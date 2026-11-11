'use strict';

// v6 Train 3 Wave 1 (#2990, V6-19 / G1+G2a, Car V60-T3-W1-A): the G1
// GitHub writer over a real node:sqlite-backed store (v83 schema:
// v6_bindings, v6_github_connections, v6_g1_outbox,
// v6_g1_milestone_bindings) plus the ALREADY-SHIPPED Stage 1
// v6_g1_leases/v6_g1_approvals tables (#1149, seeded directly here --
// minting them is lib/v6/authority-service.js's job, out of this car's
// scope to re-test).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createG1Writer, normalizeDraft, WRITE_RULES } = require('../lib/v6/g1-github-integration');

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-g1-writer-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function seedProject(db, name) {
  db.prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(tmpDir, name));
  return db.prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
}

/**
 * Seed a fully-admissible project: bound repo, a valid connection with
 * both tiers approved, and (when requested) a role lease and/or a Tier 3
 * approval. Returns everything a test needs to call `admit`/`execute`.
 */
function seedAdmissible(db, {
  projectName, repo = 'acme/widgets', leaseActor = 'builder-1', leaseActions = ['createIssue', 'createMilestone'],
  withLease = true, approvalFor = null
} = {}) {
  const projectId = seedProject(db, projectName);
  db.prepare('INSERT INTO v6_bindings (project_id, repo, installation_id, secret_ref) VALUES (?, ?, ?, ?)')
    .run(projectId, repo, 42, 'vault:gh-token');

  const probe = {
    identity: 'app-123', kind: 'app', permissions: ['issues:write'], repositories: [repo],
    expiresAt: Date.now() + 99999999
  };
  const connection = {
    repo, epoch: 1, approvedTiers: [2, 3], tokenRef: 'vault:gh-token', identity: 'app-123',
    expectedFingerprint: JSON.stringify({
      identity: probe.identity, kind: probe.kind, permissions: [...probe.permissions].sort(), repositories: [...probe.repositories].sort()
    })
  };
  db.prepare('INSERT INTO v6_github_connections (project_id, connection_json, probe_json) VALUES (?, ?, ?)')
    .run(projectId, JSON.stringify(connection), JSON.stringify(probe));

  let leaseId = null;
  if (withLease) {
    leaseId = crypto.randomUUID();
    db.prepare('INSERT INTO v6_g1_leases (id, project_id, actor, repo, connection_epoch, actions_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(leaseId, projectId, leaseActor, repo, 1, JSON.stringify(leaseActions), Date.now() + 999999);
  }

  let approvalId = null;
  if (approvalFor) {
    approvalId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO v6_g1_approvals (id, project_id, operator_actor, action, repo, target_digest, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(approvalId, projectId, approvalFor.operatorActor, approvalFor.action, repo, approvalFor.targetDigest, Date.now() + 999999);
  }

  return { projectId, repo, leaseId, approvalId, connection, probe };
}

const PRINCIPAL = { verified: true, role: 'project', actor: 'builder-1' };
const ADMISSION = { launchBindingVerified: true, csrfVerified: true };
const secretStoreOk = { get: (ref) => (ref === 'vault:gh-token' ? 'x'.repeat(20) : null) };

function fetchImplOk(number = 7, repo = 'acme/widgets', kind = 'issues') {
  return async () => ({
    status: 201,
    json: async () => ({ number, html_url: `https://github.com/${repo}/${kind === 'issues' ? 'issues' : 'milestone'}/${number}` })
  });
}

describe('createG1Writer construction', () => {
  it('throws without db/secretStore/fetchImpl', () => {
    assert.throws(() => createG1Writer({}));
    assert.throws(() => createG1Writer({ db: {}, secretStore: {} }), /secretStore/, 'a secretStore with no get() method must be refused');
  });

  it('refuses an untrusted API origin', () => {
    const db = freshStore();
    try {
      assert.throws(() => createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(), apiBase: 'https://evil.example.com' }));
    } finally {
      cleanup();
    }
  });

  it('accepts the loopback origin, for the verifier only', () => {
    const db = freshStore();
    try {
      assert.doesNotThrow(() => createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(), apiBase: 'http://127.0.0.1:4000' }));
    } finally {
      cleanup();
    }
  });
});

