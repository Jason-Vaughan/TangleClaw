'use strict';

// Tests for lib/medusa-wake.js (MED-2K9P v2 Slice 1, chunk T2) — the idle-gated
// wake-nudge monitor. Drives `_internal.tick()` deterministically with stubbed
// seams (no tmux, no Bridge, no store); `stop()` between tests clears state.
//
// The safety contract under test, in order:
//   1. a busy turn is NEVER interrupted (busy marker / no bare prompt / dialog)
//   2. the nudge carries only TC-controlled bytes (message text never injected)
//   3. one nudge per fresh-mail edge (watermark; burst = single wake)
//   4. explicit `medusaWake: true` only; listener must be `listening`
//   5. Slice-1 transport/engine gates (webui / non-claude skipped, logged once)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const wake = require('../lib/medusa-wake');

// ── Pane fixtures (from the 2026-07-11 live spike captures) ──

/** An idle Claude Code pane: bare prompt, no busy marker. */
const IDLE_PANE = [
  '❯ ',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
];
/** A busy Claude Code pane: bare prompt rendered, but a turn is in flight. */
const BUSY_PANE = [
  '❯ ',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents'
];
/** A permission dialog: the selector row is `❯ 1. Yes` — no BARE prompt line. */
const DIALOG_PANE = [
  '  Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently'
];
/** Operator mid-typing: prompt line is non-bare. */
const TYPING_PANE = [
  '❯ git status',
  '──────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
];

/** A live tmux Claude session record. */
function claudeSession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId: 'claude' };
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
    injected: [],
    injectResult: { ok: true, error: null },
    ...overrides
  };
  wake._internal.listLiveAll = () => world.sessions;
  wake._internal.getProject = () => world.project;
  wake._internal.loadProjectConfig = () => world.config;
  wake._internal.getStatus = () => world.status;
  wake._internal.getMessages = () => world.inbox;
  wake._internal.capturePane = () => ({ lines: world.pane });
  wake._internal.injectCommand = (projectName, command) => {
    world.injected.push({ projectName, command });
    return world.injectResult;
  };
  return world;
}

/** Tick enough times to clear the idle debounce. */
function tickThroughDebounce() {
  for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
}

describe('medusa-wake — _assessPane (the idle policy, pinned byte-for-byte)', () => {
  it('judges a bare-prompt pane with no busy marker idle', () => {
    assert.deepEqual(wake._assessPane(IDLE_PANE), { idle: true, reason: 'at-prompt' });
  });
  it('judges a turn-in-flight pane busy even though the bare prompt is rendered', () => {
    assert.deepEqual(wake._assessPane(BUSY_PANE), { idle: false, reason: 'turn-in-flight' });
  });
  it('refuses a permission dialog (selector row is not a bare prompt)', () => {
    assert.deepEqual(wake._assessPane(DIALOG_PANE), { idle: false, reason: 'no-bare-prompt' });
  });
  it('refuses to type over an operator\'s half-typed input', () => {
    assert.deepEqual(wake._assessPane(TYPING_PANE), { idle: false, reason: 'no-bare-prompt' });
  });
  it('strips ANSI before judging (a colored busy marker still blocks)', () => {
    const colored = ['❯ ', '[2mesc to interrupt[0m'];
    assert.deepEqual(wake._assessPane(colored), { idle: false, reason: 'turn-in-flight' });
  });
  it('judges an empty/unknown pane not-idle (fail closed)', () => {
    assert.equal(wake._assessPane([]).idle, false);
    assert.equal(wake._assessPane(['some random TUI']).idle, false);
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

describe('medusa-wake — gates (each one blocks alone)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  it('never injects while the pane shows a turn in flight', () => {
    const world = installWorld({ pane: BUSY_PANE });
    for (let i = 0; i < 5; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0);
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

  it('skips webui sessions and non-claude engines (Slice-1 gate)', () => {
    const webui = { id: 2, projectId: 20, sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:c1' };
    const gemini = { id: 3, projectId: 30, sessionMode: 'tmux', tmuxSession: 'tc-3', engineId: 'gemini' };
    const world = installWorld({ sessions: [webui, gemini] });
    tickThroughDebounce();
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
