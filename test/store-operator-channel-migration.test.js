'use strict';

// One migration creates the operator channel's storage in its final shape
// (#2031): both mail tables, the notification columns, the notification key
// index and the notifier's state table. A fresh install gets it at the current
// version; a v51 store gains it through the migration and keeps its older rows,
// and every boot refuses storage in any other shape, the key index included. Each
// direction refuses a second row for the same message, which is what makes a
// replayed delivery harmless. A notification has no Hub id and is keyed by its
// idempotency key, so no received message can collide with one.
//
// A second migration (#1799) rebuilds the outbound table so its `state` admits
// `discarded`: every row, constraint, index and the id high-water mark survive,
// a rebuild that cannot finish changes nothing, and every boot refuses a table
// that cannot hold a discarded item.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

const CHANNEL_OBJECTS = [
  'operator_channel_inbound', 'operator_channel_outbound', 'operator_channel_notify_state',
  'idx_operator_channel_inbound_state', 'idx_operator_channel_outbound_state',
  'idx_operator_channel_outbound_idem'
];

// The outbound table exactly as the abandoned stack's first migration left it:
// `hub_id NOT NULL` and no notification columns.
const STACK_V51_OUTBOUND = `CREATE TABLE operator_channel_outbound (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id              TEXT    NOT NULL UNIQUE CHECK (length(hub_id) <= 128),
  from_workspace_id   TEXT,
  text                TEXT,
  state               TEXT    NOT NULL,
  reason              TEXT,
  reply_to_inbound_id INTEGER,
  delivered_ref       TEXT,
  received_at         TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
)`;

// The outbound table exactly as the channel's first migration created it,
// before `discarded` existed. `stateCheck` lets a test loosen the one CHECK the
// rebuild is about.
const V52_OUTBOUND = (stateCheck = "CHECK (state IN ('unverified','relayable','delivered','quarantined'))") => `CREATE TABLE operator_channel_outbound (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id              TEXT    UNIQUE CHECK (hub_id IS NULL OR length(hub_id) <= 128),
  from_workspace_id   TEXT    CHECK (from_workspace_id IS NULL OR length(from_workspace_id) <= 128),
  text                TEXT    CHECK (text IS NULL OR length(text) <= 65536),
  state               TEXT    NOT NULL ${stateCheck},
  reason              TEXT    CHECK (reason IS NULL OR length(reason) <= 60),
  reply_to_inbound_id INTEGER,
  delivered_ref       TEXT    CHECK (delivered_ref IS NULL OR length(delivered_ref) <= 64),
  kind                TEXT    NOT NULL DEFAULT 'reply' CHECK (kind IN ('reply','notification')),
  notify_type         TEXT    CHECK (notify_type IS NULL OR length(notify_type) <= 40),
  idem_key            TEXT    CHECK (idem_key IS NULL OR length(idem_key) <= 100),
  project_id          INTEGER,
  received_at         TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (
    (kind = 'reply' AND hub_id IS NOT NULL AND idem_key IS NULL AND notify_type IS NULL)
    OR (kind = 'notification' AND hub_id IS NULL AND idem_key IS NOT NULL AND notify_type IS NOT NULL)
  )
)`;

let tmpDir = null;

/**
 * Names present in sqlite_master.
 * @returns {Set<string>}
 */
function objects() {
  return new Set(store.getDb().prepare('SELECT name FROM sqlite_master').all().map((r) => r.name));
}

/**
 * Open a fresh store in a new temp dir.
 * @param {string} label - Temp dir label
 * @returns {void}
 */
