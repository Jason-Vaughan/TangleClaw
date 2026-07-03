'use strict';

/*
 * Behavioral unit tests for the pure terminal-gesture math (UI-9J3F):
 * tcQuantizeScrollDelta (#443 touch-scroll line quantization),
 * tcCellFromPoint (#445 finger→buffer-cell mapping), and tcSelectionSpan
 * (#445 anchor swap + selection length) in public/api-helper.js.
 *
 * These were inline in the wiring closures and covered only by
 * regex-on-source assertions, which catch deletion but not an off-by-one.
 * The api-helper IIFE binds to globalThis under Node, so the real functions
 * run here directly — no DOM needed, the math is pure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('../public/api-helper.js');

const { tcQuantizeScrollDelta, tcCellFromPoint, tcSelectionSpan } = globalThis;

describe('tcQuantizeScrollDelta (#443 line quantization)', () => {
  const LINE = 18;

  it('accumulates sub-line drags without emitting a scroll', () => {
    const q = tcQuantizeScrollDelta(0, 10, LINE);
    assert.equal(q.lines, 0);
    assert.equal(q.remainder, 10);
  });

  it('emits whole lines once the running total crosses the line height', () => {
    // 10px carried + 12px this move = 22px → one 18px line, 4px carried on.
    const q = tcQuantizeScrollDelta(10, 12, LINE);
    assert.equal(q.lines, 1);
    assert.equal(q.remainder, 4);
  });

  it('a slow multi-move drag scrolls exactly once per line height (remainder round-trip)', () => {
    // Multi-hop: feed each call's remainder into the next, 6px at a time.
    // 6 moves = 36px = exactly 2 lines, never more, nothing lost.
    let accum = 0;
    let totalLines = 0;
    for (let i = 0; i < 6; i++) {
      const q = tcQuantizeScrollDelta(accum, 6, LINE);
      accum = q.remainder;
      totalLines += q.lines;
    }
    assert.equal(totalLines, 2);
    assert.equal(accum, 0);
  });

  it('scroll-up drags produce negative lines with symmetric truncation', () => {
    // Math.trunc, not floor: -22px is ONE line up (remainder -4), not two.
    const q = tcQuantizeScrollDelta(0, -22, LINE);
    assert.equal(q.lines, -1);
    assert.equal(q.remainder, -4);
  });

  it('direction reversal mid-drag cancels the carried remainder first', () => {
    // 10px down carried, then 14px up: total -4px — no scroll either way.
    const q = tcQuantizeScrollDelta(10, -14, LINE);
    assert.equal(q.lines, 0);
    assert.equal(q.remainder, -4);
  });

  it('a fast flick emits multiple lines in one call', () => {
    const q = tcQuantizeScrollDelta(0, 100, LINE);
    assert.equal(q.lines, 5);
    assert.equal(q.remainder, 10);
  });

  it('an exact multiple leaves zero remainder', () => {
    const q = tcQuantizeScrollDelta(0, 54, LINE);
    assert.equal(q.lines, 3);
    assert.equal(q.remainder, 0);
  });
});

describe('tcCellFromPoint (#445 finger→buffer-cell mapping)', () => {
  // An 80×24 grid over a 800×480 rect at (100, 50): 10px cells wide, 20px tall.
  const rect = { left: 100, top: 50, width: 800, height: 480 };
  const COLS = 80;
  const ROWS = 24;

  it('maps a mid-cell touch to the containing cell', () => {
    // 5px into col 0, 10px into row 0.
    assert.deepEqual(
      tcCellFromPoint({ clientX: 105, clientY: 60 }, rect, COLS, ROWS, 0),
      { col: 0, row: 0 }
    );
    // col 3 spans x[130,140); row 2 spans y[90,110).
    assert.deepEqual(
      tcCellFromPoint({ clientX: 135, clientY: 95 }, rect, COLS, ROWS, 0),
      { col: 3, row: 2 }
    );
  });

  it('a touch exactly on a cell boundary belongs to the next cell (floor semantics)', () => {
    assert.deepEqual(
      tcCellFromPoint({ clientX: 110, clientY: 70 }, rect, COLS, ROWS, 0),
      { col: 1, row: 1 }
    );
  });

  it('clamps touches outside the rect to the nearest edge cell', () => {
    // Left/above the terminal.
    assert.deepEqual(
      tcCellFromPoint({ clientX: 0, clientY: 0 }, rect, COLS, ROWS, 0),
      { col: 0, row: 0 }
    );
    // Right/below — clamps to the LAST cell, never cols/rows (off-buffer).
    assert.deepEqual(
      tcCellFromPoint({ clientX: 5000, clientY: 5000 }, rect, COLS, ROWS, 0),
      { col: COLS - 1, row: ROWS - 1 }
    );
  });

  it('the last pixel of the rect still maps inside the grid', () => {
    // x = left+width lands on the cols boundary — the clamp keeps it at cols-1.
    assert.deepEqual(
      tcCellFromPoint({ clientX: 900, clientY: 530 }, rect, COLS, ROWS, 0),
      { col: COLS - 1, row: ROWS - 1 }
    );
  });

  it('adds viewportY so the row is a BUFFER row, not a screen row', () => {
    // Scrolled back 100 lines: screen row 2 is buffer row 102. Col unaffected.
    assert.deepEqual(
      tcCellFromPoint({ clientX: 135, clientY: 95 }, rect, COLS, ROWS, 100),
      { col: 3, row: 102 }
    );
  });
});

describe('tcSelectionSpan (#445 anchor swap + selection length)', () => {
  const COLS = 80;

  it('a single cell selects with length 1', () => {
    assert.deepEqual(
      tcSelectionSpan({ col: 5, row: 10 }, { col: 5, row: 10 }, COLS),
      { col: 5, row: 10, length: 1 }
    );
  });

  it('a forward same-row drag is endpoint-inclusive', () => {
    assert.deepEqual(
      tcSelectionSpan({ col: 5, row: 10 }, { col: 9, row: 10 }, COLS),
      { col: 5, row: 10, length: 5 }
    );
  });

  it('a backward same-row drag swaps the anchor and selects the same span', () => {
    assert.deepEqual(
      tcSelectionSpan({ col: 9, row: 10 }, { col: 5, row: 10 }, COLS),
      { col: 5, row: 10, length: 5 }
    );
  });

  it('a multi-row drag counts intervening full rows', () => {
    // Row 10 col 78 → row 12 col 1: 2 cells (78,79) + full row 11 (80) + 2
    // cells (0,1) = 84; formula: (12-10)*80 + (1-78) + 1.
    assert.deepEqual(
      tcSelectionSpan({ col: 78, row: 10 }, { col: 1, row: 12 }, COLS),
      { col: 78, row: 10, length: 84 }
    );
  });

  it('an upward drag swaps rows so length is always positive', () => {
    assert.deepEqual(
      tcSelectionSpan({ col: 1, row: 12 }, { col: 78, row: 10 }, COLS),
      { col: 78, row: 10, length: 84 }
    );
  });

  it('same row, backward col with different rows in play — swap keys on row FIRST', () => {
    // to.row > from.row but to.col < from.col: no swap (row order wins).
    assert.deepEqual(
      tcSelectionSpan({ col: 70, row: 5 }, { col: 2, row: 6 }, COLS),
      { col: 70, row: 5, length: 13 }
    );
  });
});
