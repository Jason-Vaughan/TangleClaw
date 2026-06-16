'use strict';

/*
 * Frontend regression tests for the session-rules management panel (#347/D1a).
 * public/index.html carries the panel markup + dash-bar toggle; public/landing.js
 * has the load/create/toggle/delete wiring; public/ui.js wires the toggle and
 * list event delegation; public/style.css carries the visual treatment. These
 * are source-level structural assertions, matching test/governance-drift-badge.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Session rules panel (#347/D1a)', () => {
  let html, landing, ui, css;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    landing = fs.readFileSync(path.join(pub, 'landing.js'), 'utf8');
    ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  });

  describe('index.html markup', () => {
    it('has a dash-bar toggle button targeting the panel', () => {
      assert.match(html, /id="sessionRulesToggle"[^>]*aria-controls="sessionRulesPanel"/);
    });

    it('has a session-rules count badge', () => {
      assert.match(html, /id="sessionRulesCount"/);
    });

    it('has the panel with a list container, input, and add button', () => {
      assert.match(html, /id="sessionRulesPanel"/);
      assert.match(html, /id="sessionRulesList"/);
      assert.match(html, /id="sessionRuleInput"/);
      assert.match(html, /id="sessionRuleAddBtn"/);
    });
  });

  describe('landing.js wiring', () => {
    it('loads global session rules via the scoped API', () => {
      assert.match(landing, /async function loadSessionRules\(\)/);
      assert.match(landing, /\/api\/session-rules\?scope=global/);
    });

    it('renders rules with toggle + delete actions', () => {
      assert.match(landing, /function renderSessionRules\(\)/);
      assert.match(landing, /data-action="toggle"/);
      assert.match(landing, /data-action="delete"/);
    });

    it('escapes rule content to prevent XSS', () => {
      assert.match(landing, /esc\(rule\.content\)/);
    });

    it('creates via POST, toggles via PUT, deletes via DELETE', () => {
      assert.match(landing, /apiMutate\('\/api\/session-rules', 'POST'/);
      assert.match(landing, /apiMutate\(`\/api\/session-rules\/\$\{id\}`, 'PUT'/);
      assert.match(landing, /apiMutate\(`\/api\/session-rules\/\$\{id\}`, 'DELETE'/);
    });

    it('loads session rules during init', () => {
      assert.match(landing, /loadSessionRules\(\)/);
    });
  });

  describe('ui.js wiring', () => {
    it('defines a panel toggle', () => {
      assert.match(ui, /function toggleSessionRules\(\)/);
    });

    it('delegates list click/change events to handler', () => {
      assert.match(ui, /function handleSessionRulesListEvent\(/);
      assert.match(ui, /\$\('sessionRulesList'\)\.addEventListener\('click', handleSessionRulesListEvent\)/);
      assert.match(ui, /\$\('sessionRulesList'\)\.addEventListener\('change', handleSessionRulesListEvent\)/);
    });

    it('wires the toggle and add button', () => {
      assert.match(ui, /\$\('sessionRulesToggle'\)\.addEventListener\('click', toggleSessionRules\)/);
      assert.match(ui, /\$\('sessionRuleAddBtn'\)\.addEventListener\('click', createSessionRule\)/);
    });
  });

  describe('style.css', () => {
    it('defines a .session-rules-panel rule with an open state', () => {
      assert.match(css, /\.session-rules-panel\s*\{/);
      assert.match(css, /\.session-rules-panel\.open\s*\{/);
    });

    it('styles disabled rules distinctly', () => {
      assert.match(css, /\.session-rule-disabled/);
    });
  });
});
