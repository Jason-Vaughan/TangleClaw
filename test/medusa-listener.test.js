'use strict';

/**
 * Tests for the Medusa listener core (MED-2K9P Chunk 01):
 *   - lib/medusa-listener.js — WS client + state machine + inbox
 *   - lib/medusa-registry.js — session↔workspace-id mint/persist/reuse
 *
 * The listener is exercised WITHOUT real networking by injecting a
 * `wsFactory` that returns a `FakeWebSocket` (below). This is the clean seam:
 * the listener attaches handlers via `addEventListener` (as the Node 22 built-in
 * `WebSocket` global supports), and the fake records `send`s + lets a test drive
 * `open`/`message`/`close`/`error` events on demand.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MedusaListener } = require('../lib/medusa-listener');
const registry = require('../lib/medusa-registry');

/** WebSocket readyState constants (subset used by the listener). */
const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

/**
 * Minimal EventTarget-style fake WebSocket for the listener's `wsFactory` seam.
 * Records outbound frames in `sent`, and exposes `_open`/`_message`/`_rawMessage`
 * /`_closeEvent`/`_errorEvent` helpers so a test can drive lifecycle events.
 */
class FakeWebSocket {
  /**
   * @param {string} url - The Bridge URL the listener asked for.
   */
  constructor(url) {
    this.url = url;
    this.readyState = READY.CONNECTING;
    /** @type {string[]} JSON strings the listener sent. */
    this.sent = [];
    this._listeners = Object.create(null);
  }

  /**
   * Register an event handler.
   * @param {string} type - Event name.
   * @param {(event: object) => void} handler - Listener.
   * @returns {void}
   */
  addEventListener(type, handler) {
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  }

  /**
   * Record an outbound frame.
   * @param {string} data - Serialized frame.
   * @returns {void}
   */
  send(data) {
    this.sent.push(data);
  }

  /**
   * Close the socket (sets state; does NOT auto-fire a close event — tests fire
   * events explicitly to model expected vs unexpected closure).
   * @returns {void}
   */
  close() {
    this.readyState = READY.CLOSED;
  }

  /**
   * Dispatch to registered handlers.
   * @param {string} type - Event name.
   * @param {object} event - Event payload.
   * @returns {void}
   */
  _fire(type, event) {
    for (const h of this._listeners[type] || []) h(event);
  }

  /** Simulate the socket opening. @returns {void} */
  _open() {
    this.readyState = READY.OPEN;
    this._fire('open', {});
  }

  /**
   * Simulate an inbound frame from an object (serialized to JSON).
   * @param {object} obj - The frame.
   * @returns {void}
   */
  _message(obj) {
    this._fire('message', { data: JSON.stringify(obj) });
  }

  /**
   * Simulate an inbound raw (possibly malformed) frame string.
   * @param {string} str - Raw payload.
   * @returns {void}
   */
  _rawMessage(str) {
    this._fire('message', { data: str });
  }

  /**
   * Simulate the socket closing.
   * @param {number} [code] - Close code.
   * @returns {void}
   */
  _closeEvent(code = 1006) {
    this.readyState = READY.CLOSED;
    this._fire('close', { code, reason: '' });
  }

  /**
   * Simulate a socket error.
   * @param {string} [message] - Error message.
   * @returns {void}
   */
  _errorEvent(message = 'boom') {
    this._fire('error', { message });
  }
}

/**
 * Build a wsFactory that records every socket it creates.
 * @returns {{factory: (url: string) => FakeWebSocket, sockets: FakeWebSocket[]}}
 */
