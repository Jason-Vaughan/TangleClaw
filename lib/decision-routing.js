'use strict';

/**
 * Durable interactive decision requests (#2037, v5.57.0 Wave 1 Car 57-D).
 *
 * Self-contained, same shape as `lib/permission-requests.js`: this module owns
 * its own storage via `ensureDecisionSchema`, applied additively
 * (`CREATE TABLE IF NOT EXISTS`) on `store.getDb()` — it never touches
 * `lib/store/_schema.js`, so there is no startup wiring to add there.
 *
 * Scope boundary (recorded in `.prawduct/artifacts/build-plan.md`, flagged in
 * the PR body): this car builds the durable record and its CRUD/answer
 * routes only. Detecting a native structured prompt in an engine's pane,
 * pushing the decision through Medusa/Discord, resuming the paused session,
 * and timed auto-escalation are other Wave 1 cars' work — the issue's own
 * "Routing and resume" section spans all of them, this file spans none.
 *
 * Authority enforcement is deliberately narrower than the issue's full
 * role-based policy: this repo has no mechanism today that resolves "is this
 * caller the Architect/PM for this project" (Medusa workspace ids like
 * `tc-lane-arc-...` are a naming convention, never authenticated as a role).
 * So `human`/`architect`/`pm`/`role-based` decisions are Operator-only — the
 * safe default, since nothing here lets an unverified caller claim a role —
 * and only `autonomous-within-lease` lets the requesting project's own
 * current verified launch answer itself, gated additionally on `reversible`
 * and the project's configured allowlist.
 *
 * @module lib/decision-routing
 */

const crypto = require('node:crypto');
const store = require('./store');
const projectConfig = require('./project-config');
const sharedDocsAccess = require('./shared-docs-access');
const { route, jsonResponse, errorResponse } = require('./routes/_kernel');
const { _requireOperatorWrite, coordinatorGateRefused } = require('./routes/_callers');

/** Every state a decision request may be in. */
const STATES = Object.freeze({
  WAITING_DECISION: 'waiting_decision',
  ANSWERED: 'answered',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded'
});

/** States a decision can no longer be answered from. */
const TERMINAL_STATES = Object.freeze([STATES.ANSWERED, STATES.EXPIRED, STATES.SUPERSEDED]);

/** The authority classes the issue names; who may actually answer each is in the module docstring. */
const AUTHORITY_CLASSES = Object.freeze(['human', 'architect', 'pm', 'role-based', 'autonomous-within-lease']);

/** Who answered, as `answered_by_surface` restricts it. */
const ANSWER_SURFACES = Object.freeze(['operator', 'autonomous-lease']);

/** What to do next, named once per failure code so every caller gives the same answer. */
const RECOVERY = Object.freeze({
  DECISION_REQUEST_EXPIRED: 'this decision expired before it was answered; ask a new decision request',
  DECISION_LAUNCH_SUPERSEDED: 'the requesting session is no longer current; ask a new decision request from the live session'
});

