'use strict';

/**
 * Who is calling, for every route that must tell the operator from a project's
 * agent: shared documents and project groups (#1626), and the project write
 * routes (#1752).
 *
 * One resolver, so no route re-derives the caller on its own. Each of those
 * routes asks it before any lookup and states what it needs (see {@link NEEDS}):
 * to read, to write within a group, to change its own project, or the operator.
 * It answers one of five kinds:
 *
 * - `operator` — a signed-in dashboard session, or, when TangleClaw's gate
 *   stands down (`open`/`fallback`), a request from the dashboard: one that is
 *   browser-shaped, or that carries the header the dashboard's fetch wrapper
 *   adds to every request (see {@link CLIENT_HEADER}). With the gate down the
 *   whole dashboard is already open to whoever can reach it, so a stricter test
 *   here would protect nothing, and neither test claims to.
 * - `project` — a request carrying `x-tangleclaw-launch-id` that the server
 *   resolves to a live session row, and an `x-tangleclaw-project-id` equal to
 *   that row's project. The project comes from what the server recorded at
 *   launch, not from the claim; the claim only has to agree with it.
 * - `master` — the Project Master: `x-tangleclaw-role: master` with the launch
 *   id recorded in the live Master session's tmux environment. The Master has
 *   no project and no session row, so its binding is checked against the pane
 *   that holds it, and only for an id the store does not know: a project's
 *   launch id stays that project's whatever role it claims.
 * - `unbound` — no launch id at all.
 * - `invalid` — a launch id that is unknown, belongs to another project,
 *   or whose session is no longer active, or a missing/garbled project claim;
 *   or a Master claim whose id is not the live Master's, or that tmux could not
 *   check.
 *
 * Anything that is not `operator`, a valid `project` or a valid `master` is
 * refused: deny by default. A loopback caller is not the operator merely for being local.
 *
 * What each kind may do with shared documents: the operator anything; a project
 * read and write its own groups (register, lock, notify, sync); the Master read
 * every group and write nothing. Editing or deleting a document and managing
 * groups and their members are the operator's alone: `filePath` decides which
 * file is injected into every member project's engine config, so a caller that
 * could change it could choose another project's hidden context.
 *
 * What each kind may do with projects: creating, attaching, importing, deleting,
 * archiving, renaming and migrating a project, and repairing hooks across
 * projects, are the operator's. Changing a project's settings, running its
 * actions and working its stranded wraps are the operator's or that project's
 * own ({@link canChangeProject}). The Master changes no project.
 *
 * The launch id is attribution, not authentication. A same-user local process
 * that reads another pane's environment can present its binding; the security
 * model already grants such a process everything TangleClaw holds. What the
 * binding stops is a session that, following its own instructions, reads or
 * changes another project's documents or configuration because nothing asked
 * who it was.
 *
 * @module lib/shared-docs-access
 */

const store = require('./store');

/** @type {Readonly<{OPERATOR: string, PROJECT: string, MASTER: string, UNBOUND: string, INVALID: string}>} */
const KINDS = Object.freeze({
  OPERATOR: 'operator',
  PROJECT: 'project',
  MASTER: 'master',
  UNBOUND: 'unbound',
  INVALID: 'invalid'
});

/**
 * What a route needs from its caller, checked by {@link refusalFor} before any
 * lookup. What the caller may touch is checked after the lookup:
 * {@link canSeeGroup} for a group read, {@link canWriteGroup} for a group
 * write, {@link canChangeProject} for a project change. `operator` admits no
 * one else; `own-project` admits the operator and a bound project.
 * @type {Readonly<{READ: string, WRITE: string, OWN_PROJECT: string, OPERATOR: string}>}
 */
const NEEDS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  OWN_PROJECT: 'own-project',
  OPERATOR: 'operator'
});

/**
 * Which route family a refusal is for. The codes and the wording differ, so an
 * agent refused by a project route is not told about shared documents. Shared
 * docs is the default, which keeps every existing call's codes.
 * @type {Readonly<{SHARED_DOCS: string, PROJECTS: string}>}
 */
const SURFACES = Object.freeze({
  SHARED_DOCS: 'shared-docs',
  PROJECTS: 'projects'
});

