'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const store = require('../lib/store');
const { createServer } = require('../server');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('api-actions (#139 Chunk 11b)', () => {
  let server;
  let port;
  let tmpDir;
  let projectsDir;

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
      if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Stand up a project on disk + in the store.
   * @param {string} name - Project name.
   * @param {boolean} [governed=true] - Mark it governed by the Prawduct V2
   *   plugin, which is what makes actions available.
   * @returns {object} The created project record.
   */
  function makeProject(name, governed = true) {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    execSync('git init -q', { cwd: projPath });
    execSync('git config user.email test@example.com', { cwd: projPath });
    execSync('git config user.name test', { cwd: projPath });
    execSync('git commit --allow-empty -m init -q', { cwd: projPath });
    execSync('git checkout -q -b feat/api-actions-test', { cwd: projPath });
    if (governed) {
      fs.mkdirSync(path.join(projPath, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } }, null, 2)
      );
    }
    return store.projects.create({ name, path: projPath, engine: 'claude' });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-actions-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.deletePassword = null;
    store.config.save(config);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/projects/:name/actions/:command', () => {
    it('200 ok on a valid invoke-critic for a plugin-governed project', async () => {
      const project = makeProject('api-prawduct-1');
      const { status, data } = await request(
        'POST',
        '/api/projects/api-prawduct-1/actions/invoke-critic',
        {}
      );
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.output.entry.branchName, 'feat/api-actions-test');
      assert.ok(fs.existsSync(path.join(project.path, '.tangleclaw', 'critic-runs.json')));
    });

    it('404 when project is unknown', async () => {
      const { status, data } = await request(
        'POST',
        '/api/projects/no-such-project/actions/invoke-critic',
        {}
      );
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('404 when the project governance state does not support the action', async () => {
      makeProject('api-minimal-1', false); // ungoverned — nothing ships a Critic
      const { status, data } = await request(
        'POST',
        '/api/projects/api-minimal-1/actions/invoke-critic',
        {}
      );
      assert.equal(status, 404);
      assert.ok(data.error.includes('not available'));
    });

    it('404 when the command is unknown', async () => {
      makeProject('api-prawduct-2');
      const { status } = await request(
        'POST',
        '/api/projects/api-prawduct-2/actions/no-such-command',
        {}
      );
      assert.equal(status, 404);
    });

    it('forwards request body as options to the handler', async () => {
      const project = makeProject('api-prawduct-3');
      const { status, data } = await request(
        'POST',
        '/api/projects/api-prawduct-3/actions/invoke-critic',
        { branchName: 'opts/explicit' }
      );
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const arr = JSON.parse(fs.readFileSync(
        path.join(project.path, '.tangleclaw', 'critic-runs.json'), 'utf8'
      ));
      assert.equal(arr[0].branchName, 'opts/explicit');
    });

    it('non-object body (array) is coerced to no options', async () => {
      const project = makeProject('api-prawduct-4');
      const { status, data } = await request(
        'POST',
        '/api/projects/api-prawduct-4/actions/invoke-critic',
        // Express body-parser would coerce an array to options=undefined
        // here too — the endpoint's `options-or-undefined` guard pins
        // the contract.
        ['not', 'an', 'object']
      );
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      // Branch came from the project's actual git state, not from the array.
      const arr = JSON.parse(fs.readFileSync(
        path.join(project.path, '.tangleclaw', 'critic-runs.json'), 'utf8'
      ));
      assert.equal(arr[0].branchName, 'feat/api-actions-test');
    });

    it('200 ok:false (soft fail) when project path is not a git repo', async () => {
      const projPath = path.join(projectsDir, 'api-not-git');
      fs.mkdirSync(projPath, { recursive: true });
      // Governed, so the action is available and actually reaches the handler —
      // but with no git init, branch resolution fails there.
      fs.mkdirSync(path.join(projPath, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(projPath, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } }, null, 2)
      );
      store.projects.create({
        name: 'api-not-git',
        path: projPath,
        engine: 'claude'
      });
      const { status, data } = await request(
        'POST',
        '/api/projects/api-not-git/actions/invoke-critic',
        {}
      );
      // Soft fail at the handler — endpoint returns 200 with ok:false so
      // the frontend can surface the error inline rather than a hard 5xx.
      assert.equal(status, 200);
      assert.equal(data.ok, false);
      assert.ok(data.error.includes('git branch'));
    });
  });

  describe('actions surfaced on GET /api/projects/:name', () => {
    it('governed project response includes actions[]', async () => {
      makeProject('api-actions-surface');
      const { status, data } = await request('GET', '/api/projects/api-actions-surface');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.actions));
      const invokeCritic = data.actions.find((a) => a.command === 'invoke-critic');
      assert.ok(invokeCritic, 'invoke-critic action is surfaced');
      assert.equal(invokeCritic.label, 'Run Critic',
        'label renamed (#267) — handler now actually spawns a Critic via tmux (with ack-only fallback for unsupported engines/no-session cases)');
      assert.equal(invokeCritic.confirm, true,
        'confirm flipped to true (#230) so the contract-clarifying dialog actually fires');
      assert.equal(typeof invokeCritic.confirmMessage, 'string',
        'per-action confirmMessage (#230) replaces the generic "Run X for this project?" prompt');
      assert.ok(invokeCritic.confirmMessage.length > 0, 'confirmMessage is non-empty');
      assert.equal(typeof invokeCritic.successToast, 'string',
        'per-action successToast (#230) replaces the generic "X: recorded" toast');
      assert.ok(invokeCritic.successToast.length > 0, 'successToast is non-empty');
      assert.ok(invokeCritic.successToast.includes('{branchName}'),
        'successToast carries the {branchName} placeholder (#230) so the UI interpolates the actual branch from the handler response');
      // Allow-list pin (#230): exactly these keys may appear on the wire.
      // A field added to an action declaration for server-side use must NOT
      // leak through the explicit-property allow-list — what's dispatchable
      // and what's published are decided separately.
      assert.deepStrictEqual(
        Object.keys(invokeCritic).sort(),
        ['command', 'confirm', 'confirmMessage', 'label', 'successToast'],
        'no fields beyond the documented allow-list may surface on the wire'
      );
    });

    it('ungoverned project response has empty actions[]', async () => {
      makeProject('api-actions-minimal', false);
      const { status, data } = await request('GET', '/api/projects/api-actions-minimal');
      assert.equal(status, 200);
      assert.deepEqual(data.actions, []);
    });
  });
});
