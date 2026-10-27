'use strict';

/**
 * Durable scoped permission requests and Operator grants (#2352, Architect
 * Ruling A475-W2C-TRUST "Durable Scoped Record & Launch/Expiry Fail-Closed").
 *
 * Self-contained: this module owns its own storage. `ensurePermissionSchema`
 * applies `permission_requests` and `permission_request_events` additively
 * via `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` on
 * `store.getDb()` — it never touches `lib/store/_schema.js` or `lib/store.js`,
 * so there is no startup wiring to add there. Every public function in this
 * module calls it first; the DDL is cheap and idempotent, so there is nothing
 * else to initialize.
 *
 * One request is one scope against one target — the ruling is explicit that a
 * request is never bundled. A request fails closed in two ways once it stops
 * being live: past its own `expires_at` it reads as `expired`
 * (`PERMISSION_REQUEST_EXPIRED`), and once the session that asked for it is no
 * longer its project's current launch it reads as `superseded`
 * (`PERMISSION_LAUNCH_SUPERSEDED`) — both transitions are applied lazily, on
 * the next read or decision, and persisted at that point.
 *
 * `decidePermissionRequest` is the one state-transition primitive both trust
 * boundaries call (#2352's Dashboard and Discord-bridge paths, Chunks 02/03):
 * it enforces replay-is-idempotent / conflict-is-409 and scope matching, but
 * it trusts its caller to have already proven who is deciding — proving that
 * is each trust boundary's own job, not this module's.
 *
 * @module lib/permission-requests
 */

const crypto = require('node:crypto');
const store = require('./store');

/** Every state a request may be in. */
const STATES = Object.freeze({
  PENDING: 'pending',
  GRANTED: 'granted',
  REFUSED: 'refused',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded'
});

/** States a decision can no longer be made from. */
const TERMINAL_STATES = Object.freeze([STATES.GRANTED, STATES.REFUSED, STATES.EXPIRED, STATES.SUPERSEDED]);

/** Who decided a request, as `decided_by_surface` restricts it. */
const DECISION_SURFACES = Object.freeze(['dashboard', 'discord-bridge']);

/** The two decisions a request can receive. */
const DECISIONS = Object.freeze(['grant', 'refuse']);

/** What `decide` turns a decision into, as the stored terminal state. */
const DECISION_TO_STATE = Object.freeze({ grant: STATES.GRANTED, refuse: STATES.REFUSED });

/** What to do next, named once per failure code so every caller gives the same answer. */
const RECOVERY = Object.freeze({
  PERMISSION_REQUEST_EXPIRED: 'this grant expired; ask for a new permission request',
  PERMISSION_LAUNCH_SUPERSEDED: 'the requesting session is no longer current; ask for a new permission request from the live session'
});

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `perm_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the one shape every write and read answers with.
 * @param {string} code - One of this module's named failure codes
 * @param {string} message - What was refused and why, for a person
 * @param {object} [extra] - Further fields for the caller (e.g. `request`, `recovery`)
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, recovery: RECOVERY[code] || null, ...(extra || {}) };
}

/**
 * The DDL for both tables. Purely additive (`IF NOT EXISTS` throughout) —
 * safe to run on every call, so {@link ensurePermissionSchema} never needs to
 * know whether it already ran.
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS permission_requests (
      request_id           TEXT    PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 64),
      idem_key              TEXT    NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 128),
      project_id            INTEGER NOT NULL,
      session_id            INTEGER NOT NULL,
      launch_id             TEXT    NOT NULL CHECK (length(launch_id) BETWEEN 1 AND 128),
      scope                 TEXT    NOT NULL CHECK (length(scope) BETWEEN 1 AND 100),
      scope_target          TEXT    NOT NULL CHECK (length(scope_target) BETWEEN 1 AND 500),
      gate                  TEXT    NOT NULL CHECK (length(gate) BETWEEN 1 AND 100),
      action_summary        TEXT    NOT NULL CHECK (length(action_summary) BETWEEN 1 AND 2000),
      expected_answer       TEXT    CHECK (expected_answer IS NULL OR length(expected_answer) <= 500),
      state                 TEXT    NOT NULL DEFAULT 'pending'
                                     CHECK (state IN ('pending','granted','refused','expired','superseded')),
      expires_at            TEXT    NOT NULL,
      decided_at            TEXT,
      decided_by_surface    TEXT    CHECK (decided_by_surface IS NULL OR decided_by_surface IN ('dashboard','discord-bridge')),
      decided_by_actor      TEXT    CHECK (decided_by_actor IS NULL OR length(decided_by_actor) <= 200),
      decision_proof        TEXT,
      receipt_delivered_at  TEXT,
      created_at            TEXT    NOT NULL,
      updated_at            TEXT    NOT NULL,
      -- A request is "decided" exactly when it carries a decision; expiry and
      -- supersession are not decisions, so neither sets decided_at.
      CHECK ((state IN ('granted','refused')) = (decided_at IS NOT NULL)),
      CHECK ((state IN ('granted','refused')) = (decided_by_surface IS NOT NULL)),
      UNIQUE (project_id, idem_key)
    );

    CREATE INDEX IF NOT EXISTS idx_permission_requests_session
      ON permission_requests(session_id, state);

    CREATE INDEX IF NOT EXISTS idx_permission_requests_project
      ON permission_requests(project_id, state);

    CREATE TABLE IF NOT EXISTS permission_request_events (
      event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  TEXT    NOT NULL CHECK (length(request_id) <= 64),
      kind        TEXT    NOT NULL CHECK (kind IN ('created','decided','expired','superseded','receipt-delivered')),
      surface     TEXT    CHECK (surface IS NULL OR surface IN ('dashboard','discord-bridge')),
      actor       TEXT    CHECK (actor IS NULL OR length(actor) <= 200),
      detail      TEXT,
      recorded_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_permission_request_events_request
      ON permission_request_events(request_id, recorded_at);
  `;
}

