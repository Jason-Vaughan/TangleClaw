'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const { handleRequest } = require('../server');

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

  describe('the gate is dormant until an operator turns it on', () => {
    it('lets everything through with authEnabled off and no accounts', () => {
      return send('GET', '/api/config').then((res) => {
        assert.notEqual(res.statusCode, 401);
      });
    });

    it('is STILL dormant with authEnabled on but no account', async () => {
      // The decision that keeps this change from locking the operator out of
      // the live install: every caddy-mode install is authEnabled:true with a
      // bcrypt hash and zero user rows.
      setAuthEnabled(true);
      const res = await send('GET', '/api/config');
      assert.notEqual(res.statusCode, 401,
        'an install with no account must not be gated — it has no key');
    });

    it('is dormant with an account but authEnabled off', async () => {
      store.users.create('rosie', PASSWORD);
      const res = await send('GET', '/api/config');
      assert.notEqual(res.statusCode, 401);
    });

    it('goes live once BOTH are true', async () => {
      armGate();
      const res = await send('GET', '/api/config');
      assert.equal(res.statusCode, 401);
    });

    it('goes dormant again when the only account is disabled', async () => {
      // The recovery path that does not need a shell: an operator whose gate is
      // misbehaving can disable the account and get back in.
      armGate();
      store.users.disable('rosie');
      const res = await send('GET', '/api/config');
      assert.notEqual(res.statusCode, 401);
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

    it('serves /login even when the gate is dormant', async () => {
      // So the path does not blink into existence at the moment the gate turns
      // on, and an operator who has not created an account gets an honest page
      // rather than a 404.
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
        authenticated: false, gateActive: false, username: null, csrfToken: null
      });
    });

    it('reports the session when signed in', async () => {
      armGate();
      const { cookie, csrf } = await login();
      const res = await send('GET', '/api/auth/me', { cookie });
      assert.deepEqual(JSON.parse(res.body), {
        authenticated: true, gateActive: true, username: 'rosie', csrfToken: csrf
      });
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

  describe('an armed gate fails CLOSED on a corrupt config — through the PRODUCTION thunk', () => {
    // The first version of this guard was unreachable, and the suite could not
    // see it: `isGateActive`'s fail-closed branch waits for its config thunk to
    // THROW, while the real caller routed through a loader that swallowed every
    // failure into `null` — so a corrupt config.json on an armed install read
    // as "not enforcing", got cached on mtime+size, and re-served. An
    // authentication bypass for as long as the file stayed unreadable.
    //
    // The old test synthesized `() => { throw }`, an input the real caller
    // could not produce. This one corrupts the actual file and drives
    // `handleRequest`, so nothing between the disk and the verdict is
    // imagined.
    beforeEach(armGate);

    it('challenges a browser when config.json is present but unparseable', async () => {
      // Arm it for real first: the fail-closed answer is deliberately
      // conditional on this process having served a gated request.
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

    it('and recovers on the very next request once the file is readable again', async () => {
      // The other half: fail-closed must not be sticky, or fixing the file
      // would not fix the install.
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
  });
});
