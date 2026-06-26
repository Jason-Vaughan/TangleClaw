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
function writeCaddyStub(stubDir) {
  const script = `#!/bin/bash
case "$1" in
  hash-password)
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

describe('AUTH-2 — forced first-run admin (caddy mode)', () => {
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
      // Warning steers the operator to run the cutover to activate the live gate.
      assert.ok(data.warnings.some((w) => /ingress-cutover/.test(w)));

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

  describe('POST /api/setup/complete — direct mode', () => {
    beforeEach(() => resetConfig('direct'));

    it('completes without an admin (no gate in direct mode)', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/complete', {});
      assert.equal(status, 200);
      assert.equal(data.setupComplete, true);
      assert.equal(store.config.load().authEnabled, false);
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

    it('allows setupComplete=true in direct mode', async () => {
      resetConfig('direct');
      const { status } = await request(server, 'PATCH', '/api/config', { setupComplete: true });
      assert.equal(status, 200);
      assert.equal(store.config.load().setupComplete, true);
    });

    it('allows an unrelated PATCH in caddy mode without an admin (only blocks the complete transition)', async () => {
      resetConfig('caddy');
      const { status } = await request(server, 'PATCH', '/api/config', { chimeEnabled: false });
      assert.equal(status, 200);
    });
  });
});
