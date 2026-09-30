#!/usr/bin/env node
'use strict';

/**
 * A minimal Medusa hub for the offline soak guest (#2020).
 *
 * The guest has no network, so no real Medusa hub can run in it, and without a
 * hub no TangleClaw session's switchboard listener ever reaches `listening`.
 * This stub speaks exactly the part of the hub protocol TangleClaw uses, on
 * loopback only, so the soak's `engine.session.medusa-cycle` exercises the
 * candidate's own listener, send route, inbox and read path end to end. It
 * certifies TangleClaw's side of the switchboard, not Medusa.
 *
 * What it serves:
 * - HTTP (default port 3009): `POST /messages/direct`, `GET /workspaces`,
 *   `GET /health`.
 * - WebSocket (default port 3010, TangleClaw's HTTP port + 1): `register` →
 *   `registered`, `listener_heartbeat` → `heartbeat_ack`, `new_message` pushes,
 *   and `ack` → `ack_response`.
 *
 * A message stays queued for its workspace until that workspace acknowledges
 * it, and a workspace that registers again is sent everything still queued,
 * as the real hub does. It needs no credentials, because TangleClaw sends
 * none. Nothing is persisted: a restart forgets every queue.
 *
 * Usage: node medusa-stub.js [--http-port N] [--ws-port N] [--hosts 127.0.0.1,::1]
 *
 * @module deploy/soak/medusa-stub/medusa-stub
 */

const http = require('node:http');
const crypto = require('node:crypto');

/** The WebSocket handshake's fixed GUID (RFC 6455 section 1.3). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest frame accepted from a client. TangleClaw's message bodies are at most 64 KiB. */
const MAX_FRAME_BYTES = 1024 * 1024;

/** The largest HTTP request body accepted. */
const MAX_BODY_BYTES = 256 * 1024;

/** Only these hosts may be bound: the stub is loopback-only by construction. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

/**
 * The `Sec-WebSocket-Accept` value for a client key.
 * @param {string} key - The client's `Sec-WebSocket-Key`
 * @returns {string} Base64 SHA-1 of the key and the GUID
 */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Encode one unmasked server frame.
 * @param {number} opcode - 0x1 text, 0x8 close, 0xA pong
 * @param {Buffer} payload - Frame payload
 * @returns {Buffer} The frame
 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Decode the frames complete in `buf`.
 * @param {Buffer} buf - Bytes received so far
 * @returns {{frames: Array<{fin: boolean, opcode: number, payload: Buffer}>, rest: Buffer, error?: string}}
 *   The complete frames, the unconsumed bytes, and why the stream is unusable when it is
 */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(MAX_FRAME_BYTES)) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
      len = Number(big);
      pos += 8;
    }
    if (len > MAX_FRAME_BYTES) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
    // A client must mask every frame (RFC 6455 section 5.1).
    if (!masked) return { frames, rest: Buffer.alloc(0), error: 'unmasked client frame' };
    if (buf.length - pos < 4 + len) break;
    const mask = buf.subarray(pos, pos + 4);
    pos += 4;
    const payload = Buffer.from(buf.subarray(pos, pos + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = pos + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * Read a JSON request body.
 * @param {http.IncomingMessage} req - Request
 * @returns {Promise<*>} The parsed body, or `undefined` when it is not JSON
 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); resolve(undefined); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(undefined); }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Send a JSON HTTP response.
 * @param {http.ServerResponse} res - Response
 * @param {number} status - Status code
 * @param {object} body - Body
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Create a stub hub. Nothing listens until `start()`.
 * @param {object} [opts]
 * @param {number} [opts.httpPort=3009] - HTTP port (0 picks a free one)
 * @param {number} [opts.wsPort=3010] - WebSocket port (0 picks a free one)
 * @param {string[]} [opts.hosts=['127.0.0.1', '::1']] - Loopback addresses to bind
 * @param {function(object): void} [opts.log] - Structured event sink
 * @returns {{start: function(): Promise<{httpPort: number, wsPort: number}>, stop: function(): Promise<void>, workspaces: function(): string[]}}
 */
