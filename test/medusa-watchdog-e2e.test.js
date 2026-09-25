'use strict';

// #1839 exit test on an isolated instance: a scratch store and an in-process
// server on an ephemeral port, never the live service. A fake Hub mirrors the
// real one's order of events (it pushes a message to an online recipient
// BEFORE it answers the sender, and uses one id for both), so the arrival
// really does beat the send's answer here, as it does live.
//
// The scenario the plan names: a blocking message lands on a Builder whose
// composer holds a draft, so it cannot be woken. Server time moves on. The
// sender is told it aged, the PM on the assignment's escalation route is told,
// the operator sees it on the dashboard poll. Then the Builder reads, acks and
// replies, the PM closes it, and every surface clears.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const wake = require('../lib/medusa-wake');
const watchdog = require('../lib/medusa-watchdog');
const controlApi = require('../lib/control-api');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

// A Claude pane whose composer holds the operator's half-typed text, with the
// cursor sitting in it: the live-captured shape the wake monitor refuses to
// type over (the same fixture shape as test/medusa-wake.test.js).
const DRAFT_LINE = "❯ can you check why tilt-claw isn't responding?";
const DRAFT_PANE = [
  '  Churned for 17s',
  '',
  DRAFT_LINE,
  '  master | Opus 5 (1M context) | 95% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
];
const DRAFT_CURSOR = { x: 47, line: DRAFT_LINE };

const MIN = 60 * 1000;

/** Minimal fake WebSocket matching what MedusaListener drives. */
class FakeWS {
  /** @param {string} url - Requested URL */
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._h = Object.create(null);
  }

  /** @param {string} t - Event @param {Function} h - Handler @returns {void} */
  addEventListener(t, h) {
    (this._h[t] || (this._h[t] = [])).push(h);
  }

  /** @returns {void} */
  send() {}

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
    this.readyState = 1;
    for (const h of this._h.open || []) h({});
  }
}

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server - Test server
 * @param {string} method - Method
 * @param {string} urlPath - Path
 * @param {object|null} body - Body
 * @param {Record<string, string>} [headers] - Headers
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

