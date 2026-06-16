'use strict';

/*
 * Frontend regression tests for C2 / #353 — the per-project governance-drift
 * badge. public/ui.js renders the compact project card; public/style.css
 * carries the visual treatment. Source-level structural assertions lock in the
 * contract, matching the pattern in test/orphan-hooks-banner.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Project card governance-drift badge (C2, #353)', () => {
  let js, css;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  describe('ui.js render', () => {
    it('computes a driftBadge gated on the drift-no-governance state only', () => {
      assert.match(js, /const driftBadge\s*=\s*project\.governanceState === 'drift-no-governance'/);
    });

    it('the badge uses the badge-drift class and a descriptive title', () => {
      assert.match(js, /class="badge badge-drift"[^`]*title=/);
      assert.match(js, /governance drift/i);
    });

    it('renders nothing for non-drift states (empty-string fallthrough)', () => {
      // The ternary must fall through to '' so governed / not-applicable cards
      // show no badge — avoids badge noise on the common case.
      assert.match(js, /governanceState === 'drift-no-governance'[\s\S]*?:\s*''/);
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
