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

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

// The wake table is derived from the engine profiles the store holds (#1255),
// so it must be pointed at a throwaway one before the reads below — which run
// at file load, not in a hook.
const _store = useThrowawayStore('medusa-wake');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');

/** The live-probed detection profiles the engine profiles declare (#560). */
const CLAUDE = wake.ENGINE_WAKE_PROFILES.claude;
const ANTIGRAVITY = wake.ENGINE_WAKE_PROFILES.antigravity;

// Pane fixtures from the live spike captures, shared with the profile guard
// so the two cannot drift on the exact bytes (`test/_wake-fixtures.js`).
const {
  IDLE_PANE, BUSY_PANE, DIALOG_PANE, TYPING_PANE,
  AG_IDLE_PANE, AG_BUSY_PANE, AG_DIALOG_PANE, AG_TYPING_PANE
} = require('./_wake-fixtures');

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
    // Whether `lib/wrap-run-registry` says a wrap pipeline is running for this
    // project. False is the ordinary case.
    wrapRunning: false,
    // Whether the project is a coordinator in managed context rotation (#2032).
    rotating: false,
    // The Master's seams (#996). `null` = no Master to scan, which keeps every
    // project-only test exactly as it was; the Master tests set a record.
    masterRecord: null,
    masterInjected: [],
    // #792's ledger. Captured rather than written to a database, so these tests
    // assert what the monitor DECIDED to record without needing a store.
    recorded: [],
    // The session's launch sequence (#1633 R3). `not-applicable` with no
    // preflight reads as ready and not damaged, which keeps every
    // pre-existing test exactly as it was; the admission-gate tests below
    // override this to exercise the hold.
    launchSequence: { applicability: 'not-applicable', readyAt: null, recovery: 'none', preflight: null, recoveryClearedAt: null },
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
  // Stubbed rather than left to the real registry: the fixture project names
  // resolve there too, so an unstubbed read makes this gate inert in every test
  // instead of exercised in one.
  wake._internal.wrapRunning = () => world.wrapRunning;
  wake._internal.rotationOpen = () => world.rotating;
  wake._internal.getStatus = () => world.status;
  wake._internal.getMessages = () => world.inbox;
  wake._internal.capturePane = () => ({ lines: world.pane });
  // Stubbed for isolation, not convenience: fixture session names collide with
  // real ones on a developer box (`tangleclaw-master` is live here), so an
  // unstubbed cursor probe reads the operator's actual pane and the verdict
  // changes with whatever they happen to have typed. `world.cursor` is null by
  // default, which exercises the text-check fallback.
  wake._internal.cursorInfo = () => world.cursor;
  wake._internal.launchSequence = () => world.launchSequence;
  wake._internal.isNotApplicableDamagedHandoff = (sequence) =>
    sequence.applicability === 'not-applicable'
    && sequence.recovery === 'none'
    && !!(sequence.preflight && sequence.preflight.requiresRecovery)
    && !sequence.recoveryClearedAt;
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
    assert.deepEqual(verdict, { idle: false, reason: 'composer-has-input' });
  });

  it('refuses a whitespace-only composer on the no-cursor fallback path (#1109)', () => {
    // The degraded path: no cursor, so the rendered line alone decides. A
    // trailing typed space must not read as a bare prompt.
    const verdict = wake._assessPane(['❯  '], CLAUDE, undefined);
    assert.deepEqual(verdict, { idle: false, reason: 'no-prompt' });
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
    // The regression. Without the cursor this same pane reads `no-prompt`,
    // because the suggestion is indistinguishable from typed input once the
    // escape sequences are stripped.
    const withSuggestion = PANE_WITH_PROMPT_TEXT.slice();
    withSuggestion[2] = 'add case law to the reading list too, then branch and PR';
    assert.deepEqual(wake._assessPane(withSuggestion, CLAUDE),
      { idle: false, reason: 'no-prompt' });
    assert.deepEqual(wake._assessPane(withSuggestion, CLAUDE, SUGGESTION_CURSOR),
      { idle: true, reason: 'at-prompt' });
  });

  it('still refuses a pane whose composer really holds typed input', () => {
    assert.deepEqual(wake._assessPane(PANE_WITH_PROMPT_TEXT, CLAUDE, TYPED_CURSOR),
      { idle: false, reason: 'composer-has-input' });
  });

  it('falls back to the text check when the cursor is unavailable', () => {
    // A failed cursor probe must not cost a nudge that the text check can judge.
    assert.deepEqual(wake._assessPane(IDLE_PANE, CLAUDE, null),
      { idle: true, reason: 'at-prompt' });
    assert.deepEqual(wake._assessPane(PANE_WITH_PROMPT_TEXT, CLAUDE, null),
      { idle: false, reason: 'no-prompt' });
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
    assert.deepEqual(wake._assessPane(DIALOG_PANE, CLAUDE), { idle: false, reason: 'no-prompt' });
  });
  it('refuses to type over an operator\'s half-typed input', () => {
    assert.deepEqual(wake._assessPane(TYPING_PANE, CLAUDE), { idle: false, reason: 'no-prompt' });
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
    assert.deepEqual(wake._assessPane(AG_TYPING_PANE, ANTIGRAVITY), { idle: false, reason: 'no-prompt' });
  });
  it('a Claude-idle pane is NOT idle under the antigravity profile (markers do not cross)', () => {
    // The bug this chunk fixes, from the other direction: Claude's `❯` never
    // matches antigravity's `>` promptRe, and Claude lacks `? for shortcuts`.
    assert.equal(wake._assessPane(IDLE_PANE, ANTIGRAVITY).idle, false);
  });
});

