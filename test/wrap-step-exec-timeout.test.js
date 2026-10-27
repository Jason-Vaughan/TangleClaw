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

const { spawn } = require('node:child_process');

const testStep = require('../lib/wrap-steps/test');
const lintStep = require('../lib/wrap-steps/lint');
const exec = require('../lib/exec');
const { execFileArgs } = exec;

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

/**
 * A script for a grandchild that explicitly ignores `SIGTERM` and otherwise
 * just stays alive — only `SIGKILL` can end it.
 */
const TERM_IGNORING_GRANDCHILD_SCRIPT = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';

/**
 * Write a fixture for the "SIGTERM-ignoring descendant" scenario: the
 * grandchild's own script on disk, and the DIRECT-child script (what
 * `execShell`/`execFileArgs` tracks) that spawns it WITHOUT `detached` — so
 * it joins this process's own process group (standard `fork()` inheritance,
 * same as a shell's backgrounded job would) — then writes its pid to
 * `markerFile` and stays alive itself. The direct child does NOT trap
 * `SIGTERM`, so unlike its grandchild it dies immediately once signalled —
 * which is exactly the gap #1503's round 2 is about: the one child Node
 * holds a handle to can die long before the rest of its process group does.
 *
 * Both scripts live in files on disk, referenced by path, rather than being
 * embedded inline or passed through `env`: the `test`/`lint` step wrappers
 * this file drives `execShell` through do not forward `options.env` (only
 * `cwd`/`timeoutMs`/`maxBufferBytes`), and a file path is also one layer
 * simpler to get right than nesting an `-e` script inside a shell-quoted `-e`
 * script.
 *
 * Built entirely in Node rather than shell (`trap '' TERM; ...`) because a
 * shell's own job-control handling of a backgrounded job changes how and
 * when ITS OWN process dies on `SIGTERM` in ways that turned out to mask
 * exactly the race this is meant to expose — confirmed by running this same
 * scenario against the pre-round-2 implementation, where this construction
 * reproduces the bug and the shell-`trap` construction did not.
 *
 * @param {string} suffix - Distinguishes this run's fixture files from a
 *   concurrent one.
 * @returns {{parentScriptFile: string, markerFile: string, cleanup: () => void}}
 */
