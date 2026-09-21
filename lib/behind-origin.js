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
 * **The observation (#993/#1678).** The count above is the legacy banner's
 * contract, and it deliberately says nothing when it cannot measure. The
 * checkout-freshness surfaces need the opposite: a fact that says what it
 * knows and how it knows it. So the same measurement also records an
 * *observation* — origin/main's SHA, HEAD's ahead/behind/diverged relation to
 * it, when it was taken, and an evidence state (`fresh`, `stale`,
 * `unavailable`, `pending`, `disabled`, `skipped`) — served by
 * `observation()`. A failure there is `unavailable` with its reason, never a
 * zero. It runs after the legacy count has resolved, so the legacy payload and
 * its timing are unchanged. A detached HEAD is still not *counted*, but it is
 * *observed* unless it sits exactly on a release tag: a checkout detached at an
 * arbitrary commit is the live-install state #993 exists to report, and
 * skipping it left the banner silent at exactly that moment.
 *
 * @module lib/behind-origin
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { createLogger } = require('./logger');
const { NO_PROMPT_ENV } = require('./exec');
const { redactRemoteOutput } = require('./remote-output');

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
// The last completed observation (see the module docstring), or null.
// { ok, reason, skipped, originMainSha, headSha, ahead, behind, checkedAt }
let _observation = null;
// Promise of the one in-flight observation, or null when idle.
let _observing = null;
// How the most recent `measure()` fetch went — `{ok, reason}`, or null when it
// made none (detached HEAD) — so the observation that follows it reuses that
// fetch instead of making a second call to origin.
let _lastFetch = null;

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
      ...NO_PROMPT_ENV,
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
  gitDescribeExact: (cb) => _git(['describe', '--tags', '--exact-match', 'HEAD'], _localOptions(), cb),
  gitRevParseHead: (cb) => _git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], _localOptions(), cb),
  gitRevParseOrigin: (cb) => _git(['rev-parse', '--verify', '-q', `${UPSTREAM_REF}^{commit}`], _localOptions(), cb),
  gitLeftRight: (cb) => _git(['rev-list', '--left-right', '--count', `HEAD...${UPSTREAM_REF}`], _localOptions(), cb),
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
  _lastFetch = null;
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
        zero(`git threw: ${redactRemoteOutput(err && err.message) || 'unknown'}`);
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
        _lastFetch = fetchErr ? { ok: false, reason: _failReason('fetch', fetchErr) } : { ok: true, reason: null };
        // `gitFetch` is the one call here that reaches origin, so its error can
        // echo a tokenised remote URL into this reason and the debug log.
        if (fetchErr) return zero(`fetch failed: ${redactRemoteOutput(String(fetchErr.message || fetchErr))}`);
        call(_internal.gitRevList, (revErr, stdout) => {
          if (revErr) return zero(`rev-list failed: ${redactRemoteOutput(String(revErr.message || revErr))}`);
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
    // Fire-and-forget, after the legacy answer is stored: `observe` never
    // rejects and is single-flight, and it reuses this measurement's fetch.
    _startObservation(r.skipped === 'detached-head', _lastFetch);
    return _cache;
  });
  return _inFlight;
}

/**
 * Run one git seam and resolve `{err, out}` — never rejects, and a seam that
 * throws synchronously is reported as an error rather than escaping.
 *
 * @param {Function} fn - A `_internal` seam taking a node-style callback.
 * @returns {Promise<{err: Error|null, out: string}>}
 */
function _run(fn) {
  return new Promise((resolve) => {
    try {
      fn((err, stdout) => resolve({ err: err || null, out: String(stdout || '') }));
    } catch (err) {
      resolve({ err: err instanceof Error ? err : new Error(String(err)), out: '' });
    }
  });
}

/**
 * A redacted, single-line reason from a git error, for the observation and the
 * log. Remote errors can echo a tokenised URL, so every message is redacted.
 *
 * @param {string} step - Which step failed, e.g. `fetch`.
 * @param {Error} err
 * @returns {string}
 */
function _failReason(step, err) {
  const msg = redactRemoteOutput(String((err && err.message) || err || 'unknown')).split('\n').filter(Boolean);
  return `${step} failed: ${msg.slice(-1)[0] || 'unknown error'}`;
}

/**
 * Parse `rev-list --left-right --count HEAD...origin/main` output: the left
 * count is commits only HEAD has, the right count commits only origin/main has.
 *
 * @param {string} out - Raw stdout, e.g. `"2\t3\n"`.
 * @returns {{ahead: number, behind: number}|null} null when unparseable.
 */
function _parseLeftRight(out) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(out || ''));
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

/**
 * Take one observation: fetch origin, then read origin/main's SHA, HEAD's SHA
 * and their ahead/behind counts. Resolves — never rejects — to a record whose
 * `ok: false` carries the reason. A detached HEAD sitting exactly on a release
 * tag is not fetched for (the self-updater's healthy state; *Update now* is its
 * path) and records `skipped`.
 *
 * @param {boolean} detached - Whether the legacy measurement found HEAD detached.
 * @param {{ok: boolean, reason: (string|null)}|null} [priorFetch] - The fetch
 *   the legacy measurement already made, reused rather than repeated; null
 *   makes this observation fetch for itself.
 * @returns {Promise<object>} The observation record.
 */
