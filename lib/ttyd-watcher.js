'use strict';

const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('ttyd-watcher');

const DEFAULT_TTYD_LABEL = 'com.tangleclaw.ttyd';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 50;
const SHELL_TIMEOUT_MS = 5000;

let _timer = null;
let _disabled = false;

let _runner = function _defaultRunner(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: SHELL_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString();
};

/**
 * Read ttyd's PID from `launchctl list <label>`. Returns null if the service
 * is not currently running (between launchd restarts) or the command fails.
 * @param {string} label - launchd job label
 * @returns {number|null}
 */
function _getTtydPid(label) {
  let output;
  try {
    output = _runner('launchctl', ['list', label]);
  } catch (err) {
    // debug-level: the watcher polls every 5 min, and many environments
    // (fresh dev clones, non-launchd installs) won't have the label loaded.
    log.debug('launchctl list failed', { label, error: err.message });
    return null;
  }
  const match = output.match(/"PID"\s*=\s*(\d+);/);
  if (!match) return null;
  const pid = parseInt(match[1], 10);
  return Number.isFinite(pid) ? pid : null;
}

/**
 * Count children of a parent PID via `pgrep -c -P <pid>`. Returns 0 when there
 * are no children (pgrep exits 1 in that case, which is not an error here).
 * @param {number} pid - parent PID
 * @returns {number}
 */
function _countTtydChildren(pid) {
  try {
    const out = _runner('pgrep', ['-c', '-P', String(pid)]);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    if (err.status === 1) return 0;
    log.warn('pgrep failed', { pid, error: err.message });
    return 0;
  }
}

/**
 * Restart the ttyd launchd job. macOS-only — uses `launchctl kickstart -k`
 * against the user's GUI domain.
 * @param {string} label - launchd job label
 * @returns {boolean} true on success, false on failure
 */
function _kickstartTtyd(label) {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (uid <= 0) {
      // gui/0/<label> is not a valid launchctl target on macOS — root would
      // need system/<label>, which TC doesn't run as. Refuse rather than
      // emit a malformed command.
      log.warn('launchctl kickstart skipped — invalid uid', { label, uid });
      return false;
    }
    _runner('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
    return true;
  } catch (err) {
    log.error('launchctl kickstart failed', { label, error: err.message });
    return false;
  }
}

/**
 * Run one watcher tick: read ttyd PID, count its children, kickstart if the
 * count meets or exceeds threshold. All errors are swallowed and logged so a
 * failed check cannot crash the watcher loop.
 * @param {{ ttydLabel: string, threshold: number }} opts
 */
function _check(opts) {
  const { ttydLabel, threshold } = opts;
  try {
    const pid = _getTtydPid(ttydLabel);
    if (pid === null) {
      log.debug('ttyd not running, skipping check', { ttydLabel });
      return;
    }
    const count = _countTtydChildren(pid);
    if (count >= threshold) {
      log.warn('ttyd child count above threshold, kickstarting', {
        ttydLabel, pid, count, threshold
      });
      _kickstartTtyd(ttydLabel);
    } else {
      log.debug('ttyd child count ok', { ttydLabel, pid, count, threshold });
    }
  } catch (err) {
    log.warn('ttyd watcher check failed', { error: err.message });
  }
}

/**
 * Start the periodic ttyd watcher. macOS-only — no-op on other platforms.
 * Idempotent: a second call replaces the existing timer.
 * @param {object} [options]
 * @param {string} [options.ttydLabel='com.tangleclaw.ttyd']
 * @param {number} [options.intervalMs=300000] - 5 minutes default
 * @param {number} [options.threshold=50] - child-count trigger
 */
function start(options = {}) {
  if (process.platform !== 'darwin') {
    log.info('ttyd watcher disabled on non-darwin platforms', { platform: process.platform });
    return;
  }
  if (_disabled) return;

  stop();

  const ttydLabel = options.ttydLabel || DEFAULT_TTYD_LABEL;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  log.debug('Starting ttyd watcher', { ttydLabel, intervalMs, threshold });

  _timer = setInterval(() => {
    _check({ ttydLabel, threshold });
  }, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

/**
 * Stop the watcher. Idempotent.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Reset internal state (test seam).
 */
function _reset() {
  stop();
  _disabled = false;
  _runner = function _defaultRunner(cmd, args) {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString();
  };
}

/**
 * Inject a runner for tests. The runner receives (cmd, args) and must return
 * stdout as a string, or throw with `.status` set on nonzero exit.
 *
 * Module-global seam — call `_reset()` between tests to clear leftover state
 * and avoid leakage if other test files import this module concurrently.
 * @param {Function} fn
 */
function _setRunner(fn) {
  _runner = fn;
}

module.exports = {
  start,
  stop,
  _check,
  _getTtydPid,
  _countTtydChildren,
  _kickstartTtyd,
  _setRunner,
  _reset,
  DEFAULT_TTYD_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_THRESHOLD
};
