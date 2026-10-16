'use strict';

// #2322: what one advance of a merge queue does. The records are the real
// store on a temporary database; GitHub is faked at the calls `advance` is
// handed, so every test can say exactly which calls were made and in what
// order. Nothing lands unless everything a landing rests on was read in the
// call that merges, and a read that fails changes nothing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const queues = require('../lib/merge-queue-store');
const github = require('../lib/merge-queue-github');
const { REFUSALS } = require('../lib/merge-queue-state');
const { advance, AdvanceRefusal, ADVANCE_REFUSALS, FAILURES, STEPS, cleanupRefFor, cleanupFinished, _internal } = require('../lib/merge-queue');

const OPERATOR = { kind: 'operator', operatorProof: 'verified-session' };
const OWNER = { kind: 'project', projectId: 7, launchId: 'launch-owner' };
const REPO = 'Jason-Vaughan/TangleClaw';

/**
 * A 40-character commit id made of one hex digit.
 * @param {string} digit - One hex digit
 * @returns {string}
 */
function sha(digit) {
  return digit.repeat(40);
}

const HEAD = sha('a');
const BASE = sha('b');
const CANDIDATE = sha('c');
const TREE = sha('d');
const LANDED = sha('e');
const MOVED = sha('f');
const OTHER_TREE = sha('9');

/** The calls that change something on GitHub. */
const WRITES = ['createCandidate', 'discardCandidate', 'mergePull'];

let tmpDir = null;
let queueId = null;
let tick = 0;
let prNumber = 100;

/**
 * A concluded `test` check.
 * @param {string} conclusion - How it concluded
 * @param {string} runId - Its run
 * @returns {object}
 */
function concluded(conclusion, runId = '501') {
  return { status: 'concluded', conclusion, runId, suiteId: '9', completedAt: '2026-10-12T08:15:00Z', app: 'github-actions' };
}

/** A read that failed, with a reason a person can act on. */
const TIMED_OUT = { status: 'unavailable', reason: 'gh api timed out after 10000ms' };

/**
 * A GitHub in which everything a landing rests on holds, with the calls made
 * to it. A field of `over` replaces one call's answer: a value, or a function
 * of the call's arguments.
 * @param {object} [over] - Answers to replace
 * @returns {{github: object, calls: Array<Array>, names: () => string[], set: (name: string, answer: *) => void}}
 */
function fakeGithub(over = {}) {
  const answers = {
    readPull: (repo, number) => ({
      status: 'read', number, state: 'open', merged: false, draft: false, mergeable: true, baseRef: 'main', headSha: HEAD, changedFiles: 2,
      mergeCommitSha: null
    }),
    readRefTip: { status: 'read', sha: BASE },
    readBranchCheck: (repo, branch) => concluded('success', branch === 'main' ? '500' : '501'),
    readCompareFiles: { status: 'read', paths: ['lib/a.js', 'test/a.test.js'] },
    readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: TREE, parents: [BASE, HEAD] }),
    createCandidate: (repo, ref, baseSha, headSha) => ({
      status: 'created', ref, sha: CANDIDATE, tree: TREE, parents: [baseSha, headSha], refCreated: true, stageLeft: false
    }),
    discardCandidate: { status: 'discarded', candidate: 'deleted', stage: 'not-found' },
    mergePull: { status: 'merged', sha: LANDED },
    ...over
  };
  const calls = [];
  const fake = {};
  for (const name of Object.keys(answers)) {
    fake[name] = async (...args) => {
      calls.push([name, ...args]);
      const answer = answers[name];
      return typeof answer === 'function' ? answer(...args) : answer;
    };
  }
  return { github: fake, calls, names: () => calls.map((c) => c[0]), set: (name, answer) => { answers[name] = answer; } };
}

/** The verified binding the owner's inbox is read for. */
const BINDING = { projectId: 7, launchId: 'launch-owner', sessionId: 41 };

/**
 * An inbox check as the API answers it, read and holding nothing unhandled.
 * A field of `over` replaces one of its fields.
 * @param {object} [over] - Fields to replace
 * @returns {() => object} The check
 */
function inboxReads(over = {}) {
  return () => ({
    readable: true, binding: BINDING, checkedAt: '2026-10-15T23:00:00.000Z', listenerState: 'listening', blocking: [], systemExcluded: 0, ...over
  });
}

/**
 * Advance the test queue once.
 * @param {object} gh - From {@link fakeGithub}
 * @param {() => void} [guard] - The caller's guard
 * @param {(() => object)|undefined} [inboxCheck] - The owner's inbox check; a clear inbox when not given
 * @returns {Promise<object>} The advance's answer
 */
function step(gh, guard = () => {}, inboxCheck = inboxReads()) {
  return advance(queues.getQueue(queueId), { actor: OWNER, guard, inboxCheck, github: gh.github });
}

/**
 * Advance once and return the refusal it must be answered with.
 * @param {object} gh - From {@link fakeGithub}
 * @param {string} code - The refusal's code
 * @param {() => void} [guard] - The caller's guard
 * @param {() => object} [inboxCheck] - The owner's inbox check
 * @returns {Promise<AdvanceRefusal>}
 */
