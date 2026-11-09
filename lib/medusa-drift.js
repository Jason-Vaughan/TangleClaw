'use strict';

/**
 * Medusa upstream & local Hub drift (#2956): is the local `Jason-Vaughan/Medusa`
 * checkout behind its own `origin/main`, and does the running Hub's own
 * reported `gitSha` disagree with what is on disk right now?
 *
 * Two independent comparisons, both degrading gracefully rather than
 * refusing:
 * - **`updateAvailable`**: the local checkout (default: `MEDUSA_CHECKOUT_PATH`,
 *   or the sibling directory `Medusa-PM` next to wherever this repo is
 *   checked out) is behind the `Jason-Vaughan/Medusa` `origin/main` it has on
 *   disk. Never fetches on every call — the periodic check below does one
 *   bounded `git fetch` first; a caller wanting a fresh comparison without
 *   that cost reads whatever `origin/main` already points at.
 * - **`hubRestartNeeded`**: the running Hub's own `/health`/`/version`
 *   answer carries a `gitSha` that differs from the checkout's disk HEAD —
 *   the Hub is still running an older in-memory build than what a prior
 *   `git pull` already landed on disk, so a restart (not a fetch) is what's
 *   missing.
 *
 * Paired with `Jason-Vaughan/Medusa#70`: a Hub that predates it answers
 * `/health`/`/version` with no `gitSha`/`capabilities` at all, which this
 * module reads as "unknown", never as a drift finding.
 *
 * `onHubVersionUpdated`/`applyHubVersionUpdate` (`lib/medusa.js`) are the
 * push half: whichever frame handler learns of a Hub `hub.version_updated`
 * notification calls `applyHubVersionUpdate`, which this module subscribes
 * to and uses to invalidate its own cache and call back whoever registered
 * via {@link onDriftChange} here.
 *
 * @module lib/medusa-drift
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createLogger } = require('./logger');
const medusa = require('./medusa');

const log = createLogger('medusa-drift');

const DEFAULT_CHECKOUT_PATH = path.resolve(__dirname, '..', '..', 'Medusa-PM');
const GIT_TIMEOUT_MS = 8000;
const HUB_FETCH_TIMEOUT_MS = 5000;
const TTL_MS = 10 * 60 * 1000; // 10 min — a drift state changes only on a merge or a restart

const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min — this is a drift CHECK, not a hot path

let _cache = null; // { snapshot, fetchedAt }
let _inflight = null;
const _driftChangeListeners = new Set();
let _unsubscribeHubUpdate = null;
let _timer = null;

/**
 * The local Medusa checkout's configured path.
 * @returns {string}
 */
function checkoutPath() {
  return process.env.MEDUSA_CHECKOUT_PATH || DEFAULT_CHECKOUT_PATH;
}

/**
 * Run one git command against the checkout. Never throws past its own
 * callers' own try/catch — every call site here wraps this.
 * @param {string[]} args - argv after `git`
 * @param {string} cwd - The checkout's directory
 * @returns {Promise<string>} stdout, untrimmed
 */
async function _git(args, cwd) {
  const { stdout } = await _internal.execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' });
  return stdout;
}

/**
 * The local checkout's own HEAD and how far behind `origin/main` it reads,
 * from whatever refs are already on disk (no fetch — see {@link refreshDrift}
 * for the one place that fetches first).
 * @param {object} [opts]
 * @param {string} [opts.checkoutPath] - Override the configured path (tests)
 * @returns {Promise<{installed: boolean, path: string, gitSha: (string|null),
 *   commitsBehind: (number|null), updateAvailable: boolean, error: (string|null)}>}
 */
