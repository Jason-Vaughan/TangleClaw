'use strict';

/**
 * One predicate for "our own timeout killed this" (#894).
 *
 * Three hand-rolled versions of this check lived in the repo and ALL THREE were
 * dead code, for two different reasons:
 *
 *   `execSync`     throws with code 'ETIMEDOUT', signal 'SIGTERM', and NO
 *                  `killed` — that flag belongs to `spawnSync`'s RESULT object,
 *                  never to the error. `lib/tmux.js` tested `err.killed`.
 *   async `exec`   DOES set `killed: true` on the callback error, but its `code`
 *                  is `null`, not `undefined`. Both wrap steps tested
 *                  `err.code === undefined && err.killed`, failing on clause one.
 *
 * EVERY CASE HERE RUNS A REAL PROCESS. A stubbed error object would assert the
 * author's model of these shapes, and this issue exists precisely because three
 * such models were wrong.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, exec } = require('node:child_process');

const { wasTimedOut } = require('../lib/exec-timeout');

/**
 * Run a command under `execSync` with a timeout and hand back what it threw.
 * @param {string} command - Command to run.
 * @param {number} timeout - Milliseconds before the kill.
 * @returns {Error|null} The thrown error, or null when it did not throw.
 */
function syncFailure(command, timeout) {
  try {
    execSync(command, { timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Run a command under async `exec` and hand back the callback's error.
 * @param {string} command - Command to run.
 * @param {number} [timeout] - Milliseconds before the kill; omit for no timeout.
 * @returns {Promise<Error|null>}
 */
function asyncFailure(command, timeout) {
  return new Promise((resolve) => {
    exec(command, timeout ? { timeout } : {}, (err) => resolve(err || null));
  });
}

describe('wasTimedOut (#894)', () => {
  describe('says yes to a kill we caused', () => {
    it('recognises a real execSync timeout', () => {
      const err = syncFailure('sleep 5', 200);

      assert.ok(err, 'precondition: the command was killed');
      // Pinned because it is the whole bug: `killed` is NOT on this error, so a
      // check that reads it compiles, looks right, and never fires.
      assert.equal(err.killed, undefined,
        'execSync leaves `killed` unset — this is why the old tmux check was dead');
      assert.equal(err.code, 'ETIMEDOUT');
      assert.equal(wasTimedOut(err), true);
    });

    it('recognises a real async exec timeout', async () => {
      const err = await asyncFailure('sleep 5', 200);

      assert.ok(err, 'precondition: the command was killed');
      // The mirror-image trap: `killed` IS set here, but `code` is null rather
      // than undefined, so the wrap steps' compound check died on its first
      // clause while looking like it handled exactly this case.
      assert.equal(err.killed, true);
      assert.equal(err.code, null, 'null, NOT undefined — this is why the wrap-step check was dead');
      assert.equal(wasTimedOut(err), true);
    });
  });

  describe('says no to a failure that is the command answering', () => {
    it('rejects an ordinary non-zero exit', async () => {
      const err = await asyncFailure('exit 3');

      assert.ok(err, 'precondition: the command failed');
      assert.equal(err.code, 3);
      assert.equal(wasTimedOut(err), false,
        'a test suite that legitimately failed must never be reported as a timeout');
    });

    it('rejects a command that does not exist', async () => {
      const err = await asyncFailure('tc-no-such-command-894');

      assert.ok(err, 'precondition: the command failed');
      assert.equal(wasTimedOut(err), false);
    });

    it('rejects a null or undefined error', () => {
      assert.equal(wasTimedOut(null), false);
      assert.equal(wasTimedOut(undefined), false);
    });
  });
});
