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
 * (`lib/startup-control.js` `observeActivity`), not Codex wire bytes, so they
 * carry no Codex version: the app-server protocol is not proven here either.
 *
 * A captured version is not a supported one. The sets for 0.159.0 and 0.161.0
 * exist to pin what the gate REFUSES on them (#2059); whether a session of
 * such a version may be woken at all is decided by the engine profile's
 * verified versions, which a block below reads.
 *
 * The trust and update dialogs are whole reads, each saying which screen Codex
 * drew it on (#2187). That is what decides the pane gate's answer: a dialog on
 * the main screen keeps the opening composer row above it, and one on the
 * alternate screen does not.
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
const PROVEN_CLI_VERSIONS = ['0.155.1', '0.156.1', '0.159.0', '0.161.0'];

const PROVENANCE = ['live-capture', 'derived'];

const IDLE = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };

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
  absent: { open: false, answer: () => Promise.resolve(IDLE) }
};

/** What the gate does whatever the pane shows, for every answer but a fresh idle. */
const HELD_BY_CHANNEL = {
  busy: 'engine-thread-busy',
  unknown: 'engine-thread-unknown',
  failed: 'engine-thread-unknown',
  stale: 'engine-thread-unknown',
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
  // Held where the dialog is the whole pane. A version that draws it below a
  // stale composer row is listed in KNOWN_UNSAFE_IF_CHANNEL_IDLE instead.
  trustDialog: 'pane-no-prompt',
  updateDialog: 'pane-no-prompt'
};

/**
 * KNOWN UNSAFE IF THE CHANNEL ANSWERS IDLE, by codex-cli version. Live panes
 * the pane gate does NOT refuse on a fresh idle from the channel, although
 * nothing may be typed into them. An entry here records a hole, not a safety
 * property, and a green test over it proves only that the hole is still there.
 *
 * The opening screen, on every version it was captured on. Codex draws its
 * empty composer on the screen it opens with, before the folder-trust or
 * update prompt replaces it: no busy marker, a bare prompt, a still
 * transcript. Only the missing at-rest marker refuses that screen, and a fresh
 * idle from the channel excuses exactly that marker.
 *
 * Both dialogs, on 0.156.1 only (#2187). That version draws on the main
 * screen, so the composer row it opened with is still in the read, above the
 * dialog, and the gate's text check accepts a bare prompt row anywhere in the
 * read. 0.159.0 and 0.161.0 draw on the alternate screen: the dialog is the
 * whole pane, no composer row is above it, and the gate holds it. Their
 * dialogs are pinned as held in `ON_FRESH_IDLE`.
 *
 * So on these panes the one thing keeping a nudge out is the channel not
 * answering idle while they are up. Nothing proves that it cannot, on any
 * version here, the verified one included, and no fixture could: it is a
 * question about a live channel.
 *
 * The settling hold (#2059) does not take a pane off this list. It delays the
 * nudge by one monitor interval after a launch's first idle answer and judges
 * no pane, so a screen that is still up when the interval has passed is typed
 * into exactly as before.
 *
 * An empty composer cannot be the refusal, because a usable session shows the
 * same one. When the gate refuses one of these panes, its name leaves this
 * list and its hold is pinned in `ON_FRESH_IDLE`.
 *
 * The 0.155.1 set is rows excerpted by hand, so its `dialog` pane says nothing
 * about what a whole read of that version holds.
 */
