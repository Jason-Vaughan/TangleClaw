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
const { execSync } = require('node:child_process');

const _repoRoot = path.resolve(__dirname, '..');

// Captured by `captureStartup()` once at server boot. Tests use
// `_resetForTest()` to clear state between cases.
let _startupSha = null;
let _startupTs = null;

const GIT_TIMEOUT_MS = 5000;

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
 *   uptimeSeconds: number|null
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
    uptimeSeconds
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
}

const _internal = {
  execSync,
  repoRoot: _repoRoot
};

module.exports = {
  captureStartup,
  getServerInfo,
  _internal,
  __unsafeResetForTest,
  _detectSha,
  _countCommitsAhead
};
