'use strict';

/**
 * MED-2K9P Chunk 01 — service layer (`lib/medusa.js`) + the
 * `GET /api/sessions/:project/medusa/status` route.
 *
 * The service holds a module-level Map of listeners, so each test uses a unique
 * session id and stops what it starts to avoid cross-test leakage.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('../server');
const store = require('../lib/store');
const medusa = require('../lib/medusa');
const sessions = require('../lib/sessions');

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

  it('forgetSession stops the listener AND forgets the id (fresh start mints a NEW id) — MED-2K9P Chunk 04', () => {
    const sid = 'svc-forget';
    const a = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Forget Me', wsFactory: (u) => new FakeWS(u) });
    assert.notEqual(medusa.getStatus(sid).state, 'off');
    medusa.forgetSession({ projectPath: tempDir, sessionId: sid });
    // Listener stopped...
    assert.deepEqual(medusa.getStatus(sid), { state: 'off', workspaceId: null, unread: 0, lastError: null });
    // ...and the id forgotten — unlike stopSession, a fresh start mints a NEW id.
    const b = medusa.startSession({ projectPath: tempDir, sessionId: sid, name: 'Forget Me', wsFactory: (u) => new FakeWS(u) });
    started.push(sid);
    assert.notEqual(b.workspaceId, a.workspaceId);
  });

  it('forgetSession is a safe no-op for an unknown session and never throws on a bad path', () => {
    assert.doesNotThrow(() => medusa.forgetSession({ projectPath: tempDir, sessionId: 'never-started' }));
    assert.doesNotThrow(() => medusa.forgetSession({ projectPath: '/no/such/dir', sessionId: 'x' }));
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

describe('API — Medusa Chunk 02 routes (toggle / messages / read)', () => {
  let server;
  let port;
  let tempDir;
  let project;
  let active;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-c02-'));
    store._setBasePath(tempDir);
    store.init();
    const projPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-c02-proj-'));
    project = store.projects.create({ name: 'switchboard', path: projPath, engine: 'claude', methodology: 'none' });
    // A real active-session row so getActive resolves (no tmux needed — the row
    // is all the routes read).
    active = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'fake-c02' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
  });

  afterEach(() => {
    // Drop any listener a test started so the module singleton doesn't leak.
    medusa.stopSession(active.id);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path to request.
   * @param {string} method - HTTP method.
   * @param {object|null} [body] - JSON body to send.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  /**
   * Pre-seed a driven-to-listening listener for the active session using a fake
   * socket, so route behavior is deterministic (no real Bridge connection).
   * @returns {FakeWS} The fake socket, already registered + listening.
   */
  function seedListener() {
    let fake;
    const { workspaceId } = medusa.startSession({
      projectPath: project.path, sessionId: active.id, name: project.name,
      wsFactory: (u) => (fake = new FakeWS(u))
    });
    fake._open();
    fake._recv({ type: 'registered', workspaceId, connectionId: 'c1' });
    return fake;
  }

  it('toggle returns 404 for an unknown project', async () => {
    const { status } = await req('/api/sessions/nope/medusa/toggle', 'POST', {});
    assert.equal(status, 404);
  });

  it('toggle returns 409 when the project has no active session', async () => {
    const solo = store.projects.create({
      name: 'no-session', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-c02-nosess-')),
      engine: 'claude', methodology: 'none'
    });
    assert.ok(solo);
    const { status, data } = await req('/api/sessions/no-session/medusa/toggle', 'POST', {});
    assert.equal(status, 409);
    assert.equal(data.code, 'NO_SESSION');
  });

  it('toggle {enabled:false} stops a running listener (→ off)', async () => {
    seedListener();
    assert.equal(medusa.getStatus(active.id).state, 'listening');
    const { status, data } = await req('/api/sessions/switchboard/medusa/toggle', 'POST', { enabled: false });
    assert.equal(status, 200);
    assert.deepEqual(data, { state: 'off', workspaceId: null, unread: 0, lastError: null });
  });

  it('toggle {enabled:true} is idempotent against an already-listening session', async () => {
    const fake = seedListener();
    const before = medusa.getStatus(active.id);
    const { status, data } = await req('/api/sessions/switchboard/medusa/toggle', 'POST', { enabled: true });
    assert.equal(status, 200);
    assert.equal(data.state, 'listening');
    assert.equal(data.workspaceId, before.workspaceId);
    // No second register frame — the existing socket was reused, not replaced.
    assert.equal(fake.sent.filter((f) => JSON.parse(f).type === 'register').length, 1);
  });

  it('toggle with no body flips off→on (starts a listener)', async () => {
    assert.equal(medusa.getStatus(active.id).state, 'off');
    const { status, data } = await req('/api/sessions/switchboard/medusa/toggle', 'POST', null);
    assert.equal(status, 200);
    // Real socket path (no Bridge up in tests) → connecting, honest and non-off.
    assert.notEqual(data.state, 'off');
    assert.match(data.workspaceId, /^switchboard-[0-9a-f]{8}$/);
  });

  it('messages returns the inbox; read clears the unread badge', async () => {
    const fake = seedListener();
    fake._recv({ type: 'new_message', messageId: 'm1', message: { id: 'm1', from: 'peer-a', message: 'ping' } });
    fake._recv({ type: 'new_message', messageId: 'm2', message: { id: 'm2', from: 'peer-b', message: 'pong' } });

    const msgs = await req('/api/sessions/switchboard/medusa/messages', 'GET');
    assert.equal(msgs.status, 200);
    assert.equal(msgs.data.messages.length, 2);
    assert.equal(msgs.data.messages[0].message, 'ping');
    // GET is a pure read — unread is untouched.
    assert.equal(medusa.getStatus(active.id).unread, 2);

    const read = await req('/api/sessions/switchboard/medusa/read', 'POST', {});
    assert.equal(read.status, 200);
    assert.equal(read.data.unread, 0);
    // Messages remain after read (badge cleared, history kept).
    const after = await req('/api/sessions/switchboard/medusa/messages', 'GET');
    assert.equal(after.data.messages.length, 2);
  });

  it('messages returns an empty inbox when no listener is running', async () => {
    const { status, data } = await req('/api/sessions/switchboard/medusa/messages', 'GET');
    assert.equal(status, 200);
    assert.deepEqual(data, { messages: [] });
  });

  it('read is a safe no-op when no listener is running', async () => {
    const { status, data } = await req('/api/sessions/switchboard/medusa/read', 'POST', {});
    assert.equal(status, 200);
    assert.equal(data.state, 'off');
  });
});

