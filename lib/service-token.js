/**
 * M2M fleet service token (AUTH-4).
 *
 * PortHub (`/api/ports*`) and shared-docs (`/api/shared-docs*` + a group's
 * `/sync`) are machine-to-machine surfaces every project on the host calls. The
 * AUTH-2 Caddy `basic_auth` gate only covers REMOTE callers (caddy mode); local
 * fleet callers reach `localhost` directly, bypassing Caddy, so those surfaces
 * are otherwise unauthenticated. This module is the TC-level bearer-token gate on
 * exactly that direct path — the part of the API `basic_auth` structurally can't
 * protect.
 *
 * The gate is keyed on two config fields: `serviceTokenEnabled` (master switch,
 * default OFF so existing local callers keep working) and `serviceToken` (the raw
 * fleet token, stored at rest like the existing `auditSecret`/`bridgeToken` so TC
 * can auto-inject it into each project's config guide — a one-way hash would make
 * that injection impossible).
 *
 * Scope is deliberately narrow (the AUTH-4 spec): the two named surfaces plus a
 * group's `/sync` (documented as a shared-docs operation). The broader
 * `/api/groups*` CRUD stays open — out of scope for this chunk.
 *
 * @module lib/service-token
 */

'use strict';

const crypto = require('crypto');

/**
 * Prefix on every generated token — makes it greppable/identifiable in configs
 * and in any log it should never have reached.
 * @type {string}
 */
const TOKEN_PREFIX = 'tcsk_';

/**
 * Generate a new high-entropy fleet token: `tcsk_` + 32 random bytes base64url
 * (~43 url-safe chars). Zero-dependency (node `crypto`).
 * @returns {string}
 */
function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Whether a request to `pathname` must carry a valid service token.
 *
 * Pathname-prefix predicate (not a per-route flag) so any FUTURE sub-route under
 * the gated surfaces is gated automatically — fail-safe by construction, and no
 * 14 route registrations to keep in sync. Gated: `/api/ports` and `/api/ports/*`,
 * `/api/shared-docs` and `/api/shared-docs/*`, and `/api/groups/:id/sync` (only
 * the sync among the groups routes — the rest of `/api/groups*` is out of scope).
 *
 * @param {string} pathname - The request URL path (no query string).
 * @returns {boolean}
 */
function requiresServiceToken(pathname) {
  if (typeof pathname !== 'string') return false;
  if (pathname === '/api/ports' || pathname.startsWith('/api/ports/')) return true;
  if (pathname === '/api/shared-docs' || pathname.startsWith('/api/shared-docs/')) return true;
  if (/^\/api\/groups\/[^/]+\/sync$/.test(pathname)) return true;
  return false;
}

/**
 * Extract a bearer token from request headers.
 * @param {object|null} headers - `req.headers` (keys lower-cased by Node).
 * @returns {string|null} The token, or null when absent/malformed.
 */
function _extractBearer(headers) {
  if (!headers) return null;
  const raw = headers.authorization;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null;
  const token = raw.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time string equality, length-safe. `crypto.timingSafeEqual` throws on
 * unequal buffer lengths, so guard length first (token length is not the secret).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate a request against the service-token gate.
 *
 * Fail-closed semantics:
 * - Gate OFF (`!serviceTokenEnabled`) ⇒ allow. Preserves today's open behavior;
 *   the reversibility contract — disabling restores the prior surface exactly.
 * - Gate ON but no `serviceToken` ⇒ 500 misconfigured. The UI auto-generates the
 *   token on enable, so this only happens via a hand-edited config; it must NOT
 *   silently open the gate (symmetric with AUTH-2's both-or-neither guard).
 * - Missing/malformed `Authorization: Bearer` ⇒ 401.
 * - Wrong token ⇒ 401 (constant-time comparison, no timing oracle).
 * - Correct token ⇒ allow.
 *
 * @param {object|null} headers - `req.headers`.
 * @param {object|null} config - Merged TC config; reads `serviceTokenEnabled`
 *   and `serviceToken` only.
 * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
 */
function validateRequest(headers, config) {
  if (!config || !config.serviceTokenEnabled) {
    return { ok: true };
  }
  if (!config.serviceToken) {
    return {
      ok: false,
      status: 500,
      code: 'SERVICE_TOKEN_MISCONFIGURED',
      message: 'Service token gate is enabled but no token is configured'
    };
  }
  const presented = _extractBearer(headers);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Missing or malformed Authorization: Bearer header'
    };
  }
  if (!_safeEqual(presented, config.serviceToken)) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_SERVICE_TOKEN',
      message: 'Invalid service token'
    };
  }
  return { ok: true };
}

module.exports = { generateToken, requiresServiceToken, validateRequest, TOKEN_PREFIX };
