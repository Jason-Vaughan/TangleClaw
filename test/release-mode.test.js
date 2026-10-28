'use strict';

// `releaseMode` resolution (#1492 L4, renamed auto/ask -> agent/operator by
// #1701). Migration is on read: a project's file is never rewritten to move
// it from `versionBumpEnabled` to `releaseMode`, nor from the legacy
// `auto`/`ask` spellings to `agent`/`operator` — the resolver is the whole
// migration in both cases, and is tested through the real reader.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectConfig = require('../lib/project-config');

describe('resolveReleaseMode', () => {
  it('honours every explicit valid mode', () => {
    for (const mode of ['off', 'agent', 'operator']) {
      assert.deepEqual(projectConfig.resolveReleaseMode({ releaseMode: mode }), { mode, source: 'releaseMode' });
    }
  });

  it('migrates the legacy auto/ask spellings permanently, on every read (#1701)', () => {
    assert.deepEqual(projectConfig.resolveReleaseMode({ releaseMode: 'auto' }), { mode: 'agent', source: 'releaseMode' });
    assert.deepEqual(projectConfig.resolveReleaseMode({ releaseMode: 'ask' }), { mode: 'operator', source: 'releaseMode' });
    // Not a one-time nudge: the same file read again still aliases the same way.
    assert.deepEqual(projectConfig.resolveReleaseMode({ releaseMode: 'auto' }), { mode: 'agent', source: 'releaseMode' });
  });

  it('exposes the alias table itself', () => {
    assert.deepEqual(projectConfig.RELEASE_MODE_ALIASES, { auto: 'agent', ask: 'operator' });
  });

  it('lets an explicit mode beat the legacy flag in both directions', () => {
    assert.equal(projectConfig.resolveReleaseMode({ releaseMode: 'agent', versionBumpEnabled: false }).mode, 'agent');
    assert.equal(projectConfig.resolveReleaseMode({ releaseMode: 'off', versionBumpEnabled: true }).mode, 'off');
  });

  it('derives off from a legacy versionBumpEnabled:false, and the cautious operator default otherwise (#1702)', () => {
    assert.deepEqual(projectConfig.resolveReleaseMode({ versionBumpEnabled: false }), { mode: 'off', source: 'versionBumpEnabled' });
    assert.deepEqual(projectConfig.resolveReleaseMode({ versionBumpEnabled: true }), { mode: 'operator', source: 'default' });
    assert.deepEqual(projectConfig.resolveReleaseMode({}), { mode: 'operator', source: 'default' });
    assert.deepEqual(projectConfig.resolveReleaseMode(null), { mode: 'operator', source: 'default' });
  });

  it('resolves the unconfigured default to off when a different project owns the group\'s release authority (#1697)', () => {
    assert.deepEqual(
      projectConfig.resolveReleaseMode({}, { groupOwnerElsewhere: true }),
      { mode: 'off', source: 'group-owner-elsewhere' }
    );
    assert.deepEqual(
      projectConfig.resolveReleaseMode(null, { groupOwnerElsewhere: true }),
      { mode: 'off', source: 'group-owner-elsewhere' }
    );
    // No context, or a false one, is the same as today's unconfigured default.
    assert.deepEqual(projectConfig.resolveReleaseMode({}, { groupOwnerElsewhere: false }), { mode: 'operator', source: 'default' });
    assert.deepEqual(projectConfig.resolveReleaseMode({}), { mode: 'operator', source: 'default' });
  });

  it('lets an explicit value or the legacy off-flag win over group-owner-elsewhere context', () => {
    // An explicit mode always wins, group context or not.
    assert.deepEqual(
      projectConfig.resolveReleaseMode({ releaseMode: 'agent' }, { groupOwnerElsewhere: true }),
      { mode: 'agent', source: 'releaseMode' }
    );
    // Already off via the legacy flag — group context changes nothing (still off, still that source).
    assert.deepEqual(
      projectConfig.resolveReleaseMode({ versionBumpEnabled: false }, { groupOwnerElsewhere: true }),
      { mode: 'off', source: 'versionBumpEnabled' }
    );
  });

  it('reads an unrecognized explicit value as operator, with a warning', () => {
    for (const bad of ['Auto', '', 'always', true, 0]) {
      const r = projectConfig.resolveReleaseMode({ releaseMode: bad, versionBumpEnabled: true });
      assert.equal(r.mode, 'operator', `value ${JSON.stringify(bad)}`);
      assert.equal(r.source, 'invalid');
      assert.match(r.warning, /treating it as operator/);
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

  it('reads a project with no config file as operator (#1702)', () => {
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'operator');
  });

  it('reads an explicit releaseMode from disk', () => {
    write({ releaseMode: 'operator', versionBumpEnabled: true });
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'operator');
  });

  it('reads a legacy on-disk auto/ask spelling as its alias, from disk (#1701)', () => {
    write({ releaseMode: 'ask', versionBumpEnabled: true });
    assert.equal(projectConfig.resolveReleaseMode(projectConfig.load(root)).mode, 'operator');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.tangleclaw', 'project.json'), 'utf8')).releaseMode, 'ask',
      'the file itself is never rewritten by the read-time migration');
  });
});

