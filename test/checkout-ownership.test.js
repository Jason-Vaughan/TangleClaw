'use strict';

/*
 * `lib/checkout-ownership.js` (#1332) — exclusive ownership of one worktree by
 * one live session, and detection of a foreign write landing underneath the
 * session that believes it owns it.
 *
 * Driven against a real git repository (and a real linked worktree), because
 * the baseline-drift property this module exists for — a second edit to an
 * already-`M` file, not just a new status code appearing — is a property of
 * real `git status` output, not something a mock of it would exercise
 * honestly.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const ownership = require('../lib/checkout-ownership');

function makeFixture() {
  const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1332-')));
  initRepo(primary, ['-b', 'main']);
  const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(primary, 'tracked.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const worktree = path.join(primary, '.claude', 'worktrees', 'w');
  git('worktree', 'add', '-q', worktree, '-b', 'feature');
  return {
    primary,
    worktree,
    git: (...a) => execFileSync('git', a, { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'] }),
    cleanup: () => fs.rmSync(primary, { recursive: true, force: true })
  };
}

const ownerA = { sessionId: 'sess-a', projectId: 1, launchId: 'launch-a', workspaceId: 'ws-a', branch: 'feature' };
const ownerB = { sessionId: 'sess-b', projectId: 1, launchId: 'launch-b', workspaceId: 'ws-b', branch: 'feature' };

describe('gitDirFor / markerPath / MARKER_BASENAME', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('resolves the worktree\'s OWN gitdir, not the primary\'s shared one', () => {
    const expected = execFileSync('git', ['-C', fx.worktree, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    assert.equal(ownership.gitDirFor(fx.worktree), path.resolve(fx.worktree, expected));
    assert.notEqual(ownership.gitDirFor(fx.worktree), ownership.gitDirFor(fx.primary),
      'a linked worktree\'s gitdir must differ from the primary\'s own');
  });

  it('markerPath lives inside that gitdir, named MARKER_BASENAME', () => {
    assert.equal(ownership.markerPath(fx.worktree), path.join(ownership.gitDirFor(fx.worktree), ownership.MARKER_BASENAME));
    assert.equal(ownership.MARKER_BASENAME, 'tangleclaw-owner.json');
  });

  it('the lock constants are sane relative to each other', () => {
    assert.ok(ownership.LOCK_STALE_MS > ownership.LOCK_MAX_WAIT_MS,
      'a lock must be presumed abandoned well after the wait budget this module itself gives up at');
  });
});

describe('claimWorktreeOwnership / readWorktreeOwnership / releaseWorktreeOwnership', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('reads null before anything has claimed the worktree', () => {
    assert.equal(ownership.readWorktreeOwnership(fx.worktree), null);
  });

  it('a fresh claim succeeds and is readable back', () => {
    const result = ownership.claimWorktreeOwnership(fx.worktree, ownerA);
    assert.equal(result.ok, true);
    assert.equal(result.owner.sessionId, 'sess-a');
    assert.ok(result.owner.claimedAt);

    const read = ownership.readWorktreeOwnership(fx.worktree);
    assert.equal(read.sessionId, 'sess-a');
    assert.equal(read.workspaceId, 'ws-a');
  });

  it('the SAME owner re-claiming is a renewal, not a conflict', () => {
    const first = ownership.readWorktreeOwnership(fx.worktree).claimedAt;
    const result = ownership.claimWorktreeOwnership(fx.worktree, ownerA);
    assert.equal(result.ok, true);
    assert.ok(result.owner.claimedAt >= first, 'claimedAt should refresh on renewal');
  });

  it('a DIFFERENT live owner is refused without force', () => {
    const result = ownership.claimWorktreeOwnership(fx.worktree, ownerB);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OWNER_MISMATCH');
    assert.equal(result.owner.sessionId, 'sess-a', 'the conflicting owner reported back must be the real current one');
    // Must not have been overwritten by the refused attempt.
    assert.equal(ownership.readWorktreeOwnership(fx.worktree).sessionId, 'sess-a');
  });

  it('a DIFFERENT owner WITH force takes over', () => {
    const result = ownership.claimWorktreeOwnership(fx.worktree, { ...ownerB, force: true });
    assert.equal(result.ok, true);
    assert.equal(result.owner.sessionId, 'sess-b');
    assert.equal(ownership.readWorktreeOwnership(fx.worktree).sessionId, 'sess-b');
  });

  it('releasing as a non-owner without force is refused, and the marker survives', () => {
    const result = ownership.releaseWorktreeOwnership(fx.worktree, ownerA);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OWNER_MISMATCH');
    assert.equal(ownership.readWorktreeOwnership(fx.worktree).sessionId, 'sess-b');
  });

  it('the real owner releases cleanly', () => {
    const result = ownership.releaseWorktreeOwnership(fx.worktree, ownerB);
    assert.equal(result.ok, true);
    assert.equal(result.owner.sessionId, 'sess-b');
    assert.equal(ownership.readWorktreeOwnership(fx.worktree), null);
  });

  it('releasing when nothing is claimed is a no-op success', () => {
    const result = ownership.releaseWorktreeOwnership(fx.worktree, ownerA);
    assert.equal(result.ok, true);
    assert.equal(result.owner, null);
  });

  it('a held lock means claim/release are SKIPPED, never applied unlocked (two sessions racing to claim must not both succeed)', () => {
    const marker = ownership.markerPath(fx.worktree);
    const lockPath = `${marker}${ownership.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(lockPath);
    try {
      const claim = ownership.claimWorktreeOwnership(fx.worktree, ownerA);
      assert.equal(claim.ok, false);
      assert.equal(claim.code, 'LOCK_CONTENDED');
      assert.equal(ownership.readWorktreeOwnership(fx.worktree), null, 'the contended claim must not have written anything');

      const release = ownership.releaseWorktreeOwnership(fx.worktree, ownerA);
      assert.equal(release.ok, false);
      assert.equal(release.code, 'LOCK_CONTENDED');
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });

  it('a STALE claim no longer needs force to take over', () => {
    ownership.claimWorktreeOwnership(fx.worktree, ownerA);
    const marker = ownership.markerPath(fx.worktree);
    const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    record.claimedAt = new Date(Date.now() - ownership.OWNERSHIP_STALE_MS - 1000).toISOString();
    fs.writeFileSync(marker, JSON.stringify(record));

    const result = ownership.claimWorktreeOwnership(fx.worktree, ownerB);
    assert.equal(result.ok, true, 'a stale owner must not block a new claimant');
    assert.equal(result.owner.sessionId, 'sess-b');
    ownership.releaseWorktreeOwnership(fx.worktree, { ...ownerB, force: true });
  });
});

describe('captureBaselineTreeState / verifyTreeUnchangedSinceBaseline', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('headSha matches HEAD, and repeated captures of an unchanged tree produce the same statusHash', () => {
    const state = ownership.captureBaselineTreeState(fx.worktree);
    const headSha = fx.git('rev-parse', 'HEAD').toString().trim();
    assert.equal(state.headSha, headSha);

    const again = ownership.captureBaselineTreeState(fx.worktree);
    assert.equal(again.statusHash, state.statusHash);
  });

  it('an unchanged tree verifies ok against its own baseline', () => {
    const baseline = ownership.captureBaselineTreeState(fx.worktree);
    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, true);
  });

  it('a brand-new untracked file is detected as drift', () => {
    const baseline = ownership.captureBaselineTreeState(fx.worktree);
    fs.writeFileSync(path.join(fx.worktree, 'new.txt'), 'surprise\n');
    try {
      const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
      assert.equal(verified.ok, false);
      assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');
    } finally {
      fs.rmSync(path.join(fx.worktree, 'new.txt'), { force: true });
    }
  });

  it('a SECOND edit to an already-modified file is detected, even though its porcelain status code (M) does not change', () => {
    const trackedPath = path.join(fx.worktree, 'tracked.txt');
    fs.writeFileSync(trackedPath, 'two\n');
    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    // Still "M tracked.txt" in porcelain — the status CODE is identical — but
    // the content is different again. A digest keyed only on the code would
    // miss this outright, which is the exact gap this module exists to close.
    fs.writeFileSync(trackedPath, 'three\n');
    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false);
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'settle tracked.txt at three');
  });

  it('a new commit changes headSha and is detected as drift', () => {
    const baseline = ownership.captureBaselineTreeState(fx.worktree);
    fs.writeFileSync(path.join(fx.worktree, 'committed.txt'), 'x\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'a foreign commit');
    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false);
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');
  });

  it('a missing or malformed baseline is reported distinctly, not as a false "unchanged"', () => {
    assert.equal(ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, null).code, 'INVALID_BASELINE');
    assert.equal(ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, {}).code, 'INVALID_BASELINE');
  });

  it('a SECOND edit to an already-modified NON-ASCII-named file is still detected (#1332 Round 2 finding)', () => {
    // Git quotes a non-ASCII byte as a C-style OCTAL escape in default
    // porcelain output ("\303\251.txt" for é.txt) — not valid JSON despite
    // looking close to it. A JSON.parse-based parser throws, falls back to
    // the literal (bogus) quoted string as the "path", and a read against
    // that always fails — silently reading as ABSENT on every capture, so
    // two DIFFERENT edits to the same real file both digest identically.
    const nonAsciiPath = path.join(fx.worktree, 'é.txt');
    fs.writeFileSync(nonAsciiPath, 'one\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'add non-ascii file');

    fs.writeFileSync(nonAsciiPath, 'two\n');
    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    fs.writeFileSync(nonAsciiPath, 'three\n');
    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false,
      'a real second edit to a non-ASCII-named file must be caught, not silently digested as ABSENT both times');
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'settle é.txt at three');
  });

  it('a staged INDEX blob change is detected even when the working tree and HEAD stay fixed (#1332 Round 3 finding)', () => {
    const trackedPath = path.join(fx.worktree, 'tracked.txt');
    // Stage one change, then edit further WITHOUT staging — porcelain
    // status becomes "MM" (staged diff from HEAD, plus an unstaged diff on
    // top of THAT). The working-tree digest alone cannot see the staged
    // half at all.
    fs.writeFileSync(trackedPath, 'staged-one\n');
    fx.git('add', '-A');
    fs.writeFileSync(trackedPath, 'working-tree-only\n');
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'MM tracked.txt');

    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    // Mutate ONLY the staged index blob via plumbing (never `git add`, which
    // would also touch the working tree) — the working-tree file and HEAD
    // are untouched, and porcelain's status CODE stays exactly "MM" either
    // way, which is the entire gap this fix closes.
    const newBlob = execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: fx.worktree, input: 'staged-two\n' }).toString().trim();
    fx.git('update-index', '--cacheinfo', `100644,${newBlob},tracked.txt`);
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'MM tracked.txt',
      'the mutation must be invisible to the porcelain status CODE — that invisibility is the whole point of this test');

    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false,
      'a staged-only index mutation must be caught even though the working tree and HEAD never changed');
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fs.writeFileSync(trackedPath, 'one\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'settle tracked.txt back to one');
  });

  it('an UNRESOLVED MERGE with multiple index stages is detected when a non-final stage\'s blob is mutated (#1332 Round 4 finding)', () => {
    const trackedPath = path.join(fx.worktree, 'tracked.txt');
    fs.writeFileSync(trackedPath, 'ancestor\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'ancestor');
    const ancestorSha = fx.git('rev-parse', 'HEAD').toString().trim();

    fs.writeFileSync(trackedPath, 'ours\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'ours');

    fx.git('branch', 'theirs-branch', ancestorSha);
    fx.git('checkout', '-q', 'theirs-branch');
    fs.writeFileSync(trackedPath, 'theirs\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'theirs');
    fx.git('checkout', '-q', 'feature');

    try {
      fx.git('merge', '-q', '--no-ff', 'theirs-branch');
    } catch (err) { /* conflict, expected — merge exits non-zero */ }
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'UU tracked.txt');

    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    // Mutate ONLY stage 2 ("ours")'s blob via --index-info plumbing,
    // leaving stage 1 (ancestor) and stage 3 (theirs) untouched. A map
    // overwritten per path (instead of accumulating every stage) would
    // have captured only the LAST stage seen and missed this entirely.
    const newBlob = execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: fx.worktree, input: 'mutated-ours\n' }).toString().trim();
    execFileSync('git', ['update-index', '--index-info'],
      { cwd: fx.worktree, input: `100644 ${newBlob} 2\ttracked.txt\n` });
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'UU tracked.txt',
      'the mutation must be invisible to the porcelain status CODE — that invisibility is the whole point of this test');

    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false,
      'a stage-2-only index mutation inside an unresolved merge must be caught, not lost to a map that only kept the last stage seen');
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fx.git('merge', '--abort');
    fx.git('branch', '-D', 'theirs-branch');
  });

  it('a tracked SYMLINK retargeted between two nonexistent paths is detected, not silently read through as ABSENT both times (#1332 Round 5 finding)', () => {
    const linkPath = path.join(fx.worktree, 'link');
    fs.symlinkSync('first-missing', linkPath);
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'add tracked symlink');

    fs.unlinkSync(linkPath);
    fs.symlinkSync('second-missing', linkPath);
    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    // The real change under test: retarget again. `readFileSync` would
    // dereference the link and hit the SAME ENOENT regardless of target —
    // only `readlinkSync`'s own target text tells these two states apart.
    fs.unlinkSync(linkPath);
    fs.symlinkSync('third-missing', linkPath);
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'M link');

    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false,
      'retargeting a broken symlink is a real change that reading through the dereference cannot see');
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'settle link at third-missing');
  });

  it('a chmod (+x) on an already-modified file is detected even though its content never changes', () => {
    const modePath = path.join(fx.worktree, 'tracked.txt');
    fs.writeFileSync(modePath, 'mode-test\n');
    fs.chmodSync(modePath, 0o644);
    const baseline = ownership.captureBaselineTreeState(fx.worktree);

    fs.chmodSync(modePath, 0o755);
    assert.equal(fx.git('status', '--porcelain').toString().trim(), 'M tracked.txt',
      'content is unchanged, so the status code must stay exactly the same');

    const verified = ownership.verifyTreeUnchangedSinceBaseline(fx.worktree, baseline);
    assert.equal(verified.ok, false, 'a mode-only change must be caught, not hidden behind a content-only digest');
    assert.equal(verified.code, 'FOREIGN_WORKTREE_MUTATION');

    fs.chmodSync(modePath, 0o644);
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'settle tracked.txt mode and content');
  });
});

