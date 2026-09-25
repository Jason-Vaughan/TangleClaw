'use strict';

const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('ttyd-watcher');

const DEFAULT_TTYD_LABEL = 'com.tangleclaw.ttyd';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PTY_THRESHOLD = 0.85;
// #380: ttyd accumulates `tmux attach` children stuck in the kernel "exiting"
// state (`E`) — each holds a /dev/ttys* slot but is unreapable except by ttyd
// itself dying. The #144 pool-ratio gate missed the #380 recurrence (90 such
// orphans at pool ratio 0.45, far below 0.85), so this is a SECOND, independent
// gate: when ttyd has this many CONFIRMED wedged children, kickstart regardless
// of pool ratio. A healthy attached client is `S`/`R`, never `E`/`Z`, so a
// steady-state count sits near zero.
const DEFAULT_ORPHAN_THRESHOLD = 20;
// The range an operator may move the orphan threshold within. Below the floor a
// single tab's reconnect burst could trip it; above the ceiling the gate would
// sit out a large share of the 511-slot pool before acting.
const ORPHAN_THRESHOLD_MIN = 5;
const ORPHAN_THRESHOLD_MAX = 200;
// How old an `E`/`Z` child must be before it counts as wedged rather than
// merely exiting. A normal `tmux attach` exits in milliseconds; the wedged ones
// observed in #1245 lived for hours. A child younger than this is recorded as
// transient and never acted on by itself — which is what lets a reconnect burst
// pass without a restart. PROVISIONAL: the value is set from the churn
// harness's measurement of how long a transient E/Z child really lasts.
const DEFAULT_WEDGE_AGE_MS = 2 * 60 * 1000;
// The other way a child is confirmed: seen `E`/`Z` in two readings of the same
// ttyd generation. The health panel and the watcher share one reading store, so
// two readings can land a second apart; without this gap, the second one would
// "confirm" a child that is one second old.
const MIN_OBSERVATION_GAP_MS = 30 * 1000;
// How long a kickstart is given to produce a new ttyd, and how often it is
// looked for. launchd respawns a KeepAlive job in well under a second, so ten
// seconds with no new generation means the restart did not take.
const RECEIPT_TIMEOUT_MS = 10 * 1000;
const RECEIPT_POLL_MS = 500;
// Readings of the current generation kept for the observation rule. Small:
// only the most recent qualifying one is ever consulted.
const HISTORY_LIMIT = 8;
const SHELL_TIMEOUT_MS = 5000;

// The environment switches (R22 Q5). Read once at `start()`.
const ENV_WATCHER = 'TANGLECLAW_TTYD_WATCHER';
const ENV_ORPHAN_THRESHOLD = 'TANGLECLAW_TTYD_ORPHAN_THRESHOLD';

let _timer = null;
let _bootTimer = null;
let _tickInFlight = false;
let _readingInFlight = null;
let _history = [];
let _lastReceipt = null;
// Set while a kickstart this module issued is waiting for its new generation,
// so the reading that sees that generation first is not also recorded as a
// restart nobody made.
let _expectingRestartFrom = null;
let _config = _resolveConfig({});

/**
 * Run a command off the event loop, bounded by `SHELL_TIMEOUT_MS`.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} stdout.
 */
function _defaultRunner(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: SHELL_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

let _runner = _defaultRunner;

/**
 * Run a command through the runner in force. A test double may answer
 * synchronously (return a string, or throw); either way the caller sees a
 * promise.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} stdout.
 */
function _run(cmd, args) {
  return Promise.resolve().then(() => _runner(cmd, args));
}

const _defaultClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  })
};
let _clock = _defaultClock;

