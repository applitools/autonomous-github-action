# Applitools Autonomous GitHub Action — Plan

## Goal

A reusable GitHub Action that starts Applitools Autonomous tests when code is pushed or a PR is opened, waits for the run to finish (5–30 min runs), reports the result back to GitHub, and passes or fails the build based on configurable rules. It works for any Autonomous customer.

## What the Autonomous API gives us (public docs)

| Need | API | Notes |
|---|---|---|
| Start a plan | `POST /api/plan/{plan_id}/execute?apiKey=…` | Optional body `{"parameter_values": {"url": "…"}}` |
| Start a single test | `POST /api/test/{test_id}/execute?apiKey=…` | No body documented |
| Poll results | `GET /api/result/{run_id}?apiKey=…[&read_token=…]` | Returns `status`, counts (`passed/failed/unresolved/aborted/pending`), per-test list, `issues` |

Base URL: `https://autonomous.applitools.com`. Auth is a query-string API key; the key needs **execute** permission, and **read** permission or the `read_token` returned by execute.

### Confirmed against the live API (2026-10-26)

- Bad API key → `401` with plain-text body `Unauthorized`.
- Unknown plan/test ID on execute → `400` with body `{}` (not 404).
- Unknown run ID on results → `404` `{"message":"plan execution <id> not found"}`.
- Unknown route → `404` whose `message` **echoes the full URL, including `apiKey`**. The client redacts the key from all error text.
- No list endpoints (`/api/plans`, `/api/tests`, …) exist.

### Gaps to verify against a live account (Phase 0)

1. **In-progress status values.** Docs show only `failed` as an example. We need to know what `status` is while a run is queued/running (e.g. `running`, `pending`, `in_progress`) so we know when to stop polling.
2. **Results link.** No documented UI URL pattern. We need one for "link to the Autonomous results" (req. 3, 8).
3. **Test execute + parameters.** Does `/api/test/{id}/execute` accept `parameter_values` (needed for env/URL on targeted runs, req. 7)?
4. **Cancel.** No cancel endpoint documented. If a run hangs we can stop *waiting*, but can't stop the run.
5. **Rate limits / error shapes** for 401, 403, 404, 429, 5xx.

Anything we can't confirm becomes a documented limitation or a product ask.

## Design

**Type:** JavaScript action (`runs: using: node24`), zero runtime dependencies (built-in `fetch`, writes directly to `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY`). No bundling step, easy for customers to audit.

### Inputs

| Input | Default | Req. |
|---|---|---|
| `api-key` (from Secrets) | — required | 6 |
| `server-url` | `https://autonomous.applitools.com` | 6 |
| `plan-id` | — | 2 |
| `test-ids` (comma/newline list) | — | 2 |
| `test-map` (path to YAML: file globs → test/plan IDs) | — | 2 |
| `url` (shortcut for `parameter_values.url`) | — | 7 |
| `parameters` (JSON object → `parameter_values`) | — | 7 |
| `fail-on` (`failed`, `unresolved`, `aborted`, comma list, or `none`). Outcomes not listed produce a warning; timeouts and API errors always fail | `failed,aborted` | 4 |
| `timeout-minutes` (overall wait) | `45` | 5 |
| `poll-interval-seconds` | `30` | 5 |
| `max-retries` (per API call) | `5` | 5 |
| `github-token` (only for PR comment) | — | 8 |
| `pr-comment` (`true`/`false`) | `false` | 8 |

At least one of `plan-id`, `test-ids`, `test-map` is required. Several can be combined; all runs are started in parallel and reported together.

### Targeted execution (req. 2)

- `test-ids`: run exactly these tests.
- `test-map`: a YAML file checked into the repo, e.g.
  ```yaml
  - paths: ["src/checkout/**"]
    tests: ["<test-id-1>", "<test-id-2>"]
  - paths: ["src/**"]
    plans: ["<smoke-plan-id>"]
  ```
  The action diffs the PR (base…head) or push (before…after), matches changed files, and runs the union. If nothing matches, it either skips with a neutral result or falls back to `plan-id` (configurable).

### Flow

