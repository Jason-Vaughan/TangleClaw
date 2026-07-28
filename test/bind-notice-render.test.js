'use strict';

/*
 * #710 — the dashboard exposure chips, tested by RUNNING them.
 *
 * The other frontend guards in this chunk are source-greps, which is the repo's
 * established pattern for `landing.js` (a browser global, not require()-able).
 * That pattern has already failed this chunk twice: a grep cannot tell whether a
 * still-exposed install actually gets a chip, only whether some text exists. So
 * this file slices the renderer out and executes it against a DOM stub.
 *
 * What it protects: the operator whose machine is still open. If this renderer
 * silently no-ops, the only remaining signal is a line in a log file they are
 * not reading.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/** Slice a top-level function out of the source by brace matching. */
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} should exist in landing.js`);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/** A DOM stub exposing just what the renderer touches. */
function makeDom(ids) {
  const els = {};
  for (const id of ids) {
    els[id] = {
      textContent: '', title: '', _hidden: true,
      classList: {
        add(c) { if (c === 'hidden') els[id]._hidden = true; },
        remove(c) { if (c === 'hidden') els[id]._hidden = false; }
      }
    };
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}

function run(notice, elementId, ids) {
  const dom = makeDom(ids || ['bindNotice', 'ttydNotice']);
  const ctx = vm.createContext({ document: dom.document });
  vm.runInContext(`${extract('renderBindNotice')}\nrenderBindNotice(NOTICE, ELEMENT_ID);`
    .replace('NOTICE', JSON.stringify(notice))
    .replace('ELEMENT_ID', JSON.stringify(elementId || null)), ctx);
  return dom.els;
}

describe('renderBindNotice — the exposed operator actually sees a chip', () => {
  it('shows the notice when the install is still open', () => {
    const els = run({ message: 'reachable from your whole network', setting: 'bindAllInterfaces' });
    assert.equal(els.bindNotice._hidden, false, 'the chip must be visible');
    assert.match(els.bindNotice.textContent, /reachable from your whole network/);
    assert.match(els.bindNotice.textContent, /⚠/, 'carries a visible severity marker, not colour alone');
    assert.equal(els.bindNotice.title, 'reachable from your whole network');
  });

  it('hides it when there is nothing to report', () => {
    for (const nothing of [null, undefined]) {
      const els = run(nothing);
      assert.equal(els.bindNotice._hidden, true);
      assert.equal(els.bindNotice.textContent, '');
    }
  });

  it('ignores a malformed notice rather than rendering "undefined"', () => {
    const els = run({ setting: 'bindAllInterfaces' }); // no message
    assert.equal(els.bindNotice._hidden, true);
    assert.doesNotMatch(els.bindNotice.textContent, /undefined/);
  });

  it('routes the terminal notice to its OWN chip', () => {
    // The two exposures are independent — one can be resolved while the other is
    // still open. A shared slot would let the second hide the first.
    const els = run({ message: 'terminal still open', setting: 'ttyd interface' }, 'ttydNotice');
    assert.equal(els.ttydNotice._hidden, false);
    assert.match(els.ttydNotice.textContent, /terminal still open/);
    assert.equal(els.bindNotice._hidden, true, 'the dashboard chip must be untouched');
  });

  it('does not throw when its element is absent from the page', () => {
    // The settings modal and the session page share this script.
    assert.doesNotThrow(() => run({ message: 'x', setting: 'y' }, 'missingChip', ['bindNotice']));
  });
});

describe('the poll feeds both chips', () => {
  it('loadServerInfo renders the terminal notice as well as the bind notice', () => {
    assert.match(SRC, /renderBindNotice\(data\.bindNotice\);/);
    assert.match(SRC, /renderBindNotice\(data\.ttydNotice, 'ttydNotice'\);/,
      'a refused ttyd pin must reach the dashboard, not only the log');
  });
});
