'use strict';

/**
 * Where TangleClaw's own machine-state files live inside a managed project,
 * repo-root-relative with forward slashes.
 *
 * The module that writes each file and the wrap's ownership check both read the
 * name from here. With the name written in two places, a rename at the writer
 * left the wrap asking the operator about the renamed file on every wrap, with
 * every test still green.
 */

/** The prime text a silent-prime launch hands the session hook. */
const SESSION_PRIME_RELPATH = '.tangleclaw/session-prime.md';

/** The UI wrap capability note written beside the engine config on every sync. */
const UI_WRAP_ADVISORY_RELPATH = '.tangleclaw/ui-wrap-advisory.md';

/** The switchboard workspace-id registry. */
const MEDUSA_REGISTRY_RELPATH = '.tangleclaw/medusa/registry.json';

/**
 * An absolute path for one of the relpaths above.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {string} relPath - One of this module's relpaths.
 * @returns {string}
 */
function resolveIn(projectPath, relPath) {
  return require('node:path').join(projectPath, ...relPath.split('/'));
}

module.exports = {
  SESSION_PRIME_RELPATH,
  UI_WRAP_ADVISORY_RELPATH,
  MEDUSA_REGISTRY_RELPATH,
  resolveIn
};