/** Why a presented binding was not honoured. */
const INVALID_REASONS = Object.freeze({
  PROJECT_CLAIM_MISSING: 'project-claim-missing',
  UNKNOWN_LAUNCH: 'unknown-launch',
  PROJECT_MISMATCH: 'project-mismatch',
  SESSION_NOT_ACTIVE: 'session-not-active',
  MASTER_LAUNCH_STALE: 'master-launch-stale',
  MASTER_UNVERIFIABLE: 'master-unverifiable'
});

/** The reasons that belong to a Master claim, whose refusal explains the Master's binding. */
const MASTER_REASONS = new Set([INVALID_REASONS.MASTER_LAUNCH_STALE, INVALID_REASONS.MASTER_UNVERIFIABLE]);

const LAUNCH_HEADER = 'x-tangleclaw-launch-id';
const PROJECT_HEADER = 'x-tangleclaw-project-id';
const ROLE_HEADER = 'x-tangleclaw-role';

/**
 * The header the dashboard's fetch wrapper (`public/api-helper.js#tcFetch`)
 * sends on every request, with the value {@link DASHBOARD_CLIENT}. Browsers send
 * `Sec-Fetch-Site` only to HTTPS and localhost origins, and no `Origin` on a
 * same-origin `GET`, so a dashboard read over plain http on a tailnet or LAN
 * address is otherwise indistinguishable from a local script. Honoured only
 * while the gate stands down, where it grants nothing that sending `Origin`
 * would not; it is not a credential and never outranks a signed-in session.
 */
const CLIENT_HEADER = 'x-tangleclaw-client';
const DASHBOARD_CLIENT = 'dashboard';

/**
 * How long a Master claim waits for tmux, in ms. The read is a synchronous
 * subprocess on the request path, so a wedged tmux server would otherwise hold
 * the event loop for tmux's full default timeout on every such request. A read
 * that runs out is refused (`master-unverifiable`), never passed; a healthy
 * tmux answers in a few milliseconds.
 */
const MASTER_READ_TIMEOUT_MS = 1000;

/**
 * The store lookups the resolver needs. Injected so tests can exercise every
 * branch without a database, and so the resolver holds no query of its own.
 * @type {{getLaunch: function(string): (object|null), getSession: function(number): (object|null), groupsForProject: function(number): object[], liveMasterLaunch: function(): {launchId: (string|null), answered: boolean}}}
 */