1. Resolve targets (plan, tests, map).
2. Start each run; collect `{id, read_token}`.
3. Poll all runs together until each reaches a terminal state or the deadline passes.
4. Write outputs, job summary, optional PR comment.
5. Apply gating rules and exit 0/1.

### Reliability (req. 5)

- Overall deadline (`timeout-minutes`); a run still going at the deadline is reported as **timed out**, which fails the build with a clear message and the run link.
- Per-request timeout (30 s) via `AbortSignal.timeout`.
- Retries with exponential backoff + jitter on network errors, 429 (honour `Retry-After`) and 5xx. No retry on 400/401/403/404 — fail fast with an actionable message ("API key lacks execute permission", "plan ID not found").
- A transient poll error doesn't fail the run; only N consecutive failures do.
- Distinct final states: `passed`, `failed`, `unresolved`, `aborted`, `timed-out`, `error`.
- Also recommend `timeout-minutes` on the job itself as a backstop.

### Outputs and reporting (req. 3, 8)

- Step outputs: `status`, `run-ids`, `results-url`, `passed`, `failed`, `unresolved`, `aborted`.
- The job is itself a GitHub check, so pass/fail shows on the commit/PR and can be made a required status check for branch protection (that's the gate).
- Job summary: table of tests with name, status, duration, link; plus any `issues`.
- Optional PR comment, updated in place on re-runs (found by a hidden marker) rather than piling up.

### Packaging (req. 6)

- `action.yml` at repo root, versioned with tags (`v1`, `v1.0.0`).
- `examples/` with ready-to-copy workflows: PR gate, push to main, nightly full plan, env matrix (dev/qa/prod URLs).
- Optional reusable workflow (`.github/workflows/autonomous.yml` with `workflow_call`) for teams who'd rather call a workflow than wire steps.
- README with setup: create API key with execute+read, add to Secrets, find plan/test IDs, branch protection.

## Repo layout

```
action.yml
src/
  main.js        # entry: read inputs, orchestrate, exit code
  client.js      # Autonomous API client (execute, getResult, retries)
  poller.js      # wait-for-completion with deadline
  targets.js     # plan/test-ids/test-map resolution + changed files
  gate.js        # pass/fail rules
  report.js      # outputs, job summary, PR comment
  github.js      # minimal GitHub API (comment) + env helpers
test/
  mock-server.js # fake Autonomous API with scripted scenarios
  *.test.js      # node:test
examples/
README.md
```

## Test plan

### 1. Unit tests (`node --test`, no network)
- `gate.js`: every status × `fail-on` combination.
- `targets.js`: glob matching, union/dedupe, no-match fallback, push vs PR diff ranges.
- `report.js`: summary markdown snapshot, comment upsert marker.
- Input parsing: bad JSON in `parameters`, no targets, invalid enums.

### 2. Integration tests against a local mock Autonomous server
Scenarios scripted per run ID:
- running → passed; running → failed; running → unresolved; running → aborted
- run never finishes → `timed-out` within deadline (use short intervals)
- execute returns 401 / 403 / 404 → fast, clear failure, no retries
- 429 with `Retry-After`, then success
- 500 ×2 then success (retry works); 500 forever (gives up after `max-retries`)
- poll endpoint flaps (one error mid-run) → still completes
- multiple runs in parallel with mixed outcomes → combined status correct
- `read_token` passed when provided

### 3. Live smoke test (needs an Autonomous account + key)
- Run the action locally (`node src/main.js` with `INPUT_*` env vars) against a small real plan and a single test.
- Capture real in-progress status values and response shapes; fold them back into the mock server.

### 4. End-to-end in GitHub (sandbox repo)
- Workflow on `pull_request` and `push` using the action from a branch.
- Verify: check appears on PR, job summary renders, PR comment created then updated, failing run blocks merge under branch protection, `url` parameter targets a lower environment, `test-map` picks the right tests from a PR diff.

## Phases

0. Verify API gaps with a live key (above).
1. Scaffold + client + poller + gate, with mock-server tests.
2. Targets (`test-ids`, `test-map`, changed files).
3. Reporting: outputs, summary, PR comment.
4. Packaging: README, examples, reusable workflow, tags.
5. Live smoke + GitHub E2E, then pilot with a customer team.
