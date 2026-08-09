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
        tags: ['test']
      });

      assert.equal(status, 201);
      assert.equal(data.name, 'api-test-project');
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
      assert.ok(project.hasOwnProperty('actions'));
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
      assert.ok(Array.isArray(data.actions));
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

    // #103 chunk 2 — per-project silentPrime opt-in via PATCH
    it('persists silentPrime=true and surfaces it on the enriched response', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        silentPrime: true
      });
      assert.equal(status, 200);
      assert.equal(data.silentPrime, true);

      const { data: fetched } = await request('GET', '/api/projects/api-test-project');
      assert.equal(fetched.silentPrime, true);
    });

    it('rejects silentPrime with non-boolean value', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        silentPrime: 'yes'
      });
      assert.equal(status, 400);
      assert.ok(data.error.toLowerCase().includes('boolean'));
    });

    // #137 — PATCH must sync .claude/settings.json hooks immediately, not defer to next launch
    it('PATCH silentPrime=true writes SessionStart hook to .claude/settings.json on disk', async () => {
      // Use a dedicated project so we don't entangle with the existing api-test-project assertions
      await request('POST', '/api/projects', { name: 'sp-api-sync' });

      const { status } = await request('PATCH', '/api/projects/sp-api-sync', { silentPrime: true });
      assert.equal(status, 200);

      const settingsFile = path.join(projectsDir, 'sp-api-sync', '.claude', 'settings.json');
      assert.equal(fs.existsSync(settingsFile), true, 'settings.json should be written by PATCH');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(settings.hooks && settings.hooks.SessionStart, 'SessionStart hook should be present');
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.match(cmd, /"[^"]*\/data\/hooks\/sessionstart-prime\.sh"$/,
        'the command must be a QUOTED absolute path — an unquoted one breaks the moment the install path contains a space (#759)')
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
      await request('POST', '/api/projects', { name: 'to-api-delete' });

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
      await request('POST', '/api/projects', { name: 'no-pass-delete' });
      const { status, data } = await request('DELETE', '/api/projects/no-pass-delete', {});
      assert.equal(status, 200);
      assert.ok(data.ok);
    });
  });

  describe('GET /api/projects — a directory that never answers must not wedge the server (#883)', () => {
    const dirScanner = require('../lib/dir-scanner');
    const fsp = require('node:fs').promises;
    const { execFileSync } = require('node:child_process');

    it('survives more hung scans than the threadpool has threads', async () => {
      // THE WHOLE POINT, asserted through the real route rather than at the unit
      // level. Before #883 this route answered every request on time and lost a
      // libuv threadpool thread each time — four of them and the server could no
      // longer touch the filesystem AT ALL, on any path, while /api/health kept
      // returning 200. Every earlier test and every VRF row used a fresh process,
      // which is exactly how that survived six Critic rounds and 5,700 tests.
      //
      // The hang is produced by a fixture child blocking on a reader-less FIFO —
      // a real blocked syscall holding a real pool thread. A real `readdir` hang
      // needs TCC and cannot be reproduced on a CI runner (a FIFO answers
      // `readdir` with ENOTDIR in 0ms), so what this proves is the property that
      // matters here: hung scans, however induced, no longer cost THIS process
      // anything.
      const fifoDir = fs.mkdtempSync(path.join(tmpDir, 'fifo-'));
      const hungScanner = dirScanner.createScanner({
        childPath: path.join(__dirname, '_dir-scanner-hang-child.js'),
        timeoutMs: 300,
        exitGraceMs: 0
      });

      const poolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4;
      const attempts = poolSize + 1;
      const real = dirScanner.request;
      let n = 0;
      dirScanner.request = () => {
        const fifo = path.join(fifoDir, `pipe-${n++}`);
        execFileSync('mkfifo', [fifo]);
        return hungScanner.request('hang', { fifo });
      };

      try {
        for (let i = 0; i < attempts; i++) {
          const { status, data } = await request('GET', '/api/projects');
          // Degraded, not failed: registered projects come from SQLite and are
          // unaffected, so the dashboard still renders.
          assert.equal(status, 200, `request ${i + 1} of ${attempts} must still be answered`);
          assert.ok(Array.isArray(data.projects), 'must answer with a list, not an error');
        }
        assert.equal(n, attempts, 'the fixture must actually have reached the scanner each time');

        // The assertion #883 is about, and the reason it is RACED rather than
        // awaited: with the pool destroyed this readdir never resolves at all, so
        // awaiting it would hang the suite instead of failing it. Timers do not
        // use the threadpool, which is what makes the stuck case observable.
        // Verified by mutation — putting the hang back in this process makes this
        // line report, where a bare await simply never returned.
        const started = Date.now();
        const outcome = await Promise.race([
          fsp.readdir(tmpDir).then(() => 'ok', () => 'ok'),
          new Promise((resolve) => setTimeout(() => resolve('stuck'), 2000))
        ]);
        assert.equal(outcome, 'ok',
          `the server's own filesystem must still work after ${attempts} hung scans — `
          + 'an ordinary readdir on an unrelated path never completed, which is #883 exactly');
        assert.ok(Date.now() - started < 2000, 'and it must be prompt, not merely eventual');

        // And the route is genuinely healthy again, not merely returning cached
        // work: a normal request still answers once the scanner is restored.
        dirScanner.request = real;
        const { status } = await request('GET', '/api/projects');
        assert.equal(status, 200);
      } finally {
        dirScanner.request = real;
        await hungScanner.shutdown();
      }
    });
  });
});
