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
      const tables = ['schema_version', 'projects', 'sessions', 'learnings', 'session_rules', 'session_rule_versions', 'activity_log', 'port_leases', 'project_groups', 'project_group_members', 'shared_documents', 'document_locks'];
      for (const table of tables) {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        assert.ok(row, `Table "${table}" should exist`);
      }
    });

    it('should seed schema version', () => {
      store.init();

      const db = store.getDb();
      const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      assert.equal(row.version, store.CURRENT_SCHEMA_VERSION);
    });

    it('should copy bundled engine profiles', () => {
      store.init();

      const engines = fs.readdirSync(path.join(tmpDir, 'engines'));
      assert.ok(engines.includes('claude.json'), 'Should have claude profile');
      assert.ok(engines.includes('codex.json'), 'Should have codex profile');
      assert.ok(engines.includes('aider.json'), 'Should have aider profile');
      assert.ok(engines.includes('antigravity.json'), 'Should have antigravity profile');
      assert.ok(!engines.includes('gemini.json'), 'gemini retired (#457)');
      assert.ok(!engines.includes('genesis.json'), 'genesis retired (#458)');
    });


    it('preserves operator-added custom engine profiles (files in user-local with no bundled counterpart)', () => {
      // #251 — canonical-source semantics overwrite drift in bundled-named
      // profiles but leave files alone that aren't shipped with TC. An
      // operator who hand-wrote `~/.tangleclaw/engines/my-custom.json` and
      // registered it via the (currently unused) `store.engines.save`
      // primitive must not see it disappear on restart.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      fs.writeFileSync(path.join(enginesDir, 'custom.json'), JSON.stringify({ id: 'custom' }));

      store.init();

      const engines = fs.readdirSync(enginesDir);
      assert.ok(engines.includes('custom.json'), 'operator-added engine must be preserved');
      // And bundled profiles must also exist alongside.
      assert.ok(engines.includes('claude.json'), 'bundled profiles must seed alongside operator-added');
    });

    it('canonical-source: stale on-disk engine profile gets overwritten from bundle (#251)', () => {
      // #251 root case: simulate a pre-#251 install whose runtime
      // codex.json is missing every field that bundled has added since.
      // Pre-#251 behaviour was add-missing-only (`_mergeBundledProfile`):
      // VALUE changes to existing keys silently stranded. Post-#251 the
      // bundled file wins outright — the whole profile is reconciled to
      // bundled content on startup.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const stale = {
        id: 'codex',
        name: 'Codex (stale label)',
        launch: { shellCommand: 'codex', args: [], env: {} }
      };
      fs.writeFileSync(path.join(enginesDir, 'codex.json'), JSON.stringify(stale, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'codex.json'), 'utf8'));
      const bundled = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')
      );
      assert.deepStrictEqual(updated, bundled,
        'runtime profile must match bundled byte-for-byte after canonical-source sync');
    });

    it('canonical-source: operator hand-edits to bundled profiles get clobbered with a warn (#251)', () => {
      // Pre-#251, operator hand-edits were preserved. Post-#251 they get
      // overwritten — engine profiles have no UI/API edit surface, so any
      // drift is treated as stale-from-prior-TC-version. The `log.warn`
      // emitted from `_syncBundledEngines` is the breadcrumb operators
      // get if they had intentionally hand-edited the file. To preserve
      // a custom value, the change has to land in `data/engines/`.
      const enginesDir = path.join(tmpDir, 'engines');
      fs.mkdirSync(enginesDir, { recursive: true });
      const handEdit = {
        id: 'codex',
        name: 'My Custom Codex',
        launch: { shellCommand: 'my-codex', args: ['--flag'], env: { CUSTOM: '1' } }
      };
      fs.writeFileSync(path.join(enginesDir, 'codex.json'), JSON.stringify(handEdit, null, 2));

      store.init();

      const updated = JSON.parse(fs.readFileSync(path.join(enginesDir, 'codex.json'), 'utf8'));
      const bundled = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')
      );
      assert.equal(updated.name, bundled.name,
        'operator hand-edit to `name` must be clobbered by canonical-source');
      assert.equal(updated.launch.shellCommand, bundled.launch.shellCommand,
        'operator hand-edit to `shellCommand` must be clobbered');
      assert.deepStrictEqual(updated, bundled,
        'whole profile reconciles to bundled');
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

    it('canonical-source strips stale ["2","Enter"] bypass preKeys from existing claude profile (#119 → #251)', () => {
      // #119 originally addressed this via a one-shot prune. #251 subsumes
      // the prune: canonical-source overwrite from bundled (which has no
      // preKeys on bypassPermissions) achieves the same end state without
      // a special-case branch.
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
      assert.ok(!('preKeys' in bypass), 'stale preKeys gone after canonical-source overwrite');
      assert.ok(!('preKeyDelay' in bypass), 'stale preKeyDelay gone after canonical-source overwrite');
    });

    it('canonical-source is idempotent across reboots (#119 → #251)', () => {
      // Once the profile matches bundled, a second init must not rewrite
      // it. The structural-equivalence check in `_engineProfileEquivalent`
      // (recursive sorted-keys canonicalization via `_canonicalize`) is
      // what makes this hold.
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

      assert.equal(afterFirst, afterSecond, 'Profile unchanged on second init (idempotent)');
    });

    it('canonical-source clobbers operator-customized bypass preKeys (#119 → #251 contract change)', () => {
      // Pre-#251 the prune was equality-matched against the EXACT
      // ["2","Enter"] default so operator-customized preKeys (e.g. ['y',
      // 'Enter'] for a forked Claude binary that still requires
      // confirmation) were preserved. #251 retires that contract:
      // canonical-source wins, the operator hand-edit gets clobbered, and
      // the operator must move the customization to `data/engines/claude.json`
      // to make it survive. The `log.warn` emitted from
      // `_syncBundledEngines` is the breadcrumb pointing at the overwrite.
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
      const bundled = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8')
      );
      assert.deepStrictEqual(updated, bundled,
        'custom preKeys clobbered — runtime profile now matches bundled byte-for-byte');
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
      it('never writes the "chose no login" record beside a login that is on (#803)', () => {
        // Every writer that turns a login on goes through here, so none can leave
        // the two disagreeing by forgetting to clear the record.
        const config = store.config.load();
        config.authEnabled = true;
        config.loginOptOutAt = '2026-09-10T12:00:00.000Z';
        store.config.save(config);
        assert.equal(store.config.load().loginOptOutAt, null);
        assert.equal(config.loginOptOutAt, null, 'the caller holds what was written');
      });

      it('keeps the record while the login is off', () => {
        const config = store.config.load();
        config.authEnabled = false;
        config.loginOptOutAt = '2026-09-10T12:00:00.000Z';
        store.config.save(config);
        assert.equal(store.config.load().loginOptOutAt, '2026-09-10T12:00:00.000Z');
      });

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

    describe('load projectsDir fallback (#2145)', () => {
      const { getLevel, setConsoleStream } = require('../lib/logger');
      let lines;
      let priorLevel;

      /**
       * Captured lines naming the keyless/blank-projectsDir legacy fallback.
       * @returns {string[]}
       */
      const fallbackLines = () => lines.filter((l) => /legacy ~\/Documents\/Projects fallback/.test(l));

      beforeEach(() => {
        lines = [];
        priorLevel = getLevel();
        setLevel('info');
        setConsoleStream({ write: (s) => lines.push(String(s)) });
      });

      afterEach(() => {
        setConsoleStream(null);
        setLevel(priorLevel);
      });

      it('treats a blank projectsDir the same as a missing key', () => {
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ projectsDir: '' }));
        assert.equal(store.config.load().projectsDir, store.LEGACY_PROJECTS_DIR);
      });

      it('treats a whitespace-only projectsDir the same as a missing key', () => {
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ projectsDir: '   ' }));
        assert.equal(store.config.load().projectsDir, store.LEGACY_PROJECTS_DIR);
      });

      it('stays on a chosen directory', () => {
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ projectsDir: '~/code' }));
        assert.equal(store.config.load().projectsDir, '~/code');
      });

      it('logs the fallback only when init() asks for it, never on an ordinary load()', () => {
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ serverPort: 3101 }));
        store.config.load();
        assert.deepEqual(fallbackLines(), [], 'a plain load() stays silent');
        store.init();
        assert.equal(fallbackLines().length, 1, 'init() logs the fallback once');
        assert.match(fallbackLines()[0], /no projectsDir key/);
      });

      it('names the blank case distinctly from the missing-key case', () => {
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ projectsDir: '' }));
        store.init();
        assert.equal(fallbackLines().length, 1);
        assert.match(fallbackLines()[0], /blank projectsDir/);
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

    // The wrapV2 flag is retired: the pipeline is the only wrap path, so
    // the default config must not re-seed the key. Stale keys on disk
    // still round-trip (the deep-merge preserves unknown keys) but no
    // reader consults them — pinned in sessions.test.js's retirement
    // block. These replace the #139 Chunk 11c default-flip pins.
    it('does not seed a wrapV2 key when the on-disk config omits it (flag retired)', () => {
      store.projectConfig.save(projectDir, { engine: 'claude' });
      const loaded = store.projectConfig.load(projectDir);
      assert.equal('wrapV2' in loaded, false,
        'the retired flag must not re-enter configs via the default merge');
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

// AUTH-3 (#1): prove the v20→v21 sessions.owner migration on a REAL old-schema DB,
// not just a fresh CREATE TABLE. Sibling top-level describe so the main suite's
// beforeEach (which runs store.init at current schema) doesn't pre-create the column.
describe('sessions v20→v21 owner migration (AUTH-3, #1)', () => {
  it('adds the owner column to a pre-existing sessions table; old rows read null, new rows persist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sessions-owner-mig-'));
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(tmpDir, 'tangleclaw.db');
      const seed = new DatabaseSync(dbPath);
      // Seed a v20 DB: schema_version pinned at 20, a projects row, and a sessions
      // table WITHOUT the owner column + one pre-AUTH-3 row. store.init() then fires
      // the v20→v21 ALTER.
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (20);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          engine_id TEXT,
          methodology TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO projects (id, name, path) VALUES (1, 'pre-auth3', '/tmp/pre-auth3');
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          engine_id TEXT NOT NULL,
          tmux_session TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          wrap_summary TEXT,
          prime_prompt TEXT,
          methodology_phase TEXT,
          duration_seconds INTEGER,
          session_mode TEXT NOT NULL DEFAULT 'tmux',
          launch_mode TEXT,
          wrap_started_at TEXT
        );
        INSERT INTO sessions (project_id, engine_id, tmux_session) VALUES (1, 'claude', 'pre-auth3-sess');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      assert.equal(db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get().version, store.CURRENT_SCHEMA_VERSION);

      // The pre-AUTH-3 row gained the column with a NULL value (unauthenticated == null).
      const old = store.sessions.get(1);
      assert.equal(old.owner, null);

      // A new session can be stamped with an owner and round-trips it.
      const fresh = store.sessions.start({ projectId: 1, engineId: 'claude', tmuxSession: 'post-auth3', owner: 'jason' });
      assert.equal(store.sessions.get(fresh.id).owner, 'jason');
      // Default stays null when no owner is supplied (direct mode).
      const unowned = store.sessions.start({ projectId: 1, engineId: 'claude', tmuxSession: 'post-auth3-b' });
      assert.equal(store.sessions.get(unowned.id).owner, null);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('reading a stored launch blocker (#2201)', () => {
  const { getLevel, setConsoleStream } = require('../lib/logger');
  let tmpDir;
  let session;
  let lines;
  let priorLevel;

  /**
   * Write a raw value into the session's launch_blocker column, bypassing
   * setLaunchBlocker, the way a damaged or hand-edited row would hold it.
   * @param {string|null} raw - Column value to store
   */
  const writeRaw = (raw) => {
    store.getDb().prepare('UPDATE sessions SET launch_blocker = ? WHERE id = ?').run(raw, session.id);
  };

  /**
   * The captured lines that are this module's launch-blocker warning.
   * @returns {string[]}
   */
  const warnings = () => lines.filter((l) => /launch blocker could not be read/.test(l));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-blocker-'));
    store._setBasePath(tmpDir);
    store.init();
    const project = store.projects.create({ name: 'blocker', path: path.join(tmpDir, 'blocker'), engine: 'claude' });
    session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'blocker' });
    lines = [];
    priorLevel = getLevel();
    setLevel('warn');
    setConsoleStream({ write: (s) => lines.push(String(s)) });
  });

  afterEach(() => {
    setConsoleStream(null);
    setLevel(priorLevel);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a missing blocker as null without a log line', () => {
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    assert.deepEqual(warnings(), []);
  });

  it('reads a valid blocker as parsed without a log line', () => {
    writeRaw(JSON.stringify({ code: 'trust_prompt', label: 'Trust prompt', meaning: 'm', engineId: 'claude', observedAt: '2026-10-17T00:00:00Z' }));
    assert.deepEqual(store.sessions.get(session.id).launchBlocker, {
      code: 'trust_prompt', label: 'Trust prompt', meaning: 'm', engineId: 'claude', observedAt: '2026-10-17T00:00:00Z'
    });
    assert.deepEqual(warnings(), []);
  });

  it('warns once for a value that is not JSON, naming the session, the reason and the length, never the value', () => {
    const raw = '{"code": "secret-ish not json';
    writeRaw(raw);
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    const first = warnings();
    assert.equal(first.length, 1, 'one line on the first read');
    assert.match(first[0], /not JSON/);
    assert.match(first[0], new RegExp(`sessionId=${session.id}\\b`));
    assert.match(first[0], new RegExp(`length=${raw.length}\\b`));
    assert.doesNotMatch(first[0], /secret-ish/, 'the raw value is never logged');

    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    assert.equal(warnings().length, 1, 'reading the same damaged row again logs nothing more');
  });

  it('warns once for parsed JSON that names no code', () => {
    writeRaw(JSON.stringify({ label: 'no code here' }));
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    const got = warnings();
    assert.equal(got.length, 1);
    assert.match(got[0], /no code/);
    assert.doesNotMatch(got[0], /no code here/, 'the raw value is never logged');
  });

  it('warns again for a different damaged value on the same session, once', () => {
    writeRaw('not json one');
    store.sessions.get(session.id);
    writeRaw('{"code": 7}');
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    const got = warnings();
    assert.equal(got.length, 2);
    assert.match(got[0], /not JSON/);
    assert.match(got[1], /no code/);
  });

  it('keys the memory by session: the same damaged value on another session warns for it too', () => {
    const other = store.sessions.start({ projectId: session.projectId, engineId: 'claude', tmuxSession: 'blocker-2' });
    writeRaw('broken');
    store.getDb().prepare('UPDATE sessions SET launch_blocker = ? WHERE id = ?').run('broken', other.id);
    store.sessions.get(session.id);
    store.sessions.get(other.id);
    store.sessions.get(session.id);
    assert.equal(warnings().length, 2);
  });

  it('forgets what it warned about when the store closes, so a reopened database warns for its own rows', () => {
    writeRaw('damaged before close');
    store.sessions.get(session.id);
    assert.equal(warnings().length, 1);
    store.close();
    store.init();
    assert.equal(store.sessions.get(session.id).launchBlocker, null);
    assert.equal(warnings().length, 2, 'the same session id and value warn again after close and reopen');
  });

  it('bounds its memory: when the cap is reached it is cleared, so an early value warns again', () => {
    const cap = store._LAUNCH_BLOCKER_WARN_CAP;
    assert.ok(Number.isInteger(cap) && cap > 0, 'the cap is a documented positive integer');
    writeRaw('damaged 0');
    store.sessions.get(session.id);
    for (let i = 1; i < cap; i++) {
      writeRaw(`damaged ${i}`);
      store.sessions.get(session.id);
    }
    assert.equal(warnings().length, cap, 'every distinct value warned once while under the cap');
    writeRaw('damaged 0');
    store.sessions.get(session.id);
    assert.equal(warnings().length, cap, 'at the cap and not yet cleared, a remembered value stays quiet');
    writeRaw(`damaged ${cap}`);
    store.sessions.get(session.id);
    writeRaw('damaged 0');
    store.sessions.get(session.id);
    assert.equal(warnings().length, cap + 2, 'the memory was cleared when full, so the first value warns again');
  });
});

