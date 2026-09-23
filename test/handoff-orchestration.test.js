'use strict';

/**
 * The wrap-level handoff decision (Train 21, #1585).
 *
 * `_stagedHandoff` and `_finalizeHandoff` are the seam between the pipeline's
 * recorded result rows and the handoff store. Unit tests on either side of that
 * seam pass while it is mis-wired — which is exactly what happened — so these
 * drive it with the runner's REAL row shape and assert the end state.
 *
 * Every branch of the decision is covered: published, abandoned for each of the
 * four reasons, and the checkpoint path.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');
const sessions = require('../lib/sessions.js');
const lockfile = require('../lib/handoff-lockfile.js');
const stageStep = require('../lib/wrap-steps/handoff-stage.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-orch-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-orch-root-'));
  tmpDirs.push(root);
  project = store.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, path: root, engine: 'claude' });
});

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Run the real step so the attempt exists exactly as a wrap would create it,
 * then return a pipeline result carrying its row in the runner's shape.
 * @param {object} [opts] - `{runId, sessionId, keepSessionRunning}`
 * @returns {Promise<{pipelineResult: object, publicationId: string, sessionId: number}>}
 */
async function stageViaStep({ runId = 'run-1', sessionId = 5, keepSessionRunning = false } = {}) {
  const stepResult = await stageStep.run({
    project,
    session: { id: sessionId, engineId: 'claude' },
    previousResults: [],
    scope: {},
    options: { keepSessionRunning },
    wrapRunId: runId
  });
  const pipelineResult = {
    ok: true,
    blockedAt: null,
    results: [{
      stepId: 'handoff-stage',
      kind: 'handoff-stage',
      status: stepResult.status,
      output: stepResult.output,
      blockers: []
    }]
  };
  return { pipelineResult, publicationId: stepResult.output.publicationId, sessionId };
}

describe('finding this run\'s staged attempt', () => {
  it('reads the step\'s output out of the runner\'s recorded rows', async () => {
    const { pipelineResult, publicationId } = await stageViaStep({ runId: 'run-x' });
    const found = sessions._stagedHandoff(pipelineResult, 'run-x');
    assert.equal(found.publicationId, publicationId);
    assert.equal(found.wrapRunId, 'run-x');
  });

  it('finds nothing when the step did not run', () => {
    const pipelineResult = { results: [{ stepId: 'commit', kind: 'commit', status: 'done', output: {}, blockers: [] }] };
    assert.equal(sessions._stagedHandoff(pipelineResult, 'run-x'), null);
  });

  it('finds nothing when the step skipped and staged no attempt', async () => {
    const stepResult = await stageStep.run({
      project, session: { id: 5 }, previousResults: [], scope: {}, options: {}, wrapRunId: null
    });
    const pipelineResult = {
      results: [{ stepId: 'handoff-stage', kind: 'handoff-stage', status: stepResult.status, output: stepResult.output, blockers: [] }]
    };
    assert.equal(sessions._stagedHandoff(pipelineResult, 'run-x'), null);
  });
});

