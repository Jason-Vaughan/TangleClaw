'use strict';

/*
 * Source pins for `.github/workflows/test.yml` (backlog CI-9F3T).
 *
 * The workflow is config GitHub executes, not code the suite can run, so
 * these tests pin its load-bearing choices as text: the canonical test
 * command (the one README documents — drift here means CI runs something
 * other than what contributors run), the PR + push-to-main triggers (PR
 * gating and the README badge's source of truth respectively), and the
 * Node 22 floor that `node:sqlite` requires.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
const README = path.join(__dirname, '..', 'README.md');

describe('CI workflow (.github/workflows/test.yml)', () => {
  /**
   * Read the workflow file once per assertion set.
   * @returns {string}
   */
  function workflowSource() {
    return fs.readFileSync(WORKFLOW, 'utf8');
  }

  it('exists', () => {
    assert.ok(fs.existsSync(WORKFLOW), 'workflow file missing');
  });

  it('runs the canonical test command README documents', () => {
    const src = workflowSource();
    // Reporter flags may sit between `--test` and the glob: they change how
    // the run is REPORTED, not what runs (they must precede the glob — node
    // treats anything after it as a test argument). The glob and the command
    // stay pinned verbatim; any other flag still fails this.
    assert.match(src, /node --test(?: --test-reporter(?:-destination)?=\S+)* 'test\/\*\.test\.js'/);
    const readme = fs.readFileSync(README, 'utf8');
    assert.ok(
      readme.includes("node --test 'test/*.test.js'"),
      'README no longer documents the command CI pins — update both together'
    );
  });

  it('triggers on pull_request and on push to every long-lived branch', () => {
    // The branch list is pinned by NAME, not loosened to "any list", because the
    // whole point is that a long-lived branch nobody validates accumulates silent
    // failures. `feat/710-chunk2` reached 17 CI failures without a single run,
    // because CI had never been triggered on it — the PR that opened it was the
    // first. v5-baseline is the integration branch chunk PRs target, so a push to
    // it must be validated like a push to main. Adding a branch here is a
    // deliberate act; this assertion is what makes it one.
    const src = workflowSource();
    assert.match(src, /^\s*pull_request:/m);
    // Anchored to `push:` and tolerant of comment lines between the two, so this
    // binds THREE facts the way the original did: push: exists, it carries a
    // branch filter, and the filter is exactly this list. Matching `branches:`
    // anywhere would pass green if `push:` were deleted and the filter left
    // dangling under `pull_request:` — CI would stop running on pushes entirely
    // while the test still said it triggered on them.
    const branches = src.match(/^\s*push:\n(?:\s*#.*\n)*\s*branches: \[(.+)\]/m);
    assert.ok(branches, 'push: must exist and carry an explicit branch list directly under it');
    const listed = branches[1].split(',').map((b) => b.trim());
    assert.deepEqual(listed, ['main', 'v5-baseline'],
      'CI must run on pushes to main and to the v5 integration branch');
  });

  it('audits what the run did not execute, from the junit report the suite writes (#844)', () => {
    // The two halves must agree on the file name, or the audit reads nothing
    // and fails every run — or, worse, a stale report from a previous step.
    const src = workflowSource();
    const dest = src.match(/--test-reporter=junit --test-reporter-destination=(\S+)/);
    assert.ok(dest, 'the suite must write a junit report for the audit to read');
    assert.match(src, new RegExp(`node scripts/test-skip-audit\\.js ${dest[1].replace(/\./g, '\\.')}`),
      'the audit step must read the report the suite step wrote');
    // The audit must run in the same job, AFTER the suite — a separate job would
    // need the artifact shipped across, and before it there is nothing to read.
    assert.ok(src.indexOf('scripts/test-skip-audit.js') > src.indexOf("'test/*.test.js'"));
  });

  it('scans for conflict markers, and does it first (#882)', () => {
    // Markers reached main in a tracked governance file and sat there across
    // three sessions. The scan is the cheapest question CI can ask, so it runs
    // before the suite: a tree that is syntactically corrupt makes every later
    // answer suspect, and a fast red is a clearer signal than a slow one.
    const src = workflowSource();
    assert.match(src, /node scripts\/conflict-marker-scan\.js/,
      'the conflict-marker scan must run in CI, or the detection gap is still open');
    assert.ok(src.indexOf('scripts/conflict-marker-scan.js') < src.indexOf("'test/*.test.js'"),
      'the scan runs before the suite');
  });

  it('guards the service-worker cache generation, with the history that needs (#625)', () => {
    // A guard nothing calls is a file. This one asks whether a cache-first
    // public/* asset changed relative to the merge base, so it needs BOTH sides
    // in the clone — the default depth-1 checkout leaves `merge-base` unable to
    // answer, and the script exits 1 rather than reporting a pass it cannot
    // support. The base is passed through the environment, never interpolated
    // into the shell line.
    const src = workflowSource();
    assert.match(src, /node scripts\/cache-bump-guard\.js --base "\$BASE_SHA"/,
      'the guard must run with a comparison base taken from the environment');
    assert.match(src, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
      'the base comes from the pull request GitHub resolved');
    assert.match(src, /fetch-depth: 0/,
      'merge-base cannot answer in a depth-1 clone');
  });

  it('pins Node 22 (node:sqlite floor / production runtime)', () => {
    assert.match(workflowSource(), /node-version: 22/);
  });

  it('README badge points at this workflow', () => {
    const readme = fs.readFileSync(README, 'utf8');
    assert.ok(
      readme.includes('actions/workflows/test.yml/badge.svg'),
      'README badge for the Tests workflow missing'
    );
  });
});
