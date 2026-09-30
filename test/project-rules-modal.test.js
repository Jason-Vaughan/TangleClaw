'use strict';

/*
 * Frontend regression tests for the Project Rules modal section (CC-6, #381).
 * public/ui.js carries the per-project rule boxes (startup/wrap) + the 8
 * wrap-section checkboxes, backed by the session_rules store. Source-level
 * structural assertions, matching test/session-rules-panel.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const continuity = require('../lib/continuity');
const helperGlobals = require('./_api-helper-globals')();

describe('Project Rules modal (CC-6, #381)', () => {
  let ui, css;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  });

  describe('section-vocabulary drift guard (Critic NOTE 2)', () => {
    it('ui.js WRAP_SECTION_NAMES matches lib/continuity.js WRAP_SECTIONS exactly', () => {
      // The browser has no bundler, so the 8-section vocabulary is duplicated
      // between the wrap engine (continuity.js) and the modal (ui.js). This test
      // is the drift guard: parse the client array from source and compare it to
      // the canonical server list, order included.
      const m = ui.match(/const WRAP_SECTION_NAMES\s*=\s*\[([\s\S]*?)\];/);
      assert.ok(m, 'WRAP_SECTION_NAMES array literal should be present in ui.js');
      const clientNames = m[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      assert.deepEqual(clientNames, continuity.WRAP_SECTIONS);
    });
  });

  describe('ui.js — rendering', () => {
    it('renders the Project Rules section in the Settings modal', () => {
      assert.match(ui, /function renderProjectRulesSection\(project\)/);
      assert.match(ui, /\$\{renderProjectRulesSection\(project\)\}/);
    });

    it('defines the two rule kinds (startup/wrap) — mode retired to launch settings', () => {
      assert.match(ui, /PROJECT_RULE_KINDS\s*=/);
      assert.match(ui, /kind: 'startup'/);
      assert.match(ui, /kind: 'wrap'/);
      // The mode-rules box was replaced by the structured launch-mode settings.
      assert.doesNotMatch(ui, /kind: 'mode'/);
      assert.match(ui, /renderLaunchModeSettings/);
      assert.match(ui, /settingsDefaultLaunchMode/);
      assert.match(ui, /settingsShowLaunchPicker/);
    });

    it('renders the 8 wrap-section checkboxes with Next action required + disabled', () => {
      assert.match(ui, /WRAP_SECTION_NAMES\s*=/);
      assert.match(ui, /'Next action'/);
      // Next action is force-checked and disabled (the keystone)
      assert.match(ui, /isNextAction \? ' <em>\(required\)<\/em>' : ''/);
      assert.match(ui, /\$\{isNextAction \? 'disabled' : ''\}/);
    });

    it('escapes rule content to prevent XSS', () => {
      // #2029: the content is shown minus a same-id authored prefix, and still escaped.
      assert.match(ui, /esc\(tcStripSameIdPrefix\(rule\.id, rule\.content\)\.trim\(\)\)/);
      assert.doesNotMatch(ui, /\$\{rule\.content\}/);
    });
  });

  describe('ui.js — wiring', () => {
    it('loads per-project rules scoped by projectId + kind', () => {
      assert.match(ui, /async function loadProjectRules\(projectId, projectName\)/);
      assert.match(ui, /\/api\/session-rules\?projectId=\$\{encodeURIComponent\(projectId\)\}&kind=\$\{kind\}/);
      assert.match(ui, /loadProjectRules\(project\.id, project\.name\)/);
    });

    it('creates rules via POST with kind, toggles via PUT, deletes via DELETE', () => {
      assert.match(ui, /apiMutate\('\/api\/session-rules', 'POST', \{\s*content, projectId: projectRulesTargetId, kind\s*\}\)/);
      assert.match(ui, /apiMutate\(`\/api\/session-rules\/\$\{id\}`, 'PUT', \{ enabled \}\)/);
      assert.match(ui, /apiMutate\(`\/api\/session-rules\/\$\{id\}`, 'DELETE', \{\}\)/);
    });

    it('delegates add/toggle/delete events on the stable settingsBody', () => {
      assert.match(ui, /function handleProjectRulesEvent\(/);
      assert.match(ui, /\$\('settingsBody'\)\.addEventListener\('click', handleProjectRulesEvent\)/);
      assert.match(ui, /\$\('settingsBody'\)\.addEventListener\('change', handleProjectRulesEvent\)/);
    });

    it('collects the wrap-section selection (null when all 8 checked) into the PATCH body', () => {
      assert.match(ui, /function collectWrapSectionsSelection\(\)/);
      assert.match(ui, /checked\.length === WRAP_SECTION_NAMES\.length \? null : checked/);
      assert.match(ui, /body\.wrapSections = wrapSel/);
    });
  });

  describe('style.css', () => {
    it('defines the project-rules section styling', () => {
      assert.match(css, /\.project-rules-section\s*\{/);
      assert.match(css, /\.project-rules-block\s*\{/);
    });
  });

  describe('#569 — proposal visibility in the rules list', () => {
    it('fetches unfiltered and drops only rejections client-side', () => {
      // Proposals must reach the list (they get a badge); rejections must not
      // (a rejected row is a decision record, not a rule).
      assert.match(ui, /async function fetchProjectRules\(projectId, kind\)/);
      assert.match(ui, /\.filter\(\(r\) => r\.status !== 'rejected'\)/);
      // The project-rules fetch must not re-narrow to active-only, which would
      // silently hide the proposal queue again. (The Master rules fetches stay
      // active-only on purpose — the wrap never proposes master rules.)
      const helperStart = ui.indexOf('async function fetchProjectRules');
      const helperEnd = ui.indexOf('async function loadProjectRules');
      assert.ok(helperStart !== -1 && helperEnd > helperStart);
      assert.doesNotMatch(ui.slice(helperStart, helperEnd), /status=/);
      // And no per-kind re-fetch elsewhere in the modal bypasses the helper.
      assert.doesNotMatch(ui, /projectId=\$\{encodeURIComponent\(projectRulesTargetId\)\}&kind=\$\{kind\}&status=/);
    });

    it('renders a Proposed badge on proposed rules, alongside the AI badge', () => {
      assert.match(ui, /session-rule-badge--proposed/);
      assert.match(ui, /rule\.status === 'proposed'/);
      // The AI-authorship badge must survive — status and authorship are
      // different facts and both render.
      assert.match(ui, /AI-authored/);
    });

    it('a proposed rule’s enabled-toggle is inert — it governs nothing yet', () => {
      assert.match(ui, /rule\.enabled && !isProposed \? 'checked' : ''/);
      assert.match(ui, /\$\{isProposed \? 'disabled' : ''\}/);
    });

    it('a proposed row offers Approve/Reject INSTEAD of Delete — deleting would erase the decision record', () => {
      // The rule-proposal step's re-proposal guard is the rule row itself
      // (sourceLearningId): delete the row and the same learning comes back
      // next wrap. So Delete must not be the modal's dismissal gesture.
      assert.match(ui, /const actions = isProposed\s*\?/);
      assert.match(ui, /data-action="approve-rule"/);
      assert.match(ui, /data-action="reject-rule"/);
      // Delete renders only on the non-proposed arm of the ternary.
      const renderFn = ui.slice(ui.indexOf('function renderProjectRulesList'), ui.indexOf('async function addProjectRule'));
      const ternary = renderFn.slice(renderFn.indexOf('const actions = isProposed'));
      const approveArm = ternary.slice(0, ternary.indexOf(':'));
      assert.ok(!/delete-rule/.test(approveArm), 'the proposed arm must not render a delete button');
    });

    it('approve/reject wire to the status route, with 403 revealing the password field', () => {
      assert.match(ui, /async function resolveProjectRuleProposal\(id, status, kind\)/);
      assert.match(ui, /apiMutate\(`\/api\/session-rules\/\$\{id\}\/status`, 'PUT', body\)/);
      assert.match(ui, /lastErrorCode === 'FORBIDDEN'/);
      assert.match(ui, /projRulesPwGroup/);
      // The password group starts hidden — it only appears when the server refuses.
      assert.match(ui, /id="projRulesPwGroup" class="form-group hidden"/);
      // Both decisions are delegated through the section's event handler.
      assert.match(ui, /action === 'approve-rule'/);
      assert.match(ui, /action === 'reject-rule'/);
    });

    it('style.css styles the proposed badge and row accent', () => {
      assert.match(css, /\.session-rule-badge--proposed\s*\{/);
      assert.match(css, /\.session-rule-item--proposed\s*\{/);
    });
  });

  // #1053: Approve names the text the row showed. These run the real
  // renderProjectRulesList and resolveProjectRuleProposal against fakes,
  // because the property is which text reaches the server and what the list
  // does after a refusal, not what the source looks like.
  describe('approval sends the text the row showed (#1053)', () => {
    /**
     * Slice a top-level function out of ui.js by brace-matching.
     * @param {string} decl - The declaration to find
     * @returns {string} The body, braces included
     */
    function functionBody(decl) {
      const start = ui.indexOf(decl);
      assert.ok(start !== -1, `${decl} must exist`);
      const open = ui.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < ui.length; i++) {
        if (ui[i] === '{') depth++;
        else if (ui[i] === '}' && --depth === 0) return ui.slice(open, i + 1);
      }
      return assert.fail(`${decl} must close`);
    }

    /**
     * Build the two functions sharing one shown-content map, with every free
     * variable they read supplied.
     * @param {Function} respond - (url, method, body, api) => data|null
     * @returns {object} The harness
     */
    function harness(respond) {
      const calls = [];
      const statuses = [];
      const refreshes = [];
      const shown = new Map();
      const api = { lastError: null, lastErrorCode: null, lastBody: null };
      const listEl = { innerHTML: '' };
      const document = { getElementById: (id) => (id.startsWith('projRulesList-') ? listEl : null) };
      const apiMutate = async (url, method, body) => {
        calls.push({ url, method, body });
        return respond(url, method, body, api);
      };
      const deps = {
        document, apiMutate, api, projectRuleShownContent: shown, esc: (x) => String(x),
        _setProjectRulesStatus: (msg, ok) => statuses.push({ msg, ok }),
        refreshProjectRulesList: async (pid, kind) => { refreshes.push({ pid, kind }); return true; },
        refreshAfterProjectRuleMutation: async () => {},
        projectRulesTargetId: 3,
        // The real label helpers api-helper.js publishes before ui.js runs (#2029).
        tcRuleLabel: helperGlobals.tcRuleLabel,
        tcStripSameIdPrefix: helperGlobals.tcStripSameIdPrefix,
        tcRuleMismatchBadge: helperGlobals.tcRuleMismatchBadge
      };
      const names = Object.keys(deps);
      // eslint-disable-next-line no-new-func
      const build = (sig, decl) => new Function(...names,
        `return ${sig} ${functionBody(decl)};`)(...names.map((n) => deps[n]));
      return {
        render: build('function renderProjectRulesList(kind, rules)', 'function renderProjectRulesList('),
        resolve: build('async function resolveProjectRuleProposal(id, status, kind)',
          'async function resolveProjectRuleProposal('),
        calls, statuses, refreshes, shown
      };
    }

    const proposed = (id, content) => ({ id, content, status: 'proposed', enabled: true, createdBy: 'ai' });

    it('rendering remembers each proposed row’s stored text; Approve sends it', async () => {
      const h = harness(() => ({ id: 5, status: 'active' }));
      h.render('startup', [proposed(5, 'use <b>tabs</b> & spaces'), { ...proposed(6, 'live'), status: 'active' }]);
      assert.equal(h.shown.get(5), 'use <b>tabs</b> & spaces', 'the stored text, not the escaped HTML');
      assert.equal(h.shown.has(6), false, 'only proposals are approvable');
      await h.resolve(5, 'active', 'startup');
      assert.deepEqual(h.calls[0].body, { status: 'active', expectedContent: 'use <b>tabs</b> & spaces' });
    });

    it('a re-render replaces the remembered text with what the row now shows', async () => {
      const h = harness(() => ({ id: 5, status: 'active' }));
      h.render('startup', [proposed(5, 'first')]);
      h.render('startup', [proposed(5, 'second')]);
      await h.resolve(5, 'active', 'startup');
      assert.equal(h.calls[0].body.expectedContent, 'second');
    });

    it('a 409 redraws the list and says nothing was approved', async () => {
      const h = harness((url, method, body, api) => {
        api.lastErrorCode = 'RULE_CONTENT_CHANGED';
        api.lastBody = { currentContent: 'swapped' };
        return null;
      });
      h.render('wrap', [proposed(9, 'shown')]);
      await h.resolve(9, 'active', 'wrap');
      assert.deepEqual(h.refreshes, [{ pid: 3, kind: 'wrap' }], 'the list must be re-read so the row shows the current text');
      assert.equal(h.statuses.length, 1);
      assert.match(h.statuses[0].msg, /changed after it was shown/);
      assert.match(h.statuses[0].msg, /nothing was approved/);
      assert.equal(h.statuses[0].ok, false);
    });

    it('a rejection sends no expectedContent', async () => {
      const h = harness(() => ({ id: 5, status: 'rejected' }));
      h.render('startup', [proposed(5, 'text')]);
      await h.resolve(5, 'rejected', 'startup');
      assert.deepEqual(h.calls[0].body, { status: 'rejected' });
    });
  });
});
