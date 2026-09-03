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
 *               one-line fix.
 *   `clear`   — the condition was measured and is absent, or cannot exist on
 *               this platform (`detail` says which).
 *   `unknown` — the measurement itself failed; `detail` names why. This is never
 *               folded into `clear`: a probe that could not run has not said the
 *               machine is healthy, and the panel renders it as exactly that.
 *
 * Nothing here decides anything or restarts anything. The ttyd watcher keeps its
 * own fail-safe reading (0 on error) because it ACTS; this module reads the same
 * signals through `measureLeak`, where a failed reading stays null.
 *
 * Every probe is injectable (`_setProbes`) so each state is testable without a
 * launchd, a PTY pool, or a TCC-protected directory on the test machine.
 */

const os = require('node:os');
const path = require('node:path');
const ttydWatcher = require('./ttyd-watcher');
const serverInfo = require('./server-info');
const dirScanner = require('./dir-scanner');
const { createLogger } = require('./logger');

const log = createLogger('system-health');

const STATE_FIRED = 'fired';
const STATE_CLEAR = 'clear';
const STATE_UNKNOWN = 'unknown';

const TTYD_LABEL = ttydWatcher.DEFAULT_TTYD_LABEL;
const TTYD_REMEDIATION = `launchctl kickstart -k gui/$(id -u)/${TTYD_LABEL}`;
const FDA_REMEDIATION = 'System Settings → Privacy & Security → Full Disk Access → add the node binary '
  + 'TangleClaw runs (`which node`), then: launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server '
  + '— or keep every project outside ~/Documents, ~/Desktop and ~/Downloads';
const RESTART_FALLBACK_REMEDIATION = 'Restart the TangleClaw server process (no launchd job was found to restart it with)';

// The directory the Full Disk Access probe reads. `~/Documents` is the root the
// setup wizard's default projects directory sits under and the one #324/#859
// were hit on; `_protectedRoots` in server.js names the same three.
const TCC_PROBE_SUBDIR = 'Documents';
const TCC_PROBE_TIMEOUT_MS = 5000;

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
  measureLeak: (opts) => ttydWatcher.measureLeak(opts),
  serverInfo: () => serverInfo.getServerInfo(),
  probeDir: _defaultProbeDir
};

let _probes = { ..._defaultProbes };

/**
 * Build one condition record in the shape the route serves and the panel reads.
 * @param {string} id - Stable identifier (`ttyd-leak` | `stale-server` | `full-disk-access`).
 * @param {string} title - Short human name for the condition.
 * @param {'fired'|'clear'|'unknown'} state - The detector's verdict.
 * @param {string} detail - What was measured, or why it could not be.
 * @param {string} remediation - One-line fix; carried on every state so a
 *   client can show it wherever it chooses, but the panel shows it only on `fired`.
 * @returns {{id: string, title: string, state: string, detail: string, remediation: string}}
 */
function _condition(id, title, state, detail, remediation) {
  return { id, title, state, detail, remediation };
}

