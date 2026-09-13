'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { handleRequest, handleUpgrade } = require('../server');
const authGate = require('../lib/auth-gate');

// The gate and its three routes driven through the REAL request handler.
//
// The module-level tests (`auth-gate.test.js`) prove the rule; these prove the
// WIRING — that the gate is actually reached, on every branch, and that the
// routes set and clear the cookies they claim to. A rule nothing calls is the
// failure mode a pure unit test cannot see.

const PASSWORD = 'correct-horse-battery';

describe('TangleClaw\'s own front door, end to end (#1418)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gate-test-'));
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
    for (const u of store.users.list()) {
      store.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    }
    setAuthEnabled(false);
  });

  /**
   * Write `authEnabled` into the config file the gate reads.
   * @param {boolean} on
   */
  function setAuthEnabled(on) {
    const cfg = store.config.load();
    cfg.authEnabled = on;
    store.config.save(cfg);
  }

  /** Turn the gate on the way an operator does: an account, plus the switch. */
  function armGate() {
    store.users.create('rosie', PASSWORD);
    setAuthEnabled(true);
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
   * Drive one request through the real handler AS A BROWSER.
   *
   * Browser-shaped by default — `Sec-Fetch-Site` present — because the subject
   * of almost every case here is a person at a dashboard, and TangleClaw now
   * treats a loopback request with no browser marker as a MACHINE client (the
   * `tc` CLI, PortHub, the switchboard) and waves it through. Leaving that
   * implicit would have quietly turned every gate assertion below into a test
   * of the carve-out instead. Pass `machine: true` to send the fleet's shape.
   *
   * @param {string} method
   * @param {string} url
   * @param {object} [opts]
   * @param {object} [opts.body] - JSON body
   * @param {string} [opts.cookie] - Cookie header
   * @param {string} [opts.csrf] - X-CSRF-Token header
   * @param {object} [opts.headers] - Extra headers
   * @param {boolean} [opts.machine] - Send no browser markers at all
   * @param {string} [opts.remoteAddress] - Socket address; defaults to loopback
   * @returns {Promise<object>} The mock response
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

  /** Log in and return the cookie header plus csrf token a browser would hold. */
  async function login(username = 'rosie', password = PASSWORD) {
    const res = await send('POST', '/api/auth/login', { body: { username, password } });
    if (res.statusCode !== 200) return { res, cookie: null, csrf: null };
    const setCookies = res.headers['set-cookie'];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    return { res, cookie, csrf: JSON.parse(res.body).csrfToken };
  }

  describe('which state the door is in (#1420)', () => {
    it('lets everything through with authEnabled off and no accounts', () => {
      return send('GET', '/api/config').then((res) => {
        assert.notEqual(res.statusCode, 401);
      });
    });

    it('is CLOSED with authEnabled on but no account — account-required, not dormant', async () => {
      // Every install upgraded from Caddy's gate is authEnabled:true with a
      // bcrypt hash and zero user rows. Leaving that dormant is an open door the
      // moment Caddy's gate is gone.
      setAuthEnabled(true);
      const res = await send('GET', '/api/config');
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /ACCOUNT_REQUIRED/);
    });

    it('answers a page in account-required with the account-setup document, at 401', async () => {
      setAuthEnabled(true);
      const res = await send('GET', '/');
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /Create your account/);
      assert.match(res.headers['cache-control'], /no-store/);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    });

    it('serves the account-setup page at /login while no account exists, and the login form after', async () => {
      setAuthEnabled(true);
      const before = await send('GET', '/login');
      assert.equal(before.statusCode, 200);
      assert.match(before.body, /Create your account/);
      store.users.create('rosie', PASSWORD);
      const after = await send('GET', '/login');
      assert.match(after.body, /Sign in/);
      assert.doesNotMatch(after.body, /Create your account/);
    });

    it('is open with an account but authEnabled off', async () => {
      store.users.create('rosie', PASSWORD);
      const res = await send('GET', '/api/config');
      assert.notEqual(res.statusCode, 401);
    });

    it('goes live once BOTH are true', async () => {
      armGate();
      const res = await send('GET', '/api/config');
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /UNAUTHENTICATED/);
    });

    it('stays CLOSED when the only account is disabled — locked, and no account page', async () => {
      // Disabling the last account used to re-open the install. It now leaves it
      // locked: the recovery is `scripts/reset-admin.js` at a terminal, and the
      // first-account page is NOT offered, because creating an account there
      // would be a way around the one that exists.
      armGate();
      store.users.disable('rosie');
      const api = await send('GET', '/api/config');
      assert.equal(api.statusCode, 401);
      assert.match(api.body, /UNAUTHENTICATED/);
      const page = await send('GET', '/');
      assert.match(page.body, /Sign in/);
      const create = await send('POST', '/api/auth/set-password',
        { body: { username: 'mallory', password: 'a-long-enough-password' } });
      assert.equal(create.statusCode, 401, 'the first-account route is closed once any account exists');
      assert.equal(store.users.getByName('mallory'), null);
    });
  });

  describe('POST /api/auth/set-password — the first account (#1420)', () => {
    beforeEach(() => {
      const cfg = store.config.load();
      cfg.authEnabled = true;
      cfg.basicAuthUser = 'jason';
      cfg.basicAuthHash = '$2a$14$' + 'x'.repeat(53);
      store.config.save(cfg);
    });

    const GOOD = { username: 'jason', password: 'a-long-enough-password' };

    it('creates the account, signs the caller in, and arms the gate', async () => {
      const res = await send('POST', '/api/auth/set-password', { body: GOOD });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(JSON.parse(res.body).username, 'jason');
      const cookies = res.headers['set-cookie'];
      assert.ok(cookies.some((c) => c.startsWith(authSession.SESSION_COOKIE + '=')), 'a session cookie is set');
      const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
      assert.notEqual((await send('GET', '/api/config', { cookie })).statusCode, 401,
        'the new session is live');
      assert.equal((await send('GET', '/api/config')).statusCode, 401, 'the install is now armed');
      const { res: loginRes } = await login('jason', GOOD.password);
      assert.equal(loginRes.statusCode, 200, 'the password set here is the one that signs in');
    });

    it('keeps the bcrypt basicAuthHash — it is the fallback credential, not garbage', async () => {
      const hash = store.config.load().basicAuthHash;
      await send('POST', '/api/auth/set-password', { body: GOOD });
      assert.equal(store.config.load().basicAuthHash, hash);
    });

    it('applies the Caddy password policy, before creating anything', async () => {
      for (const [password, why] of [['short', 'too short'], ['password1234', 'denylisted'],
        ['jason-is-the-best-user', 'contains the username'], ['', 'empty']]) {
        const res = await send('POST', '/api/auth/set-password', { body: { username: 'jason', password } });
        assert.equal(res.statusCode, 400, `${why} must be refused`);
      }
      assert.equal(store.users.list().length, 0, 'no refused submission creates an account');
    });

    it('requires a username', async () => {
      for (const username of ['', '   ', undefined, 7]) {
        const res = await send('POST', '/api/auth/set-password',
          { body: { username, password: GOOD.password } });
        assert.equal(res.statusCode, 400, `username=${JSON.stringify(username)}`);
      }
      assert.equal(store.users.list().length, 0);
    });

    it('answers 400, not 500, to an empty body', async () => {
      const res = await send('POST', '/api/auth/set-password', { body: {} });
      assert.equal(res.statusCode, 400);
    });

    it('cannot create a second account — once one exists the route is closed', async () => {
      assert.equal((await send('POST', '/api/auth/set-password', { body: GOOD })).statusCode, 200);
      const res = await send('POST', '/api/auth/set-password',
        { body: { username: 'mallory', password: 'another-long-password' } });
      assert.equal(res.statusCode, 401, 'the gate no longer exempts the route');
      assert.equal(store.users.getByName('mallory'), null);
    });

    it('refuses with ACCOUNT_EXISTS when an account appears between the gate and the write', async () => {
      // The gate saw account-required; `reset-admin.js` (another process) wins
      // the race. `createFirstAsync`'s own check under the write lock must refuse.
      const orig = store.users.createFirstAsync;
      store.users.createFirstAsync = (u, pw) => {
        store.users.create('raced', 'raced-long-password');
        return orig.call(store.users, u, pw);
      };
      try {
        const res = await send('POST', '/api/auth/set-password', { body: GOOD });
        assert.equal(res.statusCode, 409);
        assert.match(res.body, /ACCOUNT_EXISTS/);
        assert.equal(store.users.getByName('jason'), null);
      } finally {
        store.users.createFirstAsync = orig;
      }
    });

    it('refuses on an open install, and says a login is not required rather than that an account exists', async () => {
      setAuthEnabled(false);
      const res = await send('POST', '/api/auth/set-password', { body: GOOD });
      assert.equal(res.statusCode, 409, 'an open install has no first-account step');
      assert.match(res.body, /LOGIN_NOT_REQUIRED/);
      assert.doesNotMatch(res.body, /already exists/, 'no account exists, so the message must not claim one');
      assert.equal(store.users.list().length, 0);
    });

    it('hashes off the event loop, inside the login route\'s concurrency cap', async () => {
      // Reachable signed-out until the first account exists, so a burst of
      // valid submissions must not each run a synchronous scrypt, and must not
      // occupy more of the threadpool than the login route may. Three at once:
      // two are admitted, the third is turned away busy, and of the two admitted
      // exactly one creates the account.
      const passwordLib = require('../lib/password');
      const realSync = passwordLib.hashPassword;
      let syncCalls = 0;
      passwordLib.hashPassword = function (...args) { syncCalls++; return realSync.apply(this, args); };
      try {
        const results = await Promise.all([1, 2, 3].map((n) =>
          send('POST', '/api/auth/set-password',
            { body: { username: `user${n}`, password: 'a-long-enough-password' } })));
        const statuses = results.map((r) => r.statusCode).sort();
        assert.deepEqual(statuses, [200, 409, 503], `got ${JSON.stringify(statuses)}`);
        assert.equal(syncCalls, 0, 'no synchronous hash on the unauthenticated route');
        assert.equal(store.users.list().length, 1);
      } finally {
        passwordLib.hashPassword = realSync;
      }
    });

    it('is reachable through the proxy — reach authorises it, per ADR 0016', async () => {
      const res = await send('POST', '/api/auth/set-password',
        { body: GOOD, headers: { 'x-forwarded-for': '100.64.0.7' } });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('what a gated install refuses', () => {
    beforeEach(armGate);

    it('answers an unauthenticated API call with 401 JSON', async () => {
      const res = await send('GET', '/api/config');
      assert.equal(res.statusCode, 401);
      assert.match(res.headers['content-type'], /json/);
      assert.match(res.body, /UNAUTHENTICATED/);
    });

    it('answers an unauthenticated page with the login document, at 401', async () => {
      const res = await send('GET', '/');
      assert.equal(res.statusCode, 401, 'a login page served as 200 lies to caches and monitors');
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.body, /Sign in/);
    });

    it('never caches the login page', async () => {
      const res = await send('GET', '/');
      assert.match(res.headers['cache-control'], /no-store/);
    });

    it('refuses to be framed, and loads nothing external', async () => {
      const res = await send('GET', '/');
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    });

    it('gates the proxy prefixes, not just /api/', async () => {
      // `/terminal/*` proxies to a writable ttyd — that socket is a shell.
      for (const p of ['/terminal/x', '/openclaw/proj/api/x', '/plans/p/f.md']) {
        const res = await send('GET', p);
        assert.equal(res.statusCode, 401, `${p} must be gated`);
      }
    });

    it('gates the static assets too', async () => {
      const res = await send('GET', '/app.js');
      assert.equal(res.statusCode, 401);
    });

    it('refuses a garbage session cookie rather than trusting it', async () => {
      const res = await send('GET', '/api/config', {
        cookie: `${authSession.SESSION_COOKIE}=${'f'.repeat(64)}`
      });
      assert.equal(res.statusCode, 401);
    });

    it('still serves the Caddy bypass paths', async () => {
      // These answer for callers that have no credential to offer — a health
      // probe, an anonymous PWA manifest fetch.
      const res = await send('GET', '/api/health');
      assert.notEqual(res.statusCode, 401);
    });

    it('still serves the login page on /login', async () => {
      const res = await send('GET', '/login');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Sign in/);
    });

    it('serves /login even when the gate is open', async () => {
      // So the path does not blink into existence at the moment the gate turns
      // on.
      setAuthEnabled(false);
      const res = await send('GET', '/login');
      assert.equal(res.statusCode, 200);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(armGate);

    it('accepts a correct credential and sets both cookies', async () => {
      const { res } = await login();
      assert.equal(res.statusCode, 200);
      const cookies = res.headers['set-cookie'];
      assert.equal(cookies.length, 2);
      const session = cookies.find((c) => c.startsWith(authSession.SESSION_COOKIE + '='));
      const csrf = cookies.find((c) => c.startsWith(authSession.CSRF_COOKIE + '='));
      assert.match(session, /HttpOnly/, 'the credential cookie must be HttpOnly');
      assert.doesNotMatch(csrf, /HttpOnly/, 'the CSRF cookie must be readable by the page');
    });

    it('omits Secure over plain http', async () => {
      // ADR 0016: a direct-mode install on plain http over the tailnet is
      // supported, and a Secure cookie is silently never stored there.
      const { res } = await login();
      for (const c of res.headers['set-cookie']) assert.doesNotMatch(c, /Secure/);
    });

    it('sets Secure when the request arrived over https', async () => {
      const res = await send('POST', '/api/auth/login', {
        body: { username: 'rosie', password: PASSWORD },
        headers: { 'x-forwarded-proto': 'https' }
      });
      for (const c of res.headers['set-cookie']) assert.match(c, /Secure/);
    });

    it('does not return the password, the hash, or anything but the name and token', async () => {
      const { res } = await login();
      const body = JSON.parse(res.body);
      assert.deepEqual(Object.keys(body).sort(), ['csrfToken', 'username']);
      assert.equal(res.body.includes(PASSWORD), false);
    });

    for (const [label, creds] of [
      ['a wrong password', { username: 'rosie', password: 'wrong' }],
      ['an unknown account', { username: 'nobody', password: PASSWORD }],
      ['a missing password', { username: 'rosie' }],
      ['a missing username', { password: PASSWORD }],
      ['an empty body', {}]
    ]) {
      it(`refuses ${label} with 401 and no cookie`, async () => {
        const res = await send('POST', '/api/auth/login', { body: creds });
        assert.equal(res.statusCode, 401);
        assert.equal(res.headers['set-cookie'], undefined);
      });
    }

    it('refuses a bodyless POST without throwing', async () => {
      const res = await send('POST', '/api/auth/login');
      assert.equal(res.statusCode, 401);
    });

    it('gives every failure the SAME message and code', async () => {
      // The store equalises the TIMING of the three failure modes; saying which
      // one happened in the BODY would hand back the username oracle that
      // equalisation exists to deny. One refusal, one wording.
      const bodies = [];
      for (const creds of [
        { username: 'rosie', password: 'wrong' },
        { username: 'nobody', password: PASSWORD },
        { username: 'rosie', password: '' }
      ]) {
        const res = await send('POST', '/api/auth/login', { body: creds });
        bodies.push(res.body);
      }
      assert.equal(new Set(bodies).size, 1, `refusals differ: ${bodies.join(' | ')}`);
    });

    it('refuses a disabled account', async () => {
      store.users.create('ex', PASSWORD);
      store.users.disable('ex');
      const res = await send('POST', '/api/auth/login', {
        body: { username: 'ex', password: PASSWORD }
      });
      assert.equal(res.statusCode, 401);
    });

    it('still works for a browser that already holds a live session', async () => {
      // Switching accounts, or a cookie that outlived the page. The login form
      // posts no CSRF header, so without login's CSRF exemption this is a 403
      // on the one page someone visits when something is already wrong.
      const first = await login();
      const again = await send('POST', '/api/auth/login', {
        body: { username: 'rosie', password: PASSWORD },
        cookie: first.cookie
      });
      assert.equal(again.statusCode, 200);
    });

    it('rotates the session: a pre-login cookie is destroyed, not adopted', async () => {
      // Session fixation. An attacker who plants a cookie must not end up
      // holding a live session after the victim signs in.
      const planted = await login();
      const second = await send('POST', '/api/auth/login', {
        body: { username: 'rosie', password: PASSWORD },
        cookie: planted.cookie
      });
      const newToken = second.headers['set-cookie']
        .find((c) => c.startsWith(authSession.SESSION_COOKIE + '='))
        .split('=')[1].split(';')[0];
      const oldToken = planted.cookie
        .split('; ').find((c) => c.startsWith(authSession.SESSION_COOKIE + '='))
        .split('=')[1];
      assert.notEqual(newToken, oldToken, 'a fresh token must be minted');
      assert.equal(store.authSessions.resolve(oldToken), null,
        'the session the request arrived with must be destroyed');
    });
  });

  describe('POST /api/auth/login in-flight cap (#1419)', () => {
    // The pool the verifications run on is shared with fs and dns, so an
    // unbounded burst of anonymous logins starves the whole server. The stub
    // holds each verification open until the case releases it, which is the
    // only way to put requests genuinely IN FLIGHT at the same time.
    let realVerify;
    let pending;

    beforeEach(() => {
      store.users.create('rosie', PASSWORD);
      realVerify = store.users.verifyAsync;
      pending = [];
      store.users.verifyAsync = (username, password) => new Promise((resolve, reject) => {
        pending.push({ release: () => realVerify.call(store.users, username, password).then(resolve, reject),
          fail: () => reject(new Error('scrypt exploded')) });
      });
    });

    const restore = () => { store.users.verifyAsync = realVerify; };
    const tick = () => new Promise((r) => setImmediate(r));

    it('refuses with 503 and Retry-After once two verifications are in flight', async () => {
      try {
        const first = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        const second = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        await tick();
        assert.equal(pending.length, 2, 'precondition: both verifications are running');
        const thirdP = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        await tick();
        // Checked BEFORE awaiting the third response: without the cap it would
        // be parked in the stub, and awaiting it would hang instead of failing.
        assert.equal(pending.length, 2, 'the third request must not have started a verification');
        const third = await thirdP;
        assert.equal(third.statusCode, 503);
        assert.equal(third.headers['retry-after'], '1');
        assert.match(third.body, /LOGIN_BUSY/);
        pending.forEach((p) => p.release());
        assert.equal((await first).statusCode, 200);
        assert.equal((await second).statusCode, 200);
      } finally {
        // Release anything still parked, so a failed assertion cannot leave a
        // request pending and hang the file instead of reporting.
        pending.forEach((p) => p.release());
        restore();
      }
    });

    it('frees the slot when a verification completes', async () => {
      try {
        const a = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        const b = send('POST', '/api/auth/login', { body: { username: 'rosie', password: 'wrong-password-xx' } });
        await tick();
        pending.forEach((p) => p.release());
        await a; await b;
        const c = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        await tick();
        assert.equal(pending.length, 3, 'a new verification must be admitted');
        pending[2].release();
        assert.equal((await c).statusCode, 200);
      } finally {
        pending.forEach((p) => p.release());
        restore();
      }
    });

    it('frees the slot when a verification THROWS — no leaked slot, no permanent refusal', async () => {
      try {
        for (let i = 0; i < 2; i++) {
          const r = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
          await tick();
          pending[pending.length - 1].fail();
          await r;
        }
        const next = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        await tick();
        assert.equal(pending.length, 3, 'two thrown verifications must not have used up the cap');
        pending[2].release();
        assert.equal((await next).statusCode, 200);
      } finally {
        pending.forEach((p) => p.release());
        restore();
      }
    });

    it('does not count a malformed request against the cap', async () => {
      try {
        const a = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        const b = send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
        await tick();
        const bad = await send('POST', '/api/auth/login', { body: { username: '' } });
        assert.equal(bad.statusCode, 401, 'refused as a bad credential, not as busy');
        pending.forEach((p) => p.release());
        await a; await b;
      } finally {
        pending.forEach((p) => p.release());
        restore();
      }
    });
  });

  describe('an authenticated session', () => {
    beforeEach(armGate);

    it('reaches a gated API route', async () => {
      const { cookie } = await login();
      const res = await send('GET', '/api/config', { cookie });
      assert.notEqual(res.statusCode, 401);
    });

    it('reaches a gated page', async () => {
      const { cookie } = await login();
      const res = await send('GET', '/', { cookie });
      assert.notEqual(res.statusCode, 401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('reports not-authenticated and not-gated on an open install', async () => {
      const res = await send('GET', '/api/auth/me');
      assert.equal(res.statusCode, 200, 'no login required IS a successful answer');
      assert.deepEqual(JSON.parse(res.body), {
        authenticated: false, gateActive: false, gateState: 'open', username: null, csrfToken: null
      });
    });

    it('reports the session when signed in', async () => {
      armGate();
      const { cookie, csrf } = await login();
      const res = await send('GET', '/api/auth/me', { cookie });
      assert.deepEqual(JSON.parse(res.body), {
        authenticated: true, gateActive: true, gateState: 'armed', username: 'rosie', csrfToken: csrf
      });
    });

    it('tells a signed-out caller the install needs an account', async () => {
      setAuthEnabled(true);
      const res = await send('GET', '/api/auth/me');
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).gateState, 'account-required');
    });

    it('never leaks a password hash', async () => {
      // ADR 0016 records that `users.getByName` returns the hash, so this route
      // must build its answer from the SESSION. The assertion is on the hash
      // itself so a future refactor that reaches for the row goes red.
      armGate();
      const { cookie } = await login();
      const row = store.users.getByName('rosie');
      assert.ok(row.password_hash, 'precondition: the row carries a hash');
      const res = await send('GET', '/api/auth/me', { cookie });
      assert.equal(res.body.includes(row.password_hash), false);
      assert.equal(JSON.parse(res.body).password_hash, undefined);
    });
  });

  describe('POST /api/auth/logout', () => {
    beforeEach(armGate);

    it('destroys the session server-side, not just in the browser', async () => {
      const { cookie, csrf } = await login();
      const token = cookie.split('; ')
        .find((c) => c.startsWith(authSession.SESSION_COOKIE + '='))
        .split('=')[1];
      const res = await send('POST', '/api/auth/logout', { cookie, csrf });
      assert.equal(res.statusCode, 200);
      assert.equal(store.authSessions.resolve(token), null);
    });

    it('clears both cookies with matching attributes', async () => {
      const { cookie, csrf } = await login();
      const res = await send('POST', '/api/auth/logout', { cookie, csrf });
      const cleared = res.headers['set-cookie'];
      assert.equal(cleared.length, 2);
      for (const c of cleared) {
        assert.match(c, /Max-Age=0/);
        assert.match(c, /Path=\//, 'without Path=/ the real cookie survives below the root');
      }
    });

    it('answers 200 with no session at all', async () => {
      const res = await send('POST', '/api/auth/logout');
      assert.equal(res.statusCode, 200);
    });

    it('is CSRF-checked despite being an exempt path', async () => {
      // The reason the gate evaluates CSRF ahead of its allow-list. Without
      // that ordering any page on the internet could sign the operator out.
      const { cookie } = await login();
      const res = await send('POST', '/api/auth/logout', { cookie });
      assert.equal(res.statusCode, 403);
      assert.match(res.body, /CSRF_TOKEN_INVALID/);
    });
  });

  describe('CSRF on a gated install', () => {
    beforeEach(armGate);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`refuses ${method} from a session with no token`, async () => {
        const { cookie } = await login();
        const res = await send(method, '/api/config', { cookie, body: { logLevel: 'info' } });
        assert.equal(res.statusCode, 403);
        assert.match(res.body, /CSRF_TOKEN_INVALID/);
      });
    }

    it('refuses a WRONG token', async () => {
      const { cookie } = await login();
      const res = await send('PATCH', '/api/config', {
        cookie, csrf: 'f'.repeat(64), body: { logLevel: 'info' }
      });
      assert.equal(res.statusCode, 403);
    });

    it('refuses ANOTHER session\'s token', async () => {
      // Double-submit's residual, closed: the comparison is against the token
      // stored on THIS session's row, not against whatever the caller echoed.
      const a = await login();
      const b = await login();
      const res = await send('PATCH', '/api/config', {
        cookie: a.cookie, csrf: b.csrf, body: { logLevel: 'info' }
      });
      assert.equal(res.statusCode, 403);
    });

    it('accepts the session\'s own token', async () => {
      const { cookie, csrf } = await login();
      const res = await send('PATCH', '/api/config', {
        cookie, csrf, body: { logLevel: 'info' }
      });
      assert.notEqual(res.statusCode, 403);
    });

    it('does not apply to a GET', async () => {
      const { cookie } = await login();
      const res = await send('GET', '/api/config', { cookie });
      assert.notEqual(res.statusCode, 403);
    });

    it('does not apply to a request with NO session — curl and the agent API', async () => {
      // A request carrying no session rides no ambient authority, so it is not
      // a CSRF vector. On loopback it is also not GATED (see the fleet block
      // below); what this pins is that it is never refused FOR CSRF.
      const res = await send('PATCH', '/api/config', { machine: true, body: { logLevel: 'info' } });
      assert.doesNotMatch(res.body, /CSRF/, 'a sessionless write is never a CSRF failure');
    });
  });

  describe('the gate fails CLOSED on a corrupt config — through the PRODUCTION thunk', () => {
    // `resolveGateState` answers `unreadable` only when its config thunk
    // THROWS, so a caller routing it through a loader that swallows failures
    // into `null` would make that branch unreachable and read a corrupt file as
    // "not enforcing". A synthesized `() => { throw }` cannot catch that; this
    // corrupts the actual file and drives `handleRequest`, so nothing between
    // the disk and the verdict is imagined.
    beforeEach(armGate);

    it('challenges a browser when config.json is present but unparseable', async () => {
      const armed = await send('GET', '/api/config');
      assert.equal(armed.statusCode, 401, 'precondition: the gate is armed');

      const cfgPath = store._getConfigPath();
      const good = fs.readFileSync(cfgPath, 'utf8');
      // Written with a different byte length AND a new mtime, so the cache key
      // genuinely changes — a fixture that left either alone would be served
      // the cached verdict and prove nothing.
      fs.writeFileSync(cfgPath, '{ this is not json at all, at all }');
      try {
        const res = await send('GET', '/api/config');
        assert.equal(res.statusCode, 401,
          'an armed install must stay gated when its config cannot be read');
      } finally {
        fs.writeFileSync(cfgPath, good);
      }
    });

    it('enforces on an unreadable config even on an install with NO account and no prior request', async () => {
      // The fail-closed answer is no longer conditional on the gate having been
      // armed in this process: with Caddy's gate gone, an unreadable config on a
      // fresh process is the same bypass as on a warm one.
      store.getDb().prepare('DELETE FROM users').run();
      const cfgPath = store._getConfigPath();
      const good = fs.readFileSync(cfgPath, 'utf8');
      fs.writeFileSync(cfgPath, '{ not json, and not the same length as before }');
      try {
        const res = await send('GET', '/api/config');
        assert.equal(res.statusCode, 401);
      } finally {
        fs.writeFileSync(cfgPath, good);
      }
    });

    it('also stays gated when config.json is MISSING, not just unparseable', async () => {
      // Pinned because it is a CHOICE and not an accident of an unguarded stat.
      // `store.config.load()` answers a missing file with DEFAULT_CONFIG, whose
      // authEnabled is false — so honouring it would mean deleting one file
      // silently un-gates the install.
      const armed = await send('GET', '/api/config');
      assert.equal(armed.statusCode, 401, 'precondition: the gate is armed');

      const cfgPath = store._getConfigPath();
      const good = fs.readFileSync(cfgPath, 'utf8');
      fs.unlinkSync(cfgPath);
      try {
        const res = await send('GET', '/api/config');
        assert.equal(res.statusCode, 401,
          'deleting the config must not un-gate an armed install');
      } finally {
        fs.writeFileSync(cfgPath, good);
      }
    });

    it('does not PIN the failure verdict — the recovery lever still works after one', async () => {
      // The other half: fail-closed must not be sticky. The cache keys on
      // mtime+size, so what this proves is that a cached refusal does not
      // outlive the corrupt file — it restores the file AND flips authEnabled,
      // because that switch is the documented way out and it is the thing that
      // must still work.
      await send('GET', '/api/config');
      const cfgPath = store._getConfigPath();
      const good = fs.readFileSync(cfgPath, 'utf8');
      fs.writeFileSync(cfgPath, '{ broken');
      await send('GET', '/api/config');
      fs.writeFileSync(cfgPath, good);
      setAuthEnabled(false);
      const res = await send('GET', '/api/config');
      assert.notEqual(res.statusCode, 401,
        'authEnabled:false must still be the recovery lever after a read failure');
    });
  });

  describe('the fleet keeps working when the gate is armed', () => {
    // The defect this block exists for: the gate sits ahead of
    // `serviceToken.requiresServiceToken`, so without a carve-out the moment an
    // operator runs `reset-admin.js --store` every machine caller of the
    // loopback listener gets 401 — `bin/tc`, the PortHub surface every project
    // on this machine leases through, shared-docs, and the switchboard. A valid
    // AUTH-4 token does not rescue them: the session gate answers first.
    beforeEach(armGate);

    // `machine: true` drops every browser marker, which — together with the
    // loopback socket `send` already uses — is exactly the shape `bin/tc` has.
    const FLEET_READS = [
      ['the tc CLI', '/api/tc/whoami', { 'x-tangleclaw-cli': '1', 'x-tangleclaw-verb': 'whoami' }],
      ['PortHub', '/api/ports', {}],
      ['shared docs', '/api/shared-docs', {}]
    ];

    for (const [who, url, headers] of FLEET_READS) {
      it(`${who} is not refused by the session gate`, async () => {
        const res = await send('GET', url, { headers, machine: true });
        assert.notEqual(res.statusCode, 401,
          `${url} must not be refused for want of a session`);
        assert.doesNotMatch(res.body || '', /UNAUTHENTICATED/);
      });
    }

    it('a machine WRITE is allowed without a CSRF token', async () => {
      // PortHub leasing is a POST, and no CLI can hold a CSRF token.
      const res = await send('POST', '/api/ports/lease', {
        machine: true,
        body: { port: 4999, project: 'fleet-test', service: 'suite' }
      });
      assert.notEqual(res.statusCode, 401);
      assert.notEqual(res.statusCode, 403);
    });

    it('a BROWSER-shaped loopback request is still gated', async () => {
      // The carve-out must not become a way for a page to walk through the
      // door. A browser cannot suppress Sec-Fetch-Site from script.
      const res = await send('GET', '/api/config', { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(res.statusCode, 401, 'a browser on loopback is still a browser');
    });

    it('an Origin header alone is enough to make it browser-shaped', async () => {
      const res = await send('GET', '/api/config', { headers: { origin: 'http://localhost:3102' } });
      assert.equal(res.statusCode, 401);
    });

    it('a request carrying a session cookie is NOT treated as a machine client', async () => {
      // Otherwise a signed-in browser could drop Sec-Fetch-Site and escape the
      // CSRF check by being mistaken for the CLI.
      const { cookie } = await login();
      const res = await send('PATCH', '/api/config', { cookie, body: { logLevel: 'info' } });
      assert.equal(res.statusCode, 403, 'the CSRF check must still apply');
      assert.match(res.body, /CSRF_TOKEN_INVALID/);
    });

    it('a NON-loopback request is gated, machine-shaped or not', async () => {
      const res = await send('GET', '/api/config', { machine: true, remoteAddress: '10.0.0.5' });
      assert.equal(res.statusCode, 401, 'the carve-out is local processes only');
    });

    it('a loopback request that came THROUGH THE PROXY is gated, machine-shaped or not', async () => {
      // Caddy connects from loopback and sends no browser markers for a
      // non-browser client, so without the X-Forwarded-For condition an off-box
      // `curl` forwarded by Caddy would be waved through as the fleet.
      for (const xff of ['100.64.0.7', '']) {
        const res = await send('GET', '/api/config',
          { machine: true, headers: { 'x-forwarded-for': xff } });
        assert.equal(res.statusCode, 401, `x-forwarded-for=${JSON.stringify(xff)} must be gated`);
      }
    });

    it('the proxied request to /openclaw-direct/* is gated — the #1419 residual', async () => {
      const res = await send('GET', '/openclaw-direct/abc/chat',
        { machine: true, headers: { 'x-forwarded-for': '100.64.0.7' } });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('the WebSocket upgrade (#1419)', () => {
    // `handleRequest` never sees an upgrade, so everything above says nothing
    // about this path. `/terminal/*` proxies to a --writable ttyd: a shell.
    //
    // `net.connect` is replaced for the duration of each case, and it is the
    // assertion that matters: "refused BEFORE the socket exists" means the
    // upstream connection was never opened, which a check on the client socket
    // alone cannot show — the unknown-connection branches destroy that socket
    // too, so a destroyed socket is green with the gate deleted.
    let realConnect;
    let connects;

    beforeEach(() => {
      realConnect = net.connect;
      connects = [];
      net.connect = (...args) => {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const upstream = new PassThrough();
        upstream.written = '';
        upstream.write = (chunk) => { upstream.written += String(chunk); return true; };
        connects.push({ args, upstream });
        // Async, as a real connect is: the branch assigns `proxySocket` from
        // the return value before its callback may reference it.
        if (cb) process.nextTick(cb);
        return upstream;
      };
    });

    // `after`-style restore per case, so a failing assertion cannot leave the
    // stub installed for the rest of the file.
    const restore = () => { net.connect = realConnect; };

    /**
     * Drive one upgrade through the real `handleUpgrade`.
     * @param {string} url
     * @param {object} [opts]
     * @param {string} [opts.cookie]
     * @param {string|null} [opts.origin] - Defaults to a same-host browser Origin; null sends none
     * @param {string} [opts.host]
     * @param {string} [opts.remoteAddress]
     * @returns {Promise<{written: string, destroyed: boolean}>}
     */
    async function upgrade(url, opts = {}) {
      const headers = {
        host: opts.host || 'localhost:3102',
        upgrade: 'websocket', connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13'
      };
      const origin = opts.origin === undefined ? 'http://localhost:3102' : opts.origin;
      if (origin !== null) headers.origin = origin;
      if (opts.cookie) headers.cookie = opts.cookie;
      Object.assign(headers, opts.headers);
      const socket = new PassThrough();
      socket.remoteAddress = opts.remoteAddress || '127.0.0.1';
      socket.written = '';
      socket.destroyed = false;
      const origDestroy = socket.destroy.bind(socket);
      socket.destroy = () => { socket.destroyed = true; origDestroy(); };
      const origEnd = socket.end.bind(socket);
      socket.end = (chunk, cb) => { if (chunk) socket.written += String(chunk); return origEnd(cb); };
      handleUpgrade({ url, method: 'GET', headers, socket }, socket, Buffer.alloc(0));
      await new Promise((r) => setImmediate(r));
      return socket;
    }

    const REFUSED = /^HTTP\/1\.1 401 Unauthorized\r\n/;

    describe('with the gate armed', () => {
      beforeEach(armGate);

      for (const url of ['/terminal/ws', '/openclaw/proj/ws', '/openclaw-direct/c1/ws']) {
        it(`refuses an unauthenticated browser upgrade to ${url} before any upstream socket`, async () => {
          try {
            const s = await upgrade(url);
            assert.match(s.written, REFUSED);
            assert.equal(connects.length, 0, 'no upstream connection may be opened');
            assert.equal(s.destroyed, true);
          } finally { restore(); }
        });
      }

      it('opens the terminal for a live session, with our cookies stripped from what ttyd receives', async () => {
        try {
          const { cookie } = await login();
          const s = await upgrade('/terminal/ws', { cookie: `ttyd_pref=1; ${cookie}` });
          assert.doesNotMatch(s.written, REFUSED);
          assert.equal(connects.length, 1, 'the ttyd connection must be opened');
          const sent = connects[0].upstream.written;
          assert.match(sent, /^GET \/ws HTTP\/1\.1\r\n/);
          assert.match(sent, /\r\ncookie: ttyd_pref=1\r\n/);
          assert.equal(sent.includes(authSession.SESSION_COOKIE), false,
            'the session cookie must not reach a --writable ttyd');
          assert.equal(sent.includes(authSession.CSRF_COOKIE), false);
        } finally { restore(); }
      });

      it('opens /openclaw-direct for a live session, token injected and our cookies stripped', async () => {
        try {
          const conn = store.openclawConnections.create({
            name: 'ws-gate-test', host: 'gw.example', sshUser: 'u', sshKeyPath: '/k',
            gatewayToken: 'gw-token-1419', localPort: 18999
          });
          const { cookie } = await login();
          const s = await upgrade(`/openclaw-direct/${conn.id}/ws`, { cookie });
          assert.doesNotMatch(s.written, REFUSED);
          assert.equal(connects.length, 1);
          assert.deepEqual(connects[0].args, [18999, '127.0.0.1']);
          const sent = connects[0].upstream.written;
          assert.match(sent, /\r\nauthorization: Bearer gw-token-1419\r\n/);
          assert.equal(/\r\ncookie:/i.test(sent), false, 'only our cookies were sent, so none may remain');
        } finally { restore(); }
      });

      it('refuses /openclaw-direct WITHOUT a session even for a real connection — the token is injected by us', async () => {
        // The test that makes the exemption decision visible: this connection
        // resolves, so without the gate the upstream would open and TangleClaw
        // would hand the gateway its token on an anonymous caller's behalf.
        try {
          const conn = store.openclawConnections.create({
            name: 'ws-gate-test-2', host: 'gw.example', sshUser: 'u', sshKeyPath: '/k',
            gatewayToken: 'gw-token-1419', localPort: 18998
          });
          const s = await upgrade(`/openclaw-direct/${conn.id}/ws`);
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('refuses a garbage session cookie', async () => {
        try {
          const s = await upgrade('/terminal/ws', { cookie: `${authSession.SESSION_COOKIE}=${'f'.repeat(64)}` });
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('refuses when the session lookup THROWS — fail closed on the path to a shell', async () => {
        const realResolve = store.authSessions.resolve;
        try {
          const { cookie } = await login();
          store.authSessions.resolve = () => { throw new Error('SQLITE_BUSY'); };
          const s = await upgrade('/terminal/ws', { cookie });
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally {
          store.authSessions.resolve = realResolve;
          restore();
        }
      });

      it('still destroys a CROSS-SITE upgrade that carries a valid session — the Origin guard runs first', async () => {
        // The cookie rides the attack too, so the session gate must not be what
        // decides it: the guard refuses silently, before any 401 is written.
        try {
          const { cookie } = await login();
          const s = await upgrade('/terminal/ws', { cookie, origin: 'https://evil.example' });
          assert.equal(s.destroyed, true);
          assert.equal(s.written, '', 'refused by the Origin guard, not by the session gate');
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('still destroys a REBOUND upgrade (#864) that carries a valid session', async () => {
        try {
          const { cookie } = await login();
          const s = await upgrade('/terminal/ws', {
            cookie, host: 'evil.example:3102', origin: 'http://evil.example:3102'
          });
          assert.equal(s.destroyed, true);
          assert.equal(s.written, '');
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('lets the fleet\'s shape through, by the same carve-out HTTP uses', async () => {
        // Loopback, no Origin, no Sec-Fetch-Site, no cookie. Deliberate, and
        // bounded the way the HTTP carve-out is — see lib/auth-gate.js.
        try {
          const s = await upgrade('/terminal/ws', { origin: null });
          assert.doesNotMatch(s.written, REFUSED);
          assert.equal(connects.length, 1);
        } finally { restore(); }
      });

      it('refuses a machine-shaped upgrade that came through the proxy', async () => {
        try {
          const s = await upgrade('/terminal/ws', { origin: null, headers: { 'x-forwarded-for': '100.64.0.7' } });
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('refuses a machine-shaped upgrade from OFF the box', async () => {
        try {
          const s = await upgrade('/terminal/ws', { origin: null, remoteAddress: '10.0.0.5' });
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('refuses a cookie-bearing, Origin-less loopback upgrade whose session is dead', async () => {
        // A cookie makes it a person, not the fleet — dropping Origin must not
        // turn an expired session into a machine client.
        try {
          const s = await upgrade('/terminal/ws', {
            origin: null, cookie: `${authSession.SESSION_COOKIE}=${'a'.repeat(64)}`
          });
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });
    });

    it('a refused socket carries an error listener, so a client reset cannot throw out of the listener', async () => {
      // A raw socket with no 'error' listener turns an ECONNRESET during the
      // 401 write into an uncaught exception in the server's 'upgrade' handler.
      try {
        armGate();
        const s = await upgrade('/terminal/ws');
        assert.match(s.written, REFUSED);
        assert.ok(s.listenerCount('error') > 0, 'the refusal path must attach an error listener');
        assert.doesNotThrow(() => s.emit('error', new Error('ECONNRESET')));
      } finally { restore(); }
    });

    it('closes the terminal socket, rather than throwing, when config cannot be read', async () => {
      // The gate reads config first and answers `unreadable`, which enforces —
      // but this upgrade has the fleet's shape, so the carve-out lets it through
      // and the terminal branch is the next thing to read config. An unguarded
      // throw there escapes the 'upgrade' listener and leaves the client's
      // socket half-open.
      const cfgPath = store._getConfigPath();
      const saved = fs.readFileSync(cfgPath, 'utf8');
      try {
        fs.writeFileSync(cfgPath, '{ this is not json');
        let s;
        assert.doesNotThrow(() => { s = upgrade('/terminal/ws', { origin: null }); });
        s = await s;
        assert.equal(s.destroyed, true, 'the client socket must be closed');
        assert.equal(connects.length, 0, 'no ttyd target can be named without config');
      } finally {
        fs.writeFileSync(cfgPath, saved);
        restore();
      }
    });

    describe('while no account exists (account-required)', () => {
      it('refuses a browser upgrade — nobody can hold a session yet', async () => {
        try {
          setAuthEnabled(true); // the upgraded-install shape: switch on, zero accounts
          const s = await upgrade('/terminal/ws');
          assert.match(s.written, REFUSED);
          assert.equal(connects.length, 0);
        } finally { restore(); }
      });

      it('still lets the fleet\'s shape through', async () => {
        try {
          setAuthEnabled(true);
          const s = await upgrade('/terminal/ws', { origin: null });
          assert.doesNotMatch(s.written, REFUSED);
          assert.equal(connects.length, 1);
        } finally { restore(); }
      });
    });
  });

  describe('the WebSocket refusal over a REAL socket (#1419)', () => {
    // Every other upgrade case drives a PassThrough, which cannot show what a
    // client actually receives on the wire. This one uses a listening server and
    // a real HTTP client.
    beforeEach(armGate);

    it('a real client receives HTTP/1.1 401 and the connection closes', async () => {
      const http = require('node:http');
      const server = http.createServer(handleRequest);
      server.on('upgrade', handleUpgrade);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      try {
        const raw = await new Promise((resolve, reject) => {
          const sock = net.createConnection(port, '127.0.0.1', () => {
            sock.write('GET /terminal/ws HTTP/1.1\r\nHost: localhost:3102\r\n'
              + `Origin: http://localhost:3102\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
              + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
          });
          let got = '';
          sock.on('data', (d) => { got += d; });
          sock.on('close', () => resolve(got));
          sock.on('error', reject);
          sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('connection was not closed')); });
        });
        assert.match(raw, /^HTTP\/1\.1 401 Unauthorized\r\n/);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  describe('/openclaw-direct/* over HTTP (#1419)', () => {
    beforeEach(armGate);

    it('is gated for a browser with no session — its exemption is Caddy\'s, not the gate\'s', async () => {
      const res = await send('GET', '/openclaw-direct/c1/chat?session=main');
      assert.equal(res.statusCode, 401);
    });

    it('is gated on a normalisation variant too', async () => {
      const res = await send('GET', '//openclaw-direct/c1/chat');
      assert.equal(res.statusCode, 401);
    });

    it('reaches the proxy for a live session', async () => {
      const { cookie } = await login();
      const res = await send('GET', '/openclaw-direct/nonexistent/chat', { cookie });
      // Unknown connection → the proxy's own 404, which proves the gate let it through.
      assert.equal(res.statusCode, 404);
      assert.match(res.body, /OpenClaw connection not found/);
    });
  });
  // #918. The peer reachability read carries a session's wake verdict, so it
  // must sit behind exactly the door the roster sits behind. Asserted as
  // PARITY with the roster for every caller shape, on both mounts, so a future
  // exemption for one route that skips the other shows up here as a mismatch.
  describe('the peer read sits behind the roster\'s door (#918)', () => {
    const MOUNTS = [
      ['/api/sessions/no-such-project/medusa/roster', '/api/sessions/no-such-project/medusa/peers/some-peer-1234abcd'],
      ['/api/master/medusa/roster', '/api/master/medusa/peers/some-peer-1234abcd']
    ];

    it('refuses a browser with no session exactly as the roster is refused', async () => {
      armGate();
      for (const [roster, peers] of MOUNTS) {
        const r = await send('GET', roster);
        const p = await send('GET', peers);
        assert.equal(r.statusCode, 401, `precondition: ${roster} is gated`);
        assert.equal(p.statusCode, r.statusCode, `${peers} answers as ${roster} does`);
      }
    });

    it('refuses a machine-shaped caller from off the host exactly as the roster is refused', async () => {
      armGate();
      for (const [roster, peers] of MOUNTS) {
        const r = await send('GET', roster, { machine: true, remoteAddress: '10.0.0.5' });
        const p = await send('GET', peers, { machine: true, remoteAddress: '10.0.0.5' });
        assert.equal(r.statusCode, 401, `precondition: ${roster} refuses a remote machine caller`);
        assert.equal(p.statusCode, r.statusCode);
      }
    });

    it('lets through exactly who the roster lets through — a signed-in browser and a loopback machine client', async () => {
      armGate();
      const { cookie } = await login();
      // The project mount only: past the door the Master mount probes tmux, and
      // a live Master on a developer box would make this read the real host.
      // The door itself is path-blind, which the two refusal cases above pin
      // on both mounts.
      for (const [roster, peers] of MOUNTS.slice(0, 1)) {
        for (const opts of [{ cookie }, { machine: true }]) {
          const r = await send('GET', roster, opts);
          const p = await send('GET', peers, opts);
          assert.notEqual(r.statusCode, 401, `precondition: ${roster} admits ${JSON.stringify(Object.keys(opts))}`);
          assert.equal(p.statusCode, r.statusCode, `${peers} past the door answers as ${roster} does`);
        }
      }
    });
  });
});
