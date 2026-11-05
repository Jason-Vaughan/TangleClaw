#!/usr/bin/env node
'use strict';

/**
 * Docs/screenshot parity signal CLI (#533). Same mechanics as
 * `scripts/changelog-fragment-gate.js` — read a PR's changed files and
 * body, judge them, print the verdict — but this one never fails CI: #533's
 * acceptance is explicit that the signal is non-blocking and
 * dismissible-with-reason. Exit 0 whenever the input could be read and
 * judged, whatever the verdict says; exit 4 only when it could not be
 * measured at all.
 *
 * Usage: node scripts/docs-parity-gate.js --pr <number>
 *        node scripts/docs-parity-gate.js --files <path> --body-file <path>
 *   --pr <number>        read the PR's changed files via
 *                         `gh api repos/{owner}/{repo}/pulls/<number>/files
 *                         --paginate`, and the body via
 *                         `gh api repos/{owner}/{repo}/pulls/<number>`
 *   --files <path>        test seam: a JSON file holding an array of changed paths
 *   --body-file <path>    test seam: a file holding the PR body text
 * Exit 0: judged, signal fired or not (the printed line says which).
 * Exit 4: could not measure: the file list or the body could not be read.
 */

const fs = require('node:fs');

const { execFileArgs, describeFailure } = require('../lib/exec');
const { evaluate } = require('../lib/docs-parity-gate');

/** A failure that could not be judged at all — distinct from any verdict. */
class Unreadable extends Error {}

/**
 * Read one JSON document from `gh api`.
 * @param {string[]} apiArgs - Arguments after `gh api`.
 * @returns {Promise<*>} The parsed JSON.
 * @throws {Unreadable} When `gh` fails or answers with something unparseable.
 */
async function _ghApi(apiArgs) {
  const r = await execFileArgs('gh', ['api', ...apiArgs], { timeoutMs: 15000, maxBufferBytes: 8 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Unreadable(describeFailure(r, `gh api ${apiArgs[0]}`));
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new Unreadable(`gh answered with something that is not JSON: ${err.message}`);
  }
}

/**
 * Read the PR's changed files and body through `gh api`.
 * @param {string} prNumber - Pull request number.
 * @returns {Promise<{files: string[], body: string}>}
 * @throws {Unreadable} When `gh` fails or answers with something unparseable.
 */
async function readFromGh(prNumber) {
  const filesJson = await _ghApi([`repos/{owner}/{repo}/pulls/${prNumber}/files`, '--paginate']);
  const files = Array.isArray(filesJson)
    ? filesJson.filter((f) => f && typeof f.filename === 'string').map((f) => f.filename)
    : null;
  if (files === null) throw new Unreadable('gh\'s answer carried no readable files list');

  const pr = await _ghApi([`repos/{owner}/{repo}/pulls/${prNumber}`]);
  if (pr.body !== null && typeof pr.body !== 'string') throw new Unreadable('gh\'s answer carried no readable `body`');
  return { files, body: pr.body === null ? '' : pr.body };
}

/**
 * Read the files list and body from the test seam's two files.
 * @param {string} filesPath - A JSON file holding an array of changed paths.
 * @param {string} bodyFilePath - A file holding the PR body text.
 * @returns {{files: string[], body: string}}
 * @throws {Unreadable} When either file is unreadable or the files JSON is not an array of strings.
 */
function readFromFiles(filesPath, bodyFilePath) {
  let files;
  try {
    files = JSON.parse(fs.readFileSync(filesPath, 'utf8'));
  } catch (err) {
    throw new Unreadable(`could not read --files ${filesPath}: ${err.message}`);
  }
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
    throw new Unreadable(`--files ${filesPath} must hold a JSON array of strings`);
  }
  let body;
  try {
    body = fs.readFileSync(bodyFilePath, 'utf8');
  } catch (err) {
    throw new Unreadable(`could not read --body-file ${bodyFilePath}: ${err.message}`);
  }
  return { files, body };
}

/**
 * Parse argv into options.
 * @param {string[]} argv - Arguments.
 * @returns {{pr: string|null, filesPath: string|null, bodyFilePath: string|null}}
 * @throws {Error} On an unrecognized flag, a missing value, or an incomplete combination.
 */
function parseArgs(argv) {
  const opts = { pr: null, filesPath: null, bodyFilePath: null };
  const takesValue = { '--pr': 'pr', '--files': 'filesPath', '--body-file': 'bodyFilePath' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = argv[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    opts[key] = value;
    i += 1;
  }
  const hasPr = opts.pr !== null;
  const hasFiles = opts.filesPath !== null || opts.bodyFilePath !== null;
  if (hasPr === hasFiles || (hasFiles && (opts.filesPath === null || opts.bodyFilePath === null))) {
    throw new Error('pass exactly one of --pr <number>, or both --files <path> and --body-file <path>');
  }
  return opts;
}

/**
 * CLI entry point.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`docs-parity-gate: ${err.message}\n`);
    return 4;
  }
  let input;
  try {
    input = opts.pr !== null ? await readFromGh(opts.pr) : readFromFiles(opts.filesPath, opts.bodyFilePath);
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    process.stderr.write(`docs-parity-gate: could not measure — ${err.message}\n`);
    return 4;
  }
  const verdict = evaluate(input.files, input.body);
  process.stdout.write(`docs-parity-gate: ${verdict.signal ? 'signal' : 'clear'} (non-blocking) — ${verdict.reason}\n`);
  if (verdict.signal && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n**docs-parity-gate**: user-facing surface changed with no docs touch. Not blocking — `
      + `add a \`Docs: none <reason>\` line to the PR body if this is intentional.\n\n`
      + `- user-facing: ${verdict.userFacingFiles.concat(verdict.userFacingFragments.map((f) => f.path)).join(', ') || '(none)'}\n`);
  }
  return 0;
}

module.exports = { readFromGh, readFromFiles, parseArgs, main, Unreadable };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
