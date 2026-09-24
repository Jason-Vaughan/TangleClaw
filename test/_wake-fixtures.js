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

// ── codex pane fixtures (2026-09-19 live probes, codex-cli 0.155.1) ──
// The exact bytes matter more here than anywhere else in this file. codex
// draws its run-state in a STATUS ROW whose content depends on the operator's
// `tui.status_line` order, the pane width, and whether neighbouring segments
// render at all — and the `\u00b7` separators come from the JOIN between
// segments, not from run-state itself. Hand-writing these would invent a row
// codex never draws and the guard would go green against it.

/** Composer line: empty, carrying codex's animated braille shimmer. */
const CX_COMPOSER = '\u203a\u2801Ask Codex to do anything\u2840  \u2808     \u2808 \u2802                                \u2804    \u2802';

/** `status_line = ["run-state"]` at rest. No separators: run-state is alone. */
const CX_IDLE_PANE = [
  '\u2022 PROBE_DONE',
  '  done 8:28 PM',
  CX_COMPOSER,
  '  Ready'
];
/** Same layout, turn in flight. The busy marker lives ABOVE, not in the row. */
const CX_BUSY_PANE = [
  '\u2022 Working (3s \u2022 esc to interrupt)',
  CX_COMPOSER,
  '  Working'
];
/**
 * Reasoning state. Recorded from codex's own segment help text
 * (`Compact session run-state text (Ready, Working, Thinking)`) rather than a
 * live capture — neither probe turn was long enough to render it. Marked so
 * nobody mistakes it for a measured row.
 */
const CX_THINKING_PANE = [
  CX_COMPOSER,
  '  Thinking'
];
/** run-state with a rendering neighbour after it: one joining separator. */
const CX_IDLE_WITH_NEIGHBOUR_PANE = [
  '  done 8:28 PM',
  CX_COMPOSER,
  '  Ready \u00b7 Ask for approval'
];
/**
 * The #1628 incident row: 14 configured segments, run-state sixth, truncated
 * at the pane width. The state token never renders, and the row ends U+2026.
 */
const CX_CLIPPED_PANE = [
  '  Worked for 1m 1s \u00b7 done 8:05 PM',
  CX_COMPOSER,
  '  gpt-6-astra high \u00b7 ~/Documents/Projects/TangleClaw-Architect \u00b7 TangleClaw-Architect \u00b7 docs/simplify-b\u2026'
];
/**
 * The false-idle case, and the reason this gate reads ONE row instead of the
 * tail: the pane is displaying PROSE about the marker. Whole-tail matching
 * found the literal here and reported a resting pane (ledger 5030,
 * 2026-09-19 03:29:50Z). The status row is the clipped one — no state token.
 */
const CX_TRANSCRIPT_PROSE_PANE = [
  '  The exact separator characters still need testing because TangleClaw',
  '  matches \u00b7 Ready \u00b7 literally. I will confirm before asserting recovery.',
  CX_COMPOSER,
  '  gpt-6-astra high \u00b7 ~/Documents/Projects/TangleClaw-Architect \u00b7 TangleClaw-Architect \u00b7 docs/simplify-b\u2026'
];
/** A dialog: the composer is replaced by selector rows, no status row at all. */
const CX_DIALOG_PANE = [
  '  Do you trust the contents of this directory?',
  '\u203a 1. Yes, continue',
  '  2. No, quit'
];
/** Operator mid-typing: composer holds their draft, status row still at rest. */
const CX_TYPING_PANE = [
  '\u203a reply PROBE_DONE without tools or file changes',
  '  Ready'
];

module.exports = {
  IDLE_PANE,
  BUSY_PANE,
  DIALOG_PANE,
  TYPING_PANE,
  AG_IDLE_PANE,
  AG_BUSY_PANE,
  AG_DIALOG_PANE,
  AG_TYPING_PANE,
  CX_COMPOSER,
  CX_IDLE_PANE,
  CX_BUSY_PANE,
  CX_THINKING_PANE,
  CX_IDLE_WITH_NEIGHBOUR_PANE,
  CX_CLIPPED_PANE,
  CX_TRANSCRIPT_PROSE_PANE,
  CX_DIALOG_PANE,
  CX_TYPING_PANE
};
