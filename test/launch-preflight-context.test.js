'use strict';

/**
 * Gathering the launch preflight's context, and running it (Train 21, #1586).
 *
 * `runPreflight` is pure and already has its own tests. What is under test here
 * is the half that pays for that purity: whether the reads against the database,
 * the handoff directory and git produce a context that describes the project as
 * it actually is — and whether a failure in any of them degrades the verdict
 * instead of taking down the launch.
 *
 * The distinction that matters most below: a verdict that is WRONG and a verdict
 * that says it could not be reached are different outcomes, and the second is
 * never dressed up as the first.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');
const continuity = require('../lib/continuity.js');
const lockfile = require('../lib/handoff-lockfile.js');
const { VERDICTS } = require('../lib/launch-preflight.js');
const { buildContext, evaluate, probeWorktree } = require('../lib/launch-preflight-context.js');
const { buildHandoffDocument, newPublicationId } = require('../lib/handoff-publication.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-preflight-ctx-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-preflight-root-'));
  tmpDirs.push(root);
  project = store.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, path: root, engine: 'claude' });
});

after(() => {
  try { store.close(); } catch { /* already closed */ }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Record a session for this project.
 * @param {string} [status] - Terminal or active status
 * @returns {object} The session row
 */
function addSession(status = 'wrapped') {
  const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `s-${Math.random().toString(36).slice(2)}` });
  if (status === 'wrapped') store.sessions.wrap(session.id, 'test');
  else if (status === 'killed') store.sessions.kill(session.id, 'test');
  else if (status === 'crashed') store.sessions.markCrashed(session.id, 'test');
  return session;
}

/**
 * Stage an attempt on disk and in the DB, binding eligibility by default.
 * @param {object} [opts] - `{sessionId, wrapRunId, kind, bind, worktree}`
 * @returns {string} The publication id
 */
function stageAttempt({ sessionId = 1, wrapRunId = 'run-1', kind = 'final', bind = true, worktree = null } = {}) {
  const publicationId = newPublicationId();
  const doc = buildHandoffDocument({
    publicationId, projectId: project.id, workspaceId: null, sessionId,
    wrapRunId, engineId: 'claude', kind, stagedAt: new Date().toISOString(),
    worktree, rules: [], globalRulesHash: null, engineConfigHash: null,
    continuityIndexHash: null, wrapOutcome: 'complete', missingEvidence: []
  });
  const written = lockfile.writeStaged(project, doc);
  store.handoffs.stage({
    publicationId, projectId: project.id, sessionId, wrapRunId, kind,
    fileDigest: written.digest, stagedAt: doc.stagedAt
  });
  if (bind) {
    if (kind === 'final') {
      store.handoffs.bindLifecycleEligibility(publicationId, sessionId, wrapRunId, new Date().toISOString());
    } else {
      store.handoffs.markCheckpointComplete(publicationId, wrapRunId, new Date().toISOString());
    }
  }
  return publicationId;
}

