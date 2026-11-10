'use strict';

// v6 Stage 1 (#1149 V6-02, #2977 V6-03, #2978 V6-04 + BRIDGE-1a): the v80→v81
// unified schema migration plus lib/v6/authority-service.js,
// lib/v6/transition-ledger.js, and lib/v6/incident-registry.js — ported
// near-verbatim from PRR-A's tested Phase 6 bundle
// (v6-phase6-stage1-pr-ready-bundles-and-migration-verifier.md) and INT's
// Phase 10 bundle (v6-g1-schema.js), against this repo's real
// lib/project-authority-settings.js (32 keys) and a real node:sqlite-backed
// store, not the bundles' own isolated in-memory fixtures.
//
// Still does not test lib/v6/c1-logical-projects.js's or
// lib/v6/e5-kaizen-ledger.js's own lifecycle/service behavior — PM Ruling
// (LANE_QUEUE.md revision 1621, Charter A512) assigns that to Car
// V60-T1-W1-D (BRIDGE-1b)'s own test/v6-c1-logical-projects.test.js and
// test/v6-e5-kaizen-ledger.test.js. This file's one BRIDGE-1b-touching
// assertion (below) only checks that those tables EXIST once both halves
// of v81 are installed (PM Ruling / Architect Ruling
// A533-W1D-SCOPE-COSIGN-R2, 2026-11-10) — it originally asserted their
// ABSENCE, back when only BRIDGE-1a had landed.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authorityService = require('../lib/v6/authority-service');
const transitionLedger = require('../lib/v6/transition-ledger');
const incidentRegistry = require('../lib/v6/incident-registry');
const { OPERATOR_AUTHORITY_SETTINGS } = require('../lib/project-authority-settings');

const STAGE1_TABLES = [
  'trusted_workspaces', 'trusted_memberships', 'trusted_project_workspaces',
  'trusted_principals', 'trusted_capability_grants', 'project_authority_policies',
  'project_authority_imports', 'project_authority_policy_events', 'runtime_resources',
  'runtime_transitions', 'operation_idempotency', 'runtime_observations',
  'reconciliation_findings', 'runtime_incidents', 'incident_evidence',
  'remediation_attempts', 'recovery_circuit_state', 'v6_g1_leases', 'v6_g1_approvals'
];
const BEFORE_VERSION = 80;

let tmpDir = null;

/**
 * Start a store on a fresh temporary directory.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-stage1-schema-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

/**
 * Close and reopen the store on the same directory, running any pending migration.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function reopen() {
  store.close();
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Set<string>}
 */
function existingTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

/**
 * Take a current store back to what it looked like before this migration.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function backToBefore(db) {
  for (const table of STAGE1_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
  db.exec(`INSERT INTO schema_version (version) SELECT ${BEFORE_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${BEFORE_VERSION})`);
}

/**
 * Seed a project row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{name?: string, path: string}} args
 * @returns {number} The project id.
 */
function seedProject(db, { name = `proj-${crypto.randomUUID()}`, path: projectPath }) {
  return db.prepare('INSERT INTO projects (name, path) VALUES (?,?)').run(name, projectPath).lastInsertRowid;
}

/**
 * Seed a workspace, a user, membership, and a trusted `user` principal scoped to one project.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, role?: string}} args
 * @returns {string} The principal id.
 */
function seedUserPrincipal(db, { projectId, role = 'owner' }) {
  const now = new Date().toISOString();
  // One workspace per project (trusted_project_workspaces.project_id is a PK) —
  // reuse it across multiple principals seeded for the same project instead of
  // colliding on a second insert.
  let wsId = db.prepare('SELECT workspace_id FROM trusted_project_workspaces WHERE project_id = ?').get(projectId)?.workspace_id;
  if (!wsId) {
    wsId = `ws-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsId, now);
    db.prepare('INSERT INTO trusted_project_workspaces (project_id, workspace_id) VALUES (?,?)').run(projectId, wsId);
  }
  const userId = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(`u-${crypto.randomUUID()}`, 'x').lastInsertRowid;
  db.prepare('INSERT INTO trusted_memberships (workspace_id, user_id, role, granted_at) VALUES (?,?,?,?)').run(wsId, userId, role, now);
  const principalId = `principal-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, user_id, created_at) VALUES (?,?,?,?,?)')
    .run(principalId, 'user', wsId, userId, now);
  return principalId;
}

