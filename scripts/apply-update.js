#!/usr/bin/env node
'use strict';

// Apply the latest TangleClaw release through the guarded self-updater.
//
//   node scripts/apply-update.js [--discard-tc-files]
//   node scripts/apply-update.js --help
//
// The update runs only for an invocation this script recognizes in full: no
// arguments, or `--discard-tc-files`. `--help` and `-h` print usage and stop.
// Anything else is refused, because an argument this script does not know is
// evidence the caller expects something other than what would happen — most
// often a request for help, which is the worst moment to move the checkout.
//
// This is the command-line face of `lib/update-applier.js` — the SAME code the
// beacon's "Update now" button runs, so both paths share one set of
// safety guards and one definition of what "updated" means (detached at the
// latest release tag).
//
// It exists because the other way to reach an update from a terminal is raw
// git, and raw git is what the guards are protecting against: `git pull origin
// main` merges into whatever branch is checked out, ships unreleased commits,
// and leaves an install detached at a non-tag commit that the applier then
// refuses to update again (#730). Handing an agent this script instead of git
// commands means an update it drives is bound by the same rules as one the
// operator clicks.
//
// Deliberately does NOT restart the server: the applier stages the new code and
// the restart is a separate, visible act — a restart drops the dashboard and the
// API for everyone attached, so it stays the caller's decision (matching the
// route, which also leaves the restart to its client).
//
// stdout carries ONLY the applier's verbatim result object — the stable `code`
// on a refusal, `fromSha` for one-line recovery — so a caller can parse it
// whole. The applier logs on every terminal path, and the logger's default
// routing puts anything below ERROR on stdout, which would put a log line in
// front of the payload precisely in the refusal case a caller most needs to
// read; console output is therefore pinned to stderr for the life of this
// process. The refusal still reaches `~/.tangleclaw/logs/` — a git mutation
// driven by an agent deserves the same server-side trail as one driven by the
// HTTP route, which gets it only because the server initializes file logging.
//
// Exit 0 when the update was applied, 1 when it was not (guard refusal or git
// failure — both mean "nothing moved, read the JSON and report it"). `--help`
// also exits 0, with usage on stdout instead of a result object. Exit 2 is a
// usage error: the applier was never called, stdout is empty, and the reason is
// on stderr. It is a separate exit code rather than a refusal `code` in the
// JSON so that 1 keeps meaning "the applier answered" and the applier's codes
// stay the complete list a caller has to know.

const path = require('node:path');
const updateApplier = require('../lib/update-applier');
const logger = require('../lib/logger');
// Only for the base path, so the log dir has one derivation rather than a
// second copy that drifts. Requiring the store is inert: `init()` is exported,
// never invoked at module load, so nothing here opens the database or runs a
// migration — which matters, because a process that migrates the live DB as a
// side effect of being started is a failure this project has already had once.
const store = require('../lib/store');

const USAGE =
  'Usage: node scripts/apply-update.js [--discard-tc-files]\n' +
  '       node scripts/apply-update.js --help\n' +
  '\n' +
  '  Applies the latest TangleClaw release to this checkout through the guarded\n' +
  '  updater, the same one the dashboard\'s "Update now" button runs. With no\n' +
  '  arguments it runs the update. It does not restart the server.\n' +
  '\n' +
  'Options:\n' +
  '  --discard-tc-files  Also discard TangleClaw-written files that block the\n' +
  '                      update. Honored only when no other work is uncommitted.\n' +
  '  -h, --help          Print this text and exit. Nothing is changed.\n' +
  '\n' +
  'Exit codes:\n' +
  '  0  The update was applied (or this text was requested).\n' +
  '  1  The update was refused or failed. Nothing moved; the JSON on stdout\n' +
  '     says why.\n' +
  '  2  An argument was not recognized. Nothing was run.\n';

/**
 * Sort CLI arguments into the ones this script knows and the ones it does not.
 * Pure, so the decision is testable without a process.
 *
 * Matching is exact. `--discard-tc-file` or `--discard-tc-files=true` lands in
 * `unknown` rather than being read as the nearest flag: guessing either way
 * runs a different update from the one the operator asked for.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{discardDirty: boolean, help: boolean, unknown: string[]}}
 */
function parseArgs(argv) {
  const result = { discardDirty: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--discard-tc-files') result.discardDirty = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else result.unknown.push(arg);
  }
  return result;
}

