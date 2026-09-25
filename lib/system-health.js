'use strict';

/**
 * Machine-wide health detectors behind `GET /api/system/health` (#345).
 *
 * Three recurring conditions used to live only in memory files and issue
 * threads — the ttyd PTY-pool leak (#94/#144/#380), a server process older than
 * the code on disk (#199), and a launchd-spawned node without Full Disk Access
 * (#324/#859). Each detector here returns ONE of three states:
 *
 *   `fired`   — the condition was measured and is present; `remediation` is the
 *               one-line runnable fix, `hint` (when present) the prose around it.
 *   `clear`   — the condition was measured and is absent, or cannot exist on
 *               this platform (`detail` says which).
 *   `unknown` — the measurement itself failed; `detail` names why. This is never
 *               folded into `clear`: a probe that could not run has not said the
 *               machine is healthy, and the panel renders it as exactly that.
 *
 * Nothing here decides anything or restarts anything. The ttyd row reads the
 * watcher's own shared reading through `measureLeak` — the same measurement,
 * classification and thresholds the watcher acts on, with its PID, generation
 * and sample time — so the panel and the watchdog cannot disagree about one
 * instant. A failed measurement stays null there and is `unknown` here.
 *
 * NOTHING HERE SPAWNS ON THE REQUEST PATH. The ttyd reading shells out
 * (`launchctl`, `sysctl`, `ls`, `ps`) and `ps -A` on a box mid-PTY-exhaustion is
 * exactly the command that stalls — so the route reads a cached reading and, when
 * it is stale, STARTS a refresh it never awaits. The reading is warmed once at
 * boot (`warm()`), refreshed at most once per `TTYD_CACHE_TTL_MS` however many
 * tabs poll, and single-flighted so a slow measurement cannot pile up. The Full
 * Disk Access probe is a directory read in a scanner child under a hard deadline.
 *
 * Every probe is injectable (`_setProbes`) so each state is testable without a
 * launchd, a PTY pool, or a TCC-protected directory on the test machine.
 */

const os = require('node:os');
const path = require('node:path');
const ttydWatcher = require('./ttyd-watcher');
const serverInfo = require('./server-info');
const checkoutState = require('./checkout-state');
const dirScanner = require('./dir-scanner');
const { createLogger } = require('./logger');

const log = createLogger('system-health');
const medusa = require('./medusa');

const STATE_FIRED = 'fired';
const STATE_CLEAR = 'clear';
const STATE_UNKNOWN = 'unknown';

const TTYD_LABEL = ttydWatcher.DEFAULT_TTYD_LABEL;
const TTYD_REMEDIATION = `launchctl kickstart -k gui/$(id -u)/${TTYD_LABEL}`;
const SERVER_RESTART = 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server';
// The runnable line is the restart that makes a fresh grant take effect; the
// grant itself is a System Settings gesture, which is prose, not a command.
const FDA_REMEDIATION = SERVER_RESTART;
const FDA_HINT = 'First grant Full Disk Access to the node binary TangleClaw runs (`which node`) in '
  + 'System Settings → Privacy & Security → Full Disk Access, then run the restart — '
  + 'or keep every project outside ~/Documents, ~/Desktop and ~/Downloads.';
const RESTART_FALLBACK_REMEDIATION = 'Restart the TangleClaw server process (no launchd job or qualifying systemd user unit was found to restart it with)';

// The directory the Full Disk Access probe reads. `~/Documents` is the root the
// setup wizard's default projects directory sits under and the one #324/#859
// were hit on; `_protectedRoots` in server.js names the same three.
const TCC_PROBE_SUBDIR = 'Documents';
const TCC_PROBE_TIMEOUT_MS = 5000;

// How long one ttyd reading is served before a refresh is started. Matches the
// dashboard's poll, so a single tab costs one measurement per minute and ten
// tabs still cost one.
const TTYD_CACHE_TTL_MS = 60 * 1000;

// A scanner of its own rather than the dashboard's shared background one: a
// probe that hangs kills the child it rides in, and every sibling request in
// that child dies with it. Sharing would let this panel's read cost the
// projects poll its answer. Forked lazily, so a server never asked for health
// never pays for it; the child exits on disconnect like the others.
let _healthScanner = null;

/**
 * The scanner instance the Full Disk Access probe uses, created on first use.
 * @returns {{request: Function, shutdown: Function}}
 */
