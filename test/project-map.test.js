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
      const result = projects.createProject({ name });
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
      projects.createProject({ name: 'pm-surface' });
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
      const project = projects.createProject({ name: 'pm-with-membership' }).project;
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({ groupId: group.id, name: 'NETWORK', filePath: '/abs/pm-shared/NETWORK.md' });

      projects.updateProject('pm-with-membership', { projectMapEnabled: true });

      const content = fs.readFileSync(path.join(project.path, projects.PROJECT_MAP_FILENAME), 'utf8');
      assert.ok(content.includes('- **PM Membership Group** → `/abs/pm-shared`'), 'group + sharedDir present');
      assert.ok(content.includes('  - `NETWORK`'), 'registered doc present');
    });
  });

  // ── Slice 3 (#360, #356): freshness refresh helpers ──

  describe('_parseStructureDirs', () => {
    it('extracts the dir names listed in the Structure section', () => {
      const p = path.join(tmpDir, 'parse-structure');
      fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(p, 'data'), { recursive: true });
      const content = projects._buildProjectMapContent(p);
      assert.deepEqual(projects._parseStructureDirs(content), ['data', 'lib']);
    });

    it('preserves dirs even when a description was curated onto the bullet', () => {
      const content = '# Project Map\n\n## Structure\n\n- `lib/` — core library\n- `test/` — <!-- describe -->\n\n## Shared directories / doc groups\n\n<!-- x -->\n';
      assert.deepEqual(projects._parseStructureDirs(content), ['lib', 'test']);
    });

    it('returns [] when the Structure section is absent', () => {
      assert.deepEqual(projects._parseStructureDirs('# Project Map\n\nno structure here\n'), []);
    });
  });

  describe('_mergeStructureBody', () => {
    const seeded = '# Project Map\n\n## Structure\n\n- `lib/` — core library\n- `old/` — going away\n\n## Shared directories / doc groups\n\n<!-- x -->\n';

    it('preserves the curated description on a surviving dir', () => {
      const body = projects._mergeStructureBody(seeded, ['lib']);
      assert.equal(body, '- `lib/` — core library');
    });

    it('adds a describe-stub for a new dir and drops a removed dir, in currentDirs order', () => {
      const body = projects._mergeStructureBody(seeded, ['lib', 'new']);
      assert.equal(body, '- `lib/` — core library\n- `new/` — <!-- describe -->');
      assert.ok(!body.includes('old/'), 'removed dir is dropped');
    });

    it('emits the no-dirs placeholder when currentDirs is empty', () => {
      assert.equal(projects._mergeStructureBody(seeded, []), '<!-- no top-level directories detected -->');
    });
  });

  describe('_replaceSectionBody', () => {
    const doc = '# H\n\n## Structure\n\n- `a/` — x\n\n## Shared directories / doc groups\n\n<!-- y -->\n';

    it('replaces only the targeted section body, leaving sibling sections intact', () => {
      const out = projects._replaceSectionBody(doc, '## Structure', '- `b/` — z');
      assert.ok(out.includes('## Structure\n\n- `b/` — z\n'));
      assert.ok(!out.includes('- `a/` — x'), 'old body gone');
      assert.ok(out.includes('## Shared directories / doc groups\n\n<!-- y -->'), 'sibling section untouched');
    });

    it('returns content unchanged when the heading is absent', () => {
      assert.equal(projects._replaceSectionBody(doc, '## Nonexistent', 'whatever'), doc);
    });

    it('replaces a trailing (EOF) section body and keeps a single final newline', () => {
      const out = projects._replaceSectionBody(doc, '## Shared directories / doc groups', '<!-- new -->');
      assert.ok(out.endsWith('## Shared directories / doc groups\n\n<!-- new -->\n'));
    });
  });

  describe('_refreshProjectMapContent', () => {
    it('is byte-for-byte idempotent on freshly-seeded content (no drift)', () => {
      const p = path.join(tmpDir, 'refresh-idempotent');
      fs.mkdirSync(path.join(p, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(p, 'data'), { recursive: true });
      const groups = [{ name: 'G', sharedDir: '/s', docs: [{ name: 'D' }] }];
      const seed = projects._buildProjectMapContent(p, groups);
      const refreshed = projects._refreshProjectMapContent(seed, projects._listTopLevelDirs(p), groups);
      assert.equal(refreshed, seed, 'refresh of fresh content must equal the seed exactly');
    });

    it('adds new dirs, drops removed dirs, and preserves curated descriptions', () => {
      const seed = '# Project Map\n\n## Structure\n\n- `lib/` — the library\n- `gone/` — <!-- describe -->\n\n## Shared directories / doc groups\n\n<!-- This project is not a member of any shared-doc group. -->\n';
      const out = projects._refreshProjectMapContent(seed, ['lib', 'new'], []);
      assert.ok(out.includes('- `lib/` — the library'), 'curated description preserved');
      assert.ok(out.includes('- `new/` — <!-- describe -->'), 'new dir stubbed');
      assert.ok(!out.includes('gone/'), 'removed dir dropped');
    });

    it('refreshes the shared-dir snapshot from current membership', () => {
      const seed = '# Project Map\n\n## Structure\n\n- `lib/` — <!-- describe -->\n\n## Shared directories / doc groups\n\n<!-- This project is not a member of any shared-doc group. -->\n';
      const out = projects._refreshProjectMapContent(seed, ['lib'], [
        { name: 'Backend', sharedDir: '/abs/be', docs: [{ name: 'NET' }] }
      ]);
      assert.ok(out.includes('- **Backend** → `/abs/be`'), 'new membership rendered');
      assert.ok(out.includes('  - `NET`'), 'registered doc rendered');
      assert.ok(!out.includes('not a member'), 'placeholder replaced');
    });

    it('preserves the header comment and any operator-added section verbatim', () => {
      const seed = '# Project Map\n\n<!-- my notes -->\n\n## Structure\n\n- `lib/` — <!-- describe -->\n\n## Shared directories / doc groups\n\n<!-- x -->\n\n## Operator Notes\n\nkeep this\n';
      const out = projects._refreshProjectMapContent(seed, ['lib', 'data'], []);
      assert.ok(out.includes('<!-- my notes -->'), 'header comment preserved');
      assert.ok(out.includes('## Operator Notes\n\nkeep this'), 'operator section preserved');
      assert.ok(out.includes('- `data/` — <!-- describe -->'), 'new dir added to Structure');
    });
  });
});
