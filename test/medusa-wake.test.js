'use strict';

// Tests for lib/medusa-wake.js (MED-2K9P v2 Slice 1 chunk T2, extended by #560
// engine-aware wake) — the idle-gated wake-nudge monitor. Drives
// `_internal.tick()` deterministically with stubbed seams (no tmux, no Bridge,
// no store); `stop()` between tests clears state.
//
// The safety contract under test, in order:
//   1. a busy turn is NEVER interrupted (busy marker / no bare prompt / dialog)
//   2. the nudge carries only TC-controlled bytes (message text never injected)
//   3. one nudge per fresh-mail edge (watermark; burst = single wake)
//   4. explicit `medusaWake: true` only; listener must be `listening`
//   5. engine-aware transport/engine gates (#560): webui + engines with no
//      `ENGINE_WAKE_PROFILES` entry skipped and logged once; profiled engines
//      (claude, antigravity) each judged against their own live-probed markers

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const wake = require('../lib/medusa-wake');

/** The live-probed detection profiles the module ships (#560). */
const CLAUDE = wake.ENGINE_WAKE_PROFILES.claude;
const ANTIGRAVITY = wake.ENGINE_WAKE_PROFILES.antigravity;

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

/** A live tmux Claude session record. */
function claudeSession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId: 'claude' };
}

/** A live tmux antigravity session record. */
function antigravitySession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId: 'antigravity' };
}

/**
 * Install a full happy-path seam set on `wake._internal`; individual tests
 * override the piece they exercise. Returns the mutable world the seams read.
 */
function installWorld(overrides = {}) {
  const world = {
    sessions: [claudeSession(1)],
    project: { id: 10, name: 'proj-a', path: '/tmp/proj-a' },
    config: { medusaWake: true },
    status: { state: 'listening', workspaceId: 'proj-a-abc123', unread: 1, lastError: null },
    inbox: [{ id: 'm1', from: 'peer', message: 'hello' }],
    pane: IDLE_PANE,
    // #1103. `null` means "no cursor captured", so the prompt verdict comes from
    // `pane` alone and every pre-existing test keeps its original meaning.
    cursor: null,
    injected: [],
    injectResult: { ok: true, error: null },
    // The Master's seams (#996). `null` = no Master to scan, which keeps every
    // project-only test exactly as it was; the Master tests set a record.
    masterRecord: null,
    masterInjected: [],
    // #792's ledger. Captured rather than written to a database, so these tests
    // assert what the monitor DECIDED to record without needing a store.
    recorded: [],
    ...overrides
  };
  wake._internal.recordDelivery = (entry) => { world.recorded.push(entry); };
  wake._internal.masterWakeRecord = () => world.masterRecord;
  wake._internal.injectMaster = (command) => {
    world.masterInjected.push(command);
    return world.injectResult;
  };
  wake._internal.listLiveAll = () => world.sessions;
  wake._internal.getProject = () => world.project;
  wake._internal.loadProjectConfig = () => world.config;
  wake._internal.getStatus = () => world.status;
  wake._internal.getMessages = () => world.inbox;
  wake._internal.capturePane = () => ({ lines: world.pane });
  // Stubbed for isolation, not convenience: fixture session names collide with
  // real ones on a developer box (`tangleclaw-master` is live here), so an
  // unstubbed cursor probe reads the operator's actual pane and the verdict
  // changes with whatever they happen to have typed. `world.cursor` is null by
  // default, which exercises the text-check fallback.
  wake._internal.cursorInfo = () => world.cursor;
  wake._internal.injectCommand = (projectName, command, options) => {
    world.injected.push({ projectName, command, options });
    return world.injectResult;
  };
  return world;
}

/** Tick enough times to clear the idle debounce. */
function tickThroughDebounce() {
  for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
}

/**
 * The pane from #783, captured live at the moment a nudge was misrouted: a
 * session seven minutes into a turn, with `prawduct-critic` focused. Note what
 * is NOT here — `esc to interrupt` is absent (the turn indicator moved into the
 * agent block) and the bare prompt IS rendered, which is exactly why the old
 * policy called this idle.
 */
const SUBAGENT_FOCUSED_PANE = [
  '─────────────────────────────────── @prawduct-critic ──',
  '❯',
  '───────────────────────────────────────────────────────',
  '  710-chunk2 (feat/710-chunk2) | Opus 5 (1M context) | 72% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
  '',
  '  ◯ main',
  '  ⏺ prawduct-critic  Composing reviewer.json critic partial   7m 20s · ↓ 133.2k tokens'
];

/**
 * Live captures from 2026-08-21, taken while diagnosing #1101 across four real
 * states of one session. They are the evidence that `← N agents` is an at-rest
 * affordance rather than a fleet indicator: it is present in three of the four,
 * including both states where nothing is running, and its count never changed —
 * it read `2` with no agent dispatched, `2` with one running, and `2` after it
 * finished.
 */
const AT_REST_WITH_AGENTS_HINT = [
  '  ...which is why the wake was refused.',
  '',
  '❯ ',
  '  TiLT Claw (main) | Opus 5 (1M context) | 62% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents'
];

const AGENT_RUNNING_PANE = [
  '❯ ',
  '  TangleClaw (main) | Opus 5 (1M context) | 77% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents',
  '',
  '  ⏺ main',
  '  ◯ general-purpose  Find lib files lacking tests                    4s'
];

const AGENTS_FINISHED_PANE = [
  '❯ ',
  '  TangleClaw (main) | Opus 5 (1M context) | 77% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · /tasks to see subagents · ← 2 agents'
];

