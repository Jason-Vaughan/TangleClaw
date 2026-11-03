'use strict';

/**
 * Closed-loop session lifecycle handoff (#2073 Slice 1, v5.58.0 Wave 2
 * Car 58-D, Architect Ruling A2073).
 *
 * Self-contained, same shape as `lib/governed-wrap.js`/`lib/chunk-boundary.js`:
 * this module owns its own storage via `ensureLifecycleHandoffSchema`,
 * applied additively (`CREATE TABLE IF NOT EXISTS`) on `store.getDb()` -- it
 * never touches `lib/store/_schema.js`.
 *
 * The problem (issue #2073's own words): a coordinating session can
 * checkpoint and request its own wrap, but the session that disappears
 * cannot also confirm its own terminal state, launch exactly one
 * replacement, deliver the exact checkpoint, verify reconciliation, receive
 * takeover, and close the delegation. A human remains the implicit
 * lifecycle daemon. The missing loop, as the issue states it:
 *
 *   1. the source coordinator checkpoints durable state;
 *   2. it delegates one-generation lifecycle authority to one governed session;
 *   3. the delegate supervises or initiates the supported wrap/finalize path
 *      without Kill;
 *   4. the delegate waits for conclusive, settled inactivity;
 *   5. it launches exactly one replacement for the same project;
 *   6. the replacement completes the entire normal startup protocol;
 *   7. the exact generation- and digest-bound checkpoint is delivered and reconciled;
 *   8. the replacement emits a takeover receipt; and
 *   9. the handoff closes atomically and releases the delegate.
 *
 * ## What this file is (Slice 1: Closed-Loop State Machine & Authority Contract)
 *
 * This module is the durable record and state machine for that transaction
 * -- it records and VALIDATES each step; the underlying actions it
 * validates (the actual wrap, the actual launch) run through the EXISTING,
 * separately gated mechanisms this module calls directly rather than
 * reimplementing:
 *
 * - **Checkpoint + delegation (steps 1-2):** {@link createHandoff} persists
 *   the checkpoint and its digest, and the control assignment's
 *   `state_generation` observed at that moment, if the project is governed.
 *   "One-generation" is enforced by {@link _requireLiveGeneration}: every
 *   later step refuses as `GENERATION_MOVED` (a typed blocker, never a
 *   guess) if that generation has since moved -- a HOLD, STOP, release or
 *   rebind landing mid-handoff invalidates it. Caller AUTHORITY to open or
 *   drive a handoff is proven once, at the route layer, by the SAME
 *   `_requireSessionLifecycleCaller(action: 'wrap')` gate #2824 restored --
 *   this module never re-checks or duplicates it.
 * - **Wrap/finalize without Kill (step 3):** {@link recordWrapInitiated}
 *   only records that the delegate started the real path (the existing
 *   `/wrap` route, `lib/governed-wrap.js`, or `lib/session-finalize.js`) --
 *   it does not call it; nothing in this module ever calls
 *   `store.sessions.kill`.
 * - **Settled, conclusive inactivity (step 4):** {@link recordTerminalConfirmed}
 *   reads the source session's REAL stored status. A session's status
 *   leaving `active` (to `wrapped`/`killed`/`crashed`) is written only by
 *   the wrap/kill/finalize code paths themselves, never guessed or polled
 *   from pane activity -- the authoritative, non-racy signal the issue asks for.
 * - **Single-replacement launch (step 5):** {@link launchReplacement} calls
 *   `lib/sessions.js#launchSession` for real, guarded by the SAME
 *   partial-unique-index pattern #1889/#2072 use: at most one OPEN handoff
 *   per project, so two delegates racing the same source can never both
 *   launch a successor.
 * - **Startup protocol + caller-identity-bound reconciliation (steps 6-7):**
 *   {@link reconcileStartup} requires the CALLER to genuinely be the
 *   handoff's own replacement session (or the operator) --
 *   {@link _isReplacementCaller} -- never a value the delegate could read
 *   back from this same API and resubmit as if it were proof (PRR-B
 *   I-Gate Round 1 Finding 4: an earlier design compared a caller-supplied
 *   digest to the stored one, which only proves the caller can read the
 *   API, not that it IS the replacement). It then refuses retryably until
 *   the replacement's own launch sequence has genuinely attested READY
 *   (`lib/launch-sequence.js`, `launch_sequences.ready_at`).
 * - **Takeover + atomic close (steps 8-9):** {@link recordTakeover} is the
 *   one transition into the terminal `takeover_complete` state; after it,
 *   this handoff grants nothing further to its delegate.
 * - **Fail-closed, checkpoint preserved:** {@link recordBlocker} is reachable
 *   from every non-terminal state and NEVER clears `checkpoint_json` --
 *   a failed handoff's checkpoint stays exactly as durable as a successful
 *   one's, for whatever picks the work back up.
 *
 * ## What this file is NOT (tracked as Slice 2+, out of this envelope)
 *
 * - Managed clear, restart, engine rebind and context-replacement transition
 *   types (the issue's own "Required handoff record" names all six;
 *   Ruling A2073's Slice 1 text names only wrap/finalize) --
 *   `transition_type` is deliberately `'wrap'|'finalize'` only here.
 * - An end-to-end background daemon that polls live tmux processes and
 *   drives this state machine unattended -- explicitly named in Ruling
 *   A2073 as a follow-up outside Milestone #43. This module is driven by
 *   explicit calls (a delegate session's own, or a route a server makes),
 *   never a timer of its own.
 *
 * @module lib/lifecycle-handoff
 */