/**
 * Resolve the watcher's configuration from `start()` options and the
 * environment. Options win (they are how tests and callers pin a value); the
 * environment is the operator's rollback lever. Invalid environment input never
 * disables anything silently: it falls back to the safe default and says why,
 * in `warnings`, which `start()` logs loudly.
 *
 * @param {object} options - `start()` options.
 * @param {object} [env=process.env] - Environment to read.
 * @returns {{
 *   ttydLabel: string, intervalMs: number, ptyThresholdRatio: number,
 *   orphanThreshold: number, wedgeAgeMs: number, disabled: boolean,
 *   disabledBy: string|null, warnings: string[]
 * }}
 */
function _resolveConfig(options, env = process.env) {
  const warnings = [];
  let disabled = false;
  let disabledBy = null;
  const rawSwitch = env[ENV_WATCHER];
  if (rawSwitch !== undefined && rawSwitch !== '') {
    const v = String(rawSwitch).trim().toLowerCase();
    if (v === 'off' || v === '0' || v === 'false') {
      disabled = true;
      disabledBy = `${ENV_WATCHER}=${rawSwitch}`;
    } else if (!(v === 'on' || v === '1' || v === 'true')) {
      warnings.push(`${ENV_WATCHER}=${JSON.stringify(rawSwitch)} is not on/off; the watcher stays ENABLED`);
    }
  }

  let orphanThreshold = DEFAULT_ORPHAN_THRESHOLD;
  const rawThreshold = env[ENV_ORPHAN_THRESHOLD];
  if (rawThreshold !== undefined && rawThreshold !== '') {
    const n = Number(rawThreshold);
    if (Number.isInteger(n) && n >= ORPHAN_THRESHOLD_MIN && n <= ORPHAN_THRESHOLD_MAX) {
      orphanThreshold = n;
    } else {
      warnings.push(`${ENV_ORPHAN_THRESHOLD}=${JSON.stringify(rawThreshold)} is outside the integer range `
        + `${ORPHAN_THRESHOLD_MIN}-${ORPHAN_THRESHOLD_MAX}; using the default ${DEFAULT_ORPHAN_THRESHOLD}`);
    }
  }

  return {
    ttydLabel: options.ttydLabel || DEFAULT_TTYD_LABEL,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    ptyThresholdRatio: options.ptyThresholdRatio ?? DEFAULT_PTY_THRESHOLD,
    orphanThreshold: options.orphanThreshold ?? orphanThreshold,
    wedgeAgeMs: options.wedgeAgeMs ?? DEFAULT_WEDGE_AGE_MS,
    disabled,
    disabledBy,
    warnings
  };
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
 * Classify a PTY pool reading from its two counts, or null for any
 * non-numeric or impossible pair — a pool that could not be read is never
 * reported as an empty one.
 * @param {number} cap - `kern.tty.ptmx_max`.
 * @param {number} used - Allocated `/dev/ttys*` slots.
 * @param {number} thresholdRatio - Fraction of cap that counts as exhausted.
 * @returns {{ exhausted: boolean, used: number, cap: number, ratio: number }|null}
 */
function _poolFromCounts(cap, used, thresholdRatio) {
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used) || used < 0) return null;
  const ratio = used / cap;
  const exhausted = used >= Math.floor(cap * thresholdRatio);
  return { exhausted, used, cap, ratio };
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
 * Parse `ps -A -o pid=,ppid=,stat=,etime=` into the direct children of `ppid`.
 * One `ps` call gives every child's state AND age, which is what lets a child
 * be judged by how long it has been exiting rather than by a single snapshot.
 * @param {string} out - The `ps` stdout.
 * @param {number} ppid - Parent PID (ttyd).
 * @returns {Array<{pid: number, stat: string, ageMs: number|null}>}
 */
function _parseChildren(out, ppid) {
  const children = [];
  for (const line of String(out).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)$/);
    if (!m) continue;
    if (parseInt(m[2], 10) !== ppid) continue;
    children.push({ pid: parseInt(m[1], 10), stat: m[3], ageMs: _parseEtime(m[4]) });
  }
  return children;
}

/**
 * True for a process state that is exiting (`E`) or zombied (`Z`) — the only
 * states a leaked `tmux attach` child is ever in.
 * @param {string} stat - `ps` state code.
 * @returns {boolean}
 */
