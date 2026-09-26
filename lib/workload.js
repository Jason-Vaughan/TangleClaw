'use strict';

/**
 * Session workload receipts (#1912, ADR 0020 §1–§3): what a session asserts
 * about its own work, written only through `tc workload set`.
 *
 * The caller supplies the asserted fields and nothing else. Every field that
 * identifies or dates a receipt (project, session, launch, assignment,
 * sequence, time, source) is stamped here from the launch `resolveAccess`
 * verified and from the server clock. A body that tries to set one is refused
 * rather than silently overridden, so a caller can never believe it set a
 * field the server discarded.
 *
 * A receipt is an assertion, never evidence that the work is correct, and it
 * grants nothing. How it combines with observed engine activity is the
 * composition's business, not this module's.
 *
 * @module lib/workload
 */

const store = require('./store');
const sharedDocsAccess = require('./shared-docs-access');

/** The body schema a `tc workload set` sends. */
const SCHEMA = 'tc.workload/1';

/** Asserted workload states (ADR 0020 §3). */
const STATES = Object.freeze(['working', 'waiting-external', 'blocked', 'complete']);

/** Asserted clearance values (ADR 0020 §3). */
const CLEARANCES = Object.freeze(['safe-to-clear', 'do-not-clear', 'unknown']);

/** What a `waiting-external` lane may be waiting on (ADR 0020 §3). */
const WAIT_KINDS = Object.freeze(['ci', 'review', 'operator', 'peer', 'merge', 'other']);

/** The only keys a caller may send. */
const CLIENT_KEYS = Object.freeze([
  'schema', 'state', 'clearance', 'summary', 'wait', 'waitDetail',
  'issues', 'prs', 'tasks', 'branch', 'head'
]);

/**
 * Keys the server owns, in both spellings a caller might try. They get their
 * own refusal message because sending one is a misunderstanding of the
 * contract, not a typo.
 */
const SERVER_OWNED_KEYS = Object.freeze([
  'projectId', 'project_id', 'sessionId', 'session_id', 'launchId', 'launch_id',
  'assignmentId', 'assignment_id', 'seq', 'receivedAt', 'received_at', 'source'
]);

/** A lane may write at most one receipt per this many milliseconds (ADR 0020 §3). */
const MIN_INTERVAL_MS = 1000;

/** Field bounds (ADR 0020 §3). */
const LIMITS = Object.freeze({
  summary: 200, waitDetail: 200, refsPerKind: 10, task: 64, branch: 255
});

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A refusal answer.
 * @param {number} status - HTTP status
 * @param {string} code - Machine-readable code
 * @param {string} message - What was wrong and how to fix it
 * @param {object} [extra] - Extra fields for the body
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, message, extra = {}) {
  return { status, body: { error: message, code, ...extra } };
}

/**
 * Whether a string is a git ref name `git check-ref-format` would accept for a
 * branch: no whitespace, control characters, `..`, `@{`, or any of `~^:?*[\`;
 * no leading `-` or `/`, no trailing `/`, `.` or `.lock`, no `//`.
 * @param {string} name - Candidate branch name
 * @returns {boolean}
 */
function isValidBranchName(name) {
  if (typeof name !== 'string' || name === '' || name.length > LIMITS.branch) return false;
  if (CONTROL_CHARS.test(name) || /\s/.test(name)) return false;
  if (/[~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('-') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name === '@') return false;
  return true;
}

/**
 * Validate a list of positive integer references (issue or PR numbers).
 * @param {*} value - The field as sent
 * @param {string} field - Field name, for the message
 * @returns {{ok: true, value: number[]}|{ok: false, message: string}}
 */
function _intRefs(value, field) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > LIMITS.refsPerKind) {
    return { ok: false, message: `${field} must be a list of at most ${LIMITS.refsPerKind} numbers.` };
  }
  for (const n of value) {
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, message: `${field} must hold positive whole numbers; got ${JSON.stringify(n)}.` };
    }
  }
  return { ok: true, value: value.slice() };
}

/**
 * Validate a `tc.workload/1` body: its keys, enums, consistency rules and
 * bounds (ADR 0020 §2–§3). Pure; touches no store.
 * @param {*} body - The parsed request body
 * @returns {{ok: true, value: object}|{ok: false, status: number, code: string, message: string}}
 */
