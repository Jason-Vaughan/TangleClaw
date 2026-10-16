'use strict';

// #2389 (A1b): shared-doc notices are delivered by the rule, not broadcast.
// R1 never the attested author; R2 the owners of the rows an attested author
// changed; R3 the members that subscribed; R4 nobody else. A project may mute
// or subscribe per doc or per group, the doc scope winning. Intents are
// persisted with the revision before any send, each call sends only its own,
// and each is rechecked at dispatch. Direct mail, replies and HOLD/STOP do not
// pass through any of this.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const sharedDocs = require('../lib/shared-docs');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs } = require('./_shared-docs-callers');

/**
 * A fake Bridge: who is listening, what was sent, each inbox, and a switch to
 * hold every send until released, so overlapping batches can be observed.
 * @returns {object}
 */
function fakeBridge() {
  const bridge = { sent: [], inboxes: new Map(), listening: new Set(), defer: false, waiting: [], fail: null };
  bridge.real = { getStatus: medusa.getStatus, getMessages: medusa.getMessages, sendSystemMessage: medusa.sendSystemMessage };
  medusa.getStatus = (sid) => (bridge.listening.has(sid)
    ? { state: 'listening', workspaceId: `ws-${sid}`, unread: 0, lastError: null }
    : { state: 'off', workspaceId: null });
  medusa.getMessages = (sid) => (bridge.inboxes.get(`ws-${sid}`) || []).slice();
  medusa.sendSystemMessage = async ({ to, message }) => {
    if (bridge.fail) throw new Error(bridge.fail);
    const deliver = () => {
      bridge.sent.push({ to, message });
      if (!bridge.inboxes.has(to)) bridge.inboxes.set(to, []);
      bridge.inboxes.get(to).push({ id: `env-${bridge.sent.length}`, from: 'system', message });
    };
    if (bridge.defer) await new Promise((resolve) => bridge.waiting.push(() => { deliver(); resolve(); }));
    else deliver();
    return { status: 'received', to };
  };
  bridge.release = () => { for (const go of bridge.waiting.splice(0)) go(); };
  bridge.restore = () => Object.assign(medusa, bridge.real);
  return bridge;
}

/**
 * Yield until `cond` holds, or fail after a bound.
 * @param {function(): boolean} cond - Condition
 * @returns {Promise<void>}
 */
async function until(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never held');
}

