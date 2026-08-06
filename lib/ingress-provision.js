'use strict';

// Putting a login in front of TangleClaw from the setup wizard.
//
// Two things live here, and they are here together because each is useless
// without the other:
//
//   1. `decideProvisioning` — the one derivation of "what may the wizard do
//      about a login on this machine". The wizard asks the server (see
//      GET /api/setup/ingress-state); it never re-derives the table in the
//      browser. A second copy of a security decision in front-end code is the
//      same drift lib/caddy.js already refused when it collapsed the
//      overwrite question into a single `safeToWrite` field.
//
//   2. `spawnCutover` + the result-file readers — how the server observes an
//      operation that kills it. The ingress cutover's launchctl sequence ends
//      with `kickstart -k` on the TangleClaw server, so a handler that ran the
//      plan in-process would die partway through and never learn the outcome.
//      The cutover therefore runs as a DETACHED child that survives the
//      restart and writes its outcome to a file (`--result-file`), and the
//      wizard polls for that file afterwards. Codes come from
//      scripts/ingress-cutover.js `CUTOVER_CODES` — this module never invents
//      one, so the CLI and the wizard always describe a run the same way.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('ingress-provision');

const RESULT_FILENAME = 'ingress-cutover-result.json';
// How the cutover log is NAMED to an operator, as opposed to where it resolves.
// The absolute path contains the OS account name, and the route that reports this
// answers without authentication — so callers are given the relative form.
const CUTOVER_LOG_RELATIVE = '~/.tangleclaw/logs/ingress-cutover.log';
const CUTOVER_SCRIPT = path.join('scripts', 'ingress-cutover.js');

// The ONE protection state in which TangleClaw has positively observed a gate:
// adoption read the live Caddyfile and matched it. Every other state is either
// "a credential exists but nothing here can say it is enforced" or "no answer
// yet" — neither of which may be reported to an operator as protected.
const PROTECTION_CONFIRMED = 'existing';
// States meaning a credential IS stored while enforcement is unconfirmed. Selects
// the wording of the unprotected screen; it does NOT soften the outcome.
const PROTECTION_STORED_UNCONFIRMED = new Set(['unchanged', 'existing-unverified']);

/**
 * Turn the `protection` enum into the two answers a consumer actually needs
 * (#861).
 *
 * This exists because the judgement used to be re-made by comparing the enum
 * against a literal list in three places — twice in `server.js` and once in
 * `public/setup.js` — which made the browser a second source of truth for a
 * security decision. There is no build step here, so `public/` cannot import a
 * shared constant; the server derives the answer and ships it.
 *
 * **Allowlist, not denylist, and that inversion is the point.** The old lists
 * enumerated the states meaning "not protected", so an unrecognised sixth value
 * matched none of them and fell through to the branch that DISMISSES the
 * warning — a newly-added state would silently stop telling the operator that
 * nothing is enforcing a login. Naming the single confirmed state instead makes
 * an unknown value fail safe: not confirmed, so the operator is told.
 * @param {string|null|undefined} protection - A value of the `ingress.protection` enum.
 * @returns {{confirmedProtection: boolean, credentialStored: boolean}}
 */
function deriveProtectionFlags(protection) {
  return {
    confirmedProtection: protection === PROTECTION_CONFIRMED,
    credentialStored: PROTECTION_STORED_UNCONFIRMED.has(protection)
  };
}

/**
 * Repository root — the directory holding `scripts/ingress-cutover.js`. This
 * module lives in `lib/`, so the repo is one level up.
 * @returns {string}
 */
function repoDir() {
  return path.resolve(__dirname, '..');
}

/**
 * Path of the file the detached cutover writes its outcome to. Under the store's
 * base path so tests can redirect it, and so it survives the server restart the
 * cutover performs — the whole point of the channel.
 * @returns {string}
 */
function resultPath() {
  return path.join(store._getBasePath(), RESULT_FILENAME);
}

/**
 * Where the detached cutover's stdout and stderr are appended.
 *
 * The result file carries the OUTCOME; this carries the narration, including the
 * cutover's own warning when it cannot write the result file. Beside the server's
 * own logs so an operator looking for "what happened during setup" finds both in
 * one place.
 * @returns {string}
 */
function cutoverLogPath() {
  return path.join(store._getBasePath(), 'logs', 'ingress-cutover.log');
}

