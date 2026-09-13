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
//   2. every route in the Caddyfile on disk that could reach TangleClaw passes
//      Caddy's own gate (or the peer guard) first, read through `caddy adapt` —
//      Caddy's parser, never a text walk — and the file imports no other file
//      (an edit there would not be noticed); or there is no Caddyfile at all
//      and the install is in direct mode.
// Anything unreadable, unmeasurable or unrecognised refuses, with the reason.

const fs = require('node:fs');
const net = require('node:net');
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

/**
 * Addresses judged by VALUE, never by spelling: `::ffff:7f00:1`,
 * `0:0:0:0:0:0:0:1` and `127.9.9.9` are all this machine's loopback, and an
 * exact-string list misses every form it did not think of. `net.BlockList`
 * compares parsed addresses and matches IPv4-mapped IPv6 against the IPv4 rules.
 */
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
const LOOPBACK_OR_UNSPECIFIED = new net.BlockList();
LOOPBACK_OR_UNSPECIFIED.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_OR_UNSPECIFIED.addAddress('0.0.0.0', 'ipv4');
LOOPBACK_OR_UNSPECIFIED.addAddress('::1', 'ipv6');
LOOPBACK_OR_UNSPECIFIED.addAddress('::', 'ipv6');

/**
 * Whether an IP literal falls in a block list; false for anything that is not one.
 * @param {net.BlockList} list
 * @param {string} address
 * @returns {boolean}
 */
function _inList(list, address) {
  const family = net.isIP(address);
  return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

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
  return _inList(LOOPBACK, String(address || ''));
}

/**
 * Whether anything in a route could change the request path before it is
 * forwarded: a `rewrite` handler anywhere in it, or a `reverse_proxy` carrying
 * its own `rewrite`.
 * @param {object} route - A Caddy JSON route.
 * @returns {boolean}
 */
