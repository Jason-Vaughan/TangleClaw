'use strict';

/**
 * Test helper: initialise a throwaway git repository that reads nothing from
 * this machine.
 *
 * ## Why this exists
 *
 * A bare `git init` honours the global `init.templateDir`. On a developer
 * machine that is `~/.tangleclaw/git-template` — a directory TangleClaw itself
 * rewrites (`lib/git-template.js`, from `server.js` and `lib/projects.js`).
 * When the running server regenerates it while a test's `git init` is copying
 * from it, the copy fails mid-way and the test errors in its `beforeEach` with
 * a message about a hook file that "does not exist" (#831). The suite was
 * non-deterministic on every machine where TangleClaw was running — which is
 * every developer machine and the one that produces release evidence — and the
 * failure looked like a flake in an unrelated subsystem.
 *
 * ## Why one helper and not ten `--template=` flags
 *
 * Ten call sites each carrying the flag drift: the next test that shells out
 * to `git init` forgets it, and the flake is back with no signal. So the suite
 * has exactly one way to make a repository, here, and `test/temp-repo.test.js`
 * scans `test/` and fails on any other `git init` invocation. Joining the
 * family means calling `initRepo`; the guard is what makes that a rule rather
 * than a convention.
 *
 * The one sanctioned exception is `test/git-template.test.js`'s end-to-end
 * case, which exists to prove the template mechanism works and sandboxes its
 * own global config to do so.
 */

const { execFileSync } = require('node:child_process');

/**
 * Run `git init` in `dir` with template inheritance disabled.
 *
 * `--template=` (empty) tells git to copy no template at all, which outranks
 * both the `init.templateDir` config and the `GIT_TEMPLATE_DIR` environment
 * variable — so the result is the same on a machine with TangleClaw running,
 * on a CI runner, and on a machine with no template configured.
 *
 * @param {string} dir - Existing directory to initialise. Not created here: the
 *   caller owns the directory's lifetime, this owns only the `git init`.
 * @param {string[]} [extraArgs=[]] - Further `git init` arguments, e.g.
 *   `['-b', 'main']` or `['--bare']`, appended after the isolation flags.
 * @param {object} [execOpts={}] - Extra `execFileSync` options merged over the
 *   defaults (`cwd: dir`, piped stdio). `env` is the usual reason: a test that
 *   sandboxes its own global git config passes it here.
 * @returns {string} `dir`, for chaining.
 */
function initRepo(dir, extraArgs = [], execOpts = {}) {
  execFileSync('git', ['init', '--template=', '-q', ...extraArgs], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...execOpts
  });
  return dir;
}

module.exports = { initRepo };
