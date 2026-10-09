'use strict';

/*
 * The operator bridge's HTTP surface (ADR 0023).
 *
 * Four callers, four proofs, and none stands in for another: the Project
 * Master by its live credential (`tc bridge`, Decision 15), the chat helper by
 * its scoped token, the operator by a verified account session, and a project
 * session by its verified launch, which may offer a candidate and nothing else.
 *
 * Every route is declared in {@link ROUTES} with the principal it belongs to,
 * and {@link handle} proves that principal before the route's handler runs. A
 * handler cannot be reached unauthenticated by forgetting a check, because it
 * has no check to forget: it is handed the proven caller.
 *
 * Every Master write names a request id and the version of the route it read.
 * Its first use is audited whether it is applied or refused; a repeat of the
 * same request id changes nothing and adds no row.
 */

const principal = require('./bridge-principal');
const adminCredential = require('./admin-credential');
const crypto = require('node:crypto');
const store = require('./store');
const bridgeStore = require('./bridge-store');
const bridgeReach = require('./bridge-reach');
const gateway = require('./bridge-gateway');
const bridgeNotify = require('./bridge-notify');
const sharedDocsAccess = require('./shared-docs-access');
const { resolveControlCaller } = require('./control-auth');
const { ROUTE_STATES, MAX_OUTBOUND_LENGTH } = require('./bridge-schema');
const ecosystemPrimer = require('./ecosystem-primer');
const { createLogger } = require('./logger');

const log = createLogger('bridge-api');

/** Header the helper presents its token in, and the one carrying a request's nonce. */
const HELPER_TOKEN_HEADER = 'x-tangleclaw-bridge-helper-token';
const HELPER_NONCE_HEADER = 'x-tangleclaw-bridge-nonce';

/** Shape of a route id. Anything else names no route, and is refused before it can reach a table. */
const ROUTE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Shape of a caller-supplied request id. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * A refusal in the API's error shape.
 * @param {number} status - HTTP status.
 * @param {string} code - Closed error code.
 * @param {string} error - One plain sentence.
 * @param {object} [extra] - Further fields for the body.
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, error, extra = {}) {
  return { status, body: { error, code, ...extra } };
}

/**
 * Refuse, and leave a trace of it: the code and nothing about the caller's
 * secret or message.
 * @param {string} who - Which principal's door was tried.
 * @param {number} status - HTTP status.
 * @param {string} code - Closed error code.
 * @param {string} error - One plain sentence.
 * @returns {{status: number, body: object}}
 */
function _refuseLogged(who, status, code, error) {
  log.warn('Bridge request refused', { principal: who, code });
  return _refuse(status, code, error);
}

/** Headers a proxy adds. A request that carries one did not come straight from the caller. */
const PROXY_HEADERS = Object.freeze(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via', 'x-real-ip']);

/**
 * Whether a request reached this server directly from this machine: a
 * loopback socket, and none of the headers a proxy leaves behind.
 *
 * The Master's credential and the helper's token travel in a header. Both
 * callers are on this machine, so the header never needs to cross a network
 * or pass through a proxy that could log it, and a request that did either is
 * refused before the header is even looked at.
 * @param {object} request - The request, with `req` and `headers`.
 * @returns {boolean}
 */
function _directLoopback(request) {
  const socket = request.req && request.req.socket;
  if (!adminCredential.isLoopbackRemote(socket ? socket.remoteAddress : undefined)) return false;
  const headers = request.headers || {};
  return !PROXY_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * How a request that will be answered with a secret reached this server, or
 * null when it came in a way the secret must not travel.
 *
 * The helper token is returned once, in the body of the answer that creates
 * it. So that answer is given only where nobody between here and the browser
 * can read it: over TLS this server itself terminated, to a request made
 * directly on this machine, or through a proxy on this machine that says the
 * browser reached it over https. What a proxy says is believed only from a
 * loopback peer: the same header from anywhere else is the caller's own claim.
 * @param {object} request - The request, with `req` and `headers`.
 * @returns {('https'|'loopback'|'https-proxied'|null)}
 */
function _secretTransport(request) {
  const req = request.req || {};
  const socket = req.socket || null;
  if (socket && socket.encrypted === true) return 'https';
  if (!adminCredential.isLoopbackRemote(socket ? socket.remoteAddress : undefined)) return null;
  const headers = { ...(req.headers || {}), ...(request.headers || {}) };
  if (!PROXY_HEADERS.some((name) => headers[name] !== undefined)) return 'loopback';
  const proto = headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https' ? 'https-proxied' : null;
}

/**
 * The refusal for a credentialed request that did not come directly from this machine.
 * @param {string} who - Principal name, for the log.
 * @returns {{refusal: object}}
 */
function _loopbackOnly(who) {
  return {
    refusal: _refuseLogged(who, 403, 'LOOPBACK_REQUIRED',
      'This route is answered only for a request made directly from this machine: not over the network and not through a proxy.')
  };
}

/**
 * Refuse when the operator has not enabled the bridge.
 * @returns {object|null} The refusal, or null when enabled.
 */
function _disabled() {
  if (bridgeStore.settings.isEnabled()) return null;
  return _refuse(409, 'BRIDGE_DISABLED',
    'The operator bridge is disabled. Enabling it is the operator\'s alone, from a signed-in account session; nothing on this surface can.');
}

/**
 * How many requests a minute one proven caller may make, by class of route.
 * A caller is a helper token, or a session's launch. The bounds are far above
 * what either does in ordinary work: a helper polling every five seconds and
 * posting a long item makes a few dozen requests a minute. They are there so
 * that a caller gone wrong cannot fill the store or the log: a request over
 * the bound is refused before anything is written for it, its nonce included,
 * and the refusal is logged once a minute for each caller, not once a request.
 *
 * The operator's own messages have a bucket to themselves. What the helper
 * does on the outbound side cannot spend it, so a helper gone wrong there
 * does not cost the operator a message.
 */
const RATE_LIMITS = Object.freeze({
  helper: Object.freeze({ perMinute: 600, key: (caller) => `helper:${caller.tokenId}` }),
  inbound: Object.freeze({ perMinute: 120, key: (caller) => `inbound:${caller.tokenId}` }),
  preflight: Object.freeze({ perMinute: 6, key: (caller) => `preflight:${caller.tokenId}` }),
  candidate: Object.freeze({ perMinute: 12, key: (caller) => `candidate:${caller.projectId}:${caller.launchId}` })
});

/** When each caller's recent requests were admitted, by class. In memory: a restart forgets, which errs towards admitting. */
const _admitted = new Map();

/** When each caller was last logged as over its limit. */
const _refusedLoggedAt = new Map();

/** Past this many callers, those with nothing in the last minute are dropped. */
const ADMITTED_SWEEP_AT = 256;

/**
 * Drop every caller with no request in the last minute.
 * @param {number} now - The time, in milliseconds.
 * @returns {void}
 */
function _sweepAdmitted(now) {
  for (const [key, times] of _admitted) {
    if (!times.length || now - times[times.length - 1] >= 60000) _admitted.delete(key);
  }
  for (const [key, at] of _refusedLoggedAt) {
    if (now - at >= 60000) _refusedLoggedAt.delete(key);
  }
}

/**
 * Count a request against its caller's limit, and say whether it is within it.
 * @param {string} name - A key of {@link RATE_LIMITS}.
 * @param {{perMinute: number, key: function(object): string}} limit - The limit.
 * @param {object} caller - The proven caller.
 * @returns {boolean} False when the caller has made its minute's worth already.
 */
function _admit(name, limit, caller) {
  const now = Date.parse(gateway._deps.now());
  const key = limit.key(caller);
  if (_admitted.size >= ADMITTED_SWEEP_AT && !_admitted.has(key)) _sweepAdmitted(now);
  const recent = (_admitted.get(key) || []).filter((at) => now - at < 60000);
  if (recent.length >= limit.perMinute) {
    _admitted.set(key, recent);
    return false;
  }
  recent.push(now);
  _admitted.set(key, recent);
  return true;
}

/**
 * Count a request against its route's limit, and refuse it when its caller is
 * over. Writes nothing to the store either way.
 * @param {object} entry - The route's declaration.
 * @param {object} caller - The proven caller.
 * @returns {object|null} The refusal, or null when the request is admitted or the route has no limit.
 */
function _overLimit(entry, caller) {
  const limit = RATE_LIMITS[entry.rate];
  if (!limit || _admit(entry.rate, limit, caller)) return null;
  const key = limit.key(caller);
  const now = Date.parse(gateway._deps.now());
  const logged = _refusedLoggedAt.get(key);
  if (logged === undefined || now - logged >= 60000) {
    _refusedLoggedAt.set(key, now);
    log.warn('Bridge request refused', { principal: entry.principal, code: 'RATE_LIMITED' });
  }
  return _refuse(429, 'RATE_LIMITED', `No more than ${limit.perMinute} such requests a minute are taken from one caller.`);
}

/**
 * Each principal's proof. Given the request and the route's declaration, each
 * returns `{caller}` or `{refusal}`. A principal that writes while proving
 * (the helper, whose nonce is recorded) counts the request against its limit
 * first and says so with `admitted`; for the others {@link handle} counts it.
 */
const PRINCIPALS = Object.freeze({
  /**
   * The Project Master: the live generation's credential.
   * @param {object} request - The request.
   * @param {object} entry - The route's declaration.
   * @returns {{caller: object}|{refusal: object}}
   */
  master(request, entry) {
    if (!_directLoopback(request)) return _loopbackOnly('master');
    const master = principal.verify(request.headers ? request.headers[principal.CREDENTIAL_HEADER] : undefined);
    // A credential outlives nothing: once tmux says there is no Master, the
    // credential it was given is revoked on the spot and the request refused.
    // When tmux does not answer, a live Master keeps what it was given.
    const liveness = master ? gateway._deps.master().masterLiveness() : null;
    const gone = Boolean(liveness && liveness.answered && !liveness.live);
    if (gone) principal.revokeAll('master-not-live');
    if (!master || gone) {
      return {
        refusal: _refuseLogged('master', 401, 'BRIDGE_CREDENTIAL_REQUIRED',
          'This surface is the Project Master\'s, and the request did not carry the live Master\'s bridge credential. '
          + 'A Master launched before the bridge existed, or relaunched since, has to be relaunched to hold one.')
      };
    }
    const off = entry.whileDisabled ? null : _disabled();
    return off ? { refusal: off } : { caller: master };
  },

  /**
   * The chat helper: the active scoped token, and on a write a nonce that has
   * not been seen.
   * @param {object} request - The request.
   * @param {object} entry - The route's declaration.
   * @returns {{caller: object}|{refusal: object}}
   */
  helper(request, entry) {
    if (!_directLoopback(request)) return _loopbackOnly('helper');
    const headers = request.headers || {};
    const helper = gateway.verifyHelperToken(headers[HELPER_TOKEN_HEADER]);
    if (!helper) {
      return {
        refusal: _refuseLogged('helper', 401, 'HELPER_TOKEN_REQUIRED',
          'This route is the chat helper\'s, and the request did not carry the active helper token.')
      };
    }
    // Counted here, once the token is proven and before the nonce is
    // recorded: a request over the limit leaves no row and spends no nonce.
    const over = _overLimit(entry, helper);
    if (over) return { refusal: over };
    const off = entry.whileDisabled ? null : _disabled();
    if (off) return { refusal: off };
    // A route that only reads writes nothing, a nonce included.
    if (entry.method !== 'GET' && entry.nonce !== 'none') {
      const nonce = headers[HELPER_NONCE_HEADER];
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
        return { refusal: _refuseLogged('helper', 400, 'NONCE_REQUIRED', 'A helper write needs a nonce of 16 to 128 URL-safe characters.') };
      }
      // A claim's nonce names it, so that asking again returns the same
      // answer: its handler records the nonce with the claim. Every other
      // write is refused the second time it is seen.
      if (entry.nonce === 'names-the-request') return { caller: { ...helper, nonce }, admitted: true };
      if (!bridgeStore.nonces.claim(nonce)) return { refusal: _refuseLogged('helper', 409, 'NONCE_REUSED', 'That nonce was already used.') };
    }
    return { caller: helper, admitted: true };
  },

  /**
   * A project session: a verified launch, by the binding every pane carries.
   * It may offer the Master a candidate and nothing else, and it holds no
   * bridge credential.
   * @param {object} request - The request; `request.req` is the HTTP request.
   * @returns {{caller: object}|{refusal: object}}
   */
  session(request) {
    const access = sharedDocsAccess.resolveAccess(request.req || { headers: request.headers || {} });
    if (access.kind !== sharedDocsAccess.KINDS.PROJECT || !Number.isInteger(access.projectId) || !access.launchId) {
      return {
        refusal: _refuseLogged('session', 403, 'VERIFIED_LAUNCH_REQUIRED',
          'Offering a candidate needs a verified project launch: this pane\'s own project id and launch id.')
      };
    }
    const off = _disabled();
    return off ? { refusal: off } : { caller: { projectId: access.projectId, launchId: access.launchId } };
  },

  /**
   * The operator: signed in with an account session. A request that merely
   * looks like the dashboard while the gate is open is not enough to read or
   * change bridge policy.
   * @param {object} request - The request; `request.req` is the HTTP request as `server.js` annotated it.
   * @returns {{caller: object}|{refusal: object}}
   */
  operator(request) {
    const req = request.req || {};
    const caller = resolveControlCaller(req);
    if (caller.kind !== 'operator' || !caller.actor || caller.actor.operatorProof !== 'verified-session') {
      return {
        refusal: _refuseLogged('operator', 403, 'OPERATOR_SESSION_REQUIRED',
          'Changing or reading bridge policy needs the operator signed in with an account session. '
          + 'An open gate or a dashboard-shaped request is not enough.')
      };
    }
    const session = req.tcSession || {};
    return { caller: { user: session.username || (session.userId != null ? String(session.userId) : null) } };
  }
});

/**
 * `GET status`: whether the bridge is enabled and which generation is asking.
 * Answers while disabled, so Master can tell "off" from "broken".
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @returns {{status: number, body: object}}
 */
function status(request, master) {
  const enabled = bridgeStore.settings.isEnabled();
  return {
    status: 200,
    body: {
      enabled,
      masterGeneration: master.generation,
      proof: master.proof,
      // Said here as well as in the list: an unresolved scope reaches nothing, and an empty list alone would not say why.
      scope: bridgeReach.scopeSummary(),
      // The true count, enabled or not: a disabled bridge's open routes are what
      // the Master is there to close.
      openRoutes: bridgeStore.routes.list().length,
      configurationCircuit: bridgeStore.circuit.open()
    }
  };
}

/**
 * A route as the Master is shown it: with where the gateway suggested it might
 * go. The suggestion is advice. Nothing is sent on it; only the Master's own
 * route write gives a route a destination.
 * @param {object} route - A route.
 * @returns {object} The route, with `suggestion` (null when the gateway never made one),
 *   `openQuestion` (what the operator has been asked about it and not yet answered, or null) and
 *   `launch` (the newest launch consented to for it, or null).
 */
function _withSuggestion(route) {
  const asked = bridgeStore.questions.openFor(route.routeId);
  const launch = bridgeStore.launches.latestFor(route.routeId);
  return {
    ...route,
    suggestion: bridgeStore.audit.suggestionFor(route.routeId),
    openQuestion: asked ? {
      questionId: asked.questionId, purpose: asked.purpose, projectId: asked.targetProjectId, askedAt: asked.askedAt, expiresAt: asked.expiresAt
    } : null,
    // The launch the operator consented to for this message, as it stands: queued, in flight, or how it ended.
    launch: launch ? {
      launchSeq: launch.launchSeq, projectId: launch.projectId, state: launch.state, failureCode: launch.failureCode,
      requestedAt: launch.requestedAt, startedAt: launch.startedAt, settledAt: launch.settledAt
    } : null
  };
}

/**
 * `GET routes`: routes awaiting attention, oldest first, without bodies.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} [request.query] - `states`: comma-separated route states.
 * @returns {{status: number, body: object}}
 */
function listRoutes(request) {
  const raw = request.query && typeof request.query.states === 'string' ? request.query.states : '';
  const states = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = states.filter((s) => !ROUTE_STATES.includes(s));
  if (unknown.length) {
    return _refuse(400, 'UNKNOWN_ROUTE_STATE', `Unknown route state: ${unknown.join(', ')}.`, { states: ROUTE_STATES });
  }
  return { status: 200, body: { routes: bridgeStore.routes.list({ states }).map(_withSuggestion) } };
}

/**
 * `GET routes/:routeId`: one route with the bodies still held and its audit.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @returns {{status: number, body: object}}
 */
function readRoute(request) {
  const route = ROUTE_ID.test(request.params.routeId) ? bridgeStore.routes.get(request.params.routeId) : null;
  if (!route) return _refuse(404, 'ROUTE_NOT_FOUND', 'No such route.');
  return {
    status: 200,
    body: {
      route: _withSuggestion(route),
      // What the operator wrote is conversation. It grants nothing, whatever it asks for.
      authority: 'conversation-only',
      bodies: bridgeStore.routes.bodies(route.routeId),
      audit: bridgeStore.audit.forRoute(route.routeId)
    }
  };
}

/**
 * Validate the two fields every write carries.
 * @param {object} body - Request body.
 * @returns {{requestId: string, expectedVersion: number}|{refusal: object}}
 */
function _writeFields(body) {
  const requestId = body && body.requestId;
  const expectedVersion = body && body.expectedVersion;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    return { refusal: _refuse(400, 'REQUEST_ID_REQUIRED', 'A write needs a requestId of 8 to 128 letters, digits, dots, colons, dashes or underscores.') };
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { refusal: _refuse(400, 'EXPECTED_VERSION_REQUIRED', 'A write needs expectedVersion: the version of the route or candidate as you last read it.') };
  }
  return { requestId, expectedVersion };
}