async function refusedStep(gh, code, guard, inboxCheck) {
  let caught = null;
  try {
    await step(gh, guard, inboxCheck);
  } catch (err) { // prawduct:allow prawduct/broad-except -- the test asserts on whatever was thrown, on the next lines
    caught = err;
  }
  assert.ok(caught instanceof AdvanceRefusal, `expected a refusal ${code}, got ${caught && caught.stack}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

/**
 * Submit a pull request to the test queue with every gate recorded.
 * @param {object} [overrides] - Fields to change in the submission
 * @returns {object} The entry
 */
function submit(overrides = {}) {
  prNumber += 1;
  const made = queues.submitEntry({
    queueId, prNumber, headSha: HEAD,
    gates: { review: 'critic rev-1', test: 'suite run 42', base: 'main e4dfaf47', operatorRequired: false },
    actor: OWNER, ...overrides
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.entry;
}

/**
 * Submit an entry and advance it to testing, with a candidate made on `BASE`.
 * @param {object} [overrides] - Fields to change in the submission
 * @returns {Promise<object>} The entry, as submitted
 */
async function testing(overrides) {
  const entry = submit(overrides);
  assert.equal((await step(fakeGithub())).step, STEPS.ASSEMBLED);
  return entry;
}

/**
 * The event names of one entry's history, in order.
 * @param {string} entryId - The entry
 * @returns {string[]}
 */
function history(entryId) {
  return queues.listEvents(queueId, { entryId }).map((e) => e.event);
}

/**
 * How many events the queue's history holds: a refused or waiting call adds none.
 * @returns {number}
 */
function eventCount() {
  return queues.listEvents(queueId).length;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-queue-advance-'));
  store._setBasePath(tmpDir);
  store.init();
  tick = 0;
  queues._internal.now = () => new Date(Date.UTC(2026, 9, 12, 5, 0, tick++)).toISOString();
  queueId = queues.createQueue({ repo: REPO, baseBranch: 'main', ownerProjectId: 7, actor: OPERATOR }).queue.queueId;
  _internal.refExistsSeen.clear();
  _internal.branchesGone.clear();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('merge queue advance: from queued to landed (#2322)', () => {
  it('takes an entry from queued to landed in two calls, one step each', async () => {
    const entry = submit();
    const ref = `tc-queue/${entry.entryId}`;
    const gh = fakeGithub();

    const assembled = await step(gh);
    assert.equal(assembled.step, STEPS.ASSEMBLED);
    assert.equal(assembled.changed, true);
    assert.equal(assembled.entryId, entry.entryId);
    assert.deepEqual(gh.calls, [
      ['readPull', REPO, entry.prNumber],
      ['readRefTip', REPO, 'main'],
      ['readBranchCheck', REPO, 'main', BASE, 'test'],
      ['createCandidate', REPO, ref, BASE, HEAD]
    ]);
    const made = queues.getEntry(entry.entryId);
    assert.equal(made.state, 'testing');
    assert.deepEqual(made.candidate, { ref, baseSha: BASE, sha: CANDIDATE, tree: TREE, checkRunId: null, checkConclusion: null });

    gh.calls.length = 0;
    const landed = await step(gh);
    assert.equal(landed.step, STEPS.LANDED);
    assert.deepEqual(landed.landed, { sha: LANDED, tree: TREE, treeMatches: true, baseMatches: true });
    assert.equal(landed.queueHalted, false);
    assert.equal(landed.cleanup, null);
    assert.deepEqual(landed.branches, { candidate: 'deleted', stage: 'not-found' });
    assert.match(landed.message, /LANDED on main as e{40}\. Its tree is the tested candidate's\./);
    assert.match(landed.message, /nothing was deployed and nothing was released\.$/);
    assert.deepEqual(gh.calls, [
      ['readPull', REPO, entry.prNumber],
      ['readRefTip', REPO, 'main'],
      ['readBranchCheck', REPO, ref, CANDIDATE, 'test'],
      ['readBranchCheck', REPO, 'main', BASE, 'test'],
      ['readCompareFiles', REPO, BASE, CANDIDATE],
      ['mergePull', REPO, entry.prNumber, HEAD],
      ['readCommit', REPO, LANDED],
      ['discardCandidate', REPO, ref]
    ]);
    const done = queues.getEntry(entry.entryId);
    assert.equal(done.state, 'landed');
    assert.deepEqual({ sha: done.landed.sha, tree: done.landed.tree, treeMatches: done.landed.treeMatches }, { sha: LANDED, tree: TREE, treeMatches: true });
    assert.equal(done.candidate.checkRunId, '501');
    assert.deepEqual(history(entry.entryId), ['submitted', 'assembly-started', 'candidate-made', 'landing-started', 'landed']);
    assert.equal(queues.getQueue(queueId).halt, null);
  });

  it('a landing is recorded as a merge and as nothing else: the only writes are the merge and the candidate\'s removal', async () => {
    const entry = await testing();
    const gh = fakeGithub();
    const before = eventCount();
    await step(gh);
    assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), ['mergePull', 'discardCandidate']);
    const added = queues.listEvents(queueId).slice(before).map((e) => e.event);
    assert.deepEqual(added, ['landing-started', 'landed']);
    assert.equal(queues.getEntry(entry.entryId).state, 'landed');
  });

  it('answers idle when nothing is waiting, as often as it is asked, and reads nothing', async () => {
    const gh = fakeGithub();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await step(gh), { step: STEPS.IDLE, changed: false, message: 'Nothing is waiting in this queue.' });
    }
    assert.deepEqual(gh.calls, []);
  });

  it('never assembles a second entry while the first holds the queue', async () => {
    const first = await testing();
    const second = submit();
    const gh = fakeGithub({ readBranchCheck: { status: 'running', runId: '501', suiteId: '9', app: 'github-actions' } });
    const waiting = await step(gh);
    assert.equal(waiting.step, STEPS.WAITING);
    assert.equal(waiting.entryId, first.entryId);
    assert.equal(queues.getEntry(second.entryId).state, 'queued');
    assert.ok(!gh.names().includes('createCandidate'));
    assert.ok(gh.calls.every((c) => c[0] !== 'readPull' || c[2] === first.prNumber), 'only the first entry\'s pull request is read');
  });

  it('assembles the next entry on the commit the first one landed as', async () => {
    const first = await testing();
    const second = submit();
    const gh = fakeGithub();
    assert.equal((await step(gh)).step, STEPS.LANDED);
    gh.calls.length = 0;
    gh.set('readRefTip', { status: 'read', sha: LANDED });
    const next = await step(gh);
    assert.equal(next.step, STEPS.ASSEMBLED);
    assert.equal(next.entryId, second.entryId);
    assert.deepEqual(gh.calls[gh.calls.length - 1], ['createCandidate', REPO, `tc-queue/${second.entryId}`, LANDED, HEAD]);
    assert.equal(queues.getEntry(first.entryId).state, 'landed');
  });
});

describe('merge queue advance: every recheck of a landing, each failing alone (#2322)', () => {
  /** What a pull request that no longer stands is, and the failure it is recorded as. */
  const PULL_PROBLEMS = [
    ['closed', { state: 'closed', merged: false }, FAILURES.PR_NOT_OPEN, /is closed\./],
    ['merged by someone else', { state: 'closed', merged: true }, FAILURES.PR_NOT_OPEN, /already merged, and not by this queue/],
    ['retargeted', { baseRef: 'release' }, FAILURES.PR_WRONG_BASE, /now targets release/],
    ['pushed to', { headSha: MOVED }, FAILURES.PR_HEAD_MOVED, /head is f{40}, not the submitted a{40}/],
    ['made a draft', { draft: true }, FAILURES.PR_DRAFT, /made a draft again/]
  ];

  for (const [what, fields, code, words] of PULL_PROBLEMS) {
    it(`fails a testing entry whose pull request was ${what}, removes its candidate and merges nothing`, async () => {
      const entry = await testing();
      const gh = fakeGithub({
        readPull: (repo, number) => ({
          status: 'read', number, state: 'open', merged: false, draft: false, mergeable: true, baseRef: 'main', headSha: HEAD, changedFiles: 2, ...fields
        })
      });
      const failed = await step(gh);
      assert.equal(failed.step, STEPS.FAILED);
      assert.equal(failed.failure.code, code);
      assert.match(failed.failure.detail, words);
      assert.deepEqual(gh.names(), ['readPull', 'discardCandidate']);
      const done = queues.getEntry(entry.entryId);
      assert.equal(done.state, 'failed');
      assert.deepEqual(done.failure, { code, detail: failed.failure.detail });
    });

    it(`fails a queued entry whose pull request was ${what} without touching a branch`, async () => {
      const entry = submit();
      const gh = fakeGithub({
        readPull: (repo, number) => ({
          status: 'read', number, state: 'open', merged: false, draft: false, mergeable: true, baseRef: 'main', headSha: HEAD, changedFiles: 2, ...fields
        })
      });
      const failed = await step(gh);
      assert.equal(failed.failure.code, code);
      assert.equal(failed.branches, null);
      assert.deepEqual(gh.names(), ['readPull']);
      assert.equal(queues.getEntry(entry.entryId).state, 'failed');
    });
  }

  it('fails the entry when its candidate\'s check concluded anything but success, reading the check before the branch is deleted', async () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
      const entry = await testing();
      const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('success', '500') : concluded(conclusion, '777')) });
      const failed = await step(gh);
      assert.equal(failed.step, STEPS.FAILED, conclusion);
      assert.equal(failed.failure.code, REFUSALS.CANDIDATE_NOT_GREEN);
      assert.match(failed.failure.detail, new RegExp(`concluded "${conclusion}" \\(run 777\\)`));
      const names = gh.names();
      assert.ok(names.indexOf('readBranchCheck') < names.indexOf('discardCandidate'), 'the check is read before the discard');
      assert.deepEqual(names, ['readPull', 'readRefTip', 'readBranchCheck', 'discardCandidate']);
      assert.equal(queues.getEntry(entry.entryId).state, 'failed');
    }
  });

  it('waits, changing nothing, while the candidate\'s check has not started or is running', async () => {
    const entry = await testing();
    for (const check of [{ status: 'not-found' }, { status: 'running', runId: '501', suiteId: '9', app: 'github-actions' }]) {
      const gh = fakeGithub({ readBranchCheck: check });
      const before = eventCount();
      const waited = await step(gh);
      assert.equal(waited.step, STEPS.WAITING);
      assert.equal(waited.changed, false);
      assert.match(waited.message, check.status === 'running' ? /is still running \(run 501\)/ : /has not started/);
      assert.equal(eventCount(), before);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing');
      assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), []);
    }
  });

  it('refuses to land on a red base branch, changing nothing, and lands once it is green', async () => {
    const entry = await testing();
    const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('failure', '500') : concluded('success', '501')) });
    const before = eventCount();
    const refusal = await refusedStep(gh, ADVANCE_REFUSALS.BASE_NOT_GREEN);
    assert.match(refusal.message, /check of main on b{40} concluded "failure" \(run 500\)/);
    assert.deepEqual(refusal.details, { baseSha: BASE, check: { conclusion: 'failure', runId: '500' } });
    assert.equal(eventCount(), before);
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
    assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), []);
    assert.equal((await step(fakeGithub())).step, STEPS.LANDED);
  });

  it('waits while the base branch\'s check has not concluded', async () => {
    const entry = await testing();
    for (const check of [{ status: 'not-found' }, { status: 'running', runId: '500', suiteId: '8', app: 'github-actions' }]) {
      const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? check : concluded('success', '501')) });
      const waited = await step(gh);
      assert.equal(waited.step, STEPS.WAITING);
      assert.match(waited.message, /the test check of main at b{40}/);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing');
      assert.ok(!gh.names().includes('mergePull'));
    }
  });

  it('does not wait for the base branch\'s check when the base is this queue\'s own landing of a tree its candidate passed on', async () => {
    await testing();
    assert.equal((await step(fakeGithub())).step, STEPS.LANDED);
    const second = submit();
    const onLanded = fakeGithub({ readRefTip: { status: 'read', sha: LANDED } });
    assert.equal((await step(onLanded)).step, STEPS.ASSEMBLED);
    const gh = fakeGithub({
      readRefTip: { status: 'read', sha: LANDED },
      readBranchCheck: (repo, branch) => (branch === 'main' ? { status: 'running', runId: '600', suiteId: '8', app: 'github-actions' } : concluded('success', '601')),
      mergePull: { status: 'merged', sha: MOVED }
    });
    const landed = await step(gh);
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(queues.getEntry(second.entryId).state, 'landed');
  });

  it('still waits for a pending base check when the base is a landing whose tree was not the tested one', async () => {
    const first = await testing();
    assert.equal((await step(fakeGithub({ readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: OTHER_TREE, parents: [BASE, HEAD] }) }))).queueHalted, true);
    assert.equal(queues.clearHalt(queueId, { actor: OPERATOR, reference: 'checked by hand' }).ok, true);
    assert.equal(queues.getEntry(first.entryId).landed.treeMatches, false);
    const second = submit();
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: LANDED } }))).step, STEPS.ASSEMBLED);
    const gh = fakeGithub({
      readRefTip: { status: 'read', sha: LANDED },
      readBranchCheck: (repo, branch) => (branch === 'main' ? { status: 'not-found' } : concluded('success', '601'))
    });
    assert.equal((await step(gh)).step, STEPS.WAITING);
    assert.equal(queues.getEntry(second.entryId).state, 'testing');
  });

  it('refuses to land an entry whose Operator gate is open, and lands it once the Operator has recorded it', async () => {
    const entry = await testing({ gates: { review: 'r', test: 't', base: 'b', operatorRequired: true } });
    const gh = fakeGithub();
    const before = eventCount();
    const refusal = await refusedStep(gh, REFUSALS.GATES_NOT_MET);
    assert.match(refusal.message, /The Operator gate is required and the Operator has not recorded it\. Nothing was changed: advance again once every gate is recorded\.$/);
    assert.deepEqual(refusal.details.problems.map((p) => p.code), [REFUSALS.OPERATOR_GATE_OPEN]);
    assert.equal(eventCount(), before);
    assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), []);
    assert.ok(!gh.names().includes('readCompareFiles'), 'nothing more is read for an entry that cannot land');
    assert.equal(queues.recordOperatorGate(entry.entryId, { reference: 'Operator, 2026-10-12', actor: OPERATOR }).ok, true);
    assert.equal((await step(fakeGithub())).step, STEPS.LANDED);
  });

  it('fails an entry whose landing would change a release-trigger path, or whose changes could not be read whole, and merges nothing', async () => {
    const cases = [
      [{ status: 'read', paths: ['lib/a.js', 'version.json'] }, /would change version\.json on main, which starts a release/],
      [{ status: 'read', paths: ['.github/workflows/release.yml', 'version.json'] }, /would change \.github\/workflows\/release\.yml and version\.json/],
      [{ status: 'unavailable', reason: 'the comparison lists 300 files, and GitHub lists at most 300' }, /could not be read whole \(the comparison lists 300 files/],
      [TIMED_OUT, /could not be read whole \(gh api timed out/]
    ];
    for (const [files, words] of cases) {
      const entry = await testing();
      const gh = fakeGithub({ readCompareFiles: files });
      const failed = await step(gh);
      assert.equal(failed.step, STEPS.FAILED);
      assert.equal(failed.failure.code, REFUSALS.RELEASE_TRIGGER_CHANGED);
      assert.match(failed.failure.detail, words);
      assert.ok(!gh.names().includes('mergePull'), 'the merge is never asked for');
      assert.equal(queues.getEntry(entry.entryId).state, 'failed');
    }
  });

  it('changes nothing when a read fails, and gives the reader\'s own reason', async () => {
    const reads = [
      ['readPull', TIMED_OUT, /^Pull request \d+ could not be read from GitHub \(gh api timed out after 10000ms\)/],
      ['readRefTip', TIMED_OUT, /^The tip of main could not be read/],
      ['readRefTip', { status: 'not-found' }, /GitHub says no such branch exists/],
      ['readBranchCheck', { status: 'unavailable', reason: 'the commit\'s check suites could not be read whole (100 of 131)' },
        /check of tc-queue\/\S+ on c{40} could not be read from GitHub \(the commit's check suites could not be read whole \(100 of 131\)\)/]
    ];
    const entry = await testing();
    for (const [name, answer, words] of reads) {
      const gh = fakeGithub({ [name]: answer });
      const before = eventCount();
      const refusal = await refusedStep(gh, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
      assert.equal(refusal.status, 503);
      assert.match(refusal.message, words);
      assert.match(refusal.message, /Nothing was changed; advance again once GitHub answers\.$/);
      assert.equal(eventCount(), before, name);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing', name);
      assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), [], name);
    }
    const baseUnread = fakeGithub({
      readBranchCheck: (repo, branch) => (branch === 'main' ? { status: 'unavailable', reason: 'a check run of that name is in a check suite the commit does not list, so its branch is not known' } : concluded('success'))
    });
    const refusal = await refusedStep(baseUnread, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
    assert.match(refusal.message, /^The test check of main on b{40} could not be read from GitHub \(a check run of that name is in a check suite/);
    assert.equal(refusal.details.reason, 'a check run of that name is in a check suite the commit does not list, so its branch is not known');
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });

  it('does not land a candidate whose stored check the records refuse', async () => {
    // The store checks the conclusion again in the transaction that starts the
    // landing; a candidate check with no run id never reaches the merge.
    const entry = await testing();
    const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('success', '500') : { ...concluded('success'), runId: '' }) });
    await refusedStep(gh, REFUSALS.INVALID_INPUT);
    assert.ok(!gh.names().includes('mergePull'));
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });
});

describe('merge queue advance: a branch judged by its own runs (#2322)', () => {
  const realExec = github._internal.exec;

  afterEach(() => { github._internal.exec = realExec; });

  /**
   * Answer `gh api` for the two check lists of a commit, by what each commit carries.
   * @param {Object<string, {runs: object[], suites: object[]}>} commits - By commit id
   * @returns {void}
   */
  function ghChecks(commits) {
    github._internal.exec = async (args) => {
      const pathArg = args.find((a) => a.startsWith('repos/'));
      const [, commit, list] = /commits\/([0-9a-f]{40})\/(check-runs|check-suites)/.exec(pathArg);
      const of = commits[commit];
      const body = list === 'check-runs'
        ? { total_count: of.runs.length, check_runs: of.runs }
        : { total_count: of.suites.length, check_suites: of.suites };
      return { exitCode: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}\n`, stderr: '' };
    };
  }

  /**
   * A projected check run named `test`.
   * @param {number} id - Its id
   * @param {number} suite - The suite it is in
   * @param {string} commit - Its commit
   * @param {string} conclusion - How it concluded
   * @param {string} completedAt - When
   * @returns {object}
   */
  function run(id, suite, commit, conclusion, completedAt) {
    return {
      id, name: 'test', head_sha: commit, status: 'completed', conclusion, started_at: '2026-10-12T08:00:00Z', completed_at: completedAt,
      app: 'github-actions', details_url: `https://github.com/${REPO}/actions/runs/900${id}/job/${id}`, check_suite: suite
    };
  }

  /**
   * A GitHub whose check reads are the real reader over a faked `gh`.
   * @returns {object} From {@link fakeGithub}
   */
  function withRealReader() {
    return fakeGithub({ readBranchCheck: (repo, branch, commit, name) => github.readBranchCheck(repo, branch, commit, name) });
  }

  it('a green run of another branch on a red base does not let a landing through', async () => {
    const entry = await testing();
    const ref = `tc-queue/${entry.entryId}`;
    ghChecks({
      [CANDIDATE]: { runs: [run(1, 11, CANDIDATE, 'success', '2026-10-12T08:15:00Z')], suites: [{ id: 11, head_branch: ref, head_sha: CANDIDATE }] },
      [BASE]: {
        runs: [run(2, 21, BASE, 'failure', '2026-10-12T08:10:00Z'), run(3, 22, BASE, 'success', '2026-10-12T08:20:00Z')],
        suites: [{ id: 21, head_branch: 'main', head_sha: BASE }, { id: 22, head_branch: 'tc-queue/probe', head_sha: BASE }]
      }
    });
    const gh = withRealReader();
    const refusal = await refusedStep(gh, ADVANCE_REFUSALS.BASE_NOT_GREEN);
    assert.equal(refusal.details.check.runId, '2');
    assert.ok(!gh.names().includes('mergePull'));
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });

  it('a red run of another branch on a green base does not block a landing', async () => {
    const entry = await testing();
    const ref = `tc-queue/${entry.entryId}`;
    ghChecks({
      [CANDIDATE]: {
        runs: [run(1, 11, CANDIDATE, 'success', '2026-10-12T08:15:00Z'), run(4, 12, CANDIDATE, 'failure', '2026-10-12T08:30:00Z')],
        suites: [{ id: 11, head_branch: ref, head_sha: CANDIDATE }, { id: 12, head_branch: null, head_sha: CANDIDATE }]
      },
      [BASE]: {
        runs: [run(2, 21, BASE, 'success', '2026-10-12T08:10:00Z'), run(3, 22, BASE, 'failure', '2026-10-12T08:20:00Z')],
        suites: [{ id: 21, head_branch: 'main', head_sha: BASE }, { id: 22, head_branch: 'tc-queue/probe', head_sha: BASE }]
      }
    });
    assert.equal((await step(withRealReader())).step, STEPS.LANDED);
    assert.equal(queues.getEntry(entry.entryId).candidate.checkRunId, '1');
  });

  it('an attribution that cannot be read whole changes nothing, on either branch', async () => {
    const entry = await testing();
    const ref = `tc-queue/${entry.entryId}`;
    const whole = { runs: [run(1, 11, CANDIDATE, 'success', '2026-10-12T08:15:00Z')], suites: [{ id: 11, head_branch: ref, head_sha: CANDIDATE }] };
    const unlisted = (commit) => ({ runs: [run(5, 99, commit, 'success', '2026-10-12T08:15:00Z')], suites: [{ id: 11, head_branch: 'main', head_sha: commit }] });
    for (const commits of [
      { [CANDIDATE]: unlisted(CANDIDATE), [BASE]: { runs: [], suites: [] } },
      { [CANDIDATE]: whole, [BASE]: unlisted(BASE) }
    ]) {
      ghChecks(commits);
      const gh = withRealReader();
      const refusal = await refusedStep(gh, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
      assert.match(refusal.message, /in a check suite the commit does not list, so its branch is not known/);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing');
      assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), []);
    }
  });
});

