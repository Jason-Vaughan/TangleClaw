'use strict';

// #2323: what a check watch can say. The lists are pinned because the stored
// CHECKs are built from them: changing one without a schema number and a table
// rebuild leaves a database that refuses what the code writes. `derive` is
// tested over every combination of result, last read, due time and
// cancellation, because its one promise is about combinations: no record, no
// verdict.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../lib/check-watch-state');
const { CONCLUSIONS } = require('../lib/github-checks');

const NOW = '2026-10-12T06:00:00.000Z';
const BEFORE = '2026-10-12T05:00:00.000Z';
const AFTER = '2026-10-12T07:00:00.000Z';

/**
 * A watch as the store returns it.
 * @param {object} [fields] - Fields to change
 * @returns {object}
 */
function watch(fields = {}) {
  return {
    watchId: 'cw_1', projectId: 7, registeredBy: { sessionId: 1, launchId: 'launch' }, repo: 'o/r', prNumber: 1,
    headSha: 'a'.repeat(40), checkName: 'test', dueAt: AFTER, registeredAt: BEFORE,
    result: null, lastRead: null, cancelled: null, expired: null, ...fields
  };
}

/**
 * A recorded result.
 * @param {string} conclusion - The conclusion
 * @returns {object}
 */
function result(conclusion) {
  return { conclusion, runId: '9', completedAt: BEFORE, readAt: BEFORE };
}

describe('check-watch-state: the stored vocabulary (#2323)', () => {
  it('the fact kinds, the once-only kinds, the sent kinds and the read outcomes are exactly these', () => {
    assert.deepEqual(state.FACT_KINDS, [
      'registered', 'read-failed', 'read-recovered', 'resolved',
      'woke', 'wake-undeliverable', 'alarmed', 'alarm-undeliverable', 'cancelled', 'expired'
    ]);
    assert.deepEqual(state.ONCE_ONLY_KINDS, [
      'registered', 'resolved', 'woke', 'wake-undeliverable', 'alarmed', 'alarm-undeliverable', 'cancelled', 'expired'
    ]);
    assert.deepEqual(state.SENT_KINDS, ['woke', 'alarmed']);
    assert.deepEqual(state.READ_OUTCOMES, ['ok', 'failed']);
    assert.deepEqual(state.STATES, ['waiting', 'ready', 'failed', 'unknown']);
    assert.deepEqual(state.MESSAGE_KINDS, ['wake', 'alarm']);
  });

  it('every once-only and sent kind is a fact kind, and only the two read kinds repeat', () => {
    for (const kind of [...state.ONCE_ONLY_KINDS, ...state.SENT_KINDS]) assert.ok(state.FACT_KINDS.includes(kind), kind);
    assert.deepEqual(state.FACT_KINDS.filter((k) => !state.ONCE_ONLY_KINDS.includes(k)), ['read-failed', 'read-recovered']);
  });

  it('the lists cannot be changed by a caller', () => {
    for (const list of [state.FACT_KINDS, state.ONCE_ONLY_KINDS, state.SENT_KINDS, state.READ_OUTCOMES, state.STATES, state.MESSAGE_KINDS]) {
      assert.throws(() => list.push('x'), TypeError);
    }
    assert.throws(() => { state.REFUSALS.NEW = 'x'; }, TypeError);
  });

  it('the limits are the ones ruled: 20 open watches a project, a due time at most 24 hours ahead', () => {
    assert.equal(state.MAX_OPEN_PER_PROJECT, 20);
    assert.equal(state.MAX_DUE_AHEAD_MS, 24 * 60 * 60 * 1000);
    assert.equal(state.MAX_CHECK_NAME, 100);
  });

  it('every refusal has its own code', () => {
    const codes = Object.values(state.REFUSALS);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^CHECK_WATCH_[A-Z_]+$/);
  });
});

