'use strict';

/**
 * Test guard: make a real tmux session unspawnable from the suite.
 *
 * ## Why this exists
 *
 * `launchSession` calls `tmux.createSession` UNCONDITIONALLY (`lib/sessions.js`).
 * The `tmux.hasSession` stub that several test blocks install decides only
 * whether an orphan gets killed first — it never prevents creation. So any test
 * that reaches `launchSession` without stubbing `createSession` starts a real
 * tmux session running the real engine binary, and that session outlives the
 * test run (#902).
 *
 * The reported symptom was one leaked `orphan-test` session holding a PTY. The
 * live one found while fixing this was worse: a real Claude Code process sitting
 * at a prompt in auto mode with subagents attached, its working directory
 * already deleted by the suite's own temp-root teardown.
 *
 * ## Why a guard and not three stubs
 *
 * Three separate blocks could reach the real path, and the block that did stub
 * it (`stale wrapping recovery`) was correct by accident of one author being
 * careful. Stubbing the three is a fix that holds until someone writes a fourth
 * block — and the failure is silent, slow, and lands on the maintainer's own
 * machine rather than in CI.
 *
 * So the default is inverted: the real `createSession` is unreachable, and a
 * test that wants it must say so. A new block that forgets fails loudly, on its
 * first run, with a message naming the fix.
 *
 * @module test/_tmux-guard
 */

const tmux = require('../lib/tmux');

/** @type {Function|null} The real implementation, held while the guard is installed. */
let realCreateSession = null;

/**
 * Replace `tmux.createSession` with a throwing stand-in.
 *
 * Call once from a suite's top-level `before`. A test block that legitimately
 * needs `createSession` stubs it in its own `beforeEach` as usual — that
 * assignment shadows the poison, and restoring the captured original in
 * `afterEach` restores the poison rather than the real function, which is the
 * behaviour we want.
 *
 * @returns {void}
 */
function installTmuxGuard() {
  if (realCreateSession) return; // already installed
  realCreateSession = tmux.createSession;

  tmux.createSession = (name) => {
    throw new Error(
      `#902 guard: a test reached the real tmux.createSession("${name}").\n` +
      '\n' +
      'This would start a real tmux session running the real engine binary, and\n' +
      'it would outlive the test run — the suite deletes its temp root on exit,\n' +
      'leaving an orphaned agent process at a prompt with no working directory.\n' +
      '\n' +
      'Fix: stub it in this block\'s beforeEach, as the sibling blocks do —\n' +
      '\n' +
      '    originalCreateSession = tmux.createSession;\n' +
      '    tmux.createSession = () => true;\n' +
      '\n' +
      'and restore it in afterEach. Note that `launchSession` calls createSession\n' +
      'unconditionally, so stubbing `hasSession` alone does NOT prevent this.'
    );
  };
}

/**
 * Restore the real `tmux.createSession`.
 *
 * For suite teardown only. Nothing in the test suite should need the real
 * implementation; this exists so the guard does not leak into another suite
 * sharing the module registry.
 *
 * @returns {void}
 */
function removeTmuxGuard() {
  if (!realCreateSession) return;
  tmux.createSession = realCreateSession;
  realCreateSession = null;
}

/**
 * Kill any tmux session whose name matches a test fixture, as a backstop.
 *
 * The guard above prevents creation, which is the real fix. This is the second
 * line: if a future path spawns one anyway, the suite cleans up after itself
 * rather than leaving it for a human to notice weeks later.
 *
 * Only names passed explicitly are killed — never a bare prefix match, so an
 * operator's own session cannot be caught by a fixture name that happens to
 * share a prefix.
 *
 * @param {string[]} names - Exact tmux session names owned by the suite
 * @returns {string[]} The names that were actually found and killed
 */
function reapFixtureSessions(names) {
  const killed = [];
  for (const name of names) {
    try {
      if (tmux.hasSession(name)) {
        tmux.killSession(name);
        killed.push(name);
      }
    } catch {
      // tmux absent or unreadable — nothing to reap, and a teardown helper
      // must never fail the run it is cleaning up after.
    }
  }
  return killed;
}

module.exports = { installTmuxGuard, removeTmuxGuard, reapFixtureSessions };