/**
 * Detector (a): ttyd PTY-pool exhaustion / leaked `tmux attach` children
 * (#94/#144/#380). Reads the watcher's own two gates through `measureLeak`.
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
  let m;
  try {
    m = probes.measureLeak({ ttydLabel: TTYD_LABEL });
  } catch (err) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `measurement threw: ${err.message}`, TTYD_REMEDIATION);
  }
  if (m.pid === null) {
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `launchd job ${TTYD_LABEL} is not running, so its child processes cannot be counted`,
      TTYD_REMEDIATION);
  }
  const poolFired = !!(m.pool && m.pool.exhausted);
  const orphanFired = m.orphans !== null && m.orphans >= m.orphanThreshold;
  if (poolFired || orphanFired) {
    const parts = [];
    if (poolFired) parts.push(`PTY pool ${m.pool.used}/${m.pool.cap} slots in use (threshold ${Math.round(m.ptyThresholdRatio * 100)}%)`);
    if (orphanFired) parts.push(`${m.orphans} leaked tmux clients under ttyd (threshold ${m.orphanThreshold})`);
    return _condition('ttyd-leak', title, STATE_FIRED, parts.join('; '), TTYD_REMEDIATION);
  }
  if (m.pool === null || m.orphans === null) {
    const failed = [];
    if (m.pool === null) failed.push('PTY pool (sysctl / ls /dev/ttys*)');
    if (m.orphans === null) failed.push('ttyd child processes (ps)');
    return _condition('ttyd-leak', title, STATE_UNKNOWN,
      `could not read ${failed.join(' and ')}`, TTYD_REMEDIATION);
  }
  return _condition('ttyd-leak', title, STATE_CLEAR,
    `PTY pool ${m.pool.used}/${m.pool.cap} slots in use; ${m.orphans} leaked tmux clients`,
    TTYD_REMEDIATION);
}

/**
 * Detector (b): the running server is older than the code on disk (#199).
 * Reuses `lib/server-info.js` — the same three-state `isStale` the stale-server
 * banner reads — rather than probing git a second time.
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
    return _condition('stale-server', title, STATE_FIRED, detail, remediation);
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
 * read on the event loop is the exact defect #859 fixed. A read that timed out
 * is the hazard; a read that answered is clear; a target that does not exist,
 * or any other error, is unknown — nothing was learned about the grant.
 *
 * @param {object} [probes=_probes] - Injected probes (test seam).
 * @returns {Promise<{id: string, title: string, state: string, detail: string, remediation: string}>}
 */
async function detectFullDiskAccess(probes = _probes) {
  const title = 'Full Disk Access missing';
  const platform = probes.platform();
  if (platform !== 'darwin') {
    return _condition('full-disk-access', title, STATE_CLEAR,
      `not applicable on ${platform}: there is no TCC gate on this platform`, FDA_REMEDIATION);
  }
  const target = path.join(probes.homedir(), TCC_PROBE_SUBDIR);
  try {
    const result = await probes.probeDir(target);
    return _condition('full-disk-access', title, STATE_CLEAR,
      `${target} answered (${result.entries} entries)`, FDA_REMEDIATION);
  } catch (err) {
    if (err && err.tcTimedOut) {
      return _condition('full-disk-access', title, STATE_FIRED,
        `${target} did not answer within ${TCC_PROBE_TIMEOUT_MS / 1000}s — on macOS that is what a protected folder does when node has no Full Disk Access`,
        FDA_REMEDIATION);
    }
    if (err && err.code === 'ENOENT') {
      return _condition('full-disk-access', title, STATE_UNKNOWN,
        `${target} does not exist, so there was nothing to probe`, FDA_REMEDIATION);
    }
    return _condition('full-disk-access', title, STATE_UNKNOWN,
      `probe of ${target} failed: ${(err && err.message) || String(err)}`, FDA_REMEDIATION);
  }
}

/**
 * Run every detector and assemble the payload `GET /api/system/health` serves.
 * Detectors never reject: each maps its own failure to `unknown`, so one broken
 * probe cannot take the other two conditions off the panel.
 *
 * @returns {Promise<{checkedAt: string, conditions: Array<{id: string, title: string, state: string, detail: string, remediation: string}>}>}
 */
async function getHealth() {
  const conditions = [
    detectTtydLeak(),
    detectStaleServer(),
    await detectFullDiskAccess()
  ];
  const fired = conditions.filter((c) => c.state === STATE_FIRED).map((c) => c.id);
  if (fired.length > 0) log.warn('system health conditions fired', { fired });
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
 * Restore the default probes (test seam).
 */
function _reset() {
  _probes = { ..._defaultProbes };
}

module.exports = {
  getHealth,
  detectTtydLeak,
  detectStaleServer,
  detectFullDiskAccess,
  _setProbes,
  _reset,
  STATE_FIRED,
  STATE_CLEAR,
  STATE_UNKNOWN,
  TTYD_REMEDIATION,
  FDA_REMEDIATION,
  TCC_PROBE_TIMEOUT_MS
};
