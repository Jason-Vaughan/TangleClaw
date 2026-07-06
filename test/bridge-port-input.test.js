'use strict';

/*
 * #489 (backlog OUI-2F8K) — Bridge-port auto-allocation UI affordance.
 *
 * The API has accepted `bridgePort:"auto"` since #352 (create) / #483
 * (idempotent update), but the connection form's Bridge Port field was
 * `type="number"` with blank=null-only semantics — no way to request auto.
 * The field is now a text input accepting blank / a port number / the
 * literal `auto`, with an Auto button that fills it in.
 *
 * Behavioral tests run the real `tcParseBridgePort` (the api-helper IIFE
 * binds to globalThis under Node — same pattern as terminal-math.test.js);
 * the DOM/wiring surface is pinned structurally (innerHTML-heavy modules,
 * same pattern as upload-modal-frontend.test.js).
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');

const { tcParseBridgePort } = globalThis;

describe('tcParseBridgePort (#489 field parsing)', () => {
  describe('blank → null (the #160 no-phantom-bind contract)', () => {
    it('empty string parses to null', () => {
      assert.deepEqual(tcParseBridgePort(''), { ok: true, value: null });
    });

    it('whitespace-only parses to null', () => {
      assert.deepEqual(tcParseBridgePort('   '), { ok: true, value: null });
    });

    it('null/undefined input parses to null (defensive)', () => {
      assert.deepEqual(tcParseBridgePort(null), { ok: true, value: null });
      assert.deepEqual(tcParseBridgePort(undefined), { ok: true, value: null });
    });
  });

  describe('the auto literal', () => {
    it('"auto" parses to the literal the API expects', () => {
      assert.deepEqual(tcParseBridgePort('auto'), { ok: true, value: 'auto' });
    });

    it('case and surrounding whitespace are normalized ("  AUTO " → "auto")', () => {
      // server.js compares `body.bridgePort === 'auto'` exactly — the
      // parser must hand it the lowercase trimmed literal.
      assert.deepEqual(tcParseBridgePort('  AUTO '), { ok: true, value: 'auto' });
      assert.deepEqual(tcParseBridgePort('Auto'), { ok: true, value: 'auto' });
    });
  });

  describe('numeric ports', () => {
    it('a port number is passed through as a number', () => {
      assert.deepEqual(tcParseBridgePort('3205'), { ok: true, value: 3205 });
    });

    it('surrounding whitespace is tolerated', () => {
      assert.deepEqual(tcParseBridgePort(' 3201 '), { ok: true, value: 3201 });
    });

    it('accepts the port-range boundaries 1 and 65535', () => {
      assert.deepEqual(tcParseBridgePort('1'), { ok: true, value: 1 });
      assert.deepEqual(tcParseBridgePort('65535'), { ok: true, value: 65535 });
    });

    it('rejects 0 and ports past 65535', () => {
      assert.equal(tcParseBridgePort('0').ok, false);
      assert.equal(tcParseBridgePort('65536').ok, false);
    });
  });

  describe('typos are rejected, never coerced to null', () => {
    // A silent null on edit would CLEAR the stored bridge port and release
    // its lease (#483) — the pre-#489 `parseInt || null` closure had
    // exactly that failure mode once the field became free text.
    for (const bad of ['31o1', '-1', '3201.5', 'auto 3201', '3201 auto', 'none']) {
      it(`rejects ${JSON.stringify(bad)} with a form error`, () => {
        const result = tcParseBridgePort(bad);
        assert.equal(result.ok, false);
        assert.ok(result.error && result.error.includes('Bridge Port'),
          'error message names the field');
      });
    }
  });
});

describe('Bridge Port form surface (#489 structural)', () => {
  let html;
  let js;
  let sw;
  let css;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  });

  describe('the field accepts free text', () => {
    it('ocBridgePort is a text input with numeric input mode', () => {
      const input = html.match(/<input[^>]*id="ocBridgePort"[^>]*>/);
      assert.ok(input, 'the Bridge Port input exists');
      assert.match(input[0], /type="text"/);
      assert.match(input[0], /inputmode="numeric"/);
    });

    it('the stray value="3201" default must not return (#160)', () => {
      // Pre-#489 the input carried a hardcoded value="3201" (inert — modal
      // open always overwrote it — but contradicting the #160 comment that
      // claimed it was a placeholder hint).
      const input = html.match(/<input[^>]*id="ocBridgePort"[^>]*>/);
      assert.ok(!/value=/.test(input[0]), 'no hardcoded value attribute');
    });
  });

  describe('the Auto button', () => {
    it('exists next to the field with an explanatory tooltip', () => {
      const btn = html.match(/<button[^>]*id="ocBridgeAutoBtn"[^>]*>/);
      assert.ok(btn, 'the Auto button exists');
      assert.match(btn[0], /type="button"/);
      assert.match(btn[0], /title="[^"]*free bridge port[^"]*"/);
    });

    it('is wired to fill the literal "auto"', () => {
      assert.match(js, /function fillBridgePortAuto\(/);
      assert.match(js, /\$\('ocBridgeAutoBtn'\)\.addEventListener\('click', fillBridgePortAuto\)/);
      assert.match(js, /input\.value = 'auto';/);
    });

    it('the row buttons keep the shared input+button layout', () => {
      // The Detect-row rule was generalized from #ocDetectBtn to .btn so the
      // Auto button gets the same nowrap/no-shrink treatment.
      assert.match(css, /\.oc-detect-row \.btn \{ white-space: nowrap; flex-shrink: 0; \}/);
    });
  });

  describe('saveConnection routes through the parser', () => {
    it('parses the field via tcParseBridgePort before building the body', () => {
      assert.match(js, /tcParseBridgePort\(document\.getElementById\('ocBridgePort'\)\.value\)/);
      assert.match(js, /bridgePort: bridgeParse\.value,/);
    });

    it('surfaces a parse failure on the form error element and aborts the save', () => {
      const idx = js.indexOf('const bridgeParse = tcParseBridgePort');
      assert.ok(idx !== -1);
      const after = js.slice(idx, idx + 400);
      assert.match(after, /if \(!bridgeParse\.ok\)/);
      assert.match(after, /ocError/);
      assert.match(after, /return;/);
    });

    it('the old parseInt-with-null-fallback closure is gone', () => {
      assert.ok(!/bridgePort: \(\(\) =>/.test(js),
        'the inline bridgePort IIFE must not return — typos must error, not clear the port');
    });
  });

  describe('propagation', () => {
    it('CACHE_NAME is bumped so active service workers pick up the new form', () => {
      // Past the pre-#489 generation; the exact current pin lives in
      // test/openclaw-bridge-port-row.test.js, which owns the latest bump (#491).
      assert.match(sw, /const CACHE_NAME = 'tangleclaw-v3-\d+';/);
      assert.ok(!/const CACHE_NAME = 'tangleclaw-v3-3[12345]';/.test(sw),
        'cache generation must be past v3-35 (the pre-#489 shell)');
    });
  });
});
