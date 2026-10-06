'use strict';

// #2031 (ADR 0023): schema v52 adds the Master-mediated operator bridge's
// storage in its final shape. A fresh install and a v51 store reach the same
// shape; a store whose bridge tables are the wrong shape is refused at the
// migration and at every later startup; and the Medusa exchange table is left
// exactly as it was.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeSchema = require('../lib/bridge-schema');

let tmpDir = null;

/**
 * The SQL of every bridge object, by name.
 * @returns {Map<string, string>}
 */
function bridgeObjects() {
  const rows = store.getDb().prepare(
    "SELECT name, sql FROM sqlite_master WHERE name LIKE 'bridge_%' OR name LIKE 'idx_bridge_%' ORDER BY name"
  ).all();
  return new Map(rows.map((r) => [r.name, r.sql]));
}

/**
 * Open a fresh store in a new temp dir.
 * @param {string} label - Temp dir label.
 * @returns {void}
 */
function freshStore(label) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-bridge-${label}-`));
  store._setBasePath(tmpDir);
  store.init();
}

/**
 * Turn the open store back into a v51 one: drop every bridge object and the newer stamp.
 * @returns {void}
 */
function rewindToV51() {
  const db = store.getDb();
  for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'trigger')) {
    db.exec(`DROP TRIGGER ${object.name}`);
  }
  for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'table')) {
    db.exec(`DROP TABLE ${object.name}`);
  }
  db.exec('DELETE FROM schema_version WHERE version >= 52');
  db.exec('INSERT INTO schema_version (version) VALUES (51)');
  store.close();
}

/**
 * Reopen the store in the current temp dir.
 * @returns {void}
 */
function reopen() {
  store._setBasePath(tmpDir);
  store.init();
}

describe('store: operator bridge schema (v52 to v54, #2031)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every bridge object in its checked shape', () => {
    freshStore('fresh');
    // This file owns the bridge's exact number: v52 created its storage, v53
    // reshaped two tables, and v54 added the helper's fetch leases. The store
    // as a whole moves on without the bridge (v55 is the recovery state table),
    // so the store's version is held only to be no older than the bridge's.
    assert.equal(bridgeSchema.BRIDGE_SCHEMA_VERSION, 54);
    assert.ok(store.CURRENT_SCHEMA_VERSION >= bridgeSchema.BRIDGE_SCHEMA_VERSION);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb()), []);
    const have = bridgeObjects();
    for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS) assert.ok(have.has(object.name), `missing ${object.name}`);
  });

  it('a v51 store migrates to the same shape a fresh install has', () => {
    freshStore('v51');
    const fresh = bridgeObjects();
    rewindToV51();

    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh]);
    const version = store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    assert.equal(version, store.CURRENT_SCHEMA_VERSION);
  });

  it('leaves the Medusa exchange table exactly as it was', () => {
    freshStore('exchanges');
    const sql = () => store.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'medusa_exchanges'").get().sql;
    const before = sql();
    rewindToV51();
    reopen();
    assert.equal(sql(), before);
    assert.ok(!/master-launch|sender_generation/.test(before));
  });

  /**
   * Turn the open store into one as schema v52 left it: the two tables v53
   * changed are put back in their v52 shape (no `status` kind, and a sent
   * message that did not record who it was sent to), and the stamp is 52.
   * @param {(db: object) => void} [populate] - Insert v52-era rows.
   * @returns {void}
   */
  function rewindToV52(populate) {
    const db = store.getDb();
    // First everything v54 added or reshaped, then what v53 did: a v52 store had neither.
    shapeAsV53(db);
    db.exec('DROP TABLE bridge_outbound');
    db.exec('DROP TABLE bridge_route_proofs');
    db.exec(`
      CREATE TABLE bridge_route_proofs (
        proof_id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, direction TEXT NOT NULL, hub_id TEXT NOT NULL,
        exchange_id TEXT, in_reply_to_hub_id TEXT, sender_proof TEXT NOT NULL CHECK (sender_proof IN ('master-launch','gateway','launch')),
        master_generation INTEGER, sender_project_id INTEGER, sender_launch_id TEXT, recorded_at TEXT NOT NULL
      );
      CREATE TABLE bridge_outbound (
        outbound_id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('reply','notification','failure','candidate')), notify_type TEXT, route_id TEXT,
        candidate_id TEXT, hub_id TEXT CHECK (hub_id IS NULL OR length(hub_id) <= 128), source_label TEXT NOT NULL, text TEXT,
        digest TEXT NOT NULL, state TEXT NOT NULL, drop_code TEXT, attempts INTEGER NOT NULL DEFAULT 0, delivered_ref TEXT,
        released_generation INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      );
    `);
    // Dropping a table takes its own indexes and triggers with it; put them back.
    restoreIndexesBeforeV54(db);
    if (populate) populate(db);
    db.exec('DELETE FROM schema_version WHERE version >= 53');
    db.exec('INSERT INTO schema_version (version) VALUES (52)');
    store.close();
  }

  it('upgrades a v52 store straight to the current schema: every reshaped table is rebuilt and keeps every row and id', () => {
    freshStore('v52');
    const fresh = bridgeObjects();
    const at = '2026-10-04T00:00:00.000Z';
    rewindToV52((db) => {
      const item = db.prepare(
        "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES (?, 'notification', 'fleet-idle', 'TangleClaw', ?, ?, 'ready', ?, ?)"
      );
      item.run('notify:fleet-idle:1', 'first', 'a'.repeat(64), at, at);
      item.run('notify:fleet-idle:2', 'kept', 'a'.repeat(64), at, at);
      // A row that existed and was removed: its id must never be issued again.
      item.run('notify:fleet-idle:3', 'gone', 'a'.repeat(64), at, at);
      db.exec("DELETE FROM bridge_outbound WHERE idem_key = 'notify:fleet-idle:3'");
      db.prepare(
        "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES ('r1', 'ext-r1', 'a', 's', 'c', ?, 'accepted', ?, ?)"
      ).run('a'.repeat(64), at, at);
      db.prepare(
        "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, in_reply_to_hub_id, sender_proof, sender_project_id, sender_launch_id, recorded_at) VALUES ('r1', 'from-target', 'h9', 'h1', 'launch', 4, 'launch', ?)"
      ).run(at);
      const token = db.prepare('INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)');
      token.run('t-old', 'e'.repeat(64), 'revoked', 'operator', at, at);
      token.run('t-live', 'f'.repeat(64), 'active', 'operator', at, null);
      // What a v52 store looked like: none of what the two later versions added.
      const names = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'bridge_%' OR name LIKE 'idx_bridge_%'").all().map((r) => r.name);
      // A nickname the operator set before any record of who changed one existed.
      db.prepare("INSERT INTO bridge_aliases (alias, destination_kind, destination_project_id, created_by, created_at) VALUES ('ops', 'master', NULL, 'operator', ?)").run(at);
      const aliasSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bridge_aliases'").get().sql;
      assert.ok(!/changed_by|confirmed_route_id|display|'master'\)\)/.test(aliasSql.replace("IN ('master','project')", '')), 'a v52 nickname row records only that the operator made it');
      assert.ok(!/question/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bridge_outbound'").get().sql), 'and a v52 item knows no question');
      for (const later of ['bridge_outbound_leases', 'bridge_outbound_claims', 'bridge_outbound_parts', 'bridge_route_reply_context', 'bridge_config_circuit', 'bridge_questions', 'bridge_launches', 'bridge_project_optouts']) {
        assert.ok(!names.includes(later), `${later} is not in a v52 store`);
      }
      const routesSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bridge_routes'").get().sql;
      assert.ok(!routesSql.includes('outbound-correlation'));
    });
    const raw = new (require('node:sqlite').DatabaseSync)(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
    raw.close();

    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh], 'the upgraded store has exactly the shape of a fresh one');
    const after = store.getDb();
    assert.deepEqual(after.prepare('SELECT route_id, external_id, state, resolved_by FROM bridge_routes').all().map((r) => [r.route_id, r.external_id, r.state, r.resolved_by]),
      [['r1', 'ext-r1', 'accepted', null]], 'the route came through both rebuilds');
    assert.deepEqual(after.prepare('SELECT token_id, status FROM bridge_helper_tokens ORDER BY token_id').all().map((r) => [r.token_id, r.status]),
      [['t-live', 'active'], ['t-old', 'revoked']]);
    assert.deepEqual(after.prepare('SELECT state, block_code, attempts FROM bridge_outbound ORDER BY outbound_id').all().map((r) => [r.state, r.block_code, r.attempts]),
      [['ready', null, 0], ['ready', null, 0]], 'and each item has the columns v54 added, empty');
    assert.deepEqual(after.prepare('SELECT outbound_id, idem_key, text, question_id FROM bridge_outbound ORDER BY outbound_id').all().map((r) => [r.outbound_id, r.idem_key, r.text, r.question_id]),
      [[1, 'notify:fleet-idle:1', 'first', null], [2, 'notify:fleet-idle:2', 'kept', null]]);
    assert.deepEqual({ ...after.prepare('SELECT * FROM bridge_aliases').get() },
      { alias: 'ops', destination_kind: 'master', destination_project_id: null, created_by: 'operator', created_at: at, changed_by: null, changed_at: null, confirmed_route_id: null, display: null },
      'the nickname came through, saying nothing it did not record at the time');
    for (const added of ['bridge_questions', 'bridge_launches', 'bridge_project_optouts']) {
      assert.equal(after.prepare(`SELECT COUNT(*) AS n FROM ${added}`).get().n, 0, `${added} exists, empty`);
    }
    assert.deepEqual(after.prepare('SELECT hub_id, in_reply_to_hub_id FROM bridge_route_proofs').all().map((r) => [r.hub_id, r.in_reply_to_hub_id]),
      [['h9', 'h1']]);
    const next = after.prepare(
      "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES ('notify:fleet-idle:4', 'notification', 'fleet-idle', 'TangleClaw', 'new', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at);
    assert.equal(Number(next.lastInsertRowid), 4, 'the id of a removed row is not reused');
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0);
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
  });

  it('booting an upgraded store again changes nothing', () => {
    freshStore('reboot');
    rewindToV52();
    reopen();
    const once = [...bridgeObjects()];
    const stamps = () => store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    const stamped = stamps();
    store.close();
    reopen();
    store.close();
    reopen();
    assert.deepEqual([...bridgeObjects()], once);
    assert.deepEqual(stamps(), stamped);
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_audit_anchor').get().n, 1);
  });

  it('refuses a v52 store with a bridge table missing, and does not advance the stamp', () => {
    freshStore('half');
    rewindToV52();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP TABLE bridge_nonces');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v52 store.*bridge_nonces/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0, 'nothing was set aside');
    check.close();
  });

  it('refuses a v52 store with a misshapen bridge table, and does not advance the stamp', () => {
    freshStore('malformed');
    rewindToV52();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP TABLE bridge_outbound');
    raw.exec('CREATE TABLE bridge_outbound (outbound_id INTEGER PRIMARY KEY, hub_id TEXT UNIQUE, text TEXT)');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v52 store.*bridge_outbound/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
    check.close();
  });

  it('is a superset of v52: everything a server from before v53 required still holds', () => {
    freshStore('superset');
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 52), []);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 53), []);
    store.close();
    freshStore('superset-upgraded');
    rewindToV52();
    reopen();
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 52), []);
  });

  /**
   * Put back the indexes and triggers a store had before v54: every one the
   * current schema declares, less those on tables v54 added.
   * @param {object} db - The open database.
   * @returns {void}
   */
  function restoreIndexesBeforeV54(db) {
    db.exec(bridgeSchema.bridgeIndexDdl().split(/;\s*\n/)
      .filter((stmt) => !/bridge_outbound_(leases|claims|parts)|bridge_route_reply_context|bridge_config_circuit|bridge_questions|bridge_launches|bridge_project_optouts/.test(stmt)).join(';\n'));
    // And what those versions had that v54 retired, by the statement that made it.
    for (const object of bridgeSchema.RETIRED_SCHEMA_OBJECTS.filter((o) => o.retiredAt === 54)) db.exec(object.madeBy);
  }

  /**
   * Whether the open store has the conversation index v52 created.
   * @returns {boolean}
   */
  const hasConversationIndex = () => Boolean(store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bridge_routes_conversation'").get());

  it('v54 retires the conversation index v52 created: a fresh store, a v52 store and a v53 store all end without it, in one shape', () => {
    assert.deepEqual(bridgeSchema.RETIRED_SCHEMA_OBJECTS.map((o) => [o.type, o.name, o.madeAt, o.retiredAt]), [['index', 'idx_bridge_routes_conversation', 52, 54]]);
    assert.ok(!bridgeSchema.bridgeIndexDdl().includes('idx_bridge_routes_conversation'), 'a fresh store is never given it');
    freshStore('retired-fresh');
    assert.equal(hasConversationIndex(), false);
    const fresh = [...bridgeObjects()];
    store.close();

    for (const [label, rewind] of [['v52', rewindToV52], ['v53', rewindToV53]]) {
      freshStore(`retired-${label}`);
      let had = null;
      rewind((db) => {
        had = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bridge_routes_conversation'").get());
        db.prepare(
          "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES ('r1', 'ext-r1', 'a', 's', 'c', ?, 'accepted', ?, ?)"
        ).run('a'.repeat(64), '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
      });
      assert.equal(had, true, `precondition: a ${label} store has the index`);
      reopen();
      assert.equal(hasConversationIndex(), false, `${label}: the upgrade dropped it`);
      assert.deepEqual([...bridgeObjects()], fresh, `${label}: exactly the shape of a fresh store`);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n, 1, `${label}: its routes are kept`);
      assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
      assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb()), []);
      // The version that made it still required nothing of it, and its own check still passes.
      assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 52), []);
      store.close();
    }

    // At v54 its presence is a shape problem: a store that has it is refused, not quietly kept.
    freshStore('retired-present');
    store.getDb().exec(bridgeSchema.RETIRED_SCHEMA_OBJECTS[0].madeBy);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb()), ['index idx_bridge_routes_conversation was retired in v54 and is still present']);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 53), [], 'and it was no problem before v54');
    assert.throws(() => bridgeSchema.verifyBridgeSchema(store.getDb()), /idx_bridge_routes_conversation was retired in v54 and is still present/);
    // A build from before v54 re-creates it at every boot. If one has run against
    // this store, the next boot of this build takes it away again and carries on.
    store.close();
    reopen();
    assert.equal(hasConversationIndex(), false);
    assert.deepEqual([...bridgeObjects()], fresh);
  });

  /**
   * Give the open store's bridge tables the shape schema v53 left them in:
   * none of the tables v54 added, a helper-token table without the
   * revoked-time check, no set-aside state on an item, and no resolution by a
   * posted message's record. Leaves the version stamp alone.
   * @param {object} db - The open database.
   * @returns {void}
   */
  function shapeAsV53(db) {
    db.exec('DROP TABLE bridge_outbound_leases');
    db.exec('DROP TABLE bridge_outbound_claims');
    db.exec('DROP TABLE bridge_outbound_parts');
    db.exec('DROP TABLE bridge_config_circuit');
    db.exec('DROP TABLE bridge_route_reply_context');
    db.exec('DROP TRIGGER bridge_routes_delete_reply_context');
    db.exec('DROP TABLE bridge_helper_tokens');
    db.exec('DROP TRIGGER bridge_outbound_delete_leases');
    // What v54 added for questions, consented launches and opt-outs.
    for (const table of ['bridge_launches', 'bridge_questions', 'bridge_project_optouts']) db.exec(`DROP TABLE ${table}`);
    db.exec(`
      CREATE TABLE bridge_helper_tokens (
        token_id    TEXT PRIMARY KEY CHECK (length(token_id) BETWEEN 1 AND 64),
        token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
        created_by  TEXT NOT NULL CHECK (created_by IN ('operator')),
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
      CREATE UNIQUE INDEX idx_bridge_helper_tokens_active ON bridge_helper_tokens(status) WHERE status = 'active';
    `);
    // The two v52 tables v54 reshapes, put back as v53 had them: no set-aside
    // state on an item, and no resolution by a posted message's record.
    const asV53 = {
      bridge_outbound: (sql) => sql.replace("'ready','blocked','delivered','dropped'", "'ready','delivered','dropped'")
        .replace(",'question'", '')
        .replace(/\n\s+OR \(kind = 'question'[^\n]*\n[^\n]*candidate_id IS NULL\)\n(\s+)\),\n[^\n]*A question names[^\n]*\n[^\n]*question_id IS NOT NULL\)\)/, '\n$1)')
        .split('\n').filter((line) => !/block_code|An item set aside|question_id/.test(line)).join('\n'),
      bridge_routes: (sql) => sql.replace("'outbound-correlation',", ''),
      // No record of who changed a nickname, or on which operator message.
      bridge_aliases: (sql) => sql.replace("('operator','master')", "('operator')")
        .replace(/,\n\s+CHECK \(\(changed_by IS NULL\) = \(changed_at IS NULL\)\),\n[^\n]*\n\s+CHECK \(changed_by IS NOT 'master' OR confirmed_route_id IS NOT NULL\)/, '')
        .split('\n').filter((line) => !/changed_by|changed_at|confirmed_route_id|display |Who last wrote|authorised it when|the operator typed it/.test(line)).join('\n')
    };
    for (const [table, reshape] of Object.entries(asV53)) {
      const now = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
      const was = reshape(now).replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE');
      assert.notEqual(was, now, `${table} differs between v53 and v54`);
      assert.ok(!/'blocked'|block_code|outbound-correlation|question|changed_by|confirmed_route_id|display|'master'\)\),\n\s+created_at/.test(was), `${table} is back in its v53 shape`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(was);
    }
    for (const trigger of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'trigger' && (o.since || 52) > 53)) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    }
    // Dropping a table takes its own indexes and triggers with it; put back those v53 had.
    restoreIndexesBeforeV54(db);
  }

  /**
   * Turn the open store into one as schema v53 left it. The stamp is 53.
   * @param {(db: object) => void} [populate] - Insert v53-era rows.
   * @returns {void}
   */
  function rewindToV53(populate) {
    const db = store.getDb();
    shapeAsV53(db);
    if (populate) populate(db);
    db.exec('DELETE FROM schema_version WHERE version >= 54');
    db.exec('INSERT INTO schema_version (version) VALUES (53)');
    store.close();
  }

  it('upgrades a v53 store: the lease table appears and the helper tokens keep their rows', () => {
    freshStore('v53');
    const fresh = bridgeObjects();
    const at = '2026-10-04T00:00:00.000Z';
    rewindToV53((db) => {
      const token = db.prepare('INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)');
      token.run('t-old', 'e'.repeat(64), 'revoked', 'operator', at, at);
      token.run('t-live', 'f'.repeat(64), 'active', 'operator', at, null);
    });
    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh], 'the upgraded store has exactly the shape of a fresh one');
    const db = store.getDb();
    assert.deepEqual(db.prepare('SELECT token_id, status FROM bridge_helper_tokens ORDER BY token_id').all().map((r) => [r.token_id, r.status]),
      [['t-live', 'active'], ['t-old', 'revoked']]);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
    assert.throws(() => db.exec("UPDATE bridge_helper_tokens SET status = 'revoked' WHERE token_id = 't-live'"), /CHECK/,
      'a token can no longer be revoked without recording when');
  });

  it('refuses a v53 store whose rows the new check would not admit, and leaves the stamp at 53', () => {
    freshStore('v53-bad-row');
    rewindToV53((db) => {
      // Revoked, with no time recorded: a state the v53 table allowed.
      db.prepare("INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES ('t-bad', ?, 'revoked', 'operator', 'x')").run('e'.repeat(64));
    });
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /CHECK/);
    store.close();
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 53);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0, 'nothing was left set aside');
    assert.equal(check.prepare("SELECT status FROM bridge_helper_tokens WHERE token_id = 't-bad'").get().status, 'revoked', 'and its row is untouched');
    check.close();
  });

  it('refuses a v53 store that is not sound, before touching it', () => {
    freshStore('v53-unsound');
    rewindToV53();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP INDEX idx_bridge_outbound_status');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v53 store.*idx_bridge_outbound_status/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 53);
    check.close();
  });

  it('v54 is a superset of v53 and of v52: what each earlier server required still holds', () => {
    freshStore('superset-54');
    for (const version of [52, 53, 54]) assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, version), [], `v${version}`);
    store.close();
    freshStore('superset-54-upgraded');
    rewindToV53();
    reopen();
    for (const version of [52, 53, 54]) assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, version), [], `v${version} after upgrade`);
  });

  it('a lease is fixed once issued, final once settled, one live per item, and goes with its item', () => {
    freshStore('leases');
    const db = store.getDb();
    const at = '2026-10-04T00:00:00.000Z';
    const later = '2026-10-04T00:02:00.000Z';
    db.prepare(
      "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES ('n:1', 'notification', 'fleet-idle', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at);
    const claim = 'claim-nonce-00000001';
    const lease = db.prepare(
      'INSERT INTO bridge_outbound_leases (lease_id, claim_nonce, outbound_id, item_digest, token_id, state, issued_at, expires_at) '
      + `VALUES (?, '${claim}', ?, ?, 't1', 'live', ?, ?)`
    );
    assert.throws(() => lease.run('lease-0000000000000008', 1, 'a'.repeat(64), at, later), /needs the claim/);
    db.prepare("INSERT INTO bridge_outbound_claims (claim_nonce, token_id, request_digest, claimed_at) VALUES (?, 't1', ?, ?)").run(claim, 'b'.repeat(64), at);
    assert.throws(() => db.exec("UPDATE bridge_outbound_claims SET token_id = 't2'"), /fixed once recorded/);
    assert.throws(() => lease.run('lease-0000000000000009', 99, 'a'.repeat(64), at, later), /needs its item/);
    assert.throws(() => lease.run('lease-0000000000000000', 1, 'a'.repeat(64), later, at), /CHECK/, 'it lapses after it is issued');
    lease.run('lease-0000000000000001', 1, 'a'.repeat(64), at, later);
    assert.throws(() => lease.run('lease-0000000000000002', 1, 'a'.repeat(64), at, later), /UNIQUE/, 'one live lease per item');
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET token_id = 't2'"), /fixed once issued/);
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET expires_at = '2027-01-01T00:00:00.000Z'"), /fixed once issued/);
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET state = 'used'"), /CHECK/, 'settling records when');
    db.exec(`UPDATE bridge_outbound_leases SET state = 'used', settled_at = '${later}'`);
    assert.throws(() => db.exec(`UPDATE bridge_outbound_leases SET state = 'lapsed', settled_at = '${later}'`), /final once settled/);
    lease.run('lease-0000000000000003', 1, 'a'.repeat(64), at, later);
    db.exec('DELETE FROM bridge_outbound WHERE outbound_id = 1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, 0);
  });

  it('admits one fixed status item per route, and only for a route', () => {
    freshStore('status');
    const db = store.getDb();
    const at = '2026-10-04T00:00:00.000Z';
    db.prepare(
      "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES ('r1', 'ext-r1', 'a', 's', 'c', ?, 'accepted', ?, ?)"
    ).run('a'.repeat(64), at, at);
    const item = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, released_generation, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES (?, 'status', ?, ?, 'TangleClaw', 'x', ?, 'ready', ?, ?) ON CONFLICT(idem_key) DO NOTHING"
    );
    assert.equal(item.run('route:r1:pending', 'r1', null, 'a'.repeat(64), at, at).changes, 1);
    assert.equal(item.run('route:r1:pending', 'r1', null, 'a'.repeat(64), at, at).changes, 0, 'one per route');
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:another', 'status', 'r1', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at), /UNIQUE/, 'a second status item under another key is still refused');
    assert.throws(() => item.run('route:none:pending', null, null, 'a'.repeat(64), at, at), /CHECK/);
    assert.throws(() => item.run('route:r1:pending2', 'r1', 3, 'a'.repeat(64), at, at), /CHECK/, 'nobody released it: the server wrote it');
  });

  it('refuses to advance over a bridge table of the wrong shape', () => {
    freshStore('misshapen');
    rewindToV51();
    // An outbound table from the superseded design: no idempotency key of its
    // own, so nothing could tell two notifications apart.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('CREATE TABLE bridge_outbound (outbound_id INTEGER PRIMARY KEY, hub_id TEXT UNIQUE, text TEXT)');
    raw.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /bridge_outbound/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    const version = check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    check.close();
    assert.equal(version, 51);
  });

  it('refuses at startup when a bridge object goes missing after the migration', () => {
    freshStore('tampered');
    store.getDb().exec('DROP TRIGGER bridge_audit_append_only_delete');
    store.close();
    // The table DDL would quietly put a missing TABLE back; a store that lost
    // an index it rests on is the case only the startup check sees.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP INDEX idx_bridge_route_proofs_hub');
    raw.exec('CREATE INDEX idx_bridge_route_proofs_hub ON bridge_route_proofs(hub_id)');
    raw.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /idx_bridge_route_proofs_hub/);
  });
});

describe('store: operator bridge constraints (#2031)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  const at = '2026-10-04T00:00:00.000Z';
  const digest = 'a'.repeat(64);

  it('keeps the audit append-only', () => {
    freshStore('audit');
    const db = store.getDb();
    db.prepare(
      "INSERT INTO bridge_audit (op, request_id, actor, proof, outcome, at) VALUES ('close', 'req-00000001', 'operator', 'operator', 'applied', ?)"
    ).run(at);
    assert.throws(() => db.exec("UPDATE bridge_audit SET outcome = 'changed'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM bridge_audit'), /append-only/);
  });

  it('refuses an audit row for Master that names no generation', () => {
    freshStore('audit-gen');
    assert.throws(() => store.getDb().prepare(
      "INSERT INTO bridge_audit (op, actor, proof, outcome, at) VALUES ('close', 'master', 'master-launch', 'applied', ?)"
    ).run(at), /CHECK/);
  });

  it('allows one live Master generation and one active helper token', () => {
    freshStore('single');
    const db = store.getDb();
    const mint = db.prepare('INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at) VALUES (?, ?, ?, ?)');
    const revoked = db.prepare("INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at, revoked_at) VALUES (?, ?, 'revoked', ?, ?)");
    mint.run(1, 'b'.repeat(64), 'active', at);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'active', at), /UNIQUE/);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'pending', at), /UNIQUE/, 'pending and active are one slot');
    revoked.run(2, 'c'.repeat(64), at, at);
    assert.throws(() => mint.run(3, 'f'.repeat(64), 'revoked', at), /CHECK/, 'a revoked generation records when');

    const token = db.prepare("INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES (?, ?, 'active', 'operator', ?)");
    token.run('t1', 'd'.repeat(64), at);
    assert.throws(() => token.run('t2', 'e'.repeat(64), at), /UNIQUE/);
  });

  it('gives every outbound item its own idempotency key and no synthetic Hub id', () => {
    freshStore('outbound');
    const db = store.getDb();
    const insert = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES (?, 'notification', ?, 'TangleClaw', 'x', ?, 'ready', ?, ?) ON CONFLICT(idem_key) DO NOTHING"
    );
    assert.equal(insert.run('notify:fleet-idle:1', 'fleet-idle', digest, at, at).changes, 1);
    assert.equal(insert.run('notify:fleet-idle:1', 'fleet-idle', digest, at, at).changes, 0);
    assert.equal(insert.run('notify:fleet-idle:2', 'fleet-idle', digest, at, at).changes, 1);
    const rows = db.prepare('SELECT hub_id FROM bridge_outbound').all();
    assert.deepEqual(rows.map((r) => r.hub_id), [null, null]);
    // A reserved notification type has no producer yet and is not storable.
    assert.throws(() => insert.run('notify:x:1', 'release-action-needed', digest, at, at), /CHECK/);
  });

  /**
   * Insert a bare route row.
   * @param {string} id - Route id.
   * @returns {void}
   */
  function route(id) {
    store.getDb().prepare(
      "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES (?, ?, 'a', 's', 'c', ?, 'accepted', ?, ?)"
    ).run(id, `ext-${id}`, digest, at, at);
  }

  it('refuses a reply that was not released by a Master generation', () => {
    freshStore('reply');
    route('r1');
    assert.throws(() => store.getDb().prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:answer', 'reply', 'r1', 'Master', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at), /CHECK/);
  });

  it('refuses a reply proof that does not name its launch, project and the message it answers', () => {
    freshStore('proof');
    const db = store.getDb();
    route('r1');
    route('r2');
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'from-target', 'h2', 'launch', ?)"
    ).run(at), /CHECK/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', ?)"
    ).run(at), /CHECK/);
    db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 3, 9, 'ws', 5, 'launch', ?)"
    ).run(at);
    // A message the bridge sent must say exactly who it went to.
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'to-target', 'h3', 'gateway', ?)"
    ).run(at), /CHECK/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h4', 'gateway', 'ws', 5, 'launch', ?)"
    ).run(at), /CHECK/, 'the project is part of who it went to');
    // A proof is never changed afterwards.
    assert.throws(() => db.exec("UPDATE bridge_route_proofs SET target_session_id = 6"), /immutable/);
    // One Hub message belongs to one route.
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r2', 'to-target', 'h1', 'master-launch', 3, 9, 'ws', 5, 'launch', ?)"
    ).run(at), /UNIQUE/);
  });

  it('refuses a child row whose parent does not exist', () => {
    freshStore('orphans');
    const db = store.getDb();
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES ('none', 'inbound', 'x', ?, ?)"
    ).run(digest, at), /needs its route/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, recorded_at) VALUES ('none', 'to-target', 'h9', 'master-launch', 1, ?)"
    ).run(at), /needs its route/);
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:none:failure', 'failure', 'none', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at), /needs its route or candidate/);
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
      + "VALUES ('c1', 'cand:1', 'milestone', 424242, 'launch', 'x', ?, 'submitted', ?)"
    ).run(digest, at), /needs its source project/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES ('none', 'workload', 'w1', ?)"
    ).run(digest), /needs its candidate/);
  });

  it('binds a candidate to its receipts by id and digest, immutably', () => {
    freshStore('receipts');
    const db = store.getDb();
    const project = store.projects.create({ name: 'p', path: path.join(tmpDir, 'p') });
    db.prepare(
      'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
      + "VALUES ('c1', 'cand:1', 'milestone', ?, 'launch', 'x', ?, 'submitted', ?)"
    ).run(project.id, digest, at);
    const bind = db.prepare('INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES (?, ?, ?, ?)');
    bind.run('c1', 'workload', 'w1', digest);
    assert.throws(() => bind.run('c1', 'workload', 'w1', 'b'.repeat(64)), /UNIQUE|PRIMARY/);
    assert.throws(() => db.exec("UPDATE bridge_candidate_receipts SET receipt_digest = 'x'"), /immutable/);
    db.exec("DELETE FROM bridge_candidates WHERE candidate_id = 'c1'");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_candidate_receipts').get().n, 0);
  });

  it('removing a route removes its bodies, proofs and outbound items', () => {
    freshStore('cascade');
    const db = store.getDb();
    route('r1');
    db.prepare("INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES ('r1', 'inbound', 'x', ?, ?)").run(digest, at);
    db.prepare("INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 1, 9, 'ws', 5, 'launch', ?)").run(at);
    db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:failure', 'failure', 'r1', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at);
    db.exec("DELETE FROM bridge_routes WHERE route_id = 'r1'");
    for (const table of ['bridge_route_bodies', 'bridge_route_proofs', 'bridge_outbound']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  });

  describe('questions, consented launches, nicknames and opt-outs (v54)', () => {
    const later = '2026-10-04T01:00:00.000Z';
    const refuses = (fn, why, what) => assert.throws(fn, why, what);
    /** A question on a route, as the store would write it. */
    const ask = (id, routeId, over = {}) => {
      const q = { purpose: 'clarify', target: null, state: 'open', adopted: null, adoptedFor: null, settled: null, ...over };
      store.getDb().prepare(
        'INSERT INTO bridge_questions (question_id, route_id, purpose, target_project_id, state, asked_generation, asked_at, expires_at, adopted_route_id, adopted_for, settled_at) '
        + 'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)'
      ).run(id, routeId, q.purpose, q.target, q.state, at, later, q.adopted, q.adoptedFor, q.settled);
    };
    const settle = (id, state, adopted, adoptedFor) => store.getDb().prepare(
      'UPDATE bridge_questions SET state = ?, adopted_route_id = ?, adopted_for = ?, settled_at = ? WHERE question_id = ?'
    ).run(state, adopted, adoptedFor, later, id);
    /** A consented launch row. */
    const launch = (routeId, questionId, consentRoute, over = {}) => {
      const l = { project: 7, state: 'queued', session: null, launchId: null, started: null, failure: null, startedAt: null, settled: null, ...over };
      return store.getDb().prepare(
        'INSERT INTO bridge_launches (route_id, question_id, consent_route_id, project_id, master_generation, state, session_id, launch_id, started_session, failure_code, requested_at, started_at, settled_at) '
        + 'VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(routeId, questionId, consentRoute, l.project, l.state, l.session, l.launchId, l.started, l.failure, at, l.startedAt, l.settled);
    };
    /** A held route with an adopted consent to launch project 7, answered by `consentRoute`. */
    const consented = (n) => {
      route(`held${n}`);
      route(`yes${n}`);
      ask(`q${n}`, `held${n}`, { purpose: 'launch', target: 7 });
      settle(`q${n}`, 'adopted', `yes${n}`, 'launch');
      return [`held${n}`, `q${n}`, `yes${n}`];
    };

    it('a question belongs to a route, is one at a time, and says what it is for', () => {
      freshStore('questions');
      refuses(() => ask('q0', 'no-such-route'), /needs its route/);
      route('r1');
      ask('q1', 'r1');
      refuses(() => ask('q2', 'r1'), /UNIQUE/, 'one open question per held inbound');
      refuses(() => ask('q3', 'r1', { purpose: 'launch', state: 'cancelled', settled: later }), /CHECK/, 'consent to launch names its project');
      refuses(() => ask('q4', 'r1', { target: 7, state: 'cancelled', settled: later }), /CHECK/, 'and a clarifying question names none');
      refuses(() => ask('q5', 'r1', { purpose: 'guess', state: 'cancelled', settled: later }), /CHECK/);
      refuses(() => ask('q6', 'r1', { state: 'cancelled' }), /CHECK/, 'a settled question says when');
      refuses(() => ask('q7', 'r1', { state: 'adopted', settled: later }), /CHECK/, 'an adopted question names the reply it was adopted on');
      refuses(() => ask('q8', 'r1', { state: 'expired', settled: later, adopted: 'r1', adoptedFor: 'route' }), /CHECK/, 'and no other ending names one');
      refuses(() => ask('q9', 'r1', { state: 'declined', settled: later, adopted: 'r1', adoptedFor: 'route' }), /CHECK/, 'a declined question was adopted for nothing but the decline');
      refuses(() => store.getDb().prepare("INSERT INTO bridge_questions (question_id, route_id, purpose, state, asked_generation, asked_at, expires_at, settled_at) VALUES ('q10', 'r1', 'clarify', 'cancelled', 1, ?, ?, ?)").run(later, at, later), /CHECK/, 'it expires after it is asked');
    });

    it('a question is settled once, one operator reply settles one question, and nothing else about it changes', () => {
      freshStore('questions-fixed');
      for (const id of ['r1', 'r2', 'yes']) route(id);
      ask('q1', 'r1');
      ask('q2', 'r2');
      const db = store.getDb();
      refuses(() => db.prepare("UPDATE bridge_questions SET expires_at = '2027-01-01T00:00:00.000Z' WHERE question_id = 'q1'").run(), /settled once and is otherwise fixed/, 'a question cannot be kept open longer');
      refuses(() => db.prepare("UPDATE bridge_questions SET purpose = 'launch', target_project_id = 7 WHERE question_id = 'q1'").run(), /otherwise fixed/, 'nor become a question about something else');
      refuses(() => db.prepare("UPDATE bridge_questions SET route_id = 'r2' WHERE question_id = 'q1'").run(), /otherwise fixed|UNIQUE/);
      refuses(() => settle('q1', 'adopted', 'yes', null), /CHECK/, 'a reply is adopted for something, and the row says what');
      refuses(() => settle('q1', 'cancelled', null, 'route'), /CHECK/, 'and nothing is adopted without a reply');
      settle('q1', 'adopted', 'yes', 'route');
      refuses(() => settle('q2', 'adopted', 'yes', 'route'), /UNIQUE/, 'the same reply cannot be adopted for a second question');
      refuses(() => settle('q1', 'declined', 'yes', 'decline'), /settled once/, 'an adopted question is not then declined');
      refuses(() => db.prepare("UPDATE bridge_questions SET state = 'open', adopted_route_id = NULL, adopted_for = NULL, settled_at = NULL WHERE question_id = 'q1'").run(), /settled once/, 'nor opened again');
      settle('q2', 'expired', null, null);
      ask('q3', 'r2');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bridge_questions WHERE route_id = 'r2'").get().n, 2, 'a route may be asked again once its question has ended');
    });

    it('only a question item names a question, and its posted parts and its replies carry the name', () => {
      freshStore('question-items');
      route('r1');
      const db = store.getDb();
      const item = (key, kind, questionId, generation) => db.prepare(
        "INSERT INTO bridge_outbound (idem_key, kind, route_id, question_id, source_label, text, digest, state, released_generation, created_at, updated_at) VALUES (?, ?, 'r1', ?, 'Project Master', 'x', ?, 'ready', ?, ?, ?)"
      ).run(key, kind, questionId, digest, generation, at, at);
      const made = item('route:r1:ask:q1', 'question', 'q1', 1);
      refuses(() => item('route:r1:ask:none', 'question', null, 1), /CHECK/, 'a question item names its question');
      refuses(() => item('route:r1:ask:nobody', 'question', 'q1', null), /CHECK/, 'and the Master generation that asked');
      refuses(() => item('route:r1:answer', 'reply', 'q1', 1), /CHECK/, 'an answer is not a question');
      refuses(() => item('route:r1:failure', 'failure', 'q1', null), /CHECK/);
      db.prepare("INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, route_id, question_id, delivered_at) VALUES ('d1', ?, 0, 1, 'question', 'r1', 'q1', ?)").run(Number(made.lastInsertRowid), at);
      route('reply');
      db.prepare("INSERT INTO bridge_route_reply_context (route_id, replied_external_id, canonical_external_id, outbound_id, part_index, part_count, kind, replied_route_id, question_id, created_at) VALUES ('reply', 'd1', 'd1', ?, 0, 1, 'question', 'r1', 'q1', ?)").run(Number(made.lastInsertRowid), at);
      assert.equal(db.prepare("SELECT question_id FROM bridge_route_reply_context WHERE route_id = 'reply'").get().question_id, 'q1');
    });

    it('a launch needs an adopted consent for exactly that route, project and reply', () => {
      freshStore('launch-consent');
      const [held, q, yes] = consented(1);
      refuses(() => launch(held, q, yes, { project: 8 }), /needs an adopted launch consent/, 'consent for one project launches no other');
      refuses(() => launch('yes1', q, yes), /needs an adopted launch consent/, 'nor for another route');
      refuses(() => launch(held, q, held), /needs an adopted launch consent/, 'nor on a reply that was not the one adopted');
      refuses(() => launch(held, 'no-such-question', yes), /needs an adopted launch consent/);
      // A question still open, a clarifying one, and one adopted for something else: none is consent to launch.
      route('h2'); route('y2');
      ask('open', 'h2', { purpose: 'launch', target: 7 });
      refuses(() => launch('h2', 'open', 'y2'), /needs an adopted launch consent/, 'an unanswered question launches nothing');
      settle('open', 'declined', 'y2', 'decline');
      refuses(() => launch('h2', 'open', 'y2'), /needs an adopted launch consent/, 'a declined one launches nothing');
      route('h3'); route('y3');
      ask('clar', 'h3');
      settle('clar', 'adopted', 'y3', 'route');
      refuses(() => launch('h3', 'clar', 'y3'), /needs an adopted launch consent/, 'an answered clarification is not consent to launch');
      assert.equal(Number(launch(held, q, yes).changes), 1, 'the consent itself is accepted');
      refuses(() => launch(held, q, yes), /UNIQUE/, 'once');
    });

    it('one launch is in flight on the install, each state says what it must, and a settled launch is final', () => {
      freshStore('launch-states');
      const a = consented(1);
      const b = consented(2);
      const db = store.getDb();
      launch(...a);
      launch(...b);
      const start = (routeId, session) => db.prepare(
        "UPDATE bridge_launches SET state = 'waiting-ready', session_id = ?, launch_id = ?, started_session = 1, started_at = ? WHERE route_id = ?"
      ).run(session, `launch-${session}`, later, routeId);
      refuses(() => db.prepare("UPDATE bridge_launches SET state = 'waiting-ready', started_at = ? WHERE route_id = ?").run(later, a[0]), /CHECK/, 'a launch in flight names the session it waits for');
      start(a[0], 41);
      refuses(() => start(b[0], 42), /UNIQUE/, 'a second launch waits its turn');
      assert.deepEqual(db.prepare('SELECT route_id, state FROM bridge_launches ORDER BY launch_seq').all().map((r) => [r.route_id, r.state]), [[a[0], 'waiting-ready'], [b[0], 'queued']], 'in the order consent was adopted');
      refuses(() => db.prepare("UPDATE bridge_launches SET project_id = 8 WHERE route_id = ?").run(a[0]), /a consent is fixed/, 'what was consented to does not change');
      refuses(() => db.prepare("UPDATE bridge_launches SET state = 'failed', settled_at = ? WHERE route_id = ?").run(later, a[0]), /CHECK/, 'a failure says why');
      refuses(() => db.prepare("UPDATE bridge_launches SET state = 'dispatched' WHERE route_id = ?").run(a[0]), /CHECK/, 'an ending says when');
      db.prepare("UPDATE bridge_launches SET state = 'failed', failure_code = 'ready-timeout', settled_at = ? WHERE route_id = ?").run(later, a[0]);
      refuses(() => db.prepare("UPDATE bridge_launches SET state = 'dispatched' WHERE route_id = ?").run(a[0]), /a settled launch is final/, 'a failed launch is not later called dispatched');
      start(b[0], 42);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bridge_launches WHERE state = 'waiting-ready'").get().n, 1, 'the next one takes its turn once the first has ended');
      db.prepare("UPDATE bridge_launches SET state = 'abandoned', settled_at = ? WHERE route_id = ?").run(later, b[0]);
      refuses(() => launch(...a), /UNIQUE/, 'and a consent is never used for a second launch, even after the first ended');
    });

    it('removing a route removes its questions and its launches', () => {
      freshStore('question-cascade');
      const [held] = consented(1);
      launch(held, 'q1', 'yes1');
      const db = store.getDb();
      db.exec(`DELETE FROM bridge_routes WHERE route_id = '${held}'`);
      for (const table of ['bridge_questions', 'bridge_launches']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    });

    it('a nickname the Master stores names the operator message behind it, and an opt-out is the operator\'s alone', () => {
      freshStore('nickname-record');
      const db = store.getDb();
      const nick = (alias, by, changedAt, routeId) => db.prepare(
        "INSERT INTO bridge_aliases (alias, destination_kind, destination_project_id, created_by, created_at, changed_by, changed_at, confirmed_route_id, display) VALUES (?, 'master', NULL, ?, ?, ?, ?, ?, ?)"
      ).run(alias, by || 'operator', at, by, changedAt, routeId, alias.toUpperCase());
      refuses(() => nick('a', 'master', at, null), /CHECK/, 'the Master stores a nickname only with an operator message behind it');
      refuses(() => nick('b', 'operator', null, null), /CHECK/, 'who changed it and when go together');
      refuses(() => nick('c', 'session', at, 'r1'), /CHECK/);
      nick('d', 'master', at, 'r1');
      nick('e', 'operator', at, null);
      assert.deepEqual(db.prepare('SELECT alias, changed_by, confirmed_route_id, display FROM bridge_aliases ORDER BY alias').all().map((r) => [r.alias, r.changed_by, r.confirmed_route_id, r.display]), [['d', 'master', 'r1', 'D'], ['e', 'operator', null, 'E']]);
      db.prepare("INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (7, 'operator', ?)").run(at);
      refuses(() => db.prepare("INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (8, 'master', ?)").run(at), /CHECK/, 'the Master cannot opt a project out');
      refuses(() => db.prepare("INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (7, 'operator', ?)").run(at), /UNIQUE|PRIMARY/);
    });
  });

  it('gives every terminal row the timestamp retention works from', () => {
    freshStore('terminal');
    const db = store.getDb();
    route('r1');
    assert.throws(() => db.exec("UPDATE bridge_routes SET state = 'closed' WHERE route_id = 'r1'"), /CHECK/);
    assert.throws(() => db.exec(`UPDATE bridge_routes SET closed_at = '${at}' WHERE route_id = 'r1'`), /CHECK/);
    db.exec(`UPDATE bridge_routes SET state = 'closed', closed_at = '${at}' WHERE route_id = 'r1'`);
    const item = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, delivered_at, created_at, updated_at) '
      + "VALUES (?, 'notification', 'fleet-idle', 'TangleClaw', 'x', ?, ?, ?, ?, ?)"
    );
    assert.throws(() => item.run('n:1', digest, 'delivered', null, at, at), /CHECK/);
    assert.throws(() => item.run('n:1', digest, 'ready', at, at, at), /CHECK/);
    item.run('n:1', digest, 'delivered', at, at, at);
  });

  it('keeps an unresolved route free of destination fields and ties a generation to a Master decision', () => {
    freshStore('route-checks');
    const db = store.getDb();
    route('r1');
    const set = (sql) => () => db.exec(`UPDATE bridge_routes SET ${sql} WHERE route_id = 'r1'`);
    assert.throws(set("destination_workspace_id = 'ws'"), /CHECK/);
    assert.throws(set('resolved_generation = 2'), /CHECK/);
    assert.throws(set("resolved_by = 'master', destination_kind = 'master'"), /CHECK/, 'a Master decision needs its generation');
    assert.throws(set("resolved_by = 'alias', destination_kind = 'master', resolved_generation = 2"), /CHECK/, 'a mechanical resolution has none');
    set("resolved_by = 'master', destination_kind = 'project', destination_project_id = 5, resolved_generation = 2")();
    set("resolved_by = 'default', destination_kind = 'master', destination_project_id = NULL, resolved_generation = NULL")();
  });

  it('lets audit rows leave only behind the anchor, which is one row and only moves forward', () => {
    freshStore('anchor');
    const db = store.getDb();
    const add = db.prepare("INSERT INTO bridge_audit (op, actor, proof, outcome, at) VALUES ('close', 'operator', 'operator', 'applied', ?)");
    add.run(at);
    add.run(at);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_audit_anchor').get().n, 1, 'seeded at creation');
    const move = (sql) => () => db.exec(`UPDATE bridge_audit_anchor SET ${sql}`);
    move(`through_seq = 1, removed_count = 1, compactions = 1, chain_digest = '${digest}'`)();
    assert.equal(db.prepare('DELETE FROM bridge_audit WHERE audit_seq = 1').run().changes, 1);
    assert.throws(() => db.exec('DELETE FROM bridge_audit WHERE audit_seq = 2'), /append-only/);
    assert.throws(move('through_seq = 0, removed_count = 2, compactions = 2'), /only moves forward/);
    assert.throws(move('through_seq = 2, removed_count = 1, compactions = 2'), /only moves forward/);
    assert.throws(move('through_seq = 2, removed_count = 2, compactions = 5'), /only moves forward/);
    assert.throws(() => db.exec('DELETE FROM bridge_audit_anchor'), /permanent/);
    assert.throws(() => db.exec(
      "INSERT INTO bridge_audit_anchor (anchor_id, through_seq, removed_count, compactions, updated_at) VALUES (2, 0, 0, 0, 'x')"
    ), /CHECK/);
  });

  it('keeps global pins for the operator, one active pin per conversation in each scope', () => {
    freshStore('pins');
    const db = store.getDb();
    const pin = db.prepare(
      'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, created_by, master_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    assert.throws(() => pin.run('p0', 'global', null, 'master', 'master', 1, at), /CHECK/, 'Master cannot hold a global pin');
    assert.throws(() => pin.run('p0', 'conversation', null, 'master', 'master', 1, at), /CHECK/, 'a conversation pin names its conversation');
    pin.run('p1', 'conversation', 'chan:1', 'master', 'master', 1, at);
    assert.throws(() => pin.run('p2', 'conversation', 'chan:1', 'master', 'master', 1, at), /UNIQUE/);
    // The operator may pin every conversation, and any number of single ones.
    pin.run('p3', 'global', null, 'master', 'operator', null, at);
    pin.run('p4', 'global', 'chan:1', 'master', 'operator', null, at);
    pin.run('p5', 'global', 'chan:2', 'master', 'operator', null, at);
    assert.throws(() => pin.run('p6', 'global', null, 'master', 'operator', null, at), /UNIQUE/);
    assert.throws(() => pin.run('p7', 'global', 'chan:1', 'master', 'operator', null, at), /UNIQUE/);
    db.exec("UPDATE bridge_pins SET revoked_at = '2026-10-05T00:00:00.000Z' WHERE pin_id = 'p4'");
    pin.run('p8', 'global', 'chan:1', 'master', 'operator', null, at);
  });
});
