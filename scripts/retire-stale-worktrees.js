#!/usr/bin/env node
'use strict';

/**
 * Safe worktree and `[gone]`-branch retirement (#1267): on a long-running
 * install, nothing prunes a worktree or local branch once its work has
 * landed — 35 worktrees and 77 `[gone]` branches was the observed state that
 * motivated this.
 *
 *   node scripts/retire-stale-worktrees.js [--repo <dir>] [--apply] [--json]
 *
 * Default is `--dry-run` (the absence of `--apply`): plans retirement and
 * prints what *would* happen, without removing anything. Worktrees are
 * retired before branches — a worktree pins its branch — via
 * `lib/branch-retire-safety.js`'s planner/executor pair for each. Never
 * passes `--force` to `git worktree remove`, and only ever runs
 * `git branch -d` (never `-D`). Both planners fail closed when a `git
 * fetch` fails (reason `fetch-failed`, no classification against stale
 * remote-tracking refs) and never retire a worktree or branch a live
 * session holds (reason `live-session`) — see those functions' own
 * docstrings for the `lookupSession`/`activeBranches` seam a caller can
 * supply.
 *
 * No durable, path-keyed "which live session owns this worktree" API exists
 * anywhere in this codebase, so by default this CLI's own `lookupSession`/
 * `activeBranches` are a best-effort tmux-pane probe (`_defaultLookupSession`/
 * `_defaultActiveBranches`): a pane `cd`'d into a worktree, or checked out on
 * a branch, counts as live. That probe only sees tmux-launched sessions. In
 * `--apply`, if the probe itself cannot answer (tmux unreachable), every
 * planner it feeds fails closed and retires nothing, rather than silently
 * treating "could not check" as "nothing is live" — `--dry-run` tolerates
 * the same failure by showing an optimistic preview instead, since nothing
 * there is destructive. A caller that knows a real session store can always
 * inject its own `lookupSession`/`activeBranches` into {@link runPipeline}.
 *
 * Exit codes: 0 the pipeline ran to completion, including with skips; 2 a
 * usage error; 1 an uncaught failure (a bad `--repo`, an unreadable repository).
 *
 * @module scripts/retire-stale-worktrees
 */

const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const brs = require('../lib/branch-retire-safety');

const USAGE = 'Usage: node scripts/retire-stale-worktrees.js [--repo <dir>] [--apply] [--json]\n';

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_ERROR = 1;

/**
 * Parse the command line.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{repo: string, apply: boolean, json: boolean, help: boolean}|null} Options, or null on a usage error.
 */
function parseArgs(argv) {
  const opts = { repo: process.cwd(), apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--repo') {
      const v = argv[++i];
      if (!v) return null;
      opts.repo = path.resolve(v);
    } else return null;
  }
  return opts;
}

/**
 * One tmux pane-list probe, shared by the two default detectors below.
 * Throws when tmux itself cannot answer (not installed, no server running,
 * timed out) — the only thing worse than no live-session signal is one that
 * reads as "nothing is live" when the truth is "the probe didn't work".
 *
 * @param {Function} execFileSync - `child_process.execFileSync`-compatible seam.
 * @returns {{sessionName: string, cwd: string}[]}
 */
function _tmuxPanes(execFileSync) {
  let out;
  try {
    out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    throw new Error(`default live-session probe failed (tmux list-panes -a): ${err && err.message ? err.message : err}`);
  }
  const panes = [];
  for (const line of String(out).split('\n')) {
    const [sessionName, cwd] = line.split('\t');
    if (!sessionName || !cwd) continue;
    const real = (() => { try { return fs.realpathSync(cwd.trim()); } catch { return path.resolve(cwd.trim()); } })();
    panes.push({ sessionName, cwd: real });
  }
  return panes;
}

/**
 * The CLI's own default `lookupSession`, used only when no caller injects one: a tmux pane
 * whose current directory IS the worktree counts as a live session. Only ever sees a
 * tmux-launched session — a worktree in use any other way is invisible to this default, which
 * is exactly why a caller that knows better should supply its own `lookupSession`. In
 * `--dry-run`, an unreachable tmux is swallowed (nothing destructive to fail closed on there);
 * in `--apply`, it throws, which `lib/branch-retire-safety.js`'s consumers (`describeProvenance`,
 * `retireWorktrees`) both turn into holding the worktree, never removing it.
 *
 * @param {string} worktreePath
 * @param {object} [opts]
 * @param {boolean} [opts.apply]
 * @param {Function} [opts.execFileSync] - Defaults to `child_process.execFileSync` (a test seam).
 * @returns {Promise<{sessionId: string}|null>}
 */
async function _defaultLookupSession(worktreePath, opts = {}) {
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  let panes;
  try {
    panes = _tmuxPanes(execFileSync);
  } catch (err) {
    if (opts.apply) throw err;
    return null;
  }
  const target = (() => { try { return fs.realpathSync(worktreePath); } catch { return path.resolve(worktreePath); } })();
  const hit = panes.find((p) => p.cwd === target);
  return hit ? { sessionId: hit.sessionName } : null;
}

/**
 * The CLI's own default `activeBranches`, used only when no caller injects one: whatever
 * branch is checked out at a tmux pane's current directory (a worktree or the primary
 * checkout) counts as active. A pane outside any git checkout, or at a detached HEAD, is
 * silently skipped — that is a normal case, not a probe failure; only the pane LISTING itself
 * (tmux unreachable) is treated as one, the same `--apply`-only fail-closed split as
 * {@link _defaultLookupSession}.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply]
 * @param {Function} [opts.execFileSync]
 * @returns {Set<string>}
 */