function freshStore(label) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-oc-${label}-`));
  store._setBasePath(tmpDir);
  store.init();
}

/**
 * Turn the open store back into a v51 one (the version before the channel's): drop the channel tables and the newer stamp.
 * @returns {void}
 */
function rewindToV51() {
  const db = store.getDb();
  db.exec('DROP TABLE operator_channel_inbound');
  db.exec('DROP TABLE operator_channel_outbound');
  db.exec('DROP TABLE operator_channel_notify_state');
  db.exec('DELETE FROM schema_version WHERE version >= 52');
  db.exec('INSERT INTO schema_version (version) VALUES (51)');
  store.close();
}

/**
 * Turn the open store back into a v52 one: the outbound table as the channel's
 * first migration created it, its two indexes, and the stamp before the rebuild.
 * The store is left open so a test can add rows.
 * @param {string} [ddl] - The outbound table's DDL
 * @returns {void}
 */
function rewindToV52(ddl = V52_OUTBOUND()) {
  const db = store.getDb();
  db.exec('DROP TABLE operator_channel_outbound');
  db.exec(ddl);
  db.exec('CREATE INDEX idx_operator_channel_outbound_state ON operator_channel_outbound(state, id)');
  db.exec('CREATE UNIQUE INDEX idx_operator_channel_outbound_idem ON operator_channel_outbound(idem_key) WHERE idem_key IS NOT NULL');
  db.exec('DELETE FROM schema_version WHERE version >= 53');
  db.exec('INSERT INTO schema_version (version) VALUES (52)');
}

/**
 * Every outbound row, oldest first.
 * @returns {object[]}
 */
function outboundRows() {
  return store.getDb().prepare('SELECT * FROM operator_channel_outbound ORDER BY id').all().map((r) => ({ ...r }));
}

/**
 * Insert one outbound row as raw SQL would, bypassing the store's own writers.
 * @param {object} r - Column values
 * @returns {void}
 */
function rawOutbound(r) {
  store.getDb().prepare(
    'INSERT INTO operator_channel_outbound (hub_id, from_workspace_id, text, state, reason, reply_to_inbound_id, delivered_ref, '
    + 'kind, notify_type, idem_key, project_id, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(r.hub_id ?? null, r.from ?? null, r.text ?? null, r.state, r.reason ?? null, r.replyTo ?? null, r.ref ?? null,
    r.kind || 'reply', r.type ?? null, r.key ?? null, r.project ?? null, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:05.000Z');
}

/**
 * Open the database file directly, without the store.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function rawDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
}

/**
 * Column facts for the outbound table.
 * @returns {Map<string, {notnull: number, dflt_value: (string|null)}>}
 */
function outboundColumns() {
  return new Map(store.getDb().prepare('PRAGMA table_info(operator_channel_outbound)').all().map((c) => [c.name, c]));
}

/**
 * Assert the outbound storage is in its final shape.
 * @returns {void}
 */
function assertFoldedShape() {
  const cols = outboundColumns();
  for (const c of ['hub_id', 'kind', 'notify_type', 'idem_key', 'project_id']) assert.ok(cols.has(c), `outbound missing ${c}`);
  assert.equal(cols.get('hub_id').notnull, 0, 'hub_id is nullable: a notification has none');
  assert.equal(cols.get('kind').notnull, 1);
  assert.equal(cols.get('kind').dflt_value, "'reply'");
  const idx = store.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_operator_channel_outbound_idem'").get();
  assert.match(idx.sql, /UNIQUE/i);
  assert.match(idx.sql, /WHERE\s+idem_key\s+IS\s+NOT\s+NULL/i);
  const hubUnique = store.getDb().prepare("PRAGMA index_list(operator_channel_outbound)").all()
    .filter((i) => i.unique)
    .some((i) => store.getDb().prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name).join() === 'hub_id');
  assert.ok(hubUnique, 'hub_id keeps its UNIQUE constraint');
  const stateIdx = store.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_operator_channel_outbound_state'").get();
  assert.match(stateIdx.sql, /\(state, id\)/, 'the state index is there');
  // The disposition the operator gives an item the chat refused is storable; an unknown one is not.
  const db = store.getDb();
  db.exec('SAVEPOINT shape');
  try {
    rawOutbound({ hub_id: 'shape-probe-ok', state: 'discarded', reason: 'rejected-by-chat' });
    assert.throws(() => rawOutbound({ hub_id: 'shape-probe-bad', state: 'bogus' }), /CHECK constraint failed/);
  } finally {
    db.exec('ROLLBACK TO shape');
    db.exec('RELEASE shape');
  }
}

/**
 * A notification's values.
 * @param {string} key - Idempotency key
 * @returns {object}
 */
const notice = (key) => ({ type: 'work-blocked', key, projectId: null, text: 'TangleClaw: x', at: '2026-09-27T00:00:00.000Z' });

/**
 * An inbound row's values.
 * @param {string} id - The helper's message id
 * @returns {object}
 */
const inbound = (id) => ({
  external_id: id, author_id: 'u1', space_id: 'g1', channel_id: 'c1', target_project_id: 1,
  text: 'hello', created_at: '2026-09-27T00:00:00.000Z'
});

describe('store: operator channel schema (#2031 fold)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has the final channel storage at the current schema version', () => {
    freshStore('fresh');
    const have = objects();
    for (const name of CHANNEL_OBJECTS) assert.ok(have.has(name), `missing ${name}`);
    assertFoldedShape();
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 53);
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
  });

  it('a v51 store migrates to the current version with the channel tables, and keeps its exchange rows', () => {
    freshStore('v51');
    store.medusaExchanges.insert({
      exchange_id: 'mx_keep', request_id: 'r-keep', hub_id: 'hub-keep', origin: 'send', tracking: 'tracked',
      recipient_workspace_id: 'ws', priority: 'normal', reply_required: false,
      created_at: '2026-09-27T00:00:00.000Z', state: 'stored'
    });
    rewindToV51();

    store._setBasePath(tmpDir);
    store.init();
    const have = objects();
    for (const name of CHANNEL_OBJECTS) assert.ok(have.has(name), `migration left ${name} missing`);
    assertFoldedShape();
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.equal(store.medusaExchanges.get('mx_keep').state, 'stored');
  });

  it('refuses to advance past v51 when an outbound table in another shape is already there', () => {
    freshStore('wrong-shape');
    rewindToV51();
    store._setBasePath(tmpDir);
    store.init();
    // Put the abandoned stack's outbound table back under a v51 stamp: IF NOT
    // EXISTS leaves it alone, so the storage check, which runs on every boot
    // before any migration, is what refuses it.
    const db = store.getDb();
    db.exec('DROP INDEX idx_operator_channel_outbound_idem');
    db.exec('DROP TABLE operator_channel_outbound');
    db.exec(STACK_V51_OUTBOUND);
    db.exec('DELETE FROM schema_version WHERE version >= 52');
    store.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /Refusing to advance schema_version/);
    store.close();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 51, 'the version did not advance');
    } finally {
      raw.close();
    }
  });

  it('refuses to open a store whose notification key index is in another shape, at the current version', () => {
    for (const [label, ddl] of [
      ['plain', 'CREATE INDEX idx_operator_channel_outbound_idem ON operator_channel_outbound(idem_key)'],
      ['whole', 'CREATE UNIQUE INDEX idx_operator_channel_outbound_idem ON operator_channel_outbound(idem_key)']
    ]) {
      freshStore(`idx-${label}`);
      const db = store.getDb();
      db.exec('DROP INDEX idx_operator_channel_outbound_idem');
      db.exec(ddl);
      store.close();
      store._setBasePath(tmpDir);
      assert.throws(() => store.init(), /no partial unique index on the notification key/, `${label} index accepted`);
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a v52 store migrates to the current version: every row, constraint and index survives, and discarded becomes storable', () => {
    freshStore('v52');
    const m = store.operatorChannel.insertInbound(inbound('m-kept')).row;
    rewindToV52();
    rawOutbound({ hub_id: 'hub-waiting', from: 'ws-a', text: 'not yet judged', state: 'unverified' });
    rawOutbound({ hub_id: 'hub-ready', from: 'ws-a', text: 'ready to post', state: 'relayable', replyTo: m.id });
    rawOutbound({ hub_id: 'hub-posted', from: 'ws-a', state: 'delivered', ref: '444444444444444444', replyTo: m.id });
    rawOutbound({ hub_id: 'hub-rogue', from: 'ws-b', state: 'quarantined', reason: 'no-tracked-send' });
    rawOutbound({ kind: 'notification', type: 'work-blocked', key: 'work-blocked:7', project: 7, text: 'TangleClaw: x', state: 'relayable' });
    rawOutbound({ kind: 'notification', type: 'fleet-idle', key: 'fleet-idle:1', state: 'delivered', ref: '555555555555555555' });
    rawOutbound({ hub_id: 'hub-last', from: 'ws-a', text: 'the newest', state: 'relayable' });
    const before = outboundRows();
    assert.equal(before.length, 7);
    assert.throws(() => rawOutbound({ hub_id: 'hub-early', state: 'discarded' }), /CHECK constraint failed/, 'precondition: a v52 table cannot hold a discarded row');
    store.close();

    store._setBasePath(tmpDir);
    store.init();
    assert.deepEqual(outboundRows(), before, 'every row is kept, column for column, under its own id');
    assertFoldedShape();
    const have = objects();
    for (const name of CHANNEL_OBJECTS) assert.ok(have.has(name), `the rebuild left ${name} missing`);
    assert.ok(!have.has('operator_channel_outbound_rebuild'), 'no rebuild table is left behind');
    assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.equal(store.operatorChannel.getInboundByExternalId('m-kept').id, m.id, 'the inbound table is untouched');

    // The keys still do their work on the rebuilt table.
    assert.equal(store.operatorChannel.insertOutbound({ hub_id: 'hub-ready', from_workspace_id: 'ws', text: 'again', received_at: '2026-09-28T00:00:00.000Z' }).inserted, false);
    assert.equal(store.operatorChannel.insertNotification(notice('work-blocked:7')).inserted, false);
    assert.throws(() => rawOutbound({ hub_id: 'hub-x', kind: 'notification', type: 'work-blocked', key: 'k-x', state: 'relayable' }), /CHECK constraint failed/);
    assert.throws(() => rawOutbound({ hub_id: 'h'.repeat(129), state: 'unverified' }), /CHECK constraint failed/);

    // And the store's own writer can now discard a waiting item.
    const ready = before.find((r) => r.hub_id === 'hub-ready');
    const out = store.operatorChannel.discardOutbound(ready.id, 'rejected-by-chat', '2026-09-28T00:00:01.000Z');
    assert.equal(out.changed, true);
    assert.deepEqual({ state: out.row.state, reason: out.row.reason, text: out.row.text, ref: out.row.delivered_ref, at: out.row.updated_at },
      { state: 'discarded', reason: 'rejected-by-chat', text: null, ref: null, at: '2026-09-28T00:00:01.000Z' });
    assert.equal(out.row.reply_to_inbound_id, m.id, 'what it answered is still on record');
    const posted = before.find((r) => r.hub_id === 'hub-posted');
    const again = store.operatorChannel.discardOutbound(posted.id, 'rejected-by-chat', '2026-09-28T00:00:02.000Z');
    assert.equal(again.changed, false, 'only a waiting item moves');
    assert.deepEqual({ ...again.row }, posted);
  });

  it('never gives a rebuilt table\'s next item an id an earlier one held', () => {
    // The helper's own record and its Discord nonces are keyed by outbound id.
    freshStore('v52-seq');
    rewindToV52();
    for (const hub of ['hub-1', 'hub-2', 'hub-3']) rawOutbound({ hub_id: hub, state: 'relayable', text: 't' });
    const db = store.getDb();
    db.exec("DELETE FROM operator_channel_outbound WHERE hub_id IN ('hub-2', 'hub-3')");
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    const next = store.operatorChannel.insertOutbound({ hub_id: 'hub-4', from_workspace_id: 'ws', text: 'x', received_at: '2026-09-28T00:00:00.000Z' });
    assert.equal(next.row.id, 4, 'ids 2 and 3 were used once and are not used again');

    // An emptied table keeps its mark too.
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    freshStore('v52-seq-empty');
    rewindToV52();
    rawOutbound({ hub_id: 'hub-1', state: 'relayable', text: 't' });
    store.getDb().exec('DELETE FROM operator_channel_outbound');
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    assert.equal(store.operatorChannel.insertOutbound({ hub_id: 'hub-2', from_workspace_id: 'ws', text: 'x', received_at: '2026-09-28T00:00:00.000Z' }).row.id, 2);
  });

  it('changes nothing when the rebuild cannot copy a row: the old table, its rows and the version all stand', () => {
    // A table whose state has no CHECK passes the startup shape check and can
    // hold a row the final shape refuses, which stops the copy part-way.
    freshStore('v52-stops');
    rewindToV52(V52_OUTBOUND(''));
    rawOutbound({ hub_id: 'hub-fine', state: 'relayable', text: 'kept' });
    rawOutbound({ hub_id: 'hub-odd', state: 'bogus', text: 'kept too' });
    const before = outboundRows();
    const ddl = store.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'operator_channel_outbound'").get().sql;
    store.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /CHECK constraint failed/);
    store.close();
    const raw = rawDb();
    try {
      assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52, 'the version did not advance');
      assert.equal(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'operator_channel_outbound'").get().sql, ddl, 'the old table stands');
      assert.deepEqual(raw.prepare('SELECT * FROM operator_channel_outbound ORDER BY id').all().map((r) => ({ ...r })), before);
      const names = new Set(raw.prepare('SELECT name FROM sqlite_master').all().map((r) => r.name));
      assert.ok(!names.has('operator_channel_outbound_rebuild'), 'no half-built table is left');
      for (const idx of ['idx_operator_channel_outbound_state', 'idx_operator_channel_outbound_idem']) assert.ok(names.has(idx), `${idx} stands`);
    } finally {
      raw.close();
    }
  });

  it('rebuilds over a stray table left under the rebuild\'s own name', () => {
    freshStore('v52-stray');
    rewindToV52();
    rawOutbound({ hub_id: 'hub-1', state: 'relayable', text: 't' });
    store.getDb().exec('CREATE TABLE operator_channel_outbound_rebuild (x)');
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    assertFoldedShape();
    assert.equal(outboundRows().length, 1);
    assert.ok(!objects().has('operator_channel_outbound_rebuild'));
  });

  it('leaves a table that already admits discarded alone on every later boot', () => {
    freshStore('settled');
    rawOutbound({ hub_id: 'hub-1', state: 'discarded', reason: 'rejected-by-chat' });
    const ddl = () => store.getDb().prepare("SELECT sql, rootpage FROM sqlite_master WHERE name = 'operator_channel_outbound'").get();
    const first = { ...ddl() };
    for (let i = 0; i < 2; i++) {
      store.close();
      store._setBasePath(tmpDir);
      store.init();
    }
    assert.deepEqual({ ...ddl() }, first, 'not rebuilt');
    assert.equal(outboundRows().length, 1);
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?').get(store.CURRENT_SCHEMA_VERSION).n, 1, 'stamped once');
  });

  it('refuses to start on an outbound table that cannot hold a discarded item, already stamped at the current version', () => {
    // No migration runs for a store at the current version, so only the check
    // every startup makes can refuse it: otherwise the first discard would fail.
    freshStore('stamped-no-discarded');
    const db = store.getDb();
    db.exec('DROP TABLE operator_channel_outbound');
    db.exec(V52_OUTBOUND());
    db.exec('CREATE UNIQUE INDEX idx_operator_channel_outbound_idem ON operator_channel_outbound(idem_key) WHERE idem_key IS NOT NULL');
    store.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), (err) => /state CHECK lacks discarded/.test(err.message) && /Refusing to advance schema_version/.test(err.message));
    store.close();
  });

  it('records one inbound row per message id, and answers a replay with the first row', () => {
    freshStore('inbound');
    const first = store.operatorChannel.insertInbound(inbound('m1'));
    const again = store.operatorChannel.insertInbound({ ...inbound('m1'), text: 'a different body' });
    assert.equal(first.inserted, true);
    assert.equal(again.inserted, false);
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.row.text, 'hello');
  });

  it('refuses an inbound row a CHECK or NOT NULL rejects rather than dropping it silently', () => {
    freshStore('inbound-check');
    assert.throws(() => store.operatorChannel.insertInbound({ ...inbound('m1'), author_id: 'a'.repeat(65) }), /CHECK constraint failed/);
    assert.throws(() => store.operatorChannel.insertInbound({ ...inbound('m2'), channel_id: null }), /NOT NULL constraint failed/);
    assert.equal(store.operatorChannel.getInboundByExternalId('m1'), null);
    assert.equal(store.operatorChannel.getInboundByExternalId('m2'), null);
  });

  it('records one outbound row per Hub id', () => {
    freshStore('outbound');
    const first = store.operatorChannel.insertOutbound({ hub_id: 'hub-1', from_workspace_id: 'ws', text: 'x', received_at: '2026-09-27T00:00:00.000Z' });
    const again = store.operatorChannel.insertOutbound({ hub_id: 'hub-1', from_workspace_id: 'ws', text: 'y', received_at: '2026-09-27T00:00:01.000Z' });
    assert.equal(first.inserted, true);
    assert.equal(again.inserted, false);
    assert.equal(again.row.text, 'x');
  });

  it('refuses to start on an old-shaped outbound table already stamped at the current version', () => {
    // No migration runs for a store already at the current version, so only the
    // storage check every startup makes can refuse it: without that check the
    // key index would fail on the missing column instead, with no guidance.
    freshStore('stamped-wrong-shape');
    const db = store.getDb();
    db.exec('DROP INDEX idx_operator_channel_outbound_idem');
    db.exec('DROP TABLE operator_channel_outbound');
    db.exec(STACK_V51_OUTBOUND);
    store.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), (err) => /hub_id is not a nullable UNIQUE column/.test(err.message)
      && /recreated or restored/.test(err.message));
    store.close();
  });

  it('refuses a reply with no Hub id rather than dropping it silently', () => {
    freshStore('no-hub-id');
    assert.throws(() => store.operatorChannel.insertOutbound({ hub_id: null, from_workspace_id: 'ws', text: 'x', received_at: '2026-09-27T00:00:00.000Z' }),
      /CHECK constraint failed/);
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM operator_channel_outbound').get().n, 0);
  });

  it('stores a notification with no Hub id, once per idempotency key', () => {
    freshStore('notify');
    const first = store.operatorChannel.insertNotification(notice('work-blocked:1'));
    const again = store.operatorChannel.insertNotification({ ...notice('work-blocked:1'), text: 'different' });
    const other = store.operatorChannel.insertNotification(notice('work-blocked:2'));
    assert.equal(first.inserted, true);
    assert.equal(first.row.hub_id, null);
    assert.equal(first.row.kind, 'notification');
    assert.equal(first.row.idem_key, 'work-blocked:1');
    assert.equal(again.inserted, false);
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.row.text, 'TangleClaw: x', 'the first record stands');
    assert.equal(other.inserted, true, 'many notifications share a NULL hub_id');
    assert.equal(other.row.hub_id, null);
  });

  it('links a notification to the operator message it concerns, and leaves others unlinked', () => {
    freshStore('notify-link');
    const m = store.operatorChannel.insertInbound(inbound('m1')).row;
    const linked = store.operatorChannel.insertNotification({ ...notice('k-linked'), replyToInboundId: m.id });
    const plain = store.operatorChannel.insertNotification(notice('k-plain'));
    assert.equal(linked.row.reply_to_inbound_id, m.id);
    assert.equal(plain.row.reply_to_inbound_id, null);
  });

  it('a received message cannot collide with or suppress a notification, whatever its id', () => {
    freshStore('no-collide');
    // A Hub id spelled exactly like a notification key, received first.
    const reply = store.operatorChannel.insertOutbound({ hub_id: 'work-blocked:3', from_workspace_id: 'ws', text: 'r', received_at: '2026-09-27T00:00:00.000Z' });
    const n = store.operatorChannel.insertNotification(notice('work-blocked:3'));
    assert.equal(reply.inserted, true);
    assert.equal(n.inserted, true, 'the notification is still recorded');
    assert.notEqual(n.row.id, reply.row.id);
    assert.equal(reply.row.kind, 'reply');
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM operator_channel_outbound').get().n, 2);
  });

  it('refuses a row whose kind and keys disagree', () => {
    freshStore('row-shape');
    const db = store.getDb();
    const ins = (hub, kind, type, key) => db.prepare(
      'INSERT INTO operator_channel_outbound (hub_id, text, state, kind, notify_type, idem_key, received_at, updated_at) '
      + "VALUES (?, 't', 'relayable', ?, ?, ?, 'x', 'x')"
    ).run(hub, kind, type, key);
    assert.throws(() => ins('hub-a', 'notification', 'work-blocked', 'k-a'), /CHECK constraint failed/, 'a notification carries no Hub id');
    assert.throws(() => ins(null, 'notification', 'work-blocked', null), /CHECK constraint failed/, 'a notification needs its key');
    assert.throws(() => ins(null, 'notification', null, 'k-b'), /CHECK constraint failed/, 'a notification needs its type');
    assert.throws(() => ins('hub-c', 'reply', null, 'k-c'), /CHECK constraint failed/, 'a reply carries no notification key');
    assert.throws(() => ins('hub-d', 'reply', 'work-blocked', null), /CHECK constraint failed/, 'a reply carries no notification type');
  });

  it('clears an inbound text once it is handed on, and keeps it while the row waits', () => {
    freshStore('settle');
    const { row } = store.operatorChannel.insertInbound(inbound('m2'));
    const waiting = store.operatorChannel.settleInbound(row.id, { state: 'pending', error: 'no target', at: '2026-09-27T00:00:02.000Z' });
    assert.equal(waiting.text, 'hello');
    assert.equal(waiting.attempts, 1);
    const sent = store.operatorChannel.settleInbound(row.id, { state: 'sent', hubId: 'hub-9', exchangeId: 'mx_9', at: '2026-09-27T00:00:03.000Z' });
    assert.equal(sent.text, null);
    assert.equal(sent.hub_id, 'hub-9');
    const late = store.operatorChannel.settleInbound(row.id, { state: 'failed', error: 'late', at: '2026-09-27T00:00:04.000Z' });
    assert.equal(late.state, 'sent', 'a settled row does not move again');
  });

  it('an unknown outcome records its error without spending an attempt', () => {
    freshStore('unknown');
    const { row } = store.operatorChannel.insertInbound(inbound('m3'));
    const after = store.operatorChannel.settleInbound(row.id, { state: 'pending', error: 'threw', countAttempt: false, at: '2026-09-27T00:00:02.000Z' });
    assert.equal(after.attempts, 0);
    assert.equal(after.last_error, 'threw');
  });
});
