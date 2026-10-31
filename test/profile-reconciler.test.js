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
 *
 * PRR-A round 5 on PR #2757 retired `tmux.capturePane` text as an observation
 * source entirely — no regex/window/separator parser over raw pane text can
 * ever be trustworthy, because the pane is not an authenticated channel.
 * Observation now reads each engine's own out-of-band structured session
 * record (`_readCodexActiveModel` / `_readClaudeActiveModel`); `tmux` is used
 * in these tests only to record CONTROL sends (`/clear`, `/model <id>`), and
 * `readTrustedActiveProfile` is the fake observation seam.
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

/** A fake tmux seam for CONTROL sends only — `sendKeys` records every call. Observation no longer goes through tmux at all (round 5). */
function fakeTmux() {
  const sent = [];
  return { sent, tmux: { sendKeys(session, text) { sent.push({ session, text }); } } };
}

/**
 * A fake `readTrustedActiveProfile` seam. Each call returns the next entry of
 * `sequence` (a bare non-array value is treated as a one-element sequence),
 * repeating the last entry once exhausted — mirroring the pre-control and
 * post-control observations `reconcile` makes. An entry is a `{engine,
 * model}` profile, or `null` for "unreadable / no matching session file".
 * @param {object|null|Array<object|null>} sequence
 * @returns {(session: string, opts: object) => Promise<object|null>}
 */
function fakeObserved(sequence) {
  const seq = Array.isArray(sequence) ? sequence : [sequence];
  let call = 0;
  return async () => {
    const v = seq[Math.min(call, seq.length - 1)];
    call += 1;
    return v;
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
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, readTrustedActiveProfile: fakeObserved(null) });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('holds a resource whose desired engine has no registered adapter', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'nonexistent-engine', model: 'x' });
    const { tmux } = fakeTmux();
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, readTrustedActiveProfile: fakeObserved(null) });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].detail.reason, 'UNSUPPORTED_ENGINE');
  });
});

describe('reconcile: already matching', () => {
  it('verifies without sending anything when the observed profile already matches', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux, sent } = fakeTmux();
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
    });
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
    // Observed profile is a mismatch — a clear would normally be tried
    // first, but nothing records it as safe here.
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    const clearSent = sent.some((s) => s.text === '/clear');
    assert.equal(clearSent, false, '/clear must never be sent without a recorded safe-to-clear checkpoint');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'NO_SAFE_TO_CLEAR_CHECKPOINT'));
  });

  it('refuses /clear when the checkpoint on record is not safeToClear: true', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: false, generation: 'g1', note: 'mid-write' });
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent.some((s) => s.text === '/clear'), false);
  });

  it('issues /clear only once a safe-to-clear checkpoint is recorded', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
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
    const { tmux, sent } = fakeTmux();
    // Default max age is 5 minutes; this reconcile runs 10 minutes later.
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', now: () => 1000 + 10 * 60 * 1000,
      readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a stale checkpoint must not authorize /clear');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_STALE'));
  });

  it('honors a caller-supplied checkpointMaxAgeMs instead of the 5-minute default', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' }, { now: () => 1000 });
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', now: () => 1000 + 30 * 1000, checkpointMaxAgeMs: 10 * 1000,
      readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent.some((s) => s.text === '/clear'), false);
  });

  it('PRR-A finding 3: refuses a checkpoint recorded for a different generation of the resource', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'session-before-relaunch' });
    const { tmux, sent } = fakeTmux();
    // The resource relaunched under a new generation since the checkpoint was recorded.
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'session-after-relaunch',
      readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a checkpoint for a stale generation must not authorize /clear on the current one');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_GENERATION_MISMATCH'));
  });

  it('PRR-A finding 3, round 2: refuses /clear when the caller omits currentGeneration entirely — no opt-out', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux();
    // Deliberately no currentGeneration at all — this used to skip the
    // generation check entirely and authorize /clear on the checkpoint's
    // bare presence.
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent.some((s) => s.text === '/clear'), false, 'a missing currentGeneration must refuse /clear, not skip the check');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.transition === 'refused' && e.control === 'clear' && e.detail.reason === 'CHECKPOINT_GENERATION_MISMATCH'));
  });

  it('a checkpoint matching the current generation is still honored', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'session-r1-gen1' });
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'session-r1-gen1',
      readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.ok(sent.some((s) => s.text === '/clear'));
  });

  it('PRR-A finding 3: a checkpoint already consumed by a successful /clear cannot authorize a second one', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux: tmux1 } = fakeTmux();
    const first = await reconciler.reconcile('r1', 'session-r1', {
      tmux: tmux1, currentGeneration: 'g1', readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(first.ok, false, 'the fake observation never actually moves, so reconciliation still ends in hold');
    assert.equal(reconciler.getCheckpoint('r1'), null, 'the checkpoint is consumed once /clear is actually sent, whether or not the rest of reconciliation later verifies');

    // A second reconcile, still mismatched, with no new checkpoint recorded.
    const { tmux: tmux2, sent: sent2 } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux: tmux2, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(sent2.some((s) => s.text === '/clear'), false, 'the consumed checkpoint must not authorize a second /clear');
  });
});

