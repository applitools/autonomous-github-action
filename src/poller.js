// Waits for Autonomous runs to reach a terminal state, with an overall deadline.

const TERMINAL = {
  passed: 'passed',
  failed: 'failed',
  unresolved: 'unresolved',
  aborted: 'aborted',
  canceled: 'aborted',
  cancelled: 'aborted',
  error: 'error',
};

// Statuses seen (or expected) while a run is still in progress. The live API
// reports "pending" (with empty counts) until the run finishes.
const IN_PROGRESS = new Set(['running', 'pending', 'queued', 'in_progress', 'started', 'executing', 'new', 'scheduled']);

export function classifyStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (s in TERMINAL) return { done: true, outcome: TERMINAL[s] };
  return { done: false, known: IN_PROGRESS.has(s) };
}

/**
 * @param client   AutonomousClient (only getResult is used)
 * @param runs     [{ id, readToken, label }]
 * @returns        [{ ...run, outcome, result, error }] in the same order
 */
export async function waitForRuns(client, runs, {
  timeoutMs,
  pollIntervalMs,
  maxConsecutiveErrors = 5,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const deadline = now() + timeoutMs;
  const state = runs.map((run) => ({ ...run, outcome: undefined, result: undefined, error: undefined, resultsUrl: undefined, errors: 0, lastStatus: undefined }));
  const warnedStatuses = new Set();

  while (true) {
    const pending = state.filter((s) => !s.outcome);
    if (pending.length === 0) break;

    await Promise.all(pending.map(async (s) => {
      try {
        const result = await client.getResult(s.id, s.readToken);
        s.errors = 0;
        s.result = result;
        if (result.planResultsUrl && !s.resultsUrl) {
          s.resultsUrl = result.planResultsUrl;
          log(`${s.label} (${s.id}): results at ${s.resultsUrl}`);
        }
        const { done, outcome, known } = classifyStatus(result.status);
        if (result.status !== s.lastStatus) {
          log(`${s.label} (${s.id}): ${result.status}${formatCounts(result.results)}`);
          s.lastStatus = result.status;
        }
        if (done) s.outcome = outcome;
        else if (!known && !warnedStatuses.has(result.status)) {
          warnedStatuses.add(result.status);
          log(`Unrecognised run status "${result.status}"; treating it as still in progress`);
        }
      } catch (err) {
        s.errors++;
        // Auth and permission problems will not fix themselves.
        if (err.status === 401 || err.status === 403 || s.errors >= maxConsecutiveErrors) {
          s.outcome = 'error';
          s.error = err.message;
        } else {
          log(`${s.label} (${s.id}): could not get result (${s.errors}/${maxConsecutiveErrors}): ${err.message}`);
        }
      }
    }));

    if (state.every((s) => s.outcome)) break;
    const remaining = deadline - now();
    if (remaining <= 0) {
      for (const s of state.filter((s) => !s.outcome)) {
        s.outcome = 'timed-out';
        s.error = `Run did not finish within ${Math.round(timeoutMs / 60_000 * 10) / 10} minutes (last status: ${s.lastStatus ?? 'unknown'})`;
      }
      break;
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return state.map(({ errors, lastStatus, ...rest }) => rest);
}

function formatCounts(results) {
  if (!results) return '';
  const parts = ['passed', 'failed', 'unresolved', 'aborted', 'pending']
    .filter((k) => results[k])
    .map((k) => `${results[k]} ${k}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
