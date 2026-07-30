'use strict';

// AUTH-2 slice 2b — forced first-run admin in caddy ingress mode. Exercises the
// server-side gate end to end: /api/setup/complete and the PATCH /api/config
// "Skip" path both refuse to finish setup behind the Caddy ingress without an
// admin credential, and a valid credential is validated, bcrypt-hashed (via a
// stubbed `caddy hash-password`), and persisted.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const caddy = require('../lib/caddy');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');

setLevel('error');

/**
 * Make a JSON HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, data: any }>}
 */
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
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Write a `caddy` stub that satisfies hash-password (bcrypt-shaped output, read
 * from stdin) so the admin happy-path is hermetic without a real Caddy.
 * @param {string} stubDir
 */
function writeCaddyStub(stubDir, opts = {}) {
  // `version` is opt-in. The default stub deliberately FAILS it, so most of this
  // suite runs as "caddy not installed" — which is what makes its no-credential
  // cases legitimate rather than a hole. One case needs the opposite and says so.
  const versionCase = opts.answersVersion
    ? `  version)
    echo 'v2.8.4 h1:stub'
    exit 0
    ;;
`
    : '';
  const script = `#!/bin/bash
case "$1" in
${versionCase}  hash-password)
    read -r pw
    echo '\$2a\$14\$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU'
    exit 0
    ;;
esac
echo "caddy stub: unknown args: $*" >&2
exit 1
`;
  fs.writeFileSync(path.join(stubDir, 'caddy'), script, { mode: 0o755 });
}

