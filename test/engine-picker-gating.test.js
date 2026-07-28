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
 * The behavior under test is the ONE shared implementation in
 * `public/api-helper.js`, required directly. The per-page functions are checked
 * only for delegating to it — the duplication is what let the session-page copy
 * ship ungated, so "does this page still have its own copy" is the thing worth
 * asserting about the pages themselves.
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
  assert.notEqual(start, -1, `${name} not found in the given source`);
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
    require('../public/api-helper.js');
    // Copied from production `esc` (public/landing.js), non-string rejection
    // included. A more forgiving stub renders values the real one drops, which
    // makes any assertion about label text quietly untrue.
    const esc = (str) => {
      if (typeof str !== 'string') return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    // The real shared implementations, not slices — both page copies now
    // delegate here, so testing this tests every picker at once.
    buildEngineOptions = (list, sel) => globalThis.tcBuildEngineOptions(list, sel, esc);
    resolvePickerEngine = globalThis.tcResolvePickerEngine;
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

    it('falls back to the id when a profile has no name', () => {
      // Only `id` is validated when an engine profile is saved, so a
      // hand-added profile can lack `name`. Without the fallback the option
      // renders blank — unselectable-looking, everywhere it is shared.
      const html = buildEngineOptions([{ id: 'homegrown', available: true }], '');
      assert.match(html, />homegrown</);
    });

    it('falls back for a non-string name too, which esc drops', () => {
      // `e.name || e.id` alone is not enough: a truthy non-string takes the
      // left branch and production `esc` returns '' for it, so the option is
      // blank anyway. Profile save validates only `id`, and `get()` JSON-parses
      // whatever is on disk, so the shape is reachable.
      const html = buildEngineOptions([{ id: 'homegrown', name: 42, available: true }], '');
      assert.match(html, />homegrown</);
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
    // Asserting /disabled/ over this function's source could not fail: it also
    // builds the access-level radios, whose template contains the word. The
    // picker now shares `buildEngineOptions`, so the behavioral assertions above
    // cover it and the only thing left to pin is that it still delegates.
    it('delegates to buildEngineOptions instead of hand-rolling options', () => {
      const body = sliceFunction(uiSrc, 'renderMasterSettingsBody');
      assert.match(body, /buildEngineOptions\(state\.engines/);
      assert.doesNotMatch(
        body,
        /<option value="\$\{esc\(e\.id\)\}"/,
        'a fourth copy of the option template is how this picker drifted in the first place'
      );
    });

    it('keeps its own "follow default engine" empty option', () => {
      const body = sliceFunction(uiSrc, 'renderMasterSettingsBody');
      assert.match(body, /<option value="">\(follow default engine\)<\/option>/,
        'only this picker has a no-pin state');
    });
  });

  describe('every page-level picker delegates to the shared builder', () => {
    // The blocking gap this closes: `public/session.js` carried its own
    // pre-#707 copy — labelling uninstalled engines but never disabling them —
    // and `session.html` never loads `ui.js`, so gating `ui.js` did nothing for
    // the operator's primary surface. Its settings modal PATCHes the chosen
    // engine straight onto the project.
    for (const file of ['ui.js', 'session.js']) {
      it(`${file} calls tcBuildEngineOptions rather than re-implementing it`, () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
        const body = sliceFunction(src, 'buildEngineOptions');
        // Pins the argument list too: delegating with a permissive escaper
        // would pass a bare `tcBuildEngineOptions(` check while re-opening the
        // blank-label hole the shared `typeof` guard closes.
        assert.match(body, /tcBuildEngineOptions\(engineList, selectedId, esc\)/,
          `${file} must delegate to the shared builder, passing the page's own esc`);
        assert.doesNotMatch(
          body,
          /<option value="\$\{esc\(e\.id\)\}"/,
          `${file} still hand-rolls option markup — that duplication is what let this drift`
        );
      });
    }

    it('session.html loads api-helper, so the shared builder is actually present', () => {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
      assert.match(html, /<script src="\/api-helper\.js">/);
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
