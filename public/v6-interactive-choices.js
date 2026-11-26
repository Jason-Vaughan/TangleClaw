'use strict';

/**
 * v6 (#3259, V6-003/V6-004, Car V662-W1-A): interactive numbered choices,
 * confirmation prompts, and "Chat about this" / custom-response options —
 * the canonical, standalone implementation and regression target for
 * `public/v6-shell.js`'s own in-place `extractCliGates`/`extractMultiChoice`/
 * `cliGateMarkup`/`multiChoiceMarkup`.
 *
 * NOT YET WIRED INTO THE LIVE PAGE: `public/v6-shell.js` keeps its own,
 * older copies of these four functions, called by LOCAL closure reference
 * at `waitingOnModel` (lines ~4343-4344) and the click-handler wiring at
 * `onSendChat` (lines ~9906-9919) — not through the exported
 * `global.tcV6ExtractCliGates`/`tcV6ExtractMultiChoice` globals, so an
 * outside override of those globals would never reach the live rendering
 * or sending path. Wiring this module in safely needs, outside this car's
 * file envelope: (1) a `<script>` tag for this file in `public/index.html`,
 * loaded before `v6-shell.js`; (2) replacing `v6-shell.js`'s own 4 call
 * sites to call into this module instead of its local functions; and (3)
 * `public/v6-shell.js` is this wave's exclusive file for Car V662-W1-B
 * (#3261/#3287/#3291, PR #3295) — touching it now would violate this
 * wave's 0-shared-files guarantee. A future car, once PR #3295 merges, can
 * rebase onto it, wire this module in, and delete `v6-shell.js`'s copies.
 * Until then this file exists pre-wired, same reasoning as the sibling car's
 * own `public/v6-uth-filter.js` (#3261): the dispatch's file list names it
 * and its content IS where the audited, fixed logic belongs going forward,
 * not because it does anything live yet.
 *
 * SCOPE NOTE (verified vs. flagged, not guessed): every pattern and fixture
 * below is grounded in REAL captured Claude Code TUI output already used
 * elsewhere in this repo's own test suite (`test/medusa-wake.test.js`,
 * `test/startup-dialog.test.js`, `test/v6-b1-ui-shell.test.js`, `test/
 * api-sessions.test.js`, `test/projects.test.js` — cited inline below).
 * Issue #3259's acceptance criteria ask for the SAME audit across Codex and
 * Antigravity too; this file does not extend coverage to either, because
 * this repo holds no equivalent REAL captured interactive-prompt examples
 * for them to verify against (Codex's own TUI interaction in this repo
 * goes through its `app-server` JSON-RPC protocol — `lib/startup-control-
 * codex.js` — not pane-text scraping, so it is not even established that
 * Codex presents numbered pane menus the same way at all). Extending this
 * file to those engines needs real captured examples first; inventing
 * patterns without them would be guessing, not auditing. Tracked as a
 * follow-up on #3259 rather than silently dropped or silently fabricated.
 *
 * @module public/v6-interactive-choices
 */

