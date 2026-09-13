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
// is more permissive than its success path is not a gate. Concretely: the state
// classifier answers an unreadable store or config as `unreadable`, which
// ENFORCES — only a successful read of `authEnabled` that is not exactly `true`
// opens the door. The one other way the gate stands down, `fallback`, is decided
// last and only on an exact `honoured: true` from a check that proves Caddy's
// gate is in front; any failure there keeps the enforcing state. See
// `resolveGateState`.

const caddy = require('./caddy');
const authSession = require('./auth-session');
const { createLogger } = require('./logger');

const log = createLogger('auth-gate');

/**
 * Every state the front door can be in. See {@link resolveGateState}.
 *
 * `open` and `fallback` let a request through without a question — `open`
 * because nothing is asked of this install, `fallback` because Caddy's gate is
 * asking in front of it (see {@link standsDown}). The other four all ENFORCE;
 * they differ in what a refused person is shown.
 */
const GATE_STATES = Object.freeze({
  OPEN: 'open',
  ACCOUNT_REQUIRED: 'account-required',
  ARMED: 'armed',
  LOCKED: 'locked',
  UNREADABLE: 'unreadable',
  FALLBACK: 'fallback'
});

// Methods that change server state. Same set `server.js` uses for its existing
// CSRF guards; imported from nowhere because `server.js` defines its own and a
// shared constant is worth less than each file stating the set it enforces.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The paths that must answer BEFORE anyone can be logged in, because they are
// how someone logs in. Kept deliberately tiny: every entry here is a hole in
// the gate, so the login page is a SINGLE self-contained document with its CSS
// and script inline rather than a page plus three assets.
//
// This is a SEPARATE list from `GATE_BYPASS_PATHS`, not a copy of it, and the
// distinction is the point. That list answers "what may a caller with no
// credential at all reach" (a health probe, a PWA manifest fetched
// anonymously). This one answers "what does a person who is not logged in need
// in order to log in". They happen to both be exemptions; they are not the same
// question, and merging them would mean a future addition to one silently
// widening the other.
const LOGIN_SURFACE_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me'
]);

// The state-changing paths whose authority comes from the REQUEST BODY rather
// than from the session cookie, and which are therefore not CSRF-checked: the
// login (a password) and the recovery-code redemption (a code).
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
// `POST /api/auth/recover` is here for the same two reasons: a browser still
// holding a session must be able to submit it, and it succeeds only for a caller
// who supplies an unused recovery code, which a cross-site attacker does not
// have. Forcing a victim to redeem the ATTACKER's code would reset the
// attacker's own account and sign the victim into it — the login-CSRF residual
// again, refused upstream by the same `Sec-Fetch-Site: cross-site` guard.
//
// `POST /api/auth/logout` is deliberately NOT here: its authority IS the
// cookie, and an unprotected logout lets any page sign the operator out.
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/recover']);

// The route that creates an install's FIRST account, and the only thing a
// signed-out person may reach while the install is `account-required`.
//
// NOT on `LOGIN_SURFACE_PATHS`, because that list is exempt in every state and
// this route must not be: once an account exists it has nothing to do, and an
// exemption that outlives its purpose is a hole waiting for a future edit to
// the route. The gate waves it through ONLY in `account-required`.
//
// Not CSRF-exempt by listing either, and it does not need to be: no session can
// exist before the first account does, so the CSRF step (which applies only to
// a request carrying a live session) never reaches it.
const ACCOUNT_SETUP_PATH = '/api/auth/set-password';

// The recovery-code page and the route it posts to: how a signed-out person who
// forgot their password sets a new one with a one-time code (ADR 0016, "The
// ruling").
//
// Exempt ONLY in `armed`, the one state a code can succeed in, for the reason
// `ACCOUNT_SETUP_PATH` is state-limited: an exemption that outlives its purpose
// is a hole waiting for a future edit to the route. `account-required` has no
// accounts and so no codes; `locked` has only disabled accounts, whose codes
// never redeem (a revoked person's own codes must not undo the revocation);
// `unreadable` cannot read the store a code is checked against. In each, a
// signed-out person is challenged as for any other path.
//
// Not on `LOGIN_SURFACE_PATHS`, which is exempt in every enforcing state.
const RECOVERY_PATHS = new Set(['/recover', '/api/auth/recover']);

