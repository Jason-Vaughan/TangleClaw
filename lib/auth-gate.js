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
// activation predicate answers an unreadable config as NOT gated WHILE THE GATE
// HAS NEVER BEEN ARMED — which sounds like the wrong direction until you read
// why it opens nothing — and as GATED once this process has served an armed
// request, because from then on failing open would silently remove a door the
// install is relying on. See `isGateActive`.

const caddy = require('./caddy');
const authSession = require('./auth-session');
const { createLogger } = require('./logger');

const log = createLogger('auth-gate');

// Whether this process has ever seen the gate armed. Read by `isGateActive` to
// decide which way a read FAILURE should fall — see the reasoning there.
let _everArmed = false;

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
 * A read FAILURE answers differently before and after the gate has been armed —
 * fail-open while dormant, fail-CLOSED once armed. The body argues both.
 *
 * THE ARGUMENT ORDER IS A PERFORMANCE CONTRACT, not a style choice. `loadConfig`
 * is a THUNK rather than an already-loaded config because reading config is a
 * file read plus a JSON parse, and this function runs on every request including
 * every static asset. Asking the account question first — an in-process query
 * against a table with at most a handful of rows — means an install with no
 * accounts pays no config read at all, and only an install that has genuinely
 * turned the door on pays one.
 *
 * The caller is expected to pass a thunk that caches on the config file's mtime
 * and size (`server.js#_gateConfig`) rather than one that re-reads. That keeps
 * the property this ordering was written for — an operator locked out by a
 * misconfigured gate sets `authEnabled: false` and it takes effect on the very
 * next request, because the edit changes both mtime and size — without putting
 * synchronous disk I/O on the event loop of every asset request.
 *
 * @param {() => object|null} loadConfig - Thunk returning the config. It is
 *   expected to THROW when the config cannot be read — that is what the
 *   fail-closed branch below distinguishes from a successful read of nothing,
 *   and a thunk that swallows into `null` makes that branch unreachable. A
 *   `null` return is still handled, and is treated as "not gated".
 * @param {{ anyLoginableUser: () => boolean }} sessions - `store.authSessions`
 * @returns {boolean}
 */
function isGateActive(loadConfig, sessions) {
  // Both reads are guarded, and the answer on failure DEPENDS ON WHETHER THIS
  // GATE HAS EVER BEEN ARMED. The two cases are genuinely different and
  // collapsing them was a real hole:
  //
  // BEFORE the gate has ever been armed, a read failure answers "not gated".
  // Refusing every request in that state would take the dashboard away from the
  // operator on the exact failure they need it to diagnose, and it gates
  // nothing that is not already gated — this door is additive, so declining to
  // enforce leaves the install as protected as it was before this module
  // existed (Caddy's `basic_auth` in caddy mode, a loopback-only listener in
  // direct mode).
  //
  // AFTER it has been armed once, that argument stops holding: the install IS
  // relying on this door, and a transient store or config error would silently
  // un-gate a direct-mode install for as long as it lasted, with a `log.warn`
  // as the only trace. So once `_everArmed` is set, an ERROR answers "gated"
  // and the caller challenges. `authEnabled: false` stays the recovery lever,
  // because that is a successful READ of a false value, not an error.
  //
  // `_everArmed` is per-process and resets on restart, which is the honest
  // scope: it is a memory of what this process has seen, not a persisted claim.
  let loginable;
  try {
    loginable = sessions.anyLoginableUser();
  } catch (err) {
    if (_everArmed) {
      log.error('Auth gate could not read the user store — ENFORCING, because this '
        + 'install has an armed gate and failing open would silently remove it',
      { error: err.message });
      return true;
    }
    log.warn('Auth gate could not read the user store — not enforcing', { error: err.message });
    return false;
  }
  if (loginable !== true) return false;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (_everArmed) {
      log.error('Auth gate could not read config — ENFORCING, because this install '
        + 'has an armed gate and failing open would silently remove it', { error: err.message });
      return true;
    }
    log.warn('Auth gate could not read config — not enforcing', { error: err.message });
    return false;
  }
  const active = Boolean(config) && config.authEnabled === true;
  if (active) _everArmed = true;
  return active;
}

/**
 * Reset the armed memory. Tests only — there is no operational reason to forget
 * that this process has served a gated request.
 * @returns {void}
 */
function _resetArmedMemory() {
  _everArmed = false;
}

