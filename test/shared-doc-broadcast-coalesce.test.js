'use strict';

/*
 * #1108, half one — one broadcast per reader per quiet period.
 *
 * `server.js` debounces the `fs.watch` broadcast per DOCUMENT at 500 ms, which
 * collapses one atomic save (write + rename) and nothing more. The thing that
 * actually writes these documents is an agent editing over minutes: across four
 * recorded incidents every intra-burst gap was 1.3-4.7 s, so each edit became
 * its own broadcast to every live participant. The debounce is keyed per doc and
 * the cost is per participant, so one editor's cadence is multiplied by the
 * number of live sessions.
 *
 * The fix coalesces per `(doc, reader)`: while a reader still holds an
 * un-handled notice for a doc, a second one carries nothing the first did not.
 *
 * The fixture models the round trip rather than asserting against a hand-made
 * inbox: `sendSystemMessage` appends to a fake per-workspace inbox in the shape
 * the Bridge actually hands back (`{ id, from, message }`), and `getMessages`
 * reads it. A test that pre-loaded an inbox by hand would pass against a
 * coalescing check keyed on anything at all, including the wrong thing.
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

describe('a reader gets one shared-doc notice per quiet period (#1108)', () => {
  let tmpDir;
  let server;
  let readerA;
  let readerB;
  let owner;
  let group;
  let docId;
  let otherDocId;
  let inboxes;      // workspaceId -> [{ id, from, message }]
  let sent;
  let realSend;
  let realGetStatus;
  let realGetMessages;
  let nextEnvelopeId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doc-coalesce-'));
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

    readerA = mkProject('reader-a');
    readerB = mkProject('reader-b');
    owner = mkProject('doc-owner');

    group = store.projectGroups.create({ name: 'coalesce-group' });
    for (const p of [readerA, readerB, owner]) store.projectGroups.addMember(group.id, p.id);

    const docPath = path.join(owner.path, 'BOARD.md');
    fs.writeFileSync(docPath, '# board\n');
    docId = store.sharedDocs.create({ groupId: group.id, name: 'BOARD', filePath: docPath }).id;

    // A SECOND doc deliberately sharing nothing but its group. Coalescing must
    // be per `(doc, reader)`; a check that only asked "does this reader have any
    // un-handled system notice" would suppress this one and pass every other
    // test in this file.
    const otherPath = path.join(owner.path, 'NOTES.md');
    fs.writeFileSync(otherPath, '# notes\n');
    otherDocId = store.sharedDocs.create({ groupId: group.id, name: 'NOTES', filePath: otherPath }).id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    medusa.sendSystemMessage = realSend;
    medusa.getStatus = realGetStatus;
    medusa.getMessages = realGetMessages;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const p of [readerA, readerB, owner]) {
      const active = store.sessions.getActive(p.id);
      if (active) store.sessions.kill(active.id, 'test reset');
      store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: `s-${p.name}` });
    }

    inboxes = new Map();
    sent = [];
    nextEnvelopeId = 1;
    realSend = realSend || medusa.sendSystemMessage;
    realGetStatus = realGetStatus || medusa.getStatus;
    realGetMessages = realGetMessages || medusa.getMessages;

    medusa.getStatus = (sessionId) => ({
      state: 'listening', workspaceId: `ws-${sessionId}`, unread: 0, lastError: null
    });
    // The delivery the Bridge makes: the text is echoed verbatim into the
    // recipient's inbox under `from: 'system'`, and stays there until a consumer
    // reports it handled.
    medusa.sendSystemMessage = async ({ to, message }) => {
      sent.push({ to, message });
      if (!inboxes.has(to)) inboxes.set(to, []);
      inboxes.get(to).push({ id: `env-${nextEnvelopeId++}`, from: 'system', message });
      return { status: 'received', id: `env-${nextEnvelopeId}`, to };
    };
    medusa.getMessages = (sessionId) => (inboxes.get(`ws-${sessionId}`) || []).slice();
  });

  /**
   * The workspace id the stub mints for a project's live session.
   * @param {object} project - Project record.
   * @returns {string} Its workspace id.
   */
  const wsFor = (project) => `ws-${store.sessions.getActive(project.id).id}`;

  /**
   * How many notices a project's inbox is holding un-handled.
   * @param {object} project - Project record.
   * @returns {number} Inbox depth.
   */
  const depth = (project) => (inboxes.get(wsFor(project)) || []).length;

  /**
   * Report every message currently in a project's inbox handled, the way a
   * consumer that reads its mail does.
   * @param {object} project - Project record.
   * @returns {void}
   */
  const handleAll = (project) => { inboxes.set(wsFor(project), []); };

  it('five writes across a quiet period notify each reader once, not five times', async () => {
    for (let i = 0; i < 5; i++) await post(server, `/api/shared-docs/${docId}/notify`);

    assert.equal(depth(readerA), 1,
      'a reader still holding an un-handled notice for this doc learns nothing from a second');
    assert.equal(depth(readerB), 1,
      'and the cost is per participant — the multiplier is the whole defect');
    assert.equal(sent.length, 2,
      'exactly one send per reader left the process; the other eight never reached the Bridge');
  });

  it('each reader gets its own notice — coalescing is per reader, not global', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);

    assert.deepEqual(
      sent.map((m) => m.to).sort(),
      [wsFor(readerA), wsFor(readerB)].sort(),
      'suppressing by document alone would tell the first reader and silence the second'
    );
  });

  it('a reader that handles its mail is notified again — the quiet period ENDS', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);
    handleAll(readerA);
    await post(server, `/api/shared-docs/${docId}/notify`);

    assert.equal(depth(readerA), 1,
      'the reader consumed the first notice, so the next change is news again');
    assert.equal(sent.filter((m) => m.to === wsFor(readerA)).length, 2,
      'coalescing that never re-opens is not coalescing, it is silence');
    assert.equal(depth(readerB), 1,
      'and reader B, which handled nothing, is still coalesced');
  });

  it('a pending notice for one doc does not suppress a different doc', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);
    await post(server, `/api/shared-docs/${otherDocId}/notify`);

    assert.equal(depth(readerA), 2,
      'two documents changed; a reader holding news about one has heard nothing about the other');
    const docIds = (inboxes.get(wsFor(readerA)) || [])
      .map((m) => JSON.parse(m.message).docId);
    assert.deepEqual(docIds.sort(), [docId, otherDocId].sort());
  });

  it('the notice names the doc by id as well as by name', async () => {
    await post(server, `/api/shared-docs/${docId}/notify`);

    const payload = JSON.parse(sent[0].message);
    assert.equal(payload.event, 'shared_doc_updated');
    assert.equal(payload.doc, 'BOARD', 'the display name an agent reads must not change');
    assert.equal(payload.docId, docId,
      'two groups may each register a doc called BOARD; the name cannot tell them apart');
  });

  it('a peer message that happens to look like a notice does not suppress a real one', async () => {
    // TangleClaw fills `from` from the sending listener's own workspace id and
    // refuses a caller-supplied one, so no peer routed through TC can label
    // itself `system`. A check that keyed on the payload's `type: "system"`
    // instead would let any peer silence a reader's shared-doc notices.
    inboxes.set(wsFor(readerA), [{
      id: 'peer-1',
      from: 'ws-some-peer',
      message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'BOARD', docId })
    }]);

    await post(server, `/api/shared-docs/${docId}/notify`);

    assert.ok(sent.some((m) => m.to === wsFor(readerA)),
      'the peer\'s lookalike is not a broadcast this reader already has');
  });

  it('the route reports what was coalesced, so a zero notify is not read as a failure', async () => {
    const first = await post(server, `/api/shared-docs/${docId}/notify`);
    assert.equal(first.body.notifiedCount, 2);
    assert.equal(first.body.coalescedCount, 0);

    const second = await post(server, `/api/shared-docs/${docId}/notify`);
    assert.equal(second.body.notifiedCount, 0,
      'nobody needed telling');
    assert.equal(second.body.coalescedCount, 2,
      'and "everybody already knew" must not look identical to "the broadcast reached nobody"');
    assert.equal(second.body.success, true);
  });

  it('reports coalescedCount on the failure path too, where a missing field reads as an older TC', async () => {
    // The field exists to disambiguate a zero `notifiedCount`, so dropping it on
    // the exit where `notifiedCount` is *always* zero is the one place it must
    // not be missing. `JSON.stringify` deletes an `undefined` value outright, so
    // this is presence, not value.
    const broken = medusa.getStatus;
    medusa.getStatus = () => { throw new Error('status read exploded'); };
    try {
      const res = await post(server, `/api/shared-docs/${docId}/notify`);
      assert.equal(res.status, 200);
      assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'coalescedCount'),
        'a client using key presence as capability detection reads a failure as an older TangleClaw');
      assert.equal(res.body.coalescedCount, 0);
      assert.equal(res.body.notifiedCount, 0);
      assert.ok(res.body.errors && res.body.errors.length > 0,
        'and the failure must still say it failed');
    } finally {
      medusa.getStatus = broken;
    }
  });

  it('reports coalescedCount for a doc with no group, the other early exit', async () => {
    // Reached through the store's own getter rather than by deleting a group:
    // deleting one cascades its documents, which would take the rest of this
    // fixture with it. The exit under test is `!doc.groupId`, so a doc that
    // answers with no group is the whole precondition.
    const realGet = store.sharedDocs.get;
    store.sharedDocs.get = (id) => ({ ...realGet.call(store.sharedDocs, id), groupId: null });
    try {
      const res = await post(server, `/api/shared-docs/${docId}/notify`);
      assert.equal(res.status, 200);
      assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'coalescedCount'),
        'all three of the helper\'s exits carry the field, or the contract is a lie');
      assert.equal(res.body.coalescedCount, 0);
      assert.equal(res.body.notifiedCount, 0);
      assert.deepEqual(sent, [], 'a doc with no group reaches nobody, which is the point of the exit');
    } finally {
      store.sharedDocs.get = realGet;
    }
  });

  it('an un-handled notice with no docId suppresses nothing — it fails open', async () => {
    // A notice queued Hub-side before `docId` existed, redelivered after a
    // restart. Matching it by display name would reintroduce the collision the
    // id closes; the honest cost is one duplicate, which is what every
    // broadcast cost before this change.
    inboxes.set(wsFor(readerA), [{
      id: 'legacy-1',
      from: 'system',
      message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'BOARD' })
    }]);

    await post(server, `/api/shared-docs/${docId}/notify`);

    assert.ok(sent.some((m) => m.to === wsFor(readerA)),
      'an un-matchable notice must not be treated as a match');
  });
});
