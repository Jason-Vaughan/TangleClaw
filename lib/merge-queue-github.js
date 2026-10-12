'use strict';

/**
 * Every GitHub read and write the merge queue makes, through `gh` on this
 * host. Nothing else in the queue talks to GitHub, so what the queue may change
 * there is what this file can do: create a branch under `tc-queue/`, merge a
 * commit into that branch, delete that branch, and merge a pull request at one
 * exact head with a merge commit. `docs/merge-queue.md` lists each call.
 *
 * A commit's check runs are read by `lib/github-checks.js#readCheck`, which
 * also owns what a well-formed repository and commit id are.
 *
 * Every answer carries a `status`. A call that could not be read answers
 * `unavailable` with the reason, never a guess. A write that answers
 * `unavailable` also says whether GitHub is known to have refused it
 * (`applied: false`) or its outcome is not known (`applied: null`): a timed-out
 * merge may have happened, and the caller must read before deciding. Making a
 * candidate is two writes, so it answers `refCreated` instead: whether a branch
 * now exists to delete.
 *
 * Every call is bounded and nothing is cached. No function throws.
 *
 * @module lib/merge-queue-github
 */

const { execFileArgs, describeFailure } = require('./exec');
const { invalidRequest } = require('./github-checks');

/** A read's time budget. */
const READ_TIMEOUT_MS = 10000;

/** A write's time budget: GitHub builds a merge commit before it answers. */
const WRITE_TIMEOUT_MS = 20000;

/** The most output one call may return. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** The only branches this module creates, writes to or deletes. */
const CANDIDATE_PREFIX = 'tc-queue/';

/** The only way a pull request is merged here: a true merge commit. */
const MERGE_METHOD = 'merge';

/** How many files one page of a pull request's file list holds. */
const FILES_PAGE_SIZE = 100;

/** GitHub lists at most this many files for a pull request; a list this long is not known to be whole. */
const PULL_FILES_CAP = 3000;

/** GitHub lists at most this many files in a comparison, and gives no count to check a shorter list against. */
const COMPARE_FILES_CAP = 300;

const SHA_SHAPE = /^[0-9a-f]{40}$/;
const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CANDIDATE_SHAPE = /^tc-queue\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** Stand-ins for the parts of the shared request check a call does not have. */
const ANY_SHA = '0'.repeat(40);
const ANY_CHECK_NAME = 'test';

const PULL_PROJECTION = '{number: .number, state: .state, merged: .merged, draft: .draft, mergeable: .mergeable, '
  + 'base_ref: .base.ref, head_sha: .head.sha, changed_files: .changed_files}';
const REF_PROJECTION = '{ref: .ref, sha: .object.sha, type: .object.type}';
const COMMIT_PROJECTION = '{sha: .sha, tree: .tree.sha, parents: [.parents[].sha]}';
const MERGE_PROJECTION = '{sha: .sha, tree: .commit.tree.sha, parents: [.parents[].sha]}';
const FILES_PROJECTION = '[.[] | {filename: .filename, previous_filename: .previous_filename}]';
const COMPARE_PROJECTION = '{status: .status, base: .base_commit.sha, merge_base: .merge_base_commit.sha, '
  + 'files: [.files[] | {filename: .filename, previous_filename: .previous_filename}]}';
const PULL_MERGE_PROJECTION = '{sha: .sha, merged: .merged}';

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
 * Whether a branch is one this module may create, write to and delete: one
 * name directly under `tc-queue/`.
 * @param {*} ref - A branch name, without `refs/heads/`
 * @returns {boolean}
 */
