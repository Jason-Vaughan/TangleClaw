'use strict';

// The operator channel end to end: a helper holding the channel token hands in
// an operator message, TangleClaw delivers it to the target project's live
// session through a fake Hub, the project replies through its own switchboard
// route, and the helper collects the reply mapped to the message it answers.
// Every listener runs over a fake socket, so each arrival is one the real
// listener code produces.

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
const { createServer } = require('../server');
const authSession = require('../lib/auth-session');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

const OPEN = 1;

/** Minimal fake WebSocket matching what MedusaListener drives. */
class FakeWS {
  /** @param {string} url - Requested URL */
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._h = Object.create(null);
  }

  /** @param {string} t - Event type @param {Function} h - Handler @returns {void} */
  addEventListener(t, h) {
    (this._h[t] || (this._h[t] = [])).push(h);
  }

  /** @param {string} d - Frame @returns {void} */
  send(d) {
    this.sent.push(d);
  }

  /** @returns {void} */
  close() {
    this.readyState = 3;
  }

  /** @param {object} obj - Inbound frame @returns {void} */
  recv(obj) {
    for (const h of this._h.message || []) h({ data: JSON.stringify(obj) });
  }

  /** @returns {void} */
  open() {
    this.readyState = OPEN;
    for (const h of this._h.open || []) h({});
  }
}

