'use strict';

// A wake nudge whose Enter was lost sits in the composer unsubmitted (#1621).
// The receipt check sees its nonce there and the watchdog re-arms the wake, but
// the re-arm passes the same draft gate as any wake — and that gate used to read
// the switchboard's own stranded nudge as the operator's half-typed text, so it
// refused the re-arm, and every later wake, until the exchange escalated.
//
// These tests pin the one exemption: a composer holding ONLY a switchboard nudge
// and its wake ref is safe to clear and re-paste. Any operator text alongside it,
// or a composer whose end was not seen, is still refused.

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-stranded-nudge');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const wakeTransports = require('../lib/wake-transports');

const CLAUDE = wake.ENGINE_WAKE_PROFILES.claude;
const NBSP = ' ';
const DIVIDER = '──────────────────────────────────────────────────────────────────────────────';
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';

/** A nudge exactly as the wake monitor pastes it. */
function strandedNudge(projectName = 'proj-a', unread = 1, nonce = 'a1b2c3d4e5f6') {
  const line = wake._nudgeLineFor(`/api/sessions/${encodeURIComponent(projectName)}/medusa`, unread, 'http://localhost:3102');
  return wakeTransports.withNonce(line, nonce);
}

/**
 * The text as Claude Code renders it in its composer box: the glyph and its pad
 * on the first row, continuation rows indented to the text column, wrapped at a
 * fixed width with no regard for word boundaries.
 * @param {string} text - The composer contents.
 * @param {number} [width] - Text columns per row.
 * @returns {{rows: string[], cursor: {x: number, y: number, line: string}}}
 */
function renderComposer(text, width = 76) {
  const chunks = [];
  for (let i = 0; i < text.length; i += width) chunks.push(text.slice(i, i + width));
  const rows = chunks.map((c, i) => (i === 0 ? `❯${NBSP}${c}` : `  ${c}`));
  const last = rows[rows.length - 1];
  return { rows, cursor: { x: [...last].length, y: 0, line: last } };
}

/** A resting Claude pane whose composer holds `text`. */
function paneHolding(text, { lowerBorder = true } = {}) {
  const { rows, cursor } = renderComposer(text);
  const lines = ['⏺ Done — the branch is pushed.', '', DIVIDER, ...rows];
  if (lowerBorder) lines.push(DIVIDER, FOOTER);
  return { lines, cursor };
}

describe('isOwnNudge — the composer holds only the switchboard\'s nudge (#1621)', () => {
  it('matches a nudge the monitor produced, for a project and for the Master', () => {
    assert.equal(wake.isOwnNudge(strandedNudge()), true);
    assert.equal(wake.isOwnNudge(strandedNudge('My Proj', 12)), true, 'an encoded name and a two-digit count');
    const master = wakeTransports.withNonce(wake._nudgeLineFor('/api/master/medusa', 3, 'https://localhost:3102'), '0123456789ab');
    assert.equal(wake.isOwnNudge(master), true);
  });

  it('matches the nudge however the composer wrapped it', () => {
    const { rows } = renderComposer(strandedNudge(), 33);
    assert.equal(wake.isOwnNudge(rows.map((r) => r.replace(/^❯ |^ {2}/, '')).join('\n')), true);
  });

  it('matches when the API origin could not be resolved', () => {
    const line = wake._nudgeLineFor('/api/sessions/proj-a/medusa', 1, 'the TangleClaw API');
    assert.equal(wake.isOwnNudge(wakeTransports.withNonce(line, 'a1b2c3d4e5f6')), true);
  });

  it('refuses operator text before or after the nudge', () => {
    assert.equal(wake.isOwnNudge(`${strandedNudge()} and also rebase first`), false);
    assert.equal(wake.isOwnNudge(`wait — ${strandedNudge()}`), false);
  });

  it('refuses a nudge with no wake ref, or a malformed one', () => {
    const line = wake._nudgeLineFor('/api/sessions/proj-a/medusa', 1, 'http://localhost:3102');
    assert.equal(wake.isOwnNudge(line), false, 'no wake ref: not an attempt this monitor made');
    assert.equal(wake.isOwnNudge(`${line} (wake ref xyz)`), false);
    assert.equal(wake.isOwnNudge(`${line} (wake ref a1b2c3d4e5f6a1)`), false, 'a longer ref is not a nonce');
  });

  it('refuses a nudge whose three paths disagree', () => {
    const tampered = strandedNudge().replace('/api/sessions/proj-a/medusa/send', '/api/sessions/other/medusa/send');
    assert.equal(wake.isOwnNudge(tampered), false);
  });

  it('refuses ordinary text and non-strings', () => {
    assert.equal(wake.isOwnNudge('can you check why tilt-claw is not responding?'), false);
    assert.equal(wake.isOwnNudge(''), false);
    assert.equal(wake.isOwnNudge(null), false);
    assert.equal(wake.isOwnNudge(undefined), false);
  });
});

