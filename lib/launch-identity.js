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

/**
 * Read once which launch identity variables tmux's global environment holds,
 * and say so: one warning in the log, and a notice for `GET /api/server-info`.
 *
 * A launch decides every identity variable itself, so one left in the global
 * environment reaches no pane TangleClaw creates. It is still reported, because
 * it reaches every other session on that tmux server, and because a TangleClaw
 * older than that rule is refused by `tc` in every pane it launches while the
 * variable is there. Nothing is removed: the global environment belongs to
 * every user of that tmux server, so the report names the command instead.
 *
 * Names are reported and values never are. A launch id is what the server
 * accepts as a caller's binding, and the read hands this function no value.
 *
 * Never throws: it runs before the server listens, and a tmux that misbehaves
 * must not keep the server from starting.
 *
 * @param {object} deps
 * @param {function(): {present: string[], answered: boolean, cause: (string|null)}} deps.read - `tmux.readGlobalIdentityKeys`
 * @param {{warn: function(string, object=): void}} deps.log - Where the warning goes
 * @param {function((object|null)): void} deps.setNotice - `serverInfo.setLaunchIdentityNotice`
 * @param {function(): Date} [deps.now] - The clock; the read's time is on the notice
 * @returns {{state: 'found'|'could-not-check', variables: string[], removeCommands: string[], observedAt: string, message: string}|null}
 *   The notice that was set; null when the environment holds none, or there is no tmux server.
 */
function reportGlobalIdentity({ read, log, setNotice, now = () => new Date() }) {
  let notice = null;
  try {
    const found = read();
    const observedAt = now().toISOString();
    if (!found || found.answered !== true) {
      notice = {
        state: 'could-not-check',
        variables: [],
        removeCommands: [],
        observedAt,
        message: 'TangleClaw could not check tmux\'s global environment for launch identity variables when it started: tmux did not answer. '
          + 'No pane TangleClaw launches inherits one either way: every launch sets each of them itself.'
      };
      log.warn('Could not check tmux\'s global environment for launch identity variables: tmux did not answer', { cause: (found && found.cause) || null });
    } else {
      // Kept to the known names whatever the read returned, so that nothing
      // but a name from the list can reach the log or the notice.
      const present = Array.isArray(found.present) ? found.present : [];
      const variables = LAUNCH_IDENTITY_KEYS.filter((key) => present.includes(key));
      if (variables.length > 0) {
        const removeCommands = variables.map((key) => `tmux set-environment -g -u ${key}`);
        notice = {
          state: 'found',
          variables,
          removeCommands,
          observedAt,
          message: `tmux's global environment holds ${variables.join(', ')}. `
            + 'No pane TangleClaw launches inherits them: every launch sets each launch identity variable itself. '
            + `To remove them, run: ${removeCommands.join(' ; ')}. `
            + 'This was read once, when the server started.'
        };
        log.warn('tmux\'s global environment holds launch identity variables; no pane TangleClaw launches inherits them', { variables, removeCommands });
      }
    }
  } catch (err) { // prawduct:allow prawduct/broad-except -- runs before listen: whatever the read or the clock throws, the server still starts, and the notice says the check was not made
    notice = {
      state: 'could-not-check',
      variables: [],
      removeCommands: [],
      observedAt: new Date().toISOString(),
      message: 'TangleClaw could not check tmux\'s global environment for launch identity variables when it started: the check failed. '
        + 'No pane TangleClaw launches inherits one either way: every launch sets each of them itself.'
    };
    // The error's name and code, not its message: an exec failure's message can carry output.
    try { log.warn('Could not check tmux\'s global environment for launch identity variables: the check failed', { error: (err && err.name) || 'Error', code: (err && err.code) || null }); } catch (_) { /* a logger that throws must not stop the start either */ }
  }
  try { setNotice(notice); } catch (_) { /* as above: the server starts without the notice */ }
  return notice;
}

module.exports = { LAUNCH_IDENTITY_KEYS, undecidedIdentityKeys, reportGlobalIdentity };
