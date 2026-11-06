'use strict';

// Non-blocking child-process runners for the OpenClaw request handlers that reach
// a remote host: instanceDir detection, pairing approval and the connection test.
// (The connection version read keeps its own runner in lib/openclaw-version.js.)
// Each such call can wait out a full SSH connect timeout when the host does not
// answer, and a synchronous call holds the server's single event loop for all of
// it: WebSockets drop and the dashboard reloads. These runners keep the wait off
// the loop, and `_internal` is the one seam the tests stub.

const net = require('node:net');
const { exec, execFile } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');

/**
 * Settle a child-process callback into a promise, attaching the captured
 * streams to the rejection so callers can report the remote side's own words.
 *
 * The rejection's text is rewritten, because every caller shows
 * `err.stderr || err.message` to the operator. Node's own message is
 * `Command failed: <the whole command line>`: it never says a timeout killed the
 * command, and it echoes whatever the command interpolated. A timeout is
 * therefore named in both fields, and any other failure carries its exit status
 * instead of the command line.
 * @param {Function} resolve
 * @param {Function} reject
 * @param {number|undefined} timeout - The timeout that was set, for the message.
 * @returns {(err: Error|null, stdout: string, stderr: string) => void}
 */
function _settle(resolve, reject, timeout) {
  return (err, stdout, stderr) => {
    if (!err) {
      resolve({ stdout, stderr });
      return;
    }
    const said = (stderr || '').trimEnd();
    if (wasTimedOut(err)) {
      const note = `timed out after ${timeout}ms`;
      err.timedOut = true;
      err.message = note;
      err.stderr = said ? `${said} (${note})` : '';
    } else {
      if (typeof err.code === 'number') err.message = `exited with status ${err.code}`;
      err.stderr = stderr;
    }
    err.stdout = stdout;
    reject(err);
  };
}

/**
 * Write `input` to a child's stdin and close it.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string|undefined} input
 * @returns {void}
 */
function _feed(child, input) {
  // A child that exits before reading stdin raises EPIPE on the stream; the
  // exit callback already reports that outcome, so the stream error is dropped.
  child.stdin.on('error', () => {});
  child.stdin.end(input == null ? '' : input);
}

/**
 * Run a shell command without blocking.
 * @param {string} cmd - Shell command line. Callers validate anything they interpolate.
 * @param {object} [opts]
 * @param {string} [opts.input] - Written to stdin (promisified `exec` has no `input`).
 * @param {number} [opts.timeout] - Kill the command after this many ms.
 * @returns {Promise<{stdout: string, stderr: string}>} Rejects with an error carrying
 *   `stdout`, `stderr`, `code`, and `timedOut` when our timeout killed it.
 */
function _runShell(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject, opts.timeout));
    _feed(child, opts.input);
  });
}

/**
 * Run a program with an argument vector (no shell) without blocking.
 * @param {string} file - Program to run.
 * @param {string[]} args - Arguments, passed verbatim.
 * @param {object} [opts]
 * @param {number} [opts.timeout] - Kill the program after this many ms.
 * @returns {Promise<{stdout: string, stderr: string}>} Rejects with an error carrying
 *   `stdout`, `stderr`, `code`, and `timedOut` when our timeout killed it.
 */
function _runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: opts.timeout, encoding: 'utf8' }, _settle(resolve, reject, opts.timeout));
    _feed(child, undefined);
  });
}

// ── #1531: parallel port-22 resolver for a connection's ordered addresses ──
//
// A connection declares `host` plus an optional, priority-ordered
// `fallbackHosts: string[]` (lib/store.js). When the operator's network
// changes (#1531's report: a LAN IP became unreachable after a network
// move, while a Tailscale MagicDNS name for the same host kept working),
// every SSH consumer should try the next address rather than staying stuck
// on one that stopped answering. Probing in PARALLEL matters: trying
// addresses one after another multiplies connect timeouts — the same
// event-loop-stall class #1527/#1529 fixed for a single host.

const SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 1500;
const RESOLUTION_TTL_MS = 60 * 1000;

// connId -> { activeHost, fallbackUsed, resolvedAt }
const _resolved = new Map();

/**
 * Probe one host's TCP port, never rejecting.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function _probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * De-duplicate a candidate list, preserving first-seen (highest-priority) order.
 * @param {Array<*>} items
 * @returns {Array<*>}
 */
