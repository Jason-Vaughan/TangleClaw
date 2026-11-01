'use strict';

/**
 * Resolve the origin TangleClaw should advertise when Tailscale advertisement
 * mode is on (#1380): every URL TangleClaw emits (session links, VRF links,
 * artifact shares, medusa endpoints) is loopback-shaped by default, which is
 * useless to an operator reaching the box over a Tailnet.
 *
 * Three design corrections, carried through deliberately:
 *
 * 1. **Orthogonal to `ingressMode`.** This module answers only "what
 *    hostname/port should a link use," never "how is TLS terminated." The
 *    caller passes the ACTIVE listen port (`caddyHttpsPort` in caddy mode,
 *    the effective server port in direct mode); this module never reads
 *    config and never decides which port that is, so it stays a two-state
 *    flag beside `ingressMode` rather than a bolted-together four-state one.
 * 2. **Always `[TailscaleHost]:[TC_PORT]`, never a bare hostname.** A bare
 *    tailnet hostname defaults to port 443, which a machine-wide
 *    `tailscale serve`/`funnel` route may be proxying somewhere else
 *    entirely (see #815) — reproduced live on the operator's own machine,
 *    where Serve owns 443 and proxies to an unrelated app. The port is
 *    always stated explicitly, even when it is the scheme's default.
 * 3. **Honest failure detection.** `tailscale status --json` is read, never
 *    guessed, and a node that is offline, has MagicDNS off, or has no
 *    `tailscale` CLI on `PATH` is reported with the specific reason — never
 *    a silent fallback to `localhost` or a URL nothing will answer.
 *
 * Command execution reuses `lib/host-check.js#runAllowed` (no shell, a
 * timeout, a stdout cap) rather than a second copy of that same discipline —
 * `tailscale status --json` is already on its allow-list.
 *
 * @module lib/tailscale-ingress
 */

const hostCheck = require('./host-check');

/** Every reason this module can report instead of an origin. */
const FAILURE_REASONS = Object.freeze({
  DISABLED: 'disabled',
  BAD_PORT: 'bad-port',
  CLI_ABSENT: 'cli-absent',
  COMMAND_FAILED: 'command-failed',
  PROBE_TIMEOUT: 'probe-timeout',
  OUTPUT_TOO_LARGE: 'output-too-large',
  NOT_JSON: 'not-json',
  NODE_NOT_RUNNING: 'node-not-running',
  MAGIC_DNS_OFF: 'magicdns-off',
  NO_DNS_NAME: 'no-dns-name'
});

/** Operator-facing explanation for each failure reason. */
const FAILURE_MESSAGES = Object.freeze({
  [FAILURE_REASONS.DISABLED]: 'Tailscale advertisement mode is not enabled',
  [FAILURE_REASONS.BAD_PORT]: 'the active listen port is missing or invalid',
  [FAILURE_REASONS.CLI_ABSENT]: 'the tailscale CLI is not installed, or not on PATH',
  [FAILURE_REASONS.COMMAND_FAILED]: '`tailscale status --json` failed to run',
  [FAILURE_REASONS.PROBE_TIMEOUT]: '`tailscale status --json` did not respond in time',
  [FAILURE_REASONS.OUTPUT_TOO_LARGE]: '`tailscale status --json` produced more output than expected',
  [FAILURE_REASONS.NOT_JSON]: '`tailscale status --json` did not return valid JSON',
  [FAILURE_REASONS.NODE_NOT_RUNNING]: 'this tailscale node is not running (see `tailscale status`)',
  [FAILURE_REASONS.MAGIC_DNS_OFF]: 'MagicDNS is off for this tailnet, so there is no stable hostname to advertise',
  [FAILURE_REASONS.NO_DNS_NAME]: 'this node has no assigned tailnet hostname'
});

/**
 * Build the failure shape every function here returns on the honest-failure
 * path: `{ ok: false, reason, detail }`, never a thrown error and never a
 * silent fallback value.
 * @param {string} reason - One of `FAILURE_REASONS`.
 * @param {string} [detail] - Overrides `FAILURE_MESSAGES[reason]` when a
 *   specific detail (an actual backend state, a command's error message) is
 *   more useful to the operator than the generic explanation.
 * @returns {{ok: false, reason: string, detail: string}}
 */
function _fail(reason, detail) {
  return { ok: false, reason, detail: detail || FAILURE_MESSAGES[reason] || reason };
}

/**
 * Strip the trailing dot `tailscale status --json` always writes on
 * `Self.DNSName` (it reports a fully-qualified name, e.g.
 * `host.tail1234.ts.net.`), and trim incidental whitespace.
 * @param {*} name - Candidate `Self.DNSName`.
 * @returns {string} Empty string when `name` is not a usable string.
 */
