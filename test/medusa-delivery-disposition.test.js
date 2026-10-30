'use strict';

/*
 * What a held Medusa wake means for the people waiting on it (#2086).
 *
 * `lib/medusa-delivery-disposition.js` is the one classifier behind both the
 * fleet's undelivered view and the answer a sender gets about a peer. These
 * hold it to the wake monitor's own reason vocabulary, and to the two rules
 * that decide the doubtful cases: an unknown code is `configuration`, and
 * `historical` needs a positive answer that the session is not live.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-delivery-disposition');
after(() => _store.cleanup());

const store = require('../lib/store');
const d = require('../lib/medusa-delivery-disposition');
const wake = require('../lib/medusa-wake');

const NOW = Date.parse('2026-10-04T12:00:00Z');

/**
 * An undelivered row as the store returns one.
 * @param {object} [over] - Fields to override
 * @returns {object}
 */
const row = (over = {}) => ({
  sessionId: '41', projectId: 4, workspaceId: 'ws-41', messageKey: 'm1', unread: 1,
  outcome: 'skipped', skipReason: 'pane-turn-in-flight', createdAt: '2026-10-04 11:00:00', ...over
});

describe('delivery disposition — every reason the monitor can give has a class', () => {
  it('each exact code in PEER_REASON_MEANINGS is declared here, with a real class and next action', () => {
    for (const code of Object.keys(wake.PEER_REASON_MEANINGS)) {
      const c = d.classifyReason(code);
      assert.equal(c.known, true, `${code} has no class: add it to lib/medusa-delivery-disposition.js`);
      assert.ok([...d.CLASSES, 'none'].includes(c.class), `${code} → ${c.class}`);
      assert.equal(typeof d.NEXT_ACTIONS[c.nextAction], 'string', `${code} → ${c.nextAction}`);
      assert.equal(c.nextActionMeaning, d.NEXT_ACTIONS[c.nextAction]);
    }
  });

  it('each variable-tail prefix in PEER_REASON_PREFIX_MEANINGS is declared here', () => {
    for (const prefix of Object.keys(wake.PEER_REASON_PREFIX_MEANINGS)) {
      assert.equal(d.classifyReason(`${prefix}something`).known, true, `${prefix}* has no class`);
    }
  });

  it('declares nothing the monitor cannot give: every code and prefix here is in its vocabulary', () => {
    for (const code of Object.keys(d.REASONS)) {
      assert.notEqual(wake.peerReasonMeaning(code), null, `${code} is declared here and is not a reason the monitor gives`);
    }
    for (const prefix of Object.keys(d.REASON_PREFIXES)) {
      assert.ok(Object.prototype.hasOwnProperty.call(wake.PEER_REASON_PREFIX_MEANINGS, prefix), prefix);
    }
  });

  it('every next action has a sentence, and every sentence is used', () => {
    const used = new Set([...Object.values(d.REASONS), ...Object.values(d.REASON_PREFIXES)].map((e) => e.nextAction));
    used.add('investigate').add('resend');
    assert.deepEqual([...used].sort(), Object.keys(d.NEXT_ACTIONS).sort());
    for (const text of Object.values(d.NEXT_ACTIONS)) assert.ok(text.length > 10);
  });

  it('waiting fixes a busy pane; it does not fix a session that never opted in', () => {
    assert.deepEqual([d.classifyReason('pane-turn-in-flight').class, d.classifyReason('pane-turn-in-flight').nextAction], ['actionable', 'wait']);
    assert.deepEqual([d.classifyReason('wake-not-opted-in').class, d.classifyReason('wake-not-opted-in').nextAction], ['configuration', 'enable-wake']);
    assert.deepEqual([d.classifyReason('unprofiled-engine').class, d.classifyReason('unprofiled-engine').nextAction], ['configuration', 'read-by-hand']);
    assert.deepEqual([d.classifyReason('engine-channel-absent').class, d.classifyReason('engine-channel-absent').nextAction], ['configuration', 'relaunch-recipient']);
  });

  it('a thread that has only just gone idle is waited out: the settling hold ends by itself', () => {
    const settling = d.classifyReason('engine-thread-settling');
    assert.deepEqual([settling.class, settling.nextAction, settling.known], ['actionable', 'wait', true]);
    assert.equal(d.classifyForSender('engine-thread-settling', { monitorRunning: true }).nextAction, 'wait');
    assert.equal(d.classifyForSender('engine-thread-settling', { monitorRunning: false }).nextAction, 'investigate',
      'a stopped monitor ends no hold, this one included');
  });

  it('an engine whose header says it is still starting is waited out: it ends when the engine has started (#2187)', () => {
    const starting = d.classifyReason('pane-engine-starting');
    assert.deepEqual([starting.class, starting.nextAction, starting.known], ['actionable', 'wait', true]);
    assert.equal(d.classifyForSender('pane-engine-starting', { monitorRunning: true }).nextAction, 'wait');
    assert.equal(d.classifyForSender('pane-engine-starting', { monitorRunning: false }).nextAction, 'investigate');
  });

  it('a folder the engine was told not to trust is its operator\'s to review, and waiting does not end it (#2186)', () => {
    const held = d.classifyReason('engine-folder-untrusted');
    assert.deepEqual([held.class, held.nextAction, held.known], ['configuration', 'review-folder-trust', true]);
    assert.match(held.nextActionMeaning, /trusted/);
    assert.match(held.nextActionMeaning, /by hand/);
    assert.equal(d.classifyForSender('engine-folder-untrusted', { monitorRunning: true }).nextAction, 'review-folder-trust');
    assert.equal(d.classifyForSender('engine-folder-untrusted', { monitorRunning: false }).nextAction, 'investigate');
  });

  it('a listener that is off needs someone; one that is reconnecting does not', () => {
    assert.equal(d.classifyReason('listener-off').class, 'configuration');
    assert.equal(d.classifyReason('listener-connecting').class, 'actionable');
    assert.equal(d.classifyReason('listener-error').class, 'actionable');
  });

  it('a stored failed injection is read as its code, whatever error text follows it', () => {
    assert.equal(d.reasonCode('inject-failed: tmux send-keys exited 1'), 'inject-failed');
    assert.equal(d.classifyReason('inject-failed: tmux send-keys exited 1').class, 'actionable');
  });

  it('nudged and no-mail are not a held wake', () => {
    assert.equal(d.classifyReason('nudged').class, 'none');
    assert.equal(d.classifyReason('no-mail').class, 'none');
  });
});

