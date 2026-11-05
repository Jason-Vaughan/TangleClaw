'use strict';

// #2836 (#1889 Slice 2): the chunk-boundary HTTP controller handlers
// (`lib/chunk-boundary-http.js`) and the dashboard status surface
// (`lib/chunk-boundary-ui.js`). Same fixture shape as
// `test/chunk-boundary.test.js` (Slice 1): a fresh temp store per test,
// real rows, no mocks -- this file's job is to prove the handlers forward
// to the real Slice 1 functions correctly and attach the right status
// surface, not to re-prove the state machine itself.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const cb = require('../lib/chunk-boundary');
const cbHttp = require('../lib/chunk-boundary-http');
const cbUi = require('../lib/chunk-boundary-ui');

let tmpDir = null;
let project = null;

/** @see test/chunk-boundary.test.js#validInput */
function validInput(overrides = {}) {
  return {
    projectId: project.id,
    train: 'v5.64.0',
    lane: 'TC-Lane-D',
    planRef: '.tangleclaw/plans/v5640-sprint-charter.md#car-64-c',
    builder: 'TC-Lane-D',
    assignmentId: 'asg-1',
    chunkNumber: 1,
    commitSha: 'a'.repeat(40),
    verificationReceipt: { suite: 'testament-small', passed: 100 },
    planCheckpoint: { step: 1 },
    reflectionComplete: true,
    childAccountingComplete: true,
    builderAcknowledged: true,
    ...overrides
  };
}

/** @see test/chunk-boundary.test.js#readyAfterClearReceipt */
function readyAfterClearReceipt(overrides = {}) {
  const created = cb.createChunkBoundaryReceipt(validInput(overrides));
  const id = created.receipt.receiptId;
  cb.markReadyToClear(id);
  cb.recordClearIntent(id, { targetSessionId: 1 });
  cb.recordClearOutcome(id, { outcome: 'success' });
  cb.acknowledgeReadyAfterClear(id);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chunk-boundary-http-'));
  store._setBasePath(tmpDir);
  store.init();
  const projDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projDir);
  project = store.projects.create({ name: 'cbh-proj', path: projDir, engine: 'codex' });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleCreateReceipt', () => {
  it('creates a receipt and attaches its status surface', () => {
    const r = cbHttp.handleCreateReceipt(validInput());
    assert.equal(r.ok, true);
    assert.equal(r.receipt.state, cb.STATES.PREPARE_CLEAR);
    assert.deepEqual(r.statusSurface, cbUi.receiptStatusSurface(r.receipt));
  });

  it('forwards a refusal from the real function verbatim, plus a "none" status surface', () => {
    const r = cbHttp.handleCreateReceipt(validInput({ builderAcknowledged: false }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_NOT_ACKNOWLEDGED');
    assert.equal(r.statusSurface.status, 'none');
  });
});

describe('handleGetReceipt', () => {
  it('reads a real receipt by id', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const r = cbHttp.handleGetReceipt(created.receipt.receiptId);
    assert.equal(r.ok, true);
    assert.equal(r.receipt.receiptId, created.receipt.receiptId);
    assert.equal(r.statusSurface.status, cb.STATES.PREPARE_CLEAR);
  });

  it('answers NOT_FOUND for an unknown id, with a "none" status surface', () => {
    const r = cbHttp.handleGetReceipt('no-such-receipt');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
    assert.equal(r.statusSurface.status, 'none');
  });
});

describe('handleGetReceiptForChunk', () => {
  it('reads the receipt on record for a (project, assignment, chunk) triple', () => {
    cbHttp.handleCreateReceipt(validInput());
    const r = cbHttp.handleGetReceiptForChunk(project.id, 'asg-1', 1);
    assert.equal(r.ok, true);
    assert.equal(r.receipt.chunkNumber, 1);
  });

  it('answers ok:true with a null receipt and "none" surface when nothing exists yet', () => {
    const r = cbHttp.handleGetReceiptForChunk(project.id, 'asg-none', 1);
    assert.equal(r.ok, true);
    assert.equal(r.receipt, null);
    assert.equal(r.statusSurface.status, 'none');
  });
});

