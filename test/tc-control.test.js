'use strict';

// #1861: `tc control` and the HELD banner. The banner is visibility, not
// enforcement: it tells a Builder its lane is held at its next tc call, even
// while the notice mail is still queued.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { VERB_ROSTER, renderControlStatus, renderControlBanner, receiptVerbLabel } = require('../lib/tc-verbs');

const control = VERB_ROSTER.find((v) => v.id === 'control');

/**
 * A fake tc context recording every request.
 * @param {string[]} argv - Arguments after `control`
 * @param {object} [mineData] - What GET /api/control/mine answers
 * @returns {{ctx: object, calls: object[]}}
 */
function fakeCtx(argv, mineData = { assignment: null }) {
  const calls = [];
  const ctx = {
    argv,
    env: {},
    getJson: async (p) => { calls.push(['GET', p]); return mineData; },
    postJson: async (p, body) => {
      calls.push(['POST', p, body]);
      return { holdId: 'evt_h', assignment: { state: 'held', stateGeneration: 2 } };
    }
  };
  return { ctx, calls };
}

const HELD = {
  assignment: { assignmentId: 'asg_1', issueRef: '#1861', state: 'held', stateGeneration: 3, activeHoldIds: ['evt_a', 'evt_b'] },
  holds: [
    { holdId: 'evt_a', issuer: 'project:74', releasedGeneration: null },
    { holdId: 'evt_b', issuer: 'project:70', releasedGeneration: null },
    { holdId: 'evt_c', issuer: 'project:74', releasedGeneration: 2 }
  ],
  boundToThisLaunch: true
};

describe('tc control (#1861)', () => {
  it('rejects a missing or unknown subverb and malformed arguments before any request', async () => {
    for (const argv of [[], ['bogus'], ['ack'], ['ack', 'x'], ['hold', 'asg_1'], ['release', 'asg_1', '2', 'resolved'], ['release', 'asg_1', 'two', 'resolved', 'evt_a']]) {
      const { ctx, calls } = fakeCtx(argv);
      const r = await control.run(ctx);
      assert.equal(r.code, 1, argv.join(' '));
      assert.equal(calls.length, 0, argv.join(' '));
    }
  });

  it('status renders a held lane with its holds and the ack command, and says shell git is not blocked', () => {
    const out = renderControlStatus(HELD);
    assert.match(out, /HELD at generation 3/);
    assert.match(out, /Active holds \(2\): evt_a by project:74, evt_b by project:70/);
    assert.match(out, /tc control ack 3/);
    assert.match(out, /Direct shell git\/gh is not blocked/);
    assert.match(renderControlStatus({ assignment: null }), /No open control assignment/);
  });

  it('hold and release send a fresh request id and the fields the API needs', async () => {
    const h = fakeCtx(['hold', 'asg_1', 'boundary']);
    await control.run(h.ctx);
    assert.equal(h.calls[0][1], '/api/control/assignments/asg_1/hold');
    assert.equal(h.calls[0][2].reasonCode, 'boundary');
    assert.match(h.calls[0][2].requestId, /^tc-/);
    const r = fakeCtx(['release', 'asg_1', '3', 'resolved', 'evt_a', 'evt_b']);
    await control.run(r.ctx);
    assert.deepEqual(r.calls[0][2].holdIds, ['evt_a', 'evt_b']);
    assert.equal(r.calls[0][2].expectedGeneration, 3);
  });

  it('ack posts the generation the caller saw to its own assignment', async () => {
    const { ctx, calls } = fakeCtx(['ack', '3'], HELD);
    const r = await control.run(ctx);
    assert.equal(r.code, 0);
    assert.deepEqual(calls[1], ['POST', '/api/control/assignments/asg_1/ack', { stateGeneration: 3 }]);
  });

  it('the banner speaks only for a held or stopped lane', () => {
    assert.equal(renderControlBanner({ assignment: null }), '');
    assert.equal(renderControlBanner({ assignment: { ...HELD.assignment, state: 'active' } }), '');
    assert.match(renderControlBanner(HELD), /HELD \(gen 3, 2 holds\)/);
    assert.match(renderControlBanner({ assignment: { ...HELD.assignment, state: 'stopped', activeHoldIds: [] } }), /STOPPED \(gen 3\)/);
  });

  it('records control subverbs as their own receipt labels', () => {
    assert.equal(receiptVerbLabel('control', ['status']), 'control.status');
  });
});
