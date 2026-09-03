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
 * Honesty rules:
 *  - `failing` renders loudly; `passing` renders nothing (a green line on every
 *    launch is noise that trains the reader to skip the red one).
 *  - `unknown` renders AS unknown — "gh is not installed", "not authenticated",
 *    a rate limit, an origin whose default branch cannot be named — never as
 *    green. A probe that could not answer is not an all-clear, and it is logged
 *    at warn once per fresh probe so the operator (the only one who can run
 *    `gh auth login` on the host) learns the guard is off.
 *  - `none` is reserved for facts, not failures: no origin remote, or an origin
 *    whose branch has no push-triggered workflow runs. There is no CI to be red.
 *
 * The verdict is PER WORKFLOW, not "newest run on the branch": a repo's branch
 * carries push-triggered test runs beside scheduled and release runs, and the
 * newest of those is not the trunk's verdict — a green nightly after a red
 * push would have read as passing. The newest push/dispatch run of each
 * workflow is judged; any failing one fails the branch, named.
 *
 * Two entry points, deliberately split. `refresh()` is async and does the
 * spawning (`git`, `gh`) off the event loop — a synchronous `gh` on the launch
 * path would hold every other request, session proxy and listener for up to
 * the timeout, the shape `lib/update-checker.js` records as wrong in a request
 * handler. The launch route awaits it before `launchSession`; `readCached()`
 * is the synchronous read the prime generator uses, and a cold cache is an
 * honest `unknown`, not a spawn.
 */

const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('ci-status');

const TTL_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 5000;
const RUN_WINDOW = 20;
/** Events whose runs speak for the branch's own commits. */
const TRUNK_EVENTS = new Set(['push', 'workflow_dispatch']);
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** @type {Map<string, {at: number, result: object}>} */
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
      cwd: options && options.cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024, env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString(), error: err || null });
    });
  });
}

const _internal = { exec: defaultExec };

/**
 * A one-line reason from a failed exec.
 * @param {{stderr: string, error: (Error|null)}} r - The exec result.
 * @param {string} what - The command, for the fallback sentence.
 * @returns {string}
 */
