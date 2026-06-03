'use strict';

// Tests for the Feature Index per-project toggle + template seeding (#207, chunk 1).
// Covers: DEFAULT_PROJECT_CONFIG default, _seedFeatureIndexFile idempotence,
// updateProject validation + persistence, enrichProject surface.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');

describe('feature-index (#207, chunk 1)', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-feature-index-'));
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
    it('defaults featureIndexEnabled to false', () => {
      const projectPath = path.join(projectsDir, 'default-config-proj');
      fs.mkdirSync(projectPath, { recursive: true });
      const config = store.projectConfig.load(projectPath);
      assert.equal(config.featureIndexEnabled, false);
    });
  });

  describe('_seedFeatureIndexFile helper', () => {
    it('creates FEATURES.md with the template when absent', () => {
      const projectPath = path.join(tmpDir, 'seed-create');
      fs.mkdirSync(projectPath, { recursive: true });

      const created = projects._seedFeatureIndexFile(projectPath);
      assert.equal(created, true);

      const filePath = path.join(projectPath, 'FEATURES.md');
      assert.ok(fs.existsSync(filePath), 'FEATURES.md should be created');

      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(content, projects.FEATURE_INDEX_TEMPLATE);
      assert.ok(content.includes('# Feature Index'));
      assert.ok(content.includes('## UI / Web'));
      assert.ok(content.includes('## Server / API'));
    });

    it('is idempotent — never overwrites an existing FEATURES.md', () => {
      const projectPath = path.join(tmpDir, 'seed-idempotent');
      fs.mkdirSync(projectPath, { recursive: true });

      const filePath = path.join(projectPath, 'FEATURES.md');
      const handAuthored = '# Hand-written\n\n- existing entry — keep me\n';
      fs.writeFileSync(filePath, handAuthored);

      const created = projects._seedFeatureIndexFile(projectPath);
      assert.equal(created, false, 'should not report creation when file pre-exists');

      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(content, handAuthored, 'pre-existing content must be preserved verbatim');
    });

    it('returns false (non-throwing) on write error', () => {
      // Non-existent parent directory — writeFileSync will throw, helper catches.
      const bogusPath = path.join(tmpDir, 'does', 'not', 'exist');
      const created = projects._seedFeatureIndexFile(bogusPath);
      assert.equal(created, false);
    });
  });

  describe('updateProject — featureIndexEnabled validation', () => {
    it('rejects non-boolean values without mutating state', () => {
      const result = projects.createProject({
        name: 'validation-proj',
        methodology: 'minimal'
      });
      assert.ok(result.project, 'project should be created');

      const before = store.projectConfig.load(result.project.path).featureIndexEnabled;

      const badValues = ['true', 1, null, {}, []];
      for (const bad of badValues) {
        const update = projects.updateProject('validation-proj', { featureIndexEnabled: bad });
        assert.equal(update.project, null, `should reject ${JSON.stringify(bad)}`);
        assert.ok(
          update.errors[0].includes('featureIndexEnabled'),
          `error should mention field for ${JSON.stringify(bad)}`
        );
      }

      // State unchanged after all rejections
      const after = store.projectConfig.load(result.project.path).featureIndexEnabled;
      assert.equal(after, before);
    });

    it('accepts true and persists to project.json', () => {
      projects.createProject({ name: 'accept-true-proj', methodology: 'minimal' });

      const update = projects.updateProject('accept-true-proj', { featureIndexEnabled: true });
      assert.ok(update.project);
      assert.equal(update.errors.length, 0);

      const projectPath = update.project.path;
      const config = store.projectConfig.load(projectPath);
      assert.equal(config.featureIndexEnabled, true);
    });

    it('accepts false and persists', () => {
      projects.createProject({ name: 'accept-false-proj', methodology: 'minimal' });

      // First flip to true so the false case is a real transition.
      projects.updateProject('accept-false-proj', { featureIndexEnabled: true });

      const update = projects.updateProject('accept-false-proj', { featureIndexEnabled: false });
      assert.ok(update.project);
      assert.equal(update.errors.length, 0);

      const config = store.projectConfig.load(update.project.path);
      assert.equal(config.featureIndexEnabled, false);
    });
  });

  describe('updateProject — versionBumpEnabled opt-out (#318)', () => {
    it('rejects non-boolean values', () => {
      projects.createProject({ name: 'vb-validation', methodology: 'minimal' });
      for (const bad of ['true', 1, null, {}, []]) {
        const update = projects.updateProject('vb-validation', { versionBumpEnabled: bad });
        assert.equal(update.project, null, `should reject ${JSON.stringify(bad)}`);
        assert.ok(update.errors[0].includes('versionBumpEnabled'));
      }
    });

    it('defaults to true and persists an explicit false', () => {
      projects.createProject({ name: 'vb-persist', methodology: 'minimal' });
      // Default: getProject reports true when unset.
      assert.equal(projects.getProject('vb-persist').versionBumpEnabled, true);

      const update = projects.updateProject('vb-persist', { versionBumpEnabled: false });
      assert.ok(update.project);
      assert.equal(update.errors.length, 0);
      assert.equal(store.projectConfig.load(update.project.path).versionBumpEnabled, false);
      // And getProject reflects the disabled state.
      assert.equal(projects.getProject('vb-persist').versionBumpEnabled, false);
    });
  });

  describe('updateProject — seeding behavior on toggle', () => {
    it('seeds FEATURES.md on false → true transition when file absent', () => {
      const created = projects.createProject({
        name: 'seed-on-toggle',
        methodology: 'minimal'
      });
      const featuresPath = path.join(created.project.path, 'FEATURES.md');
      assert.equal(fs.existsSync(featuresPath), false, 'precondition: FEATURES.md absent');

      projects.updateProject('seed-on-toggle', { featureIndexEnabled: true });

      assert.ok(fs.existsSync(featuresPath), 'FEATURES.md should be seeded');
      const content = fs.readFileSync(featuresPath, 'utf8');
      assert.equal(content, projects.FEATURE_INDEX_TEMPLATE);
    });

    it('does NOT overwrite a pre-existing FEATURES.md on toggle-on', () => {
      const created = projects.createProject({
        name: 'preserve-existing',
        methodology: 'minimal'
      });
      const featuresPath = path.join(created.project.path, 'FEATURES.md');
      const userContent = '# My own index\n\n- entry I wrote myself\n';
      fs.writeFileSync(featuresPath, userContent);

      projects.updateProject('preserve-existing', { featureIndexEnabled: true });

      assert.equal(fs.readFileSync(featuresPath, 'utf8'), userContent);
    });

    it('does NOT delete FEATURES.md on toggle-off', () => {
      const created = projects.createProject({
        name: 'no-delete-on-off',
        methodology: 'minimal'
      });
      const featuresPath = path.join(created.project.path, 'FEATURES.md');

      // Toggle on → seed file
      projects.updateProject('no-delete-on-off', { featureIndexEnabled: true });
      assert.ok(fs.existsSync(featuresPath));

      // Toggle off → file must remain (user owns it; git-tracked artifact)
      projects.updateProject('no-delete-on-off', { featureIndexEnabled: false });
      assert.ok(fs.existsSync(featuresPath), 'FEATURES.md must survive toggle-off');
    });

    it('does not re-seed (overwrite) on idempotent true → true save', () => {
      const created = projects.createProject({
        name: 'idempotent-true',
        methodology: 'minimal'
      });
      const featuresPath = path.join(created.project.path, 'FEATURES.md');

      projects.updateProject('idempotent-true', { featureIndexEnabled: true });
      // User edits the file
      const edited = '# Feature Index\n\n## UI / Web\n- **Foo** — does foo. `lib/foo.js:1`.\n';
      fs.writeFileSync(featuresPath, edited);

      // Re-save with toggle still true
      projects.updateProject('idempotent-true', { featureIndexEnabled: true });

      assert.equal(fs.readFileSync(featuresPath, 'utf8'), edited, 'user edits must survive a true→true save');
    });
  });

  describe('enrichProject — surface', () => {
    it('exposes featureIndexEnabled (default false)', () => {
      projects.createProject({ name: 'enrich-default', methodology: 'minimal' });
      const enriched = projects.getProject('enrich-default');
      assert.equal(enriched.featureIndexEnabled, false);
    });

    it('reflects post-update true', () => {
      projects.createProject({ name: 'enrich-true', methodology: 'minimal' });
      projects.updateProject('enrich-true', { featureIndexEnabled: true });
      const enriched = projects.getProject('enrich-true');
      assert.equal(enriched.featureIndexEnabled, true);
    });
  });

  describe('independence from other PATCH fields', () => {
    it('a featureIndexEnabled update alongside tags persists both', () => {
      projects.createProject({ name: 'combo-update', methodology: 'minimal' });

      const update = projects.updateProject('combo-update', {
        featureIndexEnabled: true,
        tags: ['active', 'experiment']
      });
      assert.ok(update.project);
      assert.equal(update.errors.length, 0);

      const config = store.projectConfig.load(update.project.path);
      assert.equal(config.featureIndexEnabled, true);

      const enriched = projects.getProject('combo-update');
      assert.deepEqual(enriched.tags, ['active', 'experiment']);
      assert.equal(enriched.featureIndexEnabled, true);
    });

    it('a non-boolean featureIndexEnabled rejection does not mutate tags', () => {
      const created = projects.createProject({
        name: 'rejection-isolation',
        methodology: 'minimal',
        tags: ['original']
      });
      assert.deepEqual(created.project.tags, ['original']);

      const update = projects.updateProject('rejection-isolation', {
        featureIndexEnabled: 'oops',
        tags: ['new-tag']
      });
      assert.equal(update.project, null);

      // Tags must remain unchanged because pre-mutation validation rejected before any write.
      const enriched = projects.getProject('rejection-isolation');
      assert.deepEqual(enriched.tags, ['original']);
    });
  });
});