function _writeTermSurvivingFixture(suffix) {
  const gcScriptFile = path.join(os.tmpdir(), `tc-exec-term-gc-${suffix}.js`);
  const parentScriptFile = path.join(os.tmpdir(), `tc-exec-term-parent-${suffix}.js`);
  const markerFile = path.join(os.tmpdir(), `tc-exec-term-marker-${suffix}.pid`);
  fs.writeFileSync(gcScriptFile, TERM_IGNORING_GRANDCHILD_SCRIPT, 'utf8');
  fs.writeFileSync(parentScriptFile, [
    'const { spawn } = require("child_process");',
    'const fs = require("fs");',
    `const gc = spawn(process.execPath, [${JSON.stringify(gcScriptFile)}], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(markerFile)}, String(gc.pid));`,
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  return {
    parentScriptFile,
    markerFile,
    cleanup: () => {
      for (const f of [gcScriptFile, parentScriptFile, markerFile]) fs.rmSync(f, { force: true });
    }
  };
}

/**
 * Assert that the pid written to `markerFile` is confirmed dead with NO
 * polling grace: #1503's own wording is "whole tree gone BEFORE execShell
 * resolves", so by the time the caller's `await` has already returned, it
 * must already be true — not eventually, after some slack.
 * @param {string} markerFile
 * @returns {void}
 */
function _assertAlreadyDead(markerFile) {
  const pid = Number(fs.readFileSync(markerFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the SIGTERM-ignoring descendant pid was captured');
  assert.throws(() => process.kill(pid, 0), (err) => err.code === 'ESRCH',
    'a SIGTERM-ignoring descendant must be confirmed dead before the promise resolves, not merely signalled');
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

      it('confirms a SIGTERM-ignoring descendant is dead BEFORE the promise resolves, not merely signalled (#1503 round 2)', async () => {
        const { parentScriptFile, markerFile, cleanup } = _writeTermSurvivingFixture(`${label}-${process.pid}`);
        try {
          const result = await step._internal.execShell(
            `"${process.execPath}" "${parentScriptFile}"`,
            { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS }
          );

          assert.equal(result.timedOut, true, 'still reported as a timeout');
          _assertAlreadyDead(markerFile);
        } finally {
          cleanup();
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

      it('kills the whole process group on an output overflow too, not just the one child (#1503 round 2 hardening)', async () => {
        // A grandchild sharing the group but writing to neither pipe. The
        // real pre-hardening symptom here is not (only) the grandchild
        // outliving the result — it is that resolution ITSELF stalls: a lone
        // `SIGTERM` to just the direct shell is not reliably prompt once that
        // shell has an outstanding backgrounded job (confirmed empirically —
        // bash defers signal handling in that state), so without a follow-up
        // `SIGKILL` the "fast bound on a chatty command" that an overflow
        // guard is supposed to be instead becomes a hang tied to the
        // background job's OWN natural lifetime (here, `sleep 30`'s full 30s).
        // The group kill's `SIGKILL` escalation forces this quickly instead.
        const markerFile = path.join(os.tmpdir(), `tc-exec-overflow-group-${label}-${process.pid}.pid`);
        try {
          const startedAt = Date.now();
          const result = await step._internal.execShell(
            `sleep 30 & echo $! > ${markerFile}; yes hello | head -c 200000`,
            { cwd: os.tmpdir(), maxBufferBytes: 1024 }
          );
          const elapsed = Date.now() - startedAt;

          assert.equal(result.timedOut, false, 'an overflow is not a timeout');
          assert.match(result.error, /maxBuffer/);
          assert.ok(elapsed < 5000,
            `overflow handling took ${elapsed}ms — should resolve in well under the backgrounded job's 30s lifetime`);

          const grandchildPid = Number(fs.readFileSync(markerFile, 'utf8').trim());
          assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the backgrounded grandchild pid was captured');

          // Not required to be dead the INSTANT the promise resolves (this
          // cleanup is deliberately fire-and-forget, unlike the timeout
          // path's confirmed-before-resolving guarantee) — but it must still
          // actually happen.
          await _assertGoneSoon(grandchildPid, 2000);
        } finally {
          fs.rmSync(markerFile, { force: true });
        }
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

    it('confirms a SIGTERM-ignoring descendant is dead before resolving, too (#1503 round 2)', async () => {
      const { parentScriptFile, markerFile, cleanup } = _writeTermSurvivingFixture(`argv-${process.pid}`);
      try {
        const result = await execFileArgs(
          process.execPath, [parentScriptFile],
          { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS }
        );

        assert.equal(result.timedOut, true, 'still reported as a timeout');
        _assertAlreadyDead(markerFile);
      } finally {
        cleanup();
      }
    });
  });

  describe('groupKillConfirmed (#1503 round 3)', () => {
    it('is absent from an ordinary successful result — no new noise on the common path', async () => {
      const result = await exec.execShell('exit 0', { cwd: os.tmpdir() });
      assert.equal('groupKillConfirmed' in result, false);
    });

    it('is absent from an ORDINARY timeout, where the group WAS confirmed gone', async () => {
      const result = await exec.execShell('sleep 30', { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS });
      assert.equal(result.timedOut, true);
      assert.equal('groupKillConfirmed' in result, false,
        'the common, successfully-confirmed case must not grow a new key either');
    });

    it('_killProcessGroupUntilGone reports false when the confirm deadline expires with the group still alive', async () => {
      // A SIGKILL that genuinely cannot be confirmed (a process stuck in
      // uninterruptible I/O, say) cannot be produced on demand — simulated
      // instead by stubbing `process.kill`'s existence PROBE (signal `0`,
      // and only for this real process's group) to always answer "still
      // alive", while every other signal this sends — the real `SIGTERM`,
      // the real `SIGKILL` — still reaches the real process untouched. The
      // process genuinely dies from those; this only makes the function
      // unable to find out.
      const child = spawn('sleep', ['5'], { detached: true });
      const pid = child.pid;
      const originalKill = process.kill;
      process.kill = (target, signal) => {
        if (target === -pid && signal === 0) return true;
        return originalKill.call(process, target, signal);
      };
      try {
        const confirmed = await exec._killProcessGroupUntilGone(pid);
        assert.equal(confirmed, false,
          'a confirmation that hit its deadline with the group still (apparently) alive must say so, not report true');
      } finally {
        process.kill = originalKill;
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone for real */ }
      }
    });

    it('execShell surfaces groupKillConfirmed: false end-to-end, with the caveat in the error text too', async () => {
      // Same technique as the direct unit test above, generalized to
      // whichever pid `execShell` spawns (it doesn't expose the pid to the
      // caller): `_groupAlive` is the only thing in this module that ever
      // probes a NEGATIVE pid with signal `0`, so intercepting exactly that
      // shape reaches only the group-existence check, not the real
      // `SIGTERM`/`SIGKILL` this still sends (and which really end the
      // spawned `sleep`) or anything unrelated elsewhere in the process.
      const originalKill = process.kill;
      process.kill = (target, signal) => {
        if (signal === 0 && typeof target === 'number' && target < 0) return true;
        return originalKill.call(process, target, signal);
      };
      try {
        const result = await exec.execShell('sleep 30', { cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS });

        assert.equal(result.timedOut, true, 'it was genuinely timed out, whatever else is uncertain');
        assert.equal(result.groupKillConfirmed, false);
        assert.match(result.error, /could not be confirmed terminated/,
          'a reader of just the error text — describeFailure, a log line — must see the caveat too');
      } finally {
        process.kill = originalKill;
      }
    });
  });
});
