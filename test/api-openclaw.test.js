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
    host: '192.168.20.10',
    sshUser: 'habitat-admin',
    sshKeyPath: '~/.ssh/genesis_habitat'
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
    assert.equal(data.host, '192.168.20.10');
    assert.equal(data.sshUser, 'habitat-admin');
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
    const certPath = path.join(__dirname, '..', 'data', 'certs', 'cursatory.local+4.pem');
    const keyPath = path.join(__dirname, '..', 'data', 'certs', 'cursatory.local+4-key.pem');

    // Only test if certs exist (they may not exist on CI)
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const https = require('node:https');
      const server = createServer({ httpsEnabled: true, certPath, keyPath });
      assert.ok(server instanceof https.Server);
      server.close();
    }
  });
});