describe('merge queue advance: making a candidate (#2322)', () => {
  it('does not assemble on a red base branch, and assembles while its check is still pending', async () => {
    const entry = submit();
    const red = fakeGithub({ readBranchCheck: concluded('failure', '500') });
    await refusedStep(red, ADVANCE_REFUSALS.BASE_NOT_GREEN);
    assert.equal(queues.getEntry(entry.entryId).state, 'queued');
    assert.deepEqual(red.names().filter((n) => WRITES.includes(n)), []);
    assert.equal((await step(fakeGithub({ readBranchCheck: { status: 'not-found' } }))).step, STEPS.ASSEMBLED);
  });

  it('changes nothing when a read before the candidate fails', async () => {
    const entry = submit();
    for (const name of ['readPull', 'readRefTip', 'readBranchCheck']) {
      const gh = fakeGithub({ [name]: TIMED_OUT });
      const before = eventCount();
      const refusal = await refusedStep(gh, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
      assert.equal(refusal.details.reason, TIMED_OUT.reason);
      assert.equal(eventCount(), before, name);
      assert.equal(queues.getEntry(entry.entryId).state, 'queued', name);
      assert.ok(!gh.names().includes('createCandidate'), name);
    }
  });

  it('fails an entry that does not merge, or that the base already holds, and the next entry is then at the front', async () => {
    for (const [status, code, words] of [
      ['conflict', FAILURES.CANDIDATE_CONFLICT, /does not merge cleanly into main at b{40}/],
      ['nothing-to-merge', FAILURES.NOTHING_TO_MERGE, /main at b{40} already holds its head/]
    ]) {
      const entry = submit();
      const next = submit();
      const gh = fakeGithub({ createCandidate: (repo, ref) => ({ status, ref, refCreated: false, stageLeft: false }) });
      const failed = await step(gh);
      assert.equal(failed.step, STEPS.FAILED);
      assert.equal(failed.failure.code, code);
      assert.match(failed.failure.detail, words);
      assert.equal(failed.branches, null);
      assert.ok(!gh.names().includes('discardCandidate'), 'the candidate call left no branch to remove');
      assert.equal(queues.getEntry(entry.entryId).state, 'failed');
      assert.deepEqual(history(entry.entryId), ['submitted', 'assembly-started', 'failed']);
      const assembled = await step(fakeGithub());
      assert.equal(assembled.entryId, next.entryId);
      assert.equal(queues.withdrawEntry(next.entryId, { reason: 'clearing for the next case', actor: OWNER }).ok, true);
    }
  });

  it('removes a branch that was already there and makes no candidate; the next advance makes it', async () => {
    const entry = submit();
    const ref = `tc-queue/${entry.entryId}`;
    for (const existing of ['stage', 'candidate']) {
      _internal.refExistsSeen.clear();
      const gh = fakeGithub({ createCandidate: { status: 'ref-exists', ref, existing, refCreated: false, stageLeft: existing === 'stage' } });
      const retry = await step(gh);
      assert.equal(retry.step, STEPS.ASSEMBLY_RETRY);
      assert.match(retry.message, new RegExp(`a ${existing} branch for ${ref} was already there`));
      assert.deepEqual(gh.names().slice(-2), ['createCandidate', 'discardCandidate']);
      assert.equal(queues.getEntry(entry.entryId).state, 'assembling');
      assert.equal(queues.getEntry(entry.entryId).candidate, null);
    }
    const made = await step(fakeGithub());
    assert.equal(made.step, STEPS.ASSEMBLED);
    assert.deepEqual(history(entry.entryId), ['submitted', 'assembly-started', 'candidate-made']);
  });

  it('stops for a person when the branch is there again on the advance after it was removed', async () => {
    const entry = submit();
    const ref = `tc-queue/${entry.entryId}`;
    const answer = { createCandidate: { status: 'ref-exists', ref, existing: 'candidate', refCreated: false, stageLeft: false } };
    assert.equal((await step(fakeGithub(answer))).step, STEPS.ASSEMBLY_RETRY);
    const gh = fakeGithub(answer);
    const before = eventCount();
    const refusal = await refusedStep(gh, ADVANCE_REFUSALS.CANDIDATE_REF_EXISTS);
    assert.match(refusal.message, /is there again after this queue removed it.*this needs a person/);
    assert.deepEqual(refusal.details, { entryId: entry.entryId, ref, existing: 'candidate' });
    assert.ok(!gh.names().includes('discardCandidate'), 'it is not removed a second time');
    assert.equal(eventCount(), before);
    assert.equal(queues.getEntry(entry.entryId).state, 'assembling');
  });

  it('removes what a candidate that could not be made may have left, and only then', async () => {
    const left = [[null, null], [true, false], [false, true], [false, null], [null, false]];
    for (const [refCreated, stageLeft] of left) {
      const entry = submit();
      const gh = fakeGithub({ createCandidate: { status: 'unavailable', reason: 'gh api timed out after 20000ms', refCreated, stageLeft } });
      const refusal = await refusedStep(gh, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
      assert.equal(refusal.status, 503);
      assert.match(refusal.message, /could not be made \(gh api timed out after 20000ms\)\. What it may have left on GitHub was removed/);
      assert.deepEqual(refusal.details.branches, { candidate: 'deleted', stage: 'not-found' });
      assert.equal(gh.names().pop(), 'discardCandidate');
      assert.equal(queues.getEntry(entry.entryId).state, 'assembling');
      assert.equal((await step(fakeGithub())).step, STEPS.ASSEMBLED, 'the entry an earlier call left assembling is assembled by the next');
      assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'clearing for the next case', actor: OWNER }).ok, true);
    }
    const clean = submit();
    const gh = fakeGithub({ createCandidate: { status: 'unavailable', reason: 'GitHub answered HTTP 403', refCreated: false, stageLeft: false } });
    const refusal = await refusedStep(gh, ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
    assert.match(refusal.message, /It left no branch on GitHub/);
    assert.equal(refusal.details.branches, null);
    assert.ok(!gh.names().includes('discardCandidate'));
    assert.equal(queues.getEntry(clean.entryId).state, 'assembling');
  });

  it('fails an assembling entry whose pull request no longer stands only after removing what it may have left', async () => {
    const entry = submit();
    await refusedStep(fakeGithub({ createCandidate: { status: 'unavailable', reason: 'x', refCreated: false, stageLeft: false } }), ADVANCE_REFUSALS.GITHUB_UNAVAILABLE);
    const gh = fakeGithub({
      readPull: (repo, number) => ({ status: 'read', number, state: 'closed', merged: false, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2 })
    });
    const failed = await step(gh);
    assert.equal(failed.failure.code, FAILURES.PR_NOT_OPEN);
    assert.deepEqual(gh.calls, [['readPull', REPO, entry.prNumber], ['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
  });
});

describe('merge queue advance: the base branch moved (#2322)', () => {
  it('discards the candidate and makes a new one on the new base, and does not land the old one', async () => {
    const entry = await testing();
    const ref = `tc-queue/${entry.entryId}`;
    const gh = fakeGithub({ readRefTip: { status: 'read', sha: MOVED } });
    const again = await step(gh);
    assert.equal(again.step, STEPS.REASSEMBLING);
    assert.match(again.message, /main moved to f{40} after its candidate was made on b{40}.*which is not a failure/);
    assert.deepEqual(gh.calls, [['readPull', REPO, entry.prNumber], ['readRefTip', REPO, 'main'], ['discardCandidate', REPO, ref]]);
    const back = queues.getEntry(entry.entryId);
    assert.equal(back.state, 'assembling');
    assert.equal(back.candidate, null);

    gh.calls.length = 0;
    assert.equal((await step(gh)).step, STEPS.ASSEMBLED);
    assert.deepEqual(gh.calls[gh.calls.length - 1], ['createCandidate', REPO, ref, MOVED, HEAD]);
    assert.equal(queues.getEntry(entry.entryId).candidate.baseSha, MOVED);
    assert.deepEqual(history(entry.entryId), ['submitted', 'assembly-started', 'candidate-made', 'candidate-discarded', 'candidate-made']);
    assert.equal((await step(gh)).step, STEPS.LANDED);
  });

  it('keeps the candidate on record while its branches could not be removed', async () => {
    const entry = await testing();
    const gh = fakeGithub({
      readRefTip: { status: 'read', sha: MOVED },
      discardCandidate: { status: 'unavailable', reason: 'tc-queue/x could not be deleted (GitHub answered HTTP 500)', candidate: 'unknown', stage: 'not-found' }
    });
    const refusal = await refusedStep(gh, ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED);
    assert.equal(refusal.status, 503);
    assert.equal(refusal.details.candidate, 'unknown');
    assert.equal(refusal.details.stage, 'not-found');
    const kept = queues.getEntry(entry.entryId);
    assert.equal(kept.state, 'testing');
    assert.equal(kept.candidate.sha, CANDIDATE);
  });
});

describe('merge queue advance: a tree that is not the tested one (#2322)', () => {
  it('records the landing, halts the queue, and refuses every further advance until the Operator clears it', async () => {
    const entry = await testing();
    const next = submit();
    const gh = fakeGithub({ readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: OTHER_TREE, parents: [MOVED, HEAD] }) });
    const landed = await step(gh);
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(landed.queueHalted, true);
    assert.deepEqual(landed.landed, { sha: LANDED, tree: OTHER_TREE, treeMatches: false, baseMatches: false });
    assert.match(landed.message, /ITS TREE IS NOT THE TESTED CANDIDATE'S, so the queue HALTED itself/);
    assert.equal(queues.getEntry(entry.entryId).landed.treeMatches, false);
    assert.equal(queues.getQueue(queueId).halt.code, queues.HALT_TREE_MISMATCH);

    for (let i = 0; i < 2; i++) {
      const halted = fakeGithub();
      const refusal = await refusedStep(halted, REFUSALS.QUEUE_HALTED);
      assert.match(refusal.message, /Nothing advances until the Operator clears the halt \(docs\/merge-queue\.md, "Clearing a halt"\)\.$/);
      assert.deepEqual(halted.calls, [], 'a halted queue reads nothing');
    }
    assert.equal(queues.getEntry(next.entryId).state, 'queued');

    assert.equal(queues.clearHalt(queueId, { actor: OPERATOR, reference: 'main checked by hand' }).ok, true);
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: LANDED } }))).entryId, next.entryId);
  });

  it('refuses to advance a retired queue', async () => {
    assert.equal(queues.retireQueue(queueId, { actor: OPERATOR }).ok, true);
    const gh = fakeGithub();
    await refusedStep(gh, REFUSALS.QUEUE_RETIRED);
    assert.deepEqual(gh.calls, []);
  });
});

