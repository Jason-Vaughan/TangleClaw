'use strict';

/**
 * Governed background wrap (#2072 Slice 1, v5.58.0 Wave 2 Car 58-D,
 * Architect Ruling A2072).
 *
 * Self-contained, same shape as `lib/decision-routing.js`/`lib/chunk-boundary.js`:
 * this module owns its own storage via `ensureGovernedWrapSchema`, applied
 * additively (`CREATE TABLE IF NOT EXISTS`) on `store.getDb()` -- it never
 * touches `lib/store/_schema.js`.
 *
 * The problem (issue #2072's own words): normal session wrapping is a
 * manual drawer questionnaire with no reviewable decision receipt and no
 * safe path for a verified coordinator to supply the same choices the
 * drawer would have asked for, without re-deciding them through a human.
 * The existing deterministic pipeline (`lib/sessions.js#startWrap` ->
 * `lib/wrap-pipeline.js`) stays the only executor; this module is the
 * governed front door onto it.
 *
 * ## What this file is (Slice 1: Core Engine & Bulk File Policy)
 *
 * 1. A versioned orchestration request + preflight packet schema
 *    ({@link createPreflightRequest}), persisted so a decision can be
 *    revalidated against what was actually true when it was prepared.
 * 2. Decision validation ({@link submitDecision}): a decision names its own
 *    request and option-schema version and answers exactly `ready` or
 *    `needs-operator` -- never a free-form mutation.
 * 3. Target/head/preflight digest revalidation ({@link executeReadyRequest}):
 *    a decision built against a packet whose head sha or control state has
 *    since moved is refused as stale, not executed against facts that are
 *    no longer true.
 * 4. Duplicate-run prevention: one open (non-terminal) governed-wrap request
 *    per project at a time ({@link createPreflightRequest}); the underlying
 *    pipeline's own single-flight (`lib/wrap-run-registry.js`,
 *    `WRAP_IN_PROGRESS`) still guards the actual run.
 * 5. A server-side bulk file policy (`leave-all-preexisting` /
 *    `include-owned-only`) so a caller with hundreds of pre-existing dirty
 *    paths does not need a >10 KB per-path `pathDecisions` body (#2072
 *    comment 5). This maps onto the wrap pipeline's OWN existing
 *    `options.foreignPathDefault` (#2076/A466-G1, `lib/wrap-steps/
 *    session-files.js#_autoLeaveEnabled`) rather than reimplementing file
 *    classification here: `leave-all-preexisting` sets
 *    `foreignPathDefault: 'leave'` (auto-leave every dirty-at-launch foreign
 *    path the pipeline would otherwise ask about); `include-owned-only`
 *    sends no override at all, so only this session's own changes are
 *    auto-included and anything foreign still blocks for a real decision --
 *    the conservative pole of the same choice.
 *
 * ## Slice 2 (#2837): progress-stage helpers
 *
 * {@link formatWrapProgressEvent} and {@link createWrapProgressStream} give
 * this module's own callers the five coarse progress stages
 * ({@link PROGRESS_STAGES}) an observer cares about, framed as the same SSE
 * wire shape the plain wrap-run stream uses. Neither is wired to an HTTP
 * route yet -- that is `lib/routes/wrap.js`'s to do, out of this envelope --
 * so today they are called directly, e.g. from a test or an in-process tool.
 *
 * ## What this file is NOT (tracked as later slices, out of this envelope)
 *
 * - The actual HTTP route serving {@link createWrapProgressStream}, the
 *   browser Wrap-button UI's live wiring into the real dashboard page, and a
 *   server-enforced Master *capability* allowlist narrower than the
 *   existing `lib/master-authority.js` lifecycle gate (`#966`) -- the Master
 *   path here reuses that gate's `'wrap'` action exactly as the manual
 *   drawer's own `POST /wrap` route already does.
 * - Interactive per-file review (the drawer's own Include/Leave list):
 *   `include-owned-only` can still legitimately block on real foreign
 *   files; this module does not pre-classify or pre-answer them beyond the
 *   bulk policy above.
 * - A coordinator's own authority to request/decide is PROVEN by the route
 *   layer (`_requireSessionLifecycleCaller`, `action: 'wrap'`) BEFORE any
 *   function here is called -- the same gate the manual `POST /wrap` route
 *   already enforces, never a second, divergent authority check.
 *
 * @module lib/governed-wrap
 */

const crypto = require('node:crypto');
const store = require('./store');
const sessions = require('./sessions');
const { execFileArgs } = require('./exec');
const { WRAP_STREAM_EVENTS } = require('../public/wrap-stream-events');

