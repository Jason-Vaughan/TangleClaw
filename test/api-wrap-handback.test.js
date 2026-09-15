'use strict';

/*
 * HTTP contract for the watched handback (#1312): `POST /wrap/handback` answers
 * 202 with a stream handle, refusals keep their status codes, the handback
 * stream delivers `handback-start` then a terminal `handback-done` and closes,
 * and `GET /wrap/status` carries the handback and the current step's start time
 * so a reloaded page can restore both. Real server on an ephemeral port, an
 * isolated temp store, the pane read and the injection stubbed.
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
const wrapRunRegistry = require('../lib/wrap-run-registry');
const wrapHandback = require('../lib/wrap-handback');

const PROJECT = 'wrap-handback-test';
const WAIT_MS = 10_000;

/**
 * Make a JSON request.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{status: number, headers: object, body: any}>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr != null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

const openRequests = new Set();

/**
 * Read an SSE response to its end (bounded), returning its frames.
 * @param {http.Server} server
 * @param {string} urlPath
 * @param {() => void} [onOpen] - Called once headers land
 * @returns {Promise<{status: number, headers: object, frames: {event: string, data: object}[]}>}
 */
function readStream(server, urlPath, onOpen) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET' }, (res) => {
      const timer = setTimeout(() => reject(new Error(`stream ${urlPath} did not end within ${WAIT_MS}ms`)), WAIT_MS);
      if (timer.unref) timer.unref();
      let buffer = '';
      const frames = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (block.startsWith(':')) continue;
          const frame = {};
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':');
            const field = line.slice(0, colon);
            const value = line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') frame.event = value;
            else if (field === 'data') frame.data = JSON.parse(value);
          }
          frames.push(frame);
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, frames }); });
      if (onOpen) onOpen();
    });
    req.on('error', reject);
    openRequests.add(req);
    req.on('close', () => openRequests.delete(req));
    req.end();
  });
}

describe('wrap handback routes (#1312)', () => {
  let tmpDir;
  let server;
  let sessionId;
  let pane;
  const savedInternal = { ...wrapHandback._internal };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-wrap-handback-'));
    store._setBasePath(tmpDir);
    store.init();
    const projDir = path.join(tmpDir, 'projects', PROJECT);
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: PROJECT, path: projDir, engine: 'claude' });
    sessionId = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'hb-route-pane' }).id;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    Object.assign(wrapHandback._internal, savedInternal);
    wrapHandback._resetForTests();
    wrapRunRegistry._resetForTests();
    for (const req of openRequests) req.destroy();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    wrapHandback._resetForTests();
    wrapRunRegistry._resetForTests();
    pane = 'working';
    Object.assign(wrapHandback._internal, savedInternal, {
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      readPaneTail: () => pane,
      newNonce: () => '0badf00d',
      inject: () => ({ ok: true, error: null })
    });
  });

  /**
   * Settle a run that halted at changelog-update.
   * @returns {string} runId
   */
  function settleBlocked() {
    const claim = wrapRunRegistry.begin(PROJECT, sessionId);
    wrapRunRegistry.finish(PROJECT, claim.runId, {
      ok: false,
      sessionId,
      pipelineResult: { ok: false, blockedAt: 'changelog-update', results: [{ stepId: 'changelog-update', kind: 'ai-content', status: 'blocked', blockers: ['no entry'] }] }
    });
    return claim.runId;
  }

  it('answers 202 with the handback and its stream handle', async () => {
    settleBlocked();
    const res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: 'Write it.' });
    assert.equal(res.status, 202);
    assert.equal(res.body.handback.state, 'working');
    assert.equal(res.body.streamUrl, `/api/sessions/${PROJECT}/wrap/handback/stream/${res.body.handbackId}`);
    assert.equal(res.body.statusUrl, `/api/sessions/${PROJECT}/wrap/status`);
  });

  it('keeps each refusal\'s status: 409 with no settled halt, 400 on a bad prompt', async () => {
    let res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: 'x' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'WRAP_NOT_SETTLED');
    settleBlocked();
    res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'memory-update', prompt: 'x' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'WRAP_STEP_NOT_BLOCKED');
    res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: '' });
    assert.equal(res.status, 400);
  });

  it('the stream delivers handback-start, then handback-done on the marker, and closes', async () => {
    settleBlocked();
    const res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: 'Write it.' });
    const stream = await readStream(server, res.body.streamUrl, () => { pane = 'done\nTCWRAP-DONE 0badf00d'; });
    assert.equal(stream.status, 200);
    assert.match(stream.headers['content-type'], /^text\/event-stream/);
    assert.deepEqual(stream.frames.map((f) => f.event), ['handback-start', 'handback-done']);
    assert.equal(stream.frames[1].data.state, 'ready');
    assert.equal(stream.frames[1].data.completedVia, 'marker');
    assert.ok(stream.frames.every((f) => Number.isFinite(f.data.at) && Number.isFinite(f.data.sentAt)));
  });

  it('a stream opened after the watch ended replays both frames and closes at once', async () => {
    settleBlocked();
    pane = 'TCWRAP-DONE 0badf00d';
    const res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: 'Write it.' });
    for (let i = 0; i < 1000 && wrapHandback.get(PROJECT, wrapRunRegistry.get(PROJECT).runId).state === 'working'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const stream = await readStream(server, res.body.streamUrl);
    assert.deepEqual(stream.frames.map((f) => [f.event, f.data.state]), [['handback-start', 'working'], ['handback-done', 'ready']]);
  });

  it('404s an unknown handback stream as JSON', async () => {
    const res = await request(server, 'GET', `/api/sessions/${PROJECT}/wrap/handback/stream/0123456789abcdef0123456789abcdef`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'HANDBACK_NOT_FOUND');
  });

  it('GET /wrap/status carries the handback and the current step\'s start time', async () => {
    const claim = wrapRunRegistry.begin(PROJECT, sessionId);
    wrapRunRegistry.emit(PROJECT, claim.runId, { type: 'run-start', steps: [{ stepId: 'a', kind: 'k' }] });
    const step = wrapRunRegistry.emit(PROJECT, claim.runId, { type: 'step-start', stepId: 'a', kind: 'k' });
    let status = await request(server, 'GET', `/api/sessions/${PROJECT}/wrap/status`);
    assert.equal(status.body.currentStepStartedAt, step.at);
    assert.equal(status.body.handback, null);
    wrapRunRegistry._resetForTests();

    settleBlocked();
    const res = await request(server, 'POST', `/api/sessions/${PROJECT}/wrap/handback`, { stepId: 'changelog-update', prompt: 'Write it.' });
    status = await request(server, 'GET', `/api/sessions/${PROJECT}/wrap/status`);
    assert.equal(status.body.handback.handbackId, res.body.handbackId);
    assert.equal(status.body.handback.stepId, 'changelog-update');
    assert.equal(status.body.currentStepStartedAt, null, 'a settled run has no current step');
  });
});
