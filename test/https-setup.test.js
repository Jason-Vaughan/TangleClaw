'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');

setLevel('error');

let httpsSetup;

/**
 * Write a shell stub named "mkcert" into stubDir that simulates the real binary.
 * Uses fixture cert+key files (passed via env) to satisfy cert generation calls.
 */
function writeMkcertStub(stubDir, caRoot, certFixture, keyFixture) {
  const script = `#!/bin/bash
set -e
case "$1" in
  -help|--help)
    echo "mkcert stub help"
    exit 0
    ;;
  -version|--version)
    echo "v1.4.4-stub"
    exit 0
    ;;
  -CAROOT)
    echo "${caRoot}"
    exit 0
    ;;
  -install)
    # Idempotently create a fake CA in CAROOT
    mkdir -p "${caRoot}"
    : > "${caRoot}/rootCA.pem"
    : > "${caRoot}/rootCA-key.pem"
    exit 0
    ;;
  -cert-file)
    # Expected: -cert-file <path> -key-file <path> hosts...
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
echo "mkcert stub: unknown args: $*" >&2
exit 1
`;
  const stubPath = path.join(stubDir, 'mkcert');
  fs.writeFileSync(stubPath, script, { mode: 0o755 });
}

/**
 * Generate a self-signed cert + key via openssl. Returns { certPath, keyPath } or null if openssl unavailable.
 */
