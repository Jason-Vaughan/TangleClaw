#!/usr/bin/env node
'use strict';

/**
 * Wave-diff `Tests:` anchor check (#2597 deliverable 2).
 *
 * A `W<N>-REC` records PR adds entries to `FEATURES.md` citing the wave's
 * new tests via a trailing `Tests: \`a.test.js\`, \`b.test.js\`.` clause.
 * `test/features-index.test.js` already holds every such anchor to
 * existing on disk and grepping its symbol, unconditionally — but nothing
 * before this held it to being the WAVE'S OWN test: a records PR could
 * cite pre-existing coverage as if it proved the wave's new work. This
 * script adds that one check: every `Tests:` anchor newly ADDED to
 * `FEATURES.md` by the diff against `--base` must name a file the SAME
 * diff touches.
 *
 * Only `+` lines of `FEATURES.md`'s own diff hunk count as "newly added" —
 * a context line or a line the diff removes is not a new claim, so a PR is
 * never held to re-touching every test file `FEATURES.md` has ever cited,
 * only the ones its own new entries claim.
 *
 * Usage: node scripts/verify-features-index.js [--base <ref>]
 *   --base <ref>  what the diff is against (default `origin/main`)
 * Exit 0 when every newly-added `Tests:` anchor names a touched file, or
 * none were added; 1 otherwise, naming each violation.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** One `Tests:` clause's backtick-quoted file list. */
const TESTS_CLAUSE_RE = /Tests:\s*((?:`[^`]+`,?\s*)+)\.?/g;
const QUOTED_PATH_RE = /`([^`]+)`/g;

/**
 * The test files a `Tests:` clause on one added line cites.
 *
 * @param {string} addedLine - A line from the diff's `+` side, leading `+` already stripped
 * @returns {string[]} The cited paths, possibly empty
 */
function testsCitedOn(addedLine) {
  const out = [];
  TESTS_CLAUSE_RE.lastIndex = 0;
  let clauseMatch;
  while ((clauseMatch = TESTS_CLAUSE_RE.exec(addedLine)) !== null) {
    QUOTED_PATH_RE.lastIndex = 0;
    let pathMatch;
    while ((pathMatch = QUOTED_PATH_RE.exec(clauseMatch[1])) !== null) out.push(pathMatch[1]);
  }
  return out;
}

/**
 * Run git in the repository.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Every file the diff against `base` touches, repo-relative.
 *
 * @param {string} base - The ref to diff against
 * @param {{git?: function(string[]): string}} [io] - Injection seam
 * @returns {Set<string>}
 */
function touchedFiles(base, io = {}) {
  const run = io.git || git;
  return new Set(run(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean));
}

/**
 * Every test file newly cited by a `Tests:` clause added to `FEATURES.md`
 * in the diff against `base`.
 *
 * @param {string} base - The ref to diff against
 * @param {{git?: function(string[]): string}} [io] - Injection seam
 * @returns {string[]}
 */
function newlyCitedTests(base, io = {}) {
  const run = io.git || git;
  const diff = run(['diff', `${base}...HEAD`, '--', 'FEATURES.md']);
  const out = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    out.push(...testsCitedOn(line.slice(1)));
  }
  return out;
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string}}
 */
function parseArgs(argv) {
  const parsed = { base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--base' && argv[i + 1]) { parsed.base = argv[++i]; continue; }
    throw new Error(`unknown or incomplete argument: ${flag}\nusage: verify-features-index.js [--base <ref>]`);
  }
  return parsed;
}

/**
 * Run the check end to end and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, git?: function(string[]): string}} [io] - Injection seams
 * @returns {number} The exit code
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  const cited = newlyCitedTests(parsed.base, io);
  if (cited.length === 0) {
    out.write('no Tests: anchors were newly added to FEATURES.md in this diff\n');
    return 0;
  }
  const touched = touchedFiles(parsed.base, io);
  const unproven = [...new Set(cited)].filter((f) => !touched.has(f));
  if (unproven.length > 0) {
    out.write(`REFUSED: Tests: anchor(s) newly added to FEATURES.md cite a file this diff does not touch: ${unproven.join(', ')}\n`);
    return 1;
  }
  out.write(`${cited.length} newly added Tests: anchor(s), each naming a file this diff touches\n`);
  return 0;
}

module.exports = { testsCitedOn, touchedFiles, newlyCitedTests, parseArgs, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
