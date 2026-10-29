'use strict';

/*
 * Exactly-once wakes and restart safety, proven on the real exchange record (#2086).
 *
 * Every other wake test either stands in for the exchange record or writes its
 * wake facts by hand. Here the real wake monitor, the real
 * `lib/medusa-exchanges.js` and the real delivery watchdog run together
 * against a scratch store on disk.
 *
 * Each `phase` is one server lifetime in its own process
 * (`test/helpers/medusa-proof-phase.js`). A restart is the next phase on the
 * same directory: a new process, new module instances, the same database
 * file. Nothing in memory crosses it, so whatever stops a second nudge or a
 * second notice after a restart is something that was written down.
 *
 * What is carried between phases by this file is only what lies outside the
 * server and really does outlive it: the time, the pane, and the recipient's
 * inbox (the Hub redelivers mail that was not marked handled).
 *
 * Assertions are on the durable record (fact counts, nonces, ledger rows) as
 * well as on what was typed and sent, so each claim is attributable to
 * persisted state.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PHASE = path.join(__dirname, 'helpers', 'medusa-proof-phase.js');
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-04T12:00:00.000Z');

let base;
let world;
let lifetimes;

/**
 * Run one server lifetime over the scratch store and return what it saw.
 * @param {object[]} steps - Steps for `medusa-proof-phase.js`
 * @param {object} [outside] - Changes to the outside world before it starts
 * @returns {{injected: object[], notices: object[], durable: object}}
 */
