'use strict';

// #2322: every GitHub read and write the merge queue makes. `gh` is replaced at
// the seam by exchanges recorded against the real repository
// (test/fixtures/merge-queue-github/README.md says when, from what, which were
// sent by a probe and not by the module, and which one file is written from
// GitHub's documentation instead). No test calls GitHub.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gq = require('../lib/merge-queue-github');
const checks = require('../lib/github-checks');

const FIXTURES = path.join(__dirname, 'fixtures', 'merge-queue-github');
const REPO = 'Jason-Vaughan/TangleClaw';
// The recordings: `main` before pull request #2331, that pull request's head,
// `main`'s merge of it, the tree both that merge and the probe's merge have,
// the probe branch and its merge commit.
const BASE = '6ee1f14ba03071bdae8056ca8d0f793df2f85cc5';
const HEAD = '1aa8f5de0941e64d171f655c0e00822e6577ba9f';
const MAIN_MERGE = '29354a4674cc207ca89205dadaab40aaf845dffc';
const TREE = 'a09b4f590cde4061cf24456ff55244fe1739ebee';
const CANDIDATE = 'tc-queue/probe-20261012-000000';
const CANDIDATE_SHA = 'bb4d7904fe3b972a6e4a1465a2cd7004fae3ee5e';
// The recordings of one candidate made the way the module makes it: `main`
// before pull request #2335, that pull request's head, `main`'s merge of it,
// the tree both that merge and the candidate have, and the two branches.
const STAGED_BASE = '43e13e785c112787a0e63407a8c6906a45f30b5f';
const STAGED_HEAD = 'ccfe717f1d1b68c7e94d38b10d95a014f9f97694';
const STAGED_MAIN_MERGE = 'abe00a40efb37906f72f88655ff6db8652617dbd';
const STAGED_TREE = '380674d09bf71d91eb9d3dafa2683fbaa67af4e6';
const STAGED_SHA = '48774bab0c809a933699f74b9965a5eb86e5e40e';
const STAGED_CANDIDATE = 'tc-queue/probe-20261012-092611';
const STAGE = 'tc-queue-stage/probe-20261012-092611';
// The recordings of a commit's checks: `main`'s merge of pull request #2335 while
// it also carried a run made for a probe branch, and a pull request's head whose
// `test` run was run a second time.
const TIP = STAGED_MAIN_MERGE;
const RERUN_SHA = '6baff24c3640f68caf2ed66deec8816e77b3240b';
const RERUN_BRANCH = 'fix/2005-delivery-failure-notice';
const PULL_FILES = [
  '.prawduct/change-log.md', 'test/fixtures/codex-panes/codex-0.156.1.json', 'test/fixtures/codex-panes/codex-0.159.0.json',
  'test/fixtures/codex-panes/codex-0.161.0.json', 'test/medusa-wake-codex-fixtures.test.js'
];

/**
 * A recorded exchange.
 * @param {string} name - Fixture file name, without `.json`
 * @returns {{args: string[], exitCode: number, statusLine: string, body: string, stderr: string}}
 */
