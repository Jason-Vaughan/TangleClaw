'use strict';

/**
 * Every GitHub read and write the merge queue makes, through `gh` on this
 * host. Nothing else in the queue talks to GitHub, so what the queue may change
 * there is what this file can do: create a branch under `tc-queue-stage/`, merge
 * a commit into it, create a branch under `tc-queue/` at that merge commit,
 * delete a branch under either prefix, and merge a pull request at one exact
 * head with a merge commit. `docs/merge-queue.md` lists each call.
 *
 * The two prefixes are two jobs. CI runs on a push to `tc-queue/`, so a
 * candidate branch is only ever created at a finished merge commit: one push,
 * one run, on the commit that is tested. The merge is made on a branch under
 * `tc-queue-stage/`, which CI does not watch, because creating a branch at the
 * base and merging into it are two pushes, the first of them on a commit that
 * is the base branch's own.
 *
 * A check has two readers. `lib/github-checks.js#readCheck` answers the newest
 * run of a name on a commit, whichever branch's push made it, and owns what a
 * well-formed repository and commit id are. `readBranchCheck` here answers the
 * newest run that belongs to one branch, which is what the queue judges a
 * branch by: one commit can carry runs of several branches.
 *
 * Every answer carries a `status`. A call that could not be read answers
 * `unavailable` with the reason, never a guess. A write that answers
 * `unavailable` also says whether GitHub is known to have refused it
 * (`applied: false`) or its outcome is not known (`applied: null`): a timed-out
 * merge may have happened, and the caller must read before deciding. Making a
 * candidate is several writes to two branches, so it answers what is known of
 * each instead: `refCreated` for the candidate branch and `stageLeft` for the
 * stage branch.
 *
 * Every call is bounded and nothing is cached. No function throws.
 *
 * @module lib/merge-queue-github
 */

const { execFileArgs, describeFailure } = require('./exec');
const { invalidRequest, interpret } = require('./github-checks');

/** A read's time budget. */
const READ_TIMEOUT_MS = 10000;

/** A write's time budget: GitHub builds a merge commit before it answers. */
const WRITE_TIMEOUT_MS = 20000;

/** The most output one call may return. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Where a candidate branch lives: the branches CI tests. Created at a merge commit, never merged into. */
const CANDIDATE_PREFIX = 'tc-queue/';

/** Where a candidate's merge is made: branches CI does not watch. With the prefix above, the only branches this module creates or deletes. */
const STAGE_PREFIX = 'tc-queue-stage/';

/** The only way a pull request is merged here: a true merge commit. */
const MERGE_METHOD = 'merge';

/** How many files one page of a pull request's file list holds. */
const FILES_PAGE_SIZE = 100;

/** GitHub lists at most this many files for a pull request; a list this long is not known to be whole. */
const PULL_FILES_CAP = 3000;

/** GitHub lists at most this many files in a comparison, and gives no count to check a shorter list against. */
const COMPARE_FILES_CAP = 300;

/** The most check suites or check runs one read asks for; a list this long is not known to be whole. */
const CHECKS_PAGE_SIZE = 100;

const SHA_SHAPE = /^[0-9a-f]{40}$/;
const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CANDIDATE_SHAPE = /^tc-queue\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const STAGE_SHAPE = /^tc-queue-stage\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** Stand-ins for the parts of the shared request check a call does not have. */
const ANY_SHA = '0'.repeat(40);
const ANY_CHECK_NAME = 'test';

const PULL_PROJECTION = '{number: .number, state: .state, merged: .merged, draft: .draft, mergeable: .mergeable, '
  + 'base_ref: .base.ref, head_sha: .head.sha, changed_files: .changed_files, merge_commit_sha: .merge_commit_sha}';
const REF_PROJECTION = '{ref: .ref, sha: .object.sha, type: .object.type}';
const COMMIT_PROJECTION = '{sha: .sha, tree: .tree.sha, parents: [.parents[].sha]}';
const MERGE_PROJECTION = '{sha: .sha, tree: .commit.tree.sha, parents: [.parents[].sha]}';
const FILES_PROJECTION = '[.[] | {filename: .filename, previous_filename: .previous_filename}]';
const COMPARE_PROJECTION = '{status: .status, base: .base_commit.sha, merge_base: .merge_base_commit.sha, '
  + 'files: [.files[] | {filename: .filename, previous_filename: .previous_filename}]}';
const PULL_MERGE_PROJECTION = '{sha: .sha, merged: .merged}';
const SUITES_PROJECTION = '{total_count: .total_count, check_suites: [.check_suites[] | '
  + '{id: .id, head_branch: .head_branch, head_sha: .head_sha}]}';
// What `readCheck` keeps of a run, so its `interpret` reads these rows, and the suite each run is in.
const BRANCH_RUNS_PROJECTION = '{total_count: .total_count, check_runs: [.check_runs[] | '
  + '{id: .id, name: .name, head_sha: .head_sha, status: .status, conclusion: .conclusion, '
  + 'started_at: .started_at, completed_at: .completed_at, app: .app.slug, details_url: .details_url, '
  + 'check_suite: .check_suite.id}]}';

