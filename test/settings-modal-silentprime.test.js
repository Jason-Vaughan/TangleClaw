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
    it('asks the shared disposition for the gate rather than reading a capability flag here', () => {
      // The gate is a capability check, not `engine.id === 'claude'`, so the UI
      // stays honest if the capability is later added to another engine. It now
      // lives in ONE place for both realms — `tcSettingDisposition`
      // (`public/api-helper.js`), whose answer `test/setting-disposition.test.js`
      // pins against the server's over every bundled profile. Reading the flag
      // here again would be the second implementation ADR 0013 forbids.
      assert.match(src, /tcSettingDisposition\('silentPrime'/);
      assert.doesNotMatch(src, /profile\.capabilities\.supportsSilentPrime/);
      assert.doesNotMatch(src, /engineId\s*===\s*'claude'/);
      // Engine resolution from the dropdown's value, not from the project record.
      assert.match(src, /state\.engines.*\.find\(e\s*=>\s*e\.id\s*===\s*engineId\)/);
    });

    it('renders a #settingsSilentPrime checkbox tied to the preserved checked state', () => {
      assert.match(src, /id="settingsSilentPrime"/);
      // The checkbox state mirrors the `preserveChecked` argument so the helper
      // can carry the user's intent across engine-dropdown switches.
      assert.match(src, /\$\{preserveChecked\s*\?\s*'checked'\s*:\s*''\}/);
    });

    it('non-supportive engines say the setting does not apply — and render no #settingsSilentPrime (#741)', () => {
      // The negative branch used to wipe the container, which read as "this
      // engine has no such setting". It now says so in words. The structural
      // lock-in stays: no `#settingsSilentPrime` element may exist on this
      // branch, because doSaveSettings attaches `silentPrime` only when it does.
      const branch = /if\s*\(\s*!disposition\.applies\s*\)\s*\{([\s\S]*?)\n    return;\n  \}/.exec(src);
      assert.ok(branch, 'the not-supported branch exists and returns');
      assert.match(branch[1], /esc\(disposition\.reason\)/,
        'the operator is told the setting does not apply, in the words the server would use');
      assert.match(branch[1], /disabled/, 'the control is inert, not hidden');
      assert.doesNotMatch(branch[1], /id="settingsSilentPrime"/, 'no saveable control on this branch');
    });

    it('initial render is wired into openSettings via renderSilentPrimeToggle', () => {
      // openSettings must call renderSilentPrimeToggle(engineId, initialChecked)
      // so the toggle's first paint reflects the project's current state.
      const fnIdx = src.indexOf('function openSettings');
      assert.ok(fnIdx >= 0);
      // Window spans the whole openSettings body; widened from 5000 as the modal
      // grew (MED-2K9P Chunk 02 added the Medusa pill), which pushed the
      // settingsEngine change listener past the old probe bound. Assertions below
      // are openSettings-specific, so a slightly over-wide window is harmless.
      const slice = src.slice(fnIdx, fnIdx + 9000);
      assert.match(slice, /renderSilentPrimeToggle\(/);
      assert.match(slice, /initialSilentChecked\s*=\s*!!project\.silentPrime/);
    });

    it('engine dropdown change re-renders the toggle (Critic Mn5 polish)', () => {
      // A `change` listener on #settingsEngine calls renderSilentPrimeToggle
      // with the dropdown's new value, so switching to a non-supportive engine
      // hides the toggle and switching back restores it. Preserves the checkbox's
      // current state across the swap.
      const fnIdx = src.indexOf('function openSettings');
      // Window spans the whole openSettings body; widened from 5000 as the modal
      // grew (MED-2K9P Chunk 02 added the Medusa pill), which pushed the
      // settingsEngine change listener past the old probe bound. Assertions below
      // are openSettings-specific, so a slightly over-wide window is harmless.
      const slice = src.slice(fnIdx, fnIdx + 9000);
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
