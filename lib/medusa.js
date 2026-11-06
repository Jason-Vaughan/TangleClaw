'use strict';

/**
 * Medusa service layer (MED-2K9P Chunk 01).
 *
 * Owns the lifecycle of per-session `MedusaListener` instances and mediates
 * between TC's server routes and the WS listener + id registry. Server routes
 * are thin pass-throughs to the functions here; the browser never talks to the
 * Medusa Bridge directly — TC is the single integration point.
 *
 * This chunk implements start/stop/status plus inbox pass-throughs. Outbound
 * send (`sendMessage`) and roster proxying (`getRoster`) are added in Chunk 03 —
 * they talk to the Bridge's HTTP API (`:3009`), whereas the listener speaks WS
 * (`:3010`); the browser still never touches the Bridge directly.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createLogger } = require('./logger');
const registry = require('./medusa-registry');
const { MedusaListener, DEFAULT_BRIDGE_URL, DEFAULT_MAX_INBOX, LISTENER_ERROR_CODES } = require('./medusa-listener');

const log = createLogger('medusa');

/** @type {Map<string, MedusaListener>} Active listeners keyed by session id. */
const listeners = new Map();

/**
 * Sessions whose `startSession()` failed closed on an explicit, refused
 * `MEDUSA_BRIDGE_WS_URL` (#2354) — no `MedusaListener` was ever created for
 * these, so `listeners` has nothing to answer `getStatus()` with. Kept here
 * so a later status poll, and the toggle route's own re-fetch of status right
 * after calling `startSession`, both see the same refusal instead of reading
 * back a generic, unexplained `off`. Cleared the moment a listener for that
 * session is created or explicitly stopped.
 * @type {Map<string, {state: string, listeningSince: null, workspaceId: null, unread: number, lastError: string, lastErrorCode: string}>}
 */
const _refusedSessions = new Map();

/**
 * Mail carried forward from a session whose listener still held unhandled
 * messages when it was torn down (#1806), keyed by project path. A wrap that
 * ends a session retires its workspace id for good (`forgetSession` below),
 * so the Hub's redelivery-on-register never reaches a message still sitting
 * unhandled in that listener's inbox at that moment — nothing will ever
 * reconnect under the retired id to claim it. `_captureCarriedMail` fills
 * this at teardown; `claimCarriedMail` drains it the next time a listener
 * starts for the same project, so the successor session's listener is seeded
 * with what the predecessor could not deliver.
 *
 * Process-local, like every other in-memory registry here: a TC restart
 * loses it along with every listener. Keyed on project path rather than
 * session id because the successor session's id does not exist yet when the
 * predecessor's mail is captured.
 * @type {Map<string, object[]>}
 */
const _carriedMail = new Map();

/**
 * Capture a session's still-unhandled inbox for its project's next listener,
 * merged with (appended after) any mail already carried from an earlier
 * stranding, so a second teardown before the first is ever claimed does not
 * overwrite it. Capped to `DEFAULT_MAX_INBOX`, oldest dropped first, for the
 * same reason the listener's own inbox is bounded (#1108): a project that
 * never relaunches Medusa must not grow this map without bound.
 * No-op when the session has no listener or nothing is unhandled. Never
 * throws: called from `forgetSession`'s own best-effort teardown, and a
 * capture failure must not be what stops the listener from stopping or the
 * workspace id from being forgotten.
 * @param {string} projectPath - Registry key.
 * @param {string|number} sessionId - The ending session's TC id.
 * @returns {void}
 */
function _captureCarriedMail(projectPath, sessionId) {
  try {
    // Through `module.exports`, not the closure-local binding: a caller that
    // stubs `medusa.getMessages = ...` (several test files do this for other
    // functions in this module) must reach this read too.
    const stranded = module.exports.getMessages(sessionId);
    if (stranded.length === 0) return;
    const existing = _carriedMail.get(projectPath) || [];
    const merged = existing.concat(stranded);
    const capped = merged.length > DEFAULT_MAX_INBOX ? merged.slice(merged.length - DEFAULT_MAX_INBOX) : merged;
    _carriedMail.set(projectPath, capped);
    log.info('Carrying unhandled Medusa mail forward to this project\'s next session', {
      projectPath, sessionId: String(sessionId), count: stranded.length, totalCarried: capped.length
    });
  } catch (err) {
    log.warn('Failed to carry Medusa mail forward to this project\'s next session', { projectPath, sessionId: String(sessionId), error: err.message });
  }
}

/**
 * Drain and return the mail carried forward for a project (#1806), if any.
 * Consumed exactly once: the entry is removed so a second listener start for
 * the same project (a toggle, a resync) does not re-seed mail the first
 * successor already received.
 * @param {string} projectPath - Registry key.
 * @returns {object[]} Carried message bodies, oldest first; empty when none.
 */
function claimCarriedMail(projectPath) {
  const carried = _carriedMail.get(projectPath);
  if (!carried) return [];
  _carriedMail.delete(projectPath);
  return carried;
}

/**
 * Who hears about each message a listener receives (#1839). Set once by the
 * server; this module stays free of the exchange store.
 * @type {(function({sessionKey: string, workspaceId: string, message: object}): void)|null}
 */
let _arrivalObserver = null;

/**
 * Register the one observer told about every received message.
 * @param {(function({sessionKey: string, workspaceId: string, message: object}): void)|null} fn - Observer, or null to clear
 * @returns {void}
 */
function setArrivalObserver(fn) {
  _arrivalObserver = typeof fn === 'function' ? fn : null;
}

/**
 * Ask the wake monitor to look at a session now (#2086). Required lazily: the
 * wake monitor reads this module, and a top-level require would be a cycle.
 * Never throws; a look that cannot be requested is one the timer still makes.
 * @param {string} sessionKey - The session's key in `listeners`
 * @param {string} reason - What happened
 * @returns {void}
 */
function _requestWakeScan(sessionKey, reason) {
  try {
    require('./medusa-wake').requestScan(sessionKey, reason);
  } catch (err) {
    log.warn('Could not ask the wake monitor for a scan', { sessionId: sessionKey, reason, error: err.message });
  }
}

/**
 * Tell the arrival observer about a received message. Recording an arrival is
 * bookkeeping about the mail, never a condition of receiving it, so a failing
 * observer is logged and the inbox carries on.
 * @param {string} sessionKey - Listener key
 * @param {string} workspaceId - The receiving workspace
 * @param {object} message - The received message
 * @returns {void}
 */
function _notifyArrival(sessionKey, workspaceId, message) {
  if (!_arrivalObserver) return;
  try {
    _arrivalObserver({ sessionKey, workspaceId, message });
  } catch (err) { // prawduct:allow prawduct/broad-except -- the observer writes SQLite and can throw anything; a lost arrival record must not cost the recipient its mail
    log.warn('Could not record a Medusa arrival', { sessionKey, workspaceId, error: err.message });
  }
}

/**
 * @type {Map<string, Set<string>>} Loop ids each session KNOWS about, keyed by
 * session id (MED-2K9P v2 T4). The Bridge has no `GET /loops` list endpoint, so
 * TC tracks discovery itself: `openLoop` records ids on the initiator side;
 * `getLoops` re-learns ids from inbound inbox messages tagged `loopId` (the
 * target side's only discovery path). In-memory by design — a TC restart
 * forgets loops until their next inbound round message re-surfaces them (the
 * Bridge's own loop store is in-memory too, so ids don't outlive it either).
 */
const knownLoops = new Map();

/**
 * Record a loop id as known to a session (creates the per-session set lazily).
 * @param {string} sessionKey - String session id.
 * @param {string} loopId - Bridge loop id.
 * @returns {void}
 */
function _trackLoop(sessionKey, loopId) {
  let set = knownLoops.get(sessionKey);
  if (!set) {
    set = new Set();
    knownLoops.set(sessionKey, set);
  }
  set.add(loopId);
}

/**
 * @type {string} Default Bridge HTTP base URL (loopback per the trust model).
 * The Bridge serves its HTTP API on `:3009` and its WS on `:3010` (HTTP port + 1);
 * send + roster use the HTTP side. Operator-overridable via `MEDUSA_BRIDGE_HTTP_URL`.
 */
const DEFAULT_BRIDGE_HTTP_URL = 'http://localhost:3009';

/** @type {string} Resolved Bridge HTTP base URL (env at load; test-overridable). */
let bridgeHttpUrl = process.env.MEDUSA_BRIDGE_HTTP_URL || DEFAULT_BRIDGE_HTTP_URL;

/**
 * Override the Bridge HTTP base URL (test seam; points send/roster at a fake
 * Bridge). Pass no argument to reset to the env/default.
 * @param {string} [url] - Base URL, or omit to reset.
 * @returns {void}
 */
function _setBridgeHttpUrl(url) {
  bridgeHttpUrl = url || process.env.MEDUSA_BRIDGE_HTTP_URL || DEFAULT_BRIDGE_HTTP_URL;
  _reportedBadUrl.clear();
  _resetBridgeProbe();
}

/**
 * @type {string|null} Explicit Bridge WS override (env at load; test-overridable).
 * `null` means "derive from the HTTP base", which is the common case: Medusa
 * serves its WS on the HTTP port + 1, so an install that moved one moved both.
 */
let bridgeWsUrl = process.env.MEDUSA_BRIDGE_WS_URL || null;

/** @type {string|null} Last logged preflight verdict, so a steady state is not re-logged. */
let _lastBridgeVerdict = null;

/** @type {number} How long a Bridge verdict stays fresh, in ms. */
const BRIDGE_PROBE_TTL_MS = 5000;

/** @type {{at: number, verdict: (object|null), inflight: (Promise<object>|null)}} */
let _bridgeProbe = { at: 0, verdict: null, inflight: null };

/**
 * Bumped by anything that makes `_bridgeProbe` authoritative on its own
 * strength (a reset, a directly-set verdict, or where the Bridge even IS
 * changing) — never by a probe's own completion. An in-flight probe started
 * under an OLDER generation checks this before writing its result, so one
 * invalidated mid-flight (the URL moved, a test reset the cache) can never
 * clobber whatever is authoritative by the time it finishes (#1009 R-Gate
 * Round 2) — the generation it started under is the only answer it is
 * allowed to still believe in.
 * @type {number}
 */
let _bridgeProbeGeneration = 0;

/**
 * Drop the cached Bridge verdict (test seam, and any caller that has just changed
 * where the Bridge is).
 * @returns {void}
 */
function _resetBridgeProbe() {
  _bridgeProbe = { at: 0, verdict: null, inflight: null };
  _bridgeProbeGeneration += 1;
}

/**
 * Set the cached Bridge verdict directly (test seam for `getStatus()`'s
 * cached read, #1009). `checkBridgeHealth()`'s own cache-write path is
 * unreachable from a seamed or forced call by design (a seamed verdict is a
 * test fixture, never a fact to cache), so this is the only way to populate
 * `_cachedBridgeInfo()` without a real, unseamable network probe.
 * @param {object} verdict - A verdict shape as `checkBridgeHealth()` returns.
 * @returns {void}
 */
function _setBridgeProbeVerdict(verdict) {
  _bridgeProbe = { at: Date.now(), verdict, inflight: null };
  _bridgeProbeGeneration += 1;
}

/**
 * Override the Bridge WS URL (test seam, mirroring `_setBridgeHttpUrl`). Pass no
 * argument to reset to the env value, and `null` explicitly to force derivation.
 * @param {string|null} [url] - WS URL, or omit to reset.
 * @returns {void}
 */
function _setBridgeWsUrl(url) {
  bridgeWsUrl = url === undefined ? (process.env.MEDUSA_BRIDGE_WS_URL || null) : url;
  _reportedBadUrl.clear();
  _resetBridgeProbe();
}