// The paths ANY caller reaches with no credential, on every gate this install
// runs. TangleClaw owns this list (ADR 0015: "one definition, moved, not
// duplicated"); Caddy's `basic_auth` matcher is generated FROM it
// (`lib/caddy.js#_bypassPathRegexp`), so the two gates cannot disagree.
//
//   - `/api/health` — liveness probes and the ingress cutover's health check
//     carry no credential.
//   - `/manifest.json` — browsers fetch a PWA manifest in anonymous mode, so a
//     gated manifest costs a failed fetch (or, behind `basic_auth`, an extra
//     prompt) on every page load. It is static, public-safe app metadata.
//
// Exact canonical paths, no prefixes: a prefix exempts everything a future
// route mounts beneath it. `/openclaw-direct/*` is deliberately absent. Its old
// exemption existed only for Caddy's `basic_auth` prompt loop (#472) — the
// gateway UI's own `Authorization` header displaced the browser's cached Basic
// credential — and the path is not protected any other way:
// `server.js#_openclawProxyHeaders` and `#_openclawWsRequestLines` inject the
// stored gateway token for whoever asks. A session cookie does not ride
// `Authorization`, so this gate has no such loop.
const GATE_BYPASS_PATHS = Object.freeze(['/api/health', '/manifest.json']);

/**
 * Whether TangleClaw's gate waves a path through unauthenticated.
 *
 * Matched on the canonical path (`caddy.caddyCanonicalPath`), for the same
 * reason {@link isLoginSurfacePath} canonicalises — and because Caddy's matcher
 * sees that same form, which is what `server.js`'s fail-closed parity guard
 * relies on.
 *
 * @param {string} rawUrl - The raw request target (`req.url`)
 * @returns {boolean}
 */
function isGateBypassPath(rawUrl) {
  return GATE_BYPASS_PATHS.includes(caddy.caddyCanonicalPath(rawUrl));
}

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
 * Whether a path is the first-account route.
 *
 * Canonicalised like {@link isLoginSurfacePath}, for the same reason.
 *
 * @param {string} rawUrl - The raw request target (`req.url`)
 * @returns {boolean}
 */
function isAccountSetupPath(rawUrl) {
  return caddy.caddyCanonicalPath(rawUrl) === ACCOUNT_SETUP_PATH;
}

/**
 * Whether a path is the recovery-code page or its route.
 *
 * Canonicalised like {@link isLoginSurfacePath}, for the same reason.
 *
 * @param {string} rawUrl - The raw request target (`req.url`)
 * @returns {boolean}
 */
function isRecoveryPath(rawUrl) {
  return RECOVERY_PATHS.has(caddy.caddyCanonicalPath(rawUrl));
}

