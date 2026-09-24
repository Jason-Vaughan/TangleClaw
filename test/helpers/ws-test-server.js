'use strict';

/**
 * A small WebSocket server on a unix socket, for tests of the client and of
 * the Codex adapter (#1825 B2). It speaks just enough of RFC 6455 to stand in
 * for Codex's app-server: the handshake, unmasked server frames of every
 * length form, and masked client frames parsed back into messages.
 *
 * `FakeAppServer` layers the app-server's JSON-RPC shape on top: requests are
 * answered by handlers, notifications and server requests can be pushed, and
 * every inbound message is recorded so a test can assert what TangleClaw
 * sent and, as importantly, what it never sent.
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A server-side frame (unmasked).
 * @param {number} opcode - Opcode.
 * @param {Buffer} payload - Payload.
 * @param {boolean} [fin=true] - FIN bit.
 * @returns {Buffer}
 */
function frame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Parse masked client frames off a buffer.
 * @param {Buffer} buf - Bytes.
 * @returns {{frames: Array<{opcode: number, payload: Buffer}>, rest: Buffer}}
 */
function parseClientFrames(buf) {
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (!masked) throw new Error('client frames must be masked');
    if (buf.length < off + 4 + len) break;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i & 3]));
    frames.push({ opcode, payload });
    buf = buf.subarray(off + 4 + len);
  }
  return { frames, rest: buf };
}

/**
 * Serve WebSocket on a unix socket. `onConnection(conn)` gets an object with
 * `send(text)`, `raw(buffer)`, `end()`, `destroy()` and `onFrames(fn)`.
 * @param {string} sockPath - Where to listen.
 * @param {(conn: object) => void} onConnection - Per-connection handler.
 * @param {object} [opts]
 * @param {boolean} [opts.refuse] - Answer 403 instead of 101.
 * @param {boolean} [opts.badAccept] - Answer 101 with a wrong accept key.
 * @returns {Promise<net.Server>}
 */
function serve(sockPath, onConnection, opts = {}) {
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const listeners = [];
    const conn = {
      send: (text) => { if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(text, 'utf8'))); },
      raw: (bytes) => { if (!socket.destroyed) socket.write(bytes); },
      end: () => socket.end(),
      destroy: () => socket.destroy(),
      onFrames: (fn) => listeners.push(fn)
    };
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        const req = head.subarray(0, end).toString('latin1');
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(req)[1];
        if (opts.refuse) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        const accept = opts.badAccept ? 'nope' : crypto.createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        buf = head.subarray(end + 4);
        onConnection(conn);
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
      const parsed = parseClientFrames(buf);
      buf = parsed.rest;
      if (parsed.frames.length > 0) for (const fn of listeners) fn(parsed.frames);
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

/**
 * A stand-in for Codex's app-server: JSON-RPC over the WebSocket above.
 *
 * `handlers[method](params, ctx)` answers a request (return a result, or
 * throw `{code, message}`). `ctx.conn` is the connection; `ctx.server` is
 * this object. Every inbound message is pushed to `received`; every
 * connection to `connections`. Emits `request` ({method, params, conn}) for
 * each inbound request, after the handler answered.
 */
class FakeAppServer extends EventEmitter {
  /**
   * @param {string} sockPath - Where to listen.
   */
  constructor(sockPath) {
    super();
    this.sockPath = sockPath;
    this.handlers = {};
    this.received = [];
    this.connections = [];
    this.server = null;
    this.nextServerRequestId = 0;
  }

  /**
   * Start listening.
   * @returns {Promise<FakeAppServer>}
   */
  async start() {
    this.server = await serve(this.sockPath, (conn) => this._accept(conn));
    return this;
  }

  /**
   * Stop listening and drop every connection.
   * @returns {void}
   */
  close() {
    for (const c of this.connections) c.destroy();
    if (this.server) this.server.close();
  }

  /**
   * Wire one connection.
   * @param {object} conn - From `serve`.
   * @returns {void}
   */
  _accept(conn) {
    conn.closed = false;
    this.connections.push(conn);
    conn.onFrames((frames) => {
      for (const f of frames) {
        if (f.opcode === 0x8) { conn.closed = true; continue; }
        if (f.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        this.received.push(msg);
        if (msg.method && msg.id !== undefined) {
          const handler = this.handlers[msg.method];
          let response;
          if (!handler) {
            response = { id: msg.id, error: { code: -32601, message: `${msg.method} is not supported yet` } };
          } else {
            try {
              const result = handler(msg.params || {}, { conn, server: this });
              response = { id: msg.id, result: result === undefined ? {} : result };
            } catch (err) {
              // A handler that throws `{noResponse: true}` leaves the request
              // unanswered, for the "socket lost before the response" cases.
              response = err.noResponse ? null : { id: msg.id, error: { code: err.code || -32600, message: err.message } };
            }
          }
          if (response !== null && !conn.closed) conn.send(JSON.stringify(response));
          this.emit('request', { method: msg.method, params: msg.params, conn });
        } else if (msg.method) {
          this.emit('notification', { method: msg.method, params: msg.params, conn });
        } else if (msg.id !== undefined) {
          this.emit('response', msg);
        }
      }
    });
  }

  /**
   * Push a notification to every live connection.
   * @param {string} method - Method.
   * @param {object} params - Params.
   * @returns {void}
   */
  notify(method, params) {
    for (const c of this.connections) if (!c.closed) c.send(JSON.stringify({ method, params }));
  }

  /**
   * Push a server→client request (an approval) to every live connection.
   * @param {string} method - Method.
   * @param {object} params - Params.
   * @returns {number} The request id.
   */
  serverRequest(method, params) {
    const id = this.nextServerRequestId++;
    for (const c of this.connections) if (!c.closed) c.send(JSON.stringify({ id, method, params }));
    return id;
  }

  /**
   * The inbound requests for a method, in order.
   * @param {string} method - Method.
   * @returns {object[]}
   */
  calls(method) {
    return this.received.filter((m) => m.method === method && m.id !== undefined);
  }

  /**
   * Whether any inbound message was a RESPONSE to a server request (an
   * approval answered by the client).
   * @returns {boolean}
   */
  answeredAnyServerRequest() {
    return this.received.some((m) => m.method === undefined && m.id !== undefined);
  }
}

module.exports = { ACCEPT_GUID, frame, parseClientFrames, serve, FakeAppServer };
