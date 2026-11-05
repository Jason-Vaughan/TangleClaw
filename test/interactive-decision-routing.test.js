'use strict';

// #2828 (v5.66.0 Car 66-B, Architect Ruling A503-R1, #2037 follow-up): the
// five composition pieces that sit on top of `lib/decision-routing.js`'s
// durable decision-request store. Small tier, 100% injectable mocks -- never
// the real store, a real tmux pane, a real clock, or a real network/Discord
// call. Each function's own `deps` is stubbed per test; nothing here opens a
// database or a socket.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const idr = require('../lib/interactive-decision-routing');
const decisionRouting = require('../lib/decision-routing');

const {
  detectInteractiveDecisionPrompt,
  transitionToWaitingDecision,
  resolveDecisionAndResume,
  routeDecisionRequest,
  evaluateDecisionSlaEscalation,
  evaluateAutonomousWithinLease
} = idr;

describe('detectInteractiveDecisionPrompt', () => {
  it('detects Claude Code\'s own AskUserQuestion widget (real footer markers, #2826)', () => {
    const lines = [
      ' Pick one:',
      ' ❯ 1. Option A',
      '   2. Option B',
      '',
      ' Enter to select · ↑/↓ to navigate · Esc to cancel'
    ];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.equal(result.kind, 'ask-user-question');
    assert.equal(result.prompt, 'Pick one:');
    assert.deepEqual(result.choices, ['Option A', 'Option B']);
    assert.equal(result.recommendation, null);
  });

  it('tags a generic numbered menu (no AskUserQuestion footer) as numbered-choice', () => {
    const lines = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.equal(result.kind, 'numbered-choice');
    assert.equal(result.prompt, 'Do you want to proceed?');
    assert.deepEqual(result.choices, ['Yes', 'No']);
  });

  it('accepts a bare ">" cursor and ")" separator, not just "❯" and "."', () => {
    const lines = [' Pick one:', '> 1. Option A', '  2) Option B'];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.deepEqual(result.choices, ['Option A', 'Option B']);
  });

  it('takes a single newline-joined string the same as an array of lines', () => {
    const asString = [' Pick one:', ' ❯ 1. Option A', '   2. Option B'].join('\n');
    const result = detectInteractiveDecisionPrompt(asString);
    assert.deepEqual(result.choices, ['Option A', 'Option B']);
  });

  it('finds the longest choice run even with a footer line after it, not only a trailing run', () => {
    const lines = [' Pick one:', ' ❯ 1. Option A', '   2. Option B', ' Esc to cancel', ' unrelated trailer'];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.deepEqual(result.choices, ['Option A', 'Option B']);
  });

  it('falls back to a bare inline (y/n) confirmation when there is no numbered menu', () => {
    const lines = ['Some unrelated output', 'Continue? (y/n)'];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.equal(result.kind, 'confirmation');
    assert.equal(result.prompt, 'Continue? (y/n)');
    assert.deepEqual(result.choices, ['yes', 'no']);
  });

  it('returns null when nothing in the pane looks like a decision prompt', () => {
    assert.equal(detectInteractiveDecisionPrompt(['just some normal output', 'nothing to see here']), null);
    assert.equal(detectInteractiveDecisionPrompt([]), null);
    assert.equal(detectInteractiveDecisionPrompt(''), null);
  });

  it('respects opts.minChoices: a single numbered line alone is not a menu by default', () => {
    const lines = [' Pick one:', ' ❯ 1. Only option'];
    assert.equal(detectInteractiveDecisionPrompt(lines), null);
    assert.ok(detectInteractiveDecisionPrompt(lines, { minChoices: 1 }));
  });

  it('respects opts.maxLookback: ignores lines beyond the given window', () => {
    const lines = [' ❯ 1. Stale A', '   2. Stale B', 'unrelated recent output'];
    assert.equal(detectInteractiveDecisionPrompt(lines, { maxLookback: 1 }), null);
  });

  it('prompt is null when every line above the choice run is blank', () => {
    const lines = ['', ' ❯ 1. Option A', '   2. Option B'];
    const result = detectInteractiveDecisionPrompt(lines);
    assert.equal(result.prompt, null);
  });
});

