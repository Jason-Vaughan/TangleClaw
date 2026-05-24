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

const _repoRoot = path.resolve(__dirname, '..');

// Captured by `captureStartup()` once at server boot. Tests use
// `_resetForTest()` to clear state between cases.
let _startupSha = null;
let _startupTs = null;
let _restartMechanism = undefined; // undefined = not yet detected; null = no mechanism available

const GIT_TIMEOUT_MS = 5000;

// macOS launchd plist installed by `deploy/install.sh`. When present
// AND the host is macOS, restartMechanism is 'launchctl' and the
// frontend "Restart TangleClaw" button is enabled (#235). Linux
// support is a deliberate follow-up — see issue filed off #235.
const MACOS_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tangleclaw.server.plist');

/**
 * Run `git rev-parse HEAD` in the TC repo root. Returns the trimmed
 * SHA on success, `null` on any failure (not a git repo, git not
 * installed, exec timeout, etc.). Never throws — the caller treats
 * `null` as "git state unknown."
 *
 * @returns {string|null}
 */
function _detectSha() {
  try {
    const out = _internal.execSync('git rev-parse HEAD', {
      cwd: _internal.repoRoot,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const trimmed = String(out || '').trim();
    return trimmed.length > 0 ? trimmed : null;
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
  _startupSha = _detectSha();
  return { startupSha: _startupSha, startedAt: _startupTs };
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
 * `isStale` falls through to `false`.
 *
 * @returns {{
 *   startupSha: string|null,
 *   currentDiskSha: string|null,
 *   isStale: boolean,
 *   commitsAhead: number,
 *   startedAt: string|null,
 *   uptimeSeconds: number|null,
 *   restartMechanism: 'launchctl'|null
 * }}
 */
function getServerInfo() {
  const startupSha = _startupSha;
  const currentDiskSha = _detectSha();
  const bothPresent = !!(startupSha && currentDiskSha);
  const isStale = bothPresent && startupSha !== currentDiskSha;
  const commitsAhead = isStale ? _countCommitsAhead(startupSha, currentDiskSha) : 0;
  const uptimeSeconds = _startupTs
    ? Math.floor((Date.now() - new Date(_startupTs).getTime()) / 1000)
    : null;
  return {
    startupSha,
    currentDiskSha,
    isStale,
    commitsAhead,
    startedAt: _startupTs,
    uptimeSeconds,
    restartMechanism: detectRestartMechanism()
  };
}

/**
 * Test-only reset. The double-underscore prefix + `unsafe` token in the
 * exported name make accidental production use loud — grep-friendly and
 * lint-friendly. Production code should never call this; startup state
 * is captured once per process lifetime.
 */
function __unsafeResetForTest() {
  _startupSha = null;
  _startupTs = null;
  _restartMechanism = undefined;
}

const _internal = {
  execSync,
  repoRoot: _repoRoot,
  platform: () => process.platform,
  existsSync: fs.existsSync
};

module.exports = {
  captureStartup,
  getServerInfo,
  detectRestartMechanism,
  buildRestartCommand,
  _internal,
  __unsafeResetForTest,
  _detectSha,
  _countCommitsAhead,
  MACOS_PLIST_PATH
};
