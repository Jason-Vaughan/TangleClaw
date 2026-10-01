'use strict';

// The Discord helper against the real operator channel (#1799): its C1 client,
// inbound filter and outbound relay talk to a real TangleClaw server over HTTP,
// with only Discord and the Medusa Hub faked. These are the acceptance rows
// that depend on what TangleClaw records: one inbound row per Discord message
// id, nothing recorded for anyone else, a merge request delivered as
// conversation, and an item left waiting through a Discord outage.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const operatorChannel = require('../lib/operator-channel');
const notify = require('../lib/operator-channel-notify');
const { createServer } = require('../server');
const authSession = require('../lib/auth-session');
const { bindProject } = require('./_shared-docs-callers');

const { createC1Client } = require('../lib/discord-helper/c1-client');
const { createInbound } = require('../lib/discord-helper/inbound');
const { createOutbound, NOTIFICATION_TITLES } = require('../lib/discord-helper/outbound');
const { openState } = require('../lib/discord-helper/state');
const { DiscordError } = require('../lib/discord-helper/discord-rest');

const PASSWORD = 'correct-horse-battery-staple';
const ALLOW = Object.freeze({ authorId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' });

/** Minimal fake WebSocket for the Medusa listeners. */
class FakeWS {
  /** @param {string} url - URL */
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this._h = Object.create(null); }

  /** @param {string} t - Type @param {Function} h - Handler @returns {void} */
  addEventListener(t, h) { (this._h[t] || (this._h[t] = [])).push(h); }

  /** @param {string} d - Frame @returns {void} */
  send(d) { this.sent.push(d); }

  /** @returns {void} */
  close() { this.readyState = 3; }

  /** @param {object} obj - Frame @returns {void} */
  recv(obj) { for (const h of this._h.message || []) h({ data: JSON.stringify(obj) }); }

  /** @returns {void} */
  open() { this.readyState = 1; for (const h of this._h.open || []) h({}); }
}

/**
 * A fake Hub. It accepts every direct send, or with `setMode('drop')` cuts the
 * connection without answering, so the sender cannot know the outcome.
 * @returns {{server: http.Server, received: object[], setMode: Function}}
 */
function makeHub() {
  const received = [];
  let mode = 'ok';
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/workspaces') return json(200, { workspaces: [] });
      if (req.method === 'POST' && req.url === '/messages/direct') {
        received.push(body);
        if (mode === 'drop') return req.socket.destroy();
        n += 1;
        return json(200, { success: true, status: 'received', id: `hub-${n}` });
      }
      return json(404, { error: 'unmatched' });
    });
  });
  return { server, received, setMode: (m) => { mode = m; } };
}

/**
 * A JSON request to the test server.
 * @param {http.Server} server - Server
 * @param {string} method - Method
 * @param {string} urlPath - Path
 * @param {object|null} body - Body
 * @param {Record<string, string>} [headers] - Headers
 * @returns {Promise<{status: number, data: object, headers: object}>}
 */
