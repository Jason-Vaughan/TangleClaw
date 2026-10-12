'use strict';

// #2323: schema v65 adds the check watch's tables. A fresh install gets them at
// the current version; a v64 store gains them, empty, through the migration.
// The promises a watch rests on (one open watch per check, a result written
// whole or not at all, once-only facts, an append-only history) are asked of
// the database directly here, because they have to hold whatever code writes.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const state = require('../lib/check-watch-state');

const TABLES = ['check_watch_facts', 'check_watches'];
const TRIGGERS = ['check_watch_facts_append_only_update', 'check_watch_facts_append_only_delete'];
const INDEXES = ['idx_check_watches_one_open', 'idx_check_watches_project', 'idx_check_watch_facts_once', 'idx_check_watch_facts_watch'];
const OBJECTS = [...TABLES, ...TRIGGERS, ...INDEXES];
const AT = '2026-10-12T05:00:00.000Z';
// The version this migration starts from: the one before the check watch's tables.
const BEFORE_VERSION = 64;

let tmpDir = null;

/**
 * Start a store on a new temporary directory.
 * @returns {object} The database
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-check-watch-schema-'));
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
 * The stored definition of every check watch object, by name.
 * @param {object} db - The database
 * @returns {Object<string, string>}
 */
function definitions(db) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%check_watch%' AND sql IS NOT NULL ORDER BY name").all();
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

/**
 * Take a current store back to what a store was before this migration: no
 * check watch objects and a version stamp of the version before.
 * @param {object} db - The database
 * @returns {void}
 */