function _defaultActiveBranches(opts = {}) {
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  let panes;
  try {
    panes = _tmuxPanes(execFileSync);
  } catch (err) {
    if (opts.apply) throw err;
    return new Set();
  }
  const branches = new Set();
  for (const p of panes) {
    try {
      const b = String(execFileSync('git', ['-C', p.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 })).trim();
      if (b && b !== 'HEAD') branches.add(b);
    } catch {
      // Not a git checkout at this pane's cwd (or detached HEAD) — not relevant, not a probe failure.
    }
  }
  return branches;
}

/**
 * Run the full worktree-then-branch retirement pipeline.
 *
 * When `opts.lookupSession`/`opts.activeBranches` are not supplied, this defaults to the
 * tmux-pane-based detectors above rather than leaving the underlying planners with nothing —
 * see their own docstrings for what that default can and cannot see.
 *
 * @param {string} repo
 * @param {boolean} apply
 * @param {object} [opts]
 * @param {Function} [opts.lookupSession] - Passed through to
 *   {@link module:lib/branch-retire-safety.planWorktreeRetirement}'s same-named option.
 * @param {Set<string>|string[]} [opts.activeBranches] - Passed through to
 *   {@link module:lib/branch-retire-safety.planBranchRetirement}'s same-named option.
 * @param {Function} [opts.execFileSync] - Test seam for the default detectors' tmux/git calls.
 * @param {Function} [opts.execFile] - Test seam passed straight through to every
 *   `lib/branch-retire-safety.js` call (its own git seam, a different API than `execFileSync` above).
 * @returns {Promise<object>} `{worktrees: {plan, result}, branches: {plan, result}}`
 */
async function runPipeline(repo, apply, opts = {}) {
  const lookupSession = typeof opts.lookupSession === 'function'
    ? opts.lookupSession
    : (p) => _defaultLookupSession(p, { apply, execFileSync: opts.execFileSync });
  const activeBranches = opts.activeBranches !== undefined
    ? opts.activeBranches
    : _defaultActiveBranches({ apply, execFileSync: opts.execFileSync });

  const worktreePlan = await brs.planWorktreeRetirement({ repo, lookupSession, execFile: opts.execFile });
  const worktreeResult = await brs.retireWorktrees(worktreePlan, { repo, apply, lookupSession, execFile: opts.execFile });
  const branchPlan = await brs.planBranchRetirement({ repo, activeBranches, execFile: opts.execFile });
  const branchResult = await brs.retireBranches(branchPlan, { repo, apply, execFile: opts.execFile });
  return { worktrees: { plan: worktreePlan, result: worktreeResult }, branches: { plan: branchPlan, result: branchResult } };
}

/**
 * A skipped worktree entry's provenance, rendered for a terminal when present
 * (best-effort; absent for entries {@link runPipeline} never reached, like a prunable tree).
 * @param {object} w - A skipped worktree entry, possibly carrying `provenance`.
 * @returns {string}
 */
function _provenanceSuffix(w) {
  const p = w.provenance;
  if (!p || (p.issueNumber === null && p.sessionId === null && p.createdAt === null)) return '';
  const bits = [];
  if (p.issueNumber !== null) bits.push(`issue #${p.issueNumber}`);
  if (p.sessionId !== null) bits.push(`session ${p.sessionId}`);
  if (p.createdAt !== null) bits.push(`created ${p.createdAt}`);
  return ` (${bits.join(', ')})`;
}

/**
 * Render the pipeline's outcome for a terminal.
 * @param {object} out - A {@link runPipeline} result.
 * @param {boolean} apply
 * @returns {string}
 */
function render(out, apply) {
  const verb = apply ? 'removed' : 'would remove';
  const lines = [];
  lines.push(`worktrees: ${out.worktrees.result.removed.length} ${verb}, ${out.worktrees.plan.skipped.length + out.worktrees.result.skipped.length} skipped`);
  for (const w of out.worktrees.result.removed) lines.push(`  ${w.action}: ${w.path} (${w.class})`);
  for (const w of out.worktrees.plan.skipped) lines.push(`  skipped: ${w.path} [${w.reason}] ${w.detail}${_provenanceSuffix(w)}`);
  for (const w of out.worktrees.result.skipped) lines.push(`  skipped: ${w.path} [${w.action}] ${w.detail}`);
  lines.push(`branches: ${out.branches.result.removed.length} ${apply ? 'deleted' : 'would delete'}, ${out.branches.plan.skipped.length + out.branches.result.skipped.length} skipped`);
  for (const b of out.branches.result.removed) lines.push(`  ${b.action}: ${b.branch}`);
  for (const b of out.branches.plan.skipped) lines.push(`  skipped: ${b.branch} — ${b.detail}`);
  for (const b of out.branches.result.skipped) lines.push(`  skipped: ${b.branch} [${b.action}] ${b.detail}`);
  return lines.join('\n') + '\n';
}

/**
 * Entry point.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  try {
    const out = await runPipeline(opts.repo, opts.apply);
    if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else process.stdout.write(render(out, opts.apply));
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`retire-stale-worktrees failed: ${err && err.message ? err.message : 'internal error'}\n`);
    return EXIT_ERROR;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }, (err) => {
    process.stderr.write(`retire-stale-worktrees failed: ${err && err.message ? err.message : 'internal error'}\n`);
    process.exit(EXIT_ERROR);
  });
}

module.exports = { parseArgs, runPipeline, render, main, _defaultLookupSession, _defaultActiveBranches, _tmuxPanes };