/** Seams for tests. */
const _internal = {
  exec: (args, timeoutMs) => execFileArgs('gh', args, { timeoutMs, maxBufferBytes: MAX_OUTPUT_BYTES })
};

/**
 * An unavailable reading.
 * @param {string} reason - Why nothing can be said
 * @param {object} [extra] - What else is known, such as whether a write was applied
 * @returns {{status: 'unavailable', reason: string}}
 */
function _unavailable(reason, extra = {}) {
  return { status: 'unavailable', reason, ...extra };
}

/**
 * Why a repository cannot be read, if it cannot.
 * @param {*} repo - `owner/name`
 * @returns {string|null} The reason, or null when it is well formed
 */
function _invalidRepo(repo) {
  return invalidRequest(repo, ANY_SHA, ANY_CHECK_NAME);
}

/**
 * Why a repository or a commit id cannot be read, if either cannot. A commit
 * id that was not given is not well formed.
 * @param {*} repo - `owner/name`
 * @param {*} sha - A full, lower-case commit id
 * @returns {string|null} The reason, or null when both are well formed
 */
function _invalidCommit(repo, sha) {
  return invalidRequest(repo, sha, ANY_CHECK_NAME);
}

/**
 * Why a pull request number cannot be read, if it cannot.
 * @param {*} number - A pull request number
 * @returns {string|null}
 */
function _invalidNumber(number) {
  return Number.isSafeInteger(number) && number > 0 ? null : 'the pull request number must be a positive whole number';
}

/**
 * Whether a branch name is one git accepts and this module will put in a URL.
 * @param {*} branch - A branch name, without `refs/heads/`
 * @returns {boolean}
 */
function _wellFormedBranch(branch) {
  return typeof branch === 'string' && BRANCH_SHAPE.test(branch)
    && !branch.includes('..')
    && !branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));
}

/**
 * Whether a branch is a candidate's: one name directly under `tc-queue/`.
 * @param {*} ref - A branch name, without `refs/heads/`
 * @returns {boolean}
 */
function isCandidateRef(ref) {
  return _wellFormedBranch(ref) && CANDIDATE_SHAPE.test(ref);
}

/**
 * Whether a branch is one a candidate's merge is made on: one name directly
 * under `tc-queue-stage/`.
 * @param {*} ref - A branch name, without `refs/heads/`
 * @returns {boolean}
 */
function isStageRef(ref) {
  return _wellFormedBranch(ref) && STAGE_SHAPE.test(ref);
}

/**
 * The stage branch of a candidate branch: the same name under the other
 * prefix. The one place that name is built, so the two branches of a candidate
 * cannot be paired wrongly.
 * @param {*} ref - A candidate branch, `tc-queue/<name>`
 * @returns {string|null} Null when `ref` is not a candidate branch
 */
function stageRefFor(ref) {
  return isCandidateRef(ref) ? `${STAGE_PREFIX}${ref.slice(CANDIDATE_PREFIX.length)}` : null;
}

/**
 * Split what `gh api -i` printed into the HTTP status and the body.
 * @param {*} stdout - The command's output
 * @returns {{http: number, body: string}|null} Null when there is no status line
 */
function _split(stdout) {
  const match = typeof stdout === 'string' ? /^HTTP\/[0-9.]+ ([0-9]{3})[^\r\n]*\r?\n/.exec(stdout) : null;
  if (!match) return null;
  const blank = /\r?\n\r?\n/.exec(stdout);
  return { http: Number(match[1]), body: blank ? stdout.slice(blank.index + blank[0].length).trim() : '' };
}

/**
 * Make one bounded `gh api` call and say what HTTP status and body came back.
 * @param {string[]} args - The arguments after `gh api -i`
 * @param {number} timeoutMs - The call's budget
 * @returns {Promise<{http: number, body: string}|{failure: string}>} `failure` when no HTTP answer was read
 */
async function _call(args, timeoutMs) {
  let r;
  try {
    r = await _internal.exec(['api', '-i', ...args], timeoutMs);
  } catch (err) {
    return { failure: `gh api could not run (${err && err.message ? err.message : 'unknown error'})` };
  }
  const answer = r ? _split(r.stdout) : null;
  if (!answer) return { failure: describeFailure(r || { exitCode: 1 }, 'gh api') };
  return answer;
}

/**
 * A body as JSON, or undefined when it is not JSON.
 * @param {string} body - An answer's body
 * @returns {*}
 */
function _json(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * One line naming an HTTP answer this module did not expect, with GitHub's own
 * message when it gave one.
 * @param {{http: number, body: string}} answer - The answer
 * @returns {string}
 */
function _unexpected(answer) {
  const parsed = _json(answer.body);
  const message = parsed && typeof parsed.message === 'string'
    ? parsed.message.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, 200)
    : '';
  return message ? `GitHub answered HTTP ${answer.http}: ${message}` : `GitHub answered HTTP ${answer.http}`;
}

