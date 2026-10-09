'use strict';

/**
 * The durable record of an operator's recovery clearance (#2049, schema v59).
 *
 * `activity_log` is pruned per event type, so it cannot say who cleared a
 * launch for as long as the question can be asked. `launch_recovery_clearances`
 * holds one row per operator clearance, written in the transaction that clears
 * the launch and never changed afterwards. This file holds that contract: what
 * a row carries, that a refusal writes none, that the clear and its record land
 * together or not at all, and that an upgraded store gets the same table as a
 * fresh one.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { clearOneLaunch, OUTCOMES } = require('../lib/launch-recovery-clear');
const { handleRequest } = require('../server');
const fixture = require('./_recovery-fixture');

const OBJECTS = [
  'launch_recovery_clearances', 'idx_launch_recovery_clearances_sequence', 'idx_launch_recovery_clearances_batch',
  'launch_recovery_clearances_append_only_update', 'launch_recovery_clearances_append_only_delete'
];

const OPERATOR = { clearance: 'operator-verified', clearedBy: 'rosie' };

/**
 * How many clearance rows the open store holds.
 * @returns {number}
 */
const rowCount = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_recovery_clearances').get().n;

/**
 * The stored DDL of each clearance object, by name.
 * @param {object} db - An open database
 * @returns {object}
 */
function ddlOf(db) {
  const out = {};
  for (const name of OBJECTS) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
    out[name] = row ? row.sql : null;
  }
  return out;
}

