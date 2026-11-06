'use strict';

/**
 * Delegated peer recovery clearance (#1713, Architect Ruling A505-R2 /
 * A505-R2.3, schema v79): CROSS-PROJECT by design — each fleet lane
 * (`TC-Lane-PM`, `TC-Lane-Arc`, the lane it coordinates) is its own
 * `store.projects` row with at most one active session
 * (`lib/sessions.js#launchSession`'s own guard), so "the coordinator's
 * session" can never be a second session of the TARGET's own project; it
 * is the active session of whichever OTHER project holds the opted-in
 * `architect`/`project-manager` grant. Covers the v79 migration itself
 * (against a real seeded v78 database), the store write
 * (`clearRecoveryAsPeer`) and its CHECK constraints, the orchestration
 * layer (`clearOneLaunchAsPeer`)'s eligibility outcomes (reusing the same
 * real-launch fixture `test/launch-recovery-clear-batch.test.js` already
 * relies on), `validatePeerClearance`'s own cross-project eligibility
 * question, and the route end to end against a real server.
 */

const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchRecoveryClear = require('../lib/launch-recovery-clear');
const fixture = require('./_recovery-fixture');
const { bindProject, sendAs, operatorOf } = require('./_shared-docs-callers');
const { createServer } = require('../server');

const tmpDirs = [];

// ── v79 migration, against a real seeded v78 database ──

/** The `launch_recovery_clearances` table exactly as v78 shipped it. */
const V78_LAUNCH_RECOVERY_CLEARANCES_DDL = `
  CREATE TABLE launch_recovery_clearances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 1 AND 64),
    project_id INTEGER NOT NULL, session_id INTEGER NOT NULL, sequence_id INTEGER NOT NULL,
    recovery_revision INTEGER NOT NULL,
    clearance TEXT NOT NULL CHECK (clearance IN ('operator-verified','open-install-unverified')),
    cleared_by TEXT, preflight TEXT NOT NULL, cleared_at TEXT NOT NULL,
    CHECK ((clearance = 'operator-verified') = (cleared_by IS NOT NULL)),
    CHECK (batch_id IS NULL OR clearance = 'operator-verified')
  );
  CREATE UNIQUE INDEX idx_launch_recovery_clearances_sequence ON launch_recovery_clearances(sequence_id);
  CREATE INDEX idx_launch_recovery_clearances_batch ON launch_recovery_clearances(batch_id) WHERE batch_id IS NOT NULL;
  CREATE TRIGGER launch_recovery_clearances_append_only_update BEFORE UPDATE ON launch_recovery_clearances
    BEGIN SELECT RAISE(ABORT, 'launch_recovery_clearances is append-only'); END;
  CREATE TRIGGER launch_recovery_clearances_append_only_delete BEFORE DELETE ON launch_recovery_clearances
    BEGIN SELECT RAISE(ABORT, 'launch_recovery_clearances is append-only'); END;
`;

/** One pre-v79 operator clearance, recorded before the peer door existed. */
const PRE_V79_ROW = `
  INSERT INTO launch_recovery_clearances (project_id, session_id, sequence_id, recovery_revision, clearance, cleared_by, preflight, cleared_at)
  VALUES (1, 100, 5000, 1, 'operator-verified', 'alice', '{}', '2026-01-01T00:00:00Z');
`;

/**
 * Seed a database at v78 with the pre-peer-clearance `launch_recovery_clearances`
 * table (and the minimum other tables `_createTables`/migrations need to exist
 * alongside it — none; the migration touches only this one table).
 * @returns {string} The store's base directory.
 */