describe('merge queue advance: a candidate\'s branches are always removed (#2322)', () => {
  const STUCK = { status: 'unavailable', reason: 'tc-queue/x could not be deleted (GitHub answered HTTP 500)', candidate: 'unknown', stage: 'deleted' };

  it('does not fail an entry while its branches are left, and fails it on the advance that removes them', async () => {
    const entry = await testing();
    const red = (repo, branch) => (branch === 'main' ? concluded('success', '500') : concluded('failure', '777'));
    const stuck = fakeGithub({ readBranchCheck: red, discardCandidate: STUCK });
    const before = eventCount();
    const refusal = await refusedStep(stuck, ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED);
    assert.match(refusal.message, /The entry stays as it is until they are gone: advance again/);
    assert.deepEqual({ candidate: refusal.details.candidate, stage: refusal.details.stage }, { candidate: 'unknown', stage: 'deleted' });
    assert.equal(eventCount(), before);
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');

    const failed = await step(fakeGithub({ readBranchCheck: red }));
    assert.equal(failed.step, STEPS.FAILED);
    assert.equal(queues.getEntry(entry.entryId).state, 'failed');
  });

  it('a landing whose branches could not be removed is still a landing, and the next entry is not assembled until they are gone', async () => {
    const entry = await testing();
    const next = submit();
    const landed = await step(fakeGithub({ discardCandidate: STUCK }));
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(landed.branches, null);
    assert.equal(landed.cleanup.code, ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED);
    assert.match(landed.message, /branches were NOT removed \[CANDIDATE_NOT_DISCARDED\]; the next advance removes them before anything else/);
    assert.equal(queues.getEntry(entry.entryId).state, 'landed');

    const stillStuck = fakeGithub({ discardCandidate: STUCK, readRefTip: { status: 'read', sha: LANDED } });
    const refusal = await refusedStep(stillStuck, ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED);
    assert.equal(refusal.details.entryId, entry.entryId);
    assert.deepEqual(stillStuck.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    assert.equal(queues.getEntry(next.entryId).state, 'queued');

    const gh = fakeGithub({ readRefTip: { status: 'read', sha: LANDED } });
    const cleaned = await step(gh);
    assert.equal(cleaned.step, STEPS.CLEANED_UP);
    assert.equal(cleaned.changed, false);
    assert.equal(cleaned.entryId, entry.entryId);
    assert.deepEqual(gh.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    assert.equal(queues.getEntry(next.entryId).state, 'queued', 'one step per call: the removal is the whole step');
    assert.equal((await step(gh)).step, STEPS.ASSEMBLED);
  });

  it('after a restart removes the latest landing\'s branches once more, which is harmless, and then goes on', async () => {
    const entry = await testing();
    assert.equal((await step(fakeGithub())).step, STEPS.LANDED);
    _internal.branchesGone.clear();
    const gh = fakeGithub({ discardCandidate: { status: 'discarded', candidate: 'not-found', stage: 'not-found' } });
    const cleaned = await step(gh);
    assert.equal(cleaned.step, STEPS.CLEANED_UP);
    assert.match(cleaned.message, new RegExp(`tc-queue/${entry.entryId} not-found, its stage branch not-found`));
    assert.deepEqual(await step(gh), { step: STEPS.IDLE, changed: false, message: 'Nothing is waiting in this queue.' });
  });
});

describe('merge queue advance: what became of a merge that was asked for (#2322)', () => {
  it('records that the merge was not made when GitHub refused it, and keeps the candidate', async () => {
    const answers = [
      { status: 'head-moved', reason: 'GitHub answered HTTP 409: Head branch was modified' },
      { status: 'not-mergeable', reason: 'GitHub answered HTTP 405: Required status check is expected' },
      { status: 'unavailable', reason: 'GitHub answered HTTP 403: Resource not accessible', applied: false }
    ];
    for (const answer of answers) {
      const entry = await testing();
      const gh = fakeGithub({ mergePull: answer });
      const notMade = await step(gh);
      assert.equal(notMade.step, STEPS.LANDING_NOT_MADE);
      assert.ok(notMade.message.includes(`was NOT merged: GitHub did not merge it (${answer.reason})`), notMade.message);
      assert.deepEqual(gh.names().slice(-1), ['mergePull'], 'nothing is read or deleted after a refused merge');
      const back = queues.getEntry(entry.entryId);
      assert.equal(back.state, 'testing');
      assert.equal(back.candidate.sha, CANDIDATE);
      assert.deepEqual(history(entry.entryId).slice(-2), ['landing-started', 'landing-not-made']);
      assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'clearing for the next case', actor: OWNER }).ok, true);
    }
  });

  /** A merge whose answer was not read: it may have happened. */
  const UNREAD_MERGE = { status: 'unavailable', reason: 'gh api timed out after 20000ms', applied: null };

  /**
   * A pull request as read back after a merge was asked for.
   * @param {object} fields - What it reads as
   * @returns {Function}
   */
  const pullReadBack = (fields) => (repo, number) => ({
    status: 'read', number, state: 'open', merged: false, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2,
    mergeCommitSha: null, ...fields
  });

  /** A pull request read back as merged by this queue's request. */
  const MERGED = { state: 'closed', merged: true, mergeCommitSha: LANDED };

  /**
   * A GitHub in which the pull request reads as open until the merge has been
   * asked for, and as `after` from then on.
   * @param {object} after - What the pull request reads as afterwards
   * @param {object} [over] - Other answers to replace
   * @returns {object} From {@link fakeGithub}
   */
  function afterUnreadMerge(after, over = {}) {
    const gh = fakeGithub({ mergePull: UNREAD_MERGE, ...over });
    gh.set('readPull', (repo, number) => (gh.names().includes('mergePull') ? pullReadBack(after)(repo, number) : pullReadBack({})(repo, number)));
    return gh;
  }

  it('reads the pull request after a merge whose answer was not read, and records a landing it finds', async () => {
    const entry = await testing();
    const gh = afterUnreadMerge(MERGED);
    const landed = await step(gh);
    assert.equal(landed.step, STEPS.LANDED);
    assert.deepEqual(landed.landed, { sha: LANDED, tree: TREE, treeMatches: true, baseMatches: true });
    assert.equal(gh.names().filter((n) => n === 'mergePull').length, 1);
    assert.deepEqual(gh.calls.slice(gh.names().indexOf('mergePull')), [
      ['mergePull', REPO, entry.prNumber, HEAD], ['readPull', REPO, entry.prNumber], ['readCommit', REPO, LANDED], ['discardCandidate', REPO, `tc-queue/${entry.entryId}`]
    ]);
    assert.equal(queues.getEntry(entry.entryId).state, 'landed');
  });

  it('records the merge as not made when the pull request reads back open, or closed without merging', async () => {
    for (const [after, words] of [[{}, /read back still open/], [{ state: 'closed' }, /read back closed and not merged/]]) {
      const entry = await testing();
      const notMade = await step(afterUnreadMerge(after));
      assert.equal(notMade.step, STEPS.LANDING_NOT_MADE);
      assert.match(notMade.message, words);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing');
      assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'clearing for the next case', actor: OWNER }).ok, true);
    }
  });

  it('leaves the entry landing when nothing can be read, and the next advance reads the pull request and never merges again', async () => {
    const entry = await testing();
    const gh = fakeGithub({ mergePull: UNREAD_MERGE });
    gh.set('readPull', (repo, number) => (gh.names().includes('mergePull') ? TIMED_OUT : pullReadBack({})(repo, number)));
    const unknown = await step(gh);
    assert.equal(unknown.step, STEPS.LANDING_UNKNOWN);
    assert.equal(unknown.changed, false);
    assert.match(unknown.message, /its merge was asked for, the answer was not read, and the pull request could not be read either/);
    assert.match(unknown.message, /No second merge is asked for\./);
    assert.equal(queues.getEntry(entry.entryId).state, 'landing');

    const stillUnread = fakeGithub({ readPull: TIMED_OUT });
    assert.equal((await step(stillUnread)).step, STEPS.LANDING_UNKNOWN);
    assert.deepEqual(stillUnread.names(), ['readPull']);

    const merged = fakeGithub({ readPull: pullReadBack(MERGED) });
    const landed = await step(merged);
    assert.equal(landed.step, STEPS.LANDED);
    assert.ok(!merged.names().includes('mergePull'), 'a landing entry is never merged a second time');
    assert.deepEqual(merged.names(), ['readPull', 'readCommit', 'discardCandidate']);
    assert.equal(queues.getEntry(entry.entryId).state, 'landed');
  });

  it('a landing entry whose pull request reads back open goes back to testing without a merge being asked for', async () => {
    const entry = await testing();
    const gh = fakeGithub({ mergePull: UNREAD_MERGE });
    gh.set('readPull', (repo, number) => (gh.names().includes('mergePull') ? TIMED_OUT : pullReadBack({})(repo, number)));
    await step(gh);
    const open = fakeGithub();
    const notMade = await step(open);
    assert.equal(notMade.step, STEPS.LANDING_NOT_MADE);
    assert.deepEqual(open.names(), ['readPull']);
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });

  it('does not record a landing on a commit that is not a merge of the submitted head, whichever way it learned of the commit', async () => {
    const notOurs = [[MOVED, sha('1')], [BASE], [BASE, HEAD, sha('1')], [HEAD, BASE]];
    for (const parents of notOurs) {
      for (const lost of [false, true]) {
        const entry = await testing();
        const readCommit = (repo, commit) => ({ status: 'read', sha: commit, tree: TREE, parents });
        const gh = lost ? afterUnreadMerge(MERGED, { readCommit }) : fakeGithub({ readCommit });
        const unknown = await step(gh);
        const where = `${parents.length} parents, answer ${lost ? 'not read' : 'read'}`;
        assert.equal(unknown.step, STEPS.LANDING_UNKNOWN, where);
        assert.equal(unknown.merged, true, where);
        assert.equal(unknown.mergeSha, LANDED, where);
        assert.match(unknown.message, /merged as e{40}, but that commit is not a merge of the submitted head a{40}, so the landing is not recorded\. This needs a person\./, where);
        const left = queues.getEntry(entry.entryId);
        assert.equal(left.state, 'landing', where);
        assert.equal(left.landed, null, where);
        assert.ok(!gh.names().includes('discardCandidate'), where);
        assert.equal(queues.failEntry(entry.entryId, { code: 'TEST_CLEARED', actor: OWNER }).ok, true);
      }
    }
  });

  it('does not take a commit for the landing when GitHub names none for a merged pull request', async () => {
    const entry = await testing();
    const gh = afterUnreadMerge({ state: 'closed', merged: true, mergeCommitSha: null });
    const unknown = await step(gh);
    assert.equal(unknown.step, STEPS.LANDING_UNKNOWN);
    assert.equal(unknown.merged, true);
    assert.match(unknown.message, /the pull request IS MERGED, but GitHub did not say as which commit, so the landing is not recorded\./);
    assert.ok(!gh.names().slice(gh.names().indexOf('mergePull')).includes('readCommit'), 'no commit is read on a guess');
    assert.ok(!gh.names().slice(gh.names().indexOf('mergePull')).includes('readRefTip'), 'the base branch\'s tip never stands in');
    assert.equal(queues.getEntry(entry.entryId).state, 'landing');
  });

  it('never takes the commit GitHub names for an open pull request as a landing', async () => {
    // GitHub gives an open pull request a trial merge commit under the same
    // name. The entry goes back to testing; that commit is not read or recorded.
    const entry = await testing();
    const gh = afterUnreadMerge({ state: 'open', merged: false, mergeCommitSha: LANDED });
    const notMade = await step(gh);
    assert.equal(notMade.step, STEPS.LANDING_NOT_MADE);
    assert.ok(!gh.names().includes('readCommit'));
    const back = queues.getEntry(entry.entryId);
    assert.equal(back.state, 'testing');
    assert.equal(back.landed, null);
  });

  it('records a landing made on a base that had moved, and the tree comparison then decides', async () => {
    const entry = await testing();
    const gh = afterUnreadMerge(MERGED, { readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: OTHER_TREE, parents: [MOVED, HEAD] }) });
    const landed = await step(gh);
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(landed.queueHalted, true);
    assert.equal(landed.landed.baseMatches, false);
    assert.equal(queues.getEntry(entry.entryId).landed.treeMatches, false);

    // The same tree on a moved base is the tested tree: recorded, not halted, and the answer says where it was merged.
    assert.equal(queues.clearHalt(queueId, { actor: OPERATOR, reference: 'checked by hand' }).ok, true);
    const second = submit();
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: LANDED } }))).step, STEPS.ASSEMBLED);
    const same = await step(fakeGithub({
      readRefTip: { status: 'read', sha: LANDED }, mergePull: { status: 'merged', sha: MOVED },
      readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: TREE, parents: [sha('1'), HEAD] })
    }));
    assert.equal(same.step, STEPS.LANDED);
    assert.equal(same.queueHalted, false);
    assert.deepEqual(same.landed, { sha: MOVED, tree: TREE, treeMatches: true, baseMatches: false });
    assert.match(same.message, /Its tree is the tested candidate's, though it was merged onto 1{40} and not the candidate's base e{40}\./);
    assert.equal(queues.getEntry(second.entryId).state, 'landed');
  });

  it('says the pull request was merged when the merge commit then cannot be read, and records the landing on the next advance', async () => {
    const entry = await testing();
    const gh = fakeGithub({ readCommit: TIMED_OUT });
    const unknown = await step(gh);
    assert.equal(unknown.step, STEPS.LANDING_UNKNOWN);
    assert.equal(unknown.merged, true);
    assert.equal(unknown.mergeSha, LANDED);
    assert.match(unknown.message, /the pull request WAS MERGED as e{40}, but that commit could not be read/);
    assert.equal(queues.getEntry(entry.entryId).state, 'landing');
    assert.ok(!gh.names().includes('discardCandidate'), 'the candidate stays until the landing is recorded');

    const next = fakeGithub({ readPull: pullReadBack(MERGED) });
    assert.equal((await step(next)).step, STEPS.LANDED);
    assert.ok(!next.names().includes('mergePull'));
  });
});

