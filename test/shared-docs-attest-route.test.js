'use strict';

/*
 * #2389: `POST /api/shared-docs/:id/attest`, its base capture, and the
 * events route that reads the record, end to end through the HTTP server, with
 * `tc docs base` / `tc docs attest` in front of them.
 *
 * Attested authorship is authenticated attestation by the session holding
 * the doc's lock in a cooperative-writer model: it proves that session held
 * the lock and that the bytes it names followed its saved base with nothing
 * OBSERVED in between. It does not prove who typed the bytes, and one test
 * below pins the limit the design states: bytes overwritten before any
 * observation cannot be seen, so they cannot be refused.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const tcVerbs = require('../lib/tc-verbs');
const sharedDocRecord = require('../lib/shared-docs');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs } = require('./_shared-docs-callers');

/**
 * @param {string|Buffer} bytes - Content
 * @returns {string} sha256 hex
 */
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * A lane-queue-shaped doc with one keyed row per lane.
 * @param {object} [o] - Row states and prose
 * @returns {string}
 */
function laneDoc(o = {}) {
  return [
    '# Lane queue', '', o.prose || 'Batch running.', '',
    '| Lane | State |', '|---|---|',
    `| TC-Lane-A | ${o.a || 'building'} |`,
    `| TC-Lane-B | ${o.b || 'planning'} |`,
    `| TC-Lane-INT | ${o.int || 'integrating'} |`, ''
  ].join('\n');
}

