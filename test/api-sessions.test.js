'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<{ status: number, body: object }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr != null) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);

    if (bodyStr != null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('api-sessions', () => {
  let tmpDir;
  let server;
  let projectsDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    // Create a test project
    const projDir = path.join(projectsDir, 'api-sess-test');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({
      name: 'api-sess-test',
      path: projDir,
      engine: 'claude',
      methodology: 'minimal'
    });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/sessions/:project/status', () => {
    it('returns inactive status when no session', async () => {
      const res = await request(server, 'GET', '/api/sessions/api-sess-test/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.active, false);
      assert.equal(res.body.project, 'api-sess-test');
    });

    it('returns 404 for unknown project', async () => {
      const res = await request(server, 'GET', '/api/sessions/nonexistent/status');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NOT_FOUND');
    });
  });

  describe('GET /api/sessions/:project/history', () => {
    it('returns empty history for new project', async () => {
      const res = await request(server, 'GET', '/api/sessions/api-sess-test/history');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.sessions));
      assert.equal(typeof res.body.total, 'number');
    });

    it('returns 404 for unknown project', async () => {
      const res = await request(server, 'GET', '/api/sessions/nonexistent/history');
      assert.equal(res.status, 404);
    });

    it('respects limit query param', async () => {
      // Create some sessions in the store directly
      const project = store.projects.getByName('api-sess-test');
      for (let i = 0; i < 3; i++) {
        const s = store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: `hist-${i}`
        });
        store.sessions.wrap(s.id, `Wrap ${i}`);
      }

      const res = await request(server, 'GET', '/api/sessions/api-sess-test/history?limit=2');
      assert.equal(res.status, 200);
      assert.equal(res.body.sessions.length, 2);
      assert.ok(res.body.total >= 3);
    });
  });

  describe('POST /api/sessions/:project/command', () => {
    it('returns 400 when command missing', async () => {
      const res = await request(server, 'POST', '/api/sessions/api-sess-test/command', {});
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'BAD_REQUEST');
    });

    it('returns 404 when no active session', async () => {
      const res = await request(server, 'POST', '/api/sessions/api-sess-test/command', {
        command: 'ls'
      });
      assert.equal(res.status, 404);
    });

    it('rejects commands exceeding 4096 characters', async () => {
      const res = await request(server, 'POST', '/api/sessions/api-sess-test/command', {
        command: 'x'.repeat(4097)
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('maximum length'));
    });
  });

  describe('POST /api/sessions/:project/wrap', () => {
    it('returns 404 when no active session', async () => {
      const res = await request(server, 'POST', '/api/sessions/api-sess-test/wrap', {});
      assert.equal(res.status, 404);
    });

    it('returns 403 when password required but missing', async () => {
      // Set a password
      const config = store.config.load();
      const crypto = require('node:crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('testpass', salt, 64).toString('hex');
      config.deletePassword = `${salt}:${hash}`;
      store.config.save(config);

      const res = await request(server, 'POST', '/api/sessions/api-sess-test/wrap', {});
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'FORBIDDEN');

      // Clean up password
      config.deletePassword = null;
      store.config.save(config);
    });
  });

  describe('GET /api/sessions/:project/peek', () => {
    it('returns 404 when no active session', async () => {
      const res = await request(server, 'GET', '/api/sessions/api-sess-test/peek');
      assert.equal(res.status, 404);
    });
  });

  describe('DELETE /api/sessions/:project', () => {
    it('returns 404 when no active session', async () => {
      const res = await request(server, 'DELETE', '/api/sessions/api-sess-test', {});
      assert.equal(res.status, 404);
    });

    it('returns 403 when password required but wrong', async () => {
      const config = store.config.load();
      const crypto = require('node:crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('secret', salt, 64).toString('hex');
      config.deletePassword = `${salt}:${hash}`;
      store.config.save(config);

      const res = await request(server, 'DELETE', '/api/sessions/api-sess-test', {
        password: 'wrong'
      });
      assert.equal(res.status, 403);

      config.deletePassword = null;
      store.config.save(config);
    });
  });

  describe('POST /api/sessions/:project (launch)', () => {
    it('returns 404 for unknown project', async () => {
      const res = await request(server, 'POST', '/api/sessions/nonexistent', {});
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/activity', () => {
    it('returns activity entries', async () => {
      const res = await request(server, 'GET', '/api/activity');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.entries));
    });

    it('filters by event type', async () => {
      const res = await request(server, 'GET', '/api/activity?type=session.wrapped');
      assert.equal(res.status, 200);
      for (const entry of res.body.entries) {
        assert.equal(entry.eventType, 'session.wrapped');
      }
    });

    it('respects limit', async () => {
      const res = await request(server, 'GET', '/api/activity?limit=2');
      assert.equal(res.status, 200);
      assert.ok(res.body.entries.length <= 2);
    });

    it('entries have expected fields', async () => {
      const res = await request(server, 'GET', '/api/activity?limit=1');
      if (res.body.entries.length > 0) {
        const entry = res.body.entries[0];
        assert.ok('id' in entry);
        assert.ok('eventType' in entry);
        assert.ok('createdAt' in entry);
        // projectName enrichment
        assert.ok('projectName' in entry);
      }
    });

    it('filters by project name', async () => {
      const res = await request(server, 'GET', '/api/activity?project=api-sess-test');
      assert.equal(res.status, 200);
      // All entries should be for this project
      for (const entry of res.body.entries) {
        if (entry.projectName) {
          assert.equal(entry.projectName, 'api-sess-test');
        }
      }
    });
  });
});