/**
 * Which state TangleClaw's front door is in on this install.
 *
 *   - `open`             — `authEnabled` is not exactly `true`. ADR 0009's
 *                          deliberate opt-out; nothing is asked.
 *   - `account-required` — `authEnabled`, and no account row exists. CLOSED:
 *                          a signed-out person reaches only the first-account
 *                          screen. This is ADR 0016's
 *                          `credential-migration-required` (an upgraded install
 *                          holding a bcrypt `basicAuthHash` that scrypt cannot
 *                          verify) WITHOUT its hash condition, because an
 *                          install with `authEnabled` and no hash has no key
 *                          either, and leaving it dormant would be an open door
 *                          once Caddy's gate is gone.
 *   - `armed`            — `authEnabled`, and an enabled account exists.
 *   - `locked`           — `authEnabled`, accounts exist, and none is enabled.
 *                          CLOSED, and the first-account screen is NOT offered:
 *                          accounts already exist, so creating one would be a
 *                          way around them. Recovery is `scripts/reset-admin.js`
 *                          on the machine; a recovery code never re-enables a
 *                          disabled account.
 *   - `unreadable`       — the store or the config could not be read. ENFORCES.
 *   - `fallback`         — any enforcing state above, while the operator's
 *                          fallback marker is honoured (`loadFallback`): Caddy's
 *                          `basic_auth` is back in front of TangleClaw and
 *                          TangleClaw stands down behind it. See below.
 *
 * WHY `account-required` MAY BE CLOSED WITH THE FIRST-ACCOUNT SCREEN OPEN TO
 * WHOEVER REACHES IT. No code path deletes a user row (`store.users` has
 * `disable`, never delete), so this state exists only before an install's first
 * account. Anyone who can reach the screen then could already reach this
 * install's dashboard ungated, or had already passed Caddy's gate in front of
 * it. Reach is therefore exactly the authority the operator already had, which
 * is ADR 0016's argument, and it holds for a direct-mode install with a wide
 * bind too. The argument depends on rows never being deleted — a delete verb
 * added to the store would re-open `account-required` on an armed install, so
 * it must answer this first.
 *
 * FAILURE DIRECTION. Both reads are guarded, and an error answers `unreadable`,
 * which enforces. The door this guards is a shell, and a transient store or
 * config fault must never remove it. `authEnabled: false` in a config file that
 * reads successfully stays the recovery lever (with the one caddy-mode exception
 * below), because that is a successful
 * READ of a false value, not an error. A config thunk that returns `null` is a
 * successful read of nothing and answers `open`, matching every other caller of
 * the config that treats an absent `authEnabled` as off.
 *
 * COST. This runs on every request, including every static asset. The account
 * question is one in-process query against a table of a handful of rows, and
 * the caller passes a config thunk that caches on the file's mtime and size
 * (`server.js#_gateConfig`), so the per-request cost is one query and one
 * `stat`. Config is read first because only `authEnabled` separates `open` from
 * `account-required` on an install with no accounts.
 *
 * `authEnabled: false` DOES NOT OPEN A CADDY-MODE INSTALL WHOSE CADDYFILE HAS NO
 * GATE OF ITS OWN. The Caddyfile is written once, by the cutover, for the state
 * at that moment: an armed install gets one with no `basic_auth` whose remote
 * sites are gated by this module alone. This function runs on every request, so
 * flipping `authEnabled` off afterwards would open those remote sites with
 * nothing in front of them. So in caddy mode the opt-out is honoured only while
 * the file on disk is observably not such a door — it still carries
 * `basic_auth`, serves nothing beyond `localhost`, or does not exist
 * (`loadIngress`, answered by `lib/caddy.js#describeIngressDoor`). Otherwise the
 * accounts decide, exactly as if `authEnabled` were on. This is ADR 0016's rule
 * for the fallback marker ("honoured only while the fallback door is observably
 * present") applied to the other way the gate can stand down. A caller that
 * passes no `loadIngress` gets the opt-out unconditionally; every caller on the
 * request path passes one.
 *
 * `fallback` IS DECIDED LAST, AND ONLY OVER A STATE THAT ENFORCES. It is the
 * recovery for a login that broke, so it overrides `account-required`, `armed`,
 * `locked` and `unreadable` alike — `unreadable` especially, which is what a
 * broken gate usually looks like. It never replaces `open`, which already asks
 * nothing. `loadFallback` (`lib/gate-fallback.js#decideFallback` behind a cache
 * in `server.js`) answers `honoured: true` only while the marker exists, the
 * listener is loopback and the Caddyfile on disk puts Caddy's gate in front of
 * every route to TangleClaw. A thunk that throws, or answers anything but
 * exactly `honoured: true`, keeps the enforcing state: a failed read of the
 * other door must never be the reason this one opens.
 *
 * @param {() => object|null} loadConfig - Thunk returning the config. Expected
 *   to THROW when the config cannot be read, which is what separates
 *   `unreadable` from a successful read.
 * @param {{ accountPresence: () => { exists: boolean, loginable: boolean } }} sessions
 *   - `store.authSessions`
 * @param {(() => { ungatedRemoteSite: boolean })|null} [loadIngress] - Thunk
 *   describing the Caddyfile on disk, asked only in caddy mode with
 *   `authEnabled` off. Expected to THROW when the file exists but cannot be
 *   read, which enforces.
 * @param {(() => { honoured: boolean, reason: string|null })|null} [loadFallback] -
 *   Thunk answering whether the fallback marker is honoured, asked only when
 *   the state would otherwise enforce.
 * @returns {'open'|'account-required'|'armed'|'locked'|'unreadable'|'fallback'}
 */
function resolveGateState(loadConfig, sessions, loadIngress = null, loadFallback = null) {
  const state = _resolveEnforcement(loadConfig, sessions, loadIngress);
  if (state === GATE_STATES.OPEN || typeof loadFallback !== 'function') return state;
  let fallback;
  try {
    fallback = loadFallback();
  } catch (err) {
    log.error('Auth gate could not check the fallback marker — ENFORCING', { error: err.message, state });
    return state;
  }
  return fallback && fallback.honoured === true ? GATE_STATES.FALLBACK : state;
}