describe('delivery disposition — the doubtful cases fail towards someone looking', () => {
  for (const code of ['some-new-code', '', null, undefined, 42, 'session-', 'listener-']) {
    it(`an undeclared reason (${JSON.stringify(code)}) is configuration, to be investigated`, () => {
      const c = d.classifyReason(code);
      assert.deepEqual([c.class, c.nextAction, c.known], ['configuration', 'investigate', false]);
    });
  }

  it('a row is historical only when its session is positively not live', () => {
    assert.equal(d.classifyDelivery(row(), { live: false, now: NOW }).class, 'historical');
    assert.equal(d.classifyDelivery(row(), { live: false, now: NOW }).nextAction, 'resend');
  });

  it('a row whose liveness is unknown is configuration, never historical and never actionable', () => {
    for (const live of [null, undefined, 'yes', 0]) {
      const item = d.classifyDelivery(row(), { live, now: NOW });
      assert.deepEqual([item.class, item.nextAction, item.live], ['configuration', 'investigate', null], JSON.stringify(live));
    }
  });

  it('a live row with an undeclared reason is configuration, and says its reason is unknown', () => {
    const item = d.classifyDelivery(row({ skipReason: 'brand-new-gate' }), { live: true, now: NOW });
    assert.deepEqual([item.class, item.nextAction, item.reasonKnown], ['configuration', 'investigate', false]);
  });

  it('a live row carrying a code that means not-held or not-live contradicts itself, and is investigated', () => {
    assert.equal(d.classifyDelivery(row({ skipReason: 'nudged' }), { live: true, now: NOW }).nextAction, 'investigate');
    assert.equal(d.classifyDelivery(row({ skipReason: 'session-ended' }), { live: true, now: NOW }).class, 'configuration');
  });

  it('a stopped recipient that is the same identity when it runs again is configuration, to be started, never historical', () => {
    const item = d.classifyDelivery(row({ sessionId: 'master' }), { live: false, restartable: true, now: NOW });
    assert.deepEqual([item.class, item.nextAction, item.live], ['configuration', 'start-recipient', false]);
  });

  it('being restartable changes nothing for a recipient that is live or whose liveness is unknown', () => {
    assert.equal(d.classifyDelivery(row(), { live: true, restartable: true, monitorRunning: true, now: NOW }).class, 'actionable');
    assert.deepEqual(
      [d.classifyDelivery(row(), { live: null, restartable: true, now: NOW }).class, d.classifyDelivery(row(), { live: null, restartable: true, now: NOW }).nextAction],
      ['configuration', 'investigate']
    );
  });

  it('a class of none is never given to a row of the list', () => {
    for (const skipReason of ['nudged', 'no-mail']) {
      for (const live of [true, false, null]) {
        assert.notEqual(d.classifyDelivery(row({ skipReason }), { live, now: NOW }).class, 'none');
      }
    }
  });

  it('a non-live row is historical whatever its last reason was, including an undeclared one', () => {
    for (const skipReason of ['wrap-running', 'wake-not-opted-in', 'brand-new-gate']) {
      assert.equal(d.classifyDelivery(row({ skipReason }), { live: false, now: NOW }).class, 'historical');
    }
  });
});

