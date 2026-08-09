'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('git');

const CACHE_TTL = 120000; // 2 minutes — short TTLs cause frequent event-loop blocking
const _cache = new Map();

/** Directories already warned about a truncated read; see `_fetchInfo`. */
const _warnedIncomplete = new Set();

/**
 * The identity a directory is cached and de-duplicated under.
 * @param {string} dir - Directory path
 * @returns {string}
 */
function cacheKeyFor(dir) {
  return path.resolve(dir);
}

/** Longest any single `git` invocation may run, regardless of budget left. */
const PER_CALL_CAP_MS = 5000;

/**
 * How long ALL of one directory's git work gets, in total.
 *
 * Reading a repository takes seven `git` invocations (see `_fetchInfo`). Capping
 * each of them separately meant the honest worst case was seven times the cap —
 * ~35s — while the scan deadline that kills the child process sits at 5s. A
 * repository whose git work merely stalled was therefore killed and reported to
 * the operator as a Full Disk Access problem, which it was not; and because the
 * kill discards this module's cache, the retry after the backoff was equally
 * cold and did it again.
 *
 * 4000ms is not a guess at how slow git can be. It is chosen so that this budget
 * plus the small root-level file reads that share the same deadline still fits
 * INSIDE that deadline (`lib/project-facts.js` derives the deadline from this
 * constant, so the two cannot drift apart). Measured against this repository —
 * 949 commits, 400 tracked files, warm — all seven invocations cost 85ms
 * together, so the budget carries roughly a 47x margin over a healthy read.
 *
 * A repository that genuinely needs longer returns a PARTIAL reading naming what
 * it could not establish, which is the point: a slow repository should cost a
 * missing badge, not a kill and a misdiagnosis.
 */
const GIT_INFO_BUDGET_MS = 4000;

/**
 * Execute a git command in a directory with timeout.
 * @param {string} command - Git command to run
 * @param {string} cwd - Working directory
 * @param {number} [timeout=PER_CALL_CAP_MS] - Timeout in ms
 * @returns {string} - stdout output
 */