describe('merge queue advance: a caller that may no longer act (#2322)', () => {
  /** What the caller's guard throws: the API's own refusal, passed on unchanged. */
  class Fenced extends Error {
    constructor() {
      super('The coordinator epoch does not admit this caller.');
      this.code = 'COORDINATOR_EPOCH_MISMATCH';
    }
  }

  /**
   * A guard that admits the caller until `rotated()` says its context was replaced.
   * @param {() => boolean} rotated - Whether the rotation has begun
   * @returns {{guard: () => void, asked: () => number}}
   */
  function guardUntil(rotated) {
    let asked = 0;
    return { guard: () => { asked += 1; if (rotated()) throw new Fenced(); }, asked: () => asked };
  }

  it('a caller refused from the start changes nothing and writes nothing to GitHub, at either step', async () => {
    const queued = submit();
    const gh = fakeGithub();
    await assert.rejects(() => step(gh, guardUntil(() => true).guard), Fenced);
    assert.equal(queues.getEntry(queued.entryId).state, 'queued');
    assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), []);

    assert.equal((await step(fakeGithub())).step, STEPS.ASSEMBLED);
    const before = eventCount();
    const landing = fakeGithub();
    await assert.rejects(() => step(landing, guardUntil(() => true).guard), Fenced);
    assert.equal(eventCount(), before);
    assert.equal(queues.getEntry(queued.entryId).state, 'testing');
    assert.deepEqual(landing.names().filter((n) => WRITES.includes(n)), []);
  });

  it('a rotation that begins during the landing\'s reads prevents the merge: it is never asked for and the entry is unchanged', async () => {
    for (const during of ['readPull', 'readRefTip', 'readBranchCheck', 'readCompareFiles']) {
      const entry = await testing();
      const gh = fakeGithub();
      const before = eventCount();
      const { guard, asked } = guardUntil(() => gh.names().includes(during));
      await assert.rejects(() => step(gh, guard), Fenced, during);
      assert.ok(asked() >= 1, during);
      assert.ok(!gh.names().includes('mergePull'), `${during}: the merge call is never made`);
      assert.equal(eventCount(), before, during);
      assert.equal(queues.getEntry(entry.entryId).state, 'testing', during);
      assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'clearing for the next case', actor: OWNER }).ok, true);
    }
  });

  it('asks the guard with nothing waited on between its answer and the merge request', async () => {
    await testing();
    const order = [];
    const gh = fakeGithub();
    const mergePull = gh.github.mergePull;
    gh.github.mergePull = (...args) => { order.push('merge'); return mergePull(...args); };
    for (const name of ['readPull', 'readRefTip', 'readBranchCheck', 'readCompareFiles']) {
      const read = gh.github[name];
      gh.github[name] = (...args) => { order.push('read'); return read(...args); };
    }
    await step(gh, () => order.push('guard'));
    const merge = order.indexOf('merge');
    assert.equal(order[merge - 1], 'guard', `the guard is the last thing before the merge request: ${order.join(' ')}`);
  });

  it('a rotation that begins after the merge request was started records the landing and starts nothing else', async () => {
    const entry = await testing();
    const next = submit();
    const gh = fakeGithub();
    const { guard } = guardUntil(() => gh.names().includes('mergePull'));
    const landed = await step(gh, guard);
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(landed.cleanup.code, 'COORDINATOR_EPOCH_MISMATCH');
    assert.equal(landed.branches, null);
    assert.deepEqual(gh.names().slice(gh.names().indexOf('mergePull')), ['mergePull', 'readCommit'], 'no branch is deleted and nothing else is started');
    assert.equal(gh.names().filter((n) => n === 'mergePull').length, 1);
    const done = queues.getEntry(entry.entryId);
    assert.equal(done.state, 'landed');
    assert.equal(done.landed.sha, LANDED);
    assert.equal(queues.getEntry(next.entryId).state, 'queued');

    const replacement = fakeGithub({ readRefTip: { status: 'read', sha: LANDED } });
    assert.equal((await step(replacement)).step, STEPS.CLEANED_UP, 'the admitted context removes the branches first');
    assert.equal((await step(replacement)).entryId, next.entryId);
  });

  it('a rotation that begins after an unread merge request still reconciles it, and never merges again', async () => {
    const entry = await testing();
    const gh = fakeGithub({ mergePull: { status: 'unavailable', reason: 'gh api timed out after 20000ms', applied: null } });
    gh.set('readPull', (repo, number) => ({
      status: 'read', number, state: gh.names().includes('mergePull') ? 'closed' : 'open', merged: gh.names().includes('mergePull'),
      draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2, mergeCommitSha: gh.names().includes('mergePull') ? LANDED : null
    }));
    const landed = await step(gh, guardUntil(() => gh.names().includes('mergePull')).guard);
    assert.equal(landed.step, STEPS.LANDED);
    assert.equal(gh.names().filter((n) => n === 'mergePull').length, 1);
    assert.equal(queues.getEntry(entry.entryId).state, 'landed');
  });

  it('a rotation that begins while the candidate is being made leaves it unrecorded, and the admitted context starts over', async () => {
    const entry = submit();
    const gh = fakeGithub();
    await assert.rejects(() => step(gh, guardUntil(() => gh.names().includes('createCandidate')).guard), Fenced);
    const left = queues.getEntry(entry.entryId);
    assert.equal(left.state, 'assembling');
    assert.equal(left.candidate, null);

    const ref = `tc-queue/${entry.entryId}`;
    const found = fakeGithub({ createCandidate: { status: 'ref-exists', ref, existing: 'candidate', refCreated: false, stageLeft: false } });
    assert.equal((await step(found)).step, STEPS.ASSEMBLY_RETRY);
    assert.equal((await step(fakeGithub())).step, STEPS.ASSEMBLED);
  });

  it('a rotation that begins while a branch is being deleted leaves the entry where it was', async () => {
    const entry = await testing();
    const gh = fakeGithub({ readRefTip: { status: 'read', sha: MOVED } });
    await assert.rejects(() => step(gh, guardUntil(() => gh.names().includes('discardCandidate')).guard), Fenced);
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });

  it('the guard is asked before the branch deletion that fails an entry, so a refused caller deletes nothing', async () => {
    const entry = await testing();
    const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('success') : concluded('failure')) });
    await assert.rejects(() => step(gh, guardUntil(() => gh.names().includes('readBranchCheck')).guard), Fenced);
    assert.ok(!gh.names().includes('discardCandidate'));
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });
});

