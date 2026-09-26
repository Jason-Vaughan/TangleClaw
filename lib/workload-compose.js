'use strict';

/**
 * The composition of a lane's workload (#1912, ADR 0020 §4, §6, §7): pure
 * functions, no store, no clock of their own, and no pane text. Every surface
 * that shows a lane's verdict (the fleet read, `tc sessions`, `tc workload
 * show`, the dashboard) reads what these return; none re-derives it (ADR 0001).
 *
 * Three facts go in and stay separate:
 * - what the engine was observed doing (the activity observer's record);
 * - what the session asserted (its newest receipt, current or stale);
 * - lifecycle: session status, lane kind, control state, supersession events.
 *
 * Two outcomes can never happen, by construction:
 * - An observed idle engine never raises a lane to `AVAILABLE` or
 *   `safe-to-clear`. Only a current receipt that says so can, and then only
 *   with the engine observed at rest.
 * - An operator narrowing never hides `WORKING`, `HELD` or `STOPPED`, and never
 *   raises anything.
 *
 * @module lib/workload-compose
 */

/** Composed availability values (ADR 0020 §6). */
const AVAILABILITY = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  STOPPED: 'STOPPED',
  HELD: 'HELD',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  BLOCKED: 'BLOCKED',
  AVAILABLE: 'AVAILABLE',
  COMPLETE_NOT_CLEAR: 'COMPLETE_NOT_CLEAR'
});

/** How long an asserted state stays current (ADR 0020 §4, ratified FWV-A17). */
const EXPIRY_MS = Object.freeze({
  working: 30 * 60 * 1000,
  'waiting-external': 120 * 60 * 1000,
  blocked: 120 * 60 * 1000,
  complete: 120 * 60 * 1000
});

/** Control event kinds that supersede a receipt (ADR 0020 §4). */
const SUPERSEDING_CONTROL_KINDS = Object.freeze(['hold', 'release', 'stop', 'rebind', 'close']);

/**
 * Parse a stored timestamp to epoch ms. SQLite's `datetime('now')` form
 * (`YYYY-MM-DD HH:MM:SS`, UTC, no zone) is read as UTC.
 * @param {string|null} ts - Timestamp
 * @returns {number} Epoch ms, or NaN
 */
function parseTime(ts) {
  if (typeof ts !== 'string' || ts === '') return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) return Date.parse(`${ts.replace(' ', 'T')}Z`);
  return Date.parse(ts);
}

/**
 * Whether a receipt still counts (ADR 0020 §4).
 * @param {object|null} receipt - The lane's newest receipt view (`state`, `receivedAt`), or null
 * @param {object} ctx - Lifecycle facts
 * @param {boolean} ctx.sessionActive - The session's status is `active`
 * @param {boolean} ctx.launchLive - The receipt's launch is the session's live launch
 * @param {Array<{kind: string, createdAt: string}>} [ctx.controlEvents] - Control events on the lane's assignments
 * @param {number|null} [ctx.wrapStartedAtMs] - When this session's newest wrap run started, if any
 * @param {boolean} [ctx.wrapRequested] - A typed-wrap request is pending for the session
 * @param {number} ctx.nowMs - Clock
 * @returns {{current: boolean, staleReason: (string|null)}}
 */
function receiptCurrency(receipt, ctx) {
  if (!receipt) return { current: false, staleReason: null };
  if (!ctx.sessionActive) return { current: false, staleReason: 'session-ended' };
  if (!ctx.launchLive) return { current: false, staleReason: 'other-launch' };
  const at = parseTime(receipt.receivedAt);
  if (!Number.isFinite(at)) return { current: false, staleReason: 'malformed' };
  if (!(receipt.state in EXPIRY_MS)) return { current: false, staleReason: 'malformed' };
  if (ctx.wrapRequested) return { current: false, staleReason: 'wrap-requested' };
  if (Number.isFinite(ctx.wrapStartedAtMs) && ctx.wrapStartedAtMs >= at) {
    return { current: false, staleReason: 'wrap-started' };
  }
  // Control events are recorded to the second. An event in the same second as
  // the receipt is treated as after it: the order is unknowable, and the
  // fail-closed answer is that the receipt no longer counts.
  const receiptSecond = Math.floor(at / 1000) * 1000;
  for (const ev of ctx.controlEvents || []) {
    if (!SUPERSEDING_CONTROL_KINDS.includes(ev.kind)) continue;
    const evAt = parseTime(ev.createdAt);
    if (!Number.isFinite(evAt) || evAt >= receiptSecond) {
      return { current: false, staleReason: `control-${ev.kind}` };
    }
  }
  if (ctx.nowMs - at > EXPIRY_MS[receipt.state]) return { current: false, staleReason: 'expired' };
  return { current: true, staleReason: null };
}

/**
 * Cap a clearance at `do-not-clear`: `safe-to-clear` becomes `do-not-clear`;
 * `do-not-clear` and `unknown` are unchanged.
 * @param {string} clearance - Asserted clearance
 * @returns {string}
 */
function capClearance(clearance) {
  return clearance === 'safe-to-clear' ? 'do-not-clear' : clearance;
}

/**
 * The base composition (ADR 0020 §6, rules 1–11), first match wins.
 * @param {object} input - Facts
 * @param {boolean} input.sessionActive - Session status is `active`
 * @param {boolean} [input.masterLane] - A Project Master lane
 * @param {string|null} [input.controlState] - The open assignment's state (`active`, `held`, `stopped`) or null
 * @param {{activity: string}} input.engine - The observer's block
 * @param {object|null} input.receipt - The newest receipt view, or null
 * @param {boolean} input.receiptCurrent - From {@link receiptCurrency}
 * @returns {{availability: string, clearance: string, reasons: string[]}}
 */
