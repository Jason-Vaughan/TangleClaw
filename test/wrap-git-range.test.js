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
    // `stopped` names any probe our own timeout killed rather than let answer, so
    // a caller can tell a fallback taken on an UNKNOWN answer from one taken on a
    // negative one. Asserted exhaustively here because it is part of the shape.
    assert.deepEqual(out, { range: 'c1f94ac..HEAD', kind: 'session', baseBranch: null, stopped: [] });
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

  it('falls back to the trunk range when the SHA resolves but is NOT an ancestor of HEAD (#664)', () => {
    // A lastWrapSha orphaned by squash-merge still resolves as an object but is off
    // HEAD's history, so `<sha>..HEAD` would balloon to the last shared ancestor —
    // whole prior sessions of already-released work. rev-parse succeeds; only the
    // ancestry probe (`merge-base --is-ancestor`) fails.
    const out = gitRange.resolveSessionRange('/p', 'c1f94ac', {
      dots: 'two',
      exec: fakeExec(/is-ancestor/)
    });
    assert.equal(out.range, 'main..HEAD');
    assert.equal(out.kind, 'branch', 'an orphaned stamp must not read as a session range');
  });

  it('takes the session range when the SHA resolves AND is an ancestor', () => {
    const out = gitRange.resolveSessionRange('/p', 'c1f94ac', { exec: fakeExec() });
    assert.equal(out.range, 'c1f94ac..HEAD');
    assert.equal(out.kind, 'session');
  });
});

describe('_git-range — isAncestorOf (#664)', () => {
  it('true when git merge-base --is-ancestor exits zero', () => {
    assert.equal(gitRange.isAncestorOf('/p', 'c1f94ac', 'HEAD', fakeExec()), true);
  });

  it('false when it exits non-zero — the orphaned or off-history ref', () => {
    assert.equal(gitRange.isAncestorOf('/p', 'c1f94ac', 'HEAD', fakeExec(/is-ancestor/)), false);
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

describe('_git-range — the tip is a parameter (#797)', () => {
  it('measures to the given tip on both the session and the fallback path', () => {
    const session = gitRange.resolveSessionRange('/p', 'c1f94ac', { tip: 'deadbee', exec: fakeExec() });
    assert.equal(session.range, 'c1f94ac..deadbee');
    const branch = gitRange.resolveSessionRange('/p', null, { tip: 'deadbee', exec: fakeExec() });
    assert.equal(branch.range, 'main...deadbee');
  });

  it('asks the ancestry question about the tip, not about HEAD', () => {
    // A step running after the wrap commit measures to that commit. Probing HEAD
    // instead answers a different question than the range being built, and #467's
    // close-loop is exactly when the two diverge.
    const asked = [];
    const exec = (cmd) => { asked.push(cmd); return ''; };
    gitRange.resolveSessionRange('/p', 'c1f94ac', { tip: 'deadbee', exec });
    assert.ok(asked.some((c) => c === 'git merge-base --is-ancestor c1f94ac deadbee'),
      `ancestry was probed against the wrong end: ${asked.join(' | ')}`);
  });

  it('defaults the tip to HEAD', () => {
    assert.equal(gitRange.resolveSessionRange('/p', 'c1f94ac', { exec: fakeExec() }).range, 'c1f94ac..HEAD');
  });
});

describe('_git-range — the sync and async resolvers agree', () => {
  /**
   * An argv-style async runner that refuses commands matching `failing`.
   *
   * @param {RegExp|null} failing - Commands to refuse, or null to accept all.
   * @returns {Function}
   */
  function fakeExecAsync(failing = null) {
    return async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      if (failing && failing.test(cmd)) return { exitCode: 1, stdout: '', stderr: '', error: null, timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', error: null, timedOut: false };
    };
  }

  // The two forms exist because the wrap's steps do not share one git seam. They
  // are allowed to differ in HOW they probe and in nothing else, so every input
  // that changes the decision is run through both.
  const CASES = [
    ['recorded SHA resolves', 'c1f94ac', null, {}],
    ['no SHA recorded', null, null, {}],
    ['SHA orphaned by squash-merge', 'c1f94ac', /is-ancestor/, {}],
    ['SHA no longer resolves', 'c1f94ac', /rev-parse --verify --quiet c1f94ac/, {}],
    ['non-hex SHA never reaches the range', 'zzzzzzz', null, {}],
    ['main absent, master present', null, /--quiet main/, {}],
    ['no trunk at all', null, /rev-parse/, {}],
    ['two-dot fallback', null, null, { dots: 'two' }],
    ['a tip that is not HEAD', 'c1f94ac', null, { tip: 'deadbee' }],
    ['a tip that is not HEAD, on the fallback', null, null, { tip: 'deadbee' }]
  ];

  for (const [name, sha, failing, options] of CASES) {
    it(`agrees on: ${name}`, async () => {
      const sync = gitRange.resolveSessionRange('/p', sha, { ...options, exec: fakeExec(failing) });
      const async_ = await gitRange.resolveSessionRangeAsync('/p', sha, { ...options, exec: fakeExecAsync(failing) });
      assert.deepEqual(async_, sync);
    });
  }

  it('the async probes report a kill instead of calling it a negative answer', async () => {
    const stopped = [];
    const killed = async () => ({ exitCode: 124, stdout: '', stderr: '', error: 'timed out', timedOut: true });
    const out = await gitRange.resolveSessionRangeAsync('/p', 'c1f94ac', {
      exec: killed, onStopped: (c) => stopped.push(c)
    });
    assert.equal(out, null, 'nothing resolved, so there is no range');
    // The null is exactly the shape a killed probe manufactures, and it carries
    // no field to say so — `onStopped` is the only way a caller can tell.
    assert.ok(stopped.some((c) => c.includes('rev-parse --verify --quiet c1f94ac')));
    assert.ok(stopped.some((c) => c.includes('--quiet main')));
  });

  it('the async runner throwing is a negative answer, not a crash', async () => {
    const out = await gitRange.resolveSessionRangeAsync('/p', 'c1f94ac', {
      exec: async () => { throw new Error('spawn ENOENT'); }
    });
    assert.equal(out, null);
  });
});
