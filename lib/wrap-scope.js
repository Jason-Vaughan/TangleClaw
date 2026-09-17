'use strict';

/**
 * The wrap's scope: which tree it works on, where its config lives, and where its
 * session started. Resolved once per wrap run, before the first step, and handed
 * to every step as `context.scope`.
 *
 * **Two roots, not one.** Until now a wrap had a single path, the project's
 * registered checkout, and used it for everything. That breaks when the session's
 * engine moved into a git worktree after launch (#1469): the AI edits files in
 * the worktree, every gate reads the checkout, and the AI cannot write where the
 * gate looks. So the scope separates:
 *
 * - `workTree` — the tree the session's edits live in. Git reads, file checks,
 *   AI-edited files, and the commit all use it. It is the pane's worktree when the
 *   session's pane is inside a worktree of this project's repo; otherwise the
 *   registered checkout.
 * - `configRoot` — always the registered checkout. The project's config
 *   (`.tangleclaw/project.json`) and the `lastWrapSha` boundary
 *   (`.tangleclaw/state.json`) are read from there, because a worktree may have
 *   neither file.
 *
 * Known limit, documented for operators: gitignored local files the AI writes
 * during a worktree wrap (memory files) land in the worktree.
 *
 * **Where the session started.** `baseline` is the launch baseline recorded at
 * launch (`lib/launch-baseline.js`); `startedAtMs` is the session row's start.
 * Range and ownership decisions read them from here so every step judges the
 * same session.
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const tmux = require('./tmux');
const gitRange = require('./wrap-steps/_git-range');
const commitStep = require('./wrap-steps/commit');
const { execFileArgs } = require('./exec');
const { createLogger } = require('./logger');

const log = createLogger('wrap-scope');

/** Bound on each probe the scope makes; a wrap start waits on these. */
const PROBE_TIMEOUT_MS = 10 * 1000;

/**
 * The argv runner the scope's git probes use.
 *
 * @param {string} file - Command.
 * @param {string[]} args - Argv.
 * @param {{cwd:string}} options - Where to run.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:(string|null), timedOut:boolean}>}
 */
function defaultExec(file, args, options) {
  return execFileArgs(file, args, { cwd: options.cwd, timeoutMs: PROBE_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 });
}

/**
 * Resolve a path through symlinks so two spellings of one directory compare equal
 * (macOS temp dirs live under a `/var` → `/private/var` link). A path that does not
 * exist is returned as given.
 *
 * @param {string} p - A path.
 * @returns {string}
 */
function _real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Ask git for a directory's worktree toplevel and the repository's common dir.
 *
 * @param {string} dir - Directory to ask about.
 * @param {Function} exec - Argv runner.
 * @returns {Promise<{identity:({toplevel:string, commonDir:string}|null), problem:(string|null)}>}
 *   `identity` is null when no answer was established. `problem` says why in
 *   words an operator can act on, and is null ONLY for "this is not a git
 *   repository", which is an answer rather than a failure. A git that refused
 *   (an old version rejecting a flag, a `safe.directory` refusal) or was stopped
 *   must not be reported as "not a repository": everything downstream would
 *   then give every uncommitted file a false reason.
 */
async function _repoIdentity(dir, exec) {
  const args = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'];
  let res;
  try {
    res = await exec('git', args, { cwd: dir });
  } catch (err) {
    log.warn('repo identity probe could not run', { dir, error: err.message });
    return { identity: null, problem: `git could not be run in ${dir}: ${err.message}` };
  }
  if (!res || res.exitCode !== 0) {
    const stderr = String((res && res.stderr) || '').trim();
    if (res && res.timedOut) {
      log.warn('repo identity probe was stopped before it answered', { dir, error: res.error });
      return { identity: null, problem: `git did not answer in ${dir} and was stopped (${res.error || 'timed out'})` };
    }
    if (/not a git repository/i.test(stderr)) return { identity: null, problem: null };
    log.warn('repo identity probe was refused', { dir, exitCode: res ? res.exitCode : null, stderr: stderr.slice(0, 300) });
    return { identity: null, problem: `git refused to read the repository in ${dir} (exit ${res ? res.exitCode : '?'})${stderr ? `: ${stderr.split('\n')[0]}` : ''}` };
  }
  const [toplevel, commonDir] = String(res.stdout || '').split('\n').map((l) => l.trim());
  if (!toplevel || !commonDir) {
    return { identity: null, problem: `git answered in ${dir} without a toplevel and common dir` };
  }
  return { identity: { toplevel: _real(toplevel), commonDir: _real(commonDir) }, problem: null };
}

/**
 * Decide which tree the wrap works on (#1469).
 *
 * The pane's directory selects a worktree only when it is inside a DIFFERENT
 * worktree of the SAME repository as the project. A pane that wandered into an
 * unrelated repo, or out of any repo, says nothing about where the session's
 * project edits are, so the registered checkout stays the target and the reason
 * is recorded.
 *
 * A project registered below its repo root keeps the same offset inside the
 * worktree; if that directory does not exist there, the checkout stays the target.
 *
 * @param {object} project - Project record (`path`).
 * @param {object|null} session - Session record (`tmuxSession`).
 * @param {object} deps - `{exec, paneCurrentPath}`.
 * @returns {Promise<{workTree:string, worktreeTarget:boolean, paneCwd:(string|null), reason:string}>}
 */