/**
 * Whether GitHub's error message says this.
 * @param {{body: string}} answer - An answer
 * @param {string} words - The words to find, in lower case
 * @returns {boolean}
 */
function _says(answer, words) {
  const parsed = _json(answer.body);
  return !!parsed && typeof parsed.message === 'string' && parsed.message.toLowerCase().includes(words);
}

/**
 * Make one read and return its parsed body, or why it could not be read.
 * @param {string} path - The API path
 * @param {string} projection - The jq filter that keeps only what is read
 * @returns {Promise<{http: number, body: string, value?: *}|{failure: string}>} `value` only on HTTP 200 with a JSON body
 */
async function _get(path, projection) {
  const answer = await _call([path, '--jq', projection], READ_TIMEOUT_MS);
  if (answer.failure || answer.http !== 200) return answer;
  const value = _json(answer.body);
  if (value === undefined || value === null) return { failure: 'gh answered with something that is not JSON' };
  return { ...answer, value };
}

/**
 * Make one write.
 * @param {string} method - The HTTP method
 * @param {string} path - The API path
 * @param {Object<string, string>} fields - The body's fields
 * @param {string} [projection] - The jq filter for a successful answer
 * @returns {Promise<{http: number, body: string}|{failure: string}>}
 */
function _send(method, path, fields, projection) {
  const args = ['-X', method, path];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  if (projection) args.push('--jq', projection);
  return _call(args, WRITE_TIMEOUT_MS);
}

/**
 * What is known about a write that did not succeed: GitHub answering 4xx
 * refused it and changed nothing; anything else leaves the outcome unknown.
 * @param {{http?: number, failure?: string}} answer - The write's answer
 * @returns {false|null}
 */
function _applied(answer) {
  return !answer.failure && answer.http >= 400 && answer.http < 500 ? false : null;
}

/**
 * Read a pull request: whether it is open, merged or a draft, the branch it
 * targets, its head commit, and how many files it changes. `mergeable` is null
 * while GitHub has not worked it out.
 *
 * `mergeCommitSha` is the commit a merged pull request was merged as, and null
 * for one that is not merged. GitHub gives an open pull request a commit under
 * the same name, a trial merge it makes to work out `mergeable`, which is on no
 * branch; that one is never answered here.
 * @param {string} repo - `owner/name`
 * @param {number} number - The pull request's number
 * @returns {Promise<{status: 'read', number: number, state: 'open'|'closed', merged: boolean, draft: boolean, mergeable: (boolean|null), baseRef: string, headSha: string, changedFiles: number, mergeCommitSha: (string|null)}|{status: 'unavailable', reason: string}>}
 */
async function readPull(repo, number) {
  const invalid = _invalidRepo(repo) || _invalidNumber(number);
  if (invalid) return _unavailable(invalid);
  const answer = await _get(`repos/${repo}/pulls/${number}`, PULL_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http !== 200) return _unavailable(_unexpected(answer));
  const p = answer.value;
  const understood = p.number === number && (p.state === 'open' || p.state === 'closed')
    && typeof p.merged === 'boolean' && typeof p.draft === 'boolean'
    && (p.mergeable === null || typeof p.mergeable === 'boolean')
    && _wellFormedBranch(p.base_ref) && SHA_SHAPE.test(p.head_sha)
    && Number.isSafeInteger(p.changed_files) && p.changed_files >= 0
    && (p.merge_commit_sha === null || SHA_SHAPE.test(p.merge_commit_sha))
    && !(p.merged && p.state !== 'closed');
  if (!understood) return _unavailable('GitHub answered with a pull request this server cannot read');
  return {
    status: 'read', number, state: p.state, merged: p.merged, draft: p.draft, mergeable: p.mergeable,
    baseRef: p.base_ref, headSha: p.head_sha, changedFiles: p.changed_files,
    mergeCommitSha: p.merged ? p.merge_commit_sha : null
  };
}

/**
 * Read the commit a branch points at. A branch that does not exist is
 * `not-found`, which is how a deleted candidate is confirmed gone.
 * @param {string} repo - `owner/name`
 * @param {string} branch - The branch name, without `refs/heads/`
 * @returns {Promise<{status: 'read', sha: string}|{status: 'not-found'}|{status: 'unavailable', reason: string}>}
 */
async function readRefTip(repo, branch) {
  const invalid = _invalidRepo(repo) || (_wellFormedBranch(branch) ? null : 'the branch name is not well formed');
  if (invalid) return _unavailable(invalid);
  const answer = await _get(`repos/${repo}/git/ref/heads/${branch}`, REF_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http === 404) return { status: 'not-found' };
  if (answer.http !== 200) return _unavailable(_unexpected(answer));
  const r = answer.value;
  if (r.ref !== `refs/heads/${branch}` || r.type !== 'commit' || !SHA_SHAPE.test(r.sha)) {
    return _unavailable('GitHub answered with a reference that is not this branch at a commit');
  }
  return { status: 'read', sha: r.sha };
}