/**
 * @type {Set<string>} Misconfigurations already reported, keyed by reason and
 * value so each distinct one is named once rather than once per session start
 * (`resolveBridgeWsUrl` runs on every `startSession`, of which there are five
 * production call sites).
 *
 * **What bounds this set is where the values come from, not the set itself.**
 * Both gates are read from the environment once at module load, so a production
 * process inserts at most a couple of strings for its whole life. The moment a
 * Bridge URL becomes runtime-settable — per project, or through a health-probe
 * path — this grows without limit AND permanently suppresses the notice for a
 * value the operator has since corrected. Whoever makes it settable owns that.
 */
const _reportedBadUrl = new Set();

/**
 * Whether a hostname is loopback.
 *
 * The WS path is unauthenticated at the workspace layer, so the Bridge URL is
 * bound to loopback by the trust model rather than by preference: anything that
 * can reach the port can register as any workspace. The override exists to move
 * a PORT, never a host.
 *
 * Reads a parsed `URL.hostname` rather than the raw string, which is what makes
 * the userinfo and suffix bypasses fail closed — `ws://localhost@evil.com:3010`
 * has hostname `evil.com`, and `ws://localhost.evil.com` has hostname
 * `localhost.evil.com`. A check written against the raw string would accept both.
 *
 * @param {string} hostname - A URL hostname (IPv6 arrives bracketed).
 * @returns {boolean} True when the host is loopback.
 */
function _isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Fall back to the loopback default, naming the reason once per distinct
 * (reason, value) pair.
 *
 * Every fallback in this resolver goes through here rather than logging at its
 * own site. One owner is the point: the sites are siblings that appear one at a
 * time, and a per-site remedy leaves the newest one unbounded — a typo'd
 * variable would `log.error` on every session start for the life of the process
 * while a remote host in the same variable reported once.
 *
 * @param {string} reason - Machine-readable classification of the refusal.
 * @param {string} value - The rejected value, echoed so the operator can find it.
 * @param {string} source - Which gate carried it.
 * @param {string} hint - What the operator can do about it.
 * @returns {string} The loopback default.
 */
function _fallbackToDefault(reason, value, source, hint) {
  const key = `${reason}:${value}`;
  if (!_reportedBadUrl.has(key)) {
    _reportedBadUrl.add(key);
    log.error('Refusing a Medusa Bridge WS URL; using the loopback default', {
      reason, value, source, using: DEFAULT_BRIDGE_URL, hint
    });
  }
  return DEFAULT_BRIDGE_URL;
}

/**
 * Validate a candidate WS URL by CONSTRUCTION rather than by listing
 * known-bad shapes: the candidate must be something `new WebSocket` will
 * accept, because the listener catches a factory throw and schedules a
 * reconnect — so a URL that parses here but not there is the one bad-input
 * path that never reaches a default and loops on an unreachable address at
 * the 30s backoff cap forever. Node 22's WebSocket rejects a non-`ws`/`wss`
 * scheme, a fragment, and a port outside the range (the last via `new URL`
 * itself), so all three are gated here.
 *
 * Pure — no logging, no fallback — so both `_acceptWsUrl` (falls back) and
 * `_resolveBridgeWsUrlOutcome` (fails closed for an explicit override, #2354)
 * can share one definition of "refused" without the two ever drifting apart.
 *
 * @param {string} candidate - The URL to validate.
 * @returns {{ok: true, url: string}|{ok: false, reason: string, hint: string}}
 */
function _validateWsUrl(candidate) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (err) {
    return { ok: false, reason: 'unparseable',
      hint: `Not a URL the WebSocket client accepts (${err.message}). Use ws://host:port.` };
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { ok: false, reason: 'bad-scheme',
      hint: 'The Bridge WebSocket URL must use the ws: or wss: scheme.' };
  }
  // A BARE trailing `#` parses with an EMPTY `hash`, so the obvious `parsed.hash`
  // test is falsy for it while the client still refuses the URL — undici gates on
  // `hash.length || href.endsWith('#')`. Mirror both halves or this is the one
  // surviving member of the class the acceptance gate exists to close.
  if (parsed.hash || parsed.href.endsWith('#')) {
    return { ok: false, reason: 'has-fragment',
      hint: 'The WebSocket client rejects a URL carrying a #fragment, including a bare trailing #; drop it.' };
  }
  if (!_isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: 'non-loopback',
      hint: 'The Medusa WS path is unauthenticated at the workspace layer, so the override may move the port but not the host. Point it at localhost/127.0.0.1, or tunnel the remote Bridge to loopback.' };
  }
  return { ok: true, url: candidate };
}

/**
 * Accept a candidate WS URL, or fall back naming why.
 * @param {string} candidate - The URL to accept or refuse.
 * @param {string} source - Which gate produced it, for the log line.
 * @returns {string} The candidate, or the loopback default.
 */
function _acceptWsUrl(candidate, source) {
  const v = _validateWsUrl(candidate);
  if (v.ok) return v.url;
  return _fallbackToDefault(v.reason, candidate, source, v.hint);
}

/**
 * Log an explicit `MEDUSA_BRIDGE_WS_URL` refusal that fails closed (#2354).
 * Unlike `_fallbackToDefault`, this never says a default is now in use —
 * none is; no listener starts. Named once per distinct (reason, value), in
 * the same dedup set as the fallback path (under an `explicit-refused:`
 * prefix) so a steady typo logs once, not once per `startSession` call.
 *
 * @param {string} reason - Machine-readable classification of the refusal.
 * @param {string} value - The rejected value, echoed so the operator can find it.
 * @param {string} hint - What the operator can do about it.
 * @returns {void}
 */
function _refuseExplicitWsUrl(reason, value, hint) {
  const key = `explicit-refused:${reason}:${value}`;
  if (!_reportedBadUrl.has(key)) {
    _reportedBadUrl.add(key);
    log.error('Refusing an explicit Medusa Bridge WS URL; starting no listener', {
      reason, value, source: 'MEDUSA_BRIDGE_WS_URL', hint
    });
  }
}

/**
 * Resolve the Bridge WS URL the way `startSession` needs it: distinguishing
 * an explicit, refused `MEDUSA_BRIDGE_WS_URL` from every other case (#2354).
 * Only the explicit case can fail closed — nothing was deliberately set in
 * every other case, so falling back to the documented default (via the
 * unchanged `resolveBridgeWsUrl()`) remains the right call there.
 *
 * @returns {{url: string}|{refused: {reason: string, value: string, variable: string, hint: string}}}
 */
function _resolveBridgeWsUrlOutcome() {
  if (!bridgeWsUrl) return { url: resolveBridgeWsUrl() };
  const v = _validateWsUrl(bridgeWsUrl);
  if (v.ok) return { url: v.url };
  _refuseExplicitWsUrl(v.reason, bridgeWsUrl, v.hint);
  return { refused: { reason: v.reason, value: bridgeWsUrl, variable: 'MEDUSA_BRIDGE_WS_URL', hint: v.hint } };
}

/**
 * Build a WS URL from the live HTTP base, or fall back naming why.
 * @returns {string} A candidate WS URL, or the loopback default.
 */
function _deriveWsFromHttpBase() {
  let http;
  try {
    http = new URL(bridgeHttpUrl);
  } catch (err) {
    return _fallbackToDefault('unparseable', bridgeHttpUrl, 'MEDUSA_BRIDGE_HTTP_URL',
      `The HTTP base is not a URL (${err.message}), so no WS URL can be derived from it.`);
  }
  if (!_isLoopbackHost(http.hostname)) {
    // Naming the SPLIT is the point. The loopback rule is a property of the whole
    // integration, but only this gate enforces it: send, roster and loops keep
    // talking to the remote Bridge while the listener drops to loopback, which is
    // the half-configured Switchboard #1100 was filed about wearing a new shape.
    return _fallbackToDefault('non-loopback-http-base', bridgeHttpUrl, 'MEDUSA_BRIDGE_HTTP_URL',
      'This install is now SPLIT: send/roster/loops use the remote Bridge while the listener stays on the loopback default. Tunnel the Bridge to loopback so both halves agree.');
  }
  if (!http.port) {
    // A base with no port carries no port information, so `+ 1` would be
    // arithmetic on the scheme default (80 or 443) — a port no Medusa serves.
    return _fallbackToDefault('no-port-in-http-base', bridgeHttpUrl, 'MEDUSA_BRIDGE_HTTP_URL',
      'Give the HTTP base an explicit port (the WS port is derived as that + 1), or set MEDUSA_BRIDGE_WS_URL.');
  }
  const scheme = http.protocol === 'https:' ? 'wss:' : 'ws:';
  // WHATWG `hostname` keeps the brackets on an IPv6 literal, so it is already in
  // the form a URL wants — no re-bracketing, and none of the port-slicing that
  // `host` would need (`[::1]` and `[::1]:3009` share no suffix shape).
  return `${scheme}//${http.hostname}:${Number(http.port) + 1}`;
}

/**
 * Resolve the Bridge WebSocket URL the same way the HTTP side resolves its base,
 * so an operator who can move one half of the integration can move the other
 * (#1100). Precedence, most specific first:
 *
 *   1. `MEDUSA_BRIDGE_WS_URL` — for an install whose WS port is not HTTP + 1.
 *   2. Derived from the live HTTP base: same host, port + 1, `http`→`ws` /
 *      `https`→`wss`. Read from `bridgeHttpUrl` rather than the environment, so
 *      the `_setBridgeHttpUrl` seam moves both gates together and they cannot drift.
 *   3. `ws://localhost:3010`.
 *
 * Every refusal returns the documented default rather than throwing, because the
 * alternative is a Switchboard that refuses to start over a typo. The cost is
 * that the default is, strictly, a plausible-looking value for a read that did
 * not succeed — accepted deliberately here, and paid for by naming every refusal
 * in the log with its reason, its value and the gate that carried it.
 *
 * @returns {string} The Bridge WS URL to hand a listener.
 */
function resolveBridgeWsUrl() {
  if (bridgeWsUrl) return _acceptWsUrl(bridgeWsUrl, 'MEDUSA_BRIDGE_WS_URL');
  const derived = _deriveWsFromHttpBase();
  return derived === DEFAULT_BRIDGE_URL ? derived : _acceptWsUrl(derived, 'MEDUSA_BRIDGE_HTTP_URL');
}

/**
 * How many listeners are running right now.
 *
 * Counted off the listener map rather than by iterating the sessions table,
 * because the Project Master has NO sessions row (ADR 0008) and is exactly the
 * listener a sessions-table walk would skip — it was also the first one the
 * install in #1130 saw fail. Every path that starts a listener, the master's
 * included, lands in this map.
 *
 * @returns {number} Count of live listeners.
 */
function activeListenerCount() {
  return listeners.size;
}

/**
 * @type {Readonly<Record<string, string>>} What a Bridge preflight found.
 *
 * The vocabulary answers the question `lastError` could not: **is there a Bridge
 * at all?** #1130 was filed because an absent external prerequisite was
 * indistinguishable from a TangleClaw listener defect — a green toggle over
 * nothing on either port. Each code names a condition an operator can act on
 * differently, which is the test for whether a distinction earns a code.
 *
 * `UNKNOWN` is the verdict when a probe DEADLINE expired: a read we stopped says
 * nothing about the Bridge, and folding it into `ABSENT` would tell an operator
 * whose host is merely slow to install software that is already there.
 */
