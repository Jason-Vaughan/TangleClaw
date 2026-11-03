'use strict';

// #2601 (Architect Ruling A2601): cross-engine Builder `gh pr merge` role
// guard. lib/merge-role-guard.js is a pure library: no environment read,
// no real command interception. Every assertion here drives the real
// exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/merge-role-guard');

describe('merge-role-guard: exported vocabulary', () => {
  it('exposes its own role/method vocabulary', () => {
    assert.deepEqual(guard.ROLE_CATEGORIES, ['builder', 'reviewer', 'architect', 'pm', 'integrator']);
    assert.deepEqual(guard.FORBIDDEN_ROLE_CATEGORIES, ['builder', 'reviewer', 'architect', 'pm']);
    assert.equal(guard.ALLOWED_MERGE_METHOD, 'merge');
    assert.deepEqual(guard.MERGE_METHODS, ['merge', 'squash', 'rebase']);
    assert.deepEqual(guard.SHORT_METHOD_FLAGS, { m: 'merge', s: 'squash', r: 'rebase' });
  });
});

describe('merge-role-guard: detectMergeInvocation (#2601)', () => {
  it('recognizes a plain "gh pr merge" invocation', () => {
    const r = guard.detectMergeInvocation('gh pr merge 123 --merge');
    assert.equal(r.isMergeInvocation, true);
    assert.equal(r.mergeMethod, 'merge');
    assert.equal(r.via, 'gh-pr-merge');
  });

  it('recognizes "gh api ... /pulls/<n>/merge"', () => {
    const r = guard.detectMergeInvocation('gh api -X PUT repos/Jason-Vaughan/TangleClaw/pulls/42/merge -f merge_method=merge');
    assert.equal(r.isMergeInvocation, true);
    assert.equal(r.via, 'gh-api');
    assert.equal(r.mergeMethod, 'merge');
  });

  it('recognizes a raw "curl -X PUT .../pulls/<n>/merge"', () => {
    const r = guard.detectMergeInvocation('curl -X PUT https://api.github.com/repos/x/y/pulls/5/merge -d \'{"merge_method":"squash"}\'');
    assert.equal(r.isMergeInvocation, true);
    assert.equal(r.via, 'rest-put');
    assert.equal(r.mergeMethod, 'squash');
  });

  it('is not a merge invocation for an unrelated command, even one mentioning "merge" loosely', () => {
    const r = guard.detectMergeInvocation('git log --oneline main..feature-merge-branch');
    assert.equal(r.isMergeInvocation, false);
    assert.equal(r.mergeMethod, null);
    assert.equal(r.via, null);
  });

  it('is not a merge invocation for "gh pr view" or "gh pr checks"', () => {
    assert.equal(guard.detectMergeInvocation('gh pr view 123').isMergeInvocation, false);
    assert.equal(guard.detectMergeInvocation('gh pr checks 123 --watch').isMergeInvocation, false);
  });

  it('refuses nothing on a missing/non-string commandText -- reports no invocation instead', () => {
    assert.equal(guard.detectMergeInvocation(undefined).isMergeInvocation, false);
    assert.equal(guard.detectMergeInvocation('').isMergeInvocation, false);
  });

  it('reads no merge method at all when none is named', () => {
    const r = guard.detectMergeInvocation('gh pr merge 123');
    assert.equal(r.isMergeInvocation, true);
    assert.equal(r.mergeMethod, null);
  });

  it('recognizes --squash and --rebase the same way as --merge', () => {
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 --squash').mergeMethod, 'squash');
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 --rebase').mergeMethod, 'rebase');
  });

  it('recognizes gh pr merge\'s own documented short aliases -s/-r/-m (PRR-B I-Gate Round 1 #1 on PR #2865)', () => {
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 -s').mergeMethod, 'squash');
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 -r').mergeMethod, 'rebase');
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 -m').mergeMethod, 'merge');
  });

  it('does not mistake a long flag\'s own letters for a short alias (-s inside --squash is not a second match)', () => {
    const r = guard.detectMergeInvocation('gh pr merge 123 --squash');
    assert.equal(r.mergeMethod, 'squash');
  });

  it('does not mistake an unrelated short flag for a merge-method alias', () => {
    const r = guard.detectMergeInvocation('gh pr merge 123 -d');
    assert.equal(r.mergeMethod, null);
  });

  it('a short alias in the middle of other flags is still recognized', () => {
    assert.equal(guard.detectMergeInvocation('gh pr merge 123 -s --match-head-commit abc').mergeMethod, 'squash');
  });
});

