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
 * @returns {Promise<{ status: number, data: object, headers: object }>}
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
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('OpenClaw UI contracts — connection list data shape', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-openclaw-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // Seed two connections
    await request(server, 'POST', '/api/openclaw/connections', {
      name: 'AlphaClaw',
      host: '10.0.0.1',
      sshUser: 'admin',
      sshKeyPath: '~/.ssh/id_rsa',
      port: 18789,
      cliCommand: 'openclaw-cli',
      localPort: 18789,
      availableAsEngine: true
    });
    await request(server, 'POST', '/api/openclaw/connections', {
      name: 'BetaClaw',
      host: '10.0.0.2',
      sshUser: 'user',
      sshKeyPath: '~/.ssh/beta_key',
      availableAsEngine: false
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list returns connections array with all fields the UI needs', async () => {
    const { status, data } = await request(server, 'GET', '/api/openclaw/connections');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.connections));
    assert.equal(data.connections.length, 2);

    const conn = data.connections.find(c => c.name === 'AlphaClaw');
    assert.ok(conn, 'AlphaClaw should be in the list');

    // All fields the UI panel renders
    assert.equal(typeof conn.id, 'string');
    assert.equal(typeof conn.name, 'string');
    assert.equal(typeof conn.host, 'string');
    assert.equal(typeof conn.port, 'number');
    assert.equal(typeof conn.sshUser, 'string');
    assert.equal(typeof conn.sshKeyPath, 'string');
    assert.equal(typeof conn.cliCommand, 'string');
    assert.equal(typeof conn.localPort, 'number');
    assert.equal(typeof conn.availableAsEngine, 'boolean');
  });

  it('individual connection GET returns same shape for modal population', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const id = list.data.connections[0].id;
    const { status, data } = await request(server, 'GET', `/api/openclaw/connections/${id}`);
    assert.equal(status, 200);

    // Modal reads these fields
    assert.ok(data.name);
    assert.ok(data.host);
    assert.ok(data.sshUser);
    assert.ok(data.sshKeyPath);
    assert.equal(typeof data.port, 'number');
    assert.equal(typeof data.localPort, 'number');
    assert.equal(typeof data.availableAsEngine, 'boolean');
  });

  it('availableAsEngine boolean survives round-trip', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const alpha = list.data.connections.find(c => c.name === 'AlphaClaw');
    const beta = list.data.connections.find(c => c.name === 'BetaClaw');
    assert.equal(alpha.availableAsEngine, true);
    assert.equal(beta.availableAsEngine, false);
  });

  it('update toggles availableAsEngine', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const beta = list.data.connections.find(c => c.name === 'BetaClaw');

    const { status, data } = await request(server, 'PUT', `/api/openclaw/connections/${beta.id}`, {
      availableAsEngine: true
    });
    assert.equal(status, 200);
    assert.equal(data.availableAsEngine, true);

    // Verify persisted
    const { data: fetched } = await request(server, 'GET', `/api/openclaw/connections/${beta.id}`);
    assert.equal(fetched.availableAsEngine, true);
  });

  it('create with all optional fields returns defaults', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/connections', {
      name: 'MinimalClaw',
      host: '10.0.0.3',
      sshUser: 'min',
      sshKeyPath: '/key'
    });
    assert.equal(status, 201);
    assert.equal(data.port, 18789);
    assert.equal(data.cliCommand, 'openclaw-cli');
    assert.equal(data.localPort, 18789);
    assert.equal(data.availableAsEngine, false);
  });

  it('delete removes connection from list', async () => {
    const list = await request(server, 'GET', '/api/openclaw/connections');
    const minimal = list.data.connections.find(c => c.name === 'MinimalClaw');
    assert.ok(minimal, 'MinimalClaw should exist');

    await request(server, 'DELETE', `/api/openclaw/connections/${minimal.id}`);

    const after = await request(server, 'GET', '/api/openclaw/connections');
    const found = after.data.connections.find(c => c.name === 'MinimalClaw');
    assert.equal(found, undefined, 'MinimalClaw should be gone');
  });

  it('static assets serve index.html for landing page', async () => {
    const { status, headers } = await request(server, 'GET', '/');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('html'));
  });

  it('static assets serve ui.js', async () => {
    const { status } = await request(server, 'GET', '/ui.js');
    assert.equal(status, 200);
  });

  it('static assets serve landing.js', async () => {
    const { status } = await request(server, 'GET', '/landing.js');
    assert.equal(status, 200);
  });
});

describe('OpenClaw UI contracts — test endpoint shape', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-openclaw-test-'));
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

  it('test endpoint returns ssh and gateway booleans for UI display', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/test', {
      host: '127.0.0.1',
      sshUser: 'nobody',
      sshKeyPath: '/nonexistent'
    });
    assert.equal(status, 200);
    assert.equal(typeof data.ssh, 'boolean');
    assert.equal(typeof data.gateway, 'boolean');
    assert.ok(Array.isArray(data.errors));
  });

  it('test endpoint validates required fields for UI error display', async () => {
    const { status, data } = await request(server, 'POST', '/api/openclaw/test', {});
    assert.equal(status, 400);
    assert.ok(data.error, 'should return error message for UI');
  });
});
