'use strict';

// TangleClaw's own session layer — the front door ADR 0015 says TangleClaw owns.
//
// This module is pure mechanism: minting, hashing, serialising and comparing.
// It holds no database handle and no request. The persistence lives in
// `store.authSessions` and the verdict in `lib/auth-gate.js`, so this file can
// be read and tested without either.
//
// WHY A COOKIE AND NOT A BEARER TOKEN (ADR 0016 OQ1, decided before any of this
// was written): a browser cannot set a header on a WebSocket handshake — the
// `WebSocket` constructor takes a URL and a subprotocol list and nothing else.
// A bearer token could only reach `server.js`'s `handleUpgrade` through the
// query string (which lands a live credential in every access log and in the
// `log.warn` calls there that already print `path`) or by abusing
// `Sec-WebSocket-Protocol` as a credential channel. A cookie is attached by the
// browser to a same-origin upgrade automatically, arrives on the very `req`
// that `handleUpgrade` already inspects, and can be `HttpOnly` so page script
// cannot read it. One cookie therefore covers the dashboard, `/terminal/*` and
// the OpenClaw gateway — which is the claim ADR 0015 rests "one gate, four
// paths" on.

const crypto = require('node:crypto');

/** Name of the session cookie. HttpOnly — this one is the credential. */
const SESSION_COOKIE = 'tc_session';

// Name of the cookie carrying the CSRF token. DELIBERATELY readable by page
// script, which is what makes it useful: `public/api-helper.js` reads it and
// echoes it into `X-CSRF-Token` on every state-changing request, so no page
// needs a bootstrap fetch before it can write, and a page that never calls
// `/api/auth/me` still works.
//
// A readable CSRF cookie is not a weakening. The server compares the submitted
// header against the token stored on the SESSION ROW, never against this
// cookie, so an attacker who can plant cookies on the origin still cannot
// produce a value that matches — which is the residual that plain
// double-submit carries and this does not.
const CSRF_COOKIE = 'tc_csrf';

/** Name of the header the CSRF token is double-submitted in. */
const CSRF_HEADER = 'x-csrf-token';

/** Bytes of entropy in a session token and in a CSRF token. */
const TOKEN_BYTES = 32;

// Absolute lifetime, not a sliding one. A sliding window is a second expiry
// rule to reason about and a write on every request, and it buys nothing here:
// the operator reaches this dashboard from a phone over a tailnet, where being
// signed out once a month is the whole cost. Deliberately a constant rather
// than a config key — a preference nobody has asked for is a surface to
// maintain, and the auth settings surface is revisited in chunk 05's #803 work.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mint a fresh, unguessable token.
 * @returns {string} 64 hex characters (32 bytes of CSPRNG output)
 */
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Hash a session token for storage.
 *
 * What is persisted is this digest, never the token itself. A session token is
 * a bearer credential for as long as it lives, so a database read — a backup, a
 * `.dump` pasted into an issue, a stray `SELECT *` in a log — must not hand
 * anyone a live session. SHA-256 with no salt on purpose: the input is 32 bytes
 * of CSPRNG output, so there is no dictionary to stretch against and a
 * per-row salt would only prevent the indexed lookup this is for.
 *
 * @param {string} token - The raw token from the cookie
 * @returns {string} 64 hex characters
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The expiry timestamp for a session created now.
 * @param {number} [now] - Epoch ms; defaults to the clock. Injectable for tests.
 * @returns {number} Epoch ms at which the session stops being valid
 */
function expiryFrom(now) {
  return (typeof now === 'number' ? now : Date.now()) + SESSION_TTL_MS;
}

/**
 * Parse a `Cookie` header into a plain object.
 *
 * Tolerant by design: a malformed pair is skipped rather than thrown on. This
 * runs on every request including unauthenticated ones, so a browser carrying
 * one broken cookie from some other tool must not take the server down — it
 * should simply be treated as not carrying ours.
 *
 * @param {string|undefined} header - The raw `Cookie` header
 * @returns {Record<string,string>} Decoded name → value pairs
 */
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // A value with invalid percent-encoding is not ours — ours is hex.
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Read the session token out of a request's cookies.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null} The raw token, or null when absent
 */
function tokenFromRequest(req) {
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : undefined);
  const token = cookies[SESSION_COOKIE];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Whether this request reached us over a secure transport.
 *
 * `X-Forwarded-Proto` is consulted because in caddy ingress mode TangleClaw
 * sits behind Caddy, which terminates TLS and forwards over plain HTTP to
 * 127.0.0.1 — so `req.socket.encrypted` is false on exactly the deployment
 * where the cookie most needs `Secure`. Trusting that header is safe here and
 * only here: getting it wrong in the permissive direction sets `Secure` on a
 * cookie, which can only ever cause a browser to withhold it (a failed login,
 * visibly), never to send it somewhere it should not go.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSecureRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers && req.headers['x-forwarded-proto'];
  if (typeof proto !== 'string') return false;
  return proto.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Build the `Set-Cookie` value that carries a session.
 *
 * Attributes are ADR 0016's, and the conditional one is the load-bearing one:
 * `Secure` is set only when the request arrived over https, NOT unconditionally.
 * A direct-mode install on plain http over the tailnet is a supported shape
 * (ADR 0003), and a `Secure` cookie is silently never stored there — producing
 * a login that appears to succeed and then does nothing, which is the worst
 * failure an auth system can have because it looks like the user's mistake.
 *
 * @param {string} token - The raw session token
 * @param {object} opts
 * @param {boolean} opts.secure - Whether to set the `Secure` attribute
 * @param {number} [opts.maxAgeMs] - Cookie lifetime; defaults to the session TTL
 * @returns {string} A `Set-Cookie` header value
 */
