'use strict';

// v6.1 (#2991, V6-20 / A2b, Car V61-W1-A): the bounded self-healing
// remediation executor, its four-state recovery circuit (closed / open /
// half-open on the shared v81 recovery_circuit_state table, plus the
// module-owned operator latch), and the Recovery Console read model —
// against a real node:sqlite-backed store migrated to the current schema,
// with a real AuthorizationService, not a stubbed one.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authorityService = require('../lib/v6/authority-service');
const a2b = require('../lib/v6/a2b-self-healing-remediator');

let tmpDir = null;
let db = null;
let auth = null;
let projectId = null;
let ownerId = null;
let memberId = null;
let now = 1_000_000;

/** @returns {number} The fake clock's current time. */
const clock = () => now;

/**
 * Seed a workspace-scoped user principal for the test project.
 * @param {string} role
 * @param {string} wsId
 * @returns {string}
 */
function seedUser(role, wsId) {
  const stamp = new Date().toISOString();
  const userId = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(`u-${crypto.randomUUID()}`, 'x').lastInsertRowid;
  db.prepare('INSERT INTO trusted_memberships (workspace_id, user_id, role, granted_at) VALUES (?,?,?,?)').run(wsId, userId, role, stamp);
  const id = `principal-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, user_id, created_at) VALUES (?,?,?,?,?)').run(id, 'user', wsId, userId, stamp);
  return id;
}

/**
 * Open a fresh store and seed one project, an owner, a plain member, and
 * the recovery service principal holding exactly a `runtime.recover` grant.
 * @returns {void}
 */
function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-a2b-'));
  store._setBasePath(tmpDir);
  store.init();
  db = store.getDb();
  now = 1_000_000;
  projectId = db.prepare('INSERT INTO projects (name, path) VALUES (?,?)').run(`p-${crypto.randomUUID()}`, path.join(tmpDir, 'p')).lastInsertRowid;
  const stamp = new Date().toISOString();
  const wsId = `ws-${crypto.randomUUID()}`;
  db.prepare('INSERT INTO trusted_workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsId, stamp);
  db.prepare('INSERT INTO trusted_project_workspaces (project_id, workspace_id) VALUES (?,?)').run(projectId, wsId);
  ownerId = seedUser('owner', wsId);
  memberId = seedUser('member', wsId);
  db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, created_at) VALUES (?,?,?,?)').run(a2b.RECOVERY_PRINCIPAL, 'service', wsId, stamp);
  db.prepare('INSERT INTO trusted_capability_grants (id, principal_id, action, resource_type, resource_id, granted_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), a2b.RECOVERY_PRINCIPAL, 'runtime.recover', 'project', String(projectId), ownerId, stamp);
  auth = authorityService.createAuthorizationService(db);
}

/**
 * Insert an open incident for the test project.
 * @param {string} [fingerprint]
 * @returns {string} The incident id.
 */
function openIncident(fingerprint = `fp-${crypto.randomUUID()}`) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO runtime_incidents (id, project_id, fingerprint, state, generation, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, projectId, fingerprint, 'open', 1, new Date(now).toISOString());
  return id;
}

/** An executor that reports a fresh healthy observation. */
const healthy = async () => ({ verification: { healthy: true, observedAt: now + 1, source: 'probe:medusa-roster' } });
/** An executor whose repair did not take. */
const unhealthy = async () => ({ verification: { healthy: false, observedAt: now + 1, source: 'probe:medusa-roster' } });

beforeEach(setup);
afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureSchema (#2991)', () => {
  it('creates the latch table idempotently and leaves the shared v81 tables alone', () => {
    a2b.ensureSchema(db);
    a2b.ensureSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(names.includes('v6_a2b_recovery_latches'));
    assert.ok(names.includes('recovery_circuit_state'));
    assert.ok(names.includes('remediation_attempts'));
  });
});

describe('remediate — allowlist and non-escalation (#2991)', () => {
  it('refuses every forbidden action by name, before any executor or DB work', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { merge: healthy }, clock });
    const incidentId = openIncident();
    for (const action of ['merge', 'release', 'delete-branch', 'delete-project', 'alter-credentials', 'raise-authority-tier']) {
      assert.equal((await r.remediate({ projectId, incidentId, remediation: action })).code, 'FORBIDDEN_ACTION', action);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM remediation_attempts').get().n, 0);
  });

  it('refuses a remediation not on the allowlist, including prototype-chain names', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { 'restart-everything': healthy }, clock });
    const incidentId = openIncident();
    assert.equal((await r.remediate({ projectId, incidentId, remediation: 'restart-everything' })).code, 'REMEDIATION_NOT_ALLOWED');
    assert.equal((await r.remediate({ projectId, incidentId, remediation: '__proto__' })).code, 'REMEDIATION_NOT_ALLOWED');
    assert.equal((await r.remediate({ projectId, incidentId, remediation: 'toString' })).code, 'REMEDIATION_NOT_ALLOWED');
  });

  it('allowlists exactly the three non-destructive repairs #2991 names', () => {
    assert.deepEqual(Object.keys(a2b.REMEDIATIONS).sort(), ['medusa-listener-rebind', 'ttyd-orphan-reap', 'wip-snapshot-harness-restart']);
    for (const spec of Object.values(a2b.REMEDIATIONS)) {
      assert.equal(spec.destructive, false);
      assert.ok(spec.maxAttempts <= a2b.MAX_ATTEMPTS_CEILING);
    }
    assert.equal(a2b.DEFAULT_MAX_ATTEMPTS, 2);
  });

  it('refuses when no executor is supplied for an allowlisted repair', async () => {
    const r = a2b.createRemediator(db, auth, { executors: {}, clock });
    assert.equal((await r.remediate({ projectId, incidentId: openIncident(), remediation: 'ttyd-orphan-reap' })).code, 'NO_EXECUTOR');
  });

  it('runs as the recovery principal, and a revoked grant default-denies with no attempt spent', async () => {
    db.prepare('UPDATE trusted_capability_grants SET revoked_at = ? WHERE principal_id = ?').run(new Date().toISOString(), a2b.RECOVERY_PRINCIPAL);
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': healthy }, clock });
    const out = await r.remediate({ projectId, incidentId: openIncident(), remediation: 'ttyd-orphan-reap' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'GRANT_DENIED');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM remediation_attempts').get().n, 0);
  });

  it('refuses an incident that belongs to another project or is not open', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': healthy }, clock });
    assert.equal((await r.remediate({ projectId, incidentId: 'nope', remediation: 'ttyd-orphan-reap' })).code, 'INCIDENT_NOT_FOUND');
    const incidentId = openIncident();
    db.prepare("UPDATE runtime_incidents SET state = 'resolved' WHERE id = ?").run(incidentId);
    assert.equal((await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' })).code, 'INCIDENT_NOT_OPEN');
  });
});

describe('remediate — verification and the circuit (#2991)', () => {
  it('a fresh healthy verification resolves the incident and keeps the circuit closed', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { 'medusa-listener-rebind': healthy }, clock });
    const incidentId = openIncident();
    const out = await r.remediate({ projectId, incidentId, remediation: 'medusa-listener-rebind' });
    assert.equal(out.code, 'VERIFIED');
    assert.equal(out.circuit.state, 'closed');
    assert.equal(db.prepare('SELECT state FROM runtime_incidents WHERE id = ?').get(incidentId).state, 'resolved');
    assert.equal(db.prepare('SELECT outcome FROM remediation_attempts WHERE id = ?').get(out.attemptId).outcome, 'verified');
  });

  it('a stale, sourceless or self-asserted verification never counts as healthy', async () => {
    for (const verification of [
      { healthy: true, observedAt: now - 1, source: 'probe' },
      { healthy: true, observedAt: now + 1, source: '  ' },
      { healthy: 'yes', observedAt: now + 1, source: 'probe' },
      null
    ]) {
      setupFresh();
      const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': async () => ({ verification }) }, clock });
      const out = await r.remediate({ projectId, incidentId: openIncident(), remediation: 'ttyd-orphan-reap' });
      assert.equal(out.code, 'NOT_VERIFIED', JSON.stringify(verification));
      assert.equal(out.circuit.state, 'open');
    }
  });

  it('an executor that throws records an error attempt and opens the circuit', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': async () => { throw new Error('boom'); } }, clock });
    const out = await r.remediate({ projectId, incidentId: openIncident(), remediation: 'ttyd-orphan-reap' });
    assert.equal(out.code, 'EXECUTOR_ERROR');
    assert.equal(db.prepare('SELECT outcome FROM remediation_attempts WHERE id = ?').get(out.attemptId).outcome, 'error');
    assert.equal(out.circuit.state, 'open');
  });

  it('walks closed → open → (backoff) → half-open probe → latched, and never exceeds maxAttempts', async () => {
    let calls = 0;
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': async (...a) => { calls++; return unhealthy(...a); } }, clock });
    const incidentId = openIncident();

    const first = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(first.circuit.state, 'open');
    assert.equal(first.circuit.nextProbeAt, now + a2b.backoffMs(1));

    const early = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(early.code, 'BACKOFF');
    assert.equal(calls, 1);

    now = first.circuit.nextProbeAt;
    let observedDuringProbe = null;
    const probing = a2b.createRemediator(db, auth, {
      executors: { 'ttyd-orphan-reap': async (...a) => { calls++; observedDuringProbe = a2b.circuitState(db, projectId).state; return unhealthy(...a); } },
      clock
    });
    const second = await probing.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(observedDuringProbe, 'half-open');
    assert.equal(second.code, 'LATCHED_AFTER_FAILURE');
    assert.equal(second.circuit.state, 'latched');

    now += a2b.MAX_BACKOFF_MS + 1;
    const third = await probing.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(third.code, 'LATCHED');
    assert.equal(calls, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM remediation_attempts WHERE incident_id = ?').get(incidentId).n, 2);
  });

  it('a successful half-open probe closes the circuit and resets failures', async () => {
    const failing = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': unhealthy }, clock });
    const incidentId = openIncident();
    const first = await failing.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    now = first.circuit.nextProbeAt;
    const fixing = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': healthy }, clock });
    const second = await fixing.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(second.code, 'VERIFIED');
    assert.deepEqual([second.circuit.state, second.circuit.failures], ['closed', 0]);
  });

  it('two concurrent calls cannot both run: the in-flight claim refuses the second', async () => {
    let release;
    const gate = new Promise((res) => { release = res; });
    let calls = 0;
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': async () => { calls++; await gate; return healthy(); } }, clock });
    const incidentId = openIncident();
    const a = r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    const b = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(b.code, 'IN_FLIGHT');
    release();
    assert.equal((await a).code, 'VERIFIED');
    assert.equal(calls, 1);
  });

  it('a crashed attempt left in-flight still spends the budget: a restart cannot get a free retry', async () => {
    const incidentId = openIncident();
    db.prepare('INSERT INTO remediation_attempts (id, incident_id, action, outcome, attempted_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), incidentId, 'ttyd-orphan-reap', 'failed', new Date(now).toISOString());
    db.prepare('INSERT INTO remediation_attempts (id, incident_id, action, outcome, attempted_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), incidentId, 'ttyd-orphan-reap', 'error', new Date(now).toISOString());
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': healthy }, clock });
    const out = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(out.code, 'MAX_ATTEMPTS');
    assert.equal(out.circuit.state, 'latched');
  });

  it('an in-flight row from a crashed process blocks only until it goes stale, then is marked abandoned and counted', async () => {
    const incidentId = openIncident();
    const crashed = crypto.randomUUID();
    db.prepare('INSERT INTO remediation_attempts (id, incident_id, action, outcome, attempted_at) VALUES (?,?,?,?,?)')
      .run(crashed, incidentId, 'ttyd-orphan-reap', 'in-flight', new Date(now).toISOString());
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': healthy }, clock });
    assert.equal((await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' })).code, 'IN_FLIGHT');
    now += a2b.IN_FLIGHT_STALE_MS + 1;
    const out = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(out.code, 'VERIFIED');
    assert.equal(db.prepare('SELECT outcome FROM remediation_attempts WHERE id = ?').get(crashed).outcome, 'abandoned');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM remediation_attempts WHERE incident_id = ?').get(incidentId).n, 2);
  });

  it('backoff doubles per failure and is capped', () => {
    assert.equal(a2b.backoffMs(1), a2b.BASE_BACKOFF_MS);
    assert.equal(a2b.backoffMs(2), a2b.BASE_BACKOFF_MS * 2);
    assert.equal(a2b.backoffMs(99), a2b.MAX_BACKOFF_MS);
  });
});

describe('clearLatch (#2991)', () => {
  /** Latch the project through two failed attempts. */
  async function latch() {
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': unhealthy }, clock });
    const incidentId = openIncident();
    const first = await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    now = first.circuit.nextProbeAt;
    await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    assert.equal(a2b.circuitState(db, projectId).state, 'latched');
    return r;
  }

  it('the recovery service can never clear its own latch', async () => {
    const r = await latch();
    assert.equal(r.clearLatch({ principalId: a2b.RECOVERY_PRINCIPAL, projectId, reason: 'self' }).code, 'OPERATOR_REQUIRED');
    assert.equal(a2b.circuitState(db, projectId).state, 'latched');
  });

  it('a plain member is denied; a reason is required', async () => {
    const r = await latch();
    assert.equal(r.clearLatch({ principalId: memberId, projectId, reason: 'try' }).code, 'ROLE_DENIED');
    assert.equal(r.clearLatch({ principalId: ownerId, projectId, reason: ' ' }).code, 'REASON_REQUIRED');
    assert.equal(a2b.circuitState(db, projectId).state, 'latched');
  });

  it('an owner clears it, closing the circuit and recording who and why', async () => {
    const r = await latch();
    const out = r.clearLatch({ principalId: ownerId, projectId, reason: 'host rebooted, verified by hand' });
    assert.equal(out.code, 'CLEARED');
    assert.deepEqual([out.circuit.state, out.circuit.failures], ['closed', 0]);
    const row = db.prepare('SELECT * FROM v6_a2b_recovery_latches WHERE project_id = ?').get(projectId);
    assert.equal(row.cleared_by, ownerId);
    assert.equal(row.clear_reason, 'host rebooted, verified by hand');
    assert.equal(r.clearLatch({ principalId: ownerId, projectId, reason: 'again' }).code, 'NOT_LATCHED');
  });
});

describe('recoveryConsole (#2991)', () => {
  it('reports the circuit, open incidents and recent attempts for one project only', async () => {
    const r = a2b.createRemediator(db, auth, { executors: { 'ttyd-orphan-reap': unhealthy }, clock });
    const incidentId = openIncident('fp-ttyd');
    await r.remediate({ projectId, incidentId, remediation: 'ttyd-orphan-reap' });
    const view = a2b.recoveryConsole(db, projectId);
    assert.equal(view.circuit.state, 'open');
    assert.deepEqual(view.openIncidents.map((i) => i.fingerprint), ['fp-ttyd']);
    assert.equal(view.recentAttempts.length, 1);
    assert.equal(view.recentAttempts[0].outcome, 'failed');
    const empty = a2b.recoveryConsole(db, projectId + 999);
    assert.deepEqual([empty.circuit.state, empty.openIncidents.length, empty.recentAttempts.length], ['closed', 0, 0]);
  });
});

/** Tear down and rebuild the store inside one test (for table-driven cases). */
function setupFresh() {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setup();
}
