'use strict';

const http = require('node:http');
const { createLogger } = require('./logger');
const store = require('./store');
const tunnel = require('./tunnel');

const log = createLogger('sidecar');

// Cached process state per connection: connectionId → { processes, lastPollAt, error, stale }
const _cache = new Map();

// Active poll timers: connectionId → timeoutId
const _pollers = new Map();

// Consecutive failure count per connection, for backoff: connectionId → number
const _failures = new Map();

// Default polling interval
const DEFAULT_POLL_INTERVAL_MS = 10000;

// How long to retain cache before marking stale (3x poll interval)
const STALE_THRESHOLD_MS = 30000;

// Backoff ceiling. A gateway that has been unreachable for a while is polled at
// this rate rather than the base interval — see `_backoffMs`.
const MAX_POLL_INTERVAL_MS = 300000;

/**
 * Shared keep-alive agent for every sidecar poll.
 *
 * Polls are a fixed low-rate request to the same handful of origins forever, so
 * a pooled connection is reused across ticks instead of a fresh TCP connect each
 * time. Without this the poller left one socket in TIME_WAIT per poll: an aborted
 * request destroys its socket, and against a slow or unreachable gateway EVERY
 * poll aborts. On a host whose kernel had stopped reaping TIME_WAIT that churn
 * competes for the ephemeral port range.
 *
 * `maxSockets: 1` per origin is deliberate — polls for one connection are serial,
 * so a second socket would only ever be a duplicate of the one already pooled.
 */
const _agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 1,
  maxFreeSockets: 1
});

/**
 * Effective poll delay for a connection, grown from the base interval by its
 * consecutive-failure count and capped at `MAX_POLL_INTERVAL_MS`.
 *
 * Doubling rather than a fixed retry rate is the point: a gateway that is down
 * stays down for minutes at a time, and re-dialling it every 10s produces one
 * dead socket per tick while learning nothing a slower probe would not.
 *
 * @param {string} connectionId - OpenClaw connection ID
 * @param {number} baseMs - The connection's configured interval
 * @returns {number} Delay in ms before the next poll
 */
function _backoffMs(connectionId, baseMs) {
  const failures = _failures.get(connectionId) || 0;
  if (failures === 0) return baseMs;
  const grown = baseMs * Math.pow(2, Math.min(failures, 10));
  return Math.min(grown, MAX_POLL_INTERVAL_MS);
}

/**
 * Issue one keep-alive GET and resolve its status and body text.
 *
 * Uses `node:http` rather than `fetch` because this project ships no npm
 * dependencies, and Node exposes no way to attach a custom connection pool to
 * global `fetch` without undici. A timeout destroys only its own request; the
 * agent's pool survives for the next tick.
 *
 * @param {string} url - Absolute http:// URL to GET
 * @param {object} headers - Request headers
 * @param {number} timeoutMs - Milliseconds before the request is aborted
 * @returns {Promise<{ status: number, body: string }>}
 */
function _getWithAgent(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: _agent, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    });
    req.on('error', reject);
  });
}

/**
 * Poll OpenClaw's /api/processes endpoint for a given connection.
 * @param {string} connectionId - OpenClaw connection ID
 * @param {object} [options] - Options
 * @param {number} [options.timeoutMs=5000] - Request timeout
 * @returns {Promise<{ ok: boolean, data: object|null, error: string|null }>}
 */
async function pollProcesses(connectionId, options = {}) {
  const conn = store.openclawConnections.get(connectionId);
  if (!conn) {
    return { ok: false, data: null, error: `Connection ${connectionId} not found` };
  }

  const timeoutMs = options.timeoutMs || 5000;
  const pollPort = conn.bridgePort || conn.localPort;
  const url = `http://127.0.0.1:${pollPort}/api/processes`;

  try {
    const headers = { 'Accept': 'application/json' };
    const token = conn.bridgeToken || conn.gatewayToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await _getWithAgent(url, headers, timeoutMs);

    if (res.status < 200 || res.status >= 300) {
      const errorMsg = `HTTP ${res.status}`;
      _failures.set(connectionId, (_failures.get(connectionId) || 0) + 1);
      _cache.set(connectionId, {
        ..._cache.get(connectionId),
        error: errorMsg,
        lastPollAt: new Date().toISOString(),
        stale: true
      });
      return { ok: false, data: null, error: errorMsg };
    }

    const body = JSON.parse(res.body);
    const cacheEntry = {
      processes: body,
      lastPollAt: new Date().toISOString(),
      error: null,
      stale: false
    };
    _cache.set(connectionId, cacheEntry);
    _failures.delete(connectionId);

    return { ok: true, data: body, error: null };
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'timeout' : err.message;
    _failures.set(connectionId, (_failures.get(connectionId) || 0) + 1);
    // Keep stale cache if we had one
    const existing = _cache.get(connectionId);
    _cache.set(connectionId, {
      processes: existing ? existing.processes : null,
      lastPollAt: new Date().toISOString(),
      error: errorMsg,
      stale: true
    });
    return { ok: false, data: null, error: errorMsg };
  }
}

/**
 * Get cached process state for a connection.
 * @param {string} connectionId - OpenClaw connection ID
 * @returns {{ processes: object|null, lastPollAt: string|null, error: string|null, stale: boolean }}
 */
function getProcesses(connectionId) {
  const entry = _cache.get(connectionId);
  if (!entry) {
    return { processes: null, lastPollAt: null, error: null, stale: false };
  }

  // Mark stale if last poll was too long ago
  if (entry.lastPollAt) {
    const age = Date.now() - new Date(entry.lastPollAt).getTime();
    if (age > STALE_THRESHOLD_MS) {
      entry.stale = true;
    }
  }

  return entry;
}

