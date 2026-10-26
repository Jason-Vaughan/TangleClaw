#!/usr/bin/env node
'use strict';

/**
 * Does a diff touch only docs/records/release-metadata paths?
 *
 * `.github/workflows/test.yml`'s Records Gate (Bottleneck A) and
 * `.github/workflows/release.yml`'s suite dedup (Bottleneck B) both need the
 * same yes/no: nothing in this diff could change what the suite's CODE paths
 * do, so a release/records PR can be certified by a narrower, faster run
 * instead of the full suite. This is the one place that question is answered,
 * so the roster of covered paths cannot drift between a workflow step and
 * whatever the next one copies from it.
 *
 * The roster reuses `lib/wrap-steps/changelog-coverage.js`'s glob grammar
 * (`_globToRegExp`) rather than inventing a second one: `**` crosses segments,
 * a literal dot is escaped, every other character is literal.
 *
 * Usage: node scripts/docs-records-only-diff.js --base <ref> [--head <ref>] [--repo <dir>]
 *   --base <ref>   required; the ref this diff is against (a PR's merge base)
 *   --head <ref>   default `HEAD`
 *   --repo <dir>   default the current working directory
 * Prints `docs-only: yes` or `docs-only: no` (naming the first non-matching
 * path) on stdout, and appends `docs_only=true`/`docs_only=false` to
 * `$GITHUB_OUTPUT` when that is set. Exit 0 whenever the diff was read,
 * whichever way it answers — the yes/no IS the answer, not a pass/fail gate.
 * Exit 1 only on a usage or git error, where no answer could be read at all.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { _globToRegExp } = require('../lib/wrap-steps/changelog-coverage');

const GIT_TIMEOUT_MS = 30000;

/**
 * Paths a diff may touch and still be "docs/records/release-metadata only".
 * Matched with {@link _globToRegExp} against each changed path, repo-relative.
 */
const DOCS_RECORDS_GLOBS = Object.freeze([
  'FEATURES.md',
  'CHANGELOG.md',
  'changelog.d/**',
  '.prawduct/**',
  'docs/**',
  'README.md',
  'version.json',
  'test/fixtures/changelog-released-sections.lock.json'
]);

/**
 * Run git in one working folder, tolerating no failure.
 *
 * @param {string[]} args - git's arguments
 * @param {string} repo - Working directory
 * @returns {string} stdout with no trailing newline
 * @throws {Error} When git could not run or exited non-zero
 */
function git(args, repo) {
  const run = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024
  });
  if (run.error || run.status !== 0) {
    const detail = (run.error && run.error.message) || run.stderr || `exit ${run.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail.trim()}`);
  }
  return run.stdout.replace(/\n$/, '');
}

/**
 * Whether every changed path matches at least one of {@link DOCS_RECORDS_GLOBS}.
 *
 * @param {string[]} changedPaths - Repo-relative paths, as `git diff --name-only` names them
 * @returns {{ok: boolean, offender: string|null}} `offender` is the first path
 *   that matched no glob, or null when every path matched (including the empty diff)
 */
function evaluate(changedPaths) {
  const matchers = DOCS_RECORDS_GLOBS.map(_globToRegExp);
  const offender = changedPaths.find((p) => !matchers.some((re) => re.test(p))) || null;
  return { ok: offender === null, offender };
}

/**
 * Parse argv into options.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string, head: string, repo: string}}
 * @throws {Error} On an unrecognized flag, a missing value, or a missing `--base`
 */
function parseArgs(argv) {
  const opts = { base: null, head: 'HEAD', repo: process.cwd() };
  const takesValue = { '--base': 'base', '--head': 'head', '--repo': 'repo' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    opts[key] = value;
    i += 1;
  }
  if (!opts.base) throw new Error('--base is required: this answer is relational, there is no diff without one');
  return opts;
}

/**
 * Resolve the diff from git and report the verdict.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {Object<string, string|undefined>} [env] - Injection seam for `GITHUB_OUTPUT`
 * @returns {number} Process exit code
 */
function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`docs-records-only-diff: ${err.message}\n`);
    return 1;
  }
  let verdict;
  try {
    const mergeBase = git(['merge-base', opts.base, opts.head], opts.repo);
    const changedPaths = git(['diff', '-z', '--name-only', mergeBase, opts.head], opts.repo)
      .split('\0')
      .filter(Boolean);
    verdict = evaluate(changedPaths);
  } catch (err) {
    process.stderr.write(`docs-records-only-diff: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(verdict.ok
    ? 'docs-only: yes\n'
    : `docs-only: no — ${verdict.offender} is outside the docs/records/release-metadata roster\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `docs_only=${verdict.ok}\n`);
  return 0;
}

module.exports = { evaluate, parseArgs, main, DOCS_RECORDS_GLOBS };

// See `scripts/cache-bump-guard.js` for why this is `process.exitCode`, not
// `process.exit()`: a piped stdout under CI is asynchronous, and `exit()`
// would race the write that names the offending path.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
