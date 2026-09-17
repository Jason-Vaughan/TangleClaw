'use strict';

/*
 * The GitHub check for stranded wraps (#1542) and its recorded outcome, including
 * the check that could not run (#1543).
 *
 * `git` and `gh` are faked through `_internal.exec`, so every case decides
 * exactly what GitHub "shows". Every case runs on a temp store, never the live
 * one, and each case gets its own project so activity rows never leak between
 * cases.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const doubles = require('./_exec-results');

const store = require('../lib/store');
const stranded = require('../lib/stranded-wraps');
const check = require('../lib/stranded-check');

const ORIGIN = 'https://github.com/example/sandbox.git';
const TOKEN_ORIGIN = 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/example/sandbox.git';
const REPO = 'github.com/example/sandbox';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const PASS = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' };
const FAIL = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'test' };
const RUNNING = { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '', name: 'test' };

/**
 * A pull request as `gh pr list --json` prints it.
 * @param {number} number
 * @param {string} branch
 * @param {string} state - OPEN | MERGED | CLOSED
 * @param {object[]} [rollup]
 * @param {string} [sha]
 * @returns {object}
 */
function pr(number, branch, state, rollup = [], sha = SHA_A) {
  return {
    number, state, headRefName: branch, headRefOid: sha,
    url: `https://github.com/example/sandbox/pull/${number}`, statusCheckRollup: rollup
  };
}

/**
 * A fake `execFile` wrapper driven by a scenario.
 *
 * - `origin`: the `origin` URL, or null for none; `originError` for a failed exec.
 * - `branches`: `{branch: sha}` on origin, or `{fail: {...}}` for a failed ls-remote.
 * - `prs`: every PR GitHub has; the search and `--head` reads filter it.
 * - `openFail` / `headFail`: an exec result to return for those reads instead.
 * - `hold`: a promise the gh reads wait on, for concurrency cases.
 * @param {object} scenario
 * @returns {{exec: Function, calls: Array<{file: string, args: string[]}>}}
 */
