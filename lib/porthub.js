'use strict';

const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('porthub');

let _expirationTimer = null;

/**
 * Register (lease) a port for a project.
 * @param {number} port - Port number
 * @param {string} projectName - Project name
 * @param {string} service - Service description
 * @param {object} [options]
 * @param {boolean} [options.permanent] - Whether the lease is permanent (default true)
 * @param {number} [options.ttlMs] - TTL in milliseconds (for non-permanent leases)
 * @param {string} [options.description] - Description
 * @returns {{ success: boolean, error: string|null }}
 */
function registerPort(port, projectName, service, options = {}) {
  try {
    const permanent = options.permanent !== false;
    store.portLeases.lease({
      port,
      project: projectName,
      service,
      permanent,
      ttlMs: options.ttlMs || null,
      description: options.description || null
    });
    log.info('Port registered', { port, project: projectName, service });
    return { success: true, error: null };
  } catch (err) {
    log.warn('Port registration failed', { port, project: projectName, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Release a port.
 * @param {number} port - Port number
 * @returns {{ success: boolean, error: string|null }}
 */
function releasePort(port) {
  try {
    store.portLeases.release(port);
    log.info('Port released', { port });
    return { success: true, error: null };
  } catch (err) {
    log.warn('Port release failed', { port, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Register multiple ports for a project.
 * @param {object} ports - Map of service name to port number { "dev": 8080, "api": 8081 }
 * @param {string} projectName - Project name
 * @returns {{ registered: object, errors: string[] }}
 */
function registerPorts(ports, projectName) {
  const registered = {};
  const errors = [];

  for (const [service, port] of Object.entries(ports)) {
    const result = registerPort(port, projectName, service);
    if (result.success) {
      registered[service] = port;
    } else {
      errors.push(`Port ${port} (${service}): ${result.error}`);
    }
  }

  return { registered, errors };
}

/**
 * Release multiple ports.
 * @param {object} ports - Map of service name to port number
 * @returns {{ released: number[], errors: string[] }}
 */
function releasePorts(ports) {
  const released = [];
  const errors = [];

  for (const [service, port] of Object.entries(ports)) {
    const result = releasePort(port);
    if (result.success) {
      released.push(port);
    } else {
      errors.push(`Port ${port} (${service}): ${result.error}`);
    }
  }

  return { released, errors };
}

/**
 * Check if a port is available (not leased by another project).
 * @param {number} port - Port number
 * @returns {{ available: boolean, leasedBy: string|null }}
 */
function checkPort(port) {
  try {
    const conflict = store.portLeases.checkConflict(port);
    if (conflict) {
      return { available: false, leasedBy: conflict.project };
    }
    return { available: true, leasedBy: null };
  } catch {
    return { available: true, leasedBy: null };
  }
}

/**
 * Get all port leases.
 * @param {object} [options] - Filter options
 * @returns {object[]}
 */
function getLeases(options) {
  return store.portLeases.list(options);
}

/**
 * Get all port leases for a project.
 * @param {string} project - Project name
 * @returns {object[]}
 */
function getLeasesForProject(project) {
  return store.portLeases.getByProject(project);
}

/**
 * Bootstrap port management: register TangleClaw infrastructure ports
 * and attempt one-time migration from old PortHub daemon.
 * @param {object} config
 * @param {number} config.ttydPort
 * @param {number} config.serverPort
 */
function bootstrap(config) {
  log.info('PortHub bootstrap starting');

  // Register TangleClaw infra ports
  registerPort(config.ttydPort, 'TangleClaw', 'ttyd', { permanent: true });
  registerPort(config.serverPort, 'TangleClaw', 'server', { permanent: true });

  // One-time migration from old PortHub daemon
  const existing = store.portLeases.list();
  const infraOnly = existing.every(l => l.project === 'TangleClaw');
  if (existing.length <= 2 && infraOnly) {
    _migrateFromOldPorthub();
  }

  log.info('PortHub bootstrap complete', { leases: store.portLeases.list().length });
}

/**
 * Shutdown port management: release TangleClaw infrastructure ports.
 * @param {object} config
 * @param {number} config.ttydPort
 * @param {number} config.serverPort
 */
function shutdown(config) {
  log.info('PortHub shutdown');
  releasePort(config.ttydPort);
  releasePort(config.serverPort);
  stopExpirationTimer();
}

/**
 * Start periodic expiration of stale leases (every 60s).
 */
function startExpirationTimer() {
  if (_expirationTimer) return;
  _expirationTimer = setInterval(() => {
    try {
      const expired = store.portLeases.expireStale();
      if (expired > 0) {
        log.info('Expired stale leases', { count: expired });
      }
    } catch (err) {
      log.warn('Expiration timer error', { error: err.message });
    }
  }, 60000);
  // Allow the timer to not keep the process alive
  if (_expirationTimer.unref) _expirationTimer.unref();
}

/**
 * Stop the expiration timer.
 */
function stopExpirationTimer() {
  if (_expirationTimer) {
    clearInterval(_expirationTimer);
    _expirationTimer = null;
  }
}

/**
 * Attempt to import leases from the old PortHub daemon.
 * Best-effort: if porthub CLI is not available, skip silently.
 */
function _migrateFromOldPorthub() {
  try {
    execSync('which porthub 2>/dev/null', { timeout: 2000, encoding: 'utf8' });
  } catch {
    log.debug('Old PortHub CLI not available, skipping migration');
    return;
  }

  try {
    const output = execSync('porthub status --json 2>/dev/null', {
      timeout: 5000,
      encoding: 'utf8'
    });

    const data = JSON.parse(output);
    const leases = data.leases || data.ports || [];
    let imported = 0;

    for (const lease of leases) {
      if (!lease.port) continue;
      // Skip if we already have this port registered
      if (store.portLeases.get(lease.port)) continue;

      store.portLeases.lease({
        port: lease.port,
        project: lease.project || 'unknown',
        service: lease.service || 'imported',
        permanent: lease.permanent !== false,
        description: 'Imported from PortHub daemon'
      });
      imported++;
    }

    if (imported > 0) {
      log.info('Migrated leases from old PortHub', { count: imported });
    }
  } catch (err) {
    log.debug('Could not migrate from old PortHub', { error: err.message });
  }
}

module.exports = {
  registerPort,
  releasePort,
  registerPorts,
  releasePorts,
  checkPort,
  getLeases,
  getLeasesForProject,
  bootstrap,
  shutdown,
  startExpirationTimer,
  stopExpirationTimer
};