const crypto = require('node:crypto');
const store = require('./store');
const sessions = require('./sessions');

/** How long `reconcileStartup` waits before giving up is the CALLER's business; this module has no timer of its own. */

/** This handoff state machine's own states. */
const STATES = Object.freeze({
  CHECKPOINTED: 'checkpointed',
  WRAP_INITIATED: 'wrap_initiated',
  TERMINAL_CONFIRMED: 'terminal_confirmed',
  REPLACEMENT_LAUNCHED: 'replacement_launched',
  STARTUP_READY: 'startup_ready',
  TAKEOVER_COMPLETE: 'takeover_complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

/** The only forward edges this state machine allows; anything else is refused. */
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.CHECKPOINTED]: [STATES.WRAP_INITIATED],
  [STATES.WRAP_INITIATED]: [STATES.TERMINAL_CONFIRMED],
  [STATES.TERMINAL_CONFIRMED]: [STATES.REPLACEMENT_LAUNCHED],
  [STATES.REPLACEMENT_LAUNCHED]: [STATES.STARTUP_READY],
  [STATES.STARTUP_READY]: [STATES.TAKEOVER_COMPLETE],
  [STATES.TAKEOVER_COMPLETE]: [],
  [STATES.FAILED]: [],
  [STATES.CANCELLED]: []
});

/** States that still count as "open" for the single-replacement, duplicate-handoff guard. */
const OPEN_STATES = Object.freeze([
  STATES.CHECKPOINTED, STATES.WRAP_INITIATED, STATES.TERMINAL_CONFIRMED, STATES.REPLACEMENT_LAUNCHED, STATES.STARTUP_READY
]);

/** The only transition types Slice 1 covers (see module doc). */
const TRANSITION_TYPES = Object.freeze(['wrap', 'finalize']);

/**
 * The activity-log event {@link launchReplacement} writes, binding a
 * launched session id to the exact handoff and attempt token that launched
 * it (PRR-B I-Gate Round 2 Finding 2) -- a durable, session-id-bound marker,
 * never a timestamp heuristic (`sessions.started_at` is only second-
 * resolution, too coarse to tell "this attempt's own session" apart from an
 * unrelated one created in the same wall-clock second).
 */
const EVENT_LAUNCH_ATTEMPTED = 'lifecycle_handoff.launch_attempted';

