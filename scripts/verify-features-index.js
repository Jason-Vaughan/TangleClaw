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
 * `--base` has no default and is not optional (PR #2606 review, Finding
 * C2). `origin/main` at check time is the WRONG base for a real
 * `W<N>-REC` records PR: by the time that PR runs, the wave's own PRs
 * (which added the test files) have already merged into `main`, so a
 * diff against the current tip shows `FEATURES.md` changing but no test
 * file touched — a true records PR would always fail. The base a
 * `W<N>-REC` caller must pass is the WAVE'S OWN STARTING COMMIT (the
 * `Base main Head` `LANE_QUEUE` records for that wave, from before any of
 * its PRs merged): diffed from there, the wave's accumulated changes
 * include both the new `FEATURES.md` citation and the test file it
 * cites. `.github/workflows/test.yml`'s Records Gate already invokes
 * this script with the ordinary PR base (`github.event.pull_request.base.sha`),
 * which is correct for a single-wave records PR but is exactly the WRONG
 * base above for a consolidated multi-wave one — nothing wires that
 * wave-start lookup yet (same posture as `scripts/suite-evidence.js`'s ci
 * mode: it exists and is correct to invoke, but computing the right
 * argument for that specific case is the caller's job to build). Refusing
 * a missing `--base` rather than defaulting to `origin/main` keeps a
 * future wrong-base caller loud instead of silently passing bad records.
 *
 * A consolidated records PR has no single `--base` that makes every cited
 * test file "touched" even with the right base above — those files landed
 * through each wave's own code PRs, which merged before the records PR
 * even branched. For that case, when the WHOLE diff classifies as
 * docs/records-only (`scripts/docs-records-only-diff.js`'s roster — no
 * executable/test file touched), an otherwise-unproven citation is
 * accepted when the file is real: present on disk at `HEAD` and
 * containing an actual test registration, not merely a dangling claim.
 * Any diff that also touches an executable or test file keeps the
 * original strict "must be touched" requirement, unchanged. This is the
 * fallback the Records Gate's existing invocation benefits from directly.
 *
 * Usage: node scripts/verify-features-index.js --base <ref>
 *   --base <ref>  REQUIRED. For `W<N>-REC`, the wave's starting commit —
 *                 never `origin/main` at check time.
 * Exit 0 when every newly-added `Tests:` anchor names a touched file (or,
 * on a docs-only diff, a real file on disk), or none were added; 1
 * otherwise, naming each violation.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate: evaluateDocsOnly } = require('./docs-records-only-diff');

const ROOT = path.join(__dirname, '..');

/** A test registration call -- `it(`/`test(`, this repo's node:test convention. */
const TEST_CALL_RE = /\b(?:it|test)\s*\(/;

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
 * Whether `relPath` exists on disk at `HEAD`, repo-relative.
 *
 * @param {string} relPath
 * @param {{existsSync?: function(string): boolean}} [io] - Injection seam
 * @returns {boolean}
 */
function existsOnDisk(relPath, io = {}) {
  const exists = io.existsSync || fs.existsSync;
  return exists(path.join(ROOT, relPath));
}

/**
 * Whether `relPath`'s on-disk content contains a real test registration —
 * a lightweight sanity check that the citation names actual test code, not
 * a run of the suite.
 *
 * @param {string} relPath
 * @param {{readFileSync?: function(string, string): string}} [io] - Injection seam
 * @returns {boolean}
 */
function hasRealTests(relPath, io = {}) {
  const read = io.readFileSync || fs.readFileSync;
  let content;
  try {
    content = read(path.join(ROOT, relPath), 'utf8');
  } catch {
    return false;
  }
  return TEST_CALL_RE.test(content);
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
 * @throws {Error} When `--base` is missing or unrecognized argv is given — there is no safe
 *   default (see the module docstring: `origin/main` at check time is wrong for `W<N>-REC`)
 */
function parseArgs(argv) {
  const parsed = { base: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--base' && argv[i + 1]) { parsed.base = argv[++i]; continue; }
    throw new Error(`unknown or incomplete argument: ${flag}\nusage: verify-features-index.js --base <ref>`);
  }
  if (!parsed.base) {
    throw new Error('--base is required: there is no safe default. For W<N>-REC, pass the wave\'s own '
      + 'starting commit, never origin/main at check time (see the module docstring).\n'
      + 'usage: verify-features-index.js --base <ref>');
  }
  return parsed;
}

/**
 * Run the check end to end and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, git?: function(string[]): string,
 *   existsSync?: function(string): boolean, readFileSync?: function(string, string): string}} [io] - Injection seams
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
  let unproven = [...new Set(cited)].filter((f) => !touched.has(f));

  // A docs/records-only diff never touches the test files its citations
  // name (see module docstring) -- for that case only, fall back to an
  // on-disk reality check instead of diff membership. A diff that also
  // touches an executable/test file keeps the strict check below unchanged.
  if (unproven.length > 0 && evaluateDocsOnly([...touched]).ok) {
    unproven = unproven.filter((f) => !(existsOnDisk(f, io) && hasRealTests(f, io)));
  }

  if (unproven.length > 0) {
    out.write(`REFUSED: Tests: anchor(s) newly added to FEATURES.md cite a file this diff does not touch: ${unproven.join(', ')}\n`);
    return 1;
  }
  out.write(`${cited.length} newly added Tests: anchor(s), each naming a file this diff touches\n`);
  return 0;
}

module.exports = { testsCitedOn, touchedFiles, newlyCitedTests, existsOnDisk, hasRealTests, parseArgs, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