function _isExiting(stat) {
  return stat.includes('E') || stat.includes('Z');
}

/**
 * Take one reading of ttyd and the PTY pool. Every probe that fails leaves its
 * field `null` — never a zero that reads as healthy — and nothing here ever
 * rejects. Single-flight: concurrent callers (the watcher's tick, the health
 * panel's refresh) share the one measurement in progress, so they cannot
 * disagree about the same instant.
 *
 * Each spawn is bounded by `SHELL_TIMEOUT_MS`; `launchctl` runs first and the
 * rest run in parallel, so one reading is bounded by roughly three of them.
 *
 * @param {{ttydLabel?: string, ptyThresholdRatio?: number}} [opts]
 * @returns {Promise<{
 *   pid: number|null, generation: string|null, sampledAt: number,
 *   children: Array<{pid: number, stat: string, ageMs: number|null}>|null,
 *   pool: {exhausted: boolean, used: number, cap: number, ratio: number}|null,
 *   errors: string[]
 * }>}
 */
function takeReading(opts = {}) {
  if (_readingInFlight) return _readingInFlight;
  _readingInFlight = _measure(opts)
    .then((reading) => { _record(reading); return reading; })
    .finally(() => { _readingInFlight = null; });
  return _readingInFlight;
}

/**
 * The measurement behind `takeReading`, without the single-flight or the
 * bookkeeping.
 * @param {{ttydLabel?: string, ptyThresholdRatio?: number}} opts
 * @returns {Promise<object>} The reading.
 */
async function _measure(opts) {
  const ttydLabel = opts.ttydLabel || _config.ttydLabel;
  const ptyThresholdRatio = opts.ptyThresholdRatio ?? _config.ptyThresholdRatio;
  const errors = [];
  let pid = null;
  try {
    pid = _parsePid(await _run('launchctl', ['list', ttydLabel]));
  } catch (err) {
    // debug-level: many environments (fresh dev clones, non-launchd installs)
    // won't have the label loaded, and this runs on every poll.
    log.debug('launchctl list failed', { label: ttydLabel, error: err.message });
  }
  if (pid === null) {
    return { pid: null, generation: null, sampledAt: _clock.now(), children: null, pool: null, errors };
  }
  const [poolResult, psResult, lstartResult] = await Promise.allSettled([
    _readPool(ptyThresholdRatio),
    _run('ps', ['-A', '-o', 'pid=,ppid=,stat=,etime=']),
    _run('ps', ['-o', 'lstart=', '-p', String(pid)])
  ]);
  let pool = null;
  if (poolResult.status === 'fulfilled') pool = poolResult.value;
  else errors.push(`pool: ${poolResult.reason && poolResult.reason.message}`);
  let children = null;
  if (psResult.status === 'fulfilled') children = _parseChildren(psResult.value, pid);
  else errors.push(`ps: ${psResult.reason && psResult.reason.message}`);
  // The generation is WHICH ttyd this is: a restart gives the same label a new
  // process, and a reused PID gives a new start time. Kept as an identity, not
  // a parsed date, because all anything needs is whether two readings match.
  let generation = null;
  const lstart = lstartResult.status === 'fulfilled' ? String(lstartResult.value).trim() : '';
  if (lstart) generation = `${pid}@${lstart}`;
  else errors.push(`lstart: ${lstartResult.status === 'rejected' ? lstartResult.reason && lstartResult.reason.message : 'empty'}`);
  return { pid, generation, sampledAt: _clock.now(), children, pool, errors };
}

/**
 * Read the PTY pool. Resolves the classified pool, or null when either count
 * was unreadable.
 * @param {number} thresholdRatio - Fraction of cap that counts as exhausted.
 * @returns {Promise<{ exhausted: boolean, used: number, cap: number, ratio: number }|null>}
 */
