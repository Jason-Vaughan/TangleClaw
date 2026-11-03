'use strict';

// #2397 (Architect Ruling A2397): ask before forwarding an instruction
// likely sent to the wrong role. Pure classifier — no store, no route.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const guard = require('../lib/role-instruction-guard');

describe('role-instruction-guard: exported vocabulary', () => {
  it('exposes the intent patterns and role responsibility table', () => {
    assert.ok(Object.keys(guard.INTENT_PATTERNS).includes('code-implementation'));
    assert.ok(Object.keys(guard.INTENT_PATTERNS).includes('commit'));
    assert.ok(Object.keys(guard.INTENT_PATTERNS).includes('merge'));
    assert.ok(Object.keys(guard.INTENT_PATTERNS).includes('release'));
    assert.ok(Object.keys(guard.INTENT_PATTERNS).includes('deploy'));
    assert.deepEqual(Object.keys(guard.ROLE_RESPONSIBILITIES).sort(),
      ['advisor', 'architect', 'builder', 'integrator', 'observer', 'pm', 'reviewer'].sort());
  });
});

describe('role-instruction-guard: detectIntents', () => {
  it('detects each named intent from representative phrasing', () => {
    assert.deepEqual(guard.detectIntents('please implement the new endpoint'), ['code-implementation']);
    assert.deepEqual(guard.detectIntents('go ahead and commit the change'), ['commit']);
    assert.deepEqual(guard.detectIntents('merge the PR once green'), ['merge']);
    assert.deepEqual(guard.detectIntents('cut a release for this'), ['release']);
    assert.deepEqual(guard.detectIntents('deploy the new build'), ['deploy']);
  });

  it('detects multiple intents in one instruction', () => {
    const intents = guard.detectIntents('implement the fix then commit the change and merge the PR');
    assert.ok(intents.includes('code-implementation'));
    assert.ok(intents.includes('commit'));
    assert.ok(intents.includes('merge'));
  });

  it('detects no intent in a plain status question', () => {
    assert.deepEqual(guard.detectIntents('what is the current status of this car?'), []);
  });
});

describe('role-instruction-guard: instructionDigest', () => {
  it('is a stable sha256 hex digest over the exact text', () => {
    const text = 'merge the PR once green';
    const digest = guard.instructionDigest(text);
    assert.equal(digest, crypto.createHash('sha256').update(text).digest('hex'));
    assert.equal(guard.instructionDigest(text), digest);
  });

  it('changes when the text changes at all', () => {
    assert.notEqual(guard.instructionDigest('merge the PR'), guard.instructionDigest('merge the pr'));
  });
});

describe('role-instruction-guard: evaluateRoleInstruction input validation', () => {
  it('refuses a non-object input', () => {
    assert.equal(guard.evaluateRoleInstruction(null).code, 'ROLE_GUARD_INVALID');
    assert.equal(guard.evaluateRoleInstruction(undefined).code, 'ROLE_GUARD_INVALID');
  });

  it('refuses a missing or empty text', () => {
    const base = { targetRole: 'pm', targetSessionId: 's1' };
    assert.equal(guard.evaluateRoleInstruction({ ...base }).code, 'ROLE_GUARD_INVALID');
    assert.equal(guard.evaluateRoleInstruction({ ...base, text: '' }).code, 'ROLE_GUARD_INVALID');
  });

  it('refuses a missing targetSessionId', () => {
    const r = guard.evaluateRoleInstruction({ text: 'status please', targetRole: 'pm' });
    assert.equal(r.code, 'ROLE_GUARD_INVALID');
  });

  it('refuses an unrecognized target role, naming the known roles', () => {
    const r = guard.evaluateRoleInstruction({ text: 'status please', targetRole: 'mascot', targetSessionId: 's1' });
    assert.equal(r.code, 'ROLE_GUARD_INVALID');
    assert.match(r.message, /mascot/);
    assert.match(r.message, /pm/);
  });
});

