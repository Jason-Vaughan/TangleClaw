'use strict';

/**
 * Durable chunk-boundary receipts and the next-dispatch admission gate
 * (#1889, v5.58.0 Wave 1 Car 58-C, Architect Ruling A1889 / A495-S1).
 *
 * Self-contained, same shape as `lib/decision-routing.js`/`lib/permission-requests.js`:
 * this module owns its own storage via `ensureChunkBoundarySchema`, applied
 * additively (`CREATE TABLE IF NOT EXISTS`) on `store.getDb()` — it never
 * touches `lib/store/_schema.js`.
 *
 * The problem (issue #1889's own words): a Builder is expected to complete
 * one Chunk, checkpoint it, and `/clear` before the next Chunk. Automatic
 * compaction may preserve mid-Chunk work but must never count as completion.
 * A conversational acknowledgment of that completion can be lost or bypassed
 * -- nothing durable recorded it, and nothing gated the next dispatch on it.
 *
 * This file is Slice 1 (the durable record + the admission gate + the
 * role-projection text wired into `lib/engines.js`/`lib/sessions.js`).
 * Wiring `validateNextChunkDispatch` into the HTTP session/dispatch routes
 * and the dashboard session-status surface is Slice 2, tracked in #2836 --
 * out of this file's envelope.
 *
 * ## The compaction non-completion invariant (trust boundary, named honestly)
 *
 * {@link createChunkBoundaryReceipt} refuses to create ANY row unless every
 * required field is present, including `builderAcknowledged: true`. This
 * module cannot independently verify that a human (or the Builder's own
 * session, as opposed to the PM asserting on its behalf) actually produced
 * that acknowledgment -- the same honest limit `lib/decision-routing.js`
 * documents for its own Operator-only answering. The invariant holds only as
 * long as no caller ever passes `builderAcknowledged: true` from a path an
 * automatic compaction or a bare PM assertion can reach. That is a calling
 * discipline this module's own code cannot enforce from inside itself; it is
 * enforced by never writing that caller, the same way "the operator alone
 * may answer" in decision-routing.js is enforced by there being no second
 * code path that can satisfy it.
 *
 * @module lib/chunk-boundary
 */

const crypto = require('node:crypto');
const store = require('./store');

/** The receipt's own clear-boundary state machine (Architect Ruling A1889). */
const STATES = Object.freeze({
  /** Full evidence is on record; the PM has not yet signalled intent to clear. */
  PREPARE_CLEAR: 'prepare_clear',
  /** The PM marked this chunk ready to clear; no clear-intent sent yet. */
  READY_TO_CLEAR: 'ready_to_clear',
  /** A target-bound clear-intent was sent; its injection outcome is recorded here, not auto-retried. */
  CLEAR_INTENT_SENT: 'clear_intent_sent',
  /** The Builder cleanly re-entered and acknowledged; this receipt may now admit the next Chunk's dispatch. */
  READY_AFTER_CLEAR: 'ready_after_clear'
});

/** The only forward edges this state machine allows; anything else is refused. */
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.PREPARE_CLEAR]: [STATES.READY_TO_CLEAR],
  [STATES.READY_TO_CLEAR]: [STATES.CLEAR_INTENT_SENT],
  // CLEAR_INTENT_SENT -> itself: a retried clear-intent after an 'uncertain'
  // or 'failed' outcome is a new attempt, not an automatic retry (bullet 2).
  [STATES.CLEAR_INTENT_SENT]: [STATES.CLEAR_INTENT_SENT, STATES.READY_AFTER_CLEAR],
  [STATES.READY_AFTER_CLEAR]: []
});

/** A clear-intent's injection outcome. `uncertain`/`failed` are both a visible HOLD, never auto-retried. */
const CLEAR_OUTCOMES = Object.freeze(['success', 'uncertain', 'failed']);

/** Typed reasons {@link validateNextChunkDispatch} may HOLD on. */
const HOLD_REASONS = Object.freeze({
  MISSING_PRIOR_RECEIPT: 'missing-prior-receipt',
  BOUNDARY_INCOMPLETE: 'boundary-incomplete',
  RECEIPT_STALE: 'receipt-stale',
  RECEIPT_SUPERSEDED: 'receipt-superseded',
  COMMIT_MISMATCH: 'commit-mismatch',
  LANE_MISMATCH: 'lane-mismatch'
});

