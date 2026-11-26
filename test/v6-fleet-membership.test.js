'use strict';

// v6 Fleet Membership Management (#3262, V6-009, Car V663-W1-A):
// lib/fleet-membership.js against a real node:sqlite-backed store, and
// lib/routes/v6-fleets.js's HTTP adapter over it, driven directly through
// its own `handle(req, res)` — not yet mounted in server.js (see that
// file's own header for why).
//
// Membership lives in `project_groups`/`project_group_members`, not
// `v6_fleets`/`v6_resources` — see `lib/fleet-membership.js`'s own header
// for the real, confirmed schema constraint (a UNIQUE column plus a
// composite foreign key) that rules the latter out for an EXISTING legacy
// project joining a fleet it does not itself own.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const fleetMembership = require('../lib/fleet-membership');
const { createV6FleetsRouter } = require('../lib/routes/v6-fleets');

let tmpDir = null;

function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-fleet-membership-'));
  store._setBasePath(tmpDir);
  store.init();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

/** A real `project_groups` row, standing in for a fleet's own membership roster. */
function seedGroup(name = 'demo-fleet') {
  return store.projectGroups.create({ name });
}

/** A real registered legacy project row. */
function seedLegacyProject(name) {
  return store.projects.create({ name, path: path.join(tmpDir, name), engine: 'claude' }).id;
}

describe('lib/fleet-membership.js — addMember', () => {
  it('adds a project to the group', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    const result = fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    assert.deepEqual(result, { ok: true, code: 'CREATED' });
    assert.deepEqual(store.projectGroups.listMembers(group.id), [legacyProjectId]);
  });

  it('refuses FLEET_NOT_FOUND for a group id that does not exist', (t) => {
    freshStore();
    t.after(cleanup);
    const legacyProjectId = seedLegacyProject('proj-a');
    const result = fleetMembership.addMember({ groupId: 'nope', legacyProjectId }, { groupsApi: store.projectGroups });
    assert.deepEqual(result, { ok: false, code: 'FLEET_NOT_FOUND' });
  });

  it('refuses PROJECT_NOT_FOUND when projectExists reports the project does not exist', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const result = fleetMembership.addMember(
      { groupId: group.id, legacyProjectId: 999 },
      { groupsApi: store.projectGroups, projectExists: () => false }
    );
    assert.deepEqual(result, { ok: false, code: 'PROJECT_NOT_FOUND' });
  });

  it('refuses ALREADY_MEMBER for a project already in the group', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    assert.equal(fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups }).ok, true);
    const second = fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    assert.deepEqual(second, { ok: false, code: 'ALREADY_MEMBER' });
  });

  it('validates groupId and legacyProjectId before touching the database', () => {
    assert.deepEqual(
      fleetMembership.addMember({ groupId: '', legacyProjectId: 1 }, { groupsApi: store.projectGroups }),
      { ok: false, code: 'INVALID_REQUEST' }
    );
    assert.deepEqual(
      fleetMembership.addMember({ groupId: 'g1', legacyProjectId: 'not-a-number' }, { groupsApi: store.projectGroups }),
      { ok: false, code: 'INVALID_REQUEST' }
    );
  });

  it('refuses MISSING_DEPENDENCY with no groupsApi injected', () => {
    assert.deepEqual(fleetMembership.addMember({ groupId: 'g1', legacyProjectId: 1 }, {}), { ok: false, code: 'MISSING_DEPENDENCY' });
  });
});

describe('lib/fleet-membership.js — removeMember', () => {
  it('removes a project from the group', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const removed = fleetMembership.removeMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    assert.deepEqual(removed, { ok: true, code: 'UPDATED' });
    assert.deepEqual(store.projectGroups.listMembers(group.id), []);
  });

  it('refuses NOT_FOUND for a project that is not a member', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    assert.deepEqual(fleetMembership.removeMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups }), { ok: false, code: 'NOT_FOUND' });
  });

  it('refuses FLEET_NOT_FOUND for an unknown group before checking membership', (t) => {
    freshStore();
    t.after(cleanup);
    assert.deepEqual(fleetMembership.removeMember({ groupId: 'nope', legacyProjectId: 1 }, { groupsApi: store.projectGroups }), { ok: false, code: 'FLEET_NOT_FOUND' });
  });

  it('the active-session safeguard: refuses ACTIVE_SESSION unless confirmed', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const deps = { groupsApi: store.projectGroups, isLegacyProjectSessionActive: () => true };
    const blocked = fleetMembership.removeMember({ groupId: group.id, legacyProjectId }, deps);
    assert.deepEqual(blocked, { ok: false, code: 'ACTIVE_SESSION' });
    assert.deepEqual(store.projectGroups.listMembers(group.id), [legacyProjectId], 'still a member — the refusal did not remove it');
    const confirmed = fleetMembership.removeMember({ groupId: group.id, legacyProjectId, confirmed: true }, deps);
    assert.equal(confirmed.ok, true);
    assert.deepEqual(store.projectGroups.listMembers(group.id), []);
  });

  it('defaults to "never active" when isLegacyProjectSessionActive is omitted — a test-only default, never the real caller\'s path', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    assert.equal(fleetMembership.removeMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups }).ok, true);
  });
});