/** Typed blocker codes {@link recordBlocker} may record, named so a reader looks them up rather than parsing prose. */
const BLOCKER_CODES = Object.freeze({
  GENERATION_MOVED: 'generation-moved',
  CHECKPOINT_DIGEST_MISMATCH: 'checkpoint-digest-mismatch',
  OTHER: 'other'
});

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `lho_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the shape the other decision/receipt modules already use.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * The DDL for this module's one table. Purely additive (`IF NOT EXISTS`).
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS lifecycle_handoffs (
      handoff_id             TEXT    PRIMARY KEY CHECK (length(handoff_id) BETWEEN 1 AND 64),
      project_id             INTEGER NOT NULL,
      project_name           TEXT    NOT NULL CHECK (length(project_name) BETWEEN 1 AND 200),
      source_session_id      INTEGER NOT NULL,
      source_launch_id       TEXT    CHECK (source_launch_id IS NULL OR length(source_launch_id) <= 128),
      transition_type        TEXT    NOT NULL CHECK (transition_type IN ('wrap','finalize')),
      delegate_principal     TEXT    NOT NULL CHECK (length(delegate_principal) BETWEEN 1 AND 128),
      observed_generation    INTEGER,
      checkpoint_json        TEXT    NOT NULL CHECK (length(checkpoint_json) BETWEEN 1 AND 16000),
      checkpoint_digest      TEXT    NOT NULL CHECK (length(checkpoint_digest) = 64),
      -- PRR-B I-Gate Round 3 Finding: the activity_log high-water mark at
      -- the moment THIS handoff was created -- _realWrapOrFinalizeInitiated
      -- requires its evidence row's id to exceed this, so an older wrap's
      -- (or finalize's) own history can never satisfy a NEW handoff's
      -- wrap-initiated transition.
      baseline_activity_id   INTEGER NOT NULL DEFAULT 0,
      state                  TEXT    NOT NULL DEFAULT 'checkpointed'
                                      CHECK (state IN ('checkpointed','wrap_initiated','terminal_confirmed',
                                                        'replacement_launched','startup_ready','takeover_complete',
                                                        'failed','cancelled')),
      replacement_session_id INTEGER,
      replacement_launch_id  TEXT    CHECK (replacement_launch_id IS NULL OR length(replacement_launch_id) <= 128),
      -- PRR-B I-Gate Round 2 Finding 2: a launch retry's own attempt identity
      -- and expected engine, persisted BEFORE the real launch call. The
      -- token is also written, durably, onto the activity-log row that
      -- marks the launched session (see EVENT_LAUNCH_ATTEMPTED) -- that
      -- marker, not this column alone, is what a retry matches an active
      -- session against.
      launch_attempt_token   TEXT    CHECK (launch_attempt_token IS NULL OR length(launch_attempt_token) <= 64),
      launch_attempt_engine_id TEXT  CHECK (launch_attempt_engine_id IS NULL OR length(launch_attempt_engine_id) <= 200),
      -- PRR-B I-Gate Round 2 Finding 1: the replacement's own reconciliation
      -- receipt -- the checkpoint digest and generation it actually read,
      -- echoed back and verified against this row's own values, never just
      -- identity plus a READY flag.
      reconciled_digest      TEXT    CHECK (reconciled_digest IS NULL OR length(reconciled_digest) = 64),
      reconciled_generation  INTEGER,
      blocker_code           TEXT    CHECK (blocker_code IS NULL OR length(blocker_code) <= 64),
      blocker_detail         TEXT    CHECK (blocker_detail IS NULL OR length(blocker_detail) <= 2000),
      cancel_reason          TEXT    CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL
    );

    -- Single-replacement guard: at most one OPEN handoff per project. A
    -- terminal row (takeover_complete/failed/cancelled) no longer occupies
    -- the key, the same partial-unique pattern #1889's receipts use.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lifecycle_handoffs_open_unique
      ON lifecycle_handoffs(project_id)
      WHERE state IN ('checkpointed','wrap_initiated','terminal_confirmed','replacement_launched','startup_ready');

    CREATE INDEX IF NOT EXISTS idx_lifecycle_handoffs_project
      ON lifecycle_handoffs(project_id, created_at);
  `;
}

/** Whether `ensureLifecycleHandoffSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureLifecycleHandoffSchema(db) {
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
  ensureLifecycleHandoffSchema(db);
  return db;
}

/**
 * One row, as the public shape callers read (camelCase, parsed JSON).
 * @param {object} row - Raw row
 * @returns {object}
 */
