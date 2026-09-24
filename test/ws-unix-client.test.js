'use strict';

/*
 * The WebSocket client over a unix socket (#1825 B2): the handshake is
 * checked, not assumed; frames of every length form arrive whole, fragmented
 * messages are reassembled, pings are answered, a close is reported once, and
 * an oversized frame ends the connection instead of buffering it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WsUnixClient } = require('../lib/ws-unix-client');
const { frame, serve } = require('./helpers/ws-test-server');

describe('WsUnixClient', () => {
  let dir;
  let n = 0;
  const servers = [];
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ws-')); });
  after(() => {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sock = () => path.join(dir, `s${++n}.sock`);

  /**
   * Serve and connect a client.
   * @param {(conn: object) => void} onConnection - Server handler.
   * @param {object} [serverOpts] - Server options.
   * @param {object} [clientOpts] - Client options.
   * @returns {Promise<WsUnixClient>}
   */
  async function connected(onConnection, serverOpts, clientOpts) {
    const p = sock();
    servers.push(await serve(p, onConnection, serverOpts));
    const client = new WsUnixClient(p, clientOpts);
    client.messages = [];
    client.errors = [];
    client.closes = [];
    client.on('message', (m) => client.messages.push(m));
    client.on('error', (e) => client.errors.push(e));
    client.on('close', (c) => client.closes.push(c));
    await client.connect();
    return client;
  }

  /**
   * Wait until the client has collected `n` messages, then return the n-th.
   * Collected rather than awaited one by one: two messages can arrive in one
   * chunk, and a listener attached after the first would miss the second.
   * @param {WsUnixClient} client - Client.
   * @param {number} n - 1-based index.
   * @returns {Promise<string>}
   */
  async function message(client, n) {
    await until(() => client.messages.length >= n, `${n} messages`);
    return client.messages[n - 1];
  }

  /**
   * Poll a condition, bounded. Events can fire before a listener attached
   * after an `await` would see them, so tests read collected arrays instead.
   * @param {() => boolean} cond - Condition.
   * @param {string} what - For the failure message.
   * @returns {Promise<void>}
   */
  async function until(cond, what) {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('completes the handshake and exchanges text frames, masking what it sends', async () => {
    let serverConn;
    const client = await connected((conn) => { serverConn = conn; conn.onFrames((frames) => { for (const f of frames) if (f.opcode === 0x1) conn.send(`echo:${f.payload.toString()}`); }); });
    assert.ok(serverConn);
    client.send('{"id":1}');
    assert.equal(await message(client, 1), 'echo:{"id":1}');
    client.close();
  });

  it('refuses a non-101 answer and a wrong accept key', async () => {
    const p1 = sock();
    servers.push(await serve(p1, () => {}, { refuse: true }));
    await assert.rejects(new WsUnixClient(p1).connect(), /handshake refused: HTTP\/1\.1 403/);
    const p2 = sock();
    servers.push(await serve(p2, () => {}, { badAccept: true }));
    await assert.rejects(new WsUnixClient(p2).connect(), /wrong Sec-WebSocket-Accept/);
  });

  it('rejects a dial to a socket nobody listens on', async () => {
    await assert.rejects(new WsUnixClient(path.join(dir, 'absent.sock')).connect(), /ENOENT|ECONNREFUSED/);
  });

  it('reads the 7-bit, 16-bit and 64-bit length forms, and messages split across chunks', async () => {
    const sizes = [5, 126, 70000];
    const bodies = sizes.map((s) => 'x'.repeat(s));
    const client = await connected((conn) => {
      const all = Buffer.concat(bodies.map((b) => frame(0x1, Buffer.from(b))));
      // Split at awkward places: mid-header of the second frame and mid-payload of the third.
      conn.raw(all.subarray(0, 8));
      setTimeout(() => conn.raw(all.subarray(8, 200)), 5);
      setTimeout(() => conn.raw(all.subarray(200)), 10);
    });
    await message(client, 3);
    assert.deepEqual(client.messages.map((g) => g.length), sizes);
    client.close();
  });

  it('reassembles a fragmented message and sends what it sent, in order', async () => {
    const client = await connected((conn) => {
      conn.raw(frame(0x1, Buffer.from('hel'), false));
      conn.raw(frame(0x0, Buffer.from('lo '), false));
      conn.raw(frame(0x0, Buffer.from('world'), true));
      conn.raw(frame(0x1, Buffer.from('next')));
    });
    assert.equal(await message(client, 1), 'hello world');
    assert.equal(await message(client, 2), 'next');
    client.close();
  });

  it('answers a ping with a pong carrying the same payload', async () => {
    let pong;
    const gotPong = new Promise((resolve) => { pong = resolve; });
    const client = await connected((conn) => {
      conn.onFrames((frames) => { for (const f of frames) if (f.opcode === 0xa) pong(f.payload.toString()); });
      conn.raw(frame(0x9, Buffer.from('keepalive')));
    });
    assert.equal(await gotPong, 'keepalive');
    client.close();
  });

  it('reports a server close once, with its code, and reports the socket ending', async () => {
    const client = await connected((conn) => {
      const payload = Buffer.alloc(2 + 3); payload.writeUInt16BE(1001, 0); payload.write('bye', 2);
      conn.raw(frame(0x8, payload));
      conn.end();
    });
    await until(() => client.closes.length >= 1, 'a close');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.closes.length, 1, 'close is emitted once');
    assert.deepEqual(client.closes[0], { code: 1001, reason: 'bye' });
    assert.equal(client.open, false);
    assert.throws(() => client.send('late'), /not open/);
  });

  it('drops the connection on a frame over the message limit, with an error', async () => {
    const client = await connected((conn) => {
      conn.raw(frame(0x1, Buffer.alloc(300, 0x41)));
    }, {}, { maxMessageBytes: 200 });
    await until(() => client.errors.length >= 1 && client.closes.length >= 1, 'an error and a close');
    assert.match(client.errors[0].message, /exceeded the message limit/);
    assert.equal(client.closes[0].code, 1002);
    assert.equal(client.open, false);
  });

  it('closes cleanly from the client side with a close frame', async () => {
    let seen;
    const gotClose = new Promise((resolve) => { seen = resolve; });
    const client = await connected((conn) => {
      conn.onFrames((frames) => { for (const f of frames) if (f.opcode === 0x8) seen(f.payload.readUInt16BE(0)); });
    });
    client.close(1000);
    assert.equal(await gotClose, 1000);
    client.close();
  });
});
