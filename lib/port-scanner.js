'use strict';

const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('port-scanner');

let _lastScan = [];
let _scanTimer = null;
// The command runner, swappable so tests can answer for lsof without a real
// listener (`_setExec`). Production always uses execSync.
let _exec = execSync;
// The platform the socket-table fallback branches on, swappable so both
// branches are tested on any CI host (`_setPlatform`).
let _platform = process.platform;

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
 * Find a listener on `port` that lsof, run as this user, cannot see.
 *
 * lsof without root lists only this user's sockets, and the listeners most
 * worth catching belong to root: `tailscale serve` (the incident behind #814
 * was a session taking a port for exactly that), sshd, system daemons. The
 * kernel's socket table is readable without root through `netstat -anv` on
 * macOS, which also prints the owning pid, and `ss -Hltn` on Linux, which
 * does not. The pid's command comes from `ps`, which also works for root.
 *
 * @param {number} port
 * @returns {{ found: boolean, pid: number|null, command: string|null }|null}
 *   null when no fallback exists here or it could not run — "unknown", which
 *   the caller keeps as lsof's answer rather than reading as clear
 */
function _socketTableListener(port) {
  const run = (cmd) => _exec(cmd, { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (_platform === 'darwin') {
      const hit = _parseNetstatListener(run('netstat -anv -p tcp'), port);
      if (!hit) return { found: false, pid: null, command: null };
      return { found: true, pid: hit.pid, command: hit.pid === null ? null : _commandOf(hit.pid) };
    }
    if (_platform === 'linux') {
      return _parseSsListener(run('ss -Hltn'), port)
        ? { found: true, pid: null, command: null }
        : { found: false, pid: null, command: null };
    }
  } catch (err) { // prawduct:allow prawduct/broad-except -- any failure of the fallback means "this source could not answer"; the caller keeps lsof's answer and the lease still reports what was checked.
    log.debug('Socket-table fallback unavailable', { port, error: err.message });
    return null;
  }
  return null;
}

/**
 * Find a LISTEN row for `port` in macOS `netstat -anv -p tcp` output.
 *
 * Columns: Proto Recv-Q Send-Q Local Foreign (state) rxbytes txbytes rhiwat
 * shiwat pid ... . The local address ends in `.<port>` (`*.22`,
 * `127.0.0.1.3102`, `fd7a:…::.8444`), and `pid` is the eleventh field.
 *
 * @param {string} output - Raw netstat output
 * @param {number} port
 * @returns {{ pid: number|null }|null} The first LISTEN row on that port, or null
 */
function _parseNetstatListener(output, port) {
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[5] !== 'LISTEN') continue;
    const m = /\.(\d+)$/.exec(parts[3] || '');
    if (!m || Number(m[1]) !== port) continue;
    const pid = parseInt(parts[10], 10);
    return { pid: Number.isInteger(pid) ? pid : null };
  }
  return null;
}

/**
 * Whether Linux `ss -Hltn` output has a listener on `port`.
 *
 * Columns: State Recv-Q Send-Q Local:Port Peer:Port. The local field ends in
 * `:<port>` (`0.0.0.0:22`, `[::]:22`, `127.0.0.1%lo:53`). `-l` already limits
 * the rows to listeners; unprivileged `ss` prints no pid.
 *
 * @param {string} output - Raw ss output
 * @param {number} port
 * @returns {boolean}
 */
function _parseSsListener(output, port) {
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const m = /:(\d+)$/.exec(parts[3] || '');
    if (m && Number(m[1]) === port) return true;
  }
  return false;
}

/**
 * Name the command a pid runs, as `ps` reports it, reduced to its basename.
 * @param {number} pid
 * @returns {string|null}
 */
