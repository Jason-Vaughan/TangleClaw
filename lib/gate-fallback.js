'use strict';

// The `fallback` gate state: TangleClaw's own login stands down behind the door
// that guarded this install before it (ADR 0016 addendum, "What the switch does").
//
// This exists for one failure: TangleClaw's login is what broke, and the operator
// needs back in. The terminal command `scripts/gate-fallback.js` puts Caddy's
// `basic_auth` back in front of TangleClaw, proves Caddy is serving it, and only
// then writes a marker file. TangleClaw reads the marker per request.
//
// READ THIS BEFORE CHANGING ANY BRANCH BELOW. The marker is a request to stop
// enforcing, so every check here must answer "keep enforcing" when it cannot
// prove the other door is there. A marker therefore never opens anything by
// itself: it is honoured only while
//   1. TangleClaw's listener is loopback, so nothing but this machine and a
//      proxy on it can reach TangleClaw directly; and
//   2. every route in the Caddyfile on disk that reaches TangleClaw passes
//      Caddy's own gate (or the peer guard) first, read through `caddy adapt` —
//      Caddy's parser, never a text walk; or there is no Caddyfile at all and
//      the install is in direct mode.
// Anything unreadable, unmeasurable or unrecognised refuses, with the reason.

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const caddy = require('./caddy');
const drift = require('./caddy-drift');
const authGate = require('./auth-gate');

/** The marker's file name under the TangleClaw home. */
const MARKER_NAME = 'gate-fallback';

/**
 * Handlers that neither reach an upstream nor hand the request to a route this
 * check cannot see. Any handler NOT listed here, met before a gate, refuses:
 * `invoke` runs a named route, and a plugin handler may proxy under another
 * name, so an unknown handler is treated as a way through, not as noise.
 */
const NEUTRAL_HANDLERS = new Set([
  'static_response', 'headers', 'vars', 'rewrite', 'encode', 'request_body',
  'map', 'error', 'file_server'
]);

/** Top-level Caddy apps that serve nothing on their own. */
const PASSIVE_APPS = new Set(['http', 'tls', 'pki']);

/**
 * Path of the fallback marker for this install.
 * @param {string} [baseDir] - TangleClaw home; defaults to the store's base path.
 * @returns {string}
 */
function markerPath(baseDir = store._getBasePath()) {
  return path.join(baseDir, MARKER_NAME);
}

/**
 * Write the marker. Created 0600: it is a local instruction to TangleClaw, and
 * nothing but the account that runs TangleClaw has reason to read it.
 * @param {string} file - From {@link markerPath}.
 * @param {{ createdAt: string }} info - What to record.
 * @returns {void}
 */
