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

/**
 * Valid `authStatus` values (AUTH-2K9D). See `resolveAuthStatus`.
 * @type {string[]}
 */
const AUTH_STATUSES = ['off', 'live', 'configured-inert', 'configured-no-identity'];

/**
 * Classify the effective auth-enforcement state for a request (AUTH-2K9D) so the
 * dashboard can warn on a config-vs-live mismatch. **Surfacing only — never
 * enforces.** Derived from config plus the same trust-gated identity resolution
 * that produces `currentUser`; see `docs/auth-status-surfacing.md`.
 *
 * | return | condition | meaning |
 * |---|---|---|
 * | `off` | `authEnabled` falsy | auth not configured (expected) |
 * | `configured-inert` | `authEnabled` && `ingressMode !== 'caddy'` | AUTH-2: settable-but-inert — direct mode has no in-process gate; only the Caddy cutover reads `authEnabled` |
 * | `live` | `authEnabled` && caddy && identity present | gate enforcing, identity flowing |
 * | `configured-no-identity` | `authEnabled` && caddy && identity null | AUTH-3: gate up but no identity arriving (missing `header_up X-Auth-User`, or the request didn't traverse Caddy / cutover not yet run) |
 *
 * @param {object} headers - Request headers (`req.headers`). May be undefined/null.
 * @param {object} config - Merged TC config; reads `ingressMode` + `authEnabled`.
 *   May be undefined/null.
 * @returns {'off'|'live'|'configured-inert'|'configured-no-identity'}
 */
function resolveAuthStatus(headers, config) {
  if (!config || !config.authEnabled) return 'off';
  // authEnabled is true. In any non-caddy ingress the flag is inert — only the
  // Caddy cutover installs a gate, so direct mode enforces nothing (AUTH-2).
  if (config.ingressMode !== 'caddy') return 'configured-inert';
  // Caddy mode: the gate should be live. A trust-gated identity ⇒ healthy; null ⇒
  // gate up but identity not arriving (AUTH-3), which resolveRequestUser reports
  // as null under the same live-gate precondition checked above.
  return resolveRequestUser(headers, config) ? 'live' : 'configured-no-identity';
}

module.exports = { resolveRequestUser, resolveAuthStatus, IDENTITY_HEADER, AUTH_STATUSES };
