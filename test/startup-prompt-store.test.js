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
