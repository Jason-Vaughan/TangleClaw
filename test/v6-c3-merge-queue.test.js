'use strict';

/*
 * v6 (#3212 Phase 1.1, Ruling A1042 / Ruling A958, Car V660-W1-B): the
 * Control-Plane GitHub Merge Broker's 4-gate verification
 * (`lib/v6/c3-merge-queue.js`). Small tier: no subprocess, no `node:sqlite`
 * database, no socket -- every function here is pure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MergeQueue, MergeQueueError, GATE_SPEC, AUTHORIZED_MERGE_ACTOR_CLASSES, SHA_SHAPE,
  verifyFourGateMergeReadiness, authorizeControlPlaneMerge
} = require('../lib/v6/c3-merge-queue');

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

/** A full, valid 4-gate receipt map pinned to `headSha`, CI under `ciKey` (default `'ci'`). */
function fullReceipts(headSha = HEAD, ciKey = 'ci') {
  const receipts = {
    observer: { verdict: 'PASS', headSha },
    architect: { verdict: 'PASS', headSha },
    reviewer: { verdict: 'PASS', headSha }
  };
  receipts[ciKey] = { verdict: 'PASS', headSha };
  return receipts;
}

/**
 * Assert `fn` throws a MergeQueueError with `code`.
 * @param {() => void} fn
 * @param {string} code
 * @returns {MergeQueueError} The caught error, for further assertions.
 */
function assertThrowsCode(fn, code) {
  let caught;
  assert.throws(fn, (error) => {
    caught = error;
    return error instanceof MergeQueueError && error.code === code;
  });
  return caught;
}

describe('v6 c3-merge-queue: verifyFourGateMergeReadiness', () => {
  it('passes when all four gates carry a PASS receipt pinned to the head sha, CI under "ci"', () => {
    const result = verifyFourGateMergeReadiness({ headSha: HEAD }, fullReceipts(HEAD, 'ci'));
    assert.deepEqual(result.ok, true);
    assert.equal(result.headSha, HEAD);
    assert.equal(result.gates.observer.verdict, 'PASS');
    assert.equal(result.gates.architect.verdict, 'PASS');
    assert.equal(result.gates.reviewer.verdict, 'PASS');
    assert.equal(result.gates.ci.verdict, 'PASS');
  });

  it('accepts CI under the "Tests" key as well as "ci"', () => {
    const result = verifyFourGateMergeReadiness({ headSha: HEAD }, fullReceipts(HEAD, 'Tests'));
    assert.equal(result.ok, true);
    assert.equal(result.gates.ci.verdict, 'PASS');
  });

  it('prefers the "ci" key over "Tests" when both are present', () => {
    const receipts = fullReceipts(HEAD, 'ci');
    receipts.Tests = { verdict: 'PASS', headSha: HEAD };
    receipts.ci = { verdict: 'REVISE', headSha: HEAD };
    assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
  });

  it('rejects a missing item', () => {
    assertThrowsCode(() => verifyFourGateMergeReadiness(undefined, fullReceipts()), 'ITEM_REQUIRED');
  });

  for (const bad of [undefined, null, '', 'not-a-sha', `${'a'.repeat(39)}`, `${'a'.repeat(41)}`, HEAD.toUpperCase()]) {
    it(`rejects an invalid headSha: ${JSON.stringify(bad)}`, () => {
      assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: bad }, fullReceipts()), 'HEAD_SHA_INVALID');
    });
  }

  it('rejects missing gateReceipts', () => {
    assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, undefined), 'GATE_RECEIPTS_REQUIRED');
  });

  it('refuses when a gate receipt is entirely missing', () => {
    const receipts = fullReceipts();
    delete receipts.reviewer;
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    const rGate = error.detail.failures.find((f) => f.gate === 'R-Gate');
    assert.equal(rGate.reason, 'missing');
  });

  it('refuses when a gate receipt is null', () => {
    const receipts = fullReceipts();
    receipts.architect = null;
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    assert.equal(error.detail.failures.find((f) => f.gate === 'A-Gate').reason, 'missing');
  });

  it('refuses when a gate receipt is present but not PASS', () => {
    const receipts = fullReceipts();
    receipts.observer = { verdict: 'REVISE', headSha: HEAD };
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    assert.equal(error.detail.failures.find((f) => f.gate === 'O-Gate').reason, 'verdict');
  });

  it('refuses when a gate receipt is PASS but pinned to a different head sha', () => {
    const receipts = fullReceipts();
    receipts.ci = { verdict: 'PASS', headSha: OTHER_HEAD };
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    assert.equal(error.detail.failures.find((f) => f.gate === 'CI').reason, 'sha-mismatch');
  });

  it('reports every failing gate at once, not just the first', () => {
    const receipts = fullReceipts();
    delete receipts.observer;
    receipts.architect = { verdict: 'REVISE', headSha: HEAD };
    receipts.reviewer = { verdict: 'PASS', headSha: OTHER_HEAD };
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    const gates = error.detail.failures.map((f) => f.gate).sort();
    assert.deepEqual(gates, ['A-Gate', 'O-Gate', 'R-Gate']);
  });

  it('does not read a gate receipt from an inherited (prototype) property', () => {
    const proto = { reviewer: { verdict: 'PASS', headSha: HEAD } };
    const receipts = Object.assign(Object.create(proto), fullReceipts());
    delete receipts.reviewer;
    const error = assertThrowsCode(() => verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
    assert.equal(error.detail.failures.find((f) => f.gate === 'R-Gate').reason, 'missing');
  });
});

