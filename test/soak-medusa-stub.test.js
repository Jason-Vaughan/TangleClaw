'use strict';

// The stub hub is only useful if the candidate's own switchboard listener
// works against it, so these tests drive TangleClaw's real MedusaListener over
// a real socket, following the soak's medusa-cycle: both listeners listening,
// a direct send that returns an id, that id in the recipient's inbox, and the
// recipient's handled report acknowledged back to the hub.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const stub = require('../deploy/soak/medusa-stub/medusa-stub');
const { MedusaListener } = require('../lib/medusa-listener');

/**
 * Poll until `fn` returns truthy, or fail after `ms`.
 * @param {function(): *} fn - Condition
 * @param {string} what - What is awaited, for the failure message
 * @param {number} [ms=5000] - Budget
 * @returns {Promise<*>} The truthy value
 */
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * POST JSON to the stub.
 * @param {number} port - HTTP port
 * @param {string} path - Path
 * @param {object} body - Body
 * @returns {Promise<{status: number, body: object}>} Response
 */
async function post(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

describe('soak medusa stub hub: against the real listener', () => {
  let hub;
  let ports;
  const listeners = [];

  /**
   * A started listener for a workspace.
   * @param {string} workspaceId - Workspace id
   * @returns {MedusaListener} The listener
   */
  function listen(workspaceId) {
    const l = new MedusaListener({ bridgeUrl: `ws://127.0.0.1:${ports.wsPort}`, workspaceId, backoffBaseMs: 50 });
    listeners.push(l);
    l.start();
    return l;
  }

  before(async () => {
    hub = stub.createHub({ httpPort: 0, wsPort: 0, hosts: ['127.0.0.1'], log: () => {} });
    ports = await hub.start();
  });

  after(async () => {
    for (const l of listeners) l.stop();
    await hub.stop();
  });

  it('brings two listeners to listening, delivers a direct send by its id, and takes the acknowledgement', async () => {
    const a = listen('soak-a-11111111');
    const b = listen('soak-b-22222222');
    await until(() => a.getStatus().state === 'listening' && b.getStatus().state === 'listening', 'both listening');

    const sent = await post(ports.httpPort, '/messages/direct', { to: 'soak-b-22222222', from: 'soak-a-11111111', message: 'hello' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.success, true);
    assert.equal(sent.body.status, 'received');
    assert.match(sent.body.id, /^[A-Za-z0-9._:-]{1,128}$/);

    const got = await until(() => b.inbox.find((m) => m.id === sent.body.id), 'the message in the recipient inbox');
    assert.deepEqual([got.from, got.to, got.message, got.type], ['soak-a-11111111', 'soak-b-22222222', 'hello', 'direct']);
    assert.equal(a.inbox.length, 0, 'the sender receives nothing');

    b.markHandled([sent.body.id]);
    await until(() => b._ackAwaiting.size === 0, 'the hub to confirm the acknowledgement');
    assert.equal(b.getStatus().lastErrorCode, null);
  });

  it('keeps an unacknowledged message queued and sends it again when the workspace registers again', async () => {
    const c = listen('soak-c-33333333');
    await until(() => c.getStatus().state === 'listening', 'listening');
    c.stop();
    await until(() => !hub.workspaces().includes('soak-c-33333333'), 'the hub to drop the closed socket');

    const sent = await post(ports.httpPort, '/messages/direct', { to: 'soak-c-33333333', from: 'soak-a-11111111', message: 'while away' });
    assert.deepEqual([sent.status, sent.body.status], [200, 'queued']);

    const back = listen('soak-c-33333333');
    const got = await until(() => back.inbox.find((m) => m.id === sent.body.id), 'the queued message after re-register');
    assert.equal(got.message, 'while away');

    // Once handled and acknowledged, a later register finds nothing queued.
    back.markHandled([sent.body.id]);
    await until(() => back._ackAwaiting.size === 0, 'the acknowledgement');
    back.stop();
    const again = listen('soak-c-33333333');
    await until(() => again.getStatus().state === 'listening', 'listening again');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(again.inbox.length, 0);
  });

  it('answers 404 for a workspace that never registered, and 400 for a malformed send', async () => {
    const unknown = await post(ports.httpPort, '/messages/direct', { to: 'nobody-00000000', from: 'soak-a-11111111', message: 'x' });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /not found/i);
    const bad = await post(ports.httpPort, '/messages/direct', { to: 'soak-a-11111111' });
    assert.equal(bad.status, 400);
  });

  it('reports itself healthy the way TangleClaw reads it, and lists registered workspaces', async () => {
    const health = await (await fetch(`http://127.0.0.1:${ports.httpPort}/health`)).json();
    assert.equal(health.status, 'hissing');
    const ws = await (await fetch(`http://127.0.0.1:${ports.httpPort}/workspaces`)).json();
    assert.ok(ws.workspaces.some((w) => w.id === 'soak-a-11111111'));
  });
});

describe('soak medusa stub hub: boundaries', () => {
  it('refuses to bind anything but loopback', () => {
    assert.throws(() => stub.createHub({ hosts: ['0.0.0.0'] }), /loopback only/);
    assert.throws(() => stub.createHub({ hosts: ['127.0.0.1', '192.168.64.2'] }), /loopback only/);
  });

  it('parses its ports and hosts, and refuses anything else', () => {
    assert.deepEqual(stub.parseArgs([]), { httpPort: 3009, wsPort: 3010, hosts: ['127.0.0.1', '::1'] });
    assert.deepEqual(stub.parseArgs(['--http-port', '4009', '--ws-port', '4010', '--hosts', '127.0.0.1']), { httpPort: 4009, wsPort: 4010, hosts: ['127.0.0.1'] });
    assert.throws(() => stub.parseArgs(['--http-port', 'x']), /port number/);
    assert.throws(() => stub.parseArgs(['--port', '1']), /unknown argument/);
    assert.throws(() => stub.parseArgs(['--hosts']), /needs a value/);
  });
});

describe('soak medusa stub hub: frames', () => {
  /**
   * A masked client frame, as a browser or Node's WebSocket sends it.
   * @param {Buffer} payload - Payload
   * @returns {Buffer} The frame
   */
  function clientFrame(payload) {
    const server = stub.encodeFrame(0x1, payload);
    const headerLen = server.length - payload.length;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const header = Buffer.from(server.subarray(0, headerLen));
    header[1] |= 0x80;
    return Buffer.concat([header, mask, masked]);
  }

  it('computes the RFC 6455 accept key', () => {
    assert.equal(stub.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('decodes masked frames of every length form, across chunk boundaries', () => {
    for (const size of [5, 300, 70000]) {
      const payload = crypto.randomBytes(size);
      const frame = clientFrame(payload);
      const first = stub.decodeFrames(frame.subarray(0, 3));
      assert.equal(first.frames.length, 0);
      const done = stub.decodeFrames(Buffer.concat([first.rest, frame.subarray(3)]));
      assert.equal(done.frames.length, 1, `size ${size}`);
      assert.ok(done.frames[0].payload.equals(payload), `size ${size}`);
      assert.equal(done.rest.length, 0);
    }
  });

  it('refuses an unmasked client frame', () => {
    assert.match(stub.decodeFrames(stub.encodeFrame(0x1, Buffer.from('x'))).error, /unmasked/);
  });
});
