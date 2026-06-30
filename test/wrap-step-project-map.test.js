'use strict';

// Tests for the `project-map` wrap step (PIDX slice 3, #360, #356).
// Covers: gate semantics (no path, toggle off, file missing), the no-drift
// skip, the happy-path staged-refresh shape, and the commit body line emitted
// from `lib/wrap-steps/commit.js`.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const projects = require('../lib/projects');
const projectMap = require('../lib/wrap-steps/project-map');
const commitStep = require('../lib/wrap-steps/commit');

const MAP = projects.PROJECT_MAP_FILENAME;

describe('wrap-step project-map (PIDX slice 3, #360, #356)', () => {
  let tmpDir;
  let projectPath;
  let project;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-project-map-'));
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);

    projectPath = path.join(projectsDir, 'project-map-test');
    fs.mkdirSync(path.join(projectPath, 'lib'), { recursive: true });
    project = store.projects.create({
      name: 'project-map-test',
      path: projectPath,
      engine: 'claude',
      methodology: 'minimal'
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset to toggle-off, no map file, only `lib/` on disk.
    store.projectConfig.save(projectPath, {
      engine: 'claude',
      methodology: 'minimal',
      projectMapEnabled: false
    });
    try { fs.rmSync(path.join(projectPath, MAP), { force: true }); } catch {}
    try { fs.rmSync(path.join(projectPath, 'data'), { recursive: true, force: true }); } catch {}
  });

  function enableToggle() {
    store.projectConfig.save(projectPath, {
      engine: 'claude',
      methodology: 'minimal',
      projectMapEnabled: true
    });
  }

  describe('skip semantics (never blocks)', () => {
    it('skips when project path is missing', async () => {
      const r = await projectMap.run({ project: null, staged: {} });
      assert.equal(r.ok, true);
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no project path/i);
    });

    it('skips when projectMapEnabled is not true', async () => {
      const r = await projectMap.run({ project, staged: {} });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /projectMapEnabled/i);
    });

    it('skips with no drift when the map is already current', async () => {
      enableToggle();
      fs.writeFileSync(path.join(projectPath, MAP), projects._buildProjectMapContent(projectPath));
      const staged = {};
      const r = await projectMap.run({ project, staged });
      assert.equal(r.status, 'skipped');
      assert.match(r.output.reason, /no drift/i);
      assert.deepEqual(staged, {}, 'nothing staged on a no-drift run');
    });
  });

  describe('happy path — drift detected → staged refresh', () => {
    it('stages the refreshed content with the documented shape and adds the new dir', async () => {
      enableToggle();
      // Seed the map while only `lib/` exists, then add `data/` on disk.
      fs.writeFileSync(path.join(projectPath, MAP), projects._buildProjectMapContent(projectPath));
      fs.mkdirSync(path.join(projectPath, 'data'), { recursive: true });

      const staged = {};
      const r = await projectMap.run({ project, staged });

      assert.equal(r.ok, true);
      assert.equal(r.status, 'done');
      assert.deepEqual(r.output.addedDirs, ['data']);
      assert.deepEqual(r.output.removedDirs, []);

      const entry = staged['project-map:refresh'];
      assert.ok(entry, 'staged key must be set');
      assert.equal(entry.primingPath, path.join(projectPath, MAP));
      assert.equal(entry.changed, true);
      assert.equal(entry.mapRefresh, true);
      assert.deepEqual(entry.addedDirs, ['data']);
      assert.ok(entry.newContent.includes('- `data/` — <!-- describe -->'), 'new dir in content');
      // The file itself is NOT written by this step — only staged.
      assert.ok(!fs.readFileSync(path.join(projectPath, MAP), 'utf8').includes('data/'),
        'on-disk file is untouched until the commit flush');
    });

    it('preserves a curated description while refreshing', async () => {
      enableToggle();
      const curated = '# Project Map\n\n## Structure\n\n- `lib/` — the core library\n\n## Shared directories / doc groups\n\n<!-- This project is not a member of any shared-doc group. -->\n';
      fs.writeFileSync(path.join(projectPath, MAP), curated);
      fs.mkdirSync(path.join(projectPath, 'data'), { recursive: true });

      const staged = {};
      await projectMap.run({ project, staged });
      const out = staged['project-map:refresh'].newContent;
      assert.ok(out.includes('- `lib/` — the core library'), 'curated description survives');
      assert.ok(out.includes('- `data/` — <!-- describe -->'), 'new dir added');
    });

    it('self-heals — creates the index when the toggle is on but the file is missing (#423)', async () => {
      enableToggle();
      fs.mkdirSync(path.join(projectPath, 'data'), { recursive: true }); // lib/ already exists
      assert.equal(fs.existsSync(path.join(projectPath, MAP)), false, 'precondition: no map file');

      const staged = {};
      const r = await projectMap.run({ project, staged });

      assert.equal(r.status, 'done');
      assert.equal(r.output.created, true);
      assert.deepEqual([...r.output.addedDirs].sort(), ['data', 'lib']);

      const entry = staged['project-map:refresh'];
      assert.ok(entry, 'staged key set');
      assert.equal(entry.created, true);
      assert.equal(entry.mapRefresh, true);
      assert.ok(entry.newContent.includes('## Structure'), 'created content has a Structure section');
      assert.ok(entry.newContent.includes('- `lib/` — <!-- describe -->'));
      assert.ok(entry.newContent.includes('- `data/` — <!-- describe -->'));
      // The step only stages — the commit flush writes the file.
      assert.equal(fs.existsSync(path.join(projectPath, MAP)), false, 'file not written until commit flush');
    });
  });

  describe('commit body line (lib/wrap-steps/commit.js)', () => {
    it('emits a "+A/-R dir(s)" line for a dir-count change', () => {
      const lines = commitStep._buildBodyLines({
        'project-map:refresh': {
          primingPath: '/x/PROJECT-MAP.md', newContent: 'x', changed: true,
          mapRefresh: true, addedDirs: ['data'], removedDirs: []
        }
      });
      assert.ok(lines.some((l) => l === '- Project Map: refreshed (+1/-0 dir(s))'), lines.join('|'));
    });

    it('emits the membership/descriptions line when no dirs changed', () => {
      const lines = commitStep._buildBodyLines({
        'project-map:refresh': {
          primingPath: '/x/PROJECT-MAP.md', newContent: 'x', changed: true,
          mapRefresh: true, addedDirs: [], removedDirs: []
        }
      });
      assert.ok(lines.some((l) => l === '- Project Map: membership/descriptions refreshed'), lines.join('|'));
    });

    it('emits a "created" line for a self-heal create (#423)', () => {
      const lines = commitStep._buildBodyLines({
        'project-map:refresh': {
          primingPath: '/x/PROJECT-MAP.md', newContent: 'x', changed: true,
          mapRefresh: true, created: true, addedDirs: ['lib', 'data'], removedDirs: []
        }
      });
      assert.ok(lines.some((l) => l === '- Project Map: created (2 dir(s))'), lines.join('|'));
    });
  });
});
