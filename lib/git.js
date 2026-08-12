'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');
const { createLogger } = require('./logger');
const { wasTimedOut } = require('./exec-timeout');

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
 * Reading a repository takes three `git` invocations (see `_fetchInfo`). Capping
 * each of them separately meant the honest worst case was a multiple of the cap,
 * while the scan deadline that kills the child process sits at 5s. A repository
 * whose git work merely stalled was therefore killed and reported to the operator
 * as a Full Disk Access problem, which it was not; and because the kill discards
 * this module's cache, the retry after the backoff was equally cold and did it
 * again.
 *
 * 4000ms is not a guess at how slow git can be. It is chosen so that this budget
 * plus the small root-level file reads that share the same deadline still fits
 * INSIDE that deadline (`lib/project-facts.js` derives the deadline from this
 * constant, so the two cannot drift apart). The margin over a healthy read is
 * large — a warm read of this repository costs tens of milliseconds against a
 * 4000ms budget — and it grew when the read went from seven invocations to three,
 * because there are fewer places for it to stall. Re-measure rather than trusting
 * a figure quoted here; the one that used to sit in this sentence described a
 * seven-invocation read that no longer exists.
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
 * Report the fields a read could not establish — loud once, quiet after.
 *
 * A partial is deliberately not cached, so a repository that stays slow re-reads
 * on every ten-second poll; warning each time would emit this several times a
 * minute per project and bury the warning it is meant to be. The same call
 * `lib/project-facts.js` makes for a remembered refusal.
 *
 * Per process rather than per interval: this runs in a child the supervisor
 * recreates, so the set dies with it and a genuinely new incident is loud again
 * without a timer to get wrong.
 *
 * @param {string} dir - Directory the read was for.
 * @param {number} budgetMs - Budget the read was given.
 * @param {string[]} fields - Field names that were not established.
 * @returns {void}
 */
