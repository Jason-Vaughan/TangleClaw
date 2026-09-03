'use strict';

/*
 * #185 — HTTP-level tests for `GET /api/sessions/:project/wrap/stream/:runId`,
 * the live wrap-progress feed. Pins the wire contract a browser `EventSource`
 * depends on: `text/event-stream`, one `id:`/`event:`/`data:` frame per
 * registry event, replay of what a late subscriber missed followed by live
 * frames, the terminal `run-done` frame carrying the wrap POST's own payload
 * shape, the response ending on it, `Last-Event-ID` resumption, a 404 for a
 * run the server does not hold, and gate parity with the wrap POST. Mirrors
 * the api-wrap-status.test.js harness (real server on an ephemeral port,
 * isolated temp store, wrap-pipeline module stubbed).
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
const { createServer, matchRoute } = require('../server');
const caddy = require('../lib/caddy');
const wrapPipelineMod = require('../lib/wrap-pipeline');
const wrapRunRegistry = require('../lib/wrap-run-registry');

/**
 * Make a plain JSON request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{status: number, headers: object, body: object|string}>}
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
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

/**
 * Parse one SSE block (the text between blank lines) into `{id, event, data}`.
 * `data` is JSON-decoded, which is what the client does with it.
 * @param {string} block
 * @returns {{id: number, event: string, data: object}}
 */
function parseFrame(block) {
  const frame = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') frame.id = Number(value);
    else if (field === 'event') frame.event = value;
    else if (field === 'data') frame.data = JSON.parse(value);
  }
  return frame;
}

/**
 * Open the stream and expose its frames as they arrive. Resolves once the
 * response headers land (before any frame), so a test can assert on a
 * still-open stream. Comment lines (`: …`) are not frames and are dropped,
 * as an EventSource drops them.
 * @param {http.Server} server
 * @param {string} urlPath
 * @param {object} [headers]
 * @returns {Promise<{status: number, headers: object, frames: object[], ended: boolean, body: string, until: (pred: Function) => Promise<void>}>}
 */