describe('medusa-wake — _assessPane: a row that starts with the prompt glyph below the last bare prompt (#2187)', () => {
  const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
  const wakeTransports = require('../lib/wake-transports');
  const RULE = '──────────────────────────────';
  const CLAUDE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  const AG_FOOTER = '? for shortcuts                                    Gemini 3.5 Flash (Medium)';
  const CX_STATUS = '  GPT-6-Astra default · Ready · Ask for approval';
  const CX_EMPTY = '› Ask Codex to do anything';
  /** The cursor on an empty composer row, as each engine styles it. */
  const CLAUDE_EMPTY_CURSOR = { x: 2, line: '❯ ' };
  const CX_EMPTY_CURSOR = { x: 2, line: '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m' };

  /** A nudge exactly as the wake monitor pastes it. */
  const NUDGE = wakeTransports.withNonce(wake._nudgeLineFor('/api/sessions/proj-a/medusa', 1, 'http://localhost:3102'), 'a1b2c3d4e5f6');

  /**
   * Text as a composer wraps it: the glyph and one separator on the first row,
   * continuation rows indented to the text column, cut at a fixed width.
   * @param {string} glyph - The engine's prompt glyph
   * @param {string} pad - The separator the engine draws after it
   * @param {string} text - The composer's contents
   * @param {number} [width] - Text columns per row
   * @returns {{rows: string[], cursor: {x: number, line: string}}} The cursor is at the end of the last row
   */
  function composerHolding(glyph, pad, text, width = 76) {
    const chunks = [];
    for (let i = 0; i < text.length; i += width) chunks.push(text.slice(i, i + width));
    const rows = chunks.map((chunk, i) => (i === 0 ? `${glyph}${pad}${chunk}` : `  ${chunk}`));
    const last = rows[rows.length - 1];
    return { rows, cursor: { x: [...last].length, line: last } };
  }

  describe('a selector row below a stale composer is refused', () => {
    const CLAUDE_DIALOG = ['❯ ', RULE, CLAUDE_FOOTER, '', '  Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently'];
    const AG_DIALOG = [RULE, '>', RULE, AG_FOOTER, '', '  Apply this change?', '> Yes', '  No', AG_FOOTER];
    // The shape of Codex's command-approval dialog as a signed-in 0.156.1
    // session drew it on 2026-10-12, below the composer row it opened with.
    const CX_APPROVAL = [CX_EMPTY, '', '  Would you like to run the following command?', '', '  $ ls', '', '› 1. Yes, proceed (y)', '  2. Yes, and don\'t ask again for this command (a)', '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel'];

    it('with no cursor: the stale bare row no longer reads as a prompt', () => {
      assert.deepEqual(wake._assessPane(CLAUDE_DIALOG, CLAUDE, null), { idle: false, reason: 'no-prompt' });
      assert.deepEqual(wake._assessPane(AG_DIALOG, ANTIGRAVITY, null), { idle: false, reason: 'no-prompt' });
      assert.deepEqual(wake._assessPane(CX_APPROVAL, CODEX, null, true), { idle: false, reason: 'no-prompt' });
    });

    it('with the cursor on the stale row, where the cursor alone says the composer is empty', () => {
      assert.equal(wake._composerEmpty(CLAUDE_EMPTY_CURSOR, CLAUDE), true);
      assert.deepEqual(wake._assessPane(CLAUDE_DIALOG, CLAUDE, CLAUDE_EMPTY_CURSOR), { idle: false, reason: 'no-prompt' });
      assert.equal(wake._composerEmpty(CX_EMPTY_CURSOR, CODEX), true);
      assert.deepEqual(wake._assessPane(CX_APPROVAL, CODEX, CX_EMPTY_CURSOR, true), { idle: false, reason: 'no-prompt' });
    });

    it('with the cursor on a row that has no glyph, which decides nothing', () => {
      const footer = { x: 27, line: CX_APPROVAL[CX_APPROVAL.length - 1] };
      assert.equal(wake._composerEmpty(footer, CODEX), null);
      assert.deepEqual(wake._assessPane(CX_APPROVAL, CODEX, footer, true), { idle: false, reason: 'no-prompt' });
    });

    it('the same rows with the selector row gone read at-prompt, so the selector row is what refuses', () => {
      /** The pane with its selector row taken out; fails if the row is not there. */
      const without = (pane, selector) => {
        assert.ok(pane.includes(selector), selector);
        return pane.filter((row) => row !== selector);
      };
      assert.deepEqual(wake._assessPane(without(CLAUDE_DIALOG, '❯ 1. Yes'), CLAUDE, null), { idle: true, reason: 'at-prompt' });
      assert.deepEqual(wake._assessPane(without(AG_DIALOG, '> Yes'), ANTIGRAVITY, null), { idle: true, reason: 'at-prompt' });
      assert.deepEqual(wake._assessPane(without(CX_APPROVAL, '› 1. Yes, proceed (y)'), CODEX, null, true), { idle: true, reason: 'at-prompt' });
    });
  });

  describe('a usable composer is not refused', () => {
    it('a composer with only its status row below it', () => {
      assert.deepEqual(wake._assessPane(IDLE_PANE, CLAUDE, CLAUDE_EMPTY_CURSOR), { idle: true, reason: 'at-prompt' });
      assert.deepEqual(wake._assessPane(AG_IDLE_PANE, ANTIGRAVITY, null), { idle: true, reason: 'at-prompt' });
      assert.deepEqual(wake._assessPane([CX_EMPTY, '', CX_STATUS], CODEX, CX_EMPTY_CURSOR), { idle: true, reason: 'at-prompt' });
    });

    it('submitted messages drawn with the glyph ABOVE the live bare composer', () => {
      // Codex draws every submitted message as a row that starts with its
      // glyph. The live composer is the last bare row, so nothing is below it.
      const codex = [CX_EMPTY, '', '› say hi', '', '• Hi.', '', '› and again', '', '• Hi again.', '', CX_EMPTY, '', CX_STATUS];
      assert.deepEqual(wake._assessPane(codex, CODEX, null), { idle: true, reason: 'at-prompt' });
      assert.deepEqual(wake._assessPane(codex, CODEX, CX_EMPTY_CURSOR), { idle: true, reason: 'at-prompt' });
      const claude = ['❯ an earlier message', '', '⏺ Done.', '', RULE, '❯ ', RULE, CLAUDE_FOOTER];
      assert.deepEqual(wake._assessPane(claude, CLAUDE, CLAUDE_EMPTY_CURSOR), { idle: true, reason: 'at-prompt' });
      const quoted = ['> a quoted line', '>', '> another', RULE, '>', RULE, AG_FOOTER];
      assert.deepEqual(wake._assessPane(quoted, ANTIGRAVITY, null), { idle: true, reason: 'at-prompt' });
    });

    it('a pending suggestion on the only prompt row is still an empty composer', () => {
      const suggestion = { x: 2, line: '❯ \x1b[2madd case law to the reading list too\x1b[0m' };
      const pane = ['⏺ Done.', RULE, '❯ add case law to the reading list too', RULE, CLAUDE_FOOTER];
      assert.deepEqual(wake._assessPane(pane, CLAUDE, suggestion), { idle: true, reason: 'at-prompt' });
    });

    it('A DECIDED LIMIT: the same suggestion below a stale bare prompt row is held, and the nudge waits', () => {
      // The live composer is usable here, and it is refused. Its row is not
      // bare (the suggestion is drawn on it), so the stale row above is the
      // last bare prompt and the composer row is a glyph-led row below it. The
      // cursor does say the composer is empty, but it would say the same of a
      // dialog's selected option drawn dim, so the cursor alone is not let to
      // overrule the refusal. The cost is a delayed nudge, never a typed one:
      // it goes once the suggestion is gone or the stale row has left the read.
      const suggestion = { x: 2, line: '❯ \x1b[2madd case law to the reading list too\x1b[0m' };
      const live = ['⏺ Done.', RULE, '❯ add case law to the reading list too', RULE, CLAUDE_FOOTER];
      assert.equal(wake._composerEmpty(suggestion, CLAUDE), true, 'the cursor alone says empty');
      assert.deepEqual(wake._assessPane([IDLE_PANE[0], '', ...live], CLAUDE, suggestion), { idle: false, reason: 'no-prompt' });
      // Without the stale row the very same composer is at-prompt.
      assert.deepEqual(wake._assessPane(live, CLAUDE, suggestion), { idle: true, reason: 'at-prompt' });
    });
  });

  describe('the operator\'s draft below a stale bare row', () => {
    const draft = composerHolding('❯', ' ', 'half typed');
    const pane = ['❯ ', '', '⏺ Done.', RULE, ...draft.rows, RULE, CLAUDE_FOOTER];

    it('is refused, and keeps the cursor\'s own reason when the cursor is on it', () => {
      assert.deepEqual(wake._assessPane(pane, CLAUDE, draft.cursor), { idle: false, reason: 'composer-has-input' });
    });

    it('is refused as no-prompt when no cursor says whose text it is', () => {
      assert.deepEqual(wake._assessPane(pane, CLAUDE, null), { idle: false, reason: 'no-prompt' });
    });
  });

  describe('the switchboard\'s own stranded nudge below a stale bare row', () => {
    /** A bordered composer holding `text`, below a bare prompt row left in the history. */
    const claudePane = (text, below = []) => {
      const held = composerHolding('❯', ' ', text);
      return { lines: ['❯ ', '', '⏺ Done.', RULE, ...held.rows, RULE, CLAUDE_FOOTER, ...below], cursor: held.cursor };
    };
    /** The same for Antigravity, whose composer is drawn between two rules. */
    const agPane = (text, below = []) => {
      const held = composerHolding('>', ' ', text);
      return { lines: ['>', '', '  DONE', RULE, ...held.rows, RULE, AG_FOOTER, ...below], cursor: held.cursor };
    };

    it('the nudge is recognised as the monitor\'s own', () => {
      assert.equal(wake.isOwnNudge(NUDGE), true);
    });

    it('Claude Code: still safe to type into, so the next nudge can clear and replace it', () => {
      const { lines, cursor } = claudePane(NUDGE);
      assert.ok(lines.filter((row) => row.startsWith('❯')).length >= 2, 'a stale bare row and the nudge\'s row');
      assert.deepEqual(wake._assessPane(lines, CLAUDE, cursor), { idle: true, reason: 'at-prompt' });
    });

    it('Antigravity: still safe to type into, so the next nudge can clear and replace it', () => {
      const { lines, cursor } = agPane(NUDGE);
      assert.ok(lines.filter((row) => row.startsWith('>')).length >= 2, 'a stale bare row and the nudge\'s row');
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, cursor), { idle: true, reason: 'at-prompt' });
    });

    describe('Antigravity: a wrap that starts a continuation row with the glyph', () => {
      // The nudge text holds `>`. Cut there, a continuation row starts with the
      // glyph. The composer's border, not the nearest glyph, marks its first row.
      const held = composerHolding('>', ' ', NUDGE, NUDGE.indexOf('>'));
      const live = ['  DONE', RULE, ...held.rows, RULE, AG_FOOTER];
      /** The text as the reader returns it: one row per line, glyph, indent and trailing blanks removed. */
      const asRead = (rows) => rows.map((row) => row.slice(2).trimEnd()).join('\n');

      it('is the case under test', () => {
        assert.ok(held.rows.slice(1).some((row) => row.trimStart().startsWith('>')), 'a continuation row starts with the glyph');
      });

      it('the nudge is still recognised whole, stale row or none', () => {
        assert.deepEqual(wake._assessPane(live, ANTIGRAVITY, held.cursor), { idle: true, reason: 'at-prompt' });
        assert.deepEqual(wake._assessPane(['>', '', ...live], ANTIGRAVITY, held.cursor), { idle: true, reason: 'at-prompt' });
      });

      it('the prompt clear reads the same whole nudge, which is what arms its residue check', () => {
        const draft = wake.readComposerDraft(live, held.cursor, ANTIGRAVITY);
        assert.deepEqual({ state: draft.state, rows: draft.rows, complete: draft.complete }, { state: 'draft', rows: held.rows.length, complete: true });
        assert.equal(draft.text, asRead(held.rows));
        assert.equal(wake.isOwnNudge(draft.text), true);
      });

      it('an operator draft wrapped the same way is read whole and still refused', () => {
        const text = 'compare a > b please, then reply with the result';
        const typed = composerHolding('>', ' ', text, text.indexOf('>'));
        assert.ok(typed.rows.slice(1, -1).some((row) => row.trimStart().startsWith('>')), 'a continuation row above the cursor starts with the glyph');
        const pane = ['  DONE', RULE, ...typed.rows, RULE, AG_FOOTER];
        const draft = wake.readComposerDraft(pane, typed.cursor, ANTIGRAVITY);
        assert.deepEqual({ state: draft.state, complete: draft.complete, text: draft.text }, { state: 'draft', complete: true, text: asRead(typed.rows) });
        assert.deepEqual(wake._assessPane(pane, ANTIGRAVITY, typed.cursor), { idle: false, reason: 'no-prompt' });
      });
    });

    describe('where no composer border anchors the first row, the nearest glyph-led row still does', () => {
      it('no divider in the read', () => {
        const rows = ['> first', '  > second', '  tail'];
        const located = wake.locateComposer(rows, { x: 6, line: '  tail' }, ANTIGRAVITY);
        assert.deepEqual(located.rows, ['  > second', '  tail']);
      });

      it('a divider whose next row is not glyph-led', () => {
        const rows = [RULE, '  transcript', '> first', '  tail'];
        const located = wake.locateComposer(rows, { x: 6, line: '  tail' }, ANTIGRAVITY);
        assert.deepEqual(located.rows, ['> first', '  tail']);
      });

      it('a divider above with none below the cursor is not a box: Codex, a rule over a submitted message', () => {
        // Codex draws no composer border. A rule row directly above a message it
        // drew with its glyph must not make that message the composer's head.
        const rows = [RULE, '› submitted earlier', '', '• Done.', '', '› live draft', '  continues', '', CX_STATUS];
        const located = wake.locateComposer(rows, { x: 11, line: '  continues' }, CODEX);
        assert.deepEqual(located.rows.slice(0, 2), ['› live draft', '  continues']);
      });
    });

    it('a selector row outside the nudge\'s composer still refuses', () => {
      const claude = claudePane(NUDGE, ['', '  Do you want to proceed?', '❯ 1. Yes', '  2. No']);
      assert.equal(wake._assessPane(claude.lines, CLAUDE, claude.cursor).idle, false);
      const ag = agPane(NUDGE, ['', '> Yes', '  No', AG_FOOTER]);
      assert.equal(wake._assessPane(ag.lines, ANTIGRAVITY, ag.cursor).idle, false);
    });

    it('a row that starts with the glyph between the stale row and the nudge\'s composer still refuses', () => {
      const held = composerHolding('❯', ' ', NUDGE);
      const lines = ['❯ ', '', '❯ 1. Yes', '  2. No', RULE, ...held.rows, RULE, CLAUDE_FOOTER];
      assert.equal(wake._assessPane(lines, CLAUDE, held.cursor).idle, false);
    });

    it('operator text after the nudge is not the nudge alone, and is refused', () => {
      const { lines, cursor } = claudePane(`${NUDGE} and also rebase first`);
      assert.equal(wake._assessPane(lines, CLAUDE, cursor).idle, false);
    });

    it('a composer whose lower border was not seen is refused', () => {
      const held = composerHolding('❯', ' ', NUDGE);
      assert.equal(wake._assessPane(['❯ ', '', RULE, ...held.rows], CLAUDE, held.cursor).idle, false);
    });

    it('Codex: its composer draws no border, so a stranded nudge is not recognised there, stale row or none', () => {
      const held = composerHolding('›', ' ', NUDGE);
      const live = [...held.rows, '', CX_STATUS];
      assert.deepEqual(wake._assessPane(live, CODEX, held.cursor), { idle: false, reason: 'no-prompt' }, 'as before this rule: the cursor is on a continuation row');
      assert.deepEqual(wake._assessPane([CX_EMPTY, '', ...live], CODEX, held.cursor), { idle: false, reason: 'no-prompt' });
    });
  });

  describe('the switchboard\'s own stranded nudge with no stale bare row in the read (#2452)', () => {
    // With text in the composer and no older bare prompt row in the read, the
    // last-bare-row check has nothing to anchor on. What is drawn below the
    // composer still decides: a dialog's selector there is a dialog.
    const DIALOG = ['', '  Do you want to proceed?', '❯ 1. Yes', '  2. No'];

    /** A Claude pane whose bordered composer holds `text`, with no bare prompt row anywhere. */
    const claudePane = (text, above = ['⏺ Done.'], below = []) => {
      const held = composerHolding('❯', ' ', text);
      return { lines: [...above, RULE, ...held.rows, RULE, CLAUDE_FOOTER, ...below], cursor: held.cursor };
    };

    it('is the case under test: no bare prompt row in the read', () => {
      const { lines } = claudePane(NUDGE, ['⏺ Done.'], DIALOG);
      assert.ok(!lines.some((row) => CLAUDE.promptRe.test(row)), 'no bare row');
    });

    it('the issue\'s repro: a selector drawn below the nudge\'s composer is refused', () => {
      // Verbatim from the issue: the nudge cut at 76 columns, the glyph on the
      // first row and two columns of indent on the rest.
      const rows = [];
      for (let i = 0; i < NUDGE.length; i += 76) rows.push((i ? '  ' : '❯ ') + NUDGE.slice(i, i + 76));
      const pane = ['⏺ Done.', RULE, ...rows, RULE, CLAUDE_FOOTER, '', '  Do you want to proceed?', '❯ 1. Yes', '  2. No'];
      const last = rows[rows.length - 1];
      assert.deepEqual(wake._assessPane(pane, CLAUDE, { x: [...last].length, line: last }), { idle: false, reason: 'no-prompt' });
    });

    it('every profile that draws Claude\'s glyph and declares no at-rest marker refuses it', () => {
      const claudeLike = Object.entries(wake.ENGINE_WAKE_PROFILES)
        .filter(([, profile]) => profile.promptGlyph === '❯' && !profile.idleMarker);
      assert.ok(claudeLike.length >= 1, 'at least the claude profile');
      const { lines, cursor } = claudePane(NUDGE, ['⏺ Done.'], DIALOG);
      for (const [id, profile] of claudeLike) {
        assert.deepEqual(wake._assessPane(lines, profile, cursor), { idle: false, reason: 'no-prompt' }, id);
      }
    });

    it('Antigravity at rest, its marker present: a selector below the nudge\'s composer is refused', () => {
      const held = composerHolding('>', ' ', NUDGE);
      const lines = ['  DONE', RULE, ...held.rows, RULE, AG_FOOTER, '', '  Apply this change?', '> Yes', '  No', AG_FOOTER];
      assert.ok(lines.some((row) => row.includes(ANTIGRAVITY.idleMarker)), 'the at-rest marker is drawn, so no excuse is involved');
      assert.ok(!lines.some((row) => ANTIGRAVITY.promptRe.test(row)), 'no bare row');
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, held.cursor), { idle: false, reason: 'no-prompt' });
    });

    it('with only the footer below the composer it is still at-prompt, so the next nudge can replace it', () => {
      const { lines, cursor } = claudePane(NUDGE);
      assert.deepEqual(wake._assessPane(lines, CLAUDE, cursor), { idle: true, reason: 'at-prompt' });
    });

    it('a glyph-led row above the composer, in the transcript, refuses nothing', () => {
      const { lines, cursor } = claudePane(NUDGE, ['❯ 1. an earlier selector, answered', '⏺ Done.']);
      assert.deepEqual(wake._assessPane(lines, CLAUDE, cursor), { idle: true, reason: 'at-prompt' });
    });
  });
});

