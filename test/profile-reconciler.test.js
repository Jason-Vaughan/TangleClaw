'use strict';

/*
 * #1967 — Session Profile Reconciler (`lib/profile-reconciler.js`).
 *
 * The motivating incident was a restoration that looked fine and wasn't: a
 * fallback model was applied, the restore back to the original was attempted,
 * and nothing verified it actually landed. These tests pin the properties the
 * required contract names directly: no global default, no clear without a
 * fresh safe-to-clear checkpoint, no guessed menu navigation, fail-closed on
 * anything unverified, and every transition audited.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tmux = require('../lib/tmux');
const { setLevel } = require('../lib/logger');

setLevel('error');

const reconciler = require('../lib/profile-reconciler');

beforeEach(() => {
  reconciler._resetForTests();
});

/** A fake tmux seam: `sendKeys` records calls, `capturePane` returns scripted lines. */
function fakeTmux(lines = []) {
  const sent = [];
  return {
    sent,
    tmux: {
      sendKeys(session, text) { sent.push({ session, text }); },
      capturePane() { return { lines }; }
    }
  };
}

describe('setDesiredProfile / getDesiredProfile', () => {
  it('rejects a profile with no engine', () => {
    const result = reconciler.setDesiredProfile('r1', { model: 'claude-opus-5-5' });
    assert.equal(result.ok, false);
  });

  it('stores a desired profile per resource, independent of other resources', () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    assert.equal(reconciler.getDesiredProfile('r1').model, 'claude-opus-5-5');
    assert.equal(reconciler.getDesiredProfile('r2'), null);
  });

  it('has no global default — an unset resource is unknown, never "the default"', () => {
    assert.equal(reconciler.getDesiredProfile('never-set'), null);
  });
});

describe('reconcile: no desired profile / no adapter', () => {
  it('holds a resource with no desired profile on record', async () => {
    const { tmux } = fakeTmux();
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('holds a resource whose desired engine has no registered adapter', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'nonexistent-engine', model: 'x' });
    const { tmux } = fakeTmux();
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].detail.reason, 'UNSUPPORTED_ENGINE');
  });
});

describe('reconcile: already matching', () => {
  it('verifies without sending anything when the observed profile already matches', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-5-5']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
    assert.equal(sent.length, 0, 'nothing should be sent to a pane that already matches');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].transition, 'verified');
  });
});

describe('reconcile: clear requires a fresh safe-to-clear checkpoint', () => {
  it('refuses to issue /clear with no checkpoint on record — a destructive control, held back', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    // Pane shows a different model — a clear would normally be tried first,
    // but nothing records it as safe here.
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    const clearSent = sent.some((s) => s.text === '/clear');
    assert.equal(clearSent, false, '/clear must never be sent without a recorded safe-to-clear checkpoint');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'NO_SAFE_TO_CLEAR_CHECKPOINT'));
  });

  it('refuses /clear when the checkpoint on record is not safeToClear: true', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: false, generation: 'g1', note: 'mid-write' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(sent.some((s) => s.text === '/clear'), false);
  });

  it('issues /clear only once a safe-to-clear checkpoint is recorded', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.ok(sent.some((s) => s.text === '/clear'));
  });

  it('rejects a checkpoint receipt with no generation', () => {
    const result = reconciler.recordCheckpoint('r1', { safeToClear: true });
    assert.equal(result.ok, false);
    assert.equal(reconciler.getCheckpoint('r1'), null);
  });

  it('PRR-A finding 3: refuses a stale checkpoint — a timestamp alone does not authorize /clear forever', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' }, { now: () => 1000 });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    // Default max age is 5 minutes; this reconcile runs 10 minutes later.
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1', now: () => 1000 + 10 * 60 * 1000 });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a stale checkpoint must not authorize /clear');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_STALE'));
  });

  it('honors a caller-supplied checkpointMaxAgeMs instead of the 5-minute default', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' }, { now: () => 1000 });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1', now: () => 1000 + 30 * 1000, checkpointMaxAgeMs: 10 * 1000 });
    assert.equal(sent.some((s) => s.text === '/clear'), false);
  });

  it('PRR-A finding 3: refuses a checkpoint recorded for a different generation of the resource', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'session-before-relaunch' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    // The resource relaunched under a new generation since the checkpoint was recorded.
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'session-after-relaunch' });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a checkpoint for a stale generation must not authorize /clear on the current one');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_GENERATION_MISMATCH'));
  });

  it('PRR-A finding 3, round 2: refuses /clear when the caller omits currentGeneration entirely — no opt-out', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    // Deliberately no currentGeneration at all — this used to skip the
    // generation check entirely and authorize /clear on the checkpoint's
    // bare presence.
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a missing currentGeneration must refuse /clear, not skip the check');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_GENERATION_MISMATCH'));
  });

  it('a checkpoint matching the current generation is still honored', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'session-r1-gen1' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'session-r1-gen1' });
    assert.ok(sent.some((s) => s.text === '/clear'));
  });

  it('PRR-A finding 3: a checkpoint already consumed by a successful /clear cannot authorize a second one', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux: tmux1 } = fakeTmux(['Model: claude-opus-4-8']);
    const first = await reconciler.reconcile('r1', 'session-r1', { tmux: tmux1, currentGeneration: 'g1' });
    assert.equal(first.ok, false, 'the pane never actually moves in this fake, so reconciliation still ends in hold');
    assert.equal(reconciler.getCheckpoint('r1'), null, 'the checkpoint is consumed once /clear is actually sent, whether or not the rest of reconciliation later verifies');

    // A second reconcile, still mismatched, with no new checkpoint recorded.
    const { tmux: tmux2, sent: sent2 } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux: tmux2 });
    assert.equal(sent2.some((s) => s.text === '/clear'), false, 'the consumed checkpoint must not authorize a second /clear');
  });
});