function makeSelfSignedCert(dir) {
  const certPath = path.join(dir, 'fixture-cert.pem');
  const keyPath = path.join(dir, 'fixture-key.pem');
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

describe('mdnsHostFor — the certificate SAN that lets another device connect', () => {
  // Required here rather than reusing the outer `httpsSetup`: that one is
  // assigned in a `before` hook belonging to the other describe block, which has
  // not run when these cases execute. These are pure string logic and need none
  // of that block's stubbed PATH or temp dirs.
  const { mdnsHostFor } = require('../lib/https-setup');
  const httpsSetup = { mdnsHostFor };
  // A clean-room install generated a cert whose SAN list contained
  // `Manageds-Virtual-Machine.local.local`. `os.hostname()` on macOS usually
  // already carries the suffix, and the code appended another unconditionally,
  // so the SAN matched nothing — costing the certificate the one name a phone or
  // laptop on the same network can actually resolve. It failed silently: cert
  // generation succeeded, and the name simply never worked.
  it('does not double a suffix the hostname already has', () => {
    assert.equal(httpsSetup.mdnsHostFor('Manageds-Virtual-Machine.local'), 'Manageds-Virtual-Machine.local');
    assert.equal(httpsSetup.mdnsHostFor('box.LOCAL'), 'box.LOCAL', 'suffix check is case-insensitive');
  });

  it('appends the suffix when it is genuinely absent', () => {
    assert.equal(httpsSetup.mdnsHostFor('studio'), 'studio.local');
  });

  it('never emits a bare ".local" for an empty or unusable hostname', () => {
    // `.local` as a SAN would be worse than no SAN — it matches nothing and
    // looks deliberate to whoever reads the certificate later.
    for (const bad of ['', '   ', null, undefined, 42]) {
      assert.equal(httpsSetup.mdnsHostFor(bad), null, `${JSON.stringify(bad)} must yield no mDNS host`);
    }
  });

  it('strips trailing dots (a fully-qualified mDNS name is written "host.local.")', () => {
    assert.equal(httpsSetup.mdnsHostFor('studio.local.'), 'studio.local');
    assert.equal(httpsSetup.mdnsHostFor('studio.'), 'studio.local');
  });
});

describe('https-setup', () => {
  let tmpDir;
  let stubDir;
  let caRoot;
  let baseDir;
  let origPath;
  let fixture;
  let hasOpenssl;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-https-setup-'));
    stubDir = path.join(tmpDir, 'bin');
    caRoot = path.join(tmpDir, 'caroot');
    baseDir = path.join(tmpDir, 'tangleclaw');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.mkdirSync(caRoot, { recursive: true });

    fixture = makeSelfSignedCert(tmpDir);
    hasOpenssl = !!fixture;

    if (fixture) {
      writeMkcertStub(stubDir, caRoot, fixture.certPath, fixture.keyPath);
    }

    origPath = process.env.PATH;
    process.env.PATH = stubDir + path.delimiter + (origPath || '');

    store._setBasePath(baseDir);
    store.init();

    // Require after PATH is primed so module uses stub if it resolves early
    httpsSetup = require('../lib/https-setup');
  });

  after(() => {
    process.env.PATH = origPath;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getCertsDir', () => {
    it('returns <basePath>/certs', () => {
      assert.equal(httpsSetup.getCertsDir(), path.join(baseDir, 'certs'));
    });
  });

  describe('effectiveServerProtocol (ENG-5R2W)', () => {
    it('returns http in caddy ingress mode regardless of HTTPS config — caddy owns TLS', () => {
      assert.equal(httpsSetup.effectiveServerProtocol({
        ingressMode: 'caddy', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem'
      }), 'http');
    });

    it('returns https only when httpsEnabled AND both cert paths are set (the willServeHttps conjunction)', () => {
      assert.equal(httpsSetup.effectiveServerProtocol({
        ingressMode: 'direct', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem'
      }), 'https');
      // httpsEnabled defaults to true — a no-cert install serves HTTP via the
      // createServer fallback, so the predicted scheme must be http too.
      assert.equal(httpsSetup.effectiveServerProtocol({ httpsEnabled: true }), 'http');
      assert.equal(httpsSetup.effectiveServerProtocol({
        httpsEnabled: true, httpsCertPath: '/c.pem'
      }), 'http');
      assert.equal(httpsSetup.effectiveServerProtocol({
        httpsEnabled: false, httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem'
      }), 'http');
    });

    it('returns http on missing config — never throws on a degenerate input', () => {
      assert.equal(httpsSetup.effectiveServerProtocol(null), 'http');
      assert.equal(httpsSetup.effectiveServerProtocol(undefined), 'http');
      assert.equal(httpsSetup.effectiveServerProtocol({}), 'http');
    });
  });

  describe('effectiveServerPort (#654)', () => {
    it('lets TANGLECLAW_PORT win over config — the standard-install case', () => {
      // The installed launchd plist sets TANGLECLAW_PORT=3102 and never touches
      // config.serverPort, which stays at the shipped 3101 default. Deriving from
      // config alone is what pointed the post-setup redirect and every injected
      // project config at a dead port.
      assert.equal(
        httpsSetup.effectiveServerPort({ serverPort: 3101 }, { TANGLECLAW_PORT: '3102' }),
        3102
      );
    });

    it('returns a number, not the raw env string', () => {
      const port = httpsSetup.effectiveServerPort({}, { TANGLECLAW_PORT: '3102' });
      assert.equal(typeof port, 'number');
      assert.equal(port, 3102);
    });

    it('falls back to config.serverPort when the environment names no port', () => {
      assert.equal(httpsSetup.effectiveServerPort({ serverPort: 3200 }, {}), 3200);
    });

    it('falls back to the 3101 code default when neither names a port', () => {
      assert.equal(httpsSetup.effectiveServerPort({}, {}), 3101);
      assert.equal(httpsSetup.effectiveServerPort({ serverPort: null }, {}), 3101);
    });

    it('never throws on a degenerate config', () => {
      assert.equal(httpsSetup.effectiveServerPort(null, {}), 3101);
      assert.equal(httpsSetup.effectiveServerPort(undefined, {}), 3101);
    });

    it('ignores a TANGLECLAW_PORT that is not a bindable port, rather than propagating it', () => {
      // A value the server could never have bound cannot be the live port, so
      // config is the better guess — propagating it would yield localhost:NaN.
      // '0x10' and '1e3' are why the guard is a digits-only test rather than a
      // bare Number(): both parse to plausible integers no plist would mean.
      for (const bad of ['', '   ', 'abc', '0', '-1', '65536', '3102.5', '3102abc', '0x10', '1e3', '+3102', ' -3102 ']) {
        assert.equal(
          httpsSetup.effectiveServerPort({ serverPort: 3200 }, { TANGLECLAW_PORT: bad }),
          3200,
          `TANGLECLAW_PORT=${JSON.stringify(bad)} must not survive`
        );
      }
    });

    it('exposes the same predicate boot uses to warn about an unbindable plist value', () => {
      // server.js main logs on !isBindableServerPort before binding; if the two
      // ever disagreed, boot would either warn about a port it then used or bind
      // a fallback with no warning at all.
      for (const good of ['3102', ' 3102 ', '1', '65535']) {
        assert.equal(httpsSetup.isBindableServerPort(good), true, `${JSON.stringify(good)} is bindable`);
      }
      for (const bad of ['', 'abc', '0', '-1', '65536', '3102.5', '0x10', '1e3', undefined, null]) {
        assert.equal(httpsSetup.isBindableServerPort(bad), false, `${JSON.stringify(bad)} is not bindable`);
        // The predicate and the resolver must agree on every rejected value.
        assert.equal(httpsSetup.effectiveServerPort({ serverPort: 3200 }, { TANGLECLAW_PORT: bad }), 3200);
      }
    });

    it('reads process.env when no env is injected', () => {
      const had = Object.prototype.hasOwnProperty.call(process.env, 'TANGLECLAW_PORT');
      const prev = process.env.TANGLECLAW_PORT;
      try {
        process.env.TANGLECLAW_PORT = '3405';
        assert.equal(httpsSetup.effectiveServerPort({ serverPort: 3101 }), 3405);
        delete process.env.TANGLECLAW_PORT;
        assert.equal(httpsSetup.effectiveServerPort({ serverPort: 3101 }), 3101);
      } finally {
        if (had) process.env.TANGLECLAW_PORT = prev;
        else delete process.env.TANGLECLAW_PORT;
      }
    });
  });

  describe('effectiveOperatorOrigin (#710)', () => {
    // The producer is swept, not sampled: every mode this function can be asked
    // about appears below. A guard for a class that exercises one member is the
    // defect this repo already learned once.

    it('sends a caddy-mode operator to CADDY, not to the server behind it', () => {
      // The whole reason this function exists. In caddy mode the server itself
      // serves plain HTTP on the loopback — `effectiveServerProtocol` says so —
      // so composing the two "what is TC serving" helpers yields
      // http://host:3102, which is TC's loopback-only and UNGATED door. Sending
      // an operator there walks them past the login gate setup just installed,
      // and from another device it is dead.
      assert.equal(
        httpsSetup.effectiveOperatorOrigin({ ingressMode: 'caddy' }, 'box.tail123.ts.net', {}),
        'https://box.tail123.ts.net:8443'
      );
    });

    it('honours a custom caddy HTTPS port', () => {
      assert.equal(
        httpsSetup.effectiveOperatorOrigin(
          { ingressMode: 'caddy', caddyHttpsPort: 9443 }, 'box', {}),
        'https://box:9443'
      );
    });

    it('ignores TC\'s own port and scheme entirely in caddy mode', () => {
      // Caddy terminates TLS and listens on its own port; nothing about TC's
      // listener changes where the operator knocks. TANGLECLAW_PORT is the
      // sharpest version of this — it is what the installed plist sets, so a
      // derivation that leaked it would be wrong on every standard install.
      assert.equal(
        httpsSetup.effectiveOperatorOrigin(
          { ingressMode: 'caddy', serverPort: 3101, httpsEnabled: false },
          'box',
          { TANGLECLAW_PORT: '3102' }
        ),
        'https://box:8443'
      );
    });

    it('is the server\'s own origin in direct mode with certs', () => {
      assert.equal(
        httpsSetup.effectiveOperatorOrigin({
          ingressMode: 'direct', httpsEnabled: true, httpsCertPath: '/c', httpsKeyPath: '/k', serverPort: 3101
        }, 'box', {}),
        'https://box:3101'
      );
    });

    it('is http in direct mode when the certs are missing, since that is what binds', () => {
      // `httpsEnabled` defaults to true, so a no-cert install still serves HTTP
      // via createServer's fallback — the ENG-5R2W defect was trusting the flag.
      assert.equal(
        httpsSetup.effectiveOperatorOrigin(
          { ingressMode: 'direct', httpsEnabled: true, serverPort: 3101 }, 'box', {}),
        'http://box:3101'
      );
    });

    it('follows TANGLECLAW_PORT in direct mode, where it IS the front door', () => {
      assert.equal(
        httpsSetup.effectiveOperatorOrigin(
          { ingressMode: 'direct', serverPort: 3101 }, 'box', { TANGLECLAW_PORT: '3102' }),
        'http://box:3102'
      );
    });

    it('answers about a config that is not in force yet', () => {
      // The setup route asks while a cutover is still running: `ingressMode` on
      // disk is whatever it was, and the question is where the operator goes
      // once it lands. Purity is what makes that askable.
      const onDisk = { ingressMode: 'direct', serverPort: 3101, caddyHttpsPort: 8443 };
      assert.equal(
        httpsSetup.effectiveOperatorOrigin({ ...onDisk, ingressMode: 'caddy' }, 'box', {}),
        'https://box:8443'
      );
      assert.equal(httpsSetup.effectiveOperatorOrigin(onDisk, 'box', {}), 'http://box:3101',
        'and the on-disk config still answers for itself');
    });

    it('falls back to localhost rather than emitting a hostless origin', () => {
      for (const host of ['', null, undefined]) {
        assert.equal(
          httpsSetup.effectiveOperatorOrigin({ ingressMode: 'caddy' }, host, {}),
          'https://localhost:8443'
        );
      }
    });

    it('says WHO answers at that origin, not only where it is', () => {
      // `via` is what stops a caller reading a response as proof the server is
      // back. Behind Caddy it is not: the proxy stays up across TangleClaw's
      // restart and answers immediately, so the wizard must not probe there.
      assert.deepEqual(
        httpsSetup.effectiveOperatorFrontDoor({ ingressMode: 'caddy' }, 'box', {}),
        { origin: 'https://box:8443', via: 'proxy' }
      );
      assert.deepEqual(
        httpsSetup.effectiveOperatorFrontDoor({ ingressMode: 'direct', serverPort: 3101 }, 'box', {}),
        { origin: 'http://box:3101', via: 'server' }
      );
    });

    it('derives the address and who answers it from ONE branch', () => {
      // Two derivations of "is this proxied" would be free to disagree with the
      // address they describe — a screen probing a proxy while calling it the
      // server is exactly the defect this pair exists to prevent.
      for (const config of [
        { ingressMode: 'caddy' },
        { ingressMode: 'caddy', caddyHttpsPort: 9443 },
        { ingressMode: 'direct', serverPort: 3101 },
        { ingressMode: 'direct', httpsEnabled: true, httpsCertPath: '/c', httpsKeyPath: '/k' },
        {}
      ]) {
        const door = httpsSetup.effectiveOperatorFrontDoor(config, 'box', {});
        const proxied = config.ingressMode === 'caddy';
        assert.equal(door.via, proxied ? 'proxy' : 'server');
        assert.equal(door.origin.startsWith('https://box:8443') || door.origin.startsWith('https://box:9443'),
          proxied, `${JSON.stringify(config)} — the port must agree with who answers`);
        assert.equal(httpsSetup.effectiveOperatorOrigin(config, 'box', {}), door.origin,
          'the string form must be the same derivation, not a second one');
      }
    });

    it('emits an origin with no trailing slash or path', () => {
      // Callers append nothing and the wizard renders it verbatim in a button.
      for (const config of [{ ingressMode: 'caddy' }, { ingressMode: 'direct', serverPort: 3101 }]) {
        const origin = httpsSetup.effectiveOperatorOrigin(config, 'box', {});
        assert.match(origin, /^https?:\/\/[^/]+$/, `${origin} must be a bare origin`);
      }
    });
  });

  describe('detectMkcert', () => {
    it('reports available: true when mkcert stub is on PATH', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const r = httpsSetup.detectMkcert();
      assert.equal(r.available, true);
      assert.equal(r.error, null);
    });

    it('returns a version string from mkcert -version', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const r = httpsSetup.detectMkcert();
      assert.ok(r.version && r.version.includes('stub'), `version should come from stub: got ${r.version}`);
    });

    it('returns the CAROOT path', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const r = httpsSetup.detectMkcert();
      assert.equal(r.carootPath, caRoot);
    });

    it('reports available: false when mkcert is not on PATH', () => {
      const saved = process.env.PATH;
      process.env.PATH = path.join(tmpDir, 'nonexistent-dir');
      try {
        const r = httpsSetup.detectMkcert();
        assert.equal(r.available, false);
        assert.ok(r.error, 'error message should be populated');
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  describe('isCaInstalled', () => {
    it('returns false when CAROOT has no rootCA.pem', () => {
      const emptyDir = path.join(tmpDir, 'empty-caroot');
      fs.mkdirSync(emptyDir);
      assert.equal(httpsSetup.isCaInstalled(emptyDir), false);
    });

    it('returns true after CA files exist in CAROOT', () => {
      const filledDir = path.join(tmpDir, 'filled-caroot');
      fs.mkdirSync(filledDir);
      fs.writeFileSync(path.join(filledDir, 'rootCA.pem'), '');
      fs.writeFileSync(path.join(filledDir, 'rootCA-key.pem'), '');
      assert.equal(httpsSetup.isCaInstalled(filledDir), true);
    });

    it('returns false for a non-existent CAROOT path', () => {
      assert.equal(httpsSetup.isCaInstalled('/tmp/tc-does-not-exist-' + Date.now()), false);
    });
  });

  describe('generateCerts', () => {
    it('invokes mkcert and writes cert.pem + key.pem into certsDir', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const outDir = path.join(tmpDir, 'generated-certs');
      const result = httpsSetup.generateCerts({ certsDir: outDir });
      assert.ok(fs.existsSync(result.certPath), 'cert.pem should exist');
      assert.ok(fs.existsSync(result.keyPath), 'key.pem should exist');
      assert.equal(result.certPath, path.join(outDir, 'cert.pem'));
      assert.equal(result.keyPath, path.join(outDir, 'key.pem'));
    });

    it('uses default host list when none provided', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const outDir = path.join(tmpDir, 'generated-certs-default-hosts');
      const result = httpsSetup.generateCerts({ certsDir: outDir });
      assert.ok(result.hosts.includes('localhost'));
      assert.ok(result.hosts.includes('127.0.0.1'));
    });

    it('parses an expiry timestamp from the generated cert', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const outDir = path.join(tmpDir, 'generated-certs-expiry');
      const result = httpsSetup.generateCerts({ certsDir: outDir });
      assert.ok(result.expiry, 'expiry should be populated');
    });

    it('tightens the private key permission to 0600', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      if (process.platform === 'win32') return t.skip('chmod not meaningful on Windows');
      const outDir = path.join(tmpDir, 'generated-certs-perm');
      const result = httpsSetup.generateCerts({ certsDir: outDir });
      const mode = fs.statSync(result.keyPath).mode & 0o777;
      assert.equal(mode, 0o600);
    });

    it('throws when mkcert is not available', () => {
      const saved = process.env.PATH;
      process.env.PATH = path.join(tmpDir, 'nonexistent-dir-2');
      try {
        assert.throws(() => httpsSetup.generateCerts({ certsDir: path.join(tmpDir, 'x') }), /mkcert/);
      } finally {
        process.env.PATH = saved;
      }
    });

    it('throws a clear error when certsDir is not writable', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      if (process.platform === 'win32') return t.skip('chmod semantics differ on Windows');
      if (process.getuid && process.getuid() === 0) return t.skip('root ignores file mode checks');
      const readOnlyDir = path.join(tmpDir, 'readonly-certs');
      fs.mkdirSync(readOnlyDir, { mode: 0o500 });
      try {
        assert.throws(
          () => httpsSetup.generateCerts({ certsDir: readOnlyDir }),
          /not writable/
        );
      } finally {
        fs.chmodSync(readOnlyDir, 0o700);
      }
    });

    // The privileged CA trust-install belongs to install.sh; the headless server
    // must not attempt it. generateCerts only runs `mkcert -install` when the CA
    // is absent, and a failure is NON-FATAL — cert generation proceeds regardless.
    it('skips mkcert -install when the local CA is already trusted', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      fs.writeFileSync(path.join(caRoot, 'rootCA.pem'), '');
      fs.writeFileSync(path.join(caRoot, 'rootCA-key.pem'), '');
      const marker = path.join(tmpDir, 'install-ran.marker');
      if (fs.existsSync(marker)) fs.rmSync(marker);
      const stub = `#!/bin/bash
case "$1" in
  -help|--help) echo ok; exit 0;;
  -version) echo "v1.4.4-stub"; exit 0;;
  -CAROOT) echo "${caRoot}"; exit 0;;
  -install) : > "${marker}"; exit 0;;
  -cert-file) shift; cp_cert="$1"; shift; shift; cp_key="$1"; cp "${fixture ? fixture.certPath : ''}" "$cp_cert"; cp "${fixture ? fixture.keyPath : ''}" "$cp_key"; exit 0;;
esac
exit 1
`;
      fs.writeFileSync(path.join(stubDir, 'mkcert'), stub, { mode: 0o755 });
      try {
        const result = httpsSetup.generateCerts({ certsDir: path.join(tmpDir, 'certs-skip-install') });
        assert.ok(fs.existsSync(result.certPath), 'cert should still be generated');
        assert.ok(!fs.existsSync(marker), 'mkcert -install must be skipped when the CA is already present');
      } finally {
        writeMkcertStub(stubDir, caRoot, fixture.certPath, fixture.keyPath);
      }
    });

    it('does not throw when mkcert -install fails (no TTY for the privileged trust step)', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const emptyCaRoot = path.join(tmpDir, 'caroot-untrusted');
      fs.mkdirSync(emptyCaRoot, { recursive: true }); // exists but no rootCA.pem → CA not installed
      const stub = `#!/bin/bash
case "$1" in
  -help|--help) echo ok; exit 0;;
  -version) echo "v1.4.4-stub"; exit 0;;
  -CAROOT) echo "${emptyCaRoot}"; exit 0;;
  -install) echo "security add-trusted-cert: a terminal is required" >&2; exit 1;;
  -cert-file) shift; cp_cert="$1"; shift; shift; cp_key="$1"; cp "${fixture ? fixture.certPath : ''}" "$cp_cert"; cp "${fixture ? fixture.keyPath : ''}" "$cp_key"; exit 0;;
esac
exit 1
`;
      fs.writeFileSync(path.join(stubDir, 'mkcert'), stub, { mode: 0o755 });
      try {
        let result;
        assert.doesNotThrow(() => { result = httpsSetup.generateCerts({ certsDir: path.join(tmpDir, 'certs-install-fails') }); });
        assert.ok(fs.existsSync(result.certPath), 'cert must be generated even though -install failed');
      } finally {
        writeMkcertStub(stubDir, caRoot, fixture.certPath, fixture.keyPath);
      }
    });
  });

  describe('validateCertFiles', () => {
    it('returns ok: true for a valid cert+key pair', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const r = httpsSetup.validateCertFiles(fixture.certPath, fixture.keyPath);
      assert.equal(r.ok, true, `expected ok, got ${r.error}`);
      assert.ok(r.expiry, 'expiry should be populated');
    });

    it('returns error when cert file is missing', () => {
      const r = httpsSetup.validateCertFiles('/tmp/nope-cert-' + Date.now(), '/tmp/nope-key');
      assert.equal(r.ok, false);
      assert.match(r.error, /not found/);
    });

    it('returns error when cert is not valid PEM', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      const badCert = path.join(tmpDir, 'bad-cert.pem');
      fs.writeFileSync(badCert, 'not a certificate');
      const r = httpsSetup.validateCertFiles(badCert, fixture.keyPath);
      assert.equal(r.ok, false);
      assert.match(r.error, /Invalid certificate/);
    });

    it('returns error when key does not match cert', (t) => {
      if (!hasOpenssl) return t.skip('openssl not available');
      // Snapshot the original cert (makeSelfSignedCert reuses filenames, so we freeze a copy first)
      const originalCert = path.join(tmpDir, 'mismatch-original-cert.pem');
      fs.copyFileSync(fixture.certPath, originalCert);

      // Generate a second independent cert+key pair in a fresh directory
      const otherDir = path.join(tmpDir, 'other-pair');
      fs.mkdirSync(otherDir);
      const other = makeSelfSignedCert(otherDir);
      assert.ok(other, 'should be able to generate a second pair');

      const r = httpsSetup.validateCertFiles(originalCert, other.keyPath);
      assert.equal(r.ok, false);
      assert.match(r.error, /do not match/);
    });

    it('returns error when certPath is empty', () => {
      const r = httpsSetup.validateCertFiles('', '');
      assert.equal(r.ok, false);
      assert.match(r.error, /required/);
    });
  });

  describe('getRemoteTrustInstructions', () => {
    it('returns steps for macOS, Linux, and Windows', () => {
      const r = httpsSetup.getRemoteTrustInstructions('/tmp/fake-caroot');
      const platforms = r.steps.map(s => s.platform);
      assert.ok(platforms.includes('macOS'));
      assert.ok(platforms.includes('Linux'));
      assert.ok(platforms.includes('Windows'));
    });

    it('includes the CAROOT path and rootCA.pem path', () => {
      const r = httpsSetup.getRemoteTrustInstructions('/tmp/fake-caroot');
      assert.equal(r.caRootPath, '/tmp/fake-caroot');
      assert.equal(r.rootCaPath, '/tmp/fake-caroot/rootCA.pem');
    });

    it('tolerates a null/empty CAROOT', () => {
      const r = httpsSetup.getRemoteTrustInstructions(null);
      assert.equal(r.caRootPath, '');
      assert.equal(r.rootCaPath, '');
      assert.ok(Array.isArray(r.steps) && r.steps.length > 0);
    });
  });
});
