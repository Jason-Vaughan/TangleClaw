'use strict';

/**
 * Who may see or change shared documents and project groups (#1626).
 *
 * One resolver, asked by every shared-docs and groups route, so no route
 * re-derives the caller on its own. It answers one of four kinds:
 *
 * - `operator` — a signed-in dashboard session, or, when TangleClaw's gate
 *   stands down (`open`/`fallback`), a browser-shaped request. With the gate
 *   down the whole dashboard is already open to whoever can reach it, so a
 *   stricter test here would protect nothing.
 * - `project` — a request carrying `x-tangleclaw-launch-id` that the server
 *   resolves to a live session row, and an `x-tangleclaw-project-id` equal to
 *   that row's project. The project comes from what the server recorded at
 *   launch, not from the claim; the claim only has to agree with it.
 * - `unbound` — no launch id at all.
 * - `invalid` — a launch id that is unknown, belongs to another project,
 *   or whose session is no longer active, or a missing/garbled project claim.
 *
 * Anything that is not `operator` or a valid `project` is refused: deny by
 * default. A loopback caller is not the operator merely for being local.
 *
 * The launch id is attribution, not authentication. A same-user local process
 * that reads another pane's environment can present its binding; the security
 * model already grants such a process everything TangleClaw holds. What the
 * binding stops is a session that, following its own instructions, reads or
 * edits another project's documents because nothing asked who it was.
 *
 * @module lib/shared-docs-access
 */

const store = require('./store');

/** @type {Readonly<{OPERATOR: string, PROJECT: string, UNBOUND: string, INVALID: string}>} */
const KINDS = Object.freeze({
  OPERATOR: 'operator',
  PROJECT: 'project',
  UNBOUND: 'unbound',
  INVALID: 'invalid'
});

/** Why a presented binding was not honoured. */
const INVALID_REASONS = Object.freeze({
  PROJECT_CLAIM_MISSING: 'project-claim-missing',
  UNKNOWN_LAUNCH: 'unknown-launch',
  PROJECT_MISMATCH: 'project-mismatch',
  SESSION_NOT_ACTIVE: 'session-not-active'
});

const LAUNCH_HEADER = 'x-tangleclaw-launch-id';
const PROJECT_HEADER = 'x-tangleclaw-project-id';

/**
 * The store lookups the resolver needs. Injected so tests can exercise every
 * branch without a database, and so the resolver holds no query of its own.
 * @type {{getLaunch: function(string): (object|null), getSession: function(number): (object|null), groupsForProject: function(number): object[]}}
 */
const DEFAULT_DEPS = Object.freeze({
  getLaunch: (launchId) => store.launchSequences.getByLaunchId(launchId),
  getSession: (sessionId) => store.sessions.get(sessionId),
  groupsForProject: (projectId) => store.projectGroups.getByProject(projectId)
});

/**
 * Whether a request carries a browser's markers. The same discriminator the
 * server's CSRF guards and machine-client carve-out use: a page cannot
 * suppress `Sec-Fetch-Site`, and script cannot forge its absence.
 * @param {object} req - The request
 * @returns {boolean}
 */
function _browserShaped(req) {
  const headers = req.headers || {};
  return headers['sec-fetch-site'] !== undefined || headers.origin !== undefined;
}

/**
 * Whether this request is the operator.
 *
 * `tcGateActive` must be exactly `false` for the browser-shape path: a request
 * that reaches here without the server having stated the gate's state is not
 * waved through on its headers.
 * @param {object} req - The request, as annotated by `server.js` (`tcSession`, `tcGateActive`)
 * @returns {boolean}
 */
function _isOperator(req) {
  if (req.tcSession) return true;
  return req.tcGateActive === false && _browserShaped(req);
}

/**
 * Build an `invalid` answer.
 * @param {string} reason - One of {@link INVALID_REASONS}
 * @returns {{kind: string, projectId: null, groupIds: string[], reason: string}}
 */