describe('the context describes the project as it is', () => {
  it('reads sessions, the epoch, the continuity index and an absent handoff', () => {
    const session = addSession('wrapped');
    const ctx = buildContext(project);

    assert.deepEqual(ctx.sessions, [{ id: session.id, status: 'wrapped' }]);
    assert.equal(ctx.projectId, project.id);
    assert.equal(ctx.file.state, 'absent');
    assert.equal(ctx.continuityIndexPresent, false, 'no index was written');
    assert.equal(ctx.handoffEpoch.present, true, 'the project was created with its epoch');
    assert.equal(ctx.handoffEpoch.baseline, store.HANDOFF_BASELINES.EMPTY);
  });

  it('notices a continuity index once one exists', () => {
    const file = continuity.indexPath(project.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Continuity index\n');
    assert.equal(buildContext(project).continuityIndexPresent, true);
  });

  it('reports a corrupt current.json as invalid, not unreadable', () => {
    // Two different problems needing two different words in front of an
    // operator: the bytes read fine, and it is the document this build does not
    // understand.
    fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
    fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    const ctx = buildContext(project);
    assert.equal(ctx.file.state, 'invalid');
    assert.equal(ctx.file.doc, null, 'nothing dereferences a document that did not parse');
  });

  it('reports an unparseable current.json as invalid too', () => {
    fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
    fs.writeFileSync(lockfile.currentPath(project), 'not json at all', 'utf8');
    assert.equal(buildContext(project).file.state, 'invalid');
  });

  it('offers only staged files the record knows about', () => {
    // A staged file with no row is not evidence of an attempt — the row is what
    // an attempt IS — so a file on disk can never nominate itself.
    const pid = stageAttempt();
    fs.writeFileSync(lockfile.stagedPath(project, 'pub-nobody-staged'), JSON.stringify({
      schema: 'tc.handoff/1', publicationId: 'pub-nobody-staged', kind: 'final'
    }) + '\n', 'utf8');

    const ctx = buildContext(project);
    assert.deepEqual(ctx.stagedFiles.map((f) => f.publicationId), [pid]);
  });

  it('includes a publication\'s producing session even when it falls outside the window', () => {
    // Check 6's checkpoint branch looks the producer up by id. A lookup that
    // missed it would not error — the branch would simply not fire — so the
    // producers are fetched rather than hoped for.
    const producer = addSession('wrapped');
    stageAttempt({ sessionId: producer.id, kind: 'checkpoint' });
    // Rebuild the context from a deliberately empty window.
    const ctx = buildContext(project);
    assert.ok(ctx.sessions.some((s) => s.id === producer.id));

    store.getDb().prepare('DELETE FROM sessions WHERE id = ?').run(producer.id);
    const afterDelete = buildContext(project);
    assert.ok(!afterDelete.sessions.some((s) => s.id === producer.id),
      'a producer whose session row is gone is left out rather than invented');
  });

  it('carries the launching workspace id through, and defaults it to null', () => {
    assert.equal(buildContext(project).workspaceId, null);
    assert.equal(buildContext(project, { workspaceId: 'ws-1' }).workspaceId, 'ws-1');
  });
});

describe('probing the worktree a handoff recorded', () => {
  it('answers null when no worktree was recorded — a non-git project', () => {
    // `null` and `toplevelExists: false` are different facts and stay different:
    // one never had a worktree, the other lost it.
    assert.equal(probeWorktree(null), null);
    assert.equal(probeWorktree({ toplevel: '' }), null);
  });

  it('reports a recorded worktree whose directory is gone', () => {
    const probe = probeWorktree({ toplevel: '/nonexistent/tc-preflight-gone' });
    assert.deepEqual(probe, { toplevelExists: false, headSha: null, branch: null });
  });

  it('reports HEAD and branch for one that is still there', () => {
    const calls = [];
    const exec = (bin, args) => {
      calls.push(args.join(' '));
      return args.includes('--abbrev-ref') ? 'main\n' : 'abc123\n';
    };
    const probe = probeWorktree({ toplevel: project.path }, exec);
    assert.deepEqual(probe, { toplevelExists: true, headSha: 'abc123', branch: 'main' });
    assert.equal(calls.length, 2);
  });

  it('reports a null HEAD when the probe fails on a directory that does exist', () => {
    // An unverifiable worktree is not a verified one. The decision reads a null
    // head as "not the recorded sha", which is the conservative direction.
    const exec = () => { throw new Error('git exploded'); };
    const probe = probeWorktree({ toplevel: project.path }, exec);
    assert.deepEqual(probe, { toplevelExists: true, headSha: null, branch: null });
  });
});

describe('evaluate', () => {
  it('reaches first-launch for a project with nothing at all', () => {
    const result = evaluate(project);
    assert.equal(result.verdict, VERDICTS.FIRST_LAUNCH);
    assert.equal(result.evaluationFailed, false);
    assert.equal(result.repaired, false);
    assert.ok(result.reason.length > 0, 'a verdict always carries a reason');
  });

  it('reaches crash-recovery when the newest session did not end on its own terms', () => {
    addSession('wrapped');
    addSession('crashed');
    assert.equal(evaluate(project).verdict, VERDICTS.CRASH_RECOVERY);
  });

  it('applies a repair and returns the verdict from the pass AFTER it', () => {
    // The whole point of the re-run: the first decision is about a state the
    // repair has just changed.
    const session = addSession('wrapped');
    const pid = stageAttempt({ sessionId: session.id });

    const result = evaluate(project);
    assert.equal(result.repaired, true);
    assert.equal(result.verdict, VERDICTS.OK, 'not the `unfinished` the first pass saw');
    assert.equal(result.repairOutcomes.length, 1);
    assert.equal(result.repairOutcomes[0].applied, true);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).doc.publicationId, pid);
  });

  it('keeps the unrepaired verdict when the repair is refused', () => {
    const session = addSession('wrapped');
    const pid = stageAttempt({ sessionId: session.id });
    // Break the bytes so the re-check inside the repair refuses.
    fs.writeFileSync(lockfile.stagedPath(project, pid), '{"schema":"tc.handoff/1","publicationId":"' + pid + '","kind":"final"}\n', 'utf8');

    const result = evaluate(project);
    assert.equal(result.repaired, false);
    assert.equal(result.verdict, VERDICTS.UNFINISHED,
      'a refused repair leaves the verdict that named the problem');
  });

  it('runs the repair pass exactly once — it never loops', () => {
    // A second pass would be a launch retrying itself. Counted through the
    // outcomes: one repair proposed, one outcome, whatever the re-run says.
    const session = addSession('wrapped');
    stageAttempt({ sessionId: session.id });
    const result = evaluate(project);
    assert.equal(result.repairOutcomes.length, 1);
  });

  it('degrades to not-evaluated rather than throwing when the context cannot be gathered', () => {
    // "Could not check" is never dressed up as "checked, and it is fine". The
    // project record names a path that is not a string, which the continuity
    // read cannot take.
    const result = evaluate({ id: project.id, name: project.name, path: 42 });
    assert.equal(result.evaluationFailed, true);
    assert.equal(result.verdict, 'not-evaluated');
    assert.match(result.reason, /could not be checked/);
  });

  it('survives a project that does not exist without throwing', () => {
    const result = evaluate({ id: 999999, name: 'ghost', path: '/nonexistent/tc-ghost' });
    assert.equal(typeof result.verdict, 'string');
    assert.equal(result.repaired, false);
  });
});