describe('delivery disposition — a list row never promises a retry from a monitor that is not running', () => {
  /** Reasons the table classes as actionable, one per shape: exact codes and a prefixed one. */
  const RETRYABLE = [
    ...Object.entries(d.REASONS).filter(([, e]) => e.class === 'actionable').map(([code]) => code),
    'listener-connecting',
    'inject-failed: tmux send-keys exited 1'
  ];

  it('the table has retryable reasons to test with', () => {
    assert.ok(RETRYABLE.length > 10);
  });

  it('with the monitor running, each retryable reason on a live row is actionable, to be waited out', () => {
    for (const skipReason of RETRYABLE) {
      const item = d.classifyDelivery(row({ skipReason }), { live: true, monitorRunning: true, now: NOW });
      assert.deepEqual([item.class, item.nextAction], ['actionable', 'wait'], skipReason);
    }
  });

  for (const monitorRunning of [false, undefined, null, 'yes', 1]) {
    it(`with the monitor not positively running (${JSON.stringify(monitorRunning)}), none is actionable and none promises a retry`, () => {
      for (const skipReason of [...RETRYABLE, 'brand-new-gate']) {
        const item = d.classifyDelivery(row({ skipReason }), { live: true, monitorRunning, now: NOW });
        assert.deepEqual([item.class, item.nextAction], ['configuration', 'investigate'], skipReason);
        assert.equal(item.nextActionMeaning, d.NEXT_ACTIONS.investigate);
        assert.doesNotMatch(item.nextActionMeaning, /retries by itself/, skipReason);
      }
    });
  }

  it('the words are the ones the sender-facing answer uses for a stopped monitor', () => {
    const listed = d.classifyDelivery(row(), { live: true, monitorRunning: false, now: NOW });
    const told = d.classifyForSender('pane-turn-in-flight', { monitorRunning: false });
    assert.deepEqual([listed.class, listed.nextAction, listed.nextActionMeaning], [told.class, told.nextAction, told.nextActionMeaning]);
  });

  it('a stopped monitor changes nothing for a row that was not actionable', () => {
    const config = d.classifyDelivery(row({ skipReason: 'wake-not-opted-in' }), { live: true, monitorRunning: false, now: NOW });
    assert.deepEqual([config.class, config.nextAction], ['configuration', 'enable-wake']);
    const gone = d.classifyDelivery(row(), { live: false, monitorRunning: false, now: NOW });
    assert.deepEqual([gone.class, gone.nextAction], ['historical', 'resend']);
    const master = d.classifyDelivery(row({ sessionId: 'master' }), { live: false, restartable: true, monitorRunning: false, now: NOW });
    assert.deepEqual([master.class, master.nextAction], ['configuration', 'start-recipient']);
  });

  it('the view of a stopped monitor has no actionable items, the same membership and order, and partitions that still add up', () => {
    const rows = [
      row({ sessionId: '1', skipReason: 'wrap-running' }),
      row({ sessionId: '2', skipReason: 'pane-writing' }),
      row({ sessionId: '3', skipReason: 'wake-not-opted-in' }),
      row({ sessionId: '4', skipReason: 'engine-thread-busy' })
    ];
    const factsFor = (r) => ({ live: r.sessionId !== '1' });
    const running = d.buildView(rows, { factsFor, monitorRunning: true, now: NOW });
    const stopped = d.buildView(rows, { factsFor, now: NOW });
    assert.deepEqual(running.actionable.map((i) => i.sessionId), ['2', '4']);
    assert.deepEqual(stopped.actionable, []);
    assert.deepEqual(stopped.undelivered.map((i) => i.sessionId), running.undelivered.map((i) => i.sessionId));
    assert.deepEqual(stopped.configuration.map((i) => i.sessionId), ['2', '3', '4']);
    assert.deepEqual(stopped.historical.map((i) => i.sessionId), ['1']);
    assert.equal(stopped.actionable.length + stopped.configuration.length + stopped.historical.length, stopped.undelivered.length);
    assert.deepEqual([stopped.summary.actionable, stopped.summary.oldestActionableAgeMs], [0, null]);
    for (const item of stopped.undelivered) assert.doesNotMatch(item.nextActionMeaning, /retries by itself/);
  });
});

