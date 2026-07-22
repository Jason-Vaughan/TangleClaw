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

  it('raises the output cap above execSync\'s 1MB default', () => {
    // --name-only over a long-lived branch runs to megabytes; hitting the default
    // throws, which degrades to `unavailable` — the gate would silently revert to
    // blocking on exactly the projects with the most history.
    let opts = null;
    cov._internal.execSync = (_cmd, o) => { opts = o; return ''; };
    cov._listCommits('/p', 'x..HEAD');
    assert.ok(opts.maxBuffer > 1024 * 1024, 'expected a raised maxBuffer');
    assert.ok(opts.timeout > 0, 'git calls must stay bounded in time too');
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
  function scenario(records, dirty = [], untracked = []) {
    cov._internal.execSync = (cmd) => {
      if (cmd.startsWith('git log')) return gitLog(records);
      if (cmd.startsWith('git diff')) return dirty.join('\n');
      if (cmd.startsWith('git ls-files')) return untracked.join('\n');
      return '';
    };
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

  it('COVERED when one commit maintained the changelog and another shipped no entry (session-level)', () => {
    // The changelog need not ride every commit — one entry covering the session's
    // work satisfies the obligation, so a sibling code commit without its own
    // entry no longer blocks (#665).
    scenario([
      { sha: 'aaa1111', subject: 'Fix a thing (#657)', files: ['CHANGELOG.md'] },
      { sha: 'bbb2222', subject: 'More work, logged in aaa1111 (#999)', files: ['lib/b.js'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.deepEqual(out.uncovered, []);
    assert.equal(out.checkedCount, 2, 'checkedCount is the denominator regardless of verdict');
  });

  it('COVERED when a later backfill commit logs work earlier commits shipped unlogged (#665)', () => {
    scenario([
      { sha: 'aaa1111', subject: 'feat: a (#70)', files: ['lib/a.js'] },
      { sha: 'bbb2222', subject: 'fix: b (#71)', files: ['lib/b.js'] },
      { sha: 'ccc3333', subject: 'docs: backfill CHANGELOG for the session', files: ['CHANGELOG.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 3);
  });

  it('COVERED when a doc-only bookkeeping commit ships no entry beside a logged code commit', () => {
    // The launch-mode-guard session: code + CHANGELOG.md in one commit, a separate
    // commit touching only the other changelog. The bookkeeping commit carries no
    // CHANGELOG.md obligation, and the session's changelog was maintained.
    scenario([
      { sha: 'aaa1111', subject: 'Close guard holes (#622)', files: ['lib/projects.js', 'CHANGELOG.md'] },
      { sha: 'bbb2222', subject: 'Change-log: guard holes (#622)', files: ['.prawduct/change-log.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
  });

  it('UNCOVERED only when NO commit in the range maintained the changelog, naming them all', () => {
    scenario([
      { sha: 'aaa1111', subject: 'Unlogged work (#998)', files: ['lib/a.js'] },
      { sha: 'bbb2222', subject: 'More unlogged work (#999)', files: ['lib/b.js'] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNCOVERED);
    assert.equal(out.checkedCount, 2);
    assert.deepEqual(out.uncovered.map((c) => c.sha), ['aaa1111', 'bbb2222'],
      'every judged commit is named when none maintained the changelog');
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

  // The working tree is part of the session. Committed history alone leaves two
  // holes: an entry written but not yet committed goes unseen, and work still
  // uncommitted at wrap time is swept into the wrap commit, which the NEXT
  // session's range starts after — so it could never be judged at all.
  it('COVERED when a declared path is dirty, even with an unlogged commit in range', () => {
    // This is what makes the block's remediation honest: writing the missing
    // entry clears it, whether the operator or the retry turn writes it.
    scenario([{ sha: 'aaa1111', subject: 'Unlogged work (#999)', files: ['lib/a.js'] }],
      ['CHANGELOG.md']);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.COVERED);
  });

  it('does NOT demand an entry when only bookkeeping files are dirty (#645 stays fixed)', () => {
    // A wrap dirties tracked bookkeeping (`.prawduct/change-log.md`) as a matter of
    // course; classifying it as work would re-block exactly the compliant sessions
    // #645 is about. Only source files count as unlogged work (#659).
    scenario([{ sha: 'aaa1111', subject: 'Logged work (#1)', files: ['CHANGELOG.md'] }],
      ['.prawduct/change-log.md']);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.COVERED);
  });

  it('DOES demand an entry when uncommitted source work is dirty and the changelog is clean (#659)', () => {
    // The work will be swept into the wrap's own commit; an entry logged for the
    // session's COMMITTED work does not cover it, so this blocks even though a
    // committed commit touched the changelog. Bookkeeping dirt is excluded.
    scenario([{ sha: 'aaa1111', subject: 'Logged work (#1)', files: ['CHANGELOG.md'] }],
      ['.prawduct/change-log.md', 'lib/a.js']);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNCOVERED);
    assert.deepEqual(out.uncommittedWork, ['lib/a.js'], 'names the work, excludes the bookkeeping');
    assert.deepEqual(out.uncovered, [], 'an uncommitted-work verdict does not populate the commit list');
  });

  it('with no commits: UNAVAILABLE when the tree is clean or only bookkeeping is dirty', () => {
    scenario([], []);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNAVAILABLE);
    scenario([], ['.prawduct/change-log.md']);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNAVAILABLE,
      'bookkeeping-only dirt is not unlogged work');
  });

  it('with no commits but dirty source work: UNCOVERED — the work ships unlogged (#659)', () => {
    scenario([], ['lib/a.js']);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNCOVERED);
    assert.deepEqual(out.uncommittedWork, ['lib/a.js']);
  });

  it('catches an UNTRACKED new source file that git add -A will commit unlogged (#659)', () => {
    // `git diff HEAD` never lists an untracked file, but the wrap's `git add -A`
    // commits it. A brand-new file is the most common form of new work — the
    // modified-only view missed exactly this class.
    scenario([], [], ['lib/brand-new.js']);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.UNCOVERED);
    assert.deepEqual(out.uncommittedWork, ['lib/brand-new.js']);
  });

  it('does not count an untracked bookkeeping file as work', () => {
    scenario([{ sha: 'aaa1111', subject: 'Logged (#1)', files: ['CHANGELOG.md'] }],
      [], ['.prawduct/scratch.md']);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.COVERED,
      'untracked bookkeeping is excluded by the leading-dot rule');
  });

  it('an untracked (brand-new) CHANGELOG satisfies coverage via the dirty route', () => {
    scenario([{ sha: 'aaa1111', subject: 'work (#1)', files: ['lib/a.js'] }],
      [], ['CHANGELOG.md']);
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.COVERED,
      'a brand-new dirty changelog is the changelog being maintained');
  });

  it('exempts a commit that touched nothing IN SCOPE — a subdir project\'s sibling-only commit', () => {
    // With --relative, a commit touching only paths outside the project root parses
    // with an empty file list. It is not the project's concern, and must not read as
    // "touched nothing, therefore unlogged".
    scenario([
      { sha: 'aaa1111', subject: 'Logged (#1)', files: ['CHANGELOG.md'] },
      { sha: 'bbb2222', subject: 'Elsewhere in the monorepo (#2)', files: [] }
    ]);
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 1);
  });

  it('UNAVAILABLE when the working tree cannot be read, rather than passing', () => {
    cov._internal.execSync = (cmd) => {
      if (cmd.startsWith('git diff')) throw new Error('git exploded');
      if (cmd.startsWith('git log')) return gitLog([{ sha: 'a1', subject: 'x (#1)', files: ['CHANGELOG.md'] }]);
      return '';
    };
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNAVAILABLE);
  });

  it('survives an unreadable project config by falling back to the trunk range', () => {
    cov._internal.loadProjectConfig = () => { throw new Error('no config'); };
    cov._internal.execSync = (cmd) => {
      if (cmd.startsWith('git log')) return gitLog([{ sha: 'a1', subject: 'Fix (#5)', files: ['CHANGELOG.md'] }]);
      return '';
    };
    const out = cov.evaluate('/p', PATHS);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.range, 'main..HEAD');
  });
});

describe('changelog-coverage — glob compilation', () => {
  it('matches a single segment with * but not across a slash', () => {
    const re = cov._globToRegExp('skills/*/CHANGELOG.md');
    assert.ok(re.test('skills/airbnb-gateway/CHANGELOG.md'));
    assert.ok(!re.test('skills/a/b/CHANGELOG.md'), '* must not cross a path separator');
    assert.ok(!re.test('skills/CHANGELOG.md'), '* requires a segment to be present');
  });

  it('matches any depth with ** and matches the root file via **/', () => {
    const re = cov._globToRegExp('**/CHANGELOG.md');
    assert.ok(re.test('CHANGELOG.md'), '**/ must match zero leading segments');
    assert.ok(re.test('skills/airbnb-gateway/CHANGELOG.md'));
    assert.ok(re.test('a/b/c/CHANGELOG.md'));
  });

  it('escapes regex metacharacters so the dot cannot match more than itself', () => {
    const re = cov._globToRegExp('CHANGELOG.md');
    assert.ok(re.test('CHANGELOG.md'));
    assert.ok(!re.test('CHANGELOGxmd'), 'the . is a literal dot, not "any character"');
  });

  it('anchors — a declared glob does not match a longer path that merely contains it', () => {
    const re = cov._globToRegExp('CHANGELOG.md');
    assert.ok(!re.test('docs/CHANGELOG.md'));
    assert.ok(!re.test('CHANGELOG.md.bak'));
  });
});

describe('changelog-coverage — coverage globs (nested changelogs)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...cov._internal };
    cov._internal.loadProjectConfig = () => ({ lastWrapSha: 'c1f94ac' });
    cov._internal.execSync = () => '';
  });
  afterEach(() => { Object.assign(cov._internal, saved); });

  function scenario(records, dirty = [], untracked = []) {
    cov._internal.execSync = (cmd) => {
      if (cmd.startsWith('git log')) return gitLog(records);
      if (cmd.startsWith('git diff')) return dirty.join('\n');
      if (cmd.startsWith('git ls-files')) return untracked.join('\n');
      return '';
    };
  }

  it('COVERED when a commit logged to a declared nested changelog (the #663 regression)', () => {
    // RentalClaw's airbnb-gateway commits logged to skills/airbnb-gateway/CHANGELOG.md.
    // With that path declared, they satisfy coverage instead of blocking the wrap.
    scenario([
      { sha: 'aaa1111', subject: 'airbnb-gateway v0.1.0', files: ['skills/airbnb-gateway/CHANGELOG.md', 'skills/airbnb-gateway/SKILL.md'] },
      { sha: 'bbb2222', subject: 'airbnb-gateway v0.2.1', files: ['skills/airbnb-gateway/CHANGELOG.md'] }
    ]);
    const out = cov.evaluate('/p', PATHS, ['skills/*/CHANGELOG.md']);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.equal(out.checkedCount, 2);
  });

  it('still UNCOVERED for a nested changelog that was NOT declared — a glob only widens', () => {
    scenario([
      { sha: 'aaa1111', subject: 'nested-only (#1)', files: ['skills/airbnb-gateway/CHANGELOG.md'] }
    ]);
    // No coveragePaths: exact-match behavior is unchanged, so the nested file does
    // not count — this is the property the existing docs/CHANGELOG.md test pins.
    assert.equal(cov.evaluate('/p', PATHS).verdict, cov.VERDICTS.UNCOVERED);
    // A different glob that doesn't match this file also leaves it uncovered.
    assert.equal(cov.evaluate('/p', PATHS, ['packages/*/CHANGELOG.md']).verdict, cov.VERDICTS.UNCOVERED);
  });

  it('COVERED via a glob-matched commit even when a sibling commit logs nowhere (session-level)', () => {
    // The full RentalClaw shape: a skill commit logs to the nested file (covered
    // by the glob), a chore/docs commit logs nowhere. Session-level coverage: the
    // changelog was maintained for the session, so the sibling does not block.
    scenario([
      { sha: 'aaa1111', subject: 'airbnb-gateway v0.1.0', files: ['skills/airbnb-gateway/CHANGELOG.md'] },
      { sha: 'ccc3333', subject: 'Remove vendored hook remnants', files: ['tools/lib/core.py'] }
    ]);
    const out = cov.evaluate('/p', PATHS, ['skills/*/CHANGELOG.md']);
    assert.equal(out.verdict, cov.VERDICTS.COVERED);
    assert.deepEqual(out.uncovered, []);
    assert.equal(out.checkedCount, 2);
  });

  it('COVERED when an uncommitted edit to a declared nested changelog is present', () => {
    // The dirty-path route honors globs too: writing the nested entry (uncommitted)
    // clears a block just as editing the root would.
    scenario([{ sha: 'aaa1111', subject: 'Unlogged (#1)', files: ['lib/a.js'] }],
      ['skills/airbnb-gateway/CHANGELOG.md']);
    assert.equal(cov.evaluate('/p', PATHS, ['skills/*/CHANGELOG.md']).verdict, cov.VERDICTS.COVERED);
  });

  it('ignores a malformed coveragePaths value rather than throwing', () => {
    scenario([{ sha: 'aaa1111', subject: 'Logged (#1)', files: ['CHANGELOG.md'] }]);
    // Non-array, and array with blank/non-string entries: all filtered, exact-match holds.
    assert.equal(cov.evaluate('/p', PATHS, 'skills/*/CHANGELOG.md').verdict, cov.VERDICTS.COVERED);
    assert.equal(cov.evaluate('/p', PATHS, ['', 42, null]).verdict, cov.VERDICTS.COVERED);
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
      assert.match(out.range, /\.\.HEAD$/);
      // A COVERED verdict can legitimately judge zero commits: an uncommitted edit
      // to a declared path (a dirty CHANGELOG.md during active development, which is
      // exactly when this suite runs) short-circuits to COVERED before any commit is
      // counted. Demand a judged commit only when the verdict came from committed
      // history. The real-git-parsing guarantee this suite exists for is pinned
      // independently by the next test, over `_listCommits` directly.
      // Two working-tree short-circuits legitimately judge zero commits: a dirty
      // declared path → COVERED, and dirty uncommitted source work → UNCOVERED
      // (#659, which is exactly the state this suite runs in during active
      // development). Demand a judged commit only for a committed-history verdict.
      const fromWorkingTreeShortCircuit =
        (out.verdict === cov.VERDICTS.COVERED && out.checkedCount === 0) ||
        (out.verdict === cov.VERDICTS.UNCOVERED && out.uncommittedWork.length > 0);
      if (!fromWorkingTreeShortCircuit) {
        assert.ok(out.checkedCount > 0, 'a committed-history verdict must have judged something');
      }
    }
  });

  it('reads real touched-file lists rather than empty ones', () => {
    // `HEAD` rather than `HEAD~N..HEAD`: CI checks out shallow (actions/checkout
    // defaults to depth 1), where any `HEAD~N` is an unknown revision. Asserting
    // over whatever history exists keeps this meaningful in a full clone without
    // being a false failure in a shallow one.
    const commits = cov._listCommits(process.cwd(), 'HEAD');
    assert.ok(commits.length > 0, 'expected at least one commit in the repo');
    assert.ok(commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha)), 'expected full SHAs from %H');
    assert.ok(commits.every((c) => c.subject.length > 0), 'expected a subject on every commit');
    assert.ok(commits.some((c) => c.files.length > 0),
      'every commit parsed with an empty file list — the --name-only format assumption is wrong');
    assert.ok(commits.every((c) => c.files.every((f) => !f.startsWith('/') && !f.includes('\u0000'))),
      'expected clean repo-relative paths, not absolute or NUL-laden ones');
  });

  it('reports paths relative to the PROJECT root when it is not the repo root', () => {
    // `git log --name-only` emits repository-root-relative paths regardless of cwd,
    // so a project rooted in a subdirectory of its repo would match none of its own
    // declared paths and report every commit uncovered. Only a real repo with a real
    // subdirectory can catch this — a fixture would just restate the assumption.
    const fs = require('node:fs');
    const os = require('node:os');
    const nodePath = require('node:path');
    const { execSync } = require('node:child_process');

    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tc-subdir-'));
    try {
      const sub = nodePath.join(root, 'sub');
      fs.mkdirSync(sub);
      fs.writeFileSync(nodePath.join(sub, 'CHANGELOG.md'), '# Changelog\n');
      fs.writeFileSync(nodePath.join(root, 'root.txt'), 'x\n');
      const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      git('init -q .');
      git('add -A');
      git('-c user.email=t@t -c user.name=t commit -qm "seed"');

      const commits = cov._listCommits(sub, 'HEAD~0..HEAD');
      const seeded = cov._listCommits(sub, 'HEAD');
      const files = (commits.length ? commits : seeded).flatMap((c) => c.files);
      assert.ok(files.includes('CHANGELOG.md'),
        `expected a project-relative CHANGELOG.md, got ${JSON.stringify(files)}`);
      assert.ok(!files.includes('sub/CHANGELOG.md'), 'path must not be repo-root-relative');
      assert.ok(!files.includes('root.txt'), 'paths outside the project root are not its concern');

      // And the dirty-path read must agree with the commit listing.
      fs.appendFileSync(nodePath.join(sub, 'CHANGELOG.md'), '- entry\n');
      assert.deepEqual(cov._dirtyPaths(sub), ['CHANGELOG.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips real wrap subjects through git and still excludes them', () => {
    // The exclusion is an assumption about text that has to survive `git log`'s
    // format string: the real post-squash subject carries an em-dash, parentheses
    // and a `#N`, any of which could be mangled between `%s` and the separator.
    // Built as a real repo rather than read from this one's history, so it holds
    // in a shallow CI checkout and does not depend on what happens to be in range.
    const fs = require('node:fs');
    const os = require('node:os');
    const nodePath = require('node:path');
    const { execSync } = require('node:child_process');

    const SUBJECTS = [
      'Session wrap',
      'Session wrap (chunk 04b)',
      'Session wrap on wrap/20260719184554-tangleclaw',
      'Session wrap — release 4.30.0 (Phase B exit, install honesty) (#658)',
      'Stop the wrap reporting success it never verified (#641)'
    ];

    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tc-wrapsubj-'));
    try {
      const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      git('init -q .');
      SUBJECTS.forEach((subject, i) => {
        fs.writeFileSync(nodePath.join(root, `f${i}.txt`), `${i}\n`);
        git('add -A');
        execSync('git -c user.email=t@t -c user.name=t commit -q -F -', {
          cwd: root, input: subject, stdio: ['pipe', 'pipe', 'ignore']
        });
      });

      const commits = cov._listCommits(root, 'HEAD');
      assert.equal(commits.length, SUBJECTS.length, 'every commit must parse into its own record');

      const parsed = commits.map((c) => c.subject).sort();
      assert.deepEqual(parsed, [...SUBJECTS].sort(),
        'a real subject was mangled between git\'s %s and the parser');

      const excluded = commits.filter((c) => cov._isWrapCommit(c.subject)).map((c) => c.subject);
      assert.equal(excluded.length, 4, 'the four wrap subjects must be excluded');
      assert.ok(excluded.includes('Session wrap — release 4.30.0 (Phase B exit, install honesty) (#658)'),
        'the post-squash form is the one that matters — it carries a #N that is never in the changelog');
      assert.ok(!excluded.includes('Stop the wrap reporting success it never verified (#641)'),
        'an ordinary commit mentioning the wrap must not be excluded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
