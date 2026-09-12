'use strict';

// The decision half of TangleClaw's own front door (#1418, ADR 0015/0016).
//
// `server.js` owns the request and the response; this module owns the verdict,
// so the rule can be read and tested without standing up a server. Every
// function here is a pure function of its arguments — no `req` is mutated, no
// database handle is held, nothing is written.
//
// READ THIS BEFORE CHANGING ANY BRANCH BELOW. Every guard here is asked "what
// happens if this check itself fails?", and the answer must be "the request is
// refused", never "the value it was computing is used". A gate whose error path
// is more permissive than its success path is not a gate. Concretely: the
// activation predicate treats an unreadable config as NOT gated — which sounds
// like the wrong direction until you read why it is the only safe answer here
// (see `isGateActive`), and why it does not open anything.

const caddy = require('./caddy');
const authSession = require('./auth-session');
const { createLogger } = require('./logger');

const log = createLogger('auth-gate');

// Methods that change server state. Same set `server.js` uses for its existing
// CSRF guards; imported from nowhere because `server.js` defines its own and a
// shared constant is worth less than each file stating the set it enforces.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The paths that must answer BEFORE anyone can be logged in, because they are
// how someone logs in. Kept deliberately tiny: every entry here is a hole in
// the gate, so the login page is a SINGLE self-contained document with its CSS
// and script inline rather than a page plus three assets.
//
// This is a SEPARATE list from `caddy.AUTH_BYPASS_PATHS`, not a copy of it, and
// the distinction is the point. That list answers "what does the Caddy gate
// wave through" (a health probe with no credential, OpenClaw's own-auth proxy,
// a PWA manifest fetched anonymously). This one answers "what does a person who
// is not logged in need in order to log in". They happen to both be exemptions;
// they are not the same question, and merging them would mean a future addition
// to one silently widening the other.
const LOGIN_SURFACE_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me'
]);

// The one state-changing path whose authority comes from the REQUEST BODY
// rather than from the session cookie, and which is therefore not CSRF-checked.
//
// This is not a convenience exemption. Without it a browser still holding a
// live session cannot submit the login form at all — the form posts no CSRF
// header, so the check refuses it with a 403 the person has no way to resolve,
// on the one page they visit when something is already wrong. That reaches
// anyone switching accounts, and anyone whose cookie outlived the page.
//
// It costs nothing, because CSRF protects a request that rides ambient
// authority and this one does not: `POST /api/auth/login` succeeds only for a
// caller who supplies a correct password, which is precisely what a cross-site
// attacker does not have. The residual class — forcing a VICTIM into an
// ATTACKER's session by submitting the attacker's credentials cross-site — is
// already refused upstream by `server.js`'s `Sec-Fetch-Site: cross-site` guard,
// which runs before this module is reached.
//
// `POST /api/auth/logout` is deliberately NOT here: its authority IS the
// cookie, and an unprotected logout lets any page sign the operator out.
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login']);

/**
 * Whether a path is part of the login surface.
 *
 * Canonicalised the same way the Caddy bypass is (`caddy.caddyCanonicalPath`):
 * percent-decoded and path-cleaned. Without that, `/api/auth/%6Cogin` and
 * `//login` are different strings to a `Set` and the same route to the router —
 * which is exactly the normalisation-parity leak class #472/#473 already cost
 * this project two rounds to close on the Caddy side.
 *
 * @param {string} rawUrl - The raw request target (`req.url`)
 * @returns {boolean}
 */
function isLoginSurfacePath(rawUrl) {
  return LOGIN_SURFACE_PATHS.has(caddy.caddyCanonicalPath(rawUrl));
}

/**
 * Whether TangleClaw's own session gate is enforcing on this install.
 *
 * TWO conditions, and the second one is this chunk's own decision rather than
 * anything either ADR states, so it is argued here in full:
 *
 *   1. `authEnabled` — the operator's master switch (ADR 0009's opt-out).
 *   2. At least one ENABLED user account exists.
 *
 * Without (2) this change locks the operator out of their own live install on
 * the first boot after it merges. Every caddy-mode install carries
 * `authEnabled: true` with a BCRYPT `basicAuthHash` and ZERO user rows — the
 * users table shipped empty in #1417 on purpose. A gate demanding a session
 * would have no account to issue one against, and `scripts/reset-admin.js`
 * needs a shell on a machine the operator is almost never at.
 *
 * Dormant is not open:
 *   - In caddy mode Caddy's `basic_auth` is untouched by this chunk and stays
 *     in front, so the install is still gated by the door it has today.
 *   - In direct mode the install is exactly as ungated as it already is — this
 *     chunk does not make it worse, it makes it FIXABLE, because an operator
 *     can now create an account and get a real login for the first time.
 *
 * CHUNK 04 MUST REPLACE THIS PREDICATE, NOT EXTEND IT. The same state —
 * `authEnabled` + a `basicAuthHash` + no user row — is ADR 0016's
 * `credential-migration-required`, where the gate is CLOSED and serves only the
 * set-password screen. That inversion is safe there because the cutover removes
 * Caddy's gate in the same change; it is unsafe here for the reason above.
 *
 * The unreadable-config path answers false — "not gated". That is more
 * permissive than the alternative and it is still right: this gate is additive,
 * so refusing to enforce leaves the install exactly as protected as it was
 * before this module existed (Caddy's gate, or a loopback-only listener), while
 * failing the other way would hand a corrupt config file the power to lock the
 * operator out of the tool they would fix it with.
 *
 * THE ARGUMENT ORDER IS A PERFORMANCE CONTRACT, not a style choice. `loadConfig`
 * is a THUNK rather than an already-loaded config because `store.config.load()`
 * is an `existsSync` + `readFileSync` + `JSON.parse` with no cache, and this
 * function runs on every request including every static asset. Asking the
 * account question first — an in-process query against a table with at most a
 * handful of rows — means an install with no accounts (every install today)
 * pays no file I/O at all, and only an install that has genuinely turned the
 * door on reads the config.
 *
 * That config read is deliberately NOT memoised. An operator locked out by a
 * misconfigured gate recovers by setting `authEnabled` false, and a cache would
 * decide how long they stay locked out. Re-reading is the cheap price of the
 * setting taking effect on the next request.
 *
 * @param {() => object|null} loadConfig - Thunk returning config, or null if unreadable
 * @param {{ anyLoginableUser: () => boolean }} sessions - `store.authSessions`
 * @returns {boolean}
 */
