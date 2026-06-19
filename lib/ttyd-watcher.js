'use strict';

const { execFileSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('ttyd-watcher');

const DEFAULT_TTYD_LABEL = 'com.tangleclaw.ttyd';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PTY_THRESHOLD = 0.85;
// #380: ttyd accumulates `tmux attach` children stuck in the kernel "exiting"
// state (`E`) — each holds a /dev/ttys* slot but is unreapable except by ttyd
// itself dying. The #144 pool-ratio gate missed the #380 recurrence (90 such
// orphans at pool ratio 0.45, far below 0.85), so this is a SECOND, independent
// gate: when ttyd has this many leaked children, kickstart regardless of pool
// ratio. A healthy attached client is `S`/`R`, never `E`/`Z`, so a steady-state
// count sits near zero; 20 is a clear-leak signal with margin for normal churn.
const DEFAULT_ORPHAN_THRESHOLD = 20;
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
    return _ttydChildStats(pid).filter((stat) => stat.includes('Z')).length;
  } catch (err) {
    log.debug('ps -A failed', { error: err.message });
    return 0;
  }
}

/**
 * Return the process-state (`stat`) codes of every direct child of `pid`, via
 * `ps -A -o ppid=,stat=` (which, unlike BSD pgrep, includes zombies AND
 * exiting processes). Throws on runner failure — callers fail-safe to 0.
 * @param {number} pid - parent PID
 * @returns {string[]} state codes (e.g. ['?Es', '?S', 'Z+'])
 */
function _ttydChildStats(pid) {
  const out = _runner('ps', ['-A', '-o', 'ppid=,stat=']);
  const stats = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\S+)/);
    if (!m) continue;
    if (parseInt(m[1], 10) === pid) stats.push(m[2]);
  }
  return stats;
}

/**
 * Count ttyd's leaked children — those stuck exiting (`E`) or zombied (`Z`).
 *
 * This is the #380 leak signal the #144 pool-ratio gate missed: ttyd spawns a
 * `tmux attach` client per websocket (via ttyd-attach.sh); on disconnect the
 * client should exit in milliseconds, but on macOS it frequently wedges in the
 * kernel `E` state for hours, holding its /dev/ttys* slot. A live attached
 * client is `S`/`R`, never `E`/`Z`, so this counts only orphans. Gates a
 * kickstart in `_check` independently of pool ratio. Returns 0 on any error
 * (fail-safe — the watcher never kickstarts on a failed measurement).
 *
 * @param {number} pid - ttyd PID
 * @returns {number}
 */
function _countTtydOrphans(pid) {
  try {
    return _ttydChildStats(pid).filter(
      (stat) => stat.includes('E') || stat.includes('Z')
    ).length;
  } catch (err) {
    log.debug('ps -A failed (orphan count)', { error: err.message });
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
 * Run one watcher tick: read ttyd PID, then kickstart if EITHER leak gate
 * trips — the PTY pool is exhausted past `ptyThresholdRatio` (#144), OR the
 * leaked-child count (ttyd children in `E`/`Z` state) reaches `orphanThreshold`
 * (#380). The gates are independent: a broken pool measurement does not
 * suppress an orphan-driven kickstart. All errors are swallowed and logged so
 * a failed check cannot crash the watcher loop.
 *
 * Zombie count is also collected for diagnostic logging; it overlaps the
 * orphan count (orphans = `E` ∪ `Z`) but is logged separately for continuity
 * with the #144 diagnostics.
 *
 * @param {{ ttydLabel: string, ptyThresholdRatio: number, orphanThreshold?: number }} opts - ptyThresholdRatio is a 0..1 fraction (not a percent — 0.85, not 85); orphanThreshold is a leaked-child COUNT (defaults to DEFAULT_ORPHAN_THRESHOLD when omitted)
 */
function _check(opts) {
  const { ttydLabel, ptyThresholdRatio } = opts;
  const orphanThreshold = opts.orphanThreshold ?? DEFAULT_ORPHAN_THRESHOLD;
  try {
    const pid = _getTtydPid(ttydLabel);
    if (pid === null) {
      log.debug('ttyd not running, skipping check', { ttydLabel });
      return;
    }
    const { exhausted, used, cap, ratio } = _isPtyPoolExhausted(ptyThresholdRatio);
    const orphans = _countTtydOrphans(pid);
    const zombies = _countTtydZombies(pid);

    // Two independent leak gates — EITHER fires a kickstart:
    //   1. PTY pool exhausted past the ratio (#144 — the original gate).
    //   2. Leaked-child count past the orphan threshold (#380 — the signal
    //      #144 missed: 90 wedged `E`-state children at pool ratio 0.45).
    //      A kickstart is the ONLY thing that frees kernel-`E`-state children
    //      (reparent to launchd → reaped); the tmux SERVER sessions survive it
    //      and clients auto-reconnect, so firing this gate is non-destructive.
    const orphanGate = orphans >= orphanThreshold;

    if (cap === 0 && !orphanGate) {
      // Pool measurement failed — `_isPtyPoolExhausted` returns the fail-safe
      // sentinel `{ exhausted:false, cap:0, ... }` when sysctl or the ls/wc
      // pipeline threw or produced non-numeric output. Never kickstart on a
      // broken pool reading ALONE — but the orphan gate is measured
      // independently, so a broken pool reading must not suppress an
      // orphan-driven kickstart (hence the `&& !orphanGate`). Surface as a
      // `warn` so operators can distinguish "pool empty" from "measurement
      // broken".
      log.warn('ttyd PTY pool measurement failed (fail-safe — no kickstart)', {
        ttydLabel, pid, orphans, zombies,
        ptyThreshold: ptyThresholdRatio, orphanThreshold
      });
      return;
    }

    if (exhausted || orphanGate) {
      const reason = exhausted && orphanGate ? 'pool-exhausted+orphan-children'
        : exhausted ? 'pool-exhausted' : 'orphan-children';
      log.warn('ttyd leak detected, kickstarting', {
        ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
        orphans, zombies, reason,
        ptyThreshold: ptyThresholdRatio, orphanThreshold
      });
      _kickstartTtyd(ttydLabel);
    } else {
      log.debug('ttyd pool + child population ok', {
        ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
        orphans, zombies,
        ptyThreshold: ptyThresholdRatio, orphanThreshold
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
 * @param {number} [options.orphanThreshold=20] - leaked-child count (ttyd children in `E`/`Z` state) above which a kickstart fires, independent of pool ratio (#380)
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
  const orphanThreshold = options.orphanThreshold ?? DEFAULT_ORPHAN_THRESHOLD;

  log.debug('Starting ttyd watcher', { ttydLabel, intervalMs, ptyThresholdRatio, orphanThreshold });

  _timer = setInterval(() => {
    _check({ ttydLabel, ptyThresholdRatio, orphanThreshold });
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
  _countTtydOrphans,
  _kickstartTtyd,
  _setRunner,
  _reset,
  DEFAULT_TTYD_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PTY_THRESHOLD,
  DEFAULT_ORPHAN_THRESHOLD
};