function _view(row) {
  return {
    handoffId: row.handoff_id,
    projectId: row.project_id,
    projectName: row.project_name,
    sourceSessionId: row.source_session_id,
    sourceLaunchId: row.source_launch_id,
    transitionType: row.transition_type,
    delegatePrincipal: row.delegate_principal,
    observedGeneration: row.observed_generation,
    checkpoint: JSON.parse(row.checkpoint_json),
    checkpointDigest: row.checkpoint_digest,
    state: row.state,
    replacementSessionId: row.replacement_session_id,
    replacementLaunchId: row.replacement_launch_id,
    reconciledDigest: row.reconciled_digest,
    reconciledGeneration: row.reconciled_generation,
    blockerCode: row.blocker_code,
    blockerDetail: row.blocker_detail,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * A stable sha256 of a checkpoint document -- what digest-bound
 * reconciliation compares against.
 * @param {object} checkpoint
 * @returns {string} 64-hex-char sha256
 */
function _digestOf(checkpoint) {
  return crypto.createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex');
}

/**
 * Load one row by id.
 * @param {string} handoffId
 * @returns {object|null}
 */
function _load(handoffId) {
  return _db().prepare('SELECT * FROM lifecycle_handoffs WHERE handoff_id = ?').get(handoffId) || null;
}

/**
 * Enforce an allowed transition, or refuse.
 * @param {object} row
 * @param {string} to
 * @returns {{ok: false, code: string, message: string}|null}
 */
function _checkTransition(row, to) {
  if (!ALLOWED_TRANSITIONS[row.state] || !ALLOWED_TRANSITIONS[row.state].includes(to)) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID_TRANSITION',
      `Handoff "${row.handoff_id}" is "${row.state}"; it cannot move to "${to}" from there.`, { state: row.state });
  }
  return null;
}

/**
 * Step 2's "one-generation" rule: refuse if the project's open assignment
 * generation has moved since this handoff observed it. A null
 * `observedGeneration` means the project was ungoverned at checkpoint time,
 * and stays exempt -- there is nothing to move.
 * @param {object} row
 * @returns {{ok: false, code: string, message: string}|null}
 */
function _requireLiveGeneration(row) {
  if (row.observed_generation === null) return null;
  const open = store.control.getOpenForProject(row.project_id);
  const liveGeneration = open ? open.state_generation : null;
  if (liveGeneration !== row.observed_generation) {
    return _refuse('LIFECYCLE_HANDOFF_GENERATION_MOVED',
      'The control generation this handoff\'s delegation was bound to has moved since checkpointing; '
        + 'a fresh handoff is required.', { observedGeneration: row.observed_generation, liveGeneration });
  }
  return null;
}

/**
 * Create a handoff: persist the checkpoint and its digest, and the control
 * generation observed right now, if the project is governed. Refuses when
 * the project already has an open handoff (the single-replacement,
 * duplicate-handoff guard) or `sourceSessionId` is not its current active
 * session.
 * @param {object} input
 * @param {string} input.projectName
 * @param {number} input.sourceSessionId - Must be the project's CURRENT active session
 * @param {'wrap'|'finalize'} input.transitionType
 * @param {string} input.delegatePrincipal - Who this handoff delegates to, for the audit trail --
 *   the route layer has already proven this principal may act on the target (`_requireSessionLifecycleCaller`,
 *   `action: 'wrap'`) before this function is ever called.
 * @param {object} input.checkpoint - The source's durable checkpoint document; opaque to this module beyond its digest.
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function createHandoff(input) {
  const { projectName, sourceSessionId, transitionType, delegatePrincipal, checkpoint } = input || {};
  if (typeof projectName !== 'string' || !projectName) return _refuse('LIFECYCLE_HANDOFF_INVALID', 'projectName is required.');
  if (!TRANSITION_TYPES.includes(transitionType)) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID', `transitionType must be one of ${TRANSITION_TYPES.join(', ')}.`);
  }
  if (typeof delegatePrincipal !== 'string' || !delegatePrincipal) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID', 'delegatePrincipal is required.');
  }
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID', 'checkpoint must be an object.');
  }

  const project = store.projects.getByName(projectName);
  if (!project) return _refuse('NOT_FOUND', `Project "${projectName}" not found.`);

  const active = store.sessions.getActive(project.id);
  if (!active || active.id !== sourceSessionId) {
    return _refuse('LIFECYCLE_HANDOFF_SESSION_NOT_CURRENT', `Session ${sourceSessionId} is not "${projectName}"'s current active session.`);
  }

  const db = _db();
  const existing = db.prepare(
    `SELECT handoff_id FROM lifecycle_handoffs WHERE project_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`
  ).get(project.id, ...OPEN_STATES);
  if (existing) {
    return _refuse('LIFECYCLE_HANDOFF_IN_PROGRESS', `"${projectName}" already has an open lifecycle handoff (${existing.handoff_id}).`,
      { handoffId: existing.handoff_id });
  }

  const sequence = store.launchSequences.getBySession(active.id);
  const open = store.control.getOpenForProject(project.id);
  const now = _internal.now();
  const handoffId = _internal.id();
  const digest = _digestOf(checkpoint);
  // The activity_log high-water mark, taken right now -- see the DDL's own
  // comment on `baseline_activity_id`.
  const baselineActivityId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity_log').get().id;

  db.prepare(
    `INSERT INTO lifecycle_handoffs
       (handoff_id, project_id, project_name, source_session_id, source_launch_id, transition_type,
        delegate_principal, observed_generation, checkpoint_json, checkpoint_digest, baseline_activity_id,
        state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(handoffId, project.id, project.name, active.id, sequence ? sequence.launchId : null, transitionType,
    delegatePrincipal, open ? open.state_generation : null, JSON.stringify(checkpoint), digest, baselineActivityId,
    STATES.CHECKPOINTED, now, now);

  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Whether a real wrap/finalize path has actually been initiated for a
 * handoff's source session -- never trusted from the caller's own
 * assertion (PRR-B I-Gate Round 1 Finding 4). `'wrap'` is proven by the
 * real wrap pipeline's own run registry actually running right now;
 * `'finalize'` is synchronous, so its proof is the activity-log record
 * `lib/sessions.js`'s own finalize path writes for this exact project and
 * session, never a caller-supplied claim.
 *
 * Bound to `baseline_activity_id` (PRR-B I-Gate Round 3 Finding): the
 * registry's checkpoint trail and the finalize activity record are both
 * durable and session-bound, but neither is HANDOFF-bound by itself -- an
 * older wrap that failed, or an older finalize, on the SAME source session
 * leaves exactly the same evidence a brand-new handoff would need, with no
 * way to tell them apart by session id alone. Requiring the matching row's
 * own `id` to exceed the high-water mark `createHandoff` recorded makes the
 * evidence specific to what happened SINCE this handoff opened, never any
 * point in that session's whole history.
 * @param {object} row
 * @returns {boolean}
 */
