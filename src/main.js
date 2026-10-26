// Entry point: start Autonomous runs, wait for them, report, and gate the build.

import { pathToFileURL } from 'node:url';
import { AutonomousClient } from './client.js';
import { waitForRuns } from './poller.js';
import { evaluate, parseFailOn } from './gate.js';
import { resolveTargets, NO_MATCH_MODES } from './targets.js';
import * as gh from './github.js';

export function readConfig(env = process.env) {
  const input = (name) => gh.getInput(name, env);

  const apiKey = input('api-key');
  if (!apiKey) throw new Error('api-key is required');

  const planIds = list(input('plan-id'));
  const testIds = list(input('test-ids'));
  const testMap = input('test-map');
  if (!planIds.length && !testIds.length && !testMap) throw new Error('Set at least one of plan-id, test-ids or test-map');

  const changedFilesInput = input('changed-files');
  const onNoMatch = (input('on-no-match') || 'skip').toLowerCase();
  if (!NO_MATCH_MODES.includes(onNoMatch)) throw new Error(`on-no-match must be one of ${NO_MATCH_MODES.join(', ')}, got "${onNoMatch}"`);

  let parameters;
  const rawParameters = input('parameters');
  if (rawParameters) {
    try {
      parameters = JSON.parse(rawParameters);
    } catch (err) {
      throw new Error(`parameters is not valid JSON: ${err.message}`);
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new Error('parameters must be a JSON object, e.g. {"url": "https://qa.example.com"}');
    }
  }
  const url = input('url');
  if (url) parameters = { ...parameters, url };

  return {
    apiKey,
    serverUrl: input('server-url') || 'https://autonomous.applitools.com',
    planIds,
    testIds,
    testMap,
    changedFiles: changedFilesInput ? list(changedFilesInput) : undefined,
    onNoMatch,
    githubToken: input('github-token') || env.GITHUB_TOKEN,
    parameters,
    failOn: parseFailOn(input('fail-on') || 'failed,aborted'),
    timeoutMs: positiveNumber(input('timeout-minutes') || '45', 'timeout-minutes') * 60_000,
    pollIntervalMs: positiveNumber(input('poll-interval-seconds') || '30', 'poll-interval-seconds') * 1000,
    maxRetries: nonNegativeInteger(input('max-retries') || '5', 'max-retries'),
  };
}

export async function run(env = process.env, { clientOptions = {}, targetOptions = {} } = {}) {
  let config;
  try {
    config = readConfig(env);
  } catch (err) {
    gh.error(err.message);
    return 1;
  }
  gh.mask(config.apiKey);

  const client = new AutonomousClient({
    apiKey: config.apiKey,
    serverUrl: config.serverUrl,
    maxRetries: config.maxRetries,
    log: gh.info,
    ...clientOptions,
  });

  let targets;
  try {
    const resolved = await resolveTargets(config, env, { log: gh.info, warn: gh.warning, ...targetOptions });
    if (resolved.skipped) {
      gh.notice('No Autonomous tests matched this change; nothing to run');
      writeOutputs([], { status: 'skipped' }, env);
      return 0;
    }
    targets = resolved.targets;
  } catch (err) {
    gh.error(err.message);
    writeOutputs([], { status: 'error' }, env);
    return 1;
  }
  gh.info(`Running ${targets.map((t) => `${t.kind} ${t.id}`).join(', ')}`);

  const started = await Promise.all(targets.map(async (t) => {
    const label = `${t.kind} ${t.id}`;
    try {
      const run = t.kind === 'plan'
        ? await client.executePlan(t.id, config.parameters)
        : await client.executeTest(t.id, config.parameters);
      gh.info(`Started ${label}: run ${run.id}`);
      return { ...run, label, target: t };
    } catch (err) {
      return { id: '', label, target: t, outcome: 'error', error: `Could not start: ${err.message}` };
    }
  }));

  const toWait = started.filter((r) => !r.outcome);
  const finished = toWait.length
    ? await waitForRuns(client, toWait, {
      timeoutMs: config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      log: gh.info,
    })
    : [];
  const runs = started.map((r) => r.outcome ? r : finished.find((f) => f.id === r.id));

  const verdict = evaluate(runs, config.failOn);
  writeOutputs(runs, verdict, env);

  verdict.warnings.forEach(gh.warning);
  verdict.failures.forEach(gh.error);
  gh.info(`Autonomous result: ${verdict.status} -> build ${verdict.success ? 'passes' : 'fails'}`);
  return verdict.success ? 0 : 1;
}

function writeOutputs(runs, verdict, env) {
  gh.setOutput('status', verdict.status, env);
  gh.setOutput('run-ids', runs.map((r) => r.id).filter(Boolean).join(','), env);
  gh.setOutput('results-url', runs.map((r) => r.resultsUrl).filter(Boolean).join(','), env);
  for (const k of ['passed', 'failed', 'unresolved', 'aborted']) {
    gh.setOutput(k, runs.reduce((sum, r) => sum + (r.result?.results?.[k] ?? 0), 0), env);
  }
}

// Comma/whitespace-separated list, de-duplicated.
function list(value) {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

function nonNegativeInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number >= 0, got "${value}"`);
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then((code) => { process.exitCode = code; }, (err) => {
    gh.error(`Unexpected error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
