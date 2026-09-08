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

const {
  MedusaListener, DEFAULT_MAX_INBOX, SYSTEM_MESSAGE_RETENTION, _setSystemMessageRetention
} = require('../lib/medusa-listener');
const registry = require('../lib/medusa-registry');
const logger = require('../lib/logger');

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

describe('the register handshake has a deadline (#1131)', () => {
  // Deliberately driven through the `wsFactory` seam rather than a real loopback
  // Bridge. A real socket would prove the same property while scoring host
  // scheduling, and this repo already carries an intermittently-red wall-clock
  // guard for exactly that reason (#1205). The seam asserts the mechanism
  // deterministically; the real-network behaviour was confirmed by probe before
  // this was written, and is recorded in the build plan rather than in a test
  // that would flake on a loaded machine.

  it('a Bridge that upgrades and never answers `register` fails instead of waiting forever', async () => {
    // The defect: `_onOpen` sends the register frame and NOTHING else ever fires.
    // The socket is open and healthy as far as the client is concerned, so no
    // close, no error, and the reconnect loop is never entered — the listener
    // parks in `connecting` indefinitely.
    const { factory, sockets } = makeFactory();
    // Two timing margins, both deliberate. The backoff (30ms) is longer than the
    // deadline (60ms is longer still) so the `error` state is observable — with a
    // short backoff the reconnect flips it to `connecting` before an assertion can
    // read it, which says nothing about the deadline. And the REPLACEMENT socket
    // gets its own 60ms deadline, so the recovery half polls for it rather than
    // sleeping a guessed interval: sleeping past it would find a socket the
    // listener has already abandoned, and read as a broken fix.
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 60, backoffBaseMs: 30, wsFactory: factory
    });
    l.start();
    sockets[0]._open();
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).type, 'register');
    assert.equal(l.state, 'connecting');

    await delay(80);
    assert.equal(l.state, 'error');
    assert.match(l.lastError, /did not complete the register handshake/);
    assert.equal(sockets.length, 1, 'the reconnect should still be backing off here');

    // And it recovers on its own once the Bridge starts answering — no restart.
    const until = Date.now() + 1000;
    while (sockets.length === 1 && Date.now() < until) await delay(5);
    const next = sockets[sockets.length - 1];
    assert.notEqual(next, sockets[0], 'the deadline should have driven a reconnect');
    next._open();
    next._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    assert.equal(l.lastError, null);
    l.stop();
  });

  it('abandons the stalled socket rather than leaving it open and ignored', async () => {
    // The socket may be perfectly healthy, so nothing else will ever end it. An
    // abandoned-but-live socket keeps receiving frames the identity guard drops
    // silently, which is a leak wearing the costume of a working connection.
    const { factory, sockets } = makeFactory();
    // The backoff MUST outlast this assertion. `_connect` closes the prior socket
    // when it reconnects, so with a short backoff this passes whether or not the
    // deadline closed anything — it would be measuring the reconnect's cleanup.
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 20, backoffBaseMs: 500, wsFactory: factory
    });
    l.start();
    sockets[0]._open();
    await delay(50);
    assert.equal(sockets.length, 1, 'no reconnect yet — so only the deadline can have closed it');
    assert.equal(sockets[0].readyState, READY.CLOSED, 'the stalled socket should have been closed');
    l.stop();
  });

  it('bounds a socket that never opens at all — a filtered port fires no event', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 60, backoffBaseMs: 200, wsFactory: factory
    });
    l.start();
    assert.equal(sockets.length, 1);
    // No _open, no _errorEvent, no _closeEvent — the SYN went nowhere.
    assert.equal(l.state, 'connecting');
    await delay(90);
    assert.equal(l.state, 'error');
    assert.match(l.lastError, /did not complete the register handshake/);
    l.stop();
  });

  it('never fires on a healthy register', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 20, backoffBaseMs: 5, wsFactory: factory
    });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    await delay(50); // well past the deadline
    assert.equal(l.state, 'listening');
    assert.equal(l.lastError, null);
    assert.equal(sockets.length, 1, 'a listening socket should not have been replaced');
    l.stop();
  });

  it('does not overwrite a truthful lastError while a reconnect is backing off', async () => {
    // The deadline is armed per attempt. If a connection is REFUSED it must stay
    // refused: an armed deadline expiring mid-backoff would relabel a socket
    // error as a handshake timeout and describe a socket that is long gone.
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 20, backoffBaseMs: 200, wsFactory: factory
    });
    l.start();
    sockets[0]._errorEvent('connection refused');
    assert.match(l.lastError, /Socket error/);
    await delay(60); // past the handshake deadline, still inside the backoff
    assert.match(l.lastError, /Socket error/, 'the refusal must survive the backoff window');
    l.stop();
  });

  it('stop() disarms the deadline AND a stopped listener stays off', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 20, backoffBaseMs: 5, wsFactory: factory
    });
    l.start();
    sockets[0]._open();
    l.stop();
    // Asserted on the timer itself, not only on the outcome: the deadline's own
    // `_intendedRunning` guard makes a LEAKED timer harmless, so the behavioural
    // half below passes whether or not `_clearTimers` owns this timer. Only the
    // field says whether stop() actually disarmed it.
    assert.equal(l._handshakeTimer, null, 'stop() must disarm the handshake deadline');
    await delay(40);
    assert.equal(l.state, 'off');
    assert.equal(sockets.length, 1, 'a stopped listener must not reconnect');
  });

  it('REGRESSION (#1131 as filed): an absent Bridge that later appears is registered without a restart', async () => {
    // The mechanism the issue reported as broken. It was already correct — a
    // live-loopback probe registered within 5ms of a healthy Bridge appearing —
    // so this pins behaviour rather than fixing it: `_connect` builds a FRESH
    // socket every attempt and no state survives a failure. Kept because the
    // reported scenario must not silently regress just because its filed
    // mechanism turned out to be the wrong diagnosis.
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({
      workspaceId: 'ws-1', handshakeTimeoutMs: 500, backoffBaseMs: 5, wsFactory: factory
    });
    l.start();
    for (let i = 0; i < 3; i++) {
      sockets[sockets.length - 1]._errorEvent('ECONNREFUSED');
      sockets[sockets.length - 1]._closeEvent(1006);
      await delay(20);
    }
    assert.ok(sockets.length > 1, 'the reconnect loop should have built new sockets');
    const healthy = sockets[sockets.length - 1];
    healthy._open();
    healthy._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    assert.equal(l.lastError, null);
    l.stop();
  });
});

