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
 * resolves the passwd home at one site and the empty string at another, and
 * the store writes its database to `/.tangleclaw/` while master state and git
 * templates keep writing to the operator's real home. The install is then half
 * relocated, which is worse than not relocated at all: it looks like it worked.
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
 * Read at call time rather than frozen at module load, so a test or a rehearsal
 * launch that sets `TANGLECLAW_HOME` is honoured regardless of when this module
 * first got required.
 *
 * @returns {string} Absolute path. `<home>/.tangleclaw`, or `TANGLECLAW_HOME`
 *   verbatim (resolved to absolute) when that is set to a non-blank value.
 */
function baseDir() {
  const override = typeof process.env[HOME_ENV] === 'string' ? process.env[HOME_ENV].trim() : '';
  if (override !== '') return path.resolve(override);
  return path.join(userHome(), BASE_DIRNAME);
}

module.exports = { baseDir, userHome, HOME_ENV, BASE_DIRNAME };