/** This module's own schema version for the persisted request/packet shape. */
const OPTION_SCHEMA_VERSION = '1.0.0';

/** How long `git rev-parse HEAD` may run before the preflight read gives up. */
const GIT_TIMEOUT_MS = 10 * 1000;

/** How long a preflight request stays open awaiting a decision, by default. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** This request/decision lifecycle's own states. */
const STATES = Object.freeze({
  AWAITING_DECISION: 'awaiting_decision',
  READY: 'ready',
  NEEDS_OPERATOR: 'needs_operator',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  STALE: 'stale',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled'
});

/** States that still count as "open" for duplicate-run prevention. */
const OPEN_STATES = Object.freeze([STATES.AWAITING_DECISION, STATES.READY, STATES.NEEDS_OPERATOR, STATES.EXECUTING]);

/** The bulk file policy a decision may choose, mapped onto the pipeline's own `foreignPathDefault` (see module doc). */
const FILE_POLICIES = Object.freeze({
  LEAVE_ALL_PREEXISTING: 'leave-all-preexisting',
  INCLUDE_OWNED_ONLY: 'include-owned-only'
});

/**
 * The five stages an SSE progress observer sees (#2837, #2072 Slice 2) --
 * never this module's own storage states ({@link STATES}), which are an
 * audit trail of DECISIONS, not a progress bar, and never the underlying
 * wrap-run's own step-by-step detail (`lib/wrap-run-registry.js`'s
 * `run-start`/`step-start`/`step-done`/... ), which already has its own
 * fine-grained stream for the pipeline's own progress bar. This is the
 * coarser, governance-level view: has a decision been made, is the pipeline
 * actually running, did it finish.
 */
const PROGRESS_STAGES = Object.freeze({
  PREFLIGHT: 'preflight',
  DECISION_VALIDATED: 'decision-validated',
  PIPELINE_RUNNING: 'pipeline-running',
  COMPLETED: 'completed',
  FAILED: 'failed'
});

/** Every progress stage, for validating a value against the real set. */
const PROGRESS_STAGE_VALUES = Object.freeze(Object.values(PROGRESS_STAGES));

/** Stages a stream never moves on from once reached. */
const TERMINAL_PROGRESS_STAGES = Object.freeze([PROGRESS_STAGES.COMPLETED, PROGRESS_STAGES.FAILED]);

/**
 * The wrap-option keys a decision's `options` bag may set, named here so a
 * caller can discover the real surface rather than guessing -- the same
 * keys `lib/sessions.js#startWrap` documents (`skipTests`, `prHandling`,
 * `skipAiContent`, `bumpLevel`, `proceedPastStranded`, `keepSessionRunning`).
 * `pathDecisions`/`foreignPathDefault` are set by THIS module from the
 * decision's `filePolicy`, never accepted directly here.
 * @type {ReadonlyArray<string>}
 */
const DECIDABLE_OPTION_KEYS = Object.freeze([
  'skipTests', 'prHandling', 'skipAiContent', 'bumpLevel', 'proceedPastStranded', 'keepSessionRunning'
]);

/** Seams for tests: the clock, the id source and the git read. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `gwr_${crypto.randomBytes(12).toString('hex')}`,
  headSha: async (workTree) => {
    const res = await execFileArgs('git', ['rev-parse', 'HEAD'], { cwd: workTree, timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: 64 * 1024 });
    if (res.exitCode !== 0) return null;
    const sha = String(res.stdout || '').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }
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
    CREATE TABLE IF NOT EXISTS governed_wrap_requests (
      request_id          TEXT    PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 64),
      project_id           INTEGER NOT NULL,
      project_name         TEXT    NOT NULL CHECK (length(project_name) BETWEEN 1 AND 200),
      session_id           INTEGER,
      launch_id            TEXT    CHECK (launch_id IS NULL OR length(launch_id) <= 128),
      initiator_kind        TEXT   NOT NULL CHECK (initiator_kind IN ('operator','master','coordinator')),
      initiator_principal   TEXT   NOT NULL CHECK (length(initiator_principal) BETWEEN 1 AND 128),
      option_schema_version TEXT   NOT NULL CHECK (length(option_schema_version) <= 32),
      head_sha              TEXT   CHECK (head_sha IS NULL OR length(head_sha) = 40),
      control_state         TEXT   CHECK (control_state IS NULL OR length(control_state) <= 32),
      preflight_json        TEXT   NOT NULL CHECK (length(preflight_json) BETWEEN 1 AND 16000),
      preflight_digest       TEXT  NOT NULL CHECK (length(preflight_digest) = 64),
      state                 TEXT   NOT NULL DEFAULT 'awaiting_decision'
                                    CHECK (state IN ('awaiting_decision','ready','needs_operator','executing',
                                                      'completed','stale','expired','cancelled')),
      decision_json         TEXT   CHECK (decision_json IS NULL OR length(decision_json) <= 8000),
      decided_by_principal  TEXT   CHECK (decided_by_principal IS NULL OR length(decided_by_principal) <= 128),
      decided_at            TEXT,
      run_id                TEXT   CHECK (run_id IS NULL OR length(run_id) <= 128),
      cancel_reason         TEXT   CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
      expires_at            TEXT   NOT NULL,
      created_at            TEXT   NOT NULL,
      updated_at            TEXT   NOT NULL
    );

    -- Duplicate-run prevention: at most one OPEN (non-terminal) request per
    -- project. A terminal row (completed/stale/expired/cancelled) no longer
    -- occupies the key, the same partial-unique pattern #1889's receipts use.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_wrap_requests_open_unique
      ON governed_wrap_requests(project_id)
      WHERE state IN ('awaiting_decision','ready','needs_operator','executing');

    CREATE INDEX IF NOT EXISTS idx_governed_wrap_requests_project
      ON governed_wrap_requests(project_id, created_at);
  `;
}

/** Whether `ensureGovernedWrapSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureGovernedWrapSchema(db) {
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
  ensureGovernedWrapSchema(db);
  return db;
}

/**
 * One row, as the public shape callers read (camelCase, parsed JSON).
 * @param {object} row - Raw row
 * @returns {object}
 */
