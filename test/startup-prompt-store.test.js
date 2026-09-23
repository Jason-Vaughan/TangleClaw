'use strict';

/*
 * Storage for the startup prompt (#1825): an append-only, revisioned prompt
 * written by compare-and-set, and a durable audit of every fire, idempotent per
 * launch and revision with at most one fire in flight per launch.
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

/**
 * A fire record for sequence `seq` at prompt revision `rev`.
 * @param {number} seq - Sequence id.
 * @param {number} rev - Prompt revision.
 * @param {string} [outcome='unsupported'] - Outcome.
 * @returns {object}
 */
function fire(seq, rev, outcome = 'unsupported') {
  return {
    sessionId: 10, sequenceId: seq, promptRevision: rev, promptDigest: 'd'.repeat(64),
    callerKind: 'operator', callerProjectId: null, outcome, reason: 'no adapter'
  };
}

describe('startup prompt store (#1825)', () => {
  after(() => {
    store.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('seed and migration', () => {
    it('a fresh install starts at revision 1 with the seed text and its digest', () => {
      openStore();
      const p = store.startupPrompts.current();
      assert.equal(p.revision, 1);
      assert.equal(p.text, store.STARTUP_PROMPT_SEED);
      assert.equal(p.digest, crypto.createHash('sha256').update(store.STARTUP_PROMPT_SEED).digest('hex'));
      assert.equal(p.createdByKind, 'seed');
    });

    it('an install upgrading from v44 gets the tables, the seed and the v45 stamp', () => {
      openStore(`CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_version (version) VALUES (44);`);
      const v = store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      assert.equal(v, store.CURRENT_SCHEMA_VERSION);
      assert.equal(store.startupPrompts.current().revision, 1);
    });

    it('re-opening does not seed a second time', () => {
      const dir = openStore();
      store.startupPrompts.update({ text: 'edited', expectedRevision: 1, byKind: 'operator' });
      store.close();
      store._setBasePath(dir);
      store.init();
      const rows = store.getDb().prepare('SELECT COUNT(*) AS n FROM startup_prompt_revisions').get().n;
      assert.equal(rows, 2);
      assert.equal(store.startupPrompts.current().text, 'edited');
    });

    it('refuses to advance past v44 when the fires table lacks its idempotency key', () => {
      const bad = `CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_version (version) VALUES (44);
        CREATE TABLE startup_prompt_fires (id INTEGER PRIMARY KEY, session_id INTEGER, sequence_id INTEGER,
          prompt_revision INTEGER, prompt_digest TEXT, caller_kind TEXT, caller_project_id INTEGER,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending')), reason TEXT, created_at TEXT, updated_at TEXT);`;
      assert.throws(() => openStore(bad), /idempotency key/);
      store.close();
    });
  });

  describe('update (compare-and-set)', () => {
    beforeEach(() => openStore());

    it('writes a new revision when the expected revision is current', () => {
      const r = store.startupPrompts.update({ text: 'second', expectedRevision: 1, byKind: 'operator' });
      assert.equal(r.ok, true);
      assert.equal(r.prompt.revision, 2);
      assert.equal(r.prompt.text, 'second');
      assert.equal(store.startupPrompts.get(1).text, store.STARTUP_PROMPT_SEED, 'revision 1 stays readable');
    });

    it('refuses a stale expected revision and names the current one', () => {
      store.startupPrompts.update({ text: 'second', expectedRevision: 1, byKind: 'operator' });
      const r = store.startupPrompts.update({ text: 'lost update', expectedRevision: 1, byKind: 'operator' });
      assert.deepEqual(r, { ok: false, currentRevision: 2 });
      assert.equal(store.startupPrompts.current().text, 'second');
    });

    it('stores the firer list with the revision, and the seed authorizes no agent', () => {
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, []);
      store.startupPrompts.update({ text: 't', firerProjectIds: [3, 7], expectedRevision: 1, byKind: 'operator' });
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, [3, 7]);
      assert.deepEqual(store.startupPrompts.get(1).firerProjectIds, [], 'an older revision keeps its own list');
    });

    it('reads a corrupt firer list as empty, authorizing no agent', () => {
      store.getDb().prepare("UPDATE startup_prompt_revisions SET firer_project_ids = 'not json' WHERE revision = 1").run();
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, []);
      store.getDb().prepare(`UPDATE startup_prompt_revisions SET firer_project_ids = '["3"]' WHERE revision = 1`).run();
      assert.deepEqual(store.startupPrompts.current().firerProjectIds, [], 'strings are not project ids');
    });

    it('rejects a created_by_kind outside the CHECK', () => {
      assert.throws(() => store.startupPrompts.update({ text: 'x', expectedRevision: 1, byKind: 'agent' }), /CHECK/);
      assert.equal(store.startupPrompts.current().revision, 1, 'the failed insert rolled back');
    });
  });

  describe('fires', () => {
    beforeEach(() => openStore());

    it('records a fire and returns the same row on a repeat, marked duplicate', () => {
      const first = store.startupPrompts.recordFire(fire(5, 1));
      assert.equal(first.duplicate, false);
      assert.equal(first.fire.outcome, 'unsupported');
      const again = store.startupPrompts.recordFire(fire(5, 1, 'pending'));
      assert.equal(again.duplicate, true);
      assert.equal(again.fire.id, first.fire.id);
      assert.equal(again.fire.outcome, 'unsupported', 'a repeat never rewrites the recorded outcome');
    });

    it('allows only one fire in flight per launch, whatever its revision', () => {
      store.startupPrompts.recordFire(fire(6, 1, 'pending'));
      assert.throws(() => store.startupPrompts.recordFire(fire(6, 2, 'pending')), /UNIQUE/);
      // A settled fire does not hold the slot.
      store.startupPrompts.recordFire(fire(7, 1, 'unsupported'));
      assert.doesNotThrow(() => store.startupPrompts.recordFire(fire(7, 2, 'pending')));
    });

    it('lists fires for a session newest first and never stores a launch id', () => {
      store.startupPrompts.recordFire(fire(8, 1));
      store.startupPrompts.recordFire(fire(9, 1));
      const list = store.startupPrompts.firesForSession(10);
      assert.deepEqual(list.map((f) => f.sequenceId), [9, 8]);
      const cols = store.getDb().prepare('PRAGMA table_info(startup_prompt_fires)').all().map((c) => c.name);
      assert.ok(!cols.some((c) => /launch/.test(c)), `no launch-id column: ${cols.join(',')}`);
    });
  });
});
