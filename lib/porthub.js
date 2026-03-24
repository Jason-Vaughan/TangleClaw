'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');
const portScanner = require('./port-scanner');

const log = createLogger('porthub');

let _expirationTimer = null;

/**
 * Register (lease) a port for a project.
 * @param {number} port - Port number
 * @param {string} projectName - Project name
 * @param {string} service - Service description
 * @param {object} [options]
 * @param {string} [options.host] - Host identifier (default 'localhost')
 * @param {boolean} [options.permanent] - Whether the lease is permanent (default true)
 * @param {number} [options.ttlMs] - TTL in milliseconds (for non-permanent leases)
 * @param {string} [options.description] - Description
 * @returns {{ success: boolean, error: string|null }}
 */
function registerPort(port, projectName, service, options = {}) {
  const host = options.host || 'localhost';
  try {
    // Warn if scanner detects this port is already in use by a system process (localhost only)
    if (host === 'localhost') {
      const systemCheck = portScanner.isPortInUseBySystem(port);
      if (systemCheck.inUse) {
        log.warn('Port is in use by system process, registering anyway', {
          host, port, project: projectName, process: systemCheck.process, pid: systemCheck.pid
        });
      }
    }

    const permanent = options.permanent !== false;
    store.portLeases.lease({
      host,
      port,
      project: projectName,
      service,
      permanent,
      ttlMs: options.ttlMs || null,
      description: options.description || null
    });
    log.info('Port registered', { host, port, project: projectName, service });
    return { success: true, error: null };
  } catch (err) {
    log.warn('Port registration failed', { host, port, project: projectName, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Release a port.
 * @param {number} port - Port number
 * @param {string} [host='localhost'] - Host identifier
 * @returns {{ success: boolean, error: string|null }}
 */
function releasePort(port, host = 'localhost') {
  try {
    store.portLeases.release(port, host);
    log.info('Port released', { host, port });
    return { success: true, error: null };
  } catch (err) {
    log.warn('Port release failed', { host, port, error: err.message });
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
 * @param {string} [host='localhost'] - Host identifier
 * @returns {{ available: boolean, leasedBy: string|null }}
 */
function checkPort(port, host = 'localhost') {
  try {
    const conflict = store.portLeases.checkConflict(port, host);
    if (conflict) {
      return { available: false, leasedBy: conflict.project, systemDetected: false };
    }

    // Check if the port is in use by a system process (localhost only)
    if (host === 'localhost') {
      const systemCheck = portScanner.isPortInUseBySystem(port);
      if (systemCheck.inUse) {
        return { available: false, leasedBy: null, systemDetected: true, process: systemCheck.process };
      }
    }

    return { available: true, leasedBy: null, systemDetected: false };
  } catch {
    return { available: true, leasedBy: null, systemDetected: false };
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

  // Register TangleClaw infra ports (use directory name to match registered project)
  const selfName = path.basename(path.resolve(__dirname, '..'));
  registerPort(config.ttydPort, selfName, 'ttyd', { permanent: true });
  registerPort(config.serverPort, selfName, 'server', { permanent: true });

  // Sync from old PortHub daemon on every boot.
  // _migrateFromOldPorthub skips ports already in our database,
  // so this is safe to run repeatedly.
  _migrateFromOldPorthub();

  // Clean up orphan leases — permanent leases for projects that are neither
  // registered in SQLite nor present as directories in projectsDir.
  _cleanupOrphanLeases();

  // Start periodic port scanning (respects config)
  const fullConfig = store.config.load();
  if (fullConfig.portScannerEnabled !== false) {
    portScanner.startScanner(fullConfig.portScannerIntervalMs || 60000);
  } else {
    log.info('Port scanner disabled by config');
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
  portScanner.stopScanner();
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

    // porthub CLI outputs ASCII art banner before the JSON.
    // Extract the JSON array by finding the first '[' character.
    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) {
      log.debug('No JSON array found in porthub output');
      return;
    }

    const data = JSON.parse(output.slice(jsonStart));
    // porthub returns a raw array of lease objects, not wrapped in { leases: [...] }
    const leases = Array.isArray(data) ? data : (data.leases || data.ports || []);
    let imported = 0;

    for (const lease of leases) {
      if (!lease.port) continue;
      // Skip expired leases
      if (lease.status === 'expired') continue;
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

/**
 * Clean up permanent port leases that reference projects which are neither
 * registered in SQLite nor present as directories in projectsDir.
 * These are ghost entries — typically from old PortHub imports for archived
 * or deleted projects whose directories no longer exist.
 */
function _cleanupOrphanLeases() {
  const fs = require('node:fs');
  const config = store.config.load();
  const projectsDir = config.projectsDir
    ? (config.projectsDir.startsWith('~')
      ? path.join(process.env.HOME || '', config.projectsDir.slice(1))
      : path.resolve(config.projectsDir))
    : null;

  if (!projectsDir) return;

  const allLeases = store.portLeases.list();
  const registeredProjects = new Set(store.projects.list().map(p => p.name));

  // Also include TangleClaw's own self-name (infra ports)
  const selfName = path.basename(path.resolve(__dirname, '..'));
  registeredProjects.add(selfName);

  // Include OpenClaw connection tunnel identifiers (tunnels register under oc-direct-<id>)
  try {
    const openclawConns = store.openclawConnections.list();
    for (const conn of openclawConns) {
      registeredProjects.add(`oc-direct-${conn.id}`);
    }
  } catch {
    // openclawConnections may not exist in older schemas — ignore
  }

  const orphanProjects = new Set();
  for (const lease of allLeases) {
    if (registeredProjects.has(lease.project)) continue;
    // Check if directory exists
    const projPath = path.join(projectsDir, lease.project);
    if (fs.existsSync(projPath)) continue;
    orphanProjects.add(lease.project);
  }

  for (const project of orphanProjects) {
    const released = store.portLeases.releaseByProject(project);
    log.info('Cleaned up orphan port leases', { project, count: released });
  }
}

/**
 * Manually trigger a sync from the old PortHub daemon.
 * Imports any leases not already in our database.
 * @returns {{ imported: number }}
 */
function syncFromDaemon() {
  const before = store.portLeases.list().length;
  _migrateFromOldPorthub();
  const after = store.portLeases.list().length;
  return { imported: after - before };
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
  stopExpirationTimer,
  syncFromDaemon
};
