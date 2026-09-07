'use strict';

const { execFileSync, execFile } = require('node:child_process');
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
// #1245: a restart blanks every open terminal iframe at once, so they all
// reconnect together — and connect/disconnect churn is what leaks. A fresh ttyd
// was observed reaching 22 wedged children within five minutes of a kickstart,
// which tripped the orphan gate again on the very next poll. Without this the
// gate can fire on damage a restart caused, blanking the operator's terminals
// two or three times over one underlying leak.
//
// Three poll intervals, computed rather than restated so the relation cannot go
// stale if the interval moves. Long enough that the post-restart reconnect burst
// is counted as the cost of the restart rather than as a fresh leak, short
// enough that a genuinely fast leak is still recycled several times an hour.
// Bounds the thrash; it does not pretend to fix the leak, which is ttyd's own.
const DEFAULT_KICKSTART_COOLDOWN_MS = 3 * DEFAULT_INTERVAL_MS;
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

// Async twin of `_runner`, used ONLY by `measureLeak` (the health panel's
// reading). The watcher's own tick stays synchronous — it runs on a timer with
// nothing waiting on it — but a reading taken for an HTTP response must never
// block the event loop, least of all on a `ps -A` during the very PTY-exhaustion
// incident it is there to report. `null` means "derive from `_runner`", which
// keeps the sync test double usable for both paths.
let _runnerAsync = null;

/**
 * Run a command off the event loop, bounded by `SHELL_TIMEOUT_MS`.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} stdout.
 */
function _defaultAsyncRunner(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: SHELL_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * The async runner in force: an injected one, else the sync runner lifted
 * onto a promise (so a test that injected only `_setRunner` drives both paths);
 * with neither injected, the bounded `execFile` runner.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} stdout.
 */
function _runAsync(cmd, args) {
  if (_runnerAsync) return _runnerAsync(cmd, args);
  if (_runner !== _defaultRunnerRef) return Promise.resolve().then(() => _runner(cmd, args));
  return _defaultAsyncRunner(cmd, args);
}
// Identity of the production sync runner, so `_runAsync` can tell "a test
// injected a sync double" from "nothing injected" without a flag to forget.
const _defaultRunnerRef = _runner;

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
  return _parsePid(output);
}

/**
 * The PID in `launchctl list <label>` output, or null when the job is loaded
 * but not running (no PID line) or the output is not a job description.
 * @param {string} output - `launchctl list <label>` stdout.
 * @returns {number|null}
 */
function _parsePid(output) {
  const match = String(output).match(/"PID"\s*=\s*(\d+);/);
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
  return _poolFromCounts(cap, used, thresholdRatio);
}

/**
 * Classify a PTY pool reading from its two counts. The fail-safe sentinel
 * (`cap: 0`) is returned for any non-numeric or impossible pair.
 * @param {number} cap - `kern.tty.ptmx_max`.
 * @param {number} used - Allocated `/dev/ttys*` slots.
 * @param {number} thresholdRatio - Fraction of cap that counts as exhausted.
 * @returns {{ exhausted: boolean, used: number, cap: number, ratio: number }}
 */
function _poolFromCounts(cap, used, thresholdRatio) {
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
  return _childStatsFrom(_runner('ps', ['-A', '-o', 'ppid=,stat=']), pid);
}

/**
 * Parse `ps -A -o ppid=,stat=` output into the state codes of `pid`'s children.
 * @param {string} out - The `ps` stdout.
 * @param {number} pid - Parent PID.
 * @returns {string[]} state codes.
 */