function makeFactory() {
  const sockets = [];
  const factory = (url) => {
    const s = new FakeWebSocket(url);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

/**
 * Await a fixed delay.
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('MedusaListener', () => {
  it('sends the register frame first on open', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    assert.equal(l.state, 'connecting');
    sockets[0]._open();
    assert.equal(sockets[0].sent.length, 1);
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'register', workspaceId: 'ws-1' });
    l.stop();
  });

  it('transitions to listening on the registered frame', () => {
    const { factory, sockets } = makeFactory();
    const states = [];
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.on('state', (s) => states.push(s));
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1', connectionId: 'conn-x' });
    assert.equal(l.state, 'listening');
    assert.deepEqual(states, ['connecting', 'listening']);
    assert.equal(l.getStatus().state, 'listening');
    l.stop();
  });

  it('pushes a new_message onto the inbox and increments unread', () => {
    const { factory, sockets } = makeFactory();
    const received = [];
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.on('message', (m) => received.push(m));
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    const msg = { id: 'm1', type: 'direct', from: 'ws-2', to: 'ws-1', message: 'hi', timestamp: 1 };
    sockets[0]._message({ type: 'new_message', messageId: 'm1', message: msg });
    assert.equal(l.inbox.length, 1);
    assert.deepEqual(l.inbox[0], msg);
    assert.equal(l.unread, 1);
    assert.deepEqual(received, [msg]);
    l.stop();
  });

  it('preserves FIFO order of a drained backlog', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    for (const id of ['a', 'b', 'c']) {
      sockets[0]._message({ type: 'new_message', messageId: id, message: { id, message: id } });
    }
    assert.deepEqual(l.inbox.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(l.unread, 3);
    l.stop();
  });

  it('markRead resets unread but keeps the inbox', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    sockets[0]._message({ type: 'new_message', message: { id: 'a' } });
    assert.equal(l.unread, 1);
    l.markRead();
    assert.equal(l.unread, 0);
    assert.equal(l.inbox.length, 1);
    l.stop();
  });

  it('tolerates a malformed frame without crashing and stays listening', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.doesNotThrow(() => sockets[0]._rawMessage('{ not json'));
    assert.equal(l.state, 'listening');
    assert.match(l.lastError, /Malformed frame/);
    // Still processes valid frames after a bad one.
    sockets[0]._message({ type: 'new_message', message: { id: 'x' } });
    assert.equal(l.inbox.length, 1);
    l.stop();
  });

  it('tolerates error / pong / heartbeat_ack frames', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.doesNotThrow(() => {
      sockets[0]._message({ type: 'pong', timestamp: 1 });
      sockets[0]._message({ type: 'heartbeat_ack', timestamp: 1, autonomousMode: false });
      sockets[0]._message({ type: 'error', message: 'bad client frame' });
    });
    assert.equal(l.state, 'listening');
    assert.match(l.lastError, /Bridge error/);
    l.stop();
  });

  it('sends a listener_heartbeat after registered', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', heartbeatMs: 10, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    await delay(35);
    const heartbeats = sockets[0].sent
      .map((s) => JSON.parse(s))
      .filter((f) => f.type === 'listener_heartbeat');
    assert.ok(heartbeats.length >= 1, 'expected at least one heartbeat');
    assert.deepEqual(heartbeats[0], { type: 'listener_heartbeat', status: 'active' });
    l.stop();
  });

  it('stop() sets state off and suppresses reconnect', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', backoffBaseMs: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    l.stop();
    assert.equal(l.state, 'off');
    // A close event arriving after stop() must not trigger a reconnect.
    sockets[0]._closeEvent();
    await delay(30);
    assert.equal(sockets.length, 1, 'no new socket should be created after stop()');
    assert.equal(l.state, 'off');
  });

  it('reconnects after an unexpected close (with tiny backoff)', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', backoffBaseMs: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    // Unexpected drop while intended-running.
    sockets[0]._closeEvent(1006);
    assert.equal(l.state, 'connecting');
    await delay(40);
    assert.ok(sockets.length >= 2, 'expected a reconnect socket to be created');
    // The reconnected socket registers again on open.
    sockets[1]._open();
    assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: 'register', workspaceId: 'ws-1' });
    l.stop();
  });

  it('surfaces an error state on socket error and reconnects', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', backoffBaseMs: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._errorEvent('connection refused');
    assert.equal(l.state, 'error');
    assert.match(l.lastError, /connection refused/);
    await delay(40);
    assert.ok(sockets.length >= 2, 'expected a reconnect after error');
    l.stop();
  });

  it('getStatus returns the observable snapshot shape', () => {
    const { factory } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-9', wsFactory: factory });
    const status = l.getStatus();
    assert.deepEqual(Object.keys(status).sort(), ['lastError', 'state', 'unread', 'workspaceId']);
    assert.equal(status.state, 'off');
    assert.equal(status.workspaceId, 'ws-9');
    assert.equal(status.unread, 0);
    assert.equal(status.lastError, null);
  });
});

describe('medusa-registry', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medusa-reg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getWorkspaceId returns null before any mint', () => {
    assert.equal(registry.getWorkspaceId(tmpDir, 42), null);
  });

  it('ensureWorkspaceId mints a valid <slug>-<hex> id', () => {
    const id = registry.ensureWorkspaceId(tmpDir, 42, 'My Project!');
    assert.match(id, /^my-project-[0-9a-f]{8}$/);
  });

  it('ensureWorkspaceId reuses the same id on a second call (persistence)', () => {
    const first = registry.ensureWorkspaceId(tmpDir, 42, 'proj');
    const second = registry.ensureWorkspaceId(tmpDir, 42, 'proj');
    assert.equal(first, second);
    // getWorkspaceId reads it back from disk.
    assert.equal(registry.getWorkspaceId(tmpDir, 42), first);
  });

  it('id survives a simulated restart (fresh read from disk)', () => {
    const id = registry.ensureWorkspaceId(tmpDir, 7, 'proj');
    // No in-memory cache — a fresh getWorkspaceId reads the persisted file.
    assert.equal(registry.getWorkspaceId(tmpDir, 7), id);
    // Persisted at the documented path.
    const file = path.join(tmpDir, '.tangleclaw', 'medusa', 'registry.json');
    assert.ok(fs.existsSync(file));
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data['7'].workspaceId, id);
  });

  it('distinct sessions get distinct ids', () => {
    const a = registry.ensureWorkspaceId(tmpDir, 1, 'proj');
    const b = registry.ensureWorkspaceId(tmpDir, 2, 'proj');
    assert.notEqual(a, b);
  });

  it('slugifies a name with no alphanumerics to a workspace fallback', () => {
    const id = registry.ensureWorkspaceId(tmpDir, 3, '!!!');
    assert.match(id, /^workspace-[0-9a-f]{8}$/);
  });

  it('forgetWorkspace removes an entry and returns true; false when absent', () => {
    registry.ensureWorkspaceId(tmpDir, 5, 'proj');
    assert.equal(registry.forgetWorkspace(tmpDir, 5), true);
    assert.equal(registry.getWorkspaceId(tmpDir, 5), null);
    assert.equal(registry.forgetWorkspace(tmpDir, 5), false);
  });

  it('treats a corrupt registry.json as empty (no throw)', () => {
    const dir = path.join(tmpDir, '.tangleclaw', 'medusa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'registry.json'), '{ not valid json', 'utf8');
    assert.doesNotThrow(() => {
      assert.equal(registry.getWorkspaceId(tmpDir, 1), null);
    });
    // And still mints fresh over the corrupt file.
    const id = registry.ensureWorkspaceId(tmpDir, 1, 'proj');
    assert.match(id, /^proj-[0-9a-f]{8}$/);
  });
});
