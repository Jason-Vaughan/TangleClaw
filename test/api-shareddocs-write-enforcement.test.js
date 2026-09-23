'use strict';

// #1626: the shared-docs and groups WRITE routes. A bound project may register,
// lock, unlock, notify and sync only within its own groups; editing or deleting
// a document and managing groups and members are the operator's alone, because
// a document's `filePath` decides which file is injected into every member
// project's engine config. The Project Master reads everything and writes
// nothing. Every request goes to an in-process server over a scratch store; the
// Master's tmux read is stubbed so no test consults a live pane.

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const master = require('../lib/master');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

const MASTER_LAUNCH_ID = 'master-live-launch-id';
const MASTER_HEADERS = { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID };

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object|null} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, raw: string, data: object}>}
 */
function send(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        resolve({ status: res.statusCode, raw, data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('#1626 shared-docs and groups writes', () => {
  let tmpDir;
  let server;
  let groupA;
  let groupB;
  let docA;
  let docB;
  let projectA;
  let projectB;
  let bindingA;
  let bindingB;
  let secretsOfB;

  /** The writes a project may make within its own groups, aimed at group A. */
  const memberWrites = () => [
    { method: 'POST', path: '/api/shared-docs', body: { groupId: groupA.id, name: `REG-${Date.now()}-${Math.random()}`, filePath: path.join(tmpDir, 'reg.md') } },
    { method: 'POST', path: `/api/shared-docs/${docA.id}/lock`, body: { sessionId: bindingA.sessionId, projectName: projectA.name } },
    { method: 'DELETE', path: `/api/shared-docs/${docA.id}/lock`, body: null },
    { method: 'POST', path: `/api/shared-docs/${docA.id}/notify`, body: null },
    { method: 'POST', path: `/api/groups/${groupA.id}/sync`, body: null }
  ];

  /** The writes only the operator may make, aimed at group A and its document. */
  const operatorWrites = () => [
    { method: 'PUT', path: `/api/shared-docs/${docA.id}`, body: { filePath: '/etc/elsewhere.md' } },
    { method: 'DELETE', path: `/api/shared-docs/${docA.id}`, body: null },
    { method: 'POST', path: '/api/groups', body: { name: 'a-new-group' } },
    { method: 'PUT', path: `/api/groups/${groupA.id}`, body: { name: 'renamed' } },
    { method: 'DELETE', path: `/api/groups/${groupA.id}`, body: null },
    { method: 'POST', path: `/api/groups/${groupA.id}/members`, body: { projectId: projectB.id } },
    { method: 'DELETE', path: `/api/groups/${groupA.id}/members/${projectA.id}`, body: null }
  ];

  /**
   * What the operator-only writes would have changed, so a refused write can be
   * shown to have changed nothing.
   * @returns {object}
   */
  const snapshot = () => ({
    docA: store.sharedDocs.get(docA.id),
    groups: store.projectGroups.list().map((g) => ({ id: g.id, name: g.name })),
    membersA: store.projectGroups.listMembers(groupA.id)
  });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shareddocs-write-'));
    store._setBasePath(tmpDir);
    store.init();

    const mkProject = (name) => {
      const dir = path.join(tmpDir, `${name}-only-dir`);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };
    projectA = mkProject('project-a');
    projectB = mkProject('project-b');

    const sharedDirA = path.join(tmpDir, 'shared-a');
    const sharedDirB = path.join(tmpDir, 'shared-b-only-dir');
    fs.mkdirSync(sharedDirA);
    fs.mkdirSync(sharedDirB);
    groupA = store.projectGroups.create({ name: 'group-a', sharedDir: sharedDirA });
    groupB = store.projectGroups.create({ name: 'group-b', sharedDir: sharedDirB });
    store.projectGroups.addMember(groupA.id, projectA.id);
    store.projectGroups.addMember(groupB.id, projectB.id);
    docA = store.sharedDocs.create({ groupId: groupA.id, name: 'A-DOC', filePath: path.join(tmpDir, 'a-doc-path.md') });
    docB = store.sharedDocs.create({ groupId: groupB.id, name: 'B-DOC', filePath: path.join(tmpDir, 'b-doc-path.md') });
    secretsOfB = [groupB.id, docB.id, docB.filePath, projectB.path, sharedDirB];

    bindingA = bindProject(projectA);
    bindingB = bindProject(projectB);

    mock.method(master, 'liveMasterLaunchId', () => ({ launchId: MASTER_LAUNCH_ID, answered: true, cause: null }));

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('authorized same-group', () => {
    it('a bound project registers, locks, unlocks, notifies and syncs within its own group', async () => {
      const reg = await send(server, 'POST', '/api/shared-docs',
        { groupId: groupA.id, name: 'A-REGISTERED', filePath: path.join(tmpDir, 'a-registered.md') }, bindingA.headers);
      assert.equal(reg.status, 201, reg.raw);
      assert.equal(reg.data.groupId, groupA.id);

      const lock = await send(server, 'POST', `/api/shared-docs/${docA.id}/lock`,
        { sessionId: bindingA.sessionId, projectName: projectA.name }, bindingA.headers);
      assert.equal(lock.status, 200, lock.raw);
      assert.ok(store.documentLocks.check(docA.id), 'the lock is held');

      const unlock = await send(server, 'DELETE', `/api/shared-docs/${docA.id}/lock`, null, bindingA.headers);
      assert.equal(unlock.status, 200, unlock.raw);
      assert.equal(store.documentLocks.check(docA.id), null, 'the lock is released');

      const notify = await send(server, 'POST', `/api/shared-docs/${docA.id}/notify`, null, bindingA.headers);
      assert.equal(notify.status, 200, notify.raw);

      const sync = await send(server, 'POST', `/api/groups/${groupA.id}/sync`, null, bindingA.headers);
      assert.equal(sync.status, 200, sync.raw);
    });
  });

  describe('missing binding', () => {
    it('every member write is refused with the binding fix, before looking anything up', async () => {
      const routes = [...memberWrites(),
        { method: 'POST', path: '/api/shared-docs/no-such-doc/lock', body: { sessionId: 1, projectName: 'x' } },
        { method: 'POST', path: '/api/groups/no-such-group/sync', body: null }];
      for (const r of routes) {
        const res = await send(server, r.method, r.path, r.body);
        assert.equal(res.status, 403, `${r.method} ${r.path}`);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_REQUIRED', `${r.method} ${r.path}`);
        assert.match(res.data.error, /TANGLECLAW_LAUNCH_ID/, `${r.method} ${r.path} names the fix`);
      }
    });

    it('every operator-only write is refused as operator-only, since no binding would help', async () => {
      const before = snapshot();
      for (const r of operatorWrites()) {
        const res = await send(server, r.method, r.path, r.body);
        assert.equal(res.status, 403, `${r.method} ${r.path}`);
        assert.equal(res.data.code, 'OPERATOR_ONLY', `${r.method} ${r.path}`);
      }
      assert.deepEqual(snapshot(), before, 'a refused write changes nothing');
    });
  });

  describe('invalid binding', () => {
    it('an unknown, mismatched or ended binding is refused on every member write', async () => {
      const dir = path.join(tmpDir, 'ended-project-dir');
      fs.mkdirSync(dir);
      const ended = store.projects.create({ name: 'ended-project', path: dir, engine: 'claude' });
      store.projectGroups.addMember(groupA.id, ended.id);
      const endedBinding = bindProject(ended);
      store.sessions.kill(endedBinding.sessionId, 'test');

      const cases = [
        [{ 'x-tangleclaw-project-id': String(projectA.id), 'x-tangleclaw-launch-id': 'not-a-launch' }, /unknown-launch/],
        [{ 'x-tangleclaw-project-id': String(projectB.id), 'x-tangleclaw-launch-id': bindingA.launchId }, /project-mismatch/],
        [endedBinding.headers, /session-not-active/]
      ];
      for (const [headers, reason] of cases) {
        for (const r of memberWrites()) {
          const res = await send(server, r.method, r.path, r.body, headers);
          assert.equal(res.status, 403, `${r.method} ${r.path}`);
          assert.equal(res.data.code, 'SHARED_DOCS_BINDING_INVALID', `${r.method} ${r.path}`);
          assert.match(res.data.error, reason, `${r.method} ${r.path}`);
        }
      }
      store.projectGroups.removeMember(groupA.id, ended.id);
    });
  });

  describe('cross-group', () => {
    it('writes into another group answer 404, exactly like ids that do not exist, and change nothing', async () => {
      const docsInB = store.sharedDocs.getByGroup(groupB.id).length;
      const pairs = [
        [{ method: 'POST', path: '/api/shared-docs', body: { groupId: groupB.id, name: 'SNEAK', filePath: '/tmp/sneak.md' } },
          { method: 'POST', path: '/api/shared-docs', body: { groupId: 'no-such-group', name: 'SNEAK', filePath: '/tmp/sneak.md' } }],
        [{ method: 'POST', path: `/api/shared-docs/${docB.id}/lock`, body: { sessionId: bindingA.sessionId, projectName: projectA.name } },
          { method: 'POST', path: '/api/shared-docs/no-such-doc/lock', body: { sessionId: bindingA.sessionId, projectName: projectA.name } }],
        [{ method: 'DELETE', path: `/api/shared-docs/${docB.id}/lock`, body: null },
          { method: 'DELETE', path: '/api/shared-docs/no-such-doc/lock', body: null }],
        [{ method: 'POST', path: `/api/shared-docs/${docB.id}/notify`, body: null },
          { method: 'POST', path: '/api/shared-docs/no-such-doc/notify', body: null }],
        [{ method: 'POST', path: `/api/groups/${groupB.id}/sync`, body: null },
          { method: 'POST', path: '/api/groups/no-such-group/sync', body: null }]
      ];
      for (const [theirs, missing] of pairs) {
        const label = `${theirs.method} ${theirs.path}`;
        const res = await send(server, theirs.method, theirs.path, theirs.body, bindingA.headers);
        const absent = await send(server, missing.method, missing.path, missing.body, bindingA.headers);
        assert.equal(res.status, 404, label);
        assert.equal(res.data.code, 'NOT_FOUND', label);
        assert.equal(absent.status, 404, `${missing.method} ${missing.path}`);
        assert.deepEqual(Object.keys(res.data).sort(), Object.keys(absent.data).sort(), `${label} is shaped like a missing id`);
        // The only B value a 404 may carry is the id the caller itself sent.
        const sent = JSON.stringify(theirs);
        for (const secret of secretsOfB.filter((s) => !sent.includes(s))) {
          assert.ok(!res.raw.includes(secret), `${label} leaked "${secret}"`);
        }
      }
      assert.equal(store.sharedDocs.getByGroup(groupB.id).length, docsInB, 'nothing was registered into group B');
      assert.equal(store.documentLocks.check(docB.id), null, 'group B\'s document was not locked');
    });

    it('a project cannot release a lock another group\'s project holds', async () => {
      store.documentLocks.acquire(docB.id, bindingB.sessionId, projectB.name);
      const res = await send(server, 'DELETE', `/api/shared-docs/${docB.id}/lock`, null, bindingA.headers);
      assert.equal(res.status, 404);
      assert.ok(store.documentLocks.check(docB.id), 'the lock is still held');
      store.documentLocks.release(docB.id);
    });
  });

  describe('operator-only writes', () => {
    it('a bound project in the group cannot repoint its own group\'s document, or delete it', async () => {
      const put = await send(server, 'PUT', `/api/shared-docs/${docA.id}`, { filePath: '/etc/elsewhere.md' }, bindingA.headers);
      assert.equal(put.status, 403);
      assert.equal(put.data.code, 'OPERATOR_ONLY');
      assert.equal(store.sharedDocs.get(docA.id).filePath, docA.filePath, 'the injected file is unchanged');

      const del = await send(server, 'DELETE', `/api/shared-docs/${docA.id}`, null, bindingA.headers);
      assert.equal(del.status, 403);
      assert.equal(del.data.code, 'OPERATOR_ONLY');
      assert.ok(store.sharedDocs.get(docA.id), 'the document still exists');
    });

    it('a bound project cannot create, change or delete a group or its members', async () => {
      const before = snapshot();
      for (const r of operatorWrites()) {
        const res = await send(server, r.method, r.path, r.body, bindingA.headers);
        assert.equal(res.status, 403, `${r.method} ${r.path}`);
        assert.equal(res.data.code, 'OPERATOR_ONLY', `${r.method} ${r.path}`);
        assert.match(res.data.error, /operator/i, `${r.method} ${r.path} says who can`);
      }
      assert.deepEqual(snapshot(), before, 'a refused write changes nothing');
    });

    it('a refusal is logged with what the route needed, and never with the launch id', async () => {
      const lines = [];
      const logger = require('../lib/logger');
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
      try {
        await send(server, 'PUT', `/api/shared-docs/${docA.id}`, { filePath: '/etc/elsewhere.md' }, bindingA.headers);
      } finally {
        logger.setConsoleStream(process.stderr);
        logger.setLevel('error');
      }
      const refused = lines.filter((l) => l.includes('Shared-docs caller refused'));
      assert.equal(refused.length, 1, lines.join(''));
      assert.match(refused[0], /OPERATOR_ONLY/);
      assert.match(refused[0], /need=operator/);
      assert.ok(!refused[0].includes(bindingA.launchId), 'the binding itself is never logged');
    });
  });

  describe('the Project Master writes nothing', () => {
    it('every member write is refused as read-only', async () => {
      for (const r of memberWrites()) {
        const res = await send(server, r.method, r.path, r.body, MASTER_HEADERS);
        assert.equal(res.status, 403, `${r.method} ${r.path}`);
        assert.equal(res.data.code, 'SHARED_DOCS_READ_ONLY', `${r.method} ${r.path}`);
      }
      assert.equal(store.documentLocks.check(docA.id), null, 'nothing was locked');
    });

    it('every operator-only write is refused as operator-only', async () => {
      const before = snapshot();
      for (const r of operatorWrites()) {
        const res = await send(server, r.method, r.path, r.body, MASTER_HEADERS);
        assert.equal(res.status, 403, `${r.method} ${r.path}`);
        assert.equal(res.data.code, 'OPERATOR_ONLY', `${r.method} ${r.path}`);
      }
      assert.deepEqual(snapshot(), before, 'a refused write changes nothing');
    });
  });

  describe('the operator keeps every write', () => {
    it('edits and locks a document in any group, and manages groups and members', async () => {
      const op = operatorHeaders(server);
      const put = await send(server, 'PUT', `/api/shared-docs/${docB.id}`, { filePath: path.join(tmpDir, 'b-moved.md') }, op);
      assert.equal(put.status, 200, put.raw);
      assert.equal(store.sharedDocs.get(docB.id).filePath, path.join(tmpDir, 'b-moved.md'));

      const lock = await send(server, 'POST', `/api/shared-docs/${docB.id}/lock`, { sessionId: 1, projectName: 'operator' }, op);
      assert.equal(lock.status, 200, lock.raw);
      const unlock = await send(server, 'DELETE', `/api/shared-docs/${docB.id}/lock`, null, op);
      assert.equal(unlock.status, 200, unlock.raw);

      const created = await send(server, 'POST', '/api/groups', { name: 'operator-group' }, op);
      assert.equal(created.status, 201, created.raw);
      const member = await send(server, 'POST', `/api/groups/${created.data.id}/members`, { projectId: projectA.id }, op);
      assert.equal(member.status, 200, member.raw);
      const removed = await send(server, 'DELETE', `/api/groups/${created.data.id}/members/${projectA.id}`, null, op);
      assert.equal(removed.status, 200, removed.raw);
      const deleted = await send(server, 'DELETE', `/api/groups/${created.data.id}`, null, op);
      assert.equal(deleted.status, 200, deleted.raw);
    });
  });
});
