'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const { createServer } = require('../server');

describe('api-projects', () => {
  let server;
  let port;
  let tmpDir;
  let projectsDir;

  /**
   * Make an HTTP request and return { status, data }.
   * @param {string} method
   * @param {string} urlPath
   * @param {object} [body]
   * @returns {Promise<{ status: number, data: object }>}
   */
  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json' }
      };

      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) {
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
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
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-projects-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    // Set projectsDir
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.deletePassword = null;
    store.config.save(config);

    server = createServer();
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/projects', () => {
    it('creates a project', async () => {
      const { status, data } = await request('POST', '/api/projects', {
        name: 'api-test-project',
        methodology: 'minimal',
        tags: ['test']
      });

      assert.equal(status, 201);
      assert.equal(data.name, 'api-test-project');
      assert.equal(data.methodology, 'minimal');
      assert.deepEqual(data.tags, ['test']);
      assert.ok(data.id);
      assert.ok(data.path);
      assert.ok(data.createdAt);
    });

    it('returns 400 for missing name', async () => {
      const { status, data } = await request('POST', '/api/projects', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('returns 400 for invalid name', async () => {
      const { status, data } = await request('POST', '/api/projects', {
        name: 'bad name!'
      });
      assert.equal(status, 400);
    });

    it('returns 409 for duplicate project', async () => {
      const { status, data } = await request('POST', '/api/projects', {
        name: 'api-test-project'
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'CONFLICT');
    });
  });

  describe('GET /api/projects', () => {
    it('lists projects', async () => {
      const { status, data } = await request('GET', '/api/projects');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.projects));
      assert.ok(data.projects.some((p) => p.name === 'api-test-project'));
    });

    it('returns enriched project data', async () => {
      const { data } = await request('GET', '/api/projects');
      const project = data.projects.find((p) => p.name === 'api-test-project');
      assert.ok(project);
      assert.ok(project.hasOwnProperty('engine'));
      assert.ok(project.hasOwnProperty('methodology'));
      assert.ok(project.hasOwnProperty('session'));
      assert.ok(project.hasOwnProperty('git'));
    });

    it('filters by tag', async () => {
      const { data } = await request('GET', '/api/projects?tag=test');
      assert.ok(data.projects.every((p) => p.tags.includes('test')));
    });
  });

  describe('GET /api/projects/:name', () => {
    it('returns project detail', async () => {
      const { status, data } = await request('GET', '/api/projects/api-test-project');
      assert.equal(status, 200);
      assert.equal(data.name, 'api-test-project');
      assert.ok(data.engine);
      assert.ok(data.methodology);
    });

    it('returns 404 for unknown project', async () => {
      const { status, data } = await request('GET', '/api/projects/nonexistent');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });
  });

  describe('PATCH /api/projects/:name', () => {
    it('updates tags', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        tags: ['updated', 'test']
      });
      assert.equal(status, 200);
      assert.deepEqual(data.tags, ['updated', 'test']);
    });

    it('rejects core rule disabling', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        rules: { core: { changelogPerChange: false } }
      });
      assert.equal(status, 400);
      assert.ok(data.error.includes('Core rules'));
    });

    it('updates extension rules', async () => {
      const { status } = await request('PATCH', '/api/projects/api-test-project', {
        rules: { extensions: { identitySentry: true } }
      });
      assert.equal(status, 200);
    });

    it('returns 404 for unknown project', async () => {
      const { status } = await request('PATCH', '/api/projects/nonexistent', {
        tags: []
      });
      assert.equal(status, 404);
    });
  });

  describe('DELETE /api/projects/:name', () => {
    it('requires password when configured', async () => {
      // Set a password
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('deleteme');
      store.config.save(config);

      const { status, data } = await request('DELETE', '/api/projects/api-test-project', {});
      assert.equal(status, 403);
      assert.equal(data.code, 'FORBIDDEN');
    });

    it('rejects incorrect password', async () => {
      const { status } = await request('DELETE', '/api/projects/api-test-project', {
        password: 'wrong'
      });
      assert.equal(status, 403);
    });

    it('deletes with correct password', async () => {
      // Create a project for deletion
      await request('POST', '/api/projects', { name: 'to-api-delete', methodology: 'minimal' });

      const { status, data } = await request('DELETE', '/api/projects/to-api-delete', {
        password: 'deleteme'
      });
      assert.equal(status, 200);
      assert.ok(data.ok);
      assert.equal(data.name, 'to-api-delete');
    });

    it('returns 404 for unknown project', async () => {
      // Clear password for simpler test
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const { status } = await request('DELETE', '/api/projects/nonexistent', {});
      assert.equal(status, 404);
    });

    it('deletes without password when not configured', async () => {
      await request('POST', '/api/projects', { name: 'no-pass-delete', methodology: 'minimal' });
      const { status, data } = await request('DELETE', '/api/projects/no-pass-delete', {});
      assert.equal(status, 200);
      assert.ok(data.ok);
    });
  });
});