/** Seams for tests: the clock and the id source. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `dec_${crypto.randomBytes(12).toString('hex')}`
};

/**
 * A refusal, in the one shape every write and read answers with.
 * @param {string} code - One of this module's named failure codes
 * @param {string} message - What was refused and why, for a person
 * @param {object} [extra] - Further fields for the caller (e.g. `request`)
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, recovery: RECOVERY[code] || null, ...(extra || {}) };
}

/**
 * The DDL for both tables. Purely additive (`IF NOT EXISTS` throughout) —
 * safe to run on every call, so {@link ensureDecisionSchema} never needs to
 * know whether it already ran.
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS decision_requests (
      decision_id       TEXT    PRIMARY KEY CHECK (length(decision_id) BETWEEN 1 AND 64),
      idem_key          TEXT    NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 128),
      project_id        INTEGER NOT NULL,
      session_id        INTEGER NOT NULL,
      launch_id         TEXT    NOT NULL CHECK (length(launch_id) BETWEEN 1 AND 128),
      head_sha          TEXT    CHECK (head_sha IS NULL OR length(head_sha) <= 64),
      prompt            TEXT    NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
      choices_json      TEXT    NOT NULL CHECK (length(choices_json) BETWEEN 1 AND 4000),
      recommendation    TEXT    CHECK (recommendation IS NULL OR length(recommendation) <= 2000),
      prompt_digest     TEXT    NOT NULL CHECK (length(prompt_digest) = 64),
      required_authority TEXT  NOT NULL CHECK (required_authority IN ('human','architect','pm','role-based','autonomous-within-lease')),
      gate              TEXT    NOT NULL CHECK (length(gate) BETWEEN 1 AND 100),
      reversible        INTEGER NOT NULL CHECK (reversible IN (0, 1)),
      state             TEXT    NOT NULL DEFAULT 'waiting_decision'
                                 CHECK (state IN ('waiting_decision','answered','expired','superseded')),
      deadline_at       TEXT    NOT NULL,
      answered_at       TEXT,
      answered_by_surface TEXT  CHECK (answered_by_surface IS NULL OR answered_by_surface IN ('operator','autonomous-lease')),
      answered_by_actor TEXT    CHECK (answered_by_actor IS NULL OR length(answered_by_actor) <= 200),
      answer            TEXT    CHECK (answer IS NULL OR length(answer) <= 500),
      audit_rationale   TEXT    CHECK (audit_rationale IS NULL OR length(audit_rationale) <= 2000),
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      -- A request is "decided" exactly when it carries an answer; expiry and
      -- supersession are not decisions, so neither sets answered_at.
      CHECK ((state = 'answered') = (answered_at IS NOT NULL)),
      CHECK ((state = 'answered') = (answered_by_surface IS NOT NULL)),
      UNIQUE (project_id, idem_key)
    );

    CREATE INDEX IF NOT EXISTS idx_decision_requests_session
      ON decision_requests(session_id, state);

    CREATE INDEX IF NOT EXISTS idx_decision_requests_project
      ON decision_requests(project_id, state);

    CREATE TABLE IF NOT EXISTS decision_request_events (
      event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT    NOT NULL CHECK (length(decision_id) <= 64),
      kind        TEXT    NOT NULL CHECK (kind IN ('created','answered','expired','superseded')),
      surface     TEXT    CHECK (surface IS NULL OR surface IN ('operator','autonomous-lease')),
      actor       TEXT    CHECK (actor IS NULL OR length(actor) <= 200),
      detail      TEXT,
      recorded_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_decision_request_events_decision
      ON decision_request_events(decision_id, recorded_at);
  `;
}

/** Whether `ensureDecisionSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureDecisionSchema(db) {
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
  ensureDecisionSchema(db);
  return db;
}

/**
 * Map a raw row to the shape this module hands callers.
 * @param {object} row - Raw `decision_requests` row
 * @returns {object}
 */
