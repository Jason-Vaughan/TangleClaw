'use strict';

/**
 * `pr-merge` wrap step (#570) — applies the PR resolutions the `pr-check`
 * gate staged, after `commit` has landed.
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const prMerge = require('../lib/wrap-steps/pr-merge');
const prCheck = require('../lib/wrap-steps/pr-check');

describe('wrap-step pr-merge — staged-resolution discovery', () => {
  it('finds the gate\'s staged entry by shape, not by step id', () => {
    const found = prMerge._findStagedResolutions({
      'some-other-step': { capturedText: 'not me' },
      'renamed-gate': { resolutions: { 42: 'merge' }, sessionScoped: [{ number: 42 }] }
    });
    assert.ok(found);
    assert.deepStrictEqual(found.resolutions, { 42: 'merge' });
  });

  it('returns null when nothing matching was staged', () => {
    assert.equal(prMerge._findStagedResolutions({ x: { capturedText: 'a' } }), null);
    assert.equal(prMerge._findStagedResolutions({}), null);
    assert.equal(prMerge._findStagedResolutions(null), null);
  });

  it('ignores an entry with resolutions but no PR list (not the gate\'s shape)', () => {
    assert.equal(prMerge._findStagedResolutions({ x: { resolutions: { 1: 'merge' } } }), null);
  });
});

describe('wrap-step pr-merge — handler', () => {
  let originals;

  before(() => {
    originals = { ...prCheck._internal };
  });

  beforeEach(() => {
    Object.assign(prCheck._internal, originals);
    // No test in this file may shell out to `gh pr merge`.
    prCheck._internal.enqueueAutoMerge = async () => ({ ok: true, reason: null });
  });

  /** Context with a gate entry already staged, as the real pipeline would. */
  function ctx(resolutions, staged) {
    return {
      project: { name: 'sandbox', path: '/tmp/sandbox-pr-merge', id: 1 },
      step: { id: 'apply-pr-resolutions' },
      previousResults: [],
      staged: staged || {
        'open-pr-check': {
          branch: 'feat/x',
          sessionScoped: Object.keys(resolutions).map((n) => ({ number: Number(n) })),
          resolutions
        }
      },
      options: {}
    };
  }

  it('enqueues auto-merge for each merge resolution', async () => {
    const calls = [];
    prCheck._internal.enqueueAutoMerge = async (cwd, number) => {
      calls.push({ cwd, number });
      return { ok: true, reason: null };
    };
    const c = ctx({ 42: 'merge', 7: 'merge' });
    const result = await prMerge.run(c);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    // Ascending order so a partial failure is reproducible.
    assert.deepStrictEqual(calls.map((x) => x.number), ['7', '42']);
    assert.equal(calls[0].cwd, '/tmp/sandbox-pr-merge');
    assert.equal(result.output.enqueued, 2);
    assert.equal(result.output.applied['42'].ok, true);
  });

  it('never touches the remote for defer or ignore', async () => {
    let merged = 0;
    prCheck._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
    const result = await prMerge.run(ctx({ 42: 'defer', 43: 'ignore' }));
    assert.equal(merged, 0);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no PR was resolved as merge/);
  });

  it('WARNS but does not block when the enqueue fails — a halt here would strand the wrap', async () => {
    // This step runs after `commit`: the commit has landed and the session's
    // AI steps have already fired, so failing the pipeline here would leave a
    // half-finished wrap whose only recovery is re-running everything.
    prCheck._internal.enqueueAutoMerge = async () => ({
      ok: false, reason: 'Auto-merge is not allowed for this repository'
    });
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.ok, true, 'must never block');
    assert.equal(result.status, 'done');
    assert.deepStrictEqual(result.blockers, []);
    assert.equal(result.output.warning, true);
    assert.equal(result.output.enqueued, 0);
    assert.match(result.output.failures[0], /PR #42: auto-merge could not be enqueued/);
    assert.match(result.output.remediation, /Allow auto-merge/);
    assert.match(result.output.remediation, /wrap itself completed/);
  });

  it('keeps the record of earlier successes when a later enqueue throws', async () => {
    // The remote is already mutated by the time PR 42 throws; discarding that
    // record would leave the operator unable to tell what actually happened.
    prCheck._internal.enqueueAutoMerge = async (cwd, number) => {
      if (number === '42') throw new Error('network died');
      return { ok: true, reason: null };
    };
    const result = await prMerge.run(ctx({ 7: 'merge', 42: 'merge' }));
    assert.equal(result.ok, true);
    assert.equal(result.output.applied['7'].ok, true, 'the earlier success survives');
    assert.equal(result.output.applied['42'].ok, false);
    assert.match(result.output.applied['42'].reason, /network died/);
  });

  it('records the outcome back onto the staged gate entry', async () => {
    const c = ctx({ 42: 'merge' });
    await prMerge.run(c);
    assert.equal(c.staged['open-pr-check'].applied['42'].ok, true);
  });

  it('skips when the gate staged nothing', async () => {
    const result = await prMerge.run(ctx({}, {}));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no PR resolutions were staged/);
  });

  it('skips without a project path rather than throwing', async () => {
    const result = await prMerge.run({ project: { name: 'x', id: 1 }, step: {}, staged: {} });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /requires context\.project\.path/);
  });
});
