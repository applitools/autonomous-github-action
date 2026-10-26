import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, readConfig } from '../src/main.js';
import { startMockServer, API_KEY, running, finished } from './mock-server.js';

let server;
let logs;
let originalLog;
let outputFile;

before(async () => {
  server = await startMockServer({
    'plan-pass': { poll: [running(), running({ passed: 1 }), finished('passed', { passed: 3 })] },
    'test-pass': { poll: [finished('passed', { passed: 1 })] },
    'test-fail': { poll: [running(), finished('failed', { failed: 1 })] },
    'plan-unresolved': { poll: [finished('unresolved', { passed: 2, unresolved: 1 })] },
    'plan-aborted': { poll: [finished('aborted', { aborted: 1 })] },
    'plan-hung': { poll: [running()] },
    'plan-flaky-poll': { poll: [running(), { status: 502 }, { status: 500 }, finished('passed', { passed: 1 })] },
  });
});
after(() => server.close());

beforeEach(() => {
  logs = [];
  originalLog = console.log;
  console.log = (m) => logs.push(String(m));
  outputFile = join(mkdtempSync(join(tmpdir(), 'autonomous-')), 'output');
  writeFileSync(outputFile, '');
});
afterEach(() => { console.log = originalLog; });

function env(inputs) {
  const e = { GITHUB_OUTPUT: outputFile, 'INPUT_API-KEY': API_KEY, 'INPUT_SERVER-URL': server.url, 'INPUT_POLL-INTERVAL-SECONDS': '0.01' };
  for (const [k, v] of Object.entries(inputs)) e[`INPUT_${k.toUpperCase()}`] = v;
  return e;
}

function outputs() {
  return Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

const fast = { clientOptions: { retryBaseMs: 1 } };

test('plan that passes -> exit 0 and outputs', async () => {
  const code = await run(env({ 'plan-id': 'plan-pass', url: 'https://qa.example.com' }), fast);
  assert.equal(code, 0);
  const out = outputs();
  assert.equal(out.status, 'passed');
  assert.match(out['run-ids'], /^run-plan-pass-\d+$/);
  assert.equal(out.passed, '3');
  assert.equal(out['results-url'], `https://autonomous.example/results/${out['run-ids']}/tests`);
  assert.ok(logs.some((l) => l.includes(`results at https://autonomous.example/results/${out['run-ids']}/tests`)));
  assert.equal(out.failed, '0');
  const exec = server.requests.find((r) => r.path === '/api/plan/plan-pass/execute');
  assert.deepEqual(exec.body, { parameter_values: { url: 'https://qa.example.com' } });
  assert.ok(logs.some((l) => l.includes('build passes')));
  assert.ok(logs.includes(`::add-mask::${API_KEY}`));
});

test('targeted tests with one failure -> exit 1, combined counts', async () => {
  const code = await run(env({ 'test-ids': 'test-pass,\ntest-fail' }), fast);
  assert.equal(code, 1);
  const out = outputs();
  assert.equal(out.status, 'failed');
  assert.equal(out['run-ids'].split(',').length, 2);
  assert.equal(out.passed, '1');
  assert.equal(out.failed, '1');
  assert.ok(logs.some((l) => /^::error::test test-fail: 1 failed - https:\/\/autonomous\.example\/results\/run-test-fail-\d+\/tests$/.test(l)));
});

test('plan and tests together', async () => {
  const code = await run(env({ 'plan-id': 'plan-pass', 'test-ids': 'test-pass' }), fast);
  assert.equal(code, 0);
  assert.equal(outputs().passed, '4');
});

test('unresolved warns by default', async () => {
  const code = await run(env({ 'plan-id': 'plan-unresolved' }), fast);
  assert.equal(code, 0);
  assert.equal(outputs().status, 'unresolved');
  assert.ok(logs.some((l) => l.startsWith('::warning::plan plan-unresolved: 1 unresolved')));
});

test('unresolved fails when fail-on includes it', async () => {
  const code = await run(env({ 'plan-id': 'plan-unresolved', 'fail-on': 'failed,unresolved' }), fast);
  assert.equal(code, 1);
});

test('aborted fails by default', async () => {
  assert.equal(await run(env({ 'plan-id': 'plan-aborted' }), fast), 1);
  assert.equal(outputs().status, 'aborted');
});

test('hung run times out instead of waiting forever', async () => {
  const startedAt = Date.now();
  const code = await run(env({ 'plan-id': 'plan-hung', 'timeout-minutes': String(0.3 / 60) }), fast);
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(outputs().status, 'timed-out');
  assert.ok(logs.some((l) => l.includes('did not finish within')));
});

test('transient result errors are retried', async () => {
  assert.equal(await run(env({ 'plan-id': 'plan-flaky-poll' }), fast), 0);
});

test('a run that cannot start is reported, others still complete', async () => {
  const code = await run(env({ 'plan-id': 'does-not-exist', 'test-ids': 'test-pass' }), fast);
  assert.equal(code, 1);
  const out = outputs();
  assert.equal(out.status, 'error');
  assert.equal(out.passed, '1');
  assert.ok(logs.some((l) => l.startsWith('::error::plan does-not-exist: Could not start: POST') && l.includes('HTTP 400')));
});

test('bad API key fails fast with a clear message', async () => {
  const code = await run({ ...env({ 'plan-id': 'plan-pass' }), 'INPUT_API-KEY': 'wrong' }, fast);
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.includes('HTTP 401: the API key is invalid or revoked')));
});