function _invalid(reason) {
  return { kind: KINDS.INVALID, projectId: null, groupIds: [], reason };
}

/**
 * Resolve who is asking, for the shared-docs and groups routes.
 * @param {object} req - The request (`headers`, and `tcSession`/`tcGateActive` set by `server.js`)
 * @param {object} [deps] - Store lookups; defaults to the live store (see {@link DEFAULT_DEPS})
 * @returns {{kind: string, projectId: (number|null), groupIds: string[], reason: (string|null)}}
 *   `groupIds` lists the groups a `project` caller belongs to; empty for every other kind,
 *   where it carries no meaning (an operator is not limited by it).
 */
function resolveAccess(req, deps = DEFAULT_DEPS) {
  if (_isOperator(req)) {
    return { kind: KINDS.OPERATOR, projectId: null, groupIds: [], reason: null };
  }

  const headers = req.headers || {};
  const launchId = headers[LAUNCH_HEADER];
  if (typeof launchId !== 'string' || launchId === '') {
    return { kind: KINDS.UNBOUND, projectId: null, groupIds: [], reason: null };
  }

  const rawProject = headers[PROJECT_HEADER];
  const claimedProjectId = typeof rawProject === 'string' && /^\d+$/.test(rawProject)
    ? Number(rawProject) : null;
  if (claimedProjectId === null) return _invalid(INVALID_REASONS.PROJECT_CLAIM_MISSING);

  const launch = deps.getLaunch(launchId);
  if (!launch) return _invalid(INVALID_REASONS.UNKNOWN_LAUNCH);
  if (launch.projectId !== claimedProjectId) return _invalid(INVALID_REASONS.PROJECT_MISMATCH);

  const session = deps.getSession(launch.sessionId);
  if (!session || session.status !== store.SESSION_STATUS.ACTIVE) {
    return _invalid(INVALID_REASONS.SESSION_NOT_ACTIVE);
  }

  const groupIds = deps.groupsForProject(launch.projectId).map((group) => group.id);
  return { kind: KINDS.PROJECT, projectId: launch.projectId, groupIds, reason: null };
}

/**
 * Whether a resolved caller may see a group and its documents.
 * @param {{kind: string, groupIds: string[]}} access - From {@link resolveAccess}
 * @param {string} groupId - Group id
 * @returns {boolean}
 */
function canSeeGroup(access, groupId) {
  if (access.kind === KINDS.OPERATOR) return true;
  if (access.kind === KINDS.PROJECT) return access.groupIds.includes(groupId);
  return false;
}

/**
 * The refusal a route sends for a caller that has no usable binding, or null
 * when the caller is bound. The message names the headers and the environment
 * variables that carry them, so an agent can recover without a relaunch.
 * @param {{kind: string, reason: (string|null)}} access - From {@link resolveAccess}
 * @returns {{status: number, code: string, message: string}|null}
 */
function refusalFor(access) {
  const how = `Send \`${PROJECT_HEADER}: $TANGLECLAW_PROJECT_ID\` and `
    + `\`${LAUNCH_HEADER}: $TANGLECLAW_LAUNCH_ID\` — both are exported into every TangleClaw-launched pane. `
    + 'A pane with no TANGLECLAW_LAUNCH_ID predates launch binding: relaunch the session.';
  if (access.kind === KINDS.UNBOUND) {
    return {
      status: 403,
      code: 'SHARED_DOCS_BINDING_REQUIRED',
      message: `Shared documents are answered only to a caller bound to a project. ${how}`
    };
  }
  if (access.kind === KINDS.INVALID) {
    return {
      status: 403,
      code: 'SHARED_DOCS_BINDING_INVALID',
      message: `This request's project binding was not honoured (${access.reason}). ${how}`
    };
  }
  return null;
}

module.exports = {
  KINDS,
  INVALID_REASONS,
  LAUNCH_HEADER,
  PROJECT_HEADER,
  resolveAccess,
  canSeeGroup,
  refusalFor
};