describe('normalizeDraft', () => {
  it('rejects a missing/blank/overlong/control-char title for any action', () => {
    assert.equal(normalizeDraft('createIssue', { title: '' }), null);
    assert.equal(normalizeDraft('createIssue', { title: 'a'.repeat(300) }), null);
    assert.equal(normalizeDraft('createIssue', { title: 'bad\x01title' }), null);
    assert.equal(normalizeDraft('createIssue', null), null);
  });

  it('createIssue: dedupes labels and keeps only a well-formed milestone number', () => {
    const draft = normalizeDraft('createIssue', { title: 't', body: 'b', labels: ['x', 'x', 'y'], milestone: 3 });
    assert.deepEqual(draft, { title: 't', body: 'b', labels: ['x', 'y'], milestone: 3 });
  });

  it('createIssue: rejects a malformed label or milestone', () => {
    assert.equal(normalizeDraft('createIssue', { title: 't', body: 'b', labels: ['has space is fine', 'bad!label'] }), null);
    assert.equal(normalizeDraft('createIssue', { title: 't', body: 'b', milestone: 0 }), null);
  });

  it('createMilestone: normalizes description/due_on, omitting unset optionals', () => {
    assert.deepEqual(normalizeDraft('createMilestone', { title: 't' }), { title: 't', description: '', state: 'open' });
    assert.deepEqual(
      normalizeDraft('createMilestone', { title: 't', due_on: '2026-12-01T00:00:00Z' }),
      { title: 't', description: '', state: 'open', due_on: '2026-12-01T00:00:00Z' }
    );
  });

  it('returns null for an unknown action', () => {
    assert.equal(normalizeDraft('deleteRepo', { title: 't' }), null);
  });
});

