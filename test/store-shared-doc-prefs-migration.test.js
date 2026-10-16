'use strict';

// #2389: schema v68 adds each project's shared-doc notice settings and the
// outcome of every notice a revision intended. A fresh install gets both at
// the current version; a v67 store gains them, empty, through the migration.
// What delivery rests on (one setting per project and scope, exactly one
// scope, one row per intended (revision, project, session) including the
// whole-project rows, and the cascades) is asked of the database directly, on
// both kinds of store.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const OBJECTS = [
  'idx_shared_doc_deliveries_pending',
  'idx_shared_doc_notice_prefs_doc',
  'idx_shared_doc_notice_prefs_group',
  'shared_doc_deliveries',
  'shared_doc_notice_prefs'
];
// The version this migration starts from: the one before notice settings.
const BEFORE_VERSION = 67;
const AT = '2026-10-15T21:00:00.000Z';

let tmpDir = null;

/**
 * Start a store on a new temporary directory.
 * @returns {object} The database
 */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-doc-prefs-schema-'));
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
 * The stored definition of every v68 object, by name.
 * @param {object} db - The database
 * @returns {Object<string, string>}
 */
function definitions(db) {
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (${OBJECTS.map(() => '?').join(', ')}) AND sql IS NOT NULL ORDER BY name`)
    .all(...OBJECTS);
  return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
}

/**
 * Take a current store back to before this migration.
 * @param {object} db - The database
 * @returns {void}
 */
function backToBefore(db) {
  db.exec('DROP TABLE shared_doc_deliveries');
  db.exec('DROP TABLE shared_doc_notice_prefs');
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
 * A group with one member project and one doc, and one revision of the doc.
 * @returns {{groupId: string, docId: string, projectId: number, eventId: number}}
 */
function fixture() {
  const group = store.projectGroups.create({ name: `g-${Math.random().toString(36).slice(2)}` });
  const dir = path.join(tmpDir, group.id);
  fs.mkdirSync(dir);
  const project = store.projects.create({ name: `p-${group.id}`, path: dir, engine: 'claude' });
  store.projectGroups.addMember(group.id, project.id);
  const file = path.join(dir, 'DOC.md');
  fs.writeFileSync(file, '# doc\n');
  const doc = store.sharedDocs.create({ groupId: group.id, name: 'DOC', filePath: file });
  const event = store.sharedDocEvents.recordRevision({
    docId: doc.id, observedAt: AT, sha256: 'a'.repeat(64), classes: ['first-seen'], attribution: 'incomplete',
    baseline: 'full', changedProjectIds: [], changedRowCount: 0, source: 'watch'
  }, { content: '# doc\n', byteLength: 6 });
  return { groupId: group.id, docId: doc.id, projectId: project.id, eventId: event.id };
}

/**
 * Insert a setting directly, past the accessor.
 * @param {object} db - The database
 * @param {object} fields - Columns
 * @returns {void}
 */
function insertPref(db, fields) {
  const row = { set_at: AT, setting: 'mute', ...fields };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO shared_doc_notice_prefs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => row[n]));
}

/**
 * Insert a delivery directly, past the accessor.
 * @param {object} db - The database
 * @param {object} fields - Columns
 * @returns {void}
 */
function insertDelivery(db, fields) {
  const row = { reason: 'owner', outcome: 'pending', resolved_at: AT, ...fields };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO shared_doc_deliveries (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((n) => row[n]));
}

describe('store: shared-doc notice settings and deliveries schema (v68, #2389)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('is at schema version 68 or later', () => {
    assert.ok(store.CURRENT_SCHEMA_VERSION >= BEFORE_VERSION + 1);
  });

  it('a fresh install has both tables and their indexes, empty, at the current version', () => {
    const db = freshStore();
    assert.deepEqual(Object.keys(definitions(db)), OBJECTS);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_notice_prefs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_deliveries').get().n, 0);
    assert.equal(version(db), store.CURRENT_SCHEMA_VERSION);
  });

  it('the stored tables carry every setting and outcome the code can write', () => {
    const have = definitions(freshStore());
    for (const s of store.SHARED_DOC_NOTICE_SETTINGS) assert.ok(have.shared_doc_notice_prefs.includes(`'${s}'`), s);
    for (const o of store.SHARED_DOC_DELIVERY_OUTCOMES) assert.ok(have.shared_doc_deliveries.includes(`'${o}'`), o);
  });

  it('a store from the version before migrates to the shape a fresh install has, stamped once', () => {
    let db = freshStore();
    const fresh = definitions(db);
    backToBefore(db);
    assert.deepEqual(Object.keys(definitions(db)), []);
    assert.equal(version(db), BEFORE_VERSION);
    db = reopen();
    assert.deepEqual(definitions(db), fresh);
    assert.deepEqual(
      db.prepare(`SELECT version FROM schema_version WHERE version >= ${BEFORE_VERSION} ORDER BY version`).all().map((r) => r.version),
      [BEFORE_VERSION, store.CURRENT_SCHEMA_VERSION]
    );
  });

  it('the migration leaves the revision record as it was', () => {
    let db = freshStore();
    const { docId } = fixture();
    backToBefore(db);
    db = reopen();
    assert.equal(store.sharedDocEvents.latest(docId).seq, 1);
  });

  it('migrating twice changes nothing: rows survive, nothing is stamped again', () => {
    let db = migratedStore();
    const { projectId, groupId } = fixture();
    store.sharedDocNoticePrefs.set({ projectId, groupId, setting: 'subscribe' });
    const stamps = db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    db.exec(`DELETE FROM schema_version WHERE version > ${BEFORE_VERSION}`);
    db = reopen();
    assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all(), stamps);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_notice_prefs').get().n, 1);
  });

  it('refuses to advance over a deliveries table that does not cascade from its revision, and says so', () => {
    const db = freshStore();
    backToBefore(db);
    db.exec('CREATE TABLE shared_doc_deliveries (id INTEGER PRIMARY KEY, event_id INTEGER, outcome TEXT)');
    store.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /v67→v68 left .*shared_doc_events\. Refusing to advance schema_version\./);
    assert.equal(stampedOnDisk(), BEFORE_VERSION);
  });

  for (const [kind, open] of [['a fresh store', freshStore], ['a store migrated from the version before', migratedStore]]) {
    describe(`what the database itself refuses, on ${kind}`, () => {
      it('a setting with no scope, or with both scopes', () => {
        const db = open();
        const { projectId, groupId, docId } = fixture();
        assert.throws(() => insertPref(db, { project_id: projectId }), /CHECK constraint failed/);
        assert.throws(() => insertPref(db, { project_id: projectId, group_id: groupId, doc_id: docId }), /CHECK constraint failed/);
      });

      it('a second setting for one project at one scope, while the other scope still takes one', () => {
        const db = open();
        const { projectId, groupId, docId } = fixture();
        insertPref(db, { project_id: projectId, group_id: groupId });
        assert.throws(() => insertPref(db, { project_id: projectId, group_id: groupId, setting: 'subscribe' }), /UNIQUE constraint failed/);
        insertPref(db, { project_id: projectId, doc_id: docId });
        assert.throws(() => insertPref(db, { project_id: projectId, doc_id: docId }), /UNIQUE constraint failed/);
      });

      it('a setting or outcome the code does not define', () => {
        const db = open();
        const { projectId, groupId, eventId } = fixture();
        assert.throws(() => insertPref(db, { project_id: projectId, group_id: groupId, setting: 'quiet' }), /CHECK constraint failed/);
        assert.throws(() => insertDelivery(db, { event_id: eventId, project_id: projectId, outcome: 'woken' }), /CHECK constraint failed/);
        assert.throws(() => insertDelivery(db, { event_id: eventId, project_id: projectId, reason: 'author' }), /CHECK constraint failed/);
      });

      it('a second whole-project row (muted, or offline with no live session) for one revision and project', () => {
        const db = open();
        const { projectId, eventId } = fixture();
        insertDelivery(db, { event_id: eventId, project_id: projectId, outcome: 'muted' });
        assert.throws(() => insertDelivery(db, { event_id: eventId, project_id: projectId, outcome: 'offline' }), /UNIQUE constraint failed/);
        // A session-specific row for the same project is a different row.
        insertDelivery(db, { event_id: eventId, project_id: projectId, session_id: 9 });
        assert.throws(() => insertDelivery(db, { event_id: eventId, project_id: projectId, session_id: 9 }), /UNIQUE constraint failed/);
      });

      it('unregistering a doc removes its settings and its revisions\' deliveries', () => {
        const db = open();
        const { projectId, docId, eventId } = fixture();
        insertPref(db, { project_id: projectId, doc_id: docId });
        insertDelivery(db, { event_id: eventId, project_id: projectId });
        store.sharedDocs.delete(docId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_notice_prefs').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_deliveries').get().n, 0);
      });

      it('deleting a group or a project removes the settings that name it', () => {
        const db = open();
        const a = fixture();
        insertPref(db, { project_id: a.projectId, group_id: a.groupId });
        store.projectGroups.delete(a.groupId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_notice_prefs').get().n, 0);
        const b = fixture();
        insertPref(db, { project_id: b.projectId, group_id: b.groupId });
        db.prepare('DELETE FROM projects WHERE id = ?').run(b.projectId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_doc_notice_prefs').get().n, 0);
      });
    });
  }
});
