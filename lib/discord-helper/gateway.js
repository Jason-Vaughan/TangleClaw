'use strict';

/**
 * The helper's Discord Gateway connection (#1799): the WebSocket that delivers
 * the operator's messages as they are written.
 *
 * It does the Gateway's own bookkeeping and nothing else: HELLO, the heartbeat,
 * IDENTIFY with only the three intents the helper needs, RESUME after a dropped
 * connection, and reconnect with jittered exponential backoff. Each
 * MESSAGE_CREATE is handed to the caller untouched; deciding whose message it
 * is belongs to `inbound.js`.
 *
 * A close Discord marks as unfixable by retrying (a refused token, intents the
 * application may not use) stops the connection instead of reconnecting,
 * because a retry would only spend the application's daily identify budget.
 *
 * @module lib/discord-helper/gateway
 */

const DEFAULT_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** GUILDS, GUILD_MESSAGES and the privileged MESSAGE_CONTENT, and nothing else. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const OP = Object.freeze({
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7,
  INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11
});

/** Closes a retry cannot fix: bad token, bad shard, invalid or disallowed intents. */
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Closes after which the session is gone, so the next connection identifies afresh. */
const FRESH_SESSION_CLOSES = new Set([4007, 4009]);

/**
 * The code this client closes with when it means to resume. Discord invalidates
 * the session on a 1000 or 1001 close, so a resumable close must use another.
 */
const RESUME_CLOSE = 4000;

/**
 * The delay before reconnect attempt `n` (0-based): exponential from `baseMs`,
 * capped at `maxMs`, with full jitter so many clients do not reconnect in step.
 * @param {number} n - Consecutive failed attempts so far
 * @param {number} baseMs - First delay
 * @param {number} maxMs - Cap
 * @param {function(): number} random - Uniform [0, 1)
 * @returns {number}
 */
function backoffDelay(n, baseMs, maxMs, random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(n, 20));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

/**
 * Make a Gateway connection. Nothing connects until `start()`.
 * @param {object} opts
 * @param {string} opts.token - Bot token; sent only in IDENTIFY and RESUME
 * @param {function(object): void} opts.onMessageCreate - Receives each MESSAGE_CREATE payload
 * @param {function(string, object=): void} opts.log - The helper's closed-code log
 * @param {Function} [opts.WebSocket] - WebSocket constructor
 * @param {string} [opts.url] - Gateway URL used when `getUrl` is absent or fails
 * @param {function(): Promise<string>} [opts.getUrl] - Asks Discord for the Gateway URL
 *   (`GET /gateway/bot`), as Discord's documentation directs; the answer is cached
 * @param {object} [opts.timers] - `{setTimeout, clearTimeout, setInterval, clearInterval}`
 * @param {function(): number} [opts.random] - Uniform [0, 1)
 * @param {number} [opts.backoffBaseMs] - First reconnect delay
 * @param {number} [opts.backoffMaxMs] - Reconnect delay cap
 * @returns {{start: function(): void, stop: function(): void, status: function(): object}}
 */
