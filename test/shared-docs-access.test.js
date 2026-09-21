'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const access = require('../lib/shared-docs-access');

setLevel('error');

const { KINDS, INVALID_REASONS } = access;

/**
 * Fake store lookups: one live launch for project 7 (session 70, groups g-a
 * and g-b), one launch for project 8 whose session was wrapped.
 * @returns {object} deps for `resolveAccess`
 */
function fakeDeps() {
  const launches = {
    'live-7': { projectId: 7, sessionId: 70 },
    'wrapped-8': { projectId: 8, sessionId: 80 }
  };
  const sessions = {
    70: { id: 70, status: 'active' },
    80: { id: 80, status: 'wrapped' }
  };
  const groups = { 7: [{ id: 'g-a' }, { id: 'g-b' }], 8: [{ id: 'g-c' }] };
  return {
    getLaunch: (id) => launches[id] || null,
    getSession: (id) => sessions[id] || null,
    groupsForProject: (pid) => groups[pid] || [],
    liveMasterLaunch: () => ({ launchId: 'master-live', answered: true, cause: null })
  };
}

/**
 * A request as `server.js` hands it to a route.
 * @param {object} headers - Request headers (lower-cased keys)
 * @param {object} [extra] - `tcSession` / `tcGateActive`
 * @returns {object}
 */
function req(headers, extra = {}) {
  return { headers, tcSession: null, tcGateActive: true, ...extra };
}

const BOUND_7 = { 'x-tangleclaw-launch-id': 'live-7', 'x-tangleclaw-project-id': '7' };

describe('resolveAccess — operator', () => {
  it('a signed-in session is the operator, whatever else the request carries', () => {
    const a = access.resolveAccess(req({}, { tcSession: { username: 'op' } }), fakeDeps());
    assert.equal(a.kind, KINDS.OPERATOR);
  });

  it('a browser-shaped request is the operator when the gate stands down', () => {
    const a = access.resolveAccess(req({ 'sec-fetch-site': 'same-origin' }, { tcGateActive: false }), fakeDeps());
    assert.equal(a.kind, KINDS.OPERATOR);
    const b = access.resolveAccess(req({ origin: 'https://host' }, { tcGateActive: false }), fakeDeps());
    assert.equal(b.kind, KINDS.OPERATOR);
  });

  it('a browser-shaped request without a session is NOT the operator while the gate is live', () => {
    const a = access.resolveAccess(req({ 'sec-fetch-site': 'same-origin' }, { tcGateActive: true }), fakeDeps());
    assert.equal(a.kind, KINDS.UNBOUND);
  });

  it('browser shape counts only when the gate state was stated as down', () => {
    const r = { headers: { 'sec-fetch-site': 'same-origin' } };
    assert.equal(access.resolveAccess(r, fakeDeps()).kind, KINDS.UNBOUND);
  });

  it('a local non-browser caller with the gate down is not the operator for being local', () => {
    const a = access.resolveAccess(req({}, { tcGateActive: false }), fakeDeps());
    assert.equal(a.kind, KINDS.UNBOUND);
  });
});

describe('resolveAccess — project binding', () => {
  it('a live launch whose project matches the claim binds to that project and its groups', () => {
    const a = access.resolveAccess(req(BOUND_7), fakeDeps());
    assert.deepEqual(a, { kind: KINDS.PROJECT, projectId: 7, groupIds: ['g-a', 'g-b'], reason: null });
  });

  it('with no launch id the caller is unbound, even with a project claim', () => {
    assert.equal(access.resolveAccess(req({}), fakeDeps()).kind, KINDS.UNBOUND);
    assert.equal(access.resolveAccess(req({ 'x-tangleclaw-project-id': '7' }), fakeDeps()).kind, KINDS.UNBOUND);
    assert.equal(access.resolveAccess(req({ 'x-tangleclaw-launch-id': '' }), fakeDeps()).kind, KINDS.UNBOUND);
  });

  it('a launch id without a project claim is invalid, not bound by the launch alone', () => {
    const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'live-7' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.PROJECT_CLAIM_MISSING);
  });

  it('a garbled project claim is invalid', () => {
    for (const bad of ['7abc', '-7', '7.0', ' 7', '']) {
      const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'live-7', 'x-tangleclaw-project-id': bad }), fakeDeps());
      assert.equal(a.kind, KINDS.INVALID, `claim ${JSON.stringify(bad)}`);
      assert.equal(a.reason, INVALID_REASONS.PROJECT_CLAIM_MISSING);
    }
  });

  it('an unknown launch id is invalid', () => {
    const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'forged', 'x-tangleclaw-project-id': '7' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.UNKNOWN_LAUNCH);
  });

  it('a launch id presented with another project\'s claim is invalid and binds to neither', () => {
    const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'live-7', 'x-tangleclaw-project-id': '8' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.PROJECT_MISMATCH);
    assert.equal(a.projectId, null);
    assert.deepEqual(a.groupIds, []);
  });

  it('a launch whose session is no longer active is invalid', () => {
    const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'wrapped-8', 'x-tangleclaw-project-id': '8' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.SESSION_NOT_ACTIVE);
  });

  it('a launch whose session row is gone is invalid', () => {
    const deps = { ...fakeDeps(), getSession: () => null };
    assert.equal(access.resolveAccess(req(BOUND_7), deps).reason, INVALID_REASONS.SESSION_NOT_ACTIVE);
  });
});

