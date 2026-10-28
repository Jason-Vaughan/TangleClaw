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
 *
 * The other property is that NOTHING here waits on a spawn: the ttyd reading is
 * cached and refreshed off the request path, so a measurement that never
 * completes cannot hold the route.
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

/**
 * A healthy ttyd reading, in the shape `ttydWatcher.measureLeak` really returns.
 *
 * Every field the producer emits is carried here deliberately — the reading's
 * identity (`generation`, `sampledAt`), the unconfirmed `transient` count, the
 * kill-switch state and the last receipt: a fixture missing a field the real
 * producer emits makes every branch that reads it unreachable, so the test
 * passes while the code is unexercised.
 */
function healthyLeak(overrides) {
  return {
    pid: 4242,
    generation: '4242@Fri Sep 25 11:28:54 2026',
    sampledAt: Date.parse('2026-09-25T18:40:00Z'),
    pool: { exhausted: false, used: 40, cap: 511, ratio: 0.078 },
    orphans: 1,
    transient: 0,
    orphanGate: false,
    orphanThreshold: 20,
    ptyThresholdRatio: 0.85,
    wedgeAgeMs: 30 * 1000,
    disabled: false,
    disabledBy: null,
    lastReceipt: null,
    ...overrides
  };
}

/** A restart-impact probe that classifies the range as code the server loads. */
const EXECUTABLE = () => ({ impact: 'executable' });

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

/**
 * Classify the ttyd condition with a fresh cache: the first call starts the
 * measurement, settling it lands the reading, the second call classifies it.
 * @param {object} probes - Probe overrides.
 * @returns {Promise<object>} The condition.
 */
async function ttydVerdict(probes) {
  systemHealth._setProbes({ ...DARWIN, ...probes });
  systemHealth.detectTtydLeak();
  await systemHealth._settleTtyd();
  return systemHealth.detectTtydLeak();
}

