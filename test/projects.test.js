'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const engines = require('../lib/engines');

describe('projects', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-projects-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    // Set projectsDir in config
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateName', () => {
    it('accepts valid names', async () => {
      assert.ok(projects.validateName('my-project').valid);
      assert.ok(projects.validateName('Project_1').valid);
      assert.ok(projects.validateName('test123').valid);
    });

    it('rejects empty names', async () => {
      assert.equal(projects.validateName('').valid, false);
      assert.equal(projects.validateName(null).valid, false);
      assert.equal(projects.validateName(undefined).valid, false);
    });

    it('accepts names with spaces', async () => {
      assert.equal(projects.validateName('my project').valid, true);
      assert.equal(projects.validateName('TiLT v2').valid, true);
    });

    it('rejects names with special characters', async () => {
      assert.equal(projects.validateName('my/project').valid, false);
      assert.equal(projects.validateName('my.project').valid, false);
      assert.equal(projects.validateName('project!').valid, false);
    });

    it('rejects names over 64 characters', async () => {
      assert.equal(projects.validateName('a'.repeat(65)).valid, false);
    });

    it('accepts names exactly 64 characters', async () => {
      assert.ok(projects.validateName('a'.repeat(64)).valid);
    });
  });

  describe('password hashing', () => {
    it('hashPassword produces salt:hash format', async () => {
      const hashed = projects.hashPassword('test123');
      assert.ok(hashed.includes(':'));
      const [salt, hash] = hashed.split(':');
      assert.equal(salt.length, 32); // 16 bytes hex
      assert.equal(hash.length, 128); // 64 bytes hex
    });

    it('verifyPassword returns true for matching password', async () => {
      const hashed = projects.hashPassword('mysecret');
      assert.ok(projects.verifyPassword('mysecret', hashed));
    });

    it('verifyPassword returns false for wrong password', async () => {
      const hashed = projects.hashPassword('mysecret');
      assert.equal(projects.verifyPassword('wrong', hashed), false);
    });

    it('verifyPassword returns false for null inputs', async () => {
      assert.equal(projects.verifyPassword(null, null), false);
      assert.equal(projects.verifyPassword('test', null), false);
      assert.equal(projects.verifyPassword(null, 'hash'), false);
    });

    it('verifyPassword returns false for invalid hash format', async () => {
      assert.equal(projects.verifyPassword('test', 'nocolon'), false);
    });
  });

  describe('checkDeletePassword', () => {
    it('allows when no password configured', async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.ok(result.allowed);
    });

    it('requires password when configured', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('secret');
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('required'));
    });

    it('allows correct password', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('correct');
      assert.ok(result.allowed);
    });

    it('rejects incorrect password', async () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('wrong');
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('Incorrect'));
    });

    it('upgrades plaintext password to hash', async () => {
      const config = store.config.load();
      config.deletePassword = 'plaintext';
      store.config.save(config);

      const result = projects.checkDeletePassword('plaintext');
      assert.ok(result.allowed);

      // Verify it was upgraded
      const updatedConfig = store.config.load();
      assert.ok(updatedConfig.deletePassword.includes(':'));
    });
  });

  describe('createProject', () => {
    it('creates a project with directory and config', async () => {
      const result = projects.createProject({
        name: 'new-project'
      });

      assert.ok(result.project);
      assert.equal(result.project.name, 'new-project');
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project')));
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project', '.tangleclaw', 'project.json')));
    });

  
    it('does not seed wrap overrides for a prawduct project', async () => {
      const result = projects.createProject({
        name: 'no-seed-prawduct'
      });
      assert.ok(result.project);
      const cfg = JSON.parse(fs.readFileSync(
        path.join(projectsDir, 'no-seed-prawduct', '.tangleclaw', 'project.json'), 'utf8'));
      assert.equal(cfg.wrapOverridesSeeded, undefined);
      assert.deepEqual(cfg.wrapStepOverrides, {});
    });

    it('creates session memory directory and seed file', async () => {
      const result = projects.createProject({
        name: 'memory-project'
      });
      assert.ok(result.project);
      const memoriesDir = path.join(projectsDir, 'memory-project', '.tangleclaw', 'memories');
      assert.ok(fs.existsSync(memoriesDir), 'memories directory should exist');
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');
      assert.ok(fs.existsSync(memoryFile), 'MEMORY.md should exist');
      const content = fs.readFileSync(memoryFile, 'utf8');
      assert.ok(content.includes('Session Memory'));
    });

    it('rejects invalid names', async () => {
      const result = projects.createProject({ name: 'bad name!' });
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });

    it('rejects duplicate projects', async () => {
      projects.createProject({ name: 'dupe-proj' });
      const result = projects.createProject({ name: 'dupe-proj' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects when directory exists', async () => {
      fs.mkdirSync(path.join(projectsDir, 'existing-dir'), { recursive: true });
      const result = projects.createProject({ name: 'existing-dir' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects unknown engine', async () => {
      const result = projects.createProject({ name: 'bad-engine', engine: 'nonexistent' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

  
    it('applies methodology default rules', async () => {
      const result = projects.createProject({
        name: 'rules-project'
      });

      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      // Core rules should always be true
      assert.equal(projConfig.rules.core.changelogPerChange, true);
      assert.equal(projConfig.rules.core.jsdocAllFunctions, true);
    });

    it('passes tags to project', async () => {
      const result = projects.createProject({
        name: 'tagged-project',
        tags: ['node', 'active']
      });

      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['node', 'active']);
    });

    it('skips git init when gitInit is false', async () => {
      const result = projects.createProject({
        name: 'no-git',
        gitInit: false
      });

      assert.ok(result.project);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'no-git', '.git')));
    });

    describe('case-insensitive duplicate rejection (#221, sibling to #188)', () => {
      it('rejects creating "Foo-Case" when "foo-case" already exists (lowercase first)', async () => {
        const first = projects.createProject({ name: 'foo-case' });
        assert.ok(first.project, 'lowercase precondition project created');

        const dup = projects.createProject({ name: 'Foo-Case' });
        assert.equal(dup.project, null, 'mixed-case dup must be rejected');
        assert.equal(dup.errors.length, 1);
        // Error message reflects the existing project's actual casing so
        // the operator can find it in the projects list.
        assert.match(dup.errors[0], /foo-case/);
        assert.match(dup.errors[0], /case-insensitive/i,
          'error must call out the case-collision so the operator understands the rejection reason');
      });

      it('rejects creating "case-second" when "Case-Second" already exists (mixed-case first)', async () => {
        const first = projects.createProject({ name: 'Case-Second' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'case-second' });
        assert.equal(dup.project, null);
        assert.match(dup.errors[0], /Case-Second/, 'error names the existing project');
      });

      it('preserves the original-casing error format when names match exactly (back-compat)', async () => {
        const first = projects.createProject({ name: 'exact-match' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'exact-match' });
        assert.equal(dup.project, null);
        // When the case matches exactly, the legacy error format is preserved
        // — no spurious "case-insensitive match" suffix that would suggest
        // a casing difference where none exists.
        assert.equal(dup.errors[0], 'Project "exact-match" already exists');
      });

      it('attachProject also rejects case-collision (#221 symmetric gate audit)', async () => {
        // Create a project, then create a sibling directory with case-only
        // difference, then try to attach that directory. The attach path
        // must reject for the same reason createProject does — otherwise
        // attach is the case-collision back door.
        projects.createProject({ name: 'attach-case' });
        const otherDir = path.join(projectsDir, 'Attach-Case');
        // Skip the test if the OS already collapsed the directory name
        // (case-insensitive filesystem) — the attach path would hit the
        // generic "already exists" fs error before reaching the case-collision
        // guard. The guard still gets exercised on case-sensitive filesystems
        // and via the store-level test below.
        try { fs.mkdirSync(otherDir); } catch { return; }
        try {
          const result = projects.attachProject('Attach-Case');
          assert.equal(result.project, null, 'attach must reject case-collision');
          assert.match(result.errors[0], /already registered/);
          assert.match(result.errors[0], /case-insensitive|attach-case/i,
            'error must cite the existing project or call out the case-collision');
        } finally {
          fs.rmSync(otherDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('getProject / listProjects', () => {
    it('getProject returns enriched project', async () => {
      const project = projects.getProject('new-project');
      assert.ok(project);
      assert.equal(project.name, 'new-project');
      assert.ok(project.hasOwnProperty('engine'));
      assert.ok(project.hasOwnProperty('actions'));
      assert.ok(project.hasOwnProperty('session'));
      assert.ok(project.hasOwnProperty('git'));
      assert.ok(project.hasOwnProperty('governanceState'));
    });

    it('getProject returns null for unknown', async () => {
      assert.equal(projects.getProject('nonexistent'), null);
    });

    it('listProjects returns array of enriched projects', async () => {
      const list = projects.listProjects();
      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
      assert.ok(list[0].hasOwnProperty('engine'));
    });

    it('listProjects filters by tag', async () => {
      const list = projects.listProjects({ tag: 'node' });
      for (const p of list) {
        assert.ok(p.tags.includes('node'));
      }
    });
  });

  describe('enrichProject — governanceState (#353)', () => {
    let govDir;

    before(() => {
      govDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-proj-gov-'));
    });

    after(() => {
      fs.rmSync(govDir, { recursive: true, force: true });
    });

    function makeProject(name, { engine = 'claude', methodology = 'prawduct', settings, vendored } = {}) {
      const projPath = path.join(govDir, name);
      fs.mkdirSync(projPath, { recursive: true });
      if (settings) {
        fs.mkdirSync(path.join(projPath, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(projPath, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
      }
      if (vendored) {
        fs.mkdirSync(path.join(projPath, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(projPath, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');
      }
      store.projects.create({ name, path: projPath, engine, methodology });
      return projPath;
    }

    it('surfaces ungoverned for a Claude project with no governance installed', async () => {
      makeProject('gov-drift');
      assert.equal(projects.getProject('gov-drift').governanceState, 'ungoverned');
    });

    it('surfaces governed-plugin once the V2 plugin ref is present', async () => {
      makeProject('gov-plugin', { settings: { enabledPlugins: { 'prawduct@prawduct': true } } });
      assert.equal(projects.getProject('gov-plugin').governanceState, 'governed-plugin');
    });

    it('surfaces not-applicable for a non-Claude project', async () => {
      makeProject('gov-na', { engine: 'gemini' });
      assert.equal(projects.getProject('gov-na').governanceState, 'not-applicable');
    });

    it('every listProjects entry carries a governanceState field', async () => {
      const list = projects.listProjects();
      assert.ok(list.length > 0);
      for (const p of list) {
        assert.ok(p.hasOwnProperty('governanceState'),
          `project ${p.name} missing governanceState`);
      }
    });
  });

  describe('syncAllProjects', () => {
    it('regenerates engine config for registered project', async () => {
      // new-project was created earlier in the test suite
      const projPath = path.join(projectsDir, 'new-project');
      const claudeMd = path.join(projPath, 'CLAUDE.md');

      // Delete existing config to confirm it gets regenerated
      if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd);
      assert.ok(!fs.existsSync(claudeMd));

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);
      assert.ok(fs.existsSync(claudeMd), 'CLAUDE.md should be regenerated');
      const content = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(content.includes('Session Memory'), 'Should include session memory guide');
    });

    it('creates memories directory for project missing it', async () => {
      const projPath = path.join(projectsDir, 'new-project');
      const memoriesDir = path.join(projPath, '.tangleclaw', 'memories');
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');

      // Remove memories dir if it exists
      if (fs.existsSync(memoriesDir)) fs.rmSync(memoriesDir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(memoriesDir));

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);
      assert.ok(fs.existsSync(memoriesDir), 'memories directory should be created');
      assert.ok(fs.existsSync(memoryFile), 'MEMORY.md should be seeded');
    });

    it('skips projects with missing paths without crashing', async () => {
      // Create a project pointing to a non-existent path
      store.projects.create({ name: 'ghost-project', path: '/tmp/nonexistent-tc-path-12345', engine: 'claude' });
      const result = projects.syncAllProjects();
      assert.ok(Array.isArray(result.errors));
      // Should not throw, ghost project is silently skipped
      assert.ok(result.synced >= 0);
    });

    it('regenerates from the DB engine, not projConfig, when project.json lacks an engine key', async () => {
      // Live-fleet bug found during the tilt retirement: codextest's DB said
      // `codex`, but its project.json had no `engine` key — boot-sync fell
      // back to claude (`project.engine` was also a dead field; store rows
      // expose `engineId`), regenerated a CLAUDE.md, and left the operative
      // .codex.yaml stale for weeks. DB is the single source of truth for the
      // engine, matching the methodology rule (#320) and the session-launch
      // path.
      const { project: proj } = projects.createProject({ name: 'db-engine-wins', engine: 'codex' });
      assert.equal(proj.engineId, 'codex');

      const projPath = path.join(projectsDir, 'db-engine-wins');
      const projConfig = store.projectConfig.load(projPath);
      delete projConfig.engine; // legacy project.json with no engine key
      store.projectConfig.save(projPath, projConfig);

      const codexYaml = path.join(projPath, '.codex.yaml');
      const claudeMd = path.join(projPath, 'CLAUDE.md');
      if (fs.existsSync(codexYaml)) fs.unlinkSync(codexYaml);
      if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd);

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);

      assert.ok(fs.existsSync(codexYaml),
        '.codex.yaml must be regenerated from the DB engine (codex)');
      assert.ok(!fs.existsSync(claudeMd),
        'no CLAUDE.md may be written for a codex project missing projConfig.engine');
    });

    it('defers to the Prawduct V2 plugin at boot: preserves the anchor AND strips the governance hook (#330)', async () => {
      // A project later onboarded to the V2 plugin: it carries the install
      // reference plus a leftover TC governance `.hooks` block and a plugin-owned
      // thin CLAUDE.md anchor. Boot-sync must NOT regenerate CLAUDE.md and MUST
      // strip the stale governance hooks (the gap the Critic flagged — boot-sync
      // previously called writeEngineConfig but not syncEngineHooks). silentPrime
      // is pinned off so this stays focused on governance-hook removal; the
      // L1-prime-preserved-on-a-governed-project case is covered in engines.test.js.
      projects.createProject({ name: 'plugin-governed-boot' });
      const projPath = path.join(projectsDir, 'plugin-governed-boot');
      fs.writeFileSync(path.join(projPath, '.tangleclaw', 'project.json'), JSON.stringify({
        engine: 'claude', methodology: 'prawduct', silentPrime: false
      }, null, 2) + '\n');
      const claudeDir = path.join(projPath, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        enabledPlugins: { 'prawduct@prawduct': true },
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }] }] }
      }, null, 2) + '\n');
      const claudeMd = path.join(projPath, 'CLAUDE.md');
      const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned by the Prawduct V2 plugin.\n';
      fs.writeFileSync(claudeMd, anchor);

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);

      assert.equal(fs.readFileSync(claudeMd, 'utf8'), anchor, 'plugin-owned CLAUDE.md must not be regenerated at boot');
      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      assert.equal(settings.hooks, undefined, 'stale governance hooks block must be stripped at boot (silentPrime off → no L1 to keep)');
      assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'plugin install reference must be preserved');
    });
  });

  describe('updateProject', () => {
    it('updates tags', async () => {
      const result = projects.updateProject('new-project', { tags: ['updated'] });
      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['updated']);
    });

    it('rejects core rule disabling', async () => {
      const result = projects.updateProject('new-project', {
        rules: { core: { changelogPerChange: false } }
      });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('Core rules'));
    });

    it('updates extension rules', async () => {
      const result = projects.updateProject('new-project', {
        rules: { extensions: { identitySentry: true } }
      });
      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.equal(projConfig.rules.extensions.identitySentry, true);
    });

    it('returns error for unknown project', async () => {
      const result = projects.updateProject('nonexistent', { tags: [] });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('updates quick commands', async () => {
      const cmds = [{ label: 'test', command: 'echo test' }];
      const result = projects.updateProject('new-project', { quickCommands: cmds });
      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.deepEqual(projConfig.quickCommands, cmds);
    });

    // CC-6 (#381): per-project wrap-section selection.
    it('persists a valid wrapSections selection + enriches it', async () => {
      const result = projects.updateProject('new-project', { wrapSections: ['Where we are', 'Next action', 'Freshness'] });
      assert.ok(result.project);
      assert.deepEqual(result.project.wrapSections, ['Where we are', 'Next action', 'Freshness']);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.deepEqual(projConfig.wrapSections, ['Where we are', 'Next action', 'Freshness']);
    });

    it('clears the wrapSections override when set to null (deep default)', async () => {
      projects.updateProject('new-project', { wrapSections: ['Freshness'] });
      const result = projects.updateProject('new-project', { wrapSections: null });
      assert.ok(result.project);
      assert.equal(result.project.wrapSections, null);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.equal(projConfig.wrapSections, null);
    });

    it('rejects wrapSections that is not an array or contains unknown names', async () => {
      const notArray = projects.updateProject('new-project', { wrapSections: 'Freshness' });
      assert.equal(notArray.project, null);
      assert.ok(notArray.errors[0].includes('wrapSections'));

      const bogus = projects.updateProject('new-project', { wrapSections: ['Where we are', 'Bogus'] });
      assert.equal(bogus.project, null);
      assert.ok(bogus.errors[0].includes('wrapSections'));
    });

    // MED-2K9P Chunk 02: per-project Medusa session-comms auto-enable.
    it('defaults medusaEnabled to false on enrich', async () => {
      const result = projects.updateProject('new-project', { tags: ['x'] });
      assert.ok(result.project);
      assert.equal(result.project.medusaEnabled, false);
    });

    it('persists medusaEnabled and round-trips it through enrich', async () => {
      const on = projects.updateProject('new-project', { medusaEnabled: true });
      assert.ok(on.project);
      assert.equal(on.project.medusaEnabled, true);
      assert.equal(store.projectConfig.load(on.project.path).medusaEnabled, true);

      const off = projects.updateProject('new-project', { medusaEnabled: false });
      assert.equal(off.project.medusaEnabled, false);
      assert.equal(store.projectConfig.load(off.project.path).medusaEnabled, false);
    });

    it('rejects a non-boolean medusaEnabled without mutating state', async () => {
      projects.updateProject('new-project', { medusaEnabled: true });
      const bad = projects.updateProject('new-project', { medusaEnabled: 'yes' });
      assert.equal(bad.project, null);
      assert.ok(bad.errors[0].includes('medusaEnabled'));
      // Prior true value is untouched by the rejected update.
      assert.equal(store.projectConfig.load(store.projects.getByName('new-project').path).medusaEnabled, true);
    });

    // MED-2K9P v2 T2: per-project idle-gated wake opt-in (same shape as medusaEnabled).
    it('defaults medusaWake to false on enrich', async () => {
      const result = projects.updateProject('new-project', { tags: ['x'] });
      assert.ok(result.project);
      assert.equal(result.project.medusaWake, false);
    });

    it('persists medusaWake and round-trips it through enrich', async () => {
      const on = projects.updateProject('new-project', { medusaWake: true });
      assert.ok(on.project);
      assert.equal(on.project.medusaWake, true);
      assert.equal(store.projectConfig.load(on.project.path).medusaWake, true);

      const off = projects.updateProject('new-project', { medusaWake: false });
      assert.equal(off.project.medusaWake, false);
      assert.equal(store.projectConfig.load(off.project.path).medusaWake, false);
    });

    it('rejects a non-boolean medusaWake without mutating state', async () => {
      projects.updateProject('new-project', { medusaWake: true });
      const bad = projects.updateProject('new-project', { medusaWake: 'yes' });
      assert.equal(bad.project, null);
      assert.ok(bad.errors[0].includes('medusaWake'));
      // Prior true value is untouched by the rejected update.
      assert.equal(store.projectConfig.load(store.projects.getByName('new-project').path).medusaWake, true);
    });

    // #428: per-project active-plan pick (the drawer plan-picker → activePlan).
    describe('activePlan (#428)', () => {
      let planDir;
      before(() => {
        planDir = path.join(projectsDir, 'new-project', '.claude', 'plans');
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(path.join(planDir, 'chosen.md'), '### Chunk 1: A\n');
      });

      it('persists a valid activePlan filename to project.json', async () => {
        const result = projects.updateProject('new-project', { activePlan: 'chosen.md' });
        assert.ok(result.project);
        const cfg = store.projectConfig.load(result.project.path);
        assert.equal(cfg.activePlan, 'chosen.md');
      });

      it('round-trips: priming-roll._readActivePlan reads back the persisted pick', async () => {
        const primingRoll = require('../lib/wrap-steps/priming-roll');
        projects.updateProject('new-project', { activePlan: 'chosen.md' });
        const projPath = path.join(projectsDir, 'new-project');
        assert.equal(primingRoll._readActivePlan(projPath), 'chosen.md');
      });

      it('clears activePlan when set to null', async () => {
        projects.updateProject('new-project', { activePlan: 'chosen.md' });
        const result = projects.updateProject('new-project', { activePlan: null });
        assert.ok(result.project);
        const cfg = store.projectConfig.load(result.project.path);
        assert.equal(cfg.activePlan, undefined, 'null must delete the key, not store null');
      });

      // #612: the validator must check the SAME directory the wrap step
      // resolves. Pinned to the legacy path it made the operator escape hatch
      // unsettable for any project following the current layout — the drawer
      // would offer plan candidates whose save was guaranteed to fail.
      it('accepts a plan in the TangleClaw-owned plans directory', async () => {
        const tcPlans = path.join(projectsDir, 'new-project', '.tangleclaw', 'plans');
        fs.mkdirSync(tcPlans, { recursive: true });
        fs.writeFileSync(path.join(tcPlans, 'current.md'), '### Chunk 1: A\n');
        try {
          const result = projects.updateProject('new-project', { activePlan: 'current.md' });
          assert.ok(result.project, `expected accept, got: ${JSON.stringify(result.errors)}`);
          const cfg = store.projectConfig.load(result.project.path);
          assert.equal(cfg.activePlan, 'current.md');
          projects.updateProject('new-project', { activePlan: null });
        } finally {
          fs.rmSync(tcPlans, { recursive: true, force: true });
        }
      });

      it('rejects a filename that does not exist under the resolved plans directory', async () => {
        const result = projects.updateProject('new-project', { activePlan: 'ghost.md' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /activePlan .* not found/);
      });

      it('rejects a non-.md filename even if the file exists', async () => {
        fs.writeFileSync(path.join(planDir, 'notes.txt'), 'x');
        const result = projects.updateProject('new-project', { activePlan: 'notes.txt' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /not found/);
      });

      it('rejects a path-bearing activePlan (traversal-safe)', async () => {
        const result = projects.updateProject('new-project', { activePlan: '../../etc/passwd' });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /bare plan filename/);
      });

      it('rejects a non-string activePlan', async () => {
        const result = projects.updateProject('new-project', { activePlan: 42 });
        assert.equal(result.project, null);
        assert.match(result.errors[0], /activePlan must be a string/);
      });
    });

    describe('rename — case-insensitive collision handling (#221, sibling to #188)', () => {
      it('allows a case-only self-rename at the DB-validator level (foo-1 → Foo-1)', (t) => {
        // Set up a discrete project so other tests' state doesn't interfere.
        projects.createProject({ name: 'self-rename-src' });

        // Case-only directory rename only works on case-sensitive filesystems.
        // On macOS APFS-CI (the common dev environment) `fs.existsSync` collapses
        // case, so the rename block's "directory already exists" guard at
        // `lib/projects.js:1294` blocks the rename. This is a separate FS-layer
        // concern from the DB-level validator gate we're testing here. Probe
        // case-sensitivity by checking whether the project's own directory
        // can be observed under its uppercased name.
        const srcProject = store.projects.getByName('self-rename-src');
        const upperPath = srcProject.path.replace(/self-rename-src$/, 'Self-Rename-Src');
        if (fs.existsSync(upperPath)) {
          t.skip('case-insensitive filesystem — DB-level self-rename gate is exercised in the cross-rename tests below');
          return;
        }

        const result = projects.updateProject('self-rename-src', { name: 'Self-Rename-Src' });
        assert.ok(result.project, 'case-only self-rename must be allowed by the validator');
        assert.equal(result.errors.length, 0);
        assert.equal(result.project.name, 'Self-Rename-Src',
          'the new name takes effect; existing project keeps its id (same row, new casing)');
      });

      it('rejects renaming to a name that case-collides with a DIFFERENT existing project', async () => {
        projects.createProject({ name: 'collision-dest' });
        projects.createProject({ name: 'rename-src' });

        const result = projects.updateProject('rename-src', { name: 'Collision-Dest' });
        assert.equal(result.project, null, 'cross-rename to a case-collision must be rejected');
        assert.ok(result.errors.length > 0);
        assert.match(result.errors[0], /collision-dest/, 'error cites the OTHER project');
        assert.match(result.errors[0], /case-insensitive/i,
          'error message calls out the case-collision so the operator understands the rejection');
      });

      it('preserves exact-case error format when rename target matches an existing name exactly', async () => {
        projects.createProject({ name: 'exact-rename-target' });
        projects.createProject({ name: 'rename-source-2' });

        const result = projects.updateProject('rename-source-2', { name: 'exact-rename-target' });
        assert.equal(result.project, null);
        assert.equal(result.errors[0], 'Project "exact-rename-target" already exists',
          'exact-case collision keeps the legacy error format — no spurious case-insensitive suffix');
      });
    });
  });

  describe('deleteProject', () => {
    it('deletes project (archive only)', async () => {
      projects.createProject({ name: 'to-delete', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete');
      assert.ok(result.success);
      assert.equal(result.filesDeleted, false);
      assert.equal(store.projects.getByName('to-delete'), null);
      // Directory should still exist
      assert.ok(fs.existsSync(path.join(projectsDir, 'to-delete')));
    });

    it('deletes project with files', async () => {
      projects.createProject({ name: 'to-delete-files', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete-files', { deleteFiles: true });
      assert.ok(result.success);
      assert.equal(result.filesDeleted, true);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'to-delete-files')));
    });

    it('returns error for unknown project', async () => {
      const result = projects.deleteProject('nonexistent');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('cascade-deletes the consolidated continuity store with files (CC-4)', async () => {
      projects.createProject({ name: 'store-cascade', methodology: 'minimal', gitInit: false });
      const store_ = path.join(projectsDir, 'store-cascade', '.tangleclaw', 'continuity', 'sessions', '1', 'uploads');
      fs.mkdirSync(store_, { recursive: true });
      fs.writeFileSync(path.join(store_, 'shot.png'), 'x');

      projects.deleteProject('store-cascade', { deleteFiles: true });
      // The store lives under project.path, so removing the project dir wipes it.
      assert.ok(!fs.existsSync(path.join(projectsDir, 'store-cascade', '.tangleclaw')));
    });

    it('preserves the continuity store when files are kept (CC-4)', async () => {
      projects.createProject({ name: 'store-keep', methodology: 'minimal', gitInit: false });
      const store_ = path.join(projectsDir, 'store-keep', '.tangleclaw', 'continuity');
      fs.mkdirSync(store_, { recursive: true });
      fs.writeFileSync(path.join(store_, 'index.md'), '# keep');

      projects.deleteProject('store-keep'); // deleteFiles defaults false
      // Deliberate: keeping the files keeps the gitignored local store too.
      assert.ok(fs.existsSync(path.join(store_, 'index.md')));
    });
  });

  describe('detectExistingProjects', () => {
    it('detects projects with .tangleclaw config', async () => {
      const detectDir = path.join(projectsDir, 'detectable');
      fs.mkdirSync(path.join(detectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(detectDir, '.tangleclaw', 'project.json'), '{}');

      const result = projects.detectExistingProjects();
      assert.ok(result.detected.some((d) => d.name === 'detectable'));
    });

    it('skips already registered projects', async () => {
      const result = projects.detectExistingProjects();
      // new-project is already registered, should not appear
      assert.ok(!result.detected.some((d) => d.name === 'new-project'));
    });

    it('skips hidden directories', async () => {
      fs.mkdirSync(path.join(projectsDir, '.hidden-dir'), { recursive: true });
      const result = projects.detectExistingProjects();
      assert.ok(!result.detected.some((d) => d.name === '.hidden-dir'));
    });
  });

  // #859 — the projects scan ran synchronously on the event loop, and the shipped
  // default projectsDir (~/Documents/Projects) is TCC-protected on macOS. A
  // launchd node without Full Disk Access does not get EPERM there: the open()
  // NEVER RETURNS. So one GET /api/projects took down every route — /api/health
  // answered 200 seconds earlier and then nothing, no error, no log, no recovery,
  // launchd still reporting the process alive. The dashboard loads this route, so
  // it was the first thing a new operator hit.
  describe('listAllProjects — a directory that never answers must not take the server down (#859)', () => {
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with the scanner replaced, then restore it.
     *
     * The hang used to be injected by stubbing `fsp.readdir` in this process.
     * Since #883 the walk happens in a child process, where a stub in this one
     * cannot reach it — so the seam moved to the scanner call itself. What is
     * being pinned here is unchanged: how `listAllProjects` DEGRADES when the
     * scan does not come back. Whether the scanner really kills a hung child is
     * `test/dir-scanner.test.js`'s job, and it is asserted against a genuinely
     * blocked syscall there rather than a stub.
     *
     * @param {Function} fakeRequest - Stand-in for dirScanner.request.
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withScanner(fakeRequest, fn) {
      const real = dirScanner.request;
      dirScanner.request = fakeRequest;
      try {
        return await fn();
      } finally {
        dirScanner.request = real;
      }
    }

    /**
     * The rejection a scan produces when the path never answered.
     * @returns {Error}
     */
    function timedOut() {
      return Object.assign(new Error('timed out after 5000ms reading /nowhere'),
        { tcTimedOut: true });
    }

    it('returns the registered projects instead of failing the request', async () => {
      const list = await withScanner(
        () => Promise.reject(timedOut()),
        () => projects.listAllProjects()
      );
      assert.ok(Array.isArray(list), 'must still answer with a list');
      // Registered projects come from the database and are unaffected by a
      // stuck filesystem; only discovery of unregistered folders is lost.
      assert.ok(list.length > 0, 'the fixture must actually have registered projects to degrade to');
      for (const p of list) {
        assert.equal(p.registered, true, 'a degraded scan may only return registered projects');
      }
    });

    it('gives the scan a deadline SHORTER than the walk it asks for', async () => {
      // The two bounds are not redundant and their order is the whole point: the
      // child stops itself first and hands back what it found, leaving the
      // supervisor's kill as the backstop for a walk that never returns at all.
      // Equal values let the kill win the tie, which throws away a partial answer
      // and reports a responsive directory as unresponsive.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = { payload, opts }; return Promise.reject(timedOut()); },
        () => projects.listAllProjects()
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.ok(seen.payload.budgetMs < seen.opts.timeoutMs,
        `the walk budget (${seen.payload.budgetMs}ms) must be under the request deadline `
        + `(${seen.opts.timeoutMs}ms)`);
    });

    it('opts the POLLED route into the failure backoff', async () => {
      // This route is polled every ten seconds for as long as a dashboard tab is
      // open. Without opting in, an unreadable projects directory costs a killed
      // child on every tick forever — and a child blocked in the kernel may never
      // leave the process table. Drop the pathKey and that returns silently:
      // everything still works, it just costs a process every ten seconds.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = opts; return Promise.reject(timedOut()); },
        () => projects.listAllProjects()
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.equal(seen.pathKey, projects.resolveProjectsDir(store.config.load().projectsDir),
        'the backoff must be keyed on the directory actually read');
    });

    it('logs a remembered refusal quietly, so one bad directory is not a log flood', async () => {
      // Same condition, same degradation — but the scanner already warned when it
      // really failed, and warns again on each escalation. Repeating that per poll
      // would bury those lines behind six identical ones a minute.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      try {
        const cached = Object.assign(new Error('remembered'),
          { tcTimedOut: true, tcCached: true });
        await withScanner(() => Promise.reject(cached), () => projects.listAllProjects());
        assert.equal(chunks.join(''), '', 'a remembered refusal must not warn again');

        // ...but a NEW failure still must, or a stuck directory goes unreported.
        await withScanner(() => Promise.reject(timedOut()), () => projects.listAllProjects());
        assert.match(chunks.join(''), /Full Disk Access/);
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }
    });

    it('names Full Disk Access and the safe directories when the path never answered', () => {
      // This string is the entire operator-facing value of degrading instead of
      // hanging: without it the dashboard just shows fewer projects and nobody
      // learns why. Inline it had NO coverage — deleting it left every test
      // green — which is the failure this pins.
      const timedOut = Object.assign(new Error('timed out'), { tcTimedOut: true });
      const hint = projects._scanFailureHint(timedOut);
      assert.match(hint, /Full Disk Access/, 'must name the actual macOS remedy');
      assert.match(hint, /~\/Documents/, 'must name the protected directories to avoid');
      assert.match(hint, /did not respond/, 'must say what was observed, not just what to do');
    });

    it('says it without the acronym', () => {
      // The three assertions above all pass against the older wording too, which
      // said "a TCC-protected path": they pin the FACTS the message must carry,
      // and nothing pinned the register. This is the one message a stranded
      // non-expert reads, and it is the worst moment to meet a new term — the
      // other two surfaces naming this condition already say "protected folder"
      // and "a directory node cannot read". Without this line, reverting to the
      // acronym leaves every test green.
      const timedOut = Object.assign(new Error('timed out'), { tcTimedOut: true });
      assert.doesNotMatch(projects._scanFailureHint(timedOut), /TCC/,
        'operator-facing text must not carry the acronym; the comments may');
    });

    it('actually PUTS the hint in the log when a scan times out', () => {
      // _scanFailureHint is pinned above, but pinning a helper says nothing
      // about whether anyone calls it: delete `hint: _scanFailureHint(err)` from
      // the log payload and the helper's own tests stay green while the operator
      // sees nothing. This asserts the wiring, through the logger's real sink.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      const real = dirScanner.request;
      dirScanner.request = () => Promise.reject(
        Object.assign(new Error('timed out'), { tcTimedOut: true })
      );
      return projects.listAllProjects().then(() => {
        const out = chunks.join('');
        assert.match(out, /Full Disk Access/,
          'the remedy must reach the log, not just exist in a helper');
      }).finally(() => {
        dirScanner.request = real;
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      });
    });

    it('adds no hint for an ordinary filesystem error', () => {
      // EACCES already explains itself. The hint exists for the failure that
      // looks like nothing at all, and attaching it everywhere would make the
      // one case it matters for invisible.
      assert.equal(projects._scanFailureHint(Object.assign(new Error('x'), { code: 'EACCES' })), undefined);
      assert.equal(projects._scanFailureHint(null), undefined);
    });

    // `_withTimeout`'s own two unit tests (the deadline fires and carries
    // `tcTimedOut`; it resolves when the work wins) are gone with the helper.
    // #883 moved every operator-path read into the scanner child, leaving the
    // helper with no production caller, and keeping dead code alive to be a
    // fixture misrepresents the module. Both contracts are asserted against the
    // code that now owns them, in test/dir-scanner.test.js — and against a real
    // blocked syscall rather than a never-settling stub.

    it('still answers when the directory read fails outright', async () => {
      const list = await withScanner(
        () => Promise.reject(Object.assign(new Error('boom'), { code: 'EACCES' })),
        () => projects.listAllProjects()
      );
      assert.ok(Array.isArray(list));
    });

    it('keeps the directories it found when the walk runs out of time', async () => {
      // Bringing the per-entry loop under the deadline introduced an
      // all-or-nothing failure the old shape did not have: throw mid-loop and
      // the caller degrades to the registered projects, discarding everything
      // already discovered. This route backs the dashboard, and per-entry cost
      // is dominated by a synchronous git.getInfo (up to seven execSync calls
      // per directory, cached two minutes) — so a cold-cache load over a few
      // dozen unregistered folders would show NONE of them, with a log line as
      // the only trace. A discovery walk that ran out of budget still
      // discovered what it got to.
      //
      // The walk now truncates inside the scanner child, so THAT half is pinned
      // in test/dir-scanner-child.test.js. What remains this file's job — and it
      // is the half that regressed before — is that `listAllProjects` RENDERS a
      // truncated result instead of treating it as a failure. Mutation: make the
      // truncated branch degrade to the registered list and `found` goes to zero.
      const partial = [
        { id: null, name: 'walked-1', path: '/x/walked-1', registered: false, git: null },
        { id: null, name: 'walked-2', path: '/x/walked-2', registered: false, git: null }
      ];
      const all = await withScanner(
        () => Promise.resolve({ unregistered: partial, truncated: true }),
        () => projects.listAllProjects()
      );
      const found = all.filter(p => p.registered === false);
      assert.deepEqual(found.map(p => p.name).sort(), ['walked-1', 'walked-2'],
        'the directories walked before the deadline must survive, not be discarded');
    });

    it('says the list is SHORT rather than letting a truncated walk look complete', async () => {
      // A silently-short list reads as "those directories are not there". The
      // log line is the only place that distinction exists, so it is wiring
      // worth pinning: delete the `truncated` branch and this goes red while
      // the test above still passes.
      const logger = require('../lib/logger');
      const chunks = [];
      const prevLevel = logger.getLevel();
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (c) => { chunks.push(String(c)); return true; } });
      try {
        await withScanner(
          () => Promise.resolve({ unregistered: [], truncated: true }),
          () => projects.listAllProjects()
        );
        assert.match(chunks.join(''), /SHORT, not empty/);
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(prevLevel);
      }
    });

    it('reports an unregistered directory\'s TangleClaw config, end to end', async () => {
      // Pins the ANSWER, because the answer is what two successive rewrites of
      // the mechanism underneath it must not change: this field was a synchronous
      // `fs.existsSync`, then an awaited `fsp.access`, and is now an `access` in
      // the scanner child, and nothing else asserts it for this function.
      //
      // Deliberately end-to-end against real directories through the real
      // scanner — no stub anywhere — so it also proves the walk's result actually
      // survives the process hop with this field intact.
      fs.mkdirSync(path.join(projectsDir, 'has-tc-config', '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'has-tc-config', '.tangleclaw', 'project.json'), '{}');
      fs.mkdirSync(path.join(projectsDir, 'no-tc-config'), { recursive: true });

      const all = await projects.listAllProjects();
      const withConfig = all.find(p => p.name === 'has-tc-config');
      const without = all.find(p => p.name === 'no-tc-config');
      assert.ok(withConfig && without, 'both unregistered directories must be listed');
      assert.equal(withConfig.hasTangleclawConfig, true);
      assert.equal(without.hasTangleclawConfig, false);
    });
  });

  // The same wedge, the OTHER call site. The projects list was fixed; the
  // first-run wizard's directory scan kept reading the operator's directory
  // synchronously, so a fresh macOS install on the pre-filled default
  // (~/Documents/Projects) still lost the whole server at wizard step 2 —
  // before the operator had any working install to go back to. Reproduced on a
  // clean macOS guest: an ordinary directory scanned 200 and left the server
  // healthy; ~/Documents/Projects never answered and the process needed a
  // launchctl kickstart.
  // `~/Documents/Projects` is the shipped default and the value the wizard
  // pre-fills — and a stock macOS install does not have it. macOS creates
  // Documents; nothing creates Projects, and nothing in TangleClaw did either.
  // So the first action of a brand-new install answered "Directory does not
  // exist" and offered nothing to do about it.
  describe('createProjectsDir — the offer that ends the dead end', () => {
    let home;
    let savedHome;

    beforeEach(() => {
      savedHome = process.env.HOME;
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'));
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('creates the folder the operator was pointed at', async () => {
      const target = path.join(home, 'Projects');
      const result = await projects.createProjectsDir(target);
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.ok(fs.statSync(target).isDirectory());
    });

    it('expands ~ the same way the scan does', async () => {
      // The wizard sends back exactly what it displayed, and what it displays is
      // `~/Documents/Projects`. Handled anywhere but here and the button would
      // create a folder literally named "~".
      fs.mkdirSync(path.join(home, 'Documents'));
      const result = await projects.createProjectsDir('~/Documents/Projects');
      assert.equal(result.ok, true);
      assert.ok(fs.statSync(path.join(home, 'Documents', 'Projects')).isDirectory());
      assert.equal(fs.existsSync(path.join(process.cwd(), '~')), false,
        'a literal ~ directory must never appear');
    });

    it('is happy when it is already there', async () => {
      // Two clicks, or a folder made in Finder while this screen was open.
      const target = path.join(home, 'Projects');
      fs.mkdirSync(target);
      const result = await projects.createProjectsDir(target);
      assert.equal(result.ok, true);
      assert.equal(result.created, false, 'it reports that it made nothing');
    });

    it('refuses to create anything outside the home directory', async () => {
      // This route runs during first-run setup, BEFORE any credential exists,
      // so it cannot be protected by one — the constraint is the boundary. It
      // must never become a general-purpose mkdir.
      const result = await projects.createProjectsDir('/tmp/tc-should-never-exist');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.equal(fs.existsSync('/tmp/tc-should-never-exist'), false);
    });

    it('refuses a traversal that climbs back out of home', async () => {
      // `path.resolve` collapses `..` before the check, so this is normalised
      // away rather than pattern-matched — which is why a path that LOOKS like
      // it is under home cannot smuggle its way out.
      const result = await projects.createProjectsDir(path.join(home, '..', '..', 'tc-escape'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /home directory/);
    });

    it('refuses to create the home directory itself', async () => {
      const result = await projects.createProjectsDir(home);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
    });

    it('creates one level, not a tree nobody asked for', async () => {
      // "You pointed at ~/Documents/Projects and it wasn't there" is one level.
      // Five is building something at a path nobody checked.
      const result = await projects.createProjectsDir(path.join(home, 'a', 'b', 'c'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /folder above it/);
      assert.equal(fs.existsSync(path.join(home, 'a')), false);
    });
  });

  describe('scanDirectoryForProjects — the wizard scan must answer, not hang', () => {
    const dirScanner = require('../lib/dir-scanner');

    /**
     * Run `fn` with the scanner replaced, then restore it.
     *
     * Same seam, and same reason, as the `listAllProjects` block above: since
     * #883 the read happens in a child process, so a `fsp` stub in this one
     * cannot reach it. These tests pin how the WIZARD reports a scan that did
     * not come back; that the scanner really kills a hung child is asserted
     * against a genuinely blocked syscall in test/dir-scanner.test.js.
     *
     * @param {Function} fakeRequest - Stand-in for dirScanner.request.
     * @param {Function} fn - Test body.
     * @returns {Promise<any>}
     */
    async function withScanner(fakeRequest, fn) {
      const real = dirScanner.request;
      dirScanner.request = fakeRequest;
      try {
        return await fn();
      } finally {
        dirScanner.request = real;
      }
    }

    it('reports the failure instead of pretending the directory was empty', async () => {
      // The dangerous wrong answer here is not an error, it is `ok: true` with
      // an empty list — the operator ticks nothing, imports nothing, and
      // concludes they have no projects.
      const result = await withScanner(
        () => Promise.reject(Object.assign(new Error('timed out after 5000ms'),
          { tcTimedOut: true })),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SCAN_FAILED');
    });

    it('names Full Disk Access in the error the operator will read', async () => {
      // The wizard renders this string verbatim. Without the remedy in it, the
      // operator sees a directory they can open in Finder being refused for no
      // stated reason — the state this whole change exists to prevent.
      const result = await withScanner(
        () => Promise.reject(Object.assign(new Error('timed out after 5000ms'),
          { tcTimedOut: true })),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.code, 'SCAN_FAILED');
      assert.match(result.error, /Full Disk Access/);
      assert.match(result.error, /~\/Documents/);
    });

    it('words a TRUNCATED walk differently, and does not blame Full Disk Access', async () => {
      // A walk that ran out of budget is the one failure a perfectly healthy
      // machine produces — a very large directory, a slow disk. Offering Full
      // Disk Access as the remedy sends the operator to change a setting that
      // was never the problem. The flag has to survive the process hop for this
      // sentence to be reachable at all.
      const result = await withScanner(
        () => Promise.reject(Object.assign(
          new Error('checked 12 of 200 subdirectories in 4750ms and gave up'),
          { tcTruncated: true }
        )),
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.equal(result.code, 'SCAN_FAILED');
      assert.match(result.error, /checked 12 of 200 subdirectories/,
        'must say how far it got, so the operator can tell slow from blocked');
      assert.doesNotMatch(result.error, /Full Disk Access — grant it/,
        'a slow directory must not be diagnosed as a protected one');
    });

    it('gives the scan a deadline SHORTER than the walk it asks for', async () => {
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = { payload, opts }; return Promise.resolve({ projects: [] }); },
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.ok(seen.payload.budgetMs < seen.opts.timeoutMs,
        'the child must give up before the supervisor kills it, so a slow walk can report');
    });

    it('does NOT opt an operator-pressed button into the failure backoff', async () => {
      // The polled route opts in; this one must not. Someone who has just granted
      // Full Disk Access and pressed Scan again is entitled to a real answer — a
      // remembered refusal would tell them their fix did not work, which is a
      // worse version of the misdiagnosis this whole issue is about. The cost of
      // leaving it out is bounded by how fast a person can click.
      let seen;
      await withScanner(
        (op, payload, opts) => { seen = opts; return Promise.resolve({ projects: [] }); },
        () => projects.scanDirectoryForProjects(projectsDir)
      );
      assert.ok(seen, 'the fixture must actually reach the scanner');
      assert.equal(seen.pathKey, undefined);
    });

    it('reports a missing directory under its OWN code, not a generic bad request', async () => {
      // The browser offers to CREATE this one, and it used to decide which
      // failure it was by regex-matching the message — so rewording a sentence
      // silently removed the button. The condition travels as a value now.
      const result = await projects.scanDirectoryForProjects(path.join(tmpDir, 'no-such-dir'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'DIR_MISSING');
      assert.match(result.error, /does not exist/);
    });

    it('reports a file path as a bad request', async () => {
      const filePath = path.join(tmpDir, 'not-a-dir.txt');
      fs.writeFileSync(filePath, 'x');
      const result = await projects.scanDirectoryForProjects(filePath);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
      assert.match(result.error, /not a directory/);
    });

    it('classifies real directories end to end, through the real scanner', async () => {
      // The classification RULES are pinned in test/dir-scanner-child.test.js,
      // where `fs` can be stubbed. This is the same question asked with no stub
      // anywhere — real directories, real child process — so the two together
      // catch both a wrong rule and a correct rule whose answer does not survive
      // the hop. Deliberate duplication at two levels, not an oversight.
      const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scan-'));
      fs.mkdirSync(path.join(scanRoot, 'with-marker'));
      fs.writeFileSync(path.join(scanRoot, 'with-marker', 'go.mod'), 'module example.com/x\n');
      fs.mkdirSync(path.join(scanRoot, 'bare'));
      fs.mkdirSync(path.join(scanRoot, '.hidden'));
      fs.writeFileSync(path.join(scanRoot, 'loose-file.txt'), 'x');
      try {
        const result = await projects.scanDirectoryForProjects(scanRoot);
        assert.equal(result.ok, true);
        const names = result.projects.map(p => p.name).sort();
        assert.deepEqual(names, ['bare', 'with-marker'],
          'hidden directories and loose files are not candidate projects');
        assert.equal(result.projects.find(p => p.name === 'with-marker').detected, true);
        assert.equal(result.projects.find(p => p.name === 'bare').detected, false);
      } finally {
        fs.rmSync(scanRoot, { recursive: true, force: true });
      }
    });
  });

  describe('listAllProjects', () => {
    it('includes both registered and unregistered projects', async () => {
      // Create an unregistered directory
      fs.mkdirSync(path.join(projectsDir, 'unregistered-proj'), { recursive: true });

      const all = await projects.listAllProjects();
      const registered = all.filter(p => p.registered === true);
      const unregistered = all.filter(p => p.registered === false);

      assert.ok(registered.length > 0, 'Should have registered projects');
      assert.ok(unregistered.some(p => p.name === 'unregistered-proj'), 'Should include unregistered dir');
    });

    it('unregistered projects have expected shape', async () => {
      const all = await projects.listAllProjects();
      const unreg = all.find(p => p.name === 'unregistered-proj');
      assert.ok(unreg);
      assert.equal(unreg.registered, false);
      assert.equal(unreg.engine, null);
      assert.equal(unreg.session, null);
      assert.deepEqual(unreg.tags, []);
      assert.ok('path' in unreg);
    });

    it('results are sorted by name', async () => {
      const all = await projects.listAllProjects();
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i - 1].name.toLowerCase() <= all[i].name.toLowerCase(),
          `${all[i - 1].name} should be before ${all[i].name}`);
      }
    });

    it('does not include hidden directories', async () => {
      const all = await projects.listAllProjects();
      assert.ok(!all.some(p => p.name.startsWith('.')));
    });
  });

  describe('attachProject', () => {
    it('attaches an existing unregistered directory', async () => {
      const attachDir = path.join(projectsDir, 'attachable');
      fs.mkdirSync(attachDir, { recursive: true });

      const result = projects.attachProject('attachable');
      assert.ok(result.project);
      assert.equal(result.project.name, 'attachable');

      // Should now be in store
      assert.ok(store.projects.getByName('attachable'));

      // Should have per-project config
      assert.ok(fs.existsSync(path.join(attachDir, '.tangleclaw', 'project.json')));
    });

  
    it('reads existing .tangleclaw/project.json', async () => {
      const attachDir = path.join(projectsDir, 'has-config');
      fs.mkdirSync(path.join(attachDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(attachDir, '.tangleclaw', 'project.json'),
        JSON.stringify({ engine: 'codex' }));

      const result = projects.attachProject('has-config');
      assert.ok(result.project);
      // Should use engine from existing config
      const dbProject = store.projects.getByName('has-config');
      assert.equal(dbProject.engineId, 'codex');
    });

    it('rejects already registered project', async () => {
      const result = projects.attachProject('new-project');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already registered'));
    });

    it('rejects non-existent directory', async () => {
      const result = projects.attachProject('does-not-exist-xyz');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('rejects invalid name', async () => {
      const result = projects.attachProject('bad name!');
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('archiveProject', () => {
    it('archives a registered project', async () => {
      const result = projects.archiveProject('attachable');
      assert.ok(result.success);
      // Should not appear in default list
      const list = projects.listProjects();
      assert.ok(!list.some(p => p.name === 'attachable'));
    });

    it('rejects archiving an already-archived project', async () => {
      const result = projects.archiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('already archived'));
    });

    it('rejects archiving a non-existent project', async () => {
      const result = projects.archiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('archived projects excluded from syncAllProjects', async () => {
      // syncAllProjects uses store.projects.list() which excludes archived
      const syncResult = projects.syncAllProjects();
      // attachable is archived, should not be counted
      const allActive = store.projects.list();
      assert.ok(!allActive.some(p => p.name === 'attachable'));
    });

    it('archived projects excluded from listAllProjects unregistered scan', async () => {
      const all = await projects.listAllProjects();
      // attachable is archived — should not appear as unregistered
      const asUnreg = all.find(p => p.name === 'attachable' && p.registered === false);
      assert.equal(asUnreg, undefined);
    });
  });

  describe('unarchiveProject', () => {
    it('restores an archived project', async () => {
      const result = projects.unarchiveProject('attachable');
      assert.ok(result.success);
      // Should appear in default list again
      const list = projects.listProjects();
      assert.ok(list.some(p => p.name === 'attachable'));
    });

    it('rejects unarchiving a non-archived project', async () => {
      const result = projects.unarchiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not archived'));
    });

    it('rejects unarchiving a non-existent project', async () => {
      const result = projects.unarchiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });
  });

  describe('resolveProjectsDir', () => {
    it('expands tilde to home directory', async () => {
      const result = projects.resolveProjectsDir('~/Documents');
      assert.ok(result.startsWith(process.env.HOME));
      assert.ok(result.endsWith('/Documents'));
    });

    it('returns absolute paths unchanged', async () => {
      const result = projects.resolveProjectsDir('/absolute/path');
      assert.equal(result, '/absolute/path');
    });
  });

  describe('enrichProject - version', () => {
    let versionDir;

    before(() => {
      versionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-version-'));
    });

    after(() => {
      fs.rmSync(versionDir, { recursive: true, force: true });
    });

    it('should include version from project package.json', async () => {
      const projPath = path.join(versionDir, 'with-version');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '2.5.0' }));

      const registered = store.projects.create({ name: 'ver-test-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '2.5.0');
    });

    it('should return null version when project has no package.json', async () => {
      const projPath = path.join(versionDir, 'no-pkg');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-test-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json has no version field', async () => {
      const projPath = path.join(versionDir, 'no-ver-field');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ name: 'test' }));

      const registered = store.projects.create({ name: 'ver-test-3', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json is malformed', async () => {
      const projPath = path.join(versionDir, 'bad-json');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), 'not json{{{');

      const registered = store.projects.create({ name: 'ver-test-4', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    // ── #55: Universal version detection chain ──

    it('layer 1: should read version from .tangleclaw/project-version.txt cache file', async () => {
      const projPath = path.join(versionDir, 'cache-only');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 9.9.9-rc1\nrecorded_at: 2026-04-10T20:00:00Z\nsource: CHANGELOG.md\n'
      );

      const registered = store.projects.create({ name: 'ver-cache-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '9.9.9-rc1');
    });

    it('layer 1: live source overrides stale cache and self-heals (#165 — semantic inversion of pre-#165 cache-wins)', async () => {
      // Pre-#165: cache was the highest-priority source and a divergent on-disk
      // CHANGELOG/version.json/package.json never reached the dashboard label
      // until the next session launch/wrap.
      // Post-#165: live sources win on every enrichment, and the cache is
      // rewritten so the next reader (and the test of cache contents) sees
      // the corrected state. See `_detectProjectVersion self-heal (#165)`
      // describe block below for the full contract.
      const projPath = path.join(versionDir, 'cache-precedence');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 1.0.0-from-cache\nsource: manual\n'
      );
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '# Changelog\n\n## [2.0.0-from-changelog] - 2026-04-01\n');
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0-from-versionjson' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0-from-packagejson' }));

      const registered = store.projects.create({ name: 'ver-cache-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '2.0.0-from-changelog');
    });

    it('layer 1: malformed cache file falls through to next layer', async () => {
      const projPath = path.join(versionDir, 'cache-malformed');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      // No "version:" line at all
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'recorded_at: 2026-04-10\nsource: nothing\n'
      );
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '5.5.5' }));

      const registered = store.projects.create({ name: 'ver-cache-3', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '5.5.5');
    });

    it('layer 2: should read first released version from CHANGELOG.md', async () => {
      const projPath = path.join(versionDir, 'changelog-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n### Added\n- thing\n\n## [3.12.7] - 2026-04-05\n\n## [3.12.6] - 2026-04-04\n'
      );

      const registered = store.projects.create({ name: 'ver-cl-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '3.12.7');
    });

    it('layer 2: CHANGELOG with only [Unreleased] falls through to next layer', async () => {
      const projPath = path.join(versionDir, 'changelog-unreleased-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- not yet released\n');
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '0.1.0' }));

      const registered = store.projects.create({ name: 'ver-cl-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '0.1.0');
    });

    it('layer 2: CHANGELOG should win over version.json and package.json when present', async () => {
      const projPath = path.join(versionDir, 'changelog-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [2.0.0] - 2026-04-01\n');
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-cl-3', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '2.0.0');
    });

    it('layer 3: should read version from version.json (TangleClaw convention)', async () => {
      const projPath = path.join(versionDir, 'versionjson-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.12.7' }));

      const registered = store.projects.create({ name: 'ver-vj-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '3.12.7');
    });

    it('layer 3: version.json should win over package.json when no cache or CHANGELOG', async () => {
      const projPath = path.join(versionDir, 'versionjson-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '3.0.0');
    });

    it('chain: all sources missing returns null', async () => {
      const projPath = path.join(versionDir, 'nothing');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-none', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('chain: project path that does not exist returns null without throwing', async () => {
      // Simulate a registered project whose directory was deleted
      const result = projects._detectProjectVersion('/nonexistent/path/that/should/not/exist/anywhere');
      assert.equal(result, null);
    });

    it('helpers: _readChangelogVersion handles version with build metadata (e.g. 0.6.9-beta)', async () => {
      const projPath = path.join(versionDir, 'changelog-prerelease');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [0.6.9-beta] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), '0.6.9-beta');
    });

    it('helpers: _readChangelogVersion rejects date-style headers (not a version)', async () => {
      const projPath = path.join(versionDir, 'changelog-date-header');
      fs.mkdirSync(projPath, { recursive: true });
      // Some projects use date headers like ## [2026-03-31] — these are NOT versions
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [2026-03-31] — Some Release\n\n## [2026-03-30] — Earlier Release\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), null);
    });

    it('helpers: _readChangelogVersion skips date headers and finds first valid version', async () => {
      const projPath = path.join(versionDir, 'changelog-mixed-headers');
      fs.mkdirSync(projPath, { recursive: true });
      // Mixed: a date header AND a valid version — should skip the date and pick the version
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [2026-03-31] — Date Entry\n\n## [1.2.3] - 2026-03-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('helpers: _readChangelogVersion accepts v-prefixed versions (e.g. v1.0.0)', async () => {
      const projPath = path.join(versionDir, 'changelog-v-prefix');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [v1.0.0] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), 'v1.0.0');
    });

    // ── Critic follow-ups (#55 chunk 1 hardening) ──

    it('BOM: _readChangelogVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'changelog-bom');
      fs.mkdirSync(projPath, { recursive: true });
      // Write a BOM-prefixed CHANGELOG — common from Windows editors
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '\uFEFF# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-04-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('BOM: _readVersionJsonVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'versionjson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        '\uFEFF' + JSON.stringify({ version: '7.7.7' })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), '7.7.7');
    });

    it('BOM: _readPackageJsonVersion handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'packagejson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'package.json'),
        '\uFEFF' + JSON.stringify({ version: '8.8.8' })
      );
      assert.equal(projects._readPackageJsonVersion(projPath), '8.8.8');
    });

    it('BOM: _readVersionCacheFile handles UTF-8 BOM-prefixed file', async () => {
      const projPath = path.join(versionDir, 'cache-bom');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        '\uFEFFversion: 9.9.9\nsource: manual\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '9.9.9');
    });

    it('version.json: rejects non-string version (number)', async () => {
      const projPath = path.join(versionDir, 'vj-number');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: 123 }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-num', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      // Should fall through to package.json since version.json had non-string
      assert.equal(enriched.version, '1.0.0');
    });

    it('version.json: rejects non-string version (object)', async () => {
      const projPath = path.join(versionDir, 'vj-object');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        JSON.stringify({ version: { major: 1, minor: 2 } })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects missing version field', async () => {
      const projPath = path.join(versionDir, 'vj-missing');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ name: 'only-name' }));
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects malformed JSON', async () => {
      const projPath = path.join(versionDir, 'vj-bad');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), 'not json{{{');
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('cache file: rejects whitespace-only version value', async () => {
      const projPath = path.join(versionDir, 'cache-whitespace');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      // Version line with only spaces after the colon — should NOT be accepted
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version:    \nsource: nothing\n'
      );
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '2.2.2' }));

      const registered = store.projects.create({ name: 'ver-cache-ws', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      // Cache file should be rejected as empty → fall through to package.json
      assert.equal(enriched.version, '2.2.2');
    });

    it('cache file: handles CRLF line endings', async () => {
      const projPath = path.join(versionDir, 'cache-crlf');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 5.5.5\r\nrecorded_at: 2026-04-10\r\nsource: manual\r\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '5.5.5');
    });

    it('layer 4 symmetry: package.json used when no cache/CHANGELOG/version.json', async () => {
      // Dedicated layer-4 test for symmetry with layers 1-3 precedence tests
      const projPath = path.join(versionDir, 'layer4-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.4.4' }));

      const registered = store.projects.create({ name: 'ver-layer4', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '4.4.4');
    });
  });

  // ── #165: Read-time self-heal of stale project-version cache ──
  describe('_detectProjectVersion self-heal (#165)', () => {
    let healDir;

    before(() => {
      healDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cache-heal-'));
    });

    after(() => {
      fs.rmSync(healDir, { recursive: true, force: true });
    });

    it('rewrites cache when on-disk version.json is newer than cached value', async () => {
      const projPath = path.join(healDir, 'stale-vs-versionjson');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      fs.writeFileSync(
        cachePath,
        'version: 3.14.0\nrecorded_at: 2026-05-05T18:30:36Z\nsource: CHANGELOG.md\n'
      );
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.16.1' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '3.16.1');

      // Cache file should have been rewritten with live value + correct source label
      const rewritten = fs.readFileSync(cachePath, 'utf8');
      assert.match(rewritten, /^version: 3\.16\.1$/m);
      assert.match(rewritten, /^source: version\.json$/m);
      // recorded_at should be present and in ISO-without-ms format (Z suffix, no `.NNN` block)
      assert.match(rewritten, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    });

    it('rewrites cache when CHANGELOG.md is newer than cached value (priority: CHANGELOG over version.json)', async () => {
      const projPath = path.join(healDir, 'stale-vs-changelog');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      fs.writeFileSync(cachePath, 'version: 0.0.0-old\nsource: package.json\n');
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [5.0.0] - 2026-05-13\n'
      );
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '4.0.0' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '5.0.0');

      const rewritten = fs.readFileSync(cachePath, 'utf8');
      assert.match(rewritten, /^version: 5\.0\.0$/m);
      assert.match(rewritten, /^source: CHANGELOG\.md$/m);
    });

    it('does not rewrite cache when cached value matches live value (steady state)', async () => {
      const projPath = path.join(healDir, 'steady-state');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      const originalBody = 'version: 2.5.0\nrecorded_at: 2026-04-01T12:00:00Z\nsource: version.json\n';
      fs.writeFileSync(cachePath, originalBody);
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.5.0' }));

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '2.5.0');

      // Byte-equal preservation — no recorded_at bump, no source rewrite. Filesystem-agnostic
      // (avoids mtime brittleness on coarse-resolution filesystems).
      const afterBytes = fs.readFileSync(cachePath, 'utf8');
      assert.equal(afterBytes, originalBody);
    });

    it('preserves cache when no on-disk live source exists (git-tag-derived cache survives)', async () => {
      const projPath = path.join(healDir, 'git-tag-only-cache');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      // Simulates `lib/project-version.js:recordVersion` having recorded a git-tag-derived
      // value — `lib/projects.js`'s live chain (CHANGELOG/version.json/package.json) cannot
      // reproduce this and must NOT clobber it.
      const originalBody = 'version: 1.2.3\nrecorded_at: 2026-04-01T12:00:00Z\nsource: git tag\n';
      fs.writeFileSync(cachePath, originalBody);
      // No CHANGELOG.md, no version.json, no package.json in projPath.

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '1.2.3');

      const afterBytes = fs.readFileSync(cachePath, 'utf8');
      assert.equal(afterBytes, originalBody);
    });

    it('returns live value without crashing when cache write fails (fail-open contract)', async () => {
      const projPath = path.join(healDir, 'write-failure');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '9.9.9' }));

      // Force the write path to fail by stubbing fs.writeFileSync to throw.
      // This is the only reliable cross-platform way to exercise the catch
      // block: chmod-based approaches can succeed silently on macOS when the
      // target file already exists in a r-o directory (POSIX semantics), and
      // would no-op when running as root. The stub closes both gaps and lets
      // us positively assert the fail-open path.
      const realWrite = fs.writeFileSync;
      let writeAttempts = 0;
      fs.writeFileSync = function stubWrite(...args) {
        writeAttempts += 1;
        const err = new Error('EACCES: simulated write failure');
        err.code = 'EACCES';
        throw err;
      };
      try {
        const result = projects._detectProjectVersion(projPath);
        // Must return the live value even though the cache rewrite failed.
        assert.equal(result, '9.9.9');
        // Positive proof the failure path was exercised — the stub recorded an attempt.
        assert.equal(writeAttempts, 1, 'fs.writeFileSync should have been invoked once');
        // Cache file should NOT exist (the write threw before any bytes hit disk).
        const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
        assert.equal(
          fs.existsSync(cachePath),
          false,
          'cache file should not have been created when the write threw'
        );
      } finally {
        fs.writeFileSync = realWrite;
      }
    });

    it('creates .tangleclaw/ if missing when self-healing a project that never had a cache', async () => {
      const projPath = path.join(healDir, 'no-tc-dir-yet');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '7.7.7' }));
      // Deliberately no .tangleclaw/ directory.

      const result = projects._detectProjectVersion(projPath);
      assert.equal(result, '7.7.7');

      // The self-heal write should have created the directory and the cache file.
      const cachePath = path.join(projPath, '.tangleclaw', 'project-version.txt');
      assert.ok(fs.existsSync(cachePath), '.tangleclaw/project-version.txt should be created');
      const body = fs.readFileSync(cachePath, 'utf8');
      assert.match(body, /^version: 7\.7\.7$/m);
      assert.match(body, /^source: version\.json$/m);
    });

    it('returns null for non-existent project path without throwing', async () => {
      const result = projects._detectProjectVersion('/nonexistent/path/for-165-test');
      assert.equal(result, null);
    });

    it('_detectLiveVersion returns null when no on-disk live source exists', async () => {
      const projPath = path.join(healDir, 'no-live-sources');
      fs.mkdirSync(projPath, { recursive: true });
      assert.equal(projects._detectLiveVersion(projPath), null);
    });

    it('_detectLiveVersion reports source label matching the reader that hit', async () => {
      const projPath = path.join(healDir, 'live-source-labels');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '1.0.0', source: 'package.json' });

      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '2.0.0', source: 'version.json' });

      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [3.0.0] - 2026-05-13\n');
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '3.0.0', source: 'CHANGELOG.md' });
    });

    // This ladder is separate from `lib/project-version.js`'s and feeds the
    // #165 self-heal, which WRITES `.tangleclaw/project-version.txt` with the
    // returned `source`. It originally had no configured-path rung, so a
    // project with `versionFilePath` set and no released CHANGELOG heading had
    // its cache overwritten with a false `source: package.json`.
    it('_detectLiveVersion honors a configured versionFilePath', async () => {
      const projPath = path.join(healDir, 'live-configured-path');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));
      fs.writeFileSync(path.join(projPath, 'VERSION.json'), JSON.stringify({ version: '9.9.9' }));

      const savedLoad = store.projectConfig.load;
      try {
        store.projectConfig.load = () => ({ versionFilePath: 'VERSION.json' });

        // Outranks both probe rungs, and labels itself with the real file.
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '9.9.9', source: 'VERSION.json' });

        // But CHANGELOG.md still outranks it — detection is deliberately
        // changelog-first, and the docs say so.
        fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [3.0.0] - 2026-05-13\n');
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '3.0.0', source: 'CHANGELOG.md' });
      } finally {
        store.projectConfig.load = savedLoad;
      }
    });

    it('_detectLiveVersion falls through to the probe when the configured file is unusable', async () => {
      const projPath = path.join(healDir, 'live-configured-bad');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));

      const savedLoad = store.projectConfig.load;
      try {
        // Points at a file that does not exist — detection degrades (the wrap
        // step refuses instead; that asymmetry is deliberate and documented).
        store.projectConfig.load = () => ({ versionFilePath: 'nope.json' });
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '2.0.0', source: 'version.json' });

        // And an escaping path is ignored rather than read.
        store.projectConfig.load = () => ({ versionFilePath: '../../etc/passwd.json' });
        assert.deepEqual(projects._detectLiveVersion(projPath),
          { version: '2.0.0', source: 'version.json' });
      } finally {
        store.projectConfig.load = savedLoad;
      }
    });
  });

  // ── #103 chunk 2: silentPrime UI toggle (enrichment + updateProject) ──
  describe('silentPrime (#103)', () => {
    let primeDir;

    before(() => {
      primeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-silent-prime-'));
    });

    after(() => {
      fs.rmSync(primeDir, { recursive: true, force: true });
    });

    it('enrichProject exposes silentPrime: true by default (#129)', async () => {
      // Pre-#129 the default was false (opt-in). Soak satisfied; silent prime
      // is now the default. See lib/store.js:DEFAULT_PROJECT_CONFIG.
      const projPath = path.join(primeDir, 'sp-default');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-default', path: projPath, engineId: 'claude' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('enrichProject reflects silentPrime: true once set in projectConfig', async () => {
      const projPath = path.join(primeDir, 'sp-on');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-on', path: projPath, engineId: 'claude' });
      const projConfig = store.projectConfig.load(projPath);
      projConfig.silentPrime = true;
      store.projectConfig.save(projPath, projConfig);
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('updateProject persists silentPrime=true when engine supports it', async () => {
      const projPath = path.join(primeDir, 'sp-update-on');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-on', path: projPath, engineId: 'claude' });
      const result = projects.updateProject('sp-update-on', { silentPrime: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, true);
      const persisted = store.projectConfig.load(projPath);
      assert.equal(persisted.silentPrime, true);
    });

    it('updateProject persists silentPrime=false (clearing the flag)', async () => {
      const projPath = path.join(primeDir, 'sp-update-off');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-off', path: projPath, engineId: 'claude' });
      // Pre-seed to true so we can confirm the false update reaches disk
      const seed = store.projectConfig.load(projPath);
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);

      const result = projects.updateProject('sp-update-off', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
      assert.equal(store.projectConfig.load(projPath).silentPrime, false);
    });

    it('updateProject rejects silentPrime=true when engine lacks the capability', async () => {
      const projPath = path.join(primeDir, 'sp-update-bad');
      fs.mkdirSync(projPath, { recursive: true });
      // 'codex' / 'gemini' / 'aider' do not advertise supportsSilentPrime; using a definitely-missing id
      // is even safer for this assertion.
      store.projects.create({ name: 'sp-update-bad', path: projPath, engine: 'no-such-engine' });
      const result = projects.updateProject('sp-update-bad', { silentPrime: true });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('silentprime'));
      // No project.json was written by the rejected PATCH. (Pre-#129, this
      // asserted `silentPrime === false` via the load default, but post-#129
      // the default is true — so the intent-preserving check is "the file
      // doesn't exist," not "the load returns false.")
      const projConfigFile = path.join(projPath, '.tangleclaw', 'project.json');
      assert.equal(fs.existsSync(projConfigFile), false, 'project.json should not be created on rejected PATCH');
    });

    it('updateProject rejects non-boolean silentPrime', async () => {
      const projPath = path.join(primeDir, 'sp-update-nonbool');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-nonbool', path: projPath, engineId: 'claude' });
      const result = projects.updateProject('sp-update-nonbool', { silentPrime: 'yes' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('boolean'));
    });

    it('updateProject silentPrime=false is accepted even on unsupported engines (always allowed to clear)', async () => {
      const projPath = path.join(primeDir, 'sp-clear-bad-engine');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-clear-bad-engine', path: projPath, engine: 'no-such-engine' });
      const result = projects.updateProject('sp-clear-bad-engine', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
    });

    // Critic chunk-2 M1 regression: a same-PATCH engine change + silentPrime=true
    // must NOT partially mutate disk state when the new engine lacks the capability.
    // Pre-fix, the engine block wrote projConfig.engine and the engine config file
    // before the silentPrime gate rejected, leaving DB and disk inconsistent.
    it('updateProject rejects engine+silentPrime PATCH atomically when new engine lacks capability', async () => {
      const projPath = path.join(primeDir, 'sp-engine-race');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-race', path: projPath, engine: 'claude' });

      // Snapshot pre-PATCH disk state
      const beforeProjConfig = store.projectConfig.load(projPath);
      assert.equal(beforeProjConfig.engine || null, null, 'baseline: engine field empty (lazy-set on first session)');
      const beforeRow = store.projects.getByName('sp-engine-race');

      // Attempt the bad PATCH: switch to an engine without the capability AND enable silentPrime.
      const result = projects.updateProject('sp-engine-race', {
        engine: 'no-such-engine',
        silentPrime: true
      });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('silentprime'));

      // Verify NO disk-state drift: no project.json was written by the
      // rejected PATCH. (Post-#129, asserting `silentPrime === false` from
      // load() would assert the default, not the file's absence.)
      const projConfigFile = path.join(projPath, '.tangleclaw', 'project.json');
      assert.equal(fs.existsSync(projConfigFile), false, 'project.json should not be created on rejected PATCH');

      // Verify NO DB drift: engine_id still points to the original engine.
      const afterRow = store.projects.getByName('sp-engine-race');
      assert.equal(afterRow.engineId, beforeRow.engineId);
    });

    // ── #137: PATCH must sync .claude/settings.json + prime file immediately ──
    it('updateProject syncs SessionStart hook to .claude/settings.json on silentPrime=true (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-sync-on');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-sync-on', path: projPath, engineId: 'claude' });

      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      assert.equal(fs.existsSync(settingsFile), false, 'baseline: no settings.json yet');

      const result = projects.updateProject('sp-sync-on', { silentPrime: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, true);

      assert.equal(fs.existsSync(settingsFile), true, 'settings.json should be written by syncEngineHooks');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(settings.hooks, 'hooks block should exist');
      assert.ok(settings.hooks.SessionStart, 'SessionStart entry should exist');
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup');
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.match(cmd, /"[^"]*\/data\/hooks\/sessionstart-prime\.sh"$/,
        'the command must be a QUOTED absolute path — an unquoted one breaks the moment the install path contains a space (#759)')
      assert.equal(cmd.includes('{{TANGLECLAW_DIR}}'), false, 'placeholder should be resolved');
    });

    it('updateProject removes SessionStart hook from .claude/settings.json on silentPrime=false (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-sync-off');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-sync-off', path: projPath, engineId: 'claude' });

      // Seed silentPrime=true via PATCH so the baseline matches the on-disk shape PATCH would produce.
      projects.updateProject('sp-sync-off', { silentPrime: true });
      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(seeded.hooks && seeded.hooks.SessionStart, 'baseline: hook should be present after silentPrime=true');

      const result = projects.updateProject('sp-sync-off', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      // The SessionStart entry must be gone. The surrounding hooks block may or may
      // not be present depending on what other baseline hooks exist (#103 may grow
      // siblings) — we only care that the silentPrime entry specifically is cleared.
      const sessionStart = after.hooks && after.hooks.SessionStart;
      assert.equal(sessionStart, undefined, 'SessionStart entry should be cleared when silentPrime=false');
    });

    it('updateProject removes stale .tangleclaw/session-prime.md on silentPrime=false (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-prime-cleanup');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-prime-cleanup', path: projPath, engineId: 'claude' });

      // Pre-seed silentPrime=true and write a stale prime file directly.
      const seed = store.projectConfig.load(projPath);
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);
      const tcDir = path.join(projPath, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      const primeFile = path.join(tcDir, 'session-prime.md');
      fs.writeFileSync(primeFile, '# stale prime from a previous session\n');
      assert.equal(fs.existsSync(primeFile), true, 'baseline: stale prime file is on disk');

      const result = projects.updateProject('sp-prime-cleanup', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(fs.existsSync(primeFile), false, 'stale prime file should be removed by PATCH');
    });

    // ── #140: engine PATCH must clear orphan .claude/settings.json hooks ──
    it('updateProject clears orphan SessionStart hook when engine flips claude → non-claude (#140)', async () => {
      const projPath = path.join(primeDir, 'sp-engine-flip-orphan');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-flip-orphan', path: projPath, engineId: 'claude' });

      // Seed silentPrime=true via PATCH so the SessionStart hook is materialized
      // as the canonical pre-flip state — same shape an existing install would
      // have on disk before the engine change.
      projects.updateProject('sp-engine-flip-orphan', { silentPrime: true });
      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(seeded.hooks && seeded.hooks.SessionStart, 'baseline: SessionStart hook present after silentPrime=true');

      // Inject a non-hook key so the test asserts the cleanup pass deletes ONLY
      // hooks and preserves the rest of the settings file (Critic m1).
      seeded.permissions = { allow: ['Read', 'Edit'] };
      fs.writeFileSync(settingsFile, JSON.stringify(seeded, null, 2) + '\n');

      // Flip engine away from claude WITHOUT touching silentPrime — exactly the
      // scenario from #140's repro. (antigravity here; the original gemini
      // fixture engine was retired in #457.)
      const result = projects.updateProject('sp-engine-flip-orphan', { engine: 'antigravity' });
      assert.deepEqual(result.errors, []);
      assert.equal(store.projects.getByName('sp-engine-flip-orphan').engineId, 'antigravity');

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.equal(
        after.hooks && after.hooks.SessionStart,
        undefined,
        'orphan SessionStart hook must be cleared on engine flip away from claude'
      );
      assert.deepEqual(
        after.permissions,
        { allow: ['Read', 'Edit'] },
        'non-hook keys must be preserved across the cleanup pass'
      );
    });

    it('updateProject materializes SessionStart hook when engine flips non-claude → claude with silentPrime=true (#140)', async () => {
      const projPath = path.join(primeDir, 'sp-engine-flip-onto-claude');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-engine-flip-onto-claude', path: projPath, engine: 'gemini' });

      // Pre-seed silentPrime=true directly in projConfig — gemini lacks the
      // capability so a PATCH would reject, but real projects can land in this
      // state via a prior claude → gemini flip that left silentPrime=true on
      // projConfig (the second half of the #140 repro).
      const seed = store.projectConfig.load(projPath);
      seed.engine = 'gemini';
      seed.silentPrime = true;
      store.projectConfig.save(projPath, seed);

      const settingsFile = path.join(projPath, '.claude', 'settings.json');
      assert.equal(fs.existsSync(settingsFile), false, 'baseline: no .claude/settings.json yet');

      // Flip onto claude. CHANGELOG claims the hook is materialized immediately
      // rather than waiting for the next launchSession.
      const result = projects.updateProject('sp-engine-flip-onto-claude', { engine: 'claude' });
      assert.deepEqual(result.errors, []);

      assert.equal(fs.existsSync(settingsFile), true, '.claude/settings.json should be written by syncEngineHooks');
      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(after.hooks && after.hooks.SessionStart, 'SessionStart hook should be materialized on flip onto claude');
      assert.equal(after.hooks.SessionStart[0].matcher, 'startup');
    });

    it('updateProject silentPrime=false is a no-op for prime cleanup when file is absent (#137)', async () => {
      const projPath = path.join(primeDir, 'sp-prime-absent');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-prime-absent', path: projPath, engineId: 'claude' });

      const primeFile = path.join(projPath, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), false, 'baseline: no prime file');

      const result = projects.updateProject('sp-prime-absent', { silentPrime: false });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, false);
      assert.equal(fs.existsSync(primeFile), false, 'still absent — _removePrimeFile is non-throwing on missing');
    });
  });

  });