describe('nextReleaseMode', () => {
  it('takes an explicit releaseMode as sent', () => {
    assert.equal(projectConfig.nextReleaseMode('agent', { releaseMode: 'operator' }), 'operator');
    assert.equal(projectConfig.nextReleaseMode('off', { releaseMode: 'agent' }), 'agent');
  });

  it('normalizes a legacy auto/ask spelling supplied on either side (#1701)', () => {
    assert.equal(projectConfig.nextReleaseMode('auto', { releaseMode: 'ask' }), 'operator');
    assert.equal(projectConfig.nextReleaseMode('ask', { releaseMode: 'auto' }), 'agent');
    assert.equal(projectConfig.nextReleaseMode('ask', {}), 'operator', 'the current mode alone is normalized too');
    assert.equal(projectConfig.nextReleaseMode('off', { releaseMode: 'auto' }), 'agent');
  });

  it('reads the legacy boolean without undoing operator', () => {
    assert.equal(projectConfig.nextReleaseMode('operator', { versionBumpEnabled: false }), 'off');
    assert.equal(projectConfig.nextReleaseMode('off', { versionBumpEnabled: true }), 'agent');
    assert.equal(projectConfig.nextReleaseMode('operator', { versionBumpEnabled: true }), 'operator');
    assert.equal(projectConfig.nextReleaseMode('agent', { versionBumpEnabled: true }), 'agent');
    assert.equal(projectConfig.nextReleaseMode('operator', {}), 'operator');
  });
});

