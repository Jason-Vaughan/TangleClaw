#!/usr/bin/env node
'use strict';

/**
 * Verify the `metrics` branch: every commit, oldest first, against the rules
 * in `lib/release-certification/verify.js` (#1949, ADR 0021).
 *
 *   node scripts/scorecard-verify.js [--ref origin/metrics] [--repo <dir>]
 *
 * Exit codes: 0 the history is clean (or the branch does not exist yet),
 * 1 violations were found, 2 usage error. With `GITHUB_STEP_SUMMARY` set, the
 * verdict is also written there as a table, so a red run says which commit
 * broke which rule.
 *
 * @module scripts/scorecard-verify
 */

const fs = require('node:fs');
const { verifyHistory } = require('../lib/release-certification/verify');

/**
 * Parse `--ref` and `--repo`.
 * @param {string[]} argv - Arguments
 * @returns {{ref: string, repo: string}|null} Options, or null on a usage error
 */
function parseArgs(argv) {
  const opts = { ref: 'origin/metrics', repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return null;
    if (flag === '--ref') opts.ref = value;
    else if (flag === '--repo') opts.repo = value;
    else return null;
  }
  return opts;
}

/**
 * The verdict as a Markdown table for the job summary.
 * @param {string} ref - Verified ref
 * @param {object} result - `verifyHistory` result
 * @returns {string} Markdown
 */
function summaryMarkdown(ref, result) {
  if (!result.exists) return `### Scorecard verification\n\n\`${ref}\` does not exist yet: nothing to verify.\n`;
  if (result.violations.length === 0) return `### Scorecard verification\n\n\`${ref}\`: ${result.commits} commit(s), no violations.\n`;
  const cell = (v) => (v.path ? `\`${v.path}\`` : (v.detail ? v.detail.replace(/[|\n]/g, ' ') : ''));
  const rows = result.violations.map((v) => `| ${v.commit ? `\`${v.commit.slice(0, 12)}\`` : '(history)'} | \`${v.rule}\` | ${cell(v)} |`);
  return `### Scorecard verification FAILED\n\n\`${ref}\`: ${result.violations.length} violation(s) across ${result.commits} commit(s).\n\n| Commit | Rule | Path or git error |\n|---|---|---|\n${rows.join('\n')}\n`;
}

/**
 * Run the verification.
 * @param {string[]} argv - Arguments
 * @param {object} [io] - `{stdout, stderr, env, verify}` seams
 * @returns {Promise<number>} Exit code
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const env = io.env || process.env;
  const opts = parseArgs(argv);
  if (!opts) {
    err.write('usage: scorecard-verify [--ref origin/metrics] [--repo <dir>]\n');
    return 2;
  }
  const result = await (io.verify || verifyHistory)({ repoDir: opts.repo, ref: opts.ref });
  out.write(`${JSON.stringify({ ref: opts.ref, ...result })}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(opts.ref, result));
  return result.violations.length === 0 ? 0 : 1;
}

module.exports = { main, parseArgs, summaryMarkdown };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
