'use strict';

/*
 * #2072 Slice 1 (v5.58.0 Wave 2 Car 58-D, Architect Ruling A2072): the
 * governed-wrap HTTP surface in `lib/routes/wrap.js` --
 * `POST /api/sessions/:project/governed-wrap`, its `GET`, and the
 * `/decision` and `/cancel` sub-routes. Proves the SAME
 * `_requireSessionLifecycleCaller` gate #2824 restored for launch/wrap also
 * covers this new surface -- never a second, divergent authority check.
 * `lib/sessions.js#startWrap` is stubbed throughout: it is a separately,
 * extensively tested dependency.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sessionsLib = require('../lib/sessions');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

function request(server, method, urlPath, body, callerHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...callerHeaders };
    if (bodyStr !== null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

function operatorRequest(server, method, urlPath, body) {
  return request(server, method, urlPath, body, operatorHeaders(server));
}

describe('governed-wrap HTTP surface (#2072 Slice 1)', () => {
  let tmpDir;
  let server;
  let target;
  let pm;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-governed-wrap-api-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    for (const name of ['gwrap-target', 'gwrap-pm']) {
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
      store.projects.create({ name, path: dir, engine: 'claude' });
    }
    target = store.projects.getByName('gwrap-target');
    pm = store.projects.getByName('gwrap-pm');

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let targetBound;
  let pmBound;
  let assignmentId;

  /** Stub sessions.startWrap for the duration of one test. */
  function stubStartWrap(impl) {
    const real = sessionsLib.startWrap;
    sessionsLib.startWrap = impl || (() => ({ ok: true, runId: 'run-1', sessionId: targetBound.sessionId }));
    return () => { sessionsLib.startWrap = real; };
  }

  beforeEach(async () => {
    targetBound = bindProject(target);
    pmBound = bindProject(pm);
    const grant = await operatorRequest(server, 'POST', '/api/control/assignments', {
      projectId: target.id, requestId: crypto.randomUUID(), issueRef: '#2072', authority: { lifecycle: [`project:${pm.id}`] }
    });
    assignmentId = grant.body.assignment.assignmentId;
  });

  afterEach(() => {
    // Force every non-terminal row closed directly, whatever state it is in
    // (including EXECUTING, which `cancelRequest` itself correctly refuses) --
    // this is test-fixture cleanup between cases sharing one `target` project
    // across the whole describe block, not something under test.
    store.getDb().prepare(
      "UPDATE governed_wrap_requests SET state = 'cancelled' WHERE project_id = ? "
      + "AND state IN ('awaiting_decision','ready','needs_operator','executing')"
    ).run(target.id);
    store.sessions.kill(targetBound.sessionId, 'test cleanup');
    store.sessions.kill(pmBound.sessionId, 'test cleanup');
    const row = store.control.getAssignment(assignmentId);
    if (row && row.closed_at === null) {
      store.control.setAssignmentState(assignmentId, { state: 'closed', state_generation: row.state_generation + 1 });
    }
  });

  it('a delegated coordinator opens a preflight request on a lane it does not own', async () => {
    const res = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.state, 'awaiting_decision');
    assert.equal(res.body.request.initiator.kind, 'coordinator');
    assert.equal(res.body.request.initiator.principal, `project:${pm.id}`);
  });

  it('GET reads the open request back, and 404s once none is open', async () => {
    const created = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
    const read = await request(server, 'GET', '/api/sessions/gwrap-target/governed-wrap');
    assert.equal(read.status, 200);
    assert.equal(read.body.request.requestId, created.body.request.requestId);

    await request(server, 'POST', `/api/sessions/gwrap-target/governed-wrap/${created.body.request.requestId}/cancel`, {}, pmBound.headers);
    const after2 = await request(server, 'GET', '/api/sessions/gwrap-target/governed-wrap');
    assert.equal(after2.status, 404);
  });

  it('a "ready" decision executes immediately, carrying the claimed run', async () => {
    const restore = stubStartWrap();
    try {
      const created = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
      const decided = await request(server, 'POST', `/api/sessions/gwrap-target/governed-wrap/${created.body.request.requestId}/decision`,
        { decision: { result: 'ready', options: { skipTests: true } } }, pmBound.headers);
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.request.state, 'executing');
      assert.equal(decided.body.request.runId, 'run-1');
      assert.equal(decided.body.started.runId, 'run-1');
    } finally {
      restore();
    }
  });

  it('a "needs-operator" decision stays NEEDS_OPERATOR and never touches the pipeline', async () => {
    let called = false;
    const restore = stubStartWrap(() => { called = true; return { ok: true, runId: 'run-x', sessionId: targetBound.sessionId }; });
    try {
      const created = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
      const decided = await request(server, 'POST', `/api/sessions/gwrap-target/governed-wrap/${created.body.request.requestId}/decision`,
        { decision: { result: 'needs-operator', question: 'Skip the test suite for this wrap?' } }, pmBound.headers);
      assert.equal(decided.status, 200);
      assert.equal(decided.body.request.state, 'needs_operator');
      assert.equal(called, false);
    } finally {
      restore();
    }
  });

  it('duplicate-run prevention: a second open request for the same lane is refused with 409', async () => {
    await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
    const second = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'GOVERNED_WRAP_IN_PROGRESS');
  });

  it('a PROJECT caller with no delegated authority is refused the SAME way #2824 refuses launch/wrap (403 SESSION_LIFECYCLE_FORBIDDEN)', async () => {
    // Close the grant this suite's beforeEach made, so pm has no standing at all.
    const row = store.control.getAssignment(assignmentId);
    store.control.setAssignmentState(assignmentId, { state: 'closed', state_generation: row.state_generation + 1 });

    const res = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {}, pmBound.headers);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
  });

  it('the operator may open and decide a governed-wrap request directly', async () => {
    const restore = stubStartWrap();
    try {
      const created = await operatorRequest(server, 'POST', '/api/sessions/gwrap-target/governed-wrap', {});
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.request.initiator.kind, 'coordinator');
      const decided = await operatorRequest(server, 'POST', `/api/sessions/gwrap-target/governed-wrap/${created.body.request.requestId}/decision`,
        { decision: { result: 'ready' } });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.request.state, 'executing');
    } finally {
      restore();
    }
  });

  it('cancelling an unknown request answers 404', async () => {
    const res = await request(server, 'POST', '/api/sessions/gwrap-target/governed-wrap/gwr_doesnotexist/cancel', {}, pmBound.headers);
    assert.equal(res.status, 404);
  });
});