/**
 * Every state {@link resolveGateState} can reach without the fallback marker.
 * Split out only so the marker is weighed once, after every other branch has
 * answered; each return below is documented on `resolveGateState`.
 *
 * @param {() => object|null} loadConfig - See `resolveGateState`.
 * @param {{ accountPresence: () => { exists: boolean, loginable: boolean } }} sessions
 *   - See `resolveGateState`.
 * @param {(() => { ungatedRemoteSite: boolean })|null} loadIngress - See `resolveGateState`.
 * @returns {'open'|'account-required'|'armed'|'locked'|'unreadable'}
 */
function _resolveEnforcement(loadConfig, sessions, loadIngress) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error('Auth gate could not read config — ENFORCING', { error: err.message });
    return GATE_STATES.UNREADABLE;
  }
  if (!config) return GATE_STATES.OPEN;
  if (config.authEnabled !== true) {
    if (config.ingressMode !== 'caddy' || typeof loadIngress !== 'function') return GATE_STATES.OPEN;
    let ingress;
    try {
      ingress = loadIngress();
    } catch (err) {
      log.error('Auth gate could not read the Caddyfile to honour authEnabled: false — ENFORCING',
        { error: err.message });
      return GATE_STATES.UNREADABLE;
    }
    if (!ingress || typeof ingress.ungatedRemoteSite !== 'boolean'
        || typeof ingress.unguardedLocalSite !== 'boolean') {
      log.error('Auth gate got a malformed Caddyfile description — ENFORCING');
      return GATE_STATES.UNREADABLE;
    }
    if (ingress.ungatedRemoteSite === false && ingress.unguardedLocalSite === false) {
      return GATE_STATES.OPEN;
    }
    if (ingress.ungatedRemoteSite === false) {
      // Only a `localhost` site without the peer guard — local in name, reachable
      // by any machine that asks for `localhost`. Ruled 2026-09-13: that counts
      // against the opt-out only when accounts exist. An install that never had
      // an account keeps `authEnabled: false` working (it is the ADR 0009 opt-out
      // population, whose fix is regenerating the Caddyfile with the guard);
      // one with accounts is closed, because the opt-out would otherwise open
      // an install whose owner once put a login on it.
      let localPresence;
      try {
        localPresence = sessions.accountPresence();
      } catch (err) {
        log.error('Auth gate could not read the user store — ENFORCING', { error: err.message });
        return GATE_STATES.UNREADABLE;
      }
      if (!localPresence || typeof localPresence.exists !== 'boolean') {
        log.error('Auth gate got a malformed answer from the user store — ENFORCING');
        return GATE_STATES.UNREADABLE;
      }
      if (localPresence.exists === false) return GATE_STATES.OPEN;
    }
    // Fall through: the accounts decide, as if authEnabled were on.
  }

  let presence;
  try {
    presence = sessions.accountPresence();
  } catch (err) {
    log.error('Auth gate could not read the user store — ENFORCING', { error: err.message });
    return GATE_STATES.UNREADABLE;
  }
  // Compared with `=== true` / `=== false`, not truthiness: a store answer that
  // is neither is not evidence of anything, and on the path to a shell it must
  // not read as "no accounts, show the first-account screen".
  if (!presence || typeof presence.exists !== 'boolean' || typeof presence.loginable !== 'boolean') {
    log.error('Auth gate got a malformed answer from the user store — ENFORCING');
    return GATE_STATES.UNREADABLE;
  }
  if (presence.loginable === true) return GATE_STATES.ARMED;
  if (presence.exists === true) return GATE_STATES.LOCKED;
  return GATE_STATES.ACCOUNT_REQUIRED;
}

