'use strict';

/**
 * Finalizing a handoff attempt, and the `handoff-stage` step (Train 21, #1585).
 *
 * These cover the plan's §2.6 rows where the DB and the files have to agree:
 * a mismatched file is never published, an older attempt never overwrites a
 * newer one, and a replayed finalize is a no-op success.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');
const lockfile = require('../lib/handoff-lockfile.js');
const { publishHandoff, abandonHandoff } = require('../lib/handoff-publish.js');
const stageStep = require('../lib/wrap-steps/handoff-stage.js');
const { buildHandoffDocument, newPublicationId } = require('../lib/handoff-publication.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-pub-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-root-'));
  tmpDirs.push(root);
  project = store.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, path: root, engine: 'claude' });
});

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Stage an attempt on disk and in the DB, and optionally bind it.
 * @param {object} [opts] - `{sessionId, wrapRunId, kind, bind}`
 * @returns {string} The publication id
 */
function stageAttempt({ sessionId = 1, wrapRunId = 'run-1', kind = 'final', bind = true } = {}) {
  const publicationId = newPublicationId();
  const doc = buildHandoffDocument({
    publicationId, projectId: project.id, workspaceId: null, sessionId,
    wrapRunId, engineId: 'claude', kind, stagedAt: new Date().toISOString(),
    worktree: null, rules: [], globalRulesHash: null, engineConfigHash: null,
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

describe('publishing a handoff (#1585)', () => {
  it('makes an eligible attempt current', () => {
    const pid = stageAttempt();
    const res = publishHandoff(project, pid);
    assert.equal(res.published, true);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).doc.publicationId, pid);
    assert.equal(store.handoffs.get(pid).state, 'published');
  });

  it('REFUSES an attempt that never became eligible', () => {
    const pid = stageAttempt({ bind: false });
    const res = publishHandoff(project, pid);
    assert.equal(res.published, false);
    assert.match(res.reason, /not eligible/);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).outcome, 'absent');
  });

  it('REFUSES a staged file whose digest does not match the record — a mismatched file is never published', () => {
    const pid = stageAttempt();
    fs.writeFileSync(lockfile.stagedPath(project, pid), '{"schema":"tc.handoff/1","publicationId":"x","kind":"final"}\n', 'utf8');
    const res = publishHandoff(project, pid);
    assert.equal(res.published, false);
    assert.match(res.reason, /digest does not match/);
  });

  it('REFUSES when the staged file is gone rather than recording a publication with no bytes', () => {
    const pid = stageAttempt();
    fs.rmSync(lockfile.stagedPath(project, pid));
    const res = publishHandoff(project, pid);
    assert.equal(res.published, false);
    assert.match(res.reason, /absent/);
  });

  it('replays as a no-op SUCCESS, which is what makes a lost finalize response safe to retry', () => {
    const pid = stageAttempt();
    assert.equal(publishHandoff(project, pid).published, true);
    const replay = publishHandoff(project, pid);
    assert.equal(replay.published, true);
    assert.equal(replay.reason, 'already published');
  });

  it('retires the previous publication and keeps its bytes', () => {
    const first = stageAttempt({ sessionId: 1, wrapRunId: 'run-1' });
    publishHandoff(project, first);
    const second = stageAttempt({ sessionId: 2, wrapRunId: 'run-2' });
    const res = publishHandoff(project, second);

    assert.equal(res.supersededId, first);
    assert.equal(store.handoffs.get(first).state, 'superseded');
    assert.equal(fs.existsSync(lockfile.historyPath(project, first)), true);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).doc.publicationId, second);
  });

  it('never lets an OLDER attempt overwrite a newer published one; it supersedes instead', () => {
    const older = stageAttempt({ sessionId: 1, wrapRunId: 'run-old' });
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-new' });
    publishHandoff(project, newer);

    const res = publishHandoff(project, older);
    assert.equal(res.published, false);
    assert.match(res.reason, /newer publication/);
    assert.equal(lockfile.readHandoffFile(lockfile.currentPath(project)).doc.publicationId, newer,
      'current.json must still be the newer attempt');

    const row = store.handoffs.get(older);
    assert.equal(row.state, 'superseded');
    assert.ok(row.eligibleAt, 'it completed, so the record keeps saying so');
  });

  it('refuses an abandoned attempt', () => {
    const pid = stageAttempt({ bind: false });
    abandonHandoff(pid, 'lost-to-kill');
    const res = publishHandoff(project, pid);
    assert.equal(res.published, false);
    assert.match(res.reason, /abandoned/);
  });

  it('refuses an unknown publication without throwing', () => {
    assert.equal(publishHandoff(project, 'no-such-thing').published, false);
  });
});

