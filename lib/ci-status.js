'use strict';

/**
 * Default-branch CI status for a project, for the session-start prime (#991).
 *
 * `main` was red for four hours on 2026-08-18 and nothing surfaced it: every
 * PR opened against it inherited the failure and read as "your PR is broken",
 * and a release was nearly cut from it. TangleClaw polls a great deal about a
 * project and did not poll the one signal that says whether its trunk builds.
 *
 * Engine-neutral by construction: this is generated text in the prime, so it
 * reaches Claude, Codex, Antigravity and Aider alike, and it is entirely
 * server-side — no engine cooperation required.
 *
 * Honesty rules, in the shape the rest of Train 11 uses:
 *  - `failing` renders loudly; `passing` renders nothing (a green line on every
 *    launch is noise that trains the reader to skip the red one).
 *  - `unknown` renders AS unknown — "gh is not installed", "not authenticated",
 *    a rate limit — never as green. A probe that could not answer is not an
 *    all-clear.
 *  - `none` (no origin, or an origin with no workflow runs) renders nothing:
 *    there is no CI to be red, which is a different fact from "could not look".
 *
 * The probe is `gh run list` on the origin's default branch, cached per
 * project for `TTL_MS` so a burst of launches asks GitHub once.
 */

const { execFileSync } = require('node:child_process');

const TTL_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 5000;

/** @type {Map<string, {at: number, result: object}>} */
const _cache = new Map();

/**
 * Run a command in the project directory and return trimmed stdout.
 * @param {string} cwd - Project directory.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @returns {string}
 */
function _defaultExec(cwd, cmd, args) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/**
 * The origin's default branch, or null when there is no origin to ask.
 * @param {string} projectPath - Project directory.
 * @param {Function} exec - `(cwd, cmd, args) => stdout`.
 * @returns {string|null}
 */
function _defaultBranch(projectPath, exec) {
  try {
    const ref = exec(projectPath, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref.replace(/^origin\//, '') || null;
  } catch {
    return null;
  }
}

/**
 * First useful line of a failed command's stderr, for the unknown reason.
 * @param {Error} err - The exec error.
 * @returns {string}
 */
function _reasonFrom(err) {
  if (err && err.code === 'ENOENT') return 'gh is not installed';
  const stderr = err && err.stderr ? String(err.stderr) : '';
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line || (err && err.message) || 'gh failed';
}

/**
 * Probe the default branch's most recent CI run.
 *
 * @param {string} projectPath - Project directory.
 * @param {object} [opts]
 * @param {Function} [opts.exec] - `(cwd, cmd, args) => stdout`; tests inject.
 * @param {number} [opts.now] - Clock, for the TTL.
 * @param {number} [opts.ttlMs] - Cache lifetime.
 * @returns {{state: ('failing'|'passing'|'in-progress'|'none'|'unknown'), branch: (string|null),
 *   reason: (string|null), runUrl: (string|null), sha: (string|null), workflow: (string|null),
 *   updatedAt: (string|null)}}
 */
function probeMainCi(projectPath, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : TTL_MS;
  const hit = _cache.get(projectPath);
  if (hit && now - hit.at < ttl) return hit.result;

  const exec = opts.exec || _defaultExec;
  const base = { branch: null, reason: null, runUrl: null, sha: null, workflow: null, updatedAt: null };
  let result;
  const branch = _defaultBranch(projectPath, exec);
  if (!branch) {
    result = { ...base, state: 'none', reason: 'no origin default branch' };
  } else {
    let runs;
    try {
      const out = exec(projectPath, 'gh', [
        'run', 'list', '--branch', branch, '--limit', '1',
        '--json', 'conclusion,status,url,headSha,updatedAt,workflowName'
      ]);
      runs = JSON.parse(out || '[]');
    } catch (err) {
      runs = null;
      result = { ...base, branch, state: 'unknown', reason: _reasonFrom(err) };
    }
    if (runs) {
      if (!Array.isArray(runs) || runs.length === 0) {
        result = { ...base, branch, state: 'none', reason: `no workflow runs on ${branch}` };
      } else {
        const run = runs[0];
        const fields = {
          ...base, branch, runUrl: run.url || null, sha: run.headSha || null,
          workflow: run.workflowName || null, updatedAt: run.updatedAt || null
        };
        if (run.status !== 'completed') {
          result = { ...fields, state: 'in-progress', reason: `run ${run.status || 'pending'}` };
        } else if (run.conclusion === 'success') {
          result = { ...fields, state: 'passing' };
        } else if (['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion)) {
          result = { ...fields, state: 'failing', reason: run.conclusion };
        } else {
          // cancelled, skipped, neutral, or a conclusion this reader has not
          // met: none of them is "passing", so none of them renders as it.
          result = { ...fields, state: 'unknown', reason: `last run concluded ${run.conclusion || 'without a verdict'}` };
        }
      }
    }
  }
  _cache.set(projectPath, { at: now, result });
  return result;
}

/**
 * Prime lines for a probe result — the failing and unknown cases only.
 * @param {object} result - From `probeMainCi`.
 * @returns {string[]} Lines; empty when there is nothing honest to say.
 */
function primeLines(result) {
  if (!result) return [];
  const sha = result.sha ? result.sha.slice(0, 7) : null;
  const where = [result.runUrl ? `run ${result.runUrl}` : null, sha ? `on ${sha}` : null,
    result.workflow ? `(${result.workflow})` : null].filter(Boolean).join(' ');
  if (result.state === 'failing') {
    return [
      `## Base branch CI: **${result.branch} is FAILING**`,
      `${where}${result.updatedAt ? `, last run ${result.updatedAt}` : ''}.`,
      'Your base branch is broken. A PR opened against it inherits this failure — do not read a red '
      + 'check on your own branch as yours until this is fixed — and a release must not be cut from it. '
      + 'Say so to the operator in your first message.',
      ''
    ];
  }
  if (result.state === 'in-progress') {
    return [`_Base branch CI: a run on ${result.branch} is in progress${where ? ` — ${where}` : ''}; its verdict is not in yet._`, ''];
  }
  if (result.state === 'unknown') {
    return [
      `_Base branch CI: **unknown** — ${result.reason || 'the probe could not answer'}. `
      + 'Not green: TangleClaw could not look, which is a different fact from "passing".',
      ''
    ];
  }
  return [];
}

/**
 * Forget cached results (tests, and a config change).
 * @param {string} [projectPath] - One project, or all when omitted.
 */
function clearCache(projectPath) {
  if (projectPath) _cache.delete(projectPath);
  else _cache.clear();
}

module.exports = { probeMainCi, primeLines, clearCache, TTL_MS };
