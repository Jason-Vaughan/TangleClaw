'use strict';

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('port-scanner');

let _lastScan = [];
let _scanTimer = null;

/**
 * Parse lsof output into an array of port entries.
 * @param {string} output - Raw lsof -iTCP -sTCP:LISTEN -nP output
 * @returns {{ port: number, pid: number, command: string }[]}
 */
function _parseLsofOutput(output) {
  const results = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Skip header line and empty lines
    if (!line.trim() || line.startsWith('COMMAND')) continue;

    const parts = line.trim().split(/\s+/);
    // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    // NAME looks like: *:3101 or 127.0.0.1:8080
    if (parts.length < 9) continue;

    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    // NAME is the 9th column (index 8), but lsof may append "(LISTEN)" as a separate token
    // Find the token containing a colon and port number
    const name = parts.find((p, i) => i >= 8 && p.includes(':')) || parts[8];
    if (!name) continue;

    // Extract port from NAME field (e.g., "*:3101", "127.0.0.1:8080", "[::1]:3000")
    const portMatch = name.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    if (isNaN(port) || isNaN(pid)) continue;

    // Deduplicate by port (lsof may show multiple entries for same port)
    if (!results.some(r => r.port === port)) {
      results.push({ port, pid, command });
    }
  }

  return results;
}

/**
 * Scan for all TCP ports currently listening on the system.
 * Uses lsof to detect ports bound by any process.
 * @returns {{ port: number, pid: number, command: string }[]}
 */
function scan() {
  try {
    const output = execSync('lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null', {
      timeout: 5000,
      encoding: 'utf8'
    });
    _lastScan = _parseLsofOutput(output);
    log.debug('Port scan complete', { count: _lastScan.length });
    return _lastScan;
  } catch (err) {
    // lsof returns exit code 1 when no listening ports found, or may fail
    if (err.stdout) {
      _lastScan = _parseLsofOutput(err.stdout);
      return _lastScan;
    }
    log.warn('Port scan failed, returning empty results', { error: err.message });
    _lastScan = [];
    return _lastScan;
  }
}

/**
 * Get the cached results from the last scan.
 * @returns {{ port: number, pid: number, command: string }[]}
 */
function getSystemPorts() {
  return _lastScan;
}

/**
 * Check if a specific port is detected as in use by the system scanner.
 * @param {number} port - Port number to check
 * @returns {{ inUse: boolean, process: string|null, pid: number|null }}
 */
function isPortInUseBySystem(port) {
  const entry = _lastScan.find(e => e.port === port);
  if (entry) {
    return { inUse: true, process: entry.command, pid: entry.pid };
  }
  return { inUse: false, process: null, pid: null };
}

/**
 * Start periodic port scanning.
 * @param {number} [intervalMs=60000] - Scan interval in milliseconds
 */
function startScanner(intervalMs = 60000) {
  if (_scanTimer) return;

  // Run an initial scan
  scan();

  _scanTimer = setInterval(() => {
    scan();
  }, intervalMs);

  // Allow the timer to not keep the process alive
  if (_scanTimer.unref) _scanTimer.unref();

  log.info('Port scanner started', { intervalMs });
}

/**
 * Stop periodic port scanning.
 */
function stopScanner() {
  if (_scanTimer) {
    clearInterval(_scanTimer);
    _scanTimer = null;
    log.info('Port scanner stopped');
  }
}

/**
 * Reset internal state (for testing).
 */
function _reset() {
  _lastScan = [];
  stopScanner();
}

module.exports = {
  scan,
  getSystemPorts,
  isPortInUseBySystem,
  startScanner,
  stopScanner,
  _parseLsofOutput,
  _reset
};
