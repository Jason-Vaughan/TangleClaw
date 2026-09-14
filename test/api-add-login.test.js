'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const { handleRequest } = require('../server');

// POST /api/auth/add-login — the way back from finishing setup without a login
// (#803; ADR 0009's opt-out, ruled 2026-09-10: a login is addable later from
// global settings). Driven through the REAL request handler, so the gate's own
// verdict is what the route reads.

const PASSWORD = 'correct-horse-battery';

describe('Adding a login from settings (#803)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-add-login-test-'));
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
    fs.rmSync(path.join(tempDir, 'accounts-established'), { force: true });
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    cfg.loginOptOutAt = '2026-09-10T12:00:00.000Z';
    store.config.save(cfg);
  });

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
   * Drive one browser-shaped request through the real handler.
   * @param {string} method
   * @param {string} url
   * @param {object} [opts]
   * @param {object} [opts.body]
   * @param {object} [opts.headers]
   * @param {string} [opts.cookie]
   * @param {string} [opts.csrf]
   * @param {string} [opts.remoteAddress]
   * @returns {Promise<object>} The mock response
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers = Object.assign({ host: 'localhost:3102', 'sec-fetch-site': 'same-origin' }, opts.headers);
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.csrf) headers[authSession.CSRF_HEADER] = opts.csrf;
    const req = {
      url, method, headers,
      socket: { remoteAddress: opts.remoteAddress || '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  const addLogin = (opts) => send('POST', '/api/auth/add-login', Object.assign({ body: {} }, opts));

  /** @returns {Promise<string>} The gate state a signed-out browser meets now. */
  async function gateState() {
    const res = await send('GET', '/api/auth/me');
    return JSON.parse(res.body).gateState;
  }

  describe('on an install with no login', () => {
    it('turns the login on, clears the recorded opt-out, and sends the browser to create the account', async () => {
      assert.equal(await gateState(), 'open');
      const res = await addLogin();
      assert.equal(res.statusCode, 200, res.body);
      const data = JSON.parse(res.body);
      assert.equal(data.next, '/login');
      assert.equal(data.accountExists, false);
      const cfg = store.config.load();
      assert.equal(cfg.authEnabled, true);
      assert.equal(cfg.loginOptOutAt, null, 'the install no longer carries "the operator chose no login"');
      assert.equal(await gateState(), 'account-required',
        '/login now serves the first-account page, which mints the recovery codes');
    });

    it('creates no account and touches no password itself', async () => {
      await addLogin();
      assert.equal(store.users.list().length, 0);
    });

    it('arms the gate at once when an account was already made at a terminal', async () => {
      store.users.create('rosie', PASSWORD);
      const res = await addLogin();
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(JSON.parse(res.body).accountExists, true);
      assert.equal(await gateState(), 'armed');
    });

    it('is reachable through the proxy — reach authorises it, as it does the first-account page', async () => {
      const res = await addLogin({ headers: { 'x-forwarded-for': '100.64.0.7' } });
      assert.equal(res.statusCode, 200, res.body);
    });
  });

  describe('where it would strand the person who pressed it', () => {
    /** An account existed (the marker was written), then its row was lost. */
    function loseTheStore() {
      const u = store.users.create('former', 'a-long-enough-password');
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
      assert.equal(store.users.accountsEstablished(), true);
    }

    it('refuses from off this machine once the account store has been lost, and changes nothing', async () => {
      loseTheStore();
      const res = await addLogin({ headers: { 'x-forwarded-for': '100.64.0.7' } });
      assert.equal(res.statusCode, 403, res.body);
      assert.match(res.body, /ACCOUNT_STORE_LOST/);
      assert.match(res.body, /reset-admin\.js --store/);
      assert.equal(store.config.load().authEnabled, false);
      assert.equal(store.config.load().loginOptOutAt, '2026-09-10T12:00:00.000Z');
    });

    it('refuses from another machine on a wide listener, with no proxy', async () => {
      loseTheStore();
      const res = await addLogin({ remoteAddress: '10.0.0.5' });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(store.config.load().authEnabled, false);
    });

    it('allows it on this machine, where the first-account page will take the claim', async () => {
      loseTheStore();
      const res = await addLogin();
      assert.equal(res.statusCode, 200, res.body);
    });

    it('refuses when every account is disabled, since nobody could sign in', async () => {
      store.users.create('rosie', PASSWORD);
      store.users.disable('rosie');
      const res = await addLogin();
      assert.equal(res.statusCode, 409, res.body);
      assert.match(res.body, /NO_LOGINABLE_ACCOUNT/);
      assert.equal(store.config.load().authEnabled, false);
    });

    it('answers 503 and changes nothing when the account store cannot be read', async () => {
      const orig = store.users.accountsEstablished;
      store.users.accountsEstablished = () => { throw new Error('EACCES: permission denied'); };
      try {
        const res = await addLogin();
        assert.equal(res.statusCode, 503, res.body);
        assert.match(res.body, /GATE_UNREADABLE/);
      } finally {
        store.users.accountsEstablished = orig;
      }
      assert.equal(store.config.load().authEnabled, false);
    });
  });

  describe('where it has nothing to do', () => {
    it('refuses while setup is unfinished — the wizard is where that choice is made', async () => {
      const cfg = store.config.load();
      cfg.setupComplete = false;
      store.config.save(cfg);
      const res = await addLogin();
      assert.equal(res.statusCode, 409, res.body);
      assert.match(res.body, /SETUP_NOT_COMPLETE/);
      assert.equal(store.config.load().authEnabled, false);
    });

    it('refuses a signed-in caller on an install whose login is already on', async () => {
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
      const csrf = JSON.parse(login.body).csrfToken;
      const res = await addLogin({ cookie, csrf });
      assert.equal(res.statusCode, 409, res.body);
      assert.match(res.body, /LOGIN_ALREADY_ON/);
    });

    it('is not reachable signed out once the login is on — the gate answers first', async () => {
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const res = await addLogin();
      assert.equal(res.statusCode, 401, res.body);
    });
  });
});