describe('reconcile: deps.stillValid aborts a superseded resource (PRR-A finding 4, round 2 on PR #2757)', () => {
  it('aborts before the first observation when the resource is already superseded', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    let observeCalls = 0;
    const tmux = { sendKeys() {}, capturePane() { observeCalls += 1; return { lines: ['Model: claude-opus-4-8'] }; } };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, stillValid: () => false });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    assert.equal(observeCalls, 0, 'a superseded resource must not even be observed');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].detail.reason, 'RESOURCE_SUPERSEDED');
  });

  it('aborts before issuing a control once the resource is superseded mid-reconciliation — simulates a rapid end + relaunch', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    let stillHere = true;
    const sent = [];
    const tmux = {
      sendKeys(session, text) { sent.push(text); },
      // The session ends (a relaunch under a new generation) the instant the
      // first observation returns — simulating the window finding 4 names: a
      // rapid end + relaunch landing between this call starting and it
      // reaching its first control.
      capturePane() { stillHere = false; return { lines: ['Model: claude-opus-4-8'] }; }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', stillValid: () => stillHere
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    assert.equal(sent.length, 0, 'no control may be sent once the resource is no longer the one asked for');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].detail.reason, 'RESOURCE_SUPERSEDED');
  });

  it('with no stillValid supplied, every check passes — opt-in, not a new default requirement', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux } = fakeTmux(['Model: claude-opus-5-5']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, true);
  });
});

describe('reconcile: explicit model argument, never a guessed menu', () => {
  it('sends /model with the exact desired id as a literal argument', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.ok(sent.some((s) => s.text === '/model claude-opus-5-5'));
    // Never an arrow key or any other guessed-navigation keystroke.
    assert.ok(sent.every((s) => !/^(Up|Down|Left|Right|Tab)$/.test(s.text)));
  });

  it('verifies and stops once the second observation matches after applying the controls', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    let call = 0;
    const tmux = {
      sent: [],
      sendKeys(session, text) { tmux.sent.push({ session, text }); },
      capturePane() {
        call += 1;
        // First observation (pre-dispatch) shows the stale model; the second
        // (post-reconciliation) shows the desired one landed.
        return { lines: [call === 1 ? 'Model: claude-opus-4-8' : 'Model: claude-opus-5-5'] };
      }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
  });
});

describe('reconcile: fail closed on an unverified or mismatched result', () => {
  it('holds when the post-reconciliation observation still does not match', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    // Every capture, before and after, shows the wrong model — the attempted
    // controls did not take effect.
    const { tmux } = fakeTmux(['Model: claude-opus-4-8']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].transition, 'refused');
    assert.equal(audit[audit.length - 1].detail.reason, 'STILL_MISMATCHED');
  });

  it('holds, not verifies, when the pane cannot be read at all (spoof/failure: no false positive on silence)', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const tmux = {
      sendKeys() {},
      capturePane() { throw new Error('tmux session "session-r1" does not exist'); }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('does not treat a desired model id appearing as a SUBSTRING of an unrelated line as a match (spoof)', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    // The exact id string is present in the pane, but not as the parser's
    // recognized "Model: <id>" shape — e.g. the operator typed it in chat.
    const { tmux } = fakeTmux(['> I would like to use claude-opus-5-5 please']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('PRR-A finding, round 3: two conflicting "Model:" lines in the pane hold the reconciliation end to end', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'desired-model' });
    const { tmux } = fakeTmux(['────────────', 'Model: wrong-model', 'Model: desired-model', '>']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('holds when an adapter throws while applying a control, rather than assuming it landed', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const tmux = {
      sendKeys(session, text) {
        if (text.startsWith('/model')) throw new Error('pane is not accepting input');
      },
      capturePane() { return { lines: ['Model: claude-opus-4-8'] }; }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.control === 'explicitModel' && e.transition === 'refused' && e.detail.reason === 'ADAPTER_ERROR'));
  });
});