/**
 * Whether these arguments are an invocation that runs the update.
 *
 * `main` and the entry point both ask this, so the set of invocations that
 * reach the applier and the set that open the server-side log are one set.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {boolean} False for a help request or any unrecognized argument.
 */
function runsApplier(argv) {
  const args = parseArgs(argv);
  return !args.help && args.unknown.length === 0;
}

/**
 * Run the guarded update and report it — or, for a help request or an argument
 * this script does not recognize, print usage and run nothing.
 *
 * Seams are parameters so this is exercisable without mutating a real checkout —
 * a test that had to spawn the script for coverage would be running `git
 * checkout` against the developer's own tree, which is exactly the class of
 * accident this script exists to prevent.
 *
 * @param {{applyUpdate: function}} [applier] - Update applier (tests)
 * @param {{write: function}} [out] - Output stream (tests)
 * @param {string[]} [argv] - CLI args (tests). `--discard-tc-files` opts into
 *   discarding TangleClaw-written files that block the update — honored by the
 *   applier only when NO real work is dirty, so the flag can never cost an
 *   operator their edits. It is the flagged, deliberate form of the dashboard's
 *   confirm dialog; agents must not pass it without the operator's say-so.
 *   Help wins over everything else on the line; any unrecognized argument
 *   refuses the whole invocation, recognized flags beside it included.
 * @param {{write: function}} [err] - Diagnostics stream (tests). Carries the
 *   usage error; `out` stays empty then, so a caller parsing stdout never
 *   meets prose where it was promised a result object.
 * @returns {number} Process exit code — 0 applied or help shown, 1 refused or
 *   failed, 2 unrecognized argument.
 */
function main(applier = updateApplier, out = process.stdout, argv = process.argv.slice(2), err = process.stderr) {
  const args = parseArgs(argv);
  if (args.help) {
    out.write(USAGE);
    return 0;
  }
  if (!runsApplier(argv)) {
    // Quoted, so an empty or whitespace argument is visible in the message.
    const named = args.unknown.map((arg) => JSON.stringify(arg)).join(', ');
    const noun = args.unknown.length === 1 ? 'argument' : 'arguments';
    err.write(`apply-update: unrecognized ${noun} ${named}. Nothing was run and nothing changed.\n\n${USAGE}`);
    return 2;
  }
  const result = applier.applyUpdate({ discardDirty: args.discardDirty });
  out.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

/**
 * Point the logger at this process's outputs before any update runs.
 *
 * Extracted from the `require.main` block so it is *executed* by a test rather
 * than pattern-matched in source. It is not spawn-tested deliberately: running
 * the real script would call `applyUpdate()` for real, and on a clean checkout
 * of `main` with a newer release available that performs an actual update —
 * a test suite that can silently move the developer's checkout is precisely
 * the accident this script exists to prevent.
 *
 * @param {object} [deps]
 * @param {object} [deps.loggerLib] - Logger module (tests)
 * @param {object} [deps.storeLib] - Store module, for the base path (tests)
 * @param {{write: function}} [deps.stderr] - Diagnostics stream (tests)
 * @returns {boolean} Whether file logging was initialized.
 */
function configureProcessLogging(deps = {}) {
  const loggerLib = deps.loggerLib || logger;
  const storeLib = deps.storeLib || store;
  const stderr = deps.stderr || process.stderr;

  loggerLib.setConsoleStream(stderr);
  try {
    // rotate: false — the server holds an open fd on this same file, and
    // rotating from a short-lived process would rename the log out from under
    // it, leaving it writing to `.log.1` unnoticed until its next restart.
    loggerLib.initFileLogging(path.join(storeLib._getBasePath(), 'logs'), { rotate: false });
    return true;
  } catch (err) {
    // An unwritable log directory must not stop an update — the result still
    // reaches stdout and stderr. Say so rather than failing silently.
    stderr.write(`[apply-update] file logging unavailable: ${err.message}\n`);
    return false;
  }
}

if (require.main === module) {
  // A help request or a usage error opens nothing: the log directory is the
  // live install's, and neither of those is an update to leave a trail for.
  if (runsApplier(process.argv.slice(2))) configureProcessLogging();
  // Not process.exit(): stdout is asynchronous when piped — which is exactly
  // how a caller parsing this JSON invokes it — and exiting can truncate the
  // payload mid-write. Setting the code lets node flush and exit on its own.
  process.exitCode = main();
}

module.exports = { main, configureProcessLogging, parseArgs, runsApplier, USAGE };
