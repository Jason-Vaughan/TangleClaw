/**
 * Proxy-authenticated identity (AUTH-3 / #1).
 *
 * When TangleClaw runs behind the Caddy ingress with the AUTH-2 `basic_auth`
 * gate enabled, Caddy authenticates the request and forwards the logged-in
 * username to TC's upstream as the `X-Auth-User` header
 * (`reverse_proxy { header_up X-Auth-User {http.auth.user.id} }`). This module
 * is the **trust gate** for that header: it decides when the value may be
 * believed, so a forged header on a direct-to-TC request is never honored.
 *
 * Spoof-defense (the NON-NEGOTIABLE): the header is trusted ONLY when the gate
 * is actually live — `ingressMode === 'caddy'` AND `authEnabled`. In that mode
 * TC binds `127.0.0.1` and Caddy is the only path, and Caddy's `header_up` uses
 * set-semantics (it overwrites any client-supplied value), so the header TC sees
 * is Caddy's. In direct mode (or with the gate off) the header is ignored
 * entirely — there is no authenticating proxy in front, so any `X-Auth-User`
 * would be attacker-supplied.
 *
 * @module lib/auth-identity
 */

'use strict';

/**
 * The header Caddy forwards the authenticated username in. Lower-case to match
 * Node's `req.headers` key normalization.
 * @type {string}
 */
const IDENTITY_HEADER = 'x-auth-user';

/**
 * Resolve the authenticated user for a request.
 *
 * @param {object} headers - The request headers (`req.headers`; keys lower-cased
 *   by Node). May be undefined/null.
 * @param {object} config - Merged TC config; only `ingressMode` and `authEnabled`
 *   are read. May be undefined/null.
 * @returns {string|null} The trimmed authenticated username when the gate is live
 *   and a single non-empty `x-auth-user` string is present; `null` otherwise
 *   (direct mode, gate off, missing header, empty value, or an ambiguous
 *   array/duplicate header — fail closed on ambiguity).
 */
function resolveRequestUser(headers, config) {
  // The gate must be live: caddy ingress AND the basic_auth gate enabled.
  // Outside that, no trustworthy proxy sets the header — ignore it.
  if (!config || config.ingressMode !== 'caddy' || !config.authEnabled) {
    return null;
  }
  if (!headers) return null;

  const raw = headers[IDENTITY_HEADER];
  // Node collapses a single header to a string. An array (or anything non-string)
  // signals a duplicated/ambiguous header — reject rather than guess (fail closed).
  if (typeof raw !== 'string') return null;

  const user = raw.trim();
  return user.length > 0 ? user : null;
}

module.exports = { resolveRequestUser, IDENTITY_HEADER };
