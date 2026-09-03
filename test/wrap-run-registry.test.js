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
    const claim = registry.begin('proj-a', 42);
    assert.equal(claim.ok, true);
    // #185 — the claim mints the run's stream handle: 128 random bits, hex.
    assert.match(claim.runId, /^[0-9a-f]{32}$/);
    const status = registry.get('proj-a');
    assert.equal(status.runId, claim.runId);
    assert.equal(status.running, true);
    assert.equal(status.sessionId, 42);
    assert.equal(status.startedAt, 1_000_000);
    assert.equal(status.currentStepId, null);
    assert.equal(status.finishedAt, null);
    assert.equal(status.result, null);
  });

  it('a second begin while running is rejected with the running run info', () => {
    const first = registry.begin('proj-a', 42);
    registry.updateStep('proj-a', 'memory-update');
    fakeNow += 60_000;
    const second = registry.begin('proj-a', 43);
    assert.equal(second.ok, false);
    assert.deepEqual(second.running, {
      runId: first.runId,
      sessionId: 42,
      startedAt: 1_000_000,
      currentStepId: 'memory-update'
    });
    // The original claim is untouched.
    assert.equal(registry.get('proj-a').sessionId, 42);
  });

  it('projects are isolated — a run on one never blocks another', () => {
    registry.begin('proj-a', 1);
    assert.equal(registry.begin('proj-b', 2).ok, true);
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
    const again = registry.begin('proj-a', 8);
    assert.equal(again.ok, true);
    // A fresh claim resets the retained result — the status endpoint must
    // never serve a previous run's outcome as the new run's.
    assert.equal(registry.get('proj-a').result, null);
    // #185 — and mints a NEW handle, so a stream opened against the old run
    // can never be fed the new run's events.
    assert.notEqual(again.runId, status.runId);
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

  // #185 — the event log and subscriptions behind GET /wrap/stream/:runId.
  describe('events (#185)', () => {
    it('emit appends seq-ordered events and step-start moves the status pointer', () => {
      registry.begin('proj-a', 1);
      const a = registry.emit('proj-a', { type: 'run-start', steps: [{ stepId: 's1', kind: 'test' }] });
      const b = registry.emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      const c = registry.emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
      assert.equal(registry.get('proj-a').currentStepId, 's1', 'step-start is what /wrap/status reports');
      assert.equal(a.type, 'run-start');
    });

    it('emit with no running run, or with no type, is dropped rather than stored', () => {
      assert.equal(registry.emit('proj-x', { type: 'step-start', stepId: 's1' }), null);
      registry.begin('proj-a', 1);
      assert.equal(registry.emit('proj-a', { stepId: 's1' }), null, 'a typeless event has no SSE name');
      registry.finish('proj-a', { ok: true });
      assert.equal(registry.emit('proj-a', { type: 'step-start', stepId: 'zombie' }), null,
        'a late callback from a finished run must not scribble on its log');
    });

    it('subscribe replays what was missed, then delivers live events, and finish ends it with run-done', () => {
      const { runId } = registry.begin('proj-a', 1);
      registry.emit('proj-a', { type: 'run-start', steps: [] });
      registry.emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });

      const live = [];
      let ended = 0;
      const sub = registry.subscribe('proj-a', runId, {
        onEvent: (ev) => live.push(ev),
        onEnd: () => { ended += 1; }
      });
      assert.equal(sub.ok, true);
      assert.equal(sub.finished, false);
      assert.deepEqual(sub.replay.map((e) => [e.seq, e.type]), [[1, 'run-start'], [2, 'step-start']]);

      registry.emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      const result = { ok: true, pipelineResult: { ok: true, results: [] } };
      registry.finish('proj-a', result);

      assert.deepEqual(live.map((e) => [e.seq, e.type]), [[3, 'step-done'], [4, 'run-done']]);
      assert.deepEqual(live[1].result, result, 'run-done carries the retained result');
      assert.equal(ended, 1, 'finish ends the subscriber exactly once');
      // Nothing after the end: a zombie emit is dropped (see above), and even
      // a second finish must not re-end.
      registry.finish('proj-a', result);
      assert.equal(ended, 1);
    });

    it('subscribe refuses a foreign or stale runId and an unknown project', () => {
      const { runId } = registry.begin('proj-a', 1);
      assert.deepEqual(registry.subscribe('proj-a', 'not-this-run', { onEvent() {}, onEnd() {} }), { ok: false });
      assert.deepEqual(registry.subscribe('proj-b', runId, { onEvent() {}, onEnd() {} }), { ok: false });
      registry.finish('proj-a', { ok: true });
      const next = registry.begin('proj-a', 2);
      assert.deepEqual(registry.subscribe('proj-a', runId, { onEvent() {}, onEnd() {} }), { ok: false },
        'the previous run\'s id must not open a stream onto the new run');
      assert.equal(registry.subscribe('proj-a', next.runId, { onEvent() {}, onEnd() {} }).ok, true);
    });

    it('a finished run is replayed in full and reported finished, so the route closes at once', () => {
      const { runId } = registry.begin('proj-a', 1);
      registry.emit('proj-a', { type: 'run-start', steps: [] });
      registry.finish('proj-a', { ok: true });
      const sub = registry.subscribe('proj-a', runId, { onEvent() {}, onEnd() {} });
      assert.equal(sub.finished, true);
      assert.deepEqual(sub.replay.map((e) => e.type), ['run-start', 'run-done']);
    });

    it('afterSeq resumes a reconnecting client past what it already has', () => {
      const { runId } = registry.begin('proj-a', 1);
      registry.emit('proj-a', { type: 'run-start', steps: [] });
      registry.emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      registry.emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      const sub = registry.subscribe('proj-a', runId, { afterSeq: 2, onEvent() {}, onEnd() {} });
      assert.deepEqual(sub.replay.map((e) => e.seq), [3]);
    });

    it('unsubscribe stops delivery; a throwing subscriber is dropped without starving the others', () => {
      const { runId } = registry.begin('proj-a', 1);
      const quiet = [];
      const loud = [];
      const bad = registry.subscribe('proj-a', runId, {
        onEvent: () => { throw new Error('socket gone'); },
        onEnd() {}
      });
      const good = registry.subscribe('proj-a', runId, { onEvent: (e) => loud.push(e.type), onEnd() {} });
      const gone = registry.subscribe('proj-a', runId, { onEvent: (e) => quiet.push(e.type), onEnd() {} });
      gone.unsubscribe();
      registry.emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      registry.emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      assert.deepEqual(loud, ['step-start', 'step-done'], 'the healthy subscriber sees everything');
      assert.deepEqual(quiet, [], 'an unsubscribed listener sees nothing');
      assert.equal(bad.ok, true);
      assert.equal(registry.get('proj-a').currentStepId, 's1', 'the throw did not reach the pipeline');
    });

    it('a stale takeover ends the displaced run\'s subscribers — they were watching a run that no longer exists', () => {
      const { runId } = registry.begin('proj-a', 1);
      let ended = 0;
      registry.subscribe('proj-a', runId, { onEvent() {}, onEnd: () => { ended += 1; } });
      fakeNow += registry.STALE_RUN_MS;
      const takeover = registry.begin('proj-a', 2);
      assert.equal(takeover.ok, true);
      assert.equal(ended, 1);
      assert.notEqual(takeover.runId, runId);
    });
  });

  it('anyRunning names a project with a live wrap, null otherwise', () => {
    assert.equal(registry.anyRunning(), null);
    registry.begin('proj-a', 1);
    assert.equal(registry.anyRunning(), 'proj-a');
    registry.finish('proj-a', { ok: true });
    assert.equal(registry.anyRunning(), null);
  });
});
