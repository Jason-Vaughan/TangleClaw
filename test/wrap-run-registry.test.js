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

  it('#1492 — records a detached copy of the run\'s options, and null without any', () => {
    const options = { release: 'hold', pathDecisions: { 'a.js': 'leave' } };
    registry.begin('proj-a', 42, options);
    options.release = 'cut';
    options.onStepEvent = () => {};
    const recorded = registry.get('proj-a').options;
    assert.deepEqual(recorded, { release: 'hold', pathDecisions: { 'a.js': 'leave' } },
      'what the operator chose, not what the pipeline later hangs on the object');
    registry._resetForTests();
    registry.begin('proj-a', 42);
    assert.equal(registry.get('proj-a').options, null);
    registry._resetForTests();
    registry.begin('proj-a', 42, ['not', 'options']);
    assert.equal(registry.get('proj-a').options, null);
    assert.equal(registry.get('never-wrapped').options, null);
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

  it('a stale running run (>= STALE_RUN_MS), short of its cancel boundary, is taken over automatically (#1805)', () => {
    registry.begin('proj-a', 1);
    fakeNow += registry.STALE_RUN_MS - 1;
    assert.equal(registry.begin('proj-a', 2).ok, false, 'just under the threshold still blocks');
    fakeNow += 1;
    const takeover = registry.begin('proj-a', 2);
    assert.equal(takeover.ok, true, 'short of the cancel boundary, nothing needs confirming');
    const status = registry.get('proj-a');
    assert.equal(status.sessionId, 2);
    assert.equal(status.startedAt, fakeNow);
  });

  it('a stale run PAST its cancel boundary is refused, not taken over, and stays refused (#1805)', () => {
    const claim = registry.begin('proj-a', 1);
    assert.equal(registry.admitStep('proj-a', claim.runId, { stepId: 'commit', pastCancelBoundary: true }), 'proceed');
    fakeNow += registry.STALE_RUN_MS;
    const refused = registry.begin('proj-a', 2);
    assert.equal(refused.ok, false, 'it may already be committing, branching or pushing — no takeover can be safe');
    assert.equal(refused.running.stale, true);
    assert.equal(refused.running.runId, claim.runId);
    assert.equal(registry.get('proj-a').sessionId, 1, 'the original run is untouched — there is no override for this case');

    // Stays refused on a later attempt too — there is no confirm flag, no
    // retry path, short of the run finishing or a restart.
    assert.equal(registry.begin('proj-a', 3).ok, false);

    // It frees itself the ordinary way: the pipeline finally finishes.
    assert.equal(registry.finish('proj-a', claim.runId, { ok: true, tag: 'late' }), true);
    assert.equal(registry.begin('proj-a', 4).ok, true, 'the slot is free once the run actually settles');
  });

  // #1805 — a stale takeover must stop the displaced pipeline before it can
  // reach its OWN cancel boundary, not just take the project's slot. Keyed on
  // the displaced `runId` alone, because the takeover already replaced the
  // project's entry by the time the displaced pipeline's own calls arrive.
  it('a stale takeover tells the displaced pipeline to stop before it can reach its cancel boundary', () => {
    const displaced = registry.begin('proj-a', 1);
    fakeNow += registry.STALE_RUN_MS;
    const takeover = registry.begin('proj-a', 2);
    assert.equal(takeover.ok, true);

    // The displaced pipeline's own next calls, still carrying its ORIGINAL
    // runId, read as cancelled — never 'proceed', regardless of which step.
    assert.equal(registry.admitStep('proj-a', displaced.runId, { stepId: 'tests', pastCancelBoundary: false }), 'cancelled');
    assert.equal(registry.isCancelRequested('proj-a', displaced.runId), true);
    // The takeover itself is completely unaffected.
    assert.equal(registry.admitStep('proj-a', takeover.runId, { stepId: 'tests', pastCancelBoundary: false }), 'proceed');
    assert.equal(registry.isCancelRequested('proj-a', takeover.runId), false);
  });

  it('the displaced-cancelled marker is cleared once the displaced pipeline itself calls finish, late', () => {
    const displaced = registry.begin('proj-a', 1);
    fakeNow += registry.STALE_RUN_MS;
    registry.begin('proj-a', 2);
    assert.equal(registry.isCancelRequested('proj-a', displaced.runId), true);

    registry.finish('proj-a', displaced.runId, { ok: false, tag: 'zombie' });
    assert.equal(registry.isCancelRequested('proj-a', displaced.runId), false,
      'nothing will ever ask on this runId\'s behalf again, so the marker has nothing left to do');
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

    // #1321 — `anyRunning` is restart's only caller, so every stale project it
    // walks past is a moment it just permitted a restart a live run would have
    // refused. The warning must fire once, not on every restart attempt.
    it('anyRunning warns once per stale run at the restart site, via warnStale', () => {
      const warnings = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      const { setLevel } = require('../lib/logger');
      setLevel('warn');
      process.stdout.write = (chunk, ...rest) => {
        const text = String(chunk);
        if (text.includes('Stale wrap run permitted an action')) warnings.push(text);
        return origWrite(chunk, ...rest);
      };
      try {
        const claim = registry.begin('proj-a', 1);
        fakeNow += registry.STALE_RUN_MS;
        assert.equal(registry.anyRunning(), null, 'the stale run no longer blocks restart');
        assert.equal(warnings.length, 1, 'warned once for this stale run at the restart site');
        assert.match(warnings[0], /proj-a/);
        assert.match(warnings[0], new RegExp(claim.runId));

        // A second restart attempt against the SAME stale run must not warn again.
        registry.anyRunning();
        assert.equal(warnings.length, 1, 'one-shot — the same run is never warned twice at the same site');

        // A takeover replaces the runId; the NEW run going stale
        // later is a fresh event, warned again.
        const takeover = registry.begin('proj-a', 2);
        fakeNow += registry.STALE_RUN_MS;
        registry.anyRunning();
        assert.equal(warnings.length, 2, 'a different run id re-arms the latch');
        assert.match(warnings[1], new RegExp(takeover.runId));
      } finally {
        process.stdout.write = origWrite;
        setLevel('error');
      }
    });

    it('warnStale is a no-op for a project with no run, a live run, or an already-settled one', () => {
      // No run at all.
      registry.warnStale('never-wrapped', 'restart');
      // Live run.
      registry.begin('proj-a', 1);
      registry.warnStale('proj-a', 'restart');
      // Settled run, however old.
      finish('proj-a', { ok: true });
      fakeNow += registry.STALE_RUN_MS * 2;
      registry.warnStale('proj-a', 'restart');
      // None of the above throw, and none of it is assertable beyond "it does
      // not throw" without hooking the logger — covered precisely by the
      // explicit one-shot test above for the one case that DOES log.
      assert.ok(true);
    });

    it('anyRunning still names a live wrap when another project holds a wedged one', () => {
      registry.begin('proj-wedged', 1);
      fakeNow += registry.STALE_RUN_MS;
      registry.begin('proj-live', 2);
      // Insertion order puts the wedged project first, so a reader that stops
      // at the first truthy `running` would answer with it.
      assert.equal(registry.anyRunning(), 'proj-live');
    });

    // #1321 — found at Critic cumulative review (rev-20261027T200007Z-2b646b7e):
    // a stale project's warning must not fire when a DIFFERENT project is
    // live, because the restart `anyRunning` gates is refused by that live
    // project regardless — warning there would claim an action happened that
    // did not (warnStale's own contract: only when actually permitting
    // something a live run would have refused).
    it('anyRunning does not warn about a stale project when another project is live — the restart was not actually permitted', () => {
      const warnings = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      const { setLevel: setLvl } = require('../lib/logger');
      setLvl('warn');
      process.stdout.write = (chunk, ...rest) => {
        const text = String(chunk);
        if (text.includes('Stale wrap run permitted an action')) warnings.push(text);
        return origWrite(chunk, ...rest);
      };
      try {
        registry.begin('proj-wedged', 1);
        fakeNow += registry.STALE_RUN_MS;
        registry.begin('proj-live', 2);
        assert.equal(registry.anyRunning(), 'proj-live', 'the restart IS refused, by the live project');
        assert.equal(warnings.length, 0, 'proj-wedged did not get to "permit" anything — the live project already blocked it');

        // Once the live project also settles, the stale one really is what
        // lets the restart through, and NOW it warns.
        registry.finish('proj-live', registry.get('proj-live').runId, { ok: true });
        assert.equal(registry.anyRunning(), null);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /proj-wedged/);
      } finally {
        process.stdout.write = origWrite;
        setLvl('error');
      }
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

    it('begin still takes over a wedged run — short of its cancel boundary, untouched behaviour (#1805)', () => {
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

  // #1816 — the durable checkpoint trail and the restart-recovery read. The
  // store itself is not exercised here (no `store.init()` in this file, by
  // design — see `_internal.projectIdFor`'s own doc): these pin WHEN the
  // registry writes a checkpoint and HOW `get()` composes a recovery read,
  // through the same `_internal` seams `now`/`newRunId` already use.
  describe('interrupted-run recovery (#1816)', () => {
    const origPersist = registry._internal.persistCheckpoint;
    const origSettled = registry._internal.markSettled;
    const origRecover = registry._internal.readInterruptedCheckpoint;
    let checkpoints;

    beforeEach(() => {
      checkpoints = [];
      registry._internal.persistCheckpoint = (project, run) => {
        checkpoints.push({
          project, runId: run.runId, currentStepId: run.currentStepId, committed: run.cancellable === false
        });
      };
      registry._internal.markSettled = (project, runId) => {
        checkpoints.push({ project, runId, settled: true });
      };
      registry._internal.readInterruptedCheckpoint = () => null;
    });

    afterEach(() => {
      registry._internal.persistCheckpoint = origPersist;
      registry._internal.markSettled = origSettled;
      registry._internal.readInterruptedCheckpoint = origRecover;
    });

    it('persists a checkpoint on begin, on every step-start, and when the run passes its cancel boundary', () => {
      const { runId } = registry.begin('proj-a', 1);
      assert.deepEqual(checkpoints[0], { project: 'proj-a', runId, currentStepId: null, committed: false });

      emit('proj-a', { type: 'step-start', stepId: 'memory-update' });
      assert.deepEqual(checkpoints[1], { project: 'proj-a', runId, currentStepId: 'memory-update', committed: false });

      // A non-step-start event does not checkpoint.
      emit('proj-a', { type: 'step-done', stepId: 'memory-update' });
      assert.equal(checkpoints.length, 2, 'step-done is not a checkpoint moment');

      assert.equal(registry.admitStep('proj-a', runId, { stepId: 'commit', pastCancelBoundary: true }), 'proceed');
      assert.deepEqual(checkpoints[2], { project: 'proj-a', runId, currentStepId: 'memory-update', committed: true });

      // Admitting a LATER step past the boundary does not checkpoint again —
      // `cancellable` only flips once.
      assert.equal(registry.admitStep('proj-a', runId, { stepId: 'push', pastCancelBoundary: true }), 'proceed');
      assert.equal(checkpoints.length, 3, 'the cancellable flip checkpoints once, not on every later step');

      finish('proj-a', { ok: true });
      assert.deepEqual(checkpoints[3], { project: 'proj-a', runId, settled: true });
    });

    it('a cancelled run never flips cancellable and so never checkpoints "committed"', () => {
      const { runId } = registry.begin('proj-a', 1);
      registry.requestCancel('proj-a', runId);
      assert.equal(registry.admitStep('proj-a', runId, { stepId: 'commit', pastCancelBoundary: true }), 'cancelled');
      assert.ok(!checkpoints.some((c) => c.committed === true), 'the commit step was never admitted — nothing to report as started');
    });

    it('get reports no interrupted run while this process holds one in memory', () => {
      registry._internal.readInterruptedCheckpoint = () => ({
        runId: 'ffff', lastStepId: 'commit', commitStarted: true, checkpointAt: '2026-01-01T00:00:00Z'
      });
      registry.begin('proj-a', 1);
      const status = registry.get('proj-a');
      assert.equal(status.interrupted, false, 'an in-memory run is authoritative, never "interrupted"');
      assert.equal(status.interruptedStepId, null);
      assert.equal(status.interruptedCommitStarted, false);
    });

    it('get reports an interrupted run from the recovery read when this process holds none, and memoises it', () => {
      let calls = 0;
      registry._internal.readInterruptedCheckpoint = () => {
        calls += 1;
        return { runId: 'abc123', lastStepId: 'pr-check', commitStarted: true, checkpointAt: '2026-02-02T00:00:00Z' };
      };
      const first = registry.get('never-wrapped');
      assert.equal(first.interrupted, true);
      assert.equal(first.runId, 'abc123');
      assert.equal(first.interruptedStepId, 'pr-check');
      assert.equal(first.interruptedCommitStarted, true);
      assert.equal(first.interruptedAt, '2026-02-02T00:00:00Z');
      assert.equal(first.running, false);

      registry.get('never-wrapped');
      registry.get('never-wrapped');
      assert.equal(calls, 1, 'the recovery read runs at most once per project per process');
    });

    it('get reports nothing interrupted, and does not re-read, once the recovery read says so', () => {
      let calls = 0;
      registry._internal.readInterruptedCheckpoint = () => { calls += 1; return null; };
      assert.equal(registry.get('clean-project').interrupted, false);
      registry.get('clean-project');
      assert.equal(calls, 1, 'a "nothing interrupted" verdict is memoised too, not just a found one');
    });

    it('an unreadable recovery source reports nothing interrupted rather than throwing', () => {
      registry._internal.readInterruptedCheckpoint = () => { throw new Error('store not initialized'); };
      assert.doesNotThrow(() => {
        const status = registry.get('never-wrapped');
        assert.equal(status.interrupted, false);
      });
    });

    it('a fresh begin after recovery clears the memo\'s relevance without needing to clear it', () => {
      registry._internal.readInterruptedCheckpoint = () => ({
        runId: 'old-run', lastStepId: 'tests', commitStarted: false, checkpointAt: '2026-01-01T00:00:00Z'
      });
      assert.equal(registry.get('proj-a').interrupted, true, 'precondition: an interrupted run is reported');
      registry.begin('proj-a', 1);
      const status = registry.get('proj-a');
      assert.equal(status.interrupted, false, 'a live in-memory run always wins over the memo');
      assert.equal(status.running, true);
    });
  });
});
