'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { operatorOf, bindProject } = require('./_shared-docs-callers');
const { createServer, _sharedDocWatchers, _sharedDocDebounceTimers } = require('../server');

// The operator routes that grant authority need a signed-in operator (#2378).
// A suite that calls one turns the login on; this answers the operator's
// signed-in session there, and the dashboard's own shape wherever the login
// is still off, so every other request is sent exactly as before.
const operators = new WeakMap();

/**
 * The headers the operator's browser sends to this server, in whatever state
 * its login is in (see `operatorOf`).
 * @param {import('node:http').Server} server - The listening test server
 * @returns {Promise<Record<string, string>>}
 */
function operatorFor(server) {
  if (!operators.has(server)) operators.set(server, operatorOf(server));
  return operators.get(server)();
}

setLevel('error');

/**
 * Make an HTTP request to the test server as the operator.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
async function request(server, method, urlPath, body) {
  // These suites exercise the dashboard's group and document management,
  // so every request is the operator's; a bare machine request is refused.
  return requestAs(server, method, urlPath, await operatorFor(server), body);
}

/**
 * Make an HTTP request to the test server with the given caller headers.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {Record<string, string>} callerHeaders - Who the request is from
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
function requestAs(server, method, urlPath, callerHeaders, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...callerHeaders }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API /api/shared-docs', () => {
  let tmpDir;
  let server;
  let groupId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-shareddocs-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a test group
    const group = store.projectGroups.create({ name: 'DocTestGroup' });
    groupId = group.id;

    // This suite calls operator routes that grant authority over sessions,

    // which need the operator signed in (#2378): the login is on, and

    // `operatorFor` sends the operator's session.
    store.config.save({ ...store.config.load(), authEnabled: true, basicAuthUser: null, basicAuthHash: null });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    // Any doc created with a real (existing) filePath in these tests gets a
    // live fs.watch handle, which keeps the process's event loop alive past
    // suite completion unless closed here.
    for (const { watcher } of _sharedDocWatchers.values()) watcher.close();
    for (const timer of _sharedDocDebounceTimers.values()) clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/shared-docs returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/api/shared-docs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.docs));
    assert.equal(data.docs.length, 0);
  });

  it('POST /api/shared-docs creates a document', async () => {
    const { status, data } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'API Guide',
      filePath: '/tmp/api-guide.md',
      injectIntoConfig: true,
      injectMode: 'reference',
      description: 'API documentation'
    });
    assert.equal(status, 201);
    assert.equal(data.name, 'API Guide');
    assert.equal(data.groupId, groupId);
    assert.equal(data.injectIntoConfig, true);
    assert.equal(data.injectMode, 'reference');
  });

  it('POST /api/shared-docs rejects missing required fields', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', { name: 'Incomplete' });
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs rejects invalid injectMode', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'Bad Mode',
      filePath: '/tmp/bad.md',
      injectMode: 'invalid'
    });
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs rejects nonexistent group', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId: 'nonexistent-group',
      name: 'Orphan',
      filePath: '/tmp/orphan.md'
    });
    assert.equal(status, 404);
  });

  it('POST /api/shared-docs rejects duplicate file path in same group', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'Dup',
      filePath: '/tmp/api-guide.md'
    });
    assert.equal(status, 409);
  });

  it('GET /api/shared-docs?groupId= filters by group', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs?groupId=${groupId}`);
    assert.equal(status, 200);
    assert.ok(data.docs.length >= 1);
    assert.ok(data.docs.every(d => d.groupId === groupId));
  });

  it('GET /api/shared-docs/:id returns a document with lock status', async () => {
    const listRes = await request(server, 'GET', '/api/shared-docs');
    const docId = listRes.data.docs[0].id;

    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}`);
    assert.equal(status, 200);
    assert.equal(data.name, 'API Guide');
    assert.equal(data.lock, null);
  });

  it('GET /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'GET', '/api/shared-docs/nonexistent');
    assert.equal(status, 404);
  });

  it('PUT /api/shared-docs/:id updates a document', async () => {
    const listRes = await request(server, 'GET', '/api/shared-docs');
    const docId = listRes.data.docs[0].id;

    const { status, data } = await request(server, 'PUT', `/api/shared-docs/${docId}`, {
      name: 'Updated Guide',
      description: 'Updated desc'
    });
    assert.equal(status, 200);
    assert.equal(data.name, 'Updated Guide');
    assert.equal(data.description, 'Updated desc');
  });

  it('PUT /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'PUT', '/api/shared-docs/nonexistent', { name: 'X' });
    assert.equal(status, 404);
  });

  it('DELETE /api/shared-docs/:id deletes a document', async () => {
    // Create a doc to delete
    const createRes = await request(server, 'POST', '/api/shared-docs', {
      groupId,
      name: 'ToDelete',
      filePath: '/tmp/delete-me.md'
    });
    const docId = createRes.data.id;

    const { status, data } = await request(server, 'DELETE', `/api/shared-docs/${docId}`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm gone
    const getRes = await request(server, 'GET', `/api/shared-docs/${docId}`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/shared-docs/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'DELETE', '/api/shared-docs/nonexistent');
    assert.equal(status, 404);
  });

  it('PUT /api/shared-docs/:id re-targets the watcher when filePath changes (regression, #990 review)', async () => {
    const fileA = path.join(tmpDir, 'watch-a.md');
    const fileB = path.join(tmpDir, 'watch-b.md');
    fs.writeFileSync(fileA, 'a');
    fs.writeFileSync(fileB, 'b');

    const createRes = await request(server, 'POST', '/api/shared-docs', {
      groupId, name: 'Retarget', filePath: fileA
    });
    const docId = createRes.data.id;
    assert.equal(_sharedDocWatchers.get(docId).filePath, fileA,
      'watcher should be watching the doc\'s initial filePath');

    await request(server, 'PUT', `/api/shared-docs/${docId}`, { filePath: fileB });
    assert.equal(_sharedDocWatchers.get(docId).filePath, fileB,
      'watcher must re-target to the new filePath after an update — the old bug left it ' +
      'watching fileA forever, silently dropping notifications for the doc\'s real content');
  });

  it('DELETE /api/shared-docs/:id closes its watcher and clears its debounce timer (regression, #990 review)', async () => {
    const file = path.join(tmpDir, 'watch-delete.md');
    fs.writeFileSync(file, 'x');

    const createRes = await request(server, 'POST', '/api/shared-docs', {
      groupId, name: 'ToDeleteWatched', filePath: file
    });
    const docId = createRes.data.id;
    assert.ok(_sharedDocWatchers.has(docId), 'watcher should exist right after create');

    // Force a pending debounce timer, then delete before it fires.
    _sharedDocDebounceTimers.set(docId, setTimeout(() => {}, 60000));

    await request(server, 'DELETE', `/api/shared-docs/${docId}`);
    assert.ok(!_sharedDocWatchers.has(docId),
      'watcher must be closed and removed on delete — the old bug leaked one fs.watch handle per deleted doc');
    assert.ok(!_sharedDocDebounceTimers.has(docId),
      'pending debounce timer must be cleared on delete, not left to fire against a deleted doc');
  });
});

describe('API /api/shared-docs/:id/lock', () => {
  let tmpDir;
  let server;
  let groupId;
  let docId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-locks-'));
    store._setBasePath(tmpDir);
    store.init();

    const group = store.projectGroups.create({ name: 'LockTestGroup' });
    groupId = group.id;

    const doc = store.sharedDocs.create({
      groupId,
      name: 'LockableDoc',
      filePath: '/tmp/lockable.md',
      injectIntoConfig: true
    });
    docId = doc.id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/shared-docs/:id/lock shows unlocked state', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.locked, false);
    assert.equal(data.lock, null);
  });

  it('POST /api/shared-docs/:id/lock acquires a lock', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 1,
      projectName: 'test-project'
    });
    assert.equal(status, 200);
    assert.equal(data.documentId, docId);
    assert.equal(data.lockedBySession, 1);
    assert.equal(data.lockedByProject, 'test-project');
    assert.ok(data.expiresAt);
  });

  it('GET /api/shared-docs/:id/lock shows locked state', async () => {
    const { status, data } = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.locked, true);
    assert.equal(data.lock.lockedByProject, 'test-project');
  });

  it('POST /api/shared-docs/:id/lock returns conflict when already locked', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 2,
      projectName: 'other-project'
    });
    assert.equal(status, 409);
    assert.equal(data.code, 'LOCK_CONFLICT');
  });

  it('POST /api/shared-docs/:id/lock rejects missing fields', async () => {
    const { status } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {});
    assert.equal(status, 400);
  });

  it('POST /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'POST', '/api/shared-docs/nonexistent/lock', {
      sessionId: 1,
      projectName: 'test'
    });
    assert.equal(status, 404);
  });

  it('DELETE /api/shared-docs/:id/lock releases a lock', async () => {
    const { status, data } = await request(server, 'DELETE', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Confirm unlocked
    const getRes = await request(server, 'GET', `/api/shared-docs/${docId}/lock`);
    assert.equal(getRes.data.locked, false);
  });

  it('DELETE /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'DELETE', '/api/shared-docs/nonexistent/lock');
    assert.equal(status, 404);
  });

  it('GET /api/shared-docs/:id/lock returns 404 for unknown doc', async () => {
    const { status } = await request(server, 'GET', '/api/shared-docs/nonexistent/lock');
    assert.equal(status, 404);
  });

  it('POST /api/shared-docs/:id/lock overrides expired lock', async () => {
    // Acquire with very short TTL — we'll manipulate the DB directly
    store.documentLocks.acquire(docId, 10, 'old-project', 0.001); // ~60ms TTL
    // Wait briefly for expiry
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }

    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 20,
      projectName: 'new-project'
    });
    assert.equal(status, 200);
    assert.equal(data.lockedByProject, 'new-project');

    // Clean up
    store.documentLocks.release(docId);
  });
});

// #2290: a member session may release only a lock it holds. An operator's
// lock records whatever session id the operator names, so the release compares
// the lock with the session the caller's launch binding verified. The holder, the
// operator, and anyone on an expired or absent lock may release.
describe('DELETE /api/shared-docs/:id/lock releases only for the holder or the operator (#2290)', () => {
  let tmpDir;
  let server;
  let docId;
  let projectA;
  let projectB;
  let bindingA;
  let bindingB;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-lock-holder-'));
    store._setBasePath(tmpDir);
    store.init();

    const group = store.projectGroups.create({ name: 'LockHolderGroup' });
    projectA = store.projects.create({ name: 'holder-a', path: path.join(tmpDir, 'a'), engine: 'claude' });
    projectB = store.projects.create({ name: 'member-b', path: path.join(tmpDir, 'b'), engine: 'claude' });
    store.projectGroups.addMember(group.id, projectA.id);
    store.projectGroups.addMember(group.id, projectB.id);
    docId = store.sharedDocs.create({ groupId: group.id, name: 'HELD', filePath: path.join(tmpDir, 'held.md') }).id;
    bindingA = bindProject(projectA);
    bindingB = bindProject(projectB);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Lock the document as project A's session, through the route.
   * @returns {Promise<object>} The lock the route answered
   */
  async function lockAsA() {
    const { status, data } = await requestAs(server, 'POST', `/api/shared-docs/${docId}/lock`, bindingA.headers, {
      sessionId: bindingA.sessionId,
      projectName: projectA.name
    });
    assert.equal(status, 200);
    return data;
  }

  it('refuses another member session with 409 NOT_LOCK_HOLDER naming the holder, and keeps the lock', async () => {
    const lock = await lockAsA();
    const { status, data } = await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingB.headers);
    assert.equal(status, 409);
    assert.equal(data.code, 'NOT_LOCK_HOLDER');
    assert.equal(data.holder.sessionId, bindingA.sessionId);
    assert.equal(data.holder.project, projectA.name);
    assert.equal(data.holder.lockedAt, lock.lockedAt);
    assert.equal(data.holder.expiresAt, lock.expiresAt);
    const after = await requestAs(server, 'GET', `/api/shared-docs/${docId}/lock`, bindingB.headers);
    assert.equal(after.data.locked, true);
    assert.equal(after.data.lock.lockedBySession, bindingA.sessionId);
  });

  it('releases for the session that holds the lock', async () => {
    const { status, data } = await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingA.headers);
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true, id: docId });
    assert.equal(store.documentLocks.check(docId), null);
  });

  it('releases for the operator, whoever holds the lock', async () => {
    await lockAsA();
    const { status, data } = await request(server, 'DELETE', `/api/shared-docs/${docId}/lock`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(store.documentLocks.check(docId), null);
  });

  it('releases an expired lock for another member session', async () => {
    await lockAsA();
    store.getDb().prepare('UPDATE document_locks SET expires_at = ? WHERE document_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), docId);
    const { status, data } = await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingB.headers);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(store.documentLocks.check(docId), null);
  });

  it('answers 200 to a member session when the document is not locked', async () => {
    assert.equal(store.documentLocks.check(docId), null);
    const { status, data } = await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingB.headers);
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true, id: docId });
  });
});

