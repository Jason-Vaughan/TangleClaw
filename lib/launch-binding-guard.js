'use strict';

/**
 * The floor under every route that changes something: who is asking must be
 * known before the handler runs (#2233).
 *
 * A pane's `tc` calls carry the launch id and project id TangleClaw exported
 * into it. When an engine runs one conversation on a process it shares with
 * another launch, those two values can belong to a different project than the
 * conversation on screen. Each route used to decide for itself whether to ask
 * who was calling, and many did not, so a request with no binding, a stale
 * one, or one for a session that is no longer its project's current session
 * could still change state. This guard asks once, in the dispatcher, for every
 * mutating route, and refuses unless the caller is one of:
 *
 * - the operator (a signed-in dashboard session, or the dashboard while the
 *   gate stands down), as `lib/shared-docs-access.js` resolves it;
 * - the Project Master, whose launch id is checked against its live pane;
 * - a project whose launch id resolves to an ACTIVE session of the project it
 *   claims, where that session is also the project's current one.
 *
 * Routes that cannot meet that test by design are listed in {@link EXCEPTIONS},
 * each with the reason and the check that stands in for this one. A mutating
 * route that is neither guarded nor listed does not exist: the guard is the
 * default, and the list is exact.
 *
 * What this does not do: it cannot tell a wrong conversation that presents a
 * valid, live binding from the right one. The binding is attribution, not
 * authentication (see `lib/shared-docs-access.js`). Keeping a conversation off
 * a shared engine process is the launch judgment's job
 * (`lib/sessions.js#_judgeLaunchIsolation`).
 *
 * @module lib/launch-binding-guard
 */

const sharedDocsAccess = require('./shared-docs-access');
const store = require('./store');

const { KINDS, INVALID_REASONS } = sharedDocsAccess;

/** The methods that change state. */
const MUTATING_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Why a mutating route is not held to the launch binding. Every value names
 * the check that stands in its place.
 * @type {Readonly<{PRE_AUTH: string, SELF_VALIDATING: string, OWN_PRINCIPAL: string}>}
 */
const EXCEPTION_KINDS = Object.freeze({
  // No identity can exist yet: the request is how one is established.
  PRE_AUTH: 'pre-auth',
  // The handler validates the launch id and project claim against each other
  // itself, and must answer a launch that is still being recorded.
  SELF_VALIDATING: 'self-validating',
  // The route proves a principal of its own before its handler runs.
  OWN_PRINCIPAL: 'own-principal'
});

/**
 * The mutating routes that are not held to the launch binding, keyed
 * `METHOD pattern` exactly as registered.
 * @type {Readonly<Object<string, {kind: string, why: string}>>}
 */
const EXCEPTIONS = Object.freeze({
  'POST /api/auth/login': { kind: EXCEPTION_KINDS.PRE_AUTH, why: 'signing in is how a session is established' },
  'POST /api/auth/logout': { kind: EXCEPTION_KINDS.PRE_AUTH, why: 'a browser whose session has already lapsed must still be able to sign out' },
  'POST /api/auth/recover': { kind: EXCEPTION_KINDS.PRE_AUTH, why: 'a recovery code stands in for the session' },
  'POST /api/auth/set-password': { kind: EXCEPTION_KINDS.PRE_AUTH, why: 'creates the first account, before any session can exist' },
  'POST /api/tc/start/next': { kind: EXCEPTION_KINDS.SELF_VALIDATING, why: 'the launch sequence validates the pair and stays retryable while a launch is recorded' },
  'POST /api/tc/start/ready': { kind: EXCEPTION_KINDS.SELF_VALIDATING, why: 'the launch sequence validates the pair' },
  'POST /api/tc/rule-receipt': { kind: EXCEPTION_KINDS.SELF_VALIDATING, why: 'an engine hook confirms one delivery by its own token and carries no launch headers' },
  'POST /api/audit/ingest': { kind: EXCEPTION_KINDS.OWN_PRINCIPAL, why: 'a remote engine\'s webhook proves its connection\'s audit secret, and the project is derived from that connection' }
});

/**
 * The routes a launch may still call after its own session has ended, keyed as
 * {@link EXCEPTIONS} is. Finalizing is how a session ends itself, and a repeat
 * of that request is how an interrupted teardown gets finished, so the caller
 * is by then an ended launch. It is admitted only for the project that launch
 * belongs to, and only for a session that finalize path itself ended: see
 * {@link _endedOwnLaunch}. What the repeat may then do is the handler's to
 * decide, and it confines an ended launch to its own session.
 * @type {ReadonlySet<string>}
 */
const ENDED_LAUNCH_ROUTES = Object.freeze(new Set([
  'POST /api/sessions/:project/finalize'
]));

