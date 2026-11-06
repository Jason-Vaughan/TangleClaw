'use strict';

// Shared shape-validators for SSH-target fields that get interpolated into
// shell `ssh`/`scp` commands (#314 — one source of truth for the guards
// introduced in #311/#312/#313). Used by lib/openclaw-detect.js,
// lib/openclaw-version.js, and the POST /api/openclaw/test route.
//
// These are deliberately strict allow-lists: anything outside the character
// class is rejected before it can reach a shell. They are NOT a substitute for
// avoiding interpolation where practical — they're the defense-in-depth net for
// the places that already build command strings.

// hostname / IPv4 / IPv6 / tailscale name. Colons allow IPv6 literals.
const SAFE_HOST = /^[A-Za-z0-9._:-]+$/;
// POSIX-ish usernames.
const SAFE_USER = /^[A-Za-z0-9._-]+$/;
// Key/dir paths: a leading ~ (expanded by the caller or remote shell) plus a
// metacharacter-free path body. No spaces, quotes, $, backticks, ;, |, &, etc.
const SAFE_KEYPATH = /^~?[A-Za-z0-9_./-]+$/;

/**
 * Validate that an SSH target's interpolated fields are all shape-safe.
 * @param {object} conn - { host, sshUser, sshKeyPath }
 * @returns {string|null} An error reason, or null when all fields are safe.
 */
function unsafeReason(conn) {
  if (!conn || !conn.host || !conn.sshUser || !conn.sshKeyPath) {
    return 'host, sshUser, and sshKeyPath are all required';
  }
  if (!SAFE_HOST.test(conn.host)) return 'host contains unsafe characters';
  if (!SAFE_USER.test(conn.sshUser)) return 'sshUser contains unsafe characters';
  if (!SAFE_KEYPATH.test(conn.sshKeyPath)) return 'sshKeyPath contains unsafe characters';
  return null;
}

/**
 * Validate a single host value's shape, the same check `unsafeReason` applies
 * to `conn.host` (#1531) — split out so a fallback host, which has no
 * `sshUser`/`sshKeyPath` of its own, can be validated on its own.
 * @param {string} host
 * @returns {string|null} An error reason, or null when safe.
 */
function unsafeHostReason(host) {
  if (!host || typeof host !== 'string') return 'host is required';
  if (!SAFE_HOST.test(host)) return 'host contains unsafe characters';
  return null;
}

/**
 * IPv4 literal (`192.168.20.10`) — not a validity check (`999.999.999.999`
 * passes the shape), just whether it LOOKS like dotted-quad, which is enough
 * to flag a connection that would break the moment the operator's network
 * changes (#363).
 * @type {RegExp}
 */
const IPV4_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Whether `host` is an IP literal (IPv4 dotted-quad, or IPv6 — bracketed
 * `[::1]` or bare `::1`/`fd7a::1`) rather than a DNS/MagicDNS name (#363).
 * A bare IPv6 literal is distinguished from a hostname by containing `::`
 * or at least two `:` — a MagicDNS/tailnet name never contains a colon
 * (`SAFE_HOST` allows one only for this reason).
 * @param {string} host
 * @returns {boolean}
 */
function isIpLiteralHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (IPV4_LITERAL.test(bare)) return true;
  return bare.includes(':'); // every hostname this project accepts is colon-free
}

/**
 * Validate a `fallbackHosts` array (#1531): every entry shape-safe via
 * `unsafeHostReason`, non-empty after trimming, and deduplicated against
 * both each other and the primary `host` (a fallback identical to the
 * primary is never useful and would make `resolveReachableHost`'s priority
 * order ambiguous). Order is preserved — priority is the whole point.
 * @param {*} hosts - Candidate value, expected `string[]`.
 * @param {string} [primaryHost] - The connection's own `host`, excluded from the result.
 * @returns {{ok: true, hosts: string[]}|{ok: false, error: string}}
 */
function validateFallbackHosts(hosts, primaryHost) {
  if (hosts === undefined || hosts === null) return { ok: true, hosts: [] };
  if (!Array.isArray(hosts)) return { ok: false, error: 'fallbackHosts must be an array of strings' };

  const seen = new Set(primaryHost ? [primaryHost] : []);
  const result = [];
  for (const raw of hosts) {
    if (typeof raw !== 'string') return { ok: false, error: 'fallbackHosts entries must be strings' };
    const host = raw.trim();
    if (!host) continue; // a blank entry (e.g. a cleared form row) is dropped, not an error
    const bad = unsafeHostReason(host);
    if (bad) return { ok: false, error: `fallbackHosts: ${bad} ("${host}")` };
    if (seen.has(host)) continue; // dedupe, preserving the first (highest-priority) occurrence
    seen.add(host);
    result.push(host);
  }
  return { ok: true, hosts: result };
}

/**
 * Audit a list of connections for an IP-literal `host` (#363) — the shape
 * that breaks the moment the operator's network changes (#1531's own
 * report). Read-only: names the connections and a suggested action, nothing
 * is rewritten here.
 * @param {Array<{id: string, name: string, host: string}>} connections
 * @returns {{ipLiteralCount: number, connections: Array<{id: string, name: string, host: string, isIpLiteral: true, suggestedAction: string}>}}
 */
function auditIpLiteralConnections(connections) {
  const flagged = (connections || [])
    .filter((c) => c && isIpLiteralHost(c.host))
    .map((c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      isIpLiteral: true,
      suggestedAction: 'Migrate to a stable DNS/MagicDNS name (e.g. a Tailscale name) and keep this IP as a fallback.'
    }));
  return { ipLiteralCount: flagged.length, connections: flagged };
}

module.exports = {
  SAFE_HOST, SAFE_USER, SAFE_KEYPATH, unsafeReason,
  unsafeHostReason, isIpLiteralHost, validateFallbackHosts, auditIpLiteralConnections
};