function _scanner() {
  if (!_healthScanner) _healthScanner = dirScanner.createScanner();
  return _healthScanner;
}

/**
 * Read one directory in the scanner child under a deadline. Resolves when the
 * read answered; rejects with the scanner's error (carrying `tcTimedOut` when
 * the path never answered) otherwise.
 * @param {string} dir - Absolute path to read.
 * @returns {Promise<{entries: number}>}
 */
function _defaultProbeDir(dir) {
  return _scanner().request('probeDir', { dir }, {
    timeoutMs: TCC_PROBE_TIMEOUT_MS,
    what: `health probe of ${dir}`,
    // Opt into the backoff: a path that did not answer is not asked again for
    // 30s, widening to 5 minutes, so a dashboard polling this route cannot
    // turn one unreadable folder into a killed child per poll.
    pathKey: dir
  });
}

const _defaultProbes = {
  platform: () => process.platform,
  homedir: () => os.homedir(),
  now: () => Date.now(),
  measureLeak: () => ttydWatcher.measureLeak(),
  // The watcher's newest reading, so a cached panel reading of a ttyd that has
  // since been restarted is dropped instead of being served as current.
  latestGeneration: () => {
    const r = ttydWatcher.latestReading();
    return r ? r.generation : null;
  },
  serverInfo: () => serverInfo.getServerInfo(),
  // The same cached classification the stale banner reads, so the two cannot
  // disagree about whether a restart would load anything.
  restartImpact: (info) => checkoutState.impactSnapshot(serverInfo.getRepoRoot(), info.startupSha, info.currentDiskSha),
  probeDir: _defaultProbeDir,
  medusaListenerCount: () => medusa.activeListenerCount(),
  medusaBridgeHealth: () => medusa.checkBridgeHealth()
};

let _probes = { ..._defaultProbes };

// The cached ttyd reading. `at === 0` means no measurement has completed yet;
// `error` is set when the last one threw. `inFlight` is the single-flight
// promise, so however many requests find the reading stale, one refresh runs.
let _ttyd = { reading: null, error: null, at: 0, inFlight: null };

// The set of condition ids that fired at the last `getHealth`, as a key, so the
// warn log fires on a transition rather than on every poll of every tab.
let _lastFiredKey = null;

/**
 * Build one condition record in the shape the route serves and the panel reads.
 * @param {string} id - Stable identifier, unique across the detector list.
 * @param {string} title - Short human name for the condition.
 * @param {'fired'|'clear'|'unknown'} state - The detector's verdict.
 * @param {string} detail - What was measured, or why it could not be.
 * @param {string} remediation - One-line runnable fix; carried on every state so
 *   a client can show it wherever it chooses, but the panel shows it only on `fired`.
 * @param {string} [hint] - Prose around the fix (a Settings gesture, an alternative).
 * @returns {{id: string, title: string, state: string, detail: string, remediation: string, hint?: string}}
 */
function _condition(id, title, state, detail, remediation, hint) {
  const c = { id, title, state, detail, remediation };
  if (hint) c.hint = hint;
  return c;
}

/**
 * Start a ttyd measurement unless one is already running. Never awaited by a
 * request: the result lands in `_ttyd` when it lands, and the NEXT read serves
 * it. A measurement that throws is recorded as such (rendered `unknown`), and
 * one that never settles leaves the last good reading in place.
 * @param {object} probes - The probes in force.
 * @returns {Promise<void>} The in-flight refresh (a test seam; production ignores it).
 */
function _refreshTtyd(probes) {
  if (_ttyd.inFlight) return _ttyd.inFlight;
  _ttyd.inFlight = Promise.resolve()
    .then(() => probes.measureLeak())
    .then(
      (reading) => { _ttyd.reading = reading; _ttyd.error = null; _ttyd.at = probes.now(); },
      (err) => { _ttyd.reading = null; _ttyd.error = err; _ttyd.at = probes.now(); }
    )
    .finally(() => { _ttyd.inFlight = null; });
  return _ttyd.inFlight;
}

/**
 * Take the first ttyd reading at boot so the dashboard's first poll after a
 * restart finds a measurement rather than "still running". No-op off macOS,
 * where the condition cannot exist. Fire-and-forget.
 * @returns {void}
 */
