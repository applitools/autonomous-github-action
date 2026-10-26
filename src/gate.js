// Decides whether the build passes, based on run outcomes and the fail-on rule.

export const GATEABLE = ['failed', 'unresolved', 'aborted'];

// Worst first; used to pick the overall status.
const SEVERITY = ['error', 'timed-out', 'failed', 'aborted', 'unresolved', 'passed'];

export function parseFailOn(value) {
  const items = String(value ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && items[0] === 'none') return [];
  const invalid = items.filter((i) => !GATEABLE.includes(i));
  if (invalid.length) {
    throw new Error(`Invalid fail-on value(s): ${invalid.join(', ')}. Use any of ${GATEABLE.join(', ')}, or "none".`);
  }
  return [...new Set(items)];
}

// A run can report status "unresolved" while also containing failed tests, so
// look at the per-test counts as well as the run status.
export function runCategories(run) {
  if (run.outcome === 'error' || run.outcome === 'timed-out') return new Set([run.outcome]);
  const categories = new Set([run.outcome]);
  for (const k of GATEABLE) {
    if ((run.result?.results?.[k] ?? 0) > 0) categories.add(k);
  }
  if (categories.size > 1) categories.delete('passed');
  return categories;
}

export function evaluate(runs, failOn) {
  const failures = [];
  const warnings = [];
  const all = new Set();

  for (const run of runs) {
    const categories = runCategories(run);
    categories.forEach((c) => all.add(c));
    for (const c of categories) {
      if (c === 'passed') continue;
      const message = describe(run, c);
      if (c === 'error' || c === 'timed-out' || failOn.includes(c)) failures.push(message);
      else warnings.push(message);
    }
  }

  const status = SEVERITY.find((s) => all.has(s)) ?? 'error';
  return { status, success: failures.length === 0 && runs.length > 0, failures, warnings };
}

function describe(run, category) {
  if (category === 'error' || category === 'timed-out') return `${run.label}: ${run.error ?? category}`;
  const count = run.result?.results?.[category];
  return `${run.label}: ${count ? `${count} ${category}` : category}`;
}
