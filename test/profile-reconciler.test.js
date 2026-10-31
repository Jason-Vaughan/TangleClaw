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

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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
    const filler = (count) => Array.from({ length: count }, (_, i) => `chrome line ${i}`);

    // Exactly n lines back from the end — the OLDEST line still inside the window.
    const atEdge = ['Model: right-at-the-edge', ...filler(n - 1)];
    assert.deepEqual(reconciler._defaultParseActiveModel(atEdge), { model: 'right-at-the-edge' });

    // One line further back than n — now outside the window, and nothing
    // else inside it matches, so the result is null, not some other line.
    const pastEdge = ['Model: right-at-the-edge', 'one more line', ...filler(n - 1)];
    assert.equal(reconciler._defaultParseActiveModel(pastEdge), null);
  });
});

describe('_defaultParseActiveModel', () => {
  it('reads the model id out of a "Model: <id>" line', () => {
    assert.deepEqual(reconciler._defaultParseActiveModel(['some output', 'Model: claude-opus-5-5', 'more output']),
      { model: 'claude-opus-5-5' });
  });

  it('prefers the LAST matching line, for a pane with more than one banner frame', () => {
    assert.deepEqual(reconciler._defaultParseActiveModel(['Model: claude-opus-4-8', 'Model: claude-opus-5-5']),
      { model: 'claude-opus-5-5' });
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