describe('lib/fleet-membership.js — listMembers', () => {
  it('lists every current member', (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const a = seedLegacyProject('proj-a');
    const b = seedLegacyProject('proj-b');
    const c = seedLegacyProject('proj-c');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId: a }, { groupsApi: store.projectGroups });
    fleetMembership.addMember({ groupId: group.id, legacyProjectId: b }, { groupsApi: store.projectGroups });
    fleetMembership.addMember({ groupId: group.id, legacyProjectId: c }, { groupsApi: store.projectGroups });
    fleetMembership.removeMember({ groupId: group.id, legacyProjectId: b }, { groupsApi: store.projectGroups });
    const result = fleetMembership.listMembers({ groupId: group.id }, { groupsApi: store.projectGroups });
    assert.equal(result.ok, true);
    assert.deepEqual(result.members, [a, c]);
  });

  it('refuses FLEET_NOT_FOUND for an unknown group', (t) => {
    freshStore();
    t.after(cleanup);
    assert.deepEqual(fleetMembership.listMembers({ groupId: 'nope' }, { groupsApi: store.projectGroups }), { ok: false, code: 'FLEET_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------
// lib/routes/v6-fleets.js — driven directly through handle(req, res),
// the same way other not-yet-mounted route factories' own test files do.
// ---------------------------------------------------------------------

/** A minimal fake `http.IncomingMessage`/`http.ServerResponse` pair for `handle(req, res)`. */
function fakeExchange(method, url, bodyObj) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code) { this.statusCode = code; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; }
  };
  process.nextTick(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
    req.emit('end');
  });
  return { req, res };
}

describe('lib/routes/v6-fleets.js', () => {
  it('POST /api/v6/fleets/:groupId/members adds a member and responds 201', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups });
    const { req, res } = fakeExchange('POST', `/api/v6/fleets/${group.id}/members`, { legacyProjectId });
    const handled = await router.handle(req, res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.ok, true);
    assert.deepEqual(store.projectGroups.listMembers(group.id), [legacyProjectId]);
  });

  it('POST with a non-integer legacyProjectId responds 400 before touching fleet-membership at all', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups });
    const { req, res } = fakeExchange('POST', `/api/v6/fleets/${group.id}/members`, { legacyProjectId: 'nope' });
    await router.handle(req, res);
    assert.equal(res.statusCode, 400);
  });

  it('GET /api/v6/fleets/:groupId/members lists current members', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups });
    const { req, res } = fakeExchange('GET', `/api/v6/fleets/${group.id}/members`);
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.members, [legacyProjectId]);
  });

  it('DELETE /api/v6/fleets/:groupId/members/:legacyProjectId removes a member', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups });
    const { req, res } = fakeExchange('DELETE', `/api/v6/fleets/${group.id}/members/${legacyProjectId}`);
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(store.projectGroups.listMembers(group.id), []);
  });

  it('DELETE translates ACTIVE_SESSION into a 409', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups, isLegacyProjectSessionActive: () => true });
    const { req, res } = fakeExchange('DELETE', `/api/v6/fleets/${group.id}/members/${legacyProjectId}`);
    await router.handle(req, res);
    assert.equal(res.statusCode, 409);
  });

  it('DELETE with confirmed:true in the body bypasses the active-session refusal', async (t) => {
    freshStore();
    t.after(cleanup);
    const group = seedGroup();
    const legacyProjectId = seedLegacyProject('proj-a');
    fleetMembership.addMember({ groupId: group.id, legacyProjectId }, { groupsApi: store.projectGroups });
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups, isLegacyProjectSessionActive: () => true });
    const { req, res } = fakeExchange('DELETE', `/api/v6/fleets/${group.id}/members/${legacyProjectId}`, { confirmed: true });
    await router.handle(req, res);
    assert.equal(res.statusCode, 200);
  });

  it('returns false (unhandled) for a request matching no route in this table', async () => {
    const router = createV6FleetsRouter({ groupsApi: store.projectGroups });
    const { req, res } = fakeExchange('GET', '/api/something-else');
    assert.equal(await router.handle(req, res), false);
  });
});
