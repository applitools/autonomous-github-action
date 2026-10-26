// Decides which plans and tests to run: explicit plan/test IDs plus any test-map
// entries that match the changed files.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTestMap, matchTestMap } from './test-map.js';
import { getChangedFiles } from './changes.js';

export const NO_MATCH_MODES = ['skip', 'all', 'fail'];

/**
 * @returns {{ targets: {kind, id}[], skipped: boolean }}
 * Throws when the test map is invalid or on-no-match is "fail" and nothing matched.
 */
export async function resolveTargets(config, env = process.env, { log = () => {}, warn = () => {}, changes = getChangedFiles } = {}) {
  const targets = [
    ...config.planIds.map((id) => ({ kind: 'plan', id })),
    ...config.testIds.map((id) => ({ kind: 'test', id })),
  ];
  if (!config.testMap) return { targets: dedupe(targets), skipped: false };

  const mapPath = resolve(env.GITHUB_WORKSPACE || process.cwd(), config.testMap);
  let text;
  try {
    text = readFileSync(mapPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read test-map ${config.testMap}: ${err.code === 'ENOENT' ? 'file not found (did you run actions/checkout?)' : err.message}`);
  }
  const entries = parseTestMap(text, config.testMap);
  const everything = entries.flatMap(entryTargets);

  let files = config.changedFiles;
  if (!files) {
    const result = await changes(env, { token: config.githubToken, log });
    files = result.files;
    if (!files) {
      warn(`Could not determine changed files (${result.reason}); running every test in ${config.testMap}`);
      return { targets: dedupe([...targets, ...everything]), skipped: false };
    }
  }

  const matched = matchTestMap(entries, files);
  for (const { entry, files: hits } of matched) {
    const label = entry.name ? `"${entry.name}"` : `[${entry.paths.join(', ')}]`;
    const shown = hits.slice(0, 5).join(', ') + (hits.length > 5 ? `, +${hits.length - 5} more` : '');
    log(`Test map ${label} matched ${hits.length} file(s): ${shown}`);
  }

  if (matched.length === 0) {
    const message = `No entry in ${config.testMap} matched the ${files.length} changed file(s)`;
    if (config.onNoMatch === 'fail') throw new Error(message);
    if (config.onNoMatch === 'all') {
      log(`${message}; running every test in the map (on-no-match: all)`);
      return { targets: dedupe([...targets, ...everything]), skipped: false };
    }
    log(`${message}; nothing extra to run (on-no-match: skip)`);
  }

  const all = dedupe([...targets, ...matched.flatMap(({ entry }) => entryTargets(entry))]);
  return { targets: all, skipped: all.length === 0 };
}

function entryTargets(entry) {
  return [
    ...entry.plans.map((id) => ({ kind: 'plan', id })),
    ...entry.tests.map((id) => ({ kind: 'test', id })),
  ];
}

function dedupe(targets) {
  const seen = new Set();
  return targets.filter((t) => {
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
