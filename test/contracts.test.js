'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const store = require('../lib/store');
const { createServer } = require('../server');

let server;
let baseUrl;
let testDir;

/**
 * Make an HTTP request to the test server.
 * @param {string} urlPath
 * @param {object} [opts]
 * @returns {Promise<{status: number, data: object, headers: object}>}
 */
function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };

    const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
    if (bodyStr) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = null;
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('json') && body) {
          try { data = JSON.parse(body); } catch { data = body; }
        } else {
          data = body;
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Setup/Teardown ──

before(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-contracts-'));
  const projectsDir = path.join(testDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  store._setBasePath(path.join(testDir, 'tangleclaw'));
  store.init();
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.deletePassword = null;
  store.config.save(config);

  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ── Contract Validation Tests ──
// Covers: health, version, config GET/PATCH, system, engines list/detail,
// methodologies list/detail, projects CRUD, activity, error shapes.
// Session endpoints (POST/DELETE/status/command/wrap/peek/history) require
// active tmux sessions — contract shapes validated in test/api-sessions.test.js.
// Tmux mouse endpoints validated in test/api-system.test.js.

describe('API Contract Validation', () => {

  describe('GET /api/health — contract shape', () => {
    it('returns status, version, uptime, and services object', async () => {
      const res = await request('/api/health');
      assert.ok([200, 503].includes(res.status));
      assert.equal(typeof res.data.status, 'string');
      assert.ok(['ok', 'degraded'].includes(res.data.status));
      assert.equal(typeof res.data.version, 'string');
      assert.equal(typeof res.data.uptime, 'number');
      assert.equal(typeof res.data.services, 'object');
      assert.equal(typeof res.data.services.database, 'string');
      assert.equal(typeof res.data.services.ttyd, 'string');
      assert.equal(typeof res.data.services.tmux, 'string');
    });
  });

  describe('GET /api/version — contract shape', () => {
    it('returns object with version string', async () => {
      const res = await request('/api/version');
      assert.equal(res.status, 200);
      assert.equal(typeof res.data.version, 'string');
      assert.ok(res.data.version.length > 0);
    });
  });

  describe('GET /api/config — contract shape', () => {
    it('returns config with required fields and redacted password', async () => {
      const res = await request('/api/config');
      assert.equal(res.status, 200);
      assert.equal(typeof res.data.serverPort, 'number');
      assert.equal(typeof res.data.ttydPort, 'number');
      assert.equal(typeof res.data.projectsDir, 'string');
      assert.equal(typeof res.data.deleteProtected, 'boolean');
      // deletePassword must never be present
      assert.equal(res.data.deletePassword, undefined);
    });
  });

  describe('PATCH /api/config — contract shape', () => {
    it('returns ok, config object, and requiresRestart boolean', async () => {
      const res = await request('/api/config', {
        method: 'PATCH',
        body: { chimeEnabled: true }
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(typeof res.data.config, 'object');
      assert.equal(typeof res.data.requiresRestart, 'boolean');
      assert.equal(res.data.config.deletePassword, undefined);
      assert.equal(typeof res.data.config.deleteProtected, 'boolean');
    });
  });

  describe('GET /api/system — contract shape', () => {
    it('returns cpu, memory, disk, and uptime', async () => {
      const res = await request('/api/system');
      assert.equal(res.status, 200);
      // CPU
      assert.equal(typeof res.data.cpu, 'object');
      assert.equal(typeof res.data.cpu.cores, 'number');
      assert.equal(typeof res.data.cpu.usage, 'number');
      // Memory
      assert.equal(typeof res.data.memory, 'object');
      assert.equal(typeof res.data.memory.total, 'number');
      assert.equal(typeof res.data.memory.percent, 'number');
      // Disk
      assert.equal(typeof res.data.disk, 'object');
      assert.equal(typeof res.data.disk.total, 'number');
      assert.equal(typeof res.data.disk.percent, 'number');
      // Uptime
      assert.equal(typeof res.data.uptime, 'number');
    });
  });

  describe('GET /api/engines — contract shape', () => {
    it('returns engines array with id, name, available, interactionModel', async () => {
      const res = await request('/api/engines');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.engines));
      assert.ok(res.data.engines.length > 0);

      for (const engine of res.data.engines) {
        assert.equal(typeof engine.id, 'string');
        assert.equal(typeof engine.name, 'string');
        assert.equal(typeof engine.available, 'boolean');
        assert.equal(typeof engine.interactionModel, 'string');
      }
    });
  });

  describe('GET /api/engines/:id — contract shape', () => {
    it('returns full engine profile with capabilities', async () => {
      const listRes = await request('/api/engines');
      const engineId = listRes.data.engines[0].id;

      const res = await request(`/api/engines/${engineId}`);
      assert.equal(res.status, 200);
      assert.equal(typeof res.data.id, 'string');
      assert.equal(typeof res.data.name, 'string');
      assert.equal(typeof res.data.available, 'boolean');
      assert.equal(typeof res.data.capabilities, 'object');
    });

    it('returns 404 for unknown engine', async () => {
      const res = await request('/api/engines/nonexistent-engine');
      assert.equal(res.status, 404);
      assert.equal(typeof res.data.error, 'string');
      assert.equal(res.data.code, 'NOT_FOUND');
    });
  });

  describe('GET /api/methodologies — contract shape', () => {
    it('returns methodologies array with id, name, description', async () => {
      const res = await request('/api/methodologies');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.methodologies));
      assert.ok(res.data.methodologies.length > 0);

      for (const meth of res.data.methodologies) {
        assert.equal(typeof meth.id, 'string');
        assert.equal(typeof meth.name, 'string');
        assert.equal(typeof meth.description, 'string');
      }
    });
  });

  describe('GET /api/methodologies/:id — contract shape', () => {
    it('returns full methodology template', async () => {
      const listRes = await request('/api/methodologies');
      const methId = listRes.data.methodologies[0].id;

      const res = await request(`/api/methodologies/${methId}`);
      assert.equal(res.status, 200);
      assert.equal(typeof res.data.id, 'string');
      assert.equal(typeof res.data.name, 'string');
      assert.equal(typeof res.data.description, 'string');
    });

    it('returns 404 for unknown methodology', async () => {
      const res = await request('/api/methodologies/nonexistent');
      assert.equal(res.status, 404);
      assert.equal(res.data.code, 'NOT_FOUND');
    });
  });

  describe('Projects CRUD — contract shapes', () => {
    it('POST /api/projects returns id, name, path, createdAt', async () => {
      const res = await request('/api/projects', {
        method: 'POST',
        body: { name: 'contract-test', engine: 'claude-code', methodology: 'minimal' }
      });
      assert.equal(res.status, 201);
      assert.equal(typeof res.data.id, 'number');
      assert.equal(res.data.name, 'contract-test');
      assert.equal(typeof res.data.path, 'string');
      assert.equal(typeof res.data.createdAt, 'string');
    });

    it('GET /api/projects returns projects array', async () => {
      const res = await request('/api/projects');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.projects));
      assert.ok(res.data.projects.length > 0);

      const proj = res.data.projects[0];
      assert.equal(typeof proj.id, 'number');
      assert.equal(typeof proj.name, 'string');
      assert.ok(Array.isArray(proj.tags));
      assert.equal(typeof proj.createdAt, 'string');
    });

    it('GET /api/projects/:name returns enriched project', async () => {
      const res = await request('/api/projects/contract-test');
      assert.equal(res.status, 200);
      assert.equal(res.data.name, 'contract-test');
      assert.equal(typeof res.data.id, 'number');
      assert.equal(typeof res.data.path, 'string');
      // engine is object or null
      if (res.data.engine) {
        assert.equal(typeof res.data.engine, 'object');
        assert.equal(typeof res.data.engine.id, 'string');
        assert.equal(typeof res.data.engine.name, 'string');
      }
      // methodology is object or null
      if (res.data.methodology) {
        assert.equal(typeof res.data.methodology, 'object');
        assert.equal(typeof res.data.methodology.id, 'string');
      }
    });

    it('DELETE /api/projects/:name returns ok, name, filesDeleted', async () => {
      const res = await request('/api/projects/contract-test', {
        method: 'DELETE',
        body: { deleteFiles: false }
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.name, 'contract-test');
      assert.equal(typeof res.data.filesDeleted, 'boolean');
    });

    it('GET /api/projects/:name returns 404 after deletion', async () => {
      const res = await request('/api/projects/contract-test');
      assert.equal(res.status, 404);
      assert.equal(res.data.code, 'NOT_FOUND');
    });
  });

  describe('GET /api/activity — contract shape', () => {
    it('returns entries array', async () => {
      const res = await request('/api/activity');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.entries));
    });
  });

  describe('Error response — contract shape', () => {
    it('all error responses have error string and code string', async () => {
      // 404
      const res404 = await request('/api/projects/no-such-project');
      assert.equal(res404.status, 404);
      assert.equal(typeof res404.data.error, 'string');
      assert.equal(typeof res404.data.code, 'string');

      // Unknown route
      const resUnknown = await request('/api/totally-unknown');
      assert.equal(resUnknown.status, 404);
      assert.equal(typeof resUnknown.data.error, 'string');
      assert.equal(typeof resUnknown.data.code, 'string');

      // 400
      const res400 = await request('/api/projects', {
        method: 'POST',
        body: {}
      });
      assert.equal(res400.status, 400);
      assert.equal(typeof res400.data.error, 'string');
      assert.equal(typeof res400.data.code, 'string');
    });
  });
});
