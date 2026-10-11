'use strict';

/**
 * The helper's Discord Gateway connection (#2031): the WebSocket that delivers
 * the operator's messages as they are written. Carried over from the helper of
 * #1799, which never merged: it speaks Discord's protocol and nothing of
 * TangleClaw's, so the bridge's change of contract did not touch it.
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
 * No connection attempt may wait for ever. The socket's own events cannot be
 * relied on to end one: Node's WebSocket reports a connection that failed
 * before the handshake with `error` and no `close`, and a server that accepts
 * and then says nothing produces no event at all. So a failed attempt is
 * retried from `error`, every attempt has a time limit from `connect()` to
 * READY or RESUMED, and a watchdog on its own timer starts an attempt when
 * the gateway holds no socket and has nothing scheduled.
 *
 * @module lib/bridge-helper/discord-gateway
 */

const DEFAULT_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** GUILDS, GUILD_MESSAGES and the privileged MESSAGE_CONTENT, and nothing else. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const OP = Object.freeze({
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7,
  INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11
});

/** The presence the bot identifies with: online, doing nothing in particular. */
const ONLINE = Object.freeze({ status: 'online', afk: false, since: null, activities: Object.freeze([]) });

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
 * The Gateway address Discord named, as one the bot token may be sent to, or null.
 *
 * Discord names an address twice: `GET /gateway/bot` for a first connection,
 * and READY's `resume_gateway_url` for a resume. Either way the helper sends
 * the bot token to it, so both are held to one fixed policy before anything is opened:
 * `wss` only, no user or password, no port or 443, and a host that is
 * `gateway.discord.gg` or a subdomain of `discord.gg`, written in lower case. A host that only
 * contains or ends with those letters, one with a trailing dot, and an IP
 * address are all refused. The path and query Discord sent are not used.
 * @param {*} raw - The address as Discord gave it
 * @returns {string|null} `wss://<host>`, or null when it is refused
 */
