'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
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
    it('accepts valid names', () => {
      assert.ok(projects.validateName('my-project').valid);
      assert.ok(projects.validateName('Project_1').valid);
      assert.ok(projects.validateName('test123').valid);
    });

    it('rejects empty names', () => {
      assert.equal(projects.validateName('').valid, false);
      assert.equal(projects.validateName(null).valid, false);
      assert.equal(projects.validateName(undefined).valid, false);
    });

    it('accepts names with spaces', () => {
      assert.equal(projects.validateName('my project').valid, true);
      assert.equal(projects.validateName('TiLT v2').valid, true);
    });

    it('rejects names with special characters', () => {
      assert.equal(projects.validateName('my/project').valid, false);
      assert.equal(projects.validateName('my.project').valid, false);
      assert.equal(projects.validateName('project!').valid, false);
    });

    it('rejects names over 64 characters', () => {
      assert.equal(projects.validateName('a'.repeat(65)).valid, false);
    });

    it('accepts names exactly 64 characters', () => {
      assert.ok(projects.validateName('a'.repeat(64)).valid);
    });
  });

  describe('password hashing', () => {
    it('hashPassword produces salt:hash format', () => {
      const hashed = projects.hashPassword('test123');
      assert.ok(hashed.includes(':'));
      const [salt, hash] = hashed.split(':');
      assert.equal(salt.length, 32); // 16 bytes hex
      assert.equal(hash.length, 128); // 64 bytes hex
    });

    it('verifyPassword returns true for matching password', () => {
      const hashed = projects.hashPassword('mysecret');
      assert.ok(projects.verifyPassword('mysecret', hashed));
    });

    it('verifyPassword returns false for wrong password', () => {
      const hashed = projects.hashPassword('mysecret');
      assert.equal(projects.verifyPassword('wrong', hashed), false);
    });

    it('verifyPassword returns false for null inputs', () => {
      assert.equal(projects.verifyPassword(null, null), false);
      assert.equal(projects.verifyPassword('test', null), false);
      assert.equal(projects.verifyPassword(null, 'hash'), false);
    });

    it('verifyPassword returns false for invalid hash format', () => {
      assert.equal(projects.verifyPassword('test', 'nocolon'), false);
    });
  });

  describe('checkDeletePassword', () => {
    it('allows when no password configured', () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.ok(result.allowed);
    });

    it('requires password when configured', () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('secret');
      store.config.save(config);

      const result = projects.checkDeletePassword(undefined);
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('required'));
    });

    it('allows correct password', () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('correct');
      assert.ok(result.allowed);
    });

    it('rejects incorrect password', () => {
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('correct');
      store.config.save(config);

      const result = projects.checkDeletePassword('wrong');
      assert.equal(result.allowed, false);
      assert.ok(result.error.includes('Incorrect'));
    });

    it('upgrades plaintext password to hash', () => {
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
    it('creates a project with directory and config', () => {
      const result = projects.createProject({
        name: 'new-project',
        methodology: 'minimal'
      });

      assert.ok(result.project);
      assert.equal(result.project.name, 'new-project');
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project')));
      assert.ok(fs.existsSync(path.join(projectsDir, 'new-project', '.tangleclaw', 'project.json')));
    });

    it('creates session memory directory and seed file', () => {
      const result = projects.createProject({
        name: 'memory-project',
        methodology: 'minimal'
      });
      assert.ok(result.project);
      const memoriesDir = path.join(projectsDir, 'memory-project', '.tangleclaw', 'memories');
      assert.ok(fs.existsSync(memoriesDir), 'memories directory should exist');
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');
      assert.ok(fs.existsSync(memoryFile), 'MEMORY.md should exist');
      const content = fs.readFileSync(memoryFile, 'utf8');
      assert.ok(content.includes('Session Memory'));
    });

    it('rejects invalid names', () => {
      const result = projects.createProject({ name: 'bad name!' });
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });

    it('rejects duplicate projects', () => {
      projects.createProject({ name: 'dupe-proj', methodology: 'minimal' });
      const result = projects.createProject({ name: 'dupe-proj' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects when directory exists', () => {
      fs.mkdirSync(path.join(projectsDir, 'existing-dir'), { recursive: true });
      const result = projects.createProject({ name: 'existing-dir' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already exists'));
    });

    it('rejects unknown engine', () => {
      const result = projects.createProject({ name: 'bad-engine', engine: 'nonexistent' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('rejects unknown methodology', () => {
      const result = projects.createProject({ name: 'bad-method', methodology: 'nonexistent' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('applies methodology default rules', () => {
      const result = projects.createProject({
        name: 'rules-project',
        methodology: 'minimal'
      });

      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      // Core rules should always be true
      assert.equal(projConfig.rules.core.changelogPerChange, true);
      assert.equal(projConfig.rules.core.jsdocAllFunctions, true);
    });

    it('passes tags to project', () => {
      const result = projects.createProject({
        name: 'tagged-project',
        tags: ['node', 'active'],
        methodology: 'minimal'
      });

      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['node', 'active']);
    });

    it('skips git init when gitInit is false', () => {
      const result = projects.createProject({
        name: 'no-git',
        gitInit: false,
        methodology: 'minimal'
      });

      assert.ok(result.project);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'no-git', '.git')));
    });

    describe('case-insensitive duplicate rejection (#221, sibling to #188)', () => {
      it('rejects creating "Foo-Case" when "foo-case" already exists (lowercase first)', () => {
        const first = projects.createProject({ name: 'foo-case', methodology: 'minimal' });
        assert.ok(first.project, 'lowercase precondition project created');

        const dup = projects.createProject({ name: 'Foo-Case', methodology: 'minimal' });
        assert.equal(dup.project, null, 'mixed-case dup must be rejected');
        assert.equal(dup.errors.length, 1);
        // Error message reflects the existing project's actual casing so
        // the operator can find it in the projects list.
        assert.match(dup.errors[0], /foo-case/);
        assert.match(dup.errors[0], /case-insensitive/i,
          'error must call out the case-collision so the operator understands the rejection reason');
      });

      it('rejects creating "case-second" when "Case-Second" already exists (mixed-case first)', () => {
        const first = projects.createProject({ name: 'Case-Second', methodology: 'minimal' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'case-second', methodology: 'minimal' });
        assert.equal(dup.project, null);
        assert.match(dup.errors[0], /Case-Second/, 'error names the existing project');
      });

      it('preserves the original-casing error format when names match exactly (back-compat)', () => {
        const first = projects.createProject({ name: 'exact-match', methodology: 'minimal' });
        assert.ok(first.project);

        const dup = projects.createProject({ name: 'exact-match', methodology: 'minimal' });
        assert.equal(dup.project, null);
        // When the case matches exactly, the legacy error format is preserved
        // — no spurious "case-insensitive match" suffix that would suggest
        // a casing difference where none exists.
        assert.equal(dup.errors[0], 'Project "exact-match" already exists');
      });

      it('attachProject also rejects case-collision (#221 symmetric gate audit)', () => {
        // Create a project, then create a sibling directory with case-only
        // difference, then try to attach that directory. The attach path
        // must reject for the same reason createProject does — otherwise
        // attach is the case-collision back door.
        projects.createProject({ name: 'attach-case', methodology: 'minimal' });
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
    it('getProject returns enriched project', () => {
      const project = projects.getProject('new-project');
      assert.ok(project);
      assert.equal(project.name, 'new-project');
      assert.ok(project.hasOwnProperty('engine'));
      assert.ok(project.hasOwnProperty('methodology'));
      assert.ok(project.hasOwnProperty('session'));
      assert.ok(project.hasOwnProperty('git'));
      assert.ok(project.hasOwnProperty('status'));
    });

    it('getProject returns null for unknown', () => {
      assert.equal(projects.getProject('nonexistent'), null);
    });

    it('listProjects returns array of enriched projects', () => {
      const list = projects.listProjects();
      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
      assert.ok(list[0].hasOwnProperty('engine'));
    });

    it('listProjects filters by tag', () => {
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

    it('surfaces drift-no-governance for a Cohort-B claude+prawduct project', () => {
      makeProject('gov-drift');
      assert.equal(projects.getProject('gov-drift').governanceState, 'drift-no-governance');
    });

    it('surfaces governed-plugin once the V2 plugin ref is present', () => {
      makeProject('gov-plugin', { settings: { enabledPlugins: { 'prawduct@prawduct': true } } });
      assert.equal(projects.getProject('gov-plugin').governanceState, 'governed-plugin');
    });

    it('surfaces not-applicable for a non-Claude project', () => {
      makeProject('gov-na', { engine: 'gemini' });
      assert.equal(projects.getProject('gov-na').governanceState, 'not-applicable');
    });

    it('every listProjects entry carries a governanceState field', () => {
      const list = projects.listProjects();
      assert.ok(list.length > 0);
      for (const p of list) {
        assert.ok(p.hasOwnProperty('governanceState'),
          `project ${p.name} missing governanceState`);
      }
    });
  });

  describe('syncAllProjects', () => {
    it('regenerates engine config for registered project', () => {
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

    it('creates memories directory for project missing it', () => {
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

    it('skips projects with missing paths without crashing', () => {
      // Create a project pointing to a non-existent path
      store.projects.create({ name: 'ghost-project', path: '/tmp/nonexistent-tc-path-12345', engine: 'claude' });
      const result = projects.syncAllProjects();
      assert.ok(Array.isArray(result.errors));
      // Should not throw, ghost project is silently skipped
      assert.ok(result.synced >= 0);
    });

    it('regenerates from DB methodology, ignoring a stale project.json string (#320)', () => {
      // Reproduce the TiLT v2 bug: DB says `prawduct`, but the git-tracked
      // project.json still carries a legacy `methodology: "minimal"`. The DB is
      // the single source of truth — sync must use it, not the stale file.
      const { project: proj } = projects.createProject({ name: 'stale-methodology', methodology: 'prawduct' });
      assert.equal(proj.methodology, 'prawduct');

      const projPath = path.join(projectsDir, 'stale-methodology');
      const configPath = path.join(projPath, '.tangleclaw', 'project.json');
      const projConfig = store.projectConfig.load(projPath);
      projConfig.methodology = 'minimal'; // legacy-schema leftover
      store.projectConfig.save(projPath, projConfig);
      // Sanity: the stale value is really on disk.
      assert.match(fs.readFileSync(configPath, 'utf8'), /"methodology":\s*"minimal"/);

      const claudeMd = path.join(projPath, 'CLAUDE.md');
      if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd);

      const result = projects.syncAllProjects();
      assert.ok(result.synced > 0);

      const content = fs.readFileSync(claudeMd, 'utf8');
      // Must reflect the DB's Prawduct, not the file's minimal.
      assert.match(content, /Prawduct/, 'CLAUDE.md should be regenerated from the DB methodology (prawduct)');
    });

    it('defers to the Prawduct V2 plugin at boot: preserves the anchor AND strips the governance hook (#330)', () => {
      // A project later onboarded to the V2 plugin: it carries the install
      // reference plus a leftover TC governance `.hooks` block and a plugin-owned
      // thin CLAUDE.md anchor. Boot-sync must NOT regenerate CLAUDE.md and MUST
      // strip the stale governance hooks (the gap the Critic flagged — boot-sync
      // previously called writeEngineConfig but not syncEngineHooks). silentPrime
      // is pinned off so this stays focused on governance-hook removal; the
      // L1-prime-preserved-on-a-governed-project case is covered in engines.test.js.
      projects.createProject({ name: 'plugin-governed-boot', methodology: 'prawduct' });
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
    it('updates tags', () => {
      const result = projects.updateProject('new-project', { tags: ['updated'] });
      assert.ok(result.project);
      assert.deepEqual(result.project.tags, ['updated']);
    });

    it('rejects core rule disabling', () => {
      const result = projects.updateProject('new-project', {
        rules: { core: { changelogPerChange: false } }
      });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('Core rules'));
    });

    it('updates extension rules', () => {
      const result = projects.updateProject('new-project', {
        rules: { extensions: { identitySentry: true } }
      });
      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.equal(projConfig.rules.extensions.identitySentry, true);
    });

    it('returns error for unknown project', () => {
      const result = projects.updateProject('nonexistent', { tags: [] });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('updates quick commands', () => {
      const cmds = [{ label: 'test', command: 'echo test' }];
      const result = projects.updateProject('new-project', { quickCommands: cmds });
      assert.ok(result.project);
      const projConfig = store.projectConfig.load(result.project.path);
      assert.deepEqual(projConfig.quickCommands, cmds);
    });

    describe('rename — case-insensitive collision handling (#221, sibling to #188)', () => {
      it('allows a case-only self-rename at the DB-validator level (foo-1 → Foo-1)', (t) => {
        // Set up a discrete project so other tests' state doesn't interfere.
        projects.createProject({ name: 'self-rename-src', methodology: 'minimal' });

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

      it('rejects renaming to a name that case-collides with a DIFFERENT existing project', () => {
        projects.createProject({ name: 'collision-dest', methodology: 'minimal' });
        projects.createProject({ name: 'rename-src', methodology: 'minimal' });

        const result = projects.updateProject('rename-src', { name: 'Collision-Dest' });
        assert.equal(result.project, null, 'cross-rename to a case-collision must be rejected');
        assert.ok(result.errors.length > 0);
        assert.match(result.errors[0], /collision-dest/, 'error cites the OTHER project');
        assert.match(result.errors[0], /case-insensitive/i,
          'error message calls out the case-collision so the operator understands the rejection');
      });

      it('preserves exact-case error format when rename target matches an existing name exactly', () => {
        projects.createProject({ name: 'exact-rename-target', methodology: 'minimal' });
        projects.createProject({ name: 'rename-source-2', methodology: 'minimal' });

        const result = projects.updateProject('rename-source-2', { name: 'exact-rename-target' });
        assert.equal(result.project, null);
        assert.equal(result.errors[0], 'Project "exact-rename-target" already exists',
          'exact-case collision keeps the legacy error format — no spurious case-insensitive suffix');
      });
    });
  });

  describe('deleteProject', () => {
    it('deletes project (archive only)', () => {
      projects.createProject({ name: 'to-delete', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete');
      assert.ok(result.success);
      assert.equal(result.filesDeleted, false);
      assert.equal(store.projects.getByName('to-delete'), null);
      // Directory should still exist
      assert.ok(fs.existsSync(path.join(projectsDir, 'to-delete')));
    });

    it('deletes project with files', () => {
      projects.createProject({ name: 'to-delete-files', methodology: 'minimal', gitInit: false });
      const result = projects.deleteProject('to-delete-files', { deleteFiles: true });
      assert.ok(result.success);
      assert.equal(result.filesDeleted, true);
      assert.ok(!fs.existsSync(path.join(projectsDir, 'to-delete-files')));
    });

    it('returns error for unknown project', () => {
      const result = projects.deleteProject('nonexistent');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });
  });

  describe('detectExistingProjects', () => {
    it('detects projects with .tangleclaw config', () => {
      const detectDir = path.join(projectsDir, 'detectable');
      fs.mkdirSync(path.join(detectDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(detectDir, '.tangleclaw', 'project.json'), '{}');

      const result = projects.detectExistingProjects();
      assert.ok(result.detected.some((d) => d.name === 'detectable'));
    });

    it('skips already registered projects', () => {
      const result = projects.detectExistingProjects();
      // new-project is already registered, should not appear
      assert.ok(!result.detected.some((d) => d.name === 'new-project'));
    });

    it('skips hidden directories', () => {
      fs.mkdirSync(path.join(projectsDir, '.hidden-dir'), { recursive: true });
      const result = projects.detectExistingProjects();
      assert.ok(!result.detected.some((d) => d.name === '.hidden-dir'));
    });
  });

  describe('listAllProjects', () => {
    it('includes both registered and unregistered projects', () => {
      // Create an unregistered directory
      fs.mkdirSync(path.join(projectsDir, 'unregistered-proj'), { recursive: true });

      const all = projects.listAllProjects();
      const registered = all.filter(p => p.registered === true);
      const unregistered = all.filter(p => p.registered === false);

      assert.ok(registered.length > 0, 'Should have registered projects');
      assert.ok(unregistered.some(p => p.name === 'unregistered-proj'), 'Should include unregistered dir');
    });

    it('unregistered projects have expected shape', () => {
      const all = projects.listAllProjects();
      const unreg = all.find(p => p.name === 'unregistered-proj');
      assert.ok(unreg);
      assert.equal(unreg.registered, false);
      assert.equal(unreg.engine, null);
      assert.equal(unreg.session, null);
      assert.deepEqual(unreg.tags, []);
      assert.ok('path' in unreg);
    });

    it('results are sorted by name', () => {
      const all = projects.listAllProjects();
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i - 1].name.toLowerCase() <= all[i].name.toLowerCase(),
          `${all[i - 1].name} should be before ${all[i].name}`);
      }
    });

    it('does not include hidden directories', () => {
      const all = projects.listAllProjects();
      assert.ok(!all.some(p => p.name.startsWith('.')));
    });
  });

  describe('attachProject', () => {
    it('attaches an existing unregistered directory', () => {
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

    it('reads existing .tangleclaw/project.json', () => {
      const attachDir = path.join(projectsDir, 'has-config');
      fs.mkdirSync(path.join(attachDir, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(attachDir, '.tangleclaw', 'project.json'),
        JSON.stringify({ engine: 'codex', methodology: 'prawduct' }));

      const result = projects.attachProject('has-config');
      assert.ok(result.project);
      // Should use engine from existing config
      const dbProject = store.projects.getByName('has-config');
      assert.equal(dbProject.engineId, 'codex');
    });

    it('rejects already registered project', () => {
      const result = projects.attachProject('new-project');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('already registered'));
    });

    it('rejects non-existent directory', () => {
      const result = projects.attachProject('does-not-exist-xyz');
      assert.equal(result.project, null);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('rejects invalid name', () => {
      const result = projects.attachProject('bad name!');
      assert.equal(result.project, null);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('archiveProject', () => {
    it('archives a registered project', () => {
      const result = projects.archiveProject('attachable');
      assert.ok(result.success);
      // Should not appear in default list
      const list = projects.listProjects();
      assert.ok(!list.some(p => p.name === 'attachable'));
    });

    it('rejects archiving an already-archived project', () => {
      const result = projects.archiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('already archived'));
    });

    it('rejects archiving a non-existent project', () => {
      const result = projects.archiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });

    it('archived projects excluded from syncAllProjects', () => {
      // syncAllProjects uses store.projects.list() which excludes archived
      const syncResult = projects.syncAllProjects();
      // attachable is archived, should not be counted
      const allActive = store.projects.list();
      assert.ok(!allActive.some(p => p.name === 'attachable'));
    });

    it('archived projects excluded from listAllProjects unregistered scan', () => {
      const all = projects.listAllProjects();
      // attachable is archived — should not appear as unregistered
      const asUnreg = all.find(p => p.name === 'attachable' && p.registered === false);
      assert.equal(asUnreg, undefined);
    });
  });

  describe('unarchiveProject', () => {
    it('restores an archived project', () => {
      const result = projects.unarchiveProject('attachable');
      assert.ok(result.success);
      // Should appear in default list again
      const list = projects.listProjects();
      assert.ok(list.some(p => p.name === 'attachable'));
    });

    it('rejects unarchiving a non-archived project', () => {
      const result = projects.unarchiveProject('attachable');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not archived'));
    });

    it('rejects unarchiving a non-existent project', () => {
      const result = projects.unarchiveProject('nonexistent-xyz');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });
  });

  describe('resolveProjectsDir', () => {
    it('expands tilde to home directory', () => {
      const result = projects.resolveProjectsDir('~/Documents');
      assert.ok(result.startsWith(process.env.HOME));
      assert.ok(result.endsWith('/Documents'));
    });

    it('returns absolute paths unchanged', () => {
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

    it('should include version from project package.json', () => {
      const projPath = path.join(versionDir, 'with-version');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '2.5.0' }));

      const registered = store.projects.create({ name: 'ver-test-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '2.5.0');
    });

    it('should return null version when project has no package.json', () => {
      const projPath = path.join(versionDir, 'no-pkg');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-test-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json has no version field', () => {
      const projPath = path.join(versionDir, 'no-ver-field');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ name: 'test' }));

      const registered = store.projects.create({ name: 'ver-test-3', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('should return null version when package.json is malformed', () => {
      const projPath = path.join(versionDir, 'bad-json');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), 'not json{{{');

      const registered = store.projects.create({ name: 'ver-test-4', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    // ── #55: Universal version detection chain ──

    it('layer 1: should read version from .tangleclaw/project-version.txt cache file', () => {
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

    it('layer 1: live source overrides stale cache and self-heals (#165 — semantic inversion of pre-#165 cache-wins)', () => {
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

    it('layer 1: malformed cache file falls through to next layer', () => {
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

    it('layer 2: should read first released version from CHANGELOG.md', () => {
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

    it('layer 2: CHANGELOG with only [Unreleased] falls through to next layer', () => {
      const projPath = path.join(versionDir, 'changelog-unreleased-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- not yet released\n');
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '0.1.0' }));

      const registered = store.projects.create({ name: 'ver-cl-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '0.1.0');
    });

    it('layer 2: CHANGELOG should win over version.json and package.json when present', () => {
      const projPath = path.join(versionDir, 'changelog-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [2.0.0] - 2026-04-01\n');
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-cl-3', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '2.0.0');
    });

    it('layer 3: should read version from version.json (TangleClaw convention)', () => {
      const projPath = path.join(versionDir, 'versionjson-only');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.12.7' }));

      const registered = store.projects.create({ name: 'ver-vj-1', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '3.12.7');
    });

    it('layer 3: version.json should win over package.json when no cache or CHANGELOG', () => {
      const projPath = path.join(versionDir, 'versionjson-precedence');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '3.0.0' }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '4.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-2', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, '3.0.0');
    });

    it('chain: all sources missing returns null', () => {
      const projPath = path.join(versionDir, 'nothing');
      fs.mkdirSync(projPath, { recursive: true });

      const registered = store.projects.create({ name: 'ver-none', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.version, null);
    });

    it('chain: project path that does not exist returns null without throwing', () => {
      // Simulate a registered project whose directory was deleted
      const result = projects._detectProjectVersion('/nonexistent/path/that/should/not/exist/anywhere');
      assert.equal(result, null);
    });

    it('helpers: _readChangelogVersion handles version with build metadata (e.g. 0.6.9-beta)', () => {
      const projPath = path.join(versionDir, 'changelog-prerelease');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [0.6.9-beta] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), '0.6.9-beta');
    });

    it('helpers: _readChangelogVersion rejects date-style headers (not a version)', () => {
      const projPath = path.join(versionDir, 'changelog-date-header');
      fs.mkdirSync(projPath, { recursive: true });
      // Some projects use date headers like ## [2026-03-31] — these are NOT versions
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [2026-03-31] — Some Release\n\n## [2026-03-30] — Earlier Release\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), null);
    });

    it('helpers: _readChangelogVersion skips date headers and finds first valid version', () => {
      const projPath = path.join(versionDir, 'changelog-mixed-headers');
      fs.mkdirSync(projPath, { recursive: true });
      // Mixed: a date header AND a valid version — should skip the date and pick the version
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '# Changelog\n\n## [2026-03-31] — Date Entry\n\n## [1.2.3] - 2026-03-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('helpers: _readChangelogVersion accepts v-prefixed versions (e.g. v1.0.0)', () => {
      const projPath = path.join(versionDir, 'changelog-v-prefix');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [v1.0.0] - 2026-04-01\n');
      assert.equal(projects._readChangelogVersion(projPath), 'v1.0.0');
    });

    // ── Critic follow-ups (#55 chunk 1 hardening) ──

    it('BOM: _readChangelogVersion handles UTF-8 BOM-prefixed file', () => {
      const projPath = path.join(versionDir, 'changelog-bom');
      fs.mkdirSync(projPath, { recursive: true });
      // Write a BOM-prefixed CHANGELOG — common from Windows editors
      fs.writeFileSync(
        path.join(projPath, 'CHANGELOG.md'),
        '\uFEFF# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-04-01\n'
      );
      assert.equal(projects._readChangelogVersion(projPath), '1.2.3');
    });

    it('BOM: _readVersionJsonVersion handles UTF-8 BOM-prefixed file', () => {
      const projPath = path.join(versionDir, 'versionjson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        '\uFEFF' + JSON.stringify({ version: '7.7.7' })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), '7.7.7');
    });

    it('BOM: _readPackageJsonVersion handles UTF-8 BOM-prefixed file', () => {
      const projPath = path.join(versionDir, 'packagejson-bom');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'package.json'),
        '\uFEFF' + JSON.stringify({ version: '8.8.8' })
      );
      assert.equal(projects._readPackageJsonVersion(projPath), '8.8.8');
    });

    it('BOM: _readVersionCacheFile handles UTF-8 BOM-prefixed file', () => {
      const projPath = path.join(versionDir, 'cache-bom');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        '\uFEFFversion: 9.9.9\nsource: manual\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '9.9.9');
    });

    it('version.json: rejects non-string version (number)', () => {
      const projPath = path.join(versionDir, 'vj-number');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: 123 }));
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const registered = store.projects.create({ name: 'ver-vj-num', path: projPath, engineId: 'claude-code' });
      const enriched = projects.enrichProject(registered);
      // Should fall through to package.json since version.json had non-string
      assert.equal(enriched.version, '1.0.0');
    });

    it('version.json: rejects non-string version (object)', () => {
      const projPath = path.join(versionDir, 'vj-object');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(
        path.join(projPath, 'version.json'),
        JSON.stringify({ version: { major: 1, minor: 2 } })
      );
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects missing version field', () => {
      const projPath = path.join(versionDir, 'vj-missing');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ name: 'only-name' }));
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('version.json: rejects malformed JSON', () => {
      const projPath = path.join(versionDir, 'vj-bad');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'version.json'), 'not json{{{');
      assert.equal(projects._readVersionJsonVersion(projPath), null);
    });

    it('cache file: rejects whitespace-only version value', () => {
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

    it('cache file: handles CRLF line endings', () => {
      const projPath = path.join(versionDir, 'cache-crlf');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project-version.txt'),
        'version: 5.5.5\r\nrecorded_at: 2026-04-10\r\nsource: manual\r\n'
      );
      assert.equal(projects._readVersionCacheFile(projPath), '5.5.5');
    });

    it('layer 4 symmetry: package.json used when no cache/CHANGELOG/version.json', () => {
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

    it('rewrites cache when on-disk version.json is newer than cached value', () => {
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

    it('rewrites cache when CHANGELOG.md is newer than cached value (priority: CHANGELOG over version.json)', () => {
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

    it('does not rewrite cache when cached value matches live value (steady state)', () => {
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

    it('preserves cache when no on-disk live source exists (git-tag-derived cache survives)', () => {
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

    it('returns live value without crashing when cache write fails (fail-open contract)', () => {
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

    it('creates .tangleclaw/ if missing when self-healing a project that never had a cache', () => {
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

    it('returns null for non-existent project path without throwing', () => {
      const result = projects._detectProjectVersion('/nonexistent/path/for-165-test');
      assert.equal(result, null);
    });

    it('_detectLiveVersion returns null when no on-disk live source exists', () => {
      const projPath = path.join(healDir, 'no-live-sources');
      fs.mkdirSync(projPath, { recursive: true });
      assert.equal(projects._detectLiveVersion(projPath), null);
    });

    it('_detectLiveVersion reports source label matching the reader that hit', () => {
      const projPath = path.join(healDir, 'live-source-labels');
      fs.mkdirSync(projPath, { recursive: true });
      fs.writeFileSync(path.join(projPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '1.0.0', source: 'package.json' });

      fs.writeFileSync(path.join(projPath, 'version.json'), JSON.stringify({ version: '2.0.0' }));
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '2.0.0', source: 'version.json' });

      fs.writeFileSync(path.join(projPath, 'CHANGELOG.md'), '## [3.0.0] - 2026-05-13\n');
      assert.deepEqual(projects._detectLiveVersion(projPath), { version: '3.0.0', source: 'CHANGELOG.md' });
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

    it('enrichProject exposes silentPrime: true by default (#129)', () => {
      // Pre-#129 the default was false (opt-in). Soak satisfied; silent prime
      // is now the default. See lib/store.js:DEFAULT_PROJECT_CONFIG.
      const projPath = path.join(primeDir, 'sp-default');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-default', path: projPath, engineId: 'claude' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('enrichProject reflects silentPrime: true once set in projectConfig', () => {
      const projPath = path.join(primeDir, 'sp-on');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-on', path: projPath, engineId: 'claude' });
      const projConfig = store.projectConfig.load(projPath);
      projConfig.silentPrime = true;
      store.projectConfig.save(projPath, projConfig);
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, true);
    });

    it('updateProject persists silentPrime=true when engine supports it', () => {
      const projPath = path.join(primeDir, 'sp-update-on');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-on', path: projPath, engineId: 'claude' });
      const result = projects.updateProject('sp-update-on', { silentPrime: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.project.silentPrime, true);
      const persisted = store.projectConfig.load(projPath);
      assert.equal(persisted.silentPrime, true);
    });

    it('updateProject persists silentPrime=false (clearing the flag)', () => {
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

    it('updateProject rejects silentPrime=true when engine lacks the capability', () => {
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

    it('updateProject rejects non-boolean silentPrime', () => {
      const projPath = path.join(primeDir, 'sp-update-nonbool');
      fs.mkdirSync(projPath, { recursive: true });
      store.projects.create({ name: 'sp-update-nonbool', path: projPath, engineId: 'claude' });
      const result = projects.updateProject('sp-update-nonbool', { silentPrime: 'yes' });
      assert.equal(result.project, null);
      assert.ok(result.errors[0].toLowerCase().includes('boolean'));
    });

    it('updateProject silentPrime=false is accepted even on unsupported engines (always allowed to clear)', () => {
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
    it('updateProject rejects engine+silentPrime PATCH atomically when new engine lacks capability', () => {
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
    it('updateProject syncs SessionStart hook to .claude/settings.json on silentPrime=true (#137)', () => {
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
      assert.ok(cmd.endsWith('sessionstart-prime.sh'), 'command should point at the bundled hook script');
      assert.equal(cmd.includes('{{TANGLECLAW_DIR}}'), false, 'placeholder should be resolved');
    });

    it('updateProject removes SessionStart hook from .claude/settings.json on silentPrime=false (#137)', () => {
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

    it('updateProject removes stale .tangleclaw/session-prime.md on silentPrime=false (#137)', () => {
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
    it('updateProject clears orphan SessionStart hook when engine flips claude → non-claude (#140)', () => {
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
      // scenario from #140's repro.
      const result = projects.updateProject('sp-engine-flip-orphan', { engine: 'gemini' });
      assert.deepEqual(result.errors, []);
      assert.equal(store.projects.getByName('sp-engine-flip-orphan').engineId, 'gemini');

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

    it('updateProject materializes SessionStart hook when engine flips non-claude → claude with silentPrime=true (#140)', () => {
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

    it('updateProject silentPrime=false is a no-op for prime cleanup when file is absent (#137)', () => {
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

  describe('methodology flip cleanup audit (#145, chunk 3)', () => {
    // Closes the audit gap on `PATCH methodology` — chunks 1+2 fixed the
    // injection side (don't inject hooks whose runtime is missing; strip
    // orphans on demand). This block locks in the cleanup side: flipping a
    // project's methodology must rebuild `.claude/settings.json.hooks` from
    // the new template, never carry forward the previous methodology's
    // entries. Pattern is the symmetric-capability-gates ADR
    // (`docs/adr/0001-symmetric-capability-gates.md`).
    let methDir;
    // Synthetic methodology that DECLARES governance hooks. Since C2 (#353)
    // stripped L3/L4 from the bundled `prawduct` template, no shipped
    // methodology carries hooks anymore — so the flip machinery (materialize /
    // strip / preserve-non-hook-keys / silentPrime-survival) can only be
    // exercised against a methodology that genuinely declares them. We clone
    // the real prawduct template and restore the pre-C2 `requires`-gated
    // product-hook block under a distinct id; this isolates the variable under
    // test (the flip logic) from the bundled template's hook content.
    const HOOKED_METHODOLOGY_ID = 'gov-hooked-test';

    before(() => {
      methDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-meth-flip-'));
      const hooked = JSON.parse(JSON.stringify(store.templates.get('prawduct')));
      hooked.id = HOOKED_METHODOLOGY_ID;
      hooked.name = 'Gov Hooked (test)';
      hooked.hooks = {
        claude: {
          SessionStart: [{
            matcher: 'startup|clear|resume',
            requires: ['tools/product-hook'],
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" clear', statusMessage: 'Preparing session...' }]
          }],
          Stop: [{
            matcher: '',
            requires: ['tools/product-hook'],
            hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop', statusMessage: 'Checking governance gates...' }]
          }]
        }
      };
      store.templates.save(hooked);
    });

    after(() => {
      fs.rmSync(methDir, { recursive: true, force: true });
      try { store.templates.delete(HOOKED_METHODOLOGY_ID); } catch { /* best-effort cleanup */ }
    });

    /**
     * Set up a registered project on the synthetic hooked methodology with the
     * runtime materialized on disk so the chunk-1 `requires` filter ACCEPTS the
     * governance hooks at `syncEngineHooks` time, then trigger the sync so hooks
     * land in `.claude/settings.json`. Bypasses `projects.createProject` (which
     * enforces a single configured `projectsDir`) and uses the same
     * `store.projects.create({ path: ... })` pattern as the existing
     * silentPrime engine-flip tests at line 1076.
     */
    function scaffoldPrawductProject(name) {
      const projPath = path.join(methDir, name);
      fs.mkdirSync(projPath, { recursive: true });
      // Scaffold the runtime so chunk-1's requires filter accepts the hooks
      fs.mkdirSync(path.join(projPath, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projPath, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');

      // Register project with methodology=prawduct in DB; sync projConfig so
      // syncEngineHooks reads the right engine + methodology. Explicit
      // silentPrime=false keeps the audit focused on methodology hooks only —
      // post-#129 the default would inject the silentPrime baseline SessionStart
      // hook and mask the methodology-strip assertion.
      store.projects.create({ name, path: projPath, engine: 'claude', methodology: HOOKED_METHODOLOGY_ID });
      const projConfig = store.projectConfig.load(projPath);
      projConfig.methodology = HOOKED_METHODOLOGY_ID;
      projConfig.silentPrime = false;
      store.projectConfig.save(projPath, projConfig);

      // Trigger syncEngineHooks to inject the methodology's governance hooks
      const template = store.templates.get(HOOKED_METHODOLOGY_ID);
      engines.syncEngineHooks(projPath, template);

      // Sanity — chunks 1+2 land the governance hooks
      const settingsPath = path.join(projPath, '.claude', 'settings.json');
      assert.ok(fs.existsSync(settingsPath), 'expected .claude/settings.json after sync');
      const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(before.hooks, 'expected .claude/settings.json.hooks to be populated after sync');
      assert.ok(JSON.stringify(before.hooks).includes('product-hook'),
        'expected prawduct product-hook reference in hooks before flip');
      return { projPath, settingsPath };
    }

    it('PATCH methodology: prawduct → minimal rebuilds hooks without prawduct entries', () => {
      const { projPath, settingsPath } = scaffoldPrawductProject('flip-to-minimal');

      const result = projects.updateProject('flip-to-minimal', { methodology: 'minimal' });
      assert.deepStrictEqual(result.errors, [], `update errors: ${result.errors.join(',')}`);
      assert.ok(result.methodologySwitch, 'expected methodologySwitch to be populated');
      assert.equal(result.methodologySwitch.from, HOOKED_METHODOLOGY_ID);
      assert.equal(result.methodologySwitch.to, 'minimal');

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const afterStr = JSON.stringify(after);
      assert.ok(!afterStr.includes('product-hook'),
        `expected no product-hook references after flip; got: ${afterStr}`);
      // Minimal has no hooks and silentPrime is off by default, so the hooks
      // key should be absent entirely (matches `delete settings.hooks` branch
      // of syncEngineHooks).
      assert.equal(after.hooks, undefined, 'expected hooks key removed when new methodology has none');
      // Project record reflects the new methodology
      const reloaded = store.projects.getByName('flip-to-minimal');
      assert.equal(reloaded.methodology, 'minimal');
      assert(projPath);
    });

    // `PATCH methodology: null` is rejected as of #151. The chunk-3 audit
    // surfaced two stacked bugs on what used to be the "removal" path —
    // ReferenceError at lib/projects.js:1174 (fixed in chunk 3) layered on
    // an SQL NOT NULL constraint. Rather than fixing both, #151 retired
    // the null-methodology semantic: per docs/methodology-guide.md every
    // project has a methodology, and `minimal` is the canonical no-workflow
    // option. The API now rejects null with a 400-style error pointing the
    // caller at `'minimal'`. See ADR 0001 §"Anti-patterns".
    it('PATCH with combined name+null-methodology rejects without renaming on disk (#151 Critic Major)', () => {
      // The null-rejection runs in the pre-mutation validation phase so a
      // combined { name, methodology: null } payload doesn't rename the
      // project on disk before the validation fires. Pre-fix, the rejection
      // lived inside the methodology branch, after the rename branch had
      // already mutated DB + filesystem.
      const { projPath } = scaffoldPrawductProject('flip-combined-name-null');
      const result = projects.updateProject('flip-combined-name-null', {
        name: 'flip-combined-name-null-RENAMED',
        methodology: null
      });

      assert.equal(result.project, null, 'expected null project on rejection');
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /methodology cannot be null/i);

      // Name unchanged in DB
      const oldByName = store.projects.getByName('flip-combined-name-null');
      const newByName = store.projects.getByName('flip-combined-name-null-RENAMED');
      assert.ok(oldByName, 'original name should still resolve');
      assert.equal(newByName, null, 'attempted new name should not resolve');
      // Directory unchanged on disk
      assert.equal(fs.existsSync(projPath), true, 'original directory should remain');
      assert.equal(fs.existsSync(projPath + '-RENAMED'), false, 'no renamed directory should appear');
    });

    it('projectConfig.load coerces on-disk methodology: null to \'minimal\' (#151 Critic Major)', () => {
      // Pre-#151 installs may have project.json files with `methodology: null`
      // explicitly written to disk (when DEFAULT_PROJECT_CONFIG.methodology was
      // null). The merge loop in store.projectConfig.load propagates explicit
      // fields from disk over the default, so without coercion an upgraded
      // install would keep seeing null in projConfig even after this PR.
      const projPath = path.join(methDir, 'legacy-projconfig');
      fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
      // Write a project.json with an explicit null methodology — what a pre-#151
      // install left on disk
      fs.writeFileSync(
        path.join(projPath, '.tangleclaw', 'project.json'),
        JSON.stringify({ engine: 'claude', methodology: null, rules: { extensions: {} } })
      );
      const loaded = store.projectConfig.load(projPath);
      assert.equal(loaded.methodology, 'minimal', 'legacy null on disk should coerce to minimal on load');
      assert.equal(loaded.engine, 'claude', 'other fields should still come through the merge');
    });

    it('store.DEFAULT_PROJECT_CONFIG.methodology is \'minimal\', not null (#151)', () => {
      // Source-of-truth alignment with the DB schema's NOT NULL DEFAULT 'minimal'.
      // Pre-#151, projConfig defaulted to null while the DB defaulted to 'minimal',
      // leaving a split-brain where any reader had to know which source to trust.
      assert.equal(store.DEFAULT_PROJECT_CONFIG.methodology, 'minimal');
    });

    it('PATCH methodology: null is rejected with a clear error pointing to \'minimal\' (#151)', () => {
      const { settingsPath } = scaffoldPrawductProject('flip-to-null-rejected');
      const result = projects.updateProject('flip-to-null-rejected', { methodology: null });

      assert.equal(result.project, null, 'expected null project on rejection');
      assert.equal(result.methodologySwitch, null);
      assert.ok(
        result.errors.some(e => /methodology cannot be null/i.test(e) && /'minimal'/.test(e)),
        `expected an error mentioning null + 'minimal'; got: ${JSON.stringify(result.errors)}`
      );

      // Sanity: the project's state is unchanged after the rejected PATCH
      const reloaded = store.projects.getByName('flip-to-null-rejected');
      assert.equal(reloaded.methodology, HOOKED_METHODOLOGY_ID, 'methodology unchanged after rejection');
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(JSON.stringify(after.hooks || {}).includes('product-hook'),
        'governance hooks still in place after rejection — no destructive partial mutation');
    });

    it('PATCH methodology preserves non-hook keys in .claude/settings.json across the flip', () => {
      const { projPath, settingsPath } = scaffoldPrawductProject('flip-preserves-other-keys');
      // Inject a non-hook key the user might depend on. Chunk 2's strip path
      // documented this same preservation contract for the bulk-repair; the
      // flip path must honor it too.
      const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      existing.permissions = { allow: ['Bash(npm:*)'] };
      existing.companyAnnouncements = ['Hello'];
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');

      const result = projects.updateProject('flip-preserves-other-keys', { methodology: 'minimal' });
      assert.deepStrictEqual(result.errors, []);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(after.permissions, { allow: ['Bash(npm:*)'] }, 'permissions key must survive flip');
      assert.deepStrictEqual(after.companyAnnouncements, ['Hello'], 'companyAnnouncements must survive flip');
      assert.equal(after.hooks, undefined);
      assert(projPath);
    });

    it('PATCH methodology: minimal → hooked materializes governance hooks (reverse-direction coverage)', () => {
      // ADR 0001 anti-pattern §4: "single-direction regression test ... both
      // directions of every paired transition need coverage." The above
      // tests cover the strip direction (hooked → minimal); this test
      // covers the materialize direction (minimal → hooked), confirming
      // that switching INTO a methodology with hooks injects them the same
      // way `createProject` would.
      const name = 'flip-minimal-to-prawduct';
      const projPath = path.join(methDir, name);
      fs.mkdirSync(projPath, { recursive: true });
      fs.mkdirSync(path.join(projPath, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(projPath, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');

      // Start in the minimal state — no hooks. Explicit silentPrime=false to
      // keep the audit focused on methodology hooks only (post-#129 the
      // default would inject the silentPrime baseline SessionStart entry).
      store.projects.create({ name, path: projPath, engine: 'claude', methodology: 'minimal' });
      const projConfig = store.projectConfig.load(projPath);
      projConfig.methodology = 'minimal';
      projConfig.silentPrime = false;
      store.projectConfig.save(projPath, projConfig);
      engines.syncEngineHooks(projPath, store.templates.get('minimal'));
      const settingsPath = path.join(projPath, '.claude', 'settings.json');
      const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(before.hooks, undefined, 'expected no hooks in minimal pre-state');

      // Flip into the hooked methodology
      const result = projects.updateProject(name, { methodology: HOOKED_METHODOLOGY_ID });
      assert.deepStrictEqual(result.errors, [], `update errors: ${result.errors.join(',')}`);
      assert.ok(result.methodologySwitch, 'expected methodologySwitch on materialize-direction flip');
      assert.equal(result.methodologySwitch.from, 'minimal');
      assert.equal(result.methodologySwitch.to, HOOKED_METHODOLOGY_ID);

      // Governance hooks should now be present
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(after.hooks, 'expected hooks block after materialize-direction flip');
      assert.ok(after.hooks.Stop, 'expected governance Stop hook materialized');
      assert.ok(JSON.stringify(after.hooks).includes('product-hook'),
        'expected product-hook reference after materialize-direction flip');
    });

    it('silentPrime baseline SessionStart hook survives methodology flip (capability-gate independent)', () => {
      // The symmetric-capability-gates pattern: the silentPrime gate runs
      // independently of the methodology gate. A flip that wipes methodology
      // hooks must leave the silentPrime baseline hook alone, because that
      // entry comes from `_buildBaselineHooks` against `projConfig.silentPrime`
      // + the engine's `supportsSilentPrime` capability, not from the
      // methodology template.
      const { projPath, settingsPath } = scaffoldPrawductProject('flip-keeps-silentprime');

      // Opt-in silentPrime so the baseline hook materializes
      const enable = projects.updateProject('flip-keeps-silentprime', { silentPrime: true });
      assert.deepStrictEqual(enable.errors, []);
      const beforeFlip = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(beforeFlip.hooks && beforeFlip.hooks.SessionStart, 'silentPrime SessionStart should be present pre-flip');
      const hasSilentPrimeBefore = JSON.stringify(beforeFlip.hooks).includes('sessionstart-prime');
      assert.ok(hasSilentPrimeBefore, 'expected sessionstart-prime baseline before flip');

      // Now flip methodology — prawduct hooks should be stripped, baseline preserved
      const flip = projects.updateProject('flip-keeps-silentprime', { methodology: 'minimal' });
      assert.deepStrictEqual(flip.errors, []);

      const afterFlip = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(afterFlip.hooks && afterFlip.hooks.SessionStart, 'silentPrime SessionStart must survive flip');
      const afterStr = JSON.stringify(afterFlip.hooks);
      assert.ok(afterStr.includes('sessionstart-prime'), 'expected sessionstart-prime baseline after flip');
      assert.ok(!afterStr.includes('product-hook'), 'expected no product-hook references after flip');
      assert(projPath);
    });
  });
});
