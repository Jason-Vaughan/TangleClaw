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

  it('refuses one form\'s wording carrying the other form\'s base', () => {
    // Each form is matched only with its own kind of base: the monitor cannot
    // produce the project wording for the Master, or the Master's for a project.
    const project = wake._nudgeLineFor('/api/sessions/proj-a/medusa', 1, 'http://localhost:3102');
    const master = wake._nudgeLineFor('/api/master/medusa', 1, 'http://localhost:3102');
    assert.notEqual(project.replace(/\/api\/sessions\/proj-a\/medusa/g, ''), master.replace(/\/api\/master\/medusa/g, ''), 'the two forms differ');
    const crossed = (line, from, to) => wakeTransports.withNonce(line.split(from).join(to), 'a1b2c3d4e5f6');
    assert.equal(wake.isOwnNudge(crossed(project, '/api/sessions/proj-a/medusa', '/api/master/medusa')), false);
    assert.equal(wake.isOwnNudge(crossed(master, '/api/master/medusa', '/api/sessions/proj-a/medusa')), false);
  });

  it('refuses a nudge whose paths disagree', () => {
    // Only the Master's form names its base more than once; the project form
    // names it once, to stay under the composer's verbatim-paste limit. Pinned
    // to `write` (#2176) so the base still repeats via the `/send` path — the
    // `read-only` form (default) never names `/send` at all.
    const store = require('../lib/store');
    const before = store.config.load();
    store.config.save({ ...before, master: { ...before.master, accessLevel: 'write' } });
    try {
      const master = wakeTransports.withNonce(wake._nudgeLineFor('/api/master/medusa', 1, 'http://localhost:3102'), 'a1b2c3d4e5f6');
      assert.equal(wake.isOwnNudge(master), true);
      const tampered = master.replace('/api/master/medusa/send', '/api/sessions/other/medusa/send');
      assert.notEqual(tampered, master);
      assert.equal(wake.isOwnNudge(tampered), false);
    } finally {
      store.config.save(before);
    }
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

/**
 * The same happy-path seams `test/medusa-wake.test.js` installs, with the pane
 * holding a nudge whose Enter was lost. Module-scoped (not local to one
 * `describe`) so both the re-arm tests below and the resubmit tests further
 * down can build on the same base world.
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
  wake._internal.rotationOpen = () => false;
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

describe('the wake monitor replaces a stranded nudge (#1621)', () => {
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

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

describe('a not-accepted receipt presses Enter again before the re-arm retypes it (#1621)', () => {
  // The re-arm (#1621/#2716) recovers a stranded nudge too, but only after
  // `IDLE_TICKS_REQUIRED` consecutive idle ticks and a full retype. This is
  // the cheaper, faster first attempt: press Enter again over the exact same
  // text, with no retype, the moment the receipt says it is still sitting
  // there unsubmitted.
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  const FIXED_NONCE = 'deadbeefcafe';

  /**
   * The stranded-nudge world, wired so a nudge's receipt comes back
   * `not-accepted` and every `_attemptResubmit` seam is observable.
   * @returns {object} The world `installStrandedWorld` returns, extended
   *   with `sentKeys` and `rearmed`.
   */
  function installUnacceptedWorld() {
    const world = installStrandedWorld();
    // Fixed so the pane this world's `pane` already shows — set up below to
    // hold exactly this nonce — is recognisable as THIS attempt's own text,
    // not some other attempt's.
    wake._internal.newNonce = () => FIXED_NONCE;
    const { lines, cursor } = paneHolding(strandedNudge('proj-a', 1, FIXED_NONCE));
    world.pane = lines;
    world.cursor = cursor;
    world.sentKeys = [];
    wake._internal.sendRawKey = (session, key) => { world.sentKeys.push({ session, key }); };
    wake._internal.pendingWakeCount = () => 1;
    wake._internal.verifySubmission = async () => ({ outcome: 'not-accepted', reason: 'test' });
    world.rearmed = [];
    wake._internal.rearmWorkspace = (workspaceId) => { world.rearmed.push(workspaceId); };
    return world;
  }

  it('presses Enter again over the exact stranded attempt, and the re-arm still runs as the backstop', async () => {
    const world = installUnacceptedWorld();
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1, 'the nudge is delivered once');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.sentKeys, [{ session: 'tc-1', key: 'Enter' }]);
    assert.deepEqual(world.rearmed, [world.status.workspaceId], 'the re-arm is never skipped just because a resubmit ran');
  });

  it('never presses Enter once the pane has moved on since delivery (operator typed)', async () => {
    const world = installUnacceptedWorld();
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1);
    // Between the delivery and the (async) receipt check landing, the
    // operator typed alongside the stranded nudge.
    const { lines, cursor } = paneHolding(`${strandedNudge('proj-a', 1, FIXED_NONCE)} wait`);
    world.pane = lines;
    world.cursor = cursor;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.sentKeys, [], 'operator text beside the nudge is never submitted by a bare Enter');
    assert.deepEqual(world.rearmed, [world.status.workspaceId]);
  });

  it('never presses Enter over a DIFFERENT stranded attempt found sitting there', async () => {
    const world = installUnacceptedWorld();
    // The composer holds some OTHER own-nudge attempt's text, not this
    // delivery's — e.g. a still-unreplaced nudge from an earlier wake.
    const other = paneHolding(strandedNudge('proj-a', 1, 'ffffffffffff'));
    world.pane = other.lines;
    world.cursor = other.cursor;
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.sentKeys, [], 'a different attempt\'s stranded nudge is not this call\'s to finish');
  });

  it('a resubmit that throws does not stop the re-arm from running', async () => {
    const world = installUnacceptedWorld();
    wake._internal.sendRawKey = () => { throw new Error('tmux gone'); };
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.rearmed, [world.status.workspaceId]);
  });

  it('an accepted receipt never presses Enter', async () => {
    const world = installUnacceptedWorld();
    wake._internal.verifySubmission = async () => ({ outcome: 'accepted', reason: 'test' });
    for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick();
    assert.equal(world.injected.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world.sentKeys, []);
  });
});