/**
 * Read a commit's tree and parents.
 * @param {string} repo - `owner/name`
 * @param {string} sha - A full, lower-case commit id
 * @returns {Promise<{status: 'read', sha: string, tree: string, parents: string[]}|{status: 'unavailable', reason: string}>}
 */
async function readCommit(repo, sha) {
  const invalid = _invalidCommit(repo, sha);
  if (invalid) return _unavailable(invalid);
  const answer = await _get(`repos/${repo}/git/commits/${sha}`, COMMIT_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http !== 200) return _unavailable(_unexpected(answer));
  const c = answer.value;
  if (c.sha !== sha || !_isCommitShape(c)) return _unavailable('GitHub answered with a commit this server cannot read');
  return { status: 'read', sha, tree: c.tree, parents: c.parents };
}

/**
 * Whether a projected commit has a commit id, a tree and a list of parents.
 * @param {*} c - A projected commit
 * @returns {boolean}
 */
function _isCommitShape(c) {
  return !!c && SHA_SHAPE.test(c.sha) && SHA_SHAPE.test(c.tree)
    && Array.isArray(c.parents) && c.parents.every((p) => SHA_SHAPE.test(p));
}

/**
 * The paths a list of changed files names: each file's path, and for a renamed
 * file the path it had before, since a rename changes both. Null when a row
 * cannot be read.
 * @param {*} rows - Projected file rows
 * @returns {string[]|null}
 */
function _paths(rows) {
  if (!Array.isArray(rows)) return null;
  const paths = new Set();
  for (const row of rows) {
    if (!row || typeof row.filename !== 'string' || !row.filename) return null;
    if (row.previous_filename !== null && row.previous_filename !== undefined && typeof row.previous_filename !== 'string') return null;
    paths.add(row.filename);
    if (row.previous_filename) paths.add(row.previous_filename);
  }
  return [...paths];
}

/**
 * Read every page of a pull request's file list.
 * @param {string} repo - `owner/name`
 * @param {number} number - The pull request's number
 * @param {number} expected - How many files the pull request says it changes
 * @returns {Promise<{rows: object[]}|{failure: string}>}
 */
async function _pullFileRows(repo, number, expected) {
  const rows = [];
  for (let page = 1; rows.length < expected; page++) {
    const answer = await _get(`repos/${repo}/pulls/${number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`, FILES_PROJECTION);
    if (answer.failure) return answer;
    if (answer.http !== 200) return { failure: _unexpected(answer) };
    if (!Array.isArray(answer.value)) return { failure: 'GitHub answered with something that is not a list of files' };
    rows.push(...answer.value);
    if (answer.value.length < FILES_PAGE_SIZE) break;
  }
  return { rows };
}

/**
 * Read the paths a pull request changes, with the head commit the pull request
 * had when its file count was read. The list is `unavailable` unless it is
 * known to be whole: as many rows as the pull request counts, and fewer than
 * GitHub's cap. The head can still move between the count and the list; a
 * caller that needs the files of one exact commit compares commits instead
 * ({@link readCompareFiles}).
 * @param {string} repo - `owner/name`
 * @param {number} number - The pull request's number
 * @returns {Promise<{status: 'read', headSha: string, paths: string[]}|{status: 'unavailable', reason: string}>}
 */
async function readPullFiles(repo, number) {
  const pull = await readPull(repo, number);
  if (pull.status !== 'read') return pull;
  if (pull.changedFiles >= PULL_FILES_CAP) {
    return _unavailable(`the pull request changes ${pull.changedFiles} files, and GitHub lists at most ${PULL_FILES_CAP}`);
  }
  const listed = await _pullFileRows(repo, number, pull.changedFiles);
  if (listed.failure) return _unavailable(listed.failure);
  if (listed.rows.length !== pull.changedFiles) {
    return _unavailable(`the pull request counts ${pull.changedFiles} changed files and GitHub listed ${listed.rows.length}`);
  }
  const paths = _paths(listed.rows);
  if (!paths) return _unavailable('GitHub answered with a file this server cannot read');
  return { status: 'read', headSha: pull.headSha, paths };
}

/**
 * Read the paths that differ between two commits, where the second is the
 * first or a descendant of it: what merging the second would change on a
 * branch at the first. Anything else is `unavailable`: commits that have
 * diverged, and a list at GitHub's cap, which may have been cut short.
 * @param {string} repo - `owner/name`
 * @param {string} baseSha - The commit compared from
 * @param {string} headSha - The commit compared to
 * @returns {Promise<{status: 'read', paths: string[]}|{status: 'unavailable', reason: string}>}
 */
