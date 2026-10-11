#!/usr/bin/env node
'use strict';

// Hold this repository's tracked CLAUDE.md to what TangleClaw writes into it.
//
// The region between the BEGIN:tangleclaw / END:tangleclaw markers is generated:
// the server splices it on every launch of a session in this checkout. When the
// generator's output moves (a new `tc` verb, an edited guide under data/) and
// the tracked file does not move with it, every checkout shows an uncommitted
// CLAUDE.md from then on.
//
//   node scripts/sync-claude-md-block.js            compare; writes nothing; exit 1 on a difference
//   node scripts/sync-claude-md-block.js --write    replace the marked block, and nothing outside it
//   add --file <path> to act on another copy of the file
//
// The block is rendered for one named profile (PINNED_PROFILE below, with an
// install whose service-token gate is off and no injectable shared documents),
// because those settings live outside the repository and move the bytes. A
// checkout launched with other settings still shows a difference; that is the
// settings, not drift.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const store = require(path.join(REPO_DIR, 'lib', 'store'));
const engines = require(path.join(REPO_DIR, 'lib', 'engines'));
const managedBlock = require(path.join(REPO_DIR, 'lib', 'managed-block'));

const EXIT = Object.freeze({ OK: 0, DIFFERS: 1, USAGE: 2 });
const CARRIER = 'CLAUDE.md';
const SYNTAX = 'markdown';
const SYNC_COMMAND = 'node scripts/sync-claude-md-block.js --write';
// Characters shown on each side of the first difference in a failure message.
const DIFFERENCE_CONTEXT = 40;

/**
 * The per-project settings the tracked block stands for: switchboard on and the
 * PortHub guide on. No `id`, so no project's shared documents are looked up.
 */
const PINNED_PROFILE = Object.freeze({
  medusaEnabled: true,
  rules: Object.freeze({ core: Object.freeze({ porthubRegistration: true }) })
});

/**
 * The install-level half of the pinned profile, written to a scratch store so
 * the host's own config cannot reach the rendering.
 */
const PINNED_INSTALL_CONFIG = Object.freeze({ serviceTokenEnabled: false });

/**
 * Render the block the production generator writes for the pinned profile.
 *
 * Runs against a scratch store for the length of the call and puts the store's
 * base path back afterwards, so the result is the same on an operator's machine,
 * in a test and in CI. No project path is passed: the rendering is the
 * committed-carrier one, which is what a tracked CLAUDE.md gets.
 *
 * @param {object} [profile=PINNED_PROFILE] - Per-project config to render for.
 * @returns {string} The block body, before the splice trims and wraps it.
 */
function renderExpectedBlock(profile = PINNED_PROFILE) {
  const previous = store._getBasePath();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-claude-md-block-'));
  try {
    fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify(PINNED_INSTALL_CONFIG));
    store._setBasePath(scratch);
    return engines._generateOperationalBlock(profile, undefined, CARRIER);
  } finally {
    store._setBasePath(previous);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Where two blocks first part ways, for a message a person can act on.
 *
 * A generated line can run to hundreds of characters and differ by one word, so
 * each side is shown as a window around the first differing character.
 *
 * @param {string} tracked - The block in the file.
 * @param {string} generated - The block the generator writes.
 * @returns {string} One line naming the first differing line and what each holds there.
 */
function firstDifference(tracked, generated) {
  const a = tracked.trim().split('\n');
  const b = generated.trim().split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const left = a[i] === undefined ? '' : a[i];
    const right = b[i] === undefined ? '' : b[i];
    let col = 0;
    while (col < left.length && left[col] === right[col]) col++;
    const from = Math.max(0, col - DIFFERENCE_CONTEXT);
    const window = (line, present) => (present
      ? JSON.stringify(`${from > 0 ? '…' : ''}${line.slice(from, col + DIFFERENCE_CONTEXT)}${line.length > col + DIFFERENCE_CONTEXT ? '…' : ''}`)
      : '(no such line)');
    return `block line ${i + 1}: tracked ${window(left, a[i] !== undefined)}, generated ${window(right, b[i] !== undefined)}`;
  }
  return 'the blocks differ only in the whitespace around them';
}

