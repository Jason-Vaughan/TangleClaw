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
 * The one exception to "no environment": {@link _isRealDefaultSocketDir}
 * reads the filesystem (via `fs.realpathSync`) to tell a real socket path
 * apart from a disposable one -- never `process.env` directly, and never
 * anything the caller's own environment could shift (see its own doc
 * comment for why `$TMUX_TMPDIR` is deliberately NOT part of that check).
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
const fs = require('node:fs');

/** The TCC-authorized production socket name (`lib/tmux.js`'s `TCC_SOCKET` default) -- never a bare `kill-server` target either. */
const TCC_AUTHORIZED_SOCKET = 'tangleclaw-tcc-authorized';

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/** tmux's own literal default-socket basename -- what `-S <dir>/default` names, and what the default socket is called inside tmux's own socket directory when no `-L`/`-S` is given at all. Never isolated, however it's reached. */
const DEFAULT_SOCKET_BASENAME = 'default';

/**
 * Every `-L <name>` / `-S <path>` socket selector named anywhere in a
 * candidate `tmux` command line, in the order they appear. `kill-server`
 * takes no arguments of its own -- only the global `-L`/`-S` flags that
 * precede the subcommand -- so this reads the whole command text rather
 * than parsing tmux's full grammar.
 *
 * Real tmux takes the LAST `-L`/`-S` of EITHER kind when more than one is
 * given (confirmed empirically: `-L a -S b` uses `b`; `-S a -L b` uses
 * `b`) -- a single regex matching only the first `-L` cannot tell that
 * `-L __tc_test_safe -L default kill-server` actually targets `default`
 * (PRR-A R-Gate HOLD). Rather than replicate every edge case of tmux's own
 * precedence correctly, a command naming more than one selector is read as
 * `ambiguous: true` and the caller fails closed on it -- this guard would
 * rather over-refuse an unusual command than let a crafted second flag
 * smuggle a real kill-server past it.
 * @param {string} commandText
 * @returns {{socket: (string|null), isPath: boolean, ambiguous: boolean}}
 */