function gatewayAddress(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^wss:\/\/([^\s/?#@:]+)(?::(\d+))?(?:[/?#]\S*)?$/.exec(raw);
  if (!m) return null;
  const host = m[1];
  if (m[2] !== undefined && m[2] !== '443') return null;
  if (host !== 'gateway.discord.gg' && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+discord\.gg$/.test(host)) return null;
  return `wss://${host}`;
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
 * @param {number} [opts.attemptTimeoutMs] - How long one attempt may take, from
 *   `connect()` to READY or RESUMED, before it is abandoned and retried
 * @param {number} [opts.watchdogMs] - How often the watchdog looks for a gateway
 *   with no socket and nothing scheduled
 * @param {function(): Date} [opts.now] - Clock, for the time a state began
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
    backoffMaxMs = 60000,
    attemptTimeoutMs = 30000,
    watchdogMs = 60000,
    now = () => new Date()
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
  let attemptTimer = null;
  let watchdogTimer = null;
  /** Counts attempts, so an address lookup that answers late opens nothing. */
  let attempt = 0;
  /** Whether the current socket has delivered a frame: only then was it ever open. */
  let heard = false;
  let awaitingAck = false;
  let failures = 0;
  let state = 'idle';
  let since = now();
  /**
   * When the gateway last stopped being ready, or was first started if it has
   * never been; null while it is ready. A gateway that is down moves between
   * `connecting` and `reconnecting` on every attempt, so `since` restarts each
   * time and cannot say how long the outage has lasted. This can.
   */
  let notReadySince = since;

  /**
   * Move to a state, keeping the time it began.
   * @param {string} next - The state
   * @returns {void}
   */
  function setState(next) {
    if (state === next) return;
    const at = now();
    if (next === 'ready') notReadySince = null;
    else if (state === 'ready' || state === 'idle') notReadySince = at;
    state = next;
    since = at;
  }

  /**
   * A timer that never keeps the process alive by itself: the helper's own
   * loop does that, and these only watch it.
   * @param {*} timer - What `setTimeout` or `setInterval` returned
   * @returns {*} The same timer
   */
  function background(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  /** @returns {void} */
  function clearAttempt() {
    if (attemptTimer) timers.clearTimeout(attemptTimer);
    attemptTimer = null;
  }

  /** @returns {void} */
  function clearWatchdog() {
    if (watchdogTimer) timers.clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  /**
   * How far the current attempt got, for the log: `lookup` when no socket was
   * made, `socket` when one was made and never opened, `open` when it opened
   * and Discord said nothing, `hello` when Discord said hello and the session
   * never became ready.
   * @returns {string}
   */
  function reached() {
    if (!ws) return 'lookup';
    if (heard) return 'hello';
    return ws.readyState === 1 ? 'open' : 'socket';
  }

  /**
   * Give up an attempt that passed its time limit, and retry on the backoff.
   * The session is kept: an attempt that went nowhere says nothing about it.
   * @returns {void}
   */
  function abandonAttempt() {
    log('gateway-attempt-abandoned', { reached: reached() });
    dropAndReconnect(RESUME_CLOSE);
  }

  /**
   * Start an attempt when the gateway holds no socket and nothing is scheduled
   * or in flight. No path is known to leave it so; this is for the one nobody
   * has thought of, and it does not depend on any socket event. It runs only
   * between `start()` and a stop or a fatal close.
   * @returns {void}
   */
  function watch() {
    if (ws || reconnectTimer || attemptTimer) return;
    log('gateway-watchdog-reconnect');
    connect();
  }

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

  /**
   * Identify, and say the bot is online. The bot is how the operator sees the
   * bridge from Discord: while the helper holds this connection the bot shows
   * as an online member, and when the helper stops Discord shows it offline.
   * Said outright, not left to Discord's default, because it is something the
   * operator relies on. No activity is set: nothing is said beyond "here".
   * @returns {void}
   */
  function identify() {
    send({
      op: OP.IDENTIFY,
      d: {
        token, intents: INTENTS, presence: ONLINE,
        properties: { os: process.platform, browser: 'tangleclaw-bridge-helper', device: 'tangleclaw-bridge-helper' }
      }
    });
  }

  /**
   * Close the current socket and schedule the next connection.
   * @param {number} code - Close code to send
   * @returns {void}
   */
  function dropAndReconnect(code) {
    const old = ws;
    ws = null;
    attempt += 1;
    clearAttempt();
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
    setState('reconnecting');
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
    heard = true;
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
        clearAttempt();
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
      clearAttempt();
      setState('ready');
      log('gateway-ready');
    } else if (type === 'RESUMED') {
      failures = 0;
      clearAttempt();
      setState('ready');
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
      clearAttempt();
      clearHeartbeat();
      const code = Number(ev && ev.code);
      if (FATAL_CLOSES.has(code)) {
        fatal = code;
        clearWatchdog();
        setState('fatal');
        log('gateway-fatal', { closeCode: code });
        return;
      }
      if (FRESH_SESSION_CLOSES.has(code)) forgetSession();
      log('gateway-closed', { closeCode: code || 0 });
      scheduleReconnect();
    },
    error: () => {
      // A socket that has delivered a frame was open, and its close follows
      // and carries the code that decides what happens next. One that never
      // delivered anything may get no close at all: Node's WebSocket reports a
      // refused connection, a host that does not resolve and a connection
      // that timed out with `error` alone. That attempt is over, so it is
      // retried here.
      if (heard) return;
      log('gateway-connect-failed');
      dropAndReconnect(RESUME_CLOSE);
    }
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
   * Keep what Discord answered for a first connection, when it is an address
   * the token may be sent to. One that is not is never opened: it is logged,
   * and the helper identifies at the default address.
   * @param {*} discovered - What Discord answered
   * @returns {void}
   */
  function adoptDiscovered(discovered) {
    const address = gatewayAddress(discovered);
    if (address) { discoveredUrl = `${address}/?v=10&encoding=json`; return; }
    log('gateway-address-refused');
  }

  /** @returns {void} */
  function connect() {
    if (stopped || fatal) return;
    setState('connecting');
    log('gateway-connecting');
    const mine = ++attempt;
    attemptTimer = background(timers.setTimeout(abandonAttempt, attemptTimeoutMs));
    if (sessionId && resumeUrl) {
      const address = gatewayAddress(resumeUrl);
      if (address) { open(`${address}/?v=10&encoding=json`); return; }
      // Not an address a session may be resumed at: nothing is opened to it
      // and nothing is sent to it. The session is dropped, and the helper
      // identifies afresh at the default address.
      log('gateway-resume-refused');
      forgetSession();
      open(url);
      return;
    }
    if (discoveredUrl || !getUrl) { open(discoveredUrl || url); return; }
    Promise.resolve()
      .then(() => getUrl())
      .then(adoptDiscovered, () => { /* the default URL still works; ask again next time */ })
      .then(() => { if (mine === attempt) open(discoveredUrl || url); });
  }

  /**
   * Open a socket to `target`.
   * @param {string} target - Gateway URL
   * @returns {void}
   */
  function open(target) {
    if (stopped || fatal) return;
    heard = false;
    try {
      ws = new WS(target);
    // prawduct:allow prawduct/broad-except -- a constructor failure is one answer: not connected, so back off
    } catch {
      ws = null;
      clearAttempt();
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
      // A gateway Discord refused for good stays refused when it is started
      // again, and says so: `stopped` would read as something a start cures.
      if (fatal) { setState('fatal'); return; }
      watchdogTimer = background(timers.setInterval(watch, watchdogMs));
      connect();
    },
    /** Close for good; the session is not kept. @returns {void} */
    stop() {
      stopped = true;
      setState('stopped');
      if (reconnectTimer) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearAttempt();
      clearWatchdog();
      clearHeartbeat();
      if (ws) { detach(ws); try { ws.close(1000); } catch { /* prawduct:allow prawduct/broad-except -- shutting down */ } ws = null; }
    },
    /**
     * Non-secret state for `status`. `since` is when the current state began;
     * `notReadySince` is when the gateway last stopped being ready (or was
     * first started, if it never has been), and null while it is ready.
     * @returns {{state: string, since: string, notReadySince: (string|null), fatalCloseCode: (number|null), resumable: boolean, reconnectAttempts: number}}
     */
    status: () => ({
      state, since: since.toISOString(), notReadySince: notReadySince ? notReadySince.toISOString() : null,
      fatalCloseCode: fatal, resumable: Boolean(sessionId), reconnectAttempts: failures
    })
  };
}

module.exports = { createGateway, gatewayAddress, backoffDelay, INTENTS, OP, FATAL_CLOSES, FRESH_SESSION_CLOSES, RESUME_CLOSE, DEFAULT_URL };