function call(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/**
 * A fake Discord REST client that de-duplicates by nonce and can be taken down.
 * @returns {object}
 */
function fakeDiscord() {
  const messages = [];
  const reactions = [];
  const byNonce = new Map();
  let next = 5000000000000000;
  return {
    messages, reactions, down: false, reject: false,
    async createMessage(channelId, m) {
      if (this.down) throw new DiscordError(0, null, 'no');
      // Discord's answer to content it will not take.
      if (this.reject) throw new DiscordError(400, 50035);
      if (byNonce.has(m.nonce)) return { id: byNonce.get(m.nonce) };
      const id = String(next++);
      byNonce.set(m.nonce, id);
      messages.push({ id, channelId, ...m });
      return { id };
    },
    async addReaction(...args) { reactions.push(args); }
  };
}

describe('discord helper against the real operator channel', () => {
  let tmpDir;
  let server;
  let hub;
  let op;
  let target;
  let channelSocket;
  let channelWs;
  let token;
  let c1;
  let discord;
  let handle;
  let clock;
  let seq = 0;
  const stopKeys = [];

  const nextId = () => `7${String(++seq).padStart(17, '0')}`;

  /**
   * A MESSAGE_CREATE from the Gateway.
   * @param {object} [over] - Overrides
   * @returns {object}
   */
  const gatewayMessage = (over = {}) => ({
    id: nextId(), type: 0, content: 'hello architect',
    author: { id: ALLOW.authorId, bot: false }, guild_id: ALLOW.guildId, channel_id: ALLOW.channelId, ...over
  });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dh-c1-'));
    store._setBasePath(tmpDir);
    store.init();
    hub = makeHub();
    await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${hub.server.address().port}`);
    operatorChannel._internal.wsFactory = (u) => (channelSocket = new FakeWS(u));
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    store.users.create('operator', PASSWORD);
    const config = store.config.load();
    Object.assign(config, { ingressMode: 'direct', authEnabled: true });
    store.config.save(config);
    const res = await call(server, 'POST', '/api/auth/login', { username: 'operator', password: PASSWORD });
    const cookies = res.headers['set-cookie'].map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith(`${authSession.CSRF_COOKIE}=`)).split('=')[1];
    op = { Cookie: cookies.join('; '), 'Sec-Fetch-Site': 'same-origin', [authSession.CSRF_HEADER]: csrf };
    clock = Date.parse('2026-09-28T12:00:00.000Z');
    operatorChannel._internal.now = () => new Date(clock);
  });

  beforeEach(async () => {
    clock += 10 * 60 * 1000;
    const name = `architect-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    target = store.projects.create({ name, path: dir, engine: 'claude' });
    hub.received.length = 0;
    hub.setMode('ok');
    const cfg = await call(server, 'PUT', '/api/operator-channel/config',
      { enabled: true, targetProject: target.name, allowlist: { authorId: ALLOW.authorId, spaceId: ALLOW.guildId, channelId: ALLOW.channelId } }, op);
    assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
    channelSocket.open();
    channelWs = medusa.getStatus(operatorChannel.CHANNEL_KEY).workspaceId;
    channelSocket.recv({ type: 'registered', workspaceId: channelWs, connectionId: 'oc' });
    const minted = await call(server, 'POST', '/api/operator-channel/token', null, op);
    token = minted.data.token;
    c1 = createC1Client({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
    discord = fakeDiscord();
    handle = createInbound({ allow: ALLOW, c1, rest: discord, log: () => {}, sleep: async () => {} });
  });

  afterEach(() => {
    for (const row of store.operatorChannel.listOutbound('relayable', 500)) {
      store.operatorChannel.deliverOutbound(row.id, 'test-cleanup', new Date(clock).toISOString());
    }
    while (stopKeys.length) medusa.stopSession(stopKeys.pop());
    medusa.stopSession(operatorChannel.CHANNEL_KEY);
  });

  after(async () => {
    operatorChannel._internal.wsFactory = undefined;
    operatorChannel._internal.now = () => new Date();
    medusa._setBridgeHttpUrl();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => hub.server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaying one Discord message id records one inbound message', async () => {
    const msg = gatewayMessage();
    const before = store.operatorChannel.countInboundSince('1970-01-01T00:00:00.000Z');
    assert.equal(await handle(msg, { selfId: null }), 'inbound-accepted');
    assert.equal(await handle(msg, { selfId: null }), 'inbound-replayed');
    assert.equal(await handle({ ...msg }, { selfId: null }), 'inbound-replayed');
    assert.equal(store.operatorChannel.countInboundSince('1970-01-01T00:00:00.000Z'), before + 1);
    assert.ok(store.operatorChannel.getInboundByExternalId(msg.id));
  });

  it('records nothing for another user, guild or channel', async () => {
    const before = store.operatorChannel.countInboundSince('1970-01-01T00:00:00.000Z');
    for (const over of [
      { author: { id: '555555555555555555', bot: false } },
      { guild_id: '666666666666666666' },
      { channel_id: '777777777777777777' }
    ]) {
      const msg = gatewayMessage({ ...over, content: 'not for you' });
      assert.equal(await handle(msg, { selfId: null }), 'inbound-ignored');
      assert.equal(store.operatorChannel.getInboundByExternalId(msg.id), null);
    }
    assert.equal(store.operatorChannel.countInboundSince('1970-01-01T00:00:00.000Z'), before);
  });

  it('delivers a merge-and-release request to the project as stamped conversation, at normal priority', async () => {
    const binding = bindProject(target);
    let socket;
    medusa.startSession({ projectPath: target.path, sessionId: binding.sessionId, name: target.name, wsFactory: (u) => (socket = new FakeWS(u)) });
    socket.open();
    const targetWs = medusa.getStatus(binding.sessionId).workspaceId;
    socket.recv({ type: 'registered', workspaceId: targetWs, connectionId: 't' });
    stopKeys.push(binding.sessionId);

    const text = 'Approved: merge PR #2001 and publish the release.';
    assert.equal(await handle(gatewayMessage({ content: text }), { selfId: null }), 'inbound-accepted');
    await operatorChannel.pump();
    assert.equal(hub.received.length, 1);
    assert.equal(hub.received[0].message, `${operatorChannel.STAMP} ${text}`);
    assert.equal(hub.received[0].priority || 'normal', 'normal');
  });

  it('leaves a notification waiting through a Discord outage, then posts and acknowledges it exactly', async () => {
    const emitted = notify.onOperatorAlerted({ exchange_id: `mx_${seq}`, recipient_project_id: target.id });
    assert.equal(emitted.emitted, true, JSON.stringify(emitted));
    const dir = fs.mkdtempSync(path.join(tmpDir, 'state-'));
    const out = createOutbound({ c1, rest: discord, state: openState(path.join(dir, 'state.json')), channelId: ALLOW.channelId, log: () => {} });

    discord.down = true;
    assert.equal(await out.tick(), 'failed');
    assert.equal(store.operatorChannel.getOutbound(emitted.id).state, 'relayable', 'not acknowledged while Discord is down');

    discord.down = false;
    assert.equal(await out.tick(), 'ok');
    assert.equal(discord.messages.length, 1);
    assert.match(discord.messages[0].content, /^\u{1F514} \*\*Operator needed\*\*\nTangleClaw: /u);
    const row = store.operatorChannel.getOutbound(emitted.id);
    assert.equal(row.state, 'delivered');
    assert.equal(await out.tick(), 'ok');
    assert.equal(discord.messages.length, 1, 'posted once');
  });

  it('titles every notification type the server emits', () => {
    for (const type of Object.keys(notify.EMITTED)) {
      assert.equal(typeof NOTIFICATION_TITLES[type], 'string', `${type} has no title and would post as "Notification"`);
      assert.ok(NOTIFICATION_TITLES[type].length > 0, type);
    }
  });

  it('tells the operator, under their own Discord message, that it may not have reached the project', async () => {
    const binding = bindProject(target);
    let socket;
    medusa.startSession({ projectPath: target.path, sessionId: binding.sessionId, name: target.name, wsFactory: (u) => (socket = new FakeWS(u)) });
    socket.open();
    socket.recv({ type: 'registered', workspaceId: medusa.getStatus(binding.sessionId).workspaceId, connectionId: 't' });
    stopKeys.push(binding.sessionId);

    hub.setMode('drop');
    const msg = gatewayMessage({ content: 'are you there?' });
    assert.equal(await handle(msg, { selfId: null }), 'inbound-accepted');
    await operatorChannel.pump();
    assert.equal(store.operatorChannel.getInboundByExternalId(msg.id).state, 'send_unknown');

    const dir = fs.mkdtempSync(path.join(tmpDir, 'state-'));
    const out = createOutbound({ c1, rest: discord, state: openState(path.join(dir, 'state.json')), channelId: ALLOW.channelId, log: () => {} });
    assert.equal(await out.tick(), 'ok');
    assert.equal(discord.messages.length, 1);
    assert.equal(discord.messages[0].replyTo, msg.id, 'posted as a reply to the message that did not arrive');
    assert.match(discord.messages[0].content, /^\u{1F514} \*\*Message not delivered\*\*\nTangleClaw: .*may not have reached/u);
    assert.equal(await out.tick(), 'ok');
    assert.equal(discord.messages.length, 1, 'posted once');
  });

  it('discards a notification Discord rejects, once the operator says so: recorded as discarded, never delivered, its text gone', async () => {
    const emitted = notify.onOperatorAlerted({ exchange_id: `mx_${seq}`, recipient_project_id: target.id });
    assert.equal(emitted.emitted, true, JSON.stringify(emitted));
    const text = store.operatorChannel.getOutbound(emitted.id).text;
    assert.ok(text && text.length > 0, 'precondition: the item has text to drop');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'state-'));
    const state = openState(path.join(dir, 'state.json'));
    const lines = [];
    const out = createOutbound({ c1, rest: discord, state, channelId: ALLOW.channelId, log: (code, fields) => lines.push({ code, ...fields }) });

    discord.reject = true;
    assert.equal(await out.tick(), 'ok');
    assert.equal(state.get(emitted.id).state, 'rejected');
    assert.equal(store.operatorChannel.getOutbound(emitted.id).state, 'relayable', 'held by the helper, still waiting on TangleClaw');
    discord.reject = false;

    // The operator, with the helper stopped, discards it; the helper's next poll carries that to TangleClaw.
    out.settleHeld(emitted.id, { discard: true });
    assert.equal(await out.tick(), 'ok');
    const row = store.operatorChannel.getOutbound(emitted.id);
    assert.equal(row.state, 'discarded');
    assert.equal(row.reason, 'rejected-by-chat');
    assert.equal(row.text, null);
    assert.equal(row.delivered_ref, null);
    assert.equal(state.get(emitted.id), undefined);
    assert.equal(discord.messages.length, 0, 'nothing of it was posted');
    assert.ok(!(await c1.listOutbound()).some((i) => i.id === emitted.id), 'it is no longer listed');
    assert.deepEqual(lines.map((l) => l.code), ['outbound-rejected', 'outbound-discarded']);
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the log never carries its text');

    // The same discard again is answered from the record; a claim that it posted is refused.
    assert.deepEqual((await c1.discard(emitted.id, 'rejected-by-chat')).body, { id: emitted.id, state: 'discarded', reason: 'rejected-by-chat', duplicate: true });
    await assert.rejects(c1.ack(emitted.id, '444444444444444444'), (err) => err.status === 409 && err.refusalCode === 'NOT_RELAYABLE');
    await assert.rejects(c1.discard(emitted.id, 'rejected-by-chat-partly-posted'), (err) => err.status === 409 && err.refusalCode === 'DISCARD_REASON_MISMATCH');
    assert.equal(store.operatorChannel.getOutbound(emitted.id).state, 'discarded');
  });

  it('the channel token reaches nothing but the channel routes', async () => {
    assert.deepEqual(Object.keys(c1).sort(), ['ack', 'discard', 'listOutbound', 'sendInbound']);
    for (const p of ['/api/projects', '/api/config', '/api/operator-channel/status']) {
      const res = await call(server, 'GET', p, null, { Authorization: `Bearer ${token}` });
      assert.equal(res.status, 403, p);
      assert.equal(res.data.code, 'CHANNEL_TOKEN_SCOPE', p);
    }
  });
});
