'use strict';

/*
 * The live-capture pane fixtures the wake gates are measured against.
 *
 * Shared rather than copied because the exact bytes are the point: the #1109
 * defect survived precisely because a hand-written fixture padded the prompt
 * with an ordinary space, which no real pane does. A second file retyping
 * these would reintroduce that gap the first time somebody's editor
 * normalised an NBSP, and the guard reading them would go green against a
 * shape production never renders.
 */

// ── Claude pane fixtures (from the 2026-07-11 live spike captures) ──

/** An idle Claude Code pane: bare prompt, no busy marker. */
const IDLE_PANE = [
  '❯ ',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
];
/** A busy Claude Code pane: bare prompt rendered, but a turn is in flight. */
const BUSY_PANE = [
  '❯ ',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents'
];
/** A permission dialog: the selector row is `❯ 1. Yes` — no BARE prompt line. */
const DIALOG_PANE = [
  '  Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently'
];
/** Operator mid-typing: prompt line is non-bare. */
const TYPING_PANE = [
  '❯ git status',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
];

// ── antigravity / Gemini-CLI pane fixtures (#560 live spike, 2026-07-14) ──
// The bare `>` prompt persists mid-turn, so idle turns on the positive
// `? for shortcuts` at-rest marker, not the prompt alone.

/** Idle antigravity pane: bare `>` between rules + the at-rest status hint. */
const AG_IDLE_PANE = [
  '  DONE: #51 — PR#56',
  '─────────────────────',
  '>',
  '─────────────────────',
  '? for shortcuts                                    Gemini 3.5 Flash (Medium)'
];
/** Busy antigravity pane: bare `>` STILL rendered, but generating + `esc to cancel`. */
const AG_BUSY_PANE = [
  '⣷  Generating...',
  '─────────────────────',
  '>',
  '─────────────────────',
  'esc to cancel                                      Gemini 3.5 Flash (Medium)'
];
/**
 * A dialog/menu analog with NO busy marker present — bare `>` still rendered,
 * but the at-rest `? for shortcuts` hint is gone. Deliberately omits
 * `esc to cancel` to isolate that the POSITIVE idle marker (not the busy gate)
 * is what refuses it — the fail-safe that covers the unverified real dialog UI.
 */
const AG_DIALOG_PANE = [
  '  Apply this change?  ● Yes   ○ No',
  '─────────────────────',
  '>',
  '─────────────────────',
  'enter to confirm · ↑↓ to select                    Gemini 3.5 Flash (Medium)'
];
/** Operator mid-typing in antigravity: prompt line is non-bare. */
const AG_TYPING_PANE = [
  '─────────────────────',
  '> what is the status',
  '─────────────────────',
  '? for shortcuts                                    Gemini 3.5 Flash (Medium)'
];

module.exports = {
  IDLE_PANE,
  BUSY_PANE,
  DIALOG_PANE,
  TYPING_PANE,
  AG_IDLE_PANE,
  AG_BUSY_PANE,
  AG_DIALOG_PANE,
  AG_TYPING_PANE
};
