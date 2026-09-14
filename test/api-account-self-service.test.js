'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const rc = require('../lib/recovery-codes');
const { handleRequest } = require('../server');

// Account self-service (#1457 change password, #1463 sign out everywhere),
// driven through the REAL request handler so the gate, the CSRF check and the
// cookies are exercised together with the routes.

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-long-enough-new-password';

describe('account self-service, end to end (#1457, #1463)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-self-service-'));
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
    setAuthEnabled(false);
  });

  /** @param {boolean} on */
  function setAuthEnabled(on) {
    const cfg = store.config.load();
    cfg.authEnabled = on;
    store.config.save(cfg);
  }

  /**
   * An armed install with one account.
   * @param {string} [name]
   * @returns {object} The user
   */
  function arm(name = 'rosie') {
    const user = store.users.create(name, PASSWORD);
    setAuthEnabled(true);
    return user;
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

  /** Whether a signed-in browser's session still reaches a gated route. */
  async function stillSignedIn(s) {
    const res = await send('GET', '/api/auth/me', { cookie: s.cookie });
    return json(res).authenticated === true;
  }

  const change = (s, body) => send('POST', '/api/auth/password', { cookie: s.cookie, csrf: s.csrf, body });

  describe('POST /api/auth/password', () => {
    it('changes the password, keeps this browser signed in on a NEW session, and ends every other session', async () => {
      arm();
      const here = await login();
      const phone = await login();
      const res = await change(here, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).otherSessionsEnded, 1);
      const renewed = { cookie: cookieOf(res), csrf: json(res).csrfToken };
      assert.match(renewed.cookie, /tc_session=[^;]+/, 'the response sets the replacement session');
      assert.equal(await stillSignedIn(renewed), true, 'the browser that made the change stays signed in');
      assert.equal(await stillSignedIn(here), false,
        'a copy of this browser\'s OLD cookie does not survive the change');
      assert.equal(await stillSignedIn(phone), false, 'every other session is ended');
      const csrfCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('tc_csrf='));
      assert.ok(csrfCookie && csrfCookie.includes(renewed.csrf), 'the page\'s CSRF cookie follows the new session');
      assert.equal((await login('rosie', PASSWORD)).cookie, null, 'the old password no longer signs in');
      assert.ok((await login('rosie', NEW_PASSWORD)).cookie, 'the new one does');
    });

    it('does not end another account\'s sessions', async () => {
      arm();
      store.users.create('sam', PASSWORD);
      const rosie = await login();
      const sam = await login('sam');
      await change(rosie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(await stillSignedIn(sam), true);
    });

    it('refuses a wrong current password with 403 REAUTH_FAILED — never 401, which the page reads as signed out', async () => {
      arm();
      const s = await login();
      const res = await change(s, { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(json(res).code, 'REAUTH_FAILED');
      assert.ok((await login('rosie', PASSWORD)).cookie, 'the password is unchanged');
      assert.equal(await stillSignedIn(s), true);
    });

    it('applies the password policy to the new password, before any hashing', async () => {
      arm();
      const s = await login();
      // Too short, contains the username, and on the denylist.
      for (const weak of ['short', 'my-name-is-rosie-ok', 'password1234']) {
        const res = await change(s, { currentPassword: PASSWORD, newPassword: weak });
        assert.equal(res.statusCode, 400, `${weak}: ${res.body}`);
        assert.equal(json(res).code, 'WEAK_PASSWORD');
      }
      assert.ok((await login('rosie', PASSWORD)).cookie, 'nothing changed');
    });

    it('checks the policy before the current password — a weak new password with a wrong current one is a 400', async () => {
      arm();
      const s = await login();
      const res = await change(s, { currentPassword: 'wrong', newPassword: 'short' });
      assert.equal(res.statusCode, 400);
      assert.equal(json(res).code, 'WEAK_PASSWORD');
    });

    it('answers 400 for missing fields and an empty body', async () => {
      arm();
      const s = await login();
      for (const body of [{}, { currentPassword: PASSWORD }, { newPassword: NEW_PASSWORD }, null]) {
        const res = await change(s, body);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
      }
    });

    it('requires the CSRF token', async () => {
      arm();
      const s = await login();
      const res = await send('POST', '/api/auth/password',
        { cookie: s.cookie, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'CSRF_TOKEN_INVALID');
    });

    it('is challenged by the gate for a signed-out browser', async () => {
      arm();
      const res = await send('POST', '/api/auth/password', { body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
      assert.equal(res.statusCode, 401);
      assert.equal(json(res).code, 'UNAUTHENTICATED');
    });

    it('refuses a local tool with no session, and changes nothing', async () => {
      arm();
      const res = await send('POST', '/api/auth/password',
        { machine: true, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
      assert.equal(res.statusCode, 401, res.body);
      assert.ok((await login('rosie', PASSWORD)).cookie);
    });

    it('says a login is not required on an open install', async () => {
      store.users.create('rosie', PASSWORD);
      const res = await send('POST', '/api/auth/password', { body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'LOGIN_NOT_REQUIRED');
    });

    it('leaves recovery codes working', async () => {
      const user = arm();
      const codes = store.recoveryCodes.replaceForUser(user.id).map(rc.formatCode);
      const s = await login();
      await change(s, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(store.recoveryCodes.status(user.id).remaining, codes.length);
    });

    it('two sessions changing the password at once: one wins, the other is told nothing changed', async () => {
      arm();
      const a = await login();
      const b = await login();
      const [ra, rb] = await Promise.all([
        change(a, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        change(b, { currentPassword: PASSWORD, newPassword: 'another-long-new-password' })
      ]);
      const statuses = [ra.statusCode, rb.statusCode].sort();
      // Both verified the same old password before either wrote; the second
      // write must not overwrite the first. Here the winner's commit also ends
      // the loser's session, so the session re-check is what refuses it; the
      // stored-hash re-check is pinned on its own in the store tests below.
      assert.deepEqual(statuses, [200, 409], `${ra.body} / ${rb.body}`);
      const winner = ra.statusCode === 200 ? NEW_PASSWORD : 'another-long-new-password';
      const loser = json(ra.statusCode === 409 ? ra : rb);
      assert.equal(loser.code, 'PASSWORD_CHANGE_STALE');
      assert.ok((await login('rosie', winner)).cookie, 'the password the winner was told they set is the one stored');
    });

    it('verifies and hashes inside the shared login concurrency cap, after the policy check', () => {
      // One slot for both derivations: the route must not take two.
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const start = src.indexOf("route('POST', '/api/auth/password'");
      const body = src.slice(start, src.indexOf('\n});', start));
      assert.equal(body.split('_withHashSlot(').length - 1, 1, 'exactly one hash slot');
      assert.match(body.slice(body.indexOf('_withHashSlot(')), /^_withHashSlot\([^)]*\n?\s*\(\) => store\.users\.changePasswordFromSession\(/,
        'the store call that verifies and hashes runs inside it');
      assert.ok(body.indexOf('validateAdminPassword(') < body.indexOf('_withHashSlot('),
        'the policy is checked before any hashing');
    });
  });

  describe('store.users.changePasswordFromSession — the re-checks under the lock', () => {
    /** The live session row behind a signed-in browser. */
    const sessionOf = (s) => store.authSessions.resolve(decodeURIComponent(s.cookie.match(/tc_session=([^;]+)/)[1]));

    it('writes nothing when the session was ended between the check and the write', async () => {
      arm();
      const s = await login();
      const row = sessionOf(s);
      store.authSessions.destroyForUser('rosie');
      assert.deepEqual({ ...await store.users.changePasswordFromSession(row, PASSWORD, NEW_PASSWORD) }, { status: 'stale' });
      assert.ok(store.users.verify('rosie', PASSWORD), 'the old password still stands');
    });

    it('writes nothing for a disabled account', async () => {
      arm();
      const s = await login();
      const row = sessionOf(s);
      store.users.disable('rosie');
      assert.equal((await store.users.changePasswordFromSession(row, PASSWORD, NEW_PASSWORD)).status, 'stale');
      store.users.enable('rosie');
      assert.ok(store.users.verify('rosie', PASSWORD));
    });

    it('writes nothing when the stored password changed after it was read', async () => {
      arm();
      const s = await login();
      const row = sessionOf(s);
      const pending = store.users.changePasswordFromSession(row, PASSWORD, NEW_PASSWORD);
      // Lands while the derivations above are off the event loop.
      store.getDb().prepare('UPDATE users SET password_hash = ? WHERE username = ?')
        .run(require('../lib/password').hashPassword('set-by-someone-else-x'), 'rosie');
      assert.equal((await pending).status, 'stale');
      assert.ok(store.users.verify('rosie', 'set-by-someone-else-x'), 'the other change stands');
    });

    it('answers bad-password without writing', async () => {
      arm();
      const s = await login();
      assert.equal((await store.users.changePasswordFromSession(sessionOf(s), 'wrong', NEW_PASSWORD)).status, 'bad-password');
      assert.equal(await stillSignedIn(s), true);
    });
  });

  describe('POST /api/auth/logout-everywhere', () => {
    it('ends every session the account holds, this one included, and clears this browser\'s cookies', async () => {
      arm();
      const here = await login();
      const phone = await login();
      const res = await send('POST', '/api/auth/logout-everywhere', { cookie: here.cookie, csrf: here.csrf });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).sessionsEnded, 2);
      assert.equal(await stillSignedIn(here), false);
      assert.equal(await stillSignedIn(phone), false);
      const cleared = res.headers['set-cookie'].join('\n');
      assert.match(cleared, /tc_session=;/);
      assert.match(cleared, /tc_csrf=;/);
    });

    it('does not touch another account\'s sessions', async () => {
      arm();
      store.users.create('sam', PASSWORD);
      const rosie = await login();
      const sam = await login('sam');
      await send('POST', '/api/auth/logout-everywhere', { cookie: rosie.cookie, csrf: rosie.csrf });
      assert.equal(await stillSignedIn(sam), true);
    });

    it('requires the CSRF token — it is not on the gate\'s exemption list', async () => {
      arm();
      const s = await login();
      const res = await send('POST', '/api/auth/logout-everywhere', { cookie: s.cookie });
      assert.equal(res.statusCode, 403);
      assert.equal(await stillSignedIn(s), true);
    });

    it('is challenged for a signed-out browser, and refuses a local tool with no session', async () => {
      arm();
      const signedOut = await send('POST', '/api/auth/logout-everywhere', { body: {} });
      assert.equal(signedOut.statusCode, 401);
      const tool = await send('POST', '/api/auth/logout-everywhere', { machine: true, body: {} });
      assert.equal(tool.statusCode, 401, tool.body);
    });

    it('says a login is not required on an open install', async () => {
      const res = await send('POST', '/api/auth/logout-everywhere', { body: {} });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'LOGIN_NOT_REQUIRED');
    });
  });
});
