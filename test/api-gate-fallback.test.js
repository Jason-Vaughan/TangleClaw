'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const store = require('../lib/store');
const caddy = require('../lib/caddy');
const gateFallback = require('../lib/gate-fallback');
const { handleRequest, handleUpgrade } = require('../server');
const { FIXTURE_CADDYFILES, FIXTURE_SERVER_PORT } = require('./_caddy-drift-fixtures');

// The fallback marker driven through the REAL request and upgrade handlers.
// `gate-fallback.test.js` proves the decision; these prove the gate asks it, on
// both transports, with the listener read from the socket's own server.

const PASSWORD = 'correct-horse-battery';
const CADDY_AVAILABLE = caddy.detectCaddy().available;

describe('the fallback marker, end to end (#1420)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fallback-api-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM recovery_codes').run();
    store.getDb().prepare('DELETE FROM users').run();
    gateFallback.removeMarker(gateFallback.markerPath());
    fs.rmSync(caddy.getCaddyfilePath(), { force: true });
    patchConfig({ authEnabled: false, ingressMode: 'direct' });
  });

  /** @param {object} fields */
  function patchConfig(fields) {
    const cfg = store.config.load();
    Object.assign(cfg, fields);
    store.config.save(cfg);
  }

  function arm() {
    store.users.create('rosie', PASSWORD);
    patchConfig({ authEnabled: true });
  }

  function setMarker() {
    gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
  }

  /**
   * The socket's server, as `net.Server#address` reports a bound listener.
   * @param {string} address
   * @returns {{ address: Function }}
   */
  const listener = (address) => ({ address: () => ({ address, port: FIXTURE_SERVER_PORT, family: 'IPv4' }) });

  function mockRes() {
    return {
      statusCode: 0,
      body: '',
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
  }

  /**
   * One browser-shaped request through the real handler.
   * @param {string} method
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.bound] - The listener address; defaults to loopback.
   * @param {object} [opts.body]
   * @returns {Promise<object>}
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers = { host: 'localhost:3102', 'sec-fetch-site': 'same-origin' };
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    const req = {
      url, method, headers,
      socket: { remoteAddress: '127.0.0.1', server: listener(opts.bound || '127.0.0.1') },
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  const json = (res) => JSON.parse(res.body);
  const gateStateOf = async (opts) => json(await send('GET', '/api/auth/me', opts)).gateState;

  describe('direct mode, no Caddyfile', () => {
    it('stands an armed gate down while the marker exists, and re-arms the moment it is gone', async () => {
      arm();
      assert.equal((await send('GET', '/api/config')).statusCode, 401);
      setMarker();
      assert.equal(await gateStateOf(), 'fallback');
      const me = json(await send('GET', '/api/auth/me'));
      assert.equal(me.gateActive, false);
      assert.equal((await send('GET', '/api/config')).statusCode, 200);
      gateFallback.removeMarker(gateFallback.markerPath());
      assert.equal(await gateStateOf(), 'armed');
      assert.equal((await send('GET', '/api/config')).statusCode, 401);
    });

    it('stands down a locked install too', async () => {
      arm();
      store.users.disable('rosie');
      setMarker();
      assert.equal(await gateStateOf(), 'fallback');
    });

    it('does not honour the marker on a listener bound beyond loopback', async () => {
      arm();
      setMarker();
      for (const bound of ['0.0.0.0', '::', '192.168.1.20']) {
        assert.equal(await gateStateOf({ bound }), 'armed', bound);
        assert.equal((await send('GET', '/api/config', { bound })).statusCode, 401, bound);
      }
    });

    it('does not honour the marker when the socket has no server to read', async () => {
      arm();
      setMarker();
      const req = {
        url: '/api/config', method: 'GET', headers: { host: 'localhost:3102', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' }, on(event, cb) { if (event === 'end') cb(); }
      };
      const res = mockRes();
      await handleRequest(req, res);
      assert.equal(res.statusCode, 401);
    });

    it('leaves an open install open — the marker never changes what it says', async () => {
      setMarker();
      assert.equal(await gateStateOf(), 'open');
    });

    it('refuses login management with GATE_FALLBACK, not "no login required"', async () => {
      arm();
      setMarker();
      const recover = await send('POST', '/api/auth/recover', { body: { code: 'x', password: 'y' } });
      assert.equal(recover.statusCode, 409);
      assert.equal(json(recover).code, 'GATE_FALLBACK');
      const codes = await send('GET', '/api/auth/recovery-codes');
      assert.equal(codes.statusCode, 409);
      assert.equal(json(codes).code, 'GATE_FALLBACK');
    });

    it('refuses turning the login on with GATE_FALLBACK, not "already on"', async () => {
      arm();
      patchConfig({ setupComplete: true });
      setMarker();
      const res = await send('POST', '/api/auth/add-login', { body: {} });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'GATE_FALLBACK');
    });

    it('refuses first-account creation with GATE_FALLBACK', async () => {
      patchConfig({ authEnabled: true });
      setMarker();
      const res = await send('POST', '/api/auth/set-password', { body: { username: 'rosie', password: PASSWORD } });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'GATE_FALLBACK');
      assert.equal(store.users.list().length, 0);
    });
  });

  describe('caddy mode', () => {
    it('does not honour the marker with no Caddyfile — Caddy may still serve an unread door', async () => {
      arm();
      patchConfig({ ingressMode: 'caddy' });
      setMarker();
      assert.equal(await gateStateOf(), 'armed');
    });

    describe('with caddy adapt answered from the committed fixtures', () => {
      // The same decision `against real caddy` makes below, runnable where caddy
      // is absent: the server's cache key, its re-read on a Caddyfile edit, and
      // the text it hands the decision.
      const drift = require('../lib/caddy-drift');
      let realAdapt;
      let adapts;
      beforeEach(() => {
        realAdapt = drift.adaptCaddyfile;
        adapts = 0;
        drift.adaptCaddyfile = (file) => {
          adapts++;
          const text = fs.readFileSync(file, 'utf8');
          const name = Object.keys(FIXTURE_CADDYFILES).find((n) => FIXTURE_CADDYFILES[n] === text);
          if (!name) return { ok: false, config: null, reason: 'not a fixture Caddyfile' };
          const json = fs.readFileSync(path.join(__dirname, 'fixtures', `caddy-adapt-${name}.json`), 'utf8');
          return { ok: true, config: JSON.parse(json), reason: null };
        };
      });
      const restoreAdapt = () => { drift.adaptCaddyfile = realAdapt; };

      it('re-decides when the Caddyfile changes, and adapts once per change', async () => {
        try {
          arm();
          patchConfig({ ingressMode: 'caddy' });
          setMarker();
          const file = caddy.getCaddyfilePath();
          fs.writeFileSync(file, FIXTURE_CADDYFILES.generated, { mode: 0o600 });
          assert.equal(await gateStateOf(), 'fallback');
          assert.equal(await gateStateOf(), 'fallback');
          assert.equal(adapts, 1, 'a second request reuses the verdict');
          fs.writeFileSync(file, FIXTURE_CADDYFILES['live-shape-own-auth'], { mode: 0o600 });
          assert.equal(await gateStateOf(), 'armed');
          fs.writeFileSync(file, FIXTURE_CADDYFILES['live-shape-gated'], { mode: 0o600 });
          assert.equal(await gateStateOf(), 'fallback');
        } finally { restoreAdapt(); }
      });

      it('refuses a Caddyfile that imports another file, even when adapt reads it as gated', async () => {
        try {
          arm();
          patchConfig({ ingressMode: 'caddy' });
          setMarker();
          const file = caddy.getCaddyfilePath();
          const importing = `${FIXTURE_CADDYFILES.generated}import extra.caddy\n`;
          fs.writeFileSync(file, importing, { mode: 0o600 });
          drift.adaptCaddyfile = () => ({ ok: true, config: JSON.parse(fs.readFileSync(
            path.join(__dirname, 'fixtures', 'caddy-adapt-generated.json'), 'utf8')), reason: null });
          assert.equal(await gateStateOf(), 'armed');
        } finally { restoreAdapt(); }
      });
    });
  });

  describe('a marker that cannot be read', () => {
    it('keeps the login enforcing, without throwing into the gate', async () => {
      arm();
      const marker = gateFallback.markerPath();
      fs.symlinkSync(marker, marker); // stat answers ELOOP
      try {
        assert.equal(await gateStateOf(), 'armed');
        assert.equal((await send('GET', '/api/config')).statusCode, 401);
      } finally {
        fs.rmSync(marker, { force: true });
      }
    });
  });

  describe('the upgrade gate asks the marker too', () => {
    let realConnect;
    let connects;
    beforeEach(() => {
      realConnect = net.connect;
      connects = [];
      net.connect = (...args) => {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const upstream = new PassThrough();
        upstream.write = () => true;
        connects.push(args);
        if (cb) process.nextTick(cb);
        return upstream;
      };
    });
    const restore = () => { net.connect = realConnect; };

    async function upgrade(bound) {
      const headers = {
        host: 'localhost:3102', origin: 'http://localhost:3102',
        upgrade: 'websocket', connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13'
      };
      const socket = new PassThrough();
      socket.remoteAddress = '127.0.0.1';
      socket.server = listener(bound);
      socket.written = '';
      const origEnd = socket.end.bind(socket);
      socket.end = (chunk, cb) => { if (chunk) socket.written += String(chunk); return origEnd(cb); };
      handleUpgrade({ url: '/terminal/ws', method: 'GET', headers, socket }, socket, Buffer.alloc(0));
      await new Promise((r) => setImmediate(r));
      return socket;
    }

    it('opens the terminal socket in fallback, and refuses it on a wide listener', async () => {
      try {
        arm();
        setMarker();
        const wide = await upgrade('0.0.0.0');
        assert.match(wide.written, /^HTTP\/1\.1 401 /);
        assert.equal(connects.length, 0);
        const local = await upgrade('127.0.0.1');
        assert.doesNotMatch(local.written, /^HTTP\/1\.1 401 /);
        assert.equal(connects.length, 1);
      } finally { restore(); }
    });
  });

  describe('against real caddy', { skip: !CADDY_AVAILABLE && 'caddy is not installed' }, () => {
    it('honours a gated Caddyfile and refuses the armed one and the /openclaw-direct exemption', async () => {
      arm();
      patchConfig({ ingressMode: 'caddy' });
      setMarker();
      const file = caddy.getCaddyfilePath();
      fs.writeFileSync(file, FIXTURE_CADDYFILES.generated, { mode: 0o600 });
      assert.equal(await gateStateOf(), 'fallback');
      fs.writeFileSync(file, FIXTURE_CADDYFILES.armed, { mode: 0o600 });
      assert.equal(await gateStateOf(), 'armed');
      fs.writeFileSync(file, FIXTURE_CADDYFILES['live-shape-own-auth'], { mode: 0o600 });
      assert.equal(await gateStateOf(), 'armed');
      fs.writeFileSync(file, FIXTURE_CADDYFILES['live-shape-gated'], { mode: 0o600 });
      assert.equal(await gateStateOf(), 'fallback');
    });
  });
});