function _realWrapOrFinalizeInitiated(row) {
  const eventType = row.transition_type === 'wrap' ? require('./wrap-run-registry').EVENT_CHECKPOINT : 'session.finalized';
  const match = _db().prepare(
    'SELECT 1 FROM activity_log WHERE project_id = ? AND session_id = ? AND event_type = ? AND id > ? LIMIT 1'
  ).get(row.project_id, row.source_session_id, eventType, row.baseline_activity_id);
  return !!match;
}

/**
 * Step 3: record that the delegate started the real wrap/finalize path --
 * verified against the real pipeline/activity-log evidence
 * ({@link _realWrapOrFinalizeInitiated}), never a bare caller assertion.
 * Nothing here performs the wrap or finalize itself, and never Kill.
 * @param {string} handoffId
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function recordWrapInitiated(handoffId) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  const bad = _checkTransition(row, STATES.WRAP_INITIATED) || _requireLiveGeneration(row);
  if (bad) return bad;
  if (!_realWrapOrFinalizeInitiated(row)) {
    return _refuse('LIFECYCLE_HANDOFF_NOT_INITIATED',
      `No real ${row.transition_type} run is evidenced for session ${row.source_session_id} yet; start it through the real path first.`);
  }
  _advance(handoffId, STATES.WRAP_INITIATED);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Step 4: confirm settled, conclusive inactivity. Reads the source
 * session's REAL stored status -- ONLY `wrapped` (the status the real
 * wrap pipeline and `lib/session-finalize.js` both write on a genuine
 * governed termination) counts. `killed` and `crashed` are explicitly
 * refused here (PRR-B I-Gate Round 1 Finding 4): neither is the
 * wrap-without-Kill, settled termination A2073 requires, whatever the
 * delegate asserts.
 * @param {string} handoffId
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function recordTerminalConfirmed(handoffId) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  const bad = _checkTransition(row, STATES.TERMINAL_CONFIRMED) || _requireLiveGeneration(row);
  if (bad) return bad;
  const source = store.sessions.get(row.source_session_id);
  if (!source || source.status !== store.SESSION_STATUS.WRAPPED) {
    return _refuse('LIFECYCLE_HANDOFF_NOT_TERMINAL',
      `The source session has not reached a genuine governed "wrapped" status yet (currently "${source ? source.status : 'unknown'}").`);
  }
  _advance(handoffId, STATES.TERMINAL_CONFIRMED);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Step 5: launch exactly one replacement for the same project, for real,
 * through `lib/sessions.js#launchSession`. A launch-level refusal (no
 * engine available, isolation unverified, …) leaves the handoff at
 * `terminal_confirmed` -- retryable, not a failure.
 * @param {string} handoffId
 * @param {object} [launchOptions] - Forwarded to `launchSession` verbatim.
 * @returns {{ok: true, handoff: object, launched: object}|{ok: false, code: string, message: string}}
 */
