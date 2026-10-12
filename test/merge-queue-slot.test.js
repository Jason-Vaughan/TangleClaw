'use strict';

// #2322: one call at a time per merge queue. A call that waits between reading
// an entry and writing it takes its queue's slot; a second such call is refused
// rather than run beside it, and the slot never outlives the call that took it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { withQueueSlot, isQueueSlotTaken, QueueSlotTaken, QUEUE_CALL_IN_FLIGHT } = require('../lib/merge-queue');

/**
 * A promise and the function that settles it.
 * @returns {{promise: Promise<*>, resolve: Function, reject: Function}}
 */
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

describe('the merge queue\'s slot (#2322)', () => {
  it('runs the call and answers what it returned, with the slot taken only while it runs', async () => {
    const seen = [];
    assert.equal(isQueueSlotTaken('mq_a'), false);
    const answer = await withQueueSlot('mq_a', async () => {
      seen.push(isQueueSlotTaken('mq_a'));
      return { done: true };
    });
    assert.deepEqual(answer, { done: true });
    assert.deepEqual(seen, [true]);
    assert.equal(isQueueSlotTaken('mq_a'), false);
    assert.equal(await withQueueSlot('mq_a', () => 7), 7, 'a call that is not async runs too');
  });

  it('refuses a second call on the same queue without running it, and takes it once the first has ended', async () => {
    const gate = deferred();
    const first = withQueueSlot('mq_a', () => gate.promise);
    let ran = false;
    await assert.rejects(() => withQueueSlot('mq_a', () => { ran = true; }), (err) => {
      assert.ok(err instanceof QueueSlotTaken);
      assert.equal(err.code, QUEUE_CALL_IN_FLIGHT);
      assert.equal(err.code, 'QUEUE_CALL_IN_FLIGHT');
      assert.equal(err.queueId, 'mq_a');
      assert.match(err.message, /Read `tc queue status`, then repeat\.$/);
      return true;
    });
    assert.equal(ran, false);
    assert.equal(isQueueSlotTaken('mq_a'), true, 'the refused call did not give the first call\'s slot back');
    gate.resolve('first');
    assert.equal(await first, 'first');
    await withQueueSlot('mq_a', () => { ran = true; });
    assert.equal(ran, true);
  });

  it('takes the slot before it first yields, so two calls started together cannot both run', async () => {
    const gate = deferred();
    const outcomes = await Promise.allSettled([
      withQueueSlot('mq_a', () => gate.promise),
      withQueueSlot('mq_a', () => 'second'),
      Promise.resolve().then(() => gate.resolve('first'))
    ]);
    assert.equal(outcomes[0].value, 'first');
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[1].reason.code, 'QUEUE_CALL_IN_FLIGHT');
  });

  it('gives the slot back after a call that threw, that rejected, and that threw before its first await', async () => {
    await assert.rejects(() => withQueueSlot('mq_a', async () => { await null; throw new Error('late'); }), /late/);
    assert.equal(isQueueSlotTaken('mq_a'), false);
    await assert.rejects(() => withQueueSlot('mq_a', () => Promise.reject(new Error('rejected'))), /rejected/);
    assert.equal(isQueueSlotTaken('mq_a'), false);
    await assert.rejects(() => withQueueSlot('mq_a', () => { throw new Error('at once'); }), /at once/);
    assert.equal(isQueueSlotTaken('mq_a'), false);
    assert.equal(await withQueueSlot('mq_a', () => 'free again'), 'free again');
  });

  it('two queues do not block each other', async () => {
    const gate = deferred();
    const a = withQueueSlot('mq_a', () => gate.promise);
    assert.equal(await withQueueSlot('mq_b', () => 'b ran'), 'b ran');
    assert.equal(isQueueSlotTaken('mq_a'), true);
    assert.equal(isQueueSlotTaken('mq_b'), false);
    gate.resolve();
    await a;
  });

  it('refuses a queue id that is not one, without running the call or taking anything', async () => {
    for (const id of [undefined, null, '', 7, {}]) {
      let ran = false;
      await assert.rejects(() => withQueueSlot(id, () => { ran = true; }), TypeError);
      assert.equal(ran, false);
    }
  });
});
