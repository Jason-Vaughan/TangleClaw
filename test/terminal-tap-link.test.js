'use strict';

/*
 * #1572 — a URL printed in the terminal opens on a TAP.
 *
 * ttyd's bundled xterm carries the WebLinksAddon, which opens a link on a
 * plain click: the linkifier marks the link on mousemove, then a mousedown
 * and mouseup on it call activate. On a touch screen that never happens
 * inside TangleClaw, because the #445 ghost-mouse suppression swallows every
 * mouse event iOS synthesizes after a touch, and the clean tap already has an
 * owner: #574's tap-to-focus, which opens the keyboard. So the tap path
 * itself must answer "was that a URL?" from the buffer text under the
 * finger, open it inside the gesture (popup rules), and NOT focus.
 *
 * api-helper.js binds its helpers to globalThis under Node, so the real
 * functions run here against fake documents, terminals and touches.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../public/api-helper.js');
const {
  tcUrlAtColumn,
  tcLineTextAround,
  tcUrlAtCell,
  tcWireTerminalDragCopy
} = globalThis;

const HELPER = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');

describe('tcUrlAtColumn (pure): the URL span containing a column', () => {
  const line = 'see https://example.com/a/b?x=1 and http://two.test/p. done';

  it('finds the URL when the column is inside it, at its first and its last character', () => {
    const first = line.indexOf('https://');
    const hit = tcUrlAtColumn(line, first);
    assert.deepEqual(hit, { url: 'https://example.com/a/b?x=1', start: first, end: first + 'https://example.com/a/b?x=1'.length });
    assert.equal(tcUrlAtColumn(line, hit.end - 1).url, 'https://example.com/a/b?x=1');
    assert.equal(tcUrlAtColumn(line, first + 10).url, 'https://example.com/a/b?x=1');
  });

  it('returns null for a column outside every URL, and for the space between two', () => {
    assert.equal(tcUrlAtColumn(line, 0), null);
    assert.equal(tcUrlAtColumn(line, line.indexOf(' and ') + 1), null);
    assert.equal(tcUrlAtColumn(line, line.length + 5), null);
  });

  it('the character right after a URL is outside it (the span end is exclusive)', () => {
    const first = tcUrlAtColumn(line, line.indexOf('https://'));
    assert.equal(line[first.end], ' ');
    assert.equal(tcUrlAtColumn(line, first.end), null, 'the space after the first URL');
    const second = tcUrlAtColumn(line, line.indexOf('http://two'));
    assert.equal(line[second.end], '.');
    assert.equal(tcUrlAtColumn(line, second.end), null, 'the full stop after the second URL');
  });

  it('picks the second URL on a line with two, and drops a trailing full stop', () => {
    const hit = tcUrlAtColumn(line, line.indexOf('two.test') + 2);
    assert.equal(hit.url, 'http://two.test/p');
    assert.equal(line[hit.end], '.');
  });

  it('refuses non-http schemes: file, javascript, mailto, ftp', () => {
    for (const text of ['open file:///etc/passwd now', 'x javascript:alert(1) y', 'mailto:a@b.c', 'ftp://host/f']) {
      const col = text.search(/[a-z]+:/);
      assert.equal(tcUrlAtColumn(text, col + 3), null, text);
    }
  });

  it('is defensive about its inputs', () => {
    assert.equal(tcUrlAtColumn('', 0), null);
    assert.equal(tcUrlAtColumn(null, 0), null);
    assert.equal(tcUrlAtColumn('https://a.b', -1), null);
    assert.equal(tcUrlAtColumn('https://a.b', NaN), null);
  });
});

/**
 * A buffer-like object over an array of rows.
 * @param {Array<{text: string, wrapped?: boolean}>} rows
 * @returns {{getLine: Function}}
 */
function makeBuffer(rows) {
  return {
    getLine(i) {
      const r = rows[i];
      if (!r) return undefined;
      return {
        isWrapped: !!r.wrapped,
        translateToString: (trim) => (trim ? r.text.replace(/\s+$/, '') : r.text)
      };
    }
  };
}