async function readCompareFiles(repo, baseSha, headSha) {
  const invalid = _invalidCommit(repo, baseSha) || _invalidCommit(repo, headSha);
  if (invalid) return _unavailable(invalid);
  const answer = await _get(`repos/${repo}/compare/${baseSha}...${headSha}`, COMPARE_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http !== 200) return _unavailable(_unexpected(answer));
  const c = answer.value;
  if (c.base !== baseSha || c.merge_base !== baseSha || (c.status !== 'ahead' && c.status !== 'identical')) {
    return _unavailable('the second commit does not descend from the first, so the comparison is not what a merge would change');
  }
  const paths = _paths(c.files);
  if (!paths) return _unavailable('GitHub answered with a file this server cannot read');
  if (c.files.length >= COMPARE_FILES_CAP) {
    return _unavailable(`the comparison lists ${c.files.length} files, and GitHub lists at most ${COMPARE_FILES_CAP}`);
  }
  return { status: 'read', paths };
}

/**
 * Read whether a commit is reachable from a branch tip: whether the tip is the
 * commit or a descendant of it. It makes the same comparison call as
 * {@link readCompareFiles}, from the commit to the tip, and reads only its
 * status, base and merge base.
 *
 * - `reachable`: GitHub compared from exactly `sha`, the merge base is `sha`,
 *   and the tip is `ahead` of it or `identical` to it.
 * - `not-reachable`: the two have `diverged`, or the tip is `behind` the
 *   commit. `compareStatus` says which.
 * - `unavailable`: anything else, including a commit GitHub no longer has.
 * @param {string} repo - `owner/name`
 * @param {string} sha - The commit asked about
 * @param {string} tipSha - The branch tip, read fresh by the caller
 * @returns {Promise<{status: 'reachable'|'not-reachable', compareStatus: string}|{status: 'unavailable', reason: string}>}
 */
async function readAncestry(repo, sha, tipSha) {
  const invalid = _invalidCommit(repo, sha) || _invalidCommit(repo, tipSha);
  if (invalid) return _unavailable(invalid);
  const answer = await _get(`repos/${repo}/compare/${sha}...${tipSha}`, COMPARE_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http !== 200) return _unavailable(_unexpected(answer));
  const c = answer.value;
  if (c.status === 'diverged' || c.status === 'behind') return { status: 'not-reachable', compareStatus: c.status };
  if ((c.status === 'ahead' || c.status === 'identical') && c.base === sha && c.merge_base === sha) {
    return { status: 'reachable', compareStatus: c.status };
  }
  return _unavailable('GitHub answered with a comparison this server cannot read');
}

/**
 * Create a branch at a commit. Its callers decide which branch; this does not.
 * @param {string} repo - `owner/name`
 * @param {string} branch - The branch name
 * @param {string} sha - The commit it starts at
 * @returns {Promise<{status: 'created'|'ref-exists'|'unavailable', made: (boolean|null), reason?: string}>} `made`: whether the branch exists because of this call, null when that is not known
 */