/** What each HOLD reason means, keyed by its code -- the one place a reader looks up what it's told. */
const HOLD_MEANINGS = Object.freeze({
  [HOLD_REASONS.MISSING_PRIOR_RECEIPT]: 'no chunk-boundary receipt exists yet for the prior chunk in this assignment',
  [HOLD_REASONS.BOUNDARY_INCOMPLETE]: 'the prior chunk\'s receipt has not reached ready_after_clear yet',
  [HOLD_REASONS.RECEIPT_STALE]: 'the prior chunk\'s receipt is older than this gate\'s freshness bound',
  [HOLD_REASONS.RECEIPT_SUPERSEDED]: 'the prior chunk\'s receipt was superseded and no longer admits a dispatch',
  [HOLD_REASONS.COMMIT_MISMATCH]: 'the dispatch\'s expected prior commit does not match the receipt\'s own commit',
  [HOLD_REASONS.LANE_MISMATCH]: 'the dispatch\'s train/lane/builder identity does not match the receipt\'s own'
});

/** How long a `ready_after_clear` receipt stays fresh enough to admit the next dispatch, by default. */
const DEFAULT_MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `cbr_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the shape `lib/decision-routing.js` already established.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * A HOLD, in the admission gate's own typed shape.
 * @param {string} reason - One of {@link HOLD_REASONS}
 * @param {object|null} receipt - The receipt the hold concerns, if any was found
 * @returns {{ok: false, hold: true, reason: string, message: string, receipt: (object|null)}}
 */
function _hold(reason, receipt) {
  return { ok: false, hold: true, reason, message: HOLD_MEANINGS[reason] || reason, receipt: receipt || null };
}

/**
 * The DDL for both tables. Purely additive (`IF NOT EXISTS` throughout).
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS chunk_boundary_receipts (
      receipt_id          TEXT    PRIMARY KEY CHECK (length(receipt_id) BETWEEN 1 AND 64),
      project_id          INTEGER NOT NULL,
      session_id          INTEGER,
      launch_id           TEXT    CHECK (launch_id IS NULL OR length(launch_id) <= 128),
      train               TEXT    NOT NULL CHECK (length(train) BETWEEN 1 AND 64),
      lane                TEXT    NOT NULL CHECK (length(lane) BETWEEN 1 AND 100),
      plan_ref            TEXT    NOT NULL CHECK (length(plan_ref) BETWEEN 1 AND 500),
      builder             TEXT    NOT NULL CHECK (length(builder) BETWEEN 1 AND 100),
      assignment_id       TEXT    NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 128),
      chunk_number        INTEGER NOT NULL CHECK (chunk_number >= 1),
      commit_sha          TEXT    NOT NULL CHECK (length(commit_sha) = 40),
      verification_receipt_json TEXT NOT NULL CHECK (length(verification_receipt_json) BETWEEN 1 AND 8000),
      plan_checkpoint_json TEXT   NOT NULL CHECK (length(plan_checkpoint_json) BETWEEN 1 AND 8000),
      reflection_complete  INTEGER NOT NULL CHECK (reflection_complete IN (0, 1)),
      reflection_detail    TEXT   CHECK (reflection_detail IS NULL OR length(reflection_detail) <= 2000),
      child_accounting_complete INTEGER NOT NULL CHECK (child_accounting_complete IN (0, 1)),
      child_accounting_detail   TEXT CHECK (child_accounting_detail IS NULL OR length(child_accounting_detail) <= 2000),
      session_generation  TEXT   CHECK (session_generation IS NULL OR length(session_generation) <= 128),
      builder_acknowledged INTEGER NOT NULL CHECK (builder_acknowledged IN (1)),
      state                TEXT   NOT NULL DEFAULT 'prepare_clear'
                                    CHECK (state IN ('prepare_clear','ready_to_clear','clear_intent_sent','ready_after_clear')),
      clear_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (clear_attempts >= 0),
      clear_target_session_id INTEGER,
      clear_intent_sent_at TEXT,
      clear_outcome        TEXT   CHECK (clear_outcome IS NULL OR clear_outcome IN ('success','uncertain','failed')),
      clear_outcome_detail TEXT   CHECK (clear_outcome_detail IS NULL OR length(clear_outcome_detail) <= 2000),
      clear_outcome_at     TEXT,
      ready_after_clear_at TEXT,
      superseded_at        TEXT,
      superseded_reason    TEXT CHECK (superseded_reason IS NULL OR length(superseded_reason) <= 500),
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      -- A receipt is only created with every piece of required evidence present
      -- (enforced again in code, at the one creation path) -- builder_acknowledged
      -- can only ever be 1, never 0, so a row with no acknowledgment cannot exist.
      UNIQUE (project_id, assignment_id, chunk_number)
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_boundary_receipts_lookup
      ON chunk_boundary_receipts(project_id, assignment_id, chunk_number);

    CREATE TABLE IF NOT EXISTS chunk_boundary_events (
      event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id  TEXT    NOT NULL CHECK (length(receipt_id) <= 64),
      kind        TEXT    NOT NULL CHECK (kind IN (
                            'created','ready_to_clear','clear_intent_sent','clear_outcome_recorded',
                            'ready_after_clear','superseded'
                          )),
      detail      TEXT,
      recorded_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_boundary_events_receipt
      ON chunk_boundary_events(receipt_id, recorded_at);
  `;
}