function seedV78() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-peer-clear-mig-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (78);
    ${V78_LAUNCH_RECOVERY_CLEARANCES_DDL}
    ${PRE_V79_ROW}
  `);
  seed.close();
  return dir;
}

describe('schema v78→v79: launch_recovery_clearances admits peer-cleared (#1713)', () => {
  after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves every pre-existing row exactly, with the four new columns NULL', () => {
    const dir = seedV78();
    store._setBasePath(dir);
    store.init();
    try {
      const row = store.getDb().prepare('SELECT * FROM launch_recovery_clearances WHERE id = 1').get();
      assert.equal(row.clearance, 'operator-verified');
      assert.equal(row.cleared_by, 'alice');
      assert.equal(row.cleared_by_session_id, null);
      assert.equal(row.cleared_by_role, null);
      assert.equal(row.cleared_by_launch_id, null);
      assert.equal(row.reason, null);
      assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 79);
    } finally {
      store.close();
    }
  });

  it('accepts a well-formed peer-cleared row and rejects one missing cleared_by_session_id', () => {
    const dir = seedV78();
    store._setBasePath(dir);
    store.init();
    try {
      const db = store.getDb();
      assert.doesNotThrow(() => db.prepare(`
        INSERT INTO launch_recovery_clearances
          (project_id, session_id, sequence_id, recovery_revision, clearance,
           cleared_by_session_id, cleared_by_role, cleared_by_launch_id, reason, preflight, cleared_at)
        VALUES (1, 200, 6000, 1, 'peer-cleared', 1555, 'project-manager', 'launch-abc', 'stalled', '{}', '2026-01-01T00:00:00Z')
      `).run());
      assert.throws(() => db.prepare(`
        INSERT INTO launch_recovery_clearances (project_id, session_id, sequence_id, recovery_revision, clearance, preflight, cleared_at)
        VALUES (1, 300, 7000, 1, 'peer-cleared', '{}', '2026-01-01T00:00:00Z')
      `).run(), /CHECK constraint failed/);
      assert.throws(() => db.prepare(`
        INSERT INTO launch_recovery_clearances (project_id, session_id, sequence_id, recovery_revision, clearance, cleared_by_role, preflight, cleared_at)
        VALUES (1, 400, 8000, 1, 'peer-cleared', 'not-a-real-role', '{}', '2026-01-01T00:00:00Z')
      `).run(), /CHECK constraint failed/, 'cleared_by_role is still constrained to the two real coordinator roles');
    } finally {
      store.close();
    }
  });

  it('is idempotent: a second init against an already-v79 store is a no-op', () => {
    const dir = seedV78();
    store._setBasePath(dir);
    store.init();
    store.close();
    store._setBasePath(dir);
    assert.doesNotThrow(() => store.init());
    store.close();
  });
});

// ── Store layer: clearRecoveryAsPeer ──

describe('store.launchSequences.clearRecoveryAsPeer (#1713)', () => {
  let env;
  before(() => { env = fixture.openTempStore('tc-peer-clear-store-'); });
  after(() => env.restore());

  it('clears recovery, leaves recovery_clearance NULL, and writes a full audit row', () => {
    const held = fixture.launchInRecovery(env);
    const cleared = store.launchSequences.clearRecoveryAsPeer(held.sequence.id, {
      sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
      clearedBySessionId: 9999, clearedByRole: 'project-manager', clearedByLaunchId: 'launch-xyz', reason: 'peer test'
    });
    assert.ok(cleared);
    assert.equal(cleared.recovery, 'cleared');
    assert.equal(cleared.recoveryClearance, null);
    assert.equal(cleared.recoveryClearedBy, 'peer:project-manager#9999');

    const audit = store.getDb().prepare('SELECT * FROM launch_recovery_clearances WHERE sequence_id = ?').get(held.sequence.id);
    assert.equal(audit.clearance, 'peer-cleared');
    assert.equal(audit.cleared_by, null);
    assert.equal(audit.cleared_by_session_id, 9999);
    assert.equal(audit.cleared_by_role, 'project-manager');
    assert.equal(audit.cleared_by_launch_id, 'launch-xyz');
    assert.equal(audit.reason, 'peer test');
  });

  it('returns null (binding moved) for a stale recoveryRevision, writing nothing', () => {
    const held = fixture.launchInRecovery(env);
    const before = store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_recovery_clearances').get().n;
    const result = store.launchSequences.clearRecoveryAsPeer(held.sequence.id, {
      sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision + 1,
      clearedBySessionId: 9999, clearedByRole: 'architect', clearedByLaunchId: 'launch-xyz'
    });
    assert.equal(result, null);
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_recovery_clearances').get().n, before);
  });

  it('throws when clearedBySessionId is not an integer', () => {
    const held = fixture.launchInRecovery(env);
    assert.throws(() => store.launchSequences.clearRecoveryAsPeer(held.sequence.id, {
      sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
      clearedByRole: 'architect', clearedByLaunchId: 'launch-xyz'
    }), /clearing peer's own session id/);
  });

  it('throws when clearedByRole is not a real coordinator role', () => {
    const held = fixture.launchInRecovery(env);
    assert.throws(() => store.launchSequences.clearRecoveryAsPeer(held.sequence.id, {
      sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
      clearedBySessionId: 9999, clearedByRole: 'worker', clearedByLaunchId: 'launch-xyz'
    }), /clearing peer's role/);
  });

  it('throws when clearedByLaunchId is missing', () => {
    const held = fixture.launchInRecovery(env);
    assert.throws(() => store.launchSequences.clearRecoveryAsPeer(held.sequence.id, {
      sessionId: held.binding.sessionId, recoveryRevision: held.binding.recoveryRevision,
      clearedBySessionId: 9999, clearedByRole: 'architect'
    }), /clearing peer's own launch id/);
  });
});

// ── Orchestration layer: clearOneLaunchAsPeer's eligibility outcomes ──

describe('launchRecoveryClear.clearOneLaunchAsPeer (#1713)', () => {
  let env;
  before(() => { env = fixture.openTempStore('tc-peer-clear-orchestration-'); });
  after(() => env.restore());

  const PEER = { clearedBySessionId: 9999, clearedByRole: 'project-manager', clearedByLaunchId: 'launch-xyz' };

  it('CLEARED: writes the clearance and logs the activity row with clearance "peer-cleared"', () => {
    const held = fixture.launchInRecovery(env);
    const result = launchRecoveryClear.clearOneLaunchAsPeer({ project: held.project, ...held.binding, ...PEER });
    assert.equal(result.outcome, launchRecoveryClear.OUTCOMES.CLEARED);
    assert.equal(result.sequence.recovery, 'cleared');
    const activityRow = store.getDb().prepare(
      "SELECT detail FROM activity_log WHERE event_type = 'launch.recovery-cleared' AND session_id = ? ORDER BY id DESC LIMIT 1"
    ).get(held.binding.sessionId);
    const detail = JSON.parse(activityRow.detail);
    assert.equal(detail.clearance, 'peer-cleared');
    assert.equal(detail.clearedByRole, 'project-manager');
  });

  it('NOT_FOUND: a sequenceId that does not belong to the named session', () => {
    const held = fixture.launchInRecovery(env);
    const result = launchRecoveryClear.clearOneLaunchAsPeer({
      project: held.project, sessionId: held.binding.sessionId, sequenceId: held.binding.sequenceId + 999999,
      recoveryRevision: held.binding.recoveryRevision, ...PEER
    });
    assert.equal(result.outcome, launchRecoveryClear.OUTCOMES.NOT_FOUND);
  });

  it('ADVISORY: a project in advisory recovery mode clears by reconciliation, never by this door', () => {
    const held = fixture.launchInRecovery(env, 'advisory');
    const result = launchRecoveryClear.clearOneLaunchAsPeer({ project: held.project, ...held.binding, ...PEER });
    assert.equal(result.outcome, launchRecoveryClear.OUTCOMES.ADVISORY);
  });

  it('NOT_REQUIRED: a launch whose recovery already cleared', () => {
    const held = fixture.launchInRecovery(env);
    const first = launchRecoveryClear.clearOneLaunchAsPeer({ project: held.project, ...held.binding, ...PEER });
    assert.equal(first.outcome, launchRecoveryClear.OUTCOMES.CLEARED);
    const second = launchRecoveryClear.clearOneLaunchAsPeer({
      project: held.project, ...held.binding, recoveryRevision: held.binding.recoveryRevision, ...PEER
    });
    assert.equal(second.outcome, launchRecoveryClear.OUTCOMES.NOT_REQUIRED);
  });

  it('BINDING_MOVED: a stale recoveryRevision on an otherwise-eligible launch', () => {
    const held = fixture.launchInRecovery(env);
    const result = launchRecoveryClear.clearOneLaunchAsPeer({
      project: held.project, sessionId: held.binding.sessionId, sequenceId: held.binding.sequenceId,
      recoveryRevision: held.binding.recoveryRevision + 1, ...PEER
    });
    assert.equal(result.outcome, launchRecoveryClear.OUTCOMES.BINDING_MOVED);
  });
});

// ── validatePeerClearance: cross-project eligibility (#1713, A505-R2.3) ──

describe('launchRecoveryClear.validatePeerClearance (#1713, cross-project)', () => {
  let env;
  before(() => { env = fixture.openTempStore('tc-peer-clear-validate-'); });
  after(() => env.restore());

  /**
   * A plain active, launched session in its own fresh project — no
   * coordinator role, no recovery involved. For the CLEARING side.
   * @returns {{project: object, binding: {sessionId: number}}}
   */
  function freshBoundProject() {
    const dir = path.join(env.projectsDir, `bound-${Math.random().toString(36).slice(2, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name: path.basename(dir), path: dir, engine: 'claude' });
    const binding = bindProject(project);
    return { project, binding };
  }

  it('refuses SELF when the clearing session names itself as the target', () => {
    const result = launchRecoveryClear.validatePeerClearance({
      targetProject: { id: 1 }, targetSessionId: 500, clearingSessionId: 500
    });
    assert.equal(result.ok, false);
    assert.equal(result.refusal, launchRecoveryClear.PEER_CLEARANCE_REFUSALS.SELF);
  });

  it('refuses SELF when the clearing session belongs to the TARGET project, even under a different session id', () => {
    const held = fixture.launchInRecovery(env);
    const result = launchRecoveryClear.validatePeerClearance({
      targetProject: held.project, targetSessionId: held.binding.sessionId + 999, clearingSessionId: held.binding.sessionId
    });
    assert.equal(result.ok, false);
    assert.equal(result.refusal, launchRecoveryClear.PEER_CLEARANCE_REFUSALS.SELF);
  });

  it('refuses NOT_ACTIVE_PEER for a clearing session id with no row at all', () => {
    const held = fixture.launchInRecovery(env);
    const result = launchRecoveryClear.validatePeerClearance({
      targetProject: held.project, targetSessionId: held.binding.sessionId, clearingSessionId: 99999999
    });
    assert.equal(result.ok, false);
    assert.equal(result.refusal, launchRecoveryClear.PEER_CLEARANCE_REFUSALS.NOT_ACTIVE_PEER);
  });

  it('refuses NOT_COORDINATOR when the clearing session\'s own project has no active role granted', () => {
    const held = fixture.launchInRecovery(env);
    const clearer = freshBoundProject();
    const result = launchRecoveryClear.validatePeerClearance({
      targetProject: held.project, targetSessionId: held.binding.sessionId, clearingSessionId: clearer.binding.sessionId
    });
    assert.equal(result.ok, false);
    assert.equal(result.refusal, launchRecoveryClear.PEER_CLEARANCE_REFUSALS.NOT_COORDINATOR);
  });

  it('succeeds (ok:true, role) for an active session of a DIFFERENT project holding an active architect/project-manager grant', () => {
    const held = fixture.launchInRecovery(env);
    const clearer = freshBoundProject();
    store.coordinatorRoles.grant({
      roleId: `role-${clearer.project.id}`, projectId: clearer.project.id, role: 'project-manager', note: null, now: new Date().toISOString()
    });
    const result = launchRecoveryClear.validatePeerClearance({
      targetProject: held.project, targetSessionId: held.binding.sessionId, clearingSessionId: clearer.binding.sessionId
    });
    assert.deepEqual(result, { ok: true, role: 'project-manager' });
  });
});

