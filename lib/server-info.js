'use strict';

/**
 * Server runtime-vs-disk diff detection (#199).
 *
 * Node caches required modules at process start. When the operator
 * pulls or merges new code while the TC server is running, the on-disk
 * code advances but the running process keeps using the in-memory copy
 * until restart. The browser, by contrast, fetches fresh static assets
 * each page load — so the front-end shows the latest UI while the
 * server still runs old behaviour. This produces silent-mismatch bugs
 * (e.g. the #199-surfacing case: Feature Index toggle clicked in a
 * post-#208 UI, sent to a pre-#208 backend that doesn't recognize
 * `featureIndexEnabled` and silently drops it on save).
 *
 * This module captures the git HEAD SHA at server boot and exposes a
 * snapshot comparison API that the front-end can poll to surface a
 * "server is stale, restart to load N new commit(s)" banner.
 *
 * **No-git fallback.** When TC is run outside a git checkout (tarball
 * install, packaged distribution, CI), `git rev-parse HEAD` fails and
 * `startupSha` / `currentDiskSha` both stay `null`. `isStale` reduces
 * to `false` in that case so the banner never fires — the
 * detection is opt-in via the presence of a git working tree.
 *
 * **Three-state staleness (#1118).** A git probe that *fails* (timeout,
 * transient exec error) is not the same as the designed no-git fallback,
 * and rendering it as `isStale: false` reports unknown as a fact — the
 * failure mode that left this install undetectable while the disk was
 * three commits ahead. `isStale` is therefore `true | false | null`:
 * `null` means "cannot determine", with `staleUnknownReason` saying why.
 * A boot-time probe failure no longer latches for the process lifetime:
 * the first later probe that succeeds is adopted as a *late baseline*
 * (`shaBaselineSource: 'late'`) — commits merged before that moment are
 * undetectable, but everything after it is watched again.
 *
 * **Dirty tree.** Uncommitted local changes don't bump HEAD so they
 * don't surface here: this module detects merged-since-startup commits
 * only. What the checkout itself is on — branch, unpushed commits,
 * uncommitted and untracked files — is `lib/checkout-state.js`, carried
 * beside this payload as `liveCheckout` (#993).
 *
 * @module lib/server-info
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createLogger } = require('./logger');

const _repoRoot = path.resolve(__dirname, '..');
const _log = createLogger('server-info');

// Captured by `captureStartup()` once at server boot. Tests use
// `_resetForTest()` to clear state between cases.
let _startupSha = null;
let _startupShaError = null; // null | 'no-git' | 'failed' — why _startupSha is null
let _shaBaselineSource = null; // 'startup' | 'late' | null — how the SHA baseline was obtained
let _startupTs = null;
let _startupVersion = null;
let _restartMechanism = undefined; // undefined = not yet detected; null = no mechanism available
let _systemdProbeAt = 0; // when the systemd unit was last queried (ms since epoch); see detectRestartMechanism()
let _systemdProbeInFlight = null; // the pending query, shared by concurrent callers
let _systemdLastReason = null; // last reason logged for a disqualified unit, so a repeat is not re-logged
let _systemdGeneration = 0; // bumped by a state reset; a query from an older generation is discarded
let _bindConfig = null; // the config the socket was bound from; see setBindConfig()
let _ttydNotice = null; // set once at boot; see setTtydNotice()
let _caddyDriftNotice = null; // set once at boot in caddy mode; see setCaddyDriftNotice()

const GIT_TIMEOUT_MS = 5000;

// macOS launchd plist installed by `deploy/install.sh`. When present
// AND the host is macOS, restartMechanism is 'launchctl' and the
// frontend "Restart TangleClaw" button is enabled (#235). Linux uses a
// systemd user unit instead (below).
const MACOS_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tangleclaw.server.plist');

// Linux systemd USER unit — the equivalent of the per-user launchd job.
// Only a user unit qualifies: the server runs unprivileged, so a system-wide
// unit is one it cannot restart without root or a polkit grant. No installer
// writes it yet (#1424); an operator who installs it by hand gets the button
// once systemd confirms it is safe (see probeSystemdUserUnit).
const SYSTEMD_USER_UNIT = 'tangleclaw.service';
const SYSTEMCTL_TIMEOUT_MS = 3000;
// How long a "no" from systemd stands before it is asked again. A "no" is
// often fixed by the operator (daemon-reload, a corrected unit) without
// restarting the server, so it must not be final.
const SYSTEMD_REPROBE_MS = 30000;

/**
 * Classify why a git probe threw. `'no-git'` is the designed fallback —
 * the binary is missing (ENOENT) or the directory is not a repository —
 * where SHA detection legitimately opts out. Everything else (timeout,
 * transient exec failure) is `'failed'`: git was expected to work and
 * did not, so the caller must treat the state as unknown, not absent.
 *
 * @param {Error & {code?: string, stderr?: string|Buffer}} err
 * @returns {'no-git'|'failed'}
 */