function _childStatsFrom(out, pid) {
  const stats = [];
  for (const line of String(out).split('\n')) {
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
 * Take one leak reading WITHOUT acting on it, for the dashboard's system-health
 * panel (#345). Same two gates `_check` kickstarts on, but every measurement
 * that fails comes back as `null` rather than the fail-safe zero the watcher
 * uses — the watcher's "0 on error" is the right shape for a decision that must
 * never fire on a broken reading, and the wrong one for a surface that must
 * never render a broken reading as "clear".
 *
 * Asynchronous, unlike `_check`: this reading is taken for an HTTP response,
 * and `ps -A` on a box mid-PTY-exhaustion is exactly the command that can
 * stall. Each spawn is bounded by `SHELL_TIMEOUT_MS`; the caller caches the
 * result and never awaits it on a request (see lib/system-health.js).
 *
 * @param {object} [opts]
 * @param {string} [opts.ttydLabel='com.tangleclaw.ttyd'] - launchd job label
 * @param {number} [opts.ptyThresholdRatio=0.85] - fraction of `kern.tty.ptmx_max` that counts as exhausted
 * @param {number} [opts.orphanThreshold=20] - leaked-child count that counts as a leak
 * @returns {Promise<{
 *   pid: number|null,
 *   pool: {exhausted: boolean, used: number, cap: number, ratio: number}|null,
 *   orphans: number|null,
 *   orphanThreshold: number,
 *   ptyThresholdRatio: number
 * }>} `pid` null when the job is not running; `pool` null when sysctl/ls could
 *   not be read; `orphans` null when `ps` could not be read.
 */
async function measureLeak(opts = {}) {
  const ttydLabel = opts.ttydLabel || DEFAULT_TTYD_LABEL;
  const ptyThresholdRatio = opts.ptyThresholdRatio ?? DEFAULT_PTY_THRESHOLD;
  const orphanThreshold = opts.orphanThreshold ?? DEFAULT_ORPHAN_THRESHOLD;
  let pid = null;
  try {
    pid = _parsePid(await _runAsync('launchctl', ['list', ttydLabel]));
  } catch (err) {
    log.debug('launchctl list failed (health measurement)', { label: ttydLabel, error: err.message });
  }
  if (pid === null) {
    return { pid: null, pool: null, orphans: null, orphanThreshold, ptyThresholdRatio, uptimeMs: null, cooldownMs: DEFAULT_KICKSTART_COOLDOWN_MS };
  }
  const [poolResult, psResult, etimeResult] = await Promise.allSettled([
    _readPoolAsync(ptyThresholdRatio),
    _runAsync('ps', ['-A', '-o', 'ppid=,stat=']),
    _runAsync('ps', ['-o', 'etime=', '-p', String(pid)])
  ]);
  let pool = null;
  if (poolResult.status === 'fulfilled') {
    pool = poolResult.value;
  } else {
    log.debug('PTY pool read failed (health measurement)', { error: poolResult.reason && poolResult.reason.message });
  }
  let orphans = null;
  if (psResult.status === 'fulfilled') {
    orphans = _childStatsFrom(psResult.value, pid).filter(
      (stat) => stat.includes('E') || stat.includes('Z')
    ).length;
  } else {
    log.debug('ps -A failed (health measurement)', { error: psResult.reason && psResult.reason.message });
  }
  // #1245 — the panel hands the operator a `launchctl kickstart` as its remedy,
  // and a restart makes every terminal reconnect at once, which leaks. Carrying
  // ttyd's age lets the panel say when the count it is showing may BE that
  // burst, rather than inviting a restart that produces another one.
  const uptimeMs = etimeResult.status === 'fulfilled'
    ? _parseEtime(etimeResult.value)
    : null;
  return { pid, pool, orphans, orphanThreshold, ptyThresholdRatio, uptimeMs, cooldownMs: DEFAULT_KICKSTART_COOLDOWN_MS };
}

/**
 * Async twin of `_isPtyPoolExhausted`. Resolves the classified pool, or `null`
 * when either count was unreadable — never the sync path's fail-safe sentinel,
 * which reads as "0 of 0 used".
 * @param {number} thresholdRatio - Fraction of cap that counts as exhausted.
 * @returns {Promise<{ exhausted: boolean, used: number, cap: number, ratio: number }|null>}
 */
async function _readPoolAsync(thresholdRatio) {
  const capRaw = await _runAsync('sysctl', ['-n', 'kern.tty.ptmx_max']);
  const usedRaw = await _runAsync('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l']);
  const pool = _poolFromCounts(parseInt(String(capRaw).trim(), 10), parseInt(String(usedRaw).trim(), 10), thresholdRatio);
  return pool.cap > 0 ? pool : null;
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
 * How long the CURRENT ttyd process has been running, in ms, or null when it
 * cannot be read.
 *
 * The cooldown is a property of the ttyd process, never of this module's own
 * bookkeeping, and that is the whole point (#1245). A restart is a restart
 * whoever caused it: this watcher's kickstart, the operator running the
 * `launchctl kickstart` the health panel hands them, or launchd respawning a
 * crashed ttyd. Counting only our own would leave the documented manual remedy
 * producing the identical reconnect burst with nothing recording it, and the
 * gate firing on that burst next tick — the exact thrash this exists to stop.
 *
 * It also makes a FAILED kickstart harmless by construction: if `launchctl`
 * refused, ttyd's age is unchanged and old, so no cooldown is armed and the
 * next tick retries on schedule. Bookkeeping would have held the only gate that
 * fires on this box down for 15 minutes after doing nothing at all.
 *
 * Survives a server restart for the same reason — the fact lives in the OS.
 *
 * @param {number} pid - ttyd PID
 * @returns {number|null} Milliseconds of uptime, or null if unreadable
 */
function _ttydUptimeMs(pid) {
  try {
    return _parseEtime(_runner('ps', ['-o', 'etime=', '-p', String(pid)]));
  } catch (err) {
    log.debug('ps -o etime= failed (ttyd uptime)', { pid, error: err.message });
    return null;
  }
}

/**
 * Parse BSD `ps -o etime=` — `[[dd-]hh:]mm:ss` — into milliseconds.
 *
 * macOS `ps` has no `etimes` keyword (the seconds-valued one), so the padded
 * form is the only thing available and it has to be parsed rather than read.
 *
 * @param {string} out - Raw `etime` field.
 * @returns {number|null} Milliseconds, or null when the shape is not recognised.
 */
function _parseEtime(out) {
  const text = String(out).trim();
  const m = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (
    (Number(days || 0) * 86400)
    + (Number(hours || 0) * 3600)
    + (Number(minutes) * 60)
    + Number(seconds)
  ) * 1000;
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
 * The orphan gate is held down for `kickstartCooldownMs` after a kickstart
 * (#1245) because a kickstart makes every terminal reconnect at once and that
 * churn is what leaks — so the gate could otherwise fire on damage its own
 * previous kickstart caused. The POOL gate is never held down: exhaustion is
 * the #94 incident, and a papercut is not worth trading for it.
 *
 * @param {{ ttydLabel: string, ptyThresholdRatio: number, orphanThreshold?: number, kickstartCooldownMs?: number }} opts - ptyThresholdRatio is a 0..1 fraction (not a percent — 0.85, not 85); orphanThreshold is a leaked-child COUNT (defaults to DEFAULT_ORPHAN_THRESHOLD when omitted)
 * The return is a TEST SEAM and has no production caller — the timer ignores it.
 * The shipped surface is the log, and that is what the suite pins; this exists
 * so a test can assert which branch ran without parsing log text for control
 * flow. Do not build behaviour on it without giving it a real consumer.
 *
 * @returns {{action: 'kickstart'|'kickstart-failed'|'suppressed'|'ok'|'skipped'|'measurement-failed'|'error', orphans: number|null, ttydUptimeMs: number|null}}
 */
function _check(opts) {
  const { ttydLabel, ptyThresholdRatio } = opts;
  const orphanThreshold = opts.orphanThreshold ?? DEFAULT_ORPHAN_THRESHOLD;
  const cooldownMs = opts.kickstartCooldownMs ?? DEFAULT_KICKSTART_COOLDOWN_MS;
  try {
    const pid = _getTtydPid(ttydLabel);
    if (pid === null) {
      log.debug('ttyd not running, skipping check', { ttydLabel });
      return { action: 'skipped', orphans: null, ttydUptimeMs: null };
    }
    const { exhausted, used, cap, ratio } = _isPtyPoolExhausted(ptyThresholdRatio);
    const orphans = _countTtydOrphans(pid);
    const zombies = _countTtydZombies(pid);
    // Carried on every return so the tick AFTER a restart says how many orphans
    // survived it. Nothing previously distinguished "the restart reclaimed them
    // and the reconnect burst made more" from "the restart did not reclaim
    // them", which is what made the thrash inferred rather than diagnosable.
    const uptimeMs = _ttydUptimeMs(pid);

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
      return { action: 'measurement-failed', orphans, ttydUptimeMs: uptimeMs };
    }

    if (exhausted || orphanGate) {
      const reason = exhausted && orphanGate ? 'pool-exhausted+orphan-children'
        : exhausted ? 'pool-exhausted' : 'orphan-children';

      // The cooldown binds the ORPHAN gate only. Pool exhaustion is the #94
      // incident — every attach fails and the machine is unusable — so it must
      // keep its ability to fire on any tick. Observed pool ratios during the
      // #1245 thrash were 0.084–0.115 against a 0.85 gate, so suppressing the
      // pool gate too would trade a papercut for the incident this watcher
      // exists to prevent.
      // An unreadable uptime must not suppress: the gate's job is to recycle a
      // leaking ttyd, so a failed measurement is a reason to act on the orphan
      // count as before, never a reason to sit on it.
      if (!exhausted && uptimeMs !== null && uptimeMs < cooldownMs) {
        // At `warn`, not swallowed: a gate that DECLINES to act is exactly what
        // an operator later needs in order to explain why terminals were or
        // were not blanking.
        log.warn('ttyd orphan gate held down — this ttyd is too newly restarted to blame', {
          ttydLabel, pid, orphans, zombies, reason,
          ttydUptimeMs: uptimeMs, cooldownMs, remainingMs: cooldownMs - uptimeMs,
          note: 'a restart makes every terminal reconnect at once, and that churn leaks — these orphans may be its cost rather than a new leak'
        });
        return { action: 'suppressed', orphans, ttydUptimeMs: uptimeMs };
      }

      log.warn('ttyd leak detected, kickstarting', {
        ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
        orphans, zombies, reason, ttydUptimeMs: uptimeMs,
        ptyThreshold: ptyThresholdRatio, orphanThreshold
      });
      const kicked = _kickstartTtyd(ttydLabel);
      return { action: kicked ? 'kickstart' : 'kickstart-failed', orphans, ttydUptimeMs: uptimeMs };
    }

    log.debug('ttyd pool + child population ok', {
      ttydLabel, pid, used, cap, ratio: Number(ratio.toFixed(3)),
      orphans, zombies, ttydUptimeMs: uptimeMs,
      ptyThreshold: ptyThresholdRatio, orphanThreshold
    });
    return { action: 'ok', orphans, ttydUptimeMs: uptimeMs };
  } catch (err) {
    log.warn('ttyd watcher check failed', { error: err.message });
    return { action: 'error', orphans: null, ttydUptimeMs: null };
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
 * @param {number} [options.kickstartCooldownMs=900000] - how long after a kickstart the ORPHAN gate is held down (#1245). The pool gate is never held down.
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
  const kickstartCooldownMs = options.kickstartCooldownMs ?? DEFAULT_KICKSTART_COOLDOWN_MS;

  log.debug('Starting ttyd watcher', {
    ttydLabel, intervalMs, ptyThresholdRatio, orphanThreshold, kickstartCooldownMs
  });

  _timer = setInterval(() => {
    _check({ ttydLabel, ptyThresholdRatio, orphanThreshold, kickstartCooldownMs });
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
  _runnerAsync = null;
  _runner = _defaultRunnerRef;
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

/**
 * Inject the async runner for tests: `(cmd, args) => Promise<string>`. Unset
 * (the default, restored by `_reset()`), `measureLeak` lifts an injected sync
 * runner onto a promise, or uses the bounded `execFile` runner.
 * @param {Function|null} fn
 */
function _setAsyncRunner(fn) {
  _runnerAsync = fn;
}

module.exports = {
  start,
  stop,
  _check,
  _getTtydPid,
  _isPtyPoolExhausted,
  _countTtydZombies,
  _countTtydOrphans,
  measureLeak,
  _kickstartTtyd,
  _setRunner,
  _setAsyncRunner,
  _reset,
  DEFAULT_TTYD_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PTY_THRESHOLD,
  DEFAULT_ORPHAN_THRESHOLD,
  DEFAULT_KICKSTART_COOLDOWN_MS,
  _ttydUptimeMs,
  _parseEtime
};
