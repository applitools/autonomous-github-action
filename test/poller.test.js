import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, waitForRuns } from '../src/poller.js';
import { ApiError } from '../src/client.js';

// A fake clock: sleep advances time instantly.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// Fake client: each run ID maps to a list of results/errors served in order (last repeats).
function fakeClient(script) {
  const calls = {};
  return {
    calls,
    async getResult(id, readToken) {
      calls[id] = calls[id] ?? [];
      calls[id].push(readToken);
      const list = script[id];
      const item = list[Math.min(calls[id].length - 1, list.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    },
  };
}

const r = (status, results = {}) => ({ status, results });

test('classifyStatus', () => {
  assert.deepEqual(classifyStatus('Passed'), { done: true, outcome: 'passed' });
  assert.deepEqual(classifyStatus('cancelled'), { done: true, outcome: 'aborted' });
  assert.deepEqual(classifyStatus('running'), { done: false, known: true });
  assert.deepEqual(classifyStatus('pending'), { done: false, known: true });
  assert.deepEqual(classifyStatus('weird'), { done: false, known: false });
});

test('polls until every run finishes', async () => {
  const c = clock();
  const client = fakeClient({
    a: [r('running'), r('running'), r('passed', { passed: 2 })],
    b: [r('queued'), r('failed', { failed: 1 })],
  });
  const runs = await waitForRuns(client, [{ id: 'a', label: 'A', readToken: 'ta' }, { id: 'b', label: 'B' }], {
    timeoutMs: 60_000, pollIntervalMs: 1_000, ...c,
  });
  assert.deepEqual(runs.map((x) => x.outcome), ['passed', 'failed']);
  assert.equal(client.calls.a.length, 3);
  assert.equal(client.calls.b.length, 2); // stops polling b once it is done
  assert.equal(client.calls.a[0], 'ta');
  assert.equal(c.now(), 2_000);
});

test('records and logs the results link once', async () => {
  const c = clock();
  const logs = [];
  const withUrl = (status) => ({ status, results: {}, planResultsUrl: 'https://x/results/a' });
  const client = fakeClient({ a: [withUrl('pending'), withUrl('pending'), withUrl('passed')] });
  const [run] = await waitForRuns(client, [{ id: 'a', label: 'A' }], { timeoutMs: 60_000, pollIntervalMs: 1, log: (m) => logs.push(m), ...c });
  assert.equal(run.resultsUrl, 'https://x/results/a');
  assert.equal(logs.filter((m) => m.includes('results at https://x/results/a')).length, 1);
});

test('marks runs still going at the deadline as timed-out', async () => {
  const c = clock();
  const client = fakeClient({ a: [r('running')], b: [r('passed')] });
  const runs = await waitForRuns(client, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], {
    timeoutMs: 10_000, pollIntervalMs: 3_000, ...c,
  });
  assert.equal(runs[0].outcome, 'timed-out');
  assert.match(runs[0].error, /did not finish within .* \(last status: running\)/);
  assert.equal(runs[1].outcome, 'passed');
  assert.equal(c.now(), 10_000); // last sleep is cut short to the deadline
});

test('tolerates transient poll errors', async () => {
  const c = clock();
  const client = fakeClient({ a: [r('running'), new ApiError('blip', { status: 500 }), new ApiError('blip', { status: 404 }), r('passed')] });
  const [run] = await waitForRuns(client, [{ id: 'a', label: 'A' }], { timeoutMs: 60_000, pollIntervalMs: 1, ...c });
  assert.equal(run.outcome, 'passed');
});

test('gives up after too many consecutive errors', async () => {
  const c = clock();
  const client = fakeClient({ a: [new ApiError('down', { status: 503 })] });
  const [run] = await waitForRuns(client, [{ id: 'a', label: 'A' }], { timeoutMs: 60_000, pollIntervalMs: 1, maxConsecutiveErrors: 3, ...c });
  assert.equal(run.outcome, 'error');
  assert.equal(client.calls.a.length, 3);
});

test('fails fast on auth errors', async () => {
  const c = clock();
  const client = fakeClient({ a: [new ApiError('forbidden', { status: 403 })] });
  const [run] = await waitForRuns(client, [{ id: 'a', label: 'A' }], { timeoutMs: 60_000, pollIntervalMs: 1, ...c });
  assert.equal(run.outcome, 'error');
  assert.equal(run.error, 'forbidden');
  assert.equal(client.calls.a.length, 1);
});

test('warns once about unknown statuses and keeps polling', async () => {
  const c = clock();
  const logs = [];
  const client = fakeClient({ a: [r('mystery'), r('mystery'), r('passed')] });
  const [run] = await waitForRuns(client, [{ id: 'a', label: 'A' }], { timeoutMs: 60_000, pollIntervalMs: 1, log: (m) => logs.push(m), ...c });
  assert.equal(run.outcome, 'passed');
  assert.equal(logs.filter((m) => m.includes('Unrecognised run status "mystery"')).length, 1);
});