describe('merge queue advance: an unhandled message in the owner\'s inbox refuses the landing (#2372)', () => {
  /**
   * Assert a refused landing changed nothing: the entry is still testing on its
   * candidate, no event was added, and nothing was written to GitHub.
   * @param {object} entry - The entry
   * @param {object} candidate - Its candidate before the call
   * @param {number} before - The event count before the call
   * @param {object} gh - From {@link fakeGithub}
   * @returns {void}
   */
  function unchanged(entry, candidate, before, gh) {
    const after = queues.getEntry(entry.entryId);
    assert.equal(after.state, 'testing');
    assert.deepEqual(after.candidate, candidate);
    assert.equal(eventCount(), before, 'no event is appended');
    assert.deepEqual(gh.names().filter((n) => WRITES.includes(n)), [], 'no merge request and no branch deletion');
  }

  for (const [label, check] of [
    ['an inbox that could not be read', inboxReads({ readable: false, reason: 'the session\'s Medusa listener is off, not listening' })],
    ['an advance given no inbox check at all', undefined],
    ['an inbox check that answers nothing', () => null]
  ]) {
    it(`${label} refuses AUTHORIZER_INBOX_UNREADABLE and changes nothing`, async () => {
      const entry = await testing();
      const candidate = queues.getEntry(entry.entryId).candidate;
      const before = eventCount();
      const gh = fakeGithub();
      const ctx = { actor: OWNER, guard: () => {}, github: gh.github };
      if (check !== undefined) ctx.inboxCheck = check;
      let caught = null;
      try {
        await advance(queues.getQueue(queueId), ctx);
      } catch (err) { // prawduct:allow prawduct/broad-except -- the test asserts on whatever was thrown, on the next lines
        caught = err;
      }
      assert.ok(caught instanceof AdvanceRefusal, String(caught && caught.stack));
      assert.equal(caught.code, ADVANCE_REFUSALS.AUTHORIZER_INBOX_UNREADABLE);
      assert.equal(caught.details.entryId, entry.entryId);
      unchanged(entry, candidate, before, gh);
    });
  }

  it('an unhandled message refuses AUTHORIZER_MESSAGE_UNREAD, naming its id and sender only, and changes nothing', async () => {
    const entry = await testing();
    const candidate = queues.getEntry(entry.entryId).candidate;
    const before = eventCount();
    const gh = fakeGithub();
    const blocking = [{ id: 'msg-approve-2', from: 'tc-pm-1' }, { id: 'msg-object-1', from: 'tc-architect-1' }];
    const refused = await refusedStep(gh, ADVANCE_REFUSALS.AUTHORIZER_MESSAGE_UNREAD, undefined, inboxReads({ blocking }));
    assert.deepEqual(refused.details.messages, blocking);
    assert.match(refused.message, /msg-approve-2 from tc-pm-1/);
    assert.match(refused.message, /Nothing was changed/);
    unchanged(entry, candidate, before, gh);
  });

  it('once the message is handled, the next advance lands and records the check without any message', async () => {
    const entry = await testing();
    await refusedStep(fakeGithub(), ADVANCE_REFUSALS.AUTHORIZER_MESSAGE_UNREAD, undefined,
      inboxReads({ blocking: [{ id: 'msg-1', from: 'tc-pm-1' }] }));
    const landed = await step(fakeGithub(), undefined, inboxReads({ systemExcluded: 2 }));
    assert.equal(landed.step, STEPS.LANDED);
    const started = queues.listEvents(queueId, { entryId: entry.entryId }).find((e) => e.event === 'landing-started');
    assert.deepEqual(started.detail, {
      headSha: HEAD, baseSha: BASE, candidateSha: CANDIDATE, candidateCheck: { runId: '501', conclusion: 'success' },
      inboxCheck: { binding: BINDING, checkedAt: '2026-10-15T23:00:00.000Z', listenerState: 'listening', systemExcluded: 2 }
    });
    assert.ok(!JSON.stringify(started.detail).includes('msg-1'), 'no message id or text is recorded');
  });

  it('reads the inbox, then asks the guard, then sends the merge request, with nothing awaited between them', async () => {
    await testing();
    const order = [];
    const gh = fakeGithub();
    for (const name of Object.keys(gh.github)) {
      const call = gh.github[name];
      gh.github[name] = (...args) => { order.push(name); return call(...args); };
    }
    const check = inboxReads();
    await step(gh, () => order.push('guard'), () => { order.push('inbox'); return check(); });
    const merge = order.indexOf('mergePull');
    assert.deepEqual(order.slice(merge - 2, merge + 1), ['inbox', 'guard', 'mergePull'], order.join(' '));
    assert.equal(order.filter((n) => n === 'inbox').length, 1, 'the inbox is read once, for the landing');
  });

  it('a guard that refuses after a clear inbox still prevents the merge', async () => {
    const entry = await testing();
    const candidate = queues.getEntry(entry.entryId).candidate;
    const before = eventCount();
    const gh = fakeGithub();
    let read = false;
    const fenced = new Error('fenced');
    await assert.rejects(() => step(gh, () => { if (read) throw fenced; }, () => { read = true; return inboxReads()(); }), (err) => err === fenced);
    unchanged(entry, candidate, before, gh);
  });

  it('does not stop the steps that merge nothing: assembly, a discard on a moved base, a failure, and cleanup', async () => {
    const blocked = inboxReads({ blocking: [{ id: 'msg-1', from: 'tc-pm-1' }] });
    let asked = 0;
    const counting = () => { asked += 1; return blocked(); };

    const first = submit();
    assert.equal((await step(fakeGithub(), undefined, counting)).step, STEPS.ASSEMBLED);
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: MOVED } }), undefined, counting)).step, STEPS.REASSEMBLING);
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: MOVED } }), undefined, counting)).step, STEPS.ASSEMBLED);
    const red = fakeGithub({ readRefTip: { status: 'read', sha: MOVED }, readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('success') : concluded('failure')) });
    assert.equal((await step(red, undefined, counting)).step, STEPS.FAILED);
    assert.equal(queues.getEntry(first.entryId).state, 'failed');

    await testing();
    const kept = fakeGithub({ discardCandidate: { status: 'unavailable', reason: 'gh api timed out after 10000ms', candidate: 'left', stage: 'not-found' } });
    assert.equal((await step(kept, undefined, inboxReads())).cleanup.code, ADVANCE_REFUSALS.CANDIDATE_NOT_DISCARDED);
    assert.equal((await step(fakeGithub({ readRefTip: { status: 'read', sha: LANDED } }), undefined, counting)).step, STEPS.CLEANED_UP);
    assert.equal(asked, 0, 'only a landing reads the inbox');
  });
});