/**
 * Live captures from 2026-08-21 (#1103), escapes retained because stripping
 * them is the defect. ` ` is the NBSP a Claude Code prompt pads with, and
 * `[2m` is SGR 2 (faint) — the attribute that marks an inline suggestion.
 *
 * The two lines render almost identically in a terminal. Only the faintness and
 * the cursor column separate "the editor is offering this" from "the operator
 * typed this", and the cursor column is the one a text check cannot see.
 */
const SUGGESTION_LINE =
  '❯ [2madd case law to the reading list too, then branch and PR[0m';
const SUGGESTION_CURSOR = { x: 2, line: SUGGESTION_LINE };

const TYPED_LINE = '❯ can you check why tilt-claw isn\'t responding?';
const TYPED_CURSOR = { x: 47, line: TYPED_LINE };

/** The pane body around either line; the prompt line itself is not bare. */
const PANE_WITH_PROMPT_TEXT = [
  '  Churned for 17s',
  '',
  '❯ can you check why tilt-claw isn\'t responding?',
  '  master | Opus 5 (1M context) | 95% left',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
];

describe('medusa-wake — _composerEmpty (cursor-based input detection, #1103)', () => {
  it('reads a pending inline suggestion as an empty composer', () => {
    assert.equal(wake._composerEmpty(SUGGESTION_CURSOR, CLAUDE), true);
  });

  it('reads genuinely typed input as a non-empty composer', () => {
    assert.equal(wake._composerEmpty(TYPED_CURSOR, CLAUDE), false);
  });

  it('refuses typed text even when the cursor was moved back to the prompt column', () => {
    // Home-key case: the cursor alone would say "empty". The text to its right
    // is at normal intensity, so it is real input and must not be typed over.
    assert.equal(wake._composerEmpty({ x: 2, line: TYPED_LINE }, CLAUDE), false);
  });

  it('returns null when the cursor line carries no prompt glyph', () => {
    // A dialog or scrolled pane is undecidable here — never "empty", because
    // guessing rest is the failure this module exists to prevent.
    assert.equal(wake._composerEmpty({ x: 2, line: '  no glyph here' }, CLAUDE), null);
  });

  it('refuses rather than guesses when a transcript line happens to contain the glyph', () => {
    // Not `null`: the glyph is present, so this reads as a prompt line holding
    // text, and the verdict is the conservative one. Erring toward refusing a
    // nudge is the correct direction — the opposite error types into a pane
    // that is not at rest.
    assert.equal(wake._composerEmpty({ x: 4, line: '  ❯ some transcript text' }, CLAUDE), false);
  });

  it('returns null when no cursor was captured', () => {
    assert.equal(wake._composerEmpty(null, CLAUDE), null);
  });

  // #1109. A live Claude pane draws the empty composer as the glyph plus a
  // single NBSP separator (), with the cursor at column 2 — the first
  // input position. So anything sitting between that separator and the cursor
  // was typed, whatever character it is. Whitespace is not exempt: an operator
  // who typed a space, or typed and deleted back to one, has input in the
  // composer that a nudge would paste over.
  it('counts a typed space as input, not as an empty composer (#1109)', () => {
    //  + NBSP separator + one typed space; cursor sits to its right.
    assert.equal(wake._composerEmpty({ x: 3, line: '❯  ' }, CLAUDE), false);
  });

  it('tolerates a space-padded prompt as at-rest, so a build that renders the separator differently is still woken (#1109)', () => {
    // Fail-closed is right for typed input, but refusing EVERY pane would mean
    // silently never waking a session. One separator cell is accepted either way.
    assert.equal(wake._composerEmpty({ x: 2, line: '\u276f ' }, CLAUDE), true);
    assert.deepEqual(wake._assessPane(['\u276f '], CLAUDE, undefined), { idle: true, reason: 'at-prompt' });
  });

  it('still reads the real at-rest shape as empty (#1109 control)', () => {
    // Verbatim shape of a live empty composer: glyph + NBSP, cursor at col 2.
    assert.equal(wake._composerEmpty({ x: 2, line: '❯ ' }, CLAUDE), true);
  });

  it('refuses a whitespace-only composer through the full gate, cursor present (#1109)', () => {
    const verdict = wake._assessPane(['❯  '], CLAUDE, { x: 3, line: '❯  ' });
    assert.deepEqual(verdict, { idle: false, reason: 'no-bare-prompt' });
  });

  it('refuses a whitespace-only composer on the no-cursor fallback path (#1109)', () => {
    // The degraded path: no cursor, so the rendered line alone decides. A
    // trailing typed space must not read as a bare prompt.
    const verdict = wake._assessPane(['❯  '], CLAUDE, undefined);
    assert.deepEqual(verdict, { idle: false, reason: 'no-bare-prompt' });
  });

  it('carries faintness across an SGR reset and a specific un-faint', () => {
    // `ESC[22m` clears faint alone; `ESC[0m` and a bare `ESC[m` clear everything.
    const cells = wake._cells('[2mab[22mc[2md[me');
    assert.deepEqual(cells.map((c) => c.ch).join(''), 'abcde');
    assert.deepEqual(cells.map((c) => c.sgr.has(2)), [true, true, false, true, false]);
  });

  it('indexes cells by visible column, ignoring escape sequences', () => {
    // cursor_x counts visible columns, so the mapping must survive styling.
    const cells = wake._cells(SUGGESTION_LINE);
    assert.equal(cells[0].ch, '❯');
    assert.equal(cells[2].ch, 'a', 'column 2 is the first input position');
    assert.equal(cells[2].sgr.has(2), true);
  });

  it('ends a colour span on the default-foreground reset, not only on a full reset', () => {
    // SGR 39 restores the default foreground, which is how antigravity closes
    // its grey placeholder, and a new colour replaces the old rather than
    // stacking — without both, the first span would never end.
    const cells = wake._cells('[90mab[39mc[90md[31me');
    assert.equal(cells.map((c) => c.ch).join(''), 'abcde');
    assert.deepEqual(cells.map((c) => c.sgr.has(90)), [true, true, false, true, false]);
  });
});

