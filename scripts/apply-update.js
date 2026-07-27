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
// Output is JSON on stdout — the applier's verbatim result object, including
// the stable `code` on a refusal and `fromSha` for one-line recovery.
// Exit 0 when the update was applied, 1 when it was not (guard refusal or git
// failure — both mean "nothing moved, read the JSON and report it").

const updateApplier = require('../lib/update-applier');

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

if (require.main === module) process.exit(main());

module.exports = { main };
