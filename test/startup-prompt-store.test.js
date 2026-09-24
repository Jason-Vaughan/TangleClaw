'use strict';

/*
 * Storage for the startup prompt (#1825): an append-only, revisioned prompt
 * written by compare-and-set with honest provenance and two digests, and a
 * durable record of every fire: idempotent by key, one ACTIVE fire per
 * launch, and an applied revision never recorded as applied twice.
 */

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const store = require('../lib/store.js');

const tmpDirs = [];

/**
 * A fresh store directory, opened as the live store.
 * @param {string} [seedSql] - SQL to run in the database before the store opens it.
 * @returns {string} The directory.
 */
function openStore(seedSql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-prompt-'));
  tmpDirs.push(dir);
  if (seedSql) {
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    db.exec(seedSql);
    db.close();
  }
  store._setBasePath(dir);
  store.init();
  return dir;
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let projectN = 0;
/**
 * A project row the sessions FK can point at.
 * @returns {object} The project.
 */
function project() {
  projectN += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-sp-proj-${projectN}-`));
  tmpDirs.push(dir);
  return store.projects.create({ name: `sp-${projectN}-${Date.now()}`, path: dir, engine: 'codex' });
}

let keyCounter = 0;

/**
 * A fire row for sequence `seq` at prompt revision `rev`.
 * @param {number} seq - Sequence id.
 * @param {number} rev - Prompt revision.
 * @param {string} [outcome='unsupported'] - Outcome.
 * @returns {object}
 */
function fire(seq, rev, outcome = 'unsupported') {
  keyCounter += 1;
  return {
    idempotencyKey: `key-${String(keyCounter).padStart(6, '0')}`,
    projectId: 1, sessionId: 10, sequenceId: seq, promptRevision: rev,
    promptTextDigest: 'd'.repeat(64), policyDigest: 'p'.repeat(64),
    callerKind: 'operator', callerClearance: 'operator-verified', callerProjectId: null,
    outcome, reasonCode: outcome === 'unsupported' ? 'engine_declares_none' : null, reason: 'no adapter'
  };
}

const V44 = `CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO schema_version (version) VALUES (44);`;

describe('startup prompt store (#1825)', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('seed and migration', () => {
    it('a fresh install starts at revision 1: the seed text, an empty firer list, both digests', () => {
      openStore();
      const p = store.startupPrompts.current();
      assert.equal(p.revision, 1);
      assert.equal(p.text, store.STARTUP_PROMPT_SEED);
      assert.equal(p.textDigest, sha(store.STARTUP_PROMPT_SEED));
      assert.deepEqual(p.firerProjectIds, []);
      assert.equal(p.policyDigest, sha('{"firerProjectIds":[]}'));
      assert.equal(p.createdByKind, 'seed');
      assert.equal(p.createdBy, null);
    });

    it('an install upgrading from v44 gets the tables, the seed and the v45 stamp', () => {
      openStore(V44);
      const v = store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      assert.equal(v, store.CURRENT_SCHEMA_VERSION);
      assert.equal(store.startupPrompts.current().revision, 1);
    });

    it('re-opening does not seed a second time', () => {
      const dir = openStore();
      store.startupPrompts.update({ text: 'edited', firerProjectIds: [], expectedRevision: 1, byKind: 'operator-verified', byName: 'rosie' });
      store.close();
      store._setBasePath(dir);
      store.init();
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM startup_prompt_revisions').get().n, 2);
      assert.equal(store.startupPrompts.current().text, 'edited');
    });

    it('refuses to advance past v44 when the fires table lacks its idempotency key', () => {
      const bad = `${V44}
        CREATE TABLE startup_prompt_fires (id INTEGER PRIMARY KEY, idempotency_key TEXT, project_id INTEGER,
          session_id INTEGER, sequence_id INTEGER, prompt_revision INTEGER, prompt_text_digest TEXT,
          policy_digest TEXT, caller_kind TEXT, caller_clearance TEXT, caller_project_id INTEGER,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending')), reason_code TEXT, reason TEXT,
          created_at TEXT, updated_at TEXT);`;
      assert.throws(() => openStore(bad), /idempotency key/);
      store.close();
    });
  });

  describe('update (compare-and-set, provenance, canonical policy)', () => {
    beforeEach(() => openStore());

    it('writes a new revision with its author and how well they were proven', () => {
      const r = store.startupPrompts.update({ text: 'second', firerProjectIds: [], expectedRevision: 1, byKind: 'operator-verified', byName: 'rosie' });
      assert.equal(r.ok, true);
      assert.equal(r.prompt.revision, 2);
      assert.equal(r.prompt.createdByKind, 'operator-verified');
      assert.equal(r.prompt.createdBy, 'rosie');
      assert.equal(store.startupPrompts.get(1).text, store.STARTUP_PROMPT_SEED, 'revision 1 stays readable');
    });

    it('records an open-install author as unverified, with no name', () => {
      const r = store.startupPrompts.update({ text: 'x', firerProjectIds: [], expectedRevision: 1, byKind: 'open-install-unverified', byName: null });
      assert.equal(r.prompt.createdByKind, 'open-install-unverified');
      assert.equal(r.prompt.createdBy, null);
    });

    it('refuses a stale expected revision and names the current one', () => {
      store.startupPrompts.update({ text: 'second', firerProjectIds: [], expectedRevision: 1, byKind: 'operator-verified' });
      const r = store.startupPrompts.update({ text: 'lost', firerProjectIds: [], expectedRevision: 1, byKind: 'operator-verified' });
      assert.deepEqual(r, { ok: false, currentRevision: 2 });
      assert.equal(store.startupPrompts.current().text, 'second');
    });

    it('stores firer ids sorted and unique, with a canonical policy digest', () => {
      store.startupPrompts.update({ text: 't', firerProjectIds: [7, 3, 7], expectedRevision: 1, byKind: 'operator-verified' });
      const p = store.startupPrompts.current();
      assert.deepEqual(p.firerProjectIds, [3, 7]);
      assert.equal(p.policyDigest, sha('{"firerProjectIds":[3,7]}'));
      store.startupPrompts.update({ text: 'other text', firerProjectIds: [7, 3], expectedRevision: 2, byKind: 'operator-verified' });
      assert.equal(store.startupPrompts.current().policyDigest, p.policyDigest, 'the policy digest ignores the text and the order');
      assert.notEqual(store.startupPrompts.current().textDigest, p.textDigest);
    });

    it('reads a corrupt firer list as empty, authorizing no agent', () => {
      store.getDb().prepare("UPDATE startup_prompt_revisions SET firer_project_ids = 'not json' WHERE revision = 1").run();
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, []);
      store.getDb().prepare(`UPDATE startup_prompt_revisions SET firer_project_ids = '["3"]' WHERE revision = 1`).run();
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, [], 'strings are not project ids');
    });

    it('rejects a provenance outside the CHECK and rolls back', () => {
      assert.throws(() => store.startupPrompts.update({ text: 'x', firerProjectIds: [], expectedRevision: 1, byKind: 'operator' }), /CHECK/);
      assert.equal(store.startupPrompts.current().revision, 1);
    });
  });

  describe('fires', () => {
    beforeEach(() => openStore());

    it('stores a fire and finds it by key, with its clearance and typed reason', () => {
      const f = fire(5, 1);
      const row = store.startupPrompts.insertFire(f);
      assert.equal(row.outcome, 'unsupported');
      assert.equal(row.reasonCode, 'engine_declares_none');
      assert.equal(row.callerClearance, 'operator-verified');
      assert.deepEqual(store.startupPrompts.getFireByKey(f.idempotencyKey), row);
    });

    it('a key can be used once', () => {
      const f = fire(5, 1);
      store.startupPrompts.insertFire(f);
      assert.throws(() => store.startupPrompts.insertFire({ ...f, sequenceId: 6 }), /UNIQUE/);
    });

    it('allows one ACTIVE fire per launch, whatever its revision; a settled one does not hold the slot', () => {
      for (const state of store.STARTUP_FIRE_ACTIVE) {
        const seq = 100 + store.STARTUP_FIRE_ACTIVE.indexOf(state);
        store.startupPrompts.insertFire(fire(seq, 1, state));
        assert.throws(() => store.startupPrompts.insertFire(fire(seq, 2, 'pending')), /UNIQUE/, state);
        assert.equal(store.startupPrompts.activeFire(seq).outcome, state);
      }
      store.startupPrompts.insertFire(fire(7, 1, 'failed'));
      assert.doesNotThrow(() => store.startupPrompts.insertFire(fire(7, 2, 'pending')));
    });

    it('never records the same revision as applied twice to one launch', () => {
      store.startupPrompts.insertFire(fire(8, 1, 'applied'));
      assert.throws(() => store.startupPrompts.insertFire(fire(8, 1, 'applied')), /UNIQUE/);
      assert.equal(store.startupPrompts.appliedFire(8, 1).outcome, 'applied');
      assert.doesNotThrow(() => store.startupPrompts.insertFire(fire(8, 2, 'applied')), 'a new revision may apply');
    });

    it('does not make (sequence, revision) permanent across unsupported or failed outcomes', () => {
      store.startupPrompts.insertFire(fire(9, 1, 'unsupported'));
      assert.doesNotThrow(() => store.startupPrompts.insertFire(fire(9, 1, 'unsupported')));
      assert.doesNotThrow(() => store.startupPrompts.insertFire(fire(9, 1, 'failed')));
    });

    it('rejects an unknown outcome or reason code, and caps free-text reasons', () => {
      assert.throws(() => store.startupPrompts.insertFire({ ...fire(11, 1), outcome: 'sent' }), /CHECK/);
      assert.throws(() => store.startupPrompts.insertFire({ ...fire(11, 1), reasonCode: 'because' }), /CHECK/);
      const row = store.startupPrompts.insertFire({ ...fire(11, 1), reason: 'x'.repeat(900) });
      assert.equal(row.reason.length, 500);
    });

    it('lists fires for a session newest first and has no launch-id column', () => {
      store.startupPrompts.insertFire(fire(12, 1));
      store.startupPrompts.insertFire(fire(13, 1));
      assert.deepEqual(store.startupPrompts.firesForSession(10).map((f) => f.sequenceId), [13, 12]);
      const cols = store.getDb().prepare('PRAGMA table_info(startup_prompt_fires)').all().map((c) => c.name);
      assert.ok(!cols.some((c) => /launch/.test(c)), cols.join(','));
    });

    it('rolls a transaction back when its work throws', () => {
      assert.throws(() => store.startupPrompts.transaction(() => {
        store.startupPrompts.insertFire(fire(14, 1));
        throw new Error('boom');
      }), /boom/);
      assert.equal(store.startupPrompts.firesForSession(10).length, 0);
    });
  });
});

/*
 * Chunk B2: the v45→v46 rebuild keeps every fire row and widens the reason
 * CHECK; a fire moves only forward through the transition map; the channels
 * table holds one open channel per session.
 */
const V45_FIRES = `CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO schema_version (version) VALUES (45);
  CREATE TABLE startup_prompt_revisions (
    revision INTEGER PRIMARY KEY CHECK (revision >= 1), text TEXT NOT NULL, text_digest TEXT NOT NULL,
    firer_project_ids TEXT NOT NULL DEFAULT '[]', policy_digest TEXT NOT NULL,
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('seed','operator-verified','open-install-unverified')),
    created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO startup_prompt_revisions (revision, text, text_digest, firer_project_ids, policy_digest, created_by_kind)
    VALUES (1, 'seed', 'd', '[]', 'p', 'seed');
  CREATE TABLE startup_prompt_fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, project_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL, sequence_id INTEGER NOT NULL, prompt_revision INTEGER NOT NULL,
    prompt_text_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
    caller_kind TEXT NOT NULL CHECK (caller_kind IN ('operator','project')),
    caller_clearance TEXT NOT NULL CHECK (caller_clearance IN ('operator-verified','open-install-unverified','project-binding')),
    caller_project_id INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('pending','dispatching','indeterminate','accepted','applied','blocked','failed','interrupted','unsupported','denied')),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('engine_declares_none','fire_scope_denied')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX idx_startup_prompt_fires_session ON startup_prompt_fires(session_id);
  CREATE UNIQUE INDEX idx_startup_prompt_fires_active ON startup_prompt_fires(sequence_id) WHERE outcome IN ('pending','dispatching','indeterminate','accepted');
  CREATE UNIQUE INDEX idx_startup_prompt_fires_applied ON startup_prompt_fires(sequence_id, prompt_revision) WHERE outcome = 'applied';
  INSERT INTO startup_prompt_fires (idempotency_key, project_id, session_id, sequence_id, prompt_revision, prompt_text_digest,
    policy_digest, caller_kind, caller_clearance, caller_project_id, outcome, reason_code, reason)
    VALUES ('old-key-000001', 1, 10, 100, 1, 'd', 'p', 'operator', 'operator-verified', NULL, 'unsupported', 'engine_declares_none', 'no adapter');`;

describe('startup prompt store: v46 (Chunk B2)', () => {
  describe('migration', () => {
    it('rebuilds a v45 fires table: rows survive, the CHECK widens, the receipt columns and indexes exist', () => {
      openStore(V45_FIRES);
      const db = store.getDb();
      assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
      const kept = store.startupPrompts.getFireByKey('old-key-000001');
      assert.ok(kept, 'the v45 row was copied');
      assert.equal(kept.outcome, 'unsupported');
      assert.equal(kept.payloadDigest, null);
      // The widened CHECK accepts a B2 reason code, which v45 refused.
      const row = store.startupPrompts.insertFire({ ...fire(101, 1, 'blocked'), reasonCode: 'trust_required', reason: 'untrusted' });
      assert.equal(row.reasonCode, 'trust_required');
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'startup_prompt_fires'").all().map((r) => r.name);
      for (const idx of ['idx_startup_prompt_fires_session', 'idx_startup_prompt_fires_active', 'idx_startup_prompt_fires_applied']) {
        assert.ok(names.includes(idx), idx);
      }
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'startup_prompt_fires_v46'").get(), undefined, 'no leftover table');
      assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'startup_control_channels'").get(), 'the channels table exists');
    });

    it('a v46-shaped install is not rebuilt again', () => {
      const dir = openStore();
      const before = store.startupPrompts.insertFire(fire(102, 1, 'unsupported'));
      store.close();
      store._setBasePath(dir);
      store.init();
      assert.deepEqual(store.startupPrompts.getFireById(before.id), before);
    });

    it('refuses to advance when the channels table lacks its state CHECK', () => {
      const bad = `${V45_FIRES}
        CREATE TABLE startup_control_channels (id INTEGER PRIMARY KEY, session_id INTEGER, sequence_id INTEGER,
          engine_id TEXT, adapter TEXT, engine_version TEXT, socket_path TEXT, resolved_socket_path TEXT, pid INTEGER,
          thread_id TEXT, state TEXT, opened_at TEXT, closed_at TEXT, close_reason TEXT);`;
      assert.throws(() => openStore(bad), /state CHECK/);
      store.close();
    });
  });

  describe('fire transitions', () => {
    beforeEach(() => openStore());

    it('moves forward through pending, dispatching, accepted and applied, stamping each step once', () => {
      const row = store.startupPrompts.insertFire({ ...fire(200, 1, 'pending'), reasonCode: null, payload: { sessionId: 10 }, payloadDigest: 'pd' });
      assert.deepEqual(row.payload, { sessionId: 10 });
      assert.equal(row.payloadDigest, 'pd');
      let r = store.startupPrompts.updateFire(row.id, { outcome: 'dispatching', engineThreadId: 'T1' });
      assert.equal(r.ok, true);
      assert.equal(r.fire.engineThreadId, 'T1');
      assert.ok(r.fire.dispatchedAt);
      r = store.startupPrompts.updateFire(row.id, { outcome: 'accepted', engineTurnId: 'U1' });
      assert.ok(r.fire.acceptedAt);
      assert.equal(r.fire.engineTurnId, 'U1');
      assert.equal(r.fire.settledAt, null);
      r = store.startupPrompts.updateFire(row.id, { outcome: 'accepted', reasonCode: 'approval_pending', reason: 'waiting' });
      assert.equal(r.ok, true, 'a same-outcome reason refresh is allowed while active');
      assert.equal(r.fire.reasonCode, 'approval_pending');
      r = store.startupPrompts.updateFire(row.id, { outcome: 'applied' });
      assert.ok(r.fire.settledAt);
      assert.equal(r.fire.reasonCode, null, 'a terminal outcome clears the in-flight reason');
    });

    it('never moves a fire backwards or out of a terminal outcome', () => {
      const applied = store.startupPrompts.insertFire(fire(201, 1, 'applied'));
      assert.match(store.startupPrompts.updateFire(applied.id, { outcome: 'accepted' }).reason, /applied fire cannot become accepted/);
      assert.equal(store.startupPrompts.updateFire(applied.id, { outcome: 'applied', reason: 'again' }).ok, false, 'terminal same-outcome edits are refused too');
      const blocked = store.startupPrompts.insertFire({ ...fire(202, 1, 'blocked'), reasonCode: 'trust_required' });
      assert.equal(store.startupPrompts.updateFire(blocked.id, { outcome: 'dispatching' }).ok, false);
      const accepted = store.startupPrompts.insertFire(fire(203, 1, 'accepted'));
      assert.equal(store.startupPrompts.updateFire(accepted.id, { outcome: 'pending' }).ok, false);
      assert.equal(store.startupPrompts.updateFire(accepted.id, { outcome: 'dispatching' }).ok, false);
      assert.equal(store.startupPrompts.updateFire(accepted.id, { outcome: 'nonsense' }).ok, false);
      assert.equal(store.startupPrompts.getFireById(accepted.id).outcome, 'accepted');
      assert.equal(store.startupPrompts.updateFire(9999, { outcome: 'applied' }).ok, false);
    });

    it('an indeterminate fire is settled only forward, by a reconcile', () => {
      const row = store.startupPrompts.insertFire({ ...fire(204, 1, 'indeterminate'), reasonCode: 'send_unconfirmed' });
      assert.equal(store.startupPrompts.activeFire(204).id, row.id, 'indeterminate holds the active slot');
      assert.equal(store.startupPrompts.updateFire(row.id, { outcome: 'dispatching' }).ok, false);
      const r = store.startupPrompts.updateFire(row.id, { outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'no such turn' });
      assert.equal(r.ok, true);
      assert.equal(store.startupPrompts.activeFire(204), null);
    });

    it('a dispatching fire may settle straight from a read-back that found the turn over', () => {
      const row = store.startupPrompts.insertFire(fire(205, 1, 'dispatching'));
      assert.equal(store.startupPrompts.updateFire(row.id, { outcome: 'interrupted', reasonCode: 'turn_interrupted' }).ok, true);
    });
  });

  describe('channels', () => {
    beforeEach(() => openStore());

    const channel = (sessionId, over = {}) => ({
      sessionId, sequenceId: sessionId * 10, engineId: 'codex', adapter: 'codex',
      adapterState: { pid: 4000 + sessionId, socketPath: `/tmp/sc-${sessionId}.sock` }, ...over
    });

    it('opens one channel per session with a generic header, merges adapter state, and closes it once with a reason and a teardown result', () => {
      const c = store.startupControlChannels.open(channel(10));
      assert.equal(c.state, 'open');
      assert.deepEqual(c.adapterState, { pid: 4010, socketPath: '/tmp/sc-10.sock' });
      assert.deepEqual(store.startupControlChannels.getOpenBySession(10), c);
      assert.throws(() => store.startupControlChannels.open(channel(10)), /UNIQUE/, 'a second open channel for the session is refused');
      const merged = store.startupControlChannels.setAdapterState(c.id, { threadId: 'thread-1' });
      assert.deepEqual(merged.adapterState, { pid: 4010, socketPath: '/tmp/sc-10.sock', threadId: 'thread-1' });
      const closed = store.startupControlChannels.close(c.id, 'session killed', 'ok');
      assert.equal(closed.state, 'closed');
      assert.equal(closed.closeReason, 'session killed');
      assert.equal(closed.teardown, 'ok');
      assert.ok(closed.closedAt);
      const again = store.startupControlChannels.close(c.id, 'again', 'signal failed: x');
      assert.equal(again.closeReason, 'session killed', 'the first reason stands');
      assert.equal(again.teardown, 'ok');
      assert.equal(store.startupControlChannels.getOpenBySession(10), null);
      const reopened = store.startupControlChannels.open(channel(10));
      assert.notEqual(reopened.id, c.id, 'a closed channel frees the slot for a relaunch');
      assert.equal(store.startupControlChannels.setAdapterState(9999, { x: 1 }), null);
    });

    it('bounds the adapter state and lists open channels oldest first', () => {
      assert.throws(() => store.startupControlChannels.open(channel(13, { adapterState: { blob: 'x'.repeat(9000) } })), /CHECK/);
      const a = store.startupControlChannels.open(channel(11));
      const b = store.startupControlChannels.open(channel(12));
      store.startupControlChannels.close(a.id, 'ended', 'skipped');
      assert.deepEqual(store.startupControlChannels.listOpen().map((c) => c.id), [b.id]);
    });
  });

  describe('active fires', () => {
    beforeEach(() => openStore());

    it('lists every in-flight fire oldest first, and none that ended', () => {
      const a = store.startupPrompts.insertFire(fire(301, 1, 'pending'));
      store.startupPrompts.insertFire(fire(302, 1, 'applied'));
      const c = store.startupPrompts.insertFire(fire(303, 1, 'accepted'));
      store.startupPrompts.insertFire(fire(304, 1, 'blocked'));
      assert.deepEqual(store.startupPrompts.listActiveFires().map((f) => f.id), [a.id, c.id]);
    });
  });
});

describe('startup prompt store: v47 (Chunk B3)', () => {
  describe('migration', () => {
    it('rebuilds a pre-v47 fires table so the launch caller is recordable, keeps every row, and adds startup_delivery to launch_sequences', () => {
      openStore(V45_FIRES);
      const db = store.getDb();
      assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 47);
      const kept = store.startupPrompts.getFireByKey('old-key-000001');
      assert.ok(kept, 'the old row survived two rebuilds');
      assert.equal(kept.callerKind, 'operator');
      const row = store.startupPrompts.insertFire({
        ...fire(401, 1, 'unsupported'), callerKind: 'launch', callerClearance: 'launch-automatic', callerProjectId: 1
      });
      assert.equal(row.callerKind, 'launch');
      assert.equal(row.callerClearance, 'launch-automatic');
      assert.throws(() => store.startupPrompts.insertFire({ ...fire(402, 1), callerKind: 'robot' }), /CHECK/, 'the CHECK still binds');
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'startup_prompt_fires'").all().map((r) => r.name);
      for (const idx of ['idx_startup_prompt_fires_session', 'idx_startup_prompt_fires_active', 'idx_startup_prompt_fires_applied']) {
        assert.ok(names.includes(idx), idx);
      }
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'startup_prompt_fires_v47'").get(), undefined, 'no leftover table');
      const ls = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'launch_sequences'").get().sql;
      assert.match(ls, /startup_delivery[^,]*CHECK/);
    });

    it('a launch records which path it selected, and every launch that never said reads legacy', () => {
      openStore();
      const snapshot = (over) => ({
        launchId: `L-${Math.random().toString(16).slice(2)}`, pageBudget: 1000, applicability: 'not-applicable',
        notApplicableReason: 'test', preflight: { verdict: 'ok', requiresRecovery: false }, sourceManifest: {}, steps: [], ...over
      });
      const pid = project().id;
      const native = store.sessions.start({ projectId: pid, engineId: 'codex', launchSequence: snapshot({ startupDelivery: 'native' }) });
      store.sessions.kill(native.id, 'next');
      const legacy = store.sessions.start({ projectId: pid, engineId: 'codex', launchSequence: snapshot({}) });
      store.sessions.kill(legacy.id, 'next');
      const odd = store.sessions.start({ projectId: pid, engineId: 'codex', launchSequence: snapshot({ startupDelivery: 'keystrokes' }) });
      assert.equal(store.launchSequences.getBySession(native.id).startupDelivery, 'native');
      assert.equal(store.launchSequences.getBySession(legacy.id).startupDelivery, 'legacy');
      assert.equal(store.launchSequences.getBySession(odd.id).startupDelivery, 'legacy', 'anything but an explicit native is the keystroke path');
    });
  });

  describe('retention runs inside the caller\'s transaction or its own (a savepoint, never a nested BEGIN)', () => {
    beforeEach(() => openStore());

    it('insertFire trims inside the fire service\'s open transaction, and a channel close trims with none open', () => {
      store._setStartupControlRetention({ fires: 1, channels: 1 });
      const pid = project().id;
      const ended = store.sessions.start({ projectId: pid, engineId: 'codex', tmuxSession: 't1' });
      store.sessions.kill(ended.id, 'ended');
      const f = (seq) => ({ ...fire(seq, 1), projectId: pid, sessionId: ended.id });
      const a = store.startupPrompts.transaction(() => store.startupPrompts.insertFire(f(701)));
      const b = store.startupPrompts.transaction(() => store.startupPrompts.insertFire(f(702)));
      assert.equal(store.startupPrompts.getFireById(a.id), null, 'trimmed inside the caller\'s BEGIN IMMEDIATE');
      assert.ok(store.startupPrompts.getFireById(b.id));
      const c = store.startupPrompts.insertFire(f(703));
      assert.equal(store.startupPrompts.getFireById(b.id), null, 'and with no transaction open');
      assert.ok(store.startupPrompts.getFireById(c.id));
      const ch1 = store.startupControlChannels.open({ sessionId: ended.id, sequenceId: 1, engineId: 'codex', adapter: 'codex', adapterState: {} });
      store.startupControlChannels.close(ch1.id, 'x', 'ok');
      const ch2 = store.startupControlChannels.recordUnavailable({ sessionId: ended.id, sequenceId: 2, engineId: 'codex', adapter: 'codex', reason: 'y' });
      assert.equal(store.startupControlChannels.get(ch1.id), null);
      assert.ok(store.startupControlChannels.get(ch2.id));
      assert.equal(store.getDb().isTransaction, false, 'no transaction is left open behind either path');
    });

    it('a failing trim inside a transaction leaves the caller\'s transaction usable', () => {
      const pid = project().id;
      const live = store.sessions.start({ projectId: pid, engineId: 'codex', tmuxSession: 't2' });
      const row = store.startupPrompts.transaction(() => {
        const r = store.startupPrompts.insertFire({ ...fire(801, 1), projectId: pid, sessionId: live.id });
        // A second write in the same transaction after the savepoint released.
        store.getDb().prepare("UPDATE startup_prompt_fires SET reason = 'still in the caller''s transaction' WHERE id = ?").run(r.id);
        return store.startupPrompts.getFireById(r.id);
      });
      assert.equal(row.reason, 'still in the caller\'s transaction');
    });
  });

  describe('retention (F6)', () => {
    let realQuotas;
    beforeEach(() => {
      openStore();
      realQuotas = { ...store.STARTUP_CONTROL_RETENTION };
    });
    after(() => store._setStartupControlRetention(realQuotas));

    /**
     * A session of `projectId`, ended unless `active`.
     * @param {number} projectId - Project.
     * @param {boolean} [active=false] - Leave it running.
     * @returns {object} The session row.
     */
    function session(projectId, active = false) {
      const s = store.sessions.start({ projectId, engineId: 'codex', tmuxSession: `t-${Math.random()}` });
      if (!active) store.sessions.kill(s.id, 'ended');
      return s;
    }

    it('keeps the newest fire rows of ended sessions per target project, and never touches an active session\'s rows', () => {
      store._setStartupControlRetention({ fires: 2 });
      const p1 = project().id;
      const p2 = project().id;
      const ended1 = session(p1);
      const ended2 = session(p1);
      const live = session(p1, true);
      const elsewhere = session(p2);
      const f = (sess, seq, over = {}) => store.startupPrompts.insertFire({ ...fire(seq, 1), projectId: sess.projectId, sessionId: sess.id, ...over });
      const liveOld = f(live, 900, { outcome: 'applied', reasonCode: null });
      const a = f(ended1, 901);
      const b = f(ended1, 902);
      const other = f(elsewhere, 950);
      const c = f(ended2, 903);
      const d = f(ended2, 904);
      // Fired BY project 2 at project 1: partitioned by the target, so it competes in project 1's quota.
      const crossFirer = f(ended2, 905, { callerKind: 'project', callerClearance: 'project-binding', callerProjectId: p2 });
      const ids = store.getDb().prepare('SELECT id FROM startup_prompt_fires ORDER BY id').all().map((r) => r.id);
      assert.deepEqual(ids, [liveOld.id, other.id, d.id, crossFirer.id].sort((x, y) => x - y));
      assert.equal(store.startupPrompts.getFireById(a.id), null);
      assert.equal(store.startupPrompts.getFireById(b.id), null);
      assert.equal(store.startupPrompts.getFireById(c.id), null);
      assert.ok(store.startupPrompts.getFireById(liveOld.id), 'the active session\'s older row is exempt');
      assert.ok(store.startupPrompts.getFireById(other.id), 'another project\'s history is its own');
    });

    it('keeps the newest closed channel rows of ended sessions per project, leaves open and active ones, and trims on close and on recordUnavailable', () => {
      store._setStartupControlRetention({ channels: 1 });
      const p1 = project().id;
      const ended1 = session(p1);
      const ended2 = session(p1);
      const live = session(p1, true);
      const ch = (sess) => store.startupControlChannels.open({ sessionId: sess.id, sequenceId: sess.id * 10, engineId: 'codex', adapter: 'codex', adapterState: {} });
      const liveOpen = ch(live);
      const first = ch(ended1);
      store.startupControlChannels.close(first.id, 'ended', 'ok');
      assert.ok(store.startupControlChannels.get(first.id), 'within quota');
      const second = store.startupControlChannels.recordUnavailable({ sessionId: ended2.id, sequenceId: 20, engineId: 'codex', adapter: 'codex', reason: 'version_unverified' });
      assert.equal(store.startupControlChannels.get(first.id), null, 'the older closed row of an ended session went');
      assert.ok(store.startupControlChannels.get(second.id));
      assert.ok(store.startupControlChannels.get(liveOpen.id), 'an open channel is never a candidate');
      const liveClosedEarlier = store.startupControlChannels.recordUnavailable({ sessionId: live.id, sequenceId: 30, engineId: 'codex', adapter: 'codex', reason: 'x' });
      store.startupControlChannels.close(liveOpen.id, 'k', 'ok');
      assert.ok(store.startupControlChannels.get(liveClosedEarlier.id), 'an active session\'s closed rows are exempt too');
      assert.ok(store.startupControlChannels.get(liveOpen.id));
    });
  });
});