function recorded(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

/** The answers to merging a pull request, written from GitHub's documentation. */
const DOCUMENTED = recorded('pull-merge-DOCUMENTED');

/**
 * What `gh api -i` prints for an exchange: the status line, the headers, a
 * blank line, the body.
 * @param {{statusLine: string, body: string}} exchange - An exchange
 * @returns {string}
 */
function printed(exchange) {
  return `${exchange.statusLine}\r\nContent-Type: application/json; charset=utf-8\r\nX-Github-Request-Id: TEST\r\n\r\n${exchange.body}`;
}

/**
 * The exec result of an exchange.
 * @param {{exitCode: number, statusLine: string, body: string, stderr: string}} exchange - An exchange
 * @returns {object}
 */
function result(exchange) {
  return { exitCode: exchange.exitCode, stdout: printed(exchange), stderr: exchange.stderr, error: null, errorCode: null, signal: null, timedOut: false };
}

/**
 * An exchange that answers HTTP 200 with this value as its body.
 * @param {*} value - The projected answer
 * @returns {object}
 */
function ok(value) {
  return { exitCode: 0, statusLine: 'HTTP/2.0 200 OK', body: `${JSON.stringify(value)}\n`, stderr: '' };
}

/**
 * An exchange GitHub refuses with this status and message.
 * @param {number} http - The HTTP status
 * @param {string} message - GitHub's message
 * @returns {object}
 */
function refused(http, message) {
  return { exitCode: 1, statusLine: `HTTP/2.0 ${http} Refused`, body: JSON.stringify({ message, status: String(http) }), stderr: `gh: ${message} (HTTP ${http})\n` };
}

/** A `gh` that was killed by its time budget before it printed anything. */
const TIMED_OUT = { exitCode: 124, stdout: '', stderr: '', error: 'timed out after 10000ms', errorCode: null, signal: 'SIGTERM', timedOut: true };

/** A `gh` that failed without reaching GitHub. */
const NOT_SIGNED_IN = { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', error: null, errorCode: null, signal: null, timedOut: false };

/** A `gh` that printed something that is not an HTTP answer. */
const GARBAGE = { exitCode: 0, stdout: '<html>proxy says hello</html>', stderr: '', error: null, errorCode: null, signal: null, timedOut: false };

/** An HTTP 200 whose body is not JSON. */
const NOT_JSON = { exitCode: 0, statusLine: 'HTTP/2.0 200 OK', body: 'jq: error', stderr: '' };

const realExec = gq._internal.exec;
let calls = [];

/**
 * Replace `gh` with these answers, given in the order the calls are made. An
 * answer is an exchange, a raw exec result, or a function of the arguments. A
 * call past the last answer fails the test.
 * @param {...(object|Function)} answers - One per expected call
 * @returns {void}
 */
function gh(...answers) {
  const queue = [...answers];
  gq._internal.exec = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    assert.ok(queue.length > 0, `an unexpected gh call: ${args.join(' ')}`);
    const next = queue.shift();
    const answer = typeof next === 'function' ? next(args) : next;
    return answer.statusLine ? result(answer) : answer;
  };
}

/**
 * A projected pull request.
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function pull(fields = {}) {
  return { number: 7, state: 'open', merged: false, draft: false, mergeable: true, base_ref: 'main', head_sha: HEAD, changed_files: 2, ...fields };
}

/**
 * Projected file rows.
 * @param {number} count - How many
 * @param {number} [from] - The first row's number
 * @returns {object[]}
 */
function files(count, from = 0) {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/file-${from + i}.js`, previous_filename: null }));
}

/**
 * A projected comparison of BASE with a descendant.
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function comparison(fields = {}) {
  return { status: 'ahead', base: BASE, merge_base: BASE, files: files(2), ...fields };
}

beforeEach(() => { calls = []; });
afterEach(() => { gq._internal.exec = realExec; });

describe('merge-queue-github — reading a pull request', () => {
  it('reads a merged pull request from the recorded answer, with the call that was recorded', async () => {
    const fx = recorded('pull-merged');
    gh(fx);
    assert.deepEqual(await gq.readPull(REPO, 2331), {
      status: 'read', number: 2331, state: 'closed', merged: true, draft: false, mergeable: null,
      baseRef: 'main', headSha: HEAD, changedFiles: 5
    });
    assert.deepEqual(calls[0].args, fx.args);
    assert.equal(calls[0].timeoutMs, gq.READ_TIMEOUT_MS);
  });

  it('reads an open draft', async () => {
    gh(recorded('pull-open-draft'));
    const r = await gq.readPull(REPO, 2217);
    assert.equal(r.status, 'read');
    assert.equal(r.state, 'open');
    assert.equal(r.draft, true);
    assert.equal(r.merged, false);
    assert.equal(r.mergeable, false);
  });

  it('answers unavailable for a pull request that does not exist, with GitHub\'s words', async () => {
    gh(recorded('pull-not-found'));
    assert.deepEqual(await gq.readPull(REPO, 999999), { status: 'unavailable', reason: 'GitHub answered HTTP 404: Not Found' });
  });

  it('answers unavailable when the answer is of another pull request or is missing a part', async () => {
    for (const fields of [{ number: 8 }, { state: 'merged' }, { merged: null }, { draft: undefined }, { mergeable: 'yes' },
      { base_ref: null }, { head_sha: 'abc' }, { changed_files: -1 }, { changed_files: null }]) {
      gh(ok(pull(fields)));
      const r = await gq.readPull(REPO, 7);
      assert.equal(r.status, 'unavailable', JSON.stringify(fields));
      assert.match(r.reason, /cannot read/);
    }
  });
});

describe('merge-queue-github — reading a branch and a commit', () => {
  it('reads the tip of main', async () => {
    const fx = recorded('ref-main');
    gh(fx);
    assert.deepEqual(await gq.readRefTip(REPO, 'main'), { status: 'read', sha: MAIN_MERGE });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('reads a candidate branch, and says not-found once it is deleted', async () => {
    gh(recorded('ref-candidate'), recorded('ref-candidate-gone'));
    assert.deepEqual(await gq.readRefTip(REPO, CANDIDATE), { status: 'read', sha: CANDIDATE_SHA });
    assert.deepEqual(await gq.readRefTip(REPO, CANDIDATE), { status: 'not-found' });
  });

  it('says not-found for a branch that never existed', async () => {
    gh(recorded('ref-not-found'));
    assert.deepEqual(await gq.readRefTip(REPO, 'tc-queue/nope'), { status: 'not-found' });
  });

  it('answers unavailable for a reference that is another branch, a tag object or not a commit id', async () => {
    for (const value of [{ ref: 'refs/heads/main-2', sha: BASE, type: 'commit' }, { ref: 'refs/heads/main', sha: BASE, type: 'tag' },
      { ref: 'refs/heads/main', sha: 'short', type: 'commit' }, [{ ref: 'refs/heads/main', sha: BASE, type: 'commit' }]]) {
      gh(ok(value));
      assert.equal((await gq.readRefTip(REPO, 'main')).status, 'unavailable', JSON.stringify(value));
    }
  });

  it('reads a merge commit\'s tree and parents, base first', async () => {
    const fx = recorded('commit-main-merge');
    gh(fx);
    assert.deepEqual(await gq.readCommit(REPO, MAIN_MERGE), { status: 'read', sha: MAIN_MERGE, tree: TREE, parents: [BASE, HEAD] });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('the recorded candidate merge has the tree main\'s own merge of the same two commits has', async () => {
    gh(recorded('commit-candidate'), recorded('commit-main-merge'));
    const candidate = await gq.readCommit(REPO, CANDIDATE_SHA);
    const landed = await gq.readCommit(REPO, MAIN_MERGE);
    assert.equal(candidate.tree, landed.tree);
    assert.deepEqual(candidate.parents, landed.parents);
    assert.notEqual(candidate.sha, landed.sha);
  });

  it('answers unavailable for a commit that is not the one asked for, or has no tree', async () => {
    for (const value of [{ sha: BASE, tree: TREE, parents: [] }, { sha: MAIN_MERGE, tree: null, parents: [] },
      { sha: MAIN_MERGE, tree: TREE, parents: ['x'] }, { sha: MAIN_MERGE, tree: TREE }]) {
      gh(ok(value));
      assert.equal((await gq.readCommit(REPO, MAIN_MERGE)).status, 'unavailable', JSON.stringify(value));
    }
  });
});

describe('merge-queue-github — the files a pull request changes', () => {
  it('reads the recorded list, with the head it was read at', async () => {
    const page = recorded('pull-files-page');
    gh(recorded('pull-merged'), page);
    assert.deepEqual(await gq.readPullFiles(REPO, 2331), { status: 'read', headSha: HEAD, paths: PULL_FILES });
    assert.deepEqual(calls[1].args, page.args);
  });

  it('gives a renamed file\'s old path and its new one', async () => {
    gh(ok(pull()), ok([{ filename: 'docs/new.md', previous_filename: 'version.json' }, { filename: 'lib/a.js', previous_filename: null }]));
    const r = await gq.readPullFiles(REPO, 7);
    assert.deepEqual(r.paths, ['docs/new.md', 'version.json', 'lib/a.js']);
  });

  it('reads every page of a long list', async () => {
    gh(ok(pull({ changed_files: 230 })), ok(files(100)), ok(files(100, 100)), ok(files(30, 200)));
    const r = await gq.readPullFiles(REPO, 7);
    assert.equal(r.status, 'read');
    assert.equal(r.paths.length, 230);
    assert.equal(r.paths[229], 'src/file-229.js');
    assert.deepEqual(calls.slice(1).map((c) => /page=(\d+)$/.exec(c.args[2])[1]), ['1', '2', '3']);
  });

  it('stops at the count when the last page is full', async () => {
    gh(ok(pull({ changed_files: 200 })), ok(files(100)), ok(files(100, 100)));
    assert.equal((await gq.readPullFiles(REPO, 7)).paths.length, 200);
  });

  it('reads a pull request that changes no file without asking for a list', async () => {
    gh(ok(pull({ changed_files: 0 })));
    assert.deepEqual(await gq.readPullFiles(REPO, 7), { status: 'read', headSha: HEAD, paths: [] });
  });

  it('answers unavailable at GitHub\'s cap, without asking for the list', async () => {
    gh(ok(pull({ changed_files: gq.PULL_FILES_CAP })));
    const r = await gq.readPullFiles(REPO, 7);
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /3000/);
    assert.equal(calls.length, 1);
  });

  it('answers unavailable when the list is shorter or longer than the pull request\'s count', async () => {
    gh(ok(pull({ changed_files: 3 })), ok(files(2)));
    const short = await gq.readPullFiles(REPO, 7);
    assert.equal(short.status, 'unavailable');
    assert.match(short.reason, /counts 3 changed files and GitHub listed 2/);
    gh(ok(pull({ changed_files: 1 })), ok(files(2)));
    assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable');
  });

  it('answers unavailable when the pull request, or any page, cannot be read', async () => {
    gh(recorded('pull-not-found'));
    assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable');
    gh(ok(pull({ changed_files: 150 })), ok(files(100)), TIMED_OUT);
    const r = await gq.readPullFiles(REPO, 7);
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /timed out/);
    gh(ok(pull()), refused(404, 'Not Found'));
    assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable');
    gh(ok(pull()), NOT_JSON);
    assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable');
    gh(ok(pull()), ok({ message: 'not a list' }));
    assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable');
  });

  it('answers unavailable for a row with no path', async () => {
    for (const row of [{ filename: '' }, { previous_filename: 'a' }, { filename: 'a', previous_filename: 7 }, null]) {
      gh(ok(pull({ changed_files: 1 })), ok([row]));
      assert.equal((await gq.readPullFiles(REPO, 7)).status, 'unavailable', JSON.stringify(row));
    }
  });
});

describe('merge-queue-github — the files between two commits', () => {
  it('reads the recorded comparison of main before and after a merge', async () => {
    const fx = recorded('compare-main-merge');
    gh(fx);
    assert.deepEqual(await gq.readCompareFiles(REPO, BASE, MAIN_MERGE), { status: 'read', paths: PULL_FILES });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('reads the same files for the candidate merge of the same two commits', async () => {
    gh(recorded('compare-candidate'));
    assert.deepEqual(await gq.readCompareFiles(REPO, BASE, CANDIDATE_SHA), { status: 'read', paths: PULL_FILES });
  });

  it('reads no files between a commit and itself', async () => {
    gh(recorded('compare-identical'));
    assert.deepEqual(await gq.readCompareFiles(REPO, BASE, BASE), { status: 'read', paths: [] });
  });

  it('answers unavailable for two commits that have diverged', async () => {
    gh(recorded('compare-diverged'));
    const r = await gq.readCompareFiles(REPO, MAIN_MERGE, 'cc3e8364398a4f68bf3e7fc03ce5993e43954ace');
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /does not descend/);
  });

  it('answers unavailable when the comparison is from another base, or the second commit is behind', async () => {
    for (const fields of [{ base: HEAD }, { merge_base: HEAD }, { status: 'behind' }, { status: 'diverged' }, { status: undefined }]) {
      gh(ok(comparison(fields)));
      assert.equal((await gq.readCompareFiles(REPO, BASE, MAIN_MERGE)).status, 'unavailable', JSON.stringify(fields));
    }
  });

  it('gives a renamed file\'s old path and its new one', async () => {
    gh(ok(comparison({ files: [{ filename: 'VERSION', previous_filename: 'version.json' }] })));
    assert.deepEqual((await gq.readCompareFiles(REPO, BASE, MAIN_MERGE)).paths, ['VERSION', 'version.json']);
  });

  it('answers unavailable at GitHub\'s cap and reads a list one short of it', async () => {
    gh(ok(comparison({ files: files(gq.COMPARE_FILES_CAP) })));
    const capped = await gq.readCompareFiles(REPO, BASE, MAIN_MERGE);
    assert.equal(capped.status, 'unavailable');
    assert.match(capped.reason, /300/);
    gh(ok(comparison({ files: files(gq.COMPARE_FILES_CAP - 1) })));
    assert.equal((await gq.readCompareFiles(REPO, BASE, MAIN_MERGE)).paths.length, gq.COMPARE_FILES_CAP - 1);
  });

  it('answers unavailable when the file list is missing or unreadable', async () => {
    for (const fields of [{ files: null }, { files: undefined }, { files: [{ filename: 3 }] }]) {
      gh(ok(comparison(fields)));
      assert.equal((await gq.readCompareFiles(REPO, BASE, MAIN_MERGE)).status, 'unavailable', JSON.stringify(fields));
    }
  });
});

describe('merge-queue-github — a read that fails', () => {
  const READS = {
    readPull: () => gq.readPull(REPO, 7),
    readRefTip: () => gq.readRefTip(REPO, 'main'),
    readCommit: () => gq.readCommit(REPO, BASE),
    readPullFiles: () => gq.readPullFiles(REPO, 7),
    readCompareFiles: () => gq.readCompareFiles(REPO, BASE, MAIN_MERGE)
  };

  for (const [name, read] of Object.entries(READS)) {
    it(`${name} answers unavailable on a timeout, a gh that did not reach GitHub, output that is no answer, a body that is not JSON, a server error, and a gh that throws`, async () => {
      const cases = [
        [TIMED_OUT, /timed out/], [NOT_SIGNED_IN, /gh auth login/], [GARBAGE, /gh api failed/],
        [NOT_JSON, /not JSON/], [ok(null), /not JSON/], [refused(500, 'Server Error'), /HTTP 500: Server Error/],
        [refused(403, 'API rate limit exceeded'), /HTTP 403: API rate limit exceeded/]
      ];
      for (const [answer, reason] of cases) {
        gh(answer);
        const r = await read();
        assert.equal(r.status, 'unavailable', String(reason));
        assert.match(r.reason, reason);
      }
      gq._internal.exec = async () => { throw new Error('spawn EMFILE'); };
      const thrown = await read();
      assert.deepEqual(thrown, { status: 'unavailable', reason: 'gh api could not run (spawn EMFILE)' });
    });
  }

  it('keeps a hostile error message to one short line', async () => {
    gh(refused(500, `line one\nline two\u0007${'x'.repeat(500)}`));
    const r = await gq.readPull(REPO, 7);
    assert.ok(!/[\n\u0007]/.test(r.reason));
    assert.ok(r.reason.length < 250);
  });
});

describe('merge-queue-github — making a candidate', () => {
  /**
   * The five recorded exchanges of one candidate, in the order they were made:
   * the stage branch created, the merge into it, the merge commit read back,
   * the candidate branch created at it, the stage branch deleted.
   * @returns {object[]}
   */
  function sequence() {
    return ['stage-ref-created', 'stage-merge-created', 'stage-merge-read', 'candidate-ref-created', 'stage-ref-deleted'].map(recorded);
  }

  /**
   * The recorded sequence with some steps answered differently.
   * @param {Object<number, object>} changes - Step number (1 to 5) to the answer it gets instead
   * @returns {object[]}
   */
  function sequenceWith(changes) {
    return sequence().map((exchange, i) => changes[i + 1] || exchange);
  }

  /**
   * An exchange that answers HTTP 201 with this value as its body.
   * @param {*} value - The projected answer
   * @returns {object}
   */
  function made(value) {
    return { exitCode: 0, statusLine: 'HTTP/2.0 201 Created', body: JSON.stringify(value), stderr: '' };
  }

  /**
   * The branches the calls made so far created, in order.
   * @returns {string[]}
   */
  function refsCreated() {
    return calls.map((c) => c.args.find((a) => a.startsWith('ref=refs/heads/'))).filter(Boolean).map((a) => a.slice('ref=refs/heads/'.length));
  }

  /**
   * The branches the calls made so far deleted, in order.
   * @returns {string[]}
   */
  function refsDeleted() {
    const lead = `repos/${REPO}/git/refs/heads/`;
    return calls.filter((c) => c.args.includes('DELETE')).map((c) => c.args.find((a) => a.startsWith(lead)).slice(lead.length));
  }

  it('merges on the stage branch, puts the candidate branch on the finished merge and deletes the stage branch, from the recorded exchanges', async () => {
    const steps = sequence();
    gh(...steps);
    assert.deepEqual(await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD), {
      status: 'created', ref: STAGED_CANDIDATE, sha: STAGED_SHA, tree: STAGED_TREE, parents: [STAGED_BASE, STAGED_HEAD],
      refCreated: true, stageLeft: false
    });
    assert.deepEqual(calls.map((c) => c.args), steps.map((s) => s.args));
    assert.deepEqual(calls.map((c) => c.timeoutMs),
      [gq.WRITE_TIMEOUT_MS, gq.WRITE_TIMEOUT_MS, gq.READ_TIMEOUT_MS, gq.WRITE_TIMEOUT_MS, gq.WRITE_TIMEOUT_MS]);
  });

  it('writes under tc-queue/ exactly once, at the merge commit and never at the base', async () => {
    gh(...sequence());
    await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual(refsCreated(), [STAGE, STAGED_CANDIDATE]);
    const underCandidate = calls.filter((c) => c.args.some((a) => a.includes(STAGED_CANDIDATE)));
    assert.equal(underCandidate.length, 1, 'one call names the candidate branch');
    assert.ok(underCandidate[0].args.includes(`sha=${STAGED_SHA}`), 'and it creates it at the merge commit');
    assert.ok(calls[1].args.includes(`base=${STAGE}`), 'the merge goes into the stage branch');
    assert.deepEqual(refsDeleted(), [STAGE]);
  });

  it('the recorded candidate has the tree main\'s own merge of the same two commits has', () => {
    const answered = JSON.parse(recorded('stage-merge-created').body);
    assert.equal(answered.tree, STAGED_TREE);
    assert.deepEqual(answered.parents, [STAGED_BASE, STAGED_HEAD]);
    assert.notEqual(answered.sha, STAGED_MAIN_MERGE);
  });

  it('answers conflict, with the stage branch deleted and no candidate branch made, when the two commits do not merge', async () => {
    gh(recorded('stage-ref-created'), recorded('merge-conflict'), recorded('stage-ref-deleted'));
    assert.deepEqual(await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD),
      { status: 'conflict', ref: STAGED_CANDIDATE, refCreated: false, stageLeft: false });
    assert.deepEqual(refsCreated(), [STAGE]);
    assert.deepEqual(refsDeleted(), [STAGE]);
  });

  it('answers nothing-to-merge, with the stage branch deleted and no candidate branch made, when the base already holds the head', async () => {
    gh(recorded('stage-ref-created'), recorded('merge-nothing'), recorded('stage-ref-deleted'));
    assert.deepEqual(await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD),
      { status: 'nothing-to-merge', ref: STAGED_CANDIDATE, refCreated: false, stageLeft: false });
    assert.deepEqual(refsCreated(), [STAGE]);
    assert.deepEqual(refsDeleted(), [STAGE]);
  });

  it('answers ref-exists for a stage branch already there, and touches neither branch', async () => {
    gh(recorded('ref-create-exists'));
    assert.deepEqual(await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD),
      { status: 'ref-exists', ref: STAGED_CANDIDATE, existing: 'stage', refCreated: false, stageLeft: true });
    assert.equal(calls.length, 1);
  });

  it('answers ref-exists for a candidate branch already there, leaves it alone and deletes the stage branch it made', async () => {
    gh(...sequenceWith({ 4: recorded('ref-create-exists') }));
    assert.deepEqual(await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD),
      { status: 'ref-exists', ref: STAGED_CANDIDATE, existing: 'candidate', refCreated: false, stageLeft: false });
    assert.deepEqual(refsDeleted(), [STAGE], 'the branch that was already there is not deleted');
  });

  it('answers unavailable, never conflict, when the candidate branch is refused or its outcome is not known after a good merge', async () => {
    gh(...sequenceWith({ 4: refused(403, 'Resource not accessible') }));
    const no = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([no.status, no.refCreated, no.stageLeft], ['unavailable', false, false]);
    assert.match(no.reason, /HTTP 403: Resource not accessible/);
    assert.deepEqual(refsDeleted(), [STAGE]);

    calls = [];
    gh(...sequenceWith({ 4: TIMED_OUT }));
    const unknown = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([unknown.status, unknown.refCreated, unknown.stageLeft], ['unavailable', null, false]);
    assert.deepEqual(refsDeleted(), [STAGE]);

    gh(...sequenceWith({ 4: refused(502, 'Bad Gateway') }));
    assert.equal((await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD)).refCreated, null);
  });

  it('says a candidate branch exists when GitHub made one that is not at the merge commit', async () => {
    gh(...sequenceWith({ 4: made({ ref: `refs/heads/${STAGED_CANDIDATE}`, sha: STAGED_BASE, type: 'commit' }) }));
    const r = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', true, false]);
  });

  it('answers unavailable and makes no candidate branch when the merge is not of exactly these two commits, base first', async () => {
    const other = '9'.repeat(40);
    for (const parents of [[STAGED_HEAD, STAGED_BASE], [STAGED_BASE, other], [other, STAGED_HEAD], [STAGED_BASE], [STAGED_BASE, STAGED_HEAD, other]]) {
      calls = [];
      gh(recorded('stage-ref-created'), made({ sha: STAGED_SHA, tree: STAGED_TREE, parents }), recorded('stage-ref-deleted'));
      const r = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', false, false], JSON.stringify(parents));
      assert.deepEqual(refsCreated(), [STAGE]);
      assert.ok(!('applied' in r));
    }
  });

  it('answers unavailable and makes no candidate branch when the merge commit read back is not what the merge answered', async () => {
    const other = '9'.repeat(40);
    const answered = { sha: STAGED_SHA, tree: STAGED_TREE, parents: [STAGED_BASE, STAGED_HEAD] };
    const readBacks = [
      ok({ ...answered, tree: other }), ok({ ...answered, parents: [STAGED_HEAD, STAGED_BASE] }), ok({ ...answered, parents: [STAGED_BASE] }),
      ok({ ...answered, sha: other }), refused(404, 'Not Found'), TIMED_OUT, NOT_JSON
    ];
    for (const readBack of readBacks) {
      calls = [];
      gh(...sequenceWith({ 3: readBack }).filter((_, i) => i !== 3));
      const r = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', false, false], JSON.stringify(readBack));
      assert.match(r.reason, /read back/);
      assert.deepEqual(refsCreated(), [STAGE]);
      assert.deepEqual(refsDeleted(), [STAGE]);
    }
  });

  it('says no branch was made when GitHub refuses the stage branch, and deletes nothing', async () => {
    gh(refused(422, 'Object does not exist'));
    const no = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([no.status, no.refCreated, no.stageLeft], ['unavailable', false, false]);
    assert.match(no.reason, /HTTP 422: Object does not exist/);
    assert.equal(calls.length, 1);
  });

  it('tries to delete a stage branch it may have made, and says what is known of it', async () => {
    gh(TIMED_OUT, recorded('stage-ref-delete-missing'));
    const gone = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([gone.status, gone.refCreated, gone.stageLeft], ['unavailable', false, false]);
    assert.deepEqual(refsDeleted(), [STAGE]);

    gh(TIMED_OUT, TIMED_OUT);
    const unknown = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([unknown.status, unknown.refCreated, unknown.stageLeft], ['unavailable', false, null]);

    gh(refused(502, 'Bad Gateway'), refused(403, 'Resource not accessible'));
    const refusedDelete = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.equal(refusedDelete.stageLeft, null, 'a branch not known to have been made is not known to be left');

    gh(made({ ref: `refs/heads/${STAGE}`, sha: STAGED_HEAD, type: 'commit' }), recorded('stage-ref-deleted'));
    const misplaced = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([misplaced.status, misplaced.refCreated, misplaced.stageLeft], ['unavailable', false, false]);
  });

  it('deletes the stage branch and makes no candidate branch when the merge is refused or its outcome is not known', async () => {
    for (const merge of [refused(404, 'Head does not exist'), TIMED_OUT, GARBAGE]) {
      calls = [];
      gh(recorded('stage-ref-created'), merge, recorded('stage-ref-deleted'));
      const r = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', false, false]);
      assert.deepEqual(refsCreated(), [STAGE]);
      assert.deepEqual(refsDeleted(), [STAGE]);
      assert.ok(!('applied' in r));
    }
  });

  it('never answers created over a stage branch left behind', async () => {
    gh(...sequenceWith({ 5: refused(403, 'Resource not accessible') }));
    const left = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([left.status, left.refCreated, left.stageLeft], ['unavailable', true, true]);
    assert.match(left.reason, /the candidate branch was made; and the stage branch tc-queue-stage\/probe-20261012-092611 could not be deleted \(GitHub answered HTTP 403/);
    assert.ok(!('sha' in left));

    gh(...sequenceWith({ 5: TIMED_OUT }));
    const unknown = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    assert.deepEqual([unknown.status, unknown.refCreated, unknown.stageLeft], ['unavailable', true, null]);

    gh(...sequenceWith({ 5: recorded('stage-ref-delete-missing') }));
    assert.equal((await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD)).status, 'created', 'already gone is gone');
  });

  it('answers unavailable, not the outcome, when the stage branch cannot be deleted after a conflict, nothing to merge or a name already taken', async () => {
    const cases = [
      [[recorded('stage-ref-created'), recorded('merge-conflict')], /the two commits do not merge; and the stage branch/],
      [[recorded('stage-ref-created'), recorded('merge-nothing')], /the base already holds the head; and the stage branch/],
      [sequenceWith({ 4: recorded('ref-create-exists') }).slice(0, 4), /the candidate branch was already there; and the stage branch/],
      [[recorded('stage-ref-created'), TIMED_OUT], /timed out.*; and the stage branch/]
    ];
    for (const [steps, reason] of cases) {
      gh(...steps, refused(403, 'Resource not accessible'));
      const refusedDelete = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([refusedDelete.status, refusedDelete.refCreated, refusedDelete.stageLeft], ['unavailable', false, true], String(reason));
      assert.match(refusedDelete.reason, reason);
      gh(...steps, TIMED_OUT);
      const unknown = await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([unknown.status, unknown.stageLeft], ['unavailable', null], String(reason));
    }
  });

  it('accepts only one name under tc-queue/ for the candidate, and refuses any other branch before gh is called', async () => {
    gh();
    for (const ref of ['main', 'v5-baseline', 'feat/x', 'tc-queue', 'tc-queue/', 'tc-queue/a/b', 'tc-queue/../main', 'tc-queue/.hidden',
      'tc-queue/a.lock', 'tc-queue/a.', 'refs/heads/tc-queue/a', 'TC-QUEUE/a', ' tc-queue/a', 'tc-queue/a b', `tc-queue/${'a'.repeat(101)}`,
      STAGE, 'tc-queue-stage/a', '', null, undefined, 7]) {
      const r = await gq.createCandidate(REPO, ref, STAGED_BASE, STAGED_HEAD);
      assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', false, false], String(ref));
      assert.match(r.reason, /one name under tc-queue\//);
    }
    assert.equal(calls.length, 0);
  });

  it('writes to no branch outside the two prefixes: not the base branch, not a pull request\'s branch', async () => {
    gh(...sequence());
    await gq.createCandidate(REPO, STAGED_CANDIDATE, STAGED_BASE, STAGED_HEAD);
    const written = [...refsCreated(), ...refsDeleted(), ...calls.map((c) => c.args.find((a) => a.startsWith('base='))).filter(Boolean).map((a) => a.slice(5))];
    assert.equal(written.length, 4);
    for (const branch of written) assert.ok(gq.isCandidateRef(branch) || gq.isStageRef(branch), branch);
  });

  it('refuses a base or head that is not a full commit id, and a missing argument, before gh is called', async () => {
    gh();
    for (const [base, head] of [[STAGED_BASE.slice(0, 7), STAGED_HEAD], [STAGED_BASE, 'main'], [STAGED_BASE.toUpperCase(), STAGED_HEAD],
      [STAGED_BASE, undefined], [STAGED_BASE, null], [undefined, STAGED_HEAD], [null, STAGED_HEAD]]) {
      const r = await gq.createCandidate(REPO, STAGED_CANDIDATE, base, head);
      assert.deepEqual([r.status, r.refCreated, r.stageLeft], ['unavailable', false, false], `${base} ${head}`);
    }
    assert.equal(calls.length, 0);
  });
});

describe('merge-queue-github — the two branches of a candidate', () => {
  it('knows a candidate branch and a stage branch from each other and from any other', () => {
    assert.equal(gq.CANDIDATE_PREFIX, 'tc-queue/');
    assert.equal(gq.STAGE_PREFIX, 'tc-queue-stage/');
    assert.equal(gq.isCandidateRef(STAGED_CANDIDATE), true);
    assert.equal(gq.isCandidateRef('tc-queue/e_17.a-b'), true);
    assert.equal(gq.isStageRef(STAGE), true);
    assert.equal(gq.isStageRef('tc-queue-stage/e_17.a-b'), true);
    for (const ref of ['main', 'tc-queue/a/b', STAGE, 'tc-queue-stage/a', null, undefined]) assert.equal(gq.isCandidateRef(ref), false, String(ref));
    for (const ref of ['main', 'tc-queue-stage', 'tc-queue-stage/', 'tc-queue-stage/a/b', 'tc-queue-stage/../main', 'tc-queue-stage/a.lock',
      'tc-queue-stages/a', 'x/tc-queue-stage/a', `tc-queue-stage/${'a'.repeat(101)}`, STAGED_CANDIDATE, 'tc-queue/a', null, undefined]) {
      assert.equal(gq.isStageRef(ref), false, String(ref));
    }
  });

  it('builds the stage branch from the candidate branch, the same name under the other prefix', () => {
    assert.equal(gq.stageRefFor(STAGED_CANDIDATE), STAGE);
    assert.equal(gq.stageRefFor('tc-queue/e_17.a-b'), 'tc-queue-stage/e_17.a-b');
    assert.equal(gq.isStageRef(gq.stageRefFor(`tc-queue/${'a'.repeat(100)}`)), true, 'the longest candidate name has a stage name');
  });

  it('builds no stage branch for a branch that is not a candidate', () => {
    for (const ref of ['main', STAGE, 'tc-queue/a/b', 'tc-queue/', 'feat/x', '', null, undefined, 7]) {
      assert.equal(gq.stageRefFor(ref), null, String(ref));
    }
  });
});

describe('merge-queue-github — deleting a branch of a candidate', () => {
  it('deletes a candidate branch, from the recorded exchange', async () => {
    const fx = recorded('ref-deleted');
    gh(fx);
    assert.deepEqual(await gq.deleteRef(REPO, CANDIDATE), { status: 'deleted' });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('deletes a stage branch, from the recorded exchange', async () => {
    const fx = recorded('stage-ref-deleted');
    gh(fx);
    assert.deepEqual(await gq.deleteRef(REPO, STAGE), { status: 'deleted' });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('says not-found when the branch is already gone', async () => {
    gh(recorded('ref-delete-missing'), recorded('stage-ref-delete-missing'));
    assert.deepEqual(await gq.deleteRef(REPO, CANDIDATE), { status: 'not-found' });
    assert.deepEqual(await gq.deleteRef(REPO, STAGE), { status: 'not-found' });
  });

  it('refuses every branch that is not one name under one of the two prefixes before gh is called', async () => {
    gh();
    for (const ref of ['main', 'v5-baseline', 'metrics', 'feat/2322-02-merge-queue-github', 'tc-queue/a/b', 'tc-queue/../main', 'heads/tc-queue/a',
      'tc-queue', 'tc-queue-stage', 'tc-queue-stage/', 'tc-queue-stage/a/b', 'tc-queue-stage/../main', 'tc-queue-stages/a', 'tc-queue-staging/a',
      'tc-queue-other/a', 'refs/heads/tc-queue-stage/a', '', null, undefined]) {
      const r = await gq.deleteRef(REPO, ref);
      assert.deepEqual([r.status, r.applied], ['unavailable', false], String(ref));
      assert.match(r.reason, /only a branch under tc-queue\/ or tc-queue-stage\/ may be deleted/);
    }
    assert.equal(calls.length, 0);
  });

  it('says whether a failed deletion was refused or is not known', async () => {
    gh(refused(403, 'Resource not accessible'));
    assert.deepEqual([(await gq.deleteRef(REPO, CANDIDATE)).applied], [false]);
    gh(refused(422, 'Validation Failed'));
    const validation = await gq.deleteRef(REPO, CANDIDATE);
    assert.deepEqual([validation.status, validation.applied], ['unavailable', false]);
    gh(TIMED_OUT);
    assert.deepEqual([(await gq.deleteRef(REPO, STAGE)).applied], [null]);
    gh(GARBAGE);
    assert.deepEqual([(await gq.deleteRef(REPO, CANDIDATE)).applied], [null]);
  });
});

describe('merge-queue-github — discarding a candidate', () => {
  it('deletes the candidate branch and its stage branch, from the recorded exchanges', async () => {
    const [candidate, stage] = [recorded('candidate-ref-deleted'), recorded('stage-ref-deleted')];
    gh(candidate, stage);
    assert.deepEqual(await gq.discardCandidate(REPO, STAGED_CANDIDATE), { status: 'discarded', candidate: 'deleted', stage: 'deleted' });
    assert.deepEqual(calls.map((c) => c.args), [candidate.args, stage.args]);
  });

  it('is discarded when only one of the two was there, as recorded after a finished candidate', async () => {
    const [candidate, stage] = [recorded('candidate-ref-deleted'), recorded('stage-ref-delete-missing')];
    gh(candidate, stage);
    assert.deepEqual(await gq.discardCandidate(REPO, STAGED_CANDIDATE), { status: 'discarded', candidate: 'deleted', stage: 'not-found' });
    assert.deepEqual(calls.map((c) => c.args), [candidate.args, stage.args]);
    gh(recorded('ref-delete-missing'), recorded('stage-ref-deleted'));
    assert.deepEqual(await gq.discardCandidate(REPO, STAGED_CANDIDATE), { status: 'discarded', candidate: 'not-found', stage: 'deleted' });
  });

  it('is discarded when neither was there, so calling it twice is harmless', async () => {
    gh(recorded('candidate-ref-deleted'), recorded('stage-ref-deleted'), recorded('ref-delete-missing'), recorded('stage-ref-delete-missing'));
    assert.equal((await gq.discardCandidate(REPO, STAGED_CANDIDATE)).status, 'discarded');
    assert.deepEqual(await gq.discardCandidate(REPO, STAGED_CANDIDATE), { status: 'discarded', candidate: 'not-found', stage: 'not-found' });
    assert.equal(calls.length, 4);
  });

  it('attempts both deletions when the first is refused, and says which branch is left', async () => {
    gh(refused(403, 'Resource not accessible'), recorded('stage-ref-deleted'));
    const r = await gq.discardCandidate(REPO, STAGED_CANDIDATE);
    assert.deepEqual([r.status, r.candidate, r.stage], ['unavailable', 'refused', 'deleted']);
    assert.match(r.reason, /^tc-queue\/probe-20261012-092611 could not be deleted \(GitHub answered HTTP 403: Resource not accessible\)$/);
    assert.equal(calls.length, 2);

    gh(recorded('candidate-ref-deleted'), refused(403, 'Resource not accessible'));
    const stageLeft = await gq.discardCandidate(REPO, STAGED_CANDIDATE);
    assert.deepEqual([stageLeft.status, stageLeft.candidate, stageLeft.stage], ['unavailable', 'deleted', 'refused']);
    assert.match(stageLeft.reason, /^tc-queue-stage\/probe-20261012-092611 could not be deleted/);
  });

  it('says a deletion that timed out is not known, and never discarded', async () => {
    gh(recorded('candidate-ref-deleted'), TIMED_OUT);
    const one = await gq.discardCandidate(REPO, STAGED_CANDIDATE);
    assert.deepEqual([one.status, one.candidate, one.stage], ['unavailable', 'deleted', 'unknown']);
    gh(TIMED_OUT, GARBAGE);
    const both = await gq.discardCandidate(REPO, STAGED_CANDIDATE);
    assert.deepEqual([both.status, both.candidate, both.stage], ['unavailable', 'unknown', 'unknown']);
    assert.match(both.reason, /tc-queue\/probe-20261012-092611 could not be deleted .*; tc-queue-stage\/probe-20261012-092611 could not be deleted/);
    gq._internal.exec = async () => { throw new Error('spawn EMFILE'); };
    assert.equal((await gq.discardCandidate(REPO, STAGED_CANDIDATE)).status, 'unavailable');
  });

  it('refuses anything but a candidate branch before gh is called, a stage branch included', async () => {
    gh();
    for (const ref of ['main', STAGE, 'tc-queue/a/b', 'tc-queue/', 'feat/x', '', null, undefined, 7]) {
      const r = await gq.discardCandidate(REPO, ref);
      assert.deepEqual([r.status, r.candidate, r.stage], ['unavailable', 'refused', 'refused'], String(ref));
      assert.match(r.reason, /one name under tc-queue\//);
    }
    assert.equal(calls.length, 0);
  });
});

describe('merge-queue-github — merging a pull request (answers written from GitHub\'s documentation, not recorded)', () => {
  it('merges with a merge commit pinned to the head, and answers the commit GitHub made', async () => {
    gh(DOCUMENTED.merged);
    assert.deepEqual(await gq.mergePull(REPO, 2331, HEAD), { status: 'merged', sha: MAIN_MERGE });
    assert.deepEqual(calls[0].args, DOCUMENTED.merged.args);
    assert.equal(calls[0].timeoutMs, gq.WRITE_TIMEOUT_MS);
  });

  it('always asks for a merge commit and the exact head, and can ask for nothing else', async () => {
    gh(DOCUMENTED.merged);
    await gq.mergePull(REPO, 2331, HEAD, 'squash');
    const args = calls[0].args;
    const fields = args.filter((a, i) => args[i - 1] === '-f');
    assert.deepEqual(fields, ['merge_method=merge', `sha=${HEAD}`]);
    assert.equal(gq.MERGE_METHOD, 'merge');
    assert.ok(!args.some((a) => /squash|rebase/.test(a)));
    assert.deepEqual(args.slice(0, 5), ['api', '-i', '-X', 'PUT', `repos/${REPO}/pulls/2331/merge`]);
  });

  it('cannot be called without a full 40-character head', async () => {
    gh();
    for (const head of [undefined, null, '', HEAD.slice(0, 39), HEAD.slice(0, 7), `${HEAD}0`, HEAD.toUpperCase(), 'HEAD', 'main']) {
      const r = await gq.mergePull(REPO, 2331, head);
      assert.deepEqual([r.status, r.applied], ['unavailable', false], String(head));
      assert.match(r.reason, /full 40-character/);
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a pull request number that is not a positive whole number before gh is called', async () => {
    gh();
    for (const number of [0, -1, 1.5, '2331', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await gq.mergePull(REPO, number, HEAD)).status, 'unavailable', String(number));
      assert.equal((await gq.readPull(REPO, number)).status, 'unavailable', String(number));
    }
    assert.equal(calls.length, 0);
  });

  it('says head-moved when the pull request is no longer at that head, and not-mergeable when GitHub will not merge it', async () => {
    gh(DOCUMENTED.headMoved);
    const moved = await gq.mergePull(REPO, 2331, HEAD);
    assert.equal(moved.status, 'head-moved');
    assert.match(moved.reason, /HTTP 409: Head branch was modified/);
    gh(DOCUMENTED.notMergeable);
    const blocked = await gq.mergePull(REPO, 2331, HEAD);
    assert.equal(blocked.status, 'not-mergeable');
    assert.match(blocked.reason, /HTTP 405: Pull Request is not mergeable/);
  });

  it('never reports a merge it did not read', async () => {
    for (const body of [{ merged: false, sha: MAIN_MERGE }, { merged: true, sha: 'abc' }, { merged: true }, { sha: MAIN_MERGE }, null, 'merged']) {
      gh({ exitCode: 0, statusLine: 'HTTP/2.0 200 OK', body: JSON.stringify(body), stderr: '' });
      const r = await gq.mergePull(REPO, 2331, HEAD);
      assert.deepEqual([r.status, r.applied], ['unavailable', null], JSON.stringify(body));
    }
    gh(NOT_JSON);
    assert.deepEqual([(await gq.mergePull(REPO, 2331, HEAD)).applied], [null]);
  });

  it('says a refused merge was not applied and a timed-out one is not known', async () => {
    gh(refused(404, 'Not Found'));
    assert.deepEqual([(await gq.mergePull(REPO, 2331, HEAD)).applied], [false]);
    gh(refused(422, 'Validation Failed'));
    assert.deepEqual([(await gq.mergePull(REPO, 2331, HEAD)).applied], [false]);
    gh(TIMED_OUT);
    const unknown = await gq.mergePull(REPO, 2331, HEAD);
    assert.deepEqual([unknown.status, unknown.applied], ['unavailable', null]);
    gh(refused(502, 'Bad Gateway'));
    assert.deepEqual([(await gq.mergePull(REPO, 2331, HEAD)).applied], [null]);
    gq._internal.exec = async () => { throw new Error('spawn EMFILE'); };
    assert.deepEqual([(await gq.mergePull(REPO, 2331, HEAD)).applied], [null]);
  });
});

describe('merge-queue-github — what is refused before gh is called', () => {
  it('refuses a repository that is not owner/name, in every function', async () => {
    gh();
    for (const repo of ['TangleClaw', 'a/b/c', '../etc', 'owner/..', 'owner/name?x=1', 'owner/na me', '', null, undefined, 7]) {
      const answers = [
        await gq.readPull(repo, 7), await gq.readRefTip(repo, 'main'), await gq.readCommit(repo, BASE),
        await gq.readPullFiles(repo, 7), await gq.readCompareFiles(repo, BASE, HEAD),
        await gq.createCandidate(repo, CANDIDATE, BASE, HEAD), await gq.deleteRef(repo, CANDIDATE), await gq.deleteRef(repo, STAGE),
        await gq.discardCandidate(repo, CANDIDATE), await gq.mergePull(repo, 7, HEAD)
      ];
      for (const r of answers) {
        assert.equal(r.status, 'unavailable', String(repo));
        assert.match(r.reason, /owner\/name/);
      }
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a branch name that is not well formed', async () => {
    gh();
    for (const branch of ['', 'a..b', 'a//b', '/main', 'main/', '.hidden', 'a/.b', 'a.lock', 'a b', 'a?b', 'a~1', 'a^', 'a:b', 'a\nb', 'x'.repeat(201), null, 7]) {
      assert.equal((await gq.readRefTip(REPO, branch)).status, 'unavailable', String(branch));
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a commit id that is not full and lower-case', async () => {
    gh();
    for (const sha of ['', BASE.slice(0, 12), BASE.toUpperCase(), 'main', null]) {
      assert.equal((await gq.readCommit(REPO, sha)).status, 'unavailable');
      assert.equal((await gq.readCompareFiles(REPO, sha, HEAD)).status, 'unavailable');
      assert.equal((await gq.readCompareFiles(REPO, BASE, sha)).status, 'unavailable');
    }
    assert.equal(calls.length, 0);
  });
});

/**
 * A projected check run of a commit, a finished green `test` run of GitHub Actions unless changed.
 * @param {number} id - The run's id, which is also its job's
 * @param {number} suiteId - The check suite it is in
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function checkRun(id, suiteId, fields = {}) {
  return {
    id, name: 'test', head_sha: TIP, status: 'completed', conclusion: 'success',
    started_at: '2026-10-12T08:00:00Z', completed_at: '2026-10-12T08:15:00Z', app: 'github-actions',
    details_url: `https://github.com/${REPO}/actions/runs/900${id}/job/${id}`, check_suite: suiteId, ...fields
  };
}

