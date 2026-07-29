'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const updateChecker = require('../lib/update-checker');

describe('update-checker', () => {
  afterEach(() => {
    updateChecker._reset();
  });

  describe('parseSemver', () => {
    it('parses standard semver string', () => {
      const result = updateChecker.parseSemver('3.1.5');
      assert.deepEqual(result, { major: 3, minor: 1, patch: 5 });
    });

    it('strips leading v', () => {
      const result = updateChecker.parseSemver('v3.2.0');
      assert.deepEqual(result, { major: 3, minor: 2, patch: 0 });
    });

    it('ignores pre-release suffix', () => {
      const result = updateChecker.parseSemver('3.2.0-beta.1');
      assert.deepEqual(result, { major: 3, minor: 2, patch: 0 });
    });

    it('returns null for invalid input', () => {
      assert.equal(updateChecker.parseSemver(null), null);
      assert.equal(updateChecker.parseSemver(''), null);
      assert.equal(updateChecker.parseSemver('not-a-version'), null);
      assert.equal(updateChecker.parseSemver('1.2'), null);
    });
  });

  describe('compareSemver', () => {
    it('returns 0 for equal versions', () => {
      const a = { major: 3, minor: 1, patch: 5 };
      const b = { major: 3, minor: 1, patch: 5 };
      assert.equal(updateChecker.compareSemver(a, b), 0);
    });

    it('returns 1 when a is newer (major)', () => {
      const a = { major: 4, minor: 0, patch: 0 };
      const b = { major: 3, minor: 9, patch: 9 };
      assert.equal(updateChecker.compareSemver(a, b), 1);
    });

    it('returns -1 when a is older (major)', () => {
      const a = { major: 2, minor: 9, patch: 9 };
      const b = { major: 3, minor: 0, patch: 0 };
      assert.equal(updateChecker.compareSemver(a, b), -1);
    });

    it('returns 1 when a is newer (minor)', () => {
      const a = { major: 3, minor: 2, patch: 0 };
      const b = { major: 3, minor: 1, patch: 9 };
      assert.equal(updateChecker.compareSemver(a, b), 1);
    });

    it('returns -1 when a is older (minor)', () => {
      const a = { major: 3, minor: 1, patch: 9 };
      const b = { major: 3, minor: 2, patch: 0 };
      assert.equal(updateChecker.compareSemver(a, b), -1);
    });

    it('returns 1 when a is newer (patch)', () => {
      const a = { major: 3, minor: 1, patch: 6 };
      const b = { major: 3, minor: 1, patch: 5 };
      assert.equal(updateChecker.compareSemver(a, b), 1);
    });

    it('returns -1 when a is older (patch)', () => {
      const a = { major: 3, minor: 1, patch: 4 };
      const b = { major: 3, minor: 1, patch: 5 };
      assert.equal(updateChecker.compareSemver(a, b), -1);
    });
  });

  describe('parseTagsOutput', () => {
    it('parses standard git ls-remote output', () => {
      const output = [
        'abc123\trefs/tags/v3.0.0',
        'def456\trefs/tags/v3.1.0',
        'ghi789\trefs/tags/v3.1.5'
      ].join('\n');
      const result = updateChecker.parseTagsOutput(output);
      assert.deepEqual(result, ['v3.0.0', 'v3.1.0', 'v3.1.5']);
    });

    it('filters out annotated tag derefs', () => {
      const output = [
        'abc123\trefs/tags/v3.0.0',
        'def456\trefs/tags/v3.0.0^{}'
      ].join('\n');
      const result = updateChecker.parseTagsOutput(output);
      assert.deepEqual(result, ['v3.0.0']);
    });

    it('handles tags without v prefix', () => {
      const output = 'abc123\trefs/tags/3.1.0\n';
      const result = updateChecker.parseTagsOutput(output);
      assert.deepEqual(result, ['3.1.0']);
    });

    it('ignores non-semver tags', () => {
      const output = [
        'abc\trefs/tags/release-candidate',
        'def\trefs/tags/v3.1.0',
        'ghi\trefs/tags/latest'
      ].join('\n');
      const result = updateChecker.parseTagsOutput(output);
      assert.deepEqual(result, ['v3.1.0']);
    });

    it('returns empty array for empty/null input', () => {
      assert.deepEqual(updateChecker.parseTagsOutput(''), []);
      assert.deepEqual(updateChecker.parseTagsOutput(null), []);
    });

    it('handles whitespace and blank lines', () => {
      const output = '\n  abc123\trefs/tags/v3.0.0  \n\n';
      const result = updateChecker.parseTagsOutput(output);
      assert.deepEqual(result, ['v3.0.0']);
    });
  });

  describe('findLatestVersion', () => {
    it('returns the highest version', () => {
      const versions = ['v3.0.0', 'v3.1.5', 'v3.1.0', 'v3.2.0'];
      assert.equal(updateChecker.findLatestVersion(versions), 'v3.2.0');
    });

    it('returns null for empty array', () => {
      assert.equal(updateChecker.findLatestVersion([]), null);
    });

    it('handles single version', () => {
      assert.equal(updateChecker.findLatestVersion(['v1.0.0']), 'v1.0.0');
    });

    it('compares across major versions', () => {
      const versions = ['v2.9.9', 'v3.0.0', 'v1.99.99'];
      assert.equal(updateChecker.findLatestVersion(versions), 'v3.0.0');
    });
  });

  describe('getCachedStatus', () => {
    it('returns default status when no check has been done', () => {
      const status = updateChecker.getCachedStatus();
      assert.equal(status.updateAvailable, false);
      assert.equal(status.latestVersion, null);
      assert.equal(status.checkedAt, null);
      assert.equal(typeof status.currentVersion, 'string');
    });

    it('returns cached result after checkForUpdate', () => {
      // This will run an actual git ls-remote — it may fail (no remote)
      // but the cache should still be populated
      updateChecker.checkForUpdate();
      const status = updateChecker.getCachedStatus();
      assert.notEqual(status.checkedAt, null);
      assert.equal(typeof status.updateAvailable, 'boolean');
    });

    it('carries the install repoRoot in the default (uncached) status (#183)', () => {
      const status = updateChecker.getCachedStatus();
      assert.equal(status.repoRoot, path.resolve(__dirname, '..'));
    });

    it('carries the install repoRoot after checkForUpdate, success or failure (#183)', () => {
      updateChecker.checkForUpdate();
      const status = updateChecker.getCachedStatus();
      assert.equal(status.repoRoot, path.resolve(__dirname, '..'));
    });
  });

  describe('startChecker / stopChecker', () => {
    it('starts and stops without error', () => {
      // Use long delays so nothing actually fires during the test
      updateChecker.startChecker(999999, 999999);
      updateChecker.stopChecker();
    });

    it('calling stop twice is safe', () => {
      updateChecker.startChecker(999999, 999999);
      updateChecker.stopChecker();
      updateChecker.stopChecker(); // should not throw
    });

    it('calling start twice replaces the previous timer', () => {
      updateChecker.startChecker(999999, 999999);
      updateChecker.startChecker(999999, 999999); // should not throw
      updateChecker.stopChecker();
    });
  });
});

