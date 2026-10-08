'use strict';

/*
 * A project's stored model for its next launch (#2188): the `model` field in
 * the project config, what a save accepts and refuses, what an engine change
 * does to it, and what the project and engine payloads report.
 *
 * Nothing here launches anything. The launch path does not read the field yet,
 * so these tests are about what is stored and what is said about it.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const engines = require('../lib/engines');
const engineModels = require('../lib/engine-models');
const { createServer } = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('project model selection — persistence (#2188)', () => {
  let tmpDir;
  let projectsDir;
  let codexHome;
  let savedCodexHome;
  let shippedCodex;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-select-'));
    projectsDir = path.join(tmpDir, 'projects');
    codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    // The roster reader finds the Codex CLI's model list through CODEX_HOME,
    // so the tests own that list and never read this machine's.
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    shippedCodex = store.engines.get('codex');
  });

  after(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeRoster(shippedCodex.models.offered);
    store.engines.save(shippedCodex);
  });

  /**
   * Write the Codex CLI's model list, fetched now.
   * @param {string[]} ids - The model ids the CLI lists.
   */
  function writeRoster(ids) {
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      fetched_at: new Date().toISOString(),
      models: ids.map((slug) => ({ slug, display_name: slug.toUpperCase() }))
    }));
  }

  /** Remove the Codex CLI's model list, so the roster cannot be read. */
  function removeRoster() {
    fs.rmSync(path.join(codexHome, 'models_cache.json'), { force: true });
  }

  /**
   * Create a project on an engine and return its row.
   * @param {string} name - Project name.
   * @param {string} [engine] - Engine id; Codex when omitted.
   * @returns {object}
   */
  function mkProject(name, engine = 'codex') {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    store.projects.create({ name, path: projPath, engine });
    const cfg = store.projectConfig.load(projPath);
    cfg.engine = engine;
    store.projectConfig.save(projPath, cfg);
    return store.projects.getByName(name);
  }

  /**
   * The model a project's config file holds.
   * @param {object} row - The project row.
   * @returns {*}
   */
  function onDisk(row) {
    return store.projectConfig.load(row.path).model;
  }

  const [SOL, LUNA] = ['gpt-5.6-sol', 'gpt-6-luna'];

  describe('the stored field', () => {
    it('defaults to null: no model selected, the engine runs its own default', async () => {
      assert.equal(store.DEFAULT_PROJECT_CONFIG.model, null);
      const row = mkProject('ms-fresh');
      assert.equal(onDisk(row), null);
      const read = await projects.getProject('ms-fresh');
      assert.equal(read.model, null);
      assert.equal(read.modelCheck, null, 'no model stored means nothing to check');
    });

    it('saves an offered model the CLI lists, to the config file and the payload', async () => {
      const row = mkProject('ms-save');
      const res = await projects.updateProject('ms-save', { model: LUNA });
      assert.deepEqual(res.errors, []);
      assert.equal(onDisk(row), LUNA);
      assert.equal(res.project.model, LUNA);
      assert.deepEqual(res.project.modelCheck, { ok: true });
    });

    it('says on the save that no launch uses the model yet, and says nothing of it on a clear', async () => {
      // The launch path does not read the field yet. Until it does, a save
      // that stores a model must not pass for one that took effect.
      mkProject('ms-interim');
      const set = await projects.updateProject('ms-interim', { model: SOL });
      assert.ok(set.warnings.includes(projects.MODEL_NOT_YET_LAUNCHED), JSON.stringify(set.warnings));
      assert.match(projects.MODEL_NOT_YET_LAUNCHED, /no launch passes it to the engine yet/);
      const cleared = await projects.updateProject('ms-interim', { model: null });
      assert.deepEqual(cleared.warnings, []);
      const viaEngine = await projects.updateProject('ms-interim', { engine: 'codex', model: LUNA });
      assert.ok(viaEngine.warnings.includes(projects.MODEL_NOT_YET_LAUNCHED));
    });

    it('null clears a stored model, and is accepted even when nothing can be confirmed', async () => {
      const row = mkProject('ms-clear');
      await projects.updateProject('ms-clear', { model: SOL });
      removeRoster();
      const res = await projects.updateProject('ms-clear', { model: null });
      assert.deepEqual(res.errors, []);
      assert.equal(onDisk(row), null);
      assert.equal(res.project.model, null);
    });

    it('is a launch-time-only setting that applies at the next launch', () => {
      const entry = projects.LAUNCH_TIME_ONLY_SETTINGS.find((s) => s.key === 'model');
      assert.ok(entry, 'model must be declared, or a save under a running session says nothing');
      assert.equal(entry.divergence, 'next-launch');
    });

    it('under a running session, a save does not claim the model applies to the next launch while no launch reads it', async () => {
      // The declared advice for this setting is "applies to the next launch".
      // That is not true yet, so the save says the one true thing and not both.
      const row = mkProject('ms-live');
      store.sessions.start({ projectId: row.id, engineId: 'codex' });
      const res = await projects.updateProject('ms-live', { model: LUNA, showLaunchModePicker: false });
      assert.ok(res.warnings.includes(projects.MODEL_NOT_YET_LAUNCHED), JSON.stringify(res.warnings));
      assert.deepEqual(res.warnings.filter((w) => /Model (is|and)|and Model/.test(w) && /next launch;/.test(w)), [],
        'no sentence may say the model applies to the next launch');
      assert.equal(res.warnings.filter((w) => /^Show launch mode picker is saved/.test(w)).length, 1,
        'a sibling setting changed in the same save is still reported');
    });

    it('is judged against the project row\'s engine when the config file names another', async () => {
      // project.json sits in the checkout; a branch switch can leave its
      // `engine` behind. The row is what launches and what the payload checks.
      const onClaude = mkProject('ms-diverged-claude', 'claude');
      const cfgA = store.projectConfig.load(onClaude.path);
      cfgA.engine = 'codex';
      store.projectConfig.save(onClaude.path, cfgA);
      const refusedSave = await projects.updateProject('ms-diverged-claude', { model: LUNA });
      assert.equal(refusedSave.project, null, 'a Codex model must not be stored on a project that launches Claude');
      assert.match(refusedSave.errors[0], /ENGINE_HAS_NO_MODELS/);
      assert.equal(onDisk(onClaude), null);

      const onCodex = mkProject('ms-diverged-codex', 'codex');
      const cfgB = store.projectConfig.load(onCodex.path);
      cfgB.engine = 'claude';
      store.projectConfig.save(onCodex.path, cfgB);
      const saved = await projects.updateProject('ms-diverged-codex', { model: LUNA });
      assert.deepEqual(saved.errors, []);
      assert.deepEqual(saved.project.modelCheck, { ok: true }, 'what was accepted is what the payload confirms');
    });
  });

  describe('what a save refuses', () => {
    /**
     * Assert a save was refused whole: an error carrying the code, and the
     * config file exactly as it was.
     * @param {string} name - Project name.
     * @param {object} updates - The PATCH body.
     * @param {RegExp} code - What the refusal must say.
     */
    async function refused(name, updates, code) {
      const row = store.projects.getByName(name);
      const beforeSave = fs.readFileSync(path.join(row.path, '.tangleclaw', 'project.json'), 'utf8');
      const res = await projects.updateProject(name, updates);
      assert.equal(res.project, null, `expected a refusal, got ${JSON.stringify(res.project && res.project.model)}`);
      assert.match(res.errors[0], code);
      assert.equal(fs.readFileSync(path.join(row.path, '.tangleclaw', 'project.json'), 'utf8'), beforeSave,
        'a refused save must leave the config file untouched');
      assert.equal(store.projects.getByName(name).engineId, row.engineId, 'and the engine where it was');
    }

    it('a value that is not a model id', async () => {
      mkProject('ms-malformed');
      const long = 'a'.repeat(101);
      for (const bad of ['gpt 6', 'gpt-6\'luna', 'x;rm', '$(id)', '-model', long, '']) {
        await refused('ms-malformed', { model: bad }, /MODEL_MALFORMED/);
      }
      for (const notText of [6, true, ['gpt-6-luna'], { id: 'gpt-6-luna' }]) {
        await refused('ms-malformed', { model: notText }, /model must be a model id or null/);
      }
    });

    it('a model that is not on the engine\'s allowlist, though the CLI lists it', async () => {
      mkProject('ms-not-offered');
      writeRoster([SOL, LUNA, 'gpt-reserve']);
      await refused('ms-not-offered', { model: 'gpt-reserve' }, /MODEL_NOT_OFFERED/);
    });

    it('an offered model the installed CLI does not list', async () => {
      mkProject('ms-unlisted');
      writeRoster([SOL]);
      await refused('ms-unlisted', { model: LUNA }, /MODEL_UNAVAILABLE/);
    });

    it('any model when the CLI\'s roster cannot be read: nothing unconfirmed is stored', async () => {
      mkProject('ms-no-roster');
      removeRoster();
      await refused('ms-no-roster', { model: LUNA }, /ROSTER_UNAVAILABLE/);
    });

    it('any model when the CLI\'s model list is too old to be called current, or dated in the future', async () => {
      mkProject('ms-stale-roster');
      const cache = path.join(codexHome, 'models_cache.json');
      const listing = (fetchedAt) => JSON.stringify({
        fetched_at: new Date(fetchedAt).toISOString(),
        models: [SOL, LUNA].map((slug) => ({ slug, display_name: slug }))
      });
      const maxAgeMs = shippedCodex.models.roster.maxAgeHours * 3600 * 1000;

      // Inside the bound the same list is accepted, so the refusals below are
      // about its age and nothing else.
      fs.writeFileSync(cache, listing(Date.now() - maxAgeMs + 3600 * 1000));
      const fresh = await projects.updateProject('ms-stale-roster', { model: SOL });
      assert.deepEqual(fresh.errors, []);

      fs.writeFileSync(cache, listing(Date.now() - maxAgeMs - 24 * 3600 * 1000));
      await refused('ms-stale-roster', { model: LUNA }, /ROSTER_UNAVAILABLE/);
      const stale = await projects.updateProject('ms-stale-roster', { model: LUNA });
      assert.match(stale.errors[0], /day\(s\) ago/);

      fs.writeFileSync(cache, listing(Date.now() + 24 * 3600 * 1000));
      await refused('ms-stale-roster', { model: LUNA }, /ROSTER_UNAVAILABLE/);
    });

    it('a model on an engine that offers none', async () => {
      mkProject('ms-claude', 'claude');
      await refused('ms-claude', { model: LUNA }, /ENGINE_HAS_NO_MODELS/);
    });

    it('a Codex model saved together with a switch to Antigravity, and nothing of the switch lands', async () => {
      mkProject('ms-cross');
      await refused('ms-cross', { engine: 'antigravity', model: LUNA }, /ENGINE_HAS_NO_MODELS/);
    });

    it('a model on an engine whose model settings are broken, never read as "offers none"', async () => {
      mkProject('ms-invalid-block');
      store.engines.save({ ...shippedCodex, models: { ...shippedCodex.models, flag: 'not a flag' } });
      await refused('ms-invalid-block', { model: LUNA }, /MODELS_BLOCK_INVALID/);
    });

    it('a model on a project bound to an orchestration profile, naming the profile', async () => {
      const row = mkProject('ms-bound');
      store.projects.update(row.id, { orchestration_profile: 'direct' });
      await refused('ms-bound', { model: LUNA }, /orchestration profile "direct"/);
    });
  });

  describe('orchestration profile and model are mutually exclusive', () => {
    it('refuses binding a profile to a project that has a model, naming the model', async () => {
      const row = mkProject('ms-bind-refused');
      await projects.updateProject('ms-bind-refused', { model: LUNA });
      assert.throws(
        () => store.projects.update(row.id, { orchestration_profile: 'direct' }),
        (err) => err.code === 'MODEL_SELECTED' && err.message.includes(LUNA) && err.message.includes('direct')
      );
      assert.equal(store.projects.get(row.id).orchestrationProfile, null, 'the binding was not written');
      assert.equal(onDisk(row), LUNA, 'and the model was not dropped to make room for it');
    });

    it('allows the binding once the model is cleared, and unbinding at any time', async () => {
      const row = mkProject('ms-bind-ok');
      await projects.updateProject('ms-bind-ok', { model: LUNA });
      await projects.updateProject('ms-bind-ok', { model: null });
      store.projects.update(row.id, { orchestration_profile: 'direct' });
      assert.equal(store.projects.get(row.id).orchestrationProfile, 'direct');
      store.projects.update(row.id, { orchestration_profile: null });
      assert.equal(store.projects.get(row.id).orchestrationProfile, null);
    });

    it('a bound project can still clear a model a hand edit left behind', async () => {
      const row = mkProject('ms-bound-clear');
      store.projects.update(row.id, { orchestration_profile: 'direct' });
      const cfg = store.projectConfig.load(row.path);
      cfg.model = LUNA;
      store.projectConfig.save(row.path, cfg);
      const res = await projects.updateProject('ms-bound-clear', { model: null });
      assert.deepEqual(res.errors, []);
      assert.equal(onDisk(row), null);
    });
  });

  describe('an engine change', () => {
    it('clears the model and says so, naming the model and both engines', async () => {
      const row = mkProject('ms-switch');
      await projects.updateProject('ms-switch', { model: LUNA });
      const res = await projects.updateProject('ms-switch', { engine: 'antigravity' });
      assert.deepEqual(res.errors, []);
      assert.equal(res.project.engine.id, 'antigravity');
      assert.equal(onDisk(row), null, 'a Codex model must not ride onto another engine');
      assert.equal(res.project.model, null);
      const told = res.warnings.filter((w) => /^Model is reset/.test(w));
      assert.equal(told.length, 1, JSON.stringify(res.warnings));
      assert.match(told[0], new RegExp(`${LUNA} was chosen for Codex`));
      assert.match(told[0], /does not carry to Antigravity/);
      assert.match(told[0], /Antigravity offers no model selection/);
    });

    it('resets a non-default launch mode and a model together: both said, one write of the config', async () => {
      const row = mkProject('ms-switch-both');
      await projects.updateProject('ms-switch-both', { defaultLaunchMode: 'bypassPermissions', model: LUNA });
      assert.equal(store.projectConfig.load(row.path).defaultLaunchMode, 'bypassPermissions');
      assert.equal(onDisk(row), LUNA);

      const realSave = store.projectConfig.save;
      const written = [];
      store.projectConfig.save = function counted(projectPath, cfg) {
        if (projectPath === row.path) written.push({ engine: cfg.engine, mode: cfg.defaultLaunchMode, model: cfg.model });
        return realSave.call(this, projectPath, cfg);
      };
      let res;
      try {
        res = await projects.updateProject('ms-switch-both', { engine: 'antigravity' });
      } finally {
        store.projectConfig.save = realSave;
      }
      assert.deepEqual(res.errors, []);
      // The engine, the mode and the model land in one write, so no reader of
      // the file ever sees the new engine beside the old engine's choices.
      assert.deepEqual(written, [{ engine: 'antigravity', mode: 'default', model: null }]);
      assert.equal(res.warnings.filter((w) => /^Default launch mode is reset/.test(w)).length, 1, JSON.stringify(res.warnings));
      assert.equal(res.warnings.filter((w) => /^Model is reset/.test(w)).length, 1, JSON.stringify(res.warnings));
      assert.equal(res.warnings.length, 2, 'the two resets and nothing else');
      assert.equal(res.project.defaultLaunchMode, 'default');
      assert.equal(res.project.model, null);
      assert.equal(res.project.modelCheck, null);
    });

    it('reports the clear for a request that names the engine and null together', async () => {
      // A settings form resets its model control when the engine moves and
      // then sends what the control shows. The operator touched the engine
      // only, so that request must be told about the clear as well.
      const row = mkProject('ms-switch-null');
      await projects.updateProject('ms-switch-null', { model: SOL });
      const res = await projects.updateProject('ms-switch-null', { engine: 'claude', model: null });
      assert.equal(onDisk(row), null);
      assert.equal(res.warnings.filter((w) => /^Model is reset/.test(w)).length, 1, JSON.stringify(res.warnings));
    });

    it('says nothing about a model when none was held', async () => {
      mkProject('ms-switch-none');
      const res = await projects.updateProject('ms-switch-none', { engine: 'antigravity' });
      assert.deepEqual(res.warnings.filter((w) => /model/i.test(w) && !/launch mode/i.test(w)), []);
    });

    it('keeps a model the same request supplies for the new engine, with no reset reported', async () => {
      const row = mkProject('ms-switch-with', 'claude');
      const res = await projects.updateProject('ms-switch-with', { engine: 'codex', model: SOL });
      assert.deepEqual(res.errors, []);
      assert.equal(res.project.engine.id, 'codex');
      assert.equal(onDisk(row), SOL);
      assert.deepEqual(res.warnings.filter((w) => /^Model is reset/.test(w)), []);
    });

    it('tells the operator when the new engine\'s model settings are broken', async () => {
      const row = mkProject('ms-switch-broken', 'claude');
      const cfg = store.projectConfig.load(row.path);
      cfg.model = 'left-by-hand';
      store.projectConfig.save(row.path, cfg);
      store.engines.save({ ...shippedCodex, models: { flag: '--model' } });
      const res = await projects.updateProject('ms-switch-broken', { engine: 'codex' });
      const told = res.warnings.filter((w) => /^Model is reset/.test(w));
      assert.equal(told.length, 1, JSON.stringify(res.warnings));
      assert.match(told[0], /Codex's model settings are invalid/);
    });

    it('a save that leaves the engine alone leaves the model alone', async () => {
      const row = mkProject('ms-untouched');
      await projects.updateProject('ms-untouched', { model: LUNA });
      const res = await projects.updateProject('ms-untouched', { engine: 'codex', tags: ['a'] });
      assert.deepEqual(res.errors, []);
      assert.equal(onDisk(row), LUNA);
      assert.deepEqual(res.warnings, []);
    });
  });

  describe('a stored model is never dropped silently', () => {
    /**
     * A Codex project holding LUNA, saved while it was selectable.
     * @param {string} name - Project name.
     * @returns {Promise<object>} The project row.
     */
    async function holding(name) {
      const row = mkProject(name);
      const res = await projects.updateProject(name, { model: LUNA });
      assert.deepEqual(res.errors, []);
      return row;
    }

    // Each row is a way the engine can stop being able to confirm the model
    // after it was stored, with the refusal the payload must then carry.
    const WENT_AWAY = [
      ['the roster cannot be read', () => removeRoster(), 'ROSTER_UNAVAILABLE'],
      ['the CLI no longer lists it', () => writeRoster([SOL]), 'MODEL_UNAVAILABLE'],
      ['it left the allowlist', () => store.engines.save({ ...shippedCodex, models: { ...shippedCodex.models, offered: [SOL] } }), 'MODEL_NOT_OFFERED'],
      ['the models block became invalid', () => store.engines.save({ ...shippedCodex, models: { ...shippedCodex.models, offered: [] } }), 'MODELS_BLOCK_INVALID'],
      ['the models block was set to null', () => store.engines.save({ ...shippedCodex, models: null }), 'ENGINE_HAS_NO_MODELS'],
      ['the models block was removed', () => { const { models: _gone, ...rest } = shippedCodex; store.engines.save(rest); }, 'ENGINE_HAS_NO_MODELS']
    ];

    for (const [what, breakIt, code] of WENT_AWAY) {
      it(`when ${what}: still stored, reported with ${code} and a reason`, async () => {
        const name = `ms-kept-${code.toLowerCase()}-${WENT_AWAY.findIndex((r) => r[0] === what)}`;
        const row = await holding(name);
        breakIt();

        const read = await projects.getProject(name);
        assert.equal(read.model, LUNA, 'the payload still names the stored model');
        assert.equal(read.modelCheck.ok, false);
        assert.equal(read.modelCheck.code, code);
        assert.ok(read.modelCheck.reason && typeof read.modelCheck.reason === 'string');

        // An unrelated save, carrying the model at its stored value as a
        // settings form does, neither fails nor clears it.
        const saved = await projects.updateProject(name, { tags: ['kept'], model: LUNA, engine: 'codex' });
        assert.deepEqual(saved.errors, [], 'a field the operator did not touch must not fail the save');
        assert.equal(onDisk(row), LUNA);
        assert.equal(saved.project.modelCheck.code, code);
      });
    }

    it('a list of projects reports each stored model, reading the roster once per engine and model', async () => {
      await holding('ms-list-a');
      await holding('ms-list-b');
      const realRead = fs.readFileSync;
      let rosterReads = 0;
      fs.readFileSync = function counted(file, ...rest) {
        if (String(file).endsWith('models_cache.json')) rosterReads++;
        return realRead.call(this, file, ...rest);
      };
      let listed;
      try {
        listed = await projects.listProjects();
      } finally {
        fs.readFileSync = realRead;
      }
      const mine = listed.filter((p) => p.name === 'ms-list-a' || p.name === 'ms-list-b');
      assert.deepEqual(mine.map((p) => p.model), [LUNA, LUNA]);
      assert.ok(mine.every((p) => p.modelCheck && p.modelCheck.ok === true));
      const holders = listed.filter((p) => p.model === LUNA && p.engine && p.engine.id === 'codex').length;
      assert.ok(holders >= 2);
      assert.equal(rosterReads, new Set(listed.filter((p) => typeof p.model === 'string')
        .map((p) => `${p.engine && p.engine.id}\n${p.model}`)).size,
      'one roster read per distinct engine and model in the list, not one per project');
    });

    it('shows a hand-edited value that is not text as what is stored, never as no selection', async () => {
      for (const [i, raw, shown] of [[0, 42, '42'], [1, { id: LUNA }, `{"id":"${LUNA}"}`], [2, [LUNA], `["${LUNA}"]`], [3, true, 'true']]) {
        const row = mkProject(`ms-hand-edit-${i}`);
        const cfg = store.projectConfig.load(row.path);
        cfg.model = raw;
        store.projectConfig.save(row.path, cfg);
        const read = await projects.getProject(`ms-hand-edit-${i}`);
        assert.equal(read.model, shown, 'the payload shows the stored value');
        assert.notEqual(read.model, null);
        assert.equal(read.modelCheck.ok, false);
        assert.equal(read.modelCheck.code, 'MODEL_MALFORMED');
        assert.equal(read.modelCheck.stored, shown);
        assert.ok(read.modelCheck.reason.includes(shown));
      }
    });

    it('bounds how much of a hand-edited value it repeats', () => {
      const report = projects.storedModelReport({ model: { junk: 'x'.repeat(5000) } }, shippedCodex);
      assert.equal(report.model.length, 120);
      assert.ok(report.model.endsWith('...'));
      assert.equal(report.modelCheck.stored, report.model);
    });

    describe('a config that cannot be read is not a config with no model', () => {
      /**
       * A Codex project holding LUNA whose config file is then replaced.
       * @param {string} name - Project name.
       * @param {(file: string, row: object) => void} damage - What happens to the file.
       * @returns {Promise<object>} The project as read afterwards.
       */
      async function readAfter(name, damage) {
        const row = await holding(name);
        damage(path.join(row.path, '.tangleclaw', 'project.json'), row);
        return projects.getProject(name);
      }

      it('a config that will not parse: unknown, reported with PROJECT_CONFIG_UNREADABLE and why', async () => {
        const read = await readAfter('ms-cfg-corrupt', (file) => fs.writeFileSync(file, '{ "engine": "codex", "model": '));
        assert.equal(read.model, null);
        assert.ok(read.modelCheck, 'a failed read must not look like "no model stored"');
        assert.equal(read.modelCheck.ok, false);
        assert.equal(read.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        assert.match(read.modelCheck.reason, /project\.json/);
        assert.match(read.modelCheck.reason, /unknown/);
      });

      it('a config file that may not be read: the same report', async (t) => {
        if (process.getuid && process.getuid() === 0) return t.skip('root reads any file');
        let locked;
        try {
          const read = await readAfter('ms-cfg-noread', (file) => { locked = file; fs.chmodSync(file, 0o000); });
          assert.equal(read.model, null);
          assert.equal(read.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        } finally {
          if (locked) fs.chmodSync(locked, 0o600);
        }
      });

      it('a config directory that may not be searched is a failed read, not a missing file', async (t) => {
        if (process.getuid && process.getuid() === 0) return t.skip('root searches any directory');
        let locked;
        try {
          const read = await readAfter('ms-cfg-dir-locked', (file) => { locked = path.dirname(file); fs.chmodSync(locked, 0o000); });
          assert.equal(read.model, null);
          assert.ok(read.modelCheck, 'a file that exists and may hold a model must not read as no model');
          assert.equal(read.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        } finally {
          if (locked) fs.chmodSync(locked, 0o700);
        }
      });

      it('valid JSON that is not an object is a config that could not be used', async () => {
        for (const [i, text] of [[0, '[]'], [1, '42'], [2, '"gpt-6-luna"'], [3, 'null']]) {
          const read = await readAfter(`ms-cfg-not-object-${i}`, (file) => fs.writeFileSync(file, text));
          assert.equal(read.model, null);
          assert.equal(read.modelCheck && read.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE', `root ${text}`);
        }
      });

      it('a list of projects reports it too, and still reports its neighbours', async () => {
        await readAfter('ms-cfg-corrupt-list', (file) => fs.writeFileSync(file, 'not json'));
        await holding('ms-cfg-good-list');
        const listed = await projects.listProjects();
        const bad = listed.find((p) => p.name === 'ms-cfg-corrupt-list');
        assert.equal(bad.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        const good = listed.find((p) => p.name === 'ms-cfg-good-list');
        assert.equal(good.model, LUNA);
        assert.deepEqual(good.modelCheck, { ok: true });
      });

      it('a config file that is not there is absent, not unreadable: no model, nothing to report', async () => {
        const read = await readAfter('ms-cfg-absent', (file) => fs.rmSync(file));
        assert.equal(read.model, null);
        assert.equal(read.modelCheck, null);
      });

      it('a project whose directory is gone has no config and so no model', async () => {
        const read = await readAfter('ms-dir-gone', (file, row) => fs.rmSync(row.path, { recursive: true, force: true }));
        assert.equal(read.model, null);
        assert.equal(read.modelCheck, null);
      });

      it('configUnreadableReason tells the three cases apart', () => {
        assert.equal(projects.configUnreadableReason({ exists: true, config: {}, configError: null, unreadable: null }), null);
        assert.equal(projects.configUnreadableReason({ exists: false, config: null, unreadable: null }), null);
        assert.match(projects.configUnreadableReason({ exists: true, config: {}, configError: 'Unexpected end of JSON input' }), /project\.json: Unexpected end/);
        assert.equal(projects.configUnreadableReason({ exists: false, config: null, unreadable: 'the directory did not respond' }), 'the directory did not respond');
        assert.equal(projects.configUnreadableReason(null), null);
      });

      it('a directory that would not answer is reported as unknown, whatever defaults stand in for its config', () => {
        const report = projects.storedModelReport(null, shippedCodex, undefined, 'the directory did not respond');
        assert.equal(report.model, null);
        assert.equal(report.modelCheck.code, 'PROJECT_CONFIG_UNREADABLE');
        assert.match(report.modelCheck.reason, /the directory did not respond/);
      });
    });
  });

  describe('what a UI is given about an engine', () => {
    /**
     * One engine from the selector's list.
     * @param {string} id - Engine id.
     * @returns {object}
     */
    function listed(id) {
      return engines.listWithAvailability({ models: true }).find((e) => e.id === id);
    }

    it('an engine that offers models: state ok, each offered model with its availability', () => {
      writeRoster([SOL]);
      const codex = listed('codex');
      assert.deepEqual(codex.modelSelection, { declared: 'present', state: 'ok', errors: [] });
      assert.deepEqual(codex.models.map((m) => [m.id, m.available]), [[SOL, true], [LUNA, false]]);
      assert.ok(codex.models[1].reason, 'an unavailable model carries its reason');
    });

    it('an unreadable roster lists every offered model as unavailable with the reason, not an empty list', () => {
      removeRoster();
      const codex = listed('codex');
      assert.equal(codex.modelSelection.state, 'ok');
      assert.deepEqual(codex.models.map((m) => m.available), [false, false]);
      assert.ok(codex.models.every((m) => /Cannot be confirmed/.test(m.reason)));
    });

    it('tells an absent models block from one set to null, which read alike as "none"', () => {
      assert.deepEqual(listed('claude').modelSelection, { declared: 'absent', state: 'none', errors: [] });
      store.engines.save({ ...shippedCodex, models: null });
      const codex = listed('codex');
      assert.deepEqual(codex.modelSelection, { declared: 'null', state: 'none', errors: [] });
      assert.deepEqual(codex.models, []);
    });

    it('a broken models block is invalid with its errors, never "none"', () => {
      store.engines.save({ ...shippedCodex, models: { ...shippedCodex.models, flag: 'nope' } });
      const codex = listed('codex');
      assert.equal(codex.modelSelection.declared, 'present');
      assert.equal(codex.modelSelection.state, 'invalid');
      assert.ok(codex.modelSelection.errors.length > 0);
      assert.deepEqual(codex.models, []);
    });

    it('the three states are the only ones, and every engine reports one', () => {
      for (const e of engines.listWithAvailability({ models: true })) {
        assert.ok(['none', 'invalid', 'ok'].includes(e.modelSelection.state), `${e.id}: ${e.modelSelection.state}`);
        assert.ok(['absent', 'null', 'present'].includes(e.modelSelection.declared), e.id);
        assert.ok(Array.isArray(e.models), `${e.id} must carry a models list, empty or not`);
      }
    });

    it('a project\'s own engine carries the state but not the roster-backed list', async () => {
      mkProject('ms-engine-shape');
      const read = await projects.getProject('ms-engine-shape');
      assert.deepEqual(read.engine.modelSelection, { declared: 'present', state: 'ok', errors: [] });
      assert.equal(Object.prototype.hasOwnProperty.call(read.engine, 'models'), false,
        'the list costs a roster read; a polled project payload must not pay it per project');
    });

    it('a list built for a gate reads no roster', () => {
      const realRead = fs.readFileSync;
      let rosterReads = 0;
      fs.readFileSync = function counted(file, ...rest) {
        if (String(file).endsWith('models_cache.json')) rosterReads++;
        return realRead.call(this, file, ...rest);
      };
      try {
        const plain = engines.listWithAvailability();
        assert.equal(Object.prototype.hasOwnProperty.call(plain.find((e) => e.id === 'codex'), 'models'), false);
      } finally {
        fs.readFileSync = realRead;
      }
      assert.equal(rosterReads, 0);
    });

    it('blockDeclaration reads a profile\'s own spelling', () => {
      assert.equal(engineModels.blockDeclaration(null), 'absent');
      assert.equal(engineModels.blockDeclaration({}), 'absent');
      assert.equal(engineModels.blockDeclaration({ models: undefined }), 'absent');
      assert.equal(engineModels.blockDeclaration({ models: null }), 'null');
      assert.equal(engineModels.blockDeclaration({ models: {} }), 'present');
      assert.equal(engineModels.blockDeclaration({ models: 'x' }), 'present');
    });
  });

  describe('over HTTP', () => {
    let server;
    let port;

    before(async () => {
      server = createServer();
      await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    /**
     * Make a JSON request to the test server.
     * @param {string} method - HTTP method.
     * @param {string} urlPath - URL path.
     * @param {object} [body] - Request body.
     * @param {Record<string, string>} [headers] - Which caller the request plays.
     * @returns {Promise<{status: number, data: object}>}
     */
    function request(method, urlPath, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: urlPath, method, agent: false,
          headers: { 'Content-Type': 'application/json', ...headers }
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let data;
            try { data = JSON.parse(raw); } catch { data = raw; }
            resolve({ status: res.statusCode, data });
          });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    }

    it('GET /api/engines gives each engine its model-selection state and offered models', async () => {
      const { status, data } = await request('GET', '/api/engines');
      assert.equal(status, 200);
      const codex = data.engines.find((e) => e.id === 'codex');
      assert.equal(codex.modelSelection.state, 'ok');
      assert.deepEqual(codex.models.map((m) => m.id), [SOL, LUNA]);
      assert.ok(codex.models.every((m) => m.available === true && m.reason === null));
      const claude = data.engines.find((e) => e.id === 'claude');
      assert.deepEqual(claude.modelSelection, { declared: 'absent', state: 'none', errors: [] });
      assert.deepEqual(claude.models, []);
    });

    it('PATCH saves a model and answers with it; a refused one is a 400 carrying the reason and code', async () => {
      const row = mkProject('ms-http');
      // A project's settings are changed by the operator or the project's own
      // session; this plays the operator's dashboard.
      const asOperator = operatorHeaders(server);
      const ok = await request('PATCH', '/api/projects/ms-http', { model: LUNA }, asOperator);
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.model, LUNA);
      assert.deepEqual(ok.data.modelCheck, { ok: true });

      const bad = await request('PATCH', '/api/projects/ms-http', { model: 'gpt-reserve' }, asOperator);
      assert.equal(bad.status, 400);
      assert.match(JSON.stringify(bad.data), /MODEL_NOT_OFFERED/);
      assert.equal(onDisk(row), LUNA, 'the refused save changed nothing');

      const read = await request('GET', '/api/projects/ms-http', undefined, asOperator);
      assert.equal(read.status, 200);
      assert.equal(read.data.model, LUNA);
      assert.deepEqual(read.data.modelCheck, { ok: true });
    });
  });
});
