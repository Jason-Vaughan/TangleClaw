'use strict';

/*
 * #1678 — one observation of origin/main per repository, shared by every
 * related session. The properties that matter: N callers cost one remote call,
 * a failure is never served as a fresh SHA, the operator's off switch starts
 * no call at all, and nothing about a clone's path leaves the module.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const uo = require('../lib/upstream-observer');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ID = 'github.com/Owner/Repo';
const MEMBER = { dir: '/clones/one', name: 'Proj-One' };
const ON = { enabled: true };

/**
 * A fake `execFile` for ls-remote. `answer` is stdout, an Error, or a function
 * returning either; calls are recorded with their options.
 * @param {string|Error|Function} answer
 * @returns {{execFile: Function, calls: Array<{args: string[], options: object}>}}
 */
function fakeLsRemote(answer) {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    assert.equal(file, 'git');
    calls.push({ args, options });
    let a = typeof answer === 'function' ? answer(calls.length) : answer;
    setImmediate(() => (a instanceof Error ? cb(a, '') : cb(null, a)));
  };
  return { execFile, calls };
}

const savedExec = uo._internal.execFile;
const savedNow = uo._internal.now;

describe('upstream-observer', () => {
  beforeEach(() => uo._reset());
  afterEach(() => {
    uo._internal.execFile = savedExec;
    uo._internal.now = savedNow;
    uo._reset();
  });

  it('parses ls-remote output and reads an empty answer as "no main", not as a failure', () => {
    assert.deepEqual(uo.parseLsRemote(`${SHA_A}\trefs/heads/main\n`), { sha: SHA_A, found: true });
    assert.deepEqual(uo.parseLsRemote(''), { sha: null, found: false });
    assert.equal(uo.parseLsRemote('garbage line'), null);
  });

  it('asks the remote with ls-remote, network options, and no fetch', async () => {
    const { execFile, calls } = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    const r = await uo.observe(MEMBER);
    assert.equal(r.state, 'measured');
    assert.equal(r.sha, SHA_A);
    assert.deepEqual(calls[0].args, ['--no-optional-locks', 'ls-remote', 'origin', 'refs/heads/main']);
    assert.equal(calls[0].options.cwd, MEMBER.dir);
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(calls[0].options.env.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes');
    assert.ok(calls[0].options.timeout > 0);
    assert.ok(!calls.some((c) => c.args.includes('fetch')), 'nothing is fetched into the clone');
  });

  it('the payload names the observing project, never its directory', async () => {
    uo._internal.execFile = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`).execFile;
    const r = await uo.refresh(ID, MEMBER);
    assert.equal(r.observedFrom, 'Proj-One');
    assert.ok(!JSON.stringify(uo.snapshot(ID, MEMBER, ON)).includes(MEMBER.dir));
  });

  it('many callers for one repository cost one remote call', async () => {
    const { execFile, calls } = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    const first = uo.snapshot(ID, MEMBER, ON);
    assert.equal(first.state, 'pending');
    uo.snapshot(ID, { dir: '/clones/two', name: 'Proj-Two' }, ON);
    await uo.refresh(ID, MEMBER);
    assert.equal(calls.length, 1);
    const a = uo.snapshot(ID, MEMBER, ON);
    const b = uo.snapshot(ID, { dir: '/clones/two', name: 'Proj-Two' }, ON);
    assert.equal(a.sha, SHA_A);
    assert.equal(b.sha, SHA_A, 'every related session reads the same upstream SHA');
    assert.equal(calls.length, 1, 'a fresh cache starts no second call');
  });

  it('re-observes after the TTL', async () => {
    let now = Date.parse('2026-09-22T00:00:00Z');
    uo._internal.now = () => now;
    const { execFile, calls } = fakeLsRemote((n) => `${n === 1 ? SHA_A : SHA_B}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    await uo.refresh(ID, MEMBER);
    now += uo.CACHE_TTL_MS - 1;
    uo.snapshot(ID, MEMBER, ON);
    assert.equal(calls.length, 1);
    now += 1;
    uo.snapshot(ID, MEMBER, ON);
    await uo.refresh(ID, MEMBER);
    assert.equal(calls.length, 2);
    assert.equal(uo.snapshot(ID, MEMBER, ON).sha, SHA_B);
  });

  it('disabled starts no call and says so', () => {
    const { execFile, calls } = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    const r = uo.snapshot(ID, MEMBER, { enabled: false });
    assert.equal(r.state, 'disabled');
    assert.equal(r.sha, null);
    assert.equal(calls.length, 0);
  });

  it('refreshIfStale never calls out when disabled', async () => {
    const { execFile, calls } = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    const r = await uo.refreshIfStale(ID, MEMBER, { enabled: false });
    assert.equal(r.state, 'disabled');
    assert.equal(calls.length, 0);
  });

  it('a failure is unknown with a redacted reason, and the last success is kept only as lastKnown', async () => {
    let fail = false;
    uo._internal.execFile = fakeLsRemote(() => (fail
      ? Object.assign(new Error('x'), { stderr: 'fatal: unable to access https://user:ghp_secret@github.com/Owner/Repo/' })
      : `${SHA_A}\trefs/heads/main\n`)).execFile;
    let now = 0;
    uo._internal.now = () => now;
    await uo.refresh(ID, MEMBER);
    fail = true;
    now += uo.CACHE_TTL_MS;
    await uo.refresh(ID, MEMBER);
    const r = uo.snapshot(ID, MEMBER, ON);
    assert.equal(r.state, 'unknown');
    assert.equal(r.sha, null, 'a failed observation never carries a SHA');
    assert.equal(r.observedAt, null);
    assert.match(r.reason, /ls-remote/);
    assert.ok(!r.reason.includes('ghp_secret'), 'a credential in the error never reaches the payload');
    assert.deepEqual(r.lastKnown, { sha: SHA_A, observedAt: new Date(0).toISOString() });
  });

  it('a remote with no main is "absent", observed, with no SHA', async () => {
    uo._internal.execFile = fakeLsRemote('').execFile;
    const r = await uo.refresh(ID, MEMBER);
    assert.equal(r.state, 'absent');
    assert.equal(r.sha, null);
    assert.ok(r.observedAt);
  });

  it('no identity is unknown and starts nothing', () => {
    const { execFile, calls } = fakeLsRemote(`${SHA_A}\trefs/heads/main\n`);
    uo._internal.execFile = execFile;
    assert.equal(uo.snapshot(null, MEMBER, ON).state, 'unknown');
    assert.equal(calls.length, 0);
  });

  it('under the test runner the default seam refuses to spawn, so an unstubbed caller reads unknown', async () => {
    const r = await uo.observe(MEMBER);
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /spawn blocked/);
  });
});