const KNOWN_UNSAFE_IF_CHANNEL_IDLE = {
  '0.156.1': ['startScreen', 'trustDialog', 'updateDialog'],
  '0.159.0': ['startScreen'],
  '0.161.0': ['startScreen']
};

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
  const sessionId = nextSession++;
  const world = { clock: 1_000_000, injected: [], recorded: [], reads: 0 };
  const s = wake._internal;
  s.listLiveAll = () => [{ id: sessionId, projectId: 10, sessionMode: 'tmux', tmuxSession: `tc-cx-${sessionId}`, engineId: 'codex' }];
  s.getProject = () => ({ id: 10, name: 'proj-cx', path: '/tmp/proj-cx' });
  s.loadProjectConfig = () => ({ medusaWake: true });
  s.wrapRunning = () => false;
  s.rotationOpen = () => false;
  s.getStatus = () => ({ state: 'listening', workspaceId: 'proj-cx-abc123', unread: 1, lastError: null });
  s.getMessages = () => [{ id: 'm1', from: 'peer', message: 'hello' }];
  s.capturePane = () => ({ lines: pane });
  s.cursorInfo = () => null;
  s.masterWakeRecord = () => null;
  s.recordDelivery = (entry) => { world.recorded.push(entry); };
  s.injectCommand = (projectName, command) => { world.injected.push(command); return { ok: true, error: null }; };
  s.openChannel = () => (channel.open
    ? { id: 7, sessionId, sequenceId: 70, engineId: 'codex', adapter: 'codex', state: 'open', adapterState: { threadId: 't-1' } }
    : null);
  s.launchSequence = () => ({ id: 70, sessionId });
  s.declaresObserver = (engineId) => engineId === 'codex';
  s.observeActivity = () => channel.answer(world.reads++);
  s.now = () => world.clock;
  // The exchange record is not what is under test here.
  s.recordWakeFacts = () => 0;
  s.alreadyAttempted = () => false;
  s.rearmDue = () => false;
  s.awaitingReadiness = () => false;
  s.noteAwaitingRead = () => 0;
  s.noteReadiness = () => 0;
  s.verifySubmission = () => Promise.resolve({ outcome: 'unknown', reason: 'fixture' });

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
            const out = await judge(pane.lines, CHANNEL_ANSWERS.idle);
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
          const out = await judge(pane.lines, CHANNEL_ANSWERS.idle);
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
        const out = await judge(pane.lines, CHANNEL_ANSWERS.idle, { ticks: 2 });
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
    assert.deepEqual(withStart, ['0.156.1', '0.159.0', '0.161.0']);
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
   * wrong, and so is `idle` on a dialog in `WITHOUT_A_MARKER_ON`; every other
   * `idle` is a pane that really is at rest.
   */
  const WITHOUT_A_MARKER = {
    idle: 'idle',
    idleWithNeighbour: 'idle',
    clippedStatusRow: 'idle',
    quotedProse: 'idle',
    idleDefaultLayout: 'idle',
    idleRunState: 'idle',
    startScreen: 'idle',
    busy: 'turn-in-flight',
    busyDefaultLayout: 'turn-in-flight',
    busyRunState: 'turn-in-flight',
    dialog: 'no-prompt',
    trustDialog: 'no-prompt',
    updateDialog: 'no-prompt',
    typing: 'no-prompt'
  };

  /**
   * Where one version's pane reads differently from the table above. On
   * 0.156.1 a dialog is drawn below the composer row the session opened with,
   * and with no marker required that stale row reads as a prompt (#2187).
   */
  const WITHOUT_A_MARKER_ON = {
    '0.156.1': { trustDialog: 'idle', updateDialog: 'idle' }
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

/** The startup dialogs a version can draw before a session is usable. */
const DIALOG_PANES = ['trustDialog', 'updateDialog'];

/** How a dialog read may say it was drawn. */
const SCREENS = ['main', 'alternate'];

/**
 * Where the selector row sits in a dialog read, and whether a bare composer
 * row is above it. Rows are compared as the gate compares them: a bare row is
 * the profile's prompt glyph with nothing typed after it.
 * @param {string[]} lines - Pane lines
 * @returns {{selector: number, footer: number, staleComposer: boolean}}
 */
function dialogShape(lines) {
  const selector = lines.findIndex((row) => /^\u203a \d+\. /.test(row));
  const footer = lines.findIndex((row) => /^ {2}enter continue \u00b7 esc /.test(row));
  const staleComposer = lines.slice(0, selector).some((row) => row.startsWith('\u203a'));
  return { selector, footer, staleComposer };
}

describe('the startup dialogs are whole reads that say which screen drew them (#2187)', () => {
  const captured = CODEX_FIXTURE_SETS.filter((set) => DIALOG_PANES.some((name) => name in set.panes));

  it('both dialogs are captured for every version that has a captured set file', () => {
    assert.deepEqual(captured.map((set) => [set.cliVersion, DIALOG_PANES.filter((name) => name in set.panes)]), [
      ['0.156.1', DIALOG_PANES],
      ['0.159.0', DIALOG_PANES],
      ['0.161.0', DIALOG_PANES]
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

      it(`codex-cli ${set.cliVersion} ${name}: known unsafe exactly when a stale composer row is above the dialog`, () => {
        assert.equal(knownUnsafe(set.cliVersion, name), dialogShape(pane.lines).staleComposer);
      });
    }
  }
});

describe('the known-unsafe list is the opening screen everywhere, and both dialogs on 0.156.1 (#2059, #2187)', () => {
  it('names nothing else, so another hole cannot be added quietly', () => {
    assert.deepEqual(KNOWN_UNSAFE_IF_CHANNEL_IDLE, {
      '0.156.1': ['startScreen', 'trustDialog', 'updateDialog'],
      '0.159.0': ['startScreen'],
      '0.161.0': ['startScreen']
    });
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

  it('the opening screen has no hold to mistake for a refusal', () => {
    assert.ok(!('startScreen' in ON_FRESH_IDLE));
  });
});