describe('admit/execute -- Tier 2 createIssue (#2990 Deliverable 1)', () => {
  it('succeeds end to end: outbox row recorded succeeded, result returned', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-tier2-ok' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(7) });
      const res = await writer.execute({
        projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue',
        idempotencyKey: 'key-1', leaseId, draft: { title: 'hello', body: 'world' }
      });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'CREATED');
      assert.deepEqual(res.result, { number: 7, url: 'https://github.com/acme/widgets/issues/7' });

      const row = db.prepare('SELECT * FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, 'key-1');
      assert.equal(row.state, 'succeeded');
    } finally {
      cleanup();
    }
  });

  it('replays the ORIGINAL outcome for a repeated key, never calling fetch again', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-replay' });
      let fetchCalls = 0;
      const fetchImpl = async (...args) => { fetchCalls++; return fetchImplOk(7)(...args); };
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl });
      const args = { projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'key-2', leaseId, draft: { title: 'x', body: 'y' } };
      await writer.execute(args);
      const replay = await writer.execute(args);
      assert.equal(replay.code, 'REPLAY');
      assert.equal(fetchCalls, 1, 'fetch must not be called a second time for a replay');
    } finally {
      cleanup();
    }
  });

  it('refuses a changed payload under the SAME idempotency key as a conflict, never overwriting', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-conflict' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(7) });
      await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'key-3', leaseId, draft: { title: 'first', body: 'b' } });
      const conflict = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'key-3', leaseId, draft: { title: 'DIFFERENT', body: 'b' } });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(conflict.status, 409);
    } finally {
      cleanup();
    }
  });

  it('fails closed with ROLE_LEASE_REQUIRED when no lease exists', async () => {
    const db = freshStore();
    try {
      const { projectId } = seedAdmissible(db, { projectName: 'g1-no-lease', withLease: false });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId: 'nonexistent', draft: { title: 't', body: 'b' } });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'ROLE_LEASE_REQUIRED');
    } finally {
      cleanup();
    }
  });

  it('refuses when the lease belongs to a DIFFERENT actor than the principal', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-wrong-actor', leaseActor: 'someone-else' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'ROLE_LEASE_REQUIRED');
    } finally {
      cleanup();
    }
  });

  it('refuses when the lease does not cover the requested action', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-action-not-leased', leaseActions: ['createMilestone'] });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'ROLE_LEASE_REQUIRED');
    } finally {
      cleanup();
    }
  });

  it('refuses when the project has no repo binding', async () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'g1-no-binding');
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId: 'x', draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'REPO_NOT_BOUND');
    } finally {
      cleanup();
    }
  });

  it('refuses an unadmitted caller (principal not verified) before touching the db further', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-unverified' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({
        projectId, principal: { ...PRINCIPAL, projectId, verified: false }, admission: ADMISSION,
        action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' }
      });
      assert.equal(res.code, 'CALLER_NOT_ADMITTED');
    } finally {
      cleanup();
    }
  });

  it('refuses when admission lacks launchBindingVerified or csrfVerified', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-no-csrf' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({
        projectId, principal: { ...PRINCIPAL, projectId }, admission: { launchBindingVerified: true, csrfVerified: false },
        action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' }
      });
      assert.equal(res.code, 'CALLER_NOT_ADMITTED');
    } finally {
      cleanup();
    }
  });

  it('refuses a malformed draft with BAD_DRAFT', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-bad-draft' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: '' } });
      assert.equal(res.code, 'BAD_DRAFT');
    } finally {
      cleanup();
    }
  });

  it('refuses an unknown action with ACTION_NOT_ALLOWED', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-bad-action' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'deleteRepo', idempotencyKey: 'k', leaseId, draft: { title: 't' } });
      assert.equal(res.code, 'ACTION_NOT_ALLOWED');
    } finally {
      cleanup();
    }
  });

  it('refuses a malformed idempotency key', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-bad-key' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'has a space', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'BAD_IDEMPOTENCY_KEY');
    } finally {
      cleanup();
    }
  });

  it('refuses when the connection is revoked', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-revoked' });
      db.prepare("UPDATE v6_github_connections SET connection_json = json_set(connection_json, '$.revokedAt', ?) WHERE project_id = ?")
        .run(Date.now(), projectId);
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'CONNECTION_REVOKED');
    } finally {
      cleanup();
    }
  });

  it('refuses when the probe reports lost repository access (drift)', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-drift' });
      db.prepare("UPDATE v6_github_connections SET probe_json = json_set(probe_json, '$.repositories', json(?)) WHERE project_id = ?")
        .run(JSON.stringify(['someone/else']), projectId);
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'REPOSITORY_ACCESS_LOST');
    } finally {
      cleanup();
    }
  });

  it('refuses when the secret store cannot supply a credential', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-no-secret' });
      const writer = createG1Writer({ db, secretStore: { get: () => null }, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'CREDENTIAL_UNAVAILABLE');
      assert.equal(res.status, 503);
    } finally {
      cleanup();
    }
  });
});

