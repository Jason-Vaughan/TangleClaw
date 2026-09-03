'use strict';

/*
 * #1180 / the session chime — "is this session waiting for me?"
 *
 * The chime read `detectIdle`, an OUTPUT-STALENESS timer: the last three pane
 * lines unchanged for ten seconds. That dings through any quiet stretch,
 * including one where the engine is mid-turn, which is the reported bug.
 *
 * The correction is NOT to swap in `_assessPane`. That is one third of the
 * decision and, on its own, the gate #1114 measured and rejected: for Claude
 * the busy marker does not render on an ordinary turn and the bare prompt is
 * drawn throughout, so the marker gates alone call a MID-STREAM pane
 * `at-prompt` (asserted as a precondition in test/medusa-wake.test.js). What
 * separates working from resting is the transcript MOVING, plus a streak.
 *
 * A first attempt at this fix also passed `active.engine`, a key that does not
 * exist on a session row (`engineId` does), so the whole path was dead code no
 * test noticed. That is pinned here too.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const medusaWake = require('../lib/medusa-wake');

const CLAUDE = medusaWake.ENGINE_WAKE_PROFILES.claude;

/** A pane sitting at Claude's bare prompt, with `n` lines of prior transcript. */
function restingPane(n = 3, tag = 'a') {
  const body = Array.from({ length: n }, (_, i) => `${tag} transcript line ${i}`);
  return [...body, '', '❯ '];
}

