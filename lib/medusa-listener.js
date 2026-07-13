'use strict';

/**
 * Per-session Medusa Bridge WebSocket listener (MED-2K9P Chunk 01).
 *
 * A `MedusaListener` is an in-TC-server WebSocket client that registers a
 * workspace against the Medusa Bridge, receives inbound messages (both the
 * post-`registered` offline-queue drain and live pushes), keeps its presence
 * fresh with periodic `listener_heartbeat` frames, and exposes an observable
 * state machine plus an in-memory inbox. It owns the WS connection ONLY — no
 * HTTP, no Express, no persistence (that lives in `medusa-registry.js`).
 *
 * The Bridge contract this speaks (verified — see
 * `.prawduct/artifacts/api-notes-medusa.md`):
 *   - client → `{ type:'register', workspaceId }` on open
 *   - server → `{ type:'registered', ... }`, then drains the offline queue FIFO
 *     as `{ type:'new_message', messageId, message:{...} }`, then live pushes
 *     arrive as the same `new_message` envelope
 *   - keepalive: client → `{ type:'listener_heartbeat', status:'active' }`,
 *     server → `{ type:'heartbeat_ack', ... }`
 *   - `{ type:'pong' }` / `{ type:'error', message }` frames are tolerated
 *
 * Trust model is trusted-local loopback — the WS path is unauthenticated at the
 * workspace layer, so the Bridge URL must stay bound to localhost.
 *
 * The `wsFactory` constructor option is the test seam: it defaults to the Node
 * 22 built-in `WebSocket` global, and tests inject a fake so the listener can be
 * exercised with no real networking.
 */

const EventEmitter = require('node:events');
const { createLogger } = require('./logger');

const log = createLogger('medusa-listener');

/**
 * @type {string} Default Bridge WebSocket URL (loopback per the trust model).
 * NOTE: Medusa serves its WS on the HTTP port + 1 (HTTP `:3009` → WS `:3010`,
 * `medusa-server.js` `protocolPort + 1`). Consumers that know only the HTTP port
 * must add 1 for the WS URL. Verified via live smoke 2026-07-10.
 */
const DEFAULT_BRIDGE_URL = 'ws://localhost:3010';
/** @type {number} Default heartbeat cadence in milliseconds. */
const DEFAULT_HEARTBEAT_MS = 20000;
/** @type {number} Default reconnect backoff base in milliseconds. */
const DEFAULT_BACKOFF_BASE_MS = 1000;
/** @type {number} Maximum reconnect backoff in milliseconds (cap). */
const MAX_BACKOFF_MS = 30000;
/**
 * @type {number} Default cap on the in-memory inbox. Oldest messages are dropped
 * beyond this so an always-on listening session can't grow memory without bound
 * (v1 badge-receive is low-volume; the unread counter is independent of the cap).
 */
const DEFAULT_MAX_INBOX = 500;
/** @type {number} WebSocket `readyState` value for an OPEN socket. */
const WS_OPEN = 1;

/**
 * An observable per-session Medusa listener.
 *
 * Emits:
 *   - `'state'` with the new state string on every state transition.
 *   - `'message'` with the inner `message` object on each received `new_message`.
 *
 * @extends EventEmitter
 */