describe('evaluateWorktreeWriteAdmission', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('admits a write when nothing has claimed the worktree', () => {
    assert.equal(ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerA).allowed, true);
  });

  it('admits the owning session when the tree matches its own recorded baseline', () => {
    const baseline = ownership.captureBaselineTreeState(fx.worktree);
    ownership.claimWorktreeOwnership(fx.worktree,
      { ...ownerA, baselineHeadSha: baseline.headSha, baselineStatusHash: baseline.statusHash });
    assert.equal(ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerA).allowed, true);
  });

  it('refuses the owning session itself once a foreign mutation drifted the tree since its baseline', () => {
    fs.writeFileSync(path.join(fx.worktree, 'foreign.txt'), 'oops\n');
    try {
      const result = ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerA);
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'FOREIGN_WORKTREE_MUTATION');
    } finally {
      fs.rmSync(path.join(fx.worktree, 'foreign.txt'), { force: true });
    }
  });

  it('refuses a DIFFERENT live owner outright, even with the tree otherwise unchanged', () => {
    const result = ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerB);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'OWNER_MISMATCH');
  });

  it('a different but STALE owner no longer blocks on identity, though a real drift against its baseline still fails closed', () => {
    const marker = ownership.markerPath(fx.worktree);
    const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
    record.claimedAt = new Date(Date.now() - ownership.OWNERSHIP_STALE_MS - 1000).toISOString();
    fs.writeFileSync(marker, JSON.stringify(record));

    assert.equal(ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerB).allowed, true,
      'identity mismatch alone must not block once the prior owner is stale');

    fs.writeFileSync(path.join(fx.worktree, 'drifted.txt'), 'x\n');
    try {
      const result = ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerB);
      assert.equal(result.allowed, false, 'a real baseline drift still fails closed regardless of the stale owner\'s identity');
      assert.equal(result.code, 'FOREIGN_WORKTREE_MUTATION');
    } finally {
      fs.rmSync(path.join(fx.worktree, 'drifted.txt'), { force: true });
      ownership.releaseWorktreeOwnership(fx.worktree, { ...ownerB, force: true });
    }
  });

  it('a marker file that exists but is corrupt (invalid JSON) fails closed, denying a foreign caller rather than reading as unowned (#1332 Round 6 finding)', () => {
    ownership.claimWorktreeOwnership(fx.worktree, ownerA);
    const marker = ownership.markerPath(fx.worktree);
    fs.writeFileSync(marker, 'not valid json {{{');
    try {
      const result = ownership.evaluateWorktreeWriteAdmission(fx.worktree, ownerB);
      assert.equal(result.allowed, false,
        'a present-but-corrupt marker must not be read the same as "no marker at all"');
      assert.equal(result.code, 'CORRUPT_OWNERSHIP_MARKER');
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});