// #2489: a member's lock is taken in its own verified name. The body's
// sessionId and projectName are a claim the route checks against the launch
// binding, and ttlMinutes is bounded for every caller of the route.
describe('POST /api/shared-docs/:id/lock binds a member to its verified session and bounds ttlMinutes (#2489)', () => {
  let tmpDir;
  let server;
  let docId;
  let projectA;
  let projectB;
  let bindingA;
  let bindingB;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-lock-caller-'));
    store._setBasePath(tmpDir);
    store.init();

    const group = store.projectGroups.create({ name: 'LockCallerGroup' });
    projectA = store.projects.create({ name: 'caller-a', path: path.join(tmpDir, 'a'), engine: 'claude' });
    projectB = store.projects.create({ name: 'caller-b', path: path.join(tmpDir, 'b'), engine: 'claude' });
    store.projectGroups.addMember(group.id, projectA.id);
    store.projectGroups.addMember(group.id, projectB.id);
    docId = store.sharedDocs.create({ groupId: group.id, name: 'CLAIMED', filePath: path.join(tmpDir, 'claimed.md') }).id;
    bindingA = bindProject(projectA);
    bindingB = bindProject(projectB);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Ask the lock route for a lock as project A's bound session.
   * @param {object} body - The request body
   * @returns {Promise<{ status: number, data: object }>}
   */
  function lockAsA(body) {
    return requestAs(server, 'POST', `/api/shared-docs/${docId}/lock`, bindingA.headers, body);
  }

  /**
   * Assert the document carries no lock, read as project A.
   * @returns {Promise<void>}
   */
  async function assertUnlocked() {
    const { status, data } = await requestAs(server, 'GET', `/api/shared-docs/${docId}/lock`, bindingA.headers);
    assert.equal(status, 200);
    assert.equal(data.locked, false);
  }

  /**
   * Minutes between a lock's acquisition and its expiry, from the route's answer.
   * @param {object} lock - The lock the route answered
   * @returns {number}
   */
  function lockMinutes(lock) {
    const lockedAt = new Date(`${lock.lockedAt.replace(' ', 'T')}Z`).getTime();
    return (new Date(lock.expiresAt).getTime() - lockedAt) / 60000;
  }

  it('refuses a member locking in another session\'s id with 403 LOCK_CALLER_MISMATCH, writing nothing', async () => {
    const { status, data } = await lockAsA({ sessionId: bindingB.sessionId, projectName: projectA.name });
    assert.equal(status, 403);
    assert.equal(data.code, 'LOCK_CALLER_MISMATCH');
    await assertUnlocked();
  });

  it('refuses a member locking in another project\'s name with 403 LOCK_CALLER_MISMATCH, writing nothing', async () => {
    const { status, data } = await lockAsA({ sessionId: bindingA.sessionId, projectName: projectB.name });
    assert.equal(status, 403);
    assert.equal(data.code, 'LOCK_CALLER_MISMATCH');
    await assertUnlocked();
  });

  it('refuses a mismatch without disclosing a lock another member holds', async () => {
    const held = await requestAs(server, 'POST', `/api/shared-docs/${docId}/lock`, bindingB.headers, {
      sessionId: bindingB.sessionId,
      projectName: projectB.name
    });
    assert.equal(held.status, 200);
    const { status, data } = await lockAsA({ sessionId: bindingB.sessionId, projectName: projectB.name });
    assert.equal(status, 403);
    assert.equal(data.code, 'LOCK_CALLER_MISMATCH');
    assert.ok(!JSON.stringify(data).includes(String(held.data.lockedAt)), 'the refusal names nothing of the held lock');
    assert.equal((await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingB.headers)).status, 200);
  });

  it('grants a member its own lock, recorded under its verified session, and lets it release', async () => {
    const { status, data } = await lockAsA({ sessionId: String(bindingA.sessionId), projectName: projectA.name });
    assert.equal(status, 200);
    assert.equal(data.lockedBySession, bindingA.sessionId);
    assert.equal(data.lockedByProject, projectA.name);
    assert.equal((await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingA.headers)).status, 200);
    await assertUnlocked();
  });

  for (const ttlMinutes of [0, -1, 121, 1.5, '30', null]) {
    it(`refuses ttlMinutes ${JSON.stringify(ttlMinutes)} with 400 BAD_REQUEST, writing nothing`, async () => {
      const { status, data } = await lockAsA({ sessionId: bindingA.sessionId, projectName: projectA.name, ttlMinutes });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /ttlMinutes/);
      await assertUnlocked();
    });
  }

  it('refuses an out-of-range ttlMinutes from the operator too', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 4242,
      projectName: 'anyone',
      ttlMinutes: 121
    });
    assert.equal(status, 400);
    assert.equal(data.code, 'BAD_REQUEST');
    await assertUnlocked();
  });

  for (const ttlMinutes of [1, 120]) {
    it(`grants ttlMinutes ${ttlMinutes}, expiring that many minutes after it was taken`, async () => {
      const { status, data } = await lockAsA({ sessionId: bindingA.sessionId, projectName: projectA.name, ttlMinutes });
      assert.equal(status, 200);
      assert.ok(Math.abs(lockMinutes(data) - ttlMinutes) < 0.1, `expected about ${ttlMinutes} minutes, got ${lockMinutes(data)}`);
      assert.equal((await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingA.headers)).status, 200);
    });
  }

  it('grants the 30-minute default when ttlMinutes is omitted', async () => {
    const { status, data } = await lockAsA({ sessionId: bindingA.sessionId, projectName: projectA.name });
    assert.equal(status, 200);
    assert.ok(Math.abs(lockMinutes(data) - 30) < 0.1, `expected about 30 minutes, got ${lockMinutes(data)}`);
    assert.equal((await requestAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, bindingA.headers)).status, 200);
  });

  it('still lets the operator take a lock under any session id it names', async () => {
    const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/lock`, {
      sessionId: 4242,
      projectName: 'operator-named'
    });
    assert.equal(status, 200);
    assert.equal(data.lockedBySession, 4242);
    assert.equal(data.lockedByProject, 'operator-named');
    assert.equal((await request(server, 'DELETE', `/api/shared-docs/${docId}/lock`)).status, 200);
  });
});

// #998 kept a project from being told of a write to a file in its own
// directory, because the broadcast could not know the writer. Since #2389 (A1b)
// a notice follows the delivery rule: the ATTESTED author is never told, and a
// member that subscribed is told of every change, an unattested write to its
// own file included, because it asked. Both are pinned here through real
// listeners.
describe('shared-doc notices never reach the attested author; a subscribing owner hears an unattested write (#998, #2389)', () => {
  const medusa = require('../lib/medusa');
  const OPEN = 1;

  /** Minimal fake WebSocket, enough for the listener to reach `listening`. */
  class FakeWS {
    /** @param {string} url - Requested URL. */
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this._h = Object.create(null); }
    /** @param {string} t - Event type. @param {Function} h - Handler. @returns {void} */
    addEventListener(t, h) { (this._h[t] || (this._h[t] = [])).push(h); }
    /** @param {string} d - Frame. @returns {void} */
    send(d) { this.sent.push(d); }
    /** @returns {void} */
    close() { this.readyState = 3; }
    /** @param {string} t - Event type. @param {object} e - Payload. @returns {void} */
    _fire(t, e) { for (const h of this._h[t] || []) h(e); }
    /** @returns {void} */
    _open() { this.readyState = OPEN; this._fire('open', {}); }
    /** @param {object} o - Inbound frame. @returns {void} */
    _recv(o) { this._fire('message', { data: JSON.stringify(o) }); }
  }

  let tmpDir;
  let server;
  let ownerSessionId;
  let peerSessionId;
  let ownerId;
  let peerId;
  let groupId;
  let docId;
  let docPath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shareddoc-self-'));
    store._setBasePath(tmpDir);
    store.init();

    const group = store.projectGroups.create({ name: 'SelfNudgeGroup' });

    // The reproduction from #998: the doc lives INSIDE a member project, so
    // that project editing its own file broadcasts a message back to itself.
    const ownerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doc-owner-'));
    const peerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doc-peer-'));
    docPath = path.join(ownerPath, 'ROADMAP_STATE.md');
    fs.writeFileSync(docPath, '# state\n');

    // Membership through `addMember`, the way the API establishes it. Passing
    // `groupId` to `projects.create` looks like it joins the group and does
    // not — `create` silently ignores the key, exactly as `list` did (#1222).
    // So these two projects were in NO group, and this suite's "the peer must
    // still be notified" could only pass because the broadcast notified every
    // project on the machine. Fixing the fixture makes the assertion mean what
    // it always said; it does not weaken it.
    const owner = store.projects.create({ name: 'doc-owner', path: ownerPath, engine: 'claude' });
    const peer = store.projects.create({ name: 'doc-peer', path: peerPath, engine: 'claude' });
    store.projectGroups.addMember(group.id, owner.id);
    store.projectGroups.addMember(group.id, peer.id);
    ownerId = owner.id;
    peerId = peer.id;
    groupId = group.id;

    const doc = store.sharedDocs.create({
      groupId: group.id, name: 'ROADMAP_STATE', filePath: docPath,
      injectIntoConfig: false, injectMode: 'reference'
    });

    // A live, listening session in each project.
    for (const [proj, assign] of [[owner, (id) => { ownerSessionId = id; }], [peer, (id) => { peerSessionId = id; }]]) {
      const sess = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: `tc-${proj.name}` });
      assign(sess.id);
      let fake;
      const { workspaceId } = medusa.startSession({
        projectPath: proj.path, sessionId: sess.id, name: proj.name,
        wsFactory: (u) => (fake = new FakeWS(u))
      });
      fake._open();
      fake._recv({ type: 'registered', workspaceId, connectionId: 'c1' });
    }

    docId = doc.id;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // The baseline every test below changes.
    await request(server, 'POST', `/api/shared-docs/${docId}/notify`);
  });

  after(async () => {
    for (const { watcher } of _sharedDocWatchers.values()) watcher.close();
    for (const timer of _sharedDocDebounceTimers.values()) clearTimeout(timer);
    medusa.stopSession(ownerSessionId);
    medusa.stopSession(peerSessionId);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // No Bridge is up in tests, so every ATTEMPTED send fails and names its
  // session — which makes the error list an honest record of who was tried.

  it('the attested author is never tried, even when its directory holds the file and it subscribed', async () => {
    const sharedDocRecord = require('../lib/shared-docs');
    for (const projectId of [ownerId, peerId]) {
      store.sharedDocNoticePrefs.set({ projectId, groupId, setting: 'subscribe' });
    }
    try {
      const base = (await sharedDocRecord.captureBase(docId)).sha256;
      const content = '# state\n\nthe owner\'s attested edit\n';
      fs.writeFileSync(docPath, content);
      const outcome = await sharedDocRecord.attest(docId, {
        baseSha256: base, sha256: sharedDocRecord.sha256(Buffer.from(content)),
        projectId: ownerId, sessionId: ownerSessionId, recheck: () => null
      });
      assert.equal(outcome.status, 200);
      const tried = (await outcome.delivery).errors.join(' ');
      assert.ok(tried.includes(`session ${peerSessionId}`), 'the subscribing peer must still be told');
      assert.ok(!tried.includes(`session ${ownerSessionId}`),
        'the attested author must never be told about its own write, whatever it subscribed to');
    } finally {
      for (const projectId of [ownerId, peerId]) {
        store.sharedDocNoticePrefs.set({ projectId, groupId, setting: 'default' });
      }
    }
  });

  it('the project whose directory holds the file IS tried for an unattested write when it subscribed, and the peer that did not is not', async () => {
    store.sharedDocNoticePrefs.set({ projectId: ownerId, groupId, setting: 'subscribe' });
    try {
      fs.appendFileSync(docPath, 'an unattested write\n');
      const { status, data } = await request(server, 'POST', `/api/shared-docs/${docId}/notify`);
      assert.equal(status, 200);
      const tried = (data.errors || []).join(' ');
      assert.ok(tried.includes(`session ${ownerSessionId}`),
        'the writer is unknown, and a subscriber asked for every change, its own included');
      assert.ok(!tried.includes(`session ${peerSessionId}`),
        'a member that did not subscribe is not told of an unknown author\'s write');
    } finally {
      store.sharedDocNoticePrefs.set({ projectId: ownerId, groupId, setting: 'default' });
    }
  });
});
