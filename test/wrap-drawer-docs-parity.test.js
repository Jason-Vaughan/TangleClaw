'use strict';

/*
 * #2886 I-Gate R1 Round 2 (A504-W1C-R5, finding 2) — the wrap drawer's
 * docs-parity dismissal control. public/wrap-drawer.js#renderDocsParityControl
 * is the pure render half (tested alone below); public/session.js's
 * `_renderDocsParityDismissControl` is the live half that binds the
 * rendered button to a real POST .../docs-parity/dismiss and, on success,
 * re-probes `resolveWrapPrStatus` so the signal clears on the next read --
 * the exact requirement this file verifies, since `resolveWrapPrStatus`
 * itself is too DOM/global-state-heavy to lift as a whole (same reason
 * test/setup-wizard-https.test.js's own harness exists for a comparable
 * function elsewhere).
 *
 * `_renderDocsParityDismissControl` is lifted directly out of session.js's
 * real source text (test/helpers/lift.js's liftDeclaration) and run against
 * the REAL public/wrap-drawer.js#renderDocsParityControl loaded into the
 * same sandbox -- a genuine two-file integration, not a stub standing in
 * for either side.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liftDeclaration } = require('./helpers/lift');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
const WRAP_DRAWER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'wrap-drawer.js'), 'utf8');

const ESC = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Strip vm-context `Object.prototype` identity so `assert.deepEqual`
 * compares structurally -- an object literal BUILT BY code running inside
 * the vm sandbox (e.g. `_renderDocsParityDismissControl`'s own `{url,
 * reason}` body) has a different `Object.prototype` than this outer test
 * context, which the strict assert module otherwise rejects as not
 * reference-equal (same reason test/wrap-drawer.test.js's own `plain()` exists).
 * @template T
 * @param {T} v
 * @returns {T}
 */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * Build a sandbox with the REAL wrap-drawer.js helpers loaded, and the
 * REAL `_renderDocsParityDismissControl` lifted from session.js, both
 * sharing one `document` (the mini-dom, upgraded on the docs-parity
 * container so its own dynamically-assigned markup registers real ids).
 * @param {object} [overrides] - `{apiMutate, resolveWrapPrStatus}`.
 * @returns {{doc: object, call: Function, calls: {mutate: Array, resolveCalls: Array}}}
 */
function loadLifted(overrides = {}) {
  const { doc } = makeDocument(['wrapDrawerDocsParity']);
  withIdParsingInnerHTML(doc.getElementById('wrapDrawerDocsParity'), doc);

  const mutateCalls = [];
  const resolveCalls = [];
  const sandbox = {
    console,
    document: doc,
    esc: ESC,
    api: overrides.api || Object.assign(async () => null, { lastError: null }),
    apiMutate: overrides.apiMutate || (async (p, m, b) => { mutateCalls.push([p, m, b]); return { dismissed: true }; }),
    projectName: 'proj-1',
    resolveWrapPrStatus: overrides.resolveWrapPrStatus || (async (...args) => { resolveCalls.push(args); })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WRAP_DRAWER_SRC, sandbox);
  vm.runInContext(
    `${liftDeclaration(SESSION_SRC, 'function _renderDocsParityDismissControl(')}\nglobalThis._renderDocsParityDismissControl = _renderDocsParityDismissControl;`,
    sandbox
  );
  return {
    doc,
    call: sandbox._renderDocsParityDismissControl,
    calls: { mutate: mutateCalls, resolve: resolveCalls }
  };
}