describe('check-watch-state: requestIdFor (#2323)', () => {
  // The shape `lib/medusa-exchanges.js` accepts for a send's request id.
  const SWITCHBOARD_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

  it('is made from the watch id and the message kind alone, so a retry builds the same id', () => {
    assert.equal(state.requestIdFor('cw_0123abcd', 'wake'), 'check-watch:wake:cw_0123abcd');
    assert.equal(state.requestIdFor('cw_0123abcd', 'alarm'), 'check-watch:alarm:cw_0123abcd');
    assert.equal(state.requestIdFor('cw_0123abcd', 'wake'), state.requestIdFor('cw_0123abcd', 'wake'));
  });

  it('a watch\'s wake and its alarm have different ids, and so do two watches', () => {
    const ids = [
      state.requestIdFor('cw_a', 'wake'), state.requestIdFor('cw_a', 'alarm'),
      state.requestIdFor('cw_b', 'wake'), state.requestIdFor('cw_b', 'alarm')
    ];
    assert.equal(new Set(ids).size, 4);
    for (const id of ids) assert.ok(id.startsWith(state.REQUEST_ID_PREFIX), id);
  });

  it('the longest watch id the table holds still gives an id the switchboard accepts', () => {
    for (const kind of state.MESSAGE_KINDS) {
      const id = state.requestIdFor('w'.repeat(64), kind);
      assert.match(id, SWITCHBOARD_REQUEST_ID);
    }
    assert.match(state.requestIdFor('cw_A-9_z', 'wake'), SWITCHBOARD_REQUEST_ID);
  });

  it('refuses anything that is not a watch id or a message a watch sends, rather than make an id from it', () => {
    for (const id of [undefined, null, '', 7, 'cw 1', 'cw:1', 'cw.1', 'cw/1', 'w'.repeat(65)]) {
      assert.throws(() => state.requestIdFor(id, 'wake'), /watch id/, String(id));
    }
    for (const kind of [undefined, 'woke', 'alarmed', 'resolved', 'WAKE', '']) {
      assert.throws(() => state.requestIdFor('cw_1', kind), /wake or alarm/, String(kind));
    }
  });
});

