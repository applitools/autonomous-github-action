// Small helpers for the GitHub Actions runtime, so the action needs no dependencies.

import { appendFileSync } from 'node:fs';

export function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export function setOutput(name, value, env = process.env) {
  const line = `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
  else process.stdout.write(`[output] ${line}`);
}

export function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// Minimal GitHub REST client: api(method, path, body?) -> parsed JSON.
export function githubApi(env, token, fetchImpl = fetch) {
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  return async (method, path, body) => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = new Error(`GitHub API ${method} ${path} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? undefined : res.json();
  };
}

export function mask(value) {
  if (value) console.log(`::add-mask::${value}`);
}

export function info(message) {
  console.log(message);
}

export function notice(message) {
  console.log(`::notice::${escape(message)}`);
}

export function warning(message) {
  console.log(`::warning::${escape(message)}`);
}

export function error(message) {
  console.log(`::error::${escape(message)}`);
}

function escape(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