function _reasonFrom(r, what) {
  if (r.error && r.error.code === 'ENOENT') return `${what.split(' ')[0]} is not installed`;
  if (r.error && (r.error.killed || r.error.signal === 'SIGTERM')) return `${what} timed out after ${EXEC_TIMEOUT_MS}ms`;
  const line = (r.stderr || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line || `${what} failed (exit ${r.exitCode})`;
}

/**
 * Judge a window of runs: the newest push/dispatch run per workflow.
 * @param {object[]} runs - `gh run list --json` rows, newest first.
 * @returns {{state: string, reason: (string|null), run: (object|null)}}
 */
function _judge(runs) {
  const newestByWorkflow = new Map();
  for (const run of runs) {
    if (!TRUNK_EVENTS.has(run.event)) continue;
    const key = run.workflowName || run.name || '?';
    if (!newestByWorkflow.has(key)) newestByWorkflow.set(key, run);
  }
  if (newestByWorkflow.size === 0) return { state: 'none', reason: 'no push-triggered workflow runs', run: null };
  const latest = [...newestByWorkflow.values()];
  const failing = latest.find((r) => r.status === 'completed' && FAILING_CONCLUSIONS.has(r.conclusion));
  if (failing) return { state: 'failing', reason: failing.conclusion, run: failing };
  const pending = latest.find((r) => r.status !== 'completed');
  if (pending) return { state: 'in-progress', reason: `run ${pending.status || 'pending'}`, run: pending };
  const odd = latest.find((r) => r.conclusion !== 'success');
  if (odd) {
    // cancelled, skipped, neutral, or a conclusion this reader has not met:
    // none of them is "passing", so none of them renders as it.
    return { state: 'unknown', reason: `${odd.workflowName || 'a workflow'} last concluded ${odd.conclusion || 'without a verdict'}`, run: odd };
  }
  return { state: 'passing', reason: null, run: latest[0] };
}

/**
 * Probe the origin's default branch and fill the cache. Async: the spawns run
 * off the event loop. Never rejects — every failure is an `unknown` with its
 * reason.
 *
 * @param {string} projectPath - Project directory.
 * @param {object} [opts]
 * @param {number} [opts.now] - Clock, for the TTL.
 * @param {number} [opts.ttlMs] - Cache lifetime.
 * @param {boolean} [opts.force] - Ignore a fresh cache entry.
 * @returns {Promise<{state: ('failing'|'passing'|'in-progress'|'none'|'unknown'), branch: (string|null),
 *   reason: (string|null), runUrl: (string|null), sha: (string|null), workflow: (string|null),
 *   updatedAt: (string|null)}>}
 */
async function refresh(projectPath, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : TTL_MS;
  const hit = _cache.get(projectPath);
  if (hit && !opts.force && now - hit.at < ttl) return hit.result;

  const exec = _internal.exec;
  const base = { branch: null, reason: null, runUrl: null, sha: null, workflow: null, updatedAt: null };
  const result = await _probe(projectPath, exec, base);
  _cache.set(projectPath, { at: now, result });
  if (result.state === 'unknown') {
    log.warn('Base-branch CI could not be read — sessions will be told unknown, not green', {
      project: projectPath, branch: result.branch, reason: result.reason
    });
  } else if (result.state === 'failing') {
    log.info('Base-branch CI is failing — sessions will be told', {
      project: projectPath, branch: result.branch, runUrl: result.runUrl, sha: result.sha
    });
  }
  return result;
}

/**
 * The probe itself, separated so `refresh` owns only caching and logging.
 * @param {string} projectPath - Project directory.
 * @param {Function} exec - The exec wrapper.
 * @param {object} base - Empty result fields.
 * @returns {Promise<object>}
 */
async function _probe(projectPath, exec, base) {
  const cwd = projectPath;
  const remote = await exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (remote.exitCode !== 0) {
    // Not a repository, or no remote named origin: nothing to be red. A
    // missing `git` binary is not that fact, so it is said as unknown.
    if (remote.error && remote.error.code === 'ENOENT') return { ...base, state: 'unknown', reason: 'git is not installed' };
    return { ...base, state: 'none', reason: 'no origin remote' };
  }

  let branch = null;
  const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
  if (head.exitCode === 0 && head.stdout.trim()) {
    branch = head.stdout.trim().replace(/^origin\//, '');
  } else {
    // `origin/HEAD` is written by `git clone`, not by `git remote add`; ask
    // GitHub for the default branch before giving up, and give up as unknown.
    const view = await exec('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd });
    if (view.exitCode === 0 && view.stdout.trim()) {
      branch = view.stdout.trim();
    } else {
      return {
        ...base, state: 'unknown',
        reason: `origin/HEAD is not set locally (git remote set-head origin -a) and gh could not name the default branch: ${_reasonFrom(view, 'gh repo view')}`
      };
    }
  }

  const list = await exec('gh', [
    'run', 'list', '--branch', branch, '--limit', String(RUN_WINDOW),
    '--json', 'conclusion,status,url,headSha,updatedAt,workflowName,event'
  ], { cwd });
  if (list.exitCode !== 0) return { ...base, branch, state: 'unknown', reason: _reasonFrom(list, 'gh run list') };
  let runs;
  try {
    runs = JSON.parse(list.stdout || '[]');
  } catch (err) {
    return { ...base, branch, state: 'unknown', reason: `gh answered in a form this reader could not parse: ${err.message}` };
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return { ...base, branch, state: 'none', reason: `no workflow runs on ${branch}` };
  }
  const verdict = _judge(runs);
  const run = verdict.run || {};
  return {
    ...base, branch, state: verdict.state, reason: verdict.reason,
    runUrl: run.url || null, sha: run.headSha || null, workflow: run.workflowName || null, updatedAt: run.updatedAt || null
  };
}

/**
 * The cached verdict, synchronously, for the prime generator. A cold cache is
 * an honest `unknown` — this never spawns.
 * @param {string} projectPath - Project directory.
 * @param {object} [opts]
 * @param {number} [opts.now] - Clock, for the TTL.
 * @param {number} [opts.ttlMs] - Cache lifetime.
 * @returns {object} A result in the `refresh` shape.
 */
function readCached(projectPath, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : TTL_MS;
  const hit = _cache.get(projectPath);
  if (hit && now - hit.at < ttl) return hit.result;
  return {
    branch: null, runUrl: null, sha: null, workflow: null, updatedAt: null,
    state: 'unknown', reason: 'not probed before this launch'
  };
}

/**
 * Prime lines for a verdict — the failing, in-progress and unknown cases only.
 * @param {object} result - From `refresh` / `readCached`.
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
      + 'Not green: TangleClaw could not look, which is a different fact from "passing". '
      + 'Mention it to the operator in your first message; they are the one who can fix the probe._',
      ''
    ];
  }
  return [];
}

/**
 * Forget cached verdicts (tests).
 * @param {string} [projectPath] - One project, or all when omitted.
 */
function clearCache(projectPath) {
  if (projectPath) _cache.delete(projectPath);
  else _cache.clear();
}

module.exports = { refresh, readCached, primeLines, clearCache, _internal };