describe('v6 c3-merge-queue: authorizeControlPlaneMerge', () => {
  it('authorizes an integrator when every gate is ready', () => {
    const result = authorizeControlPlaneMerge('q1', { actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: fullReceipts(), now: () => 12345 });
    assert.deepEqual(result, {
      ok: true, queueId: 'q1', headSha: HEAD, authorizedBy: 'integrator',
      gates: result.gates, authorizedAt: 12345
    });
    assert.equal(result.gates.ci.verdict, 'PASS');
  });

  it('authorizes an operator when every gate is ready', () => {
    const result = authorizeControlPlaneMerge('q1', { actorAuthorityClass: 'operator', headSha: HEAD, gateReceipts: fullReceipts() });
    assert.equal(result.authorizedBy, 'operator');
  });

  it('defaults authorizedAt to the real clock when no now is injected', () => {
    const before = Date.now();
    const result = authorizeControlPlaneMerge('q1', { actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: fullReceipts() });
    assert.equal(typeof result.authorizedAt, 'number');
    assert.ok(result.authorizedAt >= before);
  });

  it('forbids a builder from executing a merge', () => {
    const error = assertThrowsCode(() => authorizeControlPlaneMerge('q1', {
      actorAuthorityClass: 'builder', headSha: HEAD, gateReceipts: fullReceipts()
    }), 'BUILDER_DIRECT_MERGE_FORBIDDEN');
    assert.equal(error.status, 403);
  });

  for (const role of [undefined, null, '', 'pm', 'observer', 'reviewer']) {
    it(`forbids an unauthorized actorAuthorityClass: ${JSON.stringify(role)}`, () => {
      assertThrowsCode(() => authorizeControlPlaneMerge('q1', {
        actorAuthorityClass: role, headSha: HEAD, gateReceipts: fullReceipts()
      }), 'BUILDER_DIRECT_MERGE_FORBIDDEN');
    });
  }

  it('checks actor authority before gate readiness, so a builder is refused even with no valid gates', () => {
    assertThrowsCode(() => authorizeControlPlaneMerge('q1', {
      actorAuthorityClass: 'builder', headSha: HEAD, gateReceipts: {}
    }), 'BUILDER_DIRECT_MERGE_FORBIDDEN');
  });

  it('still refuses an authorized actor when a gate is stale', () => {
    const receipts = fullReceipts();
    receipts.ci = { verdict: 'PASS', headSha: OTHER_HEAD };
    assertThrowsCode(() => authorizeControlPlaneMerge('q1', {
      actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: receipts
    }), 'STALE_GATE_RECEIPT_SHA');
  });

  for (const bad of [undefined, null, '']) {
    it(`requires a non-empty queueId: ${JSON.stringify(bad)}`, () => {
      assertThrowsCode(() => authorizeControlPlaneMerge(bad, {
        actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: fullReceipts()
      }), 'QUEUE_ID_REQUIRED');
    });
  }
});

