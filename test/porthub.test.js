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
const portScanner = require('../lib/port-scanner');

describe('porthub (store-backed)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-porthub-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    porthub.stopExpirationTimer();
    portScanner._reset();
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

      const expectedName = require('node:path').basename(require('node:path').resolve(__dirname, '..'));
      const ttyd = store.portLeases.get(3100);
      assert.ok(ttyd);
      assert.equal(ttyd.project, expectedName);
      assert.equal(ttyd.service, 'ttyd');

      const server = store.portLeases.get(3101);
      assert.ok(server);
      assert.equal(server.project, expectedName);
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

  describe('checkPort with port scanner', () => {
    it('returns systemDetected when scanner shows port in use', () => {
      portScanner._reset();
      portScanner.scan();

      // Port 7777 is unlikely to be leased in our test DB
      const result = porthub.checkPort(7777);
      // If 7777 happens to be in use by system, systemDetected will be true
      // Either way, the shape should be correct
      assert.equal(typeof result.available, 'boolean');
      assert.equal(typeof result.systemDetected, 'boolean');
      assert.ok('leasedBy' in result);
    });

    it('returns systemDetected: false for unleased port not in system', () => {
      portScanner._reset(); // empty cache
      const result = porthub.checkPort(59999);
      assert.equal(result.available, true);
      assert.equal(result.leasedBy, null);
      assert.equal(result.systemDetected, false);
    });

    it('returns leasedBy when port is leased, not systemDetected', () => {
      porthub.registerPort(6666, 'test-proj', 'web');
      const result = porthub.checkPort(6666);
      assert.equal(result.available, false);
      assert.equal(result.leasedBy, 'test-proj');
      assert.equal(result.systemDetected, false);
    });
  });

  describe('registerPort with port scanner warning', () => {
    it('succeeds even when scanner shows port in use', () => {
      portScanner.scan();
      // Register should always succeed regardless of scanner state
      const result = porthub.registerPort(7778, 'test-proj', 'api');
      assert.equal(result.success, true);
      assert.equal(result.error, null);
    });
  });

  describe('orphan cleanup with OpenClaw connections', () => {
    it('preserves leases for active OpenClaw connections', () => {
      // Create an OpenClaw connection
      const conn = store.openclawConnections.create({
        name: 'OrphanTest',
        host: '10.0.0.1',
        sshUser: 'user',
        sshKeyPath: '/key',
        localPort: 13300
      });

      // Register a port under the oc-direct-<id> pattern
      porthub.registerPort(13300, `oc-direct-${conn.id}`, 'openclaw-tunnel');

      // Also register an orphan port for a nonexistent project
      porthub.registerPort(13301, 'deleted-project', 'dev-server');

      // Set projectsDir so cleanup can check directories
      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      // Run bootstrap which includes orphan cleanup
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      // oc-direct-* lease should survive
      const connLease = store.portLeases.get(13300);
      assert.ok(connLease, 'OpenClaw connection port lease should survive orphan cleanup');
      assert.equal(connLease.project, `oc-direct-${conn.id}`);

      // Orphan lease should be cleaned up
      const orphanLease = store.portLeases.get(13301);
      assert.equal(orphanLease, null, 'orphan lease should be cleaned up');
    });
  });
});
