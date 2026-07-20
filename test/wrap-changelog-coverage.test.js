'use strict';

/**
 * Tests for the changelog coverage predicate — the second satisfaction route for
 * the wrap's `changelog-update` gate (#645).
 *
 * The predicate asks whether every commit this session shipped maintained the
 * changelog in its own diff, so the gate stops blocking sessions that logged as
 * they worked. Its three-valued verdict is the safety property under test:
 * `unavailable` must never read as success, because the caller falls back to the
 * mutation check on it.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const cov = require('../lib/wrap-steps/changelog-coverage');

/** ASCII record separator — `git log --format=%x1e` emits this before each record. */
const RS = '\x1e';
/** ASCII unit separator — `git log --format=%x1f` emits this between fields. */
const US = '\x1f';

const PATHS = ['CHANGELOG.md'];

/**
 * Build a fake `git log --format=%x1e%H%x1f%P%x1f%s --name-only` payload.
 *
 * @param {Array<{sha:string, subject:string, files?:string[], parents?:string}>} records
 * @returns {string}
 */
function gitLog(records) {
  return records
    .map((r) => `${RS}${r.sha}${US}${r.parents === undefined ? 'p1' : r.parents}${US}${r.subject}\n` +
      (r.files || []).join('\n') + '\n')
    .join('');
}

describe('changelog-coverage — record parsing', () => {
  it('parses sha, subject and touched files from one record', () => {
    const rec = cov._parseRecord(`abc1234${US}p1${US}Do a thing (#1)\nCHANGELOG.md\nlib/x.js\n`);
    assert.equal(rec.sha, 'abc1234');
    assert.equal(rec.subject, 'Do a thing (#1)');
    assert.deepEqual(rec.files, ['CHANGELOG.md', 'lib/x.js']);
    assert.equal(rec.isMerge, false);
  });

  it('flags a commit with two parents as a merge', () => {
    const rec = cov._parseRecord(`abc1234${US}p1 p2${US}Merge branch 'x'\n`);
    assert.equal(rec.isMerge, true);
  });

  it('treats a root commit (no parents) as a non-merge', () => {
    const rec = cov._parseRecord(`abc1234${US}${US}Initial commit\nREADME.md\n`);
    assert.equal(rec.isMerge, false);
  });

  it('does not truncate a subject that itself contains the field separator', () => {
    const rec = cov._parseRecord(`abc1234${US}p1${US}Weird${US}subject\nCHANGELOG.md\n`);
    assert.equal(rec.subject, `Weird${US}subject`);
  });

  it('yields no files for a commit that touched nothing', () => {
    const rec = cov._parseRecord(`abc1234${US}p1${US}Empty\n`);
    assert.deepEqual(rec.files, []);
  });
});

describe('changelog-coverage — commit listing', () => {
  let saved;
  beforeEach(() => { saved = { ...cov._internal }; });
  afterEach(() => { Object.assign(cov._internal, saved); });

  it('splits a multi-record payload on the record separator', () => {
    cov._internal.execSync = () => gitLog([
      { sha: 'aaa1111', subject: 'One (#1)', files: ['CHANGELOG.md'] },
      { sha: 'bbb2222', subject: 'Two (#2)', files: ['lib/a.js', 'lib/b.js'] }
    ]);
    const out = cov._listCommits('/p', 'x..HEAD');
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].files, ['CHANGELOG.md']);
    assert.deepEqual(out[1].files, ['lib/a.js', 'lib/b.js']);
  });

  it('returns empty for an empty range', () => {
    cov._internal.execSync = () => '';
    assert.deepEqual(cov._listCommits('/p', 'x..HEAD'), []);
  });
});

describe('changelog-coverage — wrap-commit exclusion', () => {
  it('matches every subject form lib/wrap-steps/commit.js builds', () => {
    assert.equal(cov._isWrapCommit('Session wrap'), true);
    assert.equal(cov._isWrapCommit('Session wrap (chunk 04b)'), true);
    assert.equal(cov._isWrapCommit('Session wrap on wrap/20260719184554-tangleclaw'), true);
  });

  it('still matches AFTER the wrap PR is squash-merged onto the trunk', () => {
    assert.equal(
      cov._isWrapCommit('Session wrap — release 4.30.0 (Phase B exit, install honesty, port ownership) (#658)'),
      true
    );
  });

  it('does not match an ordinary commit that merely mentions a wrap', () => {
    assert.equal(cov._isWrapCommit('Stop the wrap reporting success it never verified (#641)'), false);
    assert.equal(cov._isWrapCommit('Refactor session wrap helpers'), false);
  });

  it('does not match on a prefix that only shares a word boundary', () => {
    assert.equal(cov._isWrapCommit('Session wrapper cleanup'), false);
  });
});

