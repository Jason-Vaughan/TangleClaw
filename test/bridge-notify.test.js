'use strict';

// #2031, #2262 (ADR 0023 Decisions 8 and 9): the typed server notifications.
// Each is found from the record that is the event, enqueued once under a key
// that names that record, written from a fixed template, and only for events
// that happened while the bridge was enabled. Fleet-idle fails closed.
// #2272: the helper's own connection to Discord, from its report: one notice
// for an outage once it has lasted five minutes, and one when it is over.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeNotify = require('../lib/bridge-notify');
const bridgeSchema = require('../lib/bridge-schema');
const workloadNudge = require('../lib/workload-nudge');
const exchanges = require('../lib/medusa-exchanges');
const { bindProject } = require('./_shared-docs-callers');

let tmpDir;
let clock;
let lanes;
let realDeps;
let n = 0;

/**
 * Advance the stand-in clock.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function later(ms) {
  clock = new Date(Date.parse(clock) + ms).toISOString();
}

/**
 * A project with a live, launch-bound session.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, launchId: string}}
 */
function liveSession(name) {
  const project = store.projects.create({ name, path: path.join(tmpDir, `p${++n}`) });
  return { project, ...bindProject(project) };
}

/**
 * The session reports its workload at the current clock.
 * @param {object} session - The session.
 * @param {string} state - Workload state.
 * @returns {number} The receipt's sequence.
 */
function reports(session, state) {
  later(2000);
  return store.workloadReceipts.append({
    project_id: session.project.id, session_id: session.sessionId, launch_id: session.launchId, assignment_id: null,
    state, clearance: state === 'complete' ? 'safe-to-clear' : 'do-not-clear', summary: `work is ${state}`,
    wait_kind: null, wait_detail: null, refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null,
    source: 'tc-cli', received_at: clock
  }, { minIntervalMs: 0, nowMs: Date.parse(clock) }).row.seq;
}

/**
 * The operator enables the bridge at the current clock.
 * @returns {void}
 */
function enable() {
  bridgeStore.settings.set('enabled', 'true');
  bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
}

/**
 * Notifications waiting for the helper.
 * @returns {{type: string, key: string, text: string}[]}
 */
function notifications() {
  return store.getDb().prepare("SELECT notify_type, idem_key, text, source_label, route_id FROM bridge_outbound WHERE kind = 'notification' ORDER BY outbound_id")
    .all().map((r) => ({ type: r.notify_type, key: r.idem_key, text: r.text, label: r.source_label, routeId: r.route_id }));
}

