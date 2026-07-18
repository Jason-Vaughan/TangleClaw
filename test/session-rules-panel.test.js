'use strict';

/*
 * Retirement pins for the global session-rules panel (#347/D1a → retired).
 * The Phase A settings cleanup deleted the hidden global session-rules tier:
 * cross-project directives belong in the Global rules document, and the
 * dash-bar panel that authored global rows (with its D1b version-history UI)
 * went with it. These source-level assertions keep the deletion honest — no
 * dangling markup, wiring, fetch paths, or orphaned CSS may resurface without
 * a deliberate decision (the Master settings surface owns any successor
 * history UI). The per-project rules UI lives on in the Settings modal and is
 * covered by test/project-rules-modal.test.js.
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

  describe('global-tier panel retirement pins', () => {
    it('index.html carries no panel markup or dash-bar toggle', () => {
      assert.doesNotMatch(html, /sessionRulesToggle/);
      assert.doesNotMatch(html, /sessionRulesPanel/);
      assert.doesNotMatch(html, /sessionRuleInput/);
      assert.doesNotMatch(html, /sessionRuleAddBtn/);
    });

    it('the dash bar labels the remaining rules tier "Global Rules"', () => {
      assert.match(html, /id="rulesToggle"[^>]*>\s*Global Rules/);
    });

    it('landing.js has no global-scope fetch or panel CRUD wiring', () => {
      assert.doesNotMatch(landing, /scope=global/);
      assert.doesNotMatch(landing, /loadSessionRules/);
      assert.doesNotMatch(landing, /createSessionRule/);
      assert.doesNotMatch(landing, /renderSessionRuleVersions/);
    });

    it('ui.js has no panel toggle or list event delegation', () => {
      assert.doesNotMatch(ui, /toggleSessionRules\b/);
      assert.doesNotMatch(ui, /handleSessionRulesListEvent/);
    });

    it('style.css keeps the shared rule-list classes but not the panel shell', () => {
      // The Project Rules section of the Settings modal reuses these.
      assert.match(css, /\.session-rules-list/);
      assert.match(css, /\.session-rule-item/);
      // The panel shell and its version-history UI went with the tier.
      assert.doesNotMatch(css, /\.session-rules-panel/);
      assert.doesNotMatch(css, /\.session-rule-versions/);
      assert.doesNotMatch(css, /\.session-rule-critic-gate/);
    });
  });
});
