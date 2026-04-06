'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

// Suppress log output during tests
setLevel('error');

const store = require('../lib/store');

describe('store', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-'));
    store._setBasePath(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should create directory structure', () => {
      store.init();

      assert.ok(fs.existsSync(path.join(tmpDir, 'engines')), 'engines dir should exist');
      assert.ok(fs.existsSync(path.join(tmpDir, 'templates')), 'templates dir should exist');
      assert.ok(fs.existsSync(path.join(tmpDir, 'logs')), 'logs dir should exist');
    });

    it('should create default config.json if missing', () => {
      store.init();

      const configPath = path.join(tmpDir, 'config.json');
      assert.ok(fs.existsSync(configPath), 'config.json should exist');

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.serverPort, 3101);
      assert.equal(config.defaultEngine, 'claude');
    });

    it('should not overwrite existing config.json', () => {
      const configPath = path.join(tmpDir, 'config.json');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ serverPort: 9999 }));

      store.init();

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.serverPort, 9999);
    });

    it('should create SQLite database with all tables', () => {
      store.init();

      assert.ok(fs.existsSync(path.join(tmpDir, 'tangleclaw.db')), 'SQLite db should exist');

      const db = store.getDb();
      assert.ok(db, 'Database should be available');

      // Verify tables exist
      const tables = ['schema_version', 'projects', 'sessions', 'learnings', 'activity_log', 'port_leases', 'project_groups', 'project_group_members', 'shared_documents', 'document_locks'];
      for (const table of tables) {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        assert.ok(row, `Table "${table}" should exist`);
      }
    });

    it('should seed schema version', () => {
      store.init();

      const db = store.getDb();
      const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(row.version, 12);
    });

    it('should copy bundled engine profiles', () => {
      store.init();

      const engines = fs.readdirSync(path.join(tmpDir, 'engines'));
      assert.ok(engines.includes('claude.json'), 'Should have claude profile');
      assert.ok(engines.includes('codex.json'), 'Should have codex profile');
      assert.ok(engines.includes('aider.json'), 'Should have aider profile');
      assert.ok(engines.includes('genesis.json'), 'Should have genesis profile');
    });

    it('should copy bundled methodology templates', () => {
      store.init();

      const templateFile = path.join(tmpDir, 'templates', 'minimal', 'template.json');
      assert.ok(fs.existsSync(templateFile), 'Should have minimal template');
    });

    it('should not overwrite existing engine profiles', () => {
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      fs.writeFileSync(path.join(enginesDir, 'custom.json'), JSON.stringify({ id: 'custom' }));

      store.init();

      // Custom engine should still exist, bundled should NOT have been copied
      const engines = fs.readdirSync(enginesDir);
      assert.ok(engines.includes('custom.json'), 'Custom engine should remain');
    });

    it('should merge new bundled fields into existing engine profiles', () => {
      // Simulate an older codex.json that's missing launch.preKeys
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const oldProfile = {
        id: 'codex',
        name: 'Codex',
        launch: { shellCommand: 'codex', args: [], env: {} }
      };
      fs.writeFileSync(path.join(enginesDir, 'codex.json'), JSON.stringify(oldProfile, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'codex.json'), 'utf8'));
      // New fields from bundled profile should be backfilled
      assert.deepStrictEqual(updated.launch.preKeys, ['Enter', 'Enter']);
      assert.equal(updated.launch.preKeyDelay, 3000);
      assert.equal(updated.launch.startupDelay, 2000);
      // Existing values should NOT be overwritten
      assert.equal(updated.launch.shellCommand, 'codex');
    });

    it('should not overwrite user-customized values when merging bundled profiles', () => {
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const customProfile = {
        id: 'codex',
        name: 'My Custom Codex',
        launch: { shellCommand: 'my-codex', args: ['--flag'], env: { CUSTOM: '1' } },
        capabilities: { supportsPrimePrompt: false }
      };
      fs.writeFileSync(path.join(enginesDir, 'codex.json'), JSON.stringify(customProfile, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'codex.json'), 'utf8'));
      // User's custom values must be preserved
      assert.equal(updated.name, 'My Custom Codex');
      assert.equal(updated.launch.shellCommand, 'my-codex');
      assert.deepStrictEqual(updated.launch.args, ['--flag']);
      assert.equal(updated.capabilities.supportsPrimePrompt, false);
      // New fields from bundled should still be added
      assert.ok('preKeys' in updated.launch, 'preKeys should be backfilled');
      assert.ok('supportsConfigFile' in updated.capabilities, 'supportsConfigFile should be backfilled');
    });

    it('should not modify engine profiles when bundled has no new fields', () => {
      // Init once to get all bundled profiles
      store.init();

      const enginesDir = path.join(tmpDir, 'engines');
      const codexPath = path.join(enginesDir, 'codex.json');
      const before = fs.readFileSync(codexPath, 'utf8');

      // Close and re-init — should not change anything
      store.close();
      store.init();

      const after = fs.readFileSync(codexPath, 'utf8');
      assert.equal(before, after, 'Profile should be unchanged when bundled has no new fields');
    });
  });

  describe('close', () => {
    it('should close without error', () => {
      store.init();
      store.close();
      assert.equal(store.getDb(), null);
    });

    it('should be safe to call multiple times', () => {
      store.init();
      store.close();
      store.close(); // should not throw
    });
  });

  describe('config', () => {
    beforeEach(() => {
      store.init();
    });

    describe('load', () => {
      it('should return config merged with defaults', () => {
        const config = store.config.load();
        assert.equal(config.serverPort, 3101);
        assert.equal(config.defaultEngine, 'claude');
        assert.equal(config.theme, 'dark');
      });

      it('should return defaults when config file is missing', () => {
        fs.unlinkSync(path.join(tmpDir, 'config.json'));
        const config = store.config.load();
        assert.equal(config.serverPort, 3101);
      });
    });

    describe('save', () => {
      it('should persist config to disk', () => {
        const config = store.config.load();
        config.theme = 'light';
        store.config.save(config);

        const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
        const loaded = JSON.parse(raw);
        assert.equal(loaded.theme, 'light');
      });
    });

    describe('get', () => {
      it('should return a top-level value', () => {
        assert.equal(store.config.get('serverPort'), 3101);
      });

      it('should return a nested value via dot notation', () => {
        const label = store.config.get('quickCommands.0.label');
        assert.equal(label, 'git status');
      });

      it('should return undefined for missing keys', () => {
        assert.equal(store.config.get('nonexistent'), undefined);
      });
    });

    describe('set', () => {
      it('should set and persist a value', () => {
        store.config.set('theme', 'high-contrast');
        assert.equal(store.config.get('theme'), 'high-contrast');
      });

      it('should create nested keys', () => {
        store.config.set('custom.nested.value', 42);
        assert.equal(store.config.get('custom.nested.value'), 42);
      });
    });
  });

  describe('engines', () => {
    beforeEach(() => {
      store.init();
    });

    describe('list', () => {
      it('should return all engine profiles', () => {
        const engines = store.engines.list();
        assert.ok(engines.length >= 4, 'Should have at least 4 engine profiles');
        const ids = engines.map((e) => e.id);
        assert.ok(ids.includes('claude'));
        assert.ok(ids.includes('codex'));
      });
    });

    describe('get', () => {
      it('should return engine by id', () => {
        const engine = store.engines.get('claude');
        assert.ok(engine);
        assert.equal(engine.id, 'claude');
        assert.equal(engine.name, 'Claude Code');
      });

      it('should return null for missing engine', () => {
        assert.equal(store.engines.get('nonexistent'), null);
      });
    });

    describe('save', () => {
      it('should write engine profile', () => {
        store.engines.save({ id: 'test-engine', name: 'Test' });
        const engine = store.engines.get('test-engine');
        assert.equal(engine.name, 'Test');
      });

      it('should reject profile without id', () => {
        assert.throws(() => store.engines.save({}), /must have an id/);
      });
    });

    describe('delete', () => {
      it('should remove engine profile', () => {
        store.engines.save({ id: 'to-delete', name: 'Temp' });
        store.engines.delete('to-delete');
        assert.equal(store.engines.get('to-delete'), null);
      });

      it('should throw for missing engine', () => {
        assert.throws(() => store.engines.delete('nonexistent'), /not found/);
      });
    });
  });

  describe('templates', () => {
    beforeEach(() => {
      store.init();
    });

    describe('list', () => {
      it('should return summary of templates', () => {
        const templates = store.templates.list();
        assert.ok(templates.length >= 1);
        const minimal = templates.find((t) => t.id === 'minimal');
        assert.ok(minimal);
        assert.equal(minimal.name, 'Minimal');
        // Summary should not include full template details
        assert.ok(!minimal.phases, 'Should not include phases in summary');
      });
    });

    describe('get', () => {
      it('should return full template by id', () => {
        const tmpl = store.templates.get('minimal');
        assert.ok(tmpl);
        assert.equal(tmpl.id, 'minimal');
        assert.ok(Array.isArray(tmpl.phases), 'Should include phases');
      });

      it('should return null for missing template', () => {
        assert.equal(store.templates.get('nonexistent'), null);
      });
    });

    describe('save', () => {
      it('should write template', () => {
        store.templates.save({ id: 'custom', name: 'Custom', type: 'methodology', version: '1.0.0' });
        const tmpl = store.templates.get('custom');
        assert.equal(tmpl.name, 'Custom');
      });
    });

    describe('delete', () => {
      it('should remove template', () => {
        store.templates.save({ id: 'temp', name: 'Temp', type: 'methodology', version: '1.0.0' });
        store.templates.delete('temp');
        assert.equal(store.templates.get('temp'), null);
      });

      it('should throw for missing template', () => {
        assert.throws(() => store.templates.delete('nonexistent'), /not found/);
      });
    });

    describe('getPlaybook', () => {
      it('should return playbook content for prawduct', () => {
        const playbook = store.templates.getPlaybook('prawduct');
        assert.ok(playbook, 'prawduct should have a playbook');
        assert.ok(playbook.includes('Session Playbook'), 'should contain playbook header');
        assert.ok(playbook.includes('One chunk per session'), 'should contain session discipline');
      });

      it('should include session start instructions in prawduct playbook', () => {
        const playbook = store.templates.getPlaybook('prawduct');
        assert.ok(playbook.includes('### Session Start'), 'should contain session start section');
        assert.ok(playbook.includes('build-plan*.md'), 'should glob for all build plans, not just build-plan.md');
        assert.ok(playbook.includes('incomplete chunks'), 'should mention finding incomplete chunks');
      });

      it('should return null for templates without playbook', () => {
        const playbook = store.templates.getPlaybook('minimal');
        assert.equal(playbook, null);
      });

      it('should return null for nonexistent template', () => {
        const playbook = store.templates.getPlaybook('nonexistent');
        assert.equal(playbook, null);
      });
    });
  });

  describe('projectConfig', () => {
    let projectDir;

    beforeEach(() => {
      store.init();
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projcfg-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it('should return defaults when no config file exists', () => {
      const config = store.projectConfig.load(projectDir);
      assert.equal(config.engine, null);
      assert.equal(config.methodology, null);
      assert.equal(config.methodologyPhase, null);
      assert.equal(config.rules.core.changelogPerChange, true);
      assert.equal(config.rules.extensions.identitySentry, false);
      assert.deepEqual(config.tags, []);
    });

    it('should save and load project config', () => {
      const config = store.projectConfig.load(projectDir);
      config.engine = 'codex';
      config.tags = ['test'];
      store.projectConfig.save(projectDir, config);

      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.engine, 'codex');
      assert.deepEqual(loaded.tags, ['test']);
    });

    it('should create .tangleclaw directory on save', () => {
      store.projectConfig.save(projectDir, { engine: 'aider' });
      assert.ok(fs.existsSync(path.join(projectDir, '.tangleclaw', 'project.json')));
    });

    it('should never allow disabling core rules', () => {
      store.projectConfig.save(projectDir, {
        rules: {
          core: { changelogPerChange: false, jsdocAllFunctions: false },
          extensions: { identitySentry: true }
        }
      });

      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.rules.core.changelogPerChange, true);
      assert.equal(loaded.rules.core.jsdocAllFunctions, true);
      assert.equal(loaded.rules.extensions.identitySentry, true);
    });

    it('should merge extensions with defaults', () => {
      store.projectConfig.save(projectDir, {
        rules: { extensions: { identitySentry: true } }
      });

      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.rules.extensions.identitySentry, true);
      assert.equal(loaded.rules.extensions.docsParity, false); // default preserved
    });

    it('should migrate legacy claude-code engine ID to claude', () => {
      store.projectConfig.save(projectDir, { engine: 'claude-code' });

      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.engine, 'claude', 'claude-code should be migrated to claude on load');
    });

    it('should handle malformed JSON gracefully', () => {
      fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), 'not json');

      const config = store.projectConfig.load(projectDir);
      assert.equal(config.engine, null); // returns defaults
    });
  });

  describe('StoreError', () => {
    it('should have code and detail properties', () => {
      const err = new store.StoreError('something broke', 'TEST_ERROR');
      assert.equal(err.message, 'something broke');
      assert.equal(err.code, 'TEST_ERROR');
      assert.equal(err.detail, 'something broke');
      assert.ok(err instanceof Error);
    });

    it('should accept a cause', () => {
      const cause = new Error('root cause');
      const err = new store.StoreError('wrapper', 'WRAPPED', cause);
      assert.equal(err.cause, cause);
    });
  });
});
