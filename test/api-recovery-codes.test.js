'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const rc = require('../lib/recovery-codes');
const { handleRequest, _recoveryFailures } = require('../server');

// Recovery codes driven through the REAL request handler: the gate, the routes,
// and the cookies, together. The store's own guarantees are
// `store-recovery-codes.test.js`'s; these prove the wiring a pre-gate route
// depends on.

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-long-enough-new-password';

describe('recovery codes, end to end (#1420)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-api-'));
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
    const db = store.getDb();
    db.prepare('DELETE FROM recovery_codes').run();
    db.prepare('DELETE FROM auth_sessions').run();
    db.prepare('DELETE FROM users').run();
    _recoveryFailures.reset();
    setAuthEnabled(false);
  });

  /** @param {boolean} on */
  function setAuthEnabled(on) {
    const cfg = store.config.load();
    cfg.authEnabled = on;
    store.config.save(cfg);
  }

  /**
   * An armed install with one account holding a fresh set of codes.
   * @returns {{ user: object, codes: string[] }}
   */
  function armWithCodes(name = 'rosie') {
    const user = store.users.create(name, PASSWORD);
    setAuthEnabled(true);
    return { user, codes: store.recoveryCodes.replaceForUser(user.id).map(rc.formatCode) };
  }

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
   * One request through the real handler, browser-shaped unless `machine`.
   * @param {string} method
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const browserMarkers = opts.machine ? {} : { 'sec-fetch-site': 'same-origin' };
    const headers = Object.assign({ host: 'localhost:3102' }, browserMarkers, opts.headers);
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

  const json = (res) => JSON.parse(res.body);
  const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  async function login(username = 'rosie', password = PASSWORD) {
    const res = await send('POST', '/api/auth/login', { body: { username, password } });
    if (res.statusCode !== 200) return { res, cookie: null, csrf: null };
    return { res, cookie: cookieOf(res), csrf: json(res).csrfToken };
  }

  const recover = (code, password = NEW_PASSWORD, opts = {}) =>
    send('POST', '/api/auth/recover', Object.assign({ body: { code, password } }, opts));

  describe('issuance on the first-account screen', () => {
    it('returns a set of codes with the new account, and each one works', async () => {
      setAuthEnabled(true);
      const res = await send('POST', '/api/auth/set-password',
        { body: { username: 'jason', password: 'a-long-enough-password' } });
      assert.equal(res.statusCode, 200, res.body);
      const codes = json(res).recoveryCodes;
      assert.equal(codes.length, rc.CODES_PER_SET);
      for (const c of codes) assert.match(c, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
      const used = await recover(codes[3]);
      assert.equal(used.statusCode, 200, used.body);
      assert.equal(json(used).username, 'jason');
    });
  });

  describe('POST /api/auth/recover', () => {
    it('resets the password, signs the redeemer in, and ends the account\'s other sessions', async () => {
      const { codes } = armWithCodes();
      const old = await login();
      assert.ok(old.cookie, 'precondition: a live session');

      const res = await recover(codes[0]);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(Object.keys(json(res)).sort(), ['csrfToken', 'remaining', 'username']);
      assert.equal(json(res).remaining, rc.CODES_PER_SET - 1);
      const cookies = res.headers['set-cookie'];
      assert.ok(cookies.some((c) => c.startsWith(authSession.SESSION_COOKIE + '=')));

      assert.equal((await send('GET', '/api/config', { cookie: cookieOf(res) })).statusCode, 200,
        'the redeemer is signed in');
      assert.equal((await send('GET', '/api/config', { cookie: old.cookie })).statusCode, 401,
        'the session from before the reset is dead');
      assert.equal((await login('rosie', PASSWORD)).res.statusCode, 401, 'the old password is gone');
      assert.equal((await login('rosie', NEW_PASSWORD)).res.statusCode, 200, 'the new one works');
    });

    it('accepts a code however it is retyped', async () => {
      const { codes } = armWithCodes();
      const typed = codes[0].toLowerCase().replace(/-/g, ' ');
      assert.equal((await recover(typed)).statusCode, 200);
    });

    it('answers a wrong code, a used code, and a disabled account\'s code identically', async () => {
      const { codes } = armWithCodes();
      store.users.create('second', PASSWORD);
      assert.equal((await recover(codes[0])).statusCode, 200);

      const wrong = await recover(rc.formatCode(rc.generateCode()));
      const used = await recover(codes[0]);
      const other = store.users.create('dave', PASSWORD);
      const [daveCode] = store.recoveryCodes.replaceForUser(other.id);
      store.users.disable('dave');
      const disabled = await recover(daveCode);
      const malformed = await recover('not-a-code');

      for (const [label, r] of [['used', used], ['disabled', disabled], ['malformed', malformed]]) {
        assert.equal(r.statusCode, wrong.statusCode, label);
        assert.equal(r.body, wrong.body, label);
      }
      assert.equal(wrong.statusCode, 401);
      assert.equal(json(wrong).code, 'INVALID_RECOVERY_CODE');
      assert.equal(store.users.getByName('dave').disabled_at !== null, true, 'still disabled');
    });

    it('applies the password policy without using the code', async () => {
      const { codes } = armWithCodes();
      for (const password of ['short', 'password1234', 'my-name-is-rosie-ok']) {
        const res = await recover(codes[0], password);
        assert.equal(res.statusCode, 400, password);
        assert.equal(json(res).code, 'WEAK_PASSWORD');
      }
      assert.equal(store.recoveryCodes.status(store.users.getByName('rosie').id).remaining, rc.CODES_PER_SET);
      assert.equal((await recover(codes[0])).statusCode, 200, 'the code still works afterwards');
    });

    it('answers 400 for missing fields without counting a failure', async () => {
      armWithCodes();
      for (let i = 0; i < 20; i++) {
        assert.equal((await send('POST', '/api/auth/recover', { body: {} })).statusCode, 400);
      }
      assert.equal((await send('POST', '/api/auth/recover')).statusCode, 400, 'bodyless');
      assert.equal(_recoveryFailures.size(), 0);
    });

    it('refuses a client past ten failures — even with a valid code — and no one else', async () => {
      const { codes } = armWithCodes();
      for (let i = 0; i < 10; i++) {
        assert.equal((await recover(rc.formatCode(rc.generateCode()))).statusCode, 401);
      }
      const limited = await recover(codes[0]);
      assert.equal(limited.statusCode, 429);
      assert.equal(json(limited).code, 'RECOVERY_RATE_LIMITED');
      assert.ok(limited.headers['retry-after']);
      assert.equal((await recover(codes[0], NEW_PASSWORD, { remoteAddress: '100.64.0.2' })).statusCode, 200,
        'a different client is unaffected');
    });

    it('counts proxied requests per forwarded client, not all as Caddy', async () => {
      const { codes } = armWithCodes();
      const viaProxy = (ip) => ({ headers: { 'x-forwarded-for': ip } });
      for (let i = 0; i < 10; i++) await recover(rc.formatCode(rc.generateCode()), NEW_PASSWORD, viaProxy('100.64.0.66'));
      assert.equal((await recover(codes[0], NEW_PASSWORD, viaProxy('100.64.0.66'))).statusCode, 429);
      assert.equal((await recover(codes[0], NEW_PASSWORD, viaProxy('100.64.0.9'))).statusCode, 200);
    });

    it('lets a browser still holding a session redeem without a CSRF token', async () => {
      const { codes } = armWithCodes();
      const { cookie } = await login();
      const res = await recover(codes[0], NEW_PASSWORD, { cookie });
      assert.equal(res.statusCode, 200, res.body);
    });

    it('refuses a cross-site submission before the route is reached', async () => {
      const { codes } = armWithCodes();
      const res = await recover(codes[0], NEW_PASSWORD, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(res.statusCode, 403);
      assert.equal(store.recoveryCodes.status(store.users.getByName('rosie').id).remaining, rc.CODES_PER_SET);
    });

    it('hashes the new password inside the login concurrency cap', async () => {
      const { codes } = armWithCodes();
      const passwordLib = require('../lib/password');
      const realAsync = passwordLib.hashPasswordAsync;
      let asyncCalls = 0;
      let release;
      const held = new Promise((r) => { release = r; });
      passwordLib.hashPasswordAsync = function (...args) {
        asyncCalls++;
        return held.then(() => realAsync.apply(this, args));
      };
      try {
        const pending = [0, 1, 2].map((i) => recover(codes[i]));
        for (let i = 0; i < 1000 && asyncCalls < 2; i++) await new Promise((r) => setImmediate(r));
        assert.equal(asyncCalls, 2, 'precondition: two redemptions hold the cap');
        release();
        const statuses = (await Promise.all(pending)).map((r) => r.statusCode).sort();
        assert.deepEqual(statuses, [200, 200, 503]);
      } finally {
        passwordLib.hashPasswordAsync = realAsync;
      }
    });

    describe('outside armed', () => {
      it('is challenged by the gate in account-required and locked', async () => {
        setAuthEnabled(true);
        const noAccount = await recover(rc.formatCode(rc.generateCode()));
        assert.equal(noAccount.statusCode, 401);
        assert.equal(json(noAccount).code, 'ACCOUNT_REQUIRED');
        const { codes } = armWithCodes();
        store.users.disable('rosie');
        const locked = await recover(codes[0]);
        assert.equal(locked.statusCode, 401);
        assert.equal(json(locked).code, 'UNAUTHENTICATED');
      });

      it('says a login is not required on an open install', async () => {
        const res = await recover(rc.formatCode(rc.generateCode()));
        assert.equal(res.statusCode, 409);
        assert.equal(json(res).code, 'LOGIN_NOT_REQUIRED');
      });

      it('answers GATE_UNREADABLE, not a verdict on the code, when the state cannot be read', async () => {
        const { codes } = armWithCodes();
        const orig = store.authSessions.accountPresence;
        store.authSessions.accountPresence = () => { throw new Error('database is locked'); };
        try {
          const res = await recover(codes[0], NEW_PASSWORD, { machine: true });
          assert.equal(res.statusCode, 503);
          assert.equal(json(res).code, 'GATE_UNREADABLE');
        } finally {
          store.authSessions.accountPresence = orig;
        }
        assert.equal(store.recoveryCodes.status(store.users.getByName('rosie').id).remaining, rc.CODES_PER_SET);
      });

      it('names the terminal when a local tool reaches it on a locked install', async () => {
        const { codes } = armWithCodes();
        store.users.disable('rosie');
        const res = await recover(codes[0], NEW_PASSWORD, { machine: true });
        assert.equal(res.statusCode, 409);
        assert.equal(json(res).code, 'RECOVERY_UNAVAILABLE');
        assert.match(json(res).error, /reset-admin/);
      });
    });
  });

  describe('GET /recover', () => {
    it('serves the recovery page to a signed-out person on an armed install, uncached and unframeable', async () => {
      armWithCodes();
      const res = await send('GET', '/recover');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /\/api\/auth\/recover/);
      assert.match(res.headers['cache-control'], /no-store/);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    });

    it('is challenged with the login page on a locked install', async () => {
      armWithCodes();
      store.users.disable('rosie');
      const res = await send('GET', '/recover');
      assert.equal(res.statusCode, 401);
      assert.doesNotMatch(res.body, /\/api\/auth\/recover'/);
    });

    it('is linked from the login page', async () => {
      armWithCodes();
      const res = await send('GET', '/login');
      assert.match(res.body, /href="\/recover"/);
    });
  });

  describe('managing codes from the dashboard', () => {
    it('reports status and never a code', async () => {
      armWithCodes();
      const { cookie } = await login();
      const res = await send('GET', '/api/auth/recovery-codes', { cookie });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.remaining, rc.CODES_PER_SET);
      assert.equal(body.notice, null);
      assert.doesNotMatch(res.body, /[0-9A-Z]{5}-[0-9A-Z]{5}/);
    });

    it('regenerates only with the current password, and the old set stops working', async () => {
      const { codes } = armWithCodes();
      const { cookie, csrf } = await login();
      const noPassword = await send('POST', '/api/auth/recovery-codes', { cookie, csrf, body: {} });
      assert.equal(noPassword.statusCode, 400);
      const wrong = await send('POST', '/api/auth/recovery-codes', { cookie, csrf, body: { password: 'nope-nope-nope' } });
      assert.equal(wrong.statusCode, 403);
      assert.equal(json(wrong).code, 'REAUTH_FAILED');
      assert.ok(store.recoveryCodes.peek(codes[0]), 'a failed re-auth changed nothing');

      const ok = await send('POST', '/api/auth/recovery-codes', { cookie, csrf, body: { password: PASSWORD } });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(json(ok).codes.length, rc.CODES_PER_SET);
      assert.equal(store.recoveryCodes.peek(codes[0]), null, 'the old set is dead');
      assert.ok(store.recoveryCodes.peek(json(ok).codes[0]));
    });

    it('requires the CSRF token to regenerate', async () => {
      armWithCodes();
      const { cookie } = await login();
      const res = await send('POST', '/api/auth/recovery-codes', { cookie, body: { password: PASSWORD } });
      assert.equal(res.statusCode, 403);
    });

    it('refuses a signed-out caller, and says a login is not in use on an open install', async () => {
      armWithCodes();
      assert.equal((await send('GET', '/api/auth/recovery-codes')).statusCode, 401);
      setAuthEnabled(false);
      const open = await send('GET', '/api/auth/recovery-codes');
      assert.equal(open.statusCode, 409);
      assert.equal(json(open).code, 'LOGIN_NOT_REQUIRED');
    });

    it('lets a local tool with no session mint nothing', async () => {
      armWithCodes();
      const res = await send('POST', '/api/auth/recovery-codes', { machine: true, body: { password: PASSWORD } });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('the redemption notice', () => {
    it('is shown to the redeemed account on /api/server-info until acknowledged', async () => {
      const { codes } = armWithCodes();
      const redeemed = await recover(codes[0], NEW_PASSWORD, { headers: { 'x-forwarded-for': '100.64.0.9' } });
      const cookie = cookieOf(redeemed);
      const csrf = json(redeemed).csrfToken;

      const info = json(await send('GET', '/api/server-info', { cookie }));
      assert.equal(info.recoveryNotice.redemptions.length, 1);
      assert.equal(info.recoveryNotice.redemptions[0].from, '100.64.0.9 (through the proxy)');
      assert.equal(info.recoveryNotice.remaining, rc.CODES_PER_SET - 1);

      const ack = await send('POST', '/api/auth/recovery-codes/acknowledge', { cookie, csrf });
      assert.equal(ack.statusCode, 200);
      assert.equal(json(ack).cleared, 1);
      assert.equal(json(await send('GET', '/api/server-info', { cookie })).recoveryNotice, null);
    });

    it('is not shown to a different account', async () => {
      const { codes } = armWithCodes();
      store.users.create('other', PASSWORD);
      await recover(codes[0]);
      const { cookie } = await login('other', PASSWORD);
      assert.equal(json(await send('GET', '/api/server-info', { cookie })).recoveryNotice, null);
    });
  });
});
