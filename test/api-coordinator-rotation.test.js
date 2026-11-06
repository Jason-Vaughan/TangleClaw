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

  const coordinatorHeaders = () => ({
    'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
    'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': LAUNCH, 'x-tangleclaw-engine-thread': 'old-thread'
  });

  // The ONE declared list the gate's routes come from: `options.gatedAction`
  // at registration (server.js / lib/routes/*.js), never a second, hand- or
  // regex-maintained copy here (#2034 item 5 — "the server should expose one
  // list that the test reads"). A newly gated route is caught automatically:
  // give it a `gatedAction` at registration and it appears here with no edit
  // to this file. `_routePatterns()` lists EVERY mount a route is registered
  // under, so the Medusa family appears once per mount (project, master).
  const GATED = require('../server')._routePatterns().filter((r) => r.options && r.options.gatedAction);

  // The master Medusa mount (`registerMedusaRoutes('/api/master/medusa', ...)`)
  // resolves its target through `resolveMasterMedusaTarget`, which requires a
  // LIVE Project Master (real tmux liveness) before it ever reaches the gate —
  // this file's fixture has no such session, so every one of these answers
  // "Project Master not running" before the gate is asked anything, never
  // COORDINATOR_FENCED. Named here, not silently dropped: they are still
  // required to declare `gatedAction` (asserted below), just not HTTP-exercised
  // by this fixture. Faking Master liveness to close this gap is tracked
  // separately rather than folded into a gated-route-list cleanup.
  const HTTP_UNTESTABLE_HERE = (r) => r.pattern.startsWith('/api/master/');
  const testable = GATED.filter((r) => !HTTP_UNTESTABLE_HERE(r));

  /**
   * A generic body that satisfies every gated route's shape well enough to
   * reach its gate check (proven across the whole set below) — the gate runs
   * before body validation on every one of these handlers.
   * @param {string} method - HTTP method.
   * @returns {object|null}
   */
  const genericBody = (method) => (method === 'DELETE' ? null
    : { to: 'x', message: 'go', target: 'x', task: 't', command: 'go', ids: ['m-1'], projectId: 1, content: 'x', id: 1,
      status: 'retired', schema: 'tc.workload/1', state: 'working', clearance: 'do-not-clear', summary: 'x', enabled: false });

  /**
   * The URL a gated route's pattern maps to for the `gate-coordinator` or
   * `gate-other` fixture project, with every other `:param` placeholder-filled.
   * @param {string} pattern - Registered route pattern.
   * @param {string} projectName - Fixture project name.
   * @returns {string}
   */
  const urlFor = (pattern, projectName) => pattern.replace(':project', projectName).replace(/:[A-Za-z]+/g, 'x1');

  it('declares at least the known gated route families (guards against an empty sweep)', () => {
    for (const r of ['/api/sessions/:project/medusa/loop', '/api/sessions/:project/medusa/loops/:loopId/continue',
      '/api/sessions/:project/medusa/toggle', '/api/sessions/:project/command', '/api/sessions/:project/startup-prompt/fire',
      '/api/session-rules', '/api/control/assignments', '/api/tc/workload', '/api/sessions/:project/wrap']) {
      assert.ok(GATED.some((x) => x.pattern === r), r);
    }
  });

  it('the master Medusa mount is still declared gated, even though this fixture cannot HTTP-exercise it', () => {
    const masterGated = GATED.filter(HTTP_UNTESTABLE_HERE);
    assert.ok(masterGated.length >= 9, `expected every master-mount Medusa route gated too, found ${masterGated.length}`);
    assert.ok(masterGated.some((r) => r.pattern === '/api/master/medusa/send'));
  });

  for (const r of testable) {
    it(`${r.method} ${r.pattern} is fenced for the rotating coordinator's own launch (gatedAction: ${r.options.gatedAction})`, async () => {
      const url = urlFor(r.pattern, 'gate-coordinator');
      const { status, data } = await req(url, r.method, genericBody(r.method), coordinatorHeaders());
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

  // This test is specifically about routes the gate judges by the CALLER's
  // project (`_callerProjectId(req)` — session-rule-write, workload-set,
  // control-mutate/-ack), not the URL's: a URL-keyed route (medusa-*, wrap,
  // session-command) still names `gate-coordinator` in its path regardless of
  // who calls it, so "a different caller" proves nothing new for those, and
  // (discovered the hard way) letting one fall through past a gate that
  // never fires for a fixture project with no real tmux pane behind it hits
  // real exec/tmux calls this test tier forbids. Those families are exercised
  // fully by the "fenced for ITS OWN launch" loop above (where the gate
  // always fires first) and, for `wrap`'s cross-project branch specifically,
  // by the dedicated finalize test just above this one.
  const CALLER_KEYED_ACTIONS = new Set(['session-rule-write', 'workload-set', 'control-mutate', 'control-ack']);
  const callerKeyed = testable.filter((r) => CALLER_KEYED_ACTIONS.has(r.options.gatedAction));

  it('the caller-keyed routes judge the caller: another project\'s launch is not fenced by this rotation', async () => {
    const headers = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'test',
      'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': OTHER_LAUNCH };
    assert.ok(callerKeyed.length >= 13, `expected the full caller-keyed family, found ${callerKeyed.length}`);
    for (const r of callerKeyed) {
      const url = urlFor(r.pattern, 'gate-coordinator');
      const { data } = await req(url, r.method, genericBody(r.method), headers);
      assert.notEqual(data && data.code, 'COORDINATOR_FENCED', `${r.method} ${url}`);
    }
  });

  // The completeness half of the single-source-of-truth derivation (PRR-A,
  // PR #2827 I-Gate R1): GATED above answers "is every ROUTE that declares a
  // gatedAction actually fenced" -- it cannot answer "did a route that calls
  // coordinatorGateRefused forget to declare one," because an undeclared
  // route is invisible to a filter keyed on the declaration. A route in one
  // of these families that still calls the gate directly but carries no
  // gatedAction would silently vanish from GATED with nothing to catch it,
  // exactly the failure mode #2034 item 5 set out to close in the first
  // place, just moved one level up. Closing it behaviorally (actually
  // calling every undeclared route as a fenced coordinator) would invoke
  // real side effects for the ones below (a real session launch, a real
  // session end) -- this instead requires every undeclared route in these
  // families to carry a REASON, so a newly-gated route with no declaration
  // fails this check immediately instead of silently passing by omission,
  // and a genuinely new exemption is a one-line, reviewed addition naming
  // why, not a silent gap.
  const GATE_RELEVANT_FAMILIES = [
    /^\/api\/sessions\/:project\/medusa\//, /^\/api\/master\/medusa\//, /^\/api\/control\/assignments/,
    /^\/api\/session-rules/, /^\/api\/sessions\/:project(\/|$)/, /^\/api\/tc\/workload$/
  ];
  const KNOWN_UNGATED = {
    'POST /api/session-rules/conflicts': 'a read: it checks text for conflicts and writes nothing',
    'POST /api/sessions/:project': 'launching a session: during a relaunch rotation an unclaimed launch stays fenced by the gate itself; only the claim binds',
    'DELETE /api/sessions/:project': 'ending a session is how a relaunch rotation begins; it dispatches nothing',
    'POST /api/sessions/:project/launch/recovery-clear': 'the operator clears a launch-recovery requirement; no coordinator authority is exercised',
    'POST /api/sessions/:project/launch/reconciliation': 'a read, sent as a POST only so the operator proof applies whole: it writes nothing, and it serves a signed-in operator only',
    'POST /api/sessions/:project/decisions': 'fenced inline (#2037): the handler calls coordinatorGateRefused(req, res, project.id, \'session-command\') before doing anything else, same shape as the other inline-fenced entries above — recording a lane-local decision request exercises no further coordinator authority beyond that, and answering is Operator-only',
    'POST /api/sessions/:project/wrap/cancel': 'stops a wrap before its commit step; it publishes and finalizes nothing',
    'POST /api/sessions/:project/chunk-boundary/validate-next-dispatch': 'a pure read (the admission gate check, #2888); it writes nothing, same shape as the launch/reconciliation entry above'
  };

  it('every mutating route in the gate-relevant families either declares gatedAction or names a reason it does not', () => {
    const undeclared = require('../server')._routePatterns()
      .filter((r) => r.method !== 'GET' && GATE_RELEVANT_FAMILIES.some((f) => f.test(r.pattern)) && !(r.options && r.options.gatedAction));
    for (const r of undeclared) {
      const key = `${r.method} ${r.pattern}`;
      assert.ok(KNOWN_UNGATED[key],
        `${key} has no gatedAction and no exemption reason -- either declare gatedAction at its registration, `
          + 'or add it to KNOWN_UNGATED above naming why it is genuinely not gated (reviewed, not silent)');
    }
    // And the reverse of the existing exemption-hygiene check: every reason
    // above must still name a route that actually exists and is still
    // undeclared -- a stale entry would otherwise hide a route that got
    // gatedAction added later without the exemption being removed.
    for (const key of Object.keys(KNOWN_UNGATED)) {
      assert.ok(undeclared.some((r) => `${r.method} ${r.pattern}` === key), `${key} is stale: remove it or re-verify it is still ungated`);
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

describe('API — currentGeneration agrees with the gate once the true latest rotation is abandoned (#2034 item 8)', () => {
  let tempDir;
  let server;
  let port;
  let project;
  const LAUNCH = 'launch-abandoned-latest-1';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-abandoned-latest-'));
    store._setBasePath(tempDir);
    store.init();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-abandoned-latest-proj-'));
    project = store.projects.create({ name: 'abandoned-latest-coordinator', path: dir, engine: 'codex' });
    const sess = store.sessions.start({
      projectId: project.id, engineId: 'codex', tmuxSession: 'tc-abandoned-latest', primePrompt: '',
      launchSequence: { launchId: LAUNCH, pageBudget: 10000, applicability: 'not-applicable', notApplicableReason: 'test',
        preflight: {}, sourceManifest: {}, steps: [] }
    });
    const now = new Date().toISOString();
    // Generation 1 completes normally and stays active — an earlier, superseded epoch.
    store.coordinatorRotations.insert({
      rotationId: 'rot_abandoned_latest_g1', attemptKey: 'abandoned-latest-0001', projectId: project.id, sessionId: sess.id,
      launchId: LAUNCH, engineId: 'codex', channelId: 1, sequenceId: 1, generation: 1, priorThreadId: 'thread-0',
      checkpointSchema: 1, checkpointDigest: 'd'.repeat(64), checkpoint: { exchanges: [] }, inboxIds: [],
      roleId: 'role_x', authorityVersion: 1, checkout: {}, github: [], now
    });
    store.coordinatorRotations.updateIf('rot_abandoned_latest_g1', 'fenced', { state: 'active', replacementThreadId: 'thread-1', completedAt: now }, { now });
    // Generation 2 is the true latest (highest generation) — relaunched out of band, then
    // abandoned by the operator to release its epoch binding (lib/coordinator-rotation.js abandon()).
    store.coordinatorRotations.insert({
      rotationId: 'rot_abandoned_latest_g2', attemptKey: 'abandoned-latest-0002', projectId: project.id, sessionId: sess.id,
      launchId: LAUNCH, engineId: 'codex', channelId: 1, sequenceId: 1, generation: 2, priorThreadId: 'thread-1',
      checkpointSchema: 1, checkpointDigest: 'e'.repeat(64), checkpoint: { exchanges: [] }, inboxIds: [],
      roleId: 'role_x', authorityVersion: 1, checkout: {}, github: [], now
    });
    store.coordinatorRotations.updateIf('rot_abandoned_latest_g2', 'fenced', { state: 'active', replacementThreadId: 'thread-2', completedAt: now }, { now });
    store.coordinatorRotations.updateIf('rot_abandoned_latest_g2', 'active', { state: 'abandoned', completedAt: now, failureCode: 'abandoned', failureDetail: 'released for test' }, { now });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports generation 0 — matching the gate, which treats an abandoned latest as never-rotated — instead of falling back to the superseded generation 1', async () => {
    assert.equal(store.coordinatorRotations.currentGeneration(project.id), 0, 'store-level: must not fall back to generation 1 just because it still carries state=active');
    const data = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/api/tc/rotation', method: 'GET', headers: {
        'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'rotation.show',
        'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': LAUNCH, 'x-tangleclaw-engine-thread': 'thread-2'
      } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(data.status, 200, JSON.stringify(data.body));
    assert.equal(data.body.latest.state, 'abandoned');
    assert.equal(data.body.generation, 0, 'the route must agree with the gate, not report the stale generation-1 epoch as current');
  });
});