async function _createRef(repo, branch, sha) {
  const answer = await _send('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, REF_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure, { made: null });
  if (answer.http === 422 && _says(answer, 'already exists')) return { status: 'ref-exists', made: false };
  if (answer.http !== 201) return _unavailable(_unexpected(answer), { made: _applied(answer) });
  const made = _json(answer.body);
  if (!made || made.ref !== `refs/heads/${branch}` || made.sha !== sha) {
    return _unavailable('GitHub created a reference that is not this branch at this commit', { made: true });
  }
  return { status: 'created', made: true };
}

/**
 * Merge a commit into a stage branch that is at `baseSha`, and read the merge
 * commit back. `created` only when the merge is of exactly these two commits,
 * base first, and a fresh read of it answers the same tree and parents.
 * @param {string} repo - `owner/name`
 * @param {string} stage - The stage branch
 * @param {string} baseSha - The commit the branch is at
 * @param {string} headSha - The commit merged in
 * @returns {Promise<{status: 'created', sha: string, tree: string, parents: string[]}|{status: 'conflict'|'nothing-to-merge'}|{status: 'unavailable', reason: string}>}
 */
async function _mergeInto(repo, stage, baseSha, headSha) {
  const message = `Merge ${headSha} into ${stage}`;
  const answer = await _send('POST', `repos/${repo}/merges`, { base: stage, head: headSha, commit_message: message }, MERGE_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure);
  if (answer.http === 409) return { status: 'conflict' };
  if (answer.http === 204) return { status: 'nothing-to-merge' };
  if (answer.http !== 201) return _unavailable(_unexpected(answer));
  const c = _json(answer.body);
  if (!_isCommitShape(c) || c.parents.length !== 2 || c.parents[0] !== baseSha || c.parents[1] !== headSha) {
    return _unavailable('GitHub made a merge that is not of these two commits');
  }
  const read = await readCommit(repo, c.sha);
  if (read.status !== 'read') return _unavailable(`the merge commit could not be read back (${read.reason})`);
  if (read.tree !== c.tree || read.parents.length !== 2 || read.parents[0] !== baseSha || read.parents[1] !== headSha) {
    return _unavailable('the merge commit read back is not the one GitHub answered the merge with');
  }
  return { status: 'created', sha: c.sha, tree: c.tree, parents: c.parents };
}

/** What a {@link createCandidate} answer says happened, for the reason given when its stage branch then cannot be deleted. */
const OUTCOME_WORDS = {
  created: 'the candidate branch was made',
  conflict: 'the two commits do not merge',
  'nothing-to-merge': 'the base already holds the head',
  'ref-exists': 'the candidate branch was already there'
};

/**
 * Finish making a candidate: delete its stage branch, and give `answer` only
 * if that branch is known gone. A deletion that was refused or whose outcome
 * is not known turns any answer into `unavailable`, so no caller reads a
 * result over a branch left behind.
 * @param {string} repo - `owner/name`
 * @param {string} stage - The stage branch
 * @param {true|null} stageMade - Whether this call made the stage branch, null when that is not known
 * @param {object} answer - The answer so far, with `refCreated`
 * @returns {Promise<object>} `answer` with `stageLeft: false`, or `unavailable` with `stageLeft` true or null
 */
async function _closeStage(repo, stage, stageMade, answer) {
  const gone = await deleteRef(repo, stage);
  if (gone.status === 'deleted' || gone.status === 'not-found') return { ...answer, stageLeft: false };
  const before = answer.status === 'unavailable' ? answer.reason : OUTCOME_WORDS[answer.status];
  return _unavailable(`${before}; and the stage branch ${stage} could not be deleted (${gone.reason})`, {
    refCreated: answer.refCreated,
    stageLeft: gone.applied === false ? stageMade : null
  });
}

/**
 * Make a candidate: the merge of `headSha` into `baseSha`, on the branch `ref`.
 * The merge is made on the stage branch of `ref` ({@link stageRefFor}), which
 * CI does not watch; `ref` is then created at the finished merge commit, which
 * is the only write under `tc-queue/` and so the only push CI sees; the stage
 * branch is deleted. Nothing is written to the base branch or to a pull
 * request's branch.
 *
 * - `created`: the merge commit, its tree and its two parents, base first. The
 *   commit was read back with the same tree and parents, `ref` is at it, and
 *   the stage branch is gone.
 * - `conflict`: the two commits do not merge cleanly. No candidate branch was made.
 * - `nothing-to-merge`: the base already contains the head. No candidate branch was made.
 * - `ref-exists`: a branch is already there under one of the two names, and was
 *   not touched; `existing` says which, `stage` or `candidate`.
 * - `unavailable`: a step was refused or could not be read, or the stage
 *   branch could not be deleted afterwards, whatever else happened.
 *
 * Every answer says what is known of each branch: `refCreated`, whether the
 * candidate branch exists because of this call, and `stageLeft`, whether the
 * stage branch still exists as far as this call knows (each true, false, or
 * null when not known). Those, and not the status, tell the caller whether
 * there is anything for {@link discardCandidate} to remove.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The candidate branch to create, `tc-queue/<name>`
 * @param {string} baseSha - The commit merged into
 * @param {string} headSha - The commit merged in
 * @returns {Promise<{status: 'created', ref: string, sha: string, tree: string, parents: string[], refCreated: true, stageLeft: false}|{status: 'conflict'|'nothing-to-merge', ref: string, refCreated: false, stageLeft: false}|{status: 'ref-exists', ref: string, existing: 'stage'|'candidate', refCreated: false, stageLeft: boolean}|{status: 'unavailable', reason: string, refCreated: (boolean|null), stageLeft: (boolean|null)}>}
 */
async function createCandidate(repo, ref, baseSha, headSha) {
  const invalid = _invalidCommit(repo, baseSha) || _invalidCommit(repo, headSha)
    || (isCandidateRef(ref) ? null : `a candidate branch must be one name under ${CANDIDATE_PREFIX}`);
  if (invalid) return _unavailable(invalid, { refCreated: false, stageLeft: false });
  const stage = stageRefFor(ref);

  const staged = await _createRef(repo, stage, baseSha);
  if (staged.status === 'ref-exists') return { status: 'ref-exists', ref, existing: 'stage', refCreated: false, stageLeft: true };
  if (staged.status !== 'created') {
    const failed = _unavailable(staged.reason, { refCreated: false });
    return staged.made === false ? { ...failed, stageLeft: false } : _closeStage(repo, stage, staged.made, failed);
  }

  const merged = await _mergeInto(repo, stage, baseSha, headSha);
  if (merged.status === 'unavailable') return _closeStage(repo, stage, true, { ...merged, refCreated: false });
  if (merged.status !== 'created') return _closeStage(repo, stage, true, { ...merged, ref, refCreated: false });

  const placed = await _createRef(repo, ref, merged.sha);
  if (placed.status === 'ref-exists') {
    return _closeStage(repo, stage, true, { status: 'ref-exists', ref, existing: 'candidate', refCreated: false });
  }
  if (placed.status !== 'created') return _closeStage(repo, stage, true, _unavailable(placed.reason, { refCreated: placed.made }));
  return _closeStage(repo, stage, true, { ...merged, ref, refCreated: true });
}

/**
 * Delete one branch of a candidate: a candidate branch or a stage branch. Any
 * branch not directly under one of those two prefixes is refused before `gh`
 * runs. `not-found` means it was already gone.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The branch to delete, `tc-queue/<name>` or `tc-queue-stage/<name>`
 * @returns {Promise<{status: 'deleted'}|{status: 'not-found'}|{status: 'unavailable', reason: string, applied: (false|null)}>}
 */
async function deleteRef(repo, ref) {
  const invalid = _invalidRepo(repo)
    || (isCandidateRef(ref) || isStageRef(ref) ? null : `only a branch under ${CANDIDATE_PREFIX} or ${STAGE_PREFIX} may be deleted`);
  if (invalid) return _unavailable(invalid, { applied: false });
  const answer = await _send('DELETE', `repos/${repo}/git/refs/heads/${ref}`, {});
  if (answer.failure) return _unavailable(answer.failure, { applied: null });
  if (answer.http === 204) return { status: 'deleted' };
  if (answer.http === 422 && _says(answer, 'does not exist')) return { status: 'not-found' };
  return _unavailable(_unexpected(answer), { applied: _applied(answer) });
}

/**
 * What a {@link deleteRef} answer says of the branch, in one word.
 * @param {{status: string, applied?: (false|null)}} answer - A deletion's answer
 * @returns {'deleted'|'not-found'|'refused'|'unknown'}
 */
function _deletion(answer) {
  if (answer.status !== 'unavailable') return answer.status;
  return answer.applied === false ? 'refused' : 'unknown';
}

/**
 * Remove both branches of a candidate: `ref` and its stage branch. Both
 * deletions are always attempted, and calling it again is harmless.
 *
 * - `discarded`: each branch was deleted or was already gone.
 * - `unavailable`: at least one deletion was refused or its outcome is not known.
 *
 * Every answer says what happened to each: `candidate` and `stage` are each
 * `deleted`, `not-found`, `refused` (nothing changed) or `unknown`.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The candidate branch, `tc-queue/<name>`
 * @returns {Promise<{status: 'discarded', candidate: string, stage: string}|{status: 'unavailable', reason: string, candidate: string, stage: string}>}
 */
async function discardCandidate(repo, ref) {
  const invalid = _invalidRepo(repo) || (isCandidateRef(ref) ? null : `a candidate branch must be one name under ${CANDIDATE_PREFIX}`);
  if (invalid) return _unavailable(invalid, { candidate: 'refused', stage: 'refused' });
  const stageRef = stageRefFor(ref);
  const answers = [[ref, await deleteRef(repo, ref)], [stageRef, await deleteRef(repo, stageRef)]];
  const [candidate, stage] = answers.map(([, answer]) => _deletion(answer));
  const failed = answers.filter(([, answer]) => answer.status === 'unavailable');
  if (failed.length === 0) return { status: 'discarded', candidate, stage };
  const reason = failed.map(([branch, answer]) => `${branch} could not be deleted (${answer.reason})`).join('; ');
  return _unavailable(reason, { candidate, stage });
}

/**
 * Merge a pull request with a merge commit, only if its head is still
 * `headSha`. Squash and rebase cannot be asked for.
 *
 * - `merged`: the merge commit GitHub made.
 * - `head-moved`: the pull request's head is no longer `headSha`. Nothing was merged.
 * - `not-mergeable`: GitHub will not merge it as it stands. Nothing was merged.
 * - `unavailable`: see the module's note on writes. With `applied: null` the
 *   pull request may have been merged.
 * @param {string} repo - `owner/name`
 * @param {number} number - The pull request's number
 * @param {string} headSha - The full head commit the merge is pinned to
 * @returns {Promise<{status: 'merged', sha: string}|{status: 'head-moved'|'not-mergeable', reason: string}|{status: 'unavailable', reason: string, applied: (false|null)}>}
 */
async function mergePull(repo, number, headSha) {
  const invalid = _invalidCommit(repo, headSha) || _invalidNumber(number);
  if (invalid) return _unavailable(invalid, { applied: false });
  const fields = { merge_method: MERGE_METHOD, sha: headSha };
  const answer = await _send('PUT', `repos/${repo}/pulls/${number}/merge`, fields, PULL_MERGE_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure, { applied: null });
  if (answer.http === 409) return { status: 'head-moved', reason: _unexpected(answer) };
  if (answer.http === 405) return { status: 'not-mergeable', reason: _unexpected(answer) };
  if (answer.http !== 200) return _unavailable(_unexpected(answer), { applied: _applied(answer) });
  const merged = _json(answer.body);
  if (!merged || merged.merged !== true || !SHA_SHAPE.test(merged.sha)) {
    return _unavailable('GitHub answered the merge with something this server cannot read', { applied: null });
  }
  return { status: 'merged', sha: merged.sha };
}

/**
 * Read one of a commit's two check lists whole, or say why it is not known to
 * be whole. A list at the page size, or one whose count disagrees with its
 * rows, may be missing rows, and a missing row here is a run given to the
 * wrong branch or to none.
 * @param {string} path - The API path
 * @param {string} projection - The jq filter that keeps only what is read
 * @param {string} key - The list's name in the answer
 * @param {string} what - What the list holds, for the reason
 * @param {string} sha - The commit every row must be of
 * @returns {Promise<{rows: object[]}|{reason: string}>}
 */
async function _checkList(path, projection, key, what, sha) {
  const answer = await _get(path, projection);
  if (answer.failure) return { reason: answer.failure };
  if (answer.http !== 200) return { reason: _unexpected(answer) };
  const rows = answer.value[key];
  if (!Array.isArray(rows) || !Number.isInteger(answer.value.total_count)) {
    return { reason: `GitHub answered with something that is not a list of ${what}` };
  }
  if (rows.length >= CHECKS_PAGE_SIZE || answer.value.total_count !== rows.length) {
    return { reason: `the commit's ${what} could not be read whole (${rows.length} of ${answer.value.total_count})` };
  }
  if (rows.some((row) => !row || typeof row !== 'object' || row.head_sha !== sha)) {
    return { reason: `GitHub answered with one of the ${what} this server cannot read, or of another commit` };
  }
  return { rows };
}

/**
 * Read one named check on one exact commit as one branch sees it: the newest
 * run of that name whose check suite belongs to that branch. One commit can
 * carry runs of several branches, and a run made for another branch never
 * stands in for this one's, whatever it concluded. A re-run of the branch's own
 * run is the same branch's and replaces the run it re-ran.
 *
 * Two reads: the commit's runs of that name, then its check suites, each of
 * which names the branch whose push made it. The suites are read second so
 * that a suite made between the two reads is in the list its run is looked up
 * in. A suite still names its branch after the branch is deleted, but that is
 * not relied on: a caller reads a branch's check before deleting the branch.
 *
 * The answer is `readCheck`'s, read by the same code, with the suite's id
 * added to a `running` or `concluded` one:
 *
 * - `not-found`: both lists were read whole and no run of that name belongs to
 *   the branch. A run whose suite names another branch, or no branch, counts
 *   for nothing.
 * - `unavailable`: either read failed, or which branch a run belongs to could
 *   not be read whole. It says nothing about the check, and is never a way of
 *   saying the branch has no run.
 * @param {string} repo - `owner/name`
 * @param {string} branch - The branch being judged, without `refs/heads/`
 * @param {string} sha - A full, lower-case commit id
 * @param {string} name - The check's name, exactly as GitHub shows it
 * @returns {Promise<{status: 'not-found'}|{status: 'running', runId: string, suiteId: string, app: string, workflowRunId?: string}|{status: 'concluded', conclusion: string, runId: string, suiteId: string, completedAt: string, app: string, workflowRunId?: string}|{status: 'unavailable', reason: string}>}
 */
async function readBranchCheck(repo, branch, sha, name) {
  const invalid = invalidRequest(repo, sha, name);
  if (invalid) return _unavailable(invalid);
  if (!_wellFormedBranch(branch)) return _unavailable('the branch must be a well-formed branch name');
  const commit = `repos/${repo}/commits/${sha}`;
  const runs = await _checkList(
    `${commit}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=${CHECKS_PAGE_SIZE}`,
    BRANCH_RUNS_PROJECTION, 'check_runs', 'check runs', sha
  );
  if (runs.reason) return _unavailable(runs.reason);
  const suites = await _checkList(`${commit}/check-suites?per_page=${CHECKS_PAGE_SIZE}`, SUITES_PROJECTION, 'check_suites', 'check suites', sha);
  if (suites.reason) return _unavailable(suites.reason);
  const branchOf = new Map();
  for (const suite of suites.rows) {
    if (!Number.isSafeInteger(suite.id) || suite.id < 1 || branchOf.has(suite.id)) {
      return _unavailable('GitHub answered with a check suite this server cannot read');
    }
    branchOf.set(suite.id, suite.head_branch);
  }
  const own = [];
  for (const run of runs.rows) {
    if (run.name !== name) continue;
    if (!branchOf.has(run.check_suite)) {
      return _unavailable('a check run of that name is in a check suite the commit does not list, so its branch is not known');
    }
    if (branchOf.get(run.check_suite) === branch) own.push(run);
  }
  const reading = interpret({ total_count: own.length, check_runs: own }, sha, name, repo);
  if (reading.status !== 'running' && reading.status !== 'concluded') return reading;
  const chosen = own.find((run) => String(run.id) === reading.runId);
  return { ...reading, suiteId: String(chosen.check_suite) };
}

module.exports = {
  readPull, readRefTip, readCommit, readPullFiles, readCompareFiles, readAncestry, readBranchCheck,
  createCandidate, discardCandidate, deleteRef, mergePull, isCandidateRef, isStageRef, stageRefFor,
  CANDIDATE_PREFIX, STAGE_PREFIX, MERGE_METHOD, PULL_FILES_CAP, COMPARE_FILES_CAP, FILES_PAGE_SIZE,
  READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, CHECKS_PAGE_SIZE, _internal
};