describe('resolveCheckInterval (#720)', () => {
  const uc = require('../lib/update-checker');

  it('defaults to 4 hours, not the 24 it shipped with', () => {
    assert.equal(uc.DEFAULT_CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000);
    assert.deepEqual(uc.resolveCheckInterval(undefined), { intervalMs: 4 * 60 * 60 * 1000, warning: null });
    assert.deepEqual(uc.resolveCheckInterval(null), { intervalMs: 4 * 60 * 60 * 1000, warning: null });
  });

  it('honors a valid configured interval', () => {
    assert.deepEqual(uc.resolveCheckInterval(7200000), { intervalMs: 7200000, warning: null });
  });

  it('rejects a non-number rather than feeding it to setInterval', () => {
    const r = uc.resolveCheckInterval('4h');
    assert.equal(r.intervalMs, uc.DEFAULT_CHECK_INTERVAL_MS);
    assert.match(r.warning, /must be a number/);
  });

  it('rejects NaN and Infinity', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = uc.resolveCheckInterval(bad);
      assert.equal(r.intervalMs, uc.DEFAULT_CHECK_INTERVAL_MS, `${bad} should fall back`);
      assert.ok(r.warning);
    }
  });

  it('rejects a value below the floor — a typo must not become a tight poll on origin', () => {
    const r = uc.resolveCheckInterval(1000);
    assert.equal(r.intervalMs, uc.DEFAULT_CHECK_INTERVAL_MS);
    assert.match(r.warning, /below the .* floor/);
    assert.deepEqual(uc.resolveCheckInterval(uc.MIN_CHECK_INTERVAL_MS),
      { intervalMs: uc.MIN_CHECK_INTERVAL_MS, warning: null }, 'the floor itself is allowed');
  });
});