function warm() {
  if (_probes.platform() !== 'darwin') return;
  _refreshTtyd(_probes);
}

/**
 * Detector (a): ttyd PTY-pool exhaustion / leaked `tmux attach` children
 * (#94/#144/#380). Classifies the CACHED reading from `measureLeak`, starting a
 * refresh when it is older than `TTYD_CACHE_TTL_MS` — never waiting for one.
 *
 * Fires when EITHER gate trips. Clear only when BOTH were measured and neither
 * tripped — one gate measured clear beside one that could not be read is
 * `unknown`, because the watcher's own history (#380: 90 orphans at pool ratio
 * 0.45) is that the gates disagree exactly when it matters.
 *
 * @param {object} [probes=_probes] - Injected probes (test seam).
 * @returns {{id: string, title: string, state: string, detail: string, remediation: string}}
 */
function detectTtydLeak(probes = _probes) {
  const title = 'Terminal (ttyd) PTY leak';
  const platform = probes.platform();
  if (platform !== 'darwin') {
    return _condition('ttyd-leak', title, STATE_CLEAR,
      `not applicable on ${platform}: the leak is a macOS kernel behaviour and the watcher only runs there`,
      TTYD_REMEDIATION);
  }
  // A cached reading of a ttyd that has since been replaced describes a process
  // that no longer exists. Drop it and re-measure rather than serve its counts.
  const latestGeneration = probes.latestGeneration ? probes.latestGeneration() : null;
  const cachedGeneration = _ttyd.reading ? _ttyd.reading.generation : null;
  const replaced = !!(latestGeneration && cachedGeneration && latestGeneration !== cachedGeneration);
  if (_ttyd.at === 0 || replaced || probes.now() - _ttyd.at >= TTYD_CACHE_TTL_MS) {
    _refreshTtyd(probes);
  }
  if (_ttyd.at === 0) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      'the first measurement is still running; it is taken off the request path and will be here on the next poll',
      TTYD_REMEDIATION);
  }
  if (replaced) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      'ttyd has restarted since the last reading; the new process is being measured and will be here on the next poll',
      TTYD_REMEDIATION);
  }
  if (_ttyd.error) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `measurement threw: ${_ttyd.error.message}`, TTYD_REMEDIATION);
  }
  const m = _ttyd.reading;
  if (m.pid === null) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `launchd job ${TTYD_LABEL} is not running, so its child processes cannot be counted`,
      TTYD_REMEDIATION);
  }
  return _withReading(_classifyTtyd(m, title), m);
}

/**
 * The verdict for one ttyd reading that has a running process behind it.
 * @param {object} m - The `measureLeak` summary.
 * @param {string} title - The condition's title.
 * @returns {{id: string, title: string, state: string, detail: string, remediation: string}}
 */
function _classifyTtyd(m, title) {
  const poolFired = !!(m.pool && m.pool.exhausted);
  const orphanFired = m.orphans !== null && m.orphans >= m.orphanThreshold;
  // Children exiting right now but not yet seen exiting long enough to be
  // confirmed: the normal cost of tabs closing. Named so a reconnect burst is
  // visible without being counted as a leak, which is also exactly what the
  // watcher does with them.
  const transientNote = m.transient > 0
    ? `${m.transient} more exiting but not yet confirmed wedged (not yet seen exiting for ${Math.round(m.wedgeAgeMs / 1000)}s)`
    : null;
  // With the watcher switched off nothing restarts a leaking ttyd, so the panel
  // is the only prompt left. A leak it can see must still read as fired; only a
  // HEALTHY reading is downgraded, because "clear" would claim a safety net
  // that is not there.
  const disabledNote = m.disabled
    ? `the ttyd watcher is disabled (${m.disabledBy}), so nothing will restart a leaking ttyd`
    : null;
  if (poolFired || orphanFired) {
    const parts = [];
    if (poolFired) parts.push(`PTY pool ${m.pool.used}/${m.pool.cap} slots in use (threshold ${Math.round(m.ptyThresholdRatio * 100)}%)`);
    if (orphanFired) parts.push(`${m.orphans} leaked tmux clients under ttyd (threshold ${m.orphanThreshold})`);
    if (transientNote) parts.push(transientNote);
    if (disabledNote) parts.push(`${disabledNote}: restart it by hand`);
    return _condition('ttyd-leak', title, STATE_FIRED, parts.join('; '), TTYD_REMEDIATION);
  }
  if (m.pool === null || m.orphans === null) {
    const failed = [];
    if (m.pool === null) failed.push('PTY pool (sysctl / ls /dev/ttys*)');
    if (m.orphans === null) failed.push('ttyd child processes (ps)');
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `could not read ${failed.join(' and ')}` + (disabledNote ? `; ${disabledNote}` : ''), TTYD_REMEDIATION);
  }
  const counts = `PTY pool ${m.pool.used}/${m.pool.cap} slots in use; ${m.orphans} leaked tmux clients`
    + (transientNote ? `; ${transientNote}` : '');
  if (disabledNote) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN, `${disabledNote}; ${counts}`, TTYD_REMEDIATION);
  }
  return _condition('ttyd-leak', title, STATE_CLEAR, counts, TTYD_REMEDIATION);
}

