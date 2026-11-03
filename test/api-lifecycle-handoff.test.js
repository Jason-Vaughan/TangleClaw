'use strict';

/*
 * #2073 Slice 1 (v5.58.0 Wave 2 Car 58-D, Architect Ruling A2073): the
 * lifecycle-handoff HTTP surface in `lib/routes/sessions.js` --
 * `POST`/`GET /api/sessions/:project/lifecycle-handoff` and its step
 * sub-routes. Proves the SAME `_requireSessionLifecycleCaller` gate #2824
 * restored also covers this surface. `lib/sessions.js#launchSession` is
 * stubbed throughout: it is a separately, extensively tested dependency
 * depending on a real engine binary.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sessionsLib = require('../lib/sessions');
const wrapRunRegistry = require('../lib/wrap-run-registry');
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

describe('lifecycle-handoff HTTP surface (#2073 Slice 1)', () => {
  let tmpDir;
  let server;
  let project;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lifecycle-handoff-api-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    const dir = path.join(projectsDir, 'lho-project');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'lho-project', path: dir, engine: 'claude' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let bound;

  afterEach(() => {
    store.getDb().prepare(
      "UPDATE lifecycle_handoffs SET state = 'cancelled' WHERE project_id = ? "
      + "AND state IN ('checkpointed','wrap_initiated','terminal_confirmed','replacement_launched','startup_ready')"
    ).run(project.id);
    wrapRunRegistry._resetForTests();
    if (bound) store.sessions.kill(bound.sessionId, 'test cleanup');
  });

  it('the operator opens a handoff and reads it back', async () => {
    bound = bindProject(project);
    const created = await operatorRequest(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff', {
      sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'x' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.handoff.state, 'checkpointed');

    const read = await request(server, 'GET', '/api/sessions/lho-project/lifecycle-handoff');
    assert.equal(read.status, 200);
    assert.equal(read.body.handoff.handoffId, created.body.handoff.handoffId);
  });

  it('a verified peer project may open a handoff on its own current session (allowOwnProject)', async () => {
    bound = bindProject(project);
    const created = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
      { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'self' } }, bound.headers);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.handoff.delegatePrincipal, `project:${project.id}`);
  });

  it('duplicate-handoff prevention answers 409', async () => {
    bound = bindProject(project);
    await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
      { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { a: 1 } }, bound.headers);
    const second = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
      { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { a: 2 } }, bound.headers);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'LIFECYCLE_HANDOFF_IN_PROGRESS');
  });

  it('a caller with general wrap authority over the target, but who is not this handoff\'s own recorded delegate, is refused driving its steps '
    + '(PRR-B I-Gate Round 2 Finding 4)', async () => {
    bound = bindProject(project);
    const crypto = require('node:crypto');
    const pm = store.projects.create({ name: 'lho-pm-nd', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-pm-nd-')), engine: 'claude' });
    const pmBound = bindProject(pm);
    let assignmentId;
    try {
      const assignment = await operatorRequest(server, 'POST', '/api/control/assignments', {
        projectId: project.id, requestId: crypto.randomUUID(), issueRef: '#2073-nd', authority: { lifecycle: [`project:${pm.id}`] }
      });
      assignmentId = assignment.body.assignment.assignmentId;
      const created = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
        { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'delegate-bound' } }, pmBound.headers);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.handoff.delegatePrincipal, `project:${pm.id}`);
      const handoffId = created.body.handoff.handoffId;

      // The TARGET's own session has general `wrap` authority over itself
      // (`allowOwnProject`) but is NOT the delegate this handoff recorded.
      const selfAttempt = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/wrap-initiated`, {}, bound.headers);
      assert.equal(selfAttempt.status, 403, JSON.stringify(selfAttempt.body));
      assert.equal(selfAttempt.body.code, 'LIFECYCLE_HANDOFF_NOT_DELEGATE');

      const cancelAttempt = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/cancel`, {}, bound.headers);
      assert.equal(cancelAttempt.status, 403, JSON.stringify(cancelAttempt.body));
      assert.equal(cancelAttempt.body.code, 'LIFECYCLE_HANDOFF_NOT_DELEGATE');

      // The real delegate still can.
      const real = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/cancel`, {}, pmBound.headers);
      assert.equal(real.status, 200, JSON.stringify(real.body));

      // The operator always has the explicit recovery path.
      const created2 = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
        { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'delegate-bound-2' } }, pmBound.headers);
      const operatorCancel = await operatorRequest(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${created2.body.handoff.handoffId}/cancel`, {});
      assert.equal(operatorCancel.status, 200, JSON.stringify(operatorCancel.body));
    } finally {
      store.sessions.kill(pmBound.sessionId, 'test cleanup');
      // This test's own control assignment must not outlive it -- a later
      // test in this file creates its OWN assignment for the SAME project,
      // and only one may be open at a time.
      if (assignmentId) {
        const row = store.control.getAssignment(assignmentId);
        if (row && row.state !== 'closed') {
          store.control.setAssignmentState(assignmentId, { state: 'closed', state_generation: row.state_generation + 1 });
        }
      }
    }
  });

  it('drives the full step sequence through to takeover, with launchSession stubbed', async () => {
    // The DELEGATE driving steps 2-5 is a SEPARATE, standing session -- never
    // `bound` itself, which (correctly) loses its own launch binding the
    // moment it wraps at step 2. This is exactly the problem #2073 solves:
    // the session being replaced cannot act for itself past that point.
    bound = bindProject(project);
    const crypto = require('node:crypto');
    const pm = store.projects.create({ name: 'lho-pm', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-pm-')), engine: 'claude' });
    const pmBound = bindProject(pm);
    await operatorRequest(server, 'POST', '/api/control/assignments', {
      projectId: project.id, requestId: crypto.randomUUID(), issueRef: '#2073', authority: { lifecycle: [`project:${pm.id}`] }
    });

    const launchSequence = require('../lib/launch-sequence');
    // Minted ahead of time so `replacementHeaders` below can be built before
    // the replacement session itself exists -- the session is created
    // for real INSIDE the stub, the moment `launch-replacement` actually
    // calls `launchSession`, so the step's own durable attempt marker
    // (PRR-B I-Gate Round 2 Finding 2) is written exactly as it would be in
    // production, rather than a pre-made session the route never launched.
    const replacementLaunchId = launchSequence.mintLaunchId();
    const real = sessionsLib.launchSession;
    let replacement;
    sessionsLib.launchSession = () => {
      const snapshot = launchSequence.buildSnapshot({
        launchId: replacementLaunchId, project, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test' }, rendered: null, rules: []
      });
      replacement = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
      return { session: replacement, primePrompt: null, ttydUrl: 'http://x', error: null };
    };
    try {
      const created = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
        { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'full-run' } }, pmBound.headers);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const handoffId = created.body.handoff.handoffId;

      wrapRunRegistry.begin(project.name, bound.sessionId);
      const step1 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/wrap-initiated`, {}, pmBound.headers);
      assert.equal(step1.status, 200, JSON.stringify(step1.body));
      assert.equal(step1.body.handoff.state, 'wrap_initiated');

      store.sessions.wrap(bound.sessionId, 'test: wrap summary');
      const step2 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/terminal-confirmed`, {}, pmBound.headers);
      assert.equal(step2.status, 200, JSON.stringify(step2.body));
      assert.equal(step2.body.handoff.state, 'terminal_confirmed');

      // Steps 6-7 below are the REPLACEMENT's own to attest -- never the
      // delegate's -- so they ride on the replacement's own launch binding.
      const replacementHeaders = { 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': replacementLaunchId };

      const step3 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/launch-replacement`, {}, pmBound.headers);
      assert.equal(step3.status, 200, JSON.stringify(step3.body));
      assert.equal(step3.body.handoff.state, 'replacement_launched');
      assert.equal(step3.body.handoff.replacementSessionId, replacement.id);

      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'digest');

      const step4 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/reconcile-startup`,
        { checkpointDigest: step2.body.handoff.checkpointDigest, generation: step2.body.handoff.observedGeneration }, replacementHeaders);
      assert.equal(step4.status, 200, JSON.stringify(step4.body));
      assert.equal(step4.body.handoff.state, 'startup_ready');

      const step5 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/takeover`, {}, replacementHeaders);
      assert.equal(step5.status, 200, JSON.stringify(step5.body));
      assert.equal(step5.body.handoff.state, 'takeover_complete');

      const after2 = await request(server, 'GET', '/api/sessions/lho-project/lifecycle-handoff');
      assert.equal(after2.status, 404, 'a terminal handoff is no longer open');
      store.sessions.kill(replacement.id, 'test cleanup');
    } finally {
      sessionsLib.launchSession = real;
      store.sessions.kill(pmBound.sessionId, 'test cleanup');
    }
  });

  it('a PROJECT caller with no delegated authority is refused the SAME way #2824 refuses launch/wrap, on a DIFFERENT project', async () => {
    const stranger = store.projects.create({ name: 'lho-stranger', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-stranger-')), engine: 'claude' });
    const strangerBound = bindProject(stranger);
    bound = bindProject(project);
    try {
      const res = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
        { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: {} }, strangerBound.headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'SESSION_LIFECYCLE_FORBIDDEN');
    } finally {
      store.sessions.kill(strangerBound.sessionId, 'test cleanup');
    }
  });

  it('cancelling an open handoff answers 200 and frees the project', async () => {
    bound = bindProject(project);
    const created = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
      { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: {} }, bound.headers);
    const handoffId = created.body.handoff.handoffId;
    const cancelled = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/cancel`, { reason: 'test' }, bound.headers);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.handoff.state, 'cancelled');
  });

  it('a project session may never drive or cancel a DIFFERENT project\'s handoff through its own :project URL (A-Gate Round 1 Blocking 1)', async () => {
    const other = store.projects.create({ name: 'lho-other-victim', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-victim-')), engine: 'claude' });
    const otherBound = bindProject(other);
    bound = bindProject(project);
    try {
      const victimHandoff = await request(server, 'POST', '/api/sessions/lho-other-victim/lifecycle-handoff',
        { sourceSessionId: otherBound.sessionId, transitionType: 'wrap', checkpoint: { note: 'victim' } }, otherBound.headers);
      assert.equal(victimHandoff.status, 201, JSON.stringify(victimHandoff.body));
      const victimHandoffId = victimHandoff.body.handoff.handoffId;

      // bound's own project ("lho-project") is a legitimate URL for bound to
      // act through -- but the handoffId named belongs to "lho-other-victim".
      const wrapInitiated = await request(server, 'POST',
        `/api/sessions/lho-project/lifecycle-handoff/${victimHandoffId}/wrap-initiated`, {}, bound.headers);
      assert.equal(wrapInitiated.status, 404, JSON.stringify(wrapInitiated.body));
      assert.equal(wrapInitiated.body.code, 'NOT_FOUND');

      const cancel = await request(server, 'POST',
        `/api/sessions/lho-project/lifecycle-handoff/${victimHandoffId}/cancel`, {}, bound.headers);
      assert.equal(cancel.status, 404, JSON.stringify(cancel.body));
      assert.equal(cancel.body.code, 'NOT_FOUND');

      // The victim's handoff is untouched.
      const stillOpen = await request(server, 'GET', '/api/sessions/lho-other-victim/lifecycle-handoff');
      assert.equal(stillOpen.status, 200);
      assert.equal(stillOpen.body.handoff.state, 'checkpointed');
    } finally {
      store.sessions.kill(otherBound.sessionId, 'test cleanup');
    }
  });
});
