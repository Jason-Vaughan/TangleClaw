'use strict';

// #2322: schema v64 adds the merge queue's tables. A fresh install gets them at
// the current version; a v63 store gains them, empty, through the migration.
// The promises the queue rests on (one active queue, one unfinished entry per
// pull request, one active entry, an append-only history) are asked of the
// database directly here, because they have to hold whatever code writes.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const TABLES = ['merge_queue_events', 'merge_queue_entries', 'merge_queues'];
const TRIGGERS = ['merge_queue_events_append_only_update', 'merge_queue_events_append_only_delete'];
const INDEXES = [
  'idx_merge_queues_one_active', 'idx_merge_queue_entries_position', 'idx_merge_queue_entries_one_per_pr',
  'idx_merge_queue_entries_one_active', 'idx_merge_queue_events_sequence', 'idx_merge_queue_events_entry'
];
const OBJECTS = [...TABLES, ...TRIGGERS, ...INDEXES];

let tmpDir = null;

/**
 * Start a store on a new temporary directory.
 * @returns {object} The database
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-queue-schema-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

/**
 * Close the store and open it again on the same directory, which runs any
 * pending migration.
 * @returns {object} The database
 */
function reopen() {
  store.close();
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

/**
 * The stored definition of every merge queue object, by name.
 * @param {object} db - The database
 * @returns {Object<string, string>}
 */
function definitions(db) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%merge_queue%' ORDER BY name").all();
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

/**
 * Take a current store back to what a v63 store is: no merge queue objects and
 * a version stamp of 63.
 * @param {object} db - The database
 * @returns {void}
 */
function backToV63(db) {
  for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
  db.exec('DELETE FROM schema_version WHERE version >= 64');
  db.exec('INSERT INTO schema_version (version) VALUES (63)');
}

/**
 * The highest schema version stamped.
 * @param {object} db - The database
 * @returns {number}
 */
function version(db) {
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
}

/**
 * Insert a queue row directly.
 * @param {object} db - The database
 * @param {string} id - Queue id
 * @param {object} [fields] - Columns to change
 * @returns {void}
 */
function insertQueue(db, id, fields = {}) {
  const row = {
    queue_id: id, repo: 'Jason-Vaughan/TangleClaw', base_branch: 'main', owner_project_id: 7, status: 'active',
    created_by_kind: 'operator', created_by_proof: 'verified-session', created_at: '2026-10-12T05:00:00.000Z', ...fields
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO merge_queues (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
}

/**
 * Insert an entry row directly.
 * @param {object} db - The database
 * @param {string} id - Entry id
 * @param {object} [fields] - Columns to change
 * @returns {void}
 */
function insertEntry(db, id, fields = {}) {
  const at = '2026-10-12T05:00:00.000Z';
  const row = {
    entry_id: id, queue_id: 'mq_1', pr_number: 1, head_sha: 'a'.repeat(40), position: 1, state: 'queued',
    review_gate_status: 'recorded', review_gate_ref: 'r', test_gate_status: 'recorded', test_gate_ref: 't',
    base_gate_status: 'recorded', base_gate_ref: 'b', operator_gate_status: 'not-required',
    submitted_by_project_id: 7, submitted_by_launch_id: 'launch', created_at: at, updated_at: at, ...fields
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO merge_queue_entries (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
}

/** The candidate columns an entry needs once it is past assembling. */
const CANDIDATE = { candidate_ref: 'tc-queue/x', candidate_base_sha: 'b'.repeat(40), candidate_sha: 'c'.repeat(40), candidate_tree: 'd'.repeat(40) };

describe('store: merge queue schema (v64, #2322)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('is at schema version 64 or later', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 64);
  });

  it('a fresh install has the three tables, empty, with their indexes and triggers, at the current version', () => {
    const db = freshStore();
    const have = definitions(db);
    for (const name of OBJECTS) assert.ok(have[name], `missing ${name}`);
    for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
  });

  it('a v63 store migrates to the same shape a fresh install has, with the tables empty', () => {
    let db = freshStore();
    const fresh = definitions(db);
    backToV63(db);
    assert.deepEqual(definitions(db), {});
    assert.equal(version(db), 63);

    db = reopen();
    assert.deepEqual(definitions(db), fresh);
    for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version WHERE version >= 63 ORDER BY version').all().map((r) => r.version).slice(0, 2), [63, 64]);
  });

  it('migrating twice changes nothing: rows survive, nothing is stamped again', () => {
    let db = freshStore();
    backToV63(db);
    db = reopen();
    insertQueue(db, 'mq_1');
    insertEntry(db, 'mqe_1');
    const shape = definitions(db);
    const stamps = db.prepare('SELECT version FROM schema_version ORDER BY version').all();

    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(), stamps);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merge_queues').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merge_queue_entries').get().n, 1);

    // The migration body itself, run again over a store that already has the tables.
    db.exec('DELETE FROM schema_version WHERE version >= 64');
    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merge_queue_entries').get().n, 1);
  });

  it('refuses to advance over a table of that name with the wrong shape, and says what is missing', () => {
    const db = freshStore();
    backToV63(db);
    // The right columns and none of the constraints: what an interrupted or
    // hand-made attempt leaves, and what `IF NOT EXISTS` then walks past.
    db.exec(
      'CREATE TABLE merge_queue_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, queue_id TEXT, entry_id TEXT, sequence INTEGER, '
      + 'event TEXT, from_state TEXT, to_state TEXT, actor_kind TEXT, actor_project_id INTEGER, actor_launch_id TEXT, actor_proof TEXT, '
      + 'detail_json TEXT, created_at TEXT)'
    );
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v63→v64 left merge_queue_events without "queue-created" in its CHECKs\. Refusing to advance schema_version\./);
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(tmpDir, 'tangleclaw.db'));
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 63);
    } finally {
      raw.close();
    }
  });

  it('one active queue per repository and base is enforced by the database itself, without regard to case', () => {
    const db = freshStore();
    insertQueue(db, 'mq_1');
    assert.throws(() => insertQueue(db, 'mq_2'), /UNIQUE/);
    assert.throws(() => insertQueue(db, 'mq_2', { repo: 'jason-vaughan/tangleclaw' }), /UNIQUE/);
    insertQueue(db, 'mq_3', { base_branch: 'v5-baseline' });
    insertQueue(db, 'mq_4', { status: 'retired', retired_at: '2026-10-12T06:00:00.000Z' });
  });

  it('only the Operator can be recorded as a queue\'s maker, and a retired queue carries when', () => {
    const db = freshStore();
    assert.throws(() => insertQueue(db, 'mq_1', { created_by_kind: 'project' }), /CHECK/);
    assert.throws(() => insertQueue(db, 'mq_1', { status: 'retired' }), /CHECK/);
    assert.throws(() => insertQueue(db, 'mq_1', { retired_at: '2026-10-12T06:00:00.000Z' }), /CHECK/);
    assert.throws(() => insertQueue(db, 'mq_1', { status: 'paused' }), /CHECK/);
    assert.throws(() => insertQueue(db, 'mq_1', { halted_at: '2026-10-12T06:00:00.000Z' }), /CHECK/);
  });

  it('one entry at a time between assembling and landing is enforced by the database itself', () => {
    const db = freshStore();
    insertQueue(db, 'mq_1');
    insertEntry(db, 'mqe_1', { state: 'assembling' });
    for (const state of ['assembling', 'testing', 'landing']) {
      assert.throws(() => insertEntry(db, 'mqe_2', { pr_number: 2, position: 2, state, ...CANDIDATE }), /UNIQUE/, state);
    }
    insertEntry(db, 'mqe_2', { pr_number: 2, position: 2 });
    assert.throws(() => db.prepare("UPDATE merge_queue_entries SET state = 'assembling' WHERE entry_id = 'mqe_2'").run(), /UNIQUE/);
    // Another queue has its own active entry.
    insertQueue(db, 'mq_9', { base_branch: 'v5-baseline' });
    insertEntry(db, 'mqe_9', { queue_id: 'mq_9', state: 'assembling' });
  });

  it('one unfinished entry per pull request, and one entry per position, are enforced by the database itself', () => {
    const db = freshStore();
    insertQueue(db, 'mq_1');
    insertEntry(db, 'mqe_1');
    assert.throws(() => insertEntry(db, 'mqe_2', { position: 2 }), /UNIQUE/);
    assert.throws(() => insertEntry(db, 'mqe_2', { pr_number: 2 }), /UNIQUE/);
    db.prepare("UPDATE merge_queue_entries SET state = 'withdrawn', withdrawn_reason = 'r', finished_at = created_at WHERE entry_id = 'mqe_1'").run();
    insertEntry(db, 'mqe_2', { position: 2 });
  });

  it('an entry row cannot say something its state does not allow', () => {
    const db = freshStore();
    insertQueue(db, 'mq_1');
    const at = '2026-10-12T05:00:00.000Z';
    const refused = [
      { state: 'parked' },
      { head_sha: 'abc' },
      { head_sha: 'A'.repeat(40) },
      { pr_number: 0 },
      { position: 0 },
      { review_gate_status: 'waived' },
      { operator_gate_status: 'waived' },
      { state: 'testing' },
      { state: 'landing', candidate_sha: 'c'.repeat(40) },
      { state: 'landed', ...CANDIDATE, finished_at: at },
      { state: 'landed', ...CANDIDATE, finished_at: at, landed_sha: 'e'.repeat(40) },
      { state: 'failed', finished_at: at },
      { state: 'withdrawn', finished_at: at },
      { state: 'failed', failure_code: 'X' },
      { state: 'queued', finished_at: at },
      { state: 'queued', failure_code: 'X' },
      { state: 'queued', withdrawn_reason: 'r' },
      { candidate_tree: 'zz' },
      { landed_tree_matches: 2 }
    ];
    for (const fields of refused) {
      assert.throws(() => insertEntry(db, 'mqe_x', fields), /CHECK/, JSON.stringify(fields));
    }
    insertEntry(db, 'mqe_ok', {
      state: 'landed', ...CANDIDATE, finished_at: at, landed_sha: 'e'.repeat(40), landed_tree: 'd'.repeat(40), landed_tree_matches: 1, landed_at: at
    });
  });

  it('the history is append-only, numbered once per queue, and says who acted', () => {
    const db = freshStore();
    const insert = (fields = {}) => {
      const row = {
        queue_id: 'mq_1', sequence: 1, event: 'queue-created', actor_kind: 'operator', actor_proof: 'verified-session',
        created_at: '2026-10-12T05:00:00.000Z', ...fields
      };
      const names = Object.keys(row);
      db.prepare(`INSERT INTO merge_queue_events (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
    };
    insert();
    assert.throws(() => insert(), /UNIQUE/);
    assert.throws(() => db.prepare("UPDATE merge_queue_events SET event = 'landed'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM merge_queue_events').run(), /append-only/);
    assert.throws(() => insert({ sequence: 2, event: 'approved' }), /CHECK/);
    assert.throws(() => insert({ sequence: 2, actor_kind: 'automation', actor_proof: null }), /CHECK/);
    assert.throws(() => insert({ sequence: 2, actor_proof: null }), /CHECK/);
    assert.throws(() => insert({ sequence: 2, actor_kind: 'project', actor_proof: null, actor_project_id: 7 }), /CHECK/);
    assert.throws(() => insert({ sequence: 2, actor_kind: 'project', actor_proof: null, actor_launch_id: 'l' }), /CHECK/);
    assert.throws(() => insert({ sequence: 2, to_state: 'parked' }), /CHECK/);
    insert({ sequence: 2, event: 'submitted', to_state: 'queued', actor_kind: 'project', actor_proof: null, actor_project_id: 7, actor_launch_id: 'l', entry_id: 'mqe_1' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merge_queue_events').get().n, 2);
  });
});
