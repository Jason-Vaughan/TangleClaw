'use strict';

/*
 * #2884 — mounting public/bridge-step-up.js and public/bridge-settings-ui.js
 * (shipped, lift-and-run tested, but previously mounted nowhere) into the
 * dashboard's Global Settings modal. Both factories' own functions are
 * already thoroughly unit-tested at the lift-and-run level; this file tests
 * only the WIRING, the same split test/settings-credential.test.js's "the
 * section is wired into the modal" describe block draws for the credential
 * section beside it.
 *
 * openGlobalSettings() itself is not lifted and run (same reason
 * test/history-drawer-uploads.test.js states for its own too-many-page-level-
 * dependencies function): it reads `state`, half a dozen other DOM ids, and
 * several helper functions defined elsewhere in the same file. Structural
 * source-text assertions are this file's own established answer to that —
 * confirming a specific call site exists, is correctly guarded, and feeds
 * the right arguments — not executing it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bridgeNotify = require('../lib/bridge-notify');

const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sessionHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
const swJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

describe('bridge-step-up.js / bridge-settings-ui.js script mounting (#2884)', () => {
  it('is loaded on both index.html and session.html', () => {
    for (const html of [indexHtml, sessionHtml]) {
      assert.match(html, /<script src="\/bridge-step-up\.js"><\/script>/);
      assert.match(html, /<script src="\/bridge-settings-ui\.js"><\/script>/);
    }
  });

  it('is registered in sw.js for both offline precache and network-first serving', () => {
    for (const file of ['bridge-step-up.js', 'bridge-settings-ui.js']) {
      assert.match(swJs, new RegExp(`STATIC_ASSETS[\\s\\S]*'/${file.replace('.', '\\.')}'[\\s\\S]*NETWORK_FIRST_PATHS`),
        `${file} must precede NETWORK_FIRST_PATHS in STATIC_ASSETS`);
      assert.match(swJs, new RegExp(`NETWORK_FIRST_PATHS[\\s\\S]*'/${file.replace('.', '\\.')}'`),
        `${file} must also be in NETWORK_FIRST_PATHS`);
    }
  });
});

describe('Global Settings modal wiring (#2884)', () => {
  it('renders a section host for each panel', () => {
    assert.match(ui, /id="gsBridgeStepUpSection"/);
    assert.match(ui, /id="gsBridgeSettingsSection"/);
  });

  it('mounts the step-up panel, guarded, and loads it once mounted', () => {
    assert.match(ui, /typeof window\.tcCreateBridgeStepUp === 'function'/);
    assert.match(ui, /tcCreateBridgeStepUp\(\{ rootId: 'gsBridgeStepUpSection', prefix: 'gsBsu', api, apiMutate, esc \}\)/);
    assert.match(ui, /bridgeStepUpPanel\.mount\(\)\)\s*bridgeStepUpPanel\.load\(\)/);
  });

  it('mounts the settings panel, guarded, with the real project list and event kinds', () => {
    assert.match(ui, /typeof window\.tcCreateBridgeSettingsUi === 'function'/);
    assert.match(ui, /rootId: 'gsBridgeSettingsSection', prefix: 'gsBset'/);
    assert.match(ui, /projects: state\.projects\.map\(\(proj\) => \(\{ id: proj\.id, name: proj\.name \}\)\)/);
    assert.match(ui, /eventKinds: BRIDGE_NOTIFICATION_EVENT_KINDS/);
    assert.match(ui, /bridgeSettingsPanel\.loadReach\(\);/);
    assert.match(ui, /bridgeSettingsPanel\.loadNotificationPolicy\(\);/);
    assert.match(ui, /bridgeSettingsPanel\.loadChannels\(\);/);
  });

  it('binds the settings panel\'s four static shell buttons to the matching method', () => {
    assert.match(ui, /ReachOptOutBtn[\s\S]{0,80}setReachBatch\(true\)/);
    assert.match(ui, /ReachOptInBtn[\s\S]{0,80}setReachBatch\(false\)/);
    assert.match(ui, /NarrowingPromptDismiss[\s\S]{0,80}dismissNarrowingPrompt\(\)/);
    assert.match(ui, /RegisterChannelBtn[\s\S]{0,80}registerChannelFromForm\(\)/);
  });
});

describe('BRIDGE_NOTIFICATION_EVENT_KINDS (#2884)', () => {
  it('matches lib/bridge-notify.js\'s own real, admitted notification types exactly', () => {
    const match = ui.match(/const BRIDGE_NOTIFICATION_EVENT_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
    assert.ok(match, 'BRIDGE_NOTIFICATION_EVENT_KINDS must be declared as a frozen array literal');
    const declared = Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    const real = Object.keys(bridgeNotify.TEMPLATES);
    assert.deepEqual([...declared].sort(), [...real].sort(),
      'the hand-kept dashboard list must track lib/bridge-notify.js TEMPLATES exactly -- there is no API to read it from, so drift here is silent');
  });
});
