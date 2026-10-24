'use strict';

const path = require('node:path');

/**
 * The home-directory folders macOS protects with TCC, named once (#880).
 *
 * A launchd-spawned node with no Full Disk Access gets no prompt and no EPERM
 * under these: a read simply never answers (#859). Every node-side place that
 * detects them or tells an operator about them reads this module, so the list
 * and the sentence that names it cannot drift apart. The browser gets the list
 * itself from the server, as `config.protectedRoots` (built by
 * `protectedRootsFor`). The copies that cannot import this module are prose
 * and shell: the wizard's caution in `public/setup.js`, the EACCES hint in
 * `public/api-helper.js`, and `deploy/install.sh`. `test/tcc-folders.test.js`
 * checks each against this list.
 *
 * Free of project dependencies on purpose (only `node:path`): `lib/uploads.js`,
 * `lib/project-facts.js` and the rest require it for a string, and must not
 * pull in anything to get one.
 *
 * @module lib/tcc-folders
 */

/**
 * The protected folders, as names under the home directory.
 * @type {ReadonlyArray<string>}
 */
const TCC_PROTECTED_FOLDERS = Object.freeze(['Documents', 'Desktop', 'Downloads']);

/**
 * The same folders as an operator reads them in a message.
 * @type {string}
 */
const TCC_PROTECTED_FOLDERS_PROSE = TCC_PROTECTED_FOLDERS
  .map((name) => `~/${name}`)
  .reduce((acc, item, i, all) => (i === 0 ? item : `${acc}${i === all.length - 1 ? ' and ' : ', '}${item}`), '');

/**
 * The protected roots as the wizard matches them: each folder in the `~/` form
 * an operator types and, when `home` is known, the absolute form it resolves
 * to. Shipping only one form leaves the other silently unmatched.
 * @param {string} [home] - The home directory, or empty when unknown
 * @returns {string[]}
 */
function protectedRootsFor(home) {
  const roots = [];
  for (const name of TCC_PROTECTED_FOLDERS) {
    roots.push(`~/${name}`);
    if (home) roots.push(path.join(home, name));
  }
  return roots;
}

/**
 * Whether a project path falls inside any TCC-protected folder.
 *
 * Uses a path-segment boundary so `~/DocumentsBackup` does not match
 * `~/Documents`: the check requires the path to equal the root exactly or
 * start with the root followed by the platform separator.
 * @param {string} projectPath - Absolute path to the project root
 * @param {string} home - The home directory
 * @returns {boolean}
 */
function projectPathIsProtected(projectPath, home) {
  if (!projectPath || !home) return false;
  for (const name of TCC_PROTECTED_FOLDERS) {
    const root = path.join(home, name);
    if (projectPath === root || projectPath.startsWith(root + path.sep)) return true;
  }
  return false;
}

module.exports = {
  TCC_PROTECTED_FOLDERS,
  TCC_PROTECTED_FOLDERS_PROSE,
  protectedRootsFor,
  projectPathIsProtected
};
