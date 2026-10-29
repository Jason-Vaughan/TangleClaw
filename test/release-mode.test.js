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
const vm = require('node:vm');

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
    // #1702 made 'operator' the unconfigured default (release-capable), so
    // addMember's own auto-claim (#1697, tested separately below) would
    // otherwise fire the moment either project joins. Pin both 'off' first
    // so THIS test isolates the updateProject-triggered claim specifically.
    await projects.updateProject('rg-a', { releaseMode: 'off' });
    await projects.updateProject('rg-b', { releaseMode: 'off' });
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

  it('fails closed (409) when the group ownership lookup throws, rather than allowing the save (PRR-A B3)', async () => {
    projects.createProject({ name: 'rg-o' });
    const savedFind = store.projectGroups.findReleaseOwnerElsewhere;
    store.projectGroups.findReleaseOwnerElsewhere = () => { throw new Error('simulated DB failure'); };
    try {
      const update = await projects.updateProject('rg-o', { releaseMode: 'agent' });
      assert.equal(update.project, null);
      assert.equal(update.code, 'CONFLICT');
      assert.match(update.errors[0], /could not verify group release authority/);
    } finally {
      store.projectGroups.findReleaseOwnerElsewhere = savedFind;
    }
    // Setting to 'off' is never racy, so an unresolvable lookup must not
    // block it even though the same guard fires for agent/operator above.
    store.projectGroups.findReleaseOwnerElsewhere = () => { throw new Error('simulated DB failure'); };
    try {
      const offUpdate = await projects.updateProject('rg-o', { releaseMode: 'off' });
      assert.deepEqual(offUpdate.errors, []);
    } finally {
      store.projectGroups.findReleaseOwnerElsewhere = savedFind;
    }
  });

  it('fails closed on the write step too, not just the validator, when the lookup fails ONLY there (#2699 R-5)', async () => {
    // The validator and `_applyProjectUpdates` each call `findReleaseOwnerElsewhere`
    // (via `safeFindReleaseOwnerElsewhere`) separately. Before the fix, a failure
    // reaching only the SECOND call was swallowed into "no owner elsewhere" and the
    // write proceeded anyway — exactly the race the validator's own fail-closed
    // check exists to prevent. Let the first call (the validator's) succeed and
    // the second (the apply step's) fail, to isolate that path.
    projects.createProject({ name: 'rg-apply-fail' });
    const savedFind = store.projectGroups.findReleaseOwnerElsewhere;
    let calls = 0;
    store.projectGroups.findReleaseOwnerElsewhere = function (...args) {
      calls += 1;
      if (calls === 1) return savedFind.apply(this, args);
      throw new Error('simulated DB failure on the apply-time lookup');
    };
    try {
      const update = await projects.updateProject('rg-apply-fail', { releaseMode: 'agent' });
      assert.match(update.errors[0], /could not verify group release authority/);
      assert.equal((await projects.getProject('rg-apply-fail')).releaseMode, 'operator',
        'the write must not have landed — releaseMode stays at its unconfigured default');
    } finally {
      store.projectGroups.findReleaseOwnerElsewhere = savedFind;
    }
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

  it('addMember auto-claims for a project already configured release-capable, before any updateProject call (Critic R-1)', async () => {
    projects.createProject({ name: 'rg-i' });
    projects.createProject({ name: 'rg-j' });
    // Configure BOTH to agent before either ever joins a group — the
    // ordering #1697's own problem statement describes (an existing fleet
    // grouped together after the fact), as opposed to configuring after
    // grouping, which the earlier tests above already cover.
    await projects.updateProject('rg-i', { releaseMode: 'agent' });
    await projects.updateProject('rg-j', { releaseMode: 'agent' });
    const i = await projects.getProject('rg-i');
    const j = await projects.getProject('rg-j');
    const group = store.projectGroups.create({ name: 'rg-fleet-5' });

    store.projectGroups.addMember(group.id, i.id);
    // Claimed by the addMember call itself — no updateProject involved.
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, i.id);

    store.projectGroups.addMember(group.id, j.id);
    // Already owned by i; j's join does not overwrite it.
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, i.id);
  });

  it('removeMember clears release_owner_project_id when the departing project is the owner (Critic R-5)', async () => {
    projects.createProject({ name: 'rg-k' });
    projects.createProject({ name: 'rg-l' });
    const k = await projects.getProject('rg-k');
    const l = await projects.getProject('rg-l');
    const group = store.projectGroups.create({ name: 'rg-fleet-6' });
    store.projectGroups.addMember(group.id, k.id);
    store.projectGroups.addMember(group.id, l.id);
    await projects.updateProject('rg-k', { releaseMode: 'agent' });
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, k.id);

    store.projectGroups.removeMember(group.id, k.id);
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, null,
      'dangling owner pointing at a non-member must not persist');

    // The remaining member can now claim it — it was not permanently stuck.
    const update = await projects.updateProject('rg-l', { releaseMode: 'agent' });
    assert.deepEqual(update.errors, []);
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, l.id);
  });

  it('removeMember leaves release_owner_project_id alone when the departing project is not the owner', async () => {
    projects.createProject({ name: 'rg-m' });
    projects.createProject({ name: 'rg-n' });
    const m = await projects.getProject('rg-m');
    const n = await projects.getProject('rg-n');
    const group = store.projectGroups.create({ name: 'rg-fleet-7' });
    store.projectGroups.addMember(group.id, m.id);
    store.projectGroups.addMember(group.id, n.id);
    await projects.updateProject('rg-m', { releaseMode: 'agent' });

    store.projectGroups.removeMember(group.id, n.id);
    assert.equal(store.projectGroups.get(group.id).releaseOwnerProjectId, m.id);
  });
});

