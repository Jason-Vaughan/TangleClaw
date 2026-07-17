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
 *        override that nothing removed (live evidence: RentalClaw-Project).
 *   RC3  the touch-only "mouse guard" (3s poll) enforced mouse OFF, while
 *        the #443 touch-scroll shim REQUIRES mouse ON — mutually exclusive
 *        designs, so touch-scroll could never reliably work on a phone.
 *
 * The decisions now live in pure functions (the TST-6L2P lift pattern) so
 * the logic executes under test even though the DOM can't:
 * tcSelectModeMouse (public/api-helper.js) and _resolveMouseValue
 * (lib/tmux.js). Source probes pin the wiring.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');
const { tcSelectModeMouse, tcIsFocusTap } = globalThis;
const { _resolveMouseValue } = require('../lib/tmux.js');

/**
 * Extract a function's body from source by walking brace depth.
 * @param {string} src - File source
 * @param {string} marker - Text locating the function (e.g. 'function foo(')
 * @returns {string} the body including braces; '' when not found
 */
function functionBody(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return '';
}

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
    const tmuxJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    const body = functionBody(tmuxJs, 'function getMouse(');
    assert.ok(body.includes('show-options -g -v mouse'),
      'getMouse must read the global mouse value as the no-override fallback');
    assert.ok(body.includes('_resolveMouseValue('),
      'getMouse must resolve through the tested pure helper');
  });
});

describe('Select-mode mouse decision (#574 RC2 — tcSelectModeMouse)', () => {
  it('exiting select mode RESTORES the pre-select state on mobile (THE regression)', () => {
    // The old mobile exit hardcoded `false`, permanently stranding a
    // session-level `mouse off` override that killed touch-scroll.
    assert.equal(tcSelectModeMouse({ entering: false, isMobile: true, mouseOn: true }), true);
  });

  it('exiting select mode restores the pre-select state on every platform', () => {
    assert.equal(tcSelectModeMouse({ entering: false, isMobile: false, mouseOn: true }), true);
    assert.equal(tcSelectModeMouse({ entering: false, isMobile: true, mouseOn: false }), false);
    assert.equal(tcSelectModeMouse({ entering: false, isMobile: false, mouseOn: false }), false);
  });

  it('entering keeps the platform split (mobile: mouse on, desktop: mouse off)', () => {
    assert.equal(tcSelectModeMouse({ entering: true, isMobile: true, mouseOn: false }), true);
    assert.equal(tcSelectModeMouse({ entering: true, isMobile: false, mouseOn: true }), false);
  });
});

describe('Select-mode + mouse-guard wiring (#574 source pins)', () => {
  let sessionJs;

  before(() => {
    sessionJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  });

  it('toggleSelect has NO auto-revert timer (no-UI-timers rule, #98/#268)', () => {
    const body = functionBody(sessionJs, 'async function toggleSelect(');
    assert.ok(body, 'toggleSelect must exist');
    assert.ok(!body.includes('setTimeout'),
      'select mode must be an explicit toggle — the 30s auto-revert was removed in #574, never re-add or lengthen it');
  });

  it('toggleSelect routes BOTH transitions through tcSelectModeMouse', () => {
    const body = functionBody(sessionJs, 'async function toggleSelect(');
    const calls = body.split('tcSelectModeMouse(').length - 1;
    assert.equal(calls, 2,
      'enter and exit must both use the tested pure decision (found ' + calls + ' call(s))');
    assert.ok(body.includes('entering: false, isMobile, mouseOn: sessionState.mouseOn'),
      'the exit path must restore sessionState.mouseOn — never a platform hardcode');
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
    const body = functionBody(helper, 'function tcWireTerminalDragCopy(');
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
    const body = functionBody(helper, 'function tcWireTerminalDragCopy(');
    assert.ok(body.includes('gestureMovedPastSlop = true'),
      'movement past the long-press slop must disqualify the tap, or every scroll would pop the keyboard');
  });
});