describe('reconcile: deps.stillValid aborts a superseded resource (PRR-A finding 4, round 2 on PR #2757)', () => {
  it('aborts before the first observation when the resource is already superseded', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    let observeCalls = 0;
    const { tmux } = fakeTmux();
    const readTrustedActiveProfile = async () => { observeCalls += 1; return { engine: 'claude', model: 'claude-opus-4-8' }; };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, readTrustedActiveProfile, stillValid: () => false });
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
    const { tmux, sent } = fakeTmux();
    // The session ends (a relaunch under a new generation) the instant the
    // first observation returns — simulating the window finding 4 names: a
    // rapid end + relaunch landing between this call starting and it
    // reaching its first control.
    const readTrustedActiveProfile = async () => { stillHere = false; return { engine: 'claude', model: 'claude-opus-4-8' }; };
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile, currentGeneration: 'g1', stillValid: () => stillHere
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    assert.equal(sent.length, 0, 'no control may be sent once the resource is no longer the one asked for');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].detail.reason, 'RESOURCE_SUPERSEDED');
  });

  it('with no stillValid supplied, every check passes — opt-in, not a new default requirement', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    const { tmux } = fakeTmux();
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
    });
    assert.equal(result.ok, true);
  });
});

describe('reconcile: explicit model argument, never a guessed menu', () => {
  it('sends /model with the exact desired id as a literal argument', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux, sent } = fakeTmux();
    await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.ok(sent.some((s) => s.text === '/model claude-opus-5-5'));
    // Never an arrow key or any other guessed-navigation keystroke.
    assert.ok(sent.every((s) => !/^(Up|Down|Left|Right|Tab)$/.test(s.text)));
  });

  it('verifies and stops once the second observation matches after applying the controls', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux } = fakeTmux();
    // First observation (pre-dispatch) shows the stale model; the second
    // (post-reconciliation) shows the desired one landed.
    const readTrustedActiveProfile = fakeObserved([
      { engine: 'claude', model: 'claude-opus-4-8' },
      { engine: 'claude', model: 'claude-opus-5-5' }
    ]);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1', readTrustedActiveProfile });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
  });
});

describe('reconcile: fail closed on an unverified or mismatched result', () => {
  it('holds when the post-reconciliation observation still does not match', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux } = fakeTmux();
    // Every observation, before and after, shows the wrong model — the
    // attempted controls did not take effect.
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].transition, 'refused');
    assert.equal(audit[audit.length - 1].detail.reason, 'STILL_MISMATCHED');
  });

  it('holds, not verifies, when the trusted source cannot be read at all (spoof/failure: no false positive on silence)', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const { tmux } = fakeTmux();
    const readTrustedActiveProfile = async () => { throw new Error('session file is unavailable'); };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1', readTrustedActiveProfile });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('PRR-A round 5: raw pane text alone — even with a separator and an exact "Model: <id>" line — must never verify a profile', async () => {
    // The exact point of round 5: _defaultParseActiveModel always returns
    // null now, and observeActiveProfile reads a trusted session file, not
    // the pane — so even a pane that would have passed every rule the last
    // four rounds added can never, by itself, verify or hold anything.
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'desired-model' });
    const { tmux, sent } = fakeTmux();
    // No readTrustedActiveProfile supplied at all: production falls through
    // to the real _readClaudeActiveModel, which (with no projectPath override
    // pointed at a fixture) finds nothing and returns null.
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, claudeHome: path.join(os.tmpdir(), 'tc-nonexistent-claude-home') });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    // An unknown observation still attempts the explicit /model correction —
    // that control is not itself dangerous, unlike /clear's checkpoint gate
    // — but it can never be confirmed by anything the pane says afterward,
    // which `result.state === 'hold'` above already proves.
    assert.ok(sent.some((s) => s.text === '/model desired-model'));
  });

  it('holds when an adapter throws while applying a control, rather than assuming it landed', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true, generation: 'g1' });
    const tmux = {
      sendKeys(session, text) {
        if (text.startsWith('/model')) throw new Error('pane is not accepting input');
      }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', {
      tmux, currentGeneration: 'g1', readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
    });
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
    const { tmux } = fakeTmux();
    const readTrustedActiveProfile = fakeObserved([
      { engine: 'claude', model: 'claude-opus-4-8' },
      { engine: 'claude', model: 'claude-opus-5-5' }
    ]);
    await reconciler.reconcile('r1', 'session-r1', { tmux, currentGeneration: 'g1', readTrustedActiveProfile });
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
    await reconciler.reconcile('r1', 's1', { tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'm1' }) });
    await reconciler.reconcile('r2', 's2', { tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'other' }) });
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

  it('observes through the shared trusted-source path, tagged with its own engine id', async () => {
    const observed = await reconciler.CODEX_ADAPTER.observeActiveProfile('s', {
      readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-5.6-sol' })
    });
    assert.deepEqual(observed, { engine: 'codex', model: 'gpt-5.6-sol' });
  });
});

