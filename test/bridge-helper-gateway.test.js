'use strict';

// #2031: the helper's Discord Gateway connection, against a WebSocket the
// test scripts by hand and timers it runs itself. It identifies with the
// three intents the helper needs and no others, keeps the heartbeat, resumes
// a dropped session without identifying again, and stops for good on a close
// a retry cannot fix, so a refused token cannot spend the application's daily
// identify budget.
//
// #2272: no connection attempt waits for ever. One that fails before it
// opens, one that never opens, one that opens and hears nothing, and one whose
// address lookup never answers are each given up and retried on the backoff,
// and a watchdog starts an attempt when nothing else would. The last block
// runs the same module over Node's real WebSocket against loopback servers.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { createGateway, gatewayAddress, backoffDelay, INTENTS, OP, FATAL_CLOSES, RESUME_CLOSE, DEFAULT_URL } = require('../lib/bridge-helper/discord-gateway');
const { fakeWebSocket } = require('./_fake-discord');
const { CODES, createLog } = require('../lib/bridge-helper/log');

/** A resume address of the shape Discord really gives: a subdomain of discord.gg. */
const RESUME_URL = 'wss://gateway-us-east1-b.discord.gg';
const BOT_TOKEN = `${'B'.repeat(24)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;

let ws;
let timers;
let codes;
let received;

/**
 * Timers the test runs by hand.
 * @returns {object}
 */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  const add = (kind) => (fn, ms) => { pending.set(next, { kind, fn, ms }); return next++; };
  const remove = (id) => { pending.delete(id); };
  return {
    setTimeout: add('timeout'), setInterval: add('interval'), clearTimeout: remove, clearInterval: remove,
    /** @returns {Array<{kind: string, ms: number}>} What is waiting. */
    waiting: () => [...pending.values()].map(({ kind, ms }) => ({ kind, ms })),
    /**
     * Fire, once each, the timers a test picks out by kind and delay.
     * @param {function({kind: string, ms: number}): boolean} pick - Which timers.
     * @returns {number} How many fired.
     */
    fireWhere(pick) {
      let fired = 0;
      for (const [id, timer] of [...pending]) {
        if (!pick({ kind: timer.kind, ms: timer.ms })) continue;
        if (timer.kind === 'timeout') pending.delete(id);
        timer.fn();
        fired += 1;
      }
      return fired;
    },
    /**
     * Fire every timer of one kind once.
     * @param {string} kind - `timeout` or `interval`.
     * @returns {void}
     */
    fire(kind) {
      for (const [id, timer] of [...pending]) {
        if (timer.kind !== kind) continue;
        if (kind === 'timeout') pending.delete(id);
        timer.fn();
      }
    }
  };
}

/**
 * Make a gateway over the fakes.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function gateway(over = {}) {
  return createGateway({
    token: BOT_TOKEN, WebSocket: ws.WebSocket, timers, random: () => 0.5,
    log: (code, fields) => codes.push([code, fields || {}]),
    onMessageCreate: (d, ctx) => { received.push([d, ctx]); },
    ...over
  });
}

/**
 * Let queued promise callbacks run.
 * @returns {Promise<void>}
 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Bring a gateway to READY on its first socket.
 * @param {object} gw - The gateway.
 * @param {string} [resumeUrl] - What READY names as the resume address.
 * @returns {Promise<object>} The socket.
 */
async function ready(gw, resumeUrl = RESUME_URL) {
  gw.start();
  await settle();
  const socket = ws.sockets[ws.sockets.length - 1];
  socket.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  socket.receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: resumeUrl, user: { id: '900000000000000009' } } });
  return socket;
}

describe('bridge helper: the Discord Gateway connection (#2031)', () => {
  beforeEach(() => {
    ws = fakeWebSocket();
    timers = fakeTimers();
    codes = [];
    received = [];
  });

  it('identifies with the three intents the helper needs and nothing else, after asking Discord where to connect', async () => {
    assert.equal(INTENTS, (1 << 0) | (1 << 9) | (1 << 15), 'GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT');
    // Only the host is taken from what Discord answered: its path and query are not used.
    const gw = gateway({ getUrl: async () => 'wss://gateway-us-east1-b.discord.gg:443/elsewhere?v=9&encoding=etf' });
    gw.start();
    await settle();
    assert.equal(ws.sockets[0].url, 'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
    assert.deepEqual(ws.sockets[0].sent, [], 'nothing is sent before Discord says hello');
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    const [identify] = ws.sockets[0].sent;
    assert.deepEqual([identify.op, identify.d.token, identify.d.intents], [OP.IDENTIFY, BOT_TOKEN, 33281]);
    // The bot is how the operator sees the bridge from Discord: it says it is online, and nothing more.
    assert.deepEqual(identify.d.presence, { status: 'online', afk: false, since: null, activities: [] });
    assert.deepEqual(Object.keys(identify.d).sort(), ['intents', 'presence', 'properties', 'token']);
    assert.deepEqual(timers.waiting(), [
      { kind: 'interval', ms: 60000 }, { kind: 'timeout', ms: 30000 }, { kind: 'timeout', ms: 20000 }
    ], 'the watchdog, the limit on this attempt, and the first heartbeat, jittered inside the interval');
    assert.ok(!JSON.stringify(codes).includes(BOT_TOKEN));
  });

  it('refuses a discovered address that is not an address at all and falls back to Discord\'s own', async () => {
    for (const bad of ['not a url', '', null, undefined, 42, { url: 'wss://gateway.discord.gg' }]) {
      ws = fakeWebSocket();
      codes = [];
      const gw = gateway({ getUrl: async () => bad });
      gw.start();
      await settle();
      assert.equal(ws.sockets[0].url, DEFAULT_URL, String(bad));
      assert.deepEqual(codes.at(-1), ['gateway-address-refused', {}], String(bad));
      gw.stop();
    }
  });

  it('falls back to Discord\'s own address, with nothing refused, when asking for one fails', async () => {
    const gw = gateway({ getUrl: async () => { throw new Error('no answer'); } });
    gw.start();
    await settle();
    assert.equal(ws.sockets[0].url, DEFAULT_URL);
    assert.deepEqual(codes.map(([code]) => code), ['gateway-connecting']);
  });

  it('hands each message to the handler with the bot\'s own id, and keeps the heartbeat', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    assert.deepEqual([gw.status().state, gw.status().resumable], ['ready', true]);
    socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: '500000000000000001', content: 'hello' } });
    await settle();
    assert.deepEqual(received, [[{ id: '500000000000000001', content: 'hello' }, { selfId: '900000000000000009' }]]);

    timers.fire('timeout');
    assert.deepEqual(socket.sent.at(-1), { op: OP.HEARTBEAT, d: 2 }, 'a heartbeat carries the last sequence number');
    socket.receive({ op: OP.HEARTBEAT_ACK });
    timers.fire('interval');
    assert.deepEqual(socket.sent.filter((p) => p.op === OP.HEARTBEAT).length, 2);
    socket.receive({ op: OP.HEARTBEAT });
    assert.deepEqual(socket.sent.at(-1), { op: OP.HEARTBEAT, d: 2 }, 'and Discord\'s own request for one is answered at once');
  });

  it('a handler that fails is logged by code and does not end the connection', async () => {
    const gw = gateway({ onMessageCreate: async () => { throw new Error('the operator said: deploy it'); } });
    const socket = await ready(gw);
    socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: '500000000000000002' } });
    await settle();
    assert.deepEqual(codes.at(-1), ['inbound-handler-failed', {}]);
    assert.equal(gw.status().state, 'ready');
  });

  it('resumes a dropped session at the address Discord gave, without identifying again', async () => {
    const gw = gateway();
    const first = await ready(gw);
    first.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 7, d: { id: '500000000000000003' } });
    first.drop(1006);
    assert.equal(gw.status().state, 'reconnecting');
    assert.deepEqual(codes.at(-1), ['gateway-closed', { closeCode: 1006 }]);
    timers.fire('timeout');
    await settle();
    const second = ws.sockets[1];
    assert.equal(second.url, `${RESUME_URL}/?v=10&encoding=json`);
    second.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(second.sent, [{ op: OP.RESUME, d: { token: BOT_TOKEN, session_id: 'sess-1', seq: 7 } }]);
    second.receive({ op: OP.DISPATCH, t: 'RESUMED', s: 8, d: {} });
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['ready', 0]);
  });

  it('a heartbeat Discord never acknowledged closes the connection in a way that keeps the session', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    timers.fire('timeout');
    timers.fire('interval');
    assert.equal(socket.closedWith, RESUME_CLOSE, 'not 1000 or 1001, which would end the session');
    assert.equal(gw.status().state, 'reconnecting');
    assert.equal(gw.status().resumable, true);
  });

  it('stops for good on a close a retry cannot fix', async () => {
    for (const code of FATAL_CLOSES) {
      ws = fakeWebSocket();
      timers = fakeTimers();
      const gw = gateway();
      const socket = await ready(gw);
      socket.drop(code);
      assert.deepEqual([gw.status().state, gw.status().fatalCloseCode], ['fatal', code]);
      assert.deepEqual(codes.at(-1), ['gateway-fatal', { closeCode: code }]);
      assert.deepEqual(timers.waiting(), [], `no reconnect is scheduled after ${code}`);
      gw.start();
      await settle();
      assert.equal(ws.sockets.length, 1, 'and starting it again does not connect');
      // Stopped and started again, it is still refused, and says that: not `stopped`, which a start would cure.
      gw.stop();
      assert.deepEqual([gw.status().state, gw.status().fatalCloseCode], ['stopped', code]);
      gw.start();
      await settle();
      assert.deepEqual([gw.status().state, gw.status().fatalCloseCode, ws.sockets.length], ['fatal', code, 1]);
      assert.deepEqual(timers.waiting(), [], 'with nothing scheduled and no watchdog');
    }
    assert.ok(FATAL_CLOSES.has(4004) && FATAL_CLOSES.has(4014), 'a refused token and disallowed intents among them');
  });

  describe('where the bot token may be sent', () => {
    const REFUSED = [
      ['a host that only starts with Discord\'s', 'wss://discord.gg.example.com'],
      ['a host that only ends with its letters', 'wss://example-discord.gg'],
      ['the bare domain, which is not the Gateway', 'wss://discord.gg'],
      ['a lookalike subdomain of another domain', 'wss://gateway.discord.gg.evil.example'],
      ['a trailing dot', 'wss://gateway.discord.gg.'],
      ['an IPv4 address', 'wss://203.0.113.7'],
      ['an IPv6 address', 'wss://[2001:db8::1]'],
      ['plain ws', 'ws://gateway.discord.gg'],
      ['https', 'https://gateway.discord.gg'],
      ['a user in the address', 'wss://user@gateway.discord.gg'],
      ['a user and password', 'wss://user:pw@gateway.discord.gg'],
      ['Discord\'s host as the user of another', 'wss://gateway.discord.gg@evil.example'],
      ['a port that is not 443', 'wss://gateway.discord.gg:8443'],
      ['port 80', 'wss://gateway.discord.gg:80'],
      ['an upper-case host', 'wss://Gateway.Discord.GG'],
      ['an empty label', 'wss://a..discord.gg'],
      ['whitespace', 'wss://gateway.discord.gg /']
    ];

    it('accepts the Gateway and its subdomains, with no port or 443, and uses nothing of the path Discord sent', () => {
      assert.equal(gatewayAddress('wss://gateway.discord.gg'), 'wss://gateway.discord.gg');
      assert.equal(gatewayAddress('wss://gateway.discord.gg/'), 'wss://gateway.discord.gg');
      assert.equal(gatewayAddress('wss://gateway.discord.gg:443'), 'wss://gateway.discord.gg');
      assert.equal(gatewayAddress('wss://gateway-us-east1-b.discord.gg'), 'wss://gateway-us-east1-b.discord.gg');
      assert.equal(gatewayAddress('wss://a.b.discord.gg/?v=9&encoding=etf#x'), 'wss://a.b.discord.gg');
      for (const [why, address] of REFUSED) assert.equal(gatewayAddress(address), null, why);
      for (const notAString of [42, null, undefined, {}, ['wss://gateway.discord.gg']]) assert.equal(gatewayAddress(notAString), null);
    });

    for (const [why, address] of REFUSED) {
      it(`refuses ${why}: nothing is opened to it, no token and no resume is sent, and the helper identifies afresh at the default`, async () => {
        const gw = gateway();
        const first = await ready(gw, address);
        first.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 7, d: { id: '500000000000000003' } });
        first.drop(1006);
        timers.fire('timeout');
        await settle();
        assert.equal(ws.sockets.length, 2);
        const second = ws.sockets[1];
        assert.equal(second.url, DEFAULT_URL, 'the default Gateway, and no socket to the address READY named');
        assert.ok(ws.sockets.every((sock) => sock.url === DEFAULT_URL));
        assert.deepEqual(codes.at(-1), ['gateway-resume-refused', {}]);
        assert.deepEqual(second.sent, [], 'nothing is sent before Discord says hello');
        second.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
        assert.equal(second.sent.length, 1);
        assert.equal(second.sent[0].op, OP.IDENTIFY, 'the session was dropped: this is a new one');
        assert.ok(!second.sent.some((p) => p.op === OP.RESUME), 'no resume, anywhere');
        assert.ok(!JSON.stringify(second.sent).includes('sess-1'), 'and the old session id goes nowhere');
        // Dropped for good: a later reconnect has no session to resume either.
        second.drop(1006);
        timers.fire('timeout');
        await settle();
        ws.sockets[2].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
        assert.equal(ws.sockets[2].sent[0].op, OP.IDENTIFY);
      });
    }

    for (const [why, address] of REFUSED) {
      it(`refuses ${why} for a first connection too: nothing is opened to it, and the token goes only to the default`, async () => {
        let asked = 0;
        const gw = gateway({ getUrl: async () => { asked++; return address; } });
        gw.start();
        await settle();
        assert.equal(ws.sockets.length, 1);
        const first = ws.sockets[0];
        assert.equal(first.url, DEFAULT_URL, 'the default Gateway, and no socket to the address Discord gave');
        assert.deepEqual(codes.at(-1), ['gateway-address-refused', {}]);
        assert.ok(!JSON.stringify(codes).includes(address), 'the refused address is not written to the log');
        first.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
        assert.deepEqual([first.sent[0].op, first.sent[0].d.token], [OP.IDENTIFY, BOT_TOKEN]);
        // Nothing is remembered of it: the next connection asks again and is held to the same rule.
        first.drop(1006);
        timers.fire('timeout');
        await settle();
        assert.equal(asked, 2);
        assert.ok(ws.sockets.every((sock) => sock.url === DEFAULT_URL));
      });
    }

    it('still resumes at the default address when READY named none', async () => {
      const gw = gateway();
      const first = await ready(gw, null);
      first.drop(1006);
      timers.fire('timeout');
      await settle();
      ws.sockets[1].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
      assert.equal(ws.sockets[1].url, DEFAULT_URL);
      assert.equal(ws.sockets[1].sent[0].op, OP.RESUME);
    });
  });

  it('identifies afresh when Discord says the session cannot be resumed', async () => {
    const gw = gateway();
    const first = await ready(gw);
    first.receive({ op: OP.INVALID_SESSION, d: false });
    assert.equal(gw.status().resumable, false);
    assert.deepEqual(timers.waiting().map((t) => t.kind), ['interval', 'timeout'], 'the watchdog, and the reconnect backoff');
    assert.equal(timers.waiting()[0].ms, 60000, 'the interval is the watchdog: the heartbeat is stopped');
    assert.ok(timers.waiting()[1].ms >= 1000, 'never sooner than a second');
    timers.fire('timeout');
    await settle();
    ws.sockets[1].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.equal(ws.sockets[1].sent[0].op, OP.IDENTIFY);
  });

  it('backs off between reconnects, up to a ceiling, and stops when told to', async () => {
    assert.deepEqual([0, 1, 2, 10, 50].map((n) => backoffDelay(n, 1000, 60000, () => 0)), [500, 1000, 2000, 30000, 30000]);
    assert.deepEqual([0, 10].map((n) => backoffDelay(n, 1000, 60000, () => 0.999999)).map(Math.round), [1000, 60000]);

    const gw = gateway();
    const socket = await ready(gw);
    gw.stop();
    assert.equal(socket.closedWith, 1000);
    assert.deepEqual(timers.waiting(), []);
    socket.drop(1000);
    assert.deepEqual(timers.waiting(), [], 'a stopped gateway does not reconnect');
    assert.equal(gw.status().state, 'stopped');
  });
});

/** The default limit on one connection attempt, and the watchdog's period. */
const ATTEMPT_MS = 30000;
const WATCHDOG_MS = 60000;

/**
 * A fake WebSocket whose sockets have not opened: `readyState` stays 0, as a
 * real one's does until the handshake completes.
 * @returns {{WebSocket: Function, sockets: object[]}}
 */
function unopenedWebSocket() {
  const base = fakeWebSocket();
  class Unopened extends base.WebSocket {
    /** @param {string} url - Where the client connected. */
    constructor(url) { super(url); this.readyState = 0; }
  }
  return { WebSocket: Unopened, sockets: base.sockets };
}

/**
 * Deliver an `error` event to whatever still listens on a fake socket.
 * @param {object} socket - The fake socket.
 * @returns {void}
 */
function fail(socket) {
  for (const fn of [...socket.listeners.error]) fn({});
}

/** @returns {number} How many attempt limits fired. */
function expireAttempt() {
  return timers.fireWhere((t) => t.kind === 'timeout' && t.ms === ATTEMPT_MS);
}

/** @returns {number} How many reconnect timers fired. */
function fireReconnect() {
  return timers.fireWhere((t) => t.kind === 'timeout' && t.ms !== ATTEMPT_MS && t.ms !== 20000);
}

/** @returns {number} How many watchdog ticks fired. */
function fireWatchdog() {
  return timers.fireWhere((t) => t.kind === 'interval' && t.ms === WATCHDOG_MS);
}

/** @returns {Array<{kind: string, ms: number}>} The reconnect timers waiting. */
function reconnectsWaiting() {
  return timers.waiting().filter((t) => t.kind === 'timeout' && t.ms !== ATTEMPT_MS && t.ms !== 20000);
}

describe('bridge helper: a Gateway connection attempt that goes nowhere (#2272)', () => {
  beforeEach(() => {
    ws = fakeWebSocket();
    timers = fakeTimers();
    codes = [];
    received = [];
  });

  it('a socket that never opens and never closes is given up at the limit and retried, and nothing it does later counts', async () => {
    ws = unopenedWebSocket();
    const gw = gateway();
    gw.start();
    await settle();
    const stuck = ws.sockets[0];
    assert.deepEqual(codes.map(([code]) => code), ['gateway-connecting']);
    assert.deepEqual(reconnectsWaiting(), [], 'nothing but the limit would ever start another attempt');
    assert.equal(expireAttempt(), 1);
    assert.deepEqual(codes.at(-1), ['gateway-attempt-abandoned', { reached: 'socket' }]);
    assert.equal(stuck.closedWith, RESUME_CLOSE, 'the socket is closed, in the way that keeps a session');
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['reconnecting', 1]);
    assert.deepEqual(reconnectsWaiting(), [{ kind: 'timeout', ms: 750 }]);

    assert.equal(fireReconnect(), 1);
    await settle();
    assert.equal(ws.sockets.length, 2);
    assert.equal(gw.status().state, 'connecting');

    // The abandoned socket comes back to life: it is not listened to.
    stuck.readyState = 1;
    stuck.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(stuck.sent, [], 'no token goes to a socket that was given up');
    fail(stuck);
    stuck.drop(4004);
    assert.deepEqual([gw.status().state, gw.status().fatalCloseCode], ['connecting', null]);
    assert.equal(ws.sockets.length, 2);
    assert.deepEqual(codes.map(([code]) => code), ['gateway-connecting', 'gateway-attempt-abandoned', 'gateway-connecting']);
  });

  it('a socket that opens and hears nothing is given up at the limit', async () => {
    const gw = gateway();
    gw.start();
    await settle();
    assert.equal(expireAttempt(), 1);
    assert.deepEqual(codes.at(-1), ['gateway-attempt-abandoned', { reached: 'open' }]);
    assert.equal(ws.sockets[0].closedWith, RESUME_CLOSE);
    assert.equal(gw.status().state, 'reconnecting');
    assert.equal(fireReconnect(), 1);
    await settle();
    assert.equal(ws.sockets.length, 2);
  });

  it('a session that is greeted and never becomes ready is given up at the limit, with its heartbeat stopped', async () => {
    const gw = gateway();
    gw.start();
    await settle();
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.equal(expireAttempt(), 1);
    assert.deepEqual(codes.at(-1), ['gateway-attempt-abandoned', { reached: 'hello' }]);
    assert.deepEqual(timers.waiting(), [{ kind: 'interval', ms: WATCHDOG_MS }, { kind: 'timeout', ms: 750 }], 'the watchdog and the reconnect: no heartbeat');
  });

  it('an address lookup that never answers is given up at the limit, and its late answer opens nothing', async () => {
    let answer;
    let asked = 0;
    const gw = gateway({ getUrl: () => { asked += 1; return new Promise((resolve) => { answer = resolve; }); } });
    gw.start();
    await settle();
    assert.equal(ws.sockets.length, 0, 'no socket is made while Discord has not said where');
    assert.equal(expireAttempt(), 1);
    assert.deepEqual(codes.at(-1), ['gateway-attempt-abandoned', { reached: 'lookup' }]);
    assert.equal(gw.status().state, 'reconnecting');

    answer('wss://gateway-us-east1-b.discord.gg');
    await settle();
    assert.equal(ws.sockets.length, 0, 'the first lookup answered after it was given up: nothing is opened for it');

    assert.equal(fireReconnect(), 1);
    await settle();
    assert.equal(ws.sockets.length, 1, 'one socket, from the second attempt');
    assert.equal(ws.sockets[0].url, 'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json', 'at the address the late answer named: it is Discord\'s answer, only too late for the attempt that asked');
    assert.equal(asked, 1);
  });

  it('a connection that fails before it opens is retried from its error, without waiting for a close that may never come', async () => {
    ws = unopenedWebSocket();
    const gw = gateway();
    gw.start();
    await settle();
    const refused = ws.sockets[0];
    fail(refused);
    assert.deepEqual(codes.at(-1), ['gateway-connect-failed', {}]);
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['reconnecting', 1]);
    assert.deepEqual(timers.waiting(), [{ kind: 'interval', ms: WATCHDOG_MS }, { kind: 'timeout', ms: 750 }], 'the attempt is over, so its limit is cleared');
    // Where a close does follow the error, it is not counted a second time.
    refused.drop(1006);
    assert.equal(gw.status().reconnectAttempts, 1);
    assert.deepEqual(codes.map(([code]) => code), ['gateway-connecting', 'gateway-connect-failed']);
    assert.equal(fireReconnect(), 1);
    await settle();
    assert.equal(ws.sockets.length, 2);
  });

  it('an attempt that ends by itself takes its limit with it: a close, a refused session, a socket that cannot be made', async () => {
    const noLimit = () => assert.deepEqual(timers.waiting().filter((t) => t.ms === ATTEMPT_MS), [], 'no limit is left to cut the next attempt short');

    const closed = gateway();
    closed.start();
    await settle();
    ws.sockets[0].drop(1006);
    assert.equal(closed.status().state, 'reconnecting');
    noLimit();
    closed.stop();

    ws = fakeWebSocket();
    timers = fakeTimers();
    const refused = gateway();
    refused.start();
    await settle();
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    ws.sockets[0].receive({ op: OP.INVALID_SESSION, d: false });
    assert.equal(refused.status().state, 'reconnecting');
    noLimit();
    refused.stop();

    timers = fakeTimers();
    const unmade = gateway({ WebSocket: function Throws() { throw new Error('no socket'); } });
    unmade.start();
    await settle();
    assert.equal(unmade.status().state, 'reconnecting');
    noLimit();
    assert.deepEqual(reconnectsWaiting(), [{ kind: 'timeout', ms: 750 }]);
  });

  it('the two timers that only watch never keep the process alive by themselves', async () => {
    const made = [];
    const real = {
      setTimeout: (fn, ms) => { const t = { kind: 'timeout', ms, unrefd: false, unref() { this.unrefd = true; } }; made.push(t); return t; },
      setInterval: (fn, ms) => { const t = { kind: 'interval', ms, unrefd: false, unref() { this.unrefd = true; } }; made.push(t); return t; },
      clearTimeout: () => {}, clearInterval: () => {}
    };
    const gw = gateway({ timers: real });
    gw.start();
    await settle();
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(made.map(({ kind, ms, unrefd }) => [kind, ms, unrefd]), [
      ['interval', WATCHDOG_MS, true], ['timeout', ATTEMPT_MS, true], ['timeout', 20000, false]
    ]);
    gw.stop();
  });

  it('an error on a connection that was open is left to its close, whose code still decides', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    fail(socket);
    assert.equal(gw.status().state, 'ready');
    assert.deepEqual(reconnectsWaiting(), []);
    assert.ok(!codes.some(([code]) => code === 'gateway-connect-failed'));
    socket.drop(4004);
    assert.deepEqual([gw.status().state, gw.status().fatalCloseCode], ['fatal', 4004]);
  });

  it('attempts given up one after another back off to the ceiling, and a ready session starts the count again', async () => {
    ws = unopenedWebSocket();
    const gw = gateway();
    gw.start();
    await settle();
    const delays = [];
    for (let n = 0; n < 9; n++) {
      assert.equal(expireAttempt(), 1, `attempt ${n} has a limit`);
      delays.push(reconnectsWaiting()[0].ms);
      assert.equal(fireReconnect(), 1);
      await settle();
    }
    assert.deepEqual(delays, [750, 1500, 3000, 6000, 12000, 24000, 45000, 45000, 45000]);
    assert.equal(ws.sockets.length, 10);

    const last = ws.sockets.at(-1);
    last.readyState = 1;
    last.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    last.receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: RESUME_URL, user: { id: '900000000000000009' } } });
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['ready', 0]);
    assert.equal(expireAttempt(), 0, 'a ready session has no attempt limit left to fire');
    last.drop(1006);
    assert.deepEqual(reconnectsWaiting(), [{ kind: 'timeout', ms: 750 }]);
  });

  it('a session that can be resumed is still resumed after an attempt was given up', async () => {
    const gw = gateway();
    const first = await ready(gw);
    first.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 7, d: { id: '500000000000000003' } });
    first.drop(1006);
    assert.equal(fireReconnect(), 1);
    await settle();
    assert.equal(expireAttempt(), 1);
    assert.deepEqual(codes.at(-1), ['gateway-attempt-abandoned', { reached: 'open' }]);
    assert.equal(gw.status().resumable, true);
    assert.equal(fireReconnect(), 1);
    await settle();
    const third = ws.sockets[2];
    assert.equal(third.url, `${RESUME_URL}/?v=10&encoding=json`);
    third.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(third.sent, [{ op: OP.RESUME, d: { token: BOT_TOKEN, session_id: 'sess-1', seq: 7 } }]);
    third.receive({ op: OP.DISPATCH, t: 'RESUMED', s: 8, d: {} });
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['ready', 0]);
    assert.equal(expireAttempt(), 0);
  });

  it('the watchdog starts an attempt when there is no socket and nothing is scheduled, whatever left it so', async () => {
    // No path is known to leave the gateway like this, so one is made: the log
    // fails once, between the close being handled and the reconnect being scheduled.
    let failLog = false;
    const gw = gateway({ log: (code, fields) => { if (failLog && code === 'gateway-closed') { failLog = false; throw new Error('log sink gone'); } codes.push([code, fields || {}]); } });
    const socket = await ready(gw);
    failLog = true;
    assert.throws(() => socket.drop(1006), /log sink gone/);
    assert.deepEqual(timers.waiting(), [{ kind: 'interval', ms: WATCHDOG_MS }], 'no socket, no reconnect, no attempt: only the watchdog is left');

    assert.equal(fireWatchdog(), 1);
    await settle();
    assert.deepEqual(codes.slice(-2).map(([code]) => code), ['gateway-watchdog-reconnect', 'gateway-connecting']);
    assert.equal(ws.sockets.length, 2);
    ws.sockets[1].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.equal(ws.sockets[1].sent[0].op, OP.RESUME, 'and the session it had is resumed');
  });

  it('the watchdog does nothing while ready, while an attempt is in flight, or while a reconnect is waiting', async () => {
    const gw = gateway();
    gw.start();
    await settle();
    assert.equal(fireWatchdog(), 1);
    assert.equal(ws.sockets.length, 1, 'an attempt is in flight');

    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    ws.sockets[0].receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: RESUME_URL, user: { id: '900000000000000009' } } });
    assert.equal(fireWatchdog(), 1);
    assert.equal(ws.sockets.length, 1, 'ready');

    ws.sockets[0].drop(1006);
    assert.equal(fireWatchdog(), 1);
    await settle();
    assert.equal(ws.sockets.length, 1, 'a reconnect is waiting');
    assert.ok(!codes.some(([code]) => code === 'gateway-watchdog-reconnect'));
    gw.stop();

    // An attempt that has no socket yet, because Discord has not said where, is still an attempt.
    ws = fakeWebSocket();
    timers = fakeTimers();
    let asked = 0;
    const asking = gateway({ getUrl: () => { asked += 1; return new Promise(() => {}); } });
    asking.start();
    await settle();
    assert.equal(fireWatchdog(), 1);
    await settle();
    assert.equal(asked, 1);
    assert.deepEqual(codes.filter(([code]) => code === 'gateway-watchdog-reconnect'), []);
  });

  it('the watchdog is gone after a close a retry cannot fix, and after a stop', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    socket.drop(4004);
    assert.deepEqual(timers.waiting(), []);
    gw.stop();
    gw.start();
    await settle();
    assert.deepEqual(timers.waiting(), [], 'and stopping and starting it brings no watchdog back: it stays refused until the helper is restarted');
    assert.equal(ws.sockets.length, 1);

    ws = fakeWebSocket();
    timers = fakeTimers();
    const other = gateway();
    await ready(other);
    other.stop();
    assert.deepEqual(timers.waiting(), []);
  });

  it('a stop leaves no timer behind, whatever the gateway was doing', async () => {
    const phases = {
      'an attempt in flight': async (gw) => { gw.start(); await settle(); },
      'greeted, not yet ready': async (gw) => { gw.start(); await settle(); ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } }); },
      'a lookup not yet answered': async (gw) => { gw.start(); await settle(); },
      'a reconnect waiting': async (gw) => { gw.start(); await settle(); expireAttempt(); },
      'ready, with the heartbeat running': async (gw) => { await ready(gw); timers.fire('timeout'); }
    };
    for (const [phase, reach] of Object.entries(phases)) {
      ws = fakeWebSocket();
      timers = fakeTimers();
      const gw = gateway(phase === 'a lookup not yet answered' ? { getUrl: () => new Promise(() => {}) } : {});
      await reach(gw);
      assert.ok(timers.waiting().length > 0, phase);
      gw.stop();
      assert.deepEqual(timers.waiting(), [], phase);
      assert.equal(gw.status().state, 'stopped', phase);
    }
  });

  it('an address lookup that answers after a stop opens nothing', async () => {
    const answers = [];
    const gw = gateway({ getUrl: () => new Promise((resolve) => { answers.push(resolve); }) });
    gw.start();
    await settle();
    gw.stop();
    gw.start();
    await settle();
    assert.equal(answers.length, 2);
    answers[0]('wss://gateway.discord.gg');
    await settle();
    assert.equal(ws.sockets.length, 0, 'the answer belongs to the attempt the stop ended; the second attempt is still asking');
    answers[1]('wss://gateway.discord.gg');
    await settle();
    assert.equal(ws.sockets.length, 1, 'and the second attempt opens one socket when its own answer comes');
  });

  it('every code the gateway logs on these paths is one the helper\'s log defines', async () => {
    // The other cases collect codes with their own sink; the helper's real log
    // writes `unknown-code` for a code its registry does not hold.
    const written = [];
    const log = createLog({ write: (line) => written.push(JSON.parse(line)) });
    let failLog = false;
    const gw = gateway({ log: (code, fields) => { if (failLog && code === 'gateway-closed') { failLog = false; throw new Error('log sink gone'); } return log(code, fields); } });
    const first = await ready(gw);
    failLog = true;
    assert.throws(() => first.drop(1006), /log sink gone/);
    fireWatchdog();
    await settle();
    expireAttempt();
    fireReconnect();
    await settle();
    fail(ws.sockets.at(-1));
    assert.deepEqual(written.map((record) => record.code), [
      'gateway-connecting', 'gateway-ready', 'gateway-watchdog-reconnect', 'gateway-connecting',
      'gateway-attempt-abandoned', 'gateway-connecting', 'gateway-connect-failed'
    ]);
    assert.equal(written[4].reached, 'open', 'and how far the attempt got passes the log\'s rule for field values');
    for (const { code } of written) assert.ok(Object.hasOwn(CODES, code) && code !== 'unknown-code', code);
  });

  it('says when the current state began, and keeps that time while the state does not change', async () => {
    let clock = Date.parse('2026-10-11T05:00:00.000Z');
    const gw = gateway({ now: () => new Date(clock) });
    assert.deepEqual([gw.status().state, gw.status().since], ['idle', '2026-10-11T05:00:00.000Z']);
    clock += 1000;
    gw.start();
    await settle();
    assert.deepEqual([gw.status().state, gw.status().since], ['connecting', '2026-10-11T05:00:01.000Z']);
    clock += 1000;
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.equal(gw.status().since, '2026-10-11T05:00:01.000Z', 'still connecting');
    ws.sockets[0].receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: RESUME_URL, user: { id: '900000000000000009' } } });
    assert.deepEqual([gw.status().state, gw.status().since], ['ready', '2026-10-11T05:00:02.000Z']);
    clock += 60000;
    ws.sockets[0].receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: '500000000000000001' } });
    assert.equal(gw.status().since, '2026-10-11T05:00:02.000Z');
    ws.sockets[0].receive({ op: OP.DISPATCH, t: 'RESUMED', s: 3, d: {} });
    assert.equal(gw.status().since, '2026-10-11T05:00:02.000Z', 'ready, said again, is the same state');
    ws.sockets[0].drop(1006);
    assert.deepEqual([gw.status().state, gw.status().since], ['reconnecting', '2026-10-11T05:01:02.000Z']);
    clock += 1000;
    gw.stop();
    assert.deepEqual([gw.status().state, gw.status().since], ['stopped', '2026-10-11T05:01:03.000Z']);
  });

  it('says since when it has not been ready, through every attempt of an outage, and null while it is', async () => {
    let clock = Date.parse('2026-10-11T05:00:00.000Z');
    const gw = gateway({ now: () => new Date(clock) });
    /** @returns {Array} The state, when it began, and since when the gateway has not been ready. */
    const read = () => [gw.status().state, gw.status().since, gw.status().notReadySince];
    assert.deepEqual(read(), ['idle', '2026-10-11T05:00:00.000Z', '2026-10-11T05:00:00.000Z'], 'made and not started');
    clock += 5000;
    gw.start();
    await settle();
    assert.deepEqual(read(), ['connecting', '2026-10-11T05:00:05.000Z', '2026-10-11T05:00:05.000Z'], 'never ready: since it was started');
    // The first attempt goes nowhere, and so does the next: the state changes each time and the outage is one.
    clock += 30000;
    expireAttempt();
    assert.deepEqual(read(), ['reconnecting', '2026-10-11T05:00:35.000Z', '2026-10-11T05:00:05.000Z']);
    clock += 1000;
    fireReconnect();
    await settle();
    assert.deepEqual(read(), ['connecting', '2026-10-11T05:00:36.000Z', '2026-10-11T05:00:05.000Z']);
    clock += 1000;
    ws.sockets.at(-1).receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    ws.sockets.at(-1).receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: RESUME_URL, user: { id: '900000000000000009' } } });
    assert.deepEqual(read(), ['ready', '2026-10-11T05:00:37.000Z', null]);

    // It drops, and three attempts fail: still the one time, the moment it stopped being ready.
    clock += 600000;
    ws.sockets.at(-1).drop(1006);
    assert.deepEqual(read(), ['reconnecting', '2026-10-11T05:10:37.000Z', '2026-10-11T05:10:37.000Z']);
    for (let n = 1; n <= 3; n++) {
      clock += 1000;
      fireReconnect();
      await settle();
      assert.deepEqual([gw.status().state, gw.status().notReadySince], ['connecting', '2026-10-11T05:10:37.000Z'], `attempt ${n}`);
      clock += 30000;
      expireAttempt();
      assert.deepEqual([gw.status().state, gw.status().notReadySince], ['reconnecting', '2026-10-11T05:10:37.000Z'], `attempt ${n} given up`);
    }
    // A resume makes it ready again; a stop, and a start after it, do not move the time it stopped being ready.
    clock += 1000;
    fireReconnect();
    await settle();
    ws.sockets.at(-1).receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    ws.sockets.at(-1).receive({ op: OP.DISPATCH, t: 'RESUMED', s: 2, d: {} });
    assert.deepEqual([gw.status().state, gw.status().notReadySince], ['ready', null]);
    clock += 60000;
    gw.stop();
    const stoppedAt = new Date(clock).toISOString();
    assert.deepEqual(read(), ['stopped', stoppedAt, stoppedAt]);
    clock += 60000;
    gw.start();
    await settle();
    assert.deepEqual([gw.status().state, gw.status().notReadySince], ['connecting', stoppedAt]);
  });
});

/**
 * Start a loopback server that accepts connections and never answers them.
 * @returns {Promise<{url: string, close: function(): Promise<void>}>}
 */
function startSilentServer() {
  return startLoopback(() => {});
}

/**
 * Start a loopback server that completes the WebSocket upgrade and then says
 * nothing: no HELLO ever comes.
 * @returns {Promise<{url: string, close: function(): Promise<void>}>}
 */
function startUpgradeOnlyServer() {
  return startLoopback((sock) => {
    let head = '';
    sock.on('data', (chunk) => {
      if (head === null) return;
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      head = null;
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
  });
}

/**
 * Start a loopback TCP server on a port the system picks.
 * @param {function(object): void} onSocket - Called with each accepted socket.
 * @returns {Promise<{url: string, close: function(): Promise<void>}>}
 */
async function startLoopback(onSocket) {
  const held = new Set();
  const server = net.createServer((sock) => {
    held.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => held.delete(sock));
    sock.resume();
    onSocket(sock);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { for (const sock of held) sock.destroy(); server.close(resolve); })
  };
}

/**
 * Run the gateway over Node's real WebSocket and real timers, with short
 * limits, until it has logged `count` codes or `withinMs` has passed.
 * @param {string} url - Where to connect.
 * @param {number} count - How many log codes to wait for.
 * @param {number} attemptTimeoutMs - The limit on one attempt.
 * @param {number} [withinMs] - The longest this waits.
 * @returns {Promise<Array<[string, object]>>} What it logged, in order.
 */
async function runReal(url, count, attemptTimeoutMs, withinMs = 20000) {
  const logged = [];
  const gw = createGateway({
    token: BOT_TOKEN, url, onMessageCreate: () => {}, random: () => 0.5,
    backoffBaseMs: 20, backoffMaxMs: 40, attemptTimeoutMs, watchdogMs: 60000,
    log: (code, fields) => logged.push([code, fields || {}])
  });
  gw.start();
  const until = Date.now() + withinMs;
  while (logged.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  gw.stop();
  return logged.slice(0, count);
}

describe('bridge helper: the Gateway over Node\'s real WebSocket, against a server that goes nowhere (#2272)', () => {
  // These cases wait real time, each bounded by the attempt limit it sets. What
  // they prove is the order of events, so no limit is one a busy machine could
  // miss: the silent server never answers however long it is given, the
  // handshake has a full second, and the refused port has five.

  it('a server that accepts the connection and never answers: the attempt is given up and another follows', async () => {
    const server = await startSilentServer();
    try {
      assert.deepEqual(await runReal(server.url, 4, 150), [
        ['gateway-connecting', {}], ['gateway-attempt-abandoned', { reached: 'socket' }],
        ['gateway-connecting', {}], ['gateway-attempt-abandoned', { reached: 'socket' }]
      ]);
    } finally { await server.close(); }
  });

  it('a server that completes the handshake and never says hello: the attempt is given up and another follows', async () => {
    const server = await startUpgradeOnlyServer();
    try {
      assert.deepEqual(await runReal(server.url, 3, 1000), [
        ['gateway-connecting', {}], ['gateway-attempt-abandoned', { reached: 'open' }],
        ['gateway-connecting', {}]
      ]);
    } finally { await server.close(); }
  });

  it('a connection that is refused: retried from the error, long before the limit', async () => {
    const server = await startSilentServer();
    const url = server.url;
    await server.close();
    const began = Date.now();
    assert.deepEqual(await runReal(url, 4, 5000), [
      ['gateway-connecting', {}], ['gateway-connect-failed', {}],
      ['gateway-connecting', {}], ['gateway-connect-failed', {}]
    ]);
    assert.ok(Date.now() - began < 5000, 'two refused attempts, without waiting out one five-second limit');
  });
});
