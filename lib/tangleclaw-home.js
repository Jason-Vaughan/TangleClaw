'use strict';

/**
 * The one derivation of TangleClaw's base directory.
 *
 * Every piece of machine-local TangleClaw state — the database, `config.json`,
 * engine profiles, orchestration profiles, logs, the PID file, master state,
 * the git template, the ttyd attach script — lives under one directory. Where
 * that directory *is* was previously answered independently at each of those
 * sites, half of them from `process.env.HOME` and half from `os.homedir()`.
 *
 * **Why that is a bug and not just duplication.** The two sources do not agree
 * in every environment, and the disagreement is silent. `os.homedir()` prefers
 * `$HOME` when it is set and falls back to the passwd entry when it is not;
 * `process.env.HOME || ''` has no fallback. So a process launched WITHOUT
 * `HOME` — a `sudo` invocation, or a launchd job whose plist does not set it —
 * resolved the passwd home at one site and the empty string at another. The
 * empty one did not fail: `path.join('', '.tangleclaw')` drops the zero-length
 * segment and yields the RELATIVE `.tangleclaw`, so the store created its
 * database under the process's working directory — for the launchd job, inside
 * the operator's own checkout — while master state and git templates kept
 * writing to the real home. That is the shape worth naming: not a refused write
 * at an implausible path, but a silent one at a plausible one, leaving the
 * install half relocated and looking like it worked.
 *
 * **The supported override is `TANGLECLAW_HOME`, and it names the BASE
 * DIRECTORY, not a home directory.** Setting it to `/tmp/tc-test` puts the
 * database at `/tmp/tc-test/tangleclaw.db` — there is no `.tangleclaw` segment
 * appended, because the variable already names the thing. It exists so a second
 * install can be rehearsed on one machine without inventing a mechanism; an
 * earlier attempt assumed exactly this variable, found it unread, fell back to
 * overriding `HOME`, and migrated the live database (2026-07-20).
 *
 * **What the override does NOT relocate**, and must be said plainly because a
 * partial sandbox is the failure this module exists to prevent: the launchd
 * plist under `~/Library/LaunchAgents` (launchd reads a fixed per-user
 * location), the Caddy site label, and the ingress ports. A second concurrent
 * install on one machine is therefore still unsafe — this makes its *state*
 * separable, not its *ingress*.
 *
 * **Which of the two accessors to read.** `baseDir()` here is the DERIVATION —
 * where this install's state belongs. `store._getBasePath()` is the LIVE value,
 * seeded from this one at load and relocatable by `store._setBasePath()`, which
 * dozens of tests use. They agree in production and diverge under that seam, so
 * the rule is: a module that owns a piece of state under the base directory
 * reads `baseDir()`; a module acting on the store's own footprint — its logs,
 * its result files, anything a test redirecting the store must see redirected —
 * reads `store._getBasePath()`. When in doubt, ask whether a test that moved the
 * store should move you too.
 *
 * Deliberately a leaf module: node built-ins only, no project requires, so the
 * store, the PID file writer and `lib/wrap-steps/*` can all pull it in at
 * module top without entering a require cycle.
 *
 * @module lib/tangleclaw-home
 */

const os = require('node:os');
const path = require('node:path');

/**
 * Environment variable naming the base directory outright.
 * @type {string}
 */
const HOME_ENV = 'TANGLECLAW_HOME';

/**
 * Directory name TangleClaw's state lives under, inside the user's home.
 * @type {string}
 */
const BASE_DIRNAME = '.tangleclaw';

/**
 * The user's home directory, from the one source the whole codebase uses.
 *
 * `os.homedir()` rather than `process.env.HOME`: it consults `$HOME` first and
 * falls back to the passwd entry, so it is a superset of the env read and
 * answers correctly in the HOME-less environments where the two used to
 * disagree. The env read stays as a last resort for a platform where
 * `os.homedir()` yields nothing.
 *
 * @returns {string} Absolute home directory, or `''` when none can be resolved.
 */
function userHome() {
  return os.homedir() || process.env.HOME || '';
}

/**
 * TangleClaw's base directory — the root of all machine-local state.
 *
 * Read at call time — but that is a property of THIS FUNCTION, not a guarantee
 * about the install. `lib/store.js` captures its value at require time (its
 * relocatable copy is then owned by `_setBasePath`), so **`TANGLECLAW_HOME` must
 * be set before any TangleClaw module loads**; setting it later moves the sites
 * that re-derive per call and leaves the store where it was, which is the same
 * half-relocation this module exists to prevent, shifted from which source to
 * which moment. Every other consumer re-derives on use.
 *
 * Throws rather than composing a default when no home can be resolved: with an
 * empty home `path.join` drops the zero-length segment and yields a RELATIVE
 * `.tangleclaw`, and the store would then seed a config and open an empty
 * database under the process's working directory and report a healthy boot.
 * A boundary that could not be established has to say so
 * (`architecture.md`'s Direction), and this is the one place that can.
 *
 * @returns {string} Absolute path. `<home>/.tangleclaw`, or `TANGLECLAW_HOME`
 *   verbatim (resolved to absolute) when that is set to a non-blank value.
 * @throws {Error} When no home directory resolves and no override is set.
 */
function baseDir() {
  const override = typeof process.env[HOME_ENV] === 'string' ? process.env[HOME_ENV].trim() : '';
  if (override !== '') return path.resolve(override);

  const home = userHome();
  if (home === '' || !path.isAbsolute(home)) {
    throw new Error(
      `Cannot locate TangleClaw's base directory: no home directory resolved (os.homedir() and $HOME are both unusable). `
      + `Set ${HOME_ENV} to the directory TangleClaw should keep its state in.`
    );
  }
  return path.join(home, BASE_DIRNAME);
}

module.exports = { baseDir, userHome, HOME_ENV, BASE_DIRNAME };
