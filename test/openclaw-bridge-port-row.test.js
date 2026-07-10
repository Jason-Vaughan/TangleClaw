'use strict';

/*
 * #491 (backlog OUI-4T9M) — the OpenClaw connection card's detail grid gains
 * a Bridge Port row, rendered ONLY when the connection has a bridge port set.
 *
 * Surfaced by the VRF-489-bridge-auto operator smoke test: a #490
 * auto-allocated bridge port was invisible on the card (Edit-modal-only), so
 * the operator couldn't tell whether allocation had worked. Non-ClawBridge
 * connections (bridgePort null, the #160 default) must stay clean — no row.
 *
 * ui.js renders DOM via innerHTML strings, so source-level structural
 * assertions are the contract lock-in — same pattern as
 * test/openclaw-version-row.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('OpenClaw connection card — conditional Bridge Port row (#491)', () => {
  let src;
  let sw;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    src = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  });

  it('renders a Bridge Port row gated on conn.bridgePort', () => {
    // The whole label+value pair is inside the conditional — a bridge-less
    // connection renders no row at all (not an empty value).
    assert.match(
      src,
      /\$\{conn\.bridgePort\s*\n?\s*\?\s*`<span class="oc-detail-label">Bridge Port<\/span><span class="oc-detail-value"[^`]*>\$\{conn\.bridgePort\}<\/span>`\s*\n?\s*:\s*''\}/,
      'Bridge Port label+value must render only when conn.bridgePort is set'
    );
  });

  it('places the row inside the card detail grid, after Local Port', () => {
    const grid = src.indexOf('<span class="oc-detail-label">Local Port</span>');
    const bridge = src.indexOf('<span class="oc-detail-label">Bridge Port</span>');
    const version = src.indexOf('<span class="oc-detail-label">Version</span>');
    assert.ok(grid !== -1 && bridge !== -1 && version !== -1, 'all three rows exist');
    assert.ok(grid < bridge && bridge < version,
      'Bridge Port row sits between Local Port and Version in the detail grid');
  });

  it('the row carries an explanatory tooltip', () => {
    assert.match(src, /<span class="oc-detail-value" title="ClawBridge port[^"]*">\$\{conn\.bridgePort\}/);
  });

  it('CACHE_NAME is bumped so active service workers pick up the new card', () => {
    // This test owns the exact current pin (latest bump: deprecated-methodology
    // badge in the pickers, #536 → v3-40, which edits ui.js/style.css). Older
    // generations assert "past v3-NN" — see bridge-port-input.test.js.
    assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-40';/);
  });
});