describe('v6 Stage 1 schema v80→v81 migration (#1149, #2977, #2978, BRIDGE-1a)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every Stage 1 table at the current version', () => {
    const db = freshStore();
    const existing = existingTables(db);
    for (const table of STAGE1_TABLES) assert.ok(existing.has(table), `missing ${table}`);
  });

  it('a v80 store gains every Stage 1 table through the migration', () => {
    const db = freshStore();
    backToBefore(db);
    const before = existingTables(db);
    for (const table of STAGE1_TABLES) assert.ok(!before.has(table), `${table} should not exist pre-migration`);
    const migrated = reopen();
    const after = existingTables(migrated);
    for (const table of STAGE1_TABLES) assert.ok(after.has(table), `missing ${table} after migration`);
    const version = migrated.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    assert.ok(version >= 81);
  });

  // BRIDGE-1b (Car V60-T1-W1-D, #2118 & #2980) landed its own C1 hierarchy
  // and Kaizen Ledger tables in a SEPARATE PR, sequenced after this one —
  // this block originally asserted their ABSENCE, to catch BRIDGE-1a
  // accidentally encroaching on BRIDGE-1b's own scope before it shipped.
  // Now that both halves of v81 are on main (PM Ruling / Architect Ruling
  // A533-W1D-SCOPE-COSIGN-R2, 2026-11-10), the guard's job is done and its
  // assertion direction flips: these tables are now a REQUIRED part of a
  // fresh v81 install, not a forbidden one. The speculative table names an
  // early plan draft used before `v81-up.sql` was finalized ('fleets',
  // 'resource_modules', 'role_leases', 'worktrees', 'asset_grants' — none
  // ever real; BRIDGE-1b's actual names are the `v6_`-prefixed ones below)
  // remain a negative check, documenting that nobody built a second table
  // under the old guessed name.
  it('the BRIDGE-1b C1 hierarchy and Kaizen Ledger tables exist at v81, and no table exists under an early draft\'s guessed name', () => {
    const db = freshStore();
    const existing = existingTables(db);
    for (const table of [
      'v6_logical_projects', 'v6_fleets', 'v6_resources', 'v6_checkouts', 'v6_legacy_project_map',
      'v6_role_leases', 'v6_shared_assets', 'v6_asset_grants', 'v6_authority_grants',
      'kaizen_items', 'kaizen_measurements'
    ]) {
      assert.ok(existing.has(table), `missing BRIDGE-1b table ${table}`);
    }
    for (const table of ['fleets', 'resource_modules', 'role_leases', 'worktrees', 'asset_grants']) {
      assert.ok(!existing.has(table), `${table} was never a real BRIDGE-1b table name`);
    }
  });
});

