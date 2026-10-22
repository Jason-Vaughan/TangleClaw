'use strict';

/**
 * Caller-identity helpers shared by several route families — the project a
 * verified launch acts for (`_callerProjectId`) and the operator proofs
 * (`_operatorProofOf`, `_requireOperatorWrite`, `_requireOperatorRead`) —
 * moved out of `server.js` unchanged (#2248).
 *
 * Owned by no one family: the launch recovery routes, the session lifecycle
 * routes and the startup prompt prove the operator through the same two
 * functions, and the recovery-mode decision records its clearance through the
 * same proof, so that two records of one request cannot disagree about it.
 *
 * The proofs still call three gate helpers that live in `server.js` with the
 * rest of the login gate: `_gateIdentity`, `_isSameOriginClear` and
 * `_refuseDuringFallback`. Requiring them from here would be a cycle, so the
 * entry point binds them once at load through `_bind(deps)`, the shape the
 * store's domain modules use for their database handle. Every proof runs at
 * request time, after the entry point has loaded, so the binding is in place
 * before the first one is asked for. When the gate has a module of its own,
 * this one requires the three from there and `_bind` goes.
 *
 * @module lib/routes/_callers
 */

const { createLogger } = require('../logger');
const authGate = require('../auth-gate');
const authSession = require('../auth-session');
const openInstallToken = require('../open-install-token');
const sharedDocsAccess = require('../shared-docs-access');
const { errorResponse, reqUrl } = require('./_kernel');

// The logger keeps the entry point's name so every log line these proofs
// write reads exactly as it did before the move.
const log = createLogger('server');

// The three gate helpers still resident in `server.js`, set by `_bind`.
let _gateIdentity;
let _isSameOriginClear;
let _refuseDuringFallback;

/**
 * Bind the gate helpers the proofs call. The entry point calls this once, at
 * load, before any route can be served.
 * @param {object} deps - The gate helpers still resident in `server.js`.
 * @param {(req: object, socket: object, pathname: string) => {sessionToken: (string|null), session: (object|null), machineClient: boolean}} deps._gateIdentity -
 *   Who the login gate says is asking: the session token and row, and whether the client is a local process.
 * @param {(req: object, what?: string) => ({ok: true}|{ok: false, error: string, code: string})} deps._isSameOriginClear -
 *   Whether a browser-shaped write came from this server's own dashboard.
 * @param {(res: object, action: string) => void} deps._refuseDuringFallback -
 *   Answer 409 while the login is stood down behind Caddy's password.
 * @returns {void}
 */
function _bind(deps) {
  ({ _gateIdentity, _isSameOriginClear, _refuseDuringFallback } = deps);
}

/**
 * The project a caller acts for, when it is a verified project launch.
 * @param {object} req - The request.
 * @returns {number|null}
 */
function _callerProjectId(req) {
  const access = sharedDocsAccess.resolveAccess(req);
  return access.kind === sharedDocsAccess.KINDS.PROJECT ? access.projectId : null;
}

/**
 * The proof behind a request that was already admitted as the operator's: the
 * word its decision is recorded with, and who was named.
 *
 * It admits and refuses nothing. Each caller's own guard has done that, and
 * this says only what that admission rested on, so that every record of an
 * operator's decision (a recovery clear, a recovery-mode decision) uses one
 * rule and two of them cannot disagree about the same request.
 *
 * `operator-verified` needs all three: a gate that is `armed`, a session, and
 * that session's CSRF token on the request. Everything else is
 * `open-install-unverified`, which is the honest word wherever TangleClaw's
 * own login identified nobody: an `open` install, and `fallback`, where
 * Caddy's login stands in front and TangleClaw cannot say who came through it.
 * The default is the unverified word so that a state this function does not
 * know can never be recorded as a verified person.
 * @param {http.IncomingMessage} req - The request, as annotated by `handleRequest`
 * @returns {{clearance: ('operator-verified'|'open-install-unverified'), actor: (string|null)}}
 */