/**
 * The gate state a tool that WRITES the Caddyfile must write for: the config's
 * intent and the accounts, never the shape of the file being replaced.
 *
 * {@link resolveGateState} reads the Caddyfile on disk so that `authEnabled:
 * false` cannot open an install whose file has no gate of its own — the right
 * question for a request, where the file is what is actually serving. It is the
 * wrong question for a writer, whose output IS that file: a writer that asked it
 * would see the old file's missing gate, conclude the login still guards the
 * door, write another file with no gate, and read the same answer back
 * forever. `authEnabled: false` could then never take effect in caddy mode
 * through any tool. So writers ask this instead, and write a file that is
 * correct for what the operator configured; the request gate then reads that
 * file and agrees.
 *
 * Every failure direction of `resolveGateState` is kept: an unreadable config
 * or store still answers `unreadable`, which keeps Caddy's gate.
 *
 * Never `fallback`: the marker says TangleClaw's login is broken right now, not
 * what the operator configured, so a writer ignores it. A file written for
 * `armed` while the marker is set carries no `basic_auth`, the marker stops
 * being honoured on the next request, and TangleClaw enforces again.
 *
 * @param {() => object|null} loadConfig - Thunk returning the config.
 * @param {{ accountPresence: () => { exists: boolean, loginable: boolean } }} sessions
 *   - `store.authSessions`
 * @returns {'open'|'account-required'|'armed'|'locked'|'unreadable'}
 */
function resolveIntendedGateState(loadConfig, sessions) {
  return resolveGateState(loadConfig, sessions, null);
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
 * Four conditions, all required:
 *   1. the socket is loopback — `adminCredential.isLoopbackRemote`, reused
 *      rather than re-derived, because `POST /api/auth/credential` already
 *      authorises on this exact predicate;
 *   2. the request did NOT come through a reverse proxy — no
 *      `X-Forwarded-For`. A loopback socket alone does not mean a local
 *      process: Caddy fronts the remote path and connects to this listener
 *      from loopback too, so without this condition every off-box request
 *      Caddy forwards would be a "machine client". Caddy's `reverse_proxy` sets
 *      the header on every request it forwards and REPLACES a value the client
 *      sent, so a remote caller cannot arrive without it — verified against
 *      Caddy v2.11.4 with a client-forged value, for a plain `reverse_proxy` and
 *      one carrying `header_up`. The fleet (`bin/tc`, PortHub, the switchboard)
 *      never sends the header.
 *
 *      RE-VERIFY THIS CONDITION when any of these changes, because each one is
 *      a way an off-box caller could arrive without the header and look local:
 *        - Caddy's version (the default is Caddy's, not ours);
 *        - a `trusted_proxies` directive, or a `header_up` that removes or
 *          rewrites `X-Forwarded-For`, in any Caddyfile — the generator emits
 *          neither, pinned by `test/auth-gate.test.js`;
 *        - a different local forwarder pointed at this listener (Tailscale
 *          Serve, nginx, cloudflared, …). Each must be checked for whether it
 *          sets the header before it fronts TangleClaw.
 *      A local process tunnelling remote traffic without adding the header (an
 *      `ssh -L` forward) is treated as local, which is right only because
 *      holding such a tunnel already means holding a shell here;
 *   3. the request is not browser-shaped — no `Sec-Fetch-Site` and no `Origin`,
 *      the same discriminator the three CSRF guards in `server.js` already use.
 *      A browser cannot suppress `Sec-Fetch-Site` from script, so a page cannot
 *      disguise itself as the CLI;
 *   4. it carries no session cookie — a browser that HAS signed in is a person,
 *      and must stay subject to the CSRF check rather than slipping into the
 *      machine path by dropping a header.
 *
 * `proxied` must be exactly `false`. The other two negative facts default to
 * "absent" when omitted, but a caller that forgets to say whether a request was
 * proxied must not have it read as local — that omission is the one that would
 * wave remote traffic through.
 *
 * @param {object} opts
 * @param {boolean} opts.loopback - Whether the socket is loopback
 * @param {boolean} opts.proxied - Whether `X-Forwarded-For` is present
 * @param {boolean} opts.browserShaped - Whether `Sec-Fetch-Site` or `Origin` is present
 * @param {boolean} opts.hasSessionCookie - Whether a session cookie was sent
 * @returns {boolean}
 */
function isMachineClient({ loopback, proxied, browserShaped, hasSessionCookie }) {
  return loopback === true && proxied === false
    && browserShaped !== true && hasSessionCookie !== true;
}

/**
 * Whether a gate state lets every request through unasked.
 *
 * One definition, because "is anything being enforced" is asked by the HTTP
 * verdict, the upgrade verdict and the routes, and three spellings of it are
 * three chances for one to treat an unexpected value as open.
 *
 * @param {string} gateState - From {@link resolveGateState}
 * @returns {boolean} true ONLY for exactly `open`
 */
function isOpen(gateState) {
  return gateState === GATE_STATES.OPEN;
}