describe('deciding what happens to the staged attempt', () => {
  it('PUBLISHES when the lifecycle completed and the attempt was bound', async () => {
    const { publicationId, sessionId } = await stageViaStep();
    store.handoffs.bindLifecycleEligibility(publicationId, sessionId, 'run-1', new Date().toISOString());

    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });

    assert.equal(store.handoffs.get(publicationId).state, 'published');
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).doc.publicationId, publicationId);
  });

  it('ABANDONS when Kill won the race and the lifecycle never completed', async () => {
    const { publicationId } = await stageViaStep();
    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'final' }, {
      lifecycleCompleted: false, publicationBound: false, keepRequested: false, pipelineOk: true
    });

    const row = store.handoffs.get(publicationId);
    assert.equal(row.state, 'abandoned');
    assert.equal(row.abandonedReason, 'lifecycle-incomplete');
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).outcome, 'absent',
      'nothing is published for an attempt that did not complete');
  });

  it('ABANDONS when the pipeline itself failed', async () => {
    const { publicationId } = await stageViaStep();
    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'final' }, {
      lifecycleCompleted: false, publicationBound: null, keepRequested: false, pipelineOk: false
    });
    assert.equal(store.handoffs.get(publicationId).abandonedReason, 'pipeline-failed');
  });

  it('ABANDONS when the lifecycle completed but the binding did not match this attempt', async () => {
    const { publicationId } = await stageViaStep();
    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: false, keepRequested: false, pipelineOk: true
    });
    assert.equal(store.handoffs.get(publicationId).abandonedReason, 'eligibility-not-bound');
  });

  it('binds and publishes a kept session\'s CHECKPOINT, which has no lifecycle transition', async () => {
    const { publicationId } = await stageViaStep({ keepSessionRunning: true });
    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'checkpoint' }, {
      lifecycleCompleted: false, publicationBound: null, keepRequested: true, pipelineOk: true
    });

    const row = store.handoffs.get(publicationId);
    assert.equal(row.eligibleVia, 'checkpoint-complete');
    assert.equal(row.state, 'published');
  });

  it('ABANDONS a checkpoint whose pipeline failed, without binding it', async () => {
    const { publicationId } = await stageViaStep({ keepSessionRunning: true });
    sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'checkpoint' }, {
      lifecycleCompleted: false, publicationBound: null, keepRequested: true, pipelineOk: false
    });
    const row = store.handoffs.get(publicationId);
    assert.equal(row.state, 'abandoned');
    assert.equal(row.eligibleAt, null);
  });

  it('never leaves an attempt STAGED — every branch either publishes or abandons', async () => {
    const branches = [
      { lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true },
      { lifecycleCompleted: false, publicationBound: false, keepRequested: false, pipelineOk: true },
      { lifecycleCompleted: false, publicationBound: null, keepRequested: false, pipelineOk: false },
      { lifecycleCompleted: true, publicationBound: false, keepRequested: false, pipelineOk: true },
      { lifecycleCompleted: false, publicationBound: null, keepRequested: true, pipelineOk: true },
      { lifecycleCompleted: false, publicationBound: null, keepRequested: true, pipelineOk: false }
    ];
    for (const [i, verdicts] of branches.entries()) {
      const { publicationId } = await stageViaStep({
        runId: `run-b${i}`, sessionId: 100 + i, keepSessionRunning: verdicts.keepRequested
      });
      if (verdicts.publicationBound === true) {
        store.handoffs.bindLifecycleEligibility(publicationId, 100 + i, `run-b${i}`, new Date().toISOString());
      }
      sessions._finalizeHandoff(project, {
        publicationId, wrapRunId: `run-b${i}`, kind: verdicts.keepRequested ? 'checkpoint' : 'final'
      }, verdicts);

      const state = store.handoffs.get(publicationId).state;
      assert.notEqual(state, 'staged',
        `branch ${i} left the attempt staged, which reads to reconciliation as a crash that never happened`);
    }
  });
});

