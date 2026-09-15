'use strict';

// #1516 — the shared GitHub issue-state lookup. gh is faked through
// `_internal.exec`; nothing here reaches the network or the live store.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const ghIssueState = require('../lib/gh-issue-state');

setLevel('error');

/**
 * A fake `gh api repos/{owner}/{repo}/issues/N --jq .state`.
 * @param {Object<string, (string|object)>} answers - Per number: 'open' / 'closed' (stdout), or an exec result
 * @returns {{exec: Function, calls: number[]}}
 */
function fakeGh(answers) {
  const calls = [];
  const exec = async (file, args, options) => {
    assert.equal(file, 'gh');
    assert.equal(args[0], 'api');
    assert.ok(options && options.cwd, 'gh runs in the checkout, where it reads the repo and login');
    const n = Number(args[1].match(/issues\/(\d+)$/)[1]);
    calls.push(n);
    const a = answers[n];
    if (typeof a === 'string') return { exitCode: 0, stdout: `${a}\n`, stderr: '', error: null };
    return a;
  };
  return { exec, calls };
}

describe('gh-issue-state lookup (#1516)', () => {
  let original;
  beforeEach(() => {
    original = ghIssueState._internal.exec;
    ghIssueState.clearCache();
  });
  afterEach(() => {
    ghIssueState._internal.exec = original;
    ghIssueState.clearCache();
  });

  it('reads each issue\'s state through the REST issues endpoint, which also answers for a PR number', async () => {
    const gh = fakeGh({ 1: 'open', 2: 'closed' });
    const seen = [];
    ghIssueState._internal.exec = async (file, args, opts) => { seen.push(args); return gh.exec(file, args, opts); };
    const r = await ghIssueState.lookup('/repo', [1, 2]);
    assert.deepEqual(r, { available: true, states: { 1: 'open', 2: 'closed' } });
    assert.deepEqual(seen[0], ['api', 'repos/{owner}/{repo}/issues/1', '--jq', '.state']);
  });

  it('ignores duplicates and anything that is not a positive integer', async () => {
    const gh = fakeGh({ 5: 'open' });
    ghIssueState._internal.exec = gh.exec;
    const r = await ghIssueState.lookup('/repo', [5, '5', 0, -3, 'abc', 1.5, null]);
    assert.deepEqual(gh.calls, [5]);
    assert.deepEqual(r.states, { 5: 'open' });
  });

  it('caches definite answers per checkout within the TTL, and re-reads after it', async () => {
    const gh = fakeGh({ 7: 'closed' });
    ghIssueState._internal.exec = gh.exec;
    await ghIssueState.lookup('/repo', [7], { now: 1000 });
    await ghIssueState.lookup('/repo', [7], { now: 1000 + ghIssueState.TTL_MS - 1 });
    assert.deepEqual(gh.calls, [7], 'a fresh entry is not re-read');
    await ghIssueState.lookup('/other-checkout', [7], { now: 1000 });
    assert.deepEqual(gh.calls, [7, 7], 'a different checkout may be a different repository');
    await ghIssueState.lookup('/repo', [7], { now: 1000 + ghIssueState.TTL_MS });
    assert.deepEqual(gh.calls, [7, 7, 7], 'an expired entry is re-read');
  });

  it('a number GitHub does not have is unknown for that number only', async () => {
    const gh = fakeGh({
      1: 'closed',
      2: { exitCode: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n', error: null }
    });
    ghIssueState._internal.exec = gh.exec;
    const r = await ghIssueState.lookup('/repo', [1, 2]);
    assert.deepEqual(r, { available: true, states: { 1: 'closed', 2: 'unknown' } });
    await ghIssueState.lookup('/repo', [2]);
    assert.deepEqual(gh.calls, [1, 2, 2], 'unknown is not cached');
  });

  it('gh not installed is unavailable with that reason, never a guessed state', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    ghIssueState._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: err });
    assert.deepEqual(await ghIssueState.lookup('/repo', [1]), { available: false, reason: 'gh is not installed' });
  });

  it('not authenticated is unavailable, with gh\'s own sentence', async () => {
    ghIssueState._internal.exec = async () => ({
      exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', error: null
    });
    const r = await ghIssueState.lookup('/repo', [1]);
    assert.equal(r.available, false);
    assert.match(r.reason, /gh auth login/);
  });

  it('an HTTP 401 is unavailable, not an unknown issue', async () => {
    ghIssueState._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n', error: null });
    const r = await ghIssueState.lookup('/repo', [1]);
    assert.equal(r.available, false);
    assert.match(r.reason, /HTTP 401/);
  });

  it('offline and timed-out calls are unavailable, and a failure is not cached', async () => {
    let offline = true;
    ghIssueState._internal.exec = async () => (offline
      ? { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com\n', error: null }
      : { exitCode: 0, stdout: 'open\n', stderr: '', error: null });
    const first = await ghIssueState.lookup('/repo', [1]);
    assert.deepEqual(first, { available: false, reason: 'error connecting to api.github.com' });
    offline = false;
    assert.deepEqual(await ghIssueState.lookup('/repo', [1]), { available: true, states: { 1: 'open' } },
      'recovering gh answers on the next call, not after the TTL');

    ghIssueState.clearCache();
    const killed = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    ghIssueState._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: killed });
    const t = await ghIssueState.lookup('/repo', [1]);
    assert.equal(t.available, false);
    assert.match(t.reason, /timed out/);
  });

  it('a state it does not recognise is unavailable rather than read as open or closed', async () => {
    ghIssueState._internal.exec = async () => ({ exitCode: 0, stdout: 'merged\n', stderr: '', error: null });
    const r = await ghIssueState.lookup('/repo', [9]);
    assert.equal(r.available, false);
    assert.match(r.reason, /does not know/);
  });

  it('redacts a credential gh echoes in its error', async () => {
    ghIssueState._internal.exec = async () => ({
      exitCode: 1, stdout: '', stderr: 'fatal: could not read https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r\n', error: null
    });
    const r = await ghIssueState.lookup('/repo', [1]);
    assert.equal(r.available, false);
    assert.ok(!r.reason.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), r.reason);
  });

  it('an empty list answers without calling gh', async () => {
    ghIssueState._internal.exec = async () => { throw new Error('must not run'); };
    assert.deepEqual(await ghIssueState.lookup('/repo', []), { available: true, states: {} });
  });
});