describe('lib/system-health (#345)', () => {
  beforeEach(() => systemHealth._reset());
  afterEach(() => systemHealth._reset());

  describe('detectTtydLeak', () => {
    it('is clear (not applicable) off macOS without measuring anything', async () => {
      let measured = false;
      systemHealth._setProbes({ platform: () => 'linux', measureLeak: async () => { measured = true; return healthyLeak(); } });
      const c = systemHealth.detectTtydLeak();
      await systemHealth._settleTtyd();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /not applicable on linux/);
      assert.equal(c.applicable, false, 'said as a value, so certification can refuse without reading detail');
      assert.equal(measured, false, 'no launchctl/ps on a platform that has neither');
    });

    it('is unknown, not clear, before the first measurement has landed', () => {
      // THE MUTATION THIS CATCHES: serving a null reading through the clear
      // branch. Before the first reading exists nothing has been measured.
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => new Promise(() => {}) });
      const c = systemHealth.detectTtydLeak();
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /first measurement is still running/);
    });

    it('never awaits the measurement — a probe that never completes does not delay the verdict', async () => {
      // THE MUTATION THIS CATCHES: `await probes.measureLeak()` on the request
      // path, which is the BLOCKING finding: `ps -A` stalls during the very
      // incident this detects.
      //
      // The probe NEVER settles, so a getHealth that awaited it could never
      // resolve: resolving at all is the proof, and no elapsed-time bound is
      // involved. The other probes are stubbed so the answer does not depend on
      // git, the filesystem or the network on a loaded host. The race below is
      // only a hang detector, so a regression fails instead of stalling the run.
      let probeStarted = false;
      systemHealth._setProbes({
        ...DARWIN,
        measureLeak: () => { probeStarted = true; return new Promise(() => {}); },
        serverInfo: () => syncedInfo(),
        restartImpact: EXECUTABLE,
        probeDir: async () => ({ entries: 3 })
      });
      const HUNG = Symbol('hung');
      let guard;
      const health = await Promise.race([
        systemHealth.getHealth(),
        new Promise((resolve) => { guard = setTimeout(() => resolve(HUNG), 30000); })
      ]);
      clearTimeout(guard);
      assert.notEqual(health, HUNG, 'getHealth waited on a measurement that never completes');
      assert.equal(probeStarted, true, 'the measurement was started, so resolving is not vacuous');
      assert.equal(health.conditions[0].state, 'unknown');
    });

    it('is clear when both gates were read and neither tripped', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak() });
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /40\/511/);
      assert.match(c.detail, /1 leaked/);
    });

    it('fires on pool exhaustion with the kickstart remediation', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ pool: { exhausted: true, used: 480, cap: 511, ratio: 0.94 } }) });
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /480\/511/);
      assert.equal(c.remediation, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd');
    });

    it('fires on the orphan gate alone, even with a healthy pool ratio (#380)', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: 90 }) });
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /90 leaked tmux clients/);
    });

    // #1245 — the count is CONFIRMED wedges only, the number the watcher acts
    // on. A reconnect burst's children are exiting but not yet confirmed; the
    // panel names them separately, so a burst is visible without reading as a
    // leak and without inviting a restart that would only make another burst.
    it('does not fire on a reconnect burst — unconfirmed exiting children are named, not counted', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: 0, transient: 25 }) });
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /0 leaked tmux clients/);
      assert.match(c.detail, /25 more exiting but not yet confirmed wedged \(not yet seen exiting for 30s\)/);
    });

    it('fires on confirmed wedges and names the unconfirmed burst beside them', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: 22, transient: 6 }) });
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /22 leaked tmux clients under ttyd \(threshold 20\)/);
      assert.match(c.detail, /6 more exiting but not yet confirmed/);
    });

    it('says nothing about transients when there are none', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: 25 }) });
      assert.equal(c.state, 'fired');
      assert.ok(!/not yet confirmed/.test(c.detail), c.detail);
    });

    // The kill switch (R22 Q5): with the watcher off nothing restarts a leaking
    // ttyd, so a healthy reading can never read as clear.
    it('is unknown — never clear — while the watcher is disabled, and names the switch', async () => {
      const c = await ttydVerdict({
        measureLeak: async () => healthyLeak({ disabled: true, disabledBy: 'TANGLECLAW_TTYD_WATCHER=off' })
      });
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /ttyd watcher is disabled \(TANGLECLAW_TTYD_WATCHER=off\)/);
      assert.match(c.detail, /40\/511 slots in use; 1 leaked tmux clients/, 'the counts are still shown');
    });

    // With the watcher off, the panel is the only thing left that can prompt a
    // restart, so a leak it can see must never be downgraded to "Could not check".
    it('still FIRES on a full pool or confirmed wedges while the watcher is disabled, and says to act by hand', async () => {
      const off = { disabled: true, disabledBy: 'TANGLECLAW_TTYD_WATCHER=off' };
      const pool = await ttydVerdict({ measureLeak: async () => healthyLeak({ ...off, pool: { exhausted: true, used: 480, cap: 511, ratio: 0.94 } }) });
      assert.equal(pool.state, 'fired');
      assert.match(pool.detail, /disabled .*restart it by hand/);
      systemHealth._reset();
      const orphans = await ttydVerdict({ measureLeak: async () => healthyLeak({ ...off, orphans: 25 }) });
      assert.equal(orphans.state, 'fired');
    });

    // The payload's `checkedAt` is the REQUEST time. Which ttyd and when it was
    // sampled have to travel with the verdict, or the panel and the watcher can
    // appear to disagree about the same instant (R22 Q2).
    it('carries the reading\'s own pid, generation and sample time, and the last receipt', async () => {
      const receipt = { at: 1, reason: 'orphan-children', from: { pid: 1, generation: 'g1' }, to: { pid: 4242, generation: 'g2' }, outcome: 'ok' };
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ lastReceipt: receipt }) });
      assert.deepEqual(c.reading, {
        pid: 4242,
        generation: '4242@Fri Sep 25 11:28:54 2026',
        sampledAt: '2026-09-25T18:40:00.000Z',
        wedged: 1,
        orphanGate: false,
        pool: { used: 40, cap: 511 },
        binary: null,
        managed: null
      });
      assert.deepEqual(c.lastReceipt, receipt);
    });

    // Release-candidate certification (#1949) judges the wedged count, the
    // orphan gate and pool use from this reading, so they travel as values a
    // machine can compare, and unmeasured stays null rather than becoming 0.
    it('carries the wedged count, orphan gate and pool use as values', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: 0, orphanGate: false }) });
      assert.equal(c.reading.wedged, 0);
      assert.equal(c.reading.orphanGate, false);
      assert.deepEqual(c.reading.pool, { used: 40, cap: 511 });
      systemHealth._reset();
      const blind = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: null, orphanGate: null, pool: null }) });
      assert.equal(blind.reading.wedged, null);
      assert.equal(blind.reading.orphanGate, null);
      assert.equal(blind.reading.pool, null);
    });

    // #1245, ADR 0018: the fix lives in the owned runtime. A machine still on
    // the Homebrew ttyd is not fixed, whatever its counts say today, and the
    // live certification must be able to see which binary it is measuring.
    it('says when launchd is running a binary other than the owned runtime', async () => {
      const managedTtydPath = () => '/Users/op/.tangleclaw/bin/ttyd';
      const c = await ttydVerdict({ managedTtydPath, measureLeak: async () => healthyLeak({ binary: '/opt/homebrew/bin/ttyd' }) });
      assert.equal(c.state, 'clear', 'a note, not a state change');
      assert.match(c.detail, /ttyd is running \/opt\/homebrew\/bin\/ttyd, not the owned runtime \/Users\/op\/\.tangleclaw\/bin\/ttyd, so the #1245 leak fix is not in force/);
      assert.equal(c.reading.binary, '/opt/homebrew/bin/ttyd');
      assert.equal(c.reading.managed, false);
    });

    it('says the binary is UNKNOWN — not "not managed" — when the probe could not read it', async () => {
      const managedTtydPath = () => '/Users/op/.tangleclaw/bin/ttyd';
      const c = await ttydVerdict({ managedTtydPath, measureLeak: async () => healthyLeak({ binary: null }) });
      assert.equal(c.reading.managed, null);
      assert.match(c.detail, /could not read which ttyd binary launchd is running/);
      assert.ok(!/not the owned runtime/.test(c.detail), c.detail);
    });

    it('says nothing extra when launchd runs the owned runtime, and marks the reading managed', async () => {
      const managedTtydPath = () => '/Users/op/.tangleclaw/bin/ttyd';
      const c = await ttydVerdict({ managedTtydPath, measureLeak: async () => healthyLeak({ binary: '/Users/op/.tangleclaw/bin/ttyd' }) });
      assert.ok(!/not in force/.test(c.detail), c.detail);
      assert.equal(c.reading.managed, true);
    });

    it('drops a cached reading once ttyd has been replaced, instead of serving the dead process\'s counts', async () => {
      let latest = '4242@Fri Sep 25 11:28:54 2026';
      let calls = 0;
      const c1 = await ttydVerdict({
        latestGeneration: () => latest,
        measureLeak: async () => { calls++; return healthyLeak({ orphans: 25 }); }
      });
      assert.equal(c1.state, 'fired');
      latest = '5555@Fri Sep 25 12:00:00 2026';
      const c2 = systemHealth.detectTtydLeak();
      assert.equal(c2.state, 'unknown');
      assert.match(c2.detail, /ttyd has restarted since the last reading/);
      await systemHealth._settleTtyd();
      assert.equal(calls, 2, 'a restart forces a re-measurement inside the TTL');
    });

    it('fires on the orphan gate when the pool reading failed — a broken pool never suppresses a leak', async () => {
      assert.equal((await ttydVerdict({ measureLeak: async () => healthyLeak({ pool: null, orphans: 25 }) })).state, 'fired');
    });

    it('is unknown when ttyd is not running under launchd', async () => {
      const c = await ttydVerdict({ measureLeak: async () => ({ pid: null, pool: null, orphans: null, orphanThreshold: 20, ptyThresholdRatio: 0.85 }) });
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /com\.tangleclaw\.ttyd is not running/);
    });

    it('is unknown, not clear, when the pool could not be read and the orphan count is low', async () => {
      // THE MUTATION THIS CATCHES: `if (poolFired || orphanFired) fired else clear` —
      // the watcher's fail-safe shape, which is right for a kickstart decision
      // and wrong for a panel that would then call a broken reading healthy.
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ pool: null }) });
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /could not read PTY pool/);
    });

    it('is unknown, not clear, when ps failed and the pool is fine', async () => {
      const c = await ttydVerdict({ measureLeak: async () => healthyLeak({ orphans: null }) });
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /ttyd child processes/);
    });

    it('is unknown with the error when the measurement rejects', async () => {
      const c = await ttydVerdict({ measureLeak: async () => { throw new Error('boom'); } });
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /boom/);
    });

    it('serves one reading per TTL however many requests arrive, then refreshes once', async () => {
      // THE MUTATION THIS CATCHES: measuring on every request (the per-tab
      // per-minute spawn storm), or never refreshing a stale reading.
      let now = 1_000_000;
      let calls = 0;
      systemHealth._setProbes({ ...DARWIN, now: () => now, measureLeak: async () => { calls++; return healthyLeak({ orphans: calls }); } });
      systemHealth.detectTtydLeak();
      await systemHealth._settleTtyd();
      for (let i = 0; i < 5; i++) systemHealth.detectTtydLeak();
      await systemHealth._settleTtyd();
      assert.equal(calls, 1, 'five polls inside the TTL cost no measurement');
      now += systemHealth.TTYD_CACHE_TTL_MS;
      const stale = systemHealth.detectTtydLeak();
      assert.match(stale.detail, /1 leaked/, 'the stale reading is served while the refresh runs');
      systemHealth.detectTtydLeak();
      await systemHealth._settleTtyd();
      assert.equal(calls, 2, 'one refresh, single-flighted across the two stale polls');
      assert.match(systemHealth.detectTtydLeak().detail, /2 leaked/);
    });

    it('keeps the last good reading when a later refresh never completes', async () => {
      let now = 1_000_000;
      let hang = false;
      systemHealth._setProbes({ ...DARWIN, now: () => now, measureLeak: () => (hang ? new Promise(() => {}) : Promise.resolve(healthyLeak())) });
      systemHealth.detectTtydLeak();
      await systemHealth._settleTtyd();
      hang = true;
      now += systemHealth.TTYD_CACHE_TTL_MS;
      assert.equal(systemHealth.detectTtydLeak().state, 'clear');
    });
  });

  describe('warm', () => {
    it('starts the first measurement on macOS and skips it elsewhere', async () => {
      let calls = 0;
      systemHealth._setProbes({ ...DARWIN, measureLeak: async () => { calls++; return healthyLeak(); } });
      systemHealth.warm();
      await systemHealth._settleTtyd();
      assert.equal(calls, 1);
      assert.equal(systemHealth.detectTtydLeak().state, 'clear', 'the first poll after boot finds a reading');

      systemHealth._reset();
      systemHealth._setProbes({ platform: () => 'linux', measureLeak: async () => { calls++; return healthyLeak(); } });
      systemHealth.warm();
      await systemHealth._settleTtyd();
      assert.equal(calls, 1, 'nothing to warm where the condition cannot exist');
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
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, currentDiskSha: '9999999abcdef', commitsAhead: 3 }) , restartImpact: EXECUTABLE });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /abcdef1.*9999999.*3 commits ahead/);
      assert.equal(c.remediation, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server');
    });

    it('leads with versions when a release is downloaded but not running', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, diskVersion: '5.19.0' }) , restartImpact: EXECUTABLE });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /running v5\.18\.0, v5\.19\.0 is on disk/);
    });

    it('names a manual restart when no restart mechanism exists', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true, restartMechanism: null }) , restartImpact: EXECUTABLE });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.match(c.remediation, /Restart the TangleClaw server process/);
    });

    it('is clear for a records-only range, saying no restart is needed (#1678)', () => {
      const seen = [];
      systemHealth._setProbes({
        serverInfo: () => syncedInfo({ isStale: true, currentDiskSha: '9999999abcdef', commitsAhead: 2 }),
        restartImpact: (info) => { seen.push([info.startupSha, info.currentDiskSha]); return { impact: 'records-only' }; }
      });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'clear');
      assert.match(c.detail, /abcdef1.*9999999.*records-only commits, no restart needed/);
      assert.deepEqual(seen, [['abcdef1234567', '9999999abcdef']], 'classifies the running-to-disk range');
    });

    it('fires for a mixed range', () => {
      systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true }), restartImpact: () => ({ impact: 'mixed' }) });
      const c = systemHealth.detectStaleServer();
      assert.equal(c.state, 'fired');
      assert.doesNotMatch(c.detail, /unknown|no restart/);
    });

    for (const [label, probe] of [
      ['pending', () => ({ impact: 'pending' })],
      ['unknown', () => ({ impact: 'unknown' })],
      ['absent', () => null],
      ['throwing', () => { throw new Error('boom'); }]
    ]) {
      it(`stays fired when the restart impact is ${label}: missing evidence never clears it`, () => {
        systemHealth._setProbes({ serverInfo: () => syncedInfo({ isStale: true }), restartImpact: probe });
        const c = systemHealth.detectStaleServer();
        assert.equal(c.state, 'fired');
        assert.match(c.detail, /restart impact unknown/);
      });
    }

    it('does not classify anything when the server is not stale', () => {
      let calls = 0;
      systemHealth._setProbes({ serverInfo: () => syncedInfo(), restartImpact: () => { calls += 1; return { impact: 'records-only' }; } });
      assert.equal(systemHealth.detectStaleServer().state, 'clear');
      assert.equal(calls, 0);
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

    it('fires when the read never answered (the scanner deadline killed it), with a runnable fix and a prose hint', async () => {
      systemHealth._setProbes({ ...DARWIN, probeDir: async () => { const e = new Error('did not answer'); e.tcTimedOut = true; throw e; } });
      const c = await systemHealth.detectFullDiskAccess();
      assert.equal(c.state, 'fired');
      assert.match(c.detail, /did not answer within 5s/);
      assert.equal(c.remediation, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server', 'the copyable line is a command');
      assert.match(c.hint, /Full Disk Access/);
      assert.match(c.hint, /which node/);
      assert.doesNotMatch(c.remediation, /System Settings/, 'prose stays out of the <code>');
    });

    it('fires on an EPERM/EACCES refusal too — a denied read is the TCC outcome, not a mystery', async () => {
      // THE MUTATION THIS CATCHES: routing a refusal into the generic unknown
      // branch. When macOS does answer, and answers no, that IS the missing grant.
      for (const code of ['EPERM', 'EACCES']) {
        systemHealth._setProbes({ ...DARWIN, probeDir: async () => { const e = new Error('refused'); e.code = code; throw e; } });
        const c = await systemHealth.detectFullDiskAccess();
        assert.equal(c.state, 'fired', code);
        assert.match(c.detail, new RegExp(`refused the read \\(${code}\\)`));
      }
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
    it('returns every condition with a timestamp, one broken probe never hiding the others', async () => {
      systemHealth._setProbes({
        ...DARWIN,
        measureLeak: async () => { throw new Error('ps gone'); },
        serverInfo: () => syncedInfo({ isStale: true, commitsAhead: 1, currentDiskSha: 'fffffff000000' }),
        restartImpact: EXECUTABLE,
        probeDir: async () => ({ entries: 3 })
      });
      systemHealth.warm();
      await systemHealth._settleTtyd();
      const health = await systemHealth.getHealth();
      assert.match(health.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(health.conditions.map((c) => [c.id, c.state]), [
        ['ttyd-leak', 'unknown'],
        ['stale-server', 'fired'],
        ['full-disk-access', 'clear'],
        // No listener is running in this process, so the Bridge is not required
        // and the condition is measured-and-absent rather than unknown.
        ['medusa-bridge', 'clear']
      ]);
      for (const c of health.conditions) {
        assert.equal(typeof c.title, 'string');
        assert.equal(typeof c.detail, 'string');
        assert.equal(typeof c.remediation, 'string');
      }
    });
  });

describe('the Medusa Bridge condition (#1130)', () => {
  // Fires only when something DEPENDS on the Bridge. A condition that fires on
  // every install is one operators learn to ignore, and a host that never enabled
  // Medusa does not have a problem.

  it('is clear when no listener is running, without probing at all', async () => {
    let probed = false;
    const c = await systemHealth.detectMedusaBridge({
      medusaListenerCount: () => 0,
      medusaBridgeHealth: async () => { probed = true; return { healthy: true }; }
    });
    assert.equal(c.state, systemHealth.STATE_CLEAR);
    assert.equal(probed, false, 'a host with no listeners must not pay for a probe');
  });

  it('fires when listeners are running against an unusable Bridge, naming the code and the remedy', async () => {
    const c = await systemHealth.detectMedusaBridge({
      medusaListenerCount: () => 2,
      medusaBridgeHealth: async () => ({
        healthy: false, code: 'BRIDGE_ABSENT', detail: 'nothing answered anywhere',
        hint: 'install it', httpUrl: 'http://localhost:3009'
      })
    });
    assert.equal(c.state, systemHealth.STATE_FIRED);
    assert.match(c.detail, /2 listener/);
    assert.match(c.detail, /BRIDGE_ABSENT/);
    assert.equal(c.hint, 'install it');
    assert.match(c.remediation, /curl .*\/health/);
  });

  it('a probe that TIMED OUT is unknown, not fired — the panel must not assert a negative', async () => {
    // One layer up from the ABSENT/UNKNOWN split inside the probe: reporting
    // `fired` for a check that merely did not finish is the same false certainty,
    // wearing the panel's vocabulary instead of the probe's.
    const c = await systemHealth.detectMedusaBridge({
      medusaListenerCount: () => 2,
      medusaBridgeHealth: async () => ({
        healthy: false, code: 'BRIDGE_UNKNOWN',
        detail: 'the Bridge could not be checked within 2000ms',
        hint: 'This is a check that did not finish, not a Bridge that is missing.',
        httpUrl: 'http://localhost:3009'
      })
    });
    assert.equal(c.state, systemHealth.STATE_UNKNOWN);
    assert.notEqual(c.state, systemHealth.STATE_FIRED);
    assert.doesNotMatch(c.detail, /not usable/, 'an unfinished check states no verdict about the Bridge');
  });

  it('reports UNKNOWN, never clear, when the probe itself could not be made', async () => {
    // The three-state vocabulary is why this module was the right home: a probe
    // that could not run has not said the Bridge is fine.
    const c = await systemHealth.detectMedusaBridge({
      medusaListenerCount: () => 1,
      medusaBridgeHealth: async () => { throw new Error('probe exploded'); }
    });
    assert.equal(c.state, systemHealth.STATE_UNKNOWN);
    assert.notEqual(c.state, systemHealth.STATE_CLEAR);
    assert.match(c.detail, /probe exploded/);
  });

  it('reports UNKNOWN when even the listener count cannot be read', async () => {
    const c = await systemHealth.detectMedusaBridge({
      medusaListenerCount: () => { throw new Error('module gone'); }
    });
    assert.equal(c.state, systemHealth.STATE_UNKNOWN);
  });

  it('counts through the listener map, so the Project Master is covered', () => {
    // ADR 0008: the master has no sessions row and was the first listener the
    // install in #1130 saw fail. A sessions-table walk would skip exactly it.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'system-health.js'), 'utf8');
    const fn = source.slice(source.indexOf('async function detectMedusaBridge'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(!/store\.sessions|sessions\.getActive/.test(body),
      'the condition must not iterate the sessions table — that is what skips the master');
    assert.match(body, /medusaListenerCount/);
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
        measureLeak: async () => healthyLeak({ orphans: 30 }),
        serverInfo: () => syncedInfo(),
        probeDir: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      });
      systemHealth.warm();
      await systemHealth._settleTtyd();
      const { status, data } = await get('/api/system/health');
      assert.equal(status, 200);
      assert.deepEqual(data.conditions.map((c) => c.state), ['fired', 'clear', 'unknown', 'clear']);
      assert.equal(data.conditions[0].remediation, systemHealth.TTYD_REMEDIATION);
      assert.equal(data.conditions[2].hint, systemHealth.FDA_HINT);
    });

    it('answers promptly while the ttyd measurement never completes', async () => {
      // THE MUTATION THIS CATCHES: any `await` of the measurement on the route.
      systemHealth._setProbes({ ...DARWIN, measureLeak: () => new Promise(() => {}), serverInfo: () => syncedInfo(), probeDir: async () => ({ entries: 0 }) });
      const started = Date.now();
      const { status, data } = await get('/api/system/health');
      assert.equal(status, 200);
      assert.ok(Date.now() - started < 1000, 'the response did not wait on the probe');
      assert.equal(data.conditions[0].state, 'unknown');
    });

    it('is not swallowed by the plain /api/system stats route', async () => {
      systemHealth._setProbes({ ...DARWIN, measureLeak: async () => healthyLeak(), serverInfo: () => syncedInfo(), probeDir: async () => ({ entries: 0 }) });
      const { data } = await get('/api/system/health');
      assert.ok(Array.isArray(data.conditions), 'the health route answers with conditions, not CPU stats');
      assert.equal(data.cpu, undefined);
    });
  });
});

describe('GET /api/health — public assets (#1368)', () => {
  // #1368 — a moved or renamed install directory leaves the server running
  // but serving no UI: every route under public/ 404s while the API itself
  // stays up. _checkPublicAssets is the detector; GET /api/health is where
  // it surfaces. The route always resolves PUBLIC_DIR to this repo's real
  // `public/` directory (which is always present in CI), so the degraded
  // branch is exercised directly against `_checkPublicAssets`, which takes
  // the directory as a parameter for exactly this reason; the wiring from
  // that helper into the route's `allOk`/`services.assets` is pinned by
  // source probes below rather than by moving the real directory out from
  // under a server that's live in another test file.
  const { _checkPublicAssets } = require('../server');

  describe('_checkPublicAssets', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-public-assets-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('is true when the directory and index.html both exist', () => {
      fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
      assert.equal(_checkPublicAssets(dir), true);
    });

    it('is false when the directory itself is missing', () => {
      assert.equal(_checkPublicAssets(path.join(dir, 'no-such-dir')), false);
    });

    it('is false when the directory exists but index.html does not', () => {
      assert.equal(_checkPublicAssets(dir), false);
    });

    it('defaults to this install\'s real public/ directory, which exists in this checkout', () => {
      assert.equal(_checkPublicAssets(), true);
    });
  });

  describe('GET /api/health response shape', () => {
    const { createServer } = require('../server');
    const store = require('../lib/store');
    let server, port, tempDir;

    before(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-health-assets-test-'));
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

    it('reports services.assets ok against this checkout\'s real public/ directory', async () => {
      const { data } = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        }).on('error', reject);
      });
      assert.equal(data.services.assets, 'ok');
    });
  });

  describe('the degraded verdict and the boot warning reach the operator (source probes)', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    it('GET /api/health folds assetsOk into allOk and reports services.assets', () => {
      const src = read('server.js');
      assert.match(src, /^\s*const allOk = dbStatus === 'ok' && ttyd === 'ok' && assetsOk;$/m);
      assert.match(src, /^\s*assets: assetsOk \? 'ok' : 'unavailable'$/m);
    });

    it('boot logs an error naming the install-moved cause when assets are missing', () => {
      const src = read('server.js');
      assert.match(src, /if \(!_checkPublicAssets\(\)\) \{/);
      assert.match(src, /log\.error\('Static asset directory \(public\/index\.html\) is missing or unreadable — UI routes will 404; '/);
      assert.match(src, /check if the install directory was moved or renamed while running/);
    });
  });
});

