'use strict';

/*
 * The wake gate's engine-activity input (#1628): for a session whose engine
 * has a native channel, what the engine's own protocol says about its thread
 * decides the one question the pane's at-rest marker used to stand in for.
 *
 * The contract under test (Architect rulings D1–D6, 2026-09-24):
 *   1. `busy` from the protocol holds the nudge whatever the pane shows;
 *   2. `idle` excuses the at-rest marker and nothing else — a busy marker, a
 *      dialog or a draft in the composer still hold;
 *   3. with NO channel, an engine meant to be judged by its channel (Codex)
 *      holds as `engine-channel-absent` — its pane marker false-idles on
 *      quoted prose — while every other engine keeps its pane gate;
 *   4. with a channel present, anything short of a fresh `idle` for the
 *      current channel and launch — not asked yet, unknown, stale, failed,
 *      or an answer about a replaced channel — holds as `engine-thread-unknown`;
 *   5. the protocol is asked only for a live, opted-in session with fresh
 *      mail, never twice at once for one channel, and nothing is ever typed
 *      from the read's callback.
 *
 * And the settling hold (#2059): the first `idle` a launch's thread reports
 * holds the nudge for one monitor interval, under its own code, whatever the
 * pane shows and whatever the idle streak is set to.
 *
 * And the untrusted-folder hold (#2186): an idle thread in a folder the
 * engine's own config says not to trust is answered `held`, and the nudge is
 * withheld under its own code until that entry changes. It is not a stall,
 * it does not start or reset the settling hold, and it recalls nothing
 * already typed.
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-engine-activity');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const {
  CX_IDLE_PANE, CX_BUSY_PANE, CX_CLIPPED_PANE, CX_TRANSCRIPT_PROSE_PANE,
  CX_DIALOG_PANE, CX_TYPING_PANE, CX_IDLE_WITH_NEIGHBOUR_PANE
} = require('./_wake-fixtures');

const CODEX = wake.ENGINE_WAKE_PROFILES.codex;
/** The monitor's cadence: the settling hold lasts one interval of it. */
const INTERVAL_MS = wake.ENGINE_SETTLING_MS;

/**
 * How long after a tick the channel's answer lands. The one overlap recorded
 * on Codex 0.156.1 had the idle answer 10 ms ahead of the pane sample.
 */
const ANSWER_LAG_MS = 10;

/**
 * Ticks from fresh mail to a nudge on a Codex session at rest: one to ask the
 * channel, one held while its first idle answer settles, then the idle streak.
 */
const TICKS_TO_NUDGE = 2 + wake.IDLE_TICKS_REQUIRED;

/** The world the last `installWorld` built: `ticks` moves its clock. */
let current = null;

const CHANNEL = { id: 7, sessionId: 1, sequenceId: 70, engineId: 'codex', adapter: 'codex', state: 'open', adapterState: { threadId: 't-1' } };
const SEQUENCE = { id: 70, sessionId: 1 };

/**
 * Install the seams for one live, opted-in Codex session with one unread
 * message. `world.activity` is what the protocol answers; `world.channel`
 * is the session's open channel (null for none).
 * @param {object} [overrides] - World overrides.
 * @returns {object} The mutable world.
 */
function installWorld(overrides = {}) {
  const world = {
    session: { id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'codex' },
    project: { id: 10, name: 'proj-cx', path: '/tmp/proj-cx' },
    status: { state: 'listening', workspaceId: 'proj-cx-abc123', unread: 1, lastError: null },
    inbox: [{ id: 'm1', from: 'peer', message: 'hello' }],
    pane: CX_CLIPPED_PANE,
    channel: CHANNEL,
    sequence: SEQUENCE,
    activity: { channel: 'present', state: 'idle', reasonCode: 'thread-idle' },
    observeCalls: 0,
    injected: [],
    recorded: [],
    clock: 1_000_000,
    ...overrides
  };
  wake._internal.listLiveAll = () => [world.session];
  wake._internal.getProject = () => world.project;
  wake._internal.loadProjectConfig = () => ({ medusaWake: true });
  wake._internal.wrapRunning = () => false;
  wake._internal.rotationOpen = () => false;
  wake._internal.getStatus = () => world.status;
  wake._internal.getMessages = () => world.inbox;
  wake._internal.capturePane = () => ({ lines: world.pane });
  wake._internal.cursorInfo = () => null;
  wake._internal.masterWakeRecord = () => null;
  wake._internal.recordDelivery = (entry) => { world.recorded.push(entry); };
  wake._internal.injectCommand = (projectName, command, options) => {
    world.injected.push({ projectName, command, options });
    return { ok: true, error: null };
  };
  wake._internal.openChannel = () => world.channel;
  wake._internal.launchSequence = () => world.sequence;
  wake._internal.declaresObserver = (engineId) => engineId === 'codex';
  wake._internal.observeActivity = (target) => {
    world.observeCalls += 1;
    world.lastObserved = target;
    return typeof world.activity === 'function' ? world.activity() : Promise.resolve(world.activity);
  };
  wake._internal.now = () => world.clock;
  current = world;
  return world;
}

