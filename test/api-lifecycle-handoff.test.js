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

    const real = sessionsLib.launchSession;
    let replacement;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      const created = await request(server, 'POST', '/api/sessions/lho-project/lifecycle-handoff',
        { sourceSessionId: bound.sessionId, transitionType: 'wrap', checkpoint: { note: 'full-run' } }, pmBound.headers);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const handoffId = created.body.handoff.handoffId;

      const step1 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/wrap-initiated`, {}, pmBound.headers);
      assert.equal(step1.status, 200, JSON.stringify(step1.body));
      assert.equal(step1.body.handoff.state, 'wrap_initiated');

      store.sessions.wrap(bound.sessionId, 'test: wrap summary');
      const step2 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/terminal-confirmed`, {}, pmBound.headers);
      assert.equal(step2.status, 200, JSON.stringify(step2.body));
      assert.equal(step2.body.handoff.state, 'terminal_confirmed');

      const launchSequence = require('../lib/launch-sequence');
      const replacementLaunchId = launchSequence.mintLaunchId();
      const snapshot = launchSequence.buildSnapshot({
        launchId: replacementLaunchId, project, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test' }, rendered: null, rules: []
      });
      replacement = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });

      const step3 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/launch-replacement`, {}, pmBound.headers);
      assert.equal(step3.status, 200, JSON.stringify(step3.body));
      assert.equal(step3.body.handoff.state, 'replacement_launched');
      assert.equal(step3.body.handoff.replacementSessionId, replacement.id);

      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'digest');
      const digest = step3.body.handoff.checkpointDigest;

      const step4 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/reconcile-startup`,
        { readyDigest: digest }, pmBound.headers);
      assert.equal(step4.status, 200, JSON.stringify(step4.body));
      assert.equal(step4.body.handoff.state, 'startup_ready');

      const step5 = await request(server, 'POST', `/api/sessions/lho-project/lifecycle-handoff/${handoffId}/takeover`, {}, pmBound.headers);
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
});
