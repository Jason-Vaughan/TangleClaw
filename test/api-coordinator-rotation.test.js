'use strict';

/*
 * #2032: the coordinator rotation routes are bound to the caller's own
 * verified launch (abandon to the operator), so no other pane, peer or
 * unbound caller can prepare, read, advance or resume a coordinator's
 * rotation. The transition rules themselves are pinned in
 * test/coordinator-rotation.test.js.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const { bindProject } = require('./_shared-docs-callers');

describe('API — coordinator rotation routes (#2032)', () => {
  let tempDir;
  let server;
  let port;
  // A project whose launch binding verifies: the caller the route-level
  // refusals below are about. A caller whose binding does not verify never
  // reaches a mutating route, so it cannot show what the route itself refuses.
  let bound;
  const FORGED = { 'x-tangleclaw-project-id': '1', 'x-tangleclaw-launch-id': 'forged' };

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-api-'));
    store._setBasePath(tempDir);
    store.init();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-api-project-'));
    bound = bindProject(store.projects.create({ name: 'rotation-api-caller', path: dir, engine: 'claude' })).headers;
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} method - Method.
   * @param {object} [body] - JSON body.
   * @param {object} [headers] - Extra headers.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
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
      if (payload) r.write(payload);
      r.end();
    });
  }

  const LAUNCH_BOUND = [
    ['POST', '/api/tc/rotation/prepare', { attemptKey: 'attempt-0001', checkpoint: {} }],
    ['GET', '/api/tc/rotation', null],
    ['POST', '/api/tc/rotation/advance', {}],
    ['POST', '/api/tc/rotation/resume', { rotationId: 'rot_x' }]
  ];

  for (const [method, url, body] of LAUNCH_BOUND) {
    it(`${method} ${url} refuses a caller with no verified launch`, async () => {
      const { status, data } = await req(url, method, body);
      assert.equal(status, 403);
      // A write is refused by the server's launch-binding floor before the
      // route is reached; a read still gets the route's own answer.
      assert.equal(data.code, method === 'GET' ? 'ROTATION_BINDING_REQUIRED' : 'LAUNCH_BINDING_REQUIRED');
    });

    it(`${method} ${url} refuses a launch id nobody holds`, async () => {
      const { status, data } = await req(url, method, body, FORGED);
      assert.equal(status, 403);
      assert.equal(data.code, method === 'GET' ? 'ROTATION_BINDING_REQUIRED' : 'LAUNCH_BINDING_INVALID');
      if (method !== 'GET') assert.equal(data.reason, 'unknown-launch');
    });
  }

  for (const [method, url, body] of [
    ['GET', '/api/coordinator-roles', null],
    ['POST', '/api/coordinator-roles', { projectId: 1, role: 'architect' }],
    ['POST', '/api/coordinator-roles/revoke', { projectId: 1 }]
  ]) {
    it(`${method} ${url} is the operator's alone (A6a)`, async () => {
      const { status, data } = await req(url, method, body, bound);
      assert.equal(status, 403);
      assert.equal(data.code, 'OPERATOR_ONLY');
    });
  }

  for (const [method, url, body] of [
    ['POST', '/api/tc/rotation/relaunch', { rotationId: 'rot_x' }],
    ['GET', '/api/rotations', null]
  ]) {
    it(`${method} ${url} is the operator's alone (A13)`, async () => {
      const { status, data } = await req(url, method, body, bound);
      assert.equal(status, 403);
      assert.equal(data.code, 'OPERATOR_ONLY');
    });
  }

  it('abandon refuses a project caller: it is the operator\'s exit', async () => {
    const { status, data } = await req('/api/tc/rotation/abandon', 'POST', { rotationId: 'rot_x', reason: 'x' }, bound);
    assert.equal(status, 403);
    assert.equal(data.code, 'OPERATOR_ONLY');
  });

  for (const [method, url, body] of [
    ['POST', '/api/coordinator-roles', { projectId: 1, role: 'architect' }],
    ['POST', '/api/coordinator-roles/revoke', { projectId: 1 }],
    ['POST', '/api/tc/rotation/relaunch', { rotationId: 'rot_x' }],
    ['POST', '/api/tc/rotation/abandon', { rotationId: 'rot_x', reason: 'x' }]
  ]) {
    it(`${method} ${url} never reaches the route for a binding that does not verify (#2233)`, async () => {
      const { status, data } = await req(url, method, body, FORGED);
      assert.equal(status, 403);
      assert.equal(data.code, 'LAUNCH_BINDING_INVALID');
      assert.equal(data.reason, 'unknown-launch');
    });
  }

  for (const [url, code] of [['/api/coordinator-roles', 'OPERATOR_ONLY'], ['/api/rotations', 'OPERATOR_ONLY']]) {
    it(`GET ${url} still answers a forged binding itself: a read is not held to the floor`, async () => {
      const { status, data } = await req(url, 'GET', null, FORGED);
      assert.equal(status, 403);
      assert.equal(data.code, code);
    });
  }
});

describe('API — every gated route answers the epoch gate (#2032)', () => {
  let tempDir;
  let server;
  let port;
  let project;
  let other;
  const LAUNCH = 'launch-gate-routes-1';
  const OTHER_LAUNCH = 'launch-gate-routes-2';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-gate-api-'));
    store._setBasePath(tempDir);
    store.init();
    const mk = (name, launchId) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-gate-${name}-`));
      const p = store.projects.create({ name, path: dir, engine: 'codex' });
      const sess = store.sessions.start({
        projectId: p.id, engineId: 'codex', tmuxSession: `tc-gate-${name}`, primePrompt: '',
        launchSequence: { launchId, pageBudget: 10000, applicability: 'not-applicable', notApplicableReason: 'test',
          preflight: {}, sourceManifest: {}, steps: [] }
      });
      return { ...p, sessionId: sess.id };
    };
    project = mk('gate-coordinator', LAUNCH);
    other = mk('gate-other', OTHER_LAUNCH);
    const now = new Date().toISOString();
    store.coordinatorRotations.insert({
      rotationId: 'rot_gate_routes', attemptKey: 'gate-routes-0001', projectId: project.id, sessionId: project.sessionId,
      launchId: LAUNCH, engineId: 'codex', channelId: 1, sequenceId: 1, generation: 1, priorThreadId: 'old-thread',
      checkpointSchema: 1, checkpointDigest: 'd'.repeat(64), checkpoint: { exchanges: [] }, inboxIds: [],
      roleId: 'role_x', authorityVersion: 1, checkout: {}, github: [], now
    });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * @param {string} urlPath - Path.
   * @param {string} method - Method.
   * @param {object|null} body - JSON body.
   * @param {object} headers - Headers.
   * @returns {Promise<{status: number, data: object}>}
   */
  function req(urlPath, method, body, headers) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
          resolve({ status: res.statusCode, data });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  // The routes the gate is wired into, and which project each one judges:
  // the URL's project for the Medusa and wrap routes, the caller's for the rest.
  const ROUTES = [
    ['POST', '/api/sessions/gate-coordinator/medusa/send', { to: 'x', message: 'go' }],
    ['POST', '/api/sessions/gate-coordinator/medusa/read', { ids: ['m-1'] }],
    ['POST', '/api/sessions/gate-coordinator/medusa/exchanges/mx_1/close', {}],
    ['POST', '/api/sessions/gate-coordinator/medusa/loop', { target: 'x', task: 't' }],
    ['POST', '/api/sessions/gate-coordinator/medusa/loops/l1/continue', { message: 'more' }],
    ['POST', '/api/sessions/gate-coordinator/medusa/loops/l1/force-done', {}],
    ['POST', '/api/sessions/gate-coordinator/medusa/loops/l1/closeout', {}],
    ['POST', '/api/sessions/gate-coordinator/medusa/toggle', { enabled: false }],
    ['POST', '/api/tc/workload', { schema: 'tc.workload/1', state: 'working', clearance: 'do-not-clear', summary: 'x' }],
    ['POST', '/api/session-rules', { projectId: 1, content: 'x' }],
    ['PUT', '/api/session-rules/1', { content: 'x' }],
    ['DELETE', '/api/session-rules/1', null],
    ['POST', '/api/session-rules/promote', { id: 1 }],
    ['PUT', '/api/session-rules/1/status', { status: 'retired' }],
    ['POST', '/api/session-rules/1/restore', {}],
    ['POST', '/api/control/assignments', { projectId: 2 }],
    ['POST', '/api/control/assignments/a1/hold', {}],
    ['POST', '/api/control/assignments/a1/release', {}],
    ['POST', '/api/control/assignments/a1/stop', {}],
    ['POST', '/api/control/assignments/a1/close', {}],
    ['POST', '/api/control/assignments/a1/ack', {}],
    ['POST', '/api/control/assignments/a1/exchange-closed', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap/complete', {}],
    ['POST', '/api/sessions/gate-coordinator/wrap/handback', {}]
  ];

  const coordinatorHeaders = () => ({
    'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
    'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': LAUNCH, 'x-tangleclaw-engine-thread': 'old-thread'
  });

  for (const [method, url, body] of ROUTES) {
    it(`${method} ${url} is fenced for the rotating coordinator's own launch`, async () => {
      const { status, data } = await req(url, method, body, coordinatorHeaders());
      assert.equal(status, 409, JSON.stringify(data));
      assert.equal(data.code, 'COORDINATOR_FENCED');
    });
  }

  // Every mutating route in the families the gate covers, as REGISTERED — so
  // a route added later is covered by existing, not by someone remembering to
  // extend a list. A route here that the gate should not judge must be named
  // below with its reason.
  const GATE_EXEMPT = {
    'POST /api/session-rules/conflicts': 'a read: it checks text for conflicts and writes nothing',
    'POST /api/sessions/:project': 'launching a session: during a relaunch rotation an unclaimed launch stays fenced by the gate itself; only the claim binds',
    'DELETE /api/sessions/:project': 'ending a session is how a relaunch rotation begins; it dispatches nothing',
    'POST /api/sessions/:project/launch/recovery-clear': 'the operator clears a launch-recovery requirement; no coordinator authority is exercised',
    'POST /api/sessions/:project/launch/reconciliation': 'a read, sent as a POST only so the operator proof applies whole: it writes nothing, and it serves a signed-in operator only',
    'POST /api/sessions/:project/wrap/cancel': 'stops a wrap before its commit step; it publishes and finalizes nothing'
  };
  const FAMILIES = [/^\/api\/sessions\/:project\/medusa\//, /^\/api\/control\/assignments/, /^\/api\/session-rules/,
    /^\/api\/sessions\/:project(\/|$)/, /^\/api\/tc\/workload$/];
  const registered = require('../server')._routePatterns()
    .filter((r) => r.method !== 'GET' && FAMILIES.some((f) => f.test(r.pattern)))
    .filter((r) => !GATE_EXEMPT[`${r.method} ${r.pattern}`]);

  it('every exemption names a route that is registered, so a stale exemption cannot hide a new one', () => {
    const all = require('../server')._routePatterns().map((r) => `${r.method} ${r.pattern}`);
    for (const key of Object.keys(GATE_EXEMPT)) assert.ok(all.includes(key), key);
  });

  it('the enumeration finds the gated families (guards against an empty sweep)', () => {
    assert.ok(registered.length >= ROUTES.length, `${registered.length} registered`);
    for (const r of ['/api/sessions/:project/medusa/loop', '/api/sessions/:project/medusa/loops/:loopId/continue', '/api/sessions/:project/medusa/toggle',
      '/api/sessions/:project/command', '/api/sessions/:project/startup-prompt/fire']) {
      assert.ok(registered.some((x) => x.pattern === r), r);
    }
  });

  for (const r of registered) {
    it(`registered ${r.method} ${r.pattern} is fenced for the rotating coordinator`, async () => {
      const url = r.pattern.replace(':project', 'gate-coordinator').replace(/:[A-Za-z]+/g, 'x1');
      const { status, data } = await req(url, r.method, r.method === 'DELETE' ? null : { to: 'x', message: 'go', target: 'x', task: 't', command: 'go' }, coordinatorHeaders());
      assert.equal(status, 409, `${r.method} ${url}: ${JSON.stringify(data)}`);
      assert.equal(data.code, 'COORDINATOR_FENCED');
    });
  }

  it('a rotating coordinator cannot finalize another lane under lifecycle authority (#2027)', async () => {
    const url = `/api/sessions/${encodeURIComponent(other.name)}/finalize`;
    const { status, data } = await req(url, 'POST', { sessionId: 1, reason: 'retire' }, coordinatorHeaders());
    assert.equal(status, 409, JSON.stringify(data));
    assert.equal(data.code, 'COORDINATOR_FENCED');
  });

  it('the caller-keyed routes judge the caller: another project\'s launch is not fenced by this rotation', async () => {
    const headers = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
      'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': OTHER_LAUNCH };
    for (const [method, url, body] of ROUTES.filter(([, u]) => !u.includes('gate-coordinator'))) {
      const { data } = await req(url, method, body, headers);
      assert.notEqual(data && data.code, 'COORDINATOR_FENCED', `${method} ${url}`);
    }
  });
});

