'use strict';

/*
 * #1181 — the per-session chime, promoted from the Session Settings modal to
 * the live session banner.
 *
 * The control is LIFTED AND RUN out of `public/api-helper.js` against the mini
 * DOM, the convention `medusa-control-component.test.js` established, because
 * the defect this move retires is invisible to a source pin. The old
 * `updateChimeIndicator` read correctly:
 *
 *   if (sessionState.chimeEnabled) btn.classList.add('active');
 *
 * A pin asserting "it paints when enabled" passes on that. What it never did
 * was REMOVE the class, so switching the chime off left the indicator lit until
 * reload — and it painted onto `#cmdBtn`, whose `active` class also means "the
 * command bar is open". Both are asserted here by running the thing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { makeDocument } = require('./_mini-dom');

const G = loadApiHelperGlobals();
const PUBLIC = path.join(__dirname, '..', 'public');
const sessionHtml = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');
const sessionJs = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');

/**
 * A document holding the chime button, plus a control bound to it.
 * @param {object} [opts]
 * @param {boolean} [opts.withButton] - Whether the button exists at all.
 * @returns {{btn: object, control: object, toggles: boolean[]}}
 */
function world({ withButton = true } = {}) {
  const { doc, ids } = makeDocument(withButton ? ['chimeBtn'] : []);
  const toggles = [];
  const control = G.tcCreateChimeControl({ doc, onToggle: (v) => toggles.push(v) });
  return { btn: ids.chimeBtn || null, control, toggles };
}

describe('tcCreateChimeControl — render paints both directions', () => {
  it('arming the chime sets the class, the pressed state and an "on" label', () => {
    const { btn, control } = world();
    control.render(true);
    assert.ok(btn.classList.contains('active'));
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.match(btn.getAttribute('aria-label'), /: on\./);
    assert.match(btn.title, /on$/);
  });

  it('disarming REMOVES the class — the defect the old indicator shipped', () => {
    const { btn, control } = world();
    control.render(true);
    control.render(false);
    assert.equal(btn.classList.contains('active'), false,
      'a chime switched off must not leave the control lit');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.match(btn.getAttribute('aria-label'), /: off\./);
  });

  it('the label names the state, so the meaning does not rest on colour alone', () => {
    const { btn, control } = world();
    control.render(true);
    const on = btn.getAttribute('aria-label');
    control.render(false);
    assert.notEqual(on, btn.getAttribute('aria-label'));
  });

  it('a missing button is a no-op rather than a throw', () => {
    const { control } = world({ withButton: false });
    assert.doesNotThrow(() => control.render(true));
    assert.doesNotThrow(() => control.mount(true));
  });
});

describe('tcCreateChimeControl — mount', () => {
  it('paints the persisted state on first mount', () => {
    const { btn, control } = world();
    control.mount(true);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
  });

  it('a click flips the control and reports the NEXT state to the caller', () => {
    const { btn, control, toggles } = world();
    control.mount(false);
    btn.dispatch('click');
    assert.deepEqual(toggles, [true]);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    btn.dispatch('click');
    assert.deepEqual(toggles, [true, false]);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
  });

  it('binds once — a second mount cannot stack a handler and double-toggle', () => {
    const { btn, control, toggles } = world();
    control.mount(false);
    control.mount(false);
    btn.dispatch('click');
    assert.equal(toggles.length, 1, 'one click must produce exactly one toggle');
  });
});

describe('#1181 — the chime moved, it was not duplicated', () => {
  it('the banner carries the control', () => {
    const actions = sessionHtml.slice(
      sessionHtml.indexOf('<div class="banner-actions">'),
      sessionHtml.indexOf('</header>')
    );
    assert.ok(actions.includes('id="chimeBtn"'), 'chime control is not in the banner');
    assert.match(actions, /id="chimeBtn"[\s\S]{0,400}?aria-pressed=/);
    assert.match(actions, /id="chimeBtn"[\s\S]{0,400}?aria-label=/);
  });

  it('the settings modal no longer has a chime row', () => {
    assert.ok(!sessionHtml.includes('id="chimeToggle"'),
      'two controls for one setting is how they drift');
  });

  it('the Cmd button no longer carries chime state', () => {
    assert.ok(!/updateChimeIndicator/.test(sessionJs),
      'the one-directional indicator must be gone, not merely corrected');
    for (const line of sessionJs.split('\n')) {
      assert.ok(!(/cmdBtn/.test(line) && /chime/i.test(line)),
        `chime state is painted onto the Cmd button again: ${line.trim()}`);
    }
  });
});

describe('#1181 — the install-wide mute still outranks the session toggle', () => {
  it('playChime returns early on config.chimeMuted, whatever the control says', () => {
    const start = sessionJs.indexOf('function playChime(');
    assert.ok(start > 0, 'playChime not found');
    const body = sessionJs.slice(start, sessionJs.indexOf('\nfunction ', start + 1));
    assert.match(body, /config\.chimeMuted\)\s*return/,
      'the global mute must gate playback, not the banner control');
  });
});
