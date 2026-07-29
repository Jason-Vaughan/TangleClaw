'use strict';

const { execSync, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createLogger } = require('./logger');

const log = createLogger('update-checker');

let _cache = null;
let _timer = null;

// Callbacks waiting on the one in-flight async check, or null when idle. This is
// what stops N dashboard tabs from becoming N `git ls-remote` calls: the first
// caller starts the check, everyone after it queues here and is served the same
// result. See `refreshIfStale`.
let _inFlight = null;

// Memoized `origin`-derived release URL base. `undefined` = not yet computed;
// `null` = computed and there is no GitHub remote.
let _releasesUrlBase;

// The install directory. Exposed in every status payload so clients (e.g. the
// session-view update pill's self-update prompt) never hardcode the path —
// the repo root is wherever this checkout actually lives (#183).
const _repoRoot = path.resolve(__dirname, '..');

/**
 * Seam for the tag query, so tests can drive the async path without a real
 * remote. Mirrors `update-applier.js`'s `_internal` convention. argv form — a
 * ref name is never parsed by a shell.
 */
const _internal = {
  lsRemote: (cb) => execFile('git', ['ls-remote', '--tags', 'origin'], {
    cwd: _repoRoot, timeout: 15000, encoding: 'utf8'
  }, cb),
  gitRemote: () => execSync('git remote get-url origin', {
    cwd: _repoRoot, timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  })
};

/**
 * The version to compare releases against — what this process loaded, falling
 * back to `version.json` only when startup was never captured.
 * @returns {string|null}
 */