describe('delivery disposition — what each item carries', () => {
  it('keeps every field of the row and adds the class, timestamps and next action', () => {
    const item = d.classifyDelivery(row(), { live: true, lastAssessedAt: '2026-10-04T11:59:55.000Z', monitorRunning: true, now: NOW });
    assert.equal(item.sessionId, '41');
    assert.equal(item.skipReason, 'pane-turn-in-flight');
    assert.deepEqual(
      [item.class, item.live, item.reason, item.since, item.lastAssessedAt, item.ageMs, item.nextAction],
      ['actionable', true, 'pane-turn-in-flight', '2026-10-04 11:00:00', '2026-10-04T11:59:55.000Z', 60 * 60 * 1000, 'wait']
    );
    assert.equal(item.nextActionMeaning, d.NEXT_ACTIONS.wait);
  });

  it('reads the store\'s timestamp as UTC, and an ISO one as given', () => {
    assert.equal(d.classifyDelivery(row({ createdAt: '2026-10-04 11:59:00' }), { live: true, now: NOW }).ageMs, 60000);
    assert.equal(d.classifyDelivery(row({ createdAt: '2026-10-04T11:59:00.000Z' }), { live: true, now: NOW }).ageMs, 60000);
  });

  it('gives no age for a timestamp it cannot read, and never a negative one', () => {
    assert.equal(d.classifyDelivery(row({ createdAt: 'yesterday' }), { live: true, now: NOW }).ageMs, null);
    assert.equal(d.classifyDelivery(row({ createdAt: null }), { live: true, now: NOW }).ageMs, null);
    assert.equal(d.classifyDelivery(row({ createdAt: '2026-10-04 13:00:00' }), { live: true, now: NOW }).ageMs, 0);
  });

  it('gives a last-assessed time only for a live session', () => {
    assert.equal(d.classifyDelivery(row(), { live: false, lastAssessedAt: '2026-10-04T11:59:55.000Z', now: NOW }).lastAssessedAt, null);
    assert.equal(d.classifyDelivery(row(), { live: true, now: NOW }).lastAssessedAt, null);
  });
});

