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

### Live runs (2026-10-26, plan `fae49398…`, test `ff3321f2…`)

- **Status lifecycle:** `pending` → `running` → terminal. Observed terminal: `unresolved`. `passed`/`failed`/`aborted` are assumed from the docs and count fields but not yet seen live.
- **Counts:** `results` is `{}` while `pending`; from `running` on it has `total`, `passed`, `failed`, `unresolved`, `aborted`, `pending`, plus `modified`, `steps_added`, `steps_removed`, `steps_existing`, `unvalidated`, `required_attention`, `validation_region_added`, `accessibility_{passed,failed,unresolved,pending,reports}`.
- **Counts are per test × environment** (a test on 2 browsers gives `total: 2`). Action outputs follow the same unit.
- **Results links (closes gap 2):** run-level `planResultsUrl` and per-test `testResultsUrl` are in every result response, including while pending.
- **Other fields:** `started_at`, `duration` (ms), per-test `totals` (`steps`, `nlp`, `checkpoints`), `issues[]` with `code` (e.g. `VISUAL_DIFFERENCE`), `message`, `params.url`.
- **Single test + parameters (gap 3, partly):** `POST /api/test/{id}/execute` accepts `{"parameter_values": {...}}` (HTTP 200). Whether a parameter is *applied* still needs a test that references one.
- **Run time:** these small runs took 60–90 s; status changes were visible within 15 s.

### Still open

1. Confirm a parameterised test/plan actually uses `parameter_values.url` (needs a test built with a URL parameter).
2. See a real `failed` and `aborted` run to confirm those status strings.
3. Cancel: no endpoint documented; on timeout we stop waiting but the run continues.
4. Rate limits: not documented; 429 handling is in place regardless.
5. Possible extra gate: `accessibility_failed` / `accessibility_unresolved` counts could become `fail-on` options.

## Design

**Type:** JavaScript action (`runs: using: node24`), zero runtime dependencies (built-in `fetch`, writes directly to `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY`). No bundling step, easy for customers to audit.

### Inputs

| Input | Default | Req. |
|---|---|---|
| `api-key` (from Secrets) | — required | 6 |
| `server-url` | `https://autonomous.applitools.com` | 6 |
| `plan-id` (one or more) | — | 2 |
| `test-ids` (comma/newline list) | — | 2 |
| `test-map` (path to YAML/JSON: file globs → test/plan IDs) | — | 2 |
| `changed-files` (override; otherwise read from the PR/push via GitHub API) | — | 2 |
| `on-no-match` (`skip` \| `all` \| `fail`) | `skip` | 2 |
| `github-token` (read changed files; later PR comment) | `${{ github.token }}` | 2, 8 |
| `url` (shortcut for `parameter_values.url`) | — | 7 |
| `parameters` (JSON object → `parameter_values`) | — | 7 |
| `fail-on` (`failed`, `unresolved`, `aborted`, comma list, or `none`). Outcomes not listed produce a warning; timeouts and API errors always fail | `failed,aborted` | 4 |
| `timeout-minutes` (overall wait) | `45` | 5 |
| `poll-interval-seconds` | `30` | 5 |
| `max-retries` (per API call) | `5` | 5 |
| `pr-comment` (`true`/`false`) | `false` | 8 |

At least one of `plan-id`, `test-ids`, `test-map` is required. Several can be combined; all runs are started in parallel and reported together.

### Targeted execution (req. 2) — built in Phase 2

- `plan-id` / `test-ids`: always run.
- `test-map`: a YAML (or JSON) file in the repo; see `examples/autonomous-map.yml`. Each entry has `paths` (globs, `!` to exclude), and `tests` and/or `plans`. Every entry matching a changed file runs; everything is unioned and de-duplicated.
- The YAML parser is a strict subset (lists of strings, inline or block) so the action stays dependency-free; unknown keys and unsupported syntax fail with a line number.
- Globs follow `.gitignore`/CODEOWNERS rules (own matcher: Node's `path.matchesGlob` skips dot-dirs like `.github/` and is missing on Node 20).
- Changed files come from the GitHub API (PR files, or compare `before...after` for push), so checkout depth doesn't matter. Renames count under old and new paths.
- When changed files can't be known (new branch, >300 files on push / >3000 on PR, other events, API error) the action **runs the whole map** with a warning, so tests are never silently skipped. `changed-files` lets teams supply their own list.
- When nothing matches: `on-no-match: skip` (default; passes with a notice, status `skipped`), `all`, or `fail`. `plan-id`/`test-ids` still run.

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