describe('audit log', () => {
  it('records requested/applied/verified transitions in order for a full reconciliation', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    let call = 0;
    const tmux = {
      sendKeys() {},
      capturePane() {
        call += 1;
        return { lines: [call === 1 ? 'Model: claude-opus-4-8' : 'Model: claude-opus-5-5'] };
      }
    };
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1' });
    const transitions = reconciler.getAudit('r1').map((e) => `${e.transition}:${e.control || ''}`);
    assert.deepEqual(transitions, [
      'requested:clear', 'applied:clear',
      'requested:explicitModel', 'applied:explicitModel',
      'verified:'
    ]);
  });

  it('keeps each resource\'s audit log independent', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'm1' });
    reconciler.setDesiredProfile('r2', { engine: 'claude', model: 'm2' });
    const { tmux: tmux1 } = fakeTmux(['Model: m1']);
    const { tmux: tmux2 } = fakeTmux(['Model: other']);
    await reconciler.reconcile('r1', 's1', { tmux: tmux1 });
    await reconciler.reconcile('r2', 's2', { tmux: tmux2 });
    assert.equal(reconciler.getAudit('r1').length, 1);
    assert.ok(reconciler.getAudit('r2').length >= 1);
    assert.notEqual(reconciler.getAudit('r1')[0].at, undefined);
  });
});

describe('CLAUDE_ADAPTER.supports', () => {
  it('supports clear and explicitModel, not yet effortMode', () => {
    assert.equal(reconciler.CLAUDE_ADAPTER.supports('clear'), true);
    assert.equal(reconciler.CLAUDE_ADAPTER.supports('explicitModel'), true);
    assert.equal(reconciler.CLAUDE_ADAPTER.supports('effortMode'), false);
  });
});

describe('CODEX_ADAPTER (PRR-A finding 1, round 2 on PR #2757: observation only)', () => {
  it('is registered', () => {
    assert.equal(reconciler.getAdapter('codex'), reconciler.CODEX_ADAPTER);
  });

  it('claims no controls at all — observation only, no measured evidence for any Codex control yet', () => {
    assert.equal(reconciler.CODEX_ADAPTER.supports('clear'), false);
    assert.equal(reconciler.CODEX_ADAPTER.supports('explicitModel'), false);
    assert.equal(reconciler.CODEX_ADAPTER.supports('effortMode'), false);
  });

  it('throws rather than silently no-op if a direct caller asks it to issue a control anyway', async () => {
    await assert.rejects(() => reconciler.CODEX_ADAPTER.issueClear('s'), /observation only/);
    await assert.rejects(() => reconciler.CODEX_ADAPTER.issueModel('s', 'x'), /observation only/);
    await assert.rejects(() => reconciler.CODEX_ADAPTER.issueEffortMode('s', {}), /observation only/);
  });

  it('observes through the same shared default parser as Claude, tagged with its own engine id', async () => {
    const { tmux } = fakeTmux(['Model: gpt-5.6-sol']);
    const observed = await reconciler.CODEX_ADAPTER.observeActiveProfile('s', { tmux });
    assert.deepEqual(observed, { engine: 'codex', model: 'gpt-5.6-sol' });
  });
});

describe('getAdmissionState (PRR-A finding 1, round 2 on PR #2757)', () => {
  it('is "pending" before any reconciliation has run for a resource', () => {
    assert.equal(reconciler.getAdmissionState('never-reconciled'), 'pending');
  });

  it('becomes "verified" after a reconciliation that converges', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux } = fakeTmux(['Model: claude-opus-5-5']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(reconciler.getAdmissionState('r1'), 'verified');
  });

  it('becomes "held" after a reconciliation that does not converge, and stays held — never silently reset', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux } = fakeTmux(['Model: wrong-model']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(reconciler.getAdmissionState('r1'), 'held');
  });

  it('is "held" for every kind of refusal, including an unsupported engine — the admission question has one uniform answer', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'gemini', model: 'x' });
    await reconciler.reconcile('r1', 'session-r1', {});
    assert.equal(reconciler.getAdmissionState('r1'), 'held');
  });

  it('is independent per resource', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'm1' });
    reconciler.setDesiredProfile('r2', { engine: 'claude', model: 'm2' });
    await reconciler.reconcile('r1', 's1', { tmux: fakeTmux(['Model: m1']).tmux });
    await reconciler.reconcile('r2', 's2', { tmux: fakeTmux(['Model: not-m2']).tmux });
    assert.equal(reconciler.getAdmissionState('r1'), 'verified');
    assert.equal(reconciler.getAdmissionState('r2'), 'held');
  });
});

describe('getCheckpoint', () => {
  it('returns null when nothing was ever recorded for a resource', () => {
    assert.equal(reconciler.getCheckpoint('never-checkpointed'), null);
  });

  it('returns the most recently recorded checkpoint', () => {
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1', note: 'first' }, { now: () => 1 });
    reconciler.recordCheckpoint('r1', { safeToClear: false, generation: 'g1', note: 'second' }, { now: () => 2 });
    const cp = reconciler.getCheckpoint('r1');
    assert.equal(cp.safeToClear, false);
    assert.equal(cp.note, 'second');
    assert.equal(cp.at, 2);
  });

  it('rejects a receipt with no boolean safeToClear', () => {
    const result = reconciler.recordCheckpoint('r1', { note: 'missing the required field' });
    assert.equal(result.ok, false);
  });
});