/** HTTP status for each outcome a route write can have. Anything unlisted is a 409 refusal. */
const WRITE_STATUS = Object.freeze({
  applied: 200,
  'route-not-found': 404
});

/**
 * Shape a route write's result as a response.
 * @param {{outcome: string, replayed: boolean, route: (object|null)}} result - From `applyRouteWrite`.
 * @returns {{status: number, body: object}}
 */
function _writeResponse(result) {
  // The Master moved the route: any send of the gateway's it no longer waits on is ended.
  if (result.outcome === 'applied' && result.route) gateway.settleSends(result.route.routeId);
  const status = WRITE_STATUS[result.outcome] || 409;
  const body = { outcome: result.outcome, replayed: result.replayed, route: result.route };
  if (status !== 200) {
    body.code = result.outcome.toUpperCase().replace(/-/g, '_');
    body.error = `The write was not applied: ${result.outcome}.`;
  }
  return { status, body };
}

/**
 * `POST routes/:routeId/close`: Master closes a route explicitly (Decision 7).
 * The bodies still held for it are cleared, and anything released for it and
 * not yet posted is withdrawn, in the same transaction. What was delivered is
 * history and is not unsent. A route with an item in the helper's hands is
 * refused `409 OUTBOUND_IN_FLIGHT`. Allowed
 * while the bridge is disabled, so that turning the bridge off never leaves
 * message text held with no way to let it go.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @param {string} [request.at] - Timestamp override (tests).
 * @returns {{status: number, body: object}}
 */
function closeRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  // The gateway's clock: a lease was issued by it, and is judged live or lapsed by it.
  const at = request.at || gateway._deps.now();
  const result = bridgeStore.applyRouteWrite({
    op: 'close', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: master.proof, masterGeneration: master.generation, at,
    change: (route) => {
      if (route.state === 'closed') return { refuse: 'already-closed' };
      // Closing withdraws what was released and not yet posted. With a live
      // lease the helper may be posting it now, and a close that succeeded
      // would be followed by the post it was meant to prevent: refused, to be
      // asked again once the lease has settled.
      bridgeStore.leases.lapse({ at });
      if (bridgeStore.outbound.inFlight(route.routeId)) return { refuse: 'outbound-in-flight' };
      return { set: { state: 'closed', closed_by: 'master', closed_at: at }, withdraw: true, clearBodies: true, detail: { from: route.state } };
    }
  });
  return _writeResponse(result);
}

/**
 * Whether text is fit to hand to a chat: printable, with no control characters
 * beyond newline and tab and no bidirectional overrides that could reorder
 * what the operator reads.
 * @param {string} text - Candidate text.
 * @returns {boolean}
 */
function _displaySafe(text) {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(text);
}