describe('forced first-run admin credential', () => {
  let tmpDir;
  let server;
  let origPath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-auth2-'));
    const stubDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    writeCaddyStub(stubDir);
    origPath = process.env.PATH;
    process.env.PATH = stubDir + path.delimiter + (origPath || '');

    store._setBasePath(tmpDir);
    store.init();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Reset config to a fresh, incomplete state with the given ingress mode. */
  function resetConfig(ingressMode) {
    const config = store.config.load();
    config.setupComplete = false;
    config.ingressMode = ingressMode;
    config.authEnabled = false;
    config.basicAuthUser = null;
    config.basicAuthHash = null;
    store.config.save(config);
  }

  describe('POST /api/setup/complete', () => {
    beforeEach(() => resetConfig('caddy'));

    it('rejects completion in caddy mode with no admin configured', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('rejects a too-short admin password (no hashing attempted)', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'short' });
      assert.equal(status, 400);
      assert.match(data.error, /at least 12/);
      assert.equal(store.config.load().setupComplete, false);
    });

    it('rejects a missing adminUser when a password is given', async () => {
      const { status } = await request(server, 'POST', '/api/setup/complete',
        { adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 400);
    });

    it('rejects a password containing the username', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'jason', adminPassword: 'jasons-long-password' });
      assert.equal(status, 400);
      assert.match(data.error, /username/);
    });

    it('validates, hashes, and persists a valid admin credential', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete',
        { adminUser: 'admin', adminPassword: 'a-strong-passphrase-42' });
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
      // The warning tells the operator the live config was not changed; the command
      // that changes it comes from `ingress.remedy`, which is state-specific. A fixed
      // command in the warning was the bare `--to caddy` form — the one the cutover
      // refuses on the hand-edited Caddyfile every path to this state has.
      assert.ok(data.warnings.some((w) => /cannot confirm anything is enforcing/.test(w)),
        'the operator must still learn nothing is known to be enforcing the login');
      assert.ok(!data.warnings.some((w) => /ingress-cutover/.test(w)),
        'the warning must not name a command the cutover would refuse');
      // This suite's caddy stub deliberately fails `version`, so this assertion runs on
      // a machine with NO Caddy — where claiming the Caddyfile governs protection would
      // be a false reassurance about a file nothing is serving.
      assert.ok(!data.warnings.some((w) => /that file already makes it/.test(w)),
        'the warning must not name the Caddyfile as what determines protection');
      // Every path that reaches this warning must still leave one actionable step.
      assert.ok(data.ingress.remedy && data.ingress.remedy.trim().length > 0,
        'a screen carrying this warning must offer a next step');

      const config = store.config.load();
      assert.equal(config.authEnabled, true);
      assert.equal(config.basicAuthUser, 'admin');
      assert.match(config.basicAuthHash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
      assert.equal(config.setupComplete, true);
    });

    it('accepts completion when an admin is already configured (no new credential)', async () => {
      const config = store.config.load();
      config.authEnabled = true;
      config.basicAuthUser = 'admin';
      config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
      store.config.save(config);

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
    });
  });

  describe('POST /api/setup/complete — direct mode, with no Caddy to run a gate', () => {
    beforeEach(() => resetConfig('direct'));

    // Direct mode is NO LONGER what makes a credential optional (#710): setup now
    // demands one whenever the machine can actually run a login gate, in either
    // ingress mode. What makes it optional here is this suite's caddy stub, which
    // answers `hash-password` and nothing else — so `caddy version` fails and
    // detection reports the binary as absent. Demanding a password with nothing
    // to enforce it would strand the operator, so completion is allowed and the
    // install finishes honestly ungated.
    //
    // The other half of that rule — direct mode WITH caddy present must refuse —
    // is in test/setup-provisioning.test.js, which does not shadow the binary.
    // Read this case as "no enforcer, no demand", never as "direct mode is exempt".
    it('completes without an admin, because no gate could be put up at all', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
      assert.equal(store.config.load().authEnabled, false);
      // Pin the REASON, so this case cannot start passing because the demand was
      // dropped rather than because there is nothing to enforce it.
      assert.equal(data.ingress.action, 'refuse');
      assert.match(data.ingress.reason, /not installed/);
      assert.equal(data.ingress.protection, 'none');
    });
  });

  describe('PATCH /api/config — Skip path', () => {
    it('refuses setupComplete=true in caddy mode without an admin', async () => {
      resetConfig('caddy');
      const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 400);
      assert.equal(data.code, 'ADMIN_REQUIRED');
      assert.equal(store.config.load().setupComplete, false);
    });

    it('allows setupComplete=true only because no gate can be put up here', async () => {
      // Direct mode is NOT what makes Skip permissible (#710). This suite's caddy
      // stub answers `hash-password` and nothing else, so `caddy version` fails and
      // detection reports the binary absent — there is nothing to enforce a
      // credential with, so finishing is allowed and the install is honestly
      // ungated.
      //
      // The previous version of this case was titled "allows setupComplete=true in
      // direct mode" and stood as evidence for exactly the hole #710 closed: on a
      // real fresh install (direct mode, caddy PRESENT) Skip finished setup with no
      // login. The companion case below covers that.
      resetConfig('direct');
      const { status } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
      assert.equal(store.config.load().setupComplete, true);
    });

    it('refuses Skip on a direct-mode install that CAN run a gate', async () => {
      // The default fresh install: direct mode, caddy installed. Skip is the other
      // route that can finish setup, so it has to answer to the same rule as
      // /api/setup/complete or it is a way past the login gate.
      //
      // Depends on a stub that answers `version`, NOT on finding a real caddy in
      // /opt/homebrew or /usr/local: CI runs ubuntu-latest with no Caddy, so a
      // real-binary lookup made the regression guard for the most important fix in
      // this chunk skip exactly where it needed to run. The guard has to be
      // deterministic on every machine, or it is not a guard.
      resetConfig('direct');
      const presentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-caddy-present-'));
      writeCaddyStub(presentDir, { answersVersion: true });
      const origPath = process.env.PATH;
      process.env.PATH = presentDir + path.delimiter + (origPath || '');
      try {
        assert.equal(caddy.detectCaddy().available, true, 'the stub must read as an installed caddy');
        const { status, data } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
        assert.equal(status, 400);
        assert.equal(data.code, 'ADMIN_REQUIRED');
        assert.equal(store.config.load().setupComplete, false, 'a refused Skip must not finish setup');
      } finally {
        process.env.PATH = origPath;
        fs.rmSync(presentDir, { recursive: true, force: true });
      }
    });

    it('allows an unrelated PATCH in caddy mode without an admin (only blocks the complete transition)', async () => {
      resetConfig('caddy');
      const { status } = await request(server, 'PATCH', '/api/config', { chimeEnabled: false });
      assert.equal(status, 200);
    });
  });
});
