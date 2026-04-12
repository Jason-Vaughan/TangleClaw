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

describe('Setup Wizard', () => {
  let tmpDir;
  let server;
  let projectsDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-setup-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir);

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

  describe('config setupComplete defaults', () => {
    it('fresh config should have setupComplete: false', () => {
      // Fresh install — DEFAULT_CONFIG has setupComplete: false
      // and the config file written by init() includes it
      const config = store.config.load();
      assert.equal(config.setupComplete, false);
    });

    it('existing config without setupComplete field should default to true', () => {
      // Simulate an existing install that predates the setupComplete field
      const configFile = path.join(tmpDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      delete config.setupComplete;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');

      const loaded = store.config.load();
      assert.equal(loaded.setupComplete, true);
    });

    it('config with setupComplete: false should remain false', () => {
      const configFile = path.join(tmpDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.setupComplete = false;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');

      const loaded = store.config.load();
      assert.equal(loaded.setupComplete, false);
    });
  });

  describe('GET /api/config includes setupComplete', () => {
    it('should include setupComplete in response', async () => {
      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(typeof data.setupComplete, 'boolean');
    });
  });

  describe('PATCH /api/config with setupComplete', () => {
    it('should accept setupComplete: true', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.setupComplete, true);
    });

    it('should reject non-boolean setupComplete', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: 'yes' });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });
  });

  describe('POST /api/setup/scan', () => {
    it('should return 400 when directory is missing', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/scan', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should return 400 for nonexistent directory', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: '/tmp/nonexistent-' + Date.now()
      });
      assert.equal(status, 400);
    });

    it('should return empty list for empty directory', async () => {
      const emptyDir = path.join(tmpDir, 'empty-projects');
      fs.mkdirSync(emptyDir);

      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: emptyDir
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.projects));
      assert.equal(data.projects.length, 0);
    });

    it('should detect projects with git repos', async () => {
      // Create a project directory with a git repo
      const projDir = path.join(projectsDir, 'test-git-project');
      fs.mkdirSync(projDir, { recursive: true });
      try {
        require('node:child_process').execSync('git init', {
          cwd: projDir,
          timeout: 5000,
          stdio: 'pipe'
        });
      } catch {
        // Git might not be available in test environment — skip
        return;
      }

      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: projectsDir
      });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.projects));

      const found = data.projects.find(p => p.name === 'test-git-project');
      assert.ok(found, 'Should find the git project');
      assert.ok(found.git, 'Should include git info');
      assert.equal(found.detected, true, 'Git project should be detected');
    });

    it('should include directories without markers as detected: false', async () => {
      const plainDir = path.join(projectsDir, 'test-plain-folder');
      fs.mkdirSync(plainDir, { recursive: true });

      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: projectsDir
      });
      assert.equal(status, 200);

      const found = data.projects.find(p => p.name === 'test-plain-folder');
      assert.ok(found, 'Should include the plain directory');
      assert.equal(found.detected, false, 'Should be marked as not detected');
    });

    it('should detect directories with common project markers', async () => {
      const pyDir = path.join(projectsDir, 'test-python-project');
      fs.mkdirSync(pyDir, { recursive: true });
      fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\nname = "test"\n');

      const goDir = path.join(projectsDir, 'test-go-project');
      fs.mkdirSync(goDir, { recursive: true });
      fs.writeFileSync(path.join(goDir, 'go.mod'), 'module example.com/test\n');

      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: projectsDir
      });
      assert.equal(status, 200);

      const pyFound = data.projects.find(p => p.name === 'test-python-project');
      assert.ok(pyFound, 'Should find the Python project');
      assert.equal(pyFound.detected, true, 'pyproject.toml should trigger detection');

      const goFound = data.projects.find(p => p.name === 'test-go-project');
      assert.ok(goFound, 'Should find the Go project');
      assert.equal(goFound.detected, true, 'go.mod should trigger detection');
    });

    it('should detect projects with methodology markers', async () => {
      // Create a project with a .prawduct directory
      const projDir = path.join(projectsDir, 'test-meth-project');
      fs.mkdirSync(path.join(projDir, '.prawduct'), { recursive: true });
      fs.writeFileSync(path.join(projDir, '.prawduct', 'project-state.yaml'), '# test\n');

      const { status, data } = await request(server, 'POST', '/api/setup/scan', {
        directory: projectsDir
      });
      assert.equal(status, 200);

      const found = data.projects.find(p => p.name === 'test-meth-project');
      assert.ok(found, 'Should find the methodology project');
      assert.equal(found.methodology, 'prawduct');
      assert.equal(found.detected, true, 'Methodology project should be detected');
    });
  });

  describe('POST /api/setup/complete', () => {
    it('should update config and set setupComplete', async () => {
      // Reset setupComplete to false first
      await request(server, 'PATCH', '/api/config', { setupComplete: false });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir,
        defaultEngine: 'claude',
        defaultMethodology: 'minimal',
        chimeEnabled: false
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.setupComplete, true);
      assert.ok(Array.isArray(data.attached));

      // Verify config was updated
      const config = store.config.load();
      assert.equal(config.setupComplete, true);
      assert.equal(config.projectsDir, projectsDir);
      assert.equal(config.chimeEnabled, false);
    });

    it('should work with no projects selected', async () => {
      await request(server, 'PATCH', '/api/config', { setupComplete: false });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.attached.length, 0);
    });

    it('should attach selected projects', async () => {
      // Ensure project dir exists
      const projDir = path.join(projectsDir, 'attach-test');
      fs.mkdirSync(projDir, { recursive: true });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir,
        projects: [
          { name: 'attach-test', path: projDir, methodology: 'minimal' }
        ]
      });

      assert.equal(status, 200);
      assert.ok(data.attached.includes('attach-test'), 'Should include attached project');

      // Verify project was registered
      const project = store.projects.getByName('attach-test');
      assert.ok(project, 'Project should exist in store');
      assert.equal(project.name, 'attach-test');
    });

    it('should skip already registered projects', async () => {
      // attach-test was already registered in the previous test
      const projDir = path.join(projectsDir, 'attach-test');

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projects: [
          { name: 'attach-test', path: projDir }
        ]
      });

      assert.equal(status, 200);
      assert.equal(data.attached.length, 0);
      assert.ok(data.warnings.length > 0, 'Should have a warning about duplicate');
    });

    it('should hash deletePassword when provided', async () => {
      const { status } = await request(server, 'POST', '/api/setup/complete', {
        deletePassword: 'testpass123'
      });

      assert.equal(status, 200);

      const config = store.config.load();
      assert.ok(config.deletePassword, 'Password should be set');
      assert.ok(config.deletePassword.includes(':'), 'Password should be hashed (salt:hash format)');
      assert.notEqual(config.deletePassword, 'testpass123', 'Password should not be stored in plaintext');
    });

    it('should return 400 for non-object body', async () => {
      const { status } = await request(server, 'POST', '/api/setup/complete', null);
      assert.equal(status, 400);
    });

    it('should skip projects with non-existent paths', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projects: [
          { name: 'phantom-proj', path: '/tmp/definitely-does-not-exist-' + Date.now() }
        ]
      });

      assert.equal(status, 200);
      assert.equal(data.attached.length, 0, 'Should not attach phantom project');
      assert.ok(data.warnings.some(w => w.includes('phantom-proj')), 'Should have warning about skipped project');

      // Verify it wasn't registered
      assert.equal(store.projects.getByName('phantom-proj'), null);
    });

    it('should handle duplicates gracefully in the same batch', async () => {
      const projDir = path.join(projectsDir, 'dup-batch-test');
      fs.mkdirSync(projDir, { recursive: true });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projects: [
          { name: 'dup-batch-test', path: projDir },
          { name: 'dup-batch-test', path: projDir }
        ]
      });

      assert.equal(status, 200);
      // First should succeed, second should be skipped
      assert.equal(data.attached.filter(n => n === 'dup-batch-test').length, 1);
      assert.ok(data.warnings.some(w => w.includes('already registered')));
    });
  });
});
