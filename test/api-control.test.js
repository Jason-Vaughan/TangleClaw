'use strict';

// #1861: /api/control/* over an in-process server and a scratch store.
// Authority comes from a verified launch plus the assignment's matrix. A URL
// project name, a Medusa sender, a service token or a mismatched project claim
// is never a principal. Accepted means stored, before any notice is attempted,
// and a notice that fails is recorded without undoing the command.

const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const controlApi = require('../lib/control-api');
const controlGate = require('../lib/control-gate');
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
  const origPaneSeams = { ...controlApi._internal };

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
    Object.assign(controlApi._internal, origPaneSeams);
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

  it('the target marking the control notice handled is recorded as observed; another inbox marking the same id is not', async () => {
    const { assignmentId, project, binding } = await assigned();
    let n2 = 0;
    controlApi._internal.sendSystemMessage = async () => { n2 += 1; return { status: 'received', id: `notice-${assignmentId}-${n2}` }; };
    await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    await settle();
    const noticeId = `notice-${assignmentId}-1`;
    await send(server, 'POST', `/api/sessions/${encodeURIComponent(pm.name)}/medusa/read`, { ids: [noticeId] }, bPM.headers);
    let st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.ok(!st.data.events.at(-1).receipts.some((r) => r.fact === 'observed'), 'another project\'s inbox proves nothing');
    await send(server, 'POST', `/api/sessions/${encodeURIComponent(project.name)}/medusa/read`, { ids: [noticeId, 'unrelated-mail'] }, binding.headers);
    st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    const observed = st.data.events.at(-1).receipts.filter((r) => r.fact === 'observed');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].outcomeCode, 'notice-handled');
    assert.equal(observed[0].actor, `project:${project.id}`);
  });

  it('a project governed after boot fails closed when the store later breaks', async () => {
    controlGate._resetForTests();
    const { project } = await assigned();
    const orig = store.control.getOpenForProject;
    store.control.getOpenForProject = () => { throw new Error('database is locked'); };
    try {
      const r = controlGate.checkMutation({ surface: 'wrap-commit', subject: { kind: 'target', projectId: project.id } });
      assert.equal(r && r.code, 'CONTROL_STATE_UNAVAILABLE');
    } finally {
      store.control.getOpenForProject = orig;
    }
  });

  it('the capability roster advertises control', async () => {
    const r = await send(server, 'GET', `/api/tc/whoami?projectId=${target.id}`, null, bT.headers);
    const cap = (r.data.capabilities || []).find((c) => c.id === 'control');
    assert.ok(cap && cap.enabled, r.raw.slice(0, 300));
    assert.match(cap.detail, /cannot block shell git\/gh/);
  });

  describe('POST /api/control/pause (#2109, Architect Ruling A26/A2109)', () => {
    /**
     * Bind a project's launch with a real tmux session name, so the pause
     * nudge's pane-busy check has something to read — plain `bindProject`
     * starts a session with no pane at all, which is the 'no-pane' case on
     * its own and cannot exercise 'sent'/'deferred-busy'.
     * @param {object} project
     * @returns {{launchId: string, sessionId: number, headers: object}}
     */
    function bindProjectWithPane(project) {
      const b = bindProject(project);
      store.getDb().prepare('UPDATE sessions SET tmux_session = ? WHERE id = ?').run(`tc-test-${b.sessionId}`, b.sessionId);
      return b;
    }

    /**
     * A target project paused by PM, escalating to the Architect, with a
     * real pane.
     * @returns {Promise<{project: object, assignmentId: string, binding: object}>}
     */
    async function pausable() {
      const project = mkProject(`pausable-${rid()}`);
      const binding = bindProjectWithPane(project);
      const res = await send(server, 'POST', '/api/control/assignments', {
        projectId: project.id, requestId: rid(), issueRef: '#2109',
        authority: { hold: [`project:${pm.id}`], escalation: { blocking: [`project:${architect.id}`] } }
      }, op);
      assert.equal(res.status, 201, res.raw);
      return { project, assignmentId: res.data.assignment.assignmentId, binding };
    }

    beforeEach(() => {
      Object.assign(controlApi._internal, origPaneSeams, {
        sendSystemMessage: async () => ({ status: 'received' }),
        workspaceIdFor: () => 'ws-builder',
        wakeProfiles: () => ({ claude: { busyMarker: 'esc to interrupt', promptRe: /^> / } }),
        capturePane: () => ({ lines: ['> '], alternateScreen: false }),
        cursorInfo: () => null,
        assessIdle: () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 }),
        inject: () => ({ ok: true, error: null })
      });
    });

    afterEach(() => { Object.assign(controlApi._internal, origPaneSeams); });

    it('an authorized peer pauses; the hold is distinct from an ordinary hold, and the pane nudge is sent', async () => {
      const { project, assignmentId } = await pausable();
      const injected = [];
      controlApi._internal.inject = (projectName, line, options) => { injected.push({ projectName, line, options }); return { ok: true, error: null }; };
      const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bPM.headers);
      assert.equal(r.status, 201, r.raw);
      assert.equal(r.data.assignment.state, 'held');
      assert.equal(r.data.nudge.status, 'sent');
      assert.equal(injected.length, 1);
      assert.equal(injected[0].projectName, project.name);
      assert.equal(injected[0].options.controlExempt, 'medusa-wake', 'without this, injectCommand\'s own controlGate would refuse to type into the lane this just HELD');
      const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
      assert.equal(st.data.events.at(-1).reasonCode, 'peer-pause-request');
    });

    it('a peer with no hold authority is refused, and nothing is paused or typed', async () => {
      const { project } = await pausable();
      const injected = [];
      controlApi._internal.inject = (...args) => { injected.push(args); return { ok: true, error: null }; };
      const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bArch.headers);
      assert.equal(r.status, 403);
      assert.equal(r.data.code, 'CONTROL_UNAUTHORIZED');
      assert.equal(injected.length, 0);
      const st = await send(server, 'GET', '/api/control/mine', null, bT.headers);
      assert.equal(st.data.assignment, null, 'unrelated projects are unaffected');
    });

    it('a project with no open assignment at all is 404, never a parallel pause record', async () => {
      const ungoverned = mkProject(`ungoverned-${rid()}`);
      const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: ungoverned.name }, bPM.headers);
      assert.equal(r.status, 404);
      assert.equal(r.data.code, 'ASSIGNMENT_NOT_FOUND');
    });

    it('a mid-turn (busy) target defers the pane nudge, escalates, and still blocks the next governed mutation', async () => {
      const { project, assignmentId } = await pausable();
      controlApi._internal.assessIdle = () => ({ idle: false, reason: 'turn-running', digest: 'd', idleTicks: 0 });
      const escalations = [];
      controlApi._internal.sendSystemMessage = async (m) => { escalations.push(m); return { status: 'received' }; };
      const injected = [];
      controlApi._internal.inject = (...args) => { injected.push(args); return { ok: true, error: null }; };

      const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bPM.headers);
      assert.equal(r.status, 201, r.raw);
      assert.equal(r.data.nudge.status, 'deferred-busy');
      assert.equal(r.data.nudge.reason, 'turn-running');
      assert.equal(injected.length, 0, 'a busy pane is never typed into');

      await settle();
      // Two system messages: the ordinary control_changed notice every hold
      // gets, and the pause's own escalation to the Architect (in
      // authority.escalation.blocking, not authority.hold).
      assert.ok(escalations.some((m) => /Pause escalation/.test(m.message) && m.to === 'ws-builder'));

      // The durable HOLD still blocks the next governed mutation, worktree
      // untouched: controlGate reads the committed state synchronously, no
      // git command runs anywhere in this path.
      const check = controlGate.checkMutation({ surface: 'wrap-commit', subject: { kind: 'target', projectId: project.id } });
      assert.equal(check && check.code, 'CONTROL_HELD');
      const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
      assert.equal(st.data.assignment.state, 'held');
    });

    it('a pane that cannot be captured defers and escalates, same as busy', async () => {
      const { project } = await pausable();
      controlApi._internal.capturePane = () => { throw new Error('pane vanished'); };
      const escalations = [];
      controlApi._internal.sendSystemMessage = async (m) => { escalations.push(m); return { status: 'received' }; };
      const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bPM.headers);
      assert.equal(r.status, 201, r.raw);
      assert.equal(r.data.nudge.status, 'pane-capture-failed');
      await settle();
      assert.ok(escalations.some((m) => /Pause escalation/.test(m.message)));
    });

    it('never calls killSession, and never on a deferred-busy pause either', async () => {
      const { project } = await pausable();
      const sessions = require('../lib/sessions');
      const originalKill = sessions.killSession;
      let killed = false;
      sessions.killSession = (...args) => { killed = true; return originalKill(...args); };
      try {
        controlApi._internal.assessIdle = () => ({ idle: false, reason: 'turn-running', digest: 'd', idleTicks: 0 });
        await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bPM.headers);
        assert.equal(killed, false);
      } finally {
        sessions.killSession = originalKill;
      }
    });

    it('is safe to send twice: the replay does not re-attempt the pane nudge', async () => {
      const { project } = await pausable();
      const reqId = rid();
      const injected = [];
      controlApi._internal.inject = (...args) => { injected.push(args); return { ok: true, error: null }; };
      const first = await send(server, 'POST', '/api/control/pause', { requestId: reqId, project: project.name }, bPM.headers);
      assert.equal(first.data.nudge.status, 'sent');
      assert.equal(injected.length, 1);
      const second = await send(server, 'POST', '/api/control/pause', { requestId: reqId, project: project.name }, bPM.headers);
      assert.equal(second.status, 200);
      assert.equal(second.data.replayed, true);
      assert.equal(second.data.nudge.status, 'replayed');
      assert.equal(injected.length, 1, 'a replay never re-attempts the pane nudge');
    });
  });
});
