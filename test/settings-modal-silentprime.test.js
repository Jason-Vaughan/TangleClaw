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
    it('declares a capability gate against project.engine.capabilities.supportsSilentPrime', () => {
      // Gating on the engine profile's capability flag (not just engine.id) keeps the
      // UI honest if the capability later applies to other engines.
      assert.match(src, /project\.engine\.capabilities\.supportsSilentPrime/);
    });

    it('renders a #settingsSilentPrime checkbox tied to project.silentPrime', () => {
      assert.match(src, /id="settingsSilentPrime"/);
      // The checkbox state must mirror project.silentPrime (so reopening the modal
      // shows the persisted value, not always-unchecked).
      assert.match(src, /\$\{project\.silentPrime\s*\?\s*'checked'\s*:\s*''\}/);
    });

    it('toggle markup sits inside the conditional block (not unconditionally emitted)', () => {
      // Walk the surrounding JS: the silentPrimeBlock must be assigned a ternary
      // gated on supportsSilent, not a plain string. This protects against a future
      // edit that drops the gate.
      const idx = src.indexOf('settingsSilentPrime');
      assert.ok(idx >= 0);
      const before = src.slice(Math.max(0, idx - 600), idx);
      assert.match(before, /supportsSilent\s*\?/);
    });

    it('non-supportive engines get an empty string from the gate (Critic Mn2 regression)', () => {
      // Locks in the *negative* branch of the ternary: when supportsSilent is false,
      // the silentPrimeBlock variable evaluates to '' (empty string). The structural
      // assertion above only confirmed the gate exists. This one confirms what the
      // gate actually produces when it falls through.
      const m = src.match(/const silentPrimeBlock\s*=\s*supportsSilent\s*\?[\s\S]+?:\s*('|")\1\s*;/);
      assert.ok(m, 'silentPrimeBlock must use a ternary that falls through to empty string');
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
