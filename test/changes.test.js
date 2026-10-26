import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChangedFiles } from '../src/changes.js';

function setup(eventName, payload) {
  const path = join(mkdtempSync(join(tmpdir(), 'event-')), 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return { GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: 'acme/web', GITHUB_EVENT_PATH: path, GITHUB_API_URL: 'https://gh.example/api/v3' };
}

// Fake fetch: routes map URL path+query -> JSON body or HTTP status.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const key = url.replace('https://gh.example/api/v3', '');
    const r = routes[key];
    if (r === undefined) return new Response('not found', { status: 404 });
    if (typeof r === 'number') return new Response('', { status: r });
    return Response.json(r);
  };
  fn.calls = calls;
  return fn;
}

const files = (n, prefix = 'f') => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.js` }));

test('pull request: paginates and includes renamed-from paths', async () => {
  const env = setup('pull_request', { pull_request: { number: 7 } });
  const fetchImpl = fakeFetch({
    '/repos/acme/web/pulls/7/files?per_page=100&page=1': files(100),
    '/repos/acme/web/pulls/7/files?per_page=100&page=2': [{ filename: 'new/name.js', previous_filename: 'old/name.js' }],
  });
  const result = await getChangedFiles(env, { token: 'tok', fetchImpl });
  assert.equal(result.files.length, 102);
  assert.ok(result.files.includes('old/name.js'));
  assert.equal(fetchImpl.calls[0].auth, 'Bearer tok');
});

test('push: compares before...after', async () => {
  const env = setup('push', { before: 'aaaaaaa1', after: 'bbbbbbb2' });
  const fetchImpl = fakeFetch({ '/repos/acme/web/compare/aaaaaaa1...bbbbbbb2': { files: [{ filename: 'src/a.js' }] } });
  assert.deepEqual(await getChangedFiles(env, { token: 't', fetchImpl }), { files: ['src/a.js'] });
});

test('push that creates a branch is unknown', async () => {
  const env = setup('push', { before: '0000000000000000000000000000000000000000', after: 'b' });
  const r = await getChangedFiles(env, { token: 't', fetchImpl: fakeFetch({}) });
  assert.equal(r.files, undefined);
  assert.match(r.reason, /new branch/);
});

test('too many files is unknown', async () => {
  const env = setup('push', { before: 'a', after: 'b' });
  const r = await getChangedFiles(env, { token: 't', fetchImpl: fakeFetch({ '/repos/acme/web/compare/a...b': { files: files(300) } }) });
  assert.equal(r.files, undefined);
  assert.match(r.reason, /300\+/);
});

test('API errors, missing token, other events and local runs are unknown', async () => {
  const pr = setup('pull_request', { pull_request: { number: 1 } });
  assert.match((await getChangedFiles(pr, { token: 't', fetchImpl: fakeFetch({ '/repos/acme/web/pulls/1/files?per_page=100&page=1': 403 }) })).reason, /HTTP 403/);
  assert.match((await getChangedFiles(pr, { token: '', fetchImpl: fakeFetch({}) })).reason, /no github-token/);
  assert.match((await getChangedFiles(setup('workflow_dispatch', {}), { token: 't' })).reason, /pass changed-files/);
  assert.match((await getChangedFiles({}, { token: 't' })).reason, /not running in GitHub Actions/);
});
