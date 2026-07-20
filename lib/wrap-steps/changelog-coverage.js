'use strict';

/**
 * Changelog coverage predicate — the second satisfaction route for the wrap's
 * `changelog-update` gate.
 *
 * **Why this exists.** The gate that guards a file-edit content step asks whether
 * the declared file CHANGED between the pre-AI snapshot and the post-AI read. For
 * `CHANGELOG.md` that is the wrong question. A project whose rules say "update the
 * changelog with every change" arrives at the wrap with the changelog already
 * complete and nothing left to write, so the mutation check blocks precisely the
 * sessions that complied (GH #645). This module answers the question the gate
 * actually wants: was the changelog MAINTAINED for the work this session shipped?
 *
 * **The predicate.** Every non-merge, non-wrap commit in the session range must
 * have touched the changelog in its own diff. Per-commit rather than
 * once-per-session, because the rule being verified is per-change; a single edit
 * vouching for a ten-commit session is the weaker claim.
 *
 * **Why not match issue references.** The obvious predicate — every commit's `#N`
 * appears under `[Unreleased]` — does not survive contact with real history. A
 * squash merge appends the PULL REQUEST number to the subject, while changelog
 * entries cite the ISSUE. They are different number spaces that systematically do
 * not match: run over this repo's own history, ref-matching reported 12 of 12
 * correctly-logged commits as uncovered. Resolving PR→issue would put a `gh` call
 * and a network dependency inside a wrap gate. What a commit TOUCHED is already
 * in the local repo and needs no convention at all.
 *
 * **Three-valued on purpose.** `unavailable` is not a failure: with no commits to
 * judge, this module cannot speak to whether the step did its job, and says so, so
 * the caller falls back to the mutation check rather than passing on no evidence.
 *
 * **Merge commits are exempt.** `git log --name-only` reports no paths for a true
 * merge, and a merge introduces no changelog obligation of its own — the
 * obligation belonged to the commits being merged, which are judged on their own.
 * Treating a merge as untouched would block on the absence of evidence.
 */

const { execSync } = require('node:child_process');
const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-steps:changelog-coverage');

const GIT_EXEC_TIMEOUT_MS = 10000;

/** Full-40 or abbreviated hex SHA, matching the shape `lastWrapSha` is stamped in. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Subject prefix of every commit the wrap itself creates. `lib/wrap-steps/commit.js`
 * builds subjects as `Session wrap`, `Session wrap (chunk N)`, or `Session wrap on
 * <branch>`, and the prefix survives the squash-merge of a wrap PR — it still
 * identifies the commit once it lands on the trunk as `Session wrap — release
 * 4.30.0 (…) (#658)`. Matching the prefix rather than the whole subject is what
 * makes the exclusion hold post-squash.
 *
 * Excluding them is required, not cosmetic: the wrap's own bookkeeping commit is
 * created by the commit step AFTER this gate runs, so holding it to the same rule
 * would judge the session on a commit it has not made yet.
 */
const WRAP_SUBJECT_RE = /^Session wrap\b/;

/**
 * Record separator for `git log --format`. `--name-only` prints a variable-length
 * file list after each record, so records need an unambiguous start marker rather
 * than a fixed line count. ASCII RS and US are used because a commit subject may
 * contain any printable character, so any printable delimiter could occur inside
 * the subject itself and split the record in the wrong place.
 */
const RECORD_SEP = '\x1e';

/** Field separator within one record. `git log`'s `%x1f` emits the same byte. */
const FIELD_SEP = '\x1f';

const VERDICTS = Object.freeze({
  COVERED: 'covered',
  UNCOVERED: 'uncovered',
  UNAVAILABLE: 'unavailable'
});

/**
 * Evaluate changelog coverage for a project's current session.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {string[]} paths - Project-relative paths that satisfy the obligation
 *   (the step's `verifyChanged` list). A commit counts as covered when it touched
 *   any one of them. Taken from the step spec rather than hardcoded so the path
 *   the gate snapshots and the path the predicate looks for cannot drift apart.
 * @returns {{verdict:string, uncovered:Array<{sha:string, subject:string}>, checkedCount:number, range:(string|null), reason:(string|null)}}
 *   `verdict` is one of `covered` | `uncovered` | `unavailable`. `uncovered` lists
 *   the commits that did not touch any declared path (empty otherwise).
 *   `checkedCount` is how many commits the verdict was computed over. `reason`
 *   explains an `unavailable` verdict and is null otherwise.
 */