describe('changelog-coverage — log range resolution', () => {
  let saved;
  beforeEach(() => { saved = { ...cov._internal }; });
  afterEach(() => { Object.assign(cov._internal, saved); });

  it('prefers the recorded lastWrapSha', () => {
    cov._internal.execSync = () => '';
    assert.equal(cov._resolveLogRange('/p', 'c1f94ac'), 'c1f94ac..HEAD');
  });

  it('uses TWO-dot, not three — three-dot would be a symmetric difference under git log', () => {
    // features-toc uses three-dot because it feeds `git diff`. The ranges are not
    // interchangeable across the two commands; a three-dot log range would list
    // commits that are on the base and absent from HEAD.
    cov._internal.execSync = () => '';
    const range = cov._resolveLogRange('/p', null);
    assert.equal(range, 'main..HEAD');
    assert.doesNotMatch(range, /\.\.\./);
  });

  it('falls back to master when main does not resolve', () => {
    cov._internal.execSync = (cmd) => {
      if (cmd.includes('main')) throw new Error('unknown revision');
      return '';
    };
    assert.equal(cov._resolveLogRange('/p', null), 'master..HEAD');
  });

  it('ignores a malformed lastWrapSha rather than building a bogus range', () => {
    cov._internal.execSync = () => '';
    assert.equal(cov._resolveLogRange('/p', 'not-a-sha!!'), 'main..HEAD');
  });

  it('ignores a well-formed lastWrapSha that no longer resolves (rebase, fresh clone)', () => {
    cov._internal.execSync = (cmd) => {
      if (cmd.includes('deadbee')) throw new Error('unknown revision');
      return '';
    };
    assert.equal(cov._resolveLogRange('/p', 'deadbee'), 'main..HEAD');
  });

  it('returns null when neither a session SHA nor a trunk branch resolves', () => {
    cov._internal.execSync = () => { throw new Error('not a git repo'); };
    assert.equal(cov._resolveLogRange('/p', null), null);
  });
});