describe('admit/execute -- Tier 3 createMilestone & distinct-operator approval (#2990 Deliverable 1, P08)', () => {
  function digestFor(repo, draft) {
    const crypto2 = require('node:crypto');
    return crypto2.createHash('sha256').update(JSON.stringify({ action: 'createMilestone', repo, draft })).digest('hex');
  }

  it('refuses a Tier 3 action with no approval at all', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-tier3-no-approval' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createMilestone', idempotencyKey: 'k', leaseId, draft: { title: 'M1' } });
      assert.equal(res.code, 'OPERATOR_APPROVAL_REQUIRED');
    } finally {
      cleanup();
    }
  });

  it('refuses self-approval -- the approval\'s operator_actor cannot equal the requesting principal\'s actor (P08)', async () => {
    const db = freshStore();
    try {
      const draft = { title: 'M1', description: '', state: 'open' };
      const { projectId, leaseId, approvalId } = seedAdmissible(db, {
        projectName: 'g1-self-approve',
        approvalFor: { operatorActor: 'builder-1', action: 'createMilestone', targetDigest: digestFor('acme/widgets', draft) }
      });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk() });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createMilestone', idempotencyKey: 'k', leaseId, approvalId, draft: { title: 'M1' } });
      assert.equal(res.code, 'OPERATOR_APPROVAL_REQUIRED', 'builder-1 approving its own builder-1 request must be refused');
    } finally {
      cleanup();
    }
  });

  it('succeeds with a DISTINCT operator\'s approval, consumes it, and binds the resulting milestone number', async () => {
    const db = freshStore();
    try {
      const draft = { title: 'M1', description: '', state: 'open' };
      const { projectId, leaseId, approvalId } = seedAdmissible(db, {
        projectName: 'g1-tier3-ok',
        approvalFor: { operatorActor: 'distinct-operator', action: 'createMilestone', targetDigest: digestFor('acme/widgets', draft) }
      });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(5, 'acme/widgets', 'milestones') });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createMilestone', idempotencyKey: 'k', leaseId, approvalId, draft: { title: 'M1' } });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'CREATED');

      const approvalRow = db.prepare('SELECT consumed_at FROM v6_g1_approvals WHERE id = ?').get(approvalId);
      assert.ok(approvalRow.consumed_at !== null, 'the approval must be consumed on success');

      const binding = db.prepare('SELECT * FROM v6_g1_milestone_bindings WHERE project_id = ? AND number = ?').get(projectId, 5);
      assert.ok(binding, 'the new milestone number must be bound for future issue-milestone references');
    } finally {
      cleanup();
    }
  });

  it('refuses an already-consumed approval on a second attempt', async () => {
    const db = freshStore();
    try {
      const draft = { title: 'M1', description: '', state: 'open' };
      const { projectId, leaseId, approvalId } = seedAdmissible(db, {
        projectName: 'g1-tier3-reuse',
        approvalFor: { operatorActor: 'distinct-operator', action: 'createMilestone', targetDigest: digestFor('acme/widgets', draft) }
      });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: fetchImplOk(5, 'acme/widgets', 'milestones') });
      await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createMilestone', idempotencyKey: 'k1', leaseId, approvalId, draft: { title: 'M1' } });
      // A second, DIFFERENT idempotency key, trying to reuse the same (now consumed) approval.
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createMilestone', idempotencyKey: 'k2', leaseId, approvalId, draft: { title: 'M1' } });
      assert.equal(res.code, 'OPERATOR_APPROVAL_REQUIRED');
    } finally {
      cleanup();
    }
  });
});

describe('outbox state on a GitHub-side failure (#2990 Deliverable 1 -- durable idempotent outbox)', () => {
  it('records state=unknown on a network error, never silently swallowed', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-network-error' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'OUTCOME_UNKNOWN');
      assert.equal(res.status, 503);
      const row = db.prepare('SELECT state FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, 'k');
      assert.equal(row.state, 'unknown');
    } finally {
      cleanup();
    }
  });

  it('records state=failed on a definite 422 rejection', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-rejected' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: async () => ({ status: 422, json: async () => ({ message: 'nope' }) }) });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'GITHUB_REJECTED');
      assert.equal(res.status, 422);
      const row = db.prepare('SELECT state, status FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, 'k');
      assert.equal(row.state, 'failed');
      assert.equal(row.status, 422);
    } finally {
      cleanup();
    }
  });

  it('records state=unknown (not failed) on a 503 -- an uncertain outcome, not a definite rejection', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-5xx' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: async () => ({ status: 503, json: async () => ({}) }) });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'OUTCOME_UNKNOWN');
      const row = db.prepare('SELECT state FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, 'k');
      assert.equal(row.state, 'unknown');
    } finally {
      cleanup();
    }
  });

  it('records state=unknown on a 201 whose body does not match the expected shape', async () => {
    const db = freshStore();
    try {
      const { projectId, leaseId } = seedAdmissible(db, { projectName: 'g1-malformed-201' });
      const writer = createG1Writer({ db, secretStore: secretStoreOk, fetchImpl: async () => ({ status: 201, json: async () => ({ not: 'what is expected' }) }) });
      const res = await writer.execute({ projectId, principal: { ...PRINCIPAL, projectId }, admission: ADMISSION, action: 'createIssue', idempotencyKey: 'k', leaseId, draft: { title: 't', body: 'b' } });
      assert.equal(res.code, 'OUTCOME_UNKNOWN');
      const row = db.prepare('SELECT state FROM v6_g1_outbox WHERE project_id = ? AND idempotency_key = ?').get(projectId, 'k');
      assert.equal(row.state, 'unknown');
    } finally {
      cleanup();
    }
  });
});
