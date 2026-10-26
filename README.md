# Applitools Autonomous GitHub Action

Run [Applitools Autonomous](https://applitools.com/platform/autonomous) tests when code is pushed or a pull request is opened, wait for the results, and pass or fail the build.

- **Runs on every check-in**: on `pull_request` and `push` events.
- **Runs only what changed**: a test map links code paths to Autonomous tests and plans.
- **Reports results to GitHub**: the build passes or fails, warnings include links, and a results table appears in the job summary and optionally as a PR comment.
- **Gates the build**: you choose which outcomes fail it (`failed`, `unresolved`, `aborted`).
- **Handles long runs**: an overall timeout, retries with backoff, and distinct `timed-out` and `error` states, so a stuck run can't hold up the pipeline.
- **Reusable**: no dependencies; use the action directly or call the shared workflow.

## Support

This action is provided **as is**:

- **No maintenance commitment:** there's no promise of bug fixes or new features.
- **No support SLA:** questions and issues may not get a response within any set time.
- **No upgrade guarantee:** future changes to Autonomous, GitHub Actions or Node.js may break it, and it may not be updated to match.

Test it in your own workflows before relying on it, and pin an exact version (for example `@v1.0.0`) so it only changes when you choose.

## Quick start

1. In Autonomous, create an API key with **execute** and **read** permissions.
2. In GitHub, add it as a repository or organization secret named `APPLITOOLS_AUTONOMOUS_API_KEY`.
3. Copy a plan ID (Plans page → ⋯ → Copy ID, or from the plan's URL) or test IDs.
4. Add `.github/workflows/autonomous.yml`:

```yaml
name: Autonomous tests
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write   # only needed for pr-comment

jobs:
  autonomous:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: applitools/autonomous-github-action@v1
        with:
          api-key: ${{ secrets.APPLITOOLS_AUTONOMOUS_API_KEY }}
          plan-id: <your-plan-id>
          url: https://qa.example.com
          pr-comment: true
```

5. To block merging, make the `autonomous` check required in **Settings → Branches → Branch protection** (or a ruleset).

More examples are in [`examples/`](examples):

| File | What it shows |
|---|---|
| [`pr-gate.yml`](examples/pr-gate.yml) | PR and push gate using a test map, with a PR comment |
| [`env-matrix.yml`](examples/env-matrix.yml) | The same plan against dev and QA in parallel, one comment per environment |
| [`nightly.yml`](examples/nightly.yml) | Scheduled full regression where unresolved results also fail |
| [`reusable-caller.yml`](examples/reusable-caller.yml) | Calling the shared workflow instead of writing steps |
| [`autonomous-map.yml`](examples/autonomous-map.yml) | Test map template |

## Choosing what runs

You can combine any of these. Everything selected starts in parallel and is reported together.

| Input | Runs |
|---|---|
| `plan-id` | One or more plans (comma- or newline-separated) |
| `test-ids` | Individual tests |
| `test-map` | Tests and plans whose paths match the files changed in this push or PR |

### Test map

Check a map into the repo (for example `.github/autonomous-map.yml`) and point `test-map` at it. Your workflow must run `actions/checkout` first.

```yaml
- name: Checkout
  paths: ["src/checkout/**", "src/payments/**", "!**/*.md"]
  tests:
    - 3f2a...   # Add to cart
    - 9b1c...   # Pay by card

- name: Shared code - run the smoke plan
  paths: ["src/shared/**", "package.json"]
  plans: [fae4...]
```

- Each entry needs `paths` and at least one of `tests` or `plans`. `name` is optional and appears in logs.
- **Patterns** follow `.gitignore`/CODEOWNERS rules:
  - `**` matches any number of directories, `*` matches anything except `/`, and `{a,b}` matches either.
  - `!pattern` excludes files; a later pattern can include them again.
  - A pattern without a `/` matches at any depth (`*.md`), and a leading `/` anchors it to the repo root.
  - Dot-folders such as `.github/` match like any other folder.
- **Every matching entry runs.** If a test or plan is selected more than once, it starts only once.
- **Format:** a strict subset of YAML (lists of strings, written inline or one per line), or the same structure as JSON. Unknown keys and unsupported syntax fail with a line number, so a typo can't quietly run nothing.

**Changed files** are read through the GitHub API: the PR's file list, or the comparison between the push's previous and new commits. So it doesn't matter how much history the checkout fetched, and renamed files count under both their old and new paths. You can also pass your own list with `changed-files`.

**If the changed files can't be determined, every test in the map runs, with a warning.** This happens for:
- a push that creates a new branch
- more than 300 files changed in a push, or 3,000 in a PR
- other events, such as `workflow_dispatch`
- an API error

**If nothing matches,** `on-no-match` decides. `plan-id` and `test-ids` always run regardless.

| `on-no-match` | Result |
|---|---|
| `skip` (default) | Passes with status `skipped` and a notice; Autonomous isn't called |
| `all` | Runs every test in the map |
| `fail` | Fails the build |

## Gating

`fail-on` lists which outcomes fail the build. Outcomes it doesn't list produce warnings. **Timeouts and API errors always fail.**

| `fail-on` | Use when |
|---|---|
| `failed,aborted` (default) | Unresolved visual differences still need a human review, so they shouldn't block the build |
| `failed,unresolved,aborted` | Strict: every difference must be reviewed before merging |
| `failed` | Aborted runs shouldn't block the build |
| `none` | Report only |

Each run's status and its per-test counts are both checked, so an `unresolved` run that also contains failed tests still counts as `failed`.

## Environments

`url` is sent as the plan parameter `url`; `parameters` takes any JSON object of parameter values. Both are passed as `parameter_values` to every plan and test the action starts, so the same tests can target production or lower environments. See [`env-matrix.yml`](examples/env-matrix.yml).

```yaml
with:
  url: https://qa.example.com
  parameters: '{"locale": "en-US"}'
```

## Reliability

| Situation | Behavior |
|---|---|
| A run takes too long | After `timeout-minutes` (default 45), the action stops waiting, reports `timed-out` with a link, and fails |
| Network error, HTTP 429 or 5xx | Retried up to `max-retries` times with growing waits, using `Retry-After` when the server sends it |
| Bad API key, missing permission, unknown ID | Fails at once with a message saying what to fix (no retries) |
| Brief errors while checking results | Tolerated; 5 in a row end that run as `error` |
| Unrecognized run status | Logged once and treated as still running |

Also set the job's own `timeout-minutes` above the action's timeout as a backstop. When a job is cancelled or times out, the action stops waiting, but **the Autonomous run keeps going**, because the API has no cancel endpoint.

## Reporting

- **Job summary** (on by default): the build verdict, a run table (name linked to Autonomous, status, counts, duration, environments), a test table, issues such as `VISUAL_DIFFERENCE`, why the build failed, and what the test map matched.
- **PR comment** (`pr-comment: true`): the same report.
  - On re-runs it's edited in place, not posted again.
  - Jobs that run the action more than once (such as a matrix) need a different `comment-key` for each.
  - It needs `pull-requests: write`. If posting fails (PRs from forks get a read-only token), you get a warning and the build result doesn't change.
- **Annotations:** one warning or error for each run that didn't pass, with its link.
- **Outputs** (see below), for later steps.

Counts are **per test per environment**: one test run on 3 browsers counts as 3.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | *required* | Autonomous API key (store in Secrets) |
| `plan-id` | | Plan ID(s) to run |
| `test-ids` | | Test IDs to run |
| `test-map` | | Path to the test map file |
| `changed-files` | from the GitHub API | Files to match against `test-map` |
| `on-no-match` | `skip` | `skip`, `all` or `fail` |
| `url` | | Target URL, sent as parameter `url` |
| `parameters` | | JSON object of parameter values |
| `fail-on` | `failed,aborted` | Outcomes that fail the build, or `none` |
| `timeout-minutes` | `45` | Maximum time to wait for all runs |
| `poll-interval-seconds` | `30` | Time between result checks |
| `max-retries` | `5` | Retries per API request |
| `summary` | `true` | Write the job summary |
| `pr-comment` | `false` | Post or update a PR comment |
| `comment-key` | job ID | Separates comments from multiple jobs |
| `github-token` | `github.token` | Reads changed files and posts the comment |
| `server-url` | `https://autonomous.applitools.com` | Autonomous server URL |

## Outputs

| Output | Description |
|---|---|
| `status` | `passed`, `unresolved`, `failed`, `aborted`, `timed-out`, `error` or `skipped` (worst across runs) |
| `run-ids` | Comma-separated Autonomous run IDs |
| `results-url` | Comma-separated links to each run's results |
| `passed`, `failed`, `unresolved`, `aborted` | Totals across all runs |

## Permissions

| Feature | Workflow permission |
|---|---|
| Test map on `push` | `contents: read` |
| Test map on `pull_request` | `pull-requests: read` (included in `write`) |
| PR comment | `pull-requests: write` |

The Autonomous key needs **execute** permission. It also needs **read** permission, unless you rely on the read token that execute returns, which the action uses automatically.

## Reusable workflow

Teams that would rather not write steps can call the shared workflow. It checks out the repo when `test-map` is set and passes every input through:

```yaml
jobs:
  autonomous:
    permissions: { contents: read, pull-requests: write }
    uses: applitools/autonomous-github-action/.github/workflows/autonomous.yml@v1
    with:
      test-map: .github/autonomous-map.yml
      url: https://qa.example.com
      pr-comment: true
    secrets:
      api-key: ${{ secrets.APPLITOOLS_AUTONOMOUS_API_KEY }}
```

It takes the same inputs as the action, plus `runs-on` and `job-timeout-minutes`, and returns `status`, `run-ids` and `results-url`.

## Known limitations

- **No cancel:** cancelling or timing out the job doesn't stop the Autonomous run.
- **Parameters:** single-test runs accept `parameter_values`. A run only uses them if the test was built with those parameters.
- **No way to list tests:** the API has no endpoint for listing plans or tests, so IDs are copied from the Autonomous web app.

## Development

No dependencies. Requires Node 20 or later.

```bash
npm test
```

- **Tests:** they run against a local fake Autonomous server (`test/mock-server.js`) that matches the live API's response shape. `test/fixtures/` holds a sanitized real result.
- **Local run against the live API:** export the key as `APPLITOOLS_AUTONOMOUS_API_KEY` in `.env` (gitignored) and pass inputs as `INPUT_<NAME>` environment variables:

```bash
set -a; source .env; set +a
env "INPUT_API-KEY=$APPLITOOLS_AUTONOMOUS_API_KEY" "INPUT_PLAN-ID=<plan-id>" node src/main.js
```

- **CI:** runs the tests on Node 20, 22 and 24. The `self-test` job runs this checkout of the action against the live API when the `APPLITOOLS_AUTONOMOUS_API_KEY` secret and `AUTONOMOUS_TEST_ID` variable are set.

### Releasing

Tag a version and move the major tag, so users on `@v1` get the update:

```bash
git tag -a v1.0.0 -m "v1.0.0" && git tag -fa v1 -m "v1" && git push origin v1.0.0 && git push -f origin v1
```
