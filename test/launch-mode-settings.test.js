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
const { standInCodex } = require('./_codex-launchable');

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

  /**
   * Create a project and return its record.
   * @param {string} name - Project name
   * @param {string} [engine] - Engine id; Claude when omitted
   * @returns {object}
   */
  function mkProject(name, engine = 'claude') {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    store.projects.create({ name, path: projPath, engine });
    // The config's engine is what the validators read first, so a project made
    // on another engine has to say so there as well as on its row.
    if (engine !== 'claude') {
      const cfg = store.projectConfig.load(projPath);
      cfg.engine = engine;
      store.projectConfig.save(projPath, cfg);
    }
    return store.projects.getByName(name);
  }

  describe('config defaults', () => {
    it('DEFAULT_PROJECT_CONFIG carries the safe defaults', () => {
      assert.equal(store.DEFAULT_PROJECT_CONFIG.defaultLaunchMode, 'default');
      assert.equal(store.DEFAULT_PROJECT_CONFIG.showLaunchModePicker, true);
    });

    it('enrichment exposes the defaults for a fresh project', async () => {
      mkProject('lm-fresh');
      const enriched = await projects.getProject('lm-fresh');
      assert.equal(enriched.defaultLaunchMode, 'default');
      assert.equal(enriched.showLaunchModePicker, true);
    });
  });

  describe('updateProject validation', () => {
    it('persists a valid mode key + picker toggle and enriches them', async () => {
      mkProject('lm-valid');
      const result = await projects.updateProject('lm-valid', { defaultLaunchMode: 'plan', showLaunchModePicker: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.defaultLaunchMode, 'plan');
      assert.equal(result.project.showLaunchModePicker, false);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.equal(projConfig.defaultLaunchMode, 'plan');
      assert.equal(projConfig.showLaunchModePicker, false);
    });

    it('rejects a non-boolean showLaunchModePicker', async () => {
      mkProject('lm-badbool');
      const result = await projects.updateProject('lm-badbool', { showLaunchModePicker: 'yes' });
      assert.equal(result.project, null);
      assert.match(result.errors[0], /showLaunchModePicker must be a boolean/);
    });

    it('rejects a mode key the engine does not define, listing the valid keys', async () => {
      mkProject('lm-badkey');
      const result = await projects.updateProject('lm-badkey', { defaultLaunchMode: 'yolo' });
      assert.equal(result.project, null);
      assert.match(result.errors[0], /not a launch mode of engine "claude"/);
      assert.match(result.errors[0], /bypassPermissions/);
    });

    it('rejects a disabled mode key (symmetric with the picker filter)', async () => {
      mkProject('lm-disabled');
      const claude = store.engines.get('claude');
      const patched = {
        ...claude,
        launchModes: { ...claude.launchModes, plan: { ...claude.launchModes.plan, disabled: true } }
      };
      const originalGet = store.engines.get;
      store.engines.get = (id) => (id === 'claude' ? patched : originalGet.call(store.engines, id));
      try {
        const result = await projects.updateProject('lm-disabled', { defaultLaunchMode: 'plan' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /disabled for engine "claude"/);
      } finally {
        store.engines.get = originalGet;
      }
    });

    it('rejects an empty or non-string mode', async () => {
      mkProject('lm-empty');
      assert.match((await projects.updateProject('lm-empty', { defaultLaunchMode: '  ' })).errors[0], /non-empty string/);
      assert.match((await projects.updateProject('lm-empty', { defaultLaunchMode: 42 })).errors[0], /non-empty string/);
    });
  });

  describe('eyes-open bypass-hidden guard', () => {
    it('blocks hiding the picker with a warning-carrying default unless confirmed', async () => {
      mkProject('lm-guard');
      const blocked = await projects.updateProject('lm-guard', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false
      });
      assert.equal(blocked.project, null);
      assert.match(blocked.errors[0], /confirmBypassHidden/);

      const confirmed = await projects.updateProject('lm-guard', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      assert.deepEqual(confirmed.errors, []);
      assert.equal(confirmed.project.defaultLaunchMode, 'bypassPermissions');
      assert.equal(confirmed.project.showLaunchModePicker, false);
    });

    it('fires when a single-field change creates the combination against stored state', async () => {
      mkProject('lm-guard-split');
      // Step 1: bypass default with the picker still shown — no guard (the
      // picker still surfaces the warning at launch).
      const step1 = await projects.updateProject('lm-guard-split', { defaultLaunchMode: 'bypassPermissions' });
      assert.deepEqual(step1.errors, []);
      // Step 2: hiding the picker now completes the combination — guard fires.
      const step2 = await projects.updateProject('lm-guard-split', { showLaunchModePicker: false });
      assert.equal(step2.project, null);
      assert.match(step2.errors[0], /confirmBypassHidden/);
    });

    it('a stored confirmed combination never blocks unrelated updates', async () => {
      mkProject('lm-guard-stored');
      await projects.updateProject('lm-guard-stored', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      const unrelated = await projects.updateProject('lm-guard-stored', { tags: ['later'] });
      assert.deepEqual(unrelated.errors, []);
      assert.deepEqual(unrelated.project.tags, ['later']);
    });

    it('does not fire for a warning-free default with the picker hidden', async () => {
      mkProject('lm-no-warn');
      const result = await projects.updateProject('lm-no-warn', {
        defaultLaunchMode: 'plan',
        showLaunchModePicker: false
      });
      assert.deepEqual(result.errors, []);
    });
  });

  describe('engine-switch reconciliation (#682 trigger, #622)', () => {
    it('resets a stored mode the new engine cannot honor to default', async () => {
      mkProject('lm-switch');
      // Claude honors bypassPermissions; aider does not (its only non-default
      // mode is yesAlways). This used to use codex, which gained a real bypass
      // mode in #731 — the contract is unchanged, the example had to move to an
      // engine where the mode is genuinely unhonorable.
      const set = await projects.updateProject('lm-switch', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      assert.deepEqual(set.errors, []);
      assert.equal(set.project.defaultLaunchMode, 'bypassPermissions');

      const switched = await projects.updateProject('lm-switch', { engine: 'aider' });
      assert.deepEqual(switched.errors.filter(e => /defaultLaunchMode|launch mode/i.test(e)), []);
      // The stranded mode is reconciled to the universally-valid default.
      const cfg = store.projectConfig.load(switched.project.path);
      assert.equal(cfg.defaultLaunchMode, 'default');
      assert.equal(switched.project.defaultLaunchMode, 'default');
    });

    // #2189 reversed what #731 recorded here. #731 kept a confirmed Bypass
    // across a switch to any engine that defines the key, and noted in passing
    // that the carried posture differs in blast radius. That difference is the
    // defect: the operator confirmed one engine's flag and got another's. A
    // launch mode is now a choice about one engine, so the three engines that
    // share the key are each pinned in the direction an operator would switch.
    for (const [from, to] of [['claude', 'codex'], ['codex', 'antigravity'], ['claude', 'antigravity'], ['antigravity', 'claude']]) {
      it(`resets Bypass on a switch from ${from} to ${to}, which defines the same key (#2189)`, async () => {
        const name = `lm-reset-${from}-${to}`;
        mkProject(name, from);
        const set = await projects.updateProject(name, {
          defaultLaunchMode: 'bypassPermissions',
          showLaunchModePicker: false,
          confirmBypassHidden: true
        });
        assert.deepEqual(set.errors, []);
        assert.equal(store.projectConfig.load(set.project.path).defaultLaunchMode, 'bypassPermissions');

        // Exactly what the session page's settings modal sends.
        const switched = await projects.updateProject(name, { engine: to });
        assert.deepEqual(switched.errors, []);
        assert.equal(switched.project.engine.id, to);
        assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'default',
          'the previous engine\'s Bypass must not become the new engine\'s default');
        assert.equal(switched.project.defaultLaunchMode, 'default');
        // The picker stays hidden, as the operator left it: over the
        // warning-free default there is nothing for it to hide.
        assert.equal(store.projectConfig.load(switched.project.path).showLaunchModePicker, false);
      });
    }

    it('says in the save response that the mode was reset, naming both engines (#2189)', async () => {
      mkProject('lm-reset-told', 'codex');
      await projects.updateProject('lm-reset-told', { defaultLaunchMode: 'bypassPermissions' });
      const switched = await projects.updateProject('lm-reset-told', { engine: 'antigravity' });
      const told = (switched.warnings || []).filter((w) => /launch mode/i.test(w));
      assert.equal(told.length, 1, `one sentence about the reset, got: ${JSON.stringify(switched.warnings)}`);
      assert.match(told[0], /reset to Interactive/);
      assert.match(told[0], /Bypass was chosen for Codex/);
      assert.match(told[0], /does not carry to Antigravity/);
    });

    it('reports the reset for the dashboard\'s request, which names the default alongside the engine (#2189)', async () => {
      // The settings modal resets its mode control when the engine dropdown
      // moves and then sends what the control shows: engine AND the default
      // mode, by name. The operator touched only the engine, so the answer to
      // that request must say the mode was reset, exactly as it does for a
      // request that leaves the mode out.
      mkProject('lm-reset-dashboard', 'codex');
      await projects.updateProject('lm-reset-dashboard', { defaultLaunchMode: 'bypassPermissions' });

      const switched = await projects.updateProject('lm-reset-dashboard', { engine: 'antigravity', defaultLaunchMode: 'default' });
      assert.deepEqual(switched.errors, []);
      assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'default');
      const told = (switched.warnings || []).filter((w) => /reset to Interactive/.test(w));
      assert.equal(told.length, 1, `the dashboard-shaped save must report the reset, got: ${JSON.stringify(switched.warnings)}`);
      assert.match(told[0], /Bypass was chosen for Codex/);
      assert.match(told[0], /does not carry to Antigravity/);

      // The engine-only request still reports it, once.
      mkProject('lm-reset-engine-only', 'codex');
      await projects.updateProject('lm-reset-engine-only', { defaultLaunchMode: 'bypassPermissions' });
      const bare = await projects.updateProject('lm-reset-engine-only', { engine: 'antigravity' });
      assert.equal((bare.warnings || []).filter((w) => /reset to Interactive/.test(w)).length, 1);
    });

    it('does not call a mode the request chose for the new engine a reset (#2189)', async () => {
      // Bypass named again for the new engine, or a different non-default mode:
      // both are choices, and "reset to Interactive" would be false of each.
      mkProject('lm-chosen-same-key', 'codex');
      await projects.updateProject('lm-chosen-same-key', { defaultLaunchMode: 'bypassPermissions' });
      const same = await projects.updateProject('lm-chosen-same-key', { engine: 'antigravity', defaultLaunchMode: 'bypassPermissions' });
      assert.deepEqual(same.errors, []);
      assert.equal(store.projectConfig.load(same.project.path).defaultLaunchMode, 'bypassPermissions');
      assert.deepEqual((same.warnings || []).filter((w) => /reset to/i.test(w)), []);

      mkProject('lm-chosen-other-key', 'codex');
      await projects.updateProject('lm-chosen-other-key', { defaultLaunchMode: 'bypassPermissions' });
      const other = await projects.updateProject('lm-chosen-other-key', { engine: 'antigravity', defaultLaunchMode: 'sandbox' });
      assert.equal(store.projectConfig.load(other.project.path).defaultLaunchMode, 'sandbox');
      assert.deepEqual((other.warnings || []).filter((w) => /reset to/i.test(w)), []);

      // And a project that was already on the default is told nothing even
      // when the request names the default.
      mkProject('lm-default-named');
      const quiet = await projects.updateProject('lm-default-named', { engine: 'codex', defaultLaunchMode: 'default' });
      assert.deepEqual((quiet.warnings || []).filter((w) => /reset to/i.test(w)), []);
    });

    it('resets a warning-free mode that both engines define: the rule is per engine, not per warning (#2189)', async () => {
      // The case that tells "reset every mode" from "reset only a warned one".
      // Claude and OpenClaw both define `plan`, and neither warns on it, so the
      // old keep-if-honored rule kept it and a warning-only rule would too.
      mkProject('lm-reset-warning-free');
      await projects.updateProject('lm-reset-warning-free', { defaultLaunchMode: 'plan' });
      const openclaw = store.engines.get('openclaw');
      assert.ok(openclaw.launchModes.plan && !openclaw.launchModes.plan.warning,
        'OpenClaw must define a warning-free plan mode, or this test separates nothing');
      const switched = await projects.updateProject('lm-reset-warning-free', { engine: 'openclaw' });
      assert.deepEqual(switched.errors, []);
      assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'default');
      assert.equal((switched.warnings || []).filter((w) => /launch mode/i.test(w)).length, 1);
    });

    it('says nothing about a reset when the project was already on the default mode (#2189)', async () => {
      mkProject('lm-reset-quiet');
      const switched = await projects.updateProject('lm-reset-quiet', { engine: 'codex' });
      assert.deepEqual((switched.warnings || []).filter((w) => /launch mode/i.test(w)), [],
        'a project already on the default mode is told nothing about a reset');
    });

    it('reports no reset for a project whose config records no mode at all (#2189)', async () => {
      // A hand-edited or older config can lack the key. It holds the default,
      // so an engine change resets nothing and must not say it did.
      const made = mkProject('lm-reset-nokey');
      const cfg = store.projectConfig.load(made.path);
      delete cfg.defaultLaunchMode;
      store.projectConfig.save(made.path, cfg);
      const switched = await projects.updateProject('lm-reset-nokey', { engine: 'codex' });
      assert.deepEqual(switched.errors, []);
      assert.deepEqual((switched.warnings || []).filter((w) => /launch mode/i.test(w)), []);
      assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'default');
    });

    it('keeps the mode when the engine sent is the one the project already has (#2189)', async () => {
      // The dashboard's settings modal sends `engine` on every save. A save that
      // names the current engine is not an engine change and must not cost the
      // operator a posture they confirmed.
      mkProject('lm-same-engine');
      await projects.updateProject('lm-same-engine', { defaultLaunchMode: 'bypassPermissions' });
      const saved = await projects.updateProject('lm-same-engine', { engine: 'claude', tags: ['x'] });
      assert.deepEqual(saved.errors, []);
      assert.equal(store.projectConfig.load(saved.project.path).defaultLaunchMode, 'bypassPermissions');
      assert.deepEqual((saved.warnings || []).filter((w) => /launch mode/i.test(w)), []);
    });

    it('takes a mode named in the same update as the choice for the new engine (#2189)', async () => {
      mkProject('lm-switch-named');
      await projects.updateProject('lm-switch-named', { defaultLaunchMode: 'bypassPermissions' });
      const switched = await projects.updateProject('lm-switch-named', { engine: 'codex', defaultLaunchMode: 'fullAuto' });
      assert.deepEqual(switched.errors, []);
      assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'fullAuto');
      assert.deepEqual((switched.warnings || []).filter((w) => /reset to/i.test(w)), [],
        'a mode the operator named was not reset, so no reset is reported');
    });

    it('refuses a named mode the new engine does not define, and switches nothing (#2189)', async () => {
      mkProject('lm-switch-bad-mode');
      await projects.updateProject('lm-switch-bad-mode', { defaultLaunchMode: 'bypassPermissions' });
      const refused = await projects.updateProject('lm-switch-bad-mode', { engine: 'codex', defaultLaunchMode: 'acceptEdits' });
      assert.equal(refused.project, null);
      assert.match(refused.errors.join(' '), /not a launch mode of engine "codex"/);
      const after = store.projects.getByName('lm-switch-bad-mode');
      assert.equal(after.engineId, 'claude', 'a refused update must not have changed the engine');
      assert.equal(store.projectConfig.load(after.path).defaultLaunchMode, 'bypassPermissions');
    });

    it('leaves a project on the default mode there across a switch', async () => {
      mkProject('lm-switch-keep');
      // 'default' is valid for every engine — a switch must not disturb it.
      const switched = await projects.updateProject('lm-switch-keep', { engine: 'codex' });
      assert.deepEqual(switched.errors, []);
      assert.equal(store.projectConfig.load(switched.project.path).defaultLaunchMode, 'default');
    });

    it('allows switching engine AND hiding the picker together when reconciliation makes it safe', async () => {
      mkProject('lm-switch-hide');
      await projects.updateProject('lm-switch-hide', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });
      // Switching to aider reconciles bypassPermissions -> default, so the
      // hidden picker no longer sits over a warning mode: the guard must not
      // block this switch-to-safe, and no re-confirm should be demanded.
      const result = await projects.updateProject('lm-switch-hide', {
        engine: 'aider',
        showLaunchModePicker: false
      });
      assert.deepEqual(result.errors.filter(e => /confirmBypassHidden/.test(e)), []);
      const cfg = store.projectConfig.load(result.project.path);
      assert.equal(cfg.defaultLaunchMode, 'default');
      assert.equal(cfg.showLaunchModePicker, false);
    });

    it('no longer asks for confirmation when the switch itself resets the warned mode (#2189)', async () => {
      // #731 pinned the opposite: with Bypass carried onto Codex, hiding the
      // picker in the same update put a warned posture behind no warning, so the
      // guard asked again and then KEPT Bypass. Now the switch resets the mode,
      // so there is no warned posture left to confirm, and asking would train
      // the operator to confirm a sentence that is no longer true.
      mkProject('lm-switch-hide-warned');
      await projects.updateProject('lm-switch-hide-warned', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });

      const switched = await projects.updateProject('lm-switch-hide-warned', {
        engine: 'codex',
        showLaunchModePicker: false
      });
      assert.deepEqual(switched.errors, []);
      const cfg = store.projectConfig.load(switched.project.path);
      assert.equal(cfg.defaultLaunchMode, 'default');
      assert.equal(cfg.showLaunchModePicker, false);
    });

    it('asks again when Bypass is NAMED for the new engine behind a hidden picker (#2189)', async () => {
      // The guard's own job survives the reset. Choosing Bypass for the new
      // engine is allowed, and behind a picker that is already hidden it needs
      // the confirmation the operator gave for the OLD engine to be given again:
      // the stored `showLaunchModePicker: false` must count, though this update
      // does not send it.
      mkProject('lm-switch-rechoose');
      await projects.updateProject('lm-switch-rechoose', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false,
        confirmBypassHidden: true
      });

      const blocked = await projects.updateProject('lm-switch-rechoose', {
        engine: 'antigravity',
        defaultLaunchMode: 'bypassPermissions'
      });
      assert.equal(blocked.project, null);
      assert.match(blocked.errors.join(' '), /confirmBypassHidden/);
      const untouched = store.projects.getByName('lm-switch-rechoose');
      assert.equal(untouched.engineId, 'claude', 'the refused update switched nothing');

      const confirmed = await projects.updateProject('lm-switch-rechoose', {
        engine: 'antigravity',
        defaultLaunchMode: 'bypassPermissions',
        confirmBypassHidden: true
      });
      assert.deepEqual(confirmed.errors, []);
      assert.equal(store.projectConfig.load(confirmed.project.path).defaultLaunchMode, 'bypassPermissions');
    });

    it('the reset is what the next launch runs: no bypass flag on the new engine (#2189)', async () => {
      // The reproduction in the issue, end to end: a Codex project on Bypass,
      // switched to Antigravity, used to launch `agy --dangerously-skip-permissions`.
      const sessions = require('../lib/sessions');
      mkProject('lm-reset-launch', 'codex');
      await projects.updateProject('lm-reset-launch', { defaultLaunchMode: 'bypassPermissions' });
      const switched = await projects.updateProject('lm-reset-launch', { engine: 'antigravity' });
      const stored = store.projectConfig.load(switched.project.path).defaultLaunchMode;
      const cmd = sessions._buildLaunchCommand(
        store.engines.get('antigravity'), store.projects.getByName('lm-reset-launch'), stored);
      assert.equal(cmd, 'agy');
    });
  });

  describe('launchModeAfterUpdate (#2189)', () => {
    const claude = () => store.engines.get('claude');
    const codex = () => store.engines.get('codex');
    const onClaude = { engineId: 'claude' };

    it('keeps the stored mode when the engine does not change', () => {
      assert.equal(projects.launchModeAfterUpdate({}, onClaude, { defaultLaunchMode: 'plan' }, claude()), 'plan');
      assert.equal(projects.launchModeAfterUpdate({ engine: 'claude' }, onClaude, { defaultLaunchMode: 'plan' }, claude()), 'plan');
    });

    it('returns default on an engine change with no mode named, whatever was stored', () => {
      for (const stored of ['bypassPermissions', 'plan', 'default', '', undefined]) {
        assert.equal(
          projects.launchModeAfterUpdate({ engine: 'codex' }, onClaude, { defaultLaunchMode: stored }, codex()),
          'default', `stored ${JSON.stringify(stored)}`);
      }
    });

    it('returns a named mode the new engine honors, and default for one it does not', () => {
      assert.equal(projects.launchModeAfterUpdate(
        { engine: 'codex', defaultLaunchMode: 'bypassPermissions' }, onClaude, { defaultLaunchMode: 'plan' }, codex()),
      'bypassPermissions');
      assert.equal(projects.launchModeAfterUpdate(
        { engine: 'codex', defaultLaunchMode: 'acceptEdits' }, onClaude, { defaultLaunchMode: 'plan' }, codex()),
      'default');
    });

    it('still reconciles a stored mode the current engine no longer honors', () => {
      assert.equal(projects.launchModeAfterUpdate({}, onClaude, { defaultLaunchMode: 'fullAuto' }, claude()), 'default');
    });
  });

  describe('write-path invariant — no path persists an unconfirmed dangerous posture', () => {
    it('create writes the safe defaults, never a hidden bypass posture', () => {
      const name = 'lm-create-safe';
      const projPath = path.join(projectsDir, name);
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name, path: projPath, engine: 'claude' });
      const cfg = store.projectConfig.load(projPath);
      assert.equal(cfg.defaultLaunchMode, 'default');
      assert.notEqual(cfg.showLaunchModePicker, false);
    });

    it('the guard still blocks claude bypass + hidden without confirm after hardening', async () => {
      mkProject('lm-still-guarded');
      const blocked = await projects.updateProject('lm-still-guarded', {
        defaultLaunchMode: 'bypassPermissions',
        showLaunchModePicker: false
      });
      assert.equal(blocked.project, null);
      assert.match(blocked.errors[0], /confirmBypassHidden/);
    });
  });

  describe('launch resolution (lib/sessions.js)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;
    let originalCreateSession;
    let restoreCodex;

    before(() => {
      sessions = require('../lib/sessions');
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
      originalCreateSession = tmux.createSession;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
      tmux.hasSession = () => false;
      tmux.createSession = () => true;
      // One of these launches overrides the engine to Codex, which launches only when its version answers (#2233).
      restoreCodex = standInCodex(require('../lib/startup-control-codex'));
    });

    after(() => {
      restoreCodex();
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

    it('does not apply the stored default to a launch that overrides the engine (#2189)', () => {
      // `engineOverride` runs a different CLI for one session. The stored mode
      // was chosen for the project's own engine, and Codex defines the same
      // `bypassPermissions` key with a wider meaning, so before this the
      // override launched Codex with its own bypass flag.
      const project = mkProject('lm-launch-override');
      const projConfig = store.projectConfig.load(project.path);
      projConfig.defaultLaunchMode = 'bypassPermissions';
      store.projectConfig.save(project.path, projConfig);

      assert.equal(launchAndReadMode('lm-launch-override', { engineOverride: 'codex' }), 'default');
      // The project's own engine still gets its stored default.
      assert.equal(launchAndReadMode('lm-launch-override'), 'bypassPermissions');
      // And a mode named with the override launch is the caller's choice.
      assert.equal(launchAndReadMode('lm-launch-override', { engineOverride: 'codex', launchMode: 'fullAuto' }), 'fullAuto');
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

    it('a rejected settings save keeps the modal open and surfaces the error', () => {
      // Anchor on the modal's own status element so the pin fails if
      // _submitSettings alone regresses to close-on-error (a bare
      // "Save failed" match would stay green via the OpenClaw modal's path).
      assert.match(ui, /getElementById\('projectRulesStatus'\)[\s\S]{0,200}Save failed: \$\{api\.lastError/);
    });
  });
});