/**
 * Live antigravity captures from 2026-08-21 (#1105). Written with ``
 * escapes rather than raw control bytes: the raw form is invisible in every
 * viewer, which is how the Claude-only assumption survived review in the first
 * place.
 *
 * `AG_TYPED_LINE` is the control that makes this approach safe — genuinely
 * typed antigravity input carries NO styling at all. Without that capture,
 * treating a colour as "not real input" would be a guess.
 */
const AG_PLACEHOLDER_LINE =
  '[94m>[39m [90mAccept-edits mode: file edits auto-approved (shift+tab to cycle)[39m';
const AG_TYPED_LINE = '[94m>[39m Hello there';

describe('medusa-wake — placeholder styling is declared per engine (#1105)', () => {
  const AG = wake.ENGINE_WAKE_PROFILES.antigravity;

  it('reads the antigravity grey placeholder as an empty composer', () => {
    // The regression: antigravity greys with SGR 90 while Claude dims with
    // SGR 2, so the faint-only rule refused this pane and the session, which
    // was idle, was never woken.
    assert.equal(wake._composerEmpty({ x: 2, line: AG_PLACEHOLDER_LINE }, AG), true);
  });

  it('reads genuinely typed antigravity input as a non-empty composer', () => {
    assert.equal(wake._composerEmpty({ x: 13, line: AG_TYPED_LINE }, AG), false);
  });

  it('refuses typed antigravity input with the cursor moved back to the prompt column', () => {
    assert.equal(wake._composerEmpty({ x: 2, line: AG_TYPED_LINE }, AG), false);
  });

  it('does not let either engine inherit the other\'s placeholder attribute', () => {
    // Both directions: a shared rule would pass one engine and silently fail
    // the other. Accepting the wrong attribute means treating real operator
    // input as a placeholder and typing over it.
    assert.equal(wake._composerEmpty({ x: 2, line: AG_PLACEHOLDER_LINE.replace('>', '❯') }, CLAUDE), false,
      'SGR 90 is not Claude\'s placeholder marker');
    assert.equal(wake._composerEmpty({ x: 2, line: SUGGESTION_LINE.replace('❯', '>') }, AG), false,
      'SGR 2 is not antigravity\'s placeholder marker');
    assert.deepEqual(CLAUDE.placeholderSgr, [2]);
    assert.deepEqual(AG.placeholderSgr, [90]);
  });
});

