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
 * don't surface here. v1 detects merged-since-startup commits only.
 * A future enhancement could surface `git status --porcelain` non-empty
 * as a secondary signal if it proves useful.
 *
 * @module lib/server-info
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
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
let _bindNotice = null; // set once at listen time; see setBindNotice()
let _ttydNotice = null; // set once at boot; see setTtydNotice()

const GIT_TIMEOUT_MS = 5000;

// macOS launchd plist installed by `deploy/install.sh`. When present
// AND the host is macOS, restartMechanism is 'launchctl' and the
// frontend "Restart TangleClaw" button is enabled (#235). Linux
// support is a deliberate follow-up — see issue filed off #235.
const MACOS_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tangleclaw.server.plist');

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
 * Detect a process-manager mechanism the server can use to restart
 * itself (#235). Today only macOS launchd is supported — Linux
 * (systemd / sysvinit / bare-node) is a deliberate follow-up.
 *
 * Mechanism is detected lazily on first read and cached for the
 * process lifetime (the underlying plist file is installed once at
 * setup time and doesn't move). Returns `null` when no mechanism is
 * available — the frontend hides the restart button in that case
 * rather than offering an action that would fail.
 *
 * @returns {'launchctl'|null}
 */
function detectRestartMechanism() {
  if (_restartMechanism !== undefined) return _restartMechanism;
  if (_internal.platform() === 'darwin' && _internal.existsSync(MACOS_PLIST_PATH)) {
    _restartMechanism = 'launchctl';
  } else {
    _restartMechanism = null;
  }
  return _restartMechanism;
}

/**
 * Build the shell command that kicks the TC server. Only called by
 * the route handler in `server.js` after the 202 response has been
 * flushed. Kept here (not in `server.js`) so the mechanism-detection
 * code and the mechanism-invocation code stay co-located — one place
 * to update when Linux support lands.
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
 * @returns {{
 *   startupSha: string|null,
 *   currentDiskSha: string|null,
 *   isStale: boolean|null,
 *   staleUnknownReason: string|null,
 *   shaBaselineSource: 'startup'|'late'|null,
 *   commitsAhead: number,
 *   startedAt: string|null,
 *   uptimeSeconds: number|null,
 *   restartMechanism: 'launchctl'|null
 * }}
 */
function getServerInfo() {
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
    bindNotice: _bindNotice,
    ttydNotice: _ttydNotice
  };
}

/**
 * Record the network-binding notice for this process, so the dashboard can show
 * it alongside the other boot-time facts the browser already polls for.
 *
 * Carried here rather than recomputed per request because it describes a
 * decision made once, at listen time: the socket that exists is the one the
 * operator is being told about.
 *
 * @param {{message: string, setting: string, severity: string}|null} notice - From
 *   `bindPolicy.describeNarrowing()`; null unless this install is in the exposed
 *   grace state — still accepting connections from the whole network with no
 *   password, because narrowing it would have taken away remote access before
 *   there was a credential gate to replace it.
 */
function setBindNotice(notice) {
  _bindNotice = notice || null;
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
  _bindNotice = null;
  _ttydNotice = null;
}

const _internal = {
  execSync,
  repoRoot: _repoRoot,
  platform: () => process.platform,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync
};

module.exports = {
  captureStartup,
  getRunningVersion,
  getServerInfo,
  setBindNotice,
  setTtydNotice,
  detectRestartMechanism,
  buildRestartCommand,
  _internal,
  __unsafeResetForTest,
  _probeSha,
  _classifyGitError,
  _countCommitsAhead,
  MACOS_PLIST_PATH
};