function writeMarker(file, info) {
  fs.writeFileSync(file, `${JSON.stringify({ ...info, by: 'scripts/gate-fallback.js' }, null, 2)}\n`,
    { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Remove the marker.
 * @param {string} file - From {@link markerPath}.
 * @returns {boolean} true when a marker was there and is now gone; false when
 *   there was none.
 * @throws {Error} Any failure other than the file being absent.
 */
function removeMarker(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Whether a socket address is this machine's loopback interface.
 * @param {string|null|undefined} address - e.g. `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, `::`.
 * @returns {boolean}
 */
function isLoopbackListener(address) {
  const text = String(address || '');
  if (text === '::1') return true;
  const v4 = text.startsWith('::ffff:') ? text.slice(7) : text;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Whether a route's matcher selects only paths TangleClaw's own gate exempts,
 * so a route behind it that proxies with no gate exposes nothing TangleClaw
 * would have asked a credential for.
 *
 * Exact entries of `authGate.GATE_BYPASS_PATHS` only. `/openclaw-direct/*` is
 * NOT one: that path carries the stored gateway token for whoever asks, so a
 * Caddy-only exemption for it (#472's prompt-loop workaround) would be an open
 * door while TangleClaw stands down.
 *
 * @param {Array} match - A route's `match` array (matcher sets, OR'd).
 * @returns {boolean}
 */
function isBypassOnlyMatch(match) {
  if (!Array.isArray(match) || match.length === 0) return false;
  return match.every((set) => set && Object.keys(set).length === 1 && Array.isArray(set.path)
    && set.path.length > 0 && set.path.every((p) => authGate.GATE_BYPASS_PATHS.includes(p)));
}

/**
 * Whether a gate route's matcher is the generator's: everything except
 * TangleClaw's bypass paths, as a case-sensitive `path_regexp`.
 *
 * Only this exact form counts as a gate covering the whole site. Caddy's `path`
 * matcher is case-insensitive, so a hand-written `not path …` exempts spellings
 * TangleClaw's router treats differently; anything else narrows the gate to
 * part of the site.
 *
 * @param {Array} match - A route's `match` array.
 * @returns {boolean}
 */
function isGeneratorGateMatch(match) {
  if (!Array.isArray(match) || match.length !== 1) return false;
  const set = match[0];
  if (!set || Object.keys(set).length !== 1 || !Array.isArray(set.not) || set.not.length !== 1) return false;
  const negated = set.not[0];
  if (!negated || Object.keys(negated).length !== 1 || !negated.path_regexp) return false;
  return negated.path_regexp.pattern === caddy.bypassPathRegexp();
}

/**
 * Walk a route list in evaluation order and say whether a request can reach a
 * handler that forwards it before passing a gate.
 *
 * Caddy runs a list's routes in order and a route's handlers in order, and an
 * authentication handler that refuses ends the request. So:
 *   - an `authentication` handler in an unmatched route, or in a route matched
 *     exactly as the generator's gate, covers everything after it in the list;
 *     in any other route it covers only the handlers after it in that route;
 *   - the peer guard covers everything after it (nothing off-box gets past);
 *   - a `subroute` is walked the same way: an unmatched one whose inner list is
 *     covered covers the rest of this list, a matched one covers only itself;
 *   - a `reverse_proxy`, or any handler not in {@link NEUTRAL_HANDLERS}, reached
 *     uncovered is the answer `uncovered` — unless its route matches only
 *     TangleClaw's own bypass paths.
 *
 * @param {Array} routes - Caddy JSON routes.
 * @param {boolean} [covered=false] - Whether an enclosing handler list already
 *   passed a gate, or the enclosing route matches only bypass paths.
 * @returns {{ state: 'covered'|'uncovered'|'none', handler: string|null }}
 *   `covered` — everything after this point in the enclosing list is gated;
 *   `uncovered` — a way through, naming the handler; `none` — neither.
 */
function walkRoutes(routes, covered = false) {
  if (!Array.isArray(routes)) return { state: 'none', handler: null };
  for (const route of routes) {
    if (!route) continue;
    if (drift.isOffboxGuardRoute(route)) return { state: 'covered', handler: null };
    const unmatched = !Array.isArray(route.match) || route.match.length === 0;
    const gateCoversList = unmatched || isGeneratorGateMatch(route.match);
    let routeCovered = covered || (!unmatched && isBypassOnlyMatch(route.match));
    for (const handler of Array.isArray(route.handle) ? route.handle : []) {
      if (!handler) continue;
      const kind = handler.handler;
      if (kind === 'authentication') {
        if (gateCoversList) return { state: 'covered', handler: null };
        routeCovered = true;
      } else if (kind === 'subroute') {
        const inner = walkRoutes(handler.routes, routeCovered);
        if (inner.state === 'uncovered') return inner;
        if (inner.state === 'covered') {
          if (unmatched) return { state: 'covered', handler: null };
          routeCovered = true;
        }
      } else if (!NEUTRAL_HANDLERS.has(kind)) {
        if (!routeCovered) return { state: 'uncovered', handler: String(kind) };
      }
    }
  }
  return { state: 'none', handler: null };
}

/**
 * Whether one top-level route forwards to TangleClaw.
 * @param {object} route - A server's top-level route.
 * @param {number} upstreamPort - TangleClaw's listen port.
 * @returns {boolean}
 */
function _reachesTangleclaw(route, upstreamPort) {
  const acc = { proxies: [], gates: [] };
  drift.collectRoutes([route], acc);
  return acc.proxies.some((dial) => {
    const parsed = drift.parseDial(dial);
    return parsed !== null && drift.isLoopbackHost(parsed.host) && parsed.port === upstreamPort;
  });
}

/**
 * Read a `caddy adapt` config as the door TangleClaw would fall back to.
 *
 * Every top-level route (and error route) that forwards to TangleClaw must pass
 * a gate before anything in it forwards anywhere — see {@link walkRoutes}.
 * Deliberately stricter than the drift check's P1, which accepts one gate
 * anywhere in a site: here TangleClaw is about to stop asking, so a single
 * ungated handle beside a gated one is a way in.
 *
 * @param {object} adapted - `caddy adapt` JSON.
 * @param {number} upstreamPort - TangleClaw's listen port.
 * @returns {{ ok: boolean, reason: string|null,
 *   probes: Array<{ port: number, tls: boolean, host: string|null }> }}
 *   `probes` lists each site reaching TangleClaw that answers other machines —
 *   what the command must see answer `401` with a Basic challenge. A site behind
 *   the peer guard is not listed: from this machine it passes the guard.
 */
function checkFallbackDoor(adapted, upstreamPort) {
  const refuse = (reason) => ({ ok: false, reason, probes: [] });
  if (!adapted || typeof adapted !== 'object') return refuse('no adapted config to read');
  if (typeof upstreamPort !== 'number' || !Number.isInteger(upstreamPort)) {
    return refuse('TangleClaw\'s port is not known');
  }
  const apps = adapted.apps || {};
  const unknownApps = Object.keys(apps).filter((name) => !PASSIVE_APPS.has(name));
  if (unknownApps.length) {
    return refuse(`the Caddyfile runs Caddy apps this check cannot read (${unknownApps.join(', ')})`);
  }
  const servers = (apps.http && apps.http.servers) || {};
  const probes = [];
  for (const server of Object.values(servers)) {
    if (!server) continue;
    const listen = Array.isArray(server.listen) ? server.listen : [];
    if (server.named_routes && Object.keys(server.named_routes).length) {
      return refuse(`the server on ${listen.join(', ')} has named routes, which this check cannot follow`);
    }
    const tls = Array.isArray(server.tls_connection_policies);
    const lists = [
      ['site', server.routes],
      ['error', server.errors && server.errors.routes]
    ];
    for (const [kind, routes] of lists) {
      for (const route of Array.isArray(routes) ? routes : []) {
        if (!route || !_reachesTangleclaw(route, upstreamPort)) continue;
        const hosts = [];
        for (const set of route.match || []) {
          for (const host of (set && set.host) || []) hosts.push(host);
        }
        const where = `the ${kind} route on ${listen.join(', ') || 'no listener'} for ${hosts.join(', ') || 'any host'}`;
        const walked = walkRoutes([route]);
        if (walked.state === 'uncovered') {
          return refuse(`${where} reaches TangleClaw without passing Caddy's gate `
            + `(an ungated \`${walked.handler}\`) — a Caddy-only exemption such as /openclaw-direct/* counts`);
        }
        const handlers = Array.isArray(route.handle) ? route.handle : [];
        const guarded = handlers.length > 0 && handlers.every(
          (h) => h && h.handler === 'subroute' && drift.refusesOffboxBeforeProxy(h.routes)
        );
        if (guarded || kind === 'error') continue;
        for (const address of listen) {
          const m = /:(\d+)$/.exec(String(address));
          if (!m) return refuse(`cannot read a port from the listen address ${address}`);
          const port = Number(m[1]);
          const probeTls = tls || port === 443;
          if (hosts.length === 0) probes.push({ port, tls: probeTls, host: null });
          for (const host of hosts) probes.push({ port, tls: probeTls, host });
        }
      }
    }
  }
  return { ok: true, reason: null, probes };
}

/**
 * Decide whether the marker is honoured. Pure: every fact is gathered by the
 * caller, so the rule is testable as data.
 *
 * @param {object} facts
 * @param {boolean} facts.markerPresent - The marker file exists.
 * @param {string|null} facts.listenerAddress - The address TangleClaw is bound to.
 * @param {number|null} facts.upstreamPort - TangleClaw's listen port.
 * @param {boolean} facts.caddyfileExists - A Caddyfile is on disk.
 * @param {{ ok: boolean, config: object|null, reason: string|null }|null} facts.adapted -
 *   `caddy adapt` over it, when it exists.
 * @param {string|null} facts.ingressMode - From config, or null when config
 *   could not be read.
 * @returns {{ honoured: boolean, reason: string|null }} `reason` says why a
 *   present marker is not honoured; null when there is no marker or it is.
 */
function decideFallback(facts) {
  const {
    markerPresent, listenerAddress, upstreamPort, caddyfileExists, adapted, ingressMode
  } = facts || {};
  if (markerPresent !== true) return { honoured: false, reason: null };
  if (!isLoopbackListener(listenerAddress)) {
    return {
      honoured: false,
      reason: `TangleClaw is listening on ${listenerAddress || 'an unknown address'}, not loopback, `
        + 'so other machines could reach it without passing any fallback door'
    };
  }
  if (caddyfileExists !== true) {
    if (ingressMode === 'direct') return { honoured: true, reason: null };
    return {
      honoured: false,
      reason: ingressMode === null || ingressMode === undefined
        ? 'there is no Caddyfile and the config could not be read to confirm direct mode'
        : `there is no Caddyfile but the install is in ${ingressMode} mode, so Caddy may still `
          + 'be serving a door nobody can read'
    };
  }
  if (!adapted || adapted.ok !== true) {
    return {
      honoured: false,
      reason: `caddy adapt could not read the Caddyfile (${(adapted && adapted.reason) || 'no result'})`
    };
  }
  const door = checkFallbackDoor(adapted.config, upstreamPort);
  if (!door.ok) return { honoured: false, reason: door.reason };
  return { honoured: true, reason: null };
}

module.exports = {
  MARKER_NAME,
  NEUTRAL_HANDLERS,
  markerPath,
  writeMarker,
  removeMarker,
  isLoopbackListener,
  isBypassOnlyMatch,
  isGeneratorGateMatch,
  walkRoutes,
  checkFallbackDoor,
  decideFallback
};
