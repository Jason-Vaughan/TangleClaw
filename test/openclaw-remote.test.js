'use strict';

/*
 * #1529 — the non-blocking runners behind the OpenClaw routes that reach a
 * remote host. Driven with REAL processes: the error shapes async `exec` and
 * `execFile` produce are exactly what this repo has modelled wrongly before
 * (lib/exec-timeout.js), so a stub would only assert our own assumptions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const remote = require('../lib/openclaw-remote');
const { wasTimedOut } = require('../lib/exec-timeout');

describe('openclaw-remote runShell (#1529)', () => {
  it('writes input to stdin and resolves stdout', async () => {
    const { stdout } = await remote._runShell('cat', { input: 'discovery script\n' });
    assert.equal(stdout, 'discovery script\n');
  });

  it('rejects a failing command with its stderr and numeric exit code', async () => {
    await assert.rejects(
      remote._runShell('echo nope >&2; exit 3'),
      (err) => {
        assert.equal(err.code, 3);
        assert.equal(err.stderr, 'nope\n');
        assert.equal(wasTimedOut(err), false, 'an ordinary failure is not a timeout');
        return true;
      }
    );
  });

  it('kills a command that outlives its timeout and names the timeout', async () => {
    await assert.rejects(
      remote._runShell('sleep 5', { timeout: 100 }),
      (err) => {
        assert.equal(wasTimedOut(err), true);
        assert.equal(err.timedOut, true);
        assert.equal(err.message, 'timed out after 100ms');
        assert.equal(err.stderr, '', 'nothing was said, so the message carries the timeout');
        return true;
      }
    );
  });

  it('keeps what a timed-out command said, and still names the timeout', async () => {
    await assert.rejects(
      remote._runShell('echo connecting >&2; sleep 5', { timeout: 300 }),
      (err) => {
        assert.equal(err.stderr, 'connecting (timed out after 300ms)');
        return true;
      }
    );
  });

  it('never echoes the command line in a failure message', async () => {
    await assert.rejects(
      remote._runShell('exit 4 # -i /secret/key/path'),
      (err) => {
        assert.equal(err.message, 'exited with status 4');
        assert.doesNotMatch(err.message, /secret/);
        return true;
      }
    );
  });

  it('does not hold the event loop while the command runs', async () => {
    let settled = false;
    const pending = remote._runShell('sleep 0.3').then(() => { settled = true; });
    const ranWhilePending = await new Promise((resolve) => setTimeout(() => resolve(!settled), 20));
    assert.equal(ranWhilePending, true, 'a timer ran while the child was still running');
    await pending;
  });

  it('tolerates a child that exits without reading its input', async () => {
    const { stdout } = await remote._runShell('echo done', { input: 'x'.repeat(1 << 20) });
    assert.equal(stdout, 'done\n');
  });
});

describe('openclaw-remote runFile (#1529)', () => {
  it('passes arguments verbatim, with no shell in between', async () => {
    const hostile = 'a; echo PWNED $(whoami)';
    const { stdout } = await remote._runFile('printf', ['%s', hostile]);
    assert.equal(stdout, hostile);
  });

  it('rejects with the exit code and stderr', async () => {
    await assert.rejects(
      remote._runFile('sh', ['-c', 'echo denied >&2; exit 255']),
      (err) => {
        assert.equal(err.code, 255);
        assert.equal(err.stderr, 'denied\n');
        return true;
      }
    );
  });

  it('reports a timeout it caused, by name', async () => {
    await assert.rejects(
      remote._runFile('sleep', ['5'], { timeout: 100 }),
      (err) => wasTimedOut(err) && typeof err.code !== 'number' && err.message === 'timed out after 100ms'
    );
  });
});
