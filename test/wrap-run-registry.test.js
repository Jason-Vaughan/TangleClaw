'use strict';

/*
 * #583 — wrap-run registry unit tests. The registry is the server-side
 * single-flight guard for V2 wraps plus the observable state behind
 * `GET /api/sessions/:project/wrap/status`. These tests pin the
 * lifecycle contract the incident exposed the absence of: one running
 * wrap per project, progress visible while running, the last result
 * retrievable after the POST connection is long gone, and a wedged run
 * unable to lock a project out of wrapping forever.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const registry = require('../lib/wrap-run-registry');

describe('wrap-run-registry (#583)', () => {
  const origNow = registry._internal.now;
  let fakeNow;

  beforeEach(() => {
    registry._resetForTests();
    fakeNow = 1_000_000;
    registry._internal.now = () => fakeNow;
  });

  afterEach(() => {
    registry._internal.now = origNow;
    registry._resetForTests();
  });

  it('begin claims the slot and get reports a running run', () => {
    assert.deepEqual(registry.begin('proj-a', 42), { ok: true });
    const status = registry.get('proj-a');
    assert.equal(status.running, true);
    assert.equal(status.sessionId, 42);
    assert.equal(status.startedAt, 1_000_000);
    assert.equal(status.currentStepId, null);
    assert.equal(status.finishedAt, null);
    assert.equal(status.result, null);
  });

  it('a second begin while running is rejected with the running run info', () => {
    registry.begin('proj-a', 42);
    registry.updateStep('proj-a', 'memory-update');
    fakeNow += 60_000;
    const second = registry.begin('proj-a', 43);
    assert.equal(second.ok, false);
    assert.deepEqual(second.running, {
      sessionId: 42,
      startedAt: 1_000_000,
      currentStepId: 'memory-update'
    });
    // The original claim is untouched.
    assert.equal(registry.get('proj-a').sessionId, 42);
  });

  it('projects are isolated — a run on one never blocks another', () => {
    registry.begin('proj-a', 1);
    assert.deepEqual(registry.begin('proj-b', 2), { ok: true });
    assert.equal(registry.get('proj-a').running, true);
    assert.equal(registry.get('proj-b').running, true);
  });

  it('updateStep tracks progress on the running run only', () => {
    registry.begin('proj-a', 1);
    registry.updateStep('proj-a', 'pr-check');
    assert.equal(registry.get('proj-a').currentStepId, 'pr-check');
    registry.updateStep('proj-a', 'changelog-update');
    assert.equal(registry.get('proj-a').currentStepId, 'changelog-update');
    // No-op on an unknown project and on a finished run (a zombie
    // pipeline's late callbacks must not scribble on later state).
    registry.updateStep('proj-x', 'anything');
    assert.equal(registry.get('proj-x').running, false);
    registry.finish('proj-a', { ok: true });
    registry.updateStep('proj-a', 'late-zombie-step');
    assert.equal(registry.get('proj-a').currentStepId, null);
  });

  it('finish retains the result for later reads and frees the slot', () => {
    registry.begin('proj-a', 7);
    fakeNow += 5_000;
    const result = { ok: true, pipelineResult: { ok: true, results: [] } };
    registry.finish('proj-a', result);
    const status = registry.get('proj-a');
    assert.equal(status.running, false);
    assert.equal(status.finishedAt, 1_005_000);
    assert.deepEqual(status.result, result);
    // Slot is free again.
    assert.deepEqual(registry.begin('proj-a', 8), { ok: true });
    // A fresh claim resets the retained result — the status endpoint must
    // never serve a previous run's outcome as the new run's.
    assert.equal(registry.get('proj-a').result, null);
  });

  it('finish on a project with no running run is a no-op (late zombie completion)', () => {
    registry.finish('proj-a', { ok: false });
    assert.equal(registry.get('proj-a').result, null);
    registry.begin('proj-a', 1);
    registry.finish('proj-a', { ok: true, tag: 'first' });
    // Second finish (e.g. a taken-over stale run completing late) is ignored.
    registry.finish('proj-a', { ok: true, tag: 'zombie' });
    assert.equal(registry.get('proj-a').result.tag, 'first');
  });

  it('a stale running run (>= STALE_RUN_MS) is taken over instead of blocking forever', () => {
    registry.begin('proj-a', 1);
    fakeNow += registry.STALE_RUN_MS - 1;
    assert.equal(registry.begin('proj-a', 2).ok, false, 'just under the threshold still blocks');
    fakeNow += 1;
    const takeover = registry.begin('proj-a', 2);
    assert.equal(takeover.ok, true, 'at the threshold the wedged run is taken over');
    const status = registry.get('proj-a');
    assert.equal(status.sessionId, 2);
    assert.equal(status.startedAt, fakeNow);
  });

  it('anyRunning names a project with a live wrap, null otherwise', () => {
    assert.equal(registry.anyRunning(), null);
    registry.begin('proj-a', 1);
    assert.equal(registry.anyRunning(), 'proj-a');
    registry.finish('proj-a', { ok: true });
    assert.equal(registry.anyRunning(), null);
  });
});
