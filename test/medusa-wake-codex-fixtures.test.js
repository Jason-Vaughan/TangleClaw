'use strict';

/*
 * The wake gate across Codex's engine states, on fixtures that say which
 * codex-cli version they came from (#2086).
 *
 * `test/_wake-fixtures.js` holds the Codex panes in `CODEX_FIXTURE_SETS`, each
 * set carrying `engine`, the exact `cliVersion` and the capture date, and each
 * pane saying whether it is a live capture or was derived. This file:
 *
 *   - checks that metadata, so no Codex pane fixture exists without a version;
 *   - runs every pane of every set against every answer the engine's channel
 *     can give, through the real gate, and pins what the gate does.
 *
 * What this proves is bounded by what was captured. The versions listed in
 * `PROVEN_CLI_VERSIONS` are the only ones proven; no other version is, and
 * nothing here infers that a neighbouring version behaves the same. The
 * channel's answers are TangleClaw's own normalized shape
 * (`lib/startup-control.js` `observeActivity`), not Codex wire bytes: the
 * app-server protocol is not proven here either. An answer names a Codex
 * version only where the profile declares what that exact version draws below
 * its composer (`capabilities.wake.restRows`), as the adapter's does, and the
 * stub here does the same for a set of such a version (`channelFor`).
 *
 * A captured version is not a supported one. The sets for 0.159.0, 0.161.0
 * and 0.162.0 exist to pin what the gate REFUSES on them (#2059); whether a
 * session of such a version may be woken at all is decided by the engine
 * profile's verified versions, which a block below reads.
 *
 * The 0.161.0 set file holds two launch paths. Its `panes`, which the matrix
 * here runs, are a plain launch on the shared daemon. Its captures over the
 * launch path TangleClaw uses are `channelPanes`, and a block below runs
 * those, beside 0.162.0's, whose `panes` are that launch path throughout.
 *
 * The trust and update dialogs are whole reads, each saying which screen Codex
 * drew it on (#2187). A dialog on the main screen keeps the opening composer
 * row above it, and one on the alternate screen does not; the pane gate holds
 * both, by different rules, and a block below pins which rule holds which.
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./_wake-fixtures');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-codex-fixtures');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');

const { CODEX_FIXTURE_SETS } = fixtures;

/** The codex-cli versions with captured fixtures. Every other version is unproven. */
const PROVEN_CLI_VERSIONS = ['0.155.1', '0.156.1', '0.159.0', '0.161.0', '0.162.0'];

const PROVENANCE = ['live-capture', 'derived'];

const IDLE = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };
const HELD = { channel: 'present', state: 'held', reasonCode: 'folder-untrusted' };

/**
 * What the engine's channel can answer. `open` is whether the session has a
 * channel at all; `answer` builds the reply for each read.
 */
const CHANNEL_ANSWERS = {
  idle: { open: true, answer: () => Promise.resolve(IDLE) },
  busy: { open: true, answer: () => Promise.resolve({ channel: 'present', state: 'busy', reasonCode: 'thread-active' }) },
  unknown: { open: true, answer: () => Promise.resolve({ channel: 'present', state: 'unknown', reasonCode: 'thread-ambiguous' }) },
  failed: { open: true, answer: () => Promise.reject(new Error('read failed')) },
  // One idle answer, then silence for longer than an answer stays fresh.
  stale: { open: true, stale: true, answer: (n) => (n === 0 ? Promise.resolve(IDLE) : new Promise(() => {})) },
  // The folder's entry in the engine's own config does not trust it (#2186).
  held: { open: true, answer: () => Promise.resolve(HELD) },
  absent: { open: false, answer: () => Promise.resolve(IDLE) }
};

/** The versions whose rows below the composer the shipped profile declares. */
const DECLARED_VERSIONS = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')).capabilities.wake.restRows);

/**
 * The channel's answer for a set of one version. An idle answer for a version
 * the profile declares names that version, as the adapter's does; every other
 * answer is the version-less one.
 * @param {string} cliVersion - The set's codex-cli version
 * @param {string} answerName - A key of `CHANNEL_ANSWERS`
 * @returns {object}
 */
function channelFor(cliVersion, answerName) {
  if (answerName !== 'idle' || !DECLARED_VERSIONS.includes(cliVersion)) return CHANNEL_ANSWERS[answerName];
  return { open: true, answer: () => Promise.resolve({ ...IDLE, version: cliVersion }) };
}

/** What the gate does whatever the pane shows, for every answer but a fresh idle. */
const HELD_BY_CHANNEL = {
  busy: 'engine-thread-busy',
  unknown: 'engine-thread-unknown',
  failed: 'engine-thread-unknown',
  stale: 'engine-thread-unknown',
  // Decided before the pane is read, so no pane reason can stand in for it.
  held: 'engine-folder-untrusted',
  absent: 'engine-channel-absent'
};

/**
 * With a fresh idle from the channel the pane decides: `null` is a nudge, a
 * string is the hold. Only live captures are pinned here.
 */
const ON_FRESH_IDLE = {
  idle: null,
  idleWithNeighbour: null,
  clippedStatusRow: null,
  quotedProse: null,
  busy: 'pane-turn-in-flight',
  dialog: 'pane-no-prompt',
  typing: 'pane-no-prompt',
  // A status line without the run-state item never draws the at-rest marker;
  // the channel's idle answer is what stands in for it.
  idleDefaultLayout: null,
  idleRunState: null,
  busyDefaultLayout: 'pane-turn-in-flight',
  busyRunState: 'pane-turn-in-flight',
  // Held on either screen: as the whole pane, where no row is a bare prompt,
  // and below a stale composer row, where the selector row is what refuses.
  trustDialog: 'pane-no-prompt',
  updateDialog: 'pane-no-prompt',
  // Held where the opening screen draws a header that says it is starting, or
  // where the profile declares the footer its version opens with and the
  // channel names that version. A version with neither is listed in
  // KNOWN_UNSAFE_IF_CHANNEL_IDLE instead.
  startScreen: 'pane-engine-starting',
  // 0.162.0 over the channel. The resuming screen draws the declared footer
  // alone, as the opening screen does.
  resumingScreen: 'pane-engine-starting',
  idleThreeItemStatus: null,
  idleSingleItemStatus: null,
  idleAfterTurn: null,
  idleAfterUpdateSkipped: null,
  idleAfterResume: null,
  // An empty status line at rest: one row, the footer with a context item
  // beside it. That is not the declared footer, so this gate does not refuse
  // it; the startup fire's witness does.
  idleEmptyStatus: null
};

