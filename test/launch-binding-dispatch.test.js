'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const store = require('../lib/store');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

// The launch-binding floor as the running server applies it (#2233): the
// request goes through the real dispatcher, and what it changed is read back
// from the store.

describe('launch-binding floor in the dispatcher (#2233)', () => {
  let tmpDir;
  let server;
  let project;
  let other;
  let binding;
  const AUDIT_SECRET = 'audit-secret-for-the-bound-connection';
  const TOKEN = 'tcsk_floor_test_token_0123456789';
  let nextPort = 39400;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-binding-dispatch-'));
    store._setBasePath(tmpDir);
    store.init();
    const mk = (name, engine = 'claude') => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine });
    };
    project = mk('floor-project');
    other = mk('floor-other');
    binding = bindProject(project);
    const conn = store.openclawConnections.create({
      name: 'floor-openclaw', host: '192.0.2.30', sshUser: 'user', sshKeyPath: '/tmp/key', auditSecret: AUDIT_SECRET
    });
    mk('floor-audited', `openclaw:${conn.id}`);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Send one request to the test server.
   * @param {string} method - HTTP method
   * @param {string} urlPath - Path
   * @param {object|null} body - JSON body
   * @param {object} [headers] - Extra headers
   * @returns {Promise<{status: number, data: object}>}
   */
  function send(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const h = { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
      const r = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
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

  /**
   * A port lease request for a port no other test in this file uses.
   * @param {string} name - Project name to lease for
   * @returns {{port: number, body: object}}
   */
  function lease(name) {
    nextPort += 1;
    return { port: nextPort, body: { port: nextPort, project: name, service: 'floor-test', ttl: 60000 } };
  }

  /**
   * Whether the registry holds a lease on a port.
   * @param {number} port - Port number
   * @returns {boolean}
   */
  function leased(port) {
    return store.portLeases.get(port) !== null && store.portLeases.get(port) !== undefined;
  }

  /**
   * Turn the service-token gate on or off for the duration of a callback.
   * @param {boolean} enabled - Gate state
   * @param {function(): Promise<void>} fn - The body
   * @returns {Promise<void>}
   */
  async function withServiceToken(enabled, fn) {
    const saved = store.config.load();
    store.config.save({ ...saved, serviceTokenEnabled: enabled, serviceToken: enabled ? TOKEN : saved.serviceToken });
    try { await fn(); } finally { store.config.save(saved); }
  }

  describe('who reaches a write', () => {
    it('refuses a caller with no binding, and the write does not happen', async () => {
      const { port, body } = lease(project.name);
      const res = await send('POST', '/api/ports/lease', body);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(res.data.reason, 'unbound');
      assert.match(res.data.error, /TANGLECLAW_LAUNCH_ID/);
      assert.equal(leased(port), false);
    });

    it('admits the operator\'s dashboard', async () => {
      const { port, body } = lease(project.name);
      const res = await send('POST', '/api/ports/lease', body, operatorHeaders(server));
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(leased(port), true);
    });

    it('admits a project whose launch is its current session', async () => {
      const { port, body } = lease(project.name);
      const res = await send('POST', '/api/ports/lease', body, binding.headers);
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(leased(port), true);
    });

    it('does not require the caller\'s project to be the route\'s target: that is the route\'s own question', async () => {
      const res = await send('POST', `/api/sessions/${encodeURIComponent(other.name)}/command`, { command: 'echo hi' }, binding.headers);
      assert.notEqual(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.notEqual(res.data.code, 'LAUNCH_BINDING_INVALID');
    });

    for (const [label, headers, reason] of [
      ['a launch id the store does not hold', () => ({ 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': 'not-a-launch' }), 'unknown-launch'],
      ['a launch id claimed for another project', () => ({ 'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': binding.launchId }), 'project-mismatch'],
      ['a launch id with no project claim', () => ({ 'x-tangleclaw-launch-id': binding.launchId }), 'project-claim-missing'],
      ['a Master claim on a launch id nobody holds', () => ({ 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'not-the-master' }), null]
    ]) {
      it(`refuses ${label}, and the write does not happen`, async () => {
        const { port, body } = lease(project.name);
        const res = await send('POST', '/api/ports/lease', body, headers());
        assert.equal(res.status, 403);
        assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
        if (reason) assert.equal(res.data.reason, reason);
        assert.equal(leased(port), false);
      });
    }

    it('refuses a launch whose session has ended, on a write that is not its own finalize', async () => {
      const ended = bindProject(other);
      store.sessions.kill(ended.sessionId, 'test');
      const { port, body } = lease(other.name);
      const res = await send('POST', '/api/ports/lease', body, ended.headers);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
      assert.equal(res.data.reason, 'session-not-active');
      assert.equal(leased(port), false);
      const command = await send('POST', `/api/sessions/${encodeURIComponent(other.name)}/command`, { command: 'echo hi' }, ended.headers);
      assert.equal(command.data.code, 'LAUNCH_BINDING_INVALID');
    });

    it('refuses a launch that was superseded by a newer session of the same project', async () => {
      const dir = path.join(tmpDir, 'floor-superseded');
      fs.mkdirSync(dir);
      const p = store.projects.create({ name: 'floor-superseded', path: dir, engine: 'claude' });
      const first = bindProject(p);
      const second = bindProject(p);
      const { port, body } = lease(p.name);
      const res = await send('POST', '/api/ports/lease', body, first.headers);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
      assert.ok(['session-not-current', 'session-not-active'].includes(res.data.reason), res.data.reason);
      assert.equal(leased(port), false);
      const current = await send('POST', '/api/ports/lease', body, second.headers);
      assert.equal(current.status, 201, JSON.stringify(current.data));
    });

    it('leaves reads alone', async () => {
      const res = await send('GET', '/api/ports', null);
      assert.equal(res.status, 200);
    });

    it('answers a write when the check itself fails, and the write does not happen', async () => {
      // The check reads the store. A read that throws (a locked database) must
      // still end the request: left unanswered, the caller's socket stays open
      // and the dashboard waits on a write that will never report. It is
      // refused, never admitted, because who is asking was not established.
      const guard = require('../lib/launch-binding-guard');
      const realJudge = guard.judge;
      guard.judge = () => { throw new Error('database is locked'); };
      const { port, body } = lease(project.name);
      let timer;
      try {
        const res = await Promise.race([
          send('POST', '/api/ports/lease', body, operatorHeaders(server)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the request was never answered')), 3000);
          })
        ]);
        assert.equal(res.status, 500);
        assert.equal(res.data.code, 'INTERNAL_ERROR');
        assert.doesNotMatch(JSON.stringify(res.data), /database is locked/, 'the cause stays in the log');
        assert.equal(leased(port), false);
      } finally {
        clearTimeout(timer);
        guard.judge = realJudge;
      }
      // The check is back, and an identified write goes through again.
      const after = await send('POST', '/api/ports/lease', lease(project.name).body, operatorHeaders(server));
      assert.equal(after.status, 201, JSON.stringify(after.data));
    });
  });

  describe('an ended launch and its own finalize', () => {
    // The admitted case, an ended launch repeating a finalize that this path
    // itself carried out, needs a real finalization and is proven end to end
    // in `api-session-finalize.test.js`. What is proven here is that ending a
    // session any other way opens nothing.
    it('does not reach the finalize route when its session was ended some other way, for its own project or another', async () => {
      const dir = path.join(tmpDir, 'floor-finalized');
      fs.mkdirSync(dir);
      const p = store.projects.create({ name: 'floor-finalized', path: dir, engine: 'claude' });
      const ended = bindProject(p);
      store.sessions.kill(ended.sessionId, 'test');
      const own = await send('POST', `/api/sessions/${encodeURIComponent(p.name)}/finalize`,
        { sessionId: ended.sessionId, reason: 'repeat after a kill' }, ended.headers);
      assert.equal(own.status, 403);
      assert.equal(own.data.code, 'LAUNCH_BINDING_INVALID');
      const foreign = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}/finalize`,
        { sessionId: binding.sessionId, reason: 'not mine' }, ended.headers);
      assert.equal(foreign.status, 403);
      assert.equal(foreign.data.code, 'LAUNCH_BINDING_INVALID');
      assert.equal(store.sessions.get(binding.sessionId).status, 'active', 'the other project\'s session is untouched');
    });
  });

  describe('a service token', () => {
    it('is a principal on a port write only while its gate is on and the token matches', async () => {
      const bearer = { Authorization: `Bearer ${TOKEN}` };
      const off = lease('external-service');
      const refused = await send('POST', '/api/ports/lease', off.body, bearer);
      assert.equal(refused.status, 403, 'gate off: the token was never checked, so it proves nothing');
      assert.equal(refused.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(leased(off.port), false);

      await withServiceToken(true, async () => {
        const on = lease('external-service');
        const ok = await send('POST', '/api/ports/lease', on.body, bearer);
        assert.equal(ok.status, 201, JSON.stringify(ok.data));
        assert.equal(leased(on.port), true);

        const wrong = lease('external-service');
        const bad = await send('POST', '/api/ports/lease', wrong.body, { Authorization: 'Bearer tcsk_wrong' });
        assert.equal(bad.status, 401);
        assert.equal(leased(wrong.port), false);
      });
    });

    it('is not a principal off the port routes, and never the operator', async () => {
      await withServiceToken(true, async () => {
        const bearer = { Authorization: `Bearer ${TOKEN}` };
        const doc = await send('POST', '/api/shared-docs', { groupId: 'g', name: 'X', filePath: path.join(tmpDir, 'x.md') }, bearer);
        assert.equal(doc.status, 403);
        assert.equal(doc.data.code, 'LAUNCH_BINDING_REQUIRED');
        const config = await send('PATCH', '/api/config', { theme: 'dark' }, bearer);
        assert.equal(config.status, 403);
        assert.equal(config.data.code, 'LAUNCH_BINDING_REQUIRED');
      });
    });
  });

  describe('the bridge', () => {
    it('holds the session candidate route to the floor: an ended launch does not reach it', async () => {
      const dir = path.join(tmpDir, 'floor-candidate');
      fs.mkdirSync(dir);
      const p = store.projects.create({ name: 'floor-candidate', path: dir, engine: 'claude' });
      const ended = bindProject(p);
      store.sessions.kill(ended.sessionId, 'test');
      const res = await send('POST', '/api/bridge/session/candidates', { kind: 'milestone', text: 'x' }, ended.headers);
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID');
      const unbound = await send('POST', '/api/bridge/session/candidates', { kind: 'milestone', text: 'x' });
      assert.equal(unbound.data.code, 'LAUNCH_BINDING_REQUIRED');
    });

    it('lets a current session through to the bridge\'s own answer', async () => {
      const res = await send('POST', '/api/bridge/session/candidates', { kind: 'milestone', text: 'x' }, binding.headers);
      assert.notEqual(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      assert.notEqual(res.data.code, 'LAUNCH_BINDING_INVALID');
    });

    it('leaves the Master\'s and the helper\'s routes to their own credentials, which an unidentified caller does not hold', async () => {
      const master = await send('POST', '/api/bridge/master/nicknames', { name: 'x' });
      assert.equal(master.status, 401);
      assert.equal(master.data.code, 'BRIDGE_CREDENTIAL_REQUIRED');
    });

    it('holds an operator bridge route to the floor', async () => {
      const res = await send('POST', '/api/bridge/operator/pins', { x: 1 });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
    });
  });

  describe('the audit webhook', () => {
    const exchange = (projectClaim) => ({
      session_id: 'floor-sess-1',
      project: projectClaim,
      exchange: { id: `ex-${Math.random().toString(36).slice(2)}`, timestamp: '2026-10-08T10:00:00Z', user_message: { content: 'hello' }, agent_response: { content: 'hi' } }
    });
    const count = () => store.evalExchanges.count({});

    for (const [label, headers] of [
      ['no Authorization header', () => ({})],
      ['a wrong secret of the same length', () => ({ Authorization: `Bearer ${'x'.repeat(AUDIT_SECRET.length)}` })],
      ['a prefix of the secret', () => ({ Authorization: `Bearer ${AUDIT_SECRET.slice(0, -1)}` })],
      ['the secret with a suffix', () => ({ Authorization: `Bearer ${AUDIT_SECRET}x` })],
      ['an empty bearer', () => ({ Authorization: 'Bearer ' })],
      ['a valid launch binding and no secret: a binding is not this route\'s proof', () => binding.headers],
      ['the operator\'s dashboard and no secret', () => operatorHeaders(server)]
    ]) {
      it(`refuses ${label}, and stores nothing`, async () => {
        const before = count();
        const res = await send('POST', '/api/audit/ingest', exchange('floor-audited'), headers());
        assert.equal(res.status, 401);
        assert.equal(res.data.code, 'UNAUTHORIZED');
        assert.equal(count(), before);
      });
    }

    it('accepts the connection\'s secret and files the exchange under the connection\'s project, not the one the payload names', async () => {
      const res = await send('POST', '/api/audit/ingest', exchange(project.name), { Authorization: `Bearer ${AUDIT_SECRET}` });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      const rows = store.evalExchanges.list({});
      const last = rows[rows.length - 1] || rows[0];
      assert.ok(rows.every((row) => row.project !== project.name), 'nothing was filed under the project the payload named');
      assert.ok(rows.some((row) => row.project === 'floor-audited'), JSON.stringify(last));
    });

    it('keeps the heartbeat guarded: it carries no credential', async () => {
      const res = await send('POST', '/api/audit/heartbeat', { session_id: 'floor-sess-1' });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LAUNCH_BINDING_REQUIRED');
      const withSecret = await send('POST', '/api/audit/heartbeat', { session_id: 'floor-sess-1' }, { Authorization: `Bearer ${AUDIT_SECRET}` });
      assert.equal(withSecret.status, 403, 'the audit secret is the ingest route\'s proof only');
    });
  });
});
