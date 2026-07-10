'use strict';

/*
 * UI-3B8N — the dashboard (landing.js) wrap trigger must be single-flight,
 * mirroring the session.js fix (#519 / VRF-wrap-single-flight).
 *
 * Regression: landing.js `confirmWrap` awaited `POST /wrap` without disabling
 * the confirm button, so a double-click fired two concurrent wraps (double
 * commit / pipeline race), and Cancel or a backdrop click could dismiss the
 * modal mid-wrap. This pins the guard structurally — landing.js is a browser
 * global script, not a require()-able module, so we assert against source the
 * same way test/session-wrapper.test.js pins the session-page fix and
 * test/auth-status-warning.test.js pins its landing surface.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find (e.g. `async function confirmWrap()`)
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`${decl} body must close`);
}

describe('UI-3B8N dashboard wrap trigger is single-flight', () => {
  let landing;

  before(() => {
    const root = path.resolve(__dirname, '..');
    landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
  });

  it('tracks an in-flight flag', () => {
    assert.ok(landing.includes('let wrapInFlight = false'),
      'landing.js must track an in-flight flag');
  });

  it('confirmWrap guards re-entrancy, locks both buttons, and resets in finally', () => {
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(body.includes('if (wrapInFlight) return'),
      'confirmWrap must bail when a wrap is already in flight');
    assert.ok(body.includes('wrapInFlight = true'),
      'must set the flag before the POST');
    assert.ok(/confirmBtn\.disabled = true/.test(body) && /cancelBtn\.disabled = true/.test(body),
      'must disable both Confirm and Cancel while wrapping');
    assert.ok(/Wrapping/.test(body),
      'must show a Wrapping… label');
    assert.ok(body.includes('} finally {') && /wrapInFlight = false/.test(body),
      'must reset the in-flight flag in finally (so a failed/hung wrap re-enables)');
  });

  it('closeWrapModal blocks user closes while a wrap is in flight (strict force check)', () => {
    assert.ok(landing.includes('if (wrapInFlight && force !== true) return'),
      'closeWrapModal must block Cancel/backdrop closes mid-wrap via a strict force check');
    // The success path must force-close past that guard.
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(body.includes('closeWrapModal(true)'),
      'confirmWrap must force-close the modal on success');
  });

  it('has no timer-driven lifecycle (state tracks the request, not a clock)', () => {
    const body = functionBody(landing, 'async function confirmWrap()');
    assert.ok(!/setTimeout|setInterval/.test(body),
      'confirmWrap must not use timers (no timer-driven UI lifecycle)');
  });
});
