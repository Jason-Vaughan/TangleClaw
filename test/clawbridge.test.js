'use strict';

/*
 * Unit tests for lib/clawbridge.js (#210 Phase 2).
 *
 * Spins up a local HTTP server impersonating ClawBridge v1.7.0's
 * `POST /v2/session/start` endpoint to verify the request shape,
 * response handling, error paths, and timeout behaviour.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const clawbridge = require('../lib/clawbridge');

/**
 * Start a stub HTTP server with the given request handler and resolve
 * with `{port, close}` once it's listening. Caller is responsible for
 * calling `close()`.
 * @param {(req: http.IncomingMessage, body: string) => {status: number, body?: object}} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function startStubBridge(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const result = handler(req, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body !== undefined ? JSON.stringify(result.body) : '');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const close = () => new Promise((r) => server.close(r));
      resolve({ port, close });
    });
  });
}

describe('clawbridge.startSession — happy paths', () => {
  it('POSTs to /v2/session/start with the expected body shape', async () => {
    let capturedReq = null;
    let capturedBody = null;
    const stub = await startStubBridge((req, body) => {
      capturedReq = { method: req.method, path: req.url, headers: req.headers };
      capturedBody = JSON.parse(body);
      return { status: 200, body: { sessionId: 'sess-abc-123', attached: false } };
    });
    try {
      const result = await clawbridge.startSession({
        localPort: stub.port,
        token: 'tok-xyz',
        project: 'demo-project',
        permissionMode: 'default'
      });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, 'sess-abc-123');
      assert.equal(result.attached, false);
      assert.equal(result.status, 200);
      assert.equal(result.error, null);

      assert.equal(capturedReq.method, 'POST');
      assert.equal(capturedReq.path, '/v2/session/start');
      assert.equal(capturedReq.headers['content-type'], 'application/json');
      assert.equal(capturedReq.headers.authorization, 'Bearer tok-xyz');

      assert.deepEqual(capturedBody, {
        project: 'demo-project',
        permissionMode: 'default',
        attachIfExists: true
      });
      assert.ok(!('instruction' in capturedBody),
        'instruction must be omitted per ClawBridge v1.6.0 orchestrator pre-create pattern');
    } finally {
      await stub.close();
    }
  });

  it('returns attached:true when ClawBridge v1.7.0 indicates idempotent attach', async () => {
    const stub = await startStubBridge((_req, _body) => ({
      status: 200,
      body: { sessionId: 'sess-already-existed', attached: true }
    }));
    try {
      const result = await clawbridge.startSession({
        localPort: stub.port, token: null,
        project: 'p', permissionMode: 'plan'
      });
      assert.equal(result.ok, true);
      assert.equal(result.sessionId, 'sess-already-existed');
      assert.equal(result.attached, true);
    } finally {
      await stub.close();
    }
  });

  it('omits Authorization header when token is null', async () => {
    let capturedHeaders = null;
    const stub = await startStubBridge((req, _body) => {
      capturedHeaders = req.headers;
      return { status: 200, body: { sessionId: 's', attached: false } };
    });
    try {
      await clawbridge.startSession({
        localPort: stub.port, token: null,
        project: 'p', permissionMode: 'auto'
      });
      assert.equal(capturedHeaders.authorization, undefined,
        'no Authorization header when no token');
    } finally {
      await stub.close();
    }
  });

  it('accepts a response that uses `id` instead of `sessionId`', async () => {
    // Defensive: ClawBridge's exact response shape isn't pinned by a
    // schema test in this repo. If a future version emits `id` instead
    // of `sessionId`, fall through to it rather than returning null.
    const stub = await startStubBridge((_req, _body) => ({
      status: 200, body: { id: 'sess-via-id-field', attached: false }
    }));
    try {
      const result = await clawbridge.startSession({
        localPort: stub.port, token: null, project: 'p', permissionMode: 'default'
      });
      assert.equal(result.sessionId, 'sess-via-id-field');
    } finally {
      await stub.close();
    }
  });
});

describe('clawbridge.startSession — error paths', () => {
  it('returns ok:false with parsed error message on 4xx', async () => {
    const stub = await startStubBridge((_req, _body) => ({
      status: 400, body: { error: 'invalid permissionMode' }
    }));
    try {
      const result = await clawbridge.startSession({
        localPort: stub.port, token: null, project: 'p', permissionMode: 'nope'
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'invalid permissionMode');
      assert.equal(result.sessionId, null);
    } finally {
      await stub.close();
    }
  });

  it('returns ok:false with synthesized message when 5xx body has no error field', async () => {
    const stub = await startStubBridge((_req, _body) => ({
      status: 500, body: { something: 'unexpected' }
    }));
    try {
      const result = await clawbridge.startSession({
        localPort: stub.port, token: null, project: 'p', permissionMode: 'default'
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 500);
      assert.match(result.error, /500/);
    } finally {
      await stub.close();
    }
  });

  it('returns ok:false with network error message on connection refused', async () => {
    // Use a port that's almost certainly not listening (high range, no stub).
    const result = await clawbridge.startSession({
      localPort: 1, // root-only privileged port; will be refused for non-root
      token: null, project: 'p', permissionMode: 'default',
      timeoutMs: 2000
    });
    assert.equal(result.ok, false);
    assert.equal(result.sessionId, null);
    assert.ok(result.error, 'should carry the network-error message');
  });

  it('returns ok:false with timeout message when request exceeds timeoutMs', async () => {
    // Stub never responds (handler hangs).
    const server = http.createServer(() => { /* hang */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await clawbridge.startSession({
        localPort: port, token: null, project: 'p', permissionMode: 'default',
        timeoutMs: 50
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /timed out/i);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('handles non-JSON response bodies without throwing', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not json</html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await clawbridge.startSession({
        localPort: port, token: null, project: 'p', permissionMode: 'default'
      });
      assert.equal(result.ok, true, 'status was 200, so ok is true');
      assert.equal(result.sessionId, null, 'no parseable JSON → no sessionId');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── CC-7 Slice B foundation: send / getOutput / getStatus (ClawBridge v1.7.1) ──

describe('clawbridge._queryString', () => {
  it('URL-encodes, skips null/undefined, but KEEPS a falsy cursor=0', () => {
    const qs = clawbridge._queryString({ project: 'a b', cursor: 0, waitMs: undefined, maxEvents: null });
    assert.equal(qs, 'project=a%20b&cursor=0');
  });
});

describe('clawbridge.send', () => {
  it('POSTs /v2/session/send with {project, message} + Bearer, returns accepted/cursor/state', async () => {
    let req = null; let body = null;
    const stub = await startStubBridge((r, b) => {
      req = { method: r.method, path: r.url, headers: r.headers };
      body = JSON.parse(b);
      return { status: 200, body: { ok: true, accepted: true, cursor: 12, sessionId: 'sess-1', state: 'running' } };
    });
    try {
      const result = await clawbridge.send({ localPort: stub.port, token: 'tok', project: 'demo', message: 'wrap now' });
      assert.equal(result.ok, true);
      assert.equal(result.accepted, true);
      assert.equal(result.cursor, 12);
      assert.equal(result.sessionId, 'sess-1');
      assert.equal(result.state, 'running');
      assert.equal(req.method, 'POST');
      assert.equal(req.path, '/v2/session/send');
      assert.equal(req.headers.authorization, 'Bearer tok');
      assert.deepEqual(body, { project: 'demo', message: 'wrap now' });
    } finally {
      await stub.close();
    }
  });

  it('maps a 404 (no active session) to ok:false + error', async () => {
    const stub = await startStubBridge(() => ({ status: 404, body: { error: 'no active session' } }));
    try {
      const result = await clawbridge.send({ localPort: stub.port, token: null, project: 'p', message: 'x' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
      assert.equal(result.error, 'no active session');
      assert.equal(result.cursor, null);
    } finally {
      await stub.close();
    }
  });

  it('maps a 409 (session not writable) to ok:false', async () => {
    const stub = await startStubBridge(() => ({ status: 409, body: { error: 'waiting for permission' } }));
    try {
      const result = await clawbridge.send({ localPort: stub.port, token: null, project: 'p', message: 'x' });
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.match(result.error, /permission/);
    } finally {
      await stub.close();
    }
  });

  it('returns ok:false on a network error', async () => {
    const result = await clawbridge.send({ localPort: 1, token: null, project: 'p', message: 'x', timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe('clawbridge.getOutput', () => {
  it('GETs /v2/session/output with cursor (incl. cursor=0) + optional params, returns events', async () => {
    let req = null;
    const stub = await startStubBridge((r) => {
      req = { method: r.method, path: r.url };
      return { status: 200, body: {
        ok: true, events: [{ seq: 1, kind: 'text', text: 'hi' }],
        cursorStart: 0, cursorEnd: 1, hasMore: false, state: 'running'
      } };
    });
    try {
      const result = await clawbridge.getOutput({ localPort: stub.port, token: null, project: 'demo', cursor: 0, maxEvents: 50 });
      assert.equal(result.ok, true);
      assert.equal(result.events.length, 1);
      assert.equal(result.cursorEnd, 1);
      assert.equal(result.hasMore, false);
      assert.equal(result.state, 'running');
      assert.equal(req.method, 'GET');
      assert.match(req.path, /^\/v2\/session\/output\?/);
      assert.match(req.path, /cursor=0/, 'cursor=0 must be sent, not dropped as falsy');
      assert.match(req.path, /maxEvents=50/);
    } finally {
      await stub.close();
    }
  });

  it('surfaces a pendingPermission when the session is waiting', async () => {
    const stub = await startStubBridge(() => ({ status: 200, body: {
      ok: true, events: [], cursorStart: 5, cursorEnd: 5, hasMore: false,
      state: 'waiting_for_permission', pendingPermission: { id: 'perm-7', permissionType: 'file_write' }
    } }));
    try {
      const result = await clawbridge.getOutput({ localPort: stub.port, token: null, project: 'p', cursor: 5 });
      assert.equal(result.state, 'waiting_for_permission');
      assert.equal(result.pendingPermission.id, 'perm-7');
    } finally {
      await stub.close();
    }
  });

  it('returns an empty events array (never undefined) on error', async () => {
    const stub = await startStubBridge(() => ({ status: 410, body: { error: 'session ended' } }));
    try {
      const result = await clawbridge.getOutput({ localPort: stub.port, token: null, project: 'p', cursor: 0 });
      assert.equal(result.ok, false);
      assert.deepEqual(result.events, []);
      assert.equal(result.error, 'session ended');
    } finally {
      await stub.close();
    }
  });
});

describe('clawbridge.getStatus', () => {
  it('GETs /v2/session/status and returns active/inputReady/state/cursor', async () => {
    let req = null;
    const stub = await startStubBridge((r) => {
      req = { method: r.method, path: r.url };
      return { status: 200, body: {
        ok: true, active: true, inputReady: true, sessionId: 'sess-9', state: 'running', cursor: 27
      } };
    });
    try {
      const result = await clawbridge.getStatus({ localPort: stub.port, token: 'tok', project: 'demo' });
      assert.equal(result.ok, true);
      assert.equal(result.active, true);
      assert.equal(result.inputReady, true);
      assert.equal(result.state, 'running');
      assert.equal(result.cursor, 27);
      assert.equal(req.method, 'GET');
      assert.match(req.path, /^\/v2\/session\/status\?project=demo$/);
    } finally {
      await stub.close();
    }
  });

  it('treats the bridge 200 + active:false as an honest "no live session" (the #364 signal)', async () => {
    const stub = await startStubBridge(() => ({ status: 200, body: { ok: true, project: 'p', active: false } }));
    try {
      const result = await clawbridge.getStatus({ localPort: stub.port, token: null, project: 'p' });
      assert.equal(result.ok, true, 'reachable bridge → ok:true even with no session');
      assert.equal(result.active, false);
      assert.equal(result.inputReady, false);
      assert.equal(result.state, null);
    } finally {
      await stub.close();
    }
  });

  it('returns ok:false (not a false "dead") when the bridge is unreachable', async () => {
    const result = await clawbridge.getStatus({ localPort: 1, token: null, project: 'p', timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.ok(result.error, 'unreachable must be distinguishable from active:false');
  });
});
