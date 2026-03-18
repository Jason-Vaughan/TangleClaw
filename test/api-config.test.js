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
 * @param {string} path
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

describe('API endpoints', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-'));
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

  describe('GET /api/health', () => {
    it('should return 200 with service status', async () => {
      const { status, data } = await request(server, 'GET', '/api/health');
      assert.equal(status, 200);
      assert.ok(data.status, 'Should have status field');
      assert.ok(data.version, 'Should have version field');
      assert.equal(typeof data.uptime, 'number');
      assert.ok(data.services, 'Should have services object');
      assert.equal(data.services.database, 'ok');
    });

    it('should include tmux status', async () => {
      const { data } = await request(server, 'GET', '/api/health');
      assert.ok(['ok', 'unavailable'].includes(data.services.tmux));
    });
  });

  describe('GET /api/version', () => {
    it('should return version', async () => {
      const { status, data } = await request(server, 'GET', '/api/version');
      assert.equal(status, 200);
      assert.equal(data.version, '3.0.0');
    });
  });

  describe('GET /api/config', () => {
    it('should return config with password redacted', async () => {
      // Set a password first
      const config = store.config.load();
      config.deletePassword = 'secret';
      store.config.save(config);

      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(data.serverPort, 3101);
      assert.equal(data.deleteProtected, true);
      assert.equal(data.deletePassword, undefined, 'Password should not be exposed');
    });

    it('should return deleteProtected false when no password', async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should include all expected fields', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(typeof data.serverPort, 'number');
      assert.equal(typeof data.ttydPort, 'number');
      assert.equal(typeof data.defaultEngine, 'string');
      assert.equal(typeof data.defaultMethodology, 'string');
      assert.ok(Array.isArray(data.quickCommands));
      assert.equal(typeof data.theme, 'string');
      assert.equal(typeof data.chimeEnabled, 'boolean');
      assert.equal(typeof data.chimeMuted, 'boolean');
      assert.equal(typeof data.portScannerEnabled, 'boolean');
      assert.equal(typeof data.portScannerIntervalMs, 'number');
    });
  });

  describe('PATCH /api/config', () => {
    it('should update config fields', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'light',
        chimeEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.theme, 'light');
      assert.equal(data.config.chimeEnabled, false);
    });

    it('should set requiresRestart when port changes', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 9999
      });
      assert.equal(data.requiresRestart, true);

      // Reset port
      await request(server, 'PATCH', '/api/config', { serverPort: 3101 });
    });

    it('should reject invalid theme', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'neon'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject invalid peekMode', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        peekMode: 'popup'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric port', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 'abc'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should redact password in response', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        deletePassword: 'newsecret'
      });
      assert.equal(data.config.deleteProtected, true);
      assert.equal(data.config.deletePassword, undefined);
    });

    it('should hash password before persisting', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: 'hashme'
      });
      const config = store.config.load();
      assert.ok(config.deletePassword.includes(':'), 'Password should be stored as salt:hash');
      assert.notEqual(config.deletePassword, 'hashme', 'Password should not be stored in plaintext');
    });

    it('should allow clearing password with null', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: null
      });
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should reject empty body', async () => {
      const { status } = await request(server, 'PATCH', '/api/config');
      assert.equal(status, 400);
    });

    it('should accept chimeMuted boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: true
      });
      assert.equal(status, 200);
      assert.equal(data.config.chimeMuted, true);
    });

    it('should reject non-boolean chimeMuted', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: 'yes'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept portScannerEnabled boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerEnabled, false);
    });

    it('should reject non-boolean portScannerEnabled', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: 1
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept valid portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 30000
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerIntervalMs, 30000);
    });

    it('should reject portScannerIntervalMs below minimum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 5000
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject portScannerIntervalMs above maximum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 999999
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 'fast'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });
  });

  describe('config migration defaults', () => {
    it('should default chimeMuted to false for existing configs', async () => {
      const config = store.config.load();
      delete config.chimeMuted;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.chimeMuted, false);
    });

    it('should default portScannerEnabled to true for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerEnabled;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerEnabled, true);
    });

    it('should default portScannerIntervalMs to 60000 for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerIntervalMs;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerIntervalMs, 60000);
    });
  });

  describe('error handling', () => {
    it('should return 404 for unknown API routes', async () => {
      const { status, data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should return standard error format', async () => {
      const { data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(typeof data.error, 'string');
      assert.equal(typeof data.code, 'string');
    });

    it('should reject oversized bodies', async () => {
      const largeBody = { data: 'x'.repeat(11 * 1024) };
      const { status, data } = await request(server, 'PATCH', '/api/config', largeBody);
      assert.equal(status, 413);
      assert.equal(data.code, 'BODY_TOO_LARGE');
    });
  });
});
