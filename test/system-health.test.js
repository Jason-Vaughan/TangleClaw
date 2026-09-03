'use strict';

/*
 * #345 — the machine-wide health detectors behind GET /api/system/health.
 *
 * Each detector has THREE states and every one of them is driven here through
 * injected probes: fired, clear, and unknown-with-reason. The property under
 * test throughout is that a probe which could not run never comes back as
 * `clear` — the mutation each unknown-case guard catches is "fold the failed
 * reading into the healthy branch", which is how the watcher's own 0-on-error
 * reading would render if it were reused as-is.
 */

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const systemHealth = require('../lib/system-health');

const DARWIN = { platform: () => 'darwin', homedir: () => '/Users/op' };

/** A healthy ttyd reading. */
function healthyLeak(overrides) {
  return {
    pid: 4242,
    pool: { exhausted: false, used: 40, cap: 511, ratio: 0.078 },
    orphans: 1,
    orphanThreshold: 20,
    ptyThresholdRatio: 0.85,
    ...overrides
  };
}

/** A clean server-info snapshot. */
function syncedInfo(overrides) {
  return {
    startupSha: 'abcdef1234567',
    currentDiskSha: 'abcdef1234567',
    isStale: false,
    staleUnknownReason: null,
    commitsAhead: 0,
    runningVersion: '5.18.0',
    diskVersion: '5.18.0',
    restartMechanism: 'launchctl',
    ...overrides
  };
}

