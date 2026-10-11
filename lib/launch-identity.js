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

module.exports = { LAUNCH_IDENTITY_KEYS, undecidedIdentityKeys };