async function observe(detached, priorFetch = null) {
  const stamp = () => new Date(_internal.now()).toISOString();
  const fail = (reason) => ({ ok: false, reason, skipped: null, originMainSha: null, headSha: null,
    ahead: null, behind: null, checkedAt: stamp() });
  if (detached) {
    const tag = await _run(_internal.gitDescribeExact);
    if (!tag.err) {
      return { ok: false, reason: `detached at release tag ${tag.out.trim()}; releases update through Update now`,
        skipped: 'release-tag', originMainSha: null, headSha: null, ahead: null, behind: null, checkedAt: stamp() };
    }
    // Only git's own "no tag here" answer proves HEAD is off-tag; any other
    // failure (git missing, spawn refused) cannot tell, so it is not observed.
    if (!/no tag exactly matches|no names found/i.test(String(tag.err.message || ''))) {
      return fail(_failReason('describe', tag.err));
    }
  }
  if (priorFetch) {
    if (!priorFetch.ok) return fail(priorFetch.reason);
  } else {
    const fetched = await _run(_internal.gitFetch);
    if (fetched.err) return fail(_failReason('fetch', fetched.err));
  }
  const origin = await _run(_internal.gitRevParseOrigin);
  if (origin.err || !origin.out.trim()) return fail(origin.err ? _failReason(`rev-parse ${UPSTREAM_REF}`, origin.err) : `${UPSTREAM_REF} does not exist after the fetch`);
  const head = await _run(_internal.gitRevParseHead);
  if (head.err || !head.out.trim()) return fail(head.err ? _failReason('rev-parse HEAD', head.err) : 'HEAD has no commit');
  const lr = await _run(_internal.gitLeftRight);
  const counts = lr.err ? null : _parseLeftRight(lr.out);
  if (!counts) return fail(lr.err ? _failReason('rev-list --left-right', lr.err) : 'rev-list --left-right answered in an unreadable form');
  return { ok: true, reason: null, skipped: null, originMainSha: origin.out.trim(), headSha: head.out.trim(),
    ahead: counts.ahead, behind: counts.behind, checkedAt: stamp() };
}

/**
 * Start one observation unless one is already running, and store its result.
 *
 * @param {boolean} detached
 * @param {{ok: boolean, reason: (string|null)}|null} [priorFetch]
 * @returns {Promise<object>}
 */
function _startObservation(detached, priorFetch = null) {
  if (_observing) return _observing;
  _observing = observe(detached, priorFetch).then((o) => {
    _observation = o;
    _observing = null;
    if (!o.ok && !o.skipped) log.debug('origin observation unavailable', { reason: o.reason });
    return o;
  });
  return _observing;
}

/**
 * The relation of HEAD to origin/main from an ahead/behind pair.
 *
 * @param {number} ahead
 * @param {number} behind
 * @returns {'equal'|'ahead'|'behind'|'diverged'}
 */
function relationOf(ahead, behind) {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'equal';
}

/**
 * The origin observation as the freshness surfaces read it. Synchronous and
 * spawn-free: it reads the last stored observation and says how much it can be
 * trusted. It never reports a relation it did not measure — an observation
 * older than the TTL is `stale`, one that failed is `unavailable`, and none yet
 * is `pending`. Reading it does not start a measurement; `snapshot()` does.
 *
 * @param {object|null|undefined} config - Loaded global config.
 * @returns {{evidence: ('fresh'|'stale'|'unavailable'|'pending'|'disabled'|'skipped'), reason: (string|null),
 *   upstreamRef: string, originMainSha: (string|null), headSha: (string|null), ahead: (number|null),
 *   behind: (number|null), relation: (string|null), checkedAt: (string|null)}}
 */
function observation(config) {
  const base = { upstreamRef: UPSTREAM_REF, originMainSha: null, headSha: null, ahead: null, behind: null,
    relation: null, checkedAt: null };
  if (!isCheckEnabled(config)) {
    return { ...base, evidence: 'disabled', reason: 'the origin check is turned off for this install' };
  }
  if (!_observation) {
    return { ...base, evidence: 'pending', reason: 'origin has not been observed since this server started' };
  }
  const o = _observation;
  if (o.skipped) return { ...base, evidence: 'skipped', reason: o.reason, checkedAt: o.checkedAt };
  if (!o.ok) return { ...base, evidence: 'unavailable', reason: o.reason, checkedAt: o.checkedAt };
  const age = _internal.now() - Date.parse(o.checkedAt);
  return {
    upstreamRef: UPSTREAM_REF,
    evidence: age < CACHE_TTL_MS ? 'fresh' : 'stale',
    reason: age < CACHE_TTL_MS ? null : `last observed ${Math.round(age / 60000)} min ago; a refresh has been started`,
    originMainSha: o.originMainSha,
    headSha: o.headSha,
    ahead: o.ahead,
    behind: o.behind,
    relation: relationOf(o.ahead, o.behind),
    checkedAt: o.checkedAt
  };
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
  _observation = null;
  _observing = null;
  _lastFetch = null;
}

module.exports = {
  getRemoteCommitsAhead,
  measure,
  refresh,
  refreshIfStale,
  snapshot,
  observation,
  observe,
  relationOf,
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
  _startObservation,
  _parseLeftRight,
  _reset
};