/** Let pending observation promises settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `n` ticks as the monitor's timer runs them: a tick, the channel's answer
 * a moment later, and the next tick one interval after the last.
 * @param {number} n - Tick count.
 * @returns {Promise<void>}
 */
async function ticks(n) {
  for (let i = 0; i < n; i++) {
    wake._internal.tick();
    current.clock += ANSWER_LAG_MS;
    await settle();
    current.clock += INTERVAL_MS - ANSWER_LAG_MS;
  }
}

/** The latest ledger skip reason. */
const lastSkip = (world) => (world.recorded.length ? world.recorded[world.recorded.length - 1].skipReason : null);

describe('medusa-wake — engine activity from the native channel (#1628)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  describe('idle from the protocol', () => {
    it('wakes the clipped-status-row pane that held mail for hours', async () => {
      const world = installWorld();
      await ticks(TICKS_TO_NUDGE);
      assert.equal(world.injected.length, 1, 'one nudge once the observation has landed and settled and the streak is met');
      assert.equal(world.lastObserved.channel, CHANNEL);
      assert.equal(world.lastObserved.project, world.project);
      assert.equal(world.lastObserved.session, world.session);
      assert.equal(world.lastObserved.sequence, SEQUENCE, 'the facade is handed the launch to check the channel against');
    });

    it('wakes the run-state-only and neighbour layouts too, whose rows never carry the separator-wrapped marker', async () => {
      for (const pane of [CX_IDLE_PANE, CX_IDLE_WITH_NEIGHBOUR_PANE]) {
        wake.stop();
        const world = installWorld({ pane });
        await ticks(TICKS_TO_NUDGE);
        assert.equal(world.injected.length, 1);
      }
    });

    it('the very first tick holds as unknown: the read it starts answers the NEXT tick, and the pane is not consulted instead', async () => {
      const world = installWorld({ pane: CX_IDLE_WITH_NEIGHBOUR_PANE });
      wake._internal.tick();
      assert.equal(lastSkip(world), 'engine-thread-unknown');
      assert.equal(world.observeCalls, 1);
      assert.equal(world.injected.length, 0);
    });

    it('nothing is typed from the read\'s callback — only a later tick injects', async () => {
      const world = installWorld();
      let release;
      world.activity = () => new Promise((resolve) => { release = resolve; });
      wake._internal.tick();
      release({ channel: 'present', state: 'idle', reasonCode: 'thread-idle' });
      await settle();
      await settle();
      assert.equal(world.injected.length, 0);
    });

    it('a busy marker in the pane still holds — a pane that shows work outranks a protocol that says none', async () => {
      const world = installWorld({ pane: CX_BUSY_PANE });
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'pane-turn-in-flight');
    });

    it('a dialog still holds: the composer is gone and nothing is typed through it', async () => {
      const world = installWorld({ pane: CX_DIALOG_PANE });
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'pane-no-prompt');
    });

    it('a draft in the composer still holds: the protocol cannot see what the operator has typed', async () => {
      const world = installWorld({ pane: CX_TYPING_PANE });
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'pane-no-prompt');
    });

    it('a transcript that is still moving still holds', async () => {
      const world = installWorld();
      let n = 0;
      wake._internal.capturePane = () => ({ lines: [`  line ${n++}`, ...CX_CLIPPED_PANE] });
      await ticks(5);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'pane-writing');
    });
  });

  describe('busy from the protocol', () => {
    it('holds under its own code, whatever the pane says — including a pane quoting the at-rest marker in prose', async () => {
      const world = installWorld({ pane: CX_TRANSCRIPT_PROSE_PANE, activity: { channel: 'present', state: 'busy', reasonCode: 'thread-active' } });
      await ticks(5);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-thread-busy');
    });

    it('a sender reading the verdict is told what it means', () => {
      assert.match(wake.peerReasonMeaning('engine-thread-busy'), /mid-turn/);
      assert.match(wake.peerReasonMeaning('engine-thread-unknown'), /not confirmed/);
    });
  });

  describe('with a channel present, no usable answer HOLDS — it never falls back to the pane', () => {
    // A pane that would pass the gate if it were consulted, so a fallback
    // would show up as an injection.
    const PASSING = CX_IDLE_WITH_NEIGHBOUR_PANE;

    /**
     * Assert a world never injects and ends on `engine-thread-unknown`.
     * @param {object} world - The world.
     */
    async function holdsUnknown(world) {
      await ticks(5);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-thread-unknown');
    }

    it('unknown', async () => {
      await holdsUnknown(installWorld({ pane: PASSING, activity: { channel: 'present', state: 'unknown', reasonCode: 'thread-ambiguous' } }));
    });

    it('a read that fails', async () => {
      await holdsUnknown(installWorld({ pane: PASSING, activity: () => Promise.reject(new Error('socket gone')) }));
    });

    it('a seam that throws synchronously', async () => {
      const world = installWorld({ pane: PASSING });
      wake._internal.observeActivity = () => { throw new Error('adapter exploded'); };
      await holdsUnknown(world);
    });

    it('a channel lookup that throws — whether a channel exists is itself unknown', async () => {
      const world = installWorld({ pane: PASSING });
      wake._internal.openChannel = () => { throw new Error('db locked'); };
      await holdsUnknown(world);
      assert.equal(world.observeCalls, 0);
    });

    it('an answer that is not the facade\'s shape', async () => {
      await holdsUnknown(installWorld({ pane: PASSING, activity: { state: 'idle' } }));
    });

    it('a channel that closed between lookup and read', async () => {
      await holdsUnknown(installWorld({ pane: PASSING, activity: { channel: 'absent', state: 'unknown', reasonCode: 'no-channel' } }));
    });

    it('an idle answer older than the freshness window', async () => {
      const world = installWorld({ pane: PASSING });
      await ticks(1);
      world.activity = () => new Promise(() => {});
      world.clock += wake.ENGINE_ACTIVITY_MAX_AGE_MS + 1;
      await holdsUnknown(world);
    });

    it('an idle answer about a REPLACED channel is not used for the new one', async () => {
      const world = installWorld({ pane: PASSING });
      await ticks(1);
      world.channel = { ...CHANNEL, id: 8, sequenceId: 71 };
      world.activity = () => new Promise(() => {});
      await holdsUnknown(world);
    });

    it('a late answer for the old channel, landing after the replacement, is discarded', async () => {
      const world = installWorld({ pane: PASSING });
      let release;
      world.activity = () => new Promise((resolve) => { release = resolve; });
      wake._internal.tick();
      const first = release;
      world.channel = { ...CHANNEL, id: 8, sequenceId: 71 };
      wake._internal.tick();
      first({ channel: 'present', state: 'idle', reasonCode: 'thread-idle' });
      await settle();
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-thread-unknown');
    });
  });

  describe('with NO channel', () => {
    it('a Codex session holds as engine-channel-absent, even on the pane that quotes the marker in prose (ledger 5030)', async () => {
      const world = installWorld({ channel: null, pane: CX_TRANSCRIPT_PROSE_PANE });
      assert.equal(wake._assessPane(CX_TRANSCRIPT_PROSE_PANE, CODEX, null).idle, true,
        'precondition: the pane gate alone reads this pane as at rest — the false idle the hold exists for');
      await ticks(1 + wake.IDLE_TICKS_REQUIRED + 2);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-channel-absent');
      assert.equal(world.observeCalls, 0);
    });

    it('a Codex channel that goes away holds as absent, not as the answer it gave', async () => {
      const world = installWorld({ pane: CX_IDLE_WITH_NEIGHBOUR_PANE });
      await ticks(1);
      world.channel = null;
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-channel-absent');
    });

    it('if whether the engine is observed cannot be told, it holds', async () => {
      const world = installWorld({ channel: null, pane: CX_TRANSCRIPT_PROSE_PANE });
      wake._internal.declaresObserver = () => { throw new Error('profile unreadable'); };
      await ticks(4);
      assert.equal(world.injected.length, 0);
      assert.equal(lastSkip(world), 'engine-channel-absent');
    });

    it('an engine not judged by a channel keeps its pane gate exactly, and is never asked', async () => {
      const { IDLE_PANE } = require('./_wake-fixtures');
      const world = installWorld({
        channel: null,
        session: { id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' },
        pane: IDLE_PANE
      });
      await ticks(wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 1);
      assert.equal(world.observeCalls, 0);
    });

    it('a sender reading the verdict is told how to restore wakes', () => {
      assert.match(wake.peerReasonMeaning('engine-channel-absent'), /relaunch/i);
    });
  });

  describe('the Project Master', () => {
    /** A live Codex Master record, as `lib/master.js#masterWakeRecord` shapes it. */
    const codexMaster = () => ({
      id: 'master', isMaster: true, name: 'Project Master', tmuxSession: 'tangleclaw-master',
      engineId: 'codex', sessionMode: 'tmux', status: 'active', medusaWake: true, apiBase: '/api/master/medusa'
    });

    it('a Codex Master — which never has a launch channel — holds under a code that does not advise a relaunch', async () => {
      const world = installWorld({ pane: CX_TRANSCRIPT_PROSE_PANE });
      const injected = [];
      wake._internal.listLiveAll = () => [];
      wake._internal.masterWakeRecord = () => codexMaster();
      wake._internal.injectMaster = (command) => { injected.push(command); return { ok: true, error: null }; };
      await ticks(1 + wake.IDLE_TICKS_REQUIRED + 2);
      assert.equal(injected.length, 0);
      assert.equal(lastSkip(world), 'master-engine-unobserved');
      assert.equal(world.observeCalls, 0);
      assert.match(wake.peerReasonMeaning('master-engine-unobserved'), /relaunch does not/);
      assert.doesNotMatch(wake.peerReasonMeaning('master-engine-unobserved'), /restores/);
    });
  });

  describe('engines not judged by a channel never consult one', () => {
    it('a channel lookup that throws cannot hold a Claude session', async () => {
      const { IDLE_PANE } = require('./_wake-fixtures');
      const world = installWorld({
        session: { id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' },
        pane: IDLE_PANE
      });
      let lookups = 0;
      wake._internal.openChannel = () => { lookups += 1; throw new Error('db locked'); };
      await ticks(wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 1);
      assert.equal(lookups, 0);
    });
  });

  describe('when the protocol is asked', () => {
    it('never while a read for the same channel is still out', async () => {
      const world = installWorld({ activity: () => new Promise(() => {}) });
      await ticks(5);
      assert.equal(world.observeCalls, 1);
    });

    it('never for a session with no unread mail', async () => {
      const world = installWorld({ status: { state: 'listening', workspaceId: 'w', unread: 0, lastError: null }, inbox: [] });
      await ticks(3);
      assert.equal(world.observeCalls, 0);
    });

    it('never for a session that has not opted into the wake', async () => {
      const world = installWorld();
      wake._internal.loadProjectConfig = () => ({ medusaWake: false });
      await ticks(3);
      assert.equal(world.observeCalls, 0);
    });
  });
});