describe('the transition handlers drive the real state machine', () => {
  it('handleMarkReadyToClear -> handleRecordClearIntent -> handleRecordClearOutcome -> handleAcknowledgeReadyAfterClear reaches ready_after_clear', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const id = created.receipt.receiptId;

    const r1 = cbHttp.handleMarkReadyToClear(id);
    assert.equal(r1.ok, true);
    assert.equal(r1.receipt.state, cb.STATES.READY_TO_CLEAR);
    assert.equal(r1.statusSurface.tone, 'info');

    const r2 = cbHttp.handleRecordClearIntent(id, { targetSessionId: 7 });
    assert.equal(r2.ok, true);
    assert.equal(r2.receipt.state, cb.STATES.CLEAR_INTENT_SENT);

    const r3 = cbHttp.handleRecordClearOutcome(id, { outcome: 'success' });
    assert.equal(r3.ok, true);

    const r4 = cbHttp.handleAcknowledgeReadyAfterClear(id);
    assert.equal(r4.ok, true);
    assert.equal(r4.receipt.state, cb.STATES.READY_AFTER_CLEAR);
    assert.equal(r4.statusSurface.tone, 'good');
    assert.equal(r4.statusSurface.label, 'Ready after clear');
  });

  it('handleAcknowledgeReadyAfterClear defaults a missing body, same as the real function', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const id = created.receipt.receiptId;
    cbHttp.handleMarkReadyToClear(id);
    cbHttp.handleRecordClearIntent(id, { targetSessionId: 1 });
    cbHttp.handleRecordClearOutcome(id, { outcome: 'success' });
    assert.doesNotThrow(() => cbHttp.handleAcknowledgeReadyAfterClear(id, undefined));
  });

  it('handleRecordClearOutcome forwards an "uncertain" HOLD, never auto-retried', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const id = created.receipt.receiptId;
    cbHttp.handleMarkReadyToClear(id);
    cbHttp.handleRecordClearIntent(id, { targetSessionId: 1 });
    const r = cbHttp.handleRecordClearOutcome(id, { outcome: 'uncertain' });
    assert.equal(r.ok, true);
    assert.equal(r.receipt.state, cb.STATES.CLEAR_INTENT_SENT, 'an uncertain outcome never auto-advances');
    assert.equal(r.receipt.clearOutcome, 'uncertain');
  });

  it('handleSupersede marks a receipt superseded, with a "hold" status surface', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const r = cbHttp.handleSupersede(created.receipt.receiptId, { reason: 'test: re-dispatched' });
    assert.equal(r.ok, true);
    assert.equal(r.receipt.supersededAt !== null, true);
    assert.equal(r.statusSurface.status, 'superseded');
    assert.equal(r.statusSurface.tone, 'hold');
  });

  it('handleSupersede forwards the real refusal for a missing reason', () => {
    const created = cbHttp.handleCreateReceipt(validInput());
    const r = cbHttp.handleSupersede(created.receipt.receiptId, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_REASON_REQUIRED');
  });
});

describe('handleValidateNextChunkDispatch', () => {
  const CANDIDATE = { projectId: 0, train: 'v5.64.0', lane: 'TC-Lane-D', builder: 'TC-Lane-D', assignmentId: 'asg-1', nextChunkNumber: 2 };

  it('admits Chunk N+1 once Chunk N reached ready_after_clear, with an "admitted" admission surface', () => {
    readyAfterClearReceipt();
    const r = cbHttp.handleValidateNextChunkDispatch({ ...CANDIDATE, projectId: project.id });
    assert.equal(r.ok, true);
    assert.equal(r.admission.admitted, true);
    assert.equal(r.admission.status, 'admitted');
    assert.equal(r.admission.tone, 'good');
  });

  it('holds with a typed reason and matching admission surface when no prior receipt exists', () => {
    const r = cbHttp.handleValidateNextChunkDispatch({ ...CANDIDATE, projectId: project.id });
    assert.equal(r.ok, false);
    assert.equal(r.hold, true);
    assert.equal(r.reason, cb.HOLD_REASONS.MISSING_PRIOR_RECEIPT);
    assert.equal(r.admission.admitted, false);
    assert.equal(r.admission.status, cb.HOLD_REASONS.MISSING_PRIOR_RECEIPT);
    assert.equal(r.admission.label, cb.HOLD_MEANINGS[cb.HOLD_REASONS.MISSING_PRIOR_RECEIPT]);
  });

  it('holds boundary-incomplete when the prior receipt has not reached ready_after_clear', () => {
    cbHttp.handleCreateReceipt(validInput());
    const r = cbHttp.handleValidateNextChunkDispatch({ ...CANDIDATE, projectId: project.id });
    assert.equal(r.ok, false);
    assert.equal(r.reason, cb.HOLD_REASONS.BOUNDARY_INCOMPLETE);
    assert.equal(r.admission.status, cb.HOLD_REASONS.BOUNDARY_INCOMPLETE);
  });

  it('holds lane-mismatch, with the mismatching receipt still attached to the surface', () => {
    readyAfterClearReceipt();
    const r = cbHttp.handleValidateNextChunkDispatch({ ...CANDIDATE, projectId: project.id, lane: 'TC-Lane-B' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, cb.HOLD_REASONS.LANE_MISMATCH);
    assert.equal(r.admission.receipt.chunkNumber, 1);
  });
});
