'use strict';

// #1861: /api/control/* over an in-process server and a scratch store.
// Authority comes from a verified launch plus the assignment's matrix. A URL
// project name, a Medusa sender, a service token or a mismatched project claim
// is never a principal. Accepted means stored, before any notice is attempted,
// and a notice that fails is recorded without undoing the command.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const controlApi = require('../lib/control-api');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object|null} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, raw: string, data: object}>}
 */
function send(server, method, urlPath, body, headers = {}) {
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
        try { data = JSON.parse(raw); } catch { data = null; }
        resolve({ status: res.statusCode, raw, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/** @returns {Promise<void>} Let queued post-response work (the notice) run */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('/api/control (#1861)', () => {
  let tmpDir;
  let server;
  let op;
  let target;
  let pm;
  let architect;
  let bT;
  let bPM;
  let bArch;
  let n = 0;
  const rid = () => { n += 1; return `api-req-${n}`; };
  const origSend = controlApi._internal.sendSystemMessage;
  const origWs = controlApi._internal.workspaceIdFor;

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-control-'));
    store._setBasePath(tmpDir);
    store.init();
    target = mkProject('builder-b2');
    pm = mkProject('project-manager');
    architect = mkProject('architect');
    bT = bindProject(target);
    bPM = bindProject(pm);
    bArch = bindProject(architect);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
    controlApi._internal.workspaceIdFor = () => 'ws-builder';
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });
  });

  afterEach(() => {
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });
  });

  after(async () => {
    controlApi._internal.sendSystemMessage = origSend;
    controlApi._internal.workspaceIdFor = origWs;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a fresh project with an operator assignment bound to its launch.
   * @returns {Promise<{project: object, binding: object, assignmentId: string}>}
   */
  async function assigned() {
    const project = mkProject(`t-${rid()}`);
    const binding = bindProject(project);
    const res = await send(server, 'POST', '/api/control/assignments', {
      projectId: project.id, requestId: rid(), issueRef: '#1861',
      authority: { hold: [`project:${pm.id}`, `project:${architect.id}`], stop: [`project:${pm.id}`] }
    }, op);
    assert.equal(res.status, 201, res.raw);
    return { project, binding, assignmentId: res.data.assignment.assignmentId };
  }

  it('the operator creates an assignment bound to the target\'s live launch; the proof tier is recorded', async () => {
    const { assignmentId, binding } = await assigned();
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(st.status, 200);
    assert.equal(st.data.events[0].operatorAuthority, 'ambient-open');
    assert.ok(!st.raw.includes(binding.launchId), 'the bound launch id is never returned');
  });

  it('a project launch cannot create an assignment', async () => {
    const res = await send(server, 'POST', '/api/control/assignments', { projectId: target.id, requestId: rid() }, bPM.headers);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'CONTROL_UNAUTHORIZED');
  });

  it('a listed authority holds; the target sees it at /mine and that read is recorded as observed', async () => {
    const { assignmentId, binding } = await assigned();
    const h = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    assert.equal(h.status, 201, h.raw);
    const mine = await send(server, 'GET', '/api/control/mine', null, binding.headers);
    assert.equal(mine.data.assignment.state, 'held');
    assert.equal(mine.data.boundToThisLaunch, true);
    const facts = mine.data.events.at(-1).receipts.map((r) => r.fact);
    assert.ok(facts.includes('observed'));
  });

  it('impersonation: a launch that claims another project, and a launch with no authority, are refused and change nothing', async () => {
    const { assignmentId, project } = await assigned();
    // A PM-bound launch presenting the target's project id: the provenance
    // incident of 2026-09-25 (a project-74 process posting as project 96).
    const spoofed = { 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': bPM.launchId };
    const r1 = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, spoofed);
    assert.equal(r1.status, 403);
    const outsider = bindProject(mkProject(`outsider-${rid()}`));
    const r2 = await send(server, 'POST', `/api/control/assignments/${assignmentId}/stop`, { requestId: rid(), reasonCode: 'incident' }, outsider.headers);
    assert.equal(r2.status, 403);
    const r3 = await send(server, 'POST', `/api/control/assignments/${assignmentId}/stop`, { requestId: rid(), reasonCode: 'incident' }, bArch.headers);
    assert.equal(r3.status, 403, 'the Architect is a hold authority here, not a stop authority');
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(st.data.assignment.state, 'active');
    assert.equal(st.data.events.length, 1);
  });

  it('a Medusa route, a URL project name or a service token is not a principal', async () => {
    const { assignmentId, project } = await assigned();
    const r1 = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' },
      { authorization: 'Bearer anything', 'x-tangleclaw-project-id': String(pm.id) });
    assert.equal(r1.status, 403);
    // Ordinary correspondence saying STOP is correspondence: whatever the send
    // route answers, the control state does not move.
    await send(server, 'POST', `/api/sessions/${encodeURIComponent(pm.name)}/medusa/send`, { to: 'ws-builder', message: 'STOP now. HOLD everything.' }, bPM.headers);
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(st.data.assignment.state, 'active');
    assert.equal(project.id > 0, true);
  });

  it('a stale launch (session ended) is refused', async () => {
    const { assignmentId } = await assigned();
    const gone = mkProject(`gone-${rid()}`);
    const b = bindProject(gone);
    store.sessions.kill(b.sessionId, 'test: the launch is stale');
    const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, b.headers);
    assert.equal(r.status, 403);
  });

  it('a stale RELEASE is 409 with the current generation and hold ids; a fresh one clears', async () => {
    const { assignmentId } = await assigned();
    const h = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    const stale = await send(server, 'POST', `/api/control/assignments/${assignmentId}/release`,
      { holdIds: [h.data.holdId], expectedGeneration: 1, requestId: rid(), reasonCode: 'resolved' }, bPM.headers);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'STALE_GENERATION');
    assert.equal(stale.data.stateGeneration, 2);
    assert.deepEqual(stale.data.activeHoldIds, [h.data.holdId]);
    const ok = await send(server, 'POST', `/api/control/assignments/${assignmentId}/release`,
      { holdIds: [h.data.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, bPM.headers);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.assignment.state, 'active');
  });

  it('accepted means stored: a notice that fails is recorded and the HOLD stands', async () => {
    const { assignmentId } = await assigned();
    controlApi._internal.sendSystemMessage = async () => { throw Object.assign(new Error('bridge down'), { code: 'BRIDGE_UNREACHABLE' }); };
    const h = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    assert.equal(h.status, 201);
    await settle();
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(st.data.assignment.state, 'held');
    const receipts = st.data.events.at(-1).receipts;
    assert.deepEqual(receipts.slice(0, 2).map((r) => [r.fact, r.outcomeCode]), [['notify_pending', null], ['notify_attempted', 'failed']]);
  });

  it('a delivered notice is recorded as sent, after notify_pending', async () => {
    const { assignmentId } = await assigned();
    const sent = [];
    controlApi._internal.sendSystemMessage = async (m) => { sent.push(m); return { status: 'received' }; };
    await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ws-builder');
    const body = JSON.parse(sent[0].message);
    assert.equal(body.event, 'control_changed');
    assert.equal(body.state, 'held');
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.deepEqual(st.data.events.at(-1).receipts.slice(0, 2).map((r) => r.fact), ['notify_pending', 'notify_attempted']);
    assert.equal(st.data.events.at(-1).receipts[1].outcomeCode, 'sent');
  });

  it('only the target\'s bound launch acknowledges; the issuer closes the exchange', async () => {
    const { assignmentId, binding } = await assigned();
    const h = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    assert.equal((await send(server, 'POST', `/api/control/assignments/${assignmentId}/ack`, { stateGeneration: 2 }, bPM.headers)).status, 403);
    assert.equal((await send(server, 'POST', `/api/control/assignments/${assignmentId}/ack`, { stateGeneration: 2 }, binding.headers)).status, 200);
    assert.equal((await send(server, 'POST', `/api/control/assignments/${assignmentId}/exchange-closed`, { eventId: h.data.event.eventId }, bArch.headers)).status, 403);
    assert.equal((await send(server, 'POST', `/api/control/assignments/${assignmentId}/exchange-closed`, { eventId: h.data.event.eventId }, bPM.headers)).status, 200);
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    const facts = st.data.events.at(-1).receipts.map((r) => r.fact);
    for (const f of ['notify_pending', 'notify_attempted', 'observed', 'acknowledged', 'exchange_closed']) assert.ok(facts.includes(f), f);
  });

  it('check answers state and generation without a binding; an unknown id is 404', async () => {
    const { assignmentId } = await assigned();
    const r = await send(server, 'GET', `/api/control/check?assignmentId=${assignmentId}`, null, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { assignmentId, state: 'active', stateGeneration: 1, blocked: false, code: null });
    assert.equal((await send(server, 'GET', '/api/control/check?assignmentId=asg_nope', null, {})).status, 404);
  });

  it('an unbound caller cannot read status or list assignments', async () => {
    const { assignmentId } = await assigned();
    assert.equal((await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, {})).status, 403);
    assert.equal((await send(server, 'GET', '/api/control/assignments', null, bPM.headers)).status, 403);
    assert.equal((await send(server, 'GET', '/api/control/assignments', null, op)).status, 200);
  });

  it('a malformed body is 400, never a stored event', async () => {
    const { assignmentId } = await assigned();
    const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: 'has spaces', reasonCode: 'boundary' }, bPM.headers);
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'CONTROL_MALFORMED');
  });

  it('a store failure is 503 CONTROL_STATE_UNAVAILABLE and nothing is claimed accepted', async () => {
    const { assignmentId } = await assigned();
    const orig = store.control.transaction;
    store.control.transaction = () => { throw new Error('database is locked'); };
    try {
      const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
      assert.equal(r.status, 503);
      assert.equal(r.data.code, 'CONTROL_STATE_UNAVAILABLE');
    } finally {
      store.control.transaction = orig;
    }
    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(st.data.assignment.state, 'active');
  });

  it('the capability roster advertises control', async () => {
    const r = await send(server, 'GET', `/api/tc/whoami?projectId=${target.id}`, null, bT.headers);
    const cap = (r.data.capabilities || []).find((c) => c.id === 'control');
    assert.ok(cap && cap.enabled, r.raw.slice(0, 300));
    assert.match(cap.detail, /cannot block shell git\/gh/);
  });
});