/**
 * Whether TangleClaw's gate asks nothing of a request in this state: `open`, or
 * `fallback`, where Caddy's gate stands in front and TangleClaw stands down.
 *
 * Asked by the HTTP and upgrade verdicts and by `server.js` when deciding
 * whether to resolve an identity at all. {@link isOpen} stays for the routes
 * that must tell the two apart in what they SAY: "this install does not require
 * a login" is true of `open` and false of `fallback`.
 *
 * @param {string} gateState - From {@link resolveGateState}
 * @returns {boolean} true ONLY for exactly `open` or exactly `fallback`
 */
function standsDown(gateState) {
  return gateState === GATE_STATES.OPEN || gateState === GATE_STATES.FALLBACK;
}

/**
 * Whether TangleClaw's own gate guards the door by itself, so nothing needs to
 * stand in front of it.
 *
 * True ONLY for `armed` and `locked`: the gate enforces, and an account exists
 * behind it, so every request that is not the fleet or a bypass path needs that
 * account's session. Every other state answers false, each for a reason:
 *   - `account-required` — the first-account screen is open to whoever reaches
 *     it, so a remote listener in front of it would let anyone who can reach
 *     that listener claim the install. Caddy's gate stays until an account
 *     exists.
 *   - `unreadable` — the state could not be read, and a failed read must never
 *     be the reason a gate is removed.
 *   - `open` — nothing is enforced at all.
 *   - `fallback` — TangleClaw has stood down, so Caddy's gate is the only one.
 *
 * Asked by everything that decides whether Caddy's gate is still needed, or
 * describes the install as if it were — among them the Caddyfile generator (and
 * whether a remote site may be emitted without it), the drift check, the bind
 * policy, and the Caddy-credential tools in `lib/admin-credential.js`. One
 * definition, so none of them can drop a gate on a state the others would keep
 * it for.
 *
 * @param {string} gateState - From {@link resolveGateState}
 * @returns {boolean}
 */
function guardsTheDoor(gateState) {
  return gateState === GATE_STATES.ARMED || gateState === GATE_STATES.LOCKED;
}

/**
 * Decide what to do with one request.
 *
 * Returns a verdict object rather than touching the response, so the whole
 * rule is testable as data. `server.js` renders the verdict.
 *
 * Order matters and is argued:
 *   1. Gate `open` or `fallback` → allow ({@link standsDown}). Nothing below can
 *      run on an install whose door is not TangleClaw's to keep. Any other
 *      value, including one this module does not know, enforces.
 *   2. CSRF, checked BEFORE the allow-list, so a state-changing request that
 *      rides a real session is validated even when its path is exempt — that
 *      is what covers `POST /api/auth/logout` without a special case for it.
 *   3. A machine client on loopback → allow (see {@link isMachineClient}).
 *      AFTER the CSRF check, deliberately: the machine predicate already
 *      requires no session cookie, so the two can never both apply, and putting
 *      it second means a future widening of the machine predicate cannot
 *      silently become a CSRF exemption as well.
 *   4. Bypass paths → allow.
 *   5. The login surface → allow. The first-account route → allow, but ONLY in
 *      `account-required` (see {@link ACCOUNT_SETUP_PATH}). The recovery page and
 *      route → allow, but ONLY in `armed` (see {@link RECOVERY_PATHS}).
 *      Steps 4 and 5 apply only when `pathname` — what the router will serve —
 *      is the canonical path the exemption matched; a spelling the two read
 *      differently falls through to the steps below.
 *   6. A live session → allow.
 *   7. Otherwise → challenge. `for` says what the refused person needs:
 *      `account-setup` in `account-required`, where there is nothing to sign in
 *      to yet, and `sign-in` in every other enforcing state.
 *
 * @param {object} opts
 * @param {string} opts.method - Upper-case HTTP method
 * @param {string} opts.rawUrl - The raw request target (`req.url`)
 * @param {string} opts.pathname - The parsed pathname
 * @param {string} opts.gateState - From {@link resolveGateState}
 * @param {{ csrfToken: string }|null} opts.session - The resolved session, or null
 * @param {string|null} opts.submittedCsrf - The `X-CSRF-Token` header, or null
 * @param {boolean} [opts.machineClient] - From {@link isMachineClient}
 * @returns {{ action: 'allow' }
 *   | { action: 'refuse-csrf' }
 *   | { action: 'challenge', as: 'json'|'html', for: 'sign-in'|'account-setup' }}
 */
