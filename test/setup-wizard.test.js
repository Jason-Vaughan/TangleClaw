'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer, _setCutoverSpawner } = require('../server');
const { installCaddyStub } = require('./_caddy-stub');
const { installAlwaysAvailableEngine } = require('./_engine-fixture');

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
  let caddyStub;
  let tmpDir;
  let server;
  let projectsDir;

  before(async () => {
    // Caddy must be PRESENT deterministically. detectCaddy() shells out to
    // `caddy version`, so without this the suite inherits the host's answer —
    // green on a dev Mac that has Caddy, 17 failures on CI that does not.
    caddyStub = installCaddyStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-setup-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir);

    store._setBasePath(tmpDir);
    // Setup refuses to finish with no engine installed, and the bundled
    // profiles detect real CLIs — so without this the result depends on
    // what the host has, passing on a dev Mac and failing on CI.
    installAlwaysAvailableEngine(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    caddyStub.restore();
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
    it('should accept setupComplete: true once a login exists', async () => {
      // This is the wizard's Skip path, and finishing setup through it now answers
      // to the same rule as /api/setup/complete: a machine that can run a login
      // gate must have a credential first (#710). Give the install one — the shape
      // any second run has — so this case keeps testing the field it is about.
      // The refusal itself is covered in test/auth2-setup-admin.test.js.
      const seeded = store.config.load();
      seeded.authEnabled = true;
      seeded.basicAuthUser = 'admin';
      seeded.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0';
      store.config.save(seeded);

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

  // TangleClaw's whole job is launching AI coding sessions. An install that
  // finishes with no engine is a dashboard that can launch nothing — the
  // operator reaches a finished-looking product and discovers the hole at the
  // first Launch button, with nothing on screen explaining it.
  describe('setup cannot finish with no engine installed', () => {
    // Resolved lazily: `tmpDir` is assigned in `before`, which runs after this
    // describe body is evaluated.
    const engineProfile = () => path.join(tmpDir, 'engines', 'test-engine.json');

    /**
     * Run `fn` on an install where nothing is detected as installed.
     *
     * EVERY profile has to go, not just the fixture: the bundled ones are
     * seeded into this store too, and they detect real CLIs — so on a machine
     * with Claude Code installed, removing only the fixture still leaves an
     * engine available and the gate correctly does not fire. Emptying the
     * directory makes the case reproduce the same way on any host.
     */
    async function withNoEngines(fn) {
      const dir = path.join(tmpDir, 'engines');
      const stash = path.join(tmpDir, 'engines-stashed');
      fs.renameSync(dir, stash);
      fs.mkdirSync(dir);
      const config = store.config.load();
      const savedComplete = config.setupComplete;
      config.setupComplete = false;
      store.config.save(config);
      try {
        await fn();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(stash, dir);
        const restore = store.config.load();
        restore.setupComplete = savedComplete;
        store.config.save(restore);
      }
    }

    it('refuses POST /api/setup/complete, naming what to do about it', async () => {
      await withNoEngines(async () => {
        const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
        assert.equal(status, 400);
        assert.equal(data.code, 'ENGINE_REQUIRED');
        assert.match(data.error, /Install one/, 'must say what to do, not only what is wrong');
        assert.equal(store.config.load().setupComplete, false,
          'a refused completion must not have half-finished setup');
      });
    });

    it('refuses the Skip path too — the button is not the rule', async () => {
      // #710 lived exactly here: /api/setup/complete got a new predicate and
      // PATCH /api/config { setupComplete: true } kept the old one, so Skip was
      // a door beside the gate. A rule enforced on one of these two is not
      // enforced.
      await withNoEngines(async () => {
        const { status, data } = await request(server, 'PATCH', '/api/config',
          { setupComplete: true });
        assert.equal(status, 400);
        assert.equal(data.code, 'ENGINE_REQUIRED');
        assert.equal(store.config.load().setupComplete, false);
      });
    });

    it('lets setup finish once an engine is there', async () => {
      // The other half of the gate: it has to OPEN. A refusal that never lifts
      // is the trap this whole slice exists to avoid.
      const config = store.config.load();
      config.setupComplete = false;
      config.authEnabled = true;
      config.basicAuthUser = 'admin';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0';
      store.config.save(config);

      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
      assert.equal(data.config.setupComplete, true);
    });

    it('does not refuse an already-finished install whose engine went away', async () => {
      // Uninstalling an engine later is a different problem, and refusing to
      // save settings over it would strand a working install.
      const enginePath = engineProfile();
      const saved = fs.readFileSync(enginePath, 'utf8');
      fs.unlinkSync(enginePath);
      const config = store.config.load();
      config.setupComplete = true;
      store.config.save(config);
      try {
        const { status } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
        assert.equal(status, 200, 'a finished install must stay settable');
      } finally {
        fs.writeFileSync(enginePath, saved);
      }
    });
  });

  describe('POST /api/setup/scan', () => {
    it('should return 400 when directory is missing', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/scan', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should return 400 for a blank directory rather than scanning the server itself', async () => {
      // path.resolve('') is the server's own working directory, so a blank
      // value is not "no value" — it is a scan of the install.
      const { status, data } = await request(server, 'POST', '/api/setup/scan', { directory: '   ' });
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

    // #859, second call site. On a stock macOS install the directory this route
    // scans is ~/Documents/Projects, which TCC blocks for a launchd-spawned
    // node with no Full Disk Access — and it blocks by never completing the
    // open(), not by returning EPERM. Read synchronously that stopped the event
    // loop, so one click on wizard step 2 killed every route in the process,
    // permanently, with launchd still reporting it healthy.
    it('keeps the event loop free and answers when the directory never responds', async () => {
      const blocked = path.join(tmpDir, 'blocked-projects');
      fs.mkdirSync(blocked, { recursive: true });

      const fsp = require('node:fs').promises;
      const realAsync = fsp.readdir;
      const realSync = fs.readdirSync;

      // Both shapes are stubbed on purpose. The async stub reproduces the real
      // failure (a read that neither resolves nor rejects); the SYNCHRONOUS one
      // is the mutation guard — revert this route to fs.readdirSync and the
      // spin below stalls the loop, which is what the assertions catch. Without
      // it, restoring the defect would leave this test green.
      fs.readdirSync = (p, o) => {
        if (String(p) === blocked) {
          const until = Date.now() + 3000;
          while (Date.now() < until) { /* the kernel, not returning */ }
          return [];
        }
        return realSync(p, o);
      };
      fsp.readdir = (p, o) => (String(p) === blocked ? new Promise(() => {}) : realAsync(p, o));

      try {
        const scan = request(server, 'POST', '/api/setup/scan', { directory: blocked });

        // A timer that fires on schedule is proof the loop stayed free while
        // the scan was outstanding — the property the whole fix is about, and
        // one no assertion about the response alone can establish.
        const timerSet = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const drift = Date.now() - timerSet;
        assert.ok(drift < 1500,
          `the scan must not block the event loop (200ms timer took ${drift}ms)`);

        const { status, data } = await scan;
        assert.equal(status, 400, 'the request must be answered, not left hanging');
        assert.equal(data.code, 'SCAN_FAILED');
        assert.match(data.error, /Full Disk Access/,
          'the operator must be told the remedy, not just that it failed');
      } finally {
        fs.readdirSync = realSync;
        fsp.readdir = realAsync;
      }
    });

      });

  describe('POST /api/setup/complete', () => {
    // TangleClaw now puts a login in front of itself as the default outcome of
    // setup, so completing it on a machine that can run one requires a
    // credential and starts an ingress cutover. These cases are about config,
    // projects and delete-protection rather than about the gate, so the machine
    // is given a credential up front — the shape a real second run has — and the
    // cutover is stubbed. Without the stub the real one would rewrite launchd
    // plists and restart the developer's live server; lib/ingress-provision.js
    // refuses that from a test process, which is why forgetting shows up as a
    // failure rather than an outage.
    let cutoverCalls;
    before(() => {
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'admin';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0';
      store.config.save(config);
      cutoverCalls = [];
      _setCutoverSpawner((opts) => { cutoverCalls.push(opts); return { ok: true, pid: 999, error: null }; });
    });

    it('starts the ingress cutover and reports the login as pending', async () => {
      await request(server, 'PATCH', '/api/config', { setupComplete: false });
      cutoverCalls.length = 0;

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir
      });

      assert.equal(status, 200);
      assert.equal(cutoverCalls.length, 1, 'a provisionable machine must start the cutover');
      assert.equal(cutoverCalls[0].target, 'caddy');
      assert.equal(data.ingress.action, 'provision');
      assert.equal(data.ingress.provisioning, true);
      assert.equal(data.ingress.protection, 'pending');
      assert.ok(data.ingress.url, 'the operator needs the address the gate will listen on');
    });

    it('suppresses the HTTPS restart while a cutover is running, so the two cannot race', async () => {
      await request(server, 'PATCH', '/api/config', { setupComplete: false });
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir,
        httpsEnabled: false,
        httpsCertPath: null,
        httpsKeyPath: null
      });
      assert.equal(status, 200);
      assert.equal(data.ingress.provisioning, true);
      assert.equal(data.restart, false, 'the cutover restarts the server as its own last step');
      assert.equal(data.redirectUrl, null);
    });

    it('should update config and set setupComplete', async () => {
      // Reset setupComplete to false first
      await request(server, 'PATCH', '/api/config', { setupComplete: false });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        projectsDir: projectsDir,
        defaultEngine: 'claude',
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
          { name: 'attach-test', path: projDir }
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