describe('the operator clearance record (#2049)', () => {
  let env;

  before(() => { env = fixture.openTempStore('tc-clearance-audit-'); });
  after(() => { env.restore(); });

  describe('what a clear records', () => {
    it('writes one row naming the launch, the binding, the operator and the evidence', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      const before = rowCount();
      const result = clearOneLaunch({ project, ...binding, ...OPERATOR });
      assert.equal(result.outcome, OUTCOMES.CLEARED);
      assert.equal(rowCount(), before + 1, 'one clear writes one record');

      const record = store.recoveryClearances.getForSequence(sequence.id);
      assert.equal(record.batchId, null, 'a clear made on its own belongs to no batch');
      assert.equal(record.projectId, project.id);
      assert.equal(record.sessionId, sequence.sessionId);
      assert.equal(record.sequenceId, sequence.id);
      assert.equal(record.recoveryRevision, binding.recoveryRevision);
      assert.equal(record.clearance, 'operator-verified');
      assert.equal(record.clearedBy, 'rosie');
      assert.equal(record.clearedAt, result.sequence.recoveryClearedAt, 'the record and the launch row share one time');
      assert.ok(record.clearedAt);
    });

    it('keeps the preflight record exactly as the launch stored it', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      const storedText = store.getDb().prepare('SELECT preflight FROM launch_sequences WHERE id = ?').get(sequence.id).preflight;
      clearOneLaunch({ project, ...binding, ...OPERATOR });
      const recordedText = store.getDb()
        .prepare('SELECT preflight FROM launch_recovery_clearances WHERE sequence_id = ?').get(sequence.id).preflight;
      assert.equal(recordedText, storedText, 'the evidence is copied byte for byte');
      const record = store.recoveryClearances.getForSequence(sequence.id);
      assert.deepEqual(record.preflight, sequence.preflight);
      assert.equal(record.preflight.requiresRecovery, true, 'including the predicate the gate obeyed');
      assert.deepEqual(store.launchSequences.getBySession(sequence.sessionId).preflight, sequence.preflight,
        'and the launch row keeps its own copy untouched');
    });

    it('records an unproven clear as unverified, naming nobody', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      clearOneLaunch({ project, ...binding, clearance: 'open-install-unverified', clearedBy: null });
      const record = store.recoveryClearances.getForSequence(sequence.id);
      assert.equal(record.clearance, 'open-install-unverified');
      assert.equal(record.clearedBy, null);
      assert.equal(record.batchId, null);
    });

    it('records the batch a clear belongs to, and lists a batch in the order it was written', () => {
      const first = fixture.launchInRecovery(env);
      const second = fixture.launchInRecovery(env);
      const alone = fixture.launchInRecovery(env);
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // A clear under a batch needs that batch on record and names its item in it.
      store.recoveryClearBatches.create({ batchId, requestedBy: 'rosie', itemCount: 2 });
      clearOneLaunch({ project: first.project, ...first.binding, ...OPERATOR, batchId, batchItemIndex: 0 });
      clearOneLaunch({ project: alone.project, ...alone.binding, ...OPERATOR });
      clearOneLaunch({ project: second.project, ...second.binding, ...OPERATOR, batchId, batchItemIndex: 1 });
      assert.deepEqual(store.recoveryClearances.listForBatch(batchId).map((r) => r.sequenceId),
        [first.sequence.id, second.sequence.id]);
      assert.deepEqual(store.recoveryClearances.listForBatch('no-such-batch'), []);
    });

    it('answers null for a launch no operator cleared', () => {
      const { sequence } = fixture.launchInRecovery(env);
      assert.equal(store.recoveryClearances.getForSequence(sequence.id), null);
    });
  });

  describe('what writes no record', () => {
    it('a refused clear, whatever the refusal', () => {
      const advisory = fixture.launchInRecovery(env, 'advisory');
      const ended = fixture.launchInRecovery(env);
      store.sessions.kill(ended.sequence.sessionId, 'test');
      const moved = fixture.launchInRecovery(env);
      const mine = fixture.launchInRecovery(env);
      const theirs = fixture.launchInRecovery(env);
      const before = rowCount();

      const outcomes = [
        clearOneLaunch({ project: advisory.project, ...advisory.binding, ...OPERATOR }),
        clearOneLaunch({ project: ended.project, ...ended.binding, ...OPERATOR }),
        clearOneLaunch({
          project: moved.project, ...moved.binding, recoveryRevision: moved.binding.recoveryRevision + 1, ...OPERATOR
        }),
        clearOneLaunch({ project: mine.project, ...theirs.binding, ...OPERATOR })
      ].map((r) => r.outcome);
      assert.deepEqual(outcomes,
        [OUTCOMES.ADVISORY, OUTCOMES.SESSION_ENDED, OUTCOMES.BINDING_MOVED, OUTCOMES.NOT_FOUND]);
      assert.equal(rowCount(), before, 'no refusal wrote a clearance');
      for (const launch of [advisory, ended, moved, mine, theirs]) {
        assert.equal(store.recoveryClearances.getForSequence(launch.sequence.id), null);
      }
    });

    it('a second clear of a launch already cleared', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      clearOneLaunch({ project, ...binding, ...OPERATOR });
      const before = rowCount();
      const again = clearOneLaunch({ project, ...binding, clearance: 'operator-verified', clearedBy: 'someone-else' });
      assert.equal(again.outcome, OUTCOMES.NOT_REQUIRED);
      assert.equal(rowCount(), before);
      assert.equal(store.recoveryClearances.getForSequence(sequence.id).clearedBy, 'rosie', 'the first record stands');
    });

    it('a session\'s own advisory reconciliation, which is not an operator clearance', () => {
      const { sequence, binding } = fixture.launchInRecovery(env, 'advisory');
      const before = rowCount();
      const cleared = store.launchSequences.clearRecovery(sequence.id, {
        sessionId: binding.sessionId, recoveryRevision: binding.recoveryRevision, clearance: 'agent-reconciled'
      });
      assert.equal(cleared.recovery, 'cleared');
      assert.equal(rowCount(), before);
      assert.equal(store.recoveryClearances.getForSequence(sequence.id), null);
    });
  });

  describe('the clear and its record land together', () => {
    /**
     * Make every clearance insert fail until the returned function is called.
     * @returns {() => void} Removes the failure
     */
    function breakTheRecord() {
      store.getDb().exec(`CREATE TRIGGER test_refuse_clearance BEFORE INSERT ON launch_recovery_clearances
        BEGIN SELECT RAISE(ABORT, 'the record cannot be written'); END`);
      return () => store.getDb().exec('DROP TRIGGER test_refuse_clearance');
    }

    it('leaves the launch required when the record cannot be written', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      const before = rowCount();
      const mend = breakTheRecord();
      try {
        assert.throws(() => clearOneLaunch({ project, ...binding, ...OPERATOR }), /the record cannot be written/);
      } finally {
        mend();
      }
      const stored = store.launchSequences.getBySession(sequence.sessionId);
      assert.equal(stored.recovery, 'required', 'the clear was rolled back');
      assert.equal(stored.recoveryClearedAt, null);
      assert.equal(stored.recoveryClearedBy, null);
      assert.equal(stored.recoveryClearance, null);
      assert.equal(rowCount(), before);
      assert.deepEqual(
        store.activity.query({ projectId: project.id, eventType: 'launch.recovery-cleared', limit: 50 }), [],
        'and no activity row claims a clear that did not happen');

      // The same binding still clears once the record can be written: the
      // failure left nothing half-done behind it.
      assert.equal(clearOneLaunch({ project, ...binding, ...OPERATOR }).outcome, OUTCOMES.CLEARED);
      assert.equal(store.recoveryClearances.getForSequence(sequence.id).clearedBy, 'rosie');
    });

    it('does not leave a transaction open after the failure', () => {
      const failed = fixture.launchInRecovery(env);
      const mend = breakTheRecord();
      try {
        assert.throws(() => clearOneLaunch({ project: failed.project, ...failed.binding, ...OPERATOR }));
      } finally {
        mend();
      }
      const next = fixture.launchInRecovery(env);
      assert.equal(clearOneLaunch({ project: next.project, ...next.binding, ...OPERATOR }).outcome, OUTCOMES.CLEARED);
    });
  });

  describe('the record cannot be rewritten', () => {
    it('refuses an update and a delete', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      clearOneLaunch({ project, ...binding, ...OPERATOR });
      const db = store.getDb();
      assert.throws(
        () => db.prepare("UPDATE launch_recovery_clearances SET cleared_by = 'mallory' WHERE sequence_id = ?").run(sequence.id),
        /append-only/);
      assert.throws(
        () => db.prepare('DELETE FROM launch_recovery_clearances WHERE sequence_id = ?').run(sequence.id),
        /append-only/);
      assert.equal(store.recoveryClearances.getForSequence(sequence.id).clearedBy, 'rosie');
    });

    it('refuses a second record for one launch', () => {
      const { project, sequence, binding } = fixture.launchInRecovery(env);
      clearOneLaunch({ project, ...binding, ...OPERATOR });
      assert.throws(() => store.getDb().prepare(
        `INSERT INTO launch_recovery_clearances
           (project_id, session_id, sequence_id, recovery_revision, clearance, cleared_by, preflight, cleared_at)
         VALUES (?, ?, ?, 1, 'operator-verified', 'mallory', '{}', datetime('now'))`
      ).run(project.id, sequence.sessionId, sequence.id), /UNIQUE/);
    });

    /**
     * Insert a hand-made clearance row for a launch that does not exist.
     * @param {object} fields - `batchId`, `clearance`, `clearedBy`
     * @returns {void}
     */
    function insertRaw({ batchId = null, clearance, clearedBy }) {
      store.getDb().prepare(
        `INSERT INTO launch_recovery_clearances
           (batch_id, project_id, session_id, sequence_id, recovery_revision, clearance, cleared_by, preflight, cleared_at)
         VALUES (?, 1, 1, ?, 1, ?, ?, '{}', datetime('now'))`
      ).run(batchId, 900000 + Math.floor(Math.random() * 90000), clearance, clearedBy);
    }

    it('refuses a verified clearance that names nobody, and an unverified one that names someone', () => {
      assert.throws(() => insertRaw({ clearance: 'operator-verified', clearedBy: null }), /CHECK/);
      assert.throws(() => insertRaw({ clearance: 'open-install-unverified', clearedBy: 'rosie' }), /CHECK/);
    });

    it('refuses a batch on an install that proved no operator', () => {
      assert.throws(() => insertRaw({ batchId: 'b1', clearance: 'open-install-unverified', clearedBy: null }), /CHECK/);
    });

    it('refuses a clearance word that is not an operator\'s', () => {
      assert.throws(() => insertRaw({ clearance: 'agent-reconciled', clearedBy: null }), /CHECK/);
    });
  });

  describe('through the clear route', () => {
    const client = fixture.makeClient(handleRequest);
    const clearUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/launch/recovery-clear`;

    beforeEach(() => { fixture.resetLogin(); });
    after(() => { fixture.resetLogin(); });

    it('a signed-in operator\'s clear is recorded under their name, in no batch', async () => {
      const held = fixture.launchInRecovery(env);
      client.arm();
      const { cookie, csrf } = await client.signIn();
      const res = await client.send('POST', clearUrl(held.project), {
        body: held.binding, headers: { cookie, 'x-csrf-token': csrf }
      });
      assert.equal(res.statusCode, 200, res.body);
      const record = store.recoveryClearances.getForSequence(held.sequence.id);
      assert.equal(record.clearance, 'operator-verified');
      assert.equal(record.clearedBy, 'rosie');
      assert.equal(record.batchId, null);
    });

    it('an open install\'s clear is recorded as unverified', async () => {
      const held = fixture.launchInRecovery(env);
      const token = await client.pageToken();
      const res = await client.send('POST', clearUrl(held.project), {
        body: held.binding, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 200, res.body);
      const record = store.recoveryClearances.getForSequence(held.sequence.id);
      assert.equal(record.clearance, 'open-install-unverified');
      assert.equal(record.clearedBy, null);
    });

    it('answers an error and clears nothing when the record cannot be written', async () => {
      const held = fixture.launchInRecovery(env);
      const token = await client.pageToken();
      store.getDb().exec(`CREATE TRIGGER test_refuse_clearance_route BEFORE INSERT ON launch_recovery_clearances
        BEGIN SELECT RAISE(ABORT, 'the record cannot be written'); END`);
      let res;
      try {
        res = await client.send('POST', clearUrl(held.project), {
          body: held.binding, headers: { 'x-tc-open-token': token }
        });
      } finally {
        store.getDb().exec('DROP TRIGGER test_refuse_clearance_route');
      }
      assert.equal(res.statusCode, 500, res.body);
      assert.equal(store.launchSequences.getBySession(held.sequence.sessionId).recovery, 'required',
        'a caller told the clear failed must not find the launch cleared');
      assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null);
    });

    it('a refused clear records nothing', async () => {
      const held = fixture.launchInRecovery(env);
      store.sessions.kill(held.sequence.sessionId, 'test');
      const token = await client.pageToken();
      const res = await client.send('POST', clearUrl(held.project), {
        body: held.binding, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(store.recoveryClearances.getForSequence(held.sequence.id), null);
    });
  });
});

describe('store: the clearance record schema (v59, #2049)', () => {
  const dirs = [];
  const prevBase = store._getBasePath();

  /**
   * A new temp directory, removed after the suite.
   * @param {string} label - Directory label
   * @returns {string}
   */
  function tmp(label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-clearance-v59-${label}-`));
    dirs.push(dir);
    return dir;
  }

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A store as a v58 server left it: no clearance objects, stamped 58, with a
   * project and a launch already cleared the old way.
   * @returns {string} Its directory
   */
  function seedV58() {
    const dir = tmp('v58');
    store.close();
    store._setBasePath(dir);
    store.init();
    store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
    store.close();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    db.exec('DROP TRIGGER launch_recovery_clearances_append_only_update');
    db.exec('DROP TRIGGER launch_recovery_clearances_append_only_delete');
    db.exec('DROP TABLE launch_recovery_clearances');
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (58)');
    db.close();
    return dir;
  }

  it('is at least the schema version this table arrived in', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 59);
  });

  it('gives an upgraded store the same table, indexes and triggers as a fresh one', () => {
    const freshDir = tmp('fresh');
    store.close();
    store._setBasePath(freshDir);
    store.init();
    const fresh = ddlOf(store.getDb());
    for (const name of OBJECTS) assert.ok(fresh[name], `a fresh store has ${name}`);
    store.close();

    const dir = seedV58();
    const probe = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.deepEqual(Object.values(ddlOf(probe)).filter(Boolean), [], 'precondition: the v58 store has none of them');
    probe.close();

    store._setBasePath(dir);
    store.init();
    assert.deepEqual(ddlOf(store.getDb()), fresh);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.ok(store.projects.getByName('carried'), 'the upgrade keeps the projects it found');
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM launch_recovery_clearances').get().n, 0,
      'and invents no record for a clearance made before the table existed');
  });

  it('refuses to advance over a table that cannot keep the record', () => {
    const dir = seedV58();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    // A table of the right name with none of the constraints the record rests on.
    db.exec(`CREATE TABLE launch_recovery_clearances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, project_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
      sequence_id INTEGER NOT NULL, recovery_revision INTEGER NOT NULL, clearance TEXT NOT NULL, cleared_by TEXT,
      preflight TEXT NOT NULL, cleared_at TEXT NOT NULL)`);
    db.close();
    store._setBasePath(dir);
    assert.throws(() => store.init(), /v58→v59 left launch_recovery_clearances without the CHECK/);
    store.close();
    const after = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 58,
      'the version stays where it was');
    after.close();
  });

  it('is unharmed by a second boot', () => {
    const dir = seedV58();
    store._setBasePath(dir);
    store.init();
    const first = ddlOf(store.getDb());
    store.close();
    store.init();
    assert.deepEqual(ddlOf(store.getDb()), first);
    assert.equal(
      store.getDb().prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?').get(store.CURRENT_SCHEMA_VERSION).n,
      1, 'the version is stamped once');
  });
});