/**
 * The routes on which a verified service token is a principal of its own, keyed
 * as {@link EXCEPTIONS} is. The token is the port registry's machine credential:
 * it lets a service that is not a TangleClaw session write to the port
 * registry (the routes listed here), and nothing else. It is honoured only when the operator has turned the
 * service-token gate on and the dispatcher verified the token on this request;
 * with the gate off there is no credential to verify, and the caller must be
 * bound like any other. It never stands for the operator or the Master.
 * @type {ReadonlySet<string>}
 */
const SERVICE_TOKEN_ROUTES = Object.freeze(new Set([
  'POST /api/ports/lease',
  'POST /api/ports/owner-kind',
  'POST /api/ports/sync',
  'POST /api/ports/release',
  'POST /api/ports/heartbeat'
]));

/**
 * Whether a method changes state.
 * @param {string} method - HTTP method
 * @returns {boolean}
 */
function isMutating(method) {
  return MUTATING_METHODS.includes(String(method || '').toUpperCase());
}

/**
 * The exception a route is listed under, if any.
 * @param {string} method - HTTP method
 * @param {string} pattern - The route's registered pattern
 * @param {{ownPrincipal?: boolean}} [routeOptions] - The route's registration options
 * @returns {{kind: string, why: string}|null}
 */
function exceptionFor(method, pattern, routeOptions = {}) {
  const listed = EXCEPTIONS[`${String(method).toUpperCase()} ${pattern}`];
  if (listed) return listed;
  if (routeOptions && routeOptions.ownPrincipal === true) {
    return { kind: EXCEPTION_KINDS.OWN_PRINCIPAL, why: 'the route proves its own principal before its handler runs' };
  }
  return null;
}

/**
 * The three things a launch binding can be. `stale` covers every binding that
 * was presented and is not honoured, whatever the reason.
 * @type {Readonly<{VERIFIED: string, STALE: string, UNBOUND: string}>}
 */
const BINDING_STATES = Object.freeze({ VERIFIED: 'verified', STALE: 'stale', UNBOUND: 'unbound' });

/** The reason this guard adds to the resolver's: the session is live but superseded. */
const SESSION_NOT_CURRENT = 'session-not-current';
/** The reason recorded for a request that presented no launch id. */
const UNBOUND_REASON = 'unbound';

/**
 * What is wrong with a binding, one sentence per reason. Every surface that
 * reports a binding (this floor, `tc whoami`, the launch sequence) reads its
 * sentence from here, so a session is told the same thing wherever it asks.
 * @type {Readonly<Object<string, string>>}
 */
const CAUSES = Object.freeze({
  [UNBOUND_REASON]: 'No launch binding was presented. A session sends two headers, which `tc` adds for it: '
    + 'x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID and x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID.',
  [INVALID_REASONS.PROJECT_CLAIM_MISSING]: 'The launch id came without a project id to check it against.',
  [INVALID_REASONS.UNKNOWN_LAUNCH]: 'TangleClaw has no record of this launch id.',
  [INVALID_REASONS.PROJECT_MISMATCH]: 'The launch id belongs to a different project than the one claimed.',
  [INVALID_REASONS.SESSION_NOT_ACTIVE]: 'The session this launch belongs to has ended.',
  [SESSION_NOT_CURRENT]: 'The session this launch belongs to is not its project\'s current session.',
  [INVALID_REASONS.MASTER_LAUNCH_STALE]: 'The launch id is not the one the live Project Master was started with.',
  [INVALID_REASONS.MASTER_UNVERIFIABLE]: 'TangleClaw could not read the live Project Master\'s launch id from its pane, so this one was not checked.'
});

const GENERAL_CAUSE = 'The launch binding presented is not one TangleClaw can verify.';

const RECOVERY_STALE = 'Do not act from this pane. Ask the operator to end this session and launch it again.';
const RECOVERY_UNBOUND = 'A pane with no TANGLECLAW_LAUNCH_ID was not started by this TangleClaw, or predates launch binding: '
  + 'ask the operator to launch the session again.';
// tmux did not answer, which says nothing about the binding itself.
const RECOVERY_UNCHECKED = 'Nothing is known to be wrong with the binding. Try again; if it keeps happening, tmux is not answering and the operator needs to know.';

/** Where a refused caller can read its binding's state at any time. */
const WHOAMI_POINTER = '`tc whoami` in the pane shows this verdict.';

/**
 * The sentence that says what is wrong with a binding.
 * @param {string} [reason] - A resolver reason, `session-not-current` or `unbound`
 * @returns {string} The reason's sentence, or the general one for a reason this table does not hold
 */
