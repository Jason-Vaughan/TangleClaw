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
  // renderMasterSettingsBody moved into the shared tcCreateMasterSettings
  // component so the modal can mount on the session page too; these pins
  // follow it there with their assertions unchanged.
  let helperSrc;

  before(() => {
    uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    helperSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
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

    // The fallback these two pin MOVED, it was not dropped (#736). It used to
    // live in `tcBuildEngineOptions`, re-established at every render site; it
    // is now established once in `engines.engineClientPayload`, the single
    // projection through which both the roster and the per-project engine
    // reach the browser.
    //
    // So they now drive the real producer. Feeding this function a RAW profile
    // asserted against a shape production never sends it — the same fixture
    // trap that let a browser predicate gate on an unprojected field and answer
    // for every engine (#1251). If the projection stops normalising, these go
    // red; if a render site re-adds a private guard, the parity check below
    // catches that instead.
    const engines = require('../lib/engines');

    it('labels an unnamed profile with its id, through the projection', () => {
      // Only `id` is validated when a profile is saved, and `get()` JSON-parses
      // whatever is on disk, so a hand-added profile can lack `name` entirely.
      const projected = engines.engineClientPayload({ id: 'homegrown' }, { available: true });
      assert.equal(projected.name, 'homegrown', 'the projection owns the fallback now');
      assert.match(buildEngineOptions([projected], ''), />homegrown</);
    });

    it('does the same for a truthy non-string name, which esc would drop', () => {
      // `name || id` alone is not enough: a truthy non-string takes the left
      // branch and production `esc` returns '' for it, so the option is blank
      // anyway. That is why the projection tests the type, not truthiness.
      const projected = engines.engineClientPayload({ id: 'homegrown', name: 42 }, { available: true });
      assert.equal(projected.name, 'homegrown');
      assert.match(buildEngineOptions([projected], ''), />homegrown</);
    });

    it('no render site keeps a private copy of the fallback', () => {
      // The point of moving it: one owner, not one per surface. A re-added
      // guard is not a bug in itself — it is the drift that made the count of
      // sites needing to remember grow without anything failing.
      //
      // Walks EVERY `.js` under `public/`, not a hand-listed three. A guard
      // that enumerates today's files answers "clean" about the eleven it never
      // opened, which is this repo's own recorded lesson about set claims — and
      // the first cut of this test made exactly that mistake.
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.join(__dirname, '..', 'public');

      /** @param {string} dir - Directory to walk. @returns {string[]} */
      const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return jsFiles(full);
        return e.name.endsWith('.js') ? [full] : [];
      });

      const files = jsFiles(root);
      assert.ok(files.length >= 10, `the walk found only ${files.length} files — it is not reaching public/`);

      // `tcEngineDisplayName` is the one legitimate holder: it is the browser
      // half of `engines.engineDisplayName`, whose server callers pass raw
      // profiles, and the parity test holds the two to the same words. Its body
      // is excised so the scan cannot pass by finding it — the exact way the
      // first cut of this guard stayed green with a live copy inside a file it
      // was already reading.
      const owner = /function tcEngineDisplayName\(engine\) \{[\s\S]*?\n {2}\}/;
      let sawOwner = false;
      for (const file of files) {
        let src = fs.readFileSync(file, 'utf8');
        if (owner.test(src)) { sawOwner = true; src = src.replace(owner, ''); }
        const rel = path.relative(path.join(__dirname, '..'), file);
        // Both spellings the deleted guards used, so a re-add cannot dodge the
        // scan by switching operators.
        assert.doesNotMatch(src, /typeof\s+\w+\.name\s*===\s*'string'/,
          `${rel} re-establishes the engine-name fallback the projection already guarantees`);
        // The `||` form is scoped to lines that also name an engine. Unscoped,
        // it matches any `x.name || x.id` — `public/session.js` builds a Medusa
        // WORKSPACE label that way, a different domain with no projection
        // behind it, and failing on that would be the same error as the
        // too-narrow first cut, pointed the other way.
        for (const line of src.split('\n')) {
          if (!/engine/i.test(line)) continue;
          assert.doesNotMatch(line, /\w+\.name\s*\|\|\s*\w+\.id/,
            `${rel} re-establishes the engine-name fallback with the || form: ${line.trim()}`);
        }
      }
      assert.ok(sawOwner, 'tcEngineDisplayName was not found — the exclusion is stale, not satisfied');
    });

    it('no browser code reads the one engine response that is not projected', () => {
      // `GET /api/engines/:id` returns the RAW profile on purpose — it is the
      // introspection endpoint and carries fields the projection drops
      // (`detection`, `errorPatterns`, `statusPage`). So it is the single
      // engine response without #736's usable-`name` guarantee, and the render
      // sites that now read `engine.name` straight are safe only while nothing
      // in `public/` fetches it.
      //
      // Pinned rather than trusted: "no caller today" is what made the old
      // per-site guards look redundant, and a future fetch here would reopen
      // the blank-label hole with nothing turning red.
      const fs = require('node:fs');
      const path = require('node:path');
      const root = path.join(__dirname, '..', 'public');
      /** @param {string} dir - Directory to walk. @returns {string[]} */
      const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return jsFiles(full);
        return e.name.endsWith('.js') ? [full] : [];
      });
      for (const file of jsFiles(root)) {
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(path.join(__dirname, '..'), file);
        // The trailing slash is the discriminator: the roster is
        // `'/api/engines'` and is projected. Deliberately NOT requiring a
        // character after it — the realistic caller writes
        // `'/api/engines/' + id`, where the next character is the closing
        // quote, and a pattern demanding a literal id matched none of them.
        assert.doesNotMatch(src, /['"`]\/api\/engines\//,
          `${rel} fetches the unprojected single-engine endpoint — route it through the roster, `
          + 'or project that response first (#736)');
      }
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
      const body = sliceFunction(helperSrc, 'renderMasterSettingsBody');
      assert.match(body, /buildEngineOptions\(state\.engines/);
      assert.doesNotMatch(
        body,
        /<option value="\$\{esc\(e\.id\)\}"/,
        'a fourth copy of the option template is how this picker drifted in the first place'
      );
    });

    it('keeps its own "follow default engine" empty option', () => {
      const body = sliceFunction(helperSrc, 'renderMasterSettingsBody');
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
        // Pins the argument list, not just the call name. The shared builder
        // escapes with whatever it is handed, so a page delegating with
        // `String` or an identity function would satisfy a bare
        // `tcBuildEngineOptions(` grep while injecting unescaped markup from an
        // engine id or name. (It does not guard the blank-label case — the
        // `typeof` fallback picks the label before escaping, so that one is
        // safe regardless of the escaper.) Note this matches the parameter
        // identifiers verbatim, so renaming them is a deliberate edit here too.
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