// #2140 — the restart route's 300ms-later exec regressed to a false
// "spawnSync /bin/sh ETIMEDOUT" failure log on a SUCCESSFUL restart: the
// synchronous execSync held the event loop for up to its own 5s timeout,
// which kept this process from handling the SIGTERM the restart mechanism
// sent it the instant the new process came up. Landed here (not in
// test/api-system.test.js, where POST /api/server/restart's other
// contract tests live) because this car's authorized file scope names only
// test/system-health.test.js and test/launchagent-scan.test.js — flagged in
// the PR body as a dispatch gap rather than expanding scope mid-build.
describe('POST /api/server/restart — non-blocking exec (#2140)', () => {
  const { createServer } = require('../server');
  const store = require('../lib/store');
  const serverInfo = require('../lib/server-info');
  const { operatorHeaders } = require('./_shared-docs-callers');
  let server, port, tempDir;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-restart-nonblocking-test-'));
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

  function request(method, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: operatorHeaders(server) }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('answers a concurrent request while the scheduled exec is in flight — the mutation this catches is execSync back on the event loop', async () => {
    const origDetect = serverInfo.detectRestartMechanism;
    const origConfirm = serverInfo.confirmRestartMechanism;
    const origBuild = serverInfo.buildRestartCommand;
    serverInfo.detectRestartMechanism = () => 'launchctl';
    // confirmRestartMechanism's re-check for 'launchctl' asks whether THIS
    // process (the test runner) was started by launchd (#1555) — never true
    // here — so it must be stubbed alongside detectRestartMechanism.
    serverInfo.confirmRestartMechanism = () => ({ ok: true, reason: null });
    // Long enough that a blocking execSync would still be holding the event
    // loop when the concurrent GET below is sent.
    serverInfo.buildRestartCommand = () => 'sleep 2';
    try {
      const { status } = await request('POST', '/api/server/restart');
      assert.equal(status, 202);
      await new Promise((resolve) => setTimeout(resolve, 350)); // past the route's 300ms delay; the exec is now running
      const started = Date.now();
      const version = await request('GET', '/api/version');
      assert.equal(version.status, 200);
      assert.ok(Date.now() - started < 500, 'a concurrent request must not wait on the pending restart exec');
    } finally {
      serverInfo.detectRestartMechanism = origDetect;
      serverInfo.confirmRestartMechanism = origConfirm;
      serverInfo.buildRestartCommand = origBuild;
      await new Promise((resolve) => setTimeout(resolve, 1700)); // drain the sleep before after() tears the server down
    }
  });

  it('does not log an exec-failed line when the child dies to the process\'s own SIGTERM (the expected successful-restart path)', async () => {
    const origDetect = serverInfo.detectRestartMechanism;
    const origConfirm = serverInfo.confirmRestartMechanism;
    const origBuild = serverInfo.buildRestartCommand;
    const origError = console.error;
    const logged = [];
    serverInfo.detectRestartMechanism = () => 'launchctl';
    serverInfo.confirmRestartMechanism = () => ({ ok: true, reason: null });
    // Simulates what a real restart mechanism does to this process: deliver
    // SIGTERM to the child exec spawned, without the child ever reporting a
    // non-zero exit for any OTHER reason.
    serverInfo.buildRestartCommand = () => 'kill -TERM $$; sleep 1';
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      const { status } = await request('POST', '/api/server/restart');
      assert.equal(status, 202);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(!logged.some((l) => l.includes('[server-restart] exec failed')),
        `a SIGTERM-killed child must not be logged as a failure, got: ${JSON.stringify(logged)}`);
    } finally {
      console.error = origError;
      serverInfo.detectRestartMechanism = origDetect;
      serverInfo.confirmRestartMechanism = origConfirm;
      serverInfo.buildRestartCommand = origBuild;
    }
  });

  it('still logs when the command genuinely hangs and node has to kill it on timeout — the guard must not swallow a real failure', async () => {
    // Distinguishes the two signal: 'SIGTERM' cases: a child that
    // self-terminates (killed: false, the test above) is the expected
    // shutdown path, but a command that just hangs and gets killed by
    // node's own `{ timeout: 5000 }` (killed: true) is a genuine failure —
    // the previous execSync path always logged this, and a guard that
    // conflates the two would silently drop it.
    const origDetect = serverInfo.detectRestartMechanism;
    const origConfirm = serverInfo.confirmRestartMechanism;
    const origBuild = serverInfo.buildRestartCommand;
    const origError = console.error;
    const logged = [];
    serverInfo.detectRestartMechanism = () => 'launchctl';
    serverInfo.confirmRestartMechanism = () => ({ ok: true, reason: null });
    serverInfo.buildRestartCommand = () => 'sleep 30';
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      const { status } = await request('POST', '/api/server/restart');
      assert.equal(status, 202);
      // Past the route's 300ms delay plus the exec's own 5000ms timeout.
      await new Promise((resolve) => setTimeout(resolve, 5600));
      const line = logged.find((l) => l.includes('[server-restart] exec failed'));
      assert.ok(line, `a node-enforced timeout kill must still be logged, got: ${JSON.stringify(logged)}`);
    } finally {
      console.error = origError;
      serverInfo.detectRestartMechanism = origDetect;
      serverInfo.confirmRestartMechanism = origConfirm;
      serverInfo.buildRestartCommand = origBuild;
    }
  });

  it('wires exec (not execSync) with the signal/killed guard (source probe)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const route = src.slice(src.indexOf("route('POST', '/api/server/restart'"));
    const body = route.slice(0, route.indexOf('\n});\n'));
    assert.doesNotMatch(body, /execSync\(/, 'the restart exec must not block the event loop');
    assert.match(body, /require\('node:child_process'\)\.exec\(command, \{ timeout: 5000 \}/);
    assert.match(body, /if \(err\.signal === 'SIGTERM' && !err\.killed\) return;/);
  });
});