function _commandOf(pid) {
  try {
    const out = _exec(`ps -p ${pid} -o comm=`, { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out ? out.split('/').pop() : null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- a vanished pid or a missing ps leaves the listener unnamed, never unreported.
    log.debug('Could not name listener pid', { pid, error: err.message });
    return null;
  }
}

/**
 * Ask the machine, now, whether anything is listening on one TCP port.
 *
 * The periodic scan is a cache: empty before its first run, and empty forever
 * when `portScannerEnabled` is false. A lease decision read from it would grant
 * a port the machine is visibly using whenever the cache is cold, which is the
 * exact failure that let a session take Caddy's port (#814). So the lease path
 * asks lsof about the one port, and when lsof (which sees only this user's
 * sockets) finds nothing, asks the kernel socket table too, so a root-owned
 * listener is not reported free. It falls back to the cache only when lsof
 * cannot run, saying so in `source`.
 *
 * lsof exits 1 both when nothing listens and when it fails, so a non-zero exit
 * with a readable stdout is parsed, an exit with empty output and no error
 * text is "nothing listening", and anything else is "could not ask".
 *
 * @param {number|string} port - Port number to check; a numeric string is accepted
 * @returns {{ inUse: boolean, process: string|null, pid: number|null, source: 'probe'|'cache'|'unavailable' }}
 *   `source` says what answered: a fresh probe, the cached scan (lsof failed and
 *   the cache had run), or nothing (a non-port value, or lsof failed with the
 *   cache empty, so `inUse: false` is unknown, not clear).
 */
function probePort(port) {
  const fromEntries = (entries, source) => {
    const entry = entries.find((e) => e.port === port);
    return entry
      ? { inUse: true, process: entry.command, pid: entry.pid, source }
      : { inUse: false, process: null, pid: null, source };
  };
  const requested = port;
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // Said out loud: a caller that passed something that is not a port gets
    // "could not check", and a silent one looks exactly like a clear answer.
    log.warn('Port probe given a value that is not a port', { port: requested });
    return { inUse: false, process: null, pid: null, source: 'unavailable' };
  }
  let lsofAnswer;
  try {
    // stderr is captured, not discarded, so a failing lsof can be told apart
    // from one that found nothing.
    const output = _exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    lsofAnswer = fromEntries(_parseLsofOutput(output), 'probe');
  } catch (err) {
    if (err.stdout) {
      lsofAnswer = fromEntries(_parseLsofOutput(err.stdout), 'probe');
    } else if (err.status === 1 && !err.stderr) {
      // Exit 1 with nothing printed is lsof's "no such listener".
      lsofAnswer = { inUse: false, process: null, pid: null, source: 'probe' };
    } else {
      log.warn('Port probe failed, falling back to the cached scan', { port, error: err.message });
      if (_lastScan.length > 0) return fromEntries(_lastScan, 'cache');
      return { inUse: false, process: null, pid: null, source: 'unavailable' };
    }
  }
  if (lsofAnswer.inUse) return lsofAnswer;
  const other = _socketTableListener(port);
  if (other && other.found) {
    return { inUse: true, process: other.command, pid: other.pid, source: 'probe' };
  }
  return lsofAnswer;
}

/**
 * Start periodic port scanning.
 * @param {number} [intervalMs=60000] - Scan interval in milliseconds
 */
function startScanner(intervalMs = 60000) {
  if (_scanTimer) stopScanner();

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
  _exec = execSync;
  _platform = process.platform;
  stopScanner();
}

/**
 * Replace the command runner (for testing).
 * @param {Function} fn - execSync-compatible function
 */
function _setExec(fn) {
  _exec = fn;
}

/**
 * Replace the platform the socket-table fallback branches on (for testing).
 * @param {string} platform - A `process.platform` value
 */
function _setPlatform(platform) {
  _platform = platform;
}

/**
 * Seed the cached scan (for testing).
 * @param {{ port: number, pid: number, command: string }[]} entries
 */
function _setLastScan(entries) {
  _lastScan = entries;
}

module.exports = {
  scan,
  getSystemPorts,
  probePort,
  startScanner,
  stopScanner,
  _parseLsofOutput,
  _reset,
  _setExec,
  _setLastScan,
  _setPlatform,
  _parseNetstatListener,
  _parseSsListener
};