/*
 * #716 — an answer nobody re-measures is not an answer.
 *
 * Reproduced on this repo 2026-07-29: the server checked once, 60s after boot,
 * 37 minutes before the release it was asked about existed, and the next check
 * was four hours out. GET /api/update-status is a pure cache read, so the
 * dashboard's own 5-minute poll re-read that same stale value ~48 times.
 */
describe('#716 measuring on demand', () => {
  const uc = require('../lib/update-checker');
  const TAGS = '0000\trefs/tags/v9.9.9\n1111\trefs/tags/v1.0.0\n';

  let realLsRemote;
  let realGitRemote;

  beforeEach(() => {
    realLsRemote = uc._internal.lsRemote;
    realGitRemote = uc._internal.gitRemote;
    uc._reset();
  });

  afterEach(() => {
    uc._internal.lsRemote = realLsRemote;
    uc._internal.gitRemote = realGitRemote;
    uc._reset();
  });

  /**
   * Install an lsRemote stub and count how often the network was touched.
   * @param {string|null} output - stdout to yield, or null to fail the call
   * @returns {{count: () => number}}
   */
  function stubLsRemote(output) {
    let calls = 0;
    uc._internal.lsRemote = (cb) => {
      calls++;
      // Async on purpose: a synchronous stub would let a broken single-flight
      // pass, because the second caller could never arrive mid-check.
      setImmediate(() => (output === null
        ? cb(new Error('offline'), '')
        : cb(null, output)));
    };
    return { count: () => calls };
  }

  /** @returns {Promise<{status: object, refreshed: boolean}>} */
  function refresh(maxAgeMs) {
    return new Promise((resolve) => {
      uc.refreshIfStale(maxAgeMs, (status, refreshed) => resolve({ status, refreshed }));
    });
  }

  describe('_buildStatus separates "could not measure" from "nothing to offer"', () => {
    it('reports a failed query as checkOk:false, never as up to date', () => {
      // Before this field these two produced byte-identical payloads, so an
      // offline install rendered exactly like a current one.
      const s = uc._buildStatus('1.0.0', null, '2026-07-29T00:00:00Z');
      assert.equal(s.checkOk, false);
      assert.equal(s.updateAvailable, false);
      assert.equal(s.latestVersion, null);
    });

    it('reports a reachable remote with no version tags as a real measurement', () => {
      const s = uc._buildStatus('1.0.0', 'abc\trefs/heads/main\n', '2026-07-29T00:00:00Z');
      assert.equal(s.checkOk, true, 'nothing to offer IS an answer');
      assert.equal(s.latestVersion, null);
    });

    it('still detects a newer tag', () => {
      const s = uc._buildStatus('1.0.0', TAGS, '2026-07-29T00:00:00Z');
      assert.equal(s.checkOk, true);
      assert.equal(s.updateAvailable, true);
      assert.equal(s.latestVersion, '9.9.9');
    });

    it('cannot measure without a current version to compare against', () => {
      const s = uc._buildStatus(null, TAGS, '2026-07-29T00:00:00Z');
      assert.equal(s.checkOk, false);
      assert.equal(s.currentVersion, null);
    });
  });

  it('both transports interpret the tag list in one place', () => {
    // The sync form still serves the timer and update-applier; the async form
    // serves requests. Two parsers would eventually disagree about the same
    // remote, and the disagreement would surface as a phantom or missing pill.
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'lib', 'update-checker.js'), 'utf8');
    const sync = src.slice(src.indexOf('function checkForUpdate('), src.indexOf('function checkForUpdateAsync('));
    const async_ = src.slice(src.indexOf('function checkForUpdateAsync('), src.indexOf('function refreshIfStale('));
    assert.match(sync, /_buildStatus\(/, 'checkForUpdate must delegate parsing');
    assert.match(async_, /_buildStatus\(/, 'checkForUpdateAsync must delegate parsing');
  });

  describe('refreshIfStale', () => {
    it('measures when nothing has ever been checked, whatever the floor', async () => {
      // The state every freshly booted server sits in, and precisely when an
      // answer is most wanted — a cold cache must never be served as fresh.
      const net = stubLsRemote(TAGS);
      const { refreshed, status } = await refresh(60 * 60 * 1000);
      assert.equal(refreshed, true);
      assert.equal(net.count(), 1);
      assert.equal(status.checkOk, true);
    });

    it('serves the cache inside the window instead of touching the network', async () => {
      const net = stubLsRemote(TAGS);
      await refresh(60000);
      assert.equal(net.count(), 1);

      const second = await refresh(60000);
      assert.equal(second.refreshed, false, 'a reload loop must not become a git ls-remote loop');
      assert.equal(net.count(), 1);
    });

    it('measures again once the cache ages past the window', async () => {
      const net = stubLsRemote(TAGS);
      await refresh(60000);
      // Age the cached answer rather than sleeping.
      uc.getCachedStatus().checkedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const again = await refresh(60000);
      assert.equal(again.refreshed, true);
      assert.equal(net.count(), 2);
    });

    it('does not trust a timestamp from the future', async () => {
      const net = stubLsRemote(TAGS);
      await refresh(60000);
      uc.getCachedStatus().checkedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const again = await refresh(60000);
      assert.equal(again.refreshed, true, 'clock skew must fail toward measuring, not toward silence');
      assert.equal(net.count(), 2);
    });

    it('coalesces concurrent callers into one network call', async () => {
      // Every open tab refreshes on focus. Without single-flight, N tabs are N
      // simultaneous git ls-remote calls against origin.
      const net = stubLsRemote(TAGS);
      const results = await Promise.all([refresh(60000), refresh(60000), refresh(60000)]);
      assert.equal(net.count(), 1);
      for (const r of results) {
        assert.equal(r.refreshed, true);
        assert.equal(r.status.latestVersion, '9.9.9', 'every waiter gets the real result');
      }
    });

    it('reports a failed measurement rather than a false all-clear', async () => {
      const net = stubLsRemote(null);
      const { status, refreshed } = await refresh(60000);
      assert.equal(refreshed, true);
      assert.equal(net.count(), 1);
      assert.equal(status.checkOk, false);
      assert.equal(status.updateAvailable, false);
    });

    it('releases the in-flight queue so a later caller can measure again', async () => {
      // A queue left populated would strand every subsequent caller forever.
      const net = stubLsRemote(TAGS);
      await refresh(60000);
      uc.getCachedStatus().checkedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const again = await refresh(60000);
      assert.equal(again.refreshed, true);
      assert.equal(net.count(), 2);
    });
  });

  it('gives an operator-initiated check a much shorter floor than an automatic one', () => {
    // Same throttle, two floors: an automatic refocus should settle for a recent
    // answer; someone who deliberately asked is owed a real measurement.
    assert.ok(uc.MANUAL_REFRESH_MIN_AGE_MS < uc.AUTO_REFRESH_MIN_AGE_MS);
    assert.ok(uc.MANUAL_REFRESH_MIN_AGE_MS > 0, 'still guards against a double-tap');
  });

  describe('the origin lookup is memoized, but only when it answered', () => {
    /** @returns {{count: () => number}} */
    function stubGitRemote(value) {
      let calls = 0;
      uc._internal.gitRemote = () => {
        calls++;
        if (value instanceof Error) throw value;
        return value;
      };
      return { count: () => calls };
    }

    it('spawns once for a real answer, not on every request', () => {
      // This is a SYNCHRONOUS spawn now reached from every page load and tab
      // refocus. Without the memo it is a 2s-timeout blocking call on the hot
      // request path.
      const git = stubGitRemote('https://github.com/o/r.git\n');
      const first = uc._getReleasesUrlBase();
      const second = uc._getReleasesUrlBase();
      assert.equal(first, 'https://github.com/o/r/releases/tag/');
      assert.equal(second, first);
      assert.equal(git.count(), 1);
    });

    it('memoizes "not a GitHub remote" — that is a real answer', () => {
      const git = stubGitRemote('git@gitlab.com:o/r.git\n');
      assert.equal(uc._getReleasesUrlBase(), null);
      assert.equal(uc._getReleasesUrlBase(), null);
      assert.equal(git.count(), 1);
    });

    it('does NOT memoize a failure — one timeout must not kill the link forever', () => {
      // The hazard that motivated memoizing at all is a sync spawn that HANGS
      // (#324), and that is the case which throws. Caching it would trade a
      // repeated stall for permanently losing every release-notes link on an
      // install already in trouble.
      const failing = stubGitRemote(new Error('spawn timed out'));
      assert.equal(uc._getReleasesUrlBase(), null, 'degrades to no link for now');
      assert.equal(uc._getReleasesUrlBase(), null);
      assert.equal(failing.count(), 2, 'a failed read stays retryable');

      const recovered = stubGitRemote('https://github.com/o/r.git\n');
      assert.equal(uc._getReleasesUrlBase(), 'https://github.com/o/r/releases/tag/',
        'and the link comes back once git works again');
      assert.equal(recovered.count(), 1);
    });
  });

  it('a failed check is visible at the default log level', async () => {
    // `lib/logger.js` defaults to `info`. At debug, an install that had quietly
    // stopped being able to detect releases left no trace an operator would
    // ever find — the failure mode is silence, so the log IS the feature.
    const logger = require('../lib/logger');
    const lines = [];
    logger.setConsoleStream({ write: (s) => lines.push(s) });
    logger.setLevel('info');
    try {
      stubLsRemote(null);
      await new Promise((resolve) => uc.checkForUpdateAsync(resolve));
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
    assert.ok(lines.some((l) => /Update check failed/.test(l)),
      'a failed check must surface at info, not only at debug');
  });

  it('upgraded BOTH failure paths, not just the one under test', () => {
    // The sync path is what `startChecker` drives every 4h and what
    // `update-applier` runs pre-flight — i.e. the one that fails on an
    // unattended server, where nobody is watching a dashboard. Upgrading only
    // the async path would leave the quieter, more important path dark.
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'lib', 'update-checker.js'), 'utf8');
    assert.doesNotMatch(src, /log\.debug\('Update check failed/,
      'both catch blocks must report at the same visible level');
    assert.equal((src.match(/log\.warn\('Update check failed/g) || []).length, 2,
      'sync and async both report the failure');
  });

  it('one throwing waiter cannot strand the others', async () => {
    // These callbacks write HTTP responses; writing to a socket the client
    // already closed throws. A bare fan-out loop would abandon every waiter
    // after the first, and the server's non-exiting uncaughtException handler
    // turns those into requests that simply never answer.
    stubLsRemote(TAGS);
    const served = [];
    await new Promise((resolve) => {
      uc.refreshIfStale(60000, () => { throw new Error('socket destroyed'); });
      uc.refreshIfStale(60000, (s) => { served.push(s.latestVersion); });
      uc.refreshIfStale(60000, (s) => { served.push(s.latestVersion); resolve(); });
    });
    assert.deepEqual(served, ['9.9.9', '9.9.9'], 'siblings of a throwing waiter still get served');
  });

  it('maps the manual flag to the right floor, in the right direction', () => {
    // The mutation this exists to catch is an inverted ternary, which hands
    // automatic checks the aggressive floor and operator requests the lazy one
    // — backwards, and invisible in review because both values are plausible.
    assert.equal(uc.resolveRefreshFloor(true), uc.MANUAL_REFRESH_MIN_AGE_MS);
    assert.equal(uc.resolveRefreshFloor(false), uc.AUTO_REFRESH_MIN_AGE_MS);
    // A malformed body must degrade to the SAFER (longer) floor, never the
    // aggressive one — `{"manual": "yes"}` is not consent to poll harder.
    for (const junk of [undefined, null, 'true', 1, {}]) {
      assert.equal(uc.resolveRefreshFloor(junk), uc.AUTO_REFRESH_MIN_AGE_MS,
        `${JSON.stringify(junk)} must not buy the manual floor`);
    }
  });

  it('the async transport builds exactly what _buildStatus builds', async () => {
    // The previous guard only checked that both functions mention _buildStatus.
    // That passes even if the async path hands it the wrong argument — so this
    // compares the actual payloads for the same tag list.
    stubLsRemote(TAGS);
    const viaAsync = await new Promise((resolve) => uc.checkForUpdateAsync(resolve));
    const direct = uc._buildStatus(viaAsync.currentVersion, TAGS, viaAsync.checkedAt);
    assert.deepEqual(viaAsync, direct);
    assert.equal(viaAsync.latestVersion, '9.9.9', 'and it is the real parse, not two matching nulls');
  });

  it('a failed async query yields the failure payload, not a parse of empty output', async () => {
    stubLsRemote(null);
    const failed = await new Promise((resolve) => uc.checkForUpdateAsync(resolve));
    assert.deepEqual(failed, uc._buildStatus(failed.currentVersion, null, failed.checkedAt));
    assert.equal(failed.checkOk, false);
  });
});