function _view(row) {
  return {
    requestId: row.request_id,
    projectId: row.project_id,
    projectName: row.project_name,
    sessionId: row.session_id,
    launchId: row.launch_id,
    initiator: { kind: row.initiator_kind, principal: row.initiator_principal },
    optionSchemaVersion: row.option_schema_version,
    preflight: JSON.parse(row.preflight_json),
    preflightDigest: row.preflight_digest,
    state: row.state,
    decision: row.decision_json ? JSON.parse(row.decision_json) : null,
    decidedByPrincipal: row.decided_by_principal,
    decidedAt: row.decided_at,
    runId: row.run_id,
    cancelReason: row.cancel_reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * A stable digest of the preflight packet's live-fact fields -- what
 * revalidation compares against, not the whole packet (whose
 * `optionSchemaVersion`/`decidableOptionKeys` never change on their own).
 * @param {{headSha: (string|null), controlState: (string|null), sessionId: (number|null), launchId: (string|null)}} facts
 * @returns {string} 64-hex-char sha256
 */
function _digestOf(facts) {
  const substance = JSON.stringify({
    headSha: facts.headSha, controlState: facts.controlState, sessionId: facts.sessionId, launchId: facts.launchId
  });
  return crypto.createHash('sha256').update(substance).digest('hex');
}

/**
 * The live facts a preflight packet captures, read fresh. Used both to BUILD
 * a new packet and to REVALIDATE an existing one against current reality.
 * @param {object} project - Project row (`id`, `name`, `path`)
 * @returns {Promise<{headSha: (string|null), controlState: (string|null), sessionId: (number|null), launchId: (string|null)}>}
 */
async function _liveFacts(project) {
  const active = store.sessions.getActive(project.id);
  const sequence = active ? store.launchSequences.getBySession(active.id) : null;
  const open = store.control.getOpenForProject(project.id);
  const headSha = project.path ? await _internal.headSha(project.path) : null;
  return {
    headSha,
    controlState: open ? open.state : null,
    sessionId: active ? active.id : null,
    launchId: sequence ? sequence.launchId : null
  };
}

/**
 * Create a versioned preflight request for a project: the facts true right
 * now, persisted so a later decision can be checked against them rather
 * than trusted blind. Refuses when the project already has an open request
 * (duplicate-run prevention) or no active session.
 * @param {object} input
 * @param {string} input.projectName - Target project
 * @param {{kind: 'operator'|'master'|'coordinator', principal: string}} input.initiator - Who asked; the
 *   route layer has already proven this identity may act on the target (`_requireSessionLifecycleCaller`,
 *   `action: 'wrap'`) before this function is ever called.
 * @param {number} [input.ttlMs] - How long this request stays open; {@link DEFAULT_TTL_MS} otherwise.
 * @returns {Promise<{ok: true, request: object}|{ok: false, code: string, message: string}>}
 */
async function createPreflightRequest(input) {
  const { projectName, initiator } = input || {};
  if (typeof projectName !== 'string' || !projectName) return _refuse('GOVERNED_WRAP_INVALID', 'projectName is required.');
  if (!initiator || !['operator', 'master', 'coordinator'].includes(initiator.kind) || typeof initiator.principal !== 'string' || !initiator.principal) {
    return _refuse('GOVERNED_WRAP_INVALID', 'initiator.kind ("operator"|"master"|"coordinator") and initiator.principal are required.');
  }
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;

  const project = store.projects.getByName(projectName);
  if (!project) return _refuse('NOT_FOUND', `Project "${projectName}" not found.`);

  const db = _db();
  const existing = db.prepare(
    `SELECT request_id FROM governed_wrap_requests WHERE project_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`
  ).get(project.id, ...OPEN_STATES);
  if (existing) {
    return _refuse('GOVERNED_WRAP_IN_PROGRESS', `"${projectName}" already has an open governed-wrap request (${existing.request_id}).`,
      { requestId: existing.request_id });
  }

  const facts = await _liveFacts(project);
  if (!facts.sessionId) return _refuse('NOT_FOUND', `No active session for "${projectName}".`);

  const now = _internal.now();
  const requestId = _internal.id();
  const preflight = {
    projectId: project.id,
    projectName: project.name,
    sessionId: facts.sessionId,
    launchId: facts.launchId,
    headSha: facts.headSha,
    controlState: facts.controlState,
    optionSchemaVersion: OPTION_SCHEMA_VERSION,
    decidableOptionKeys: DECIDABLE_OPTION_KEYS,
    filePolicies: Object.values(FILE_POLICIES),
    createdAt: now
  };
  const preflightJson = JSON.stringify(preflight);
  const digest = _digestOf(facts);
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();

  db.prepare(
    `INSERT INTO governed_wrap_requests
       (request_id, project_id, project_name, session_id, launch_id, initiator_kind, initiator_principal,
        option_schema_version, head_sha, control_state, preflight_json, preflight_digest, state,
        expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(requestId, project.id, project.name, facts.sessionId, facts.launchId, initiator.kind, initiator.principal,
    OPTION_SCHEMA_VERSION, facts.headSha, facts.controlState, preflightJson, digest, STATES.AWAITING_DECISION,
    expiresAt, now, now);

  return { ok: true, request: _view(db.prepare('SELECT * FROM governed_wrap_requests WHERE request_id = ?').get(requestId)) };
}

/**
 * Load one request by id, expiring it in place first if its TTL has passed.
 * @param {string} requestId
 * @returns {object|null} The row, post-expiry-check, or null
 */
function _loadLive(requestId) {
  const db = _db();
  const row = db.prepare('SELECT * FROM governed_wrap_requests WHERE request_id = ?').get(requestId);
  if (!row) return null;
  if (OPEN_STATES.includes(row.state) && row.expires_at <= _internal.now()) {
    db.prepare('UPDATE governed_wrap_requests SET state = ?, updated_at = ? WHERE request_id = ?')
      .run(STATES.EXPIRED, _internal.now(), requestId);
    return db.prepare('SELECT * FROM governed_wrap_requests WHERE request_id = ?').get(requestId);
  }
  return row;
}

/**
 * Submit a decision against an open request: exactly `ready` (with the wrap
 * options and optional bulk file policy) or `needs-operator` (with one
 * bounded question). Validates the request is still open and un-expired;
 * does NOT yet execute anything -- {@link executeReadyRequest} does, after
 * its own fresh revalidation.
 * @param {object} input
 * @param {string} input.requestId
 * @param {string} input.principal - The decider's principal (`operator`, `master`, or `project:<id>`),
 *   for the audit trail -- the route layer has already proven this principal may decide here (and,
 *   per #2072, is never the request's own target project -- `allowOwnProject: false` on that route).
 * @param {{result: 'ready', requestId: string, optionSchemaVersion: string, preflightDigest: string,
 *   options?: object, filePolicy?: string}|{result: 'needs-operator', requestId: string,
 *   optionSchemaVersion: string, preflightDigest: string, question: string}} input.decision - Bound to
 *   the EXACT request id, option-schema version and preflight digest currently on record (PRR-B I-Gate
 *   Round 1 Finding 3) -- a decision prepared against a packet that has since moved is refused as
 *   stale, never silently accepted against the live row instead of the one it was actually read from.
 * @returns {{ok: true, request: object}|{ok: false, code: string, message: string}}
 */
function submitDecision(input) {
  const { requestId, principal, decision } = input || {};
  if (typeof requestId !== 'string' || !requestId) return _refuse('GOVERNED_WRAP_INVALID', 'requestId is required.');
  if (typeof principal !== 'string' || !principal) return _refuse('GOVERNED_WRAP_INVALID', 'principal is required.');
  const malformed = _validateDecisionShape(decision);
  if (malformed) return malformed;

  const row = _loadLive(requestId);
  if (!row) return _refuse('NOT_FOUND', `No governed-wrap request "${requestId}".`);
  if (row.state !== STATES.AWAITING_DECISION) {
    return _refuse('GOVERNED_WRAP_NOT_AWAITING_DECISION', `Request "${requestId}" is "${row.state}", not awaiting a decision.`,
      { state: row.state });
  }
  if (decision.requestId !== requestId || decision.optionSchemaVersion !== row.option_schema_version || decision.preflightDigest !== row.preflight_digest) {
    return _refuse('GOVERNED_WRAP_STALE',
      'This decision does not name the exact requestId, optionSchemaVersion and preflightDigest currently on record; re-read the request and decide again.',
      { requestId: row.request_id, optionSchemaVersion: row.option_schema_version, preflightDigest: row.preflight_digest });
  }

  const nextState = decision.result === 'ready' ? STATES.READY : STATES.NEEDS_OPERATOR;
  const now = _internal.now();
  _db().prepare('UPDATE governed_wrap_requests SET state = ?, decision_json = ?, decided_by_principal = ?, decided_at = ?, updated_at = ? WHERE request_id = ?')
    .run(nextState, JSON.stringify(decision), principal, now, now, requestId);
  return { ok: true, request: _view(_loadLive(requestId)) };
}

/**
 * Validate a decision's shape, independent of any request it names.
 * @param {*} decision
 * @returns {{ok: false, code: string, message: string}|null} A refusal, or null when well-formed
 */
/** `options` keys whose only legal values are `true`/`false` (`lib/sessions.js#startWrap`'s own doc). */
const BOOLEAN_OPTION_KEYS = Object.freeze(['skipTests', 'skipAiContent', 'keepSessionRunning']);

/** `bumpLevel`'s real allowed values (`lib/wrap-steps/version-bump.js`'s own "Bump-level precedence" doc). */
const BUMP_LEVELS = Object.freeze(['patch', 'minor', 'major']);

/** `prHandling`'s string-shortcut values (`lib/wrap-steps/pr-check.js`'s own `VALID_HANDLINGS`). */
const PR_HANDLING_SHORTCUTS = Object.freeze(['merge', 'defer', 'ignore']);

/** A decision's allowed top-level fields, by `result` -- anything else is an unrecognized field, never silently forwarded. */
const DECISION_FIELDS_BY_RESULT = Object.freeze({
  'ready': Object.freeze(['requestId', 'optionSchemaVersion', 'preflightDigest', 'result', 'options', 'filePolicy']),
  'needs-operator': Object.freeze(['requestId', 'optionSchemaVersion', 'preflightDigest', 'result', 'question'])
});

/**
 * Validate one `decision.options` value against the real shape the wrap
 * pipeline gives that key (`lib/sessions.js#startWrap`'s own doc names the
 * keys; each one's own step module names its own allowed values) -- A2072
 * requires a decision to select from the OFFERED option values, never an
 * arbitrary one a loose "is this key known" check would wave through
 * (PRR-B I-Gate Round 2 Finding: `skipTests: "yes"` passed and was forwarded
 * to `startWrap` as-is).
 * @param {string} key - One of {@link DECIDABLE_OPTION_KEYS}
 * @param {*} value
 * @returns {string|null} A problem sentence, or null when the value is legal
 */
function _optionValueProblem(key, value) {
  if (BOOLEAN_OPTION_KEYS.includes(key)) {
    return typeof value === 'boolean' ? null : `decision.options.${key} must be true or false.`;
  }
  if (key === 'bumpLevel') {
    return BUMP_LEVELS.includes(value) ? null : `decision.options.bumpLevel must be one of ${BUMP_LEVELS.join(', ')}.`;
  }
  if (key === 'prHandling') {
    if (typeof value === 'string') {
      return PR_HANDLING_SHORTCUTS.includes(value) ? null
        : `decision.options.prHandling must be one of ${PR_HANDLING_SHORTCUTS.join(', ')}, or an object map of PR number to one of those.`;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const bad = Object.values(value).filter((v) => !PR_HANDLING_SHORTCUTS.includes(v));
      return bad.length === 0 ? null : `decision.options.prHandling values must each be one of ${PR_HANDLING_SHORTCUTS.join(', ')}.`;
    }
    return 'decision.options.prHandling must be a string shortcut or an object map.';
  }
  if (key === 'proceedPastStranded') {
    if (!Array.isArray(value)) return 'decision.options.proceedPastStranded must be an array of {remote?, branch, headSha?}.';
    const bad = value.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.branch !== 'string' || !item.branch);
    return bad ? 'decision.options.proceedPastStranded entries must each be {remote?, branch, headSha?}.' : null;
  }
  return null;
}

function _validateDecisionShape(decision) {
  if (!decision || typeof decision !== 'object') return _refuse('GOVERNED_WRAP_INVALID', 'decision is required.');
  for (const field of ['requestId', 'optionSchemaVersion', 'preflightDigest']) {
    if (typeof decision[field] !== 'string' || !decision[field]) {
      return _refuse('GOVERNED_WRAP_INVALID', `decision.${field} is required -- bind the decision to the exact request you read.`);
    }
  }
  if (decision.result === 'needs-operator') {
    if (typeof decision.question !== 'string' || !decision.question) {
      return _refuse('GOVERNED_WRAP_INVALID', 'decision.question is required when result is "needs-operator".');
    }
    const extra = Object.keys(decision).filter((k) => !DECISION_FIELDS_BY_RESULT['needs-operator'].includes(k));
    if (extra.length > 0) {
      return _refuse('GOVERNED_WRAP_INVALID', `decision carries unrecognized field(s) for a "needs-operator" result: ${extra.join(', ')}.`);
    }
    return null;
  }
  if (decision.result !== 'ready') {
    return _refuse('GOVERNED_WRAP_INVALID', 'decision.result must be exactly "ready" or "needs-operator".');
  }
  const extra = Object.keys(decision).filter((k) => !DECISION_FIELDS_BY_RESULT['ready'].includes(k));
  if (extra.length > 0) {
    return _refuse('GOVERNED_WRAP_INVALID', `decision carries unrecognized field(s) for a "ready" result: ${extra.join(', ')}.`);
  }
  if (decision.filePolicy !== undefined && !Object.values(FILE_POLICIES).includes(decision.filePolicy)) {
    return _refuse('GOVERNED_WRAP_INVALID', `decision.filePolicy must be one of ${Object.values(FILE_POLICIES).join(', ')}.`);
  }
  if (decision.options !== undefined) {
    if (typeof decision.options !== 'object' || decision.options === null || Array.isArray(decision.options)) {
      return _refuse('GOVERNED_WRAP_INVALID', 'decision.options must be an object.');
    }
    const unknown = Object.keys(decision.options).filter((k) => !DECIDABLE_OPTION_KEYS.includes(k));
    if (unknown.length > 0) {
      return _refuse('GOVERNED_WRAP_INVALID', `decision.options may only set ${DECIDABLE_OPTION_KEYS.join(', ')} -- not ${unknown.join(', ')}.`);
    }
    for (const [key, value] of Object.entries(decision.options)) {
      const problem = _optionValueProblem(key, value);
      if (problem) return _refuse('GOVERNED_WRAP_INVALID', problem);
    }
  }
  return null;
}

/**
 * The wrap-pipeline `options` bag a `ready` decision maps to: its own
 * `options` plus the bulk file policy translated to `foreignPathDefault`
 * (see module doc) -- never `pathDecisions` directly, which stays the
 * interactive drawer's own path.
 * @param {{options?: object, filePolicy?: string}} decision
 * @returns {object}
 */
function _wrapOptionsFor(decision) {
  const options = { ...(decision.options || {}) };
  if (decision.filePolicy === FILE_POLICIES.LEAVE_ALL_PREEXISTING) {
    options.foreignPathDefault = 'leave';
  }
  // include-owned-only: no override -- only this session's own changes are
  // auto-included, and a real foreign file still blocks for a decision.
  return options;
}

/**
 * Execute a `ready` request: revalidate its preflight digest against LIVE
 * facts (target/head/control state), and only if nothing has moved, claim
 * the real wrap pipeline through `lib/sessions.js#startWrap`. A request
 * whose facts have moved since the decision was prepared is marked `stale`
 * and refused -- the caller must create a fresh preflight request, never
 * execute a decision built against facts that are no longer true.
 * @param {string} requestId
 * @returns {Promise<{ok: true, request: object, started: object}|{ok: false, code: string, message: string}>}
 */
async function executeReadyRequest(requestId) {
  const row = _loadLive(requestId);
  if (!row) return _refuse('NOT_FOUND', `No governed-wrap request "${requestId}".`);
  if (row.state !== STATES.READY) {
    return _refuse('GOVERNED_WRAP_NOT_READY', `Request "${requestId}" is "${row.state}", not "ready".`, { state: row.state });
  }

  const project = store.projects.get(row.project_id);
  if (!project) return _refuse('NOT_FOUND', `Project ${row.project_id} no longer exists.`);
  const liveFacts = await _liveFacts(project);
  const preflight = JSON.parse(row.preflight_json);
  const liveDigest = _digestOf(liveFacts);
  if (liveDigest !== row.preflight_digest) {
    const now = _internal.now();
    _db().prepare('UPDATE governed_wrap_requests SET state = ?, updated_at = ? WHERE request_id = ?')
      .run(STATES.STALE, now, requestId);
    return _refuse('GOVERNED_WRAP_STALE',
      'The target has changed since this decision\'s preflight packet was prepared (head, control state, session or launch moved); create a fresh preflight request.',
      { preflight, live: liveFacts });
  }

  const decision = JSON.parse(row.decision_json);
  const wrapOptions = _wrapOptionsFor(decision);
  const started = sessions.startWrap(project.name, wrapOptions);
  const now = _internal.now();
  if (!started.ok) {
    // A pipeline-level refusal (e.g. WRAP_IN_PROGRESS, STRANDED_WRAPS) leaves
    // this request READY -- nothing here failed, so a corrected decision (or
    // a retry once the pipeline is free) may still execute it.
    return _refuse(started.code || 'GOVERNED_WRAP_EXECUTION_REFUSED', started.error || 'The wrap pipeline refused this request.', { started });
  }
  _db().prepare('UPDATE governed_wrap_requests SET state = ?, run_id = ?, updated_at = ? WHERE request_id = ?')
    .run(STATES.EXECUTING, started.runId, now, requestId);
  return { ok: true, request: _view(_loadLive(requestId)), started };
}

/**
 * Cancel an open request. A terminal request (already executing or
 * finished) cannot be cancelled from here -- that is the pipeline's own
 * cancel route's job, not this one's.
 * @param {string} requestId
 * @param {string} reason
 * @returns {{ok: true, request: object}|{ok: false, code: string, message: string}}
 */
function cancelRequest(requestId, reason) {
  const row = _loadLive(requestId);
  if (!row) return _refuse('NOT_FOUND', `No governed-wrap request "${requestId}".`);
  if (![STATES.AWAITING_DECISION, STATES.READY, STATES.NEEDS_OPERATOR].includes(row.state)) {
    return _refuse('GOVERNED_WRAP_NOT_CANCELLABLE', `Request "${requestId}" is "${row.state}" and can no longer be cancelled here.`,
      { state: row.state });
  }
  const now = _internal.now();
  _db().prepare('UPDATE governed_wrap_requests SET state = ?, cancel_reason = ?, updated_at = ? WHERE request_id = ?')
    .run(STATES.CANCELLED, typeof reason === 'string' && reason ? reason.slice(0, 500) : null, now, requestId);
  return { ok: true, request: _view(_loadLive(requestId)) };
}

/**
 * One request by id.
 * @param {string} requestId
 * @returns {object|null}
 */
function getRequest(requestId) {
  const row = _loadLive(requestId);
  return row ? _view(row) : null;
}

/**
 * The open (non-terminal) governed-wrap request for a project, if any.
 * @param {number} projectId
 * @returns {object|null}
 */
function getOpenForProject(projectId) {
  const db = _db();
  const row = db.prepare(
    `SELECT * FROM governed_wrap_requests WHERE project_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`
  ).get(projectId, ...OPEN_STATES);
  if (!row) return null;
  // Apply the same lazy-expiry check a direct-by-id read gets.
  return _loadLive(row.request_id) ? _view(_loadLive(row.request_id)) : null;
}

/**
 * This module's own lifecycle state, coarsened to one of {@link PROGRESS_STAGES}
 * -- used only while there is no live wrap-run to ask instead (before a
 * decision is made, or once the run has left the in-process registry).
 * @param {string} state - One of {@link STATES}
 * @returns {string} One of {@link PROGRESS_STAGES}
 */
function _stageForRequestState(state) {
  switch (state) {
    case STATES.AWAITING_DECISION: return PROGRESS_STAGES.PREFLIGHT;
    case STATES.READY:
    case STATES.NEEDS_OPERATOR: return PROGRESS_STAGES.DECISION_VALIDATED;
    case STATES.EXECUTING: return PROGRESS_STAGES.PIPELINE_RUNNING;
    case STATES.COMPLETED: return PROGRESS_STAGES.COMPLETED;
    // STALE, EXPIRED, CANCELLED: none of them ever claimed a run, or the run
    // they claimed is no longer this decision's to report on -- failed, not
    // completed, because this governed-wrap request itself did not finish.
    default: return PROGRESS_STAGES.FAILED;
  }
}

/**
 * One `lib/wrap-run-registry.js` event, coarsened to a progress stage, or
 * `null` for an event that does not move the coarse stage at all (every
 * step-level event while the pipeline simply goes on running).
 * @param {{type: string, result?: ({ok: boolean}|null)}} event - A registry event (replay or live)
 * @returns {string|null}
 */
function _stageForRunEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === WRAP_STREAM_EVENTS.RUN_DONE) {
    return event.result && event.result.ok === false ? PROGRESS_STAGES.FAILED : PROGRESS_STAGES.COMPLETED;
  }
  return PROGRESS_STAGES.PIPELINE_RUNNING;
}

/**
 * Frame one progress stage as a Server-Sent Events message, the same wire
 * shape `lib/routes/wrap.js#_wrapStreamFrame` uses for the plain wrap-run
 * stream: `seq` as the `id:` line, the stage as the `event:` name, and the
 * rest as one JSON `data:` line.
 * @param {number} seq - This frame's sequence number (what a reconnecting `EventSource` echoes back as `Last-Event-ID`)
 * @param {string} stage - One of {@link PROGRESS_STAGES}
 * @param {object|null} [detail] - Stage-specific detail (e.g. `{state}`, `{runEventType}`)
 * @returns {string} The wire frame, terminated by the blank line SSE requires
 * @throws {Error} When `seq` is not a non-negative integer or `stage` is not a real stage
 */
function formatWrapProgressEvent(seq, stage, detail) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error('formatWrapProgressEvent: seq must be a non-negative integer');
  if (!PROGRESS_STAGE_VALUES.includes(stage)) throw new Error(`formatWrapProgressEvent: unknown progress stage "${stage}"`);
  const data = { stage, detail: detail == null ? null : detail, sentAt: _internal.now() };
  return `id: ${seq}\nevent: ${stage}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Open a live progress stream for a governed-wrap request: the SAME
 * "replay what already happened, then live events, closing on a terminal
 * one" contract `sessions.subscribeWrapRun` gives its own callers (#185),
 * reported in this module's own five coarse stages rather than the
 * underlying run's step-by-step detail.
 *
 * Reports the TRUE live stage even when this request's own stored
 * {@link STATES} still says `executing` forever -- nothing in this module's
 * envelope updates that row to `completed`/`failed` once the pipeline
 * finishes (tracked as a later slice); this function answers from the
 * run's own live registry entry instead, which is authoritative regardless
 * of what the stored request row says.
 *
 * @param {string} requestId
 * @param {{onEvent: (frame: {seq: number, stage: string, detail: (object|null)}) => void, onEnd: () => void}} listener
 * @returns {{ok: true, replay: Array<{seq: number, stage: string, detail: (object|null)}>, finished: boolean, unsubscribe: () => void}|{ok: false, code: string, message: string}}
 */
function createWrapProgressStream(requestId, listener) {
  const row = _loadLive(requestId);
  if (!row) return _refuse('NOT_FOUND', `No governed-wrap request "${requestId}".`);
  const request = _view(row);

  let seq = 0;
  const frame = (stage, detail) => ({ seq: ++seq, stage, detail: detail || null });
  const initial = frame(_stageForRequestState(request.state), { state: request.state });

  if (request.state !== STATES.EXECUTING || !request.runId) {
    return { ok: true, replay: [initial], finished: TERMINAL_PROGRESS_STAGES.includes(initial.stage), unsubscribe: () => {} };
  }

  const replay = [initial];
  const sub = sessions.subscribeWrapRun(request.projectName, request.runId, {
    afterSeq: 0,
    onEvent: (event) => {
      const stage = _stageForRunEvent(event);
      if (stage) listener.onEvent(frame(stage, { runEventType: event.type }));
    },
    onEnd: () => listener.onEnd()
  });
  if (!sub.ok) {
    // The run already left the in-process registry (most likely a restart);
    // this request's own stored state is all that is left to report.
    return { ok: true, replay, finished: true, unsubscribe: () => {} };
  }
  for (const event of sub.replay) {
    const stage = _stageForRunEvent(event);
    if (stage) replay.push(frame(stage, { runEventType: event.type }));
  }
  return { ok: true, replay, finished: sub.finished, unsubscribe: sub.unsubscribe };
}

module.exports = {
  STATES,
  FILE_POLICIES,
  DECIDABLE_OPTION_KEYS,
  OPTION_SCHEMA_VERSION,
  createPreflightRequest,
  submitDecision,
  executeReadyRequest,
  cancelRequest,
  getRequest,
  getOpenForProject,
  PROGRESS_STAGES,
  formatWrapProgressEvent,
  createWrapProgressStream
};