function validate(body) {
  const bad = (code, message) => ({ ok: false, status: 400, code, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('WORKLOAD_BAD_BODY', `The body must be a JSON object with schema "${SCHEMA}".`);
  }
  for (const key of Object.keys(body)) {
    if (SERVER_OWNED_KEYS.includes(key)) {
      return bad('WORKLOAD_FIELD_NOT_WRITABLE',
        `"${key}" is stamped by the server from your verified launch and cannot be sent.`);
    }
    if (!CLIENT_KEYS.includes(key)) {
      return bad('WORKLOAD_FIELD_NOT_WRITABLE',
        `"${key}" is not a workload field. Allowed: ${CLIENT_KEYS.join(', ')}.`);
    }
  }
  if (body.schema !== SCHEMA) {
    return bad('WORKLOAD_BAD_BODY', `schema must be "${SCHEMA}".`);
  }
  if (!STATES.includes(body.state)) {
    return bad('WORKLOAD_BAD_FIELD', `state must be one of ${STATES.join(', ')}.`);
  }
  if (!CLEARANCES.includes(body.clearance)) {
    return bad('WORKLOAD_BAD_FIELD', `clearance must be one of ${CLEARANCES.join(', ')}.`);
  }
  if (typeof body.summary !== 'string' || body.summary.length < 1 || body.summary.length > LIMITS.summary
      || CONTROL_CHARS.test(body.summary) || body.summary.trim() === '') {
    return bad('WORKLOAD_BAD_FIELD',
      `summary must be one line of 1–${LIMITS.summary} characters with no control characters.`);
  }

  let wait = null;
  if (body.wait !== undefined) {
    if (!WAIT_KINDS.includes(body.wait)) {
      return bad('WORKLOAD_BAD_FIELD', `wait must be one of ${WAIT_KINDS.join(', ')}.`);
    }
    wait = body.wait;
  }
  let waitDetail = null;
  if (body.waitDetail !== undefined) {
    if (typeof body.waitDetail !== 'string' || body.waitDetail.length > LIMITS.waitDetail
        || CONTROL_CHARS.test(body.waitDetail)) {
      return bad('WORKLOAD_BAD_FIELD',
        `waitDetail must be at most ${LIMITS.waitDetail} characters with no control characters.`);
    }
    if (wait === null) return bad('WORKLOAD_INCONSISTENT', 'waitDetail needs wait.');
    waitDetail = body.waitDetail;
  }

  const issues = _intRefs(body.issues, 'issues');
  if (!issues.ok) return bad('WORKLOAD_BAD_FIELD', issues.message);
  const prs = _intRefs(body.prs, 'prs');
  if (!prs.ok) return bad('WORKLOAD_BAD_FIELD', prs.message);
  let tasks = [];
  if (body.tasks !== undefined) {
    if (!Array.isArray(body.tasks) || body.tasks.length > LIMITS.refsPerKind) {
      return bad('WORKLOAD_BAD_FIELD', `tasks must be a list of at most ${LIMITS.refsPerKind} ids.`);
    }
    for (const t of body.tasks) {
      if (typeof t !== 'string' || t === '' || t.length > LIMITS.task || CONTROL_CHARS.test(t)) {
        return bad('WORKLOAD_BAD_FIELD', `each task id must be 1–${LIMITS.task} characters with no control characters.`);
      }
    }
    tasks = body.tasks.slice();
  }

  let branch = null;
  if (body.branch !== undefined) {
    if (!isValidBranchName(body.branch)) {
      return bad('WORKLOAD_BAD_FIELD', 'branch must be a valid git branch name of at most 255 characters.');
    }
    branch = body.branch;
  }
  let head = null;
  if (body.head !== undefined) {
    if (typeof body.head !== 'string' || !/^[0-9a-f]{40}$/.test(body.head)) {
      return bad('WORKLOAD_BAD_FIELD', 'head must be a full 40-character lowercase commit SHA.');
    }
    head = body.head;
  }

  // Consistency rules (ADR 0020 §3).
  if (body.state === 'working' && body.clearance !== 'do-not-clear') {
    return bad('WORKLOAD_INCONSISTENT', 'working requires clearance do-not-clear: work in flight is never safe to clear.');
  }
  if (body.state === 'waiting-external' && wait === null) {
    return bad('WORKLOAD_INCONSISTENT', `waiting-external requires wait (${WAIT_KINDS.join(', ')}).`);
  }
  if (body.state !== 'waiting-external' && wait !== null) {
    return bad('WORKLOAD_INCONSISTENT', 'wait is only for state waiting-external.');
  }

  return {
    ok: true,
    value: {
      state: body.state,
      clearance: body.clearance,
      summary: body.summary,
      wait,
      waitDetail,
      refs: { issues: issues.value, prs: prs.value, tasks },
      branch,
      head
    }
  };
}

/**
 * The binding refusal for a caller that may not write or read a lane's
 * workload, or null for a verified project launch.
 * @param {{kind: string, reason: (string|null)}} access - From `resolveAccess`
 * @returns {{status: number, body: object}|null}
 */
function bindingRefusal(access) {
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) return null;
  const why = access.kind === sharedDocsAccess.KINDS.INVALID ? access.reason : access.kind;
  return _refuse(403, 'WORKLOAD_BINDING_REQUIRED',
    'Only a session with a verified launch writes its own workload, through `tc workload set` '
    + 'in its own pane (it sends x-tangleclaw-project-id and x-tangleclaw-launch-id). '
    + `This caller is ${why}.`,
    { reason: why });
}