function evaluate({ method, rawUrl, pathname, gateState, session, submittedCsrf, machineClient }) {
  if (standsDown(gateState)) return { action: 'allow' };

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

  // Every exemption below is matched on the canonical path AND honoured only
  // when the router will serve that same path. The canonicaliser and the
  // router disagree on some spellings: `//login` is `/login` to the first and
  // `/` (host `login`) to `new URL`, so an exemption granted on the canonical
  // path alone let `GET //login` or `GET //manifest.json` reach the dashboard
  // shell with no session. A spelling the two disagree on is simply not
  // exempt; it is challenged like any other path.
  const routedAsCanonical = caddy.caddyCanonicalPath(rawUrl) === pathname;
  // `GATE_BYPASS_PATHS` — the same predicate `server.js`'s fail-closed parity
  // guard uses, so the two cannot disagree about how a path is canonicalised.
  if (routedAsCanonical && isGateBypassPath(rawUrl)) return { action: 'allow' };
  if (routedAsCanonical && isLoginSurfacePath(rawUrl)) return { action: 'allow' };
  const accountRequired = gateState === GATE_STATES.ACCOUNT_REQUIRED;
  if (accountRequired && routedAsCanonical && isAccountSetupPath(rawUrl)) return { action: 'allow' };
  const armed = gateState === GATE_STATES.ARMED;
  if (armed && routedAsCanonical && isRecoveryPath(rawUrl)) return { action: 'allow' };

  if (session) return { action: 'allow' };

  // A refused API call gets JSON because its caller is code; a refused page
  // gets a document because its caller is a person. Both carry 401 — a 200 on
  // the login page would tell caches and uptime monitors the request succeeded.
  return {
    action: 'challenge',
    as: pathname.startsWith('/api/') ? 'json' : 'html',
    for: accountRequired ? 'account-setup' : 'sign-in'
  };
}

/**
 * Decide whether a WebSocket upgrade may proceed.
 *
 * Deliberately NOT `evaluate` called with `method: 'GET'`. `evaluate` carries
 * the HTTP exemptions — the bypass list, the login surface, the first-account
 * route and the recovery route — and none of them is a WebSocket route. Routing the
 * handshake through them would mean a future addition to either list silently
 * becomes a way onto a socket that, for `/terminal/*`, is a `--writable` shell.
 * So this takes no path at all: an upgrade is allowed for who is asking, never
 * for where it is going.
 *
 * No CSRF step. A handshake is a `GET`, and the attack CSRF exists for — a page
 * the operator visits acting with their cookie — is refused before this runs by
 * `server.js#handleUpgrade`'s Origin guard, which is the check built for
 * WebSockets precisely because they ignore the same-origin policy.
 *
 * Order:
 *   1. Gate `open` or `fallback` → allow, by {@link standsDown}: on the path to
 *      a shell, a value that is not one of those two exactly must not read as one.
 *   2. A machine client → allow, by the same `isMachineClient` predicate HTTP
 *      uses, so the two transports share one carve-out.
 *   3. A live session → allow.
 *   4. Otherwise → refuse. In `account-required` nobody can hold a session, so
 *      only the fleet gets a socket until the first account exists.
 *
 * @param {object} opts
 * @param {string} opts.gateState - From {@link resolveGateState}
 * @param {object|null} opts.session - The resolved session, or null
 * @param {boolean} [opts.machineClient] - From {@link isMachineClient}
 * @returns {{ action: 'allow' } | { action: 'refuse' }}
 */
function evaluateUpgrade({ gateState, session, machineClient }) {
  if (standsDown(gateState)) return { action: 'allow' };
  if (machineClient === true) return { action: 'allow' };
  if (session) return { action: 'allow' };
  return { action: 'refuse' };
}

module.exports = {
  GATE_STATES,
  UNSAFE_METHODS,
  LOGIN_SURFACE_PATHS,
  CSRF_EXEMPT_PATHS,
  ACCOUNT_SETUP_PATH,
  RECOVERY_PATHS,
  GATE_BYPASS_PATHS,
  isLoginSurfacePath,
  isAccountSetupPath,
  isRecoveryPath,
  isGateBypassPath,
  isMachineClient,
  isOpen,
  standsDown,
  guardsTheDoor,
  resolveGateState,
  resolveIntendedGateState,
  evaluate,
  evaluateUpgrade
};