describe('connection-outcome logs name the URL that was tried (#1100)', () => {
  /**
   * Capture info-and-above while `fn` runs, restoring the quiet test posture.
   * @param {() => void} fn - Work to run while capturing.
   * @returns {string[]} The captured lines.
   */
  function captureLog(fn) {
    const lines = [];
    logger.setLevel('info');
    logger.setConsoleStream({ write: (line) => lines.push(line) });
    try {
      fn();
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
    return lines;
  }

  it('every outcome line carries bridgeUrl, so a URL pointing at nothing is diagnosable', () => {
    // While the URL was a constant, its absence from these lines cost nothing —
    // ws://localhost:3010 was the only value there could be. It is now derived
    // (env, then port arithmetic, then a possible loopback fallback), so an
    // operator aimed at the wrong port would otherwise see only generic
    // reconnect churn: the wrong-cause diagnosis #1130 was filed about.
    const { factory, sockets } = makeFactory();
    const url = 'ws://localhost:4321';
    const l = new MedusaListener({ bridgeUrl: url, workspaceId: 'ws-log', backoffBaseMs: 5, wsFactory: factory });
    const lines = captureLog(() => {
      l.start();
      sockets[0]._open();
      sockets[0]._message({ type: 'registered', workspaceId: 'ws-log' });
      sockets[0]._errorEvent('nope');
      sockets[0]._closeEvent(1006);
    });
    l.stop();

    for (const marker of [
      'Medusa socket open; registering',
      'Medusa registered; listening',
      'Medusa socket error',
      'Medusa socket closed unexpectedly',
      'Scheduling Medusa reconnect'
    ]) {
      const line = lines.find((x) => x.includes(marker));
      assert.ok(line, `expected a line for ${marker}`);
      assert.ok(line.includes(url), `${marker} should name the URL it tried`);
    }
  });
});


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

  it('caps the inbox at maxInbox, dropping the oldest', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', maxInbox: 3, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      sockets[0]._message({ type: 'new_message', messageId: id, message: { id, message: id } });
    }
    // Oldest two ('a','b') dropped; most-recent three retained in order.
    assert.deepEqual(l.inbox.map((m) => m.id), ['c', 'd', 'e']);
    assert.equal(l.unread, 5); // unread counter is independent of the cap.
    l.stop();
  });

  it('markRead resets unread but keeps the inbox (badge clear only)', () => {
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

  it('a badge clear never acks — the Hub keeps its durable copies (#785)', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    sockets[0]._message({ type: 'new_message', messageId: 'a', message: { id: 'a' } });
    l.markRead();
    const acks = sockets[0].sent.map((x) => JSON.parse(x)).filter((f) => f.type === 'ack');
    assert.deepEqual(acks, [], 'clearing the badge must not drop the Hub copy');
    assert.equal(l.inbox.length, 1, 'clearing the badge must not discard mail');
    l.stop();
  });

  it('markHandled removes exactly the named messages from the inbox', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    for (const id of ['a', 'b', 'c']) {
      sockets[0]._message({ type: 'new_message', messageId: id, message: { id } });
    }
    l.markHandled(['a', 'c']);
    assert.deepEqual(l.inbox.map((m) => m.id), ['b']);
    assert.equal(l.unread, 1);
    l.stop();
  });

  it('markHandled matches a message whose body id differs from its envelope id', () => {
    // `GET /messages` hands out message BODIES, so a consumer names a message by
    // the body's `id`. If that ever diverges from the envelope's `messageId`,
    // envelope-only matching would silently no-op: nothing would leave the inbox,
    // nothing would be acked, and the Hub would re-flood on every reconnect.
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    sockets[0]._message({ type: 'new_message', messageId: 'env-1', message: { id: 'body-1' } });
    l.markHandled(['body-1']);
    assert.equal(l.inbox.length, 0, 'a body-id report must remove the message');
    const acks = sockets[0].sent.map((x) => JSON.parse(x)).filter((f) => f.type === 'ack');
    assert.deepEqual(acks[0].messageIds, ['env-1'], 'the ack must carry the id the HUB knows');
    l.stop();
  });

  it('markHandled ignores unknown ids and is safe to replay', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    sockets[0]._message({ type: 'new_message', messageId: 'a', message: { id: 'a' } });
    l.markHandled(['nope']);
    assert.equal(l.inbox.length, 1);
    assert.equal(l.unread, 1);
    l.markHandled(['a']);
    l.markHandled(['a']);
    assert.equal(l.inbox.length, 0);
    assert.equal(l.unread, 0);
    l.stop();
  });

  it('un-handled mail survives a listener replacement; handled mail does not come back', () => {
    // The reachable #785 trigger: a Medusa toggle cycle (or a TC restart) keeps
    // the registry's workspace id and builds a FRESH listener, so the in-memory
    // inbox is discarded while the session still reports `listening`. Because
    // only handled mail is acked, the Hub still holds the rest and re-drains it.
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    sockets[0]._message({ type: 'new_message', messageId: 'seen', message: { id: 'seen' } });
    sockets[0]._message({ type: 'new_message', messageId: 'unseen', message: { id: 'unseen' } });
    l.markHandled(['seen']);
    sockets[0]._message({ type: 'ack_response', success: true, messageIds: ['seen'] });

    // Replacement: a brand-new listener under the SAME workspace id.
    l.stop();
    const fresh = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    fresh.start();
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    // The Hub drains what it still holds — the un-handled message only.
    sockets[1]._message({ type: 'new_message', messageId: 'unseen', message: { id: 'unseen' } });
    assert.deepEqual(fresh.inbox.map((m) => m.id), ['unseen']);
    fresh.stop();
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

  // ── MED-2K9P Chunk 04: resilience hardening ──

  it('de-dups a repeated messageId (no double-inject / double-unread)', () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    const env = { type: 'new_message', messageId: 'dup-1', message: { id: 'dup-1', message: 'once' } };
    sockets[0]._message(env);
    sockets[0]._message(env); // exact duplicate (e.g. drain overlapping a live push)
    assert.equal(l.inbox.length, 1, 'duplicate must not be re-injected');
    assert.equal(l.unread, 1, 'duplicate must not re-increment unread');
    // A different messageId still lands.
    sockets[0]._message({ type: 'new_message', messageId: 'dup-2', message: { id: 'dup-2', message: 'twice' } });
    assert.equal(l.inbox.length, 2);
    l.stop();
  });

  it('a late event from a superseded socket cannot perturb live state (identity guard)', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', backoffBaseMs: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    // Force a reconnect: the old socket (sockets[0]) is now superseded.
    sockets[0]._closeEvent(1006);
    await delay(40);
    assert.ok(sockets.length >= 2, 'expected a reconnect socket');
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    // The OLD socket now fires late events — they must be ignored entirely.
    sockets[0]._errorEvent('late error from dead socket');
    sockets[0]._closeEvent(1011);
    sockets[0]._message({ type: 'new_message', messageId: 'ghost', message: { id: 'ghost' } });
    assert.equal(l.state, 'listening', 'stale socket must not flip state');
    assert.equal(l.inbox.length, 0, 'stale socket must not inject a message');
    assert.equal(l.lastError, null, 'stale socket must not set lastError');
    l.stop();
  });

  it('recovers to listening after a Bridge drop and reconnect', async () => {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', backoffBaseMs: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    // Bridge drops.
    sockets[0]._closeEvent(1006);
    assert.equal(l.state, 'connecting');
    assert.match(l.lastError, /closed/);
    // Reconnect + re-register → back to listening, error cleared.
    await delay(40);
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(l.state, 'listening');
    assert.equal(l.lastError, null);
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

describe('MedusaListener — ACK-on-handled (TC#547, narrowed by #785)', () => {
  /**
   * Parse a socket's outbound `ack` frames.
   * @param {FakeWebSocket} socket - The fake socket.
   * @returns {Array<{type: string, messageIds: string[]}>} Ack frames, in order.
   */
  function ackFrames(socket) {
    return socket.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'ack');
  }

  /**
   * Start a listener, register it, and deliver the given envelope ids.
   * @param {string[]} ids - Envelope messageIds to deliver.
   * @returns {{l: MedusaListener, sockets: FakeWebSocket[]}}
   */
  function listeningWith(ids) {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-1', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-1' });
    for (const id of ids) {
      sockets[0]._message({ type: 'new_message', messageId: id, message: { id, message: id } });
    }
    return { l, sockets };
  }

  it('does NOT ack on receipt — an unread message stays queued Hub-side', () => {
    const { l, sockets } = listeningWith(['m1', 'm2']);
    assert.equal(ackFrames(sockets[0]).length, 0);
    l.stop();
  });

  it('markHandled acks every handled message id in one frame', () => {
    const { l, sockets } = listeningWith(['m1', 'm2']);
    l.markHandled(['m1', 'm2']);
    const acks = ackFrames(sockets[0]);
    assert.equal(acks.length, 1);
    assert.deepEqual(acks[0].messageIds.sort(), ['m1', 'm2']);
    l.stop();
  });

  it('a confirmed ack is not re-sent on the next markHandled or reconnect (multi-hop)', () => {
    const { l, sockets } = listeningWith(['m1']);
    l.markHandled(['m1']);
    sockets[0]._message({ type: 'ack_response', success: true, messageIds: ['m1'] });
    // Hop 2: re-reporting the same id sends nothing new.
    l.markHandled(['m1']);
    assert.equal(ackFrames(sockets[0]).length, 1);
    // Hop 3: a reconnect re-register must not re-flush a confirmed ack.
    sockets[0]._closeEvent();
    // (reconnect is timer-driven; drive a fresh connect deterministically)
    l.stop();
    l.start();
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(ackFrames(sockets[1]).length, 0);
    l.stop();
  });

  it('an UNconfirmed ack re-flushes on the next registered handshake (lost-frame retry)', () => {
    const { l, sockets } = listeningWith(['m1', 'm2']);
    l.markHandled(['m1', 'm2']); // ack sent, but the Hub never answers (lost frame)
    l.stop();
    l.start();
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    const acks = ackFrames(sockets[1]);
    assert.equal(acks.length, 1);
    assert.deepEqual(acks[0].messageIds.sort(), ['m1', 'm2']);
    // The Hub's post-register drain redelivers the un-acked messages; the
    // de-dup keeps them out of the inbox AND unread stays read (no re-badge).
    sockets[1]._message({ type: 'new_message', messageId: 'm1', message: { id: 'm1', message: 'm1' } });
    assert.equal(l.unread, 0);
    // Both were handled, so both left the inbox; the redelivery is de-duped.
    assert.equal(l.inbox.length, 0);
    l.stop();
  });

  it('a failed ack_response leaves ids awaiting (never confirmed-by-assumption)', () => {
    const { l, sockets } = listeningWith(['m1']);
    l.markHandled(['m1']);
    sockets[0]._message({ type: 'ack_response', success: false, messageIds: ['m1'] });
    l.stop();
    l.start();
    sockets[1]._open();
    sockets[1]._message({ type: 'registered', workspaceId: 'ws-1' });
    assert.equal(ackFrames(sockets[1]).length, 1, 'unconfirmed id must re-flush');
    l.stop();
  });

  it('messages handled AFTER an earlier confirmed batch ack independently', () => {
    const { l, sockets } = listeningWith(['m1']);
    l.markHandled(['m1']);
    sockets[0]._message({ type: 'ack_response', success: true, messageIds: ['m1'] });
    sockets[0]._message({ type: 'new_message', messageId: 'm2', message: { id: 'm2', message: 'm2' } });
    assert.equal(l.unread, 1);
    l.markHandled(['m2']);
    const acks = ackFrames(sockets[0]);
    assert.equal(acks.length, 2);
    assert.deepEqual(acks[1].messageIds, ['m2']);
    l.stop();
  });

  it('a message with no envelope id is readable without acking (nothing to ack)', () => {
    const { l, sockets } = listeningWith([]);
    sockets[0]._message({ type: 'new_message', message: { id: 'x', message: 'no envelope id' } });
    assert.equal(l.unread, 1);
    l.markRead();
    assert.equal(l.unread, 0);
    assert.equal(ackFrames(sockets[0]).length, 0);
    l.stop();
  });
});

