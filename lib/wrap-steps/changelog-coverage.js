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
 * **The predicate.** The session range is covered if ANY non-merge, non-wrap
 * commit in it touched the changelog — the obligation is "the changelog was
 * maintained for this session's work", not "every commit logged itself in its own
 * diff". A session that writes one entry for several commits, backfills its log in
 * a single commit, or lands a doc-only / bookkeeping commit beside its logged work
 * all satisfy it. Per-commit was tried first and was stricter than the rule it
 * enforced: it false-blocked exactly those disciplined sessions (GH #665). The
 * completeness of the entry is driven by the wrap's changelog-update step; this
 * predicate confirms the changelog was maintained, not that each change self-logged.
 *
 * **A commit satisfies by touching any declared path OR any coverage glob.** The
 * declared paths (the step's `verifyChanged`) are matched exactly, so a lookalike
 * elsewhere in the tree does not count. A monorepo keeps a changelog per package,
 * and a commit that logs its change to that nested file is maintaining the
 * changelog just as faithfully as one editing the root — yet an exact match reads
 * it as uncovered. A project widens what counts by declaring coverage globs
 * (`coveragePaths`), matched with the small grammar in {@link _globToRegExp}.
 * Globs only ever WIDEN coverage: with none declared, behavior is exact-match as
 * before, and an undeclared nested changelog still does not count. This is a
 * project-owned choice, like the `blocker` toggle — it cannot make the gate pass
 * on a commit that touched no changelog at all.
 *
 * **An uncommitted edit to a declared path satisfies the predicate outright** — the
 * changelog is being maintained, whether by the operator answering a block or by an
 * earlier turn that has not committed yet. This is also what makes a coverage
 * block's remediation honest: writing the missing entry clears it, with no need to
 * commit first.
 *
 * **Uncommitted work IS judged, by kind (#659).** Work left uncommitted at wrap is
 * swept into the wrap's own commit by `git add -A`, and the next session's range
 * starts after that commit — so if it isn't caught here, it ships unlogged forever.
 * Demanding an entry for *any* dirty file was tried and reverted (#645): a session
 * dirties tracked bookkeeping files (`.prawduct/change-log.md` on this repo) as a
 * matter of course, so that rule blocked exactly the compliant sessions this
 * predicate exists to unblock. The fix is to tell work from bookkeeping: a dirty
 * path counts as unlogged work only when the shared source-file classifier
 * (`./_source-paths` `isSourceFile`) says so, which excludes `.prawduct/`,
 * `.tangleclaw/`, build output, and the changelog/readme themselves. When such work
 * is dirty and the changelog is not, the verdict is `uncovered` with the offending
 * paths in `uncommittedWork` — and this check runs BEFORE the committed-history one,
 * because an entry logged for the session's committed work does not cover new
 * uncommitted work. A dirty changelog still short-circuits to `covered` above, so a
 * mid-edit session is never caught.
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
const { isSourceFile } = require('./_source-paths');

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
 *   (the step's `verifyChanged` list), matched exactly. A commit counts as covered
 *   when it touched any one of them. Taken from the step spec rather than hardcoded
 *   so the path the gate snapshots and the path the predicate looks for cannot
 *   drift apart.
 * @param {string[]} [coveragePaths] - Optional project-declared globs that ALSO
 *   satisfy coverage (e.g. a per-package nested changelog). Purely additive:
 *   omitting them, or passing a non-array, leaves exact-match behavior unchanged.
 *   Grammar in {@link _globToRegExp}.
 * @returns {{verdict:string, uncovered:Array<{sha:string, subject:string}>, uncommittedWork:string[], checkedCount:number, range:(string|null), reason:(string|null)}}
 *   `verdict` is one of `covered` | `uncovered` | `unavailable`. On an `uncovered`
 *   verdict EITHER `uncovered` lists every judged commit (none maintained the
 *   changelog) OR `uncommittedWork` lists the dirty source files that will ship in
 *   the wrap's own commit with no entry (#659) — never both; the other is empty.
 *   Both are empty when covered. `checkedCount` is how many commits the verdict was
 *   computed over. `reason` explains an `unavailable` verdict and is null otherwise.
 */
function evaluate(projectPath, paths, coveragePaths) {
  const wanted = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
  if (wanted.length === 0) {
    return _unavailable('no paths declared to check', null);
  }

  // Coverage globs are compiled once here, not per file. Invalid entries (non-string
  // or blank) are filtered out rather than throwing — a stale config key must not
  // take the wrap down mid-run. The surviving sources are kept for diagnostics: an
  // incomplete verdict should be able to say which globs were in effect, so a
  // typo'd-but-valid glob is distinguishable from a genuine coverage miss.
  const globSources = (Array.isArray(coveragePaths) ? coveragePaths : [])
    .filter((p) => typeof p === 'string' && p.trim());
  const globs = globSources.map(_globToRegExp);

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

  // A touched path counts if it exactly matches a declared path or matches a
  // declared coverage glob. Used for both the committed-history check and the
  // uncommitted-edit check below, so a nested changelog satisfies either way.
  const isCovered = (f) => wantedSet.has(f) || globs.some((re) => re.test(f));

  // Committed history alone would miss an entry written earlier in the session but
  // not yet committed, so the working-tree state is read too. `declaredDirty` below
  // (the changelog itself) satisfies coverage; the rest of the dirty tree is judged
  // by kind for the uncommitted-work check (#659) — a source file counts as unlogged
  // work, tracked bookkeeping does not. The classifier is the shared `isSourceFile`,
  // which is what keeps the reverted #645 "any dirty file" false-block from
  // returning (see the module header).
  let dirty;
  try {
    dirty = _dirtyPaths(projectPath);
  } catch (err) {
    return _unavailable(`could not read the working tree: ${err.message}`, range);
  }
  const declaredDirty = dirty.filter(isCovered);

  // An uncommitted edit to a declared path IS the changelog being maintained for
  // this session — by the operator, or by an earlier turn. It also makes the
  // remediation honest: writing the missing entry is what clears a coverage block.
  if (declaredDirty.length > 0) {
    log.info('changelog coverage satisfied by an uncommitted edit', {
      range, declaredDirty
    });
    return {
      verdict: VERDICTS.COVERED, uncovered: [], uncommittedWork: [], checkedCount: 0, range, reason: null
    };
  }

  // #659: uncommitted WORK is swept into the wrap's own commit by `git add -A`. The
  // changelog is not being maintained for it here — declaredDirty was empty, so the
  // changelog file is not dirty — which means that work ships unlogged. Classify the
  // dirty set with the shared source-file signal so a wrap's routine bookkeeping
  // churn (`.prawduct/`, `.tangleclaw/`, build output) is NOT mistaken for work:
  // that misclassification is exactly what forced the revert of the first "any dirty
  // file" rule (#645). This precedes the committed-history check on purpose — an
  // entry logged for the session's COMMITTED work does not cover NEW uncommitted
  // work, so dirty work must block even when an earlier commit touched the changelog
  // (the #659 repro). An uncommitted changelog edit still wins via declaredDirty
  // above, so a mid-edit session is never caught here.
  const dirtyWork = dirty.filter(isSourceFile);
  if (dirtyWork.length > 0) {
    log.warn('changelog coverage incomplete — uncommitted work with no changelog entry', {
      range, dirtyWork
    });
    return {
      verdict: VERDICTS.UNCOVERED,
      uncovered: [],
      uncommittedWork: dirtyWork,
      checkedCount: 0,
      range,
      reason: null
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

  const checkedCount = checkable.length;

  // Session-level coverage: the obligation is "the changelog was maintained for
  // this session's work", and it is met if ANY judged commit in the range touched
  // a declared path or coverage glob — the entry need not ride the same commit as
  // each change. A session commonly logs all its work in one entry, backfills
  // several commits in a single commit, or lands a doc-only/bookkeeping commit
  // beside its logged work; the former per-commit rule false-blocked all three
  // even though the changelog was fully maintained. Per-commit bought little here:
  // the wrap's changelog-update step is what drives a COMPLETE entry; this
  // predicate only confirms the changelog was maintained at all.
  if (checkable.some((c) => c.files.some(isCovered))) {
    log.info('changelog coverage satisfied', { range, checkedCount });
    return { verdict: VERDICTS.COVERED, uncovered: [], uncommittedWork: [], checkedCount, range, reason: null };
  }

  // No judged commit touched the changelog and no uncommitted edit maintains it —
  // it was not maintained this session. Name every judged commit so the
  // remediation points at the work that shipped with no entry anywhere.
  const uncovered = checkable.map(({ sha, subject }) => ({ sha, subject }));
  log.warn('changelog coverage incomplete — no commit maintained the changelog', {
    range,
    checkedCount,
    coveragePaths: globSources
  });
  return { verdict: VERDICTS.UNCOVERED, uncovered, uncommittedWork: [], checkedCount, range, reason: null };
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
  return { verdict: VERDICTS.UNAVAILABLE, uncovered: [], uncommittedWork: [], checkedCount: 0, range, reason };
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
 * List the paths the wrap's own `git add -A` will commit — modified tracked files
 * AND untracked (non-ignored) files — as paths relative to `cwd`, deduped.
 *
 * Both halves are needed because that is precisely the set the wrap sweeps into its
 * own commit, which is the set the uncommitted-work check (#659) must judge. A NEW
 * source file is the most common form of new work, and `git diff HEAD` never lists
 * an untracked file (it has no `HEAD` version to differ from) — so the modified-only
 * view missed exactly the case #659 exists to catch.
 *
 * - `git diff --name-only --relative HEAD` — modified tracked files. `--relative`
 *   because git reports repository-root-relative paths by default, and a project
 *   rooted in a subdirectory would then match none of its own declared paths.
 * - `git ls-files --others --exclude-standard` — untracked files that are NOT
 *   gitignored, i.e. exactly what `git add -A` would newly stage (a gitignored
 *   scratch file is added by neither). Its output is already cwd-relative, so no
 *   `--relative` flag is needed (nor accepted). The caller then filters this set
 *   through `isSourceFile`, so genuine scratch that slips past `.gitignore` still
 *   only counts when it is a source file.
 *
 * @param {string} cwd - Absolute project root.
 * @returns {string[]}
 */
function _dirtyPaths(cwd) {
  const opts = {
    cwd,
    encoding: 'utf8',
    timeout: GIT_EXEC_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'ignore']
  };
  const modified = _internal.execSync('git diff --name-only --relative HEAD', opts);
  const untracked = _internal.execSync('git ls-files --others --exclude-standard', opts);
  const out = new Set();
  for (const stdout of [modified, untracked]) {
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) out.add(trimmed);
    }
  }
  return [...out];
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

/**
 * Compile one coverage glob into an anchored `RegExp` over a project-relative path.
 *
 * The grammar is the small subset a per-package changelog declaration needs, not
 * full globbing:
 * - a single star matches within one path segment (never a slash);
 * - a double star matches across segments (any depth);
 * - a double star immediately followed by a slash matches zero or more leading
 *   segments, so a double-star-slash prefix on a filename covers the root file as
 *   well as nested ones.
 *
 * Every other character is matched literally — regex metacharacters (notably the
 * dot in `CHANGELOG.md`) are escaped so they cannot match more than themselves.
 * A project rooting below its repo root is judged on `--relative` paths, the same
 * form these globs are written against.
 *
 * @param {string} glob - A coverage glob.
 * @returns {RegExp} An anchored matcher.
 */
function _globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
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
  _dirtyPaths,
  _globToRegExp
};
