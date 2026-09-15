'use strict';

// `releaseMode` resolution (#1492 L4). Migration is on read: a project's file
// is never rewritten to move it from `versionBumpEnabled` to `releaseMode`, so
// the resolver is the whole migration and is tested through the real reader.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectConfig = require('../lib/project-config');

describe('resolveReleaseMode', () => {
  it('honours every explicit valid mode', () => {
    for (const mode of ['off', 'auto', 'ask']) {
      assert.deepEqual(projectConfig.resolveReleaseMode({ releaseMode: mode }), { mode, source: 'releaseMode' });
    }
  });

  it('lets an explicit mode beat the legacy flag in both directions', () => {
    assert.equal(projectConfig.resolveReleaseMode({ releaseMode: 'auto', versionBumpEnabled: false }).mode, 'auto');
    assert.equal(projectConfig.resolveReleaseMode({ releaseMode: 'off', versionBumpEnabled: true }).mode, 'off');
  });

  it('derives off from a legacy versionBumpEnabled:false, and auto otherwise', () => {
    assert.deepEqual(projectConfig.resolveReleaseMode({ versionBumpEnabled: false }), { mode: 'off', source: 'versionBumpEnabled' });
    assert.deepEqual(projectConfig.resolveReleaseMode({ versionBumpEnabled: true }), { mode: 'auto', source: 'default' });
    assert.deepEqual(projectConfig.resolveReleaseMode({}), { mode: 'auto', source: 'default' });
    assert.deepEqual(projectConfig.resolveReleaseMode(null), { mode: 'auto', source: 'default' });
  });

  it('reads an unrecognized explicit value as ask, with a warning', () => {
    for (const bad of ['Auto', '', 'always', true, 0]) {
      const r = projectConfig.resolveReleaseMode({ releaseMode: bad, versionBumpEnabled: true });
      assert.equal(r.mode, 'ask', `value ${JSON.stringify(bad)}`);
      assert.equal(r.source, 'invalid');
      assert.match(r.warning, /treating it as ask/);
    }
  });

  it('ships releaseMode null, so the default cannot mask a legacy opt-out', () => {
    assert.equal(projectConfig.DEFAULT_PROJECT_CONFIG.releaseMode, null);
  });
});

describe('resolveReleaseMode through the config reader', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-mode-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const write = (obj) => {
    fs.mkdirSync(path.join(root, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tangleclaw', 'project.json'), JSON.stringify(obj));
  };

  it('keeps a legacy opt-out off after the defaults merge', () => {
    write({ versionBumpEnabled: false });
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'off');
  });

  it('reads a project with no config file as auto', () => {
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'auto');
  });

  it('reads an explicit releaseMode from disk', () => {
    write({ releaseMode: 'ask', versionBumpEnabled: true });
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'ask');
  });
});

describe('nextReleaseMode', () => {
  it('takes an explicit releaseMode as sent', () => {
    assert.equal(projectConfig.nextReleaseMode('auto', { releaseMode: 'ask' }), 'ask');
    assert.equal(projectConfig.nextReleaseMode('off', { releaseMode: 'auto' }), 'auto');
  });

  it('reads the legacy boolean without undoing ask', () => {
    assert.equal(projectConfig.nextReleaseMode('ask', { versionBumpEnabled: false }), 'off');
    assert.equal(projectConfig.nextReleaseMode('off', { versionBumpEnabled: true }), 'auto');
    assert.equal(projectConfig.nextReleaseMode('ask', { versionBumpEnabled: true }), 'ask');
    assert.equal(projectConfig.nextReleaseMode('auto', { versionBumpEnabled: true }), 'auto');
    assert.equal(projectConfig.nextReleaseMode('ask', {}), 'ask');
  });
});

describe('updateProject — releaseMode (#1492)', () => {
  const store = require('../lib/store');
  const projects = require('../lib/projects');
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-mode-api-'));
    const projectsDir = path.join(tmpDir, 'projects');
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

  it('reports auto for a new project, and releaseMode beside the legacy shadow', async () => {
    projects.createProject({ name: 'rm-default' });
    const p = await projects.getProject('rm-default');
    assert.equal(p.releaseMode, 'auto');
    assert.equal(p.versionBumpEnabled, true);
  });

  it('persists each mode, keeping the legacy key in step for an older reader', async () => {
    projects.createProject({ name: 'rm-persist' });
    for (const [mode, legacy] of [['ask', false], ['off', false], ['auto', true]]) {
      const update = await projects.updateProject('rm-persist', { releaseMode: mode });
      assert.deepEqual(update.errors, []);
      const onDisk = JSON.parse(fs.readFileSync(path.join(update.project.path, '.tangleclaw', 'project.json'), 'utf8'));
      assert.equal(onDisk.releaseMode, mode);
      assert.equal(onDisk.versionBumpEnabled, legacy, `legacy shadow for ${mode}`);
      const p = await projects.getProject('rm-persist');
      assert.equal(p.releaseMode, mode);
      assert.equal(p.versionBumpEnabled, mode !== 'off');
    }
  });

  it('keeps ask when the settings modal saves its checkbox as true', async () => {
    projects.createProject({ name: 'rm-modal' });
    await projects.updateProject('rm-modal', { releaseMode: 'ask' });
    const update = await projects.updateProject('rm-modal', { versionBumpEnabled: true, tags: ['x'] });
    assert.deepEqual(update.errors, []);
    assert.equal((await projects.getProject('rm-modal')).releaseMode, 'ask');
  });

  it('turns a legacy opt-out back on as auto', async () => {
    projects.createProject({ name: 'rm-legacy' });
    await projects.updateProject('rm-legacy', { versionBumpEnabled: false });
    assert.equal((await projects.getProject('rm-legacy')).releaseMode, 'off');
    await projects.updateProject('rm-legacy', { versionBumpEnabled: true });
    assert.equal((await projects.getProject('rm-legacy')).releaseMode, 'auto');
  });

  it('refuses an unknown mode and a contradictory pair, writing nothing', async () => {
    projects.createProject({ name: 'rm-refuse' });
    await projects.updateProject('rm-refuse', { releaseMode: 'ask' });
    const cases = [
      [{ releaseMode: 'Auto' }, /releaseMode must be one of off, auto, ask/],
      [{ releaseMode: null }, /releaseMode must be one of/],
      [{ releaseMode: 'off', versionBumpEnabled: true }, /contradicts/],
      [{ releaseMode: 'auto', versionBumpEnabled: false }, /contradicts/],
      [{ releaseMode: 'ask', tags: ['a'], versionBumpEnabled: 'yes' }, /versionBumpEnabled must be a boolean/]
    ];
    for (const [body, pattern] of cases) {
      const update = await projects.updateProject('rm-refuse', body);
      assert.equal(update.project, null, JSON.stringify(body));
      assert.match(update.errors[0], pattern);
    }
    assert.equal((await projects.getProject('rm-refuse')).releaseMode, 'ask');
  });

  it('accepts a consistent pair', async () => {
    projects.createProject({ name: 'rm-pair' });
    const update = await projects.updateProject('rm-pair', { releaseMode: 'ask', versionBumpEnabled: true });
    assert.deepEqual(update.errors, []);
    assert.equal((await projects.getProject('rm-pair')).releaseMode, 'ask');
  });
});
