'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Test Helpers ──

const store = require('../lib/store');
const { createServer } = require('../server');

let server;
let baseUrl;
let testDir;

/**
 * Make an HTTP request to the test server.
 * @param {string} urlPath
 * @param {object} [opts]
 * @returns {Promise<{status: number, data: object}>}
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
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-integration-'));

  // Create a projects directory
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

// ── Tests ──

describe('Landing Page API Integration', () => {

  describe('Static file serving', () => {
    it('should serve index.html at /', async () => {
      const res = await request('/');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(typeof res.data === 'string');
      assert.ok(res.data.includes('TangleClaw'));
    });

    it('should serve style.css', async () => {
      const res = await request('/style.css');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/css'));
    });

    it('should serve landing.js', async () => {
      const res = await request('/landing.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
    });

    it('should serve ui.js', async () => {
      const res = await request('/ui.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
    });

    it('should serve manifest.json', async () => {
      const res = await request('/manifest.json');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('json'));
    });

    it('should serve sw.js', async () => {
      const res = await request('/sw.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
    });

    it('should serve index.html for SPA fallback routes', async () => {
      const res = await request('/session/test-project');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
    });
  });

  describe('GET /api/version', () => {
    it('should return version string', async () => {
      const res = await request('/api/version');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.version === 'string');
      assert.ok(res.data.version.length > 0);
    });
  });

  describe('GET /api/config', () => {
    it('should return config with expected shape', async () => {
      const res = await request('/api/config');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data === 'object');
      assert.ok('serverPort' in res.data);
      assert.ok('ttydPort' in res.data);
      assert.ok('projectsDir' in res.data);
      assert.ok('deleteProtected' in res.data);
      assert.ok(typeof res.data.deleteProtected === 'boolean');
      // deletePassword must not be present
      assert.equal(res.data.deletePassword, undefined);
    });
  });

  describe('GET /api/system', () => {
    it('should return system stats with expected shape', async () => {
      const res = await request('/api/system');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.cpu === 'object');
      assert.ok(typeof res.data.memory === 'object');
      assert.ok(typeof res.data.disk === 'object');
      assert.ok(typeof res.data.uptime === 'number');
      // CPU fields
      assert.ok('cores' in res.data.cpu);
      assert.ok('usage' in res.data.cpu);
      // Memory fields
      assert.ok('total' in res.data.memory);
      assert.ok('percent' in res.data.memory);
      // Disk fields
      assert.ok('total' in res.data.disk);
      assert.ok('percent' in res.data.disk);
    });
  });

  describe('GET /api/engines', () => {
    it('should return engines array with expected shape', async () => {
      const res = await request('/api/engines');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.engines));
      assert.ok(res.data.engines.length > 0, 'should have at least one engine');

      const engine = res.data.engines[0];
      assert.ok(typeof engine.id === 'string');
      assert.ok(typeof engine.name === 'string');
      assert.ok(typeof engine.available === 'boolean');
      assert.ok(typeof engine.interactionModel === 'string');
    });
  });

  describe('GET /api/methodologies', () => {
    it('should return methodologies array with expected shape', async () => {
      const res = await request('/api/methodologies');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.methodologies));
      assert.ok(res.data.methodologies.length > 0, 'should have at least one methodology');

      const meth = res.data.methodologies[0];
      assert.ok(typeof meth.id === 'string');
      assert.ok(typeof meth.name === 'string');
      assert.ok(typeof meth.description === 'string');
    });
  });

  describe('GET /api/projects', () => {
    it('should return projects array (may be empty)', async () => {
      const res = await request('/api/projects');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.projects));
    });
  });

  describe('POST /api/projects — create + verify shape', () => {
    it('should create a project and return expected fields', async () => {
      const res = await request('/api/projects', {
        method: 'POST',
        body: {
          name: 'integration-test-proj',
          engine: 'claude',
          methodology: 'minimal',
          tags: ['test']
        }
      });
      assert.equal(res.status, 201);
      assert.ok(typeof res.data.id === 'number');
      assert.equal(res.data.name, 'integration-test-proj');
      assert.ok(typeof res.data.path === 'string');
      assert.ok(typeof res.data.createdAt === 'string');
    });

    it('should list the created project with enriched fields', async () => {
      const res = await request('/api/projects');
      assert.equal(res.status, 200);
      const project = res.data.projects.find(p => p.name === 'integration-test-proj');
      assert.ok(project, 'created project should appear in list');
      assert.ok(typeof project.id === 'number');
      assert.ok(typeof project.name === 'string');
      // Engine and methodology should be enriched objects or null
      if (project.engine) {
        assert.ok(typeof project.engine === 'object');
        assert.ok('id' in project.engine);
        assert.ok('name' in project.engine);
      }
      if (project.methodology) {
        assert.ok(typeof project.methodology === 'object');
        assert.ok('id' in project.methodology);
      }
      // Tags
      assert.ok(Array.isArray(project.tags));
    });

    it('should get single project by name', async () => {
      const res = await request('/api/projects/integration-test-proj');
      assert.equal(res.status, 200);
      assert.equal(res.data.name, 'integration-test-proj');
    });

    it('should return 409 for duplicate project name', async () => {
      const res = await request('/api/projects', {
        method: 'POST',
        body: { name: 'integration-test-proj', engine: 'claude', methodology: 'minimal' }
      });
      assert.equal(res.status, 409);
      assert.ok(res.data.code === 'CONFLICT');
    });

    it('should return 400 for invalid project name', async () => {
      const res = await request('/api/projects', {
        method: 'POST',
        body: { name: 'has spaces', engine: 'claude' }
      });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/projects — response includes errors/warnings', () => {
    it('should return 201 with warnings array on partial success', async () => {
      // Create a project with valid methodology — should succeed
      const res = await request('/api/projects', {
        method: 'POST',
        body: { name: 'meth-warn-test', engine: 'claude', methodology: 'minimal' }
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.name, 'meth-warn-test');
      // warnings may or may not be present — key thing is the shape is valid
      if (res.data.warnings) {
        assert.ok(Array.isArray(res.data.warnings));
      }

      // Cleanup
      await request('/api/projects/meth-warn-test', { method: 'DELETE', body: { deleteFiles: true } });
    });
  });

  describe('PATCH /api/projects/:name', () => {
    it('should update project tags', async () => {
      const res = await request('/api/projects/integration-test-proj', {
        method: 'PATCH',
        body: { tags: ['updated', 'test'] }
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.tags));
      assert.ok(res.data.tags.includes('updated'));
    });
  });

  describe('DELETE /api/projects/:name', () => {
    it('should delete a project', async () => {
      const res = await request('/api/projects/integration-test-proj', {
        method: 'DELETE',
        body: { deleteFiles: false }
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.ok);
      assert.equal(res.data.name, 'integration-test-proj');
    });

    it('should return 404 for deleted project', async () => {
      const res = await request('/api/projects/integration-test-proj');
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/health', () => {
    it('should return health status with expected shape', async () => {
      const res = await request('/api/health');
      assert.ok([200, 503].includes(res.status));
      assert.ok(typeof res.data.status === 'string');
      assert.ok(typeof res.data.version === 'string');
      assert.ok(typeof res.data.uptime === 'number');
      assert.ok(typeof res.data.services === 'object');
      assert.ok('database' in res.data.services);
      assert.ok('ttyd' in res.data.services);
      assert.ok('tmux' in res.data.services);
    });
  });

  describe('GET /api/activity', () => {
    it('should return activity entries array', async () => {
      const res = await request('/api/activity');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.entries));
    });
  });

  describe('GET /api/projects — registered field', () => {
    it('projects should include registered field', async () => {
      // Create a project first
      await request('/api/projects', {
        method: 'POST',
        body: { name: 'reg-field-test', engine: 'claude', methodology: 'minimal' }
      });

      const res = await request('/api/projects');
      assert.equal(res.status, 200);
      const project = res.data.projects.find(p => p.name === 'reg-field-test');
      assert.ok(project);
      assert.equal(project.registered, true);

      // Cleanup
      await request('/api/projects/reg-field-test', { method: 'DELETE', body: { deleteFiles: true } });
    });

    it('unregistered filesystem dirs appear with registered: false', async () => {
      // Create a directory directly in the projects folder
      const config = store.config.load();
      const projectsDir = path.resolve(config.projectsDir);
      const unregDir = path.join(projectsDir, 'unreg-api-test');
      fs.mkdirSync(unregDir, { recursive: true });

      const res = await request('/api/projects');
      assert.equal(res.status, 200);
      const unreg = res.data.projects.find(p => p.name === 'unreg-api-test');
      assert.ok(unreg, 'unregistered dir should appear in project list');
      assert.equal(unreg.registered, false);

      // Cleanup
      fs.rmSync(unregDir, { recursive: true, force: true });
    });
  });

  describe('POST /api/projects/attach', () => {
    it('should attach an existing directory', async () => {
      const config = store.config.load();
      const projectsDir = path.resolve(config.projectsDir);
      const attachDir = path.join(projectsDir, 'attach-api-test');
      fs.mkdirSync(attachDir, { recursive: true });

      const res = await request('/api/projects/attach', {
        method: 'POST',
        body: { name: 'attach-api-test' }
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.name, 'attach-api-test');
      assert.equal(res.data.registered, true);

      // Cleanup
      await request('/api/projects/attach-api-test', { method: 'DELETE', body: { deleteFiles: true } });
    });

    it('should return 409 for already registered project', async () => {
      await request('/api/projects', {
        method: 'POST',
        body: { name: 'already-reg', engine: 'claude', methodology: 'minimal' }
      });

      const res = await request('/api/projects/attach', {
        method: 'POST',
        body: { name: 'already-reg' }
      });
      assert.equal(res.status, 409);

      // Cleanup
      await request('/api/projects/already-reg', { method: 'DELETE', body: { deleteFiles: true } });
    });

    it('should return 400 for non-existent directory', async () => {
      const res = await request('/api/projects/attach', {
        method: 'POST',
        body: { name: 'does-not-exist-xyz' }
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Error shapes', () => {
    it('should return standard error shape for 404', async () => {
      const res = await request('/api/projects/nonexistent-project');
      assert.equal(res.status, 404);
      assert.ok(typeof res.data.error === 'string');
      assert.equal(res.data.code, 'NOT_FOUND');
    });

    it('should return 404 for unknown API routes', async () => {
      const res = await request('/api/nonexistent');
      assert.equal(res.status, 404);
      assert.ok(typeof res.data.error === 'string');
      assert.ok(typeof res.data.code === 'string');
    });
  });
});