describe('medusa-wake — _assessPane with cursor (#1103)', () => {
  it('judges a pane idle when its prompt line holds only a suggestion', () => {
    // The regression. Without the cursor this same pane reads `no-bare-prompt`,
    // because the suggestion is indistinguishable from typed input once the
    // escape sequences are stripped.
    const withSuggestion = PANE_WITH_PROMPT_TEXT.slice();
    withSuggestion[2] = 'add case law to the reading list too, then branch and PR';
    assert.deepEqual(wake._assessPane(withSuggestion, CLAUDE),
      { idle: false, reason: 'no-bare-prompt' });
    assert.deepEqual(wake._assessPane(withSuggestion, CLAUDE, SUGGESTION_CURSOR),
      { idle: true, reason: 'at-prompt' });
  });

  it('still refuses a pane whose composer really holds typed input', () => {
    assert.deepEqual(wake._assessPane(PANE_WITH_PROMPT_TEXT, CLAUDE, TYPED_CURSOR),
      { idle: false, reason: 'no-bare-prompt' });
  });

  it('falls back to the text check when the cursor is unavailable', () => {
    // A failed cursor probe must not cost a nudge that the text check can judge.
    assert.deepEqual(wake._assessPane(IDLE_PANE, CLAUDE, null),
      { idle: true, reason: 'at-prompt' });
    assert.deepEqual(wake._assessPane(PANE_WITH_PROMPT_TEXT, CLAUDE, null),
      { idle: false, reason: 'no-bare-prompt' });
  });

  it('lets the busy and fleet gates win over an empty composer', () => {
    // Gate order matters: a suggestion can be pending while a turn is in
    // flight, and an empty composer is not permission to interrupt one.
    const busy = BUSY_PANE.concat(['  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
    assert.equal(wake._assessPane(busy, CLAUDE, SUGGESTION_CURSOR).reason, 'turn-in-flight');
    const fleet = ['  ⏺ main', '  ◯ general-purpose  doing a thing   4s', '❯ '];
    assert.equal(wake._assessPane(fleet, CLAUDE, SUGGESTION_CURSOR).reason, 'agents-running');
  });
});

describe('medusa-wake — _assessPane (Claude idle policy, pinned byte-for-byte)', () => {
  it('refuses a pane with a running subagent, even though it reads at-prompt (#783)', () => {
    // The regression this gate exists for. Both of the old policy's signals say
    // "safe": no busy marker, bare prompt present. The session was mid-turn.
    assert.ok(!SUBAGENT_FOCUSED_PANE.join('\n').includes('esc to interrupt'),
      'fixture precondition: the busy marker really is absent');
    assert.ok(SUBAGENT_FOCUSED_PANE.some((l) => CLAUDE.promptRe.test(l)),
      'fixture precondition: the bare prompt really is rendered');
    assert.deepEqual(wake._assessPane(SUBAGENT_FOCUSED_PANE, CLAUDE), { idle: false, reason: 'agents-running' });
  });

  it('refuses while agents run regardless of which view holds focus', () => {
    // Focus can change between the capture and the paste, so the gate is on the
    // fleet running at all, not on who is focused right now.
    const mainFocused = SUBAGENT_FOCUSED_PANE.map((l) => l.replace('@prawduct-critic', 'main'));
    assert.equal(wake._assessPane(mainFocused, CLAUDE).idle, false);
  });

  it('reads a plural fleet the same as a single agent', () => {
    const many = SUBAGENT_FOCUSED_PANE.map((l) => l.replace('← 1 agent', '← 3 agents'));
    assert.deepEqual(wake._assessPane(many, CLAUDE), { idle: false, reason: 'agents-running' });
  });

  it('does not mistake ordinary pane text for a fleet indicator', () => {
    const chatter = ['I asked 2 agents about it earlier', '❯'];
    assert.deepEqual(wake._assessPane(chatter, CLAUDE), { idle: true, reason: 'at-prompt' });
  });

  it('judges an at-rest pane idle even though the status line offers `← N agents` (#1101)', () => {
    // The bug this fixture exists for. `← N agents` is the "press ← to view
    // agents" affordance on the EMPTY-composer hint row — it renders because the
    // session is at rest, and clears the moment a character is typed. Reading it
    // as a fleet inverted the gate: idle sessions read busy and never recovered,
    // because an idle composer never fills on its own.
    assert.ok(!AT_REST_WITH_AGENTS_HINT.join('\n').includes('esc to interrupt'),
      'fixture precondition: no busy marker');
    assert.ok(!/^[ \t]*[◯⏺][ \t]+\S/m.test(AT_REST_WITH_AGENTS_HINT.join('\n')),
      'fixture precondition: no agent block is rendered');
    assert.deepEqual(wake._assessPane(AT_REST_WITH_AGENTS_HINT, CLAUDE), { idle: true, reason: 'at-prompt' });
  });

  it('judges a pane idle once its fleet has finished, while the hint persists (#1101)', () => {
    // Captured immediately after the last agent completed: the agent block has
    // cleared, but the hint row still advertises the count — and has gained
    // `/tasks to see subagents`. Nothing about either text tracks liveness.
    assert.ok(AGENTS_FINISHED_PANE.join('\n').includes('← 2 agents'),
      'fixture precondition: the hint really does persist after completion');
    assert.deepEqual(wake._assessPane(AGENTS_FINISHED_PANE, CLAUDE), { idle: true, reason: 'at-prompt' });
  });

  it('refuses a pane whose agent block is live, captured with main focused (#1101)', () => {
    // The other side of #783's capture: there the agent held focus (`◯ main` /
    // `⏺ prawduct-critic`), here main does (`⏺ main` / `◯ general-purpose`).
    // The gate must fire from either side, so it keys on the unfocused row.
    assert.ok(!AGENT_RUNNING_PANE.join('\n').includes('esc to interrupt'),
      'fixture precondition: the busy marker is absent while the agent runs');
    assert.ok(AGENT_RUNNING_PANE.some((l) => CLAUDE.promptRe.test(l)),
      'fixture precondition: a bare prompt is rendered while the agent runs');
    assert.deepEqual(wake._assessPane(AGENT_RUNNING_PANE, CLAUDE), { idle: false, reason: 'agents-running' });
  });

  it('ignores the agent glyph when it is not at the start of a line', () => {
    // The tail is 15 lines of arbitrary transcript, not a status line, so an
    // unanchored scan would let ordinary output block a nudge indefinitely.
    const quoting = ['  the other pane showed ◯ general-purpose in its block', '❯'];
    assert.deepEqual(wake._assessPane(quoting, CLAUDE), { idle: true, reason: 'at-prompt' });
  });

  it('judges a bare-prompt pane with no busy marker idle', () => {
    assert.deepEqual(wake._assessPane(IDLE_PANE, CLAUDE), { idle: true, reason: 'at-prompt' });
  });
  it('judges a turn-in-flight pane busy even though the bare prompt is rendered', () => {
    assert.deepEqual(wake._assessPane(BUSY_PANE, CLAUDE), { idle: false, reason: 'turn-in-flight' });
  });
  it('refuses a permission dialog (selector row is not a bare prompt)', () => {
    assert.deepEqual(wake._assessPane(DIALOG_PANE, CLAUDE), { idle: false, reason: 'no-bare-prompt' });
  });
  it('refuses to type over an operator\'s half-typed input', () => {
    assert.deepEqual(wake._assessPane(TYPING_PANE, CLAUDE), { idle: false, reason: 'no-bare-prompt' });
  });
  it('strips ANSI before judging (a colored busy marker still blocks)', () => {
    const colored = ['❯ ', '[2mesc to interrupt[0m'];
    assert.deepEqual(wake._assessPane(colored, CLAUDE), { idle: false, reason: 'turn-in-flight' });
  });
  it('judges an empty/unknown pane not-idle (fail closed)', () => {
    assert.equal(wake._assessPane([], CLAUDE).idle, false);
    assert.equal(wake._assessPane(['some random TUI'], CLAUDE).idle, false);
  });
});

describe('medusa-wake — _assessPane (antigravity idle policy, #560)', () => {
  it('judges a bare `>` pane with the at-rest hint idle', () => {
    assert.deepEqual(wake._assessPane(AG_IDLE_PANE, ANTIGRAVITY), { idle: true, reason: 'at-prompt' });
  });
  it('judges a generating pane busy EVEN THOUGH the bare `>` prompt persists', () => {
    // The load-bearing #560 finding: antigravity keeps `>` mid-turn, so the
    // busy marker (not the prompt) is what blocks a nudge here.
    assert.deepEqual(wake._assessPane(AG_BUSY_PANE, ANTIGRAVITY), { idle: false, reason: 'turn-in-flight' });
  });
  it('refuses a dialog/menu: bare `>` present but the at-rest hint is gone → not-at-rest', () => {
    // Fail-safe by construction — the positive `? for shortcuts` marker is
    // absent during a dialog, so an unverified dialog UI still reads non-idle.
    assert.deepEqual(wake._assessPane(AG_DIALOG_PANE, ANTIGRAVITY), { idle: false, reason: 'not-at-rest' });
  });
  it('refuses to type over half-typed antigravity input (prompt non-bare)', () => {
    assert.deepEqual(wake._assessPane(AG_TYPING_PANE, ANTIGRAVITY), { idle: false, reason: 'no-bare-prompt' });
  });
  it('a Claude-idle pane is NOT idle under the antigravity profile (markers do not cross)', () => {
    // The bug this chunk fixes, from the other direction: Claude's `❯` never
    // matches antigravity's `>` promptRe, and Claude lacks `? for shortcuts`.
    assert.equal(wake._assessPane(IDLE_PANE, ANTIGRAVITY).idle, false);
  });
});

describe('medusa-wake — nudge injection', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('nudges an opted-in, listening, idle session after the debounce — exactly once', () => {
    const world = installWorld();
    wake._internal.tick();
    assert.equal(world.injected.length, 0, 'first idle tick is debounce, not injection');
    wake._internal.tick();
    assert.equal(world.injected.length, 1, 'second consecutive idle tick injects');
    // Watermark: further ticks with the same backlog never re-nudge.
    wake._internal.tick();
    wake._internal.tick();
    assert.equal(world.injected.length, 1, 'same mail edge never re-fires');
  });

  it('the nudge is a fixed template — message content is NEVER typed into the pane', () => {
    const world = installWorld({
      inbox: [{ id: 'm1', from: 'peer', message: 'EVIL$(rm -rf ~)\nsecond line' }]
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1);
    const cmd = world.injected[0].command;
    assert.ok(!cmd.includes('EVIL'), 'inbound text must not reach the pane');
    assert.ok(!cmd.includes('\n'), 'nudge must be a single line');
    assert.match(cmd, /\[TangleClaw Switchboard\]/);
    assert.match(cmd, /GET \/api\/sessions\/proj-a\/medusa\/messages/);
    assert.match(cmd, /POST \/api\/sessions\/proj-a\/medusa\/read/);
  });

  it('URL-encodes the project name in the nudge paths', () => {
    assert.match(wake._nudgeLine('My Proj', 2), /\/api\/sessions\/My%20Proj\/medusa\/messages/);
  });

  it('watermark keys off the production row shape: inner `id` primary, envelope `messageId` honored, length fallback', () => {
    // Production rows are the Bridge's inner `message` object carrying `.id`
    // (lib/medusa-listener.js stores `frame.message`, not the envelope). A row
    // with BOTH prefers messageId; a row with NEITHER still advances via the
    // length-stamped fallback — new arrivals must always produce a new key.
    const world = installWorld({ inbox: [{ id: 'x1', from: 'p', message: 'a' }] });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'id-keyed row nudges');
    world.inbox = world.inbox.concat([{ messageId: 'env-2', id: 'x2', from: 'p', message: 'b' }]);
    world.status = { ...world.status, unread: 2 };
    tickThroughDebounce();
    assert.equal(world.injected.length, 2, 'messageId-keyed row is a fresh edge');
    world.inbox = world.inbox.concat([{ from: 'p', message: 'c' }]);
    world.status = { ...world.status, unread: 3 };
    tickThroughDebounce();
    assert.equal(world.injected.length, 3, 'id-less row still advances via length fallback');
  });

  it('a burst drains on a single wake; a NEW arrival after the nudge re-arms', () => {
    const world = installWorld({
      inbox: [
        { id: 'm1', from: 'p', message: 'a' },
        { id: 'm2', from: 'p', message: 'b' },
        { id: 'm3', from: 'p', message: 'c' }
      ],
      status: { state: 'listening', workspaceId: 'w', unread: 3, lastError: null }
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'one nudge covers the whole backlog');
    assert.match(world.injected[0].command, /3 unread/);

    // Fresh arrival → new edge → one more nudge after the debounce.
    world.inbox = world.inbox.concat([{ id: 'm4', from: 'p', message: 'd' }]);
    world.status = { ...world.status, unread: 4 };
    tickThroughDebounce();
    assert.equal(world.injected.length, 2);
  });

  it('an inbox read (unread 0) advances the watermark silently — no nudge for consumed mail', () => {
    const world = installWorld({
      status: { state: 'listening', workspaceId: 'w', unread: 0, lastError: null }
    });
    tickThroughDebounce();
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
  });

  it('a failed injection retries next tick (watermark only advances on success)', () => {
    const world = installWorld({ injectResult: { ok: false, error: 'tmux gone' } });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'attempted');
    world.injectResult = { ok: true, error: null };
    tickThroughDebounce();
    assert.equal(world.injected.length, 2, 'retried after transient failure');
    tickThroughDebounce();
    assert.equal(world.injected.length, 2, 'success advanced the watermark');
  });
});

describe('medusa-wake — nudge addresses the judged session (MED-7Q4C)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('passes the judged session id to injectCommand, not just the project name', () => {
    // The defect: idleness was judged on `session.tmuxSession` but injected via
    // `injectCommand(project.name)`, which re-resolves the active session on its
    // own. Reverting to project-name-only addressing fails this assertion.
    const world = installWorld();
    tickThroughDebounce();
    assert.equal(world.injected.length, 1);
    assert.deepEqual(world.injected[0].options, { sessionId: world.sessions[0].id });
  });

  it('addresses each session by its OWN id when one project holds two live sessions', () => {
    // The reachable-divergence case the fix exists for: two live tmux sessions
    // under one project. Each judged pane must be nudged on its own handle —
    // with project-name-only addressing both nudges would race to whichever
    // session `getActive` happens to pick.
    const a = claudeSession(1);
    const b = { ...claudeSession(2), projectId: a.projectId, tmuxSession: 'tc-2' };
    const world = installWorld({ sessions: [a, b] });
    tickThroughDebounce();
    assert.equal(world.injected.length, 2, 'both live sessions are nudged');
    assert.deepEqual(
      world.injected.map((i) => i.options.sessionId).sort(),
      [a.id, b.id].sort(),
      'each nudge carries its own session id — never one id twice'
    );
  });
});

