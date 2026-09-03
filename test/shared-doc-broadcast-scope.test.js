'use strict';

/*
 * #1222 — a shared-doc update must reach only the doc's own group.
 *
 * `broadcastSharedDocUpdate` looked scoped and was not. It called
 * `store.projects.list({ groupId: doc.groupId })`, but `projectsApi.list`
 * handles `archived`, `engine` and `tag` and silently ignores every other key
 * — so it returned every non-archived project on the machine, and the
 * broadcast reached every live session in every project, in every group.
 *
 * Nothing caught it because the function had no tests at all, and because the
 * shape reads correct: the variable was named `projectsInGroup`, and the #998
 * owner exclusion sitting directly below it is real and works — so the one
 * session it visibly withheld from was the doc's own owner. Observed in the
 * field as five wakes into an unrelated session in 37 minutes, each one a
 * `medusa-wake` that types into a live pane.
 *
 * THE test here is the negative one: a live session in a project OUTSIDE the
 * group, asserted not notified. A fixture with only in-group sessions passes
 * against the broken code, which is exactly why the bug survived.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const { createServer } = require('../server');

/**
 * POST to the test server and resolve its parsed response.
 * @param {http.Server} server - Listening server.
 * @param {string} urlPath - Path to request.
 * @returns {Promise<{status: number, body: object}>} The response.
 */
function post(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Length': 0 } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = body; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('shared-doc broadcasts stay inside the doc\'s group (#1222)', () => {
  let tmpDir;
  let server;
  let inGroup;      // member of the group, does not own the doc → notified
  let owner;        // member whose directory holds the doc → excluded (#998)
  let outsider;     // NOT a member → must never hear about it
  let docId;
  let sent;
  let realSend;
  let realGetStatus;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doc-scope-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    /**
     * Create a project with a real directory.
     * @param {string} name - Project name.
     * @returns {object} The created project record.
     */
    const mkProject = (name) => {
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };

    inGroup = mkProject('in-group');
    owner = mkProject('doc-owner');
    outsider = mkProject('outsider');

    const group = store.projectGroups.create({ name: 'scoped-group' });
    store.projectGroups.addMember(group.id, inGroup.id);
    store.projectGroups.addMember(group.id, owner.id);
    // `outsider` is deliberately NOT added.

    // The doc lives inside `owner`, so the #998 exclusion applies to it.
    const docPath = path.join(owner.path, 'SHARED.md');
    fs.writeFileSync(docPath, '# shared\n');
    const doc = store.sharedDocs.create({
      groupId: group.id, name: 'SHARED', filePath: docPath
    });
    docId = doc.id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    medusa.sendSystemMessage = realSend;
    medusa.getStatus = realGetStatus;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A live session in EVERY project, each with a listening Medusa workspace.
    // The filter under test is the only thing that can tell them apart.
    for (const p of [inGroup, owner, outsider]) {
      const active = store.sessions.getActive(p.id);
      if (active) store.sessions.kill(active.id, 'test reset');
      store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: `s-${p.name}` });
    }

    sent = [];
    realSend = realSend || medusa.sendSystemMessage;
    realGetStatus = realGetStatus || medusa.getStatus;
    medusa.getStatus = (sessionId) => ({
      state: 'listening', workspaceId: `ws-${sessionId}`, unread: 0, lastError: null
    });
    medusa.sendSystemMessage = async ({ to, message }) => { sent.push({ to, message }); };
  });

  /**
   * The workspace id the stub mints for a project's live session.
   * @param {object} project - Project record.
   * @returns {string} Its workspace id.
   */
  const wsFor = (project) => `ws-${store.sessions.getActive(project.id).id}`;

  it('does NOT notify a live session whose project is not in the group', async () => {
    const res = await post(server, `/api/shared-docs/${docId}/notify`);
    assert.equal(res.status, 200);

    const recipients = sent.map((m) => m.to);
    assert.ok(!recipients.includes(wsFor(outsider)),
      'a project sharing no group with the doc must not be told the doc exists, let alone that it changed');
  });

  it('still notifies the group member that does not own the doc', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);

    const recipients = sent.map((m) => m.to);
    assert.ok(recipients.includes(wsFor(inGroup)),
      'scoping must not become silence — the members are the whole point');
  });

  it('still excludes the owning project (#998 holds)', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);

    const recipients = sent.map((m) => m.to);
    assert.ok(!recipients.includes(wsFor(owner)),
      'a project must not be woken about a file in its own directory');
  });

  it('notifies exactly the group, and the count it reports is the count it sent', async () => {
    const res = await post(server, `/api/shared-docs/${docId}/notify`);

    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)],
      'one member, one message — not "every live session minus the owner"');
    assert.equal(res.body.notifiedCount, sent.length,
      'the route\'s own number must match what actually went out');
  });

  it('an archived member still counts as the owner, so archiving cannot re-open the #998 wake', async () => {
    // The fix resolves members by id rather than filtering `projects.list()`,
    // which defaults to excluding archived projects. Filtering that list would
    // drop an archived owner from the exclusion set and wake it about its own
    // file — the #998 defect through a new door.
    // `update()` does not handle `archived` — there is a dedicated `archive()`.
    // Written the other way first, this test archived nothing, and the mutation
    // it exists to catch stayed green against a fixture that never reached the
    // subject.
    const ownerWs = wsFor(owner);
    store.projects.archive(owner.id);
    try {
      assert.equal(store.projects.get(owner.id).archived, true,
        'the fixture must actually archive, or this test measures nothing');
      await post(server, `/api/shared-docs/${docId}/notify`);
      const recipients = sent.map((m) => m.to);
      assert.ok(!recipients.includes(ownerWs),
        'an archived owner is still the owner');
    } finally {
      store.projects.unarchive(owner.id);
    }
  });

  it('a doc whose group has no members notifies nobody, rather than everybody', async () => {
    const empty = store.projectGroups.create({ name: 'empty-group' });
    const docPath = path.join(tmpDir, 'ORPHAN.md');
    fs.writeFileSync(docPath, '# orphan\n');
    const orphan = store.sharedDocs.create({
      groupId: empty.id, name: 'ORPHAN', filePath: docPath
    });

    const res = await post(server, `/api/shared-docs/${orphan.id}/notify`);

    assert.deepEqual(sent, [],
      'an empty membership is zero recipients — the broken code made it every session on the machine');
    assert.equal(res.body.notifiedCount, 0);
  });
});
