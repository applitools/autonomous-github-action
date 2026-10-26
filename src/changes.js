// Works out which files changed in the triggering push or pull request, using
// the GitHub REST API so it does not depend on how deep the checkout is.
//
// Returns { files: string[] } or { files: undefined, reason } when the list
// cannot be determined (callers then run everything in the test map).

import { readFileSync } from 'node:fs';

const PR_FILES_LIMIT = 3000; // GitHub returns at most this many files for a PR
const COMPARE_FILES_LIMIT = 300; // ...and this many for a compare
const ZERO_SHA = /^0+$/;

export async function getChangedFiles(env = process.env, { token, fetchImpl = fetch, log = () => {} } = {}) {
  const eventName = env.GITHUB_EVENT_NAME;
  const repo = env.GITHUB_REPOSITORY;
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  if (!eventName || !repo || !env.GITHUB_EVENT_PATH) return unknown('not running in GitHub Actions');

  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch (err) {
    return unknown(`could not read the event payload: ${err.message}`);
  }
  if (!token) return unknown('no github-token');

  const api = async (path) => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status}`);
    return res.json();
  };

  try {
    if (eventName === 'pull_request' || eventName === 'pull_request_target') {
      const number = event.pull_request?.number;
      if (!number) return unknown('event has no pull request number');
      const files = [];
      for (let page = 1; ; page++) {
        const batch = await api(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        files.push(...batch.flatMap(fileNames));
        if (batch.length < 100) break;
      }
      if (files.length >= PR_FILES_LIMIT) return unknown(`pull request has ${PR_FILES_LIMIT}+ changed files`);
      return known(files, log, `pull request #${number}`);
    }

    if (eventName === 'push') {
      const { before, after } = event;
      if (event.deleted) return { files: [], reason: 'branch deleted' };
      if (!before || ZERO_SHA.test(before)) return unknown('push created a new branch, so there is no previous commit to compare');
      const data = await api(`/repos/${repo}/compare/${before}...${after}`);
      const files = (data.files ?? []).flatMap(fileNames);
      if ((data.files ?? []).length >= COMPARE_FILES_LIMIT) return unknown(`push changed ${COMPARE_FILES_LIMIT}+ files`);
      return known(files, log, `push ${before.slice(0, 7)}...${after.slice(0, 7)}`);
    }
  } catch (err) {
    return unknown(err.message);
  }

  return unknown(`event "${eventName}" has no changed files; pass changed-files to target tests`);
}

// A renamed file counts under both its old and new path.
function fileNames(f) {
  return f.previous_filename ? [f.filename, f.previous_filename] : [f.filename];
}

function known(files, log, what) {
  const unique = [...new Set(files)];
  log(`${unique.length} changed file(s) in ${what}`);
  return { files: unique };
}

function unknown(reason) {
  return { files: undefined, reason };
}
