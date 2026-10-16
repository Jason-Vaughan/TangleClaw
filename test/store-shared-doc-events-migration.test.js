'use strict';

// #2389: schema v67 adds the shared-document revision record and its
// baselines. A fresh install gets both at the current version; a v66 store
// gains them, empty, through the migration. What the record rests on (one
// seq per doc, an attested revision naming its project, session and time,
// and the cascade from an unregistered doc) is asked of the database
// directly, on both kinds of store.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const OBJECTS = ['idx_shared_doc_events_doc_seq', 'shared_doc_baselines', 'shared_doc_events'];
// The version this migration starts from: the one before the revision record.
const BEFORE_VERSION = 66;
const DIGEST = 'a'.repeat(64);
const AT = '2026-10-15T20:00:00.000Z';

let tmpDir = null;

/**
 * Start a store on a new temporary directory.
 * @returns {object} The database
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-doc-events-schema-'));
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
 * The stored definition of every record object, by name.
 * @param {object} db - The database
 * @returns {Object<string, string>}
 */
function definitions(db) {
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (${OBJECTS.map(() => '?').join(', ')}) AND sql IS NOT NULL ORDER BY name`)
    .all(...OBJECTS);
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

/**
 * Take a current store back to before this migration: no record tables and a
 * version stamp of the version before.
 * @param {object} db - The database
 * @returns {void}
 */
function backToBefore(db) {
  db.exec('DROP TABLE shared_doc_events');
  db.exec('DROP TABLE shared_doc_baselines');
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

/**
 * Register a doc to hang revisions on.
 * @returns {string} Its id
 */
function registerDoc() {
  const group = store.projectGroups.create({ name: `g-${Math.random().toString(36).slice(2)}` });
  const file = path.join(tmpDir, `${group.id}.md`);
  fs.writeFileSync(file, '# doc\n');
  return store.sharedDocs.create({ groupId: group.id, name: 'DOC', filePath: file }).id;
}

/**
 * Insert a revision row directly, past the accessor.
 * @param {object} db - The database
 * @param {string} docId - Doc id
 * @param {object} [fields] - Columns to change from an unknown-author revision
 * @returns {void}
 */
function insertRow(db, docId, fields = {}) {
  const row = {
    doc_id: docId, seq: 1, observed_at: AT, sha256: DIGEST, classes: '["first-seen"]',
    attribution: 'incomplete', baseline: 'full', changed_project_ids: '[]', source: 'watch', ...fields
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO shared_doc_events (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => row[n]));
}

describe('store: shared-doc revision record schema (v67, #2389)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('is at schema version 67 or later', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= BEFORE_VERSION + 1);
  });

  it('a fresh install has both tables and the unique index, empty, at the current version', () => {
    const db = freshStore();
    assert.deepEqual(Object.keys(definitions(db)), OBJECTS);
    assert.match(definitions(db).idx_shared_doc_events_doc_seq, /UNIQUE/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_events').get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
  });

  it('the stored table carries every source the code can write', () => {
    const have = definitions(freshStore());
    for (const source of store.SHARED_DOC_EVENT_SOURCES) assert.ok(have.shared_doc_events.includes(`'${source}'`), source);
  });

  it('a store from the version before migrates to the shape a fresh install has, stamped once', () => {
    let db = freshStore();
    const fresh = definitions(db);
    backToBefore(db);
    assert.deepEqual(definitions(db), {});
    assert.equal(version(db), BEFORE_VERSION);

    db = reopen();
    assert.deepEqual(definitions(db), fresh);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
      db.prepare(`SELECT version FROM schema_version WHERE version >= ${BEFORE_VERSION} ORDER BY version`).all().map((r) => r.version),
      [BEFORE_VERSION, store.CURRENT_SCHEMA_VERSION]
    );
  });

  it('the migration leaves shared documents and their locks as they were', () => {
    let db = freshStore();
    const docId = registerDoc();
    store.documentLocks.acquire(docId, 1425, 'TC-Lane-A');
    backToBefore(db);
    db = reopen();
    assert.ok(store.sharedDocs.get(docId));
    assert.equal(store.documentLocks.check(docId).lockedBySession, 1425);
  });

  it('migrating twice changes nothing: rows survive, nothing is stamped again', () => {
    let db = migratedStore();
    const docId = registerDoc();
    insertRow(db, docId);
    const shape = definitions(db);
    const stamps = db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
    db = reopen();
    assert.deepEqual(definitions(db), shape);
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(), stamps);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_events').get().n, 1);
  });

  it('refuses to advance over a revision table that does not cascade from its doc, and says so', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec('CREATE TABLE shared_doc_events (id INTEGER PRIMARY KEY, doc_id TEXT, seq INTEGER)');
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v66→v67 left shared_doc_events without ON DELETE CASCADE from shared_documents\. Refusing to advance schema_version\./);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  for (const [kind, open] of [['a fresh store', freshStore], ['a store migrated from the version before', migratedStore]]) {
    describe(`what the database itself refuses, on ${kind}`, () => {
      it('a second revision with the same seq for one doc, while another doc still takes it', () => {
        const db = open();
        const a = registerDoc();
        const b = registerDoc();
        insertRow(db, a);
        assert.throws(() => insertRow(db, a), /UNIQUE constraint failed/);
        insertRow(db, b);
      });

      it('an attested revision that does not name its project, its session and its time', () => {
        const db = open();
        const docId = registerDoc();
        assert.throws(() => insertRow(db, docId, { author_source: 'attested', author_project_id: 7, attested_at: AT }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, docId, { author_source: 'unknown', author_project_id: 7, author_session_id: 9, attested_at: AT }), /CHECK constraint failed/);
        insertRow(db, docId, { author_source: 'attested', author_project_id: 7, author_session_id: 9, attested_at: AT });
      });

      it('a source, routing state or digest the record does not define', () => {
        const db = open();
        const docId = registerDoc();
        assert.throws(() => insertRow(db, docId, { source: 'write' }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, docId, { routing: 'sent' }), /CHECK constraint failed/);
        assert.throws(() => insertRow(db, docId, { sha256: 'abc' }), /CHECK constraint failed/);
      });

      it('a baseline that claims to be complete with no content', () => {
        const db = open();
        const docId = registerDoc();
        assert.throws(() => db.prepare('INSERT INTO shared_doc_baselines (doc_id, sha256, content, byte_length, complete, observed_at, last_seq) VALUES (?, ?, NULL, 0, 1, ?, 1)')
          .run(docId, DIGEST, AT), /CHECK constraint failed/);
      });

      it('unregistering a doc removes its revisions and its baseline', () => {
        const db = open();
        const docId = registerDoc();
        store.sharedDocEvents.recordRevision({
          docId, observedAt: AT, sha256: DIGEST, classes: ['first-seen'], attribution: 'incomplete',
          baseline: 'full', changedProjectIds: [], changedRowCount: 0, source: 'watch'
        }, { content: '# doc\n', byteLength: 6 });
        store.sharedDocs.delete(docId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_events WHERE doc_id = ?').get(docId).n, 0);
        assert.equal(store.sharedDocEvents.getBaseline(docId), null);
      });
    });
  }
});