describe('lib/sessions — _maybeAutoStartMedusa (per-project auto-enable)', () => {
  let tempDir;
  const sid = 'autostart-sess';

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-autostart-'));
  });

  afterEach(() => {
    medusa.stopSession(sid);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does NOT start a listener when medusaEnabled is absent/false', () => {
    // No project.json medusaEnabled key → default off.
    sessions._maybeAutoStartMedusa({ path: tempDir, name: 'AutoOff' }, { id: sid });
    assert.equal(medusa.getStatus(sid).state, 'off');
  });

  it('starts a listener when medusaEnabled is true', () => {
    store.projectConfig.save(tempDir, { medusaEnabled: true });
    sessions._maybeAutoStartMedusa({ path: tempDir, name: 'AutoOn' }, { id: sid });
    // Real socket path (no Bridge in tests) → honest non-off state, listener present.
    assert.notEqual(medusa.getStatus(sid).state, 'off');
    assert.match(medusa.getStatus(sid).workspaceId, /^autoon-[0-9a-f]{8}$/);
  });

  it('never throws even if start fails (launch must not be bricked)', () => {
    // A bogus project path still must not throw out of the helper.
    assert.doesNotThrow(() => sessions._maybeAutoStartMedusa({ path: '/no/such/dir', name: 'Bad' }, { id: 'x' }));
    medusa.stopSession('x');
  });

  it('_teardownMedusa stops a session listener + forgets its id (MED-2K9P Chunk 04)', () => {
    const project = { path: tempDir, name: 'Teardown' };
    const session = { id: 'teardown-sess' };
    const a = medusa.startSession({ projectPath: project.path, sessionId: session.id, name: project.name, wsFactory: (u) => new FakeWS(u) });
    assert.notEqual(medusa.getStatus(session.id).state, 'off');
    sessions._teardownMedusa(project, session);
    assert.equal(medusa.getStatus(session.id).state, 'off');
    // Id forgotten → a fresh start after teardown mints a new id.
    const b = medusa.startSession({ projectPath: project.path, sessionId: session.id, name: project.name, wsFactory: (u) => new FakeWS(u) });
    medusa.stopSession(session.id);
    assert.notEqual(b.workspaceId, a.workspaceId);
  });

  it('_teardownMedusa is a safe no-op when project or session is missing', () => {
    assert.doesNotThrow(() => sessions._teardownMedusa(null, { id: 'x' }));
    assert.doesNotThrow(() => sessions._teardownMedusa({ path: tempDir }, null));
  });
});

