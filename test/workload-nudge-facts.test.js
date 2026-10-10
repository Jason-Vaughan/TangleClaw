'use strict';

/**
 * The record of what the workload nudge monitor did about an expired receipt
 * (schema v61, #2262).
 *
 * Two properties carry the weight. A fact is recorded once: the monitor asks
 * the table, on every tick and after every restart, whether an expiry has had
 * its nudge, so a second row for the same fact would be a lane typed into
 * twice. And the record cannot be rewritten: a run's account of how each stall
 * was noticed is only worth reading if nothing could have edited it.
 *
 * The `nudged` fact has no route, and SQLite treats two NULLs as different
 * values in a unique index. The case that would slip through a plain index is
 * tested by name.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store.js');

/** Every object the v61 migration creates. */
const OBJECTS = [
  'workload_nudge_facts',
  'idx_workload_nudge_facts_once',
  'idx_workload_nudge_facts_created',
  'workload_nudge_facts_append_only_update',
  'workload_nudge_facts_append_only_delete'
];

const prevBase = store._getBasePath();
const dirs = [];

/**
 * A new temp directory, removed after the file's tests.
 * @param {string} label - Directory label
 * @returns {string}
 */
function tmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-nudge-facts-${label}-`));
  dirs.push(dir);
  return dir;
}

/**
 * Point the store at a fresh directory and open it.
 * @param {string} label - Directory label
 * @returns {string} The directory
 */
function openFresh(label) {
  const dir = tmp(label);
  store.close();
  store._setBasePath(dir);
  store.init();
  return dir;
}

/**
 * A fact row as the monitor would hand it over, with the given fields changed.
 * @param {object} [over] - Fields to override
 * @returns {object}
 */
function fact(over = {}) {
  return {
    project_id: 11,
    session_id: 22,
    launch_id: 'launch-a',
    receipt_id: 100,
    kind: 'nudged',
    code: 'nudged',
    engine_activity: 'at-rest',
    engine_reason: 'at-rest',
    detail_json: JSON.stringify({ silentSeconds: 1900 }),
    created_at: '2026-10-09T10:00:00.000Z',
    ...over
  };
}

after(() => {
  store.close();
  store._setBasePath(prevBase);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('store: the workload nudge fact schema (v61, #2262)', () => {
  /**
   * The stored DDL of each v61 object, by name.
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

  /**
   * A store as a v60 server left it: no nudge objects, stamped 60, with a
   * project and a workload receipt already in it.
   * @returns {string} Its directory
   */
  function seedV60() {
    const dir = openFresh('v60');
    store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
    store.workloadReceipts.append({
      project_id: 1, session_id: 1, launch_id: 'carried-launch', state: 'working', clearance: 'do-not-clear',
      summary: 'carried', refs_json: '{}', source: 'tc-cli', received_at: '2026-10-09T09:00:00.000Z'
    }, { minIntervalMs: 0, nowMs: Date.parse('2026-10-09T09:00:00.000Z') });
    store.close();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    // Dropping a table drops its triggers and indexes with it.
    db.exec('DROP TABLE workload_nudge_facts');
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (60)');
    db.close();
    return dir;
  }

  it('is at least the schema version this table arrived in', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 61);
  });

  it('gives an upgraded store the same table, indexes and triggers as a fresh one', () => {
    openFresh('fresh');
    const fresh = ddlOf(store.getDb());
    for (const name of OBJECTS) assert.ok(fresh[name], `a fresh store has ${name}`);
    store.close();

    const dir = seedV60();
    const probe = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.deepEqual(Object.values(ddlOf(probe)).filter(Boolean), [], 'precondition: the v60 store has none of them');
    probe.close();

    store._setBasePath(dir);
    store.init();
    assert.deepEqual(ddlOf(store.getDb()), fresh);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.ok(store.projects.getByName('carried'), 'the upgrade keeps the projects it found');
    assert.equal(store.workloadReceipts.listForLaunch('carried-launch').length, 1, 'and the receipts');
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM workload_nudge_facts').get().n, 0, 'and invents no fact');
  });

  it('refuses to advance over a table that would let a fact be recorded twice', () => {
    const dir = seedV60();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    // The right table, with a plain unique index in place of the one that reads
    // a missing route as ''. Two `nudged` rows for one receipt would both fit.
    db.exec(`CREATE TABLE workload_nudge_facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
      launch_id TEXT NOT NULL, receipt_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('nudged','not-nudged','escalated','escalation-undeliverable')),
      route TEXT CHECK (route IS NULL OR route IN ('coordinator','operator')),
      target_project_id INTEGER, code TEXT NOT NULL, engine_activity TEXT, engine_reason TEXT,
      detail_json TEXT, created_at TEXT NOT NULL)`);
    db.exec('CREATE UNIQUE INDEX idx_workload_nudge_facts_once ON workload_nudge_facts(receipt_id, kind, route)');
    db.close();
    store._setBasePath(dir);
    assert.throws(() => store.init(), /v60→v61 left no index keeping a fact to one row per receipt, kind and route/);
    store.close();
    const left = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    assert.equal(left.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 60, 'the version stays where it was');
    left.close();
  });

  it('refuses to advance over a table whose kind admits any word', () => {
    const dir = seedV60();
    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    db.exec(`CREATE TABLE workload_nudge_facts (
      fact_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
      launch_id TEXT NOT NULL, receipt_id INTEGER NOT NULL, kind TEXT NOT NULL, route TEXT,
      target_project_id INTEGER, code TEXT NOT NULL, engine_activity TEXT, engine_reason TEXT,
      detail_json TEXT, created_at TEXT NOT NULL)`);
    db.close();
    store._setBasePath(dir);
    assert.throws(() => store.init(), /v60→v61 left workload_nudge_facts without "nudged" in its CHECKs/);
    store.close();
  });

  it('is unharmed by a second boot', () => {
    const dir = seedV60();
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

describe('store.workloadNudgeFacts (#2262)', () => {
  before(() => {
    openFresh('facts');
  });

  it('records a fact once and says whether this call was the one that recorded it', () => {
    const first = store.workloadNudgeFacts.record(fact());
    assert.equal(first.recorded, true);
    assert.equal(first.row.kind, 'nudged');
    assert.equal(first.row.route, null);
    assert.equal(first.row.created_at, '2026-10-09T10:00:00.000Z');

    // A second tick, a minute later, reporting the same fact.
    const second = store.workloadNudgeFacts.record(fact({ created_at: '2026-10-09T10:01:00.000Z', code: 'changed' }));
    assert.equal(second.recorded, false, 'a nudged fact has no route, and is still recorded once');
    assert.equal(second.row.fact_id, first.row.fact_id, 'the answer is the fact already on record');
    assert.equal(second.row.created_at, '2026-10-09T10:00:00.000Z', 'which keeps its own time');
    assert.equal(second.row.code, 'nudged');
    assert.equal(store.workloadNudgeFacts.listForReceipt(100).length, 1);
  });

  it('counts a fact per receipt, per kind and per route', () => {
    const escalatedToCoordinator = fact({
      receipt_id: 101, kind: 'escalated', route: 'coordinator', target_project_id: 7, code: 'escalated'
    });
    assert.equal(store.workloadNudgeFacts.record(fact({ receipt_id: 101 })).recorded, true, 'another receipt');
    assert.equal(store.workloadNudgeFacts.record(escalatedToCoordinator).recorded, true, 'another kind');
    assert.equal(store.workloadNudgeFacts.record(fact({
      receipt_id: 101, kind: 'escalated', route: 'operator', code: 'escalated-operator'
    })).recorded, true, 'another route');
    assert.equal(store.workloadNudgeFacts.record(escalatedToCoordinator).recorded, false);
  });

  it('returns a receipt\'s facts in the order they were recorded, and none for a receipt with none', () => {
    const facts = store.workloadNudgeFacts.listForReceipt(101);
    assert.deepEqual(facts.map((f) => [f.kind, f.route]), [
      ['nudged', null], ['escalated', 'coordinator'], ['escalated', 'operator']
    ]);
    assert.equal(facts[1].target_project_id, 7);
    assert.equal(facts[0].engine_activity, 'at-rest');
    assert.deepEqual(JSON.parse(facts[0].detail_json), { silentSeconds: 1900 });
    assert.deepEqual(store.workloadNudgeFacts.listForReceipt(999), []);
  });

  it('takes every kind and both routes the monitor will ever record', () => {
    for (const kind of store.WORKLOAD_NUDGE_FACT_KINDS) {
      const route = kind === 'nudged' ? null : 'operator';
      assert.equal(store.workloadNudgeFacts.record(fact({ receipt_id: 200, kind, route })).recorded, true, kind);
    }
    assert.equal(store.workloadNudgeFacts.record(fact({ receipt_id: 201, kind: 'not-nudged', route: null })).recorded, true,
      'a reason for not nudging may name no route');
    assert.deepEqual([...store.WORKLOAD_NUDGE_ROUTES], ['coordinator', 'operator']);
  });

  it('throws on a fact the table refuses, and records nothing for it', () => {
    const refused = [
      [{ kind: 'reminded' }, /CHECK constraint failed/],
      [{ kind: 'escalated', route: 'discord' }, /CHECK constraint failed/],
      [{ kind: 'nudged', route: 'operator' }, /CHECK constraint failed/],
      [{ kind: 'escalated', route: null }, /CHECK constraint failed/],
      [{ kind: 'escalation-undeliverable', route: null }, /CHECK constraint failed/],
      [{ kind: 'escalated', route: 'operator', target_project_id: 7 }, /CHECK constraint failed/],
      [{ code: '' }, /CHECK constraint failed/],
      [{ launch_id: '' }, /CHECK constraint failed/],
      [{ detail_json: 'x'.repeat(2049) }, /CHECK constraint failed/],
      [{ created_at: null }, /NOT NULL constraint failed/]
    ];
    for (const [over, message] of refused) {
      assert.throws(() => store.workloadNudgeFacts.record(fact({ receipt_id: 300, ...over })), message, JSON.stringify(over));
    }
    assert.deepEqual(store.workloadNudgeFacts.listForReceipt(300), []);
    // The transaction a refusal rolled back left the store writable.
    assert.equal(store.workloadNudgeFacts.record(fact({ receipt_id: 300 })).recorded, true);
  });

  it('refuses to change or remove a fact', () => {
    const db = store.getDb();
    assert.throws(() => db.prepare("UPDATE workload_nudge_facts SET code = 'rewritten' WHERE receipt_id = 100").run(),
      /workload_nudge_facts is append-only/);
    assert.throws(() => db.prepare('DELETE FROM workload_nudge_facts WHERE receipt_id = 100').run(),
      /workload_nudge_facts is append-only/);
    assert.equal(store.workloadNudgeFacts.listForReceipt(100)[0].code, 'nudged');
  });

  it('reads back the facts of a span of time, oldest first, the end left out', () => {
    openFresh('span');
    const at = (minute) => `2026-10-09T11:${String(minute).padStart(2, '0')}:00.000Z`;
    store.workloadNudgeFacts.record(fact({ receipt_id: 3, created_at: at(30) }));
    store.workloadNudgeFacts.record(fact({ receipt_id: 1, created_at: at(10) }));
    store.workloadNudgeFacts.record(fact({ receipt_id: 2, created_at: at(20) }));
    store.workloadNudgeFacts.record(fact({ receipt_id: 2, kind: 'escalated', route: 'operator', created_at: at(20) }));

    const span = store.workloadNudgeFacts.listBetween(at(10), at(30));
    assert.deepEqual(span.map((f) => [f.receipt_id, f.kind]), [[1, 'nudged'], [2, 'nudged'], [2, 'escalated']]);
    assert.deepEqual(store.workloadNudgeFacts.listBetween(at(40), at(50)), []);
    assert.equal(store.workloadNudgeFacts.listBetween(at(0), at(59), { limit: 2 }).length, 2);
    assert.equal(store.workloadNudgeFacts.listBetween(at(0), at(59), { limit: 0 }).length, 4, 'a limit that is no limit is ignored');
  });
});