describe('transitionToWaitingDecision', () => {
  const session = { id: 42, projectId: 7, launchId: 'launch-abc' };
  const promptDescriptor = { kind: 'numbered-choice', prompt: 'Proceed?', choices: ['Yes', 'No'], recommendation: null };

  it('builds and forwards the right createDecisionRequest input, through the injected dep only', () => {
    let seen = null;
    const deps = {
      createDecisionRequest: (input) => {
        seen = input;
        return { ok: true, request: { decisionId: 'dec_1', ...input } };
      },
      resolveDecisionAuthorityPolicy: () => 'human'
    };
    const result = transitionToWaitingDecision(session, promptDescriptor, deps);
    assert.equal(result.ok, true);
    assert.equal(seen.projectId, 7);
    assert.equal(seen.sessionId, 42);
    assert.equal(seen.launchId, 'launch-abc');
    assert.equal(seen.prompt, 'Proceed?');
    assert.deepEqual(seen.choices, ['Yes', 'No']);
    assert.equal(seen.requiredAuthority, 'human');
    assert.equal(seen.gate, 'numbered-choice');
    assert.equal(seen.ttlMs, 30 * 60 * 1000);
  });

  it('never touches the real store: a deps-free call hits the real createDecisionRequest, which fails closed with no store initialized, rather than silently no-op', () => {
    // Proves the default dep IS the real composed function (the car's whole
    // job), not that this test exercises the real store -- that would need
    // `small` tier's forbidden sqlite. `_db()` throws before any write.
    assert.throws(() => transitionToWaitingDecision(session, promptDescriptor), /not initialized/);
  });

  it('passes promptDescriptor.gate/idemKey/reversible/ttlMs/headSha through when the caller sets them', () => {
    let seen = null;
    const deps = { createDecisionRequest: (input) => { seen = input; return { ok: true, request: { decisionId: 'dec_1' } }; } };
    transitionToWaitingDecision(session, {
      ...promptDescriptor, gate: 'custom-gate', idemKey: 'custom-idem', reversible: true, ttlMs: 5000, headSha: 'abc123',
      requiredAuthority: 'architect'
    }, deps);
    assert.equal(seen.gate, 'custom-gate');
    assert.equal(seen.idemKey, 'custom-idem');
    assert.equal(seen.reversible, true);
    assert.equal(seen.ttlMs, 5000);
    assert.equal(seen.headSha, 'abc123');
    assert.equal(seen.requiredAuthority, 'architect');
  });

  it('calls deps.onSessionTransition with the computed transition on success', () => {
    let transition = null;
    const deps = {
      createDecisionRequest: () => ({ ok: true, request: { decisionId: 'dec_9' } }),
      onSessionTransition: (t) => { transition = t; }
    };
    const result = transitionToWaitingDecision(session, promptDescriptor, deps);
    assert.deepEqual(transition, { sessionId: 42, projectId: 7, workload: 'blocked', reason: 'waiting_decision', decisionId: 'dec_9' });
    assert.deepEqual(result.transition, transition);
  });

  it('does not call onSessionTransition and passes through the refusal when createDecisionRequest fails', () => {
    let called = false;
    const deps = {
      createDecisionRequest: () => ({ ok: false, code: 'DECISION_REQUEST_INVALID', message: 'bad' }),
      onSessionTransition: () => { called = true; }
    };
    const result = transitionToWaitingDecision(session, promptDescriptor, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECISION_REQUEST_INVALID');
    assert.equal(called, false);
  });

  it('refuses a session missing required fields, before calling any dep', () => {
    let called = false;
    const deps = { createDecisionRequest: () => { called = true; return { ok: true, request: {} }; } };
    const result = transitionToWaitingDecision({ id: 1 }, promptDescriptor, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_INVALID');
    assert.equal(called, false);
  });

  it('refuses a promptDescriptor missing prompt/choices', () => {
    const result = transitionToWaitingDecision(session, { kind: 'x' }, { createDecisionRequest: () => ({ ok: true, request: {} }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROMPT_DESCRIPTOR_INVALID');
  });
});

describe('resolveDecisionAndResume', () => {
  it('answers through the injected dep and then calls resumeSession with the answered decision', () => {
    let resumeArgs = null;
    const deps = {
      answerDecisionRequest: (decisionId, answer) => ({
        ok: true,
        request: { decisionId, sessionId: 1, projectId: 2, launchId: 'l1', answer: answer.answer }
      }),
      resumeSession: (session, decision) => { resumeArgs = { session, decision }; return { resumed: true }; }
    };
    const result = resolveDecisionAndResume('dec_1', { answer: 'Yes', expectedPromptDigest: 'd' }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(result.resume, { resumed: true });
    assert.deepEqual(resumeArgs.session, { id: 1, projectId: 2, launchId: 'l1' });
    assert.equal(resumeArgs.decision.answer, 'Yes');
  });

  it('does not call resumeSession when the answer itself is refused', () => {
    let called = false;
    const deps = {
      answerDecisionRequest: () => ({ ok: false, code: 'DECISION_REQUEST_EXPIRED', message: 'expired' }),
      resumeSession: () => { called = true; return { resumed: true }; }
    };
    const result = resolveDecisionAndResume('dec_1', { answer: 'Yes' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECISION_REQUEST_EXPIRED');
    assert.equal(called, false);
  });

  it('with no deps, the default resumeSession hook is an honest inert no-op, not a silent success', () => {
    const deps = { answerDecisionRequest: () => ({ ok: true, request: { decisionId: 'd', sessionId: 1, projectId: 2, launchId: 'l' } }) };
    const result = resolveDecisionAndResume('dec_1', { answer: 'Yes' }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(result.resume, { resumed: false, reason: 'NO_RESUME_HOOK_PROVIDED' });
  });

  it('always answers as surface "operator", regardless of requiredAuthority or who called it (#2037\'s own standing ruling, unchanged here)', () => {
    let seenAnswer = null;
    const deps = {
      answerDecisionRequest: (decisionId, answer) => { seenAnswer = answer; return { ok: true, request: { decisionId } }; }
    };
    resolveDecisionAndResume('dec_1', { answer: 'Yes', answeredByActor: 'architect:someone' }, deps);
    assert.equal(seenAnswer.answeredBySurface, 'operator');
    assert.equal(seenAnswer.answeredByActor, 'architect:someone');
  });
});

describe('routeDecisionRequest', () => {
  const decision = { decisionId: 'dec_1', gate: 'test-gate' };

  it('calling with no deps at all is always safe and does nothing (opt-in-by-default)', () => {
    const result = routeDecisionRequest(decision, ['dashboard', 'medusa', 'discord']);
    assert.deepEqual(result.routed, []);
    assert.deepEqual(result.skipped, [
      { target: 'dashboard', reason: 'NO_ADAPTER_PROVIDED' },
      { target: 'medusa', reason: 'NO_ADAPTER_PROVIDED' },
      { target: 'discord', reason: 'NO_ADAPTER_PROVIDED' }
    ]);
  });

  it('calls each provided adapter with the decision and reports its result', () => {
    const seen = [];
    const result = routeDecisionRequest(decision, ['dashboard', 'medusa'], {
      dashboard: (d) => { seen.push(['dashboard', d.decisionId]); return 'pushed'; },
      medusa: (d) => { seen.push(['medusa', d.decisionId]); return { messageId: 'm1' }; }
    });
    assert.deepEqual(seen, [['dashboard', 'dec_1'], ['medusa', 'dec_1']]);
    assert.deepEqual(result.routed, [
      { target: 'dashboard', ok: true, result: 'pushed' },
      { target: 'medusa', ok: true, result: { messageId: 'm1' } }
    ]);
  });

  it('one target throwing is reported as its own failure and does not stop the others', () => {
    const result = routeDecisionRequest(decision, ['medusa', 'discord'], {
      medusa: () => { throw new Error('medusa down'); },
      discord: () => 'ok'
    });
    assert.deepEqual(result.routed, [
      { target: 'medusa', ok: false, error: 'medusa down' },
      { target: 'discord', ok: true, result: 'ok' }
    ]);
  });

  it('refuses an unknown target instead of silently skipping it the same way as "no adapter"', () => {
    const result = routeDecisionRequest(decision, ['slack'], {});
    assert.deepEqual(result.skipped, [{ target: 'slack', reason: 'UNKNOWN_TARGET' }]);
  });

  it('a non-array targets argument routes nothing', () => {
    assert.deepEqual(routeDecisionRequest(decision, null), { routed: [], skipped: [] });
  });
});

describe('evaluateDecisionSlaEscalation', () => {
  const MINUTE = 60 * 1000;
  const base = {
    decisionId: 'dec_1', state: decisionRouting.STATES.WAITING_DECISION,
    requiredAuthority: 'human', gate: 'a-gate', prompt: 'Proceed?', createdAt: '2026-11-03T08:00:00.000Z'
  };
  const nowMs = Date.parse('2026-11-03T08:35:00.000Z'); // 35 minutes after createdAt

  it('escalates a WAITING_DECISION request past its default SLA', () => {
    const result = evaluateDecisionSlaEscalation([base], nowMs);
    assert.equal(result.escalations.length, 1);
    assert.equal(result.escalations[0].decisionId, 'dec_1');
    assert.equal(result.escalations[0].ageMs, 35 * MINUTE);
    assert.equal(result.escalations[0].payload.kind, 'operator-action-required');
    assert.match(result.escalations[0].payload.text, /a-gate/);
  });

  it('does not escalate a request still within SLA', () => {
    const result = evaluateDecisionSlaEscalation([base], Date.parse('2026-11-03T08:10:00.000Z'));
    assert.deepEqual(result.escalations, []);
  });

  it('does not escalate a non-WAITING_DECISION request, however old', () => {
    const result = evaluateDecisionSlaEscalation([{ ...base, state: decisionRouting.STATES.ANSWERED }], nowMs);
    assert.deepEqual(result.escalations, []);
  });

  it('applies a per-authority-class SLA override over the default', () => {
    const architectDecision = { ...base, requiredAuthority: 'architect' };
    const result = evaluateDecisionSlaEscalation([architectDecision], nowMs, { slaMsByAuthority: { architect: 60 * MINUTE } });
    assert.deepEqual(result.escalations, []); // 35m < 60m override, even though it would have escalated at the 30m default
  });

  it('is a pure function of its own arguments: the exact same inputs always produce the exact same answer', () => {
    const a = evaluateDecisionSlaEscalation([base], nowMs);
    const b = evaluateDecisionSlaEscalation([base], nowMs);
    assert.deepEqual(a, b);
  });

  it('ignores a malformed entry (no createdAt) rather than throwing', () => {
    const result = evaluateDecisionSlaEscalation([{ ...base, createdAt: 'not-a-date' }], nowMs);
    assert.deepEqual(result.escalations, []);
  });
});

describe('evaluateAutonomousWithinLease', () => {
  const decision = {
    decisionId: 'dec_1', requiredAuthority: 'autonomous-within-lease', state: decisionRouting.STATES.WAITING_DECISION,
    gate: 'release-cut', projectId: 7
  };
  const activeLease = { state: 'active', expiresAtMs: Date.now() + 60000, scopeGate: 'release-cut', projectId: 7, grantedToRole: 'architect' };
  const architectCaller = { role: 'architect' };

  it('allows when the lease genuinely covers this decision for this caller', () => {
    assert.deepEqual(evaluateAutonomousWithinLease(decision, activeLease, architectCaller), { allowed: true, reason: null });
  });

  it('refuses a decision whose requiredAuthority is not autonomous-within-lease at all', () => {
    const result = evaluateAutonomousWithinLease({ ...decision, requiredAuthority: 'human' }, activeLease, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'DECISION_NOT_LEASE_SCOPED' });
  });

  it('refuses a decision that is no longer WAITING_DECISION', () => {
    const result = evaluateAutonomousWithinLease({ ...decision, state: decisionRouting.STATES.ANSWERED }, activeLease, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'DECISION_NOT_WAITING' });
  });

  it('refuses with no lease at all', () => {
    assert.deepEqual(evaluateAutonomousWithinLease(decision, null, architectCaller), { allowed: false, reason: 'LEASE_MISSING' });
  });

  it('refuses a lease that is not active', () => {
    const result = evaluateAutonomousWithinLease(decision, { ...activeLease, state: 'draining' }, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_NOT_ACTIVE' });
  });

  it('refuses an expired lease', () => {
    const result = evaluateAutonomousWithinLease(decision, { ...activeLease, expiresAtMs: Date.now() - 1 }, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_EXPIRED' });
  });

  it('refuses a lease scoped to a different project', () => {
    const result = evaluateAutonomousWithinLease(decision, { ...activeLease, projectId: 999 }, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_PROJECT_MISMATCH' });
  });

  it('refuses a lease scoped to a different gate than this decision names', () => {
    const result = evaluateAutonomousWithinLease(decision, { ...activeLease, scopeGate: 'some-other-gate' }, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_SCOPE_MISMATCH' });
  });

  it('refuses a caller whose role is not architect or pm, even holding an otherwise-valid lease', () => {
    const result = evaluateAutonomousWithinLease(decision, activeLease, { role: 'human' });
    assert.deepEqual(result, { allowed: false, reason: 'CALLER_NOT_AUTHORIZED_CLASS' });
  });

  it('refuses when the caller\'s role does not match who the lease was granted to', () => {
    const result = evaluateAutonomousWithinLease(decision, activeLease, { role: 'pm' });
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_ROLE_MISMATCH' });
  });

  it('allows a pm caller holding a lease granted to pm', () => {
    const pmLease = { ...activeLease, grantedToRole: 'pm' };
    assert.deepEqual(evaluateAutonomousWithinLease(decision, pmLease, { role: 'pm' }), { allowed: true, reason: null });
  });

  it('a caller-supplied decision.gate/reversible claim alone, with no matching lease, is never sufficient', () => {
    // The exact shape #2037 Round 2 found unsafe: trusting the decision's own
    // free-text gate/reversible fields. Here they're just data the lease's
    // OWN scopeGate must independently match -- a mismatched or absent lease
    // still refuses regardless of what the decision claims about itself.
    const claimedReversible = { ...decision, reversible: true, gate: 'anything-i-claim' };
    const result = evaluateAutonomousWithinLease(claimedReversible, null, architectCaller);
    assert.deepEqual(result, { allowed: false, reason: 'LEASE_MISSING' });
  });
});
