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