/**
 * KNOWN UNSAFE IF THE CHANNEL ANSWERS IDLE, by codex-cli version. Live panes
 * the pane gate does NOT refuse on a fresh idle from the channel, although
 * nothing may be typed into them. An entry here records a hole, not a safety
 * property, and a green test over it proves only that the hole is still there.
 *
 * Two kinds of pane are listed.
 *
 * The opening screen of 0.159.0. Codex draws its empty composer on the screen
 * it opens with, before the folder-trust or update prompt replaces it: no busy
 * marker, a bare prompt, a still transcript. On 0.156.1 that screen's header
 * says the engine is starting and the gate holds it by that (`ON_FRESH_IDLE`).
 * 0.159.0, 0.161.0 and 0.162.0 draw no such header row on any captured screen,
 * so the starting marker has nothing to read. For 0.161.0 and 0.162.0 the
 * profile declares the footer row that screen draws alone, and the gate holds
 * it by that once the channel names the version. Nothing is declared for
 * 0.159.0, so only the missing at-rest marker refuses its opening screen,
 * which a fresh idle from the channel excuses.
 *
 * So on that pane the one thing keeping a nudge out is the channel not
 * answering idle while it is up, and today a session of 0.159.0 has no channel
 * at all: it is not a verified version (a block below reads the profile for
 * that). Admitting it is what would open this hole.
 *
 * The settling hold (#2059) does not take a pane off this list. It delays the
 * nudge by one monitor interval after a launch's first idle answer and judges
 * no pane, so a screen that is still up when the interval has passed is typed
 * into exactly as before.
 *
 * A streaming answer on 0.161.0 and on 0.162.0. While the answer streams,
 * each draws no busy row: an empty composer with the cursor on it, the status
 * row and the declared footer below, exactly as at rest. Only the transcript
 * above the composer says a turn is running, and the gate does not read it.
 * What keeps a nudge out of a running turn is the channel answering `busy`,
 * and it did on every tick measured. But the thread's answer comes from the
 * app-server and the pane from the TUI client, and they can disagree: with
 * the client stopped mid-answer and the turn then ending, each version's
 * thread read idle under this very frame, the gate called it at the prompt
 * and the nudge was typed into it (signed in, 2026-10-12, each version in its
 * own run). So neither version is verified, and a block below keeps it so.
 *
 * An empty composer cannot be the refusal, because a usable session shows the
 * same one. When the gate refuses one of these panes, its name leaves this
 * list and its hold is pinned in `ON_FRESH_IDLE`.
 *
 * The 0.155.1 set is rows excerpted by hand, so its `dialog` pane says nothing
 * about what a whole read of that version holds.
 */
const KNOWN_UNSAFE_IF_CHANNEL_IDLE = {
  '0.159.0': ['startScreen'],
  '0.161.0': ['streamingDefaultLayout'],
  '0.162.0': ['streamingDefaultLayout']
};

/** The listed panes that are a streaming answer, not an opening screen. */
const STREAMING_PANE = 'streamingDefaultLayout';

/**
 * Whether a pane is on the known-unsafe list for its version.
 * @param {string} cliVersion - The set's codex-cli version
 * @param {string} paneName - The pane's name in that set
 * @returns {boolean}
 */
function knownUnsafe(cliVersion, paneName) {
  return (KNOWN_UNSAFE_IF_CHANNEL_IDLE[cliVersion] || []).includes(paneName);
}

/**
 * Cells this file does not prove: a fresh idle from the channel against a pane
 * that was derived, not captured. Where the channel holds, the pane is never
 * consulted, so those cells are proven for derived panes too.
 */
const UNPROVEN_ON_FRESH_IDLE = [['0.155.1', 'thinking']];

/**
 * Live-captured panes that say the same thing as an earlier one, in any set.
 * Compared by content, with trailing space on each row ignored, so a pasted
 * literal is found as well as a reused constant. Two versions that truly draw
 * the same pane would be reported too: that is for whoever adds the set to
 * explain here, not for this check to wave through.
 * @param {object[]} sets - Fixture sets
 * @returns {string[]} One line per copy, empty when there are none
 */
function copiedPanes(sets) {
  const seen = new Map();
  const copies = [];
  for (const set of sets) {
    for (const [name, pane] of Object.entries(set.panes)) {
      if (pane.provenance !== 'live-capture') continue;
      const content = pane.lines.map((row) => row.trimEnd()).join('\n');
      const label = `${set.cliVersion} ${name}`;
      if (seen.has(content)) copies.push(`${label} copies ${seen.get(content)}`);
      else seen.set(content, label);
    }
  }
  return copies;
}

/** Let pending observation promises settle. @returns {Promise<void>} */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The monitor's cadence: the settling hold lasts one interval of it. */
const INTERVAL_MS = wake.ENGINE_SETTLING_MS;

/**
 * How long after a tick the channel's answer lands. The one overlap recorded
 * on Codex 0.156.1 had the idle answer 10 ms ahead of the pane sample.
 */
const ANSWER_LAG_MS = 10;

/** Ticks enough for a settled idle answer to reach a nudge, with two to spare. */
const SETTLED_TICKS = 2 + wake.IDLE_TICKS_REQUIRED + 2;

let nextSession = 1;

/**
 * Point the monitor's seams at one live, opted-in Codex session with one
 * unread message, and return the seam table.
 * @param {{clock: number}} world - Holds the clock the monitor reads
 * @param {object} o
 * @param {function(): string[]} o.pane - The pane lines for each read
 * @param {boolean} o.channelOpen - Whether the session has a channel at all
 * @param {function(): Promise<object>} o.observe - The channel's answer for each read
 * @param {function(object): void} o.onDelivery - Receives every ledger entry
 * @param {function(string): void} o.onInject - Receives every typed command
 * @returns {object} `wake._internal`
 */
function installSeams(world, o) {
  const sessionId = nextSession++;
  const s = wake._internal;
  s.listLiveAll = () => [{ id: sessionId, projectId: 10, sessionMode: 'tmux', tmuxSession: `tc-cx-${sessionId}`, engineId: 'codex' }];
  s.getProject = () => ({ id: 10, name: 'proj-cx', path: '/tmp/proj-cx' });
  s.loadProjectConfig = () => ({ medusaWake: true });
  s.wrapRunning = () => false;
  s.rotationOpen = () => false;
  s.getStatus = () => ({ state: 'listening', workspaceId: 'proj-cx-abc123', unread: 1, lastError: null });
  s.getMessages = () => [{ id: 'm1', from: 'peer', message: 'hello' }];
  s.capturePane = () => ({ lines: o.pane() });
  s.cursorInfo = () => null;
  s.masterWakeRecord = () => null;
  s.recordDelivery = o.onDelivery;
  s.injectCommand = (projectName, command) => { o.onInject(command); return { ok: true, error: null }; };
  s.openChannel = () => (o.channelOpen
    ? { id: 7, sessionId, sequenceId: 70, engineId: 'codex', adapter: 'codex', state: 'open', adapterState: { threadId: 't-1' } }
    : null);
  s.launchSequence = () => ({ id: 70, sessionId });
  s.declaresObserver = (engineId) => engineId === 'codex';
  s.observeActivity = o.observe;
  s.now = () => world.clock;
  // The exchange record is not what is under test here.
  s.recordWakeFacts = () => 0;
  s.alreadyAttempted = () => false;
  s.rearmDue = () => false;
  s.awaitingReadiness = () => false;
  s.noteAwaitingRead = () => 0;
  s.noteReadiness = () => 0;
  s.verifySubmission = () => Promise.resolve({ outcome: 'unknown', reason: 'fixture' });
  return s;
}

