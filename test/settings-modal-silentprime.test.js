'use strict';

/*
 * Frontend regression tests for #103 chunk 2 — the per-project Silent Prime
 * toggle in the Project Settings modal (public/ui.js).
 *
 * The toggle:
 *   1. Renders inside #settingsBody only when project.engine.capabilities.supportsSilentPrime is true.
 *   2. Reflects the current project.silentPrime value via the checkbox checked state.
 *   3. Sends silentPrime: <bool> on the PATCH body produced by doSaveSettings.
 *
 * ui.js is a large script with many top-level dependencies (state, esc, apiMutate,
 * etc.) and renders DOM via innerHTML strings, so source-level structural assertions
 * are the pragmatic way to lock in the contract — the same pattern used for session.js
 * in test/session-wrapper.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Project Settings modal — silentPrime toggle (#103 chunk 2)', () => {
  let src;

  before(() => {
    src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  });

  describe('openSettings render', () => {
    it('declares a capability gate via state.engines profile.capabilities.supportsSilentPrime', () => {
      // The gate lives in the renderSilentPrimeToggle helper: it looks up the
      // selected engine in `state.engines` and reads `profile.capabilities.supportsSilentPrime`.
      // Gating on the capability flag (not on `engine.id === 'claude'`) keeps the
      // UI honest if the capability is later added to other engines.
      assert.match(src, /profile\.capabilities\.supportsSilentPrime/);
      // Engine resolution from the dropdown's value, not from the project record.
      assert.match(src, /state\.engines.*\.find\(e\s*=>\s*e\.id\s*===\s*engineId\)/);
    });

    it('renders a #settingsSilentPrime checkbox tied to the preserved checked state', () => {
      assert.match(src, /id="settingsSilentPrime"/);
      // The checkbox state mirrors the `preserveChecked` argument so the helper
      // can carry the user's intent across engine-dropdown switches.
      assert.match(src, /\$\{preserveChecked\s*\?\s*'checked'\s*:\s*''\}/);
    });

    it('non-supportive engines wipe the container (Critic Mn2 regression)', () => {
      // When supportsSilent is false, the helper sets container.innerHTML = ''
      // and returns. This is the structural lock-in for the negative branch — a
      // future refactor cannot accidentally emit toggle markup on a non-supportive
      // engine.
      assert.match(src, /if\s*\(\s*!supportsSilent\s*\)\s*\{[^}]*container\.innerHTML\s*=\s*['"]['"]/);
    });

    it('initial render is wired into openSettings via renderSilentPrimeToggle', () => {
      // openSettings must call renderSilentPrimeToggle(engineId, initialChecked)
      // so the toggle's first paint reflects the project's current state.
      const fnIdx = src.indexOf('function openSettings');
      assert.ok(fnIdx >= 0);
      const slice = src.slice(fnIdx, fnIdx + 5000);
      assert.match(slice, /renderSilentPrimeToggle\(/);
      assert.match(slice, /initialSilentChecked\s*=\s*!!project\.silentPrime/);
    });

    it('engine dropdown change re-renders the toggle (Critic Mn5 polish)', () => {
      // A `change` listener on #settingsEngine calls renderSilentPrimeToggle
      // with the dropdown's new value, so switching to a non-supportive engine
      // hides the toggle and switching back restores it. Preserves the checkbox's
      // current state across the swap.
      const fnIdx = src.indexOf('function openSettings');
      const slice = src.slice(fnIdx, fnIdx + 5000);
      assert.match(slice, /getElementById\(['"]settingsEngine['"]\)\.addEventListener\(['"]change['"]/);
      // The change handler must call renderSilentPrimeToggle (not just update state)
      assert.match(slice, /addEventListener\(['"]change['"][\s\S]+?renderSilentPrimeToggle\(/);
    });

    it('explanatory hint mentions SessionStart hook so the user knows what they are opting into', () => {
      assert.match(src, /SessionStart hook/);
    });
  });

  describe('doSaveSettings PATCH body', () => {
    it('includes silentPrime in the PATCH body when the checkbox was rendered', () => {
      // Find the doSaveSettings function and check it reads the checkbox and
      // attaches silentPrime to the body. Use a brace-walked slice so a future
      // refactor that splits the function still passes structurally.
      const fnIdx = src.indexOf('async function doSaveSettings');
      assert.ok(fnIdx >= 0, 'doSaveSettings must exist');
      // Walk forward until the matching closing brace for the function.
      let depth = 0;
      let i = src.indexOf('{', fnIdx);
      const start = i;
      assert.ok(start >= 0);
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const fnBody = src.slice(start, i + 1);
      assert.match(fnBody, /getElementById\(['"]settingsSilentPrime['"]\)/);
      assert.match(fnBody, /body\.silentPrime\s*=/);
    });

    it('only attaches silentPrime when the element exists (matches capability-gated render)', () => {
      // The render is gated, so reading the checkbox must also be gated to avoid
      // sending an undefined silentPrime field on non-Claude engines. A truthy
      // `if (silentPrimeEl)` guard or equivalent is required.
      const fnIdx = src.indexOf('async function doSaveSettings');
      const slice = src.slice(fnIdx, fnIdx + 1500);
      assert.match(slice, /if\s*\(\s*silentPrimeEl\s*\)/);
    });
  });
});
