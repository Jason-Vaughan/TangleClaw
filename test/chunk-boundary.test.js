'use strict';

// #1889 (v5.58.0 Wave 1 Car 58-C, Slice 1): durable chunk-boundary receipts
// and the next-dispatch admission gate, via `lib/chunk-boundary.js`. A fresh
// temp store per test -- real `chunk_boundary_receipts`/`chunk_boundary_events`
// rows, no mocks, mirroring `test/decision-routing.test.js`'s own harness.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const cb = require('../lib/chunk-boundary');

let tmpDir = null;
let project = null;

/** A minimal, fully-valid creation input; override per test. */
function validInput(overrides = {}) {
  return {
    projectId: project.id,
    train: 'v5.58.0',
    lane: 'TC-Lane-D',
    planRef: '.tangleclaw/plans/v5580-sprint-charter.md#car-58-c',
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

/** Drive a fresh receipt all the way to `ready_after_clear`, returning its id. */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chunk-boundary-'));
  store._setBasePath(tmpDir);
  store.init();
  const projDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projDir);
  project = store.projects.create({ name: 'proj', path: projDir, engine: 'codex' });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createChunkBoundaryReceipt — the one creation path, and what it refuses', () => {
  it('creates in prepare_clear with every field recorded', () => {
    const r = cb.createChunkBoundaryReceipt(validInput());
    assert.equal(r.ok, true);
    assert.equal(r.receipt.state, cb.STATES.PREPARE_CLEAR);
    assert.equal(r.receipt.builderAcknowledged, true);
    assert.equal(r.receipt.reflectionComplete, true);
    assert.equal(r.receipt.childAccountingComplete, true);
    assert.deepEqual(r.receipt.verificationReceipt, { suite: 'testament-small', passed: 100 });
    assert.deepEqual(r.receipt.planCheckpoint, { step: 1 });
    assert.equal(r.receipt.clearAttempts, 0);
    assert.equal(r.receipt.supersededAt, null);
  });

  it('replays idempotently on the same (project, assignment, chunk) triple', () => {
    const first = cb.createChunkBoundaryReceipt(validInput());
    const second = cb.createChunkBoundaryReceipt(validInput());
    assert.equal(second.replay, true);
    assert.equal(second.receipt.receiptId, first.receipt.receiptId);
  });

  it('a different chunk number for the same assignment creates a second receipt', () => {
    const first = cb.createChunkBoundaryReceipt(validInput({ chunkNumber: 1 }));
    const second = cb.createChunkBoundaryReceipt(validInput({ chunkNumber: 2 }));
    assert.notEqual(first.receipt.receiptId, second.receipt.receiptId);
  });

  for (const field of ['projectId', 'train', 'lane', 'planRef', 'builder', 'assignmentId', 'commitSha', 'verificationReceipt', 'planCheckpoint']) {
    it(`refuses creation when "${field}" is missing`, () => {
      const r = cb.createChunkBoundaryReceipt(validInput({ [field]: undefined }));
      assert.equal(r.ok, false);
      assert.match(r.code, /REQUIRED/);
    });
  }

  it('refuses a chunkNumber below 1', () => {
    const r = cb.createChunkBoundaryReceipt(validInput({ chunkNumber: 0 }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_CHUNK_NUMBER_INVALID');
  });

  it('refuses a commitSha that is not exactly 40 hex characters', () => {
    const r = cb.createChunkBoundaryReceipt(validInput({ commitSha: 'deadbeef' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_COMMIT_INVALID');
  });

  it('never creates a row when reflectionComplete is not exactly true (incomplete evidence)', () => {
    for (const bad of [false, 'yes', 1, null]) {
      const r = cb.createChunkBoundaryReceipt(validInput({ reflectionComplete: bad }));
      assert.equal(r.ok, false, `reflectionComplete=${JSON.stringify(bad)} must be refused`);
      assert.equal(r.code, 'CHUNK_BOUNDARY_REFLECTION_INCOMPLETE');
    }
    assert.equal(cb.getReceiptForChunk(project.id, 'asg-1', 1), null, 'no partial row was ever written');
  });

  it('never creates a row when childAccountingComplete is not exactly true', () => {
    const r = cb.createChunkBoundaryReceipt(validInput({ childAccountingComplete: false }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_CHILD_ACCOUNTING_INCOMPLETE');
    assert.equal(cb.getReceiptForChunk(project.id, 'asg-1', 1), null);
  });

  it('the compaction non-completion invariant: a PM assertion alone (builderAcknowledged not exactly true) never creates a valid receipt', () => {
    for (const bad of [false, undefined, null, 'true', 1]) {
      const r = cb.createChunkBoundaryReceipt(validInput({ builderAcknowledged: bad }));
      assert.equal(r.ok, false, `builderAcknowledged=${JSON.stringify(bad)} must be refused`);
      assert.equal(r.code, 'CHUNK_BOUNDARY_NOT_ACKNOWLEDGED');
    }
    assert.equal(cb.getReceiptForChunk(project.id, 'asg-1', 1), null, 'no row was ever written without acknowledgment');
  });
});

describe('the clear-boundary state machine — PREPARE_CLEAR -> READY_TO_CLEAR -> CLEAR_INTENT_SENT -> READY_AFTER_CLEAR', () => {
  it('walks the full happy path', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;

    const r1 = cb.markReadyToClear(id);
    assert.equal(r1.ok, true);
    assert.equal(r1.receipt.state, cb.STATES.READY_TO_CLEAR);

    const r2 = cb.recordClearIntent(id, { targetSessionId: 7 });
    assert.equal(r2.ok, true);
    assert.equal(r2.receipt.state, cb.STATES.CLEAR_INTENT_SENT);
    assert.equal(r2.receipt.clearAttempts, 1);
    assert.equal(r2.receipt.clearTargetSessionId, 7);
    assert.ok(r2.receipt.clearIntentSentAt);

    const r3 = cb.recordClearOutcome(id, { outcome: 'success' });
    assert.equal(r3.ok, true);
    assert.equal(r3.receipt.state, cb.STATES.CLEAR_INTENT_SENT, 'outcome recording does not itself advance state');
    assert.equal(r3.receipt.clearOutcome, 'success');

    const r4 = cb.acknowledgeReadyAfterClear(id, { sessionGeneration: 'gen-abc' });
    assert.equal(r4.ok, true);
    assert.equal(r4.receipt.state, cb.STATES.READY_AFTER_CLEAR);
    assert.equal(r4.receipt.sessionGeneration, 'gen-abc');
    assert.ok(r4.receipt.readyAfterClearAt);
  });

  it('rejects skipping a state: recordClearIntent directly from prepare_clear', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const r = cb.recordClearIntent(created.receipt.receiptId, { targetSessionId: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_TRANSITION_INVALID');
  });

  it('rejects markReadyToClear a second time (already past prepare_clear)', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    const r = cb.markReadyToClear(id);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_TRANSITION_INVALID');
  });

  it('rejects acknowledging re-entry before any clear outcome was ever recorded', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    cb.recordClearIntent(id, { targetSessionId: 1 });
    const r = cb.acknowledgeReadyAfterClear(id);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_OUTCOME_NOT_SUCCESSFUL');
  });

  it('an "uncertain" or "failed" outcome is a visible HOLD, never auto-retried, and does not advance the state', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    cb.recordClearIntent(id, { targetSessionId: 1 });
    const outcome = cb.recordClearOutcome(id, { outcome: 'uncertain', detail: 'pane read timed out' });
    assert.equal(outcome.receipt.state, cb.STATES.CLEAR_INTENT_SENT);
    const ack = cb.acknowledgeReadyAfterClear(id);
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'CHUNK_BOUNDARY_OUTCOME_NOT_SUCCESSFUL');
    // Nothing here moved it forward on its own -- confirmed by reading it fresh.
    assert.equal(cb.getChunkBoundaryReceipt(id).state, cb.STATES.CLEAR_INTENT_SENT);
  });

  it('a fresh recordClearIntent after "uncertain" is an explicit new attempt, counted', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    cb.recordClearIntent(id, { targetSessionId: 1 });
    cb.recordClearOutcome(id, { outcome: 'uncertain' });
    const retry = cb.recordClearIntent(id, { targetSessionId: 1 });
    assert.equal(retry.ok, true);
    assert.equal(retry.receipt.clearAttempts, 2);
    assert.equal(retry.receipt.clearOutcome, null, 'the stale outcome is cleared by the new attempt');
  });

  it('recordClearOutcome refuses an unrecognized outcome value', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    cb.recordClearIntent(id, { targetSessionId: 1 });
    const r = cb.recordClearOutcome(id, { outcome: 'maybe' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_OUTCOME_INVALID');
  });

  it('recordClearOutcome refuses outside clear_intent_sent', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const r = cb.recordClearOutcome(created.receipt.receiptId, { outcome: 'success' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_TRANSITION_INVALID');
  });

  it('every transition function refuses an unknown receipt id', () => {
    assert.equal(cb.markReadyToClear('cbr_missing').code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
    assert.equal(cb.recordClearIntent('cbr_missing', { targetSessionId: 1 }).code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
    assert.equal(cb.recordClearOutcome('cbr_missing', { outcome: 'success' }).code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
    assert.equal(cb.acknowledgeReadyAfterClear('cbr_missing').code, 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND');
  });
});

describe('supersedeChunkBoundaryReceipt — the non-answer closure', () => {
  it('supersedes and blocks every further transition', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    const sup = cb.supersedeChunkBoundaryReceipt(id, { reason: 'duplicate dispatch, chunk re-planned' });
    assert.equal(sup.ok, true);
    assert.ok(sup.receipt.supersededAt);
    assert.equal(sup.receipt.supersededReason, 'duplicate dispatch, chunk re-planned');

    assert.equal(cb.markReadyToClear(id).code, 'CHUNK_BOUNDARY_SUPERSEDED');
  });

  it('replays idempotently once already superseded', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    const first = cb.supersedeChunkBoundaryReceipt(id, { reason: 'first reason' });
    const second = cb.supersedeChunkBoundaryReceipt(id, { reason: 'a different later reason' });
    assert.equal(second.replay, true);
    assert.equal(second.receipt.supersededReason, first.receipt.supersededReason, 'the original reason is kept, not overwritten by the replay');
  });

  it('refuses an empty reason', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const r = cb.supersedeChunkBoundaryReceipt(created.receipt.receiptId, { reason: '' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHUNK_BOUNDARY_REASON_REQUIRED');
  });
});

describe('validateNextChunkDispatch — the admission gate', () => {
  const dispatchFor = (overrides = {}) => ({
    projectId: project.id, train: 'v5.58.0', lane: 'TC-Lane-D', builder: 'TC-Lane-D',
    assignmentId: 'asg-1', nextChunkNumber: 2, ...overrides
  });

  it('HOLDs missing-prior-receipt when no receipt exists at all for the assignment', () => {
    const r = cb.validateNextChunkDispatch(dispatchFor());
    assert.equal(r.ok, false);
    assert.equal(r.hold, true);
    assert.equal(r.reason, cb.HOLD_REASONS.MISSING_PRIOR_RECEIPT);
    assert.equal(r.receipt, null);
  });

  it('HOLDs missing-prior-receipt for nextChunkNumber=1 (there is no chunk 0)', () => {
    const r = cb.validateNextChunkDispatch(dispatchFor({ nextChunkNumber: 1 }));
    assert.equal(r.reason, cb.HOLD_REASONS.MISSING_PRIOR_RECEIPT);
  });

  it('HOLDs boundary-incomplete while the prior receipt has not reached ready_after_clear', () => {
    cb.createChunkBoundaryReceipt(validInput({ chunkNumber: 1 }));
    const r = cb.validateNextChunkDispatch(dispatchFor());
    assert.equal(r.reason, cb.HOLD_REASONS.BOUNDARY_INCOMPLETE);
    assert.ok(r.receipt, 'the incomplete receipt is still handed back, for diagnosis');
  });

  it('admits once the prior receipt is ready_after_clear', () => {
    readyAfterClearReceipt({ chunkNumber: 1 });
    const r = cb.validateNextChunkDispatch(dispatchFor());
    assert.equal(r.ok, true);
    assert.equal(r.receipt.chunkNumber, 1);
  });

  it('is idempotent across repeated calls with the same inputs', () => {
    readyAfterClearReceipt({ chunkNumber: 1 });
    const first = cb.validateNextChunkDispatch(dispatchFor());
    const second = cb.validateNextChunkDispatch(dispatchFor());
    assert.deepEqual(first, second);
  });

  it('HOLDs commit-mismatch when expectedPriorCommit disagrees with the receipt', () => {
    readyAfterClearReceipt({ chunkNumber: 1, commitSha: 'a'.repeat(40) });
    const r = cb.validateNextChunkDispatch(dispatchFor({ expectedPriorCommit: 'b'.repeat(40) }));
    assert.equal(r.reason, cb.HOLD_REASONS.COMMIT_MISMATCH);
  });

  it('admits when expectedPriorCommit matches, case-insensitively', () => {
    readyAfterClearReceipt({ chunkNumber: 1, commitSha: 'a'.repeat(40) });
    const r = cb.validateNextChunkDispatch(dispatchFor({ expectedPriorCommit: 'A'.repeat(40) }));
    assert.equal(r.ok, true);
  });

  it('HOLDs lane-mismatch when train/lane/builder disagrees with the receipt', () => {
    readyAfterClearReceipt({ chunkNumber: 1 });
    assert.equal(cb.validateNextChunkDispatch(dispatchFor({ lane: 'TC-Lane-WRONG' })).reason, cb.HOLD_REASONS.LANE_MISMATCH);
    assert.equal(cb.validateNextChunkDispatch(dispatchFor({ builder: 'TC-Lane-WRONG' })).reason, cb.HOLD_REASONS.LANE_MISMATCH);
    assert.equal(cb.validateNextChunkDispatch(dispatchFor({ train: 'v9.9.9' })).reason, cb.HOLD_REASONS.LANE_MISMATCH);
  });

  it('HOLDs receipt-stale once the receipt is older than maxAgeMs', () => {
    readyAfterClearReceipt({ chunkNumber: 1 });
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const r = cb.validateNextChunkDispatch(dispatchFor(), { maxAgeMs: 1000, now: farFuture });
    assert.equal(r.reason, cb.HOLD_REASONS.RECEIPT_STALE);
  });

  it('HOLDs receipt-superseded once the prior receipt was superseded', () => {
    const id = readyAfterClearReceipt({ chunkNumber: 1 });
    cb.supersedeChunkBoundaryReceipt(id, { reason: 're-planned' });
    const r = cb.validateNextChunkDispatch(dispatchFor());
    assert.equal(r.reason, cb.HOLD_REASONS.RECEIPT_SUPERSEDED);
  });

  it('every HOLD_REASONS code has a meaning in HOLD_MEANINGS', () => {
    for (const code of Object.values(cb.HOLD_REASONS)) {
      assert.ok(cb.HOLD_MEANINGS[code], `HOLD_MEANINGS is missing an entry for "${code}"`);
    }
  });
});

describe('roleProjectionLines / protocolDigest — the versioned role projection', () => {
  it('both formats carry the same version and digest', () => {
    const md = cb.roleProjectionLines('md');
    const comment = cb.roleProjectionLines('comment');
    assert.match(md[0], new RegExp(`v${cb.PROTOCOL_VERSION.replace(/\./g, '\\.')}`));
    assert.ok(md.some((l) => l.includes(cb.protocolDigest())), 'md carries the digest');
    assert.ok(comment.some((l) => l.includes(cb.protocolDigest())), 'comment carries the same digest');
  });

  it('the digest is stable across calls and does not recurse', () => {
    assert.equal(cb.protocolDigest(), cb.protocolDigest());
    assert.equal(cb.protocolDigest().length, 12);
  });

  it('covers both the Project Manager and the Builder in one block (no first-class role field exists yet)', () => {
    const text = cb.roleProjectionLines('md').join('\n');
    assert.match(text, /Project Manager/);
    assert.match(text, /Builder/);
  });

  it('DEFAULT_MAX_RECEIPT_AGE_MS is the default validateNextChunkDispatch actually uses', () => {
    assert.equal(cb.DEFAULT_MAX_RECEIPT_AGE_MS, 24 * 60 * 60 * 1000);
    readyAfterClearReceipt({ chunkNumber: 1 });
    const justInside = new Date(Date.now() + cb.DEFAULT_MAX_RECEIPT_AGE_MS - 1000).toISOString();
    const r = cb.validateNextChunkDispatch(
      { projectId: project.id, train: 'v5.58.0', lane: 'TC-Lane-D', builder: 'TC-Lane-D', assignmentId: 'asg-1', nextChunkNumber: 2 },
      { now: justInside }
    );
    assert.equal(r.ok, true, 'still fresh just inside the default bound, with no maxAgeMs override');
  });
});

describe('seams -- _internal, CLEAR_OUTCOMES, ensureChunkBoundarySchema', () => {
  it('_internal.now/_internal.id are the actual clock/id source a receipt is created with', () => {
    const realNow = cb._internal.now;
    const realId = cb._internal.id;
    cb._internal.now = () => '2026-01-01T00:00:00.000Z';
    cb._internal.id = () => 'cbr_fixed-test-id';
    try {
      const r = cb.createChunkBoundaryReceipt(validInput());
      assert.equal(r.receipt.receiptId, 'cbr_fixed-test-id');
      assert.equal(r.receipt.createdAt, '2026-01-01T00:00:00.000Z');
      assert.equal(r.receipt.updatedAt, '2026-01-01T00:00:00.000Z');
    } finally {
      cb._internal.now = realNow;
      cb._internal.id = realId;
    }
  });

  it('CLEAR_OUTCOMES is the exact set recordClearOutcome accepts', () => {
    const created = cb.createChunkBoundaryReceipt(validInput());
    const id = created.receipt.receiptId;
    cb.markReadyToClear(id);
    cb.recordClearIntent(id, { targetSessionId: 1 });
    for (const outcome of cb.CLEAR_OUTCOMES) {
      // Each is independently valid as a value, even outside its one
      // reachable state here -- the invalid-value rejection is covered
      // separately above.
      assert.ok(['success', 'uncertain', 'failed'].includes(outcome));
    }
    const r = cb.recordClearOutcome(id, { outcome: cb.CLEAR_OUTCOMES[0] });
    assert.equal(r.ok, true);
    assert.equal(r.receipt.clearOutcome, cb.CLEAR_OUTCOMES[0]);
  });

  it('ensureChunkBoundarySchema is idempotent and leaves a usable table behind', () => {
    const db = store.getDb();
    cb.ensureChunkBoundarySchema(db);
    cb.ensureChunkBoundarySchema(db); // second call, same handle: must not throw or re-run DDL oddly
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunk_boundary_receipts'").get();
    assert.ok(row, 'the table exists after ensureChunkBoundarySchema runs directly');
  });
});
