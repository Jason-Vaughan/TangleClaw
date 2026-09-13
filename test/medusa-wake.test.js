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
  // Stubbed rather than left to the real registry: the fixture project names
  // resolve there too, so an unstubbed read makes this gate inert in every test
  // instead of exercised in one.
  wake._internal.wrapRunning = () => world.wrapRunning;
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
    assert.deepEqual(Object.keys(v).sort(), ['local', 'meaning', 'monitorRunning', 'observedAt', 'reason', 'since', 'workspaceId']);
    assert.equal(v.meaning, wake.PEER_REASON_MEANINGS['pane-no-prompt'], 'the meaning is the declared text for the code, nothing captured');
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