describe('registerAdapter / getAdapter', () => {
  it('ships with the Claude adapter pre-registered', () => {
    assert.equal(reconciler.getAdapter('claude'), reconciler.CLAUDE_ADAPTER);
  });

  it('returns null for an engine with no registered adapter', () => {
    assert.equal(reconciler.getAdapter('nonexistent-engine'), null);
  });

  it('registers a new adapter so reconcile can use an engine beyond Claude (extensibility contract)', async () => {
    const fakeAdapter = {
      supports: (c) => c === 'explicitModel',
      issueModel: async () => {},
      observeActiveProfile: async () => ({ engine: 'fake-engine', model: 'fake-model' })
    };
    reconciler.registerAdapter('fake-engine', fakeAdapter);
    assert.equal(reconciler.getAdapter('fake-engine'), fakeAdapter);
    reconciler.setDesiredProfile('r1', { engine: 'fake-engine', model: 'fake-model' });
    const result = await reconciler.reconcile('r1', 'session-r1', {});
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
  });
});

describe('CONTROL_ORDER', () => {
  it('is the fixed, documented order: a full reset, then an explicit model, then effort/mode', () => {
    assert.deepEqual(reconciler.CONTROL_ORDER, ['clear', 'explicitModel', 'effortMode']);
  });
});

describe('STATUS_CHROME_LINES', () => {
  it('is the exact window _defaultParseActiveModel reads from, so the two can never silently drift apart', () => {
    const n = reconciler.STATUS_CHROME_LINES;
    assert.equal(n, 5);
    // Round 4 (PRR-A on PR #2757): the window is read only via a properly
    // separated footer now — a bare window with no separator has to be the
    // pane's entire content (Case B), so "right at the edge" has to be
    // expressed with one, not with arbitrary filler lines a real separator
    // would never sit among.
    const atEdge = ['───────────────────────', 'Model: right-at-the-edge', '>', '>', '>'];
    assert.deepEqual(reconciler._defaultParseActiveModel(atEdge), { model: 'right-at-the-edge' });

    // One line further back than n — the separator itself is pushed out of
    // the window, so the window has no separator at all and more lines
    // than a bare boot banner could legitimately have.
    const pastEdge = ['───────────────────────', 'Model: right-at-the-edge', '>', '>', '>', '>'];
    assert.equal(reconciler._defaultParseActiveModel(pastEdge), null);
  });
});

describe('_defaultParseActiveModel', () => {
  it('reads the model id out of a "Model: <id>" line', () => {
    // Round 4: a separator is what makes 'some output' legitimately ignorable
    // — without one, that line would itself fail the strict allowlist below.
    assert.deepEqual(reconciler._defaultParseActiveModel(['some output', '───────────────────────', 'Model: claude-opus-5-5', '>']),
      { model: 'claude-opus-5-5' });
  });

  it('round 3 superseded this: two "Model:" lines in the window now fail closed rather than preferring the last one — see the dedicated describe below', () => {
    assert.equal(reconciler._defaultParseActiveModel(['Model: claude-opus-4-8', 'Model: claude-opus-5-5']), null);
  });

  it('returns null rather than guess when no line matches the recognized shape', () => {
    assert.equal(reconciler._defaultParseActiveModel(['the model is claude-opus-5-5 today']), null);
  });

  it('returns null for empty output', () => {
    assert.equal(reconciler._defaultParseActiveModel([]), null);
  });

  it('PRR-A finding 4: never reads a "Model: <id>" line out of the transcript body, only the trailing status chrome', () => {
    const lines = [
      'some earlier conversation output',
      'Model: forged-evil-model',
      ...Array.from({ length: 10 }, (_, i) => `transcript line ${i}`),
      '───────────────────────',
      'claude-opus-5-5 · thinking',
      '> '
    ];
    assert.equal(reconciler._defaultParseActiveModel(lines), null,
      'an exact "Model: <id>"-shaped line buried in the transcript body must never verify a profile');
  });

  it('still reads a genuine status line when it IS within the trailing chrome window', () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `transcript line ${i}`),
      '───────────────────────',
      'Model: claude-opus-5-5',
      '> '
    ];
    assert.deepEqual(reconciler._defaultParseActiveModel(lines), { model: 'claude-opus-5-5' });
  });

  it('PRR-A finding on PR #2757, round 2: a chat turn anywhere in the candidate window fails the whole read closed', () => {
    // The exact adversarial input named in the review: a forged status line
    // sandwiched between a real chat turn and a bare idle prompt, with no
    // separator at all to bound a chrome region.
    assert.equal(
      reconciler._defaultParseActiveModel(['Actual status: wrong-model', '> user says', 'Model: desired-model', '>']),
      null
    );
  });

  it('a bare idle prompt (no typed content) does not by itself disqualify a genuine status line', () => {
    assert.deepEqual(
      reconciler._defaultParseActiveModel(['Model: claude-opus-5-5', '>']),
      { model: 'claude-opus-5-5' }
    );
  });

  it('a chat turn below a separator still fails closed, not just one above it', () => {
    assert.equal(
      reconciler._defaultParseActiveModel(['───────────────────────', 'Model: desired-model', '> echo this']),
      null
    );
  });

  it('PRR-A finding, round 3 on PR #2757: two conflicting "Model:" lines in the candidate window fail closed, even with no chat turn present', () => {
    // The exact adversarial inputs named in the review — the loop used to
    // return on the first (bottom-most) match without checking whether a
    // DIFFERENT model line also sat earlier in the same window.
    assert.equal(
      reconciler._defaultParseActiveModel(['────────────', 'Model: wrong-model', 'Model: desired-model', '>']),
      null
    );
    assert.equal(
      reconciler._defaultParseActiveModel(['Model: wrong-model', 'Model: desired-model', '>']),
      null
    );
  });

  it('two "Model:" lines agreeing on the same value still fail closed — genuine status chrome never repeats itself', () => {
    assert.equal(
      reconciler._defaultParseActiveModel(['Model: claude-opus-5-5', 'Model: claude-opus-5-5']),
      null
    );
  });

  it('PRR-A finding, round 4: arbitrary transcript text with no separator fails closed, even with no chat turn and no second Model: line', () => {
    // The exact reproduction named in the review — with no separator to
    // bound a chrome region, 'transcript output' was never checked for
    // being anything other than a chat-turn-shaped line, so it slipped
    // through as if it were legitimate context around a real status line.
    assert.equal(
      reconciler._defaultParseActiveModel(['transcript output', 'Model: desired-model', '>']),
      null
    );
  });

  it('PRR-A finding, round 4: a stale "Model:" line pushed outside the trailing window by filler, with no separator anywhere, fails closed', () => {
    // The exact reproduction named in the review — the stale line being
    // outside STATUS_CHROME_LINES let it slip past the round-3 "two
    // matches in the window" check entirely; Case B's own length/position
    // rule (not a whole-pane scan) is what catches this one: with no
    // separator at all, nonEmpty is longer than the window allows.
    assert.equal(
      reconciler._defaultParseActiveModel([
        'Model: wrong-model', 'transcript 1', 'transcript 2', 'transcript 3',
        'transcript 4', 'transcript 5', 'Model: desired-model', '>'
      ]),
      null
    );
  });
});

