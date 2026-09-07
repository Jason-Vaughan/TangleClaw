'use strict';

/*
 * #583 — wrap-run registry unit tests. The registry is the server-side
 * single-flight guard for wraps plus the observable state behind
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

/**
 * The runId the registry currently holds for a project — what a live pipeline
 * would be carrying. Lets the tests below stay about the property they name;
 * the run-identity check itself is pinned by its own cases.
 * @param {string} project - Registry key
 * @returns {string|null} The current runId
 */
const rid = (project) => registry.get(project).runId;
/** `registry.emit` for the project's current run. @returns {object|null} */
const emit = (project, event) => registry.emit(project, rid(project), event);
/** `registry.finish` for the project's current run. @returns {boolean} */
const finish = (project, result) => registry.finish(project, rid(project), result);

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
    emit('proj-a', { type: 'step-start', stepId: 'memory-update' });
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

  it('a step-start moves the status pointer, on the running run only', () => {
    registry.begin('proj-a', 1);
    emit('proj-a', { type: 'step-start', stepId: 'pr-check' });
    assert.equal(registry.get('proj-a').currentStepId, 'pr-check');
    emit('proj-a', { type: 'step-start', stepId: 'changelog-update' });
    assert.equal(registry.get('proj-a').currentStepId, 'changelog-update');
    // No-op on an unknown project and on a finished run (a zombie
    // pipeline's late callbacks must not scribble on later state).
    emit('proj-x', { type: 'step-start', stepId: 'anything' });
    assert.equal(registry.get('proj-x').running, false);
    finish('proj-a', { ok: true });
    emit('proj-a', { type: 'step-start', stepId: 'late-zombie-step' });
    assert.equal(registry.get('proj-a').currentStepId, null);
  });

  it('finish retains the result for later reads and frees the slot', () => {
    registry.begin('proj-a', 7);
    fakeNow += 5_000;
    const result = { ok: true, pipelineResult: { ok: true, results: [] } };
    finish('proj-a', result);
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
    finish('proj-a', { ok: false });
    assert.equal(registry.get('proj-a').result, null);
    registry.begin('proj-a', 1);
    finish('proj-a', { ok: true, tag: 'first' });
    // Second finish (e.g. a taken-over stale run completing late) is ignored.
    finish('proj-a', { ok: true, tag: 'zombie' });
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
      const a = emit('proj-a', { type: 'run-start', steps: [{ stepId: 's1', kind: 'test' }] });
      const b = emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      const c = emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
      assert.equal(registry.get('proj-a').currentStepId, 's1', 'step-start is what /wrap/status reports');
      assert.equal(a.type, 'run-start');
    });

    it('emit with no running run, or with no type, is dropped rather than stored', () => {
      assert.equal(emit('proj-x', { type: 'step-start', stepId: 's1' }), null);
      registry.begin('proj-a', 1);
      assert.equal(emit('proj-a', { stepId: 's1' }), null, 'a typeless event has no SSE name');
      finish('proj-a', { ok: true });
      assert.equal(emit('proj-a', { type: 'step-start', stepId: 'zombie' }), null,
        'a late callback from a finished run must not scribble on its log');
    });

    it('subscribe replays what was missed, then delivers live events, and finish ends it with run-done', () => {
      const { runId } = registry.begin('proj-a', 1);
      emit('proj-a', { type: 'run-start', steps: [] });
      emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });

      const live = [];
      let ended = 0;
      const sub = registry.subscribe('proj-a', runId, {
        onEvent: (ev) => live.push(ev),
        onEnd: () => { ended += 1; }
      });
      assert.equal(sub.ok, true);
      assert.equal(sub.finished, false);
      assert.deepEqual(sub.replay.map((e) => [e.seq, e.type]), [[1, 'run-start'], [2, 'step-start']]);

      emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
      const result = { ok: true, pipelineResult: { ok: true, results: [] } };
      finish('proj-a', result);

      assert.deepEqual(live.map((e) => [e.seq, e.type]), [[3, 'step-done'], [4, 'run-done']]);
      assert.deepEqual(live[1].result, result, 'run-done carries the retained result');
      assert.equal(ended, 1, 'finish ends the subscriber exactly once');
      // Nothing after the end: a zombie emit is dropped (see above), and even
      // a second finish must not re-end.
      finish('proj-a', result);
      assert.equal(ended, 1);
    });

    it('subscribe refuses a foreign or stale runId and an unknown project', () => {
      const { runId } = registry.begin('proj-a', 1);
      assert.deepEqual(registry.subscribe('proj-a', 'not-this-run', { onEvent() {}, onEnd() {} }), { ok: false });
      assert.deepEqual(registry.subscribe('proj-b', runId, { onEvent() {}, onEnd() {} }), { ok: false });
      finish('proj-a', { ok: true });
      const next = registry.begin('proj-a', 2);
      assert.deepEqual(registry.subscribe('proj-a', runId, { onEvent() {}, onEnd() {} }), { ok: false },
        'the previous run\'s id must not open a stream onto the new run');
      assert.equal(registry.subscribe('proj-a', next.runId, { onEvent() {}, onEnd() {} }).ok, true);
    });

    it('a finished run is replayed in full and reported finished, so the route closes at once', () => {
      const { runId } = registry.begin('proj-a', 1);
      emit('proj-a', { type: 'run-start', steps: [] });
      finish('proj-a', { ok: true });
      const sub = registry.subscribe('proj-a', runId, { onEvent() {}, onEnd() {} });
      assert.equal(sub.finished, true);
      assert.deepEqual(sub.replay.map((e) => e.type), ['run-start', 'run-done']);
    });

    it('afterSeq resumes a reconnecting client past what it already has', () => {
      const { runId } = registry.begin('proj-a', 1);
      emit('proj-a', { type: 'run-start', steps: [] });
      emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
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
      emit('proj-a', { type: 'step-start', stepId: 's1', kind: 'test' });
      emit('proj-a', { type: 'step-done', stepId: 's1', kind: 'test', status: 'done' });
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

  // The displaced-pipeline case the project-name check could not see. A stale
  // takeover replaces the project's entry while the OLD pipeline is still
  // running and still holding its callbacks; keyed on the project alone, that
  // pipeline's next event lands in the takeover's log and reaches the
  // takeover's subscribers — a run's watchers fed another run's steps, which
  // is exactly what `subscribe` refuses at the door.
  describe('emit and finish are keyed on the run, not the project (#185)', () => {
    it('an event from a displaced run is dropped, not appended to the takeover', () => {
      const displaced = registry.begin('proj-a', 1);
      fakeNow += registry.STALE_RUN_MS;
      const takeover = registry.begin('proj-a', 2);
      const seen = [];
      registry.subscribe('proj-a', takeover.runId, { onEvent: (e) => seen.push(e), onEnd() {} });

      const dropped = registry.emit('proj-a', displaced.runId, { type: 'step-start', stepId: 'zombie' });

      assert.equal(dropped, null, 'the old pipeline may not write into the new run');
      assert.deepEqual(seen, [], 'and its subscribers must never see the old run\'s steps');
      assert.equal(registry.get('proj-a').currentStepId, null,
        'nor may it move the takeover\'s status pointer');
      // The takeover's own events still land.
      assert.ok(registry.emit('proj-a', takeover.runId, { type: 'step-start', stepId: 'real' }));
      assert.equal(registry.get('proj-a').currentStepId, 'real');
    });

    it('a displaced run finishing late does not close out the takeover', () => {
      const displaced = registry.begin('proj-a', 1);
      fakeNow += registry.STALE_RUN_MS;
      const takeover = registry.begin('proj-a', 2);
      let ended = 0;
      registry.subscribe('proj-a', takeover.runId, { onEvent() {}, onEnd: () => { ended += 1; } });

      const settled = registry.finish('proj-a', displaced.runId, { ok: true, tag: 'zombie' });

      assert.equal(settled, false, 'finish reports it did not settle the run');
      assert.equal(ended, 0, 'the takeover\'s stream stays open');
      const status = registry.get('proj-a');
      assert.equal(status.running, true, 'and its slot stays claimed');
      assert.equal(status.result, null, 'no zombie result is retained');
    });

    it('finish returns whether it settled the run, so a caller can tell', () => {
      const claim = registry.begin('proj-a', 1);
      assert.equal(registry.finish('proj-a', claim.runId, { ok: true }), true);
      // Second call: the run is already finished.
      assert.equal(registry.finish('proj-a', claim.runId, { ok: true }), false);
      // Never begun.
      assert.equal(registry.finish('proj-never', 'x'.repeat(32), { ok: true }), false);
    });
  });

  // #1314 — STALE_RUN_MS was applied by `begin` alone. Every reader of
  // `running` believed a wedged run forever, so one pipeline promise that
  // never settled refused `POST /api/server/restart` permanently and stopped
  // `lib/medusa-wake.js` nudging the project at all. These pin the readers
  // against the same threshold `begin` has always used.
  describe('a wedged run stops being believed by readers (#1314)', () => {
    it('get reports a stale run as not running, and says so, keeping its identity', () => {
      const claim = registry.begin('proj-a', 7);

      fakeNow += registry.STALE_RUN_MS - 1;
      const fresh = registry.get('proj-a');
      assert.equal(fresh.running, true, 'just under the threshold it is still live');
      assert.equal(fresh.stale, false);

      fakeNow += 1;
      const wedged = registry.get('proj-a');
      assert.equal(wedged.running, false, 'at the threshold no reader should still believe it');
      assert.equal(wedged.stale, true, 'and the reason is reported, not merely the absence');
      // The record survives: a stale run is reported, never reaped. The card
      // needs `startedAt` to say HOW long it has been wedged, and the stream
      // route still resolves the run by id.
      assert.equal(wedged.runId, claim.runId);
      assert.equal(wedged.startedAt, 1_000_000);
      assert.equal(wedged.sessionId, 7);
    });

    it('a finished run is not stale — settled and wedged are different answers', () => {
      registry.begin('proj-a', 1);
      finish('proj-a', { ok: true });
      fakeNow += registry.STALE_RUN_MS * 2;
      const status = registry.get('proj-a');
      assert.equal(status.running, false);
      assert.equal(status.stale, false, 'it finished; age is irrelevant');
      assert.equal(status.result.ok, true);
    });

    it('anyRunning skips a wedged run so the restart gate stops refusing forever', () => {
      registry.begin('proj-a', 1);
      assert.equal(registry.anyRunning(), 'proj-a');
      fakeNow += registry.STALE_RUN_MS;
      assert.equal(registry.anyRunning(), null, 'server.js:979 must let the restart through');
    });

    it('anyRunning still names a live wrap when another project holds a wedged one', () => {
      registry.begin('proj-wedged', 1);
      fakeNow += registry.STALE_RUN_MS;
      registry.begin('proj-live', 2);
      // Insertion order puts the wedged project first, so a reader that stops
      // at the first truthy `running` would answer with it.
      assert.equal(registry.anyRunning(), 'proj-live');
    });

    it('subscribe closes a stream opened on a wedged run instead of hanging it', () => {
      const claim = registry.begin('proj-a', 1);
      emit('proj-a', { type: 'run-start', steps: [] });
      fakeNow += registry.STALE_RUN_MS;

      let ended = 0;
      const sub = registry.subscribe('proj-a', claim.runId, {
        onEvent: () => {},
        onEnd: () => { ended += 1; }
      });
      assert.equal(sub.ok, true, 'the run still exists, so the id resolves');
      assert.equal(sub.finished, true, 'a wedged run will never emit again — do not hold the client');
      assert.deepEqual(sub.replay.map((ev) => ev.type), ['run-start', 'run-done'],
        'it gets what the run emitted, then a terminal frame it never emitted itself');
      // Synthesised, not appended: a read must not write to the log, and the
      // run may still settle for real afterwards.
      const terminal = sub.replay[1];
      assert.equal(terminal.stale, true, 'the terminal frame says WHY the stream ended');
      assert.equal(terminal.result, null, 'a wedged pipeline\'s outcome is what nobody knows');
      assert.equal(terminal.seq, 2, 'numbered as the next event would have been');
      assert.deepEqual(registry.get('proj-a').runId, claim.runId);

      // No listener was registered: a late finish must not call back into a
      // client that was already told the stream was over.
      finish('proj-a', { ok: false });
      assert.equal(ended, 0);
    });

    // The writers ask a DIFFERENT question from the readers. `run.running`
    // means "has this run settled?"; staleness means "should a reader still
    // believe it is in progress?". A wedged pipeline that finally completes
    // must be able to record its outcome — dropping it would strand the run
    // stale forever with no result.
    it('the run\'s own pipeline can still finish it after it has gone stale', () => {
      const claim = registry.begin('proj-a', 1);
      fakeNow += registry.STALE_RUN_MS;
      assert.equal(registry.get('proj-a').stale, true);

      assert.equal(registry.finish('proj-a', claim.runId, { ok: true, tag: 'late' }), true,
        'the owning pipeline settles its own run');
      const status = registry.get('proj-a');
      assert.equal(status.running, false);
      assert.equal(status.stale, false, 'settled, so no longer wedged');
      assert.equal(status.result.tag, 'late');
    });

    it('emit from the run\'s own pipeline still records after it has gone stale', () => {
      const claim = registry.begin('proj-a', 1);
      fakeNow += registry.STALE_RUN_MS;
      const stored = registry.emit('proj-a', claim.runId, { type: 'step-done', stepId: 's1' });
      assert.notEqual(stored, null, 'the record of what the run did is still worth keeping');
      assert.equal(stored.seq, 1);
    });

    it('begin still takes over a wedged run — the behaviour that already worked is untouched', () => {
      registry.begin('proj-a', 1);
      fakeNow += registry.STALE_RUN_MS;
      const takeover = registry.begin('proj-a', 2);
      assert.equal(takeover.ok, true);
      const status = registry.get('proj-a');
      assert.equal(status.running, true, 'the takeover is live');
      assert.equal(status.stale, false);
      assert.equal(status.sessionId, 2);
    });
  });

  it('anyRunning names a project with a live wrap, null otherwise', () => {
    assert.equal(registry.anyRunning(), null);
    registry.begin('proj-a', 1);
    assert.equal(registry.anyRunning(), 'proj-a');
    finish('proj-a', { ok: true });
    assert.equal(registry.anyRunning(), null);
  });
});
