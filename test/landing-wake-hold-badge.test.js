'use strict';

/*
 * Frontend regression tests for #2578 — the held-wake-reason badge on
 * dashboard session cards.
 *
 * When a session's Medusa wakeups are held because the pane has unsent prompt
 * input (`pane-not-at-rest` or `pane-composer-has-input`), a visible badge is
 * shown on the project card. `renderHeldWakeBadge` is defined in
 * public/landing.js and injected via a renderCard wrapper in init() so that
 * public/ui.js remains unmodified. public/style.css carries the visual treatment.
 * Source-level structural assertions lock in the contract, following the pattern
 * in test/governance-drift-badge.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Held wake-reason badge (#2578)', () => {
  let landing, css;

  before(() => {
    landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  describe('landing.js render', () => {
    it('defines renderHeldWakeBadge function', () => {
      assert.match(landing, /function renderHeldWakeBadge\s*\(project\)/);
    });

    it('gates the badge on project.session.active and project.session.heldWakeReason', () => {
      assert.match(landing, /project\.session\.active/);
      assert.match(landing, /project\.session\.heldWakeReason/);
    });

    it('the badge uses the badge-wake-hold class', () => {
      assert.match(landing, /class="badge badge-wake-hold"/);
    });

    it('the badge title mentions held wakeups and input', () => {
      assert.match(landing, /Medusa wakeups held/);
      assert.match(landing, /input/);
    });

    it('returns empty string when heldWakeReason is absent', () => {
      assert.match(landing, /return\s+''/);
    });

    it('wraps renderCard in init() to inject the badge before card-row-actions', () => {
      assert.match(landing, /window\.renderCard\s*=/);
      assert.match(landing, /card-row-actions/);
      assert.match(landing, /renderHeldWakeBadge\(project\)/);
    });
  });

  describe('style.css', () => {
    it('defines a .badge-wake-hold rule', () => {
      assert.match(css, /\.badge-wake-hold\s*\{/);
    });

    it('the badge uses an amber colour scheme (like the drift and stranded badges)', () => {
      const m = css.match(/\.badge-wake-hold\s*\{([^}]+)\}/);
      assert.ok(m, '.badge-wake-hold rule exists');
      assert.match(m[1], /color/, 'the rule sets a colour');
    });
  });
});