function _classifyGitError(err) {
  if (err && err.code === 'ENOENT') return 'no-git';
  const text = `${(err && err.message) || ''} ${(err && err.stderr) || ''}`;
  if (/not a git repo/i.test(text)) return 'no-git';
  return 'failed';
}

/**
 * Run `git rev-parse HEAD` in the TC repo root. Never throws. A miss
 * carries its reason — `'no-git'` (designed fallback) vs `'failed'` (a
 * probe that should have worked) — because the two demand different
 * downstream honesty: no-git disables detection by design, a failure
 * makes staleness *unknown* (#1118).
 *
 * @returns {{sha: string|null, error: 'no-git'|'failed'|null, detail: string|null}}
 */
function _probeSha() {
  try {
    const out = _internal.execSync('git rev-parse HEAD', {
      cwd: _internal.repoRoot,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const trimmed = String(out || '').trim();
    if (trimmed.length > 0) return { sha: trimmed, error: null, detail: null };
    return { sha: null, error: 'failed', detail: 'empty rev-parse output' };
  } catch (err) {
    return { sha: null, error: _classifyGitError(err), detail: String((err && err.message) || err) };
  }
}


/**
 * Read the version from `version.json` at the repo root. Returns `null`
 * on any failure. Never throws.
 *
 * Deliberately re-read on every call rather than cached: the self-updater
 * rewrites this file by checking out a release tag while the process keeps
 * running, so a cached value would describe the process, not the disk.
 *
 * @returns {string|null}
 */
function _readDiskVersion() {
  try {
    const raw = _internal.readFileSync(path.join(_internal.repoRoot, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const v = parsed && parsed.version;
    return (typeof v === 'string' && v.length > 0) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Count commits between `startupSha` and current HEAD. Returns 0 when
 * either side is null or the range is empty (i.e. no advancement).
 * Never throws.
 *
 * @param {string} startupSha
 * @param {string} currentSha
 * @returns {number}
 */
function _countCommitsAhead(startupSha, currentSha) {
  if (!startupSha || !currentSha || startupSha === currentSha) return 0;
  try {
    const out = _internal.execSync(`git rev-list ${startupSha}..${currentSha} --count`, {
      cwd: _internal.repoRoot,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const n = parseInt(String(out || '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Capture the startup SHA + timestamp. Idempotent — subsequent calls
 * are no-ops. Server boot calls this once; everything else reads via
 * `getServerInfo()`.
 *
 * @returns {{startupSha: string|null, startedAt: string}}
 */
function captureStartup() {
  if (_startupTs !== null) {
    return { startupSha: _startupSha, startedAt: _startupTs };
  }
  _startupTs = new Date().toISOString();
  const probe = _probeSha();
  _startupSha = probe.sha;
  _startupShaError = probe.sha ? null : probe.error;
  _shaBaselineSource = probe.sha ? 'startup' : null;
  if (_startupShaError === 'failed') {
    // Without this line the miss is invisible until an operator notices the
    // absence of a banner — the way #1118 was actually found.
    _log.warn('startup SHA capture failed — stale-server detection degraded until a later probe succeeds', { detail: probe.detail });
  }
  _startupVersion = _readDiskVersion();
  return { startupSha: _startupSha, startedAt: _startupTs };
}

/**
 * The version this process actually loaded, captured once at startup.
 *
 * Deliberately NOT a fresh read of `version.json`. The working tree and the
 * running process diverge for the whole window between a self-update's
 * checkout and the restart that loads it — the state `getServerInfo()` reports
 * as `versionStale`. Anything answering "which version is running?" from disk
 * announces the new release while the old code is still serving, which is the
 * one moment the answer carries weight.
 *
 * Returns `null` before `captureStartup()` has run, so callers can fall back to
 * saying nothing rather than to a version they cannot vouch for.
 *
 * @returns {string|null} Semver string, or null when startup was never captured.
 */
function getRunningVersion() {
  return _startupVersion;
}

/**
 * Ask systemd whether restarting the user unit is safe for THIS process.
 *
 * Reads the unit as systemd has it loaded, not as it sits on disk, so
 * drop-ins, every configuration directory and a pending `daemon-reload` are
 * all accounted for. Safe means all three hold:
 * - `MainPID` is this process — the unit is what runs this server, so the
 *   restart replaces it rather than failing to bind a second copy;
 * - `KillMode=process` — the default, `control-group`, stops every process
 *   in the unit's cgroup, including a tmux server the server started, while
 *   the restart dialog promises that sessions survive;
 * - `NeedDaemonReload=no` — edited unit files are not yet in force, so a
 *   restart would still use the old settings.
 *
 * Runs `systemctl` asynchronously, without a shell, and never rejects: a
 * slow user manager must not stall the server. `reason` is null when there
 * is simply no such unit, which is the normal case on a host that does not
 * run TangleClaw under systemd and not worth reporting.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
async function probeSystemdUserUnit() {
  let out;
  try {
    const result = await _internal.execFileAsync('systemctl',
      ['--user', 'show', SYSTEMD_USER_UNIT, '-p', 'LoadState', '-p', 'MainPID', '-p', 'KillMode', '-p', 'NeedDaemonReload'],
      { encoding: 'utf8', timeout: SYSTEMCTL_TIMEOUT_MS });
    out = result.stdout;
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: null }; // no systemctl on this host
    const detail = err && err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, reason: `systemctl --user show failed: ${detail || (err && err.message) || 'unknown error'}` };
  }
  const props = {};
  for (const line of String(out).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  if (props.LoadState !== 'loaded') return { ok: false, reason: null };
  if (props.MainPID !== String(_internal.pid())) {
    return { ok: false, reason: `${SYSTEMD_USER_UNIT} is not running this server (its MainPID is ${props.MainPID || 'unknown'})` };
  }
  if (props.KillMode !== 'process') {
    return { ok: false, reason: `${SYSTEMD_USER_UNIT} has KillMode=${props.KillMode || 'unknown'}; a restart would end every tmux session — set KillMode=process` };
  }
  if (props.NeedDaemonReload !== 'no') {
    return { ok: false, reason: `${SYSTEMD_USER_UNIT} changed on disk since systemd loaded it — run systemctl --user daemon-reload` };
  }
  return { ok: true, reason: null };
}

/**
 * Query systemd and record the answer as the cached mechanism. Concurrent
 * callers share one query. A disqualified unit's reason is logged when it
 * first appears or changes, not on every re-query.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
function refreshSystemdMechanism() {
  if (_systemdProbeInFlight) return _systemdProbeInFlight;
  const generation = _systemdGeneration;
  _systemdProbeAt = _internal.now();
  _systemdProbeInFlight = probeSystemdUserUnit().then((probe) => {
    if (generation !== _systemdGeneration) return probe; // state was reset while this query ran
    _restartMechanism = probe.ok ? 'systemctl' : null;
    if (probe.reason && probe.reason !== _systemdLastReason) {
      _log.info('restart button disabled', { reason: probe.reason });
    }
    _systemdLastReason = probe.reason;
    return probe;
  }).finally(() => {
    if (generation === _systemdGeneration) _systemdProbeInFlight = null;
  });
  return _systemdProbeInFlight;
}

/**
 * The process-manager mechanism the server can use to restart itself
 * (#235): macOS launchd via the per-user plist, or a Linux systemd user
 * unit that systemd confirms is safe to restart (see
 * {@link probeSystemdUserUnit}). Other hosts (sysvinit, bare-node,
 * Windows) have no mechanism.
 *
 * Synchronous and cheap: it returns the cached answer. On Linux the answer
 * comes from a background systemd query — `server.js` starts one at boot,
 * and a "no" (or no answer yet) starts another here once
 * {@link SYSTEMD_REPROBE_MS} has passed, so a unit the operator fixes brings
 * the button back on a later poll without a server restart. A "yes" stands
 * until {@link confirmRestartMechanism} finds otherwise.
 *
 * @returns {'launchctl'|'systemctl'|null}
 */
function detectRestartMechanism() {
  const platform = _internal.platform();
  if (platform !== 'linux') {
    if (_restartMechanism === undefined) {
      _restartMechanism = platform === 'darwin' && _internal.existsSync(MACOS_PLIST_PATH) ? 'launchctl' : null;
    }
    return _restartMechanism;
  }
  if (_restartMechanism !== 'systemctl' && !_systemdProbeInFlight
      && _internal.now() - _systemdProbeAt >= SYSTEMD_REPROBE_MS) {
    refreshSystemdMechanism().catch((err) => {
      _log.warn('restart mechanism query failed', { error: err && err.message });
    });
  }
  return _restartMechanism === undefined ? null : _restartMechanism;
}

/**
 * Re-check, at the moment of a restart, that the mechanism is still safe to
 * use. launchd needs no re-check. For systemd the unit is queried again
 * (without blocking the server); when it no longer qualifies, the cached
 * answer becomes "no" until a later query says otherwise.
 *
 * @param {string|null} mechanism - Return value of `detectRestartMechanism()`
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
async function confirmRestartMechanism(mechanism) {
  if (mechanism !== 'systemctl') return { ok: true, reason: null };
  const probe = await refreshSystemdMechanism();
  if (!probe.ok) {
    return { ok: false, reason: probe.reason || `${SYSTEMD_USER_UNIT} is no longer loaded` };
  }
  return probe;
}

/**
 * Build the shell command that kicks the TC server. Only called by
 * the route handler in `server.js` after the 202 response has been
 * flushed. Kept here (not in `server.js`) so the mechanism-detection
 * code and the mechanism-invocation code stay co-located — one place
 * to update when a mechanism is added.
 *
 * @param {string} mechanism - Return value of `detectRestartMechanism()`
 * @returns {string|null}
 */
function buildRestartCommand(mechanism) {
  if (mechanism === 'launchctl') {
    // `gui/$UID` targets the per-user GUI domain (where the plist
    // is loaded by `deploy/install.sh`). `kickstart -k` kills the
    // current instance and immediately launches a fresh one — the
    // process running this code is the one being killed, which is
    // why the route handler flushes 202 *before* calling exec.
    return `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server`;
  }
  if (mechanism === 'systemctl') {
    // `--user` addresses the operator's own service manager, where the
    // unit lives. `--no-block` returns as soon as the restart job is
    // queued: the route runs this with execSync, which stalls the event
    // loop until the command exits, and a blocking restart would wait on
    // a job that cannot finish until this process has stopped.
    return 'systemctl --user --no-block restart tangleclaw.service';
  }
  return null;
}

/**
 * Snapshot of the server's runtime-vs-disk state. Safe to call before
 * `captureStartup()` — `startupSha` and `startedAt` will be null and
 * `isStale` falls through to `false` (a transient boot state, not a
 * detection failure).
 *
 * `isStale` is three-state (#1118): `true` (disk provably ahead), `false`
 * (provably in sync, or the designed no-git fallback), `null` (cannot
 * determine — a git probe failed where it was expected to work, and the
 * version signal is quiet). `staleUnknownReason` names the `null` cause.
 *
 * `bindNotice` pairs the bind recorded at listen time with the gate state the
 * caller passes, so it agrees with the `authStatus` the same request reports: an
 * account created after boot clears it, and an `authEnabled: false` edited in
 * after boot raises it. An omitted `gateState` counts as unguarded, so a caller
 * that did not ask never loses the warning.
 *
 * @param {object} [options]
 * @param {string|null} [options.gateState] - TangleClaw's gate state for this request.
 * @returns {{
 *   startupSha: string|null,
 *   currentDiskSha: string|null,
 *   isStale: boolean|null,
 *   staleUnknownReason: string|null,
 *   shaBaselineSource: 'startup'|'late'|null,
 *   commitsAhead: number,
 *   startedAt: string|null,
 *   uptimeSeconds: number|null,
 *   restartMechanism: 'launchctl'|'systemctl'|null
 * }}
 */
function getServerInfo(options = {}) {
  const current = _probeSha();

  // Late-baseline recovery (#1118). A boot-time probe miss used to latch
  // null for the process lifetime, silently disabling SHA detection. When
  // a later probe succeeds, adopt its SHA as the baseline: commits merged
  // between boot and now stay undetectable (and `shaBaselineSource: 'late'`
  // says so), but everything after this moment is watched again — a late
  // baseline is usable, a null one never is.
  if (_startupTs !== null && _startupSha === null && _startupShaError !== null && current.sha) {
    _startupSha = current.sha;
    _startupShaError = null;
    _shaBaselineSource = 'late';
    _log.warn('startup SHA baseline recovered late — staleness between boot and now was undetectable', { baseline: current.sha });
  }

  const startupSha = _startupSha;
  const currentDiskSha = current.sha;
  const bothPresent = !!(startupSha && currentDiskSha);
  const shaStale = bothPresent && startupSha !== currentDiskSha;

  // Second, independent staleness signal (#713 follow-up). The SHA check is
  // the more precise one but it is entirely git-dependent: if `git rev-parse`
  // fails or times out, `currentDiskSha` is null, `bothPresent` is false, and
  // the SHA signal can say nothing — since #1118 that reports as unknown
  // rather than as a confident false, but unknown still shows no commit
  // count, while the disk has in fact moved. A self-update whose restart did
  // not take looks exactly like that: the operator sees an unchanged version
  // number and no explanation.
  //
  // Comparing version.json needs no git at all, so it still fires when SHA
  // detection is unavailable. It is coarser — it only moves on a release —
  // which is exactly the case the self-updater produces.
  const runningVersion = _startupVersion;
  const diskVersion = _readDiskVersion();
  const versionStale = !!(runningVersion && diskVersion && runningVersion !== diskVersion);

  // Three-state staleness (#1118). Positive signals win outright; a clean
  // SHA comparison or the designed no-git fallback is an honest `false`;
  // anything else post-boot means a probe failed where it should have
  // worked, and unknown must not be rendered as a fact — the same rule the
  // update beacon applies (`tcIsUpdateAnswer`: a failed check is not "up
  // to date").
  const noGitByDesign = _startupShaError === 'no-git' && current.error === 'no-git';
  let isStale;
  let staleUnknownReason = null;
  if (shaStale || versionStale) {
    isStale = true;
  } else if (bothPresent || noGitByDesign || _startupTs === null) {
    isStale = false;
  } else {
    isStale = null;
    staleUnknownReason = startupSha === null
      ? 'git SHA detection failed at boot and has not recovered'
      : 'current git SHA read failed';
  }

  const commitsAhead = shaStale ? _countCommitsAhead(startupSha, currentDiskSha) : 0;
  const uptimeSeconds = _startupTs
    ? Math.floor((Date.now() - new Date(_startupTs).getTime()) / 1000)
    : null;
  return {
    startupSha,
    currentDiskSha,
    isStale,
    staleUnknownReason,
    shaBaselineSource: _shaBaselineSource,
    commitsAhead,
    runningVersion,
    diskVersion,
    startedAt: _startupTs,
    uptimeSeconds,
    restartMechanism: detectRestartMechanism(),
    bindNotice: _bindConfig
      ? require('./bind-policy').describeNarrowing(_bindConfig, options.gateState == null ? null : options.gateState)
      : null,
    ttydNotice: _ttydNotice,
    caddyDriftNotice: _caddyDriftNotice
  };
}

/**
 * Record the config this process bound its socket from, so the dashboard can be
 * told when that socket is still wide with no password in front.
 *
 * Only the bind is fixed at listen time — the socket that exists is the one the
 * operator is being told about. Whether a login guards it is not: an account can
 * be created, or `authEnabled` turned off, without a restart. So the notice
 * itself is derived per call in {@link getServerInfo}, from this and the gate
 * state the request carries (`bindPolicy.describeNarrowing`).
 *
 * @param {object|null} config - The config the listener was bound from. Copied,
 *   so a later edit to the caller's object does not move the recorded bind.
 */
function setBindConfig(config) {
  _bindConfig = config ? { ...config } : null;
}

/**
 * Record that the terminal listener could NOT be pinned, so the operator learns
 * it from the dashboard rather than only from a log file.
 *
 * The re-pin refuses whenever it does not fully recognize the installed job —
 * the right call, since guessing could take every terminal down. But a refusal
 * leaves an unauthenticated `--writable` shell listening on the network, and a
 * server log is the wrong channel for that: the person who needs to know is
 * looking at a browser.
 *
 * @param {{message: string, setting: string, severity: string}|null} notice
 */
function setTtydNotice(notice) {
  _ttydNotice = notice || null;
}

/**
 * Record what the Caddyfile divergence check found, so the operator reads it in
 * the browser rather than in a boot log.
 *
 * Carried here for the same reason as the two notices above: it describes a
 * measurement taken once, at boot. Re-running `caddy adapt` twice per
 * `/api/server-info` poll would spawn subprocesses on a route the dashboard
 * polls continuously.
 *
 * The operator is almost never sitting at this machine, which is the whole
 * argument for a dashboard surface over a log line: a finding nobody reads
 * protects nothing.
 *
 * @param {{message: string, setting: string, severity: string, findings: string[]}|null} notice -
 *   From `caddyDrift.describeDrift()`; null when the check ran and every
 *   property holds.
 */
function setCaddyDriftNotice(notice) {
  _caddyDriftNotice = notice || null;
}

/**
 * Test-only reset. The double-underscore prefix + `unsafe` token in the
 * exported name make accidental production use loud — grep-friendly and
 * lint-friendly. Production code should never call this; startup state
 * is captured once per process lifetime.
 */
function __unsafeResetForTest() {
  _startupSha = null;
  _startupShaError = null;
  _shaBaselineSource = null;
  _startupTs = null;
  _startupVersion = null;
  _restartMechanism = undefined;
  _systemdProbeAt = 0;
  _systemdProbeInFlight = null;
  _systemdLastReason = null;
  _systemdGeneration += 1;
  _bindConfig = null;
  _ttydNotice = null;
  _caddyDriftNotice = null;
}

const _internal = {
  execSync,
  repoRoot: _repoRoot,
  platform: () => process.platform,
  execFileAsync: promisify(execFile),
  pid: () => process.pid,
  now: () => Date.now(),
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync
};

module.exports = {
  captureStartup,
  getRunningVersion,
  getServerInfo,
  setBindConfig,
  setTtydNotice,
  setCaddyDriftNotice,
  detectRestartMechanism,
  confirmRestartMechanism,
  refreshSystemdMechanism,
  probeSystemdUserUnit,
  buildRestartCommand,
  _internal,
  __unsafeResetForTest,
  _probeSha,
  _classifyGitError,
  _countCommitsAhead,
  MACOS_PLIST_PATH,
  SYSTEMD_USER_UNIT,
  SYSTEMD_REPROBE_MS
};