/**
 * Judge one Codex pane under one channel answer through the real gate.
 *
 * Time moves as the monitor's timer moves it: a tick, the channel's answer a
 * moment later, the next tick one interval after the last. So an idle answer
 * is a SETTLED one by the time the pane decides, unless `opts.ticks` stops the
 * run before the settling hold has passed.
 * @param {string[]} pane - Pane lines
 * @param {object} channel - An entry of `CHANNEL_ANSWERS`
 * @param {object} [opts]
 * @param {number} [opts.ticks] - Ticks to run; defaults to `SETTLED_TICKS`.
 * @returns {Promise<{injected: number, held: (string|null)}>}
 */
async function judge(pane, channel, opts = {}) {
  const world = { clock: 1_000_000, injected: [], recorded: [], reads: 0 };
  const s = installSeams(world, {
    pane: () => pane,
    channelOpen: channel.open,
    observe: () => channel.answer(world.reads++),
    onDelivery: (entry) => { world.recorded.push(entry); },
    onInject: (command) => { world.injected.push(command); }
  });

  if (channel.stale) {
    s.tick();
    await settle();
    world.clock += wake.ENGINE_ACTIVITY_MAX_AGE_MS + 1;
  }
  for (let i = 0; i < (opts.ticks || SETTLED_TICKS); i++) {
    s.tick();
    world.clock += ANSWER_LAG_MS;
    await settle();
    world.clock += INTERVAL_MS - ANSWER_LAG_MS;
  }
  const last = world.recorded.length ? world.recorded[world.recorded.length - 1] : null;
  return { injected: world.injected.length, held: last && last.outcome === 'skipped' ? last.skipReason : null };
}

describe('Codex wake fixtures are qualified by version (#2086)', () => {
  it('every set names the engine, an exact codex-cli version and its capture date', () => {
    assert.ok(CODEX_FIXTURE_SETS.length > 0);
    for (const set of CODEX_FIXTURE_SETS) {
      assert.equal(set.engine, 'codex');
      assert.match(set.cliVersion, /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
      assert.match(set.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Object.keys(set.panes).length > 0);
      for (const [name, pane] of Object.entries(set.panes)) {
        assert.ok(PROVENANCE.includes(pane.provenance), `${set.cliVersion} ${name}: says how it was obtained`);
        assert.ok(Array.isArray(pane.lines) && pane.lines.length > 0, `${set.cliVersion} ${name}`);
      }
    }
  });

  it('the proven versions are exactly the ones with a fixture set, one set each', () => {
    assert.deepEqual(CODEX_FIXTURE_SETS.map((set) => set.cliVersion), PROVEN_CLI_VERSIONS);
  });

  it('no Codex pane fixture exists outside a versioned set', () => {
    const versioned = new Set(CODEX_FIXTURE_SETS.flatMap((set) => Object.values(set.panes).map((pane) => pane.lines)));
    const exported = Object.entries(fixtures).filter(([name]) => /^CX_.*_PANE$/.test(name));
    assert.ok(exported.length > 0);
    for (const [name, lines] of exported) assert.ok(versioned.has(lines), `${name} belongs to no versioned set`);
  });

  it('a set is not a copy of another under a new version number', () => {
    assert.deepEqual(copiedPanes(CODEX_FIXTURE_SETS), []);
  });

  it('the copy check reads what a pane says, so a pasted copy is caught as surely as a reused constant', () => {
    const [real] = CODEX_FIXTURE_SETS;
    const pasted = {
      engine: 'codex',
      cliVersion: '9.9.9',
      capturedOn: '2026-10-04',
      panes: { idle: { lines: JSON.parse(JSON.stringify(real.panes.idle.lines)), provenance: 'live-capture' } }
    };
    assert.notEqual(pasted.panes.idle.lines, real.panes.idle.lines, 'a different array holding the same rows');
    assert.deepEqual(copiedPanes([real, pasted]), [`9.9.9 idle copies ${real.cliVersion} idle`]);
    // Trailing spaces and a re-wrapped array do not disguise one.
    const padded = { ...pasted, panes: { idle: { lines: real.panes.idle.lines.map((row) => `${row}  `), provenance: 'live-capture' } } };
    assert.equal(copiedPanes([real, padded]).length, 1);
    // A pane that really differs is not a copy, and a derived pane is not held to this.
    const different = { ...pasted, panes: { idle: { lines: ['\u203a', '  Ready now'], provenance: 'live-capture' } } };
    assert.deepEqual(copiedPanes([real, different]), []);
    const derived = { ...pasted, panes: { thinking: { lines: [...real.panes.thinking.lines], provenance: 'derived' } } };
    assert.deepEqual(copiedPanes([real, derived]), []);
  });

  it('the cells left unproven are exactly the derived panes, and they are named', () => {
    const derived = CODEX_FIXTURE_SETS.flatMap((set) => Object.entries(set.panes)
      .filter(([, pane]) => pane.provenance !== 'live-capture')
      .map(([name]) => [set.cliVersion, name]));
    assert.deepEqual(derived, UNPROVEN_ON_FRESH_IDLE);
    for (const [, name] of derived) assert.ok(!(name in ON_FRESH_IDLE), `${name} has no pinned outcome to mistake for proof`);
  });

  it('the wake profile under test is the bundled Codex profile', () => {
    assert.ok(wake.ENGINE_WAKE_PROFILES.codex, 'the gate has a Codex profile to judge these panes with');
  });
});

describe('the wake gate over every Codex engine state, per captured version (#2086)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  for (const set of CODEX_FIXTURE_SETS) {
    describe(`codex-cli ${set.cliVersion}`, () => {
      for (const [paneName, pane] of Object.entries(set.panes)) {
        for (const [answerName, held] of Object.entries(HELD_BY_CHANNEL)) {
          it(`${paneName} pane, channel ${answerName}: held as ${held}, nothing typed`, async () => {
            const out = await judge(pane.lines, CHANNEL_ANSWERS[answerName]);
            assert.deepEqual(out, { injected: 0, held });
          });
        }

        // A pane nobody observed cannot prove what the gate does with a real
        // one, so its fresh-idle cell is not asserted: see UNPROVEN_ON_FRESH_IDLE.
        if (pane.provenance !== 'live-capture') continue;
        if (knownUnsafe(set.cliVersion, paneName)) {
          it(`KNOWN UNSAFE IF CHANNEL IDLE: ${paneName} pane, channel idle: the pane gate does not refuse it and a nudge is typed`, async () => {
            const out = await judge(pane.lines, channelFor(set.cliVersion, 'idle'));
            // `injected: 1` DOCUMENTS what the gate does today when handed an
            // idle answer over this pane. It is not acceptance of that
            // behaviour, and it is not evidence that a live channel can answer
            // idle while Codex is still starting: the answer here is a stub.
            assert.deepEqual(out, { injected: 1, held: null }, 'if this now holds, the hole is closed: take the pane off the list and pin its hold in ON_FRESH_IDLE');
          });
          continue;
        }
        const expected = ON_FRESH_IDLE[paneName];
        it(`${paneName} pane, channel idle: ${expected === null ? 'nudged once' : `held as ${expected}`}`, async () => {
          assert.ok(paneName in ON_FRESH_IDLE, 'a new live pane needs an expected outcome here');
          const out = await judge(pane.lines, channelFor(set.cliVersion, 'idle'));
          assert.deepEqual(out, expected === null ? { injected: 1, held: null } : { injected: 0, held: expected });
        });
      }
    });
  }
});