describe('medusa-wake — the settling hold after a launch\'s thread first reports idle (#2059)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  const { CODEX_FIXTURE_SETS } = require('./_wake-fixtures');
  const CX_0156 = CODEX_FIXTURE_SETS.find((set) => set.cliVersion === '0.156.1').panes;

  /**
   * The overlap recorded on Codex 0.156.1 after its update prompt was skipped:
   * the channel answered idle 4.16 s into the launch, a pane sample 10 ms
   * later still drew the `model: loading` header over an empty composer, and
   * the sample 0.19 s after that was the usable composer.
   */
  const OVERLAP = { idleAnswerAt: 4160, loadingPaneAt: 4170, usablePaneAt: 4360 };
  const LOADING_PANE = CX_0156.startScreen.lines;
  const USABLE_PANE = CX_0156.idleDefaultLayout.lines;

  /** Every skip reason the ledger holds, in order. */
  const skips = (world) => world.recorded.filter((r) => r.outcome === 'skipped').map((r) => r.skipReason);

  /**
   * A second message arriving for a session already nudged for the first.
   * @param {object} world - The world.
   */
  function moreMail(world) {
    world.inbox = [...world.inbox, { id: `m${world.inbox.length + 1}`, from: 'peer', message: 'again' }];
    world.recorded.length = 0;
  }

  it('the recorded overlap is held: an idle answer over the loading screen types nothing, with no streak to lean on', async () => {
    const launchedAt = 1_000_000;
    const world = installWorld({ pane: LOADING_PANE, clock: launchedAt + OVERLAP.idleAnswerAt - ANSWER_LAG_MS });
    wake._internal.idleTicksRequired = () => 1;
    assert.equal(wake._assessPane(LOADING_PANE, CODEX, null, true).idle, true,
      'precondition: handed an idle answer, the pane gate does not refuse the loading screen');

    wake._internal.tick(); // asks the channel
    world.clock = launchedAt + OVERLAP.idleAnswerAt;
    await settle(); // the idle answer lands
    world.clock = launchedAt + OVERLAP.loadingPaneAt;
    wake._internal.tick(); // the recorded sample: idle answer in hand, loading header on the pane
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-settling');

    world.pane = USABLE_PANE;
    world.clock = launchedAt + OVERLAP.usablePaneAt;
    await settle();
    wake._internal.tick(); // the next recorded sample: usable, and still inside the interval
    assert.equal(world.injected.length, 0, 'a usable composer does not end the hold early');
    assert.equal(lastSkip(world), 'engine-thread-settling');

    world.clock = launchedAt + OVERLAP.idleAnswerAt + INTERVAL_MS;
    await settle();
    wake._internal.tick();
    assert.equal(world.injected.length, 1, 'one interval after the first idle answer the session is woken');
  });

  it('the hold is one full interval from the first idle answer: a millisecond short still holds', async () => {
    const world = installWorld();
    wake._internal.idleTicksRequired = () => 1;
    wake._internal.tick();
    await settle(); // first idle answer, at the starting clock
    world.clock += INTERVAL_MS - 1;
    wake._internal.tick();
    await settle();
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-settling');
    world.clock += 1;
    wake._internal.tick();
    assert.equal(world.injected.length, 1);
  });

  it('a thread idle for longer than the interval is not held: later mail is nudged on the streak alone', async () => {
    const world = installWorld();
    await ticks(TICKS_TO_NUDGE);
    assert.equal(world.injected.length, 1);
    assert.deepEqual(skips(world), ['engine-thread-unknown', 'engine-thread-settling'], 'held once, for the first idle answer');

    moreMail(world);
    await ticks(wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 2, 'no tick is spent settling again');
    assert.deepEqual(skips(world), []);
  });

  it('a turn that ends does not start the hold again: busy then idle on the same channel is not a launch', async () => {
    const world = installWorld();
    await ticks(TICKS_TO_NUDGE);
    assert.equal(world.injected.length, 1);

    moreMail(world);
    world.activity = { channel: 'present', state: 'busy', reasonCode: 'thread-active' };
    await ticks(3);
    assert.equal(lastSkip(world), 'engine-thread-busy');
    world.activity = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };
    await ticks(1 + wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 2);
    assert.ok(!skips(world).includes('engine-thread-settling'));
  });

  it('a channel replaced by a relaunch starts the hold again', async () => {
    const world = installWorld();
    await ticks(TICKS_TO_NUDGE);
    assert.equal(world.injected.length, 1);

    moreMail(world);
    world.channel = { ...CHANNEL, id: 8, sequenceId: 71 };
    await ticks(2);
    assert.equal(world.injected.length, 1, 'the new channel\'s first idle answer is held');
    assert.deepEqual(skips(world), ['engine-thread-unknown', 'engine-thread-settling']);
    await ticks(wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 2, 'and the session is woken once it has settled');
  });

  it('a channel that goes away and comes back starts the hold again', async () => {
    const world = installWorld();
    await ticks(TICKS_TO_NUDGE);
    moreMail(world);
    world.channel = null;
    await ticks(1);
    assert.equal(lastSkip(world), 'engine-channel-absent');
    world.channel = CHANNEL;
    await ticks(2);
    assert.equal(world.injected.length, 1);
    assert.equal(lastSkip(world), 'engine-thread-settling');
  });

  for (const required of [1, wake.IDLE_TICKS_REQUIRED, wake.IDLE_TICKS_REQUIRED + 3]) {
    it(`changing the idle streak to ${required} does not remove the hold`, async () => {
      const world = installWorld();
      wake._internal.idleTicksRequired = () => required;
      await ticks(2);
      assert.equal(world.injected.length, 0, 'the first idle answer never produces a nudge');
      assert.equal(lastSkip(world), 'engine-thread-settling');
      await ticks(required);
      assert.equal(world.injected.length, 1, 'and the streak, whatever it is, is counted from after the hold');
    });
  }

  it('the hold is time, not ticks: with the clock standing still no number of ticks ends it', async () => {
    const world = installWorld();
    wake._internal.idleTicksRequired = () => 1;
    for (let i = 0; i < 10; i++) {
      wake._internal.tick();
      await settle();
    }
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-settling');
  });

  it('a clock that steps backwards holds rather than types', async () => {
    const world = installWorld();
    wake._internal.idleTicksRequired = () => 1;
    wake._internal.tick();
    await settle();
    world.clock -= 60 * 1000;
    wake._internal.tick();
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-settling');
  });

  it('an engine not judged by a channel is never held to settle', async () => {
    const { IDLE_PANE } = require('./_wake-fixtures');
    const world = installWorld({
      channel: null,
      session: { id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' },
      pane: IDLE_PANE
    });
    await ticks(wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 1);
    assert.deepEqual(skips(world), []);
  });

  it('a sender asking about the peer while it settles gets the code, its meaning and that waiting fixes it', async () => {
    const world = installWorld();
    wake._internal.masterKey = () => 'master';
    wake._internal.readRegistry = () => [];
    await ticks(2);
    const answer = wake.peerReachability(world.status.workspaceId);
    assert.equal(answer.local, true);
    assert.equal(answer.reason, 'engine-thread-settling');
    assert.equal(answer.meaning, wake.peerReasonMeaning('engine-thread-settling'));
    // The monitor's timer is not running in a hand-driven test, and a stopped
    // monitor never tells a sender to wait; the disposition tests pin the reason's own class.
    assert.equal(answer.monitorRunning, false);
    await ticks(wake.IDLE_TICKS_REQUIRED);
    assert.equal(wake.peerReachability(world.status.workspaceId).reason, 'nudged', 'and the verdict moves on once the session is woken');
  });

  it('a sender reading the verdict is told it is brief and why', () => {
    assert.match(wake.peerReasonMeaning('engine-thread-settling'), /only just reported/);
    assert.match(wake.peerReasonMeaning('engine-thread-settling'), /one monitor interval/);
  });

  it('the hold lasts one monitor interval', () => {
    assert.equal(wake.ENGINE_SETTLING_MS, 5000);
    assert.ok(wake.ENGINE_SETTLING_MS < wake.ENGINE_ACTIVITY_MAX_AGE_MS, 'an answer outlives its own settling, or no session would ever be woken');
  });
});

