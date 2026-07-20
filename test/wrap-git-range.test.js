'use strict';

/**
 * Tests for the shared wrap session-range resolver.
 *
 * The module exists because two copies of this logic drifted on the detail that
 * matters most — the `lastWrapSha` shape regex was `{7,64}` in one and `{7,40}` in
 * the other, for the same field — and because the two-dot/three-dot choice means
 * different things to `git diff` and `git log`. Both are pinned here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gitRange = require('../lib/wrap-steps/_git-range');

/**
 * An `execSync` stand-in that fails for refs matching `failing`.
 *
 * @param {RegExp|null} failing - Refs to reject, or null to accept everything.
 * @returns {Function}
 */
function fakeExec(failing = null) {
  return (cmd) => {
    if (failing && failing.test(cmd)) throw new Error('unknown revision');
    return '';
  };
}

describe('_git-range — session range resolution', () => {
  it('prefers the recorded lastWrapSha over the trunk fallback', () => {
    const out = gitRange.resolveSessionRange('/p', 'c1f94ac', { exec: fakeExec() });
    assert.deepEqual(out, { range: 'c1f94ac..HEAD', kind: 'session', baseBranch: null });
  });

  it('emits three-dot for the diff caller and two-dot for the log caller', () => {
    // The whole reason the option exists: three-dot means "since the merge base" to
    // `git diff` but the symmetric difference to `git log`.
    const three = gitRange.resolveSessionRange('/p', null, { dots: 'three', exec: fakeExec() });
    const two = gitRange.resolveSessionRange('/p', null, { dots: 'two', exec: fakeExec() });
    assert.equal(three.range, 'main...HEAD');
    assert.equal(two.range, 'main..HEAD');
  });

  it('defaults to three-dot — the pre-existing diff caller\'s shape', () => {
    assert.equal(gitRange.resolveSessionRange('/p', null, { exec: fakeExec() }).range, 'main...HEAD');
  });

  it('a session range is two-dot regardless of the dots option', () => {
    const out = gitRange.resolveSessionRange('/p', 'c1f94ac', { dots: 'three', exec: fakeExec() });
    assert.equal(out.range, 'c1f94ac..HEAD');
  });

  it('falls back to master when main does not resolve', () => {
    const out = gitRange.resolveSessionRange('/p', null, { dots: 'two', exec: fakeExec(/main/) });
    assert.equal(out.range, 'master..HEAD');
    assert.equal(out.baseBranch, 'master');
  });

  it('returns null when neither a session SHA nor a trunk branch resolves', () => {
    assert.equal(gitRange.resolveSessionRange('/p', null, { exec: fakeExec(/.*/) }), null);
  });

  it('ignores a lastWrapSha that no longer resolves (rebase, fresh clone)', () => {
    const out = gitRange.resolveSessionRange('/p', 'deadbee', { dots: 'two', exec: fakeExec(/deadbee/) });
    assert.equal(out.range, 'main..HEAD');
  });
});

describe('_git-range — SHA shape', () => {
  it('accepts a 64-char SHA, so SHA-256 repos are not silently rejected', () => {
    // The divergence this module was extracted to end: one copy capped at 40, which
    // would reject every SHA-256 object name and fall back to the trunk range.
    assert.ok(gitRange.SHA_RE.test('a'.repeat(64)));
    assert.ok(gitRange.SHA_RE.test('a'.repeat(40)));
    assert.ok(gitRange.SHA_RE.test('c1f94ac'));
  });

  it('rejects shapes that could carry shell metacharacters into a range', () => {
    assert.ok(!gitRange.SHA_RE.test('not-a-sha!!'));
    assert.ok(!gitRange.SHA_RE.test('abc123; rm -rf /'));
    assert.ok(!gitRange.SHA_RE.test('abc12'), 'too short to be an abbreviation');
    assert.ok(!gitRange.SHA_RE.test('a'.repeat(65)), 'longer than any object name');
  });

  it('rejects a SHA shape only after it fails to resolve, never inventing a range', () => {
    const out = gitRange.resolveSessionRange('/p', 'zzzzzzz', { dots: 'two', exec: fakeExec() });
    assert.equal(out.range, 'main..HEAD', 'a non-hex value must not reach the range string');
  });
});

describe('_git-range — both callers agree', () => {
  it('features-toc and changelog-coverage resolve the same session SHA range', () => {
    // They differ only in the fallback form; on the common path they must agree, or
    // one step judges a different set of commits than the other.
    const featuresToc = require('../lib/wrap-steps/features-toc');
    const coverage = require('../lib/wrap-steps/changelog-coverage');

    const savedF = featuresToc._internal.execSync;
    const savedC = coverage._internal.execSync;
    featuresToc._internal.execSync = fakeExec();
    coverage._internal.execSync = fakeExec();
    try {
      assert.equal(featuresToc._resolveSessionRange('/p', 'c1f94ac').range, 'c1f94ac..HEAD');
      assert.equal(coverage._resolveLogRange('/p', 'c1f94ac'), 'c1f94ac..HEAD');
    } finally {
      featuresToc._internal.execSync = savedF;
      coverage._internal.execSync = savedC;
    }
  });
});