async function _readPool(thresholdRatio) {
  const capRaw = await _run('sysctl', ['-n', 'kern.tty.ptmx_max']);
  // `ls /dev/ttys* 2>/dev/null | wc -l` — the shell pipeline is necessary
  // because bare `ls /dev/ttys*` exits 1 on no-match and `wc` would never run.
  const usedRaw = await _run('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l']);
  return _poolFromCounts(parseInt(String(capRaw).trim(), 10), parseInt(String(usedRaw).trim(), 10), thresholdRatio);
}

/**
 * File a reading in the history, dropping every reading of an older ttyd
 * generation, and record a restart this module did not make.
 * @param {object} reading - A reading from `_measure`.
 * @returns {void}
 */
function _record(reading) {
  const previous = _history.length ? _history[_history.length - 1] : null;
  if (reading.generation && previous && previous.generation && previous.generation !== reading.generation) {
    if (_expectingRestartFrom !== previous.generation) {
      // A new ttyd appeared with no kickstart from here: the operator, another
      // session, a server-driven restart, or launchd respawning a crash. Which
      // of those is not knowable from here, so none is named.
      _lastReceipt = {
        at: reading.sampledAt,
        reason: null,
        from: { pid: previous.pid, generation: previous.generation },
        to: { pid: reading.pid, generation: reading.generation },
        outcome: 'external-restart'
      };
      log.warn('ttyd restarted outside the watcher', _lastReceipt);
    }
    _history = [];
  }
  if (reading.generation) {
    _history.push(reading);
    if (_history.length > HISTORY_LIMIT) _history.shift();
  }
}

/**
 * Sort a reading's `E`/`Z` children into confirmed wedges and transients.
 *
 * A child is **wedged** when it is exiting AND either it is older than
 * `wedgeAgeMs`, or the same child was already exiting in an earlier reading of
 * the SAME ttyd generation taken at least `MIN_OBSERVATION_GAP_MS` before.
 * Everything else exiting is **transient**: the normal cost of a websocket
 * closing, reported but never acted on. That split is what stops a reconnect
 * burst from tripping the gate, while a real wedge is still confirmed within
 * one or two ticks.
 *
 * The gates are `null` when the measurement they need is missing: a failed
 * measurement is unknown, never a reason to act and never a reason to call the
 * machine healthy.
 *
 * @param {object} reading - A reading.
 * @param {object[]} history - Earlier readings (any generation; mismatches are ignored).
 * @param {{orphanThreshold: number, wedgeAgeMs: number}} opts
 * @returns {{
 *   wedged: Array<{pid: number, stat: string, ageMs: number|null}>|null,
 *   transient: Array<{pid: number, stat: string, ageMs: number|null}>|null,
 *   orphanGate: boolean|null, poolGate: boolean|null
 * }}
 */
function classifyReading(reading, history, opts) {
  const poolGate = reading.pool ? reading.pool.exhausted : null;
  if (!reading.children) return { wedged: null, transient: null, orphanGate: null, poolGate };
  let earlier = null;
  if (reading.generation) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h === reading || h.generation !== reading.generation || !h.children) continue;
      if (reading.sampledAt - h.sampledAt >= MIN_OBSERVATION_GAP_MS) { earlier = h; break; }
    }
  }
  const seenExiting = new Set(earlier ? earlier.children.filter((c) => _isExiting(c.stat)).map((c) => c.pid) : []);
  const wedged = [];
  const transient = [];
  for (const child of reading.children) {
    if (!_isExiting(child.stat)) continue;
    const oldEnough = child.ageMs !== null && child.ageMs >= opts.wedgeAgeMs;
    if (oldEnough || seenExiting.has(child.pid)) wedged.push(child);
    else transient.push(child);
  }
  return { wedged, transient, orphanGate: wedged.length >= opts.orphanThreshold, poolGate };
}

/**
 * Restart the ttyd launchd job. macOS-only — uses `launchctl kickstart -k`
 * against the user's GUI domain.
 * @param {string} label - launchd job label
 * @returns {Promise<boolean>} true when launchctl accepted the command
 */
