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
 * **Detached HEAD is skipped, not counted.** The self-updater leaves a healthy
 * install detached at a release tag (`lib/update-applier.js`), and a tag is
 * behind `main` for the whole release interval by construction. Counting there
 * would show the banner permanently on every non-developer install, telling
 * the operator to pull when the guarded *Update now* is the right path. So
 * HEAD is checked with `git symbolic-ref` first and, when it is not on a
 * branch, no fetch is made at all and the payload says `skipped:
 * 'detached-head'`.
 *
 * **Never synchronous.** The fetch is a network call to GitHub with a timeout
 * measured in seconds; `execSync` would stall the single-threaded server —
 * terminal websockets included — for that long. Every git call here goes
 * through `execFile`, and the dashboard route reads the cache without waiting.
 * The fetch runs with `GIT_TERMINAL_PROMPT=0` and ssh in batch mode so a
 * remote that wants credentials fails instead of waiting on a tty nobody has.
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
 * The environment variable `TC_BEHIND_ORIGIN_DISABLED=1` does the same from
 * outside the config (CI, sandboxes, a test process that must not touch the
 * network or the developer's `.git`). See `docs/configuration-reference.md`.
 *
 * @module lib/behind-origin
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('behind-origin');

const _repoRoot = path.resolve(__dirname, '..');

/** How long one measurement is served before a fresh fetch is started. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Upper bound on one `git fetch` — a hung remote must not pin the slot. */
const FETCH_TIMEOUT_MS = 20000;
/** Upper bound on the local-only git calls (rev-list, symbolic-ref). */
const LOCAL_GIT_TIMEOUT_MS = 5000;

/** The upstream ref the local HEAD is compared against. */
const UPSTREAM_REF = 'origin/main';

/** Environment kill switch — any non-empty value other than `0` disables. */
const ENV_KILL_SWITCH = 'TC_BEHIND_ORIGIN_DISABLED';

// { commitsAhead: number, skipped: string|null, checkedAt: string } — the
// last completed measurement.
let _cache = null;
// Promise of the one in-flight measurement, or null when idle.
let _inFlight = null;

/**
 * Why the default git seam must not spawn anything, or null when it may.
 * A process under Node's test runner (`NODE_TEST_CONTEXT` is set for every
 * file it runs) is the case this exists for: eight unstubbed route tests were
 * each spawning a real `git fetch origin` into the developer's checkout.
 *
 * @returns {string|null}
 */
function _spawnBlockedReason() {
  if (process.env.NODE_TEST_CONTEXT) return 'node test runner';
  return null;
}

/**
 * Options for the network-bound fetch. `GIT_TERMINAL_PROMPT=0` makes an HTTPS
 * remote that wants credentials fail at once instead of prompting; ssh batch
 * mode does the same for an SSH remote. Neither prompt could be answered — the
 * server has no tty — so without these the fetch would hang until its timeout
 * on every tick. Built by a function so a test can pin the timeout.
 *
 * @returns {import('node:child_process').ExecFileOptions}
 */
function _fetchOptions() {
  return {
    cwd: _repoRoot,
    timeout: FETCH_TIMEOUT_MS,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes'
    }
  };
}

/**
 * Options for the local-only git calls.
 * @returns {import('node:child_process').ExecFileOptions}
 */
function _localOptions() {
  return { cwd: _repoRoot, timeout: LOCAL_GIT_TIMEOUT_MS, encoding: 'utf8' };
}

/**
 * Run one git command through the injectable `execFile`, refusing to spawn
 * when the environment says so. argv form — nothing is parsed by a shell.
 *
 * @param {string[]} args - git arguments.
 * @param {object} options - execFile options.
 * @param {(err: Error|null, stdout?: string) => void} cb
 */
function _git(args, options, cb) {
  const blocked = _spawnBlockedReason();
  if (blocked) {
    return void setImmediate(() => cb(new Error(`git spawn blocked: ${blocked}`)));
  }
  _internal.execFile('git', args, options, cb);
}

/**
 * Seam for the git calls, so tests drive every branch without a remote.
 * `execFile` is the lowest injection point (used to pin the options); the
 * three named calls sit above it for tests that only care about outcomes.
 */
const _internal = {
  execFile: childProcess.execFile,
  gitSymbolicRef: (cb) => _git(['symbolic-ref', '-q', 'HEAD'], _localOptions(), cb),
  gitFetch: (cb) => _git(['fetch', '--quiet', 'origin'], _fetchOptions(), cb),
  gitRevList: (cb) => _git(['rev-list', `HEAD..${UPSTREAM_REF}`, '--count'], _localOptions(), cb),
  now: () => Date.now()
};

/**
 * Whether the environment kill switch is set. `0` and empty mean "not set",
 * so `TC_BEHIND_ORIGIN_DISABLED=0` reads the way an operator expects.
 *
 * @returns {boolean}
 */
