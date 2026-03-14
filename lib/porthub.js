'use strict';

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('porthub');

const DEFAULT_TIMEOUT = 5000;

/**
 * Check if the PortHub CLI is available.
 * @returns {boolean}
 */
function isAvailable() {
  try {
    execSync('which porthub 2>/dev/null', { timeout: 2000, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the PortHub daemon is running.
 * @returns {boolean}
 */
function isDaemonRunning() {
  try {
    const output = execSync('porthub status 2>/dev/null', {
      timeout: DEFAULT_TIMEOUT,
      encoding: 'utf8'
    });
    return !output.includes('not running') && !output.includes('error');
  } catch {
    return false;
  }
}

/**
 * Register (lease) a port with PortHub for a project.
 * @param {number} port - Port number to register
 * @param {string} projectName - Project name
 * @param {string} service - Service description
 * @param {object} [options]
 * @param {boolean} [options.permanent] - Whether the lease is permanent (default true)
 * @returns {{ success: boolean, error: string|null }}
 */
function registerPort(port, projectName, service, options = {}) {
  if (!isAvailable()) {
    log.warn('PortHub not available, skipping port registration', { port, project: projectName });
    return { success: false, error: 'PortHub CLI not available' };
  }

  const permanent = options.permanent !== false;

  try {
    let cmd = `porthub lease ${port} --project "${_escapeArg(projectName)}" --service "${_escapeArg(service)}"`;
    if (permanent) {
      cmd += ' --permanent';
    }

    execSync(cmd, { timeout: DEFAULT_TIMEOUT, encoding: 'utf8', stdio: 'pipe' });
    log.info('Port registered with PortHub', { port, project: projectName, service });
    return { success: true, error: null };
  } catch (err) {
    const message = _extractError(err);
    log.warn('PortHub port registration failed', { port, project: projectName, error: message });
    return { success: false, error: message };
  }
}

/**
 * Release a port from PortHub.
 * @param {number} port - Port number to release
 * @returns {{ success: boolean, error: string|null }}
 */
function releasePort(port) {
  if (!isAvailable()) {
    log.warn('PortHub not available, skipping port release', { port });
    return { success: false, error: 'PortHub CLI not available' };
  }

  try {
    execSync(`porthub release ${port}`, {
      timeout: DEFAULT_TIMEOUT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    log.info('Port released from PortHub', { port });
    return { success: true, error: null };
  } catch (err) {
    const message = _extractError(err);
    log.warn('PortHub port release failed', { port, error: message });
    return { success: false, error: message };
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
 * @param {number} port - Port number to check
 * @returns {{ available: boolean, leasedBy: string|null }}
 */
function checkPort(port) {
  if (!isAvailable()) {
    return { available: true, leasedBy: null }; // Assume available when PortHub unavailable
  }

  try {
    const output = execSync('porthub status 2>/dev/null', {
      timeout: DEFAULT_TIMEOUT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    // Parse status output for this port — look for port number in lease listings
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes(String(port))) {
        // Try to extract project name from the line
        const projectMatch = line.match(/project[:\s]+["']?([^"'\s,]+)/i);
        return { available: false, leasedBy: projectMatch ? projectMatch[1] : 'unknown' };
      }
    }
    return { available: true, leasedBy: null };
  } catch {
    return { available: true, leasedBy: null };
  }
}

/**
 * Escape a string for use in a shell command argument.
 * @param {string} str - String to escape
 * @returns {string}
 */
function _escapeArg(str) {
  return String(str).replace(/[\\"`$]/g, '\\$&');
}

/**
 * Extract error message from a child_process error.
 * @param {Error} err - Error from execSync
 * @returns {string}
 */
function _extractError(err) {
  if (err.stderr) {
    const stderr = err.stderr.toString().trim();
    if (stderr) return stderr;
  }
  if (err.stdout) {
    const stdout = err.stdout.toString().trim();
    if (stdout) return stdout;
  }
  return err.message || 'Unknown error';
}

module.exports = {
  isAvailable,
  isDaemonRunning,
  registerPort,
  releasePort,
  registerPorts,
  releasePorts,
  checkPort
};