/** Every live pane of every set, as `[version, name, lines]`. */
const LIVE_PANES = CODEX_FIXTURE_SETS.flatMap((set) => Object.entries(set.panes)
  .filter(([, pane]) => pane.provenance === 'live-capture')
  .map(([name, pane]) => [set.cliVersion, name, pane.lines]));

describe('the first idle answer of a launch is held, whatever the pane shows (#2059)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  // Two ticks: the first asks the channel, the second is the first to hold its
  // idle answer. The pane is not read on either, so a derived pane proves this
  // as well as a captured one.
  for (const set of CODEX_FIXTURE_SETS) {
    for (const [paneName, pane] of Object.entries(set.panes)) {
      it(`codex-cli ${set.cliVersion}: ${paneName} pane, first idle answer: held as engine-thread-settling, nothing typed`, async () => {
        const out = await judge(pane.lines, channelFor(set.cliVersion, 'idle'), { ticks: 2 });
        assert.deepEqual(out, { injected: 0, held: 'engine-thread-settling' });
      });
    }
  }
});

/**
 * The pane gate's own verdict, with no channel involved.
 * @param {string[]} lines - Pane lines
 * @param {object} profile - Wake profile
 * @returns {string} `idle`, or the refusal reason
 */
function paneVerdict(lines, profile) {
  const verdict = wake._assessPane(lines, profile, null, false);
  return verdict.idle ? 'idle' : verdict.reason;
}

describe('what refuses a Codex pane when no channel has spoken (#2059)', () => {
  const shipped = () => wake.ENGINE_WAKE_PROFILES.codex;
  /** The rule #2059 asked for: the same profile with no at-rest marker. */
  const markerless = () => ({ ...shipped(), idleMarker: null });

  it('the start screen is captured for every version it was seen on', () => {
    const withStart = CODEX_FIXTURE_SETS.filter((set) => 'startScreen' in set.panes).map((set) => set.cliVersion);
    assert.deepEqual(withStart, ['0.156.1', '0.159.0', '0.161.0', '0.162.0']);
  });

  for (const [version, , lines] of LIVE_PANES.filter(([, name]) => name === 'startScreen')) {
    it(`codex-cli ${version}: the start screen is not at rest under the shipped profile`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'not-at-rest');
    });
  }

  it('the shipped Codex profile keeps a positive at-rest marker', () => {
    assert.equal(typeof shipped().idleMarker, 'string');
    assert.ok(shipped().idleMarker.length > 0);
  });

  /**
   * What the pane gate would say of each live pane if no at-rest marker were
   * required. Every live pane name has an entry, so a new pane cannot go
   * unjudged. `idle` on `startScreen` is the case a markerless rule gets
   * wrong; every other `idle` is a pane that really is at rest.
   */
  const WITHOUT_A_MARKER = {
    idle: 'idle',
    idleWithNeighbour: 'idle',
    clippedStatusRow: 'idle',
    quotedProse: 'idle',
    idleDefaultLayout: 'idle',
    idleRunState: 'idle',
    startScreen: 'idle',
    // With no version named the declared footer is not asked about, so the
    // resuming screen reads as the opening screen does.
    resumingScreen: 'idle',
    idleThreeItemStatus: 'idle',
    idleSingleItemStatus: 'idle',
    idleEmptyStatus: 'idle',
    idleAfterTurn: 'idle',
    idleAfterUpdateSkipped: 'idle',
    idleAfterResume: 'idle',
    // A streaming answer draws no busy row, so with or without a marker rule
    // the pane alone reads as rest.
    streamingDefaultLayout: 'idle',
    busy: 'turn-in-flight',
    busyDefaultLayout: 'turn-in-flight',
    busyRunState: 'turn-in-flight',
    dialog: 'no-prompt',
    trustDialog: 'no-prompt',
    updateDialog: 'no-prompt',
    typing: 'no-prompt'
  };

  /**
   * Where one version's pane reads differently from the table above. The
   * 0.156.1 opening screen is refused by its own header, which needs no
   * at-rest marker: it says the engine is starting.
   */
  const WITHOUT_A_MARKER_ON = {
    '0.156.1': { startScreen: 'engine-starting' }
  };

  for (const [version, name, lines] of LIVE_PANES) {
    const expected = (WITHOUT_A_MARKER_ON[version] || {})[name] || WITHOUT_A_MARKER[name];
    it(`codex-cli ${version}: with no at-rest marker required, ${name} reads ${expected}`, () => {
      assert.ok(name in WITHOUT_A_MARKER, 'a new live pane needs an expected verdict here');
      assert.equal(paneVerdict(lines, markerless()), expected);
      // A pane refused without the marker is refused with it too.
      if (expected !== 'idle') assert.notEqual(paneVerdict(lines, shipped()), 'idle');
    });
  }

  for (const [version, name, lines] of LIVE_PANES.filter(([, name]) => name === 'idleDefaultLayout')) {
    it(`codex-cli ${version}: at rest with Codex's default status line is held as not-at-rest`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'not-at-rest', `${name} draws no run-state item`);
    });
  }

  for (const [version, , lines] of LIVE_PANES.filter(([, name]) => name === 'idleRunState')) {
    it(`codex-cli ${version}: at rest with the run-state item shown reads idle`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'idle');
    });
  }
});