(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory(global);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (attachTo) {
  /**
   * Escape HTML special characters for safe interpolation into markup.
   * Mirrors `public/v6-shell.js`'s own `escapeHtml` exactly (kept local:
   * this module must not depend on that file to stay independently
   * loadable/testable, same reasoning as `public/v6-uth-filter.js`).
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------
  // CLI-level gates: folder-trust, a tool/bash permission prompt, or an
  // arrow-marked selector menu — detected in the pane's most recent raw
  // lines (nearest first), same contract as `public/v6-shell.js`'s
  // `extractCliGates` (#3105), generalized to read the REAL option text
  // present instead of assuming a fixed set.
  // ---------------------------------------------------------------------

  /** A CLI folder-trust prompt wording (#3105, confirmed against `test/startup-dialog.test.js`'s real captures). */
  const GATE_TRUST_WORDING = /trust the files in this folder|trust this folder|trust this directory|I trust this folder/i;
  /** A CLI tool/bash permission or generic confirmation prompt's own question line (#3105). */
  const GATE_PERMISSION_WORDING = /Do you want to (?:proceed|make this edit|run this command|allow)|Allow (?:once|always|this)|Run command\?|Apply changes\?/i;

  /**
   * A NUMBERED menu row: optionally `❯`/`›`/`>`/`●`-prefixed (the CURRENTLY
   * SELECTED row — real Claude Code captures show the marker can sit on
   * ANY option, not always the first; `test/startup-dialog.test.js`'s
   * `WARNING: ... Bypass Permissions` fixture marks option 1 of a "No,
   * exit" / "Yes, I accept" pair), then an explicit number (`1.`/`1)`).
   * Deliberately requires the digit — a bare arrow-marked row with no
   * number (Claude Code's own trust dialog: `❯ No, exit` / `  Yes, I
   * trust this folder`, `test/api-sessions.test.js`) is NOT a numbered
   * row, and is never swallowed into a numbered block by this pattern —
   * sending a typed digit to that dialog would not be the keystroke its
   * real TUI expects at all, so conflating the two shapes would be the
   * exact "does not have the exact same effect" bug #3259 exists to fix.
   * Group 1: the option's own number. Group 2: the label text.
   */
  const NUMBERED_MENU_ROW = /^\s*[❯›>●]?\s*(\d+)[.)]\s+(\S.*?)\s*$/;

  /** A line that closes a numbered menu block rather than being another row in it (#3259). */
  const MENU_BLOCK_STOP = /^\s*$|Enter to confirm|Esc to cancel|ctrl\+t to disable/i;

  /**
   * Starting from `anchorIndex` (a confirmed numbered row), collect every
   * CONTIGUOUS numbered row around it — both directions — so the real,
   * full option set reaches the caller instead of a hardcoded one (#3259:
   * the predecessor this module replaces returned a fixed 3-option set
   * for every `permission`/`selector` gate regardless of what the dialog
   * actually showed). Extension requires an ACTUAL digit on every row
   * added — never a bare marker or bare prose line — so a question line
   * sitting directly above the first option (no blank line between them,
   * as in the real `Do you want to proceed? / ❯ 1. Yes / 2. No...`
   * capture) is never mistaken for part of the menu.
   * @param {string[]} lines - In forward (pane) order, not reversed.
   * @param {number} anchorIndex
   * @returns {{options: Array<{key: string, label: string}>, start: number}}
   */
  function collectNumberedBlock(lines, anchorIndex) {
    const isRow = (line) => !MENU_BLOCK_STOP.test(line) && NUMBERED_MENU_ROW.test(line);
    let start = anchorIndex;
    while (start > 0 && isRow(lines[start - 1])) start--;
    let end = anchorIndex;
    while (end < lines.length - 1 && isRow(lines[end + 1])) end++;
    const options = [];
    for (let i = start; i <= end; i++) {
      const m = NUMBERED_MENU_ROW.exec(lines[i]);
      if (m) options.push({ key: m[1], label: m[2] });
    }
    return { options, start };
  }

  /**
   * The nearest non-blank line before `beforeIndex` that is not itself part
   * of the menu block or its own closing hint — the menu's own question/
   * context line, when the pane shows one immediately above it.
   * @param {string[]} lines
   * @param {number} beforeIndex
   * @returns {string|null}
   */
  function precedingContextLine(lines, beforeIndex) {
    for (let j = beforeIndex - 1; j >= 0; j--) {
      const t = String(lines[j] || '').trim();
      if (!t) continue;
      return MENU_BLOCK_STOP.test(t) ? null : t;
    }
    return null;
  }

  /**
   * Claude Code's own real folder-trust dialog has no numbered rows at all
   * — two plain, arrow-selectable lines, verified against `test/
   * api-sessions.test.js`/`test/projects.test.js`/`test/startup-dialog.
   * test.js`'s real captures: `❯ No, exit` and `Yes, I trust this folder`
   * (either order, either one marked). Matched narrowly against these
   * exact verified labels rather than a generic "un-numbered arrow row"
   * heuristic, which would risk mistaking ordinary prose for a menu with
   * no digit to anchor on. `inputMode: 'arrow'` names what the predecessor
   * got wrong: this dialog has no digit a chat-typed "1"/"2" could ever
   * match — it needs arrow-key navigation + Enter, which is a sending
   * concern for the later wiring car, not this module, but the data shape
   * says so honestly rather than implying a digit send would work.
   * @param {string[]} lines
   * @returns {{text: string, options: Array<{key: string, label: string}>}|null}
   */
  function detectTrustDialog(lines) {
    const EXIT = /No,\s*exit/i;
    const TRUST = /Yes,\s*I trust this folder/i;
    let exitIdx = -1;
    let trustIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = String(lines[i] || '').trim();
      if (exitIdx === -1 && EXIT.test(t)) exitIdx = i;
      if (trustIdx === -1 && TRUST.test(t)) trustIdx = i;
    }
    if (exitIdx === -1 || trustIdx === -1) return null;
    const first = Math.min(exitIdx, trustIdx);
    const options = exitIdx < trustIdx
      ? [{ key: 'exit', label: 'No, exit' }, { key: 'trust', label: 'Yes, I trust this folder' }]
      : [{ key: 'trust', label: 'Yes, I trust this folder' }, { key: 'exit', label: 'No, exit' }];
    const text = precedingContextLine(lines, first) || 'Accessing workspace:';
    return { text, options };
  }

  /**
   * A CLI-level gate waiting on the operator: folder-trust, a tool/bash
   * permission prompt, or a numbered selector menu, read from the pane's
   * ACTUAL recent lines rather than inferred from which cue phrase matched
   * (#3259 — see this file's own header for the real captures this was
   * audited against).
   * @param {string[]|null} lines - Recent raw pane lines, noise included, oldest-first — same convention `public/v6-shell.js` passes.
   * @returns {{kind: 'trust'|'permission'|'selector', text: string, options: Array<{key: string, label: string}>, inputMode: 'numbered'|'arrow'}|null}
   */
  function extractCliGates(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const trust = detectTrustDialog(list);
    if (trust) return { kind: 'trust', text: trust.text, options: trust.options, inputMode: 'arrow' };
    for (let i = list.length - 1; i >= 0; i--) {
      const trimmed = String(list[i] || '').trim();
      if (!trimmed) continue;
      const m = NUMBERED_MENU_ROW.exec(trimmed);
      if (/^[❯›>●]/.test(trimmed) && m) {
        const { options, start } = collectNumberedBlock(list, i);
        if (options.length === 0) continue;
        const text = precedingContextLine(list, start) || trimmed;
        const blockText = options.map((o) => o.label).join(' ');
        const kind = GATE_TRUST_WORDING.test(blockText) ? 'trust' : (GATE_PERMISSION_WORDING.test(text) ? 'permission' : 'selector');
        return { kind, text, options, inputMode: 'numbered' };
      }
      if (GATE_TRUST_WORDING.test(trimmed)) {
        // Trust wording stated in words with neither of `detectTrustDialog`'s
        // two verified option labels visible yet (a narrow capture window) —
        // a known gate, genuinely unknown real options; empty is honest here,
        // never the predecessor's guessed "y"/"n" (not what this dialog's
        // real TUI accepts at all — see `detectTrustDialog`'s own doc comment).
        return { kind: 'trust', text: trimmed, options: [], inputMode: 'arrow' };
      }
      if (GATE_PERMISSION_WORDING.test(trimmed) || /\((?:y\/n|Y\/n|y\/N|yes\/no)\)\s*$/i.test(trimmed)) {
        // A permission/confirmation question stated in words with no
        // numbered rows visible in this capture window at all (a narrow
        // capture, or a dialog answered by a single keypress with nothing
        // rendered to anchor on) — a known gate, genuinely unknown real
        // options; an empty list is honest here, never a guessed pair.
        return { kind: 'permission', text: trimmed, options: [], inputMode: 'numbered' };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // A multiple-choice question in the latest reply text (#3105/#3259).
  // ---------------------------------------------------------------------

  /** A numbered choice line: `1. Do X`, `2) Do Y` — up to 5 (#3259: widened from the predecessor's 1-4). */
  const MULTI_CHOICE_LINE = /^\s*([1-5])[.):]\s+(.+?)\s*$/;
  /** An explicit invitation to pick one of several options (#3167), for a preceding line that does not itself end in a `?`. */
  const MULTI_CHOICE_PROMPT = /\b(choose|select|pick|which option|reply with)\b/i;
  /** Headers that open a "Your ToDo" block (#3105) — a numbered ToDo list reads identically to a multi-choice prompt syntactically. */
  const TODO_HEADER = /^(?:YOUR TURN|Next steps?|Your ToDo|Action required|Operator action):\s*(.*)$/i;
  /**
   * An explicit free-form/"chat about this" invitation stated in the
   * prompt's own text, distinct from the implicit generic write-in every
   * multi-choice card already offers (#3259 — the issue's own "Chat about
   * this" / custom-response wording has no real captured precedent
   * anywhere in this repo to match against; this recognizes only the
   * prompt EXPLICITLY inviting a free-form answer, in its own words, never
   * a guessed phrasing).
   */
  const FREEFORM_INVITATION = /\b(?:or (?:type|say|chat about|describe) something else|chat about this|type your own|something else entirely)\b/i;

  /**
   * @param {(question: string) => boolean} asksQuestion - Injected (test-only in this module; `public/v6-shell.js` has its own real implementation) — this module has no opinion on what counts as a question in prose outside the explicit `MULTI_CHOICE_PROMPT`/numbered-choice shape.
   * @param {string} text
   * @returns {{question: string, choices: string[], freeform: {label: string}|null}|null}
   */
  function extractMultiChoice(text, asksQuestion) {
    const asks = typeof asksQuestion === 'function' ? asksQuestion : (q) => /\?\s*$/.test(q);
    const lines = String(text || '').split(/\r?\n/);
    const choices = [];
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MULTI_CHOICE_LINE);
      if (m && Number(m[1]) === choices.length + 1) {
        if (start === -1) start = i;
        end = i;
        choices.push(m[2].trim());
      } else if (start !== -1) {
        break;
      }
    }
    if (choices.length < 2) return null;
    const question = lines.slice(0, start).map((l) => l.trim()).filter(Boolean).pop() || '';
    if (TODO_HEADER.test(question)) return null;
    if (!asks(question) && !MULTI_CHOICE_PROMPT.test(question)) return null;
    let freeform = null;
    for (let i = end + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      const fm = FREEFORM_INVITATION.exec(t);
      if (fm) freeform = { label: t };
      break;
    }
    return { question, choices, freeform };
  }

  // ---------------------------------------------------------------------
  // Rendering: a clickable chip per real option, plus a consistent
  // "Chat about this" free-form escape hatch on EVERY card (#3259 — the
  // predecessor rendered that only for multi-choice cards, as a bare "5 /
  // Other" with no CLI-gate equivalent at all).
  // ---------------------------------------------------------------------

  /**
   * @param {ReturnType<typeof extractCliGates>} gate
   * @returns {string} HTML, or '' when there is none.
   */
  function cliGateMarkup(gate) {
    if (!gate) return '';
    const chips = (gate.options || []).map((o) => (
      `<button type="button" class="v6-chat-gate-action" data-gate-key="${escapeHtml(o.key)}" data-gate-input-mode="${escapeHtml(gate.inputMode)}">${escapeHtml(o.label)}</button>`
    )).join('');
    return `<p class="v6-chat-gate-card"><span class="v6-chat-question-text">${escapeHtml(gate.text)}</span>
      <span class="v6-chat-gate-actions">${chips}<button type="button" class="v6-chat-choice-other" data-choice-key="other">💬 Chat about this</button><button type="button" class="v6-chat-gate-hood">🔧 Under the Hood</button></span></p>`;
  }

  /**
   * @param {ReturnType<typeof extractMultiChoice>} choice
   * @returns {string} HTML, or '' when there is none.
   */
  function multiChoiceMarkup(choice) {
    if (!choice) return '';
    const chips = choice.choices.map((c, i) => (
      `<button type="button" class="v6-chat-choice-option" data-choice-key="${i + 1}" title="${escapeHtml(c)}">${i + 1}</button>`
    )).join('');
    const freeformLabel = choice.freeform ? '💬 Chat about this' : `${choice.choices.length + 1} / Other`;
    return `<p class="v6-chat-choice-card">${choice.question ? `<span class="v6-chat-question-text">${escapeHtml(choice.question)}</span>` : ''}
      <span class="v6-chat-gate-actions">${chips}<button type="button" class="v6-chat-choice-option v6-chat-choice-other" data-choice-key="other">${escapeHtml(freeformLabel)}</button></span></p>`;
  }

  const exported = {
    GATE_TRUST_WORDING, GATE_PERMISSION_WORDING, NUMBERED_MENU_ROW, MENU_BLOCK_STOP, MULTI_CHOICE_LINE,
    MULTI_CHOICE_PROMPT, TODO_HEADER, FREEFORM_INVITATION,
    extractCliGates, extractMultiChoice, cliGateMarkup, multiChoiceMarkup
  };
  if (attachTo) attachTo.tcV6InteractiveChoices = exported;
  return exported;
});
