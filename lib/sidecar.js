'use strict';

const { createLogger } = require('./logger');
const store = require('./store');
const tunnel = require('./tunnel');

const log = createLogger('sidecar');

// Cached process state per connection: connectionId → { processes, lastPollAt, error, stale }
const _cache = new Map();

// Active polling intervals: connectionId → intervalId
const _pollers = new Map();

// Default polling interval
const DEFAULT_POLL_INTERVAL_MS = 10000;

// How long to retain cache before marking stale (3x poll interval)
const STALE_THRESHOLD_MS = 30000;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { 'Accept': 'application/json' };
    const token = conn.bridgeToken || conn.gatewayToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errorMsg = `HTTP ${res.status}`;
      _cache.set(connectionId, {
        ..._cache.get(connectionId),
        error: errorMsg,
        lastPollAt: new Date().toISOString(),
        stale: true
      });
      return { ok: false, data: null, error: errorMsg };
    }

    const body = await res.json();
    const cacheEntry = {
      processes: body,
      lastPollAt: new Date().toISOString(),
      error: null,
      stale: false
    };
    _cache.set(connectionId, cacheEntry);

    return { ok: true, data: body, error: null };
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'timeout' : err.message;
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

  // Initial poll
  pollProcesses(connectionId).catch(err => {
    log.debug('Initial sidecar poll failed', { connectionId, error: err.message });
  });

  const id = setInterval(() => {
    pollProcesses(connectionId).catch(err => {
      log.debug('Sidecar poll failed', { connectionId, error: err.message });
    });
  }, intervalMs);

  _pollers.set(connectionId, id);
}

/**
 * Stop polling for a connection.
 * @param {string} connectionId - OpenClaw connection ID
 */
function stopPolling(connectionId) {
  const id = _pollers.get(connectionId);
  if (id) {
    clearInterval(id);
    _pollers.delete(connectionId);
    log.info('Stopped sidecar polling', { connectionId });
  }
}

/**
 * Stop all polling.
 */
function stopAllPolling() {
  for (const [connectionId, id] of _pollers) {
    clearInterval(id);
    log.info('Stopped sidecar polling', { connectionId });
  }
  _pollers.clear();
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
