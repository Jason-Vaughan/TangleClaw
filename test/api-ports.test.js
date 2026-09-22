'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');
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

setLevel('error');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API /api/ports', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-ports-'));
    store._setBasePath(tmpDir);
    store.init();
    probeFindsNothing();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    portScanner._reset();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/ports returns expected shape with grouped leases', async () => {
    // Seed some leases
    store.portLeases.lease({ port: 3100, project: 'TangleClaw', service: 'ttyd', permanent: true });
    store.portLeases.lease({ port: 3101, project: 'TangleClaw', service: 'server', permanent: true });
    store.portLeases.lease({ port: 4000, project: 'OtherProj', service: 'dev' });

    const { status, data } = await request(server, 'GET', '/api/ports');
    assert.equal(status, 200);
    assert.equal(data.totalLeases, 3);
    assert.ok(Array.isArray(data.leases));
    assert.ok(data.grouped.TangleClaw);
    assert.equal(data.grouped.TangleClaw.length, 2);
    assert.ok(data.grouped.OtherProj);
    assert.equal(data.grouped.OtherProj.length, 1);
  });

  it('POST /api/ports/lease creates a lease', async () => {
    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5000,
      project: 'NewProject',
      service: 'api',
      permanent: true
    });
    assert.equal(status, 201);
    assert.equal(data.port, 5000);
    assert.equal(data.project, 'NewProject');
    assert.equal(data.service, 'api');
    assert.equal(data.permanent, true);
  });

  it('POST /api/ports/lease validates required fields', async () => {
    const { status } = await request(server, 'POST', '/api/ports/lease', { port: 5001 });
    assert.equal(status, 400);
  });

  // #1394 — the divergence check reads `reach` off the lease to tell a
  // deliberate exposure from an accidental one, so it has to survive the wire.
  it('POST /api/ports/lease round-trips reach, and GET reports it', async () => {
    const posted = await request(server, 'POST', '/api/ports/lease', {
      port: 5010, project: 'ReachProject', service: 'gui', reach: 'tailnet'
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.data.reach, 'tailnet');

    const listed = await request(server, 'GET', '/api/ports');
    const lease = listed.data.leases.find((l) => l.port === 5010);
    assert.equal(lease.reach, 'tailnet', 'the listing is where another process reads it');
  });

  it('POST /api/ports/lease defaults reach to loopback, the weakest claim', async () => {
    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5011, project: 'QuietProject', service: 'db'
    });
    assert.equal(status, 201);
    assert.equal(data.reach, 'loopback');
  });

  it('POST /api/ports/lease rejects an unknown reach with 400, naming the legal values', async () => {
    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5012, project: 'BadProject', service: 'x', reach: 'world'
    });
    assert.equal(status, 400);
    for (const reach of store.LEASE_REACHES) {
      assert.ok(data.error.includes(reach), `the 400 should name ${reach}`);
    }
  });

  // #613 — the API used to upsert unconditionally, so a lease request for a
  // port another project owned silently replaced the owner with a 201. The
  // documented contract said "never overwrite another project's lease"; it was
  // enforced only by client convention, and the convention failed live.
  it('POST /api/ports/lease returns 409 when another project owns the port', async () => {
    store.portLeases.lease({ port: 5100, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5100,
      project: 'Intruder',
      service: 'api'
    });

    assert.equal(status, 409, 'a taken port is a conflict, not a bad request');
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner', 'the response names the owner so the caller can choose another port');
    assert.equal(data.owner.service, 'dev-server');
    assert.equal(store.portLeases.get(5100).project, 'Owner', 'the owner keeps the lease');
  });

  it('POST /api/ports/lease renews the same project\'s own lease with 201', async () => {
    store.portLeases.lease({ port: 5101, project: 'Renewer', service: 'api' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5101,
      project: 'Renewer',
      service: 'api-v2'
    });

    assert.equal(status, 201, 'renewing your own lease is not a conflict');
    assert.equal(data.service, 'api-v2');
  });

  it('POST /api/ports/lease takes the port over when force is set', async () => {
    store.portLeases.lease({ port: 5102, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/lease', {
      port: 5102,
      project: 'Taker',
      service: 'api',
      force: true
    });

    assert.equal(status, 201);
    assert.equal(data.project, 'Taker');
  });

  it('POST /api/ports/release removes a lease', async () => {
    store.portLeases.lease({ port: 6000, project: 'ToRelease', service: 'temp' });

    const { status, data } = await request(server, 'POST', '/api/ports/release', { port: 6000 });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.port, 6000);

    assert.equal(store.portLeases.get(6000), null);
  });

  it('POST /api/ports/heartbeat updates a lease', async () => {
    store.portLeases.lease({ port: 7000, project: 'HB', service: 'dev', ttlMs: 60000 });

    const { status, data } = await request(server, 'POST', '/api/ports/heartbeat', { port: 7000 });
    assert.equal(status, 200);
    assert.equal(data.port, 7000);
    assert.ok(data.lastHeartbeat);
  });

  it('POST /api/ports/heartbeat returns 404 for unknown port', async () => {
    const { status } = await request(server, 'POST', '/api/ports/heartbeat', { port: 99999 });
    assert.equal(status, 404);
  });

  // #656 — release and heartbeat took only a port, so any caller could delete or
  // renew another project's lease. They now verify ownership when a project is named
  // (opt-in, so old {port}-only callers still work). A stray release is a silent
  // deletion, the wider hole than the lease overwrite #613 closed.
  it('POST /api/ports/release returns 409 when another project owns the live port', async () => {
    store.portLeases.lease({ port: 6100, project: 'Owner', service: 'dev-server' });

    const { status, data } = await request(server, 'POST', '/api/ports/release', {
      port: 6100,
      project: 'Intruder'
    });

    assert.equal(status, 409, 'releasing another project\'s live port is a conflict');
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner', 'the response names the owner');
    assert.ok(store.portLeases.get(6100), 'the owner keeps the lease after a refused release');
  });

  it('POST /api/ports/release with force removes another project\'s lease', async () => {
    store.portLeases.lease({ port: 6101, project: 'Owner', service: 'dev-server' });

    const { status } = await request(server, 'POST', '/api/ports/release', {
      port: 6101, project: 'Taker', force: true
    });

    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6101), null);
  });

  it('POST /api/ports/release with the owning project succeeds', async () => {
    store.portLeases.lease({ port: 6102, project: 'Mine', service: 'temp' });

    const { status } = await request(server, 'POST', '/api/ports/release', {
      port: 6102, project: 'Mine'
    });

    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6102), null);
  });

  it('POST /api/ports/release with no project still deletes (backward compat)', async () => {
    store.portLeases.lease({ port: 6103, project: 'Whoever', service: 'temp' });

    const { status } = await request(server, 'POST', '/api/ports/release', { port: 6103 });
    assert.equal(status, 200);
    assert.equal(store.portLeases.get(6103), null);
  });

  it('POST /api/ports/heartbeat returns 409 when another project owns the lease', async () => {
    store.portLeases.lease({ port: 7100, project: 'Owner', service: 'dev', ttlMs: 60000 });

    const { status, data } = await request(server, 'POST', '/api/ports/heartbeat', {
      port: 7100, project: 'Intruder'
    });

    assert.equal(status, 409);
    assert.equal(data.code, 'PORT_CONFLICT');
    assert.equal(data.owner.project, 'Owner');
  });
  describe('the lease route asks the machine (#814)', () => {
    /** Make lsof report `command` listening on `port`; anything else is free. */
    function probeFinds(port, command) {
      portScanner._setExec((cmd) => {
        if (cmd.includes(`-iTCP:${port} `)) {
          return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n${command} 4242 me 7u IPv6 0x1 0t0 TCP *:${port} (LISTEN)`;
        }
        const err = new Error('no listener');
        err.status = 1;
        err.stdout = '';
        err.stderr = '';
        throw err;
      });
    }

    after(() => probeFindsNothing());

    it('answers 409 PORT_IN_USE naming the listener, and stores nothing', async () => {
      probeFinds(7443, 'caddy');
      const { status, data } = await request(server, 'POST', '/api/ports/lease', {
        port: 7443, project: 'WheresMy', service: 'preview'
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'PORT_IN_USE');
      assert.deepEqual(data.listener, { port: 7443, pid: 4242, command: 'caddy' });
      assert.equal(store.portLeases.get(7443), null);
    });

    it('grants it with adoptListener and reports listenerCheck', async () => {
      probeFinds(7444, 'node');
      const { status, data } = await request(server, 'POST', '/api/ports/lease', {
        port: 7444, project: 'Mine', service: 'dev', adoptListener: true
      });
      assert.equal(status, 201);
      assert.equal(data.listenerCheck, 'adopted');
      assert.equal(data.project, 'Mine');
    });

    it('probes a port sent as a string, rather than granting it unchecked', async () => {
      probeFinds(7448, 'caddy');
      const { status, data } = await request(server, 'POST', '/api/ports/lease', {
        port: '7448', project: 'P', service: 'dev'
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'PORT_IN_USE');
      assert.equal(store.portLeases.get(7448), null);
    });

    it('rejects a port that is not an integer in range', async () => {
      for (const port of ['abc', 70000, 3.5]) {
        const { status, data } = await request(server, 'POST', '/api/ports/lease', { port, project: 'P', service: 's' });
        assert.equal(status, 400, `port ${JSON.stringify(port)}`);
        assert.equal(data.code, 'BAD_REQUEST');
      }
    });

    it('keeps the HTTP default of a non-permanent lease', async () => {
      probeFindsNothing();
      const { status, data } = await request(server, 'POST', '/api/ports/lease', {
        port: 7445, project: 'P', service: 'dev', ttl: 60000
      });
      assert.equal(status, 201);
      assert.equal(data.permanent, false);
      assert.equal(data.listenerCheck, 'clear');
      assert.ok(data.expiresAt, 'a ttl lease still gets its expiry');
    });

    it('passes ownerKind through and rejects an unknown one as 400', async () => {
      probeFindsNothing();
      const ok = await request(server, 'POST', '/api/ports/lease', {
        port: 7446, project: 'Homebrew', service: 'postgres', ownerKind: 'external'
      });
      assert.equal(ok.status, 201);
      assert.equal(ok.data.ownerKind, 'external');
      const bad = await request(server, 'POST', '/api/ports/lease', {
        port: 7447, project: 'P', service: 's', ownerKind: 'daemon'
      });
      assert.equal(bad.status, 400);
    });

    it('GET /api/ports lists unleased listeners with pid and command', async () => {
      portScanner._setLastScan([
        { port: 7450, pid: 11, command: 'postgres' },
        { port: 7446, pid: 12, command: 'postgres' }
      ]);
      const { data } = await request(server, 'GET', '/api/ports');
      assert.deepEqual(data.systemPorts, [{ port: 7450, pid: 11, command: 'postgres' }],
        'a leased port is not listed as unleased');
      assert.equal(data.systemPortCount, 1);
      portScanner._setLastScan([]);
    });
  });

  describe('a host-less release is refused when another host holds the port (#853)', () => {
    it('answers 400 HOST_REQUIRED naming the host, and deletes nothing', async () => {
      store.portLeases.lease({ port: 7460, project: 'Medusa', service: 'a2a', permanent: true });
      store.portLeases.lease({ port: 7460, host: 'habitat', project: 'RentalClaw', service: 'tools', permanent: true });
      const { status, data } = await request(server, 'POST', '/api/ports/release', { port: 7460 });
      assert.equal(status, 400);
      assert.equal(data.code, 'HOST_REQUIRED');
      assert.match(data.error, /habitat/);
      assert.ok(store.portLeases.get(7460), "localhost's lease survives");
      assert.ok(store.portLeases.get(7460, 'habitat'), "habitat's lease survives");
    });

    it('an explicit host releases exactly that lease', async () => {
      const { status } = await request(server, 'POST', '/api/ports/release', { port: 7460, host: 'localhost' });
      assert.equal(status, 200);
      assert.equal(store.portLeases.get(7460), null);
      assert.ok(store.portLeases.get(7460, 'habitat'));
    });

    it('a host-less release of a localhost-only port still works', async () => {
      store.portLeases.lease({ port: 7461, project: 'P', service: 's' });
      const { status } = await request(server, 'POST', '/api/ports/release', { port: 7461 });
      assert.equal(status, 200);
      assert.equal(store.portLeases.get(7461), null);
    });
  });

  describe('non-project owners (#1381)', () => {
    it('POST /api/ports/owner-kind marks every lease of a name external', async () => {
      store.portLeases.lease({ port: 7470, project: 'Brew', service: 'postgres', permanent: true });
      store.portLeases.lease({ port: 7471, project: 'Brew', service: 'redis', permanent: true });
      const { status, data } = await request(server, 'POST', '/api/ports/owner-kind', {
        project: 'Brew', ownerKind: 'external'
      });
      assert.equal(status, 200);
      assert.equal(data.updated, 2);
      assert.equal(store.portLeases.get(7470).ownerKind, 'external');
      assert.equal(store.portLeases.get(7471).ownerKind, 'external');
    });

    it('owner-kind answers 404 for a name with no leases, 400 for a bad kind or missing field', async () => {
      assert.equal((await request(server, 'POST', '/api/ports/owner-kind', { project: 'Nobody', ownerKind: 'external' })).status, 404);
      assert.equal((await request(server, 'POST', '/api/ports/owner-kind', { project: 'Brew', ownerKind: 'daemon' })).status, 400);
      assert.equal((await request(server, 'POST', '/api/ports/owner-kind', { ownerKind: 'external' })).status, 400);
    });

    it('import with a missing directory releases nothing and says the leases were kept', async () => {
      const config = store.config.load();
      config.projectsDir = tmpDir;
      store.config.save(config);
      store.portLeases.lease({ port: 7480, project: 'Homebrew', service: 'postgresql@14', permanent: true });
      const { status, data } = await request(server, 'POST', '/api/projects/import', { names: ['Homebrew'] });
      assert.equal(status, 200);
      assert.deepEqual(data.imported, []);
      assert.ok(store.portLeases.get(7480), 'import must not delete a lease it cannot classify');
      assert.match(data.warnings[0], /left in place/);
      assert.match(data.warnings[0], /Not a project/);
    });
  });
});
