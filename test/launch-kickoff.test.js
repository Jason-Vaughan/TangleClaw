'use strict';

/**
 * The launch kickoff (#1635).
 *
 * A silently primed session is handed its whole launch context as hidden model
 * context and asked nothing, so it sits at an empty prompt until a human types
 * or the unready monitor's window elapses. This module is the turn that was
 * missing, and the cases that matter are mostly the ones where it must NOT
 * fire: a pasted prime (which is itself a first turn), a launch with no
 * sequence to read, an engine with no probed pane signature, a pane that is
 * working or holds an unsent draft, and any second call at all.
 *
 * Every seam is stubbed. Typing into a real pane and reading a real store are
 * the two things these tests must not do.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const launchKickoff = require('../lib/launch-kickoff');

const REAL_SEAMS = { ...launchKickoff._internal };

/** A launch that SHOULD be kicked off, so each test names only its own deviation. */
const LIVE_LAUNCH = Object.freeze({
  sessionId: 42,
  projectId: 7,
  projectName: 'TangleClaw-Builder1',
  tmuxName: 'TangleClaw-Builder1',
  engineId: 'claude',
  silentPrime: true,
  hasSequence: true
});

describe('launch kickoff (#1635)', () => {
  let injected;
  let activity;
  let clock;

  beforeEach(() => {
    Object.assign(launchKickoff._internal, REAL_SEAMS);
    launchKickoff.reset();
    injected = [];
    activity = [];
    launchKickoff._internal.stepCount = () => 4;
    launchKickoff._internal.wakeProfiles = () => ({ claude: { busyMarker: 'esc to interrupt', promptRe: /^> / } });
    launchKickoff._internal.capturePane = () => ({ lines: ['> '], alternateScreen: false });
    launchKickoff._internal.cursorInfo = () => null;
    launchKickoff._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 });
    // A fake clock advanced by `sleep`, so the poll loop's real wall-clock
    // deadline is reached in a few iterations instead of spinning for the whole
    // window. Stubbing `sleep` alone would leave `now` real and busy-spin.
    clock = 0;
    launchKickoff._internal.now = () => clock;
    launchKickoff._internal.sleep = () => {
      clock += launchKickoff.IDLE_POLL_MS;
      return Promise.resolve();
    };
    launchKickoff._internal.inject = (projectName, command, options) => {
      injected.push({ projectName, command, options });
      return { ok: true, error: null };
    };
    launchKickoff._internal.logActivity = (entry) => activity.push(entry);
  });

  afterEach(() => {
    Object.assign(launchKickoff._internal, REAL_SEAMS);
    launchKickoff.reset();
  });

  describe('the defect it exists to close', () => {
    it('asks a silently primed session to read its context', async () => {
      // The regression pin. Before this module, a launch in exactly this state
      // had nothing typed into it at all and served its first step only when
      // the unready window elapsed or a human intervened.
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 1);
      assert.match(injected[0].command, /tc start next/);
      assert.equal(injected[0].projectName, 'TangleClaw-Builder1');
      assert.deepEqual(injected[0].options, { sessionId: 42 });
    });

    it('records that the line was sent, and claims nothing more', async () => {
      await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(activity.length, 1);
      assert.equal(activity[0].eventType, 'launch.kickoff');
      assert.equal(activity[0].sessionId, 42);
      assert.equal(activity[0].projectId, 7);
      // `sent` is the whole claim: typing bytes into a pane is not evidence the
      // engine consumed the turn, and the receipt that settles that is the
      // sequence's own pagesServed.
      assert.equal(activity[0].detail.observed, 'sent');
    });
  });

  describe('launches with no turn to restore', () => {
    it('leaves a pasted prime alone — the paste IS the first turn', async () => {
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH, silentPrime: false });

      assert.equal(outcome, 'not-silent');
      assert.equal(injected.length, 0);
    });

    it('sends nothing when the launch has no sequence to read', async () => {
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH, hasSequence: false });

      assert.equal(outcome, 'no-sequence');
      assert.equal(injected.length, 0);
    });

    it('sends nothing to a session with no pane', async () => {
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH, tmuxName: null });

      assert.equal(outcome, 'no-pane');
      assert.equal(injected.length, 0);
    });
  });

  describe('engine agnosticism', () => {
    it('refuses to type into an engine with no probed pane signature', async () => {
      // The standing engine-agnostic rule, enforced structurally: an engine
      // TangleClaw has never probed degrades to today's behaviour with a
      // recorded reason rather than being typed into on a guess.
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH, engineId: 'some-new-engine' });

      assert.equal(outcome, 'unprofiled-engine');
      assert.equal(injected.length, 0);
    });

    it('does not burn the one-shot on an engine it refused', async () => {
      await launchKickoff.kickoff({ ...LIVE_LAUNCH, engineId: 'some-new-engine' });
      // The refusal is about the engine, not about this session having had its
      // turn — a relaunch on a profiled engine must still be able to kick off.
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 1);
    });
  });

  describe('panes that must be left alone', () => {
    it('never types over an unsent draft', async () => {
      // The issue's explicit constraint: a retry must not submit whatever the
      // operator had half-typed. `composer-has-input` is the shared idle gate's
      // name for exactly that, and it is a refusal, not a delay.
      launchKickoff._internal.assessIdle = () => ({
        idle: false, reason: 'composer-has-input', digest: 'd', idleTicks: 0
      });

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'pane-busy');
      assert.equal(injected.length, 0);
    });

    it('never types into a pane that is working', async () => {
      launchKickoff._internal.assessIdle = () => ({ idle: false, reason: 'working', digest: 'd', idleTicks: 0 });

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'pane-busy');
      assert.equal(injected.length, 0);
    });

    it('gives up rather than looping when the pane can never be read', async () => {
      launchKickoff._internal.capturePane = () => { throw new Error('no server running'); };

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'pane-busy');
      assert.equal(injected.length, 0);
    });

    it('judges by the text check when the cursor probe fails', async () => {
      // Best-effort, exactly as the unready monitor treats it: a pane that
      // cannot report a cursor must not lose its kickoff to a tmux query that
      // failed while the pane itself read fine.
      launchKickoff._internal.cursorInfo = () => { throw new Error('cursor unavailable'); };

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 1);
    });

    it('waits for a pane that settles, rather than refusing the first glance', async () => {
      let looks = 0;
      launchKickoff._internal.assessIdle = () => {
        looks += 1;
        return looks < 3
          ? { idle: false, reason: 'pane-writing', digest: `d${looks}`, idleTicks: 0 }
          : { idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 };
      };

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 1);
    });
  });

  describe('at most once', () => {
    it('refuses a second call for the same session', async () => {
      await launchKickoff.kickoff({ ...LIVE_LAUNCH });
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'already-fired');
      assert.equal(injected.length, 1);
    });

    it('does not re-send after a failed send', async () => {
      // Marked before the send, not after: a duplicate turn is the worse
      // failure, and `launch-unready` is already the backstop for a send that
      // never landed.
      launchKickoff._internal.inject = () => ({ ok: false, error: 'pane gone' });
      const first = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      launchKickoff._internal.inject = (projectName, command, options) => {
        injected.push({ projectName, command, options });
        return { ok: true, error: null };
      };
      const second = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(first, 'inject-failed');
      assert.equal(second, 'already-fired');
      assert.equal(injected.length, 0);
    });

    it('forgets the oldest sessions rather than growing without bound', async () => {
      // Nothing tells this module a session ended, so the set needs its own
      // ceiling. Dropping the oldest is safe because session ids only increase.
      for (let i = 0; i < launchKickoff.FIRED_MEMORY; i += 1) {
        await launchKickoff.kickoff({ ...LIVE_LAUNCH, sessionId: 1000 + i });
      }
      assert.equal(launchKickoff._fired.size, launchKickoff.FIRED_MEMORY);

      await launchKickoff.kickoff({ ...LIVE_LAUNCH, sessionId: 9999 });

      assert.equal(launchKickoff._fired.size, launchKickoff.FIRED_MEMORY);
      assert.ok(!launchKickoff._fired.has(1000), 'the oldest session was evicted');
      assert.ok(launchKickoff._fired.has(9999), 'the newest session is remembered');
    });

    it('tracks sessions independently', async () => {
      await launchKickoff.kickoff({ ...LIVE_LAUNCH });
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH, sessionId: 43 });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 2);
    });
  });

  describe('the line itself', () => {
    it('is a single line, so one Enter submits the whole sentence', () => {
      assert.ok(!launchKickoff.kickoffLine(4).includes('\n'));
    });

    it('states that reading authorizes nothing', () => {
      // The kickoff is the first thing the session acts on, and "begin reading"
      // sits one word away from "begin working". The line has to close that
      // itself, because the confirmation gates it must not override are in a
      // prime this line does not repeat.
      assert.match(launchKickoff.kickoffLine(4), /authorize nothing/);
    });

    it('counts the steps it was given rather than assuming four', () => {
      assert.match(launchKickoff.kickoffLine(6), /0 of 6 step\(s\)/);
    });
  });

  describe('honest states', () => {
    it('gives every outcome it can return a declared meaning', async () => {
      // A code with no meaning here is a state nobody can explain — the same
      // contract `launch-unready` holds itself to.
      const produced = new Set();
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH, hasSequence: false }));
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH, silentPrime: false }));
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH, tmuxName: null }));
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH, engineId: 'unknown-engine' }));
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH }));
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH }));

      launchKickoff.reset();
      launchKickoff._internal.inject = () => ({ ok: false, error: 'gone' });
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH }));

      launchKickoff.reset();
      launchKickoff._internal.assessIdle = () => ({ idle: false, reason: 'working', digest: 'd', idleTicks: 0 });
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH }));

      for (const code of produced) {
        assert.ok(launchKickoff.OUTCOME_MEANINGS[code], `outcome "${code}" has no declared meaning`);
      }
      // Every declared meaning is reachable, so the table cannot accumulate
      // states the code stopped producing.
      assert.deepEqual(
        [...produced].sort(),
        Object.keys(launchKickoff.OUTCOME_MEANINGS).sort()
      );
    });

    it('never throws, whatever the pane does', async () => {
      launchKickoff._internal.capturePane = () => { throw new Error('boom'); };
      launchKickoff._internal.cursorInfo = () => { throw new Error('boom'); };

      await assert.doesNotReject(() => launchKickoff.kickoff({ ...LIVE_LAUNCH }));
    });
  });
});