async function _kickstartTtyd(label) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid <= 0) {
    // gui/0/<label> is not a valid launchctl target on macOS — root would
    // need system/<label>, which TC doesn't run as. Refuse rather than
    // emit a malformed command.
    log.warn('launchctl kickstart skipped — invalid uid', { label, uid });
    return false;
  }
  try {
    await _run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
    return true;
  } catch (err) {
    log.error('launchctl kickstart failed', { label, error: err.message });
    return false;
  }
}

/**
 * Kickstart ttyd and prove whether it took: re-read until a NEW generation
 * appears or `RECEIPT_TIMEOUT_MS` passes. `launchctl` exiting 0 is not proof —
 * only a different ttyd process is.
 * @param {object} reading - The reading the decision was made on.
 * @param {string} reason - Which gate fired.
 * @returns {Promise<object>} The receipt.
 */
async function _kickstartWithReceipt(reading, reason) {
  const from = { pid: reading.pid, generation: reading.generation };
  const receipt = { at: _clock.now(), reason, from, to: null, outcome: 'failed' };
  _expectingRestartFrom = reading.generation;
  try {
    const accepted = await _kickstartTtyd(_config.ttydLabel);
    if (accepted) {
      receipt.outcome = 'no-new-generation';
      const deadline = _clock.now() + RECEIPT_TIMEOUT_MS;
      while (_clock.now() < deadline) {
        await _clock.sleep(RECEIPT_POLL_MS);
        const next = await takeReading();
        if (next.generation && next.generation !== reading.generation) {
          receipt.to = { pid: next.pid, generation: next.generation };
          receipt.outcome = 'ok';
          break;
        }
      }
    }
  } finally {
    _expectingRestartFrom = null;
  }
  _lastReceipt = receipt;
  const level = receipt.outcome === 'ok' ? 'warn' : 'error';
  log[level]('ttyd kickstart receipt', receipt);
  return receipt;
}

/**
 * One watcher tick: take the shared reading, classify it, and kickstart only
 * when a gate is TRUE — never on an unknown one. The pool gate is never held
 * down (exhaustion is the #94 incident); the orphan gate counts confirmed
 * wedges only. Ticks never overlap: a tick that finds one running returns
 * `overlap` and does nothing. All errors are logged, never thrown, so a failed
 * tick cannot stop the loop.
 *
 * @returns {Promise<{action: string, reading?: object, classification?: object, receipt?: object}>}
 *   `action` is `kickstart` | `kickstart-failed` | `ok` | `skipped` |
 *   `measurement-failed` | `disabled` | `overlap` | `error`.
 */
async function _tick() {
  if (_tickInFlight) return { action: 'overlap' };
  _tickInFlight = true;
  try {
    if (_config.disabled) return { action: 'disabled' };
    const reading = await takeReading();
    if (reading.pid === null) {
      log.debug('ttyd not running, skipping check', { ttydLabel: _config.ttydLabel });
      return { action: 'skipped', reading };
    }
    const classification = classifyReading(reading, _history, _config);
    const summary = _summaryForLog(reading, classification);
    if (classification.poolGate === true || classification.orphanGate === true) {
      const reason = classification.poolGate && classification.orphanGate ? 'pool-exhausted+orphan-children'
        : classification.poolGate ? 'pool-exhausted' : 'orphan-children';
      log.warn('ttyd leak detected, kickstarting', { ...summary, reason });
      const receipt = await _kickstartWithReceipt(reading, reason);
      return { action: receipt.outcome === 'failed' ? 'kickstart-failed' : 'kickstart', reading, classification, receipt };
    }
    if (classification.poolGate === null || classification.orphanGate === null) {
      // Measured nothing it could act on for at least one gate. Never a
      // kickstart; logged so "the gate was blind" is distinguishable from
      // "the gate was clear".
      log.warn('ttyd measurement incomplete (no kickstart on an unknown reading)', { ...summary, errors: reading.errors });
      return { action: 'measurement-failed', reading, classification };
    }
    log.debug('ttyd pool + child population ok', summary);
    return { action: 'ok', reading, classification };
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- the tick runs on a timer with no caller;
    // a throw here would surface as an unhandled rejection and a dead watcher.
    log.warn('ttyd watcher check failed', { error: err.message });
    return { action: 'error' };
  } finally {
    _tickInFlight = false;
  }
}