async function localCheckoutStatus(opts = {}) {
  const dir = opts.checkoutPath || checkoutPath();
  if (!_internal.pathExists(dir)) {
    return { installed: false, path: dir, gitSha: null, commitsBehind: null, updateAvailable: false, error: null };
  }
  let gitSha;
  try {
    gitSha = (await _git(['rev-parse', 'HEAD'], dir)).trim();
  } catch (err) {
    log.warn('Could not read the local Medusa checkout\'s HEAD', { dir, error: err.message });
    return { installed: true, path: dir, gitSha: null, commitsBehind: null, updateAvailable: false, error: err.message };
  }
  let commitsBehind = null;
  try {
    const count = parseInt((await _git(['rev-list', '--count', 'HEAD..origin/main'], dir)).trim(), 10);
    if (Number.isFinite(count)) commitsBehind = count;
  } catch (err) {
    // No origin/main ref on disk yet, or not a git repo at all -- the
    // checkout's HEAD above is still honest; only the comparison is unknown.
    log.warn('Could not compare the local Medusa checkout against origin/main', { dir, error: err.message });
  }
  return {
    installed: true, path: dir, gitSha, commitsBehind,
    updateAvailable: typeof commitsBehind === 'number' && commitsBehind > 0,
    error: null
  };
}

/**
 * Fetch `origin main` into the local checkout, bounded and best-effort: a
 * network failure or missing remote leaves whatever refs already exist on
 * disk untouched, and is logged rather than thrown.
 * @param {string} dir - The checkout's directory
 * @returns {Promise<boolean>} Whether the fetch succeeded
 */
async function _fetchOrigin(dir) {
  try {
    await _internal.execFileAsync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' });
    return true;
  } catch (err) {
    log.warn('Could not fetch the local Medusa checkout\'s origin/main', { dir, error: err.message });
    return false;
  }
}

/**
 * The running Hub's own reported version, read from `GET /health` first and
 * `GET /version` if that answers nothing usable -- tolerating a Hub that
 * predates `Jason-Vaughan/Medusa#70` and exposes neither `gitSha` nor
 * `capabilities` at all.
 * @param {object} [opts]
 * @param {string} [opts.bridgeHttpUrl] - Override the Hub's base URL (tests)
 * @returns {Promise<{reachable: boolean, gitSha: (string|null),
 *   version: (string|null), capabilities: (string[]|null), error: (string|null)}>}
 */
