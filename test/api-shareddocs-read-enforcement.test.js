'use strict';

// #1626: the shared-docs and groups READ routes answer only a caller bound to
// a project, and a bound project sees only the groups it belongs to. The four
// classes the acceptance gate names — authorized same-group, missing binding,
// invalid binding, cross-group — plus the Master and `tc docs` callers that
// must keep working. Every request goes to an in-process server over a scratch
// store; the Master's tmux read is stubbed so no test consults a live pane.

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const master = require('../lib/master');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');
const MASTER_LAUNCH_ID = 'master-live-launch-id';

/**
 * GET a path from the test server.
 * @param {http.Server} server
 * @param {string} urlPath
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, raw: string, data: object}>}
 */
function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET', headers
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
    req.end();
  });
}

/**
 * Run bin/tc asynchronously: the server answers on this event loop, so a sync
 * spawn would deadlock.
 * @param {string[]} args
 * @param {object} env
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runTc(args, env) {
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('#1626 shared-docs and groups reads answer only a bound caller', () => {
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
  // Values that exist only in group B, so their presence anywhere in a body
  // group A's caller receives is the disclosure the fix closes.
  let secretsOfB;

  /** Every read route, given the ids it names. */
  const readRoutes = () => [
    '/api/shared-docs',
    `/api/shared-docs?groupId=${groupA.id}`,
    `/api/shared-docs/${docA.id}`,
    `/api/shared-docs/${docA.id}/lock`,
    '/api/groups',
    `/api/groups/${groupA.id}`,
    `/api/groups/${groupA.id}/members`
  ];

  /**
   * Assert that none of group B's ids or absolute paths appear in a body.
   * @param {string} raw - Response body
   * @param {string} route - For the failure message
   */
  const assertNothingOfB = (raw, route) => {
    for (const secret of secretsOfB) {
      assert.ok(!raw.includes(secret), `${route} leaked "${secret}" from group B`);
    }
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shareddocs-read-'));
    store._setBasePath(tmpDir);
    store.init();

    const mkProject = (name) => {
      const dir = path.join(tmpDir, `${name}-only-dir`);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };
    projectA = mkProject('project-a');
    projectB = mkProject('project-b');

    groupA = store.projectGroups.create({ name: 'group-a' });
    groupB = store.projectGroups.create({ name: 'group-b' });
    store.projectGroups.addMember(groupA.id, projectA.id);
    store.projectGroups.addMember(groupB.id, projectB.id);
    docA = store.sharedDocs.create({ groupId: groupA.id, name: 'A-DOC', filePath: path.join(tmpDir, 'a-doc-path.md') });
    docB = store.sharedDocs.create({ groupId: groupB.id, name: 'B-DOC', filePath: path.join(tmpDir, 'b-doc-path.md') });
    secretsOfB = [groupB.id, docB.id, docB.filePath, projectB.path];

    bindingA = bindProject(projectA);
    bindingB = bindProject(projectB);

    // The Master's binding lives in its tmux session; stand one in so a
    // Master claim is judged without reaching this machine's real tmux.
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
    it('the bare list is the caller\'s own groups\' documents, not the install-wide list', async () => {
      const res = await get(server, '/api/shared-docs', bindingA.headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.docs.map((d) => d.id), [docA.id]);
      assertNothingOfB(res.raw, 'GET /api/shared-docs');
    });

    it('the groupId form answers for a group the caller is in', async () => {
      const res = await get(server, `/api/shared-docs?groupId=${groupA.id}`, bindingA.headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.docs.map((d) => d.id), [docA.id]);
    });

    it('lists only the caller\'s own groups', async () => {
      const res = await get(server, '/api/groups', bindingA.headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.groups.map((g) => g.id), [groupA.id]);
      assertNothingOfB(res.raw, 'GET /api/groups');
    });

    it('reads its own group, its members, its document and the document\'s lock', async () => {
      const group = await get(server, `/api/groups/${groupA.id}`, bindingA.headers);
      assert.equal(group.status, 200);
      assert.deepEqual(group.data.members.map((m) => m.id), [projectA.id]);
      assert.deepEqual(group.data.docs.map((d) => d.id), [docA.id]);

      const members = await get(server, `/api/groups/${groupA.id}/members`, bindingA.headers);
      assert.equal(members.status, 200);
      assert.deepEqual(members.data.members.map((m) => m.id), [projectA.id]);

      const doc = await get(server, `/api/shared-docs/${docA.id}`, bindingA.headers);
      assert.equal(doc.status, 200);
      assert.equal(doc.data.id, docA.id);

      const lock = await get(server, `/api/shared-docs/${docA.id}/lock`, bindingA.headers);
      assert.equal(lock.status, 200);
      assert.equal(lock.data.locked, false);
    });
  });

  describe('missing binding', () => {
    it('every read route refuses a request with no headers, before looking anything up', async () => {
      for (const route of readRoutes()) {
        const res = await get(server, route);
        assert.equal(res.status, 403, route);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_REQUIRED', route);
        assert.match(res.data.error, /TANGLECLAW_LAUNCH_ID/, `${route} names the fix`);
      }
    });

    it('a project claim with no launch id is not a binding', async () => {
      for (const route of readRoutes()) {
        const res = await get(server, route, { 'x-tangleclaw-project-id': String(projectA.id) });
        assert.equal(res.status, 403, route);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_REQUIRED', route);
      }
    });

    it('the Master role header with no launch id is not a binding', async () => {
      const res = await get(server, '/api/shared-docs', { 'x-tangleclaw-role': 'master' });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'SHARED_DOCS_BINDING_REQUIRED');
    });
  });

  describe('invalid binding', () => {
    it('an unknown launch id is refused on every read route', async () => {
      const headers = { 'x-tangleclaw-project-id': String(projectA.id), 'x-tangleclaw-launch-id': 'not-a-launch' };
      for (const route of readRoutes()) {
        const res = await get(server, route, headers);
        assert.equal(res.status, 403, route);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_INVALID', route);
        assert.match(res.data.error, /unknown-launch/, route);
      }
    });

    it('a launch id presented under another project\'s id is refused, not re-scoped', async () => {
      const headers = { 'x-tangleclaw-project-id': String(projectB.id), 'x-tangleclaw-launch-id': bindingA.launchId };
      for (const route of readRoutes()) {
        const res = await get(server, route, headers);
        assert.equal(res.status, 403, route);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_INVALID', route);
        assert.match(res.data.error, /project-mismatch/, route);
      }
    });

    it('a launch whose session has ended is refused', async () => {
      const dir = path.join(tmpDir, 'ended-project-dir');
      fs.mkdirSync(dir);
      const ended = store.projects.create({ name: 'ended-project', path: dir, engine: 'claude' });
      store.projectGroups.addMember(groupA.id, ended.id);
      const binding = bindProject(ended);
      assert.equal((await get(server, '/api/shared-docs', binding.headers)).status, 200, 'live before the kill');

      store.sessions.kill(binding.sessionId, 'test');
      for (const route of readRoutes()) {
        const res = await get(server, route, binding.headers);
        assert.equal(res.status, 403, route);
        assert.equal(res.data.code, 'SHARED_DOCS_BINDING_INVALID', route);
        assert.match(res.data.error, /session-not-active/, route);
      }
      store.projectGroups.removeMember(groupA.id, ended.id);
    });

    it('a stale Master launch id is refused', async () => {
      const res = await get(server, '/api/shared-docs', {
        'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'a-replaced-master-id'
      });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'SHARED_DOCS_BINDING_INVALID');
      assert.match(res.data.error, /master-launch-stale/);
    });
  });

  describe('cross-group', () => {
    it('another group\'s id, document and members answer 404, exactly like ids that do not exist', async () => {
      const pairs = [
        [`/api/groups/${groupB.id}`, '/api/groups/no-such-group'],
        [`/api/groups/${groupB.id}/members`, '/api/groups/no-such-group/members'],
        [`/api/shared-docs?groupId=${groupB.id}`, '/api/shared-docs?groupId=no-such-group'],
        [`/api/shared-docs/${docB.id}`, '/api/shared-docs/no-such-doc'],
        [`/api/shared-docs/${docB.id}/lock`, '/api/shared-docs/no-such-doc/lock']
      ];
      for (const [theirs, missing] of pairs) {
        const res = await get(server, theirs, bindingA.headers);
        const absent = await get(server, missing, bindingA.headers);
        assert.equal(res.status, 404, theirs);
        assert.equal(res.data.code, 'NOT_FOUND', theirs);
        assert.equal(absent.status, 404, missing);
        assert.deepEqual(Object.keys(res.data).sort(), Object.keys(absent.data).sort(),
          `${theirs} is shaped like a missing id`);
        // The only B value a 404 may carry is the id the caller itself sent.
        for (const secret of secretsOfB.filter((s) => !theirs.includes(s))) {
          assert.ok(!res.raw.includes(secret), `${theirs} leaked "${secret}"`);
        }
      }
    });

    it('group B\'s own caller sees group B, and not group A', async () => {
      const res = await get(server, '/api/shared-docs', bindingB.headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.docs.map((d) => d.id), [docB.id]);
      assert.ok(!res.raw.includes(docA.filePath));
    });

    it('a project in no group sees an empty list, not the install\'s', async () => {
      const dir = path.join(tmpDir, 'loner-dir');
      fs.mkdirSync(dir);
      const loner = bindProject(store.projects.create({ name: 'loner', path: dir, engine: 'claude' }));
      const docs = await get(server, '/api/shared-docs', loner.headers);
      assert.equal(docs.status, 200);
      assert.deepEqual(docs.data.docs, []);
      const groups = await get(server, '/api/groups', loner.headers);
      assert.equal(groups.status, 200);
      assert.deepEqual(groups.data.groups, []);
    });
  });

  describe('callers that keep their access', () => {
    it('the bound Project Master still reads every group', async () => {
      const headers = { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_LAUNCH_ID };
      const docs = await get(server, '/api/shared-docs', headers);
      assert.equal(docs.status, 200);
      assert.deepEqual(docs.data.docs.map((d) => d.id).sort(), [docA.id, docB.id].sort());
      const groups = await get(server, '/api/groups', headers);
      assert.equal(groups.status, 200);
      assert.deepEqual(groups.data.groups.map((g) => g.id).sort(), [groupA.id, groupB.id].sort());
      const group = await get(server, `/api/groups/${groupB.id}`, headers);
      assert.equal(group.status, 200);
    });

    it('the operator\'s dashboard still reads every group', async () => {
      const docs = await get(server, '/api/shared-docs', operatorHeaders(server));
      assert.equal(docs.status, 200);
      assert.deepEqual(docs.data.docs.map((d) => d.id).sort(), [docA.id, docB.id].sort());
      const groups = await get(server, '/api/groups', operatorHeaders(server));
      assert.deepEqual(groups.data.groups.map((g) => g.id).sort(), [groupA.id, groupB.id].sort());
    });

    it('`tc docs` from a project pane lists that project\'s documents only', async () => {
      const res = await runTc(['docs'], {
        ...process.env,
        TANGLECLAW_API: `http://127.0.0.1:${server.address().port}`,
        TANGLECLAW_PROJECT_ID: String(projectA.id),
        TANGLECLAW_LAUNCH_ID: bindingA.launchId
      });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /A-DOC/);
      assert.ok(!res.stdout.includes('B-DOC'));
      assert.ok(!res.stdout.includes(docB.filePath));
    });

    it('`tc docs` from the Master pane lists every group\'s documents', async () => {
      const env = { ...process.env, TANGLECLAW_API: `http://127.0.0.1:${server.address().port}`,
        TANGLECLAW_ROLE: 'master', TANGLECLAW_LAUNCH_ID: MASTER_LAUNCH_ID };
      delete env.TANGLECLAW_PROJECT_ID;
      const res = await runTc(['docs'], env);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /A-DOC/);
      assert.match(res.stdout, /B-DOC/);
    });
  });
});
