'use strict';

/*
 * #1222 — a shared-doc update must reach only the doc's own group.
 *
 * Since #2389 (A1b) who is told is the delivery rule's: the owners of the rows
 * an attested author changed, and the members that subscribed; never the
 * attested author, and nobody else. The broadcast this file was written for is
 * gone; its group-scope contract is kept and asserted against the rule, and
 * #998's "never the project whose directory holds the file" is replaced by
 * "never the attested author", with a subscriber's self-echo of an unattested
 * write accepted because it asked for every change.
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
const { operatorHeaders } = require('./_shared-docs-callers');
const sharedDocRecord = require('../lib/shared-docs');

/**
 * POST to the test server as the operator's dashboard and resolve its parsed
 * response. The notify route answers only a caller that may write the
 * document's group; which caller asks does not change what is broadcast.
 * @param {http.Server} server - Listening server.
 * @param {string} urlPath - Path to request.
 * @returns {Promise<{status: number, body: object}>} The response.
 */
function post(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Length': 0, ...operatorHeaders(server) } },
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

  /**
   * A subscription at the group scope.
   * @param {object} project - Project record.
   * @returns {void}
   */
  const subscribe = (project) => {
    store.sharedDocNoticePrefs.set({ projectId: project.id, groupId: store.sharedDocs.get(docId).groupId, setting: 'subscribe' });
  };

  /**
   * Change the doc's bytes, then notify through the route.
   * @param {string} [id] - Doc id
   * @returns {Promise<{status: number, body: object}>}
   */
  const change = (id = docId) => {
    fs.appendFileSync(store.sharedDocs.get(id).filePath, `edit ${Date.now()} ${Math.random()}\n`);
    return post(server, `/api/shared-docs/${id}/notify`);
  };

  /**
   * As `author`'s live session: save the base, write `content`, attest it,
   * and wait for the notices it sends.
   * @param {object} author - Project record.
   * @param {string} content - The doc's new content
   * @returns {Promise<object>} The attest outcome
   */
  const attestedWrite = async (author, content) => {
    const base = await sharedDocRecord.captureBase(docId);
    fs.writeFileSync(store.sharedDocs.get(docId).filePath, content);
    const outcome = await sharedDocRecord.attest(docId, {
      baseSha256: base.sha256,
      sha256: sharedDocRecord.sha256(Buffer.from(content)),
      projectId: author.id,
      sessionId: store.sessions.getActive(author.id).id,
      recheck: () => null
    });
    await sharedDocRecord.drain();
    return outcome;
  };

  beforeEach(async () => {
    // Every test starts from a recorded baseline and no settings.
    store.getDb().prepare('DELETE FROM shared_doc_notice_prefs').run();
    await post(server, `/api/shared-docs/${docId}/notify`);
    await sharedDocRecord.drain();
    sent.length = 0;
  });

  it('does NOT notify a live session whose project is not in the group, even with a setting that says subscribe', async () => {
    subscribe(inGroup);
    // Written past the route, which would refuse it: only current members'
    // settings are ever read.
    subscribe(outsider);
    const res = await change();
    assert.equal(res.status, 200);
    const recipients = sent.map((m) => m.to);
    assert.ok(!recipients.includes(wsFor(outsider)),
      'a project sharing no group with the doc must not be told the doc exists, let alone that it changed');
    assert.ok(recipients.includes(wsFor(inGroup)), 'scoping must not become silence');
  });

  it('an unattested write tells the subscribing members and nobody else: there is no broadcast', async () => {
    subscribe(inGroup);
    await change();
    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)],
      'the member that did not subscribe, and the containing project, are not told of an unknown author\'s write');
  });

  it('with no subscriber, an unattested write tells no one', async () => {
    const res = await change();
    assert.equal(res.status, 200);
    assert.deepEqual(sent, []);
    assert.equal(res.body.notifiedCount, 0);
  });

  it('the project holding the file is told of an unattested write when it subscribed: the echo it asked for (#998 retired)', async () => {
    subscribe(owner);
    await change();
    assert.deepEqual(sent.map((m) => m.to), [wsFor(owner)],
      'the writer is unknown, and the subscriber asked for every change, its own included');
  });

  it('the attested author is never told, even when it subscribed and its directory holds the file (R1)', async () => {
    subscribe(owner);
    subscribe(inGroup);
    const outcome = await attestedWrite(owner, '# shared\n\n| Lane | State |\n|---|---|\n| in-group | moved |\n');
    assert.equal(outcome.status, 200);
    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)],
      'the row\'s owner (and a subscriber) is told; the author is not');
  });

  it('the owner of a changed row is told of an attested write without subscribing; the author is not (R2)', async () => {
    await attestedWrite(owner, '# shared\n\n| Lane | State |\n|---|---|\n| in-group | one |\n');
    sent.length = 0;
    const outcome = await attestedWrite(owner, '# shared\n\n| Lane | State |\n|---|---|\n| in-group | two |\n');
    assert.deepEqual(outcome.revision.changedProjectIds, [inGroup.id]);
    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)]);
    const deliveries = store.sharedDocDeliveries.listForEvent(outcome.revision.id);
    assert.deepEqual(deliveries.map((d) => [d.projectId, d.reason, d.outcome]), [[inGroup.id, 'owner', 'sent']]);
  });

  it('an archived member that attested is still the author, so archiving cannot re-open a self-notice', async () => {
    subscribe(owner);
    const ownerWs = wsFor(owner);
    store.projects.archive(owner.id);
    try {
      assert.equal(store.projects.get(owner.id).archived, true,
        'the fixture must actually archive, or this test measures nothing');
      await attestedWrite(owner, `# shared\n\narchived edit ${Date.now()}\n`);
      assert.ok(!sent.map((m) => m.to).includes(ownerWs), 'an archived author is still the author');
    } finally {
      store.projects.unarchive(owner.id);
    }
  });

  it('notifies exactly the selected members, and the count it reports is the count it sent', async () => {
    subscribe(inGroup);
    const res = await change();
    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)]);
    assert.equal(res.body.notifiedCount, sent.length,
      'the route\'s own number must match what actually went out');
  });

  it('a notify records the revision and sends the notice it always sent, answering seq and duplicate besides', async () => {
    subscribe(inGroup);
    const res = await change();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['coalescedCount', 'duplicate', 'notifiedCount', 'seq', 'success'],
      'the fields it always answered, plus the revision it recorded');
    assert.equal(res.body.success, true);
    assert.equal(res.body.duplicate, false);
    assert.deepEqual(sent, [{
      to: wsFor(inGroup),
      message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'SHARED', docId })
    }], 'the notice is byte-identical');
    const revision = store.sharedDocEvents.latest(docId);
    assert.equal(res.body.seq, revision.seq);
    assert.equal(revision.authorSource, 'unknown', 'the notify caller is never made the author');
    assert.equal(revision.routing, 'done');
  });

  it('a revision that cannot be recorded notifies nobody, and the call says so where it always reported a failure', async () => {
    subscribe(inGroup);
    const docPath = store.sharedDocs.get(docId).filePath;
    const saved = fs.readFileSync(docPath);
    fs.rmSync(docPath);
    try {
      const res = await post(server, `/api/shared-docs/${docId}/notify`);
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.notifiedCount, res.body.coalescedCount], [0, 0]);
      assert.match(res.body.errors[0], /not recorded, so nobody was notified/);
      await sharedDocRecord.drain();
      assert.deepEqual(sent, [], 'there is no broadcast to fall back to');
    } finally {
      fs.writeFileSync(docPath, saved);
    }
  });

  it('a notice is sent only once its revision is recorded, even behind another read of the doc', async () => {
    subscribe(inGroup);
    let release;
    const blocked = sharedDocRecord.observe(docId, {
      source: 'watch', read: () => new Promise((resolve) => { release = resolve; })
    });
    fs.appendFileSync(store.sharedDocs.get(docId).filePath, 'queued edit\n');
    const pending = post(server, `/api/shared-docs/${docId}/notify`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(sent, [], 'nothing is sent before the revision it is derived from exists');
    release(fs.readFileSync(store.sharedDocs.get(docId).filePath));
    await blocked;
    const res = await pending;
    await sharedDocRecord.drain();
    assert.equal(res.status, 200);
    assert.deepEqual(sent.map((m) => m.to), [wsFor(inGroup)], 'told once: the notify read is a duplicate of the watch read');
  });

  it('a doc whose group has no members notifies nobody, rather than everybody', async () => {
    const empty = store.projectGroups.create({ name: 'empty-group' });
    const docPath = path.join(tmpDir, 'ORPHAN.md');
    fs.writeFileSync(docPath, '# orphan\n');
    const orphan = store.sharedDocs.create({
      groupId: empty.id, name: 'ORPHAN', filePath: docPath
    });
    await post(server, `/api/shared-docs/${orphan.id}/notify`);
    const res = await change(orphan.id);
    assert.deepEqual(sent, [],
      'an empty membership is zero recipients — the broken code made it every session on the machine');
    assert.equal(res.body.notifiedCount, 0);
  });
});