describe('updateProject — releaseMode (#1492, #1701)', () => {
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

  it('reports the cautious operator default for a new project, and releaseMode beside the legacy shadow (#1702)', async () => {
    projects.createProject({ name: 'rm-default' });
    const p = await projects.getProject('rm-default');
    assert.equal(p.releaseMode, 'operator');
    assert.equal(p.versionBumpEnabled, true);
  });

  it('persists each mode, keeping the legacy key in step for an older reader', async () => {
    projects.createProject({ name: 'rm-persist' });
    for (const [mode, legacy] of [['operator', false], ['off', false], ['agent', true]]) {
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

  it('accepts a legacy auto/ask spelling in a PATCH and persists the canonical mode (#1701)', async () => {
    projects.createProject({ name: 'rm-alias-patch' });
    const update = await projects.updateProject('rm-alias-patch', { releaseMode: 'ask' });
    assert.deepEqual(update.errors, []);
    const onDisk = JSON.parse(fs.readFileSync(path.join(update.project.path, '.tangleclaw', 'project.json'), 'utf8'));
    assert.equal(onDisk.releaseMode, 'operator', 'the alias is normalized before it is written, not stored verbatim');
    assert.equal((await projects.getProject('rm-alias-patch')).releaseMode, 'operator');
  });

  it('keeps operator when the settings modal saves its checkbox as true', async () => {
    projects.createProject({ name: 'rm-modal' });
    await projects.updateProject('rm-modal', { releaseMode: 'operator' });
    const update = await projects.updateProject('rm-modal', { versionBumpEnabled: true, tags: ['x'] });
    assert.deepEqual(update.errors, []);
    assert.equal((await projects.getProject('rm-modal')).releaseMode, 'operator');
  });

  it('turns a legacy opt-out back on as agent', async () => {
    projects.createProject({ name: 'rm-legacy' });
    await projects.updateProject('rm-legacy', { versionBumpEnabled: false });
    assert.equal((await projects.getProject('rm-legacy')).releaseMode, 'off');
    await projects.updateProject('rm-legacy', { versionBumpEnabled: true });
    assert.equal((await projects.getProject('rm-legacy')).releaseMode, 'agent');
  });

  it('refuses an unknown mode and a contradictory pair, writing nothing', async () => {
    projects.createProject({ name: 'rm-refuse' });
    await projects.updateProject('rm-refuse', { releaseMode: 'operator' });
    const cases = [
      [{ releaseMode: 'Auto' }, /releaseMode must be one of off, agent, operator/],
      [{ releaseMode: null }, /releaseMode must be one of/],
      [{ releaseMode: 'off', versionBumpEnabled: true }, /contradicts/],
      [{ releaseMode: 'agent', versionBumpEnabled: false }, /contradicts/],
      [{ releaseMode: 'operator', tags: ['a'], versionBumpEnabled: 'yes' }, /versionBumpEnabled must be a boolean/]
    ];
    for (const [body, pattern] of cases) {
      const update = await projects.updateProject('rm-refuse', body);
      assert.equal(update.project, null, JSON.stringify(body));
      assert.match(update.errors[0], pattern);
    }
    assert.equal((await projects.getProject('rm-refuse')).releaseMode, 'operator');
  });

  it('accepts a consistent pair', async () => {
    projects.createProject({ name: 'rm-pair' });
    const update = await projects.updateProject('rm-pair', { releaseMode: 'operator', versionBumpEnabled: true });
    assert.deepEqual(update.errors, []);
    assert.equal((await projects.getProject('rm-pair')).releaseMode, 'operator');
  });
});

describe('updateProject — group release authority (#1697)', () => {
  const store = require('../lib/store');
  const projects = require('../lib/projects');
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-release-owner-api-'));
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

  it('the first member to go release-capable auto-claims the group, silently', async () => {
    projects.createProject({ name: 'rg-a' });
    projects.createProject({ name: 'rg-b' });
    const a = await projects.getProject('rg-a');
    const b = await projects.getProject('rg-b');
    const group = store.projectGroups.create({ name: 'rg-fleet-1' });
    store.projectGroups.addMember(group.id, a.id);
    store.projectGroups.addMember(group.id, b.id);

    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, null);
    const update = await projects.updateProject('rg-a', { releaseMode: 'agent' });
    assert.deepEqual(update.errors, []);
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, a.id);
  });

  it('refuses a second member going release-capable with 409, naming the owner', async () => {
    projects.createProject({ name: 'rg-c' });
    projects.createProject({ name: 'rg-d' });
    const c = await projects.getProject('rg-c');
    const d = await projects.getProject('rg-d');
    const group = store.projectGroups.create({ name: 'rg-fleet-2' });
    store.projectGroups.addMember(group.id, c.id);
    store.projectGroups.addMember(group.id, d.id);

    await projects.updateProject('rg-c', { releaseMode: 'agent' });
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, c.id);

    for (const mode of ['agent', 'operator']) {
      const update = await projects.updateProject('rg-d', { releaseMode: mode });
      assert.equal(update.project, null);
      assert.equal(update.code, 'CONFLICT');
      assert.match(update.errors[0], /rg-c/);
      assert.match(update.errors[0], /rg-fleet-2/);
    }
    // Setting the non-owner to off is never a conflict.
    const offUpdate = await projects.updateProject('rg-d', { releaseMode: 'off' });
    assert.deepEqual(offUpdate.errors, []);
  });

  it('a transfer via the group settings unblocks the formerly-refused member', async () => {
    projects.createProject({ name: 'rg-e' });
    projects.createProject({ name: 'rg-f' });
    const e = await projects.getProject('rg-e');
    const f = await projects.getProject('rg-f');
    const group = store.projectGroups.create({ name: 'rg-fleet-3' });
    store.projectGroups.addMember(group.id, e.id);
    store.projectGroups.addMember(group.id, f.id);

    await projects.updateProject('rg-e', { releaseMode: 'agent' });
    const blocked = await projects.updateProject('rg-f', { releaseMode: 'agent' });
    assert.equal(blocked.code, 'CONFLICT');

    store.projectGroups.update(group.id, { releaseOwnerProjectId: f.id });
    const allowed = await projects.updateProject('rg-f', { releaseMode: 'agent' });
    assert.deepEqual(allowed.errors, []);
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, f.id);
  });

  it('reports group-owner-elsewhere as off for an unconfigured non-owner member (#1702)', async () => {
    projects.createProject({ name: 'rg-g' });
    projects.createProject({ name: 'rg-h' });
    const g = await projects.getProject('rg-g');
    const group = store.projectGroups.create({ name: 'rg-fleet-4' });
    store.projectGroups.addMember(group.id, g.id);
    store.projectGroups.addMember(group.id, (await projects.getProject('rg-h')).id);

    await projects.updateProject('rg-g', { releaseMode: 'agent' });
    // rg-h never configured releaseMode and sits in a group rg-g now owns.
    const h = await projects.getProject('rg-h');
    assert.equal(h.releaseMode, 'off');
  });
});