/** Whether `ensurePermissionSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point — a `db` already initialized is a no-op after the
 * first call, and even a cold one costs only `CREATE ... IF NOT EXISTS`.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensurePermissionSchema(db) {
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
  ensurePermissionSchema(db);
  return db;
}

/**
 * Map a raw row to the shape this module hands callers.
 * @param {object} row - Raw `permission_requests` row
 * @returns {object}
 */
function _rowToRequest(row) {
  return {
    requestId: row.request_id,
    idemKey: row.idem_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    launchId: row.launch_id,
    scope: row.scope,
    scopeTarget: row.scope_target,
    gate: row.gate,
    actionSummary: row.action_summary,
    expectedAnswer: row.expected_answer,
    state: row.state,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBySurface: row.decided_by_surface,
    decidedByActor: row.decided_by_actor,
    decisionProof: row.decision_proof,
    receiptDeliveredAt: row.receipt_delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Record one line of a request's history. Never fails closed on its own
 * account — an event is a record of what already happened, not a gate.
 * @param {object} db - Open database handle
 * @param {string} requestId - The request this event is about
 * @param {string} kind - One of `permission_request_events.kind`'s values
 * @param {{surface?: string, actor?: string, detail?: string}} [fields]
 * @returns {void}
 */
function _recordEvent(db, requestId, kind, fields = {}) {
  db.prepare(
    `INSERT INTO permission_request_events (request_id, kind, surface, actor, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(requestId, kind, fields.surface || null, fields.actor || null, fields.detail || null, _internal.now());
}

/**
 * Whether `(projectId, sessionId, launchId)` is still the project's live
 * launch: the launch id resolves to a launch sequence bound to that same
 * session, and that session is still the project's current (active) one.
 * Mirrors the check `lib/launch-binding-guard.js` makes for mutating routes,
 * reusing the same two store lookups rather than a second implementation of
 * "is this launch still current".
 * @param {{projectId: number, sessionId: number, launchId: string}} binding
 * @returns {boolean}
 */
function _isLaunchCurrent({ projectId, sessionId, launchId }) {
  const sequence = store.launchSequences.getByLaunchId(launchId);
  if (!sequence || sequence.sessionId !== sessionId) return false;
  const current = store.sessions.getActive(projectId);
  return Boolean(current) && current.id === sessionId;
}

/**
 * Apply this request's lazy fail-closed transitions against the current
 * time and launch state, persisting whichever one fires. A no-op on a row
 * already in a terminal state, or one still live.
 *
 * Checked in this order: expiry first (a pure time comparison), then
 * supersession (needs a store lookup) — matching the order the Architect
 * Ruling names them in. A row can only ever earn one of the two: once either
 * fires the row is terminal, so the other check never runs against it again.
 * @param {object} db - Open database handle
 * @param {object} row - Raw `permission_requests` row
 * @returns {object} The row, raw, after any transition this call applied
 */
function _evaluate(db, row) {
  if (row.state !== STATES.PENDING) return row;
  const now = _internal.now();
  if (row.expires_at <= now) {
    db.prepare('UPDATE permission_requests SET state = ?, updated_at = ? WHERE request_id = ?')
      .run(STATES.EXPIRED, now, row.request_id);
    _recordEvent(db, row.request_id, 'expired');
    return { ...row, state: STATES.EXPIRED, updated_at: now };
  }
  if (!_isLaunchCurrent({ projectId: row.project_id, sessionId: row.session_id, launchId: row.launch_id })) {
    db.prepare('UPDATE permission_requests SET state = ?, updated_at = ? WHERE request_id = ?')
      .run(STATES.SUPERSEDED, now, row.request_id);
    _recordEvent(db, row.request_id, 'superseded');
    return { ...row, state: STATES.SUPERSEDED, updated_at: now };
  }
  return row;
}

/**
 * Create a durable permission request. One scope against one target — never
 * bundled, per the Architect Ruling.
 * @param {object} input
 * @param {string} input.idemKey - Caller-supplied idempotency key, unique per project
 * @param {number} input.projectId
 * @param {number} input.sessionId
 * @param {string} input.launchId - Must belong to a VERIFIED project launch; this module trusts the caller already checked that
 * @param {string} input.scope - A single scope name
 * @param {string} input.scopeTarget - What that scope applies to
 * @param {string} input.gate - Which gate is asking
 * @param {string} input.actionSummary - What will happen if granted, for a person
 * @param {string} [input.expectedAnswer] - What answer the asker expects
 * @param {number} input.ttlMs - How long the request stays live before it expires
 * @returns {{ok: true, request: object}|{ok: false, code: string, message: string}}
 */
function createPermissionRequest(input) {
  const db = _db();
  if (Array.isArray(input.scope) || Array.isArray(input.scopeTarget)) {
    return _refuse('PERMISSION_SCOPE_BUNDLED', 'A permission request names exactly one scope and one target; it cannot bundle several.');
  }
  for (const field of ['idemKey', 'projectId', 'sessionId', 'launchId', 'scope', 'scopeTarget', 'gate', 'actionSummary', 'ttlMs']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return _refuse('PERMISSION_REQUEST_INVALID', `Missing required field "${field}".`);
    }
  }
  const existing = db.prepare('SELECT * FROM permission_requests WHERE project_id = ? AND idem_key = ?')
    .get(input.projectId, input.idemKey);
  if (existing) return { ok: true, request: _rowToRequest(_evaluate(db, existing)), replay: true };

  const now = _internal.now();
  const requestId = _internal.id();
  const expiresAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
  db.prepare(
    `INSERT INTO permission_requests
       (request_id, idem_key, project_id, session_id, launch_id, scope, scope_target, gate,
        action_summary, expected_answer, state, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    requestId, input.idemKey, input.projectId, input.sessionId, input.launchId,
    input.scope, input.scopeTarget, input.gate, input.actionSummary, input.expectedAnswer || null,
    STATES.PENDING, expiresAt, now, now
  );
  _recordEvent(db, requestId, 'created');
  return { ok: true, request: _rowToRequest(db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId)) };
}

/**
 * The state-transition primitive both trust boundaries call once they have
 * each proven, in their own way, who is deciding. This function does not
 * itself check identity or provenance — it enforces only what every surface
 * must agree on regardless: the request is live, the decision is well-formed,
 * a replay of the same decision is a no-op, and a conflicting decision (or
 * any decision once the request is no longer pending) fails closed.
 * @param {string} requestId
 * @param {object} decision
 * @param {string} decision.decision - `'grant'` or `'refuse'`
 * @param {string} decision.decidedBySurface - `'dashboard'` or `'discord-bridge'`
 * @param {string} decision.decidedByActor - Who decided, for the record
 * @param {string} decision.decisionProof - Opaque proof material the caller already verified
 * @param {string} [decision.expectedScope] - When given, must match the request's own scope
 * @returns {{ok: true, request: object, replay?: true}|{ok: false, code: string, message: string, request?: object}}
 */
function decidePermissionRequest(requestId, decision) {
  const db = _db();
  const row = db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId);
  if (!row) return _refuse('PERMISSION_REQUEST_NOT_FOUND', `No permission request "${requestId}".`);
  if (!DECISIONS.includes(decision.decision)) {
    return _refuse('PERMISSION_DECISION_INVALID', `"${decision.decision}" is not a decision this module accepts.`);
  }
  if (!DECISION_SURFACES.includes(decision.decidedBySurface)) {
    return _refuse('PERMISSION_DECISION_INVALID', `"${decision.decidedBySurface}" is not a surface this module accepts.`);
  }
  const evaluated = _evaluate(db, row);
  if (evaluated.state === STATES.EXPIRED) {
    return _refuse('PERMISSION_REQUEST_EXPIRED', 'This permission request expired before it was decided.', { request: _rowToRequest(evaluated) });
  }
  if (evaluated.state === STATES.SUPERSEDED) {
    return _refuse('PERMISSION_LAUNCH_SUPERSEDED', 'The requesting session is no longer current; this permission request was superseded.', { request: _rowToRequest(evaluated) });
  }
  if (decision.expectedScope !== undefined && decision.expectedScope !== evaluated.scope) {
    return _refuse('PERMISSION_SCOPE_MISMATCH', `This request is scoped "${evaluated.scope}", not "${decision.expectedScope}".`, { request: _rowToRequest(evaluated) });
  }
  const targetState = DECISION_TO_STATE[decision.decision];
  if (TERMINAL_STATES.includes(evaluated.state)) {
    // Already decided. The exact same decision, by the same actor and
    // surface, is a replay — idempotent. Anything else is a conflict.
    const isReplay = evaluated.state === targetState
      && evaluated.decided_by_surface === decision.decidedBySurface
      && evaluated.decided_by_actor === decision.decidedByActor;
    if (isReplay) return { ok: true, request: _rowToRequest(evaluated), replay: true };
    return _refuse('PERMISSION_DECISION_CONFLICT', 'This permission request already carries a different decision.', { request: _rowToRequest(evaluated) });
  }

  const now = _internal.now();
  db.prepare(
    `UPDATE permission_requests
       SET state = ?, decided_at = ?, decided_by_surface = ?, decided_by_actor = ?, decision_proof = ?, updated_at = ?
     WHERE request_id = ?`
  ).run(targetState, now, decision.decidedBySurface, decision.decidedByActor, decision.decisionProof || null, now, requestId);
  _recordEvent(db, requestId, 'decided', { surface: decision.decidedBySurface, actor: decision.decidedByActor, detail: decision.decision });
  return { ok: true, request: _rowToRequest(db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId)) };
}