describe('check-watch-state: derive (#2323)', () => {
  const RESULTS = [null, ...CONCLUSIONS];
  const LAST_READS = [
    null,
    { at: BEFORE, outcome: 'ok', detail: null },
    { at: BEFORE, outcome: 'failed', detail: 'gh api timed out after 10000ms' }
  ];
  const DUES = [AFTER, NOW, BEFORE];
  const CANCELLATIONS = [null, { at: BEFORE, projectId: 7, launchId: 'launch' }];
  const EXPIRED = { at: NOW };

  it('every combination of result, last read, due time and cancellation gives exactly the state the record supports', () => {
    let combinations = 0;
    for (const conclusion of RESULTS) {
      for (const lastRead of LAST_READS) {
        for (const dueAt of DUES) {
          for (const cancelled of CANCELLATIONS) {
            combinations++;
            const w = watch({ result: conclusion ? result(conclusion) : null, lastRead, dueAt, cancelled });
            const got = state.derive(w, NOW);
            const label = JSON.stringify({ conclusion, lastRead: lastRead && lastRead.outcome, dueAt, cancelled: Boolean(cancelled) });
            assert.ok(state.STATES.includes(got.state), label);
            if (conclusion) {
              assert.deepEqual(got, { state: conclusion === 'success' ? 'ready' : 'failed', reasons: [] }, label);
              continue;
            }
            const reasons = [];
            if (cancelled) reasons.push('cancelled');
            if (dueAt !== AFTER) reasons.push('past-due');
            if (lastRead && lastRead.outcome === 'failed') reasons.push('read-failed');
            assert.deepEqual(got, { state: reasons.length ? 'unknown' : 'waiting', reasons }, label);
          }
        }
      }
    }
    assert.equal(combinations, RESULTS.length * LAST_READS.length * DUES.length * CANCELLATIONS.length);
  });

  it('never says ready or failed without a recorded result, whatever else the record holds', () => {
    for (const lastRead of LAST_READS) {
      for (const dueAt of DUES) {
        for (const cancelled of CANCELLATIONS) {
          for (const noResult of [null, undefined, {}, { conclusion: null }, { conclusion: '' }, { conclusion: 7 }, { runId: '9' }]) {
            const got = state.derive(watch({ result: noResult, lastRead, dueAt, cancelled }), NOW);
            assert.ok(got.state === 'waiting' || got.state === 'unknown', JSON.stringify({ noResult, got }));
          }
        }
      }
    }
  });

  it('unknown is its own state: it is never reported as failed or as ready', () => {
    const unknowns = [
      watch({ dueAt: BEFORE }),
      watch({ lastRead: LAST_READS[2] }),
      watch({ cancelled: CANCELLATIONS[1] }),
      watch({ dueAt: BEFORE, expired: EXPIRED }),
      watch({ dueAt: BEFORE, lastRead: LAST_READS[2], cancelled: CANCELLATIONS[1], expired: EXPIRED })
    ];
    for (const w of unknowns) {
      const got = state.derive(w, NOW);
      assert.equal(got.state, 'unknown');
      assert.notEqual(got.state, 'failed');
      assert.notEqual(got.state, 'ready');
      assert.ok(got.reasons.length >= 1);
    }
    assert.deepEqual(state.derive(unknowns[4], NOW).reasons, ['cancelled', 'expired', 'past-due', 'read-failed']);
  });

  it('says which of the two it is: GitHub could not be read, or the due time passed', () => {
    assert.deepEqual(state.derive(watch({ lastRead: LAST_READS[2] }), NOW), { state: 'unknown', reasons: ['read-failed'] });
    assert.deepEqual(state.derive(watch({ dueAt: BEFORE, lastRead: LAST_READS[1] }), NOW), { state: 'unknown', reasons: ['past-due'] });
  });

  it('an expired watch is unknown with the expired reason, for every last read: never failed, never ready, never waiting', () => {
    for (const lastRead of LAST_READS) {
      for (const cancelled of CANCELLATIONS) {
        const got = state.derive(watch({ dueAt: BEFORE, lastRead, cancelled, expired: EXPIRED }), NOW);
        assert.equal(got.state, 'unknown');
        assert.ok(got.reasons.includes('expired'), JSON.stringify(got));
        assert.ok(got.reasons.includes('past-due'), JSON.stringify(got));
      }
    }
    // Even with a due time that somehow reads as ahead, expiry alone is enough.
    assert.deepEqual(state.derive(watch({ expired: EXPIRED }), NOW), { state: 'unknown', reasons: ['expired'] });
  });

  it('a watch is waiting up to its due time and unknown from that instant', () => {
    const due = '2026-10-12T06:00:00.000Z';
    assert.equal(state.derive(watch({ dueAt: due }), '2026-10-12T05:59:59.999Z').state, 'waiting');
    assert.equal(state.derive(watch({ dueAt: due }), due).state, 'unknown');
    assert.equal(state.derive(watch({ dueAt: due }), '2026-10-12T06:00:00.001Z').state, 'unknown');
  });

  it('takes the time now as a string, a Date or milliseconds, and reads the same', () => {
    for (const now of [NOW, new Date(NOW), Date.parse(NOW)]) {
      assert.equal(state.derive(watch(), now).state, 'waiting');
      assert.equal(state.derive(watch({ dueAt: BEFORE }), now).state, 'unknown');
    }
  });

  it('a result recorded before a cancellation or a due time stands', () => {
    const w = watch({ result: result('success'), dueAt: BEFORE, cancelled: CANCELLATIONS[1], lastRead: LAST_READS[2] });
    assert.deepEqual(state.derive(w, NOW), { state: 'ready', reasons: [] });
  });

  it('a record or a time it cannot make sense of is unknown and says unreadable: not waiting, and not a due time that passed', () => {
    const unreadable = { state: 'unknown', reasons: ['unreadable'] };
    for (const w of [null, undefined, watch({ dueAt: null }), watch({ dueAt: 'soon' }), watch({ dueAt: undefined })]) {
      assert.deepEqual(state.derive(w, NOW), unreadable);
    }
    for (const now of [undefined, null, 'now', NaN, {}]) {
      assert.deepEqual(state.derive(watch(), now), unreadable, String(now));
    }
    assert.deepEqual(state.derive(watch({ lastRead: { at: BEFORE, outcome: 'maybe', detail: null } }), NOW), unreadable);
    // What can still be read is still said beside it.
    assert.deepEqual(state.derive(watch({ dueAt: 'soon', cancelled: CANCELLATIONS[1], lastRead: LAST_READS[2] }), NOW).reasons, ['cancelled', 'read-failed', 'unreadable']);
  });

  it('the name limit a watch is stored under is the one the reader accepts', () => {
    assert.equal(state.MAX_CHECK_NAME, require('../lib/github-checks').MAX_CHECK_NAME);
  });

  it('reads nothing but its arguments and changes neither', () => {
    const w = Object.freeze(watch({ lastRead: Object.freeze({ at: BEFORE, outcome: 'ok', detail: null }) }));
    assert.deepEqual(state.derive(w, NOW), state.derive(w, NOW));
    assert.deepEqual(state.derive(w, NOW), { state: 'waiting', reasons: [] });
  });
});