describe('medusa-wake — a measured Antigravity pane holding a stranded nudge (#2358)', () => {
  // MEASURED, not constructed: a read-only `tmux capture-pane -p -e -S -40` of
  // a live Antigravity session at rest, agy 1.3.6, pane 179x44 (text width 177),
  // cursor x 56 / y 39. Every row above the composer's upper border was replaced
  // with `<redacted row>` before it was written. The composer held the monitor's
  // own switchboard nudge, which the engine wrapped at WORD boundaries over four
  // rows indented by two. Each `>` in the nudge sits inside a word starting `<`
  // or `"`, so in this one configuration no continuation row starts with the
  // glyph: the hard-cut case pinned above is not what this capture shows. Whether
  // a pane narrower than such a word hard-breaks it at a `>` is unmeasured.
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const FIXTURE = path.join(__dirname, 'fixtures', 'antigravity-composer-m1-stranded-nudge.txt');
  const FIXTURE_SHA256 = '4fb32949a522bc217891616e5d7c3fcb5fea1e99f73bbaa3ea33143eb77cd0ec';
  const PANE_HEIGHT = 44;
  const CURSOR = { x: 56, y: 39 };
  const raw = fs.readFileSync(FIXTURE, 'utf8').replace(/\n$/, '').split('\n');
  // The monitor reads the pane without styling and the cursor's own row with it
  // (`tmux.capturePane` and `tmux.cursorInfo`), so the test feeds it the same way.
  const lines = raw.map((row) => row.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));
  const cursorRow = raw.length - PANE_HEIGHT + CURSOR.y;
  const cursor = { x: CURSOR.x, line: raw[cursorRow] };
  const upperBorder = lines.findLastIndex((row, i) => i < cursorRow && /^─+$/.test(row));

  it('is the redacted capture, unchanged', () => {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
    assert.ok(lines.slice(0, upperBorder).every((row) => row === '<redacted row>'), 'nothing above the composer survives');
  });

  it('(a) the composer reading recognises all four wrapped rows and the exact own nudge', () => {
    // The expected text comes from the fixture's rows, not from the reader:
    // the glyph and its separator off the first row, the two-column indent off
    // the rest, one row per line.
    const composerRows = lines.slice(upperBorder + 1, cursorRow + 1);
    assert.equal(composerRows.length, 4);
    assert.ok(composerRows.slice(1).every((row) => /^ {2}\S/.test(row) && !row.trimStart().startsWith('>')), 'indented continuations, none glyph-led');
    const expected = [composerRows[0].slice(2), ...composerRows.slice(1).map((row) => row.slice(2))].join('\n');

    const located = wake.locateComposer(lines, cursor, ANTIGRAVITY);
    assert.equal(located.located, true);
    assert.equal(located.rows[0], lines[upperBorder + 1], 'its first row is the glyph row under the upper border');
    assert.equal(located.cursorIndex, 3);

    const draft = wake.readComposerDraft(lines, cursor, ANTIGRAVITY);
    assert.deepEqual({ state: draft.state, rows: draft.rows, complete: draft.complete }, { state: 'draft', rows: 4, complete: true });
    assert.equal(draft.text, expected);
    assert.equal(wake.isOwnNudge(draft.text), true);
  });

  it('(b) the production pane gate judges it at-prompt, so the next wake clears and replaces the nudge', () => {
    // The live Antigravity path has no engine channel, so no `engineIdle` is
    // passed, and the profile's at-rest marker is on no row of this capture:
    // agy hides it while its composer holds text. The composer holds exactly
    // the monitor's own nudge, seen whole, which is the one case the missing
    // marker is excused for. The status row's queued `1 task(s)` is not a turn
    // in flight; the busy marker and an agent fleet would still refuse.
    assert.ok(!lines.some((row) => row.includes(ANTIGRAVITY.idleMarker)), 'the idle marker is absent');
    assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, cursor), { idle: true, reason: 'at-prompt' });
  });

  it('the channel\'s idle answer makes no difference to it any more', () => {
    assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, cursor, true), wake._assessPane(lines, ANTIGRAVITY, cursor));
  });
});

describe('medusa-wake — a live 167x27 Antigravity pane whose composer hides the at-rest hint (#2358)', () => {
  // MEASURED: `tmux capture-pane -p` of a live agy session (Gemini 3.8 Flash,
  // pane 167x27, not in copy-mode) on 2026-10-17, its bottom rows copied
  // verbatim from the issue. The Master's switchboard nudge sat unsubmitted in
  // the composer and agy drew no `? for shortcuts` hint, because it hides the
  // hint while its composer holds text. The monitor refused every tick as
  // `not-at-rest` until it escalated; one Enter submitted the nudge.
  //
  // The nudge's own wording gained `inReplyTo` since this was captured
  // (#1988), so the composer rows below are re-wrapped (same greedy
  // word-wrap at 167 columns the original rows measure out to) to the
  // CURRENT text rather than frozen at the 2026-10-17 bytes — what #2358
  // is actually about (agy hiding the at-rest hint while its composer holds
  // ANY text) is unaffected by the nudge's wording, but `isOwnNudge` below
  // is tied to current wording, so a frozen mismatch would wrongly fail
  // `_assessPane`'s `at-prompt` classification on an unrelated axis.
  const RULE = '─'.repeat(167);
  const CAPTURE = [
    '      • Event-driven triage of Medusa switchboard exchanges and the Operator Bridge (tc bridge), handling inbound routes and verifying/releasing session milestone',
    '      and operator-action-required candidates to Discord.',
    '      • No self-directed project lifecycle mutations (no session launches, kills, wraps, clears, config changes, or rule modifications).',
    '      • Durable state and history maintained exclusively under  (MEMORY.md and CHANGELOG.md).',
    '',
    '',
    RULE,
    '> [TangleClaw Switchboard] You have 1 unread Medusa message(s). Fetch them from the TangleClaw API at http://localhost:3102: GET /api/master/medusa/messages — act on',
    '  them as appropriate. Reply to each one that needs an answer BEFORE marking it handled: POST /api/master/medusa/send',
    '  {"to":"<sender-workspace-id>","message":"<reply>","inReplyTo":"<message-id>"}; then mark it handled: POST /api/master/medusa/read {"ids":[...]}. Both POSTs need the',
    '  headers x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID. The initiator closes the exchange, so a message you do not answer leaves them',
    '  blocked. Never use /clear as an acknowledgement. (wake ref abd48653f687)',
    RULE,
    `${' '.repeat(142)}Gemini 3.8 Flash · medium`,
  ];
  const PANE_HEIGHT = 27;
  const LINES = [...Array(PANE_HEIGHT - CAPTURE.length).fill(''), ...CAPTURE];
  const LOWER = LINES.lastIndexOf(RULE);
  const UPPER = LINES.lastIndexOf(RULE, LOWER - 1);
  /**
   * The cursor at the end of a row's text.
   * [ASSUMPTION A1] The capture did not record the cursor. After a paste agy
   * leaves it after the last character, which is where the measured 179x44
   * capture has it; this placement is an assumption, not live proof.
   * @param {string} row - The cursor's row
   * @returns {{x: number, line: string}}
   */
  const cursorAtEnd = (row) => ({ x: [...row].length, line: row });
  const CURSOR = cursorAtEnd(LINES[LOWER - 1]);
  /**
   * The capture with its composer rows replaced.
   * @param {string[]} composer - Rows between the two rules
   * @returns {{lines: string[], cursor: {x: number, line: string}}}
   */
  const holding = (composer) => ({
    lines: [...LINES.slice(0, UPPER + 1), ...composer, ...LINES.slice(LOWER)],
    cursor: cursorAtEnd(composer[composer.length - 1])
  });

  it('is the shape the issue reports: no at-rest hint, no busy marker, the own nudge whole between two rules', () => {
    assert.equal(LINES.length, PANE_HEIGHT);
    assert.ok(!LINES.some((row) => row.includes(ANTIGRAVITY.idleMarker)), 'the idle marker is absent');
    assert.ok(!LINES.some((row) => row.includes(ANTIGRAVITY.busyMarker)), 'the busy marker is absent');
    assert.equal(LOWER - UPPER - 1, 5, 'five composer rows');
    const draft = wake.readComposerDraft(LINES, CURSOR, ANTIGRAVITY);
    assert.deepEqual({ state: draft.state, rows: draft.rows, complete: draft.complete }, { state: 'draft', rows: 5, complete: true });
    assert.equal(wake.isOwnNudge(draft.text), true);
  });

  it('is judged at-prompt, so the next wake clears and replaces the nudge', () => {
    assert.deepEqual(wake._assessPane(LINES, ANTIGRAVITY, CURSOR), { idle: true, reason: 'at-prompt' });
  });

  describe('every other refusal still holds', () => {
    it('the busy marker', () => {
      const lines = [...LINES.slice(0, -1), `esc to cancel${LINES[LINES.length - 1].slice(13)}`];
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'turn-in-flight' });
    });

    it('a running agent fleet', () => {
      const lines = [...LINES.slice(1, UPPER - 1), '  ◯ builder  Working', ...LINES.slice(UPPER - 1)];
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'agents-running' });
    });

    it('the nudge with operator text after it', () => {
      const composer = LINES.slice(UPPER + 1, LOWER);
      composer[composer.length - 1] += ' and also rebase first';
      const { lines, cursor } = holding(composer);
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, cursor), { idle: false, reason: 'not-at-rest' });
    });

    it('a draft that is not the nudge', () => {
      const { lines, cursor } = holding(['> please look at the failing test before you reply']);
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, cursor), { idle: false, reason: 'not-at-rest' });
    });

    it('a composer whose lower border was not seen', () => {
      const lines = ['', '', ...LINES.slice(0, LOWER)];
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'not-at-rest' });
    });

    it('a selector row drawn below the composer', () => {
      const lines = [...LINES.slice(3), '', '> Yes', '  No'];
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'not-at-rest' });
    });

    it('a dialog drawn above the composer, its key help in the status row\'s hint slot', () => {
      // The recorded dialog analog's own rows around the nudge's composer: no
      // row below the composer is glyph-led, and none says `esc to cancel`.
      const [question, , , , keyHelp] = AG_DIALOG_PANE;
      const lines = ['', question, ...LINES.slice(UPPER, -1), keyHelp];
      const below = lines.slice(lines.lastIndexOf(RULE));
      assert.equal(below.length, 2, 'the lower border and the status row');
      assert.ok(!below.some((row) => row.trimStart().startsWith('>')), 'nothing glyph-led below the composer');
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'not-at-rest' });
    });

    it('any text in the status row\'s hint slot, whatever it says', () => {
      const status = LINES[LINES.length - 1];
      const lines = [...LINES.slice(0, -1), `tab to cycle${status.slice(12)}`];
      assert.deepEqual(wake._assessPane(lines, ANTIGRAVITY, CURSOR), { idle: false, reason: 'not-at-rest' });
    });

    it('a header that says the engine is still starting, for a profile that declares one', () => {
      const declaring = { ...ANTIGRAVITY, headerRe: /^\s*Antigravity CLI · model:/, startingRe: /model: loading/ };
      const starting = ['Antigravity CLI · model: loading', ...LINES.slice(1)];
      assert.deepEqual(wake._assessPane(starting, declaring, CURSOR), { idle: false, reason: 'engine-starting' });
      const named = ['Antigravity CLI · model: Gemini 3.8 Flash', ...LINES.slice(1)];
      assert.deepEqual(wake._assessPane(named, declaring, CURSOR), { idle: true, reason: 'at-prompt' });
    });
  });
});