describe('lib/system-health (#345)', () => {
  beforeEach(() => systemHealth._reset());
  afterEach(() => systemHealth._reset());

  describe('detectTtydLeak', () => {
    it('is clear (not applicable) off macOS without measuring anything', () => {
      let measured = false;
      systemHealth._setProbes({ platform: () => 'linux', measureLeak: () => { measured = true; return healthyLeak(); } });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /not applicable on linux/);
      assert.equal(measured, false, 'no launchctl/ps on a platform that has neither');
    });

    it('is clear when both gates were read and neither tripped', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak() });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /40\/511/);
      assert.match(c.detail, /1 leaked/);
    });

    it('fires on pool exhaustion with the kickstart remediation', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak({ pool: { exhausted: true, used: 480, cap: 511, ratio: 0.94 } }) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /480\/511/);
      assert.equal(c.remediation, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd');
    });

    it('fires on the orphan gate alone, even with a healthy pool ratio (#380)', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak({ orphans: 90 }) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /90 leaked tmux clients/);
    });

    it('fires on the orphan gate when the pool reading failed — a broken pool never suppresses a leak', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak({ pool: null, orphans: 25 }) });
      assert.equal(systemHealth.detectTtydLeak().state, 'fired');
    });

    it('is unknown when ttyd is not running under launchd', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => ({ pid: null, pool: null, orphans: null, orphanThreshold: 20, ptyThresholdRatio: 0.85 }) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /com\.tangleclaw\.ttyd is not running/);
    });

    it('is unknown, not clear, when the pool could not be read and the orphan count is low', () => {
      // THE MUTATION THIS CATCHES: `if (poolFired || orphanFired) fired else clear` —
      // the watcher's fail-safe shape, which is right for a kickstart decision
      // and wrong for a panel that would then call a broken reading healthy.
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak({ pool: null }) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /could not read PTY pool/);
    });

    it('is unknown, not clear, when ps failed and the pool is fine', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak({ orphans: null }) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /ttyd child processes/);
    });

    it('is unknown with the error when the measurement throws', () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => { throw new Error('boom'); } });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /boom/);
    });
  });

  describe('detectStaleServer', () => {
    it('is clear when the running SHA matches disk', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo() });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /abcdef1/);
    });

    it('fires on a SHA delta with the launchctl restart as remediation', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, currentDiskSha: '9999999abcdef', commitsAhead: 3 }) });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /abcdef1.*9999999.*3 commits ahead/);
      assert.equal(c.remediation, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server');
    });

    it('leads with versions when a release is downloaded but not running', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, diskVersion: '5.19.0' }) });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /running v5\.18\.0, v5\.19\.0 is on disk/);
    });

    it('names a manual restart when no restart mechanism exists', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, restartMechanism: null }) });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.remediation, /Restart the TangleClaw server process/);
    });

    it('is unknown with the server-info reason when isStale is null (#1118)', () => {
      // THE MUTATION THIS CATCHES: `if (!info.isStale) clear` — the bare-falsy
      // check that once rendered an undetectable server as healthy.
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: null, staleUnknownReason: 'current git SHA read failed' }) });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'unknown');
      assert.equal(c.detail, 'current git SHA read failed');
    });

    it('is unknown when server-info itself throws', () => {
      systemHealth._setProbes({ serverInfo: () => { throw new Error('no git'); } });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /no git/);
    });
  });

  describe('detectFullDiskAccess', () => {
    it('is clear (not applicable) off macOS without probing', async () => {
      let probed = false;
      systemHealth._setProbes({ platform: () => 'linux', homedir: () => '/home/op', probeDir: async () => { probed = true; return { entries: 1 }; } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /no TCC gate/);
      assert.equal(probed, false);
    });

    it('probes ~/Documents and is clear when the read answers', async () => {
      const seen = [];
      systemHealth._setProbes({ ...DARWIN, probeDir: async (dir) => { seen.push(dir); return { entries: 12 }; } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'clear');
      assert.deepEqual(seen, ['/Users/op/Documents']);
      assert.match(c.detail, /12 entries/);
    });

    it('fires when the read never answered (the scanner deadline killed it)', async () => {
      systemHealth._setProbes({ ...DARWIN, probeDir: async () => { const e = new Error('did not answer'); e.tcTimedOut = true; throw e; } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /did not answer within 5s/);
      assert.match(c.remediation, /Full Disk Access/);
      assert.match(c.remediation, /com\.tangleclaw\.server/);
    });

    it('fires on the cached backoff answer too — the condition is unchanged, only its cost', async () => {
      systemHealth._setProbes({ ...DARWIN, probeDir: async () => { const e = new Error('not trying again for 30s'); e.tcTimedOut = true; e.tcCached = true; throw e; } });
      assert.equal((await systemHealth.detectFullDiskAccess()).state, 'fired');
    });

    it('is unknown, not clear, when ~/Documents does not exist', async () => {
      // THE MUTATION THIS CATCHES: treating "nothing to read" as "read fine".
      systemHealth._setProbes({ ...DARWIN, probeDir: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /does not exist/);
    });

    it('is unknown with the error for any other probe failure', async () => {
      systemHealth._setProbes({ ...DARWIN, probeDir: async () => { throw new Error('child crashed'); } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /child crashed/);
    });
  });

  describe('getHealth', () => {
    it('returns all three conditions with a timestamp, one broken probe never hiding the others', async () => {
      systemHealth._setProbes({
        ...DARWIN,
        measureLeak: () => { throw new Error('ps gone'); },
        serverInfo: () => syncedInfo({ isStale: true, commitsAhead: 1, currentDiskSha: 'fffffff000000' }),
        probeDir: async () => ({ entries: 3 })
      });
      const health = await systemHealth.getHealth();
      assert.match(health.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(health.conditions.map((c) => [c.id, c.state]), [
        ['ttyd-leak', 'unknown'],
        ['stale-server', 'fired'],
        ['full-disk-access', 'clear']
      ]);
      for (const c of health.conditions) {
        assert.equal(typeof c.title, 'string');
        assert.equal(typeof c.detail, 'string');
        assert.equal(typeof c.remediation, 'string');
      }
    });
  });

  describe('GET /api/system/health', () => {
    const { createServer } = require('../server');
    const store = require('../lib/store');
    let server;
    let port;
    let tempDir;

    before(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-system-health-test-'));
      store._setBasePath(tempDir);
      store.init();
      server = createServer();
      await new Promise((resolve) => { server.listen(0, () => { port = server.address().port; resolve(); }); });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * GET a path from the test server.
     * @param {string} urlPath - Request path.
     * @returns {Promise<{status: number, data: object}>}
     */
    function get(urlPath) {
      return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        }).on('error', reject);
      });
    }

    it('serves the detectors\' verdicts, including an unknown one, verbatim', async () => {
      systemHealth._setProbes({
        ...DARWIN,
        measureLeak: () => healthyLeak({ orphans: 30 }),
        serverInfo: () => syncedInfo(),
        probeDir: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      });
      const { status, data } = await get('/api/system/health');
      assert.equal(status, 200);
      assert.deepEqual(data.conditions.map((c) => c.state), ['fired', 'clear', 'unknown']);
      assert.equal(data.conditions[0].remediation, systemHealth.TTYD_REMEDIATION);
    });

    it('is not swallowed by the plain /api/system stats route', async () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => healthyLeak(), serverInfo: () => syncedInfo(), probeDir: async () => ({ entries: 0 }) });
      const { data } = await get('/api/system/health');
      assert.ok(Array.isArray(data.conditions), 'the health route answers with conditions, not CPU stats');
      assert.equal(data.cpu, undefined);
    });
  });
});
