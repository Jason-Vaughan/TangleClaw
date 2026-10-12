'use strict';

// #2323: the reader of one named check on one exact commit. The answers it is
// tested against start from real responses captured from this repository
// (test/fixtures/github-checks/), cut down the way the reader's own `--jq`
// projection cuts them. No test calls GitHub: `gh` is replaced at the seam.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checks = require('../lib/github-checks');

const FIXTURES = path.join(__dirname, 'fixtures', 'github-checks');
const REPO = 'Jason-Vaughan/TangleClaw';
// The commit the first fixture was captured from, and its `test` run.
const SHA = 'f75070546360a5c4034d8a927bfa1a0bc6947e55';
const TEST_RUN_ID = '114669381605';
const TEST_WORKFLOW_RUN_ID = '38205955903';
// A later commit, captured with the workflow run its `test` run belongs to (#2321).
const ACTIONS_SHA = '06ac528fe7faf370565cf36320d62b602e11c3d0';

/**
 * A captured GitHub response.
 * @param {string} name - Fixture file name
 * @returns {object}
 */
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * What `gh api ...?check_name=<name> --jq <projection>` prints for a raw
 * response: only the runs of that name, and only the fields the reader keeps.
 * @param {object} raw - A raw check-runs response
 * @param {string} name - The check name asked for
 * @returns {string} JSON text
 */
function answerFor(raw, name) {
  const runs = raw.check_runs.filter((r) => r.name === name).map((r) => ({
    id: r.id, name: r.name, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion,
    started_at: r.started_at, completed_at: r.completed_at, app: r.app ? r.app.slug : null, details_url: r.details_url
  }));
  return JSON.stringify({ total_count: runs.length, check_runs: runs });
}

/**
 * One projected run of the `test` check on {@link SHA}.
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function run(fields = {}) {
  return {
    id: 100, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success',
    started_at: '2026-10-12T04:58:35Z', completed_at: '2026-10-12T05:13:25Z',
    app: 'github-actions', details_url: `https://github.com/${REPO}/actions/runs/7001/job/100`, ...fields
  };
}

/**
 * The JSON text of an answer holding these runs.
 * @param {object[]} runs - Projected runs
 * @param {number} [total] - `total_count`, when it should differ from the number of runs
 * @returns {string}
 */
function answer(runs, total = runs.length) {
  return JSON.stringify({ total_count: total, check_runs: runs });
}

const realExec = checks._internal.exec;
let calls = [];

/**
 * Replace `gh` with a function that answers once with `result`.
 * @param {object|Function} result - An exec result, or a function of the args returning one
 * @returns {void}
 */
function gh(result) {
  checks._internal.exec = async (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return typeof result === 'function' ? result(args) : result;
  };
}

/**
 * A successful exec result printing `stdout`.
 * @param {string} stdout - What gh printed
 * @returns {object}
 */
function ok(stdout) {
  return { exitCode: 0, stdout, stderr: '', error: null, errorCode: null, signal: null, timedOut: false };
}