async function hubVersionStatus(opts = {}) {
  const base = opts.bridgeHttpUrl || medusa.getBridgeHttpUrl();
  const doFetch = _internal.fetchImpl;
  for (const pathName of ['/health', '/version']) {
    try {
      const res = await doFetch(`${base}${pathName}`, { signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || typeof data !== 'object') continue;
      return {
        reachable: true,
        gitSha: typeof data.gitSha === 'string' ? data.gitSha : null,
        version: typeof data.version === 'string' ? data.version : null,
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : null,
        error: null
      };
    } catch (err) {
      log.warn('Could not read the Medusa Hub\'s version endpoint', { base, path: pathName, error: err.message });
    }
  }
  return { reachable: false, gitSha: null, version: null, capabilities: null, error: 'the Hub answered neither /health nor /version' };
}

/**
 * The full drift snapshot: the local checkout, the running Hub, and the two
 * derived findings — `updateAvailable` (the checkout itself is behind
 * upstream) and `hubRestartNeeded` (the Hub's in-memory build disagrees with
 * what's on disk). Cached for `TTL_MS`; pass `force` to bypass it. Never
 * throws — every sub-check above already degrades on its own.
 * @param {object} [opts]
 * @param {boolean} [opts.force] - Bypass the cache
 * @param {boolean} [opts.fetch] - Fetch `origin/main` first (the periodic check's own default; a request-driven read defaults to false, reading whatever refs are already there)
 * @param {string} [opts.checkoutPath] - Override the configured checkout path (tests)
 * @param {string} [opts.bridgeHttpUrl] - Override the Hub's base URL (tests)
 * @returns {Promise<{checkedAt: string, local: object, hub: object,
 *   updateAvailable: boolean, hubRestartNeeded: boolean}>}
 */
async function getDrift(opts = {}) {
  if (!opts.force && _cache && (Date.now() - _cache.fetchedAt) < TTL_MS) return _cache.snapshot;
  if (_inflight) return _inflight;
  const run = (async () => {
    const dir = opts.checkoutPath || checkoutPath();
    if (opts.fetch && _internal.pathExists(dir)) await _fetchOrigin(dir);
    const [local, hub] = await Promise.all([
      localCheckoutStatus({ checkoutPath: opts.checkoutPath }),
      hubVersionStatus({ bridgeHttpUrl: opts.bridgeHttpUrl })
    ]);
    const hubRestartNeeded = Boolean(
      local.installed && local.gitSha && hub.reachable && hub.gitSha && hub.gitSha !== local.gitSha
    );
    const snapshot = {
      checkedAt: new Date().toISOString(),
      local, hub,
      updateAvailable: local.updateAvailable,
      hubRestartNeeded
    };
    _cache = { snapshot, fetchedAt: Date.now() };
    return snapshot;
  })().finally(() => { _inflight = null; });
  _inflight = run;
  return run;
}

/**
 * Force a fresh check, fetching `origin/main` first — what the periodic
 * background check and the push-triggered refresh below both call.
 * @returns {Promise<object>} The fresh snapshot, see {@link getDrift}
 */
async function refreshDrift() {
  const snapshot = await getDrift({ force: true, fetch: true });
  for (const fn of _driftChangeListeners) {
    try {
      fn(snapshot);
    } catch (err) { // prawduct:allow prawduct/broad-except -- one bad subscriber must not break the others or the refresh itself
      log.warn('A drift-change subscriber threw', { error: err && err.message });
    }
  }
  return snapshot;
}

/**
 * Subscribe to a fresh drift snapshot every time one is computed via
 * {@link refreshDrift} (the periodic check, and the push listener below).
 * @param {function(object): void} fn
 * @returns {function(): void} Unsubscribe
 */
function onDriftChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _driftChangeListeners.add(fn);
  return () => _driftChangeListeners.delete(fn);
}

/**
 * Wire this module to `lib/medusa.js`'s `hub.version_updated` fan-out
 * (idempotent — a second call replaces the first subscription rather than
 * stacking another one) and start the periodic background check. A push
 * notification invalidates the cache and triggers the same refresh the
 * periodic check runs, so a dashboard registered via {@link onDriftChange}
 * learns of a Hub restart without waiting for the next poll.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - Periodic check cadence (default {@link DEFAULT_CHECK_INTERVAL_MS})
 * @returns {void}
 */
function start(opts = {}) {
  if (_unsubscribeHubUpdate) _unsubscribeHubUpdate();
  _unsubscribeHubUpdate = medusa.onHubVersionUpdated(() => {
    refreshDrift().catch((err) => log.warn('Drift refresh after hub.version_updated failed', { error: err && err.message }));
  });
  if (_timer) clearInterval(_timer);
  const intervalMs = opts.intervalMs || DEFAULT_CHECK_INTERVAL_MS;
  _timer = setInterval(() => {
    refreshDrift().catch((err) => log.warn('Periodic Medusa drift check failed', { error: err && err.message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref(); // never hold the event loop open
}

/**
 * Undo {@link start} and drop every cached/registered state (tests).
 * @returns {void}
 */
function stop() {
  if (_unsubscribeHubUpdate) _unsubscribeHubUpdate();
  _unsubscribeHubUpdate = null;
  if (_timer) clearInterval(_timer);
  _timer = null;
  _driftChangeListeners.clear();
  _cache = null;
  _inflight = null;
}

// Overridable for tests — zero live network/process calls without an explicit override.
const _internal = {
  execFileAsync: promisify(execFile),
  fetchImpl: fetch,
  pathExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
};

module.exports = {
  checkoutPath, localCheckoutStatus, hubVersionStatus, getDrift, refreshDrift,
  onDriftChange, start, stop, DEFAULT_CHECKOUT_PATH, DEFAULT_CHECK_INTERVAL_MS, TTL_MS, _internal
};
