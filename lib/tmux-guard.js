'use strict';

/**
 * `tmux kill-server` safety guard (#2946, Architect Ruling A506-W2HF-SCOPE-R2).
 *
 * A bare `tmux kill-server` (no explicit `-L`/`-S` target) kills the DEFAULT
 * tmux server and every live session on it in one call. Confirmed for real
 * at `2026-11-08T22:24:16.633Z`: session `#1574` ran exactly that while
 * debugging `#2929`/`#2945` (`test/tmux-tcc.test.js`) to simulate an empty
 * default server for a test, and it took down all 22 live TangleClaw fleet
 * sessions at once, including itself.
 *
 * A pure classifier/evaluator, mirroring `lib/merge-role-guard.js`'s own
 * shape: {@link evaluateTmuxKillGuard} takes a candidate shell command as
 * plain data and returns a computed verdict -- nothing here reads the
 * environment, intercepts a real shell command, or writes a wrapper file
 * itself. That wiring is `lib/merge-role-guard.js#createRoleGuardWrapperScripts`,
 * whose generated `tmux` wrapper script requires this module to evaluate
 * each candidate command before deciding whether to exec the real `tmux`.
 *
 * Scope, deliberately narrow: only `kill-server` is evaluated here.
 * `kill-session`/`kill-window`/`kill-pane` are everyday, single-target
 * operations `lib/tmux.js#killSession` runs legitimately and constantly
 * (including in this very test suite's own `afterEach` cleanup) -- #2946's
 * own text ties "unauthorized" `kill-session` et al. to a server-issued
 * authorization this module has no way to check from a bare command string
 * alone, and guessing that shape wrong risks refusing routine session
 * teardown fleet-wide. Left for a follow-up ruling rather than guessed at
 * here (see the PR body / #2946).
 *
 * @module lib/tmux-guard
 */

const path = require('node:path');

/** The TCC-authorized production socket name (`lib/tmux.js`'s `TCC_SOCKET` default) -- never a bare `kill-server` target either. */
const TCC_AUTHORIZED_SOCKET = 'tangleclaw-tcc-authorized';

/** A socket/session-name shape this guard treats as isolated/disposable test infrastructure, never the shared default or TCC-authorized server (`test/_tmux-session-names.js#uniqueSessionName`'s own convention). */
const ISOLATED_SOCKET_RE = /^__tc_test_/;

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * The first `-L <name>` or `-S <path>` socket target named anywhere in a
 * candidate `tmux` command line. `kill-server` takes no arguments of its
 * own -- only the global `-L`/`-S` flags that precede the subcommand -- so
 * this reads the whole command text rather than parsing tmux's full
 * grammar. `-L` wins when a (malformed) command somehow names both.
 * @param {string} commandText
 * @returns {{socket: (string|null), isPath: boolean}}
 */
function _namedSocket(commandText) {
  const strip = (s) => s.replace(/^['"]|['"]$/g, '');
  const lMatch = /-L\s+(\S+)/.exec(commandText);
  if (lMatch) return { socket: strip(lMatch[1]), isPath: false };
  const sMatch = /-S\s+(\S+)/.exec(commandText);
  if (sMatch) return { socket: strip(sMatch[1]), isPath: true };
  return { socket: null, isPath: false };
}

/**
 * Whether a named socket (from {@link _namedSocket}) is isolated/disposable
 * test infrastructure, safe for a test to `kill-server` outright -- never
 * the default socket (no `-L`/`-S` at all) and never the TCC-authorized one.
 * @param {{socket: (string|null), isPath: boolean}} named
 * @returns {boolean}
 */
function _isIsolatedSocket(named) {
  if (!named.socket) return false;
  if (named.socket === TCC_AUTHORIZED_SOCKET) return false;
  if (named.isPath) {
    // `-S <path>`: isolated only when the path's own basename follows the
    // same test-fixture convention `-L` names do, OR it sits under a real
    // scratch/temp directory (`os.tmpdir()`'s own platform prefixes) rather
    // than wherever tmux's default socket directory lives.
    return ISOLATED_SOCKET_RE.test(path.basename(named.socket))
      || /(^|\/)(tmp|var\/folders|private\/tmp|private\/var\/folders)\//.test(named.socket);
  }
  return ISOLATED_SOCKET_RE.test(named.socket);
}

/**
 * Evaluate whether a candidate `tmux` command may proceed (#2946). A
 * command that is not `kill-server` at all always proceeds -- this guard
 * has nothing to say about any other tmux subcommand (see this module's own
 * doc comment for why `kill-session`/`kill-window`/`kill-pane` are out of
 * scope here).
 * @param {object} input
 * @param {string} input.commandText - The candidate shell command, e.g. `"tmux kill-server"` or `"tmux -L __tc_test_foo kill-server"`.
 * @returns {{ok: true, result: {allowed: true, reason: string}}|{ok: false, code: string, message: string}}
 */
function evaluateTmuxKillGuard(input) {
  if (!input || typeof input !== 'object' || typeof input.commandText !== 'string') {
    return _refuse('TMUX_GUARD_INVALID', 'input.commandText must be a string.');
  }
  const commandText = input.commandText;
  if (!/\bkill-server\b/.test(commandText)) {
    return { ok: true, result: { allowed: true, reason: 'not a kill-server invocation' } };
  }
  const named = _namedSocket(commandText);
  if (_isIsolatedSocket(named)) {
    return { ok: true, result: { allowed: true, reason: 'targets an isolated test socket' } };
  }
  return _refuse(
    'TMUX_KILL_SERVER_FORBIDDEN',
    named.socket
      ? `tmux kill-server against '${named.socket}' is refused -- only an isolated __tc_test_* socket (or a path under a scratch test directory) may be killed this way.`
      : 'tmux kill-server with no -L/-S target is refused -- it would kill the DEFAULT server and every live session on it (the exact #2929/#2945 incident, 2026-11-08T22:24:16.633Z); use an isolated -L __tc_test_<name> socket instead.'
  );
}

module.exports = {
  TCC_AUTHORIZED_SOCKET,
  ISOLATED_SOCKET_RE,
  evaluateTmuxKillGuard
};