describe('Medusa teardown is wired into EVERY session-end path (MED-2K9P Chunk 04)', () => {
  // The behavioral stop-and-forget is covered above; these source-probes pin that
  // every terminal transition actually calls teardown, so a new end path can't
  // silently strand a live listener (a ghost roster peer) — Critic Chunk 04.
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  /**
   * Slice a named function body out of a source string.
   * @param {string} src - The source.
   * @param {string} name - Function name.
   * @returns {string} The body slice.
   */
  function fnBody(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `function ${name} not found`);
    const next = src.indexOf('\nfunction ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  for (const fn of ['killSession', '_completeV2Wrap', 'completeWrap', 'autoCompleteWrap']) {
    it(`${fn} tears down Medusa`, () => {
      assert.match(fnBody(sessionsSrc, fn), /_teardownMedusa\(/, `${fn} must call _teardownMedusa`);
    });
  }

  it('the stale-wrapping recovery path tears down the recovered session', () => {
    // Inside launchSession; anchor on the recovery marker + the teardown call nearby.
    assert.match(sessionsSrc, /auto-recovered stale wrapping row'\);[\s\S]{0,200}_teardownMedusa\(project, wrapping\)/);
  });

  it('the tunnel-kill path (server.js) forgets the killed webui session', () => {
    assert.match(serverSrc, /Tunnel killed from connection panel'\);[\s\S]{0,200}medusa\.forgetSession\(/);
  });
});

/**
 * A minimal fake Medusa Bridge HTTP server keyed to the verify-api shapes
 * (2026-07-10): `POST /messages/direct` → received / queued / 404-not-found;
 * `GET /workspaces` → a roster. Records every send body so tests can assert the
 * truthful `from` and that a rejected send never reached the Bridge.
 * @returns {{server: import('node:http').Server, received: object[], setRoster: (r: object[]) => void}}
 */
function makeFakeBridge() {
  /** @type {object[]} */
  const received = [];
  /** @type {object[]} */
  let roster = [
    { id: 'live-ws', name: 'Live', listener: { active: true }, connected: true },
    { id: 'offline-ws', name: 'Offline', listener: { active: false }, connected: false }
  ];
  /** @param {import('node:http').ServerResponse} res @param {number} code @param {object} obj @returns {void} */
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST' && req.url === '/messages/direct') {
        received.push(body);
        if (body.to === 'offline-ws') {
          return json(res, 200, { success: true, status: 'queued', id: 'q-1', message: 'Workspace offline. Message queued in Hub inbox.' });
        }
        if (body.to === 'live-ws') {
          return json(res, 200, { success: true, status: 'received', id: 'r-1', message: 'Delivered over WebSocket.' });
        }
        // Mirror the real Bridge: unknown target → 404 not-found (a real failure).
        return json(res, 404, { error: `Peer/Workspace ${body.to} not found.` });
      }
      if (req.method === 'GET' && req.url === '/workspaces') {
        return json(res, 200, { count: roster.length, workspaces: roster, telemetry: {} });
      }
      return json(res, 404, { error: 'unmatched' });
    });
  });
  return { server, received, setRoster: (r) => { roster = r; } };
}