describe('the step reads only what wrap-scope actually produces', () => {
  // This guard exists because the same defect landed three times: a field read
  // off a foreign object by a name its producer never emits, with a hand-built
  // fixture supplying the invented name so the tests agreed. The document's
  // bytes are frozen at staging, so a wrong value here can never be repaired.
  // Assert against a REAL resolved scope, never a literal.
  it('every scope key the handoff reads exists on a real resolved scope, with the type it is used as', async () => {
    const wrapScope = require('../lib/wrap-scope.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-scope-'));
    tmpDirs.push(repo);
    const { execFileSync } = require('node:child_process');
    const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 't@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);

    const proj = { id: project.id, name: project.name, path: repo, configPath: repo };
    const scope = await wrapScope.resolve(proj, null, {});

    for (const key of ['workTree', 'workToplevel', 'workGitDir', 'trunk', 'baseline']) {
      assert.ok(key in scope, `handoff-stage reads scope.${key}, which wrap-scope does not produce`);
    }
    // The two fields that were silently wrong, pinned by TYPE rather than presence.
    assert.equal(typeof scope.workGitDir, 'string', 'gitDir must come from a path, not a flag');
    assert.equal(typeof scope.worktreeTarget, 'boolean',
      'worktreeTarget is a boolean — it must never be used as gitDir');

    const facts = stageStep._worktreeFacts(scope);
    assert.equal(typeof facts.gitDir, 'string');
    assert.equal(facts.dirty, false, 'the fixture tree is clean at this point');

    // The facts must describe ONE tree: the branch named has to contain the sha
    // named. They came from different moments once — the scope's trunk branch
    // probed before the commit step, the sha from the session's launch — and a
    // fixture that supplies the right answer cannot catch that, so this asserts
    // agreement against a real tree rather than against handed-in values.
    const measured = stageStep._worktreeFacts(scope);
    const gitOut = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const head = gitOut(['rev-parse', 'HEAD']);
    const onBranch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);

    assert.equal(measured.headSha, head,
      'headSha must be THIS tree\'s head, never a sha carried from another moment');
    assert.equal(measured.branch, onBranch,
      'branch must be THIS tree\'s branch, not one probed before the commit step');

    // The property the document actually needs, and the one that was false on
    // the live install: the branch it names must CONTAIN the sha it names.
    const contains = gitOut(['branch', '--contains', measured.headSha])
      .split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim()).filter(Boolean);
    assert.ok(contains.includes(measured.branch),
      `the handoff claims branch ${measured.branch} at ${measured.headSha}, but that branch does not contain it`);
  });

  // `dirty` decides a recovery verdict (plan §2.7: a removed worktree needs
  // recovery iff it was dirty), and a kept session stages a checkpoint, another
  // checkpoint and a final well inside `git.getInfo`'s TTL. A membership check
  // — dirty is true, false or null — is satisfied by a value read minutes ago
  // from a different attempt, so it cannot tell a measurement from a memory.
  // Straddle a real write instead: the only thing that changes between these
  // two calls is the tree itself.
  it('measures dirty at the moment of staging, not from a cached earlier reading', async () => {
    const wrapScope = require('../lib/wrap-scope.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-dirty-'));
    tmpDirs.push(repo);
    const { execFileSync } = require('node:child_process');
    const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 't@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);

    const proj = { id: project.id, name: project.name, path: repo, configPath: repo };
    const scope = await wrapScope.resolve(proj, null, {});

    const clean = stageStep._worktreeFacts(scope);
    assert.equal(clean.dirty, false, 'a committed tree stages as clean');

    fs.writeFileSync(path.join(repo, 'f.txt'), 'uncommitted\n');

    const dirty = stageStep._worktreeFacts(scope);
    assert.equal(dirty.dirty, true,
      'the second staging must see the write — a cached reading would still say false');
  });
});

/*
 * #1649 — a failed git probe must not freeze "this project has no worktree".
 *
 * `wrap-scope` keeps two states apart that the handoff flattened: a root that
 * is not a git repository, and a root whose git probe could not run. Both leave
 * `workToplevel` null, and `worktree: null` is the single field that disables
 * the launch's two workspace checks and satisfies a precondition of `ok`. So a
 * wrap whose probe timed out froze a clean bill of health for a tree nobody
 * measured — and the bytes are frozen at staging, so nothing could repair it.
 *
 * These drive REAL `wrapScope.resolve` calls rather than literals. A hand-built
 * scope would supply whichever discriminator the code happens to read, which is
 * exactly how the sibling defects in this file went undetected.
 */