class MedusaListener extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.bridgeUrl] - Bridge WS URL (default `ws://localhost:3010`; note Medusa's WS port is its HTTP port + 1).
   * @param {string} options.workspaceId - Stable workspace id to register.
   * @param {string} [options.name] - Human-readable name (for logging).
   * @param {number} [options.heartbeatMs] - Heartbeat cadence (default 20000).
   * @param {number} [options.backoffBaseMs] - Reconnect backoff base (default 1000).
   * @param {number} [options.maxInbox] - Cap on retained inbox messages (default 500).
   * @param {(url: string) => object} [options.wsFactory] - Socket factory (test seam).
   */
  constructor({ bridgeUrl, workspaceId, name, heartbeatMs, backoffBaseMs, maxInbox, wsFactory } = {}) {
    super();
    this.bridgeUrl = bridgeUrl || DEFAULT_BRIDGE_URL;
    this.workspaceId = workspaceId;
    this.name = name || workspaceId;
    this.heartbeatMs = heartbeatMs || DEFAULT_HEARTBEAT_MS;
    this.backoffBaseMs = backoffBaseMs || DEFAULT_BACKOFF_BASE_MS;
    this.maxInbox = maxInbox || DEFAULT_MAX_INBOX;
    this.wsFactory = wsFactory || ((url) => new WebSocket(url));

    /** @type {'off'|'connecting'|'listening'|'error'} */
    this.state = 'off';
    /** @type {string|null} */
    this.lastError = null;
    /** @type {Array<object>} In-memory inbox (not persisted). */
    this.inbox = [];
    /** @type {number} Count of unread messages since the last `markRead()`. */
    this.unread = 0;

    // De-dup by envelope `messageId` (bounded, FIFO-evicted) so a duplicate
    // delivery — e.g. a re-`registered` drain overlapping a live push — is not
    // double-injected into the inbox. Independent of the Bridge's own ~5-min cache.
    /** @type {Set<string>} */
    this._seenMessageIds = new Set();
    /** @type {string[]} Insertion order for bounded eviction of `_seenMessageIds`. */
    this._seenOrder = [];

    // ACK-on-read (TC#547). The Hub retains every delivered message until it is
    // ACK'd (at-least-once, Medusa#46), so a listener that never ACKs re-floods
    // its whole handled inbox on every reconnect/TC restart — stale unread
    // badges and stale wake nudges. TC ACKs on READ, not receipt: a message
    // received but never read stays queued Hub-side and honestly redelivers
    // after a crash; a read message is ACK'd and never re-floods.
    /** @type {string[]} Envelope ids received but not yet read (in arrival order). */
    this._unackedIds = [];
    /** @type {Set<string>} Ids read (markRead) whose ACK the Hub has not yet confirmed. */
    this._ackAwaiting = new Set();

    // Internal
    this._ws = null;
    this._intendedRunning = false;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._backoffAttempt = 0;

    // Bound handlers so we can attach/detach consistently across sockets.
    this._onOpen = this._onOpen.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onError = this._onError.bind(this);
  }

  /**
   * Begin listening: open a socket and drive the register handshake. Reconnects
   * automatically on unexpected failures until `stop()` is called. Calling
   * `start()` while already running is a no-op.
   * @returns {void}
   */
  start() {
    if (this._intendedRunning) return;
    this._intendedRunning = true;
    this._backoffAttempt = 0;
    this._connect();
  }

  /**
   * Stop listening: clear timers, close the socket, and set state to `off`.
   * Suppresses any reconnect. Idempotent.
   * @returns {void}
   */
  stop() {
    this._intendedRunning = false;
    this._clearTimers();
    if (this._ws) {
      try {
        this._ws.close();
      } catch (err) {
        log.warn('Error closing Medusa socket on stop', { workspaceId: this.workspaceId, error: err.message });
      }
      this._ws = null;
    }
    this._setState('off');
  }

  /**
   * Mark the inbox as read (resets the unread counter; keeps the messages) and
   * ACK every read message to the Hub (TC#547) so it is dropped from the durable
   * queue and never redelivered on reconnect/restart. Ids stay in the awaiting
   * set until the Hub confirms (`ack_response`); unconfirmed ids are re-flushed
   * on the next (re)`registered` handshake, so a lost ACK frame degrades to a
   * redundant retry, never a re-flood the operator has to re-read.
   * @returns {void}
   */
  markRead() {
    this.unread = 0;
    if (this._unackedIds.length > 0) {
      for (const id of this._unackedIds) this._ackAwaiting.add(id);
      this._unackedIds = [];
    }
    this._flushAcks();
  }

  /**
   * Send one `ack` frame for every id still awaiting Hub confirmation. Safe to
   * call with an empty set or a closed socket (no-op / dropped send — the
   * `registered` re-flush covers it).
   * @returns {void}
   */
  _flushAcks() {
    if (this._ackAwaiting.size === 0) return;
    this._send({ type: 'ack', messageIds: [...this._ackAwaiting] });
  }

  /**
   * Observable status snapshot.
   * @returns {{state: string, workspaceId: (string|undefined), unread: number, lastError: (string|null)}}
   */
  getStatus() {
    return {
      state: this.state,
      workspaceId: this.workspaceId,
      unread: this.unread,
      lastError: this.lastError
    };
  }

  /**
   * Transition state and emit `'state'` when it actually changes.
   * @param {'off'|'connecting'|'listening'|'error'} next - The new state.
   * @returns {void}
   */
  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  /**
   * Open a new socket and attach handlers. Sets state to `connecting`. A
   * synchronous factory failure surfaces as `error` and schedules a reconnect.
   * @returns {void}
   */
  _connect() {
    this._setState('connecting');
    // Defensive: close + drop any prior socket before opening a new one, so a
    // superseded socket (e.g. an `error` with no following `close`, or a throw
    // below) can't linger open or slip a late event through during backoff. The
    // identity guard already neutralizes stale events; nulling `_ws` first means
    // even a factory throw leaves no socket that could pass the guard.
    if (this._ws) {
      try {
        this._ws.close();
      } catch (err) {
        log.warn('Error closing superseded Medusa socket', { workspaceId: this.workspaceId, error: err.message });
      }
      this._ws = null;
    }
    let ws;
    try {
      ws = this.wsFactory(this.bridgeUrl);
    } catch (err) {
      this.lastError = `Failed to open socket: ${err.message}`;
      log.error('Failed to open Medusa socket', { bridgeUrl: this.bridgeUrl, error: err.message });
      this._setState('error');
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    // Socket-identity guard (Critic NOTE 3): a reconnect replaces `this._ws`, but
    // the superseded socket can still fire a late `close`/`error`/`message`. Gate
    // every handler on the firing socket still being the current one, so a stale
    // event from a replaced (or post-`stop()`) socket cannot perturb live state.
    const guard = (fn) => (event) => { if (ws !== this._ws) return; fn(event); };
    ws.addEventListener('open', guard(this._onOpen));
    ws.addEventListener('message', guard(this._onMessage));
    ws.addEventListener('close', guard(this._onClose));
    ws.addEventListener('error', guard(this._onError));
  }

  /**
   * On socket open: send the `register` frame. The Bridge replies `registered`.
   * @returns {void}
   */
  _onOpen() {
    log.info('Medusa socket open; registering', { workspaceId: this.workspaceId });
    this._send({ type: 'register', workspaceId: this.workspaceId });
  }

  /**
   * Handle an inbound frame. Malformed JSON is recorded on `lastError` and
   * dropped — it never crashes the listener, which stays listening.
   * @param {{data: (string|Buffer)}} event - The WS message event.
   * @returns {void}
   */
  _onMessage(event) {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (err) {
      this.lastError = `Malformed frame: ${err.message}`;
      log.warn('Dropped malformed Medusa frame', { workspaceId: this.workspaceId, error: err.message });
      return;
    }

    switch (frame && frame.type) {
      case 'registered':
        this._onRegistered();
        break;
      case 'new_message':
        this._onNewMessage(frame);
        break;
      case 'ack_response':
        this._onAckResponse(frame);
        break;
      case 'heartbeat_ack':
      case 'pong':
        // Presence/keepalive acks — nothing to do, tolerate.
        break;
      case 'error':
        // Bridge-reported error (e.g. it parsed a bad client frame). Record it
        // but stay listening; the connection is not closed by the Bridge here.
        this.lastError = `Bridge error: ${frame.message || 'unknown'}`;
        log.warn('Medusa Bridge reported an error', { workspaceId: this.workspaceId, message: frame.message });
        break;
      default:
        log.debug('Ignoring unrecognized Medusa frame', { workspaceId: this.workspaceId, type: frame && frame.type });
    }
  }

  /**
   * Handle the `registered` acknowledgement: enter `listening`, clear the last
   * error, reset backoff, and start the heartbeat interval. Any read-but-
   * unconfirmed ACKs are re-flushed (TC#547): the Hub's post-register drain
   * redelivers them (the `_seenMessageIds` de-dup keeps them out of the inbox),
   * and this retry removes them from the durable queue for good.
   * @returns {void}
   */
  _onRegistered() {
    log.info('Medusa registered; listening', { workspaceId: this.workspaceId });
    this.lastError = null;
    this._backoffAttempt = 0;
    this._setState('listening');
    this._startHeartbeat();
    this._flushAcks();
  }

  /**
   * Handle the Hub's `ack_response` (TC#547): drop confirmed ids from the
   * awaiting set. A failed/partial response leaves ids in place for the next
   * re-flush — never confirmed-by-assumption.
   * @param {{success?: boolean, messageIds?: string[]}} frame - The response frame.
   * @returns {void}
   */
  _onAckResponse(frame) {
    if (!frame || frame.success !== true || !Array.isArray(frame.messageIds)) {
      log.warn('Medusa ack not confirmed by the Hub', { workspaceId: this.workspaceId, frame });
      return;
    }
    for (const id of frame.messageIds) this._ackAwaiting.delete(String(id));
  }

  /**
   * Handle a `new_message` envelope: push the inner message onto the inbox,
   * increment unread, and emit `'message'`.
   * @param {{message: object}} frame - The `new_message` envelope.
   * @returns {void}
   */
  _onNewMessage(frame) {
    const message = frame.message;
    if (!message || typeof message !== 'object') {
      this.lastError = 'Received new_message with no message body';
      log.warn('new_message missing message body', { workspaceId: this.workspaceId });
      return;
    }
    // Drop a duplicate delivery (same envelope messageId) so a reconnect drain
    // overlapping a live push can't double-count unread or duplicate the inbox row.
    const messageId = frame.messageId != null ? String(frame.messageId) : null;
    if (messageId !== null) {
      if (this._seenMessageIds.has(messageId)) {
        log.debug('Dropped duplicate Medusa message', { workspaceId: this.workspaceId, messageId });
        return;
      }
      this._seenMessageIds.add(messageId);
      this._seenOrder.push(messageId);
      if (this._seenOrder.length > this.maxInbox) {
        this._seenMessageIds.delete(this._seenOrder.shift());
      }
      // TC#547: remember the envelope id so markRead can ACK it. Bounded like
      // the inbox — an evicted id simply stays queued Hub-side (at-least-once).
      this._unackedIds.push(messageId);
      if (this._unackedIds.length > this.maxInbox) this._unackedIds.shift();
    }
    this.inbox.push(message);
    if (this.inbox.length > this.maxInbox) this.inbox.shift(); // drop oldest — bounded memory.
    this.unread += 1;
    log.info('Medusa message received', { workspaceId: this.workspaceId, from: message.from, unread: this.unread });
    this.emit('message', message);
  }

  /**
   * On socket close: stop the heartbeat. If closure was unexpected (i.e. we did
   * not `stop()`), surface it and schedule a reconnect.
   * @param {{code?: number, reason?: string}} [event] - The WS close event.
   * @returns {void}
   */
  _onClose(event) {
    this._clearHeartbeat();
    if (!this._intendedRunning) return; // explicit stop() — stay `off`.
    const code = event && event.code;
    this.lastError = `Connection closed${code != null ? ` (code ${code})` : ''}`;
    log.warn('Medusa socket closed unexpectedly; reconnecting', { workspaceId: this.workspaceId, code });
    this._setState('connecting');
    this._scheduleReconnect();
  }

  /**
   * On socket error: record it and (while intended-running) schedule a
   * reconnect. A `close` typically follows; the reconnect guard prevents a
   * double schedule.
   * @param {{message?: string, error?: Error}} [event] - The WS error event.
   * @returns {void}
   */
  _onError(event) {
    if (!this._intendedRunning) return;
    const msg = (event && (event.message || (event.error && event.error.message))) || 'socket error';
    this.lastError = `Socket error: ${msg}`;
    log.warn('Medusa socket error', { workspaceId: this.workspaceId, error: msg });
    this._setState('error');
    this._scheduleReconnect();
  }

  /**
   * Serialize and send a frame if the socket is open. Send failures are logged,
   * not thrown (a dead socket triggers the close/reconnect path).
   * @param {object} obj - The frame to send.
   * @returns {void}
   */
  _send(obj) {
    if (!this._ws || this._ws.readyState !== WS_OPEN) return;
    try {
      this._ws.send(JSON.stringify(obj));
    } catch (err) {
      log.warn('Failed to send Medusa frame', { workspaceId: this.workspaceId, type: obj.type, error: err.message });
    }
  }

  /**
   * Start (or restart) the heartbeat interval that keeps presence fresh.
   * @returns {void}
   */
  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._send({ type: 'listener_heartbeat', status: 'active' });
    }, this.heartbeatMs);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  /**
   * Clear the heartbeat interval if running.
   * @returns {void}
   */
  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Schedule a reconnect with capped exponential backoff, unless a reconnect is
   * already pending or `stop()` was called.
   * @returns {void}
   */
  _scheduleReconnect() {
    if (!this._intendedRunning) return;
    if (this._reconnectTimer) return; // already scheduled — don't double up.
    const delay = Math.min(this.backoffBaseMs * (2 ** this._backoffAttempt), MAX_BACKOFF_MS);
    this._backoffAttempt += 1;
    log.info('Scheduling Medusa reconnect', { workspaceId: this.workspaceId, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._intendedRunning) this._connect();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  /**
   * Clear both the heartbeat and reconnect timers.
   * @returns {void}
   */
  _clearTimers() {
    this._clearHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = { MedusaListener };