const BRIDGE_HEALTH_CODES = Object.freeze({
  /** The WS port accepts and the Bridge's own `/health` reported `hissing`. */
  OK: 'BRIDGE_OK',
  /** Nothing answered on either transport — no Bridge on this host. */
  ABSENT: 'BRIDGE_ABSENT',
  /** The HTTP API answered but nothing is accepting on the WS port. */
  WS_ABSENT: 'BRIDGE_WS_ABSENT',
  /** The WS port accepts and the HTTP API did not answer at all. */
  HTTP_ABSENT: 'BRIDGE_HTTP_ABSENT',
  /**
   * The Bridge answered and did not report itself well — its `status` was not
   * `hissing`, or its body could not be read. Independent of the WS half: a
   * Bridge saying it is degraded is that, whether or not its socket accepts.
   */
  UNHEALTHY: 'BRIDGE_UNHEALTHY',
  /** A probe deadline expired, so nothing about the Bridge was established. */
  UNKNOWN: 'BRIDGE_UNKNOWN',
  /**
   * A local configuration problem, not a Bridge one (#2354): an explicit
   * `MEDUSA_BRIDGE_WS_URL` was refused, so `startSession()` will fail closed
   * and start no listener — neither transport was probed, because reporting
   * "healthy" against the loopback default here would contradict what the
   * toggle is actually about to do.
   */
  WS_URL_REFUSED: 'BRIDGE_WS_URL_REFUSED'
});

/** @type {string} The `status` a well Bridge reports (verified against its source, 2026-09-08). */
const BRIDGE_HEALTHY_STATUS = 'hissing';

/** @type {number} Deadline for each half of the preflight, in ms. */
const BRIDGE_PROBE_TIMEOUT_MS = 2000;

/**
 * Whether something is accepting TCP connections at a WS URL's host and port.
 *
 * A TCP connect, not a WebSocket handshake, and the difference is deliberate: the
 * question this half answers is "is anything there", and a full handshake would
 * register a workspace as a side effect of asking. Bounded by its own deadline
 * because a filtered port answers nothing at all — the same shape the listener's
 * handshake deadline exists for (#1131).
 *
 * @param {string} wsUrl - The resolved Bridge WS URL.
 * @param {(opts: object) => object} [connectImpl] - `net.connect` override (test seam).
 * @returns {Promise<{accepting: boolean, detail: (string|null), timedOut: boolean}>}
 */
function _probeWsPort(wsUrl, connectImpl) {
  const connect = connectImpl || net.connect;
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch (err) {
    return Promise.resolve({ accepting: false, detail: `unparseable WS URL: ${err.message}`, timedOut: false });
  }
  const port = Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80);
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

  return new Promise((resolve) => {
    let settled = false;
    /**
     * Resolve once and tear the socket down.
     * @param {boolean} accepting - Whether the port accepted.
     * @param {string|null} detail - Why not, when it did not.
     * @returns {void}
     */
    const done = (accepting, detail, timedOut = false) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // prawduct:allow prawduct/broad-except -- tearing down a probe socket; any
        // failure here is already past the answer we came for.
      }
      resolve({ accepting, detail, timedOut });
    };
    let socket;
    try {
      socket = connect({ host, port, timeout: BRIDGE_PROBE_TIMEOUT_MS });
    } catch (err) {
      resolve({ accepting: false, detail: err.message, timedOut: false });
      return;
    }
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, `no answer within ${BRIDGE_PROBE_TIMEOUT_MS}ms`, true));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

/**
 * Probe the Medusa Bridge on BOTH transports and classify what is there (#1130).
 *
 * Both halves are checked because they fail independently and mean different
 * things: TangleClaw's send/roster use the HTTP API while every listener uses the
 * WebSocket, so a Bridge that serves one and not the other leaves half a working
 * Switchboard — and reporting "healthy" off the HTTP side alone is the same class
 * of unverified assertion #1130 was filed about.
 *
 * Never throws. Every failure becomes a classified verdict, because a preflight
 * that can fail is a preflight that turns into an outage of the thing it guards.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam; bypasses the cache).
 * @param {(opts: object) => object} [options.connectImpl] - `net.connect` override (test seam; bypasses the cache).
 * @param {boolean} [options.force] - Skip the cached verdict and probe now.
 * @returns {Promise<{healthy: boolean, code: string, detail: string, hint: (string|null), httpUrl: string, wsUrl: string, version: (string|null), updaterStatus: (string|null)}>}
 */
async function checkBridgeHealth(options = {}) {
  const { fetchImpl, connectImpl, force } = options;
  // Two sequential 2s probes, and this runs on every /api/system/health poll AND
  // every toggle. Uncached that is the cost pattern the health module's own header
  // warns about ("ten tabs still cost one"), so: serve a recent verdict, and
  // collapse concurrent callers onto ONE in-flight probe rather than stampeding a
  // Bridge that is already struggling. Tests pass their own seams, which bypass
  // the cache — a cached verdict from another test's fixture would be a lie.
  const seamed = !!(fetchImpl || connectImpl);
  if (!seamed && !force) {
    if (_bridgeProbe.inflight) return _bridgeProbe.inflight;
    if (_bridgeProbe.verdict && Date.now() - _bridgeProbe.at < BRIDGE_PROBE_TTL_MS) {
      return _bridgeProbe.verdict;
    }
    const startGen = _bridgeProbeGeneration;
    const run = _checkBridgeHealthUncached({});
    _bridgeProbe.inflight = run;
    try {
      const verdict = await run;
      // Only commit if nothing made the cache authoritative on its OWN
      // strength while this was in flight (a reset, a directly-set verdict,
      // a Bridge-URL change) — a probe started under an older generation
      // writing anyway is exactly the stale-clobber #1009 R-Gate Round 2
      // found: a background refresh for one listener resolving late enough
      // to overwrite a deliberately-reset or freshly-set cache with data
      // that was already superseded by the time it arrived.
      if (_bridgeProbeGeneration === startGen) {
        _bridgeProbe = { at: Date.now(), verdict, inflight: null };
      }
      return verdict;
    } finally {
      if (_bridgeProbe.inflight === run) _bridgeProbe.inflight = null;
    }
  }
  return _checkBridgeHealthUncached({ fetchImpl, connectImpl });
}

/**
 * The probe itself, with no caching (see `checkBridgeHealth`).
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @param {(opts: object) => object} [options.connectImpl] - `net.connect` override (test seam).
 * @returns {Promise<object>} The classified verdict.
 */
async function _checkBridgeHealthUncached({ fetchImpl, connectImpl }) {
  const doFetch = fetchImpl || fetch;
  const httpUrl = bridgeHttpUrl;
  const wsOutcome = _resolveBridgeWsUrlOutcome();
  if (wsOutcome.refused) {
    // #2354: this is the preflight startSession() will hit too — report the
    // same refusal rather than probing the loopback default and calling it
    // healthy, which would tell the toggle the opposite of what is about to
    // happen when it actually starts (or fails to start) a listener.
    return {
      healthy: false,
      code: BRIDGE_HEALTH_CODES.WS_URL_REFUSED,
      detail: `${wsOutcome.refused.variable} (${wsOutcome.refused.value}) was refused (${wsOutcome.refused.reason}) — no session listener will start`,
      hint: wsOutcome.refused.hint,
      httpUrl, wsUrl: wsOutcome.refused.value, version: null, updaterStatus: null
    };
  }
  const wsUrl = wsOutcome.url;

  let httpAnswered = false;
  let httpOk = false;
  let httpTimedOut = false;
  let httpDetail = null;
  let version = null;
  // #1009: the Bridge's own `/health` reports this alongside `version` — read
  // the same way, from the same body, never a second request.
  let updaterStatus = null;
  try {
    const res = await doFetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(BRIDGE_PROBE_TIMEOUT_MS)
    });
    httpAnswered = !!res;
    if (res && res.ok) {
      // The STATUS CODE IS NOT THE VERDICT. Medusa answers HTTP 200 on both of its
      // paths — `{status:'hissing'}` when well and, from its own catch,
      // `{status:'degraded', error}` when not (verified in its source, 2026-09-08:
      // `res.statusCode = 200` appears in both branches). Reading `res.ok` would
      // report a degraded Bridge as healthy and make BRIDGE_UNHEALTHY unreachable
      // against a real Bridge — the producer's own field is the only signal there is.
      try {
        const body = await res.json();
        version = (body && body.version) || null;
        updaterStatus = (body && body.updaterStatus) || null;
        const reported = body && body.status;
        if (reported === BRIDGE_HEALTHY_STATUS) httpOk = true;
        else httpDetail = `the Bridge reports status "${reported || 'none'}"`
          + `${body && body.error ? `: ${body.error}` : ''}`;
      } catch (err) {
        // A 200 whose body cannot be read is a Bridge answering in a shape this
        // version does not know. Not healthy — we have no verdict from it — and
        // not absent either, which is what `httpAnswered` above already carries.
        httpDetail = `unreadable /health body: ${err.message}`;
      }
    } else {
      httpDetail = `HTTP ${res ? res.status : 'no response'}`;
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      httpTimedOut = true;
      httpDetail = `no answer within ${BRIDGE_PROBE_TIMEOUT_MS}ms`;
    } else {
      httpDetail = (err.cause && err.cause.code) || err.message;
    }
  }

  const ws = await _probeWsPort(wsUrl, connectImpl);

  const install = 'Install or start the Medusa Bridge, or point TangleClaw at it with MEDUSA_BRIDGE_HTTP_URL (see docs/configuration-reference.md).';

  /**
   * Log the verdict and return it.
   *
   * The classification has to reach the LOG, not only the API: #1130 was
   * misdiagnosed from a log line, and a code nobody can grep for leaves the next
   * diagnosis exactly where that one started. Logged at the transition only —
   * this runs per toggle and per health poll, and a repeated verdict is not news.
   *
   * @param {object} verdict - The verdict to report.
   * @returns {object} The same verdict.
   */
  const report = (verdict) => {
    if (verdict.code !== _lastBridgeVerdict) {
      _lastBridgeVerdict = verdict.code;
      if (verdict.healthy) log.info('Medusa Bridge preflight', { code: verdict.code, httpUrl, wsUrl, version });
      else log.warn('Medusa Bridge preflight', { code: verdict.code, httpUrl, wsUrl, detail: verdict.detail });
    }
    return verdict;
  };
  if (httpOk && ws.accepting) {
    return report({
      healthy: true, code: BRIDGE_HEALTH_CODES.OK,
      detail: `Bridge answering on ${httpUrl} and ${wsUrl}`, hint: null, httpUrl, wsUrl, version, updaterStatus
    });
  }
  if (httpTimedOut || ws.timedOut) {
    // A deadline we imposed is not evidence about the Bridge. Reporting ABSENT
    // here would tell an operator whose host is merely slow to install software
    // that is already installed — the check could not distinguish two states, so
    // it says so instead of picking one.
    return report({
      healthy: false, code: BRIDGE_HEALTH_CODES.UNKNOWN,
      detail: `The Bridge could not be checked within ${BRIDGE_PROBE_TIMEOUT_MS}ms`
        + ` (HTTP ${httpUrl}: ${httpDetail || 'answered'}; WS ${wsUrl}: ${ws.detail || 'answered'})`,
      hint: 'This is a check that did not finish, not a Bridge that is missing. Retry, or reach the endpoints by hand.',
      httpUrl, wsUrl, version: null, updaterStatus: null
    });
  }
  if (!httpAnswered && !ws.accepting) {
    return report({
      healthy: false, code: BRIDGE_HEALTH_CODES.ABSENT,
      detail: `Nothing answered at ${httpUrl} (${httpDetail}) or ${wsUrl} (${ws.detail})`,
      hint: install, httpUrl, wsUrl, version: null, updaterStatus: null
    });
  }
  // ANSWERED but not well is not the same as absent, and the difference decides
  // what an operator does: absent means install or start something, unhealthy
  // means read the Bridge's own logs for a service that is up and unwell.
  if (httpAnswered && !httpOk) {
    return report({
      healthy: false, code: BRIDGE_HEALTH_CODES.UNHEALTHY,
      detail: `The Bridge answered at ${httpUrl} but did not report itself healthy (${httpDetail}); `
        + `${ws.accepting ? 'its WebSocket port is accepting' : `and nothing is accepting at ${wsUrl} (${ws.detail})`}`,
      hint: 'The Bridge process is running but reporting a problem. Check its own logs rather than reinstalling it.',
      httpUrl, wsUrl, version: null, updaterStatus: null
    });
  }
  if (httpOk && !ws.accepting) {
    return report({
      healthy: false, code: BRIDGE_HEALTH_CODES.WS_ABSENT,
      detail: `The Bridge HTTP API answered at ${httpUrl} but nothing is accepting at ${wsUrl} (${ws.detail})`,
      hint: 'Send and roster will work; no session listener can register. The Bridge may be mid-boot, or its WebSocket port may differ from HTTP + 1 — set MEDUSA_BRIDGE_WS_URL if so.',
      httpUrl, wsUrl, version, updaterStatus
    });
  }
  return report({
    healthy: false, code: BRIDGE_HEALTH_CODES.HTTP_ABSENT,
    detail: `Something is accepting at ${wsUrl} but the Bridge HTTP API did not answer at ${httpUrl} (${httpDetail})`,
    hint: 'Listeners may register while send and roster fail. Check that the HTTP port is the Bridge and not another service.',
    httpUrl, wsUrl, version: null, updaterStatus: null
  });
}

