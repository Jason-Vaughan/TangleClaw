'use strict';

// #2322: every GitHub read and write the merge queue makes. `gh` is replaced at
// the seam by exchanges recorded against the real repository
// (test/fixtures/merge-queue-github/README.md says when, from what, which two
// were sent by the probe and not by the module, and which one file is written
// from GitHub's documentation instead). No test calls GitHub.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gq = require('../lib/merge-queue-github');

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
  it('creates the branch at the base and merges the head into it, from the recorded exchanges', async () => {
    const [ref, merge] = [recorded('ref-created'), recorded('merge-created')];
    gh(ref, merge);
    assert.deepEqual(await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD), {
      status: 'created', ref: CANDIDATE, sha: CANDIDATE_SHA, tree: TREE, parents: [BASE, HEAD], refCreated: true
    });
    assert.deepEqual(calls.map((c) => c.args), [ref.args, merge.args]);
    assert.ok(calls.every((c) => c.timeoutMs === gq.WRITE_TIMEOUT_MS));
  });

  it('answers ref-exists and merges nothing when the branch is already there', async () => {
    gh(recorded('ref-create-exists'));
    assert.deepEqual(await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD), { status: 'ref-exists', ref: CANDIDATE, refCreated: false });
    assert.equal(calls.length, 1);
  });

  it('answers conflict, with the branch made, when the two commits do not merge', async () => {
    gh(recorded('ref-created'), recorded('merge-conflict'));
    assert.deepEqual(await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD), { status: 'conflict', ref: CANDIDATE, refCreated: true });
  });

  it('answers nothing-to-merge, with the branch made, when the base already holds the head', async () => {
    gh(recorded('ref-created'), recorded('merge-nothing'));
    assert.deepEqual(await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD), { status: 'nothing-to-merge', ref: CANDIDATE, refCreated: true });
  });

  it('answers unavailable for a merge that is not of exactly these two commits, base first', async () => {
    const other = '9'.repeat(40);
    for (const parents of [[HEAD, BASE], [BASE, other], [other, HEAD], [BASE], [BASE, HEAD, other]]) {
      gh(recorded('ref-created'), { exitCode: 0, statusLine: 'HTTP/2.0 201 Created', body: JSON.stringify({ sha: CANDIDATE_SHA, tree: TREE, parents }), stderr: '' });
      const r = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
      assert.equal(r.status, 'unavailable', JSON.stringify(parents));
      assert.equal(r.refCreated, true);
      assert.ok(!('applied' in r));
    }
  });

  it('answers unavailable when the created reference is not this branch at the base', async () => {
    gh({ exitCode: 0, statusLine: 'HTTP/2.0 201 Created', body: JSON.stringify({ ref: `refs/heads/${CANDIDATE}`, sha: HEAD, type: 'commit' }), stderr: '' });
    const r = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.refCreated, true);
    assert.equal(calls.length, 1, 'nothing is merged into a branch that is not where it should be');
  });

  it('says the branch was not made when GitHub refuses to create it, and that it is not known after a timeout', async () => {
    gh(refused(422, 'Object does not exist'));
    const no = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.deepEqual([no.status, no.refCreated], ['unavailable', false]);
    assert.match(no.reason, /HTTP 422: Object does not exist/);
    gh(TIMED_OUT);
    const unknown = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.deepEqual([unknown.status, unknown.refCreated], ['unavailable', null]);
    gh(refused(502, 'Bad Gateway'));
    const gateway = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.equal(gateway.refCreated, null);
  });

  it('says the branch exists when the merge into it is refused or its outcome is not known, and never that nothing changed', async () => {
    gh(recorded('ref-created'), refused(404, 'Head does not exist'));
    const no = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.deepEqual([no.status, no.refCreated], ['unavailable', true]);
    assert.ok(!('applied' in no));
    gh(recorded('ref-created'), TIMED_OUT);
    const unknown = await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.deepEqual([unknown.status, unknown.refCreated], ['unavailable', true]);
    assert.ok(!('applied' in unknown));
  });

  it('writes only under refs/heads/tc-queue/, and refuses any other branch before gh is called', async () => {
    gh();
    for (const ref of ['main', 'v5-baseline', 'feat/x', 'tc-queue', 'tc-queue/', 'tc-queue/a/b', 'tc-queue/../main', 'tc-queue/.hidden',
      'tc-queue/a.lock', 'tc-queue/a.', 'refs/heads/tc-queue/a', 'TC-QUEUE/a', ' tc-queue/a', 'tc-queue/a b', `tc-queue/${'a'.repeat(101)}`, '', null, undefined, 7]) {
      const r = await gq.createCandidate(REPO, ref, BASE, HEAD);
      assert.deepEqual([r.status, r.refCreated], ['unavailable', false], String(ref));
      assert.match(r.reason, /one name under tc-queue\//);
    }
    assert.equal(calls.length, 0);
    gh(recorded('ref-created'), recorded('merge-created'));
    await gq.createCandidate(REPO, CANDIDATE, BASE, HEAD);
    assert.ok(calls[0].args.includes(`ref=refs/heads/${CANDIDATE}`));
    assert.ok(calls[1].args.includes(`base=${CANDIDATE}`));
  });

  it('refuses a base or head that is not a full commit id before gh is called', async () => {
    gh();
    for (const [base, head] of [[BASE.slice(0, 7), HEAD], [BASE, 'main'], [BASE.toUpperCase(), HEAD], [BASE, undefined]]) {
      assert.equal((await gq.createCandidate(REPO, CANDIDATE, base, head)).status, 'unavailable');
    }
    assert.equal(calls.length, 0);
  });
});

describe('merge-queue-github — deleting a candidate', () => {
  it('deletes the branch, from the recorded exchange', async () => {
    const fx = recorded('ref-deleted');
    gh(fx);
    assert.deepEqual(await gq.deleteRef(REPO, CANDIDATE), { status: 'deleted' });
    assert.deepEqual(calls[0].args, fx.args);
  });

  it('says not-found when the branch is already gone', async () => {
    gh(recorded('ref-delete-missing'));
    assert.deepEqual(await gq.deleteRef(REPO, CANDIDATE), { status: 'not-found' });
  });

  it('refuses every branch that is not directly under tc-queue/ before gh is called', async () => {
    gh();
    for (const ref of ['main', 'v5-baseline', 'metrics', 'feat/2322-02-merge-queue-github', 'tc-queue/a/b', 'tc-queue/../main', 'heads/tc-queue/a', '', null]) {
      const r = await gq.deleteRef(REPO, ref);
      assert.deepEqual([r.status, r.applied], ['unavailable', false], String(ref));
      assert.match(r.reason, /only a branch under tc-queue\//);
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
    assert.deepEqual([(await gq.deleteRef(REPO, CANDIDATE)).applied], [null]);
    gh(GARBAGE);
    assert.deepEqual([(await gq.deleteRef(REPO, CANDIDATE)).applied], [null]);
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
        await gq.createCandidate(repo, CANDIDATE, BASE, HEAD), await gq.deleteRef(repo, CANDIDATE), await gq.mergePull(repo, 7, HEAD)
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

  it('knows a candidate branch from any other', () => {
    assert.equal(gq.isCandidateRef(CANDIDATE), true);
    assert.equal(gq.isCandidateRef('tc-queue/e_17.a-b'), true);
    assert.equal(gq.isCandidateRef('main'), false);
    assert.equal(gq.isCandidateRef('tc-queue/a/b'), false);
    assert.equal(gq.CANDIDATE_PREFIX, 'tc-queue/');
    assert.ok(CANDIDATE.startsWith(gq.CANDIDATE_PREFIX));
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