/**
 * Decide what the setup wizard is allowed to do about a login on this machine.
 *
 * PURE — no I/O, so the whole table is unit-testable. Callers supply the facts:
 * the Caddyfile classification from `caddy.classifyIngressState()` and whether
 * the `caddy` binary was detected.
 *
 * Three actions, six Caddyfile states, no default fall-through — an unrecognized
 * state refuses rather than guessing, because not knowing what is in front of the
 * door is not the same as knowing the door is unguarded.
 *
 * Caddy-not-installed is tested FIRST and wins over every content state,
 * including `adoptable`. A hand-written Caddyfile on a machine with no Caddy
 * binary is a config nothing is running: adopting its credential would mark
 * TangleClaw protected while nothing enforces the gate. An operator who believes
 * they have a login behaves less carefully than one who knows they have none, so
 * a false claim of protection is worse than an honest absence of it — that is the
 * rule every branch here answers to.
 *
 * @param {object} facts
 * @param {string} facts.state - Caddyfile state: `absent`, `generated`,
 *   `adoptable`, `ambiguous`, `ungated` or `unreadable`.
 * @param {boolean} facts.caddyAvailable - Whether the `caddy` binary was found.
 * @param {boolean} facts.safeToWrite - `lib/caddy.js`'s verdict on whether this
 *   file may be overwritten. Consumed, never re-derived: it is the single field
 *   the project's write decision lives in, and a second copy here could answer
 *   `provision` for a file the classifier says must not be touched.
 * @param {string} [facts.ingressMode] - The install's current ingress mode. An
 *   existing credential is only *in force* when Caddy is the live ingress.
 * @param {string|null} [facts.user] - Existing credential's username, when the
 *   state is `adoptable` — used only to name it back to the operator.
 * @returns {{ action: 'provision'|'adopt'|'refuse', reason: string, remedy: string|null,
 *   user: string|null }} `action` is the only field a caller branches on.
 *   `reason` is one operator-facing sentence; `remedy` names what fixes a
 *   refusal, or null when nothing is broken.
 */
function decideProvisioning(facts) {
  const { state, caddyAvailable, safeToWrite } = facts || {};
  const user = (facts && facts.user) || null;
  const ingressMode = (facts && facts.ingressMode) || null;
  const cutoverCmd = 'node scripts/ingress-cutover.js --to caddy';

  if (!caddyAvailable) {
    return {
      action: 'refuse',
      reason: 'Caddy is not installed, so TangleClaw cannot put a login in front of itself yet. '
        + 'It was also not found on the PATH the background service runs with, which can happen if '
        + 'Caddy was installed after TangleClaw.',
      remedy: `Install Caddy (e.g. \`brew install caddy\`), then run \`${cutoverCmd}\`.`,
      user: null
    };
  }

  switch (state) {
    case 'absent':
    case 'generated':
      // Nothing a human maintains is at risk: either there is no Caddyfile, or
      // the one there is verifies as ours and regenerating reproduces it. The
      // state selects the wording; `safeToWrite` decides. If the classifier ever
      // stops calling one of these writable, this must refuse with it rather than
      // spawn a cutover against a file it has been told to leave alone.
      if (safeToWrite !== true) {
        return {
          action: 'refuse',
          reason: 'TangleClaw will not overwrite the existing Caddy config on this machine.',
          remedy: `Run \`${cutoverCmd} --dry-run\` at a terminal to see what it would do.`,
          user: null
        };
      }
      return { action: 'provision', reason: '', remedy: null, user: null };

    case 'adoptable':
      // A working hand-rolled gate. Adopt it — forcing a second credential would
      // either clobber it or leave two.
      //
      // But only when Caddy is the LIVE ingress. A single-credential Caddyfile on
      // a direct-mode install is a config nothing is serving — the same argument
      // the caddy-missing branch above makes, and it applies here too: this shape
      // is produced by `ingress-cutover.js --rollback`, which unloads Caddy and
      // sets ingressMode back to direct while leaving the file on disk. Adopting
      // there would set authEnabled on an install with no gate in front of it.
      if (ingressMode !== 'caddy') {
        return {
          action: 'refuse',
          reason: 'A Caddy config with a login is on disk, but Caddy is not the active ingress here, '
            + 'so that login is not in force and TangleClaw will not treat it as protection.',
          remedy: `Run \`${cutoverCmd}\` at a terminal to make it the active ingress, or delete the `
            + 'unused Caddy config and re-run setup.',
          user: null
        };
      }
      return {
        action: 'adopt',
        reason: user
          ? `An existing Caddy login for "${user}" is already in front of TangleClaw, so it will be kept rather than replaced.`
          : 'An existing Caddy login is already in front of TangleClaw, so it will be kept rather than replaced.',
        remedy: null,
        user
      };

    case 'ambiguous':
      return {
        action: 'refuse',
        reason: 'The existing Caddy config defines several logins, so TangleClaw cannot tell which one '
          + 'is yours and will not guess.',
        remedy: 'Leave one login in the Caddyfile, or set the credential explicitly with '
          + '`node scripts/reset-admin.js`.',
        user: null
      };

    case 'ungated':
      // Replacing this file is survivable only because the CLI takes a
      // timestamped backup and offers --force/--rollback. A browser has none of
      // those, so the decision belongs at a terminal.
      return {
        action: 'refuse',
        reason: 'A Caddy config written by hand is already here and it has no login in it. '
          + 'TangleClaw will not overwrite a config a person maintains.',
        remedy: `Run \`${cutoverCmd} --force\` at a terminal, where a timestamped backup is taken and `
          + '`--rollback` is available.',
        user: null
      };

    case 'unreadable':
      return {
        action: 'refuse',
        reason: 'A Caddy config is present but could not be read, so TangleClaw cannot tell whether '
          + 'a login is already in force and will not write over it.',
        remedy: 'Fix the file\'s permissions so it can be read, then re-run setup or '
          + `\`${cutoverCmd}\`.`,
        user: null
      };

    default:
      // Fail closed. Reached only if classifyIngressState grows a state that
      // nothing here was taught to answer for.
      return {
        action: 'refuse',
        reason: `TangleClaw does not recognize the state of the Caddy config (${String(state)}), `
          + 'so it will not change it.',
        remedy: `Run \`${cutoverCmd} --dry-run\` at a terminal to see what it would do.`,
        user: null
      };
  }
}