/**
 * The fields a watcher log line carries about one reading.
 * @param {object} reading - A reading.
 * @param {object} c - Its classification.
 * @returns {object}
 */
function _summaryForLog(reading, c) {
  return {
    ttydLabel: _config.ttydLabel,
    pid: reading.pid,
    generation: reading.generation,
    used: reading.pool ? reading.pool.used : null,
    cap: reading.pool ? reading.pool.cap : null,
    ratio: reading.pool ? Number(reading.pool.ratio.toFixed(3)) : null,
    wedged: c.wedged ? c.wedged.length : null,
    transient: c.transient ? c.transient.length : null,
    ptyThreshold: _config.ptyThresholdRatio,
    orphanThreshold: _config.orphanThreshold,
    wedgeAgeMs: _config.wedgeAgeMs
  };
}

/**
 * Take a reading for the dashboard's system-health panel and summarise it with
 * the SAME classification the watcher acts on, the thresholds in force, and the
 * last kickstart receipt. It shares `takeReading`'s single-flight and history
 * with the watcher, so the panel and the watchdog report the same ttyd, the same
 * generation and the same sample. Every count that could not be measured is
 * `null`, never zero.
 *
 * @returns {Promise<{
 *   pid: number|null, generation: string|null, sampledAt: number,
 *   pool: {exhausted: boolean, used: number, cap: number, ratio: number}|null,
 *   orphans: number|null, transient: number|null,
 *   orphanThreshold: number, ptyThresholdRatio: number, wedgeAgeMs: number,
 *   disabled: boolean, disabledBy: string|null, lastReceipt: object|null
 * }>} `orphans` is the CONFIRMED wedged count the gate compares.
 */
async function measureLeak() {
  const reading = await takeReading();
  const c = reading.pid === null
    ? { wedged: null, transient: null }
    : classifyReading(reading, _history, _config);
  return {
    pid: reading.pid,
    generation: reading.generation,
    sampledAt: reading.sampledAt,
    pool: reading.pool,
    orphans: c.wedged ? c.wedged.length : null,
    transient: c.transient ? c.transient.length : null,
    orphanThreshold: _config.orphanThreshold,
    ptyThresholdRatio: _config.ptyThresholdRatio,
    wedgeAgeMs: _config.wedgeAgeMs,
    disabled: _config.disabled,
    disabledBy: _config.disabledBy,
    lastReceipt: _lastReceipt
  };
}

/**
 * The most recent reading of the current ttyd generation, or null.
 * @returns {object|null}
 */
function latestReading() {
  return _history.length ? _history[_history.length - 1] : null;
}

/**
 * The last kickstart or external-restart receipt, or null.
 * @returns {object|null}
 */
function lastReceipt() {
  return _lastReceipt;
}

/**
 * Start the ttyd watcher. macOS-only — no-op on other platforms. Runs one tick
 * immediately (off the event loop, never blocking boot) and then one per
 * interval, so a server restart never leaves the machine unwatched for a full
 * interval. Idempotent: a second call replaces the existing timers.
 *
 * `TANGLECLAW_TTYD_WATCHER=off` disables the actions (readings for the health
 * panel continue, and it reports the watcher as disabled);
 * `TANGLECLAW_TTYD_ORPHAN_THRESHOLD` moves the orphan gate within its bounds.
 * Both are logged at warn whenever they are in effect or invalid.
 *
 * @param {object} [options]
 * @param {string} [options.ttydLabel='com.tangleclaw.ttyd']
 * @param {number} [options.intervalMs=300000] - 5 minutes default
 * @param {number} [options.ptyThresholdRatio=0.85] - fraction of `kern.tty.ptmx_max` above which a kickstart fires
 * @param {number} [options.orphanThreshold=20] - confirmed wedged children at which a kickstart fires, independent of pool ratio (#380)
 * @param {number} [options.wedgeAgeMs=120000] - how long a child must have been exiting to count as wedged
 * @param {object} [env=process.env] - Environment to read the switches from.
 */