function causeFor(reason) {
  return Object.prototype.hasOwnProperty.call(CAUSES, reason) ? CAUSES[reason] : GENERAL_CAUSE;
}

/**
 * What a caller with a binding that is not honoured should do about it.
 * @param {string} state - One of {@link BINDING_STATES}
 * @param {string} [reason] - Why, for a stale binding
 * @returns {string|null} Null for a verified binding
 */
function recoveryFor(state, reason) {
  if (state === BINDING_STATES.VERIFIED) return null;
  if (state === BINDING_STATES.UNBOUND) return RECOVERY_UNBOUND;
  return reason === INVALID_REASONS.MASTER_UNVERIFIABLE ? RECOVERY_UNCHECKED : RECOVERY_STALE;
}

/**
 * Build a refusal from a binding's description.
 * @param {{state: string, reason: string, cause: string, recovery: string}} described - From {@link _classify}
 * @returns {{allowed: false, status: number, code: string, reason: string, message: string}}
 */
function _refuse(described) {
  const unbound = described.state === BINDING_STATES.UNBOUND;
  return {
    allowed: false,
    status: 403,
    code: unbound ? 'LAUNCH_BINDING_REQUIRED' : 'LAUNCH_BINDING_INVALID',
    reason: described.reason,
    message: `${described.cause}${unbound ? '' : ` (${described.reason})`} ${described.recovery} ${WHOAMI_POINTER}`
  };
}

/**
 * The store lookups the guard needs beyond the resolver's. Injected so every
 * branch can be tested without a database.
 * @type {{resolveAccess: function(object): object, resolveBinding: function(object): object, currentSession: function(number): (object|null), getLaunch: function(string): (object|null), getSession: function(number): (object|null), projectByName: function(string): (object|null), finalizedByGovernedPath: function(object): boolean}}
 */
const DEFAULT_DEPS = Object.freeze({
  resolveAccess: (req) => sharedDocsAccess.resolveAccess(req),
  resolveBinding: (req) => sharedDocsAccess.resolveBinding(req),
  currentSession: (projectId) => store.sessions.getActive(projectId),
  getLaunch: (launchId) => store.launchSequences.getByLaunchId(launchId),
  getSession: (sessionId) => store.sessions.get(sessionId),
  projectByName: (name) => store.projects.getByName(name),
  // Required lazily: the session module pulls in the engine and tmux modules,
  // which a caller of this guard does not otherwise need loaded.
  finalizedByGovernedPath: (session) => require('./sessions').isFinalizedByGovernedPath(session)
});

/**
 * Whether a request is an ended launch asking about its own project, on a
 * route that allows that. Every fact is read here rather than taken from the
 * resolver's refusal reason: the launch exists, the project the request claims
 * is the launch's, the route's target project is that same project, and the
 * launch's session exists, belongs to that project, and was ended by this
 * same finalize path. An ACTIVE session never qualifies, so a superseded but
 * live launch is still refused as not current; nor does a session the wrap, a
 * kill or anything else ended.
 * @param {object} req - The request
 * @param {{method: string, pattern: string, params?: object}} matched - The matched route
 * @param {object} deps - Lookups (see {@link DEFAULT_DEPS})
 * @returns {boolean}
 */
function _endedOwnLaunch(req, matched, deps) {
  if (!ENDED_LAUNCH_ROUTES.has(`${String(matched.method).toUpperCase()} ${matched.pattern}`)) return false;
  const headers = (req && req.headers) || {};
  const launchId = headers[sharedDocsAccess.LAUNCH_HEADER];
  const claimed = headers[sharedDocsAccess.PROJECT_HEADER];
  if (typeof launchId !== 'string' || launchId === '') return false;
  if (typeof claimed !== 'string' || !/^\d+$/.test(claimed)) return false;
  const launch = deps.getLaunch(launchId);
  if (!launch || launch.projectId !== Number(claimed)) return false;
  const target = deps.projectByName(matched.params ? matched.params.project : undefined);
  if (!target || target.id !== launch.projectId) return false;
  const session = deps.getSession(launch.sessionId);
  if (!session || session.projectId !== launch.projectId) return false;
  // Ended is not enough. Only a session this same finalize path ended is one
  // whose teardown a repeat can have left to finish; a session the wrap, a
  // kill or a crash ended has nothing for its old launch to come back for.
  if (session.status !== store.SESSION_STATUS.WRAPPED) return false;
  return deps.finalizedByGovernedPath(session) === true;
}