test('config validation', () => {
  const base = { 'INPUT_API-KEY': 'k' };
  assert.throws(() => readConfig({}), /api-key is required/);
  assert.throws(() => readConfig(base), /Set at least one of plan-id, test-ids or test-map/);
  assert.throws(() => readConfig({ ...base, 'INPUT_PLAN-ID': 'p', INPUT_PARAMETERS: '{bad' }), /not valid JSON/);
  assert.throws(() => readConfig({ ...base, 'INPUT_PLAN-ID': 'p', INPUT_PARAMETERS: '[1]' }), /must be a JSON object/);
  assert.throws(() => readConfig({ ...base, 'INPUT_PLAN-ID': 'p', 'INPUT_TIMEOUT-MINUTES': '0' }), /timeout-minutes must be a positive number/);
  assert.throws(() => readConfig({ ...base, 'INPUT_PLAN-ID': 'p', 'INPUT_MAX-RETRIES': '1.5' }), /max-retries must be a whole number/);
  assert.throws(() => readConfig({ ...base, 'INPUT_PLAN-ID': 'p', 'INPUT_FAIL-ON': 'nope' }), /Invalid fail-on/);

  const c = readConfig({ ...base, 'INPUT_TEST-IDS': 'a, b a', INPUT_PARAMETERS: '{"url":"x","env":"qa"}', INPUT_URL: 'https://y' });
  assert.deepEqual(c.testIds, ['a', 'b']);
  assert.deepEqual(c.parameters, { url: 'https://y', env: 'qa' });
  assert.deepEqual(c.failOn, ['failed', 'aborted']);
  assert.equal(c.timeoutMs, 45 * 60_000);
  assert.equal(c.pollIntervalMs, 30_000);
});

test('invalid config exits 1 without calling the API', async () => {
  const before = server.requests.length;
  assert.equal(await run({ 'INPUT_API-KEY': 'k' }), 1);
  assert.equal(server.requests.length, before);
  assert.ok(logs.some((l) => l.startsWith('::error::Set at least one of plan-id')));
});

// --- test-map -------------------------------------------------------------

const MAP = `
- name: Checkout
  paths: ["src/checkout/**"]
  tests: [test-pass]
- name: Search
  paths: ["src/search/**"]
  tests: [test-fail]
  plans: [plan-pass]
`;

function mapEnv(inputs, map = MAP) {
  const workspace = mkdtempSync(join(tmpdir(), 'workspace-'));
  writeFileSync(join(workspace, 'autonomous-map.yml'), map);
  return { ...env({ 'test-map': 'autonomous-map.yml', ...inputs }), GITHUB_WORKSPACE: workspace };
}

const executed = (since) => server.requests.slice(since).filter((r) => r.path.endsWith('/execute')).map((r) => r.path);