function fakeExec(scenario) {
  const calls = [];
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
  const exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'git' && args[0] === '--version') {
      // A git that would not start in the folder (ENOENT) is modelled as missing everywhere.
      const e = scenario.originError;
      return e && e.errorCode === 'ENOENT' ? e : ok('git version 2.x\n');
    }
    if (file === 'git' && args[0] === 'remote') {
      if (scenario.originError) return scenario.originError;
      if (!scenario.origin) return { exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'", error: new Error('exit 2') };
      return ok(`${scenario.origin}\n`);
    }
    if (file === 'git' && args[0] === 'ls-remote') {
      const b = scenario.branches || {};
      if (b.fail) return b.fail;
      return ok(Object.entries(b).map(([name, sha]) => `${sha}\trefs/heads/${name}`).join('\n') + (Object.keys(b).length ? '\n' : ''));
    }
    if (file === 'gh') {
      if (scenario.hold) await scenario.hold;
      const repoAt = args.indexOf('--repo');
      assert.equal(args[repoAt + 1], scenario.repo || REPO, 'every gh read is pinned to origin');
      const all = scenario.prs || [];
      const head = args.find((a) => a.startsWith('--head='));
      if (head) {
        if (scenario.headFail) return scenario.headFail;
        const branch = head.slice('--head='.length);
        return ok(JSON.stringify(all.filter((p) => p.headRefName === branch)));
      }
      if (scenario.openFail) return scenario.openFail;
      if (scenario.openRaw !== undefined) return ok(scenario.openRaw);
      return ok(JSON.stringify(all.filter((p) => p.state === 'OPEN' && p.headRefName.startsWith('wrap/'))));
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

describe('stranded wraps — GitHub check (#1542, #1543)', () => {
  let storeDir;
  let prevBase;
  let project;
  let seq = 0;
  const realExec = check._internal.exec;
  const realNow = check._internal.now;
  const realQuery = check._internal.query;

  before(() => {
    prevBase = store._getBasePath();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-check-'));
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
    project = store.projects.create({ name: `strand-check-${seq}`, path: dir, engine: 'claude' });
  });

  afterEach(() => {
    check._internal.exec = realExec;
    check._internal.now = realNow;
    check._internal.query = realQuery;
  });

  /**
   * Install a scenario and run one requested check.
   * @param {object} scenario
   * @returns {Promise<object>}
   */
  async function runWith(scenario) {
    check._internal.exec = fakeExec(scenario).exec;
    return check.check(project);
  }

  const recordAt = (branch, headSha, remote = ORIGIN) =>
    stranded.record({ projectId: project.id, remote, branch, headSha });
  const listed = () => stranded.list(project).items.map((i) => i.branch);
  const rowsOf = (eventType) => store.activity.query({ projectId: project.id, eventType, limit: 100 });

  describe('clearing a local item', () => {
    it('clears an item whose branch has a merged PR, and records why', async () => {
      recordAt('wrap/1-x', SHA_A);
      const result = await runWith({ origin: ORIGIN, branches: {}, prs: [pr(7, 'wrap/1-x', 'MERGED', [PASS])] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.cleared.map((c) => [c.branch, c.reason]), [['wrap/1-x', 'merged']]);
      assert.deepEqual(listed(), []);
      const [row] = rowsOf('wrap.strand_cleared');
      assert.deepEqual(
        { ...row.detail, at: typeof row.detail.at },
        { remote: ORIGIN, branch: 'wrap/1-x', headSha: SHA_A, reason: 'merged', prUrl: 'https://github.com/example/sandbox/pull/7', at: 'string' }
      );
    });

    it('clears an item whose branch is gone from origin with no open PR', async () => {
      recordAt('wrap/1-x', SHA_A);
      const result = await runWith({ origin: ORIGIN, branches: {}, prs: [] });
      assert.deepEqual(result.cleared.map((c) => c.reason), ['deleted']);
      assert.deepEqual(listed(), []);
    });

    it('clears an item whose open PR has every check passed', async () => {
      recordAt('wrap/1-x', SHA_A);
      const result = await runWith({
        origin: ORIGIN, branches: { 'wrap/1-x': SHA_A }, prs: [pr(8, 'wrap/1-x', 'OPEN', [PASS, { state: 'SUCCESS' }])]
      });
      assert.deepEqual(result.cleared.map((c) => c.reason), ['green']);
      assert.deepEqual(listed(), []);
    });

    const kept = [
      ['an open PR with a check still running', [pr(8, 'wrap/1-x', 'OPEN', [PASS, RUNNING])]],
      ['an open PR with no checks at all', [pr(8, 'wrap/1-x', 'OPEN', [])]],
      ['an open PR with a failed check', [pr(8, 'wrap/1-x', 'OPEN', [FAIL])]],
      ['a PR closed without merging, branch still there', [pr(8, 'wrap/1-x', 'CLOSED', [PASS])]],
      ['no PR, branch still there', []],
      ['an open PR still running while the branch is missing from origin', [pr(8, 'wrap/1-x', 'OPEN', [RUNNING])], {}]
    ];
    for (const [label, prs, branches = { 'wrap/1-x': SHA_A }] of kept) {
      it(`keeps the item for ${label}`, async () => {
        recordAt('wrap/1-x', SHA_A);
        const result = await runWith({ origin: ORIGIN, branches, prs });
        assert.equal(result.ok, true);
        assert.deepEqual(result.cleared, []);
        assert.deepEqual(listed(), ['wrap/1-x']);
        assert.equal(stranded.blockingItems(project).length, 1, 'it still holds the launch');
      });
    }

    it('lifts the launch and wrap holds once cleared', async () => {
      recordAt('wrap/1-x', SHA_A);
      assert.equal(stranded.launchGate(project, {}).ok, false);
      await runWith({ origin: ORIGIN, branches: {}, prs: [pr(7, 'wrap/1-x', 'MERGED')] });
      assert.equal(stranded.launchGate(project, {}).ok, true);
      assert.equal(stranded.wrapGate(project, undefined).ok, true);
    });

    it('lists the same branch again when it is stranded at a new head', async () => {
      recordAt('wrap/1-x', SHA_A);
      await runWith({ origin: ORIGIN, branches: {}, prs: [] });
      assert.deepEqual(listed(), []);
      recordAt('wrap/1-x', SHA_B);
      const items = stranded.list(project).items;
      assert.deepEqual(items.map((i) => [i.branch, i.headSha]), [['wrap/1-x', SHA_B]]);
      assert.equal(stranded.isBlocking(items[0]), true);
    });

    it('clears a grandfathered item by branch name, with no head SHA', async () => {
      store.activity.log({
        projectId: project.id, eventType: 'wrap.auto_pr',
        detail: { branch: 'wrap/0-old', pushed: true, prUrl: null, stranded: true }
      });
      const result = await runWith({ origin: ORIGIN, branches: {}, prs: [pr(3, 'wrap/0-old', 'MERGED')] });
      assert.deepEqual(result.cleared.map((c) => [c.branch, c.headSha, c.reason]), [['wrap/0-old', null, 'merged']]);
      assert.deepEqual(listed(), []);
    });

    it('clears an acknowledged item too, since it is dealt with either way', async () => {
      recordAt('wrap/1-x', SHA_A);
      stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'op');
      await runWith({ origin: ORIGIN, branches: {}, prs: [pr(7, 'wrap/1-x', 'MERGED')] });
      assert.deepEqual(listed(), []);
    });

    it('leaves an item recorded against another remote alone', async () => {
      recordAt('wrap/1-x', SHA_A, 'https://github.com/example/other.git');
      const result = await runWith({ origin: ORIGIN, branches: {}, prs: [] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.cleared, []);
      assert.deepEqual(listed(), ['wrap/1-x']);
    });

    it('matches an item recorded from a credentialed origin, and never stores the credential', async () => {
      recordAt('wrap/1-x', SHA_A, TOKEN_ORIGIN);
      const result = await runWith({ origin: TOKEN_ORIGIN, branches: {}, prs: [] });
      assert.deepEqual(result.cleared.map((c) => c.reason), ['deleted']);
      const all = JSON.stringify([...rowsOf('wrap.strand_check'), ...rowsOf('wrap.strand_cleared')]);
      assert.ok(!all.includes('ghp_'), 'no token in any row');
    });

    it('reports a clear that could not be saved as a failed check', async () => {
      recordAt('wrap/1-x', SHA_A);
      const realLog = stranded._internal.log;
      stranded._internal.log = (event) => {
        if (event.eventType === 'wrap.strand_cleared') return;
        realLog(event);
      };
      try {
        const result = await runWith({
          origin: ORIGIN, branches: { 'wrap/2-y': SHA_B }, prs: [pr(9, 'wrap/2-y', 'OPEN', [FAIL], SHA_B)]
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /could not be saved/);
        assert.deepEqual(result.cleared, []);
        assert.deepEqual(result.findings, [], 'a failed check reports no findings');
        assert.equal(check.status(project).state, 'failed');
        assert.deepEqual(listed(), ['wrap/1-x']);
      } finally {
        stranded._internal.log = realLog;
      }
    });
  });

  describe('findings', () => {
    it('reports an open wrap PR with a failed check as red CI', async () => {
      const result = await runWith({
        origin: ORIGIN, branches: { 'wrap/2-y': SHA_B }, prs: [pr(9, 'wrap/2-y', 'OPEN', [FAIL], SHA_B)]
      });
      assert.deepEqual(result.findings, [{
        kind: 'red-ci', scope: 'repo', branch: 'wrap/2-y', headSha: SHA_B,
        prNumber: 9, prUrl: 'https://github.com/example/sandbox/pull/9'
      }]);
    });

    it('reports a wrap branch with no PR and no local record as no-PR', async () => {
      const result = await runWith({ origin: ORIGIN, branches: { 'wrap/3-z': SHA_C }, prs: [] });
      assert.deepEqual(result.findings, [{
        kind: 'no-pr', scope: 'repo', branch: 'wrap/3-z', headSha: SHA_C, prNumber: null, prUrl: null
      }]);
    });

    it('does not report a branch whose PR was merged or closed as no-PR', async () => {
      const result = await runWith({
        origin: ORIGIN, branches: { 'wrap/3-z': SHA_C, 'wrap/4-w': SHA_B },
        prs: [pr(4, 'wrap/3-z', 'MERGED', [], SHA_C), pr(5, 'wrap/4-w', 'CLOSED', [], SHA_B)]
      });
      assert.deepEqual(result.findings, []);
    });

    it('does not report a locally recorded branch as no-PR: it is already listed', async () => {
      recordAt('wrap/1-x', SHA_A);
      const result = await runWith({ origin: ORIGIN, branches: { 'wrap/1-x': SHA_A }, prs: [] });
      assert.deepEqual(result.findings, []);
      assert.deepEqual(listed(), ['wrap/1-x']);
    });

    it('ignores branches and PRs outside wrap/', async () => {
      const result = await runWith({
        origin: ORIGIN, branches: {}, prs: [pr(9, 'feat/wrap-thing', 'OPEN', [FAIL])]
      });
      assert.deepEqual(result.findings, []);
    });

    it('never makes a finding block a launch or a wrap', async () => {
      await runWith({
        origin: ORIGIN, branches: { 'wrap/2-y': SHA_B, 'wrap/3-z': SHA_C }, prs: [pr(9, 'wrap/2-y', 'OPEN', [FAIL], SHA_B)]
      });
      assert.equal(check.status(project).findings.length, 2);
      assert.deepEqual(stranded.blockingItems(project), []);
      assert.equal(stranded.launchGate(project, {}).ok, true);
      assert.equal(stranded.wrapGate(project, undefined).ok, true);
    });

    it('stores at most the capped number of findings, with the full total', async () => {
      const branches = {};
      for (let i = 0; i < check._internal.FINDINGS_CAP + 3; i += 1) branches[`wrap/9-${String(i).padStart(2, '0')}`] = SHA_C;
      check._internal.exec = fakeExec({ origin: ORIGIN, branches, prs: [] }).exec;
      const realLookupCap = check._internal.NO_PR_LOOKUP_CAP;
      check._internal.NO_PR_LOOKUP_CAP = 100;
      try {
        await check.check(project);
      } finally {
        check._internal.NO_PR_LOOKUP_CAP = realLookupCap;
      }
      const s = check.status(project);
      assert.equal(s.findings.length, check._internal.FINDINGS_CAP);
      assert.equal(s.findingsTotal, check._internal.FINDINGS_CAP + 3);
      assert.equal(check.summary(s).noPr, check._internal.FINDINGS_CAP + 3, 'the card counts every finding, not the stored ones');
    });

    it('looks up at most the capped number of unrecorded branches, and says how many it skipped', async () => {
      const branches = {};
      for (let i = 0; i < check._internal.NO_PR_LOOKUP_CAP + 2; i += 1) branches[`wrap/8-${String(i).padStart(2, '0')}`] = SHA_C;
      const fake = fakeExec({ origin: ORIGIN, branches, prs: [] });
      check._internal.exec = fake.exec;
      const result = await check.check(project);
      const headReads = fake.calls.filter((c) => c.args.some((a) => a.startsWith('--head='))).length;
      assert.equal(headReads, check._internal.NO_PR_LOOKUP_CAP);
      assert.equal(result.unchecked, 2);
      assert.equal(check.status(project).unchecked, 2);
    });
  });

  describe('a check that could not run', () => {
    const failures = [
      ['gh is not installed', { openFail: doubles.notFound('gh') }, /gh is not installed/],
      ['gh is not signed in', { openFail: { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', error: new Error('exit 4') } }, /gh auth login/],
      ['gh timed out', { openFail: doubles.stopped() }, /timed out/],
      ['gh printed something unparseable', { openRaw: 'not json' }, /could not parse/],
      ['the per-branch read failed', { headFail: { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com', error: new Error('exit 1') } }, /error connecting/],
      ['ls-remote failed', { branches: { fail: { exitCode: 128, stdout: '', stderr: 'fatal: unable to access \'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x\': Could not resolve host', error: new Error('exit 128') } } }, /Could not resolve host/],
      ['git is not installed', { originError: doubles.notFound('git') }, /git is not installed/]
    ];
    for (const [label, extra, reasonRe] of failures) {
      it(`records a failed check with the reason when ${label}, and clears and reports nothing`, async () => {
        recordAt('wrap/1-x', SHA_A);
        const result = await runWith({ origin: ORIGIN, branches: {}, prs: [pr(9, 'wrap/2-y', 'OPEN', [FAIL])], ...extra });
        assert.equal(result.ok, false);
        assert.equal(result.state, 'failed');
        assert.match(result.reason, reasonRe);
        assert.ok(!result.reason.includes('ghp_'), 'the reason is redacted');
        assert.deepEqual(result.cleared, []);
        assert.deepEqual(result.findings, []);
        assert.deepEqual(listed(), ['wrap/1-x']);
        const rows = rowsOf('wrap.strand_check');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].detail.outcome, 'failed');
        assert.equal(rows[0].detail.remote, label === 'git is not installed' ? null : ORIGIN, 'a failed check names the remote it was checking, once known');
        assert.equal(rows[0].detail.ok, false);
        assert.match(rows[0].detail.reason, reasonRe);
        assert.deepEqual(rowsOf('wrap.strand_cleared'), []);
      });
    }

    it('clears nothing from a partial read: a branch missing only because a later read failed stays', async () => {
      recordAt('wrap/1-x', SHA_A);
      // ls-remote answered (and does not list the branch), then gh failed.
      const result = await runWith({
        origin: ORIGIN, branches: {},
        openFail: { exitCode: 1, stdout: '', stderr: 'HTTP 502', error: new Error('exit 1') }
      });
      assert.equal(result.ok, false);
      assert.deepEqual(listed(), ['wrap/1-x']);
    });

    it('records a failed check, not "none", when reading origin timed out', async () => {
      const result = await runWith({
        originError: doubles.stopped()
      });
      assert.equal(result.state, 'failed');
      assert.match(result.reason, /git remote get-url timed out/);
      assert.equal(check.status(project).state, 'failed');
      assert.notEqual(await check.checkAfterLaunch(project), null, 'a timeout never lets a launch skip the next check');
    });

    const enoent = () => (doubles.notFound('git'));

    it('records a failed check naming the folder when a git spawn cannot start but git itself runs', async () => {
      const calls = [];
      check._internal.exec = async (file, args, options) => {
        calls.push([file, ...args, options && options.cwd ? 'in-folder' : 'no-folder']);
        if (args[0] === '--version') return { exitCode: 0, stdout: 'git version 2.x\n', stderr: '', error: null };
        return enoent();
      };
      const result = await check.check(project);
      assert.equal(result.state, 'failed');
      assert.match(result.reason, /project folder is missing/);
      assert.doesNotMatch(result.reason, /git is not installed/);
      assert.deepEqual(calls, [['git', 'remote', 'get-url', 'origin', 'in-folder'], ['git', '--version', 'no-folder']],
        'the only other spawn is the no-folder git probe; nothing reads the folder itself');
    });

    it('says git is not installed when git will not start anywhere', async () => {
      check._internal.exec = async () => enoent();
      const result = await check.check(project);
      assert.match(result.reason, /git is not installed/);
    });

    it('checks the real folder: a project whose path was removed fails with that reason', async () => {
      fs.rmSync(project.path, { recursive: true, force: true });
      const result = await check.check(project);
      assert.match(result.reason, /project folder is missing/);
    });

    it('records a failed check when git could not be started for another reason', async () => {
      const result = await runWith({
        originError: doubles.spawnFailed('git', 'EACCES')
      });
      assert.equal(result.state, 'failed');
    });

    it('records "none", not a failure, for a project with no origin', async () => {
      const result = await runWith({ origin: null });
      assert.equal(result.state, 'none');
      assert.match(result.reason, /no origin remote/);
      assert.equal(check.status(project).state, 'none');
    });

    it('records "none" for an origin that is not on github.com, without asking gh', async () => {
      const fake = fakeExec({ origin: 'git@gitlab.com:example/sandbox.git' });
      check._internal.exec = fake.exec;
      const result = await check.check(project);
      assert.equal(result.state, 'none');
      assert.match(result.reason, /not a GitHub remote/);
      assert.ok(!fake.calls.some((c) => c.file === 'gh'));
    });
  });

  describe('repoOf()', () => {
    const cases = [
      ['https://github.com/example/sandbox.git', 'github.com/example/sandbox'],
      ['https://github.com/example/sandbox', 'github.com/example/sandbox'],
      ['https://github.com/example/sandbox/', 'github.com/example/sandbox'],
      [TOKEN_ORIGIN, 'github.com/example/sandbox'],
      ['git@github.com:example/sandbox.git', 'github.com/example/sandbox'],
      ['ssh://git@github.com/example/sandbox.git', 'github.com/example/sandbox'],
      ['ssh://git@github.com:22/example/sandbox.git', 'github.com/example/sandbox'],
      ['https://www.github.com/example/sandbox.git', 'github.com/example/sandbox']
    ];
    for (const [url, want] of cases) {
      it(`reads ${url}`, () => assert.equal(check.repoOf(url), want));
    }
    for (const url of ['https://gitlab.com/a/b.git', '/srv/git/sandbox.git', 'file:///srv/x.git', 'https://github.com/only-owner', '', null,
      'https://github.com/a/b/c', 'https://github.com/-a/b', 'git@github.com:a/..']) {
      it(`refuses ${JSON.stringify(url)}`, () => assert.equal(check.repoOf(url), null));
    }
  });

  describe('status()', () => {
    it('is "never" with no check on record', () => {
      assert.deepEqual(check.status(project), {
        state: 'never', lastOkAt: null, lastAttemptAt: null, reason: null,
        findings: [], findingsTotal: 0, redCiTotal: 0, noPrTotal: 0, unchecked: 0
      });
    });

    it('is "ok" with the findings of the latest check', async () => {
      await runWith({ origin: ORIGIN, branches: { 'wrap/3-z': SHA_C }, prs: [] });
      const s = check.status(project);
      assert.equal(s.state, 'ok');
      assert.equal(s.lastOkAt, s.lastAttemptAt);
      assert.equal(s.reason, null);
      assert.deepEqual(s.findings.map((f) => f.branch), ['wrap/3-z']);
      assert.equal(s.findingsTotal, 1);
    });

    it('after a failure, is "failed" with the reason, and keeps the older findings with their own time', async () => {
      check._internal.now = () => Date.parse('2026-09-16T10:00:00Z');
      await runWith({ origin: ORIGIN, branches: { 'wrap/3-z': SHA_C }, prs: [] });
      check._internal.now = () => Date.parse('2026-09-16T11:00:00Z');
      await runWith({ origin: ORIGIN, openFail: { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway', error: new Error('x') } });
      const s = check.status(project);
      assert.equal(s.state, 'failed');
      assert.equal(s.lastOkAt, '2026-09-16T10:00:00.000Z');
      assert.equal(s.lastAttemptAt, '2026-09-16T11:00:00.000Z');
      assert.match(s.reason, /HTTP 502/);
      assert.deepEqual(s.findings.map((f) => f.branch), ['wrap/3-z']);
    });

    it('a later successful check replaces older findings', async () => {
      await runWith({ origin: ORIGIN, branches: { 'wrap/3-z': SHA_C }, prs: [] });
      await runWith({ origin: ORIGIN, branches: {}, prs: [] });
      assert.deepEqual(check.status(project).findings, []);
    });
  });

  describe('when a check runs', () => {
    it('joins a check already running for the project instead of starting another', async () => {
      let release;
      const hold = new Promise((r) => { release = r; });
      const fake = fakeExec({ origin: ORIGIN, branches: {}, prs: [], hold });
      check._internal.exec = fake.exec;
      const first = check.check(project);
      const second = check.check(project);
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a, b);
      assert.equal(fake.calls.filter((c) => c.file === 'git' && c.args[0] === 'ls-remote').length, 1);
      assert.equal(rowsOf('wrap.strand_check').length, 1);
    });

    it('starts a new check once the previous one finished', async () => {
      const fake = fakeExec({ origin: ORIGIN, branches: {}, prs: [] });
      check._internal.exec = fake.exec;
      await check.check(project);
      await check.check(project);
      assert.equal(rowsOf('wrap.strand_check').length, 2);
    });

    it('skips a launch check within five minutes of a successful one, but not a requested one', async () => {
      let now = Date.parse('2026-09-16T10:00:00Z');
      check._internal.now = () => now;
      const fake = fakeExec({ origin: ORIGIN, branches: {}, prs: [] });
      check._internal.exec = fake.exec;
      await check.check(project);
      now += 4 * 60 * 1000;
      assert.equal(await check.checkAfterLaunch(project), null);
      assert.equal(rowsOf('wrap.strand_check').length, 1);
      await check.check(project);
      assert.equal(rowsOf('wrap.strand_check').length, 2, 'a requested check always runs');
      now += 6 * 60 * 1000;
      assert.notEqual(await check.checkAfterLaunch(project), null);
      assert.equal(rowsOf('wrap.strand_check').length, 3);
    });

    it('does not skip a launch check after a recent failed one', async () => {
      const fake = fakeExec({ origin: ORIGIN, openFail: { exitCode: 1, stdout: '', stderr: 'HTTP 502', error: new Error('x') } });
      check._internal.exec = fake.exec;
      await check.check(project);
      assert.notEqual(await check.checkAfterLaunch(project), null);
      assert.equal(rowsOf('wrap.strand_check').length, 2);
    });

    it('never rejects, even when the store cannot be read', async () => {
      check._internal.exec = fakeExec({ origin: ORIGIN, branches: {}, prs: [] }).exec;
      const realListQuery = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('database is locked'); };
      check._internal.query = () => { throw new Error('database is locked'); };
      try {
        const result = await check.check(project);
        assert.equal(result.ok, false);
        assert.match(result.reason, /database is locked/);
        assert.equal(await check.checkAfterLaunch(project).then(() => 'resolved'), 'resolved');
      } finally {
        stranded._internal.query = realListQuery;
      }
      assert.equal(rowsOf('wrap.strand_check').length, 2, 'the launch check ran even though the last check could not be read');
    });

    it('records one row per attempt with what the check looked at', async () => {
      recordAt('wrap/1-x', SHA_A);
      await runWith({ origin: TOKEN_ORIGIN, branches: { 'wrap/3-z': SHA_C }, prs: [pr(7, 'wrap/1-x', 'MERGED')] });
      const [row] = rowsOf('wrap.strand_check');
      const d = row.detail;
      assert.equal(d.remote, 'https://github.com/example/sandbox.git');
      assert.equal(d.outcome, 'ok');
      assert.equal(d.ok, true);
      assert.equal(d.reason, null);
      assert.equal(typeof d.at, 'string');
      assert.equal(typeof d.durationMs, 'number');
      assert.equal(d.checked, 1);
      assert.equal(d.cleared, 1);
      assert.equal(d.findingsTotal, 1);
      assert.equal(d.findings.length, 1);
    });
  });

  describe('primeLines() with a GitHub status', () => {
    const item = { branch: 'wrap/1-x', headSha: SHA_A, recordedAt: '2026-09-16T10:00:00Z', acknowledged: false, grandfathered: false };
    const at = '2026-09-16T10:00:00.000Z';
    const findings = [
      { kind: 'red-ci', branch: 'wrap/2-y', prNumber: 9 },
      { kind: 'no-pr', branch: 'wrap/3-z' },
      { kind: 'no-pr', branch: 'wrap/4-w' }
    ];
    const gh = (over) => ({ state: 'ok', lastOkAt: at, lastAttemptAt: at, reason: null, findings: [], findingsTotal: 0, unchecked: 0, ...over });
    const text = (state) => stranded.primeLines({ project: 'demo', ...state }).join('\n');

    it('lists findings with the time of the check', () => {
      const t = text({ items: [], github: gh({ findings, findingsTotal: 3, redCiTotal: 1, noPrTotal: 2 }) });
      assert.match(t, /GitHub, as of 2026-09-16 10:00 UTC: 1 wrap PR with failing checks, 2 wrap branches with no PR/);
      assert.match(t, /`wrap\/2-y` \(PR #9\)/);
      assert.match(t, /`wrap\/3-z`, …\)/);
    });

    it('says nothing extra for a clean check', () => {
      assert.equal(text({ items: [], github: gh() }), text({ items: [] }));
    });

    it('says the latest check failed and when, and marks older findings as of their own time', () => {
      const t = text({
        items: [item],
        github: gh({ state: 'failed', lastAttemptAt: '2026-09-16T11:00:00.000Z', reason: 'gh is not installed', findings, findingsTotal: 3 })
      });
      assert.match(t, /GitHub check: couldn't check at 2026-09-16 11:00 UTC \(gh is not installed\)\. Stranded status may be out of date\./);
      assert.match(t, /GitHub, as of 2026-09-16 10:00 UTC/);
    });

    it('says "not run yet" only when there are local items', () => {
      assert.match(text({ items: [item], github: gh({ state: 'never', lastOkAt: null, lastAttemptAt: null }) }), /GitHub check: not run yet/);
      assert.equal(text({ items: [], github: gh({ state: 'never' }) }), text({ items: [] }));
    });

    it('says why no check is possible only when there are local items', () => {
      assert.match(text({ items: [item], github: gh({ state: 'none', reason: 'no origin remote' }) }), /GitHub check: not possible \(no origin remote\)/);
      assert.equal(text({ items: [], github: gh({ state: 'none', reason: 'no origin remote' }) }), text({ items: [] }));
    });

    it('stays within the section budget with many items and findings', () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ ...item, branch: `wrap/2026091612${String(i).padStart(4, '0')}-a-long-project-slug` }));
      const manyFindings = many.map((i) => ({ kind: 'no-pr', branch: i.branch }));
      const t = text({
        project: 'demo', items: many,
        github: gh({ state: 'failed', reason: 'x'.repeat(500), findings: manyFindings.slice(0, 20), findingsTotal: 30, noPrTotal: 30, unchecked: 4 })
      });
      assert.ok(t.length <= stranded._internal.PRIME_BUDGET_CHARS, `section is ${t.length} chars`);
      assert.match(t, /- …and \d+ more\./, 'what did not fit is counted');
      assert.match(t, /30 wrap branches with no PR/, 'the count is the total, not the stored findings');
      assert.match(t, /couldn't check at/);
    });

    it('is the same text for the same input, whatever the engine', () => {
      const state = { items: [item], github: gh({ findings, findingsTotal: 3 }) };
      assert.equal(text(state), text(state));
      assert.ok(!/CLAUDE\.md|\.claude\//.test(text(state)));
    });
  });

  describe('primeSection() reads the GitHub status', () => {
    it('includes the latest failed check', async () => {
      recordAt('wrap/1-x', SHA_A);
      await runWith({ origin: ORIGIN, openFail: { exitCode: 1, stdout: '', stderr: 'HTTP 502', error: new Error('x') } });
      assert.match(stranded.primeSection(project, () => check.status(project)).join('\n'), /couldn't check at .*HTTP 502/);
    });

    it('renders "could not be read" when the status read throws', () => {
      recordAt('wrap/1-x', SHA_A);
      const text = stranded.primeSection(project, () => { throw new Error('database is locked'); }).join('\n');
      assert.match(text, /could not be read \(database is locked\)/);
    });
  });
});