describe('merge-role-guard: evaluateMergeRoleGuard (#2601)', () => {
  it('refuses a non-string commandText', () => {
    assert.equal(guard.evaluateMergeRoleGuard({ commandText: 123 }).code, 'MERGE_ROLE_GUARD_INVALID');
  });

  it('refuses a non-string role or lane when present', () => {
    assert.equal(guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 1', role: 42 }).code, 'MERGE_ROLE_GUARD_INVALID');
    assert.equal(guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 1', lane: 42 }).code, 'MERGE_ROLE_GUARD_INVALID');
  });

  it('allows any command that is not a PR-merge invocation, whatever the role', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'git status', role: 'builder' });
    assert.equal(r.ok, true);
    assert.equal(r.result.allowed, true);
  });

  for (const role of ['builder', 'reviewer', 'architect', 'pm']) {
    it(`refuses a "${role}" role from merging (Rule #282)`, () => {
      const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', role });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'MERGE_ROLE_FORBIDDEN');
    });
  }

  for (const [lane, label] of [['TC-Lane-A', 'builder'], ['TC-Lane-B', 'builder'], ['TC-Lane-C', 'builder'], ['TC-Lane-D', 'builder'],
    ['TC-Lane-PRR-A', 'reviewer'], ['TC-Lane-PRR-B', 'reviewer'], ['TC-Lane-Arc', 'architect'], ['TC-Lane-PM', 'pm']]) {
    it(`refuses lane "${lane}" (resolves as ${label}) from merging`, () => {
      const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', lane });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'MERGE_ROLE_FORBIDDEN');
    });
  }

  it('allows role "integrator" to merge with --merge', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', role: 'integrator' });
    assert.equal(r.ok, true);
    assert.equal(r.result.reason, 'authorized Integrator');
  });

  it('allows lane "TC-Lane-INT" to merge with --merge', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', lane: 'TC-Lane-INT' });
    assert.equal(r.ok, true);
  });

  it('allows an explicit operator context to merge with --merge', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', isOperator: true });
    assert.equal(r.ok, true);
    assert.equal(r.result.reason, 'explicit operator context');
  });

  it('refuses an integrator using --squash with MERGE_METHOD_FORBIDDEN, not MERGE_ROLE_FORBIDDEN', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --squash', role: 'integrator' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MERGE_METHOD_FORBIDDEN');
  });

  it('refuses the operator using --rebase the same way', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --rebase', isOperator: true });
    assert.equal(r.code, 'MERGE_METHOD_FORBIDDEN');
  });

  it('refuses an authorized Integrator using the short -s alias just as it would --squash (PRR-B I-Gate Round 1 #1 on PR #2865)', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 -s', role: 'integrator' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MERGE_METHOD_FORBIDDEN');
  });

  it('refuses the operator using the short -r alias just as it would --rebase', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 -r', isOperator: true });
    assert.equal(r.code, 'MERGE_METHOD_FORBIDDEN');
  });

  it('allows the short -m alias, same as --merge', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 -m', role: 'integrator' });
    assert.equal(r.ok, true);
  });

  it('a forbidden role using --squash is refused for the role, not the method (role checked first)', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --squash', role: 'builder' });
    assert.equal(r.code, 'MERGE_ROLE_FORBIDDEN');
  });

  it('an unrecognized role AND lane (neither given) is refused, failing closed', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MERGE_ROLE_FORBIDDEN');
  });

  it('isOperator: true overrides a forbidden role, never the reverse', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', role: 'builder', isOperator: true });
    assert.equal(r.ok, true);
    assert.equal(r.result.reason, 'explicit operator context');
  });

  it('an explicit role takes priority over a lane id when both are given', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123 --merge', role: 'integrator', lane: 'TC-Lane-B' });
    assert.equal(r.ok, true);
  });

  it('a merge method with no --merge/--squash/--rebase flag at all is allowed for an authorized caller (defaults to the GitHub API default, not refused here)', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh pr merge 123', role: 'integrator' });
    assert.equal(r.ok, true);
  });

  it('refuses a forbidden-role gh api merge invocation the same way as gh pr merge', () => {
    const r = guard.evaluateMergeRoleGuard({ commandText: 'gh api -X PUT repos/x/y/pulls/5/merge', role: 'reviewer' });
    assert.equal(r.code, 'MERGE_ROLE_FORBIDDEN');
  });
});
