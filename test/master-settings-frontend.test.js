'use strict';

/*
 * Frontend structural tests for the Master settings surface — the brain-icon
 * panel's gear button and modal: access-level control (read-only enforced,
 * higher tiers disabled), engine/scope/availability settings, and the
 * editable Hard-rules block with version history + restore (the first UI
 * consumer of the D1b versions API).
 *
 * The surface renders via markup + DOM wiring with many top-level deps, so
 * source-level structural assertions are the pragmatic contract lock-in — same
 * pattern as test/master-pane-frontend.test.js.
 *
 * The settings modal itself moved out of ui.js/index.html into the shared
 * `tcCreateMasterSettings` component in api-helper.js, so it can mount on the
 * session page as well as the dashboard. These pins follow it there: the
 * assertions are unchanged, only the source they read moved. index.html keeps
 * the gear (the dashboard's own affordance); the modal's markup is emitted by
 * `tcMasterSettingsMarkup` so the two pages cannot carry drifting copies.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Master settings surface — frontend', () => {
  let html;
  let js;
  let helper;
  let css;
  /** The api-helper.js Master settings component (the modal's whole body). */
  let masterSection;
  /** The modal shell markup the component emits for both pages. */
  let modalMarkup;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    helper = fs.readFileSync(path.join(pub, 'api-helper.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

    const start = helper.indexOf('function tcCreateMasterSettings');
    const end = helper.indexOf('// Only the classifiers the render sites actually call are exported.');
    assert.ok(start > -1 && end > start,
      'api-helper.js has the Master settings component before its export block');
    masterSection = helper.slice(start, end);

    const mStart = helper.indexOf('function tcMasterSettingsMarkup');
    assert.notEqual(mStart, -1, 'api-helper.js emits the modal shell markup');
    modalMarkup = helper.slice(mStart, helper.indexOf('\n  }', mStart));
  });

  describe('markup', () => {
    it('the master panel status row carries the settings gear', () => {
      assert.match(html, /id="masterSettingsBtn"[^>]*aria-label="Master settings"/s);
    });

    it('the settings modal ships with body container, Save and Close', () => {
      assert.match(modalMarkup, /id="masterSettingsModal"/);
      assert.match(modalMarkup, /id="masterSettingsBody"/);
      assert.match(modalMarkup, /id="masterSettingsCloseBtn"/);
      assert.match(modalMarkup, /id="masterSettingsSaveBtn"/);
    });

    it('neither page carries its own copy of the modal — one emitter, two mounts', () => {
      // The whole point of the move. A second static copy in either page would
      // be the drift this component exists to prevent, and `mount()` would
      // adopt it and render into markup the other page never sees.
      const sessionHtml = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
      assert.doesNotMatch(html, /id="masterSettingsModal"/,
        'index.html must not re-declare the modal the component emits');
      assert.doesNotMatch(sessionHtml, /id="masterSettingsModal"/,
        'session.html must not re-declare the modal the component emits');
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
    it('the gear opens the modal, and the component binds the rest on mount', () => {
      // The gear stays the dashboard's, because that is where the dashboard's
      // affordance lives. Close/Save and the delegated Hard-rules handlers moved
      // into the component so the session page gets them without re-wiring.
      assert.match(js, /\$\('masterSettingsBtn'\)\.addEventListener\('click', openMasterSettings\)/);
      assert.match(js, /masterSettings\.mount\(\)/);
      assert.match(masterSection, /closeBtn\.addEventListener\('click', closeMasterSettings\)/);
      assert.match(masterSection, /saveBtn\.addEventListener\('click', saveMasterSettings\)/);
      assert.match(masterSection, /body\.addEventListener\('click', handleMasterSettingsEvent\)/);
      assert.match(masterSection, /body\.addEventListener\('change', handleMasterSettingsEvent\)/);
    });

    it('both pages construct the component, so neither forked the modal', () => {
      const sessionJs = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
      assert.match(js, /tcCreateMasterSettings\(\{/,
        'the dashboard mounts the shared component');
      assert.match(sessionJs, /tcCreateMasterSettings\(\{/,
        'the session page mounts the same shared component');
      assert.match(sessionJs, /masterSettings\.mount\(\)/);
    });

    it('mounting twice does not stack a second modal or double-bind', () => {
      // `mount()` runs on load and the control bar will call it again; an
      // append-always mount would give the page two #masterSettingsModal nodes
      // and getElementById would render into the one the operator cannot see.
      assert.match(masterSection, /if \(!modal\) \{/,
        'mount must inject only when the modal is absent');
      assert.match(masterSection, /dataset\.tcMasterSettingsBound === '1'/,
        'mount must not re-bind listeners it already bound');
    });

    it('access options meet the 44px mobile touch-target bar', () => {
      const block = css.match(/\.master-access-option \{[^}]*\}/s);
      assert.ok(block, 'master-access-option styles exist');
      assert.match(block[0], /min-height: 44px/);
    });
  });
});
