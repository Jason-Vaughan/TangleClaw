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
const { liftDeclaration } = require('./helpers/lift');

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

/*
 * #1304 — Create opens Settings in its draft/setup step instead of
 * auto-launching, so Medusa/model/effort/Project Rules are reachable before
 * the first session boots. Real execution of the shipped functions, not
 * source-text matching: both halves (submitCreate's handoff, and the save
 * flow's launch-after-save) are behaviors a regex can't tell apart from a
 * plausible-looking but dead branch.
 */
describe('#1304 — Create opens Settings instead of auto-launching, with a Save & Launch path', () => {
  describe('submitCreate hands off to openSettings', () => {
    /**
     * Run the real submitCreate() with every dependency stubbed/recording.
     * @param {object} opts
     * @param {object} opts.createData - The createData object submitCreate reads.
     * @param {object|null} opts.apiResult - What the stubbed POST /api/projects resolves to.
     * @returns {{run: Function, calls: object}}
     */
    function buildSubmitCreateHarness({ createData, apiResult }) {
      const calls = { apiMutate: [], closeCreateModal: 0, loadProjects: 0, openSettings: [] };
      const documentStub = {
        getElementById: (id) => {
          if (id === 'createTags') return { value: createData.tags || '' };
          if (id === 'createSubmitBtn') return { disabled: false, innerHTML: '', textContent: '' };
          if (id === 'createError') return { textContent: '', classList: { remove: () => {} } };
          return null;
        }
      };
      const run = new Function(
        'document', 'createData', 'state', 'openBypassHiddenModal', 'apiMutate', 'tcCreateProjectBody',
        'api', 'showToast', 'closeCreateModal', 'loadProjects', 'openSettings',
        `${liftDeclaration(UI_SRC, 'async function submitCreate(')}\nreturn submitCreate;`
      )(
        documentStub,
        createData,
        { engines: [] },
        () => { throw new Error('must not open the bypass-hidden modal in this fixture'); },
        async (url, method, body) => { calls.apiMutate.push({ url, method, body }); return apiResult; },
        (data) => data, // the real tcCreateProjectBody has its own tests above; identity suffices here
        { lastError: null },
        () => {},
        () => { calls.closeCreateModal++; },
        async () => { calls.loadProjects++; },
        (name, options) => { calls.openSettings.push({ name, options }); }
      );
      return { run, calls };
    }

    it('opens Settings with offerLaunch:true on success, instead of launching directly', async () => {
      const { run, calls } = buildSubmitCreateHarness({
        createData: { name: 'new-proj', engine: 'claude', showLaunchModePicker: true, tags: '' },
        apiResult: { project: { id: 1, name: 'new-proj' } }
      });
      await run();
      assert.equal(calls.closeCreateModal, 1);
      assert.equal(calls.loadProjects, 1);
      assert.deepEqual(calls.openSettings, [{ name: 'new-proj', options: { offerLaunch: true } }]);
    });

    it('does not open Settings when creation fails', async () => {
      const { run, calls } = buildSubmitCreateHarness({
        createData: { name: 'new-proj', engine: 'claude', showLaunchModePicker: true, tags: '' },
        apiResult: null
      });
      await run();
      assert.equal(calls.openSettings.length, 0);
      assert.equal(calls.closeCreateModal, 0);
    });
  });

  describe('openSettings/closeSettings control the Save & Launch button', () => {
    /**
     * A fake classList recording every toggle() call.
     * @returns {{toggle: Function, calls: Array<{cls: string, force: boolean}>}}
     */
    function fakeClassList() {
      const calls = [];
      return {
        calls,
        toggle(cls, force) { calls.push({ op: 'toggle', cls, force }); },
        add(cls) { calls.push({ op: 'add', cls }); },
        remove(cls) { calls.push({ op: 'remove', cls }); }
      };
    }

    it('openSettings sets settingsOfferLaunch and shows/hides the button accordingly', () => {
      const btn = { classList: fakeClassList() };
      const documentStub = { getElementById: (id) => (id === 'settingsSaveLaunchBtn' ? btn : null) };
      // state.projects has no matching project, so openSettings returns right
      // after the #1304 lines -- the only ones under test here -- without
      // needing to stub the rest of the (large) form-rendering body.
      const src = `let settingsTarget = null;\nlet settingsOfferLaunch = false;\n${liftDeclaration(UI_SRC, 'function openSettings(')}\nreturn { openSettings, get settingsOfferLaunch() { return settingsOfferLaunch; } };`;
      const { openSettings } = new Function('document', 'state', src)(documentStub, { projects: [] });

      openSettings('draft-proj', { offerLaunch: true });
      assert.deepEqual(btn.classList.calls.at(-1), { op: 'toggle', cls: 'hidden', force: false });

      openSettings('other-proj');
      assert.deepEqual(btn.classList.calls.at(-1), { op: 'toggle', cls: 'hidden', force: true },
        'opening normally (no offerLaunch) must hide the button again');
    });

    it('closeSettings resets settingsOfferLaunch and re-hides the button', () => {
      const btn = { classList: fakeClassList() };
      const modal = { classList: fakeClassList() };
      const documentStub = {
        getElementById: (id) => {
          if (id === 'settingsSaveLaunchBtn') return btn;
          if (id === 'settingsModal') return modal;
          return null;
        }
      };
      const src = `let settingsTarget = 'draft-proj';\nlet settingsOfferLaunch = true;\nlet isolationOverrideReveal = false;\nlet projectRulesTargetId = 1;\nlet projectRulesTargetName = 'draft-proj';\n${liftDeclaration(UI_SRC, 'function closeSettings(')}\nreturn { closeSettings, get settingsOfferLaunch() { return settingsOfferLaunch; }, get settingsTarget() { return settingsTarget; } };`;
      // NOT destructured with spread: `...rest` reads a getter's value AT
      // SPREAD TIME, flattening it into a static property -- which would
      // capture the pre-closeSettings() value instead of reading it fresh
      // afterward.
      const result = new Function('document', src)(documentStub);
      result.closeSettings();
      assert.equal(result.settingsOfferLaunch, false);
      assert.equal(result.settingsTarget, null);
      assert.ok(btn.classList.calls.some((c) => c.op === 'add' && c.cls === 'hidden'),
        'closeSettings must add the hidden class back');
    });
  });

  describe('saveSettings(launchAfter) only launches when asked, and only after a successful save', () => {
    /**
     * Run the real _submitSettings(body, launchAfter) with every dependency stubbed.
     * @param {object} opts
     * @param {string} opts.target - The settingsTarget in scope when called.
     * @param {object|null} opts.apiResult - What the stubbed PATCH resolves to.
     * @returns {{run: Function, calls: object}}
     */
    function buildSubmitSettingsHarness({ target, apiResult }) {
      const calls = { closeSettings: 0, loadProjects: 0, launchProject: [] };
      const src = `let settingsTarget = ${JSON.stringify(target)};\n${liftDeclaration(UI_SRC, 'async function _submitSettings(')}\nreturn _submitSettings;`;
      const run = new Function(
        'document', 'apiMutate', 'api', 'closeSettings', 'renderSettingsWarnings', 'loadProjects', 'launchProject',
        src
      )(
        { getElementById: () => null },
        async (url, method, body) => apiResult,
        { lastError: null },
        () => { calls.closeSettings++; },
        () => {},
        async () => { calls.loadProjects++; },
        async (name) => { calls.launchProject.push(name); }
      );
      return { run, calls };
    }

    it('launches the project after a successful save when launchAfter is true', async () => {
      const { run, calls } = buildSubmitSettingsHarness({ target: 'my-proj', apiResult: { warnings: [] } });
      await run({ engine: 'claude' }, true);
      assert.deepEqual(calls.launchProject, ['my-proj']);
      assert.equal(calls.closeSettings, 1);
    });

    it('does not launch when launchAfter is false (plain Save)', async () => {
      const { run, calls } = buildSubmitSettingsHarness({ target: 'my-proj', apiResult: { warnings: [] } });
      await run({ engine: 'claude' }, false);
      assert.deepEqual(calls.launchProject, []);
      assert.equal(calls.closeSettings, 1, 'a plain save must still save and close');
    });

    it('does not launch when the save fails, even if launchAfter is true', async () => {
      const { run, calls } = buildSubmitSettingsHarness({ target: 'my-proj', apiResult: null });
      await run({ engine: 'claude' }, true);
      assert.deepEqual(calls.launchProject, []);
      assert.equal(calls.closeSettings, 0, 'the modal must stay open so the error is visible');
    });

    it('launches using the RENAMED name when the save included a rename', async () => {
      const { run, calls } = buildSubmitSettingsHarness({ target: 'old-name', apiResult: { warnings: [] } });
      await run({ engine: 'claude', name: 'new-name' }, true);
      assert.deepEqual(calls.launchProject, ['new-name']);
    });
  });

  describe('unarchiveProject surfaces the path-health refusal with a confirm-and-retry (#2401 Critic BLOCKING: no prior coverage of this branch)', () => {
    /**
     * Run the real unarchiveProject(name), with apiMutate answering each
     * call in order from `responses`.
     * @param {object} opts
     * @param {Array<{ok: boolean, data?: object, error?: string, code?: (string|null)}>} opts.responses
     * @param {boolean} [opts.confirmReturns] - What the stubbed confirm() answers.
     * @returns {{run: Function, calls: object}}
     */
    function buildUnarchiveHarness({ responses, confirmReturns }) {
      const calls = { apiMutate: [], loadProjects: 0, showToast: [], confirmAsked: [] };
      const api = { lastError: null, lastErrorCode: null };
      let callIndex = 0;
      const apiMutate = async (url, method, body) => {
        calls.apiMutate.push({ url, method, body });
        const resp = responses[callIndex++];
        if (resp.ok) {
          api.lastError = null;
          api.lastErrorCode = null;
          return resp.data;
        }
        api.lastError = resp.error;
        api.lastErrorCode = resp.code || null;
        return null;
      };
      const confirm = (message) => { calls.confirmAsked.push(message); return confirmReturns; };
      const run = new Function(
        'apiMutate', 'api', 'confirm', 'loadProjects', 'showToast',
        `${liftDeclaration(UI_SRC, 'async function unarchiveProject(')}\nreturn unarchiveProject;`
      )(
        apiMutate,
        api,
        confirm,
        async () => { calls.loadProjects++; },
        (message) => { calls.showToast.push(message); }
      );
      return { run, calls };
    }

    it('unarchives directly on success, with no confirm', async () => {
      const { run, calls } = buildUnarchiveHarness({ responses: [{ ok: true, data: { success: true } }] });
      await run('proj');
      assert.equal(calls.loadProjects, 1);
      assert.deepEqual(calls.confirmAsked, []);
      assert.equal(calls.apiMutate.length, 1);
    });

    it('asks to proceed as a fresh start on PROJECT_PATH_UNSEEDED, then retries and succeeds when confirmed', async () => {
      const { run, calls } = buildUnarchiveHarness({
        responses: [
          { ok: false, error: '"x" has no git history — it looks like an empty placeholder', code: 'PROJECT_PATH_UNSEEDED' },
          { ok: true, data: { success: true } }
        ],
        confirmReturns: true
      });
      await run('proj');
      assert.equal(calls.confirmAsked.length, 1);
      assert.match(calls.confirmAsked[0], /looks like an empty placeholder/);
      assert.equal(calls.apiMutate.length, 2, 'the refused call, then a retry');
      assert.deepEqual(calls.apiMutate[1].body, { confirmFreshStart: true });
      assert.equal(calls.loadProjects, 1);
    });

    it('asks on PROJECT_PATH_MISSING too, and does not retry when the operator declines', async () => {
      const { run, calls } = buildUnarchiveHarness({
        responses: [{ ok: false, error: 'the project folder no longer exists', code: 'PROJECT_PATH_MISSING' }],
        confirmReturns: false
      });
      await run('proj');
      assert.equal(calls.confirmAsked.length, 1);
      assert.equal(calls.apiMutate.length, 1, 'declining must not send the confirmFreshStart retry');
      assert.equal(calls.loadProjects, 0);
    });

    it('shows a toast for any other failure, without asking to confirm', async () => {
      const { run, calls } = buildUnarchiveHarness({
        responses: [{ ok: false, error: 'is not archived', code: null }]
      });
      await run('proj');
      assert.deepEqual(calls.confirmAsked, []);
      assert.equal(calls.loadProjects, 0);
      assert.deepEqual(calls.showToast, ['Could not unarchive "proj": is not archived']);
    });
  });
});