const MASTER = { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'master-live' };

describe('resolveAccess — Project Master binding', () => {
  it('the live Master\'s launch id with the role header is the Master', () => {
    const a = access.resolveAccess(req(MASTER), fakeDeps());
    assert.deepEqual(a, { kind: KINDS.MASTER, projectId: null, groupIds: [], reason: null });
  });

  it('a replaced or ended Master\'s id is invalid, never the Master', () => {
    const a = access.resolveAccess(req({ ...MASTER, 'x-tangleclaw-launch-id': 'master-before-relaunch' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.MASTER_LAUNCH_STALE);
    const ended = { ...fakeDeps(), liveMasterLaunch: () => ({ launchId: null, answered: true, cause: null }) };
    assert.equal(access.resolveAccess(req(MASTER), ended).reason, INVALID_REASONS.MASTER_LAUNCH_STALE);
  });

  it('refuses when tmux cannot say which id is the live Master\'s', () => {
    const silent = { ...fakeDeps(), liveMasterLaunch: () => ({ launchId: null, answered: false, cause: 'read-timed-out' }) };
    const a = access.resolveAccess(req(MASTER), silent);
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.MASTER_UNVERIFIABLE);
    assert.equal(a.cause, 'read-timed-out', 'why tmux did not answer travels with the refusal');
  });

  it('the role header with no launch id is unbound', () => {
    assert.equal(access.resolveAccess(req({ 'x-tangleclaw-role': 'master' }), fakeDeps()).kind, KINDS.UNBOUND);
  });

  it('a project launch id with the role header is that project, never the Master', () => {
    const a = access.resolveAccess(req({ ...BOUND_7, 'x-tangleclaw-role': 'master' }), fakeDeps());
    assert.equal(a.kind, KINDS.PROJECT);
    assert.equal(a.projectId, 7);
    // Even without its project claim, it is refused as a project, not promoted.
    const noClaim = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'live-7', 'x-tangleclaw-role': 'master' }), fakeDeps());
    assert.equal(noClaim.kind, KINDS.INVALID);
    assert.equal(noClaim.reason, INVALID_REASONS.PROJECT_CLAIM_MISSING);
  });

  it('the live Master\'s id without the role header is not the Master', () => {
    const a = access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'master-live', 'x-tangleclaw-project-id': '7' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.UNKNOWN_LAUNCH);
  });

  it('asks tmux only for a request that claims the Master role', () => {
    let asked = 0;
    const counting = { ...fakeDeps(), liveMasterLaunch: () => { asked += 1; return { launchId: 'master-live', answered: true, cause: null }; } };
    access.resolveAccess(req(BOUND_7), counting);
    access.resolveAccess(req({ 'x-tangleclaw-launch-id': 'forged', 'x-tangleclaw-project-id': '7' }), counting);
    access.resolveAccess(req({ ...BOUND_7, 'x-tangleclaw-role': 'master' }), counting);
    assert.equal(asked, 0);
    access.resolveAccess(req(MASTER), counting);
    assert.equal(asked, 1);
  });

  it('a role other than master changes nothing', () => {
    const a = access.resolveAccess(req({ ...MASTER, 'x-tangleclaw-role': 'Master' }), fakeDeps());
    assert.equal(a.kind, KINDS.INVALID);
    assert.equal(a.reason, INVALID_REASONS.PROJECT_CLAIM_MISSING);
  });
});

describe('canSeeGroup', () => {
  it('the operator sees every group; a project only its own; nobody else any', () => {
    assert.equal(access.canSeeGroup({ kind: KINDS.OPERATOR, groupIds: [] }, 'g-z'), true);
    const bound = access.resolveAccess(req(BOUND_7), fakeDeps());
    assert.equal(access.canSeeGroup(bound, 'g-a'), true);
    assert.equal(access.canSeeGroup(bound, 'g-c'), false);
    assert.equal(access.canSeeGroup({ kind: KINDS.UNBOUND, groupIds: ['g-a'] }, 'g-a'), false);
    assert.equal(access.canSeeGroup({ kind: KINDS.INVALID, groupIds: ['g-a'] }, 'g-a'), false);
  });

  it('the bound Master sees every group', () => {
    const m = access.resolveAccess(req(MASTER), fakeDeps());
    assert.equal(access.canSeeGroup(m, 'g-a'), true);
    assert.equal(access.canSeeGroup(m, 'g-z'), true);
  });
});