describe('tcLineTextAround (pure): a wrapped line is one line', () => {
  it('joins the tapped row with the wrapped rows before and after it, and offsets the column', () => {
    const buf = makeBuffer([
      { text: 'unrelated line          ' },
      { text: 'go to https://example.c' },
      { text: 'om/very/long/path?q=1   ', wrapped: true },
      { text: 'next line               ' }
    ]);
    const onFirst = tcLineTextAround(buf, 1);
    assert.equal(onFirst.colOffset, 0);
    assert.equal(onFirst.text, 'go to https://example.com/very/long/path?q=1');
    const onSecond = tcLineTextAround(buf, 2);
    assert.equal(onSecond.colOffset, 'go to https://example.c'.length);
    assert.equal(onSecond.text, onFirst.text);
  });

  it('a row that is not wrapped and not continued stands alone, trimmed', () => {
    const buf = makeBuffer([{ text: 'alone   ' }, { text: 'after', wrapped: false }]);
    assert.deepEqual(tcLineTextAround(buf, 0), { text: 'alone', colOffset: 0 });
  });

  it('a missing row gives an empty line rather than a throw', () => {
    assert.deepEqual(tcLineTextAround(makeBuffer([]), 5), { text: '', colOffset: 0 });
    assert.deepEqual(tcLineTextAround(null, 0), { text: '', colOffset: 0 });
  });
});

describe('tcUrlAtCell (pure over a terminal): the URL under a buffer cell', () => {
  const term = {
    buffer: { active: makeBuffer([{ text: 'x https://a.b/c' }, { text: 'plain' }]) }
  };
  it('answers the URL for a cell inside it and null elsewhere', () => {
    assert.equal(tcUrlAtCell(term, { col: 4, row: 0 }), 'https://a.b/c');
    assert.equal(tcUrlAtCell(term, { col: 0, row: 0 }), null);
    assert.equal(tcUrlAtCell(term, { col: 2, row: 1 }), null);
  });
  it('a terminal with no buffer, or no cell, answers null', () => {
    assert.equal(tcUrlAtCell({}, { col: 0, row: 0 }), null);
    assert.equal(tcUrlAtCell(term, null), null);
  });
});

/* ── The wiring: a tap on a URL opens it and does not focus ── */

const CELL_W = 8;
const CELL_H = 16;

/**
 * A fake ttyd iframe document with listener capture and the DOM the
 * drag-copy wiring touches (style injection, the Copy pill, the screen rect).
 * @param {number} cols
 * @param {number} rows
 * @returns {object}
 */
function makeDoc(cols, rows) {
  const opens = [];
  const doc = {
    listeners: {},
    opens,
    addEventListener(type, cb) {
      (doc.listeners[type] = doc.listeners[type] || []).push(cb);
    },
    createElement: () => ({ style: {}, textContent: '', setAttribute() {}, addEventListener() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { clientWidth: cols * CELL_W },
    querySelector: (sel) => (sel === '.xterm-screen'
      ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: cols * CELL_W, height: rows * CELL_H }) }
      : null),
    defaultView: {
      open(url, target, features) { opens.push({ url, target, features }); return {}; },
      console: { debug() {} },
      MouseEvent: function MouseEvent() {},
      WheelEvent: function WheelEvent() {}
    }
  };
  return doc;
}

/**
 * A fake xterm Terminal over text rows, counting focus calls.
 * @param {string[]} rows
 * @returns {object}
 */
function makeTerm(rows) {
  const term = {
    cols: 80,
    rows: rows.length,
    options: {},
    focusCalls: 0,
    buffer: { active: Object.assign(makeBuffer(rows.map((text) => ({ text }))), { viewportY: 0 }) },
    select() {},
    getSelection: () => '',
    focus() { term.focusCalls += 1; }
  };
  return term;
}

/**
 * Wire a fresh doc/term pair and return a tap driver.
 * @param {string[]} rows - Terminal text rows.
 * @returns {{doc: object, term: object, tap: Function, fire: Function}}
 */
function wire(rows) {
  const doc = makeDoc(80, rows.length);
  const term = makeTerm(rows);
  const win = { ontouchstart: null };
  assert.equal(tcWireTerminalDragCopy(win, term, doc), true);
  const fire = (type, e) => (doc.listeners[type] || []).forEach((cb) => cb(e));
  const touch = (col, row) => ({ clientX: col * CELL_W + 2, clientY: row * CELL_H + 2 });
  const tap = (col, row) => {
    const t = touch(col, row);
    fire('touchstart', { touches: [t], target: {} });
    fire('touchend', { touches: [], changedTouches: [t] });
  };
  return { doc, term, tap, fire, touch };
}