describe('#1839 exit: an unreadable blocking message escalates, then clears once answered (isolated instance)', () => {
  let tmpDir;
  let server;
  let hub;
  let pm;
  let builder;
  let bPM;
  let bBuilder;
  const sockets = new Map();
  const hubLog = [];
  const savedWake = {};
  const injected = [];

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1839-e2e-'));
    store._setBasePath(tmpDir);
    store.init();

    // The fake Hub: one id per message, pushed to an online recipient before
    // the sender gets its answer, exactly as src/medusa/medusa-server.js does.
    hub = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/messages/direct') {
          const id = crypto.randomUUID();
          const msg = { id, type: 'direct', from: body.from, to: body.to, message: body.message, timestamp: new Date().toISOString() };
          hubLog.push(msg);
          const ws = sockets.get(body.to);
          if (ws) ws.recv({ type: 'new_message', messageId: id, message: msg });
          res.end(JSON.stringify({ success: true, status: ws ? 'received' : 'queued', id }));
          return;
        }
        if (req.method === 'GET' && req.url === '/workspaces') {
          res.end(JSON.stringify({ workspaces: [...sockets.keys()].map((id) => ({ id })) }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
    medusa._setBridgeHttpUrl(`http://127.0.0.1:${hub.address().port}`);

    pm = mkProject('e2e-pm');
    builder = mkProject('e2e-builder');
    bPM = bindProject(pm);
    bBuilder = bindProject(builder);
    for (const [project, binding] of [[pm, bPM], [builder, bBuilder]]) {
      let socket;
      const { workspaceId } = medusa.startSession({
        projectPath: project.path, sessionId: binding.sessionId, name: project.name,
        wsFactory: (u) => (socket = new FakeWS(u))
      });
      socket.open();
      socket.recv({ type: 'registered', workspaceId, connectionId: 'c1' });
      sockets.set(workspaceId, socket);
    }

    // The wake monitor sees the Builder's pane holding a half-typed draft.
    Object.assign(savedWake, wake._internal);
    const liveBuilder = { ...store.sessions.get(bBuilder.sessionId), tmuxSession: 'tc-e2e-builder', sessionMode: 'tmux', engineId: 'claude' };
    const liveReal = wake._internal.listLiveAll;
    wake._internal.listLiveAll = () => liveReal().map((s) => (s.id === bBuilder.sessionId ? liveBuilder : s));
    wake._internal.loadProjectConfig = () => ({ medusaWake: true });
    wake._internal.wrapRunning = () => false;
    wake._internal.capturePane = () => ({ lines: DRAFT_PANE });
    wake._internal.cursorInfo = () => DRAFT_CURSOR;
    wake._internal.masterWakeRecord = () => null;
    wake._internal.injectCommand = (name, command) => { injected.push(command); return { ok: true, error: null }; };
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    wake.stop();
    Object.assign(wake._internal, savedWake);
    medusa.stopSession(bPM.sessionId);
    medusa.stopSession(bBuilder.sessionId);
    medusa._setBridgeHttpUrl();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => hub.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs end to end', async () => {
    const op = operatorHeaders(server);
    const pmWs = medusa.getStatus(bPM.sessionId).workspaceId;
    const builderWs = medusa.getStatus(bBuilder.sessionId).workspaceId;
    const pmBase = `/api/sessions/${pm.name}/medusa`;
    const builderBase = `/api/sessions/${builder.name}/medusa`;

    // The operator governs the Builder and routes its escalations to the PM.
    const asg = await call(server, 'POST', '/api/control/assignments', {
      projectId: builder.id, requestId: 'e2e-asg', issueRef: '#1839',
      authority: { hold: [`project:${pm.id}`], escalation: { blocking: [`project:${pm.id}`] } }
    }, op);
    assert.equal(asg.status, 201, JSON.stringify(asg.data));

    // The PM sends a blocking question. The Hub pushes it to the Builder
    // before answering the PM, so the arrival is adopted by the send.
    const sent = await call(server, 'POST', `${pmBase}/send`,
      { to: builderWs, message: 'Which schema version?', priority: 'blocking', reason: 'awaiting-ruling' }, bPM.headers);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const exchangeId = sent.data.exchange.exchangeId;
    const row = () => store.medusaExchanges.get(exchangeId);
    assert.equal(row().state, 'delivered', 'the early arrival was adopted');
    assert.equal(row().hub_id, sent.data.id, 'the recipient saw the same id the sender was given');

    // The wake monitor cannot wake a pane with a draft in its composer.
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED + 1; i++) wake._internal.tick();
    assert.equal(injected.length, 0, 'a draft is never typed over');
    assert.equal(row().wake_code, 'pane-composer-has-input');

    // Server time moves on; nothing is read.
    const t0 = Date.parse(row().created_at);
    const notices = () => hubLog.filter((m) => m.from === 'system').map((m) => JSON.parse(m.message));
    await watchdog.tick(t0 + 5 * MIN).notices;
    assert.deepEqual(notices().map((n) => [n.level, n.to]), [['aged', 'sender']]);
    assert.equal(hubLog.filter((m) => m.from === 'system')[0].to, pmWs, 'the sender is told at its own workspace');
    assert.equal(notices()[0].blocker, 'pane-composer-has-input', 'with the real blocker named');

    await watchdog.tick(t0 + 15 * MIN).notices;
    const escalated = notices().filter((n) => n.level === 'escalated');
    assert.deepEqual(escalated.map((n) => n.to).sort(), ['escalation', 'sender']);
    assert.equal(escalated.find((n) => n.to === 'escalation').controlState, 'active');

    await watchdog.tick(t0 + 60 * MIN).notices;
    const info = await call(server, 'GET', '/api/server-info', null, op);
    assert.equal(info.data.medusaEscalations.count, 1);
    assert.equal(info.data.medusaEscalations.oldest.recipient, builder.name);
    assert.equal(info.data.medusaEscalations.oldest.blocker, 'pane-composer-has-input');
    assert.ok(!hubLog.filter((m) => m.from === 'system').some((m) => m.message.includes('Which schema version?')),
      'no notice ever carries the message text');
    const before = hubLog.length;
    await watchdog.tick(t0 + 61 * MIN).notices;
    assert.equal(hubLog.length, before, 'a later tick repeats nothing');

    // The Builder finally reads and acks it. A reply is required, so the
    // exchange stays open; the Builder replies, and the PM closes it.
    const inbox = await call(server, 'GET', `${builderBase}/messages`, null, bBuilder.headers);
    assert.ok(inbox.data.messages.some((m) => m.id === sent.data.id));
    await call(server, 'POST', `${builderBase}/read`, { ids: [sent.data.id] }, bBuilder.headers);
    assert.equal(row().state, 'acknowledged');
    assert.equal(row().terminal_at, null);
    const reply = await call(server, 'POST', `${builderBase}/send`,
      { to: pmWs, message: 'v49.', inReplyTo: sent.data.id }, bBuilder.headers);
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    assert.equal(row().state, 'replied');
    const closed = await call(server, 'POST', `${pmBase}/exchanges/${exchangeId}/close`, null, bPM.headers);
    assert.equal(closed.status, 200);
    assert.equal(row().state, 'closed');

    const cleared = await call(server, 'GET', '/api/server-info', null, op);
    assert.equal(cleared.data.medusaEscalations, null, 'the banner clears once the exchange is closed');
    const list = await call(server, 'GET', '/api/medusa/escalations', null, op);
    assert.ok(!list.data.escalations.some((e) => e.exchangeId === exchangeId));
  });
});
