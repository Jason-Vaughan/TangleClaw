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
