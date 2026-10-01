'use strict';

// One migration creates the operator channel's storage in its final shape
// (#2031): both mail tables, the notification columns, the notification key
// index and the notifier's state table. A fresh install gets it at the current
// version; a v51 store gains it through the migration and keeps its older rows,
// and every boot refuses storage in any other shape, the key index included. Each
// direction refuses a second row for the same message, which is what makes a
// replayed delivery harmless. A notification has no Hub id and is keyed by its
// idempotency key, so no received message can collide with one.

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
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 52);
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