describe('a captured Codex version is woken only if the profile verified it (#2059)', () => {
  const startupControl = require('../lib/startup-control');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
  const verified = profile.capabilities.startupControl.verifiedVersions;

  /**
   * Resolve the Codex startup channel as if `version` were installed.
   * @param {string} version - codex-cli version
   * @returns {{supported: boolean, reasonCode: (string|null)}}
   */
  function resolveAt(version) {
    const adapters = { codex: { installedVersion: () => version, observeActivity: () => null } };
    return startupControl.resolve(profile, adapters, 'codex');
  }

  it('the captured versions split into verified and not, and both kinds are present', () => {
    const captured = CODEX_FIXTURE_SETS.map((set) => set.cliVersion);
    assert.ok(captured.some((version) => verified.includes(version)), 'a verified version is captured');
    assert.ok(captured.some((version) => !verified.includes(version)), 'an unverified version is captured');
  });

  for (const set of CODEX_FIXTURE_SETS) {
    if (verified.includes(set.cliVersion)) {
      it(`codex-cli ${set.cliVersion} is verified: its launch gets a channel`, () => {
        const out = resolveAt(set.cliVersion);
        assert.equal(out.supported, true);
        assert.equal(out.reasonCode, null);
      });
      continue;
    }
    it(`codex-cli ${set.cliVersion} is not verified: its launch gets no channel`, () => {
      const out = resolveAt(set.cliVersion);
      assert.equal(out.supported, false);
      assert.equal(out.reasonCode, 'version_unverified');
    });

    it(`codex-cli ${set.cliVersion}: an unverified version is still an engine judged by its channel`, () => {
      const adapters = { codex: { installedVersion: () => set.cliVersion, observeActivity: () => null } };
      assert.equal(startupControl.declaresObserver('codex', () => profile, adapters), true);
    });
  }

  // What the gate then does with such a session is the `absent` row of the
  // matrix above: held as engine-channel-absent on every pane of every set.
});

describe('the opening and resuming screens of a version that declares its footer, over the launch path TangleClaw uses (#2059)', () => {
  const { CODEX_CHANNEL_VERSIONS, CODEX_CHANNEL_FIXTURES } = require('./_codex-visible-pane-fixtures');
  const shipped = () => wake.ENGINE_WAKE_PROFILES.codex;
  /** The channel's idle answer, naming `version` or none. */
  const idleNaming = (version) => ({ open: true, answer: () => Promise.resolve(version ? { ...IDLE, version } : IDLE) });
  /** The pane gate's own verdict for a version, the engine's thread reported idle. */
  const verdictAt = (lines, version, profile = shipped(), cursor = null) => {
    const verdict = wake._assessPane(lines, profile, cursor, true, version);
    return verdict.idle ? 'idle' : verdict.reason;
  };
  const OPENING = ['startScreen', 'resumingScreen'];
  const AT_REST = ['idleDefaultLayout', 'idleThreeItemStatus', 'idleSingleItemStatus', 'idleAfterTurn', 'idleAfterUpdateSkipped', 'idleAfterResume'];

  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  it('the declared versions are the captured ones, each from its own file', () => {
    assert.deepEqual(DECLARED_VERSIONS, [...CODEX_CHANNEL_VERSIONS]);
    for (const version of CODEX_CHANNEL_VERSIONS) assert.equal(CODEX_CHANNEL_FIXTURES[version].version, version);
    assert.equal(shipped().restRows['0.156.1'], undefined, 'nothing is declared for 0.156.1');
    assert.equal(shipped().restRows['0.159.0'], undefined, 'nor for 0.159.0, which was not measured over this launch path');
  });

  for (const version of CODEX_CHANNEL_VERSIONS) {
    const fx = CODEX_CHANNEL_FIXTURES[version];

    for (const name of OPENING) {
      it(`codex-cli ${version} ${name}: held as pane-engine-starting through the gate, the thread reported idle, nothing typed`, async () => {
        assert.deepEqual(await judge([...fx.lines[name]], idleNaming(version)), { injected: 0, held: 'pane-engine-starting' });
      });

      it(`codex-cli ${version} ${name}: the refusal is the declared footer's, not the header's, the at-rest marker's or the cursor's`, () => {
        const lines = [...fx.lines[name]];
        assert.equal(verdictAt(lines, version), 'engine-starting');
        const { headerRe, startingRe, ...headerless } = shipped();
        assert.ok(headerRe && startingRe, 'the shipped profile declares a starting header');
        assert.equal(verdictAt(lines, version, headerless), 'engine-starting', 'with no header pattern at all');
        assert.equal(verdictAt(lines, version, { ...shipped(), idleMarker: null }), 'engine-starting', 'with no at-rest marker required');
        const pane = fx.panes[name];
        assert.equal(verdictAt(lines, version, shipped(), { x: pane.x, line: pane.rows[pane.y] }), 'engine-starting', 'with the cursor on the empty composer');
      });

      it(`codex-cli ${version} ${name}: refused only for the version the channel named`, () => {
        const lines = [...fx.lines[name]];
        assert.equal(verdictAt(lines, null), 'idle', 'no version named');
        assert.equal(verdictAt(lines, '0.156.1'), 'idle', 'a version with no declaration');
        assert.equal(verdictAt(lines, '0.159.0'), 'idle');
        assert.equal(verdictAt(lines, `${version}0`), 'idle', 'a version that is not exactly a declared one');
        assert.equal(verdictAt(lines, 'constructor'), 'idle', 'a name every object has is not a declared version');
      });
    }

    for (const name of AT_REST) {
      it(`codex-cli ${version} ${name}: a usable composer does not get this refusal, and is nudged once`, async () => {
        assert.equal(verdictAt([...fx.lines[name]], version), 'idle');
        assert.deepEqual(await judge([...fx.lines[name]], idleNaming(version)), { injected: 1, held: null });
      });
    }

    it(`codex-cli ${version}: a footer that differs by one character is not the declared footer`, () => {
      const lines = [...fx.lines.startScreen];
      const at = lines.lastIndexOf('  ? for shortcuts');
      assert.ok(at > 0);
      for (const other of ['  ? for shortcut', '  ? for shortcuts.', '   ? for shortcuts', '  ← for agents · ? for shortcuts']) {
        const changed = [...lines];
        changed[at] = other;
        assert.equal(verdictAt(changed, version), 'idle', other);
      }
      const padded = [...lines];
      padded[at] = '  ? for shortcuts   ';
      assert.equal(verdictAt(padded, version), 'engine-starting', 'trailing space on the row is not part of it');
    });

    it(`codex-cli ${version}: an empty status line is held while it opens and not once it is at rest`, () => {
      const rest = [...fx.lines.idleEmptyStatus];
      assert.match(rest[rest.length - 1], /^ {2}\? for shortcuts {2,}100% context left$/);
      assert.equal(verdictAt(rest, version), 'idle', 'the footer with a context item beside it is not the declared footer');
      const opening = [...rest];
      opening[opening.length - 1] = '  ? for shortcuts';
      assert.equal(verdictAt(opening, version), 'engine-starting');
    });

    it(`codex-cli ${version}: the dialogs, typed text and a drawn busy row keep their own refusals under the declaration`, () => {
      assert.equal(verdictAt([...fx.lines.trustDialog], version), 'no-prompt');
      assert.equal(verdictAt([...fx.lines.updateDialog], version), 'no-prompt');
      assert.equal(verdictAt([...fx.lines.typing], version), 'no-prompt');
      assert.equal(verdictAt([...fx.lines.busyDefaultLayout], version), 'turn-in-flight');
    });

    it(`codex-cli ${version}: a streaming turn draws no busy row, and is held by the channel's answer and by the transcript moving`, async () => {
      const { streamingFirst, streamingNext } = fx.turnFrames;
      for (const frame of [streamingFirst, streamingNext]) {
        assert.ok(!frame.lines.join('\n').includes(shipped().busyMarker), 'no busy marker is drawn while the answer streams');
        // The limit, stated: read alone, with an idle answer nothing real would
        // give while this is up, the pane gate does not refuse this frame.
        assert.equal(verdictAt([...frame.lines], version), 'idle');
      }
      assert.equal(fx.threads.userActive.status.type, 'active', 'the thread reports the turn');
      assert.deepEqual(await judge([...streamingFirst.lines], CHANNEL_ANSWERS.busy), { injected: 0, held: 'engine-thread-busy' });
      // Even under an idle answer, two reads of a transcript that moved are not at rest.
      const moving = wake.assessSessionIdle({ lines: [...streamingFirst.lines], profile: shipped(), cursor: null, engineIdle: true, engineVersion: version });
      const next = wake.assessSessionIdle({ lines: [...streamingNext.lines], profile: shipped(), cursor: null, engineIdle: true, engineVersion: version, prevDigest: moving.digest, idleTicks: moving.idleTicks });
      assert.deepEqual({ idle: next.idle, reason: next.reason, idleTicks: next.idleTicks }, { idle: false, reason: 'pane-writing', idleTicks: 0 });
    });
  }

  it('an opening screen is held for as long as it is up and nudged once the status row is drawn above the footer', async () => {
    for (const version of CODEX_CHANNEL_VERSIONS) {
      const fx = CODEX_CHANNEL_FIXTURES[version];
      const world = { clock: 1_000_000, injected: [], recorded: [], pane: [...fx.lines.startScreen] };
      const s = installSeams(world, {
        pane: () => world.pane,
        channelOpen: true,
        observe: () => Promise.resolve({ ...IDLE, version }),
        onDelivery: (entry) => { world.recorded.push(entry); },
        onInject: (command) => { world.injected.push(command); }
      });
      const run = async (ticks) => {
        for (let i = 0; i < ticks; i++) {
          s.tick();
          world.clock += ANSWER_LAG_MS;
          await settle();
          world.clock += INTERVAL_MS - ANSWER_LAG_MS;
        }
      };
      await run(SETTLED_TICKS);
      assert.equal(world.injected.length, 0, `${version}: nothing typed while it opens`);
      assert.equal(world.recorded[world.recorded.length - 1].skipReason, 'pane-engine-starting', version);
      world.pane = [...fx.lines.idleDefaultLayout];
      await run(SETTLED_TICKS);
      assert.equal(world.injected.length, 1, `${version}: nudged once at rest`);
      wake.stop();
    }
  });
});