describe('lib/v6/authority-service.js (#1149, V6-02)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('KEYS matches the real, live project-authority-settings registry exactly', () => {
    assert.deepEqual(authorityService.KEYS, Object.keys(OPERATOR_AUTHORITY_SETTINGS));
    assert.equal(authorityService.KEYS.length, 32);
  });

  it('backfillProject imports every key from a project with no legacy file', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    const result = authorityService.backfillProject(db, projectId);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'IMPORTED');
    assert.equal(result.count, authorityService.KEYS.length);
    const rowCount = db.prepare('SELECT COUNT(*) n FROM project_authority_policies WHERE project_id = ?').get(projectId).n;
    assert.equal(rowCount, authorityService.KEYS.length);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('backfillProject blocks an unverified fleetCoordinator:true file flag', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({ fleetCoordinator: true }));
    const projectId = seedProject(db, { path: projectDir });
    const result = authorityService.backfillProject(db, projectId);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'IMPORTED_BLOCKED');
    assert.deepEqual(result.discrepancies, [{ settingKey: 'fleetCoordinator', code: 'UNVERIFIED_FLEET_FLAG', legacyFileValue: true }]);
    assert.equal(authorityService.getEffective(db, projectId, 'fleetCoordinator').value, false);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('backfillProject imports fleetCoordinator:true when an operator-created active project-manager role proves it', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({ fleetCoordinator: true }));
    const projectId = seedProject(db, { path: projectDir });
    db.prepare("INSERT INTO coordinator_roles (role_id, project_id, role, status, authority_version, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(`role-${crypto.randomUUID()}`, projectId, 'project-manager', 'active', 1, 'operator', new Date().toISOString());
    const result = authorityService.backfillProject(db, projectId);
    assert.equal(result.ok, true);
    assert.equal(authorityService.getEffective(db, projectId, 'fleetCoordinator').value, true);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('backfillProject refuses to re-import an already-blocked project', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({ fleetCoordinator: true }));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    const again = authorityService.backfillProject(db, projectId);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'IMPORT_BLOCKED');
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('getEffective fails closed for an unregistered or missing-policy setting', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    assert.equal(authorityService.getEffective(db, projectId, 'notARealSetting').code, 'UNREGISTERED_SETTING');
    assert.equal(authorityService.getEffective(db, projectId, 'engine').code, 'POLICY_MISSING');
  });

  it('getEffective delegates recoveryMode to the existing recovery pin resolver', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    db.prepare('INSERT INTO project_recovery_state (project_id, pinned_mode, pinned_at, pinned_by) VALUES (?,?,?,?)')
      .run(projectId, 'operator', new Date().toISOString(), 'op');
    const answer = authorityService.getEffective(db, projectId, 'launchSequence.recoveryMode');
    assert.equal(answer.ok, true);
    assert.equal(answer.value, 'operator');
    assert.equal(answer.source, 'existing-recovery-pin-resolver');
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('detectDrift reports FILE_TAMPER when the file disagrees with the imported policy', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({ silentPrime: true }));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({ silentPrime: false }));
    const drift = authorityService.detectDrift(db, projectId);
    assert.deepEqual(drift, [{ code: 'FILE_TAMPER', settingKey: 'silentPrime' }]);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('detectDrift reports no drift when the file still matches', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    assert.deepEqual(authorityService.detectDrift(db, projectId), []);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('detectDrift reports FILE_UNREADABLE rather than throwing on a corrupt file', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), '{not json');
    const drift = authorityService.detectDrift(db, projectId);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].code, 'FILE_UNREADABLE');
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('setPolicy CAS-updates fleetCoordinator under operator proof and records an event', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    const principalId = seedUserPrincipal(db, { projectId });
    const auth = authorityService.createAuthorizationService(db);
    const before = authorityService.getEffective(db, projectId, 'fleetCoordinator');
    const result = authorityService.setPolicy(db, {
      projectId, key: 'fleetCoordinator', value: true, expectedVersion: before.rowVersion,
      principalId, requestId: 'req-1', auth, operatorProof: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'UPDATED');
    assert.equal(authorityService.getEffective(db, projectId, 'fleetCoordinator').value, true);
    const events = db.prepare('SELECT COUNT(*) n FROM project_authority_policy_events WHERE project_id = ?').get(projectId).n;
    assert.equal(events, 1);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('setPolicy refuses a stale expectedVersion and an operator-pinned write without proof', () => {
    const db = freshStore();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-'));
    const projectId = seedProject(db, { path: projectDir });
    authorityService.backfillProject(db, projectId);
    const principalId = seedUserPrincipal(db, { projectId });
    const auth = authorityService.createAuthorizationService(db);
    const stale = authorityService.setPolicy(db, {
      projectId, key: 'fleetCoordinator', value: true, expectedVersion: 999,
      principalId, requestId: 'req-1', auth, operatorProof: true
    });
    assert.equal(stale.code, 'STALE_POLICY');
    const before = authorityService.getEffective(db, projectId, 'fleetCoordinator');
    const noProof = authorityService.setPolicy(db, {
      projectId, key: 'fleetCoordinator', value: true, expectedVersion: before.rowVersion,
      principalId, requestId: 'req-2', auth
    });
    assert.equal(noProof.code, 'OPERATOR_PROOF_REQUIRED');
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('setPolicy refuses every key but fleetCoordinator, and refuses the recovery pin', () => {
    const db = freshStore();
    const result = authorityService.setPolicy(db, {
      projectId: 1, key: 'engine', value: 'claude', expectedVersion: 1, principalId: 'x', requestId: 'r', auth: { authorize: () => ({ allowed: true }) }
    });
    assert.equal(result.code, 'POLICY_VALIDATOR_REQUIRED');
  });

  it('createAuthorizationService allows an owner to write policy, denies a plain member, and default-denies an unknown principal', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const memberId = seedUserPrincipal(db, { projectId, role: 'member' });
    const auth = authorityService.createAuthorizationService(db);
    assert.equal(auth.authorize(ownerId, 'project.writePolicy', { type: 'project', id: projectId }).allowed, true);
    assert.equal(auth.authorize(memberId, 'project.writePolicy', { type: 'project', id: projectId }).allowed, false);
    assert.equal(auth.authorize(memberId, 'project.readPolicy', { type: 'project', id: projectId }).allowed, true);
    // An unknown-but-present-looking principal id fails at the DB lookup
    // (SCOPE_DENIED), not the structural check — DEFAULT_DENY is reserved for
    // a missing/empty principal, an unrecognized action, or an invalid ref.
    assert.equal(auth.authorize('nobody', 'project.writePolicy', { type: 'project', id: projectId }).code, 'SCOPE_DENIED');
    assert.equal(auth.authorize(ownerId, 'not.a.real.action', { type: 'project', id: projectId }).code, 'DEFAULT_DENY');
    assert.equal(auth.authorize('', 'project.writePolicy', { type: 'project', id: projectId }).code, 'DEFAULT_DENY');
  });

  it('mintLease/revokeLease and mintApproval/revokeApproval round-trip for an authorized owner', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const lease = authorityService.mintLease(db, {
      principalId: ownerId, auth, projectId, actor: 'agent:1', repo: 'o/r', connectionEpoch: 1,
      actions: ['issues:write'], ttlMs: 3600000
    });
    assert.equal(lease.ok, true);
    assert.equal(lease.code, 'MINTED');
    assert.equal(authorityService.revokeLease(db, { principalId: ownerId, auth, projectId, leaseId: lease.id }).code, 'REVOKED');
    assert.equal(authorityService.revokeLease(db, { principalId: ownerId, auth, projectId, leaseId: lease.id }).code, 'NOT_FOUND_OR_ALREADY_REVOKED');

    const approval = authorityService.mintApproval(db, {
      principalId: ownerId, auth, projectId, operatorActor: 'op:distinct', action: 'createMilestone',
      repo: 'o/r', targetDigest: 'sha256:abc', ttlMs: 3600000
    });
    assert.equal(approval.ok, true);
    assert.equal(authorityService.revokeApproval(db, { principalId: ownerId, auth, projectId, approvalId: approval.id }).code, 'REVOKED');
  });

  it('ACTIONS names every action createAuthorizationService and the lease/approval mint/revoke surface recognize', () => {
    for (const action of ['runtime.readOperation', 'runtime.readFinding', 'runtime.readIncident',
      'runtime.createTransition', 'runtime.reconcile', 'runtime.recover', 'project.readPolicy',
      'project.writePolicy', 'g1.mintLease', 'g1.revokeLease', 'g1.mintApproval', 'g1.revokeApproval']) {
      assert.ok(authorityService.ACTIONS.has(action), `ACTIONS should recognize ${action}`);
    }
    assert.equal(authorityService.ACTIONS.has('not.a.real.action'), false);
  });

  it('backfillAll backfills every existing project, in id order', () => {
    const db = freshStore();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-b-'));
    const idA = seedProject(db, { path: dirA });
    const idB = seedProject(db, { path: dirB });
    const results = authorityService.backfillAll(db);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.code), ['IMPORTED', 'IMPORTED']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM project_authority_policies WHERE project_id = ?').get(idA).n, authorityService.KEYS.length);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM project_authority_policies WHERE project_id = ?').get(idB).n, authorityService.KEYS.length);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('createVerifiedPrincipalResolver maps a verified project-scoped launch to its agent principal, an operator session to its user principal, and anything else to null', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const wsId = `ws-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO trusted_workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsId, now);
    db.prepare('INSERT INTO trusted_project_workspaces (project_id, workspace_id) VALUES (?,?)').run(projectId, wsId);
    const userId = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(`u-${crypto.randomUUID()}`, 'x').lastInsertRowid;
    const sessionId = db.prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?,?)').run(projectId, 'claude').lastInsertRowid;
    const operatorPrincipalId = `principal-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, user_id, created_at) VALUES (?,?,?,?,?)')
      .run(operatorPrincipalId, 'user', wsId, userId, now);
    const agentPrincipalId = `principal-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, project_id, session_id, initiating_principal_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(agentPrincipalId, 'agent', wsId, projectId, sessionId, operatorPrincipalId, now);

    const resolveProjectResolver = authorityService.createVerifiedPrincipalResolver(db, () => ({ kind: 'project', sessionId, projectId }));
    assert.equal(resolveProjectResolver({}), agentPrincipalId);

    const resolveOperatorResolver = authorityService.createVerifiedPrincipalResolver(db, () => ({ kind: 'operator' }));
    assert.equal(resolveOperatorResolver({ tcSession: { userId } }), operatorPrincipalId);

    const resolveUnbound = authorityService.createVerifiedPrincipalResolver(db, () => ({ kind: 'unbound' }));
    assert.equal(resolveUnbound({}), null);
  });

  it('mintLease refuses a plain member and an invalid request', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const memberId = seedUserPrincipal(db, { projectId, role: 'member' });
    const auth = authorityService.createAuthorizationService(db);
    const denied = authorityService.mintLease(db, {
      principalId: memberId, auth, projectId, actor: 'agent:1', repo: 'o/r', connectionEpoch: 1, actions: ['issues:write'], ttlMs: 1000
    });
    assert.equal(denied.code, 'ROLE_DENIED');
    const invalid = authorityService.mintLease(db, { principalId: memberId, auth, projectId, actor: '', repo: 'o/r', connectionEpoch: 1, actions: [], ttlMs: 0 });
    assert.equal(invalid.code, 'INVALID_REQUEST');
  });
});

describe('lib/v6/transition-ledger.js (#2977, V6-03)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function seedResource(db, projectId, generation = 0) {
    const id = `res-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO runtime_resources (id, project_id, generation) VALUES (?,?,?)').run(id, projectId, generation);
    return id;
  }

  it('requests a transition, replays an identical request, and refuses a conflicting one under the same key', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const resourceId = seedResource(db, projectId, 0);
    const ledger = transitionLedger.createRuntimeTransitions(db, auth);
    const args = { principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 0, key: 'req-1' };
    const first = ledger.request(args);
    assert.equal(first.code, 'PENDING');
    const replay = ledger.request(args);
    assert.equal(replay.code, 'DEDUP');
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transition.id, first.id);
    assert.equal(replay.transition.state, 'pending');
    const conflict = ledger.request({ ...args, detail: { different: true } });
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('a replay after the original transition has committed returns the full, current receipt, not a bare {status, id} (PRR-A R1, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const resourceId = seedResource(db, projectId, 0);
    const ledger = transitionLedger.createRuntimeTransitions(db, auth);
    const args = { principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 0, key: 'req-committed' };
    const { id } = ledger.request(args);
    ledger.settle({ principalId: ownerId, projectId, id, state: 'committed', evidence: { source: 'tmux', observedAt: new Date().toISOString() } });
    const replay = ledger.request(args);
    assert.equal(replay.ok, true);
    assert.equal(replay.code, 'DEDUP');
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, id);
    assert.equal(replay.transition.state, 'committed');
    assert.equal(replay.transition.target_generation, 1);
  });

  it('refuses a stale generation and an in-flight resource', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const resourceId = seedResource(db, projectId, 2);
    const ledger = transitionLedger.createRuntimeTransitions(db, auth);
    const stale = ledger.request({ principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 0, key: 'req-stale' });
    assert.equal(stale.code, 'STALE_GENERATION');
    ledger.request({ principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 2, key: 'req-open' });
    const inFlight = ledger.request({ principalId: ownerId, projectId, resourceId, action: 'wrap', expectedGeneration: 2, key: 'req-other' });
    assert.equal(inFlight.code, 'IN_FLIGHT');
  });

  it('settle(committed) bumps the resource generation under CAS; settle requires evidence and absence proof for unknown→failed', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const resourceId = seedResource(db, projectId, 0);
    const ledger = transitionLedger.createRuntimeTransitions(db, auth);
    const { id } = ledger.request({ principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 0, key: 'req-1' });
    const noEvidence = ledger.settle({ principalId: ownerId, projectId, id, state: 'committed', evidence: null });
    assert.equal(noEvidence.code, 'EVIDENCE_REQUIRED');
    const committed = ledger.settle({ principalId: ownerId, projectId, id, state: 'committed', evidence: { source: 'tmux', observedAt: new Date().toISOString() } });
    assert.equal(committed.code, 'COMMITTED');
    const generation = db.prepare('SELECT generation FROM runtime_resources WHERE id = ?').get(resourceId).generation;
    assert.equal(generation, 1);
    const terminal = ledger.settle({ principalId: ownerId, projectId, id, state: 'failed', evidence: { source: 'tmux', observedAt: new Date().toISOString() } });
    assert.equal(terminal.code, 'TERMINAL');
  });

  it('settle(unknown→failed) requires absenceProven', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const resourceId = seedResource(db, projectId, 0);
    const ledger = transitionLedger.createRuntimeTransitions(db, auth);
    const { id } = ledger.request({ principalId: ownerId, projectId, resourceId, action: 'launch', expectedGeneration: 0, key: 'req-1' });
    ledger.settle({ principalId: ownerId, projectId, id, state: 'unknown', evidence: { source: 'tmux', observedAt: new Date().toISOString() } });
    const withoutProof = ledger.settle({ principalId: ownerId, projectId, id, state: 'failed', evidence: { source: 'tmux', observedAt: new Date().toISOString() } });
    assert.equal(withoutProof.code, 'ABSENCE_REQUIRED');
    const withProof = ledger.settle({ principalId: ownerId, projectId, id, state: 'failed', evidence: { source: 'tmux', observedAt: new Date().toISOString(), absenceProven: true } });
    assert.equal(withProof.code, 'FAILED');
  });

  it('SURFACES names the five planes reconcile probes, in the order a probe map must supply them', () => {
    assert.deepEqual(transitionLedger.SURFACES, ['sqlite', 'tmux', 'git', 'ports', 'medusa']);
  });

  it('reconcile is safe only when every surface answers ok with no findings, and persistFindings writes open rows', async () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const allOk = await transitionLedger.reconcile({ id: 'res-1' }, {
      sqlite: () => ({ status: 'ok', active: true, head: 'abc' }),
      tmux: () => ({ status: 'ok' }),
      git: () => ({ status: 'ok', head: 'abc' }),
      ports: () => ({ status: 'ok', owner: 'res-1' }),
      medusa: () => ({ status: 'ok', pending: 0 })
    });
    assert.equal(allOk.safe, true);
    assert.deepEqual(allOk.findings, []);

    const divergent = await transitionLedger.reconcile({ id: 'res-1' }, {
      sqlite: () => ({ status: 'ok', active: true, head: 'abc' }),
      tmux: () => ({ status: 'missing' }),
      git: () => ({ status: 'ok', head: 'different' }),
      ports: () => ({ status: 'ok', owner: 'someone-else' }),
      medusa: () => { throw new Error('boom'); }
    });
    assert.equal(divergent.safe, false);
    const codes = divergent.findings.map((f) => f.code).sort();
    assert.deepEqual(codes, ['ACTIVE_TMUX_MISSING', 'HEAD_DIVERGED', 'LEASE_OWNER_MISMATCH', 'PROBE_UNKNOWN'].sort());

    const written = transitionLedger.persistFindings(db, projectId, 'res-1', divergent);
    assert.equal(written, divergent.findings.length);
    const rows = db.prepare("SELECT COUNT(*) n FROM reconciliation_findings WHERE project_id = ? AND state = 'open'").get(projectId).n;
    assert.equal(rows, divergent.findings.length);
  });
});