describe('lib/medusa — send / roster (MED-2K9P Chunk 03)', () => {
  let bridge;
  let tempDir;
  const sid = 'c03-svc';
  let workspaceId;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-c03-svc-'));
    bridge = makeFakeBridge();
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${bridge.server.address().port}`);
  });

  beforeEach(() => {
    let fake;
    const status = medusa.startSession({
      projectPath: tempDir, sessionId: sid, name: 'Sender',
      wsFactory: (u) => (fake = new FakeWS(u))
    });
    workspaceId = status.workspaceId;
    fake._open();
    fake._recv({ type: 'registered', workspaceId, connectionId: 'c1' });
    bridge.received.length = 0;
  });

  afterEach(() => {
    medusa.stopSession(sid);
    bridge.setRoster([
      { id: 'live-ws', name: 'Live', listener: { active: true }, connected: true },
      { id: 'offline-ws', name: 'Offline', listener: { active: false }, connected: false }
    ]);
  });

  after(async () => {
    medusa._setBridgeHttpUrl(); // reset to env/default
    await new Promise((resolve) => bridge.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sends to a live target → received, with the session workspace id as a truthful from', async () => {
    const result = await medusa.sendMessage({ sessionId: sid, to: 'live-ws', message: 'hello there' });
    assert.equal(result.status, 'received');
    assert.equal(result.to, 'live-ws');
    assert.equal(bridge.received.length, 1);
    assert.deepEqual(bridge.received[0], { to: 'live-ws', from: workspaceId, message: 'hello there' });
  });

  it('sends to an offline target → queued (not a false "sent")', async () => {
    const result = await medusa.sendMessage({ sessionId: sid, to: 'offline-ws', message: 'ping' });
    assert.equal(result.status, 'queued');
  });

  it('an unknown target is an honest failure, not a silent success', async () => {
    await assert.rejects(
      () => medusa.sendMessage({ sessionId: sid, to: 'ghost-ws', message: 'anyone?' }),
      (err) => {
        assert.equal(err.httpStatus, 502);
        assert.equal(err.code, 'SEND_REJECTED');
        assert.match(err.message, /not found/);
        return true;
      }
    );
  });

  it('rejects an empty message BEFORE hitting the Bridge (Bridge would queue a blank)', async () => {
    await assert.rejects(
      () => medusa.sendMessage({ sessionId: sid, to: 'live-ws', message: '   ' }),
      (err) => { assert.equal(err.code, 'EMPTY_MESSAGE'); assert.equal(err.httpStatus, 400); return true; }
    );
    // Critically: nothing was sent — no blank message reached the Bridge.
    assert.equal(bridge.received.length, 0);
  });

  it('rejects a missing target', async () => {
    await assert.rejects(
      () => medusa.sendMessage({ sessionId: sid, message: 'orphan' }),
      (err) => { assert.equal(err.code, 'NO_TARGET'); return true; }
    );
  });

  it('refuses to send to the session itself', async () => {
    await assert.rejects(
      () => medusa.sendMessage({ sessionId: sid, to: workspaceId, message: 'echo' }),
      (err) => { assert.equal(err.code, 'SELF_TARGET'); return true; }
    );
  });

  it('refuses to send when the session is not listening', async () => {
    medusa.stopSession(sid); // now off
    await assert.rejects(
      () => medusa.sendMessage({ sessionId: sid, to: 'live-ws', message: 'nope' }),
      (err) => { assert.equal(err.code, 'NOT_LISTENING'); assert.equal(err.httpStatus, 409); return true; }
    );
  });

  it('surfaces a Bridge-unreachable failure honestly (no false success)', async () => {
    await assert.rejects(
      () => medusa.sendMessage({
        sessionId: sid, to: 'live-ws', message: 'hi',
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED'))
      }),
      (err) => { assert.equal(err.code, 'BRIDGE_UNREACHABLE'); assert.equal(err.httpStatus, 502); return true; }
    );
  });

  it('roster returns other workspaces and excludes the calling session', async () => {
    bridge.setRoster([
      { id: 'live-ws', name: 'Live' },
      { id: workspaceId, name: 'Self' },
      { id: 'offline-ws', name: 'Offline' }
    ]);
    const roster = await medusa.getRoster({ sessionId: sid });
    const ids = roster.map((w) => w.id);
    assert.ok(ids.includes('live-ws') && ids.includes('offline-ws'));
    assert.ok(!ids.includes(workspaceId), 'own workspace must be excluded');
  });
});

describe('API — Medusa Chunk 03 routes (send / roster)', () => {
  let bridge;
  let server;
  let port;
  let tempDir;
  let project;
  let active;
  let workspaceId;

  before(async () => {
    bridge = makeFakeBridge();
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${bridge.server.address().port}`);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-c03-api-'));
    store._setBasePath(tempDir);
    store.init();
    const projPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-c03-proj-'));
    project = store.projects.create({ name: 'sender', path: projPath, engine: 'claude', methodology: 'none' });
    active = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'fake-c03' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, () => { port = server.address().port; resolve(); }));
  });

  beforeEach(() => {
    let fake;
    const status = medusa.startSession({
      projectPath: project.path, sessionId: active.id, name: project.name,
      wsFactory: (u) => (fake = new FakeWS(u))
    });
    workspaceId = status.workspaceId;
    fake._open();
    fake._recv({ type: 'registered', workspaceId, connectionId: 'c1' });
    bridge.received.length = 0;
  });

  afterEach(() => {
    medusa.stopSession(active.id);
  });

  after(async () => {
    medusa._setBridgeHttpUrl();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => bridge.server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path to request.
   * @param {string} method - HTTP method.
   * @param {object|null} [body] - JSON body.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  it('send returns 404 for an unknown project', async () => {
    const { status } = await req('/api/sessions/nope/medusa/send', 'POST', { to: 'live-ws', message: 'hi' });
    assert.equal(status, 404);
  });

  it('send returns 409 when the project has no active session', async () => {
    store.projects.create({
      name: 'no-session-c03', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-c03-nosess-')),
      engine: 'claude', methodology: 'none'
    });
    const { status, data } = await req('/api/sessions/no-session-c03/medusa/send', 'POST', { to: 'live-ws', message: 'hi' });
    assert.equal(status, 409);
    assert.equal(data.code, 'NO_SESSION');
  });

  it('send delivers to a live target → 200 received', async () => {
    const { status, data } = await req('/api/sessions/sender/medusa/send', 'POST', { to: 'live-ws', message: 'hello' });
    assert.equal(status, 200);
    assert.equal(data.status, 'received');
    assert.equal(bridge.received[0].from, workspaceId);
  });

  it('send to an offline target → 200 queued (surfaced as queued, not sent)', async () => {
    const { status, data } = await req('/api/sessions/sender/medusa/send', 'POST', { to: 'offline-ws', message: 'later' });
    assert.equal(status, 200);
    assert.equal(data.status, 'queued');
  });

  it('send to an unknown target → 502 honest failure', async () => {
    const { status, data } = await req('/api/sessions/sender/medusa/send', 'POST', { to: 'ghost-ws', message: 'anyone?' });
    assert.equal(status, 502);
    assert.equal(data.code, 'SEND_REJECTED');
  });

  it('send with an empty message → 400', async () => {
    const { status, data } = await req('/api/sessions/sender/medusa/send', 'POST', { to: 'live-ws', message: '' });
    assert.equal(status, 400);
    assert.equal(data.code, 'EMPTY_MESSAGE');
  });

  it('roster returns the other workspaces, excluding self', async () => {
    bridge.setRoster([
      { id: 'live-ws', name: 'Live' },
      { id: workspaceId, name: 'Self' }
    ]);
    const { status, data } = await req('/api/sessions/sender/medusa/roster', 'GET');
    assert.equal(status, 200);
    const ids = data.workspaces.map((w) => w.id);
    assert.ok(ids.includes('live-ws'));
    assert.ok(!ids.includes(workspaceId));
    bridge.setRoster([{ id: 'live-ws', name: 'Live' }, { id: 'offline-ws', name: 'Offline' }]);
  });

  it('roster returns 409 when the project has no active session', async () => {
    const { status, data } = await req('/api/sessions/no-session-c03/medusa/roster', 'GET');
    assert.equal(status, 409);
    assert.equal(data.code, 'NO_SESSION');
  });
});