function openStream(server, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET', headers: headers || {} },
      (res) => {
        const stream = { status: res.statusCode, headers: res.headers, frames: [], ended: false, body: '', waiters: [] };
        const notify = () => { stream.waiters = stream.waiters.filter((w) => !w()); };
        stream.until = (pred) => new Promise((done) => {
          const check = () => { if (pred(stream)) { done(); return true; } return false; };
          if (!check()) stream.waiters.push(check);
        });
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          stream.body += chunk;
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (block.startsWith(':')) continue;
            stream.frames.push(parseFrame(block));
          }
          notify();
        });
        res.on('end', () => { stream.ended = true; notify(); });
        resolve(stream);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/sessions/:project/wrap/stream/:runId (#185)', () => {
  let tmpDir;
  let server;
  let projectId;
  const realRunPipeline = wrapPipelineMod.runWrapPipeline;
  const STREAM = (runId) => `/api/sessions/wrap-stream-test/wrap/stream/${runId}`;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-wrap-stream-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    const projDir = path.join(projectsDir, 'wrap-stream-test');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: 'wrap-stream-test', path: projDir, engine: 'claude' });
    projectId = project.id;

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

  /**
   * Poll /wrap/status until a run is in flight and return its runId.
   * @returns {Promise<string>}
   */
  async function awaitRunId() {
    for (let i = 0; i < 100; i++) {
      const status = await request(server, 'GET', '/api/sessions/wrap-stream-test/wrap/status');
      if (status.body.running && status.body.runId) return status.body.runId;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('the wrap never claimed a run');
  }

  it('404s a run the server does not hold, as JSON — never an empty stream', async () => {
    const res = await request(server, 'GET', STREAM('0123456789abcdef0123456789abcdef'));
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'WRAP_RUN_NOT_FOUND');
    assert.match(res.headers['content-type'], /application\/json/);
  });

  it('replays the frames a late subscriber missed, streams live ones, and closes on run-done in the POST payload shape', async () => {
    store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'wrap-stream-live' });
    let releaseFirst;
    let releaseSecond;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const blockedResult = {
      ok: false,
      blockedAt: 'changelog-update',
      results: [
        { stepId: 'open-pr-check', kind: 'pr-check', status: 'done', output: null, blockers: [] },
        { stepId: 'changelog-update', kind: 'ai-content', status: 'blocked', output: null, blockers: ['no entry'] }
      ],
      commitSha: null,
      summary: null,
      error: null
    };
    wrapPipelineMod.runWrapPipeline = async (_name, options) => {
      options.onStepEvent({ type: 'run-start', steps: [{ stepId: 'open-pr-check', kind: 'pr-check' }, { stepId: 'changelog-update', kind: 'ai-content' }] });
      options.onStepEvent({ type: 'step-start', stepId: 'open-pr-check', kind: 'pr-check' });
      options.onStepEvent({ type: 'step-done', stepId: 'open-pr-check', kind: 'pr-check', status: 'done', output: null, blockers: [], halted: false });
      await firstGate;
      options.onStepEvent({ type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
      await secondGate;
      options.onStepEvent({ type: 'step-blocked', stepId: 'changelog-update', kind: 'ai-content', status: 'blocked', output: null, blockers: ['no entry'], halted: true });
      return blockedResult;
    };

    const postPromise = request(server, 'POST', '/api/sessions/wrap-stream-test/wrap', {});
    const runId = await awaitRunId();

    // Subscribe AFTER three events have already been emitted.
    const stream = await openStream(server, STREAM(runId));
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /^text\/event-stream/);
    assert.match(stream.headers['cache-control'], /no-cache/);
    await stream.until((s) => s.frames.length >= 3);
    assert.deepEqual(stream.frames.map((f) => [f.id, f.event]),
      [[1, 'run-start'], [2, 'step-start'], [3, 'step-done']],
      'the replay is the missed events, in order, with their registry seq as the SSE id');
    assert.deepEqual(stream.frames[0].data.steps.map((s) => s.stepId), ['open-pr-check', 'changelog-update']);
    assert.equal(stream.frames[2].data.status, 'done');
    assert.equal(stream.ended, false, 'the stream stays open while the run is live');

    // Live delivery.
    releaseFirst();
    await stream.until((s) => s.frames.length >= 4);
    assert.deepEqual([stream.frames[3].id, stream.frames[3].event, stream.frames[3].data.stepId],
      [4, 'step-start', 'changelog-update']);
    assert.equal(stream.ended, false);

    releaseSecond();
    const post = await postPromise;
    assert.equal(post.status, 200);
    await stream.until((s) => s.ended);
    assert.deepEqual(stream.frames.map((f) => f.event),
      ['run-start', 'step-start', 'step-done', 'step-start', 'step-blocked', 'run-done']);
    assert.equal(stream.frames[4].data.halted, true);
    // THE PIN: the terminal frame IS the wrap POST's payload, so the drawer
    // renders the stream's end exactly as it renders the POST's return.
    assert.deepEqual(stream.frames[5].data.result, post.body);
    assert.equal(post.body.runId, runId, 'the POST reports the same handle the stream was opened with');
    assert.equal(post.body.status, 'blocked');

    // A finished run replays in full and closes at once.
    const replay = await openStream(server, STREAM(runId));
    await replay.until((s) => s.ended);
    assert.equal(replay.frames.length, 6);
    assert.equal(replay.frames[5].event, 'run-done');

    // Last-Event-ID resumes past what a reconnecting client already holds.
    const resumed = await openStream(server, STREAM(runId), { 'Last-Event-ID': '4' });
    await resumed.until((s) => s.ended);
    assert.deepEqual(resumed.frames.map((f) => f.id), [5, 6]);
  });

  it('a stream opened against a finished run whose pipeline threw still ends with the run\'s real error', async () => {
    store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'wrap-stream-threw' });
    wrapPipelineMod.runWrapPipeline = async (_name, options) => {
      options.onStepEvent({ type: 'run-start', steps: [] });
      throw new Error('handler exploded');
    };
    const post = await request(server, 'POST', '/api/sessions/wrap-stream-test/wrap', {});
    assert.equal(post.status, 500, 'precondition: a thrown pipeline is the POST\'s 500 path');
    const status = await request(server, 'GET', '/api/sessions/wrap-stream-test/wrap/status');
    const stream = await openStream(server, STREAM(status.body.runId));
    await stream.until((s) => s.ended);
    assert.deepEqual(stream.frames.map((f) => f.event), ['run-start', 'run-done']);
    assert.equal(stream.frames[1].data.result.ok, false);
    assert.match(stream.frames[1].data.result.error, /handler exploded/);
    assert.equal(stream.frames[1].data.result.pipelineResult, undefined, 'no per-step result exists to invent');
  });

  it('a subscriber that disconnects mid-run is dropped and the run finishes untouched', async () => {
    store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'wrap-stream-drop' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    wrapPipelineMod.runWrapPipeline = async (_name, options) => {
      options.onStepEvent({ type: 'run-start', steps: [] });
      await gate;
      options.onStepEvent({ type: 'step-start', stepId: 'commit', kind: 'commit' });
      return { ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null };
    };
    const postPromise = request(server, 'POST', '/api/sessions/wrap-stream-test/wrap', {});
    const runId = await awaitRunId();
    const addr = server.address();
    // A raw socket we can slam shut from the client side.
    const req = http.get({ hostname: '127.0.0.1', port: addr.port, path: STREAM(runId) });
    await new Promise((resolve) => req.on('response', resolve));
    req.destroy();
    release();
    const post = await postPromise;
    assert.equal(post.status, 200, 'the pipeline never waits on, or fails for, a gone subscriber');
    assert.equal(post.body.ok, true);
  });

  describe('gate parity with the wrap POST', () => {
    it('is routed under /api/ (so every handleRequest gate the POST passes applies) and is GET-only', () => {
      assert.ok(matchRoute('GET', '/api/sessions/p/wrap/stream/abc'), 'the stream route is registered');
      assert.equal(matchRoute('POST', '/api/sessions/p/wrap/stream/abc'), null, 'no write verb reaches it');
      assert.ok(matchRoute('POST', '/api/sessions/p/wrap'), 'precondition: the POST it pairs with');
    });

    it('is NOT a Caddy auth-bypass path — the perimeter credential gates it exactly as it gates the POST', () => {
      const streamPath = '/api/sessions/p/wrap/stream/0123456789abcdef0123456789abcdef';
      assert.equal(caddy.isCaddyAuthBypassPath(streamPath), false);
      assert.equal(caddy.isCaddyAuthBypassPath('/api/sessions/p/wrap'), false);
      // The parity, not just the two booleans: whatever the bypass matcher
      // says about the POST it must say about the stream, so a future bypass
      // widening that catches one catches both.
      assert.equal(caddy.isCaddyAuthBypassPath(streamPath), caddy.isCaddyAuthBypassPath('/api/sessions/p/wrap'));
    });

    it('a browser EventSource can carry no body and no custom header, so the run handle is the credential: it is not guessable', () => {
      const ids = new Set();
      for (let i = 0; i < 50; i++) {
        wrapRunRegistry._resetForTests();
        ids.add(wrapRunRegistry.begin('p', 1).runId);
      }
      assert.equal(ids.size, 50);
      for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
    });
  });
});
