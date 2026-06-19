'use strict';

/*
 * UB (#228/#229) — client-side wiring for the "Update & restart" pill action.
 *
 * Source-level structural assertions over public/landing.js + style.css, same
 * pattern as test/update-pill-link.test.js (#149). The backend (lib/update-applier.js
 * + the route) has its own behavioral suites; these lock the frontend contract:
 * the button is rendered + wired, the apply→restart→poll flow is correct, the
 * refusal/no-mechanism paths surface honestly, and — load-bearing — the restart
 * poll has NO timer-driven blind reload (the no-UI-timers rule, #98/#268).
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('UB self-update pill (#228/#229)', () => {
  let js, css;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  describe('button render + wiring', () => {
    it('renders an "Update & restart" button in the pill', () => {
      assert.match(js, /class="update-pill-apply" id="updateApplyBtn"/);
      assert.match(js, /Update &amp; restart/);
    });

    it('wires the button click to applyUpdateAndRestart(data)', () => {
      assert.match(js, /getElementById\('updateApplyBtn'\)/);
      assert.match(js, /applyUpdateAndRestart\(data\)/);
      assert.match(js, /function applyUpdateAndRestart\(data\)/);
    });

    it('keeps the existing dismiss button intact alongside the new action', () => {
      // Regression guard — the action button addition must not break the
      // per-version dismiss contract existing installs rely on.
      assert.match(js, /class="update-pill-dismiss"/);
      assert.match(js, /tc_updateDismissed_\$\{data\.latestVersion\}/);
    });
  });

  describe('apply → restart → poll flow', () => {
    it('POSTs the apply route, then chains the existing #235 restart route', () => {
      assert.match(js, /apiMutate\('\/api\/update\/apply', 'POST'/);
      assert.match(js, /apiMutate\('\/api\/server\/restart', 'POST'/);
    });

    it('confirms before mutating and serializes via the shared restartInFlight flag', () => {
      assert.match(js, /window\.confirm\(/);
      assert.match(js, /if \(state\.restartInFlight\) return;/);
    });

    it('routes the poll→reload through the shared pollServerBackAndReload helper', () => {
      assert.match(js, /function pollServerBackAndReload\(oldStartedAt, restore\)/);
      // Both the #235 restart and the UB apply path must use the one helper —
      // a definition + two call sites.
      const calls = js.match(/pollServerBackAndReload\(/g) || [];
      assert.ok(calls.length >= 3, `expected helper definition + 2 call sites, found ${calls.length}`);
    });
  });

  describe('no timer-driven reload (no-UI-timers rule #98/#268)', () => {
    it('never reloads on a setTimeout — the helper aborts honestly without a baseline', () => {
      // The load-bearing guard: a missing startedAt baseline must abort with a
      // message (let the operator refresh), NOT a blind timed window.location.reload.
      assert.doesNotMatch(js, /setTimeout\([^;]*window\.location\.reload/);
      assert.match(js, /if \(!oldStartedAt\) \{[\s\S]*?restore\(\);[\s\S]*?window\.alert/);
    });
  });

  describe('honest failure surfacing', () => {
    it('surfaces a refused-guard (409) reason from the server', () => {
      assert.match(js, /Update not applied:/);
      assert.match(js, /applyResp && applyResp\.error\) \|\| api\.lastError/);
    });

    it('degrades honestly when the restart has no mechanism (code already on disk)', () => {
      assert.match(js, /on disk, but auto-restart didn't run/);
    });
  });

  describe('CSS', () => {
    it('declares .update-pill-apply with a hover + disabled treatment', () => {
      assert.match(css, /\.update-pill-apply\s*\{/);
      assert.match(css, /\.update-pill-apply:hover:not\(:disabled\)/);
      assert.match(css, /\.update-pill-apply:disabled/);
    });
  });
});
