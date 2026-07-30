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
const CUTOVER_SCRIPT = path.join('scripts', 'ingress-cutover.js');

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
 * TangleClaw protected while nothing enforces the gate, which is the exact
 * failure this chunk exists to prevent.
 *
 * @param {object} facts
 * @param {string} facts.state - Caddyfile state: `absent`, `generated`,
 *   `adoptable`, `ambiguous`, `ungated` or `unreadable`.
 * @param {boolean} facts.caddyAvailable - Whether the `caddy` binary was found.
 * @param {string|null} [facts.user] - Existing credential's username, when the
 *   state is `adoptable` — used only to name it back to the operator.
 * @returns {{ action: 'provision'|'adopt'|'refuse', reason: string, remedy: string|null,
 *   user: string|null }} `action` is the only field a caller branches on.
 *   `reason` is one operator-facing sentence; `remedy` names what fixes a
 *   refusal, or null when nothing is broken.
 */
function decideProvisioning(facts) {
  const { state, caddyAvailable } = facts || {};
  const user = (facts && facts.user) || null;
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
      // the one there is verifies as ours and regenerating reproduces it.
      return { action: 'provision', reason: '', remedy: null, user: null };

    case 'adoptable':
      // A working hand-rolled gate. Adopt it — forcing a second credential would
      // either clobber it or leave two.
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
 * Delete any previous cutover result. Called immediately BEFORE spawning, so a
 * poller can never read a stale run's outcome as this run's — the file is the
 * only channel, and a leftover `ok` from last week would report success for a
 * cutover that has not happened yet.
 *
 * Best-effort: a result file that cannot be removed must not stop provisioning.
 * The caller learns nothing was cleared and the poll degrades to the same
 * "cannot confirm" state it already has to handle.
 * @returns {{ cleared: boolean, error: string|null }}
 */
function clearResult() {
  const target = resultPath();
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
 * Detached, `stdio: 'ignore'`, and `unref`'d — all three for the same reason:
 * the child restarts this server. It must outlive the parent, it must not hold
 * pipes to a process that is going away, and it must not keep the event loop
 * alive while the response is still being sent. It reports back only through
 * `--result-file`.
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

  try {
    // process.execPath, not 'node': under launchd the service's PATH is whatever
    // install.sh captured, and the child must run the same runtime as the server
    // regardless of what is on it.
    const child = spawnFn(process.execPath, argv, {
      cwd: dir,
      detached: true,
      stdio: 'ignore'
    });
    if (child && typeof child.unref === 'function') child.unref();
    const pid = (child && typeof child.pid === 'number') ? child.pid : null;
    log.info('Ingress cutover started as a detached child', { target, pid, resultFile });
    return { ok: true, pid, argv, error: null };
  } catch (err) {
    log.error('Could not start ingress cutover', { target, error: err.message });
    return { ok: false, pid: null, argv, error: err.message };
  }
}

module.exports = {
  decideProvisioning,
  resultPath,
  repoDir,
  clearResult,
  readResult,
  spawnCutover,
  RESULT_FILENAME
};
