'use strict';

// The Caddyfile on disk, described as a door: does it serve TangleClaw beyond
// this machine with nothing of Caddy's own in front?
//
// `lib/auth-gate.js#resolveGateState` asks this in caddy mode with `authEnabled`
// off, and honours the opt-out only while the answer is "no". So every branch
// below is written to be wrong in one direction only: a wrong "door" keeps a
// login on, a wrong "no door" removes one.
//
// Caddy's own parser answers first (`caddy adapt`), read with the same
// evaluation-order walker the fallback marker is judged by. The text reader in
// `lib/caddy.js#describeIngressDoor` answers only when `caddy adapt` cannot run
// — it is the fallback, not a second opinion.
//
// Its own module because the adapt walker lives in `lib/gate-fallback.js`, which
// requires `lib/caddy.js`: putting this in `caddy.js` would make the two require
// each other.

const fs = require('node:fs');
const caddy = require('./caddy');
const drift = require('./caddy-drift');
const gateFallback = require('./gate-fallback');

/**
 * Whether a host from a route's `host` matcher names this machine only.
 * @param {string} host - e.g. `localhost`, `box.ts.net`, `*.example.com`.
 * @returns {boolean}
 */
function _isLocalOnlyHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Describe an adapted config as a door.
 *
 * Every top-level route, in a server's site list and its error list, is walked
 * with `gateFallback.walkRoutes` — the order Caddy runs it in, with the peer
 * guard, a gate route and TangleClaw's bypass-only routes understood. A route
 * where a request can reach a forwarding handler before any gate is a door:
 *   - `unguardedLocalSite` when every host it matches is `localhost`,
 *     `127.0.0.1` or `::1` (local in name only — Caddy serves any machine that
 *     asks for that host);
 *   - `ungatedRemoteSite` otherwise, including a route with no host matcher.
 * Anything this cannot read — a Caddy app beyond http/tls/pki, named routes —
 * is an ungated remote site.
 *
 * Every forwarding route counts, not only one that dials TangleClaw: which
 * upstream is TangleClaw is not known here, and over-reporting keeps a login on.
 *
 * @param {object} adapted - `caddy adapt` JSON.
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean }}
 */
function describeAdaptedDoor(adapted) {
  const door = { ungatedRemoteSite: true, unguardedLocalSite: false };
  if (!adapted || typeof adapted !== 'object') return door;
  const apps = adapted.apps || {};
  if (Object.keys(apps).some((name) => !gateFallback.PASSIVE_APPS.has(name))) return door;
  const servers = (apps.http && apps.http.servers) || {};
  let unguardedLocalSite = false;
  for (const server of Object.values(servers)) {
    if (!server) continue;
    if (server.named_routes && Object.keys(server.named_routes).length) return door;
    const routes = [
      ...(Array.isArray(server.routes) ? server.routes : []),
      ...(server.errors && Array.isArray(server.errors.routes) ? server.errors.routes : [])
    ];
    for (const route of routes) {
      if (!route || gateFallback.walkRoutes([route]).state !== 'uncovered') continue;
      const hosts = [];
      let unmatchedSet = !Array.isArray(route.match) || route.match.length === 0;
      for (const set of Array.isArray(route.match) ? route.match : []) {
        const setHosts = set && Array.isArray(set.host) ? set.host : [];
        // A matcher set with no host list matches every host.
        if (setHosts.length === 0) unmatchedSet = true;
        hosts.push(...setHosts);
      }
      if (unmatchedSet || !hosts.every(_isLocalOnlyHost)) return door;
      unguardedLocalSite = true;
    }
  }
  return { ungatedRemoteSite: false, unguardedLocalSite };
}

/**
 * Describe Caddyfile text as a door — Caddy's parser first, the text reader
 * when that cannot run.
 *
 * 1. No file (`null`) is no door: Caddy has nothing to serve.
 * 2. Text that imports another FILE is an ungated remote site without asking
 *    Caddy. The answer is cached on the Caddyfile's own mtime and size, so an
 *    edit to the imported file would never be read; `gate-fallback` refuses the
 *    same shape for the same reason.
 * 3. `caddy adapt` over the text → {@link describeAdaptedDoor}.
 * 4. Adapt unavailable or failing → `caddy.describeIngressDoor`, which reads
 *    every shape it cannot see as a door.
 *
 * @param {string|null} content - Caddyfile text, or null when there is no file.
 * @param {object} [opts]
 * @param {(content: string) => { ok: boolean, config: object|null, reason: string|null }} [opts.adapt] -
 *   Defaults to `caddy-drift#adaptCaddyfileContent`; injectable so a test does
 *   not depend on whether the host has Caddy.
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean,
 *   source: 'none'|'import'|'adapt'|'text', reason: string|null }}
 *   `source` says which reader answered; `reason` is set when the text reader
 *   answered because adapt could not (already redacted by the adapter).
 */
function describeIngressContent(content, opts = {}) {
  if (typeof content !== 'string') {
    return { ...caddy.describeIngressDoor(null), source: 'none', reason: null };
  }
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
    ...caddy.describeIngressDoor(content),
    source: 'text',
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
