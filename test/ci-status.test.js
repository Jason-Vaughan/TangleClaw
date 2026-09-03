'use strict';

/*
 * #991 — a red `main` reaches every session at start.
 *
 * The probe is `gh run list` on the origin's default branch, judged PER
 * WORKFLOW over a window of push/dispatch runs. These drive it with an
 * injected exec so every state the reader can meet is produced on purpose,
 * and pin the honesty rules: failing renders loudly, passing renders nothing,
 * a probe that could not answer renders as UNKNOWN — never as the absence of
 * a warning — and `none` is reserved for "there is no CI to be red".
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../lib/ci-status');

const RUN = {
  url: 'https://github.com/o/r/actions/runs/1', headSha: 'abcdef0123456789', updatedAt: '2026-08-18T07:00:00Z',
  workflowName: 'Tests', event: 'push', status: 'completed', conclusion: 'failure'
};

/**
 * Install an exec that answers the probe's three commands from a spec.
 * @param {object} spec - `{remote, head, repoView, runs, listError}`; each of
 *   `remote`/`head`/`repoView` is a `{exitCode, stdout, stderr, error}` or
 *   omitted for a clean default; `runs` is the JSON body; `listError` an exec
 *   result to answer `gh run list` with instead.
 * @returns {string[][]} The command log.
 */
function install(spec) {
  const calls = [];
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
  const fail = (stderr = '', extra = {}) => ({ exitCode: 1, stdout: '', stderr, error: Object.assign(new Error('exit 1'), extra) });
  ci._internal.exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = `${file} ${args.slice(0, 2).join(' ')}`;
    if (key === 'git remote get-url') return spec.remote || ok('git@github.com:o/r.git');
    if (key === 'git symbolic-ref --short') return spec.head || ok('origin/main');
    if (key === 'gh repo view') return spec.repoView || fail('gh: not logged in');
    if (key === 'gh run list') return spec.listError || ok(JSON.stringify(spec.runs || []));
    throw new Error(`unexpected command ${key}`);
  };
  install.fail = fail;
  return calls;
}