/**
 * Delete a previous cutover result.
 *
 * `spawnCutover` calls this itself, immediately before starting the child, so the
 * ordering the channel depends on cannot be forgotten by a caller: a leftover
 * `ok` from an earlier run would otherwise be read as this run's outcome. Exposed
 * for tests and for teardown, not as a step a caller is expected to sequence.
 *
 * Best-effort: a result file that cannot be removed must not stop provisioning.
 * The caller learns nothing was cleared and the poll degrades to the same
 * "cannot confirm" state it already has to handle.
 * @param {string} [target=resultPath()] - File to remove.
 * @returns {{ cleared: boolean, error: string|null }}
 */
function clearResult(target = resultPath()) {
  try {
    fs.rmSync(target, { force: true });
    return { cleared: true, error: null };
  } catch (err) {
    log.warn('Could not clear previous ingress cutover result', { path: target, error: err.message });
    return { cleared: false, error: err.message };
  }
}

/**
 * Read the cutover's outcome file.
 *
 * Three answers, deliberately distinct, because a caller must not conflate them:
 * absent (`present: false` — the run has not finished, or never started),
 * malformed (`malformed: true` — something is there but it is not an outcome),
 * and readable (`result` — authoritative; branch on its `code`).
 * @returns {{ present: boolean, malformed: boolean, result: object|null }}
 */
function readResult() {
  let raw;
  try {
    raw = fs.readFileSync(resultPath(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Could not read ingress cutover result', { error: err.message });
    }
    return { present: false, malformed: false, result: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: true, malformed: true, result: null };
    }
    return { present: true, malformed: false, result: parsed };
  } catch (err) { // prawduct:allow prawduct/broad-except -- JSON.parse's SyntaxError subtypes change nothing here; the file is not an outcome, which is what the caller is told
    log.warn('Ingress cutover result file is not parseable JSON', { error: err.message });
    return { present: true, malformed: true, result: null };
  }
}