describe('_assessPane — a stranded nudge does not block its own re-arm (#1621)', () => {
  it('a wrapped nudge with the cursor on its last row is safe to type into', () => {
    const { lines, cursor } = paneHolding(strandedNudge());
    assert.deepEqual(wake._assessPane(lines, CLAUDE, cursor), { idle: true, reason: 'at-prompt' });
  });

  it('a nudge that fits the glyph row is safe to type into', () => {
    const text = strandedNudge();
    const row = `❯${NBSP}${text}`;
    const lines = [DIVIDER, row, DIVIDER, FOOTER];
    assert.deepEqual(wake._assessPane(lines, CLAUDE, { x: [...row].length, y: 0, line: row }), { idle: true, reason: 'at-prompt' });
  });

  it('the nudge with operator text after it is still refused', () => {
    const { lines, cursor } = paneHolding(`${strandedNudge()} and please rebase first`);
    assert.equal(wake._assessPane(lines, CLAUDE, cursor).idle, false);
  });

  it('operator text alone is still refused exactly as before', () => {
    const typed = `❯${NBSP}can you check why tilt-claw isn't responding?`;
    const lines = [DIVIDER, typed, DIVIDER, FOOTER];
    assert.deepEqual(wake._assessPane(lines, CLAUDE, { x: [...typed].length, y: 0, line: typed }),
      { idle: false, reason: 'composer-has-input' });
  });

  it('a composer whose end was not seen is still refused', () => {
    const { lines, cursor } = paneHolding(strandedNudge(), { lowerBorder: false });
    assert.equal(wake._assessPane(lines, CLAUDE, cursor).idle, false);
  });

  it('without a cursor nothing can be located, so the text check still refuses', () => {
    const { lines } = paneHolding(strandedNudge());
    assert.equal(wake._assessPane(lines, CLAUDE, null).idle, false);
  });

  it('a busy turn still wins over a stranded nudge', () => {
    const { lines, cursor } = paneHolding(strandedNudge());
    const busy = ['✻ Churning… (12s · esc to interrupt)', ...lines];
    assert.equal(wake._assessPane(busy, CLAUDE, cursor).idle, false);
  });
});

describe('the wake monitor replaces a stranded nudge (#1621)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  /**
   * The same happy-path seams `test/medusa-wake.test.js` installs, with the pane
   * holding a nudge whose Enter was lost.
   * @returns {object} The world the seams read.
   */
  function installStrandedWorld() {
    const { lines, cursor } = paneHolding(strandedNudge('proj-a', 1, 'ffffffffffff'));
    const world = {
      sessions: [{ id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' }],
      project: { id: 10, name: 'proj-a', path: '/tmp/proj-a' },
      status: { state: 'listening', workspaceId: 'proj-a-abc123', unread: 1, lastError: null },
      inbox: [{ id: 'm1', from: 'peer', message: 'hello' }],
      pane: lines,
      cursor,
      injected: [],
      recorded: []
    };
    wake._internal.recordDelivery = (entry) => { world.recorded.push(entry); };
    wake._internal.masterWakeRecord = () => null;
    wake._internal.injectMaster = () => ({ ok: true, error: null });
    wake._internal.listLiveAll = () => world.sessions;
    wake._internal.getProject = () => world.project;
    wake._internal.loadProjectConfig = () => ({ medusaWake: true });
    wake._internal.wrapRunning = () => false;
    wake._internal.getStatus = () => world.status;
    wake._internal.getMessages = () => world.inbox;
    wake._internal.capturePane = () => ({ lines: world.pane });
    wake._internal.cursorInfo = () => world.cursor;
    wake._internal.injectCommand = (projectName, command, options) => {
      world.injected.push({ projectName, command, options });
      return { ok: true, error: null };
    };
    return world;
  }

  it('injects a fresh nudge over the stranded one instead of refusing the pane', () => {
    const world = installStrandedWorld();
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1, 'the stranded nudge no longer blocks the wake');
    assert.deepEqual(world.recorded.map((r) => r.skipReason).filter(Boolean), []);
    const fresh = world.injected[0].command;
    assert.equal(wake.isOwnNudge(fresh), true, 'the replacement is itself a recognisable nudge');
    assert.doesNotMatch(fresh, /ffffffffffff/, 'with a new nonce, so its own receipt is distinguishable');
  });

  it('still refuses when the operator has typed after the stranded nudge', () => {
    const world = installStrandedWorld();
    const { lines, cursor } = paneHolding(`${strandedNudge('proj-a', 1, 'ffffffffffff')} hold on`);
    world.pane = lines;
    world.cursor = cursor;
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED + 1; i++) wake._internal.tick();
    assert.equal(world.injected.length, 0, 'operator text is never typed over');
  });
});
