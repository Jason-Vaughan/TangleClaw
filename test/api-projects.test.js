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
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

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
   * @param {Record<string, string>} [headers] - Which caller the request plays
   * @returns {Promise<{ status: number, data: object }>}
   */
  function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', ...headers }
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

  /** @returns {Record<string, string>} Headers that make a request the operator's dashboard */
  const asOperator = () => operatorHeaders(server);

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

    it('returns enriched project data to the operator', async () => {
      const { data } = await request('GET', '/api/projects', null, asOperator());
      const project = data.projects.find((p) => p.name === 'api-test-project');
      assert.ok(project);
      assert.ok(project.hasOwnProperty('engine'));
      assert.ok(project.hasOwnProperty('actions'));
      assert.ok(project.hasOwnProperty('session'));
      assert.ok(project.hasOwnProperty('git'));
    });

    it('says whether the list is the whole list (#885)', async () => {
      // THE MUTATION THIS CATCHES: dropping `scan` from the route body. The list
      // degrades to registered projects when the projects directory cannot be
      // read, and a 200 with a well-formed array looks identical either way —
      // which is the entire defect. The field has to cross the boundary, not
      // just exist inside `listAllProjects`.
      const { status, data } = await request('GET', '/api/projects', null, asOperator());

      assert.equal(status, 200);
      assert.ok(data.scan, 'the response must carry the scan state');
      assert.equal(typeof data.scan.complete, 'boolean');
      assert.ok('code' in data.scan && 'reason' in data.scan && 'hint' in data.scan,
        'always present, null when healthy — a consumer reads these, never probes for them');
      assert.ok(data.scan.dir, 'and names the directory it is talking about');
    });

    it('filters by tag', async () => {
      const { data } = await request('GET', '/api/projects?tag=test');
      assert.ok(data.projects.every((p) => p.tags.includes('test')));
    });
  });

  describe('GET /api/projects/:name', () => {
    it('returns project detail to the operator', async () => {
      const { status, data } = await request('GET', '/api/projects/api-test-project', null, asOperator());
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

    // The route picks its status by SEARCHING the first error for `not found`
    // (server.js), so the code a client sees is decided by prose the validator
    // happened to write. These record what that produces today rather than
    // endorsing it: an engine typo answers 404 on a route whose 404 otherwise
    // means the PROJECT is gone, so a client branching on status reports
    // "project not found" for a misspelled engine. #1288 carries the fix; the
    // pin exists because the contract artifact described this wrong until a
    // review checked it against the route, and only a route-level test can.
    it('answers 400 for a field the validator refuses on shape', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        featureIndexEnabled: 'not-a-boolean'
      });
      assert.equal(status, 400);
      assert.ok(data.error.includes('featureIndexEnabled'));
    });

    it('answers 404 — not 400 — for an unknown engine, because the message says "not found"', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        engine: 'no-such-engine'
      });
      assert.equal(status, 404, 'today\'s behavior, tracked as wrong in #1288');
      assert.ok(data.error.includes('Engine "no-such-engine" not found'));
    });

    // #1148 — a rename's after-the-fact warning (a LaunchAgent still naming
    // the old path) must reach the wire on the same `warnings` field the
    // dashboard already reads for partial failures, with the rename still 200.
    it('carries a rename\'s LaunchAgent warning on the response warnings field', async () => {
      const launchAgentScan = require('../lib/launchagent-scan');
      const laDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-la-'));
      const realDir = launchAgentScan.defaultLaunchAgentsDir;
      launchAgentScan.defaultLaunchAgentsDir = () => laDir;
      try {
        projects.createProject({ name: 'api-la-src', gitInit: false });
        const oldPath = store.projects.getByName('api-la-src').path;
        fs.writeFileSync(path.join(laDir, 'com.example.sync.plist'),
          `<plist version="1.0"><dict><key>Label</key><string>com.example.sync</string>`
          + `<key>WorkingDirectory</key><string>${oldPath}</string></dict></plist>\n`);

        const { status, data } = await request('PATCH', '/api/projects/api-la-src', { name: 'api-la-dst' });
        assert.equal(status, 200);
        assert.equal(data.name, 'api-la-dst');
        assert.equal(Array.isArray(data.warnings) && data.warnings.length, 1, 'exactly one warning on the wire');
        assert.match(data.warnings[0], /1 LaunchAgent still references the old path /);
        assert.match(data.warnings[0], /com\.example\.sync/);
      } finally {
        launchAgentScan.defaultLaunchAgentsDir = realDir;
        fs.rmSync(laDir, { recursive: true, force: true });
      }
    });

    // #103 chunk 2 — per-project silentPrime opt-in via PATCH
    it('persists silentPrime=true and surfaces it on the enriched response', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        silentPrime: true
      });
      assert.equal(status, 200);
      assert.equal(data.silentPrime, true);

      const { data: fetched } = await request('GET', '/api/projects/api-test-project', null, asOperator());
      assert.equal(fetched.silentPrime, true);
    });

    it('rejects silentPrime with non-boolean value', async () => {
      const { status, data } = await request('PATCH', '/api/projects/api-test-project', {
        silentPrime: 'yes'
      });
      assert.equal(status, 400);
      assert.ok(data.error.toLowerCase().includes('boolean'));
    });

    // #137 — PATCH must sync the hooks immediately, not defer to next launch.
    // The target is `.claude/settings.local.json`: the command is an absolute path to
    // this machine's install, which is valid nowhere else, so it must not land in the
    // shared, committable file (#1022).
    it('PATCH silentPrime=true writes SessionStart hook to .claude/settings.local.json on disk', async () => {
      // Use a dedicated project so we don't entangle with the existing api-test-project assertions
      await request('POST', '/api/projects', { name: 'sp-api-sync' });

      const { status } = await request('PATCH', '/api/projects/sp-api-sync', { silentPrime: true });
      assert.equal(status, 200);

      const claudeDir = path.join(projectsDir, 'sp-api-sync', '.claude');
      const settingsFile = path.join(claudeDir, 'settings.local.json');
      assert.equal(fs.existsSync(settingsFile), true, 'settings.local.json should be written by PATCH');
      assert.equal(fs.existsSync(path.join(claudeDir, 'settings.json')), false,
        'the shared, committable file must not receive a machine-absolute hook path (#1022)');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      assert.ok(settings.hooks && settings.hooks.SessionStart, 'SessionStart hook should be present');
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      // Quoting is no longer asserted by shape here: a `/^"/` match is true of
      // `"$HOME/x"`, which still expands. `test/engines-hook-shell-safety.test.js`
      // proves the real property by running each emitted command through `/bin/sh`.
      assert.match(cmd, /\/data\/hooks\/sessionstart-prime-claude\.sh$/);
    });
  });

  describe('DELETE /api/projects/:name', () => {
    it('requires password when configured', async () => {
      // Set a password
      const config = store.config.load();
      config.deletePassword = projects.hashPassword('deleteme');
      store.config.save(config);

      const { status, data } = await request('DELETE', '/api/projects/api-test-project', {}, asOperator());
      assert.equal(status, 403);
      assert.equal(data.code, 'FORBIDDEN');
    });

    it('rejects incorrect password', async () => {
      const { status } = await request('DELETE', '/api/projects/api-test-project', {
        password: 'wrong'
      }, asOperator());
      assert.equal(status, 403);
    });

    it('deletes with correct password', async () => {
      // Create a project for deletion
      await request('POST', '/api/projects', { name: 'to-api-delete' });

      const { status, data } = await request('DELETE', '/api/projects/to-api-delete', {
        password: 'deleteme'
      }, asOperator());
      assert.equal(status, 200);
      assert.ok(data.ok);
      assert.equal(data.name, 'to-api-delete');
    });

    it('returns 404 for unknown project', async () => {
      // Clear password for simpler test
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const { status } = await request('DELETE', '/api/projects/nonexistent', {}, asOperator());
      assert.equal(status, 404);
    });

    it('deletes without password for the operator when none is configured', async () => {
      await request('POST', '/api/projects', { name: 'no-pass-delete' });
      const { status, data } = await request('DELETE', '/api/projects/no-pass-delete', {}, asOperator());
      assert.equal(status, 200);
      assert.ok(data.ok);
    });
  });

  describe('each caller sees only the projects it owns (#1739)', () => {
    // Fields that describe a project's workspace. None may reach a caller that
    // does not own the project.
    const WORKSPACE_FIELDS = ['path', 'groups', 'git', 'ports', 'sessionHealth', 'stranded', 'evalAudit', 'actions'];
    let own;
    let other;
    let binding;

    before(async () => {
      await request('POST', '/api/projects', { name: 'view-own' });
      await request('POST', '/api/projects', { name: 'view-other' });
      own = store.projects.getByName('view-own');
      other = store.projects.getByName('view-other');
      binding = bindProject(own);
    });

    /**
     * Assert a row is the public projection and carries no workspace field.
     * @param {object} row - A project row from the API
     */
    function assertRestricted(row) {
      assert.equal(row.restricted, true, `${row.name} should be the public projection`);
      for (const field of WORKSPACE_FIELDS) {
        assert.equal(field in row, false, `${row.name} must not carry ${field}`);
      }
      assert.ok(row.engine === null || Object.keys(row.engine).every((k) => k === 'id' || k === 'name'),
        'the engine is named, not profiled');
    }

    it('an unbound caller gets every row as the public projection, and no projects directory', async () => {
      const { status, data } = await request('GET', '/api/projects');
      assert.equal(status, 200);
      assert.ok(data.projects.length >= 2);
      for (const row of data.projects) assertRestricted(row);
      const names = data.projects.map((p) => p.name);
      assert.ok(names.includes('view-own') && names.includes('view-other'), 'the roster itself stays readable');
      assert.equal(typeof data.scan.complete, 'boolean');
      assert.equal('dir' in data.scan, false);
      assert.equal('hint' in data.scan, false);
    });

    it('a bound project sees its own row whole and every other row restricted', async () => {
      const { status, data } = await request('GET', '/api/projects', null, binding.headers);
      assert.equal(status, 200);
      const mine = data.projects.find((p) => p.name === 'view-own');
      assert.equal(mine.path, own.path);
      assert.ok(Array.isArray(mine.groups));
      assert.equal('restricted' in mine, false);
      for (const row of data.projects.filter((p) => p.name !== 'view-own')) assertRestricted(row);
      assert.equal('dir' in data.scan, false, 'the projects directory is not one project\'s');
    });

    it('a binding whose project claim disagrees with its launch is treated as unbound', async () => {
      const headers = { ...binding.headers, 'x-tangleclaw-project-id': String(other.id) };
      const { data } = await request('GET', '/api/projects', null, headers);
      for (const row of data.projects) assertRestricted(row);
    });

    it('the operator sees every row whole', async () => {
      const { data } = await request('GET', '/api/projects', null, asOperator());
      const theirs = data.projects.find((p) => p.name === 'view-other');
      assert.equal(theirs.path, other.path);
      assert.equal('restricted' in theirs, false);
      assert.ok(data.scan.dir);
    });

    it('GET /api/projects/:name is shaped the same way', async () => {
      const unbound = await request('GET', '/api/projects/view-other');
      assert.equal(unbound.status, 200);
      assertRestricted(unbound.data);

      const foreign = await request('GET', '/api/projects/view-other', null, binding.headers);
      assertRestricted(foreign.data);

      const mine = await request('GET', '/api/projects/view-own', null, binding.headers);
      assert.equal(mine.data.path, own.path);
    });
  });

  describe('deleting, archiving and unarchiving are the operator\'s (#1746)', () => {
    let binding;

    before(async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);
      await request('POST', '/api/projects', { name: 'op-only' });
      binding = bindProject(store.projects.getByName('op-only'));
    });

    for (const [label, headersFor] of [
      ['an unbound caller', () => ({})],
      ['the project itself', () => binding.headers]
    ]) {
      it(`refuses DELETE to ${label} when no password is set, and the project survives`, async () => {
        const { status, data } = await request('DELETE', '/api/projects/op-only', { deleteFiles: true }, headersFor());
        assert.equal(status, 403);
        assert.equal(data.code, 'OPERATOR_ONLY');
        assert.ok(store.projects.getByName('op-only'), 'the project must still exist');
        assert.ok(fs.existsSync(path.join(projectsDir, 'op-only')), 'and so must its directory');
      });

      it(`refuses archive and unarchive to ${label}`, async () => {
        for (const verb of ['archive', 'unarchive']) {
          const { status, data } = await request('POST', `/api/projects/op-only/${verb}`, {}, headersFor());
          assert.equal(status, 403, verb);
          assert.equal(data.code, 'OPERATOR_ONLY', verb);
        }
        assert.equal(store.projects.getByName('op-only').archived, false);
      });
    }

    it('refuses before any lookup, so a missing project reads the same as a present one', async () => {
      const { status, data } = await request('DELETE', '/api/projects/no-such-project', {});
      assert.equal(status, 403);
      assert.equal(data.code, 'OPERATOR_ONLY');
    });

    it('lets the operator archive, unarchive and delete', async () => {
      // A project with no live session: archiving refuses one that has a session.
      await request('POST', '/api/projects', { name: 'op-lifecycle' });
      assert.equal((await request('POST', '/api/projects/op-lifecycle/archive', {}, asOperator())).status, 200);
      assert.equal(store.projects.list({ archived: true }).find((p) => p.name === 'op-lifecycle').archived, true);
      assert.equal((await request('POST', '/api/projects/op-lifecycle/unarchive', {}, asOperator())).status, 200);
      const { status } = await request('DELETE', '/api/projects/op-lifecycle', {}, asOperator());
      assert.equal(status, 200);
      assert.equal(store.projects.getByName('op-lifecycle'), null);
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
          const before = n;
          const { status, data } = await request('GET', '/api/projects');
          // Degraded, not failed: registered projects come from SQLite and are
          // unaffected, so the dashboard still renders.
          assert.equal(status, 200, `request ${i + 1} of ${attempts} must still be answered`);
          assert.ok(Array.isArray(data.projects), 'must answer with a list, not an error');
          // Checked per request rather than as one total at the end. The route
          // used to make exactly one scanner call, so a total of `attempts` said
          // "every request reached the fixture"; since #884 it makes one per
          // registered project as well, and a total would silently pass if one
          // request bypassed the scanner while another made two. Asserting the
          // count MOVED on every iteration is what the total was standing in for.
          assert.ok(n > before,
            `request ${i + 1} of ${attempts} must actually have reached the scanner`);
        }

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