function createHub(opts = {}) {
  const hosts = opts.hosts || [...LOOPBACK_HOSTS];
  for (const h of hosts) {
    if (!LOOPBACK_HOSTS.includes(h)) throw new Error(`refusing to bind ${h}: the stub hub binds loopback only (${LOOPBACK_HOSTS.join(', ')})`);
  }
  const log = opts.log || ((e) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`));
  /** @type {Map<string, object>} workspace id → its live socket state */
  const sockets = new Map();
  /** @type {Map<string, Map<string, object>>} workspace id → message id → queued envelope, until acked */
  const queues = new Map();
  /** @type {Set<string>} every workspace id that has registered since start */
  const known = new Set();
  const servers = [];

  /**
   * Send one JSON frame on a client socket.
   * @param {object} client - Socket state
   * @param {object} obj - Frame body
   * @returns {void}
   */
  function sendFrame(client, obj) {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
  }

  /**
   * Handle one text frame from a client.
   * @param {object} client - Socket state
   * @param {*} frame - Parsed frame
   * @returns {void}
   */
  function onClientFrame(client, frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'register' && typeof frame.workspaceId === 'string' && frame.workspaceId) {
      const id = frame.workspaceId;
      const previous = sockets.get(id);
      if (previous && previous !== client) previous.socket.destroy();
      client.workspaceId = id;
      sockets.set(id, client);
      known.add(id);
      sendFrame(client, { type: 'registered', workspaceId: id });
      // Everything still unacknowledged goes again: the listener drops an id it
      // has already seen, so a repeat is harmless and a loss is not possible.
      for (const envelope of (queues.get(id) || new Map()).values()) sendFrame(client, envelope);
      log({ event: 'registered', workspaceId: id, queued: (queues.get(id) || new Map()).size });
    } else if (frame.type === 'listener_heartbeat') {
      sendFrame(client, { type: 'heartbeat_ack' });
    } else if (frame.type === 'ack' && Array.isArray(frame.messageIds)) {
      const queue = client.workspaceId ? queues.get(client.workspaceId) : null;
      const ids = frame.messageIds.map(String);
      for (const mid of ids) if (queue) queue.delete(mid);
      sendFrame(client, { type: 'ack_response', success: true, messageIds: ids });
    }
  }

  /**
   * Take over an upgraded connection as a WebSocket client.
   * @param {http.IncomingMessage} req - Upgrade request
   * @param {import('node:net').Socket} socket - Its socket
   * @returns {void}
   */
  function onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    // No extension or subprotocol is accepted: the client offers
    // permessage-deflate, and echoing it would promise compressed frames.
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const client = { socket, workspaceId: null, buf: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      const { frames, rest, error } = decodeFrames(Buffer.concat([client.buf, chunk]));
      client.buf = rest;
      for (const f of frames) {
        if (!f.fin || f.opcode === 0x0) { socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xeb]))); return; } // 1003: no fragments
        if (f.opcode === 0x8) { socket.end(encodeFrame(0x8, f.payload.subarray(0, 2))); return; }
        if (f.opcode === 0x9) { socket.write(encodeFrame(0xA, f.payload)); continue; }
        if (f.opcode !== 0x1) continue;
        let parsed;
        try { parsed = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        onClientFrame(client, parsed);
      }
      if (error) {
        log({ event: 'bad-frame', workspaceId: client.workspaceId, error });
        socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xea]))); // 1002: protocol error
      }
    });
    const drop = () => {
      if (client.workspaceId && sockets.get(client.workspaceId) === client) sockets.delete(client.workspaceId);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  /**
   * Route one HTTP request.
   * @param {http.IncomingMessage} req - Request
   * @param {http.ServerResponse} res - Response
   * @returns {Promise<void>}
   */
  async function onRequest(req, res) {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'hissing', version: 'soak-stub' });
    } else if (req.method === 'GET' && url.pathname === '/workspaces') {
      sendJson(res, 200, { workspaces: [...known].map((id) => ({ id, name: id })) });
    } else if (req.method === 'POST' && url.pathname === '/messages/direct') {
      const body = await readJson(req);
      if (!body || typeof body.to !== 'string' || typeof body.from !== 'string' || typeof body.message !== 'string') {
        sendJson(res, 400, { success: false, error: 'to, from and message are required strings' });
        return;
      }
      if (!known.has(body.to)) {
        sendJson(res, 404, { success: false, error: `Workspace ${body.to} not found` });
        return;
      }
      const id = crypto.randomUUID();
      const message = { id, type: 'direct', from: body.from, to: body.to, message: body.message, timestamp: new Date().toISOString() };
      const envelope = { type: 'new_message', messageId: id, message };
      if (!queues.has(body.to)) queues.set(body.to, new Map());
      queues.get(body.to).set(id, envelope);
      const target = sockets.get(body.to);
      if (target) sendFrame(target, envelope);
      log({ event: 'direct', id, from: body.from, to: body.to, delivered: Boolean(target) });
      sendJson(res, 200, { success: true, status: target ? 'received' : 'queued', id });
    } else {
      sendJson(res, 404, { success: false, error: 'not found' });
    }
  }

  /**
   * Listen on one host and port.
   * @param {http.Server} server - Server
   * @param {string} host - Address
   * @param {number} port - Port (0 for any)
   * @returns {Promise<number>} The port bound
   */
  function listen(server, host, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
    });
  }

  return {
    async start() {
      let httpPort = opts.httpPort ?? 3009;
      let wsPort = opts.wsPort ?? 3010;
      // Every host binds the same pair of ports: the first bind of a 0 port
      // fixes it for the rest, so each address serves one hub.
      for (const host of hosts) {
        const h = http.createServer((req, res) => { onRequest(req, res).catch(() => sendJson(res, 500, { success: false, error: 'stub error' })); });
        const w = http.createServer((_req, res) => sendJson(res, 426, { success: false, error: 'WebSocket only' }));
        w.on('upgrade', onUpgrade);
        servers.push(h, w);
        httpPort = await listen(h, host, httpPort);
        wsPort = await listen(w, host, wsPort);
      }
      log({ event: 'listening', hosts, httpPort, wsPort });
      return { httpPort, wsPort };
    },
    async stop() {
      for (const c of sockets.values()) c.socket.destroy();
      sockets.clear();
      await Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
      servers.length = 0;
    },
    workspaces: () => [...sockets.keys()]
  };
}

/**
 * Parse the command line.
 * @param {string[]} argv - Arguments after the script
 * @returns {{httpPort: number, wsPort: number, hosts: string[]}} Options
 * @throws {Error} On an unknown or malformed argument
 */
function parseArgs(argv) {
  const out = { httpPort: 3009, wsPort: 3010, hosts: [...LOOPBACK_HOSTS] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--http-port' || flag === '--ws-port') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${flag} must be a port number, not ${value}`);
      out[flag === '--http-port' ? 'httpPort' : 'wsPort'] = n;
    } else if (flag === '--hosts') {
      out.hosts = value.split(',').map((h) => h.trim()).filter(Boolean);
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return out;
}

module.exports = { createHub, parseArgs, encodeFrame, decodeFrames, acceptKey, LOOPBACK_HOSTS };

if (require.main === module) {
  let hub;
  try {
    hub = createHub(parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`medusa-stub: ${err.message}\n`);
    process.exit(2);
  }
  hub.start().catch((err) => {
    process.stderr.write(`medusa-stub: could not listen: ${err.message}\n`);
    process.exit(3);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { hub.stop().then(() => process.exit(0)); });
}
