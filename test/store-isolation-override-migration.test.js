'use strict';

// #2229: schema v66 adds the launch-isolation overrides' table. A fresh install
// gets it at the current version; a v65 store gains it, empty, through the
// migration. What the override rests on (exactly one install-wide row, one row
// per project, an install row that names no project) is asked of the database
// directly here, on both kinds of store, because it has to hold whatever code
// writes.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const TABLE = 'launch_isolation_overrides';
const INDEXES = ['idx_launch_isolation_overrides_install', 'idx_launch_isolation_overrides_project'];
const OBJECTS = [TABLE, ...INDEXES];
const AT = '2026-10-12T05:00:00.000Z';
// The version this migration starts from: the one before the overrides' table.
const BEFORE_VERSION = 65;

let tmpDir = null;

/**
 * Start a store on a new temporary directory.
 * @returns {object} The database
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-isolation-override-schema-'));
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
 * The stored definition of every override object, by name.
 * @param {object} db - The database
 * @returns {Object<string, string>}
 */
function definitions(db) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%launch_isolation_overrides%' AND sql IS NOT NULL ORDER BY name").all();
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

/**
 * Take a current store back to what a store was before this migration: no
 * overrides table and a version stamp of the version before.
 * @param {object} db - The database
 * @returns {void}
 */
function backToBefore(db) {
  db.exec(`DROP TABLE ${TABLE}`);
  db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
  db.exec(`INSERT INTO schema_version (version) SELECT ${BEFORE_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${BEFORE_VERSION})`);
}

/**
 * A store that reached the current version through the migration.
 * @returns {object} The database
 */