describe('a terminal device-attributes reply in the composer does not hold a wake (#2555)', () => {
  const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
  const CX_STATUS = '  GPT-6-Astra default · Ready · Ask for approval';
  /**
   * A resting Codex pane whose composer row holds `typed`, cursor after it.
   * @param {string} typed - What the composer row holds after its glyph and pad.
   * @returns {{lines: string[], cursor: {x: number, y: number, line: string}}}
   */
  const codexHolding = (typed) => {
    const row = `› ${typed}`;
    return { lines: ['• Done.', '', row, '', CX_STATUS], cursor: { x: [...row].length, y: 0, line: row } };
  };

  it('recognises replies, and only replies', () => {
    for (const text of ['0;276;0c', '[>0;276;0c', '\x1b[>0;276;0c', '\x1b[?62;22c', '?1;2c', '0;276;0c0;276;0c', ' 0;276;0c ']) {
      assert.equal(wake.isTerminalReplyResidue(text), true, JSON.stringify(text));
    }
    for (const text of ['3c', 'abc', '12c', '0;276;0c fix the bug', 'fix 0;276;0c', '', null, 7]) {
      assert.equal(wake.isTerminalReplyResidue(text), false, JSON.stringify(text));
    }
  });

  it('a Codex composer holding only the reply is at the prompt', () => {
    const { lines, cursor } = codexHolding('0;276;0c');
    assert.equal(wake._composerEmpty(cursor, CODEX), false, 'the cursor alone reads it as input');
    assert.deepEqual(wake._assessPane(lines, CODEX, cursor), { idle: true, reason: 'at-prompt' });
  });

  it('the reply with anything typed beside it is still the operator\'s input', () => {
    for (const typed of ['0;276;0c fix the bug', 'fix the bug 0;276;0c', '3c']) {
      const { lines, cursor } = codexHolding(typed);
      assert.deepEqual(wake._assessPane(lines, CODEX, cursor), { idle: false, reason: 'composer-has-input' }, typed);
    }
  });

  it('text after the cursor is input, whatever is before it', () => {
    const row = '› 0;276;0c and more';
    const cursor = { x: [...'› 0;276;0c'].length, y: 0, line: row };
    assert.deepEqual(wake._assessPane(['• Done.', '', row, '', CX_STATUS], CODEX, cursor), { idle: false, reason: 'composer-has-input' });
  });

  it('a row led by the glyph below the composer still refuses, with the at-rest status row in view', () => {
    const { cursor } = codexHolding('0;276;0c');
    // The status row is kept, so the activity check passes and only the row
    // below the composer can refuse: that row is the selector of a dialog.
    const lines = [cursor.line, '', '  Would you like to run the following command?', '',
      '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', CX_STATUS];
    assert.deepEqual(wake._assessPane(lines, CODEX, cursor), { idle: false, reason: 'composer-has-input' });
  });

  it('a busy turn still wins over the reply', () => {
    const { lines, cursor } = codexHolding('0;276;0c');
    const busy = [...lines.slice(0, -1), '• Working (3s • esc to interrupt)', ...lines.slice(-1)];
    assert.equal(wake._assessPane(busy, CODEX, cursor).idle, false);
  });

  it('a Claude composer holding only the reply is at the prompt too', () => {
    const typed = `❯${NBSP}0;276;0c`;
    const lines = [DIVIDER, typed, DIVIDER, FOOTER];
    assert.deepEqual(wake._assessPane(lines, CLAUDE, { x: [...typed].length, y: 0, line: typed }), { idle: true, reason: 'at-prompt' });
  });
});