describe('delivery disposition — the fleet view', () => {
  const rows = [
    row({ sessionId: '1', skipReason: 'wrap-running', createdAt: '2026-08-21 09:55:47' }),
    row({ sessionId: '2', skipReason: 'pane-writing', createdAt: '2026-10-04 11:30:00' }),
    row({ sessionId: '3', skipReason: 'wake-not-opted-in', createdAt: '2026-10-04 10:00:00' }),
    row({ sessionId: '4', skipReason: 'engine-thread-busy', createdAt: '2026-10-04 11:50:00' }),
    row({ sessionId: '5', skipReason: 'brand-new-gate', createdAt: '2026-10-04 11:55:00' }),
    row({ sessionId: 'master', skipReason: 'pane-writing', createdAt: '2026-10-04 11:58:00' })
  ];
  const live = { 1: false, 2: true, 3: true, 4: true, 5: true };
  const factsFor = (r) => {
    if (r.sessionId === 'master') throw new Error('could not tell');
    return { live: live[r.sessionId], lastAssessedAt: '2026-10-04T11:59:58.000Z' };
  };
  const view = d.buildView(rows, { factsFor, monitorRunning: true, now: NOW });

  it('keeps undelivered complete and in the order given', () => {
    assert.deepEqual(view.undelivered.map((i) => i.sessionId), ['1', '2', '3', '4', '5', 'master']);
  });

  it('puts each item in exactly one partition, and the partitions sum to undelivered', () => {
    assert.deepEqual(view.historical.map((i) => i.sessionId), ['1']);
    assert.deepEqual(view.actionable.map((i) => i.sessionId), ['2', '4']);
    assert.deepEqual(view.configuration.map((i) => i.sessionId), ['3', '5', 'master']);
    assert.equal(view.actionable.length + view.configuration.length + view.historical.length, view.undelivered.length);
  });

  it('the partitions hold the same objects as undelivered, not copies', () => {
    for (const cls of d.CLASSES) for (const item of view[cls]) assert.ok(view.undelivered.includes(item));
  });

  it('a row whose facts could not be read is configuration, not historical', () => {
    const master = view.undelivered[5];
    assert.deepEqual([master.class, master.live, master.nextAction], ['configuration', null, 'investigate']);
  });

  it('summarizes the counts, the oldest actionable age and the undeclared reasons', () => {
    assert.deepEqual(view.summary, {
      total: 6, actionable: 2, configuration: 3, historical: 1,
      oldestActionableAgeMs: 30 * 60 * 1000,
      unknownReasons: ['brand-new-gate']
    });
  });

  it('an empty list gives empty partitions and no oldest age', () => {
    const empty = d.buildView([], { factsFor, now: NOW });
    assert.deepEqual(empty, {
      undelivered: [], actionable: [], configuration: [], historical: [],
      summary: { total: 0, actionable: 0, configuration: 0, historical: 0, oldestActionableAgeMs: null, unknownReasons: [] }
    });
  });

  it('does not change the rows it is given', () => {
    const input = [row()];
    const before = JSON.stringify(input);
    d.buildView(input, { factsFor: () => ({ live: true }), now: NOW });
    assert.equal(JSON.stringify(input), before);
  });
});

describe('delivery disposition — a stopped monitor never tells a sender to wait', () => {
  it('with the monitor running, the answer is the reason\'s own class', () => {
    for (const code of ['pane-turn-in-flight', 'wake-not-opted-in', 'nudged', 'session-ended']) {
      assert.deepEqual(d.classifyForSender(code, { monitorRunning: true }), d.classifyReason(code));
    }
  });

  it('with the monitor stopped, every reason is configuration, to be investigated', () => {
    for (const code of [...Object.keys(wake.PEER_REASON_MEANINGS), 'listener-connecting', 'session-ended', 'brand-new-gate']) {
      const c = d.classifyForSender(code, { monitorRunning: false });
      assert.deepEqual([c.class, c.nextAction], ['configuration', 'investigate'], code);
      assert.equal(c.nextActionMeaning, d.NEXT_ACTIONS.investigate);
      assert.doesNotMatch(c.nextActionMeaning, /retries by itself/, code);
    }
  });

  it('anything short of a positive "running" counts as stopped', () => {
    for (const facts of [undefined, null, {}, { monitorRunning: 'yes' }, { monitorRunning: 1 }]) {
      assert.equal(d.classifyForSender('pane-turn-in-flight', facts).nextAction, 'investigate');
    }
  });

  it('still says whether the reason itself is one the table knows', () => {
    assert.equal(d.classifyForSender('pane-turn-in-flight', { monitorRunning: false }).known, true);
    assert.equal(d.classifyForSender('brand-new-gate', { monitorRunning: false }).known, false);
  });
});

