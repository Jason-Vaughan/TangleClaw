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

  describe('re-arm budget', () => {
    it('re-arms an unconfirmed attempt only after its wait, once per tick however many ticks run', () => {
      const x = deliveredBlocking();
      attempt();
      assert.equal(watchdog.tick(T0 + 2 * MIN).rearmed, 0, 'not before rearmAfterMs');
      at(T0 + 3 * MIN);
      assert.equal(watchdog.tick(clock).rearmed, 1);
      assert.equal(watchdog.tick(clock).rearmed, 0, 'a duplicate tick re-arms nothing');
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.state, 'wake_pending');
      assert.equal(row.wake_code, 'rearmed');
      assert.equal(row.rearm_count, 1);
      assert.equal(row.next_eligible_at, new Date(T0 + 5 * MIN).toISOString());
      assert.equal(mx.rearmDue('builder-ws'), true);
    });

    it('re-arms a not-accepted attempt at once', () => {
      const x = deliveredBlocking();
      attempt();
      mx.recordWakeForRecipient('builder-ws', 'wake_not_accepted', { code: 'nonce-in-composer' });
      assert.equal(watchdog.tick(T0).rearmed, 1);
      assert.equal(store.medusaExchanges.facts(x.exchange_id).find((f) => f.fact === 'rearmed').code, 'not-accepted');
    });

    it('walks the backoff and stops at the cap, from the durable record alone', () => {
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { rearmAfterMs: 30 * 1000 } });
      const x = deliveredBlocking();
      attempt();
      at(T0 + MIN);
      assert.equal(watchdog.tick(clock).rearmed, 1, 're-arm 1');

      // The monitor retries at once; the next re-arm waits out the 2-minute step.
      attempt();
      assert.equal(watchdog.tick(T0 + 2 * MIN).rearmed, 0, 'inside the first backoff step');
      at(T0 + 3 * MIN);
      assert.equal(watchdog.tick(clock).rearmed, 1, 're-arm 2 once the step has passed');

      attempt();
      assert.equal(watchdog.tick(T0 + 6 * MIN).rearmed, 0, 'inside the 4-minute step');
      at(T0 + 7 * MIN);
      assert.equal(watchdog.tick(clock).rearmed, 1, 're-arm 3');

      attempt();
      assert.equal(watchdog.tick(T0 + 60 * MIN).rearmed, 0, 'the budget is spent');
      const row = store.medusaExchanges.get(x.exchange_id);
      assert.equal(row.rearm_count, 3);
      assert.equal(row.state, 'wake_attempted');
    });

    it('never re-arms mail that has been read, or when the watchdog is disabled', () => {
      deliveredBlocking();
      attempt();
      mx.recordRead(['hub-1'], 'builder-ws', { kind: 'project', projectId: 20 });
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);

      deliveredBlocking('hub-2');
      mx.recordWakeForRecipient('builder-ws', 'wake_attempted', { code: 'tmux' });
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { enabled: false } });
      assert.equal(watchdog.tick(T0 + 30 * MIN).rearmed, 0);
    });

    it('does not let a later blocked verdict erase a pending re-arm', () => {
      const x = deliveredBlocking();
      attempt();
      watchdog.tick(T0 + 3 * MIN);
      mx.recordWakeForRecipient('builder-ws', 'wake_blocked', { code: 'pane-turn-in-flight' });
      assert.equal(store.medusaExchanges.get(x.exchange_id).wake_code, 'rearmed');
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

    it('nudges once with a per-attempt nonce, and a re-arm brings one more nudge only when the pane is ready', async () => {
      const x = deliveredBlocking();
      tickIdle();
      assert.equal(world.injected.length, 1);
      assert.match(world.injected[0], /\(wake ref [0-9a-f]{12}\)$/, 'the nudge carries its nonce');
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_attempted');
      tickIdle();
      assert.equal(world.injected.length, 1, 'an owned edge is not nudged again');

      watchdog.tick(T0 + 3 * MIN);
      world.pane = BUSY_PANE;
      tickIdle();
      assert.equal(world.injected.length, 1, 'a re-armed wake still waits for a ready pane');

      world.pane = IDLE_PANE;
      tickIdle();
      tickIdle();
      assert.equal(world.injected.length, 2, 'the re-armed wake goes out once the pane is ready');
      assert.notEqual(world.injected[0], world.injected[1], 'each attempt has its own nonce');
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_attempted');
    });

    it('records a not-accepted receipt when the nonce is still in the composer', async () => {
      const x = deliveredBlocking();
      world.receipt = { outcome: 'not-accepted', reason: 'nonce still in the composer' };
      tickIdle();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(store.medusaExchanges.get(x.exchange_id).state, 'wake_not_accepted');
      assert.equal(watchdog.tick(T0).rearmed, 1, 'a proven miss re-arms at once');
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
});
