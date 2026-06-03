'use strict';

/*
 * Frontend regression tests for #306 — the OpenClaw Version row in the
 * connection detail list (public/ui.js renderOpenclawConnections) is now
 * ALWAYS rendered, not gated behind `conn.instanceDir`.
 *
 * Before #306 the entire `Version` label+value was wrapped in
 * `${conn.instanceDir ? ... : ''}`, so a connection without an Instance Dir
 * showed no Version row at all — making the #296 version-display feature look
 * absent. Now the label is unconditional; only the *value* branches:
 *   - instanceDir set   → async-fetched `ocVer-<id>` value (current behavior)
 *   - instanceDir unset → muted "Set Instance Dir to enable" hint
 *
 * ui.js renders DOM via innerHTML strings and has many top-level deps, so
 * source-level structural assertions are the pragmatic contract lock-in —
 * the same pattern used in test/settings-modal-silentprime.test.js and
 * test/session-wrapper.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('OpenClaw connection detail — Version row always renders (#306)', () => {
  let src;
  let css;

  before(() => {
    src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  });

  it('renders the Version label unconditionally (not wrapped in a conn.instanceDir guard)', () => {
    // The label must NOT be inside `${conn.instanceDir ? <label+value> : ''}`.
    // Regression guard: the pre-#306 form gated the whole label away.
    assert.doesNotMatch(
      src,
      /\$\{conn\.instanceDir\s*\?\s*`<span class="oc-detail-label">Version<\/span>/,
      'the Version label must not be gated behind conn.instanceDir (pre-#306 bug)'
    );
    // The label is emitted before the value branch.
    assert.match(
      src,
      /<span class="oc-detail-label">Version<\/span>\$\{conn\.instanceDir/,
      'Version label should be unconditional, immediately followed by the instanceDir value branch'
    );
  });

  it('keeps the async-fetched value (ocVer-<id> + "checking…") on the instanceDir-set branch', () => {
    assert.match(src, /id="ocVer-\$\{esc\(conn\.id\)\}"/);
    assert.match(src, /checking…/);
    // The fetchable value still carries the instance .env tooltip.
    assert.match(src, /OpenClaw instance image tag \(\$\{esc\(conn\.instanceDir\)\}\/\.env\)/);
  });

  it('shows a muted, actionable hint when instanceDir is unset', () => {
    assert.match(src, /oc-detail-value oc-detail-muted/);
    assert.match(src, /Set Instance Dir to enable/);
    // The hint's tooltip tells the operator how to enable it.
    assert.match(src, /Set this connection's Instance Dir.*to read its OpenClaw image tag over SSH/);
  });

  it('still only async-fetches versions for connections with an instanceDir', () => {
    // The hint branch has no ocVer-<id> element to populate, so the fetch loop
    // must keep skipping connections without an instanceDir.
    assert.match(src, /for \(const conn of state\.openclawConnections\)\s*\{\s*\n\s*if \(!conn\.instanceDir\) continue;/);
  });

  it('defines the .oc-detail-muted style used by the hint', () => {
    assert.match(css, /\.oc-detail-value\.oc-detail-muted\s*\{[^}]*var\(--text-muted\)/);
  });
});