describe('a probe failure and a non-git root are different handoffs (#1649)', () => {
  const wrapScope = require('../lib/wrap-scope.js');

  /** A scope resolved against an exec that cannot run git at all.
   * @returns {Promise<object>} the resolved scope */
  async function scopeWithFailedProbe() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1649-failed-'));
    tmpDirs.push(dir);
    const proj = { id: project.id, name: project.name, path: dir, configPath: dir };
    return wrapScope.resolve(proj, null, {
      exec: async () => {
        const err = new Error('git rev-parse timed out after 5000ms');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      paneCurrentPath: async () => null
    });
  }

  it('a scope whose git probe failed yields no facts AND a stated reason', async () => {
    const scope = await scopeWithFailedProbe();

    // The producer's half of the contract, asserted by TYPE against the real
    // resolver: if `workTreeProblem` ever stopped being a reason string, the
    // discriminator below would silently read every failure as a non-repo.
    assert.equal(scope.workToplevel, null);
    assert.equal(typeof scope.workTreeProblem, 'string');
    assert.ok(scope.workTreeProblem.trim(), 'a probe failure must name itself');

    assert.equal(stageStep._worktreeFacts(scope), null,
      'there are no facts to record — that part is unchanged');
    assert.equal(stageStep._worktreeProblem(scope), scope.workTreeProblem,
      'the null must be accompanied by the reason, or it reads as "no worktree"');
  });

  it('a genuine non-git root still records a bare null, with no reason', async () => {
    // The case the null was always FOR, and the one that must not regress: an
    // ordinary directory. If this started carrying a problem string, every
    // non-git project would be pushed into reconciliation forever.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1649-plain-'));
    tmpDirs.push(dir);
    const proj = { id: project.id, name: project.name, path: dir, configPath: dir };
    const scope = await wrapScope.resolve(proj, null, { paneCurrentPath: async () => null });

    assert.equal(scope.workToplevel, null, 'a plain directory has no git identity');
    assert.equal(stageStep._worktreeFacts(scope), null);
    assert.equal(stageStep._worktreeProblem(scope), null,
      'nothing failed here — the null means what the schema says it means');
  });

  it('a readable repository records facts and no reason', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1649-repo-'));
    tmpDirs.push(repo);
    const { execFileSync } = require('node:child_process');
    const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 't@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);

    const proj = { id: project.id, name: project.name, path: repo, configPath: repo };
    const scope = await wrapScope.resolve(proj, null, {});

    assert.ok(stageStep._worktreeFacts(scope), 'a readable tree produces facts');
    assert.equal(stageStep._worktreeProblem(scope), null,
      'the reason is load-bearing only where it explains a missing fact');
  });

  // The JOIN, which every test above leaves unpinned: each one asserts a side.
  // Delete `worktreeProblem: _worktreeProblem(scope)` from the step's
  // `buildHandoffDocument` call and all of them stay green while the frozen
  // bytes silently lose the discriminator — the same seam failure this file's
  // header records for #1585. So drive the REAL step with a REAL failed-probe
  // scope and read the staged bytes back off disk.
  it('the staged bytes carry the probe failure, not just the helper', async () => {
    const scope = await scopeWithFailedProbe();
    const stepResult = await stageStep.run({
      project,
      session: { id: 7, engineId: 'claude' },
      previousResults: [],
      scope,
      options: { keepSessionRunning: false },
      wrapRunId: 'run-1649'
    });

    const staged = lockfile.readHandoffFile(lockfile.stagedPath(project, stepResult.output.publicationId));
    assert.equal(staged.outcome, 'ok', 'the staged document must still read back as a handoff');
    assert.equal(staged.doc.worktree, null);
    assert.equal(staged.doc.worktreeProblem, scope.workTreeProblem,
      'the reason must reach the frozen bytes — the whole point is that they cannot be repaired later');
  });

  it('refuses to build a document that records both facts and a failure', async () => {
    // The two are mutually exclusive by construction, so the honesty contract
    // is enforced where the bytes are made rather than discovered by a reader
    // who has no safe way to pick a side.
    const { buildHandoffDocument } = require('../lib/handoff-publication.js');
    const base = {
      publicationId: 'pid-x', projectId: project.id, sessionId: 1, wrapRunId: 'run-x',
      engineId: 'claude', kind: 'final', stagedAt: new Date().toISOString(),
      wrapOutcome: 'complete', rules: []
    };
    assert.throws(
      () => buildHandoffDocument({
        ...base,
        worktree: { path: '/repo', toplevel: '/repo' },
        worktreeProblem: 'git could not be run'
      }),
      /cannot record worktree facts and a probe failure at once/
    );
  });
});