describe('v6 c3-merge-queue: MergeQueue instance', () => {
  it('verifyFourGateMergeReadiness behaves identically to the module function', () => {
    const queue = new MergeQueue();
    const result = queue.verifyFourGateMergeReadiness({ headSha: HEAD }, fullReceipts());
    assert.equal(result.ok, true);
    const receipts = fullReceipts();
    delete receipts.reviewer;
    assertThrowsCode(() => queue.verifyFourGateMergeReadiness({ headSha: HEAD }, receipts), 'STALE_GATE_RECEIPT_SHA');
  });

  it('authorizeControlPlaneMerge uses the instance clock, overriding any now passed in opts', () => {
    const queue = new MergeQueue({ now: () => 999 });
    const result = queue.authorizeControlPlaneMerge('q1', {
      actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: fullReceipts(), now: () => 1
    });
    assert.equal(result.authorizedAt, 999);
  });

  it('defaults its own clock to Date.now when none is injected', () => {
    const queue = new MergeQueue();
    const before = Date.now();
    const result = queue.authorizeControlPlaneMerge('q1', { actorAuthorityClass: 'integrator', headSha: HEAD, gateReceipts: fullReceipts() });
    assert.ok(result.authorizedAt >= before);
  });

  it('still enforces actor authority on the instance method', () => {
    const queue = new MergeQueue();
    assertThrowsCode(() => queue.authorizeControlPlaneMerge('q1', {
      actorAuthorityClass: 'builder', headSha: HEAD, gateReceipts: fullReceipts()
    }), 'BUILDER_DIRECT_MERGE_FORBIDDEN');
  });
});

describe('v6 c3-merge-queue: exported constants', () => {
  it('GATE_SPEC names all four gates with their accepted receipt keys', () => {
    assert.deepEqual(GATE_SPEC.map((g) => g.label), ['O-Gate', 'A-Gate', 'R-Gate', 'CI']);
    assert.deepEqual(GATE_SPEC.find((g) => g.label === 'CI').keys, ['ci', 'Tests']);
    assert.ok(Object.isFrozen(GATE_SPEC));
  });

  it('AUTHORIZED_MERGE_ACTOR_CLASSES names exactly integrator and operator', () => {
    assert.deepEqual(AUTHORIZED_MERGE_ACTOR_CLASSES, ['integrator', 'operator']);
    assert.ok(Object.isFrozen(AUTHORIZED_MERGE_ACTOR_CLASSES));
  });

  it('SHA_SHAPE matches a full lower-case 40-hex sha and rejects malformed ones', () => {
    assert.equal(SHA_SHAPE.test(HEAD), true);
    assert.equal(SHA_SHAPE.test(HEAD.toUpperCase()), false);
    assert.equal(SHA_SHAPE.test(HEAD.slice(0, 39)), false);
    assert.equal(SHA_SHAPE.test(`${HEAD}a`), false);
  });
});

describe('v6 c3-merge-queue: MergeQueueError', () => {
  it('carries code, status, detail and a stable name', () => {
    const error = new MergeQueueError('SOME_CODE', 'a message', 418, { x: 1 });
    assert.equal(error.name, 'MergeQueueError');
    assert.equal(error.code, 'SOME_CODE');
    assert.equal(error.status, 418);
    assert.deepEqual(error.detail, { x: 1 });
    assert.equal(error.message, 'a message');
    assert.ok(error instanceof Error);
  });

  it('defaults status to 400 when not given', () => {
    const error = new MergeQueueError('SOME_CODE', 'a message');
    assert.equal(error.status, 400);
  });
});
