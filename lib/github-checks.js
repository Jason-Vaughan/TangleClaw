'use strict';

/**
 * A trusted, server-side reader of one named check on one exact commit:
 * TangleClaw asks GitHub itself, through `gh` on this host, what the check's
 * newest run says. A session's claim that a check passed is never evidence;
 * what this module reads is.
 *
 * The answer is one of four, and the last is never mistaken for any other:
 *
 * - `not-found`: GitHub answered, and the commit has no run of that name.
 * - `running`: the newest run of that name has not finished.
 * - `concluded`: it finished, with the conclusion, the run's id and when.
 * - `unavailable`: the read failed, or the answer could not be understood. It
 *   carries the reason and says nothing about the check.
 *
 * Every read is bounded and nothing is cached: a caller that asks twice reads
 * GitHub twice.
 *
 * @module lib/github-checks
 */

const { execFileArgs, describeFailure } = require('./exec');

/** One gh call's time budget. */
const EXEC_TIMEOUT_MS = 10000;

/** The most runs asked for; a commit with more runs of one name than this is not guessed at. */
const PAGE_SIZE = 100;

/** The longest check name read. */
const MAX_CHECK_NAME = 100;

/** Every conclusion GitHub gives a finished check run. */
const CONCLUSIONS = Object.freeze([
  'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'
]);

/** Every status GitHub gives a check run that has not finished. */
const UNFINISHED_STATUSES = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_SHAPE = /^[0-9a-f]{40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** What is kept of each run: the fields this module reads and no others, so a long answer stays small. */
const PROJECTION = '{total_count: .total_count, check_runs: [.check_runs[] | '
  + '{id: .id, name: .name, head_sha: .head_sha, status: .status, conclusion: .conclusion, '
  + 'started_at: .started_at, completed_at: .completed_at}]}';

/** Seams for tests. */
const _internal = {
  exec: (args, timeoutMs = EXEC_TIMEOUT_MS) => execFileArgs('gh', args, { timeoutMs, maxBufferBytes: 256 * 1024 })
};

/**
 * Why a repository, commit or check name cannot be read, if it cannot.
 * @param {*} repo - `owner/name`
 * @param {*} sha - A full, lower-case commit id
 * @param {*} name - The check's name, exactly as GitHub shows it
 * @returns {string|null} The reason, or null when all three can be read
 */
function invalidRequest(repo, sha, name) {
  if (typeof repo !== 'string' || !REPO_SHAPE.test(repo) || repo.split('/').some((seg) => /^\.+$/.test(seg))) {
    return 'the repository must be owner/name';
  }
  if (typeof sha !== 'string' || !SHA_SHAPE.test(sha)) return 'the commit must be a full 40-character lower-case sha';
  if (typeof name !== 'string' || !name || name.length > MAX_CHECK_NAME || name !== name.trim() || CONTROL_CHARACTER.test(name)) {
    return `the check name must be 1 to ${MAX_CHECK_NAME} characters with no surrounding space or control character`;
  }
  return null;
}

/**
 * An unavailable reading.
 * @param {string} reason - Why nothing can be said about the check
 * @returns {{status: 'unavailable', reason: string}}
 */
function _unavailable(reason) {
  return { status: 'unavailable', reason };
}

/**
 * A time GitHub gave, as milliseconds, or null when it is not a time.
 * @param {*} value - An ISO string
 * @returns {number|null}
 */
function _time(value) {
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether run `a` is newer than run `b`: the later start, and for runs that
 * started together the higher id, which GitHub gives in creation order.
 * @param {object} a - A run
 * @param {object} b - A run
 * @returns {boolean}
 */
function _newer(a, b) {
  const [at, bt] = [_time(a.started_at), _time(b.started_at)];
  if (at !== null && bt !== null && at !== bt) return at > bt;
  return a.id > b.id;
}

/**
 * Read GitHub's answer for a commit's check runs into one reading of the named
 * check. The newest run of that name wins, so a re-run replaces the run it
 * re-ran. Anything not understood is `unavailable`, never a guess.
 * @param {*} answer - The parsed answer
 * @param {string} sha - The commit asked about
 * @param {string} name - The check's name
 * @returns {{status: string, conclusion?: string, runId?: string, completedAt?: string, reason?: string}}
 */
function interpret(answer, sha, name) {
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.check_runs) || !Number.isInteger(answer.total_count)) {
    return _unavailable('GitHub answered with something that is not a list of check runs');
  }
  if (answer.total_count > answer.check_runs.length) {
    return _unavailable(`the commit has ${answer.total_count} runs of that name, more than one read returns`);
  }
  let newest = null;
  for (const run of answer.check_runs) {
    if (!run || typeof run !== 'object' || !Number.isSafeInteger(run.id) || run.id < 1 || typeof run.status !== 'string') {
      return _unavailable('GitHub answered with a check run this server cannot read');
    }
    if (run.head_sha !== sha) return _unavailable('GitHub answered with a check run of another commit');
    if (run.name !== name) continue;
    if (!newest || _newer(run, newest)) newest = run;
  }
  if (!newest) return { status: 'not-found' };
  const runId = String(newest.id);
  if (UNFINISHED_STATUSES.includes(newest.status)) return { status: 'running', runId };
  if (newest.status !== 'completed') return _unavailable(`check run ${runId} has a status this server does not know: ${newest.status}`);
  if (!CONCLUSIONS.includes(newest.conclusion)) {
    return _unavailable(`check run ${runId} finished with a conclusion this server does not know: ${String(newest.conclusion)}`);
  }
  if (_time(newest.completed_at) === null) return _unavailable(`check run ${runId} finished without a completion time`);
  return { status: 'concluded', conclusion: newest.conclusion, runId, completedAt: new Date(_time(newest.completed_at)).toISOString() };
}

/**
 * Read one named check on one exact commit from GitHub. A malformed
 * repository, commit or name is refused before `gh` runs. Never throws.
 * @param {string} repo - `owner/name`
 * @param {string} sha - A full, lower-case commit id
 * @param {string} name - The check's name, exactly as GitHub shows it
 * @param {number} [timeoutMs] - This read's budget
 * @returns {Promise<{status: 'not-found'}|{status: 'running', runId: string}|{status: 'concluded', conclusion: string, runId: string, completedAt: string}|{status: 'unavailable', reason: string}>}
 */
async function readCheck(repo, sha, name, timeoutMs = EXEC_TIMEOUT_MS) {
  const invalid = invalidRequest(repo, sha, name);
  if (invalid) return _unavailable(invalid);
  const path = `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=${PAGE_SIZE}`;
  let r;
  try {
    r = await _internal.exec(['api', path, '--jq', PROJECTION], timeoutMs);
  } catch (err) {
    return _unavailable(`gh api could not run (${err && err.message ? err.message : 'unknown error'})`);
  }
  if (!r || r.exitCode !== 0) return _unavailable(describeFailure(r || { exitCode: 1 }, 'gh api'));
  let answer;
  try {
    answer = JSON.parse(r.stdout);
  } catch {
    return _unavailable('gh answered with something that is not JSON');
  }
  return interpret(answer, sha, name);
}

module.exports = { readCheck, interpret, invalidRequest, CONCLUSIONS, UNFINISHED_STATUSES, MAX_CHECK_NAME, EXEC_TIMEOUT_MS, _internal };