// The settings-modal and group-modal pieces of #1697, run against the real
// `public/ui.js` source (a browser script, not a module) the same way
// `test/engine-change-launch-mode-ui.test.js` does: extract one function (or
// expression) by text and execute it in a VM sandbox. Kept here rather than
// a new `test/ui-dom.test.js` file, which would also need registering in
// `test/tiers.json`/`.testament.toml` for `scripts/test-tiers.js --check`
// (both outside this chunk's file scope) — see the PR body.
describe('public/ui.js — group release-authority UI (#1697)', () => {
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  /**
   * One top-level function's source in a browser script (mirrors the helper
   * in `test/engine-change-launch-mode-ui.test.js`).
   * @param {string} decl - The declaration's opening text
   * @returns {string}
   */
  function functionSource(decl) {
    const start = uiSrc.indexOf(decl);
    assert.notEqual(start, -1, `${decl} must exist`);
    return uiSrc.slice(start, uiSrc.indexOf('\n}\n', start) + 2);
  }

  describe('releaseOwnerGroup — the settings-modal hint (R-3)', () => {
    /**
     * Evaluate the shipped `releaseOwnerGroup` expression against a project.
     * @param {object} project
     * @returns {object|undefined}
     */
    function releaseOwnerGroupFor(project) {
      const marker = 'const releaseOwnerGroup = ';
      const start = uiSrc.indexOf(marker);
      assert.notEqual(start, -1, 'the releaseOwnerGroup computation must exist');
      const end = uiSrc.indexOf(';\n', start);
      const expr = uiSrc.slice(start + marker.length, end);
      const ctx = { project };
      vm.createContext(ctx);
      return vm.runInContext(expr, ctx);
    }

    it('picks a group owned by a DIFFERENT project over one this project owns itself', () => {
      const project = {
        id: 1,
        groups: [
          { id: 'self-owned', name: 'self', releaseOwnerProjectId: 1 },
          { id: 'elsewhere', name: 'conflict', releaseOwnerProjectId: 2, releaseOwnerName: 'Other' }
        ]
      };
      assert.equal(releaseOwnerGroupFor(project).id, 'elsewhere');
    });

    it('falls back to a self-owned group when nothing else conflicts', () => {
      const project = { id: 1, groups: [{ id: 'self-owned', name: 'self', releaseOwnerProjectId: 1 }] };
      assert.equal(releaseOwnerGroupFor(project).id, 'self-owned');
    });

    it('is undefined when no group has any owner', () => {
      const project = { id: 1, groups: [{ id: 'vacant', name: 'v', releaseOwnerProjectId: null }] };
      assert.equal(releaseOwnerGroupFor(project), undefined);
    });
  });

  describe('toggleGroupMembership — the group-modal staleness guard (R-6)', () => {
    /**
     * Run the real `toggleGroupMembership` against mocked API/render globals.
     * @param {object} opts
     * @param {string|null} opts.groupEditIdValue - What the modal is showing when the toggle starts
     * @param {string} opts.groupId - The group this toggle is for
     * @param {object} opts.fetchedData - What the refetch after the mutation returns
     * @returns {Promise<{renderCalls: Array}>}
     */
    async function run({ groupEditIdValue, groupId, fetchedData }) {
      const renderCalls = [];
      const ctx = {
        groupEditId: groupEditIdValue,
        apiMutate: async () => ({}),
        api: async () => fetchedData,
        renderGroupReleaseOwner: (members, owner) => renderCalls.push({ members, owner })
      };
      vm.createContext(ctx);
      vm.runInContext(functionSource('async function toggleGroupMembership('), ctx);
      await ctx.toggleGroupMembership(groupId, 42, true);
      return { renderCalls };
    }

    it('renders the refreshed owner when the modal is still showing the same group', async () => {
      const { renderCalls } = await run({
        groupEditIdValue: 'g1', groupId: 'g1', fetchedData: { members: [1], releaseOwnerProjectId: 1 }
      });
      assert.equal(renderCalls.length, 1);
      assert.deepEqual(renderCalls[0], { members: [1], owner: 1 });
    });

    it('does not render when the modal switched to a different group while the request was in flight', async () => {
      const { renderCalls } = await run({
        groupEditIdValue: 'g2', groupId: 'g1', fetchedData: { members: [1], releaseOwnerProjectId: 1 }
      });
      assert.equal(renderCalls.length, 0);
    });

    it('does not render when the modal closed (groupEditId null) while the request was in flight', async () => {
      const { renderCalls } = await run({
        groupEditIdValue: null, groupId: 'g1', fetchedData: { members: [1], releaseOwnerProjectId: 1 }
      });
      assert.equal(renderCalls.length, 0);
    });
  });
});
