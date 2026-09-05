'use strict';

/*
 * #626 — project creation should collect the settings that are load-bearing for
 * the first session. Measured against the issue's own bar, the wizard already
 * shipped four of five (name, engine, launch posture, silent prime); the one
 * that remained is `showLaunchModePicker`, the pair of a field already on
 * step 2.
 *
 * The reason it is not merely a fifth field: it carries the eyes-open guard.
 * Hiding the picker while the default mode carries a warning
 * (bypassPermissions / fullAuto / yesAlways) removes the red
 * isolated-environments warning from the launch flow entirely. `updateProject`
 * has refused that combination without an explicit confirm since the settings
 * existed. `createProject` never has — and creation is both the place the
 * posture is first established and the one route the guard had never run on.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
setLevel('error');
const store = require('../lib/store');
const loadApiHelperGlobals = require('./_api-helper-globals');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');

describe('#626 launch posture is settable at creation, and the guard runs there', () => {
  let tmpDir;
  let projectsDir;
  let projects;
  let warnedMode;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-create-posture-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.defaultEngine = 'claude';
    store.config.save(config);
    projects = require('../lib/projects');

    // Read the warned mode off the real profile rather than naming one: a
    // fixture that hardcodes `bypassPermissions` keeps passing after the
    // profile stops warning about it, asserting a guard that no longer guards.
    const claude = store.engines.get('claude');
    warnedMode = Object.keys(claude.launchModes || {})
      .find((k) => claude.launchModes[k] && claude.launchModes[k].warning);
    assert.ok(warnedMode, 'claude must declare a warning-carrying mode, or these assert nothing');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** @param {string} name - Project name. @returns {object} Its stored config. */
  const cfgOf = (name) => store.projectConfig.load(path.join(projectsDir, name));

  it('persists showLaunchModePicker, so the posture no longer needs a second visit', () => {
    const result = projects.createProject({
      name: 'cp-hidden', engine: 'claude', showLaunchModePicker: false
    });
    assert.ok(result.project, `create must succeed: ${result.errors}`);
    assert.equal(cfgOf('cp-hidden').showLaunchModePicker, false);
  });

  it('defaults to showing the picker when the field is absent', () => {
    // A wizard clicked straight through must create exactly what it did before.
    const result = projects.createProject({ name: 'cp-default', engine: 'claude' });
    assert.ok(result.project);
    assert.equal(cfgOf('cp-default').showLaunchModePicker, true);
  });

  it('refuses a hidden picker over a warned default without an explicit confirm', () => {
    const result = projects.createProject({
      name: 'cp-guarded', engine: 'claude',
      defaultLaunchMode: warnedMode, showLaunchModePicker: false
    });
    assert.equal(result.project, null, 'the create is refused, not quietly made');
    assert.match(result.errors[0], /removes its warning from the launch flow/);
    assert.match(result.errors[0], /confirmBypassHidden/, 'and says how to proceed');
    assert.equal(fs.existsSync(path.join(projectsDir, 'cp-guarded')), false,
      'a refusal before the directory is created leaves nothing on disk');
  });

  it('allows it once confirmed', () => {
    const result = projects.createProject({
      name: 'cp-confirmed', engine: 'claude',
      defaultLaunchMode: warnedMode, showLaunchModePicker: false, confirmBypassHidden: true
    });
    assert.ok(result.project, `create must succeed: ${result.errors}`);
    const cfg = cfgOf('cp-confirmed');
    assert.equal(cfg.showLaunchModePicker, false);
    assert.equal(cfg.defaultLaunchMode, warnedMode);
  });

  it('does not fire on a hidden picker over a mode that carries no warning', () => {
    // The guard exists for the warning, not for the hidden picker. Blocking
    // every hidden picker would train the operator to confirm reflexively.
    const result = projects.createProject({
      name: 'cp-quiet', engine: 'claude',
      defaultLaunchMode: 'default', showLaunchModePicker: false
    });
    assert.ok(result.project, `create must succeed: ${result.errors}`);
    assert.equal(cfgOf('cp-quiet').showLaunchModePicker, false);
  });

  it('refuses a launch mode the engine will not run, as an edit already does', () => {
    // Create stored whatever it was handed. `updateProject` has validated the
    // mode against the engine all along, so the one route that establishes a
    // project's posture was the one route that did not check it.
    const result = projects.createProject({
      name: 'cp-badmode', engine: 'codex', defaultLaunchMode: 'plan'
    });
    assert.equal(result.project, null);
    assert.match(result.errors[0], /defaultLaunchMode/);
    assert.match(result.errors[0], /does not offer the launch mode "plan"/,
      'and it is the disposition\'s sentence, not a second wording of it');
  });

  it('refuses a silentPrime the engine cannot honor, and a non-boolean one', () => {
    // The create path stored this raw while PATCH refused both. Every reader
    // tests `=== true`, so a stored `"true"` runs with silent prime OFF against
    // a shipped default of on — a project born quietly wrong. Same class as the
    // launch-mode gap above: create-time validation lagging PATCH-time.
    const bad = projects.createProject({ name: 'cp-sp-type', engine: 'claude', silentPrime: 'yes' });
    assert.equal(bad.project, null);
    assert.match(bad.errors[0], /silentPrime must be a boolean/);

    const unsupported = projects.createProject({ name: 'cp-sp-engine', engine: 'codex', silentPrime: true });
    assert.equal(unsupported.project, null);
    assert.match(unsupported.errors[0], /silentPrime/, 'names the field it refused');
    assert.match(unsupported.errors[0], /does not deliver a hidden prime/,
      'and carries the disposition\'s sentence, the one the modal greys the row with');
    assert.equal(fs.existsSync(path.join(projectsDir, 'cp-sp-engine')), false,
      'refused before the directory is created');

    // `false` is not a request to do anything, so it is stored anywhere.
    const off = projects.createProject({ name: 'cp-sp-off', engine: 'codex', silentPrime: false });
    assert.ok(off.project, `create must succeed: ${off.errors}`);
    assert.equal(cfgOf('cp-sp-off').silentPrime, false);
  });

  it('rejects a non-boolean showLaunchModePicker', () => {
    const result = projects.createProject({
      name: 'cp-type', engine: 'claude', showLaunchModePicker: 'no'
    });
    assert.equal(result.project, null);
    assert.match(result.errors[0], /must be a boolean/);
  });

  describe('the wizard collects and sends it', () => {
    it('renders the toggle beside Launch Posture on step 2', () => {
      const step = UI_SRC.slice(UI_SRC.indexOf('let launchModeHtml'));
      assert.match(step.slice(0, 3000), /id="createShowLaunchPicker"/);
    });

    it('collects it in createNext', () => {
      const next = UI_SRC.slice(UI_SRC.indexOf('function createNext'));
      assert.match(next.slice(0, 1200), /createShowLaunchPicker[\s\S]*?createData\.showLaunchModePicker/);
    });

    describe('the POST body is built by a function a test can run', () => {
      const helpers = loadApiHelperGlobals();
      const claude = { id: 'claude', name: 'Claude Code', capabilities: { supportsSilentPrime: true }, launchModes: {} };
      const codex = { id: 'codex', name: 'Codex', capabilities: { supportsSilentPrime: false }, launchModes: {} };

      it('sends the launch posture the wizard collected', () => {
        const body = helpers.tcCreateProjectBody({
          name: 'p', engine: 'claude', defaultLaunchMode: 'plan',
          showLaunchModePicker: false, silentPrime: true, tags: 'a, b'
        }, [claude]);
        assert.equal(body.showLaunchModePicker, false);
        assert.equal(body.defaultLaunchMode, 'plan');
        // `Array.from`: the helper runs in a vm realm, so its array has that
        // realm's prototype and deepStrictEqual calls two identical lists unequal.
        assert.deepEqual(Array.from(body.tags), ['a', 'b']);
      });

      it('omits silentPrime for an engine that cannot honor it, whatever the wizard is holding', () => {
        // Toggle it on Claude, go Back, switch to Codex: the control is gone
        // from the screen but `createData` still holds `true`, and the server
        // now REFUSES that value — so posting it shows the operator a rejection
        // for a setting they cannot see.
        const body = helpers.tcCreateProjectBody({
          name: 'p', engine: 'codex', silentPrime: true, tags: ''
        }, [codex]);
        assert.equal('silentPrime' in body, false,
          'omitted, so the new project keeps the shipped default');
      });

      it('sends it where the engine does honor it', () => {
        const body = helpers.tcCreateProjectBody({
          name: 'p', engine: 'claude', silentPrime: false, tags: ''
        }, [claude]);
        assert.equal(body.silentPrime, false);
      });

      it('attaches the eyes-open confirmation only once one was actually given', () => {
        const without = helpers.tcCreateProjectBody({ name: 'p', engine: 'claude', tags: '' }, [claude]);
        assert.equal('confirmBypassHidden' in without, false);
        const withIt = helpers.tcCreateProjectBody({
          name: 'p', engine: 'claude', tags: '', confirmBypassHiddenFor: 'claude:bypassPermissions'
        }, [claude]);
        assert.equal(withIt.confirmBypassHidden, true);
      });
    });

    it('routes a warned hidden-picker creation through the same confirm the edit path uses', () => {
      // One modal for both paths. Two would drift, and the warning text IS the
      // guard — a create-only copy is the one most likely to go stale.
      const submit = UI_SRC.slice(UI_SRC.indexOf('async function submitCreate'));
      const head = submit.slice(0, 2500);
      assert.match(head, /openBypassHiddenModal\(/, 'the create path opens the shared confirm');
      assert.match(head, /modeConfig\.warning/, 'and only when the mode actually warns');
      assert.match(head, /confirmBypassHiddenFor = confirmedFor/,
        'the confirm records WHICH engine+mode was seen, not a sticky boolean');
      assert.match(head, /confirmedFor = `\$\{createData\.engine\}:\$\{mode\}`/,
        'keyed to the pair the warning belongs to — a failed create leaves the '
        + 'drawer open, and a latched boolean would wave a different warned mode through');
      // The confirm must be able to send something other than the settings
      // PATCH, or a create routed into it would silently PATCH a project.
      const confirm = UI_SRC.slice(UI_SRC.indexOf('async function confirmBypassHidden'));
      assert.match(confirm.slice(0, 600), /pendingBypassHiddenSubmit/,
        'the confirm resends to the caller that parked the body');
    });
  });
});