/**
 * An error carrying an HTTP status for the route layer to surface honestly.
 * @param {string} message - Human-readable reason.
 * @param {number} httpStatus - HTTP status the route should return.
 * @param {string} code - Machine-readable error code.
 * @returns {Error} The error, with `httpStatus` and `code` attached.
 */
function sendError(message, httpStatus, code) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

/** @type {{state: string, workspaceId: null, unread: number, lastError: null}} Status for a session with no listener. */
const OFF_STATUS = { state: 'off', listeningSince: null, workspaceId: null, unread: 0, lastError: null, lastErrorCode: null };

/**
 * Start a listener for a session (idempotent per session). Ensures a stable
 * workspace id via the registry, creates + starts a `MedusaListener`, and
 * returns its status. If a listener already exists for the session, its current
 * status is returned without double-starting.
 * @param {object} options
 * @param {string} options.projectPath - Absolute path to the project directory.
 * @param {string|number} options.sessionId - The TC session id.
 * @param {string} options.name - Human-readable name for id minting + logging.
 * @param {string} [options.workspaceId] - Pre-minted workspace id from the launch
 *   path (MED-2K9P v2 T1) so the listener registers under the exact identity
 *   already injected into the session's prime prompt. Omitted by the toggle /
 *   reconnect paths, which keep the registry's existing id.
 * @param {string} [options.bridgeUrl] - Explicit Bridge WS URL. Omitted by every
 *   production caller, which is what makes `resolveBridgeWsUrl()` the reachable
 *   path (#1100); passing one still wins, preserving the test seam.
 * @param {(url: string) => object} [options.wsFactory] - Socket factory passed to the
 *   listener (test seam; defaults to the built-in `WebSocket` inside the listener).
 * @returns {{state: string, listeningSince: (string|null), workspaceId: (string|null), unread: number, lastError: (string|null), lastErrorCode: (string|null)}}
 */
function startSession({ projectPath, sessionId, name, workspaceId: preferredId, bridgeUrl, wsFactory }) {
  const key = String(sessionId);
  const existing = listeners.get(key);
  if (existing) return existing.getStatus();

  let resolvedUrl = bridgeUrl;
  if (!resolvedUrl) {
    const outcome = _resolveBridgeWsUrlOutcome();
    if (outcome.refused) {
      // #2354: an explicit MEDUSA_BRIDGE_WS_URL that was refused fails
      // closed — no listener, no workspace-id side effect, no silent
      // redirect to the default Bridge. Persisted in `_refusedSessions` so
      // getStatus() (and the toggle route's own re-fetch right after this
      // call) sees the same refusal rather than a generic `off`.
      const status = {
        ...OFF_STATUS,
        lastError: `${outcome.refused.variable}="${outcome.refused.value}" refused `
          + `(${outcome.refused.reason}): ${outcome.refused.hint}`,
        lastErrorCode: LISTENER_ERROR_CODES.WS_URL_REFUSED
      };
      _refusedSessions.set(key, status);
      return status;
    }
    resolvedUrl = outcome.url;
  }

  const workspaceId = registry.ensureWorkspaceId(projectPath, sessionId, name, preferredId);
  const listener = new MedusaListener({ bridgeUrl: resolvedUrl, workspaceId, name, wsFactory });
  _refusedSessions.delete(key);
  // Learn loop ids as mail ARRIVES rather than by scanning retained mail later:
  // a handled message leaves the inbox, so a lazy scan would miss any loop whose
  // only mention was handled before the banner first looked (#784 clear-on-handled).
  listener.on('message', (msg) => {
    if (msg && typeof msg.loopId === 'string' && msg.loopId) _trackLoop(key, msg.loopId);
    _notifyArrival(key, workspaceId, msg);
  });
  // #2086: a listener that has come back to `listening` may be holding mail
  // the wake monitor could not act on while it was away (it holds the nudge
  // for any other state), so the monitor is asked to look now.
  listener.on('state', (next) => {
    if (next === 'listening') _requestWakeScan(key, 'listener-listening');
  });
  listeners.set(key, listener);
  // #1806: a predecessor session for this same project may have ended with
  // mail still unhandled in its (now-gone) listener's inbox. Seeded before
  // `start()` opens the socket, so nothing genuinely new can arrive first.
  if (projectPath) {
    const carried = claimCarriedMail(projectPath);
    if (carried.length > 0) listener.seedCarriedMail(carried);
  }
  listener.start();
  log.info('Started Medusa listener', { sessionId: key, workspaceId });
  return listener.getStatus();
}

/**
 * Mint (but do not persist) a workspace id for a launch (MED-2K9P v2 T1).
 * The launch path calls this BEFORE the session record exists so the prime
 * prompt and the listener share one identity: the minted id goes into the
 * prime, then rides `startSession({ workspaceId })` into the registry. If the
 * listener never starts (Bridge down, launch aborted) the id was never
 * persisted, so nothing leaks.
 * @param {string} name - Human-readable name used to build the id slug.
 * @returns {string} A freshly minted workspace id.
 */
function mintWorkspaceId(name) {
  return registry.mintId(name);
}

/**
 * Stop and remove a session's listener. The registry entry is intentionally
 * retained (forget-on-end is a later chunk's concern). No-op if none exists.
 * @param {string|number} sessionId - The TC session id.
 * @returns {void}
 */
function stopSession(sessionId) {
  const key = String(sessionId);
  // An explicit stop always returns to a clean `off`, whether or not a
  // refusal (#2354) was ever recorded — an operator who just turned the
  // switchboard off should not keep seeing a stale WS_URL_REFUSED.
  _refusedSessions.delete(key);
  const listener = listeners.get(key);
  if (!listener) return;
  listener.stop();
  listeners.delete(key);
  log.info('Stopped Medusa listener', { sessionId: key });
}

/**
 * Tear down a session's Medusa presence on session end (MED-2K9P Chunk 04):
 * stop the listener (closing the WS — the Bridge auto-drops it from `wsClients`)
 * and forget the persisted workspace id so the session is no longer addressable
 * and a future session mints a fresh id. Best-effort and never throws — session
 * teardown must not be blocked by a Medusa cleanup failure. No server-side
 * deregister call: a WS-only id is never in the Bridge's `workspaceRegistry`, so
 * `DELETE /workspaces/:id` is a no-op for it (see api-notes-medusa.md Chunk 04).
 *
 * #1806: whatever is still unhandled in the listener's inbox at this moment is
 * captured for the project's next listener BEFORE `stopSession` tears the
 * listener down — the workspace id this mail arrived under is about to be
 * retired for good, so it is now or never.
 * @param {object} options
 * @param {string} options.projectPath - Absolute path to the project directory.
 * @param {string|number} options.sessionId - The TC session id.
 * @returns {void}
 */
function forgetSession({ projectPath, sessionId }) {
  try {
    if (projectPath) _captureCarriedMail(projectPath, sessionId);
    stopSession(sessionId);
    // Loop tracking dies with the session identity (a banner toggle-off keeps
    // it so a toggle cycle can still observe its loops; session END does not).
    knownLoops.delete(String(sessionId));
    if (projectPath) registry.forgetWorkspace(projectPath, sessionId);
  } catch (err) {
    log.warn('Failed to forget Medusa session on teardown', { sessionId: String(sessionId), error: err.message });
  }
}

/**
 * The install's cached Bridge version / update-status reading for the hover
 * tooltip (#1009) — whatever `checkBridgeHealth()` last measured, however
 * stale; `getStatus()` never blocks a status read on a fresh probe. `null`
 * for both until the first probe anywhere (a toggle, a health poll, or
 * `getStatus()`'s own background refresh below) resolves.
 * @returns {{bridgeVersion: (string|null), bridgeUpdaterStatus: (string|null)}}
 */
function _cachedBridgeInfo() {
  const verdict = _bridgeProbe.verdict;
  return {
    bridgeVersion: verdict ? verdict.version : null,
    bridgeUpdaterStatus: verdict ? verdict.updaterStatus : null
  };
}

/**
 * Keep the Bridge cache warm for an active listener (#1009 R-Gate Round 2).
 *
 * A pure cache READ in `getStatus()` alone is not enough: `GET
 * /api/system/health` only runs `checkBridgeHealth()` when something polls
 * it (the dashboard), and a toggle-ON probes once but the verdict never
 * refreshes again after that — a session that reconnects on its own, with
 * no dashboard tab open and no fresh toggle, would carry a stale or absent
 * reading forever. This is the one place the normal status-poll flow (every
 * route that calls `getStatus()` on an active listener) can reach a refresh
 * without `getStatus()` itself blocking on one.
 *
 * Fire-and-forget by design, and safe to call on every `getStatus()` for an
 * active listener: `checkBridgeHealth()` already single-flights concurrent
 * callers and serves a cached verdict within `BRIDGE_PROBE_TTL_MS`, so this
 * costs a real probe only once per that window, never per call.
 * @returns {void}
 */
function _refreshBridgeInfo() {
  checkBridgeHealth().catch(() => {}); // prawduct:allow prawduct/broad-except -- fire-and-forget cache warm; checkBridgeHealth() never actually rejects, but a status read must not depend on that holding
}

/**
 * Return the observable status for a session's listener: the listener's own
 * status, the recorded refusal when `startSession()` failed closed on an
 * explicit Bridge WS URL (#2354) and no listener exists for it, or a plain
 * `off` status when neither applies (or there is no session id) — always
 * carrying the cached Bridge version/update-status reading (#1009), and
 * keeping it warm while a listener is active.
 * @param {string|number|null} sessionId - The TC session id.
 * @returns {{state: string, listeningSince: (string|null), workspaceId: (string|null), unread: number, lastError: (string|null), lastErrorCode: (string|null), bridgeVersion: (string|null), bridgeUpdaterStatus: (string|null)}}
 */
function getStatus(sessionId) {
  // getStatus() ITSELF never blocks on a fresh probe or throws on one — only
  // the active-listener branch below triggers a background refresh, and
  // every other branch (off, refused, no session id) stays a pure read, same
  // as before: those are exactly the paths tests exercise with no network
  // to reach and no listener for a probe to be meaningful about.
  const bridgeInfo = _cachedBridgeInfo();
  if (sessionId == null) return { ...OFF_STATUS, ...bridgeInfo };
  const key = String(sessionId);
  const listener = listeners.get(key);
  if (listener) {
    _refreshBridgeInfo();
    return { ...listener.getStatus(), ...bridgeInfo };
  }
  const refused = _refusedSessions.get(key);
  return refused ? { ...refused, ...bridgeInfo } : { ...OFF_STATUS, ...bridgeInfo };
}