describe('the wrap result names what became of its handoff (#1675)', () => {
  it('reports PUBLISHED with the id and the digest the row attests to', async () => {
    const { publicationId, sessionId } = await stageViaStep();
    store.handoffs.bindLifecycleEligibility(publicationId, sessionId, 'run-1', new Date().toISOString());
    const out = sessions._finalizeHandoff(project, { publicationId, wrapRunId: 'run-1', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });
    assert.equal(out.state, 'published');
    assert.equal(out.publicationId, publicationId);
    assert.equal(out.kind, 'final');
    assert.equal(out.reason, null);
    assert.equal(out.digest, store.handoffs.get(publicationId).fileDigest);
    assert.equal(out.digest, lockfile.readHandoffFile(lockfile.currentPath(project)).digest,
      'the digest the wrap reports is the digest of the bytes the next launch reads');
  });

  it('reports NOT-PUBLISHED, with the refusal, when a newer publication is already current', async () => {
    const older = await stageViaStep({ runId: 'run-old', sessionId: 7 });
    const newer = await stageViaStep({ runId: 'run-new', sessionId: 8 });
    store.handoffs.bindLifecycleEligibility(older.publicationId, 7, 'run-old', new Date().toISOString());
    store.handoffs.bindLifecycleEligibility(newer.publicationId, 8, 'run-new', new Date().toISOString());
    const won = sessions._finalizeHandoff(project, { publicationId: newer.publicationId, wrapRunId: 'run-new', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });
    assert.equal(won.state, 'published');

    const lost = sessions._finalizeHandoff(project, { publicationId: older.publicationId, wrapRunId: 'run-old', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });
    assert.equal(lost.state, 'not-published');
    assert.match(lost.reason, /newer publication/);
    assert.equal(lost.publicationId, older.publicationId);
    // Directional and structured: the winner is named in its own slot, never
    // left for a client to parse out of `reason`, and never in the slot that
    // means "the one this attempt displaced".
    assert.equal(lost.supersededById, newer.publicationId);
    assert.equal(lost.supersededId, null);
  });

  it('names the publication a win DISPLACED in supersededId, and nothing in supersededById', async () => {
    const first = await stageViaStep({ runId: 'run-1st', sessionId: 11 });
    const second = await stageViaStep({ runId: 'run-2nd', sessionId: 12 });
    for (const [pub, sid, run] of [[first.publicationId, 11, 'run-1st'], [second.publicationId, 12, 'run-2nd']]) {
      store.handoffs.bindLifecycleEligibility(pub, sid, run, new Date().toISOString());
    }
    sessions._finalizeHandoff(project, { publicationId: first.publicationId, wrapRunId: 'run-1st', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });
    const won = sessions._finalizeHandoff(project, { publicationId: second.publicationId, wrapRunId: 'run-2nd', kind: 'final' }, {
      lifecycleCompleted: true, publicationBound: true, keepRequested: false, pipelineOk: true
    });
    assert.equal(won.state, 'published');
    assert.equal(won.supersededId, first.publicationId);
    assert.equal(won.supersededById, null);
  });

  it('reports ABANDONED with the store\'s reason on every abandoning branch', async () => {
    const cases = [
      [{ lifecycleCompleted: false, publicationBound: false, keepRequested: false, pipelineOk: true }, 'lifecycle-incomplete'],
      [{ lifecycleCompleted: false, publicationBound: null, keepRequested: false, pipelineOk: false }, 'pipeline-failed'],
      [{ lifecycleCompleted: true, publicationBound: false, keepRequested: false, pipelineOk: true }, 'eligibility-not-bound'],
      [{ lifecycleCompleted: false, publicationBound: null, keepRequested: true, pipelineOk: false }, 'pipeline-failed']
    ];
    for (const [i, [verdicts, reason]] of cases.entries()) {
      const { publicationId } = await stageViaStep({ runId: `run-a${i}`, sessionId: 200 + i, keepSessionRunning: verdicts.keepRequested });
      const out = sessions._finalizeHandoff(project, {
        publicationId, wrapRunId: `run-a${i}`, kind: verdicts.keepRequested ? 'checkpoint' : 'final'
      }, verdicts);
      assert.equal(out.state, 'abandoned', `case ${i}`);
      assert.equal(out.reason, reason, `case ${i}`);
      assert.equal(store.handoffs.get(publicationId).abandonedReason, reason, `case ${i}: the result says what the store recorded`);
    }
  });

  it('reports NOT-STAGED with the step\'s own reason, or that the run stopped before the step', () => {
    const skipped = sessions._unstagedHandoff({ results: [{
      stepId: 'handoff-stage', kind: 'handoff-stage', status: 'skipped',
      output: { reason: 'no wrap run id: the handoff could not be bound to this attempt' }, blockers: []
    }] });
    assert.equal(skipped.state, 'not-staged');
    assert.equal(skipped.publicationId, null);
    assert.match(skipped.reason, /no wrap run id/);

    const stopped = sessions._unstagedHandoff({ blockedAt: 'commit', results: [
      { stepId: 'commit', kind: 'commit', status: 'blocked', output: null, blockers: ['x'] },
      { stepId: 'handoff-stage', kind: 'handoff-stage', status: 'pending', output: null, blockers: [] }
    ] });
    assert.equal(stopped.reason, 'the wrap stopped before it staged a handoff');
    assert.equal(sessions._unstagedHandoff({ results: [] }).reason, 'the wrap stopped before it staged a handoff');
  });
});

