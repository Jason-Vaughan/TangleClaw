'use strict';

// #2352 (Architect Ruling A475-W2C-TRUST): the permission-request record and
// its fail-closed state machine. Every write goes through the real store on a
// temporary database; each expiry/supersession test drives the module's own
// clock rather than sleeping, and each conflict/replay test asserts the exact
// code a trust-boundary caller (Chunks 02/03) will branch on.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const permissionRequests = require('../lib/permission-requests');

const { STATES } = permissionRequests;

const START = Date.parse('2026-10-27T08:00:00.000Z');
const MINUTE = 60 * 1000;

const realNow = permissionRequests._internal.now;

let tmpDir = null;
let PROJECT_A = null;
let PROJECT_B = null;

/**
 * Fix the module's clock to an exact instant.
 * @param {number} ms - Offset from {@link START}
 * @returns {void}
 */
function clockAt(ms = 0) {
  const iso = new Date(START + ms).toISOString();
  permissionRequests._internal.now = () => iso;
}

/**
 * Start a session bound to a fresh launch sequence, so the session is both a
 * real `sessions` row and a real, resolvable launch — everything
 * `_isLaunchCurrent` needs to answer truthfully.
 * @param {number} projectId
 * @param {string} launchId - Must be unique across the whole test file
 * @returns {object} The created session (`store.sessions.start`'s return)
 */
function startSession(projectId, launchId) {
  return store.sessions.start({
    projectId,
    engineId: 'claude',
    launchSequence: {
      launchId,
      pageBudget: 0,
      applicability: 'not-applicable',
      notApplicableReason: 'test fixture — no real launch steps needed',
      preflight: {},
      sourceManifest: {}
    }
  });
}

/**
 * Create a request bound to a freshly-started session, with sane defaults.
 * @param {object} [overrides]
 * @returns {{result: object, session: object, launchId: string}}
 */