/**
 * Read one request, applying its lazy expiry/supersession transition first.
 * @param {string} requestId
 * @returns {object|null}
 */
function getPermissionRequest(requestId) {
  const db = _db();
  const row = db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId);
  return row ? _rowToRequest(_evaluate(db, row)) : null;
}

/**
 * List a session's requests, newest first, each evaluated before being
 * returned (so a listing never shows a stale `pending` past its own expiry).
 * @param {number} sessionId
 * @param {{state?: string}} [options]
 * @returns {object[]}
 */
function listPermissionRequestsForSession(sessionId, options = {}) {
  const db = _db();
  const rows = db.prepare('SELECT * FROM permission_requests WHERE session_id = ? ORDER BY created_at DESC, request_id DESC')
    .all(sessionId)
    .map((row) => _evaluate(db, row));
  const filtered = options.state ? rows.filter((row) => row.state === options.state) : rows;
  return filtered.map(_rowToRequest);
}

/**
 * Mark a request's receipt as delivered, once. Idempotent: a second call
 * after the first leaves `receiptDeliveredAt` at its original value and
 * reports `delivered: false` so the caller knows not to send a second notice.
 * @param {string} requestId
 * @returns {{ok: true, request: object, delivered: boolean}|{ok: false, code: string, message: string}}
 */
function markReceiptDelivered(requestId) {
  const db = _db();
  const row = db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId);
  if (!row) return _refuse('PERMISSION_REQUEST_NOT_FOUND', `No permission request "${requestId}".`);
  if (row.receipt_delivered_at) return { ok: true, request: _rowToRequest(row), delivered: false };
  const now = _internal.now();
  db.prepare('UPDATE permission_requests SET receipt_delivered_at = ?, updated_at = ? WHERE request_id = ?')
    .run(now, now, requestId);
  _recordEvent(db, requestId, 'receipt-delivered');
  return { ok: true, request: _rowToRequest(db.prepare('SELECT * FROM permission_requests WHERE request_id = ?').get(requestId)), delivered: true };
}

module.exports = {
  STATES,
  DECISION_SURFACES,
  DECISIONS,
  ensurePermissionSchema,
  createPermissionRequest,
  decidePermissionRequest,
  getPermissionRequest,
  listPermissionRequestsForSession,
  markReceiptDelivered,
  _internal
};
