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

describe('API /api/rules/global', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-globalrules-'));
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

  describe('GET /api/rules/global', () => {
    it('should return default global rules content', async () => {
      const { status, data } = await request(server, 'GET', '/api/rules/global');
      assert.equal(status, 200);
      assert.ok(typeof data.content === 'string');
      assert.ok(data.content.includes('Global Rules'));
    });
  });

  describe('PUT /api/rules/global', () => {
    it('should save custom rules', async () => {
      const custom = '# My Rules\n\n- Be excellent\n';
      const { status, data } = await request(server, 'PUT', '/api/rules/global', { content: custom });
      assert.equal(status, 200);
      assert.ok(data.ok);

      // Verify persisted
      const { data: loaded } = await request(server, 'GET', '/api/rules/global');
      assert.equal(loaded.content, custom);
    });

    it('should reject missing content', async () => {
      const { status } = await request(server, 'PUT', '/api/rules/global', {});
      assert.equal(status, 400);
    });

    it('should accept empty string content', async () => {
      const { status, data } = await request(server, 'PUT', '/api/rules/global', { content: '' });
      assert.equal(status, 200);
      assert.ok(data.ok);
    });
  });

  describe('POST /api/rules/global/reset', () => {
    it('should reset to bundled defaults', async () => {
      // Save custom first
      await request(server, 'PUT', '/api/rules/global', { content: '# Custom' });

      const { status, data } = await request(server, 'POST', '/api/rules/global/reset');
      assert.equal(status, 200);
      assert.ok(data.content.includes('Global Rules'), 'Should return default content');

      // Verify persisted
      const { data: loaded } = await request(server, 'GET', '/api/rules/global');
      assert.equal(loaded.content, data.content);
    });
  });
});
