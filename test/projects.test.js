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
  });
});
