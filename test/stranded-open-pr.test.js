'use strict';

/*
 * Opening a pull request for a listed stranded wrap from the cleanup path
 * (#1545). `git` and `gh` are faked through `_internal.exec`, so each case
 * decides what GitHub shows. Every case runs on a temp store and its own
 * project, never the live store.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const stranded = require('../lib/stranded-wraps');
const check = require('../lib/stranded-check');

const ORIGIN = 'https://github.com/example/sandbox.git';
const TOKEN_ORIGIN = 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/example/sandbox.git';
const REPO = 'github.com/example/sandbox';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PR_URL = 'https://github.com/example/sandbox/pull/42';
const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
const failed = (stderr, exitCode = 1) => ({ exitCode, stdout: '', stderr, error: new Error(`exit ${exitCode}`) });

/**
 * A fake `execFile` wrapper.
 * - `origin`: URL, or null for no origin
 * - `remoteHeads`: `{branch: sha}` on origin
 * - `openPrs`: open PRs by head
 * - `create`: the `gh pr create` result (default: prints PR_URL)
 * - `fail`: `{origin|lsRemote|prList: execResult}`
 * @param {object} scenario
 * @returns {{exec: Function, calls: Array<{file: string, args: string[]}>}}
 */
function fakeExec(scenario) {
  const calls = [];
  const fail = scenario.fail || {};
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === '--version') {
      return scenario.gitMissing ? fail.origin : ok('git version 2.x\n');
    }
    if (file === 'git' && args[0] === 'remote') {
      if (fail.origin) return fail.origin;
      return scenario.origin ? ok(`${scenario.origin}\n`) : failed("error: No such remote 'origin'", 2);
    }
    if (file === 'git' && args[0] === 'ls-remote') {
      if (fail.lsRemote) return fail.lsRemote;
      const ref = args[3];
      const heads = scenario.remoteHeads || {};
      const lines = Object.entries(heads).filter(([b]) => `refs/heads/${b}` === ref).map(([b, sha]) => `${sha}\trefs/heads/${b}\n`);
      return ok(lines.join(''));
    }
    if (file === 'gh') {
      assert.equal(args[args.indexOf('--repo') + 1], REPO, 'every gh call is pinned to origin');
      if (args[0] === 'pr' && args[1] === 'list') {
        if (fail.prList) return fail.prList;
        const head = args.find((a) => a.startsWith('--head=')).slice('--head='.length);
        return ok(JSON.stringify((scenario.openPrs || []).filter((p) => p.headRefName === head)));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return scenario.create || ok(`\nCreating pull request\n${PR_URL}\n`);
      }
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

describe('stranded wraps — open a PR from the cleanup path (#1545)', () => {
  let storeDir;
  let prevBase;
  let project;
  let seq = 0;
  const realExec = check._internal.exec;
  const realLog = stranded._internal.log;

  before(() => {
    prevBase = store._getBasePath();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-open-pr-'));
    store.close();
    store._setBasePath(storeDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    const dir = fs.mkdtempSync(path.join(storeDir, 'proj-'));
    project = store.projects.create({ name: `open-pr-${seq}`, path: dir, engine: 'claude' });
  });

  afterEach(() => {
    check._internal.exec = realExec;
    stranded._internal.log = realLog;
  });

  const recordFull = (branch = 'wrap/1-x', headSha = SHA_A, remote = ORIGIN) =>
    stranded.record({ projectId: project.id, remote, branch, headSha });
  const recordOlder = (branch = 'wrap/0-old') => store.activity.log({
    projectId: project.id, eventType: 'wrap.auto_pr', detail: { branch, pushed: true, prUrl: null, stranded: true }
  });
  const openedRows = () => store.activity.query({ projectId: project.id, eventType: stranded.EVENT_PR_OPENED, limit: 50 });

  /**
   * Install a scenario and open a PR.
   * @param {object} scenario
   * @param {object} request
   * @param {string|null} [by]
   * @returns {Promise<{result: object, calls: object[]}>}
   */
  async function openWith(scenario, request, by = 'operator') {
    const fake = fakeExec({ origin: ORIGIN, ...scenario });
    check._internal.exec = fake.exec;
    const result = await check.openPr(project, request, by);
    return { result, calls: fake.calls };
  }

  describe('opening', () => {
    it('opens the PR, records who and when, and shows it on the item', async () => {
      recordFull();
      const { result, calls } = await openWith(
        { remoteHeads: { 'wrap/1-x': SHA_A } },
        { branch: 'wrap/1-x', headSha: SHA_A, remote: ORIGIN, confirm: true }
      );
      assert.equal(result.ok, true);
      assert.equal(result.prUrl, PR_URL);
      assert.deepEqual(result.item.prOpened.url, PR_URL);
      assert.equal(result.item.prOpened.by, 'operator');

      const create = calls.find((c) => c.args[1] === 'create');
      assert.deepEqual(create.args.slice(0, 5), ['pr', 'create', '--repo', REPO, '--head=wrap/1-x']);
      assert.equal(create.args[create.args.indexOf('--title') + 1], 'Session wrap on wrap/1-x');
      assert.match(create.args[create.args.indexOf('--body') + 1], /stranded-wrap cleanup by operator/);
      assert.ok(!create.args.includes('--base'), 'the PR targets the default branch');

      const [row] = openedRows();
      assert.deepEqual({ ...row.detail, at: typeof row.detail.at }, {
        remote: ORIGIN, branch: 'wrap/1-x', headSha: SHA_A, prUrl: PR_URL, by: 'operator', at: 'string'
      });
      const [item] = stranded.list(project).items;
      assert.equal(item.prOpened.url, PR_URL);
      assert.equal(item.acknowledged, false, 'opening a PR does not acknowledge the item');
      assert.equal(stranded.blockingItems(project).length, 1, 'nor stop it holding the launch');
    });

    it('opens one for an older record, matched by branch with no head SHA', async () => {
      recordOlder();
      const { result } = await openWith(
        { remoteHeads: { 'wrap/0-old': SHA_B } },
        { branch: 'wrap/0-old', headSha: null, confirm: true },
        null
      );
      assert.equal(result.ok, true);
      assert.equal(result.item.prOpened.by, null);
      assert.equal(openedRows()[0].detail.headSha, null);
    });

    it('matches an origin carrying credentials to the recorded remote', async () => {
      recordFull();
      const { result } = await openWith(
        { origin: TOKEN_ORIGIN, remoteHeads: { 'wrap/1-x': SHA_A } },
        { branch: 'wrap/1-x', headSha: SHA_A, confirm: true }
      );
      assert.equal(result.ok, true);
    });
  });

  describe('refusing before anything is sent', () => {
    const bad = [
      ['confirm is missing', { branch: 'wrap/1-x', headSha: SHA_A }, /confirm: true is required/],
      ['confirm is not literally true', { branch: 'wrap/1-x', headSha: SHA_A, confirm: 'yes' }, /confirm: true is required/],
      ['branch is missing', { headSha: SHA_A, confirm: true }, /branch/],
      ['headSha is missing', { branch: 'wrap/1-x', confirm: true }, /headSha is required/],
      ['remote is not a string', { branch: 'wrap/1-x', headSha: SHA_A, remote: 5, confirm: true }, /remote/]
    ];
    for (const [label, request, message] of bad) {
      it(`answers BAD_REQUEST when ${label}`, async () => {
        recordFull();
        const { result, calls } = await openWith({ remoteHeads: { 'wrap/1-x': SHA_A } }, request);
        assert.equal(result.code, 'BAD_REQUEST');
        assert.match(result.error, message);
        assert.equal(calls.length, 0);
      });
    }

    it('answers NOT_FOUND for an item that is not listed, or at another head', async () => {
      recordFull();
      for (const request of [
        { branch: 'wrap/9-none', headSha: SHA_A, confirm: true },
        { branch: 'wrap/1-x', headSha: SHA_B, confirm: true },
        { branch: 'wrap/1-x', headSha: SHA_A, remote: 'https://github.com/other/repo.git', confirm: true }
      ]) {
        const { result, calls } = await openWith({ remoteHeads: { 'wrap/1-x': SHA_A } }, request);
        assert.equal(result.code, 'NOT_FOUND');
        assert.equal(calls.length, 0);
      }
    });
  });

  describe('refusing after reading GitHub, recording nothing', () => {
    const request = { branch: 'wrap/1-x', headSha: SHA_A, confirm: true };
    const cases = [
      ['origin is missing', { origin: null }, 'NOT_GITHUB', /no origin remote/],
      ['origin is not on GitHub', { origin: 'https://gitlab.com/example/sandbox.git' }, 'NOT_GITHUB', /not a GitHub repository \(https:\/\/gitlab\.com/],
      ['git cannot run', { gitMissing: true, fail: { origin: { exitCode: 1, stdout: '', stderr: '', error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) } } }, 'READ_FAILED', /git is not installed/],
      ['git refuses the folder as a repository', { fail: { origin: failed('fatal: not a git repository (or any of the parent directories): .git', 128) } }, 'READ_FAILED', /git remote get-url failed: fatal: not a git repository/],
      ['the folder is gone', { fail: { origin: { exitCode: 1, stdout: '', stderr: '', error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) } } }, 'READ_FAILED', /project folder is missing/],
      ['origin moved to another repository', { origin: 'https://github.com/example/other.git' }, 'REMOTE_MISMATCH', /recorded on https:\/\/github\.com\/example\/sandbox\.git/],
      ['the branch is gone', { remoteHeads: {} }, 'BRANCH_GONE', /no longer on origin/],
      ['the branch moved', { remoteHeads: { 'wrap/1-x': SHA_B } }, 'BRANCH_MOVED', new RegExp(`at ${SHA_B} on origin, not ${SHA_A}`)],
      ['ls-remote fails', { fail: { lsRemote: failed('fatal: unable to access: Could not resolve host: github.com') } }, 'READ_FAILED', /git ls-remote failed: fatal: unable to access/],
      ['the PR lookup fails', { remoteHeads: { 'wrap/1-x': SHA_A }, fail: { prList: failed('gh: To get started with GitHub CLI, please run:  gh auth login') } }, 'READ_FAILED', /gh auth login/],
      ['an open PR already exists', { remoteHeads: { 'wrap/1-x': SHA_A }, openPrs: [{ number: 7, url: 'https://github.com/example/sandbox/pull/7', headRefName: 'wrap/1-x' }] }, 'PR_EXISTS', /already has an open pull request: https:\/\/github\.com\/example\/sandbox\/pull\/7/],
      ['gh pr create fails', { remoteHeads: { 'wrap/1-x': SHA_A }, create: failed('pull request create failed: GraphQL: No commits between main and wrap/1-x') }, 'CREATE_FAILED', /gh pr create failed: pull request create failed: GraphQL: No commits/],
      ['gh pr create is stopped', { remoteHeads: { 'wrap/1-x': SHA_A }, create: { exitCode: 1, stdout: '', stderr: '', error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) } }, 'CREATE_FAILED', /timed out.*may have reached GitHub/],
      ['gh pr create prints no URL', { remoteHeads: { 'wrap/1-x': SHA_A }, create: ok('done\n') }, 'CREATE_FAILED', /printed no pull request URL/]
    ];
    for (const [label, scenario, code, message] of cases) {
      it(`answers ${code} when ${label}`, async () => {
        recordFull();
        const { result } = await openWith(scenario, request);
        assert.equal(result.ok, false);
        assert.equal(result.code, code);
        assert.match(result.error, message);
        assert.deepEqual(openedRows(), []);
        assert.equal(stranded.list(project).items[0].prOpened, null);
      });
    }

    it('logs a failure it could not avoid, and not a refusal', async () => {
      recordFull();
      const lines = [];
      setConsoleStream({ write: (text) => lines.push(text) });
      setLevel('warn');
      try {
        await openWith({ remoteHeads: { 'wrap/1-x': SHA_A }, create: failed('GraphQL: boom') }, request);
        const afterFailure = lines.join('\n');
        lines.length = 0;
        await openWith({ remoteHeads: {} }, request);
        assert.match(afterFailure, /Could not open a PR for a stranded wrap.*CREATE_FAILED.*GraphQL: boom/s);
        assert.equal(lines.join('\n'), '', 'a refusal such as BRANCH_GONE is not a warning');
      } finally {
        setConsoleStream(null);
        setLevel('error');
      }
    });

    it('never sends gh pr create when a read refused', async () => {
      recordFull();
      const { calls } = await openWith({ remoteHeads: {} }, request);
      assert.ok(!calls.some((c) => c.args[1] === 'create'));
    });

    it('redacts a token that a failure echoes', async () => {
      recordFull();
      const { result } = await openWith(
        { fail: { lsRemote: failed(`fatal: unable to access '${TOKEN_ORIGIN}/': 403`) } },
        request
      );
      assert.equal(result.code, 'READ_FAILED');
      assert.doesNotMatch(result.error, /ghp_/);
    });

    it('answers WRITE_FAILED, with the URL, when the record was not saved', async () => {
      recordFull();
      stranded._internal.log = () => {};
      const { result } = await openWith({ remoteHeads: { 'wrap/1-x': SHA_A } }, request);
      assert.equal(result.code, 'WRITE_FAILED');
      assert.equal(result.prUrl, PR_URL);
      assert.match(result.error, /was opened \(https:\/\/github\.com\/example\/sandbox\/pull\/42\)/);
    });
  });

  it('opens one PR when pressed twice at once', async () => {
    recordFull();
    let release;
    const hold = new Promise((r) => { release = r; });
    const fake = fakeExec({ origin: ORIGIN, remoteHeads: { 'wrap/1-x': SHA_A } });
    check._internal.exec = async (file, args) => {
      if (args[1] === 'create') await hold;
      return fake.exec(file, args);
    };
    const request = { branch: 'wrap/1-x', headSha: SHA_A, confirm: true };
    const first = check.openPr(project, request, 'a');
    const second = check.openPr(project, request, 'b');
    const early = await Promise.race([second, new Promise((r) => setTimeout(() => r('still waiting'), 50))]);
    release();
    assert.equal(early.code, 'IN_PROGRESS', 'the second press is refused at once, not queued behind the first');
    assert.equal((await first).ok, true);
    await second;
    assert.equal(fake.calls.filter((c) => c.args[1] === 'create').length, 1);
    // Once the first finished, a new press is read again (and finds the PR open on GitHub in real life).
    const third = await check.openPr(project, request, 'c');
    assert.notEqual(third.code, 'IN_PROGRESS');
  });

  it('lists the newest PR opened for an item', () => {
    recordFull();
    stranded.recordPrOpened(project, { remote: ORIGIN, branch: 'wrap/1-x', headSha: SHA_A, prUrl: 'https://github.com/example/sandbox/pull/1', by: 'a', at: '2026-09-16T00:00:00.000Z' });
    stranded.recordPrOpened(project, { remote: ORIGIN, branch: 'wrap/1-x', headSha: SHA_A, prUrl: PR_URL, by: 'b', at: '2026-09-16T01:00:00.000Z' });
    const [item] = stranded.list(project).items;
    assert.deepEqual(item.prOpened, { url: PR_URL, by: 'b', at: '2026-09-16T01:00:00.000Z' });
  });

  it('does not show a PR opened at an earlier head on the same branch', () => {
    recordFull('wrap/1-x', SHA_A);
    stranded.recordPrOpened(project, { remote: ORIGIN, branch: 'wrap/1-x', headSha: SHA_A, prUrl: PR_URL, by: 'a', at: '2026-09-16T00:00:00.000Z' });
    recordFull('wrap/1-x', SHA_B);
    const [item] = stranded.list(project).items;
    assert.equal(item.headSha, SHA_B);
    assert.equal(item.prOpened, null);
  });
});