function _reportIncomplete(dir, budgetMs, fields) {
  const key = cacheKeyFor(dir);
  const level = _warnedIncomplete.has(key) ? 'debug' : 'warn';
  _warnedIncomplete.add(key);
  // Says what is true of every case: these fields were not established. The
  // budget is the usual cause but not the only one — a `git status` that fails
  // for its own reasons lands here too, and naming the budget would report a
  // cause that did not happen.
  log[level]('Git info incomplete — fields not established', { dir, budgetMs, fields });
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
 * Read branch, dirtiness and has-commits out of one `status` output.
 *
 * Every shape below was measured against real fixture repositories rather than
 * recalled, because this parser is the whole reason three invocations can replace
 * seven. `git status --porcelain=v1 --branch` prints a `## ` header line and then
 * one line per changed path:
 *
 *   `## main`                      — clean or dirty, no upstream
 *   `## main...origin/main`        — tracking
 *   `## main...origin/main [ahead 1]` — tracking, diverged
 *   `## HEAD (no branch)`          — detached
 *   `## No commits yet on main`    — unborn HEAD, and it EXITS 0
 *
 * Two of those are worth stating because they remove guards rather than add them:
 *
 * An unborn HEAD does not fail. `rev-parse --abbrev-ref HEAD` does fail there, and
 * the code this replaced answered `'unknown'` for every freshly-initialised
 * repository; git names the branch here, so the honest answer is available.
 *
 * Splitting on `...` is unambiguous, because a branch name cannot contain it —
 * git's refname rules forbid `..` anywhere, and `git branch 'has...dots'` is
 * refused outright. There is deliberately no guard for that case; it cannot occur.
 *
 * @param {string} output - Raw stdout from `git status --porcelain=v1 --branch`.
 * @returns {{ branch: string, dirty: boolean, hasCommits: boolean }}
 */
function _parseStatus(output) {
  const lines = String(output || '').split('\n');
  const header = (lines[0] || '').trim();
  // Anything after the header is a changed path. `_exec` trims, so a clean tree
  // is exactly one line.
  const dirty = lines.slice(1).some((line) => line.trim().length > 0);

  const rest = header.startsWith('## ') ? header.slice(3) : header;

  // Detached: git says so in words. `'HEAD'` is what `rev-parse --abbrev-ref`
  // answered here before the collapse, and callers already read it that way.
  if (rest.startsWith('HEAD (no branch)')) {
    return { branch: 'HEAD', dirty, hasCommits: true };
  }

  // Unborn HEAD. The branch exists as a name even though nothing points at it.
  const NO_COMMITS = 'No commits yet on ';
  if (rest.startsWith(NO_COMMITS)) {
    return { branch: rest.slice(NO_COMMITS.length).trim() || 'unknown', dirty, hasCommits: false };
  }

  // `<branch>...<upstream>[ ahead/behind]`. The upstream and the divergence
  // counts are deliberately dropped: nothing renders them, and parsing a field
  // no one reads is a second thing to keep correct.
  const branch = rest.split('...')[0].split(' ')[0].trim();
  return { branch: branch || 'unknown', dirty, hasCommits: true };
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
 * @param {Function} [options.execFn] - Injected `_exec`. The point of this change
 *   is HOW MANY invocations happen, and a count cannot be observed from the
 *   outside — the answers are identical either way, which is the whole claim.
 *   Same seam, same name, as `lib/tmux.js` and `lib/engines.js`.
 * @returns {{ branch: string, dirty: boolean|null, lastCommit: string, lastCommitAge: string, latestTag: string|null, incomplete: string[] }|null}
 */
function _fetchInfo(dir, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : GIT_INFO_BUDGET_MS;
  const exec = options.execFn || _exec;
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
   * A spawn our own cap KILLED is unestablished, not answered: the caller's
   * documented fallback would otherwise present "we stopped looking" as a fact.
   * Whether any OTHER failure counts as an answer is the caller's call, because
   * it differs per field — see `errorIsAnswer`.
   *
   * @param {string} field - Field name to record when this cannot be answered.
   * @param {*} fallback - Value to use when it cannot be answered.
   * @param {(timeout: number) => *} run - Runs the step under the given cap.
   * @param {boolean} [errorIsAnswer=false] - Whether a git-side failure IS the
   *   answer. True for the three probes whose failure is informative — not a
   *   repository, no commits, no tags — where the fallback stands as fact. False
   *   everywhere else, because "git errored" tells us nothing about the value.
   * @returns {{ok: boolean, value: *}} `ok` is the single source of truth for
   *   whether this field was established; every caller branches on it and none
   *   re-derives it from the value, the array, or a length snapshot.
   */
  const step = (field, fallback, run, errorIsAnswer = false) => {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      incomplete.push(field);
      return { ok: false, value: fallback };
    }
    try {
      return { ok: true, value: run(Math.min(PER_CALL_CAP_MS, remaining)) };
    } catch (err) {
      if (errorIsAnswer && !wasTimedOut(err)) return { ok: true, value: fallback };
      incomplete.push(field);
      return { ok: false, value: fallback };
    }
  };

  // ONE invocation answers three questions: is this a repository, what branch is
  // it on, and is the tree dirty. `--porcelain=v1` fixes the format across git
  // versions; `--branch` adds the leading `## ` line.
  //
  // A git-side failure is NOT an answer here, which is the difference from the
  // probe this replaced. `status` fails on a repository whose `.git/index` is
  // merely unreadable — measured, exit 128 — while that same directory answers
  // `rev-parse --is-inside-work-tree` with `true`. So a failure sends us to that
  // probe to settle repository-or-not, rather than concluding it here.
  const status = step('branch', null, (t) => exec('git status --porcelain=v1 --branch', dir, t));

  if (!status.ok) {
    // `status` did not answer. Ask the one question that decides whether this
    // directory is a project at all — the SAME command that used to decide it,
    // so this path's verdict is unchanged from before the collapse.
    //
    // Its failure IS the answer: not a repository. Its success means we have a
    // repository we could not read, which must come back as a partial reading
    // and never as `null` — `lib/dir-scanner-child.js` derives whether a
    // directory IS a project from `gitInfo && gitInfo.branch`, so `null` here
    // would delete a broken project from the dashboard instead of costing it a
    // badge.
    const repo = step('branch', false, (t) => {
      exec('git rev-parse --is-inside-work-tree', dir, t);
      return true;
    }, true);
    if (repo.ok && repo.value !== true) return null;

    // Either we could not look at all, or this is a repository we could not
    // read. Both establish nothing, and this exit returns early, so it reports
    // on its own way out rather than falling through to the shared report below.
    const nothing = ['branch', 'dirty', 'lastCommit', 'lastCommitAge', 'latestTag'];
    _reportIncomplete(dir, budgetMs, nothing);
    return {
      branch: 'unknown', dirty: null, lastCommit: '', lastCommitAge: '', latestTag: null,
      incomplete: nothing
    };
  }

  const parsed = _parseStatus(status.value);
  // `dirty` follows `status`: it was established by the same invocation that
  // established the branch, so it cannot be separately unknown here. When
  // `status` did NOT run, the early return above already reports it as `null`
  // rather than `false` — an unknown must never render as a clean repository.
  const branch = parsed.branch;
  const dirty = parsed.dirty;

  let lastCommit = '';
  let lastCommitAge = '';
  let latestTag = null;
  // Whether the repository has any commits is now read POSITIVELY, off the `## `
  // line, instead of being inferred from a failing `rev-parse HEAD`. That probe
  // treated ANY non-timeout failure as "no commits", so a repository that failed
  // it for some other reason was reported as empty; a marker git prints on
  // purpose cannot be wrong that way. It also costs nothing: an unborn
  // repository now reads in ONE invocation rather than four.
  if (parsed.hasCommits) {
    // Two fields in one invocation. `%s` is the subject and is always exactly one
    // line — git folds a multi-line first paragraph into it — so a two-line
    // format cannot be pulled out of alignment by a commit message.
    const logged = step('lastCommit', null,
      (t) => exec('git log -1 --format=%s%n%cr', dir, t));
    if (logged.ok) {
      const lines = String(logged.value).split('\n');
      lastCommit = (lines[0] || '').trim();
      lastCommitAge = (lines[1] || '').trim();
    } else {
      // One invocation, two fields: neither was established.
      if (!incomplete.includes('lastCommitAge')) incomplete.push('lastCommitAge');
    }
    // No tags is an answer, not a gap.
    latestTag = step('latestTag', null,
      (t) => exec('git describe --tags --abbrev=0', dir, t), true).value;
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
    _reportIncomplete(dir, budgetMs, incomplete);
  }

  return {
    branch,
    dirty,
    lastCommit,
    lastCommitAge,
    latestTag,
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
  _exec,
  _fetchInfo
};