/**
 * A projected check suite of a commit.
 * @param {number} id - The suite's id
 * @param {*} branch - What it gives as its branch
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function checkSuite(id, branch, fields = {}) {
  return { id, head_branch: branch, head_sha: TIP, ...fields };
}

/**
 * The answer to reading a commit's check runs.
 * @param {object[]} rows - The runs
 * @param {number} [total] - The count GitHub gives, the rows' own when not given
 * @returns {object}
 */
function runsAnswer(rows, total = rows.length) {
  return ok({ total_count: total, check_runs: rows });
}

/**
 * The answer to reading a commit's check suites.
 * @param {object[]} rows - The suites
 * @param {number} [total] - The count GitHub gives, the rows' own when not given
 * @returns {object}
 */
function suitesAnswer(rows, total = rows.length) {
  return ok({ total_count: total, check_suites: rows });
}

/**
 * A recorded exchange's projected body.
 * @param {string} name - Fixture file name, without `.json`
 * @returns {object}
 */
function recordedBody(name) {
  return JSON.parse(recorded(name).body);
}

describe('merge-queue-github — a check as one branch sees it', () => {
  it('reads the recorded candidate commit for its candidate branch, with the two calls that were recorded', async () => {
    const [runs, suites] = [recorded('checks-runs-candidate'), recorded('checks-suites-candidate')];
    gh(runs, suites);
    assert.deepEqual(await gq.readBranchCheck(REPO, STAGED_CANDIDATE, STAGED_SHA, 'test'), {
      status: 'concluded', conclusion: 'cancelled', runId: '114746472956', completedAt: '2026-10-12T09:29:08.000Z',
      app: 'github-actions', workflowRunId: '38229882501', suiteId: '103575890893'
    });
    assert.deepEqual(calls.map((c) => c.args), [runs.args, suites.args]);
    assert.deepEqual(calls.map((c) => c.timeoutMs), [gq.READ_TIMEOUT_MS, gq.READ_TIMEOUT_MS]);
  });

  it('answers not-found for the stage branch of that commit, whose four suites hold no run of that name', async () => {
    gh(recorded('checks-runs-candidate'), recorded('checks-suites-candidate'));
    assert.deepEqual(await gq.readBranchCheck(REPO, STAGE, STAGED_SHA, 'test'), { status: 'not-found' });
    assert.equal(recordedBody('checks-suites-candidate').check_suites.filter((row) => row.head_branch === STAGE).length, 4);
  });

  it('answers main\'s own run on the recorded tip that also carries a newer run of another branch', async () => {
    const runs = recordedBody('checks-runs-main-foreign');
    // What the reader of a commit answers for the same runs: the newer one, which is not main's.
    assert.equal(checks.interpret(runs, TIP, 'test', REPO).conclusion, 'cancelled');
    gh(recorded('checks-runs-main-foreign'), recorded('checks-suites-main-foreign'));
    assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), {
      status: 'concluded', conclusion: 'success', runId: '114732777086', completedAt: '2026-10-12T09:06:20.000Z',
      app: 'github-actions', workflowRunId: '38225769581', suiteId: '103564351946'
    });
    gh(recorded('checks-runs-main-foreign'), recorded('checks-suites-main-foreign'));
    const foreign = await gq.readBranchCheck(REPO, 'tc-queue/probe-20261012-084901', TIP, 'test');
    assert.equal(foreign.conclusion, 'cancelled');
    assert.equal(foreign.suiteId, '103564755779');
  });

  it('answers the second attempt of a recorded re-run, which is in the first attempt\'s suite', async () => {
    gh(recorded('checks-runs-rerun'), recorded('checks-suites-rerun'));
    const latest = await gq.readBranchCheck(REPO, RERUN_BRANCH, RERUN_SHA, 'test');
    assert.equal(latest.runId, '111977985772');
    assert.equal(latest.conclusion, 'success');
    // Both attempts, as GitHub lists them when asked for all: the newer is still the one answered.
    const both = recordedBody('checks-runs-rerun-all-PROBE');
    assert.deepEqual(both.check_runs.map((row) => row.check_suite), [101231172868, 101231172868]);
    gh(ok(both), recorded('checks-suites-rerun'));
    assert.deepEqual(await gq.readBranchCheck(REPO, RERUN_BRANCH, RERUN_SHA, 'test'), latest);
  });

  it('answers a re-run of the branch\'s own run whatever it concludes, green then red and red then green', async () => {
    for (const [first, second] of [['success', 'failure'], ['failure', 'success']]) {
      for (const order of [0, 1]) {
        const rows = [
          checkRun(11, 1, { conclusion: first, started_at: '2026-10-12T08:00:00Z' }),
          checkRun(12, 1, { conclusion: second, started_at: '2026-10-12T09:00:00Z' })
        ];
        gh(runsAnswer(order ? rows.reverse() : rows), suitesAnswer([checkSuite(1, 'main')]));
        const r = await gq.readBranchCheck(REPO, 'main', TIP, 'test');
        assert.equal(r.conclusion, second, `${first} then ${second}`);
        assert.equal(r.runId, '12');
      }
    }
  });

  it('answers a run that has not finished as running, with its suite and its app', async () => {
    gh(runsAnswer([checkRun(11, 1, { status: 'in_progress', conclusion: null, completed_at: null })]), suitesAnswer([checkSuite(1, 'main')]));
    assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), {
      status: 'running', runId: '11', app: 'github-actions', workflowRunId: '90011', suiteId: '1'
    });
  });

  it('answers not-found when every run of that name is another branch\'s, green or red', async () => {
    for (const conclusion of ['success', 'failure']) {
      gh(runsAnswer([checkRun(11, 2, { conclusion }), checkRun(12, 3, { conclusion })]),
        suitesAnswer([checkSuite(1, 'main'), checkSuite(2, 'tc-queue/a1'), checkSuite(3, 'feat/other')]));
      assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), { status: 'not-found' });
    }
  });

  it('answers not-found when the commit has no run of that name at all', async () => {
    gh(runsAnswer([]), suitesAnswer([checkSuite(1, 'main')]));
    assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), { status: 'not-found' });
    gh(runsAnswer([checkRun(11, 1, { name: 'lint' })]), suitesAnswer([checkSuite(1, 'main')]));
    assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), { status: 'not-found' });
  });

  it('counts a branch only when its name is exactly the one asked for', async () => {
    for (const other of ['Main', 'main ', 'refs/heads/main', 'main/x', 'mai']) {
      gh(runsAnswer([checkRun(11, 2)]), suitesAnswer([checkSuite(2, other)]));
      assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), { status: 'not-found' }, other);
    }
  });

  // A suite that gives no branch stands in for none. The projection writes a
  // missing `head_branch` as null; the row with the key absent is what the
  // reader would see if it did not.
  const NO_BRANCH = {
    'a null branch': checkSuite(2, null),
    'a row with no branch': { id: 2, head_sha: TIP },
    'a branch that is a number': checkSuite(2, 7),
    'a branch that is a list': checkSuite(2, ['main']),
    'a branch that is true': checkSuite(2, true)
  };
  for (const [what, suite] of Object.entries(NO_BRANCH)) {
    it(`ignores a run whose suite gives ${what}, alone`, async () => {
      gh(runsAnswer([checkRun(11, 2)]), suitesAnswer([suite]));
      assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'), { status: 'not-found' });
    });

    it(`ignores a run whose suite gives ${what}, beside a run of the branch`, async () => {
      gh(runsAnswer([checkRun(11, 2, { conclusion: 'success', started_at: '2026-10-12T09:00:00Z' }), checkRun(12, 1, { conclusion: 'failure' })]),
        suitesAnswer([suite, checkSuite(1, 'main')]));
      const r = await gq.readBranchCheck(REPO, 'main', TIP, 'test');
      assert.equal(r.runId, '12');
      assert.equal(r.conclusion, 'failure');
      assert.equal(r.suiteId, '1');
    });
  }

  it('is not stopped by a foreign run it could not have answered', async () => {
    const foreign = [checkRun(11, 2, { app: null }), checkRun(12, 2, { conclusion: 'mystery' }), checkRun(13, 2, { status: 'unheard-of' })];
    gh(runsAnswer([...foreign, checkRun(14, 1)]), suitesAnswer([checkSuite(1, 'main'), checkSuite(2, 'feat/other')]));
    assert.equal((await gq.readBranchCheck(REPO, 'main', TIP, 'test')).runId, '14');
  });

  it('answers unavailable, never not-found, for a run of the branch it cannot read', async () => {
    for (const fields of [{ app: null }, { conclusion: 'mystery' }, { status: 'unheard-of' }, { completed_at: null }, { id: 'eleven' }]) {
      gh(runsAnswer([checkRun(11, 1, fields)]), suitesAnswer([checkSuite(1, 'main')]));
      assert.equal((await gq.readBranchCheck(REPO, 'main', TIP, 'test')).status, 'unavailable', JSON.stringify(fields));
    }
  });

  describe('attribution that is not whole is unavailable', () => {
    const many = (make) => Array.from({ length: gq.CHECKS_PAGE_SIZE }, (_, i) => make(i + 1));
    const CASES = {
      'the suites list at its page size': [runsAnswer([checkRun(11, 1)]), suitesAnswer(many((i) => checkSuite(i, 'main')))],
      'the suites list with a count larger than its rows': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main')], 2)],
      'the suites list with a count smaller than its rows': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main'), checkSuite(2, 'x')], 1)],
      'the runs list at its page size': [runsAnswer(many((i) => checkRun(i, 1)))],
      'the runs list with a count larger than its rows': [runsAnswer([checkRun(11, 1)], 2)],
      'a run whose suite is not in the list': [runsAnswer([checkRun(11, 9)]), suitesAnswer([checkSuite(1, 'main')])],
      'a run whose suite is not in the list, beside a run of the branch': [runsAnswer([checkRun(11, 1), checkRun(12, 9)]), suitesAnswer([checkSuite(1, 'main')])],
      'a run that names no suite': [runsAnswer([checkRun(11, null)]), suitesAnswer([checkSuite(1, 'main')])],
      'a suites row that is not a row': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main'), null])],
      'a suite with no id': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main'), checkSuite(null, 'main')])],
      'a suite whose id is not a whole number': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main'), checkSuite('2', 'main')])],
      'two suites with one id': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main'), checkSuite(1, 'feat/other')])],
      'a suite of another commit': [runsAnswer([checkRun(11, 1)]), suitesAnswer([checkSuite(1, 'main', { head_sha: BASE })])],
      'a run of another commit': [runsAnswer([checkRun(11, 1), checkRun(12, 2, { head_sha: BASE })])],
      'a runs row that is not a row': [runsAnswer([checkRun(11, 1), 'run'])],
      'a runs answer with no list': [ok({ total_count: 0 })],
      'a runs answer with no count': [ok({ check_runs: [] })],
      'a runs answer that is a list': [ok([])],
      'a suites answer with no list': [runsAnswer([checkRun(11, 1)]), ok({ total_count: 0 })],
      'a suites answer with no count': [runsAnswer([checkRun(11, 1)]), ok({ check_suites: [checkSuite(1, 'main')] })]
    };
    for (const [what, answers] of Object.entries(CASES)) {
      it(what, async () => {
        gh(...answers);
        const r = await gq.readBranchCheck(REPO, 'main', TIP, 'test');
        assert.equal(r.status, 'unavailable');
        assert.ok(r.reason);
        assert.equal(calls.length, answers.length);
      });
    }

    it('one row short of the page size is read', async () => {
      const suites = Array.from({ length: gq.CHECKS_PAGE_SIZE - 1 }, (_, i) => checkSuite(i + 1, i ? `feat/b${i}` : 'main'));
      gh(runsAnswer([checkRun(11, 1)]), suitesAnswer(suites));
      assert.equal((await gq.readBranchCheck(REPO, 'main', TIP, 'test')).status, 'concluded');
    });
  });

  describe('a read that fails is unavailable', () => {
    const FAILURES = {
      'refused by GitHub': refused(403, 'API rate limit exceeded'),
      'not found by GitHub': refused(404, 'Not Found'),
      'out of time': TIMED_OUT,
      'gh not signed in': NOT_SIGNED_IN,
      'output that is not an HTTP answer': GARBAGE,
      'a body that is not JSON': NOT_JSON,
      'a body that is null': { exitCode: 0, statusLine: 'HTTP/2.0 200 OK', body: 'null', stderr: '' }
    };
    for (const [what, failure] of Object.entries(FAILURES)) {
      it(`the runs read, ${what}: the suites are not read`, async () => {
        gh(failure);
        const r = await gq.readBranchCheck(REPO, 'main', TIP, 'test');
        assert.equal(r.status, 'unavailable');
        assert.ok(r.reason);
        assert.equal(calls.length, 1);
      });

      it(`the suites read, ${what}: a run of the branch is not answered`, async () => {
        gh(runsAnswer([checkRun(11, 1)]), failure);
        const r = await gq.readBranchCheck(REPO, 'main', TIP, 'test');
        assert.equal(r.status, 'unavailable');
        assert.ok(r.reason);
      });

      it(`the suites read, ${what}: no run of that name is still not "not-found"`, async () => {
        gh(runsAnswer([]), failure);
        assert.equal((await gq.readBranchCheck(REPO, 'main', TIP, 'test')).status, 'unavailable');
      });
    }

    it('gh that cannot be started', async () => {
      gq._internal.exec = async () => { throw new Error('spawn gh ENOENT'); };
      assert.deepEqual(await gq.readBranchCheck(REPO, 'main', TIP, 'test'),
        { status: 'unavailable', reason: 'gh api could not run (spawn gh ENOENT)' });
    });
  });

  it('asks for the named check, encoded, on that commit', async () => {
    gh(runsAnswer([]), suitesAnswer([]));
    await gq.readBranchCheck(REPO, 'main', TIP, 'build & test');
    assert.equal(calls[0].args[2], `repos/${REPO}/commits/${TIP}/check-runs?check_name=build%20%26%20test&filter=latest&per_page=100`);
    assert.equal(calls[1].args[2], `repos/${REPO}/commits/${TIP}/check-suites?per_page=100`);
  });

  it('refuses a branch that is not well formed before gh is called', async () => {
    gh();
    for (const branch of ['', ' main', 'main ', '../main', 'a..b', '/main', 'main/', 'a//b', 'a.lock', '.hidden', 'a b', 'a?b', 'a~1', 'a^', 'a:b',
      'refs/heads/main\n', 'x'.repeat(201), 7, {}, ['main'], true, undefined, null]) {
      const r = await gq.readBranchCheck(REPO, branch, TIP, 'test');
      assert.deepEqual(r, { status: 'unavailable', reason: 'the branch must be a well-formed branch name' }, String(branch));
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a missing or malformed repository, commit or name before gh is called', async () => {
    gh();
    const good = [REPO, 'main', TIP, 'test'];
    for (let i = 0; i < good.length; i++) {
      for (const bad of [undefined, null]) {
        const args = [...good];
        args[i] = bad;
        assert.equal((await gq.readBranchCheck(...args)).status, 'unavailable', `argument ${i} ${bad}`);
      }
    }
    for (const args of [['owner', 'main', TIP, 'test'], ['../etc/passwd', 'main', TIP, 'test'], [REPO, 'main', TIP.slice(0, 12), 'test'],
      [REPO, 'main', TIP.toUpperCase(), 'test'], [REPO, 'main', TIP, ''], [REPO, 'main', TIP, ' test'], [REPO, 'main', TIP, 't\u0000est']]) {
      assert.equal((await gq.readBranchCheck(...args)).status, 'unavailable', JSON.stringify(args));
    }
    assert.equal((await gq.readBranchCheck()).status, 'unavailable');
    assert.equal(calls.length, 0);
  });
});

describe('merge-queue-github — the recordings', () => {
  it('every fixture but the documented one is a recorded exchange with its call and its time', () => {
    const names = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.json'));
    assert.ok(names.includes('pull-merge-DOCUMENTED.json'));
    for (const name of names) {
      const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
      if (name === 'pull-merge-DOCUMENTED.json') {
        assert.equal(fx.captured, false);
        assert.match(fx.note, /NOT a captured response/);
        continue;
      }
      assert.ok(!Number.isNaN(Date.parse(fx.capturedAt)), name);
      assert.deepEqual(fx.args.slice(0, 2), ['api', '-i'], name);
      assert.match(fx.statusLine, /^HTTP\/[0-9.]+ [0-9]{3} /, name);
      assert.equal(typeof fx.body, 'string', name);
    }
  });
});
