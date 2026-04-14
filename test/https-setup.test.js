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