/*
 * #1108, half two — an inbox nobody drains still has a ceiling.
 *
 * `medusa-wake` skips a session whose engine has no wake profile, forever and
 * by design: guessing an engine's idle signature is the false-idle hazard that
 * module exists to prevent. So no consumer ever reports that session's mail
 * handled, nothing ever ACKs it, and its inbox is append-only for the life of
 * the workspace id. `maxInbox` is not a drain — it drops the oldest entry
 * locally while the Hub keeps its durable copy and re-floods on the next
 * reconnect.
 *
 * The boundary this must not cross: only a SYSTEM broadcast may be drained. A
 * peer-to-peer message has a sender waiting on it and the switchboard's rule is
 * that the initiator closes the loop, so expiring one would close somebody
 * else's exchange silently. The property keyed on is the envelope's
 * `from === 'system'` rather than anything in the payload, which any peer can
 * write. That `from` is trustworthy because TANGLECLAW fills it — the Bridge
 * copies what its caller supplies, while `/medusa/send` reads only `to` and
 * `message` and `lib/medusa.js#sendMessage` uses the sending listener's own
 * workspace id (pinned in `test/api-medusa.test.js`).
 */
describe('MedusaListener — the system-broadcast drain (#1108)', () => {
  /**
   * Parse a socket's outbound `ack` frames.
   * @param {FakeWebSocket} socket - The fake socket.
   * @returns {Array<{type: string, messageIds: string[]}>} Ack frames, in order.
   */
  function ackFrames(socket) {
    return socket.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'ack');
  }

  /**
   * Every envelope id this socket has ACKed, across all frames.
   * @param {FakeWebSocket} socket - The fake socket.
   * @returns {string[]} Acked ids.
   */
  function ackedIds(socket) {
    return ackFrames(socket).flatMap((f) => f.messageIds);
  }

  /** Start and register a listener. @returns {{l: MedusaListener, sockets: FakeWebSocket[]}} */
  function listening() {
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-unprofiled', wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-unprofiled' });
    return { l, sockets };
  }

  /**
   * Deliver a broadcast in the shape `sendSystemMessage` produces.
   * @param {FakeWebSocket} socket - The fake socket.
   * @param {string} id - Envelope id.
   * @param {string} [doc] - Doc name carried in the payload.
   * @returns {void}
   */
  function deliverSystem(socket, id, doc = 'BOARD') {
    socket._message({
      type: 'new_message',
      messageId: id,
      message: {
        id, from: 'system', to: 'ws-unprofiled',
        message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc })
      }
    });
  }

  /**
   * Deliver a peer-to-peer message — one with a sender waiting on a reply.
   * @param {FakeWebSocket} socket - The fake socket.
   * @param {string} id - Envelope id.
   * @returns {void}
   */
  function deliverPeer(socket, id) {
    socket._message({
      type: 'new_message',
      messageId: id,
      message: { id, from: 'ws-a-real-peer', to: 'ws-unprofiled', message: 'are you there?' }
    });
  }

  afterEach(() => { _setSystemMessageRetention(SYSTEM_MESSAGE_RETENTION); });

  it('bounds an inbox that nothing ever drains', () => {
    _setSystemMessageRetention(3);
    const { l, sockets } = listening();
    for (let i = 0; i < 50; i++) deliverSystem(sockets[0], `s${i}`);

    assert.equal(l.inbox.length, 3,
      'nothing here ever reports a message handled — the cap is the only ceiling');
    assert.equal(l.unread, 3,
      'a badge counting mail that no longer exists is a count nothing can explain');
    l.stop();
  });

  it('drains the OLDEST and keeps the newest — the freshest change is the one worth having', () => {
    _setSystemMessageRetention(2);
    const { l, sockets } = listening();
    for (const id of ['s1', 's2', 's3', 's4']) deliverSystem(sockets[0], id);

    assert.deepEqual(l.inbox.map((m) => m.id), ['s3', 's4']);
    l.stop();
  });

  it('ACKs what it drains, so the Hub stops re-flooding it', () => {
    // This is the whole difference from `maxInbox`, which drops locally and
    // leaves the durable copy queued: the message comes straight back on the
    // next reconnect and the inbox is unbounded again through a second door.
    _setSystemMessageRetention(1);
    const { l, sockets } = listening();
    for (const id of ['s1', 's2', 's3']) deliverSystem(sockets[0], id);

    // De-duplicated: `_flushAcks` re-sends every id still awaiting the Hub's
    // `ack_response`, and this fake never answers, so an id legitimately
    // appears in more than one frame. What matters is which ids were ACKed.
    assert.deepEqual([...new Set(ackedIds(sockets[0]))].sort(), ['s1', 's2'],
      'a drained message must stop existing, not stop being visible');
    assert.ok(!ackedIds(sockets[0]).includes('s3'),
      'and the message still in the inbox must stay queued Hub-side, un-ACKed');
    l.stop();
  });

  it('NEVER drains a peer message — the initiator closes the loop, not the cap', () => {
    // The assertion that pins the boundary. A peer is blocked on this reply;
    // expiring it closes their exchange without them knowing.
    _setSystemMessageRetention(1);
    const { l, sockets } = listening();
    deliverPeer(sockets[0], 'p1');
    for (let i = 0; i < 20; i++) deliverSystem(sockets[0], `s${i}`);

    const froms = l.inbox.map((m) => m.from);
    assert.ok(froms.includes('ws-a-real-peer'),
      'a peer\'s unanswered message survives any volume of broadcast');
    assert.ok(!ackedIds(sockets[0]).includes('p1'),
      'and is never ACKed out of the Hub behind its sender\'s back');
    l.stop();
  });

  it('does not count peer messages toward the system cap', () => {
    // Counting them would let a peer conversation evict the broadcasts, and a
    // burst of broadcasts evict itself early — the cap must describe one
    // population, not two.
    _setSystemMessageRetention(3);
    const { l, sockets } = listening();
    for (const id of ['p1', 'p2', 'p3', 'p4']) deliverPeer(sockets[0], id);
    for (const id of ['s1', 's2', 's3']) deliverSystem(sockets[0], id);

    assert.equal(l.inbox.filter((m) => m.from === 'system').length, 3,
      'three system messages against a cap of three is at the cap, not over it');
    assert.equal(l.inbox.filter((m) => m.from !== 'system').length, 4,
      'and every peer message is still there');
    l.stop();
  });

  it('keys on the envelope sender, not on the payload a peer can write', () => {
    _setSystemMessageRetention(1);
    const { l, sockets } = listening();
    sockets[0]._message({
      type: 'new_message',
      messageId: 'forged',
      message: {
        id: 'forged', from: 'ws-a-real-peer',
        message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'BOARD' })
      }
    });
    for (const id of ['s1', 's2']) deliverSystem(sockets[0], id);

    assert.ok(l.inbox.some((m) => m.id === 'forged'),
      'a peer typing "type":"system" into its body must not make its own message expirable');
    l.stop();
  });

  it('a retention of 0 keeps everything — the cap is disableable, and off is off', () => {
    _setSystemMessageRetention(0);
    const { l, sockets } = listening();
    for (let i = 0; i < 30; i++) deliverSystem(sockets[0], `s${i}`);

    assert.equal(l.inbox.length, 30);
    assert.equal(ackedIds(sockets[0]).length, 0);
    l.stop();
  });

  it('bounds the unconfirmed-ack set, so an unanswering Hub cannot reproduce the leak elsewhere', () => {
    // The drain adds one id per arrival on exactly the sessions with no consumer,
    // and ids leave `_ackAwaiting` only on a Hub `ack_response` this fake never
    // sends. Unbounded, that is #1108's end state one collection over, with
    // `_flushAcks` re-sending the whole set every time.
    _setSystemMessageRetention(1);
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-unprofiled', maxInbox: 5, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-unprofiled' });
    for (let i = 0; i < 40; i++) deliverSystem(sockets[0], `s${i}`);

    assert.ok(l._ackAwaiting.size <= 5,
      'every other collection on the receive path is capped; this one was not');
    const last = ackFrames(sockets[0]).at(-1);
    assert.ok(last.messageIds.length <= 5,
      'and the frame it sends must not grow with the number of messages ever drained');
    l.stop();
  });

  it('an evicted ack id leaves its message queued Hub-side rather than being re-ACKed forever', () => {
    // The cost of the bound, stated as a test: eviction is allowed precisely
    // because the at-least-once contract already covers it.
    _setSystemMessageRetention(1);
    const { factory, sockets } = makeFactory();
    const l = new MedusaListener({ workspaceId: 'ws-unprofiled', maxInbox: 2, wsFactory: factory });
    l.start();
    sockets[0]._open();
    sockets[0]._message({ type: 'registered', workspaceId: 'ws-unprofiled' });
    for (let i = 0; i < 10; i++) deliverSystem(sockets[0], `s${i}`);

    const last = ackFrames(sockets[0]).at(-1);
    assert.ok(!last.messageIds.includes('s0'),
      'the oldest unconfirmed id is the one a responsive Hub would have answered by now');
    l.stop();
  });

  it('ships with a cap that is actually a ceiling, and a distinct one', () => {
    // The call site's policy argument is code. Stated as a RELATION rather than
    // a number, because the number was re-decided once already (#1108 review:
    // 20 sat below the 43 documents this install's largest group holds, so it
    // bound the ordinary case instead of backstopping it) and a test asserting
    // a literal would have to be re-decided alongside it. What must stay true:
    // it bounds something, and it is not a second name for the memory bound —
    // if it reached `maxInbox` the drain would never fire before the silent
    // local shift already did. How much headroom it leaves over a real group's
    // document count is a fact about the install, recorded where it was
    // measured, in the constant's own JSDoc.
    assert.ok(SYSTEM_MESSAGE_RETENTION > 0,
      'a cap of zero disables the drain, and every test above would measure a seam nothing reaches');
    assert.ok(SYSTEM_MESSAGE_RETENTION < DEFAULT_MAX_INBOX,
      'a cap at or above maxInbox never fires — the memory shift gets there first, silently');
    const { l, sockets } = listening();
    for (let i = 0; i < SYSTEM_MESSAGE_RETENTION + 5; i++) deliverSystem(sockets[0], `s${i}`);
    assert.equal(l.inbox.length, SYSTEM_MESSAGE_RETENTION,
      'the shipped default must be the one that applies with no seam touched');
    l.stop();
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
