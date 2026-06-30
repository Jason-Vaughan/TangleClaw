'use strict';

// Tests for the Project Map per-project toggle + seeding (PIDX #360, #356, slice 1).
// Covers: DEFAULT_PROJECT_CONFIG default, _listTopLevelDirs filtering,
// _buildProjectMapContent shape, _seedProjectMapFile idempotence, updateProject
// validation + persistence + seed-on-toggle, enrichProject surface.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');

describe('project-map (PIDX #360, #356, slice 1)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-project-map-'));
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

  describe('DEFAULT_PROJECT_CONFIG', () => {
    it('defaults projectMapEnabled to false', () => {
      const projectPath = path.join(projectsDir, 'pm-default-config');
      fs.mkdirSync(projectPath, { recursive: true });
      const config = store.projectConfig.load(projectPath);
      assert.equal(config.projectMapEnabled, false);
    });
  });

  describe('_listTopLevelDirs', () => {
    it('lists directories and excludes vendored/build/hidden dirs', () => {
      const p = path.join(tmpDir, 'list-dirs');
      for (const d of ['lib', 'data', 'test', 'node_modules', 'dist', 'build', 'coverage', '.git', '.hidden']) {
        fs.mkdirSync(path.join(p, d), { recursive: true });
      }
      fs.writeFileSync(path.join(p, 'README.md'), '# x'); // a file, not a dir

      const dirs = projects._listTopLevelDirs(p);
      assert.deepEqual(dirs, ['data', 'lib', 'test']); // sorted, filtered, no files
    });

    it('returns [] (non-throwing) for an unreadable path', () => {
      assert.deepEqual(projects._listTopLevelDirs(path.join(tmpDir, 'nope', 'missing')), []);
    });
  });

  describe('_buildProjectMapContent', () => {
    it('includes the header, a Structure section with dir bullets, and a Shared-dirs section', () => {
      const p = path.join(tmpDir, 'build-content');
      fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(p, 'deploy'), { recursive: true });

      const content = projects._buildProjectMapContent(p);
      assert.ok(content.includes('# Project Map'));
      assert.ok(content.includes('## Structure'));
      assert.ok(content.includes('- `deploy/` — <!-- describe -->'));
      assert.ok(content.includes('- `lib/` — <!-- describe -->'));
      assert.ok(content.includes('## Shared directories / doc groups'));
    });

    it('emits a placeholder when no top-level directories exist', () => {
      const p = path.join(tmpDir, 'build-empty');
      fs.mkdirSync(p, { recursive: true });
      const content = projects._buildProjectMapContent(p);
      assert.ok(content.includes('<!-- no top-level directories detected -->'));
    });
  });

  describe('_seedProjectMapFile helper', () => {
    it('creates PROJECT-MAP.md with generated content when absent', () => {
      const projectPath = path.join(tmpDir, 'pm-seed-create');
      fs.mkdirSync(path.join(projectPath, 'lib'), { recursive: true });

      const created = projects._seedProjectMapFile(projectPath);
      assert.equal(created, true);

      const filePath = path.join(projectPath, projects.PROJECT_MAP_FILENAME);
      assert.ok(fs.existsSync(filePath), 'PROJECT-MAP.md should be created');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('# Project Map'));
      assert.ok(content.includes('- `lib/` — <!-- describe -->'));
    });

    it('is idempotent — never overwrites an existing PROJECT-MAP.md', () => {
      const projectPath = path.join(tmpDir, 'pm-seed-idempotent');
      fs.mkdirSync(projectPath, { recursive: true });
      const filePath = path.join(projectPath, projects.PROJECT_MAP_FILENAME);
      const handAuthored = '# Curated map\n\n- keep me\n';
      fs.writeFileSync(filePath, handAuthored);

      const created = projects._seedProjectMapFile(projectPath);
      assert.equal(created, false);
      assert.equal(fs.readFileSync(filePath, 'utf8'), handAuthored);
    });

    it('returns false (non-throwing) on write error', () => {
      const bogusPath = path.join(tmpDir, 'pm', 'does', 'not', 'exist');
      assert.equal(projects._seedProjectMapFile(bogusPath), false);
    });
  });

  describe('updateProject — projectMapEnabled', () => {
    function makeProject(name) {
      const result = projects.createProject({ name, methodology: 'minimal' });
      assert.ok(result.project, 'project should be created');
      return result.project;
    }

    it('rejects a non-boolean value without mutating state', () => {
      const project = makeProject('pm-validate');
      const result = projects.updateProject(project.name, { projectMapEnabled: 'yes' });
      assert.deepEqual(result.errors, ['projectMapEnabled must be a boolean']);
      assert.equal(result.project, null);
      assert.equal(store.projectConfig.load(project.path).projectMapEnabled, false);
    });

    it('seeds PROJECT-MAP.md on a false → true transition when the file is absent', () => {
      const project = makeProject('pm-seed-on-toggle');
      fs.mkdirSync(path.join(project.path, 'lib'), { recursive: true });
      const filePath = path.join(project.path, projects.PROJECT_MAP_FILENAME);
      assert.equal(fs.existsSync(filePath), false);

      projects.updateProject(project.name, { projectMapEnabled: true });

      assert.equal(store.projectConfig.load(project.path).projectMapEnabled, true);
      assert.ok(fs.existsSync(filePath), 'toggle-on should seed PROJECT-MAP.md');
    });

    it('does NOT overwrite a pre-existing PROJECT-MAP.md on toggle-on', () => {
      const project = makeProject('pm-no-overwrite');
      const filePath = path.join(project.path, projects.PROJECT_MAP_FILENAME);
      const curated = '# Mine\n\n- entry\n';
      fs.writeFileSync(filePath, curated);

      projects.updateProject(project.name, { projectMapEnabled: true });
      assert.equal(fs.readFileSync(filePath, 'utf8'), curated);
    });

    it('does NOT delete PROJECT-MAP.md on toggle-off', () => {
      const project = makeProject('pm-no-delete');
      const filePath = path.join(project.path, projects.PROJECT_MAP_FILENAME);
      projects.updateProject(project.name, { projectMapEnabled: true });
      assert.ok(fs.existsSync(filePath));

      projects.updateProject(project.name, { projectMapEnabled: false });
      assert.equal(store.projectConfig.load(project.path).projectMapEnabled, false);
      assert.ok(fs.existsSync(filePath), 'toggle-off must leave the file (user-owned artifact)');
    });
  });

  describe('enrichProject — surface', () => {
    it('exposes projectMapEnabled (default false, reflects post-update true)', () => {
      projects.createProject({ name: 'pm-surface', methodology: 'minimal' });
      assert.equal(projects.getProject('pm-surface').projectMapEnabled, false);

      projects.updateProject('pm-surface', { projectMapEnabled: true });
      assert.equal(projects.getProject('pm-surface').projectMapEnabled, true);
    });
  });

  // ── Slice 2 (#356): shared-dir / doc-group membership ──

  describe('_buildSharedDirsSection', () => {
    it('renders a "not a member" note for no groups', () => {
      assert.match(projects._buildSharedDirsSection([]), /not a member of any shared-doc group/);
      assert.match(projects._buildSharedDirsSection(undefined), /not a member/);
    });

    it('renders each group with its absolute sharedDir and nested registered docs', () => {
      const md = projects._buildSharedDirsSection([
        { name: 'AI Inference', sharedDir: '/abs/Monad-1', docs: [{ name: 'LITELLM' }, { name: 'TANGLEBRAIN' }] }
      ]);
      assert.ok(md.includes('- **AI Inference** → `/abs/Monad-1`'));
      assert.ok(md.includes('  - `LITELLM`'));
      assert.ok(md.includes('  - `TANGLEBRAIN`'));
    });

    it('notes a group with no sharedDir and a group with no docs', () => {
      const md = projects._buildSharedDirsSection([
        { name: 'NoDir', sharedDir: null, docs: [] }
      ]);
      assert.ok(md.includes('- **NoDir** → _(no shared directory)_'));
      assert.ok(md.includes('  - _(no docs registered)_'));
    });
  });

  describe('_collectProjectGroups', () => {
    it('maps store group membership into the section shape', () => {
      const fakeStore = {
        projectGroups: { getByProject: () => [{ id: 'g1', name: 'G1', sharedDir: '/x' }] },
        sharedDocs: { getByGroup: () => [{ name: 'DocA' }, { name: 'DocB' }] }
      };
      assert.deepEqual(projects._collectProjectGroups(42, { store: fakeStore }), [
        { name: 'G1', sharedDir: '/x', docs: [{ name: 'DocA' }, { name: 'DocB' }] }
      ]);
    });

    it('returns [] (non-throwing) when the store throws', () => {
      const throwingStore = { projectGroups: { getByProject() { throw new Error('boom'); } } };
      assert.deepEqual(projects._collectProjectGroups(1, { store: throwingStore }), []);
    });
  });

  describe('_buildProjectMapContent with membership', () => {
    it('embeds the shared-dirs membership into the section', () => {
      const p = path.join(tmpDir, 'content-with-groups');
      fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
      const content = projects._buildProjectMapContent(p, [
        { name: 'GroupX', sharedDir: '/shared/x', docs: [{ name: 'DOC' }] }
      ]);
      assert.ok(content.includes('## Shared directories / doc groups'));
      assert.ok(content.includes('- **GroupX** → `/shared/x`'));
      assert.ok(content.includes('  - `DOC`'));
    });
  });

  describe('updateProject — seeds PROJECT-MAP.md with real group membership', () => {
    it('writes the project\'s shared-doc group membership on toggle-on', () => {
      const group = store.projectGroups.create({ name: 'PM Membership Group', sharedDir: '/abs/pm-shared' });
      const project = projects.createProject({ name: 'pm-with-membership', methodology: 'minimal' }).project;
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({ groupId: group.id, name: 'NETWORK', filePath: '/abs/pm-shared/NETWORK.md' });

      projects.updateProject('pm-with-membership', { projectMapEnabled: true });

      const content = fs.readFileSync(path.join(project.path, projects.PROJECT_MAP_FILENAME), 'utf8');
      assert.ok(content.includes('- **PM Membership Group** → `/abs/pm-shared`'), 'group + sharedDir present');
      assert.ok(content.includes('  - `NETWORK`'), 'registered doc present');
    });
  });
});