async function resolveWorkTree(project, session, deps) {
  const registered = project.path;
  const keep = (reason, paneCwd = null) => ({ workTree: registered, worktreeTarget: false, paneCwd, reason });

  if (!session || !session.tmuxSession) return keep('no pane to read');
  const paneCwd = deps.paneCurrentPath(session.tmuxSession);
  if (!paneCwd) return keep('pane directory could not be read');

  const [paneRead, projRead] = await Promise.all([_repoIdentity(paneCwd, deps.exec), _repoIdentity(registered, deps.exec)]);
  const pane = paneRead.identity;
  const proj = projRead.identity;
  if (!proj) return keep(projRead.problem || 'project checkout is not a git repo', paneCwd);
  if (!pane) return keep(paneRead.problem || 'pane is not inside a git repo', paneCwd);
  if (pane.commonDir !== proj.commonDir) return keep('pane is inside a different repository', paneCwd);
  if (pane.toplevel === proj.toplevel) return keep('pane is inside the registered checkout', paneCwd);

  const offset = path.relative(proj.toplevel, _real(registered));
  const candidate = offset ? path.join(pane.toplevel, offset) : pane.toplevel;
  if (!fs.existsSync(candidate)) {
    return keep(`the project directory ${offset} does not exist in the pane's worktree`, paneCwd);
  }
  return { workTree: candidate, worktreeTarget: true, paneCwd, reason: 'pane is inside a worktree of this repository' };
}

/**
 * Parse the session row's SQLite `started_at` (UTC, no zone marker).
 *
 * @param {string|null|undefined} s - `YYYY-MM-DD HH:MM:SS`.
 * @returns {number|null} Epoch ms, or null.
 */
function _startedAtMs(s) {
  if (!s || typeof s !== 'string') return null;
  const ms = Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the scope for one wrap run.
 *
 * Never throws: every probe degrades to the registered checkout, no baseline, or
 * no trunk information, and the reason is kept on the scope.
 *
 * @param {object} project - Project record.
 * @param {object|null} session - The session being wrapped.
 * @param {object} [deps] - Test seams: `{exec, paneCurrentPath, getLaunchBaseline}`.
 * @returns {Promise<{workTree:string, configRoot:string, worktreeTarget:boolean,
 *   paneCwd:(string|null), workTreeReason:string, workToplevel:(string|null), workTreeProblem:(string|null),
 *   baseline:({sha:string, toplevel:(string|null), dirty:({paths:string[], truncated:boolean}|null)}|null),
 *   snapshotApplies:boolean, startedAtMs:(number|null),
 *   lastWrapSha:(string|null), lastWrapShaRead:string,
 *   trunk:{onTrunk:boolean, branch:(string|null), trunkRefs:string[]}}>}
 */
async function resolve(project, session, deps = {}) {
  const exec = deps.exec || defaultExec;
  const paneCurrentPath = deps.paneCurrentPath || tmux.paneCurrentPath;
  const getLaunchBaseline = deps.getLaunchBaseline || ((id) => store.sessions.getLaunchBaseline(id));

  const target = await resolveWorkTree(project, session, { exec, paneCurrentPath });
  let baseline = null;
  if (session && session.id != null) {
    try {
      baseline = getLaunchBaseline(session.id);
    } catch (err) {
      log.warn('launch baseline could not be read; this wrap measures without one', { session: session.id, error: err.message });
    }
  }

  // The launch dirty set describes the tree the session launched in. It applies
  // to the work tree only when that is the same toplevel, and only when the set
  // is complete — a partial list would make every unlisted pre-existing file
  // look like this session's work.
  const workRead = await _repoIdentity(target.workTree, exec);
  const workIdentity = workRead.identity;
  const snapshotApplies = Boolean(baseline && baseline.dirty && !baseline.dirty.truncated
    && baseline.toplevel && workIdentity && _real(baseline.toplevel) === workIdentity.toplevel);

  // The commit step owns this read (it is the step that overwrites the boundary);
  // one reader, so the recorded/absent/unreadable outcome cannot drift.
  const boundary = commitStep._readLastWrapSha(project.path);
  const trunk = workIdentity
    ? await gitRange.describeTrunkAsync(target.workTree, exec)
    : { onTrunk: false, branch: null, trunkRefs: [] };

  const scope = {
    workTree: target.workTree,
    configRoot: project.path,
    worktreeTarget: target.worktreeTarget,
    paneCwd: target.paneCwd,
    workTreeReason: target.reason,
    workToplevel: workIdentity ? workIdentity.toplevel : null,
    // Why `workToplevel` is null when git failed rather than answered "not a
    // repository"; null in every other case. Steps that report a cause read it.
    workTreeProblem: workIdentity ? null : workRead.problem,
    baseline,
    snapshotApplies,
    startedAtMs: session ? _startedAtMs(session.startedAt) : null,
    lastWrapSha: boundary.sha,
    lastWrapShaRead: boundary.read,
    trunk
  };
  log.info('wrap scope resolved', {
    project: project.name,
    workTree: scope.workTree,
    worktreeTarget: scope.worktreeTarget,
    workTreeReason: scope.workTreeReason,
    launchSha: baseline ? baseline.sha : null,
    snapshotApplies,
    onTrunk: trunk.onTrunk
  });
  return scope;
}

/**
 * The project record a wrap step sees: `path` is the work tree, `configPath` the
 * registered checkout. Every step reads config through `./wrap-steps/_config-root#configRootOf`.
 *
 * @param {object} project - Registered project record.
 * @param {object} scope - From {@link resolve}.
 * @returns {object}
 */
function stepProject(project, scope) {
  return { ...project, path: scope.workTree, configPath: scope.configRoot };
}

module.exports = {
  resolve,
  resolveWorkTree,
  stepProject,
  _startedAtMs
};
