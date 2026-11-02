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
const medusaExchanges = require('../lib/medusa-exchanges');
const gateFallback = require('../lib/gate-fallback');
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

  it('refuses a normal send from a caller with no launch binding, before anything reaches the Hub or the record (#2233)', async () => {
    const count = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM medusa_exchanges').get().n;
    const before = count();
    const received = hub.received.length;
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'hello' });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
    assert.equal(hub.received.length, received);
    assert.equal(count(), before);
  });

  // This case used to send with no binding and assert the exchange was
  // recorded with an unverified sender. A send with no binding is now refused
  // (above), so no send is recorded unverified; what remains is the path a
  // normal send takes to its automatic close.
  it('follows a normal send from a bound sender to an automatic close', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'hello' }, bPM.headers);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.exchange.state, 'stored');
    assert.equal(sent.data.exchange.sender.verified, true);
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
    // The launch-binding floor answers a caller with no binding before the
    // route's own check of a blocking send is reached.
    assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
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

    // #1976 — the Ack Gate: a reply-required message cannot be marked handled
    // before it is answered.
    const earlyAck = await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, bBuilder.headers);
    assert.equal(earlyAck.status, 409);
    assert.equal(earlyAck.data.code, 'REPLY_REQUIRED_BEFORE_ACK');
    assert.equal(store.medusaExchanges.getByHubId(hubId, 'send').state, 'delivered', 'the refused ack changed nothing');

    const unbound = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'done', inReplyTo: hubId });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.data.code, 'LAUNCH_BINDING_REQUIRED');

    const reply = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'ruled', inReplyTo: hubId }, bBuilder.headers);
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    const target = store.medusaExchanges.getByHubId(hubId, 'send');
    assert.equal(target.state, 'replied');
    assert.equal(target.terminal_at, null);

    // Now that the reply is bound, the Ack Gate has nothing left to refuse.
    const ackAfterReply = await call(server, 'POST', `${builderBase()}/read`, { ids: [hubId] }, bBuilder.headers);
    assert.equal(ackAfterReply.status, 200);
    assert.equal(store.medusaExchanges.getByHubId(hubId, 'send').state, 'replied');

    const byBuilder = await call(server, 'POST', `${builderBase()}/exchanges/${target.exchange_id}/close`, null, bBuilder.headers);
    assert.equal(byBuilder.status, 403, 'the Builder did not send it');
    assert.equal(byBuilder.data.code, 'NOT_INITIATOR');
    const missing = await call(server, 'POST', `${pmBase()}/exchanges/mx_nope/close`, null, bPM.headers);
    assert.equal(missing.status, 404);
    const unboundClose = await call(server, 'POST', `${pmBase()}/exchanges/${target.exchange_id}/close`, null);
    assert.equal(unboundClose.status, 403);
    assert.equal(unboundClose.data.code, 'LAUNCH_BINDING_REQUIRED');
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
    const first = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', requestId: 'req-drop-1' }, bPM.headers);
    assert.equal(first.status, 502);
    assert.equal(first.data.exchange.state, 'send_unknown');
    const attempts = hub.received.length;
    hub.setMode('ok');
    const retry = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x', requestId: 'req-drop-1' }, bPM.headers);
    assert.equal(retry.status, 409);
    assert.equal(retry.data.code, 'SEND_ALREADY_ATTEMPTED');
    assert.equal(hub.received.length, attempts, 'the retry never reached the Hub');
  });

  it('ends an explicit Hub refusal as undeliverable', async () => {
    hub.setMode('refuse');
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
    assert.equal(res.status, 502);
    assert.equal(res.data.exchange.state, 'undeliverable');
  });

  it('records a Hub success without an id as send_unknown', async () => {
    hub.setMode('noid');
    const res = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
    assert.equal(res.status, 200);
    assert.equal(res.data.exchange.state, 'send_unknown');
  });

  it('refuses a protected priority to a workspace this host cannot supervise, and leaves normal mail untracked', async () => {
    const blocked = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x', priority: 'blocking' }, bPM.headers);
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, 'WATCHDOG_UNAVAILABLE_REMOTE');
    assert.equal(hub.received.length, 0);
    hub.roster.push({ id: 'remote-ws' });
    const normal = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' }, bPM.headers);
    assert.equal(normal.status, 200, JSON.stringify(normal.data));
    assert.equal(normal.data.exchange.tracking, 'untracked');
  });

  it('shows a lost or refused Hub answer on an untracked send too', async () => {
    hub.setMode('drop');
    const lost = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' }, bPM.headers);
    assert.equal(lost.status, 502);
    assert.equal(lost.data.exchange.tracking, 'untracked');
    assert.equal(lost.data.exchange.state, 'send_unknown');
    hub.setMode('refuse');
    const refused = await call(server, 'POST', `${pmBase()}/send`, { to: 'remote-ws', message: 'x' }, bPM.headers);
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
    // Viewing in the dashboard records no read (#1987); an explicit handled-mark does.
    assert.equal(facts.some((f) => f.fact === 'read'), false);
    assert.equal(facts.find((f) => f.fact === 'acknowledged').actor, 'operator-ui');
    assert.equal(x.state, 'acknowledged');
    assert.equal(x.terminal_at, null);
  });

  /**
   * Send a tracked message from the PM to the Builder, deliver it, and leave
   * it with a wake the Builder's pane did not accept: unread, awaiting read,
   * and due a re-arm.
   * @returns {Promise<string>} Hub id
   */
  const unreadWithWake = async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
    const hubId = sent.data.id;
    deliverToBuilder(hubId);
    medusaExchanges.recordWakeForRecipient(builderWs, 'wake_attempted', { detail: { nonce: 'n1' } });
    medusaExchanges.recordWakeForRecipient(builderWs, 'wake_not_accepted', { attemptNonce: 'n1' });
    return hubId;
  };
  const standing = (hubId) => {
    const x = store.medusaExchanges.getByHubId(hubId, 'send');
    const facts = store.medusaExchanges.facts(x.exchange_id);
    return { state: x.state, awaiting: medusaExchanges.pendingWakeCount(builderWs), rearm: medusaExchanges.rearmTrigger(facts), read: facts.filter((f) => f.fact === 'read') };
  };

  it('leaves the exchange untouched when the operator views the inbox in the dashboard (#1987)', async () => {
    const hubId = await unreadWithWake();
    const before = standing(hubId);
    assert.equal(before.awaiting, 1);
    assert.equal(before.rearm, 'not-accepted');
    const viewed = await call(server, 'GET', `${builderBase()}/messages`, null, op);
    assert.equal(viewed.status, 200);
    assert.ok(viewed.data.messages.some((m) => m.id === hubId), 'the operator sees the message');
    assert.deepEqual(standing(hubId), before, 'no read fact, still awaiting read, re-arm still due, same projection');
    assert.ok(medusa.getStatus(bBuilder.sessionId).unread > 0, 'unread stays pending');
    const again = await call(server, 'GET', `${builderBase()}/messages`, null, op);
    assert.ok(again.data.messages.some((m) => m.id === hubId), 'still in the inbox');
    const pmCaller = { kind: 'project', projectId: pm.id };
    assert.equal(medusaExchanges.retract(hubId, pmCaller, { reason: 'superseded' }).state, 'retracted', 'still retractable');
  });

  it('records no read for a dashboard view whose operator cannot be proven (gate in fallback)', async () => {
    const hubId = await unreadWithWake();
    const before = standing(hubId);
    const cfg = store.config.load();
    const prevAuth = cfg.authEnabled;
    store.users.create(`rosie${Date.now()}`, 'correct horse battery staple');
    store.config.save({ ...cfg, authEnabled: true });
    gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
    try {
      const viewed = await call(server, 'GET', `${builderBase()}/messages`, null, op);
      assert.equal(viewed.status, 200, JSON.stringify(viewed.data));
      assert.ok(viewed.data.messages.some((m) => m.id === hubId));
    } finally {
      gateFallback.removeMarker(gateFallback.markerPath());
      store.getDb().prepare('DELETE FROM users').run();
      store.config.save({ ...store.config.load(), authEnabled: prevAuth });
    }
    assert.deepEqual(standing(hubId), before, 'no unverified-reader read either');
    // A caller that is not browser-shaped (an agent's plain curl) still records its read.
    await call(server, 'GET', `${builderBase()}/messages`);
    assert.equal(standing(hubId).read[0].actor, 'unverified-reader');
  });

  it('still records the agent\'s own read, with every transition it carries (#1987 pair)', async () => {
    const hubId = await unreadWithWake();
    const read = await call(server, 'GET', `${builderBase()}/messages`, null, bBuilder.headers);
    assert.equal(read.status, 200);
    const after = standing(hubId);
    assert.equal(after.read.length, 1);
    assert.equal(after.read[0].actor, 'recipient');
    assert.equal(after.state, 'read');
    assert.equal(after.awaiting, 0);
    assert.equal(after.rearm, null);
    const pmCaller = { kind: 'project', projectId: pm.id };
    assert.throws(() => medusaExchanges.retract(hubId, pmCaller, { reason: 'superseded' }), { code: 'NOT_RETRACTABLE' });
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

  // #2137 — ?role= aliases direction, and role=all merges both sides.
  it('?role=sender/recipient alias direction', async () => {
    const sentByPm = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'from pm' }, bPM.headers);
    deliverToBuilder(sentByPm.data.id);
    const sentByBuilder = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'from builder' }, bBuilder.headers);
    assert.equal(sentByBuilder.status, 200, JSON.stringify(sentByBuilder.data));

    const asSender = await call(server, 'GET', `${pmBase()}/exchanges?role=sender`, null, bPM.headers);
    assert.equal(asSender.status, 200);
    assert.deepEqual(asSender.data.exchanges.map((x) => x.hubId), [sentByPm.data.id]);
    const viaDirection = await call(server, 'GET', `${pmBase()}/exchanges?direction=sent`, null, bPM.headers);
    assert.deepEqual(viaDirection.data.exchanges.map((x) => x.hubId), asSender.data.exchanges.map((x) => x.hubId),
      'role=sender is exactly direction=sent');

    const asRecipient = await call(server, 'GET', `${pmBase()}/exchanges?role=recipient`, null, bPM.headers);
    assert.equal(asRecipient.status, 200);
    assert.deepEqual(asRecipient.data.exchanges.map((x) => x.hubId), [sentByBuilder.data.id]);
  });

  /**
   * A send recorded directly through the library (not the HTTP route), so its
   * `created_at` can be pinned via {@link medusaExchanges._internal}.now — the
   * precision a real `/send` round-trip cannot offer when several must sort
   * in a known order.
   * @param {{senderProjectId: number, senderWs: string, recipientWs: string, recipientProjectId: (number|null),
   *   hubId: string, atMs: number}} opts
   * @returns {object} The bound exchange row
   */
  function sendAt({ senderProjectId, senderWs, recipientWs, recipientProjectId, hubId, atMs }) {
    const real = medusaExchanges._internal.now;
    medusaExchanges._internal.now = () => new Date(atMs);
    try {
      const x = medusaExchanges.createSendIntent({
        meta: medusaExchanges.validateSendMeta({}, { kind: 'project', projectId: senderProjectId }, senderProjectId),
        sender: { projectId: senderProjectId, sessionId: 9, workspaceId: senderWs },
        recipient: { workspaceId: recipientWs, projectId: recipientProjectId, sessionId: null }
      });
      return medusaExchanges.bindHubId(x.exchange_id, hubId, { hubStatus: 'received' });
    } finally {
      medusaExchanges._internal.now = real;
    }
  }

  it('?role=all merges both sides newest-first, collapses a TRUE duplicate (sender and recipient are the same exchange), and caps at ?limit', async () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    // Oldest to newest: a plain received, a plain sent, then one exchange that
    // is BOTH sent and received by this project (PM messaging itself) — the
    // one row a naive concat (rather than a true id-keyed dedup) would double.
    const received = sendAt({
      senderProjectId: builder.id, senderWs: builderWs, recipientWs: pmWs, recipientProjectId: pm.id,
      hubId: 'hub-role-all-received', atMs: t0
    });
    const sent = sendAt({
      senderProjectId: pm.id, senderWs: pmWs, recipientWs: builderWs, recipientProjectId: builder.id,
      hubId: 'hub-role-all-sent', atMs: t0 + 1000
    });
    const self = sendAt({
      senderProjectId: pm.id, senderWs: pmWs, recipientWs: pmWs, recipientProjectId: pm.id,
      hubId: 'hub-role-all-self', atMs: t0 + 2000
    });

    const all = await call(server, 'GET', `${pmBase()}/exchanges?role=all`, null, bPM.headers);
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.exchanges.map((x) => x.exchangeId), [self.exchange_id, sent.exchange_id, received.exchange_id],
      'newest first — the self-exchange appears exactly once, not twice');

    const capped = await call(server, 'GET', `${pmBase()}/exchanges?role=all&limit=2`, null, bPM.headers);
    assert.equal(capped.status, 200);
    assert.deepEqual(capped.data.exchanges.map((x) => x.exchangeId), [self.exchange_id, sent.exchange_id],
      'limit caps the MERGED, deduplicated result — not each side independently');
  });

  // R-Gate Round 2 on PR #2813: medusa.getStatus() reports workspaceId: null
  // for a STOPPED listener — that is liveness, not identity. A received
  // exchange is filed under the registry's durable workspace id, which
  // outlives the listener; ?role=recipient/all must still find it.
  it('?role=recipient and ?role=all still return a persisted received exchange once the listener has stopped', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
    deliverToBuilder(sent.data.id);
    medusa.stopSession(bBuilder.sessionId);
    assert.equal(medusa.getStatus(bBuilder.sessionId).workspaceId, null, 'no live listener — this is the off case');

    const asRecipient = await call(server, 'GET', `${builderBase()}/exchanges?role=recipient`, null, bBuilder.headers);
    assert.equal(asRecipient.status, 200);
    assert.deepEqual(asRecipient.data.exchanges.map((x) => x.hubId), [sent.data.id]);

    const all = await call(server, 'GET', `${builderBase()}/exchanges?role=all`, null, bBuilder.headers);
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.exchanges.map((x) => x.hubId), [sent.data.id]);
  });

  // R-Gate Round 3 on PR #2813: the Ack Gate's own workspaceId resolution had
  // the identical gap — a session that read a reply-required message, then
  // stopped its listener, must still be refused on POST .../read.
  it('the Ack Gate still refuses an unanswered reply-required message once the listener has stopped', async () => {
    const sent = await call(server, 'POST', `${pmBase()}/send`,
      { to: builderWs, message: 'rule on X', priority: 'blocking', reason: 'awaiting-ruling' }, bPM.headers);
    assert.equal(sent.data.exchange.replyRequired, true);
    deliverToBuilder(sent.data.id);
    medusa.stopSession(bBuilder.sessionId);
    assert.equal(medusa.getStatus(bBuilder.sessionId).workspaceId, null, 'no live listener — this is the off case');

    const ack = await call(server, 'POST', `${builderBase()}/read`, { ids: [sent.data.id] }, bBuilder.headers);
    assert.equal(ack.status, 409);
    assert.equal(ack.data.code, 'REPLY_REQUIRED_BEFORE_ACK');
  });

  // #1873 — the retraction route itself (the library function has its own
  // direct-call coverage in test/medusa-exchanges.test.js; this exercises
  // caller resolution, the coordinator gate wiring, and the best-effort
  // side effects only the route performs).
  describe('POST /messages/:hubId/retract (#1873)', () => {
    it('refuses an unbound caller and a non-sender, before succeeding for the verified sender', async () => {
      const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
      const hubId = sent.data.id;

      const unbound = await call(server, 'POST', `${pmBase()}/messages/${hubId}/retract`, { reason: 'superseded' });
      assert.equal(unbound.status, 403);
      assert.equal(unbound.data.code, 'LAUNCH_BINDING_REQUIRED');

      const notTheSender = await call(server, 'POST', `${builderBase()}/messages/${hubId}/retract`, { reason: 'superseded' }, bBuilder.headers);
      assert.equal(notTheSender.status, 403);
      assert.equal(notTheSender.data.code, 'NOT_INITIATOR');

      const ok = await call(server, 'POST', `${pmBase()}/messages/${hubId}/retract`, { reason: 'sent-in-error' }, bPM.headers);
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.exchange.state, 'retracted');
      assert.equal(ok.data.exchange.ended.code, 'sent-in-error');
    });

    it('is refused once read, and propagates a 404 for an id nothing sent', async () => {
      const missing = await call(server, 'POST', `${pmBase()}/messages/hub-no-such-id/retract`, { reason: 'superseded' }, bPM.headers);
      assert.equal(missing.status, 404);
      assert.equal(missing.data.code, 'EXCHANGE_NOT_FOUND');

      const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
      const hubId = sent.data.id;
      deliverToBuilder(hubId);
      await call(server, 'GET', `${builderBase()}/messages`, null, bBuilder.headers);
      const refused = await call(server, 'POST', `${pmBase()}/messages/${hubId}/retract`, { reason: 'superseded' }, bPM.headers);
      assert.equal(refused.status, 409);
      assert.equal(refused.data.code, 'NOT_RETRACTABLE');
    });

    it('is refused for a HOLD/STOP/RELEASE control notice, even for the operator', async () => {
      store.control.insertReceipt({
        event_id: 'evt-retract-ctl-1', fact: 'notify_attempted', outcome_code: 'sent',
        actor_principal: 'system', notice_ref: 'hub-ctl-retract-1'
      });
      const refused = await call(server, 'POST', `${pmBase()}/messages/hub-ctl-retract-1/retract`, { reason: 'superseded' }, op);
      assert.equal(refused.status, 409);
      assert.equal(refused.data.code, 'CONTROL_NOT_RETRACTABLE');
    });

    it('clears the retracted message from a live recipient session\'s own inbox', async () => {
      const sent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'x' }, bPM.headers);
      const hubId = sent.data.id;
      deliverToBuilder(hubId);
      const before = await call(server, 'GET', `${builderBase()}/messages`, null, op);
      assert.ok(before.data.messages.some((m) => m.id === hubId), 'in the inbox before retraction');

      const retracted = await call(server, 'POST', `${pmBase()}/messages/${hubId}/retract`, { reason: 'superseded' }, bPM.headers);
      assert.equal(retracted.status, 200, JSON.stringify(retracted.data));

      const after = await call(server, 'GET', `${builderBase()}/messages`, null, op);
      assert.ok(!after.data.messages.some((m) => m.id === hubId), 'cleared from the recipient\'s own inbox');
    });

    it('sends a best-effort system retraction notice only when a wake was already attempted', async () => {
      const silent = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'no wake yet' }, bPM.headers);
      deliverToBuilder(silent.data.id);
      const beforeCount = hub.received.length;
      const r1 = await call(server, 'POST', `${pmBase()}/messages/${silent.data.id}/retract`, { reason: 'superseded' }, bPM.headers);
      assert.equal(r1.status, 200, JSON.stringify(r1.data));
      assert.equal(hub.received.length, beforeCount, 'no wake was attempted, so no notice is sent');

      const woken = await call(server, 'POST', `${pmBase()}/send`, { to: builderWs, message: 'woken then retracted' }, bPM.headers);
      deliverToBuilder(woken.data.id);
      medusaExchanges.recordWakeForRecipient(builderWs, 'wake_attempted', { detail: { nonce: 'n-retract' } });
      const r2 = await call(server, 'POST', `${pmBase()}/messages/${woken.data.id}/retract`, { reason: 'sent-in-error', replacementHubId: null }, bPM.headers);
      assert.equal(r2.status, 200, JSON.stringify(r2.data));
      const notice = hub.received.find((m) => m.to === builderWs && typeof m.message === 'string' && m.message.includes('[Medusa Retraction]'));
      assert.ok(notice, 'a system notice named the retraction');
      assert.match(notice.message, new RegExp(woken.data.id));
      assert.match(notice.message, /sent-in-error/);
    });

    it('the Builder sweeping its OWN sent message leaves the PM\'s side alone', async () => {
      const sent = await call(server, 'POST', `${builderBase()}/send`, { to: pmWs, message: 'x' }, bBuilder.headers);
      const retracted = await call(server, 'POST', `${builderBase()}/messages/${sent.data.id}/retract`, { reason: 'no-longer-needed' }, bBuilder.headers);
      assert.equal(retracted.status, 200, JSON.stringify(retracted.data));
      assert.equal(retracted.data.exchange.state, 'retracted');
    });
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
    // replyRequired: false — this test is about the delivery ledger, not the
    // #1976 Ack Gate; a reply-required blocking send would refuse the ack below.
    const sent = await call(server, 'POST', `${pmBase()}/send`,
      { to: builderWs, message: 'x', priority: 'blocking', replyRequired: false }, bPM.headers);
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
