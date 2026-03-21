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
      name: 'RentalClaw',
      host: '192.168.20.10',
      sshUser: 'habitat-admin',
      sshKeyPath: '~/.ssh/genesis_habitat',
      ...overrides
    });
  }

  describe('create', () => {
    it('should create a connection with required fields', () => {
      const conn = createConnection();
      assert.ok(conn.id);
      assert.equal(conn.name, 'RentalClaw');
      assert.equal(conn.host, '192.168.20.10');
      assert.equal(conn.sshUser, 'habitat-admin');
      assert.equal(conn.sshKeyPath, '~/.ssh/genesis_habitat');
      assert.equal(conn.port, 18789);
      assert.equal(conn.localPort, 18789);
      assert.equal(conn.cliCommand, 'openclaw-cli');
      assert.equal(conn.availableAsEngine, false);
      assert.equal(conn.gatewayToken, null);
      assert.ok(conn.createdAt);
    });

    it('should accept optional fields', () => {
      const conn = createConnection({
        port: 9999,
        gatewayToken: 'tok-123',
        cliCommand: 'my-cli',
        localPort: 8888,
        availableAsEngine: true
      });
      assert.equal(conn.port, 9999);
      assert.equal(conn.gatewayToken, 'tok-123');
      assert.equal(conn.cliCommand, 'my-cli');
      assert.equal(conn.localPort, 8888);
      assert.equal(conn.availableAsEngine, true);
    });

    it('should trim whitespace from name', () => {
      const conn = createConnection({ name: '  RentalClaw  ' });
      assert.equal(conn.name, 'RentalClaw');
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
  });

  describe('get', () => {
    it('should return connection by id', () => {
      const created = createConnection();
      const fetched = store.openclawConnections.get(created.id);
      assert.equal(fetched.name, 'RentalClaw');
      assert.equal(fetched.host, '192.168.20.10');
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
      assert.equal(updated.host, '192.168.20.10'); // unchanged
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
      assert.equal(list[0].name, 'RentalClaw');
    });
  });
});