describe('shared-doc attestation route (#2389)', () => {
  let tmpDir;
  let server;
  let lanes;    // { a, b, int } project records
  let int;      // INT's binding
  let b;        // B's binding
  let group;
  let foreignDocId;
  let docId;
  let file;
  let realGetStatus;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attest-route-'));
    store._setBasePath(tmpDir);
    store.init();
    const mk = (name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };
    lanes = { a: mk('TC-Lane-A'), b: mk('TC-Lane-B'), int: mk('TC-Lane-INT') };
    group = store.projectGroups.create({ name: 'lanes' });
    for (const p of Object.values(lanes)) store.projectGroups.addMember(group.id, p.id);
    int = bindProject(lanes.int);
    b = bindProject(lanes.b);

    // A doc in a group no lane belongs to.
    const other = store.projectGroups.create({ name: 'elsewhere' });
    const otherFile = path.join(tmpDir, 'ELSEWHERE.md');
    fs.writeFileSync(otherFile, '# elsewhere\n');
    foreignDocId = store.sharedDocs.create({ groupId: other.id, name: 'ELSEWHERE', filePath: otherFile }).id;

    // Nobody is listening: the notify route's broadcast reaches no one, and
    // what is under test is the record it now makes.
    realGetStatus = medusa.getStatus;
    medusa.getStatus = () => null;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    medusa.getStatus = realGetStatus;
    if (server) await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    file = path.join(tmpDir, `LANE_QUEUE-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(file, laneDoc());
    docId = store.sharedDocs.create({ groupId: group.id, name: path.basename(file), filePath: file }).id;
  });

  afterEach(() => {
    store.documentLocks.release(docId);
  });

  const lock = (who, sessionId = who.sessionId, projectName) => sendAs(server, 'POST', `/api/shared-docs/${docId}/lock`,
    { sessionId, projectName: projectName || store.projects.get(Number(who.headers['x-tangleclaw-project-id'])).name }, who.headers);
  const unlock = (who) => sendAs(server, 'DELETE', `/api/shared-docs/${docId}/lock`, undefined, who.headers);
  const base = (who, id = docId) => sendAs(server, 'POST', `/api/shared-docs/${id}/attest`, { base: true }, who.headers);
  const attest = (who, baseSha256, sha256, id = docId) => sendAs(server, 'POST', `/api/shared-docs/${id}/attest`, { baseSha256, sha256 }, who.headers);
  // Notify answers without waiting for its record, so a test reading the
  // record drains the doc's queue first.
  const notify = async () => {
    const res = await sendAs(server, 'POST', `/api/shared-docs/${docId}/notify`, undefined, operatorHeaders(server));
    await sharedDocRecord.serialize(docId, async () => {});
    return res;
  };
  const events = (who, query = '') => sendAs(server, 'GET', `/api/shared-docs/${docId}/events${query}`, undefined, who.headers);
  const write = (text) => { fs.writeFileSync(file, text); return sha(text); };
  const latest = () => store.sharedDocEvents.latest(docId);

  it('INT locks, saves the base, edits TC-Lane-A\'s row and attests: INT is the attested author, A the would-select', async () => {
    assert.equal((await lock(int)).status, 200);
    const saved = await base(int);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.sha256, sha(laneDoc()));
    const edited = write(laneDoc({ a: 'ready' }));
    const res = await attest(int, saved.data.sha256, edited);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const rev = res.data.revision;
    assert.equal(rev.authorSource, 'attested');
    assert.equal(rev.authorProjectId, lanes.int.id);
    assert.equal(rev.authorSessionId, int.sessionId);
    assert.deepEqual(rev.classes, ['row']);
    assert.deepEqual(rev.changedProjectIds, [lanes.a.id]);
    assert.deepEqual(rev.shadowWouldSelect, [lanes.a.id]);

    // The watcher or notify seeing the same bytes later is a duplicate.
    assert.equal((await notify()).status, 200);
    assert.equal(latest().seq, rev.seq);
    assert.equal(latest().duplicateObservations, 1);
    assert.equal(latest().authorProjectId, lanes.int.id);
  });

  it('the same edit not attested: author unknown, INT only a lock-holder hint, no one selected', async () => {
    await lock(int);
    await base(int);
    write(laneDoc({ a: 'ready' }));
    await notify();
    const rev = latest();
    assert.equal(rev.authorSource, 'unknown');
    assert.equal(rev.lockHolderHint.project, lanes.int.name);
    assert.deepEqual(rev.shadowWouldSelect, []);
    assert.equal(rev.source, 'notify');
  });

  it('an OBSERVED external write between the base and INT\'s edit is its own unknown revision, and the attest is refused BASE_MISMATCH', async () => {
    await lock(int);
    const saved = (await base(int)).data.sha256;
    write(laneDoc({ prose: 'Someone else wrote here.' }));
    await notify();
    const external = latest();
    const edited = write(laneDoc({ prose: 'Someone else wrote here.', a: 'ready' }));
    const res = await attest(int, saved, edited);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'BASE_MISMATCH');
    assert.equal(external.authorSource, 'unknown');
    assert.equal(store.sharedDocEvents.list(docId).events.every((e) => e.authorSource === 'unknown'), true);
  });

  it('the stated limit: an external write overwritten before any observation cannot be seen, so it is not refused', async () => {
    await lock(int);
    const saved = (await base(int)).data.sha256;
    write(laneDoc({ prose: 'Never observed.' }));
    const edited = write(laneDoc({ a: 'ready' }));
    const res = await attest(int, saved, edited);
    assert.equal(res.status, 200);
    assert.equal(store.sharedDocEvents.list(docId).events.length, 2, 'only the base and the edit were ever observed');
  });

  it('an attest naming a digest the file does not hold is refused DIGEST_MISMATCH', async () => {
    await lock(int);
    const saved = (await base(int)).data.sha256;
    write(laneDoc({ a: 'ready' }));
    const res = await attest(int, saved, sha('something else'));
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'DIGEST_MISMATCH');
    assert.equal(latest().authorSource, 'unknown', 'the read is recorded; nothing is bound');
  });

  describe('refusals change no binding', () => {
    /**
     * Prepare a base and an edit, run `refuse`, and check the edit stayed unbound.
     * @param {function(string, string): Promise<object>} refuse - Sends the refused request
     * @returns {Promise<object>} The refused response
     */
    async function refused(refuse) {
      const saved = (await base(int)).data.sha256;
      const edited = write(laneDoc({ a: 'ready' }));
      const res = await refuse(saved, edited);
      assert.ok(res.status >= 400, JSON.stringify(res.data));
      const rev = latest();
      assert.equal(rev.authorSource, 'unknown');
      assert.equal(rev.authorProjectId, null);
      return res;
    }

    it('no lock', async () => {
      const res = await refused((s, e) => attest(int, s, e));
      assert.equal(res.data.code, 'NOT_LOCK_HOLDER');
    });

    it('the lock held by another session of INT\'s own project', async () => {
      store.documentLocks.acquire(docId, int.sessionId + 1000, lanes.int.name);
      const res = await refused((s, e) => attest(int, s, e));
      assert.equal(res.data.code, 'NOT_LOCK_HOLDER');
      assert.match(res.data.error, /another session/);
    });

    it('an expired lock', async () => {
      store.documentLocks.acquire(docId, int.sessionId, lanes.int.name, -1);
      const res = await refused((s, e) => attest(int, s, e));
      assert.equal(res.data.code, 'NOT_LOCK_HOLDER');
      assert.match(res.data.error, /expired/);
    });

    it('the operator, who has no session to bind', async () => {
      await lock(int);
      const res = await refused((s, e) => sendAs(server, 'POST', `/api/shared-docs/${docId}/attest`, { baseSha256: s, sha256: e }, operatorHeaders(server)));
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'PROJECT_ONLY');
    });

    it('a body over 1 KB', async () => {
      await lock(int);
      const res = await refused((s, e) => sendAs(server, 'POST', `/api/shared-docs/${docId}/attest`,
        { baseSha256: s, sha256: e, pad: 'x'.repeat(2048) }, int.headers));
      assert.equal(res.status, 413);
    });

    it('digests that are not lowercase hex sha256', async () => {
      await lock(int);
      const res = await refused((s) => attest(int, s, 'ABC'));
      assert.equal(res.status, 400);
    });

    it('a no-op: the base named as the edit', async () => {
      await lock(int);
      const saved = (await base(int)).data.sha256;
      const res = await attest(int, saved, saved);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'NO_CHANGE');
      assert.equal(latest().authorSource, 'unknown');
    });
  });

  it('another group\'s doc answers 404, for a base and an attest alike', async () => {
    assert.equal((await base(int, foreignDocId)).status, 404);
    assert.equal((await attest(int, sha('a'), sha('b'), foreignDocId)).status, 404);
  });

  it('a registered file that is missing is refused UNREADABLE and records nothing', async () => {
    await lock(int);
    const saved = (await base(int)).data.sha256;
    const before = latest().seq;
    fs.rmSync(file);
    const res = await attest(int, saved, sha('gone'));
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'UNREADABLE');
    assert.equal(latest().seq, before);
    assert.equal((await base(int)).data.code, 'UNREADABLE');
  });

  it('re-attesting: the same session is answered "already"; another session is refused', async () => {
    await lock(int);
    const saved = (await base(int)).data.sha256;
    const edited = write(laneDoc({ a: 'ready' }));
    assert.equal((await attest(int, saved, edited)).status, 200);
    const again = await attest(int, saved, edited);
    assert.equal(again.status, 200);
    assert.equal(again.data.already, true);

    await unlock(int);
    assert.equal((await lock(b)).status, 200);
    const other = await attest(b, saved, edited);
    assert.equal(other.status, 409);
    assert.equal(other.data.code, 'ALREADY_ATTESTED');
    assert.equal(latest().authorProjectId, lanes.int.id);
    await unlock(b);
  });

  describe('the events route', () => {
    it('answers latest, the oldest retained seq, and each revision, to a group member', async () => {
      await notify();
      write(laneDoc({ b: 'ready' }));
      await notify();
      const res = await events(b);
      assert.equal(res.status, 200);
      assert.equal(res.data.latest.seq, 2);
      assert.equal(res.data.oldestRetainedSeq, 1);
      assert.equal(res.data.gap, false);
      assert.deepEqual(res.data.events.map((e) => e.seq), [1, 2]);
      assert.deepEqual((await events(b, '?since=1')).data.events.map((e) => e.seq), [2]);
    });

    it('says there is a gap when revisions after `since` are no longer retained', async () => {
      await notify();
      store.getDb().prepare('DELETE FROM shared_doc_events WHERE doc_id = ? AND seq = 1').run(docId);
      write(laneDoc({ b: 'ready' }));
      await notify();
      const res = await events(b, '?since=0');
      assert.equal(res.data.oldestRetainedSeq, 2);
      assert.equal(res.data.gap, true);
    });

    it('refuses another group\'s doc and a malformed query', async () => {
      const foreign = await sendAs(server, 'GET', `/api/shared-docs/${foreignDocId}/events`, undefined, int.headers);
      assert.equal(foreign.status, 404);
      assert.equal((await events(int, '?since=-1')).status, 400);
      assert.equal((await events(int, '?limit=501')).status, 400);
    });
  });

  describe('tc docs base / attest', () => {
    /**
     * A `tc` context that records what it posts, answering from `answers`.
     * @param {string[]} argv - Arguments after `docs`
     * @param {function(string, object): object} answer - Returns a body or throws
     * @returns {{ctx: object, posts: Array<{path: string, body: object}>}}
     */
    function fakeCtx(argv, answer) {
      const posts = [];
      const ctx = {
        argv,
        env: {},
        getJson: async () => ({ docs: [{ id: docId, name: 'LANE_QUEUE', groupId: group.id, filePath: file }] }),
        postJson: async (p, body) => { posts.push({ path: p, body }); return answer(p, body); },
        readFile: (p) => fs.readFileSync(p)
      };
      return { ctx, posts };
    }
    const docsVerb = tcVerbs.VERB_ROSTER.find((v) => v.id === 'docs');

    it('base asks the server to observe and prints the digest to save', async () => {
      const { ctx, posts } = fakeCtx(['base', 'LANE_QUEUE'], () => ({ seq: 4, sha256: 'c'.repeat(64) }));
      const out = await docsVerb.run(ctx);
      assert.equal(out.code, 0);
      assert.deepEqual(posts, [{ path: `/api/shared-docs/${docId}/attest`, body: { base: true } }]);
      assert.match(out.stdout, /c{64}/);
      assert.match(out.stdout, /SAVE this digest/);
    });

    it('attest sends the SAVED base and the file\'s digest, once, and never retries a refusal', async () => {
      const saved = 'd'.repeat(64);
      const { ctx, posts } = fakeCtx(['attest', docId, '--base', saved], () => {
        const e = new Error('409 BASE_MISMATCH'); e.status = 409; throw e;
      });
      await assert.rejects(docsVerb.run(ctx), /BASE_MISMATCH/);
      assert.equal(posts.length, 1, 'one request: no base is fetched and nothing is retried');
      assert.deepEqual(posts[0].body, { baseSha256: saved, sha256: sha(fs.readFileSync(file)) });
    });

    it('attest without a saved base is a usage error that sends nothing', async () => {
      const { ctx, posts } = fakeCtx(['attest', docId], () => ({}));
      const out = await docsVerb.run(ctx);
      assert.equal(out.code, 1);
      assert.equal(posts.length, 0);
    });

    it('the whole workflow against the server: lock, base, edit, attest, labelled ATTESTED', async () => {
      await lock(int);
      const call = (argv) => docsVerb.run({
        argv, env: {},
        getJson: async (p) => (await sendAs(server, 'GET', p, undefined, int.headers)).data,
        postJson: async (p, body) => {
          const r = await sendAs(server, 'POST', p, body, int.headers);
          if (r.status >= 400) throw new Error(`${r.status} ${r.data.code}`);
          return r.data;
        },
        readFile: (p) => fs.readFileSync(p)
      });
      const baseOut = await call(['base', docId]);
      const saved = baseOut.stdout.match(/base ([0-9a-f]{64})/)[1];
      write(laneDoc({ a: 'ready' }));
      const out = await call(['attest', docId, '--base', saved]);
      assert.equal(out.code, 0);
      assert.match(out.stdout, /ATTESTED authorship/);
      assert.match(out.stdout, /not proof of who wrote the bytes/);
      assert.equal(latest().authorProjectId, lanes.int.id);
    });
  });
});