function _rowToRequest(row) {
  return {
    decisionId: row.decision_id,
    idemKey: row.idem_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    launchId: row.launch_id,
    headSha: row.head_sha,
    prompt: row.prompt,
    choices: JSON.parse(row.choices_json),
    recommendation: row.recommendation,
    promptDigest: row.prompt_digest,
    requiredAuthority: row.required_authority,
    gate: row.gate,
    reversible: Boolean(row.reversible),
    state: row.state,
    deadlineAt: row.deadline_at,
    isOverdue: row.state === STATES.WAITING_DECISION && row.deadline_at <= _internal.now(),
    answeredAt: row.answered_at,
    answeredBySurface: row.answered_by_surface,
    answeredByActor: row.answered_by_actor,
    answer: row.answer,
    auditRationale: row.audit_rationale,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Record one line of a decision's history. Never fails closed on its own
 * account — an event is a record of what already happened, not a gate.
 * @param {object} db - Open database handle
 * @param {string} decisionId
 * @param {string} kind - One of `decision_request_events.kind`'s values
 * @param {{surface?: string, actor?: string, detail?: string}} [fields]
 * @returns {void}
 */
function _recordEvent(db, decisionId, kind, fields = {}) {
  db.prepare(
    `INSERT INTO decision_request_events (decision_id, kind, surface, actor, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(decisionId, kind, fields.surface || null, fields.actor || null, fields.detail || null, _internal.now());
}

/**
 * The SHA-256 hex digest of a prompt bound to its exact choice set, so an
 * answer cannot apply to a newer prompt that reuses the same decision id in
 * spirit but changed its text or choices.
 * @param {string} prompt
 * @param {string[]} choices
 * @returns {string}
 */
function _promptDigest(prompt, choices) {
  return crypto.createHash('sha256').update(`${prompt}\u0000${JSON.stringify(choices)}`).digest('hex');
}

/**
 * Whether `(projectId, sessionId, launchId)` is still the project's live
 * launch. Mirrors `lib/permission-requests.js`'s `_isLaunchCurrent`.
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
 * Apply this decision's lazy fail-closed transitions against the current
 * time and launch state, persisting whichever one fires. A no-op on a row
 * already terminal, or one still live. Mirrors
 * `lib/permission-requests.js`'s `_evaluate`.
 * @param {object} db - Open database handle
 * @param {object} row - Raw `decision_requests` row
 * @returns {object} The row, raw, after any transition this call applied
 */
function _evaluate(db, row) {
  if (row.state !== STATES.WAITING_DECISION) return row;
  const now = _internal.now();
  if (row.deadline_at <= now) {
    db.prepare('UPDATE decision_requests SET state = ?, updated_at = ? WHERE decision_id = ?')
      .run(STATES.EXPIRED, now, row.decision_id);
    _recordEvent(db, row.decision_id, 'expired');
    return { ...row, state: STATES.EXPIRED, updated_at: now };
  }
  if (!_isLaunchCurrent({ projectId: row.project_id, sessionId: row.session_id, launchId: row.launch_id })) {
    db.prepare('UPDATE decision_requests SET state = ?, updated_at = ? WHERE decision_id = ?')
      .run(STATES.SUPERSEDED, now, row.decision_id);
    _recordEvent(db, row.decision_id, 'superseded');
    return { ...row, state: STATES.SUPERSEDED, updated_at: now };
  }
  return row;
}

/**
 * Create a durable decision request.
 * @param {object} input
 * @param {string} input.idemKey - Caller-supplied idempotency key, unique per project
 * @param {number} input.projectId
 * @param {number} input.sessionId
 * @param {string} input.launchId - Must belong to a VERIFIED project launch; this module trusts the caller already checked that
 * @param {string} [input.headSha] - The exact HEAD the prompt was raised against, when applicable
 * @param {string} input.prompt - The exact prompt text
 * @param {string[]} input.choices - The exact choices offered
 * @param {string} [input.recommendation] - A recommendation/rationale, if the prompt supplied one
 * @param {string} input.requiredAuthority - One of {@link AUTHORITY_CLASSES}
 * @param {string} input.gate - Which allowlist-checked gate this decision is, for the autonomous-within-lease path
 * @param {boolean} [input.reversible] - Whether this choice is reversible (required for autonomous-within-lease)
 * @param {number} input.ttlMs - How long the request stays live before it expires
 * @returns {{ok: true, request: object}|{ok: false, code: string, message: string}}
 */
function createDecisionRequest(input) {
  const db = _db();
  for (const field of ['idemKey', 'projectId', 'sessionId', 'launchId', 'prompt', 'choices', 'requiredAuthority', 'gate', 'ttlMs']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return _refuse('DECISION_REQUEST_INVALID', `Missing required field "${field}".`);
    }
  }
  for (const field of ['idemKey', 'prompt', 'gate']) {
    if (typeof input[field] !== 'string') {
      return _refuse('DECISION_REQUEST_INVALID', `Field "${field}" must be a string.`);
    }
  }
  if (!Array.isArray(input.choices) || input.choices.length < 2 || !input.choices.every((c) => typeof c === 'string' && c.length > 0)) {
    return _refuse('DECISION_REQUEST_INVALID', 'Field "choices" must be an array of at least two non-empty strings.');
  }
  if (!AUTHORITY_CLASSES.includes(input.requiredAuthority)) {
    return _refuse('DECISION_REQUEST_INVALID', `"${input.requiredAuthority}" is not an authority class this module accepts.`);
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return _refuse('DECISION_REQUEST_INVALID', 'Field "ttlMs" must be a positive number.');
  }

  const existing = db.prepare('SELECT * FROM decision_requests WHERE project_id = ? AND idem_key = ?')
    .get(input.projectId, input.idemKey);
  if (existing) return { ok: true, request: _rowToRequest(_evaluate(db, existing)), replay: true };

  const now = _internal.now();
  const decisionId = _internal.id();
  const deadlineAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
  const promptDigest = _promptDigest(input.prompt, input.choices);
  db.prepare(
    `INSERT INTO decision_requests
       (decision_id, idem_key, project_id, session_id, launch_id, head_sha, prompt, choices_json,
        recommendation, prompt_digest, required_authority, gate, reversible, state, deadline_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    decisionId, input.idemKey, input.projectId, input.sessionId, input.launchId, input.headSha || null,
    input.prompt, JSON.stringify(input.choices), input.recommendation || null, promptDigest,
    input.requiredAuthority, input.gate, input.reversible ? 1 : 0, STATES.WAITING_DECISION, deadlineAt, now, now
  );
  _recordEvent(db, decisionId, 'created');
  return { ok: true, request: _rowToRequest(db.prepare('SELECT * FROM decision_requests WHERE decision_id = ?').get(decisionId)) };
}

/**
 * Whether the project's configured `decisionAutonomousAllowlist` names this
 * decision's `gate`, per `lib/project-config.js#resolveDecisionAutonomousAllowlist`.
 * @param {object} projectRow - A `store.projects` row (carries `path`)
 * @param {string} gate
 * @returns {boolean}
 */
function _gateIsAllowlisted(projectRow, gate) {
  const config = projectConfig.load(projectRow.path);
  const allowlist = resolveDecisionAutonomousAllowlist(config);
  return allowlist.includes(gate);
}

/**
 * The project's configured autonomous-within-lease gate allowlist, validated
 * and defaulted. Colocated here rather than in `lib/project-config.js` itself,
 * matching `lib/wrap-steps/pr-merge.js#resolveWrapMergeMethod`'s
 * consuming-module convention.
 * @param {object} config - As `projectConfig.load` returns
 * @returns {string[]}
 */
function resolveDecisionAutonomousAllowlist(config) {
  const raw = config && config.decisionAutonomousAllowlist;
  if (!Array.isArray(raw)) return [];
  return raw.filter((g) => typeof g === 'string' && g.length > 0);
}

/**
 * The state-transition primitive the answer routes call once they have
 * each proven, in their own way, who is answering. This function does not
 * itself check identity — it enforces only what every surface must agree on
 * regardless: the request is live, the prompt digest matches exactly (an
 * answer cannot apply to a newer prompt), a replay of the same answer is a
 * no-op, and a conflicting answer (or any answer once the request is no
 * longer waiting) fails closed.
 * @param {string} decisionId
 * @param {object} answer
 * @param {string} answer.answer - The chosen answer, must be one of the request's own `choices`
 * @param {string} answer.answeredBySurface - `'operator'` or `'autonomous-lease'`
 * @param {string} answer.answeredByActor - Who answered, for the record
 * @param {string} answer.expectedPromptDigest - Must match the request's own `promptDigest`
 * @param {string} [answer.auditRationale] - Why this answer, for the audit trail
 * @returns {{ok: true, request: object, replay?: true}|{ok: false, code: string, message: string, request?: object}}
 */
function answerDecisionRequest(decisionId, answer) {
  const db = _db();
  const row = db.prepare('SELECT * FROM decision_requests WHERE decision_id = ?').get(decisionId);
  if (!row) return _refuse('DECISION_REQUEST_NOT_FOUND', `No decision request "${decisionId}".`);
  if (!ANSWER_SURFACES.includes(answer.answeredBySurface)) {
    return _refuse('DECISION_ANSWER_INVALID', `"${answer.answeredBySurface}" is not a surface this module accepts.`);
  }
  if (typeof answer.answer !== 'string' || answer.answer.length === 0) {
    return _refuse('DECISION_ANSWER_INVALID', 'Field "answer" must be a non-empty string.');
  }
  const evaluated = _evaluate(db, row);
  if (evaluated.state === STATES.EXPIRED) {
    return _refuse('DECISION_REQUEST_EXPIRED', 'This decision request expired before it was answered.', { request: _rowToRequest(evaluated) });
  }
  if (evaluated.state === STATES.SUPERSEDED) {
    return _refuse('DECISION_LAUNCH_SUPERSEDED', 'The requesting session is no longer current; this decision request was superseded.', { request: _rowToRequest(evaluated) });
  }
  if (answer.expectedPromptDigest !== evaluated.prompt_digest) {
    return _refuse('DECISION_PROMPT_MISMATCH', 'The supplied prompt digest does not match this decision\'s own prompt.', { request: _rowToRequest(evaluated) });
  }
  const choices = JSON.parse(evaluated.choices_json);
  if (!choices.includes(answer.answer)) {
    return _refuse('DECISION_ANSWER_NOT_OFFERED', `"${answer.answer}" is not one of this decision's offered choices.`, { request: _rowToRequest(evaluated) });
  }
  if (TERMINAL_STATES.includes(evaluated.state)) {
    // Already answered. The exact same answer, by the same actor and
    // surface, is a replay — idempotent. Anything else is a conflict.
    const isReplay = evaluated.answer === answer.answer
      && evaluated.answered_by_surface === answer.answeredBySurface
      && evaluated.answered_by_actor === answer.answeredByActor;
    if (isReplay) return { ok: true, request: _rowToRequest(evaluated), replay: true };
    return _refuse('DECISION_ANSWER_CONFLICT', 'This decision request already carries a different answer.', { request: _rowToRequest(evaluated) });
  }

  const now = _internal.now();
  db.prepare(
    `UPDATE decision_requests
       SET state = ?, answered_at = ?, answered_by_surface = ?, answered_by_actor = ?, answer = ?,
           audit_rationale = ?, updated_at = ?
     WHERE decision_id = ?`
  ).run(
    STATES.ANSWERED, now, answer.answeredBySurface, answer.answeredByActor, answer.answer,
    answer.auditRationale || null, now, decisionId
  );
  _recordEvent(db, decisionId, 'answered', { surface: answer.answeredBySurface, actor: answer.answeredByActor, detail: answer.answer });
  return { ok: true, request: _rowToRequest(db.prepare('SELECT * FROM decision_requests WHERE decision_id = ?').get(decisionId)) };
}

/**
 * Read one decision request, applying its lazy expiry/supersession
 * transition first.
 * @param {string} decisionId
 * @returns {object|null}
 */
function getDecisionRequest(decisionId) {
  const db = _db();
  const row = db.prepare('SELECT * FROM decision_requests WHERE decision_id = ?').get(decisionId);
  return row ? _rowToRequest(_evaluate(db, row)) : null;
}

/**
 * List a session's decision requests, newest first, each evaluated before
 * being returned.
 * @param {number} sessionId
 * @param {{state?: string}} [options]
 * @returns {object[]}
 */
function listDecisionRequestsForSession(sessionId, options = {}) {
  const db = _db();
  const rows = db.prepare('SELECT * FROM decision_requests WHERE session_id = ? ORDER BY created_at DESC, decision_id DESC')
    .all(sessionId)
    .map((row) => _evaluate(db, row));
  const filtered = options.state ? rows.filter((row) => row.state === options.state) : rows;
  return filtered.map(_rowToRequest);
}

// ── HTTP routes ──
//
// Same create/list/read/decide shape as `lib/routes/sessions.js`'s
// permission-request routes, reusing `sharedDocsAccess` for who-is-asking and
// `lib/routes/_callers.js`'s `_requireOperatorWrite` for the Operator proof.

/**
 * Map an `{ok: false, code}` result to its HTTP status and write the response.
 * @param {http.ServerResponse} res
 * @param {object} result
 * @returns {void}
 */
function _respondDecisionResult(res, result) {
  if (result.ok) return jsonResponse(res, result.replay ? 200 : 201, result);
  const status = {
    DECISION_REQUEST_NOT_FOUND: 404,
    DECISION_REQUEST_EXPIRED: 409,
    DECISION_LAUNCH_SUPERSEDED: 409,
    DECISION_ANSWER_CONFLICT: 409,
    DECISION_PROMPT_MISMATCH: 409,
    DECISION_ANSWER_NOT_OFFERED: 400,
    DECISION_ANSWER_INVALID: 400,
    DECISION_REQUEST_INVALID: 400,
    DECISION_AUTONOMOUS_NOT_ALLOWLISTED: 403
  }[result.code] || 400;
  return errorResponse(res, status, result.message, result.code, { recovery: result.recovery, request: result.request });
}

/**
 * Whether this caller may read a decision request belonging to `projectId`:
 * the Operator, the Master, or that project's own verified launch.
 * @param {{kind: string, projectId: (number|null)}} access
 * @param {number} projectId
 * @returns {boolean}
 */
function _mayReadDecisionsFor(access, projectId) {
  return access.kind === sharedDocsAccess.KINDS.OPERATOR
    || access.kind === sharedDocsAccess.KINDS.MASTER
    || (access.kind === sharedDocsAccess.KINDS.PROJECT && access.projectId === projectId);
}

/**
 * Register this module's HTTP routes through the shared kernel. Takes no
 * arguments: everything the handlers need is required directly (same as
 * `lib/routes/launch-recovery.js`'s `register()`), so `server.js` mounts this
 * with a single call near the control routes.
 * @returns {void}
 */
function register() {
  // POST /api/sessions/:project/decisions — a verified project launch records
  // an interactive decision it is blocked on. Idempotent on (sessionId, launchId, body.requestId).
  route('POST', '/api/sessions/:project/decisions', (req, res, params, body) => {
    const project = store.projects.getByName(params.project);
    // #2032: a rotating coordinator asking for a decision on another lane's
    // behalf is new work handed to a pane that has not claimed the epoch yet
    // (same fence `lib/routes/sessions.js`'s permission-request create applies).
    if (project && coordinatorGateRefused(req, res, project.id, 'session-command')) return;
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (access.kind !== sharedDocsAccess.KINDS.PROJECT || access.projectId !== project.id) {
      return errorResponse(res, 403, 'Only a verified launch of this project may record a decision request.', 'FORBIDDEN');
    }
    const b = body && typeof body === 'object' ? body : {};
    if (!b.requestId || typeof b.requestId !== 'string') {
      return errorResponse(res, 400, 'requestId (an idempotency key) is required', 'BAD_REQUEST');
    }
    const result = createDecisionRequest({
      idemKey: `${access.sessionId}:${access.launchId}:${b.requestId}`,
      projectId: project.id,
      sessionId: access.sessionId,
      launchId: access.launchId,
      headSha: b.headSha,
      prompt: b.prompt,
      choices: b.choices,
      recommendation: b.recommendation,
      requiredAuthority: b.requiredAuthority,
      gate: b.gate,
      reversible: Boolean(b.reversible),
      ttlMs: b.ttlMs
    });
    _respondDecisionResult(res, result);
  });

  // GET /api/sessions/:project/decisions — session-scoped listing, for the
  // Operator, the Master, or this project's own verified launch (its own
  // current session only — mirrors the permission-request listing route).
  route('GET', '/api/sessions/:project/decisions', (req, res, params) => {
    const project = store.projects.getByName(params.project);
    if (!project) return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadDecisionsFor(access, project.id)) {
      return errorResponse(res, 403, 'Not permitted to read this project\'s decision requests.', 'FORBIDDEN');
    }
    const sessionIds = access.kind === sharedDocsAccess.KINDS.PROJECT
      ? [access.sessionId]
      : store.sessions.list(project.id, { limit: 100 }).map((s) => s.id);
    const requests = sessionIds
      .flatMap((sessionId) => listDecisionRequestsForSession(sessionId))
      .sort((a, b2) => (a.createdAt < b2.createdAt ? 1 : -1));
    jsonResponse(res, 200, { requests });
  });

  // GET /api/decisions/:decisionId — a single decision, for the Operator, the
  // Master, or the requesting project's own verified launch.
  route('GET', '/api/decisions/:decisionId', (req, res, params) => {
    const existing = getDecisionRequest(params.decisionId);
    if (!existing) return errorResponse(res, 404, `No decision request "${params.decisionId}"`, 'DECISION_REQUEST_NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    if (!_mayReadDecisionsFor(access, existing.projectId)) {
      return errorResponse(res, 403, 'Not permitted to read this decision request.', 'FORBIDDEN');
    }
    jsonResponse(res, 200, { request: existing });
  });

  // POST /api/decisions/:decisionId/answer — the Operator may always answer;
  // the requesting project's own current verified launch may answer ONLY a
  // `requiredAuthority: 'autonomous-within-lease'` decision whose `gate` is on
  // its project's configured allowlist and which was created `reversible`.
  // See the module docstring for why architect/pm/role-based are Operator-only.
  route('POST', '/api/decisions/:decisionId/answer', (req, res, params, body) => {
    const existing = getDecisionRequest(params.decisionId);
    if (!existing) return errorResponse(res, 404, `No decision request "${params.decisionId}"`, 'DECISION_REQUEST_NOT_FOUND');
    const access = sharedDocsAccess.resolveAccess(req);
    const b = body && typeof body === 'object' ? body : {};
    if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
      const proof = _requireOperatorWrite(req, res, {
        logEvent: 'Refused a decision answer',
        logContext: { decisionId: params.decisionId },
        fallbackAction: 'answer a decision request',
        sameOriginWhat: 'A decision answer',
        unauthenticated: 'Sign in to answer a decision request.',
        machineClient: 'A local process may not answer a decision request.',
        openToken: 'An open-install token is required to answer a decision request.',
        gateUnsupported: (gateState) => `Cannot answer a decision request while the login gate is "${gateState}".`
      });
      if (!proof) return;
      return _respondDecisionResult(res, answerDecisionRequest(params.decisionId, {
        answer: b.answer,
        answeredBySurface: 'operator',
        answeredByActor: proof.actor || 'operator',
        expectedPromptDigest: b.expectedPromptDigest,
        auditRationale: b.auditRationale
      }));
    }
    if (access.kind === sharedDocsAccess.KINDS.PROJECT && access.projectId === existing.projectId && access.sessionId === existing.sessionId) {
      if (existing.requiredAuthority !== 'autonomous-within-lease' || !existing.reversible) {
        return errorResponse(res, 403,
          'Only the Operator may answer this decision; it is not an explicitly allowlisted, reversible, autonomous-within-lease choice.',
          'FORBIDDEN');
      }
      const project = store.projects.get(existing.projectId);
      if (!project || !_gateIsAllowlisted(project, existing.gate)) {
        return _respondDecisionResult(res, _refuse('DECISION_AUTONOMOUS_NOT_ALLOWLISTED',
          `Gate "${existing.gate}" is not on this project's configured autonomous-within-lease allowlist.`));
      }
      return _respondDecisionResult(res, answerDecisionRequest(params.decisionId, {
        answer: b.answer,
        answeredBySurface: 'autonomous-lease',
        answeredByActor: `project:${access.projectId}`,
        expectedPromptDigest: b.expectedPromptDigest,
        auditRationale: b.auditRationale
      }));
    }
    return errorResponse(res, 403, 'Not permitted to answer this decision request.', 'FORBIDDEN');
  });
}

module.exports = {
  STATES,
  AUTHORITY_CLASSES,
  ANSWER_SURFACES,
  ensureDecisionSchema,
  createDecisionRequest,
  answerDecisionRequest,
  getDecisionRequest,
  listDecisionRequestsForSession,
  resolveDecisionAutonomousAllowlist,
  register,
  _internal
};
