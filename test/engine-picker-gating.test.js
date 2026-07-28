'use strict';

/*
 * #707 — the engine pickers must not offer, or default to, an engine this
 * machine does not have.
 *
 * The server-side resolver is only half the fix. The Create-project drawer POSTs
 * its engine explicitly, so `data.engine || resolveDefaultEngine(config)` never
 * reaches its fallback — whatever the picker holds is what the project gets.
 * That makes the picker's seed and its selectable set part of the fix, not
 * cosmetics.
 *
 * `public/ui.js` is browser code (top-level DOM access), so the functions under
 * test are sliced out of source and evaluated in isolation — the same technique
 * as test/openclaw-engine.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice a function out of source text by brace matching.
 * @param {string} src - File source
 * @param {string} name - Function name
 * @returns {string}
 */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in public/ui.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('engine picker gating (#707)', () => {
  let resolvePickerEngine;
  let buildEngineOptions;
  let uiSrc;

  before(() => {
    uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    // `esc` is the only helper these two need.
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const factory = new Function('esc', `
      ${sliceFunction(uiSrc, 'resolvePickerEngine')}
      ${sliceFunction(uiSrc, 'buildEngineOptions')}
      return { resolvePickerEngine, buildEngineOptions };
    `);
    ({ resolvePickerEngine, buildEngineOptions } = factory(esc));
  });

  describe('resolvePickerEngine', () => {
    const CODEX_ONLY = [
      { id: 'claude', name: 'Claude Code', available: false },
      { id: 'codex', name: 'Codex', available: true }
    ];

    it('does not seed the picker with an uninstalled configured engine', () => {
      // The drawer POSTs this value, so seeding it from config.defaultEngine
      // bound new projects to a missing engine no matter what the server did.
      assert.equal(resolvePickerEngine(CODEX_ONLY, 'claude'), 'codex');
    });

    it('keeps the configured engine when it is installed', () => {
      assert.equal(resolvePickerEngine([
        { id: 'claude', available: true }, { id: 'codex', available: true }
      ], 'claude'), 'claude');
    });

    it('picks deterministically, not in engine-directory order', () => {
      // Mirrors the server's sort. The list arrives in profile-directory order,
      // and this value is persisted onto the project — an unsorted pick would
      // bind projects to a filesystem-dependent engine.
      const order1 = [{ id: 'codex', available: true }, { id: 'aider', available: true }];
      const order2 = [{ id: 'aider', available: true }, { id: 'codex', available: true }];
      assert.equal(resolvePickerEngine(order1, ''), resolvePickerEngine(order2, ''));
      assert.equal(resolvePickerEngine(order1, ''), 'aider');
    });

    it('treats a missing availability flag as not installed', () => {
      // The safe reading for a value that gets persisted.
      assert.equal(resolvePickerEngine([{ id: 'mystery' }], ''), '');
    });

    it('returns empty when nothing is installed', () => {
      assert.equal(resolvePickerEngine([{ id: 'claude', available: false }], 'claude'), '');
      assert.equal(resolvePickerEngine([], 'claude'), '');
      assert.equal(resolvePickerEngine(null, 'claude'), '');
    });
  });

  describe('buildEngineOptions', () => {
    const MIXED = [
      { id: 'claude', name: 'Claude Code', available: false },
      { id: 'codex', name: 'Codex', available: true }
    ];

    it('disables an uninstalled engine rather than only labelling it', () => {
      const html = buildEngineOptions(MIXED, 'codex');
      const claudeOpt = html.match(/<option value="claude"[^>]*>/)[0];
      assert.match(claudeOpt, /disabled/, 'an uninstalled engine must not be selectable');
      assert.match(html, /\(not installed\)/);
    });

    it('leaves installed engines selectable', () => {
      const codexOpt = buildEngineOptions(MIXED, 'codex').match(/<option value="codex"[^>]*>/)[0];
      assert.doesNotMatch(codexOpt, /disabled/);
    });

    it('never disables the engine currently in use', () => {
      // A project already bound to an engine that has since been uninstalled
      // must still render its own value — disabling it would make the control
      // show a selection it refuses to keep.
      const claudeOpt = buildEngineOptions(MIXED, 'claude').match(/<option value="claude"[^>]*>/)[0];
      assert.doesNotMatch(claudeOpt, /disabled/);
      assert.match(claudeOpt, /selected/);
    });
  });

  describe('the Master picker uses the same gating', () => {
    it('disables and labels uninstalled engines', () => {
      // This picker previously did neither, on the surface where it matters
      // most: the master launches its engine immediately, so an unavailable
      // pin fails at once rather than at some later project launch.
      const body = sliceFunction(uiSrc, 'renderMasterSettingsBody');
      assert.match(body, /e\.available === false/, 'master picker must consider availability');
      assert.match(body, /disabled/, 'master picker must disable uninstalled engines');
      assert.match(body, /not installed/, 'master picker must label uninstalled engines');
    });
  });

  describe('the Create-project drawer seeds from the resolver', () => {
    it('does not read config.defaultEngine straight into the payload', () => {
      const body = sliceFunction(uiSrc, 'openCreateModal');
      assert.match(body, /resolvePickerEngine\(/, 'the drawer must seed from the resolved engine');
      assert.doesNotMatch(
        body,
        /engine:\s*state\.config\s*\?\s*state\.config\.defaultEngine/,
        'seeding straight from config short-circuits the server resolver'
      );
    });
  });
});