describe('merge queue advance: an entry stuck in landing, and the cleanup a settlement leaves (#2364)', () => {
  /**
   * An entry in landing whose candidate is recorded on `ref`, made by the
   * store's own calls so the ref can be one the queue would never make.
   * @param {string} [ref] - The candidate branch to record, the entry's own when not given
   * @returns {object} The entry
   */
  function landingOn(ref) {
    const entry = submit();
    assert.equal(queues.beginAssembly(entry.entryId, { actor: OWNER }).ok, true);
    const recorded = queues.recordCandidate(entry.entryId, { ref: ref || `tc-queue/${entry.entryId}`, baseSha: BASE, sha: CANDIDATE, tree: TREE, actor: OWNER });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.equal(queues.beginLanding(entry.entryId, { candidateCheck: { runId: '501', conclusion: 'success' }, actor: OWNER }).ok, true);
    return entry;
  }

  /**
   * Settle an entry as failed, disposing of its merge request, by the store's own call.
   * @param {string} entryId - The entry
   * @returns {object} The store's answer
   */
  function settleFailed(entryId) {
    const done = queues.settleLanding(entryId, {
      actor: OPERATOR, outcome: 'failed', mergeAttempt: 'unsuccessful', reference: 'r', attestation: 'a',
      readBack: { merged: false, state: 'closed', mergeCommitSha: null }, provenance: { readAt: 'now' }
    });
    assert.equal(done.ok, true, JSON.stringify(done));
    return done;
  }

  it('no advance takes an entry from landing to failed, whatever the merge\'s outcome reads as: only the Operator\'s settlement does', async () => {
    const outcomes = [
      ['the pull request unreadable', { readPull: TIMED_OUT }],
      ['read back open', {}],
      ['read back closed and not merged', { readPull: (repo, number) => ({ status: 'read', number, state: 'closed', merged: false, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2, mergeCommitSha: null }) }],
      ['merged with no commit named', { readPull: (repo, number) => ({ status: 'read', number, state: 'closed', merged: true, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2, mergeCommitSha: null }) }],
      ['merged as a commit that cannot be read', { readPull: (repo, number) => ({ status: 'read', number, state: 'closed', merged: true, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2, mergeCommitSha: LANDED }), readCommit: TIMED_OUT }],
      ['merged as a commit that is not a merge of the head', { readPull: (repo, number) => ({ status: 'read', number, state: 'closed', merged: true, draft: false, mergeable: null, baseRef: 'main', headSha: HEAD, changedFiles: 2, mergeCommitSha: LANDED }), readCommit: (repo, commit) => ({ status: 'read', sha: commit, tree: TREE, parents: [BASE] }) }]
    ];
    for (const [what, over] of outcomes) {
      const entry = landingOn();
      const answer = await step(fakeGithub(over));
      const now = queues.getEntry(entry.entryId);
      assert.notEqual(now.state, 'failed', what);
      assert.ok(!history(entry.entryId).includes('failed'), what);
      assert.notEqual(answer.step, STEPS.FAILED, what);
      if (now.state === 'landing') settleFailed(entry.entryId);
      else if (now.state === 'testing') assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'next case', actor: OWNER }).ok, true);
      _internal.branchesGone.add(entry.entryId);
    }
  });

  it('retries a settled entry\'s cleanup that did not finish, on its recorded branch, before anything else', async () => {
    const entry = landingOn();
    settleFailed(entry.entryId);
    const next = submit();
    const gh = fakeGithub();
    const cleaned = await step(gh);
    assert.equal(cleaned.step, STEPS.CLEANED_UP);
    assert.equal(cleaned.entryId, entry.entryId);
    assert.deepEqual(gh.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    assert.match(cleaned.message, /^The candidate's branches of failed entry /);
    assert.equal(queues.getEntry(next.entryId).state, 'queued', 'no entry moved');
    assert.equal((await step(gh)).step, STEPS.ASSEMBLED, 'and once is enough');
  });

  it('never deletes a recorded branch the queue does not own, on any retry, never falls back to the entry\'s own name, and reports the skip', async () => {
    for (const ref of ['main', 'feature/x', 'tc-queue-stage/x', 'tc-queue/a/b', 'tc-queue/.hidden']) {
      const entry = landingOn(ref);
      settleFailed(entry.entryId);
      for (let retry = 0; retry < 2; retry += 1) {
        const gh = fakeGithub();
        const answer = await step(gh);
        assert.ok(!gh.names().includes('discardCandidate'), `${ref}, retry ${retry}`);
        assert.equal(answer.step, STEPS.IDLE, ref);
        assert.deepEqual(answer.cleanupSkipped, { entryId: entry.entryId, reason: 'not-queue-owned', ref }, ref);
        assert.match(answer.message, /was NOT removed \[not-queue-owned\]/, ref);
      }
    }
  });

  it('never removes a recorded branch that an unfinished entry also records', async () => {
    const shared = 'tc-queue/shared-name';
    const settled = landingOn(shared);
    settleFailed(settled.entryId);
    const holder = submit();
    assert.equal(queues.beginAssembly(holder.entryId, { actor: OWNER }).ok, true);
    assert.equal(queues.recordCandidate(holder.entryId, { ref: shared, baseSha: BASE, sha: CANDIDATE, tree: TREE, actor: OWNER }).ok, true);
    const gh = fakeGithub({ readBranchCheck: (repo, branch) => (branch === 'main' ? concluded('success', '500') : { status: 'running', runId: '502' }) });
    const answer = await step(gh);
    assert.ok(!gh.names().includes('discardCandidate'));
    assert.equal(answer.step, STEPS.WAITING);
    assert.deepEqual(answer.cleanupSkipped, { entryId: settled.entryId, reason: 'held-by-another-entry', ref: shared, heldBy: holder.entryId });
    assert.equal(queues.getEntry(holder.entryId).candidate.ref, shared);
  });

  it('names the branch a finished entry\'s cleanup may remove, or why none', () => {
    const own = { entryId: 'mqe_1', state: 'failed', candidate: { ref: 'tc-queue/mqe_1' } };
    const holder = { entryId: 'mqe_2', state: 'testing', candidate: { ref: 'tc-queue/mqe_1' } };
    const finishedHolder = { ...holder, state: 'withdrawn' };
    assert.deepEqual(cleanupRefFor(own, [own]), { ref: 'tc-queue/mqe_1' });
    assert.deepEqual(cleanupRefFor(own, [own, finishedHolder]), { ref: 'tc-queue/mqe_1' }, 'a finished entry holds nothing');
    assert.deepEqual(cleanupRefFor(own, [own, holder]), { skip: 'held-by-another-entry', ref: 'tc-queue/mqe_1', heldBy: 'mqe_2' });
    assert.deepEqual(cleanupRefFor({ ...own, candidate: null }, []), { skip: 'no-recorded-ref', ref: null });
    assert.deepEqual(cleanupRefFor({ ...own, candidate: { ref: 'main' } }, []), { skip: 'not-queue-owned', ref: 'main' });
  });

  it('a cleanup that removes nothing it may not, and a removal that fails, both leave the entry owed or settled as it was', async () => {
    const queue = queues.getQueue(queueId);
    const entry = { entryId: 'mqe_x', state: 'failed', candidate: { ref: 'tc-queue/mqe_x' } };
    const calls = [];
    const failing = async (repo, ref) => { calls.push(ref); return { status: 'unavailable', reason: 'gh api timed out', candidate: 'unknown', stage: 'deleted' }; };
    assert.deepEqual(await cleanupFinished(queue, entry, [entry], failing),
      { status: 'failed', ref: 'tc-queue/mqe_x', reason: 'gh api timed out', candidate: 'unknown', stage: 'deleted' });
    assert.ok(!_internal.branchesGone.has('mqe_x'), 'still owed to the next advance');
    const working = async (repo, ref) => { calls.push(ref); return { status: 'discarded', candidate: 'deleted', stage: 'not-found' }; };
    assert.deepEqual(await cleanupFinished(queue, entry, [entry], working), { status: 'removed', ref: 'tc-queue/mqe_x', candidate: 'deleted', stage: 'not-found' });
    assert.ok(_internal.branchesGone.has('mqe_x'));
    assert.deepEqual(await cleanupFinished(queue, { ...entry, candidate: { ref: 'feature/x' } }, [], working), { status: 'skipped', reason: 'not-queue-owned', ref: 'feature/x' });
    assert.deepEqual(calls, ['tc-queue/mqe_x', 'tc-queue/mqe_x']);
  });
});
