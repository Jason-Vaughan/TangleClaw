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

/**
 * Answer every single-port probe as lsof does when nothing listens (exit 1, no
 * output), so these tests grade the registry and never this machine's ports —
 * a developer box running anything on a fixture port would otherwise turn a
 * lease into PORT_IN_USE.
 */
function probeFindsNothing() {
  portScanner._setExec(() => {
    const err = new Error('no listener');
    err.status = 1;
    err.stdout = '';
    err.stderr = '';
    throw err;
  });
}

describe('porthub (store-backed)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-porthub-'));
    store._setBasePath(tmpDir);
    store.init();
    probeFindsNothing();
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

    it('reclaims infra ports held under a different project name (#613)', () => {
      // The startup-safety property behind bootstrap's `force`. The project
      // name is derived from the CHECKOUT DIRECTORY, so a clone or worktree
      // named anything other than the original re-registers the same ports
      // under a different owner — and without `force` that is a cross-project
      // claim on its own previous lease, which would 409 and leave the server
      // unable to record the ports it is about to bind anyway.
      store.portLeases.lease({ port: 3100, project: 'TangleClaw-worktree', service: 'ttyd', permanent: true });
      store.portLeases.lease({ port: 3101, project: 'TangleClaw-worktree', service: 'server', permanent: true });

      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      const expectedName = path.basename(path.resolve(__dirname, '..'));
      assert.equal(store.portLeases.get(3100).project, expectedName,
        'bootstrap must reclaim its own infra port regardless of the recorded owner');
      assert.equal(store.portLeases.get(3101).project, expectedName);
    });
  });

  // #613 — the store refuses a cross-project claim; these cover the wrapper
  // every in-process caller actually goes through.
  describe('registerPort ownership (#613)', () => {
    it('fails without taking the port when another project owns it', () => {
      store.portLeases.lease({ port: 4300, project: 'Owner', service: 'dev-server' });

      const result = porthub.registerPort(4300, 'Intruder', 'api');

      assert.equal(result.success, false);
      assert.equal(store.portLeases.get(4300).project, 'Owner', 'the owner keeps the port');
    });

    it('reports the conflict distinctly from a malformed request', () => {
      // A caller that wants to pick another port needs to tell "someone else
      // owns this" apart from "this request was wrong", and needs to know who.
      store.portLeases.lease({ port: 4301, project: 'Owner', service: 'dev-server' });

      const result = porthub.registerPort(4301, 'Intruder', 'api');

      assert.equal(result.code, 'PORT_CONFLICT');
      assert.equal(result.owner.project, 'Owner');
      assert.equal(result.owner.service, 'dev-server');
    });

    it('takes the port over when force is passed', () => {
      store.portLeases.lease({ port: 4302, project: 'Owner', service: 'dev-server' });

      const result = porthub.registerPort(4302, 'Taker', 'api', { force: true });

      assert.equal(result.success, true);
      assert.equal(store.portLeases.get(4302).project, 'Taker');
    });

    it('renews a port the same project already holds', () => {
      porthub.registerPort(4303, 'Same', 'api');
      const result = porthub.registerPort(4303, 'Same', 'api-v2');

      assert.equal(result.success, true);
      assert.equal(store.portLeases.get(4303).service, 'api-v2');
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

  // #814 — the registry used to answer "free" for a port the machine was
  // visibly using, and only logged a warning. The contract is now: an UNLEASED
  // listener refuses the lease unless the caller adopts it as its own. This
  // replaces the old "always succeeds regardless of scanner" case, whose
  // requirement #814 reverses.
  describe('registerPort listener check (#814)', () => {
    /** Make lsof report `command` (pid 4242) listening on `port`. */
    function probeFinds(port, command = 'caddy') {
      portScanner._setExec(() => [
        'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        `${command}  4242 me    7u  IPv6 0x1      0t0  TCP *:${port} (LISTEN)`
      ].join('\n'));
    }

    it('refuses an unleased listener, names it, and stores nothing', () => {
      probeFinds(8443);
      const result = porthub.registerPort(8443, 'WheresMy', 'preview', { permanent: false });
      assert.equal(result.success, false);
      assert.equal(result.code, 'PORT_IN_USE');
      assert.deepEqual(result.listener, { port: 8443, pid: 4242, command: 'caddy' });
      assert.equal(result.listenerCheck, 'refused');
      assert.match(result.error, /adoptListener/);
      assert.equal(store.portLeases.get(8443), null, 'a refused lease must not be written');
    });

    it('grants the same request when the caller adopts the listener', () => {
      probeFinds(8443, 'node');
      const result = porthub.registerPort(8443, 'my-proj', 'dev', { adoptListener: true });
      assert.equal(result.success, true);
      assert.equal(result.listenerCheck, 'adopted');
      assert.equal(result.listener.pid, 4242);
      assert.equal(store.portLeases.get(8443).project, 'my-proj');
    });

    it('a renewal by the holding project never probes', () => {
      porthub.registerPort(3200, 'my-proj', 'dev');
      let probed = false;
      portScanner._setExec(() => { probed = true; return ''; });
      const result = porthub.registerPort(3200, 'my-proj', 'dev');
      assert.equal(result.success, true);
      assert.equal(result.listenerCheck, 'renewal');
      assert.equal(probed, false, 'the running service IS the listener; asking would refuse the happy path');
    });

    it("another project's live lease stays PORT_CONFLICT, not PORT_IN_USE", () => {
      porthub.registerPort(3200, 'owner', 'dev');
      probeFinds(3200);
      const result = porthub.registerPort(3200, 'intruder', 'dev');
      assert.equal(result.code, 'PORT_CONFLICT');
      assert.equal(result.owner.project, 'owner');
      assert.equal(result.listenerCheck, null);
    });

    it('a forced takeover of a leased port is not refused by its listener', () => {
      porthub.registerPort(3200, 'gone', 'dev');
      probeFinds(3200);
      const result = porthub.registerPort(3200, 'successor', 'dev', { force: true });
      assert.equal(result.success, true);
      assert.equal(result.listenerCheck, 'takeover');
    });

    it('an expired lease does not hide a listener', () => {
      store.portLeases.lease({ port: 3201, project: 'old', service: 'dev', ttlMs: 1 });
      store.getDb().prepare("UPDATE port_leases SET expires_at = datetime('now', '-1 hour') WHERE port = 3201").run();
      probeFinds(3201);
      const result = porthub.registerPort(3201, 'new', 'dev');
      assert.equal(result.code, 'PORT_IN_USE');
    });

    it('a non-localhost host is not probed and says so', () => {
      let probed = false;
      portScanner._setExec(() => { probed = true; return ''; });
      const result = porthub.registerPort(3203, 'RentalClaw', 'tools', { host: 'habitat' });
      assert.equal(result.success, true);
      assert.equal(result.listenerCheck, 'not-local');
      assert.equal(probed, false);
    });

    it('when lsof cannot run and no scan is cached, grants and says the check was unavailable', () => {
      portScanner._setExec(() => {
        const err = new Error('lsof: not found');
        err.status = 127;
        err.stdout = '';
        err.stderr = 'sh: lsof: not found';
        throw err;
      });
      const result = porthub.registerPort(3204, 'p', 'dev');
      assert.equal(result.success, true);
      assert.equal(result.listenerCheck, 'unavailable');
    });

    it('when lsof cannot run, a cached scan still refuses a listener it saw', () => {
      portScanner._setLastScan([{ port: 3205, pid: 99, command: 'postgres' }]);
      portScanner._setExec(() => {
        const err = new Error('lsof failed');
        err.status = 127;
        err.stdout = '';
        err.stderr = 'boom';
        throw err;
      });
      const result = porthub.registerPort(3205, 'p', 'dev');
      assert.equal(result.code, 'PORT_IN_USE');
      assert.equal(result.listener.command, 'postgres');
    });

    it('returns the stored lease on success', () => {
      const result = porthub.registerPort(3206, 'p', 'dev', { permanent: false, autoRenew: true, reach: 'tailnet' });
      assert.equal(result.lease.port, 3206);
      assert.equal(result.lease.autoRenew, true);
      assert.equal(result.lease.reach, 'tailnet');
      assert.equal(result.lease.permanent, false);
    });

    it('bootstrap still records its own infra ports while they are listening', () => {
      portScanner._setExec((cmd) => {
        const port = Number(/-iTCP:(\d+)/.exec(cmd)[1]);
        // Every lsof call reports ttyd listening, so the socket-table fallback
        // is never reached here.
        return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nttyd 1 me 7u IPv4 0x1 0t0 TCP 127.0.0.1:${port} (LISTEN)`;
      });
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      assert.ok(store.portLeases.get(3100), 'ttyd lease recorded despite its listener');
      assert.ok(store.portLeases.get(3101), 'server lease recorded despite its listener');
    });
  });

  describe('bootstrap enrols Caddy in caddy mode only (#814)', () => {
    it('enrols both Caddy listeners as tailnet leases under its own name in caddy mode', () => {
      const config = store.config.load();
      config.ingressMode = 'caddy';
      config.caddyHttpsPort = 8443;
      config.caddyHttpPort = 8080;
      store.config.save(config);
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      const selfName = path.basename(path.resolve(__dirname, '..'));
      for (const [port, service] of [[8443, 'caddy-https-ingress'], [8080, 'caddy-http-ingress']]) {
        const lease = store.portLeases.get(port);
        assert.ok(lease, `${port} enrolled`);
        assert.equal(lease.project, selfName);
        assert.equal(lease.service, service);
        assert.equal(lease.permanent, true);
        assert.equal(lease.reach, 'tailnet');
      }
    });

    it('releases its own Caddy leases once the install is no longer in caddy mode', () => {
      const selfName = path.basename(path.resolve(__dirname, '..'));
      store.portLeases.lease({ port: 8443, project: selfName, service: 'caddy-https-ingress', permanent: true });
      store.portLeases.lease({ port: 8080, project: selfName, service: 'caddy-http-ingress', permanent: true });
      store.portLeases.lease({ port: 8444, project: 'WheresMy', service: 'caddy-https-ingress', permanent: true });
      // The boot sweep runs in the same bootstrap and would take WheresMy's
      // lease if its project directory were missing. Give it one inside this
      // test's own projectsDir, so what survives depends on the rule under test
      // and not on whether the developer's machine has a WheresMy checkout.
      fs.mkdirSync(path.join(tmpDir, 'WheresMy'));
      const config = store.config.load();
      config.ingressMode = 'direct';
      config.projectsDir = tmpDir;
      store.config.save(config);
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      assert.equal(store.portLeases.get(8443), null, 'Caddy is no longer running, so its port is free');
      assert.equal(store.portLeases.get(8080), null);
      assert.ok(store.portLeases.get(8444), "another project's lease is untouched, whatever its service name");
    });

    it('enrols nothing for Caddy in direct mode', () => {
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      assert.equal(store.portLeases.get(8443), null);
      assert.equal(store.portLeases.get(8080), null);
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

    it('records every lease the boot sweep displaced, and records it as a sweep', () => {
      porthub.registerPort(13401, 'deleted-project', 'dev-server');
      porthub.registerPort(13402, 'deleted-project', 'api');
      porthub.registerPort(13403, 'also-gone', 'dev-server');

      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      const swept = store.activity.query({ eventType: 'port.orphan_swept' });
      assert.deepEqual(
        swept.map(r => `${r.detail.project}:${r.detail.port}:${r.detail.service}`).sort(),
        ['also-gone:13403:dev-server', 'deleted-project:13401:dev-server', 'deleted-project:13402:api'],
        'the sweep deletes per lease, so it must report per lease'
      );
      assert.ok(swept.every(r => r.detail.host === 'localhost'));
      // Host and port are the lease's primary key; without both, the record
      // cannot identify what was displaced.
      assert.equal(
        store.activity.query({ eventType: 'port.released' }).length, 0,
        'a sweep must not leave rows claiming the owner released these ports'
      );
    });

    it('declines to sweep when the connection list cannot be read', () => {
      // The oc-direct-<id> identifiers are one of the three inputs that decide
      // "not an orphan". Lose them and every live tunnel lease looks orphaned,
      // so the sweep would delete the exact leases it exists to protect — and
      // the audit trail would name those ports as a correct-looking result.
      porthub.registerPort(13501, 'deleted-project', 'dev-server');

      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      const original = store.openclawConnections.list;
      store.openclawConnections.list = () => { throw new Error('database is locked'); };
      try {
        porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });
      } finally {
        store.openclawConnections.list = original;
      }

      assert.ok(
        store.portLeases.get(13501),
        'a lease survives a boot whose classifier lost an input — refusing to classify beats guessing in the deleting direction'
      );
      assert.equal(store.activity.query({ eventType: 'port.orphan_swept' }).length, 0);
    });

    it('writes nothing when the sweep displaces nothing', () => {
      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      assert.equal(store.activity.query({ eventType: 'port.orphan_swept' }).length, 0);
    });
  });

  describe('the boot sweep and non-project owners (#1381)', () => {
    it('leaves an external lease for a missing directory in place', () => {
      porthub.registerPort(5432, 'Homebrew', 'postgresql@14', { ownerKind: 'external' });
      porthub.registerPort(13501, 'deleted-project', 'dev-server');
      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      assert.ok(store.portLeases.get(5432), 'an owner that was never a project has no directory to find');
      assert.equal(store.portLeases.get(13501), null, 'a genuine orphan is still swept');
    });

    it('keeps the external leases of a name that also holds project leases', () => {
      porthub.registerPort(13601, 'mixed', 'db', { ownerKind: 'external' });
      porthub.registerPort(13602, 'mixed', 'dev');
      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);

      porthub.bootstrap({ ttydPort: 3100, serverPort: 3101 });

      assert.ok(store.portLeases.get(13601), 'the external lease survives');
      assert.equal(store.portLeases.get(13602), null, 'the project lease of the missing project is swept');
    });
  });

  describe('nextFreePort (#352)', () => {
    it('returns the first port in the range when nothing is taken', () => {
      assert.equal(porthub.nextFreePort({ range: [18789, 18999] }), 18789);
    });

    it('skips a lease-held port and returns the next free one', () => {
      porthub.registerPort(18789, 'other-project', 'openclaw-tunnel');
      assert.equal(porthub.nextFreePort({ range: [18789, 18999] }), 18790);
    });

    it('skips multiple consecutive lease-held ports', () => {
      porthub.registerPort(18789, 'a', 'svc');
      porthub.registerPort(18790, 'b', 'svc');
      porthub.registerPort(18791, 'c', 'svc');
      assert.equal(porthub.nextFreePort({ range: [18789, 18999] }), 18792);
    });

    it('skips an OS-bound port (system process) even when unleased', () => {
      // The machine is asked per port now, not the scan cache, so the stub
      // answers for lsof. afterEach's `_reset` restores the real runner.
      portScanner._setExec((cmd) => {
        if (cmd.includes('-iTCP:18789 ')) {
          return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nsomeproc 1234 me 7u IPv4 0x1 0t0 TCP *:18789 (LISTEN)';
        }
        const err = new Error('no listener');
        err.status = 1;
        err.stdout = '';
        err.stderr = '';
        throw err;
      });
      assert.equal(porthub.nextFreePort({ range: [18789, 18999] }), 18790);
    });

    it('asks the machine even when the scan cache is cold (#814)', () => {
      // A cold cache used to read as "free" for a port the machine was using.
      portScanner._setLastScan([]);
      portScanner._setExec((cmd) => {
        if (cmd.includes('-iTCP:18789 ')) {
          return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nsomeproc 1234 me 7u IPv4 0x1 0t0 TCP *:18789 (LISTEN)';
        }
        const err = new Error('no listener');
        err.status = 1;
        err.stdout = '';
        err.stderr = '';
        throw err;
      });
      const check = porthub.checkPort(18789);
      assert.equal(check.available, false);
      assert.equal(check.systemDetected, true);
      assert.equal(check.process, 'someproc');
    });

    it('respects the host scope — a lease on another host does not block', () => {
      porthub.registerPort(18789, 'remote-project', 'svc', { host: 'remote-box' });
      // localhost scan still sees 18789 as free
      assert.equal(porthub.nextFreePort({ range: [18789, 18999] }), 18789);
    });

    it('throws when the range holds no free port', () => {
      porthub.registerPort(18789, 'a', 'svc');
      porthub.registerPort(18790, 'b', 'svc');
      assert.throws(
        () => porthub.nextFreePort({ range: [18789, 18791] }),
        /No free port available/
      );
    });

    it('throws on a malformed range', () => {
      assert.throws(() => porthub.nextFreePort({ range: [18789] }), /integer range/);
      assert.throws(() => porthub.nextFreePort({ range: 'nope' }), /integer range/);
      assert.throws(() => porthub.nextFreePort({}), /integer range/);
    });
  });
});
