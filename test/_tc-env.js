'use strict';

/**
 * The environment a test hands a `tc` it spawns.
 *
 * `tc` compares the launch identity in its environment with the one tmux
 * recorded for the pane it runs in, and refuses when they differ. A test that
 * passes the developer's environment through, with a test identity laid over
 * it, hands `tc` the developer's own pane and an identity that pane never had,
 * which `tc` rightly refuses. The suite then fails inside a tmux pane and
 * passes in CI, where there is no tmux.
 *
 * Not a test file: the leading underscore keeps it out of the suite glob.
 * @module test/_tc-env
 */

/**
 * A copy of an environment with no tmux pane in it, so a spawned `tc` reports
 * the pane check as not made rather than comparing against a pane that is not
 * the test's.
 * @param {Object<string, string>} env - The environment to copy, usually `process.env`
 * @returns {Object<string, string>}
 */
function outsidePane(env) {
  const { TMUX: _socket, TMUX_PANE: _pane, ...rest } = env;
  return rest;
}

module.exports = { outsidePane };
