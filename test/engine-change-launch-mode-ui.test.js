'use strict';

/*
 * #2189 — the dashboard settings modal must not carry one engine's launch mode
 * onto another.
 *
 * The server resets the default launch mode on an engine change unless the same
 * update names one (`test/launch-mode-settings.test.js`). That alone left the
 * modal wrong in two ways: moving the engine dropdown re-rendered the mode
 * control with the previous engine's selection whenever the new engine defined
 * the same key, and the save omitted the mode when it equalled the stored
 * value. So an operator saw "Bypass" selected for the new engine and the server
 * was told no mode had been chosen. These tests run the modal's own functions.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const loadApiHelperGlobals = require('./_api-helper-globals');
const store = require('../lib/store');
const projects = require('../lib/projects');

const PUBLIC = path.join(__dirname, '..', 'public');
// Every bundled profile, read from the directory, so an engine added later is
// compared without anyone remembering to list it here.
const ENGINE_IDS = fs.readdirSync(path.join(__dirname, '..', 'data', 'engines'))
  .filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();

/**
 * A bundled engine profile, as shipped.
 * @param {string} id - Engine id
 * @returns {object}
 */
function profile(id) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8'));
}

/**
 * A project record as the modal holds it.
 * @param {string} engineId - Stored engine
 * @param {string} mode - Stored default launch mode
 * @returns {object}
 */
function projectOn(engineId, mode) {
  const p = profile(engineId);
  return { engine: { id: p.id, name: p.name, launchModes: p.launchModes }, defaultLaunchMode: mode, showLaunchModePicker: true };
}

/**
 * One top-level function's source in a browser script.
 * @param {string} src - File contents
 * @param {string} decl - The declaration's opening text
 * @returns {string}
 */
