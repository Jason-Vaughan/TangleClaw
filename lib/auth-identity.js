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
 * Header whose presence marks a request as having traversed a reverse proxy.
 * Caddy's `reverse_proxy` sets `X-Forwarded-For` on every upstream request, so
 * in caddy mode its absence means the client reached TC's loopback bind
 * directly (e.g. `curl localhost:3102`, a local browser) without passing the
 * gate — a legitimate access path, not evidence the gate is broken. Used ONLY
 * to classify the `authStatus` diagnostic; never consulted for identity trust
 * (spoofing it can at most show the spoofer a warning chip).
 * @type {string}
 */
const PROXY_EVIDENCE_HEADER = 'x-forwarded-for';

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
const AUTH_STATUSES = ['off', 'live', 'configured-inert', 'configured-no-identity', 'configured-bypassed'];

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
 * | `configured-no-identity` | `authEnabled` && caddy && identity null && request traversed a proxy | AUTH-3: gate up but no identity arriving (missing `header_up X-Auth-User`) |
 * | `configured-bypassed` | `authEnabled` && caddy && identity null && no proxy evidence | request reached TC's loopback bind directly without traversing Caddy — gate health unknowable from this request, no warning warranted |
 *
 * The proxy-evidence split (AUTH-5N2J) exists because Caddy connects to TC from
 * loopback just like a direct local client, so the remote address can't tell the
 * two apart — but Caddy always sets `X-Forwarded-For` and a direct client sends
 * none. Without the split, every direct-loopback dashboard load false-positived
 * the amber `configured-no-identity` warning against a healthy gate.
 *
 * @param {object} headers - Request headers (`req.headers`). May be undefined/null.
 * @param {object} config - Merged TC config; reads `ingressMode` + `authEnabled`.
 *   May be undefined/null.
 * @returns {'off'|'live'|'configured-inert'|'configured-no-identity'|'configured-bypassed'}
 */
function resolveAuthStatus(headers, config) {
  if (!config || !config.authEnabled) return 'off';
  // authEnabled is true. In any non-caddy ingress the flag is inert — only the
  // Caddy cutover installs a gate, so direct mode enforces nothing (AUTH-2).
  if (config.ingressMode !== 'caddy') return 'configured-inert';
  // Caddy mode: the gate should be live. A trust-gated identity ⇒ healthy.
  if (resolveRequestUser(headers, config)) return 'live';
  // No identity. Only a request that demonstrably traversed a proxy can testify
  // that identity forwarding is broken (AUTH-3); a direct-loopback request
  // simply never passed the gate (AUTH-5N2J) — flagging it would be a false
  // positive. Any non-empty X-Forwarded-For (string or duplicated array header)
  // counts as traversal evidence.
  const forwarded = headers && headers[PROXY_EVIDENCE_HEADER];
  const traversedProxy = Array.isArray(forwarded) ? forwarded.length > 0 : typeof forwarded === 'string' && forwarded.trim().length > 0;
  return traversedProxy ? 'configured-no-identity' : 'configured-bypassed';
}

module.exports = { resolveRequestUser, resolveAuthStatus, IDENTITY_HEADER, PROXY_EVIDENCE_HEADER, AUTH_STATUSES };
