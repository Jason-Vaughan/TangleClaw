'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.openclawConnections', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-openclaw-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a valid connection with defaults.
   * @param {object} [overrides] - Fields to override
   * @returns {object}
   */
  function createConnection(overrides = {}) {
    return store.openclawConnections.create({
      name: 'ExampleApp',
      host: '198.51.100.10',
      sshUser: 'testuser',
      sshKeyPath: '~/.ssh/test_key',
      ...overrides
    });
  }

  describe('create', () => {
    it('should create a connection with required fields', () => {
      const conn = createConnection();
      assert.ok(conn.id);
      assert.equal(conn.name, 'ExampleApp');
      assert.equal(conn.host, '198.51.100.10');
      assert.equal(conn.sshUser, 'testuser');
      assert.equal(conn.sshKeyPath, '~/.ssh/test_key');
      assert.equal(conn.port, 18789);
      assert.equal(conn.localPort, 18789);
      assert.equal(conn.cliCommand, 'openclaw-cli');
      assert.equal(conn.availableAsEngine, false);
      assert.equal(conn.gatewayToken, null);
      // Post-#160: bridgePort defaults to null (not 3201) so non-ClawBridge
      // deployments don't get a stray `-L 3201` SSH forward.
      assert.equal(conn.bridgePort, null);
      assert.ok(conn.createdAt);
    });

    it('should accept optional fields', () => {
      const conn = createConnection({
        port: 9999,
        gatewayToken: 'tok-123',
        cliCommand: 'my-cli',
        localPort: 8888,
        bridgePort: 4201,
        instanceDir: '~/openclaw-tilt',
        availableAsEngine: true
      });
      assert.equal(conn.port, 9999);
      assert.equal(conn.gatewayToken, 'tok-123');
      assert.equal(conn.cliCommand, 'my-cli');
      assert.equal(conn.bridgePort, 4201);
      assert.equal(conn.instanceDir, '~/openclaw-tilt');
      assert.equal(conn.localPort, 8888);
      assert.equal(conn.availableAsEngine, true);
    });

    it('defaults instanceDir to null and round-trips an update (#296)', () => {
      const created = createConnection({});
      assert.equal(created.instanceDir, null, 'unset → null');
      const updated = store.openclawConnections.update(created.id, { instanceDir: '~/openclaw' });
      assert.equal(updated.instanceDir, '~/openclaw');
      const cleared = store.openclawConnections.update(created.id, { instanceDir: null });
      assert.equal(cleared.instanceDir, null, 'PATCH to null clears');
    });

    it('should trim whitespace from name', () => {
      const conn = createConnection({ name: '  ExampleApp  ' });
      assert.equal(conn.name, 'ExampleApp');
    });

    it('should reject empty name', () => {
      assert.throws(() => createConnection({ name: '' }), { code: 'BAD_REQUEST' });
      assert.throws(() => createConnection({ name: '   ' }), { code: 'BAD_REQUEST' });
    });

    it('should reject invalid name characters', () => {
      assert.throws(() => createConnection({ name: 'bad/name' }), { code: 'BAD_REQUEST' });
    });

    it('should reject missing host', () => {
      assert.throws(() => createConnection({ host: '' }), { code: 'BAD_REQUEST' });
    });

    it('should reject missing sshUser', () => {
      assert.throws(() => createConnection({ sshUser: '' }), { code: 'BAD_REQUEST' });
    });

    it('should reject missing sshKeyPath', () => {
      assert.throws(() => createConnection({ sshKeyPath: '' }), { code: 'BAD_REQUEST' });
    });

    it('should reject duplicate name', () => {
      createConnection();
      assert.throws(() => createConnection(), { code: 'CONFLICT' });
    });

    it('defaults fallbackHosts to [] and round-trips a real list, in priority order (#1531)', () => {
      const created = createConnection({});
      assert.deepEqual(created.fallbackHosts, []);
      const withFallback = createConnection({
        name: 'WithFallback', fallbackHosts: ['habitat.tail123.ts.net', 'kobold.tail123.ts.net']
      });
      assert.deepEqual(withFallback.fallbackHosts, ['habitat.tail123.ts.net', 'kobold.tail123.ts.net']);
      const fetched = store.openclawConnections.get(withFallback.id);
      assert.deepEqual(fetched.fallbackHosts, ['habitat.tail123.ts.net', 'kobold.tail123.ts.net']);
    });

    it('trims, drops blanks, and dedupes fallbackHosts against the primary host', () => {
      const conn = createConnection({
        name: 'Deduped', host: '192.168.20.10',
        fallbackHosts: ['  habitat.tail123.ts.net  ', '', '192.168.20.10', 'habitat.tail123.ts.net']
      });
      assert.deepEqual(conn.fallbackHosts, ['habitat.tail123.ts.net']);
    });

    it('rejects an unsafe fallbackHosts entry, BAD_REQUEST, before the row is ever written', () => {
      assert.throws(
        () => createConnection({ name: 'Unsafe', fallbackHosts: ['ok-host', 'a; rm -rf /'] }),
        { code: 'BAD_REQUEST' }
      );
      assert.equal(store.openclawConnections.list().find((c) => c.name === 'Unsafe'), undefined);
    });

    it('rejects a non-array fallbackHosts', () => {
      assert.throws(() => createConnection({ fallbackHosts: 'not-an-array' }), { code: 'BAD_REQUEST' });
    });
  });

  describe('get', () => {
    it('should return connection by id', () => {
      const created = createConnection();
      const fetched = store.openclawConnections.get(created.id);
      assert.equal(fetched.name, 'ExampleApp');
      assert.equal(fetched.host, '198.51.100.10');
    });

    it('should return null for non-existent id', () => {
      const result = store.openclawConnections.get('nonexistent');
      assert.equal(result, null);
    });
  });

  describe('list', () => {
    it('should return empty array initially', () => {
      const list = store.openclawConnections.list();
      assert.deepEqual(list, []);
    });

    it('should return all connections sorted by name', () => {
      createConnection({ name: 'Zulu' });
      createConnection({ name: 'Alpha', host: '10.0.0.1' });
      const list = store.openclawConnections.list();
      assert.equal(list.length, 2);
      assert.equal(list[0].name, 'Alpha');
      assert.equal(list[1].name, 'Zulu');
    });

    it('should filter by availableAsEngine', () => {
      createConnection({ name: 'EngineOne', availableAsEngine: true });
      createConnection({ name: 'NotEngine', availableAsEngine: false });

      const engines = store.openclawConnections.list({ availableAsEngine: true });
      assert.equal(engines.length, 1);
      assert.equal(engines[0].name, 'EngineOne');

      const nonEngines = store.openclawConnections.list({ availableAsEngine: false });
      assert.equal(nonEngines.length, 1);
      assert.equal(nonEngines[0].name, 'NotEngine');
    });
  });

  describe('update', () => {
    it('should update individual fields', () => {
      const conn = createConnection();
      const updated = store.openclawConnections.update(conn.id, { name: 'NewName', port: 5555 });
      assert.equal(updated.name, 'NewName');
      assert.equal(updated.port, 5555);
      assert.equal(updated.host, '198.51.100.10'); // unchanged
    });

    it('should update bridgePort', () => {
      const conn = createConnection();
      // Post-#160: default is null, not 3201.
      assert.equal(conn.bridgePort, null);
      const updated = store.openclawConnections.update(conn.id, { bridgePort: 4201 });
      assert.equal(updated.bridgePort, 4201);
    });

    it('should toggle availableAsEngine', () => {
      const conn = createConnection();
      assert.equal(conn.availableAsEngine, false);
      const updated = store.openclawConnections.update(conn.id, { availableAsEngine: true });
      assert.equal(updated.availableAsEngine, true);
    });

    it('should return existing if no fields provided', () => {
      const conn = createConnection();
      const same = store.openclawConnections.update(conn.id, {});
      assert.equal(same.name, conn.name);
    });

    it('should throw NOT_FOUND for non-existent id', () => {
      assert.throws(
        () => store.openclawConnections.update('nonexistent', { name: 'X' }),
        { code: 'NOT_FOUND' }
      );
    });

    it('should throw CONFLICT for duplicate name', () => {
      createConnection({ name: 'A' });
      const b = createConnection({ name: 'B', host: '10.0.0.1' });
      assert.throws(
        () => store.openclawConnections.update(b.id, { name: 'A' }),
        { code: 'CONFLICT' }
      );
    });

    it('updates fallbackHosts, re-validated and re-deduped against whichever host is primary (#1531)', () => {
      const conn = createConnection();
      const updated = store.openclawConnections.update(conn.id, {
        fallbackHosts: ['habitat.tail123.ts.net', '198.51.100.10'] // 198.51.100.10 is this row's own host
      });
      assert.deepEqual(updated.fallbackHosts, ['habitat.tail123.ts.net'], 'deduped against the UNCHANGED existing host');
    });

    it('re-validates fallbackHosts against a host ALSO being changed in the same call', () => {
      const conn = createConnection({ host: '10.0.0.5' });
      const updated = store.openclawConnections.update(conn.id, {
        host: '10.0.0.9',
        fallbackHosts: ['10.0.0.9', '10.0.0.5'] // 10.0.0.9 is the NEW host, must dedupe against it, not the old one
      });
      assert.deepEqual(updated.fallbackHosts, ['10.0.0.5']);
    });

    it('clearing fallbackHosts to [] is a real clear, not a no-op', () => {
      const conn = createConnection({ fallbackHosts: ['habitat.tail123.ts.net'] });
      assert.deepEqual(conn.fallbackHosts, ['habitat.tail123.ts.net']);
      const cleared = store.openclawConnections.update(conn.id, { fallbackHosts: [] });
      assert.deepEqual(cleared.fallbackHosts, []);
    });

    it('rejects an unsafe fallbackHosts entry on update too', () => {
      const conn = createConnection();
      assert.throws(
        () => store.openclawConnections.update(conn.id, { fallbackHosts: ['a; rm -rf /'] }),
        { code: 'BAD_REQUEST' }
      );
    });
  });

  describe('migrateHostToMagicDns (#363)', () => {
    it('refuses without explicit confirmation, CONFIRMATION_REQUIRED', () => {
      const conn = createConnection();
      assert.throws(
        () => store.openclawConnections.migrateHostToMagicDns(conn.id, { magicDnsHost: 'habitat.tail123.ts.net' }),
        { code: 'CONFIRMATION_REQUIRED' }
      );
      // Refused BEFORE anything changed.
      assert.equal(store.openclawConnections.get(conn.id).host, conn.host);
    });

    it('rewrites host and keeps the old IP as the top-priority fallback by default', () => {
      const conn = createConnection({ host: '192.168.20.10' });
      const migrated = store.openclawConnections.migrateHostToMagicDns(conn.id, {
        magicDnsHost: 'habitat.tail123.ts.net', confirmed: true
      });
      assert.equal(migrated.host, 'habitat.tail123.ts.net');
      assert.deepEqual(migrated.fallbackHosts, ['192.168.20.10']);
    });

    it('discards the old host when keepOldHostAsFallback is false', () => {
      const conn = createConnection({ host: '192.168.20.10' });
      const migrated = store.openclawConnections.migrateHostToMagicDns(conn.id, {
        magicDnsHost: 'habitat.tail123.ts.net', keepOldHostAsFallback: false, confirmed: true
      });
      assert.equal(migrated.host, 'habitat.tail123.ts.net');
      assert.deepEqual(migrated.fallbackHosts, []);
    });

    it('preserves OTHER existing fallback hosts alongside the demoted primary', () => {
      const conn = createConnection({ host: '192.168.20.10', fallbackHosts: ['kobold.tail123.ts.net'] });
      const migrated = store.openclawConnections.migrateHostToMagicDns(conn.id, {
        magicDnsHost: 'habitat.tail123.ts.net', confirmed: true
      });
      assert.deepEqual(migrated.fallbackHosts, ['192.168.20.10', 'kobold.tail123.ts.net']);
    });

    it('refuses a magicDnsHost that is itself an IP literal — this migration exists to move away from one', () => {
      const conn = createConnection();
      assert.throws(
        () => store.openclawConnections.migrateHostToMagicDns(conn.id, { magicDnsHost: '10.0.0.9', confirmed: true }),
        { code: 'BAD_REQUEST' }
      );
    });

    it('refuses a missing or unsafe magicDnsHost', () => {
      const conn = createConnection();
      assert.throws(
        () => store.openclawConnections.migrateHostToMagicDns(conn.id, { confirmed: true }),
        { code: 'BAD_REQUEST' }
      );
      assert.throws(
        () => store.openclawConnections.migrateHostToMagicDns(conn.id, { magicDnsHost: 'a; rm -rf /', confirmed: true }),
        { code: 'BAD_REQUEST' }
      );
    });

    it('throws NOT_FOUND for a non-existent connection', () => {
      assert.throws(
        () => store.openclawConnections.migrateHostToMagicDns('nonexistent', { magicDnsHost: 'habitat.tail123.ts.net', confirmed: true }),
        { code: 'NOT_FOUND' }
      );
    });
  });

  describe('delete', () => {
    it('should delete a connection', () => {
      const conn = createConnection();
      store.openclawConnections.delete(conn.id);
      assert.equal(store.openclawConnections.get(conn.id), null);
    });

    it('should throw NOT_FOUND for non-existent id', () => {
      assert.throws(
        () => store.openclawConnections.delete('nonexistent'),
        { code: 'NOT_FOUND' }
      );
    });

    it('should not affect other connections', () => {
      const a = createConnection({ name: 'A' });
      const b = createConnection({ name: 'B', host: '10.0.0.1' });
      store.openclawConnections.delete(a.id);
      assert.ok(store.openclawConnections.get(b.id));
      assert.equal(store.openclawConnections.list().length, 1);
    });
  });

  describe('schema migration', () => {
    it('should persist connections across close/init cycles', () => {
      createConnection();
      store.close();
      store.init();
      const list = store.openclawConnections.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'ExampleApp');
    });

    it('v14→v15 migration preserves existing bridge_port row data verbatim (#160)', () => {
      // Critic MAJOR-2: the canonical migration test. Builds a fresh tmpDir
      // with the PRE-#160 schema (bridge_port INTEGER NOT NULL DEFAULT 3201),
      // seeds rows with two distinct existing bridge_port values, marks
      // schema_version = 14, then runs `store.init()` which fires
      // `_runMigrations` and exercises the v14→v15 recreate-table path. After
      // the run, both rows must still carry their original bridge_port values.
      store.close();
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-openclaw-mig-'));
      try {
        // Seed a pre-#160 SQLite DB using node:sqlite (the same engine
        // `lib/store.js` uses — DatabaseSync). Land the exact pre-#160 schema
        // shape via `.exec`.
        const { DatabaseSync } = require('node:sqlite');
        const dbPath = path.join(tmpDir2, 'tangleclaw.db');
        const seed = new DatabaseSync(dbPath);
        seed.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO schema_version (version) VALUES (14);
          CREATE TABLE openclaw_connections (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL UNIQUE,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 18789,
            ssh_user          TEXT NOT NULL,
            ssh_key_path      TEXT NOT NULL,
            gateway_token     TEXT,
            cli_command       TEXT DEFAULT 'openclaw-cli',
            local_port        INTEGER NOT NULL DEFAULT 18789,
            available_as_engine INTEGER NOT NULL DEFAULT 0,
            default_mode      TEXT NOT NULL DEFAULT 'ssh',
            audit_secret      TEXT,
            bridge_port       INTEGER NOT NULL DEFAULT 3201,
            bridge_token      TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO openclaw_connections
            (id, name, host, port, ssh_user, ssh_key_path, local_port, default_mode, bridge_port)
          VALUES
            ('row-3201', 'PreBridge3201', '10.0.0.1', 18789, 'user', '/key', 18790, 'ssh', 3201),
            ('row-4501', 'PreBridge4501', '10.0.0.2', 18789, 'user', '/key', 18791, 'ssh', 4501);
        `);
        seed.close();

        // Run the actual migration via store.init().
        store._setBasePath(tmpDir2);
        store.init();

        const db = store.getDb();
        // Schema version advanced to current (v14 → v15 bridge_port rebuild → v16 instance_dir → v17 migration_status → v18 session_rules → v19 session_rule_versions → v20 session_rules.kind → v21 sessions.owner → v22 projects.orchestration_profile → v23 session_rule_versions.op CHECK → v24 session_rule_versions.critic_gate).
        const ver = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
        assert.equal(ver.version, store.CURRENT_SCHEMA_VERSION);
        // Column constraint actually changed (v15).
        const cols = db.prepare("PRAGMA table_info(openclaw_connections)").all();
        const bridgeCol = cols.find((c) => c.name === 'bridge_port');
        assert.equal(bridgeCol.notnull, 0, 'post-migration: bridge_port nullable');
        assert.equal(bridgeCol.dflt_value, null, 'post-migration: no SQL DEFAULT');
        // v16 added instance_dir (#296) on top of the v15 rebuild.
        assert.ok(cols.find((c) => c.name === 'instance_dir'), 'post-migration: instance_dir column present');
        // Data preservation: both rows survive with their original bridge_port.
        const row3201 = db.prepare('SELECT bridge_port FROM openclaw_connections WHERE id = ?').get('row-3201');
        const row4501 = db.prepare('SELECT bridge_port FROM openclaw_connections WHERE id = ?').get('row-4501');
        assert.equal(row3201.bridge_port, 3201, 'pre-existing 3201 row preserved');
        assert.equal(row4501.bridge_port, 4501, 'pre-existing 4501 row preserved');
        // Post-migration: inserts with bridge_port = null now work.
        const created = store.openclawConnections.create({
          name: 'PostMigration',
          host: '10.0.0.3',
          sshUser: 'user',
          sshKeyPath: '/key',
          localPort: 18792,
          bridgePort: null
        });
        assert.equal(created.bridgePort, null, 'post-migration: null bridgePort accepted');
      } finally {
        try { store.close(); } catch { /* already closed */ }
        fs.rmSync(tmpDir2, { recursive: true, force: true });
        // Restore the test-suite's own tmpDir so afterEach() runs cleanly.
        store._setBasePath(tmpDir);
        store.init();
      }
    });

    it('adds fallback_hosts to an existing v79 store, preserving existing rows verbatim, WITHOUT '
      + 'bumping CURRENT_SCHEMA_VERSION (#1531, Architect Ruling A505-R4.2)', () => {
      store.close();
      const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-openclaw-mig-fh-'));
      try {
        const { DatabaseSync } = require('node:sqlite');
        const dbPath = path.join(tmpDir3, 'tangleclaw.db');
        const seed = new DatabaseSync(dbPath);
        seed.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO schema_version (version) VALUES (79);
          CREATE TABLE openclaw_connections (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL UNIQUE,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 18789,
            ssh_user          TEXT NOT NULL,
            ssh_key_path      TEXT NOT NULL,
            gateway_token     TEXT,
            cli_command       TEXT DEFAULT 'openclaw-cli',
            local_port        INTEGER NOT NULL DEFAULT 18789,
            available_as_engine INTEGER NOT NULL DEFAULT 0,
            default_mode      TEXT NOT NULL DEFAULT 'ssh',
            audit_secret      TEXT,
            bridge_port       INTEGER,
            bridge_token      TEXT,
            instance_dir      TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO openclaw_connections (id, name, host, ssh_user, ssh_key_path, local_port)
          VALUES ('row-pre-fh', 'PreFallbackHosts', '10.0.0.5', 'user', '/key', 18790);
        `);
        seed.close();

        store._setBasePath(tmpDir3);
        store.init();

        const db = store.getDb();
        const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
        assert.equal(ver.v, 79, 'CURRENT_SCHEMA_VERSION stays 79 — Ruling A505-R4.2 explicitly keeps it '
          + 'unbumped so historical schema-version assertions elsewhere in the suite stay untouched');
        assert.equal(ver.v, store.CURRENT_SCHEMA_VERSION);
        const cols = db.prepare("PRAGMA table_info(openclaw_connections)").all();
        assert.ok(cols.find((c) => c.name === 'fallback_hosts'), 'fallback_hosts column present after the idempotent add');

        const preExisting = store.openclawConnections.get('row-pre-fh');
        assert.equal(preExisting.host, '10.0.0.5', 'pre-existing row untouched');
        assert.deepEqual(preExisting.fallbackHosts, [], 'a pre-existing row reads back as an empty list, never null/undefined');

        const created = store.openclawConnections.create({
          name: 'PostFallbackHostsAdd', host: '10.0.0.6', sshUser: 'user', sshKeyPath: '/key',
          localPort: 18791, fallbackHosts: ['habitat.tail123.ts.net']
        });
        assert.deepEqual(created.fallbackHosts, ['habitat.tail123.ts.net'], 'fallbackHosts round-trips after the column add');
      } finally {
        try { store.close(); } catch { /* already closed */ }
        fs.rmSync(tmpDir3, { recursive: true, force: true });
        store._setBasePath(tmpDir);
        store.init();
      }
    });

    it('adding fallback_hosts is idempotent across repeated init() calls', () => {
      createConnection();
      store.close();
      store.init();
      assert.doesNotThrow(() => store.init());
      const cols = store.getDb().prepare("PRAGMA table_info(openclaw_connections)").all();
      assert.equal(cols.filter((c) => c.name === 'fallback_hosts').length, 1, 'exactly one column, not re-added');
    });

    it('should have bridge_port column after migration', () => {
      const db = store.getDb();
      const cols = db.prepare("PRAGMA table_info(openclaw_connections)").all();
      const bridgeCol = cols.find(c => c.name === 'bridge_port');
      assert.ok(bridgeCol, 'bridge_port column should exist');
      // Post-#160 (schema v15): NOT NULL constraint dropped + DEFAULT removed.
      assert.equal(bridgeCol.notnull, 0, 'bridge_port should be nullable');
      assert.equal(bridgeCol.dflt_value, null, 'bridge_port should have no SQL DEFAULT');
    });
  });
});
