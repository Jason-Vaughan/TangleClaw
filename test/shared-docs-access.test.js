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
    groupsForProject: (pid) => groups[pid] || []
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

describe('canSeeGroup', () => {
  it('the operator sees every group; a project only its own; nobody else any', () => {
    assert.equal(access.canSeeGroup({ kind: KINDS.OPERATOR, groupIds: [] }, 'g-z'), true);
    const bound = access.resolveAccess(req(BOUND_7), fakeDeps());
    assert.equal(access.canSeeGroup(bound, 'g-a'), true);
    assert.equal(access.canSeeGroup(bound, 'g-c'), false);
    assert.equal(access.canSeeGroup({ kind: KINDS.UNBOUND, groupIds: ['g-a'] }, 'g-a'), false);
    assert.equal(access.canSeeGroup({ kind: KINDS.INVALID, groupIds: ['g-a'] }, 'g-a'), false);
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

  it('stops honouring the launch once its session is wrapped', () => {
    store.sessions.wrap(bound.session.id, 'done');
    const a = access.resolveAccess(req({
      'x-tangleclaw-launch-id': bound.launchId, 'x-tangleclaw-project-id': String(project.id)
    }));
    assert.equal(a.reason, INVALID_REASONS.SESSION_NOT_ACTIVE);
  });
});