/**
 * Attach the identity of the reading a ttyd verdict was made from, and the last
 * kickstart receipt, so a reader can tell WHICH ttyd and WHEN — the payload's
 * `checkedAt` is the request time, which says nothing about how old the reading is.
 * @param {object} condition - The verdict.
 * @param {object} m - The `measureLeak` summary it came from.
 * @returns {object} The same condition, extended.
 */
function _withReading(condition, m) {
  condition.reading = {
    pid: m.pid,
    generation: m.generation,
    sampledAt: typeof m.sampledAt === 'number' ? new Date(m.sampledAt).toISOString() : null
  };
  condition.lastReceipt = m.lastReceipt || null;
  return condition;
}

/**
 * The restart-impact verdict for a stale server, or `'unknown'` when the
 * classification cannot be read.
 * @param {object} probes - Injected probes.
 * @param {object} info - Server info.
 * @returns {string} `records-only`, `executable`, `mixed`, `pending` or `unknown`.
 */
function _restartImpact(probes, info) {
  try {
    const snap = probes.restartImpact(info);
    return (snap && typeof snap.impact === 'string') ? snap.impact : 'unknown';
  } catch (err) {
    log.warn('restart-impact read failed during the stale-server check', { error: err.message });
    return 'unknown';
  }
}

/**
 * Detector (b): the running server is older than the code on disk (#199).
 * Reuses `lib/server-info.js` — the same three-state `isStale` the stale-server
 * banner reads — rather than probing git a second time, and the same cached
 * restart-impact classification: a range of records-only commits (docs,
 * tests, plans) is clear, because a restart would load nothing.
 *
 * @param {object} [probes=_probes] - Injected probes (test seam).
 * @returns {{id: string, title: string, state: string, detail: string, remediation: string}}
 */
function detectStaleServer(probes = _probes) {
  const title = 'Server running old code';
  let info;
  try {
    info = probes.serverInfo();
  } catch (err) {
    return _condition('stale-server', title, STATE_UNKNOWN,
      `server-info read threw: ${err.message}`, RESTART_FALLBACK_REMEDIATION);
  }
  const remediation = serverInfo.buildRestartCommand(info.restartMechanism) || RESTART_FALLBACK_REMEDIATION;
  if (info.isStale === true) {
    const versionMoved = info.runningVersion && info.diskVersion && info.runningVersion !== info.diskVersion;
    const detail = versionMoved
      ? `running v${info.runningVersion}, v${info.diskVersion} is on disk`
      : `running ${String(info.startupSha || '?').slice(0, 7)}, disk is at ${String(info.currentDiskSha || '?').slice(0, 7)}`
        + (info.commitsAhead > 0 ? ` (${info.commitsAhead} commit${info.commitsAhead === 1 ? '' : 's'} ahead)` : '');
    const impact = _restartImpact(probes, info);
    // Only a range classified records-only clears: missing or unfinished
    // evidence never downgrades the condition.
    if (impact === 'records-only') {
      return _condition('stale-server', title, STATE_CLEAR, `${detail}: records-only commits, no restart needed`, remediation);
    }
    if (impact === 'executable' || impact === 'mixed') {
      return _condition('stale-server', title, STATE_FIRED, detail, remediation);
    }
    return _condition('stale-server', title, STATE_FIRED, `${detail}; restart impact unknown`, remediation);
  }
  if (info.isStale === false) {
    return _condition('stale-server', title, STATE_CLEAR,
      info.startupSha ? `running ${String(info.startupSha).slice(0, 7)}, same as disk` : 'running code matches disk',
      remediation);
  }
  return _condition('stale-server', title, STATE_UNKNOWN,
    info.staleUnknownReason || 'staleness could not be determined', remediation);
}

