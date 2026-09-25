'use strict';

// #1839: the delivery watchdog's re-arm budget and the wake monitor's side of
// it. Time is a fake clock throughout: an hour-scale backoff is walked in
// milliseconds, and a "restart" is simply the watchdog reading the same durable
// record with no memory of its own.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const mx = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');
const wake = require('../lib/medusa-wake');
const transports = require('../lib/wake-transports');
const { IDLE_PANE, BUSY_PANE } = require('./_wake-fixtures');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-25T12:00:00.000Z');
const PM = { kind: 'project', projectId: 10 };

let tmpDir = null;
let clock = T0;

/**
 * Set the fake clock.
 * @param {number} ms - Epoch ms
 * @returns {void}
 */
function at(ms) {
  clock = ms;
}

/**
 * A blocking message from the PM to the Builder, stored and delivered.
 * @param {string} [hubId] - Hub id
 * @returns {object} The exchange row
 */
function deliveredBlocking(hubId = 'hub-1') {
  const x = mx.createSendIntent({
    meta: mx.validateSendMeta({ priority: 'blocking' }, PM, 10),
    sender: { projectId: 10, workspaceId: 'pm-ws' },
    recipient: { workspaceId: 'builder-ws', projectId: 20, sessionId: 2 }
  });
  mx.bindHubId(x.exchange_id, hubId);
  mx.recordArrival({ hubId, recipientWorkspaceId: 'builder-ws' });
  return store.medusaExchanges.get(x.exchange_id);
}

/**
 * Record a wake attempt on the Builder's pending mail at the current clock.
 * @returns {void}
 */
function attempt() {
  mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: `n${clock}` } });
}

