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
  let tempRulesPath;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-globalrules-'));
    store._setBasePath(tmpDir);
    store.init();
    // #240 — redirect canonical global-rules to tmp and seed with a
    // realistic baseline so GET returns something with "Global Rules"
    // in it (matching the public API contract).
    tempRulesPath = path.join(tmpDir, 'global-rules.md');
    fs.writeFileSync(tempRulesPath, '# Global Rules\n\n- Seed baseline for API test\n');
    store.globalRules._setBundledGlobalRulesPath(tempRulesPath);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.globalRules._resetBundledGlobalRulesPath();
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

  describe('POST /api/rules/global/reset (#240 no-op contract)', () => {
    it('returns current content unchanged — reset is a no-op under the canonical-source model', async () => {
      // Pre-#240 reset restored the per-install file from bundled
      // defaults. Under the canonical-source model the tracked file
      // IS canonical; reset returns current content + the route stays
      // for back-compat with the UI button (which should be removed
      // in a follow-up; today it just becomes a no-op refresh).
      const custom = '# Custom Pre-Reset\n\n- this should survive reset\n';
      await request(server, 'PUT', '/api/rules/global', { content: custom });

      const { status, data } = await request(server, 'POST', '/api/rules/global/reset');
      assert.equal(status, 200);
      assert.equal(data.content, custom,
        'reset returns current content unchanged (no-op)');

      // Verify the on-disk file was not modified
      const { data: loaded } = await request(server, 'GET', '/api/rules/global');
      assert.equal(loaded.content, custom,
        'reset did not modify the canonical file');
    });
  });

  describe('normalization on save (#100)', () => {
    it('strips trailing whitespace and uniform body indent on PUT round-trip', async () => {
      // Mirrors the live ~/.tangleclaw/global-rules.md pollution: H1 at col 0,
      // body uniformly indented 2 spaces, trailing whitespace per line.
      const dirty = '# Rules   \n\n  - one  \n  - two\t\n';
      const { status } = await request(server, 'PUT', '/api/rules/global', { content: dirty });
      assert.equal(status, 200);

      const { data } = await request(server, 'GET', '/api/rules/global');
      assert.equal(data.content, '# Rules\n\n- one\n- two\n');
    });
  });
});
