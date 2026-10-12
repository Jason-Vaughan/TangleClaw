'use strict';

/**
 * One call at a time per merge queue.
 *
 * A call that reads an entry's state, waits on GitHub and then writes can be
 * overtaken by another call on the same queue: an entry could gain a candidate
 * while a withdrawal is deciding it has none, and leave the queue with both
 * branches still on GitHub. So a call that waits between reading and writing
 * takes its queue's slot for as long as it runs, and a second such call is
 * refused rather than queued behind it: the caller reads the queue and decides
 * again on what it then says.
 *
 * The slot is held in this process's memory. One server process serves an
 * install, and a restart frees every slot, which is safe because each call that
 * takes one is harmless to repeat.
 *
 * @module lib/merge-queue
 */

/** The code of the refusal a call gets when its queue's slot is taken. */
const QUEUE_CALL_IN_FLIGHT = 'QUEUE_CALL_IN_FLIGHT';

/** The queue ids whose slot is taken now. */
const _taken = new Set();

/** The refusal of a call that found its queue's slot taken. */
class QueueSlotTaken extends Error {
  /**
   * @param {string} queueId - The queue whose slot is taken
   */
  constructor(queueId) {
    super('Another advance or withdrawal of this queue is running. Read `tc queue status`, then repeat.');
    this.name = 'QueueSlotTaken';
    this.code = QUEUE_CALL_IN_FLIGHT;
    this.queueId = queueId;
  }
}

/**
 * Run `fn` holding the slot of one queue. The slot is taken before this
 * function first yields and is given back when `fn` ends, whether it returned,
 * refused or threw.
 * @param {string} queueId - The queue's id
 * @param {() => (Promise<*>|*)} fn - The call to run inside the slot
 * @returns {Promise<*>} What `fn` returned
 * @throws {QueueSlotTaken} When another call holds this queue's slot; `fn` is not run
 * @throws {TypeError} When `queueId` is not a non-empty string; `fn` is not run
 */
async function withQueueSlot(queueId, fn) {
  if (typeof queueId !== 'string' || !queueId) throw new TypeError('withQueueSlot needs the queue\'s id');
  if (_taken.has(queueId)) throw new QueueSlotTaken(queueId);
  _taken.add(queueId);
  try {
    return await fn();
  } finally {
    _taken.delete(queueId);
  }
}

/**
 * Whether a queue's slot is taken now.
 * @param {string} queueId - The queue's id
 * @returns {boolean}
 */
function isQueueSlotTaken(queueId) {
  return _taken.has(queueId);
}

module.exports = {
  QUEUE_CALL_IN_FLIGHT,
  QueueSlotTaken,
  withQueueSlot,
  isQueueSlotTaken
};