/**
 * Return a copy of a session's in-memory inbox (empty when no listener).
 * @param {string|number} sessionId - The TC session id.
 * @returns {Array<object>} The received messages, oldest first.
 */
function getMessages(sessionId) {
  const listener = listeners.get(String(sessionId));
  return listener ? listener.inbox.slice() : [];
}

/**
 * Clear a session's unread badge. Keeps every message and every Hub copy.
 * No-op if the session has no listener.
 * @param {string|number} sessionId - The TC session id.
 * @returns {void}
 */
function markRead(sessionId) {
  const listener = listeners.get(String(sessionId));
  if (listener) listener.markRead();
}

/**
 * Report messages handled for a session: drop them from the inbox and ACK them
 * to the Hub. One of the two paths that discards mail — the listener's own
 * system-broadcast drain is the other. No-op if there is no listener.
 * @param {string|number} sessionId - The TC session id.
 * @param {string[]} ids - Envelope ids the consumer has handled.
 * @returns {void}
 */
function markHandled(sessionId, ids) {
  const listener = listeners.get(String(sessionId));
  if (listener) listener.markHandled(ids);
}

/**
 * Send a direct message from a session to another workspace (MED-2K9P Chunk 03).
 *
 * The session must have a running listener — its stable workspace id becomes the
 * truthful `from` (the Bridge trusts `from` verbatim, so TC never lets the browser
 * set it). The result is honest: `received` (delivered live), `queued` (recipient
 * offline, stored in the Hub inbox), never a blanket "sent". Failures throw a
 * status-carrying error rather than reporting a false success.
 *
 * The Bridge does NOT validate the message body (a missing body still queues —
 * verify-api 2026-07-10), so a non-empty text is enforced here.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The sending TC session id.
 * @param {string} options.to - Target workspace id (from the roster).
 * @param {string} options.message - Message text (must be non-empty).
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @param {function({from: string}): void} [options.beforeHub] - Called once the
 *   send has passed every local check and just before the Hub is contacted, so a
 *   caller can record its intent durably first (#1839). If it throws, nothing is sent.
 * @returns {Promise<{status: string, id: (string|undefined), to: string}>}
 * @throws {Error} With `httpStatus`/`code` when validation fails, the session
 *   isn't listening, or the Bridge rejects/ is unreachable. Once the Hub has been
 *   contacted the error also carries `hubOutcome`: `unknown` when the message may
 *   or may not exist (the request failed in flight), `refused` when the Hub
 *   answered and declined it.
 */
