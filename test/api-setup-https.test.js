'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');

setLevel('error');

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

function writeMkcertStub(stubDir, caRoot, certFixture, keyFixture) {
  const script = `#!/bin/bash
set -e
case "$1" in
  -help|--help) echo "mkcert stub"; exit 0 ;;
  -version|--version) echo "v1.4.4-stub"; exit 0 ;;
  -CAROOT) echo "${caRoot}"; exit 0 ;;
  -install)
    mkdir -p "${caRoot}"
    : > "${caRoot}/rootCA.pem"
    : > "${caRoot}/rootCA-key.pem"
    exit 0
    ;;
  -cert-file)
    shift
    cert_path="$1"; shift
    [ "$1" = "-key-file" ] || { echo "expected -key-file" >&2; exit 1; }
    shift
    key_path="$1"; shift
    cp "${certFixture}" "$cert_path"
    cp "${keyFixture}" "$key_path"
    exit 0
    ;;
esac
echo "unknown" >&2; exit 1
`;
  const p = path.join(stubDir, 'mkcert');
  fs.writeFileSync(p, script, { mode: 0o755 });
}

function makeSelfSignedCert(dir) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 30 -nodes -subj "/CN=localhost"`,
      { stdio: 'ignore', timeout: 10000 }
    );
  } catch {
    return null;
  }
  return { certPath, keyPath };
}

describe('HTTPS Setup API', () => {
  let tmpDir;
  let stubDir;
  let caRoot;
  let baseDir;
  let server;
  let origPath;
  let fixture;
  let hasOpenssl;
  let restartCalls;
  let createServer;
  let _setRestartScheduler;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-https-'));
    stubDir = path.join(tmpDir, 'bin');
    caRoot = path.join(tmpDir, 'caroot');
    baseDir = path.join(tmpDir, 'tangleclaw');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.mkdirSync(caRoot, { recursive: true });

    const fixtureDir = path.join(tmpDir, 'fixture');
    fs.mkdirSync(fixtureDir);
    fixture = makeSelfSignedCert(fixtureDir);
    hasOpenssl = !!fixture;

    if (fixture) {
      writeMkcertStub(stubDir, caRoot, fixture.certPath, fixture.keyPath);
    }

    origPath = process.env.PATH;
    process.env.PATH = stubDir + path.delimiter + (origPath || '');

    store._setBasePath(baseDir);
    store.init();

    ({ createServer, _setRestartScheduler } = require('../server'));

    restartCalls = 0;
    _setRestartScheduler(() => { restartCalls += 1; });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    process.env.PATH = origPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/setup/https-check', () => {
    it('returns mkcert detection info and certsDir', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'GET', '/api/setup/https-check');
      assert.equal(status, 200);
      assert.equal(data.mkcert.available, true);
      assert.equal(data.mkcert.carootPath, caRoot);
      assert.ok(data.mkcert.version && data.mkcert.version.includes('stub'));
      assert.equal(data.certsDir, path.join(baseDir, 'certs'));
    });
  });

  describe('POST /api/setup/generate-cert', () => {
    it('generates cert + key and returns remote trust steps', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {});
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(fs.existsSync(data.certPath), 'cert should exist on disk');
      assert.ok(fs.existsSync(data.keyPath), 'key should exist on disk');
      assert.ok(Array.isArray(data.remoteTrust.steps));
      const platforms = data.remoteTrust.steps.map(s => s.platform);
      assert.ok(platforms.includes('macOS'));
    });

    it('accepts a custom hosts list', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: ['localhost', 'example.local']
      });
      assert.equal(status, 200);
      assert.deepEqual(data.hosts, ['localhost', 'example.local']);
    });

    it('returns 500 when mkcert is unavailable', async () => {
      const saved = process.env.PATH;
      process.env.PATH = path.join(tmpDir, 'nonexistent-dir-api');
      try {
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {});
        assert.equal(status, 500);
        assert.equal(data.code, 'MKCERT_FAILED');
      } finally {
        process.env.PATH = saved;
      }
    });

    it('rejects hosts that start with a dash (would be parsed as an mkcert flag)', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: ['-install']
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.match(data.error, /Invalid host/);
    });

    it('rejects hosts with shell metacharacters', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: ['localhost', '$(whoami)']
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
    });

    it('rejects an empty hosts array', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: []
      });
      assert.equal(status, 400);
      assert.match(data.error, /non-empty/);
    });

    it('rejects a non-string host', async () => {
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: [123]
      });
      assert.equal(status, 400);
      assert.match(data.error, /Invalid host/);
    });
  });

  describe('POST /api/setup/complete — HTTPS fields', () => {
    it('accepts valid cert paths, saves them, and schedules a restart', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');

      // Reset baseline — no HTTPS in config
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      restartCalls = 0;

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        httpsEnabled: true,
        httpsCertPath: fixture.certPath,
        httpsKeyPath: fixture.keyPath
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.restart, true);
      assert.ok(data.redirectUrl && data.redirectUrl.startsWith('https://'));
      assert.equal(restartCalls, 1);

      const cfg = store.config.load();
      assert.equal(cfg.httpsEnabled, true);
      assert.equal(cfg.httpsCertPath, fixture.certPath);
      assert.equal(cfg.httpsKeyPath, fixture.keyPath);
    });

    it('returns 400 when cert files are invalid', async () => {
      restartCalls = 0;
      const badCert = path.join(tmpDir, 'bad-cert.pem');
      const badKey = path.join(tmpDir, 'bad-key.pem');
      fs.writeFileSync(badCert, 'not a cert');
      fs.writeFileSync(badKey, 'not a key');

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        httpsEnabled: true,
        httpsCertPath: badCert,
        httpsKeyPath: badKey
      });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.equal(restartCalls, 0);
    });

    it('returns 400 when only one of certPath/keyPath is provided', async () => {
      restartCalls = 0;
      // Reset to a clean baseline first
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: '',
        httpsKeyPath: ''
      });

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        httpsEnabled: true,
        httpsCertPath: '/tmp/nope-cert.pem'
        // keyPath intentionally omitted
      });
      assert.equal(status, 400);
      assert.match(data.error, /Both httpsCertPath and httpsKeyPath/);
      assert.equal(restartCalls, 0);
    });

    it('does not schedule a restart when HTTPS state is unchanged', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      // Seed current config with HTTPS already on
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: fixture.certPath,
        httpsKeyPath: fixture.keyPath
      });
      restartCalls = 0;

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        httpsEnabled: true,
        httpsCertPath: fixture.certPath,
        httpsKeyPath: fixture.keyPath
      });
      assert.equal(status, 200);
      assert.equal(data.restart, false);
      assert.equal(data.redirectUrl, null);
      assert.equal(restartCalls, 0);
    });

    it('schedules a restart when disabling HTTPS from a fully-HTTPS config', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      // Seed HTTPS-on state
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: true,
        httpsCertPath: fixture.certPath,
        httpsKeyPath: fixture.keyPath
      });
      restartCalls = 0;

      const { status, data } = await request(server, 'POST', '/api/setup/complete', {
        httpsEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.restart, true);
      assert.ok(data.redirectUrl && data.redirectUrl.startsWith('http://'));
      assert.equal(restartCalls, 1);
    });
  });
});