describe('getAdmissionState (PRR-A finding 1, round 2 on PR #2757)', () => {
  it('is "pending" before any reconciliation has run for a resource', () => {
    assert.equal(reconciler.getAdmissionState('never-reconciled'), 'pending');
  });

  it('becomes "verified" after a reconciliation that converges', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    await reconciler.reconcile('r1', 'session-r1', {
      tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
    });
    assert.equal(reconciler.getAdmissionState('r1'), 'verified');
  });

  it('becomes "held" after a reconciliation that does not converge, and stays held — never silently reset', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    await reconciler.reconcile('r1', 'session-r1', {
      tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'wrong-model' })
    });
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
    await reconciler.reconcile('r1', 's1', { tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'm1' }) });
    await reconciler.reconcile('r2', 's2', { tmux: fakeTmux().tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'not-m2' }) });
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

describe('_defaultParseActiveModel (PRR-A round 5 on PR #2757: retired — unconditionally null)', () => {
  it('returns null for literally anything, including a line that would have passed every one of the last four rounds\' rules', () => {
    assert.equal(reconciler._defaultParseActiveModel([]), null);
    assert.equal(reconciler._defaultParseActiveModel(['Model: claude-opus-5-5']), null);
    assert.equal(reconciler._defaultParseActiveModel(['───────────────────────', 'Model: claude-opus-5-5', '>']), null);
  });

  it('PRR-A round 5, exact reproduction 1: a separator + a single clean "Model: <id>" line is still null', () => {
    assert.equal(reconciler._defaultParseActiveModel(['────', 'Model: desired-model', '>']), null);
  });

  it('PRR-A round 5, exact reproduction 2: a separator-bounded single match with stale transcript before it is still null', () => {
    assert.equal(
      reconciler._defaultParseActiveModel([
        'Model: actual-wrong', 'transcript 1', 'transcript 2', 'transcript 3', 'transcript 4',
        '────', 'Model: desired-model', '>'
      ]),
      null
    );
  });
});

