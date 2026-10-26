import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestMap, matchTestMap, compilePattern } from '../src/test-map.js';

const matches = (pattern, file) => compilePattern(pattern).regex.test(file);

test('glob: ** and *', () => {
  assert.ok(matches('src/**', 'src/a/b/c.js'));
  assert.ok(matches('src/**', 'src/a.js'));
  assert.ok(!matches('src/**', 'lib/src/a.js'));
  assert.ok(matches('src/*.js', 'src/a.js'));
  assert.ok(!matches('src/*.js', 'src/a/b.js'));
  assert.ok(matches('src/**/*.js', 'src/a.js'));
  assert.ok(matches('src/**/*.js', 'src/a/b/c.js'));
  assert.ok(matches('**', '.github/workflows/ci.yml'));
});

test('glob: patterns without a slash match at any depth', () => {
  assert.ok(matches('*.md', 'README.md'));
  assert.ok(matches('*.md', 'docs/guide/setup.md'));
  assert.ok(matches('package.json', 'packages/web/package.json'));
  assert.ok(!matches('*.md', 'docs/a.mdx'));
});

test('glob: anchoring, directories, braces, classes, ?', () => {
  assert.ok(matches('/README.md', 'README.md'));
  assert.ok(!matches('/README.md', 'docs/README.md'));
  assert.ok(matches('src/checkout/', 'src/checkout/cart/index.ts'));
  assert.ok(matches('**/checkout/**', 'apps/web/checkout/page.tsx'));
  assert.ok(matches('src/**/*.{ts,tsx}', 'src/a/b.tsx'));
  assert.ok(!matches('src/**/*.{ts,tsx}', 'src/a/b.js'));
  assert.ok(matches('v[0-9].txt', 'v3.txt'));
  assert.ok(matches('file?.js', 'file1.js'));
  assert.ok(matches('a+b(c).js', 'a+b(c).js'));
  assert.ok(!matches('a.js', 'aXjs'));
  assert.ok(matches('.github/**', '.github/workflows/ci.yml'));
});

const YAML = `
# Map of code areas to Autonomous tests
- name: Checkout          # cart and payment
  paths: ["src/checkout/**", "!**/*.md"]
  tests: [t-checkout-1, 't-checkout-2']
- name: "Everything else"
  paths:
    - src/**
    - "#weird/**"
  plans:
    - p-smoke
`;

test('parses the YAML subset', () => {
  const entries = parseTestMap(YAML, 'map.yml');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ matchers, ...e }) => e), [
    { name: 'Checkout', paths: ['src/checkout/**', '!**/*.md'], tests: ['t-checkout-1', 't-checkout-2'], plans: [] },
    { name: 'Everything else', paths: ['src/**', '#weird/**'], tests: [], plans: ['p-smoke'] },
  ]);
});

test('parses JSON', () => {
  const entries = parseTestMap('[{"paths": ["a/**"], "tests": ["t1"]}, {"paths": "b/**", "plans": "p1"}]');
  assert.deepEqual(entries.map((e) => [e.paths, e.tests, e.plans]), [[['a/**'], ['t1'], []], [['b/**'], [], ['p1']]]);
});

test('reports helpful errors', () => {
  const bad = (text, re) => assert.throws(() => parseTestMap(text, 'map.yml'), re);
  bad('- paths: [a]\n  test: [t1]', /line 2: unknown key "test"/);
  bad('- paths: [a]', /needs "tests" and\/or "plans"/);
  bad('- tests: [t1]', /"paths" is required/);
  bad('- paths: ["!a/**"]\n  tests: [t]', /at least one pattern that is not an exclusion/);
  bad('paths: [a]', /line 1: expected a list of entries/);
  bad('- paths: [a, "b]\n  tests: [t]', /unterminated quote/);
  bad('- paths: [a\n  tests: [t]', /unterminated list/);
  bad('- paths:\n  tests: [t]', /expected a list under "paths"/);
  bad('- paths: [a]\n  paths: [b]\n  tests: [t]', /duplicate key "paths"/);
  bad('- paths: [a]\n  tests: &anchor x', /unsupported YAML syntax/);
  bad('- paths: [a]\n  tests: [t]\n   - x', /line 3: unexpected indentation/);
  bad('{"paths": []}', /line 1/);
  bad('[{"paths": ["a"], "tests": [1]}]', /"tests" must be a list of non-empty strings/);
  bad('[not json', /invalid JSON/);
});

test('matchTestMap applies exclusions and returns the files that matched', () => {
  const entries = parseTestMap(YAML);
  const hit = matchTestMap(entries, ['src/checkout/cart.ts', 'src/checkout/README.md', 'docs/x.md']);
  assert.deepEqual(hit.map((h) => [h.entry.name, h.files]), [
    ['Checkout', ['src/checkout/cart.ts']],
    ['Everything else', ['src/checkout/cart.ts', 'src/checkout/README.md']],
  ]);
  assert.deepEqual(matchTestMap(entries, ['src/checkout/README.md']).map((h) => h.entry.name), ['Everything else']);
  assert.deepEqual(matchTestMap(entries, ['docs/x.md']), []);
});

test('a later include re-adds an excluded file', () => {
  const [entry] = parseTestMap('- paths: ["docs/**", "!**/*.md", "docs/important.md"]\n  tests: [t]');
  assert.equal(matchTestMap([entry], ['docs/important.md']).length, 1);
  assert.equal(matchTestMap([entry], ['docs/other.md']).length, 0);
});