function isCandidateRef(ref) {
  return _wellFormedBranch(ref) && CANDIDATE_SHAPE.test(ref);
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
 * @param {string} repo - `owner/name`
 * @param {number} number - The pull request's number
 * @returns {Promise<{status: 'read', number: number, state: 'open'|'closed', merged: boolean, draft: boolean, mergeable: (boolean|null), baseRef: string, headSha: string, changedFiles: number}|{status: 'unavailable', reason: string}>}
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
    && Number.isSafeInteger(p.changed_files) && p.changed_files >= 0;
  if (!understood) return _unavailable('GitHub answered with a pull request this server cannot read');
  return {
    status: 'read', number, state: p.state, merged: p.merged, draft: p.draft, mergeable: p.mergeable,
    baseRef: p.base_ref, headSha: p.head_sha, changedFiles: p.changed_files
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
 * Create a branch under `tc-queue/` at a commit.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The branch name
 * @param {string} baseSha - The commit it starts at
 * @returns {Promise<{status: string, refCreated: (boolean|null), reason?: string}>} `status` is `created`, `ref-exists` or `unavailable`
 */
async function _createRef(repo, ref, baseSha) {
  const answer = await _send('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${ref}`, sha: baseSha }, REF_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure, { refCreated: null });
  if (answer.http === 422 && _says(answer, 'already exists')) return { status: 'ref-exists', refCreated: false };
  if (answer.http !== 201) return _unavailable(_unexpected(answer), { refCreated: _applied(answer) });
  const made = _json(answer.body);
  if (!made || made.ref !== `refs/heads/${ref}` || made.sha !== baseSha) {
    return _unavailable('GitHub created a reference that is not this branch at this commit', { refCreated: true });
  }
  return { status: 'created', refCreated: true };
}

/**
 * Merge a commit into a candidate branch that is at `baseSha`.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The candidate branch
 * @param {string} baseSha - The commit the branch is at
 * @param {string} headSha - The commit merged in
 * @returns {Promise<object>} A {@link createCandidate} answer, without `ref`
 */
async function _mergeInto(repo, ref, baseSha, headSha) {
  const message = `Merge ${headSha} into ${ref}`;
  const answer = await _send('POST', `repos/${repo}/merges`, { base: ref, head: headSha, commit_message: message }, MERGE_PROJECTION);
  if (answer.failure) return _unavailable(answer.failure, { refCreated: true });
  if (answer.http === 409) return { status: 'conflict', refCreated: true };
  if (answer.http === 204) return { status: 'nothing-to-merge', refCreated: true };
  if (answer.http !== 201) return _unavailable(_unexpected(answer), { refCreated: true });
  const c = _json(answer.body);
  if (!_isCommitShape(c) || c.parents.length !== 2 || c.parents[0] !== baseSha || c.parents[1] !== headSha) {
    return _unavailable('GitHub made a merge that is not of these two commits', { refCreated: true });
  }
  return { status: 'created', sha: c.sha, tree: c.tree, parents: c.parents, refCreated: true };
}

/**
 * Make a candidate: create the branch `ref` at `baseSha` and merge `headSha`
 * into it. Only a branch directly under `tc-queue/` is ever written.
 *
 * - `created`: the merge commit, its tree and its two parents, base first.
 * - `conflict`: the two commits do not merge cleanly. The branch exists, at the base.
 * - `nothing-to-merge`: the base already contains the head. The branch exists, at the base.
 * - `ref-exists`: a branch of that name is already there. It was not touched.
 * - `unavailable`: the branch could not be made, or the merge into it was
 *   refused or could not be read.
 *
 * Every answer says whether the branch now exists because of this call
 * (`refCreated`: true, false, or null when that is not known). That, and not
 * the status, is what tells the caller whether there is a branch to delete: a
 * refused merge leaves the branch it was to go into.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The branch to create, `tc-queue/<name>`
 * @param {string} baseSha - The commit the branch starts at
 * @param {string} headSha - The commit merged into it
 * @returns {Promise<{status: 'created', ref: string, sha: string, tree: string, parents: string[], refCreated: true}|{status: 'conflict'|'nothing-to-merge'|'ref-exists', ref: string, refCreated: boolean}|{status: 'unavailable', reason: string, refCreated: (boolean|null)}>}
 */
async function createCandidate(repo, ref, baseSha, headSha) {
  const invalid = _invalidCommit(repo, baseSha) || _invalidCommit(repo, headSha)
    || (isCandidateRef(ref) ? null : `a candidate branch must be one name under ${CANDIDATE_PREFIX}`);
  if (invalid) return _unavailable(invalid, { refCreated: false });
  const made = await _createRef(repo, ref, baseSha);
  if (made.status !== 'created') return made.status === 'unavailable' ? made : { ...made, ref };
  const merged = await _mergeInto(repo, ref, baseSha, headSha);
  return merged.status === 'unavailable' ? merged : { ...merged, ref };
}

/**
 * Delete a candidate branch. Any branch not directly under `tc-queue/` is
 * refused before `gh` runs. `not-found` means it was already gone.
 * @param {string} repo - `owner/name`
 * @param {string} ref - The branch to delete, `tc-queue/<name>`
 * @returns {Promise<{status: 'deleted'}|{status: 'not-found'}|{status: 'unavailable', reason: string, applied: (false|null)}>}
 */
async function deleteRef(repo, ref) {
  const invalid = _invalidRepo(repo) || (isCandidateRef(ref) ? null : `only a branch under ${CANDIDATE_PREFIX} may be deleted`);
  if (invalid) return _unavailable(invalid, { applied: false });
  const answer = await _send('DELETE', `repos/${repo}/git/refs/heads/${ref}`, {});
  if (answer.failure) return _unavailable(answer.failure, { applied: null });
  if (answer.http === 204) return { status: 'deleted' };
  if (answer.http === 422 && _says(answer, 'does not exist')) return { status: 'not-found' };
  return _unavailable(_unexpected(answer), { applied: _applied(answer) });
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

module.exports = {
  readPull, readRefTip, readCommit, readPullFiles, readCompareFiles,
  createCandidate, deleteRef, mergePull, isCandidateRef,
  CANDIDATE_PREFIX, MERGE_METHOD, PULL_FILES_CAP, COMPARE_FILES_CAP, FILES_PAGE_SIZE,
  READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, _internal
};
