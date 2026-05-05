'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');

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

    it('layer 1: cache file should win over CHANGELOG, version.json, and package.json', () => {
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
      assert.equal(enriched.version, '1.0.0-from-cache');
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

  // ── #103 chunk 2: silentPrime UI toggle (enrichment + updateProject) ──
  describe('silentPrime (#103)', () => {
    let primeDir;

    before(() => {
      primeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-silent-prime-'));
    });

    after(() => {
      fs.rmSync(primeDir, { recursive: true, force: true });
    });

    it('enrichProject exposes silentPrime: false by default', () => {
      const projPath = path.join(primeDir, 'sp-default');
      fs.mkdirSync(projPath, { recursive: true });
      const registered = store.projects.create({ name: 'sp-default', path: projPath, engineId: 'claude' });
      const enriched = projects.enrichProject(registered);
      assert.equal(enriched.silentPrime, false);
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
      // And the file was not written
      assert.equal(store.projectConfig.load(projPath).silentPrime, false);
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

      // Verify NO disk-state drift: the engine field on projConfig was not mutated.
      const afterProjConfig = store.projectConfig.load(projPath);
      assert.equal(afterProjConfig.engine || null, null, 'projConfig.engine must not have been written');
      assert.equal(afterProjConfig.silentPrime, false, 'silentPrime must not have been written either');

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
});
