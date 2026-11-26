'use strict';

/*
 * v6.6.1 Wave 1 (Car V661-W1-C, #3258 / V6-001).
 *
 * public/ui.js is a large, DOM-executing production file, not safely
 * mountable in node:test the way test/v6-b1-ui-shell.test.js loads
 * public/v6-shell.js itself (`vm.runInContext` + test/_mini-dom.js) — ui.js
 * assumes a full page's worth of elements already exist by the time its
 * top-level script reaches the v6 shell mount. This file instead does a
 * source-level regression, the same pattern
 * test/v6-usage-popover-and-composer-layout.test.js uses against the real
 * shipped public/style.css rule bodies: extract the literal options object
 * ui.js passes to `tcCreateV6Shell(document, { ... })` in production, and
 * every `options.onXxx` identifier public/v6-shell.js's own mount code
 * actually reads, then assert the first set covers the second. That is
 * exactly the failure #3258 fixed for `onViewOfflineHistory` and
 * `onReturnToStartCard`: v6-shell.js's wireControls() had read them since
 * #3203 shipped, but nothing in production ever passed them in, so the
 * "View Previous Conversation" button did nothing. This test exists so a
 * callback v6-shell.js starts consuming can never again go silently
 * unwired here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const SHELL_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8');

/**
 * Scans forward from `openBraceIndex` (which must point at a `{`) and
 * returns the index of its matching `}`, by plain depth counting. Safe
 * here only because the scanned region (the tcCreateV6Shell options
 * object) carries no `{`/`}` inside a string or comment — verified by the
 * balance assertion callers make on the result.
 * @param {string} src
 * @param {number} openBraceIndex
 * @returns {number}
 */
function matchingBraceIndex(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The literal options object public/ui.js passes to
 * `tcCreateV6Shell(document, { ... })` in production, as raw source text
 * (everything between the outer braces, exclusive).
 * @returns {string}
 */
function extractMountOptionsSource() {
  const marker = 'window.tcCreateV6Shell(document, {';
  const start = UI_SRC.indexOf(marker);
  assert.ok(start !== -1, 'public/ui.js must still call window.tcCreateV6Shell(document, {...}) directly');
  const openBrace = start + marker.length - 1;
  const closeBrace = matchingBraceIndex(UI_SRC, openBrace);
  assert.ok(closeBrace !== -1, 'unbalanced braces while scanning the tcCreateV6Shell options object');
  return UI_SRC.slice(openBrace + 1, closeBrace);
}

/**
 * Every `options.onXxx` identifier public/v6-shell.js's mount function
 * actually reads at runtime — i.e. what it genuinely CONSUMES, not just
 * documents in its own JSDoc opts typedef.
 * @returns {Set<string>}
 */
function consumedShellCallbacks() {
  const names = new Set();
  const re = /options\.(on[A-Za-z]\w*)/g;
  let m = re.exec(SHELL_SRC);
  while (m) {
    names.add(m[1]);
    m = re.exec(SHELL_SRC);
  }
  return names;
}

/**
 * Every `onXxx(...) { ... }` method-shorthand key public/ui.js wires into
 * the options object, mapped to that method's own source body — so callers
 * can assert WHAT it delegates to, not just that the key is present.
 * @param {string} optionsSrc
 * @returns {Map<string, string>}
 */
function wiredUiCallbacks(optionsSrc) {
  const wired = new Map();
  const re = /(on[A-Z]\w*)\s*\([^)]*\)\s*\{/g;
  let m = re.exec(optionsSrc);
  while (m) {
    const bodyStart = re.lastIndex;
    const bodyEnd = matchingBraceIndex(optionsSrc, bodyStart - 1);
    wired.set(m[1], bodyEnd === -1 ? '' : optionsSrc.slice(bodyStart, bodyEnd));
    m = re.exec(optionsSrc);
  }
  return wired;
}

// `onHoodCommand` is a real callback public/v6-shell.js consumes
// (Under the Hood's Interactive CLI Mode, #3135) that this file does NOT
// yet wire — deliberately, per its own doc comment on the mount opts
// typedef ("planned for Wave 2"), with a documented fallback
// (onSendChat / a direct fetch) in the meantime. The one allowed gap in
// the otherwise-exhaustive audit below.
const INTENTIONALLY_DEFERRED = new Set(['onHoodCommand']);

describe('#3258 (V6-001): public/ui.js wires every tcCreateV6Shell callback public/v6-shell.js consumes', () => {
  const optionsSrc = extractMountOptionsSource();
  const consumed = consumedShellCallbacks();
  const wired = wiredUiCallbacks(optionsSrc);

  it('sanity: the extractor actually found a broad set of consumed callbacks', () => {
    assert.ok(consumed.size >= 20, `expected a broad set of consumed callbacks, found ${consumed.size}`);
  });

  it('every consumed callback, except the documented Wave-2 deferral, is wired in public/ui.js', () => {
    const missing = [...consumed].filter((name) => !INTENTIONALLY_DEFERRED.has(name) && !wired.has(name));
    assert.deepEqual(missing, [], `public/ui.js is missing: ${missing.join(', ')}`);
  });

  it('the documented deferral is itself still unwired (so this test notices the day it should be promoted out of the allowlist)', () => {
    for (const name of INTENTIONALLY_DEFERRED) {
      assert.ok(consumed.has(name), `${name} is no longer consumed by v6-shell.js — drop it from INTENTIONALLY_DEFERRED`);
    }
  });

  it('onViewOfflineHistory delegates to v6Live.viewOfflineHistory, passing the project name through', () => {
    assert.ok(wired.has('onViewOfflineHistory'), 'onViewOfflineHistory must be wired');
    assert.match(wired.get('onViewOfflineHistory'), /v6Live\.viewOfflineHistory\(\s*projectName\s*\)/);
  });

  it('onReturnToStartCard delegates to v6Live.returnToStartCard, passing the project name through', () => {
    assert.ok(wired.has('onReturnToStartCard'), 'onReturnToStartCard must be wired');
    assert.match(wired.get('onReturnToStartCard'), /v6Live\.returnToStartCard\(\s*projectName\s*\)/);
  });

  it('onStartFleetMembers delegates to v6Live.startFleetMembers, passing the names through '
    + '(#3258 acceptance criterion 1 — wired ahead of a shell-side consumer landing)', () => {
    assert.ok(wired.has('onStartFleetMembers'), 'onStartFleetMembers must be wired');
    assert.match(wired.get('onStartFleetMembers'), /v6Live\.startFleetMembers\(\s*names\s*\)/);
  });

  it('root-cause guard: public/v6-shell.js still reads onViewOfflineHistory/onReturnToStartCard '
    + '(if it ever stops, say so loudly rather than let the audit above pass for the wrong reason)', () => {
    assert.match(SHELL_SRC, /options\.onViewOfflineHistory/);
    assert.match(SHELL_SRC, /options\.onReturnToStartCard/);
  });
});
