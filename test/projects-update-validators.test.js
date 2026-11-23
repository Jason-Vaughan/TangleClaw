'use strict';

// #3196 (Car V659-W1-D): `_applyProjectUpdates`'s automatic engine-state
// migration on project rename -- `lib/projects.js` wires
// `workspace-rename-check.js#migrateEngineStateOnRename` right after
// `fs.renameSync` succeeds, folding its `warnings` into `updateProject`'s
// own return value and logging every successful migration.
//
// `migrateEngineStateOnRename`'s own logic (moving the right directory,
// collision/EACCES handling, Codex's content-keyed warning) is already
// fully covered against real `~/.claude`/`~/.codex` fixtures in
// `test/workspace-rename-check.test.js` -- this file's only job is the
// INTEGRATION seam: that `_applyProjectUpdates` actually calls it after a
// real rename and threads its result through correctly. The real call site
// takes no `claudeHome`/`codexHome` override (by design -- it reads the
// REAL `~/.claude`/`~/.codex`, same as every other engine-state reader in
// this codebase), so this file stubs `workspace-rename-check`'s own
// exported function for the duration of each test that needs a specific
// migration result, restoring it immediately after -- never touching the
// real filesystem's `~/.claude` or `~/.codex`.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const projects = require('../lib/projects');
const workspaceRenameCheck = require('../lib/workspace-rename-check');
const logger = require('../lib/logger');

describe('_applyProjectUpdates: automatic engine-state migration on rename (#3196)', () => {
  let tmpDir;
  let projectsDir;
  let originalMigrate;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rename-migrate-'));
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

  beforeEach(() => {
    originalMigrate = workspaceRenameCheck.migrateEngineStateOnRename;
  });

  afterEach(() => {
    // Restore the real implementation unconditionally, so a stub set by
    // one test can never leak into the next.
    workspaceRenameCheck.migrateEngineStateOnRename = originalMigrate;
  });

  it('calls migrateEngineStateOnRename with the exact old/new paths right after a successful rename', async () => {
    projects.createProject({ name: 'mig-called' });
    let calledWith = null;
    workspaceRenameCheck.migrateEngineStateOnRename = (oldPath, newPath) => {
      calledWith = { oldPath, newPath };
      return { migrated: [], warnings: [] };
    };
    const result = await projects.updateProject('mig-called', { name: 'mig-called-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(calledWith.oldPath, path.join(projectsDir, 'mig-called'));
    assert.equal(calledWith.newPath, path.join(projectsDir, 'mig-called-renamed'));
  });

  it('adds nothing to updateProject\'s own warnings on a clean migration with 0 warnings', async () => {
    projects.createProject({ name: 'mig-clean' });
    workspaceRenameCheck.migrateEngineStateOnRename = () => ({
      migrated: [{ engine: 'claude', from: '/old/encoded', to: '/new/encoded', status: 'migrated' }],
      warnings: []
    });
    const result = await projects.updateProject('mig-clean', { name: 'mig-clean-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.deepEqual((result.warnings || []).filter((w) => w.includes('migrat')), []);
  });

  it('surfaces a migration warning (target collision / EACCES / Codex) onto updateProject\'s own warnings, without blocking the rename', async () => {
    projects.createProject({ name: 'mig-warn' });
    const WARNING = 'Claude Code engine state at /src was not migrated: /dst already exists. Resolve manually: mv /src /dst';
    workspaceRenameCheck.migrateEngineStateOnRename = () => ({
      migrated: [{ engine: 'claude', from: '/src', to: '/dst', status: 'failed', reason: 'target directory already exists' }],
      warnings: [WARNING]
    });
    const result = await projects.updateProject('mig-warn', { name: 'mig-warn-renamed' });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.ok((result.warnings || []).includes(WARNING), JSON.stringify(result.warnings));
    // The directory rename itself already succeeded on disk -- a migration
    // warning reports that one piece did not complete, it never undoes the
    // rename or blocks the update as a whole.
    assert.equal(fs.existsSync(path.join(projectsDir, 'mig-warn-renamed')), true);
    assert.equal(fs.existsSync(path.join(projectsDir, 'mig-warn')), false);
  });

  it('logs every successful migration, keyed by the real old/new project paths', async () => {
    projects.createProject({ name: 'mig-logged' });
    const oldPath = path.join(projectsDir, 'mig-logged');
    const newPath = path.join(projectsDir, 'mig-logged-renamed');
    const migratedEntry = { engine: 'claude', from: '/a', to: '/b', status: 'migrated' };
    workspaceRenameCheck.migrateEngineStateOnRename = () => ({ migrated: [migratedEntry], warnings: [] });
    // Every module's logger funnels through this one shared stream
    // (lib/logger.js#_write); pinning it here is the one seam that lets a
    // test read what `lib/projects.js`'s OWN (unexported) `log` instance
    // actually wrote, without changing production code for testability.
    let written = '';
    logger.setConsoleStream({ write: (chunk) => { written += chunk; } });
    try {
      await projects.updateProject('mig-logged', { name: 'mig-logged-renamed' });
    } finally {
      logger.setConsoleStream(null);
    }
    const line = written.split('\n').find((l) => l.includes('Engine state directory migrated with project rename'));
    assert.ok(line, `expected a migration log line among:\n${written}`);
    assert.ok(line.includes(`from=${oldPath}`), line);
    assert.ok(line.includes(`to=${newPath}`), line);
    assert.ok(line.includes(`migrated=${JSON.stringify([migratedEntry])}`), line);
  });

  it('never calls migrateEngineStateOnRename when the update carries no rename', async () => {
    projects.createProject({ name: 'mig-no-rename' });
    let called = false;
    workspaceRenameCheck.migrateEngineStateOnRename = () => { called = true; return { migrated: [], warnings: [] }; };
    const result = await projects.updateProject('mig-no-rename', { tags: ['x'] });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(called, false);
  });
});