/** The startup dialogs a version can draw before a session is usable. */
const DIALOG_PANES = ['trustDialog', 'updateDialog'];

/** How a dialog read may say it was drawn. */
const SCREENS = ['main', 'alternate'];

/**
 * Where the selector row sits in a dialog read, and whether a bare composer
 * row is above it. A bare row is one the shipped profile's own prompt pattern
 * matches, which is the comparison the gate makes.
 * @param {string[]} lines - Pane lines
 * @returns {{selector: number, footer: number, staleComposer: boolean}}
 */
function dialogShape(lines) {
  const { promptRe } = wake.ENGINE_WAKE_PROFILES.codex;
  const selector = lines.findIndex((row) => /^\u203a \d+\. /.test(row));
  const footer = lines.findIndex((row) => /^ {2}enter continue \u00b7 esc /.test(row));
  const staleComposer = lines.slice(0, selector).some((row) => promptRe.test(row));
  return { selector, footer, staleComposer };
}

describe('the startup dialogs are whole reads that say which screen drew them (#2187)', () => {
  const captured = CODEX_FIXTURE_SETS.filter((set) => DIALOG_PANES.some((name) => name in set.panes));

  it('both dialogs are captured for every version that has a captured set file', () => {
    assert.deepEqual(captured.map((set) => [set.cliVersion, DIALOG_PANES.filter((name) => name in set.panes)]), [
      ['0.156.1', DIALOG_PANES],
      ['0.159.0', DIALOG_PANES],
      ['0.161.0', DIALOG_PANES],
      ['0.162.0', DIALOG_PANES]
    ]);
  });

  for (const set of captured) {
    for (const name of DIALOG_PANES.filter((pane) => pane in set.panes)) {
      const pane = set.panes[name];

      it(`codex-cli ${set.cliVersion} ${name}: a live read with its own date, its screen and how it was taken`, () => {
        assert.equal(pane.provenance, 'live-capture');
        assert.match(pane.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(SCREENS.includes(pane.screen), 'says which screen Codex drew it on');
        assert.ok(typeof pane.note === 'string' && pane.note.includes('Not captured:'), 'says what the read did not cover');
      });

      it(`codex-cli ${set.cliVersion} ${name}: runs from the screen's first row to the dialog's footer`, () => {
        const shape = dialogShape(pane.lines);
        assert.ok(shape.selector > 0, 'has a selector row');
        assert.equal(shape.footer, pane.lines.length - 1, 'ends at the footer row');
        assert.ok(shape.footer > shape.selector);
        // A main-screen read still holds the composer row the session opened
        // with; an alternate-screen read holds the dialog and nothing else.
        assert.equal(shape.staleComposer, pane.screen === 'main');
      });

      it(`codex-cli ${set.cliVersion} ${name}: not known unsafe on either screen`, () => {
        assert.equal(knownUnsafe(set.cliVersion, name), false);
      });
    }
  }
});

/** The rows of Codex 0.156.1's header box: its borders and the rows inside them. */
const HEADER_BOX_RE = /^[\u256d\u2502\u2570]/;

/**
 * The cursor as tmux reported it on each 0.156.1 dialog when the read was
 * taken (2026-10-11, pane 100x30): hidden, at column 27 of the footer row,
 * which is the last row of the read. A column past a row with no prompt glyph
 * decides nothing about the composer, which is the point of having it here.
 * @param {string[]} lines - A dialog's pane lines
 * @returns {{x: number, line: string}}
 */
function footerCursor(lines) {
  return { x: 27, line: lines[lines.length - 1] };
}

/** Codex's empty composer row as a pane read returns it, and as it is styled on the terminal. */
const EMPTY_COMPOSER_TEXT = '\u203a Ask Codex to do anything';
const ON_EMPTY_COMPOSER = { x: 2, line: '\u001b[1m\u203a\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m' };

describe('which rule holds which Codex 0.156.1 startup screen (#2187)', () => {
  const shipped = () => wake.ENGINE_WAKE_PROFILES.codex;
  const set = CODEX_FIXTURE_SETS.find((candidate) => candidate.cliVersion === '0.156.1');
  /** The pane gate with the channel's idle answer, which excuses the at-rest marker. */
  const underIdle = (lines, cursor = null) => wake._assessPane(lines, shipped(), cursor, true);

  for (const name of DIALOG_PANES) {
    const { lines } = set.panes[name];

    it(`${name}: held as no-prompt by the selector row below the stale composer, not by its header`, () => {
      assert.deepEqual(underIdle(lines), { idle: false, reason: 'no-prompt' });
      // With the header box gone nothing says the engine is starting, and the
      // dialog is still refused.
      const noHeader = lines.filter((row) => !HEADER_BOX_RE.test(row));
      assert.ok(!noHeader.some((row) => /model:/.test(row)), 'the header rows are out of the read');
      assert.equal(shipped().startingRe.test(lines.join('\n')), true, 'and the whole read did carry the marker');
      assert.deepEqual(underIdle(noHeader), { idle: false, reason: 'no-prompt' });
    });

    it(`${name}: held with the cursor where it was captured, hidden on the footer row`, () => {
      assert.deepEqual(underIdle(lines, footerCursor(lines)), { idle: false, reason: 'no-prompt' });
    });

    it(`${name}: held with the cursor on the stale composer row, which reads as an empty composer`, () => {
      // Not captured: Codex parks the cursor on the footer. This is the frame
      // where the cursor alone would answer at-prompt, so it is built.
      assert.ok(lines.some((row) => row === EMPTY_COMPOSER_TEXT), 'the stale row is an empty composer');
      assert.equal(wake._composerEmpty(ON_EMPTY_COMPOSER, shipped()), true, 'the cursor alone says empty');
      assert.deepEqual(underIdle(lines, ON_EMPTY_COMPOSER), { idle: false, reason: 'no-prompt' });
    });

    it(`${name}: with the selector row gone the same read is held by its header alone`, () => {
      const noSelector = lines.filter((row) => !row.startsWith(shipped().promptGlyph) || shipped().promptRe.test(row));
      assert.deepEqual(underIdle(noSelector), { idle: false, reason: 'engine-starting' });
    });
  }

  it('the opening screen is held by its header: nothing is drawn below its composer', () => {
    const { lines } = set.panes.startScreen;
    assert.deepEqual(underIdle(lines), { idle: false, reason: 'engine-starting' });
    assert.equal(lines[lines.length - 1], EMPTY_COMPOSER_TEXT);
    assert.deepEqual(underIdle(lines, ON_EMPTY_COMPOSER), { idle: false, reason: 'engine-starting' }, 'and with the cursor on its empty composer');
  });

  it('a header that names its model, below the one that said loading, is not starting', () => {
    const { lines } = set.panes.idleRunState;
    const superseded = set.panes.startScreen.lines.slice(0, 6);
    assert.deepEqual(underIdle([...superseded, '', ...lines]), { idle: true, reason: 'at-prompt' });
    // The other way round, the newest header is the one that reads loading.
    assert.deepEqual(underIdle([...lines.slice(0, 6), '', ...set.panes.startScreen.lines]), { idle: false, reason: 'engine-starting' });
  });

  it('every usable 0.156.1 pane still reads at-prompt under an idle answer', () => {
    for (const name of ['idleDefaultLayout', 'idleRunState']) {
      assert.deepEqual(underIdle(set.panes[name].lines), { idle: true, reason: 'at-prompt' }, name);
    }
  });
});

/**
 * The holds the gate records, in order, while the channel's answer changes.
 * @param {string[]|function(object): string[]} pane - Pane lines, or a function of the world giving them for the tick in hand
 * @param {Array<object>} answers - The channel's answer for each read; the last one repeats
 * @param {number} ticks - Ticks to run
 * @returns {Promise<{injected: number, holds: string[]}>} `holds` with repeats collapsed
 */
async function timeline(pane, answers, ticks) {
  const world = { clock: 1_000_000, injected: 0, holds: [], reads: 0, tick: 0 };
  const s = installSeams(world, {
    pane: () => (typeof pane === 'function' ? pane(world) : pane),
    channelOpen: true,
    observe: () => Promise.resolve(answers[Math.min(world.reads++, answers.length - 1)]),
    onDelivery: (entry) => {
      if (entry.outcome !== 'skipped') return;
      if (world.holds[world.holds.length - 1] !== entry.skipReason) world.holds.push(entry.skipReason);
    },
    onInject: () => { world.injected += 1; }
  });
  for (let i = 0; i < ticks; i++) {
    world.tick = i;
    s.tick();
    world.clock += ANSWER_LAG_MS;
    await settle();
    world.clock += INTERVAL_MS - ANSWER_LAG_MS;
  }
  return { injected: world.injected, holds: world.holds };
}

describe('the folder hold, the settling hold and the pane refusals act in that order (#2186, #2059, #2187)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  const set = CODEX_FIXTURE_SETS.find((candidate) => candidate.cliVersion === '0.156.1');
  const RELEASED = [HELD, HELD, HELD, IDLE];
  const TICKS = RELEASED.length + SETTLED_TICKS;
  /** What the first tick records: it asks the channel and has no answer yet. */
  const ASKING = 'engine-thread-unknown';

  for (const [name, refusal] of [['startScreen', 'pane-engine-starting'], ['trustDialog', 'pane-no-prompt'], ['updateDialog', 'pane-no-prompt']]) {
    it(`a session released from the folder hold onto the ${name}: settles, then is refused as ${refusal}, nothing typed`, async () => {
      const out = await timeline(set.panes[name].lines, RELEASED, TICKS);
      assert.deepEqual(out, { injected: 0, holds: [ASKING, 'engine-folder-untrusted', 'engine-thread-settling', refusal] });
    });
  }

  it('a session released from the folder hold onto a usable composer: settles, then is nudged once', async () => {
    const out = await timeline(set.panes.idleDefaultLayout.lines, RELEASED, TICKS);
    assert.equal(out.injected, 1);
    assert.deepEqual(out.holds.slice(0, 3), [ASKING, 'engine-folder-untrusted', 'engine-thread-settling']);
    assert.ok(!out.holds.some((hold) => hold === 'pane-engine-starting' || hold === 'pane-no-prompt'), `a usable composer met no pane refusal: ${out.holds}`);
  });

  it('the opening screen gives way to a usable composer: held as starting while it is up, then nudged once', async () => {
    const UP_FOR = 6;
    const pane = (world) => (world.tick < UP_FOR ? set.panes.startScreen.lines : set.panes.idleRunState.lines);
    const out = await timeline(pane, [IDLE], UP_FOR + SETTLED_TICKS);
    assert.equal(out.injected, 1);
    assert.deepEqual(out.holds.slice(0, 3), [ASKING, 'engine-thread-settling', 'pane-engine-starting']);
  });

  it('a real turn ends: held while the turn is drawn, then nudged once', async () => {
    const BUSY_FOR = 6;
    const pane = (world) => (world.tick < BUSY_FOR ? set.panes.busyRunState.lines : set.panes.idleRunState.lines);
    const out = await timeline(pane, [IDLE], BUSY_FOR + SETTLED_TICKS);
    assert.equal(out.injected, 1);
    assert.deepEqual(out.holds.slice(0, 3), [ASKING, 'engine-thread-settling', 'pane-turn-in-flight']);
  });
});