describe('shared-doc notices by the delivery rule (#2389)', () => {
  let tmpDir;
  let server;
  let group;
  let doc;
  let alpha; let bravo; let charlie; let sub;
  let bridge;
  let edits = 0;

  /**
   * A project with one live session, listening unless told otherwise.
   * @param {string} name - Project name
   * @returns {{project: object, sessionId: number, headers: object}}
   */
  const live = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    store.projectGroups.addMember(group.id, project.id);
    return { project, ...bindProject(project) };
  };

  /**
   * The doc's text with one row per project, as LANE_QUEUE keys its rows.
   * @param {Object<string, string>} states - project name → its row's state
   * @param {string} [prose] - A line outside the table
   * @returns {string}
   */
  const board = (states, prose = 'Notes.') => {
    const rows = Object.entries(states).map(([name, state]) => `| ${name} | ${state} |`).join('\n');
    return `# Board\n\n${prose}\n\n| Lane | State |\n|---|---|\n${rows}\n`;
  };

  let current;

  /**
   * Write the doc with new states, unattested, and observe it as the watcher would.
   * @param {Object<string, string>} changes - Row states to change
   * @param {string} [prose] - New prose
   * @returns {Promise<{revision: object, delivery: Promise<object>}>}
   */
  const unattested = async (changes = {}, prose) => {
    current = { ...current, ...changes };
    fs.writeFileSync(doc.filePath, board(current, prose || `Notes ${++edits}.`));
    return sharedDocs.observe(doc.id, { source: 'watch' });
  };

  /**
   * As `who`: save the base, write new states, attest.
   * @param {object} who - From {@link live}
   * @param {Object<string, string>} changes - Row states to change
   * @param {{base?: string, observeFirst?: boolean}} [opts] - A stale base, or let the watcher see the bytes first
   * @returns {Promise<object>} The attest outcome
   */
  const attested = async (who, changes, opts = {}) => {
    const base = opts.base || (await sharedDocs.captureBase(doc.id)).sha256;
    current = { ...current, ...changes };
    const content = board(current, 'Notes.');
    fs.writeFileSync(doc.filePath, content);
    if (opts.observeFirst) await sharedDocs.observe(doc.id, { source: 'watch' });
    return sharedDocs.attest(doc.id, {
      baseSha256: base,
      sha256: sharedDocs.sha256(Buffer.from(content)),
      projectId: who.project.id,
      sessionId: who.sessionId,
      recheck: () => null
    });
  };

  const ws = (who) => `ws-${who.sessionId}`;
  const recipients = () => bridge.sent.map((m) => m.to).sort();
  const setting = (who, value, scope = 'group') => store.sharedDocNoticePrefs.set({
    projectId: who.project.id, setting: value, ...(scope === 'group' ? { groupId: group.id } : { docId: doc.id })
  });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-notice-routing-'));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    group = store.projectGroups.create({ name: `g-${Math.random().toString(36).slice(2)}` });
    alpha = live(`alpha-${group.id.slice(0, 6)}`);
    bravo = live(`bravo-${group.id.slice(0, 6)}`);
    charlie = live(`charlie-${group.id.slice(0, 6)}`);
    sub = live(`sub-${group.id.slice(0, 6)}`);
    const file = path.join(tmpDir, `${group.id}.md`);
    current = { [alpha.project.name]: 'a0', [bravo.project.name]: 'b0', [charlie.project.name]: 'c0', [sub.project.name]: 's0' };
    fs.writeFileSync(file, board(current));
    doc = store.sharedDocs.create({ groupId: group.id, name: 'BOARD', filePath: file });
    bridge = fakeBridge();
    for (const who of [alpha, bravo, charlie, sub]) bridge.listening.add(who.sessionId);
    // The first observation is `first-seen`: it tells no one, and is the baseline.
    await sharedDocs.observe(doc.id, { source: 'watch' });
    await sharedDocs.drain();
  });

  /**
   * Stop holding sends, release every held one, and wait for every batch.
   * @returns {Promise<void>}
   */
  const flush = async () => {
    bridge.defer = false;
    bridge.release();
    await sharedDocs.drain();
  };

  /** Settle everything and restore the real Bridge after each test. */
  const done = async () => { await flush(); bridge.restore(); };

  describe('who is told', () => {
    it('N attested writes to another project\'s row tell that owner and nobody else, never the author (criterion 1)', async () => {
      for (let i = 1; i <= 3; i++) {
        const out = await attested(alpha, { [bravo.project.name]: `b${i}` });
        assert.equal(out.status, 200);
        await out.delivery;
        bridge.inboxes.clear();
      }
      assert.deepEqual(recipients(), [ws(bravo), ws(bravo), ws(bravo)]);
      await done();
    });

    it('a second own-row notice before the first is handled is coalesced (criterion 2)', async () => {
      await (await attested(alpha, { [bravo.project.name]: 'b1' })).delivery;
      const second = await attested(alpha, { [bravo.project.name]: 'b2' });
      const counts = await second.delivery;
      assert.equal(counts.coalesced, 1);
      assert.equal(bridge.sent.length, 1);
      assert.deepEqual(store.sharedDocDeliveries.summary(second.revision.id), { coalesced: 1 });
      await done();
    });

    it('unattested writes and prose edits tell subscribers only (criterion 3, R3/R4)', async () => {
      setting(sub, 'subscribe');
      await (await unattested({ [bravo.project.name]: 'b9' })).delivery;
      await (await unattested({}, 'Prose only.')).delivery;
      assert.deepEqual(recipients(), [ws(sub)], 'the row owner is not told of an unknown author\'s write; the subscriber is told once (coalesced after)');
      await done();
    });

    it('formatting-only and first-seen revisions tell nobody, subscribers included', async () => {
      setting(sub, 'subscribe');
      fs.writeFileSync(doc.filePath, board(current, '**Notes.**'));
      const out = await sharedDocs.observe(doc.id, { source: 'watch' });
      assert.deepEqual(out.revision.classes, ['formatting']);
      await out.delivery;
      assert.deepEqual(bridge.sent, []);
      assert.equal(out.revision.routing, 'none');
      await done();
    });

    it('a subscriber that is the attested author is not told of its own edit (R1 over R3)', async () => {
      setting(alpha, 'subscribe');
      setting(sub, 'subscribe');
      await (await attested(alpha, { [bravo.project.name]: 'b1' })).delivery;
      assert.deepEqual(recipients(), [ws(bravo), ws(sub)].sort());
      await done();
    });

    it('a project with two live sessions, one listening and one not: one sent and one offline (criterion 3)', async () => {
      const second = bindProject(bravo.project);
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      const rows = store.sharedDocDeliveries.listForEvent(out.revision.id);
      assert.deepEqual(rows.map((r) => [r.sessionId, r.outcome]).sort(),
        [[bravo.sessionId, 'sent'], [second.sessionId, 'offline']].sort());
      assert.deepEqual(store.sharedDocDeliveries.summary(out.revision.id), { sent: 1, offline: 1 });
      await done();
    });

    it('an owner with no live session is recorded offline, never dropped (criterion 5)', async () => {
      store.sessions.kill(bravo.sessionId, 'gone');
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      const rows = store.sharedDocDeliveries.listForEvent(out.revision.id);
      assert.deepEqual(rows.map((r) => [r.projectId, r.sessionId, r.outcome]), [[bravo.project.id, null, 'offline']]);
      assert.equal(store.sharedDocEvents.get(out.revision.id).routing, 'done');
      await done();
    });

    it('a muted owner is recorded muted and not told', async () => {
      setting(bravo, 'mute', 'doc');
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      assert.deepEqual(bridge.sent, []);
      assert.deepEqual(store.sharedDocDeliveries.listForEvent(out.revision.id).map((r) => [r.sessionId, r.outcome]), [[null, 'muted']]);
      await done();
    });
  });

  describe('preferences', () => {
    it('a doc-scope mute beats a group-scope subscribe, and the reverse; default clears (criterion 4)', async () => {
      setting(sub, 'subscribe', 'group');
      setting(sub, 'mute', 'doc');
      assert.equal(sharedDocs.effectiveSettings(doc).get(sub.project.id), 'mute');
      setting(sub, 'mute', 'group');
      setting(sub, 'subscribe', 'doc');
      assert.equal(sharedDocs.effectiveSettings(doc).get(sub.project.id), 'subscribe');
      setting(sub, 'default', 'doc');
      assert.equal(sharedDocs.effectiveSettings(doc).get(sub.project.id), 'mute');
      setting(sub, 'default', 'group');
      assert.equal(sharedDocs.effectiveSettings(doc).get(sub.project.id), null);
      await done();
    });

    it('a member reads every member\'s settings, so a coordinator sees that a peer is muted (criterion 6)', async () => {
      setting(bravo, 'mute', 'doc');
      const res = await sendAs(server, 'GET', `/api/shared-docs/${doc.id}/notices`, undefined, alpha.headers);
      assert.equal(res.status, 200);
      const row = res.data.members.find((m) => m.projectId === bravo.project.id);
      assert.deepEqual([row.doc, row.group, row.effective], ['mute', null, 'mute']);
      await done();
    });

    it('a project sets its own setting through the routes, and only its own', async () => {
      let res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'mute' }, alpha.headers);
      assert.equal(res.status, 200);
      assert.deepEqual([res.data.scope, res.data.setting, res.data.effective], ['doc', 'mute', 'mute']);
      res = await sendAs(server, 'POST', `/api/groups/${group.id}/notices`, { setting: 'subscribe' }, alpha.headers);
      assert.deepEqual([res.data.scope, res.data.setting, res.data.effective], ['group', 'subscribe', 'subscribe']);
      res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'mute', projectId: bravo.project.id }, alpha.headers);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'NOT_OWN_PROJECT');
      res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'quiet' }, alpha.headers);
      assert.equal(res.status, 400);
      res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'default' }, alpha.headers);
      assert.deepEqual([res.data.setting, res.data.effective], [null, 'subscribe']);
      await done();
    });

    it('the operator may set any member\'s, and nobody may set a non-member\'s or reach another group\'s doc', async () => {
      let res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'mute', projectId: bravo.project.id }, operatorHeaders(server));
      assert.equal(res.status, 200);
      res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'mute' }, operatorHeaders(server));
      assert.equal(res.status, 400, 'the operator has no project of its own to default to');
      const stranger = store.projects.create({ name: `stranger-${group.id.slice(0, 6)}`, path: path.join(tmpDir, 'stranger'), engine: 'claude' });
      res = await sendAs(server, 'POST', `/api/shared-docs/${doc.id}/notices`, { setting: 'mute', projectId: stranger.id }, operatorHeaders(server));
      assert.equal(res.status, 404);
      assert.equal(res.data.code, 'NOT_A_MEMBER');
      const outsider = bindProject(stranger);
      res = await sendAs(server, 'GET', `/api/shared-docs/${doc.id}/notices`, undefined, outsider.headers);
      assert.equal(res.status, 404, 'another group\'s doc answers as if it did not exist');
      res = await sendAs(server, 'POST', `/api/groups/${group.id}/notices`, { setting: 'mute' }, outsider.headers);
      assert.equal(res.status, 404);
      res = await sendAs(server, 'GET', `/api/groups/${group.id}/notices`);
      assert.equal(res.status, 403, 'an unbound caller is refused before any lookup');
      await done();
    });

    it('tc docs mute, subscribe and default set this pane\'s own setting by doc or --group, and tc docs shows it', async () => {
      const docsVerb = require('../lib/tc-verbs').VERB_ROSTER.find((v) => v.id === 'docs');
      const call = (argv) => docsVerb.run({
        argv,
        env: { TANGLECLAW_PROJECT_ID: String(alpha.project.id) },
        getJson: async (p) => (await sendAs(server, 'GET', p, undefined, alpha.headers)).data,
        postJson: async (p, body) => {
          const r = await sendAs(server, 'POST', p, body, alpha.headers);
          if (r.status >= 400) throw new Error(`${r.status} ${r.data.code}`);
          return r.data;
        }
      });
      let out = await call(['subscribe', '--group', group.name]);
      assert.equal(out.code, 0);
      assert.match(out.stdout, /subscribe set at the group scope/);
      out = await call(['mute', 'BOARD']);
      assert.match(out.stdout, /BOARD: mute set at the doc scope\. In effect: muted/);
      out = await call([]);
      assert.match(out.stdout, /BOARD[^\n]*\n {4}notices: muted \(never told\) \(set on this doc\)/);
      out = await call(['unmute', 'BOARD']);
      assert.match(out.stdout, /setting cleared at the doc scope\. In effect: subscribed/);
      assert.equal(sharedDocs.effectiveSettings(doc).get(alpha.project.id), 'subscribe');
      out = await call(['mute']);
      assert.equal(out.code, 1, 'a form with no target is a usage error');
      await done();
    });

    it('removing a project from the group drops its settings there; deleting the doc drops its records (criterion 7)', async () => {
      setting(sub, 'subscribe', 'group');
      setting(sub, 'mute', 'doc');
      setting(bravo, 'mute', 'group');
      let res = await sendAs(server, 'DELETE', `/api/groups/${group.id}/members/${sub.project.id}`, undefined, operatorHeaders(server));
      assert.equal(res.status, 200);
      assert.deepEqual(store.sharedDocNoticePrefs.listForGroup(group.id).map((p) => p.projectId), [bravo.project.id]);
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      res = await sendAs(server, 'DELETE', `/api/shared-docs/${doc.id}`, undefined, operatorHeaders(server));
      assert.equal(res.status, 200);
      const db = store.getDb();
      for (const table of ['shared_doc_notice_prefs', 'shared_doc_events', 'shared_doc_deliveries']) {
        const where = table === 'shared_doc_deliveries' ? 'event_id = ?' : 'doc_id = ?';
        const key = table === 'shared_doc_deliveries' ? out.revision.id : doc.id;
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(key).n, 0, table);
      }
      await done();
    });

    it('the events route shows a change to an owner that was offline, with what its notice did (criterion 5)', async () => {
      store.sessions.kill(bravo.sessionId, 'away');
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      const back = bindProject(bravo.project);
      const res = await sendAs(server, 'GET', `/api/shared-docs/${doc.id}/events?since=${out.revision.seq - 1}`, undefined, back.headers);
      assert.equal(res.status, 200);
      const event = res.data.events.find((e) => e.seq === out.revision.seq);
      assert.deepEqual(event.changedProjectIds, [bravo.project.id]);
      assert.deepEqual(event.deliveries, { offline: 1 });
      await done();
    });
  });

  describe('order, atomicity and concurrency (A81 points 4-5)', () => {
    it('an attestation of bytes the watcher already routed adds only the projects not yet resolved, while the first batch is still in flight', async () => {
      setting(sub, 'subscribe');
      setting(bravo, 'subscribe');
      bridge.defer = true;
      const out = await attested(alpha, { [bravo.project.name]: 'b1' }, { observeFirst: true });
      assert.equal(out.status, 200);
      const event = store.sharedDocEvents.get(out.revision.id);
      const rows = store.sharedDocDeliveries.listForEvent(event.id);
      assert.deepEqual(rows.map((r) => [r.projectId, r.reason]).sort(),
        [[bravo.project.id, 'subscriber'], [sub.project.id, 'subscriber']].sort(),
        'the watcher saw the bytes first, author unknown, and resolved both subscribers; the attestation finds the row owner already resolved and adds nobody');
      assert.equal(event.routing, 'pending');
      await flush();
      assert.equal(store.sharedDocEvents.get(event.id).routing, 'done');
      assert.deepEqual(recipients(), [ws(bravo), ws(sub)].sort(), 'one notice each, never a second for the owner');
      await done();
    });

    it('two batches of one revision in flight at once: each sends only its own, and done waits for both', async () => {
      setting(sub, 'subscribe');
      bridge.defer = true;
      // Batch 1: the watcher's observation, author unknown: the subscriber.
      current = { ...current, [bravo.project.name]: 'b1' };
      const content = board(current, 'Notes.');
      const base = (await sharedDocs.captureBase(doc.id)).sha256;
      fs.writeFileSync(doc.filePath, content);
      const first = await sharedDocs.observe(doc.id, { source: 'watch' });
      await until(() => bridge.waiting.length === 1);
      // Batch 2: the attestation of the same bytes: the row's owner.
      const second = await sharedDocs.attest(doc.id, {
        baseSha256: base, sha256: sharedDocs.sha256(Buffer.from(content)),
        projectId: alpha.project.id, sessionId: alpha.sessionId, recheck: () => null
      });
      await until(() => bridge.waiting.length === 2);
      bridge.waiting.pop()();
      const secondCounts = await second.delivery;
      assert.equal(secondCounts.notified, 1, 'the attestation\'s call counts its own send only');
      assert.equal(store.sharedDocEvents.get(first.revision.id).routing, 'pending', 'the watcher\'s send is still outstanding');
      bridge.defer = false;
      bridge.release();
      const firstCounts = await first.delivery;
      assert.equal(firstCounts.notified, 1);
      assert.equal(store.sharedDocEvents.get(first.revision.id).routing, 'done');
      assert.deepEqual(recipients(), [ws(bravo), ws(sub)].sort());
      await done();
    });

    it('a project already resolved is never resolved again, whatever its first outcome', async () => {
      setting(bravo, 'subscribe');
      bridge.fail = 'bridge down';
      current = { ...current, [bravo.project.name]: 'b1' };
      const content = board(current, 'Notes.');
      const base = (await sharedDocs.captureBase(doc.id)).sha256;
      fs.writeFileSync(doc.filePath, content);
      const first = await sharedDocs.observe(doc.id, { source: 'watch' });
      const counts = await first.delivery;
      assert.equal(counts.errors.length, 1);
      bridge.fail = null;
      const out = await sharedDocs.attest(doc.id, {
        baseSha256: base, sha256: sharedDocs.sha256(Buffer.from(content)),
        projectId: alpha.project.id, sessionId: alpha.sessionId, recheck: () => null
      });
      await out.delivery;
      assert.deepEqual(bridge.sent, [], 'its failed notice is its outcome; the attestation does not retry it');
      assert.deepEqual(store.sharedDocDeliveries.listForEvent(first.revision.id).map((r) => [r.projectId, r.outcome]),
        [[bravo.project.id, 'failed']]);
      await done();
    });

    it('a refused attestation leaves its new bytes unknown: subscribers only, and no owner (A89)', async () => {
      setting(sub, 'subscribe');
      const stale = 'f'.repeat(64);
      const out = await attested(alpha, { [bravo.project.name]: 'b1' }, { base: stale });
      assert.equal(out.code, 'BASE_MISMATCH');
      await out.delivery;
      const revision = store.sharedDocEvents.latest(doc.id);
      assert.equal(revision.authorSource, 'unknown');
      assert.deepEqual(recipients(), [ws(sub)], 'the row\'s owner is not selected for an unattested revision');
      await done();
    });

    it('a re-attestation sends nothing', async () => {
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      await out.delivery;
      bridge.inboxes.clear();
      const again = await sharedDocs.attest(doc.id, {
        baseSha256: out.revision.priorSha256, sha256: out.revision.sha256,
        projectId: alpha.project.id, sessionId: alpha.sessionId, recheck: () => null
      });
      assert.equal(again.already, true);
      assert.equal(again.delivery, undefined);
      assert.equal(bridge.sent.length, 1);
      await done();
    });

    it('a revision that cannot be recorded sends nothing', async () => {
      setting(sub, 'subscribe');
      await assert.rejects(sharedDocs.observe(doc.id, {
        source: 'watch', read: async () => { throw Object.assign(new Error('gone'), { code: 'UNREADABLE' }); }
      }), /gone/);
      await sharedDocs.drain();
      assert.deepEqual(bridge.sent, []);
      await done();
    });
  });

  describe('dispatch-time checks (A89)', () => {
    it('a recipient muted, removed or unsubscribed after resolution is not sent, and says why', async () => {
      setting(sub, 'subscribe');
      setting(charlie, 'subscribe');
      bridge.defer = true;
      const out = await attested(alpha, { [bravo.project.name]: 'b1' });
      // The first of three sends is in flight; settle the others' fates now.
      await until(() => bridge.waiting.length === 1);
      setting(charlie, 'mute', 'doc');
      store.projectGroups.removeMember(group.id, sub.project.id);
      bridge.defer = false;
      bridge.release();
      const counts = await out.delivery;
      const byProject = Object.fromEntries(store.sharedDocDeliveries.listForEvent(out.revision.id).map((r) => [r.projectId, r.outcome]));
      assert.equal(byProject[bravo.project.id], 'sent');
      assert.equal(byProject[charlie.project.id], 'muted');
      assert.equal(byProject[sub.project.id], 'withdrawn');
      assert.deepEqual([counts.notified, counts.muted, counts.withdrawn], [1, 1, 1]);
      assert.equal(store.sharedDocEvents.get(out.revision.id).routing, 'done');
      await done();
    });

    it('a doc deleted while a send is in flight leaves no queued notice to deliver', async () => {
      setting(sub, 'subscribe');
      setting(charlie, 'subscribe');
      bridge.defer = true;
      const out = await unattested({}, 'Prose.');
      await until(() => bridge.waiting.length === 1);
      store.sharedDocs.delete(doc.id);
      bridge.defer = false;
      bridge.release();
      const counts = await out.delivery;
      assert.equal(bridge.sent.length, 1, 'the send already on the wire lands; the next is never made');
      assert.equal(counts.notified, 1);
      await done();
    });
  });

  describe('a delivery the server stopped during (A81 point 5)', () => {
    it('is interrupted, never resent, and a later first attestation binds but sends nothing', async () => {
      setting(sub, 'subscribe');
      bridge.defer = true;
      current = { ...current, [bravo.project.name]: 'b1' };
      const content = board(current, 'Notes.');
      const base = (await sharedDocs.captureBase(doc.id)).sha256;
      fs.writeFileSync(doc.filePath, content);
      const first = await sharedDocs.observe(doc.id, { source: 'watch' });
      await until(() => bridge.waiting.length === 1);
      // What the next boot does before anything else.
      assert.deepEqual(store.sharedDocDeliveries.interruptPending(), { revisions: 1, deliveries: 1 });
      bridge.defer = false;
      bridge.release();
      await first.delivery;
      assert.equal(store.sharedDocEvents.get(first.revision.id).routing, 'interrupted');
      assert.deepEqual(store.sharedDocDeliveries.summary(first.revision.id), { unknown: 1 },
        'a send that may or may not have left keeps the outcome nobody can know');
      bridge.defer = false;
      const out = await sharedDocs.attest(doc.id, {
        baseSha256: base, sha256: sharedDocs.sha256(Buffer.from(content)),
        projectId: alpha.project.id, sessionId: alpha.sessionId, recheck: () => null
      });
      assert.equal(out.status, 200);
      await out.delivery;
      const revision = store.sharedDocEvents.get(first.revision.id);
      assert.equal(revision.authorSource, 'attested');
      assert.equal(revision.routing, 'interrupted');
      assert.equal(store.sharedDocDeliveries.listForEvent(revision.id).length, 1, 'the row owner is not resolved: the delivery is never extended');
      await done();
    });
  });
});