function launchReplacement(handoffId, launchOptions) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  const bad = _checkTransition(row, STATES.REPLACEMENT_LAUNCHED) || _requireLiveGeneration(row);
  if (bad) return bad;

  // Restart-safety (PRR-B I-Gate Round 1 Finding 4, tightened at Round 2
  // Finding 2): the source is already confirmed `wrapped` by this point, so
  // nothing else SHOULD be launching into this project's active-session
  // slot except this exact handoff's own retry -- but "should" is not
  // proof, and `sessions.started_at` is only second-resolution, too coarse
  // to tell "this attempt's own session" apart from an unrelated one
  // created in the same wall-clock second by timing alone. Persist this
  // retry's own attempt identity and expected engine BEFORE calling
  // `launchSession`; once it succeeds, mark the launched session with that
  // exact attempt token in the durable activity log, BEFORE the handoff row
  // itself is updated, so a crash right after a successful launch still
  // leaves a session-id-bound marker a retry can match on. An active
  // session with no such marker for this attempt is a typed blocker, never
  // a silent adoption.
  const project = store.projects.getByName(row.project_name);
  const expectedEngineId = (launchOptions && launchOptions.engineOverride) || (project ? project.engineId : null);
  let attemptToken = row.launch_attempt_token;
  if (!attemptToken) {
    attemptToken = _internal.id();
    _db().prepare(
      'UPDATE lifecycle_handoffs SET launch_attempt_token = ?, launch_attempt_engine_id = ?, updated_at = ? WHERE handoff_id = ?'
    ).run(attemptToken, expectedEngineId, _internal.now(), handoffId);
  } else if (row.launch_attempt_engine_id !== expectedEngineId) {
    return _refuse('LIFECYCLE_HANDOFF_LAUNCH_ATTEMPT_MISMATCH',
      'This handoff\'s launch attempt was already recorded against a different expected engine than this retry names; '
        + 'retry with the same launchOptions, or cancel and open a fresh handoff.',
      { recordedEngineId: row.launch_attempt_engine_id, requestedEngineId: expectedEngineId });
  }

  const already = store.sessions.getActive(row.project_id);
  let launched;
  if (already) {
    const marked = store.activity.query({ projectId: row.project_id, sessionId: already.id, eventType: EVENT_LAUNCH_ATTEMPTED, limit: 10 })
      .some((r) => r.detail && r.detail.handoffId === handoffId && r.detail.attemptToken === attemptToken);
    if (!marked) {
      return _refuse('LIFECYCLE_HANDOFF_LAUNCH_UNRELATED_SESSION',
        `An active session (${already.id}) already occupies "${row.project_name}", but it carries no marker tying it to this `
          + 'handoff\'s own launch attempt. Resolve it manually before retrying.',
        { activeSessionId: already.id });
    }
    launched = { session: already, adopted: true };
  } else {
    launched = sessions.launchSession(row.project_name, launchOptions || {});
    if (launched.session) {
      store.activity.log({
        projectId: row.project_id, sessionId: launched.session.id, eventType: EVENT_LAUNCH_ATTEMPTED,
        detail: { handoffId, attemptToken }
      });
    }
  }
  if (!launched.session) {
    return _refuse(launched.code || 'LIFECYCLE_HANDOFF_LAUNCH_REFUSED', launched.error || 'The replacement launch was refused.', { launched });
  }
  const sequence = store.launchSequences.getBySession(launched.session.id);
  const now = _internal.now();
  _db().prepare(
    'UPDATE lifecycle_handoffs SET state = ?, replacement_session_id = ?, replacement_launch_id = ?, updated_at = ? WHERE handoff_id = ?'
  ).run(STATES.REPLACEMENT_LAUNCHED, launched.session.id, sequence ? sequence.launchId : null, now, handoffId);
  return { ok: true, handoff: _view(_load(handoffId)), launched };
}