async function sendMessage({ sessionId, to, message, fetchImpl, beforeHub }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Message text is required', 400, 'EMPTY_MESSAGE');
  if (!to || typeof to !== 'string') throw sendError('A target workspace is required', 400, 'NO_TARGET');

  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before sending', 409, 'NOT_LISTENING');
  }
  const from = listener.workspaceId;
  if (to === from) throw sendError('Cannot send a message to this same session', 400, 'SELF_TARGET');
  if (typeof beforeHub === 'function') beforeHub({ from });

  const doFetch = fetchImpl || fetch;

  /**
   * One POST to the Bridge's direct-send endpoint.
   * @param {string} target - Workspace id to address.
   * @returns {Promise<{res: object, data: object}>}
   */
  async function attempt(target) {
    let res;
    let data;
    try {
      res = await doFetch(`${bridgeHttpUrl}/messages/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: target, from, message: text })
      });
      data = await res.json();
    } catch (err) {
      log.warn('Medusa send failed to reach the Bridge', { sessionId: String(sessionId), to: target, error: err.message });
      // The request may have reached the Hub before the failure (a reset, a
      // timeout, an unreadable answer), so whether the message exists is unknown.
      const unknown = sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
      unknown.hubOutcome = 'unknown';
      throw unknown;
    }
    return { res, data };
  }

  /**
   * Did the Bridge reject this because the handle names nobody?
   * @param {object} res - Fetch response.
   * @param {object} data - Parsed body.
   * @returns {boolean}
   */
  function isUnknownTarget(res, data) {
    if (res.status === 404) return true;
    const msg = (data && (data.error || data.message)) || '';
    return /not found/i.test(msg);
  }

  let { res, data } = await attempt(to);
  let deliveredTo = to;
  let retargetedFrom = null;

  // A workspace id is a HANDLE, not an identity: Medusa mints a fresh random
  // suffix whenever a workspace registers without requesting one, so every peer
  // restart invalidates the id its peers are holding (#1023). The failure is
  // latent — the handle works right up until the peer restarts, which is exactly
  // when a long-running exchange is most likely to be mid-flight — and the
  // Bridge's own wording ("Peer/Workspace X not found") reads as "that peer is
  // gone" rather than "your handle is stale", so a sender that backs off on it
  // drops the message and looks like an unrelated delivery gap.
  //
  // So a not-found is treated as a stale handle first and a missing peer second:
  // re-resolve against the live roster and retry exactly ONCE. Once, because a
  // second failure is evidence about the peer rather than about the handle, and
  // a retry loop over a genuinely absent workspace is just a slower error.
  if (!res.ok || !data || data.success !== true) {
    if (isUnknownTarget(res, data)) {
      let roster = [];
      try {
        roster = await getRoster({ sessionId, fetchImpl });
      } catch (err) {
        log.warn('Could not fetch the roster to re-resolve a stale target', { to, error: err.message });
      }
      const resolved = _reresolveWorkspaceId(to, roster);
      if (resolved.ok && resolved.id !== to) {
        log.info('Re-resolved a stale workspace id and retrying the send', { sessionId: String(sessionId), staleId: to, workspaceId: resolved.id });
        retargetedFrom = to;
        deliveredTo = resolved.id;
        ({ res, data } = await attempt(resolved.id));
      } else if (!resolved.ok) {
        // Say which of the two things went wrong, because they need different
        // actions from the operator and the Bridge's message distinguishes
        // neither: a rotated handle is recoverable, an absent peer is not.
        const detail = resolved.candidates.length
          ? `${resolved.reason} (${resolved.candidates.join(', ')}) — name the one you mean`
          : resolved.reason;
        const refused = sendError(
          `${to} is not a live workspace, and re-resolving it failed: ${detail}`,
          502, 'SEND_REJECTED'
        );
        refused.hubOutcome = 'refused';
        throw refused;
      }
    }
  }

  // The Bridge returns `success:true` for received/queued; anything else (e.g. a
  // 404 "Peer/Workspace not found") is a real failure — never a silent success.
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa send rejected by the Bridge', { sessionId: String(sessionId), to: deliveredTo, status: res.status, reason });
    const refused = sendError(reason, 502, 'SEND_REJECTED');
    refused.hubOutcome = 'refused';
    throw refused;
  }

  log.info('Medusa message sent', { sessionId: String(sessionId), from, to: deliveredTo, status: data.status });
  // `retargetedFrom` travels with the result so a caller can say the handle was
  // refreshed rather than silently succeeding against a different id than it asked for.
  return { status: data.status, id: data.id, to: deliveredTo, retargetedFrom };
}

/** @type {number} Deadline for a system send, in ms (#2270). */
const BRIDGE_SEND_TIMEOUT_MS = 30000;

/**
 * Send a system-level Medusa message to a workspace. Bypasses the session sender check.
 *
 * Bounded (#2270): an unreachable Bridge was already handled (the `catch`
 * below turns it into `BRIDGE_UNREACHABLE`), but a Bridge that accepts the
 * connection and never answers was not — nothing here settles. A caller
 * that awaits this (the workload-nudge monitor added in #2262 deliberately
 * does not, for exactly this reason) could stall its own pass on one hung
 * request. `AbortSignal.timeout` turns that case into the same
 * `BRIDGE_UNREACHABLE` the catch block already produces for an unreachable
 * Bridge — one failure shape, not two.
 * @param {object} params
 * @param {string} params.to - Target workspace ID.
 * @param {string} params.message - The message body.
 * @param {typeof fetch} [params.fetchImpl] - Fetch override.
 * @param {number} [params.timeoutMs] - Deadline for the send; defaults to `BRIDGE_SEND_TIMEOUT_MS`.
 */
async function sendSystemMessage({ to, message, fetchImpl, timeoutMs = BRIDGE_SEND_TIMEOUT_MS }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Message text is required', 400, 'EMPTY_MESSAGE');
  if (!to || typeof to !== 'string') throw sendError('A target workspace is required', 400, 'NO_TARGET');

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/messages/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from: 'system', message: text }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    data = await res.json();
  } catch (err) {
    log.warn('Medusa system send failed to reach the Bridge', { to, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }

  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa system send rejected by Bridge', { to, reason });
    throw sendError(`Bridge rejected message: ${reason}`, res.status || 500, 'BRIDGE_REJECTED');
  }
  return { status: data.status, id: data.id, to };
}

/**
 * Fetch the live roster of registered workspaces from the Bridge, excluding the
 * calling session's own workspace so it can't message itself (MED-2K9P Chunk 03).
 * A thin proxy — TC is the single integration point; the browser never calls the
 * Bridge directly.
 *
 * Also stamps `isMaster: true, role: 'orchestrator'` on the one entry (if any)
 * whose `id` matches the Master/Orchestrator listener's workspace id (#2127,
 * Ruling A505-R3.10). Every project session listener is keyed in `listeners` by
 * its numeric `String(sessionId)`; only the Master/Orchestrator listener is
 * keyed by the literal `'master'` (`lib/master.js#MASTER_MEDUSA_KEY`) — a
 * server-verified identity no roster entry's own `name`/`id` can spoof, unlike
 * the display name or id prefix TangleClaw happens to mint it under today.
 * @param {object} options
 * @param {string|number} [options.sessionId] - The calling session (for self-exclusion).
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<Array<object>>} Roster entries (other workspaces), the
 *   Master/Orchestrator's entry carrying `isMaster`/`role` when present.
 * @throws {Error} With `httpStatus`/`code` when the Bridge is unreachable or errors.
 */
async function getRoster({ sessionId, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/workspaces`);
    data = await res.json();
  } catch (err) {
    log.warn('Medusa roster fetch failed to reach the Bridge', { error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data) {
    throw sendError(`Bridge returned HTTP ${res.status}`, 502, 'ROSTER_FAILED');
  }
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  const listener = sessionId == null ? null : listeners.get(String(sessionId));
  const selfId = listener ? listener.workspaceId : null;
  const masterListener = listeners.get('master');
  const masterId = masterListener ? masterListener.workspaceId : null;
  return workspaces
    .filter((w) => w && w.id && w.id !== selfId)
    .map((w) => (masterId && w.id === masterId ? { ...w, isMaster: true, role: 'orchestrator' } : w));
}

/**
 * Per-sender broadcast cooldown state (#1224), keyed by the resolved sender
 * identity (a workspace id, or `'system'`). In-memory, per-process — a
 * restart clears it, the same as every other in-memory state this module
 * keeps (`listeners`, `_refusedSessions`).
 * @type {Map<string, {lastAt: number, lastMessage: string, sentTo: string[]}>}
 */
const _broadcastCooldowns = new Map();

/** @type {number} Minimum time between two system-wide broadcasts from the SAME sender (#1224). */
const BROADCAST_COOLDOWN_MS = 30000;

/**
 * Send one message to every other active, registered switchboard workspace
 * (#1224) — an explicit, system-wide broadcast, distinct from a point-to-
 * point (`sendMessage`/`sendSystemMessage`) or group-scoped send. Resolves
 * targets from the live roster (`getRoster`), the same source `sendMessage`'s
 * own stale-handle re-resolution already trusts.
 *
 * Marked in the message text itself with a `[BROADCAST scope=all]` prefix:
 * the Bridge's own `/messages/direct` endpoint accepts no envelope metadata
 * beyond `to`/`from`/`message` (confirmed against the real Hub — #1009 PR
 * #2808 already found it mints its own id and ignores anything else sent),
 * so there is no separate field to carry a `scope` value in.
 *
 * Restricted to an operator or coordinator caller (#1224's own acceptance),
 * enforced HERE rather than left to whatever eventually calls this: this
 * file is Car 69-B's one authorized place to hold that policy, and the
 * caller supplies `callerKind` already resolved — the same division of
 * labor `sendMessage`'s own sender check already draws between "who is
 * this" (the route's job) and "may they do this" (this function's).
 *
 * Rate-limited per sender (#1224): a sender who just broadcast must wait
 * `BROADCAST_COOLDOWN_MS` before broadcasting again. A retry with the
 * IDENTICAL message inside that window is coalesced — answered as already
 * sent, with no second fan-out, the honest-idempotent-retry posture this
 * codebase uses elsewhere (e.g. `createSessionWithTccBootstrap`'s own
 * "a second call against an already-bootstrapped name is a no-op"); a
 * DIFFERENT message inside the same window is refused outright, since
 * honoring it would mean either silently dropping the first message's
 * fan-out record or sending two broadcasts the rate limit exists to bound.
 *
 * @param {object} params
 * @param {string} [params.senderId] - The broadcasting sender's own identity
 *   key for rate-limiting (a workspace id, or `'system'` when there is none).
 * @param {string} params.callerKind - One of `'operator'`, `'coordinator'`,
 *   or anything else (refused, 403).
 * @param {string} params.message - The message body. Never pre-fixed by the
 *   caller — this function owns the `[BROADCAST scope=all]` marker, so it
 *   can never be duplicated or omitted by a caller forgetting it.
 * @param {typeof fetch} [params.fetchImpl] - Fetch override (test seam).
 * @param {number} [params.nowMs] - Injected clock (test seam).
 * @returns {Promise<{ok: true, scope: 'all', sentTo: string[],
 *   failedTo: Array<{workspaceId: string, reason: string}>, coalesced: boolean}>}
 * @throws {Error} With `httpStatus`/`code` — `BROADCAST_FORBIDDEN` (403, not
 *   operator/coordinator), `EMPTY_MESSAGE` (400), `BROADCAST_RATE_LIMITED`
 *   (429, a different message inside the cooldown), or `BROADCAST_ROSTER_FAILED`
 *   (502, the roster itself could not be read).
 */
async function broadcastAll({ senderId, callerKind, message, fetchImpl, nowMs } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Message text is required', 400, 'EMPTY_MESSAGE');
  if (callerKind !== 'operator' && callerKind !== 'coordinator') {
    throw sendError('Only an operator or a coordinator may broadcast system-wide', 403, 'BROADCAST_FORBIDDEN');
  }
  const sender = typeof senderId === 'string' && senderId ? senderId : 'system';
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  const cooldown = _broadcastCooldowns.get(sender);
  if (cooldown && now - cooldown.lastAt < BROADCAST_COOLDOWN_MS) {
    if (cooldown.lastMessage === text) {
      // I-Gate Round 2 C2: the reservation below is written SYNCHRONOUSLY,
      // before the roster read or any send completes, with `sentTo`/
      // `failedTo` still `[]` placeholders. An identical retry arriving
      // while that first call is still in flight must never hand those
      // placeholders back as if they were the real, settled result — it
      // awaits the SAME call's own outcome instead. `inFlightPromise` is
      // absent once the reservation has been overwritten with the final,
      // settled entry (below), so this branch only ever runs for a call
      // that is genuinely still in progress.
      if (cooldown.inFlightPromise) {
        const settled = await cooldown.inFlightPromise;
        return { ok: true, scope: 'all', sentTo: settled.sentTo, failedTo: settled.failedTo, coalesced: true };
      }
      return { ok: true, scope: 'all', sentTo: cooldown.sentTo, failedTo: cooldown.failedTo || [], coalesced: true };
    }
    const waitMs = BROADCAST_COOLDOWN_MS - (now - cooldown.lastAt);
    throw sendError(
      `This sender already broadcast ${Math.round((now - cooldown.lastAt) / 1000)}s ago; `
      + `wait ${Math.ceil(waitMs / 1000)}s before broadcasting a different message.`,
      429, 'BROADCAST_RATE_LIMITED'
    );
  }

  // I-Gate Round 1 C2a: reserve this sender's slot SYNCHRONOUSLY — before the
  // first `await` below — so two concurrent calls at the same `nowMs` cannot
  // both read "no cooldown yet" and both fan out. The second call's own read
  // of `_broadcastCooldowns` now sees this reservation and is coalesced or
  // rate-limited against it, exactly as it would be against a completed one.
  // Reaching this line only happens when no cooldown existed above, or the
  // existing one had already expired — never one still valid — so this can
  // never clobber a cooldown a later coalesced/rate-limited read still needs.
  //
  // I-Gate Round 2 C2: `inFlightPromise` is what an identical retry (above)
  // awaits instead of trusting this reservation's still-empty placeholders.
  // It resolves with the real `{sentTo, failedTo}` on success, or rejects
  // with the exact same error this call itself throws on roster failure —
  // never a different, invented one for the waiter.
  let settleInFlight;
  let failInFlight;
  const inFlightPromise = new Promise((resolve, reject) => { settleInFlight = resolve; failInFlight = reject; });
  // This call never awaits its own `inFlightPromise` — it throws/returns
  // directly — so when no retry ever shows up to await it, a rejection
  // would otherwise be a real unhandledRejection. A second, independent
  // `.catch()` here is purely a handled no-op sink; it does not consume the
  // rejection for a retry's own, separate `await`, which still sees it.
  inFlightPromise.catch(() => {});
  // I-Gate Round 3 C2: kept so the cleanup/completion writes below can check
  // THIS call still owns the map entry before touching it. A call that was
  // still awaiting the roster/sends past its own 30s cooldown window can
  // finish (or fail) after a NEWER reservation for the same sender has
  // already replaced this one — an unconditional delete/overwrite there
  // would erase that newer reservation, or resurrect a rate limit the newer
  // call already legitimately cleared.
  const reservation = { lastAt: now, lastMessage: text, sentTo: [], failedTo: [], inFlightPromise };
  _broadcastCooldowns.set(sender, reservation);

  let roster;
  try {
    roster = await getRoster({ fetchImpl });
  } catch (err) {
    // A roster failure never actually broadcasts anything — release the
    // reservation so a failed attempt does not cool down the sender's next
    // real one (the pre-fix behavior: this branch never touched the map) —
    // but only THIS call's own reservation; a newer one must survive.
    if (_broadcastCooldowns.get(sender) === reservation) _broadcastCooldowns.delete(sender);
    log.warn('Medusa broadcast could not read the roster', { sender, error: err.message });
    const refusal = sendError(`Could not resolve the roster to broadcast to: ${err.message}`, 502, 'BROADCAST_ROSTER_FAILED');
    failInFlight(refusal);
    throw refusal;
  }

  const envelopeText = `[BROADCAST scope=all] ${text}`;
  const doFetch = fetchImpl || fetch;
  const sentTo = [];
  const failedTo = [];
  for (const workspace of roster) {
    if (!workspace || !workspace.id || workspace.id === sender) continue;
    try {
      const res = await doFetch(`${bridgeHttpUrl}/messages/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: workspace.id, from: sender, message: envelopeText })
      });
      const data = await res.json();
      if (!res.ok || !data || data.success !== true) {
        failedTo.push({ workspaceId: workspace.id, reason: (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}` });
        continue;
      }
      sentTo.push(workspace.id);
    } catch (err) {
      failedTo.push({ workspaceId: workspace.id, reason: err.message });
    }
  }

  // I-Gate Round 1 C2b: carry `failedTo` alongside `sentTo` into the
  // reservation this call already made — a later coalesced retry reads this
  // same record, and without it the retry would report `failedTo: []`,
  // concealing a partial delivery failure the first call already knew about.
  //
  // This overwrite also drops `inFlightPromise` (the new entry carries only
  // `lastAt`/`lastMessage`/`sentTo`/`failedTo`) — the settled signal below
  // is what wakes an in-flight retry; once awake, a retry's `cooldown` read
  // in the SETTLED entry has no such field at all, which is exactly what
  // marks this sender as no-longer-in-flight for the next one along.
  //
  // I-Gate Round 3 C2: only if THIS call's reservation is still the live
  // entry — a late success past the 30s window must not resurrect a stale
  // `lastAt` over a newer reservation already in place.
  if (_broadcastCooldowns.get(sender) === reservation) {
    _broadcastCooldowns.set(sender, { lastAt: now, lastMessage: text, sentTo, failedTo });
  }
  settleInFlight({ sentTo, failedTo });
  log.info('Medusa system-wide broadcast sent', { sender, sentCount: sentTo.length, failedCount: failedTo.length });
  return { ok: true, scope: 'all', sentTo, failedTo, coalesced: false };
}

/**
 * @type {RegExp} TangleClaw's workspace-id shape: `<name-slug>-<8 hex>`
 * (`lib/medusa-registry.js#_mintId`). The suffix is what rotates when a peer
 * restarts; the slug is the durable half.
 */
const WORKSPACE_ID_RE = /^(.*)-[0-9a-f]{8}$/;

/**
 * The durable half of a workspace id — everything before the random suffix.
 * @param {string} workspaceId - A workspace id.
 * @returns {string|null} The slug, or null if the id is not TC-minted.
 */
function _idSlug(workspaceId) {
  const m = WORKSPACE_ID_RE.exec(String(workspaceId || ''));
  return m ? m[1] : null;
}

/**
 * Find the workspace that a stale id used to name, by matching TangleClaw's own
 * id convention against the live roster.
 *
 * Why not just target the human-readable name, which the Bridge resolves
 * server-side? Because it does not work for the ids TangleClaw mints. Medusa
 * matches a WS-only client by `id.split('-')[0]`, so `tilt-v2-8ef50ea0` answers
 * to `"tilt"` and never to `"TiLT v2"` — every multi-word project silently 404s,
 * including the one in this bug's own reproduction, while single-word projects
 * work and make the approach look correct. Worse, `"TiLT v2"` and `"TiLT Claw"`
 * both truncate to `"tilt"`, so the two collide whenever both are live.
 * TangleClaw owns its id format, so it can match on the whole slug reliably.
 *
 * Ambiguity fails loudly and lists the candidates rather than picking one: two
 * live sessions of the same project genuinely share a slug, and guessing which
 * one an operator meant is how a message reaches the wrong reader.
 *
 * @param {string} staleId - The workspace id that was rejected.
 * @param {Array<object>} roster - Live roster entries.
 * @returns {{ok: true, id: string}|{ok: false, reason: string, candidates: string[]}}
 */
function _reresolveWorkspaceId(staleId, roster) {
  const slug = _idSlug(staleId);
  if (!slug) {
    return { ok: false, reason: 'not a TangleClaw-minted id, so there is no slug to match on', candidates: [] };
  }
  const matches = (roster || [])
    .map((w) => (w && w.id ? String(w.id) : null))
    .filter((id) => id && _idSlug(id) === slug);

  if (matches.length === 1) return { ok: true, id: matches[0] };
  if (matches.length === 0) {
    return { ok: false, reason: `no live workspace is named ${slug}`, candidates: [] };
  }
  return { ok: false, reason: `${matches.length} live workspaces share the name ${slug}`, candidates: matches };
}

/** @type {string[]} Loop judge modes the Bridge accepts (MED-2K9P v2 T3). */
const LOOP_MODES = ['supervised', 'autonomous'];
/** @type {number} Default max-rounds guard when the modal leaves it blank. */
const DEFAULT_MAX_ROUNDS = 10;
/**
 * Default wall-clock guard (seconds) per judge mode, applied when the caller
 * omits `maxWallTimeSeconds` (MED-6V3R).
 *
 * The Bridge halts a loop once `now - startedAt` exceeds this budget: total
 * elapsed since first delivery, never paused and never reset per round
 * (Medusa `checkWallTimeGuardForLoop`; Medusa#54 moved the origin off loop
 * creation, but the clock still runs while a loop merely waits). That makes
 * one shared default wrong, because the two modes bound different things:
 *
 * - `autonomous` — agents drive every round unattended, so the clock measures
 *   AGENT WORK and the guard is genuine runaway protection. 10 minutes.
 * - `supervised` — a round advances only when the initiator sends, so the loop
 *   cannot run away by construction (`maxRounds` already bounds it) and the
 *   clock measures HUMAN DELIBERATION. The guard is an abandonment bound, not
 *   a runaway bound. 8 hours outlives real thinking time while still reaping
 *   loops left open overnight; the old 10-minute budget halted live supervised
 *   fixtures three times purely because the operator stepped away (VRF-561).
 *
 * @type {{supervised: number, autonomous: number}}
 */
const DEFAULT_WALL_SECONDS = {
  supervised: 28800,
  autonomous: 600
};

/**
 * Validate a guard value: a positive integer, or undefined to take the default.
 * @param {*} value - Raw guard value from the request body.
 * @param {number} fallback - Default when the value is undefined/null.
 * @returns {number|null} The validated integer, or null when invalid.
 */
function _guardInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Open a Medusa loop from a session to a target workspace (MED-2K9P v2 T3) —
 * the setup modal's launch path. One Bridge call over the public contract:
 * `POST /loops` creates the loop object (initiator = this session's workspace
 * id, the chosen mode, and the server-enforced guards) and the Bridge itself
 * delivers a `loopInvite` message to the target — durably queued in the
 * target's inbox and pushed live over WS when it is online (Medusa#47, fixed
 * upstream in Medusa PR #48; TC's prior out-of-band task notice was dropped as
 * redundant — TC#552).
 *
 * The Bridge's open response does not report the invite's live-vs-queued
 * delivery (unlike `/messages/direct`), so TC makes no claim beyond what the
 * contract guarantees: the invite is durably queued and reaches the target on
 * connect. No fake "delivered live" status is invented.
 *
 * Guards are the two the Bridge actually enforces (maxRounds,
 * maxWallTimeSeconds). A token-budget guard is deliberately NOT offered until
 * Medusa enforces one — an unenforced knob would be a dishonest control. An
 * omitted `maxWallTimeSeconds` defaults per judge mode, because the modes bound
 * different things — see `DEFAULT_WALL_SECONDS` (MED-6V3R).
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.target - Target workspace id (from the roster).
 * @param {string} options.task - The task the target is asked to do.
 * @param {string} options.doneCriteria - What the initiator will judge against.
 * @param {string} [options.mode='supervised'] - Judge mode (`supervised` | `autonomous`).
 * @param {{maxRounds?: number, maxWallTimeSeconds?: number}} [options.guards] - Runaway guards.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loop: object}>}
 * @throws {Error} With `httpStatus`/`code` on validation failure, a missing
 *   listener, Bridge rejection, or unreachable Bridge.
 */
async function openLoop({ sessionId, target, task, doneCriteria, mode, guards, fetchImpl }) {
  const taskText = typeof task === 'string' ? task.trim() : '';
  if (!taskText) throw sendError('A task is required', 400, 'EMPTY_TASK');
  const doneText = typeof doneCriteria === 'string' ? doneCriteria.trim() : '';
  if (!doneText) throw sendError('Done criteria are required — the initiator judges against them', 400, 'EMPTY_DONE_CRITERIA');
  if (!target || typeof target !== 'string') throw sendError('A target workspace is required', 400, 'NO_TARGET');

  const chosenMode = mode === undefined || mode === null || mode === '' ? 'supervised' : mode;
  if (!LOOP_MODES.includes(chosenMode)) {
    throw sendError(`Mode must be one of: ${LOOP_MODES.join(', ')}`, 400, 'BAD_MODE');
  }

  const g = guards || {};
  const maxRounds = _guardInt(g.maxRounds, DEFAULT_MAX_ROUNDS);
  const maxWallTimeSeconds = _guardInt(g.maxWallTimeSeconds, DEFAULT_WALL_SECONDS[chosenMode]);
  if (maxRounds === null || maxWallTimeSeconds === null) {
    throw sendError('Guards must be positive integers (maxRounds, maxWallTimeSeconds)', 400, 'BAD_GUARDS');
  }

  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before opening a loop', 409, 'NOT_LISTENING');
  }
  const initiator = listener.workspaceId;
  if (target === initiator) throw sendError('Cannot open a loop with this same session', 400, 'SELF_TARGET');

  const doFetch = fetchImpl || fetch;
  /**
   * One POST opening a loop against a target.
   * @param {string} to - Target workspace id.
   * @returns {Promise<{res: object, loop: object}>}
   */
  async function attemptOpen(to) {
    let res;
    let loop;
    try {
      res = await doFetch(`${bridgeHttpUrl}/loops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initiator,
          target: to,
          task: taskText,
          doneCriteria: doneText,
          mode: chosenMode,
          guards: { maxRounds, maxWallTimeSeconds }
        })
      });
      loop = await res.json();
    } catch (err) {
      log.warn('Medusa loop open failed to reach the Bridge', { sessionId: String(sessionId), target: to, error: err.message });
      throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
    }
    return { res, loop };
  }

  let { res, loop } = await attemptOpen(target);
  let openedWith = target;

  // A loop's target is a workspace id and expires exactly like a direct send's
  // (#1023) — and a loop is the longer-lived of the two, so it is MORE likely to
  // be opened against a handle its peer has already rotated away from. Retrying
  // is safe here specifically because the open FAILED: no loop was created, so
  // the second attempt cannot duplicate one.
  if ((!res.ok || !loop || !loop.id)
      && (res.status === 404 || /not found/i.test((loop && (loop.error || loop.message)) || ''))) {
    let roster = [];
    try {
      roster = await getRoster({ sessionId, fetchImpl });
    } catch (err) {
      log.warn('Could not fetch the roster to re-resolve a stale loop target', { target, error: err.message });
    }
    const resolved = _reresolveWorkspaceId(target, roster);
    if (resolved.ok && resolved.id !== target) {
      log.info('Re-resolved a stale loop target and retrying the open', { sessionId: String(sessionId), staleId: target, workspaceId: resolved.id });
      openedWith = resolved.id;
      ({ res, loop } = await attemptOpen(resolved.id));
    } else if (!resolved.ok) {
      const detail = resolved.candidates.length
        ? `${resolved.reason} (${resolved.candidates.join(', ')}) — name the one you mean`
        : resolved.reason;
      throw sendError(
        `${target} is not a live workspace, and re-resolving it failed: ${detail}`,
        502, 'LOOP_REJECTED'
      );
    }
  }

  if (!res.ok || !loop || !loop.id) {
    const reason = (loop && (loop.error || loop.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa loop open rejected by the Bridge', { sessionId: String(sessionId), target: openedWith, status: res.status, reason });
    throw sendError(reason, 502, 'LOOP_REJECTED');
  }

  // The Bridge delivers the loopInvite to the target itself (Medusa#47 → PR
  // #48) — no out-of-band task notice needed (TC#552). Track the id so the
  // banner loop view can observe this loop (no Bridge list endpoint exists).
  _trackLoop(String(sessionId), loop.id);

  log.info('Medusa loop opened', {
    sessionId: String(sessionId), loopId: loop.id, initiator, target: openedWith, mode: chosenMode
  });
  return { loop };
}

/** @type {string[]} Loop states in which the Bridge still accepts messages/close. */
const ACTIVE_LOOP_STATES = ['initiated', 'responded', 'continue'];

/**
 * List the loops a session knows about, with live state from the Bridge
 * (MED-2K9P v2 T4 — the banner loop view's data source). Discovery is TC-side
 * because the Bridge exposes no `GET /loops` list: ids recorded by `openLoop`
 * plus ids learned from inbound messages tagged `loopId` (loopInvite, round
 * messages, close notifications — the target side's only path). Those are
 * recorded on arrival by the listener's `'message'` subscription, so a message
 * handled and dropped from the inbox still leaves its loop tracked; the sweep
 * below only re-covers mail still waiting.
 *
 * Each known id is fetched via `GET /loops/:id`, which also triggers the
 * Bridge's wall-clock guard check — so a timed-out loop is reported `halted`
 * the moment the banner looks at it, not on its next message. A 404 (the
 * Bridge restarted and lost its in-memory loop store) untracks the id —
 * self-healing, never a phantom row.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The observing TC session id.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<Array<object>>} Loop objects, each with a TC-derived
 *   `role` (`'initiator'` | `'target'`) for this session. Empty when the
 *   session has no listener (no identity → no vantage point).
 * @throws {Error} With `httpStatus`/`code` when the Bridge is unreachable.
 */
async function getLoops({ sessionId, fetchImpl }) {
  const key = String(sessionId);
  const listener = listeners.get(key);
  if (!listener || listener.state === 'off') return [];
  const self = listener.workspaceId;

  const ids = new Set(knownLoops.get(key) || []);
  for (const msg of listener.inbox) {
    if (msg && typeof msg.loopId === 'string' && msg.loopId) {
      ids.add(msg.loopId);
      _trackLoop(key, msg.loopId);
    }
  }
  if (ids.size === 0) return [];

  const doFetch = fetchImpl || fetch;
  const loops = [];
  for (const id of ids) {
    let res;
    let loop;
    try {
      res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(id)}`);
      loop = await res.json();
    } catch (err) {
      log.warn('Medusa loop fetch failed to reach the Bridge', { sessionId: key, loopId: id, error: err.message });
      throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
    }
    if (res.status === 404) {
      // The Bridge lost this loop (its store is in-memory) — stop tracking it.
      const set = knownLoops.get(key);
      if (set) set.delete(id);
      continue;
    }
    if (!res.ok || !loop || !loop.id) continue; // transient Bridge error — skip this poll, keep tracking.
    loops.push({ ...loop, role: loop.initiator === self ? 'initiator' : 'target' });
  }
  // Stable order: active loops first, then most recent first within each group.
  loops.sort((a, b) => {
    const aActive = ACTIVE_LOOP_STATES.includes(a.state) ? 0 : 1;
    const bActive = ACTIVE_LOOP_STATES.includes(b.state) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return loops;
}

/**
 * Force-done a loop from its initiating session (MED-2K9P v2 T4) — the human
 * kill-switch of the loop protocol's control invariant ("a human can always
 * intervene; only the initiator ends a loop, never the receiver").
 *
 * Mapping decision (pinned against Bridge source 2026-07-14): the Bridge has
 * no external transition to `halted` — that state is reserved for its own
 * runaway guards. Force-done therefore rides the contract's close endpoint
 * with a structured `closeSignal.reason: 'force-done'`, and the loop lands in
 * `complete` with that reason recorded. TC renders the outcome from
 * `closeSignal.reason` — honest, no fake "halted" label. The Bridge enforces
 * the invariant itself: a non-initiator close is 403, and a guard-halted loop
 * rejects close with 400 ("a halted loop cannot be closed") — both surfaced
 * verbatim, never swallowed.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to force-done.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>} The Bridge's
 *   honest close result.
 * @throws {Error} With `httpStatus`/`code` on a missing listener, Bridge
 *   rejection (not initiator / already halted / unknown loop), or unreachable
 *   Bridge.
 */
async function forceDoneLoop({ sessionId, loopId, fetchImpl }) {
  return _closeLoop({
    sessionId,
    loopId,
    closeSignal: { reason: 'force-done', evidence: 'Operator force-done from the TangleClaw banner' },
    logLabel: 'force-done',
    errCode: 'FORCE_DONE_REJECTED',
    fetchImpl
  });
}

/**
 * Satisfied closeout — the CLOSEOUT half of the loop control spine (TC#561,
 * design §1: "initiator judges → CLOSEOUT (satisfied, ends) or FEEDBACK
 * (loops)"). The Bridge has a single `/close` endpoint, so this rides it with a
 * distinct `closeSignal.reason: 'satisfied'` — semantically separate from the
 * `force-done` kill-switch even though both land the loop in `complete`. TC
 * renders the outcome from the reason ("ended — marked done" vs "ended by
 * force-done"), so the operator's satisfied judgment is never mislabeled as a
 * kill. Same initiator-only (403) / already-closed (400) / unknown (404)
 * passthrough as force-done.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to close as satisfied.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>}
 * @throws {Error} With `httpStatus`/`code` on a missing listener, Bridge
 *   rejection, or unreachable Bridge.
 */
async function closeoutLoop({ sessionId, loopId, fetchImpl }) {
  return _closeLoop({
    sessionId,
    loopId,
    closeSignal: { reason: 'satisfied', evidence: 'Operator marked the loop satisfied from the TangleClaw banner' },
    logLabel: 'closeout',
    errCode: 'CLOSEOUT_REJECTED',
    fetchImpl
  });
}

/**
 * Shared Bridge close for the two initiator closeouts (force-done kill-switch
 * and satisfied closeout — TC#561). Both are `POST /loops/:id/close` with the
 * caller's `closeSignal`; only the reason + labels differ. The Bridge enforces
 * the control invariant: a non-initiator close is 403, an already
 * complete/halted loop is 400, an unknown loop 404 — all surfaced verbatim with
 * their real status, never swallowed.
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to close.
 * @param {{reason: string, evidence: string}} options.closeSignal - The close signal.
 * @param {string} options.logLabel - Short label for log lines (`force-done`|`closeout`).
 * @param {string} options.errCode - Error code on Bridge rejection.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, closeSignal: object}>} The Bridge's honest close result.
 * @throws {Error} With `httpStatus`/`code` on missing listener / Bridge reject / unreachable.
 */
async function _closeLoop({ sessionId, loopId, closeSignal, logLabel, errCode, fetchImpl }) {
  if (!loopId || typeof loopId !== 'string') throw sendError('A loop id is required', 400, 'NO_LOOP_ID');
  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before ending a loop', 409, 'NOT_LISTENING');
  }

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(loopId)}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: listener.workspaceId, closeSignal })
    });
    data = await res.json();
  } catch (err) {
    log.warn(`Medusa ${logLabel} failed to reach the Bridge`, { sessionId: String(sessionId), loopId, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn(`Medusa ${logLabel} rejected by the Bridge`, { sessionId: String(sessionId), loopId, status: res.status, reason });
    // 400 = "already complete/halted" family; 403 = initiator-only invariant.
    throw sendError(reason, res.status === 400 || res.status === 403 || res.status === 404 ? res.status : 502, errCode);
  }

  log.info(`Medusa loop ${logLabel}`, { sessionId: String(sessionId), loopId, loopState: data.loopState });
  return { loopState: data.loopState, closeSignal: data.closeSignal };
}

/**
 * Send an initiator feedback round to continue a supervised loop (TC#561 — the
 * FEEDBACK half of the design §1 control spine). Posts to the Bridge's
 * `POST /loops/:id/message {from, message}`; the round lands in the target's
 * inbox tagged `loopId` and the loop advances `responded → continue` (round++).
 *
 * The Bridge accepts a round from the initiator ONLY once the target has
 * responded — posting while `initiated` yields `400 "Initiated loop expects
 * target response first"`. TC's UI therefore offers this only in `responded`
 * state; if a stale click still lands in the wrong state, the Bridge's 400
 * passes through verbatim (never a false "sent"). After the post, if the round
 * reaches `maxRounds` the Bridge auto-halts — reported on the next status poll.
 *
 * @param {object} options
 * @param {string|number} options.sessionId - The initiating TC session id.
 * @param {string} options.loopId - The loop to continue.
 * @param {string} options.message - The initiator's feedback text for this round.
 * @param {typeof fetch} [options.fetchImpl] - Fetch override (test seam).
 * @returns {Promise<{loopState: string, round: number, delivered: boolean, messageId: (string|undefined)}>}
 * @throws {Error} With `httpStatus`/`code` on empty feedback, a missing
 *   listener, Bridge rejection (wrong state / unknown loop), or unreachable Bridge.
 */
async function continueLoop({ sessionId, loopId, message, fetchImpl }) {
  if (!loopId || typeof loopId !== 'string') throw sendError('A loop id is required', 400, 'NO_LOOP_ID');
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw sendError('Feedback is required to continue the loop', 400, 'EMPTY_FEEDBACK');
  const listener = listeners.get(String(sessionId));
  if (!listener || listener.state === 'off') {
    throw sendError('Enable Medusa for this session before continuing a loop', 409, 'NOT_LISTENING');
  }

  const doFetch = fetchImpl || fetch;
  let res;
  let data;
  try {
    res = await doFetch(`${bridgeHttpUrl}/loops/${encodeURIComponent(loopId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: listener.workspaceId, message: text })
    });
    data = await res.json();
  } catch (err) {
    log.warn('Medusa loop continue failed to reach the Bridge', { sessionId: String(sessionId), loopId, error: err.message });
    throw sendError(`Message bridge unreachable: ${err.message}`, 502, 'BRIDGE_UNREACHABLE');
  }
  if (!res.ok || !data || data.success !== true) {
    const reason = (data && (data.error || data.message)) || `Bridge returned HTTP ${res.status}`;
    log.warn('Medusa loop continue rejected by the Bridge', { sessionId: String(sessionId), loopId, status: res.status, reason });
    // 400 = wrong state ("target response first" / already closed); 404 = unknown loop.
    throw sendError(reason, res.status === 400 || res.status === 403 || res.status === 404 ? res.status : 502, 'CONTINUE_REJECTED');
  }

  log.info('Medusa loop continued', { sessionId: String(sessionId), loopId, loopState: data.loopState, round: data.round });
  return { loopState: data.loopState, round: data.round, delivered: !!data.delivered, messageId: data.messageId };
}

/**
 * Where the consumer contract sits inside a Medusa checkout, relative to its
 * root. Exported for two live consumers, so do not unexport it: `lib/sessions.js`
 * names it when logging a rejected candidate, and tests seed fixture checkouts
 * through it. Code deriving the doc's absolute path should call
 * `contractPathIn()` rather than joining this itself.
 * @type {string}
 */
const CONTRACT_RELATIVE_PATH = path.join('docs', 'CONSUMER-CONTRACT.md');

/**
 * The contract doc's absolute path inside a checkout root. The single
 * derivation site — vetting one location and then reading another is precisely
 * the drift `hasContract`/`readContract` must not develop between them.
 * @param {string} rootPath - Checkout root.
 * @returns {string} Absolute path to the contract doc.
 */
function contractPathIn(rootPath) {
  return path.join(rootPath, CONTRACT_RELATIVE_PATH);
}

/**
 * Does this directory hold a USABLE Medusa consumer contract? This is the
 * corroboration that lets a caller treat a directory as the switchboard
 * checkout (#873) — a name match alone never can.
 *
 * "Usable" is deliberately the same test `readContract` applies when accepting
 * a candidate: readable AND non-blank. An existence-only check would admit a
 * project holding an empty or unreadable `docs/CONSUMER-CONTRACT.md`, which
 * `readContract` then rejects — reopening the #873 shape in miniature, with the
 * prime naming a project we had just declined to trust.
 * @param {string} [rootPath] - Candidate checkout root.
 * @returns {boolean} True when the directory carries a usable contract.
 */
function hasContract(rootPath) {
  if (!rootPath) return false;
  try {
    return fs.readFileSync(contractPathIn(rootPath), 'utf8').trim().length > 0;
  } catch (err) {
    // Any failure to read it — absent, unreadable, a directory — means this is
    // not a checkout we can resolve a contract from. The caller logs the
    // rejection; swallowing the errno here keeps that decision in one place.
    return false;
  }
}

/**
 * Resolve Medusa's public consumer-contract doc for prime injection
 * (MED-2K9P v2 T1). The Bridge does not serve its contract over HTTP yet
 * (probed 2026-07-12 — a filed Medusa feature; when it lands this becomes a
 * Bridge fetch), so resolution is local-disk, in priority order:
 *
 *   1. `MEDUSA_CONTRACT_PATH` env override (operator control; also the test seam).
 *   2. `<checkout>/docs/CONSUMER-CONTRACT.md` — the caller supplies the root of
 *      a checkout it has already corroborated, never a bare name match (#873).
 *
 * Honest resolution: the failure return names every path tried so the prime can
 * say WHY the contract is missing instead of silently omitting it. It can only
 * be honest about paths it is given — a caller that supplies an unvetted
 * directory makes this function report that directory as a failed Medusa
 * checkout, which is the shape of #873.
 * @param {object} [options]
 * @param {string|function(): (string|null)} [options.medusaProjectPath] - Root of a
 *   corroborated checkout, or a thunk returning one. A thunk is called ONLY if the
 *   override did not resolve, so a resolver with side effects (a store lookup, a
 *   warning about a rejected candidate) costs nothing on a launch the override
 *   already answered.
 * @returns {{text: string, source: string}|{text: null, tried: string[]}}
 */
function readContract({ medusaProjectPath } = {}) {
  const tried = [];
  const attempt = (candidate) => {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      if (text.trim()) return { text, source: candidate };
      tried.push(`${candidate} (empty)`);
    } catch (err) {
      tried.push(`${candidate} (${err.code || err.message})`);
    }
    return null;
  };

  if (process.env.MEDUSA_CONTRACT_PATH) {
    const hit = attempt(process.env.MEDUSA_CONTRACT_PATH);
    if (hit) return hit;
  }

  // Resolved only now — see the thunk note on `options.medusaProjectPath`.
  const checkoutRoot = typeof medusaProjectPath === 'function'
    ? medusaProjectPath()
    : medusaProjectPath;
  if (checkoutRoot) {
    const hit = attempt(contractPathIn(checkoutRoot));
    if (hit) return hit;
  }
  if (tried.length > 0) {
    log.warn('Medusa consumer contract not resolvable for prime injection', { tried });
  }
  return { text: null, tried };
}

module.exports = {
  startSession,
  stopSession,
  forgetSession,
  getStatus,
  getMessages,
  markRead,
  markHandled,
  _reresolveWorkspaceId,
  sendMessage,
  sendSystemMessage,
  setArrivalObserver,
  getRoster,
  broadcastAll,
  BROADCAST_COOLDOWN_MS,
  openLoop,
  getLoops,
  forceDoneLoop,
  closeoutLoop,
  continueLoop,
  mintWorkspaceId,
  readContract,
  hasContract,
  CONTRACT_RELATIVE_PATH,
  _setBridgeHttpUrl,
  _setBridgeWsUrl,
  resolveBridgeWsUrl,
  checkBridgeHealth,
  _resetBridgeProbe,
  _setBridgeProbeVerdict,
  activeListenerCount,
  BRIDGE_HEALTH_CODES
};