// #2248: the schema lives in `lib/store/_schema.js` and must never
// require the facade (Architect A404): that cycle would evaluate the migration
// chain against a half-built export object. The one domain api the chain calls,
// `projectConfigApi` inside `_migrateDropMethodology`, reaches it by injection
// from the facade's `init()`. Both halves are pinned: the source never requires
// the facade, and the drop-methodology migration still seeds a project through
// the injected api on a real pre-v28 database, so the injection is proven live
// at the point the chain reaches it.
describe('the schema module and the facade seam (#2248)', () => {
  const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store', '_schema.js'), 'utf8');
  const facadeSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');

  it('lib/store/_schema.js requires no facade: what it calls into is injected before the chain runs', () => {
    assert.doesNotMatch(schemaSrc, /require\(['"]\.\.\/store(\.js)?['"]\)/, 'the schema must not require lib/store.js');
    assert.doesNotMatch(schemaSrc, /require\(['"]\.\/index(\.js)?['"]\)/, 'nor a facade under another name');
    assert.match(schemaSrc, /projectConfigApi = deps \? deps\.projectConfigApi : null/, 'projectConfigApi arrives through _bind');
    const bind = facadeSrc.indexOf('schema._bind({ db: _db, dbFile: _dbFile, projectConfigApi, SESSION_STATUS });');
    const create = facadeSrc.indexOf('\n  _createTables();');
    assert.ok(bind !== -1, 'the facade binds the schema');
    assert.ok(create !== -1 && bind < create, 'and does so before the chain runs');
  });

  it('every module under lib/store/ that exports _bind is bound by the facade and guards its own handle', () => {
    // The slip `BOUND_MODULES` exists to catch is a module the facade requires
    // but never binds. Nothing at runtime can tell "forgotten" from "closed", so
    // the contract is read off the sources: each binder is required by the
    // facade and either bound by name in `init()` or listed in `BOUND_MODULES`;
    // and a domain module guards over its OWN `_db`, because the shared guard
    // in `_db.js` would pass for a module whose handle was never bound.
    const dir = path.join(__dirname, '..', 'lib', 'store');
    const boundList = facadeSrc.match(/const BOUND_MODULES = \[([^\]]*)\];/);
    assert.ok(boundList, 'the facade declares BOUND_MODULES');
    const listed = boundList[1].split(',').map((s) => s.trim()).filter(Boolean);
    // The by-name arm reads init()'s body only: `close()` also calls `_bind(null)`,
    // and a module unbound there but never bound in init() must not pass.
    const initStart = facadeSrc.indexOf('\nfunction init() {');
    assert.ok(initStart !== -1, 'the facade defines init()');
    const initBody = facadeSrc.slice(initStart, facadeSrc.indexOf('\n}\n', initStart));
    const binders = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const exports = src.slice(src.lastIndexOf('module.exports'));
      return /\b_bind\b/.test(exports);
    });
    assert.ok(binders.length >= 3, `the handle, the schema and at least one domain export _bind (${binders.join(', ')})`);
    for (const file of binders) {
      const mod = file.replace(/\.js$/, '');
      const required = facadeSrc.match(new RegExp(`\\nconst (\\w+) = require\\('\\./store/${mod}'\\);`));
      assert.ok(required, `${file} is required by the facade`);
      const name = required[1];
      const byName = new RegExp(`\\n\\s+${name}\\._bind\\(`).test(initBody);
      assert.ok(byName || listed.includes(name), `${file} is bound by init(): by name or through BOUND_MODULES`);
      if (!file.startsWith('_')) {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.match(src, /\nfunction _ensureDb\(\) \{\n  if \(!_db\) \{/, `${file} guards over its own handle, not the handle module's`);
        assert.doesNotMatch(src, /\{[^}]*\b_ensureDb\b[^}]*\} = require\('\.\/_db'\)/, `${file} does not import the shared guard`);
      }
    }
  });

  it('a pre-v28 store with a minimal project is seeded through the injected api and loses the column', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drop-methodology-'));
    try {
      const { DatabaseSync } = require('node:sqlite');
      // A real project directory: the migration seeds its project.json through
      // `projectConfigApi.load`/`.save`, which is the injected api under test.
      const projectDir = path.join(tmpDir, 'minimal-project');
      fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), '{}\n');
      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (20);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          engine_id TEXT,
          methodology TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_projects_methodology ON projects(methodology);
        INSERT INTO projects (id, name, path, methodology)
          VALUES (1, 'minimal-project', '${projectDir.replace(/'/g, "''")}', 'minimal');
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          engine_id TEXT NOT NULL,
          tmux_session TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          wrap_summary TEXT,
          prime_prompt TEXT,
          methodology_phase TEXT,
          duration_seconds INTEGER,
          session_mode TEXT NOT NULL DEFAULT 'tmux',
          launch_mode TEXT,
          wrap_started_at TEXT
        );
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION,
        'the whole ladder ran');
      assert.ok(!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'methodology'),
        'projects.methodology is dropped');
      const seeded = JSON.parse(fs.readFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), 'utf8'));
      assert.equal(seeded.wrapOverridesSeeded, true, 'the injected projectConfigApi.save wrote the one-shot marker');
      assert.ok(Object.keys(seeded.wrapStepOverrides || {}).length > 0, 'and the commit-only wrap overrides');
      assert.ok(fs.existsSync(path.join(tmpDir, 'tangleclaw.db.pre-v28-backup')),
        'the pre-v28 snapshot sits beside the database the injected dbFile names');
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // #2232 — a present-but-unusable project.json (parses, but not a plain
  // object; does not parse at all; or parses as a plain object whose merge
  // still fails deeper) must be left exactly as it is: counted, logged, and
  // never overwritten with the seeded defaults. Before this, the migration's
  // own raw read only caught a JSON.parse failure — a value that parsed fine
  // but wasn't an object (`[1,2,3]`) fell through the
  // `onDisk.wrapOverridesSeeded` check (reads `undefined` on an array, same as
  // "not yet seeded") all the way to the save that clobbers it. The R1 review
  // round (PR #2684) caught a second, deeper gap: an object-shaped root
  // (`{"rules":null,...}`) passes that top-level guard, but the second,
  // lax `projectConfigApi.load(row.path)` call — with no `onError` — can
  // still throw internally on a field like `rules.core` and silently hand
  // back defaults, which the migration then saved over the original file.
  it('a pre-v28 project with a non-object or corrupt project.json is skipped, not clobbered', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drop-methodology-unreadable-'));
    try {
      const { DatabaseSync } = require('node:sqlite');
      const arrayProjectDir = path.join(tmpDir, 'array-project');
      fs.mkdirSync(path.join(arrayProjectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(arrayProjectDir, '.tangleclaw', 'project.json'), '[1,2,3]');

      const corruptProjectDir = path.join(tmpDir, 'corrupt-project');
      fs.mkdirSync(path.join(corruptProjectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(corruptProjectDir, '.tangleclaw', 'project.json'), '{not valid json');

      // R1 A-Gate/R-Gate regression (PR #2684): an OBJECT-shaped root passes
      // the migration's own top-level guard, but `project-config.js#load`'s
      // merge can still throw deeper — `rules: null` fails merging
      // `rules.core` — and the lax loader used to catch that internally and
      // hand back silent defaults, which the migration then saved over this
      // exact file, discarding `operatorValue`.
      const deepMergeFailDir = path.join(tmpDir, 'deep-merge-fail-project');
      fs.mkdirSync(path.join(deepMergeFailDir, '.tangleclaw'), { recursive: true });
      const deepMergeFailBody = JSON.stringify({ rules: null, operatorValue: 'preserve' });
      fs.writeFileSync(path.join(deepMergeFailDir, '.tangleclaw', 'project.json'), deepMergeFailBody);

      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (20);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL,
          engine_id TEXT,
          methodology TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_projects_methodology ON projects(methodology);
        INSERT INTO projects (id, name, path, methodology)
          VALUES (1, 'array-project', '${arrayProjectDir.replace(/'/g, "''")}', 'minimal');
        INSERT INTO projects (id, name, path, methodology)
          VALUES (2, 'corrupt-project', '${corruptProjectDir.replace(/'/g, "''")}', 'minimal');
        INSERT INTO projects (id, name, path, methodology)
          VALUES (3, 'deep-merge-fail-project', '${deepMergeFailDir.replace(/'/g, "''")}', 'minimal');
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          engine_id TEXT NOT NULL,
          tmux_session TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          wrap_summary TEXT,
          prime_prompt TEXT,
          methodology_phase TEXT,
          duration_seconds INTEGER,
          session_mode TEXT NOT NULL DEFAULT 'tmux',
          launch_mode TEXT,
          wrap_started_at TEXT
        );
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION,
        'the ladder still runs to completion despite three unusable configs');

      assert.equal(fs.readFileSync(path.join(arrayProjectDir, '.tangleclaw', 'project.json'), 'utf8'), '[1,2,3]',
        'a non-object project.json must survive byte-for-byte');
      assert.equal(fs.readFileSync(path.join(corruptProjectDir, '.tangleclaw', 'project.json'), 'utf8'), '{not valid json',
        'a corrupt project.json must survive byte-for-byte');
      assert.equal(fs.readFileSync(path.join(deepMergeFailDir, '.tangleclaw', 'project.json'), 'utf8'), deepMergeFailBody,
        'an object-shaped config whose merge fails deeper must survive byte-for-byte, including operatorValue');
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