describe('medusa-watchdog (#1839)', () => {
  const origLoad = watchdog._internal.loadConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-watchdog-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = T0;
    mx._internal.now = () => new Date(clock);
    watchdog._internal.loadConfig = () => ({});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mx._internal.now = () => new Date();
    watchdog._internal.loadConfig = origLoad;
  });

  describe('settings', () => {
    it('uses the defaults when nothing is stored', () => {
      assert.deepEqual(watchdog.resolveSettings({}).settings, { ...watchdog.DEFAULTS });
    });

    it('refuses unknown keys and out-of-bounds values, and merges a valid patch', () => {
      assert.match(watchdog.validatePatch({ bogus: 1 }, {}).error, /not a setting/);
      assert.match(watchdog.validatePatch({ tickMs: 10 }, {}).error, /tickMs/);
      assert.match(watchdog.validatePatch({ backoffMs: [] }, {}).error, /backoffMs/);
      assert.match(watchdog.validatePatch({ enabled: 'yes' }, {}).error, /enabled/);
      assert.deepEqual(watchdog.validatePatch({ maxRearms: 1 }, { enabled: false }).value, { enabled: false, maxRearms: 1 });
    });

    it('ignores a bad stored value, with a warning, rather than running on it', () => {
      const { settings, warning } = watchdog.resolveSettings({ medusaWatchdog: { tickMs: 1 } });
      assert.equal(settings.tickMs, watchdog.DEFAULTS.tickMs);
      assert.match(warning, /using the defaults/);
    });
  });

  describe('re-arm triggers and budget (R20 A3)', () => {
    /**
     * Persist the post-attempt readiness change a re-arm needs: an ineligible
     * verdict after the attempt, then the monitor finding it eligible again.
     * @param {string} [from] - The ineligible verdict
     * @returns {void}
     */
    const readinessChange = (from = 'pane-turn-in-flight') => {
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: from });
      assert.ok(mx.noteReadiness('builder-ws') >= 1, 'the readiness change is recorded');
    };

    it('(1) does not re-arm on elapsed time alone, and spends no budget', () => {
      const x = deliveredBlocking();
      attempt();
      for (const t of [3, 10, 60, 180]) assert.equal(watchdog.tick(T0 + t * MIN).rearmed, 0, `nothing at +${t} min`);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.rearm_count, 0);
      assert.equal(row.state, 'wake_attempted');
      assert.equal(mx.rearmDue('builder-ws'), false);
    });

    it('does not count eligibility without a prior ineligible verdict as a readiness change', () => {
      const x = deliveredBlocking();
      attempt();
      assert.equal(mx.noteReadiness('builder-ws'), 0, 'eligible all along is no change');
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 0);
    });

    it('(2) re-arms once a persisted readiness change is newer than the attempt, not before rearmAfterMs', () => {
      const x = deliveredBlocking();
      attempt();
      at(T0 + MIN);
      readinessChange();
      assert.equal(watchdog.tick(T0 + 2 * MIN).rearmed, 0, 'inside rearmAfterMs');
      at(T0 + 3 * MIN);
      assert.equal(watchdog.tick(clock).rearmed, 1);
      assert.equal(watchdog.tick(clock).rearmed, 0, 'a duplicate tick re-arms nothing');
      const facts = store.medusaExchanges.facts(x.exchange_id);
      assert.equal(facts.find((f) => f.fact === 'rearmed').code, 'readiness-changed');
      const change = facts.find((f) => f.fact === 'readiness_changed');
      assert.equal(JSON.parse(change.detail_json).nonce, `n${T0}`, 'tied to the attempt it follows');
      assert.equal(mx.rearmDue('builder-ws'), true);
    });

    it('does not reuse a readiness change from before the newest attempt', () => {
      const x = deliveredBlocking();
      attempt();
      readinessChange();
      at(T0 + 3 * MIN);
      watchdog.tick(clock);
      attempt();
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0, 'the second attempt needs its own trigger');
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 1);
    });

    it('re-arms a negative receipt at once', () => {
      const x = deliveredBlocking();
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: 'n1' } });
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', attemptNonce: 'n1' });
      assert.equal(watchdog.tick(T0).rearmed, 1);
      assert.equal(store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'rearmed').code, 'not-accepted');
    });

    it('(3) a restart between the ineligible verdict and eligibility, or before the tick, keeps the decision', () => {
      const x = deliveredBlocking();
      attempt();
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'listener-connecting' });
      // "Restart": the store is reopened and nothing survives but the record.
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(mx.noteReadiness('builder-ws'), 1, 'the ineligible half survived the restart');
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(watchdog.tick(T0 + 3 * MIN).rearmed, 1, 'the watchdog decides from the durable record');
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(watchdog.tick(T0 + 3 * MIN).rearmed, 0, 'and a restarted duplicate tick re-arms nothing');
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 1);
    });

    it('(4) leaves an attempt with no trigger open, unread and escalatable by age', () => {
      const x = deliveredBlocking();
      attempt();
      watchdog.tick(T0 + 90 * MIN);
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.rearm_count, 0);
      assert.ok(store.medusaExchanges.listOpen().some((r) => r.exchange_id === x.exchange_id), 'still in the working set');
      assert.equal(Date.parse(row.created_at), T0, 'its age is measured from when it was sent');
      assert.equal(mx.recordEscalationFact(x.exchange_id, 'escalation_queued', { code: 'blocking-unread' }).esc_level, 'escalated',
        'an age escalation can still be recorded on it');
    });

    it('walks the backoff and stops at the cap, each re-arm on its own trigger', () => {
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { rearmAfterMs: 30 * 1000 } });
      const x = deliveredBlocking();
      const cycle = (t) => { at(t); attempt(); at(t + 10 * 1000); readinessChange(); };
      cycle(T0);
      assert.equal(watchdog.tick(T0 + MIN).rearmed, 1, 're-arm 1');
      cycle(T0 + MIN);
      assert.equal(watchdog.tick(T0 + 2 * MIN).rearmed, 0, 'inside the 2-minute step');
      assert.equal(watchdog.tick(T0 + 3 * MIN).rearmed, 1, 're-arm 2');
      cycle(T0 + 3 * MIN);
      assert.equal(watchdog.tick(T0 + 6 * MIN).rearmed, 0, 'inside the 4-minute step');
      assert.equal(watchdog.tick(T0 + 7 * MIN).rearmed, 1, 're-arm 3');
      cycle(T0 + 7 * MIN);
      assert.equal(watchdog.tick(T0 + 60 * MIN).rearmed, 0, 'the budget is spent');
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 3);
    });

    it('never re-arms mail that has been read, or when the watchdog is disabled', () => {
      deliveredBlocking();
      attempt();
      readinessChange();
      mx.recordRead(['hub-1'], 'builder-ws', { kind: 'project', projectId: 20 });
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);

      deliveredBlocking('hub-2');
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' });
      readinessChange();
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { enabled: false } });
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);
    });

    it('shows a blocked verdict after a re-arm without cancelling the re-arm', () => {
      const x = deliveredBlocking();
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: 'n1' } });
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', attemptNonce: 'n1' });
      watchdog.tick(T0);
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-composer-has-input' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'pane-composer-has-input', 'the real blocker is visible');
      assert.equal(mx.rearmDue('builder-ws'), true, 'and the re-arm still stands');
    });

    it('never re-arms a wake an engine-native receipt says was accepted', () => {
      deliveredBlocking();
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'native', detail: { nonce: 'n1' } });
      mx.recordWakeForRecipient('builder-ws', 'wake_accepted', { code: 'native', attemptNonce: 'n1' });
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-turn-in-flight' });
      assert.equal(mx.noteReadiness('builder-ws'), 0, 'an accepted attempt is settled; nothing to watch for');
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);
    });

    it('applies a receipt only to the exchanges its attempt reached', () => {
      const early = deliveredBlocking('hub-1');
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux', detail: { nonce: 'n1' } });
      const late = deliveredBlocking('hub-2');
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer', attemptNonce: 'n1' });
      assert.equal(store.medusaExchanges.get(early.exchange_id).state, 'wake_not_accepted');
      assert.equal(store.medusaExchanges.get(late.exchange_id).state, 'delivered', 'mail after the nudge did not miss it');
    });
  });

  describe('the wake monitor honours a re-arm, through every gate', () => {
    const saved = {};
    const SEAMS = ['listLiveAll', 'getProject', 'loadProjectConfig', 'wrapRunning', 'getStatus', 'getMessages',
      'capturePane', 'cursorInfo', 'injectCommand', 'injectMaster', 'recordDelivery', 'masterWakeRecord', 'verifySubmission'];
    let world;

    beforeEach(() => {
      for (const k of SEAMS) saved[k] = wake._internal[k];
      world = {
        pane: IDLE_PANE,
        injected: [],
        status: { state: 'listening', workspaceId: 'builder-ws', unread: 1, lastError: null },
        inbox: [{ id: 'hub-1', from: 'pm-ws', message: 'rule on X' }],
        receipt: { outcome: 'unknown', reason: 'test' }
      };
      wake._internal.listLiveAll = () => [{ id: 2, projectId: 20, sessionMode: 'tmux', tmuxSession: 'tc-2', engineId: 'claude' }];
      wake._internal.getProject = () => ({ id: 20, name: 'builder', path: '/tmp/builder' });
      wake._internal.loadProjectConfig = () => ({ medusaWake: true });
      wake._internal.wrapRunning = () => false;
      wake._internal.getStatus = () => world.status;
      wake._internal.getMessages = () => world.inbox;
      wake._internal.capturePane = () => ({ lines: world.pane });
      wake._internal.cursorInfo = () => null;
      wake._internal.injectCommand = (name, command) => { world.injected.push(command); return { ok: true, error: null }; };
      wake._internal.injectMaster = () => ({ ok: true, error: null });
      wake._internal.recordDelivery = () => {};
      wake._internal.masterWakeRecord = () => null;
      wake._internal.verifySubmission = async () => world.receipt;
    });

    afterEach(() => {
      wake.stop();
      for (const k of SEAMS) wake._internal[k] = saved[k];
    });

    /** Tick the monitor through its idle debounce. */
    const tickIdle = () => { for (let i = 0; i < wake.IDLE_TICKS_REQUIRED; i++) wake._internal.tick(); };

    it('nudges once with its nonce; watches the owned edge without injecting; re-nudges only after a recorded readiness change', async () => {
      const x = deliveredBlocking();
      tickIdle();
      assert.equal(world.injected.length, 1);
      assert.match(world.injected[0], /\(wake ref [0-9a-f]{12}\)$/, 'the nudge carries its nonce');
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_attempted');

      tickIdle();
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0, 'idle all along after the nudge is no readiness change');
      assert.equal(world.injected.length, 1);

      world.pane = BUSY_PANE;
      tickIdle();
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'pane-turn-in-flight', 'the ineligible verdict is recorded');
      assert.equal(world.injected.length, 1, 'observing never injects');

      world.pane = IDLE_PANE;
      tickIdle();
      tickIdle();
      assert.ok(store.medusaExchanges.facts(x.exchange_id).some((f) => f.fact === 'readiness_changed'), 'eligible again is recorded');
      assert.equal(world.injected.length, 1, 'recording readiness is not a nudge');

      assert.equal(watchdog.tick(T0 + 31 * MIN).rearmed, 1);
      world.pane = BUSY_PANE;
      tickIdle();
      assert.equal(world.injected.length, 1, 'a re-armed wake still waits for a ready pane');
      world.pane = IDLE_PANE;
      tickIdle();
      tickIdle();
      assert.equal(world.injected.length, 2, 'the re-armed wake goes out once the pane is ready');
      assert.notEqual(world.injected[0], world.injected[1], 'each attempt has its own nonce');
    });

    it('a restarted monitor does not nudge again for mail the durable record shows already attempted', () => {
      const x = deliveredBlocking();
      tickIdle();
      assert.equal(world.injected.length, 1);
      wake.stop(); // a restart: the in-memory watermark is gone
      tickIdle();
      tickIdle();
      assert.equal(world.injected.length, 1, 'no wake outside the re-arm budget');
      assert.equal(store.medusaExchanges.get(x.exchange_id).rearm_count, 0);

      // Mail the record does not account for (an untracked arrival) is still a fresh edge.
      world.inbox = [...world.inbox, { id: 'hub-remote', from: 'remote-ws', message: 'hi' }];
      world.status = { ...world.status, unread: 2 };
      tickIdle();
      assert.equal(world.injected.length, 2, 'unaccounted mail is still nudged');
    });

    it('records a pane capture failure on an owned edge as ineligible, without a ledger row or an injection', () => {
      const x = deliveredBlocking();
      tickIdle();
      const origCapture = wake._internal.capturePane;
      wake._internal.capturePane = () => { throw new Error('no pane'); };
      try {
        wake._internal.tick();
      } finally {
        wake._internal.capturePane = origCapture;
      }
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'pane-capture-failed');
      assert.equal(world.injected.length, 1);
    });

    it('records a listener reconnect after the nudge as the ineligible half of a readiness change', () => {
      const x = deliveredBlocking();
      tickIdle();
      world.status = { ...world.status, state: 'connecting' };
      wake._internal.tick();
      world.status = { ...world.status, state: 'listening' };
      tickIdle();
      tickIdle();
      const facts = store.medusaExchanges.facts(x.exchange_id);
      const change = facts.find((f) => f.fact === 'readiness_changed');
      assert.ok(change, 'the reconnect, then an eligible pane, is a readiness change');
      assert.equal(JSON.parse(change.detail_json).from, 'listener-connecting');
    });

    it('records a not-accepted receipt when the nonce is still in the composer', async () => {
      const x = deliveredBlocking();
      world.receipt = { outcome: 'not-accepted', reason: 'nonce still in the composer' };
      tickIdle();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_not_accepted');
      assert.equal(watchdog.tick(T0).rearmed, 1, 'a proven miss re-arms at once');
    });

    it('a reconnect after a settled nudge leaves the exchange awaiting read, not stuck on the old reason', () => {
      const x = deliveredBlocking();
      tickIdle();
      // Settle the attempt: a readiness change has already been recorded for it.
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-turn-in-flight' });
      mx.noteReadiness('builder-ws');
      world.status = { ...world.status, state: 'connecting' };
      wake._internal.tick();
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'listener-connecting');
      world.status = { ...world.status, state: 'listening' };
      wake._internal.tick();
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'wake_pending');
      assert.equal(row.wake_code, 'awaiting-read');
      assert.equal(world.injected.length, 1, 'the owned edge is not nudged again');
    });

    it('records wake_accepted from a positive-receipt transport, and only then', async () => {
      const x = deliveredBlocking();
      const native = {
        id: 'native', channel: 'tmux-inject', receipts: 'positive',
        deliver: (ctx, seams) => seams.injectCommand(ctx.project.name, ctx.line, {}),
        verify: async () => ({ outcome: 'accepted' })
      };
      const origFor = wake._internal.transportFor;
      wake._internal.transportFor = () => native;
      try {
        tickIdle();
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        wake._internal.transportFor = origFor;
      }
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_accepted');

      const y = deliveredBlocking('hub-2');
      world.inbox = [...world.inbox, { id: 'hub-2', from: 'pm-ws', message: 'second' }];
      world.status = { ...world.status, unread: 2 };
      world.receipt = { outcome: 'accepted' };
      tickIdle();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(store.medusaExchanges.get(y.exchange_id).state, 'wake_attempted', 'tmux never records accepted, whatever its check says');
    });

    it('records blocked verdicts once per change, not once per tick', () => {
      const x = deliveredBlocking();
      world.pane = BUSY_PANE;
      tickIdle();
      tickIdle();
      const blocked = store.medusaExchanges.facts(x.exchange_id).filter((f) => f.fact === 'wake_blocked');
      assert.equal(blocked.length, 1);
    });

    it('chooses the transport per session and keeps tmux negative-receipt-only', () => {
      assert.equal(transports.forSession({ isMaster: true }).id, 'master');
      assert.equal(transports.forSession({}).receipts, 'negative');
      assert.equal(transports.tmuxTransport.receipts === 'positive', false, 'tmux can never claim accepted');
    });
  });

  describe('observe-only on the engine gate (Codex)', () => {
    const { CX_CLIPPED_PANE } = require('./_wake-fixtures');
    const saved = {};
    let world;

    beforeEach(() => {
      Object.assign(saved, wake._internal);
      wake.stop();
      world = {
        injected: [],
        clock: 1000000,
        activity: { channel: 'present', state: 'idle', reasonCode: 'thread-idle' }
      };
      const session = { id: 2, projectId: 20, sessionMode: 'tmux', tmuxSession: 'tc-2', engineId: 'codex' };
      wake._internal.listLiveAll = () => [session];
      wake._internal.getProject = () => ({ id: 20, name: 'builder', path: '/tmp/builder' });
      wake._internal.loadProjectConfig = () => ({ medusaWake: true });
      wake._internal.wrapRunning = () => false;
      wake._internal.getStatus = () => ({ state: 'listening', workspaceId: 'builder-ws', unread: 1, lastError: null });
      wake._internal.getMessages = () => [{ id: 'hub-1', from: 'pm-ws', message: 'x' }];
      wake._internal.capturePane = () => ({ lines: CX_CLIPPED_PANE });
      wake._internal.cursorInfo = () => null;
      wake._internal.masterWakeRecord = () => null;
      wake._internal.recordDelivery = () => {};
      wake._internal.injectCommand = (name, command) => { world.injected.push(command); return { ok: true, error: null }; };
      wake._internal.verifySubmission = async () => ({ outcome: 'unknown', reason: 'test' });
      wake._internal.openChannel = () => ({ id: 7, sessionId: 2, sequenceId: 70, engineId: 'codex', adapter: 'codex', state: 'open', adapterState: { threadId: 't-1' } });
      wake._internal.launchSequence = () => ({ id: 70, sessionId: 2 });
      wake._internal.declaresObserver = (engineId) => engineId === 'codex';
      wake._internal.observeActivity = () => Promise.resolve(world.activity);
      wake._internal.now = () => world.clock;
    });

    afterEach(() => {
      wake.stop();
      Object.assign(wake._internal, saved);
    });

    /**
     * Tick, letting each observation land before the next.
     * @param {number} n - Tick count
     * @returns {Promise<void>}
     */
    const ticks = async (n) => {
      for (let i = 0; i < n; i++) {
        wake._internal.tick();
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    /**
     * Change what the engine answers, and age the cached answer out so the
     * next tick asks again.
     * @param {string} state - `idle` or `busy`
     * @returns {void}
     */
    const engineTurns = (state) => {
      world.activity = { channel: 'present', state, reasonCode: `thread-${state}` };
      world.clock += wake.ENGINE_ACTIVITY_MAX_AGE_MS + 1;
    };

    it('records the engine turning busy after the nudge, then idle, as a readiness change, typing nothing more', async () => {
      const x = deliveredBlocking();
      await ticks(1 + wake.IDLE_TICKS_REQUIRED);
      assert.equal(world.injected.length, 1, 'the first nudge');
      engineTurns('busy');
      await ticks(3);
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'engine-thread-busy', 'the engine gate verdict is recorded');
      engineTurns('idle');
      await ticks(2 + wake.IDLE_TICKS_REQUIRED);
      const change = store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'readiness_changed');
      assert.ok(change, 'engine busy then idle is a readiness change');
      // `from` is the newest ineligible verdict: while the engine is asked again
      // that is `engine-thread-unknown`, and the busy verdict is on record before it.
      assert.match(JSON.parse(change.detail_json).from, /^engine-thread-(busy|unknown)$/);
      assert.equal(world.injected.length, 1, 'observing never injects');
    });
  });
});