function _normalizeDnsName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Resolve this node's tailnet hostname from `tailscale status --json`.
 * Honest failure detection only (#1380's third design correction): every
 * branch below ends in a specific, named reason — never a guess and never a
 * quiet fallback to `localhost`.
 * @param {object} [deps] - Injected for tests.
 * @param {Function} [deps.execFile] - Replaces `node:child_process.execFile`.
 * @returns {Promise<{ok: true, host: string} | {ok: false, reason: string, detail: string}>}
 */
async function resolveTailscaleHost(deps = {}) {
  const execFile = deps.execFile || require('node:child_process').execFile;
  let res;
  try {
    res = await hostCheck.runAllowed({ execFile }, 'tailscale', ['status', '--json']);
  } catch (err) {
    return _fail(FAILURE_REASONS.COMMAND_FAILED, err.message);
  }
  if (!res.ok) {
    // `runAllowed`'s own reason vocabulary (`cli-absent`, `command-failed`,
    // `probe-timeout`, `output-too-large`) is reused verbatim — this
    // module's `FAILURE_REASONS` spells each one identically on purpose, so
    // no translation table can drift out of sync with the thing it mirrors.
    return _fail(res.reason, FAILURE_MESSAGES[res.reason]);
  }
  let doc;
  try {
    doc = JSON.parse(res.stdout);
  } catch {
    return _fail(FAILURE_REASONS.NOT_JSON);
  }
  const backend = doc && typeof doc.BackendState === 'string' ? doc.BackendState : '';
  if (backend !== 'Running') {
    return _fail(
      FAILURE_REASONS.NODE_NOT_RUNNING,
      backend ? `tailscale backend state is "${backend}", not "Running"` : FAILURE_MESSAGES[FAILURE_REASONS.NODE_NOT_RUNNING]
    );
  }
  const tailnet = doc && doc.CurrentTailnet;
  if (!tailnet || tailnet.MagicDNSEnabled !== true) {
    return _fail(FAILURE_REASONS.MAGIC_DNS_OFF);
  }
  const host = _normalizeDnsName(doc.Self && doc.Self.DNSName);
  if (!host) return _fail(FAILURE_REASONS.NO_DNS_NAME);
  return { ok: true, host };
}

/**
 * Compose the advertised origin from a resolved tailnet host and the active
 * listen port (#1380's second design correction): the port is always
 * explicit, never implied by the scheme's default.
 * @param {string} host - A resolved tailnet hostname (never blank, never a
 *   loopback spelling).
 * @param {number} port - The active listen port.
 * @param {string} [scheme='https']
 * @returns {string}
 * @throws {Error} When `host` or `port` is malformed — a programming error in
 *   the caller, not a runtime condition this module reports as `ok: false`.
 */
function composeAdvertisedOrigin(host, port, scheme = 'https') {
  if (typeof host !== 'string' || host.trim() === '') throw new Error('host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be a whole number from 1 to 65535');
  if (typeof scheme !== 'string' || scheme.trim() === '') throw new Error('scheme is required');
  return `${scheme}://${host}:${port}`;
}

/**
 * Resolve the origin TangleClaw should advertise under Tailscale mode, or an
 * honest reason it cannot — the one function the rest of the product needs.
 *
 * @param {object} opts
 * @param {boolean} opts.enabled - The `tailscaleMode` config flag. `false`
 *   (or omitted) answers `{ok: false, reason: 'disabled'}` without touching
 *   `tailscale` at all — a caller on a project that never turned this on
 *   pays no process-spawn cost.
 * @param {number} opts.port - The active listen port (the caller's job to
 *   resolve — see the module header's first design correction).
 * @param {string} [opts.scheme='https']
 * @param {object} [opts.deps] - Injected for tests.
 * @returns {Promise<{ok: true, origin: string, host: string} | {ok: false, reason: string, detail: string}>}
 */
async function resolveAdvertisedOrigin(opts = {}) {
  const { enabled, port, scheme = 'https', deps } = opts;
  if (!enabled) return _fail(FAILURE_REASONS.DISABLED);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return _fail(FAILURE_REASONS.BAD_PORT);
  const resolved = await resolveTailscaleHost(deps);
  if (!resolved.ok) return resolved;
  return { ok: true, origin: composeAdvertisedOrigin(resolved.host, port, scheme), host: resolved.host };
}

module.exports = {
  FAILURE_REASONS,
  FAILURE_MESSAGES,
  resolveTailscaleHost,
  composeAdvertisedOrigin,
  resolveAdvertisedOrigin
};
