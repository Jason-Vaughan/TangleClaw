'use strict';

/**
 * `pr-merge` wrap step (#570) — applies the PR resolutions the `pr-check`
 * gate collected, by enqueueing GitHub auto-merge for every PR the operator
 * resolved as `merge`.
 *
 * **Why this is a separate step from the gate.** The two halves have opposite
 * ordering requirements. The gate must run EARLY: it blocks on an undecided
 * PR, and blocking is only cheap before the AI-content steps have prompted
 * the session and before `commit` has landed. The merge must run LATE: it
 * merges the PR that the wrap commit belongs to, so enqueueing it before
 * `commit` would merge a PR missing that commit — and `--delete-branch` could
 * delete the branch mid-wrap. One step cannot be both first and last, so the
 * decision is gated up front and applied at the end.
 *
 * **Running after `commit` is necessary but NOT sufficient — the commit has
 * to be PUSHED.** `commit` only pushes on the auto-branch path (wrapping on
 * `main`/`master`), and a session-scoped PR is by definition on a feature
 * branch, which is exactly the path where the wrap commit stays local. So
 * enqueueing auto-merge on a wrap-committed-but-unpushed branch merges a PR
 * that does not contain the wrap commit — the version bump and CHANGELOG
 * promotion never reach the base branch and `--delete-branch` strands the
 * local commit with no upstream. That is the #447/#450/#453 dangling-wrap
 * class arriving through a different door. This step therefore pushes the
 * branch first, and if the push fails it enqueues nothing: a stale PR is a
 * far cheaper outcome than a merged-but-incomplete one.
 *
 * **This step never blocks.** It runs after `commit`, so a halt here would
 * strand the wrap half-finished — the commit landed, the session's AI steps
 * already fired, but the pipeline reports failure and the session lifecycle
 * never completes. A failed enqueue is also not something a retry fixes
 * (auto-merge disabled on the repo, a closed PR): it needs the operator to
 * act on GitHub. So a failure surfaces as `output.warning` with remediation
 * and the wrap completes honestly, rather than trading a stale PR for a
 * stranded session.
 *
 * **Input.** Duck-typed on the staged shape `{resolutions, sessionScoped}`
 * rather than keyed to the gate's step id, so a template that renames its
 * gate step still feeds this one.
 */

const { execFile } = require('node:child_process');
const prCheck = require('./pr-check');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-pr-merge');

const EXEC_TIMEOUT_MS = 60 * 1000;

/**
 * Thin `execFile` wrapper mirroring `commit.js:defaultExec` — resolves to a
 * structured result, never throws on non-zero exit.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

/**
 * Make sure the branch the PR points at actually contains the wrap commit,
 * by pushing HEAD when the local branch is ahead of (or has no) upstream.
 *
 * Returns `{ok:true, pushed}` when the remote is known to be current, and
 * `{ok:false, reason}` when it is not — including the "can't tell" cases.
 * Refusing to enqueue on an uncertain answer is deliberate: enqueueing a
 * merge for a PR that may be missing the wrap commit is unrecoverable once
 * `--delete-branch` fires, while declining leaves a stale PR the operator
 * can merge themselves.
 *
 * @param {string} cwd - Project root
 * @returns {Promise<{ok:boolean, pushed:boolean, reason:string|null}>}
 */
async function _ensurePushed(cwd) {
  const branchRes = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    return { ok: false, pushed: false, reason: 'HEAD is detached — cannot identify the branch to push' };
  }

  // Measured against `origin/<branch>` rather than the tracking ref `@{u}`:
  // the merge targets the PR's head on `origin`, and a branch whose upstream
  // is something else (a fork, a second remote, a renamed tracking branch)
  // can be level with `@{u}` while `origin` still lacks the wrap commit —
  // which is precisely the merge this check exists to prevent.
  const ahead = await _internal.exec('git', ['rev-list', '--count', `origin/${branch}..HEAD`], { cwd });
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') {
    return { ok: true, pushed: false, reason: null };
  }

  // Either the branch is ahead, or `origin/<branch>` does not exist yet (the
  // rev-list fails). Both want the same push; `-u` is harmless when an
  // upstream already exists.
  const push = await _internal.exec('git', ['push', '-u', 'origin', branch], { cwd });
  if (push.exitCode !== 0) {
    const raw = (push.stderr || push.stdout || `exit ${push.exitCode}`).trim();
    return { ok: false, pushed: false, reason: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw };
  }
  return { ok: true, pushed: true, reason: null };
}

/**
 * Find the staged PR resolutions produced by the gate. Shape-typed: the
 * first staged entry carrying a `resolutions` object alongside a
 * `sessionScoped` array wins.
 *
 * @param {Record<string, object>} staged - Pipeline scratch space
 * @returns {{resolutions: Record<string,string>}|null}
 */
function _findStagedResolutions(staged) {
  if (!staged || typeof staged !== 'object') return null;
  for (const entry of Object.values(staged)) {
    if (entry
        && typeof entry.resolutions === 'object' && entry.resolutions !== null
        && Array.isArray(entry.sessionScoped)) {
      return entry;
    }
  }
  return null;
}

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:true, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;

  if (!project || !project.path) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'pr-merge requires context.project.path' },
      blockers: []
    };
  }

  const entry = _findStagedResolutions(staged);
  if (!entry) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR resolutions were staged this wrap' },
      blockers: []
    };
  }

  const merges = Object.keys(entry.resolutions).filter((n) => entry.resolutions[n] === 'merge');
  if (merges.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR was resolved as merge', resolutions: entry.resolutions },
      blockers: []
    };
  }

  const push = await _ensurePushed(project.path);
  if (!push.ok) {
    const output = {
      resolutions: entry.resolutions,
      applied: {},
      enqueued: 0,
      pushed: false,
      failures: [`Branch not pushed, so no merge was enqueued — ${push.reason}`],
      warning: true,
      remediation: 'The wrap commit is safe locally but is not on the remote, so merging the PR now '
        + 'would land a PR without it. Push the branch and merge the PR yourself. '
        + 'The wrap itself completed — nothing needs to be re-run.'
    };
    log.warn('pr-merge declined to enqueue — branch not pushed', {
      project: project.name, reason: push.reason
    });
    return { ok: true, status: 'done', output, blockers: [] };
  }

  const { applied, failures } = await prCheck._applyResolutions(project.path, entry.resolutions);
  // Record the outcome back onto the gate's staged entry so anything reading
  // the wrap's staged state sees what actually happened, not just what was
  // asked for. `commit` has already run, so this is a record, not an input.
  entry.applied = applied;

  const output = {
    resolutions: entry.resolutions,
    applied,
    enqueued: merges.length - failures.length,
    pushed: push.pushed,
    failures
  };

  if (failures.length > 0) {
    output.warning = true;
    output.remediation = 'Auto-merge could not be enqueued. Enable it for the repository '
      + '(Settings → Pull Requests → Allow auto-merge), or merge the PR yourself. '
      + 'The wrap itself completed — nothing needs to be re-run.';
    log.warn('pr-merge could not enqueue every auto-merge', {
      project: project.name, failures
    });
    return { ok: true, status: 'done', output, blockers: [] };
  }

  log.info('pr-merge enqueued auto-merge', { project: project.name, enqueued: merges.length });
  return { ok: true, status: 'done', output, blockers: [] };
}

const _internal = {
  exec: defaultExec
};

module.exports = { run, _internal, _findStagedResolutions, _ensurePushed };
