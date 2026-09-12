'use strict';

/**
 * `pr-merge` wrap step (#570) — applies the PR resolutions the `pr-check`
 * gate staged, after `commit` has landed.
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const prMerge = require('../lib/wrap-steps/pr-merge');

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
    originals = { ...prMerge._internal };
  });

  beforeEach(() => {
    Object.assign(prMerge._internal, originals);
    // No test in this file may shell out to `gh pr merge` or to git.
    prMerge._internal.enqueueAutoMerge = async () => ({ ok: true, reason: null });
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
    prMerge._internal.enqueueAutoMerge = async (cwd, number) => {
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
    prMerge._internal.enqueueAutoMerge = async () => {
      mergedAfterPush = calls.some((c) => c.startsWith('push'));
      return { ok: true, reason: null };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.output.pushed, true);
    assert.equal(mergedAfterPush, true, 'the push must happen before the enqueue');
    assert.ok(calls.includes('push -u origin feat/x'));
  });

  it('measures against origin/<branch>, not the tracking ref', async () => {
    // A branch tracking something other than origin/<branch> (fork, second
    // remote) can be level with @{u} while origin still lacks the wrap commit.
    const calls = [];
    prMerge._internal.exec = async (file, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '0\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await prMerge.run(ctx({ 42: 'merge' }));
    assert.ok(calls.some((c) => c === 'rev-list --count origin/feat/x..HEAD'),
      'the ahead-count must be taken against the ref the PR is built from');
  });

  it('pushes when origin/<branch> does not exist yet', async () => {
    // First push of the branch: `rev-list` against a missing ref fails, which
    // must mean "push", never "assume it is current".
    const calls = [];
    prMerge._internal.exec = async (file, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'feat/x\n', stderr: '' };
      if (args[0] === 'rev-list') {
        return { exitCode: 128, stdout: '', stderr: "fatal: ambiguous argument 'origin/feat/x..HEAD'\n" };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = await prMerge.run(ctx({ 42: 'merge' }));
    assert.equal(result.output.pushed, true);
    assert.ok(calls.includes('push -u origin feat/x'));
    assert.equal(result.output.enqueued, 1);
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
    prMerge._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
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
    prMerge._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
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
    prMerge._internal.enqueueAutoMerge = async () => { merged++; return { ok: true, reason: null }; };
    const result = await prMerge.run(ctx({ 42: 'defer', 43: 'ignore' }));
    assert.equal(merged, 0);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /no PR was resolved as merge/);
  });

  it('WARNS but does not block when the enqueue fails — a halt here would strand the wrap', async () => {
    // This step runs after `commit`: the commit has landed and the session's
    // AI steps have already fired, so failing the pipeline here would leave a
    // half-finished wrap whose only recovery is re-running everything.
    prMerge._internal.enqueueAutoMerge = async () => ({
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
    prMerge._internal.enqueueAutoMerge = async (cwd, number) => {
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

describe('wrap-step pr-merge — remote error text carries no credential', () => {
  // Three producers in two files turn a failed remote command's stderr into
  // operator-facing text. `git push` echoes the remote it could not reach, and
  // a remote can be `https://<token>@host` — so each of them is a place a
  // credential escapes unless the string is redacted where it is built.
  //
  // Tokens are assembled at runtime, never written contiguously: a
  // secret-shaped literal in a tracked file is blocked by GitHub push
  // protection (#377), and recovering from that costs a history rewrite.
  const TOKEN = `gh${'o'}_notarealtokenvalue`;
  const REMOTE_ERR = `fatal: unable to access 'https://${TOKEN}@github.com/x/y.git/': 403`;

  // A freshly-required copy, because the describes above leave their own stubs
  // installed on the shared `_internal` table — snapshotting it here would
  // capture those, and this block needs the real `enqueueAutoMerge`.
  let mod;
  beforeEach(() => {
    delete require.cache[require.resolve('../lib/wrap-steps/pr-merge')];
    mod = require('../lib/wrap-steps/pr-merge');
  });

  it('_ensurePushed strips it from the reason a failed push produces', async () => {
    mod._internal.exec = async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'wrap/x\n', stderr: '' };
      if (cmd.startsWith('git rev-list')) return { exitCode: 0, stdout: '2\n', stderr: '' };
      if (cmd.startsWith('git push')) return { exitCode: 128, stdout: '', stderr: REMOTE_ERR };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const r = await mod._ensurePushed('/tmp');

    assert.equal(r.ok, false, 'refusing on a failed push is unchanged — only the text is');
    assert.ok(!r.reason.includes(TOKEN), 'the token must not reach the wrap result');
    assert.match(r.reason, /\/\/\*\*\*@github\.com/, 'the host survives; the credential does not');
    assert.match(r.reason, /403/, 'the diagnostic value survives redaction');
  });

  it('enqueueAutoMerge strips it from the reason a failed `gh pr merge` produces', async () => {
    mod._internal.execShell = async () => ({ exitCode: 1, stdout: '', stderr: REMOTE_ERR });

    const r = await mod._internal.enqueueAutoMerge('/tmp', 42);

    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes(TOKEN), 'the second producer in this file needs the same guard');
    assert.match(r.reason, /\/\/\*\*\*@github\.com/);
  });

  it('a stopped command is still reported as stopped, not redacted into silence', async () => {
    // The redaction must not swallow the "we killed it" wording, which is a
    // different verdict from a refusal and sends the operator somewhere else.
    mod._internal.execShell = async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: true, error: 'timed out' });

    const r = await mod._internal.enqueueAutoMerge('/tmp', 42);

    assert.match(r.reason, /stopped before it answered/);
  });
});