function _operatorProofOf(req) {
  if (req.tcGateState === authGate.GATE_STATES.ARMED && req.tcSession
    && authSession.csrfTokenMatches(authSession.csrfTokenFromRequest(req), req.tcSession.csrfToken)) {
    return { clearance: 'operator-verified', actor: req.tcSession.username };
  }
  return { clearance: 'open-install-unverified', actor: null };
}

/**
 * Prove that a state-changing request is the OPERATOR's, or refuse it.
 *
 * One implementation for every write that records a decision as an operator's
 * (the launch recovery clear, the startup prompt), so the proof cannot drift
 * between them. The launch reconciliation read uses it too, although it
 * changes nothing: what it serves is for the operator alone, and it is sent as
 * a POST so that this proof applies to it whole. That route serves only an
 * `operator-verified` result and refuses the open-install one.
 *
 * The branches key on the GATE STATE first, never on "is there a
 * session". An `armed` install with a failed authentication has no
 * `req.tcSession`, and the order below is what keeps that request from falling
 * through to the open-install branch and being honoured as an anonymous
 * browser: each state is answered by its own branch, and anything
 * unrecognised is refused rather than defaulted.
 *
 * Every refusal is logged. On an install with no login these checks are the
 * ONLY barrier on a state-changing write, so a rejected attempt that left no
 * trace would make "did anything try this" answerable only for the attempts
 * that worked.
 *
 * @param {http.IncomingMessage} req - The request.
 * @param {http.ServerResponse} res - The response, written on refusal.
 * @param {object} o - What is being attempted, for logs and messages.
 * @param {string} o.logEvent - Log line for a refusal, e.g. 'Refused a recovery clear'.
 * @param {object} o.logContext - Extra log fields (e.g. `{project}`).
 * @param {string} o.fallbackAction - Phrase for `_refuseDuringFallback`.
 * @param {string} o.sameOriginWhat - Subject of a cross-site refusal, e.g. 'A recovery clear'.
 * @param {string} o.unauthenticated - 401 message on an armed gate with no session.
 * @param {string} o.machineClient - 403 message for a local process on an open gate.
 * @param {string} o.openToken - 403 message for a missing open-install token.
 * @param {(gateState: string) => string} o.gateUnsupported - 409 message for any other gate state.
 * @returns {{clearance: string, actor: (string|null)}|null} The proof, or null
 *   when a refusal was already sent.
 */
function _requireOperatorWrite(req, res, o) {
  const gateState = req.tcGateState;
  const logFields = (code, extra = {}) => ({ code, ...o.logContext, gateState, ...extra });
  // 1. Fallback — TangleClaw's own login is stood down behind Caddy's, so it
  //    cannot say who this is and must not record that anyone verified it.
  if (gateState === authGate.GATE_STATES.FALLBACK) {
    _refuseDuringFallback(res, o.fallbackAction);
    return null;
  }

  if (gateState === authGate.GATE_STATES.ARMED) {
    // 2. Armed — a login is in force, so an operator's session is the only
    //    thing that proves it. Machine clients and failed authentication end
    //    here with a 401 and never reach step 3.
    if (!req.tcSession) {
      log.warn(o.logEvent, logFields('UNAUTHENTICATED'));
      errorResponse(res, 401, o.unauthenticated, 'UNAUTHENTICATED');
      return null;
    }
    // The perimeter already refused this write without a valid CSRF token. It
    // is asserted again here rather than inherited: this write records a
    // decision as an operator's, and a guard it does not own is a guard that
    // can move out from under it without this file changing. Through the SAME
    // `csrfTokenMatches` the perimeter uses, though — a hand-rolled `!==` would
    // be a copy that inherits none of its type-, length- and timing-safety, so
    // a later hardening of that function would silently skip the one write that
    // records who an operator is.
    if (!authSession.csrfTokenMatches(authSession.csrfTokenFromRequest(req), req.tcSession.csrfToken)) {
      log.warn(o.logEvent, logFields('CSRF_TOKEN_INVALID', { username: req.tcSession.username }));
      errorResponse(res, 403, 'This request is missing a valid CSRF token.', 'CSRF_TOKEN_INVALID');
      return null;
    }
    return _operatorProofOf(req);
  }

  if (authGate.isOpen(gateState)) {
    // 3. Open — the login is explicitly disabled, so nothing here can prove a
    //    person. The checks stop a CROSS-SITE browser and nothing more, and the
    //    clearance word records exactly that.
    //
    //    The gate stands down in `open`, so `handleRequest` resolved no
    //    identity: this branch asks for one itself rather than reading a field
    //    that is null for two different reasons.
    const identity = _gateIdentity(req, req.socket, reqUrl(req).pathname);
    if (identity.machineClient) {
      log.warn(o.logEvent, logFields('OPERATOR_REQUIRED'));
      errorResponse(res, 403, o.machineClient, 'OPERATOR_REQUIRED');
      return null;
    }
    const sameOrigin = _isSameOriginClear(req, o.sameOriginWhat);
    if (!sameOrigin.ok) {
      log.warn(o.logEvent, logFields(sameOrigin.code));
      errorResponse(res, 403, sameOrigin.error, sameOrigin.code);
      return null;
    }
    if (!openInstallToken.verify(req.headers['x-tc-open-token'])) {
      log.warn(o.logEvent, logFields('OPEN_INSTALL_TOKEN_INVALID'));
      errorResponse(res, 403, o.openToken, 'OPEN_INSTALL_TOKEN_INVALID');
      return null;
    }
    // Never `operator-verified`. Same-origin plus a page token proves the click
    // came from this server's own dashboard; it does not prove a human, and it
    // cannot exclude a local process that fetched a token of its own.
    return _operatorProofOf(req);
  }

  // 4. Anything else — `account-required`, `locked`, `unreadable`. There is no
  //    fall-through to the open branch, by construction.
  log.warn(o.logEvent, logFields('GATE_STATE_UNSUPPORTED'));
  errorResponse(res, 409, o.gateUnsupported(gateState), 'GATE_STATE_UNSUPPORTED');
  return null;
}