describe('the handoff-stage wrap step', () => {
  /**
   * A runner context for the step.
   * @param {object} [over] - Overrides
   * @returns {object} Context
   */
  function ctx(over = {}) {
    return {
      project,
      session: { id: 7, engineId: 'claude' },
      previousResults: [],
      scope: {},
      options: {},
      wrapRunId: 'run-step',
      ...over
    };
  }

  it('stages bytes and a row, and hands back the publication id', async () => {
    const res = await stageStep.run(ctx());
    assert.equal(res.ok, true);
    assert.equal(res.status, 'done');
    const pid = res.output.publicationId;
    assert.equal(store.handoffs.get(pid).state, 'staged');
    assert.equal(lockfile.readHandoffFile(lockfile.stagedPath(project, pid)).outcome, 'ok');
  });

  it('records a kept session\'s attempt as a checkpoint', async () => {
    const res = await stageStep.run(ctx({ options: { keepSessionRunning: true } }));
    assert.equal(res.output.kind, 'checkpoint');
  });

  it('SKIPS honestly when it has no run id to bind the attempt to', async () => {
    const res = await stageStep.run(ctx({ wrapRunId: null }));
    assert.equal(res.ok, true);
    assert.equal(res.status, 'skipped');
    assert.match(res.output.reason, /no wrap run id/);
    assert.equal(store.handoffs.listByProject(project.id).length, 0);
  });

  it('writes NOTHING on a replay within one run — no orphan staged file', async () => {
    const first = await stageStep.run(ctx());
    const before = fs.readdirSync(lockfile.handoffDir(project)).filter((n) => n.startsWith('staged-'));

    const replay = await stageStep.run(ctx());
    const afterFiles = fs.readdirSync(lockfile.handoffDir(project)).filter((n) => n.startsWith('staged-'));

    assert.equal(replay.output.replayed, true);
    assert.equal(replay.output.publicationId, first.output.publicationId);
    assert.deepEqual(afterFiles, before,
      'a second mint would leave a staged file no row references, which reads as an unfinished publish');
    assert.equal(store.handoffs.listByProject(project.id).length, 1);
  });

  it('skips when there is no session to hand off from', async () => {
    const res = await stageStep.run(ctx({ session: null }));
    assert.equal(res.status, 'skipped');
  });

  // The rows below carry EXACTLY the runner's recorded shape — `{stepId, kind,
  // status, output, blockers}` and no `ok`. An earlier version of these tests
  // added an `ok` field the runner never writes, which made a filter on
  // `r.ok !== true` pass here while marking every successful step as missing
  // evidence in production.
  it('names the steps that fell short, reading the runner\'s real row shape', async () => {
    const res = await stageStep.run(ctx({
      previousResults: [
        { stepId: 'test', kind: 'test', status: 'blocked', output: null, blockers: ['2 failed'] },
        { stepId: 'lint', kind: 'lint', status: 'done', output: null, blockers: [] },
        { stepId: 'commit', kind: 'commit', status: 'needs-operator', output: null, blockers: [] }
      ]
    }));
    assert.equal(res.output.wrapOutcome, 'degraded');
    assert.deepEqual(res.output.missingEvidence, ['test: blocked', 'commit: needs-operator']);
  });

  it('reports a clean wrap as COMPLETE — reachable only because it reads status, not a field the runner never writes', async () => {
    const res = await stageStep.run(ctx({
      previousResults: [
        { stepId: 'lint', kind: 'lint', status: 'done', output: null, blockers: [] },
        { stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'abc123' }, blockers: [] },
        { stepId: 'pr-check', kind: 'pr-check', status: 'skipped', output: null, blockers: [] }
      ]
    }));
    assert.equal(res.output.wrapOutcome, 'complete',
      'a step that correctly did not apply withheld no evidence');
    assert.deepEqual(res.output.missingEvidence, []);
  });

  it('reads the next steps from the capture field the ai-content step actually declares', async () => {
    const res = await stageStep.run(ctx({
      previousResults: [{
        stepId: 'memory-update', kind: 'ai-content', status: 'done', blockers: [],
        output: { parsedFields: { nextSteps: '- ship chunk 03', summary: 's' } }
      }]
    }));
    const pid = res.output.publicationId;
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, pid)).doc;
    assert.equal(doc.nextAction, '- ship chunk 03');
  });

  it('records the wrap commit as the handoff\'s head sha when the work tree is a repo', async () => {
    const res = await stageStep.run(ctx({
      scope: {
        workTree: '/abs/work', workToplevel: '/abs/work', workGitDir: '/abs/work/.git',
        worktreeTarget: false, trunk: { branch: 'main' }, baseline: null
      },
      previousResults: [{ stepId: 'commit', kind: 'commit', status: 'done', blockers: [], output: { commitSha: 'cafe1234' } }]
    }));
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, res.output.publicationId)).doc;
    assert.equal(doc.worktree.headSha, 'cafe1234');
    assert.equal(doc.worktree.branch, 'main');
    assert.equal(doc.worktree.gitDir, '/abs/work/.git',
      'gitDir is a path; worktreeTarget is a boolean and was never one');
  });

  it('records worktree null ONLY for a root with no git identity, never as a stand-in for an unread key', async () => {
    const res = await stageStep.run(ctx({ scope: { workTree: '/abs', workToplevel: null } }));
    const doc = lockfile.readHandoffFile(lockfile.stagedPath(project, res.output.publicationId)).doc;
    assert.equal(doc.worktree, null);
  });

  it('returns a status from the runner\'s declared vocabulary', async () => {
    const { WRAP_STEP_STATUSES } = (() => {
      const wp = require('../lib/wrap-pipeline.js');
      return { WRAP_STEP_STATUSES: wp.STEP_STATUSES || ['pending', 'running', 'done', 'blocked', 'skipped', 'needs-operator'] };
    })();
    for (const context of [ctx(), ctx({ wrapRunId: null }), ctx({ session: null })]) {
      const res = await stageStep.run(context);
      assert.ok(WRAP_STEP_STATUSES.includes(res.status), `status ${res.status} is not in the declared vocabulary`);
    }
  });
});