describe('MED-2K9P v2 T1 — workspace-id pre-mint + launch threading', () => {
  const medusaRegistry = require('../lib/medusa-registry');
  let tempDir;
  const started = [];

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-t1-'));
  });

  afterEach(() => {
    while (started.length) medusa.stopSession(started.pop());
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('mintId returns a slug-8hex id and does NOT persist it', () => {
    const id = medusaRegistry.mintId('Pre Mint');
    assert.match(id, /^pre-mint-[0-9a-f]{8}$/);
    // Nothing written — the registry file does not exist yet.
    assert.equal(fs.existsSync(path.join(tempDir, '.tangleclaw', 'medusa', 'registry.json')), false);
  });

  it('mintWorkspaceId (service facade) delegates to the registry mint', () => {
    assert.match(medusa.mintWorkspaceId('Facade Mint'), /^facade-mint-[0-9a-f]{8}$/);
  });

  it('ensureWorkspaceId adopts a preferredId when no entry exists', () => {
    const preferred = medusaRegistry.mintId('Adopt Me');
    const got = medusaRegistry.ensureWorkspaceId(tempDir, 't1-adopt', 'Adopt Me', preferred);
    assert.equal(got, preferred);
    // Persisted: a later preferred-less call returns the adopted id.
    assert.equal(medusaRegistry.ensureWorkspaceId(tempDir, 't1-adopt', 'Adopt Me'), preferred);
  });

  it('ensureWorkspaceId without preferredId keeps an existing entry (stability regression)', () => {
    const first = medusaRegistry.ensureWorkspaceId(tempDir, 't1-stable', 'Stable');
    const second = medusaRegistry.ensureWorkspaceId(tempDir, 't1-stable', 'Stable');
    assert.equal(second, first);
  });

  it('ensureWorkspaceId supersedes a stale differing entry when the launch supplies preferredId', () => {
    const stale = medusaRegistry.ensureWorkspaceId(tempDir, 't1-stale', 'Stale');
    const preferred = medusaRegistry.mintId('Stale');
    const got = medusaRegistry.ensureWorkspaceId(tempDir, 't1-stale', 'Stale', preferred);
    assert.equal(got, preferred);
    assert.notEqual(got, stale);
    // The supersede is durable, not just the return value.
    assert.equal(medusaRegistry.getWorkspaceId(tempDir, 't1-stale'), preferred);
  });

  it('startSession registers under a caller-supplied workspaceId (prime ↔ listener identity seam)', () => {
    const preferred = medusa.mintWorkspaceId('Seam Test');
    const sid = 't1-seam';
    started.push(sid);
    let fake;
    const status = medusa.startSession({
      projectPath: tempDir, sessionId: sid, name: 'Seam Test',
      workspaceId: preferred,
      wsFactory: (u) => (fake = new FakeWS(u))
    });
    assert.equal(status.workspaceId, preferred);
    fake._open();
    // The WS register frame carries the SAME id the prime was given.
    assert.deepEqual(JSON.parse(fake.sent[0]), { type: 'register', workspaceId: preferred });
  });

  it('_maybeAutoStartMedusa threads the pre-minted id through to the listener', () => {
    store.projectConfig.save(tempDir, { medusaEnabled: true });
    const preferred = medusa.mintWorkspaceId('Thread Test');
    const sid = 't1-thread';
    started.push(sid);
    sessions._maybeAutoStartMedusa({ path: tempDir, name: 'Thread Test' }, { id: sid }, preferred);
    assert.equal(medusa.getStatus(sid).workspaceId, preferred);
  });

  it('_maybeAutoStartMedusa without a workspaceId keeps the mint-fresh behavior (webui/toggle path)', () => {
    store.projectConfig.save(tempDir, { medusaEnabled: true });
    const sid = 't1-nothread';
    started.push(sid);
    sessions._maybeAutoStartMedusa({ path: tempDir, name: 'No Thread' }, { id: sid });
    assert.match(medusa.getStatus(sid).workspaceId, /^no-thread-[0-9a-f]{8}$/);
  });
});