/**
 * Establish that a read is a signed-in operator's, or send the refusal.
 *
 * For the reads that span every project on the install. They are served only
 * while the login gate is `armed` and the request carries an operator's
 * session: on an install with no login nothing could show that the reader of
 * a fleet-wide answer is the operator. Every other gate state refuses by its
 * own branch, and the gate state is decided before the session is looked at,
 * as in `_requireOperatorWrite`.
 *
 * No CSRF proof is asked for: a GET changes nothing, and a cross-site page
 * cannot read the answer.
 * @param {object} req - Request
 * @param {object} res - Response
 * @param {object} o
 * @param {string} o.logEvent - Log line for a refusal.
 * @param {string} o.fallbackAction - What cannot be done during fallback, for the 409.
 * @param {string} o.noLogin - 403 message for an install with no login.
 * @param {string} o.unauthenticated - 401 message for a caller who is not signed in.
 * @param {(gateState: string) => string} o.gateUnsupported - 409 message for any other gate state.
 * @returns {{actor: string, gateState: string}|null} The reader, or null when a refusal was already sent.
 */
function _requireOperatorRead(req, res, o) {
  const gateState = req.tcGateState;
  const refuse = (status, code, message) => {
    log.warn(o.logEvent, { code, gateState });
    errorResponse(res, status, message, code);
    return null;
  };
  if (gateState === authGate.GATE_STATES.FALLBACK) {
    log.warn(o.logEvent, { code: 'GATE_FALLBACK', gateState });
    _refuseDuringFallback(res, o.fallbackAction);
    return null;
  }
  if (gateState !== authGate.GATE_STATES.ARMED) {
    // The status and code the reconciliation read gives the same condition,
    // so a client handles "this needs a login" once for every operator read.
    if (authGate.isOpen(gateState)) return refuse(403, 'LOGIN_GATE_REQUIRED', o.noLogin);
    return refuse(409, 'GATE_STATE_UNSUPPORTED', o.gateUnsupported(gateState));
  }
  if (!req.tcSession) return refuse(401, 'UNAUTHENTICATED', o.unauthenticated);
  return { actor: req.tcSession.username, gateState };
}

module.exports = { _bind, _callerProjectId, _operatorProofOf, _requireOperatorWrite, _requireOperatorRead };
