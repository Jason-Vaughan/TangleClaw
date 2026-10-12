'use strict';

/*
 * The automatic bootstrap at launch (#1825 B3, Architect F1–F4).
 *
 * A native launch gets exactly one automatic attempt through the shared fire
 * service, after the pane gate, under a deterministic key and the internal
 * launch caller. The gate is the engine adapter's own launch-readiness read
 * where the adapter has one (#2059), and the at-rest marker only where it has
 * none; a gate that never passes still produces the audited attempt,
 * carried as a launch-only pre-send result the service settles as
 * `pane_not_ready`, and this module never touches the pane or the store. A
 * legacy launch asks the same service so its reason is recorded, and is left
 * to its paste or kickoff.
 *
 * Every seam is stubbed: no store, no pane, no adapter.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const launchBootstrap = require('../lib/launch-bootstrap');
const startupPrompt = require('../lib/startup-prompt');

const REAL = { ...launchBootstrap._internal };

const NATIVE = Object.freeze({
  sessionId: 42, projectId: 7, projectName: 'TangleClaw-Builder1', tmuxName: 'tc-b1',
  engineId: 'codex', hasSequence: true, startupDelivery: 'native'
});

describe('launch bootstrap (#1825 B3)', () => {
  let fires;
  let activity;
  let readiness;
  let answer;
  let gate;
  let gateAsks;
  let markerAsks;

  beforeEach(() => {
    Object.assign(launchBootstrap._internal, REAL);
    launchBootstrap.reset();
    fires = [];
    activity = [];
    readiness = { gated: true, ready: true, waitedMs: 1200 };
    answer = () => ({ status: 200, body: { fire: { id: 5, outcome: 'accepted', reasonCode: null }, duplicate: false } });
    launchBootstrap._internal.getSequence = (sid) => (sid === 42 ? { id: 100, sessionId: 42, cursor: 0 } : null);
    launchBootstrap._internal.currentPrompt = () => ({ revision: 3 });
    // Unless a case says otherwise, the engine's adapter has no launch-readiness
    // read, which is the one case in which the marker gate below is the gate.
    gate = { answer: 'unsupported' };
    gateAsks = [];
    markerAsks = 0;
    launchBootstrap._internal.launchGate = async (launch) => { gateAsks.push(launch); return typeof gate === 'function' ? gate() : gate; };
    launchBootstrap._internal.awaitPaneReady = async () => { markerAsks += 1; return readiness; };
    launchBootstrap._internal.fire = async (input) => { fires.push(input); return answer(input); };
    launchBootstrap._internal.logActivity = (entry) => activity.push(entry);
  });

  afterEach(() => {
    Object.assign(launchBootstrap._internal, REAL);
    launchBootstrap.reset();
  });

  describe('the native path', () => {
    it('fires once through the service after the pane gate, under the launch key and the internal caller', async () => {
      const outcome = await launchBootstrap.bootstrap({ ...NATIVE });
      assert.equal(outcome, 'fired');
      assert.equal(fires.length, 1);
      const f = fires[0];
      assert.equal(f.projectName, 'TangleClaw-Builder1');
      assert.equal(f.sessionId, 42);
      assert.equal(f.sequenceId, 100);
      assert.equal(f.expectedRevision, 3);
      assert.equal(f.idempotencyKey, launchBootstrap.attemptKey(100, 3));
      assert.equal(f.idempotencyKey, 'launch-100-r3');
      assert.match(f.idempotencyKey, startupPrompt.IDEMPOTENCY_KEY_PATTERN, 'the key passes the service\'s own validation');
      assert.deepEqual(f.caller, startupPrompt.launchCaller({ sessionId: 42, projectId: 7 }));
      assert.equal(f.caller.kind, startupPrompt.LAUNCH_CALLER_KIND);
      assert.equal(f.clearance, startupPrompt.LAUNCH_CLEARANCE);
      assert.equal(f.paneGate.ready, true);
      assert.equal(activity.length, 1);
      assert.equal(activity[0].eventType, 'launch.bootstrap');
      assert.deepEqual(activity[0].detail, { sequenceId: 100, startupDelivery: 'native', outcome: 'fired', fireId: 5, reasonCode: null });
    });

    it('a pane that never becomes ready still produces the audited attempt, carried as a gate result the service can only settle blocked', async () => {
      readiness = { gated: true, ready: false, waitedMs: 90000, reason: 'the at-rest marker never appeared' };
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 6, outcome: 'blocked', reasonCode: 'pane_not_ready' }, reasonCode: 'pane_not_ready' } });
      const outcome = await launchBootstrap.bootstrap({ ...NATIVE });
      assert.equal(outcome, 'not-sent');
      assert.equal(fires.length, 1, 'the attempt goes through the service exactly once');
      assert.deepEqual(fires[0].paneGate, { ready: false, reason: 'the at-rest marker never appeared' });
      assert.equal(activity[0].detail.reasonCode, 'pane_not_ready');
    });

    it('an engine with no at-rest marker cannot be observed ready, and says so rather than sending', async () => {
      readiness = { gated: false, reason: 'engine codex declares no positive at-rest marker' };
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 7, outcome: 'blocked', reasonCode: 'pane_not_ready' } } });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
      assert.equal(fires[0].paneGate.ready, false);
      assert.match(fires[0].paneGate.reason, /no positive at-rest marker/);
    });

    it('a readiness gate that throws is a gate that did not pass', async () => {
      launchBootstrap._internal.awaitPaneReady = async () => { throw new Error('tmux gone'); };
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 8, outcome: 'blocked', reasonCode: 'pane_not_ready' } } });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
      assert.equal(fires[0].paneGate.ready, false);
      assert.match(fires[0].paneGate.reason, /tmux gone/);
    });

    it('a native session with no pane is not observed ready', async () => {
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 9, outcome: 'blocked', reasonCode: 'pane_not_ready' } } });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE, tmuxName: null }), 'not-sent');
      assert.equal(fires[0].paneGate.ready, false);
    });

    it('the adapter\'s own pre-send blocker is reported as not sent, never retried, and never pasted', async () => {
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 10, outcome: 'blocked', reasonCode: 'trust_required' } } });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
      assert.equal(fires.length, 1);
      assert.equal(activity[0].detail.reasonCode, 'trust_required');
    });

    it('retries exactly once at the new revision when the prompt was saved between the read and the fire', async () => {
      let rev = 3;
      launchBootstrap._internal.currentPrompt = () => ({ revision: rev });
      answer = (input) => {
        if (input.expectedRevision === 3) { rev = 4; return { status: 409, body: { code: 'STALE_STARTUP_PROMPT', currentRevision: 4 } }; }
        return { status: 200, body: { fire: { id: 11, outcome: 'accepted', reasonCode: null } } };
      };
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'fired');
      assert.deepEqual(fires.map((f) => f.idempotencyKey), ['launch-100-r3', 'launch-100-r4']);
    });
  });

  describe('the native path, gated by the engine adapter\'s own launch-readiness read (#2059)', () => {
    const BLOCKED = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 20, outcome: 'blocked', reasonCode: 'pane_not_ready' }, reasonCode: 'pane_not_ready' } });

    it('asks the adapter for this launch, and a ready answer fires once without the marker gate ever being consulted', async () => {
      gate = { answer: 'ready' };
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'fired');
      assert.deepEqual(gateAsks, [{ sessionId: 42, sequenceId: 100, engineId: 'codex' }]);
      assert.equal(markerAsks, 0);
      assert.equal(fires.length, 1);
      assert.deepEqual(fires[0].paneGate, { ready: true, reason: 'the launch\'s thread was idle and its pane showed an empty composer', proof: 'adapter' });
    });

    it('AN ADAPTER WITHOUT THE METHOD falls back to the marker gate: unsupported is the only answer that does', async () => {
      gate = { answer: 'unsupported' };
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'fired');
      assert.equal(markerAsks, 1);
      assert.deepEqual(fires[0].paneGate, { ready: true, reason: 'the pane rendered its at-rest marker over a settled transcript' });
      assert.equal('proof' in fires[0].paneGate, false);
    });

    it('AN ADAPTER WITH THE METHOD THAT CANNOT ANSWER ends pane_not_ready with nothing sent, and the marker gate is never consulted even though the pane shows the marker', async () => {
      const cannot = [
        ['its channel, pane or thread could not answer', { answer: 'unknown', unavailable: true, observation: 'the engine adapter failed while reading launch readiness', remedy: null, whole: null }],
        ['its call timed out', { answer: 'unknown', unavailable: true, observation: 'the engine adapter did not answer the launch-readiness read in time', remedy: null, whole: null }],
        ['the read threw', () => { throw new Error('boom'); }],
        ['it answered nothing', null],
        ['it answered a word nobody defined', { answer: 'maybe' }]
      ];
      for (const [name, answerOf] of cannot) {
        launchBootstrap.reset();
        fires = [];
        markerAsks = 0;
        readiness = { gated: true, ready: true, waitedMs: 10 };
        gate = answerOf;
        answer = BLOCKED;
        assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent', name);
        assert.equal(markerAsks, 0, `${name}: a runtime unknown never passes by the status marker`);
        assert.equal(fires.length, 1, name);
        assert.equal(fires[0].paneGate.ready, false, name);
        assert.equal(fires[0].paneGate.proof, 'adapter', name);
        assert.equal(fires[0].paneGate.unavailable, true, `${name}: a proof that could not be made`);
        assert.ok(fires[0].paneGate.reason, name);
      }
    });

    it('unsupported and unknown are different answers, and only one of them reaches the marker', async () => {
      const outcomes = {};
      for (const word of ['unsupported', 'unknown']) {
        launchBootstrap.reset();
        fires = [];
        markerAsks = 0;
        gate = { answer: word, unavailable: true, observation: 'x' };
        await launchBootstrap.bootstrap({ ...NATIVE });
        outcomes[word] = { markerAsks, ready: fires[0].paneGate.ready };
      }
      assert.deepEqual(outcomes, { unsupported: { markerAsks: 1, ready: true }, unknown: { markerAsks: 0, ready: false } });
    });

    it('a pane the adapter saw not ready at the window\'s end is one attempt, carrying its last observation, its remedy, and that it was SEEN', async () => {
      gate = { answer: 'not-ready', unavailable: false, observation: 'the pane was not at an empty composer: the composer holds typed text', remedy: 'Press Fire startup prompt once the pane shows an empty composer.', whole: null };
      answer = BLOCKED;
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
      assert.equal(fires.length, 1, 'recorded once, never retried');
      assert.deepEqual(fires[0].paneGate, {
        ready: false, proof: 'adapter', unavailable: false,
        reason: 'the pane was not at an empty composer: the composer holds typed text',
        remedy: 'Press Fire startup prompt once the pane shows an empty composer.'
      });
      assert.equal(activity[0].detail.reasonCode, 'pane_not_ready');
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'already-fired');
      assert.equal(fires.length, 1);
    });

    it('an unreadable pane and an unanswering channel are each carried as a proof that was unavailable', async () => {
      for (const observation of ['the pane could not be read', 'the app-server did not answer']) {
        launchBootstrap.reset();
        fires = [];
        gate = { answer: 'not-ready', unavailable: true, observation, remedy: 'Press Fire startup prompt once the pane shows an empty composer.', whole: null };
        answer = BLOCKED;
        assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
        assert.equal(fires[0].paneGate.unavailable, true, observation);
        assert.equal(fires[0].paneGate.reason, observation);
      }
    });

    it('a whole sentence from the adapter (a profile fault) is carried as it is', async () => {
      gate = { answer: 'not-ready', unavailable: false, observation: 'o', remedy: null, whole: 'The engine profile declares no starting pattern.' };
      answer = BLOCKED;
      await launchBootstrap.bootstrap({ ...NATIVE });
      assert.equal(fires[0].paneGate.whole, 'The engine profile declares no starting pattern.');
      assert.equal('remedy' in fires[0].paneGate, false);
    });

    it('A READY GATE FOLLOWED BY A REFUSED LAST LOOK IS ONE ROW, NOT TWO: the fire\'s own blocked answer is the outcome and nothing is tried again', async () => {
      gate = { answer: 'ready' };
      answer = BLOCKED;
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'not-sent');
      assert.equal(fires.length, 1);
      assert.equal(fires[0].paneGate.ready, true);
      assert.equal(activity.length, 1);
      assert.deepEqual(activity[0].detail, { sequenceId: 100, startupDelivery: 'native', outcome: 'not-sent', fireId: 20, reasonCode: 'pane_not_ready' });
    });

    it('a legacy launch never asks the adapter, and a native session with no pane asks nothing', async () => {
      answer = () => ({ status: 409, body: { code: 'STARTUP_CONTROL_UNSUPPORTED', fire: { id: 12, outcome: 'unsupported', reasonCode: 'engine_declares_none' } } });
      await launchBootstrap.bootstrap({ ...NATIVE, startupDelivery: 'legacy' });
      assert.deepEqual(gateAsks, []);
      assert.equal(markerAsks, 0);
      launchBootstrap.reset();
      answer = BLOCKED;
      await launchBootstrap.bootstrap({ ...NATIVE, tmuxName: null });
      assert.deepEqual(gateAsks, []);
      assert.equal(markerAsks, 0);
    });

    it('the real seam asks the fire service\'s launchGate', () => {
      assert.equal(typeof REAL.launchGate, 'function');
      assert.equal(typeof startupPrompt.launchGate, 'function');
    });
  });

  describe('the legacy path', () => {
    it('asks the same service with the same caller so the reason is recorded, and carries no gate result', async () => {
      answer = () => ({ status: 409, body: { code: 'STARTUP_CONTROL_UNSUPPORTED', fire: { id: 12, outcome: 'unsupported', reasonCode: 'engine_declares_none' }, reasonCode: 'engine_declares_none' } });
      const outcome = await launchBootstrap.bootstrap({ ...NATIVE, engineId: 'claude', startupDelivery: 'legacy' });
      assert.equal(outcome, 'legacy-recorded');
      assert.equal(fires.length, 1);
      assert.equal('paneGate' in fires[0], false, 'a legacy launch waits on no pane');
      assert.equal(fires[0].caller.kind, 'launch');
      assert.equal(activity[0].detail.startupDelivery, 'legacy');
      assert.equal(activity[0].detail.reasonCode, 'engine_declares_none');
    });

    it('a supported engine whose channel never started records the adapter\'s blocked answer', async () => {
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 13, outcome: 'blocked', reasonCode: 'channel_unavailable' } } });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE, startupDelivery: 'legacy' }), 'legacy-recorded');
      assert.equal(activity[0].detail.reasonCode, 'channel_unavailable');
    });
  });

  describe('launches with nothing to do, and the one-shot', () => {
    it('does nothing for a launch with no sequence', async () => {
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE, hasSequence: false }), 'no-sequence');
      assert.equal(fires.length, 0);
      assert.equal(activity.length, 0);
    });

    it('is at most once per session, claimed before the send', async () => {
      let resolveFire;
      launchBootstrap._internal.fire = () => new Promise((resolve) => { resolveFire = resolve; });
      const first = launchBootstrap.bootstrap({ ...NATIVE });
      await new Promise((r) => setImmediate(r));
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'already-fired', 'while the first is still in flight');
      resolveFire({ status: 200, body: { fire: { id: 1, outcome: 'accepted' } } });
      assert.equal(await first, 'fired');
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'already-fired');
    });

    it('gives the shot back when the launch was gone before anything was asked', async () => {
      launchBootstrap._internal.getSequence = () => null;
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'session-gone');
      assert.equal(fires.length, 0);
      launchBootstrap._internal.getSequence = () => ({ id: 100, cursor: 0 });
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'fired', 'a later call may still try');
    });

    it('maps the service\'s target refusals to session-gone and its slot refusals to already-fired, without throwing', async () => {
      for (const [code, expected] of [['SESSION_NOT_FOUND', 'session-gone'], ['LAUNCH_NOT_CURRENT', 'session-gone'], ['STARTUP_PROMPT_ALREADY_APPLIED', 'already-fired'], ['STARTUP_FIRE_IN_FLIGHT', 'already-fired'], ['IDEMPOTENCY_KEY_REUSED', 'service-refused']]) {
        launchBootstrap.reset();
        fires = [];
        answer = () => ({ status: 409, body: { code } });
        assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), expected, code);
      }
    });

    it('never rejects, whatever the service does', async () => {
      launchBootstrap._internal.fire = async () => { throw new Error('boom'); };
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'service-refused');
      launchBootstrap.reset();
      launchBootstrap._internal.currentPrompt = () => { throw new Error('no prompt'); };
      assert.equal(await launchBootstrap.bootstrap({ ...NATIVE }), 'service-refused');
    });

    it('every declared outcome is reachable', async () => {
      const produced = new Set();
      const run = async (args) => produced.add(await launchBootstrap.bootstrap(args));
      await run({ ...NATIVE, hasSequence: false });
      await run({ ...NATIVE });
      await run({ ...NATIVE });
      launchBootstrap.reset();
      answer = () => ({ status: 409, body: { code: 'STARTUP_FIRE_BLOCKED', fire: { id: 2, outcome: 'blocked', reasonCode: 'engine_not_ready' } } });
      await run({ ...NATIVE });
      launchBootstrap.reset();
      answer = () => ({ status: 409, body: { code: 'STARTUP_CONTROL_UNSUPPORTED', fire: { id: 3, outcome: 'unsupported' } } });
      await run({ ...NATIVE, startupDelivery: 'legacy' });
      launchBootstrap.reset();
      answer = () => ({ status: 404, body: { code: 'SESSION_NOT_FOUND' } });
      await run({ ...NATIVE });
      launchBootstrap.reset();
      answer = () => ({ status: 500, body: { code: 'INTERNAL_ERROR' } });
      await run({ ...NATIVE });
      assert.deepEqual([...produced].sort(), Object.keys(launchBootstrap.OUTCOME_MEANINGS).sort());
    });
  });
});
