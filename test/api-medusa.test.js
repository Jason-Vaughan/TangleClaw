'use strict';

/**
 * MED-2K9P Chunk 01 — service layer (`lib/medusa.js`) + the
 * `GET /api/sessions/:project/medusa/status` route.
 *
 * The service holds a module-level Map of listeners, so each test uses a unique
 * session id and stops what it starts to avoid cross-test leakage.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('../server');
const store = require('../lib/store');
const medusa = require('../lib/medusa');

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

/** Minimal fake WebSocket matching what MedusaListener drives (test seam). */
class FakeWS {
  /** @param {string} url - Requested URL. */
  constructor(url) {
    this.url = url;
    this.readyState = CONNECTING;
    /** @type {string[]} */
    this.sent = [];
    this._h = Object.create(null);
  }

  /**
   * @param {string} t - Event type.
   * @param {(e: object) => void} h - Handler.
   * @returns {void}
   */
  addEventListener(t, h) {
    (this._h[t] || (this._h[t] = [])).push(h);
  }

  /** @param {string} d - Serialized frame. @returns {void} */
  send(d) {
    this.sent.push(d);
  }

  /** @returns {void} */
  close() {
    this.readyState = CLOSED;
  }

  /**
   * @param {string} t - Event type.
   * @param {object} e - Event payload.
   * @returns {void}
   */
  _fire(t, e) {
    for (const h of this._h[t] || []) h(e);
  }

  /** @returns {void} */
  _open() {
    this.readyState = OPEN;
    this._fire('open', {});
  }

  /** @param {object} obj - Inbound frame object. @returns {void} */
  _recv(obj) {
    this._fire('message', { data: JSON.stringify(obj) });
  }
}

describe('lib/medusa — service layer', () => {
  let tempDir;
  const started = [];

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-svc-'));
  });

  afterEach(() => {
    // Stop anything a test started so the module singleton doesn't leak.
    while (started.length) medusa.stopSession(started.pop());
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getStatus(null) and unknown session return an off status', () => {
    const off = { state: 'off', workspaceId: null, unread: 0, lastError: null };
    assert.deepEqual(medusa.getStatus(null), off);
    assert.deepEqual(medusa.getStatus('no-such-session'), off);
  });

  it('getMessages/markRead on an unknown session are safe no-ops', () => {
    assert.deepEqual(medusa.getMessages('no-such-session'), []);
    assert.doesNotThrow(() => medusa.markRead('no-such-session'));
  });

  it('startSession registers, drives to listening, and surfaces received messages', () => {
    const sid = 'svc-1';
    started.push(sid);
    let fake;
    const status = medusa.startSession({
      projectPath: tempDir,
      sessionId: sid,
      name: 'Svc One',
      wsFactory: (url) => (fake = new FakeWS(url))
    });

    // Workspace id minted from the registry; connecting before the socket opens.
    assert.match(status.workspaceId, /^svc-one-[0-9a-f]{8}$/);
    assert.equal(status.state, 'connecting');

    fake._open();
    // First frame the listener sends is the register handshake.
    assert.deepEqual(JSON.parse(fake.sent[0]), { type: 'register', workspaceId: status.workspaceId });

    fake._recv({ type: 'registered', workspaceId: status.workspaceId, connectionId: 'c1' });
    assert.equal(medusa.getStatus(sid).state, 'listening');

    fake._recv({ type: 'new_message', messageId: 'm1', message: { id: 'm1', from: 'other', message: 'hi there' } });
    assert.equal(medusa.getStatus(sid).unread, 1);
    const msgs = medusa.getMessages(sid);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].message, 'hi there');

    medusa.markRead(sid);
    assert.equal(medusa.getStatus(sid).unread, 0);
  });

  it('startSession is idempotent per session (no double-start)', () => {
    const sid = 'svc-2';
    started.push(sid);
    const first = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Svc Two', wsFactory: (u) => new FakeWS(u) });
    const second = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Svc Two', wsFactory: (u) => new FakeWS(u) });
    assert.equal(second.workspaceId, first.workspaceId);
    assert.deepEqual(second, medusa.getStatus(sid));
  });

  it('stopSession removes the listener and reverts to off', () => {
    const sid = 'svc-3';
    medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Svc Three', wsFactory: (u) => new FakeWS(u) });
    assert.notEqual(medusa.getStatus(sid).state, 'off');
    medusa.stopSession(sid);
    assert.deepEqual(medusa.getStatus(sid), { state: 'off', workspaceId: null, unread: 0, lastError: null });
  });

  it('reuses the same workspace id across restarts (registry persistence)', () => {
    const sid = 'svc-4';
    const a = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Svc Four', wsFactory: (u) => new FakeWS(u) });
    medusa.stopSession(sid);
    const b = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Svc Four', wsFactory: (u) => new FakeWS(u) });
    medusa.stopSession(sid);
    assert.equal(b.workspaceId, a.workspaceId);
  });
});

describe('API — GET /api/sessions/:project/medusa/status', () => {
  let server;
  let port;
  let tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-api-'));
    store._setBasePath(tempDir);
    store.init();
    const projPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-proj-'));
    store.projects.create({ name: 'demo', path: projPath, engine: 'claude', methodology: 'none' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path to GET.
   * @returns {Promise<{status: number, data: object}>}
   */
  function get(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
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
      req.end();
    });
  }

  it('returns 404 for an unknown project', async () => {
    const { status } = await get('/api/sessions/nope/medusa/status');
    assert.equal(status, 404);
  });

  it('returns an off status when the project has no active session', async () => {
    const { status, data } = await get('/api/sessions/demo/medusa/status');
    assert.equal(status, 200);
    assert.deepEqual(data, { state: 'off', workspaceId: null, unread: 0, lastError: null });
  });

  it('honors the ?sessionId= fallback (off for a session with no listener)', async () => {
    const { status, data } = await get('/api/sessions/demo/medusa/status?sessionId=ghost');
    assert.equal(status, 200);
    assert.equal(data.state, 'off');
  });
});