function _rewritesPath(route) {
  for (const handler of Array.isArray(route && route.handle) ? route.handle : []) {
    if (!handler) continue;
    if (handler.handler === 'rewrite') return true;
    if (handler.handler === 'reverse_proxy' && handler.rewrite) return true;
    if (handler.handler === 'subroute' && Array.isArray(handler.routes) && handler.routes.some(_rewritesPath)) {
      return true;
    }
  }
  return false;
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
 *     TangleClaw's own bypass paths AND nothing in it rewrites the path, since
 *     a rewrite could forward a gated path under an exempt matcher.
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
    let routeCovered = covered || (!unmatched && isBypassOnlyMatch(route.match) && !_rewritesPath(route));
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
 * Whether one upstream dial PROVABLY does not reach TangleClaw's listener.
 *
 * Proof is narrow: a dial that parses as `host:port` where the port differs, or
 * the host is a concrete address that is not loopback (TangleClaw's listener is
 * loopback, or the marker is not honoured at all). Everything else — an empty
 * host (`:3102` dials the local system), a wildcard, a placeholder, a unix
 * socket, a network prefix — cannot be ruled out, so it counts as reaching.
 *
 * @param {string} dial - An upstream's `dial`.
 * @param {number} upstreamPort - TangleClaw's listen port.
 * @returns {boolean}
 */
function _dialProvablyElsewhere(dial, upstreamPort) {
  const parsed = drift.parseDial(dial);
  if (parsed === null) return false;
  if (parsed.port !== upstreamPort) return true;
  const host = parsed.host.replace(/^\[|\]$/g, '');
  // Only a concrete IP that is neither loopback nor unspecified is proof; an
  // empty host, a name (`localhost` included) or anything else is not.
  return net.isIP(host) !== 0 && !_inList(LOOPBACK_OR_UNSPECIFIED, host);
}

/**
 * Whether one top-level route could forward to TangleClaw: it holds any
 * `reverse_proxy` that is not provably pointed elsewhere — including one with
 * no static upstreams (`dynamic_upstreams`) or an upstream this cannot read.
 * @param {object} route - A server's top-level route.
 * @param {number} upstreamPort - TangleClaw's listen port.
 * @returns {boolean}
 */
function _mayReachTangleclaw(route, upstreamPort) {
  for (const handler of Array.isArray(route && route.handle) ? route.handle : []) {
    if (!handler) continue;
    if (handler.handler === 'reverse_proxy') {
      const upstreams = Array.isArray(handler.upstreams) ? handler.upstreams : [];
      if (handler.dynamic_upstreams || upstreams.length === 0) return true;
      if (upstreams.some((u) => !u || typeof u.dial !== 'string' || !_dialProvablyElsewhere(u.dial, upstreamPort))) {
        return true;
      }
    } else if (handler.handler === 'subroute' && Array.isArray(handler.routes)
        && handler.routes.some((r) => _mayReachTangleclaw(r, upstreamPort))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a Caddyfile imports another FILE (as opposed to a snippet defined in
 * itself). `caddy adapt` follows the import, but the honoured verdict is cached
 * on the Caddyfile's own mtime and size, so an ungated route added to the
 * imported file would not be re-checked. Such a file refuses instead.
 *
 * Read on the text, and deliberately over-reports: any `import` whose first
 * argument is not the name of a `(snippet)` defined in this file counts.
 *
 * @param {string} content - Caddyfile text.
 * @returns {string|null} The first imported name that is not a local snippet, or null.
 */
function importedFile(content) {
  if (typeof content !== 'string') return null;
  const lines = content.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trim());
  const snippets = new Set();
  for (const line of lines) {
    const m = /^\(([^()\s]+)\)\s*\{$/.exec(line);
    if (m) snippets.add(m[1]);
  }
  for (const line of lines) {
    const m = /^import\s+(\S+)/.exec(line);
    if (m && !snippets.has(m[1])) return m[1];
  }
  return null;
}

/**
 * The whole fallback-door question for one Caddyfile: its text imports no other
 * file, and its adapted config passes {@link checkFallbackDoor}. The one entry
 * point both the server and the command ask.
 * @param {string} content - Caddyfile text.
 * @param {object} adaptedConfig - `caddy adapt` JSON for that text.
 * @param {number} upstreamPort - TangleClaw's listen port.
 * @returns {{ ok: boolean, reason: string|null, probes: Array<{ port: number, tls: boolean, host: string|null }> }}
 */
function checkFallbackFile(content, adaptedConfig, upstreamPort) {
  const imported = importedFile(content);
  if (imported !== null) {
    return {
      ok: false,
      reason: `the Caddyfile imports \`${imported}\`, and a change there would not be noticed while `
        + 'TangleClaw stands down — inline it, or restore a Caddyfile that does not import',
      probes: []
    };
  }
  return checkFallbackDoor(adaptedConfig, upstreamPort);
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
        if (!route || !_mayReachTangleclaw(route, upstreamPort)) continue;
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
 * @param {string|null} [facts.caddyfileContent] - Its text, when it exists.
 * @param {{ ok: boolean, config: object|null, reason: string|null }|null} facts.adapted -
 *   `caddy adapt` over it, when it exists.
 * @param {string|null} facts.ingressMode - From config, or null when config
 *   could not be read.
 * @returns {{ honoured: boolean, reason: string|null }} `reason` says why a
 *   present marker is not honoured; null when there is no marker or it is.
 */
function decideFallback(facts) {
  const {
    markerPresent, listenerAddress, upstreamPort, caddyfileExists, caddyfileContent, adapted, ingressMode
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
  if (typeof caddyfileContent !== 'string') {
    return { honoured: false, reason: 'the Caddyfile\'s text was not read' };
  }
  const door = checkFallbackFile(caddyfileContent, adapted.config, upstreamPort);
  if (!door.ok) return { honoured: false, reason: door.reason };
  return { honoured: true, reason: null };
}

module.exports = {
  MARKER_NAME,
  NEUTRAL_HANDLERS,
  PASSIVE_APPS,
  markerPath,
  writeMarker,
  removeMarker,
  isLoopbackListener,
  isBypassOnlyMatch,
  isGeneratorGateMatch,
  walkRoutes,
  importedFile,
  checkFallbackDoor,
  checkFallbackFile,
  decideFallback
};
