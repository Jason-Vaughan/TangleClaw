'use strict';

/*
 * Frontend tests for the OpenClaw "Read Me" setup-guide modal
 * (#306-followup) — a button next to "+ Add Connection" that opens a modal
 * explaining the Add Connection flow + its fields, and holding a copy-paste
 * AI-agent setup prompt.
 *
 * ui.js/index.html render via static markup + innerHTML strings, so
 * source-level structural assertions are the contract lock-in — same pattern
 * as test/settings-modal-silentprime.test.js and test/openclaw-version-row.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('OpenClaw "Read Me" setup-guide modal (#306-followup)', () => {
  let ui, html, css;

  before(() => {
    const p = (f) => path.join(__dirname, '..', 'public', f);
    ui = fs.readFileSync(p('ui.js'), 'utf8');
    html = fs.readFileSync(p('index.html'), 'utf8');
    css = fs.readFileSync(p('style.css'), 'utf8');
  });

  describe('Read Me button', () => {
    it('renders next to + Add Connection in BOTH the empty and populated panel states', () => {
      const matches = ui.match(/onclick="openOpenclawSetupModal\(\)"/g) || [];
      assert.equal(matches.length, 2, 'a Read Me button should sit by each + Add Connection button');
      assert.match(ui, /Read Me<\/button>/);
    });
  });

  describe('modal open/close/copy handlers', () => {
    it('defines open + close that toggle the modal via the .open class', () => {
      assert.match(ui, /function openOpenclawSetupModal\(\)\s*\{[^}]*getElementById\('openclawSetupModal'\)\.classList\.add\('open'\)/);
      assert.match(ui, /function closeOpenclawSetupModal\(\)\s*\{[^}]*getElementById\('openclawSetupModal'\)\.classList\.remove\('open'\)/);
    });

    it('copy reads the prompt from the modal <pre> (single source of truth) and uses the clipboard API', () => {
      assert.match(ui, /function copyOpenclawSetupPrompt\(\)/);
      assert.match(ui, /getElementById\('ocSetupPrompt'\)/);
      assert.match(ui, /navigator\.clipboard\.writeText\(prompt\)/);
    });

    it('wires Close, Copy, and backdrop-dismiss listeners', () => {
      assert.match(ui, /\$\('ocSetupCloseBtn'\)\.addEventListener\('click', closeOpenclawSetupModal\)/);
      assert.match(ui, /\$\('ocSetupCopyBtn'\)\.addEventListener\('click', copyOpenclawSetupPrompt\)/);
      assert.match(ui, /\$\('openclawSetupModal'\)\.addEventListener\('click'.*closeOpenclawSetupModal/);
    });

    it('the modal is not timer-dismissed (no setTimeout in open/close — honors the no-UI-timers rule)', () => {
      const openFn = ui.slice(ui.indexOf('function openOpenclawSetupModal'), ui.indexOf('function copyOpenclawSetupPrompt'));
      assert.doesNotMatch(openFn, /setTimeout/, 'modal lifecycle must be explicit user action, never a timer');
    });
  });

  describe('modal markup (index.html)', () => {
    it('declares the modal-backdrop with the prompt <pre> and action buttons', () => {
      assert.match(html, /<div class="modal-backdrop" id="openclawSetupModal">/);
      assert.match(html, /<pre id="ocSetupPrompt"/);
      assert.match(html, /id="ocSetupCloseBtn"/);
      assert.match(html, /id="ocSetupCopyBtn"/);
    });

    it('explains the + Add Connection flow and the fields it asks for', () => {
      assert.match(html, /class="oc-setup-fields"/);
      for (const field of ['Host', 'SSH User', 'Gateway Port', 'Instance Dir', 'Available as engine']) {
        assert.ok(html.includes(field), `setup modal should mention the "${field}" field`);
      }
    });

    it('the AI-agent prompt covers the version-critical fields and the pinned-tag caveat', () => {
      const open = html.indexOf('<pre id="ocSetupPrompt"');
      const start = html.indexOf('>', open) + 1; // skip past the opening tag
      const end = html.indexOf('</pre>', start);
      const prompt = html.slice(start, end);
      assert.ok(prompt.includes('OPENCLAW_IMAGE'), 'prompt must reference OPENCLAW_IMAGE');
      assert.ok(prompt.includes('OPENCLAW_GATEWAY_PORT'), 'prompt must reference the gateway port var');
      assert.ok(prompt.includes('Instance Dir'), 'prompt must instruct reporting the Instance Dir');
      assert.ok(/pinned image tag|moving tag|:latest/i.test(prompt), 'prompt should warn about moving vs pinned tags');
      // The <pre> must not contain raw angle-bracket placeholders that the
      // browser would parse as markup and drop from the copied text.
      assert.doesNotMatch(prompt, /<[a-z]/i, 'prompt text must avoid literal HTML-looking angle brackets');
    });

    it('Instance Dir field label now signals it is recommended', () => {
      assert.match(html, /Instance Dir <span[^>]*>\(recommended/);
    });
  });

  describe('styling', () => {
    it('defines the .oc-setup-prompt block style', () => {
      assert.match(css, /\.oc-setup-prompt\s*\{[^}]*white-space:\s*pre-wrap/);
    });
  });
});