describe('what a shared-doc mute never touches (#2389 criteria 8 and 9)', () => {
  let tmpDir;
  let hub;
  let owner; let peer; let observer;
  let groupId;
  let docId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-notice-mute-paths-'));
    store._setBasePath(tmpDir);
    store.init();
    hub = require('./_bridge-hub').install();
    owner = hub.liveProject('owner-muted', tmpDir);
    peer = hub.liveProject('peer', tmpDir);
    observer = hub.liveProject('observer', tmpDir);
    const group = store.projectGroups.create({ name: 'muted-group' });
    groupId = group.id;
    for (const p of [owner, peer, observer]) store.projectGroups.addMember(group.id, p.project.id);
    const file = path.join(tmpDir, 'QUEUE.md');
    fs.writeFileSync(file, '# queue\n');
    docId = store.sharedDocs.create({ groupId: group.id, name: 'QUEUE', filePath: file }).id;
    // Muted at both scopes.
    store.sharedDocNoticePrefs.set({ projectId: owner.project.id, groupId, setting: 'mute' });
    store.sharedDocNoticePrefs.set({ projectId: owner.project.id, docId, setting: 'mute' });
  });

  after(() => {
    hub.restore();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a direct blocking message reaches its muted owner, and its copy to the Observer is durable in the exchange record (D4)', async () => {
    const toOwner = await hub.sessionSends(peer, { to: owner.workspaceId, text: 'material difficulty', deliver: false });
    assert.equal(toOwner.status, 200);
    assert.ok(hub.sent.some((m) => m.to === owner.workspaceId && m.message === 'material difficulty'));
    const toObserver = await hub.sessionSends(peer, { to: observer.workspaceId, text: 'material difficulty (copy)', deliver: false });
    assert.equal(toObserver.status, 200);
    const exchange = store.medusaExchanges.get(toObserver.body.exchange.exchangeId || toObserver.body.exchange.id);
    assert.ok(exchange, 'the copy is in the exchange record');
  });

  it('a reply in an open exchange reaches the muted session that started it', async () => {
    const asked = await hub.sessionSends(owner, { to: peer.workspaceId, text: 'question', deliver: false });
    assert.equal(asked.status, 200);
    const reply = await hub.sessionSends(peer, { to: owner.workspaceId, text: 'answer', inReplyTo: asked.body.id, deliver: false });
    assert.equal(reply.status, 200);
    assert.ok(hub.sent.some((m) => m.to === owner.workspaceId && m.message === 'answer'));
  });

  it('a HOLD/STOP notice reaches the muted session', async () => {
    const controlApi = require('../lib/control-api');
    const realInternal = { ...controlApi._internal };
    const notices = [];
    controlApi._internal.workspaceIdFor = () => owner.workspaceId;
    controlApi._internal.sendSystemMessage = async (m) => { notices.push(m); return { id: 'n-1' }; };
    try {
      const outcome = await controlApi.notify({
        assignment: { projectId: owner.project.id, assignmentId: 'asg-1', state: 'held', stateGeneration: 1 },
        event: { kind: 'hold', eventId: 'evt-1' }
      });
      assert.equal(outcome, 'sent');
      assert.equal(notices[0].to, owner.workspaceId);
    } finally {
      Object.assign(controlApi._internal, realInternal);
    }
  });
});