function create(overrides = {}) {
  const projectId = overrides.projectId ?? PROJECT_A;
  const launchId = overrides.launchId ?? `launch-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
  const session = overrides.session ?? startSession(projectId, launchId);
  const result = permissionRequests.createPermissionRequest({
    idemKey: overrides.idemKey ?? `idem-${launchId}`,
    projectId,
    sessionId: session.id,
    launchId,
    scope: overrides.scope ?? 'repo-write',
    scopeTarget: overrides.scopeTarget ?? 'origin/main',
    gate: overrides.gate ?? 'test-gate',
    actionSummary: overrides.actionSummary ?? 'push a commit',
    expectedAnswer: overrides.expectedAnswer,
    ttlMs: overrides.ttlMs ?? 10 * MINUTE
  });
  return { result, session, launchId };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-permission-requests-'));
  store._setBasePath(tmpDir);
  store.init();
  PROJECT_A = store.projects.create({ name: 'perm-req-a', path: path.join(tmpDir, 'proj-a') }).id;
  PROJECT_B = store.projects.create({ name: 'perm-req-b', path: path.join(tmpDir, 'proj-b') }).id;
  clockAt(0);
});

afterEach(() => {
  permissionRequests._internal.now = realNow;
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('ensurePermissionSchema', () => {
  it('is idempotent: applying it twice against the same db throws nothing and leaves the tables queryable', () => {
    const db = store.getDb();
    permissionRequests.ensurePermissionSchema(db);
    permissionRequests.ensurePermissionSchema(db);
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) AS n FROM permission_requests').get());
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) AS n FROM permission_request_events').get());
  });
});

describe('createPermissionRequest', () => {
  it('creates a pending request with the full durable record shape', () => {
    const { result, session, launchId } = create({ actionSummary: 'merge PR #2352' });
    assert.equal(result.ok, true);
    const req = result.request;
    assert.match(req.requestId, /^perm_[a-f0-9]{24}$/);
    assert.equal(req.projectId, PROJECT_A);
    assert.equal(req.sessionId, session.id);
    assert.equal(req.launchId, launchId);
    assert.equal(req.scope, 'repo-write');
    assert.equal(req.scopeTarget, 'origin/main');
    assert.equal(req.gate, 'test-gate');
    assert.equal(req.actionSummary, 'merge PR #2352');
    assert.equal(req.state, STATES.PENDING);
    assert.equal(req.decidedAt, null);
    assert.equal(req.decidedBySurface, null);
    assert.equal(req.decidedByActor, null);
    assert.equal(req.decisionProof, null);
    assert.equal(req.receiptDeliveredAt, null);
    assert.ok(req.expiresAt > req.createdAt, 'expiresAt is after createdAt');
  });

  it('rejects a bundled scope (array) rather than silently taking the first entry', () => {
    const session = startSession(PROJECT_A, 'launch-bundle');
    const result = permissionRequests.createPermissionRequest({
      idemKey: 'idem-bundle', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-bundle',
      scope: ['repo-write', 'repo-admin'], scopeTarget: 'origin/main', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PERMISSION_SCOPE_BUNDLED');
  });

  it('refuses a request missing a required field', () => {
    const session = startSession(PROJECT_A, 'launch-missing');
    const result = permissionRequests.createPermissionRequest({
      idemKey: 'idem-missing', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-missing',
      scope: 'repo-write', scopeTarget: 'origin/main', gate: 'g', ttlMs: MINUTE
      // actionSummary deliberately omitted
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PERMISSION_REQUEST_INVALID');
    assert.match(result.message, /actionSummary/);
  });

  it('is idempotent on (projectId, idemKey): a repeat create returns the same row, not a second one', () => {
    const session = startSession(PROJECT_A, 'launch-idem');
    const first = permissionRequests.createPermissionRequest({
      idemKey: 'idem-fixed', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-idem',
      scope: 'repo-write', scopeTarget: 'origin/main', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    const second = permissionRequests.createPermissionRequest({
      idemKey: 'idem-fixed', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-idem',
      scope: 'repo-write', scopeTarget: 'origin/main', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    assert.equal(second.ok, true);
    assert.equal(second.replay, true);
    assert.equal(second.request.requestId, first.request.requestId);
    const count = store.getDb().prepare('SELECT COUNT(*) AS n FROM permission_requests').get().n;
    assert.equal(count, 1);
  });

  it('scopes the idempotency key per project: the same idemKey in a different project creates a second row', () => {
    const sessionA = startSession(PROJECT_A, 'launch-scope-a');
    const sessionB = startSession(PROJECT_B, 'launch-scope-b');
    const a = permissionRequests.createPermissionRequest({
      idemKey: 'shared-key', projectId: PROJECT_A, sessionId: sessionA.id, launchId: 'launch-scope-a',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    const b = permissionRequests.createPermissionRequest({
      idemKey: 'shared-key', projectId: PROJECT_B, sessionId: sessionB.id, launchId: 'launch-scope-b',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.request.requestId, b.request.requestId);
  });
});

describe('expiry (fail-closed)', () => {
  it('a request read after its own expires_at transitions to expired and fails closed', () => {
    const { result } = create({ ttlMs: MINUTE });
    clockAt(2 * MINUTE);
    const read = permissionRequests.getPermissionRequest(result.request.requestId);
    assert.equal(read.state, STATES.EXPIRED);
  });

  it('deciding an expired request fails closed with PERMISSION_REQUEST_EXPIRED and a recovery action', () => {
    const { result } = create({ ttlMs: MINUTE });
    clockAt(2 * MINUTE);
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'proof'
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'PERMISSION_REQUEST_EXPIRED');
    assert.ok(decision.recovery, 'names a recovery action');
    assert.equal(decision.request.state, STATES.EXPIRED);
  });

  it('a request still inside its TTL is untouched by evaluation', () => {
    const { result } = create({ ttlMs: 10 * MINUTE });
    clockAt(1 * MINUTE);
    const read = permissionRequests.getPermissionRequest(result.request.requestId);
    assert.equal(read.state, STATES.PENDING);
  });
});

describe('supersession (fail-closed)', () => {
  it('a request whose session is no longer the project\'s current launch transitions to superseded', () => {
    const { result } = create({ projectId: PROJECT_A, launchId: 'launch-super-old' });
    // A second session for the same project becomes the current one — the
    // first session's launch is no longer live, with no need to end it
    // explicitly: supersession is about currency, not termination.
    startSession(PROJECT_A, 'launch-super-new');
    const read = permissionRequests.getPermissionRequest(result.request.requestId);
    assert.equal(read.state, STATES.SUPERSEDED);
  });

  it('deciding a superseded request fails closed with PERMISSION_LAUNCH_SUPERSEDED', () => {
    const { result } = create({ projectId: PROJECT_A, launchId: 'launch-super-old-2' });
    startSession(PROJECT_A, 'launch-super-new-2');
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'refuse', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'proof'
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'PERMISSION_LAUNCH_SUPERSEDED');
  });

  it('a request whose session is still the project\'s only (current) one is untouched', () => {
    const { result } = create({ projectId: PROJECT_B });
    const read = permissionRequests.getPermissionRequest(result.request.requestId);
    assert.equal(read.state, STATES.PENDING);
  });
});

describe('decidePermissionRequest', () => {
  it('grants a pending request and persists decided_at/surface/actor/proof exactly as given', () => {
    const { result } = create();
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator:jason', decisionProof: 'csrf-ok;requestId=match'
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.request.state, STATES.GRANTED);
    assert.ok(decision.request.decidedAt);
    assert.equal(decision.request.decidedBySurface, 'dashboard');
    assert.equal(decision.request.decidedByActor, 'operator:jason');
    assert.equal(decision.request.decisionProof, 'csrf-ok;requestId=match');
  });

  it('refuses a pending request', () => {
    const { result } = create();
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'refuse', decidedBySurface: 'discord-bridge', decidedByActor: 'discord:123', decisionProof: 'bridge-proof'
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.request.state, STATES.REFUSED);
  });

  it('a replay of the exact same decision by the same actor/surface is idempotent, not a conflict', () => {
    const { result } = create();
    const first = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p1'
    });
    const second = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p1'
    });
    assert.equal(second.ok, true);
    assert.equal(second.replay, true);
    assert.equal(second.request.decidedAt, first.request.decidedAt, 'replay does not move decided_at');
  });

  it('a conflicting decision after the request is already decided fails closed with PERMISSION_DECISION_CONFLICT', () => {
    const { result } = create();
    permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p1'
    });
    const conflict = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'refuse', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p2'
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'PERMISSION_DECISION_CONFLICT');
    assert.equal(conflict.request.state, STATES.GRANTED, 'the original decision stands');
  });

  it('a decision naming an expectedScope that does not match the request\'s scope fails closed', () => {
    const { result } = create({ scope: 'repo-write' });
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p', expectedScope: 'repo-admin'
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'PERMISSION_SCOPE_MISMATCH');
  });

  it('rejects a decision value this module does not recognize', () => {
    const { result } = create();
    const decision = permissionRequests.decidePermissionRequest(result.request.requestId, {
      decision: 'approve-all', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p'
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'PERMISSION_DECISION_INVALID');
  });

  it('answers PERMISSION_REQUEST_NOT_FOUND for an unknown request id', () => {
    const decision = permissionRequests.decidePermissionRequest('perm_does_not_exist', {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p'
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'PERMISSION_REQUEST_NOT_FOUND');
  });
});

describe('listPermissionRequestsForSession', () => {
  it('lists newest first and reflects lazy expiry at read time', () => {
    const session = startSession(PROJECT_A, 'launch-list');
    const older = permissionRequests.createPermissionRequest({
      idemKey: 'idem-list-1', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-list',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    }).request;
    clockAt(1);
    const newer = permissionRequests.createPermissionRequest({
      idemKey: 'idem-list-2', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-list',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: 10 * MINUTE
    }).request;
    clockAt(2 * MINUTE);
    const listed = permissionRequests.listPermissionRequestsForSession(session.id);
    assert.deepEqual(listed.map((r) => r.requestId), [newer.requestId, older.requestId]);
    assert.equal(listed[0].state, STATES.PENDING);
    assert.equal(listed[1].state, STATES.EXPIRED, 'the older, shorter-TTL request has lazily expired by read time');
  });

  it('filters by state', () => {
    const session = startSession(PROJECT_A, 'launch-list-filter');
    const a = permissionRequests.createPermissionRequest({
      idemKey: 'idem-filter-1', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-list-filter',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    }).request;
    permissionRequests.createPermissionRequest({
      idemKey: 'idem-filter-2', projectId: PROJECT_A, sessionId: session.id, launchId: 'launch-list-filter',
      scope: 's', scopeTarget: 't', gate: 'g', actionSummary: 'x', ttlMs: MINUTE
    });
    permissionRequests.decidePermissionRequest(a.requestId, {
      decision: 'grant', decidedBySurface: 'dashboard', decidedByActor: 'operator', decisionProof: 'p'
    });
    const granted = permissionRequests.listPermissionRequestsForSession(session.id, { state: STATES.GRANTED });
    assert.equal(granted.length, 1);
    assert.equal(granted[0].requestId, a.requestId);
  });
});

describe('markReceiptDelivered', () => {
  it('delivers once: the first call sets receiptDeliveredAt, the second is a no-op reporting delivered:false', () => {
    const { result } = create();
    const first = permissionRequests.markReceiptDelivered(result.request.requestId);
    assert.equal(first.ok, true);
    assert.equal(first.delivered, true);
    assert.ok(first.request.receiptDeliveredAt);

    clockAt(5 * MINUTE);
    const second = permissionRequests.markReceiptDelivered(result.request.requestId);
    assert.equal(second.ok, true);
    assert.equal(second.delivered, false);
    assert.equal(second.request.receiptDeliveredAt, first.request.receiptDeliveredAt, 'timestamp does not move on the second delivery');
  });

  it('answers PERMISSION_REQUEST_NOT_FOUND for an unknown request id', () => {
    const result = permissionRequests.markReceiptDelivered('perm_does_not_exist');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PERMISSION_REQUEST_NOT_FOUND');
  });
});

describe('permission_request_events', () => {
  it('records one event per lifecycle transition', () => {
    const { result } = create({ ttlMs: MINUTE });
    permissionRequests.markReceiptDelivered(result.request.requestId);
    const kinds = store.getDb()
      .prepare('SELECT kind FROM permission_request_events WHERE request_id = ? ORDER BY event_id')
      .all(result.request.requestId)
      .map((row) => row.kind);
    assert.deepEqual(kinds, ['created', 'receipt-delivered']);

    clockAt(2 * MINUTE);
    permissionRequests.getPermissionRequest(result.request.requestId);
    const kindsAfterExpiry = store.getDb()
      .prepare('SELECT kind FROM permission_request_events WHERE request_id = ? ORDER BY event_id')
      .all(result.request.requestId)
      .map((row) => row.kind);
    assert.deepEqual(kindsAfterExpiry, ['created', 'receipt-delivered', 'expired']);
  });
});
