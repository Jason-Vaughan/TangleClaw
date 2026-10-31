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

const { describe, it, beforeEach } = require('node:test');
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
    reconciler.recordCheckpoint('r1', { safeToClear: false, note: 'mid-write' });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(sent.some((s) => s.text === '/clear'), false);
  });

  it('issues /clear only once a safe-to-clear checkpoint is recorded', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.ok(sent.some((s) => s.text === '/clear'));
  });
});

describe('reconcile: explicit model argument, never a guessed menu', () => {
  it('sends /model with the exact desired id as a literal argument', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    const { tmux, sent } = fakeTmux(['Model: claude-opus-4-8']);
    await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.ok(sent.some((s) => s.text === '/model claude-opus-5-5'));
    // Never an arrow key or any other guessed-navigation keystroke.
    assert.ok(sent.every((s) => !/^(Up|Down|Left|Right|Tab)$/.test(s.text)));
  });

  it('verifies and stops once the second observation matches after applying the controls', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
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
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'verified');
  });
});

describe('reconcile: fail closed on an unverified or mismatched result', () => {
  it('holds when the post-reconciliation observation still does not match', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    // Every capture, before and after, shows the wrong model — the attempted
    // controls did not take effect.
    const { tmux } = fakeTmux(['Model: claude-opus-4-8']);
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.equal(audit[audit.length - 1].transition, 'refused');
    assert.equal(audit[audit.length - 1].detail.reason, 'STILL_MISMATCHED');
  });

  it('holds, not verifies, when the pane cannot be read at all (spoof/failure: no false positive on silence)', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    const tmux = {
      sendKeys() {},
      capturePane() { throw new Error('tmux session "session-r1" does not exist'); }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
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
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    const tmux = {
      sendKeys(session, text) {
        if (text.startsWith('/model')) throw new Error('pane is not accepting input');
      },
      capturePane() { return { lines: ['Model: claude-opus-4-8'] }; }
    };
    const result = await reconciler.reconcile('r1', 'session-r1', { tmux });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'hold');
    const audit = reconciler.getAudit('r1');
    assert.ok(audit.some((e) => e.control === 'explicitModel' && e.transition === 'refused' && e.detail.reason === 'ADAPTER_ERROR'));
  });
});

describe('audit log', () => {
  it('records requested/applied/verified transitions in order for a full reconciliation', async () => {
    reconciler.setDesiredProfile('r1', { engine: 'claude', model: 'claude-opus-5-5' });
    reconciler.recordCheckpoint('r1', { safeToClear: true });
    let call = 0;
    const tmux = {
      sendKeys() {},
      capturePane() {
        call += 1;
        return { lines: [call === 1 ? 'Model: claude-opus-4-8' : 'Model: claude-opus-5-5'] };
      }
    };
    await reconciler.reconcile('r1', 'session-r1', { tmux });
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

describe('getCheckpoint', () => {
  it('returns null when nothing was ever recorded for a resource', () => {
    assert.equal(reconciler.getCheckpoint('never-checkpointed'), null);
  });

  it('returns the most recently recorded checkpoint', () => {
    reconciler.recordCheckpoint('r1', { safeToClear: true, note: 'first' }, { now: () => 1 });
    reconciler.recordCheckpoint('r1', { safeToClear: false, note: 'second' }, { now: () => 2 });
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
