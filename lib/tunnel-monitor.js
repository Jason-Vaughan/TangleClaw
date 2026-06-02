'use strict';

// #294 — periodic OpenClaw tunnel liveness check + auto-recreate.
//
// An `ssh -f -N -L` tunnel can die on its own (transport drop under
// ExitOnForwardFailure, or the remote gateway container being restarted) while
// the operator isn't looking, and nothing rebuilds it — so the connection
// reads dead until someone manually re-launches it (the "tunnel doesn't
// persist" complaint). This monitor walks the tunnels TC has established this
// process lifetime, end-to-end probes each (#288 `httpRoundTrip`), and rebuilds
// any that died via `ensureTunnel({force:true})` — which re-resolves the
// connection config and re-picks the right forward target (#291). Per-connection
// exponential backoff keeps a genuinely-down gateway from hot-looping.
//
// Scope: only tunnels currently TRACKED as `oc-direct-<connId>` (i.e. ones the
// operator opened) are monitored — we never auto-establish a tunnel nobody
// asked for. A dead tunnel stays tracked (nothing prunes the map on ssh exit),
// so it remains visible to the monitor and gets rebuilt. On server restart the
// in-memory tracking resets; the operator's next open re-tracks it.

const tunnel = require('./tunnel');
const { createLogger } = require('./logger');

const log = createLogger('tunnel-monitor');

const DEFAULT_INTERVAL_MS = 45 * 1000;
const BASE_BACKOFF_MS = 45 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const KEY_PREFIX = 'oc-direct-';
// Require N consecutive failed probes before recreating, so a single transient
// probe timeout doesn't tear down an otherwise-healthy tunnel (which would
// briefly drop the port under an open Web UI — the symptom we're fixing).
const FAILURES_BEFORE_RECREATE = 2;

const _backoff = new Map(); // connId -> { failures, nextAttemptAt }
const _misses = new Map(); // connId -> consecutive failed probes (debounce)
let _timer = null;
let _ticking = false; // in-flight guard: ensure ticks never overlap

/**
 * Extract a connection id from a tunnel tracking key, or null if it isn't an
 * operator-opened OpenClaw connection tunnel.
 * @param {string} key
 * @returns {string|null}
 */
function _connIdFromKey(key) {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null;
}

/**
 * Whether a connection is eligible for a recreate attempt right now (not inside
 * its backoff window).
 * @param {string} connId
 * @param {number} now - epoch ms
 * @returns {boolean}
 */
function _eligible(connId, now) {
  const bo = _backoff.get(connId);
  return !bo || bo.nextAttemptAt <= now;
}

/**
 * Check one connection's tunnel and recreate it if dead. Pure of timers —
 * `now` is injected so tests are deterministic.
 * @param {object} conn - OpenClaw connection record
 * @param {number} now - epoch ms
 * @returns {Promise<{outcome:string, error?:string}>}
 */
async function _checkOne(conn, now) {
  if (!conn || !conn.localPort) return { outcome: 'skip:no-conn' };
  if (!_eligible(conn.id, now)) return { outcome: 'skip:backoff' };

  const alive = await _internal.roundTrip(conn.localPort);
  if (alive) {
    _backoff.delete(conn.id); // healthy → clear any backoff
    _misses.delete(conn.id);
    return { outcome: 'healthy' };
  }

  // Debounce (#294 review): require N consecutive failed probes before tearing
  // down, so a lone transient probe timeout doesn't rebuild a healthy tunnel.
  const misses = (_misses.get(conn.id) || 0) + 1;
  if (misses < FAILURES_BEFORE_RECREATE) {
    _misses.set(conn.id, misses);
    return { outcome: 'probing', misses };
  }
  _misses.delete(conn.id); // confirmed dead — backoff governs retries from here

  log.warn('Tunnel down — auto-recreating', { connId: conn.id, localPort: conn.localPort });
  const extraForwards = conn.bridgePort
    ? [{ localPort: conn.bridgePort, remotePort: conn.bridgePort }]
    : [];
  let res;
  try {
    res = await _internal.ensure(`${KEY_PREFIX}${conn.id}`, {
      host: conn.host,
      port: conn.port,
      localPort: conn.localPort,
      sshUser: conn.sshUser,
      sshKeyPath: conn.sshKeyPath,
      force: true,
      extraForwards
    });
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  if (res && res.ok) {
    _backoff.delete(conn.id);
    log.info('Tunnel auto-recreated', { connId: conn.id, localPort: conn.localPort, forwardTarget: res.forwardTarget });
    return { outcome: 'recreated' };
  }

  // Failed — back off so a truly-down gateway doesn't hot-loop.
  const failures = (_backoff.get(conn.id)?.failures || 0) + 1;
  const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  _backoff.set(conn.id, { failures, nextAttemptAt: now + delay });
  log.warn('Tunnel recreate failed — backing off', { connId: conn.id, failures, delayMs: delay, error: res && res.error });
  return { outcome: 'failed', error: res && res.error };
}

/**
 * One monitor pass over all tracked oc-direct tunnels.
 * @param {number} now - epoch ms (injected for tests)
 * @returns {Promise<object[]>} per-connection results
 */
async function tick(now) {
  // In-flight guard (#294 review): ticks must never overlap. A recreate's ssh
  // spawn can outlast the interval, and two concurrent ticks would both see a
  // not-yet-backed-off connId eligible and race a teardown/rebuild of the same
  // local port. A second tick while one runs is a no-op.
  if (_ticking) return [];
  _ticking = true;
  const results = [];
  try {
    let tracked;
    try {
      tracked = _internal.listTunnels();
    } catch (err) {
      log.warn('tunnel-monitor tick: listTunnels failed', { error: err.message });
      return results;
    }
    for (const t of tracked) {
      const connId = _connIdFromKey(t && t.projectName);
      if (!connId) continue;
      const conn = _internal.getConn(connId);
      if (!conn) continue;
      try {
        results.push({ connId, ...(await _checkOne(conn, now)) });
      } catch (err) {
        log.warn('tunnel-monitor: check threw', { connId, error: err.message });
      }
    }
    return results;
  } finally {
    _ticking = false;
  }
}

/**
 * Start the periodic monitor. Idempotent. The timer is unref'd so it never
 * keeps the process alive on its own.
 * @param {number} [intervalMs]
 */
function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return;
  _timer = setInterval(() => { tick(Date.now()).catch(() => {}); }, intervalMs);
  if (_timer.unref) _timer.unref();
  log.info('tunnel-monitor started', { intervalMs });
}

/**
 * Stop the monitor and clear backoff state.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _backoff.clear();
  _misses.clear();
}

// Injectable seam for tests.
const _internal = {
  roundTrip: (port) => tunnel.httpRoundTrip(port),
  ensure: (name, cfg) => tunnel.ensureTunnel(name, cfg),
  listTunnels: () => tunnel.listTunnels(),
  getConn: (id) => require('./store').openclawConnections.get(id)
};

module.exports = { start, stop, tick, _checkOne, _connIdFromKey, _eligible, _backoff, _misses, _internal,
  DEFAULT_INTERVAL_MS, BASE_BACKOFF_MS, MAX_BACKOFF_MS, FAILURES_BEFORE_RECREATE };
