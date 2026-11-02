'use strict';

/*
 * `lib/branch-ownership.js` (#1977) — cross-session ownership of a branch,
 * and review evidence bound to the exact head it was recorded against.
 *
 * Driven against a real git repository with a real remote, because
 * `handoffBranchOwnership`'s "no unpublished local work" proof is a property
 * of real `git status`/`rev-parse`/upstream-tracking output, not something a
 * mock of it would exercise honestly.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo, cloneRepo } = require('./_temp-repo');
const branchOwnership = require('../lib/branch-ownership');

function makeFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1977-')));
  const remote = path.join(base, 'remote.git');
  const worktreeRoot = path.join(base, 'clone');
  fs.mkdirSync(remote, { recursive: true });
  initRepo(remote, ['--bare', '-b', 'main']);
  cloneRepo(remote, worktreeRoot);
  const git = (...a) => execFileSync('git', a, { cwd: worktreeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(worktreeRoot, 'f.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('push', '-q', '-u', 'origin', 'main');
  git('checkout', '-q', '-b', 'feature');
  git('push', '-q', '-u', 'origin', 'feature');
  return {
    worktreeRoot,
    git,
    headSha: () => git('rev-parse', 'HEAD').toString().trim(),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true })
  };
}

const genA = { sessionId: 'sess-a', projectId: 1, launchId: 'launch-a', generationId: 'gen-a' };
const genB = { sessionId: 'sess-b', projectId: 1, launchId: 'launch-b', generationId: 'gen-b' };

describe('storePath / STORE_BASENAME / lock constants', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('the store lives in the COMMON gitdir, under STORE_BASENAME', () => {
    const commonDir = fx.git('rev-parse', '--git-common-dir').toString().trim();
    assert.equal(branchOwnership.storePath(fx.worktreeRoot),
      path.join(path.resolve(fx.worktreeRoot, commonDir), branchOwnership.STORE_BASENAME));
    assert.equal(branchOwnership.STORE_BASENAME, 'tangleclaw-branch-ownership.json');
  });

  it('the lock constants are sane relative to each other', () => {
    assert.ok(branchOwnership.LOCK_STALE_MS > branchOwnership.LOCK_MAX_WAIT_MS,
      'a lock must be presumed abandoned well after the wait budget this module itself gives up at, or a live holder\'s own pending call could be broken as "stale" by a waiting peer');
  });
});

describe('bindBranchOwnership / readBranchOwnership', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('reads null before anything binds the branch', () => {
    assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature'), null);
  });

  it('a first bind succeeds', () => {
    const result = branchOwnership.bindBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genA, headSha: fx.headSha()
    });
    assert.equal(result.ok, true);
    assert.equal(result.owner.generationId, 'gen-a');
    assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature').generationId, 'gen-a');
  });

  it('the SAME generation re-binding is a renewal that refreshes headSha', () => {
    fs.writeFileSync(path.join(fx.worktreeRoot, 'f.txt'), 'two\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'second');
    const newHead = fx.headSha();
    const result = branchOwnership.bindBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genA, headSha: newHead
    });
    assert.equal(result.ok, true);
    assert.equal(result.owner.headSha, newHead);
  });

  it('a DIFFERENT generation is refused outright, with no force escape', () => {
    const result = branchOwnership.bindBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genB, headSha: fx.headSha()
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BRANCH_OWNED_BY_OTHER_GENERATION');
    assert.equal(result.owner.generationId, 'gen-a');
    assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature').generationId, 'gen-a',
      'the refused attempt must not have overwritten the real owner');
  });

  it('a held lock means the update is SKIPPED, never applied unlocked', () => {
    const file = branchOwnership.storePath(fx.worktreeRoot);
    const lockPath = `${file}${branchOwnership.LOCK_SUFFIX}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(lockPath);
    try {
      const result = branchOwnership.bindBranchOwnership({
        branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genA, headSha: fx.headSha()
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'LOCK_CONTENDED');
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });
});

describe('evaluateBranchMutationGuard', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('admits any caller on a branch nothing has bound yet', () => {
    const result = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genB
    });
    assert.equal(result.allowed, true);
  });

  it('admits the branch\'s own owner generation', () => {
    branchOwnership.bindBranchOwnership({ branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genA, headSha: fx.headSha() });
    const result = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genA
    });
    assert.equal(result.allowed, true);
  });

  it('refuses a cross-owner ordinary mutation as CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN', () => {
    const result = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genB, commandOrAction: 'git commit'
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN');
    assert.equal(result.details.owner.generationId, 'gen-a');
  });

  it('refuses a cross-owner force-push specifically as CROSS_OWNER_FORCE_PUSH_FORBIDDEN', () => {
    const result = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genB, isForcePush: true, commandOrAction: 'git push --force'
    });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'CROSS_OWNER_FORCE_PUSH_FORBIDDEN');
  });

  it('a caller with the SAME sessionId/launchId but no generationId does not bypass a bound generation (#1977 Round 2 finding)', () => {
    // The bound record (genA) has a generationId. A caller sharing genA's
    // sessionId/launchId but omitting generationId entirely — e.g. a stale
    // reference, or simply forgetting to pass it — must not fall back to
    // matching on identity alone once the record itself has a generation.
    const callerNoGeneration = { sessionId: genA.sessionId, launchId: genA.launchId };
    const result = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: callerNoGeneration
    });
    assert.equal(result.allowed, false,
      'omitting generationId must not fall back to a sessionId/launchId match against a record that HAS one');
    assert.equal(result.code, 'CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN');
  });

  it('a store file that exists but is corrupt (invalid JSON) fails closed, denying any mutation rather than reading every branch as unbound (#1977 Round 6 finding)', () => {
    const storeFile = branchOwnership.storePath(fx.worktreeRoot);
    const before_ = fs.readFileSync(storeFile, 'utf8');
    fs.writeFileSync(storeFile, 'not valid json {{{');
    try {
      const result = branchOwnership.evaluateBranchMutationGuard({
        branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genA, isForcePush: true, commandOrAction: 'git push --force'
      });
      assert.equal(result.allowed, false,
        'a present-but-corrupt store must not be read as "every branch unbound" — even this branch\'s own genuine owner (genA) must be refused until the corruption is resolved');
      assert.equal(result.code, 'CORRUPT_BRANCH_OWNERSHIP_STORE');
    } finally {
      fs.writeFileSync(storeFile, before_);
    }
  });
});

describe('recordReviewEvidence / invalidateReviewEvidenceOnRewrite', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('records evidence against the exact head reviewed', () => {
    const head1 = fx.headSha();
    const result = branchOwnership.recordReviewEvidence({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      headSha: head1, gate: 'A-Gate', reviewerId: 'arc', verdict: 'PASS', token: 'TOK-1'
    });
    assert.equal(result.ok, true);
    assert.equal(result.evidence.headSha, head1);

    const record = branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature');
    assert.equal(record.reviewEvidence.length, 1);
    assert.equal(record.reviewEvidence[0].verdict, 'PASS');
  });

  it('a rewrite invalidates evidence tied to the OLD head, keeping only what matches the new one', () => {
    const oldHead = fx.headSha();
    fs.writeFileSync(path.join(fx.worktreeRoot, 'f.txt'), 'rewritten\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '--amend', '-m', 'amended');
    const newHead = fx.headSha();
    assert.notEqual(oldHead, newHead);

    const result = branchOwnership.invalidateReviewEvidenceOnRewrite({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, previousHeadSha: oldHead, newHeadSha: newHead
    });
    assert.equal(result.ok, true);
    assert.equal(result.invalidatedCount, 1);

    const record = branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature');
    assert.equal(record.reviewEvidence.length, 0);
    assert.equal(record.headSha, newHead);
  });

  it('evidence already recorded against the CURRENT head survives a no-op invalidation', () => {
    const head = fx.headSha();
    branchOwnership.recordReviewEvidence({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      headSha: head, gate: 'R-Gate', reviewerId: 'prr-a', verdict: 'ACCEPT'
    });
    const result = branchOwnership.invalidateReviewEvidenceOnRewrite({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, previousHeadSha: head, newHeadSha: head
    });
    assert.equal(result.invalidatedCount, 0);
    assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature').reviewEvidence.length, 1);
  });
});

describe('handoffBranchOwnership', () => {
  let fx;
  before(() => { fx = makeFixture(); });
  after(() => fx.cleanup());

  it('refuses rather than silently passing when there is no basis to verify publication at all', () => {
    // A LOCAL-only branch: no upstream tracking configured, and the caller
    // supplies no fromOwner.headSha either — nothing here to compare
    // localHead against, so this must refuse, not read as "clean."
    fx.git('checkout', '-q', '-b', 'local-only');
    const result = branchOwnership.handoffBranchOwnership({
      branch: 'local-only', worktreeRoot: fx.worktreeRoot,
      fromOwner: { sessionId: 'sess-a', launchId: 'launch-a', generationId: 'gen-a' }, // no headSha
      toOwner: genB
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNABLE_TO_VERIFY_PUBLICATION');
    fx.git('checkout', '-q', 'feature');
  });

  it('refuses when the working tree is not clean', () => {
    branchOwnership.bindBranchOwnership({ branch: 'feature', worktreeRoot: fx.worktreeRoot, ...genA, headSha: fx.headSha() });
    fs.writeFileSync(path.join(fx.worktreeRoot, 'dirty.txt'), 'x\n');
    try {
      const result = branchOwnership.handoffBranchOwnership({
        branch: 'feature', worktreeRoot: fx.worktreeRoot,
        fromOwner: { ...genA, headSha: fx.headSha() }, toOwner: genB
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNPUBLISHED_LOCAL_WORK');
      assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature').generationId, 'gen-a');
    } finally {
      fs.rmSync(path.join(fx.worktreeRoot, 'dirty.txt'), { force: true });
    }
  });

  it('refuses when local HEAD is ahead of the prior owner\'s claimed head (unpublished commit)', () => {
    const publishedHead = fx.headSha();
    fs.writeFileSync(path.join(fx.worktreeRoot, 'f.txt'), 'unpublished\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'local only, never pushed');
    const result = branchOwnership.handoffBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      fromOwner: { ...genA, headSha: publishedHead }, toOwner: genB
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNPUBLISHED_LOCAL_WORK');
    assert.equal(result.details.localHead, fx.headSha());
    fx.git('push', '-q', 'origin', 'feature');
  });

  it('refuses FROM_OWNER_MISMATCH when the claimed prior owner is not the real one', () => {
    const result = branchOwnership.handoffBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      fromOwner: { ...genB, headSha: fx.headSha() }, toOwner: { ...genB, generationId: 'gen-c' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FROM_OWNER_MISMATCH');
  });

  it('succeeds when clean and published, preserves review evidence, and the old generation loses mutation rights', () => {
    branchOwnership.recordReviewEvidence({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      headSha: fx.headSha(), gate: 'A-Gate', reviewerId: 'arc', verdict: 'PASS'
    });
    const result = branchOwnership.handoffBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      fromOwner: { ...genA, headSha: fx.headSha() }, toOwner: genB, reason: 'owner session ended cleanly'
    });
    assert.equal(result.ok, true);
    assert.equal(result.owner.generationId, 'gen-b');
    assert.equal(result.owner.reviewEvidence.length, 1, 'review evidence is about the CODE, not who owns the branch');

    // The old generation (gen-a) no longer owns this branch.
    const guardOld = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genA
    });
    assert.equal(guardOld.allowed, false);
    assert.equal(guardOld.code, 'CROSS_OWNER_BRANCH_MUTATION_FORBIDDEN');

    const guardNew = branchOwnership.evaluateBranchMutationGuard({
      branch: 'feature', worktreeRoot: fx.worktreeRoot, caller: genB
    });
    assert.equal(guardNew.allowed, true);
  });

  it('a caller-supplied fromOwner.headSha that merely mirrors the unpublished local HEAD does not substitute for real verification (#1977 Round 2 finding)', () => {
    // A commit that exists locally and is NEVER pushed. A buggy/naive
    // caller might set fromOwner.headSha to this same unpublished value —
    // trivially "matching" localHead by construction — but that must not
    // be enough: the actual upstream still points at the OLDER commit.
    fs.writeFileSync(path.join(fx.worktreeRoot, 'f.txt'), 'never pushed\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'local only, never pushed, mirrored into fromOwner.headSha');
    const unpublishedHead = fx.headSha();

    const result = branchOwnership.handoffBranchOwnership({
      branch: 'feature', worktreeRoot: fx.worktreeRoot,
      fromOwner: { ...genB, headSha: unpublishedHead }, toOwner: genA
    });
    assert.equal(result.ok, false, 'matching fromOwner.headSha to the unpublished local HEAD must not substitute for real upstream verification');
    assert.equal(result.code, 'UNPUBLISHED_LOCAL_WORK');
    assert.equal(result.details.localHead, unpublishedHead);
    assert.notEqual(result.details.publishedHeadSha, unpublishedHead);

    // Ownership must not have moved on a refused handoff.
    assert.equal(branchOwnership.readBranchOwnership(fx.worktreeRoot, 'feature').generationId, 'gen-b');
  });
});
