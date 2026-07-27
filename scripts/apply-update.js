#!/usr/bin/env node
'use strict';

// Apply the latest TangleClaw release through the guarded self-updater.
//
//   node scripts/apply-update.js
//
// This is the command-line face of `lib/update-applier.js` — the SAME code the
// dashboard's "Update & restart" button runs, so both paths share one set of
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
// failure — both mean "nothing moved, read the JSON and report it").

const path = require('node:path');
const updateApplier = require('../lib/update-applier');
const logger = require('../lib/logger');
// Only for the base path, so the log dir has one derivation rather than a
// second copy that drifts. Requiring the store is inert: `init()` is exported,
// never invoked at module load, so nothing here opens the database or runs a
// migration — which matters, because a process that migrates the live DB as a
// side effect of being started is a failure this project has already had once.
const store = require('../lib/store');

/**
 * Run the guarded update and report it.
 *
 * Seams are parameters so this is exercisable without mutating a real checkout —
 * a test that had to spawn the script for coverage would be running `git
 * checkout` against the developer's own tree, which is exactly the class of
 * accident this script exists to prevent.
 *
 * @param {{applyUpdate: function}} [applier] - Update applier (tests)
 * @param {{write: function}} [out] - Output stream (tests)
 * @returns {number} Process exit code — 0 applied, 1 refused or failed.
 */
function main(applier = updateApplier, out = process.stdout) {
  const result = applier.applyUpdate();
  out.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  logger.setConsoleStream(process.stderr);
  try {
    logger.initFileLogging(path.join(store._getBasePath(), 'logs'));
  } catch (err) {
    // An unwritable log directory must not stop an update — the result still
    // reaches stdout and stderr. Say so rather than failing silently.
    process.stderr.write(`[apply-update] file logging unavailable: ${err.message}\n`);
  }
  // Not process.exit(): stdout is asynchronous when piped — which is exactly
  // how a caller parsing this JSON invokes it — and exiting can truncate the
  // payload mid-write. Setting the code lets node flush and exit on its own.
  process.exitCode = main();
}

module.exports = { main };