describe('#1572 tap-to-open in tcWireTerminalDragCopy', () => {
  it('a clean tap on a URL opens it once, in a new tab with noopener, and does NOT focus the terminal', () => {
    const { doc, term, tap } = wire(['run: https://example.com/deploy?id=7 ok']);
    tap(10, 0);
    assert.deepEqual(doc.opens, [{ url: 'https://example.com/deploy?id=7', target: '_blank', features: 'noopener' }]);
    assert.equal(term.focusCalls, 0, 'a link tap must not raise the keyboard');
  });

  it('a clean tap elsewhere focuses the terminal (as #574 built) and opens nothing', () => {
    const { doc, term, tap } = wire(['run: https://example.com/deploy?id=7 ok']);
    tap(1, 0);
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 1);
  });

  it('a tap on the continuation of a wrapped URL opens the whole URL', () => {
    const doc = makeDoc(80, 2);
    const term = makeTerm(['x', 'y']);
    term.buffer.active = Object.assign(makeBuffer([
      { text: 'https://example.com/' + 'a'.repeat(60) },
      { text: 'b'.repeat(20) + '/end', wrapped: true }
    ]), { viewportY: 0 });
    assert.equal(tcWireTerminalDragCopy({ ontouchstart: null }, term, doc), true);
    const fire = (type, e) => (doc.listeners[type] || []).forEach((cb) => cb(e));
    const t = { clientX: 5 * CELL_W + 2, clientY: 1 * CELL_H + 2 };
    fire('touchstart', { touches: [t], target: {} });
    fire('touchend', { touches: [], changedTouches: [t] });
    assert.equal(doc.opens.length, 1);
    assert.equal(doc.opens[0].url, 'https://example.com/' + 'a'.repeat(60) + 'b'.repeat(20) + '/end');
    assert.equal(term.focusCalls, 0);
  });

  it('a finger that moved past the slop (a scroll) opens nothing and focuses nothing', () => {
    const { doc, term, fire, touch } = wire(['https://example.com/x']);
    const start = touch(3, 0);
    fire('touchstart', { touches: [start], target: {} });
    fire('touchmove', { touches: [{ clientX: start.clientX, clientY: start.clientY + 40 }], preventDefault() {} });
    fire('touchend', { touches: [], changedTouches: [start] });
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 0);
  });

  it('a second finger cancels the tap: nothing opens, nothing focuses', () => {
    const { doc, term, fire, touch } = wire(['https://example.com/x']);
    const a = touch(3, 0);
    fire('touchstart', { touches: [a], target: {} });
    fire('touchstart', { touches: [a, touch(10, 0)], target: {} });
    fire('touchend', { touches: [], changedTouches: [a] });
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 0);
  });

  it('a long-press (select mode) on a URL selects; lifting the finger opens nothing', async () => {
    const { doc, term, fire, touch } = wire(['https://example.com/x']);
    const a = touch(3, 0);
    fire('touchstart', { touches: [a], target: {} });
    await new Promise((r) => setTimeout(r, 520));
    assert.equal(doc.tcTouchSelectActive, true, 'select mode entered');
    fire('touchend', { touches: [], changedTouches: [a] });
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 0);
  });

  it('a tap on a non-http token focuses instead of opening', () => {
    const { doc, term, tap } = wire(['see file:///etc/hosts and javascript:alert(1)']);
    tap(8, 0);
    tap(30, 0);
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 2);
  });

  it('the terminal outliving its buffer mid-gesture is a focus, not a throw', () => {
    const { doc, term, tap } = wire(['https://example.com/x']);
    term.buffer = null;
    assert.doesNotThrow(() => tap(3, 0));
    assert.deepEqual(doc.opens, []);
    assert.equal(term.focusCalls, 1);
  });
});

describe('#1572 source pins', () => {
  const start = HELPER.indexOf('function tcWireTerminalDragCopy');
  const end = HELPER.indexOf('function tcWireTerminalFrame');
  const shim = HELPER.slice(start, end);

  it('the tap branch runs inside touchend, before term.focus(), and only on a clean tap', () => {
    const touchend = shim.slice(shim.indexOf("doc.addEventListener('touchend'"));
    const link = touchend.indexOf('tcUrlAtCell(');
    const focus = touchend.indexOf('term.focus()');
    assert.ok(link > -1 && focus > -1 && link < focus, 'the URL check precedes the focus');
    assert.ok(touchend.indexOf('tcIsFocusTap(') < link, 'the classifier gates the URL check');
  });

  it("opens with _blank and noopener from the iframe's own window, inside the gesture", () => {
    assert.match(shim, /iframeWin\.open\(url, '_blank', 'noopener'\)/);
  });

  it('the URL regex is the one ttyd\'s WebLinksAddon uses (https? only)', () => {
    assert.match(HELPER, /const TC_URL_REGEX = \/\(https\?\|HTTPS\?\):\[\/\]\{2\}/);
  });

  it('the helpers are exported', () => {
    for (const name of ['tcUrlAtColumn', 'tcLineTextAround', 'tcUrlAtCell']) {
      assert.match(HELPER, new RegExp(`global\\.${name} = ${name};`));
    }
  });
});