describe('_matches', () => {
  it('never matches a different engine, whatever else agrees', () => {
    assert.equal(reconciler._matches({ engine: 'codex', model: 'x' }, { engine: 'claude', model: 'x' }), false);
  });

  it('treats a desired field the caller left unset as "don\'t care"', () => {
    assert.equal(reconciler._matches({ engine: 'claude', model: 'anything' }, { engine: 'claude' }), true);
  });

  it('does not match a null observation', () => {
    assert.equal(reconciler._matches(null, { engine: 'claude' }), false);
  });
});

/*
 * PRR-A finding 2 on PR #2757 (#1967): "wire profile-reconciler into
 * production ... and add an integration test proving production wiring
 * converges a session." `lib/sessions.js`'s `_verifyModelAfterLaunch` is that
 * one production call site — the exact function `launchSession` schedules
 * after every launch that selected a model — and these call it directly,
 * through the real (not re-implemented) `setDesiredProfile` +
 * `reconcile` + `CLAUDE_ADAPTER` path, faking only the tmux pane I/O a unit
 * test cannot have a real one for.
 */
describe('sessions._verifyModelAfterLaunch — production wiring converges a session (#1967/#2188 PRR-A finding 2)', () => {
  const sessions = require('../lib/sessions');
  const store = require('../lib/store');

  beforeEach(() => {
    reconciler._resetForTests();
  });

  it('converges immediately when the pane already shows the requested model — nothing is sent', async () => {
    const { tmux, sent } = fakeTmux(['Model: claude-opus-5-5']);
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-1', 9001, 1, 'claude', 'claude-opus-5-5', { tmux, stillValid: () => true });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
    assert.equal(sent.length, 0);
  });

  it('converges a mismatch by sending the real explicit /model control and re-observing', async () => {
    let call = 0;
    const sent = [];
    const tmux = {
      sendKeys(session, text) { sent.push(text); },
      capturePane() {
        call += 1;
        return { lines: [call === 1 ? 'Model: claude-opus-4-8' : 'Model: claude-opus-5-5'] };
      }
    };
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-2', 9002, 1, 'claude', 'claude-opus-5-5', { tmux, stillValid: () => true });
    assert.ok(sent.includes('/model claude-opus-5-5'));
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
    // The real audit trail this production call site leaves behind, keyed by
    // the exact resourceId `_verifyModelAfterLaunch` uses.
    const audit = reconciler.getAudit('session:9002');
    assert.ok(audit.some((e) => e.transition === 'requested' && e.control === 'explicitModel'));
    assert.ok(audit.some((e) => e.transition === 'verified'));
  });

  it('holds, honestly, rather than falsely verifying, when the pane never converges', async () => {
    const { tmux } = fakeTmux(['Model: some-other-model']);
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-3', 9003, 1, 'claude', 'claude-opus-5-5', { tmux, stillValid: () => true });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('holds for an engine with no registered adapter at all (e.g. gemini, not yet shipped) rather than silently skipping', async () => {
    const { tmux } = fakeTmux(['Model: anything']);
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-4', 9004, 1, 'gemini', 'some-model', { tmux, stillValid: () => true });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    assert.equal(result.reason, 'no control adapter is registered for engine "gemini"');
  });

  it('PRR-A finding 1, round 2: codex is a registered OBSERVATION-only adapter — verifies a match, holds (never corrects) a mismatch', async () => {
    const matching = await sessions._verifyModelAfterLaunch('tmux-verify-codex-1', 9010, 1, 'codex', 'gpt-5.6-sol',
      { tmux: fakeTmux(['Model: gpt-5.6-sol']).tmux, stillValid: () => true });
    assert.equal(matching.ok, true);
    assert.equal(matching.state, 'verified');

    const { tmux, sent } = fakeTmux(['Model: gpt-6-luna']);
    const mismatched = await sessions._verifyModelAfterLaunch('tmux-verify-codex-2', 9011, 1, 'codex', 'gpt-5.6-sol', { tmux, stillValid: () => true });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.state, 'hold');
    assert.equal(sent.length, 0, 'the codex adapter claims no controls — it never sends anything, even on a mismatch');
  });

  it('never throws out of the launch path, even if the adapter itself throws', async () => {
    const tmux = { sendKeys() {}, capturePane() { throw new Error('tmux is unavailable'); } };
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-5', 9005, 1, 'claude', 'claude-opus-5-5', { tmux, stillValid: () => true });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  describe('the real default stillValid check (PRR-A finding 4, round 2 on PR #2757)', () => {
    let realGetActive;
    beforeEach(() => { realGetActive = store.sessions.getActive; });
    afterEach(() => { store.sessions.getActive = realGetActive; });

    it('holds without sending anything when the active session for the project is no longer the one this call was scheduled for', async () => {
      // A relaunch landed under session id 9007 while this call (scheduled
      // for 9006) was still pending.
      store.sessions.getActive = () => ({ id: 9007 });
      const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-6', 9006, 1, 'claude', 'claude-opus-5-5', { tmux });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
      assert.equal(sent.length, 0, 'the superseded session must not be acted on at all');
    });

    it('proceeds normally when the active session really is the one this call was scheduled for', async () => {
      store.sessions.getActive = () => ({ id: 9008 });
      const { tmux } = fakeTmux(['Model: claude-opus-5-5']);
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-7', 9008, 1, 'claude', 'claude-opus-5-5', { tmux });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'verified');
    });

    it('holds when there is no active session at all for the project (it ended, with no replacement)', async () => {
      store.sessions.getActive = () => null;
      const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-8', 9009, 1, 'claude', 'claude-opus-5-5', { tmux });
      assert.equal(result.ok, false);
      assert.equal(sent.length, 0);
    });
  });
});

