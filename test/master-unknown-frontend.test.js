'use strict';

/*
 * #905 — the Project Master's state can be UNKNOWN, and the panel has to say so.
 *
 * `getMasterStatus` used to report `exists: t.hasSession(...)`, and `hasSession`
 * answers false both for a master that is not running and for a tmux server too
 * wedged to reply. The dashboard then rendered nothing at all for a false: the
 * dot stayed neutral and the row still read "Checking…", so a wedge looked
 * exactly like a master nobody had started. Opening the panel fired an ensure
 * against the same unresponsive server and reported "Failed to start the master
 * session" — blaming the start for a condition that predates it.
 *
 * These tests LIFT the real functions out of public/ui.js and RUN them, the
 * same lift-and-run approach as test/landing-unreachable-state.test.js —
 * asserting on rendered state, because what the operator sees IS the defect.
 * A source-grep would only prove the branch exists, and existing and reachable
 * are different claims (#928 R-1).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

/**
 * Load the real `public/api-helper.js` and return its exported globals.
 *
 * The module is an IIFE that assigns onto a global object, so it is loaded the
 * way a page loads it rather than reimplemented — the point of these guards is
 * that the master renders through the SHARED vocabulary, and a stubbed
 * `tcMasterRead` would prove the opposite of what is being claimed.
 *
 * @returns {object} The globals the helper exports.
 */
function loadApiHelper() {
  const g = { window: undefined, document: undefined, fetch: () => {}, console };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(API_HELPER_SRC, g);
  return g;
}

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * A DOM element stub covering what the master status code touches.
 * @param {string} id - Element id.
 * @returns {object} The stub.
 */
function makeElement(id) {
  const classSet = new Set();
  return {
    id,
    textContent: '',
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c),
      toggle: (c, on) => (on ? classSet.add(c) : classSet.delete(c))
    },
    _classes: classSet
  };
}

/**
 * Build a sandbox running the real master-status functions against a
 * test-controlled `/api/master/status` payload.
 * @param {object|null} payload - What the API answers.
 * @returns {Promise<object>} The sandbox, with `els` attached.
 */
async function render(payload) {
  const els = {
    masterDot: makeElement('masterDot'),
    masterPanelDot: makeElement('masterPanelDot'),
    masterPanelStatusText: makeElement('masterPanelStatusText'),
    masterPanelRetryBtn: makeElement('masterPanelRetryBtn')
  };
  // The row starts as the markup ships it, so a test can tell "left untouched"
  // from "deliberately written" — the original defect was silence, and silence
  // is only visible against the placeholder it fails to replace.
  els.masterPanelStatusText.textContent = 'Checking…';
  els.masterPanelRetryBtn.classList.add('hidden');

  const sandbox = {
    console,
    document: { getElementById: (id) => els[id] || null },
    // Mirrors the real helper's contract: resolves the parsed body, or null on
    // failure with the reason on `api.lastError`.
    api: async () => payload,
    // The REAL classifier, not a stub. What is being asserted is that the master
    // row speaks the shared degraded-read vocabulary, and a stub would make that
    // claim unfalsifiable.
    tcMasterRead: loadApiHelper().tcMasterRead
  };
  // The status row moved into the shared control bar (#768 chunk 2), so
  // `setMasterStatus` delegates rather than writing ids. The REAL component is
  // injected, bound to these same elements — a stub here would assert only that
  // delegation was attempted, not that the row still ends up correct, which is
  // the whole subject of this file.
  sandbox.masterBar = loadApiHelper().tcCreateMasterControlBar({
    doc: sandbox.document, rootId: 'masterPanelBar', prefix: 'masterPanel'
  });
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const script = [
    liftFunction(UI_SRC, 'function setMasterStatus(status, text, showRetry)'),
    liftFunction(UI_SRC, 'async function refreshMasterDot()'),
    'refreshMasterDot();'
  ].join('\n');

  await vm.runInContext(script, sandbox);
  sandbox.els = els;
  return sandbox;
}

