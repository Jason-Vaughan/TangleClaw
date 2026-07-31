'use strict';

// POST /api/auth/credential — the only route that changes a login outside first-run
// setup and the terminal recovery tool.
//
// What these tests are really about is REFUSAL. The endpoint's value is not that it
// can write a credential — `PATCH /api/config` could do that, which is the defect
// it replaces — but that it declines whenever nothing is authenticating the caller,
// whenever there is no credential to change, and whenever the change would end at
// "no password". The happy path is the small part.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const caddy = require('../lib/caddy');
const { createServer, _setRestartScheduler } = require('../server');
const { installCaddyStub } = require('./_caddy-stub');

const STUB_HASH = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
const OLD_HASH = '$2b$12$' + 'o'.repeat(53);
const GOOD_PASSWORD = 'a-perfectly-fine-passphrase';

/** Make a JSON request to the test server. */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A live, gated Caddyfile — the only state in which a change is allowed. */
function writeGatedCaddyfile(user = 'jason', hash = OLD_HASH) {
  const p = caddy.getCaddyfilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    'localhost:8443 {',
    '  basic_auth {',
    `    ${user} ${hash}`,
    '  }',
    '  reverse_proxy 127.0.0.1:3102',
    '}',
    ''
  ].join('\n'), { mode: 0o600 });
}