/**
 * Say what a resolved binding is: verified, stale or unbound, with the cause
 * and the recovery. The one place that decides it, for the floor and for every
 * surface that reports it. Anything that is not positively a current project
 * launch or the live Master is not verified, an unknown kind included.
 * @param {{kind: string, reason?: (string|null), projectId?: (number|null), sessionId?: number}} resolved - From the
 *   resolver, for a caller who is not the operator
 * @param {object} deps - Lookups (see {@link DEFAULT_DEPS})
 * @returns {{state: string, reason: (string|null), role: (string|null), projectId: (number|null), sessionId: (number|null), cause: (string|null), recovery: (string|null)}}
 */
function _classify(resolved, deps) {
  const describe = (state, reason, role, projectId, sessionId) => ({
    state,
    reason,
    role,
    projectId,
    sessionId,
    cause: state === BINDING_STATES.VERIFIED ? null : causeFor(reason),
    recovery: recoveryFor(state, reason)
  });
  if (resolved.kind === KINDS.MASTER) return describe(BINDING_STATES.VERIFIED, null, 'master', null, null);
  if (resolved.kind === KINDS.UNBOUND) return describe(BINDING_STATES.UNBOUND, UNBOUND_REASON, null, null, null);
  if (resolved.kind !== KINDS.PROJECT) {
    return describe(BINDING_STATES.STALE, resolved.reason || 'invalid', null, null, null);
  }
  // An ACTIVE session that is not the project's current one is a launch that
  // was superseded without being ended. Its claims are internally consistent,
  // which is why the resolver passes it and this comparison is made here.
  const current = deps.currentSession(resolved.projectId);
  if (!current || current.id !== resolved.sessionId) {
    return describe(BINDING_STATES.STALE, SESSION_NOT_CURRENT, 'project', resolved.projectId, resolved.sessionId);
  }
  return describe(BINDING_STATES.VERIFIED, null, 'project', resolved.projectId, resolved.sessionId);
}

/**
 * The verdict on the launch binding a request carries, whoever else the
 * request is: a signed-in dashboard that also sends a launch id is told about
 * the launch id. Reads only; it admits and refuses nothing.
 * @param {object} req - The request
 * @param {object} [deps] - Lookups; defaults to the live resolver and store
 * @returns {{state: string, reason: (string|null), role: (string|null), projectId: (number|null), sessionId: (number|null), cause: (string|null), recovery: (string|null)}}
 *   `state` is one of {@link BINDING_STATES}. `cause` and `recovery` are null only for `verified`.
 */
function describeBinding(req, deps = DEFAULT_DEPS) {
  return _classify(deps.resolveBinding(req), deps);
}

/**
 * Decide whether a request may reach a mutating route's handler.
 * @param {object} req - The request, annotated by the dispatcher (`tcSession`, `tcGateActive`)
 * @param {{method: string, pattern: string, options?: object, serviceTokenVerified?: boolean}} matched - The matched
 *   route. `serviceTokenVerified` is exactly `true` only when the service-token gate is on and this
 *   request's token was checked against it.
 * @param {object} [deps] - Lookups; defaults to the live resolver and store
 * @returns {{allowed: true, via: string, access?: object}|{allowed: false, status: number, code: string, reason: string, message: string}}
 *   `via` says what admitted the request: `not-mutating`, an exception kind, `service-token`, or the caller kind.
 */
function judge(req, matched, deps = DEFAULT_DEPS) {
  if (!isMutating(matched.method)) return { allowed: true, via: 'not-mutating' };
  const exception = exceptionFor(matched.method, matched.pattern, matched.options);
  if (exception) return { allowed: true, via: exception.kind };
  if (matched.serviceTokenVerified === true
    && SERVICE_TOKEN_ROUTES.has(`${String(matched.method).toUpperCase()} ${matched.pattern}`)) {
    return { allowed: true, via: 'service-token' };
  }

  const access = deps.resolveAccess(req);
  if (access.kind === KINDS.OPERATOR || access.kind === KINDS.MASTER) {
    return { allowed: true, via: access.kind, access };
  }
  if (access.kind === KINDS.INVALID && access.reason === INVALID_REASONS.SESSION_NOT_ACTIVE
    && _endedOwnLaunch(req, matched, deps)) {
    return { allowed: true, via: 'ended-own-launch' };
  }
  const described = _classify(access, deps);
  if (described.state !== BINDING_STATES.VERIFIED) return _refuse(described);
  return { allowed: true, via: KINDS.PROJECT, access };
}

module.exports = {
  MUTATING_METHODS,
  EXCEPTION_KINDS,
  EXCEPTIONS,
  SERVICE_TOKEN_ROUTES,
  ENDED_LAUNCH_ROUTES,
  BINDING_STATES,
  DEFAULT_DEPS,
  isMutating,
  exceptionFor,
  causeFor,
  recoveryFor,
  describeBinding,
  judge
};