function migratedStore() {
  backToBefore(freshStore());
  return reopen();
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
 * Insert an override row directly, past the accessor.
 * @param {object} db - The database
 * @param {object} [fields] - Columns to change from an install-wide row
 * @returns {void}
 */
function insertRow(db, fields = {}) {
  const row = { scope: 'install', project_id: null, set_at: AT, set_by: 'operator', ...fields };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${TABLE} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
}

/**
 * How many override rows there are.
 * @param {object} db - The database
 * @param {string} [where] - A WHERE clause body
 * @returns {number}
 */
function count(db, where = '1 = 1') {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${where}`).get().n;
}

/**
 * Open the database file directly, past the store, and read its highest stamp.
 * @returns {number}
 */
function stampedOnDisk() {
  const raw = new (require('node:sqlite').DatabaseSync)(path.join(tmpDir, 'tangleclaw.db'));
  try {
    return raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  } finally {
    raw.close();
  }
}

describe('store: launch-isolation overrides schema (v66, #2229)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('is at schema version 66 or later', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= BEFORE_VERSION + 1);
  });

  it('a fresh install has the table, empty, with both unique indexes, at the current version', () => {
    const db = freshStore();
    const have = definitions(db);
    for (const name of OBJECTS) assert.ok(have[name], `missing ${name}`);
    for (const name of INDEXES) assert.match(have[name], /UNIQUE/i, name);
    assert.equal(count(db), 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
  });

  it('the stored table carries every scope the code can write', () => {
    const have = definitions(freshStore());
    for (const scope of store.LAUNCH_ISOLATION_OVERRIDE_SCOPES) assert.ok(have[TABLE].includes(`'${scope}'`), scope);
  });

  it('a store from the version before migrates to the same shape a fresh install has, with the table empty', () => {
    let db = freshStore();
    const fresh = definitions(db);
    backToBefore(db);
    assert.deepEqual(definitions(db), {});
    assert.equal(version(db), BEFORE_VERSION);

    db = reopen();
    assert.deepEqual(definitions(db), fresh);
    assert.equal(count(db), 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    // One stamp per boot, the current version: the earlier stamp is kept and the upgrade adds exactly one.
    assert.deepEqual(
      db.prepare(`SELECT version FROM schema_version WHERE version >= ${BEFORE_VERSION} ORDER BY version`).all().map((r) => r.version),
      [BEFORE_VERSION, store.CURRENT_SCHEMA_VERSION]
    );
  });

  it('the migration leaves the check watch\'s tables and their rows as they were', () => {
    let db = freshStore();
    db.prepare(
      'INSERT INTO check_watches (watch_id, project_id, registered_session_id, registered_launch_id, repo, pr_number, head_sha, check_name, due_at, registered_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('cw_1', 7, 1409, 'launch', 'Jason-Vaughan/TangleClaw', 2328, 'a'.repeat(40), 'test', '2026-10-12T06:00:00.000Z', AT);
    const shape = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%check_watch%' ORDER BY name").all();
    backToBefore(db);
    db = reopen();
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%check_watch%' ORDER BY name").all(), shape);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM check_watches').get().n, 1);
  });

  it('migrating twice changes nothing: rows survive, nothing is stamped again', () => {
    let db = migratedStore();
    insertRow(db);
    insertRow(db, { scope: 'project', project_id: 7 });
    const shape = definitions(db);
    const stamps = db.prepare('SELECT version FROM schema_version ORDER BY version').all();

    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(), stamps);
    assert.equal(count(db), 2);

    // The migration body itself, run again over a store that already has the table.
    db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    assert.equal(count(db), 2);
  });

  it('refuses to advance over a table of that name with no constraints, and says what is missing', () => {
    const db = freshStore();
    backToBefore(db);
    // The right columns and none of the constraints: what an interrupted or
    // hand-made attempt leaves, and what `IF NOT EXISTS` then walks past.
    db.exec(`CREATE TABLE ${TABLE} (override_id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, project_id INTEGER, set_at TEXT, set_by TEXT)`);
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v65→v66 left launch_isolation_overrides without "install" in its CHECKs\. Refusing to advance schema_version\./);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  it('refuses to advance over a table that lets an install row name a project', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec(`CREATE TABLE ${TABLE} (override_id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK (scope IN ('install', 'project')), `
      + 'project_id INTEGER, set_at TEXT NOT NULL, set_by TEXT)');
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v65→v66 left launch_isolation_overrides without the CHECK that an install row has no project\. Refusing/);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  it('refuses to advance over a table that would take a project id below one', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec(`CREATE TABLE ${TABLE} (override_id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK (scope IN ('install', 'project')), `
      + "project_id INTEGER, set_at TEXT NOT NULL, set_by TEXT, CHECK ((scope = 'install') = (project_id IS NULL)))");
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v65→v66 left launch_isolation_overrides without the CHECK that a project id is positive\. Refusing/);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  it('refuses to advance over an install index that is not unique: several install-wide rows would fit', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec(`CREATE TABLE ${TABLE} (override_id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK (scope IN ('install', 'project')), `
      + "project_id INTEGER CHECK (project_id IS NULL OR project_id > 0), set_at TEXT NOT NULL, set_by TEXT, CHECK ((scope = 'install') = (project_id IS NULL)))");
    db.exec(`CREATE INDEX idx_launch_isolation_overrides_install ON ${TABLE}(scope) WHERE scope = 'install'`);
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v65→v66 left no idx_launch_isolation_overrides_install unique index of the expected shape\. Refusing/);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  // Each property is asked of a store made fresh and of one that migrated: the
  // two are built by different code paths from the same DDL.
  for (const [kind, open] of [['a fresh store', freshStore], ['a store migrated from the version before', migratedStore]]) {
    describe(`what the database itself refuses, on ${kind}`, () => {
      it('a second install-wide row', () => {
        const db = open();
        insertRow(db);
        assert.throws(() => insertRow(db, { set_at: '2026-10-12T06:00:00.000Z', set_by: 'someone-else' }), /UNIQUE constraint failed/);
        assert.equal(count(db, "scope = 'install'"), 1);
      });

      it('a second row for one project, while another project still fits', () => {
        const db = open();
        insertRow(db, { scope: 'project', project_id: 7 });
        assert.throws(() => insertRow(db, { scope: 'project', project_id: 7 }), /UNIQUE constraint failed/);
        insertRow(db, { scope: 'project', project_id: 8 });
        assert.equal(count(db, "scope = 'project'"), 2);
      });

      it('an install row that names a project, and a project row that names none', () => {
        const db = open();
        assert.throws(() => insertRow(db, { project_id: 7 }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, { scope: 'project', project_id: null }), /CHECK constraint failed/);
        assert.equal(count(db), 0);
      });

      it('a scope that is neither, a project id below one, a row with no time, and a name that is empty', () => {
        const db = open();
        assert.throws(() => insertRow(db, { scope: 'master' }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, { scope: 'project', project_id: 0 }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, { set_at: null }), /NOT NULL constraint failed/);
        assert.throws(() => insertRow(db, { set_by: '' }), /CHECK constraint failed/);
        assert.equal(count(db), 0);
      });

      it('nothing about a row whose operator has no name: an install with no login gate', () => {
        const db = open();
        insertRow(db, { set_by: null });
        assert.equal(count(db), 1);
      });

      it('setting the install-wide override twice through the accessor leaves exactly one row, the first', () => {
        const db = open();
        assert.deepEqual(store.launchIsolationOverrides.set({ projectId: null, setBy: 'first', at: AT }), { changed: true });
        assert.deepEqual(store.launchIsolationOverrides.set({ projectId: null, setBy: 'second' }), { changed: false });
        assert.equal(count(db, "scope = 'install'"), 1);
        assert.deepEqual(store.launchIsolationOverrides.list().install, { setAt: AT, setBy: 'first' });
      });
    });
  }
});