describe('#991 ci-status.refresh', () => {
  const realExec = ci._internal.exec;
  beforeEach(() => ci.clearCache());
  afterEach(() => { ci._internal.exec = realExec; });

  it('reads a failed push run as failing, with run, sha and workflow', async () => {
    const calls = install({ runs: [RUN] });
    const r = await ci.refresh('/p/a', { now: 0 });
    assert.equal(r.state, 'failing');
    assert.equal(r.branch, 'main');
    assert.equal(r.runUrl, RUN.url);
    assert.equal(r.sha, RUN.headSha);
    assert.equal(r.workflow, 'Tests');
    const list = calls.find((c) => c[0] === 'gh' && c[1] === 'run');
    assert.ok(list.includes('--branch') && list[list.indexOf('--branch') + 1] === 'main', 'asks about the origin default branch');
    assert.equal(list[list.indexOf('--limit') + 1], '20', 'a window, not the single newest run');
  });

  it('judges per workflow: a newer green scheduled run does not hide a red test run', async () => {
    // The 2026-08-18 shape with this repo's real workflow mix: a red Tests
    // push, then a green upstream-drift cron and a green release push on top.
    install({ runs: [
      { ...RUN, workflowName: 'upstream-drift', event: 'schedule', conclusion: 'success', updatedAt: '2026-08-19T06:17:00Z' },
      { ...RUN, workflowName: 'Release', event: 'push', conclusion: 'success', updatedAt: '2026-08-18T09:00:00Z' },
      RUN
    ] });
    const r = await ci.refresh('/p/b', { now: 0 });
    assert.equal(r.state, 'failing', 'the newest push run of the Tests workflow is red');
    assert.equal(r.workflow, 'Tests', 'and the failing workflow is the one named');
  });

  it('a newer green run of the SAME workflow does clear an older red one', async () => {
    install({ runs: [{ ...RUN, conclusion: 'success', updatedAt: '2026-08-18T11:00:00Z' }, RUN] });
    assert.equal((await ci.refresh('/p/c', { now: 0 })).state, 'passing');
  });

  it('ignores scheduled runs entirely — a red nightly is not the trunk\'s verdict', async () => {
    install({ runs: [{ ...RUN, workflowName: 'upstream-drift', event: 'schedule' }] });
    const r = await ci.refresh('/p/d', { now: 0 });
    assert.equal(r.state, 'none');
    assert.match(r.reason, /no push-triggered workflow runs/);
  });

  it('reads a workflow whose newest run has not completed as in-progress, not a verdict', async () => {
    install({ runs: [{ ...RUN, status: 'in_progress', conclusion: null }] });
    assert.equal((await ci.refresh('/p/e', { now: 0 })).state, 'in-progress');
  });

  it('reads no origin remote as none — there is no CI to be red — and never asks gh', async () => {
    const calls = install({ remote: install.fail('fatal: No such remote') });
    const r = await ci.refresh('/p/f', { now: 0 });
    assert.equal(r.state, 'none');
    assert.equal(r.reason, 'no origin remote');
    assert.equal(calls.filter((c) => c[0] === 'gh').length, 0);
  });

  it('an origin whose origin/HEAD is unset is resolved through gh repo view', async () => {
    const ok = { exitCode: 0, stdout: 'develop\n', stderr: '', error: null };
    install({ head: install.fail('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'), repoView: ok, runs: [RUN] });
    const r = await ci.refresh('/p/g', { now: 0 });
    assert.equal(r.branch, 'develop');
    assert.equal(r.state, 'failing');
  });

  it('an origin whose default branch cannot be named is UNKNOWN with a remedy — not silence', async () => {
    // `origin/HEAD` is written by `git clone`, not by `git remote add`; four
    // projects on the developer box were in this shape when this shipped.
    install({ head: install.fail('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref') });
    const r = await ci.refresh('/p/h', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /git remote set-head origin -a/);
    assert.match(r.reason, /gh: not logged in/);
  });

  it('reads a missing gh as UNKNOWN with the reason, never as passing', async () => {
    install({ listError: install.fail('', { code: 'ENOENT' }) });
    const r = await ci.refresh('/p/i', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.equal(r.reason, 'gh is not installed');
  });

  it('reads a missing git as UNKNOWN, not as "no origin"', async () => {
    install({ remote: install.fail('', { code: 'ENOENT' }) });
    const r = await ci.refresh('/p/j', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.equal(r.reason, 'git is not installed');
  });

  it('reads a gh failure as UNKNOWN carrying gh\'s first stderr line', async () => {
    install({ listError: install.fail('\nTo get started with GitHub CLI, please run:  gh auth login\n') });
    const r = await ci.refresh('/p/k', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /gh auth login/);
  });

  it('reads a timed-out gh as UNKNOWN naming the timeout', async () => {
    install({ listError: install.fail('', { killed: true, signal: 'SIGTERM' }) });
    const r = await ci.refresh('/p/l', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /timed out/);
  });

  it('reads a cancelled or verdict-less conclusion as unknown, not passing', async () => {
    for (const conclusion of ['cancelled', 'skipped', null]) {
      ci.clearCache();
      install({ runs: [{ ...RUN, conclusion }] });
      const r = await ci.refresh('/p/m', { now: 0 });
      assert.equal(r.state, 'unknown', `conclusion ${conclusion}`);
    }
  });

  it('caches per project for the TTL and re-asks after it', async () => {
    const calls = install({ runs: [RUN] });
    await ci.refresh('/p/n', { now: 0, ttlMs: 1000 });
    await ci.refresh('/p/n', { now: 500, ttlMs: 1000 });
    assert.equal(calls.filter((c) => c[0] === 'gh').length, 1, 'a second launch inside the TTL asks GitHub once');
    await ci.refresh('/p/n', { now: 1500, ttlMs: 1000 });
    assert.equal(calls.filter((c) => c[0] === 'gh').length, 2, 'and re-asks after it');
  });
});

describe('#991 ci-status.readCached', () => {
  const realExec = ci._internal.exec;
  beforeEach(() => ci.clearCache());
  afterEach(() => { ci._internal.exec = realExec; });

  it('hands back the refreshed verdict without spawning', async () => {
    const calls = install({ runs: [RUN] });
    await ci.refresh('/p/o', { now: 0 });
    const before = calls.length;
    assert.equal(ci.readCached('/p/o', { now: 10 }).state, 'failing');
    assert.equal(calls.length, before, 'a read is a read');
  });

  it('a cold cache is an honest unknown, not a spawn and not green', () => {
    const calls = install({ runs: [RUN] });
    const r = ci.readCached('/p/p', { now: 0 });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /not probed before this launch/);
    assert.equal(calls.length, 0);
  });
});

describe('#991 primeLines', () => {
  it('renders a failing base branch loudly, naming run, sha and the consequence', () => {
    const lines = ci.primeLines({ state: 'failing', branch: 'main', runUrl: RUN.url, sha: RUN.headSha, workflow: 'Tests', updatedAt: RUN.updatedAt }).join('\n');
    assert.match(lines, /main is FAILING/);
    assert.match(lines, /run https:\/\/github\.com\/o\/r\/actions\/runs\/1 on abcdef0 \(Tests\)/);
    assert.match(lines, /release must not be cut/);
    assert.match(lines, /Say so to the operator/);
  });

  it('renders unknown AS unknown, says it is not green, and asks the session to relay it', () => {
    const lines = ci.primeLines({ state: 'unknown', branch: 'main', reason: 'gh is not installed' }).join('\n');
    assert.match(lines, /\*\*unknown\*\* — gh is not installed/);
    assert.match(lines, /Not green/);
    assert.match(lines, /Mention it to the operator/, 'the operator is the only one who can fix the probe');
    assert.doesNotMatch(lines, /FAILING/);
  });

  it('renders an in-progress run as no verdict yet', () => {
    const lines = ci.primeLines({ state: 'in-progress', branch: 'main', runUrl: RUN.url }).join('\n');
    assert.match(lines, /in progress/);
    assert.match(lines, /verdict is not in yet/);
  });

  it('renders nothing for passing and for none — a green line on every launch is noise', () => {
    assert.deepEqual(ci.primeLines({ state: 'passing', branch: 'main' }), []);
    assert.deepEqual(ci.primeLines({ state: 'none', branch: null, reason: 'no origin remote' }), []);
    assert.deepEqual(ci.primeLines(null), []);
  });
});

describe('#991 the launch route warms the cache before the synchronous launch reads it', () => {
  it('server.js awaits ci-status.refresh ahead of launchSession in the launch route', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const route = src.slice(src.indexOf("route('POST', '/api/sessions/:project',"), src.indexOf('sessions.launchSession(params.project'));
    assert.match(route, /await ciStatus\.refresh\(project\.path\)/,
      'the spawn belongs off the event loop, ahead of the sync prime generator');
  });
});
