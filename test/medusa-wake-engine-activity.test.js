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
  return world;
}

/** Let pending observation promises settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `n` ticks, letting each tick's observation land before the next — the
 * order a real five-second timer gives them.
 * @param {number} n - Tick count.
 * @returns {Promise<void>}
 */
async function ticks(n) {
  for (let i = 0; i < n; i++) {
    wake._internal.tick();
    await settle();
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
      await ticks(1 + wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 1, 'one nudge once the observation has landed and the streak is met');
      assert.equal(world.lastObserved.channel, CHANNEL);
      assert.equal(world.lastObserved.project, world.project);
      assert.equal(world.lastObserved.session, world.session);
      assert.equal(world.lastObserved.sequence, SEQUENCE, 'the facade is handed the launch to check the channel against');
    });

    it('wakes the run-state-only and neighbour layouts too, whose rows never carry the separator-wrapped marker', async () => {
      for (const pane of [CX_IDLE_PANE, CX_IDLE_WITH_NEIGHBOUR_PANE]) {
        wake.stop();
        const world = installWorld({ pane });
        await ticks(1 + wake.IDLE_TICKS_REQUIRED);
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
