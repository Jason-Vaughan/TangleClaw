'use strict';

/**
 * Chunk-boundary status surface (#2836, #1889 Slice 2).
 *
 * `lib/chunk-boundary.js`'s receipt state and `validateNextChunkDispatch`
 * verdict are not, by themselves, something a dashboard or a PM-facing
 * status line can render -- they are raw rows and typed refusals. This
 * module turns either into a plain, UI-agnostic view model: a status/label/
 * tone triple, never markup. Lives in `lib/`, not `public/` (Ruling
 * A501-W1C-R1 Amendment #2): mounting it onto the real dashboard page is
 * Slice 3 (#2888, a shared `public/index.html` hot file out of this
 * envelope), and that page is free to render this shape however it needs
 * rather than inherit markup decided before it existed. `public/` is also
 * cache-first (`scripts/cache-bump-guard.js`); a file with no route or page
 * to reach yet has no business adding to that surface prematurely.
 *
 * @module lib/chunk-boundary-ui
 */

const { STATES, HOLD_REASONS, HOLD_MEANINGS } = require('./chunk-boundary');

/** A receipt state's display label and tone, for the view model below. */
const STATE_DISPLAY = Object.freeze({
  [STATES.PREPARE_CLEAR]: { label: 'Preparing to clear', tone: 'neutral' },
  [STATES.READY_TO_CLEAR]: { label: 'Ready to clear', tone: 'info' },
  [STATES.CLEAR_INTENT_SENT]: { label: 'Clear intent sent', tone: 'info' },
  [STATES.READY_AFTER_CLEAR]: { label: 'Ready after clear', tone: 'good' }
});

/** A HOLD reason's display label, built from `HOLD_MEANINGS` so the two never drift apart. */
const HOLD_DISPLAY = Object.freeze(
  Object.fromEntries(Object.entries(HOLD_REASONS).map(([, code]) => [code, { label: HOLD_MEANINGS[code], tone: 'hold' }]))
);

/**
 * One chunk-boundary receipt's status surface.
 * @param {object|null} receipt - `getChunkBoundaryReceipt`/`getReceiptForChunk`'s view, or null
 * @returns {{status: string, label: string, tone: ('neutral'|'info'|'good'|'hold'|'none'),
 *   chunkNumber: (number|null), builder: (string|null), lane: (string|null),
 *   clearAttempts: (number|null), readyAfterClearAt: (string|null), superseded: boolean}}
 */
function receiptStatusSurface(receipt) {
  if (!receipt) {
    return {
      status: 'none', label: 'No chunk-boundary receipt yet', tone: 'none',
      chunkNumber: null, builder: null, lane: null, clearAttempts: null, readyAfterClearAt: null, superseded: false
    };
  }
  if (receipt.supersededAt) {
    return {
      status: 'superseded', label: 'Superseded', tone: 'hold',
      chunkNumber: receipt.chunkNumber, builder: receipt.builder, lane: receipt.lane,
      clearAttempts: receipt.clearAttempts, readyAfterClearAt: receipt.readyAfterClearAt, superseded: true
    };
  }
  const display = STATE_DISPLAY[receipt.state] || { label: receipt.state, tone: 'neutral' };
  return {
    status: receipt.state, label: display.label, tone: display.tone,
    chunkNumber: receipt.chunkNumber, builder: receipt.builder, lane: receipt.lane,
    clearAttempts: receipt.clearAttempts, readyAfterClearAt: receipt.readyAfterClearAt, superseded: false
  };
}

/**
 * `validateNextChunkDispatch`'s verdict, as the same status-surface shape,
 * plus the prior receipt (if any) it was judged against.
 * @param {{ok: true, receipt: object}|{ok: false, hold: true, reason: string, message: string, receipt: (object|null)}} verdict
 * @returns {{admitted: boolean, status: string, label: string, tone: string, message: (string|null), receipt: object}}
 */
function admissionStatusSurface(verdict) {
  const v = verdict || {};
  if (v.ok) {
    return { admitted: true, status: 'admitted', label: 'Next chunk admitted', tone: 'good', message: null, receipt: receiptStatusSurface(v.receipt) };
  }
  const display = HOLD_DISPLAY[v.reason] || { label: v.reason || 'hold', tone: 'hold' };
  return {
    admitted: false, status: v.reason || 'hold', label: display.label, tone: display.tone,
    message: typeof v.message === 'string' ? v.message : null, receipt: receiptStatusSurface(v.receipt)
  };
}

module.exports = { receiptStatusSurface, admissionStatusSurface };