describe('MED-2K9P v2 T1 — medusa.readContract (consumer-contract resolution)', () => {
  let tempDir;
  let savedEnv;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-contract-'));
    savedEnv = process.env.MEDUSA_CONTRACT_PATH;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MEDUSA_CONTRACT_PATH;
    else process.env.MEDUSA_CONTRACT_PATH = savedEnv;
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves via the MEDUSA_CONTRACT_PATH env override first', () => {
    const envDoc = path.join(tempDir, 'env-contract.md');
    fs.writeFileSync(envDoc, '# Env Contract\n');
    const projDir = path.join(tempDir, 'medusa-proj');
    fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'docs', 'CONSUMER-CONTRACT.md'), '# Project Contract\n');

    process.env.MEDUSA_CONTRACT_PATH = envDoc;
    const got = medusa.readContract({ medusaProjectPath: projDir });
    assert.equal(got.text, '# Env Contract\n');
    assert.equal(got.source, envDoc);
  });

  it('falls back to <medusaProjectPath>/docs/CONSUMER-CONTRACT.md', () => {
    delete process.env.MEDUSA_CONTRACT_PATH;
    const projDir = path.join(tempDir, 'medusa-proj2');
    fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'docs', 'CONSUMER-CONTRACT.md'), '# Project Contract 2\n');
    const got = medusa.readContract({ medusaProjectPath: projDir });
    assert.equal(got.text, '# Project Contract 2\n');
    assert.equal(got.source, path.join(projDir, 'docs', 'CONSUMER-CONTRACT.md'));
  });

  it('reports every path tried when nothing resolves (honest failure)', () => {
    delete process.env.MEDUSA_CONTRACT_PATH;
    const got = medusa.readContract({ medusaProjectPath: path.join(tempDir, 'nope') });
    assert.equal(got.text, null);
    assert.equal(got.tried.length, 1);
    assert.match(got.tried[0], /CONSUMER-CONTRACT\.md \(ENOENT\)/);
  });

  it('treats an empty contract file as unresolved, not a silent blank injection', () => {
    const emptyDoc = path.join(tempDir, 'empty.md');
    fs.writeFileSync(emptyDoc, '   \n');
    process.env.MEDUSA_CONTRACT_PATH = emptyDoc;
    const got = medusa.readContract({});
    assert.equal(got.text, null);
    assert.match(got.tried[0], /\(empty\)$/);
  });

  it('returns an empty tried list when there are no candidates at all', () => {
    delete process.env.MEDUSA_CONTRACT_PATH;
    const got = medusa.readContract({});
    assert.deepEqual(got, { text: null, tried: [] });
  });
});