/**
 * Whether `caller` genuinely IS the handoff's own replacement session --
 * never a bare caller-supplied value, since the delegate itself can always
 * read a handoff's facts and parrot them back (PRR-B I-Gate Round 1
 * Finding 4). The operator may always call on the replacement's behalf
 * (break-glass, same as every other lifecycle action's operator path); a
 * project caller must be the EXACT session/launch this handoff recorded as
 * its replacement.
 * @param {object} row
 * @param {{kind: string, sessionId?: number, launchId?: string}|null} caller
 * @returns {boolean}
 */
function _isReplacementCaller(row, caller) {
  if (!caller) return false;
  if (caller.kind === 'operator') return true;
  return caller.kind === 'project' && caller.sessionId === row.replacement_session_id
    && typeof row.replacement_launch_id === 'string' && caller.launchId === row.replacement_launch_id;
}

/**
 * Steps 6-7: reconcile the replacement's startup. Refuses retryably until
 * the replacement's own launch sequence has attested READY. The caller
 * must genuinely BE the replacement (or the operator) --
 * {@link _isReplacementCaller} -- never a claim the delegate could forge by
 * reading this handoff's own facts and resubmitting them.
 *
 * Identity and launch READY establish WHO is calling, not that the
 * checkpoint was actually read (PRR-B I-Gate Round 2 Finding 1): `caller`
 * alone let a replacement reach `startup_ready` -- and so `takeover_complete`
 * -- without ever having consumed the checkpoint. `reconciliation` is the
 * replacement's own receipt, required to exactly echo this handoff's own
 * `checkpointDigest`/`observedGeneration`, the same "bound to the exact
 * values on record, not the live ones" discipline `submitDecision`'s
 * `GOVERNED_WRAP_STALE` check already applies to a governed-wrap decision.
 * @param {string} handoffId
 * @param {{kind: string, sessionId?: number, launchId?: string}} caller - The verified caller
 *   identity the route layer already proved (`sharedDocsAccess.resolveAccess`).
 * @param {{checkpointDigest: string, generation: number|null}} reconciliation - Must name the EXACT
 *   `checkpointDigest` and `observedGeneration` this handoff recorded.
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function reconcileStartup(handoffId, caller, reconciliation) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  const bad = _checkTransition(row, STATES.STARTUP_READY) || _requireLiveGeneration(row);
  if (bad) return bad;
  if (!_isReplacementCaller(row, caller)) {
    return _refuse('LIFECYCLE_HANDOFF_NOT_REPLACEMENT',
      'Only the handoff\'s own replacement session (or the operator) may reconcile its startup.');
  }
  const sequence = row.replacement_session_id ? store.launchSequences.getBySession(row.replacement_session_id) : null;
  if (!sequence || !sequence.readyAt) {
    return _refuse('LIFECYCLE_HANDOFF_STARTUP_NOT_READY', 'The replacement has not yet attested READY.');
  }
  const r = reconciliation || {};
  if (r.checkpointDigest !== row.checkpoint_digest || r.generation !== row.observed_generation) {
    return _refuse('LIFECYCLE_HANDOFF_CHECKPOINT_NOT_RECONCILED',
      'reconciliation.checkpointDigest and reconciliation.generation must exactly echo this handoff\'s own '
        + 'checkpointDigest and observedGeneration -- read the checkpoint before attesting reconciliation.',
      { checkpointDigest: row.checkpoint_digest, observedGeneration: row.observed_generation });
  }
  _db().prepare('UPDATE lifecycle_handoffs SET reconciled_digest = ?, reconciled_generation = ?, updated_at = ? WHERE handoff_id = ?')
    .run(r.checkpointDigest, r.generation, _internal.now(), handoffId);
  _advance(handoffId, STATES.STARTUP_READY);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Step 8-9: the one transition into the terminal `takeover_complete` state
 * -- the replacement's own takeover receipt and the delegate's release, as
 * one atomic write. The caller must genuinely BE the replacement (or the
 * operator), the same proof {@link reconcileStartup} requires (PRR-B I-Gate
 * Round 1 Finding 4) -- a delegate route call alone was never that receipt.
 * Also requires {@link reconcileStartup}'s own checkpoint receipt to be on
 * record (PRR-B I-Gate Round 2 Finding 1 names both transitions) -- in
 * practice always true by the time `startup_ready` is reached, since that
 * is the one way to reach it, but checked here directly rather than trusted
 * transitively through the state machine.
 * @param {string} handoffId
 * @param {{kind: string, sessionId?: number, launchId?: string}} caller - As {@link reconcileStartup}.
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function recordTakeover(handoffId, caller) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  const bad = _checkTransition(row, STATES.TAKEOVER_COMPLETE) || _requireLiveGeneration(row);
  if (bad) return bad;
  if (!_isReplacementCaller(row, caller)) {
    return _refuse('LIFECYCLE_HANDOFF_NOT_REPLACEMENT',
      'Only the handoff\'s own replacement session (or the operator) may record its takeover.');
  }
  if (row.reconciled_digest !== row.checkpoint_digest || row.reconciled_generation !== row.observed_generation) {
    return _refuse('LIFECYCLE_HANDOFF_CHECKPOINT_NOT_RECONCILED',
      'This handoff has no valid checkpoint reconciliation receipt on record yet; reconcile startup first.');
  }
  _advance(handoffId, STATES.TAKEOVER_COMPLETE);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Fail closed from any non-terminal state, with a typed blocker. The
 * checkpoint is NEVER cleared.
 * @param {string} handoffId
 * @param {{code: string, detail?: string}} input
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function recordBlocker(handoffId, input) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  if (!OPEN_STATES.includes(row.state)) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID_TRANSITION', `Handoff "${handoffId}" is already "${row.state}".`, { state: row.state });
  }
  const { code, detail } = input || {};
  if (typeof code !== 'string' || !code) return _refuse('LIFECYCLE_HANDOFF_INVALID', 'code is required.');
  const now = _internal.now();
  _db().prepare('UPDATE lifecycle_handoffs SET state = ?, blocker_code = ?, blocker_detail = ?, updated_at = ? WHERE handoff_id = ?')
    .run(STATES.FAILED, code, typeof detail === 'string' ? detail.slice(0, 2000) : null, now, handoffId);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Withdraw an open handoff before takeover. The checkpoint is NEVER cleared.
 * @param {string} handoffId
 * @param {string} [reason]
 * @returns {{ok: true, handoff: object}|{ok: false, code: string, message: string}}
 */