describe('reconcile with only raw pane-text observation stays held (PRR-A round 5)', () => {
  it('a pane with a separator and an exact "Model: <id>" line, read through the OLD mechanism only, never verifies', async () => {
    // Simulates a caller that still only has pane text to offer: passing
    // `parseActiveProfile`/`tmux.capturePane` alone (the retired path) with
    // no `readTrustedActiveProfile` must not verify anything, because
    // nothing in production ever falls back to parsing the pane again.
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'desired-model' });
    const tmux = {
      sendKeys() {},
      capturePane() { return { lines: ['────', 'Model: desired-model', '>'] }; }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux, claudeHome: path.join(os.tmpdir(), 'tc-nonexistent-claude-home') });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
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
 * PRR-A round 5 on PR #2757: the engine-owned structured session-file
 * readers, wired into production as the ONLY observation source. Each
 * engine writes its own session record out-of-band from the pane; these
 * tests use real temporary `codexHome`/`claudeHome` directories with real
 * files, exercising the readers exactly as `_observeViaTrustedSource` calls
 * them in production.
 */
describe('_readCodexActiveModel', () => {
  let tmpHome;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-home-'));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Write a rollout file under `tmpHome/sessions/<subpath>` with the given records. */
  function writeRollout(subpath, records) {
    const full = path.join(tmpHome, 'sessions', subpath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return full;
  }

  it('returns null when the sessions directory does not exist at all', () => {
    assert.equal(reconciler._readCodexActiveModel({ codexHome: tmpHome }), null);
  });

  it('reads the model from a turn_context record in a real rollout file', () => {
    writeRollout('2026/10/31/rollout-test.jsonl', [
      { type: 'session_meta', payload: { id: 's1', cwd: '/Users/jasonvaughan/Documents/Projects/TC-Lane-A' } },
      { type: 'turn_context', payload: { cwd: '/Users/jasonvaughan/Documents/Projects/TC-Lane-A', model: 'gpt-5.6-sol' } }
    ]);
    const result = reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/Users/jasonvaughan/Documents/Projects/TC-Lane-A' });
    assert.deepEqual(result, { engine: 'codex', model: 'gpt-5.6-sol' });
  });

  it('prefers the LATEST turn_context model when several appear in the same file', () => {
    writeRollout('2026/10/31/rollout-test.jsonl', [
      { type: 'session_meta', payload: { id: 's1', cwd: '/project' } },
      { type: 'turn_context', payload: { cwd: '/project', model: 'gpt-5.6-sol' } },
      { type: 'turn_context', payload: { cwd: '/project', model: 'gpt-6-luna' } }
    ]);
    assert.deepEqual(reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/project' }),
      { engine: 'codex', model: 'gpt-6-luna' });
  });

  it('returns null when no rollout file matches deps.projectPath', () => {
    writeRollout('2026/10/31/rollout-test.jsonl', [
      { type: 'session_meta', payload: { id: 's1', cwd: '/some/other/project' } },
      { type: 'turn_context', payload: { cwd: '/some/other/project', model: 'gpt-5.6-sol' } }
    ]);
    assert.equal(reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/project' }), null);
  });

  it('skips a file whose mtime is older than startedAtMs - 5000', () => {
    const file = writeRollout('2026/10/31/rollout-stale.jsonl', [
      { type: 'session_meta', payload: { id: 's1', cwd: '/project' } },
      { type: 'turn_context', payload: { cwd: '/project', model: 'gpt-5.6-sol' } }
    ]);
    const old = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(file, old / 1000, old / 1000);
    assert.equal(reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/project', startedAtMs: Date.now() }), null);
  });

  it('accepts a file within the 5-second startedAtMs slack', () => {
    const file = writeRollout('2026/10/31/rollout-fresh.jsonl', [
      { type: 'session_meta', payload: { id: 's1', cwd: '/project' } },
      { type: 'turn_context', payload: { cwd: '/project', model: 'gpt-5.6-sol' } }
    ]);
    const now = Date.now();
    fs.utimesSync(file, now / 1000, now / 1000);
    const result = reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/project', startedAtMs: now + 2000 });
    assert.deepEqual(result, { engine: 'codex', model: 'gpt-5.6-sol' });
  });

  it('skips a malformed line rather than failing the whole read', () => {
    const full = path.join(tmpHome, 'sessions', '2026/10/31/rollout-malformed.jsonl');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full,
      '{"type":"session_meta","payload":{"id":"s1","cwd":"/project"}}\n'
      + 'not even json\n'
      + '{"type":"turn_context","payload":{"cwd":"/project","model":"gpt-5.6-sol"}}\n');
    assert.deepEqual(reconciler._readCodexActiveModel({ codexHome: tmpHome, projectPath: '/project' }), { engine: 'codex', model: 'gpt-5.6-sol' });
  });
});

describe('_readClaudeActiveModel', () => {
  let tmpHome;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-claude-home-'));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeTranscript(subpath, records) {
    const full = path.join(tmpHome, 'projects', subpath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return full;
  }

  it('returns null when the projects directory does not exist at all', () => {
    assert.equal(reconciler._readClaudeActiveModel({ claudeHome: tmpHome }), null);
  });

  it('reads the model from an assistant row in a real transcript file', () => {
    writeTranscript('-project/session.jsonl', [
      { type: 'user', cwd: '/project' },
      { type: 'assistant', cwd: '/project', message: { model: 'claude-sonnet-5' } }
    ]);
    assert.deepEqual(reconciler._readClaudeActiveModel({ claudeHome: tmpHome, projectPath: '/project' }),
      { engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('prefers the LATEST assistant row when several appear in the same file', () => {
    writeTranscript('-project/session.jsonl', [
      { type: 'assistant', cwd: '/project', message: { model: 'claude-opus-4-8' } },
      { type: 'assistant', cwd: '/project', message: { model: 'claude-sonnet-5' } }
    ]);
    assert.deepEqual(reconciler._readClaudeActiveModel({ claudeHome: tmpHome, projectPath: '/project' }),
      { engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('returns null when no transcript row matches deps.projectPath', () => {
    writeTranscript('-other/session.jsonl', [
      { type: 'assistant', cwd: '/some/other/project', message: { model: 'claude-sonnet-5' } }
    ]);
    assert.equal(reconciler._readClaudeActiveModel({ claudeHome: tmpHome, projectPath: '/project' }), null);
  });

  it('skips a file whose mtime is older than startedAtMs - 5000', () => {
    const file = writeTranscript('-project/session.jsonl', [
      { type: 'assistant', cwd: '/project', message: { model: 'claude-sonnet-5' } }
    ]);
    const old = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(file, old / 1000, old / 1000);
    assert.equal(reconciler._readClaudeActiveModel({ claudeHome: tmpHome, projectPath: '/project', startedAtMs: Date.now() }), null);
  });
});

describe('_observeViaTrustedSource', () => {
  it('uses deps.readTrustedActiveProfile when a test supplies it, never the structured reader', async () => {
    // A projectPath that would never match any real file still returns
    // exactly what the seam says — proof the seam, not a real file lookup,
    // is what answered.
    const result = await reconciler._observeViaTrustedSource('claude', 's', {
      projectPath: '/this/path/matches/nothing/real',
      readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'from-the-seam' })
    });
    assert.deepEqual(result, { engine: 'claude', model: 'from-the-seam' });
  });

  it('returns null for an engine with neither a seam nor a structured reader', async () => {
    const result = await reconciler._observeViaTrustedSource('gemini', 's', {});
    assert.equal(result, null);
  });

  it('routes codex to the real _readCodexActiveModel when no seam is supplied', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-home-'));
    try {
      const result = await reconciler._observeViaTrustedSource('codex', 's', { codexHome: tmpHome });
      assert.equal(result, null, 'an empty codexHome genuinely has nothing to read');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

/*
 * PRR-A finding 2 on PR #2757 (#1967): "wire profile-reconciler into
 * production ... and add an integration test proving production wiring
 * converges a session." `lib/sessions.js`'s `_verifyModelAfterLaunch` is that
 * one production call site — the exact function `launchSession` schedules
 * after every launch that selected a model — and these call it directly,
 * through the real (not re-implemented) `setDesiredProfile` +
 * `reconcile` + `CLAUDE_ADAPTER` path, faking only the trusted-source read
 * (round 5) a unit test cannot have a real session file for.
 */
describe('sessions._verifyModelAfterLaunch — production wiring converges a session (#1967/#2188 PRR-A finding 2)', () => {
  const sessions = require('../lib/sessions');
  const store = require('../lib/store');

  beforeEach(() => {
    reconciler._resetForTests();
  });

  it('converges immediately when the trusted source already shows the requested model — nothing is sent', async () => {
    const { tmux, sent } = fakeTmux();
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-1', 9001, 1, 'claude', 'claude-opus-5-5', {
      tmux, stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
    assert.equal(sent.length, 0);
  });

  it('converges a mismatch by sending the real explicit /model control and re-observing', async () => {
    const sent = [];
    const tmux = { sendKeys(session, text) { sent.push(text); } };
    const readTrustedActiveProfile = fakeObserved([
      { engine: 'claude', model: 'claude-opus-4-8' },
      { engine: 'claude', model: 'claude-opus-5-5' }
    ]);
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-2', 9002, 1, 'claude', 'claude-opus-5-5', {
      tmux, stillValid: () => true, readTrustedActiveProfile
    });
    assert.ok(sent.includes('/model claude-opus-5-5'));
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
    // The real audit trail this production call site leaves behind, keyed by
    // the exact resourceId `_verifyModelAfterLaunch` uses.
    const audit = reconciler.getAudit('session:9002');
    assert.ok(audit.some((e) => e.transition === 'requested' && e.control === 'explicitModel'));
    assert.ok(audit.some((e) => e.transition === 'verified'));
  });

  it('holds, honestly, rather than falsely verifying, when the trusted source never converges', async () => {
    const { tmux } = fakeTmux();
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-3', 9003, 1, 'claude', 'claude-opus-5-5', {
      tmux, stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'some-other-model' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
  });

  it('holds for an engine with no registered adapter at all (e.g. gemini, not yet shipped) rather than silently skipping', async () => {
    const { tmux } = fakeTmux();
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-4', 9004, 1, 'gemini', 'some-model', {
      tmux, stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'gemini', model: 'anything' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    assert.equal(result.reason, 'no control adapter is registered for engine "gemini"');
  });

  it('PRR-A finding 1, round 2: codex is a registered OBSERVATION-only adapter — verifies a match, holds (never corrects) a mismatch', async () => {
    const matching = await sessions._verifyModelAfterLaunch('tmux-verify-codex-1', 9010, 1, 'codex', 'gpt-5.6-sol', {
      tmux: fakeTmux().tmux, stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-5.6-sol' })
    });
    assert.equal(matching.ok, true);
    assert.equal(matching.state, 'verified');

    const { tmux, sent } = fakeTmux();
    const mismatched = await sessions._verifyModelAfterLaunch('tmux-verify-codex-2', 9011, 1, 'codex', 'gpt-5.6-sol', {
      tmux, stillValid: () => true, readTrustedActiveProfile: fakeObserved({ engine: 'codex', model: 'gpt-6-luna' })
    });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.state, 'hold');
    assert.equal(sent.length, 0, 'the codex adapter claims no controls — it never sends anything, even on a mismatch');
  });

  it('never throws out of the launch path, even if the trusted-source read itself throws', async () => {
    const { tmux } = fakeTmux();
    const readTrustedActiveProfile = async () => { throw new Error('session file is unavailable'); };
    const result = await sessions._verifyModelAfterLaunch('tmux-verify-5', 9005, 1, 'claude', 'claude-opus-5-5', {
      tmux, stillValid: () => true, readTrustedActiveProfile
    });
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
      const { tmux, sent } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-6', 9006, 1, 'claude', 'claude-opus-5-5', {
        tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
      assert.equal(sent.length, 0, 'the superseded session must not be acted on at all');
    });

    it('proceeds normally when the active session really is the one this call was scheduled for', async () => {
      store.sessions.getActive = () => ({ id: 9008 });
      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-7', 9008, 1, 'claude', 'claude-opus-5-5', {
        tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'verified');
    });

    it('holds when there is no active session at all for the project (it ended, with no replacement)', async () => {
      store.sessions.getActive = () => null;
      const { tmux, sent } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-verify-8', 9009, 1, 'claude', 'claude-opus-5-5', {
        tmux, readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-4-8' })
      });
      assert.equal(result.ok, false);
      assert.equal(sent.length, 0);
    });
  });

  describe('PRR-A round 5: production path reaches the real structured-file readers (no seam) with real temporary homes', () => {
    let tmpCodexHome;
    let tmpClaudeHome;
    beforeEach(() => {
      tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-home-'));
      tmpClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-claude-home-'));
    });
    afterEach(() => {
      fs.rmSync(tmpCodexHome, { recursive: true, force: true });
      fs.rmSync(tmpClaudeHome, { recursive: true, force: true });
    });

    it('converges to "verified" ONLY from a matching real codex rollout file, with no readTrustedActiveProfile seam at all', async () => {
      const rollout = path.join(tmpCodexHome, 'sessions', '2026', '10', '31', 'rollout-test.jsonl');
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/fixture/project' } }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: '/fixture/project', model: 'gpt-5.6-sol' } })
      ].join('\n') + '\n');

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-codex-prod', 9020, 1, 'codex', 'gpt-5.6-sol', {
        tmux, stillValid: () => true, codexHome: tmpCodexHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'verified');
    });

    it('stays "held" on a model mismatch in the real codex rollout file', async () => {
      const rollout = path.join(tmpCodexHome, 'sessions', '2026', '10', '31', 'rollout-test.jsonl');
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/fixture/project' } }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: '/fixture/project', model: 'gpt-6-luna' } })
      ].join('\n') + '\n');

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-codex-prod-2', 9021, 1, 'codex', 'gpt-5.6-sol', {
        tmux, stillValid: () => true, codexHome: tmpCodexHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
    });

    it('stays "held" when the rollout file\'s cwd does not match the project path', async () => {
      const rollout = path.join(tmpCodexHome, 'sessions', '2026', '10', '31', 'rollout-test.jsonl');
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/some/other/project' } }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: '/some/other/project', model: 'gpt-5.6-sol' } })
      ].join('\n') + '\n');

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-codex-prod-3', 9022, 1, 'codex', 'gpt-5.6-sol', {
        tmux, stillValid: () => true, codexHome: tmpCodexHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
    });

    it('stays "held" when the rollout file is stale relative to startedAtMs', async () => {
      const rollout = path.join(tmpCodexHome, 'sessions', '2026', '10', '31', 'rollout-test.jsonl');
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.writeFileSync(rollout, [
        JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/fixture/project' } }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: '/fixture/project', model: 'gpt-5.6-sol' } })
      ].join('\n') + '\n');
      const old = Date.now() - 60 * 60 * 1000;
      fs.utimesSync(rollout, old / 1000, old / 1000);

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-codex-prod-4', 9023, 1, 'codex', 'gpt-5.6-sol', {
        tmux, stillValid: () => true, codexHome: tmpCodexHome, projectPath: '/fixture/project', startedAtMs: Date.now()
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
    });

    it('stays "held" when no rollout file exists at all', async () => {
      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-codex-prod-5', 9024, 1, 'codex', 'gpt-5.6-sol', {
        tmux, stillValid: () => true, codexHome: tmpCodexHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
    });

    it('converges to "verified" ONLY from a matching real claude transcript file, with no readTrustedActiveProfile seam at all', async () => {
      const transcript = path.join(tmpClaudeHome, 'projects', '-fixture-project', 'session.jsonl');
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, [
        JSON.stringify({ type: 'assistant', cwd: '/fixture/project', message: { model: 'claude-sonnet-5' } })
      ].join('\n') + '\n');

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-claude-prod', 9025, 1, 'claude', 'claude-sonnet-5', {
        tmux, stillValid: () => true, claudeHome: tmpClaudeHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'verified');
    });

    it('stays "held" on a model mismatch in the real claude transcript file', async () => {
      const transcript = path.join(tmpClaudeHome, 'projects', '-fixture-project', 'session.jsonl');
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, [
        JSON.stringify({ type: 'assistant', cwd: '/fixture/project', message: { model: 'claude-opus-4-8' } })
      ].join('\n') + '\n');

      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-claude-prod-2', 9026, 1, 'claude', 'claude-sonnet-5', {
        tmux, stillValid: () => true, claudeHome: tmpClaudeHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
    });

    it('stays "held" when no claude transcript file exists at all', async () => {
      const { tmux } = fakeTmux();
      const result = await sessions._verifyModelAfterLaunch('tmux-claude-prod-3', 9027, 1, 'claude', 'claude-sonnet-5', {
        tmux, stillValid: () => true, claudeHome: tmpClaudeHome, projectPath: '/fixture/project'
      });
      assert.equal(result.ok, false);
      assert.equal(result.state, 'hold');
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
      await reconciler.reconcile('session:90002', 's', { readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' }) });
      assert.equal(sessions._modelAdmissionBlock(90002), null);
    });

    it('is "model-unverified" once the in-memory reconciler state is "held"', async () => {
      reconciler.setDesiredProfile('session:90003', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90003', 's', { readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'wrong-model' }) });
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
      await reconciler.reconcile('session:90010', 's', { readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'wrong-model' }) });
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
      await reconciler.reconcile('session:90012', 's', { readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'wrong-model' }) });
      // This sequence's OWN fields say ready (readyAt set, not-applicable) —
      // the model block must still win.
      const readiness = sessions.startupReadiness(fakeSequence(90012, { readyAt: '2026-01-01T00:00:00Z' }));
      assert.equal(readiness.state, 'needs-attention');
      assert.equal(readiness.blocker, 'model-unverified');
    });

    it('allows the sequence through once the model reconciliation verifies', async () => {
      reconciler.setDesiredProfile('session:90013', { engine: 'claude', model: 'claude-opus-5-5' });
      await reconciler.reconcile('session:90013', 's', { readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' }) });
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
        readTrustedActiveProfile: fakeObserved({ engine: 'claude', model: 'claude-opus-5-5' })
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
