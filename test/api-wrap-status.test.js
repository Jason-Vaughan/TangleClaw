'use strict';

/*
 * #583 — HTTP-level tests for the wrap-run single-flight + reattach
 * surface: `POST /wrap` answering 409 WRAP_IN_PROGRESS while a pipeline
 * runs, `GET /wrap/status` exposing the running/finished run, and
 * `POST /api/server/restart` refusing to kill a mid-flight wrap unless
 * forced. Mirrors the api-sessions.test.js harness (real server on an
 * ephemeral port, isolated temp store, wrap-pipeline module stubbed).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const wrapPipelineMod = require('../lib/wrap-pipeline');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const serverInfo = require('../lib/server-info');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, body: object }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr != null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
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
      }
    );
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

describe('api wrap-run status + single-flight (#583)', () => {
  let tmpDir;
  let server;
  let projectId;
  const realRunPipeline = wrapPipelineMod.runWrapPipeline;

  const EMPTY_PIPELINE_RESULT = Object.freeze({
    ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null
  });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-wrap-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    const projDir = path.join(projectsDir, 'wrap-run-test');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({
      name: 'wrap-run-test',
      path: projDir,
      engine: 'claude'
    });
    projectId = project.id;
    // The server-side pipeline (the path #583 guards) is the only wrap
    // route — the legacy NL-prompt path and its wrapV2 gate are retired.

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    wrapPipelineMod.runWrapPipeline = realRunPipeline;
    wrapRunRegistry._resetForTests();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    wrapRunRegistry._resetForTests();
    wrapPipelineMod.runWrapPipeline = realRunPipeline;
    const active = store.sessions.getActive(projectId);
    if (active) store.sessions.kill(active.id, 'test cleanup');
  });

  describe('GET /api/sessions/:project/wrap/status', () => {
    it('reports no run for a project that never wrapped (post-restart truth)', async () => {
      const res = await request(server, 'GET', '/api/sessions/wrap-run-test/wrap/status');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        project: 'wrap-run-test',
        running: false,
        sessionId: null,
        startedAt: null,
        currentStepId: null,
        finishedAt: null,
        result: null
      });
    });

    it('reports a running run with progress, then the finished result in POST payload shape', async () => {
      store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'wrap-run-live' });
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      wrapPipelineMod.runWrapPipeline = async (projectName, options) => {
        options.onStepStart('memory-update', 'ai-content');
        await gate;
        return { ...EMPTY_PIPELINE_RESULT };
      };

      const postPromise = request(server, 'POST', '/api/sessions/wrap-run-test/wrap', {});
      // Poll until the pipeline has claimed the slot (bounded spin).
      let status;
      for (let i = 0; i < 50; i++) {
        status = await request(server, 'GET', '/api/sessions/wrap-run-test/wrap/status');
        if (status.body.running) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(status.body.running, true, 'status reports the in-flight run');
      assert.equal(status.body.currentStepId, 'memory-update', 'status carries pipeline progress');
      assert.equal(typeof status.body.startedAt, 'number');
      assert.equal(status.body.result, null, 'no result while running');

      releaseGate();
      const post = await postPromise;
      assert.equal(post.status, 200);

      const after = await request(server, 'GET', '/api/sessions/wrap-run-test/wrap/status');
      assert.equal(after.body.running, false);
      assert.equal(typeof after.body.finishedAt, 'number');
      // The retained result must be byte-shaped like the POST's own payload —
      // the reattach path renders exactly what the dead connection missed.
      assert.deepEqual(after.body.result, post.body,
        'status result matches the POST payload shape exactly');
    });
  });

  describe('POST /api/sessions/:project/wrap — single-flight 409', () => {
    it('a concurrent wrap POST gets 409 WRAP_IN_PROGRESS and starts no second pipeline', async () => {
      store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'wrap-run-409' });
      let pipelineCalls = 0;
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      wrapPipelineMod.runWrapPipeline = async () => {
        pipelineCalls += 1;
        await gate;
        return { ...EMPTY_PIPELINE_RESULT };
      };

      const first = request(server, 'POST', '/api/sessions/wrap-run-test/wrap', {});
      let status;
      for (let i = 0; i < 50; i++) {
        status = await request(server, 'GET', '/api/sessions/wrap-run-test/wrap/status');
        if (status.body.running) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(status.body.running, true, 'precondition: first wrap is in flight');

      const second = await request(server, 'POST', '/api/sessions/wrap-run-test/wrap', {});
      assert.equal(second.status, 409, 'concurrent wrap is refused');
      assert.equal(second.body.code, 'WRAP_IN_PROGRESS');
      assert.match(second.body.error, /already running/);
      assert.equal(pipelineCalls, 1, 'THE PIN: no second pipeline started');

      releaseGate();
      const firstRes = await first;
      assert.equal(firstRes.status, 200, 'the original wrap completes untouched');
    });
  });

  describe('POST /api/server/restart — wrap guard', () => {
    it('refuses 409 WRAP_RESTART_BLOCKED while any wrap is running (guard precedes mechanism detection)', async () => {
      // Claim a run directly — the guard reads the registry, and this keeps
      // the test independent of pipeline timing.
      wrapRunRegistry.begin('wrap-run-test', 1);
      try {
        const res = await request(server, 'POST', '/api/server/restart', {});
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'WRAP_RESTART_BLOCKED');
        assert.match(res.body.error, /wrap-run-test/, 'refusal names the wrapping project');
      } finally {
        wrapRunRegistry._resetForTests();
      }
    });

    it('{"force": true} bypasses the guard (proven via a stubbed null mechanism → 501, no exec)', async () => {
      wrapRunRegistry.begin('wrap-run-test', 1);
      const realDetect = serverInfo.detectRestartMechanism;
      serverInfo.detectRestartMechanism = () => null;
      try {
        const res = await request(server, 'POST', '/api/server/restart', { force: true });
        assert.equal(res.status, 501,
          'force reached mechanism detection (stubbed null) — the wrap guard was bypassed');
      } finally {
        serverInfo.detectRestartMechanism = realDetect;
        wrapRunRegistry._resetForTests();
      }
    });

    it('no running wrap → guard does not interfere (stubbed null mechanism → 501)', async () => {
      const realDetect = serverInfo.detectRestartMechanism;
      serverInfo.detectRestartMechanism = () => null;
      try {
        const res = await request(server, 'POST', '/api/server/restart', {});
        assert.equal(res.status, 501, 'reaches mechanism detection with no wrap running');
      } finally {
        serverInfo.detectRestartMechanism = realDetect;
      }
    });
  });
});