/** How a destination the Master named is refused, by why it names nothing the bridge may reach. */
const UNREACHABLE = Object.freeze({
  unknown: [400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, name, slug or nickname. tc bridge destinations lists them.'],
  archived: [400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, name, slug or nickname. tc bridge destinations lists them.'],
  ambiguous: [409, 'DESTINATION_AMBIGUOUS', 'That names more than one destination. Use a project id.'],
  'scope-unresolved': [409, 'SCOPE_UNRESOLVED', 'The Project Master\'s scope names a project group that cannot be resolved, so no project is reachable. It is the operator\'s to put right in the Master settings.'],
  'out-of-scope': [409, 'DESTINATION_OUT_OF_SCOPE', 'That project is outside the Project Master\'s scope.'],
  'opted-out': [409, 'DESTINATION_OPTED_OUT', 'That project is out of reach of the bridge by the operator\'s choice.']
});

/**
 * Read a destination the Master named, as something the bridge may reach.
 * @param {*} to - What the Master sent.
 * @returns {{destination: object}|{refusal: {status: number, body: object}}}
 */
function _reachable(to) {
  const found = bridgeReach.resolve(to);
  if (found.destination) return found;
  const [status, code] = UNREACHABLE[found.refusal];
  return { refusal: _refuse(status, code, _whyUnreachable(code)) };
}

/**
 * The sentence a destination that cannot be reached is refused with, for
 * every write that names one. An unresolved scope says which thing is wrong
 * with it, as it stands now.
 * @param {string} code - A code from {@link UNREACHABLE}.
 * @returns {string|null} Null for a code that is not about reach.
 */
function _whyUnreachable(code) {
  const entry = Object.values(UNREACHABLE).find((known) => known[1] === code);
  if (!entry) return null;
  if (code !== 'SCOPE_UNRESOLVED') return entry[2];
  return `The Project Master's scope cannot be resolved (${bridgeReach.scopeSummary().why}), so no project is reachable. It is the operator's to put right in the Master settings.`;
}

/**
 * Put a Master write that was refused before it reached the route on the
 * audit, so that every Master write leaves a row whether it was applied or
 * refused. Ids and the closed code only.
 * @param {object} w - What {@link _masterWrite} returned.
 * @param {string} op - The operation.
 * @param {{status: number, body: object}} refusal - The refusal being answered.
 * @returns {{status: number, body: object}} The same refusal.
 */
function _refusedWrite(w, op, refusal) {
  bridgeStore.audit.append({
    op, actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, routeId: w.routeId,
    expectedVersion: w.fields.expectedVersion, outcome: String(refusal.body.code || 'refused').toLowerCase().replace(/_/g, '-'), at: gateway._deps.now()
  });
  return refusal;
}

/**
 * `GET destinations`: every project the bridge may reach, with each way of
 * naming it and whether it is running. Worked out from the registry as it is
 * asked for. Answers while the bridge is disabled.
 * @returns {{status: number, body: object}}
 */
function listDestinations() {
  return { status: 200, body: bridgeReach.destinations() };
}

/**
 * The fields every Master write carries, validated.
 * @param {object} request - The request.
 * @param {object} master - The proven Master.
 * @returns {{master: object, fields: object, routeId: string}|{refusal: object}}
 */
function _masterWrite(request, master) {
  const fields = _writeFields(request.body);
  if (fields.refusal) return { refusal: fields.refusal };
  const routeId = request.params.routeId;
  // An id that could not be a route's is refused here: it could not be
  // recorded against the audit either, so there is nothing to apply or audit.
  if (!ROUTE_ID.test(routeId)) return { refusal: _refuse(404, 'ROUTE_NOT_FOUND', 'No such route.') };
  return { master, fields, routeId };
}

/**
 * `POST routes/:routeId/route`: Master names the destination of a route that
 * is waiting for it. The gateway then carries the message there.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, to, answeredBy?}`; `to` is `master`, a project id or an exact
 *   project name. `answeredBy` is the route of the operator message the Master takes as the answer to the clarifying
 *   question it asked about this one: it must be recorded as a reply to that very question, and its route is closed with this write.
 * @returns {Promise<{status: number, body: object}>}
 */
async function routeTo(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const reach = _reachable(request.body.to);
  if (reach.refusal) return _refusedWrite(w, 'route', reach.refusal);
  const destination = reach.destination;
  const answeredBy = request.body.answeredBy;
  if (answeredBy !== undefined && (typeof answeredBy !== 'string' || !ROUTE_ID.test(answeredBy))) {
    return _refuse(400, 'BAD_ANSWERED_BY', 'answeredBy is the route id of the operator message that answered your question.');
  }
  // A project with no session to receive it is said to be that, before anything
  // moves: the message stays held, and the Master can ask the operator whether
  // to launch one. Nothing is ever launched by routing.
  // More than one live session is an anomaly, and which one a message is for is never guessed.
  const standing = destination.kind === 'project' ? bridgeReach.liveness(destination.projectId).state : 'live';
  if (standing === 'several-live') {
    return _refusedWrite(w, 'route', _refuse(409, 'TARGET_AMBIGUOUS', `${destination.label} has more than one live session. The message stays held: ask the operator which is meant, or to end the others.`));
  }
  if (standing !== 'live') {
    return _refusedWrite(w, 'route', _refuse(409, 'TARGET_OFFLINE', `${destination.label} has no live session to receive it. The message stays held: ${standing === 'not-running'
      ? 'ask the operator whether to launch one with tc bridge ask-launch.' : 'a session is running that cannot be sent to, which is the operator\'s to look at.'}`));
  }
  const result = bridgeStore.applyRouteWrite({
    op: 'route', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    // The gateway's clock: a question was asked by it, and is judged answerable or out of time by it.
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, at: gateway._deps.now(),
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      return {
        set: {
          state: 'accepted', resolved_by: 'master', destination_kind: destination.kind,
          destination_project_id: destination.projectId, resolved_generation: w.master.generation, failure_code: null
        },
        ...(answeredBy ? { adopt: { replyRouteId: answeredBy, for: 'route', purposes: ['clarify'] } } : {}),
        detail: { to: destination.kind, projectId: destination.projectId }
      };
    }
  });
  if (result.outcome === 'applied' && !result.replayed) result.route = await gateway.advance(w.routeId);
  return _writeResponse(result);
}

/**
 * `POST routes/:routeId/ask`: the Master asks the operator something about a
 * message it has not routed yet. The message stays held, exactly as it is, and
 * nothing is sent anywhere but the question itself, to the operator, as a
 * reply to their message. One question at a time: a second is refused
 * `409 QUESTION_OPEN` until the first is answered, runs out, or the message
 * stops waiting.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, text}`.
 * @returns {{status: number, body: object}}
 */
function askRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const text = request.body.text;
  if (typeof text !== 'string' || !text.trim()) return _refuse(400, 'QUESTION_REQUIRED', 'A question needs text.');
  if (text.length > MAX_OUTBOUND_LENGTH) return _refuse(413, 'QUESTION_TOO_LONG', `A question may be at most ${MAX_OUTBOUND_LENGTH} characters.`);
  if (!_displaySafe(text)) return _refuse(400, 'QUESTION_NOT_DISPLAY_SAFE', 'The question contains control or text-direction characters.');
  const result = bridgeStore.applyRouteWrite({
    op: 'ask', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, at: gateway._deps.now(),
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      return {
        ask: { questionId: gateway._deps.id('q'), purpose: 'clarify', text, digest: bridgeStore.digest(text), sourceLabel: 'Project Master' },
        detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * A caller's `answeredBy`, read: the route id of an operator message.
 * @param {object} body - The request body.
 * @returns {{answeredBy: string}|{refusal: object}}
 */
function _answeredBy(body) {
  const answeredBy = body ? body.answeredBy : undefined;
  if (typeof answeredBy !== 'string' || !ROUTE_ID.test(answeredBy)) {
    return { refusal: _refuse(400, 'BAD_ANSWERED_BY', 'answeredBy is the route id of the operator message that answered your question.') };
  }
  return { answeredBy };
}

/**
 * `POST routes/:routeId/ask-launch`: the Master asks the operator whether to
 * launch a session for a project that is not running, so that a held message
 * can go to it. Nothing is launched by asking. The question's words are the
 * server's, fixed, so a launch question can never be made to ask anything else.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, project}`; `project` is a project id or an exact project name.
 * @returns {{status: number, body: object}}
 */
function askLaunch(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const reach = request.body.project === 'master' ? { refusal: _refuse(...UNREACHABLE.unknown) } : _reachable(request.body.project);
  if (reach.refusal) return _refusedWrite(w, 'ask-launch', reach.refusal);
  const destination = reach.destination;
  if (destination.kind !== 'project') return _refusedWrite(w, 'ask-launch', _refuse(...UNREACHABLE.unknown));
  const standing = bridgeReach.liveness(destination.projectId).state;
  if (standing === 'live') {
    return _refusedWrite(w, 'ask-launch', _refuse(409, 'TARGET_LIVE', `${destination.label} is running: there is nothing to launch. Route the message with tc bridge route.`));
  }
  if (standing === 'several-live') {
    return _refusedWrite(w, 'ask-launch', _refuse(409, 'TARGET_AMBIGUOUS', `${destination.label} has more than one live session. There is nothing to launch: ask the operator which is meant, or to end the others.`));
  }
  // Running, but nothing a message can be sent to: a launch would start nothing.
  if (standing === 'unreachable') {
    return _refusedWrite(w, 'ask-launch', _refuse(409, 'TARGET_UNREACHABLE', `${destination.label} has a session running that cannot be reached over Medusa. There is nothing to launch: it is the operator's to look at.`));
  }
  const text = `${destination.label} is not running. Would you like me to launch it?`;
  const result = bridgeStore.applyRouteWrite({
    op: 'ask-launch', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, at: gateway._deps.now(),
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      if (bridgeStore.launches.unsettledFor(route.routeId)) return { refuse: 'launch-in-progress' };
      return {
        ask: {
          questionId: gateway._deps.id('q'), purpose: 'launch', targetProjectId: destination.projectId,
          text, digest: bridgeStore.digest(text), sourceLabel: 'Project Master'
        },
        detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST routes/:routeId/launch`: the Master adopts the operator's reply as
 * consent to the launch it asked about. This records the decision and
 * launches nothing itself: the server starts the session, in turn, waits for
 * it to be ready and to be the session it started, and only then sends the
 * held message on, to that project, as it was written.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, answeredBy}`.
 * @returns {{status: number, body: object}}
 */
function launchFor(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const named = _answeredBy(request.body);
  if (named.refusal) return named.refusal;
  const result = bridgeStore.applyRouteWrite({
    op: 'launch', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, at: gateway._deps.now(),
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      // The route stays held: it is the server, later, that sends it on.
      return { adopt: { replyRouteId: named.answeredBy, for: 'launch', purposes: ['launch'] }, detail: { from: route.state } };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST routes/:routeId/decline`: the operator said no, or cancel, in reply
 * to a question. The question is settled on that reply, the reply's route is
 * closed, and the held message is closed with its text cleared: nothing is
 * launched and nothing is sent on.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, answeredBy}`.
 * @returns {{status: number, body: object}}
 */
function declineRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const named = _answeredBy(request.body);
  if (named.refusal) return named.refusal;
  const at = gateway._deps.now();
  const result = bridgeStore.applyRouteWrite({
    op: 'decline', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation, at,
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      return {
        set: { state: 'closed', closed_by: 'master', closed_at: at, failure_code: null },
        adopt: { replyRouteId: named.answeredBy, for: 'decline', purposes: ['launch', 'clarify'] },
        withdraw: true, clearBodies: true, detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * Release an answer for a route: the one path by which anything a route
 * produced reaches the operator. The answer is Master's, whatever its source.
 * @param {object} w - What {@link _masterWrite} returned.
 * @param {string} op - `answer` or `release`.
 * @param {(route: object) => ({text: string, label: string}|{refuse: string})} source - Where the text comes from.
 * @returns {{status: number, body: object}}
 */
function _release(w, op, source) {
  const result = bridgeStore.applyRouteWrite({
    op, requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation,
    change: (route) => {
      const from = source(route);
      if (from.refuse) return { refuse: from.refuse, detail: { state: route.state } };
      return {
        set: { state: 'released' },
        body: { role: 'answer', text: from.text, digest: bridgeStore.digest(from.text) },
        outbound: {
          idemKey: `route:${route.routeId}:answer`, kind: 'reply', sourceLabel: from.label, text: from.text,
          digest: bridgeStore.digest(from.text), releasedGeneration: w.master.generation
        },
        detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST routes/:routeId/answer`: Master answers the operator in its own words.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, text}`.
 * @returns {{status: number, body: object}}
 */
function answerRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const text = request.body.text;
  if (typeof text !== 'string' || !text.trim()) return _refuse(400, 'ANSWER_REQUIRED', 'An answer needs text.');
  if (text.length > MAX_OUTBOUND_LENGTH) return _refuse(413, 'ANSWER_TOO_LONG', `An answer may be at most ${MAX_OUTBOUND_LENGTH} characters.`);
  if (!_displaySafe(text)) return _refuse(400, 'ANSWER_NOT_DISPLAY_SAFE', 'The answer contains control or text-direction characters.');
  // Not from `awaiting-master`: a route nobody has routed is not the Master's
  // to answer yet, its own included. It routes the message to itself first, so
  // that every answer has a routing decision behind it on the audit.
  return _release(w, 'answer', (route) => (
    ['routed', 'reply-held'].includes(route.state)
      // A route whose send could not be confirmed is the Master's to answer
      // too: it will never be sent again, so somebody has to speak for it.
      || (route.state === 'accepted' && route.failureCode === gateway.SEND_UNCONFIRMED)
      ? { text, label: 'Project Master' }
      : { refuse: 'not-answerable' }
  ));
}

/**
 * `POST routes/:routeId/release`: Master sends on, unchanged, the reply a
 * destination gave and the gateway is holding.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @returns {{status: number, body: object}}
 */
function releaseRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  return _release(w, 'release', (route) => {
    if (route.state !== 'reply-held') return { refuse: 'no-reply-held' };
    const held = bridgeStore.routes.body(route.routeId, 'reply');
    if (!held || !held.text) return { refuse: 'no-reply-held' };
    if (!_displaySafe(held.text)) return { refuse: 'reply-not-display-safe' };
    const project = route.destination && route.destination.projectId ? store.projects.get(route.destination.projectId) : null;
    return { text: held.text, label: `Project Master, relaying ${project ? project.name : 'a session'}`.slice(0, 80) };
  });
}

/**
 * `POST routes/:routeId/pin`: Master pins the route's conversation to a
 * destination. Conversation-scoped only; a global pin is the operator's.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, to}`.
 * @returns {{status: number, body: object}}
 */
function pinRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const reach = _reachable(request.body.to);
  if (reach.refusal) return _refusedWrite(w, 'pin', reach.refusal);
  const destination = reach.destination;
  const result = bridgeStore.applyRouteWrite({
    op: 'pin', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation,
    change: (route) => {
      if (route.state === 'closed') return { refuse: 'already-closed' };
      return {
        set: {},
        pin: {
          pinId: `pin_${crypto.randomBytes(9).toString('base64url')}`, conversationKey: gateway.conversationKey(route.context),
          destination: { kind: destination.kind, projectId: destination.projectId }
        },
        detail: { to: destination.kind, projectId: destination.projectId }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST helper/inbound`: the helper hands over one operator message.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.body - The message; see `bridge-gateway#acceptInbound`.
 * @returns {Promise<{status: number, body: object}>}
 */
async function helperInbound(request) {
  return gateway.acceptInbound(request.body);
}

/**
 * `POST helper/preflight`: what the helper can check about the bridge before
 * it is switched on, without changing anything. It answers only the holder of
 * the live helper token, from this machine, and only in yes, no and a closed
 * word: no id, no token, no text and nothing about any message.
 *
 * `allowlistMatch` is one answer for all three ids together, so it cannot be
 * used to find out which of them differs.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} [request.body] - `{authorId, spaceId, channelId}`: the ids the helper is configured with.
 * @returns {{status: number, body: object}}
 */
function helperPreflight(request) {
  const body = request.body || {};
  const allowed = gateway.allowlist();
  const given = ['authorId', 'spaceId', 'channelId'].every((field) => typeof body[field] === 'string' && gateway.CHAT_ID.test(body[field]));
  return {
    status: 200,
    body: {
      tokenLive: true,
      bridgeEnabled: bridgeStore.settings.isEnabled(),
      allowlistSet: Boolean(allowed),
      allowlistMatch: Boolean(allowed && given && allowed.authorId === body.authorId && allowed.spaceId === body.spaceId && allowed.channelId === body.channelId),
      circuit: bridgeStore.circuit.open() ? 'open' : 'closed'
    }
  };
}

/**
 * `POST helper/outbound/claim`: the helper collects what to post next. Each
 * item comes under a lease; the request's nonce names the claim, so asking
 * again with the same nonce returns the same leases.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} [request.body] - `{limit}`: at most this many.
 * @param {{tokenId: string, nonce: string}} helper - The verified helper.
 * @returns {{status: number, body: object}}
 */
function helperClaim(request, helper) {
  return gateway.claimOutbound(helper, helper.nonce, { limit: request.body ? request.body.limit : undefined });
}

/**
 * The item a helper route names, or a refusal when it could not be one.
 * @param {object} request - The request.
 * @returns {{outboundId: number}|{refusal: object}}
 */
function _outboundId(request) {
  if (!/^\d{1,12}$/.test(String(request.params.outboundId))) return { refusal: _refuse(404, 'OUTBOUND_NOT_FOUND', 'No such outbound item.') };
  return { outboundId: Number(request.params.outboundId) };
}

/**
 * `POST helper/outbound/:outboundId/parts`: the chat confirmed one message of an item.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `outboundId`.
 * @param {object} request.body - `{leaseId, partIndex, partCount, externalId}`.
 * @param {{tokenId: string}} helper - The verified helper.
 * @returns {{status: number, body: object}}
 */
function helperPart(request, helper) {
  const named = _outboundId(request);
  if (named.refusal) return named.refusal;
  const body = request.body || {};
  return gateway.recordPart(named.outboundId, {
    leaseId: body.leaseId, tokenId: helper.tokenId, partIndex: body.partIndex, partCount: body.partCount, externalId: body.externalId
  });
}

/**
 * `POST helper/outbound/:outboundId/ack`: the chat confirmed every message of
 * an item. The set seals the item, so it is always given whole, with its
 * count: nothing but `parts` and `partCount` is passed on, so a body that
 * names a single message some other way is refused as malformed.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `outboundId`.
 * @param {object} request.body - `{leaseId, parts, partCount}`: the lease the item was claimed under, and the chat's id for each posted message, in order, with how many there are.
 * @param {{tokenId: string}} helper - The verified helper.
 * @returns {{status: number, body: object}}
 */
function helperAck(request, helper) {
  const named = _outboundId(request);
  if (named.refusal) return named.refusal;
  const body = request.body || {};
  return gateway.acknowledgeOutbound(named.outboundId, undefined, {
    leaseId: body.leaseId, tokenId: helper.tokenId, parts: body.parts, partCount: body.partCount
  });
}

/**
 * `POST helper/outbound/:outboundId/failure`: the helper could not post an item.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `outboundId`.
 * @param {object} request.body - `{leaseId, reason, parts?, partCount?}`.
 * @param {{tokenId: string}} helper - The verified helper.
 * @returns {{status: number, body: object}}
 */
function helperFailure(request, helper) {
  const named = _outboundId(request);
  if (named.refusal) return named.refusal;
  const body = request.body || {};
  return gateway.reportFailure(named.outboundId, {
    leaseId: body.leaseId, tokenId: helper.tokenId, reason: body.reason, parts: body.parts, partCount: body.partCount
  });
}

/** How each outcome of a decision about a set-aside item is answered. */
const OUTBOUND_WRITE_STATUS = Object.freeze({
  applied: 200, 'outbound-not-found': 404, 'not-blocked': 409, 'not-waiting': 409, 'outbound-in-flight': 409, 'request-id-reused': 409
});

/**
 * Decide what becomes of an item: put a set-aside one back, or withdraw one
 * that has not been posted. The Project Master's and the operator's alike.
 * @param {('outbound-requeue'|'outbound-withdraw')} op - Which decision.
 * @param {object} request - The request: `params.outboundId`, `body.requestId`.
 * @param {{actor: string, proof: string, generation?: number, user?: (string|null)}} who - Who decided.
 * @returns {{status: number, body: object}}
 */
function _decideOutbound(op, request, who) {
  const named = _outboundId(request);
  if (named.refusal) return named.refusal;
  const requestId = request.body ? request.body.requestId : undefined;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    return _refuse(400, 'REQUEST_ID_REQUIRED', 'A write carries a requestId of 8 to 128 characters.');
  }
  const result = bridgeStore.applyOutboundWrite({
    op, requestId, outboundId: named.outboundId, actor: who.actor, proof: who.proof, masterGeneration: who.generation ?? null,
    detail: who.actor === 'operator' ? { user: who.user } : undefined
  });
  const item = result.item ? { outboundId: result.item.outboundId, kind: result.item.kind, state: result.item.state, blockCode: result.item.blockCode } : null;
  const body = { item, replayed: result.replayed };
  if (result.outcome !== 'applied') {
    body.code = result.outcome.toUpperCase().replace(/-/g, '_');
    body.error = `The write was not applied: ${result.outcome}.`;
  }
  return { status: OUTBOUND_WRITE_STATUS[result.outcome], body };
}

/**
 * Reset the configuration circuit: close the open episode and say what
 * becomes of the items it set aside. The Project Master's and the operator's.
 * @param {object} request - The request: `body.requestId`, `body.decision`.
 * @param {{actor: string, proof: string, generation?: number, user?: (string|null)}} who - Who decided.
 * @returns {{status: number, body: object}}
 */
function _resetCircuit(request, who) {
  const body = request.body || {};
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.requestId)) {
    return _refuse(400, 'REQUEST_ID_REQUIRED', 'A write carries a requestId of 8 to 128 characters.');
  }
  if (body.decision !== 'requeue' && body.decision !== 'withdraw') {
    return _refuse(400, 'DECISION_REQUIRED', 'A reset says what becomes of the items that were set aside: "requeue" or "withdraw".');
  }
  const result = bridgeStore.applyCircuitReset({
    requestId: body.requestId, decision: body.decision, actor: who.actor, proof: who.proof, masterGeneration: who.generation ?? null,
    detail: who.actor === 'operator' ? { user: who.user } : undefined, at: gateway._deps.now()
  });
  if (result.outcome === 'applied' && !result.replayed) {
    log.info('Bridge configuration circuit reset', { episodeId: result.episode.episodeId, by: who.actor, decision: body.decision, items: result.items });
  }
  const answer = { episode: result.episode, items: result.items, replayed: result.replayed };
  if (result.outcome !== 'applied') {
    answer.code = result.outcome.toUpperCase().replace(/-/g, '_');
    answer.error = `The reset was not applied: ${result.outcome}.`;
  }
  return { status: result.outcome === 'applied' ? 200 : 409, body: answer };
}

/**
 * `POST master/circuit/:episodeId/ack`: Master says it has taken up the open
 * configuration episode. From then on the gateway stops telling it.
 * @param {object} request - `params.episodeId`.
 * @param {{generation: number}} master - The verified Master.
 * @returns {{status: number, body: object}}
 */
function masterAckCircuit(request, master) {
  if (!/^\d{1,9}$/.test(String(request.params.episodeId))) return _refuse(404, 'CIRCUIT_NOT_OPEN', 'No such open configuration episode.');
  const result = bridgeStore.circuit.ack(Number(request.params.episodeId), master.generation, { at: gateway._deps.now() });
  if (result.outcome === 'not-open') return _refuse(409, 'CIRCUIT_NOT_OPEN', 'No such open configuration episode.');
  return { status: 200, body: { episode: result.episode, replayed: result.outcome === 'already-acked' } };
}

/**
 * `POST master/circuit/reset`: Master resets the configuration circuit.
 * @param {object} request - `body.requestId`, `body.decision`.
 * @param {{proof: string, generation: number}} master - The verified Master.
 * @returns {{status: number, body: object}}
 */
function masterResetCircuit(request, master) {
  return _resetCircuit(request, { actor: 'master', proof: master.proof, generation: master.generation });
}

/**
 * `POST operator/circuit/reset`: the operator resets the configuration circuit.
 * @param {object} request - `body.requestId`, `body.decision`.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @returns {{status: number, body: object}}
 */
function operatorResetCircuit(request, operator) {
  return _resetCircuit(request, { actor: 'operator', proof: 'verified-session', user: operator.user });
}

/**
 * `GET master/outbound/blocked`: the items set aside, for Master to decide on.
 * Each says what it is and why it was set aside, never its text.
 * @returns {{status: number, body: object}}
 */
function blockedOutbound() {
  return { status: 200, body: { items: _setAsideItems() } };
}

/**
 * The items set aside, as the Master and the operator are both shown them:
 * what each is and why it is held, and never its text.
 * @returns {{outboundId: number, kind: string, notifyType: (string|null), routeId: (string|null), blockCode: string, attempts: number, partsPosted: number, createdAt: string}[]}
 */
function _setAsideItems() {
  return bridgeStore.outbound.blocked().map((item) => ({
    outboundId: item.outboundId, kind: item.kind, notifyType: item.notifyType, routeId: item.routeId, blockCode: item.blockCode,
    attempts: item.attempts, partsPosted: bridgeStore.parts.forItem(item.outboundId).length, createdAt: item.createdAt
  }));
}

/**
 * `POST master/outbound/:outboundId/requeue`: Master puts a set-aside item back.
 * @param {object} request - `params.outboundId`, `body.requestId`.
 * @param {{proof: string, generation: number}} master - The verified Master.
 * @returns {{status: number, body: object}}
 */
function masterRequeue(request, master) {
  return _decideOutbound('outbound-requeue', request, { actor: 'master', proof: master.proof, generation: master.generation });
}

/**
 * `POST master/outbound/:outboundId/withdraw`: Master withdraws an item that has not been posted.
 * @param {object} request - `params.outboundId`, `body.requestId`.
 * @param {{proof: string, generation: number}} master - The verified Master.
 * @returns {{status: number, body: object}}
 */
function masterWithdraw(request, master) {
  return _decideOutbound('outbound-withdraw', request, { actor: 'master', proof: master.proof, generation: master.generation });
}

/**
 * `POST operator/outbound/:outboundId/requeue`: the operator puts a set-aside item back.
 * @param {object} request - `params.outboundId`, `body.requestId`.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @returns {{status: number, body: object}}
 */
function operatorRequeue(request, operator) {
  return _decideOutbound('outbound-requeue', request, { actor: 'operator', proof: 'verified-session', user: operator.user });
}

/**
 * `POST operator/outbound/:outboundId/withdraw`: the operator withdraws an item that has not been posted.
 * @param {object} request - `params.outboundId`, `body.requestId`.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @returns {{status: number, body: object}}
 */
function operatorWithdraw(request, operator) {
  return _decideOutbound('outbound-withdraw', request, { actor: 'operator', proof: 'verified-session', user: operator.user });
}

/**
 * `POST operator/candidates/:candidateId/withdraw`: the operator withdraws a
 * candidate nobody has decided. It will never be approved or posted.
 * @param {object} request - `params.candidateId`, `body.requestId`.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @returns {{status: number, body: object}}
 */
function operatorWithdrawCandidate(request, operator) {
  const candidateId = String(request.params.candidateId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidateId)) return _refuse(404, 'CANDIDATE_NOT_FOUND', 'No such candidate.');
  const requestId = request.body ? request.body.requestId : undefined;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    return _refuse(400, 'REQUEST_ID_REQUIRED', 'A write carries a requestId of 8 to 128 characters.');
  }
  const result = bridgeStore.withdrawCandidateAsOperator({ requestId, candidateId, detail: { user: operator.user } });
  const candidate = result.candidate ? { candidateId: result.candidate.candidateId, kind: result.candidate.kind, state: result.candidate.state } : null;
  const body = { candidate, replayed: result.replayed };
  if (result.outcome !== 'applied') {
    body.code = result.outcome.toUpperCase().replace(/-/g, '_');
    body.error = `The write was not applied: ${result.outcome}.`;
  }
  const status = { applied: 200, 'candidate-not-found': 404, 'not-waiting': 409, 'request-id-reused': 409 }[result.outcome];
  return { status, body };
}

/**
 * Record one operator policy change in the audit.
 * @param {string} op - Operation name.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @param {object} [detail] - Small structured detail; never a secret.
 * @returns {void}
 */
function _auditOperator(op, operator, detail) {
  bridgeStore.audit.append({
    op, actor: 'operator', proof: 'verified-session', outcome: 'applied', detail: { ...(detail || {}), user: operator.user }
  });
}

/**
 * `GET operator/status`: the bridge's policy and what is waiting.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorStatus(request, operator) {
  return {
    status: 200,
    body: {
      enabled: bridgeStore.settings.isEnabled(),
      allowlist: gateway.allowlist(),
      helperToken: bridgeStore.helperTokens.active(),
      masterCredential: bridgeStore.masterCredentials.live(),
      aliases: bridgeStore.aliases.list(),
      // Each nickname with who set it, when, and on which operator message: for looking, and for putting right.
      nicknames: bridgeStore.aliases.records().map(_nicknameView),
      // What the bridge may reach: how the Master's scope reads, and the projects the operator has taken out of reach.
      reach: {
        scope: bridgeReach.scopeSummary(),
        reachable: bridgeReach.reachable().projects.map((project) => ({ projectId: project.id, name: project.name })),
        optouts: bridgeStore.optouts.list().map((o) => ({ ...o, name: (store.projects.get(o.projectId) || {}).name || null }))
      },
      pins: bridgeStore.pins.list(),
      openRoutes: bridgeStore.routes.list().length,
      // How many routes are open in each state, and when the oldest arrived.
      // Counts and a time, never text. Age is only age: a route is closed by
      // the Master, and how long it has waited says nothing of delivery.
      openRoutesByState: _openRouteCounts(),
      oldestOpenRouteAt: (bridgeStore.routes.list({ limit: 1 })[0] || { createdAt: null }).createdAt,
      waitingForHelper: bridgeStore.outbound.ready({ limit: 100 }).length,
      setAside: bridgeStore.outbound.blocked().length,
      // Which they are, so the operator can decide each one: ids and reasons, no text.
      setAsideItems: _setAsideItems(),
      // Everything queued that no open route owns, undecided candidates included:
      // what a rollback has to clear, since closing routes does not. No text.
      routelessItems: bridgeStore.routelessInventory(),
      candidatesPrimed: candidatesPrimed(),
      // What the operator last set, whether or not the bridge is on for it to take
      // effect: with the bridge off nothing is primed, and the setting is still there
      // to come back with it unless it is switched off.
      candidatePrimerSetting: bridgeStore.settings.get(CANDIDATES_PRIMED) === 'true',
      // The switch says what the operator asked for, not what a pane was told.
      // This is the last launch whose section came out over its cap and was
      // rendered without the switched verb: null when none has since the server started.
      candidatePrimerOmitted: ecosystemPrimer.lastSwitchFallback(),
      // Whether the Master can be told at all, and how many routes are waiting on it
      // untold of the state they are in now: a route told of an earlier state counts.
      masterListener: { enabled: gateway._deps.master().masterListenerEnabled(), state: gateway._deps.master().getMasterMedusaStatus().state },
      routesMasterNotTold: gateway.routesMasterNotTold(),
      configurationCircuit: bridgeStore.circuit.open(),
      droppedArrivals: gateway.droppedArrivals()
    }
  };
}

/**
 * How many routes are open in each state.
 * @returns {object} State name to count, for states with at least one route.
 */
function _openRouteCounts() {
  const counts = {};
  for (const route of bridgeStore.routes.list()) counts[route.state] = (counts[route.state] || 0) + 1;
  return counts;
}

/**
 * `POST operator/enable` and `operator/disable`: the operator's switch.
 * Enabling is refused until the allowlist is set and a helper token exists,
 * so the bridge never opens to nobody in particular.
 * @param {boolean} enable - Which way.
 * @returns {(request: object) => {status: number, body: object}}
 */
function operatorSwitch(enable) {
  return (request, operator) => {
    if (enable && !gateway.allowlist()) return _refuse(409, 'ALLOWLIST_NOT_SET', 'Set the allowlist before enabling the bridge.');
    if (enable && !bridgeStore.helperTokens.active()) return _refuse(409, 'HELPER_TOKEN_NOT_SET', 'Create the helper token before enabling the bridge.');
    // The gateway tells the Master what needs it through the Master's Medusa
    // listener. Without one, a message would wait with nobody told.
    if (enable && !gateway._deps.master().masterListenerEnabled()) {
      return _refuse(409, 'MASTER_LISTENER_OFF',
        'The Project Master is not a switchboard participant, so the bridge could not tell it that a message is waiting. Turn on the Master\'s Medusa setting first.');
    }
    bridgeStore.settings.set('enabled', enable ? 'true' : 'false');
    // Notifications look only at what happens from here on: enabling delivers no backlog.
    if (enable) bridgeStore.settings.set(bridgeNotify.ENABLED_AT, new Date().toISOString());
    _auditOperator(enable ? 'enable' : 'disable', operator);
    const listener = gateway.syncListener();
    return { status: 200, body: { enabled: enable, listener: listener.state } };
  };
}

/** The setting that says every pane is told of `tc candidate`. */
const CANDIDATES_PRIMED = 'candidates.primed';

/**
 * Whether sessions are being told they may offer the Master a candidate. Only
 * while the bridge is enabled: with the bridge off the verb is refused, so
 * switching the bridge off takes the verb out of the list with it.
 * @returns {boolean}
 */
function candidatesPrimed() {
  return bridgeStore.settings.isEnabled() && bridgeStore.settings.get(CANDIDATES_PRIMED) === 'true';
}

/**
 * `POST operator/candidate-primer`: the operator says whether every pane is
 * told of `tc candidate`. It can be switched on only while the bridge is
 * enabled. It takes effect for each session at its next launch: a pane's
 * instructions are written when it starts.
 * @param {object} request
 * @param {object} request.body - `{primed}`: true or false.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @returns {{status: number, body: object}}
 */
function operatorCandidatePrimer(request, operator) {
  const primed = request.body ? request.body.primed : undefined;
  if (typeof primed !== 'boolean') return _refuse(400, 'BAD_PRIMER', 'Say `primed`: true or false.');
  if (primed && !bridgeStore.settings.isEnabled()) {
    return _refuse(409, 'BRIDGE_DISABLED', 'Sessions are told of `tc candidate` only while the bridge is enabled: with it off the verb is refused.');
  }
  bridgeStore.settings.set(CANDIDATES_PRIMED, primed ? 'true' : 'false');
  _auditOperator(primed ? 'candidate-primer-on' : 'candidate-primer-off', operator);
  return { status: 200, body: { candidatesPrimed: candidatesPrimed() } };
}

/**
 * `POST operator/allowlist`: the one author, space and channel accepted.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{authorId, spaceId, channelId}`.
 * @returns {{status: number, body: object}}
 */
function operatorAllowlist(request, operator) {
  const body = request.body || {};
  for (const field of ['authorId', 'spaceId', 'channelId']) {
    if (typeof body[field] !== 'string' || !gateway.CHAT_ID.test(body[field])) {
      return _refuse(400, 'BAD_ALLOWLIST', `Missing or malformed ${field}.`);
    }
  }
  bridgeStore.settings.set('allow.author', body.authorId);
  bridgeStore.settings.set('allow.space', body.spaceId);
  bridgeStore.settings.set('allow.channel', body.channelId);
  // The ids themselves stay out of the audit: they identify a person and a place.
  _auditOperator('allowlist', operator);
  return { status: 200, body: { allowlist: gateway.allowlist() } };
}

/**
 * `POST operator/helper-token`: replace the helper token. The value is in
 * this response and nowhere else; only its hash is kept. Refused, with
 * nothing created, unless the request came over https or directly from this
 * machine: see {@link _secretTransport}.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorMintHelperToken(request, operator) {
  // Before anything is made: a token that cannot be shown safely is not created.
  if (!_secretTransport(request)) {
    return _refuseLogged('operator', 403, 'SECURE_TRANSPORT_REQUIRED',
      'The helper token is shown once, in this answer, so it is created only over https or from this machine itself. '
      + 'Nothing was created. Open the dashboard over https, or on the machine TangleClaw runs on, and create it there.');
  }
  const minted = gateway.mintHelperToken();
  _auditOperator('helper-token-mint', operator, { tokenId: minted.tokenId });
  return { status: 201, body: { tokenId: minted.tokenId, token: minted.token, shownOnce: true } };
}

/**
 * `DELETE operator/helper-token`: revoke the helper token.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorRevokeHelperToken(request, operator) {
  const revoked = bridgeStore.helperTokens.revoke();
  _auditOperator('helper-token-revoke', operator, { revoked });
  return { status: 200, body: { revoked } };
}

/** What a nickname looks like once normalised: the same shape an address takes after `@`. */
const NICKNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** How the operator's own nickname is refused when it would make a name mean two things. */
const NICKNAME_COLLIDES = Object.freeze([409, 'NICKNAME_COLLIDES', 'That is a number, or already the name or the slug of a project the bridge can reach, so as a nickname it would mean two things.']);

/** How the Master's nickname write is answered, by outcome. Everything not listed is a 409 under its own code. */
const NICKNAME_STATUS = Object.freeze({ applied: 200, 'nickname-not-found': 404, 'unknown-destination': 400 });

/**
 * A nickname as typed, normalised: no leading `@`, lower case.
 * @param {*} typed - What was sent.
 * @returns {{key: string, display: string}|null} Null when it is not shaped like a nickname.
 */
function _nickname(typed) {
  const display = typeof typed === 'string' ? typed.replace(/^@/, '') : '';
  const key = display.toLowerCase();
  return NICKNAME.test(key) ? { key, display } : null;
}

/**
 * A nickname as it is shown: what it points at by name, whether that is
 * within reach and running, and everything recorded about who set it.
 * @param {object} record - From `aliases.record`.
 * @returns {object}
 */
function _nicknameView(record) {
  const project = record.destination.kind === 'project' ? store.projects.get(record.destination.projectId) : null;
  const why = record.destination.kind === 'project' ? bridgeReach.outOfReach(project) : null;
  return {
    nickname: record.alias, display: record.display,
    destination: { kind: record.destination.kind, projectId: record.destination.projectId, name: project ? project.name : (record.destination.kind === 'master' ? 'Project Master' : null) },
    reachable: why === null, outOfReach: why,
    live: record.destination.kind === 'project' && why === null ? bridgeReach.liveness(record.destination.projectId).state : null,
    createdBy: record.createdBy, createdAt: record.createdAt, changedBy: record.changedBy, changedAt: record.changedAt,
    confirmedRouteId: record.confirmedRouteId
  };
}

/**
 * `GET nicknames`: every nickname, with what each points at and who set it.
 * Answers while the bridge is disabled.
 * @returns {{status: number, body: object}}
 */
function listNicknames() {
  return { status: 200, body: { nicknames: bridgeStore.aliases.records().map(_nicknameView) } };
}

/**
 * `GET nicknames/:name`: one nickname, explained.
 * @param {object} request
 * @param {object} request.params - `name`.
 * @returns {{status: number, body: object}}
 */
function readNickname(request) {
  const named = _nickname(request.params.name);
  const record = named ? bridgeStore.aliases.record(named.key) : null;
  if (!record) return _refuse(404, 'NICKNAME_NOT_FOUND', 'No such nickname.');
  return { status: 200, body: { nickname: _nicknameView(record) } };
}

/**
 * One nickname change by the Master, on the authority of one operator
 * message: the fields every one carries, validated, and the write applied.
 * @param {object} request - The request.
 * @param {object} master - The proven Master.
 * @param {string} op - `nickname-set`, `nickname-rename` or `nickname-forget`.
 * @param {(authority: object) => object} change - What is written; runs inside the store's transaction.
 * @returns {Promise<{status: number, body: object}>} On a change made on a reply, the body carries `instruction`:
 *   the message the question was about, which that write routed to the Master.
 */
async function _nicknameWrite(request, master, op, change) {
  const body = request.body || {};
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(body.requestId)) {
    return _refuse(400, 'REQUEST_ID_REQUIRED', 'A write carries a requestId of 8 to 128 characters.');
  }
  const named = _answeredBy(body);
  if (named.refusal) return named.refusal;
  const result = bridgeStore.applyNicknameWrite({
    op, requestId: body.requestId, answeredBy: named.answeredBy, proof: master.proof, masterGeneration: master.generation,
    at: gateway._deps.now(), change
  });
  const status = NICKNAME_STATUS[result.outcome] || 409;
  const answer = { outcome: result.outcome, replayed: result.replayed, ...(result.detail || {}) };
  // A change made on a reply routed the message it was about to the Master, in the same write. The gateway
  // carries it there now. On a replay too: if the first attempt stopped between the write and this, the
  // retry finishes the carrying, so the Master is never told to answer a message that is not yet its to answer.
  if (result.outcome === 'applied' && result.detail && result.detail.instructionRouteId) {
    await gateway.advance(result.detail.instructionRouteId);
    const instruction = bridgeStore.routes.get(result.detail.instructionRouteId);
    answer.instruction = instruction ? { routeId: instruction.routeId, state: instruction.state, version: instruction.version } : null;
  }
  if (status !== 200) {
    answer.code = result.outcome.toUpperCase().replace(/-/g, '_');
    // Where the destination is the reason, the same sentence any other write to it is refused with.
    const reach = _whyUnreachable(answer.code);
    answer.error = reach ? `The nickname was not changed. ${reach}` : `The nickname was not changed: ${result.outcome}.`;
  }
  return { status, body: answer };
}

/**
 * `POST nicknames`: the Master stores a nickname the operator asked for. The
 * operator's message is named by `answeredBy`: the instruction itself, or
 * their reply to the Master's question about it. A nickname is routing
 * metadata and nothing more: it is only ever a suggestion, it changes no rule,
 * credential or permission, and it grants nothing.
 * @param {object} request
 * @param {object} request.body - `{requestId, name, to, answeredBy}`; `to` is `master` or a reachable project.
 * @returns {{status: number, body: object}}
 */
function setNickname(request, master) {
  const name = _nickname(request.body ? request.body.name : undefined);
  if (!name) return _refuse(400, 'BAD_NICKNAME', 'A nickname is 1 to 64 letters, digits, dots, dashes or underscores.');
  const to = request.body.to;
  return _nicknameWrite(request, master, 'nickname-set', (authority) => {
    // Judged inside the write, on what is there at that moment, so that a refusal for where it points or for
    // what it is called is on the audit like any other.
    const found = bridgeReach.resolve(to);
    if (found.refusal) return { refuse: UNREACHABLE[found.refusal][1].toLowerCase().replace(/_/g, '-'), detail: { nickname: name.key } };
    const destination = found.destination;
    const clash = bridgeReach.nicknameClash(name.key);
    if (clash) return { refuse: `nickname-${clash}`, detail: { nickname: name.key } };
    bridgeStore.aliases.set(name.key, destination, { by: 'master', confirmedRouteId: authority.routeId, display: name.display, at: gateway._deps.now() });
    return { detail: { nickname: name.key, to: destination.kind, projectId: destination.projectId } };
  });
}

/**
 * `POST nicknames/:name/rename`: the Master gives a nickname a new name, on
 * the operator's say-so. What it points at does not change.
 * @param {object} request
 * @param {object} request.params - `name`.
 * @param {object} request.body - `{requestId, to, answeredBy}`; `to` is the new name.
 * @returns {{status: number, body: object}}
 */
function renameNickname(request, master) {
  const was = _nickname(request.params.name);
  const next = _nickname(request.body ? request.body.to : undefined);
  if (!was || !next) return _refuse(400, 'BAD_NICKNAME', 'A nickname is 1 to 64 letters, digits, dots, dashes or underscores.');
  return _nicknameWrite(request, master, 'nickname-rename', (authority) => {
    const before = bridgeStore.aliases.get(was.key);
    if (!before) return { refuse: 'nickname-not-found', detail: { was: was.key } };
    const clash = bridgeReach.nicknameClash(next.key, was.key);
    if (clash) return { refuse: `nickname-${clash}`, detail: { nickname: next.key, was: was.key } };
    bridgeStore.aliases.rename(was.key, next.key, { by: 'master', confirmedRouteId: authority.routeId, display: next.display, at: gateway._deps.now() });
    return { detail: { nickname: next.key, was: was.key, to: before.kind, projectId: before.projectId } };
  });
}

/**
 * `POST nicknames/:name/forget`: the Master removes a nickname, on the
 * operator's say-so.
 * @param {object} request
 * @param {object} request.params - `name`.
 * @param {object} request.body - `{requestId, answeredBy}`.
 * @returns {{status: number, body: object}}
 */
function forgetNickname(request, master) {
  const was = _nickname(request.params.name);
  if (!was) return _refuse(400, 'BAD_NICKNAME', 'A nickname is 1 to 64 letters, digits, dots, dashes or underscores.');
  return _nicknameWrite(request, master, 'nickname-forget', () => {
    const before = bridgeStore.aliases.get(was.key);
    if (!before || !bridgeStore.aliases.remove(was.key)) return { refuse: 'nickname-not-found', detail: { was: was.key } };
    return { detail: { was: was.key, to: before.kind, projectId: before.projectId } };
  });
}

/**
 * `POST operator/aliases`: create or replace a global alias.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{alias, to}`.
 * @returns {{status: number, body: object}}
 */
function operatorSetAlias(request, operator) {
  const body = request.body || {};
  // One reading of what a nickname is, for the operator's route and the Master's alike.
  const named = _nickname(body.alias);
  if (!named) return _refuse(400, 'BAD_ALIAS', 'An alias is 1 to 64 letters, digits, dots, dashes or underscores.');
  const alias = named.key;
  if (bridgeReach.RESERVED_NICKNAMES.includes(alias)) return _refuse(409, 'ALIAS_RESERVED', `"${alias}" is reserved and cannot be an alias: "master" always means the Project Master, and the others are what tc bridge nickname is told to do.`);
  // The operator's nicknames and pins are held to what the bridge may reach too: one that could never be routed to is not stored.
  const reach = _reachable(body.to);
  if (reach.refusal) return reach.refusal;
  const destination = reach.destination;
  // The same rule the Master's nicknames are held to: a name must never come to mean two things. Pointing a
  // nickname that already exists somewhere else is the operator's to do, and is not a clash.
  if (bridgeReach.nicknameClash(alias, alias) === 'collides') return _refuse(...NICKNAME_COLLIDES);
  bridgeStore.aliases.set(alias, destination, { by: 'operator', display: named.display });
  _auditOperator('alias-set', operator, { alias, to: destination.kind, projectId: destination.projectId });
  return { status: 200, body: { alias, destination: { kind: destination.kind, projectId: destination.projectId } } };
}

/**
 * `POST operator/optouts`: take a project out of reach of the bridge. Policy,
 * and the signed-in operator's alone: no message is suggested for it or
 * routed to it, and no session is launched for it, whatever is asked in the
 * chat. Putting it back is the same operator's `DELETE`.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{project}`: a project id.
 * @returns {{status: number, body: object}}
 */
function operatorSetOptout(request, operator) {
  const id = request.body ? request.body.project : undefined;
  const project = Number.isInteger(id) ? store.projects.get(id) : null;
  if (!project) return _refuse(400, 'UNKNOWN_PROJECT', 'Name the project by its id.');
  const added = bridgeStore.optouts.set(project.id);
  if (added) _auditOperator('optout-set', operator, { projectId: project.id });
  return { status: 200, body: { projectId: project.id, optedOut: true, changed: added } };
}

/**
 * `DELETE operator/optouts/:projectId`: put a project back within reach.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.params - `projectId`.
 * @returns {{status: number, body: object}}
 */
function operatorRemoveOptout(request, operator) {
  const raw = String(request.params.projectId || '');
  const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
  if (id === null || !bridgeStore.optouts.remove(id)) return _refuse(404, 'OPTOUT_NOT_FOUND', 'That project is not opted out.');
  _auditOperator('optout-remove', operator, { projectId: id });
  return { status: 200, body: { projectId: id, optedOut: false } };
}

/**
 * `DELETE operator/aliases/:alias`: remove a global alias.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.params - `alias`.
 * @returns {{status: number, body: object}}
 */
function operatorRemoveAlias(request, operator) {
  const alias = String(request.params.alias || '').toLowerCase();
  if (!bridgeStore.aliases.remove(alias)) return _refuse(404, 'ALIAS_NOT_FOUND', 'No such alias.');
  _auditOperator('alias-remove', operator, { alias });
  return { status: 200, body: { removed: alias } };
}

/**
 * `POST operator/pins`: set the operator's pin for one conversation, or for
 * every conversation when no `conversationKey` is given.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{conversationKey?, to}`.
 * @returns {{status: number, body: object}}
 */
function operatorSetPin(request, operator) {
  const body = request.body || {};
  const key = body.conversationKey == null ? null : body.conversationKey;
  if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9_:-]{1,160}$/.test(key))) {
    return _refuse(400, 'BAD_CONVERSATION', 'A conversation key is a channel id, or channel:thread.');
  }
  const reach = _reachable(body.to);
  if (reach.refusal) return reach.refusal;
  const destination = reach.destination;
  const pinId = `pin_${crypto.randomBytes(9).toString('base64url')}`;
  bridgeStore.pins.setGlobal({ pinId, conversationKey: key, destination });
  _auditOperator('pin-set', operator, { pinId, to: destination.kind, projectId: destination.projectId, every: key === null });
  return { status: 200, body: { pinId, conversationKey: key, destination: { kind: destination.kind, projectId: destination.projectId } } };
}

/**
 * `DELETE operator/pins/:pinId`: revoke any active pin, the Master's included.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.params - `pinId`.
 * @returns {{status: number, body: object}}
 */
function operatorRevokePin(request, operator) {
  if (!bridgeStore.pins.revoke(String(request.params.pinId || ''))) return _refuse(404, 'PIN_NOT_FOUND', 'No such active pin.');
  _auditOperator('pin-revoke', operator, { pinId: request.params.pinId });
  return { status: 200, body: { revoked: request.params.pinId } };
}

/** Shape of a candidate id. */
const CANDIDATE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Longest text a candidate or its rendering may carry: one chat message. */
const MAX_CANDIDATE_TEXT = 1800;

/**
 * Check candidate text: present, bounded, fit to display.
 * @param {*} text - Candidate text.
 * @returns {object|null} The refusal, or null when it is acceptable.
 */
function _candidateTextRefusal(text) {
  if (typeof text !== 'string' || !text.trim()) return _refuse(400, 'CANDIDATE_TEXT_REQUIRED', 'A candidate needs text.');
  if (text.length > MAX_CANDIDATE_TEXT) return _refuse(413, 'CANDIDATE_TOO_LONG', `Candidate text may be at most ${MAX_CANDIDATE_TEXT} characters.`);
  if (!_displaySafe(text)) return _refuse(400, 'CANDIDATE_NOT_DISPLAY_SAFE', 'The text contains control or text-direction characters.');
  return null;
}

/**
 * `POST session/candidates`: a verified session offers the Master a
 * `milestone` or `operator-action-required` fact, resting on its own workload
 * receipts. Nothing here reaches the chat: only the Master can turn a
 * candidate into something the operator reads.
 *
 * Idempotent on the request id within the launch. The same id with a
 * different payload is refused, not answered with the earlier candidate.
 * @param {object} request
 * @param {object} request.body - `{requestId, kind, text, receipts: [{kind: 'workload', seq}]}`.
 * @param {{projectId: number, launchId: string}} session - The verified launch.
 * @returns {{status: number, body: object}}
 */
function submitCandidate(request, session) {
  const body = request.body || {};
  if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) {
    return _refuse(400, 'REQUEST_ID_REQUIRED', 'A candidate needs a requestId of 8 to 128 letters, digits, dots, colons, dashes or underscores.');
  }
  if (body.kind !== 'milestone' && body.kind !== 'operator-action-required') {
    return _refuse(400, 'UNKNOWN_CANDIDATE_KIND', 'A candidate is a "milestone" or an "operator-action-required".');
  }
  const textRefusal = _candidateTextRefusal(body.text);
  if (textRefusal) return textRefusal;
  if (!Array.isArray(body.receipts) || body.receipts.length < 1 || body.receipts.length > 8) {
    return _refuse(400, 'RECEIPTS_REQUIRED', 'A candidate rests on one to eight of your own workload receipts.');
  }
  const bound = [];
  for (const named of body.receipts) {
    if (!named || !bridgeStore.RECEIPT_KINDS.includes(named.kind) || !Number.isInteger(named.seq) || named.seq < 1) {
      return _refuse(400, 'BAD_RECEIPT', 'Name each receipt as {"kind": "workload", "seq": <its sequence number>}.');
    }
    // Looked up within the caller's own launch: another launch's receipt, or
    // another project's, cannot be named at all.
    const receipt = bridgeStore.receipts.workloadForLaunch(session.launchId, named.seq);
    if (!receipt || receipt.projectId !== session.projectId) {
      return _refuse(404, 'RECEIPT_NOT_FOUND', `This launch has no workload receipt with sequence ${named.seq}.`);
    }
    if (!bound.some((b) => b.id === receipt.receiptId)) bound.push({ kind: 'workload', id: receipt.receiptId, digest: receipt.digest });
  }
  const idemKey = `cand:${bridgeStore.digest(`${session.launchId}\n${body.requestId}`).slice(0, 48)}`;
  const result = bridgeStore.candidates.submit({
    candidateId: `cd_${crypto.randomBytes(9).toString('base64url')}`, idemKey, kind: body.kind,
    sourceProjectId: session.projectId, sourceLaunchId: session.launchId, text: body.text, receipts: bound
  });
  if (result.overLimit) {
    return _refuse(429, 'CANDIDATE_LIMIT', `This launch already has ${bridgeStore.MAX_OPEN_CANDIDATES_PER_LAUNCH} candidates waiting for the Master.`);
  }
  if (!result.created) {
    // Compared with what was submitted, not with what the candidate rests on
    // now: a merge may since have given it more receipts.
    if (result.candidate.payloadDigest !== bridgeStore.candidatePayloadDigest(body.kind, body.text, bound)) {
      return _refuse(409, 'REQUEST_ID_CONFLICT', 'That requestId was already used by this launch for a different candidate.');
    }
  }
  bridgeStore.audit.append({
    op: 'candidate-submit', actor: 'session', proof: 'launch', outcome: result.created ? 'accepted' : 'replayed',
    detail: { candidateId: result.candidate.candidateId, projectId: session.projectId, receipts: bound.length }
  });
  return {
    status: result.created ? 201 : 200,
    body: { candidateId: result.candidate.candidateId, state: result.candidate.state, replayed: !result.created }
  };
}

/**
 * A candidate with what the Master needs to judge it.
 * @param {object} candidate - As the store returns it.
 * @returns {object}
 */
function _candidateView(candidate) {
  const project = store.projects.get(candidate.sourceProjectId);
  return {
    ...candidate,
    sourceProjectName: project ? project.name : null,
    receipts: bridgeStore.candidates.receipts(candidate.candidateId)
  };
}

/**
 * `GET candidates`: what sessions have offered and the Master has not decided.
 * @returns {{status: number, body: object}}
 */
function listCandidates() {
  return { status: 200, body: { candidates: bridgeStore.candidates.list().map(_candidateView) } };
}

/**
 * `GET candidates/:candidateId`: one candidate with its receipts.
 * @param {object} request
 * @param {object} request.params - `candidateId`.
 * @returns {{status: number, body: object}}
 */
function readCandidate(request) {
  const candidate = CANDIDATE_ID.test(request.params.candidateId) ? bridgeStore.candidates.get(request.params.candidateId) : null;
  if (!candidate) return _refuse(404, 'CANDIDATE_NOT_FOUND', 'No such candidate.');
  return {
    status: 200,
    // What a session wrote is a claim for the Master to judge. It is not the operator's word and not authority.
    body: { candidate: _candidateView(candidate), authority: 'session-claim' }
  };
}

/**
 * The fields every Master decision on a candidate carries, validated.
 * @param {object} request - The request.
 * @returns {{fields: object, candidateId: string}|{refusal: object}}
 */
function _candidateWrite(request) {
  const fields = _writeFields(request.body);
  if (fields.refusal) return { refusal: fields.refusal };
  const candidateId = request.params.candidateId;
  if (!CANDIDATE_ID.test(candidateId)) return { refusal: _refuse(404, 'CANDIDATE_NOT_FOUND', 'No such candidate.') };
  return { fields, candidateId };
}

/**
 * Shape a candidate write's result as a response.
 * @param {{outcome: string, replayed: boolean, candidate: (object|null)}} result - From `applyCandidateWrite`.
 * @returns {{status: number, body: object}}
 */
function _candidateResponse(result) {
  const status = result.outcome === 'applied' ? 200 : (result.outcome === 'candidate-not-found' ? 404 : 409);
  const body = { outcome: result.outcome, replayed: result.replayed, candidate: result.candidate };
  if (status !== 200) {
    body.code = result.outcome.toUpperCase().replace(/-/g, '_');
    body.error = `The decision was not applied: ${result.outcome}.`;
  }
  return { status, body };
}

/**
 * Whether every receipt a candidate rests on is still what it was: present,
 * and with the digest recorded when it was bound. That covers the receipts
 * its session named and any carried to it by a merge; each was checked
 * against its own launch when its candidate was submitted.
 * @param {object} candidate - The candidate.
 * @returns {boolean}
 */
function _receiptsStillHold(candidate) {
  const bound = bridgeStore.candidates.receipts(candidate.candidateId);
  if (bound.length === 0) return false;
  return bound.every((b) => {
    if (b.kind !== 'workload') return false;
    const now = bridgeStore.receipts.workloadById(b.id);
    return !!now && now.digest === b.digest;
  });
}

/**
 * `POST candidates/:candidateId/approve`: the Master renders a candidate for
 * the operator. Every receipt is verified again, and the one outbound item is
 * created in the same transaction as the decision.
 * @param {object} request
 * @param {object} request.params - `candidateId`.
 * @param {object} request.body - `{requestId, expectedVersion, text?}`; `text` replaces the session's wording.
 * @param {object} master - The proven Master.
 * @returns {{status: number, body: object}}
 */
function approveCandidate(request, master) {
  const w = _candidateWrite(request);
  if (w.refusal) return w.refusal;
  const own = request.body.text;
  if (own !== undefined) {
    const refusal = _candidateTextRefusal(own);
    if (refusal) return refusal;
  }
  return _candidateResponse(bridgeStore.applyCandidateWrite({
    op: 'candidate-approve', requestId: w.fields.requestId, candidateId: w.candidateId,
    expectedVersion: w.fields.expectedVersion, masterGeneration: master.generation,
    change: (candidate) => {
      if (candidate.state !== 'submitted') return { refuse: 'already-decided' };
      if (!_receiptsStillHold(candidate)) return { refuse: 'receipts-do-not-hold' };
      const text = own !== undefined ? own : candidate.text;
      if (typeof text !== 'string' || !_displaySafe(text)) return { refuse: 'not-display-safe' };
      const project = store.projects.get(candidate.sourceProjectId);
      return {
        state: 'approved',
        outbound: {
          idemKey: `candidate:${candidate.candidateId}`, kind: 'candidate',
          sourceLabel: `Project Master, from ${project ? project.name : 'a session'}`.slice(0, 80),
          text, digest: bridgeStore.digest(text), releasedGeneration: master.generation
        },
        detail: { kind: candidate.kind, wording: own !== undefined ? 'master' : 'session' }
      };
    }
  }));
}

/**
 * `POST candidates/:candidateId/reject`: the Master declines a candidate.
 * Nothing is posted.
 * @param {object} request
 * @param {object} request.params - `candidateId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @param {object} master - The proven Master.
 * @returns {{status: number, body: object}}
 */
function rejectCandidate(request, master) {
  const w = _candidateWrite(request);
  if (w.refusal) return w.refusal;
  return _candidateResponse(bridgeStore.applyCandidateWrite({
    op: 'candidate-reject', requestId: w.fields.requestId, candidateId: w.candidateId,
    expectedVersion: w.fields.expectedVersion, masterGeneration: master.generation,
    change: (candidate) => (candidate.state !== 'submitted' ? { refuse: 'already-decided' } : { state: 'rejected' })
  }));
}

/**
 * `POST candidates/:candidateId/merge`: the Master folds a candidate into
 * another that says the same thing. The surviving candidate gains every
 * receipt of the one folded in; the one folded in can never be approved.
 * @param {object} request
 * @param {object} request.params - `candidateId`: the one to fold in.
 * @param {object} request.body - `{requestId, expectedVersion, into}`.
 * @param {object} master - The proven Master.
 * @returns {{status: number, body: object}}
 */
function mergeCandidate(request, master) {
  const w = _candidateWrite(request);
  if (w.refusal) return w.refusal;
  const into = request.body.into;
  if (typeof into !== 'string' || !CANDIDATE_ID.test(into) || into === w.candidateId) {
    return _refuse(400, 'MERGE_TARGET_REQUIRED', 'Name another candidate to merge into.');
  }
  return _candidateResponse(bridgeStore.applyCandidateWrite({
    op: 'candidate-merge', requestId: w.fields.requestId, candidateId: w.candidateId,
    expectedVersion: w.fields.expectedVersion, masterGeneration: master.generation,
    change: (candidate) => {
      if (candidate.state !== 'submitted') return { refuse: 'already-decided' };
      const target = bridgeStore.candidates.get(into);
      if (!target || target.state !== 'submitted') return { refuse: 'merge-target-not-open' };
      if (!_receiptsStillHold(candidate)) return { refuse: 'receipts-do-not-hold' };
      return { state: 'merged', carryReceiptsTo: into, detail: { into } };
    }
  }));
}

/**
 * Every bridge route: its method, its path, the one principal it belongs to,
 * and its handler. `whileDisabled` marks the few a disabled bridge still
 * answers.
 */
const ROUTES = Object.freeze([
  { method: 'GET', path: '/api/bridge/master/status', principal: 'master', whileDisabled: true, handler: status },
  // The two reads answer while disabled: after the operator switches the bridge
  // off, the Master has to be able to see which routes are still open in order
  // to close them. They read only; every route that sends or resolves is refused.
  { method: 'GET', path: '/api/bridge/master/routes', principal: 'master', whileDisabled: true, handler: listRoutes },
  { method: 'GET', path: '/api/bridge/master/destinations', principal: 'master', whileDisabled: true, handler: listDestinations },
  { method: 'GET', path: '/api/bridge/master/nicknames', principal: 'master', whileDisabled: true, handler: listNicknames },
  { method: 'GET', path: '/api/bridge/master/nicknames/:name', principal: 'master', whileDisabled: true, handler: readNickname },
  { method: 'POST', path: '/api/bridge/master/nicknames', principal: 'master', handler: setNickname },
  { method: 'POST', path: '/api/bridge/master/nicknames/:name/rename', principal: 'master', handler: renameNickname },
  { method: 'POST', path: '/api/bridge/master/nicknames/:name/forget', principal: 'master', handler: forgetNickname },
  { method: 'GET', path: '/api/bridge/master/routes/:routeId', principal: 'master', whileDisabled: true, handler: readRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/close', principal: 'master', whileDisabled: true, handler: closeRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/route', principal: 'master', handler: routeTo },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/ask', principal: 'master', handler: askRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/ask-launch', principal: 'master', handler: askLaunch },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/launch', principal: 'master', handler: launchFor },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/decline', principal: 'master', handler: declineRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/answer', principal: 'master', handler: answerRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/release', principal: 'master', handler: releaseRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/pin', principal: 'master', handler: pinRoute },
  { method: 'GET', path: '/api/bridge/master/candidates', principal: 'master', handler: listCandidates },
  { method: 'GET', path: '/api/bridge/master/candidates/:candidateId', principal: 'master', handler: readCandidate },
  { method: 'POST', path: '/api/bridge/master/candidates/:candidateId/approve', principal: 'master', handler: approveCandidate },
  { method: 'POST', path: '/api/bridge/master/candidates/:candidateId/reject', principal: 'master', handler: rejectCandidate },
  { method: 'POST', path: '/api/bridge/master/candidates/:candidateId/merge', principal: 'master', handler: mergeCandidate },
  { method: 'GET', path: '/api/bridge/master/outbound/blocked', principal: 'master', whileDisabled: true, handler: blockedOutbound },
  { method: 'POST', path: '/api/bridge/master/outbound/:outboundId/requeue', principal: 'master', handler: masterRequeue },
  { method: 'POST', path: '/api/bridge/master/outbound/:outboundId/withdraw', principal: 'master', whileDisabled: true, handler: masterWithdraw },
  { method: 'POST', path: '/api/bridge/master/circuit/:episodeId/ack', principal: 'master', whileDisabled: true, handler: masterAckCircuit },
  { method: 'POST', path: '/api/bridge/master/circuit/reset', principal: 'master', whileDisabled: true, handler: masterResetCircuit },
  { method: 'POST', path: '/api/bridge/session/candidates', principal: 'session', rate: 'candidate', handler: submitCandidate },
  { method: 'POST', path: '/api/bridge/helper/preflight', principal: 'helper', whileDisabled: true, nonce: 'none', rate: 'preflight', handler: helperPreflight },
  { method: 'POST', path: '/api/bridge/helper/inbound', principal: 'helper', rate: 'inbound', handler: helperInbound },
  { method: 'POST', path: '/api/bridge/helper/outbound/claim', principal: 'helper', nonce: 'names-the-request', rate: 'helper', handler: helperClaim },
  { method: 'POST', path: '/api/bridge/helper/outbound/:outboundId/parts', principal: 'helper', rate: 'helper', handler: helperPart },
  { method: 'POST', path: '/api/bridge/helper/outbound/:outboundId/ack', principal: 'helper', rate: 'helper', handler: helperAck },
  { method: 'POST', path: '/api/bridge/helper/outbound/:outboundId/failure', principal: 'helper', rate: 'helper', handler: helperFailure },
  { method: 'GET', path: '/api/bridge/operator/status', principal: 'operator', handler: operatorStatus },
  { method: 'POST', path: '/api/bridge/operator/enable', principal: 'operator', handler: operatorSwitch(true) },
  { method: 'POST', path: '/api/bridge/operator/disable', principal: 'operator', handler: operatorSwitch(false) },
  { method: 'POST', path: '/api/bridge/operator/allowlist', principal: 'operator', handler: operatorAllowlist },
  { method: 'POST', path: '/api/bridge/operator/helper-token', principal: 'operator', handler: operatorMintHelperToken },
  { method: 'DELETE', path: '/api/bridge/operator/helper-token', principal: 'operator', handler: operatorRevokeHelperToken },
  { method: 'POST', path: '/api/bridge/operator/outbound/:outboundId/requeue', principal: 'operator', handler: operatorRequeue },
  { method: 'POST', path: '/api/bridge/operator/outbound/:outboundId/withdraw', principal: 'operator', handler: operatorWithdraw },
  { method: 'POST', path: '/api/bridge/operator/candidates/:candidateId/withdraw', principal: 'operator', handler: operatorWithdrawCandidate },
  { method: 'POST', path: '/api/bridge/operator/candidate-primer', principal: 'operator', handler: operatorCandidatePrimer },
  { method: 'POST', path: '/api/bridge/operator/circuit/reset', principal: 'operator', handler: operatorResetCircuit },
  { method: 'POST', path: '/api/bridge/operator/aliases', principal: 'operator', handler: operatorSetAlias },
  { method: 'DELETE', path: '/api/bridge/operator/aliases/:alias', principal: 'operator', handler: operatorRemoveAlias },
  { method: 'POST', path: '/api/bridge/operator/optouts', principal: 'operator', handler: operatorSetOptout },
  { method: 'DELETE', path: '/api/bridge/operator/optouts/:projectId', principal: 'operator', handler: operatorRemoveOptout },
  { method: 'POST', path: '/api/bridge/operator/pins', principal: 'operator', handler: operatorSetPin },
  { method: 'DELETE', path: '/api/bridge/operator/pins/:pinId', principal: 'operator', handler: operatorRevokePin }
]);

/**
 * The principals whose proof is a credential of their own, with no launch
 * binding to check: the Master's bridge credential and the chat helper's
 * scoped token. A closed list. The operator and a project session are proven
 * by what every other route already reads, so their routes are held to the
 * server's launch-binding floor like any other (`lib/launch-binding-guard.js`).
 * @type {ReadonlyArray<string>}
 */
const OWN_CREDENTIAL_PRINCIPALS = Object.freeze(['master', 'helper']);

/**
 * Whether a declared route proves a credential of its own before its handler,
 * so the launch-binding floor does not apply to it. Only an entry declared in
 * {@link ROUTES} with a principal on {@link OWN_CREDENTIAL_PRINCIPALS}
 * qualifies; anything else, an unknown principal included, does not.
 * @param {object} entry - A route declaration
 * @returns {boolean}
 */
function provesOwnPrincipal(entry) {
  return ROUTES.includes(entry) && OWN_CREDENTIAL_PRINCIPALS.includes(entry.principal);
}

/**
 * Answer one bridge request: prove the route's principal, then run its
 * handler with the proven caller. The only way a handler is reached.
 * @param {{method: string, path: string, principal: string, handler: Function}} entry - A {@link ROUTES} entry.
 * @param {{req?: object, headers: object, params?: object, query?: object, body?: object}} request - The request.
 * @returns {Promise<{status: number, body: object}>}
 */
async function handle(entry, request) {
  const proven = PRINCIPALS[entry.principal](request, entry);
  if (proven.refusal) return proven.refusal;
  const over = proven.admitted ? null : _overLimit(entry, proven.caller);
  if (over) return over;
  return entry.handler({ params: {}, query: {}, ...request }, proven.caller);
}

/**
 * Forget every rate-limit count. For tests.
 * @returns {void}
 */
function _resetRateLimits() {
  _admitted.clear();
  _refusedLoggedAt.clear();
}

/**
 * The declared route for a method and path pattern.
 * @param {string} method - HTTP method.
 * @param {string} path - Path pattern as declared.
 * @returns {object} The entry.
 * @throws {Error} When no such route is declared.
 */
function routeFor(method, path) {
  const entry = ROUTES.find((r) => r.method === method && r.path === path);
  if (!entry) throw new Error(`no bridge route ${method} ${path}`);
  return entry;
}

module.exports = { HELPER_TOKEN_HEADER, HELPER_NONCE_HEADER, ROUTES, OWN_CREDENTIAL_PRINCIPALS, provesOwnPrincipal, RATE_LIMITS, ADMITTED_SWEEP_AT, handle, routeFor, candidatesPrimed, _resetRateLimits, _admitted };
