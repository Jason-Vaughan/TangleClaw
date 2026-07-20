'use strict';

/*
 * #638 — HTTP-level tests for GET /api/sessions/:project/wrap/pr-status, the
 * read-only probe that resolves a wrap PR's live merge outcome after the
 * pipeline returns, so a blocked release never renders as success. `gh` is
 * stubbed via `wrap-pr-status._internal.exec`; the harness mirrors
 * api-wrap-status.test.js (real server, isolated store).
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const prStatus = require('../lib/wrap-pr-status');

function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('api GET /wrap/pr-status (#638)', () => {
  let tmpDir;
  let server;
  const savedExec = prStatus._internal.exec;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-prstatus-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    const projDir = path.join(projectsDir, 'prstatus-test');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({ name: 'prstatus-test', path: projDir, engine: 'claude', methodology: 'minimal' });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    prStatus._internal.exec = savedExec;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { prStatus._internal.exec = savedExec; });
  afterEach(() => { prStatus._internal.exec = savedExec; });

  it('400 when the url query param is missing', async () => {
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_REQUEST');
  });

  it('resolves a MERGED PR to outcome merged', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', url: 'u' }), stderr: '' });
    const url = encodeURIComponent('https://github.com/o/r/pull/12');
    const res = await request(server, 'GET', `/api/sessions/prstatus-test/wrap/pr-status?url=${url}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'merged');
    assert.equal(res.body.project, 'prstatus-test');
  });

  it('resolves an OPEN+BLOCKED PR to outcome blocked (the #636 case)', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }), stderr: '' });
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=7');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'blocked');
  });

  it('an invalid PR ref resolves to unknown WITHOUT invoking gh', async () => {
    let called = false;
    prStatus._internal.exec = async () => { called = true; return { exitCode: 0, stdout: '{}', stderr: '' }; };
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=--json');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'unknown');
    assert.equal(called, false);
  });

  it('an unknown project resolves to unknown, not a 500', async () => {
    const res = await request(server, 'GET', '/api/sessions/does-not-exist/wrap/pr-status?url=9');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'unknown');
    assert.match(res.body.reason, /not found/);
  });
});