/**
 * A fake Hub. `mode` decides how the next direct send is answered.
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
        if (mode === 'refuse') return json(404, { error: `Peer/Workspace ${body.to} not found.` });
        n += 1;
        return json(200, { success: true, status: 'received', id: `hub-${n}` });
      }
      return json(404, { error: 'unmatched' });
    });
  });
  return { server, received, setMode: (m) => { mode = m; } };
}

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server - Test server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path
 * @param {object|null} body - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{status: number, data: object}>}
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

const PASSWORD = 'correct-horse-battery-staple';

const ALLOW = Object.freeze({ authorId: '111111111111111111', spaceId: '222222222222222222', channelId: '333333333333333333' });

describe('API — operator channel', () => {
  let tmpDir;
  let server;
  let hub;
  let op;
  let target;
  let targetBinding;
  let targetWs;
  let channelSocket;
  let channelWs;
  let token;
  let clock;
  let seq = 0;
  const stopKeys = [];

  const mkProject = (label) => {
    const name = `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  /**
   * Start a listener for a bound session over a fake socket, registered and listening.
   * @param {object} project - Project record
   * @param {{sessionId: number}} binding - Its launch binding
   * @returns {{workspaceId: string, socket: FakeWS}}
   */
  const listen = (project, binding) => {
    let socket;
    const { workspaceId } = medusa.startSession({
      projectPath: project.path, sessionId: binding.sessionId, name: project.name,
      wsFactory: (u) => (socket = new FakeWS(u))
    });
    socket.open();
    socket.recv({ type: 'registered', workspaceId, connectionId: 'c1' });
    stopKeys.push(binding.sessionId);
    return { workspaceId, socket };
  };

  /** Bring the target project online: an active session with a listening switchboard. */
  const bringTargetOnline = () => {
    targetBinding = bindProject(target);
    targetWs = listen(target, targetBinding).workspaceId;
  };

  /**
   * The helper's headers.
   * @param {string} [t] - Token; the current one when omitted
   * @returns {Record<string, string>}
   */
  const helper = (t = token) => ({ Authorization: `Bearer ${t}` });

  /**
   * A fresh operator message body.
   * @param {object} [over] - Overrides for the message ids
   * @param {string} [text] - Message text
   * @returns {object}
   */
  const msg = (over = {}, text = 'hello architect') => {
    seq += 1;
    return { message: { id: `9${String(seq).padStart(17, '0')}`, ...ALLOW, ...over }, text };
  };

  /**
   * Have the Hub deliver a message to the channel's own workspace.
   * @param {string} hubId - Hub message id
   * @param {string} from - Sender workspace
   * @param {string} text - Body
   * @returns {void}
   */
  const deliverToChannel = (hubId, from, text) => {
    channelSocket.recv({ type: 'new_message', messageId: hubId, message: { id: hubId, from, message: text } });
  };

  /**
   * Arm the gate with one account, sign in, and return browser headers that
   * carry the session and its CSRF token.
   * @returns {Promise<Record<string, string>>}
   */
  const signIn = async () => {
    store.users.create('operator', PASSWORD);
    setGate(true);
    const res = await call(server, 'POST', '/api/auth/login', { username: 'operator', password: PASSWORD });
    assert.equal(res.status, 200, 'precondition: signed in');
    const cookies = res.headers['set-cookie'].map((c) => c.split(';')[0]);
    const csrf = cookies.find((c) => c.startsWith(`${authSession.CSRF_COOKIE}=`)).split('=')[1];
    return { Cookie: cookies.join('; '), 'Sec-Fetch-Site': 'same-origin', [authSession.CSRF_HEADER]: csrf };
  };

  /**
   * Arm or open TangleClaw's own login gate.
   * @param {boolean} armed - Whether the gate is armed
   * @returns {void}
   */
  const setGate = (armed) => {
    const config = store.config.load();
    Object.assign(config, { ingressMode: 'direct', authEnabled: armed });
    store.config.save(config);
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-oc-'));
    store._setBasePath(tmpDir);
    store.init();
    hub = makeHub();
    await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${hub.server.address().port}`);
    operatorChannel._internal.wsFactory = (u) => (channelSocket = new FakeWS(u));
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    // An armed gate and a signed-in operator: minting the token and changing
    // the settings need a verified session, which only an armed gate gives.
    op = await signIn();
    clock = Date.parse('2026-09-27T12:00:00.000Z');
    operatorChannel._internal.now = () => new Date(clock);
  });

  beforeEach(async () => {
    // Each test starts well clear of the last one's rate-limit window.
    clock += 10 * 60 * 1000;
    target = mkProject('architect');
    targetBinding = null;
    targetWs = null;
    hub.received.length = 0;
    hub.setMode('ok');
    const cfg = await call(server, 'PUT', '/api/operator-channel/config',
      { enabled: true, targetProject: target.name, allowlist: { ...ALLOW } }, op);
    assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
    channelSocket.open();
    channelWs = medusa.getStatus(operatorChannel.CHANNEL_KEY).workspaceId;
    channelSocket.recv({ type: 'registered', workspaceId: channelWs, connectionId: 'oc' });
    const minted = await call(server, 'POST', '/api/operator-channel/token', null, op);
    assert.equal(minted.status, 200);
    token = minted.data.token;
  });

  afterEach(() => {
    // A reply one test left waiting must not surface in the next test's poll.
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

  describe('delivery', () => {
    it('keeps a message while the target is offline, and delivers it once, stamped, when the target comes up', async () => {
      const body = msg();
      const accepted = await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.inbound.state, 'pending');

      await operatorChannel.pump();
      assert.equal(hub.received.length, 0, 'nothing is sent while no target session is live');

      bringTargetOnline();
      await operatorChannel.pump();
      assert.equal(hub.received.length, 1);
      const sent = hub.received[0];
      assert.equal(sent.to, targetWs);
      assert.equal(sent.from, channelWs);
      assert.equal(sent.message, `${operatorChannel.STAMP} hello architect`);

      const row = store.operatorChannel.getInboundByExternalId(body.message.id);
      assert.equal(row.state, 'sent');
      assert.equal(row.text, null, 'the text is dropped once the Hub has it');
      const ex = store.medusaExchanges.get(row.exchange_id);
      assert.equal(ex.priority, 'normal');
      assert.equal(ex.sender_verified, 0, 'the channel can claim nothing');
      assert.equal(ex.recipient_project_id, target.id);

      await operatorChannel.pump();
      assert.equal(hub.received.length, 1, 'a delivered message is never sent again');
    });

    it('answers a replayed message id from its record and never sends it twice', async () => {
      bringTargetOnline();
      const body = msg();
      const first = await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const again = await call(server, 'POST', '/api/operator-channel/inbound', { ...body, text: 'edited' }, helper());
      await operatorChannel.pump();
      assert.equal(first.status, 202);
      assert.equal(again.status, 200);
      assert.equal(again.data.duplicate, true);
      assert.equal(again.data.inbound.id, first.data.inbound.id);
      assert.equal(hub.received.length, 1);
    });

    it('a message for an offline project does not hold back one for a live project', async () => {
      const offline = store.operatorChannel.insertInbound({
        external_id: 'held-back-000000001', author_id: ALLOW.authorId, space_id: ALLOW.spaceId, channel_id: ALLOW.channelId,
        target_project_id: mkProject('offline').id, text: 'for a project that is down', created_at: new Date(clock).toISOString()
      }).row;
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      assert.equal(store.operatorChannel.getInboundByExternalId(body.message.id).state, 'sent');
      assert.equal(store.operatorChannel.getInbound(offline.id).state, 'pending');
    });

    it('reaches a live project past more queued messages than one batch holds for an offline one', async () => {
      const offline = mkProject('backlog');
      for (let i = 0; i < 60; i += 1) {
        store.operatorChannel.insertInbound({
          external_id: `backlog-${target.id}-${i}`, author_id: ALLOW.authorId, space_id: ALLOW.spaceId, channel_id: ALLOW.channelId,
          // Older than the rate-limit window, so the backlog does not count against the live message.
          target_project_id: offline.id, text: 'queued', created_at: new Date(clock - 5 * 60 * 1000).toISOString()
        });
      }
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      assert.equal(store.operatorChannel.getInboundByExternalId(body.message.id).state, 'sent');
      assert.equal(hub.received.length, 1);
    });

    it('does not resend a message whose Hub outcome was lost', async () => {
      bringTargetOnline();
      hub.setMode('drop');
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      assert.equal(store.operatorChannel.getInboundByExternalId(body.message.id).state, 'send_unknown');
      hub.setMode('ok');
      await operatorChannel.pump();
      assert.equal(hub.received.length, 1, 'the Hub was asked once, and only once');
    });

    it('tells the helper, as a reply to the operator\'s own message, that a message may not have arrived', async () => {
      bringTargetOnline();
      hub.setMode('drop');
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      const notices = out.data.replies.filter((r) => r.type === 'message-undelivered');
      assert.equal(notices.length, 1, JSON.stringify(out.data.replies));
      assert.equal(notices[0].kind, 'notification');
      assert.deepEqual(notices[0].inReplyTo, { messageId: body.message.id });
      assert.match(notices[0].text, /may not have reached/);
    });

    it('retries a refused send under a fresh request id, since a refusal is known not to be on the Hub', async () => {
      bringTargetOnline();
      hub.setMode('refuse');
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const refused = store.operatorChannel.getInboundByExternalId(body.message.id);
      assert.equal(refused.state, 'pending');
      assert.ok(refused.attempts >= 1);
      for (let i = 0; i < refused.attempts; i += 1) {
        assert.equal(store.medusaExchanges.getByRequestId(`operator-channel:${body.message.id}:${i}`).state, 'undeliverable');
      }

      hub.setMode('ok');
      await operatorChannel.pump();
      const sent = store.operatorChannel.getInboundByExternalId(body.message.id);
      assert.equal(sent.state, 'sent');
      assert.equal(store.medusaExchanges.get(sent.exchange_id).request_id, `operator-channel:${body.message.id}:${refused.attempts}`,
        'the successful send used a request id no refused attempt had used');
    });
  });

  describe('replies', () => {
    it('hands the target project\'s reply to the helper, mapped to the message it answers, once', async () => {
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const inHub = store.operatorChannel.getInboundByExternalId(body.message.id).hub_id;

      const reply = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'on it', inReplyTo: inHub }, targetBinding.headers);
      assert.equal(reply.status, 200, JSON.stringify(reply.data));
      deliverToChannel(reply.data.id, targetWs, 'on it');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.status, 200);
      assert.equal(out.data.replies.length, 1);
      const r = out.data.replies[0];
      assert.equal(r.text, 'on it');
      assert.deepEqual(r.inReplyTo, { messageId: body.message.id });

      const ack = await call(server, 'POST', `/api/operator-channel/outbound/${r.id}/ack`, { postedId: '444444444444444444' }, helper());
      assert.equal(ack.status, 200);
      assert.equal(ack.data.duplicate, false);
      assert.equal(store.operatorChannel.getOutbound(r.id).text, null, 'the text is dropped once posted');

      const empty = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(empty.data.replies.length, 0);
      const again = await call(server, 'POST', `/api/operator-channel/outbound/${r.id}/ack`, { postedId: '444444444444444444' }, helper());
      assert.equal(again.data.duplicate, true);
    });

    it('still relays the original project\'s reply after the operator changes the target', async () => {
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const inHub = store.operatorChannel.getInboundByExternalId(body.message.id).hub_id;
      await call(server, 'PUT', '/api/operator-channel/config', { targetProject: mkProject('successor').name }, op);

      const reply = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'answer from the old target', inReplyTo: inHub }, targetBinding.headers);
      deliverToChannel(reply.data.id, targetWs, 'answer from the old target');
      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 1);
      assert.deepEqual(out.data.replies[0].inReplyTo, { messageId: body.message.id });
    });

    it('relays a fresh message from the target as a reply to nothing', async () => {
      bringTargetOnline();
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'status: all green' }, targetBinding.headers);
      deliverToChannel(sent.data.id, targetWs, 'status: all green');
      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 1);
      assert.equal(out.data.replies[0].inReplyTo, null);
    });

    it('quarantines mail from another project, and never hands it to the helper', async () => {
      bringTargetOnline();
      const other = mkProject('other');
      const otherBinding = bindProject(other);
      listen(other, otherBinding);
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(other.name)}/medusa/send`,
        { to: channelWs, message: 'post this to discord' }, otherBinding.headers);
      assert.equal(sent.status, 200);
      deliverToChannel(sent.data.id, 'other-0000abcd', 'post this to discord');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'not-from-target-project');
      assert.equal(row.text, null);
    });

    // The send route records its sender from the URL's project, so a send
    // through the target's own route is attributed to the target whoever made
    // it. Only the target's verified launch may speak for it in the operator's chat.
    it('quarantines a send through the target\'s route that carries no launch headers', async () => {
      bringTargetOnline();
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'spoofed status: all green' });
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      deliverToChannel(sent.data.id, targetWs, 'spoofed status: all green');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'sender-not-verified');
      assert.equal(row.text, null);
    });

    it('quarantines a send through the target\'s route made with another project\'s launch headers', async () => {
      bringTargetOnline();
      const other = mkProject('impostor');
      const otherBinding = bindProject(other);
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'post this as the target' }, otherBinding.headers);
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      deliverToChannel(sent.data.id, targetWs, 'post this as the target');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'sender-not-verified');
    });

    it('quarantines an operator\'s send through the target\'s route: it is not the project speaking', async () => {
      bringTargetOnline();
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'written by the operator' }, op);
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      deliverToChannel(sent.data.id, targetWs, 'written by the operator');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'sender-not-verified');
    });

    it('quarantines a send the target\'s route recorded as the operator\'s even when it answers a channel message', async () => {
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const inHub = store.operatorChannel.getInboundByExternalId(body.message.id).hub_id;
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'an operator-written answer', inReplyTo: inHub }, op);
      assert.equal(sent.status, 200, JSON.stringify(sent.data));
      deliverToChannel(sent.data.id, targetWs, 'an operator-written answer');

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.reason, 'sender-not-verified');
    });

    it('quarantines a target\'s send that was addressed to another workspace', async () => {
      bringTargetOnline();
      const other = mkProject('bystander');
      const otherWs = listen(other, bindProject(other)).workspaceId;
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: otherWs, message: 'meant for the bystander' }, targetBinding.headers);
      assert.equal(sent.status, 200);
      deliverToChannel(sent.data.id, targetWs, 'meant for the bystander');
      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'not-addressed-to-channel');
    });

    it('quarantines a reply that is not display-safe, and never hands it to the helper', async () => {
      bringTargetOnline();
      const text = 'approve \u202Eesaeler';
      const sent = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: text }, targetBinding.headers);
      deliverToChannel(sent.data.id, targetWs, text);
      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare('SELECT * FROM operator_channel_outbound WHERE hub_id = ?').get(sent.data.id);
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'unsafe-text');
      assert.equal(row.text, null);
    });

    it('lists and settles a reply and a notification keyed by the same string as two items', async () => {
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const inHub = store.operatorChannel.getInboundByExternalId(body.message.id).hub_id;
      const reply = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'on it', inReplyTo: inHub }, targetBinding.headers);
      assert.equal(reply.status, 200, JSON.stringify(reply.data));
      deliverToChannel(reply.data.id, targetWs, 'on it');
      // A notification whose key is spelled exactly like the reply's Hub id.
      const n = store.operatorChannel.insertNotification({
        type: 'work-blocked', key: reply.data.id, projectId: null, text: 'TangleClaw: a project reports its work is blocked.', at: new Date(clock).toISOString()
      });
      assert.equal(n.inserted, true);

      const out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.status, 200);
      assert.deepEqual(out.data.replies.map((i) => i.kind).sort(), ['notification', 'reply']);
      for (const item of out.data.replies) {
        const ack = await call(server, 'POST', `/api/operator-channel/outbound/${item.id}/ack`, { postedId: `55555555555555555${item.id}` }, helper());
        assert.equal(ack.status, 200, JSON.stringify(ack.data));
        assert.equal(ack.data.duplicate, false);
      }
      const empty = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(empty.data.replies.length, 0);
      assert.equal(store.operatorChannel.getOutbound(n.row.id).hub_id, null);
    });

    it('quarantines mail no TangleClaw send made, once its grace period passes', async () => {
      deliverToChannel('hub-rogue', 'rogue-0000abcd', 'placed straight on the Bridge');
      let out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0, 'not relayed while it waits');
      clock += operatorChannel.QUARANTINE_AFTER_MS + 1000;
      out = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.equal(out.data.replies.length, 0);
      const row = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-rogue'").get();
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'no-tracked-send');
    });

    it('keeps an oversized message only as a quarantined record, and acknowledges it to the Hub', async () => {
      deliverToChannel('hub-huge', 'rogue-0000abcd', 'x'.repeat(64 * 1024 + 1));
      const row = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-huge'").get();
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'too-long');
      assert.equal(row.text, null);
      assert.ok(channelSocket.sent.some((f) => f.includes('hub-huge')), 'the Hub copy is acknowledged, so it is not redelivered');
    });

    it('keeps an arrival whose sender id is longer than a workspace id as a quarantined record, and acknowledges it', async () => {
      deliverToChannel('hub-longfrom', 'w'.repeat(129), 'from a sender no send here could have');
      const row = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-longfrom'").get();
      assert.ok(row, 'the arrival is recorded, not lost to a refused insert');
      assert.equal(row.state, 'quarantined');
      assert.equal(row.reason, 'sender-too-long');
      assert.equal(row.from_workspace_id, null);
      assert.equal(row.text, null);
      assert.ok(channelSocket.sent.some((f) => f.includes('hub-longfrom')), 'the Hub copy is acknowledged, so it is not redelivered');

      deliverToChannel('hub-edgefrom', 'w'.repeat(128), 'a sender id at the bound');
      const edge = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-edgefrom'").get();
      assert.equal(edge.from_workspace_id, 'w'.repeat(128));
      assert.equal(edge.state, 'unverified', 'a sender id at the bound is judged like any other');
    });

    it('refuses an ack for a reply that is not waiting', async () => {
      const missing = await call(server, 'POST', '/api/operator-channel/outbound/999999/ack', { postedId: '1' }, helper());
      assert.equal(missing.status, 404);
      const bad = await call(server, 'POST', '/api/operator-channel/outbound/1/ack', { postedId: 'has spaces' }, helper());
      assert.equal(bad.status, 400);
    });
  });

  describe('discarding an item the chat refused', () => {
    const TEXT = 'TangleClaw: a project reports its work is blocked.';

    /**
     * A notification waiting for the helper.
     * @returns {object} Its outbound row
     */
    const waiting = () => {
      seq += 1;
      return store.operatorChannel.insertNotification({ type: 'work-blocked', key: `discard-${seq}`, projectId: null, text: TEXT, at: new Date(clock).toISOString() }).row;
    };
    const discard = (id, body, headers = helper()) => call(server, 'POST', `/api/operator-channel/outbound/${id}/discard`, body, headers);

    it('records a reply as discarded under the reason given, drops its text, and never as delivered', async () => {
      bringTargetOnline();
      const body = msg();
      await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      await operatorChannel.pump();
      const inHub = store.operatorChannel.getInboundByExternalId(body.message.id).hub_id;
      const reply = await call(server, 'POST', `/api/sessions/${encodeURIComponent(target.name)}/medusa/send`,
        { to: channelWs, message: 'a reply the chat will refuse', inReplyTo: inHub }, targetBinding.headers);
      assert.equal(reply.status, 200, JSON.stringify(reply.data));
      deliverToChannel(reply.data.id, targetWs, 'a reply the chat will refuse');
      const listed = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      const r = listed.data.replies.find((i) => i.text === 'a reply the chat will refuse');
      assert.ok(r, 'precondition: the reply is waiting');

      clock += 1000;
      const res = await discard(r.id, { reason: 'rejected-by-chat' });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data, { id: r.id, state: 'discarded', reason: 'rejected-by-chat', duplicate: false });
      const row = store.operatorChannel.getOutbound(r.id);
      assert.equal(row.state, 'discarded');
      assert.equal(row.reason, 'rejected-by-chat');
      assert.equal(row.text, null, 'the text is dropped');
      assert.equal(row.delivered_ref, null, 'nothing was posted, so there is no posted reference');
      assert.equal(row.updated_at, new Date(clock).toISOString());
      assert.equal(row.kind, 'reply');
      assert.equal(row.hub_id, reply.data.id, 'the record of which message it was is kept');

      const after = await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      assert.ok(!after.data.replies.some((i) => i.id === r.id), 'it has left the relay queue');
      const status = await call(server, 'GET', '/api/operator-channel/status', null, op);
      assert.ok(status.data.counts.outbound.discarded >= 1, 'the operator sees it counted as discarded');
      assert.doesNotMatch(JSON.stringify(status.data), /the chat will refuse/);

      // It cannot be turned into a delivery afterwards.
      const ack = await call(server, 'POST', `/api/operator-channel/outbound/${r.id}/ack`, { postedId: '444444444444444444' }, helper());
      assert.equal(ack.status, 409);
      assert.equal(ack.data.code, 'NOT_RELAYABLE');
      assert.equal(store.operatorChannel.getOutbound(r.id).state, 'discarded');
      assert.equal(store.operatorChannel.getOutbound(r.id).delivered_ref, null);
    });

    it('answers the same discard again from its record, and refuses another reason for it', async () => {
      const row = waiting();
      const first = await discard(row.id, { reason: 'rejected-by-chat-partly-posted' });
      assert.deepEqual(first.data, { id: row.id, state: 'discarded', reason: 'rejected-by-chat-partly-posted', duplicate: false });
      const recorded = store.operatorChannel.getOutbound(row.id);
      clock += 5000;
      for (let i = 0; i < 2; i++) {
        const again = await discard(row.id, { reason: 'rejected-by-chat-partly-posted' });
        assert.equal(again.status, 200);
        assert.deepEqual(again.data, { id: row.id, state: 'discarded', reason: 'rejected-by-chat-partly-posted', duplicate: true });
      }
      const other = await discard(row.id, { reason: 'rejected-by-chat' });
      assert.equal(other.status, 409);
      assert.equal(other.data.code, 'DISCARD_REASON_MISMATCH');
      assert.deepEqual(store.operatorChannel.getOutbound(row.id), recorded, 'the first record stands, untouched');
    });

    it('accepts exactly the documented reasons', async () => {
      assert.deepEqual([...operatorChannel.DISCARD_REASONS], ['rejected-by-chat', 'rejected-by-chat-partly-posted']);
      assert.ok(Object.isFrozen(operatorChannel.DISCARD_REASONS));
      const row = waiting();
      for (const body of [null, {}, { reason: 'because' }, { reason: 42 }, { reason: 'delivered' }, { reason: 'Rejected-By-Chat' },
        { reason: ['rejected-by-chat'] }, { postedId: '444444444444444444' }]) {
        const res = await discard(row.id, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.data.code, 'BAD_DISCARD', JSON.stringify(body));
      }
      const still = store.operatorChannel.getOutbound(row.id);
      assert.equal(still.state, 'relayable', 'a refused discard moves nothing');
      assert.equal(still.text, TEXT);
      for (const reason of operatorChannel.DISCARD_REASONS) {
        const each = waiting();
        const res = await discard(each.id, { reason });
        assert.equal(res.status, 200, reason);
        assert.equal(store.operatorChannel.getOutbound(each.id).reason, reason);
      }
    });

    it('refuses a discard for an item that is not waiting', async () => {
      for (const id of ['999999', 'abc', '1.5', '-1']) {
        const res = await discard(id, { reason: 'rejected-by-chat' });
        assert.equal(res.status, 404, id);
        assert.equal(res.data.code, 'NOT_FOUND', id);
      }

      // Already posted: it stays delivered, with the reference it was posted under.
      const posted = waiting();
      await call(server, 'POST', `/api/operator-channel/outbound/${posted.id}/ack`, { postedId: '444444444444444444' }, helper());
      const afterAck = await discard(posted.id, { reason: 'rejected-by-chat' });
      assert.equal(afterAck.status, 409);
      assert.equal(afterAck.data.code, 'NOT_RELAYABLE');
      const delivered = store.operatorChannel.getOutbound(posted.id);
      assert.equal(delivered.state, 'delivered');
      assert.equal(delivered.delivered_ref, '444444444444444444');
      assert.equal(delivered.reason, null);

      // Not yet judged, and judged unfit: neither was ever the helper's to discard.
      deliverToChannel('hub-undecided', 'rogue-0000abcd', 'placed straight on the Bridge');
      const undecided = store.getDb().prepare("SELECT * FROM operator_channel_outbound WHERE hub_id = 'hub-undecided'").get();
      assert.equal(undecided.state, 'unverified', 'precondition');
      assert.equal((await discard(undecided.id, { reason: 'rejected-by-chat' })).data.code, 'NOT_RELAYABLE');
      assert.equal(store.operatorChannel.getOutbound(undecided.id).state, 'unverified');
      assert.equal(store.operatorChannel.getOutbound(undecided.id).text, 'placed straight on the Bridge');
      clock += operatorChannel.QUARANTINE_AFTER_MS + 1000;
      await call(server, 'GET', '/api/operator-channel/outbound', null, helper());
      const quarantined = await discard(undecided.id, { reason: 'rejected-by-chat' });
      assert.equal(quarantined.status, 409);
      assert.equal(quarantined.data.code, 'NOT_RELAYABLE');
      const kept = store.operatorChannel.getOutbound(undecided.id);
      assert.equal(kept.state, 'quarantined');
      assert.equal(kept.reason, 'no-tracked-send', 'a quarantine keeps its own reason');
    });

    it('is the helper\'s alone: no token, a stale token and the operator\'s own session are all refused', async () => {
      const row = waiting();
      assert.equal((await discard(row.id, { reason: 'rejected-by-chat' }, {})).status, 401);
      assert.equal((await discard(row.id, { reason: 'rejected-by-chat' }, helper('ocsk_not-the-token'))).status, 401);
      assert.equal((await discard(row.id, { reason: 'rejected-by-chat' }, op)).status, 401);
      assert.equal(store.operatorChannel.getOutbound(row.id).state, 'relayable');
    });
  });

  describe('fences', () => {
    it('refuses the helper routes without a valid token, and an old token after rotation', async () => {
      const none = await call(server, 'POST', '/api/operator-channel/inbound', msg());
      assert.equal(none.status, 401);
      const wrong = await call(server, 'GET', '/api/operator-channel/outbound', null, helper('ocsk_not-the-token'));
      assert.equal(wrong.status, 401);
      const old = token;
      await call(server, 'POST', '/api/operator-channel/token', null, op);
      const stale = await call(server, 'GET', '/api/operator-channel/outbound', null, helper(old));
      assert.equal(stale.status, 401);
    });

    it('refuses a channel token on every other route, even dressed as the dashboard', async () => {
      for (const [method, p] of [['GET', '/api/operator-channel/status'], ['POST', '/api/operator-channel/token'],
        ['GET', '/api/control/assignments'], ['GET', '/api/config']]) {
        const r = await call(server, method, p, null, { ...op, ...helper(), 'x-tangleclaw-client': 'dashboard' });
        assert.equal(r.status, 403, `${method} ${p}`);
        assert.equal(r.data.code, 'CHANNEL_TOKEN_SCOPE', `${method} ${p}`);
      }
    });

    it('accepts a channel token on exactly the four helper routes', async () => {
      // Each of the four reaches its handler, which then judges the (empty) request on its merits.
      for (const [method, p, status, code] of [
        ['POST', '/api/operator-channel/inbound', 400, 'BAD_MESSAGE'],
        ['GET', '/api/operator-channel/outbound', 200, undefined],
        ['POST', '/api/operator-channel/outbound/999999/ack', 400, 'BAD_ACK'],
        ['POST', '/api/operator-channel/outbound/999999/discard', 400, 'BAD_DISCARD']
      ]) {
        const r = await call(server, method, p, method === 'GET' ? null : {}, helper());
        assert.equal(r.status, status, `${method} ${p}`);
        assert.equal(r.data.code, code, `${method} ${p}`);
      }
      // Anything beside them, however close, is refused at the perimeter, whatever the method.
      for (const p of [
        '/api/operator-channel/outbound/1', '/api/operator-channel/outbound/1/', '/api/operator-channel/outbound/1/discarded',
        '/api/operator-channel/outbound/1/discard/again', '/api/operator-channel/outbound/1/2/discard',
        '/api/operator-channel/outbound//discard', '/api/operator-channel/outbound/1/ack/x', '/api/operator-channel/outbound/1/requeue',
        '/api/operator-channel/discard', '/api/operator-channel/inbound/1', '/api/operator-channel/status',
        '/api/operator-channel/config', '/api/operator-channel/token', '/api/operator-channel'
      ]) {
        for (const method of ['GET', 'POST']) {
          const r = await call(server, method, p, method === 'GET' ? null : {}, helper());
          assert.equal(r.status, 403, `${method} ${p}`);
          assert.equal(r.data.code, 'CHANNEL_TOKEN_SCOPE', `${method} ${p}`);
        }
      }
    });

    it('lets only a signed-in operator configure the channel or mint its token', async () => {
      bringTargetOnline();
      // A local script, an agent session, and a local caller dressed as the dashboard.
      const spoofed = { ...operatorHeaders(server), 'x-tangleclaw-client': 'dashboard' };
      for (const headers of [{}, targetBinding.headers, spoofed]) {
        const s = await call(server, 'GET', '/api/operator-channel/status', null, headers);
        const c = await call(server, 'PUT', '/api/operator-channel/config', { enabled: false }, headers);
        const t = await call(server, 'POST', '/api/operator-channel/token', null, headers);
        for (const r of [s, c, t]) assert.ok(r.status === 401 || r.status === 403, `refused, got ${r.status}`);
      }
      const status = await call(server, 'GET', '/api/operator-channel/status', null, op);
      assert.equal(status.status, 200);
      assert.equal(status.data.settings.tokenConfigured, true);
      assert.equal(JSON.stringify(status.data).includes(token), false);
      assert.equal('tokenHash' in status.data.settings, false);
    });

    it('never returns the token hash through the config API', async () => {
      const cfg = await call(server, 'GET', '/api/config', null, op);
      assert.equal(cfg.status, 200);
      assert.equal(cfg.data.operatorChannel.tokenConfigured, true);
      assert.equal('tokenHash' in cfg.data.operatorChannel, false);
    });

    it('refuses the ambient-open operator: on an open gate the dashboard headers cannot mint a token or change the settings', async () => {
      setGate(false);
      try {
        const spoofed = { ...operatorHeaders(server), 'x-tangleclaw-client': 'dashboard' };
        const c = await call(server, 'PUT', '/api/operator-channel/config', { enabled: false }, spoofed);
        const t = await call(server, 'POST', '/api/operator-channel/token', null, spoofed);
        for (const r of [c, t]) {
          assert.equal(r.status, 403);
          assert.equal(r.data.code, 'OPERATOR_VERIFICATION_REQUIRED');
        }
        assert.equal(operatorChannel.settings().enabled, true, 'nothing changed');
        const status = await call(server, 'GET', '/api/operator-channel/status', null, spoofed);
        assert.equal(status.status, 200, 'reading the status needs no more than any operator read');
      } finally {
        setGate(true);
      }
    });

    it('refuses inbound text that would display differently from what was sent, and keeps line breaks', async () => {
      for (const text of ['ma\u200bin', 'left \u202Eright', 'a\u2028b', 'soft\u00ADhyphen', 'b\uFEFFom']) {
        const r = await call(server, 'POST', '/api/operator-channel/inbound', msg({}, text), helper());
        assert.equal(r.status, 400, JSON.stringify(text));
        assert.equal(r.data.code, 'UNSAFE_TEXT');
      }
      const ok = await call(server, 'POST', '/api/operator-channel/inbound', msg({}, 'line one\nline two\n\tindented'), helper());
      assert.equal(ok.status, 202);
    });

    it('accepts only the allowlisted author, space and channel', async () => {
      for (const over of [{ authorId: '999' }, { spaceId: '999' }, { channelId: '999' }]) {
        const r = await call(server, 'POST', '/api/operator-channel/inbound', msg(over), helper());
        assert.equal(r.status, 403, JSON.stringify(over));
        assert.equal(r.data.code, 'NOT_ALLOWLISTED');
      }
    });

    it('refuses malformed, empty and over-long messages', async () => {
      assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', msg({ id: 'no spaces allowed' }), helper())).status, 400);
      assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', msg({}, '   '), helper())).status, 400);
      const long = await call(server, 'POST', '/api/operator-channel/inbound',
        msg({}, 'x'.repeat(operatorChannel.MAX_TEXT_LENGTH + 1)), helper());
      assert.equal(long.status, 413);
    });

    it('answers a replay from its record even after the target is unset', async () => {
      const body = msg();
      assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', body, helper())).status, 202);
      await call(server, 'PUT', '/api/operator-channel/config', { targetProject: null }, op);
      const replay = await call(server, 'POST', '/api/operator-channel/inbound', body, helper());
      assert.equal(replay.status, 200);
      assert.equal(replay.data.duplicate, true);
    });

    it('rate-limits new messages but still answers a replay', async () => {
      let first = null;
      for (let i = 0; i < operatorChannel.INBOUND_RATE.max; i += 1) {
        const body = msg();
        if (!first) first = body;
        assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', body, helper())).status, 202);
      }
      const over = await call(server, 'POST', '/api/operator-channel/inbound', msg(), helper());
      assert.equal(over.status, 429);
      const replay = await call(server, 'POST', '/api/operator-channel/inbound', first, helper());
      assert.equal(replay.status, 200);
    });

    it('accepts nothing while turned off, and nothing without a target', async () => {
      await call(server, 'PUT', '/api/operator-channel/config', { enabled: false }, op);
      assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', msg(), helper())).status, 503);
      assert.equal(medusa.getStatus(operatorChannel.CHANNEL_KEY).state, 'off', 'turning it off stops the listener');
      await call(server, 'PUT', '/api/operator-channel/config', { enabled: true, targetProject: null }, op);
      assert.equal((await call(server, 'POST', '/api/operator-channel/inbound', msg(), helper())).status, 409);
    });

    it('refuses settings that name no project or an incomplete allowlist', async () => {
      const noProject = await call(server, 'PUT', '/api/operator-channel/config', { targetProject: 'does-not-exist' }, op);
      assert.equal(noProject.status, 400);
      const partial = await call(server, 'PUT', '/api/operator-channel/config', { allowlist: { authorId: '1' } }, op);
      assert.equal(partial.status, 400);
    });
  });
});
