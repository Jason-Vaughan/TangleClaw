'use strict';

/*
 * Frontend regression tests for C2 / #353 — the per-project governance badge.
 * public/ui.js renders the compact project card; public/style.css carries the
 * visual treatment. Source-level structural assertions lock in the contract,
 * matching the pattern in test/orphan-hooks-banner.test.js.
 *
 * Since #538 the badge marks a legacy-governance MIGRATION CANDIDATE, not a
 * fault: with no methodology label left to contradict, a project that simply
 * isn't governed is ordinary, and badging it would flag most of the fleet.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Project card governance badge (C2, #353)', () => {
  let js, css;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  describe('ui.js render', () => {
    it('computes the badge gated on the governed-vendored state only', () => {
      assert.match(js, /const driftBadge\s*=\s*project\.governanceState === 'governed-vendored'/);
    });

    it('the badge uses the badge-drift class and a descriptive title', () => {
      assert.match(js, /class="badge badge-drift"[^`]*title=/);
      assert.match(js, /legacy governance/i);
    });

    it('renders nothing for every other state (empty-string fallthrough)', () => {
      // The ternary must fall through to '' so governed-plugin, ungoverned, and
      // not-applicable cards show no badge.
      assert.match(js, /governanceState === 'governed-vendored'[\s\S]*?:\s*''/);
    });

    it('never badges the ungoverned state (#538)', () => {
      // The neutral state must not regain an alarming treatment: most projects
      // are simply not Prawduct-governed, and badging them all is noise.
      assert.doesNotMatch(js, /governanceState === 'ungoverned'/);
      assert.doesNotMatch(js, /drift-no-governance/);
    });

    it('the driftBadge is placed in the card-row template', () => {
      assert.match(js, /\$\{driftBadge\}/);
    });
  });

  describe('style.css', () => {
    it('defines a .badge-drift rule', () => {
      assert.match(css, /\.badge-drift\s*\{/);
    });
  });
});
