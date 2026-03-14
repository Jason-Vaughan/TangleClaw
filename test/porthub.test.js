'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const porthub = require('../lib/porthub');

describe('porthub (store-backed)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-porthub-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    porthub.stopExpirationTimer();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('registerPort / releasePort', () => {
    it('registers a port using the store', () => {
      const result = porthub.registerPort(8080, 'my-project', 'dev-server');
      assert.equal(result.success, true);
      assert.equal(result.error, null);

      const lease = store.portLeases.get(8080);
      assert.ok(lease);
      assert.equal(lease.project, 'my-project');
      assert.equal(lease.service, 'dev-server');
    });

    it('releases a port from the store', () => {
      porthub.registerPort(9090, 'test', 'api');
      const result = porthub.releasePort(9090);
      assert.equal(result.success, true);
      assert.equal(store.portLeases.get(9090), null);
    });
  });

  describe('registerPorts / releasePorts', () => {
    it('handles multiple ports', () => {
      const result = porthub.registerPorts({ dev: 8080, api: 8081 }, 'test-project');
      assert.deepEqual(result.registered, { dev: 8080, api: 8081 });
      assert.equal(result.errors.length, 0);
    });

    it('releases multiple ports', () => {
      porthub.registerPorts({ dev: 8080, api: 8081 }, 'test-project');
      const result = porthub.releasePorts({ dev: 8080, api: 8081 });
      assert.deepEqual(result.released, [8080, 8081]);
      assert.equal(result.errors.length, 0);
    });
  });

  describe('checkPort', () => {
    it('returns available for unleased port', () => {
      const result = porthub.checkPort(9999);
      assert.equal(result.available, true);
      assert.equal(result.leasedBy, null);
    });

    it('returns unavailable for leased port', () => {
      porthub.registerPort(5000, 'blocker', 'web');
      const result = porthub.checkPort(5000);
      assert.equal(result.available, false);
      assert.equal(result.leasedBy, 'blocker');
    });
  });

  describe('getLeases / getLeasesForProject', () => {
    it('returns all leases', () => {
      porthub.registerPort(3000, 'A', 'svc1');
      porthub.registerPort(4000, 'B', 'svc2');
      const leases = porthub.getLeases();
      assert.equal(leases.length, 2);
    });

    it('returns leases for a specific project', () => {
      porthub.registerPort(3000, 'A', 'svc1');
      porthub.registerPort(3001, 'A', 'svc2');
      porthub.registerPort(4000, 'B', 'svc3');
      const leases = porthub.getLeasesForProject('A');
      assert.equal(leases.length, 2);
    });
  });

  describe('bootstrap', () => {
    it('registers infrastructure ports', () => {
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      const ttyd = store.portLeases.get(3100);
      assert.ok(ttyd);
      assert.equal(ttyd.project, 'TangleClaw');
      assert.equal(ttyd.service, 'ttyd');

      const server = store.portLeases.get(3101);
      assert.ok(server);
      assert.equal(server.project, 'TangleClaw');
      assert.equal(server.service, 'server');
    });
  });

  describe('shutdown', () => {
    it('releases infrastructure ports', () => {
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      porthub.shutdown({ ttydPort: 3100, serverPort: 3101 });

      assert.equal(store.portLeases.get(3100), null);
      assert.equal(store.portLeases.get(3101), null);
    });
  });

  describe('expiration timer', () => {
    it('starts and stops without error', () => {
      porthub.startExpirationTimer();
      porthub.startExpirationTimer(); // idempotent
      porthub.stopExpirationTimer();
      porthub.stopExpirationTimer(); // idempotent
    });
  });
});