describe('changelog-coverage — evaluate()', () => {
  let saved;
  beforeEach(() => {
    saved = { ...cov._internal };
    cov._internal.loadProjectConfig = () => ({ lastWrapSha: 'c1f94ac' });
    cov._internal.execSync = () => '';
  });
  afterEach(() => { Object.assign(cov._internal, saved); });

  /**
   * Point the module at a synthetic session.
   *
   * @param {Array<{sha:string, subject:string, files?:string[], parents?:string}>} records
   */
  function scenario(records) {
    cov._internal.execSync = (cmd) => (cmd.startsWith('git log') ? gitLog(records) : '');
  }

  it('COVERED when every commit touched a declared path', () => {
    scenario([
      { sha: 'aaa1111', subject: 'Fix a thing (#657)', files: ['CHANGELOG.md', 'lib/a.js'] },
      { sha: 'bbb2222', subject: 'Fix another (#655)', files: ['lib/b.js', 'CHANGELOG.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 2);
    assert.deepEqual(out.uncovered, []);
  });

  it('COVERED when the only untouching commits are the wrap\'s own bookkeeping', () => {
    scenario([
      { sha: 'aaa1111', subject: 'Session wrap — release 4.30.0 (#658)', files: ['version.json'] },
      { sha: 'bbb2222', subject: 'Fix a thing (#655)', files: ['CHANGELOG.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 1, 'the wrap commit is excluded, not counted as covered');
  });

  it('COVERED when a merge commit reports no paths — absence of evidence must not block', () => {
    scenario([
      { sha: 'aaa1111', subject: "Merge branch 'x'", parents: 'p1 p2', files: [] },
      { sha: 'bbb2222', subject: 'Fix a thing (#655)', files: ['CHANGELOG.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 1);
  });

  it('UNCOVERED when a commit shipped without touching a declared path, and names it', () => {
    scenario([
      { sha: 'aaa1111', subject: 'Fix a thing (#657)', files: ['CHANGELOG.md'] },
      { sha: 'bbb2222', subject: 'Unlogged work (#999)', files: ['lib/b.js'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNCOVERED);
    assert.equal(out.uncovered.length, 1);
    assert.equal(out.uncovered[0].sha, 'bbb2222');
    assert.equal(out.uncovered[0].subject, 'Unlogged work (#999)');
    assert.equal(out.checkedCount, 2, 'checkedCount is the denominator, not the failure count');
  });

  it('matches a declared path exactly — a lookalike elsewhere in the tree does not count', () => {
    scenario([{ sha: 'aaa1111', subject: 'Fix (#1)', files: ['docs/CHANGELOG.md'] }]);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNCOVERED);
  });

  it('accepts ANY of several declared paths', () => {
    scenario([{ sha: 'aaa1111', subject: 'Fix (#1)', files: ['NOTES.md'] }]);
    assert.equal(cov.evaluate('/p', ['CHANGELOG.md', 'NOTES.md']).verdict, cov.VERDICTS.COVERED);
  });

  it('UNAVAILABLE when the range contains only wrap commits', () => {
    scenario([{ sha: 'aaa1111', subject: 'Session wrap on wrap/2026-x', files: ['version.json'] }]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNAVAILABLE);
    assert.equal(out.checkedCount, 0);
  });

  it('UNAVAILABLE when the session made no commits at all', () => {
    scenario([]);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNAVAILABLE);
  });

  it('UNAVAILABLE when no range resolves', () => {
    cov._internal.loadProjectConfig = () => ({ lastWrapSha: null });
    cov._internal.execSync = () => { throw new Error('not a git repo'); };
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNAVAILABLE);
    assert.equal(out.range, null);
  });

  it('UNAVAILABLE when git log fails, rather than throwing at the caller', () => {
    cov._internal.execSync = (cmd) => {
      if (cmd.startsWith('git log')) throw new Error('bad revision');
      return '';
    };
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNAVAILABLE);
  });

  it('UNAVAILABLE when no paths are declared — it cannot judge an empty obligation', () => {
    scenario([{ sha: 'aaa1111', subject: 'Fix (#1)', files: ['lib/a.js'] }]);
    assert.equal(cov.evaluate('/p', []).verdict, cov.VERDICTS.UNAVAILABLE);
    assert.equal(cov.evaluate('/p', undefined).verdict, cov.VERDICTS.UNAVAILABLE);
  });

  it('survives an unreadable project config by falling back to the trunk range', () => {
    cov._internal.loadProjectConfig = () => { throw new Error('no config'); };
    cov._internal.execSync = (cmd) => (cmd.startsWith('git log')
      ? gitLog([{ sha: 'a1', subject: 'Fix (#5)', files: ['CHANGELOG.md'] }])
      : '');
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.range, 'main..HEAD');
  });
});

describe('changelog-coverage — against this repository\'s real history', () => {
  // The unit tests above run on synthetic payloads, and synthetic payloads are
  // exactly what let the first version of this predicate pass its whole suite
  // while being wrong about real commits. This exercises the real git binary on
  // the real repo: the shape of `git log --name-only` output, the wrap-subject
  // prefix, and merge handling are all assumptions about a foreign tool.
  it('parses real commits and reaches a verdict without throwing', () => {
    const out = cov.evaluate(process.cwd(), PATHS);
    assert.ok(Object.values(cov.VERDICTS).includes(out.verdict));
    if (out.verdict !== cov.VERDICTS.UNAVAILABLE) {
      assert.ok(out.checkedCount > 0, 'a judgeable verdict must have judged something');
      assert.match(out.range, /\.\.HEAD$/);
    }
  });

  it('reads real touched-file lists rather than empty ones', () => {
    // An explicit relative range, not the resolved one: on a feature branch with
    // no commits yet, `main..HEAD` is legitimately empty and would assert nothing.
    const commits = cov._listCommits(process.cwd(), 'HEAD~12..HEAD');
    assert.ok(commits.length > 0, 'expected commits in the repo');
    assert.ok(commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha)), 'expected full SHAs from %H');
    assert.ok(commits.every((c) => c.subject.length > 0), 'expected a subject on every commit');
    assert.ok(commits.some((c) => c.files.length > 0),
      'every commit parsed with an empty file list — the --name-only format assumption is wrong');
    assert.ok(commits.some((c) => c.files.includes('CHANGELOG.md')),
      'expected real commits touching CHANGELOG.md — the path-matching assumption is wrong');
  });

  it('recognizes real wrap commits in real history', () => {
    // The wrap-subject prefix is an assumption about what the commit step wrote
    // months ago and what squash-merge preserved; synthetic subjects cannot test it.
    const commits = cov._listCommits(process.cwd(), 'HEAD~30..HEAD');
    assert.ok(commits.some((c) => cov._isWrapCommit(c.subject)),
      'expected at least one real wrap commit in the last 30 — the exclusion may be matching nothing');
    assert.ok(commits.some((c) => !cov._isWrapCommit(c.subject)),
      'expected ordinary commits too — the exclusion must not be matching everything');
  });
});
