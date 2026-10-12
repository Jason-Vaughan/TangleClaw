'use strict';

/*
 * The merge queue and the CI workflow must agree on one branch prefix (#2322).
 *
 * The queue tests a pull request by making a candidate branch and waiting for
 * the `test` check on its commit. Nothing opens a pull request for that
 * branch, so the check exists only if `.github/workflows/test.yml` runs on a
 * push to it. The workflow is text GitHub reads and the prefix is a constant
 * the queue writes under; if either moved alone, every candidate would wait
 * for a run that never starts. These tests read the prefix from the module
 * that writes the branches, so the two cannot drift.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CANDIDATE_PREFIX, STAGE_PREFIX, isCandidateRef, isStageRef, stageRefFor } = require('../lib/merge-queue-github');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');

/**
 * Read the workflow file.
 * @returns {string}
 */
function workflowSource() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

/**
 * The branch patterns under the workflow's `push:` trigger, quotes removed.
 * Anchored to `push:` with only comment lines between, so a list left under
 * another trigger is not read as this one.
 * @param {string} src - The workflow file's text
 * @returns {string[]|null} The patterns, or null when `push:` carries no list
 */
function pushBranches(src) {
  const m = src.match(/^ {2}push:\n(?:\s*#.*\n)*\s*branches: \[(.+)\]/m);
  if (!m) return null;
  return m[1].split(',').map((b) => b.trim().replace(/^(['"])(.*)\1$/, '$2'));
}

/**
 * Whether a GitHub branch filter pattern matches a branch name. Covers the
 * two forms this workflow uses: a literal name, and a prefix ending in `**`
 * (which matches any characters, `/` included).
 * @param {string} pattern - One entry of the `branches:` list
 * @param {string} branch - A branch name
 * @returns {boolean}
 */
function patternMatches(pattern, branch) {
  if (pattern.endsWith('**')) return branch.startsWith(pattern.slice(0, -2));
  return pattern === branch;
}

describe('the test workflow runs on a merge queue candidate (#2322)', () => {
  it('the prefix the queue writes under is the one this test reads', () => {
    assert.equal(typeof CANDIDATE_PREFIX, 'string');
    assert.match(CANDIDATE_PREFIX, /^[a-z][a-z0-9-]*\/$/,
      'the prefix is one path segment ending in a slash, so prefix + ** is a valid branch filter');
  });

  it('the push trigger lists the queue prefix, built from that constant', () => {
    const listed = pushBranches(workflowSource());
    assert.ok(listed, 'push: must carry an explicit branch list');
    assert.ok(listed.includes(`${CANDIDATE_PREFIX}**`),
      `the push trigger must list ${CANDIDATE_PREFIX}** or no queue candidate is ever tested`);
  });

  it('every name the queue accepts for a candidate starts a run, and a near miss does not', () => {
    const listed = pushBranches(workflowSource());
    const runsOn = (branch) => listed.some((p) => patternMatches(p, branch));
    for (const name of ['1', 'entry-42', 'probe-20261012-071816', 'A.b_c-9']) {
      const ref = `${CANDIDATE_PREFIX}${name}`;
      assert.equal(isCandidateRef(ref), true, `${ref} is a name the queue would write`);
      assert.equal(runsOn(ref), true, `${ref} must start the workflow`);
    }
    const bare = CANDIDATE_PREFIX.slice(0, -1);
    for (const other of [bare, `${bare}-other/1`, `x/${CANDIDATE_PREFIX}1`, 'feat/2322-03-queue-ci-trigger']) {
      assert.equal(runsOn(other), false, `${other} is not a candidate and must not be matched by the push list`);
    }
  });

  it('no branch a candidate is merged on starts a run', () => {
    // The merge is made on a stage branch so that the only push CI sees is the
    // candidate branch arriving at the finished merge. A stage branch starts at
    // the base, which is the base branch's own commit: a run for that push
    // would be a second `test` run on it.
    const listed = pushBranches(workflowSource());
    const runsOn = (branch) => listed.some((p) => patternMatches(p, branch));
    for (const name of ['1', 'entry-42', 'probe-20261012-092611', 'A.b_c-9']) {
      const stage = stageRefFor(`${CANDIDATE_PREFIX}${name}`);
      assert.equal(isStageRef(stage), true, `${stage} is a name the queue would merge on`);
      assert.equal(runsOn(stage), false, `${stage} must not start the workflow`);
    }
    assert.ok(!listed.some((p) => p.startsWith(STAGE_PREFIX.slice(0, -1))),
      `the push trigger must never list the stage prefix ${STAGE_PREFIX}`);
    assert.ok(!STAGE_PREFIX.startsWith(CANDIDATE_PREFIX), 'a stage name is never under the candidate prefix');
  });

  it('the long-lived branches are still on the list', () => {
    const listed = pushBranches(workflowSource());
    assert.ok(listed.includes('main'), 'a push to main must still run the suite');
    assert.ok(listed.includes('v5-baseline'), 'a push to v5-baseline must still run the suite');
  });

  it('pull requests and the release still reach the workflow', () => {
    const src = workflowSource();
    assert.match(src, /^ {2}pull_request:/m, 'pull requests must still be tested');
    assert.match(src, /^ {2}workflow_call:/m,
      'release.yml calls this workflow; without workflow_call no release can run');
  });

  it('the workflow token stays read-only', () => {
    // A candidate branch is made by the queue, not reviewed as a pull request,
    // so the run it starts must not hold more than it needs to read the tree.
    const block = workflowSource().match(/^permissions:\n((?: {2}.*\n)+)/m);
    assert.ok(block, 'the workflow must declare its permissions');
    assert.equal(block[1], '  contents: read\n', 'the permissions block is exactly contents: read');
  });
});