test('test-map runs only the entries matching changed files', async () => {
  const since = server.requests.length;
  const code = await run(mapEnv({ 'changed-files': 'src/checkout/cart.ts\nREADME.md' }), fast);
  assert.equal(code, 0);
  assert.deepEqual(executed(since), ['/api/test/test-pass/execute']);
  assert.ok(logs.some((l) => l === 'Test map "Checkout" matched 1 file(s): src/checkout/cart.ts'));
});

test('test-map unions matches with plan-id and de-duplicates', async () => {
  const since = server.requests.length;
  const code = await run(mapEnv({ 'plan-id': 'plan-pass', 'changed-files': 'src/search/a.ts,src/checkout/b.ts' }), fast);
  assert.equal(code, 1); // test-fail is in the Search entry
  assert.deepEqual(executed(since).sort(), ['/api/plan/plan-pass/execute', '/api/test/test-fail/execute', '/api/test/test-pass/execute']);
});

test('no match with on-no-match skip passes without calling Autonomous', async () => {
  const since = server.requests.length;
  const code = await run(mapEnv({ 'changed-files': 'docs/readme.md' }), fast);
  assert.equal(code, 0);
  assert.equal(server.requests.length, since);
  assert.equal(outputs().status, 'skipped');
  assert.ok(logs.some((l) => l.startsWith('::notice::No Autonomous tests matched')));
});

test('no match still runs plan-id', async () => {
  const since = server.requests.length;
  assert.equal(await run(mapEnv({ 'plan-id': 'plan-pass', 'changed-files': 'docs/readme.md' }), fast), 0);
  assert.deepEqual(executed(since), ['/api/plan/plan-pass/execute']);
});

test('no match with on-no-match all runs the whole map', async () => {
  const since = server.requests.length;
  await run(mapEnv({ 'changed-files': 'docs/readme.md', 'on-no-match': 'all' }), fast);
  assert.equal(executed(since).length, 3);
});

test('no match with on-no-match fail fails', async () => {
  const since = server.requests.length;
  assert.equal(await run(mapEnv({ 'changed-files': 'docs/readme.md', 'on-no-match': 'fail' }), fast), 1);
  assert.equal(server.requests.length, since);
  assert.ok(logs.some((l) => l.startsWith('::error::No entry in autonomous-map.yml matched the 1 changed file(s)')));
});

test('unknown changed files run the whole map with a warning', async () => {
  const since = server.requests.length;
  const changes = async () => ({ files: undefined, reason: 'push created a new branch' });
  await run(mapEnv({}), { ...fast, targetOptions: { changes } });
  assert.equal(executed(since).length, 3);
  assert.ok(logs.some((l) => l.startsWith('::warning::Could not determine changed files (push created a new branch)')));
});

test('changed files come from the GitHub event when not given', async () => {
  const since = server.requests.length;
  let seen;
  const changes = async (e, opts) => { seen = opts.token; return { files: ['src/checkout/x.ts'] }; };
  await run({ ...mapEnv({ 'github-token': 'gh-token' }) }, { ...fast, targetOptions: { changes } });
  assert.equal(seen, 'gh-token');
  assert.deepEqual(executed(since), ['/api/test/test-pass/execute']);
});

test('missing or invalid test-map fails clearly', async () => {
  const missing = { ...env({ 'test-map': 'nope.yml', 'changed-files': 'a' }), GITHUB_WORKSPACE: tmpdir() };
  assert.equal(await run(missing, fast), 1);
  assert.ok(logs.some((l) => l.includes('Could not read test-map nope.yml: file not found (did you run actions/checkout?)')));
  assert.equal(await run(mapEnv({ 'changed-files': 'a' }, '- paths: [a]\n  test: [x]'), fast), 1);
  assert.ok(logs.some((l) => l.includes('unknown key "test"')));
});

test('on-no-match is validated', () => {
  assert.throws(() => readConfig({ 'INPUT_API-KEY': 'k', 'INPUT_TEST-MAP': 'm', 'INPUT_ON-NO-MATCH': 'maybe' }), /on-no-match must be one of skip, all, fail/);
});
