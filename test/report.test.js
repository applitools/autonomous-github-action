import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReport, upsertPrComment, duration } from '../src/report.js';
import { evaluate } from '../src/gate.js';

const live = JSON.parse(readFileSync(new URL('./fixtures/plan-result-unresolved.json', import.meta.url))).result;
const planRun = {
  id: live.id, label: 'plan p1', target: { kind: 'plan', id: 'p1' }, name: live.name,
  outcome: 'unresolved', result: live, resultsUrl: live.planResultsUrl,
};
const env = { GITHUB_SHA: 'abcdef1234567', GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' };

test('duration formatting', () => {
  assert.equal(duration(68227), '1m 8s');
  assert.equal(duration(4_000), '4s');
  assert.equal(duration(3_725_000), '1h 2m');
  assert.equal(duration(undefined), '—');
});

test('renders a live plan result', () => {
  const md = renderReport([planRun], evaluate([planRun], ['failed', 'aborted']), {
    failOn: ['failed', 'aborted'], parameters: { url: 'https://qa.example.com' }, env,
  });
  assert.match(md, /^## ⚠️ Applitools Autonomous: unresolved\n/);
  assert.match(md, /\*\*Build passes\*\* · fail-on: failed, aborted · url: `https:\/\/qa\.example\.com` · commit `abcdef1` · \[workflow run\]\(https:\/\/github\.com\/acme\/web\/actions\/runs\/42\)/);
  assert.ok(md.includes(`| [plan "Google Tester"](${live.planResultsUrl}) | ⚠️ unresolved | 1 passed · 2 unresolved | 1m 8s | Safari, Android Emulation, Chrome |`), md);
  assert.match(md, /- `VISUAL_DIFFERENCE` A visual difference was detected on https:\/\/google\.com/);
  assert.ok(!md.includes('Why the build failed'));
  assert.ok(md.includes('Results count each test once per environment.'));
  // One test in one run: no separate tests table.
  assert.ok(!md.includes('| Test | Run |'));
});

test('lists tests, failure reasons, and notes', () => {
  const testRun = {
    id: 'r2', label: 'test t1', target: { kind: 'test', id: 't1' }, outcome: 'timed-out',
    error: 'Run did not finish within 45 minutes (last status: running)', result: { status: 'running', tests: [{ name: 'Login | SSO', status: 'running' }] },
  };
  const runs = [planRun, testRun];
  const md = renderReport(runs, evaluate(runs, ['failed']), { failOn: ['failed'], notes: ['Test map "Checkout" matched 1 file(s): src/a.ts'] });
  assert.match(md, /^## ⏱️ Applitools Autonomous: timed-out/);
  assert.ok(md.includes('**Build fails**'));
  assert.ok(md.includes('| Test | Run | Status | Results |'));
  assert.ok(md.includes(`| [testing](${live.tests[0].testResultsUrl}) | plan "Google Tester" | ⚠️ unresolved | 1 passed · 2 unresolved |`));
  assert.ok(md.includes('| Login \\| SSO | test t1 | ⏳ running | — |'), 'pipes are escaped');
  assert.ok(md.includes('**Why the build failed**\n\n- test t1: Run did not finish within 45 minutes (last status: running)'));
  assert.ok(md.includes('Test map "Checkout" matched 1 file(s): src/a.ts'));
});

test('long test lists collapse and are capped', () => {
  const tests = Array.from({ length: 130 }, (_, i) => ({ name: `T${i}`, status: 'passed', results: { passed: 1 } }));
  const run = { id: 'r', label: 'plan big', target: { kind: 'plan' }, outcome: 'passed', result: { status: 'passed', tests } };
  const md = renderReport([run], evaluate([run], []), {});
  assert.ok(md.includes('<details><summary>Tests (130)</summary>'));
  assert.ok(md.includes('| … 30 more | | | |'));
  assert.ok(!md.includes('| T100 |'));
});

test('skipped and error reports', () => {
  const skipped = renderReport([], { status: 'skipped' }, { notes: ['No entry in map.yml matched the 2 changed file(s)'] });
  assert.match(skipped, /^## ⏭️ Applitools Autonomous: skipped\n\n\*\*Nothing to run\*\*/);
  const err = renderReport([], { status: 'error', success: false }, { error: 'Could not read test-map x.yml' });
  assert.ok(err.includes('**Build fails**'));
  assert.ok(err.includes('> 💥 Could not read test-map x.yml'));
});

// --- PR comment -----------------------------------------------------------

function prEnv(event = 'pull_request') {
  const path = join(mkdtempSync(join(tmpdir(), 'event-')), 'event.json');
  writeFileSync(path, JSON.stringify({ pull_request: { number: 9 } }));
  return { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: 'https://gh.example' };
}

function fakeGitHub(existing = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://gh.example', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(existing.slice((page - 1) * 100, page * 100));
    }
    return Response.json({ id: 1 }, { status: init.method === 'POST' ? 201 : 200 });
  };
  return { calls, fetchImpl };
}

test('creates a PR comment with a hidden marker', async () => {
  const gh = fakeGitHub([{ id: 5, body: 'unrelated' }]);
  const result = await upsertPrComment('## hello\n', prEnv(), { token: 't', key: 'qa', fetchImpl: gh.fetchImpl });
  assert.equal(result, 'Commented on PR #9');
  const post = gh.calls.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/repos/acme/web/issues/9/comments');
  assert.equal(post.body.body, '<!-- applitools-autonomous-report:qa -->\n## hello\n');
});

test('updates the existing comment for the same key, across pages', async () => {
  const others = Array.from({ length: 100 }, (_, i) => ({ id: i, body: '<!-- applitools-autonomous-report:prod -->\nold' }));
  const gh = fakeGitHub([...others, { id: 777, body: '<!-- applitools-autonomous-report:qa -->\nold' }]);
  const result = await upsertPrComment('new', prEnv(), { token: 't', key: 'qa', fetchImpl: gh.fetchImpl });
  assert.equal(result, 'Updated PR #9 comment');
  assert.deepEqual(gh.calls.at(-1), { method: 'PATCH', path: '/repos/acme/web/issues/comments/777', body: { body: '<!-- applitools-autonomous-report:qa -->\nnew' } });
});

test('does nothing outside pull requests', async () => {
  const gh = fakeGitHub();
  assert.equal(await upsertPrComment('x', { ...prEnv(), GITHUB_EVENT_NAME: 'push' }, { token: 't', key: 'k', fetchImpl: gh.fetchImpl }), undefined);
  assert.equal(gh.calls.length, 0);
});