function backToBefore(db) {
  for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER ${trigger}`);
  for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
  db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
  db.exec(`INSERT INTO schema_version (version) SELECT ${BEFORE_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${BEFORE_VERSION})`);
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
 * Insert a row directly.
 * @param {object} db - The database
 * @param {string} table - Table name
 * @param {object} row - Column values
 * @returns {void}
 */
function insert(db, table, row) {
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
}

/**
 * Insert a watch row directly.
 * @param {object} db - The database
 * @param {string} id - Watch id
 * @param {object} [fields] - Columns to change
 * @returns {void}
 */
function insertWatch(db, id, fields = {}) {
  insert(db, 'check_watches', {
    watch_id: id, project_id: 7, registered_session_id: 1409, registered_launch_id: 'launch', repo: 'Jason-Vaughan/TangleClaw',
    pr_number: 2328, head_sha: 'a'.repeat(40), check_name: 'test', due_at: '2026-10-12T06:00:00.000Z', registered_at: AT, ...fields
  });
}

/**
 * Insert a fact row directly.
 * @param {object} db - The database
 * @param {object} [fields] - Columns to change
 * @returns {void}
 */
function insertFact(db, fields = {}) {
  insert(db, 'check_watch_facts', { watch_id: 'cw_1', kind: 'registered', created_at: AT, ...fields });
}

/** The columns a sent message's fact needs. */
const SENT = { request_id: 'check-watch:wake:cw_1', exchange_id: 'mx_1', recipient_workspace_id: 'tc-lane-a-830caf13' };

/** The four result columns, written together. */
const RESULT = { result_conclusion: 'success', result_run_id: '9', result_completed_at: AT, result_read_at: AT };

describe('store: check watch schema (v65, #2323)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('is at schema version 65 or later', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= BEFORE_VERSION + 1);
  });

  it('a fresh install has both tables, empty, with their indexes and triggers, at the current version', () => {
    const db = freshStore();
    const have = definitions(db);
    for (const name of OBJECTS) assert.ok(have[name], `missing ${name}`);
    for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
  });

  it('the stored tables carry every fact kind and read outcome the code can write', () => {
    const have = definitions(freshStore());
    for (const kind of state.FACT_KINDS) assert.ok(have.check_watch_facts.includes(`'${kind}'`), kind);
    for (const kind of state.ONCE_ONLY_KINDS) assert.ok(have.idx_check_watch_facts_once.includes(`'${kind}'`), kind);
    for (const outcome of state.READ_OUTCOMES) assert.ok(have.check_watches.includes(`'${outcome}'`), outcome);
    for (const kind of state.FACT_KINDS.filter((k) => !state.ONCE_ONLY_KINDS.includes(k))) {
      assert.ok(!have.idx_check_watch_facts_once.includes(`'${kind}'`), kind);
    }
  });

  it('a store from the version before migrates to the same shape a fresh install has, with the tables empty', () => {
    let db = freshStore();
    const fresh = definitions(db);
    backToBefore(db);
    assert.deepEqual(definitions(db), {});
    assert.equal(version(db), BEFORE_VERSION);

    db = reopen();
    assert.deepEqual(definitions(db), fresh);
    for (const table of TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    // One stamp per boot, the current version: the earlier stamp is kept and the upgrade adds exactly one.
    assert.deepEqual(
      db.prepare(`SELECT version FROM schema_version WHERE version >= ${BEFORE_VERSION} ORDER BY version`).all().map((r) => r.version),
      [BEFORE_VERSION, store.CURRENT_SCHEMA_VERSION]
    );
  });

  it('the migration leaves the merge queue\'s tables and their rows as they were', () => {
    let db = freshStore();
    insert(db, 'merge_queues', {
      queue_id: 'mq_1', repo: 'Jason-Vaughan/TangleClaw', base_branch: 'main', owner_project_id: 7, status: 'active',
      created_by_kind: 'operator', created_by_proof: 'verified-session', created_at: AT
    });
    const queueShape = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%merge_queue%' ORDER BY name").all();
    backToBefore(db);
    db = reopen();
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%merge_queue%' ORDER BY name").all(), queueShape);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merge_queues').get().n, 1);
  });

  it('migrating twice changes nothing: rows survive, nothing is stamped again', () => {
    let db = freshStore();
    backToBefore(db);
    db = reopen();
    insertWatch(db, 'cw_1');
    insertFact(db);
    const shape = definitions(db);
    const stamps = db.prepare('SELECT version FROM schema_version ORDER BY version').all();

    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(), stamps);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watches').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watch_facts').get().n, 1);

    // The migration body itself, run again over a store that already has the tables.
    db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watches').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watch_facts').get().n, 1);
  });

  it('refuses to advance over a table of that name with the wrong shape, and says what is missing', () => {
    const db = freshStore();
    backToBefore(db);
    // The right columns and none of the constraints: what an interrupted or
    // hand-made attempt leaves, and what `IF NOT EXISTS` then walks past.
    db.exec(
      'CREATE TABLE check_watch_facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT, kind TEXT, code TEXT, request_id TEXT, '
      + 'exchange_id TEXT, recipient_workspace_id TEXT, detail_json TEXT, created_at TEXT)'
    );
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v64→v65 left check_watch_facts without "registered" in its CHECKs\. Refusing to advance schema_version\./);
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(tmpDir, 'tangleclaw.db'));
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, BEFORE_VERSION);
    } finally {
      raw.close();
    }
  });

  it('refuses to advance over an open-watch index that does not leave out expired watches', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec('CREATE TABLE check_watches (watch_id TEXT PRIMARY KEY, project_id INTEGER, repo TEXT, head_sha TEXT, check_name TEXT, '
      + "registered_at TEXT, result_read_at TEXT, cancelled_at TEXT, expired_at TEXT, last_read_outcome TEXT CHECK (last_read_outcome IN ('ok', 'failed')))");
    db.exec('CREATE UNIQUE INDEX idx_check_watches_one_open ON check_watches(project_id, repo, head_sha, check_name) '
      + 'WHERE result_read_at IS NULL AND cancelled_at IS NULL');
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v64→v65 left no idx_check_watches_one_open unique index of the expected shape/);
  });

  it('one open watch per project, repository, commit and check name is enforced by the database itself, without regard to case', () => {
    const db = freshStore();
    insertWatch(db, 'cw_1');
    assert.throws(() => insertWatch(db, 'cw_2'), /UNIQUE/);
    assert.throws(() => insertWatch(db, 'cw_2', { repo: 'jason-vaughan/tangleclaw' }), /UNIQUE/);
    insertWatch(db, 'cw_3', { project_id: 8 });
    insertWatch(db, 'cw_4', { head_sha: 'b'.repeat(40) });
    insertWatch(db, 'cw_5', { check_name: 'Test' });
    insertWatch(db, 'cw_6', { repo: 'Jason-Vaughan/Other' });
  });

  it('a watch with a result, a cancelled watch and an expired watch each leave the check free to be watched again', () => {
    const db = freshStore();
    insertWatch(db, 'cw_1', RESULT);
    insertWatch(db, 'cw_2', { cancelled_at: AT, cancelled_by_project_id: 7, cancelled_by_launch_id: 'launch' });
    insertWatch(db, 'cw_3', { expired_at: AT });
    insertWatch(db, 'cw_4');
    assert.throws(() => insertWatch(db, 'cw_5'), /UNIQUE/);
    // Ending the open one frees it again, by each of the three ways.
    db.prepare("UPDATE check_watches SET expired_at = ? WHERE watch_id = 'cw_4'").run(AT);
    insertWatch(db, 'cw_5');
  });

  it('a watch row cannot say something half-written or out of shape', () => {
    const db = freshStore();
    const refused = [
      { head_sha: 'abc' },
      { head_sha: 'A'.repeat(40) },
      { pr_number: 0 },
      { check_name: '' },
      { check_name: 'x'.repeat(state.MAX_CHECK_NAME + 1) },
      { registered_launch_id: '' },
      { repo: 'x' },
      { result_conclusion: 'success' },
      { result_read_at: AT },
      { ...RESULT, result_run_id: null },
      { ...RESULT, result_completed_at: null },
      { ...RESULT, result_conclusion: null },
      { ...RESULT, result_conclusion: '' },
      { last_read_at: AT },
      { last_read_outcome: 'ok' },
      { last_read_at: AT, last_read_outcome: 'maybe' },
      { last_read_at: AT, last_read_outcome: 'ok', last_read_detail: 'a reason with nothing failing' },
      { last_read_detail: 'x' },
      { last_read_at: AT, last_read_outcome: 'failed', last_read_detail: 'x'.repeat(501) },
      { cancelled_at: AT },
      { cancelled_at: AT, cancelled_by_project_id: 7 },
      { cancelled_at: AT, cancelled_by_launch_id: 'launch' },
      { cancelled_by_project_id: 7 },
      { cancelled_by_launch_id: 'launch' },
      { ...RESULT, expired_at: AT }
    ];
    for (const fields of refused) {
      assert.throws(() => insertWatch(db, 'cw_x', fields), /CHECK/, JSON.stringify(fields));
    }
    insertWatch(db, 'cw_ok', {
      ...RESULT, last_read_at: AT, last_read_outcome: 'ok', cancelled_at: AT, cancelled_by_project_id: 7, cancelled_by_launch_id: 'launch'
    });
    insertWatch(db, 'cw_failing', { head_sha: 'b'.repeat(40), last_read_at: AT, last_read_outcome: 'failed', last_read_detail: 'gh is not installed' });
    assert.throws(() => db.prepare("UPDATE check_watches SET expired_at = ? WHERE watch_id = 'cw_ok'").run(AT), /CHECK/);
    assert.throws(() => insertWatch(db, 'cw_ok', { head_sha: 'c'.repeat(40) }), /UNIQUE|PRIMARY/);
  });

  it('the once-only facts cannot be written twice, enforced by the database, and the read facts can repeat', () => {
    const db = freshStore();
    for (const kind of state.ONCE_ONLY_KINDS) {
      const fields = state.SENT_KINDS.includes(kind) ? { kind, ...SENT } : { kind };
      insertFact(db, fields);
      assert.throws(() => insertFact(db, fields), /UNIQUE/, kind);
      // Another watch has its own.
      insertFact(db, { ...fields, watch_id: 'cw_2' });
    }
    for (const kind of ['read-failed', 'read-recovered']) {
      insertFact(db, { kind });
      insertFact(db, { kind });
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM check_watch_facts WHERE watch_id = 'cw_1'").get().n, state.ONCE_ONLY_KINDS.length + 4);
  });

  it('a sent message\'s fact names its request id, its exchange and its workspace, and no other fact names an exchange', () => {
    const db = freshStore();
    for (const kind of state.SENT_KINDS) {
      assert.throws(() => insertFact(db, { kind }), /CHECK/, kind);
      assert.throws(() => insertFact(db, { kind, ...SENT, exchange_id: null }), /CHECK/, kind);
      assert.throws(() => insertFact(db, { kind, ...SENT, request_id: null }), /CHECK/, kind);
      assert.throws(() => insertFact(db, { kind, ...SENT, recipient_workspace_id: null }), /CHECK/, kind);
      insertFact(db, { kind, ...SENT });
    }
    for (const kind of state.FACT_KINDS.filter((k) => !state.SENT_KINDS.includes(k))) {
      assert.throws(() => insertFact(db, { kind, watch_id: 'cw_2', exchange_id: 'mx_1' }), /CHECK/, kind);
      assert.throws(() => insertFact(db, { kind, watch_id: 'cw_2', request_id: 'check-watch:wake:cw_2' }), /CHECK/, kind);
    }
    // A message that could not be delivered may still say where it would have gone.
    insertFact(db, { kind: 'wake-undeliverable', watch_id: 'cw_2', code: 'NO_LIVE_SESSION', recipient_workspace_id: 'tc-lane-a-830caf13' });
  });

  it('the history is append-only and admits only the kinds a watch has', () => {
    const db = freshStore();
    insertFact(db);
    assert.throws(() => db.prepare("UPDATE check_watch_facts SET kind = 'resolved'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM check_watch_facts').run(), /append-only/);
    assert.throws(() => insertFact(db, { kind: 'approved' }), /CHECK/);
    assert.throws(() => insertFact(db, { kind: 'resolved', code: '' }), /CHECK/);
    assert.throws(() => insertFact(db, { kind: 'resolved', code: 'x'.repeat(65) }), /CHECK/);
    assert.throws(() => insertFact(db, { kind: 'resolved', detail_json: 'x'.repeat(4097) }), /CHECK/);
    assert.throws(() => insertFact(db, { kind: 'resolved', created_at: null }), /NOT NULL/);
    assert.throws(() => insertFact(db, { kind: 'resolved', watch_id: null }), /NOT NULL/);
    insertFact(db, { kind: 'resolved', code: 'success' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watch_facts').get().n, 2);
    // A fact outlives its watch: there is no watch row here at all.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watches').get().n, 0);
  });
});