function createGateway(opts) {
  const {
    token, onMessageCreate, log,
    WebSocket: WS = globalThis.WebSocket,
    url = DEFAULT_URL,
    getUrl = null,
    timers = globalThis,
    random = Math.random,
    backoffBaseMs = 1000,
    backoffMaxMs = 60000
  } = opts;

  let ws = null;
  let stopped = true;
  let fatal = null;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let discoveredUrl = null;
  let selfId = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let awaitingAck = false;
  let failures = 0;
  let state = 'idle';

  /** @returns {void} */
  function clearHeartbeat() {
    if (heartbeatTimer) { timers.clearTimeout(heartbeatTimer); timers.clearInterval(heartbeatTimer); }
    heartbeatTimer = null;
  }

  /**
   * @param {object} payload - Gateway payload
   * @returns {void}
   */
  function send(payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  /** @returns {void} */
  function beat() {
    if (awaitingAck) {
      // No ACK since the last beat: the connection is a zombie. Close in a way
      // that keeps the session, and resume on a new one.
      dropAndReconnect(RESUME_CLOSE);
      return;
    }
    awaitingAck = true;
    send({ op: OP.HEARTBEAT, d: seq });
  }

  /** @returns {void} */
  function identify() {
    send({ op: OP.IDENTIFY, d: { token, intents: INTENTS, properties: { os: process.platform, browser: 'tangleclaw-discord-helper', device: 'tangleclaw-discord-helper' } } });
  }

  /**
   * Close the current socket and schedule the next connection.
   * @param {number} code - Close code to send
   * @returns {void}
   */
  function dropAndReconnect(code) {
    const old = ws;
    ws = null;
    clearHeartbeat();
    if (old) {
      detach(old);
      try { old.close(code); } catch { /* prawduct:allow prawduct/broad-except -- a socket already closing may throw; it is being discarded */ }
    }
    scheduleReconnect();
  }

  /**
   * Schedule the next connection on the shared backoff.
   * @param {number} [minMs] - A floor under the backoff delay
   * @returns {void}
   */
  function scheduleReconnect(minMs = 0) {
    if (stopped || fatal || reconnectTimer) return;
    state = 'reconnecting';
    const delay = Math.max(minMs, backoffDelay(failures, backoffBaseMs, backoffMaxMs, random));
    failures += 1;
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  /**
   * Forget the session so the next connection identifies.
   * @returns {void}
   */
  function forgetSession() {
    seq = null;
    sessionId = null;
    resumeUrl = null;
  }

  /**
   * @param {object} msg - A parsed Gateway payload
   * @returns {void}
   */
  function onPayload(msg) {
    if (typeof msg.s === 'number') seq = msg.s;
    switch (msg.op) {
      case OP.HELLO: {
        const interval = Number(msg.d && msg.d.heartbeat_interval);
        if (!(interval > 0)) { dropAndReconnect(RESUME_CLOSE); return; }
        clearHeartbeat();
        awaitingAck = false;
        heartbeatTimer = timers.setTimeout(() => {
          beat();
          heartbeatTimer = timers.setInterval(beat, interval);
        }, Math.floor(interval * random()));
        if (sessionId && seq !== null) send({ op: OP.RESUME, d: { token, session_id: sessionId, seq } });
        else identify();
        return;
      }
      case OP.HEARTBEAT_ACK:
        awaitingAck = false;
        return;
      case OP.HEARTBEAT:
        send({ op: OP.HEARTBEAT, d: seq });
        return;
      case OP.RECONNECT:
        dropAndReconnect(RESUME_CLOSE);
        return;
      case OP.INVALID_SESSION:
        log('gateway-invalid-session');
        if (msg.d !== true) forgetSession();
        clearHeartbeat();
        if (ws) { detach(ws); try { ws.close(RESUME_CLOSE); } catch { /* prawduct:allow prawduct/broad-except -- discarding the socket */ } ws = null; }
        // The same backoff as any reconnect, never under a short random pause
        // (the common libraries' convention). A session Discord keeps refusing
        // is then retried less and less often, and cannot spend the daily
        // identify budget; `failures` resets only on READY or RESUMED.
        scheduleReconnect(1000 + Math.floor(4000 * random()));
        return;
      case OP.DISPATCH:
        onDispatch(msg.t, msg.d || {});
        return;
      default:
    }
  }

  /**
   * @param {string} type - Event name
   * @param {object} d - Event data
   * @returns {void}
   */
  function onDispatch(type, d) {
    if (type === 'READY') {
      sessionId = typeof d.session_id === 'string' ? d.session_id : null;
      resumeUrl = typeof d.resume_gateway_url === 'string' ? d.resume_gateway_url : null;
      selfId = d.user && typeof d.user.id === 'string' ? d.user.id : null;
      failures = 0;
      state = 'ready';
      log('gateway-ready');
    } else if (type === 'RESUMED') {
      failures = 0;
      state = 'ready';
      log('gateway-resumed');
    } else if (type === 'MESSAGE_CREATE') {
      // The handler is async and owns its errors; this catch keeps one that
      // escapes from becoming an unhandled rejection that ends the process.
      Promise.resolve().then(() => onMessageCreate(d, { selfId })).catch(() => log('inbound-handler-failed'));
    }
  }

  /** Handlers bound to the live socket, so a discarded one cannot act. */
  const handlers = {
    message: (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; } // prawduct:allow prawduct/broad-except -- a frame that is not JSON is ignored
      if (msg && typeof msg === 'object') onPayload(msg);
    },
    close: (ev) => {
      ws = null;
      clearHeartbeat();
      const code = Number(ev && ev.code);
      if (FATAL_CLOSES.has(code)) {
        fatal = code;
        state = 'fatal';
        log('gateway-fatal', { closeCode: code });
        return;
      }
      if (FRESH_SESSION_CLOSES.has(code)) forgetSession();
      log('gateway-closed', { closeCode: code || 0 });
      scheduleReconnect();
    },
    error: () => { /* a close always follows an error; the close handler reconnects */ }
  };

  /**
   * @param {object} sock - Socket to stop listening to
   * @returns {void}
   */
  function detach(sock) {
    for (const [t, h] of Object.entries(handlers)) {
      if (typeof sock.removeEventListener === 'function') sock.removeEventListener(t, h);
    }
  }

  /**
   * The URL for a connection that has no session to resume.
   * @param {string} discovered - What Discord answered
   * @returns {string|null} A wss URL with the version and encoding, or null
   */
  function withQuery(discovered) {
    if (typeof discovered !== 'string' || !/^wss:\/\/[^\s/?#]+/.test(discovered)) return null;
    return `${discovered.replace(/\/?(\?.*)?$/, '')}/?v=10&encoding=json`;
  }

  /** @returns {void} */
  function connect() {
    if (stopped || fatal) return;
    state = 'connecting';
    log('gateway-connecting');
    if (sessionId && resumeUrl) { open(withQuery(resumeUrl) || url); return; }
    if (discoveredUrl || !getUrl) { open(discoveredUrl || url); return; }
    Promise.resolve()
      .then(() => getUrl())
      .then((u) => { discoveredUrl = withQuery(u); }, () => { /* the default URL still works; ask again next time */ })
      .then(() => open(discoveredUrl || url));
  }

  /**
   * Open a socket to `target`.
   * @param {string} target - Gateway URL
   * @returns {void}
   */
  function open(target) {
    if (stopped || fatal) return;
    try {
      ws = new WS(target);
    // prawduct:allow prawduct/broad-except -- a constructor failure is one answer: not connected, so back off
    } catch {
      ws = null;
      scheduleReconnect();
      return;
    }
    for (const [t, h] of Object.entries(handlers)) ws.addEventListener(t, h);
  }

  return {
    /** Connect, and keep reconnecting until stopped. @returns {void} */
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    /** Close for good; the session is not kept. @returns {void} */
    stop() {
      stopped = true;
      state = 'stopped';
      if (reconnectTimer) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearHeartbeat();
      if (ws) { detach(ws); try { ws.close(1000); } catch { /* prawduct:allow prawduct/broad-except -- shutting down */ } ws = null; }
    },
    /**
     * Non-secret state for `status`.
     * @returns {{state: string, fatalCloseCode: (number|null), resumable: boolean, reconnectAttempts: number}}
     */
    status: () => ({ state, fatalCloseCode: fatal, resumable: Boolean(sessionId), reconnectAttempts: failures })
  };
}

module.exports = { createGateway, backoffDelay, INTENTS, OP, FATAL_CLOSES, FRESH_SESSION_CLOSES, RESUME_CLOSE, DEFAULT_URL };