function functionSource(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

describe('#2189 — the settings modal and an engine change', () => {
  let helpers;
  let ui;

  before(() => {
    helpers = loadApiHelperGlobals();
    ui = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');
  });

  describe('tcLaunchModeForEngine — what the mode control shows', () => {
    it('shows default for any other engine, whatever the project has stored', () => {
      for (const from of ENGINE_IDS) {
        for (const mode of Object.keys(profile(from).launchModes)) {
          for (const to of ENGINE_IDS.filter((id) => id !== from)) {
            assert.equal(helpers.tcLaunchModeForEngine(projectOn(from, mode), to), 'default',
              `${from}/${mode} shown on ${to}`);
          }
        }
      }
    });

    it('shows the stored mode again when the dropdown returns to the stored engine', () => {
      assert.equal(helpers.tcLaunchModeForEngine(projectOn('codex', 'bypassPermissions'), 'codex'), 'bypassPermissions');
      assert.equal(helpers.tcLaunchModeForEngine(projectOn('claude', 'plan'), 'claude'), 'plan');
    });

    it('answers default for a project with no stored mode or no engine', () => {
      assert.equal(helpers.tcLaunchModeForEngine({ engine: { id: 'claude' } }, 'claude'), 'default');
      assert.equal(helpers.tcLaunchModeForEngine(null, 'claude'), 'default');
    });
  });

  describe('tcLaunchModePatch — what the save sends', () => {
    it('sends nothing for an unchanged mode on an unchanged engine', () => {
      // The stored bypass + hidden picker was confirmed once; resending it on a
      // tag edit would trip the server's guard for a change nobody made.
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'bypassPermissions'), 'claude', 'bypassPermissions'), undefined);
    });

    it('sends a changed mode on an unchanged engine', () => {
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'default'), 'claude', 'plan'), 'plan');
    });

    it('always sends the mode with an engine change, even when its key equals the stored one', () => {
      // The case that lost the operator's choice: Bypass stored for Claude,
      // Bypass picked again for Codex. Equal keys, different engines.
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'bypassPermissions'), 'codex', 'bypassPermissions'), 'bypassPermissions');
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'default'), 'codex', 'default'), 'default');
    });

    it('sends nothing when the mode control is not rendered', () => {
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'plan'), 'codex', null), undefined);
      assert.equal(helpers.tcLaunchModePatch(projectOn('claude', 'plan'), 'codex', undefined), undefined);
    });
  });

  describe('the modal applies the rule the server applies', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-2189-ui-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
    });
    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('shows, for every engine pair and stored mode, the mode an engine-only save stores', () => {
      // Two implementations of one rule, in two runtimes that cannot share a
      // file. Derived from the bundled profiles on both sides, so a mode added
      // to an engine is covered without editing this test.
      let compared = 0;
      for (const from of ENGINE_IDS) {
        for (const mode of Object.keys(profile(from).launchModes)) {
          for (const to of ENGINE_IDS) {
            const shown = helpers.tcLaunchModeForEngine(projectOn(from, mode), to);
            const stored = projects.launchModeAfterUpdate(
              { engine: to }, { engineId: from }, { defaultLaunchMode: mode }, store.engines.get(to));
            assert.equal(shown, stored, `${from}/${mode} -> ${to}: modal shows ${shown}, server stores ${stored}`);
            compared++;
          }
        }
      }
      assert.ok(compared > ENGINE_IDS.length, 'the comparison must have run over real modes');
    });
  });

  describe('renderLaunchModeSettings — the control itself', () => {
    /**
     * Render the launch-mode section for an engine and return its markup.
     * @param {string} engineId - Engine the dropdown names
     * @param {string} mode - Mode to show selected
     * @param {object|null} resetFrom - Engine whose mode was dropped, or null
     * @returns {string}
     */
    function render(engineId, mode, resetFrom) {
      const container = { innerHTML: '' };
      const ctx = {
        document: { getElementById: (id) => (id === 'settingsLaunchModeContainer' ? container : null) },
        state: { engines: ENGINE_IDS.map(profile) },
        tcHonoredLaunchModes: helpers.tcHonoredLaunchModes,
        esc: helpers.tcEscapeHtml
      };
      vm.createContext(ctx);
      vm.runInContext(functionSource(ui, 'function renderLaunchModeSettings('), ctx);
      ctx.renderLaunchModeSettings(engineId, mode, true, resetFrom);
      return container.innerHTML;
    }

    /**
     * The value of the option the markup marks selected.
     * @param {string} html - Rendered section
     * @returns {string|null}
     */
    function selected(html) {
      const m = html.match(/<option value="([^"]+)" selected>/);
      return m ? m[1] : null;
    }

    it('selects Interactive on Antigravity for a project that stored Bypass on Codex', () => {
      const project = projectOn('codex', 'bypassPermissions');
      const html = render('antigravity', helpers.tcLaunchModeForEngine(project, 'antigravity'), project.engine);
      assert.equal(selected(html), 'default');
      // Bypass is still offered: the operator may choose it for this engine.
      assert.match(html, /<option value="bypassPermissions" >/);
    });

    it('says the mode was reset and names the engine it was chosen for', () => {
      const project = projectOn('codex', 'bypassPermissions');
      const html = render('antigravity', 'default', project.engine);
      assert.match(html, /id="settingsLaunchModeReset"/);
      assert.match(html, /the mode chosen for Codex does not carry over/);
    });

    it('says nothing about a reset when nothing was dropped', () => {
      assert.doesNotMatch(render('codex', 'bypassPermissions', null), /settingsLaunchModeReset/);
    });

    it('escapes the engine name in the note', () => {
      const html = render('antigravity', 'default', { id: 'x', name: '<img src=x>' });
      assert.doesNotMatch(html, /<img src=x>/);
    });
  });

  describe('request and response, end to end', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-2189-e2e-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
    });
    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * The PATCH body the real `doSaveSettings` builds for a modal in this state.
     * @param {object} project - The project as the dashboard holds it
     * @param {string} engineValue - The engine dropdown's value
     * @param {string} modeValue - The mode control's value
     * @returns {Promise<object>}
     */
    async function savedBody(project, engineValue, modeValue) {
      const els = {
        settingsName: { value: project.name },
        settingsEngine: { value: engineValue },
        settingsTags: { value: '' },
        settingsDefaultLaunchMode: { value: modeValue },
        settingsShowLaunchPicker: { checked: project.showLaunchModePicker !== false }
      };
      const sent = [];
      const ctx = {
        document: { getElementById: (id) => els[id] || null },
        state: { projects: [project], engines: ENGINE_IDS.map(profile) },
        settingsTarget: project.name,
        async _submitSettings(body) { sent.push(body); },
        tcSettingDisposition: () => ({ applies: false }),
        tcLaunchModePatch: helpers.tcLaunchModePatch,
        collectWrapSectionsSelection: () => undefined,
        openBypassHiddenModal() { assert.fail('no confirmation is expected for a reset to the default mode'); }
      };
      vm.createContext(ctx);
      vm.runInContext(`${functionSource(ui, 'async function doSaveSettings(')}; this.run = doSaveSettings;`, ctx);
      await ctx.run();
      assert.equal(sent.length, 1, 'the save must have been submitted');
      return JSON.parse(JSON.stringify(sent[0]));
    }

    it('the save the dashboard really sends for an engine switch is answered with the reset', async () => {
      // The whole path an operator takes: a Codex project on Bypass, the engine
      // dropdown moved to Antigravity (the mode control resets), Save. The
      // modal's own body goes to the server's own update, and the answer must
      // say what happened to the mode. A note shown before the save is not
      // that: it is gone once the modal closes.
      const dir = path.join(tmpDir, 'p-e2e');
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name: 'p-e2e', path: dir, engine: 'codex' });
      const cfg = store.projectConfig.load(dir);
      cfg.engine = 'codex';
      store.projectConfig.save(dir, cfg);
      assert.deepEqual((await projects.updateProject('p-e2e', { defaultLaunchMode: 'bypassPermissions' })).errors, []);

      const held = { ...projectOn('codex', 'bypassPermissions'), name: 'p-e2e' };
      const shown = helpers.tcLaunchModeForEngine(held, 'antigravity');
      const body = await savedBody(held, 'antigravity', shown);
      assert.equal(body.engine, 'antigravity');
      assert.equal(body.defaultLaunchMode, 'default', 'the dashboard names the default mode with the engine');

      const answer = await projects.updateProject('p-e2e', body);
      assert.deepEqual(answer.errors, []);
      assert.equal(store.projectConfig.load(dir).defaultLaunchMode, 'default');
      const told = (answer.warnings || []).filter((w) => /reset to Interactive/.test(w));
      assert.equal(told.length, 1, `the answer to the dashboard's save must report the reset: ${JSON.stringify(answer.warnings)}`);
      assert.match(told[0], /Bypass was chosen for Codex and does not carry to Antigravity/);
    });
  });

  describe('wiring', () => {
    it('the engine-change handler asks the rule for the mode instead of reading the control', () => {
      const start = ui.indexOf("document.getElementById('settingsEngine').addEventListener('change', (e) => {");
      assert.notEqual(start, -1, 'the engine-change handler must exist');
      const handler = ui.slice(start, ui.indexOf('\n  });\n', start));
      assert.match(handler, /tcLaunchModeForEngine\(project, e\.target\.value\)/);
      assert.doesNotMatch(handler, /settingsDefaultLaunchMode/,
        'reading the mode control here is how the previous engine\'s selection was carried over');
    });

    it('the save takes its launch mode from tcLaunchModePatch with the engine it is sending', () => {
      const save = functionSource(ui, 'async function doSaveSettings(');
      assert.match(save, /tcLaunchModePatch\(project2, body\.engine, /);
      assert.doesNotMatch(save, /launchModeEl\.value !== \(project2\.defaultLaunchMode/,
        'the value-only comparison is what omitted a mode re-chosen for a new engine');
    });
  });
});
