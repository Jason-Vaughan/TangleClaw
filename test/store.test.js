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
      assert.equal(row.version, 15);
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

    it('bundled claude profile has no preKeys on bypassPermissions (#119)', () => {
      // Regression test: the "press 2 to confirm dangerous mode" dialog no
      // longer exists in current Claude Code, so any preKeys here would land
      // in chat as a stray first user message.
      const bundled = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8')
      );
      const bypass = bundled.launchModes.bypassPermissions;
      assert.ok(bypass, 'bypassPermissions mode should exist');
      assert.ok(!('preKeys' in bypass), 'bypassPermissions should not declare preKeys');
      assert.ok(!('preKeyDelay' in bypass), 'bypassPermissions should not declare preKeyDelay');
    });

    it('prunes stale ["2","Enter"] bypass preKeys from existing claude profile (#119)', () => {
      // Simulate an existing install whose runtime claude.json still carries
      // the stale preKeys baked in by older bundled versions.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const stale = {
        id: 'claude',
        name: 'Claude Code',
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          default: { label: 'Interactive', args: [] },
          bypassPermissions: {
            label: 'Bypass',
            args: ['--dangerously-skip-permissions'],
            preKeys: ['2', 'Enter'],
            preKeyDelay: 2000
          }
        }
      };
      fs.writeFileSync(path.join(enginesDir, 'claude.json'), JSON.stringify(stale, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'claude.json'), 'utf8'));
      const bypass = updated.launchModes.bypassPermissions;
      assert.ok(!('preKeys' in bypass), 'stale preKeys should be pruned');
      assert.ok(!('preKeyDelay' in bypass), 'stale preKeyDelay should be pruned');
      // Other bypass fields preserved
      assert.equal(bypass.label, 'Bypass');
      assert.deepStrictEqual(bypass.args, ['--dangerously-skip-permissions']);
    });

    it('bypass preKey prune is idempotent across reboots (#119)', () => {
      // Once pruned, a second init must not re-trigger work or rewrite the file.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const stale = {
        id: 'claude',
        name: 'Claude Code',
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          default: { label: 'Interactive', args: [] },
          bypassPermissions: {
            label: 'Bypass',
            args: ['--dangerously-skip-permissions'],
            preKeys: ['2', 'Enter'],
            preKeyDelay: 2000
          }
        }
      };
      const livePath = path.join(enginesDir, 'claude.json');
      fs.writeFileSync(livePath, JSON.stringify(stale, null, 2));

      store.init();
      const afterFirst = fs.readFileSync(livePath, 'utf8');

      store.close();
      store.init();
      const afterSecond = fs.readFileSync(livePath, 'utf8');

      assert.equal(afterFirst, afterSecond, 'Profile should be unchanged on second init');
      const final = JSON.parse(afterSecond);
      assert.ok(!('preKeys' in final.launchModes.bypassPermissions));
    });

    it('preserves user-customized bypass preKeys (#119)', () => {
      // If a user has *intentionally* set non-default preKeys (e.g. for a
      // forked Claude binary that still requires confirmation), the prune must
      // not touch them. Equality match against ["2","Enter"] guards this.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const custom = {
        id: 'claude',
        name: 'Claude Code',
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          default: { label: 'Interactive', args: [] },
          bypassPermissions: {
            label: 'Bypass',
            args: ['--dangerously-skip-permissions'],
            preKeys: ['y', 'Enter'],
            preKeyDelay: 1500
          }
        }
      };
      fs.writeFileSync(path.join(enginesDir, 'claude.json'), JSON.stringify(custom, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'claude.json'), 'utf8'));
      const bypass = updated.launchModes.bypassPermissions;
      assert.deepStrictEqual(bypass.preKeys, ['y', 'Enter'], 'custom preKeys should be preserved');
      assert.equal(bypass.preKeyDelay, 1500, 'custom preKeyDelay should be preserved');
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

    it('reconciles stale runtime methodology template against bundled on init (#136 / #139 Chunk 2)', () => {
      // Integration test for the reconcile glue in _copyBundledTemplates →
      // _mergeBundledTemplate. The unit tests above already prove the merge
      // function works in isolation; this test locks in that init() actually
      // calls it for existing template.json files.
      //
      // Post-#139 Chunk 2: bundled prawduct/template.json ships `wrap_pipeline`
      // instead of `wrap`. A pre-#139 runtime template still has the legacy
      // `wrap` block. The reconciler's job here is to propagate the new
      // `wrap_pipeline` from bundled into live via `addMissing`, while
      // leaving the legacy `wrap` block intact (the inert safety-net
      // behavior — see ARRAY_RECONCILERS comment in lib/store.js).
      const templatesDir = path.join(tmpDir, 'templates');
      const prawductDir = path.join(templatesDir, 'prawduct');
      fs.mkdirSync(prawductDir, { recursive: true });
      const stale = {
        id: 'prawduct',
        name: 'Prawduct',
        wrap: { command: null, steps: ['version-bump', 'changelog-update', 'commit'] }
      };
      const livePath = path.join(prawductDir, 'template.json');
      fs.writeFileSync(livePath, JSON.stringify(stale, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      // `wrap_pipeline` propagated from bundled.
      assert.ok(updated.wrap_pipeline, 'wrap_pipeline should be added from bundled');
      const ids = updated.wrap_pipeline.steps.map((s) => s.id);
      assert.ok(ids.includes('memory-update'),
        'memory-update step should be present in wrap_pipeline (#139 Chunk 2)');
      assert.ok(ids.indexOf('version-bump') < ids.indexOf('commit'),
        'order preserved: version-bump before commit');
      // Legacy `wrap` block left untouched as the inert safety net.
      assert.deepStrictEqual(updated.wrap,
        { command: null, steps: ['version-bump', 'changelog-update', 'commit'] },
        'legacy wrap block must be preserved as-is when bundled drops it');
    });

    it('reconciles stale runtime methodology template hook entries against bundled on init (#158)', () => {
      // Same integration shape as the #136 case above, but exercising the
      // hook-entry backfill path added in #158. Seeds a pre-#146 runtime
      // template — hook entries present but missing the `requires` precondition
      // — and asserts init() backfills requires from the bundled template.
      const templatesDir = path.join(tmpDir, 'templates');
      const prawductDir = path.join(templatesDir, 'prawduct');
      fs.mkdirSync(prawductDir, { recursive: true });
      const stale = {
        id: 'prawduct',
        name: 'Prawduct',
        wrap: { command: null, steps: ['version-bump', 'changelog-update', 'memory-update', 'commit'] },
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              // NO requires — pre-#146 shape
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      };
      const livePath = path.join(prawductDir, 'template.json');
      fs.writeFileSync(livePath, JSON.stringify(stale, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      assert.ok(Array.isArray(updated.hooks.claude.SessionStart[0].requires),
        'SessionStart[0].requires backfilled from bundled (#158 incident shape)');
      assert.ok(updated.hooks.claude.SessionStart[0].requires.includes('tools/product-hook'),
        'SessionStart[0].requires contains tools/product-hook');
      assert.ok(Array.isArray(updated.hooks.claude.Stop[0].requires),
        'Stop[0].requires backfilled from bundled');
      assert.ok(updated.hooks.claude.Stop[0].requires.includes('tools/product-hook'),
        'Stop[0].requires contains tools/product-hook');
      // Inner hooks array preserved (chunk-1 filter strips `requires` from the
      // emitted .claude/settings.json but the runtime template keeps it).
      assert.equal(updated.hooks.claude.Stop[0].hooks[0].command,
        'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop');
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
      // methodology default aligned with the DB schema's NOT NULL DEFAULT 'minimal' (#151)
      assert.equal(config.methodology, 'minimal');
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

    // #139 Chunk 11c — round-trip pin for the legacy opt-out path. The
    // CHANGELOG's migration guarantee ("existing projects with `wrapV2:
    // false` keep the legacy path") rests entirely on this round-trip:
    // a future refactor of `projectConfigApi.load`'s deep-merge that
    // accidentally let `DEFAULT_PROJECT_CONFIG.wrapV2: true` overwrite
    // an explicit `false` would silently route every legacy-opt-out
    // project to V2. This test is the load-bearing pin.
    it('should preserve explicit wrapV2:false across save/load round-trip (#139 Chunk 11c)', () => {
      store.projectConfig.save(projectDir, { wrapV2: false });
      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.wrapV2, false,
        'explicit wrapV2:false on disk must survive deep-merge with the default-true config');
    });

    it('should preserve explicit wrapV2:true across save/load round-trip (#139 Chunk 11c)', () => {
      store.projectConfig.save(projectDir, { wrapV2: true });
      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.wrapV2, true);
    });

    it('should fill in wrapV2:true (default) when the on-disk config omits the field (#139 Chunk 11c)', () => {
      // Persist a config that omits wrapV2 entirely — simulates an
      // older project.json written before the field existed.
      store.projectConfig.save(projectDir, { engine: 'claude' });
      const loaded = store.projectConfig.load(projectDir);
      assert.equal(loaded.wrapV2, true, 'absent flag must default to true post-Chunk-11c');
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

  describe('_isOrderedSubset (#136)', () => {
    it('returns true when needle appears as ordered subsequence in haystack', () => {
      assert.equal(store._isOrderedSubset(['a', 'b', 'c'], ['a', 'b', 'c']), true);
      assert.equal(store._isOrderedSubset(['a', 'c'], ['a', 'b', 'c']), true);
      assert.equal(store._isOrderedSubset(['b'], ['a', 'b', 'c']), true);
      assert.equal(store._isOrderedSubset([], ['a', 'b', 'c']), true);
    });

    it('returns false when needle has elements not in haystack', () => {
      assert.equal(store._isOrderedSubset(['a', 'x'], ['a', 'b', 'c']), false);
      assert.equal(store._isOrderedSubset(['x'], ['a', 'b', 'c']), false);
    });

    it('returns false when needle order differs from haystack', () => {
      assert.equal(store._isOrderedSubset(['b', 'a'], ['a', 'b', 'c']), false);
      assert.equal(store._isOrderedSubset(['c', 'a'], ['a', 'b', 'c']), false);
    });

    it('returns false for non-array inputs', () => {
      assert.equal(store._isOrderedSubset(null, ['a']), false);
      assert.equal(store._isOrderedSubset(['a'], null), false);
      assert.equal(store._isOrderedSubset('a', ['a']), false);
    });

    it('handles duplicate elements in needle and haystack correctly', () => {
      // Needle ['a','a'] should match in ['a','a','b'] (two `a`s present in order)
      // but not in ['a','b'] (only one `a`).
      assert.equal(store._isOrderedSubset(['a', 'a'], ['a', 'a', 'b']), true);
      assert.equal(store._isOrderedSubset(['a', 'a'], ['a', 'b']), false);
      // Needle with duplicates non-contiguous in haystack
      assert.equal(store._isOrderedSubset(['a', 'a'], ['a', 'b', 'a']), true);
    });

    it('handles empty haystack', () => {
      assert.equal(store._isOrderedSubset(['a'], []), false);
      assert.equal(store._isOrderedSubset([], []), true);
    });
  });

  describe('_reconcileOrderedSubset (#155 Chunk 1)', () => {
    it('returns a copy of bundled when live is a strict ordered subset', () => {
      const result = store._reconcileOrderedSubset(['a', 'c'], ['a', 'b', 'c']);
      assert.deepStrictEqual(result, ['a', 'b', 'c']);
    });

    it('returns null when live and bundled are identical (no rewrite needed)', () => {
      assert.equal(store._reconcileOrderedSubset(['a', 'b', 'c'], ['a', 'b', 'c']), null);
    });

    it('returns null when live has elements not in bundled (user customization)', () => {
      assert.equal(store._reconcileOrderedSubset(['a', 'custom', 'b'], ['a', 'b']), null);
    });

    it('returns null when live is reordered relative to bundled (user customization)', () => {
      assert.equal(store._reconcileOrderedSubset(['b', 'a'], ['a', 'b']), null);
    });

    it('returns null on non-array inputs', () => {
      assert.equal(store._reconcileOrderedSubset(null, ['a']), null);
      assert.equal(store._reconcileOrderedSubset(['a'], null), null);
      assert.equal(store._reconcileOrderedSubset('a', ['a']), null);
    });

    it('returns a new array (not the bundled reference) to avoid aliasing', () => {
      const bundled = ['a', 'b'];
      const result = store._reconcileOrderedSubset(['a'], bundled);
      assert.notStrictEqual(result, bundled, 'result must be a fresh array');
      assert.deepStrictEqual(result, bundled);
    });
  });

  describe('_reconcileSetUnion (#155 Chunk 1)', () => {
    it('appends bundled entries missing from live in bundled order', () => {
      const result = store._reconcileSetUnion(['a'], ['a', 'b', 'c']);
      assert.deepStrictEqual(result, ['a', 'b', 'c']);
    });

    it('preserves live order at the front; new bundled entries go at the end', () => {
      // Live order ['c','a'] preserved; 'b' (in bundled, missing from live) appended.
      const result = store._reconcileSetUnion(['c', 'a'], ['a', 'b', 'c']);
      assert.deepStrictEqual(result, ['c', 'a', 'b']);
    });

    it('returns null when live already contains every bundled entry (no rewrite needed)', () => {
      assert.equal(store._reconcileSetUnion(['a', 'b', 'c'], ['a', 'b']), null);
      assert.equal(store._reconcileSetUnion(['a', 'b'], ['a', 'b']), null);
    });

    it('preserves user-added entries not in bundled', () => {
      const result = store._reconcileSetUnion(['user-added'], ['bundled-only']);
      assert.deepStrictEqual(result, ['user-added', 'bundled-only']);
    });

    it('handles empty live (returns copy of bundled)', () => {
      const result = store._reconcileSetUnion([], ['a', 'b']);
      assert.deepStrictEqual(result, ['a', 'b']);
    });

    it('returns null on empty bundled', () => {
      assert.equal(store._reconcileSetUnion(['a'], []), null);
    });

    it('returns null on non-array inputs', () => {
      assert.equal(store._reconcileSetUnion(null, ['a']), null);
      assert.equal(store._reconcileSetUnion(['a'], null), null);
    });

    it('does not duplicate entries that already exist in live', () => {
      // bundled has 'a' twice — live's existing 'a' satisfies both. No dupes.
      const result = store._reconcileSetUnion(['a'], ['a', 'a', 'b']);
      // 'b' is the only missing entry. Both bundled 'a' instances should be
      // filtered out because membership in live is sufficient.
      assert.deepStrictEqual(result, ['a', 'b']);
    });
  });

  describe('_reconcileMergeBy (#155 Chunk 2)', () => {
    it('appends bundled entries whose idKey value is missing from live', () => {
      const result = store._reconcileMergeBy(
        [{ id: 'a' }],
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        'id',
      );
      assert.deepStrictEqual(result, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    });

    it('preserves live order at the front; new bundled entries go at the end', () => {
      const result = store._reconcileMergeBy(
        [{ id: 'c' }, { id: 'a' }],
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        'id',
      );
      assert.deepStrictEqual(result, [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
    });

    it('returns null when every bundled id is already present in live (no rewrite needed)', () => {
      assert.equal(
        store._reconcileMergeBy(
          [{ id: 'a' }, { id: 'b' }],
          [{ id: 'a' }, { id: 'b' }],
          'id',
        ),
        null,
      );
      assert.equal(
        store._reconcileMergeBy(
          [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          [{ id: 'a' }, { id: 'b' }],
          'id',
        ),
        null,
      );
    });

    it('preserves user-added entries (live entries whose id is not in bundled stay untouched)', () => {
      const result = store._reconcileMergeBy(
        [{ id: 'user-only' }],
        [{ id: 'bundled-only' }],
        'id',
      );
      assert.deepStrictEqual(result, [{ id: 'user-only' }, { id: 'bundled-only' }]);
    });

    it('never overwrites field values on entries matched by id (additive only)', () => {
      const live = [{ id: 'a', val: 'live-value' }];
      const bundled = [{ id: 'a', val: 'bundled-value' }, { id: 'b', val: 'b-val' }];
      const result = store._reconcileMergeBy(live, bundled, 'id');
      // `a` matched: untouched. `b` missing: appended verbatim.
      assert.deepStrictEqual(result, [{ id: 'a', val: 'live-value' }, { id: 'b', val: 'b-val' }]);
    });

    it('deep-clones appended entries so subsequent bundled mutations cannot leak into the result', () => {
      const bundled = [{ id: 'a', meta: { tag: 'original' } }];
      const result = store._reconcileMergeBy([], bundled, 'id');
      // Mutate bundled after the merge — result must not change.
      bundled[0].meta.tag = 'mutated';
      assert.equal(result[0].meta.tag, 'original');
    });

    it('handles empty live (returns deep-cloned copy of bundled)', () => {
      const result = store._reconcileMergeBy([], [{ id: 'a' }, { id: 'b' }], 'id');
      assert.deepStrictEqual(result, [{ id: 'a' }, { id: 'b' }]);
    });

    it('returns null on empty bundled', () => {
      assert.equal(store._reconcileMergeBy([{ id: 'a' }], [], 'id'), null);
    });

    it('returns null on non-array inputs', () => {
      assert.equal(store._reconcileMergeBy(null, [{ id: 'a' }], 'id'), null);
      assert.equal(store._reconcileMergeBy([{ id: 'a' }], null, 'id'), null);
    });

    it('returns null when idKey is missing or empty', () => {
      assert.equal(store._reconcileMergeBy([{ id: 'a' }], [{ id: 'b' }], ''), null);
      assert.equal(store._reconcileMergeBy([{ id: 'a' }], [{ id: 'b' }], undefined), null);
      assert.equal(store._reconcileMergeBy([{ id: 'a' }], [{ id: 'b' }], null), null);
    });

    it('supports non-"id" key names (e.g. label)', () => {
      const result = store._reconcileMergeBy(
        [{ label: 'Run Critic' }],
        [{ label: 'Run Critic' }, { label: 'Run Audit' }],
        'label',
      );
      assert.deepStrictEqual(result, [{ label: 'Run Critic' }, { label: 'Run Audit' }]);
    });

    it('skips bundled entries that lack a string-valued idKey (cannot dedupe safely)', () => {
      const result = store._reconcileMergeBy(
        [{ id: 'a' }],
        [{ id: 'a' }, { /* no id */ name: 'orphan' }, { id: 'b' }],
        'id',
      );
      // Only `b` is appended; the keyless bundled entry is skipped.
      assert.deepStrictEqual(result, [{ id: 'a' }, { id: 'b' }]);
    });

    it('protects against bundled internal duplicates within the same pass', () => {
      // bundled has two entries with id='b'; live has none. Only the first
      // is appended — the dedupe set tracks ids added during this pass.
      const result = store._reconcileMergeBy(
        [{ id: 'a' }],
        [{ id: 'a' }, { id: 'b', v: 1 }, { id: 'b', v: 2 }],
        'id',
      );
      assert.deepStrictEqual(result, [{ id: 'a' }, { id: 'b', v: 1 }]);
    });
  });

  describe('_mergeBundledTemplate (#136)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-tpl-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeJson(filename, obj) {
      const p = path.join(tmpDir, filename);
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
      return p;
    }

    it('reconciles wrap.steps when live is a strict ordered subset of bundled (the #136 incident shape)', () => {
      // The v3.13.7 case verbatim: bundled added `memory-update` to wrap.steps;
      // existing install's runtime copy is missing that step but otherwise matches.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { command: null, steps: ['version-bump', 'changelog-update', 'learnings-capture', 'next-session-prime', 'memory-update', 'commit'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { command: null, steps: ['version-bump', 'changelog-update', 'learnings-capture', 'next-session-prime', 'commit'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps,
        ['version-bump', 'changelog-update', 'learnings-capture', 'next-session-prime', 'memory-update', 'commit']);
    });

    it('does NOT replace wrap.steps when live has steps not in bundled (user customization)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'my-custom-step', 'b', 'c'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps, ['a', 'my-custom-step', 'b', 'c'],
        'user customization should be preserved');
    });

    it('does NOT replace wrap.steps when live has reordered steps (user customization)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['b', 'a', 'c'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps, ['b', 'a', 'c']);
    });

    it('does NOT replace wrap.steps when live and bundled are identical (no-op)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'] }
      });
      const beforeMtime = fs.statSync(live).mtime.getTime();
      // Wait a tick to ensure mtime would change if rewritten
      const sleep10 = Date.now() + 10;
      while (Date.now() < sleep10) { /* spin */ }
      store._mergeBundledTemplate(bundled, live);
      const afterMtime = fs.statSync(live).mtime.getTime();
      assert.equal(beforeMtime, afterMtime, 'file should not be rewritten on no-op');
    });

    it('adds missing top-level fields from bundled (additive merge)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'minimal',
        wrap: { steps: ['commit'] },
        // A future top-level field
        eval: { exchanges: { enabled: true } }
      });
      const live = writeJson('live.json', {
        id: 'minimal',
        wrap: { steps: ['commit'] }
        // no eval block — picks up from bundled
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.eval, { exchanges: { enabled: true } });
    });

    it('preserves existing field values when bundled differs (additive only, never overwrites)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        description: 'Bundled description',
        wrap: { steps: ['commit'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        description: 'User customized description',
        wrap: { steps: ['commit'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.equal(merged.description, 'User customized description',
        'existing field value preserved over bundled');
    });

    it('recursively adds missing nested keys without touching peer keys', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        init: { directories: ['.prawduct'], files: { 'BUILD.md': 'bundled-content' } }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        init: { directories: ['.prawduct'] } // no `files` key
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.init.directories, ['.prawduct']);
      assert.deepStrictEqual(merged.init.files, { 'BUILD.md': 'bundled-content' });
    });

    it('silently skips malformed JSON files (fail-open)', () => {
      const bundled = writeJson('bundled.json', { id: 'prawduct' });
      const livePath = path.join(tmpDir, 'live.json');
      fs.writeFileSync(livePath, '{not valid json');
      // Should not throw
      store._mergeBundledTemplate(bundled, livePath);
      // Malformed file unchanged
      assert.equal(fs.readFileSync(livePath, 'utf8'), '{not valid json');
    });

    it('treats user-removed step as stale-older and re-adds it on reconcile (acknowledged limitation, #136)', () => {
      // The ordered-subset check cannot distinguish "user is on an older
      // version missing some steps" from "user intentionally removed a step
      // that's in bundled" — both produce a live array that's a strict
      // ordered subset of bundled. The chosen policy is to re-add (treat as
      // stale-older). Locking this in so a future contributor who wants the
      // opposite behavior knows where to update the policy.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        // User intentionally removed 'b' — but live IS still an ordered
        // subset of bundled (['a','c'] ⊂ ['a','b','c']), so the reconciler
        // can't tell the difference and re-adds it.
        wrap: { steps: ['a', 'c'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps, ['a', 'b', 'c'],
        'user-removed step is re-added (policy choice — see #136 CHANGELOG entry)');
    });

    it('handles missing bundled file gracefully', () => {
      const bundled = path.join(tmpDir, 'does-not-exist.json');
      const live = writeJson('live.json', { id: 'prawduct', wrap: { steps: ['a'] } });
      store._mergeBundledTemplate(bundled, live);
      const stillThere = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(stillThere.wrap.steps, ['a']);
    });

    // #155 Chunk 1 — table-driven plain-array reconciliation extends the same
    // policy across `prime.sections`, `wrap.captureFields`, `init.directories`.

    it('reconciles prime.sections when live is a strict ordered subset (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        prime: { sections: ['methodology-rules', 'current-phase', 'active-learnings', 'last-session-summary', 'project-state'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        prime: { sections: ['methodology-rules', 'active-learnings', 'last-session-summary'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.prime.sections,
        ['methodology-rules', 'current-phase', 'active-learnings', 'last-session-summary', 'project-state'],
      );
    });

    it('does NOT replace prime.sections when live has user-added section (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        prime: { sections: ['a', 'b'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        prime: { sections: ['a', 'custom', 'b'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.prime.sections, ['a', 'custom', 'b']);
    });

    it('appends missing bundled entries onto wrap.captureFields (setUnion, #155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { captureFields: ['summary', 'nextSteps', 'learnings'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { captureFields: ['summary'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.captureFields, ['summary', 'nextSteps', 'learnings']);
    });

    it('preserves user-added captureFields entries; appends only missing bundled (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { captureFields: ['summary', 'nextSteps'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { captureFields: ['summary', 'user-added-field'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      // Live order preserved at front; bundled-only 'nextSteps' appended.
      assert.deepStrictEqual(merged.wrap.captureFields, ['summary', 'user-added-field', 'nextSteps']);
    });

    it('appends missing bundled entries onto init.directories (setUnion, #155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        init: { directories: ['.tangleclaw', '.prawduct'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        init: { directories: ['.tangleclaw'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.init.directories, ['.tangleclaw', '.prawduct']);
    });

    it('does NOT rewrite when every registered array is already in sync (no-op, #155)', () => {
      // Asserts the fail-open posture: when every policy returns null and
      // the addMissing recursive pass finds nothing, the file is left alone.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a'], captureFields: ['summary'] },
        prime: { sections: ['x'] },
        init: { directories: ['.d'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a'], captureFields: ['summary'] },
        prime: { sections: ['x'] },
        init: { directories: ['.d'] }
      });
      const beforeMtime = fs.statSync(live).mtime.getTime();
      const sleep10 = Date.now() + 10;
      while (Date.now() < sleep10) { /* spin */ }
      store._mergeBundledTemplate(bundled, live);
      const afterMtime = fs.statSync(live).mtime.getTime();
      assert.equal(beforeMtime, afterMtime, 'identical templates must not trigger a rewrite');
    });

    it('reconciles multiple drifting arrays in a single pass (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b', 'c'], captureFields: ['summary', 'nextSteps'] },
        prime: { sections: ['rules', 'phase', 'state'] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'c'], captureFields: ['summary'] },
        prime: { sections: ['rules', 'state'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps, ['a', 'b', 'c']);
      assert.deepStrictEqual(merged.wrap.captureFields, ['summary', 'nextSteps']);
      assert.deepStrictEqual(merged.prime.sections, ['rules', 'phase', 'state']);
    });

    it('table-driven driver does not touch arrays absent from ARRAY_RECONCILERS (#155)', () => {
      // Arbitrary template-author-defined arrays not in the policy table
      // must be ignored. `customCategory.items` is not registered; the
      // recursive `addMissing` pass also leaves arrays alone (it only
      // recurses into plain objects). Pins the scope boundary.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a'] },
        customCategory: { items: [{ id: 'x' }, { id: 'y' }] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a'] },
        customCategory: { items: [{ id: 'x' }] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.customCategory.items, [{ id: 'x' }],
        'unregistered array paths must not be reconciled');
    });

    // #155 Chunk 2 — object-keyed array reconciliation extends the same
    // policy across `phases`, `evalDimensions.tier1/2/3`, and `actions`.

    it('appends missing phases by id (mergeBy:id, #155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [
          { id: 'discovery', weight: 'deep' },
          { id: 'planning',  weight: 'deep' },
          { id: 'building',  weight: 'normal' }
        ]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: [
          { id: 'discovery', weight: 'deep' }
        ]
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.equal(merged.phases.length, 3);
      assert.deepStrictEqual(merged.phases.map((p) => p.id), ['discovery', 'planning', 'building']);
    });

    it('preserves user-added phases; appends only bundled-new ids (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [
          { id: 'discovery' },
          { id: 'planning' }
        ]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: [
          { id: 'discovery' },
          { id: 'user-custom-phase' }
        ]
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      // Live order at front; bundled-new `planning` appended.
      assert.deepStrictEqual(
        merged.phases.map((p) => p.id),
        ['discovery', 'user-custom-phase', 'planning'],
      );
    });

    it('preserves user customization to existing phase entries (additive only, never overwrites) (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [{ id: 'discovery', weight: 'deep', description: 'Bundled' }]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: [{ id: 'discovery', weight: 'focused', description: 'User edit' }]
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.phases,
        [{ id: 'discovery', weight: 'focused', description: 'User edit' }],
        'matched-by-id entry is left untouched — additive policy never overwrites field values',
      );
    });

    it('appends missing evalDimensions.tier1 entries by id (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'tilt',
        evalDimensions: {
          tier1: [
            { id: 'self_identification', check: 'pattern' },
            { id: 'authority_verification', check: 'pattern' }
          ]
        }
      });
      const live = writeJson('live.json', {
        id: 'tilt',
        evalDimensions: {
          tier1: [{ id: 'self_identification', check: 'pattern' }]
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.equal(merged.evalDimensions.tier1.length, 2);
      assert.deepStrictEqual(
        merged.evalDimensions.tier1.map((d) => d.id),
        ['self_identification', 'authority_verification'],
      );
    });

    it('appends missing actions matched by label (mergeBy:label, #155)', () => {
      // Prawduct's `actions` entries are keyed by `label`, not `id` —
      // pinned via a separate idKey configuration in ARRAY_RECONCILERS.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        actions: [
          { label: 'Run Critic',    command: 'invoke-critic',    confirm: false },
          { label: 'Run Audit',     command: 'invoke-audit',     confirm: true }
        ]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        actions: [
          { label: 'Run Critic', command: 'invoke-critic', confirm: false }
        ]
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.equal(merged.actions.length, 2);
      assert.deepStrictEqual(
        merged.actions.map((a) => a.label),
        ['Run Critic', 'Run Audit'],
      );
    });

    it('deep-clones appended object entries so bundled mutations cannot leak into live (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [{ id: 'discovery', meta: { note: 'original' } }]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: []
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      // Mutate bundled state on disk after reconcile; live snapshot must
      // be independent because the appended entry was deep-cloned at
      // write time. The fs-level cloning is guaranteed by the JSON
      // round-trip, but this also covers the in-memory deep-clone in
      // _reconcileMergeBy for the case where a caller reuses the same
      // bundled object in-process across multiple live targets.
      assert.deepStrictEqual(merged.phases, [{ id: 'discovery', meta: { note: 'original' } }]);
    });

    it('reconciles object-keyed arrays in a single pass alongside string arrays (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['a', 'b'], captureFields: ['summary', 'next'] },
        phases: [{ id: 'discovery' }, { id: 'planning' }],
        evalDimensions: { tier1: [{ id: 'x' }, { id: 'y' }] }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['a'], captureFields: ['summary'] },
        phases: [{ id: 'discovery' }],
        evalDimensions: { tier1: [{ id: 'x' }] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.wrap.steps, ['a', 'b']);
      assert.deepStrictEqual(merged.wrap.captureFields, ['summary', 'next']);
      assert.deepStrictEqual(merged.phases.map((p) => p.id), ['discovery', 'planning']);
      assert.deepStrictEqual(merged.evalDimensions.tier1.map((d) => d.id), ['x', 'y']);
    });

    it('no-op when every object-keyed array is already in sync (#155)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [{ id: 'discovery' }],
        actions: [{ label: 'Run Critic' }]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: [{ id: 'discovery' }],
        actions: [{ label: 'Run Critic' }]
      });
      const beforeMtime = fs.statSync(live).mtime.getTime();
      const sleep10 = Date.now() + 10;
      while (Date.now() < sleep10) { /* spin */ }
      store._mergeBundledTemplate(bundled, live);
      const afterMtime = fs.statSync(live).mtime.getTime();
      assert.equal(beforeMtime, afterMtime, 'identical templates must not trigger a rewrite');
    });

    it('treats user-removed object-keyed entry as stale and re-adds it (acknowledged limitation, ADR 0001)', () => {
      // Symmetric with the wrap.steps user-removed-step limitation:
      // _reconcileMergeBy can't distinguish "user removed entry with id X"
      // from "user is on an older version that never had id X" — both
      // produce a live whose id-set is a subset of bundled's. Policy
      // choice: re-add. Documented in ADR 0001.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        phases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        phases: [{ id: 'a' }, { id: 'c' }] // user intentionally removed `b`
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.phases.map((p) => p.id),
        ['a', 'c', 'b'],
        'user-removed entry is re-added on reconcile (policy choice — see ADR 0001)',
      );
    });

    // #139 Chunk 2 — wrap_pipeline.steps reconciliation via mergeBy:id.
    // The new wrap schema's typed step objects each carry an `id`; the
    // policy mirrors `phases` and `actions` so adding a new bundled
    // pipeline step propagates additively without disturbing user edits.

    it('appends missing wrap_pipeline.steps by id (mergeBy:id, #139 Chunk 2)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap_pipeline: {
          schemaVersion: '1.0',
          steps: [
            { id: 'version-bump', kind: 'version-bump' },
            { id: 'memory-update', kind: 'ai-content', prompt: '' },
            { id: 'commit', kind: 'commit' }
          ]
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap_pipeline: {
          schemaVersion: '1.0',
          steps: [
            { id: 'version-bump', kind: 'version-bump' }
          ]
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.wrap_pipeline.steps.map((s) => s.id),
        ['version-bump', 'memory-update', 'commit'],
      );
    });

    it('preserves user-added wrap_pipeline.steps; appends only bundled-new ids (#139 Chunk 2)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'memory-update', kind: 'ai-content' },
            { id: 'commit',        kind: 'commit' }
          ]
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'memory-update',       kind: 'ai-content' },
            { id: 'user-custom-step',    kind: 'ai-content', prompt: 'custom' }
          ]
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      // Live order at front; bundled-new `commit` appended.
      assert.deepStrictEqual(
        merged.wrap_pipeline.steps.map((s) => s.id),
        ['memory-update', 'user-custom-step', 'commit'],
      );
    });

    it('preserves user customization on existing wrap_pipeline.steps entries (additive only, #139 Chunk 2)', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'memory-update', kind: 'ai-content', prompt: 'Bundled prompt', blocker: false }
          ]
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'memory-update', kind: 'ai-content', prompt: 'User customized prompt', blocker: true }
          ]
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.wrap_pipeline.steps,
        [{ id: 'memory-update', kind: 'ai-content', prompt: 'User customized prompt', blocker: true }],
        'matched-by-id entry is left untouched — additive policy never overwrites field values',
      );
    });

    it('treats user-removed wrap_pipeline.step as stale and re-adds it (ADR 0001 limitation, #139 Chunk 2)', () => {
      // Same policy choice as phases / actions / wrap.steps: when live's
      // id-set is a subset of bundled's, the reconciler can't distinguish
      // intentional removal from older-version state, so re-adds. The
      // wrap pipeline inherits the documented limitation.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'a', kind: 'ai-content' },
            { id: 'b', kind: 'ai-content' },
            { id: 'c', kind: 'commit' }
          ]
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [
            { id: 'a', kind: 'ai-content' },
            { id: 'c', kind: 'commit' }
          ] // user intentionally removed `b`
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(
        merged.wrap_pipeline.steps.map((s) => s.id),
        ['a', 'c', 'b'],
        'user-removed step is re-added on reconcile (policy choice — see ADR 0001)',
      );
    });

    it('inert legacy wrap.steps/wrap.captureFields reconcilers skip when bundled drops the legacy block (#139 Chunk 2)', () => {
      // After #139 migrates bundled templates from `wrap` to `wrap_pipeline`,
      // the legacy reconciler entries remain in ARRAY_RECONCILERS as a
      // safety net for live templates that still have a `wrap` block from
      // before the migration. With no bundled `wrap.steps`, the reconciler
      // must short-circuit (Array.isArray check) and leave the live wrap
      // block untouched. Pins this safety-net behavior.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap_pipeline: {
          steps: [{ id: 'commit', kind: 'commit' }]
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { command: null, steps: ['legacy-step'], captureFields: ['legacy-field'] }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      // wrap block is preserved as-is; wrap_pipeline is added from bundled
      assert.deepStrictEqual(merged.wrap, { command: null, steps: ['legacy-step'], captureFields: ['legacy-field'] });
      assert.deepStrictEqual(merged.wrap_pipeline.steps.map((s) => s.id), ['commit']);
    });
  });

  describe('_mergeBundledHookEntries (#158)', () => {
    it('backfills missing requires onto live hook entries matched by matcher (canonical #158 incident shape)', () => {
      const bundled = {
        id: 'prawduct',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      };
      const live = {
        id: 'prawduct',
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              // NO requires — pre-#146 shape
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      };
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, true, 'should report a change');
      assert.deepStrictEqual(live.hooks.claude.SessionStart[0].requires, ['tools/product-hook']);
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/product-hook']);
      // Inner hooks array preserved verbatim
      assert.equal(live.hooks.claude.Stop[0].hooks[0].command, 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop');
    });

    it('does NOT overwrite an existing requires on live (additive only, never overwrites)', () => {
      const bundled = {
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/bundled-tool'] }] } }
      };
      const live = {
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/user-customized'] }] } }
      };
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, false, 'no key added → no change reported');
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/user-customized']);
    });

    it('preserves user-added keys not present in bundled', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [{ matcher: 'startup', requires: ['tools/x'] }] } }
      };
      const live = {
        hooks: { claude: { SessionStart: [{ matcher: 'startup', userCustom: 'preserve me' }] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      assert.equal(live.hooks.claude.SessionStart[0].userCustom, 'preserve me');
      assert.deepStrictEqual(live.hooks.claude.SessionStart[0].requires, ['tools/x']);
    });

    it('does NOT cross-match entries with different matchers', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [{ matcher: 'startup', requires: ['tools/a'] }] } }
      };
      const live = {
        hooks: { claude: { SessionStart: [{ matcher: 'resume' }] } }
      };
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, false, 'matcher mismatch → no backfill');
      assert.equal('requires' in live.hooks.claude.SessionStart[0], false);
    });

    it('does NOT insert bundled-only entries that have no live match', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [
          { matcher: 'startup', requires: ['tools/a'] },
          { matcher: 'resume', requires: ['tools/b'] }
        ] } }
      };
      const live = {
        hooks: { claude: { SessionStart: [{ matcher: 'startup' }] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      // First entry backfilled
      assert.deepStrictEqual(live.hooks.claude.SessionStart[0].requires, ['tools/a']);
      // Second bundled entry NOT inserted
      assert.equal(live.hooks.claude.SessionStart.length, 1, 'bundled-only entry must not be added');
    });

    it('falls back to index match when both sides lack a string matcher', () => {
      const bundled = {
        hooks: { claude: { Stop: [{ requires: ['tools/x'] }] } }
      };
      const live = {
        hooks: { claude: { Stop: [{ hooks: [{ command: 'foo' }] }] } }
      };
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, true);
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/x']);
      assert.equal(live.hooks.claude.Stop[0].hooks[0].command, 'foo');
    });

    it('matches entries by matcher regardless of array position', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [
          { matcher: 'startup', requires: ['tools/a'] },
          { matcher: 'resume', requires: ['tools/b'] }
        ] } }
      };
      const live = {
        hooks: { claude: { SessionStart: [
          { matcher: 'resume' },  // reversed order from bundled
          { matcher: 'startup' }
        ] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      assert.deepStrictEqual(live.hooks.claude.SessionStart[0].requires, ['tools/b'],
        'resume entry (at live index 0) gets resume requires');
      assert.deepStrictEqual(live.hooks.claude.SessionStart[1].requires, ['tools/a'],
        'startup entry (at live index 1) gets startup requires');
      // Live order preserved — entries are not reordered.
      assert.equal(live.hooks.claude.SessionStart[0].matcher, 'resume');
      assert.equal(live.hooks.claude.SessionStart[1].matcher, 'startup');
    });

    it('handles duplicate matchers on live via FIFO index queue (acknowledged limitation)', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [
          { matcher: 'startup', requires: ['tools/first'] },
          { matcher: 'startup', requires: ['tools/second'] }
        ] } }
      };
      const live = {
        hooks: { claude: { SessionStart: [
          { matcher: 'startup', tag: 'live-A' },
          { matcher: 'startup', tag: 'live-B' }
        ] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      assert.deepStrictEqual(live.hooks.claude.SessionStart[0].requires, ['tools/first']);
      assert.deepStrictEqual(live.hooks.claude.SessionStart[1].requires, ['tools/second']);
      // Tags preserved — live entries identified by appearance order, not destroyed.
      assert.equal(live.hooks.claude.SessionStart[0].tag, 'live-A');
      assert.equal(live.hooks.claude.SessionStart[1].tag, 'live-B');
    });

    it('fails open on malformed nested shapes (e.g. live.hooks.claude.SessionStart is not an array)', () => {
      const bundled = {
        hooks: { claude: { SessionStart: [{ matcher: 'startup', requires: ['tools/x'] }] } }
      };
      const live = {
        hooks: { claude: { SessionStart: 'not-an-array' } }
      };
      assert.doesNotThrow(() => store._mergeBundledHookEntries(bundled, live));
      // Malformed value preserved untouched
      assert.equal(live.hooks.claude.SessionStart, 'not-an-array');
    });

    it('reconciles multiple engines independently when bundled defines both', () => {
      const bundled = {
        hooks: {
          claude: { Stop: [{ matcher: '', requires: ['tools/claude-tool'] }] },
          codex: { Stop: [{ matcher: '', requires: ['tools/codex-tool'] }] }
        }
      };
      const live = {
        hooks: {
          claude: { Stop: [{ matcher: '' }] },
          codex: { Stop: [{ matcher: '' }] }
        }
      };
      store._mergeBundledHookEntries(bundled, live);
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/claude-tool']);
      assert.deepStrictEqual(live.hooks.codex.Stop[0].requires, ['tools/codex-tool']);
    });

    it('deep-clones backfilled values — later mutation of bundled does not leak into live', () => {
      const bundled = {
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/x'] }] } }
      };
      const live = {
        hooks: { claude: { Stop: [{ matcher: '' }] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      // Mutate bundled afterwards
      bundled.hooks.claude.Stop[0].requires.push('tools/y');
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/x'],
        'live must not share array reference with bundled');
    });

    it('no-op when live has no hooks block', () => {
      const bundled = {
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/x'] }] } }
      };
      const live = { id: 'prawduct' };  // no hooks key at all
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, false);
      assert.equal('hooks' in live, false, 'live.hooks not auto-created');
    });

    it('no-op when bundled has no hooks block', () => {
      const bundled = { id: 'prawduct' };
      const live = {
        hooks: { claude: { Stop: [{ matcher: '' }] } }
      };
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, false);
    });

    it('skips silently when live is missing an engine key that bundled defines (additive-at-entry-level contract)', () => {
      // Critic MAJOR-2: documented contract is "additive at entry level only".
      // When live has no entry for an engine that bundled defines, the helper
      // does NOT auto-create the engine block — that's `addMissing`'s job
      // upstream in _mergeBundledTemplate (which adds the bundled engine
      // block as a reference before this helper runs). Direct callers of the
      // exported helper that bypass _mergeBundledTemplate get silent skip,
      // not silent insert.
      const bundled = {
        hooks: { codex: { Stop: [{ matcher: '', requires: ['tools/codex-tool'] }] } }
      };
      const live = { hooks: {} };  // engine entirely absent on live
      const changed = store._mergeBundledHookEntries(bundled, live);
      assert.equal(changed, false, 'helper does not auto-add missing engine blocks');
      assert.equal('codex' in live.hooks, false, 'live.hooks.codex still absent — not silently inserted');
    });

    it('skips malformed bundled or live entries (null/string in the array) without throwing', () => {
      // Critic MINOR-3: defensive branches in the forEach loops are not
      // covered by other tests. Pin the contract: malformed entries are
      // skipped, well-formed entries still backfill correctly.
      const bundled = {
        hooks: { claude: { Stop: [null, { matcher: 'x', requires: ['tools/a'] }] } }
      };
      const live = {
        hooks: { claude: { Stop: ['malformed', { matcher: 'x' }] } }
      };
      assert.doesNotThrow(() => store._mergeBundledHookEntries(bundled, live));
      assert.deepStrictEqual(live.hooks.claude.Stop[1].requires, ['tools/a'],
        'well-formed entry still backfilled despite malformed sibling');
      assert.equal(live.hooks.claude.Stop[0], 'malformed',
        'malformed live entry left untouched');
    });

    it('does NOT recurse into entry.hooks[] inner command objects (entry-level keys only)', () => {
      // Critic MINOR-1: pin the documented entry-level-only contract.
      // bundled entry has statusMessage on its inner hook[0]; live entry
      // lacks it. The helper backfills entry-level keys but does NOT recurse
      // into the inner `hooks` array of command objects.
      const bundled = {
        hooks: { claude: { Stop: [{
          matcher: '',
          requires: ['tools/x'],
          hooks: [{ type: 'command', command: 'echo bundled', statusMessage: 'Bundled status' }]
        }] } }
      };
      const live = {
        hooks: { claude: { Stop: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'echo bundled' }]  // no statusMessage
        }] } }
      };
      store._mergeBundledHookEntries(bundled, live);
      assert.deepStrictEqual(live.hooks.claude.Stop[0].requires, ['tools/x'],
        'top-level requires backfilled');
      assert.equal('statusMessage' in live.hooks.claude.Stop[0].hooks[0], false,
        'inner hook[0].statusMessage NOT backfilled — entry-level keys only');
    });
  });

  describe('_mergeBundledTemplate hook-entry reconciliation integration (#158)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-tpl-158-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeJson(filename, obj) {
      const p = path.join(tmpDir, filename);
      fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
      return p;
    }

    it('end-to-end via _mergeBundledTemplate: pre-#146 live template gets requires backfilled, written back to disk', () => {
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['commit'] },
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              requires: ['tools/product-hook'],
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['commit'] },
        hooks: {
          claude: {
            SessionStart: [{
              matcher: 'startup|clear|resume',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear' }]
            }],
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }]
            }]
          }
        }
      });
      store._mergeBundledTemplate(bundled, live);
      const merged = JSON.parse(fs.readFileSync(live, 'utf8'));
      assert.deepStrictEqual(merged.hooks.claude.SessionStart[0].requires, ['tools/product-hook']);
      assert.deepStrictEqual(merged.hooks.claude.Stop[0].requires, ['tools/product-hook']);
    });

    it('no-op leaves file byte-identical when live already has requires (no rewrite when nothing to add)', () => {
      // Critic MINOR-2: mtime comparisons are unreliable on coarse-resolution
      // filesystems (HFS+, NFS). Byte-equal check is filesystem-agnostic.
      const bundled = writeJson('bundled.json', {
        id: 'prawduct',
        wrap: { steps: ['commit'] },
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/product-hook'] }] } }
      });
      const live = writeJson('live.json', {
        id: 'prawduct',
        wrap: { steps: ['commit'] },
        hooks: { claude: { Stop: [{ matcher: '', requires: ['tools/product-hook'] }] } }
      });
      const before = fs.readFileSync(live);
      store._mergeBundledTemplate(bundled, live);
      const after = fs.readFileSync(live);
      assert.ok(before.equals(after), 'no-op should not rewrite the file');
    });
  });
});