describe('role-instruction-guard: evaluateRoleInstruction pass-through', () => {
  it('forwards an instruction with no detected mismatch', () => {
    const r = guard.evaluateRoleInstruction({ text: 'what is the current status?', targetRole: 'pm', targetSessionId: 's1' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { forwarded: true, detectedIntents: [], overridden: false });
  });

  it('forwards an instruction whose detected intents are all within the role\'s own scope', () => {
    const r = guard.evaluateRoleInstruction({ text: 'go ahead and merge the PR', targetRole: 'integrator', targetSessionId: 's1' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.detectedIntents, ['merge']);
    assert.equal(r.result.overridden, false);
  });
});

describe('role-instruction-guard: evaluateRoleInstruction mismatch (the named example cases)', () => {
  it('holds a code-implementation instruction sent to the coordinator-only pm role', () => {
    const r = guard.evaluateRoleInstruction({ text: 'please implement the fix', targetRole: 'pm', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
    assert.equal(r.detectedIntent, 'code-implementation');
    assert.equal(r.targetRole, 'pm');
    assert.match(r.reason, /pm/);
    assert.equal(typeof r.confirmationDigest, 'string');
  });

  it('holds a commit instruction sent to the read-only advisor role', () => {
    const r = guard.evaluateRoleInstruction({ text: 'git commit the change', targetRole: 'advisor', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
    assert.equal(r.detectedIntent, 'commit');
  });

  it('holds a code-implementation instruction sent to the read-only reviewer role', () => {
    const r = guard.evaluateRoleInstruction({ text: 'edit the file to fix the bug', targetRole: 'reviewer', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
  });

  it('holds a merge instruction sent to a non-integrator builder lane', () => {
    const r = guard.evaluateRoleInstruction({ text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
    assert.equal(r.detectedIntent, 'merge');
  });

  it('holds a release instruction sent to a non-integrator builder lane', () => {
    const r = guard.evaluateRoleInstruction({ text: 'ship a release for this', targetRole: 'builder', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
    assert.equal(r.detectedIntent, 'release');
  });

  it('holds a deploy instruction sent to the observer role', () => {
    const r = guard.evaluateRoleInstruction({ text: 'restart the live server', targetRole: 'observer', targetSessionId: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
    assert.equal(r.detectedIntent, 'deploy');
  });

  it('never mismatches an architect or integrator target, whose disallowedIntents is empty', () => {
    const architect = guard.evaluateRoleInstruction({ text: 'deploy, merge and release all of it', targetRole: 'architect', targetSessionId: 's1' });
    assert.equal(architect.ok, true);
    const integrator = guard.evaluateRoleInstruction({ text: 'cut a release and deploy it', targetRole: 'integrator', targetSessionId: 's1' });
    assert.equal(integrator.ok, true);
  });
});

describe('role-instruction-guard: evaluateRoleInstruction override', () => {
  it('accepts a confirmRoleOverride that matches the exact text digest', () => {
    const text = 'please implement the fix';
    const digest = guard.instructionDigest(text);
    const r = guard.evaluateRoleInstruction({ text, targetRole: 'pm', targetSessionId: 's1', confirmRoleOverride: digest });
    assert.equal(r.ok, true);
    assert.equal(r.result.overridden, true);
    assert.deepEqual(r.result.detectedIntents, ['code-implementation']);
  });

  it('still blocks on a wrong digest', () => {
    const r = guard.evaluateRoleInstruction({
      text: 'please implement the fix', targetRole: 'pm', targetSessionId: 's1', confirmRoleOverride: 'not-the-real-digest'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED');
  });

  it('still blocks when confirmRoleOverride is absent', () => {
    const r = guard.evaluateRoleInstruction({ text: 'please implement the fix', targetRole: 'pm', targetSessionId: 's1' });
    assert.equal(r.ok, false);
  });

  it('a digest confirmed for one instruction text does not carry over to a different text', () => {
    const digestForOtherText = guard.instructionDigest('a completely different instruction');
    const r = guard.evaluateRoleInstruction({
      text: 'please implement the fix', targetRole: 'pm', targetSessionId: 's1', confirmRoleOverride: digestForOtherText
    });
    assert.equal(r.ok, false);
  });
});

describe('role-instruction-guard: suggestedRole resolution', () => {
  it('suggests the first available role whose own responsibilities allow the mismatched intent', () => {
    const r = guard.evaluateRoleInstruction({
      text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1',
      availableRoles: ['pm', 'advisor', 'integrator', 'architect']
    });
    assert.equal(r.ok, false);
    assert.equal(r.suggestedRole, 'integrator');
  });

  it('skips an available role that also disallows the mismatched intent', () => {
    const r = guard.evaluateRoleInstruction({
      text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1',
      availableRoles: ['pm', 'advisor', 'reviewer', 'architect']
    });
    assert.equal(r.suggestedRole, 'architect');
  });

  it('returns null when no availableRoles were given', () => {
    const r = guard.evaluateRoleInstruction({ text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1' });
    assert.equal(r.suggestedRole, null);
  });

  it('returns null when every available role disallows the mismatched intent', () => {
    const r = guard.evaluateRoleInstruction({
      text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1',
      availableRoles: ['pm', 'advisor', 'reviewer', 'observer']
    });
    assert.equal(r.suggestedRole, null);
  });

  it('ignores an availableRoles entry that is not a recognized role', () => {
    const r = guard.evaluateRoleInstruction({
      text: 'gh pr merge this now', targetRole: 'builder', targetSessionId: 's1',
      availableRoles: ['mascot', 'integrator']
    });
    assert.equal(r.suggestedRole, 'integrator');
  });
});
