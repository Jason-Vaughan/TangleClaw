'use strict';

/**
 * The variables that say which launch a process belongs to: the launch, its
 * project, its role and its switchboard name. `tc` compares these four between
 * a shell and its pane (`lib/tc-verbs.js#PANE_IDENTITY_KEYS`), and a test holds
 * the two lists equal.
 *
 * A launch gives some of them and not others: a project session has no role, a
 * Project Master has no project id, and a workspace id exists only with the
 * switchboard on. One it does not give must not arrive from somewhere else.
 * tmux hands a new session every variable in its server's global environment,
 * and a child process inherits its parent's, so a value nobody decided is a
 * value left over from another launch.
 */
const LAUNCH_IDENTITY_KEYS = Object.freeze(['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID']);

/**
 * The identity variables a launch's environment entries give no value for.
 * An empty value counts as not given: every reader of these variables treats
 * empty and unset alike.
 * @param {Object<string, *>} [env] - The launch's environment entries.
 * @returns {string[]} The undecided keys, in {@link LAUNCH_IDENTITY_KEYS} order.
 */
function undecidedIdentityKeys(env) {
  const given = env && typeof env === 'object' ? env : {};
  return LAUNCH_IDENTITY_KEYS.filter((key) => given[key] === undefined || given[key] === null || String(given[key]) === '');
}

/** The read the report makes, as a person would type it: named in the log when it fails. */
const GLOBAL_READ = 'tmux show-environment -g';

/**
 * A notice for one of the three outcomes of the read. Always the same five
 * fields, so that a reader is told the outcome and never left to infer it
 * from a field that is missing.
 * @param {'none'|'found'|'could-not-check'} state - The outcome reached
 * @param {string|null} observedAt - When the read was made, as an ISO time; null when none was
 * @param {string} message - The outcome as a sentence for a person; empty for `none`
 * @param {string[]} [variables] - The names found
 * @returns {{state: string, variables: string[], removeCommands: string[], observedAt: (string|null), message: string}}
 */
function _notice(state, observedAt, message, variables = []) {
  return { state, variables, removeCommands: variables.map((key) => `tmux set-environment -g -u ${key}`), observedAt, message };
}

/**
 * Read once which launch identity variables tmux's global environment holds,
 * and say so: a notice for `GET /api/server-info` whatever the outcome, and
 * one warning in the log unless the outcome is a clean "none".
 *
 * A launch decides every identity variable itself, so one left in the global
 * environment reaches no pane TangleClaw creates. It is still reported, because
 * it reaches every other session on that tmux server, and because a TangleClaw
 * older than that rule is refused by `tc` in every pane it launches while the
 * variable is there. Nothing is removed: the global environment belongs to
 * every user of that tmux server, so the report names the command instead.
 *
 * Three outcomes, each stated in the notice's `state`: `found`; `none`, when
 * tmux answered and held none or no tmux server is running; and
 * `could-not-check` for a read that did not answer, failed or threw. The last
 * is never folded into `none`.
 *
 * Names are reported and values never are. A launch id is what the server
 * accepts as a caller's binding, and the read hands this function no value.
 *
 * Never throws: it runs before the server listens, and a tmux that misbehaves
 * must not keep the server from starting.
 *
 * @param {object} deps
 * @param {function(): {present: string[], answered: boolean, cause: (string|null), failure?: object}} deps.read - `tmux.readGlobalIdentityKeys`
 * @param {{warn: function(string, object=): void}} deps.log - Where the warning goes
 * @param {function(object): void} deps.setNotice - `serverInfo.setLaunchIdentityNotice`
 * @param {function(): Date} [deps.now] - The clock; the read's time is on the notice
 * @returns {{state: 'none'|'found'|'could-not-check', variables: string[], removeCommands: string[], observedAt: string, message: string}}
 *   The notice that was set.
 */
function reportGlobalIdentity({ read, log, setNotice, now = () => new Date() }) {
  const EITHER_WAY = 'No pane TangleClaw launches inherits one either way: every launch sets each of them itself.';
  let notice;
  try {
    const found = read();
    const observedAt = now().toISOString();
    if (!found || found.answered !== true) {
      const cause = (found && found.cause) || null;
      const failure = (found && found.failure) || {};
      const why = cause === 'read-timed-out' ? 'tmux did not answer in time' : 'the read of it failed';
      notice = _notice('could-not-check', observedAt,
        `TangleClaw could not check tmux's global environment for launch identity variables when it started: ${why}. ${EITHER_WAY}`);
      log.warn(`Could not check tmux's global environment for launch identity variables: ${why}`, {
        read: GLOBAL_READ,
        cause,
        status: typeof failure.status === 'number' ? failure.status : null,
        signal: typeof failure.signal === 'string' ? failure.signal : null,
        code: typeof failure.code === 'string' ? failure.code : null
      });
    } else {
      // Kept to the known names whatever the read returned, so that nothing
      // but a name from the list can reach the log or the notice.
      const present = Array.isArray(found.present) ? found.present : [];
      const variables = LAUNCH_IDENTITY_KEYS.filter((key) => present.includes(key));
      if (variables.length === 0) {
        notice = _notice('none', observedAt, '');
      } else {
        notice = _notice('found', observedAt, '', variables);
        notice.message = `tmux's global environment holds ${variables.join(', ')}. `
          + 'No pane TangleClaw launches inherits them: every launch sets each launch identity variable itself. '
          + `To remove them, run: ${notice.removeCommands.join(' ; ')}. `
          + 'This was read once, when the server started.';
        log.warn('tmux\'s global environment holds launch identity variables; no pane TangleClaw launches inherits them',
          { variables, removeCommands: notice.removeCommands });
      }
    }
  } catch (err) { // prawduct:allow prawduct/broad-except -- runs before listen: whatever the read or the clock throws, the server still starts, and the notice says the check was not made
    notice = _notice('could-not-check', new Date().toISOString(),
      `TangleClaw could not check tmux's global environment for launch identity variables when it started: the check failed. ${EITHER_WAY}`);
    // The error's name, code, exit status and signal, and not its message: an
    // exec failure's message can carry what the command printed.
    try {
      log.warn('Could not check tmux\'s global environment for launch identity variables: the check failed', {
        read: GLOBAL_READ,
        error: (err && err.name) || 'Error',
        code: err && typeof err.code === 'string' ? err.code : null,
        status: err && typeof err.status === 'number' ? err.status : null,
        signal: err && typeof err.signal === 'string' ? err.signal : null
      });
    } catch (_) { /* a logger that throws must not stop the start either */ }
  }
  try { setNotice(notice); } catch (_) { /* as above: the server starts without the notice */ }
  return notice;
}

module.exports = { LAUNCH_IDENTITY_KEYS, undecidedIdentityKeys, reportGlobalIdentity };
