'use strict';

/*
 * #1912: the `tc workload set|show` client. It sends only the asserted fields
 * (never identity or time, which the server stamps), parses repeatable refs
 * into numbers, refuses a malformed invocation before any request, and renders
 * what the server returned.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VERB_ROSTER, receiptVerbLabel, renderWorkloadReceipt, renderLaneLine, renderSessions } = require('../lib/tc-verbs');

const verb = VERB_ROSTER.find((v) => v.id === 'workload');

/**
 * A fake `tc` context that records requests.
 * @param {string[]} argv - Arguments after `tc workload`
 * @param {object} [reply] - What the fake server answers
 * @returns {{ctx: object, calls: Array<{method: string, path: string, body?: object}>}}
 */
function fakeCtx(argv, reply = { receipt: null }) {
  const calls = [];
  return {
    calls,
    ctx: {
      argv,
      env: {},
      getJson: async (p) => { calls.push({ method: 'GET', path: p }); return reply; },
      postJson: async (p, body) => { calls.push({ method: 'POST', path: p, body }); return reply; }
    }
  };
}

const RECEIPT = {
  seq: 3, state: 'waiting-external', clearance: 'do-not-clear', summary: 'CI on PR 1916',
  wait: 'ci', waitDetail: 'exact-head', refs: { issues: [1912], prs: [1916], tasks: ['A1'] },
  branch: 'feat/1912-fleet-workload', head: 'c'.repeat(40), assignmentId: null,
  receivedAt: '2026-09-26T20:00:00.000Z'
};