describe('the periodic medusa_deliveries sweep runs independent of record() (#2720)', () => {
  // Before this, `store.medusaDeliveries.prune` ran only from inside
  // `record()` itself, so a DORMANT project — every session ended, nothing
  // left to call `record()` — never had its rows trimmed again. This sweep
  // runs on a tick with no live session at all, which is exactly that case.
  let saved;
  beforeEach(() => { wake.stop(); saved = { ...wake._internal }; });
  afterEach(() => { Object.assign(wake._internal, saved); wake.stop(); });

  /**
   * Wire the seams the periodic sweep reads, with no live session and no
   * Master — the dormant-project shape this exists for.
   * @param {object} [overrides] - Per-seam overrides.
   * @returns {{pruned: object[], nowMs: number, setNow: Function}}
   */
  function installDormantWorld(overrides = {}) {
    // Comfortably past `PRUNE_EVERY_MS` from a zero epoch, like real
    // `Date.now()` is — `_lastMedusaDeliveryPruneAt` starts at 0 (`wake.stop()`
    // in `beforeEach`), so the first tick's `now - 0` must already clear the
    // window for the very first sweep to run, exactly as it does against a
    // real epoch-scale clock in production.
    let nowMs = wake.PRUNE_EVERY_MS * 10;
    wake._internal.now = () => nowMs;
    wake._internal.listLiveAll = overrides.listLiveAll || (() => []);
    wake._internal.masterWakeRecord = overrides.masterWakeRecord || (() => null);
    wake._internal.listProjects = overrides.listProjects || (() => [{ id: 10 }, { id: 20 }]);
    const pruned = [];
    wake._internal.pruneMedusaDeliveries = overrides.pruneMedusaDeliveries
      || ((options) => { pruned.push(options); return { endedSessions: 0, unattached: 0 }; });
    return { pruned, bump: (deltaMs) => { nowMs += deltaMs; } };
  }

  it('sweeps every known project on a tick with no live session at all', () => {
    const { pruned } = installDormantWorld();
    wake._internal.tick();
    assert.deepEqual(pruned, [{ projectId: 10 }, { projectId: 20 }],
      'every known project is swept, not only ones with a live session');
  });

  it('is rate-limited: a tick moments later does not sweep again', () => {
    const { pruned, bump } = installDormantWorld();
    wake._internal.tick();
    assert.equal(pruned.length, 2);
    bump(1000);
    wake._internal.tick();
    assert.equal(pruned.length, 2, 'a second tick inside PRUNE_EVERY_MS must not sweep again');
  });

  it('sweeps again once a full PRUNE_EVERY_MS has elapsed', () => {
    const { pruned, bump } = installDormantWorld();
    wake._internal.tick();
    assert.equal(pruned.length, 2);
    bump(wake.PRUNE_EVERY_MS);
    wake._internal.tick();
    assert.equal(pruned.length, 4, 'a full window elapsed, so the sweep ran again for every project');
  });

  it('one project\'s sweep failure does not stop the sweep for the rest, or the tick itself', () => {
    const { pruned } = installDormantWorld({
      listProjects: () => [{ id: 10 }, { id: 20 }, { id: 30 }],
      pruneMedusaDeliveries: (options) => {
        if (options.projectId === 20) throw new Error('db busy');
        pruned.push(options);
      }
    });
    assert.doesNotThrow(() => wake._internal.tick());
    assert.deepEqual(pruned, [{ projectId: 10 }, { projectId: 30 }],
      'the failing project is skipped; the others still swept');
  });

  it('a failure to list projects does not throw, and leaves nothing swept', () => {
    const { pruned } = installDormantWorld({ listProjects: () => { throw new Error('store unavailable'); } });
    assert.doesNotThrow(() => wake._internal.tick());
    assert.deepEqual(pruned, []);
  });

  it('still runs the ordinary per-session scan on the same tick (not a replacement for it)', () => {
    const sessions = [{ id: 1, projectId: 10, sessionMode: 'webui', tmuxSession: null, engineId: 'claude' }];
    const { pruned } = installDormantWorld({ listProjects: () => [{ id: 10 }], listLiveAll: () => sessions });
    const recorded = [];
    wake._internal.recordDelivery = (entry) => recorded.push(entry);
    wake._internal.getProject = () => ({ id: 10, name: 'proj-a', path: '/tmp/proj-a' });
    wake._internal.loadProjectConfig = () => ({ medusaWake: true });
    wake._internal.wrapRunning = () => false;
    wake._internal.rotationOpen = () => false;
    wake._internal.getStatus = () => ({ state: 'listening', workspaceId: 'proj-a-abc', unread: 1, lastError: null });
    wake._internal.getMessages = () => [{ id: 'm1', from: 'peer', message: 'hello' }];
    wake._internal.tick();
    assert.deepEqual(pruned, [{ projectId: 10 }], 'the sweep still ran');
    assert.equal(recorded.some((r) => r.skipReason === 'no-pane'), true, 'and the webui session was still scanned, unaffected');
  });
});
