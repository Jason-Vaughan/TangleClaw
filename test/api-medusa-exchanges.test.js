'use strict';

// #1839: the switchboard routes record each ordinary message as an exchange.
// Two project sessions on this host (a PM and a Builder) talk through a fake
// Hub; their listeners are driven over fake sockets, so every arrival, read,
// ack and reply is one the real routes produce.

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
const { createServer } = require('../server');
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
 * @returns {{server: http.Server, received: object[], setMode: Function, roster: object[]}}
 */
function makeHub() {
  const received = [];
  let mode = 'ok';
  let n = 0;
  const roster = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/workspaces') return json(200, { workspaces: roster });
      if (req.method === 'POST' && req.url === '/messages/direct') {
        received.push(body);
        if (mode === 'drop') return req.socket.destroy();
        if (mode === 'refuse') return json(404, { error: `Peer/Workspace ${body.to} not found.` });
        if (mode === 'noid') return json(200, { success: true, status: 'queued' });
        n += 1;
        return json(200, { success: true, status: 'received', id: `hub-${n}` });
      }
      return json(404, { error: 'unmatched' });
    });
  });
  return { server, received, roster, setMode: (m) => { mode = m; } };
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
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

describe('API — Medusa exchanges (#1839)', () => {
  let tmpDir;
  let server;
  let hub;
  let pm;
  let builder;
  let bPM;
  let bBuilder;
  let pmWs;
  let builderWs;
  let builderSocket;
  let op;

  const mkProject = (name) => {
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
    return { workspaceId, socket };
  };

  /**
   * Have the Hub deliver a message to the Builder's listener.
   * @param {string} hubId - Hub message id
   * @returns {void}
   */
  const deliverToBuilder = (hubId) => {
    builderSocket.recv({ type: 'new_message', messageId: hubId, message: { id: hubId, from: pmWs, message: 'ping' } });
  };

  const pmBase = () => `/api/sessions/${encodeURIComponent(pm.name)}/medusa`;
  const builderBase = () => `/api/sessions/${encodeURIComponent(builder.name)}/medusa`;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-mx-'));
    store._setBasePath(tmpDir);
    store.init();
    hub = makeHub();
    await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${hub.server.address().port}`);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
  });

  beforeEach(() => {
    pm = mkProject(`pm-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
    builder = mkProject(`builder-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
    bPM = bindProject(pm);
    bBuilder = bindProject(builder);
    pmWs = listen(pm, bPM).workspaceId;
    ({ workspaceId: builderWs, socket: builderSocket } = listen(builder, bBuilder));
    hub.received.length = 0;
    hub.setMode('ok');
  });

  afterEach(() => {
    medusa.stopSession(bPM.sessionId);
    medusa.stopSession(bBuilder.sessionId);
  });

  after(async () => {
    medusa._setBridgeHttpUrl();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => hub.server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a legacy unbound normal send as unverified, and follows it to an automatic close', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'hello' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.exchange.state, 'stored');
    assert.equal(sent.data.exchange.sender.verified, false);
    assert.equal(sent.data.exchange.tracking, 'tracked');
    const hubId = sent.data.id;

    deliverToBuilder(hubId);
    const read = await call(server, 'GET', `${builderBase()}/messages`, null, bBuilder.headers);
    assert.equal(read.status, 200);
    let x = store.medusaExchanges.getByHubId(hubId, 'send');
    assert.equal(x.state, 'read');
    assert.equal(store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'read').actor, 'recipient');

    await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, bBuilder.headers);
    x = store.medusaExchanges.getByHubId(hubId, 'send');
    assert.equal(x.state, 'closed');
    assert.equal(x.terminal_code, 'acknowledged');
  });

  it('refuses an unbound blocking send before anything reaches the Hub or the record', async () => {
    const count = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM medusa_exchanges').get().n;
    const before = count();
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', priority: 'blocking' });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'PRIORITY_BINDING_REQUIRED');
    assert.equal(hub.received.length, 0);
    assert.equal(count(), before);
  });

  it('keeps a bound blocking send open until a bound reply, then awaits the initiator', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`,
      { to: builderWs, message: 'rule on X', priority: 'blocking', reason: 'awaiting-ruling' }, bPM.headers);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.exchange.replyRequired, true);
    assert.equal(sent.data.exchange.sender.verified, true);
    const hubId = sent.data.id;
    deliverToBuilder(hubId);
    await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, bBuilder.headers);
    assert.equal(store.medusaExchanges.getByHubId(hubId, 'send').state, 'acknowledged');

    const unbound = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'done', inReplyTo: hubId });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.data.code, 'EXCHANGE_BINDING_REQUIRED');

    const reply = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'ruled', inReplyTo: hubId }, bBuilder.headers);
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    const target = store.medusaExchanges.getByHubId(hubId, 'send');
    assert.equal(target.state, 'replied');
    assert.equal(target.terminal_at, null);

    const byBuilder = await call(server, 'POST', `${builderBase()}/exchanges/${target.exchange_id}/close`, null, bBuilder.headers);
    assert.equal(byBuilder.status, 403, 'the Builder did not send it');
    assert.equal(byBuilder.data.code, 'NOT_INITIATOR');
    const missing = await call(server, 'POST', `${pmBase()}/exchanges/mx_nope/close`, null, bPM.headers);
    assert.equal(missing.status, 404);
    const unboundClose = await call(server, 'POST', `${pmBase()}/exchanges/${target.exchange_id}/close`, null);
    assert.equal(unboundClose.status, 403);
    assert.equal(unboundClose.data.code, 'EXCHANGE_BINDING_REQUIRED');
    const closed = await call(server, 'POST', `${pmBase()}/exchanges/${target.exchange_id}/close`, null, bPM.headers);
    assert.equal(closed.status, 200);
    assert.equal(closed.data.exchange.state, 'closed');
  });

  it('reserves critical to the operator and records the proof tier honestly', async () => {
    const byProject = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', priority: 'critical' }, bPM.headers);
    assert.equal(byProject.status, 403);
    assert.equal(byProject.data.code, 'PRIORITY_RESERVED');
    const byOperator = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', priority: 'critical' }, op);
    assert.equal(byOperator.status, 200, JSON.stringify(byOperator.data));
    const row = store.medusaExchanges.get(byOperator.data.exchange.exchangeId);
    assert.equal(row.sender_proof, 'ambient-open');
  });

  it('reports a lost Hub answer as send_unknown and never re-sends the same requestId', async () => {
    hub.setMode('drop');
    const first = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', requestId: 'req-drop-1' });
    assert.equal(first.status, 502);
    assert.equal(first.data.exchange.state, 'send_unknown');
    const attempts = hub.received.length;
    hub.setMode('ok');
    const retry = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', requestId: 'req-drop-1' });
    assert.equal(retry.status, 409);
    assert.equal(retry.data.code, 'SEND_ALREADY_ATTEMPTED');
    assert.equal(hub.received.length, attempts, 'the retry never reached the Hub');
  });

  it('ends an explicit Hub refusal as undeliverable', async () => {
    hub.setMode('refuse');
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' });
    assert.equal(res.status, 502);
    assert.equal(res.data.exchange.state, 'undeliverable');
  });

  it('records a Hub success without an id as send_unknown', async () => {
    hub.setMode('noid');
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' });
    assert.equal(res.status, 200);
    assert.equal(res.data.exchange.state, 'send_unknown');
  });

  it('refuses a protected priority to a workspace this host cannot supervise, and leaves normal mail untracked', async () => {
    const blocked = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x', priority: 'blocking' }, bPM.headers);
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, 'WATCHDOG_UNAVAILABLE_REMOTE');
    assert.equal(hub.received.length, 0);
    hub.roster.push({ id: 'remote-ws' });
    const normal = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' });
    assert.equal(normal.status, 200, JSON.stringify(normal.data));
    assert.equal(normal.data.exchange.tracking, 'untracked');
  });

  it('shows a lost or refused Hub answer on an untracked send too', async () => {
    hub.setMode('drop');
    const lost = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' });
    assert.equal(lost.status, 502);
    assert.equal(lost.data.exchange.tracking, 'untracked');
    assert.equal(lost.data.exchange.state, 'send_unknown');
    hub.setMode('refuse');
    const refused = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' });
    assert.equal(refused.status, 502);
    assert.equal(refused.data.exchange.state, 'undeliverable');
  });

  it('records the dashboard marking mail handled as operator-ui, and it does not satisfy a reply', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', priority: 'blocking' }, bPM.headers);
    const hubId = sent.data.id;
    deliverToBuilder(hubId);
    await call(server, 'GET', `${builderBase()}/messages`, null, op);
    await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, op);
    const x = store.medusaExchanges.getByHubId(hubId, 'send');
    const facts = store.medusaExchanges.facts(x.exchange_id);
    assert.equal(facts.find((f) => f.fact === 'read').actor, 'operator-ui');
    assert.equal(facts.find((f) => f.fact === 'acknowledged').actor, 'operator-ui');
    assert.equal(x.state, 'acknowledged');
    assert.equal(x.terminal_at, null);
  });

  it('records nothing when a sender reports its own message to someone else as handled', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
    const hubId = sent.data.id;
    await call(server, 'POST', `${pmBase()}/read`, { ids: [hubId] }, bPM.headers);
    await call(server, 'POST', `${pmBase()}/read`, { ids: [hubId] });
    const x = store.medusaExchanges.getByHubId(hubId, 'send');
    assert.equal(x.state, 'stored');
    assert.ok(!store.medusaExchanges.facts(x.exchange_id).some((f) => f.fact === 'acknowledged'));
  });

  it('lists a session\'s sent and received exchanges without bodies', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'secret body' }, bPM.headers);
    deliverToBuilder(sent.data.id);
    const mine = await call(server, 'GET', `${pmBase()}/exchanges`, null, bPM.headers);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.exchanges.length, 1);
    const theirs = await call(server, 'GET', `${builderBase()}/exchanges?direction=received`, null, bBuilder.headers);
    assert.equal(theirs.data.exchanges.length, 1);
    assert.ok(!JSON.stringify(theirs.data).includes('secret body'));
  });

  it('accepts bounded watchdog settings through PATCH /api/config and refuses the rest', async () => {
    const bad = await call(server, 'PATCH', '/api/config', { medusaWatchdog: { tickMs: 1 } }, op);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /tickMs/);
    const unknown = await call(server, 'PATCH', '/api/config', { medusaWatchdog: { escalateEverything: true } }, op);
    assert.equal(unknown.status, 400);
    const ok = await call(server, 'PATCH', '/api/config', { medusaWatchdog: { maxRearms: 2 } }, op);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(store.config.load().medusaWatchdog.maxRearms, 2);
    await call(server, 'PATCH', '/api/config', { medusaWatchdog: { rearmAfterMs: 120000 } }, op);
    assert.deepEqual(store.config.load().medusaWatchdog, { maxRearms: 2, rearmAfterMs: 120000 }, 'patches merge');
  });

  it('lists escalated exchanges for the operator and summarizes them on the server-info poll', async () => {
    const watchdog = require('../lib/medusa-watchdog');
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'secret body', priority: 'blocking' }, bPM.headers);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const origSend = watchdog._internal.sendSystemMessage;
    watchdog._internal.sendSystemMessage = async () => ({ status: 'received' });
    try {
      const x = store.medusaExchanges.get(sent.data.exchange.exchangeId);
      await watchdog.tick(Date.parse(x.created_at) + 61 * 60 * 1000).notices;
    } finally {
      watchdog._internal.sendSystemMessage = origSend;
    }
    const list = await call(server, 'GET', '/api/medusa/escalations', null, op);
    assert.equal(list.status, 200);
    const mine = list.data.escalations.find((e) => e.exchangeId === sent.data.exchange.exchangeId);
    assert.ok(mine, 'the escalated exchange is listed');
    assert.equal(mine.escalation, 'operator');
    assert.equal(mine.recipientName, builder.name);
    assert.ok(!JSON.stringify(list.data).includes('secret body'), 'no message text');
    const info = await call(server, 'GET', '/api/server-info', null, op);
    assert.ok(info.data.medusaEscalations && info.data.medusaEscalations.count >= 1);
  });

  it('drops a session from the undelivered list once its mail is handled by hand (#1435)', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', priority: 'blocking' }, bPM.headers);
    const hubId = sent.data.id;
    deliverToBuilder(hubId);
    store.medusaDeliveries.record({
      sessionId: String(bBuilder.sessionId), projectId: builder.id, workspaceId: builderWs,
      messageKey: hubId, unread: 1, channel: 'none', outcome: 'skipped', skipReason: 'pane-composer-has-input'
    });
    const listed = (await call(server, 'GET', '/api/medusa/deliveries', null, op)).data.undelivered;
    assert.ok(listed.some((d) => String(d.sessionId) === String(bBuilder.sessionId)), 'listed while the mail is unhandled');
    await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, bBuilder.headers);
    const after = (await call(server, 'GET', '/api/medusa/deliveries', null, op)).data.undelivered;
    assert.ok(!after.some((d) => String(d.sessionId) === String(bBuilder.sessionId)), 'gone once handled');
  });
});
