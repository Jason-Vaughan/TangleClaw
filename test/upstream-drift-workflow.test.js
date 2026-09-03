'use strict';

/*
 * Source pins for `.github/workflows/upstream-drift.yml` (#835).
 *
 * The workflow is config GitHub executes, not code the suite can run. These
 * pin what makes it a real check rather than a green ritual: it runs on a
 * schedule, it puts the marketplace checkout at the path the test reads, and
 * it runs the test with absence turned into failure. Each one, missing,
 * produces a workflow that passes and verifies nothing — the #835 shape.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'upstream-drift.yml');
const TEST_FILE = path.join(__dirname, 'c1-plugin-migration.test.js');

describe('Upstream drift workflow (.github/workflows/upstream-drift.yml)', () => {
  /**
   * Read the workflow file once per assertion.
   * @returns {string}
   */
  function workflowSource() {
    return fs.readFileSync(WORKFLOW, 'utf8');
  }

  it('exists', () => {
    assert.ok(fs.existsSync(WORKFLOW), 'workflow file missing');
  });

  it('runs on a schedule and can be dispatched by hand', () => {
    const src = workflowSource();
    assert.match(src, /^\s*schedule:\n\s*(?:#.*\n\s*)*- cron: '[^']+'/m, 'a cron schedule is the whole point');
    assert.match(src, /^\s*workflow_dispatch:/m, 'manual dispatch is how a fresh clone verifies it');
  });

  it('clones the prawduct marketplace to the exact path the test reads', () => {
    const src = workflowSource();
    const clone = src.match(/git clone --depth 1 https:\/\/github\.com\/brookstalley\/prawduct\.git "\$HOME\/([^"]+)"/);
    assert.ok(clone, 'must shallow-clone brookstalley/prawduct under $HOME');
    // The test composes os.homedir() + these segments. Pin the workflow's
    // path to the test's path literally, so relocating one without the other
    // fails here rather than as a scheduled run that skips forever.
    const testSrc = fs.readFileSync(TEST_FILE, 'utf8');
    const segments = clone[1].split('/');
    const literal = segments.map((s) => `'${s}'`).join(', ');
    assert.ok(testSrc.includes(`os.homedir(), ${literal}`),
      `the test does not read os.homedir()/${clone[1]} — workflow and test disagree on where the checkout lives`);
  });

  it('runs the comparison with absence turned into failure', () => {
    const src = workflowSource();
    assert.match(src, /TANGLECLAW_REQUIRE_UPSTREAM: '1'/,
      'without the flag the "not installed" branch skips, and a scheduled run that skips is the bug');
    assert.match(src, /run: node --test test\/c1-plugin-migration\.test\.js/);
    // The env must be set on the step that runs the test, not merely present
    // somewhere in the file: env on the clone step protects nothing.
    const stepIdx = src.indexOf('run: node --test test/c1-plugin-migration.test.js');
    const envIdx = src.lastIndexOf('TANGLECLAW_REQUIRE_UPSTREAM', stepIdx);
    const prevStep = src.lastIndexOf('- name:', stepIdx);
    assert.ok(envIdx > prevStep, 'TANGLECLAW_REQUIRE_UPSTREAM must be declared on the step that runs the test');
  });

  it('pins Node 22 (node:sqlite floor / production runtime)', () => {
    assert.match(workflowSource(), /node-version: 22/);
  });
});