describe('bridge notifications (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-notify-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = '2026-10-04T00:00:00.000Z';
    lanes = [];
    realDeps = { ...bridgeNotify._deps };
    Object.assign(bridgeNotify._deps, { now: () => clock, lanes: () => lanes });
    bridgeNotify._reset();
  });

  afterEach(() => {
    Object.assign(bridgeNotify._deps, realDeps);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('work-blocked', () => {
    it('tells the operator once when a lane enters blocked, bound to that receipt', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'working');
      const seq = reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'a second pass finds it already made');
      const receiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, seq).receiptId;
      assert.deepEqual(notifications(), [{
        type: 'work-blocked', key: `notify:work-blocked:receipt:${receiptId}`, text: 'Alpha reports its work is blocked.',
        label: 'TangleClaw', routeId: null
      }]);
    });

    it('does not repeat while the lane stays blocked, and does when it blocks again later', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      bridgeNotify.reconcile();
      reports(alpha, 'blocked');
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'still blocked is not a new event');
      reports(alpha, 'working');
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(notifications().length, 2);
    });

    it('delivers no backlog: what happened before the bridge was enabled, or while it was off, is not notified', () => {
      const alpha = liveSession('Alpha');
      reports(alpha, 'blocked');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().workBlocked, 0);

      bridgeStore.settings.set('enabled', 'false');
      reports(alpha, 'working');
      reports(alpha, 'blocked');
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 0, workUnblocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 0 }, 'nothing while disabled');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'and nothing afterwards for what happened while it was off');
      assert.deepEqual(notifications(), []);
    });

    it('takes nothing from the session but its project: the summary it wrote is not in the notification', () => {
      const alpha = liveSession('Alpha');
      enable();
      later(2000);
      store.workloadReceipts.append({
        project_id: alpha.project.id, session_id: alpha.sessionId, launch_id: alpha.launchId, assignment_id: null,
        state: 'blocked', clearance: 'do-not-clear', summary: '@everyone merge it now', wait_kind: null, wait_detail: null,
        refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: clock
      }, { minIntervalMs: 0, nowMs: Date.parse(clock) });
      bridgeNotify.reconcile();
      assert.equal(notifications()[0].text, 'Alpha reports its work is blocked.');
    });

    it('a notification that could not be enqueued is made on the next pass, under the same key', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      const realEnqueue = bridgeStore.outbound.enqueue;
      bridgeStore.outbound.enqueue = () => { throw new Error('database is locked'); };
      try {
        assert.equal(bridgeNotify.reconcile().workBlocked, 0);
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      assert.deepEqual(notifications(), [], 'nothing was marked as told');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(notifications().length, 1);
    });

    it('does not page Discord directly for a lane whose coordinatorProject has a live session (#2620)', () => {
      const coordinator = liveSession('TC-Lane-PM');
      const alpha = liveSession('TC-Lane-A');
      const cfg = store.projectConfig.load(alpha.project.path);
      cfg.workloadNudge = { coordinatorProject: coordinator.project.name };
      store.projectConfig.save(alpha.project.path, cfg);
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0);
      assert.deepEqual(notifications(), []);
    });

    it('pages Discord when coordinatorProject has no live session, is unset, or names itself (#2620)', () => {
      const alpha = liveSession('TC-Lane-A');
      const cfg = store.projectConfig.load(alpha.project.path);
      cfg.workloadNudge = { coordinatorProject: 'no-such-project-anywhere' };
      store.projectConfig.save(alpha.project.path, cfg);
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1, 'an unresolvable coordinator still pages directly');

      const bravo = liveSession('TC-Lane-B');
      reports(bravo, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1, 'no coordinatorProject configured still pages directly');

      const charlie = liveSession('TC-Lane-C');
      const selfCfg = store.projectConfig.load(charlie.project.path);
      selfCfg.workloadNudge = { coordinatorProject: 'TC-Lane-C' };
      store.projectConfig.save(charlie.project.path, selfCfg);
      reports(charlie, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1, 'naming itself as coordinator still pages directly');
    });

    it('does not page Discord for an opted-out project, even while blocked (#2620)', () => {
      const alpha = liveSession('Alpha');
      bridgeStore.optouts.set(alpha.project.id);
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0);
      assert.deepEqual(notifications(), []);
    });
  });

  describe('work-unblocked (#2141)', () => {
    it('tells the operator once when an announced block clears, bound to the clearing receipt', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'working');
      const blockedSeq = reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      const clearSeq = reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 1);
      assert.equal(bridgeNotify.reconcile().workUnblocked, 0, 'a second pass finds it already made');
      const blockedReceiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, blockedSeq).receiptId;
      const clearReceiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, clearSeq).receiptId;
      const rows = notifications();
      assert.deepEqual(rows.map((r) => r.type), ['work-blocked', 'work-blocked'],
        'Architect Ruling A475-W1A-R1: work-unblocked rides under the work-blocked notify_type');
      assert.deepEqual(rows.map((r) => r.key), [
        `notify:work-blocked:receipt:${blockedReceiptId}`, `notify:work-unblocked:receipt:${clearReceiptId}`
      ], 'the idem_key still tells the two apart');
      assert.equal(rows[1].text, 'Alpha reports its work is no longer blocked.');
    });

    it('clears to any non-blocked state: complete and waiting-external both count', () => {
      for (const clearTo of ['complete', 'waiting-external']) {
        const alpha = liveSession(`Alpha-${clearTo}`);
        enable();
        reports(alpha, 'blocked');
        bridgeNotify.reconcile();
        reports(alpha, clearTo);
        assert.equal(bridgeNotify.reconcile().workUnblocked, 1, clearTo);
      }
    });

    it('is not announced when the block it would clear was never announced (opted-out project)', () => {
      const alpha = liveSession('Alpha');
      bridgeStore.optouts.set(alpha.project.id);
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'precondition: the block itself was not announced');
      reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 0);
      assert.deepEqual(notifications(), []);
    });

    it('is not announced when the block it would clear was never announced (a live coordinator managed it)', () => {
      const coordinator = liveSession('TC-Lane-PM');
      const alpha = liveSession('TC-Lane-A');
      const cfg = store.projectConfig.load(alpha.project.path);
      cfg.workloadNudge = { coordinatorProject: coordinator.project.name };
      store.projectConfig.save(alpha.project.path, cfg);
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'precondition: the block itself was not announced');
      reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 0);
      assert.deepEqual(notifications(), []);
    });

    it('does not repeat while the lane stays clear, and announces again for a later block that clears', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      bridgeNotify.reconcile();
      reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 1);
      reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 0, 'already clear is not a new event');
      reports(alpha, 'blocked');
      bridgeNotify.reconcile();
      reports(alpha, 'complete');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 1, 'a later block clearing is its own event');
    });

    it('clears an episode whose announced receipt is not the immediate predecessor: blocked, blocked again, then working (PR #2629 review C1/C2)', () => {
      const alpha = liveSession('Alpha');
      enable();
      const firstBlockedSeq = reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1, 'the first blocked receipt of the run is announced');
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'a repeat blocked report is not a new event, and is never announced itself');
      const clearSeq = reports(alpha, 'working');
      assert.equal(bridgeNotify.reconcile().workUnblocked, 1, 'clearing still finds the run\'s announced receipt, not the unannounced repeat');
      const firstBlockedReceiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, firstBlockedSeq).receiptId;
      const clearReceiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, clearSeq).receiptId;
      assert.deepEqual(notifications().map((r) => r.key), [
        `notify:work-blocked:receipt:${firstBlockedReceiptId}`, `notify:work-unblocked:receipt:${clearReceiptId}`
      ]);
    });

    it('never announces a recovery that is already stale by the time the pass runs: blocked, working, blocked again, all before one reconcile (PR #2629 review C1)', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      reports(alpha, 'working');
      const reblockSeq = reports(alpha, 'blocked');
      const result = bridgeNotify.reconcile();
      assert.deepEqual({ workBlocked: result.workBlocked, workUnblocked: result.workUnblocked }, { workBlocked: 1, workUnblocked: 0 },
        'the lane is blocked again by the time this pass runs, so the recovery in between is not announced -- it would read as "all clear" while the lane is blocked');
      const reblockReceiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, reblockSeq).receiptId;
      assert.deepEqual(notifications().map((r) => r.key).slice(-1), [`notify:work-blocked:receipt:${reblockReceiptId}`]);
    });
  });

  describe('operator-needed', () => {
    /**
     * An exchange between two workspaces, then raised to the operator rung as the watchdog does.
     * @param {object} recipient - The recipient session.
     * @param {object} [opts] - `senderProjectId`, `senderWorkspaceId` and `priority` to vary the exchange (#2141).
     * @returns {string} The exchange id.
     */
    function alertedExchange(recipient, opts = {}) {
      const row = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta(
          { to: 'ws-recipient', message: 'x', requestId: `req-ex-${++n}-0000`, priority: opts.priority },
          { kind: 'system' }, null, {}
        ),
        sender: {
          projectId: Object.prototype.hasOwnProperty.call(opts, 'senderProjectId') ? opts.senderProjectId : null,
          sessionId: 'someone',
          workspaceId: Object.prototype.hasOwnProperty.call(opts, 'senderWorkspaceId') ? opts.senderWorkspaceId : 'ws-sender'
        },
        recipient: { workspaceId: 'ws-recipient', projectId: recipient.project.id, sessionId: recipient.sessionId },
        tracking: 'tracked'
      });
      exchanges.recordEscalationFact(row.exchange_id, 'operator_alerted', { code: 'unanswered', at: clock });
      return row.exchange_id;
    }

    it('tells the operator once per exchange the watchdog raised to its operator rung, with sender/priority/age/exchange id (#2141)', () => {
      const alpha = liveSession('Alpha');
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        later(1000);
        const exchangeId = alertedExchange(alpha);
        later(5 * 60000);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 0);
        assert.deepEqual(notifications(), [{
          type: 'operator-needed', key: `notify:operator-needed:exchange:${exchangeId}`,
          text: `A normal message from ws-sender to Alpha was read and has gone unanswered long enough to need you. It was sent 5 minutes ago. (exchange ${exchangeId})`,
          label: 'TangleClaw', routeId: null
        }]);
        // Each reason the watchdog gives has its own fixed sentence, and none says more than is known.
        const said = (code) => bridgeNotify.TEMPLATES['operator-needed']({ project: 'Alpha', why: code, sender: 'Bravo', priority: 'normal', age: null, exchangeId: 'ex1' });
        assert.equal(said('unread'), 'A normal message from Bravo to Alpha has gone unread long enough to need you. (exchange ex1)');
        assert.equal(said('prolonged-unread'), said('unread'));
        assert.equal(said('prolonged-unanswered'), said('unanswered'));
        assert.match(said('blocking-unread'), /is blocking its sender and has gone unread/);
        assert.match(said('critical-unread'), /is critical and has gone unread/);
        assert.match(said('configuration-hold'), /cannot be delivered until its recipient.s setup is put right/);
        assert.match(said('engine-thread-unknown-stalled'), /is stalled: its recipient.s engine cannot be identified/);
        assert.match(said('prolonged-actionable'), /has waited long enough on a recipient that should have taken it/);
        assert.match(said('no-escalation-route'), /has nobody else it can be escalated to/);
        for (const unknown of ['something-new', undefined, null, '__proto__', 'constructor']) {
          assert.equal(said(unknown), 'A normal message from Bravo to Alpha needs you. (exchange ex1)', `${unknown}: a reason with no sentence of its own says only that`);
        }
        for (const code of ['unread', 'prolonged-unread', 'blocking-unread', 'critical-unread', 'configuration-hold', 'engine-thread-unknown-stalled', 'no-escalation-route', 'prolonged-actionable']) {
          assert.ok(!/unanswered/.test(said(code)), `${code} is not called unanswered`);
        }
        assert.equal(
          bridgeNotify.TEMPLATES['operator-needed']({ project: 'Alpha', why: 'unread', sender: 'Bravo', priority: 'blocking', age: '5 minutes', exchangeId: 'ex1' }),
          'A blocking message from Bravo to Alpha has gone unread long enough to need you. It was sent 5 minutes ago. (exchange ex1)'
        );
      } finally {
        exchanges._internal.now = realNow;
      }
    });

    it('resolves the sender to its project name, else its raw workspace id, else says the sender is unknown (#2141)', () => {
      const alpha = liveSession('Alpha');
      const bravo = liveSession('Bravo');
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        alertedExchange(alpha, { senderProjectId: bravo.project.id, senderWorkspaceId: 'ws-bravo' });
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.match(notifications()[0].text, /^A normal message from Bravo to Alpha /);

        alertedExchange(alpha, { senderProjectId: null, senderWorkspaceId: 'ws-unregistered' });
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.match(notifications()[1].text, /^A normal message from ws-unregistered to Alpha /);

        alertedExchange(alpha, { senderProjectId: null, senderWorkspaceId: null });
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.match(notifications()[2].text, /^A normal message from an unknown sender to Alpha /);

        // createSendIntent does not validate sender.workspaceId against WORKSPACE_ID_RE
        // (only the recipient's is checked), so this module cleans it itself before
        // it reaches Discord, the same as a project name.
        alertedExchange(alpha, { senderProjectId: null, senderWorkspaceId: 'Evil\u202Eabc' });
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.ok(!notifications()[3].text.includes('\u202E'));
        assert.match(notifications()[3].text, /^A normal message from Evilabc to Alpha /);
      } finally {
        exchanges._internal.now = realNow;
      }
    });

    it('does not page Discord directly for a recipient whose coordinatorProject has a live session (#2141, mirrors #2620)', () => {
      const coordinator = liveSession('TC-Lane-PM');
      const alpha = liveSession('TC-Lane-A');
      const cfg = store.projectConfig.load(alpha.project.path);
      cfg.workloadNudge = { coordinatorProject: coordinator.project.name };
      store.projectConfig.save(alpha.project.path, cfg);
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        alertedExchange(alpha);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 0);
        assert.deepEqual(notifications(), []);
      } finally {
        exchanges._internal.now = realNow;
      }
    });

    it('pages Discord when coordinatorProject has no live session, is unset, or names itself (#2141, mirrors #2620)', () => {
      const alpha = liveSession('TC-Lane-A');
      const cfg = store.projectConfig.load(alpha.project.path);
      cfg.workloadNudge = { coordinatorProject: 'no-such-project-anywhere' };
      store.projectConfig.save(alpha.project.path, cfg);
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        alertedExchange(alpha);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1, 'an unresolvable coordinator still pages directly');

        const bravo = liveSession('TC-Lane-B');
        alertedExchange(bravo);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1, 'no coordinatorProject configured still pages directly');

        const charlie = liveSession('TC-Lane-C');
        const selfCfg = store.projectConfig.load(charlie.project.path);
        selfCfg.workloadNudge = { coordinatorProject: 'TC-Lane-C' };
        store.projectConfig.save(charlie.project.path, selfCfg);
        alertedExchange(charlie);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1, 'naming itself as coordinator still pages directly');
      } finally {
        exchanges._internal.now = realNow;
      }
    });

    it('does not page Discord for an opted-out recipient, even when the watchdog raised the exchange (PR #2629 review C2)', () => {
      const alpha = liveSession('Alpha');
      bridgeStore.optouts.set(alpha.project.id);
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        alertedExchange(alpha);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 0);
        assert.deepEqual(notifications(), []);
      } finally {
        exchanges._internal.now = realNow;
      }
    });
  });

  describe('fleet-idle', () => {
    const idle = (sessionId, launchId, receiptSeq) => ({ sessionId, launchId, receiptSeq, availability: 'AVAILABLE' });
    const busy = (sessionId, launchId) => ({ sessionId, launchId, receiptSeq: 1, availability: 'WORKING' });

    it('tells the operator once when the fleet is seen to become idle, and not again while it stays so', () => {
      enable();
      lanes = [idle(1, 'launch-a', 4), busy(2, 'launch-b')];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      lanes = [idle(1, 'launch-a', 4), idle(2, 'launch-b', 7)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(notifications()[0].text, 'Every live session has finished its work and is clear (2 lanes). The fleet is waiting for work.');

      // A lane that stays finished and reports again is the same episode.
      lanes = [idle(1, 'launch-a', 5), idle(2, 'launch-b', 8)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'a renewed receipt is not a new idle spell');
      assert.equal(notifications().length, 1);
    });

    it('a new episode begins when the fleet stops being idle and becomes idle again, or its members change', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);

      // It works, then finishes at the very same receipt set it had before.
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      later(60000);
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1, 'the same lanes idle again is a new spell, not the old one');

      // A session joins, already finished: the members changed.
      later(60000);
      lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 1)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.match(notifications()[2].text, /\(2 lanes\)/);
      assert.equal(new Set(notifications().map((x) => x.key)).size, 3);
    });

    const unseen = (sessionId, launchId, receiptSeq) => ({ sessionId, launchId, receiptSeq, availability: 'COMPLETE_NOT_CLEAR' });

    it('does not announce a fleet that was already idle when the bridge was enabled', () => {
      lanes = [idle(1, 'launch-a', 4)];
      enable();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'idle before it was enabled is not news');
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);

      // Disabled and enabled again, still idle throughout.
      bridgeStore.settings.set('enabled', 'false');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.deepEqual(notifications(), []);

      // What happens after that is news.
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 6)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
    });

    it('does not announce an idle fleet again after a server restart, while the engines are not yet observed at rest', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);

      // The server restarts. For its first passes the activity observer has
      // not yet seen any pane at rest, so a finished lane reads not-clear.
      bridgeNotify._reset();
      lanes = [unseen(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      // Then it is observed at rest: the same spell, not a new one.
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'found idle on the first reading that says anything: not announced');
      assert.equal(notifications().length, 1);
      assert.deepEqual(bridgeNotify.episode(), { open: true, resumed: true }, 'the episode its notice recorded, resumed');
      // A resumed episode ends like any other, and is then no longer anything resumed.
      lanes = [busy(1, 'launch-a')];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.deepEqual(bridgeNotify.episode(), { open: false, resumed: false });

      // A different fleet found idle after a start is taken as it is too, but it is not that episode.
      bridgeNotify._reset();
      lanes = [idle(7, 'launch-z', 1)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.deepEqual(bridgeNotify.episode(), { open: true, resumed: false });
    });

    it('a reading that lapses and comes back is the same episode, not a new one', () => {
      enable();
      lanes = [busy(1, 'launch-a'), busy(2, 'launch-b')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 3)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      for (const lapse of [
        [unseen(1, 'launch-a', 2), idle(2, 'launch-b', 3)],
        [{ sessionId: 1, launchId: 'launch-a', receiptSeq: null, availability: 'UNKNOWN' }, idle(2, 'launch-b', 3)],
        null
      ]) {
        lanes = lapse;
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
        lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 3)];
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'not knowing is not evidence that anything changed');
      }
      assert.equal(notifications().length, 1);
    });

    it('not knowing never begins an episode, and evidence of work always ends one', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [unseen(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'finished but not seen at rest is not idle');
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      for (const state of ['WORKING', 'WAITING', 'BLOCKED', 'HELD', 'STOPPED']) {
        later(60000);
        lanes = [{ sessionId: 1, launchId: 'launch-a', receiptSeq: 2, availability: state }];
        bridgeNotify.reconcile();
        lanes = [idle(1, 'launch-a', 2)];
        assert.equal(bridgeNotify.reconcile().fleetIdle, 1, `${state} ended the episode`);
      }
      // An empty fleet ends it too.
      later(60000);
      lanes = [];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
    });

    it('an idle notice that could not be enqueued is made on the next pass, under the same key', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      const realEnqueue = bridgeStore.outbound.enqueue;
      const tried = [];
      bridgeStore.outbound.enqueue = (item) => { tried.push(item.idemKey); throw new Error('database is locked'); };
      try {
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
        later(15000);
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      later(15000);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(notifications().length, 1);
      assert.deepEqual([...new Set(tried)], [notifications()[0].key], 'every attempt used the one key');
    });

    it('fails closed: an empty fleet, or any lane that is not known to be finished and clear, is not idle', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      const cases = {
        'no live lanes': [],
        'a working lane': [idle(1, 'a', 1), busy(2, 'b')],
        'a waiting lane': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'WAITING' }],
        'a blocked lane': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'BLOCKED' }],
        'complete but not clear': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'COMPLETE_NOT_CLEAR' }],
        'an unknown or stale lane': [idle(1, 'a', 1), { sessionId: 2, launchId: 'b', receiptSeq: 3, availability: 'UNKNOWN' }],
        'a lane with no receipt': [{ sessionId: 1, launchId: 'a', receiptSeq: null, availability: 'AVAILABLE' }],
        'a lane with no known launch': [{ sessionId: 1, launchId: null, receiptSeq: 2, availability: 'AVAILABLE' }],
        'a reader that answers nothing': null
      };
      for (const [what, value] of Object.entries(cases)) {
        lanes = value;
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0, what);
      }
      assert.deepEqual(notifications(), []);
    });

    it('one kind failing does not stop the others', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      bridgeNotify._deps.lanes = () => { throw new Error('the lane reader failed'); };
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 1, workUnblocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 0 });
    });

    it('reads lanes through the fleet\'s own composition: only a fresh, finished, clear lane at rest is AVAILABLE', () => {
      const workloadFleet = require('../lib/workload-fleet');
      const atRest = { get: () => ({ activity: 'at-rest' }) };
      const unobserved = { get: () => ({ activity: 'unknown' }) };
      const compose = (observer) => (session, projectName) => workloadFleet.laneFor(session, {
        observer, projectName, nowMs: Date.parse(clock), wrap: { wrapRun: () => null }
      });
      const done = liveSession('Done');
      const seq = reports(done, 'complete');
      const working = liveSession('Working');
      reports(working, 'working');
      const silent = liveSession('Silent');

      const read = bridgeNotify.readLanes(compose(atRest));
      const of = (s) => read.find((l) => l.sessionId === s.sessionId);
      assert.deepEqual(of(done), { sessionId: done.sessionId, launchId: done.launchId, receiptSeq: seq, availability: 'AVAILABLE' });
      assert.equal(of(working).availability, 'WORKING');
      assert.deepEqual([of(silent).availability, of(silent).receiptSeq], ['UNKNOWN', null], 'a lane that never reported is unknown');
      // The same finished lane with an engine nobody has observed at rest is not clear.
      assert.equal(bridgeNotify.readLanes(compose(unobserved)).find((l) => l.sessionId === done.sessionId).availability, 'COMPLETE_NOT_CLEAR');
    });

    it('a lane is not AVAILABLE on an expired receipt, a receipt from an earlier launch, a busy engine or a session with no launch', () => {
      const workloadFleet = require('../lib/workload-fleet');
      const observer = (activity) => ({ get: () => ({ activity }) });
      const compose = (activity) => (session, projectName) => workloadFleet.laneFor(session, {
        observer: observer(activity), projectName, nowMs: Date.parse(clock), wrap: { wrapRun: () => null }
      });
      const read = (activity, s) => bridgeNotify.readLanes(compose(activity)).find((l) => l.sessionId === s.sessionId);
      const current = liveSession('Current');
      const seq = reports(current, 'complete');
      const relaunched = liveSession('Relaunched');
      reports(relaunched, 'complete');
      const unlaunched = liveSession('Unlaunched');
      reports(unlaunched, 'complete');
      assert.equal(read('at-rest', relaunched).availability, 'AVAILABLE', 'precondition: each would be clear as it stands');
      assert.equal(read('at-rest', unlaunched).availability, 'AVAILABLE');

      // The session was launched again: what the earlier launch reported is not this one's.
      store.getDb().prepare('UPDATE launch_sequences SET launch_id = ? WHERE session_id = ?').run('a-newer-launch', relaunched.sessionId);
      assert.deepEqual(read('at-rest', relaunched), { sessionId: relaunched.sessionId, launchId: 'a-newer-launch', receiptSeq: null, availability: 'UNKNOWN' });
      // A session with no launch on record has nothing a receipt could be bound to.
      store.getDb().prepare('DELETE FROM launch_sequences WHERE session_id = ?').run(unlaunched.sessionId);
      assert.deepEqual(read('at-rest', unlaunched), { sessionId: unlaunched.sessionId, launchId: null, receiptSeq: null, availability: 'UNKNOWN' });
      // An engine seen working outranks a receipt that says finished.
      assert.deepEqual(read('busy', current), { sessionId: current.sessionId, launchId: current.launchId, receiptSeq: seq, availability: 'WORKING' });
      assert.equal(read('at-rest', current).availability, 'AVAILABLE');
      // A finished receipt is believed for two hours, and then it is not.
      later(120 * 60 * 1000 - 5000);
      assert.equal(read('at-rest', current).availability, 'AVAILABLE');
      later(10000);
      assert.deepEqual(read('at-rest', current), { sessionId: current.sessionId, launchId: current.launchId, receiptSeq: seq, availability: 'UNKNOWN' });

      // None of them makes the fleet idle.
      enable();
      bridgeNotify._deps.lanes = () => bridgeNotify.readLanes(compose('at-rest'));
      bridgeNotify.reconcile();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.deepEqual(notifications().filter((x) => x.type === 'fleet-idle'), []);
    });

    it('the server wires that reader in, so a real fleet is read without anything being supplied', () => {
      Object.assign(bridgeNotify._deps, { lanes: realDeps.lanes });
      const server = require('../server');
      assert.ok(server.createServer);
      const done = liveSession('Done');
      reports(done, 'complete');
      const read = bridgeNotify._deps.lanes();
      const lane = read.find((l) => l.sessionId === done.sessionId);
      assert.ok(lane, 'the wired reader returns this store\'s live lanes');
      assert.equal(lane.launchId, done.launchId);
      // The server's own observer has not seen this pane at rest, so the lane
      // is not clear and the fleet is not idle: the real path fails closed.
      assert.notEqual(lane.availability, 'AVAILABLE');
      enable();
      bridgeNotify.reconcile();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
    });
  });

  describe('lane-silent (#2262)', () => {
    /**
     * The nudge monitor records a fact about a session's expired report, at the current clock.
     * @param {object} session - The session.
     * @param {object} fields - `kind`, `route`, `code` and whatever else differs.
     * @param {number} [receiptId] - The expired receipt; a new one each call by default.
     * @returns {object} The stored row.
     */
    function records(session, fields, receiptId = 5000 + ++n) {
      later(1000);
      return store.workloadNudgeFacts.record({
        project_id: session.project.id, session_id: session.sessionId, launch_id: session.launchId, receipt_id: receiptId,
        engine_activity: 'at-rest', engine_reason: 'at-rest', detail_json: JSON.stringify({ receiptSeq: 3, silentSeconds: 2520 }),
        created_at: clock, ...fields
      }).row;
    }
    const onOperatorRoute = (code = 'no-coordinator') => ({ kind: 'escalated', route: 'operator', code });

    it('tells the operator once about a lane with nobody else to tell, bound to that fact', () => {
      const alpha = liveSession('Alpha');
      enable();
      const fact = records(alpha, onOperatorRoute());
      assert.equal(bridgeNotify.reconcile().laneSilent, 1);
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'a second pass finds it already made');
      assert.deepEqual(notifications(), [{
        type: 'lane-silent', key: `notify:lane-silent:nudge-fact:${fact.fact_id}`,
        text: 'Alpha has gone silent: its workload report expired and it had reported nothing for 42 minutes. Nobody else was told: it names no coordinator.',
        label: 'TangleClaw', routeId: null
      }]);
      assert.equal(bridgeNotify.laneSilentNotice(fact.fact_id), 'ready');
    });

    it('raises nothing for an escalation that reached a coordinator, or for the row saying one could not be reached', () => {
      const alpha = liveSession('Alpha');
      const coordinator = liveSession('Coordinator');
      enable();
      const told = records(alpha, { kind: 'escalated', route: 'coordinator', target_project_id: coordinator.project.id, code: 'escalated' });
      records(alpha, { kind: 'escalation-undeliverable', route: 'coordinator', target_project_id: coordinator.project.id, code: 'coordinator-no-live-session' });
      records(alpha, { kind: 'nudged', code: 'nudged' });
      records(alpha, { kind: 'not-nudged', route: 'operator', code: 'startup-dialog' });
      assert.equal(bridgeNotify.reconcile().laneSilent, 0);
      assert.deepEqual(notifications(), []);
      assert.equal(bridgeNotify.laneSilentNotice(told.fact_id), null);
    });

    it('delivers no backlog: a fact from before the bridge was enabled, while it was off, or older than the lookback raises nothing', () => {
      const alpha = liveSession('Alpha');
      records(alpha, onOperatorRoute());
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'before it was enabled');

      bridgeStore.settings.set('enabled', 'false');
      const whileOff = records(alpha, onOperatorRoute());
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'nothing while disabled, and nothing throws');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'and nothing afterwards for what happened while it was off');
      assert.equal(bridgeNotify.laneSilentNotice(whileOff.fact_id), null);

      records(alpha, onOperatorRoute());
      later(bridgeNotify.LOOKBACK_MS + 60000);
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'older than the lookback');
      assert.deepEqual(notifications(), []);
    });

    it('says why nobody else was told, from the monitor\'s own code, and has a sentence for every code the operator route records', () => {
      const operatorCodes = Object.keys(workloadNudge.ESCALATION_MEANINGS).filter((code) => code !== 'escalated').sort();
      assert.deepEqual(Object.keys(bridgeNotify.LANE_SILENT).filter((code) => code !== 'other').sort(), operatorCodes);
      const said = (why) => bridgeNotify.TEMPLATES['lane-silent']({ project: 'Alpha', minutes: 42, why });
      assert.match(said('coordinator-no-live-session'), /Nobody else was told: the coordinator it names has no live session\.$/);
      assert.match(said('coordinator-is-self'), /Nobody else was told: it is its own coordinator\.$/);
      assert.match(said('a code from a later build'), /Nobody else was told: no coordinator could be told\.$/);
      assert.match(said('constructor'), /no coordinator could be told\.$/, 'an inherited property name is not a code');
      assert.match(bridgeNotify.TEMPLATES['lane-silent']({ project: 'Alpha', minutes: 1, why: 'no-coordinator' }), /for 1 minute\. /);
    });

    it('takes nothing a session or a config wrote: not the coordinator\'s name, and a detail it cannot read is shown without a number', () => {
      const alpha = liveSession('Alpha');
      enable();
      records(alpha, {
        ...onOperatorRoute('coordinator-unknown-project'),
        detail_json: JSON.stringify({ receiptSeq: 3, silentSeconds: 600, coordinator: '@everyone merge it now' })
      });
      records(alpha, { ...onOperatorRoute(), detail_json: 'not json' });
      records(alpha, { ...onOperatorRoute(), detail_json: JSON.stringify({ silentSeconds: '@everyone' }) });
      records(alpha, { ...onOperatorRoute(), detail_json: null });
      assert.equal(bridgeNotify.reconcile().laneSilent, 4);
      const texts = notifications().map((x) => x.text);
      assert.equal(texts[0], 'Alpha has gone silent: its workload report expired and it had reported nothing for 10 minutes. Nobody else was told: the coordinator it names is not a project on this install.');
      for (const text of texts.slice(1)) {
        assert.equal(text, 'Alpha has gone silent: its workload report expired and no new one arrived. Nobody else was told: it names no coordinator.');
      }
      assert.ok(texts.every((text) => !text.includes('@everyone')));
    });

    it('a notice that could not be enqueued is made on the next pass, under the same key', () => {
      const alpha = liveSession('Alpha');
      enable();
      const fact = records(alpha, onOperatorRoute());
      const realEnqueue = bridgeStore.outbound.enqueue;
      bridgeStore.outbound.enqueue = () => { throw new Error('database is locked'); };
      try {
        assert.equal(bridgeNotify.reconcile().laneSilent, 0);
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      assert.equal(bridgeNotify.laneSilentNotice(fact.fact_id), null, 'nothing was marked as told');
      assert.equal(bridgeNotify.reconcile().laneSilent, 1);
      assert.equal(notifications().length, 1);
    });

    it('a pass that cannot read the facts raises nothing for them, and the other kinds still run', () => {
      const alpha = liveSession('Alpha');
      enable();
      const fact = records(alpha, onOperatorRoute());
      reports(alpha, 'blocked');
      const realList = store.workloadNudgeFacts.listOperatorEscalations;
      store.workloadNudgeFacts.listOperatorEscalations = () => { throw new Error('database is locked'); };
      try {
        assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 1, workUnblocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 0 });
      } finally {
        store.workloadNudgeFacts.listOperatorEscalations = realList;
      }
      assert.deepEqual(notifications().map((x) => x.type), ['work-blocked']);
      assert.equal(bridgeNotify.reconcile().laneSilent, 1, 'and the fact is found on the next pass');
      assert.equal(bridgeNotify.laneSilentNotice(fact.fact_id), 'ready');
    });

    it('reads every fact in the window, however many pages that is', () => {
      const alpha = liveSession('Alpha');
      enable();
      const realList = store.workloadNudgeFacts.listOperatorEscalations;
      const pages = [];
      store.workloadNudgeFacts.listOperatorEscalations = (query) => {
        pages.push(query.after ? query.after.factId : null);
        return realList.call(store.workloadNudgeFacts, { ...query, limit: 2 });
      };
      try {
        const facts = [1, 2, 3, 4, 5].map(() => records(alpha, onOperatorRoute()));
        assert.equal(bridgeNotify.reconcile().laneSilent, 5);
        assert.deepEqual(pages, [null, facts[1].fact_id, facts[3].fact_id]);
        assert.equal(notifications().length, 5);
        // The oldest are made already; the pass must still reach a new one behind them.
        records(alpha, onOperatorRoute());
        assert.equal(bridgeNotify.reconcile().laneSilent, 1);
      } finally {
        store.workloadNudgeFacts.listOperatorEscalations = realList;
      }
    });

    it('reports what became of a notice: delivered once the helper has it posted', () => {
      const alpha = liveSession('Alpha');
      enable();
      const fact = records(alpha, onOperatorRoute());
      bridgeNotify.reconcile();
      store.getDb().prepare("UPDATE bridge_outbound SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE idem_key = ?")
        .run(clock, clock, `notify:lane-silent:nudge-fact:${fact.fact_id}`);
      assert.equal(bridgeNotify.laneSilentNotice(fact.fact_id), 'delivered');
      assert.equal(bridgeNotify.reconcile().laneSilent, 0, 'and a delivered notice is not made again');
    });
  });

  describe('the sentences about the helper\'s own connection (#2272)', () => {
    const DOWN = '2026-10-11T20:03:00.000Z';
    const down = (values) => bridgeNotify.TEMPLATES['gateway-down']({ since: DOWN, minutes: 5, state: 'reconnecting', fatalCloseCode: null, ...values });
    const recovered = (values) => bridgeNotify.TEMPLATES['gateway-recovered']({ since: '2026-10-12T08:15:00.000Z', minutes: 732, ...values });

    // The zone is pinned, so these read the same on any machine.
    beforeEach(() => {
      bridgeNotify._deps.timeZone = () => 'America/Los_Angeles';
    });

    it('says a lost connection is still being retried, in the operator\'s local time', () => {
      const text = 'The Discord helper lost its connection to Discord at 13:03 PDT on 2026-10-11 and has not had one for 5 minutes. '
        + 'It is still trying. It can still post here, but it is not receiving what you send.';
      assert.equal(down({ state: 'reconnecting' }), text);
      assert.equal(down({ state: 'connecting' }), text);
    });

    it('does not say it is trying when the helper did not say so', () => {
      for (const state of ['idle', 'stopped']) {
        assert.equal(down({ state }), 'The Discord helper lost its connection to Discord at 13:03 PDT on 2026-10-11 and has not had one for 5 minutes. '
          + 'It can still post here, but it is not receiving what you send.');
      }
    });

    it('says a refused connection is refused, why, and that it will not come back by itself', () => {
      const refused = (why) => `Discord has refused the Discord helper's connection since 13:03 PDT on 2026-10-11 (${why}). `
        + 'It will not reconnect by itself: the cause has to be put right and the helper restarted. '
        + 'It can still post here, but it is not receiving what you send, so anything you reply will need sending again once it is fixed.';
      assert.equal(down({ state: 'fatal', fatalCloseCode: 4004 }), refused('the bot token was rejected'));
      assert.equal(down({ state: 'fatal', fatalCloseCode: 4014 }), refused('Message Content Intent is off'));
      assert.equal(down({ state: 'fatal', fatalCloseCode: 4010 }), refused('close code 4010'));
      assert.equal(down({ state: 'fatal', fatalCloseCode: null }), refused('no close code was reported'));
      assert.deepEqual(bridgeNotify.GATEWAY_REFUSED, { 4004: 'the bot token was rejected', 4014: 'Message Content Intent is off' });
      // A refusal is never worded as a connection that is being retried.
      for (const code of [4004, 4014, 4010, null, 'toString']) {
        assert.ok(!/trying|retry/i.test(down({ state: 'fatal', fatalCloseCode: code })), `close code ${code}`);
      }
    });

    it('says the connection is back, for how long it was not, and to send again what may have been missed', () => {
      assert.equal(recovered(), 'The Discord helper is connected to Discord again, since 01:15 PDT on 2026-10-12. '
        + 'It was not connected for 12 hours 12 minutes. Anything you sent here in that time may not have arrived: please send it again.');
    });

    it('counts a length of time in whole minutes and hours', () => {
      const length = (minutes) => /It was not connected for ([^.]+)\./.exec(recovered({ minutes }))[1];
      assert.deepEqual([0, 1, 5, 59, 60, 61, 120, 1501].map(length),
        ['0 minutes', '1 minute', '5 minutes', '59 minutes', '1 hour 0 minutes', '1 hour 1 minute', '2 hours 0 minutes', '25 hours 1 minute']);
    });

    it('leaves a length out when it was not given one it can count, and never prints what it was given', () => {
      for (const minutes of [null, undefined, -1, 4.5, NaN, '5', '<b>']) {
        assert.equal(recovered({ minutes }), 'The Discord helper is connected to Discord again, since 01:15 PDT on 2026-10-12. '
          + 'Anything you sent here in that time may not have arrived: please send it again.');
        assert.equal(down({ minutes }), 'The Discord helper lost its connection to Discord at 13:03 PDT on 2026-10-11 and has not had one since. '
          + 'It is still trying. It can still post here, but it is not receiving what you send.');
      }
      for (const since of [null, undefined, 'yesterday', '@everyone', 1760212980000]) {
        assert.ok(recovered({ since }).startsWith('The Discord helper is connected to Discord again, since a time that was not recorded.'), String(since));
        assert.ok(!recovered({ since }).includes('@everyone'));
      }
      assert.ok(!down({ state: '@everyone' }).includes('@everyone'), 'a state it does not know is not shown');
    });

    it('shows a time in the zone it is told, with that zone, in summer and in winter', () => {
      assert.match(down({ since: '2026-01-11T20:03:00.000Z' }), / at 12:03 PST on 2026-01-11 /);
      assert.match(down({ since: '2026-10-12T06:30:00.000Z' }), / at 23:30 PDT on 2026-10-11 /, 'the date is the local one too');
      assert.match(down({ since: '2026-10-11T07:00:00.000Z' }), / at 00:00 PDT on 2026-10-11 /, 'midnight is 00, not 24');
      bridgeNotify._deps.timeZone = () => 'Asia/Kolkata';
      assert.match(down(), / at 01:33 GMT\+5:30 on 2026-10-12 /, 'a zone with no short name is still named');
    });

    it('falls back to UTC, said as UTC, for a zone the runtime cannot name, and never shows a time without a zone', () => {
      bridgeNotify._deps.timeZone = () => 'Nowhere/Not_A_Zone';
      assert.match(down(), / at 20:03 UTC on 2026-10-11 /);
      assert.match(recovered(), / since 08:15 UTC on 2026-10-12\./);
      assert.match(down({ state: 'fatal', fatalCloseCode: 4004 }), / since 20:03 UTC on 2026-10-11 /);
    });

    it('uses this host\'s own zone when it is told none, and still names it', () => {
      bridgeNotify._deps.timeZone = realDeps.timeZone;
      assert.equal(realDeps.timeZone(), undefined);
      assert.match(down(), / at \d\d:\d\d \S+ on \d{4}-\d\d-\d\d /);
    });
  });

  describe('the outage notice and its recovery (#2272)', () => {
    const MINUTE = 60000;
    const DAY = 24 * 60 * MINUTE;
    let reading;

    /**
     * What the helper's report reads as, from now on.
     * @param {string} word - `connected`, `down`, `not-reported` or `never-reported`.
     * @param {object} [more] - `since`, `state`, `fatalCloseCode`.
     * @returns {void}
     */
    function reads(word, more = {}) {
      if (word === 'never-reported') {
        reading = { reading: word, state: null, since: null, fatalCloseCode: null, reportedAt: null };
        return;
      }
      const state = word === 'connected' ? 'ready' : 'reconnecting';
      reading = { reading: word, state, since: clock, fatalCloseCode: null, reportedAt: clock, ...more };
    }

    /**
     * Passes at one-minute steps, as the gateway makes them.
     * @param {number} minutes - How many.
     * @returns {number} How many notices they made between them.
     */
    function passes(minutes) {
      let made = 0;
      for (let i = 0; i < minutes; i++) {
        later(MINUTE);
        made += bridgeNotify.reconcile().gatewayOutage;
      }
      return made;
    }

    /**
     * An outage that began now, watched until its notice is made.
     * @returns {string} When it began.
     */
    function announcedOutage() {
      const began = clock;
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(5), 1, 'precondition: the outage was announced');
      return began;
    }

    /**
     * The helper posted every notice it was waiting to collect.
     * @returns {void}
     */
    function helperPosts() {
      store.getDb().prepare("UPDATE bridge_outbound SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE state = 'ready'").run(clock, clock);
    }

    const ours = () => notifications().filter((x) => x.type.startsWith('gateway-'));

    beforeEach(() => {
      Object.assign(bridgeNotify._deps, { timeZone: () => 'America/Los_Angeles', discordReading: () => reading });
      clock = '2026-10-11T20:00:00.000Z';
      enable();
      later(60 * MINUTE);
      reads('never-reported');
    });

    it('says nothing at 4 minutes 59 seconds, tells the operator at 5 minutes, and once only however long it lasts', () => {
      assert.equal(bridgeNotify.GATEWAY_DOWN_AFTER_MS, 5 * MINUTE);
      const began = clock;
      reads('down');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0);
      later(5 * MINUTE - 1000);
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0, '4 minutes 59 seconds');
      later(1000);
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1, '5 minutes');
      assert.deepEqual(notifications(), [{
        type: 'gateway-down', key: `notify:gateway-down:since:${began}`,
        text: 'The Discord helper lost its connection to Discord at 14:00 PDT on 2026-10-11 and has not had one for 5 minutes. '
          + 'It is still trying. It can still post here, but it is not receiving what you send.',
        label: 'TangleClaw', routeId: null
      }]);
      assert.equal(passes(60), 0, 'still down an hour later');
      // The server restarts: what it had seen is gone, and the notice is still the record.
      bridgeNotify._reset();
      assert.equal(passes(10), 0, 'a restart does not announce it twice');
      // Posted or not, it is the one notice.
      helperPosts();
      assert.equal(passes(10), 0);
      assert.equal(notifications().length, 1);
    });

    it('announces the recovery once, with how long the outage lasted, and nothing more while it stays connected', () => {
      const began = announcedOutage();
      later(7 * MINUTE);
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.deepEqual(ours()[1], {
        type: 'gateway-recovered', key: `notify:gateway-recovered:since:${began}`,
        text: 'The Discord helper is connected to Discord again, since 14:12 PDT on 2026-10-11. It was not connected for 12 minutes. '
          + 'Anything you sent here in that time may not have arrived: please send it again.',
        label: 'TangleClaw', routeId: null
      });
      assert.equal(passes(30), 0, 'connected and staying so is not news');
      bridgeNotify._reset();
      assert.equal(passes(5), 0, 'nor after a restart');
      assert.equal(ours().length, 2);
    });

    it('announces no recovery for an outage that was never announced', () => {
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(4), 0);
      reads('connected');
      assert.equal(passes(3), 0, 'back inside five minutes: there was nothing to be back from');
      assert.deepEqual(notifications(), []);
      // And the short drop does not count towards the next one, even from a helper whose clock runs behind.
      reads('down', { since: new Date(Date.parse(clock) - 120 * MINUTE).toISOString() });
      bridgeNotify.reconcile();
      assert.equal(passes(4), 0, 'a new drop is watched from its own first reading');
      assert.equal(passes(1), 1);
    });

    it('announces a second outage after a recovery as its own outage', () => {
      const first = announcedOutage();
      reads('connected');
      assert.equal(passes(1), 1);
      later(30 * MINUTE);
      const second = clock;
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(4), 0);
      assert.equal(passes(1), 1);
      reads('connected');
      assert.equal(passes(1), 1);
      assert.deepEqual(ours().map((x) => x.key), [
        `notify:gateway-down:since:${first}`, `notify:gateway-recovered:since:${first}`,
        `notify:gateway-down:since:${second}`, `notify:gateway-recovered:since:${second}`
      ]);
    });

    it('queues nothing for no report, for a report gone stale, or while the bridge is disabled', () => {
      assert.equal(passes(30), 0, 'never reported');
      reads('not-reported', { state: 'reconnecting' });
      assert.equal(passes(30), 0, 'a helper that polls slowly reads like this while it runs: not an outage');
      reads('not-reported', { state: 'ready' });
      assert.equal(passes(30), 0);
      reads('down');
      bridgeStore.settings.set('enabled', 'false');
      assert.equal(passes(30), 0, 'disabled');
      assert.deepEqual(notifications(), []);
      // Enabled again in the middle of the outage: it has to be watched for five minutes from then.
      enable();
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0, 'the first pass that reads it as down');
      assert.equal(passes(4), 0, 'not for an outage watched for less than five minutes');
      assert.equal(passes(1), 1);
    });

    it('counts from when the bridge was enabled, when that is later than the outage and than first seeing it', () => {
      reads('down');
      bridgeNotify.reconcile();
      passes(1);
      bridgeStore.settings.set('enabled', 'false');
      later(2 * MINUTE);
      enable();
      assert.equal(passes(4), 0, 'seven minutes down and seen, four since it was enabled');
      assert.equal(passes(1), 1);
    });

    it('a reading it cannot use raises nothing and breaks nothing', () => {
      for (const odd of [null, undefined, {}, { reading: 'something-new' }, 'down']) {
        reading = odd;
        assert.equal(passes(6), 0, JSON.stringify(odd));
      }
      reads('down', { since: 'yesterday' });
      assert.equal(passes(10), 0, 'a beginning that is not a time cannot be counted from');
      assert.deepEqual(notifications(), []);
    });

    it('tells the operator of a connection Discord refused after the same five minutes, in the refusal\'s own words', () => {
      reads('down', { state: 'fatal', fatalCloseCode: 4004 });
      bridgeNotify.reconcile();
      assert.equal(passes(4), 0);
      assert.equal(passes(1), 1);
      assert.equal(notifications()[0].text, 'Discord has refused the Discord helper\'s connection since 14:00 PDT on 2026-10-11 (the bot token was rejected). '
        + 'It will not reconnect by itself: the cause has to be put right and the helper restarted. '
        + 'It can still post here, but it is not receiving what you send, so anything you reply will need sending again once it is fixed.');
      assert.ok(!/trying|retry/i.test(notifications()[0].text));
      // Put right and restarted: the recovery is announced like any other.
      later(20 * MINUTE);
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.match(notifications()[1].text, /It was not connected for 25 minutes\./);
    });

    it('says what the helper is doing when the notice is made, not when the outage began', () => {
      reads('down', { state: 'connecting' });
      bridgeNotify.reconcile();
      passes(4);
      reads('down', { since: reading.since, state: 'stopped' });
      assert.equal(passes(1), 1);
      assert.ok(!notifications()[0].text.includes('It is still trying.'));
    });

    it('a helper restarted in the middle of an announced outage is not a second outage, and the recovery counts from the first beginning', () => {
      const began = announcedOutage();
      later(10 * MINUTE);
      // A restarted helper counts from its own start.
      reads('down', { state: 'connecting' });
      assert.equal(passes(30), 0, 'the same outage, whatever time the report now carries');
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.equal(ours()[1].key, `notify:gateway-recovered:since:${began}`);
      assert.match(ours()[1].text, /It was not connected for 45 minutes\./);
    });

    it('a report that stops arriving during an outage neither ends it nor announces a recovery', () => {
      const began = announcedOutage();
      reads('not-reported', { since: began, state: 'reconnecting' });
      assert.equal(passes(120), 0, 'no word from the helper is not word that it is connected');
      // A last report that said connected, gone stale, is not a connection either.
      reads('not-reported', { state: 'ready' });
      assert.equal(passes(10), 0);
      assert.equal(ours().length, 1);
      // The outage is still the open one when a report next says down ...
      reads('down', { since: began });
      assert.equal(passes(10), 0, 'still down: nothing more');
      // ... and when one next says connected.
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.equal(ours()[1].key, `notify:gateway-recovered:since:${began}`);
    });

    it('a report that stops arriving before the notice does not restart the wait', () => {
      // A helper polling every five minutes reads down for three and not-reported for two, over and over.
      const began = clock;
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(3), 0);
      reads('not-reported', { since: began, state: 'reconnecting' });
      assert.equal(passes(2), 0, 'five minutes are up, but there is no report to act on');
      reads('down', { since: began });
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1, 'the next report that says down is enough');
    });

    it('does not announce an outage this server has not itself watched for five minutes', () => {
      // The helper says it has been down for two hours; this process has only just started.
      reads('down', { since: new Date(Date.parse(clock) - 120 * MINUTE).toISOString() });
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0);
      assert.equal(passes(4), 0);
      assert.equal(passes(1), 1);
      assert.match(notifications()[0].text, /has not had one for 2 hours 5 minutes\./, 'the length is the helper\'s');
      // A helper whose clock runs ahead costs a delay and no more.
      bridgeNotify._reset();
      store.getDb().prepare('DELETE FROM bridge_outbound').run();
      reads('down', { since: new Date(Date.parse(clock) + 10 * MINUTE).toISOString() });
      assert.equal(passes(14), 0);
      assert.equal(passes(1), 1);
    });

    it('a notice that could not be enqueued is made on the next pass, under the same key, for the outage and for the recovery', () => {
      const began = clock;
      reads('down');
      bridgeNotify.reconcile();
      passes(4);
      const realEnqueue = bridgeStore.outbound.enqueue;
      const failing = (work) => {
        bridgeStore.outbound.enqueue = () => { throw new Error('database is locked'); };
        try {
          work();
        } finally {
          bridgeStore.outbound.enqueue = realEnqueue;
        }
      };
      failing(() => assert.equal(passes(2), 0));
      assert.deepEqual(notifications(), [], 'nothing was marked as told');
      assert.equal(passes(1), 1);
      reads('connected');
      failing(() => assert.equal(passes(2), 0));
      assert.equal(passes(1), 1);
      assert.deepEqual(ours().map((x) => x.key), [`notify:gateway-down:since:${began}`, `notify:gateway-recovered:since:${began}`]);
    });

    /**
     * The limit for an uncollected outage notice passes, and it is let go.
     * @returns {void}
     */
    function noticeLetGo() {
      later(7 * DAY + MINUTE);
      assert.equal(bridgeStore.expire({ now: clock }).outbound, 1, 'precondition: the notice was let go');
    }

    it('announces once more, with its first beginning and its real length, an outage still going on after its notice was let go uncollected', () => {
      const began = announcedOutage();
      const first = ours()[0];
      reads('down', { since: began });
      noticeLetGo();
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1, 'the helper is back and still not connected: the operator has been told nothing yet');
      assert.equal(ours().length, 2);
      assert.notEqual(ours()[1].key, first.key, 'a new notice, not the one that was let go');
      assert.ok(ours()[1].key.endsWith(`:since:${began}`));
      assert.equal(ours()[1].text, 'The Discord helper lost its connection to Discord at 14:00 PDT on 2026-10-11 and has not had one for 168 hours 6 minutes. '
        + 'It is still trying. It can still post here, but it is not receiving what you send.');
      assert.equal(passes(60), 0, 'once: the new notice is the outage\'s notice now');
      bridgeNotify._reset();
      assert.equal(passes(10), 0, 'and not again after a restart');
      // Let go a second time, still down: once more, and not sooner than the limit.
      noticeLetGo();
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.equal(passes(60), 0);
      assert.equal(new Set(ours().map((x) => x.key)).size, 3);
    });

    it('says nothing when the connection came back before or after the notice was let go', () => {
      const began = announcedOutage();
      // Back while the notice still waited, with the helper unable to post either notice.
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      later(7 * DAY + MINUTE);
      assert.equal(bridgeStore.expire({ now: clock }).outbound, 2, 'precondition: both were let go');
      assert.equal(passes(10), 0);
      assert.equal(ours().length, 2);

      // Back only after the notice was let go: a notice nobody saw has nothing to be followed by.
      store.getDb().prepare('DELETE FROM bridge_outbound').run();
      bridgeNotify._reset();
      reads('never-reported');
      const second = announcedOutage();
      reads('not-reported', { since: second, state: 'reconnecting' });
      noticeLetGo();
      reads('connected');
      assert.equal(passes(10), 0);
      assert.equal(ours().length, 1);
      // What was let go holds nothing open: the next outage is announced as its own.
      const third = clock;
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(5), 1);
      assert.equal(ours()[1].key, `notify:gateway-down:since:${third}`);
      assert.ok(began < second && second < third);
    });

    it('follows an outage announced again with its recovery, counted from its first beginning', () => {
      const began = announcedOutage();
      reads('down', { since: began });
      noticeLetGo();
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      helperPosts();
      later(30 * MINUTE);
      reads('connected');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.deepEqual(ours()[2], {
        type: 'gateway-recovered', key: `notify:gateway-recovered:since:${began}`,
        text: 'The Discord helper is connected to Discord again, since 14:36 PDT on 2026-10-18. It was not connected for 168 hours 36 minutes. '
          + 'Anything you sent here in that time may not have arrived: please send it again.',
        label: 'TangleClaw', routeId: null
      });
      assert.equal(passes(30), 0);
    });

    it('does not announce again an outage whose notice somebody withdrew, and announces the next one', () => {
      const began = announcedOutage();
      // As the store withdraws an item: on purpose, and for good.
      store.getDb().prepare("UPDATE bridge_outbound SET state = 'dropped', drop_code = 'withdrawn', text = NULL, updated_at = ? WHERE state = 'ready'").run(clock);
      reads('down', { since: began });
      assert.equal(passes(30), 0, 'withdrawing is final');
      later(8 * DAY);
      assert.equal(passes(5), 0, 'however long it lasts');
      reads('connected');
      assert.equal(passes(5), 0, 'and there is no notice for a recovery to follow');
      assert.equal(ours().length, 1);
      reads('down');
      bridgeNotify.reconcile();
      assert.equal(passes(5), 1, 'a later outage is its own');
    });

    it('announces a helper restarted after its notice was let go from the beginning it now reports, after the usual wait', () => {
      announcedOutage();
      noticeLetGo();
      // The server cannot tell this from a new outage: it has no notice the operator saw to hold it to.
      const restarted = clock;
      reads('down', { state: 'connecting' });
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0);
      assert.equal(passes(4), 0);
      assert.equal(passes(1), 1);
      assert.equal(ours()[1].key, `notify:gateway-down:since:${restarted}`);
    });

    it('announces once more an outage still open after retention has removed its posted notice, as a reminder', () => {
      const began = announcedOutage();
      helperPosts();
      reads('down', { since: began });
      later(30 * DAY + MINUTE);
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 0, 'thirty days on, the notice is still the record');
      assert.equal(bridgeStore.prune({ now: clock }).outbound, 1, 'precondition: retention removed it');
      assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
      assert.equal(passes(60), 0, 'once');
      assert.match(notifications()[0].text, /^The Discord helper lost its connection to Discord at 14:00 PDT on 2026-10-11 and has not had one for 720 hours 6 minutes\./);
    });

    it('has no recovery to announce for an outage that ends after its notice was removed', () => {
      const began = announcedOutage();
      helperPosts();
      later(30 * DAY + MINUTE);
      bridgeStore.prune({ now: clock });
      reads('connected');
      assert.equal(passes(5), 0);
      assert.deepEqual(notifications(), []);
      assert.ok(began);
    });

    it('leaves the other kinds as they were, and its own failure does not stop them', () => {
      const alpha = liveSession('Alpha');
      reports(alpha, 'blocked');
      bridgeNotify._deps.discordReading = () => { throw new Error('the gateway could not be read'); };
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 1, workUnblocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 0 });
      assert.deepEqual(notifications().map((x) => x.type), ['work-blocked']);
      // And with an outage announced in the same pass, each kind counts its own.
      Object.assign(bridgeNotify._deps, { discordReading: () => reading });
      reads('down');
      bridgeNotify.reconcile();
      later(5 * MINUTE);
      // working then blocked again, in the same un-reconciled stretch: by the time this pass
      // runs the lane is blocked again, so the now-stale recovery for the working receipt in
      // between is suppressed (PR #2629 review C1) -- only the new block is announced.
      reports(alpha, 'working');
      reports(alpha, 'blocked');
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 1, workUnblocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 1 });
    });

    it('reads the helper\'s report from the gateway itself when nothing else is supplied', () => {
      const gateway = require('../lib/bridge-gateway');
      const gatewayNow = gateway._deps.now;
      Object.assign(bridgeNotify._deps, { discordReading: realDeps.discordReading });
      gateway._deps.now = () => clock;
      gateway._reset();
      try {
        assert.equal(passes(6), 0, 'never reported');
        const began = clock;
        // The helper reports with every claim; each one is the report held.
        const claim = (state) => gateway.recordDiscordReport({ state, since: state === 'ready' ? clock : began, fatalCloseCode: null });
        claim('reconnecting');
        let made = bridgeNotify.reconcile().gatewayOutage;
        for (let i = 0; i < 5; i++) {
          later(MINUTE);
          claim('reconnecting');
          made += bridgeNotify.reconcile().gatewayOutage;
        }
        assert.equal(made, 1);
        assert.equal(notifications()[0].key, `notify:gateway-down:since:${began}`);
        // The helper stops reporting: past the gateway's staleness limit the report says nothing.
        later(gateway.DISCORD_REPORT_STALE_MS + 1000);
        assert.equal(gateway.discordReading().reading, 'not-reported');
        assert.equal(bridgeNotify.reconcile().gatewayOutage, 0);
        claim('ready');
        assert.equal(bridgeNotify.reconcile().gatewayOutage, 1);
        assert.deepEqual(ours().map((x) => x.type), ['gateway-down', 'gateway-recovered']);
      } finally {
        gateway._deps.now = gatewayNow;
        gateway._reset();
      }
    });
  });

  it('every notification text comes from a fixed template that takes no free text', () => {
    assert.deepEqual(Object.keys(bridgeNotify.TEMPLATES).sort(),
      ['fleet-idle', 'gateway-down', 'gateway-recovered', 'lane-silent', 'operator-needed', 'work-blocked', 'work-unblocked']);
    // work-unblocked is the one deliberate exception (#2141, Architect Ruling A475-W1A-R1): it has
    // its own template but is never a notify_type NOTIFICATION_TYPES admits, because _emit stores
    // it under work-blocked's own admitted type and retention instead of adding a new one.
    assert.deepEqual(
      Object.keys(bridgeNotify.TEMPLATES).filter((t) => t !== 'work-unblocked').sort(),
      [...bridgeSchema.NOTIFICATION_TYPES].sort(),
      'every admitted type has a template, and no other does except the one deliberate exception'
    );
    // A project name is the only string a template shows, and it is cleaned and bounded.
    // The store refuses such a name; this is one it would never have written.
    const hostile = store.projects.create({ name: 'Evil', path: path.join(tmpDir, 'evil') });
    store.getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run(`Evil\u202E${'x'.repeat(200)}`, hostile.id);
    const bound = bindProject(hostile);
    enable();
    reports({ project: hostile, ...bound }, 'blocked');
    bridgeNotify.reconcile();
    const text = notifications()[0].text;
    assert.ok(!text.includes('\u202E'));
    assert.ok(text.length < 120);
  });
});