describe('medusa-wake — gates (each one blocks alone)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('never injects while the pane shows a turn in flight', () => {
    const world = installWorld({ pane: BUSY_PANE });
    for (let i = 0; i < 5; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0);
  });

  // #1114. Claude's `busyMarker` stopped rendering on an ordinary turn, and no
  // string separates a streaming session from a resting one — mid-stream the
  // spinner is absent, the bare prompt is present, and the status rows match a
  // resting pane exactly. So liveness is read from the transcript MOVING.
  it('never nudges a pane whose transcript is still moving, even when every marker gate says idle (#1114)', () => {
    const world = installWorld();
    // Both panes pass every lexical gate: no busy marker, no fleet, bare prompt.
    const streamA = ['one hundred twenty-eight', '\u2500\u2500\u2500', '\u276f\u00a0'];
    const streamB = ['one hundred fifty-seven', '\u2500\u2500\u2500', '\u276f\u00a0'];
    assert.deepEqual(wake._assessPane(streamA, CLAUDE, undefined), { idle: true, reason: 'at-prompt' },
      'precondition: the marker gates alone judge this pane idle');
    for (let i = 0; i < 8; i++) {
      world.pane = i % 2 === 0 ? streamA : streamB;
      wake._internal.tick();
    }
    assert.equal(world.injected.length, 0, 'a writing pane is never nudged');
  });

  it('nudges once the transcript stops moving (#1114)', () => {
    const world = installWorld();
    world.pane = ['one hundred twenty-eight', '\u2500\u2500\u2500', '\u276f\u00a0'];
    wake._internal.tick();
    world.pane = ['one hundred fifty-seven', '\u2500\u2500\u2500', '\u276f\u00a0'];
    wake._internal.tick();          // still moving
    assert.equal(world.injected.length, 0);
    tickThroughDebounce();          // same content twice → at rest
    assert.equal(world.injected.length, 1, 'a settled pane is woken');
  });

  it('does not mistake a rotating suggestion or a falling context counter for liveness (#1114)', () => {
    // Both live BELOW the composer and change while the session is idle; the
    // digest excludes them deliberately, or every idle pane would look busy.
    const p = CLAUDE;
    const a = ['done', '\u2500\u2500\u2500', '\u276f\u00a0\u001b[2mtry this next\u001b[0m', '\u2500\u2500\u2500', '  proj | 95% left'];
    const b = ['done', '\u2500\u2500\u2500', '\u276f\u00a0\u001b[2msomething else\u001b[0m', '\u2500\u2500\u2500', '  proj | 90% left'];
    assert.equal(wake._paneDigest(a, p), wake._paneDigest(b, p));
  });

  it('never injects into a permission dialog', () => {
    const world = installWorld({ pane: DIALOG_PANE });
    for (let i = 0; i < 5; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0);
  });

  it('a busy interruption resets the idle debounce (no stale half-count)', () => {
    const world = installWorld();
    wake._internal.tick();          // idle tick 1
    world.pane = BUSY_PANE;
    wake._internal.tick();          // busy — resets
    world.pane = IDLE_PANE;
    wake._internal.tick();          // idle tick 1 again
    assert.equal(world.injected.length, 0, 'debounce restarted after busy');
    wake._internal.tick();          // idle tick 2 → inject
    assert.equal(world.injected.length, 1);
  });

  it('requires explicit medusaWake: true (absent/false/truthy-nonbool all skip)', () => {
    for (const config of [{}, { medusaWake: false }, { medusaWake: 'yes' }]) {
      wake.stop();
      const world = installWorld({ config });
      tickThroughDebounce();
      assert.equal(world.injected.length, 0, `config ${JSON.stringify(config)} must not wake`);
    }
  });

  it('requires a listening listener (off/error/connecting skip)', () => {
    for (const state of ['off', 'error', 'connecting']) {
      wake.stop();
      const world = installWorld({ status: { state, workspaceId: null, unread: 1, lastError: null } });
      tickThroughDebounce();
      assert.equal(world.injected.length, 0, `state ${state} must not wake`);
    }
  });

  it('a reconnect window HOLDS a pending wake — never consumes it (Critic cumulative WARNING)', () => {
    // The listener preserves inbox/unread across a reconnect. Ticks landing in
    // the connecting/error backoff window must not advance the watermark: the
    // wake fires as soon as the listener is back, with no new arrival needed.
    const world = installWorld({
      status: { state: 'connecting', workspaceId: 'w', unread: 1, lastError: null }
    });
    for (let i = 0; i < 4; i++) wake._internal.tick(); // whole window spent reconnecting
    assert.equal(world.injected.length, 0, 'no injection while not listening');
    world.status = { state: 'listening', workspaceId: 'w', unread: 1, lastError: null };
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the held wake fires after recovery — same mail, no new edge required');
  });

  it('never nudges a wrapping session', () => {
    const wrapping = { ...claudeSession(1), status: 'wrapping' };
    const world = installWorld({ sessions: [wrapping] });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
    world.sessions = [{ ...claudeSession(1), status: 'active' }];
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'same session nudges once active again');
  });

  it('skips webui sessions and unprofiled engines (#560 gate)', () => {
    // webui has no pane; codex/gemini(retired) have no live-captured profile.
    const webui = { id: 2, projectId: 20, sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:c1' };
    const codex = { id: 3, projectId: 30, sessionMode: 'tmux', tmuxSession: 'tc-3', engineId: 'codex' };
    const gemini = { id: 4, projectId: 40, sessionMode: 'tmux', tmuxSession: 'tc-4', engineId: 'gemini' };
    const world = installWorld({ sessions: [webui, codex, gemini] });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
  });

  it('nudges an idle antigravity session using its own profile (#560)', () => {
    // The bug fix, end-to-end: a profiled non-Claude engine wakes on fresh mail.
    const world = installWorld({ sessions: [antigravitySession(1)], pane: AG_IDLE_PANE });
    wake._internal.tick();
    assert.equal(world.injected.length, 0, 'first idle tick is debounce');
    wake._internal.tick();
    assert.equal(world.injected.length, 1, 'second idle tick nudges the antigravity pane');
  });

  it('never nudges a generating antigravity pane (bare `>` persists mid-turn)', () => {
    const world = installWorld({ sessions: [antigravitySession(1)], pane: AG_BUSY_PANE });
    for (let i = 0; i < 5; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0);
  });

  it('an unreadable project config is treated as opted out (fail closed)', () => {
    const world = installWorld();
    wake._internal.loadProjectConfig = () => { throw new Error('EACCES'); };
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
  });

  it('a vanished pane never crashes the tick', () => {
    const world = installWorld();
    wake._internal.capturePane = () => { throw new Error('pane gone'); };
    assert.doesNotThrow(() => tickThroughDebounce());
    assert.equal(world.injected.length, 0);
  });

  it('prunes state for ended sessions', () => {
    const world = installWorld();
    tickThroughDebounce();
    assert.equal(world.injected.length, 1);
    // Session ends, then a new session with the SAME id appears (id reuse):
    // pruning must have dropped the old watermark so fresh mail nudges again.
    world.sessions = [];
    wake._internal.tick();
    world.sessions = [claudeSession(1)];
    tickThroughDebounce();
    assert.equal(world.injected.length, 2, 'post-prune session gets its own fresh watermark');
  });
});

