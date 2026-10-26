import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseFailOn, runCategories } from '../src/gate.js';

const run = (outcome, results = {}, extra = {}) => ({ label: `run ${outcome}`, outcome, result: { results }, ...extra });

test('parseFailOn accepts lists, dedupes, and "none"', () => {
  assert.deepEqual(parseFailOn('failed, aborted\nfailed'), ['failed', 'aborted']);
  assert.deepEqual(parseFailOn('FAILED'), ['failed']);
  assert.deepEqual(parseFailOn('none'), []);
  assert.deepEqual(parseFailOn(''), []);
  assert.throws(() => parseFailOn('failed,bogus'), /Invalid fail-on value\(s\): bogus/);
});

test('runCategories uses counts as well as status', () => {
  assert.deepEqual([...runCategories(run('passed', { passed: 3 }))], ['passed']);
  assert.deepEqual([...runCategories(run('unresolved', { unresolved: 1, failed: 2 }))].sort(), ['failed', 'unresolved']);
  assert.deepEqual([...runCategories(run('timed-out', { failed: 2 }))], ['timed-out']);
});

test('all passed -> success', () => {
  const v = evaluate([run('passed', { passed: 2 }), run('passed', { passed: 1 })], ['failed']);
  assert.equal(v.status, 'passed');
  assert.equal(v.success, true);
  assert.deepEqual(v.failures, []);
  assert.deepEqual(v.warnings, []);
});

test('failed fails the build only when in fail-on', () => {
  assert.equal(evaluate([run('failed', { failed: 1 })], ['failed']).success, false);
  const lenient = evaluate([run('failed', { failed: 1 })], []);
  assert.equal(lenient.success, true);
  assert.deepEqual(lenient.warnings, ['run failed: 1 failed']);
});

test('unresolved warns by default and fails when configured', () => {
  const runs = [run('unresolved', { unresolved: 2, passed: 1 })];
  const warn = evaluate(runs, ['failed', 'aborted']);
  assert.equal(warn.success, true);
  assert.equal(warn.status, 'unresolved');
  assert.deepEqual(warn.warnings, ['run unresolved: 2 unresolved']);
  assert.equal(evaluate(runs, ['unresolved']).success, false);
});

test('aborted follows fail-on', () => {
  assert.equal(evaluate([run('aborted', { aborted: 1 })], ['aborted']).success, false);
  assert.equal(evaluate([run('aborted', { aborted: 1 })], ['failed']).success, true);
});

test('timeouts and errors always fail, even with fail-on none', () => {
  const t = evaluate([run('timed-out', {}, { error: 'took too long' })], []);
  assert.equal(t.success, false);
  assert.equal(t.status, 'timed-out');
  assert.deepEqual(t.failures, ['run timed-out: took too long']);
  assert.equal(evaluate([run('error', {}, { error: 'boom' })], []).success, false);
});

test('overall status is the worst outcome', () => {
  const v = evaluate([run('passed', { passed: 1 }), run('unresolved', { unresolved: 1 }), run('failed', { failed: 1 })], ['failed']);
  assert.equal(v.status, 'failed');
  assert.equal(evaluate([run('failed', { failed: 1 }), run('timed-out')], []).status, 'timed-out');
});

test('no runs is not a success', () => {
  assert.equal(evaluate([], ['failed']).success, false);
});