/**
 * Detector (c): the install / launchd TCC hazard (#324, #859) — this node
 * process lacks Full Disk Access, so a read under `~/Documents` never returns.
 *
 * Measured the way the product already survives it: the read runs in a
 * scanner child under a deadline (`lib/dir-scanner.js`), because an in-process
 * read on the event loop is the exact defect #859 fixed. Two outcomes are the
 * hazard: a read that timed out (the launchd case — no error, no answer), and
 * an `EPERM`/`EACCES` refusal (the case where macOS does answer, and answers
 * no). A read that answered is clear; a target that does not exist, or any
 * other error, is unknown — nothing was learned about the grant.
 *
 * @param {object} [probes=_probes] - Injected probes (test seam).
 * @returns {Promise<{id: string, title: string, state: string, detail: string, remediation: string, hint?: string}>}
 */
async function detectFullDiskAccess(probes = _probes) {
  const title = 'Full Disk Access missing';
  const platform = probes.platform();
  if (platform !== 'darwin') {
    return _condition('full-disk-access', title, STATE_CLEAR,
      `not applicable on ${platform}: there is no TCC gate on this platform`, FDA_REMEDIATION, FDA_HINT);
  }
  const target = path.join(probes.homedir(), TCC_PROBE_SUBDIR);
  try {
    const result = await probes.probeDir(target);
    return _condition('full-disk-access', title, STATE_CLEAR,
      `${target} answered (${result.entries} entries)`, FDA_REMEDIATION, FDA_HINT);
  } catch (err) {
    if (err && err.tcTimedOut) {
      return _condition('full-disk-access', title, STATE_FIRED,
        `${target} did not answer within ${TCC_PROBE_TIMEOUT_MS / 1000}s — on macOS that is what a protected folder does when node has no Full Disk Access`,
        FDA_REMEDIATION, FDA_HINT);
    }
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return _condition('full-disk-access', title, STATE_FIRED,
        `${target} refused the read (${err.code}) — macOS denies a process without Full Disk Access`,
        FDA_REMEDIATION, FDA_HINT);
    }
    if (err && err.code === 'ENOENT') {
      return _condition('full-disk-access', title, STATE_UNKNOWN,
        `${target} does not exist, so there was nothing to probe`, FDA_REMEDIATION, FDA_HINT);
    }
    return _condition('full-disk-access', title, STATE_UNKNOWN,
      `probe of ${target} failed: ${(err && err.message) || String(err)}`, FDA_REMEDIATION, FDA_HINT);
  }
}

/**
 * A Bridge that is required and not there (#1130).
 *
 * Fires only when something is actually depending on it — at least one listener
 * is running — because a host that has never enabled Medusa does not have a
 * problem, and a condition that fires on every install is one operators learn to
 * ignore. That count comes from the listener map rather than the sessions table:
 * the Project Master has no sessions row (ADR 0008) and was the first listener
 * the reporting install saw fail, so a sessions walk would skip exactly it.
 *
 * The `unknown` state is real here and belongs to this function rather than to
 * the probe: `checkBridgeHealth` always reaches a verdict, so the only way to
 * have no answer is to have failed to reach it at all.
 *
 * @param {typeof _defaultProbes} [probes] - Probe seam, like every other detector
 *   here. Deliberately NOT a private `deps` object: `getHealth` calls the
 *   detectors with no arguments, so a second seam would be unreachable from a
 *   `_setProbes` test of the whole payload — and a suite that happened to start a
 *   listener would then make real network calls from a unit test.
 * @returns {Promise<{id: string, title: string, state: string, detail: string, remediation: string, hint?: string}>}
 */
