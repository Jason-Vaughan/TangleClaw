/**
 * Request identity: where "who is asking" comes from, and where it must NOT.
 *
 * Identity comes from TangleClaw's own session (`req.tcSession`, resolved by
 * `server.js#_gateIdentity`), on every ingress mode (ADR 0016 OQ2). This module
 * no longer interprets a proxy-supplied identity. Its job is the inverse: to
 * REFUSE one.
 *
 * Why refuse rather than ignore. Caddy's `basic_auth` gate used to populate
 * `X-Auth-User` with `header_up`, which overwrites a client's value, so the
 * header TangleClaw saw was Caddy's. Once Caddy's gate is gone nothing
 * overwrites it, and a request carrying `X-Auth-User` is carrying the caller's
 * own claim. A second source of truth about who the caller is is exactly what
 * ADR 0015 rejects — so the header is DELETED from the request at entry
 * ({@link refuseInboundIdentity}), before any routing, and a later reader cannot
 * reintroduce trust in it by accident.
 *
 * During the cutover a hand-edited Caddyfile can still send the header on every
 * forwarded request. That is Caddy's own line, not a forgery, so it is deleted
 * just the same but logged quietly; a header arriving WITHOUT having come
 * through a proxy cannot be Caddy's, and is logged as refused.
 *
 * @module lib/auth-identity
 */

'use strict';

const { GATE_STATES } = require('./auth-gate');

/**
 * The header Caddy's `basic_auth` gate forwarded the authenticated username in.
 * Lower-case to match Node's `req.headers` key normalization.
 * @type {string}
 */
const IDENTITY_HEADER = 'x-auth-user';

/**
 * Header whose presence marks a request as having come through a reverse proxy.
 * Caddy's `reverse_proxy` sets it on every forwarded request and replaces a
 * client's value (`lib/auth-gate.js#isMachineClient` carries the evidence and
 * when to re-check it). Used here only to decide how loudly a refused identity
 * header is logged — never to trust anything.
 * @type {string}
 */
const PROXY_EVIDENCE_HEADER = 'x-forwarded-for';

/**
 * Whether a proxy-set request header may be believed at all.
 *
 * The condition is Caddy fronting the install with its `basic_auth` gate: caddy
 * ingress AND `authEnabled`. Outside that nothing trustworthy sits in front of
 * this server, so an `x-…` header is just a string the caller chose.
 *
 * Identity no longer answers to this — {@link refuseInboundIdentity} deletes the
 * identity header on every mode. What still does is the forwarded HOST the
 * operator-topology fact reads (`lib/session-ownership.js#resolveOperatorHost`),
 * which names an address, not a person.
 *
 * @param {object|null} config - Loaded server config.
 * @returns {boolean}
 */
function isProxyHeaderTrusted(config) {
  return !!(config && config.ingressMode === 'caddy' && config.authEnabled);
}

/**
 * Delete an inbound identity header from a request's headers, and report what
 * was there.
 *
 * Mutates `headers` on purpose. Deleting at request entry — rather than
 * skipping the header wherever identity is read — is what keeps a future reader
 * from trusting it again, and it also keeps the header off every upstream the
 * request is later proxied to.
 *
 * @param {object|null|undefined} headers - `req.headers` (keys lower-cased by Node)
 * @returns {{ present: boolean, proxied: boolean }} `present` when the header was
 *   there and has now been removed; `proxied` when the request came through a
 *   reverse proxy, which is how Caddy's own transitional header is told apart
 *   from a forgery in the log.
 */
function refuseInboundIdentity(headers) {
  if (!headers || typeof headers !== 'object'
      || !Object.prototype.hasOwnProperty.call(headers, IDENTITY_HEADER)) {
    return { present: false, proxied: false };
  }
  delete headers[IDENTITY_HEADER];
  return { present: true, proxied: cameThroughProxy(headers) };
}

/**
 * Whether a request came through a reverse proxy: `X-Forwarded-For` is present,
 * whatever its value.
 *
 * The ONE spelling of this check. The fleet carve-out
 * (`lib/auth-gate.js#isMachineClient`'s `proxied`), the first-account log line
 * and the identity refusal all ask it, and a second spelling is how one of them
 * ends up testing a different header or treating an empty value differently.
 * Presence, not a non-empty value, because Caddy sets it on every forwarded
 * request, so even an empty one is not evidence of a local process.
 *
 * @param {object|null|undefined} headers - `req.headers`
 * @returns {boolean}
 */
function cameThroughProxy(headers) {
  return !!headers && typeof headers === 'object' && headers[PROXY_EVIDENCE_HEADER] !== undefined;
}

/**
 * Valid `authStatus` values: exactly the gate's states, built from them so a
 * state added to the gate is a valid status without a second edit here.
 * @type {string[]}
 */
const AUTH_STATUSES = Object.values(GATE_STATES);

/**
 * The dashboard's `authStatus`: TangleClaw's gate state, reported as-is.
 *
 * The gate is the one owner of whether a login is enforced
 * (`lib/auth-gate.js#resolveGateState`), and `/api/auth/me` already reports the
 * same value as `gateState`. One vocabulary, not a second one mapped onto it — a
 * rename map is where a newly added state gets labelled wrongly.
 *
 * The values that compared config against a proxy header (`configured-inert`,
 * `configured-no-identity`, `configured-bypassed`) do not exist: each described
 * a disagreement between Caddy's gate and a header, and TangleClaw enforces its
 * own login on every mode and reads no such header.
 *
 * A value that is not a gate state answers `unreadable`, never `open`: a status
 * that fails toward "no login required" would tell the operator the door is open
 * when the code cannot say so.
 *
 * @param {string} gateState - From `lib/auth-gate.js#resolveGateState`
 * @returns {string} One of {@link AUTH_STATUSES}
 */
function resolveAuthStatus(gateState) {
  return AUTH_STATUSES.includes(gateState) ? gateState : GATE_STATES.UNREADABLE;
}

module.exports = {
  refuseInboundIdentity,
  cameThroughProxy,
  resolveAuthStatus,
  isProxyHeaderTrusted,
  IDENTITY_HEADER,
  PROXY_EVIDENCE_HEADER,
  AUTH_STATUSES
};
