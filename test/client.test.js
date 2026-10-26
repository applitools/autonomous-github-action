import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousClient, ApiError } from '../src/client.js';
import { startMockServer, API_KEY, finished } from './mock-server.js';

let server;
const sleeps = [];
const client = (opts = {}) => new AutonomousClient({
  apiKey: API_KEY, serverUrl: server.url, retryBaseMs: 100, sleep: async (ms) => { sleeps.push(ms); }, ...opts,
});

before(async () => {
  server = await startMockServer({
    ok: { poll: [finished('passed', { passed: 1 })] },
    flaky: { execute: [{ status: 500 }, { status: 502 }, {}] },
    limited: { execute: [{ status: 429, headers: { 'Retry-After': '7' } }, {}] },
    down: { execute: [{ status: 503 }] },
    garbage: { poll: [{ raw: 'not json' }] },
    slow: { poll: [{ delayMs: 500, body: { result: { status: 'passed' } } }] },
  });
});
after(() => server.close());

test('executePlan sends parameter_values and returns the run', async () => {
  const run = await client().executePlan('ok', { url: 'https://qa.example.com' });
  assert.match(run.id, /^run-ok-/);
  assert.equal(run.readToken, `token-${run.id}`);
  const req = server.requests.at(-1);
  assert.equal(req.path, '/api/plan/ok/execute');
  assert.deepEqual(req.body, { parameter_values: { url: 'https://qa.example.com' } });
});

test('executeTest without parameters sends no body', async () => {
  await client().executeTest('ok');
  const req = server.requests.at(-1);
  assert.equal(req.path, '/api/test/ok/execute');
  assert.equal(req.body, undefined);
});

test('getResult passes read_token', async () => {
  const run = await client().executeTest('ok');
  const result = await client().getResult(run.id, run.readToken);
  assert.equal(result.status, 'passed');
  assert.equal(server.requests.at(-1).query.read_token, run.readToken);
});

test('retries 5xx with backoff, then succeeds', async () => {
  sleeps.length = 0;
  const run = await client().executePlan('flaky');
  assert.ok(run.id);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 50 && sleeps[0] <= 100, `first backoff ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 100 && sleeps[1] <= 200, `second backoff ${sleeps[1]}`);
});

test('honours Retry-After on 429', async () => {
  sleeps.length = 0;
  await client().executePlan('limited');
  assert.deepEqual(sleeps, [7000]);
});

test('gives up after max-retries', async () => {
  sleeps.length = 0;
  await assert.rejects(client({ maxRetries: 2 }).executePlan('down'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(sleeps.length, 2);
});

test('does not retry 400, and explains it', async () => {
  sleeps.length = 0;
  await assert.rejects(client().executePlan('no-such-plan'), /HTTP 400: check that the plan\/test ID is correct/);
  assert.equal(sleeps.length, 0);
});

test('does not retry 401', async () => {
  sleeps.length = 0;
  await assert.rejects(client({ apiKey: 'wrong' }).executePlan('ok'), (err) => err.status === 401 && /invalid or revoked/.test(err.message));
  assert.equal(sleeps.length, 0);
});

test('never leaks the API key from error bodies', async () => {
  // An unknown route makes the API echo the full URL, apiKey included.
  const err = await client({ serverUrl: `${server.url}/wrong-prefix` }).getResult('x').catch((e) => e);
  assert.equal(err.status, 404);
  assert.ok(!err.message.includes(API_KEY), err.message);
  assert.ok(!String(err.body).includes(API_KEY));
  assert.match(err.message, /apiKey=\*\*\*/);
});

test('rejects invalid JSON', async () => {
  const run = await client().executeTest('garbage');
  await assert.rejects(client().getResult(run.id), /invalid JSON/);
});

test('times out slow requests and retries them', async () => {
  sleeps.length = 0;
  const run = await client().executeTest('slow');
  await assert.rejects(client({ requestTimeoutMs: 50, maxRetries: 1 }).getResult(run.id), /timed out after 0.05s/);
  assert.equal(sleeps.length, 1);
});
