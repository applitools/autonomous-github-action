// Markdown report used for the job summary and the PR comment.

import { readFileSync } from 'node:fs';
import { displayName } from './gate.js';
import { githubApi } from './github.js';

const ICONS = {
  passed: '✅',
  failed: '❌',
  unresolved: '⚠️',
  aborted: '⛔',
  'timed-out': '⏱️',
  error: '💥',
  skipped: '⏭️',
  pending: '⏳',
  running: '⏳',
};
const COUNT_KEYS = ['passed', 'failed', 'unresolved', 'aborted'];
const MAX_TEST_ROWS = 100;
const MAX_ISSUES = 20;
const MARKER = 'applitools-autonomous-report';

/**
 * @param runs     finished runs from main (with result, outcome, resultsUrl, error)
 * @param verdict  from gate.evaluate, or { status: 'skipped' | 'error' } when nothing ran
 * @param context  { failOn, parameters, notes, error, env }
 */
export function renderReport(runs, verdict, { failOn = [], parameters, notes = [], error, env = {} } = {}) {
  const lines = [];
  const status = verdict.status;
  lines.push(`## ${icon(status)} Applitools Autonomous: ${status}`, '');

  const facts = [];
  if (status === 'skipped') facts.push('**Nothing to run**');
  else facts.push(verdict.success ? '**Build passes**' : '**Build fails**');
  facts.push(`fail-on: ${failOn.length ? failOn.join(', ') : 'none'}`);
  for (const [k, v] of Object.entries(parameters ?? {})) facts.push(`${k}: ${code(v)}`);
  if (env.GITHUB_SHA) facts.push(`commit ${code(env.GITHUB_SHA.slice(0, 7))}`);
  const runUrl = workflowRunUrl(env);
  if (runUrl) facts.push(`[workflow run](${runUrl})`);
  lines.push(facts.join(' · '), '');

  if (error) lines.push(`> ${icon('error')} ${cell(error)}`, '');

  if (runs.length) {
    lines.push('| Run | Status | Results | Duration | Environments |', '|---|---|---|---|---|');
    for (const run of runs) {
      const outcome = run.outcome ?? run.result?.status;
      const envs = (run.result?.environments ?? []).map((e) => e.name).filter(Boolean).join(', ');
      lines.push(`| ${link(displayName(run), run.resultsUrl)} | ${icon(outcome)} ${outcome} | ${counts(run.result?.results)} | ${duration(run.result?.duration)} | ${cell(envs) || '—'} |`);
    }
    lines.push('');
  }

  const tests = runs.flatMap((run) => (run.result?.tests ?? []).map((t) => ({ ...t, run })));
  // A single-test run already shows everything in the run table.
  const showTests = tests.length > 1 || runs.length > 1;
  if (tests.length && showTests) {
    const rows = tests.slice(0, MAX_TEST_ROWS).map((t) =>
      `| ${link(t.name ?? t.id, t.testResultsUrl)} | ${cell(displayName(t.run))} | ${icon(t.status)} ${t.status ?? '—'} | ${counts(t.results)} |`);
    if (tests.length > MAX_TEST_ROWS) rows.push(`| … ${tests.length - MAX_TEST_ROWS} more | | | |`);
    const table = ['| Test | Run | Status | Results |', '|---|---|---|---|', ...rows];
    if (tests.length > 10) lines.push(`<details><summary>Tests (${tests.length})</summary>`, '', ...table, '', '</details>', '');
    else lines.push(...table, '');
  }

  const issues = runs.flatMap((run) => (run.result?.issues ?? []).map((i) => ({ ...i, run })));
  if (issues.length) {
    lines.push('**Issues**', '');
    for (const i of issues.slice(0, MAX_ISSUES)) {
      const where = i.params?.url ? ` on ${i.params.url}` : '';
      lines.push(`- ${code(i.code ?? 'ISSUE')} ${cell(i.message ?? '')}${where} (${link(displayName(i.run), i.run.resultsUrl)})`);
    }
    if (issues.length > MAX_ISSUES) lines.push(`- … ${issues.length - MAX_ISSUES} more`);
    lines.push('');
  }

  const failures = verdict.failures ?? [];
  if (failures.length) {
    lines.push('**Why the build failed**', '', ...failures.map((f) => `- ${f}`), '');
  }

  const counted = runs.some((r) => r.result?.results?.total);
  if (notes.length || counted) {
    const extra = [...notes];
    if (counted) extra.push('Results count each test once per environment.');
    lines.push('<sub>', extra.map(cell).join('<br>'), '</sub>');
  }
  return lines.join('\n').trim() + '\n';
}

// Creates or updates this job's comment on the pull request. Returns a short
// description of what happened, or undefined when there is no pull request.
export async function upsertPrComment(markdown, env, { token, key, fetchImpl = fetch } = {}) {
  const number = pullRequestNumber(env);
  if (!number) return undefined;
  if (!token) throw new Error('pr-comment needs github-token');
  const api = githubApi(env, token, fetchImpl);
  const repo = env.GITHUB_REPOSITORY;
  const marker = `<!-- ${MARKER}:${key} -->`;
  const body = `${marker}\n${markdown}`;

  for (let page = 1; ; page++) {
    const comments = await api('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const existing = comments.find((c) => c.body?.startsWith(marker));
    if (existing) {
      await api('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
      return `Updated PR #${number} comment`;
    }
    if (comments.length < 100) break;
  }
  await api('POST', `/repos/${repo}/issues/${number}/comments`, { body });
  return `Commented on PR #${number}`;
}

function pullRequestNumber(env) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) || !env.GITHUB_EVENT_PATH) return undefined;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.number;
  } catch {
    return undefined;
  }
}

function workflowRunUrl(env) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function icon(status) {
  return ICONS[status] ?? '❔';
}

function counts(results) {
  if (!results) return '—';
  const parts = COUNT_KEYS.filter((k) => results[k]).map((k) => `${results[k]} ${k}`);
  return parts.length ? parts.join(' · ') : '—';
}

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function link(text, url) {
  return url ? `[${cell(text)}](${url})` : cell(text);
}

function code(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

// Keeps text from breaking a markdown table row.
function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
