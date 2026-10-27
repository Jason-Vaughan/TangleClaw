'use strict';

/**
 * A wrap step that was KILLED must not be reported as one that FAILED (#894).
 *
 * `defaultExecShell` tested `err.code === undefined && err.killed` for its
 * timeout. Async `exec` does set `killed: true`, but its `code` is `null` rather
 * than `undefined`, so the branch died on its first clause and every killed
 * command fell through to the ordinary path as `exitCode: 1, error: null` —
 * byte-identical to a suite that ran and failed. The operator was then handed
 * "fix the failing test(s) shown above" for tests that had never run.
 *
 * The timeout cases here run a REAL process against a REAL kill, through the
 * production `defaultExecShell`. That mapping is precisely where the defect
 * lived, and an injected error object would have asserted the broken model.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const testStep = require('../lib/wrap-steps/test');
const lintStep = require('../lib/wrap-steps/lint');
const { execFileArgs } = require('../lib/exec');

/** Short enough to keep the suite fast, long enough not to race the spawn. */
const SHORT_TIMEOUT_MS = 300;

/**
 * Poll until `pid` is gone (ESRCH), or fail. The group-kill signal and the
 * shell's own exit (which resolves `execShell`'s promise) race each other, so
 * the grandchild asserted against here is not guaranteed dead the instant the
 * promise resolves — only shortly after.
 * @param {number} pid
 * @param {number} timeoutMs - Budget before this gives up and fails.
 * @returns {Promise<void>}
 */
async function _assertGoneSoon(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      assert.equal(err.code, 'ESRCH', `unexpected error polling pid ${pid}`);
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`pid ${pid} is still alive ${timeoutMs}ms after its command was reported timed out`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('wrap exec shell — a killed command is named as killed (#894)', () => {
  for (const [label, step] of [['test', testStep], ['lint', lintStep]]) {
    describe(`${label} step`, () => {
      it('maps a real timeout to exit 124 and timedOut', async () => {
        const result = await step._internal.execShell('sleep 30', {
          cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
        });

        assert.equal(result.timedOut, true, 'a killed command must be flagged as killed');
        assert.equal(result.exitCode, 124);
        assert.match(result.error, /timed out/);
        // The pre-fix behaviour, pinned so a regression is unmistakable: it
        // resolved exitCode 1 with error null, which no caller could tell apart
        // from an ordinary failing run.
        assert.notEqual(result.exitCode, 1);
        assert.notEqual(result.error, null);
      });

      it('leaves an ordinary non-zero exit alone', async () => {
        const result = await step._internal.execShell('exit 3', { cwd: os.tmpdir() });

        assert.equal(result.timedOut, false, 'a command that answered is not a timeout');
        assert.equal(result.exitCode, 3);
        assert.equal(result.error, null, 'an exit code IS the answer — there is no exec error');
      });

      it('kills a timed-out command\'s whole process group, not just the shell (#1503)', async () => {
        const markerFile = path.join(os.tmpdir(), `tc-exec-group-kill-${label}-${process.pid}.pid`);
        try {
          const result = await step._internal.execShell(
            `sleep 30 & echo $! > ${markerFile}; wait`,
            { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS }
          );

          assert.equal(result.timedOut, true, 'still reported as a timeout, not an ordinary failure');

          const grandchildPid = Number(fs.readFileSync(markerFile, 'utf8').trim());
          assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the backgrounded grandchild pid was captured');

          // The pre-fix behaviour: `exec`'s own `timeout` signals only the shell,
          // so this grandchild (started by `sleep 30 &`, outside the shell's own
          // process) would still be running here.
          await _assertGoneSoon(grandchildPid, 2000);
        } finally {
          fs.rmSync(markerFile, { force: true });
        }
      });

      it('names an output overflow instead of reporting a silent failure', async () => {
        // The reachable non-numeric code, and why `typeof err.code !== 'number'`
        // replaced `err.code === undefined`: a suite chatty enough to exceed
        // maxBuffer fails with code 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', which
        // the old test missed — so it arrived as a bare exit 1 with no error.
        //
        // It is also the near-miss for the timeout predicate: the child IS
        // killed here, but `killed` is left unset and no signal is reported, so
        // this must NOT be reported as a timeout.
        const result = await step._internal.execShell('yes hello | head -c 200000', {
          cwd: os.tmpdir(), maxBufferBytes: 1024
        });

        assert.equal(result.timedOut, false, 'an overflow is not a timeout');
        assert.notEqual(result.exitCode, 0);
        assert.match(result.error, /maxBuffer/, 'the operator must be told what actually happened');
      });
    });
  }

  describe('execFileArgs — the argv-style entry point (#1503)', () => {
    // The shell form above drives the fix through `execShell`. `execFileArgs`
    // shares the same group-kill implementation but is a distinct spawn call
    // (`shell` unset rather than `true`), so it is driven here directly rather
    // than trusted by inference from its sibling.
    it('kills a timed-out argv-form command\'s whole process group too', async () => {
      const markerFile = path.join(os.tmpdir(), `tc-exec-group-kill-argv-${process.pid}.pid`);
      try {
        const result = await execFileArgs(
          'sh', ['-c', `sleep 30 & echo $! > ${markerFile}; wait`],
          { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS }
        );

        assert.equal(result.timedOut, true, 'still reported as a timeout, not an ordinary failure');

        const grandchildPid = Number(fs.readFileSync(markerFile, 'utf8').trim());
        assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the backgrounded grandchild pid was captured');

        await _assertGoneSoon(grandchildPid, 2000);
      } finally {
        fs.rmSync(markerFile, { force: true });
      }
    });
  });
});