describe('POST /api/auth/credential', () => {
  let server; let tmpDir; let caddyStub;

  before(async () => {
    caddyStub = installCaddyStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-credapi-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    caddyStub.restore();
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const p = caddy.getCaddyfilePath();
    if (fs.existsSync(p)) fs.rmSync(p);
    // The allowed shape, restored per case so a refusal test cannot pass because a
    // previous case left the install in a state that refuses anyway.
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = true;
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();
  });

  describe('the guard — what it will not do', () => {
    it('refuses when nothing is enforcing a login, because nothing authenticated the caller', () => {
      // The #805 shape, from the other direction: on an ungated install there is no
      // perimeter, so this request is anonymous. Writing a credential here would let
      // whoever reaches the box claim it.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      return request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD }).then(({ status, data }) => {
        assert.equal(status, 409);
        assert.equal(data.code, 'NOT_CADDY_MODE');
        assert.equal(store.config.load().basicAuthHash, OLD_HASH, 'nothing may be written');
      });
    });

    it('refuses when config records a credential the live Caddyfile is not applying', async () => {
      // The stored-unconfirmed state. Changing it would report a password change
      // that nothing enforces.
      fs.writeFileSync(caddy.getCaddyfilePath(),
        'localhost:8443 {\n  reverse_proxy 127.0.0.1:3102\n}\n', { mode: 0o600 });
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(status, 409);
      assert.equal(data.code, 'NO_GATE');
      assert.match(data.error, /reset-admin/, 'recovery lives at a terminal');
      assert.equal(store.config.load().basicAuthHash, OLD_HASH);
    });

    it('refuses to CREATE a first credential — that is recovery, not settings', async () => {
      // A dashboard route that creates a gate is the second remote door the
      // Direction forbids: a reset behind the gate cannot help someone the gate has
      // locked out.
      const config = store.config.load();
      config.basicAuthUser = null;
      config.basicAuthHash = null;
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'brand-new', password: GOOD_PASSWORD });
      assert.equal(status, 409);
      assert.equal(data.code, 'NO_CREDENTIAL');
      assert.equal(store.config.load().basicAuthHash, null, 'no credential may appear from here');
    });

    it('has no way to blank the credential — every empty spelling is a validation error', async () => {
      // The Direction allows exactly one route to "no password" and it is not this
      // one. An empty password must read as an invalid password, never as "clear it".
      for (const password of ['', null, undefined]) {
        const { status } = await request(server, 'POST', '/api/auth/credential',
          { user: 'jason', password });
        assert.equal(status, 400, `password ${JSON.stringify(password)} must not blank the login`);
        assert.equal(store.config.load().basicAuthHash, OLD_HASH);
      }
    });

    it('rejects a weak password with the same rules setup uses, not a second set', async () => {
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: 'short' });
      assert.equal(status, 400);
      // Same validator as the wizard: one implementation, so the rules cannot drift
      // between where a password is first set and where it is changed.
      assert.equal(data.error, caddy.validateAdminPassword('short', 'jason').error);
    });
  });

  describe('the change itself', () => {
    it('rewrites the LIVE gate, not just the recorded config', async () => {
      // Config alone would tell the operator their password changed while the old
      // one still opens the dashboard.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const live = fs.readFileSync(caddy.getCaddyfilePath(), 'utf8');
      assert.ok(live.includes(STUB_HASH), 'the Caddyfile must carry the new hash');
      assert.ok(!live.includes(OLD_HASH), 'and must not still carry the old one');
      assert.equal(store.config.load().basicAuthHash, STUB_HASH);
    });

    it('keeps the username in force when only a password is sent', async () => {
      // Making someone retype a username to change a password is how a typo
      // silently becomes a second account.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { password: GOOD_PASSWORD });
      assert.equal(status, 200);
      assert.equal(data.user, 'jason');
      assert.equal(store.config.load().basicAuthUser, 'jason');
    });

    it('says plainly that the operator is about to be signed out', async () => {
      // Caddy reloads with the new hash and basic_auth cannot hand a browser new
      // credentials, so the re-prompt is certain. Unexplained, it reads as a fault.
      const { data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(data.signedOut, true);
    });

    it('never returns the hash it just wrote', async () => {
      const { raw } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.ok(!raw.includes(STUB_HASH), 'a credential hash must not cross the HTTP boundary');
      assert.ok(!raw.includes(GOOD_PASSWORD), 'and neither must the plaintext');
    });
  });

  describe('GET /api/auth/credential — the same answer, before the form is drawn', () => {
    it('reports changeable with the username to prefill, and never the hash', async () => {
      const { status, data } = await request(server, 'GET', '/api/auth/credential');
      assert.equal(status, 200);
      assert.equal(data.changeable, true);
      assert.equal(data.user, 'jason');
      assert.equal('hash' in data, false);
    });

    it('agrees with POST about a machine, so the form is never offered then refused', async () => {
      // The wizard's step list already had to fix exactly this: a client deciding
      // one thing while the server decided another about the same install.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      const get = await request(server, 'GET', '/api/auth/credential');
      const post = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(get.data.changeable, false);
      assert.equal(post.status, 409);
      assert.equal(get.data.code, post.data.code, 'both must name the same reason');
    });

    it('withholds the username when the change is refused', async () => {
      // Nothing here is authenticating the caller in that state, so it must not
      // answer questions about the account either.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      const { data } = await request(server, 'GET', '/api/auth/credential');
      assert.equal(data.user, null);
    });
  });
});

describe('POST /api/auth/credential — fail-closed when Caddy rejects the file', () => {
  let server; let tmpDir; let caddyStub;

  before(async () => {
    // The one suite that needs `caddy validate` to REJECT.
    caddyStub = installCaddyStub({ answersValidate: false });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-credapi-bad-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    caddyStub.restore();
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the gate and leaves the recorded credential where it was', async () => {
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = true;
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();

    const { status, data } = await request(server, 'POST', '/api/auth/credential',
      { user: 'jason', password: GOOD_PASSWORD });

    assert.equal(status, 400);
    assert.equal(data.code, 'VALIDATE_FAILED');
    assert.equal(store.config.load().basicAuthHash, OLD_HASH,
      'config must not record a credential the ingress rejected');
    assert.ok(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8').includes(OLD_HASH),
      'the working gate must be restored');
  });

  it('does not leak the rejected hash through the error message', async () => {
    // `caddy validate` output quotes the offending line, and that line carries a
    // credential. Filtered at the HTTP boundary as well as the log.
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();
    const { raw } = await request(server, 'POST', '/api/auth/credential',
      { user: 'jason', password: GOOD_PASSWORD });
    assert.ok(!raw.includes(STUB_HASH));
    assert.ok(!raw.includes(OLD_HASH));
  });
});
