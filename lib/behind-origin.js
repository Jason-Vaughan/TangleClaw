'use strict';

/**
 * Behind-origin detection (#227) — is the local clone behind `origin/main`?
 *
 * The staleness chain has three layers. `lib/update-checker.js` watches for a
 * new *release tag* on GitHub; `lib/server-info.js` watches for the *running
 * process* lagging the on-disk checkout (#199). Between them sat a gap: a
 * commit lands on `main` upstream and nothing on the dashboard says so until
 * the next release, so an operator who does not watch the repo sits on an old
 * checkout without knowing it. This module closes that gap.
 *
 * `getRemoteCommitsAhead()` runs `git fetch --quiet origin` and then counts
 * `HEAD..origin/main`. It resolves to `0` — never rejects — when there is no
 * remote, the fetch fails (offline, no credentials), the branch is absent, or
 * git itself is missing: the banner is opt-in via a working remote, the same
 * no-git fallback #199 takes. `0` is reported as "nothing to say", not as a
 * proven fact, which is why the payload carries `checkedAt` alongside it.
 *
 * **Never synchronous.** The fetch is a network call to GitHub with a timeout
 * measured in seconds; `execSync` would stall the single-threaded server —
 * terminal websockets included — for that long. Every git call here goes
 * through `execFile`, and the dashboard route reads the cache without waiting.
 *
 * **Cache + single-flight.** One measurement is kept in memory for
 * `CACHE_TTL_MS` (15 minutes). `snapshot()` returns it immediately and starts
 * at most one background refresh when it has expired, so N open dashboard tabs
 * polling `/api/server-info` cannot become N fetches against origin.
 *
 * **Opt-out.** The check is a periodic network call to GitHub, which an
 * operator on a metered or privacy-conscious connection may not want.
 * `config.behindOriginCheckEnabled: false` skips it entirely — no fetch is
 * ever started and the payload says `enabled: false` so the UI stays quiet.
 * See `docs/configuration-reference.md`.
 *
 * @module lib/behind-origin
 */

const path = require('node:path');
const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('behind-origin');

const _repoRoot = path.resolve(__dirname, '..');

/** How long one measurement is served before a fresh fetch is started. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Upper bound on one `git fetch` — a hung remote must not pin the slot. */
const FETCH_TIMEOUT_MS = 20000;
const REV_LIST_TIMEOUT_MS = 5000;

/** The upstream ref the local HEAD is compared against. */
const UPSTREAM_REF = 'origin/main';

// { commitsAhead: number, checkedAt: string } — the last completed measurement.
let _cache = null;
// Promise of the one in-flight measurement, or null when idle.
let _inFlight = null;

/**
 * Seam for the two git calls, so tests drive every branch without a remote.
 * argv form throughout — nothing here is parsed by a shell.
 */
const _internal = {
  gitFetch: (cb) => execFile('git', ['fetch', '--quiet', 'origin'], {
    cwd: _repoRoot, timeout: FETCH_TIMEOUT_MS, encoding: 'utf8'
  }, cb),
  gitRevList: (cb) => execFile('git', ['rev-list', `HEAD..${UPSTREAM_REF}`, '--count'], {
    cwd: _repoRoot, timeout: REV_LIST_TIMEOUT_MS, encoding: 'utf8'
  }, cb),
  now: () => Date.now()
};

/**
 * Whether the check is on for this install. Only an explicit `false` turns it
 * off: an absent key (an install predating the setting) and any non-boolean
 * value leave the default — on — in force, matching how `PATCH /api/config`
 * refuses a non-boolean rather than guessing at it.
 *
 * @param {object|null|undefined} config - Loaded global config.
 * @returns {boolean}
 */
function isCheckEnabled(config) {
  return !(config && config.behindOriginCheckEnabled === false);
}

/**
 * Parse `git rev-list --count` output. Anything that is not a non-negative
 * integer collapses to 0 — the banner must never render garbage a git
 * oddity produced.
 *
 * @param {string|Buffer|null|undefined} out - Raw stdout.
 * @returns {number}
 */