describe('refusalFor', () => {
  it('refuses unbound and invalid callers with 403 and names the headers and env vars', () => {
    const unbound = access.refusalFor({ kind: KINDS.UNBOUND, reason: null });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.code, 'SHARED_DOCS_BINDING_REQUIRED');
    const invalid = access.refusalFor({ kind: KINDS.INVALID, reason: INVALID_REASONS.PROJECT_MISMATCH });
    assert.equal(invalid.status, 403);
    assert.equal(invalid.code, 'SHARED_DOCS_BINDING_INVALID');
    assert.match(invalid.message, /project-mismatch/);
    for (const r of [unbound, invalid]) {
      for (const needle of ['x-tangleclaw-project-id', 'x-tangleclaw-launch-id', '$TANGLECLAW_PROJECT_ID', '$TANGLECLAW_LAUNCH_ID']) {
        assert.ok(r.message.includes(needle), `${r.code} names ${needle}`);
      }
    }
  });

  it('refuses nobody who is bound', () => {
    assert.equal(access.refusalFor({ kind: KINDS.OPERATOR, reason: null }), null);
    assert.equal(access.refusalFor({ kind: KINDS.PROJECT, reason: null }), null);
    assert.equal(access.refusalFor({ kind: KINDS.MASTER, reason: null }), null);
  });

  it('tells a refused Master how the Master binds, not how a project does', () => {
    for (const reason of [INVALID_REASONS.MASTER_LAUNCH_STALE, INVALID_REASONS.MASTER_UNVERIFIABLE]) {
      const r = access.refusalFor({ kind: KINDS.INVALID, reason });
      assert.equal(r.status, 403);
      assert.equal(r.code, 'SHARED_DOCS_BINDING_INVALID');
      assert.ok(r.message.includes(reason));
      for (const needle of ['x-tangleclaw-role: master', 'x-tangleclaw-launch-id', '$TANGLECLAW_LAUNCH_ID', 'relaunch the Project Master']) {
        assert.ok(r.message.includes(needle), `${reason} names ${needle}`);
      }
      assert.ok(!r.message.includes('$TANGLECLAW_PROJECT_ID'), 'the Master has no project id to send');
    }
  });
});

describe('resolveAccess against a real store', () => {
  let tmpDir;
  let project;
  let other;
  let bound;
  let group;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-docs-access-'));
    store._setBasePath(tmpDir);
    store.init();
    const launchSequence = require('../lib/launch-sequence');
    const mk = (name) => {
      const dir = path.join(tmpDir, 'projects', name);
      fs.mkdirSync(dir, { recursive: true });
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };
    project = mk('reader');
    other = mk('neighbour');
    group = store.projectGroups.create({ name: 'readers' });
    store.projectGroups.addMember(group.id, project.id);
    store.projectGroups.create({ name: 'neighbours' });

    const engine = store.engines.get('claude');
    const launchId = launchSequence.mintLaunchId();
    const snapshot = launchSequence.buildSnapshot({
      launchId, project, engineProfile: engine,
      applicability: { applicable: false, reason: 'test' }, rendered: null, rules: []
    });
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
    bound = { launchId, session };
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('binds a live launch to its project and exactly that project\'s groups', () => {
    const a = access.resolveAccess(req({
      'x-tangleclaw-launch-id': bound.launchId, 'x-tangleclaw-project-id': String(project.id)
    }));
    assert.equal(a.kind, KINDS.PROJECT);
    assert.equal(a.projectId, project.id);
    assert.deepEqual(a.groupIds, [group.id]);
  });

  it('refuses the same launch id claimed for another project', () => {
    const a = access.resolveAccess(req({
      'x-tangleclaw-launch-id': bound.launchId, 'x-tangleclaw-project-id': String(other.id)
    }));
    assert.equal(a.reason, INVALID_REASONS.PROJECT_MISMATCH);
  });

  it('by default asks lib/master for the live Master\'s id, after the store says the id is no project\'s', () => {
    // Patched on the module object the lazy require returns, so this never
    // reads the Master session actually running on the test host.
    const master = require('../lib/master');
    const real = master.liveMasterLaunchId;
    master.liveMasterLaunchId = () => ({ launchId: 'master-live', answered: true, cause: null });
    try {
      assert.equal(access.resolveAccess(req({ 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'master-live' })).kind, KINDS.MASTER);
      const promoted = access.resolveAccess(req({
        'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': bound.launchId, 'x-tangleclaw-project-id': String(project.id)
      }));
      assert.equal(promoted.kind, KINDS.PROJECT, 'a real project launch id stays that project\'s');
    } finally {
      master.liveMasterLaunchId = real;
    }
  });

  it('stops honouring the launch once its session is wrapped', () => {
    store.sessions.wrap(bound.session.id, 'done');
    const a = access.resolveAccess(req({
      'x-tangleclaw-launch-id': bound.launchId, 'x-tangleclaw-project-id': String(project.id)
    }));
    assert.equal(a.reason, INVALID_REASONS.SESSION_NOT_ACTIVE);
  });
});
