'use strict';

/**
 * A minimal WebSocket (RFC 6455) client over a unix domain socket (#1825).
 *
 * Codex's app-server speaks WebSocket on its unix socket, Node's global
 * `WebSocket` dials only TCP URLs, and this project carries no dependencies,
 * so the client is ours. It does exactly what a JSON-RPC peer needs: the
 * opening handshake with the accept-key check, masked text frames out, text
 * frames of every length form in (including fragmented ones), ping answered
 * with pong, and a clean close. Binary frames are delivered as UTF-8 text,
 * because the peer only ever sends JSON; extensions and subprotocols are not
 * negotiated.
 *
 * Every wire byte is bounded: a frame longer than `maxMessageBytes` closes the
 * connection with an error rather than buffering without limit.
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/** The GUID RFC 6455 concatenates to the client key to form the accept value. */
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Longest message accepted, in bytes. The app-server advertises 16 MiB. */
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** How long the opening handshake may take before the dial is abandoned. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

const OPCODE = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

/**
 * A WebSocket client bound to one unix socket path.
 *
 * Events: `message` (string), `close` ({code, reason}), `error` (Error).
 */
class WsUnixClient extends EventEmitter {
  /**
   * @param {string} socketPath - The unix socket to dial.
   * @param {object} [options]
   * @param {number} [options.maxMessageBytes] - Largest message accepted.
   * @param {number} [options.handshakeTimeoutMs] - Handshake deadline.
   * @param {string} [options.host] - The `Host` header value (cosmetic on a unix socket).
   */
  constructor(socketPath, options = {}) {
    super();
    this.socketPath = socketPath;
    this.maxMessageBytes = options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.host = options.host || 'localhost';
    this.socket = null;
    this.open = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentBytes = 0;
    this._closeEmitted = false;
  }

  /**
   * Dial the socket and complete the opening handshake.
   * @returns {Promise<void>} Resolves once frames may be sent.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const expected = crypto.createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
      const socket = net.connect(this.socketPath);
      this.socket = socket;
      let head = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`WebSocket handshake timed out after ${this.handshakeTimeoutMs}ms`)), this.handshakeTimeoutMs);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('data', onHandshakeData);
        socket.off('error', onDialError);
        if (err) {
          socket.destroy();
          reject(err);
          return;
        }
        this.open = true;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (e) => this.emit('error', e));
        socket.on('close', () => this._emitClose(1006, 'socket closed'));
        resolve();
      };
      const onDialError = (err) => finish(err);
      const onHandshakeData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) {
          if (head.length > 16384) finish(new Error('WebSocket handshake response exceeded 16 KiB'));
          return;
        }
        const response = head.subarray(0, end).toString('latin1');
        const rest = head.subarray(end + 4);
        const statusLine = response.split('\r\n')[0];
        if (!/^HTTP\/1\.1 101 /.test(statusLine)) return finish(new Error(`WebSocket handshake refused: ${statusLine}`));
        const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(response);
        if (!accept || accept[1] !== expected) return finish(new Error('WebSocket handshake returned a wrong Sec-WebSocket-Accept'));
        finish(null);
        // Bytes that arrived with the handshake are delivered on the next loop
        // turn, so a caller attaching listeners right after `await connect()`
        // still sees the first message.
        if (rest.length > 0) setImmediate(() => this._onData(rest));
      };

      socket.on('error', onDialError);
      socket.on('data', onHandshakeData);
      socket.on('connect', () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${this.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
    });
  }

  /**
   * Send one text message.
   * @param {string} text - UTF-8 text.
   * @returns {void}
   * @throws {Error} When the connection is not open.
   */
  send(text) {
    if (!this.open) throw new Error('WebSocket is not open');
    this._writeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'));
  }

  /**
   * Send a close frame and end the socket. Safe to call more than once.
   * @param {number} [code=1000] - Close code.
   * @returns {void}
   */
  close(code = 1000) {
    if (this.open) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      try { this._writeFrame(OPCODE.CLOSE, payload); } catch { /* the socket is already gone */ }
    }
    this.open = false;
    if (this.socket) this.socket.end();
  }

  /**
   * Drop the socket at once, without a close frame.
   * @returns {void}
   */
  destroy() {
    this.open = false;
    if (this.socket) this.socket.destroy();
  }

  /**
   * Emit `close` once.
   * @param {number} code - Close code.
   * @param {string} reason - Why.
   * @returns {void}
   */
  _emitClose(code, reason) {
    this.open = false;
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close', { code, reason });
  }

  /**
   * Frame and write one message. Client frames are always masked (RFC 6455 §5.3).
   * @param {number} opcode - Frame opcode.
   * @param {Buffer} payload - Payload bytes.
   * @returns {void}
   */
  _writeFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /**
   * Consume inbound bytes, delivering every complete frame.
   * @param {Buffer} chunk - Bytes from the socket.
   * @returns {void}
   */
  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (frame === null) return;
      if (frame === false) {
        this._fail('WebSocket frame exceeded the message limit');
        return;
      }
      this._handleFrame(frame);
      if (!this.socket || this.socket.destroyed) return;
    }
  }

  /**
   * Parse one frame off the buffer.
   * @returns {{fin: boolean, opcode: number, payload: Buffer}|null|false} The frame,
   *   null when more bytes are needed, false when the frame is over the limit.
   */
  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) return false;
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxMessageBytes) return false;
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    this._buffer = buf.subarray(offset + len);
    if (mask) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    return { fin, opcode, payload };
  }

  /**
   * Act on one parsed frame.
   * @param {{fin: boolean, opcode: number, payload: Buffer}} frame - The frame.
   * @returns {void}
   */
  _handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        try { this._writeFrame(OPCODE.PONG, frame.payload); } catch { /* closing */ }
        return;
      case OPCODE.PONG:
        return;
      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        this.open = false;
        if (this.socket) this.socket.end();
        this._emitClose(code, reason);
        return;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
      case OPCODE.CONTINUATION: {
        this._fragmentBytes += frame.payload.length;
        if (this._fragmentBytes > this.maxMessageBytes) {
          this._fail('WebSocket message exceeded the message limit');
          return;
        }
        this._fragments.push(frame.payload);
        if (frame.fin) {
          const whole = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
          this._fragments = [];
          this._fragmentBytes = 0;
          this.emit('message', whole.toString('utf8'));
        }
        return;
      }
      default:
        this._fail(`WebSocket frame with unknown opcode ${frame.opcode}`);
    }
  }

  /**
   * Drop the connection over a protocol fault, reporting it once.
   * @param {string} message - What went wrong.
   * @returns {void}
   */
  _fail(message) {
    this.emit('error', new Error(message));
    this.destroy();
    this._emitClose(1002, message);
  }
}

module.exports = { WsUnixClient, ACCEPT_GUID, DEFAULT_MAX_MESSAGE_BYTES, OPCODE };