describe('lib/v6/incident-registry.js (#2978, V6-04)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a healthy first-ever report for a fingerprint creates zero runtime_incidents rows (PRR-A R1, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const result = incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-1', generation: 1, action: 'noop', health: 'healthy' });
    assert.equal(result.code, 'HEALTHY_NO_ACTION');
    assert.equal(result.id, null);
    const incidentRows = db.prepare('SELECT COUNT(*) n FROM runtime_incidents WHERE project_id = ? AND fingerprint = ?').get(projectId, 'fp-1').n;
    assert.equal(incidentRows, 0);
    const evidenceRows = db.prepare('SELECT COUNT(*) n FROM incident_evidence').get().n;
    assert.equal(evidenceRows, 0);
  });

  it('a healthy report against an EXISTING incident (recovery) still records evidence and returns its real id', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const unhealthy = incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-recover', generation: 1, action: 'restart', health: 'unhealthy' });
    assert.notEqual(unhealthy.id, null);
    const healthy = incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-recover', generation: 1, action: 'noop', health: 'healthy' });
    assert.equal(healthy.code, 'HEALTHY_NO_ACTION');
    assert.equal(healthy.id, unhealthy.id);
    const attempts = db.prepare('SELECT COUNT(*) n FROM remediation_attempts WHERE incident_id = ?').get(healthy.id).n;
    assert.equal(attempts, 1); // from the earlier unhealthy step only; the healthy step attempts no recovery
    const evidenceRows = db.prepare('SELECT COUNT(*) n FROM incident_evidence WHERE incident_id = ?').get(healthy.id).n;
    assert.equal(evidenceRows, 2); // one per step
  });

  it('redacts a bare Bearer/ghp_/tc_master_ token value with no adjacent token/secret keyword (PRR-A R1, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    // A fresh fingerprint's first report must be unhealthy to get an incident_evidence row
    // at all (a healthy first report creates none, per the regression test above).
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-secret', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: { note: 'saw Bearer ghp_EXAMPLE_SECRET_12345 and tc_master_EXAMPLE_SECRET_12345 in the log' }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('ghp_EXAMPLE_SECRET_12345'), 'ghp_ token leaked unredacted');
    assert.ok(!row.payload_json.includes('tc_master_EXAMPLE_SECRET_12345'), 'tc_master_ token leaked unredacted');
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('redacts X-TangleClaw-Launch-Id, TANGLECLAW_LAUNCH_ID=, tc_launch_ and tc_hb_ values (PRR-A R2, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-secret-2', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: {
        headers: 'X-TangleClaw-Launch-Id: opaque-value-12345',
        env: 'TANGLECLAW_LAUNCH_ID=opaque-value-12345',
        note: 'saw tc_launch_ABCdef1234567890 and tc_hb_ABCdef1234567890 in the log'
      }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('opaque-value-12345'), 'launch id leaked unredacted');
    assert.ok(!row.payload_json.includes('tc_launch_ABCdef1234567890'), 'tc_launch_ token leaked unredacted');
    assert.ok(!row.payload_json.includes('tc_hb_ABCdef1234567890'), 'tc_hb_ token leaked unredacted');
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('redacts a generic x-tangleclaw-* header, AWS/Slack/Google key shapes, and ANTHROPIC_API_KEY=/OPENAI_API_KEY= (Arc Ruling A520, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-secret-3', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: {
        header: 'x-tangleclaw-session-proof: opaque-proof-value', // a header this module has no dedicated pattern for by name
        aws: 'AKIAABCDEFGHIJKLMNOP',
        slack: 'xoxb-1234567890-abcdefghij',
        google: 'AIza' + 'A'.repeat(35),
        anthropic: 'ANTHROPIC_API_KEY=sk-ant-EXAMPLE',
        openai: 'OPENAI_API_KEY=sk-EXAMPLE1234567890'
      }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('opaque-proof-value'), 'generic x-tangleclaw-* header value leaked unredacted');
    assert.ok(!row.payload_json.includes('AKIAABCDEFGHIJKLMNOP'), 'AWS key leaked unredacted');
    assert.ok(!row.payload_json.includes('xoxb-1234567890-abcdefghij'), 'Slack token leaked unredacted');
    assert.ok(!row.payload_json.includes('AIza' + 'A'.repeat(35)), 'Google API key leaked unredacted');
    assert.ok(!row.payload_json.includes('sk-ant-EXAMPLE'), 'ANTHROPIC_API_KEY value leaked unredacted');
    assert.ok(!row.payload_json.includes('sk-EXAMPLE1234567890'), 'OPENAI_API_KEY value leaked unredacted');
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('redacts a full multiline PEM private-key block and a Discord webhook URL (PM Ruling, PR #3008 R5)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEEXAMPLEKEYBODYDATAHERE\nMORELINESOFBASE64EXAMPLE\n-----END RSA PRIVATE KEY-----';
    const webhook = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-ExampleToken_123';
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-secret-4', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: { key: pem, hook: `posted to ${webhook}` }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('MIIEEXAMPLEKEYBODYDATAHERE'), 'PEM key body leaked unredacted');
    assert.ok(!row.payload_json.includes('MORELINESOFBASE64EXAMPLE'), 'PEM key body leaked unredacted');
    assert.ok(!row.payload_json.includes('-----BEGIN RSA PRIVATE KEY-----'), 'PEM header leaked unredacted');
    assert.ok(!row.payload_json.includes('AbCdEf-ExampleToken_123'), 'Discord webhook token leaked unredacted');
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('redacts a PEM private-key block with no END marker (truncated capture) through to end of string (Arc Ruling A523, PR #3008)', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const truncated = '-----BEGIN RSA PRIVATE KEY-----\nMIIEEXAMPLEKEYBODYDATAHERE\nMORELINESOFBASE64EXAMPLE'; // no END line
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-secret-5', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: { note: truncated }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('MIIEEXAMPLEKEYBODYDATAHERE'), 'truncated PEM key body leaked unredacted');
    assert.ok(!row.payload_json.includes('MORELINESOFBASE64EXAMPLE'), 'truncated PEM key body leaked unredacted');
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('refuses a reserved action outright', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    for (const action of incidentRegistry.RESERVED) {
      const result = incidents.step({ principalId: ownerId, projectId, fingerprint: `fp-${action}`, generation: 1, action, health: 'unhealthy' });
      assert.equal(result.code, 'RESERVED_ACTION');
    }
  });

  it('an unhealthy step with a fresh, matching, healthy verification is VERIFIED', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    let clock = 1000;
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth, { clock: () => clock });
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-2', generation: 1, action: 'restart', health: 'unhealthy',
      verification: { generation: 1, observedAt: clock + 1, healthy: true, source: 'probe' }
    });
    assert.equal(result.code, 'VERIFIED');
    const incident = db.prepare('SELECT state FROM runtime_incidents WHERE id = ?').get(result.id);
    assert.equal(incident.state, 'resolved');
  });

  it('two failed attempts open the circuit, and a third within the backoff window is refused', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    let clock = 1000;
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth, { clock: () => clock });
    const step = () => incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-3', generation: 1, action: 'restart', health: 'unhealthy' });
    const first = step();
    assert.equal(first.code, 'ATTEMPT_FAILED');
    const second = step();
    assert.equal(second.code, 'CIRCUIT_OPEN');
    const third = step();
    assert.equal(third.code, 'BACKOFF');
    clock += 2000;
    const fourth = step();
    assert.equal(fourth.code, 'MAX_ATTEMPTS');
  });

  it('refuses a stale-generation step against an open incident', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-4', generation: 1, action: 'restart', health: 'unhealthy' });
    const stale = incidents.step({ principalId: ownerId, projectId, fingerprint: 'fp-4', generation: 2, action: 'restart', health: 'unhealthy' });
    assert.equal(stale.code, 'STALE_INCIDENT');
  });

  it('redacts secret-shaped keys and values from persisted evidence', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const ownerId = seedUserPrincipal(db, { projectId, role: 'owner' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    // unhealthy, not healthy: a healthy first-ever report for a fingerprint
    // creates no incident/evidence row at all (see the dedicated regression
    // test above), so this key-name-based redaction case needs a real row.
    const result = incidents.step({
      principalId: ownerId, projectId, fingerprint: 'fp-5', generation: 1, action: 'noop', health: 'unhealthy',
      evidence: { apiKey: 'should-be-gone', note: 'token: abc123 in a log line' }
    });
    const row = db.prepare('SELECT payload_json FROM incident_evidence WHERE incident_id = ?').get(result.id);
    assert.ok(!row.payload_json.includes('should-be-gone'));
    assert.ok(!row.payload_json.includes('abc123'));
    assert.ok(row.payload_json.includes('[REDACTED]'));
  });

  it('denies a step from an unauthorized principal', () => {
    const db = freshStore();
    const projectId = seedProject(db, { path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-project-')) });
    const memberId = seedUserPrincipal(db, { projectId, role: 'member' });
    const auth = authorityService.createAuthorizationService(db);
    const incidents = incidentRegistry.createRuntimeIncidents(db, auth);
    const result = incidents.step({ principalId: memberId, projectId, fingerprint: 'fp-6', generation: 1, action: 'restart', health: 'unhealthy' });
    assert.equal(result.code, 'ROLE_DENIED');
  });
});
