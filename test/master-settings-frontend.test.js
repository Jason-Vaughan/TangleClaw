'use strict';

/*
 * Frontend structural tests for the Master settings surface — the brain-icon
 * panel's gear button and modal: access-level control (read-only enforced,
 * higher tiers disabled), engine/scope/availability settings, and the
 * editable Hard-rules block with version history + restore (the first UI
 * consumer of the D1b versions API).
 *
 * ui.js / index.html render via static markup + DOM wiring with many
 * top-level deps, so source-level structural assertions are the pragmatic
 * contract lock-in — same pattern as test/master-pane-frontend.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Master settings surface — frontend', () => {
  let html;
  let js;
  let css;
  /** The ui.js Project Master section (settings code lives inside it). */
  let masterSection;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

    const start = js.indexOf('── Project Master');
    const end = js.indexOf('── Event Bindings ──');
    assert.ok(start > -1 && end > start, 'ui.js has a Project Master section before Event Bindings');
    masterSection = js.slice(start, end);
  });

  describe('markup', () => {
    it('the master panel status row carries the settings gear', () => {
      assert.match(html, /id="masterSettingsBtn"[^>]*aria-label="Master settings"/s);
    });

    it('the settings modal ships with body container, Save and Close', () => {
      assert.match(html, /id="masterSettingsModal"/);
      assert.match(html, /id="masterSettingsBody"/);
      assert.match(html, /id="masterSettingsCloseBtn"/);
      assert.match(html, /id="masterSettingsSaveBtn"/);
    });
  });

  describe('settings form', () => {
    it('renders the access-level radios with disabled not-yet-enforced tiers', () => {
      assert.match(masterSection, /name="masterAccessLevel"/);
      assert.match(masterSection, /enabledAccessLevels\.includes\(level\)/);
      assert.match(masterSection, /master-access-disabled/);
    });

    it('surfaces the enforcement badge honestly (structural vs instructional)', () => {
      assert.match(masterSection, /master-enforcement-badge/);
      assert.match(masterSection, /instructional/);
    });

    it('persists via PATCH /api/config with the whole master object', () => {
      assert.match(masterSection, /apiMutate\('\/api\/config', 'PATCH', \{ master: masterPatch \}\)/);
    });

    it('scope select is labeled a focus setting, not a security boundary', () => {
      assert.match(masterSection, /not a security boundary/);
    });
  });

  describe('Hard rules editor', () => {
    it('loads master rules from the kind-scoped session-rules API', () => {
      assert.match(masterSection, /\/api\/session-rules\?kind=master/);
    });

    it('eyes-open confirm precedes disabling or deleting a shipped baseline rule, and the confirm flag reaches the API', () => {
      assert.match(masterSection, /createdBy === 'system'/);
      assert.match(masterSection, /confirmBaselineEdit = true/);
      assert.match(masterSection, /\?confirm=true/);
    });

    it('version restore of a baseline rule confirms and sends the flag (gate symmetric with edit/disable/delete)', () => {
      const restoreFn = masterSection.slice(
        masterSection.indexOf('async function restoreMasterRuleVersion'),
        masterSection.indexOf('function handleMasterSettingsEvent')
      );
      assert.match(restoreFn, /createdBy === 'system'/);
      assert.match(restoreFn, /confirmBaselineEdit = true/);
      assert.match(restoreFn, /if \(!confirm\(/);
    });

    it('exposes version history with per-version restore and Restore defaults', () => {
      assert.match(masterSection, /data-action="master-rule-history"/);
      assert.match(masterSection, /data-action="master-restore-version"/);
      assert.match(masterSection, /data-action="master-restore-defaults"/);
      assert.match(masterSection, /\/api\/session-rules\/\$\{id\}\/versions/);
      assert.match(masterSection, /\/api\/master\/rules\/restore-defaults/);
    });

    it('marks shipped baseline rules with a badge', () => {
      assert.match(masterSection, /Shipped baseline rule/);
    });
  });

  describe('wiring and style', () => {
    it('the gear, modal buttons, and delegated body handlers are bound', () => {
      assert.match(js, /\$\('masterSettingsBtn'\)\.addEventListener\('click', openMasterSettings\)/);
      assert.match(js, /\$\('masterSettingsCloseBtn'\)\.addEventListener\('click', closeMasterSettings\)/);
      assert.match(js, /\$\('masterSettingsSaveBtn'\)\.addEventListener\('click', saveMasterSettings\)/);
      assert.match(js, /\$\('masterSettingsBody'\)\.addEventListener\('click', handleMasterSettingsEvent\)/);
      assert.match(js, /\$\('masterSettingsBody'\)\.addEventListener\('change', handleMasterSettingsEvent\)/);
    });

    it('access options meet the 44px mobile touch-target bar', () => {
      const block = css.match(/\.master-access-option \{[^}]*\}/s);
      assert.ok(block, 'master-access-option styles exist');
      assert.match(block[0], /min-height: 44px/);
    });
  });
});