function _namedSocket(commandText) {
  const strip = (s) => s.replace(/^['"]|['"]$/g, '');
  const selectors = [];
  const re = /-([LS])\s+(\S+)/g;
  let m;
  while ((m = re.exec(commandText)) !== null) {
    selectors.push({ socket: strip(m[2]), isPath: m[1] === 'S' });
  }
  if (selectors.length === 0) return { socket: null, isPath: false, ambiguous: false };
  const last = selectors[selectors.length - 1];
  return { socket: last.socket, isPath: last.isPath, ambiguous: selectors.length > 1 };
}

/**
 * Whether `dir` is the ONE shared default tmux socket directory this
 * fleet's panes actually use -- `/tmp/tmux-<uid>` (never `$TMUX_TMPDIR`,
 * and never Node's `os.tmpdir()`, which can differ from both): confirmed
 * empirically that every real TangleClaw pane on this host runs with
 * `TMUX_TMPDIR` unset, so tmux's own fallback (the literal `/tmp`) is where
 * the real default and TCC-authorized sockets actually live, full stop --
 * this is deliberately NOT relative to the candidate command's own
 * environment. A test that fully re-roots its OWN private server via
 * `process.env.TMUX_TMPDIR` (`test/tmux-named-paste-buffer.test.js` does
 * exactly this) produces a socket whose directory is never this one, even
 * though its basename is also, legitimately, `default` -- which is exactly
 * why this check exists instead of trusting the basename alone (PRR-A
 * R-Gate HOLD: `-S /tmp/tmux-<uid>/default` previously passed a broad "is
 * this under /tmp" check, which could not tell a real default apart from a
 * test's own re-rooted one either -- comparing the exact directory, not a
 * loose prefix, is what both reject the real one AND accept the test's).
 * Compared by realpath for the same symlink reasons
 * `lib/merge-role-guard.js`'s own wrapper templates already document
 * (`/tmp` -> `/private/tmp` on macOS). Unresolvable fails CLOSED -- read as
 * "yes, this is the real one" -- so an error never reads as proof of
 * isolation. If this fleet's own `TMUX_TMPDIR` ever becomes non-empty for a
 * real pane, this constant needs updating to match -- it is deliberately a
 * fact about this deployment, not a general tmux rule.
 * @param {string} dir - A candidate socket's containing directory.
 * @returns {boolean}
 */
function _isRealDefaultSocketDir(dir) {
  let uid;
  try { uid = process.getuid(); } catch { return true; }
  const realDefaultDir = `/tmp/tmux-${uid}`;
  try {
    return fs.realpathSync(dir) === fs.realpathSync(realDefaultDir);
  } catch {
    return true;
  }
}

/**
 * Whether `dir` is genuinely under a scratch/temp root a test's own
 * `mkdtemp`-style setup would create -- `/tmp`, `/var/folders` (and their
 * macOS `/private/...` realpaths), but never the bare root itself, AND
 * containing at least one path segment that actually looks test-created
 * (Architect A-Gate R3 addendum, A506-W2HF-AGATE-R3-HOLD, after PRR-A
 * R-Gate Round 4): {@link _isRealDefaultSocketDir} alone only excludes the
 * ONE exact real default directory -- it says nothing about
 * `-S /Users/someone/prod/default`, an arbitrary EXISTING directory
 * elsewhere entirely, which `_isRealDefaultSocketDir` happily reports as
 * "not the real one" (true) while being nowhere near a disposable test
 * root either. "Under /tmp" alone is still not enough on its own: `/tmp` is
 * shared and world-writable, so `-S /tmp/some-other-real-thing/default`
 * could just as easily be a REAL, unrelated server some other process put
 * there, not a fixture of this suite's own making. Requiring a path
 * segment matching this suite's own actual fixture-naming conventions
 * (`__tc_test_`, or the `tc-` prefix every real `mkdtemp` call in this
 * codebase uses -- `tc-2173-`, `tc-tmux-guard-rerooted-`, etc.) narrows
 * "isolated" to "a directory one of OUR tests actually created," not
 * merely "somewhere under /tmp." Checked across every segment of the
 * resolved path, not just the immediate parent, so nesting depth doesn't
 * matter. Unresolvable fails CLOSED -- read as "not a verified test root"
 * -- so an error never reads as proof of isolation.
 * @param {string} dir - A candidate socket's containing directory.
 * @returns {boolean}
 */
function _isUnderVerifiedTestRoot(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return false; }
  if (/^\/(private\/)?tmp\/?$/.test(real)) return false;
  if (!/^\/(private\/)?(tmp|var\/folders)(\/|$)/.test(real)) return false;
  return real.split('/').some((segment) => /^(__tc_test_|tc-)/.test(segment));
}

/**
 * Test-fixture socket-name conventions this guard trusts as isolated by
 * name alone -- an ALLOWLIST (#2946's own issue text specifies exactly
 * one: `^__tc_test_`), not a denylist of the two protected names. PRR-A
 * R-Gate HOLD (Round 3): an earlier version of this guard allowed ANY
 * explicitly-named socket that wasn't literally `default`/TCC-authorized
 * -- `-L some-other-real-socket kill-server` passed, which could kill a
 * real, named, non-fleet production server this guard has no way to know
 * is important. Every prefix here is one actually used by a real,
 * already-existing `kill-server` caller in this suite (cross-checked
 * against the static scan's own `VERIFIED_SAFE` list in
 * `test/tmux-guard.test.js`) -- not a guess at what else might be safe.
 * A caller naming a socket this list doesn't recognize is refused, even
 * though it is almost certainly NOT the real default/TCC socket either --
 * fail closed on the unknown, per the issue's own original intent, rather
 * than fail open on "well, it's not literally one of the two known bad
 * ones."
 * @type {ReadonlyArray<RegExp>}
 */
const ISOLATED_NAME_PREFIXES = Object.freeze([
  /^__tc_test_/,
  /^tc-test-panes-/
]);

/**
 * Whether a named socket (from {@link _namedSocket}) is safe for a test to
 * `kill-server` outright. The TCC-authorized socket is refused under ANY
 * selector, unconditionally (Architect A-Gate R3 addendum,
 * A506-W2HF-AGATE-R3-HOLD): unlike the default socket, no test anywhere in
 * this suite ever legitimately needs a server of its own named exactly
 * `tangleclaw-tcc-authorized`, re-rooted or not, so there is no exception
 * to carve out for it. The bare default socket (no `-L`/`-S` at all, or one
 * explicitly named `default`) DOES need one: for `-L`, basename alone is
 * enough (a name always lives in tmux's own socket directory, so naming it
 * `default` always means the real one); for `-S`, basename alone is NOT
 * enough on its own -- {@link _isRealDefaultSocketDir} AND
 * {@link _isUnderVerifiedTestRoot} must BOTH hold (not the one real
 * directory, AND genuinely a verified test-created scratch location),
 * since a test's own fully re-rooted private server can legitimately have
 * a socket whose basename is ALSO `default`, but an arbitrary EXISTING
 * directory elsewhere (PRR-A R-Gate HOLD, Round 4: `-S
 * /Users/someone/prod/default`) is neither the real one nor a verified test
 * root, and must still be refused. Every other name is checked against
 * {@link ISOLATED_NAME_PREFIXES} -- an allowlist, not "anything that isn't
 * one of the two real names" (see that constant's own doc comment for why
 * the broader form was refused in review).
 * @param {{socket: (string|null), isPath: boolean, ambiguous: boolean}} named
 * @returns {boolean}
 */
function _isIsolatedSocket(named) {
  if (named.ambiguous) return false;
  if (!named.socket) return false;
  const basename = named.isPath ? path.basename(named.socket) : named.socket;
  if (basename === TCC_AUTHORIZED_SOCKET) return false;
  if (basename === DEFAULT_SOCKET_BASENAME) {
    if (!named.isPath) return false;
    const dir = path.dirname(named.socket);
    return !_isRealDefaultSocketDir(dir) && _isUnderVerifiedTestRoot(dir);
  }
  return ISOLATED_NAME_PREFIXES.some((re) => re.test(basename));
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
  if (named.ambiguous) {
    return _refuse(
      'TMUX_KILL_SERVER_FORBIDDEN',
      'tmux kill-server naming more than one -L/-S socket selector is refused -- tmux itself honors only the LAST one, which this guard will not try to re-derive; repeat the command with exactly one -L __tc_test_<name> selector.'
    );
  }
  return _refuse(
    'TMUX_KILL_SERVER_FORBIDDEN',
    named.socket
      ? `tmux kill-server against '${named.socket}' is refused -- its name matches no verified isolated test-fixture convention (${ISOLATED_NAME_PREFIXES.map((re) => re.source).join(', ')}), and a -S path reaching the real default/TCC socket directory is refused regardless of name. Use an isolated -L __tc_test_<name> socket instead.`
      : 'tmux kill-server with no -L/-S target is refused -- it would kill the DEFAULT server and every live session on it (the exact #2929/#2945 incident, 2026-11-08T22:24:16.633Z); use an isolated -L __tc_test_<name> socket instead.'
  );
}

module.exports = {
  TCC_AUTHORIZED_SOCKET,
  DEFAULT_SOCKET_BASENAME,
  ISOLATED_NAME_PREFIXES,
  evaluateTmuxKillGuard
};