function start(options = {}, env = process.env) {
  if (process.platform !== 'darwin') {
    log.info('ttyd watcher disabled on non-darwin platforms', { platform: process.platform });
    return;
  }

  stop();

  _config = _resolveConfig(options, env);
  for (const warning of _config.warnings) log.warn(`ttyd watcher configuration: ${warning}`);
  if (_config.disabled) {
    log.warn('ttyd watcher DISABLED — it will not restart a leaking ttyd; the health panel reports it as unknown', {
      disabledBy: _config.disabledBy
    });
    return;
  }
  if (_config.orphanThreshold !== DEFAULT_ORPHAN_THRESHOLD) {
    log.warn('ttyd watcher orphan threshold overridden', { orphanThreshold: _config.orphanThreshold });
  }

  log.debug('Starting ttyd watcher', {
    ttydLabel: _config.ttydLabel, intervalMs: _config.intervalMs, ptyThresholdRatio: _config.ptyThresholdRatio,
    orphanThreshold: _config.orphanThreshold, wedgeAgeMs: _config.wedgeAgeMs
  });

  _bootTimer = setTimeout(() => { _bootTimer = null; _tick(); }, 0);
  if (typeof _bootTimer.unref === 'function') _bootTimer.unref();
  _timer = setInterval(() => { _tick(); }, _config.intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

/**
 * Stop the watcher. Idempotent.
 */
function stop() {
  if (_bootTimer) {
    clearTimeout(_bootTimer);
    _bootTimer = null;
  }
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
  _runner = _defaultRunner;
  _clock = _defaultClock;
  _tickInFlight = false;
  _readingInFlight = null;
  _history = [];
  _lastReceipt = null;
  _expectingRestartFrom = null;
  _config = _resolveConfig({}, {});
}

/**
 * Inject a runner for tests: `(cmd, args) => string | Promise<string>`, throwing
 * (or rejecting) with `.status` set on nonzero exit.
 *
 * Module-global seam — call `_reset()` between tests to clear leftover state
 * and avoid leakage if other test files import this module concurrently.
 * @param {Function} fn
 */
function _setRunner(fn) {
  _runner = fn;
}

/**
 * Inject a clock for tests: `{ now(): number, sleep(ms): Promise<void> }`.
 * @param {{now: Function, sleep: Function}} clock
 */
function _setClock(clock) {
  _clock = clock;
}

/**
 * Apply a configuration without starting timers (test seam).
 * @param {object} options - `start()` options.
 * @param {object} [env={}] - Environment.
 * @returns {object} The configuration now in force.
 */
function _configure(options, env = {}) {
  _config = _resolveConfig(options, env);
  return _config;
}

module.exports = {
  start,
  stop,
  takeReading,
  classifyReading,
  measureLeak,
  latestReading,
  lastReceipt,
  _tick,
  _kickstartTtyd,
  _resolveConfig,
  _configure,
  _parsePid,
  _poolFromCounts,
  _parseChildren,
  _parseEtime,
  _setRunner,
  _setClock,
  _reset,
  DEFAULT_TTYD_LABEL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PTY_THRESHOLD,
  DEFAULT_ORPHAN_THRESHOLD,
  DEFAULT_WEDGE_AGE_MS,
  ORPHAN_THRESHOLD_MIN,
  ORPHAN_THRESHOLD_MAX,
  MIN_OBSERVATION_GAP_MS,
  RECEIPT_TIMEOUT_MS,
  ENV_WATCHER,
  ENV_ORPHAN_THRESHOLD
};