function _dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Resolve the reachable address for a connection: `conn.host` tried
 * alongside every `conn.fallbackHosts` entry, in priority order, all probed
 * on TCP port 22 IN PARALLEL with a short timeout, caching the winner per
 * `conn.id` for a short TTL.
 *
 * Zero overhead for the common case (#1531): a connection with no
 * `fallbackHosts` returns immediately with no probing and no cache lookup —
 * existing single-host connections and every test written before this
 * feature pay nothing for it.
 *
 * Never throws, and never reports an address this function could not
 * itself verify as the ONLY option: when nothing answers, it falls back to
 * `conn.host` so the real `ssh` call still runs and reports its own real
 * failure — this resolver's job is routing among reachable candidates, not
 * inventing a diagnosis for a down host.
 *
 * @param {object} conn - Connection record (`host`, `fallbackHosts`, `id`).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Per-candidate probe timeout (default `PROBE_TIMEOUT_MS`).
 * @param {number} [opts.ttlMs] - How long a resolution is trusted before re-probing (default `RESOLUTION_TTL_MS`).
 * @param {(host: string, port: number, timeoutMs: number) => Promise<boolean>} [opts.probePortImpl] - Injected for tests.
 * @returns {Promise<{host: string, fallbackUsed: boolean, candidatesTried: string[]}>}
 */
async function resolveReachableHost(conn, opts = {}) {
  const fallbackHosts = Array.isArray(conn && conn.fallbackHosts) ? conn.fallbackHosts : [];
  if (fallbackHosts.length === 0) {
    return { host: conn.host, fallbackUsed: false, candidatesTried: [conn.host] };
  }

  const candidates = _dedupe([conn.host, ...fallbackHosts]);
  const connId = conn.id;
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : RESOLUTION_TTL_MS;
  if (connId) {
    const cached = _resolved.get(connId);
    if (cached && (Date.now() - cached.resolvedAt) < ttlMs) {
      return { host: cached.activeHost, fallbackUsed: cached.fallbackUsed, candidatesTried: candidates };
    }
  }

  const probe = opts.probePortImpl || _internal.probePort;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  const answers = await Promise.all(candidates.map((host) => probe(host, SSH_PORT, timeoutMs).then((ok) => ({ host, ok }))));
  // `candidates` order IS priority order — pick the first (not the fastest)
  // candidate that answered, so a slower-but-higher-priority address still
  // wins over a faster-but-lower-priority one.
  const winner = candidates.find((host) => answers.some((a) => a.host === host && a.ok));
  const activeHost = winner || conn.host;
  const fallbackUsed = activeHost !== conn.host;

  if (connId) {
    _resolved.set(connId, { activeHost, fallbackUsed, resolvedAt: Date.now() });
  }
  return { host: activeHost, fallbackUsed, candidatesTried: candidates };
}

/**
 * Forget a connection's cached resolution — call after an SSH failure using
 * the resolved host (so the next call re-probes instead of retrying a route
 * that just failed) or after the connection's `host`/`fallbackHosts` change.
 * @param {string} connId
 * @returns {void}
 */
function invalidateResolvedHost(connId) {
  if (connId) _resolved.delete(connId);
}

/**
 * The currently cached route for a connection, for display (#1531 "visible
 * route") and for a synchronous consumer like
 * `lib/sessions.js#_buildLaunchCommand` that cannot await a fresh probe.
 *
 * I-Gate Round 4: honors the same TTL `resolveReachableHost` itself applies
 * — an entry past `RESOLUTION_TTL_MS` is deleted and reported as absent
 * (`null`) rather than handed back stale. Without this, a synchronous
 * caller had no way to tell "this answer is still trustworthy" from "this
 * answer is 10 minutes old and the host may be long gone" — the exact gap
 * that let a stale route disable fallback instead of enabling it.
 * @param {string} connId
 * @returns {{activeHost: string, fallbackUsed: boolean, resolvedAt: number}|null}
 */
function getActiveRoute(connId) {
  if (!connId) return null;
  const cached = _resolved.get(connId);
  if (!cached) return null;
  if (Date.now() - cached.resolvedAt >= RESOLUTION_TTL_MS) {
    _resolved.delete(connId);
    return null;
  }
  return { ...cached };
}

// Overridable for tests.
const _internal = { runShell: _runShell, runFile: _runFile, probePort: _probePort };

/**
 * Run a shell command without blocking (see `_runShell`).
 * @param {string} cmd
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runShell(cmd, opts) {
  return _internal.runShell(cmd, opts);
}

/**
 * Run a program without a shell and without blocking (see `_runFile`).
 * @param {string} file
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFile(file, args, opts) {
  return _internal.runFile(file, args, opts);
}

module.exports = {
  runShell, runFile, _internal, _runShell, _runFile,
  resolveReachableHost, invalidateResolvedHost, getActiveRoute, _resolved
};