describe('the master panel distinguishes "not running" from "could not look" (#905)', () => {
  it('says the state is unknown when tmux did not answer', async () => {
    // THE MUTATION THIS CATCHES: rendering `exists: null` through the same
    // branch as `exists: false` — i.e. leaving the page as it was. That is what
    // shipped, and it is the entire defect: the operator is shown a panel that
    // looks like a master they never started.
    const { els } = await render({ exists: null, incomplete: ['exists'], cause: 'read-timed-out' });

    assert.notEqual(els.masterPanelStatusText.textContent, 'Checking…',
      'a state nobody could establish must not leave the placeholder standing');
    assert.match(els.masterPanelStatusText.textContent, /could not be established/i,
      'and it has to name the state as unestablished, not as down');
    assert.equal(els.masterPanelRetryBtn._classes.has('hidden'), false,
      'an unknown is worth re-asking about, so Retry has to be reachable');
  });

  it('speaks the shared degraded-read vocabulary — cause AND remedy, like a project card', async () => {
    // Critic R-9/R-21. `cause` crossed the payload boundary and was consumed by
    // nothing: the row hand-wrote one fixed sentence with no cause and no
    // remedy, while a project card on the SAME page, meeting the SAME wedge,
    // named both. `public/api-helper.js` exists so a new source joins in one
    // place rather than growing another render path, and `architecture.md`'s
    // Direction records that as a norm — so the bespoke sentence was a norm
    // departure, not a style choice.
    //
    // THE MUTATION THIS CATCHES: rendering a literal string here instead of
    // going through `tcMasterRead` — the remedy disappears, and so does any
    // future cause the shared table learns to translate.
    const { els } = await render({ exists: null, incomplete: ['exists'], cause: 'read-timed-out' });
    const text = els.masterPanelStatusText.textContent;

    assert.match(text, /stopped by TangleClaw after it stopped responding/,
      'the CAUSE has to be translated, not dropped — it is in the payload and nothing read it');
    assert.match(text, /tmux kill-server/,
      'and the operator needs the REMEDY the sibling surface already gives them');
  });

  it('translates an unfamiliar cause rather than echoing a raw token at the operator', async () => {
    // The shared table degrades unknown tokens to a generic sentence. Pinned
    // here because the master row is a new consumer of that behaviour, and the
    // failure mode is a payload token leaking into prose someone reads.
    const { els } = await render({ exists: null, incomplete: ['exists'], cause: 'some-new-token' });
    assert.doesNotMatch(els.masterPanelStatusText.textContent, /some-new-token/,
      'a raw cause token in operator-facing prose reads as a leak');
    assert.match(els.masterPanelStatusText.textContent, /did not complete/);
  });

  it('does not paint the master live or down on an unknown', async () => {
    // The dot carries three meanings already; "we could not look" is not a
    // degree of down, and colouring it as one would state a fact this payload
    // explicitly declines to state.
    const { els } = await render({ exists: null, incomplete: ['exists'], cause: 'read-timed-out' });

    for (const dot of [els.masterDot, els.masterPanelDot]) {
      assert.equal(dot._classes.has('live'), false);
      assert.equal(dot._classes.has('down'), false);
      assert.equal(dot._classes.has('pending'), false);
    }
  });

  it('still paints live when tmux answered that the master is up', async () => {
    const { els } = await render({ exists: true, incomplete: [], cause: null });
    assert.equal(els.masterDot._classes.has('live'), true);
    assert.equal(els.masterPanelDot._classes.has('live'), true);
  });

  it('leaves an ANSWERED absence exactly as it was', async () => {
    // The half that keeps this from becoming "shout on every load". tmux
    // answering "not running" on a machine where the operator simply has not
    // started the master is the ordinary case, and it is not a problem report.
    const { els } = await render({ exists: false, incomplete: [], cause: null });

    assert.equal(els.masterPanelStatusText.textContent, 'Checking…',
      'an answered absence is the ordinary state, not a condition to announce');
    assert.equal(els.masterDot._classes.has('live'), false);
  });

  it('does not paint the panel red when the ENSURE refused on an unknown liveness', async () => {
    // THE MUTATION THIS CATCHES: leaving `setMasterStatus('down', ...)` on the
    // ensure failure path. `ensureMasterSession` now refuses rather than
    // starting a second master over one it cannot see, and that refusal comes
    // back as an error — so the panel's own error branch would have painted the
    // master DOWN on exactly the condition the server just said it could not
    // establish. The defect this change removes, re-entered one layer along.
    const els = {
      masterDot: makeElement('masterDot'),
      masterPanelDot: makeElement('masterPanelDot'),
      masterPanelStatusText: makeElement('masterPanelStatusText'),
      masterPanelRetryBtn: makeElement('masterPanelRetryBtn')
    };
    const sandbox = {
      console,
      document: { getElementById: (id) => els[id] || null },
      state: { masterEnsuring: false },
      attachMasterFrame() { throw new Error('must not attach a frame for a master it cannot see'); }
    };
    const api = async () => null;
    api.lastError = 'Could not determine whether the Project Master is already running — tmux did not answer.';
    api.lastErrorCode = 'MASTER_LIVENESS_UNKNOWN';
    sandbox.api = api;
    sandbox.window = sandbox;
    // Same reason as `render` above: the row belongs to the shared bar now, so
    // the real component is injected rather than stubbed.
    sandbox.masterBar = loadApiHelper().tcCreateMasterControlBar({
      doc: sandbox.document, rootId: 'masterPanelBar', prefix: 'masterPanel'
    });
    vm.createContext(sandbox);

    await vm.runInContext([
      liftFunction(UI_SRC, 'function setMasterStatus(status, text, showRetry)'),
      liftFunction(UI_SRC, 'async function ensureMasterAttached()'),
      'ensureMasterAttached();'
    ].join('\n'), sandbox);

    assert.equal(els.masterDot._classes.has('down'), false,
      'a liveness nobody established must not be painted as a definite down');
    assert.match(els.masterPanelStatusText.textContent, /tmux did not answer/,
      'and the real reason has to reach the operator');
    assert.equal(els.masterPanelRetryBtn._classes.has('hidden'), false, 'Retry stays available');
  });

  it('still paints down when the ensure genuinely failed', async () => {
    // The other half: a real start failure is still a red dot. Without this the
    // fix above could degrade into "never show down", which loses the signal
    // that an engine is missing or a launch command is broken.
    const els = {
      masterDot: makeElement('masterDot'),
      masterPanelDot: makeElement('masterPanelDot'),
      masterPanelStatusText: makeElement('masterPanelStatusText'),
      masterPanelRetryBtn: makeElement('masterPanelRetryBtn')
    };
    const sandbox = {
      console,
      document: { getElementById: (id) => els[id] || null },
      state: { masterEnsuring: false },
      attachMasterFrame() {}
    };
    const api = async () => null;
    api.lastError = 'Engine "claude" not available (binary not found)';
    api.lastErrorCode = 'MASTER_ENSURE_FAILED';
    sandbox.api = api;
    sandbox.window = sandbox;
    // Same reason as `render` above: the row belongs to the shared bar now, so
    // the real component is injected rather than stubbed.
    sandbox.masterBar = loadApiHelper().tcCreateMasterControlBar({
      doc: sandbox.document, rootId: 'masterPanelBar', prefix: 'masterPanel'
    });
    vm.createContext(sandbox);

    await vm.runInContext([
      liftFunction(UI_SRC, 'function setMasterStatus(status, text, showRetry)'),
      liftFunction(UI_SRC, 'async function ensureMasterAttached()'),
      'ensureMasterAttached();'
    ].join('\n'), sandbox);

    assert.equal(els.masterDot._classes.has('down'), true,
      'a genuine start failure is a definite down, and must still read as one');
  });

  it('does nothing at all when the status call itself failed', async () => {
    // A null payload is the api helper reporting a failed request, not the
    // server reporting an unknown — reading `.exists` off it would throw and
    // take the rest of page init with it.
    const { els } = await render(null);
    assert.equal(els.masterPanelStatusText.textContent, 'Checking…');
  });
});