function _getCurrentVersion() {
  // "Is there an update?" is a question about the code that is RUNNING, so it
  // is answered from what this process loaded, not from the working tree.
  //
  // Reading the tree makes the checker agree with itself out of an update and
  // then contradict the running server: after a self-update checks out the new
  // release, `version.json` already reads the new number while the old code
  // still serves, so the checker concludes "up to date" and the dashboard takes
  // the update pill down — for a server that has not restarted onto it. The
  // stale-server banner covers that window, but only after the pill has already
  // said the opposite.
  //
  // Required lazily: `server-info` is a peer module and this is called from a
  // timer, so a top-level require would fix the load order between two modules
  // that otherwise do not depend on each other.
  const running = require('./server-info').getRunningVersion();
  if (running) return running;

  // Fallback for a process that never captured startup — tests, and any
  // consumer of this module outside the server.
  try {
    const versionFile = path.join(__dirname, '..', 'version.json');
    const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * Parse a semver string into { major, minor, patch } numbers.
 * Strips leading 'v' and ignores pre-release suffixes.
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
function parseSemver(version) {
  if (!version || typeof version !== 'string') return null;
  const cleaned = version.replace(/^v/, '').split('-')[0];
  const parts = cleaned.split('.');
  if (parts.length < 3) return null;
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;
  return { major, minor, patch };
}

/**
 * Compare two semver objects. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number}
 */
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

/**
 * Parse git ls-remote --tags output into an array of version strings.
 * @param {string} output - Raw git ls-remote output
 * @returns {string[]}
 */
function parseTagsOutput(output) {
  if (!output || typeof output !== 'string') return [];
  const versions = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: <sha>\trefs/tags/<tagname>
    const match = trimmed.match(/refs\/tags\/(v?\d+\.\d+\.\d+[^\s^]*)$/);
    if (match) {
      // Skip annotated tag derefs (^{})
      const tag = match[1];
      if (tag.includes('^')) continue;
      versions.push(tag);
    }
  }
  return versions;
}

/**
 * Pure parser: given a `git remote get-url` style remote string, return
 * `{ owner, repo }` for GitHub remotes or `null` for everything else.
 *
 * Accepts the four remote forms real users + CI environments produce:
 *   - `https://github.com/<owner>/<repo>(.git)?(/)?`
 *   - `https://<user>(:<token>)?@github.com/<owner>/<repo>(.git)?(/)?` — `gh auth setup-git` tokenized clones
 *   - `ssh://git@github.com/<owner>/<repo>(.git)?(/)?` — Docker / CI variant
 *   - `git@github.com:<owner>/<repo>(.git)?` — classic SSH form
 *
 * Host match is case-insensitive (`GitHub.com` is served as a valid alias).
 * Owner and repo are restricted to GitHub's character class (`[A-Za-z0-9._-]+`)
 * as a defense-in-depth gate against malformed remotes propagating junk into
 * the rendered href even though `esc()` is the real escape boundary.
 *
 * @param {string} remoteUrl - Raw output of `git remote get-url origin`
 * @returns {{ owner: string, repo: string }|null}
 */
function _parseGitHubRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const segment = '[A-Za-z0-9._-]+';

  // HTTPS forms (with optional userinfo@ for tokenized clones), case-insensitive host
  let m = trimmed.match(new RegExp(`^https?://(?:[^@/]+@)?github\\.com/(${segment})/(${segment}?)(?:\\.git)?/?$`, 'i'));
  if (!m) {
    // ssh://git@github.com/<owner>/<repo>(.git)? — protocol form (Docker / CI)
    m = trimmed.match(new RegExp(`^ssh://git@github\\.com/(${segment})/(${segment}?)(?:\\.git)?/?$`, 'i'));
  }
  if (!m) {
    // git@github.com:<owner>/<repo>(.git)? — classic SCP-style SSH form
    m = trimmed.match(new RegExp(`^git@github\\.com:(${segment})/(${segment}?)(?:\\.git)?$`, 'i'));
  }
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Derive a GitHub release-tag URL base from the local repo's `origin` remote.
 * Mirrors the same `origin` that `checkForUpdate` polls for tags, so a fork
 * install links to its own fork's release pages instead of the canonical repo.
 *
 * Returns null on any non-GitHub remote, missing remote, or git failure
 * (caller falls back to omitting `releaseUrl` from the response).
 *
 * @returns {string|null} `https://github.com/<owner>/<repo>/releases/tag/` (trailing slash) or null
 */
function _getReleasesUrlBase() {
  // Memoized because this is a synchronous spawn and the request path now
  // reaches it on every page load and tab refocus. `origin` cannot change
  // under a running process without someone editing git config by hand, and a
  // synchronous spawn on this platform is not merely slow: an install whose
  // repo sits under a TCC-protected directory can have one hang outright
  // (#324). One call per process, off the hot path.
  if (_releasesUrlBase !== undefined) return _releasesUrlBase;
  const computed = _computeReleasesUrlBase();
  // Memoize only a real ANSWER. `undefined` means the read threw — and the very
  // hazard that motivated caching (a synchronous spawn hanging under a
  // TCC-protected directory, #324) is one that throws, so caching it would
  // trade a repeated 2s stall for permanently losing the release-notes link on
  // an install that is already in trouble. A parsed "not a GitHub remote" is a
  // genuine answer and is cached.
  if (computed !== undefined) _releasesUrlBase = computed;
  return computed === undefined ? null : computed;
}

/**
 * Read `origin` and derive the release-tag URL base. Uncached — callers go
 * through `_getReleasesUrlBase`.
 * @returns {string|null|undefined} The URL base; `null` when `origin` is not a
 *   GitHub remote (a real answer); `undefined` when the read failed (retryable).
 */
function _computeReleasesUrlBase() {
  try {
    const remote = _internal.gitRemote();

    const parsed = _parseGitHubRemote(remote);
    if (!parsed) return null;
    return `https://github.com/${parsed.owner}/${parsed.repo}/releases/tag/`;
  } catch (err) {
    log.debug('Could not derive releases URL base', { error: err.message });
    // NOT null — see `_getReleasesUrlBase`. A failure must stay retryable.
    return undefined;
  }
}

/**
 * Find the latest semver version from a list of version strings.
 * @param {string[]} versions
 * @returns {string|null}
 */
function findLatestVersion(versions) {
  let latest = null;
  let latestParsed = null;
  for (const v of versions) {
    const parsed = parseSemver(v);
    if (!parsed) continue;
    if (!latestParsed || compareSemver(parsed, latestParsed) > 0) {
      latestParsed = parsed;
      latest = v;
    }
  }
  return latest;
}

/**
 * Assemble a status payload from raw `git ls-remote --tags` output.
 *
 * Pure apart from logging and the local `git remote get-url` read, and the only
 * place the tag list is interpreted — the synchronous and asynchronous checks
 * differ solely in how they obtain `output`, so the two can never disagree about
 * what a given tag list means.
 *
 * `output === null` means the query did not produce a usable answer (it threw,
 * timed out, or the current version could not be read). That is reported as
 * `checkOk: false` rather than folded into "no update", because a check that
 * failed and a check that succeeded and found nothing are different facts: the
 * first must not be rendered to an operator as "you are up to date".
 *
 * @param {string|null} currentVersion - The running version, or null if unreadable
 * @param {string|null} output - Raw `git ls-remote --tags` stdout, or null on failure
 * @param {string} checkedAt - ISO timestamp for this attempt
 * @returns {{ updateAvailable: boolean, currentVersion: string|null, latestVersion: string|null, releaseUrl: string|null, repoRoot: string, checkedAt: string, checkOk: boolean }}
 */
function _buildStatus(currentVersion, output, checkedAt) {
  const unmeasured = {
    updateAvailable: false,
    currentVersion: currentVersion || null,
    latestVersion: null,
    releaseUrl: null,
    repoRoot: _repoRoot,
    checkedAt,
    checkOk: false
  };

  if (!currentVersion || output === null || output === undefined) return unmeasured;

  const latestTag = findLatestVersion(parseTagsOutput(output));

  // A reachable remote with no version tags IS a successful measurement — it
  // genuinely has nothing to offer — so this answers `checkOk: true` while the
  // failure path above does not.
  if (!latestTag) {
    log.debug('No remote tags found');
    return { ...unmeasured, checkOk: true };
  }

  const currentParsed = parseSemver(currentVersion);
  const latestParsed = parseSemver(latestTag);

  const updateAvailable = currentParsed && latestParsed
    ? compareSemver(latestParsed, currentParsed) > 0
    : false;

  // Normalize latestVersion without leading 'v'
  const latestVersion = latestTag.replace(/^v/, '');

  // Build release-tag URL from the same `origin` we just polled, so a fork
  // install gets fork-scoped links. Use the raw tag (which preserves any
  // leading `v`) so the URL matches what GitHub actually serves.
  const urlBase = _getReleasesUrlBase();
  const releaseUrl = urlBase ? `${urlBase}${latestTag}` : null;

  if (updateAvailable) {
    log.info(`Update available: v${currentVersion} → v${latestVersion}`);
  } else {
    log.debug(`Up to date: v${currentVersion}`);
  }

  return { updateAvailable, currentVersion, latestVersion, releaseUrl, repoRoot: _repoRoot, checkedAt, checkOk: true };
}

/**
 * Check for updates by fetching git remote tags, synchronously.
 *
 * Retained as the synchronous form because two callers need an answer inline:
 * the periodic timer, and `update-applier`'s pre-flight guard. Request handlers
 * must use `refreshIfStale` instead — this blocks the event loop for as long as
 * the network takes, up to the 15s timeout.
 *
 * @returns {{ updateAvailable: boolean, currentVersion: string|null, latestVersion: string|null, releaseUrl: string|null, repoRoot: string, checkedAt: string, checkOk: boolean }}
 */
function checkForUpdate() {
  const currentVersion = _getCurrentVersion();
  const checkedAt = new Date().toISOString();

  if (!currentVersion) {
    log.warn('Could not read current version');
    _cache = _buildStatus(null, null, checkedAt);
    return _cache;
  }

  let output = null;
  try {
    output = execSync('git ls-remote --tags origin', {
      cwd: _repoRoot,
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- offline, missing git, timeout and non-zero exit are one fact here: the remote could not be measured. Logged, then reported as checkOk:false.
    // warn, not debug — and this path matters MORE than the async one. This is
    // what the periodic timer drives and what `update-applier` runs pre-flight,
    // so it is the path that fails on an unattended server. `lib/logger.js`
    // defaults to `info`, so at debug an install that had silently stopped
    // being able to detect releases left no trace an operator would ever find.
    log.warn('Update check failed (likely offline)', { error: err.message });
  }

  _cache = _buildStatus(currentVersion, output, checkedAt);
  return _cache;
}

/**
 * Check for updates without blocking the event loop.
 *
 * Same measurement as `checkForUpdate`, over `execFile` instead of `execSync`.
 * This is the form anything request-triggered must use: the server is
 * single-threaded, so a synchronous `git ls-remote` on a slow or flaky network
 * would stall every other request — terminal websockets included — for up to
 * the full 15s timeout.
 *
 * @param {(status: object) => void} cb - Receives the fresh status; never called with an error
 * @returns {void}
 */
function checkForUpdateAsync(cb) {
  const currentVersion = _getCurrentVersion();
  const checkedAt = new Date().toISOString();

  if (!currentVersion) {
    log.warn('Could not read current version');
    _cache = _buildStatus(null, null, checkedAt);
    return void cb(_cache);
  }

  _internal.lsRemote((err, stdout) => {
    if (err) {
      // warn, not debug: `lib/logger.js` defaults to `info`, so a debug line
      // means an install that has silently stopped being able to detect
      // releases leaves no trace an operator would ever find.
      log.warn('Update check failed (likely offline)', { error: err.message });
    }
    _cache = _buildStatus(currentVersion, err ? null : stdout, checkedAt);
    cb(_cache);
  });
}

/**
 * The staleness floor a refresh request should use.
 *
 * Pure, and exported, because it is the one place the operator-asked-for-it
 * distinction turns into a number — inline in a route handler an inverted
 * ternary would hand automatic checks the aggressive floor and operator
 * requests the lazy one, which is exactly backwards and invisible in review.
 *
 * @param {boolean} manual - True when the operator explicitly asked
 * @returns {number} Milliseconds
 */
function resolveRefreshFloor(manual) {
  return manual === true ? MANUAL_REFRESH_MIN_AGE_MS : AUTO_REFRESH_MIN_AGE_MS;
}

/**
 * Serve the cached status when it is fresh enough, otherwise measure again.
 *
 * The entry point for every event-driven check (dashboard load, tab refocus, the
 * operator asking). Two properties make it safe to call from a request handler:
 *
 * - **Throttled** — a cache younger than `maxAgeMs` is returned as-is, so a
 *   reload loop cannot turn into a `git ls-remote` loop.
 * - **Single-flight** — concurrent callers past the throttle share one check
 *   rather than each starting their own, so open tabs do not multiply network
 *   calls against `origin`.
 *
 * A cache with no `checkedAt` (never measured) is always stale regardless of
 * `maxAgeMs` — that is the state a freshly booted server sits in, and it is
 * precisely when an answer is most wanted. A `checkedAt` in the future (clock
 * skew) is likewise treated as stale rather than trusted.
 *
 * @param {number} maxAgeMs - Serve cache when it is younger than this
 * @param {(status: object, refreshed: boolean) => void} cb - Status, and whether it was re-measured
 * @returns {void}
 */
function refreshIfStale(maxAgeMs, cb) {
  const cached = _cache;
  if (cached && cached.checkedAt) {
    const age = Date.now() - Date.parse(cached.checkedAt);
    if (Number.isFinite(age) && age >= 0 && age < maxAgeMs) {
      return void cb(cached, false);
    }
  }

  if (_inFlight) {
    _inFlight.push(cb);
    return;
  }

  _inFlight = [cb];
  checkForUpdateAsync((status) => {
    const waiting = _inFlight || [];
    _inFlight = null;
    for (const fn of waiting) {
      // Isolated per waiter. These callbacks write HTTP responses, and writing
      // to a socket the client already closed throws — an unguarded loop would
      // abandon every remaining waiter mid-fan-out, and the server's
      // non-exiting uncaughtException handler would turn those into requests
      // that simply never answer.
      try {
        fn(status, true);
      } catch (err) { // prawduct:allow prawduct/broad-except -- one waiter's failure must not strand its siblings; logged with context
        log.warn('update-status waiter threw', { error: err.message });
      }
    }
  });
}

/**
 * Get the cached update status.
 * @returns {{ updateAvailable: boolean, currentVersion: string|null, latestVersion: string|null, releaseUrl: string|null, repoRoot: string, checkedAt: string|null, checkOk: boolean }}
 *   `checkedAt: null` with `checkOk: false` is the never-measured state every
 *   boot passes through — consumers must not render it as up-to-date.
 */
function getCachedStatus() {
  if (_cache) return _cache;
  return { updateAvailable: false, currentVersion: _getCurrentVersion(), latestVersion: null, releaseUrl: null, repoRoot: _repoRoot, checkedAt: null, checkOk: false };
}

// How often a running server re-checks for a release. Four hours, not the
// twenty-four this shipped with: 24h was chosen for a quieter release cadence
// than this project has, and it meant a long-running server could sit most of a
// release's life without noticing it. One check is a single `git ls-remote`, so
// six a day instead of one costs nothing measurable.
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Floor for an operator-supplied interval. Guards against a typo (a stray unit,
// a value in seconds) turning into a tight poll against origin.
const MIN_CHECK_INTERVAL_MS = 60 * 1000;

// How fresh a cached answer must be for an automatic event-driven check (page
// load, tab refocus) to accept it instead of measuring again. Set at the
// dashboard's existing status-poll cadence: often enough that a release is
// noticed within minutes of the operator looking at the page, rare enough that
// backgrounding and foregrounding a phone all afternoon is not a poll loop
// against origin.
const AUTO_REFRESH_MIN_AGE_MS = 5 * 60 * 1000;

// The same floor for an explicit operator request. Far shorter, because someone
// who deliberately asks "is there an update?" is owed a real measurement rather
// than a minutes-old recollection — this exists only so a double-tap cannot
// start two checks.
const MANUAL_REFRESH_MIN_AGE_MS = 10 * 1000;

/**
 * Resolve the configured update-check interval to a usable value.
 *
 * Falls back to the default for anything missing, non-numeric, or below the
 * floor, rather than propagating it into `setInterval` — a malformed value there
 * would either poll origin continuously or (for `NaN`) silently degrade to a
 * timer that fires far more often than intended.
 *
 * @param {*} configured - Raw `config.updateCheckIntervalMs`
 * @returns {{ intervalMs: number, warning: string|null }} Resolved interval, and
 *   a reason string when the configured value was rejected (caller logs it —
 *   this stays pure so config regeneration can call it freely).
 */
function resolveCheckInterval(configured) {
  if (configured === undefined || configured === null) {
    return { intervalMs: DEFAULT_CHECK_INTERVAL_MS, warning: null };
  }
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return {
      intervalMs: DEFAULT_CHECK_INTERVAL_MS,
      warning: `updateCheckIntervalMs must be a number, got ${JSON.stringify(configured)}`
    };
  }
  if (configured < MIN_CHECK_INTERVAL_MS) {
    return {
      intervalMs: DEFAULT_CHECK_INTERVAL_MS,
      warning: `updateCheckIntervalMs ${configured}ms is below the ${MIN_CHECK_INTERVAL_MS}ms floor`
    };
  }
  return { intervalMs: configured, warning: null };
}

/**
 * Start the periodic update checker.
 * First check runs after initialDelayMs (default 60s), then every intervalMs
 * (default `DEFAULT_CHECK_INTERVAL_MS`).
 * @param {number} [intervalMs] - Check interval in ms; defaults to `DEFAULT_CHECK_INTERVAL_MS`
 * @param {number} [initialDelayMs=60000] - Delay before first check
 */
function startChecker(intervalMs, initialDelayMs) {
  stopChecker();
  const interval = intervalMs || DEFAULT_CHECK_INTERVAL_MS;
  const delay = typeof initialDelayMs === 'number' ? initialDelayMs : 60000;

  log.debug('Starting update checker', { intervalMs: interval, initialDelayMs: delay });

  // First check after delay
  _timer = setTimeout(() => {
    checkForUpdate();
    // Then periodic checks
    _timer = setInterval(() => {
      checkForUpdate();
    }, interval);
  }, delay);
}

/**
 * Stop the periodic update checker.
 */
function stopChecker() {
  if (_timer) {
    clearTimeout(_timer);
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Reset internal state (for testing).
 */
function _reset() {
  stopChecker();
  _cache = null;
  // Callbacks queued behind an in-flight check would otherwise survive into the
  // next test and be resolved by its measurement.
  _inFlight = null;
  _releasesUrlBase = undefined;
}

module.exports = {
  checkForUpdate,
  checkForUpdateAsync,
  refreshIfStale,
  resolveRefreshFloor,
  getCachedStatus,
  startChecker,
  stopChecker,
  _reset,
  AUTO_REFRESH_MIN_AGE_MS,
  MANUAL_REFRESH_MIN_AGE_MS,
  // Exposed for testing
  parseSemver,
  compareSemver,
  parseTagsOutput,
  findLatestVersion,
  resolveCheckInterval,
  DEFAULT_CHECK_INTERVAL_MS,
  MIN_CHECK_INTERVAL_MS,
  _getReleasesUrlBase,
  _parseGitHubRemote,
  _getCurrentVersion,
  _buildStatus,
  _internal
};