describe('tc workload (#1912)', () => {
  it('is on the roster and records its subverb in the receipt label', () => {
    assert.ok(verb, 'workload must be a declared verb');
    assert.equal(receiptVerbLabel('workload', ['set']), 'workload.set');
    assert.equal(receiptVerbLabel('workload', ['show']), 'workload.show');
  });

  it('set sends exactly the asserted fields, with numeric refs, to POST /api/tc/workload', async () => {
    const { ctx, calls } = fakeCtx([
      'set', 'waiting-external', '--clearance', 'do-not-clear', '--summary', 'CI on PR 1916',
      '--wait', 'ci', '--wait-detail', 'exact-head', '--issue', '1912', '--pr', '1916', '--pr', '1917',
      '--task', 'A1', '--branch', 'feat/1912-fleet-workload', '--head', 'c'.repeat(40)
    ], { receipt: RECEIPT });
    const out = await verb.run(ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [{
      method: 'POST',
      path: '/api/tc/workload',
      body: {
        schema: 'tc.workload/1', state: 'waiting-external', clearance: 'do-not-clear', summary: 'CI on PR 1916',
        wait: 'ci', waitDetail: 'exact-head', issues: [1912], prs: [1916, 1917], tasks: ['A1'],
        branch: 'feat/1912-fleet-workload', head: 'c'.repeat(40)
      }
    }]);
  });

  it('never sends an identity or time field, whatever the invocation', async () => {
    const { ctx, calls } = fakeCtx(['set', 'complete', '--clearance', 'safe-to-clear', '--summary', 'done']);
    await verb.run(ctx);
    const keys = Object.keys(calls[0].body);
    for (const k of ['projectId', 'sessionId', 'launchId', 'assignmentId', 'seq', 'receivedAt', 'source']) {
      assert.ok(!keys.includes(k), `${k} must not be sent`);
    }
  });

  it('refuses a malformed invocation without sending anything', async () => {
    const cases = [
      [],
      ['bogus'],
      ['set'],
      ['set', '--clearance', 'unknown'],
      ['set', 'complete', '--summary', 'x'],
      ['set', 'complete', '--clearance', 'unknown'],
      ['set', 'complete', '--clearance', 'unknown', '--summary', 'x', '--issue', 'abc'],
      ['set', 'complete', '--clearance', 'unknown', '--summary', 'x', '--nope', 'y'],
      ['set', 'complete', '--clearance', 'unknown', '--summary'],
      ['set', 'complete', '--clearance', 'unknown', '--clearance', 'unknown', '--summary', 'x'],
      ['show', 'extra']
    ];
    for (const argv of cases) {
      const { ctx, calls } = fakeCtx(argv);
      const out = await verb.run(ctx);
      assert.equal(out.code, 1, `should refuse: ${argv.join(' ')}`);
      assert.equal(calls.length, 0, `should send nothing: ${argv.join(' ')}`);
    }
  });

  it('show reads GET /api/tc/workload and renders the receipt', async () => {
    const { ctx, calls } = fakeCtx(['show'], { receipt: RECEIPT });
    const out = await verb.run(ctx);
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/tc/workload' }]);
    assert.match(out.stdout, /Workload #3: waiting-external, do-not-clear/);
    assert.match(out.stdout, /waiting on: ci \(exact-head\)/);
    assert.match(out.stdout, /refs: #1912, PR #1916, A1/);
    assert.match(out.stdout, /branch: feat\/1912-fleet-workload @ cccccccccccc/);
  });

  it('show adds the composed verdict coordinators see, when the server sends one', async () => {
    const { ctx } = fakeCtx(['show'], {
      receipt: RECEIPT,
      composed: { availability: 'WAITING', clearance: 'do-not-clear', reasons: ['receipt-waiting'] },
      workload: { receipt: RECEIPT, provenance: 'explicit-receipt', staleReason: null, ageSeconds: 180 },
      engine: { activity: 'at-rest', reason: 'at-rest' }
    });
    const out = await verb.run(ctx);
    assert.match(out.stdout, /Coordinators see: WAITING, do-not-clear/);
  });

  it('says a lane with no receipt reads UNKNOWN to coordinators', () => {
    assert.match(renderWorkloadReceipt(null), /UNKNOWN/);
  });
});

describe('the composed lane line (#1912, ADR 0020 §6)', () => {
  const lane = (patch = {}) => ({
    composed: { availability: 'AVAILABLE', clearance: 'safe-to-clear', reasons: [] },
    workload: { receipt: { state: 'complete', clearance: 'safe-to-clear', summary: 'Train 2 merged' }, provenance: 'explicit-receipt', staleReason: null, ageSeconds: 300 },
    engine: { activity: 'at-rest', reason: 'at-rest' },
    ...patch
  });

  it('leads with the verdict, then keeps the assertion and the observation apart', () => {
    assert.equal(renderLaneLine(lane()),
      'AVAILABLE, safe-to-clear — asserted complete/safe-to-clear, 5m ago: "Train 2 merged"; engine at-rest (at-rest)');
  });

  it('says a receipt is stale and why', () => {
    const line = renderLaneLine(lane({
      composed: { availability: 'UNKNOWN', clearance: 'unknown', reasons: [] },
      workload: { receipt: { state: 'complete', clearance: 'safe-to-clear', summary: 's' }, provenance: 'stale', staleReason: 'expired', ageSeconds: 9000 }
    }));
    assert.match(line, /^UNKNOWN, unknown — asserted complete\/safe-to-clear \(stale: expired\), 150m ago/);
  });

  it('says when there is no receipt, and names an operator narrowing', () => {
    assert.match(renderLaneLine(lane({ workload: { receipt: null, provenance: 'none' } })), /— no receipt; engine at-rest/);
    const narrowed = renderLaneLine(lane({ workload: { ...lane().workload, narrowing: { reason: 'reviewing' } } }));
    assert.match(narrowed, /; operator-narrowed: reviewing$/);
  });

  it('renders nothing for a response without the blocks', () => {
    assert.equal(renderLaneLine({}), '');
    assert.equal(renderLaneLine(null), '');
  });

  it('tc sessions prints each lane\'s line beneath its session', () => {
    const out = renderSessions({ sessions: [{ id: 7, projectId: 3, projectName: 'b2', engineId: 'claude', status: 'active', startedAt: 't', ...lane() }] }, {});
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l.includes('#7 b2'));
    assert.ok(i >= 0);
    assert.match(lines[i + 1], /^ {6}AVAILABLE, safe-to-clear — /);
  });
});
