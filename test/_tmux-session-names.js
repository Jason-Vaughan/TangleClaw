'use strict';

/**
 * Test helper: names for the real tmux sessions a test creates.
 *
 * ## Why this exists
 *
 * A tmux session name is global to the host's tmux server, not to the process
 * or the checkout that created it. A test that creates a real session under a
 * literal name therefore shares that name with every other run of the suite on
 * the machine. Two runs at once fail each other: the second `new-session`
 * reports `duplicate session`, and each run's teardown kills the session the
 * other is still using (`can't find session`). Neither failure says anything
 * about the code under test.
 *
 * ## What makes a name unique
 *
 * - the process id, which separates processes alive at the same time;
 * - a random nonce drawn once per process, because a pid is unique only within
 *   one pid namespace and containers can share a tmux socket;
 * - a per-process counter, so two names asked for in the same process never
 *   match, even under the same label.
 *
 * A test keeps the name it was given and tears down exactly that name. Nothing
 * here cleans up by prefix or pattern: a pattern wide enough to catch a leaked
 * fixture is wide enough to catch another run's live one.
 *
 * @module test/_tmux-session-names
 */

const crypto = require('node:crypto');

/** Marks a session as a suite fixture to anyone reading `tmux ls`. */
const PREFIX = '__tc_test_';

/** Drawn once, so every name from this process shares it and no other process's does. */
const PROCESS_NONCE = crypto.randomBytes(4).toString('hex');

/** @type {number} How many names this process has handed out. */
let issued = 0;

/**
 * Return a tmux session name no other process, and no other call, will get.
 *
 * @param {string} label - What the session is for; letters, digits, `_` and `-` only
 * @returns {string} A name tmux accepts and `lib/tmux.js#isValidSessionName` allows
 */
function uniqueSessionName(label) {
  if (typeof label !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(label)) {
    throw new Error(`uniqueSessionName: label must be letters, digits, "_" or "-", got ${JSON.stringify(label)}`);
  }
  issued += 1;
  return `${PREFIX}${label}_${process.pid}_${PROCESS_NONCE}_${issued}__`;
}

module.exports = { uniqueSessionName };