/**
 * Start polling for a connection.
 * @param {string} connectionId - OpenClaw connection ID
 * @param {number} [intervalMs] - Polling interval in milliseconds
 */
function startPolling(connectionId, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
  if (_pollers.has(connectionId)) {
    log.debug('Polling already active', { connectionId });
    return;
  }

  log.info('Starting sidecar polling', { connectionId, intervalMs });

  // Self-rescheduling rather than setInterval: the delay is recomputed after
  // every poll so a failing gateway can be backed off instead of re-dialled on
  // a fixed cadence. Scheduling the NEXT tick only after the current one settles
  // also stops slow polls from overlapping.
  const scheduleNext = () => {
    if (!_pollers.has(connectionId)) return; // stopped while a poll was in flight
    const delay = _backoffMs(connectionId, intervalMs);
    const next = setTimeout(tick, delay);
    if (typeof next.unref === 'function') next.unref();
    _pollers.set(connectionId, next);
  };

  const tick = () => {
    pollProcesses(connectionId)
      .catch(err => {
        log.debug('Sidecar poll failed', { connectionId, error: err.message });
      })
      .finally(scheduleNext);
  };

  // Mark the poller active before the first poll so a stopPolling() racing the
  // initial request is still seen by scheduleNext.
  _pollers.set(connectionId, null);
  tick();
}

/**
 * Stop polling for a connection.
 * @param {string} connectionId - OpenClaw connection ID
 */
function stopPolling(connectionId) {
  // Cleared unconditionally, not just when a poller existed: `pollProcesses` is
  // also called directly by the route layer, so a failure count can accumulate
  // with no poller attached. Leaving it would make the NEXT startPolling inherit
  // it and open already backed off to minutes.
  _failures.delete(connectionId);
  if (_pollers.has(connectionId)) {
    clearTimeout(_pollers.get(connectionId));
    _pollers.delete(connectionId);
    log.info('Stopped sidecar polling', { connectionId });
  }
}

/**
 * Stop all polling.
 */
function stopAllPolling() {
  for (const [connectionId, id] of _pollers) {
    clearTimeout(id);
    log.info('Stopped sidecar polling', { connectionId });
  }
  _pollers.clear();
  _failures.clear();
}

/**
 * Resolve a project name to its OpenClaw connection ID.
 * @param {string} projectName - Project name
 * @returns {string|null} - Connection ID or null
 */
function resolveConnectionId(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;
  const engineId = project.engineId;
  if (!engineId || !engineId.startsWith('openclaw:')) return null;
  return engineId.split(':')[1];
}

/**
 * Get process state for a project (resolves project → connection → cached state).
 * @param {string} projectName - Project name
 * @returns {{ processes: object|null, lastPollAt: string|null, error: string|null, stale: boolean, connectionId: string|null }}
 */
function getProcessesForProject(projectName) {
  const connectionId = resolveConnectionId(projectName);
  if (!connectionId) {
    return { processes: null, lastPollAt: null, error: null, stale: false, connectionId: null };
  }

  const state = getProcesses(connectionId);
  return { ...state, connectionId };
}

/**
 * Ensure polling is active for all OpenClaw connections that have active sessions.
 * Call this on server startup and when sessions change.
 */
function syncPolling() {
  try {
    const connections = store.openclawConnections.list();
    const projects = store.projects.list();
    const activeTunnels = tunnel.listTunnels();

    for (const conn of connections) {
      const engineId = `openclaw:${conn.id}`;
      // Check if any project using this connection has an active session
      const connProjects = projects.filter(p => p.engineId === engineId);
      const hasActiveSession = connProjects.some(p => {
        const session = store.sessions.getActive(p.id);
        return session !== null;
      });

      // Check if a direct-connect tunnel is active for this connection
      const hasActiveTunnel = activeTunnels.some(t => t.projectName === `oc-direct-${conn.id}`);

      const shouldPoll = hasActiveSession || hasActiveTunnel;

      if (shouldPoll && !_pollers.has(conn.id)) {
        startPolling(conn.id);
      } else if (!shouldPoll && _pollers.has(conn.id)) {
        stopPolling(conn.id);
      }
    }
  } catch (err) {
    log.debug('syncPolling failed', { error: err.message });
  }
}

/**
 * Get process state directly by connection ID (no project resolution).
 * Returns the cached state with active/recent arrays flattened for the API response.
 * @param {string} connId - OpenClaw connection ID
 * @returns {{ active: object[], recent: object[], lastPollAt: string|null, stale: boolean, error: string|null }}
 */
function getProcessesByConnection(connId) {
  const conn = store.openclawConnections.get(connId);
  if (!conn) {
    return { active: [], recent: [], lastPollAt: null, stale: false, error: 'Connection not found' };
  }

  const state = getProcesses(connId);
  if (!state.processes) {
    return { active: [], recent: [], lastPollAt: state.lastPollAt, stale: state.stale, error: state.error };
  }

  return {
    active: state.processes.active || [],
    recent: state.processes.recent || [],
    lastPollAt: state.lastPollAt,
    stale: state.stale,
    error: state.error
  };
}

module.exports = {
  pollProcesses,
  getProcesses,
  startPolling,
  stopPolling,
  stopAllPolling,
  MAX_POLL_INTERVAL_MS,
  _backoffMs,
  _failures,
  _agent,
  resolveConnectionId,
  getProcessesForProject,
  getProcessesByConnection,
  syncPolling,
  // Exposed for testing
  _cache,
  _pollers,
  DEFAULT_POLL_INTERVAL_MS,
  STALE_THRESHOLD_MS
};