/**
 * Start the ingress cutover as a detached child process.
 *
 * Detached and `unref`'d because the child restarts this server: it must outlive
 * the parent and must not keep the event loop alive while the response is still
 * being sent. Its stdio goes to a LOG FILE rather than to `'ignore'` — it must
 * not hold pipes to a process that is going away, but discarding its output
 * throws away the diagnostics that matter most precisely when the result file is
 * the thing that failed. `writeCutoverResult`'s "the failure goes to stderr" is
 * only true for a caller reading stderr; this makes it true here too.
 *
 * Any previous result is cleared first, so the poller cannot read an earlier
 * run's outcome as this one's.
 *
 * @param {object} [opts]
 * @param {'caddy'|'direct'} [opts.target='caddy'] - Cutover direction.
 * @param {string} [opts.resultFile] - Where the child writes its outcome;
 *   defaults to {@link resultPath}.
 * @param {Function} [opts.spawnFn=spawn] - Injectable `child_process.spawn`, so
 *   tests can assert the argv and the detach flags without running a cutover.
 * @returns {{ ok: boolean, pid: number|null, argv: string[], error: string|null }}
 */
function spawnCutover(opts = {}) {
  const target = opts.target || 'caddy';
  const resultFile = opts.resultFile || resultPath();
  const spawnFn = opts.spawnFn || spawn;
  const dir = repoDir();
  const argv = [path.join(dir, CUTOVER_SCRIPT), '--to', target, '--result-file', resultFile];

  // Interlock, not test-shaped behavior. A real run here rewrites launchd plists
  // and restarts the machine's TangleClaw server — and on a developer's box that
  // is the live install. Under `node --test` (which is how this project's suite
  // runs) an unstubbed reach into this function must fail loudly instead of
  // taking the dashboard down mid-suite. Tests that mean to exercise the spawn
  // pass their own `spawnFn` and are unaffected. Covers only processes the test
  // runner launched; a file run as plain `node test/x.js` gets no protection.
  if (!opts.spawnFn && process.env.NODE_TEST_CONTEXT) {
    const error = 'refusing to start a real ingress cutover from a test process '
      + '(pass spawnFn, or override the server\'s cutover spawner)';
    log.error(error, { target });
    return { ok: false, pid: null, argv, error };
  }

  // Append-mode fd, opened before the fork so a failure to open is reported here
  // rather than vanishing with the child. Falls back to discarding output — no
  // log is worse than no cutover is worse than neither.
  let logFd = 'ignore';
  const logPath = cutoverLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 0600 to match the result file the same run writes. The child's stderr lands
    // here verbatim, and on the validate-failed path that text is `caddy validate`
    // output quoting a `basic_auth <user> <hash>` line — so this file can hold a
    // credential hash even though nothing deliberately writes one to it. Mode is
    // only applied on create; an existing log keeps its permissions, so tighten it
    // as well rather than trusting the first-ever open to have set it.
    logFd = fs.openSync(logPath, 'a', 0o600);
    try {
      fs.fchmodSync(logFd, 0o600);
    } catch (err) {
      log.warn('Could not tighten permissions on the ingress cutover log',
        { path: logPath, error: err.message });
    }
  } catch (err) {
    log.warn('Could not open the ingress cutover log; the child\'s output will be discarded',
      { path: logPath, error: err.message });
  }

  try {
    // process.execPath, not 'node': under launchd the service's PATH is whatever
    // install.sh captured, and the child must run the same runtime as the server
    // regardless of what is on it.
    clearResult(resultFile);
    const child = spawnFn(process.execPath, argv, {
      cwd: dir,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    if (child && typeof child.unref === 'function') child.unref();
    const pid = (child && typeof child.pid === 'number') ? child.pid : null;
    log.info('Ingress cutover started as a detached child', { target, pid, resultFile, logPath });
    return { ok: true, pid, argv, error: null, logPath };
  } catch (err) {
    log.error('Could not start ingress cutover', { target, error: err.message });
    return { ok: false, pid: null, argv, error: err.message, logPath };
  } finally {
    // The child holds its own duplicate of the descriptor; the parent's copy is
    // dead weight and leaks one fd per provisioning attempt if left open.
    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch (err) {
        log.warn('Could not close the ingress cutover log descriptor', { error: err.message });
      }
    }
  }
}

module.exports = {
  decideProvisioning,
  resultPath,
  cutoverLogPath,
  repoDir,
  clearResult,
  readResult,
  spawnCutover,
  deriveProtectionFlags,
  PROTECTION_CONFIRMED,
  RESULT_FILENAME,
  CUTOVER_LOG_RELATIVE
};
