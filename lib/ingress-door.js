'use strict';

// The Caddyfile on disk, described as a door: does it serve TangleClaw beyond
// this machine with nothing of Caddy's own in front?
//
// `lib/auth-gate.js#resolveGateState` asks this in caddy mode with `authEnabled`
// off, and honours the opt-out only while the answer is "no". So every branch
// below is written to be wrong in one direction only: a wrong "door" keeps a
// login on, a wrong "no door" removes one.
//
// Caddy's parser is the only parser (`caddy adapt`), read with the walker the
// fallback marker is judged by. When Caddy cannot read the file, the answer is
// "door" — never a guess from the text. The fallback marker makes the same
// choice for the same kind of question ("may TangleClaw stop asking?").
//
// Its own module because the adapt walker lives in `lib/gate-fallback.js`, which
// requires `lib/caddy.js`: putting this in `caddy.js` would make the two require
// each other.

const fs = require('node:fs');
const caddy = require('./caddy');
const drift = require('./caddy-drift');
const gateFallback = require('./gate-fallback');

const NO_DOOR = Object.freeze({ ungatedRemoteSite: false, unguardedLocalSite: false });

/**
 * Describe an adapted config as a door.
 *
 * Every top-level route (`gateFallback.eachTopLevelRoute`: site lists and error
 * lists, which Caddy runs without the site's `basic_auth` — a refused password
 * is itself an error) is walked with `gateFallback.walkRoutes`, in the order
 * Caddy runs it, with the peer guard, a gate route and TangleClaw's bypass-only
 * routes understood. A route where a request can reach a forwarding handler
 * before any gate is a door:
 *   - `unguardedLocalSite` when every host it can match is `localhost`,
 *     `127.0.0.1` or `::1` (local in name only — Caddy serves any machine that
 *     asks for that host);
 *   - `ungatedRemoteSite` otherwise, including a route some request reaches
 *     whatever host it names.
 * A config the iterator cannot read — a Caddy app beyond http/tls/pki, named
 * routes — is an ungated remote site.
 *
 * Every forwarding route counts, not only one that dials TangleClaw: which
 * upstream is TangleClaw is not known here, and over-reporting keeps a login on.
 *
 * @param {object} adapted - `caddy adapt` JSON.
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean }}
 */
function describeAdaptedDoor(adapted) {
  const door = { ungatedRemoteSite: true, unguardedLocalSite: false };
  const walk = gateFallback.eachTopLevelRoute(adapted);
  if (walk.unreadable) return door;
  let unguardedLocalSite = false;
  for (const { route, hosts, anyHost } of walk.routes) {
    if (gateFallback.walkRoutes([route]).state !== 'uncovered') continue;
    if (anyHost || !hosts.every(drift.isLoopbackHost)) return door;
    unguardedLocalSite = true;
  }
  return { ungatedRemoteSite: false, unguardedLocalSite };
}

/**
 * Describe Caddyfile text as a door.
 *
 * 1. No file (`null`) is no door: Caddy has nothing to serve.
 * 2. Text that imports another FILE is an ungated remote site without asking
 *    Caddy. The server caches the answer on the Caddyfile's own mtime and size,
 *    so an edit to the imported file would never be read; `gate-fallback`
 *    refuses the same shape for the same reason.
 * 3. `caddy adapt` over the text → {@link describeAdaptedDoor}.
 * 4. Adapt unavailable or failing → an ungated remote site, with Caddy's reason.
 *    The accounts decide, as with any door, and `reset-admin.js --store` is the
 *    recovery; the fix for the opt-out is making `caddy` reachable to TangleClaw.
 *
 * @param {string|null} content - Caddyfile text, or null when there is no file.
 * @param {object} [opts]
 * @param {(content: string) => { ok: boolean, config: object|null, reason: string|null }} [opts.adapt] -
 *   Defaults to `caddy-drift#adaptCaddyfileContent`; injectable so a test does
 *   not depend on whether the host has Caddy.
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean,
 *   source: 'none'|'import'|'adapt'|'unread', reason: string|null }}
 *   `source` says what answered; `reason` is set for `import` and `unread`
 *   (already redacted by the adapter).
 */
function describeIngressContent(content, opts = {}) {
  if (typeof content !== 'string') return { ...NO_DOOR, source: 'none', reason: null };
  const imported = gateFallback.importedFile(content);
  if (imported !== null) {
    return { ungatedRemoteSite: true, unguardedLocalSite: false, source: 'import', reason: `imports ${imported}` };
  }
  const adapt = typeof opts.adapt === 'function' ? opts.adapt : drift.adaptCaddyfileContent;
  const adapted = adapt(content);
  if (adapted && adapted.ok === true) {
    return { ...describeAdaptedDoor(adapted.config), source: 'adapt', reason: null };
  }
  return {
    ungatedRemoteSite: true,
    unguardedLocalSite: false,
    source: 'unread',
    reason: (adapted && adapted.reason) || 'caddy adapt gave no result'
  };
}

/**
 * {@link describeIngressContent} for the Caddyfile on disk — the `loadIngress`
 * thunk a caller outside the server passes to `resolveGateState`
 * (`scripts/reset-admin.js`).
 *
 * A MISSING file describes no door. Any other read failure THROWS, which the
 * gate answers with `unreadable`. The server does not call this: it stats the
 * file for its cache key first, and a file gone between that stat and a read
 * must throw rather than be cached as "no door" (`server.js#_gateIngress`).
 *
 * @param {string} [file] - Caddyfile path; defaults to `caddy.getCaddyfilePath()`.
 * @param {object} [opts] - Passed to {@link describeIngressContent}.
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean, source: string, reason: string|null }}
 * @throws {Error} If the file exists but cannot be read
 */
function readIngressDoor(file = caddy.getCaddyfilePath(), opts = {}) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return describeIngressContent(null, opts);
    throw err;
  }
  return describeIngressContent(content, opts);
}

module.exports = {
  describeAdaptedDoor,
  describeIngressContent,
  readIngressDoor
};
