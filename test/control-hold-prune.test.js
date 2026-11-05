'use strict';

// #2832: the generic POST /api/control/assignments/:id/hold route must refuse
// reasonCode 'peer-pause-request' — that code exists so a reader of
// control_events can tell a peer's safe-boundary pause apart from every other
// hold, and POST /api/control/pause is the only path that both places it and
// nudges/escalates to the target. Letting the generic route accept the same
// code would place an identical HOLD while silently skipping both.
//
// #2834 (coordinator_roles retention prune tie-break) is NOT covered here:
// its fix lives in lib/store.js, outside this car's authorized file envelope
// (lib/control-api.js, lib/control-state.js, lib/control-hooks.js,
// lib/merge-role-guard.js, lib/sessions.js, lib/workload-nudge.js). Flagged
// to the dispatcher; this file covers only what this car's envelope reaches.

const { describe, it, before, after } = require('node:test');
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

describe('POST /api/control/assignments/:id/hold refuses peer-pause-request (#2832)', () => {
  let tmpDir;
  let server;
  let op;
  let target;
  let pm;
  let bPM;
  let n = 0;
  const rid = () => { n += 1; return `hold-prune-req-${n}`; };
  const origSend = controlApi._internal.sendSystemMessage;
  const origWs = controlApi._internal.workspaceIdFor;
  const origPaneSeams = { ...controlApi._internal };

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hold-prune-'));
    store._setBasePath(tmpDir);
    store.init();
    target = mkProject('builder-target');
    pm = mkProject('project-manager');
    bPM = bindProject(pm);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
    controlApi._internal.workspaceIdFor = () => 'ws-builder';
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });
    // The /pause test below exercises _nudgePausedTarget for real; without
    // these it tries to capture an actual tmux pane that does not exist in
    // this test, the same seams test/api-control.test.js's own #2109 describe
    // block stubs for every pause-route test it runs.
    controlApi._internal.inject = () => ({ ok: true, error: null });
    controlApi._internal.assessIdle = () => ({ idle: true, reason: 'at-rest', digest: 'd', idleTicks: 1 });
    controlApi._internal.capturePane = () => ['$ '];
    controlApi._internal.cursorInfo = () => ({ row: 0, col: 0, visible: true });
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
   * Create a fresh project with an operator assignment whose authority.hold
   * lists `pm`, mirroring the issue's repro (a caller already authorized to
   * hold this assignment by the ordinary path).
   * @returns {Promise<{project: object, assignmentId: string}>}
   */
  async function assigned() {
    const project = mkProject(`t-${rid()}`);
    bindProject(project);
    const res = await send(server, 'POST', '/api/control/assignments', {
      projectId: project.id, requestId: rid(), issueRef: '#2832',
      authority: { hold: [`project:${pm.id}`] }
    }, op);
    assert.equal(res.status, 201, res.raw);
    return { project, assignmentId: res.data.assignment.assignmentId };
  }

  it('refuses the generic route with 400 PEER_PAUSE_REQUIRES_PAUSE_ROUTE, steering the caller to /pause', async () => {
    const { assignmentId } = await assigned();
    const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: rid(), reasonCode: 'peer-pause-request' }, bPM.headers);
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.data.code, 'PEER_PAUSE_REQUIRES_PAUSE_ROUTE');
    assert.match(r.data.error, /\/api\/control\/pause/);
  });

  it('places no hold at all when refused: the assignment stays active with no new event', async () => {
    const { assignmentId } = await assigned();
    const before1 = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    const eventsBefore = before1.data.events.length;
    await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: rid(), reasonCode: 'peer-pause-request' }, bPM.headers);
    const after1 = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.equal(after1.data.assignment.state, 'active');
    assert.equal(after1.data.events.length, eventsBefore);
  });

  it('still accepts every other reason code on the generic route, unaffected by the guard', async () => {
    const { assignmentId } = await assigned();
    const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    assert.equal(r.status, 201, r.raw);
    assert.equal(r.data.event.reasonCode, 'boundary');
  });

  it('a peer\'s pause through the dedicated route is unaffected: it still places peer-pause-request and nudges', async () => {
    const { project } = await assigned();
    const r = await send(server, 'POST', '/api/control/pause', { requestId: rid(), project: project.name }, bPM.headers);
    assert.equal(r.status, 201, r.raw);
    assert.equal(r.data.event.reasonCode, 'peer-pause-request');
    assert.ok(r.data.nudge, 'the dedicated route still attempts its nudge');
  });

  it('refuses the guarded reason code the same way for an operator caller, not just a peer project', async () => {
    const { assignmentId } = await assigned();
    const r = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: rid(), reasonCode: 'peer-pause-request' }, op);
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.data.code, 'PEER_PAUSE_REQUIRES_PAUSE_ROUTE');
  });
});