/**
 * Whether this request is a MACHINE client on the loopback listener, and so
 * outside the tier-1 front door entirely.
 *
 * This carve-out is the difference between a login and an outage, and it is a
 * scope decision rather than a convenience. TangleClaw's loopback listener is
 * not only a dashboard: `bin/tc` runs on it, every project on this machine
 * leases ports through `/api/ports*`, shared docs sync over it, and agent
 * sessions pass switchboard messages across it. None of them holds a cookie and
 * none can be handed one, so a session gate in front of them refuses the whole
 * fleet the moment an operator creates an account — including the `tc` CLI the
 * project guide tells every session to use.
 *
 * **It opens nothing that was not already open.** These callers reach
 * TangleClaw only over loopback, which is the perimeter ADR 0009 gives them:
 * in direct mode the listener binds `127.0.0.1` by default, and in caddy mode
 * Caddy fronts the remote path while the loopback bind stays reachable to local
 * processes exactly as it is today. Tier 1 is the door a PERSON walks through;
 * machine callers are AUTH-4's domain, and its service-token gate still runs
 * below this one, unchanged, on the surfaces it covers.
 *
 * Three conditions, all required:
 *   1. the socket is loopback — `adminCredential.isLoopbackRemote`, reused
 *      rather than re-derived, because `POST /api/auth/credential` already
 *      authorises on this exact predicate;
 *   2. the request is not browser-shaped — no `Sec-Fetch-Site` and no `Origin`,
 *      the same discriminator the three CSRF guards in `server.js` already use.
 *      A browser cannot suppress `Sec-Fetch-Site` from script, so a page cannot
 *      disguise itself as the CLI;
 *   3. it carries no session cookie — a browser that HAS signed in is a person,
 *      and must stay subject to the CSRF check rather than slipping into the
 *      machine path by dropping a header.
 *
 * ⚠ CHUNK 04 MUST REVISIT THIS. The carve-out is sound while something else
 * fronts the remote path, which is true here because Caddy's `basic_auth` is
 * still up. Once #1420 removes it, a loopback socket no longer implies a local
 * process — Caddy's own proxied traffic arrives from loopback too — and the
 * condition has to become something a remote caller cannot manufacture (a
 * service token, or a listener split). Recorded here rather than in a plan
 * because this is the line that would have to change.
 *
 * @param {object} opts
 * @param {boolean} opts.loopback - Whether the socket is loopback
 * @param {boolean} opts.browserShaped - Whether `Sec-Fetch-Site` or `Origin` is present
 * @param {boolean} opts.hasSessionCookie - Whether a session cookie was sent
 * @returns {boolean}
 */
function isMachineClient({ loopback, browserShaped, hasSessionCookie }) {
  return loopback === true && browserShaped !== true && hasSessionCookie !== true;
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
 *   3. A machine client on loopback → allow (see {@link isMachineClient}).
 *      AFTER the CSRF check, deliberately: the machine predicate already
 *      requires no session cookie, so the two can never both apply, and putting
 *      it second means a future widening of the machine predicate cannot
 *      silently become a CSRF exemption as well.
 *   4. Bypass paths → allow.
 *   5. A live session → allow.
 *   6. Otherwise → challenge.
 *
 * @param {object} opts
 * @param {string} opts.method - Upper-case HTTP method
 * @param {string} opts.rawUrl - The raw request target (`req.url`)
 * @param {string} opts.pathname - The parsed pathname
 * @param {boolean} opts.gateActive - From {@link isGateActive}
 * @param {{ csrfToken: string }|null} opts.session - The resolved session, or null
 * @param {string|null} opts.submittedCsrf - The `X-CSRF-Token` header, or null
 * @param {boolean} [opts.machineClient] - From {@link isMachineClient}
 * @returns {{ action: 'allow' }
 *   | { action: 'refuse-csrf' }
 *   | { action: 'challenge', as: 'json'|'html' }}
 */
function evaluate({ method, rawUrl, pathname, gateActive, session, submittedCsrf, machineClient }) {
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

  // The fleet: `bin/tc`, PortHub, shared docs, the switchboard. Outside tier 1
  // by scope, not by oversight — see `isMachineClient`.
  if (machineClient === true) return { action: 'allow' };

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
  isMachineClient,
  isGateActive,
  evaluate,
  _resetArmedMemory
};
