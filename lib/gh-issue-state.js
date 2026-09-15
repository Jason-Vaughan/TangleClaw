'use strict';

/**
 * GitHub issue open/closed state, read through plain `gh`, cached, and honest
 * about when it could not look (#1516).
 *
 * The first consumer is the wrap's `priming-roll` step, which drops a build plan
 * whose cited issues have all closed before asking the operator to pick between
 * plans. It is a module rather than a one-off `gh` call because later GitHub
 * features read the same fact, and each hand-rolled call re-decides what a
 * missing `gh`, a lapsed login or an offline host means.
 *
 * Engine-neutral: server-side `gh`, no engine cooperation.
 *
 * Honesty rules (the `lib/ci-status.js` pattern):
 *  - A lookup that could not run — `gh` not installed, not authenticated, the
 *    host offline, the directory not a GitHub repository — answers
 *    `{available: false, reason}`. It never answers "open" or "closed" for an
 *    issue it did not read, because a caller would act on that guess.
 *  - One issue that GitHub says does not exist (HTTP 404, or 410 for a deleted
 *    issue) is `unknown` for that number only; the rest of the lookup stands.
 *  - Only definite answers are cached. A failure is retried on the next call, so
 *    an operator who runs `gh auth login` is not told "unavailable" for the rest
 *    of the TTL.
 *
 * `gh api repos/{owner}/{repo}/issues/N` is used rather than `gh issue view`:
 * the REST issues endpoint also answers for a pull request number, which plans
 * cite as often as issues, and gh fills `{owner}/{repo}` from the checkout.
 */

const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');
const { redactRemoteOutput, REDACTED_PREFIX } = require('./remote-output');

const log = createLogger('gh-issue-state');

const TTL_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 5000;
/** Parallel `gh` calls per lookup: enough to be quick, few enough not to trip a rate limit. */
const CONCURRENCY = 4;
/** A number GitHub does not have — answered per issue, not as a failed lookup. */
const NOT_FOUND_RE = /\(HTTP 404\)|\(HTTP 410\)/;

/** @type {Map<string, {at: number, state: ('open'|'closed')}>} */
const _cache = new Map();

/**
 * Thin `execFile` wrapper — resolves to `{exitCode, stdout, stderr, error}`,
 * never rejects. Overridable via `_internal` for tests.
 * @param {string} file - Executable.
 * @param {string[]} args - Arguments.
 * @param {{cwd: string}} options - Working directory.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, error: (Error|null)}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options && options.cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString(), error: err || null });
    });
  });
}

const _internal = { exec: defaultExec };

/**
 * A one-line, redacted reason from a failed `gh` call.
 * @param {{exitCode: number, stderr: string, error: (Error|null)}} r - The exec result.
 * @returns {string}
 */
function _reasonFrom(r) {
  if (r.error && r.error.code === 'ENOENT') return 'gh is not installed';
  if (r.error && (r.error.killed || r.error.signal === 'SIGTERM')) return `gh api timed out after ${EXEC_TIMEOUT_MS}ms`;
  const line = (r.stderr || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  // gh reaches a remote, so its stderr can echo a tokenised URL, and this reason
  // is shown to the operator.
  const safe = redactRemoteOutput(line);
  if (safe && safe.startsWith(REDACTED_PREFIX)) return `gh api failed (exit ${r.exitCode}): ${safe}`;
  return safe || `gh api failed (exit ${r.exitCode})`;
}

/**
 * Whether a failed call is "this number does not exist" rather than "gh could
 * not look at all".
 * @param {{exitCode: number, stderr: string, error: (Error|null)}} r - The exec result.
 * @returns {boolean}
 */
function _isNotFound(r) {
  if (r.error && (r.error.code === 'ENOENT' || r.error.killed)) return false;
  return NOT_FOUND_RE.test(r.stderr || '');
}

/**
 * Read one issue's state. Never rejects.
 * @param {string} cwd - A checkout of the repository.
 * @param {number} number - Issue or pull request number.
 * @returns {Promise<{state: ('open'|'closed'|'unknown')}|{failed: string}>}
 */
async function _readOne(cwd, number) {
  const r = await _internal.exec('gh', ['api', `repos/{owner}/{repo}/issues/${number}`, '--jq', '.state'], { cwd });
  if (r.exitCode !== 0) {
    if (_isNotFound(r)) return { state: 'unknown' };
    return { failed: _reasonFrom(r) };
  }
  const state = r.stdout.trim().toLowerCase();
  if (state === 'open' || state === 'closed') return { state };
  return { failed: `gh answered issue #${number} with a state this reader does not know: ${JSON.stringify(state.slice(0, 40))}` };
}

/**
 * Look up the state of several issues in one repository.
 *
 * @param {string} cwd - A checkout of the repository (gh reads the remote and login here).
 * @param {Array<number|string>} numbers - Issue or PR numbers; non-positive-integers are ignored.
 * @param {object} [opts]
 * @param {number} [opts.now] - Clock, for the TTL.
 * @param {number} [opts.ttlMs] - Cache lifetime.
 * @returns {Promise<{available: true, states: Object<string, ('open'|'closed'|'unknown')>}
 *   | {available: false, reason: string}>} `states` is keyed by the number as a string.
 */
async function lookup(cwd, numbers, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : TTL_MS;
  const wanted = [...new Set((Array.isArray(numbers) ? numbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isSafeInteger(n) && n > 0))];

  const states = {};
  const toRead = [];
  for (const n of wanted) {
    const hit = _cache.get(`${cwd}#${n}`);
    if (hit && now - hit.at < ttl) states[n] = hit.state;
    else toRead.push(n);
  }

  for (let i = 0; i < toRead.length; i += CONCURRENCY) {
    const batch = toRead.slice(i, i + CONCURRENCY);
    const answers = await Promise.all(batch.map((n) => _readOne(cwd, n)));
    for (let j = 0; j < batch.length; j += 1) {
      const answer = answers[j];
      if (answer.failed) {
        log.warn('GitHub issue state could not be read — callers are told unavailable, not a guess', {
          cwd, issue: batch[j], reason: answer.failed
        });
        return { available: false, reason: answer.failed };
      }
      states[batch[j]] = answer.state;
      if (answer.state !== 'unknown') _cache.set(`${cwd}#${batch[j]}`, { at: now, state: answer.state });
    }
  }
  return { available: true, states };
}

/**
 * Forget cached states (tests).
 * @param {string} [cwd] - One checkout, or all when omitted.
 * @returns {void}
 */
function clearCache(cwd) {
  if (!cwd) { _cache.clear(); return; }
  for (const key of [..._cache.keys()]) {
    if (key.startsWith(`${cwd}#`)) _cache.delete(key);
  }
}

module.exports = { lookup, clearCache, TTL_MS, _internal };
