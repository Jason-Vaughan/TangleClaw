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
const { installAlwaysAvailableEngine } = require('./_engine-fixture');

setLevel('error');

// See the note in test/master.test.js: the redirect URL derives its port from
// TANGLECLAW_PORT before config (#654), and a TangleClaw-launched dev session
// inherits that variable, so the ambient value has to go or config-driven
// assertions depend on how the runner was started.
delete process.env.TANGLECLAW_PORT;

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
    // `POST /api/setup/complete` refuses to finish an install with no AI engine,
    // and the bundled profiles detect real CLIs — so the seven tests below asked
    // the host a question instead of the code: green on a Mac with Claude Code
    // installed, `400 ENGINE_REQUIRED` on a CI runner with none. Satisfy the
    // precondition deterministically, the same way every other suite that drives
    // setup to completion already does.
    installAlwaysAvailableEngine(baseDir);
    store.init();

    // This suite is about the HTTPS restart and the redirect URL it produces —
    // a path that exists only when setup does NOT start an ingress cutover,
    // because a cutover restarts the server itself and the handler deliberately
    // suppresses the HTTPS restart to avoid racing it. Park the machine in a
    // state where no cutover can start (a hand-written Caddyfile with no login,
    // which TangleClaw refuses to overwrite) so these cases keep testing their
    // own subject. The suppression itself is asserted separately below.
    fs.writeFileSync(
      path.join(baseDir, 'Caddyfile'),
      '# maintained by hand\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n'
    );

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

    it('adds a custom hosts list to the existing names rather than replacing them', async (t) => {
      // #1905 / Architect ruling A19 retired the verbatim-replacement contract:
      // a replacement list could drop a canonical host and recreate
      // HOST_NOT_SERVED. `hosts` now adds, and `removeHosts` removes.
      if (!hasOpenssl) return t.skip('openssl not available');
      const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
        hosts: ['localhost', 'example.local']
      });
      assert.equal(status, 200);
      assert.ok(data.hosts.includes('example.local'), 'the extra is minted');
      for (const h of ['localhost', '127.0.0.1', '::1']) {
        assert.ok(data.hosts.includes(h), `${h} is kept`);
      }
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

    describe('#1905 — the tailnet name comes from the shared host inventory', () => {
      const hostInventory = require('../lib/host-inventory');
      const httpsSetup = require('../lib/https-setup');
      const sessionOwnership = require('../lib/session-ownership');
      const TS = 'box.tail123.ts.net';
      let realExec;
      let savedConfig;

      /**
       * Make `tailscale status --json` report `dnsName` (or fail when null).
       * @param {string|null} dnsName - The Self.DNSName to report.
       * @returns {void}
       */
      function tailscaleReports(dnsName) {
        hostInventory._internal.execSync = () => {
          if (dnsName === null) throw new Error('command not found: tailscale');
          return JSON.stringify({ Self: { DNSName: dnsName } });
        };
      }

      before(() => {
        realExec = hostInventory._internal.execSync;
        savedConfig = store.config.load();
      });
      after(() => {
        hostInventory._internal.execSync = realExec;
        hostInventory._resetForTest();
      });
      // Each case sets its own config; put the suite's back afterwards.
      const restore = () => store.config.save({ ...savedConfig });

      it('mints the detected MagicDNS name, normalized, beside the defaults', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        tailscaleReports('Box.Tail123.ts.net.');
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {});
        assert.equal(status, 200);
        assert.ok(data.hosts.includes(TS), 'the detected name is in the cert');
        assert.ok(data.hosts.includes('localhost'), 'the defaults are kept');
        assert.equal(data.inventory.tailnet.host, TS);
        assert.equal(data.inventory.tailnet.source, 'detected');
        assert.equal(data.inventory.tailnet.covered, true);
        assert.equal(data.inventory.tailnet.caddySite, 'not-configured');
        assert.equal(store.config.load().caddyTailnetHost, savedConfig.caddyTailnetHost,
          'a detected name is not written into caddyTailnetHost');
      });

      it('reports the omission when detection is unavailable, and invents no host', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        tailscaleReports(null);
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {});
        assert.equal(status, 200);
        assert.equal(data.inventory.tailnet.host, null);
        assert.match(data.inventory.tailnet.omission, /tailscale: unavailable/);
        assert.ok(!data.hosts.some((h) => h.endsWith('.ts.net')));
      });

      it('an explicit hosts list cannot leave out the canonical tailnet host', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        tailscaleReports(`${TS}.`);
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
          hosts: ['localhost']
        });
        assert.equal(status, 200);
        assert.ok(data.hosts.includes(TS), 'the mandatory canonical host is unioned in');
        assert.equal(data.inventory.tailnet.covered, true);
      });

      it('removeHosts removes a non-canonical name from the minted list', async (t) => {
        // One request, because the mkcert stub writes the same fixture cert every
        // time: a name added by an earlier request is never actually carried, so a
        // two-request version passed without removeHosts doing anything.
        if (!hasOpenssl) return t.skip('openssl not available');
        tailscaleReports(null);
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
          hosts: ['extra.example', 'keep.example'], removeHosts: ['extra.example']
        });
        assert.equal(status, 200);
        assert.ok(!data.hosts.includes('extra.example'), 'the removed name is not minted');
        assert.ok(data.hosts.includes('keep.example'), 'the others are');
        assert.ok(data.hosts.includes('localhost'));
      });

      it('removeHosts matches a dotted, upper-cased spelling of the name it removes', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        tailscaleReports(null);
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
          hosts: ['extra.example'], removeHosts: ['EXTRA.Example.']
        });
        assert.equal(status, 200);
        assert.ok(!data.hosts.includes('extra.example'));
      });

      for (const [label, name, probe] of [
        ['the canonical tailnet host', TS, `${TS}.`],
        ['a mkcert default', 'localhost', null],
        ['the mDNS name', require('../lib/https-setup').mdnsHostFor(os.hostname()), null]
      ]) {
        it(`removeHosts naming ${label} is a typed conflict and mints nothing`, async () => {
          tailscaleReports(probe);
          const certPath = path.join(baseDir, 'certs', 'cert.pem');
          const before = fs.existsSync(certPath) ? fs.statSync(certPath).mtimeMs : null;
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
            removeHosts: [name.toUpperCase()]
          });
          assert.equal(status, 409);
          assert.equal(data.code, 'CANONICAL_HOST_REMOVAL');
          assert.deepEqual(data.hosts, [name.toLowerCase()]);
          assert.equal(fs.existsSync(certPath) ? fs.statSync(certPath).mtimeMs : null, before,
            'the certificate is not regenerated');
        });
      }

      for (const [label, variant, canonical, probe] of [
        ['the tailnet host, dotted and upper-cased', 'Box.Tail123.TS.NET.', 'box.tail123.ts.net', 'box.tail123.ts.net.'],
        ['localhost with a trailing dot', 'LOCALHOST.', 'localhost', null]
      ]) {
        it(`removeHosts compares normalized names: ${label} is still a canonical conflict`, async () => {
          tailscaleReports(probe);
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
            removeHosts: [variant]
          });
          assert.equal(status, 409);
          assert.equal(data.code, 'CANONICAL_HOST_REMOVAL');
          assert.deepEqual(data.hosts, [canonical]);
        });
      }

      it('rejects a malformed removeHosts', async () => {
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {
          removeHosts: ['-install']
        });
        assert.equal(status, 400);
        assert.equal(data.code, 'BAD_REQUEST');
      });

      it('drift is reported and not silently reconciled', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net' });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert', {});
          assert.equal(status, 200);
          assert.deepEqual(data.inventory.tailnet.drift,
            { configured: 'old.tail123.ts.net', observed: TS });
          assert.equal(data.inventory.tailnet.host, 'old.tail123.ts.net');
          assert.ok(!data.hosts.includes(TS), 'the observed name is not half-adopted');
          assert.equal(data.inventory.reconciled, null);
          assert.equal(store.config.load().caddyTailnetHost, 'old.tail123.ts.net');
        } finally {
          restore();
        }
      });

      it('direct mode: reconcileTailnet moves the configured name and the cert together, with parity before and after', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        const gated = { ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' };
        store.config.save(gated);
        tailscaleReports(`${TS}.`);
        try {
          const cfgBefore = store.config.load();
          const canonicalBefore = hostInventory.resolveTailnetHost(cfgBefore).host;
          assert.equal(canonicalBefore, 'old.tail123.ts.net');
          assert.equal(sessionOwnership.resolveOperatorHost({}, cfgBefore).host, canonicalBefore);
          assert.ok(httpsSetup.servedHostAllowlist(cfgBefore).has(canonicalBefore));

          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: true });
          assert.equal(status, 200);
          assert.ok(data.hosts.includes(TS), 'the cert carries the new name');
          assert.ok(data.hosts.includes('old.tail123.ts.net'), 'and still the outgoing one');
          assert.deepEqual(data.inventory.reconciled.caddyTailnetHost,
            { from: 'old.tail123.ts.net', to: TS });
          assert.equal(data.inventory.reconciled.pending, undefined, 'nothing is left pending');

          const cfgAfter = store.config.load();
          assert.equal(cfgAfter.caddyTailnetHost, TS);
          assert.equal(hostInventory.resolveTailnetHost(cfgAfter).host, TS);
          assert.equal(sessionOwnership.resolveOperatorHost({}, cfgAfter).host, TS);
          assert.ok(httpsSetup.servedHostAllowlist(cfgAfter, { certHosts: data.hosts }).has(TS));
          assert.ok(httpsSetup.certHostUnion(null, cfgAfter).includes(TS));
        } finally {
          restore();
        }
      });

      it('direct mode: a failed mint leaves the config unchanged', async () => {
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' });
        tailscaleReports(`${TS}.`);
        const saved = process.env.PATH;
        process.env.PATH = path.join(tmpDir, 'nonexistent-dir-reconcile');
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: true });
          assert.equal(status, 500);
          assert.equal(data.code, 'MKCERT_FAILED');
          assert.equal(store.config.load().caddyTailnetHost, 'old.tail123.ts.net');
        } finally {
          process.env.PATH = saved;
          restore();
        }
      });

      it('direct mode: a failed config save after the mint leaves the outgoing host canonical and covered everywhere', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' });
        tailscaleReports(`${TS}.`);
        const realSave = store.config.save;
        store.config.save = () => { throw new Error('EROFS: read-only file system'); };
        let data;
        let status;
        try {
          ({ status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: true }));
        } finally {
          store.config.save = realSave;
        }
        try {
          assert.equal(status, 500);
          assert.equal(data.code, 'RECONCILE_SAVE_FAILED');
          assert.ok(data.hosts.includes('old.tail123.ts.net') && data.hosts.includes(TS),
            'the minted cert carries both names');
          const cfg = store.config.load();
          assert.equal(cfg.caddyTailnetHost, 'old.tail123.ts.net', 'the config did not move');
          const canonical = hostInventory.resolveTailnetHost(cfg).host;
          assert.equal(canonical, 'old.tail123.ts.net');
          assert.ok(httpsSetup.servedHostAllowlist(cfg, { certHosts: data.hosts }).has(canonical));
          assert.equal(sessionOwnership.resolveOperatorHost({}, cfg).host, canonical);
          assert.ok(data.hosts.includes(canonical), 'the canonical host is never uncovered');
        } finally {
          restore();
        }
      });

      it('an ungated install is refused with a named remedy and nothing changes', async () => {
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: false });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: true });
          assert.equal(status, 409);
          assert.equal(data.code, 'TAILNET_UNGATED');
          assert.match(data.error, /Arm the TangleClaw login/);
          assert.equal(store.config.load().caddyTailnetHost, 'old.tail123.ts.net');
        } finally {
          restore();
        }
      });

      it('caddy mode: reconcileTailnet true is refused, names prepare and the apply command, and flips nothing', async () => {
        store.config.save({ ...{ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' }, ingressMode: 'caddy' });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: true });
          assert.equal(status, 409);
          assert.equal(data.code, 'RECONCILE_NEEDS_CUTOVER');
          assert.deepEqual(data.next, {
            prepare: { reconcileTailnet: 'prepare' },
            apply: `node scripts/ingress-cutover.js --to caddy --tailnet-host ${TS}`
          });
          assert.deepEqual(data.drift, { configured: 'old.tail123.ts.net', observed: TS });
          assert.equal(store.config.load().caddyTailnetHost, 'old.tail123.ts.net');
        } finally {
          restore();
        }
      });

      it('caddy mode: prepare mints a transition cert with both names and changes nothing else', async (t) => {
        if (!hasOpenssl) return t.skip('openssl not available');
        store.config.save({ ...{ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' }, ingressMode: 'caddy' });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: 'prepare' });
          assert.equal(status, 200);
          assert.ok(data.hosts.includes(TS) && data.hosts.includes('old.tail123.ts.net'),
            'the transition cert carries the old and the new name');
          assert.deepEqual(data.inventory.prepared, {
            from: 'old.tail123.ts.net', to: TS,
            apply: `node scripts/ingress-cutover.js --to caddy --tailnet-host ${TS}`
          });
          assert.equal(data.inventory.reconciled, null);
          const cfg = store.config.load();
          assert.equal(cfg.caddyTailnetHost, 'old.tail123.ts.net', 'no canonical flip in prepare');
          assert.equal(hostInventory.resolveTailnetHost(cfg).host, 'old.tail123.ts.net');
          assert.equal(sessionOwnership.resolveOperatorHost({}, cfg).host, 'old.tail123.ts.net');
          assert.equal(data.inventory.tailnet.host, 'old.tail123.ts.net');
        } finally {
          restore();
        }
      });

      it('caddy mode: prepare on an ungated install is refused', async () => {
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: false, ingressMode: 'caddy' });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: 'prepare' });
          assert.equal(status, 409);
          assert.equal(data.code, 'TAILNET_UNGATED');
        } finally {
          restore();
        }
      });

      it('direct mode: prepare is refused as unnecessary', async () => {
        store.config.save({ ...savedConfig, caddyTailnetHost: 'old.tail123.ts.net', authEnabled: true, basicAuthUser: 'op', basicAuthHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' });
        tailscaleReports(`${TS}.`);
        try {
          const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
            { reconcileTailnet: 'prepare' });
          assert.equal(status, 409);
          assert.equal(data.code, 'PREPARE_NOT_NEEDED');
          assert.equal(store.config.load().caddyTailnetHost, 'old.tail123.ts.net');
        } finally {
          restore();
        }
      });

      it('reconcileTailnet with nothing to reconcile is refused and changes nothing', async () => {
        tailscaleReports(`${TS}.`);
        const before = store.config.load().caddyTailnetHost;
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
          { reconcileTailnet: true });
        assert.equal(status, 409);
        assert.equal(data.code, 'NO_TAILNET_DRIFT');
        assert.equal(store.config.load().caddyTailnetHost, before);
      });

      it('rejects a non-boolean reconcileTailnet', async () => {
        const { status, data } = await request(server, 'POST', '/api/setup/generate-cert',
          { reconcileTailnet: 'yes' });
        assert.equal(status, 400);
        assert.equal(data.code, 'BAD_REQUEST');
      });
    });
  });

  describe('POST /api/setup/complete — HTTPS fields', () => {
    /**
     * POST /api/setup/complete as a first run that chooses no login.
     *
     * These cases are about the HTTPS restart and redirect, not the login step.
     * Setup demands a login or the operator's explicit choice of none on a first
     * run, so a first-run request carries that choice; a later re-POST (setup
     * already complete) must not, because the choice is only made once.
     * @param {object} body
     * @returns {Promise<{ status: number, data: any }>}
     */
    function completeSetup(body) {
      const firstRun = store.config.load().setupComplete === false;
      return request(server, 'POST', '/api/setup/complete', firstRun ? { ...body, noLogin: true } : body);
    }

    it('accepts valid cert paths, saves them, and schedules a restart', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');

      // Reset baseline — no HTTPS in config
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false,
        httpsCertPath: '',
        httpsKeyPath: ''
      });
      restartCalls = 0;

      const { status, data } = await completeSetup({
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

    it('builds redirectUrl from the bound port, not config.serverPort (#654)', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');

      // The standard install: config keeps the shipped 3101 default while the
      // launchd plist binds 3102. Deriving the redirect from config sent the
      // operator to a connection-refused page immediately after a *successful*
      // HTTPS configuration — the failure looked like the restart, not the URL.
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false, httpsCertPath: '', httpsKeyPath: ''
      });
      store.config.save(Object.assign(store.config.load(), { serverPort: 3101 }));
      restartCalls = 0;

      const had = Object.prototype.hasOwnProperty.call(process.env, 'TANGLECLAW_PORT');
      const prev = process.env.TANGLECLAW_PORT;
      try {
        process.env.TANGLECLAW_PORT = '3102';
        const { status, data } = await completeSetup({
          httpsEnabled: true,
          httpsCertPath: fixture.certPath,
          httpsKeyPath: fixture.keyPath
        });

        assert.equal(status, 200);
        assert.equal(data.restart, true);
        assert.match(data.redirectUrl, /^https:\/\/[^:/]+:3102$/);
        assert.equal(data.redirectVia, 'server',
          'in direct mode the address IS the server, so a reply there does mean it is back');
        assert.ok(
          !data.redirectUrl.endsWith(':3101'),
          'must not redirect to the config port when the environment overrides it'
        );
      } finally {
        if (had) process.env.TANGLECLAW_PORT = prev;
        else delete process.env.TANGLECLAW_PORT;
      }
    });

    it('sends a caddy-mode operator to Caddy, not to the port TC re-binds', async (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');

      // The reachable version of the bug this chunk exists for. `shouldRestart`
      // only needs the HTTPS config to have CHANGED — it does not care about
      // ingress mode — so a caddy-mode install whose operator edits a cert path
      // in the wizard takes this path. The old expression built the scheme from
      // `willServeHttps` and the port from TC's own listener, which behind Caddy
      // is plain HTTP on the loopback: it named a port nothing answers on, and
      // an ungated one at that.
      await request(server, 'PATCH', '/api/config', {
        httpsEnabled: false, httpsCertPath: '', httpsKeyPath: ''
      });
      // A credential is required to finish setup in caddy mode (chunk 2's
      // ADMIN_REQUIRED), so the fixture carries one — this test is about where
      // the operator is SENT, on an install that legitimately completes.
      store.config.save(Object.assign(store.config.load(), {
        ingressMode: 'caddy',
        caddyHttpsPort: 8443,
        serverPort: 3101,
        authEnabled: true,
        basicAuthUser: 'jason',
        basicAuthHash: '$2a$14$' + 'o'.repeat(53)
      }));
      restartCalls = 0;

      try {
        const { status, data } = await request(server, 'POST', '/api/setup/complete', {
          httpsEnabled: true,
          httpsCertPath: fixture.certPath,
          httpsKeyPath: fixture.keyPath
        });

        assert.equal(status, 200);
        assert.match(data.redirectUrl, /^https:\/\/[^:/]+:8443$/,
          'the front door in caddy mode is Caddy, on its own port');
        assert.equal(data.redirectVia, 'proxy',
          'and the client must be TOLD a proxy answers there — it cannot tell from the URL, '
          + 'and probing a proxy proves nothing about the server behind it');
        assert.ok(!/:3101$|:3102$/.test(data.redirectUrl),
          'never TC\'s own listener — behind Caddy that is the ungated loopback door');
      } finally {
        store.config.save(Object.assign(store.config.load(), {
          ingressMode: 'direct', authEnabled: false, basicAuthUser: null, basicAuthHash: null
        }));
      }
    });

    it('returns 400 when cert files are invalid', async () => {
      restartCalls = 0;
      const badCert = path.join(tmpDir, 'bad-cert.pem');
      const badKey = path.join(tmpDir, 'bad-key.pem');
      fs.writeFileSync(badCert, 'not a cert');
      fs.writeFileSync(badKey, 'not a key');

      const { status, data } = await completeSetup({
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

      const { status, data } = await completeSetup({
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

      const { status, data } = await completeSetup({
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

      const { status, data } = await completeSetup({
        httpsEnabled: false
      });
      assert.equal(status, 200);
      assert.equal(data.restart, true);
      assert.ok(data.redirectUrl && data.redirectUrl.startsWith('http://'));
      assert.equal(restartCalls, 1);
    });
  });
});