/*
 * PRR-A finding 1, round 2 on PR #2757 (#2188): the model-admission block
 * actually wired into the startup admission gate (#1633,
 * `startupReadiness`/`activeStartupReadiness`) and into `injectCommand` —
 * per PM's scope ruling, both already live in lib/sessions.js, no new files
 * needed. `_modelAdmissionBlock` is the single predicate both read.
 */
describe('model admission (lib/sessions.js, PRR-A finding 1 round 2)', () => {
  const sessions = require('../lib/sessions');
  const store = require('../lib/store');

  beforeEach(() => {
    reconciler._resetForTests();
  });

  /** A minimal launch-sequence fixture `startupReadiness` can read without touching the DB. */
  function fakeSequence(sessionId, overrides = {}) {
    return {
      id: 1, sessionId, revision: 1, applicability: 'not-applicable',
      cursor: 0, unreadyAt: null, readyAt: '2026-01-01T00:00:00Z',
      recovery: 'none', preflight: null, recoveryClearedAt: null,
      ...overrides
    };
  }

  describe('_modelAdmissionBlock', () => {
    it('is null when no model was ever requested for this session', () => {
      // A REAL (empty) store, not an uninitialized one: round 3 makes a
      // genuine query FAILURE fail closed, which this must not be — an
      // uninitialized store throws for a different reason than "no rows",
      // and conflating the two would make this test pass for the wrong one.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        assert.equal(sessions._modelAdmissionBlock(90001), null);
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('is null once the in-memory reconciler state is "verified"', async () => {
      reconciler.setDesiredProfile('session:90002', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90002', 's', { tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: claude-opus-5-5'] }; } } });
      assert.equal(sessions._modelAdmissionBlock(90002), null);
    });

    it('is "model-unverified" once the in-memory reconciler state is "held"', async () => {
      reconciler.setDesiredProfile('session:90003', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90003', 's', { tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: wrong-model'] }; } } });
      assert.equal(sessions._modelAdmissionBlock(90003), 'model-unverified');
    });

    it('falls back to the durable activity_log after an in-memory reset — "verified" survives it', async () => {
      // Real store, so activity.log actually persists rather than no-opping.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        const project = store.projects.create({ name: 'admission-durable', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'admission-durable' });
        store.activity.log({
          projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-requested',
          detail: { engine: 'claude', model: 'claude-opus-5-5', confirmedSelectableAtLaunch: true }
        });
        store.activity.log({
          projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-verified',
          detail: { engine: 'claude', model: 'claude-opus-5-5', ok: true, state: 'verified' }
        });
        // Simulates a process restart: the in-memory reconciler map is gone,
        // but the durable rows just written above are not (PM's ruling calls
        // this `profileReconciler.reset(...)`; no such per-resource reset
        // exists on this module, so `_resetForTests()` — clearing ALL
        // in-memory state — is the faithful stand-in for "the process
        // restarted," which is the actual scenario being proven).
        reconciler._resetForTests();
        assert.equal(sessions._modelAdmissionBlock(session.id), null);
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to the durable activity_log after an in-memory reset — "pending" survives it when no verification row exists yet', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        const project = store.projects.create({ name: 'admission-durable-pending', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'admission-durable-pending' });
        store.activity.log({
          projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-requested',
          detail: { engine: 'claude', model: 'claude-opus-5-5', confirmedSelectableAtLaunch: true }
        });
        reconciler._resetForTests();
        assert.equal(sessions._modelAdmissionBlock(session.id), 'model-verification-pending');
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to the durable activity_log — "held" survives it when the latest verification row says ok: false', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        const project = store.projects.create({ name: 'admission-durable-held', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'admission-durable-held' });
        store.activity.log({
          projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-verified',
          detail: { engine: 'claude', model: 'claude-opus-5-5', ok: false, state: 'hold' }
        });
        reconciler._resetForTests();
        assert.equal(sessions._modelAdmissionBlock(session.id), 'model-unverified');
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('PRR-A finding 1, round 3: a model requested in memory is "model-verification-pending" even if the durable query throws — the in-memory check runs first and never reaches it', () => {
      const realQuery = store.activity.query;
      store.activity.query = () => { throw new Error('store is unavailable'); };
      try {
        reconciler.setDesiredProfile('session:999999', { engine: 'codex', model: 'gpt-5.6-sol' });
        assert.equal(sessions._modelAdmissionBlock(999999), 'model-verification-pending');
      } finally {
        store.activity.query = realQuery;
      }
    });

    it('PRR-A finding 1, round 3: startupReadiness and injectCommand both hold on that same in-memory-pending-despite-a-throwing-store case', async () => {
      const realQuery = store.activity.query;
      const realHasSession = tmux.hasSession;
      const realSendKeys = tmux.sendKeys;
      store.activity.query = () => { throw new Error('store is unavailable'); };
      tmux.hasSession = () => true;
      tmux.sendKeys = () => {};
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      try {
        store._setBasePath(path.join(tmpDir, 'tangleclaw'));
        store.init();
        const project = store.projects.create({ name: 'admission-throwing-query', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'admission-throwing-query' });
        reconciler.setDesiredProfile(`session:${session.id}`, { engine: 'claude', model: 'claude-opus-5-5' });

        const readiness = sessions.startupReadiness({
          id: 1, sessionId: session.id, revision: 1, applicability: 'not-applicable',
          cursor: 0, unreadyAt: null, readyAt: '2026-01-01T00:00:00Z', recovery: 'none', preflight: null, recoveryClearedAt: null
        });
        assert.equal(readiness.state, 'starting');
        assert.equal(readiness.blocker, 'model-verification-pending');

        const injected = sessions.injectCommand('admission-throwing-query', 'hello');
        assert.equal(injected.ok, false);
        assert.equal(injected.code, 'MODEL_ADMISSION_HELD');
      } finally {
        store.activity.query = realQuery;
        tmux.hasSession = realHasSession;
        tmux.sendKeys = realSendKeys;
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('PRR-A finding 1, round 3: after an in-memory reset, a throwing durable query fails CLOSED ("model-unverified"), never null', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      const realQuery = store.activity.query;
      try {
        const project = store.projects.create({ name: 'admission-reset-throwing', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'admission-reset-throwing' });
        reconciler.setDesiredProfile(`session:${session.id}`, { engine: 'claude', model: 'claude-opus-5-5' });
        // The process "restarted": in-memory state is gone, so the early
        // check this finding just added can no longer short-circuit, and
        // the durable fallback is reached and made to fail.
        reconciler._resetForTests();
        store.activity.query = () => { throw new Error('store is unavailable'); };
        assert.equal(sessions._modelAdmissionBlock(session.id), 'model-unverified');
      } finally {
        store.activity.query = realQuery;
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('startupReadiness / activeStartupReadiness', () => {
    it('reports needs-attention with blocker "model-unverified" when the model reconciliation held', async () => {
      reconciler.setDesiredProfile('session:90010', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90010', 's', { tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: wrong-model'] }; } } });
      const readiness = sessions.startupReadiness(fakeSequence(90010));
      assert.equal(readiness.state, 'needs-attention');
      assert.equal(readiness.blocker, 'model-unverified');
    });

    it('reports starting with blocker "model-verification-pending" before verification completes', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        const project = store.projects.create({ name: 'readiness-pending', path: tmpDir, engine: 'claude' });
        const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'readiness-pending' });
        store.activity.log({
          projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-requested',
          detail: { engine: 'claude', model: 'claude-opus-5-5', confirmedSelectableAtLaunch: true }
        });
        // No reconcile() has run yet — the 6-second deferred check has not fired.
        const readiness = sessions.startupReadiness(fakeSequence(session.id));
        assert.equal(readiness.state, 'starting');
        assert.equal(readiness.blocker, 'model-verification-pending');
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('with nothing requested at all, there is no model block — confirms "pending" never spuriously holds an untouched session', () => {
      // A real (empty) store — round 3 makes a genuine query failure fail
      // closed, which an uninitialized store would now trigger for the
      // wrong reason (see the `_modelAdmissionBlock` describe's first test).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
      try {
        const readiness = sessions.startupReadiness(fakeSequence(90011));
        assert.notEqual(readiness.blocker, 'model-verification-pending');
        assert.notEqual(readiness.blocker, 'model-unverified');
      } finally {
        store.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('a model block overrides what the sequence itself would otherwise report', async () => {
      reconciler.setDesiredProfile('session:90012', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90012', 's', { tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: wrong-model'] }; } } });
      // This sequence's OWN fields say ready (readyAt set, not-applicable) —
      // the model block must still win.
      const readiness = sessions.startupReadiness(fakeSequence(90012, { readyAt: '2026-01-01T00:00:00Z' }));
      assert.equal(readiness.state, 'needs-attention');
      assert.equal(readiness.blocker, 'model-unverified');
    });

    it('allows the sequence through once the model reconciliation verifies', async () => {
      reconciler.setDesiredProfile('session:90013', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90013', 's', { tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: claude-opus-5-5'] }; } } });
      const readiness = sessions.startupReadiness(fakeSequence(90013));
      assert.equal(readiness.state, 'ready');
      assert.equal(readiness.blocker, null);
    });
  });

  describe('injectCommand', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-admission-inject-'));
      store._setBasePath(path.join(tmpDir, 'tangleclaw'));
      store.init();
    });
    after(() => {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    let realHasSession;
    let realSendKeys;
    beforeEach(() => {
      realHasSession = tmux.hasSession;
      realSendKeys = tmux.sendKeys;
      tmux.hasSession = () => true;
      tmux.sendKeys = () => {};
    });
    afterEach(() => {
      tmux.hasSession = realHasSession;
      tmux.sendKeys = realSendKeys;
    });

    it('refuses with MODEL_ADMISSION_HELD while the launch-requested model is unverified, and allows it once verified', async () => {
      const project = store.projects.create({ name: 'inject-admission', path: path.join(tmpDir, 'inject-admission'), engine: 'claude' });
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'inject-admission' });
      reconciler.setDesiredProfile(`session:${session.id}`, { engine: 'claude', model: 'claude-opus-5-5' });
      // Mirrors what launchSession itself writes right after creating the
      // session row — the durable half of "a model was requested", without
      // which a 'pending' in-memory state is indistinguishable from
      // "nothing was ever requested" (both are the Map's default miss).
      store.activity.log({
        projectId: project.id, sessionId: session.id, eventType: 'session.model-launch-requested',
        detail: { engine: 'claude', model: 'claude-opus-5-5', confirmedSelectableAtLaunch: true }
      });

      const held = sessions.injectCommand('inject-admission', 'hello');
      assert.equal(held.ok, false);
      assert.equal(held.code, 'MODEL_ADMISSION_HELD');
      assert.equal(held.modelAdmission, 'model-verification-pending');

      await reconciler.reconcile(`session:${session.id}`, 'inject-admission', {
        tmux: { sendKeys() {}, capturePane() { return { lines: ['Model: claude-opus-5-5'] }; } }
      });
      const allowed = sessions.injectCommand('inject-admission', 'hello');
      assert.equal(allowed.ok, true);
    });

    it('launchSend: true bypasses the admission hold — the launch kickoff cannot wait behind the gate that makes it ready', async () => {
      const project = store.projects.create({ name: 'inject-admission-launchsend', path: path.join(tmpDir, 'inject-admission-launchsend'), engine: 'claude' });
      const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'inject-admission-launchsend' });
      reconciler.setDesiredProfile(`session:${session.id}`, { engine: 'claude', model: 'claude-opus-5-5' });
      const result = sessions.injectCommand('inject-admission-launchsend', 'hello', { launchSend: true });
      assert.equal(result.ok, true);
    });
  });
});