describe('#1180 assessSessionIdle — the composed gate, not the marker gates alone', () => {
  it('PRECONDITION: the marker gates alone call a mid-stream pane idle', () => {
    // If this ever stops being true the composition below is over-built — but
    // while it IS true, using _assessPane by itself ships a false chime.
    assert.deepEqual(
      medusaWake._assessPane(restingPane(3), CLAUDE, undefined),
      { idle: true, reason: 'at-prompt' }
    );
  });

  it('a pane that MOVED is not idle, however at-rest it looks', () => {
    const first = medusaWake.assessSessionIdle({ lines: restingPane(3, 'a'), profile: CLAUDE });
    const second = medusaWake.assessSessionIdle({
      lines: restingPane(4, 'a'), profile: CLAUDE,
      prevDigest: first.digest, idleTicks: first.idleTicks
    });
    assert.equal(second.idle, false);
    assert.equal(second.reason, 'pane-writing');
    assert.equal(second.idleTicks, 0, 'movement must reset the streak, not merely fail one tick');
  });

  it('needs a STREAK — one quiet sample is not a verdict', () => {
    const lines = restingPane(3);
    const t1 = medusaWake.assessSessionIdle({ lines, profile: CLAUDE });
    assert.equal(t1.idle, false, 'the first quiet tick must not fire');
    const t2 = medusaWake.assessSessionIdle({
      lines, profile: CLAUDE, prevDigest: t1.digest, idleTicks: t1.idleTicks
    });
    assert.equal(t2.idle, true);
  });

  it('a busy marker beats everything, even a still pane', () => {
    const lines = ['working', 'esc to interrupt', '❯ '];
    const t1 = medusaWake.assessSessionIdle({ lines, profile: CLAUDE });
    const t2 = medusaWake.assessSessionIdle({
      lines, profile: CLAUDE, prevDigest: t1.digest, idleTicks: t1.idleTicks
    });
    assert.equal(t2.idle, false);
    assert.equal(t2.reason, 'turn-in-flight');
  });

  it('a running agent fleet is never idle', () => {
    // The fleet signal is the agent block's ◯ bullet, not the status-line hint.
    const lines = ['◯ researching the codebase', '◯ writing the patch', '❯ '];
    let st = { digest: undefined, idleTicks: 0 };
    for (let i = 0; i < 3; i++) {
      const r = medusaWake.assessSessionIdle({
        lines, profile: CLAUDE, prevDigest: st.digest, idleTicks: st.idleTicks
      });
      st = { digest: r.digest, idleTicks: r.idleTicks };
      assert.equal(r.idle, false, 'a fleet pane must never accumulate an idle streak');
    }
  });

  it('a streak survives only while the pane keeps still', () => {
    let st = {};
    const steady = restingPane(3);
    for (let i = 0; i < 2; i++) {
      const r = medusaWake.assessSessionIdle({ lines: steady, profile: CLAUDE, prevDigest: st.digest, idleTicks: st.idleTicks });
      st = { digest: r.digest, idleTicks: r.idleTicks };
    }
    const moved = medusaWake.assessSessionIdle({
      lines: restingPane(5), profile: CLAUDE, prevDigest: st.digest, idleTicks: st.idleTicks
    });
    assert.equal(moved.idle, false);
    assert.equal(moved.idleTicks, 0);
  });

  it('the wake monitor and the chime share ONE gate', () => {
    // Two consumers with two copies of this composition is how they drift.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'medusa-wake.js'), 'utf8');
    const scan = src.slice(src.indexOf('function _scanSession'), src.indexOf('function _tick'));
    assert.match(scan, /assessSessionIdle\(/, 'the wake monitor must read through the shared gate');
    assert.doesNotMatch(scan, /const verdict = _assessPane\(/,
      'the wake monitor re-implements the composition instead of calling it');
    assert.doesNotMatch(scan, /_paneDigest\(/,
      'the wake monitor computes its own digest instead of taking the gate\'s');
  });
});

describe('#1180 detectAtPrompt — wired to a real session row', () => {
  const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');

  it('the chime site reads engineId — the key a session row actually has', () => {
    // A first attempt passed `active.engine`; store rows map engine_id ->
    // engineId, so the profile lookup was always undefined and every call fell
    // through to the legacy path. Dead code the suite could not see.
    assert.match(sessionsSrc, /detectAtPrompt\(active\.tmuxSession, active\.engineId\)/);
    assert.doesNotMatch(sessionsSrc, /detectAtPrompt\([^)]*\.engine\)/,
      'a session row has no `engine` key — that spelling makes the call inert');
  });

  it('the store really does expose engineId and not engine', () => {
    // Pin the assumption itself, so a future rename reds here rather than
    // silently disabling the chime gate.
    const store = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
    assert.match(store, /engineId:\s*row\.engine_id/);
  });

  it('an unprofiled engine degrades to staleness — it does not guess, and does not go silent', () => {
    // Guessing an unprofiled engine's idle signature is the false-idle hazard.
    // But answering "unknown" forever would delete the chime for that engine
    // and break #907's contract that a REACHED pane yields a real reading.
    const sessions = require('../lib/sessions.js');
    const r = sessions.detectAtPrompt('nonexistent-pane', 'codex');
    assert.notEqual(r.idle, null, 'a reached pane must still produce a real reading (#907)');
    assert.match(r.reason, /^staleness:no-wake-profile/,
      'the reason must name WHICH gate answered, or the degradation is invisible');
  });

  it('an unreadable pane degrades to staleness, naming that it did', () => {
    const sessions = require('../lib/sessions.js');
    const r = sessions.detectAtPrompt('definitely-not-a-real-tmux-session-1180', 'claude');
    assert.notEqual(r.idle, null);
    assert.match(r.reason, /^staleness:/);
  });

  it('the WRAPPING site deliberately stays on the staleness heuristic', () => {
    // Wrap-completion was built against "≥10s of unchanged output". Migrating
    // it is a separate behaviour change; this pins that the decision was made
    // rather than overlooked.
    assert.match(sessionsSrc, /detectIdle\(wrapping\.tmuxSession\)/);
  });

  it('the other detectIdle callers are untouched, and the reason is recorded', () => {
    for (const f of ['lib/wrap-steps/ai-content.js', 'lib/actions/invoke-critic.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.match(src, /detectIdle\(/, `${f} should still use the staleness heuristic`);
    }
    assert.match(sessionsSrc, /output-staleness heuristic|OUTPUT-STALENESS/i,
      'detectIdle must say what it actually measures, so the split is legible');
  });
});

describe('#1180 the chime consumer treats the unknown as no-ding', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

  it('only a truthy idle dings', () => {
    assert.match(view, /if \(data\.active && data\.idle\)/);
  });
});

describe('#1180 the capture window is wide enough for the digest to see movement', () => {
  const tmux = require('../lib/tmux');
  const sessions = require('../lib/sessions.js');

  it('captures TMUX_TAIL_LINES, the same window the wake monitor judges on', () => {
    // The old staleness heuristic read 3 lines. The digest needs the engine's
    // whole tail: it deliberately DROPS the composer and the divider above it,
    // so a 3-line window can reduce to almost nothing and stop registering
    // transcript movement — the signal this gate depends on.
    const realCapture = tmux.capturePane;
    const realCursor = tmux.cursorInfo;
    let seenOpts = null;
    tmux.capturePane = (_s, opts) => { seenOpts = opts; return { lines: ['a', 'b', '❯ '] }; };
    tmux.cursorInfo = () => null;
    try {
      sessions.detectAtPrompt('any-session', 'claude');
      assert.ok(seenOpts, 'capturePane was not called');
      assert.equal(seenOpts.lines, medusaWake.TMUX_TAIL_LINES);
      assert.ok(seenOpts.lines >= 15, 'a narrow window stops the digest seeing movement');
    } finally {
      tmux.capturePane = realCapture;
      tmux.cursorInfo = realCursor;
    }
  });

  it('a cursor probe failure is survivable, not fatal', () => {
    // The wake monitor treats this as non-fatal and falls back to the text
    // check; a stricter reading here would report "busy" for a pane that
    // captured fine, which is the opposite of the truth.
    const realCapture = tmux.capturePane;
    const realCursor = tmux.cursorInfo;
    tmux.capturePane = () => ({ lines: ['transcript', '', '❯ '] });
    tmux.cursorInfo = () => { throw new Error('no cursor'); };
    try {
      const r = sessions.detectAtPrompt('cursorless-session-1180', 'claude');
      assert.doesNotMatch(r.reason, /^staleness:/,
        'a readable pane must be judged by the strong gate even when the cursor probe fails');
    } finally {
      tmux.capturePane = realCapture;
      tmux.cursorInfo = realCursor;
    }
  });
});
