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
 * supply. This CLI does not yet call a real session store (no durable,
 * path-keyed "which live session owns this worktree" API exists in this
 * codebase today); the seam is wired so one can be supplied once such an
 * API exists.
 *
 * Exit codes: 0 the pipeline ran to completion, including with skips; 2 a
 * usage error; 1 an uncaught failure (a bad `--repo`, an unreadable repository).
 *
 * @module scripts/retire-stale-worktrees
 */

const path = require('node:path');
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
 * Run the full worktree-then-branch retirement pipeline.
 *
 * @param {string} repo
 * @param {boolean} apply
 * @param {object} [opts]
 * @param {Function} [opts.lookupSession] - Passed through to
 *   {@link module:lib/branch-retire-safety.planWorktreeRetirement}'s same-named option.
 * @param {Set<string>|string[]} [opts.activeBranches] - Passed through to
 *   {@link module:lib/branch-retire-safety.planBranchRetirement}'s same-named option.
 * @returns {Promise<object>} `{worktrees: {plan, result}, branches: {plan, result}}`
 */
async function runPipeline(repo, apply, opts = {}) {
  const worktreePlan = await brs.planWorktreeRetirement({ repo, lookupSession: opts.lookupSession });
  const worktreeResult = await brs.retireWorktrees(worktreePlan, { repo, apply });
  const branchPlan = await brs.planBranchRetirement({ repo, activeBranches: opts.activeBranches });
  const branchResult = await brs.retireBranches(branchPlan, { repo, apply });
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
  if (!p || (p.issueNumber === null && p.sessionId === null)) return '';
  const bits = [];
  if (p.issueNumber !== null) bits.push(`issue #${p.issueNumber}`);
  if (p.sessionId !== null) bits.push(`session ${p.sessionId}`);
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

module.exports = { parseArgs, runPipeline, render, main };