describe('the handoff freezes the resume its wrap wrote (#1675)', () => {
  /**
   * A continuity-write row in the runner's shape.
   * @param {object} [over] - Output overrides
   * @param {string} [status] - Row status
   * @returns {object}
   */
  const cwRow = (over = {}, status = 'done') => ({
    stepId: 'continuity-write', kind: 'continuity-write', status, blockers: [],
    output: {
      written: true, currentState: 'Chunk 03 shipped.', nextAction: 'Plan chunk 04.',
      freshness: { sha: 'abc1234', branch: 'main', writtenAt: '2026-09-23', tier: 'full' }, ...over
    }
  });

  it('copies the continuity step\'s own words into the staged document', async () => {
    const step = await stageStep.run({
      project, session: { id: 9, engineId: 'claude' }, previousResults: [cwRow()], scope: {}, options: {}, wrapRunId: 'run-r'
    });
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, step.output.publicationId)).doc;
    assert.deepEqual(doc.resume, {
      currentState: 'Chunk 03 shipped.', nextAction: 'Plan chunk 04.',
      freshness: { sha: 'abc1234', branch: 'main', writtenAt: '2026-09-23', tier: 'full' }
    });
    assert.equal(doc.wrapOutcome, 'complete');
  });

  it('derives the top-level next action from the resume, so the two can never disagree', async () => {
    const earlier = {
      stepId: 'memory-update', kind: 'ai-content', status: 'done', blockers: [],
      output: { parsedFields: { nextSteps: 'an earlier capture the index did not use' } }
    };
    const step = await stageStep.run({
      project, session: { id: 12, engineId: 'claude' }, previousResults: [earlier, cwRow()], scope: {}, options: {}, wrapRunId: 'run-canon'
    });
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, step.output.publicationId)).doc;
    assert.equal(doc.nextAction, 'Plan chunk 04.');
    assert.equal(doc.resume.nextAction, 'Plan chunk 04.');
  });

  it('a continuity step that did not write degrades the handoff and records no resume', async () => {
    for (const [i, row] of [cwRow({ written: false, error: 'EACCES' }), cwRow({}, 'skipped')].entries()) {
      const step = await stageStep.run({
        project, session: { id: 30 + i, engineId: 'claude' }, previousResults: [row], scope: {}, options: {}, wrapRunId: `run-w${i}`
      });
      const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, step.output.publicationId)).doc;
      assert.equal(doc.resume, null, `case ${i}`);
      assert.equal(doc.wrapOutcome, 'degraded', `case ${i}: an index nobody wrote is not a complete handoff`);
      assert.ok(doc.missingEvidence.includes('continuity-write: index not written'), `case ${i}: ${doc.missingEvidence}`);
    }
  });

  it('names the failure once, not twice, when the step also failed outright', async () => {
    const step = await stageStep.run({
      project, session: { id: 40, engineId: 'claude' }, previousResults: [cwRow({ written: false }, 'blocked')],
      scope: {}, options: {}, wrapRunId: 'run-once'
    });
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, step.output.publicationId)).doc;
    assert.equal(doc.missingEvidence.filter((m) => m.startsWith('continuity-write:')).length, 1);
  });
});
