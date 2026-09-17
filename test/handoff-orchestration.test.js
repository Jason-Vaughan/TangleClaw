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