describe('delivery disposition — the sender-facing answer uses the same classifier', () => {
  it('peerReachability from a stopped monitor says the monitor is not running and does not promise a retry', () => {
    const saved = { ...wake._internal };
    const wasRunning = wake.isRunning();
    try {
      wake.stop();
      wake._internal.listLiveAll = () => [{ id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' }];
      wake._internal.masterWakeRecord = () => null;
      wake._internal.getProject = () => ({ id: 10, name: 'proj-a', path: '/tmp/proj-a' });
      wake._internal.wrapRunning = () => true;
      wake._internal.getStatus = () => ({ state: 'listening', workspaceId: 'peer-ws', unread: 1, lastError: null });
      wake._internal.getMessages = () => [{ id: 'm1', from: 'x', message: 'hi' }];
      wake._internal.recordDelivery = () => {};
      wake._internal.recordWakeFacts = () => {};
      // A verdict the monitor would retry by itself, were it running.
      wake._internal.tick();
      const stale = wake.peerReachability('peer-ws');
      assert.equal(stale.reason, 'wrap-running');
      assert.equal(stale.monitorRunning, false);
      assert.deepEqual([stale.class, stale.nextAction], ['configuration', 'investigate']);
      assert.doesNotMatch(stale.nextActionMeaning, /retries by itself/);
      // The same verdict from a running monitor is one to wait out.
      wake.start({ intervalMs: 2 ** 30 });
      wake._internal.tick();
      const fresh = wake.peerReachability('peer-ws');
      assert.equal(fresh.monitorRunning, true);
      assert.deepEqual([fresh.reason, fresh.class, fresh.nextAction], ['wrap-running', 'actionable', 'wait']);
    } finally {
      wake.stop();
      Object.assign(wake._internal, saved);
      // Leave the singleton monitor as this test found it.
      if (wasRunning) wake.start({ intervalMs: 2 ** 30 });
    }
  });

  it('peerReachability carries the class and next action of its reason', () => {
    const saved = { ...wake._internal };
    const wasRunning = wake.isRunning();
    try {
      wake.stop();
      wake.start({ intervalMs: 2 ** 30 });
      wake._internal.listLiveAll = () => [{ id: 1, projectId: 10, sessionMode: 'tmux', tmuxSession: 'tc-1', engineId: 'claude' }];
      wake._internal.masterWakeRecord = () => null;
      wake._internal.getProject = () => ({ id: 10, name: 'proj-a', path: '/tmp/proj-a' });
      wake._internal.wrapRunning = () => false;
      wake._internal.rotationOpen = () => false;
      wake._internal.loadProjectConfig = () => ({ medusaWake: false });
      wake._internal.getStatus = () => ({ state: 'listening', workspaceId: 'peer-ws', unread: 1, lastError: null });
      wake._internal.getMessages = () => [{ id: 'm1', from: 'x', message: 'hi' }];
      wake._internal.recordDelivery = () => {};
      wake._internal.recordWakeFacts = () => {};
      const before = wake.peerReachability('peer-ws');
      assert.deepEqual([before.reason, before.class, before.nextAction], ['not-observed', 'actionable', 'wait']);
      wake._internal.tick();
      const got = wake.peerReachability('peer-ws');
      const expected = d.classifyReason('wake-not-opted-in');
      assert.equal(got.reason, 'wake-not-opted-in');
      assert.deepEqual([got.class, got.nextAction, got.nextActionMeaning], [expected.class, expected.nextAction, expected.nextActionMeaning]);
      assert.equal(got.class, 'configuration');
      assert.deepEqual(wake.verdictFor(1).reason, 'wake-not-opted-in');
      assert.equal(wake.verdictFor(999), null);
      assert.deepEqual(wake.peerReachability('nobody'), { workspaceId: 'nobody', local: false }, 'a peer this host cannot see gets no class');
    } finally {
      wake.stop();
      Object.assign(wake._internal, saved);
      // Leave the singleton monitor as this test found it.
      if (wasRunning) wake.start({ intervalMs: 2 ** 30 });
    }
  });
});

describe('medusa_deliveries retention boundaries (#1331)', () => {
  it('an orphan id that merely LOOKS like a real session id numerically does not dodge the global cap (CAST-to-INTEGER false match)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-retention-malformed-orphan-'));
    const proj = store.projects.create({ name: 'retention-malformed-orphan', path: dir, engine: 'claude' });
    const real = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'fake-retention-malformed' });
    store.medusaDeliveries._setRetention({ unattachedEndedRows: 0 });
    try {
      // SQLite's CAST(TEXT AS INTEGER) parses only the leading numeric
      // prefix, so '<real.id>junk' casts to the same integer as the real
      // session id — the same false match any of '042', '42junk' or '42.5'
      // would produce against a session id of 42. The sweep runs in the
      // same savepoint as the insert, so one record() call is enough to
      // prove the row never persists past this write.
      const malformed = `${real.id}junk`;
      store.medusaDeliveries.record({ sessionId: malformed, messageKey: 'bad1', channel: 'none', outcome: 'skipped', skipReason: 'x' });
      assert.equal(store.medusaDeliveries.listForSession(malformed).length, 0, 'the malformed id never matched the real session and was swept as an orphan');
    } finally {
      store.medusaDeliveries._setRetention({ unattachedEndedRows: 200 });
    }
  });

  it('recording a new delivery for an already-ended, over-quota session returns it without throwing, even though the sweep removes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-retention-insert-survives-sweep-'));
    const proj = store.projects.create({ name: 'retention-insert-survives-sweep', path: dir, engine: 'claude' });

    const old = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'fake-retention-old' });
    store.medusaDeliveries.record({ sessionId: old.id, messageKey: 'old-1', channel: 'none', outcome: 'skipped', skipReason: 'x' });
    store.sessions.kill(old.id, 'test: ends first, so it ranks behind the next session');

    store.medusaDeliveries._setRetention({ endedSessionsPerProject: 1, endedSessionRows: 1 });
    try {
      // A newer ended session outranks `old`, pushing it to rank 1 -- beyond
      // the quota of 1, so the full-delete tier applies to `old`.
      const newer = store.sessions.start({ projectId: proj.id, engineId: 'claude', tmuxSession: 'fake-retention-newer' });
      store.medusaDeliveries.record({ sessionId: newer.id, messageKey: 'newer-1', channel: 'none', outcome: 'skipped', skipReason: 'x' });
      store.sessions.kill(newer.id, 'test: ends after old, outranking it');

      // Recording a brand-new delivery for `old` triggers the very sweep
      // that now ranks it beyond quota. record() returns what it wrote even
      // when the sweep deletes that row again immediately after -- the
      // return value is a record of the write, not a promise the row still
      // exists, so a caller never has to re-read the row to get it back.
      const recorded = store.medusaDeliveries.record({ sessionId: old.id, projectId: proj.id, messageKey: 'old-2', channel: 'none', outcome: 'skipped', skipReason: 'y' });
      assert.equal(recorded.messageKey, 'old-2', 'the write succeeds and returns the row it just wrote, not undefined');
      assert.equal(store.medusaDeliveries.listForSession(old.id).length, 0, 'the sweep still removes every row of the over-quota session, including the one just written -- the returned object is a record of the write, not proof it persisted');
    } finally {
      store.medusaDeliveries._setRetention({ endedSessionsPerProject: 20, endedSessionRows: 10, unattachedEndedRows: 200 });
    }
  });
});
