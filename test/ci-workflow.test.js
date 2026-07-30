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
    assert.match(src, /node --test 'test\/\*\.test\.js'/);
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
    const branches = src.match(/^\s*branches: \[(.+)\]/m);
    assert.ok(branches, 'push: must pin an explicit branch list');
    const listed = branches[1].split(',').map((b) => b.trim());
    assert.deepEqual(listed, ['main', 'v5-baseline'],
      'CI must run on pushes to main and to the v5 integration branch');
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
