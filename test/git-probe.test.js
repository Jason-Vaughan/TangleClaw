'use strict';

/*
 * The one git runner the server's checkout probes share (#1678 R-11). Its
 * guarantees are what every caller relies on without re-checking: no prompt,
 * no lock, a bound on every call, no real spawn under the test runner, and a
 * failure that resolves with a reason instead of throwing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gp = require('../lib/git-probe');

/**
 * Record one call and answer it.
 * @param {string|Error} answer
 * @returns {{execFile: Function, calls: Array<{file: string, args: string[], options: object}>}}
 */
function recorder(answer) {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    calls.push({ file, args, options });
    setImmediate(() => (answer instanceof Error ? cb(answer, '') : cb(null, answer)));
  };
  return { execFile, calls };
}

describe('git-probe: runGit', () => {
  it('a local call is lock-free, prompt-free, C-locale and bounded by the local timeout', async () => {
    const { execFile, calls } = recorder('out\n');
    const r = await gp.runGit(execFile, '/repo', ['status']);
    assert.deepEqual(r, { ok: true, stdout: 'out\n', err: null });
    const c = calls[0];
    assert.equal(c.file, 'git');
    assert.deepEqual(c.args, ['--no-optional-locks', 'status']);
    assert.equal(c.options.cwd, '/repo');
    assert.equal(c.options.timeout, gp.LOCAL_TIMEOUT_MS);
    assert.equal(c.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(c.options.env.LC_ALL, 'C');
    assert.equal(c.options.env.GIT_SSH_COMMAND, undefined, 'a local call does not need ssh settings');
  });

  it('a network call runs ssh in batch mode under the network timeout', async () => {
    const { execFile, calls } = recorder('');
    await gp.runGit(execFile, '/repo', ['ls-remote', 'origin'], { network: true });
    assert.equal(calls[0].options.timeout, gp.NETWORK_TIMEOUT_MS);
    assert.equal(calls[0].options.env.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes');
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  });

  it('an explicit timeout wins', async () => {
    const { execFile, calls } = recorder('');
    await gp.runGit(execFile, '/repo', ['status'], { timeoutMs: 123 });
    assert.equal(calls[0].options.timeout, 123);
  });

  it('a failing call resolves with the error; a throwing seam resolves too', async () => {
    const err = new Error('boom');
    const failed = await gp.runGit(recorder(err).execFile, '/repo', ['status']);
    assert.equal(failed.ok, false);
    assert.equal(failed.err, err);
    const thrown = await gp.runGit(() => { throw new Error('spawn refused'); }, '/repo', ['status']);
    assert.equal(thrown.ok, false);
    assert.match(thrown.err.message, /spawn refused/);
  });

  it('under the test runner the default seam refuses to spawn', async () => {
    assert.equal(gp.spawnBlockedReason(), 'node test runner');
    const r = await gp.runGit(gp.defaultExecFile, process.cwd(), ['status']);
    assert.equal(r.ok, false);
    assert.match(r.err.message, /spawn blocked/);
  });
});

describe('git-probe: isNoGit and failureReason', () => {
  it('only a missing binary or a non-repository is "no git"', () => {
    assert.equal(gp.isNoGit(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })), true);
    assert.equal(gp.isNoGit(Object.assign(new Error('x'), { stderr: 'fatal: not a git repository' })), true);
    assert.equal(gp.isNoGit(Object.assign(new Error('x'), { stderr: 'fatal: index file corrupt' })), false);
    assert.equal(gp.isNoGit(null), false);
  });

  it('names a timeout, keeps the first line, and redacts a credential', () => {
    assert.equal(gp.failureReason('git status', Object.assign(new Error('x'), { killed: true })), 'git status: git timed out');
    assert.equal(gp.failureReason('git status', Object.assign(new Error('x'), { stderr: '\nfatal: bad\nmore' })), 'git status: fatal: bad');
    const r = gp.failureReason('git ls-remote', Object.assign(new Error('x'), {
      stderr: 'fatal: unable to access https://u:ghp_token@github.com/o/r/'
    }));
    assert.ok(!r.includes('ghp_token'));
  });

  it('removes every location git echoes, keeping what went wrong', () => {
    const r = gp.failureReason('git ls-remote', Object.assign(new Error('x'), {
      stderr: "fatal: '/Users/someone/repos/private.git' does not appear to be a git repository"
    }));
    assert.equal(r, "git ls-remote: fatal: '…' does not appear to be a git repository");
    assert.equal(gp.scrubLocations('fatal: unable to access https://github.com/o/r/: timeout'), 'fatal: unable to access <remote> timeout');
    assert.equal(gp.scrubLocations('ssh: connect to git@github.com:o/r.git failed'), 'ssh: connect to <remote> failed');
    assert.equal(gp.scrubLocations('fatal: cannot chdir to /srv/x: denied'), 'fatal: cannot chdir to <path>: denied');
  });
});
