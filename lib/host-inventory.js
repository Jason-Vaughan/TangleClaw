'use strict';

/**
 * The one answer to "what name does this machine serve on its overlay network?"
 * (#1905, Architect rulings R45/R46).
 *
 * Four consumers need that name: the certificate's SAN list, the served-Host
 * allowlist, the Caddy tailnet site and the operator links. They used to answer
 * it from two sources. Links probed `tailscale status`, and everything else read
 * `config.caddyTailnetHost`, which a default install leaves null. So a link could
 * name a host that the certificate did not carry and the allowlist refused.
 * Every consumer now asks this module, so they cannot disagree.
 *
 * The name comes only from a validated local source: the overlay's own status
 * command, or the configured name. It never comes from a request's `Host` header,
 * because a header is what the allowlist exists to judge.
 *
 * @module lib/host-inventory
 */

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('host-inventory');

const PROBE_TIMEOUT_MS = 3000;
// How long an observation that found no name is trusted before the next reader
// probes again. The server's first probe runs at boot, which is exactly when an
// overlay daemon may not be up yet; a miss remembered for the process lifetime
// kept the name out of the allowlist until a restart. A found name is kept: it
// changes only when the machine is renamed, and a mutation boundary refreshes it.
const MISS_RETRY_MS = 60 * 1000;

// One DNS label: 1-63 characters, alphanumeric at both ends, hyphens inside.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Test seam, mirroring `lib/server-info.js#_internal`. `session-ownership`
// exposes this same `execSync` through its own `_internal`, so there is one
// probe and one place to stub it.
const _internal = { execSync, now: () => Date.now() };

/**
 * Overlay networks whose status command reports this machine's DNS name.
 *
 * Tailscale is the only entry today. Another overlay that publishes its own
 * names (a WireGuard mesh with a DNS plane, a Zero Trust tunnel) is added here
 * as another entry. Every consumer reads the result through
 * `resolveTailnetHost`, so none of them grows a provider-specific branch.
 *
 * `parse` receives the command's stdout and returns the raw name, or null. It
 * may throw on malformed output; the probe turns that into a reported omission.
 */
const OVERLAY_DNS_PROVIDERS = Object.freeze([
  Object.freeze({
    provider: 'tailscale',
    command: 'tailscale status --json',
    parse(stdout) {
      const parsed = JSON.parse(String(stdout || ''));
      const dns = parsed && parsed.Self && parsed.Self.DNSName;
      return typeof dns === 'string' ? dns : null;
    }
  })
]);

// The memoized observation. undefined = never probed in this process.
let _observation;

/**
 * Normalize a host name to the one form every consumer compares.
 *
 * Trims whitespace, lowercases, and strips trailing dots, so the fully
 * qualified `Host.Tailnet.ts.net.` that `tailscale status` reports and the
 * `host.tailnet.ts.net` a browser sends compare equal. Returns null for
 * anything that is not a DNS name: an empty value, an IP literal, a port, a
 * scheme, or a label that breaks DNS shape. IP literals are deliberately out of
 * scope, because the allowlist accepts any IP-literal `Host` on its own
 * reasoning.
 *
 * @param {*} value - Candidate name.
 * @returns {string|null} The normalized name, or null.
 */
function normalizeHostName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!name || name.length > 253) return null;
  const labels = name.split('.');
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  // A name made of digit-only labels is an IPv4 literal, not a DNS name.
  if (labels.every((label) => /^[0-9]+$/.test(label))) return null;
  return name;
}

/**
 * Run each registered overlay provider's probe, fresh, and return the first name found.
 *
 * Never throws. A missing binary, a stopped daemon, malformed output and an
 * invalid name all come back as `host: null` with a `reason`, so a caller
 * reports the omission instead of inventing a host.
 *
 * @returns {{host: string|null, provider: string|null, reason: string|null}}
 */