async function detectMedusaBridge(probes = _probes) {
  const title = 'Medusa Bridge reachable';
  const count = probes.medusaListenerCount;
  const check = probes.medusaBridgeHealth;
  let listenerCount;
  try {
    listenerCount = count();
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- this panel must degrade, never throw:
    // one condition that cannot be evaluated may not take the others off the panel.
    return _condition('medusa-bridge', title, STATE_UNKNOWN,
      `Could not tell whether any session has Medusa enabled: ${err.message}`,
      'Retry; if it persists the Medusa integration is failing to load.');
  }
  if (listenerCount === 0) {
    return _condition('medusa-bridge', title, STATE_CLEAR,
      'No session has Medusa enabled, so no Bridge is required.', '');
  }

  let health;
  try {
    health = await check();
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- same reason; a probe that throws is a
    // check we could not make, which is `unknown`, not a Bridge that is absent.
    return _condition('medusa-bridge', title, STATE_UNKNOWN,
      `${listenerCount} listener(s) are running but the Bridge could not be checked: ${err.message}`,
      'Retry; if it persists, check the Bridge by hand at its configured URL.');
  }

  if (health.code === medusa.BRIDGE_HEALTH_CODES.UNKNOWN) {
    // A probe deadline expired, so nothing about the Bridge was established.
    // Reporting `fired` here would assert a definite negative about a check that
    // merely did not finish — the exact false certainty this condition exists to
    // remove, one layer up from the ABSENT/UNKNOWN split inside the probe.
    return _condition('medusa-bridge', title, STATE_UNKNOWN,
      `${listenerCount} listener(s) are enabled and ${health.detail}`,
      `curl -sS ${health.httpUrl}/health`,
      health.hint || 'Retry, or reach the endpoints by hand.');
  }
  if (health.healthy) {
    return _condition('medusa-bridge', title, STATE_CLEAR,
      `${listenerCount} listener(s) running against a Bridge answering on both transports`
        + `${health.version ? ` (v${health.version})` : ''}.`, '');
  }
  return _condition('medusa-bridge', title, STATE_FIRED,
    `${listenerCount} listener(s) are enabled but the Bridge is not usable (${health.code}) — ${health.detail}`,
    `curl -sS ${health.httpUrl}/health`,
    health.hint || 'Check the Medusa Bridge on this host.');
}

/**
 * Run every detector and assemble the payload `GET /api/system/health` serves.
 * Detectors never reject: each maps its own failure to `unknown`, so one broken
 * probe cannot take the OTHER conditions off the panel. The fired set is
 * logged when it CHANGES — a condition that stays fired across a hundred polls
 * is one warn line, and its clearing is one info line.
 *
 * @returns {Promise<{checkedAt: string, conditions: Array<{id: string, title: string, state: string, detail: string, remediation: string, hint?: string}>}>}
 */
async function getHealth() {
  const conditions = [
    detectTtydLeak(),
    detectStaleServer(),
    await detectFullDiskAccess(),
    await detectMedusaBridge()
  ];
  const fired = conditions.filter((c) => c.state === STATE_FIRED).map((c) => c.id);
  const key = fired.join(',');
  if (key !== _lastFiredKey) {
    if (fired.length > 0) log.warn('system health conditions fired', { fired });
    else if (_lastFiredKey) log.info('system health conditions cleared', { previously: _lastFiredKey.split(',') });
    _lastFiredKey = key;
  }
  return { checkedAt: new Date().toISOString(), conditions };
}

/**
 * Replace probes for tests. Partial: unnamed probes keep their defaults.
 * @param {Partial<typeof _defaultProbes>} overrides - Probe functions to swap in.
 */
function _setProbes(overrides) {
  _probes = { ..._defaultProbes, ...overrides };
}

/**
 * Wait for the in-flight ttyd refresh, if any (test seam — production never
 * awaits a measurement on a request).
 * @returns {Promise<void>}
 */
function _settleTtyd() {
  return _ttyd.inFlight || Promise.resolve();
}

/**
 * Restore the default probes and drop the cached reading (test seam).
 */
function _reset() {
  _probes = { ..._defaultProbes };
  _ttyd = { reading: null, error: null, at: 0, inFlight: null };
  _lastFiredKey = null;
}

module.exports = {
  getHealth,
  warm,
  detectTtydLeak,
  detectStaleServer,
  detectFullDiskAccess,
  detectMedusaBridge,
  _setProbes,
  _settleTtyd,
  _reset,
  STATE_FIRED,
  STATE_CLEAR,
  STATE_UNKNOWN,
  TTYD_REMEDIATION,
  FDA_REMEDIATION,
  FDA_HINT,
  TCC_PROBE_TIMEOUT_MS,
  TTYD_CACHE_TTL_MS
};
