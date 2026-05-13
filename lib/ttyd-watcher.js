'use strict';

const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('ttyd-watcher');

const DEFAULT_TTYD_LABEL = 'com.tangleclaw.ttyd';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PTY_THRESHOLD = 0.85;
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
 * Measure PTY pool exhaustion on macOS by comparing the `kern.tty.ptmx_max`
 * cap against the count of `/dev/ttys*` slot files currently allocated.
 *
 * The exhausted resource — the one that produces the `pty_spawn: 6 (Device
 * not configured)` crash signature in #94 — is the PTY slot pool, not the
 * live-child count under any particular pid. Zombies hold slots; live
 * children hold slots; this measurement counts both because it asks the
 * kernel rather than introspecting a process tree.
 *
 * Replaces the pre-#144 `_countTtydChildren` proxy that invoked
 * `pgrep -c -P <pid>` and silently failed on every macOS install:
 *   - BSD pgrep has no `-c` flag (exits 2, was not handled)
 *   - BSD pgrep filters out zombies (the exact population we wanted to count)
 *
 * Fail-safe: any non-numeric reading from sysctl or ls returns
 * `{ exhausted: false, used: 0, cap: 0, ratio: 0 }`. The watcher never
 * kickstarts on a failed measurement.
 *
 * @param {number} [thresholdRatio=DEFAULT_PTY_THRESHOLD] - fraction of cap above which the pool is considered exhausted (e.g. 0.85)
 * @returns {{ exhausted: boolean, used: number, cap: number, ratio: number }}
 */
function _isPtyPoolExhausted(thresholdRatio = DEFAULT_PTY_THRESHOLD) {
  let cap = 0;
  let used = 0;
  try {
    const capRaw = _runner('sysctl', ['-n', 'kern.tty.ptmx_max']).trim();
    cap = parseInt(capRaw, 10);
  } catch (err) {
    log.debug('sysctl kern.tty.ptmx_max failed', { error: err.message });
    return { exhausted: false, used: 0, cap: 0, ratio: 0 };
  }
  try {
    // `ls /dev/ttys* 2>/dev/null | wc -l` — the shell pipeline is necessary
    // because bare `ls /dev/ttys*` exits 1 on no-match and `wc` would never
    // run. Piping through sh keeps stderr/stdout/exit semantics clean.
    const usedRaw = _runner('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l']).trim();
    used = parseInt(usedRaw, 10);
  } catch (err) {
    log.debug('ls /dev/ttys* failed', { error: err.message });
    return { exhausted: false, used: 0, cap: 0, ratio: 0 };
  }
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used) || used < 0) {
    return { exhausted: false, used: 0, cap: 0, ratio: 0 };
  }
  const ratio = used / cap;
  const exhausted = used >= Math.floor(cap * thresholdRatio);
  return { exhausted, used, cap, ratio };
}

/**
 * Count zombie processes (state contains 'Z') whose parent PID is `pid`.
 *
 * Used for **diagnostic logging only** — never gates the kickstart decision.
 * Captured here so production logs on the next incident carry the data that
 * answers "how many zombie children did ttyd have when we kickstarted?" with
 * a grep rather than a guess. Future tuning may promote this to a secondary
 * gate; for now the pool measurement is the sole authority.
 *
 * Uses `ps -A -o ppid=,stat=` which (unlike BSD pgrep) DOES include zombies.
 * Returns 0 on any error — the caller never has to handle null.
 *
 * @param {number} pid - parent PID (typically ttyd)
 * @returns {number}
 */
function _countTtydZombies(pid) {
  try {
    const out = _runner('ps', ['-A', '-o', 'ppid=,stat=']);
    let count = 0;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(\S+)/);
      if (!m) continue;
      const ppid = parseInt(m[1], 10);
      const stat = m[2];
      if (ppid === pid && stat.includes('Z')) count += 1;
    }
    return count;
  } catch (err) {
    log.debug('ps -A failed', { error: err.message });
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
 * Run one watcher tick: read ttyd PID, measure PTY pool, kickstart if pool
 * is exhausted past `ptyThresholdRatio`. All errors are swallowed and logged
 * so a failed check cannot crash the watcher loop.
 *
 * Zombie count is collected for diagnostic logging but does NOT gate the
 * kickstart decision (#144 design call — pool-only gate, simpler, matches
 * the manually-verified fix path).
 *
 * @param {{ ttydLabel: string, ptyThresholdRatio: number }} opts - ptyThresholdRatio is a 0..1 fraction (not a percent — 0.85, not 85)
 */
function _check(opts) {
  const { ttydLabel, ptyThresholdRatio } = opts;
  try {
    const pid = _getTtydPid(ttydLabel);
    if (pid === null) {
      log.debug('ttyd not running, skipping check', { ttydLabel });
      return;
    }
    const { exhausted, used, cap, ratio } = _isPtyPoolExhausted(ptyThresholdRatio);
    const zombies = _countTtydZombies(pid);
    if (cap === 0) {
      // Measurement failed — `_isPtyPoolExhausted` returns the fail-safe sentinel
      // `{ exhausted: false, used: 0, cap: 0, ratio: 0 }` when sysctl or the ls/wc
      // pipeline threw, or produced non-numeric output. Surface this as a `warn`
      // so operators grepping the log can distinguish "pool empty" from
      // "measurement broken" — they were indistinguishable pre-Critic-MINOR-1.
      log.warn('ttyd PTY pool measurement failed (fail-safe — no kickstart)', {
        ttydLabel, pid, zombies, threshold: ptyThresholdRatio
      });
      return;
    }
    if (exhausted) {
      log.warn('ttyd PTY pool exhausted, kickstarting', {
        ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
        zombies, threshold: ptyThresholdRatio
      });
      _kickstartTtyd(ttydLabel);
    } else {
      log.debug('ttyd PTY pool ok', {
        ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
        zombies, threshold: ptyThresholdRatio
      });
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
 * @param {number} [options.ptyThresholdRatio=0.85] - fraction of `kern.tty.ptmx_max` above which a kickstart fires
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
  const ptyThresholdRatio = options.ptyThresholdRatio ?? DEFAULT_PTY_THRESHOLD;

  log.debug('Starting ttyd watcher', { ttydLabel, intervalMs, ptyThresholdRatio });

  _timer = setInterval(() => {
    _check({ ttydLabel, ptyThresholdRatio });
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
  _isPtyPoolExhausted,
  _countTtydZombies,
  _kickstartTtyd,
  _setRunner,
  _reset,
  DEFAULT_TTYD_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PTY_THRESHOLD
};