function evaluate(projectPath, paths) {
  const wanted = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
  if (wanted.length === 0) {
    return _unavailable('no paths declared to check', null);
  }

  let lastWrapSha = null;
  try {
    const projConfig = _internal.loadProjectConfig(projectPath);
    lastWrapSha = (projConfig && projConfig.lastWrapSha) || null;
  } catch (err) {
    // A missing or unreadable project config is not an error here — it only means
    // no session SHA is recorded, and the base-branch fallback applies.
    log.debug('Could not load project config for changelog coverage', { error: err.message });
  }

  const range = _resolveLogRange(projectPath, lastWrapSha);
  if (!range) {
    return _unavailable('no session range resolves (no lastWrapSha and no main/master base branch)', null);
  }

  let commits;
  try {
    commits = _listCommits(projectPath, range);
  } catch (err) {
    return _unavailable(`could not list commits in ${range}: ${err.message}`, range);
  }

  const checkable = commits.filter((c) => !_isWrapCommit(c.subject) && !c.isMerge);
  if (checkable.length === 0) {
    return _unavailable('the session range contains no commits this predicate can judge', range);
  }

  const wantedSet = new Set(wanted);
  const uncovered = checkable
    .filter((c) => !c.files.some((f) => wantedSet.has(f)))
    .map(({ sha, subject }) => ({ sha, subject }));

  if (uncovered.length === 0) {
    log.info('changelog coverage satisfied', { range, checkedCount: checkable.length });
    return { verdict: VERDICTS.COVERED, uncovered: [], checkedCount: checkable.length, range, reason: null };
  }

  log.warn('changelog coverage incomplete', {
    range,
    checkedCount: checkable.length,
    uncoveredCount: uncovered.length
  });
  return { verdict: VERDICTS.UNCOVERED, uncovered, checkedCount: checkable.length, range, reason: null };
}

/**
 * Build an `unavailable` verdict — the predicate could not judge, so the caller
 * must fall back to its own check rather than read this as pass or fail.
 *
 * @param {string} reason - Why the predicate could not judge.
 * @param {string|null} range - The resolved range, when one was resolved.
 * @returns {{verdict:string, uncovered:Array, checkedCount:number, range:(string|null), reason:string}}
 */
function _unavailable(reason, range) {
  log.debug('changelog coverage unavailable', { reason, range });
  return { verdict: VERDICTS.UNAVAILABLE, uncovered: [], checkedCount: 0, range, reason };
}

/**
 * Resolve the commit range for the session, preferring the recorded wrap SHA and
 * falling back to the trunk branch.
 *
 * **Two-dot, deliberately.** `lib/wrap-steps/features-toc.js` resolves a
 * comparable range using three-dot (`main...HEAD`) because it feeds `git diff`,
 * where three-dot means "diff against the merge base". Fed to `git log`, three-dot
 * means the SYMMETRIC difference — it would list commits present on the base and
 * absent from HEAD, which are not this session's work. The ranges are not
 * interchangeable across those two commands; this module needs `<base>..HEAD`.
 *
 * @param {string} cwd - Absolute project root.
 * @param {string|null} lastWrapSha - `projConfig.lastWrapSha`, or null.
 * @returns {string|null} A git revision range, or null when none resolves.
 */
function _resolveLogRange(cwd, lastWrapSha) {
  if (lastWrapSha && SHA_RE.test(lastWrapSha) && _isResolvableCommit(cwd, lastWrapSha)) {
    return `${lastWrapSha}..HEAD`;
  }
  for (const candidate of ['main', 'master']) {
    if (_isResolvableCommit(cwd, candidate)) return `${candidate}..HEAD`;
  }
  return null;
}

/**
 * Whether `ref` resolves to a commit in the local repo. Peels with `^{commit}` so
 * a tag or tree object cannot masquerade as a valid range endpoint.
 *
 * @param {string} cwd - Absolute project root.
 * @param {string} ref - A git ref or SHA.
 * @returns {boolean}
 */
function _isResolvableCommit(cwd, ref) {
  try {
    _internal.execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, {
      cwd,
      timeout: GIT_EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List the commits in `range` with the paths each one touched.
 *
 * One `git log` invocation rather than a `git show` per commit: a session can
 * carry dozens of commits, and the per-commit form would pay a process spawn for
 * each. `--name-only` appends a variable-length path list to every record, which
 * is why records are delimited by {@link RECORD_SEP} rather than by line count.
 *
 * @param {string} cwd - Absolute project root.
 * @param {string} range - A git revision range.
 * @returns {Array<{sha:string, subject:string, isMerge:boolean, files:string[]}>}
 */
function _listCommits(cwd, range) {
  const stdout = _internal.execSync(
    `git log --format=%x1e%H%x1f%P%x1f%s --name-only ${range}`,
    { cwd, encoding: 'utf8', timeout: GIT_EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return String(stdout || '')
    .split(RECORD_SEP)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => _parseRecord(chunk));
}

/**
 * Parse one `git log --name-only` record: a header line of
 * `<sha><US><parents><US><subject>` followed by the touched paths.
 *
 * @param {string} chunk - One record, without its leading separator.
 * @returns {{sha:string, subject:string, isMerge:boolean, files:string[]}}
 */
function _parseRecord(chunk) {
  const lines = chunk.split('\n');
  const [sha = '', parents = '', ...subjectParts] = String(lines[0] || '').split(FIELD_SEP);
  const files = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    sha,
    // A subject containing the field separator would otherwise be truncated.
    subject: subjectParts.join(FIELD_SEP),
    isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
    files
  };
}

/**
 * Whether a commit subject belongs to the wrap's own bookkeeping.
 *
 * @param {string} subject - Commit subject line.
 * @returns {boolean}
 */
function _isWrapCommit(subject) {
  return WRAP_SUBJECT_RE.test(String(subject || ''));
}

const _internal = {
  execSync,
  loadProjectConfig: (projectPath) => store.projectConfig.load(projectPath)
};

module.exports = {
  evaluate,
  VERDICTS,
  _internal,
  _resolveLogRange,
  _listCommits,
  _parseRecord,
  _isWrapCommit
};