describe('medusa-wake — _assessPane: an engine whose header says it is still starting (#2187)', () => {
  const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
  const LOADING = ['╭──────────────────────────────────╮', '│ >_ OpenAI Codex (v0.156.1)       │', '│ model:     loading   /model to change │', '╰──────────────────────────────────╯'];
  const NAMED = ['╭──────────────────────────────────╮', '│ >_ OpenAI Codex (v0.156.1)       │', '│ model:     GPT-6-Astra   /model to change │', '╰──────────────────────────────────╯'];
  const COMPOSER = ['', '› Ask Codex to do anything', '', '  GPT-6-Astra default · /tmp/proj'];
  /** The pane gate with the channel's idle answer, which excuses the at-rest marker. */
  const underIdle = (lines, profile = CODEX) => wake._assessPane(lines, profile, null, true);

  it('the bundled Codex profile declares the header and its starting marker; the other two declare neither', () => {
    assert.ok(CODEX.headerRe instanceof RegExp && CODEX.startingRe instanceof RegExp);
    for (const profile of [CLAUDE, ANTIGRAVITY]) {
      assert.equal(profile.headerRe, undefined);
      assert.equal(profile.startingRe, undefined);
    }
  });

  it('a header reading loading over an empty composer is refused as engine-starting', () => {
    assert.deepEqual(underIdle([...LOADING, ...COMPOSER]), { idle: false, reason: 'engine-starting' });
  });

  it('a header naming its model is not starting', () => {
    assert.deepEqual(underIdle([...NAMED, ...COMPOSER]), { idle: true, reason: 'at-prompt' });
  });

  it('the NEWEST header decides: a superseded loading header above one that names a model is not starting', () => {
    assert.deepEqual(underIdle([...LOADING, '', ...NAMED, ...COMPOSER]), { idle: true, reason: 'at-prompt' });
    assert.deepEqual(underIdle([...NAMED, '', ...LOADING, ...COMPOSER]), { idle: false, reason: 'engine-starting' });
  });

  it('a read with no header at all is not refused', () => {
    assert.deepEqual(underIdle(COMPOSER), { idle: true, reason: 'at-prompt' });
  });

  it('the word in a transcript, away from a header row, refuses nothing', () => {
    assert.deepEqual(underIdle(['• The model is loading its weights.', ...COMPOSER]), { idle: true, reason: 'at-prompt' });
  });

  it('a turn in flight is still reported as the turn, ahead of the header', () => {
    assert.equal(underIdle([...LOADING, '• Working (0s • esc to interrupt)', ...COMPOSER]).reason, 'turn-in-flight');
  });

  it('without the channel\'s idle answer the missing at-rest marker is still what refuses', () => {
    assert.equal(wake._assessPane([...LOADING, ...COMPOSER], CODEX, null, false).reason, 'not-at-rest');
  });

  it('a profile that declares no starting marker is unaffected by the same rows', () => {
    const { headerRe, startingRe, ...undeclared } = CODEX;
    assert.ok(headerRe && startingRe);
    assert.deepEqual(underIdle([...LOADING, ...COMPOSER], undeclared), { idle: true, reason: 'at-prompt' });
    const claudePane = ['│ model:     loading   /model to change │', '❯ ', '──────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
    assert.deepEqual(wake._assessPane(claudePane, CLAUDE, null), { idle: true, reason: 'at-prompt' });
  });

  it('the reason has a meaning a sender can read', () => {
    const meaning = wake.peerReasonMeaning('pane-engine-starting');
    assert.equal(typeof meaning, 'string');
    assert.match(meaning, /starting/);
  });

  it('the meaning covers a screen held by the rows it opens or resumes with, not only one held by its header (#2059)', () => {
    const meaning = wake.peerReasonMeaning('pane-engine-starting');
    assert.match(meaning, /its header says so/);
    assert.match(meaning, /the rows it opens or resumes with/);
    assert.match(meaning, /the nudge waits/);
    // One code for both producers: the disposition is the same wait.
    const codex = wake.ENGINE_WAKE_PROFILES.codex;
    const opening = ['\u203a Ask Codex to do anything', '', '  ? for shortcuts'];
    assert.deepEqual(wake._assessPane(opening, codex, null, true, '0.161.0'), { idle: false, reason: 'engine-starting' });
    assert.deepEqual(wake._assessPane(opening, codex, null, true), { idle: true, reason: 'at-prompt' });
  });
});

describe('medusa-wake — a Codex pane still drawing a turn under an idle thread, by the version\'s own end-of-turn rows (#2059)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
  const VERSION = '0.161.0';
  const COMPOSER = '› Ask Codex to do anything';
  const BELOW = ['', '  GPT-6.1-Sol default · /tmp/p · Reply OK', '  ? for shortcuts'];
  const ASKED = '› Write the numbers 1 to 150, one per line.';
  /**
   * A pane with `above` drawn over an empty composer and its two rows below.
   * @param {string[]} above - The rows above the composer.
   * @returns {string[]}
   */
  const pane = (above) => [...above, '', '', COMPOSER, ...BELOW];
  /** Codex's empty composer row as the cursor read returns it, styled. */
  const ON_EMPTY_COMPOSER = { x: 2, line: '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m' };

  const PRE_TURN = ['', '  >_ OpenAI Codex (v0.161.0)', '     /tmp/p'];
  const STREAMING = [ASKED, '', '', '• 1 the sun shines over quiet hills', '  2 the sun shines over quiet hills', '  13 the sun shines over quiet'];
  const WORKED = [ASKED, '', '• 1 the sun shines over quiet hills', '  2 the sun shines over quiet hills', '', '  Worked for 1m 04s • 18:16'];
  const INTERRUPTED = [ASKED, '', '• I’ll read the message.', '', '■ Conversation interrupted - use /feedback if something went wrong'];
  // Recorded on 0.161.0 while its thread read failed with `connection closed`.
  const RECONNECTING = [ASKED, '', '• Reconnecting to server… (9s)'];

  it('the bundled profile declares end-of-turn rows for exactly 0.161.0 and 0.162.0, each compiled from its own entry', () => {
    const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')).capabilities.wake.restRows;
    for (const version of ['0.161.0', '0.162.0']) {
      const { turnEnd } = declared[version];
      const compiled = CODEX.restRows[version];
      assert.equal(compiled.turnRowRe.source, new RegExp(turnEnd.turnRowPattern).source, version);
      assert.deepEqual(compiled.endRowRes.map((re) => re.source), turnEnd.endRowPatterns.map((p) => new RegExp(p).source), version);
      assert.ok(Object.isFrozen(compiled) && Object.isFrozen(compiled.endRowRes), version);
      assert.match(turnEnd.evidence.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(turnEnd.evidence.source.includes(`codex-cli ${version}`), `${version}'s end-of-turn rows are its own measurement`);
    }
    assert.equal(CODEX.restRows['0.156.1'], undefined, 'nothing is declared for 0.156.1, whose post-turn screen was never measured');
  });

  it('pre-turn, after a turn that ended, and after an interrupted one: not in flight', () => {
    assert.equal(wake._paneTurnInFlight(pane(PRE_TURN), CODEX, VERSION), false);
    assert.equal(wake._paneTurnInFlight(pane(WORKED), CODEX, VERSION), false);
    assert.equal(wake._paneTurnInFlight(pane(INTERRUPTED), CODEX, VERSION), false);
  });

  it('an answer still being drawn, a submitted message with no answer yet and a reconnecting turn: in flight', () => {
    assert.equal(wake._paneTurnInFlight(pane(STREAMING), CODEX, VERSION), true);
    assert.equal(wake._paneTurnInFlight(pane([ASKED]), CODEX, VERSION), true);
    assert.equal(wake._paneTurnInFlight(pane(RECONNECTING), CODEX, VERSION), true);
  });

  it('an end row followed by a newer turn does not end the newer one; trailing space on the end row is not part of it', () => {
    assert.equal(wake._paneTurnInFlight(pane([...WORKED, '', '› Next one.', '', '• Working on it']), CODEX, VERSION), true);
    const padded = [...WORKED];
    padded[padded.length - 1] += '   ';
    assert.equal(wake._paneTurnInFlight(pane(padded), CODEX, VERSION), false);
  });

  it('asks only for the exact version the channel proved, and only its own entry', () => {
    const lines = pane(STREAMING);
    for (const version of [null, undefined, '0.156.1', '0.159.0', '0.161.00', '0.161', 'constructor', '__proto__']) {
      assert.equal(wake._paneTurnInFlight(lines, CODEX, version), false, String(version));
    }
    assert.equal(wake._paneTurnInFlight(lines, CODEX, '0.162.0'), true);
    const inherited = { ...CODEX, restRows: Object.create({ [VERSION]: CODEX.restRows[VERSION] }) };
    assert.equal(wake._paneTurnInFlight(lines, inherited, VERSION), false, 'an entry inherited through the prototype counts as absent');
    const footerOnly = { ...CODEX, restRows: { [VERSION]: { footerRe: CODEX.restRows[VERSION].footerRe } } };
    assert.equal(wake._paneTurnInFlight(lines, footerOnly, VERSION), false, 'an entry that declares no end-of-turn rows never holds');
    assert.equal(wake._paneTurnInFlight(lines, CLAUDE, VERSION), false, 'a profile with no table never holds');
  });

  it('with no bare composer row in the read there is nothing to anchor on', () => {
    assert.equal(wake._paneTurnInFlight(STREAMING, CODEX, VERSION), false);
  });

  it('an older empty composer above the live one is not a turn, though it starts with the same glyph', () => {
    const olderOpening = [COMPOSER, '  ? for shortcuts', ''];
    assert.equal(wake._paneTurnInFlight(pane([...olderOpening, ...PRE_TURN]), CODEX, VERSION), false);
    assert.equal(wake._paneTurnInFlight(pane([...WORKED, '', COMPOSER]), CODEX, VERSION), false, 'nor does one drawn after the end row hide it');
    assert.equal(wake._paneTurnInFlight(pane([...olderOpening, ...STREAMING]), CODEX, VERSION), true, 'a real turn below one is still in flight');
  });

  it('through the pane gate: held as turn-in-flight, even with the cursor on the empty composer; a version with no declaration reads at-prompt', () => {
    assert.deepEqual(wake._assessPane(pane(STREAMING), CODEX, null, true, VERSION), { idle: false, reason: 'turn-in-flight' });
    assert.deepEqual(wake._assessPane(pane(STREAMING), CODEX, ON_EMPTY_COMPOSER, true, VERSION), { idle: false, reason: 'turn-in-flight' });
    assert.deepEqual(wake._assessPane(pane(STREAMING), CODEX, null, true), { idle: true, reason: 'at-prompt' });
    assert.deepEqual(wake._assessPane(pane(WORKED), CODEX, ON_EMPTY_COMPOSER, true, VERSION), { idle: true, reason: 'at-prompt' });
    assert.deepEqual(wake._assessPane(pane(PRE_TURN), CODEX, null, true, VERSION), { idle: true, reason: 'at-prompt' });
  });

  it('the opening screen keeps its own refusal: no turn row is drawn on it', () => {
    const opening = [COMPOSER, '', '  ? for shortcuts'];
    assert.deepEqual(wake._assessPane(opening, CODEX, null, true, VERSION), { idle: false, reason: 'engine-starting' });
  });

  it('the reason a sender reads says mid-turn and that the nudge waits', () => {
    assert.match(wake.peerReasonMeaning('pane-turn-in-flight'), /mid-turn/);
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
    // The project form names its verbs through `tc` and the API base once
    // (#1976): every further mention of the base costs the encoded project
    // name again against the composer's verbatim-paste limit.
    assert.match(cmd, /tc message read/);
    assert.match(cmd, /tc message ack <message-id>/);
    assert.match(cmd, /API at \S+\/api\/sessions\/proj-a\/medusa: GET \/messages; POST \/send \(inReplyTo\) and \/read need launch headers\./);
  });

  it('URL-encodes the project name in the nudge path', () => {
    assert.match(wake._nudgeLine('My Proj', 2), /\/api\/sessions\/My%20Proj\/medusa: GET \/messages/);
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
    // The nudge carries the one HOLD exemption (#1861): it is how a control notice reaches a held pane.
    assert.deepEqual(world.injected[0].options, { sessionId: world.sessions[0].id, controlExempt: 'medusa-wake' });
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

describe('medusa-wake — #2402 reply-guidance override and non-actionable-notice suppression', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('uses the project\'s replyGuidance override in the nudge instead of the default tc message instruction', () => {
    const world = installWorld({ config: { medusaWake: true, replyGuidance: 'Answer by direct input: POST /api/sessions/proj-a/command' } });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1);
    assert.match(world.injected[0].command, /Answer by direct input: POST \/api\/sessions\/proj-a\/command/);
    assert.ok(!world.injected[0].command.includes('tc message send --in-reply-to'),
      'the default instruction is replaced, not merely appended alongside');
  });

  it('keeps the default instruction when replyGuidance is unset', () => {
    const world = installWorld();
    tickThroughDebounce();
    assert.match(world.injected[0].command, /tc message send --in-reply-to <message-id>/);
  });

  it('keeps the default instruction when replyGuidance is invalid (e.g. multi-line), rather than injecting something unvalidated', () => {
    const world = installWorld({ config: { medusaWake: true, replyGuidance: 'two\nlines' } });
    tickThroughDebounce();
    assert.match(world.injected[0].command, /tc message send --in-reply-to <message-id>/);
  });

  /**
   * A `shared_doc_updated` notice exactly as the real producer envelopes it
   * (`lib/shared-docs.js#sendIntents` via `medusa.sendSystemMessage`): `from`
   * is the system sender, and the notice itself is JSON-encoded INTO
   * `message` — never top-level `type`/`event` fields on the entry.
   * @param {object} [overrides] - Fields to merge into the decoded payload.
   * @returns {object} An inbox entry.
   */
  function systemNotice(overrides = {}) {
    return {
      id: `n-${Math.random().toString(36).slice(2)}`,
      from: 'system',
      message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'NETWORK', docId: 'd1', sentAt: '2026-10-28T00:00:00Z', ...overrides })
    };
  }

  it('suppresses the nudge when every unhandled message is a shared_doc_updated notice and the project opted in', () => {
    const world = installWorld({
      config: { medusaWake: true, suppressNonActionableWakes: true },
      inbox: [systemNotice()]
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
    assert.equal(world.recorded.some((r) => r.skipReason === 'non-actionable-notice-only'), true);
  });

  it('still nudges for an all-notice inbox when the project has not opted in', () => {
    const world = installWorld({
      config: { medusaWake: true },
      inbox: [systemNotice()]
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'default preserves today\'s behavior — opt-in only');
  });

  it('still nudges when a real message sits alongside a notice, even opted in', () => {
    const world = installWorld({
      config: { medusaWake: true, suppressNonActionableWakes: true },
      inbox: [systemNotice(), { id: 'm1', from: 'peer', message: 'hello' }],
      status: { state: 'listening', workspaceId: 'proj-a-abc123', unread: 2, lastError: null }
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'a real message alongside a notice still nudges');
  });

  it('a peer carrying notice-like JSON must still wake — only the system sender is trusted', () => {
    // `noticeDocId`'s own rationale (`lib/shared-docs.js`): a peer could type
    // the same JSON into its own message body, and a peer message has a
    // sender waiting on it — treating it as a redundant notice would
    // suppress a reply somebody is blocked on.
    const world = installWorld({
      config: { medusaWake: true, suppressNonActionableWakes: true },
      inbox: [{
        id: 'm1', from: 'peer-workspace-id',
        message: JSON.stringify({ type: 'system', event: 'shared_doc_updated', doc: 'NETWORK', docId: 'd1', sentAt: '2026-10-28T00:00:00Z' })
      }]
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'notice-shaped JSON from a non-system sender still wakes the session');
  });

  it('never suppresses for the Master, which has no project config to read the setting from', () => {
    const world = installWorld({
      sessions: [],
      masterRecord: {
        id: 'master', isMaster: true, name: 'Project Master', tmuxSession: 'tangleclaw-master',
        engineId: 'claude', sessionMode: 'tmux', status: 'active', medusaWake: true,
        apiBase: '/api/master/medusa'
      },
      inbox: [systemNotice()]
    });
    tickThroughDebounce();
    assert.equal(world.masterInjected.length, 1, 'the Master branch is unaffected by a setting it cannot read');
  });
});

describe('medusa-wake — a not-accepted receipt immediately asks the watchdog to re-arm (#2716)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  /**
   * A fake transport whose `verify` is controlled directly, bypassing
   * `verifySubmission`/a real pane read entirely. `deliver` still calls the
   * real `injectCommand` hook it is handed, exactly as the real transports
   * do, so `world.injected` is populated the same way a genuine nudge would.
   */
  const fakeTransport = (receipt) => Object.freeze({
    id: 'fake-2716', channel: 'fake', receipts: receipt.outcome === 'accepted' ? 'positive' : 'negative',
    deliver: (args, hooks) => hooks.injectCommand(args.project.name, args.line, {}),
    verify: async () => receipt
  });

  it('calls rearmWorkspace right after recording wake_not_accepted — not merely records it and waits for the periodic watchdog tick', async () => {
    const world = installWorld();
    wake._internal.transportFor = () => fakeTransport({ outcome: 'not-accepted', reason: 'test' });
    wake._internal.pendingWakeCount = () => 1;
    const recorded = [];
    wake._internal.recordWakeFacts = (workspaceId, fact, opts) => recorded.push({ workspaceId, fact, opts });
    const rearmed = [];
    wake._internal.rearmWorkspace = (workspaceId) => { rearmed.push(workspaceId); };
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the nudge itself still goes through unchanged');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(recorded.some((r) => r.fact === 'wake_attempted'), 'the attempt is still recorded');
    assert.ok(recorded.some((r) => r.fact === 'wake_not_accepted'), 'and so is the receipt');
    assert.deepEqual(rearmed, [world.status.workspaceId], 'the watchdog is asked to re-arm this exact workspace, once');
  });

  it('a re-arm failure is caught and logged: the already-recorded receipt stands, and nothing throws', async () => {
    const world = installWorld();
    wake._internal.transportFor = () => fakeTransport({ outcome: 'not-accepted', reason: 'test' });
    wake._internal.pendingWakeCount = () => 1;
    const recorded = [];
    wake._internal.recordWakeFacts = (workspaceId, fact, opts) => recorded.push({ workspaceId, fact, opts });
    wake._internal.rearmWorkspace = () => { throw new Error('watchdog unreachable'); };
    tickThroughDebounce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(recorded.some((r) => r.fact === 'wake_not_accepted'), 'the receipt is recorded regardless of the re-arm outcome');
  });

  it('an accepted receipt never asks for a re-arm', async () => {
    installWorld();
    wake._internal.transportFor = () => fakeTransport({ outcome: 'accepted' });
    wake._internal.pendingWakeCount = () => 1;
    wake._internal.recordWakeFacts = () => {};
    const rearmed = [];
    wake._internal.rearmWorkspace = (workspaceId) => { rearmed.push(workspaceId); };
    tickThroughDebounce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rearmed, [], 'only a proven miss re-arms; an accepted nudge has nothing to retry');
  });
});

describe('medusa-wake — a scan requested inside the observation gap is booked, not dropped (#2716)', () => {
  // PRR-A/PM found that the fix above was inert in the exact case it exists
  // for: `requestScan('wake-rearmed')` fires ~1.2s after the nudge's own pane
  // read stamped `lastPaneAnswerAt`, so `_promptLook`'s own gate
  // (`_mayLookNow`) silently dropped it every time, and the re-armed wake
  // still waited for a periodic tick regardless. This exercises the REAL
  // `requestScan` -> `_promptLook` -> `_bookFollowUp` chain end to end, with
  // a fake clock and fake timers, rather than mocking any of it away.
  let saved;
  let clock;
  let timers;

  beforeEach(() => {
    wake.stop();
    saved = { ...wake._internal };
    clock = 1_000_000;
    timers = [];
    wake._internal.now = () => clock;
    wake._internal.clock = () => clock;
    wake._internal.setTimer = (fn, ms) => { const t = { fn, dueAt: clock + ms }; timers.push(t); return t; };
    wake._internal.clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
    // Deterministic: run the deferred "next turn" immediately rather than via a real setImmediate.
    wake._internal.defer = (fn) => fn();
  });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  /** Fire every timer whose booked due time the fake clock has now reached. */
  function fireDueTimers() {
    const due = timers.filter((t) => t.dueAt <= clock);
    timers = timers.filter((t) => t.dueAt > clock);
    for (const t of due) t.fn();
  }

  /**
   * Drive the debounce and the nudge through the REAL async path (the one
   * the periodic timer actually uses — `start()` ticks with `{async: true}`)
   * rather than the synchronous `capturePane` path `tick()` alone exercises
   * elsewhere in this file. `lastPaneAnswerAt` (what `_mayLookNow`'s
   * observation-gap check reads) is set only when an async read's answer is
   * judged (`_onPaneRead` -> `_judgeSession({prefetched})`), never by a bare
   * sync tick, so this is the only way to reach the real failure mode.
   * Ticks until the nudge lands (bounded, so a real regression here fails
   * loudly instead of looping forever) rather than assuming the async path's
   * debounce needs exactly as many cycles as the synchronous one.
   * @param {object} world - From `installWorld`.
   * @returns {Promise<void>}
   */
  async function tickAsyncUntilNudged(world) {
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED + 2 && world.injected.length === 0; i++) {
      // Each observation must be spaced out past MIN_OBSERVATION_GAP_MS, or
      // it resets the debounce streak instead of extending it (the exact
      // mechanism #2716 is about) -- real ticks are seconds apart, well past
      // the gap, which a frozen fake clock between manual ticks is not.
      if (i > 0) clock += wake.MIN_OBSERVATION_GAP_MS + 1000;
      wake._internal.tick({ async: true });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(world.injected.length, 1, 'the nudge went out');
  }

  it('REAL: a request ~1.2s after the nudge\'s own pane read books a follow-up instead of being silently dropped, and the follow-up actually looks before any periodic tick runs again', async () => {
    // `requestScan` is a no-op unless the monitor is "running"; a huge
    // interval means the real setInterval it schedules never fires within
    // this test.
    wake.start({ intervalMs: 3600 * 1000 });
    const reads = [];
    const world = installWorld();
    wake._internal.readPaneAsync = (tmuxSession) => {
      reads.push(tmuxSession);
      return Promise.resolve({ cap: { lines: world.pane, alternateScreen: false }, cursor: null });
    };
    // Same mail edge as the first nudge, but the watchdog has re-armed it --
    // exactly what the real `rearmWorkspace` sets durably, and exactly what
    // lets `_judgeSession` run every gate again (including a fresh pane
    // read) for an edge it already nudged, instead of treating it as
    // already handled and reusing the cached verdict with no new read.
    wake._internal.rearmDue = () => true;

    // Debounce, then the nudge: the nudge tick's own async pane read, once
    // judged, stamps `lastPaneAnswerAt` at the current fake clock.
    await tickAsyncUntilNudged(world);
    const readsAfterNudge = reads.length;
    assert.ok(readsAfterNudge >= 1, 'via the async path, which is what stamps lastPaneAnswerAt');

    // ~1.2s later, same as the real not-accepted receipt timing: the
    // immediate re-arm asks for a scan.
    clock += 1200;
    wake.requestScan(1, 'wake-rearmed');
    assert.equal(reads.length, readsAfterNudge, 'still inside MIN_OBSERVATION_GAP_MS: no SECOND look fires synchronously');
    assert.equal(timers.length, 1, 'a follow-up is booked instead of the request being dropped outright');

    // The booked follow-up fires at the earliest safe time -- strictly
    // before a periodic tick is ever run again in this test, so whatever
    // looked again, it was the follow-up and nothing else.
    clock += wake.MIN_OBSERVATION_GAP_MS;
    fireDueTimers();
    assert.equal(reads.length, readsAfterNudge + 1, 'the follow-up itself looked, without waiting for a periodic tick');
    assert.equal(reads[reads.length - 1], world.sessions[0].tmuxSession);
  });

  it('control: a request OUTSIDE the gap still looks immediately, same as before (#2716 only changes the dropped case)', async () => {
    wake.start({ intervalMs: 3600 * 1000 });
    const reads = [];
    const world = installWorld();
    wake._internal.readPaneAsync = (tmuxSession) => {
      reads.push(tmuxSession);
      return Promise.resolve({ cap: { lines: world.pane, alternateScreen: false }, cursor: null });
    };
    wake._internal.rearmDue = () => true;
    await tickAsyncUntilNudged(world);
    const readsAfterNudge = reads.length;
    clock += wake.MIN_OBSERVATION_GAP_MS + 1;
    wake.requestScan(1, 'wake-rearmed');
    assert.equal(reads.length, readsAfterNudge + 1, 'outside the gap, the request is looked at immediately, with no follow-up needed');
    assert.equal(timers.length, 0, 'nothing was booked: there was nothing to recover');
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

  // #918. A session blocked on a dialog is unreachable for exactly as long as
  // the dialog is up; what makes that bounded rather than permanent is that the
  // refusal HOLDS the mail edge instead of consuming it. Nothing new arrives
  // while the dialog is open, so a monitor that only nudged on arrival would
  // never wake this session at all once the dialog cleared.
  it('holds the mail edge while a dialog is up and nudges once it clears, with no new arrival (#918)', () => {
    const world = installWorld({ pane: DIALOG_PANE });
    for (let i = 0; i < 6; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0, 'never types into the dialog');
    assert.equal(
      world.recorded.filter((r) => r.skipReason === 'pane-no-prompt').length, 1,
      'the dialog is recorded as the reason, once — a transition, not a row per tick'
    );

    world.pane = IDLE_PANE; // the operator answers the dialog; the inbox is unchanged
    // Clearing the dialog redraws the transcript, which is movement (#1114), so
    // the first tick after it settles rather than counts toward the streak.
    wake._internal.tick();
    assert.equal(world.injected.length, 0, 'the redraw is a settle tick, not an idle one');
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the held mail is nudged after the dialog clears');
    assert.equal(world.recorded[world.recorded.length - 1].outcome, 'nudged');

    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'and exactly once — the drain consumed the edge');
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

  it('never nudges into a pane a wrap pipeline is driving', () => {
    // The guard that replaced the retired `wrapping` status. A wrap pauses
    // between steps, and a pane at rest there is exactly the shape this monitor
    // acts on — so without this it would type a line into a running wrap.
    const world = installWorld({ wrapRunning: true });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
    assert.ok(world.recorded.some((r) => r.skipReason === 'wrap-running'),
      'and the skip is recorded, not silent');

    world.wrapRunning = false;
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the held nudge fires once the wrap is over');
  });

  it('never nudges a coordinator in managed context rotation, and nudges once when it resumes (#2032)', () => {
    // The rotation types its own /clear and delivers its own re-entry turn; a
    // nudge typed into the pane meanwhile would land in the clear or on top of
    // the reconciliation. Mail waits, and is nudged once after the resume.
    const world = installWorld({ rotating: true });
    tickThroughDebounce();
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
    assert.ok(world.recorded.some((r) => r.skipReason === 'coordinator-rotating'), 'the hold is recorded, not silent');

    world.rotating = false;
    tickThroughDebounce();
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the waiting mail is nudged exactly once after the rotation resumes');
  });

  it('holds the nudge when the rotation record cannot be read (#2032)', () => {
    const world = installWorld({ sessions: [claudeSession(7)] });
    wake._internal.rotationOpen = () => { throw new Error('store locked'); };
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
  });

  // #1633 R3. `lib/sessions.js#activeStartupReadiness` reads a session with no
  // bound launch sequence at all as `needs-attention` — every launch binds one
  // at start — so the wake gate must hold on exactly the same shape, not treat
  // a missing row as "nothing to wait on".
  it('never nudges a session with no launch sequence bound at all, and nudges once one attests READY (#1633 R3)', () => {
    const world = installWorld({ launchSequence: null });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0, 'no sequence row — held, never read as ready');
    assert.ok(world.recorded.some((r) => r.skipReason === 'startup-not-ready'),
      'the hold is recorded, not silent, under the same code the other two startup holds use');

    world.launchSequence = { applicability: 'not-applicable', readyAt: null, recovery: 'none', preflight: null, recoveryClearedAt: null };
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the held nudge fires once the session has a sequence');
  });

  // #1633 R3. A `not-applicable` sequence is ordinarily ready immediately, but
  // `lib/launch-recovery-clear.js#isNotApplicableDamagedHandoff` reads the same
  // preflight the recovery-clear route and the readiness panel do — a damaged
  // sequence-less handoff must hold here too, or the wake gate would nudge a
  // session the panel is still showing "Needs attention".
  it('never nudges a not-applicable session with an uncleared damaged handoff, and nudges once it clears (#1633 R3)', () => {
    const world = installWorld({
      launchSequence: {
        applicability: 'not-applicable', readyAt: null, recovery: 'none',
        preflight: { requiresRecovery: true }, recoveryClearedAt: null
      }
    });
    tickThroughDebounce();
    assert.equal(world.injected.length, 0, 'a damaged handoff holds the nudge even though applicability is not-applicable');
    assert.ok(world.recorded.some((r) => r.skipReason === 'startup-not-ready'),
      'the hold is recorded, not silent');

    world.launchSequence = {
      applicability: 'not-applicable', readyAt: null, recovery: 'none',
      preflight: { requiresRecovery: true }, recoveryClearedAt: '2026-10-28T00:00:00.000Z'
    };
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'the held nudge fires once the damaged handoff is cleared');
  });

  // #1314 — every test above stubs `_internal.wrapRunning`, so none of them can
  // see what the real seam answers. That is the gap the bug lived in: the gate
  // fails closed by design, so a permanently-true read is indistinguishable
  // from a real wrap and the project silently stops being woken forever. This
  // drives the REAL seam against the REAL registry.
  it('the real wrap seam stops holding nudges once a run is wedged past STALE_RUN_MS', () => {
    const registry = require('../lib/wrap-run-registry');
    const realWrapRunning = wake._internal.wrapRunning;
    const realNow = registry._internal.now;
    let fakeNow = realNow();
    registry._internal.now = () => fakeNow;
    try {
      registry._resetForTests();
      wake._internal.wrapRunning = realWrapRunning;
      registry.begin('wedged-project', 1);
      assert.equal(realWrapRunning('wedged-project'), true, 'a live wrap still holds the nudge');

      fakeNow += registry.STALE_RUN_MS;
      assert.equal(realWrapRunning('wedged-project'), false,
        'a wedged run must not withhold this project\'s nudges for the life of the process');
    } finally {
      registry._internal.now = realNow;
      registry._resetForTests();
      wake._internal.wrapRunning = realWrapRunning;
    }
  });

  // #1321 — the wake gate silently resuming nudges past a stale run (the same
  // transition the test above drives) is exactly the moment `warnStale` must
  // record once. This drives the REAL `wrapRunning` AND `warnStaleWrap` seams
  // against the REAL registry, through a full tick — not a direct function call —
  // so the gate's own call site is what is pinned, not just the registry's export.
  it('warns once, via the real registry, the tick that first resumes nudging a stale wrap (#1321)', () => {
    const registry = require('../lib/wrap-run-registry');
    const realWrapRunning = wake._internal.wrapRunning;
    const realWarnStaleWrap = wake._internal.warnStaleWrap;
    const realNow = registry._internal.now;
    let fakeNow = realNow();
    registry._internal.now = () => fakeNow;
    const warnings = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const { setLevel: setLvl } = require('../lib/logger');
    try {
      registry._resetForTests();
      // `installWorld` stubs `wrapRunning` to its own `world.wrapRunning` flag
      // (and declares no `warnStaleWrap` seam at all) — both real seams must be
      // restored AFTER it runs, or this test exercises the stub, not the gate.
      const world = installWorld({ project: { id: 10, name: 'wedged-project', path: '/tmp/wedged-project' } });
      wake._internal.wrapRunning = realWrapRunning;
      wake._internal.warnStaleWrap = realWarnStaleWrap;
      const claim = registry.begin('wedged-project', 1);

      tickThroughDebounce();
      assert.equal(world.injected.length, 0, 'still live — no nudge, no warning yet');

      fakeNow += registry.STALE_RUN_MS;
      setLvl('warn');
      process.stdout.write = (chunk, ...rest) => {
        const text = String(chunk);
        if (text.includes('Stale wrap run permitted an action')) warnings.push(text);
        return origWrite(chunk, ...rest);
      };
      tickThroughDebounce();
      assert.equal(world.injected.length, 1, 'the wedged run no longer withholds the nudge');
      assert.equal(warnings.length, 1, 'warned exactly once for this run at the wake site');
      assert.match(warnings[0], /wedged-project/);
      assert.match(warnings[0], new RegExp(claim.runId));

      // Debounce needs a fresh mail edge to nudge again; staleness itself does
      // not re-fire the wake, but the gate still re-evaluates `wrapRunning`
      // every tick — the latch, not the lack of ticks, is what keeps this at one.
      tickThroughDebounce();
      assert.equal(warnings.length, 1, 'one-shot — not re-warned on a later tick for the same run');
    } finally {
      process.stdout.write = origWrite;
      setLvl('error');
      registry._internal.now = realNow;
      registry._resetForTests();
      wake._internal.wrapRunning = realWrapRunning;
      wake._internal.warnStaleWrap = realWarnStaleWrap;
    }
  });

  // #1321 — PRR-A, PR #2646 review: the warning must not fire merely because
  // the WRAP gate stopped withholding the nudge — a LATER gate (rotation,
  // here) can still withhold it on that same tick, and the one-shot latch
  // would then suppress the warning on the tick that actually nudges. Held
  // first by rotation (no warning), then nudged once rotation clears (exactly
  // one warning, on the tick the nudge actually happens).
  it('does not warn while a stale run is held by a LATER gate, and warns on the tick that actually nudges', () => {
    const registry = require('../lib/wrap-run-registry');
    const realWrapRunning = wake._internal.wrapRunning;
    const realWarnStaleWrap = wake._internal.warnStaleWrap;
    const realNow = registry._internal.now;
    let fakeNow = realNow();
    registry._internal.now = () => fakeNow;
    const warnings = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const { setLevel: setLvl } = require('../lib/logger');
    try {
      registry._resetForTests();
      const world = installWorld({
        project: { id: 10, name: 'held-then-nudged', path: '/tmp/held-then-nudged' },
        rotating: true
      });
      wake._internal.wrapRunning = realWrapRunning;
      wake._internal.warnStaleWrap = realWarnStaleWrap;
      const claim = registry.begin('held-then-nudged', 1);
      fakeNow += registry.STALE_RUN_MS;

      setLvl('warn');
      process.stdout.write = (chunk, ...rest) => {
        const text = String(chunk);
        if (text.includes('Stale wrap run permitted an action')) warnings.push(text);
        return origWrite(chunk, ...rest);
      };

      // The wrap gate no longer withholds (the run is stale), but rotation
      // still does — this tick must not warn.
      tickThroughDebounce();
      assert.equal(world.injected.length, 0, 'held by rotation, not nudged');
      assert.equal(warnings.length, 0, 'the wrap gate passing is not the same as the nudge happening');

      // Rotation clears; THIS tick is the one that actually nudges.
      world.rotating = false;
      tickThroughDebounce();
      assert.equal(world.injected.length, 1, 'now nudged');
      assert.equal(warnings.length, 1, 'warned exactly once, on the tick that actually permitted the nudge');
      assert.match(warnings[0], /held-then-nudged/);
      assert.match(warnings[0], new RegExp(claim.runId));
    } finally {
      process.stdout.write = origWrite;
      setLvl('error');
      registry._internal.now = realNow;
      registry._resetForTests();
      wake._internal.wrapRunning = realWrapRunning;
      wake._internal.warnStaleWrap = realWarnStaleWrap;
    }
  });

  it('holds the nudge when the wrap registry cannot be read', () => {
    // The gate withholds a nudge, so an unreadable registry is a reason to
    // withhold one — never a reason to send it. Reversing this is silent: the
    // nudge lands and nothing says the gate was skipped.
    const world = installWorld({ sessions: [claudeSession(7)] });
    wake._internal.wrapRunning = () => { throw new Error('registry exploded'); };
    tickThroughDebounce();
    assert.equal(world.injected.length, 0);
  });

  it('never nudges a session that has ended', () => {
    // `listLiveAll` returns only `active` rows, so this guard fires on the race:
    // the session ended between the roster read and this scan. Enumerated over
    // every terminal status, because one of them is not the family — and each
    // gets its own id, since the monitor keeps state per session.
    ['wrapped', 'killed', 'crashed'].forEach((status, i) => {
      const ended = { ...claudeSession(i + 1), status };
      const world = installWorld({ sessions: [ended] });
      tickThroughDebounce();
      assert.equal(world.injected.length, 0, `a ${status} session must not be nudged`);
    });
    // And the skip is a per-session decision, not a latch on the monitor.
    const world = installWorld({ sessions: [{ ...claudeSession(4), status: 'active' }] });
    tickThroughDebounce();
    assert.equal(world.injected.length, 1, 'a live session still nudges');
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

  /**
   * Run `fn` with the Master's config-held access level set to `level`,
   * restoring whatever was there before — `_nudgeLineFor` reads this fresh
   * from the shared throwaway store on every call (#2176), so a test that
   * sets it must not leak the change to tests that run after it.
   * @param {string} level - One of `read-only`, `suggest`, `write`.
   * @param {Function} fn - Runs with the level in effect.
   */
  function withMasterAccessLevel(level, fn) {
    const store = require('../lib/store');
    const before = store.config.load();
    store.config.save({ ...before, master: { ...before.master, accessLevel: level } });
    try {
      fn();
    } finally {
      store.config.save(before);
    }
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
    // The reply path a project session is given is now `tc message send`, which
    // carries its launch headers (#1976). The raw reply route stays, named once
    // relative to the one API base, with what a raw reply must carry.
    const line = wake._nudgeLineFor('/api/sessions/p/medusa', 1, 'http://localhost:3102');
    assert.match(line, /tc message send --in-reply-to <message-id> <sender-workspace-id> "<reply>"/);
    assert.match(line, /API at http:\/\/localhost:3102\/api\/sessions\/p\/medusa: GET \/messages; POST \/send \(inReplyTo\) and \/read need launch headers\./);
    assert.equal(line.split('/api/sessions/p/medusa').length - 1, 1, 'the base is named once');
    assert.match(line, /initiator closes the exchange/);
    assert.ok(!line.includes('\n'), 'still one line');
  });

  it('names the reply path that works, before the ack (#1976)', () => {
    // The nudge said mark handled, then reply with a raw POST /send. A raw send
    // carrying inReplyTo without the launch headers is refused
    // (EXCHANGE_BINDING_REQUIRED), and one sent without inReplyTo records no
    // reply, so following the nudge left the initiator blocked either way.
    const line = wake._nudgeLineFor('/api/sessions/p/medusa', 1, 'http://localhost:3102');
    assert.match(line, /tc message send --in-reply-to <message-id>/);
    assert.match(line, /launch headers/, 'the raw path names what it needs');
    assert.match(line, /tc message ack <message-id>/);
    assert.ok(line.indexOf('--in-reply-to') < line.indexOf('tc message ack'), 'reply comes before the ack');
    assert.match(line, /tc message owed/);
    assert.match(line, /Never use \/clear as an acknowledgement/);
    assert.ok(!line.includes('\n'), 'still one line');
  });

  it('stays well under the composer\'s verbatim-paste limit for the longest valid project names (#1976)', () => {
    // Claude Code shows a paste of up to COMPOSER_VERBATIM_MAX characters as
    // typed and anything longer as `[Pasted text #N]`. A nudge whose Enter is
    // lost is recognised by reading the composer back, so a collapsed nudge is
    // never recognised and the session's wakes stop until the exchange
    // escalates. The base carries the URL-encoded name, and a space encodes to
    // three characters, so space-heavy names are the long ones.
    const { validateName } = require('../lib/projects');
    const wakeTransports = require('../lib/wake-transports');
    const BOUND = 750;
    assert.ok(BOUND <= wake.COMPOSER_VERBATIM_MAX - 50, 'the bound keeps a margin under the measured limit');
    assert.equal(validateName('x'.repeat(65)).valid, false, 'no valid name is longer than 64');
    const project = (name) => {
      assert.equal(validateName(name).valid, true, `"${name.slice(0, 8)}…" must be a name the registry accepts`);
      return `/api/sessions/${encodeURIComponent(name)}/medusa`;
    };
    const cases = [
      ['a letter, 62 spaces, a letter', project(`a${' '.repeat(62)}b`), 999, 'https://localhost:3102'],
      ['64 plain characters', project('x'.repeat(64)), 999, 'https://localhost:3102'],
      ['64 spaces, the longest origin and count', project(' '.repeat(64)), 99999, 'https://localhost:65535'],
      ['the Master', require('../lib/master').MASTER_MEDUSA_API_BASE, 99999, 'https://localhost:65535']
    ];
    for (const [label, base, unread, origin] of cases) {
      const line = wakeTransports.withNonce(wake._nudgeLineFor(base, unread, origin), '0123456789ab');
      assert.ok(line.length <= BOUND, `${label}: the whole nudge is ${line.length} characters, over ${BOUND}`);
      assert.equal(wake.isOwnNudge(line), true, `${label}: still recognised as our own nudge`);
    }
  });

  it('gives a sending-enabled Project Master only the raw routes: no tc message command (#1976)', () => {
    // `tc message` resolves a project name and the Master has none, so every
    // `tc message` command refuses in its pane. A Master nudge that named them
    // would leave it only the raw ack, which is the ack-without-reply the
    // project wording exists to stop. Pinned to `write` (#2176): sending is
    // gated by access level, and the POST-reply form is only correct when the
    // route itself would accept it.
    const base = require('../lib/master').MASTER_MEDUSA_API_BASE;
    withMasterAccessLevel('write', () => {
      const line = wake._nudgeLineFor(base, 2, 'http://localhost:3102');
      assert.doesNotMatch(line, /tc message/, 'no tc message command reaches the Master');
      assert.doesNotMatch(line, /launch headers|in-reply-to/, 'nor the project-only reply carrier');
      // `inReplyTo` itself DOES belong in the Master's raw body (#1988): without
      // it, the body the nudge demonstrates never binds a reply, leaving the
      // initiator blocked exactly as before the fix.
      assert.match(line, /POST \/api\/master\/medusa\/send \{"to":"<sender-workspace-id>","message":"<reply>","inReplyTo":"<message-id>"\}/);
      assert.match(line, /POST \/api\/master\/medusa\/read \{"ids":\[\.\.\.\]\}/);
      assert.ok(line.indexOf('/medusa/send') < line.indexOf('/medusa/read'), 'reply comes before the ack');
      // Both writes are refused without the Master's own binding (#2233), which
      // is a role and a launch id, not a project's two headers.
      assert.match(line, /Both POSTs need the headers x-tangleclaw-role: master and x-tangleclaw-launch-id: \$TANGLECLAW_LAUNCH_ID\./);
      assert.doesNotMatch(line, /x-tangleclaw-project-id/, 'the Master has no project to claim');
      assert.match(line, /BEFORE marking it handled/);
      assert.match(line, /initiator closes the exchange/);
      assert.match(line, /Never use \/clear as an acknowledgement/);
      assert.ok(!line.includes('\n'), 'still one line');
    });
    // The base picks the form, so a project session never gets the Master's.
    assert.match(wake._nudgeLineFor('/api/sessions/master/medusa', 2, 'http://localhost:3102'), /tc message send --in-reply-to/);
  });

  it("following the Master's own raw instruction literally binds the reply and marks the original replied (#1988)", () => {
    // Parsed from the nudge's OWN text rather than hand-written, so a future
    // wording change that drops `inReplyTo` again fails here, not just at the
    // regex assertion above.
    const medusaExchanges = require('../lib/medusa-exchanges');
    const base = require('../lib/master').MASTER_MEDUSA_API_BASE;
    withMasterAccessLevel('write', () => {
      const line = wake._nudgeLineFor(base, 1, 'http://localhost:3102');
      const bodyMatch = line.match(/POST \/api\/master\/medusa\/send (\{.*?\});/);
      assert.ok(bodyMatch, 'the nudge demonstrates a JSON body for the send');
      const demonstratedBody = JSON.parse(bodyMatch[1]);
      assert.equal(demonstratedBody.inReplyTo, '<message-id>', 'the demonstrated body names inReplyTo');
      assert.equal(demonstratedBody.to, '<sender-workspace-id>', 'the demonstrated body names the placeholder to fill in');

      const original = medusaExchanges.createSendIntent({
        meta: medusaExchanges.validateSendMeta({}, { kind: 'project', projectId: 20 }, 20),
        sender: { projectId: 20, sessionId: 2, workspaceId: 'builder-ws' },
        recipient: { workspaceId: 'master-ws', projectId: null, sessionId: null }
      });
      medusaExchanges.bindHubId(original.exchange_id, 'hub-follow-instruction', { hubStatus: 'received' });

      // The Master follows its own nudge literally: `<sender-workspace-id>`
      // filled in with the real sender it names (builder-ws), `<message-id>`
      // with the Hub id the message actually arrived under.
      const reply = medusaExchanges.createSendIntent({
        meta: medusaExchanges.validateSendMeta({ inReplyTo: 'hub-follow-instruction' }, { kind: 'master' }, null),
        sender: { projectId: null, sessionId: 'master', workspaceId: 'master-ws' },
        recipient: { workspaceId: 'builder-ws', projectId: 20 }
      });
      assert.equal(reply.in_reply_to, original.exchange_id, 'the demonstrated body binds the reply');
      medusaExchanges.bindHubId(reply.exchange_id, 'hub-master-followed-nudge', { hubStatus: 'received' });
      const repliedFact = require('../lib/store').medusaExchanges.facts(original.exchange_id).find((f) => f.fact === 'replied');
      assert.ok(repliedFact, 'the original is marked replied');
      assert.equal(repliedFact.actor, 'master');
    });
  });

  it('tells a suggest-tier Master it may send too — only read-only is refused the POST form (#2176)', () => {
    const base = require('../lib/master').MASTER_MEDUSA_API_BASE;
    withMasterAccessLevel('suggest', () => {
      const line = wake._nudgeLineFor(base, 2, 'http://localhost:3102');
      assert.match(line, /POST \/api\/master\/medusa\/send/);
    });
  });

  it('never tells a read-only Project Master to POST a reply its access level refuses (#2176)', () => {
    // The Master's own baseline rule is read-only by default (`accessLevel`
    // defaults to `read-only`), and `POST .../send` answers 403 `ACCESS_LEVEL`
    // at that tier (`masterMedusaOutbound`). The old wording told it to POST
    // anyway — instructing it to do what its own contract and the route both
    // refuse, the exact deadlock #2176 reports. The fix reworks the wording; it
    // must NOT widen the Master's outbound authority as a side effect.
    const base = require('../lib/master').MASTER_MEDUSA_API_BASE;
    const wakeTransports = require('../lib/wake-transports');
    withMasterAccessLevel('read-only', () => {
      const line = wake._nudgeLineFor(base, 2, 'http://localhost:3102');
      assert.doesNotMatch(line, /POST \/api\/master\/medusa\/send/, 'never instructs a send the route would refuse');
      assert.doesNotMatch(line, /tc message/, 'no tc message command reaches the Master');
      assert.match(line, /GET \/api\/master\/medusa\/messages/, 'can still read its inbox');
      assert.match(line, /Sending is disabled at your current access level/);
      assert.match(line, /describe the exact reply for the operator to send/, 'mirrors the baseline read-only rule');
      // Marking handled is not gated by access level (only send/loop are), so
      // the nudge still names it, with the Master's own binding headers.
      assert.match(line, /POST \/api\/master\/medusa\/read \{"ids":\[\.\.\.\]\}/);
      assert.match(line, /x-tangleclaw-role: master and x-tangleclaw-launch-id: \$TANGLECLAW_LAUNCH_ID/);
      assert.doesNotMatch(line, /x-tangleclaw-project-id/, 'the Master has no project to claim');
      assert.ok(!line.includes('\n'), 'still one line');
      assert.ok(line.length <= wake.COMPOSER_VERBATIM_MAX - 50, 'stays well under the composer paste limit');
      assert.equal(
        wake.isOwnNudge(wakeTransports.withNonce(line, '0123456789ab')),
        true,
        'the stranded-nudge detector recognises the read-only form too'
      );
    });
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

// #918. A sender cannot see a peer's pane, so "why has my message not been
// picked up?" was answerable only by leaving the protocol. The monitor already
// decides the answer on every tick; these pin that what it hands a sender is
// that decision — a reason code with a timestamp — and nothing it did not see.
describe('medusa-wake — peer reachability verdicts (#918)', () => {
  let saved;
  let clock;
  const PEER = 'proj-a-abc123';

  beforeEach(() => {
    wake.stop();
    saved = { ...wake._internal };
    clock = Date.parse('2026-09-12T10:00:00.000Z');
    wake._internal.now = () => clock;
    wake._internal.masterKey = () => 'master';
    wake._internal.registeredWorkspaceId = () => null;
  });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  /** Advance the stub clock by `ms` and run one tick. */
  function tickAt(ms) {
    clock += ms;
    wake._internal.tick();
  }

  it('reports a dialog as `pane-no-prompt`, and keeps `since` while `observedAt` moves', () => {
    installWorld({ pane: DIALOG_PANE });
    tickAt(0);
    const first = wake.peerReachability(PEER);
    assert.equal(first.local, true);
    assert.equal(first.reason, 'pane-no-prompt');
    assert.equal(first.since, '2026-09-12T10:00:00.000Z');
    assert.equal(first.observedAt, '2026-09-12T10:00:00.000Z');

    tickAt(5000);
    const second = wake.peerReachability(PEER);
    assert.equal(second.reason, 'pane-no-prompt');
    assert.equal(second.since, '2026-09-12T10:00:00.000Z', 'the dialog has been up since the first observation');
    assert.equal(second.observedAt, '2026-09-12T10:00:05.000Z', 'but it was re-confirmed just now');
  });

  it('reports typed input under the cursor as `pane-composer-has-input`, in the verdict and the ledger', () => {
    const world = installWorld({ pane: PANE_WITH_PROMPT_TEXT, cursor: TYPED_CURSOR });
    tickAt(0);
    assert.equal(wake.peerReachability(PEER).reason, 'pane-composer-has-input');
    assert.deepEqual(world.recorded.map((r) => r.skipReason), ['pane-composer-has-input']);
  });

  it('resets `since` when the reason changes', () => {
    const world = installWorld({ pane: DIALOG_PANE });
    tickAt(0);
    world.pane = BUSY_PANE;
    tickAt(5000);
    const v = wake.peerReachability(PEER);
    assert.equal(v.reason, 'pane-turn-in-flight');
    assert.equal(v.since, '2026-09-12T10:00:05.000Z');
  });

  it('says `wake-not-opted-in` explicitly — even with no mail, because that gate is what the monitor observed', () => {
    const world = installWorld({ config: { medusaWake: false } });
    tickAt(0);
    assert.equal(wake.peerReachability(PEER).reason, 'wake-not-opted-in');
    world.status = { ...world.status, unread: 0 };
    tickAt(5000);
    assert.equal(wake.peerReachability(PEER).reason, 'wake-not-opted-in');
  });

  it('says `no-mail` for an opted-in session with nothing unread', () => {
    installWorld({ status: { state: 'listening', workspaceId: PEER, unread: 0, lastError: null } });
    tickAt(0);
    assert.equal(wake.peerReachability(PEER).reason, 'no-mail');
  });

  it('reports `pane-at-prompt` during the debounce, then `nudged` — and `nudged` holds while the mail sits unhandled', () => {
    installWorld();
    tickAt(0);
    assert.equal(wake.peerReachability(PEER).reason, 'pane-at-prompt');
    tickAt(5000);
    assert.equal(wake.peerReachability(PEER).reason, 'nudged');
    tickAt(5000);
    const held = wake.peerReachability(PEER);
    assert.equal(held.reason, 'nudged');
    assert.equal(held.since, '2026-09-12T10:00:05.000Z');
  });

  it('names a failed injection by code, without the tmux error text', () => {
    installWorld({ injectResult: { ok: false, error: 'tmux: /private/secret path gone' } });
    tickAt(0);
    tickAt(5000);
    const v = wake.peerReachability(PEER);
    assert.equal(v.reason, 'inject-failed');
    assert.ok(!JSON.stringify(v).includes('secret'));
  });

  it('never carries pane content — only the fixed fields', () => {
    const SECRET = 'API_KEY=sk-do-not-leak';
    installWorld({ pane: [SECRET, '  Do you want to proceed?', '❯ 1. Yes', '  2. No'] });
    tickAt(0);
    const v = wake.peerReachability(PEER);
    // #2086 added `class`, `nextAction` and `nextActionMeaning`: three more
    // fixed fields, each taken from a declared table by the reason code.
    assert.deepEqual(Object.keys(v).sort(), ['class', 'local', 'meaning', 'monitorRunning', 'nextAction', 'nextActionMeaning', 'observedAt', 'reason', 'since', 'workspaceId']);
    assert.equal(v.meaning, wake.PEER_REASON_MEANINGS['pane-no-prompt'], 'the meaning is the declared text for the code, nothing captured');
    const disposition = require('../lib/medusa-delivery-disposition');
    assert.equal(v.nextActionMeaning, disposition.NEXT_ACTIONS[v.nextAction], 'the next action is the declared text for its code, nothing captured');
    assert.ok(Object.prototype.hasOwnProperty.call(disposition.NEXT_ACTIONS, v.nextAction));
    assert.ok([...disposition.CLASSES, 'none'].includes(v.class));
    assert.ok(!JSON.stringify(v).includes(SECRET));
  });

  it('answers `local: false` and nothing else for a workspace no local session holds', () => {
    installWorld();
    tickAt(0);
    assert.deepEqual(wake.peerReachability('someone-elses-host-1234abcd'), {
      workspaceId: 'someone-elses-host-1234abcd', local: false
    });
    assert.deepEqual(wake.peerReachability(''), { workspaceId: '', local: false });
  });

  it('answers `not-observed` for a local session the monitor has not scanned yet — never a guessed state', () => {
    installWorld();
    const v = wake.peerReachability(PEER);
    assert.equal(v.local, true);
    assert.equal(v.reason, 'not-observed');
    assert.equal(v.since, null);
    assert.equal(v.observedAt, null);
  });

  it('resolves a session whose listener is off through the registry', () => {
    const world = installWorld({ status: { state: 'off', workspaceId: null, unread: 0, lastError: null } });
    wake._internal.registeredWorkspaceId = (c) => (c.key === world.sessions[0].id ? 'toggled-off-9999aaaa' : null);
    tickAt(0);
    const v = wake.peerReachability('toggled-off-9999aaaa');
    assert.equal(v.local, true);
    assert.equal(v.reason, 'listener-off', 'and its verdict is the off listener the monitor saw');
  });

  it('resolves the Project Master by its listener key, with no tmux probe', () => {
    const world = installWorld({ sessions: [] });
    wake._internal.getStatus = (key) => (key === 'master'
      ? { state: 'listening', workspaceId: 'project-master-0000beef', unread: 0, lastError: null }
      : { state: 'off', workspaceId: null, unread: 0, lastError: null });
    wake._internal.masterWakeRecord = () => { throw new Error('peer resolution must not probe tmux'); };
    const v = wake.peerReachability('project-master-0000beef');
    assert.equal(v.local, true);
    assert.equal(v.reason, 'not-observed');
    assert.equal(world.injected.length, 0);
  });

  // R-2. The Master is always a candidate, so unlike an ended project session
  // it never drops out to `local: false`. Before this, a stopped Master read
  // `not-observed` forever — a promise of an assessment nothing would make.
  describe('a Project Master that is not running', () => {
    const MASTER_WS = 'project-master-0000beef';

    /** A world with no project sessions whose Master is registered but its listener is off. */
    function masterWorld(masterRecord) {
      const world = installWorld({ sessions: [], masterRecord });
      wake._internal.getStatus = () => ({ state: 'off', workspaceId: null, unread: 0, lastError: null });
      wake._internal.registeredWorkspaceId = (c) => (c.record === null ? MASTER_WS : null);
      return world;
    }

    it('reads `not-running` once a tick found no Master, stamped with that tick', () => {
      masterWorld(null);
      tickAt(0);
      const v = wake.peerReachability(MASTER_WS);
      assert.equal(v.local, true, 'still this host\'s Master — only stopped');
      assert.equal(v.reason, 'not-running');
      assert.equal(v.meaning, wake.PEER_REASON_MEANINGS['not-running']);
      assert.equal(v.since, '2026-09-12T10:00:00.000Z');
      assert.equal(v.observedAt, '2026-09-12T10:00:00.000Z');

      tickAt(5000);
      const again = wake.peerReachability(MASTER_WS);
      assert.equal(again.since, '2026-09-12T10:00:00.000Z', 'stopped since the first observation');
      assert.equal(again.observedAt, '2026-09-12T10:00:05.000Z', 're-observed just now');
    });

    it('is `not-observed` before any tick has looked, not `not-running`', () => {
      masterWorld(null);
      assert.equal(wake.peerReachability(MASTER_WS).reason, 'not-observed');
    });

    it('reports a running Master\'s own verdict, and `not-running` from the tick it stops', () => {
      const world = masterWorld({
        id: 'master', isMaster: true, name: 'Project Master', tmuxSession: 'tangleclaw-master',
        engineId: 'claude', sessionMode: 'tmux', status: 'active', medusaWake: true, apiBase: '/api/master/medusa'
      });
      tickAt(0);
      assert.equal(wake.peerReachability(MASTER_WS).reason, 'listener-off');
      world.masterRecord = null;
      tickAt(5000);
      const v = wake.peerReachability(MASTER_WS);
      assert.equal(v.reason, 'not-running');
      assert.equal(v.since, '2026-09-12T10:00:05.000Z');
    });

    it('does not read a probe that THREW as a stopped Master', () => {
      masterWorld(null);
      wake._internal.masterWakeRecord = () => { throw new Error('tmux exploded'); };
      tickAt(0);
      assert.equal(wake.peerReachability(MASTER_WS).reason, 'not-observed');
    });
  });

  // R-11. The registry lookup runs per candidate; an unreadable registry used to
  // log once per live session on every request. Guarded by COUNTING.
  describe('registry reads per lookup', () => {
    /** Three live sessions of one project, none holding a running listener. */
    function threeSessionWorld() {
      const world = installWorld({
        sessions: [claudeSession(1), claudeSession(2), claudeSession(3)],
        status: { state: 'off', workspaceId: null, unread: 0, lastError: null }
      });
      wake._internal.registeredWorkspaceId = saved.registeredWorkspaceId;
      wake._internal.masterKey = () => 'master';
      return world;
    }

    /** Capture warn-level log lines for the duration of `fn`. */
    function captureWarnings(fn) {
      const logger = require('../lib/logger');
      const lines = [];
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (line) => lines.push(line) });
      try { fn(); } finally {
        logger.setConsoleStream(null);
        logger.setLevel('error');
      }
      return lines;
    }

    it('reads each project\'s registry once however many of its sessions are candidates', () => {
      threeSessionWorld();
      const reads = [];
      wake._internal.readRegistry = (projectPath) => {
        reads.push(projectPath);
        return { 3: 'third-session-1234abcd' };
      };
      const realMaster = require('../lib/master').masterMedusaTarget;
      require('../lib/master').masterMedusaTarget = () => ({ projectPath: '/tmp/master-home', sessionId: 'master' });
      try {
        assert.equal(wake.peerReachability('nobody-here-00000000').local, false);
      } finally {
        require('../lib/master').masterMedusaTarget = realMaster;
      }
      assert.deepEqual(reads.sort(), ['/tmp/master-home', '/tmp/proj-a'], 'one read per registry file, not one per session');
      const found = wake.peerReachability('third-session-1234abcd');
      assert.equal(found.local, true);
    });

    it('logs one warning per lookup when the registry cannot be read, not one per session', () => {
      threeSessionWorld();
      wake._internal.getProject = () => { throw new Error('store is gone'); };
      const lines = captureWarnings(() => {
        assert.equal(wake.peerReachability('nobody-here-00000000').local, false);
      });
      const registryWarnings = lines.filter((l) => l.includes('registry read failed'));
      assert.equal(registryWarnings.length, 1, lines.join(''));
    });

    it('an unparsable registry file on disk warns once per lookup through the real registry module', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-registry-'));
      try {
        fs.mkdirSync(path.join(dir, '.tangleclaw', 'medusa'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.tangleclaw', 'medusa', 'registry.json'), '{not json');
        const world = threeSessionWorld();
        world.project = { id: 10, name: 'proj-a', path: dir };
        wake._internal.readRegistry = saved.readRegistry;
        wake._internal.masterKey = () => 'master';
        const realMaster = require('../lib/master').masterMedusaTarget;
        require('../lib/master').masterMedusaTarget = () => ({ projectPath: path.join(dir, 'no-master'), sessionId: 'master' });
        let lines;
        try {
          lines = captureWarnings(() => {
            assert.equal(wake.peerReachability('nobody-here-00000000').local, false);
          });
        } finally {
          require('../lib/master').masterMedusaTarget = realMaster;
        }
        assert.equal(lines.filter((l) => l.includes('corrupt JSON')).length, 1, lines.join(''));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // R-8/R-10. A gate that returns no code is a defect; the docstring promised it
  // would be loud, so it is — once per session per entry into the state.
  it('logs a missing reason code once on entering `unclassified`, not on every tick', () => {
    const logger = require('../lib/logger');
    const lines = [];
    logger.setLevel('warn');
    logger.setConsoleStream({ write: (line) => lines.push(line) });
    const st = { verdict: null };
    try {
      wake._noteVerdict(st, undefined, 7);
      wake._noteVerdict(st, undefined, 7);
      wake._noteVerdict(st, '', 7);
      assert.equal(st.verdict.reason, 'unclassified');
      wake._noteVerdict(st, 'no-mail', 7);
      wake._noteVerdict(st, undefined, 7);
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
    const warned = lines.filter((l) => l.includes('returned no reason code'));
    assert.equal(warned.length, 2, `one per transition into unclassified:\n${lines.join('')}`);
    assert.match(warned[0], /sessionId=7/);
  });

  it('says whether the monitor is still refreshing the verdict', () => {
    installWorld();
    tickAt(0);
    assert.equal(wake.peerReachability(PEER).monitorRunning, false);
    wake.start({ intervalMs: 60 * 60 * 1000 });
    assert.equal(wake.peerReachability(PEER).monitorRunning, true);
  });

  it('every gate names what it observed — no tick leaves an unclassified verdict', () => {
    const worlds = [
      { sessions: [{ ...claudeSession(1), sessionMode: 'webui' }] },
      { sessions: [{ ...claudeSession(1), engineId: 'codex' }] },
      { sessions: [{ ...claudeSession(1), status: 'ended' }] },
      { project: null },
      { wrapRunning: true },
      { config: { medusaWake: false } },
      { status: { state: 'connecting', workspaceId: PEER, unread: 1, lastError: null } },
      { status: { state: 'listening', workspaceId: PEER, unread: 0, lastError: null } },
      { status: { state: 'listening', workspaceId: PEER, unread: 2, lastError: null }, inbox: [] },
      { pane: DIALOG_PANE },
      { pane: BUSY_PANE },
      {}
    ];
    for (const w of worlds) {
      wake.stop();
      installWorld(w);
      tickAt(5000);
      tickAt(5000);
      const v = wake.peerReachability(PEER);
      assert.equal(v.local, true, `fixture resolves: ${JSON.stringify(w)}`);
      assert.notEqual(v.reason, 'unclassified', `a gate returned no code for ${JSON.stringify(w)}`);
      assert.notEqual(v.reason, 'not-observed', `the tick recorded nothing for ${JSON.stringify(w)}`);
    }
  });
});

// R-7. The reason vocabulary is declared ONCE (`PEER_REASON_MEANINGS`). These
// derive the codes the monitor can emit from the producing SOURCE — the return
// sites of `_judgeSession`, the assessor reasons it prefixes, and the answers
// `peerReachability`/`_noteVerdict` build — rather than from a typed list, so a
// new gate that is not declared turns this red instead of shipping a bare code.
describe('medusa-wake — the peer reason vocabulary is declared for every code emitted (#918)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'medusa-wake.js'), 'utf8');

  /** The source of a top-level function, through its closing column-0 brace. */
  function topLevelFunction(name) {
    const start = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `lib/medusa-wake.js has no top-level function ${name}`);
    const end = SRC.indexOf('\n}\n', start);
    return SRC.slice(start, end + 2);
  }

  /** Drop comments so prose naming a code is never read as producing it. */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }

  /** Kebab-case string literals, minus those only compared against. */
  function codeLiterals(expr) {
    const cleaned = expr.replace(/[!=]==\s*'[^']*'/g, '');
    return [...cleaned.matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)].map((m) => m[1]);
  }

  /** Template-literal prefixes (`` `listener-${…}` `` → `listener-`). */
  function templatePrefixes(expr) {
    return [...expr.matchAll(/`([a-z-]*)\$\{/g)].map((m) => m[1]);
  }

  /** Every reason code the wake monitor can hand a sender, derived from source. */
  function emittedCodes() {
    const exact = new Set();
    const prefixes = new Set();

    // The assessor reasons `_judgeSession` prefixes with `pane-`.
    const assessorReasons = ['_assessActivity', '_assessPane']
      .flatMap((fn) => [...stripComments(topLevelFunction(fn)).matchAll(/reason:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    assert.ok(assessorReasons.length >= 5, `the assessor scan found reasons: ${assessorReasons}`);
    const idleOwn = [...stripComments(topLevelFunction('assessSessionIdle')).matchAll(/reason:\s*'(pane-[a-z-]+)'/g)].map((m) => m[1]);

    let judge = stripComments(topLevelFunction('_judgeSession'));
    const recordStart = judge.indexOf('  function record(');
    assert.ok(recordStart >= 0, 'the nested ledger writer moved; update this scan');
    judge = judge.slice(0, recordStart) + judge.slice(judge.indexOf('\n  }\n', recordStart) + 4);

    const returns = [...judge.matchAll(/\breturn\b([^;]*);/g)].map((m) => m[1].trim());
    assert.ok(returns.length >= 10, `the return scan found ${returns.length} sites`);
    for (const expr of returns) {
      let source = expr;
      if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
        const def = judge.match(new RegExp(`const ${expr} = ([^;]*);`));
        assert.ok(def, `return ${expr}: no single-line const definition to derive its codes from`);
        source = def[1];
      } else {
        assert.ok(/^('[^']*'|`[^`]*`)$/.test(expr),
          `_judgeSession returns \`${expr || '(nothing)'}\` — a site this scan cannot derive a code from`);
      }
      const lits = codeLiterals(source);
      const pres = templatePrefixes(source);
      assert.ok(lits.length + pres.length > 0, `return ${expr}: yields no code`);
      lits.forEach((c) => exact.add(c));
      pres.forEach((p) => prefixes.add(p));
    }
    if (prefixes.delete('pane-')) {
      assessorReasons.forEach((r) => exact.add(`pane-${r}`));
      idleOwn.forEach((r) => exact.add(r));
    }

    for (const fn of ['peerReachability', '_noteVerdict']) {
      codeLiterals(stripComments(topLevelFunction(fn))).forEach((c) => exact.add(c));
    }
    return { exact, prefixes };
  }

  it('every exact code a return site can emit has a declared meaning', () => {
    const { exact } = emittedCodes();
    for (const code of exact) {
      assert.equal(typeof wake.peerReasonMeaning(code), 'string', `\`${code}\` is emitted but has no declared meaning`);
    }
  });

  it('every variable-tail code a return site can emit has a declared prefix', () => {
    const { prefixes } = emittedCodes();
    assert.ok(prefixes.size >= 2, `found prefixes: ${[...prefixes]}`);
    for (const prefix of prefixes) {
      assert.ok(Object.prototype.hasOwnProperty.call(wake.PEER_REASON_PREFIX_MEANINGS, prefix),
        `\`${prefix}<tail>\` is emitted but no prefix meaning is declared`);
    }
  });

  it('declares nothing no site emits — every declared code is derived from a producer', () => {
    const { exact } = emittedCodes();
    for (const code of Object.keys(wake.PEER_REASON_MEANINGS)) {
      assert.ok(exact.has(code), `\`${code}\` is declared but nothing in lib/medusa-wake.js emits it`);
    }
  });

  it('every declared code, exact or prefixed, has a non-empty meaning', () => {
    for (const [code, meaning] of Object.entries(wake.PEER_REASON_MEANINGS)) {
      assert.ok(typeof meaning === 'string' && meaning.length > 0, code);
      assert.equal(wake.peerReasonMeaning(code), meaning);
    }
    for (const prefix of Object.keys(wake.PEER_REASON_PREFIX_MEANINGS)) {
      const meaning = wake.peerReasonMeaning(`${prefix}sometail`);
      assert.match(meaning, /sometail/, `${prefix} fills its tail`);
      assert.equal(wake.peerReasonMeaning(prefix), null, 'a bare prefix is not a code');
    }
  });

  it('an unknown code has no meaning — relayed as-is, never given a guessed one', () => {
    assert.equal(wake.peerReasonMeaning('a-future-code'), null);
    assert.equal(wake.peerReasonMeaning(''), null);
    assert.equal(wake.peerReasonMeaning(undefined), null);
    assert.equal(wake.peerReasonMeaning('toString'), null, 'no prototype key reads as declared');
  });
});

describe('medusa-wake — verdictFor exposes per-session hold reason for the projects layer (#2578)', () => {
  let saved;
  let clock;

  beforeEach(() => {
    wake.stop();
    saved = { ...wake._internal };
    clock = Date.parse('2026-09-12T10:00:00.000Z');
    wake._internal.now = () => clock;
    wake._internal.masterKey = () => 'master';
    wake._internal.registeredWorkspaceId = () => null;
  });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('returns null for a session the monitor has not yet assessed', () => {
    assert.equal(wake.verdictFor(999), null);
  });

  it('returns the pane-composer-has-input verdict for a session whose composer has typed input', () => {
    installWorld({ pane: PANE_WITH_PROMPT_TEXT, cursor: TYPED_CURSOR });
    wake._internal.tick();
    const v = wake.verdictFor(1); // claudeSession(1).id === 1
    assert.ok(v, 'verdict is set after a tick');
    assert.equal(v.reason, 'pane-composer-has-input');
    assert.equal(typeof v.since, 'string');
    assert.equal(typeof v.observedAt, 'string');
  });

  it('returns the pane-not-at-rest verdict for an antigravity session whose pane lacks the at-rest marker', () => {
    installWorld({ sessions: [antigravitySession(1)], pane: AG_DIALOG_PANE });
    wake._internal.tick();
    const v = wake.verdictFor(1); // antigravitySession(1).id === 1
    assert.ok(v, 'verdict is set after a tick');
    assert.equal(v.reason, 'pane-not-at-rest');
  });

  it('returns a shallow copy so the caller cannot mutate the stored verdict', () => {
    installWorld({ pane: PANE_WITH_PROMPT_TEXT, cursor: TYPED_CURSOR });
    wake._internal.tick();
    const v1 = wake.verdictFor(1);
    v1.reason = 'tampered';
    const v2 = wake.verdictFor(1);
    assert.notEqual(v2.reason, 'tampered', 'stored verdict is not mutated by the caller');
  });
});
