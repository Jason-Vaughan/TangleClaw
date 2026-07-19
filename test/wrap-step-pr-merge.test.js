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
  let gitOriginals;

  before(() => {
    originals = { ...prCheck._internal };
    gitOriginals = { ...prMerge._internal };
  });

  beforeEach(() => {
    Object.assign(prCheck._internal, originals);
    Object.assign(prMerge._internal, gitOriginals);
    // No test in this file may shell out to `gh pr merge` or to git.
    prCheck._internal.enqueueAutoMerge = async () => ({ ok: true, reason: null });
    prMerge._internal.exec = async (file, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '0\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
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

  it('pushes the branch before enqueueing — a PR merged without the wrap commit is unrecoverable', async () => {
    // `commit` only pushes on the auto-branch path, and a session-scoped PR is
    // by definition on a feature branch — the path where the wrap commit stays
    // local. Enqueueing first would merge a PR that lacks it.
    const calls = [];
    prMerge._internal.exec = async (file, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '2\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    let mergedAfterPush = null;
    prCheck._internal.enqueueAutoMerge = async () => {
      mergedAfterPush = calls.some((c) => c.startsWith('push'));
      return { ok: true, reason: null };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.output.pushed, true);
    assert.equal(mergedAfterPush, true, 'the push must happen before the enqueue');
    assert.ok(calls.includes('push -u origin feat/x'));
  });

  it('does not push when the branch is already current', async () => {
    const calls = [];
    prMerge._internal.exec = async (file, args) => {
      calls.push(args[0]);
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '0\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.output.pushed, false);
    assert.ok(!calls.includes('push'));
    assert.equal(result.output.enqueued, 1);
  });

  it('enqueues NOTHING when the push fails — a stale PR beats a merged-but-incomplete one', async () => {
    let merged = 0;
    prCheck._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
    prMerge._internal.exec = async (file, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '1\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'remote rejected: protected branch\n' };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.ok, true, 'still must not block');
    assert.equal(merged, 0);
    assert.equal(result.output.warning, true);
    assert.equal(result.output.pushed, false);
    assert.match(result.output.failures[0], /Branch not pushed.*protected branch/);
    assert.match(result.output.remediation, /Push the branch and merge the PR yourself/);
  });

  it('declines on detached HEAD rather than guessing what to push', async () => {
    let merged = 0;
    prCheck._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
    prMerge._internal.exec = async (file, args) => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'HEAD\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(merged, 0);
    assert.match(result.output.failures[0], /detached/);
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