/** Whether `ensureChunkBoundarySchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureChunkBoundarySchema(db) {
  if (_initialized.has(db)) return;
  db.exec(_tablesDdl());
  _initialized.add(db);
}

/**
 * The open database, with this module's schema guaranteed present.
 * @returns {object}
 * @throws {Error} When the store is not initialized
 */
function _db() {
  const db = store.getDb();
  if (!db) throw new Error('The store is not initialized.');
  ensureChunkBoundarySchema(db);
  return db;
}

/**
 * Map a raw row to the shape this module hands callers.
 * @param {object} row - Raw `chunk_boundary_receipts` row
 * @returns {object}
 */
function _rowToReceipt(row) {
  return {
    receiptId: row.receipt_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    launchId: row.launch_id,
    train: row.train,
    lane: row.lane,
    planRef: row.plan_ref,
    builder: row.builder,
    assignmentId: row.assignment_id,
    chunkNumber: row.chunk_number,
    commitSha: row.commit_sha,
    verificationReceipt: JSON.parse(row.verification_receipt_json),
    planCheckpoint: JSON.parse(row.plan_checkpoint_json),
    reflectionComplete: Boolean(row.reflection_complete),
    reflectionDetail: row.reflection_detail,
    childAccountingComplete: Boolean(row.child_accounting_complete),
    childAccountingDetail: row.child_accounting_detail,
    sessionGeneration: row.session_generation,
    builderAcknowledged: Boolean(row.builder_acknowledged),
    state: row.state,
    clearAttempts: row.clear_attempts,
    clearTargetSessionId: row.clear_target_session_id,
    clearIntentSentAt: row.clear_intent_sent_at,
    clearOutcome: row.clear_outcome,
    clearOutcomeDetail: row.clear_outcome_detail,
    clearOutcomeAt: row.clear_outcome_at,
    readyAfterClearAt: row.ready_after_clear_at,
    supersededAt: row.superseded_at,
    supersededReason: row.superseded_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Record one line of a receipt's history. Never fails closed on its own
 * account -- an event is a record of what already happened, not a gate.
 * @param {object} db - Open database handle
 * @param {string} receiptId
 * @param {string} kind - One of `chunk_boundary_events.kind`'s values
 * @param {string} [detail]
 * @returns {void}
 */
function _recordEvent(db, receiptId, kind, detail) {
  db.prepare('INSERT INTO chunk_boundary_events (receipt_id, kind, detail, recorded_at) VALUES (?, ?, ?, ?)')
    .run(receiptId, kind, detail || null, _internal.now());
}

/**
 * The live receipt row, or `null`.
 * @param {object} db
 * @param {string} receiptId
 * @returns {object|null} Raw row
 */
function _getRow(db, receiptId) {
  return db.prepare('SELECT * FROM chunk_boundary_receipts WHERE receipt_id = ?').get(receiptId);
}

/**
 * Required fields a caller must supply, and the missing-field code each one
 * answers with -- named individually so a refusal says exactly what is
 * absent, not just "incomplete evidence."
 * @type {Array<{field: string, code: string}>}
 */
const REQUIRED_FIELDS = Object.freeze([
  { field: 'projectId', code: 'CHUNK_BOUNDARY_PROJECT_REQUIRED' },
  { field: 'train', code: 'CHUNK_BOUNDARY_TRAIN_REQUIRED' },
  { field: 'lane', code: 'CHUNK_BOUNDARY_LANE_REQUIRED' },
  { field: 'planRef', code: 'CHUNK_BOUNDARY_PLAN_REF_REQUIRED' },
  { field: 'builder', code: 'CHUNK_BOUNDARY_BUILDER_REQUIRED' },
  { field: 'assignmentId', code: 'CHUNK_BOUNDARY_ASSIGNMENT_REQUIRED' },
  { field: 'chunkNumber', code: 'CHUNK_BOUNDARY_CHUNK_NUMBER_REQUIRED' },
  { field: 'commitSha', code: 'CHUNK_BOUNDARY_COMMIT_REQUIRED' },
  { field: 'verificationReceipt', code: 'CHUNK_BOUNDARY_VERIFICATION_REQUIRED' },
  { field: 'planCheckpoint', code: 'CHUNK_BOUNDARY_CHECKPOINT_REQUIRED' }
]);

/**
 * Create a durable chunk-boundary receipt for a completed Chunk, in state
 * `prepare_clear`. Refuses to create ANY row -- not a partial one -- unless
 * every required piece of evidence is present, `reflectionComplete` and
 * `childAccountingComplete` are both exactly `true`, and `builderAcknowledged`
 * is exactly `true` (see the module docstring's trust-boundary note: this is
 * attested by the caller, not independently verified here). This is the one
 * creation path, and it is idempotent: a replay with the same
 * `(projectId, assignmentId, chunkNumber)` returns the existing row rather
 * than erroring or creating a second one.
 * @param {object} input
 * @param {number} input.projectId
 * @param {number} [input.sessionId] - The Builder's own session, when known
 * @param {string} [input.launchId]
 * @param {string} input.train - e.g. `"v5.58.0"`
 * @param {string} input.lane - e.g. `"TC-Lane-D"`
 * @param {string} input.planRef - A durable plan checkpoint reference (path, URL, or id)
 * @param {string} input.builder - The Builder's own identity (may equal `lane`)
 * @param {string} input.assignmentId
 * @param {number} input.chunkNumber - >= 1
 * @param {string} input.commitSha - Exactly 40 hex characters
 * @param {object} input.verificationReceipt - This project's own verification evidence, whatever shape it takes
 * @param {object} input.planCheckpoint - A snapshot of the plan's own state at this chunk's completion
 * @param {boolean} input.reflectionComplete - Must be exactly `true`
 * @param {string} [input.reflectionDetail]
 * @param {boolean} input.childAccountingComplete - Must be exactly `true` (no subagent left unaccounted for)
 * @param {string} [input.childAccountingDetail]
 * @param {string} [input.sessionGeneration] - The engine's own session/context generation id, when it exposes one
 * @param {boolean} input.builderAcknowledged - Must be exactly `true`; see the trust-boundary note above
 * @returns {{ok: true, receipt: object, replay?: true}|{ok: false, code: string, message: string}}
 */
function createChunkBoundaryReceipt(input) {
  const db = _db();
  const b = input && typeof input === 'object' ? input : {};

  for (const { field, code } of REQUIRED_FIELDS) {
    const v = b[field];
    if (v === undefined || v === null || v === '') return _refuse(code, `Field "${field}" is required.`);
  }
  if (!Number.isSafeInteger(b.chunkNumber) || b.chunkNumber < 1) {
    return _refuse('CHUNK_BOUNDARY_CHUNK_NUMBER_INVALID', 'Field "chunkNumber" must be an integer >= 1.');
  }
  if (typeof b.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(b.commitSha)) {
    return _refuse('CHUNK_BOUNDARY_COMMIT_INVALID', 'Field "commitSha" must be exactly 40 hex characters.');
  }
  // The invariant: reflection and child-accounting must be affirmatively
  // complete, and the Builder's own acknowledgment must be affirmatively
  // true -- never inferred from absence, never defaulted.
  if (b.reflectionComplete !== true) {
    return _refuse('CHUNK_BOUNDARY_REFLECTION_INCOMPLETE', 'Field "reflectionComplete" must be exactly true.');
  }
  if (b.childAccountingComplete !== true) {
    return _refuse('CHUNK_BOUNDARY_CHILD_ACCOUNTING_INCOMPLETE', 'Field "childAccountingComplete" must be exactly true.');
  }
  if (b.builderAcknowledged !== true) {
    return _refuse(
      'CHUNK_BOUNDARY_NOT_ACKNOWLEDGED',
      'Field "builderAcknowledged" must be exactly true -- a PM assertion alone, or automatic compaction, never creates a valid receipt.'
    );
  }

  const existing = db.prepare('SELECT * FROM chunk_boundary_receipts WHERE project_id = ? AND assignment_id = ? AND chunk_number = ?')
    .get(b.projectId, b.assignmentId, b.chunkNumber);
  if (existing) return { ok: true, receipt: _rowToReceipt(existing), replay: true };

  const now = _internal.now();
  const receiptId = _internal.id();
  db.prepare(
    `INSERT INTO chunk_boundary_receipts
       (receipt_id, project_id, session_id, launch_id, train, lane, plan_ref, builder, assignment_id,
        chunk_number, commit_sha, verification_receipt_json, plan_checkpoint_json,
        reflection_complete, reflection_detail, child_accounting_complete, child_accounting_detail,
        session_generation, builder_acknowledged, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    receiptId, b.projectId, b.sessionId || null, b.launchId || null, b.train, b.lane, b.planRef, b.builder,
    b.assignmentId, b.chunkNumber, b.commitSha.toLowerCase(), JSON.stringify(b.verificationReceipt),
    JSON.stringify(b.planCheckpoint), 1, b.reflectionDetail || null, 1, b.childAccountingDetail || null,
    b.sessionGeneration || null, STATES.PREPARE_CLEAR, now, now
  );
  _recordEvent(db, receiptId, 'created', `chunk ${b.chunkNumber} for assignment ${b.assignmentId}`);
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * Guard a single forward transition: the receipt must exist, must not
 * already be superseded, and the move from its current state must be one
 * {@link ALLOWED_TRANSITIONS} actually lists.
 * @param {object} db
 * @param {string} receiptId
 * @param {string} toState
 * @returns {{ok: true, row: object}|{ok: false, code: string, message: string}}
 */
function _guardTransition(db, receiptId, toState) {
  const row = _getRow(db, receiptId);
  if (!row) return _refuse('CHUNK_BOUNDARY_RECEIPT_NOT_FOUND', `No chunk-boundary receipt "${receiptId}".`);
  if (row.superseded_at) return _refuse('CHUNK_BOUNDARY_SUPERSEDED', 'This receipt was superseded; it accepts no further transitions.');
  const allowed = ALLOWED_TRANSITIONS[row.state] || [];
  if (!allowed.includes(toState)) {
    return _refuse(
      'CHUNK_BOUNDARY_TRANSITION_INVALID',
      `Cannot move from "${row.state}" to "${toState}".`
    );
  }
  return { ok: true, row };
}

/**
 * The PM marks a chunk ready to clear: `prepare_clear` -> `ready_to_clear`.
 * @param {string} receiptId
 * @returns {{ok: true, receipt: object}|{ok: false, code: string, message: string}}
 */
function markReadyToClear(receiptId) {
  const db = _db();
  const guard = _guardTransition(db, receiptId, STATES.READY_TO_CLEAR);
  if (!guard.ok) return guard;
  const now = _internal.now();
  db.prepare('UPDATE chunk_boundary_receipts SET state = ?, updated_at = ? WHERE receipt_id = ?')
    .run(STATES.READY_TO_CLEAR, now, receiptId);
  _recordEvent(db, receiptId, 'ready_to_clear');
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * The PM records a target-bound clear-intent before injecting `/clear` into
 * the Builder's pane: `ready_to_clear` -> `clear_intent_sent`, or
 * `clear_intent_sent` -> itself again (a fresh attempt after a prior
 * `uncertain`/`failed` outcome -- never automatic, always a new explicit
 * call). `clearAttempts` counts every call that reaches this state.
 * @param {string} receiptId
 * @param {{targetSessionId: number}} input - The exact session this clear-intent targets
 * @returns {{ok: true, receipt: object}|{ok: false, code: string, message: string}}
 */
function recordClearIntent(receiptId, input) {
  const db = _db();
  const b = input && typeof input === 'object' ? input : {};
  if (!Number.isSafeInteger(b.targetSessionId)) {
    return _refuse('CHUNK_BOUNDARY_TARGET_SESSION_REQUIRED', 'Field "targetSessionId" must be an integer session id.');
  }
  const guard = _guardTransition(db, receiptId, STATES.CLEAR_INTENT_SENT);
  if (!guard.ok) return guard;
  const now = _internal.now();
  db.prepare(
    `UPDATE chunk_boundary_receipts
       SET state = ?, clear_attempts = clear_attempts + 1, clear_target_session_id = ?,
           clear_intent_sent_at = ?, clear_outcome = NULL, clear_outcome_detail = NULL,
           clear_outcome_at = NULL, updated_at = ?
     WHERE receipt_id = ?`
  ).run(STATES.CLEAR_INTENT_SENT, b.targetSessionId, now, now, receiptId);
  _recordEvent(db, receiptId, 'clear_intent_sent', `target session ${b.targetSessionId}`);
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * Record a clear-intent's injection outcome. `success` leaves the receipt in
 * `clear_intent_sent` awaiting the Builder's own re-entry acknowledgment
 * ({@link acknowledgeReadyAfterClear}); `uncertain`/`failed` also leave it in
 * `clear_intent_sent` -- a visible HOLD this module never auto-retries, per
 * Architect Ruling A1889 bullet 2. Only {@link recordClearIntent} moves it
 * forward again, as a new, explicit attempt.
 * @param {string} receiptId
 * @param {{outcome: string, detail?: string}} input
 * @returns {{ok: true, receipt: object}|{ok: false, code: string, message: string}}
 */
function recordClearOutcome(receiptId, input) {
  const db = _db();
  const b = input && typeof input === 'object' ? input : {};
  if (!CLEAR_OUTCOMES.includes(b.outcome)) {
    return _refuse('CHUNK_BOUNDARY_OUTCOME_INVALID', `Field "outcome" must be one of: ${CLEAR_OUTCOMES.join(', ')}.`);
  }
  const row = _getRow(db, receiptId);
  if (!row) return _refuse('CHUNK_BOUNDARY_RECEIPT_NOT_FOUND', `No chunk-boundary receipt "${receiptId}".`);
  if (row.superseded_at) return _refuse('CHUNK_BOUNDARY_SUPERSEDED', 'This receipt was superseded; it accepts no further transitions.');
  if (row.state !== STATES.CLEAR_INTENT_SENT) {
    return _refuse('CHUNK_BOUNDARY_TRANSITION_INVALID', `A clear outcome may only be recorded from "${STATES.CLEAR_INTENT_SENT}", not "${row.state}".`);
  }
  const now = _internal.now();
  db.prepare(
    'UPDATE chunk_boundary_receipts SET clear_outcome = ?, clear_outcome_detail = ?, clear_outcome_at = ?, updated_at = ? WHERE receipt_id = ?'
  ).run(b.outcome, b.detail || null, now, now, receiptId);
  _recordEvent(db, receiptId, 'clear_outcome_recorded', b.outcome);
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * The Builder's own clean re-entry acknowledgment, completing the boundary:
 * `clear_intent_sent` (with a recorded `success` outcome) -> `ready_after_clear`.
 * Refused -- not silently ignored -- when the last recorded outcome was not
 * `success`, or none was ever recorded: nothing here infers success from the
 * absence of a recorded failure.
 * @param {string} receiptId
 * @param {{sessionGeneration?: string}} [input]
 * @returns {{ok: true, receipt: object}|{ok: false, code: string, message: string}}
 */
function acknowledgeReadyAfterClear(receiptId, input = {}) {
  const db = _db();
  const guard = _guardTransition(db, receiptId, STATES.READY_AFTER_CLEAR);
  if (!guard.ok) return guard;
  if (guard.row.clear_outcome !== 'success') {
    return _refuse(
      'CHUNK_BOUNDARY_OUTCOME_NOT_SUCCESSFUL',
      `The last recorded clear outcome is "${guard.row.clear_outcome || 'none'}", not "success"; re-entry cannot be acknowledged yet.`
    );
  }
  const now = _internal.now();
  db.prepare(
    'UPDATE chunk_boundary_receipts SET state = ?, session_generation = COALESCE(?, session_generation), ready_after_clear_at = ?, updated_at = ? WHERE receipt_id = ?'
  ).run(STATES.READY_AFTER_CLEAR, input.sessionGeneration || null, now, now, receiptId);
  _recordEvent(db, receiptId, 'ready_after_clear');
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * Supersede a receipt the situation resolved some other way (a corrected
 * duplicate, a re-planned chunk) -- never an answer, same non-answer closure
 * shape as `lib/decision-routing.js#supersedeDecisionRequest`. Idempotent: a
 * receipt already superseded is a no-op replay.
 * @param {string} receiptId
 * @param {{reason: string}} input
 * @returns {{ok: true, receipt: object, replay?: true}|{ok: false, code: string, message: string}}
 */
function supersedeChunkBoundaryReceipt(receiptId, input) {
  const db = _db();
  const b = input && typeof input === 'object' ? input : {};
  if (typeof b.reason !== 'string' || b.reason.length === 0) {
    return _refuse('CHUNK_BOUNDARY_REASON_REQUIRED', 'Field "reason" must be a non-empty string.');
  }
  const row = _getRow(db, receiptId);
  if (!row) return _refuse('CHUNK_BOUNDARY_RECEIPT_NOT_FOUND', `No chunk-boundary receipt "${receiptId}".`);
  if (row.superseded_at) return { ok: true, receipt: _rowToReceipt(row), replay: true };
  const now = _internal.now();
  db.prepare('UPDATE chunk_boundary_receipts SET superseded_at = ?, superseded_reason = ?, updated_at = ? WHERE receipt_id = ?')
    .run(now, b.reason, now, receiptId);
  _recordEvent(db, receiptId, 'superseded', b.reason);
  return { ok: true, receipt: _rowToReceipt(_getRow(db, receiptId)) };
}

/**
 * Read one receipt by id, or `null`.
 * @param {string} receiptId
 * @returns {object|null}
 */
function getChunkBoundaryReceipt(receiptId) {
  const db = _db();
  const row = _getRow(db, receiptId);
  return row ? _rowToReceipt(row) : null;
}

/**
 * The receipt on record for one (project, assignment, chunk) triple, or
 * `null` when none exists.
 * @param {number} projectId
 * @param {string} assignmentId
 * @param {number} chunkNumber
 * @returns {object|null}
 */
function getReceiptForChunk(projectId, assignmentId, chunkNumber) {
  const db = _db();
  const row = db.prepare('SELECT * FROM chunk_boundary_receipts WHERE project_id = ? AND assignment_id = ? AND chunk_number = ?')
    .get(projectId, assignmentId, chunkNumber);
  return row ? _rowToReceipt(row) : null;
}

/**
 * The admission gate (Architect Ruling A1889 bullet 3): whether Chunk N+1
 * may be dispatched to this assignment. Validates receipt identity,
 * sequence, freshness, commit, and lane binding against the durable receipt
 * for Chunk N -- a pure read, so it is trivially idempotent across retries
 * and survives a controller/PM/session restart (nothing here is in-memory).
 * @param {object} candidate
 * @param {number} candidate.projectId
 * @param {string} candidate.train
 * @param {string} candidate.lane
 * @param {string} candidate.builder
 * @param {string} candidate.assignmentId
 * @param {number} candidate.nextChunkNumber - The Chunk about to be dispatched; >= 2
 * @param {string} [candidate.expectedPriorCommit] - When supplied, must match the prior receipt's own commit
 * @param {{maxAgeMs?: number, now?: string}} [opts]
 * @returns {{ok: true, receipt: object}|{ok: false, hold: true, reason: string, message: string, receipt: (object|null)}}
 */
function validateNextChunkDispatch(candidate, opts = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_RECEIPT_AGE_MS;
  const nowIso = opts.now || _internal.now();
  const priorChunk = (Number.isSafeInteger(c.nextChunkNumber) ? c.nextChunkNumber : 0) - 1;

  const receipt = priorChunk >= 1 ? getReceiptForChunk(c.projectId, c.assignmentId, priorChunk) : null;
  if (!receipt) return _hold(HOLD_REASONS.MISSING_PRIOR_RECEIPT, null);
  if (receipt.supersededAt) return _hold(HOLD_REASONS.RECEIPT_SUPERSEDED, receipt);
  if (receipt.state !== STATES.READY_AFTER_CLEAR) return _hold(HOLD_REASONS.BOUNDARY_INCOMPLETE, receipt);

  const ageMs = Date.parse(nowIso) - Date.parse(receipt.readyAfterClearAt || receipt.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) return _hold(HOLD_REASONS.RECEIPT_STALE, receipt);

  if (typeof c.expectedPriorCommit === 'string' && c.expectedPriorCommit.length > 0
    && c.expectedPriorCommit.toLowerCase() !== receipt.commitSha) {
    return _hold(HOLD_REASONS.COMMIT_MISMATCH, receipt);
  }

  if (receipt.train !== c.train || receipt.lane !== c.lane || receipt.builder !== c.builder) {
    return _hold(HOLD_REASONS.LANE_MISMATCH, receipt);
  }

  return { ok: true, receipt };
}

/** This module's own protocol version. Bump it when {@link _PROJECTION_SUBSTANCE}'s content changes. */
const PROTOCOL_VERSION = '1.0.0';

/**
 * The role-projection's own substance, independent of the version/digest
 * header line -- so {@link protocolDigest} can hash this directly without
 * calling back into {@link roleProjectionLines} (which would recurse:
 * the header line itself embeds the digest).
 * @type {string[]}
 */
const _PROJECTION_SUBSTANCE = Object.freeze([
  'A Chunk is complete only once a **durable receipt** records it, not a conversational '
    + 'acknowledgment that can be lost or bypassed. A receipt requires, together: the exact '
    + 'completed commit, this project\'s own verification evidence, a durable plan checkpoint, '
    + 'reflection-gate and child-accounting completion, and -- the one piece nothing else can '
    + 'substitute for -- **the Builder\'s own acknowledgment**. A PM assertion alone, or '
    + 'automatic context compaction, never creates or completes one.',
  '',
  '| Lifecycle step | What it means |',
  '|---|---|',
  '| `compact` | Continuity/pressure relief inside active work. Never advances the Train. |',
  '| `/clear` | A planned boundary, taken only once the Chunk\'s receipt exists and is complete. |',
  '| `wrap` | Closes the Train lifecycle. Release/merge/deploy authority is separately governed. |',
  '',
  '**If you are the Project Manager:** before dispatching Chunk N+1 to a lane, its receipt '
    + 'for Chunk N must exist and read `ready_after_clear` -- `lib/chunk-boundary.js#validateNextChunkDispatch` '
    + 'is the one place that checks this honestly; do not dispatch around a HOLD it returns.',
  '',
  '**If you are the Builder:** independently refuse a Chunk N+1 dispatch that cites no valid '
    + 'prior-chunk receipt, even if the PM asserts the prior chunk is done -- the receipt, not the '
    + 'assertion, is what the next session (yours or a fresh one) can actually trust after a restart.'
]);

/**
 * A short, stable digest of {@link _PROJECTION_SUBSTANCE} plus
 * {@link PROTOCOL_VERSION} -- independent of `roleProjectionLines`, which
 * instead embeds this digest's own output in its header line.
 * @returns {string} 12 hex characters
 */
function protocolDigest() {
  const substance = `${PROTOCOL_VERSION}\n${_PROJECTION_SUBSTANCE.join('\n')}`;
  return crypto.createHash('sha256').update(substance).digest('hex').slice(0, 12);
}

/**
 * The versioned role-aware session-boundary contract, as lines of text, for
 * both the Project Manager and the Builder role in one dual-audience block
 * -- the issue's own "until first-class role/contract fields exist, use the
 * managed project rule/prime compatibility path": nothing in this codebase
 * yet distinguishes which role a given project/session plays, so the same
 * generated text carries both roles' guidance rather than guessing which one
 * applies. Named the same `(format, options)` shape
 * `lib/engines.js#_medusaSwitchboardLines` already uses, so it plugs into
 * the same generated-carrier call sites.
 * @param {'md'|'comment'} [format]
 * @returns {string[]}
 */
function roleProjectionLines(format = 'md') {
  const version = PROTOCOL_VERSION;
  const digest = protocolDigest();
  if (format === 'comment') {
    return [
      '#',
      `# Chunk-Boundary Protocol v${version} (digest ${digest}) -- #1889`,
      '# A Chunk is complete only once a durable receipt records it: the exact commit,',
      '# verification evidence, a plan checkpoint, reflection and child-accounting',
      '# completion, AND the Builder\'s own acknowledgment -- never a PM assertion alone,',
      '# never automatic compaction. compact: continuity relief, never advances the Train.',
      '# /clear: a planned boundary, taken only after that receipt exists.',
      '# PM: before dispatching Chunk N+1, the receipt for Chunk N must exist and read',
      '# ready_after_clear. Builder: refuse a Chunk N+1 dispatch that cites no such receipt.'
    ];
  }
  return [
    `## Chunk-Boundary Protocol v${version} (#1889)`,
    '',
    `_Digest \`${digest}\` -- for diagnosing which version of this text a session loaded._`,
    '',
    ..._PROJECTION_SUBSTANCE,
    ''
  ];
}

module.exports = {
  STATES,
  CLEAR_OUTCOMES,
  HOLD_REASONS,
  HOLD_MEANINGS,
  DEFAULT_MAX_RECEIPT_AGE_MS,
  PROTOCOL_VERSION,
  createChunkBoundaryReceipt,
  markReadyToClear,
  recordClearIntent,
  recordClearOutcome,
  acknowledgeReadyAfterClear,
  supersedeChunkBoundaryReceipt,
  getChunkBoundaryReceipt,
  getReceiptForChunk,
  validateNextChunkDispatch,
  roleProjectionLines,
  protocolDigest,
  ensureChunkBoundarySchema,
  _internal
};