describe('API — GET /api/tc/rotation answers a resumed coordinator with `latest` (#2032)', () => {
  let tempDir;
  let server;
  let port;
  let project;
  const LAUNCH = 'launch-latest-route-1';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-latest-'));
    store._setBasePath(tempDir);
    store.init();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-latest-proj-'));
    project = store.projects.create({ name: 'latest-coordinator', path: dir, engine: 'codex' });
    const sess = store.sessions.start({
      projectId: project.id, engineId: 'codex', tmuxSession: 'tc-latest', primePrompt: '',
      launchSequence: { launchId: LAUNCH, pageBudget: 10000, applicability: 'not-applicable', notApplicableReason: 'test',
        preflight: {}, sourceManifest: {}, steps: [] }
    });
    const now = new Date().toISOString();
    store.coordinatorRotations.insert({
      rotationId: 'rot_latest_route', attemptKey: 'latest-route-0001', projectId: project.id, sessionId: sess.id,
      launchId: LAUNCH, engineId: 'codex', channelId: 1, sequenceId: 1, generation: 1, priorThreadId: 'old-thread',
      checkpointSchema: 1, checkpointDigest: 'd'.repeat(64), checkpoint: { exchanges: [] }, inboxIds: [],
      roleId: 'role_x', authorityVersion: 1, checkout: {}, github: [], now
    });
    store.coordinatorRotations.updateIf('rot_latest_route', 'fenced', { state: 'active', replacementThreadId: 'new-thread', completedAt: now }, { now });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns no open rotation, and the resumed one as latest with its bound thread, from the real route', async () => {
    const data = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/api/tc/rotation', method: 'GET', headers: {
        'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'rotation.show',
        'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': LAUNCH, 'x-tangleclaw-engine-thread': 'new-thread'
      } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(data.status, 200, JSON.stringify(data.body));
    assert.equal(data.body.rotation, null, 'nothing is open');
    assert.equal(data.body.latest.state, 'active');
    assert.equal(data.body.latest.replacementThreadId, 'new-thread');
    assert.equal(data.body.latest.priorThreadId, 'old-thread');
    assert.equal(data.body.generation, 1);
    assert.equal(data.body.binding.forwardedThread, 'new-thread');
  });
});