describe('the known-unsafe list is one opening screen with nothing to refuse it and the streaming answer of two versions (#2059, #2187)', () => {
  it('names nothing else, so another hole cannot be added quietly', () => {
    assert.deepEqual(KNOWN_UNSAFE_IF_CHANNEL_IDLE, {
      '0.159.0': ['startScreen'],
      '0.161.0': ['streamingDefaultLayout'],
      '0.162.0': ['streamingDefaultLayout']
    });
  });

  it('0.161.0\'s opening screen left the list only because the gate now refuses it under 0.161.0\'s own declaration', async () => {
    const lines = CODEX_FIXTURE_SETS.find((set) => set.cliVersion === '0.161.0').panes.startScreen.lines;
    const saved = { ...wake._internal };
    wake.stop();
    try {
      assert.deepEqual(await judge(lines, channelFor('0.161.0', 'idle')), { injected: 0, held: 'pane-engine-starting' });
      // The same pane under an idle answer that names no version is typed
      // into, as it was while it was listed: the refusal is the declaration's.
      assert.deepEqual(await judge(lines, CHANNEL_ANSWERS.idle), { injected: 1, held: null });
    } finally {
      wake.stop();
      Object.assign(wake._internal, saved);
    }
  });

  it('every entry names a live pane of a captured set', () => {
    for (const [cliVersion, names] of Object.entries(KNOWN_UNSAFE_IF_CHANNEL_IDLE)) {
      const set = CODEX_FIXTURE_SETS.find((candidate) => candidate.cliVersion === cliVersion);
      assert.ok(set, `${cliVersion} has a fixture set`);
      for (const name of names) {
        assert.ok(set.panes[name], `${cliVersion} ${name} is a captured pane`);
        assert.equal(set.panes[name].provenance, 'live-capture', `${cliVersion} ${name}`);
      }
    }
  });

  it('a listed opening screen is one with no header row for the starting marker to read and no declared footer', () => {
    const { headerRe } = wake.ENGINE_WAKE_PROFILES.codex;
    for (const set of CODEX_FIXTURE_SETS.filter((candidate) => 'startScreen' in candidate.panes)) {
      const hasHeader = set.panes.startScreen.lines.some((row) => headerRe.test(row));
      assert.equal(knownUnsafe(set.cliVersion, 'startScreen'), !hasHeader && !DECLARED_VERSIONS.includes(set.cliVersion), set.cliVersion);
    }
  });

  /** The versions whose streaming answer is listed. */
  const STREAMING_VERSIONS = Object.keys(KNOWN_UNSAFE_IF_CHANNEL_IDLE).filter((cliVersion) => knownUnsafe(cliVersion, STREAMING_PANE));

  /**
   * Run `fn` with the monitor stopped and its seams put back afterwards.
   * @param {function(): Promise<void>} fn - The body
   * @returns {Promise<void>}
   */
  async function withGate(fn) {
    const saved = { ...wake._internal };
    wake.stop();
    try {
      await fn();
    } finally {
      wake.stop();
      Object.assign(wake._internal, saved);
    }
  }

  it('a streaming answer is listed for exactly the versions whose footer the profile declares', () => {
    assert.deepEqual(STREAMING_VERSIONS, DECLARED_VERSIONS);
  });

  for (const cliVersion of STREAMING_VERSIONS) {
    const pane = CODEX_FIXTURE_SETS.find((set) => set.cliVersion === cliVersion).panes[STREAMING_PANE];
    const BUSY = { channel: 'present', state: 'busy', reasonCode: 'thread-active' };

    it(`codex-cli ${cliVersion}: the listed streaming pane is a capture over the launch path TangleClaw uses, and is drawn like rest`, () => {
      const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8')).capabilities.wake;
      assert.equal(pane.launchPath, 'remote-channel');
      const { x, y, rows } = pane.visible;
      assert.match(rows[y], new RegExp(profile.promptPattern), 'the cursor row is the empty composer');
      assert.equal(x, 2);
      const below = rows.slice(y + 1).filter((row) => row !== '');
      assert.equal(below.length, 2, 'a status row, then the footer');
      assert.match(below[0], /^ {2}\S.* · /);
      assert.match(below[1], new RegExp(profile.restRows[cliVersion].footerPattern));
      assert.ok(!rows.join('\n').includes(profile.busyMarker), 'no busy row is drawn while the answer streams');
      const above = rows.slice(0, y).filter((row) => row !== '');
      assert.doesNotMatch(above[above.length - 1], /^ {2}Worked for /, 'the answer is still being written: no end-of-turn row');
    });

    it(`codex-cli ${cliVersion}: the pane gate alone calls that frame at the prompt once it has been still for the required ticks`, () => {
      const codex = wake.ENGINE_WAKE_PROFILES.codex;
      const first = wake.assessSessionIdle({ lines: [...pane.lines], profile: codex, cursor: null, engineIdle: true, engineVersion: cliVersion });
      const second = wake.assessSessionIdle({ lines: [...pane.lines], profile: codex, cursor: null, engineIdle: true, engineVersion: cliVersion, prevDigest: first.digest, idleTicks: first.idleTicks });
      assert.deepEqual({ idle: second.idle, reason: second.reason }, { idle: true, reason: 'at-prompt' });
    });

    it(`codex-cli ${cliVersion}: while the thread answers busy over that frame, it is held and nothing is typed`, async () => {
      await withGate(async () => {
        const out = await timeline(pane.lines, [BUSY], SETTLED_TICKS + 4);
        assert.deepEqual(out, { injected: 0, holds: ['engine-thread-unknown', 'engine-thread-busy'] });
      });
    });

    // The measured hole, pinned so that closing it turns this red: the frame
    // does not change, the thread's answer goes from busy to idle, and after
    // the settling interval the nudge is typed into a pane still showing an
    // answer being written.
    it(`KNOWN UNSAFE: codex-cli ${cliVersion}: the turn ends under the same still frame: settles, then is typed into`, async () => {
      await withGate(async () => {
        const out = await timeline(pane.lines, [BUSY, BUSY, BUSY, { ...IDLE, version: cliVersion }], 3 + SETTLED_TICKS);
        assert.deepEqual(out, { injected: 1, holds: ['engine-thread-unknown', 'engine-thread-busy', 'engine-thread-settling'] }, 'if nothing is typed now, the hole is closed for this version: take its pane off the list and pin its hold');
      });
    });
  }

  it('no listed version is one the profile verifies, so no session of it has a channel to answer idle', () => {
    const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    const verified = profile.capabilities.startupControl.verifiedVersions;
    for (const cliVersion of Object.keys(KNOWN_UNSAFE_IF_CHANNEL_IDLE)) {
      assert.ok(!verified.includes(cliVersion), `${cliVersion} is verified while its opening screen is known unsafe`);
    }
  });
});
