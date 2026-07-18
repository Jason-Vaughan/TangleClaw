'use strict';

/*
 * Per-project launch-mode settings (Phase A settings retask): the structured
 * `defaultLaunchMode` + `showLaunchModePicker` project settings that replaced
 * the retired free-text mode-rules kind. Covers the config defaults, PATCH
 * validation (engine-key membership + the eyes-open bypass-hidden guard),
 * enrichment exposure, server-side default-mode resolution at launch, and the
 * frontend wiring pins (settings modal renderer, landing picker gate, confirm
 * modal markup).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('launch-mode settings', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-mode-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a claude-engine project and return its enriched record. */
  function mkProject(name) {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    store.projects.create({ name, path: projPath, engine: 'claude', methodology: 'minimal' });
    return store.projects.getByName(name);
  }

  describe('config defaults', () => {
    it('DEFAULT_PROJECT_CONFIG carries the safe defaults', () => {
      assert.equal(store.DEFAULT_PROJECT_CONFIG.defaultLaunchMode, 'default');
      assert.equal(store.DEFAULT_PROJECT_CONFIG.showLaunchModePicker, true);
    });

    it('enrichment exposes the defaults for a fresh project', () => {
      mkProject('lm-fresh');
      const enriched = projects.getProject('lm-fresh');
      assert.equal(enriched.defaultLaunchMode, 'default');
      assert.equal(enriched.showLaunchModePicker, true);
    });
  });

  describe('updateProject validation', () => {
    it('persists a valid mode key + picker toggle and enriches them', () => {
      mkProject('lm-valid');
      const result = projects.updateProject('lm-valid', { defaultLaunchMode: 'plan', showLaunchModePicker: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.defaultLaunchMode, 'plan');
      assert.equal(result.project.showLaunchModePicker, false);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.equal(projConfig.defaultLaunchMode, 'plan');
      assert.equal(projConfig.showLaunchModePicker, false);
    });

    it('rejects a non-boolean showLaunchModePicker', () => {
      mkProject('lm-badbool');
      const result = projects.updateProject('lm-badbool', { showLaunchModePicker: 'yes' });
      assert.equal(result.project, null);
      assert.match(result.errors[0], /showLaunchModePicker must be a boolean/);
    });

    it('rejects a mode key the engine does not define, listing the valid keys', () => {
      mkProject('lm-badkey');
      const result = projects.updateProject('lm-badkey', { defaultLaunchMode: 'yolo' });
      assert.equal(result.project, null);
      assert.match(result.errors[0], /not a launch mode of engine "claude"/);
      assert.match(result.errors[0], /bypassPermissions/);
    });

    it('rejects a disabled mode key (symmetric with the picker filter)', () => {
      mkProject('lm-disabled');
      const claude = store.engines.get('claude');
      const patched = {
        ...claude,
        launchModes: { ...claude.launchModes, plan: { ...claude.launchModes.plan, disabled: true } }
      };
      const originalGet = store.engines.get;
      store.engines.get = (id) => (id === 'claude' ? patched : originalGet.call(store.engines, id));
      try {
        const result = projects.updateProject('lm-disabled', { defaultLaunchMode: 'plan' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /disabled for engine "claude"/);
      } finally {
        store.engines.get = originalGet;
      }
    });

    it('rejects an empty or non-string mode', () => {
      mkProject('lm-empty');
      assert.match(projects.updateProject('lm-empty', { defaultLaunchMode: '  ' }).errors[0], /non-empty string/);
      assert.match(projects.updateProject('lm-empty', { defaultLaunchMode: 42 }).errors[0], /non-empty string/);
    });
  });

  describe('eyes-open bypass-hidden guard', () => {
    it('blocks hiding the picker with a warning-carrying default unless confirmed', () => {
      mkProject('lm-guard');
      const blocked = projects.updateProject('lm-guard', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false
      });
      assert.equal(blocked.project, null);
      assert.match(blocked.errors[0], /confirmBypassHidden/);

      const confirmed = projects.updateProject('lm-guard', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      assert.deepEqual(confirmed.errors, []);
      assert.equal(confirmed.project.defaultLaunchMode, 'bypassPermissions');
      assert.equal(confirmed.project.showLaunchModePicker, false);
    });

    it('fires when a single-field change creates the combination against stored state', () => {
      mkProject('lm-guard-split');
      // Step 1: bypass default with the picker still shown — no guard (the
      // picker still surfaces the warning at launch).
      const step1 = projects.updateProject('lm-guard-split', { defaultLaunchMode: 'bypassPermissions' });
      assert.deepEqual(step1.errors, []);
      // Step 2: hiding the picker now completes the combination — guard fires.
      const step2 = projects.updateProject('lm-guard-split', { showLaunchModePicker: false });
      assert.equal(step2.project, null);
      assert.match(step2.errors[0], /confirmBypassHidden/);
    });

    it('a stored confirmed combination never blocks unrelated updates', () => {
      mkProject('lm-guard-stored');
      projects.updateProject('lm-guard-stored', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      const unrelated = projects.updateProject('lm-guard-stored', { tags: ['later'] });
      assert.deepEqual(unrelated.errors, []);
      assert.deepEqual(unrelated.project.tags, ['later']);
    });

    it('does not fire for a warning-free default with the picker hidden', () => {
      mkProject('lm-no-warn');
      const result = projects.updateProject('lm-no-warn', {
        defaultLaunchMode: 'plan',
        showLaunchModePicker: false
      });
      assert.deepEqual(result.errors, []);
    });
  });

  describe('launch resolution (lib/sessions.js)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;
    let originalCreateSession;

    before(() => {
      sessions = require('../lib/sessions');
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
      originalCreateSession = tmux.createSession;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      tmux.hasSession = () => false;
      tmux.createSession = () => true;
    });

    after(() => {
      tmux.hasSession = originalHasSession;
      enginesModule.detectEngine = originalDetectEngine;
      tmux.createSession = originalCreateSession;
    });

    /** Launch, assert the recorded launchMode, then kill the session. */
    function launchAndReadMode(name, options) {
      const result = sessions.launchSession(name, options);
      assert.equal(result.error, null);
      const mode = result.session.launchMode;
      store.sessions.kill(result.session.id, 'test cleanup');
      return mode;
    }

    it('applies the configured default when the caller picks no mode', () => {
      const project = mkProject('lm-launch-default');
      const projConfig = store.projectConfig.load(project.path);
      projConfig.defaultLaunchMode = 'plan';
      store.projectConfig.save(project.path, projConfig);

      assert.equal(launchAndReadMode('lm-launch-default'), 'plan');
    });

    it('an explicit caller choice beats the configured default', () => {
      const project = mkProject('lm-launch-explicit');
      const projConfig = store.projectConfig.load(project.path);
      projConfig.defaultLaunchMode = 'plan';
      store.projectConfig.save(project.path, projConfig);

      assert.equal(launchAndReadMode('lm-launch-explicit', { launchMode: 'acceptEdits' }), 'acceptEdits');
    });

    it('ignores a configured mode the engine has disabled (falls back to engine default)', () => {
      const project = mkProject('lm-launch-disabled');
      const projConfig = store.projectConfig.load(project.path);
      projConfig.defaultLaunchMode = 'plan';
      store.projectConfig.save(project.path, projConfig);

      const claude = store.engines.get('claude');
      const patched = {
        ...claude,
        launchModes: { ...claude.launchModes, plan: { ...claude.launchModes.plan, disabled: true } }
      };
      const originalGet = store.engines.get;
      store.engines.get = (id) => (id === 'claude' ? patched : originalGet.call(store.engines, id));
      try {
        assert.equal(launchAndReadMode('lm-launch-disabled'), 'default');
      } finally {
        store.engines.get = originalGet;
      }
    });

    it('ignores a configured key the engine does not define (stale after engine switch)', () => {
      const project = mkProject('lm-launch-stale');
      const projConfig = store.projectConfig.load(project.path);
      projConfig.defaultLaunchMode = 'fullAuto'; // a codex key, not claude's
      store.projectConfig.save(project.path, projConfig);

      // Falls through to the engine profile's own default ('default').
      assert.equal(launchAndReadMode('lm-launch-stale'), 'default');
    });
  });

  describe('frontend wiring pins', () => {
    let html, landing, ui;

    before(() => {
      const pub = path.join(__dirname, '..', 'public');
      html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
      landing = fs.readFileSync(path.join(pub, 'landing.js'), 'utf8');
      ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    });

    it('settings modal renders the launch-mode section and re-renders on engine change', () => {
      assert.match(ui, /function renderLaunchModeSettings\(/);
      assert.match(ui, /settingsLaunchModeContainer/);
      assert.match(ui, /settingsDefaultLaunchMode/);
      assert.match(ui, /settingsShowLaunchPicker/);
    });

    it('save path routes the risky combination through the confirm modal', () => {
      assert.match(ui, /openBypassHiddenModal\(/);
      assert.match(ui, /confirmBypassHidden = true/);
      assert.match(html, /id="bypassHiddenModal"/);
      assert.match(html, /id="bypassHiddenConfirmBtn"/);
    });

    it('landing launch gate skips the picker when showLaunchModePicker is false', () => {
      assert.match(landing, /showLaunchModePicker === false/);
    });
  });
});