// ── The route, end to end against a real server (#1713) ──

describe('POST /api/sessions/:project/launch/recovery-clear-peer (#1713)', () => {
  let env;
  let server;

  before(async () => {
    env = fixture.openTempStore('tc-peer-clear-route-');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    env.restore();
  });

  /**
   * A project with an active session and an active architect/project-manager
   * grant of its own — ready to act as the clearing coordinator.
   * @param {'architect'|'project-manager'} role
   * @returns {{project: object, binding: object}}
   */
  function coordinatorProject(role) {
    const dir = path.join(env.projectsDir, `coord-${Math.random().toString(36).slice(2, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name: path.basename(dir), path: dir, engine: 'claude' });
    const binding = bindProject(project);
    store.coordinatorRoles.grant({
      roleId: `role-${project.id}`, projectId: project.id, role, note: null, now: new Date().toISOString()
    });
    return { project, binding };
  }

  const URL_FOR = (projectName) => `/api/sessions/${encodeURIComponent(projectName)}/launch/recovery-clear-peer`;

  // Each test below spends several real seconds in fixture.launchInRecovery
  // before its one HTTP call -- well past Node's default 5s server-side
  // keep-alive timeout, so a pooled client socket from an earlier test (or
  // from this same call reusing the global agent) can be torn down by the
  // server between tests. `Connection: close` forces a fresh socket per
  // request rather than racing a stale pooled one (ECONNRESET).
  const FRESH = { Connection: 'close' };

  it('clears a target project\'s stalled launch when sent by a different project\'s coordinator session', async () => {
    const held = fixture.launchInRecovery(env);
    const coordinator = coordinatorProject('architect');
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name),
      { ...held.binding, reason: 'peer test' }, { ...FRESH, ...coordinator.binding.headers });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.recovery, 'cleared');
    assert.equal(res.data.clearedBySessionId, coordinator.binding.sessionId);
    assert.equal(res.data.clearedByRole, 'architect');
    assert.equal(res.data.reason, 'peer test');
  });

  it('refuses with no launch-binding headers at all -- the generic launch-binding floor catches this before the route\'s own check ever runs', async () => {
    const held = fixture.launchInRecovery(env);
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name), { ...held.binding }, FRESH);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
  });

  it('refuses a verified OPERATOR caller through this door (PEER_CLEARANCE_CALLER_UNVERIFIED) -- use the operator clear route instead', async () => {
    const held = fixture.launchInRecovery(env);
    const operatorHeaders = await operatorOf(server)();
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name), { ...held.binding }, { ...FRESH, ...operatorHeaders });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'PEER_CLEARANCE_CALLER_UNVERIFIED');
  });

  it('refuses a project trying to clear its own launch through this door (PEER_CLEARANCE_SELF)', async () => {
    const held = fixture.launchInRecovery(env);
    // A second (bindProject bypasses the one-active-session guard) session of
    // the SAME target project, calling in on its own launch -- same project,
    // different session id than the one being cleared.
    const secondSessionOfSameProject = bindProject(held.project);
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name),
      { ...held.binding }, { ...FRESH, ...secondSessionOfSameProject.headers });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'PEER_CLEARANCE_SELF');
  });

  it('refuses a verified session with no coordinator role on its own project (PEER_CLEARANCE_NOT_COORDINATOR)', async () => {
    const held = fixture.launchInRecovery(env);
    const dir = path.join(env.projectsDir, `noncoord-${Math.random().toString(36).slice(2, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    const plainProject = store.projects.create({ name: path.basename(dir), path: dir, engine: 'claude' });
    const plainBinding = bindProject(plainProject);
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name),
      { ...held.binding }, { ...FRESH, ...plainBinding.headers });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'PEER_CLEARANCE_NOT_COORDINATOR');
  });

  it('404s a sequenceId that does not belong to the named project (NOT_FOUND)', async () => {
    const held = fixture.launchInRecovery(env);
    const coordinator = coordinatorProject('project-manager');
    const res = await sendAs(server, 'POST', URL_FOR(held.project.name),
      { ...held.binding, sequenceId: held.binding.sequenceId + 999999 }, { ...FRESH, ...coordinator.binding.headers });
    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'NOT_FOUND');
  });
});