describe('github-checks: readCheck (#2323)', () => {
  beforeEach(() => { calls = []; });
  afterEach(() => { checks._internal.exec = realExec; });

  it('reads a finished check from a real captured response: the conclusion, the run and when it completed', async () => {
    gh(ok(answerFor(fixture('commit-with-runs.json'), 'test')));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
      status: 'concluded', conclusion: 'success', runId: TEST_RUN_ID, completedAt: '2026-10-12T05:13:25.000Z',
      app: 'github-actions', workflowRunId: TEST_WORKFLOW_RUN_ID
    });
  });

  it('reads the answer GitHub really gave to the request this reader sends, name filter and projection included', async () => {
    // Captured through the reader's own seam from the real request for `test` on this commit.
    const captured = fs.readFileSync(path.join(FIXTURES, 'named-check-projected.json'), 'utf8');
    gh(ok(captured));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
      status: 'concluded', conclusion: 'success', runId: TEST_RUN_ID, completedAt: '2026-10-12T05:13:25.000Z',
      app: 'github-actions', workflowRunId: TEST_WORKFLOW_RUN_ID
    });
    // The commit has two runs; asked for one name, GitHub counts only that name's. The helper below assumes the same.
    assert.equal(JSON.parse(captured).total_count, 1);
    assert.equal(fixture('commit-with-runs.json').total_count, 2);
    assert.deepEqual(JSON.parse(captured), JSON.parse(answerFor(fixture('commit-with-runs.json'), 'test')));
  });

  it('asks GitHub once, for that commit and that name only, and keeps only the fields it reads', async () => {
    gh(ok(answerFor(fixture('commit-with-runs.json'), 'Vercel Preview Comments')));
    const reading = await checks.readCheck(REPO, SHA, 'Vercel Preview Comments');
    assert.equal(reading.status, 'concluded');
    assert.equal(calls.length, 1);
    const [api, apiPath, flag, projection] = calls[0].args;
    assert.equal(api, 'api');
    assert.equal(apiPath, `repos/${REPO}/commits/${SHA}/check-runs?check_name=Vercel%20Preview%20Comments&filter=latest&per_page=100`);
    assert.equal(flag, '--jq');
    assert.equal(reading.app, 'vercel');
    assert.equal('workflowRunId' in reading, false);
    for (const field of ['total_count', 'id', 'name', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at', '.app.slug', 'details_url']) {
      assert.ok(projection.includes(field), field);
    }
    assert.equal(calls[0].timeoutMs, checks.EXEC_TIMEOUT_MS);
  });

  it('a name with characters a URL gives meaning to is sent as data, not as part of the request', async () => {
    gh(ok(answer([])));
    await checks.readCheck(REPO, SHA, 'build & test?x=1#y / e2e');
    assert.ok(calls[0].args[1].includes('check_name=build%20%26%20test%3Fx%3D1%23y%20%2F%20e2e&filter=latest'));
  });

  it('a commit with no check runs at all reads not-found (a real captured response)', async () => {
    gh(ok(answerFor(fixture('commit-without-runs.json'), 'test')));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), { status: 'not-found' });
  });

  it('a commit whose runs have other names reads not-found', async () => {
    gh(ok(answer([run({ name: 'lint' }), run({ id: 101, name: 'Test' })])));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), { status: 'not-found' });
  });

  it('a run that has not finished reads running, whatever GitHub calls the wait', async () => {
    for (const status of checks.UNFINISHED_STATUSES) {
      gh(ok(answer([run({ status, conclusion: null, completed_at: null })])));
      assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
        status: 'running', runId: '100', app: 'github-actions', workflowRunId: '7001'
      }, status);
    }
    assert.deepEqual([...checks.UNFINISHED_STATUSES].sort(), ['in_progress', 'pending', 'queued', 'requested', 'waiting']);
  });

  it('every conclusion GitHub gives a finished run is read as that conclusion', async () => {
    for (const conclusion of checks.CONCLUSIONS) {
      gh(ok(answer([run({ conclusion })])));
      const reading = await checks.readCheck(REPO, SHA, 'test');
      assert.deepEqual(reading, {
        status: 'concluded', conclusion, runId: '100', completedAt: '2026-10-12T05:13:25.000Z', app: 'github-actions', workflowRunId: '7001'
      }, conclusion);
    }
    assert.deepEqual([...checks.CONCLUSIONS].sort(), [
      'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out'
    ]);
  });

  it('of two runs of the same name the one that started later wins, in either order', async () => {
    const first = run({ id: 500, conclusion: 'failure', started_at: '2026-10-12T04:00:00Z' });
    const rerun = run({ id: 400, conclusion: 'success', started_at: '2026-10-12T05:00:00Z' });
    for (const runs of [[first, rerun], [rerun, first]]) {
      gh(ok(answer(runs)));
      const reading = await checks.readCheck(REPO, SHA, 'test');
      assert.equal(reading.conclusion, 'success');
      assert.equal(reading.runId, '400');
    }
  });

  it('a re-run still running hides the finished run it replaces', async () => {
    gh(ok(answer([
      run({ id: 1, conclusion: 'failure', started_at: '2026-10-12T04:00:00Z' }),
      run({ id: 2, status: 'in_progress', conclusion: null, completed_at: null, started_at: '2026-10-12T05:00:00Z' })
    ])));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
      status: 'running', runId: '2', app: 'github-actions', workflowRunId: '7001'
    });
  });

  it('two runs that started together, or with no start time, are told apart by id: the higher is newer', async () => {
    for (const startedAt of ['2026-10-12T04:00:00Z', null]) {
      for (const ids of [[7, 9], [9, 7]]) {
        gh(ok(answer([
          run({ id: ids[0], started_at: startedAt, conclusion: ids[0] === 9 ? 'success' : 'failure' }),
          run({ id: ids[1], started_at: startedAt, conclusion: ids[1] === 9 ? 'success' : 'failure' })
        ])));
        const reading = await checks.readCheck(REPO, SHA, 'test');
        assert.equal(reading.runId, '9');
        assert.equal(reading.conclusion, 'success');
      }
    }
  });

  it('a gh that times out is unavailable, with the reason, and is not read as running or failed', async () => {
    gh({ exitCode: 124, stdout: '', stderr: '', error: 'timed out after 10000ms', errorCode: null, signal: null, timedOut: true });
    const reading = await checks.readCheck(REPO, SHA, 'test');
    assert.equal(reading.status, 'unavailable');
    assert.match(reading.reason, /gh api timed out after 10000ms/);
  });

  it('a gh that is missing, that fails, or that throws is unavailable with the reason', async () => {
    gh({ exitCode: 1, stdout: '', stderr: '', error: 'spawn gh ENOENT', errorCode: 'ENOENT', signal: null, timedOut: false });
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), { status: 'unavailable', reason: 'gh is not installed' });

    gh({ exitCode: 1, stdout: '', stderr: `gh: No commit found for SHA: ${SHA} (HTTP 422)\n`, error: null, errorCode: null, signal: null, timedOut: false });
    const unknownCommit = await checks.readCheck(REPO, SHA, 'test');
    assert.equal(unknownCommit.status, 'unavailable');
    assert.match(unknownCommit.reason, /No commit found/);

    gh({ exitCode: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)\n', error: null, errorCode: null, signal: null, timedOut: false });
    assert.match((await checks.readCheck(REPO, SHA, 'test')).reason, /rate limit/);

    gh(() => { throw new Error('boom'); });
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), { status: 'unavailable', reason: 'gh api could not run (boom)' });

    gh(undefined);
    assert.equal((await checks.readCheck(REPO, SHA, 'test')).status, 'unavailable');
  });

  it('an answer it cannot understand is unavailable, never a guess', async () => {
    const bad = {
      'not JSON': 'Not Found',
      'empty': '',
      'a list': '[]',
      'null': 'null',
      'no check_runs': JSON.stringify({ total_count: 0 }),
      'no total_count': JSON.stringify({ check_runs: [] }),
      'a run that is not an object': answer([null]),
      'a run with no id': answer([run({ id: null })]),
      'a run with a text id': answer([run({ id: '100' })]),
      'a run with no status': answer([run({ status: null })]),
      'a status it does not know': answer([run({ status: 'paused' })]),
      'a conclusion it does not know': answer([run({ conclusion: 'meh' })]),
      'finished with no conclusion': answer([run({ conclusion: null })]),
      'finished with no completion time': answer([run({ completed_at: null })]),
      'finished with a completion time that is not a time': answer([run({ completed_at: 'yesterday' })]),
      'a run of another commit': answer([run({ head_sha: 'b'.repeat(40) })]),
      'a run of another commit beside the right one': answer([run(), run({ id: 101, head_sha: 'b'.repeat(40) })]),
      'more runs than it was given': answer([run()], 101),
      'a finished run with no app': answer([run({ app: null })]),
      'a finished run whose app is missing': answer([run({ app: undefined })]),
      'a running run with no app': answer([run({ status: 'in_progress', conclusion: null, completed_at: null, app: null })]),
      'an app that is not text': answer([run({ app: { slug: 'github-actions' } })]),
      'an app that is empty': answer([run({ app: '' })]),
      'an app that is not a slug': answer([run({ app: 'github actions\n' })])
    };
    for (const [what, stdout] of Object.entries(bad)) {
      gh(ok(stdout));
      const reading = await checks.readCheck(REPO, SHA, 'test');
      assert.equal(reading.status, 'unavailable', what);
      assert.ok(reading.reason && typeof reading.reason === 'string', what);
      assert.deepEqual(Object.keys(reading).sort(), ['reason', 'status'], what);
    }
  });

  it('a malformed repository, commit or name is refused before gh runs', async () => {
    gh(ok(answer([run()])));
    const refused = [
      [undefined, SHA, 'test'],
      ['TangleClaw', SHA, 'test'],
      ['a/b/c', SHA, 'test'],
      ['-owner/repo', SHA, 'test'],
      ['owner/..', SHA, 'test'],
      ['owner/re po', SHA, 'test'],
      ['owner/repo?x=1', SHA, 'test'],
      [REPO, undefined, 'test'],
      [REPO, SHA.slice(0, 7), 'test'],
      [REPO, SHA.toUpperCase(), 'test'],
      [REPO, `${SHA.slice(0, 39)}g`, 'test'],
      [REPO, `${SHA}/../x`, 'test'],
      [REPO, 'main', 'test'],
      [REPO, SHA, undefined],
      [REPO, SHA, ''],
      [REPO, SHA, ' test'],
      [REPO, SHA, 'test '],
      [REPO, SHA, 'te\nst'],
      [REPO, SHA, 'te\u0000st'],
      [REPO, SHA, 'x'.repeat(checks.MAX_CHECK_NAME + 1)],
      [REPO, SHA, 42]
    ];
    for (const [repo, sha, name] of refused) {
      const reading = await checks.readCheck(repo, sha, name);
      assert.equal(reading.status, 'unavailable', JSON.stringify([repo, sha, name]));
      assert.equal(reading.reason, checks.invalidRequest(repo, sha, name));
    }
    assert.equal(calls.length, 0);

    assert.equal(checks.invalidRequest(REPO, SHA, 'x'.repeat(checks.MAX_CHECK_NAME)), null);
    assert.equal(checks.invalidRequest('o/r.git-2_x', SHA, 'CI / build (ubuntu-latest, 20.x)'), null);
  });

  it('a GitHub Actions run names its app and its workflow run, from a real captured response with the run it names', async () => {
    const raw = fixture('commit-with-actions-run.json');
    gh(ok(answerFor(raw, 'test')));
    const reading = await checks.readCheck(REPO, ACTIONS_SHA, 'test');
    assert.deepEqual(reading, {
      status: 'concluded', conclusion: 'success', runId: '114790539875', completedAt: '2026-10-12T11:45:25.000Z',
      app: 'github-actions', workflowRunId: '38243179635'
    });
    // The workflow run GitHub gave for that id is the one this commit's `test` job ran in.
    const workflowRun = fixture('workflow-run.json');
    assert.equal(String(workflowRun.id), reading.workflowRunId);
    assert.equal(workflowRun.head_sha, ACTIONS_SHA);
    assert.equal(workflowRun.check_suite_id, raw.check_runs.find((r) => r.name === 'test').check_suite.id);
  });

  it('another app\'s run is reported with that app and no workflow run (a real captured response)', async () => {
    gh(ok(answerFor(fixture('commit-with-actions-run.json'), 'Vercel Preview Comments')));
    assert.deepEqual(await checks.readCheck(REPO, ACTIONS_SHA, 'Vercel Preview Comments'), {
      status: 'concluded', conclusion: 'success', runId: '114790634624', completedAt: '2026-10-12T11:31:33.000Z', app: 'vercel'
    });
  });

  it('a check of the same name made by another app is reported as that app\'s, not refused and not called CI\'s', async () => {
    // It copies a real job's link; the link is the app's own word, so it earns no workflow run.
    gh(ok(answer([run({ app: 'some-other-app' })])));
    assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
      status: 'concluded', conclusion: 'success', runId: '100', completedAt: '2026-10-12T05:13:25.000Z', app: 'some-other-app'
    });
  });

  it('a link of any other shape gives no workflow run and still an answer', async () => {
    const others = [
      null, undefined, 42, '', 'https://vercel.com/github',
      `https://github.com/${REPO}/runs/100`,
      `https://github.com/${REPO}/actions/runs/7001`,
      `https://github.com/${REPO}/actions/runs/7001/job/100/extra`,
      `https://github.com/${REPO}/actions/runs/7001/job/100?x=1`,
      `https://github.com/${REPO}/actions/runs/0/job/100`,
      `https://github.com/${REPO}/actions/runs/7001x/job/100`,
      `http://github.com/${REPO}/actions/runs/7001/job/100`,
      `https://github.com.example/${REPO}/actions/runs/7001/job/100`,
      `https://example.com/?u=https://github.com/${REPO}/actions/runs/7001/job/100`,
      'https://github.com/someone/else/actions/runs/7001/job/100',
      `https://github.com/${REPO}/extra/actions/runs/7001/job/100`
    ];
    for (const detailsUrl of others) {
      gh(ok(answer([run({ details_url: detailsUrl })])));
      assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
        status: 'concluded', conclusion: 'success', runId: '100', completedAt: '2026-10-12T05:13:25.000Z', app: 'github-actions'
      }, String(detailsUrl));
    }
  });

  it('the workflow run is read whatever case the repository was asked in, as GitHub reads it', async () => {
    gh(ok(answer([run()])));
    assert.equal((await checks.readCheck(REPO.toLowerCase(), SHA, 'test')).workflowRunId, '7001');
  });

  it('two runs of one name from different apps: the newer wins as before, and the answer names its app', async () => {
    const actions = run({ id: 500, conclusion: 'failure', started_at: '2026-10-12T04:00:00Z' });
    const other = run({ id: 400, app: 'some-other-app', started_at: '2026-10-12T05:00:00Z' });
    for (const runs of [[actions, other], [other, actions]]) {
      gh(ok(answer(runs)));
      assert.deepEqual(await checks.readCheck(REPO, SHA, 'test'), {
        status: 'concluded', conclusion: 'success', runId: '400', completedAt: '2026-10-12T05:13:25.000Z', app: 'some-other-app'
      });
    }
    // An older run with no app does not spoil the reading of the newer one, which is the only one read.
    gh(ok(answer([run({ id: 1, app: null, started_at: '2026-10-12T04:00:00Z' }), run({ id: 2, started_at: '2026-10-12T05:00:00Z' })])));
    assert.equal((await checks.readCheck(REPO, SHA, 'test')).app, 'github-actions');
  });

  it('interpret, given no repository, names the app and reads no workflow run', () => {
    assert.deepEqual(checks.interpret(JSON.parse(answer([run()])), SHA, 'test'), {
      status: 'concluded', conclusion: 'success', runId: '100', completedAt: '2026-10-12T05:13:25.000Z', app: 'github-actions'
    });
    assert.equal(checks.ACTIONS_APP, 'github-actions');
  });

  it('nothing is cached: two reads ask GitHub twice and each says what GitHub said then', async () => {
    let n = 0;
    gh(() => ok(answer([run(n++ === 0 ? { status: 'in_progress', conclusion: null, completed_at: null } : {})])));
    assert.equal((await checks.readCheck(REPO, SHA, 'test')).status, 'running');
    assert.equal((await checks.readCheck(REPO, SHA, 'test')).status, 'concluded');
    assert.equal(calls.length, 2);
  });
});
