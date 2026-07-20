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
 * **An uncommitted edit to a declared path satisfies the predicate outright** — the
 * changelog is being maintained, whether by the operator answering a block or by an
 * earlier turn that has not committed yet. This is also what makes a coverage
 * block's remediation honest: writing the missing entry clears it, with no need to
 * commit first.
 *
 * **Known gap: work still uncommitted at wrap time is not judged.** It gets swept
 * into the wrap's own commit, which the next session's range starts after, so no
 * later run sees it either. Demanding an entry for any dirty file was tried and
 * reverted: a session dirties tracked bookkeeping files (`.prawduct/change-log.md`
 * on this repo) as a matter of course, so that rule blocked exactly the compliant
 * sessions #645 is about — the original defect in a narrower costume. The mutation
 * route still covers the case where the session edits the changelog during the
 * step. Tracked as a follow-up rather than closed with a rule that misfires.
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
const gitRange = require('./_git-range');

const log = createLogger('wrap-steps:changelog-coverage');

const GIT_EXEC_TIMEOUT_MS = gitRange.GIT_EXEC_TIMEOUT_MS;

/**
 * Output cap for the commit listing, matching the ceiling `commit.js` and
 * `pr-check.js` use for their git calls. `--name-only` emits every touched path for
 * every commit, so a first wrap on a long-lived branch can run to megabytes —
 * past `execSync`'s 1MB default this throws, which the caller degrades to
 * `unavailable`, i.e. the gate silently reverts to blocking on the projects with
 * the most history.
 */
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

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
    log.info('Could not load project config; using the trunk range', { error: err.message });
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

  const wantedSet = new Set(wanted);

  // Committed history alone would miss an entry written earlier in the session but
  // not yet committed, so the declared paths' working-tree state is read too.
  //
  // This reads the declared paths ONLY. Judging the rest of the dirty tree — the
  // symmetric "uncommitted work with no entry is unlogged" rule — was implemented
  // and reverted: a session dirties tracked bookkeeping files as a matter of
  // course, so it blocked the compliant sessions this predicate exists to unblock.
  // Do not re-add it without a way to tell work from bookkeeping (see #659 and the
  // module header). This is not an oversight to be tidied up.
  let dirty;
  try {
    dirty = _dirtyPaths(projectPath);
  } catch (err) {
    return _unavailable(`could not read the working tree: ${err.message}`, range);
  }
  const declaredDirty = dirty.filter((f) => wantedSet.has(f));

  // An uncommitted edit to a declared path IS the changelog being maintained for
  // this session — by the operator, or by an earlier turn. It also makes the
  // remediation honest: writing the missing entry is what clears a coverage block.
  if (declaredDirty.length > 0) {
    log.info('changelog coverage satisfied by an uncommitted edit', {
      range, declaredDirty
    });
    return {
      verdict: VERDICTS.COVERED, uncovered: [], checkedCount: 0, range, reason: null
    };
  }

  // A commit with no files in scope is not judgeable. Two cases reach here: a true
  // merge, whose changelog obligation belonged to the commits being merged; and —
  // in a project rooted below its repo root — a commit that touched only paths
  // outside the project, which are not this project's concern. Both would
  // otherwise read as "touched nothing, therefore unlogged".
  const checkable = commits.filter(
    (c) => !_isWrapCommit(c.subject) && !c.isMerge && c.files.length > 0
  );
  if (checkable.length === 0) {
    return _unavailable('the session range contains no commits this predicate can judge', range);
  }

  const uncovered = checkable
    .filter((c) => !c.files.some((f) => wantedSet.has(f)))
    .map(({ sha, subject }) => ({ sha, subject }));
  const checkedCount = checkable.length;

  if (uncovered.length === 0) {
    log.info('changelog coverage satisfied', { range, checkedCount });
    return { verdict: VERDICTS.COVERED, uncovered: [], checkedCount, range, reason: null };
  }

  log.warn('changelog coverage incomplete', {
    range,
    checkedCount,
    uncoveredCount: uncovered.length
  });
  return { verdict: VERDICTS.UNCOVERED, uncovered, checkedCount, range, reason: null };
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
  // info, not debug: `lib/logger.js` defaults to info, and this is the one path
  // where the operator gets the old mutation blocker with no sign the predicate
  // ran. Silent abstention is indistinguishable from the feature not existing.
  log.info('changelog coverage unavailable — falling back to the mutation check', { reason, range });
  return { verdict: VERDICTS.UNAVAILABLE, uncovered: [], checkedCount: 0, range, reason };
}

/**
 * Resolve the commit range for the session, delegating to the shared resolver.
 *
 * **Two-dot, deliberately.** Three-dot means "since the merge base" to `git diff`
 * but the SYMMETRIC difference to `git log` — it would list commits present on the
 * base and absent from HEAD, which are not this session's work. `features-toc`
 * asks the same resolver for the three-dot form because it feeds `git diff`.
 *
 * @param {string} cwd - Absolute project root.
 * @param {string|null} lastWrapSha - `projConfig.lastWrapSha`, or null.
 * @returns {string|null} A git revision range, or null when none resolves.
 */
function _resolveLogRange(cwd, lastWrapSha) {
  const resolved = gitRange.resolveSessionRange(cwd, lastWrapSha, {
    dots: 'two',
    exec: _internal.execSync
  });
  return resolved ? resolved.range : null;
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
    `git log --format=%x1e%H%x1f%P%x1f%s --name-only --relative ${range}`,
    {
      cwd,
      encoding: 'utf8',
      timeout: GIT_EXEC_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore']
    }
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
 * List tracked paths modified in the working tree relative to `HEAD`, staged or
 * not, as paths relative to `cwd`.
 *
 * `--relative` for the same reason the commit listing needs it: git reports
 * repository-root-relative paths by default, and a project rooted in a
 * subdirectory of its repo would then match none of its own declared paths.
 *
 * Untracked files are deliberately excluded. A brand-new file has no `HEAD`
 * version to differ from, and a tree full of scratch files should not read as
 * unlogged work.
 *
 * @param {string} cwd - Absolute project root.
 * @returns {string[]}
 */
function _dirtyPaths(cwd) {
  const stdout = _internal.execSync('git diff --name-only --relative HEAD', {
    cwd,
    encoding: 'utf8',
    timeout: GIT_EXEC_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
  _isWrapCommit,
  _dirtyPaths
};