function composeBase({ sessionActive, masterLane = false, controlState = null, engine, receipt, receiptCurrent }) {
  const busy = engine && engine.activity === 'busy';
  const r = receiptCurrent ? receipt : null;
  if (!sessionActive) return { availability: AVAILABILITY.UNKNOWN, clearance: 'unknown', reasons: ['session-not-active'] };
  if (masterLane) return { availability: AVAILABILITY.UNKNOWN, clearance: 'unknown', reasons: ['unsupported-master-lane'] };
  if (controlState === 'stopped' || controlState === 'held') {
    let clearance;
    if (busy) clearance = 'do-not-clear';
    else if (r) clearance = capClearance(r.clearance);
    else clearance = 'unknown';
    const availability = controlState === 'stopped' ? AVAILABILITY.STOPPED : AVAILABILITY.HELD;
    return { availability, clearance, reasons: [`control-${controlState}`, ...(busy ? ['engine-busy'] : [])] };
  }
  if (busy) return { availability: AVAILABILITY.WORKING, clearance: 'do-not-clear', reasons: ['engine-busy'] };
  if (!r) return { availability: AVAILABILITY.UNKNOWN, clearance: 'unknown', reasons: ['no-current-receipt'] };
  if (r.state === 'working') return { availability: AVAILABILITY.WORKING, clearance: 'do-not-clear', reasons: ['receipt-working'] };
  if (r.state === 'waiting-external') return { availability: AVAILABILITY.WAITING, clearance: r.clearance, reasons: ['receipt-waiting'] };
  if (r.state === 'blocked') return { availability: AVAILABILITY.BLOCKED, clearance: r.clearance, reasons: ['receipt-blocked'] };
  if (r.state === 'complete' && r.clearance === 'safe-to-clear' && engine && engine.activity === 'at-rest') {
    return { availability: AVAILABILITY.AVAILABLE, clearance: 'safe-to-clear', reasons: ['receipt-complete-safe', 'engine-at-rest'] };
  }
  return {
    availability: AVAILABILITY.COMPLETE_NOT_CLEAR,
    clearance: capClearance(r.clearance),
    reasons: ['receipt-complete', `engine-${engine ? engine.activity : 'unknown'}`]
  };
}

/** Availabilities an operator narrowing may turn into UNKNOWN (ADR 0020 §7). */
const NARROWABLE_TO_UNKNOWN = Object.freeze([
  AVAILABILITY.AVAILABLE, AVAILABILITY.COMPLETE_NOT_CLEAR, AVAILABILITY.WAITING, AVAILABILITY.BLOCKED
]);

/**
 * Apply an operator narrowing to a base verdict: a monotone restriction
 * applied last (ADR 0020 §7). It can cap clearance at `do-not-clear` and turn
 * AVAILABLE, COMPLETE_NOT_CLEAR, WAITING or BLOCKED into UNKNOWN. It never
 * changes WORKING, HELD, STOPPED or UNKNOWN, and never raises anything.
 * `reasons` keeps the base verdict beside the narrowed one.
 * @param {{availability: string, clearance: string, reasons: string[]}} base - From {@link composeBase}
 * @param {{capClearance: boolean, forceUnknown: boolean}|null} narrowing - The lane's active narrowing
 * @returns {{availability: string, clearance: string, reasons: string[]}}
 */
function applyNarrowing(base, narrowing) {
  if (!narrowing || (!narrowing.capClearance && !narrowing.forceUnknown)) return base;
  let { availability, clearance } = base;
  if (narrowing.forceUnknown && NARROWABLE_TO_UNKNOWN.includes(availability)) availability = AVAILABILITY.UNKNOWN;
  if (narrowing.capClearance || narrowing.forceUnknown) clearance = capClearance(clearance);
  if (availability === base.availability && clearance === base.clearance) return base;
  return {
    availability,
    clearance,
    reasons: [...base.reasons, `base:${base.availability}/${base.clearance}`, `operator-narrowed:${availability}/${clearance}`]
  };
}

/**
 * Compose one lane's full verdict.
 * @param {object} input - Everything {@link receiptCurrency}, {@link composeBase} and {@link applyNarrowing} need
 * @returns {{composed: object, workload: object}} `composed` for coordinators; `workload` is the
 *   receipt block with its provenance
 */
function composeLane(input) {
  const currency = receiptCurrency(input.receipt, input);
  const base = composeBase({ ...input, receiptCurrent: currency.current });
  const composed = applyNarrowing(base, input.narrowing || null);
  let provenance = 'none';
  if (input.receipt) provenance = currency.current ? 'explicit-receipt' : 'stale';
  const at = input.receipt ? parseTime(input.receipt.receivedAt) : NaN;
  return {
    composed,
    workload: {
      receipt: input.receipt || null,
      provenance,
      staleReason: currency.staleReason,
      ageSeconds: Number.isFinite(at) ? Math.max(0, Math.round((input.nowMs - at) / 1000)) : null
    }
  };
}

module.exports = {
  AVAILABILITY,
  EXPIRY_MS,
  SUPERSEDING_CONTROL_KINDS,
  NARROWABLE_TO_UNKNOWN,
  parseTime,
  receiptCurrency,
  capClearance,
  composeBase,
  applyNarrowing,
  composeLane
};