function serializeCookie(token, { secure, maxAgeMs } = {}) {
  const age = Math.floor((typeof maxAgeMs === 'number' ? maxAgeMs : SESSION_TTL_MS) / 1000);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the operator follows links to this dashboard (from a
    // chat, from a notification), and Strict would present them a login page on
    // arrival every time. Lax carries the session on top-level navigation while
    // withholding it from cross-site form posts. It is NOT the CSRF defence —
    // the per-session token below is; see `server.js`'s gate.
    'SameSite=Lax',
    `Max-Age=${age}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the `Set-Cookie` value that carries the CSRF token.
 *
 * Same attributes as the session cookie MINUS `HttpOnly`, because the page has
 * to read it. It shares the session's lifetime so the two expire together —
 * a page holding a CSRF token for a session that is gone would send a header
 * that can only ever be refused.
 *
 * @param {string} csrfToken
 * @param {object} opts
 * @param {boolean} opts.secure
 * @param {number} [opts.maxAgeMs]
 * @returns {string} A `Set-Cookie` header value
 */
function serializeCsrfCookie(csrfToken, { secure, maxAgeMs } = {}) {
  const age = Math.floor((typeof maxAgeMs === 'number' ? maxAgeMs : SESSION_TTL_MS) / 1000);
  const parts = [
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${age}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the `Set-Cookie` value that clears the CSRF cookie.
 * @param {object} opts
 * @param {boolean} opts.secure
 * @returns {string}
 */
function clearCsrfCookie({ secure } = {}) {
  const parts = [`${CSRF_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Build the `Set-Cookie` value that clears a session cookie.
 *
 * Must repeat every attribute that scopes the original except the lifetime: a
 * browser matches a replacement cookie on name, domain and path, so a clear
 * written without `Path=/` leaves the real cookie in place and logout silently
 * does nothing on any page below the root.
 *
 * @param {object} opts
 * @param {boolean} opts.secure
 * @returns {string} A `Set-Cookie` header value that expires the cookie
 */
function clearCookie({ secure } = {}) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Remove TangleClaw's own cookies from a `Cookie` header value.
 *
 * Every reverse-proxy path in `server.js` copies the incoming headers to its
 * upstream, so without this the session cookie travels to ttyd and to the
 * OpenClaw gateway — which for OpenClaw can be a REMOTE host through a tunnel.
 * Neither upstream has any use for it, and a credential that travels further
 * than it is needed is exactly how the #470 class of bug happens; ADR 0016 OQ1
 * records the requirement as a consequence of choosing a cookie.
 *
 * Removes only OUR two names and leaves everything else in place. Dropping the
 * whole header would be simpler and wrong: the OpenClaw gateway sets its own
 * cookies through this proxy, and stripping them would break its UI while
 * looking like a TangleClaw bug.
 *
 * @param {string|undefined} header - The raw `Cookie` header value
 * @returns {string|undefined} The header with our cookies removed, or undefined
 *   when nothing is left to send
 */
function stripOwnCookies(header) {
  if (typeof header !== 'string' || header === '') return undefined;
  const kept = header.split(';').filter((part) => {
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    return name !== SESSION_COOKIE && name !== CSRF_COOKIE;
  }).map((p) => p.trim()).filter(Boolean);
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * Copy a header object for an upstream, with our cookies removed.
 *
 * The `Cookie` key is DELETED rather than set to an empty string when nothing
 * survives: an empty `Cookie:` header is a malformed request to some servers,
 * and "no cookies" is what we mean.
 *
 * @param {object} headers - Headers destined for an upstream (lowercased keys)
 * @returns {object} The same headers with the session and CSRF cookies gone
 */
function stripOwnCookiesFromHeaders(headers) {
  const out = { ...headers };
  const stripped = stripOwnCookies(out.cookie);
  if (stripped === undefined) delete out.cookie;
  else out.cookie = stripped;
  return out;
}

/**
 * Constant-time comparison of a submitted CSRF token against the session's.
 *
 * Length is compared first because `crypto.timingSafeEqual` THROWS on unequal
 * buffer lengths — the same trap `lib/password.js` documents. Comparing lengths
 * leaks nothing: the length of a CSRF token is a public constant.
 *
 * @param {*} submitted - Whatever arrived in the header
 * @param {*} expected - The token stored on the session
 * @returns {boolean} true only on an exact match of two non-empty strings
 */
function csrfTokenMatches(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string') return false;
  if (submitted.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(submitted, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Read the submitted CSRF token off a request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function csrfTokenFromRequest(req) {
  const v = req && req.headers ? req.headers[CSRF_HEADER] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  serializeCsrfCookie,
  clearCsrfCookie,
  SESSION_TTL_MS,
  mintToken,
  hashToken,
  expiryFrom,
  parseCookies,
  tokenFromRequest,
  isSecureRequest,
  serializeCookie,
  clearCookie,
  csrfTokenMatches,
  csrfTokenFromRequest,
  stripOwnCookies,
  stripOwnCookiesFromHeaders
};
