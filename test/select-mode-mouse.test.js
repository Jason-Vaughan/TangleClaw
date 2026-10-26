'use strict';

/*
 * Regression tests for #574 (UI-6M4V) — the iPhone terminal was select-only:
 * no soft keyboard, no touch-scroll. The scroll half traced to three
 * interlocking defects around tmux mouse state:
 *
 *   RC1  lib/tmux.js getMouse read only the SESSION-level option, which is
 *        empty when no override exists — so every global-`mouse on` session
 *        (deploy/tmux.conf) was misreported as off.
 *   RC2  toggleSelect's mobile exit path hardcoded mouse OFF (and its 30s
 *        auto-revert timer violated the no-UI-timers rule, #98/#268) —
 *        one Select round-trip stranded a session-level `mouse off`
 *        override that nothing removed (live evidence: ExampleApp-Project).
 *   RC3  the touch-only "mouse guard" (3s poll) enforced mouse OFF, while
 *        the #443 touch-scroll shim REQUIRES mouse ON — mutually exclusive
 *        designs, so touch-scroll could never reliably work on a phone.
 *
 * The decisions now live in pure functions (the TST-6L2P lift pattern) so
 * the logic executes under test even though the DOM can't: _resolveMouseValue
 * (lib/tmux.js). Source probes pin the wiring.
 *
 * #579 (UI-2P7T) extends the family: restoring a pre-select state that was
 * INHERITED from the global by SETTING its value strands a benign-valued
 * session-level override (found live in VRF-574 leg 4). The restore now
 * distinguishes inherited from explicit (_resolveMouseState / getMouseState
 * / unsetMouse in lib/tmux.js). This infrastructure outlives Select mode
 * itself: #1237's plain mouse-mode Settings toggle routes through the same
 * /api/tmux/mouse and the same explicit/inherited distinction.
 *
 * #960 (Operator Decision A2) removed the Select button, its session.js
 * caller side (toggleSelect, repairAbandonedSelect, the writeSelectMarker/
 * clearSelectMarker localStorage helpers), and — per A474-W2-R4's W2-C
 * authorization to touch public/api-helper.js once W2-B's own PR had
 * merged — the now-orphaned tcSelectModeMouse/tcParseSelectMarker
 * themselves, along with their describe blocks here.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { liftBody } = require('./helpers/lift');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');
const { tcIsFocusTap } = globalThis;
const { _resolveMouseValue } = require('../lib/tmux.js');

describe('Effective tmux mouse state (#574 RC1 — _resolveMouseValue)', () => {
  it('falls back to the global value when the session has no override (THE regression)', () => {
    // Every session without an override read as '' → was coerced to false
    // even though deploy/tmux.conf sets global mouse on.
    assert.equal(_resolveMouseValue('', 'on'), true);
  });

  it('a session-level override wins over the global in both directions', () => {
    assert.equal(_resolveMouseValue('off', 'on'), false);
    assert.equal(_resolveMouseValue('on', 'off'), true);
  });

  it('resolves off when neither level enables the mouse', () => {
    assert.equal(_resolveMouseValue('', 'off'), false);
    assert.equal(_resolveMouseValue('', ''), false);
    assert.equal(_resolveMouseValue('off', 'off'), false);
  });

  it('getMouse is wired to read the global fallback', () => {
    // Re-pointed for #579: the reads moved into getMouseState (getMouse
    // delegates to it) — the #574 intent (global fallback consulted) is
    // unchanged, the guard follows the code to its new home.
    const tmuxJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    const getBody = liftBody(tmuxJs, 'function getMouse(');
    assert.ok(getBody.includes('getMouseState('),
      'getMouse must delegate to the source-aware getMouseState');
    const stateBody = liftBody(tmuxJs, 'function getMouseState(');
    assert.ok(stateBody.includes('show-options -g -v mouse'),
      'getMouseState must read the global mouse value as the no-override fallback');
    assert.ok(stateBody.includes('_resolveMouseState('),
      'getMouseState must resolve through the tested pure helper');
  });
});

describe('Mouse state source (#579 — _resolveMouseState)', () => {
  const { _resolveMouseState } = require('../lib/tmux.js');

  it('an inherited value reports explicit: false (the restore-by-unset signal)', () => {
    assert.deepEqual(_resolveMouseState('', 'on'), { on: true, explicit: false });
    assert.deepEqual(_resolveMouseState('', 'off'), { on: false, explicit: false });
  });

  it('a session-level override reports explicit: true with its own value', () => {
    assert.deepEqual(_resolveMouseState('off', 'on'), { on: false, explicit: true });
    assert.deepEqual(_resolveMouseState('on', 'off'), { on: true, explicit: true });
    assert.deepEqual(_resolveMouseState('on', 'on'), { on: true, explicit: true });
  });

  it('_resolveMouseValue keeps its boolean contract through the shared resolution', () => {
    assert.equal(_resolveMouseValue('', 'on'), true);
    assert.equal(_resolveMouseValue('off', 'on'), false);
  });

  it('is wired: getMouseState resolves through the tested helper; unsetMouse uses set -u', () => {
    const tmuxJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    const stateBody = liftBody(tmuxJs, 'function getMouseState(');
    assert.ok(stateBody.includes('_resolveMouseState('),
      'getMouseState must resolve through the tested pure helper');
    const unsetBody = liftBody(tmuxJs, 'function unsetMouse(');
    assert.ok(unsetBody.includes('set-option -u'),
      'unsetMouse must remove the session-level override, not write a value');
  });

  it('is wired: the mouse routes carry the source and accept unset (#579)', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(serverJs.includes("'/api/tmux/mouse/:session'") &&
      serverJs.includes('explicit: state.explicit'),
      'GET must report whether the value is a session-level override');
    assert.ok(serverJs.includes('tmux.unsetMouse('),
      'POST must route unset: true to tmux.unsetMouse');
  });
});

describe('Select-mode + mouse-guard wiring (#574 source pins)', () => {
  let sessionJs;

  before(() => {
    sessionJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  });

  it('the touch-only mouse guard stays removed (#574 RC3)', () => {
    // The guard (a 3s poll forcing tmux mouse OFF on touch devices) is
    // mutually exclusive with the #443 touch-scroll shim, which needs mouse
    // ON to translate drags into tmux copy-mode scrolling.
    assert.ok(!sessionJs.includes('startMouseGuard') && !sessionJs.includes('mouseGuardTimer'),
      'reinstating the touch mouse guard kills touch-scroll — see #574');
  });
});

describe('Tap-to-focus (#574 RC4 — tcIsFocusTap)', () => {
  it('a clean tap focuses (THE regression — the keyboard could never appear)', () => {
    assert.equal(tcIsFocusTap({
      multiTouch: false, wasPill: false, selectActivated: false, movedPastSlop: false
    }), true);
  });

  it('every non-tap gesture is excluded', () => {
    const clean = { multiTouch: false, wasPill: false, selectActivated: false, movedPastSlop: false };
    for (const flag of ['multiTouch', 'wasPill', 'selectActivated', 'movedPastSlop']) {
      assert.equal(tcIsFocusTap({ ...clean, [flag]: true }), false,
        `${flag} must disqualify the gesture from focusing`);
    }
  });

  it('is wired: touchend focuses through the predicate, touchcancel never focuses', () => {
    const helper = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
    const body = liftBody(helper, 'function tcWireTerminalDragCopy(');
    assert.ok(body, 'tcWireTerminalDragCopy must exist');
    // The touchend handler must gate term.focus() on the tested predicate.
    const touchendAt = body.indexOf("addEventListener('touchend'");
    const touchcancelAt = body.indexOf("addEventListener('touchcancel'");
    assert.ok(touchendAt !== -1 && touchcancelAt !== -1, 'both end handlers must exist');
    const touchendSlice = body.slice(touchendAt, touchcancelAt);
    assert.ok(touchendSlice.includes('tcIsFocusTap(') && touchendSlice.includes('term.focus()'),
      'touchend must focus the terminal via tcIsFocusTap — the ghost-mouse ' +
      'suppression swallows the synthesized mousedown that used to do it');
    const touchcancelSlice = body.slice(touchcancelAt);
    assert.ok(!touchcancelSlice.includes('term.focus()'),
      'touchcancel must never focus (the system took the gesture back)');
  });

  it('is wired: the slop-exceed branch marks the gesture as a scroll', () => {
    const helper = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
    const body = liftBody(helper, 'function tcWireTerminalDragCopy(');
    assert.ok(body.includes('gestureMovedPastSlop = true'),
      'movement past the long-press slop must disqualify the tap, or every scroll would pop the keyboard');
  });
});