describe('medusa-wake — start/stop lifecycle', () => {
  it('start is idempotent and stop clears the timer', () => {
    wake.start({ intervalMs: 60000 });
    wake.start({ intervalMs: 60000 }); // no throw, no double timer
    wake.stop();
    wake.stop(); // idempotent
  });
});

describe('medusa-wake — the Project Master is scanned like any session (#996)', () => {
  afterEach(() => wake.stop());

  /** A live Master record, as `lib/master.js#masterWakeRecord` shapes it. */
  function masterRecord(overrides = {}) {
    return {
      id: 'master', isMaster: true, name: 'Project Master', tmuxSession: 'tangleclaw-master',
      engineId: 'claude', sessionMode: 'tmux', status: 'active', medusaWake: true,
      apiBase: '/api/master/medusa', ...overrides
    };
  }

  it('nudges an idle, opted-in Master through ITS injector, with the Master API paths', () => {
    const world = installWorld({ sessions: [], masterRecord: masterRecord() });
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 1, 'one nudge for the Master');
    assert.equal(world.injected.length, 0, 'never through the project injector — the Master owns no project');
    assert.match(world.masterInjected[0], /GET \/api\/master\/medusa\/messages/);
    assert.match(world.masterInjected[0], /POST \/api\/master\/medusa\/read/);
    assert.doesNotMatch(world.masterInjected[0], /\/api\/sessions\//);
    assert.doesNotMatch(world.masterInjected[0], /hello/, 'message text never rides the nudge');
  });

  it('does not nudge a Master whose medusaWake is off — the opt-in is read from the record', () => {
    const world = installWorld({ sessions: [], masterRecord: masterRecord({ medusaWake: false }) });
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 0);
  });

  it('applies the same idle gate to the Master — a busy Master pane is never typed into', () => {
    const world = installWorld({ sessions: [], masterRecord: masterRecord(), pane: BUSY_PANE });
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 0);
  });

  it('nudges once per fresh-mail edge for the Master (watermark), like a project', () => {
    const world = installWorld({ sessions: [], masterRecord: masterRecord() });
    tickThroughDebounce();
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 1);
    world.inbox = world.inbox.concat([{ id: 'm2', from: 'peer', message: 'again' }]);
    world.status = { ...world.status, unread: 1 };
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 2);
  });

  it('a Master that is absent (record null) costs the projects nothing', () => {
    const world = installWorld({ masterRecord: null });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the project still gets its nudge');
    assert.equal(world.masterInjected.length, 0);
  });

  it('a throwing Master probe is contained — the project scan still runs', () => {
    const world = installWorld();
    wake._internal.masterWakeRecord = () => { throw new Error('tmux exploded'); };
    tickThroughDebounce();
    assert.equal(world.injected.length, 1);
  });

  it('_nudgeLineFor carries only TC-controlled bytes and the given API base', () => {
    const line = wake._nudgeLineFor('/api/master/medusa', 3, 'http://localhost:3102');
    assert.match(line, /^\[TangleClaw Switchboard\] You have 3 unread/);
    assert.match(line, /GET \/api\/master\/medusa\/messages/);
    assert.ok(!line.includes('\n'), 'single line — sendKeys sends one Enter');
    // The project form is the same text with the project base substituted.
    assert.equal(
      wake._nudgeLine('My Proj', 3),
      wake._nudgeLineFor('/api/sessions/My%20Proj/medusa', 3, wake._internal.apiOrigin())
    );
  });

  it('names the reply endpoint and the initiator-closes contract (#912)', () => {
    // The receiving session did exactly what it was told and still left the
    // initiator hanging: the nudge said fetch, act, mark read — never reply, and
    // never named the send path. The reply obligation lived only in the prime,
    // read at session start and subject to compaction, while the nudge is what
    // is actually in front of the model at the moment it acts.
    const line = wake._nudgeLineFor('/api/sessions/p/medusa', 1, 'http://localhost:3102');
    assert.match(line, /POST \/api\/sessions\/p\/medusa\/send/);
    assert.match(line, /initiator closes the exchange/);
    assert.ok(!line.includes('\n'), 'still one line');
  });

  it('states the API origin outright instead of pointing at a guide (#1020)', () => {
    // "base URL + auth are in your project guide" dangled: the guide never
    // carried one, and for a plugin-governed project TangleClaw does not write
    // that guide at all — so the session could only guess the port, and the one
    // concrete base URL in its prime belongs to MEDUSA (:3009), a different
    // server.
    const line = wake._nudgeLineFor('/api/sessions/p/medusa', 1, 'http://localhost:3102');
    assert.match(line, /at http:\/\/localhost:3102/);
    assert.ok(!/project guide/.test(line), 'the dangling pointer must be gone');
  });

  it('resolves the origin from what the server actually serves', () => {
    // Not from config intent: the plist's TANGLECLAW_PORT overrides
    // config.serverPort, and caddy / no-cert installs bind plain HTTP even with
    // httpsEnabled set.
    const origin = wake._internal.apiOrigin();
    assert.match(origin, /^https?:\/\/localhost:\d+$/, `unexpected origin: ${origin}`);
  });
});

