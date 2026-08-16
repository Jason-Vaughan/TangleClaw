'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');

setLevel('error');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API endpoints', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-'));
    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // #710 — the server owns the network-binding classification and ships it as
  // `bindState`. The frontend renders that and derives nothing. These are live
  // HTTP assertions on purpose: the frontend guards are source-greps, so
  // reverting the two server call sites left every one of them green while the
  // settings modal fell back to `{}` — rendering a grace install's switch OFF
  // over a wide-open socket, with the keep-open button gone. That is the exact
  // defect the chunk exists to prevent, reachable by deleting one expression.
  describe('bindState on the config API (#710)', () => {
    it('GET /api/config carries the server-resolved bind state', async () => {
      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.ok(data.bindState, 'the classification must reach the client');
      assert.equal(data.bindState.setting, 'bindAllInterfaces');
      assert.equal(typeof data.bindState.wide, 'boolean');
      assert.equal(typeof data.bindState.lockedByCaddy, 'boolean');
      assert.ok(['opted-in', 'closed', 'unchosen'].includes(data.bindState.choice));
    });

    it('PATCH /api/config returns it too, so the control re-renders from the server', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { chimeMuted: false });
      assert.equal(status, 200);
      assert.ok(data.config.bindState, 'the PATCH response must carry it as well');
    });
  });

  // The wizard warns an operator BEFORE they point the product at a directory it
  // may not be able to read (#859). Which directories those are is a fact about
  // the machine TangleClaw runs on, and the browser cannot answer it: the browser
  // may be a phone, where `navigator.platform` would report iOS about a Mac and
  // the one warning that matters would never appear. So the server ships it,
  // exactly as it ships `bindState` above.
  describe('protectedRoots on the config API (#859)', () => {
    it('GET /api/config carries the roots this machine protects', async () => {
      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.protectedRoots),
        'always an array, so the client never special-cases a missing field');

      if (process.platform === 'darwin') {
        // Both forms: the `~` an operator types and the absolute path it
        // resolves to. Shipping only one leaves the other silently unmatched.
        assert.ok(data.protectedRoots.includes('~/Documents'));
        assert.ok(data.protectedRoots.includes('~/Desktop'));
        assert.ok(data.protectedRoots.includes('~/Downloads'));
        assert.ok(data.protectedRoots.some(r => r.startsWith('/') && r.endsWith('/Documents')),
          'the absolute form must be there too');
      } else {
        assert.deepEqual(data.protectedRoots, [],
          'no other platform has this behaviour, and a caution that fires where it '
          + 'does not apply is one people learn to ignore');
      }
    });
  });

  describe('bindState edge cases (#710)', () => {
    it('reports wide + unchosen for an install that predates the setting', async () => {
      // The population this whole mechanism exists for. If the API reports
      // `closed` here, the settings modal draws a shut door over an open one.
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
      const saved = raw.bindAllInterfaces;
      delete raw.bindAllInterfaces;
      raw.ingressMode = 'direct';
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(raw));
      try {
        const { data } = await request(server, 'GET', '/api/config');
        assert.equal(data.bindState.choice, 'unchosen');
        assert.equal(data.bindState.wide, true, 'a legacy install is still bound wide, deliberately');
        assert.equal(data.bindState.grace, true);
      } finally {
        raw.bindAllInterfaces = saved;
        fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(raw));
      }
    });

    it('reports closed once the operator has chosen', async () => {
      await request(server, 'PATCH', '/api/config', { bindAllInterfaces: false });
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.bindState.choice, 'closed');
      assert.equal(data.bindState.wide, false);
      assert.equal(data.bindState.grace, false);
    });
  });

  describe('GET /api/health', () => {
    it('should return 200 with service status', async () => {
      const { status, data } = await request(server, 'GET', '/api/health');
      assert.equal(status, 200);
      assert.ok(data.status, 'Should have status field');
      assert.ok(data.version, 'Should have version field');
      assert.equal(typeof data.uptime, 'number');
      assert.ok(data.services, 'Should have services object');
      assert.equal(data.services.database, 'ok');
    });

    it('should include tmux status', async () => {
      const { data } = await request(server, 'GET', '/api/health');
      assert.ok(['ok', 'unavailable'].includes(data.services.tmux));
    });
  });

  describe('GET /api/version', () => {
    it('should return version', async () => {
      const { status, data } = await request(server, 'GET', '/api/version');
      assert.equal(status, 200);
      const expected = require('../version.json').version;
      assert.equal(data.version, expected);
    });
  });

  describe('GET /api/config', () => {
    it('should return config with password redacted', async () => {
      // Set a password first
      const config = store.config.load();
      config.deletePassword = 'secret';
      store.config.save(config);

      const { status, data } = await request(server, 'GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(data.serverPort, 3101);
      assert.equal(data.deleteProtected, true);
      assert.equal(data.deletePassword, undefined, 'Password should not be exposed');
    });

    it('should return deleteProtected false when no password', async () => {
      const config = store.config.load();
      config.deletePassword = null;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should include all expected fields', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(typeof data.serverPort, 'number');
      assert.equal(typeof data.ttydPort, 'number');
      assert.equal(typeof data.defaultEngine, 'string');
      assert.ok(Array.isArray(data.quickCommands));
      assert.equal(typeof data.theme, 'string');
      assert.equal(typeof data.chimeEnabled, 'boolean');
      assert.equal(typeof data.chimeMuted, 'boolean');
      assert.equal(typeof data.portScannerEnabled, 'boolean');
      assert.equal(typeof data.portScannerIntervalMs, 'number');
    });
  });

  describe('PATCH /api/config', () => {
    it('should update config fields', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'light',
        chimeEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.theme, 'light');
      assert.equal(data.config.chimeEnabled, false);
    });

    it('should set requiresRestart when port changes', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 9999
      });
      assert.equal(data.requiresRestart, true);

      // Reset port
      await request(server, 'PATCH', '/api/config', { serverPort: 3101 });
    });

    it('should reject invalid theme', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        theme: 'neon'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject invalid peekMode', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        peekMode: 'popup'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric port', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        serverPort: 'abc'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should redact password in response', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', {
        deletePassword: 'newsecret'
      });
      assert.equal(data.config.deleteProtected, true);
      assert.equal(data.config.deletePassword, undefined);
    });

    it('should hash password before persisting', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: 'hashme'
      });
      const config = store.config.load();
      assert.ok(config.deletePassword.includes(':'), 'Password should be stored as salt:hash');
      assert.notEqual(config.deletePassword, 'hashme', 'Password should not be stored in plaintext');
    });

    it('should allow clearing password with null', async () => {
      await request(server, 'PATCH', '/api/config', {
        deletePassword: null
      });
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.deleteProtected, false);
    });

    it('should reject empty body', async () => {
      const { status } = await request(server, 'PATCH', '/api/config');
      assert.equal(status, 400);
    });

    // #247 — stripAiCoauthors field. Boolean validation + persistence.
    it('should accept stripAiCoauthors boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        stripAiCoauthors: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.stripAiCoauthors, false);
      // Restore default
      await request(server, 'PATCH', '/api/config', { stripAiCoauthors: true });
    });

    it('should reject non-boolean stripAiCoauthors', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        stripAiCoauthors: 'yes'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /stripAiCoauthors must be a boolean/);
    });

    it('should default stripAiCoauthors to true on GET when unset', async () => {
      // The DEFAULT_CONFIG sets stripAiCoauthors: true; a fresh config
      // (or any patched config that doesn't explicitly include the field)
      // must surface as true.
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.stripAiCoauthors, true,
        'default ON — Critic-driven default to make the security default safe');
    });

    it('should accept chimeMuted boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: true
      });
      assert.equal(status, 200);
      assert.equal(data.config.chimeMuted, true);
    });

    it('should reject non-boolean chimeMuted', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        chimeMuted: 'yes'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept portScannerEnabled boolean', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerEnabled, false);
    });

    it('should reject non-boolean portScannerEnabled', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerEnabled: 1
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept valid portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 30000
      });
      assert.equal(status, 200);
      assert.equal(data.config.portScannerIntervalMs, 30000);
    });

    it('should reject portScannerIntervalMs below minimum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 5000
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject portScannerIntervalMs above maximum', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 999999
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject non-numeric portScannerIntervalMs', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        portScannerIntervalMs: 'fast'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    // AUTH-1 (#395) — ingress topology flag
    it('should default ingressMode to direct', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.ingressMode, 'direct');
    });

    it('should accept ingressMode=caddy', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ingressMode: 'caddy'
      });
      assert.equal(status, 200);
      assert.equal(data.config.ingressMode, 'caddy');
      // restore default for later tests
      await request(server, 'PATCH', '/api/config', { ingressMode: 'direct' });
    });

    it('should reject an unknown ingressMode', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        ingressMode: 'nginx'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept a string publicDomain and normalize empty string to null', async () => {
      let res = await request(server, 'PATCH', '/api/config', { publicDomain: 'tc.example.com' });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.publicDomain, 'tc.example.com');
      res = await request(server, 'PATCH', '/api/config', { publicDomain: '' });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.publicDomain, null);
    });

    it('should reject a non-string, non-null publicDomain', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        publicDomain: 42
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should accept valid caddy ports and default them to 8443/8080', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.caddyHttpsPort, 8443);
      assert.equal(data.caddyHttpPort, 8080);
      const res = await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 443, caddyHttpPort: 80 });
      assert.equal(res.status, 200);
      assert.equal(res.data.config.caddyHttpsPort, 443);
      assert.equal(res.data.config.caddyHttpPort, 80);
      await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 8443, caddyHttpPort: 8080 });
    });

    it('should reject a non-integer caddy port', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', { caddyHttpsPort: 8443.5 });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('should reject a caddy port out of range', async () => {
      for (const bad of [0, 70000, 'eighty']) {
        const { status } = await request(server, 'PATCH', '/api/config', { caddyHttpPort: bad });
        assert.equal(status, 400, `port ${bad} should be rejected`);
      }
    });

    // AUTH-2 (Path A) — basic_auth gate config. A real bcrypt hash fixture
    // (caddy hash-password output) so the bcrypt-shape guard is exercised honestly.
    const BCRYPT = '$2a$14$0Eq3PY/I86yjD0yXuZNv3eKbNXqSyeO911yQE8qvUKFVE/f0SjEWW';

    it('should default authEnabled false, basicAuthUser null, and never expose the hash', async () => {
      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.authEnabled, false);
      assert.equal(data.basicAuthUser, null);
      assert.equal(data.basicAuthConfigured, false);
      assert.equal('basicAuthHash' in data, false); // redacted — credential hash never leaves the server
    });

    // These six previously pinned PATCH /api/config WRITING the credential. That
    // capability is gone, so the contract is replaced rather than deleted — and
    // the replacement is strictly stronger: it asserted which writes were allowed,
    // this asserts that none are. The route authenticates nobody and had no
    // lifecycle gate, so on an ungated, network-reachable install an
    // unauthenticated caller could set an admin credential and lock the owner out.

    it('refuses every credential field, individually', async () => {
      for (const body of [
        { authEnabled: true },
        { basicAuthUser: 'attacker' },
        { basicAuthHash: BCRYPT }
      ]) {
        const { status, data } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 409, `${Object.keys(body)[0]} must be refused here`);
        assert.equal(data.code, 'CREDENTIAL_ROUTE_MOVED');
      }
    });

    it('refuses a WELL-FORMED bcrypt hash too — the objection is the route, not the shape', async () => {
      // The old guard rejected plaintext and accepted a real hash. That is exactly
      // backwards for this defect: a valid hash from an unauthenticated caller is
      // the attack, not the mistake.
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        basicAuthUser: 'attacker', basicAuthHash: BCRYPT, authEnabled: true
      });
      assert.equal(status, 409);
      assert.equal(data.code, 'CREDENTIAL_ROUTE_MOVED');
      assert.equal(store.config.load().basicAuthHash, null, 'nothing may be persisted');
      assert.equal(store.config.load().basicAuthUser, null);
      assert.equal(store.config.load().authEnabled, false);
    });

    it('names both ways to actually change it, since refusing without one is a dead end', async () => {
      const { data } = await request(server, 'PATCH', '/api/config', { basicAuthUser: 'jason' });
      assert.match(data.error, /\/api\/auth\/credential/, 'the settings route');
      assert.match(data.error, /reset-admin/, 'and the terminal recovery tool');
    });

    it('refuses the WHOLE patch, so an unrelated field does not slip through beside it', async () => {
      // Atomicity matters here: applying the harmless half of a rejected body would
      // report partial success as success, and the caller has no way to tell which
      // half took.
      const before = store.config.load().theme;
      const nextTheme = before === 'light' ? 'dark' : 'light';
      const { status } = await request(server, 'PATCH', '/api/config',
        { theme: nextTheme, basicAuthUser: 'attacker' });
      assert.equal(status, 409);
      assert.equal(store.config.load().theme, before, 'the unrelated field must not have applied');
    });

    it('still refuses when a credential field is explicitly null or empty', async () => {
      // The blanking route. `null` reads as "clear it", which the Direction forbids
      // from a settings surface: it would be a second way to reach "no password".
      for (const body of [{ basicAuthUser: null }, { basicAuthHash: '' }, { authEnabled: false }]) {
        const { status } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 409, `${JSON.stringify(body)} must not be a way to blank the login`);
      }
    });

    it('leaves the config API redacting the hash exactly as before', async () => {
      // Asserted with a hash ACTUALLY PRESENT. Both surviving versions of this
      // check ran against a null one, where `'basicAuthHash' in data` is false
      // and `basicAuthConfigured` is false whether or not the redaction line
      // exists — so deleting the redaction would have leaked a real hash past a
      // green suite. The fixture has to contain the thing being redacted.
      const stored = store.config.load();
      const had = stored.basicAuthHash;
      stored.basicAuthHash = BCRYPT;
      store.config.save(stored);
      try {
        const { data } = await request(server, 'GET', '/api/config');
        assert.equal('basicAuthHash' in data, false, 'the hash must not be a field');
        assert.ok(!JSON.stringify(data).includes(BCRYPT),
          'and must not appear anywhere in the response, under any key');
        assert.equal(data.basicAuthConfigured, true, 'only the boolean crosses the boundary');
      } finally {
        const back = store.config.load();
        back.basicAuthHash = had;
        store.config.save(back);
      }
    });

    it('still saves an unrelated field when the stored config is half-credentialed', async () => {
      // A both-or-neither check used to run here and reject the whole request when
      // config held authEnabled=true with no credential. Once the credential fields
      // left this route, no request could CREATE that state — the check could only
      // fire on a config that arrived broken, and there it rejected a theme change
      // with an instruction to send credential fields this same route refuses. An
      // error with no exit. The invariant now lives where the fields are written.
      const stored = store.config.load();
      const restore = {
        authEnabled: stored.authEnabled,
        basicAuthUser: stored.basicAuthUser,
        basicAuthHash: stored.basicAuthHash
      };
      stored.authEnabled = true;
      stored.basicAuthUser = null;
      stored.basicAuthHash = null;
      store.config.save(stored);

      try {
        const before = store.config.load().theme;
        const nextTheme = before === 'light' ? 'dark' : 'light';
        const { status } = await request(server, 'PATCH', '/api/config', { theme: nextTheme });
        assert.equal(status, 200, 'an unrelated write must not be held hostage by a state it cannot fix');
        assert.equal(store.config.load().theme, nextTheme);
      } finally {
        store.config.save({ ...store.config.load(), ...restore });
      }
    });
  });

  describe('PATCH /api/config HTTPS cert validation', () => {
    const { execSync } = require('node:child_process');
    let fixtureDir;
    let certPath;
    let keyPath;
    let hasOpenssl;

    before(() => {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-patch-https-'));
      certPath = path.join(fixtureDir, 'cert.pem');
      keyPath = path.join(fixtureDir, 'key.pem');
      try {
        execSync(
          `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 30 -nodes -subj "/CN=localhost"`,
          { stdio: 'ignore', timeout: 10000 }
        );
        hasOpenssl = true;
      } catch {
        hasOpenssl = false;
      }
    });

    after(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      // Reset HTTPS fields so later tests start clean
      const config = store.config.load();
      config.httpsEnabled = false;
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);
    });

    it('should reject enabling HTTPS with a missing cert file', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: '/tmp/tc-no-such-cert-' + Date.now() + '.pem',
        httpsKeyPath: '/tmp/tc-no-such-key-' + Date.now() + '.pem'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /HTTPS cert validation failed/);
    });

    it('should reject enabling HTTPS with only one cert path set', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: ''
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /Both httpsCertPath and httpsKeyPath are required/);
    });

    it('should accept enabling HTTPS with a valid cert pair', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: keyPath
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.config.httpsEnabled, true);
      assert.equal(data.requiresRestart, true);
    });

    it('should allow enabling HTTPS with no cert paths (graceful HTTP fallback)', async () => {
      // Existing installs upgrading to DEFAULT_CONFIG.httpsEnabled=true without certs
      // must not be blocked here — createServer() logs and falls back to HTTP.
      // Clear cert fields first so the validator sees the "no paths" case.
      const config = store.config.load();
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);

      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('should normalize empty-string cert paths to null (shape parity with /api/setup/complete)', async () => {
      const config = store.config.load();
      config.httpsCertPath = null;
      config.httpsKeyPath = null;
      store.config.save(config);

      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      const saved = store.config.load();
      assert.equal(saved.httpsCertPath, null);
      assert.equal(saved.httpsKeyPath, null);
    });

    it('should accept null for httpsCertPath/httpsKeyPath to clear them', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: null,
        httpsKeyPath: null
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const saved = store.config.load();
      assert.equal(saved.httpsCertPath, null);
      assert.equal(saved.httpsKeyPath, null);
    });

    it('should allow disabling HTTPS even when cert paths remain set', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      // Simulate user turning HTTPS off without clearing paths — validator must not run.
      const config = store.config.load();
      config.httpsEnabled = true;
      config.httpsCertPath = certPath;
      config.httpsKeyPath = keyPath;
      store.config.save(config);

      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.config.httpsEnabled, false);
    });

    it('should reject enabling HTTPS when cert exists but key is missing (asymmetric failure)', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: certPath,
        httpsKeyPath: '/tmp/tc-no-such-key-' + Date.now() + '.pem'
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /HTTPS cert validation failed/);
    });
  });

  describe('config migration defaults', () => {
    it('should default chimeMuted to false for existing configs', async () => {
      const config = store.config.load();
      delete config.chimeMuted;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.chimeMuted, false);
    });

    it('should default portScannerEnabled to true for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerEnabled;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerEnabled, true);
    });

    it('should default portScannerIntervalMs to 60000 for existing configs', async () => {
      const config = store.config.load();
      delete config.portScannerIntervalMs;
      store.config.save(config);

      const { data } = await request(server, 'GET', '/api/config');
      assert.equal(data.portScannerIntervalMs, 60000);
    });
  });

  describe('error handling', () => {
    it('should return 404 for unknown API routes', async () => {
      const { status, data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('should return standard error format', async () => {
      const { data } = await request(server, 'GET', '/api/nonexistent');
      assert.equal(typeof data.error, 'string');
      assert.equal(typeof data.code, 'string');
    });

    it('should reject oversized bodies', async () => {
      const largeBody = { data: 'x'.repeat(11 * 1024) };
      const { status, data } = await request(server, 'PATCH', '/api/config', largeBody);
      assert.equal(status, 413);
      assert.equal(data.code, 'BODY_TOO_LARGE');
    });
  });

  // Project Master settings — merge-then-validate whole-object semantics.
  describe('PATCH /api/config { master }', () => {
    it('accepts a valid patch and stores the full normalized shape', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      assert.equal(status, 200);
      assert.deepEqual(store.config.load().master, {
        // #756 added launchMode to the normalized shape. It is stored on every
        // write, not only when patched, so the block never carries a missing
        // field for `_buildLaunchCommand` to receive as undefined.
        accessLevel: 'read-only', engine: null, launchMode: 'default', scope: 'all', autoStart: true
      });
    });

    it('a partial patch merges onto current settings instead of wiping fields', async () => {
      await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      const { status } = await request(server, 'PATCH', '/api/config', { master: { engine: 'claude' } });
      assert.equal(status, 200);
      const saved = store.config.load().master;
      assert.equal(saved.engine, 'claude');
      assert.equal(saved.autoStart, true, 'earlier field must survive the second patch');
    });

    it('ships launchMode in the DEFAULT master block, before any PATCH (#756)', async () => {
      // The whole point of the DEFAULT_CONFIG entry: `GET /api/config` and
      // `GET /api/master/status` must agree on an install nobody has PATCHed.
      // Every other assertion here reads the block AFTER a patch, and
      // `validateMasterPatch` sources the field from `masterSettings()`, which
      // defaults it independently — so deleting the default would leave all of
      // them green while the two endpoints disagreed.
      const master = require('../lib/master');
      assert.equal(store.DEFAULT_CONFIG.master.launchMode, 'default',
        'a never-PATCHed install must carry launchMode, not omit it');
      // The invariant the default exists for, asserted as an agreement rather
      // than as the constant's shape: what `GET /api/config` would report and
      // what `masterSettings` (behind `GET /api/master/status`) reports must be
      // the same value on an install nobody has touched.
      assert.equal(
        store.DEFAULT_CONFIG.master.launchMode,
        master.masterSettings({}).launchMode,
        'config default and master-status default must not disagree'
      );
    });

    it('stores a launch mode (#756)', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { launchMode: 'acceptEdits' } });
      assert.equal(status, 200);
      assert.equal(store.config.load().master.launchMode, 'acceptEdits');
    });

    it('accepts a mode the CURRENT engine cannot honor, and keeps it stored', async () => {
      // Deliberate: validation is by name, not against whichever engine happens
      // to be resolved at the moment of the PATCH. The operator may switch
      // engines back, and `_masterRuntime` reconciles at launch. Rejecting here
      // would make the setting's validity depend on unrelated state.
      const { status } = await request(server, 'PATCH', '/api/config', {
        master: { engine: 'aider', launchMode: 'acceptEdits' }
      });
      assert.equal(status, 200);
      assert.equal(store.config.load().master.launchMode, 'acceptEdits',
        'the stored preference survives an engine that cannot honor it');
    });

    it('rejects a launch mode no engine defines, naming the valid set', async () => {
      const { status, data } = await request(server, 'PATCH', '/api/config', {
        master: { launchMode: 'ludicrous-speed' }
      });
      assert.equal(status, 400);
      assert.match(data.error, /master\.launchMode must be one of/);
      assert.match(data.error, /default/, 'the honest set must name at least the universal mode');
    });

    it('does not reject an unrelated patch over a stored mode gone unhonorable', async () => {
      // `knownLaunchModes()` is the union across INSTALLED engines, so
      // uninstalling one shrinks it. Validating the MERGED value would then
      // 400 every master PATCH on the install — including ones that only
      // toggle autoStart — over a stored mode the operator never touched.
      const config = store.config.load();
      config.master = { ...config.master, launchMode: 'mode-from-a-since-removed-engine' };
      store.config.save(config);
      const { status } = await request(server, 'PATCH', '/api/config', { master: { autoStart: true } });
      assert.equal(status, 200, 'a patch that does not touch launchMode must not be judged on it');
      assert.equal(store.config.load().master.autoStart, true);
    });

    it('rejects a non-string launch mode', async () => {
      const { status } = await request(server, 'PATCH', '/api/config', { master: { launchMode: 7 } });
      assert.equal(status, 400);
    });

    it('rejects not-yet-enforced access levels with an honest reason', async () => {
      for (const level of ['suggest', 'write']) {
        const { status, data } = await request(server, 'PATCH', '/api/config', { master: { accessLevel: level } });
        assert.equal(status, 400);
        assert.match(data.error, /structural enforcement/);
      }
      const unknown = await request(server, 'PATCH', '/api/config', { master: { accessLevel: 'root' } });
      assert.equal(unknown.status, 400);
    });

    it('rejects unknown fields, unconfigured engines, missing groups, and bad shapes', async () => {
      const cases = [
        { master: { sneaky: true } },
        { master: { engine: 'no-such-engine' } },
        { master: { scope: { type: 'group', groupId: 'no-such-group' } } },
        { master: { scope: 'some-string' } },
        { master: { autoStart: 'yes' } },
        { master: 'read-only' },
        { master: ['read-only'] }
      ];
      for (const body of cases) {
        const { status } = await request(server, 'PATCH', '/api/config', body);
        assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
    });

    it('accepts a group scope for a real group', async () => {
      const group = store.projectGroups.create({ name: 'master-scope-group' });
      const { status } = await request(server, 'PATCH', '/api/config', {
        master: { scope: { type: 'group', groupId: group.id } }
      });
      assert.equal(status, 200);
      assert.deepEqual(store.config.load().master.scope, { type: 'group', groupId: group.id });
    });
  });
});