describe('medusa-wake — a folder the engine was told not to trust holds the nudge (#2186)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  const HELD = { channel: 'present', state: 'held', reasonCode: 'folder-untrusted' };
  const IDLE = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };
  const CODE = 'engine-folder-untrusted';

  /** Every skip reason the ledger holds, in order. */
  const skips = (world) => world.recorded.filter((r) => r.outcome === 'skipped').map((r) => r.skipReason);
  /** The ledger's nudged rows. */
  const nudges = (world) => world.recorded.filter((r) => r.outcome === 'nudged');

  /**
   * A second message arriving for a session already nudged for the first.
   * @param {object} world - The world.
   */
  function moreMail(world) {
    world.inbox = [...world.inbox, { id: `m${world.inbox.length + 1}`, from: 'peer', message: 'again' }];
  }

  it('types nothing, however long the session sits at rest on a usable pane, and says why', async () => {
    const world = installWorld({ activity: HELD, pane: CX_IDLE_PANE });
    await ticks(TICKS_TO_NUDGE + 20);
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), CODE);
    assert.deepEqual([...new Set(skips(world).slice(1))], [CODE], 'after the first, unanswered tick it is the only reason given');
  });

  it('is recorded once for the edge, not once per tick', async () => {
    const world = installWorld({ activity: HELD });
    await ticks(30);
    assert.equal(skips(world).filter((r) => r === CODE).length, 1);
  });

  it('a held answer with a reason this monitor does not know holds as unknown, never as idle', async () => {
    const world = installWorld({ activity: { channel: 'present', state: 'held', reasonCode: 'something-new' } });
    await ticks(TICKS_TO_NUDGE + 2);
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-unknown');
  });

  it('is not a stall: no alert is raised however long it lasts', async () => {
    const world = installWorld({ activity: HELD });
    for (let t = 0; t < wake.WAKE_STALL_ALERT_MS * 3; t += INTERVAL_MS) await ticks(1);
    assert.equal(wake.wakeStallSummary(), null);
    assert.equal(world.injected.length, 0);
  });

  it('a sender asking about the peer gets the code, its meaning and what its operator can choose', async () => {
    const world = installWorld({ activity: HELD });
    wake._internal.masterKey = () => 'master';
    wake._internal.readRegistry = () => [];
    await ticks(3);
    const answer = wake.peerReachability(world.status.workspaceId);
    assert.equal(answer.local, true);
    assert.equal(answer.reason, CODE);
    assert.equal(answer.meaning, wake.peerReasonMeaning(CODE));
    assert.match(answer.meaning, /does not trust/);
    assert.match(answer.meaning, /trusted/);
    assert.match(answer.meaning, /by hand/);
  });

  it('the entry set to trusted releases the nudge with no relaunch, after the settling hold it never started', async () => {
    const world = installWorld({ activity: HELD, pane: CX_IDLE_PANE });
    await ticks(10);
    assert.equal(world.injected.length, 0);
    world.activity = IDLE;
    await ticks(1);
    assert.equal(lastSkip(world), CODE, 'the tick that asks still holds on the last answer');
    await ticks(1);
    assert.equal(lastSkip(world), 'engine-thread-settling', 'the first idle answer of this launch settles like any other');
    assert.equal(world.injected.length, 0);
    await ticks(wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 1);
  });

  it('does not restart the settling hold of a thread that had already settled', async () => {
    const world = installWorld({ pane: CX_IDLE_PANE });
    await ticks(TICKS_TO_NUDGE);
    assert.equal(world.injected.length, 1, 'trusted and nudged for the first message');
    world.activity = HELD;
    moreMail(world);
    await ticks(6);
    assert.equal(world.injected.length, 1);
    assert.equal(lastSkip(world), CODE);
    world.activity = IDLE;
    await ticks(2 + wake.IDLE_TICKS_REQUIRED);
    assert.equal(world.injected.length, 2);
    assert.ok(!skips(world).slice(skips(world).lastIndexOf(CODE)).includes('engine-thread-settling'), 'no second settling hold on the same channel');
  });

  it('a nudge already typed is not recalled: its receipt stays, and only later mail is held', async () => {
    const world = installWorld({ pane: CX_IDLE_PANE });
    await ticks(TICKS_TO_NUDGE);
    assert.equal(nudges(world).length, 1);
    world.activity = HELD;
    await ticks(10);
    assert.equal(world.injected.length, 1, 'nothing more is typed for the edge already nudged');
    assert.equal(nudges(world).length, 1, 'the nudged receipt is still the edge\'s record');
    assert.ok(!skips(world).includes(CODE), 'an owned edge is not rewritten as held');
    moreMail(world);
    await ticks(6);
    assert.equal(world.injected.length, 1);
    assert.equal(lastSkip(world), CODE, 'the next message is the one held');
  });

  describe('an edge already nudged and still being watched (observe-only)', () => {
    /**
     * A world nudged once, whose attempt the watchdog has not settled, with
     * the durable record's seams captured.
     * @returns {Promise<object>} The world, with `facts` and `readiness` filled as the monitor records.
     */
    async function nudgedAndWatched() {
      const world = installWorld({ pane: CX_IDLE_PANE });
      world.facts = [];
      world.readiness = 0;
      world.rearm = false;
      wake._internal.recordWakeFacts = (workspaceId, fact, opts) => { world.facts.push({ fact, code: opts && opts.code }); };
      wake._internal.noteReadiness = () => { world.readiness += 1; return 1; };
      wake._internal.awaitingReadiness = () => true;
      wake._internal.rearmDue = () => { const due = world.rearm; world.rearm = false; return due; };
      wake._internal.alreadyAttempted = () => false;
      wake._internal.pendingWakeCount = () => 0;
      await ticks(TICKS_TO_NUDGE);
      assert.equal(world.injected.length, 1);
      return world;
    }
    const blocked = (world) => world.facts.filter((f) => f.fact === 'wake_blocked').map((f) => f.code);

    it('a held answer is recorded as a readiness observation: the nudged row stays and nothing is typed', async () => {
      const world = await nudgedAndWatched();
      world.facts.length = 0;
      world.activity = HELD;
      await ticks(6);
      assert.ok(blocked(world).includes(CODE), 'the watchdog is told the session is not eligible now, and why');
      assert.equal(world.injected.length, 1);
      assert.equal(nudges(world).length, 1);
      assert.ok(!skips(world).includes(CODE), 'the ledger does not say the earlier nudge was withheld');
      assert.equal(world.readiness, 0, 'a held session is never reported as having become ready');
      assert.equal(wake.verdictFor(1).reason, 'nudged');
    });

    it('held then trusted is reported as a readiness change, and a re-arm then nudges once', async () => {
      const world = await nudgedAndWatched();
      world.activity = HELD;
      await ticks(6);
      assert.equal(world.readiness, 0);
      world.activity = IDLE;
      await ticks(2 + wake.IDLE_TICKS_REQUIRED);
      assert.ok(world.readiness > 0, 'ineligible to eligible is recorded for the watchdog');
      assert.equal(world.injected.length, 1, 'observing never types');
      world.rearm = true;
      await ticks(1 + wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 2, 'the re-armed edge goes back through the gates and is nudged');
    });

    it('a re-arm that lands while the folder is still untrusted is held, then nudged once it is trusted', async () => {
      const world = await nudgedAndWatched();
      world.activity = HELD;
      await ticks(3);
      world.rearm = true;
      await ticks(6);
      assert.equal(world.injected.length, 1);
      assert.equal(lastSkip(world), CODE, 'a re-armed edge is an ordinary edge again, and is held like one');
      world.activity = IDLE;
      await ticks(2 + wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 2);
    });
  });

  it('the settling samples are still held with this hold in the chain: an idle answer over the loading screen types nothing', async () => {
    const { CODEX_FIXTURE_SETS } = require('./_wake-fixtures');
    const loading = CODEX_FIXTURE_SETS.find((set) => set.cliVersion === '0.156.1').panes.startScreen.lines;
    wake._internal.idleTicksRequired = () => 1;
    const world = installWorld({ pane: loading });
    await ticks(2);
    assert.equal(world.injected.length, 0);
    assert.equal(lastSkip(world), 'engine-thread-settling');
  });
});