describe('medusa-wake — the delivery ledger (#792, #791)', () => {
  // `wake.stop()` clears the monitor's per-session state, including the
  // already-nudged watermark. Without it the first test's successful nudge
  // makes every later one take the "this edge is already announced" exit and
  // record nothing — the tests would be measuring leaked state, not behaviour.
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('records a nudge that landed, naming the channel', () => {
    const world = installWorld();
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'precondition: the nudge fired');
    assert.equal(world.recorded.length, 1);
    assert.deepEqual(
      { outcome: world.recorded[0].outcome, channel: world.recorded[0].channel, key: world.recorded[0].messageKey },
      { outcome: 'nudged', channel: 'tmux-inject', key: 'm1' }
    );
  });

  it('records an injection that was attempted and failed (#791)', () => {
    // The whole point: this used to be a log line and nothing else, so a broken
    // channel and a quiet peer were the same thing from anywhere outside.
    const world = installWorld({ injectResult: { ok: false, error: 'tmux session gone' } });
    tickThroughDebounce();
    assert.equal(world.recorded.length, 1);
    assert.equal(world.recorded[0].outcome, 'failed');
    assert.equal(world.recorded[0].channel, 'tmux-inject');
    assert.match(world.recorded[0].skipReason, /tmux session gone/);
  });

  it('records unread mail on a session whose wake is switched off', () => {
    // The most consequential silence: mail nothing will ever announce.
    const world = installWorld({ config: { medusaWake: false } });
    wake._internal.tick();
    assert.equal(world.injected.length, 0);
    assert.equal(world.recorded.length, 1);
    assert.equal(world.recorded[0].outcome, 'skipped');
    assert.equal(world.recorded[0].skipReason, 'wake-not-opted-in');
    assert.equal(world.recorded[0].unread, 1);
  });

  it('records a busy pane as a skip naming the pane verdict', () => {
    const world = installWorld({ pane: BUSY_PANE });
    wake._internal.tick();
    assert.equal(world.recorded.length, 1);
    assert.equal(world.recorded[0].skipReason, 'pane-turn-in-flight');
  });

  it('records a listener that is not listening, so a reconnect window is visible', () => {
    const world = installWorld({ status: { state: 'connecting', workspaceId: 'w', unread: 2, lastError: null } });
    wake._internal.tick();
    assert.equal(world.recorded.length, 1);
    assert.equal(world.recorded[0].skipReason, 'listener-connecting');
  });

  it('records nothing when the inbox is empty — an empty inbox is not a miss', () => {
    const world = installWorld({ status: { state: 'listening', workspaceId: 'w', unread: 0, lastError: null }, inbox: [] });
    tickThroughDebounce();
    assert.deepEqual(world.recorded, []);
  });

  it('records one row per (edge, outcome) rather than one per tick', () => {
    // The monitor runs on a timer. A row per tick would bury the one event that
    // matters and blow through retention within an hour.
    const world = installWorld({ config: { medusaWake: false } });
    for (let i = 0; i < 12; i++) wake._internal.tick();
    assert.equal(world.recorded.length, 1, 'twelve ticks, one fact');

    // A NEW message is a new edge, and must be recorded again.
    world.inbox = [{ id: 'm1' }, { id: 'm2' }];
    world.status = { state: 'listening', workspaceId: 'w', unread: 2, lastError: null };
    wake._internal.tick();
    assert.equal(world.recorded.length, 2);
    assert.equal(world.recorded[1].messageKey, 'm2');
  });

  it('records a changed outcome for the same edge — a channel that breaks is news', () => {
    const world = installWorld({ pane: BUSY_PANE });
    wake._internal.tick();
    assert.equal(world.recorded.length, 1);
    world.pane = IDLE_PANE;
    tickThroughDebounce();
    assert.deepEqual(world.recorded.map((r) => r.outcome), ['skipped', 'nudged']);
  });

  it('never lets a ledger failure stop the nudge', () => {
    const world = installWorld();
    wake._internal.recordDelivery = () => { throw new Error('db is locked'); };
    assert.doesNotThrow(() => tickThroughDebounce());
    assert.equal(world.injected.length, 1, 'the nudge still went out');
  });
});