function isGateActive(loadConfig, sessions) {
  // Both reads are guarded, and both answer "not gated" on failure — the same
  // direction, for the same reason, stated once here rather than twice inline.
  //
  // The store throws when the database is not open (a request served before
  // `store.init()`, a store that failed to open at boot). Refusing every
  // request in that state would take the dashboard away from the operator on
  // the exact failure they need it to diagnose, and it would gate NOTHING that
  // is not already gated: this door is additive, so declining to enforce it
  // leaves the install as protected as it was before this module existed —
  // Caddy's `basic_auth` in caddy mode, a loopback-only listener in direct
  // mode. Logged at warn, never silently, because a gate that has stopped
  // enforcing is something the operator must be able to find in the log.
  let loginable;
  try {
    loginable = sessions.anyLoginableUser();
  } catch (err) {
    log.warn('Auth gate could not read the user store — not enforcing', { error: err.message });
    return false;
  }
  if (loginable !== true) return false;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.warn('Auth gate could not read config — not enforcing', { error: err.message });
    return false;
  }
  return Boolean(config) && config.authEnabled === true;
}

/**
 * Decide what to do with one request.
 *
 * Returns a verdict object rather than touching the response, so the whole
 * rule is testable as data. `server.js` renders the verdict.
 *
 * Order matters and is argued:
 *   1. Gate inactive → allow. Nothing below can run on an install with no door.
 *   2. CSRF, checked BEFORE the allow-list, so a state-changing request that
 *      rides a real session is validated even when its path is exempt — that
 *      is what covers `POST /api/auth/logout` without a special case for it.
 *   3. Bypass paths → allow.
 *   4. A live session → allow.
 *   5. Otherwise → challenge.
 *
 * @param {object} opts
 * @param {string} opts.method - Upper-case HTTP method
 * @param {string} opts.rawUrl - The raw request target (`req.url`)
 * @param {string} opts.pathname - The parsed pathname
 * @param {boolean} opts.gateActive - From {@link isGateActive}
 * @param {{ csrfToken: string }|null} opts.session - The resolved session, or null
 * @param {string|null} opts.submittedCsrf - The `X-CSRF-Token` header, or null
 * @returns {{ action: 'allow' }
 *   | { action: 'refuse-csrf' }
 *   | { action: 'challenge', as: 'json'|'html' }}
 */
function evaluate({ method, rawUrl, pathname, gateActive, session, submittedCsrf }) {
  if (!gateActive) return { action: 'allow' };

  // CSRF applies to a state-changing request that carries a LIVE SESSION, and
  // to no other. A request with no session is riding no ambient authority, so
  // it is not a CSRF vector — which is precisely what keeps `curl`, the `tc`
  // CLI and the documented agent-facing API working untouched, none of which
  // hold a session cookie. This is the token ADR 0016 says `SameSite=Lax` is
  // not; Lax narrows the attack, the token closes it.
  if (UNSAFE_METHODS.has(method) && session
      && !CSRF_EXEMPT_PATHS.has(caddy.caddyCanonicalPath(rawUrl))) {
    if (!authSession.csrfTokenMatches(submittedCsrf, session.csrfToken)) {
      return { action: 'refuse-csrf' };
    }
  }

  // Caddy's own exemptions, reused rather than restated (ADR 0015: "one
  // definition, moved, not duplicated"). `server.js`'s fail-closed parity guard
  // already depends on this same function, so the two gates cannot drift into
  // disagreeing about what a bypass path is.
  if (caddy.isCaddyAuthBypassPath(rawUrl)) return { action: 'allow' };
  if (isLoginSurfacePath(rawUrl)) return { action: 'allow' };

  if (session) return { action: 'allow' };

  // A refused API call gets JSON because its caller is code; a refused page
  // gets the login document because its caller is a person. Both carry 401 —
  // a 200 on the login page would tell caches and uptime monitors the request
  // succeeded.
  return { action: 'challenge', as: pathname.startsWith('/api/') ? 'json' : 'html' };
}

module.exports = {
  UNSAFE_METHODS,
  LOGIN_SURFACE_PATHS,
  CSRF_EXEMPT_PATHS,
  isLoginSurfacePath,
  isGateActive,
  evaluate
};