/**
 * Whether a request came from the `tc` client naming a verb: the precondition
 * for recording `source: 'tc-cli'`.
 * @param {object} headers - Request headers (lower-cased)
 * @returns {boolean}
 */
function _fromTcClient(headers) {
  return headers['x-tangleclaw-cli'] === 'tc'
    && typeof headers['x-tangleclaw-verb'] === 'string' && headers['x-tangleclaw-verb'] !== '';
}

/**
 * The public view of a stored receipt.
 * @param {object|null} row - A `workload_receipts` row
 * @returns {object|null}
 */
function toView(row) {
  if (!row) return null;
  let refs;
  try { refs = JSON.parse(row.refs_json); } catch { refs = { issues: [], prs: [], tasks: [] }; }
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    assignmentId: row.assignment_id,
    seq: row.seq,
    state: row.state,
    clearance: row.clearance,
    summary: row.summary,
    wait: row.wait_kind,
    waitDetail: row.wait_detail,
    refs,
    branch: row.branch,
    head: row.head_sha,
    source: row.source,
    receivedAt: row.received_at
  };
}

/**
 * Record a receipt from `POST /api/tc/workload`.
 * @param {{req: object, body: *, access?: object, nowMs?: number}} input - The request, its parsed
 *   body, and (for tests) a pre-resolved access and a clock
 * @returns {{status: number, body: object}}
 */
function record({ req, body, access = sharedDocsAccess.resolveAccess(req), nowMs = Date.now() }) {
  const refusal = bindingRefusal(access);
  if (refusal) return refusal;
  if (!_fromTcClient(req.headers || {})) {
    return _refuse(403, 'WORKLOAD_BINDING_REQUIRED',
      'Workload is written only by the tc client (`tc workload set`), which names itself and its verb.',
      { reason: 'tc-client-required' });
  }
  const checked = validate(body);
  if (!checked.ok) return _refuse(checked.status, checked.code, checked.message);
  const v = checked.value;

  const open = store.control.getOpenForProject(access.projectId);
  const assignmentId = open && open.bound_launch_id === access.launchId ? open.assignment_id : null;

  const result = store.workloadReceipts.append({
    project_id: access.projectId,
    session_id: access.sessionId,
    launch_id: access.launchId,
    assignment_id: assignmentId,
    state: v.state,
    clearance: v.clearance,
    summary: v.summary,
    wait_kind: v.wait,
    wait_detail: v.waitDetail,
    refs_json: JSON.stringify(v.refs),
    branch: v.branch,
    head_sha: v.head,
    source: 'tc-cli',
    received_at: new Date(nowMs).toISOString()
  }, { minIntervalMs: MIN_INTERVAL_MS, nowMs });

  if (result.busy) {
    return _refuse(503, 'WORKLOAD_BUSY',
      'Another write held the store twice in a row; nothing was recorded. Retry the same command.');
  }
  if (result.rateLimited) {
    return _refuse(429, 'WORKLOAD_RATE',
      `One workload receipt per second per lane; retry in ${result.retryAfterMs} ms.`,
      { retryAfterMs: result.retryAfterMs });
  }
  return { status: 201, body: { receipt: toView(result.row) } };
}

/**
 * The caller's own lane: its newest receipt, from `GET /api/tc/workload`.
 * @param {{req: object, access?: object}} input - The request (and, for tests, a pre-resolved access)
 * @returns {{status: number, body: object}}
 */
function readOwn({ req, access = sharedDocsAccess.resolveAccess(req) }) {
  const refusal = bindingRefusal(access);
  if (refusal) return refusal;
  return { status: 200, body: { receipt: toView(store.workloadReceipts.latestForLaunch(access.launchId)) } };
}

module.exports = {
  SCHEMA,
  STATES,
  CLEARANCES,
  WAIT_KINDS,
  CLIENT_KEYS,
  SERVER_OWNED_KEYS,
  MIN_INTERVAL_MS,
  LIMITS,
  validate,
  isValidBranchName,
  bindingRefusal,
  toView,
  record,
  readOwn
};