function _envDisabled() {
  const v = process.env[ENV_KILL_SWITCH];
  return typeof v === 'string' && v.length > 0 && v !== '0';
}

/**
 * Whether the check is on for this install. Off when the environment kill
 * switch is set, or when config carries an explicit `false`. An absent config
 * key (an install predating the setting) and any non-boolean value leave the
 * default — on — in force, matching how `PATCH /api/config` refuses a
 * non-boolean rather than guessing at it.
 *
 * @param {object|null|undefined} config - Loaded global config.
 * @returns {boolean}
 */
function isCheckEnabled(config) {
  if (_envDisabled()) return false;
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
 * One full measurement: is HEAD on a branch, fetch, count. Resolves — never
 * rejects — to `{commitsAhead, skipped}`; every failure is `commitsAhead: 0`
 * and a detached HEAD is `skipped: 'detached-head'` with no fetch made.
 * A failed step is logged at debug level only; it is the expected state of
 * an offline laptop, not a fault.
 *
 * @returns {Promise<{commitsAhead: number, skipped: string|null}>}
 */
function measure() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result, reason) => {
      if (settled) return;
      settled = true;
      if (reason) log.debug('behind-origin check yielded 0', { reason });
      resolve(result);
    };
    const zero = (reason) => done({ commitsAhead: 0, skipped: null }, reason);
    const call = (fn, onOk) => {
      try {
        fn((err, stdout) => onOk(err, stdout));
      } catch (err) {
        // The seam itself throwing (bad argv, spawn refused) must not escape —
        // the caller is a route handler that owns a response.
        zero(`git threw: ${err && err.message}`);
      }
    };
    call(_internal.gitSymbolicRef, (refErr) => {
      if (refErr) {
        // `symbolic-ref -q` exits 1 on a detached HEAD and says nothing; any
        // other failure (no git, not a repo) also means there is nothing to
        // compare, and skipping the fetch is the safe reading of both.
        return done({ commitsAhead: 0, skipped: 'detached-head' });
      }
      call(_internal.gitFetch, (fetchErr) => {
        if (fetchErr) return zero(`fetch failed: ${fetchErr.message || fetchErr}`);
        call(_internal.gitRevList, (revErr, stdout) => {
          if (revErr) return zero(`rev-list failed: ${revErr.message || revErr}`);
          done({ commitsAhead: _parseCount(stdout), skipped: null });
        });
      });
    });
  });
}

/**
 * Fetch `origin` and count the commits `origin/main` has that HEAD does not.
 *
 * Resolves to 0 — never rejects — on every failure: no remote configured,
 * fetch refused or timed out, `origin/main` absent after the fetch, git not
 * installed, unparseable output. Also 0 on a detached HEAD, where no fetch
 * is made (see `measure`).
 *
 * @returns {Promise<number>} Commits upstream that the local clone lacks.
 */
function getRemoteCommitsAhead() {
  return measure().then((r) => r.commitsAhead);
}

/**
 * Measure now, coalescing concurrent callers onto one in-flight measurement.
 * The cache is replaced only when the measurement completes.
 *
 * @returns {Promise<{commitsAhead: number, skipped: string|null, checkedAt: string}>}
 */
function refresh() {
  if (_inFlight) return _inFlight;
  _inFlight = measure().then((r) => {
    _cache = { ...r, checkedAt: new Date(_internal.now()).toISOString() };
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
 * @returns {Promise<{commitsAhead: number, skipped: string|null, checkedAt: string}>}
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
 * Disabled installs get `{enabled: false, commitsAhead: 0, ...}` and no fetch
 * is started: the flag is the operator's word that this machine should not
 * call out, so a stale cache does not override it.
 *
 * `checkedAt: null` with `enabled: true` means "not measured yet" (the window
 * right after boot); `skipped: 'detached-head'` means HEAD is on a tag, not
 * a branch, so nothing was counted. The UI treats both like 0 — nothing to
 * say.
 *
 * @param {object|null|undefined} config - Loaded global config.
 * @returns {{enabled: boolean, commitsAhead: number, skipped: string|null, checkedAt: string|null}}
 */
function snapshot(config) {
  if (!isCheckEnabled(config)) {
    return { enabled: false, commitsAhead: 0, skipped: null, checkedAt: null };
  }
  if (!_isFresh(CACHE_TTL_MS)) {
    // Fire-and-forget: `refresh` never rejects, so nothing is left unhandled.
    refresh();
  }
  return {
    enabled: true,
    commitsAhead: _cache ? _cache.commitsAhead : 0,
    skipped: _cache ? _cache.skipped : null,
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
  measure,
  refresh,
  refreshIfStale,
  snapshot,
  isCheckEnabled,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  LOCAL_GIT_TIMEOUT_MS,
  UPSTREAM_REF,
  ENV_KILL_SWITCH,
  _internal,
  _fetchOptions,
  _localOptions,
  _spawnBlockedReason,
  _reset
};