function phase(steps, outside = {}) {
  const run = spawnSync(process.execPath, [PHASE, JSON.stringify({ basePath: base, ...world, ...outside, steps })], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  world = out.world;
  lifetimes += 1;
  return out;
}

/** The exchange for a Hub id, from a phase's durable snapshot. */
const exchange = (out, hubId) => out.durable.exchanges.find((x) => x.hubId === hubId);
/** An exchange's facts of one kind. */
const factsOf = (x, fact) => x.facts.filter((f) => f.fact === fact);
/** The nonces of an exchange's attempts, in order. */
const attemptNonces = (x) => factsOf(x, 'wake_attempted').map((f) => f.nonce);
/** Ledger rows that record a nudge. */
const nudges = (out) => out.durable.ledger.filter((l) => l.outcome === 'nudged');

describe('wakes on the real exchange record (#2086)', () => {
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-2086-proof-'));
    world = { now: T0 };
    lifetimes = 0;
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('an eligible recipient is woken exactly once', () => {
    it('one nudge, one recorded attempt and one nonce, however many ticks follow', () => {
      const out = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 12 }]);
      assert.equal(out.injected.length, 1);
      const x = exchange(out, 'h1');
      assert.equal(x.state, 'wake_attempted');
      assert.equal(attemptNonces(x).length, 1);
      assert.match(attemptNonces(x)[0], /^[0-9a-f]{12}$/);
      assert.ok(out.injected[0].command.includes(attemptNonces(x)[0]), 'the nonce typed is the nonce recorded');
      assert.equal(nudges(out).length, 1);
    });

    it('a restart sends no second nudge: the attempt on record is what stops it', () => {
      const first = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }]);
      const nonce = attemptNonces(exchange(first, 'h1'))[0];
      for (let i = 0; i < 3; i++) {
        const next = phase([{ op: 'ticks', n: 8 }]);
        assert.equal(next.injected.length, 0, `lifetime ${lifetimes}`);
        assert.deepEqual(attemptNonces(exchange(next, 'h1')), [nonce]);
        assert.equal(nudges(next).length, 1);
      }
    });

    it('time alone never re-arms a nudge with no receipt, across a restart or not', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }]);
      const later = phase([{ op: 'advance', ms: 20 * MIN }, { op: 'watchdog' }, { op: 'ticks', n: 4 }, { op: 'watchdog' }]);
      assert.equal(later.injected.length, 0);
      const x = exchange(later, 'h1');
      assert.deepEqual([x.rearmCount, factsOf(x, 'rearmed').length, attemptNonces(x).length], [0, 0, 1]);
    });

    it('mail that arrives after a nudge gets its own, and is not marked by the earlier receipt', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }], { receipt: 'not-accepted' });
      const arrived = phase([{ op: 'send', hubId: 'h2' }], { receipt: 'unknown' });
      assert.deepEqual(exchange(arrived, 'h2').facts.filter((f) => f.fact.startsWith('wake_')), [], 'the miss belongs to the nudge that came before it');
      const first = attemptNonces(exchange(arrived, 'h1'))[0];
      // A restart later, the new mail is still nudged, once.
      const woken = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(woken.injected.length, 1);
      const second = attemptNonces(exchange(woken, 'h2'))[0];
      assert.notEqual(second, first);
      assert.deepEqual(attemptNonces(exchange(woken, 'h1')), [first, second], 'one nudge names no message, so it concerns both');
      assert.deepEqual(attemptNonces(exchange(woken, 'h2')), [second]);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 0);
    });
  });

  describe('a receipt is about the nudge it names', () => {
    it('a late miss for an earlier nudge marks nothing once a newer nudge has gone out', () => {
      const out = phase([
        { op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 },
        { op: 'send', hubId: 'h2' }, { op: 'ticks', n: 4 },
        { op: 'answerReceipt', outcome: 'not-accepted' }
      ], { receipt: 'deferred' });
      assert.equal(out.injected.length, 2);
      const [first, second] = attemptNonces(exchange(out, 'h1'));
      assert.deepEqual(attemptNonces(exchange(out, 'h2')), [second]);
      assert.notEqual(first, second);
      for (const hubId of ['h1', 'h2']) {
        assert.equal(factsOf(exchange(out, hubId), 'wake_not_accepted').length, 0, `${hubId}: the miss was for a nudge that is no longer its newest`);
        assert.equal(exchange(out, hubId).state, 'wake_attempted');
      }
      // So nothing is re-armed on the strength of it, in this lifetime or the next.
      const later = phase([{ op: 'advance', ms: 10 * MIN }, { op: 'watchdog' }, { op: 'ticks', n: 4 }], { receipt: 'unknown' });
      assert.equal(later.injected.length, 0);
      assert.equal(exchange(later, 'h1').rearmCount, 0);
    });

    it('a miss for the newest nudge marks every message that nudge was about', () => {
      const out = phase([
        { op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'send', hubId: 'h2' }, { op: 'ticks', n: 4 },
        { op: 'answerReceipt', outcome: 'not-accepted' }
      ], { receipt: 'deferred' });
      const nonce = attemptNonces(exchange(out, 'h1'))[0];
      for (const hubId of ['h1', 'h2']) {
        assert.deepEqual(factsOf(exchange(out, hubId), 'wake_not_accepted').map((f) => f.nonce), [nonce]);
      }
    });
  });

  describe('a nudge that provably missed is retried within a budget that survives restarts', () => {
    it('one re-arm per miss, however many watchdog passes and restarts see it', () => {
      const missed = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }], { receipt: 'not-accepted' });
      const x0 = exchange(missed, 'h1');
      assert.equal(factsOf(x0, 'wake_not_accepted')[0].nonce, attemptNonces(x0)[0], 'the miss names the attempt it is about');
      // #2716: the re-arm itself (a durable store write, not the wake
      // monitor's own later scan) now runs immediately inside THIS phase,
      // right after the receipt is recorded -- not left waiting for a
      // separate watchdog pass, which is why the exchange has already
      // moved past `wake_not_accepted` by the time this phase returns.
      assert.notEqual(x0.state, 'wake_not_accepted', 'already re-armed immediately, not left waiting for a watchdog pass');
      assert.deepEqual([x0.rearmCount, factsOf(x0, 'rearmed').length], [1, 1]);
      assert.equal(factsOf(x0, 'rearmed')[0].code, 'not-accepted');

      // Further watchdog passes, mid-backoff, find it already armed and re-arm nothing more.
      const armed = phase([{ op: 'watchdog' }, { op: 'watchdog' }]);
      assert.deepEqual([exchange(armed, 'h1').rearmCount, factsOf(exchange(armed, 'h1'), 'rearmed').length], [1, 1]);
      const again = phase([{ op: 'watchdog' }, { op: 'watchdog' }]);
      assert.deepEqual([exchange(again, 'h1').rearmCount, factsOf(exchange(again, 'h1'), 'rearmed').length], [1, 1]);
      assert.equal(exchange(again, 'h1').nextEligibleAt, x0.nextEligibleAt, 'the backoff is on record from the immediate re-arm');

      const retried = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(retried.injected.length, 1, 'the re-arm buys exactly one more nudge');
      const nonces = attemptNonces(exchange(retried, 'h1'));
      assert.equal(nonces.length, 2);
      assert.notEqual(nonces[0], nonces[1]);

      // The second miss is on record at once, but its re-arm waits out the backoff.
      const early = phase([{ op: 'watchdog' }, { op: 'ticks', n: 4 }]);
      assert.equal(early.injected.length, 0);
      assert.equal(exchange(early, 'h1').rearmCount, 1);
    });

    it('the budget is spent across restarts, never reset by one, and the operator is told once', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }], { receipt: 'not-accepted' });
      let typed = 1;
      let last;
      for (let i = 0; i < 8; i++) {
        last = phase([{ op: 'advance', ms: 40 * MIN }, { op: 'watchdog' }, { op: 'ticks', n: 4 }]);
        typed += last.injected.length;
      }
      const x = exchange(last, 'h1');
      assert.equal(typed, 4, 'the first nudge and three re-arms');
      assert.deepEqual([x.rearmCount, factsOf(x, 'rearmed').length, new Set(attemptNonces(x)).size], [3, 3, 4]);
      assert.equal(nudges(last).length, 4);
      assert.equal(factsOf(x, 'aged').length, 1);
      // Told once, at the hour, while a re-arm was still pending: the alert keeps what was true then.
      assert.deepEqual(factsOf(x, 'operator_alerted').map((f) => f.code), ['prolonged-actionable']);
      assert.equal(last.durable.activity.length, 1);
    });
  });

  describe('a held wake survives a restart and is still delivered', () => {
    it('a busy recipient is not nudged, the hold is recorded once, and it is woken when it comes to rest', () => {
      const held = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 8 }], { pane: 'busy' });
      assert.equal(held.injected.length, 0);
      assert.deepEqual(factsOf(exchange(held, 'h1'), 'wake_blocked').map((f) => f.code), ['pane-turn-in-flight']);

      const still = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(still.injected.length, 0);
      assert.equal(factsOf(exchange(still, 'h1'), 'wake_blocked').length, 1, 'an unchanged hold is not recorded again after a restart');

      const woken = phase([{ op: 'ticks', n: 6 }], { pane: 'idle' });
      assert.equal(woken.injected.length, 1);
      assert.equal(attemptNonces(exchange(woken, 'h1')).length, 1);
      assert.equal(phase([{ op: 'ticks', n: 6 }]).injected.length, 0);
    });

    it('nudged, then busy, then at rest again: the record says already nudged, and one re-arm follows the readiness change', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }]);
      phase([{ op: 'ticks', n: 4 }], { pane: 'busy' });
      const rested = phase([{ op: 'ticks', n: 4 }], { pane: 'idle' });
      assert.equal(rested.injected.length, 0);
      const x = exchange(rested, 'h1');
      assert.deepEqual([x.state, x.wakeCode], ['wake_pending', 'awaiting-read'], 'written by the monitor itself');
      assert.equal(factsOf(x, 'readiness_changed').length, 1);

      const rearmed = phase([{ op: 'advance', ms: 4 * MIN }, { op: 'watchdog' }, { op: 'watchdog' }, { op: 'ticks', n: 4 }]);
      assert.equal(rearmed.injected.length, 1);
      assert.deepEqual([exchange(rearmed, 'h1').rearmCount, attemptNonces(exchange(rearmed, 'h1')).length], [1, 2]);

      const aged = phase([{ op: 'advance', ms: 30 * MIN }, { op: 'watchdog' }]);
      assert.deepEqual(aged.notices.map((n) => [n.body.level, n.body.class, n.body.condition]), [['aged', 'none', 'unread']]);
    });
  });

  describe('notices and alerts are sent once, across restarts', () => {
    it('the aged notice and the operator alert are each one fact, and a restarted watchdog repeats neither', () => {
      const aged = phase([
        { op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'advance', ms: 30 * MIN }, { op: 'watchdog' }
      ], { pane: 'busy' });
      assert.deepEqual(aged.notices.map((n) => [n.body.level, n.body.blocker, n.body.class]), [['aged', 'pane-turn-in-flight', 'actionable']]);

      const restarted = phase([{ op: 'watchdog' }, { op: 'watchdog' }]);
      assert.equal(restarted.notices.length, 0);
      assert.equal(factsOf(exchange(restarted, 'h1'), 'aged').length, 1);

      const alerted = phase([{ op: 'advance', ms: 30 * MIN }, { op: 'watchdog' }]);
      assert.deepEqual(factsOf(exchange(alerted, 'h1'), 'operator_alerted').map((f) => f.code), ['prolonged-actionable']);
      assert.equal(alerted.durable.activity.length, 1);

      const after = phase([{ op: 'watchdog' }, { op: 'advance', ms: 24 * 60 * MIN }, { op: 'watchdog' }]);
      assert.equal(after.notices.length, 0);
      assert.equal(factsOf(exchange(after, 'h1'), 'operator_alerted').length, 1);
      assert.equal(after.durable.activity.length, 1);
      assert.equal(after.injected.length, 0);
    });

    it('acknowledged and owed a reply: tracked through a restart, told once as unanswered', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1', body: { replyRequired: true } }, { op: 'ticks', n: 4 }]);
      const acked = phase([
        { op: 'read', hubIds: ['h1'] }, { op: 'ack', hubIds: ['h1'] }, { op: 'ticks', n: 4 }, { op: 'advance', ms: 31 * MIN }, { op: 'watchdog' }
      ]);
      assert.equal(acked.injected.length, 0, 'handled mail is never nudged');
      assert.deepEqual(acked.notices.map((n) => [n.body.level, n.body.condition, n.body.class]), [['aged', 'unanswered', 'none']]);

      const later = phase([{ op: 'watchdog' }, { op: 'advance', ms: 31 * MIN }, { op: 'watchdog' }, { op: 'ticks', n: 4 }]);
      assert.equal(later.notices.length, 0);
      assert.equal(later.injected.length, 0);
      const x = exchange(later, 'h1');
      assert.deepEqual(factsOf(x, 'operator_alerted').map((f) => f.code), ['prolonged-unanswered']);
      assert.equal(attemptNonces(x).length, 1);
    });
  });

  describe('mail that was fetched but not marked handled', () => {
    it('is not nudged again in the same lifetime', () => {
      const out = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }, { op: 'ticks', n: 8 }]);
      assert.equal(out.injected.length, 1);
      assert.equal(exchange(out, 'h1').state, 'read');
    });

    // The Hub redelivers mail that was never marked handled, so after a restart
    // the listener counts it unread again while the record says it was read.
    // A restart is not a miss and not a readiness change.
    it('is not nudged again by a restart, however many there are', () => {
      const first = phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }]);
      const nonce = attemptNonces(exchange(first, 'h1'));
      for (let i = 0; i < 4; i++) {
        const restarted = phase([{ op: 'ticks', n: 8 }]);
        assert.equal(restarted.injected.length, 0, `lifetime ${lifetimes}`);
        assert.equal(nudges(restarted).length, 1);
        assert.deepEqual(attemptNonces(exchange(restarted, 'h1')), nonce);
        assert.equal(exchange(restarted, 'h1').rearmCount, 0);
      }
    });

    // The other order: fetched before any nudge was recorded on it (read while
    // the pane was busy, or in the same inbox read an earlier nudge prompted).
    // It has a read on record and no attempt, and a restart is still no reason.
    it('fetched before it was ever nudged: no restart nudges it, and no attempt is ever recorded', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'read', hubIds: ['h1'] }]);
      for (let i = 0; i < 4; i++) {
        const restarted = phase([{ op: 'ticks', n: 8 }]);
        assert.equal(restarted.injected.length, 0, `lifetime ${lifetimes}`);
        assert.equal(nudges(restarted).length, 0);
        const x = exchange(restarted, 'h1');
        assert.deepEqual([x.state, attemptNonces(x).length, x.rearmCount], ['read', 0, 0]);
      }
    });

    it('fetched before it was ever nudged, then new mail: the new message is nudged once and only it records the attempt', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'read', hubIds: ['h1'] }]);
      phase([{ op: 'send', hubId: 'h2' }]);
      const woken = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(woken.injected.length, 1);
      assert.equal(attemptNonces(exchange(woken, 'h2')).length, 1);
      assert.equal(attemptNonces(exchange(woken, 'h1')).length, 0);
      for (let i = 0; i < 2; i++) {
        const restarted = phase([{ op: 'ticks', n: 8 }]);
        assert.equal(restarted.injected.length, 0);
        assert.equal(nudges(restarted).length, 1);
      }
    });

    it('the record is asked by the body\'s `id`, which is what it is keyed on, whatever `messageId` the body carries', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }], { envelopeIds: true });
      for (let i = 0; i < 2; i++) assert.equal(phase([{ op: 'ticks', n: 8 }], { envelopeIds: true }).injected.length, 0);
    });

    it('redelivered and fetched again after a restart, it is still one arrival and one read on record', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }]);
      const again = phase([{ op: 'redeliver', hubIds: ['h1'] }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }, { op: 'ticks', n: 4 }]);
      const x = exchange(again, 'h1');
      assert.deepEqual([factsOf(x, 'arrived').length, factsOf(x, 'read').length, attemptNonces(x).length], [1, 1, 1]);
      assert.equal(again.injected.length, 0);
      assert.equal(again.durable.exchanges.length, 1, 'a redelivery opens no second exchange');
    });

    it('does not hide new mail: old fetched mail and one new message get exactly one new nudge', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }]);
      phase([{ op: 'send', hubId: 'h2' }]);
      const woken = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(woken.injected.length, 1);
      assert.equal(attemptNonces(exchange(woken, 'h2')).length, 1);
      assert.equal(attemptNonces(exchange(woken, 'h1')).length, 1, 'the fetched message gains nothing');
      for (let i = 0; i < 2; i++) assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 0);
    });

    it('several old and several new: one nudge covers the new ones, and restarts add none', () => {
      phase([
        { op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'send', hubId: 'h2' }, { op: 'ticks', n: 4 },
        { op: 'read', hubIds: ['h1', 'h2'] }
      ]);
      const arrived = phase([{ op: 'send', hubId: 'h3' }, { op: 'send', hubId: 'h4' }]);
      assert.equal(arrived.injected.length, 0);
      const woken = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(woken.injected.length, 1);
      const nonce = attemptNonces(exchange(woken, 'h3'));
      assert.equal(nonce.length, 1);
      assert.deepEqual(attemptNonces(exchange(woken, 'h4')), nonce);
      assert.equal(nudges(woken).length, 2);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 0);
    });

    it('handled mail is not counted in: after old mail is acknowledged or answered, new mail is still nudged after a restart', () => {
      phase([
        { op: 'setup' }, { op: 'send', hubId: 'h1', body: { replyRequired: true } }, { op: 'send', hubId: 'h2' }, { op: 'ticks', n: 4 },
        { op: 'read', hubIds: ['h1', 'h2'] }, { op: 'ack', hubIds: ['h1', 'h2'] }
      ]);
      phase([{ op: 'send', hubId: 'h3' }]);
      const woken = phase([{ op: 'ticks', n: 8 }]);
      assert.equal(woken.injected.length, 1, 'two handled exchanges do not account for one new message');
      assert.equal(attemptNonces(exchange(woken, 'h3')).length, 1);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 0);
    });
  });

  describe('mail the record cannot vouch for fails conservative: it is treated as not yet nudged', () => {
    it('an untracked message beside owned mail is nudged after a restart', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }]);
      phase([{ op: 'sendUntracked', hubId: 'u1' }]);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 1);
    });

    it('a message with no exchange record beside owned mail is nudged after a restart', () => {
      phase([{ op: 'setup' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 }, { op: 'read', hubIds: ['h1'] }]);
      phase([{ op: 'deliverUnrecorded', hubId: 'system-1' }]);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 1);
    });

    it('wherever it sits in the inbox: every message is asked about, not only the newest', () => {
      phase([
        { op: 'setup' }, { op: 'deliverUnrecorded', hubId: 'system-1' }, { op: 'send', hubId: 'h1' }, { op: 'ticks', n: 4 },
        { op: 'read', hubIds: ['h1'] }
      ]);
      assert.equal(phase([{ op: 'ticks', n: 8 }]).injected.length, 1, 'the newest message is owned; the older one cannot be vouched for');
    });
  });
});
