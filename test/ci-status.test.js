'use strict';

/*
 * #991 — a red `main` reaches every session at start.
 *
 * The probe is `gh run list` on the origin's default branch. These drive it
 * with an injected exec so every state the reader can meet is produced on
 * purpose, and pin the honesty rules: failing renders loudly, passing renders
 * nothing, and a probe that could not answer renders as UNKNOWN — never as
 * the absence of a warning.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../lib/ci-status');

/**
 * An exec that answers `git symbolic-ref` with a branch and `gh run list` with
 * a canned JSON body (or throws what `gh` would).
 * @param {object} spec - `{branch, runs, ghError}`.
 * @returns {Function} `(cwd, cmd, args) => stdout`, with a `.calls` log.
 */
function fakeExec(spec) {
  const fn = (cwd, cmd, args) => {
    fn.calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (spec.branch === null) { const e = new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'); throw e; }
      return `origin/${spec.branch}`;
    }
    if (cmd === 'gh') {
      if (spec.ghError) throw spec.ghError;
      return JSON.stringify(spec.runs);
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  fn.calls = [];
  return fn;
}

const RUN = {
  url: 'https://github.com/o/r/actions/runs/1', headSha: 'abcdef0123456789', updatedAt: '2026-08-18T07:00:00Z',
  workflowName: 'Tests'
};

describe('#991 probeMainCi', () => {
  beforeEach(() => ci.clearCache());

  it('reads a failed completed run as failing, with the run, sha and workflow', () => {
    const exec = fakeExec({ branch: 'main', runs: [{ ...RUN, status: 'completed', conclusion: 'failure' }] });
    const r = ci.probeMainCi('/p/a', { exec, now: 0 });
    assert.equal(r.state, 'failing');
    assert.equal(r.branch, 'main');
    assert.equal(r.runUrl, RUN.url);
    assert.equal(r.sha, RUN.headSha);
    assert.equal(r.workflow, 'Tests');
    assert.deepEqual(exec.calls[1].slice(0, 5), ['gh', 'run', 'list', '--branch', 'main'], 'asks about the origin default branch');
  });

  it('reads a successful run as passing', () => {
    const exec = fakeExec({ branch: 'main', runs: [{ ...RUN, status: 'completed', conclusion: 'success' }] });
    assert.equal(ci.probeMainCi('/p/b', { exec, now: 0 }).state, 'passing');
  });

  it('reads a run that has not completed as in-progress, not as a verdict', () => {
    const exec = fakeExec({ branch: 'main', runs: [{ ...RUN, status: 'in_progress', conclusion: null }] });
    const r = ci.probeMainCi('/p/c', { exec, now: 0 });
    assert.equal(r.state, 'in-progress');
  });

  it('reads no origin as none — there is no CI to be red', () => {
    const exec = fakeExec({ branch: null });
    const r = ci.probeMainCi('/p/d', { exec, now: 0 });
    assert.equal(r.state, 'none');
    assert.equal(exec.calls.length, 1, 'gh is never asked without a branch');
  });

  it('reads an empty run list as none', () => {
    const exec = fakeExec({ branch: 'develop', runs: [] });
    const r = ci.probeMainCi('/p/e', { exec, now: 0 });
    assert.equal(r.state, 'none');
    assert.match(r.reason, /no workflow runs on develop/);
  });

  it('reads a missing gh as UNKNOWN with the reason, never as passing', () => {
    const err = new Error('spawn gh ENOENT'); err.code = 'ENOENT';
    const exec = fakeExec({ branch: 'main', ghError: err });
    const r = ci.probeMainCi('/p/f', { exec, now: 0 });
    assert.equal(r.state, 'unknown');
    assert.equal(r.reason, 'gh is not installed');
  });

  it('reads a gh failure as UNKNOWN carrying gh\'s first stderr line', () => {
    const err = new Error('exit 4'); err.stderr = '\nTo get started with GitHub CLI, please run:  gh auth login\n';
    const exec = fakeExec({ branch: 'main', ghError: err });
    const r = ci.probeMainCi('/p/g', { exec, now: 0 });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /gh auth login/);
  });

  it('reads a cancelled or otherwise verdict-less conclusion as unknown, not passing', () => {
    for (const conclusion of ['cancelled', 'skipped', null]) {
      ci.clearCache();
      const exec = fakeExec({ branch: 'main', runs: [{ ...RUN, status: 'completed', conclusion }] });
      const r = ci.probeMainCi('/p/h', { exec, now: 0 });
      assert.equal(r.state, 'unknown', `conclusion ${conclusion}`);
    }
  });

  it('caches per project for the TTL and re-asks after it', () => {
    const exec = fakeExec({ branch: 'main', runs: [{ ...RUN, status: 'completed', conclusion: 'failure' }] });
    ci.probeMainCi('/p/i', { exec, now: 0, ttlMs: 1000 });
    ci.probeMainCi('/p/i', { exec, now: 500, ttlMs: 1000 });
    assert.equal(exec.calls.filter((c) => c[0] === 'gh').length, 1, 'a second launch inside the TTL asks GitHub once');
    ci.probeMainCi('/p/i', { exec, now: 1500, ttlMs: 1000 });
    assert.equal(exec.calls.filter((c) => c[0] === 'gh').length, 2, 'and re-asks after it');
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

  it('renders unknown AS unknown, and says it is not green', () => {
    const lines = ci.primeLines({ state: 'unknown', branch: 'main', reason: 'gh is not installed' }).join('\n');
    assert.match(lines, /\*\*unknown\*\* — gh is not installed/);
    assert.match(lines, /Not green/);
    assert.doesNotMatch(lines, /FAILING/);
  });

  it('renders an in-progress run as no verdict yet', () => {
    const lines = ci.primeLines({ state: 'in-progress', branch: 'main', runUrl: RUN.url }).join('\n');
    assert.match(lines, /in progress/);
    assert.match(lines, /verdict is not in yet/);
  });

  it('renders nothing for passing and for none — a green line on every launch is noise', () => {
    assert.deepEqual(ci.primeLines({ state: 'passing', branch: 'main' }), []);
    assert.deepEqual(ci.primeLines({ state: 'none', branch: null, reason: 'no origin default branch' }), []);
    assert.deepEqual(ci.primeLines(null), []);
  });
});