describe('what the launch record keeps', () => {
  it('a reconciliation-demanding verdict is reported as one', () => {
    // `stale` is reconciliation, not recovery: the handoff is sound, the tree
    // moved under it.
    const session = addSession('wrapped');
    const pid = stageAttempt({
      sessionId: session.id,
      worktree: { path: project.path, toplevel: project.path, gitDir: null, branch: 'main', headSha: 'recorded-sha', dirty: false }
    });
    const { publishHandoff } = require('../lib/handoff-publish.js');
    assert.equal(publishHandoff(project, pid).published, true);

    const exec = (bin, args) => (args.includes('--abbrev-ref') ? 'main\n' : 'a-different-sha\n');
    const result = evaluate(project, { exec });
    assert.equal(result.verdict, VERDICTS.STALE);
    const { needsReconciliation } = require('../lib/launch-preflight.js');
    assert.equal(needsReconciliation(result), true);
  });
});

describe('what the launch path actually produces', () => {
  it('probes the registered root only when the recorded worktree is gone', () => {
    // §2.7 promises this as the diagnosis an operator gets for
    // `workspace-unavailable`. It was plumbed end to end and hardcoded null in
    // the first cut, so the test that mattered was never the pure module's
    // pass-through — it was whether anything produces a value at all.
    const session = addSession('wrapped');
    const pid = stageAttempt({
      sessionId: session.id,
      worktree: { path: '/nonexistent/tc-gone', toplevel: '/nonexistent/tc-gone', gitDir: null, branch: 'main', headSha: 'recorded', dirty: false }
    });
    const { publishHandoff } = require('../lib/handoff-publish.js');
    assert.equal(publishHandoff(project, pid).published, true);

    const exec = () => 'root-head-sha\n';
    const ctx = buildContext(project, { exec });
    assert.equal(ctx.worktreeProbe.toplevelExists, false, 'precondition: the recorded worktree is gone');
    assert.equal(ctx.fallbackRootHead, 'root-head-sha', 'the registered root IS probed');

    const result = evaluate(project, { exec });
    assert.equal(result.verdict, VERDICTS.WORKSPACE_UNAVAILABLE);
    assert.equal(result.evidence.fallbackRootHead, 'root-head-sha',
      'and it reaches the evidence an operator reads');
  });

  it('does not probe the registered root when the worktree is still there', () => {
    // A probe nobody will read is a git call on every launch for nothing.
    const session = addSession('wrapped');
    const pid = stageAttempt({
      sessionId: session.id,
      worktree: { path: project.path, toplevel: project.path, gitDir: null, branch: 'main', headSha: 'recorded', dirty: false }
    });
    const { publishHandoff } = require('../lib/handoff-publish.js');
    publishHandoff(project, pid);

    const calls = [];
    const exec = (bin, args, opts) => { calls.push(opts.cwd); return args.includes('--abbrev-ref') ? 'main\n' : 'recorded\n'; };
    const ctx = buildContext(project, { exec });
    assert.equal(ctx.fallbackRootHead, null);
    assert.ok(calls.every((cwd) => cwd === project.path), 'only the recorded worktree was probed');
  });

  it('answers both predicates so a caller need not know which applies', () => {
    // `requiresRecovery` has no production consumer until #1587's recovery gate.
    // It is answered anyway: the predicate a caller has to go and find is the
    // one that gets forgotten.
    const session = addSession('wrapped');
    const pid = stageAttempt({
      sessionId: session.id,
      worktree: { path: project.path, toplevel: project.path, gitDir: null, branch: 'main', headSha: 'recorded-sha', dirty: false }
    });
    const { publishHandoff } = require('../lib/handoff-publish.js');
    publishHandoff(project, pid);

    const exec = (bin, args) => (args.includes('--abbrev-ref') ? 'main\n' : 'a-different-sha\n');
    const result = evaluate(project, { exec });
    assert.equal(result.verdict, VERDICTS.STALE);
    assert.equal(result.requiresReconciliation, true, 'stale is reconciliation, not recovery');
    assert.equal(result.requiresRecovery, false);
  });

  it('owes RECOVERY when it could not decide at all, and says it tried', () => {
    // This expectation is the inverse of what it once asserted, and the inversion
    // is the contract: failing to establish current continuity is not evidence
    // that continuity is sound. A launch that could not run its required check
    // must not proceed to an ungated READY on the strength of a decision nobody
    // reached.
    const result = evaluate({ id: project.id, name: project.name, path: 42 });
    assert.equal(result.requiresRecovery, true,
      'a check that could not be performed is not a check that passed');
    // Reconciliation stays false on purpose: a reconciliation cannot clear
    // operator-mode recovery, so demanding one here would name a gate the
    // launch is not standing at.
    assert.equal(result.requiresReconciliation, false);
    // A POSITIVELY OBSERVED failure: called, and it threw. Distinct from
    // `evaluationMissing`, which is the weaker claim that no usable result is
    // available. Both owe recovery.
    assert.equal(result.evaluationFailed, true);
    assert.equal(result.evaluationMissing, false);
  });
});