describe('wrap-drawer.js#renderDocsParityControl (pure)', () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(WRAP_DRAWER_SRC, sandbox);
  const { renderDocsParityControl } = sandbox.window.tcWrapDrawerHelpers;

  it('hides and clears the container when the signal has not fired', () => {
    const container = { classList: { add() {}, remove() {} }, innerHTML: 'stale' };
    const hiddenAdds = [];
    container.classList.add = (c) => hiddenAdds.push(c);
    assert.equal(renderDocsParityControl(container, null, ESC), false);
    assert.equal(container.innerHTML, '');
    assert.ok(hiddenAdds.includes('hidden'));

    assert.equal(renderDocsParityControl(container, { signal: false }, ESC), false);
  });

  it('renders the reason input and dismiss button, escaped, when the signal fires', () => {
    const container = { classList: { add() {}, remove() {} }, innerHTML: '' };
    const shown = renderDocsParityControl(container, { signal: true, reason: '<script>alert(1)</script>' }, ESC);
    assert.equal(shown, true);
    assert.match(container.innerHTML, /id="wrapDrawerDocsParityDismissBtn"/);
    assert.match(container.innerHTML, /id="wrapDrawerDocsParityReason"/);
    assert.doesNotMatch(container.innerHTML, /<script>alert/);
    assert.match(container.innerHTML, /&lt;script&gt;/);
  });
});

describe('session.js#_renderDocsParityDismissControl -- the live half (#2886 I-Gate R1 Round 2)', () => {
  it('does nothing, binds nothing, when docsParity has not fired', () => {
    const { doc, call } = loadLifted();
    call({ prUrl: 'https://github.com/o/r/pull/1' }, null, null, null);
    assert.equal(doc.getElementById('wrapDrawerDocsParity').innerHTML, '');
  });

  it('shows an error and makes no request when the reason is left blank', async () => {
    const { doc, call, calls } = loadLifted();
    call({ prUrl: 'https://github.com/o/r/pull/1' }, { signal: true, reason: 'touches server.js' }, null, null);

    const reasonInput = doc.getElementById('wrapDrawerDocsParityReason');
    reasonInput.value = '   ';
    doc.getElementById('wrapDrawerDocsParityDismissBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.mutate.length, 0, 'a blank reason must never reach the server');
    const err = doc.getElementById('wrapDrawerDocsParityError');
    assert.equal(err.classList.contains('hidden'), false);
    assert.match(err.textContent, /reason is required/);
  });

  it('posts the PR url and reason, then re-probes resolveWrapPrStatus on success', async () => {
    const { doc, call, calls } = loadLifted();
    const pr = { prUrl: 'https://github.com/o/r/pull/1' };
    const btn = { disabled: false };
    const baseStatus = { label: 'x', tone: 'success', detail: null };
    call(pr, { signal: true, reason: 'touches server.js' }, btn, baseStatus);

    const reasonInput = doc.getElementById('wrapDrawerDocsParityReason');
    reasonInput.value = 'operator-verified, no docs needed';
    doc.getElementById('wrapDrawerDocsParityDismissBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.mutate.length, 1);
    assert.equal(calls.mutate[0][0], '/api/sessions/proj-1/wrap/docs-parity/dismiss');
    assert.equal(calls.mutate[0][1], 'POST');
    assert.deepEqual(plain(calls.mutate[0][2]), { url: pr.prUrl, reason: 'operator-verified, no docs needed' });

    // The whole point of this control: a successful dismiss re-probes, so
    // the signal is read fresh rather than hidden locally on an assumption.
    assert.equal(calls.resolve.length, 1);
    assert.deepEqual(calls.resolve[0], [pr, btn, baseStatus]);
  });

  it('shows the server\'s own error and does not re-probe when the dismiss is refused', async () => {
    const { doc, call, calls } = loadLifted({
      apiMutate: async () => null,
      api: Object.assign(async () => null, { lastError: 'NOT_SIGNALED' })
    });
    call({ prUrl: 'u' }, { signal: true, reason: 'x' }, null, null);
    doc.getElementById('wrapDrawerDocsParityReason').value = 'a real reason';
    doc.getElementById('wrapDrawerDocsParityDismissBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 0));

    const err = doc.getElementById('wrapDrawerDocsParityError');
    assert.equal(err.classList.contains('hidden'), false);
    assert.equal(err.textContent, 'NOT_SIGNALED');
    assert.equal(calls.resolve.length, 0, 'a refused dismiss must not re-probe');
  });
});