function cancelHandoff(handoffId, reason) {
  const row = _load(handoffId);
  if (!row) return _refuse('NOT_FOUND', `No lifecycle handoff "${handoffId}".`);
  if (!OPEN_STATES.includes(row.state)) {
    return _refuse('LIFECYCLE_HANDOFF_INVALID_TRANSITION', `Handoff "${handoffId}" is already "${row.state}".`, { state: row.state });
  }
  const now = _internal.now();
  _db().prepare('UPDATE lifecycle_handoffs SET state = ?, cancel_reason = ?, updated_at = ? WHERE handoff_id = ?')
    .run(STATES.CANCELLED, typeof reason === 'string' && reason ? reason.slice(0, 500) : null, now, handoffId);
  return { ok: true, handoff: _view(_load(handoffId)) };
}

/**
 * Move a handoff to a new state. Caller has already validated the
 * transition; this is the one write path.
 * @param {string} handoffId
 * @param {string} toState
 * @returns {void}
 */
function _advance(handoffId, toState) {
  _db().prepare('UPDATE lifecycle_handoffs SET state = ?, updated_at = ? WHERE handoff_id = ?').run(toState, _internal.now(), handoffId);
}

/**
 * One handoff by id.
 * @param {string} handoffId
 * @returns {object|null}
 */
function getHandoff(handoffId) {
  const row = _load(handoffId);
  return row ? _view(row) : null;
}

/**
 * The open (non-terminal) handoff for a project, if any.
 * @param {number} projectId
 * @returns {object|null}
 */
function getOpenForProject(projectId) {
  const row = _db().prepare(
    `SELECT * FROM lifecycle_handoffs WHERE project_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`
  ).get(projectId, ...OPEN_STATES);
  return row ? _view(row) : null;
}

module.exports = {
  STATES,
  TRANSITION_TYPES,
  BLOCKER_CODES,
  ensureLifecycleHandoffSchema,
  createHandoff,
  recordWrapInitiated,
  recordTerminalConfirmed,
  launchReplacement,
  reconcileStartup,
  recordTakeover,
  recordBlocker,
  cancelHandoff,
  getHandoff,
  getOpenForProject,
  _internal
};
