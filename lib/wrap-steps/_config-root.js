'use strict';

/**
 * Where a wrap step reads and writes project config.
 *
 * A wrap can work on a git worktree the session moved into, while the project's
 * config (`.tangleclaw/project.json`) and wrap state (`.tangleclaw/state.json`,
 * the `lastWrapSha` boundary) may exist only in the registered checkout (#1469).
 * The runner therefore hands steps a project whose `path` is the work tree and
 * whose `configPath` is the registered checkout. Reading config from `path` would
 * find no file in a worktree, load the defaults, and silently change what the
 * wrap does.
 *
 * `test/wrap-session-scope.test.js` ("wrap steps read project config from the registered checkout") fails when a step reads config any other way.
 *
 * @param {object} project - A project record. A record that never passed through
 *   the runner (a unit harness, a direct call) has no `configPath`, and its
 *   `path` is the registered checkout.
 * @returns {string} Absolute path of the directory holding `.tangleclaw/project.json`.
 */
function configRootOf(project) {
  return (project && project.configPath) || (project && project.path);
}

module.exports = { configRootOf };