function _parseCount(out) {
  const n = parseInt(String(out || '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Fetch `origin` and count the commits `origin/main` has that HEAD does not.
 *
 * Resolves to 0 — never rejects — on every failure: no remote configured,
 * fetch refused or timed out, `origin/main` absent after the fetch, git not
 * installed, unparseable output. A failed measurement is logged at debug
 * level only; it is the expected state of an offline laptop, not a fault.
 *
 * @returns {Promise<number>} Commits upstream that the local clone lacks.
 */
function getRemoteCommitsAhead() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (n, reason) => {
      if (settled) return;
      settled = true;
      if (reason) log.debug('behind-origin check yielded 0', { reason });
      resolve(n);
    };
    try {
      _internal.gitFetch((fetchErr) => {
        if (fetchErr) return done(0, `fetch failed: ${fetchErr.message || fetchErr}`);
        try {
          _internal.gitRevList((revErr, stdout) => {
            if (revErr) return done(0, `rev-list failed: ${revErr.message || revErr}`);
            done(_parseCount(stdout));
          });
        } catch (err) {
          done(0, `rev-list threw: ${err && err.message}`);
        }
      });
    } catch (err) {
      // `execFile` itself throwing (bad argv, spawn refused) must not escape —
      // the caller is a route handler that owns a response.
      done(0, `fetch threw: ${err && err.message}`);
    }
  });
}

/**
 * Measure now, coalescing concurrent callers onto one in-flight measurement.
 * The cache is replaced only when the measurement completes.
 *
 * @returns {Promise<{commitsAhead: number, checkedAt: string}>}
 */
function refresh() {
  if (_inFlight) return _inFlight;
  _inFlight = getRemoteCommitsAhead().then((commitsAhead) => {
    _cache = { commitsAhead, checkedAt: new Date(_internal.now()).toISOString() };
    _inFlight = null;
    return _cache;
  });
  return _inFlight;
}

/**
 * Whether the cached measurement is younger than `maxAgeMs`. A cache that
 * was never filled is always stale.
 *
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
function _isFresh(maxAgeMs) {
  if (!_cache || !_cache.checkedAt) return false;
  return (_internal.now() - Date.parse(_cache.checkedAt)) < maxAgeMs;
}

/**
 * Serve the cache when it is younger than `maxAgeMs`, otherwise measure.
 *
 * @param {number} [maxAgeMs=CACHE_TTL_MS]
 * @returns {Promise<{commitsAhead: number, checkedAt: string}>}
 */
function refreshIfStale(maxAgeMs = CACHE_TTL_MS) {
  if (_isFresh(maxAgeMs)) return Promise.resolve(_cache);
  return refresh();
}

/**
 * The payload `/api/server-info` carries. Returns the cached answer at once
 * and — when the check is enabled and the cache has expired — starts one
 * background refresh so the *next* poll sees the fresh number. The route
 * never waits on the network.
 *
 * Disabled installs get `{enabled: false, commitsAhead: 0, checkedAt: null}`
 * and no fetch is started: the flag is the operator's word that this
 * machine should not call out, so a stale cache does not override it.
 *
 * `checkedAt: null` with `enabled: true` means "not measured yet" (the window
 * right after boot), which the UI treats the same as 0 — nothing to say.
 *
 * @param {object|null|undefined} config - Loaded global config.
 * @returns {{enabled: boolean, commitsAhead: number, checkedAt: string|null}}
 */
function snapshot(config) {
  if (!isCheckEnabled(config)) {
    return { enabled: false, commitsAhead: 0, checkedAt: null };
  }
  if (!_isFresh(CACHE_TTL_MS)) {
    // Fire-and-forget: `refresh` never rejects, so nothing is left unhandled.
    refresh();
  }
  return {
    enabled: true,
    commitsAhead: _cache ? _cache.commitsAhead : 0,
    checkedAt: _cache ? _cache.checkedAt : null
  };
}

/**
 * Reset module state (tests only).
 */
function _reset() {
  _cache = null;
  _inFlight = null;
}

module.exports = {
  getRemoteCommitsAhead,
  refresh,
  refreshIfStale,
  snapshot,
  isCheckEnabled,
  CACHE_TTL_MS,
  UPSTREAM_REF,
  _internal,
  _reset
};