/**
 * The hop between the launch path and the kickoff.
 *
 * The unit tests above prove the module decides correctly; these prove the
 * launch actually calls it, and with the launch's own facts. A decision nothing
 * invokes is the failure this project has already paid for once — the 2026-09-14
 * live check found a widget and a server that both worked with nothing
 * connecting them.
 */
describe('the launch path reaches the kickoff (#1635)', () => {
  const sessions = require('../lib/sessions');
  const realKickoff = launchKickoff.kickoff;
  let calls;

  const ENGINE_PROFILE = Object.freeze({ capabilities: { supportsPrimePrompt: true }, launch: {} });

  beforeEach(() => {
    calls = [];
    launchKickoff.kickoff = (args) => {
      calls.push(args);
      return Promise.resolve('sent');
    };
  });

  afterEach(() => {
    launchKickoff.kickoff = realKickoff;
  });

  /** Let the deferred timer fire. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('hands the kickoff the launch it was given', async () => {
    sessions._deferEngineInit(
      'tc-builder1', 'TangleClaw-Builder1', 'claude', ENGINE_PROFILE,
      'the prime', null, true, null,
      { sessionId: 99, projectId: 3, hasSequence: true }
    );
    await settle();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      sessionId: 99,
      projectId: 3,
      projectName: 'TangleClaw-Builder1',
      tmuxName: 'tc-builder1',
      engineId: 'claude',
      silentPrime: true,
      hasSequence: true
    });
  });

  it('carries a launch with no sequence through rather than deciding for it', async () => {
    // The branch must not pre-empt the module's own `no-sequence` answer: one
    // place decides, so there is one place to read when the answer is wrong.
    sessions._deferEngineInit(
      'tc-builder1', 'TangleClaw-Builder1', 'claude', ENGINE_PROFILE,
      'the prime', null, true, null,
      { sessionId: 99, projectId: 3, hasSequence: false }
    );
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasSequence, false);
  });

  it('does not kick off a launch whose prime was pasted', async () => {
    sessions._deferEngineInit(
      'tc-builder1', 'TangleClaw-Builder1', 'claude', ENGINE_PROFILE,
      'the prime', null, false, null,
      { sessionId: 99, projectId: 3, hasSequence: true }
    );
    await settle();

    assert.equal(calls.length, 0);
  });

  it('does not kick off a caller that is not launching a session', async () => {
    sessions._deferEngineInit(
      'tc-builder1', 'TangleClaw-Builder1', 'claude', ENGINE_PROFILE,
      'the prime', null, true, null, null
    );
    await settle();

    assert.equal(calls.length, 0);
  });
});