/**
 * Compare a carrier's text with what a launch would write into it.
 *
 * Goes through the production splice, so "in sync" means exactly "a launch
 * would leave this file byte-identical". Reads only; the caller decides whether
 * anything is written.
 *
 * @param {string} text - The carrier's contents.
 * @param {string} [expectedBody] - The generated block body; rendered for the
 *   pinned profile when omitted.
 * @returns {{inSync: boolean, merged: (string|null), message: string}}
 *   `merged` is the text a sync would write, or null when the file has no
 *   single well-formed marker pair and so cannot be compared or synced.
 */
function compareCarrier(text, expectedBody = renderExpectedBlock()) {
  const markers = engines.managedBlockMarkers(SYNTAX);
  const outside = managedBlock.outsideManagedBlock(text, markers);
  if (outside === null) {
    return {
      inSync: false,
      merged: null,
      message: `${CARRIER} does not hold exactly one ${markers.begin} followed by one ${markers.end}; `
        + 'restore the markers by hand, this script will not guess where the block belongs'
    };
  }
  const { merged, error } = engines._mergeManagedBlock(text, expectedBody, SYNTAX);
  if (error) return { inSync: false, merged: null, message: `the generated block cannot be spliced: ${error}` };
  if (managedBlock.outsideManagedBlock(merged, markers) !== outside) {
    return { inSync: false, merged: null, message: 'the splice would change text outside the markers; nothing is written' };
  }
  if (merged === text) return { inSync: true, merged, message: `${CARRIER}: the tracked block is what the generator writes` };
  const tracked = managedBlock.extractManagedBlock(text, markers);
  const generated = managedBlock.extractManagedBlock(merged, markers);
  return {
    inSync: false,
    merged,
    message: `${CARRIER}: the block between the tangleclaw markers is not what the generator writes `
      + `(${firstDifference(tracked, generated)}). If the generator's output was changed on purpose, run \`${SYNC_COMMAND}\` `
      + 'and commit the result in the same change. Never edit between the markers by hand.'
  };
}

/**
 * Parse the command line.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{write: boolean, file: string, error: (string|null)}}
 */
function parseArgs(argv) {
  const out = { write: false, file: path.join(REPO_DIR, CARRIER), error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--file') {
      if (!argv[i + 1]) out.error = '--file needs a path';
      else out.file = path.resolve(argv[++i]);
    } else out.error = `unknown argument: ${a}`;
  }
  return out;
}

/**
 * Replace a file's contents atomically, so an interrupted write leaves the old
 * file and never half of the new one.
 * @param {string} file - Absolute path.
 * @param {string} text - New contents.
 * @returns {void}
 */
function writeAtomically(file, text) {
  const tmp = `${file}.sync-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Run the comparison, and the write when asked.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{log: function(string): void, error: function(string): void}} [io=console]
 * @returns {number} Exit code: 0 in sync (or synced), 1 differs or refused, 2 usage.
 */
function main(argv, io = console) {
  const args = parseArgs(argv);
  if (args.error) {
    io.error(`${args.error}\nusage: node scripts/sync-claude-md-block.js [--write] [--file <path>]`);
    return EXIT.USAGE;
  }
  let text;
  try {
    text = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    io.error(`cannot read ${args.file}: ${err.message}`);
    return EXIT.DIFFERS;
  }
  const result = compareCarrier(text);
  if (result.inSync) {
    io.log(result.message);
    return EXIT.OK;
  }
  if (!args.write || result.merged === null) {
    io.error(result.message);
    return EXIT.DIFFERS;
  }
  writeAtomically(args.file, result.merged);
  io.log(`${args.file}: the block between the tangleclaw markers was replaced; text outside them is unchanged. Commit it.`);
  return EXIT.OK;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  CARRIER,
  SYNC_COMMAND,
  PINNED_PROFILE,
  PINNED_INSTALL_CONFIG,
  renderExpectedBlock,
  compareCarrier,
  firstDifference,
  parseArgs,
  main
};