describe('medusa-wake — assessSessionIdle takes the engine\'s answer as an input (#1628)', () => {
  it('engineIdle lifts only the at-rest marker', () => {
    const lifted = wake.assessSessionIdle({ lines: CX_CLIPPED_PANE, profile: CODEX, engineIdle: true, ticksRequired: 1 });
    assert.equal(lifted.idle, true);
    const held = wake.assessSessionIdle({ lines: CX_CLIPPED_PANE, profile: CODEX, ticksRequired: 1 });
    assert.deepEqual([held.idle, held.reason], [false, 'not-at-rest']);
    const busy = wake.assessSessionIdle({ lines: CX_BUSY_PANE, profile: CODEX, engineIdle: true, ticksRequired: 1 });
    assert.deepEqual([busy.idle, busy.reason], [false, 'turn-in-flight']);
  });

  it('a notifier (mustBeTypeable: false) gets the same lift', () => {
    const r = wake.assessSessionIdle({ lines: CX_CLIPPED_PANE, profile: CODEX, engineIdle: true, mustBeTypeable: false, ticksRequired: 1 });
    assert.equal(r.idle, true);
  });
});

describe('medusa-wake — a prolonged engine-thread-unknown alerts the operator (#1978)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  const UNKNOWN = { channel: 'present', state: 'unknown', reasonCode: 'thread-ambiguous' };

  /**
   * Tick through `ms` of server time at the monitor's own cadence.
   * @param {object} world - The world whose clock `ticks` advances.
   * @param {number} ms - How long to run.
   * @returns {Promise<void>}
   */
  async function runFor(world, ms) {
    assert.equal(world, current, 'the clock that moves is the installed world\'s');
    for (let t = 0; t < ms; t += INTERVAL_MS) await ticks(1);
  }

  it('says nothing before the threshold, then names the stalled session, its adapter reason and its age', async () => {
    const world = installWorld({ activity: UNKNOWN });
    await runFor(world, wake.WAKE_STALL_ALERT_MS - 60 * 1000);
    assert.equal(wake.wakeStallSummary(), null);
    await runFor(world, 2 * 60 * 1000);
    const summary = wake.wakeStallSummary();
    assert.equal(summary.count, 1);
    assert.equal(summary.oldest.sessionId, 1);
    assert.equal(summary.oldest.project, 'proj-cx');
    assert.equal(summary.oldest.engineReason, 'thread-ambiguous');
    assert.ok(summary.oldest.ageMinutes >= wake.WAKE_STALL_ALERT_MS / 60000);
    assert.equal(summary.oldest.meaning, wake.peerReasonMeaning('engine-thread-unknown'));
    assert.equal(world.injected.length, 0, 'the alert never types into the pane');
  });

  it('clears the moment the engine answers idle', async () => {
    const world = installWorld({ activity: UNKNOWN });
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    assert.equal(wake.wakeStallSummary().count, 1);
    world.activity = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };
    await runFor(world, 10 * 1000);
    assert.equal(wake.wakeStallSummary(), null);
  });

  it('clears when the mail is read, and a later stall starts its own clock', async () => {
    const world = installWorld({ activity: UNKNOWN });
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    world.status = { ...world.status, unread: 0 };
    world.inbox = [];
    await runFor(world, 5000);
    assert.equal(wake.wakeStallSummary(), null);
    world.status = { ...world.status, unread: 1 };
    world.inbox = [{ id: 'm2', from: 'peer', message: 'again' }];
    await runFor(world, 60 * 1000);
    assert.equal(wake.wakeStallSummary(), null, 'the old episode\'s age does not carry over');
  });

  it('a busy engine is not a stall — it is working, and the wake waits for it', async () => {
    const world = installWorld({ activity: { channel: 'present', state: 'busy', reasonCode: 'thread-active' } });
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    assert.equal(wake.wakeStallSummary(), null);
  });

  it('warns once per stall episode, and again for the next episode', async () => {
    const logger = require('../lib/logger');
    const lines = [];
    logger.setLevel('warn');
    logger.setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
    try {
      const stallWarnings = () => lines.filter((l) => l.includes('held for want of an engine answer')).length;
      const world = installWorld({ activity: UNKNOWN });
      await runFor(world, wake.WAKE_STALL_ALERT_MS - 60 * 1000);
      assert.equal(stallWarnings(), 0, 'nothing before the threshold');
      await runFor(world, 5 * 60 * 1000);
      assert.equal(stallWarnings(), 1, 'one warning, not one per tick');
      world.activity = { channel: 'present', state: 'busy', reasonCode: 'thread-active' };
      await runFor(world, 10 * 1000);
      world.activity = UNKNOWN;
      await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
      assert.equal(stallWarnings(), 2, 'a new episode is said again');
    } finally {
      logger.setConsoleStream(null);
      logger.setLevel('error');
    }
  });

  it('with several sessions stalled, counts them all and names the one stalled longest', async () => {
    const world = installWorld({ activity: UNKNOWN });
    const second = { ...world.session, id: 2, projectId: 20, tmuxSession: 'tc-2' };
    const projects = { 10: world.project, 20: { id: 20, name: 'proj-late', path: '/tmp/proj-late' } };
    wake._internal.getProject = (id) => projects[id];
    await runFor(world, 3 * 60 * 1000);
    wake._internal.listLiveAll = () => [world.session, second];
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    const summary = wake.wakeStallSummary();
    assert.equal(summary.count, 2);
    assert.equal(summary.oldest.sessionId, 1);
    assert.equal(summary.oldest.project, 'proj-cx');
  });

  it('a project lookup that throws still raises the alert, unnamed', async () => {
    const world = installWorld({ activity: UNKNOWN });
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    wake._internal.getProject = () => { throw new Error('store closed'); };
    const summary = wake.wakeStallSummary();
    assert.equal(summary.count, 1);
    assert.equal(summary.oldest.project, null);
    assert.equal(summary.oldest.sessionId, 1);
  });

  it('clears when the session ends', async () => {
    const world = installWorld({ activity: UNKNOWN });
    await runFor(world, wake.WAKE_STALL_ALERT_MS + 60 * 1000);
    wake._internal.listLiveAll = () => [];
    await runFor(world, 5000);
    assert.equal(wake.wakeStallSummary(), null);
  });
});