function probeOverlayDns() {
  const misses = [];
  for (const p of OVERLAY_DNS_PROVIDERS) {
    let stdout;
    try {
      stdout = _internal.execSync(p.command, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err) {
      log.debug('Overlay DNS probe unavailable', { provider: p.provider, error: err.message });
      misses.push(`${p.provider}: unavailable`);
      continue;
    }
    let raw;
    try {
      raw = p.parse(stdout);
    } catch (err) {
      log.debug('Overlay DNS probe output unreadable', { provider: p.provider, error: err.message });
      misses.push(`${p.provider}: unreadable output`);
      continue;
    }
    const host = normalizeHostName(raw);
    if (host) return { host, provider: p.provider, reason: null };
    misses.push(raw ? `${p.provider}: reported an invalid name` : `${p.provider}: reported no name`);
  }
  return { host: null, provider: null, reason: misses.join('; ') || 'no overlay provider registered' };
}

/**
 * The process-wide overlay observation that every consumer shares.
 *
 * Probed once and memoized: the allowlist runs on every guarded request, and a
 * synchronous probe per request would stall the event loop. A miss is retried
 * after `MISS_RETRY_MS`, so a daemon that starts after the server is picked up
 * without a restart. A mutation boundary (certificate generation) passes
 * `refresh: true` so what it writes reflects the machine now, and every later
 * reader sees that same refreshed answer.
 *
 * @param {object} [options]
 * @param {boolean} [options.refresh=false] - Probe again instead of reusing the memo.
 * @returns {{host: string|null, provider: string|null, reason: string|null, at: number}}
 */
function observeOverlayDns({ refresh = false } = {}) {
  const now = _internal.now();
  const staleMiss = _observation && !_observation.host
    && now - _observation.at >= MISS_RETRY_MS;
  if (refresh || _observation === undefined || staleMiss) {
    const previous = _observation && _observation.host;
    _observation = { ...probeOverlayDns(), at: now };
    if (_observation.host && _observation.host !== previous) {
      log.info('Overlay DNS name observed', { host: _observation.host, provider: _observation.provider });
    } else if (!_observation.host && previous) {
      // Logged on the transition only: a machine with no overlay misses on
      // every retry, and a line a minute would say nothing new.
      log.info('Overlay DNS name no longer observed', { previous, reason: _observation.reason });
    }
  }
  return _observation;
}

/**
 * The canonical tailnet host, with its provenance.
 *
 * - A configured name (`config.caddyTailnetHost`) wins. It is what the Caddy
 *   tailnet site and the existing certificate were built for.
 * - With nothing configured, the observed name is used.
 * - A configured name that differs from the observed one is reported as
 *   `drift`. The configured name stays canonical and the observed one is
 *   ignored until reconciled, so neither is silently half-adopted.
 * - With neither, `host` is null and `omission` says why. No host is invented,
 *   and an explicit host entry still works.
 *
 * `caddySite` says whether a Caddy tailnet site serves the host. A detected name
 * is never written into `caddyTailnetHost` here: the Caddy generator refuses a
 * tailnet site without a gate, so adding one is the operator's decision.
 *
 * @param {object|null} config - Loaded TangleClaw config.
 * @param {{host: string|null, provider?: string|null, reason?: string|null}} [observation]
 *   - Defaults to the shared memo (`observeOverlayDns()`).
 * @returns {{host: string|null, source: 'configured'|'detected'|null,
 *   configured: string|null, observed: string|null, provider: string|null,
 *   drift: {configured: string, observed: string}|null,
 *   omission: string|null, caddySite: 'configured'|'not-configured'}}
 */
function resolveTailnetHost(config, observation) {
  const obs = observation || observeOverlayDns();
  const configured = normalizeHostName(config && config.caddyTailnetHost);
  const observed = normalizeHostName(obs && obs.host);
  const provider = observed ? (obs.provider || null) : null;
  const caddySite = configured ? 'configured' : 'not-configured';
  if (configured) {
    const drift = observed && observed !== configured ? { configured, observed } : null;
    return { host: configured, source: 'configured', configured, observed, provider, drift, omission: null, caddySite };
  }
  if (observed) {
    return { host: observed, source: 'detected', configured: null, observed, provider, drift: null, omission: null, caddySite };
  }
  return {
    host: null,
    source: null,
    configured: null,
    observed: null,
    provider: null,
    drift: null,
    omission: `no overlay DNS name detected (${(obs && obs.reason) || 'no observation'}); `
      + 'add the name explicitly with POST /api/setup/generate-cert {"hosts": [...]}',
    caddySite
  };
}

/**
 * Forget the memoized observation. Tests only.
 * @returns {void}
 */
function _resetForTest() {
  _observation = undefined;
}

module.exports = {
  normalizeHostName,
  probeOverlayDns,
  observeOverlayDns,
  resolveTailnetHost,
  OVERLAY_DNS_PROVIDERS,
  MISS_RETRY_MS,
  _internal,
  _resetForTest
};