function _exec(command, cwd, timeout = PER_CALL_CAP_MS) {
  return execSync(command, {
    cwd,
    timeout,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

/**
 * Whether OUR OWN cap killed this spawn, rather than git answering.
 *
 * `execSync` does NOT set `killed` on the error it throws — that flag belongs to
 * `spawnSync`'s result object. A timeout arrives as `code: 'ETIMEDOUT'` with
 * `signal: 'SIGTERM'`, so a `killed` check compiles, reads plausibly, and never
 * fires; every budget-truncated read would fall through to its documented
 * fallback and be reported as an answer. Both properties are checked because
 * they come from different layers and a Node change to either is survivable.
 *
 * @param {Error} err - Error thrown by `execSync`.
 * @returns {boolean}
 */
function _wasTimedOut(err) {
  return !!err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM');
}

/**
 * Check if a directory is a git repository.
 * @param {string} dir - Directory path
 * @returns {boolean}
 */
function isGitRepo(dir) {
  try {
    _exec('git rev-parse --is-inside-work-tree', dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get git info for a project directory. Results are cached with a 2-minute TTL.
 *
 * A PARTIAL reading — one whose `incomplete` names fields the budget could not
 * establish — is deliberately NOT cached. It records that the budget ran out
 * once, not that this repository is slow, and freezing it for the TTL would
 * repeat one bad reading across twelve polls of a repository that may be
 * answering fine by now.
 *
 * @param {string} dir - Project directory path
 * @param {object} [options] - Read options.
 * @param {number} [options.budgetMs] - Total wall clock for all git work here.
 * @returns {{ branch: string, dirty: boolean|null, lastCommit: string, lastCommitAge: string, latestTag: string|null, incomplete: string[] }|null}
 */
function getInfo(dir, options = {}) {
  const cacheKey = cacheKeyFor(dir);
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }

  const data = _fetchInfo(dir, options);
  if (!data || data.incomplete.length === 0) {
    _cache.set(cacheKey, { data, time: Date.now() });
  }
  return data;
}

/**
 * Fetch git info without caching, bounded by ONE budget across every spawn.
 *
 * Returns `null` only when the directory is genuinely not a repository. A
 * repository this ran out of budget on comes back as an object whose
 * `incomplete` names the fields it could not establish — never `null`, because
 * `lib/dir-scanner-child.js` derives whether a directory IS a project from
 * `gitInfo && gitInfo.branch`, and a slow repository must lose a badge rather
 * than stop being a project.
 *
 * An unestablished field is never given a plausible default. `dirty` in
 * particular becomes `null` and not `false`: the dashboard renders it as a dot,
 * so `false` would draw a dirty repository as clean — an unknown presented as a
 * definite answer.
 *
 * @param {string} dir - Project directory path
 * @param {object} [options] - Read options.
 * @param {number} [options.budgetMs] - Total wall clock for all git work here.
 * @returns {{ branch: string, dirty: boolean|null, lastCommit: string, lastCommitAge: string, latestTag: string|null, incomplete: string[] }|null}
 */
function _fetchInfo(dir, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : GIT_INFO_BUDGET_MS;
  const endsAt = Date.now() + budgetMs;
  const incomplete = [];

  /**
   * Run one git step if budget remains, else record the field as unestablished.
   *
   * The zero check is load-bearing rather than defensive: `execSync` treats
   * `timeout: 0` as NO timeout, so a cap computed as min(perCall, remaining)
   * becomes UNBOUNDED the instant the budget reaches zero — the very inversion
   * this budget exists to remove. An exhausted budget must skip, never spawn.
   *
   * A spawn our own cap KILLED is unestablished too, not answered: the caller's
   * documented fallback would otherwise present "we stopped looking" as a fact.
   * Any other failure means git itself answered (or is absent), and there the
   * fallback is the honest result.
   *
   * @param {string} field - Field name to record when this cannot be answered.
   * @param {*} fallback - Value to use when it cannot be answered.
   * @param {(timeout: number) => *} run - Runs the step under the given cap.
   * @returns {*}
   */
  const step = (field, fallback, run) => {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      incomplete.push(field);
      return fallback;
    }
    try {
      return run(Math.min(PER_CALL_CAP_MS, remaining));
    } catch (err) {
      if (_wasTimedOut(err)) incomplete.push(field);
      return fallback;
    }
  };

  // Whether this is a repository at all is answered first and separately: every
  // field below is meaningless without it, and it is the cheapest of the seven.
  const repoCheck = step('branch', null, (t) => {
    _exec('git rev-parse --is-inside-work-tree', dir, t);
    return true;
  });
  if (repoCheck === null) {
    // Distinguish "we could not look" from "not a repository". Only the latter
    // is an answer; the former must not be cached as one, and `incomplete`
    // carrying `branch` is what tells `getInfo` to leave it out of the cache.
    if (incomplete.length === 0) return null;
    return {
      branch: 'unknown', dirty: null, lastCommit: '', lastCommitAge: '', latestTag: null,
      incomplete: ['branch', 'dirty', 'lastCommit', 'lastCommitAge', 'latestTag']
    };
  }

  const branch = step('branch', 'unknown',
    (t) => _exec('git rev-parse --abbrev-ref HEAD', dir, t));
  const dirty = step('dirty', null,
    (t) => _exec('git status --porcelain', dir, t).length > 0);

  // Whether the repository has any commits at all, before asking log/describe
  // about them.
  //
  // A repository with NO commits is a real answer — `git rev-parse HEAD` fails
  // there, and empty message/age/tag are the truth about it. A probe the budget
  // cut short is NOT an answer, and it fails the same way. The two are told
  // apart by whether the step recorded the field, never by the return value,
  // which is identical in both cases; reading the value alone reported every
  // freshly-initialised repository as unestablished.
  const beforeProbe = incomplete.length;
  const hasCommits = step('lastCommit', false, (t) => {
    _exec('git rev-parse HEAD', dir, t);
    return true;
  });
  const probeAnswered = incomplete.length === beforeProbe;

  let lastCommit = '';
  let lastCommitAge = '';
  let latestTag = null;
  if (hasCommits) {
    lastCommit = step('lastCommit', '', (t) => _exec('git log -1 --format=%s', dir, t));
    lastCommitAge = step('lastCommitAge', '', (t) => _exec('git log -1 --format=%cr', dir, t));
    latestTag = step('latestTag', null, (t) => _exec('git describe --tags --abbrev=0', dir, t));
  } else if (!probeAnswered) {
    // The probe was skipped or killed, so nothing downstream of it was even
    // attempted. Say so for each field rather than letting three empty values
    // pass for "this repository has no commits".
    for (const field of ['lastCommitAge', 'latestTag']) {
      if (!incomplete.includes(field)) incomplete.push(field);
    }
  }

  if (incomplete.length > 0) {
    // Loud ONCE per directory, quiet afterwards. A partial is deliberately not
    // cached, so a persistently slow repository re-reads on every ten-second
    // poll — warning each time would emit this several times a minute and bury
    // the warning it is meant to be. The same call is made one layer up for a
    // remembered refusal, and for the same reason.
    //
    // Per process rather than per interval: this runs in a child the supervisor
    // recreates, so the set dies with it and a genuinely new incident is loud
    // again without a timer to get wrong.
    const level = _warnedIncomplete.has(cacheKeyFor(dir)) ? 'debug' : 'warn';
    _warnedIncomplete.add(cacheKeyFor(dir));
    log[level]('Git info incomplete — ran out of budget', { dir, budgetMs, fields: incomplete });
  }

  return {
    branch, dirty, lastCommit, lastCommitAge, latestTag,
    // De-duplicated: the has-commits probe and the message read share a field
    // name, so a budget that dies on the probe would otherwise name it twice.
    incomplete: [...new Set(incomplete)]
  };
}

/**
 * Check if the working directory has uncommitted changes.
 *
 * Kept separate from `_fetchInfo`'s budgeted read because `commit` needs a
 * straight yes/no under the ordinary per-call cap, with no partial answer to
 * interpret.
 *
 * @param {string} dir - Repository directory
 * @returns {boolean}
 */
function _isDirty(dir) {
  try {
    const output = _exec('git status --porcelain', dir);
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage all changes and commit with the given message.
 * @param {string} dir - Repository directory
 * @param {string} message - Commit message
 * @returns {{ committed: boolean, error?: string }}
 */
function commit(dir, message) {
  try {
    if (!_isDirty(dir)) {
      return { committed: false };
    }
    _exec('git add -A', dir, 10000);
    // Escape single quotes in commit message
    const escaped = message.replace(/'/g, "'\\''");
    _exec(`git commit -m '${escaped}'`, dir, 15000);
    log.info('Auto-committed changes', { dir, message });
    clearCacheFor(dir);
    return { committed: true };
  } catch (err) {
    log.warn('Auto-commit failed', { dir, error: err.message });
    return { committed: false, error: err.message };
  }
}

/**
 * Clear the git info cache. Useful for testing or forcing refresh.
 */
function clearCache() {
  _cache.clear();
  _warnedIncomplete.clear();
}

/**
 * Clear cache for a specific directory.
 * @param {string} dir - Directory path to clear
 */
function clearCacheFor(dir) {
  _cache.delete(cacheKeyFor(dir));
  _warnedIncomplete.delete(cacheKeyFor(dir));
}

module.exports = {
  isGitRepo,
  commit,
  getInfo,
  clearCache,
  clearCacheFor,
  GIT_INFO_BUDGET_MS,
  PER_CALL_CAP_MS,
  _exec,
  _fetchInfo
};