const DEFAULT_DEPS = Object.freeze({
  getLaunch: (launchId) => store.launchSequences.getByLaunchId(launchId),
  getSession: (sessionId) => store.sessions.get(sessionId),
  groupsForProject: (projectId) => store.projectGroups.getByProject(projectId),
  // Required lazily: `lib/master.js` pulls in the session and engine modules,
  // which a caller of this resolver does not otherwise need loaded.
  liveMasterLaunch: () => require('./master').liveMasterLaunchId({ timeout: MASTER_READ_TIMEOUT_MS })
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
 * `tcGateActive` must be exactly `false` for the browser-shape and dashboard
 * paths: a request that reaches here without the server having stated the
 * gate's state is not waved through on its headers.
 * @param {object} req - The request, as annotated by `server.js` (`tcSession`, `tcGateActive`)
 * @returns {boolean}
 */
function _isOperator(req) {
  if (req.tcSession) return true;
  return req.tcGateActive === false && (_browserShaped(req) || _dashboardClient(req));
}

/**
 * Whether a request says it comes from the dashboard's fetch wrapper.
 * @param {object} req - The request
 * @returns {boolean}
 */
function _dashboardClient(req) {
  const headers = req.headers || {};
  return headers[CLIENT_HEADER] === DASHBOARD_CLIENT;
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
 * Resolve a Master claim: the presented id must be the one the live Master
 * session was launched with. A tmux that does not answer is a refusal, never a
 * pass.
 * @param {string} launchId - The presented launch id
 * @param {object} deps - Store and Master lookups (see {@link DEFAULT_DEPS})
 * @returns {{kind: string, projectId: null, groupIds: string[], reason: (string|null), cause?: (string|null)}}
 *   `cause` is set only when tmux did not answer, and says why.
 */
function _resolveMaster(launchId, deps) {
  const live = deps.liveMasterLaunch();
  if (!live || !live.answered) {
    // Why tmux did not answer is what tells an operator a hung tmux server
    // from a bad binding, so it travels with the refusal.
    return { ..._invalid(INVALID_REASONS.MASTER_UNVERIFIABLE), cause: (live && live.cause) || null };
  }
  if (typeof live.launchId === 'string' && live.launchId !== '' && live.launchId === launchId) {
    return { kind: KINDS.MASTER, projectId: null, groupIds: [], reason: null };
  }
  return _invalid(INVALID_REASONS.MASTER_LAUNCH_STALE);
}

/**
 * Resolve who is asking, for the shared-docs and groups routes.
 * @param {object} req - The request (`headers`, and `tcSession`/`tcGateActive` set by `server.js`)
 * @param {object} [deps] - Store lookups; defaults to the live store (see {@link DEFAULT_DEPS})
 * @returns {{kind: string, projectId: (number|null), groupIds: string[], reason: (string|null)}}
 *   `groupIds` lists the groups a `project` caller belongs to; empty for every other kind,
 *   where it carries no meaning (neither the operator nor the Master is limited by it).
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

  // The store is asked first, so a project's launch id can never be promoted
  // to the Master by adding the role header; only an id no project owns is
  // compared with the live Master's.
  if (headers[ROLE_HEADER] === 'master' && !deps.getLaunch(launchId)) {
    return _resolveMaster(launchId, deps);
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
  if (access.kind === KINDS.OPERATOR || access.kind === KINDS.MASTER) return true;
  if (access.kind === KINDS.PROJECT) return access.groupIds.includes(groupId);
  return false;
}

/**
 * Whether a resolved caller may change a group or its documents: register,
 * lock, unlock, notify or sync. Only the operator and a member project may;
 * the Project Master never can, so a write route that forgot to ask
 * {@link refusalFor} for `write` still does not let it through.
 * @param {{kind: string, groupIds: string[]}} access - From {@link resolveAccess}
 * @param {string} groupId - Group id
 * @returns {boolean}
 */
function canWriteGroup(access, groupId) {
  if (access.kind === KINDS.OPERATOR) return true;
  if (access.kind === KINDS.PROJECT) return access.groupIds.includes(groupId);
  return false;
}

/**
 * Whether a resolved caller may change a project: its settings, its actions,
 * its stranded wraps. The operator may change any project; a bound project only
 * its own. The Project Master has no project, so it may change none.
 * @param {{kind: string, projectId: (number|null)}} access - From {@link resolveAccess}
 * @param {number} projectId - The target project's id
 * @returns {boolean}
 */
function canChangeProject(access, projectId) {
  if (access.kind === KINDS.OPERATOR) return true;
  if (access.kind === KINDS.PROJECT) return access.projectId === projectId;
  return false;
}

/**
 * The refusal a route sends when its caller cannot do what the route needs, or
 * null when it can. A binding refusal names the headers and the environment
 * variables that carry them, so an agent can recover without a relaunch; an
 * operator-only refusal says no binding would help.
 *
 * What the caller may touch is not checked here: a shared-docs route that finds
 * the group or document outside the caller's groups answers 404, as it does for
 * one that does not exist, and a project route asks {@link canChangeProject}
 * once it has found the project.
 * @param {{kind: string, reason: (string|null)}} access - From {@link resolveAccess}
 * @param {string} [need] - One of {@link NEEDS}; defaults to `read`
 * @param {{surface?: string, action?: string}} [opts] - `surface` is one of
 *   {@link SURFACES} (default shared docs). `action` completes "Only the
 *   operator can …" for an operator-only project route, e.g. "create a project".
 * @returns {{status: number, code: string, message: string}|null}
 */
function refusalFor(access, need = NEEDS.READ, opts = {}) {
  if (opts.surface === SURFACES.PROJECTS) return _projectRefusal(access, need, opts.action);
  if (need === NEEDS.OPERATOR) {
    if (access.kind === KINDS.OPERATOR) return null;
    return {
      status: 403,
      code: 'OPERATOR_ONLY',
      message: 'Only the operator can edit or delete a shared document, or create, change or delete '
        + 'a group or its members. Ask the operator to make this change from the TangleClaw dashboard; '
        + 'no project or Project Master binding can make it.'
    };
  }
  const bindingRefusal = _bindingRefusal(access, SURFACES.SHARED_DOCS);
  if (bindingRefusal) return bindingRefusal;
  if (need === NEEDS.WRITE && access.kind === KINDS.MASTER) {
    return {
      status: 403,
      code: 'SHARED_DOCS_READ_ONLY',
      message: 'The Project Master reads every group\'s shared documents but changes none of them. '
        + 'Registering, locking, notifying and syncing are done by a project in the group, or by the operator.'
    };
  }
  return null;
}

/**
 * The refusal for a project write route. Every project route here changes
 * something, so any need other than `operator` is treated as `own-project`.
 * @param {{kind: string, reason: (string|null)}} access - From {@link resolveAccess}
 * @param {string} need - One of {@link NEEDS}
 * @param {string} [action] - What was refused, for the operator-only message
 * @returns {{status: number, code: string, message: string}|null}
 */
function _projectRefusal(access, need, action) {
  if (need === NEEDS.OPERATOR) {
    if (access.kind === KINDS.OPERATOR) return null;
    return {
      status: 403,
      code: 'OPERATOR_ONLY',
      message: `Only the operator can ${action || 'make this change to a project'}. Ask the operator to do it `
        + 'from the TangleClaw dashboard; no project or Project Master binding can.'
    };
  }
  const bindingRefusal = _bindingRefusal(access, SURFACES.PROJECTS);
  if (bindingRefusal) return bindingRefusal;
  if (access.kind === KINDS.MASTER) {
    return {
      status: 403,
      code: 'PROJECT_READ_ONLY',
      message: 'The Project Master reads projects but changes none of them. A project\'s settings, '
        + 'actions and stranded wraps are changed by that project\'s own session, or by the operator.'
    };
  }
  return null;
}

/**
 * The refusal for a caller with no usable binding, or null when it is bound.
 * @param {{kind: string, reason: (string|null)}} access - From {@link resolveAccess}
 * @param {string} surface - One of {@link SURFACES}; picks the codes and wording
 * @returns {{status: number, code: string, message: string}|null}
 */
function _bindingRefusal(access, surface) {
  const projects = surface === SURFACES.PROJECTS;
  const prefix = projects ? 'PROJECT' : 'SHARED_DOCS';
  const how = `Send \`${PROJECT_HEADER}: $TANGLECLAW_PROJECT_ID\` and `
    + `\`${LAUNCH_HEADER}: $TANGLECLAW_LAUNCH_ID\` — both are exported into every TangleClaw-launched pane. `
    + 'A pane with no TANGLECLAW_LAUNCH_ID predates launch binding: relaunch the session.';
  if (access.kind === KINDS.UNBOUND) {
    return {
      status: 403,
      code: `${prefix}_BINDING_REQUIRED`,
      message: projects
        ? `A project is changed only by the operator or by a caller bound to that project. ${how}`
        : `Shared documents are answered only to a caller bound to a project. ${how}`
    };
  }
  if (access.kind === KINDS.INVALID && MASTER_REASONS.has(access.reason)) {
    return {
      status: 403,
      code: `${prefix}_BINDING_INVALID`,
      message: `This request's Project Master binding was not honoured (${access.reason}). `
        + `From the Master pane, send \`${ROLE_HEADER}: master\` and \`${LAUNCH_HEADER}: $TANGLECLAW_LAUNCH_ID\`. `
        + 'Only the live Master session\'s own id is honoured, and a Master pane with no '
        + 'TANGLECLAW_LAUNCH_ID predates the binding: relaunch the Project Master.'
    };
  }
  if (access.kind === KINDS.INVALID) {
    return {
      status: 403,
      code: `${prefix}_BINDING_INVALID`,
      message: `This request's project binding was not honoured (${access.reason}). ${how}`
    };
  }
  return null;
}

module.exports = {
  KINDS,
  NEEDS,
  SURFACES,
  INVALID_REASONS,
  MASTER_READ_TIMEOUT_MS,
  LAUNCH_HEADER,
  PROJECT_HEADER,
  ROLE_HEADER,
  CLIENT_HEADER,
  DASHBOARD_CLIENT,
  resolveAccess,
  canSeeGroup,
  canWriteGroup,
  canChangeProject,
  refusalFor
};
