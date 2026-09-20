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

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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
    // A sequence nobody has begun: the shape that earns a kickoff.
    launchKickoff._internal.getSequence = () => ({ id: 1, cursor: 0 });
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

  describe('a session that no longer needs asking', () => {
    it('leaves a session that has already begun reading alone', async () => {
      // The whole point of the window is that something else may move in it —
      // a human typing is one of the two launches on the record. Sending now
      // would tell a session that is mid-read to begin reading.
      launchKickoff._internal.getSequence = () => ({ id: 1, cursor: 1 });

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'already-begun');
      assert.equal(injected.length, 0);
    });

    it('can still kick off a session that began and was rolled back', async () => {
      // Nothing was typed, so the one-shot was not spent.
      launchKickoff._internal.getSequence = () => ({ id: 1, cursor: 1 });
      await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      launchKickoff._internal.getSequence = () => ({ id: 1, cursor: 0 });
      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sent');
      assert.equal(injected.length, 1);
    });

    it('says so when the sequence is gone by the time the pane comes free', async () => {
      launchKickoff._internal.getSequence = () => null;

      const outcome = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(outcome, 'sequence-gone');
      assert.equal(injected.length, 0);
    });
  });

  describe('the window is long enough for a slow boot', () => {
    it('outlasts the 41-second boot that sized the readiness gate', () => {
      // A horizon shorter than a real slow boot expires while the engine is
      // still starting, which is the ten-minute wait this module removes
      // arriving by another route.
      const { PANE_READY_TIMEOUT_MS } = require('../lib/sessions');
      assert.ok(launchKickoff.IDLE_TIMEOUT_MS >= PANE_READY_TIMEOUT_MS,
        'the kickoff gives a booting pane at least as long as the prime paste does');
    });

    it('gives the shot back when the pane never came free', async () => {
      // Claiming the shot protects against a SECOND turn. A window that
      // expired without typing never risked one, and keeping the claim would
      // spend the kickoff on exactly the slow boot that needs it most.
      launchKickoff._internal.assessIdle = () => ({ idle: false, reason: 'working', digest: 'd', idleTicks: 0 });
      const first = await launchKickoff.kickoff({ ...LIVE_LAUNCH });
      assert.equal(first, 'pane-busy');
      assert.ok(!launchKickoff._fired.has(LIVE_LAUNCH.sessionId), 'the one-shot was not spent');

      launchKickoff._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 });
      const second = await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(second, 'sent');
      assert.equal(injected.length, 1);
    });
  });

  describe('it carries no rules', () => {
    it('writes a kickoff activity entry and nothing else', async () => {
      // Direction §4: a delivery row for a line that carries no rules is the
      // true-but-useless accounting the ledger exists to keep out. The hook
      // delivered the rules; this line delivers none.
      await launchKickoff.kickoff({ ...LIVE_LAUNCH });

      assert.equal(activity.length, 1);
      assert.equal(activity[0].eventType, 'launch.kickoff');
      assert.deepEqual(activity[0].detail, { observed: 'sent' });
    });

    it('cannot reach the rule-delivery ledger at all', () => {
      // Structural, because the guarantee is an absence: the module has no
      // seam that could write a delivery row, so no future edit can add one
      // without this failing first.
      //
      // Comments are stripped before the scan. The module's own docstring
      // names the ledger in order to say it never writes to it, and a guard
      // that cannot tell an explanation from a call would fire on the prose
      // that documents the very property it is checking.
      const raw = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/launch-kickoff.js'), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!code.includes('session_rule_deliveries'), 'no rules table');
      assert.ok(!code.includes('_recordRuleDelivery'), 'no rules recorder');
      assert.ok(!code.includes('session-rules-channel'), 'no rules channel');
      assert.deepEqual(
        Object.keys(launchKickoff._internal).filter((k) => /rule/i.test(k)),
        [],
        'no rules-shaped seam'
      );
    });
  });

  describe('the line itself', () => {
    it('is a single line, so one Enter submits the whole sentence', () => {
      assert.ok(!launchKickoff.kickoffLine({ cursor: 0 }, 4).includes('\n'));
    });

    it('states that reading authorizes nothing', () => {
      // The kickoff is the first thing the session acts on, and "begin reading"
      // sits one word away from "begin working". The line has to close that
      // itself, because the confirmation gates it must not override are in a
      // prime this line does not repeat.
      assert.match(launchKickoff.kickoffLine({ cursor: 0 }, 4), /authorize nothing/);
    });

    it('counts the steps it was given rather than assuming four', () => {
      assert.match(launchKickoff.kickoffLine({ cursor: 0 }, 6), /0 of 6 step\(s\)/);
    });

    it('states the count it observed rather than a constant', async () => {
      // #1599, in the sibling written beside this one: a line that describes a
      // state it did not observe is the failure that train exists to end. The
      // number is rendered from the row, so it cannot drift from it.
      assert.match(launchKickoff.kickoffLine({ cursor: 2 }, 6), /2 of 6 step\(s\)/);
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

      launchKickoff.reset();
      launchKickoff._internal.assessIdle = () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 2 });
      launchKickoff._internal.getSequence = () => ({ id: 1, cursor: 2 });
      produced.add(await launchKickoff.kickoff({ ...LIVE_LAUNCH }));

      launchKickoff.reset();
      launchKickoff._internal.getSequence = () => null;
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

  it('carries a pasted-prime launch through rather than deciding for it', async () => {
    // The branch tests only whether this is a real launch. Re-testing
    // `silentPrime` here would make the module's own `not-silent` answer
    // unreachable in production — a declared outcome only tests could see.
    sessions._deferEngineInit(
      'tc-builder1', 'TangleClaw-Builder1', 'claude', ENGINE_PROFILE,
      'the prime', null, false, null,
      { sessionId: 99, projectId: 3, hasSequence: true }
    );
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].silentPrime, false);
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

/**
 * The launch itself reaches the kickoff, with the launch's own facts.
 *
 * The block above drives `_deferEngineInit` directly, so it proves the hop but
 * takes the kickoff context as given. The context is BUILT one level up, in
 * `launchSession`, and `hasSequence` is a mapping there rather than a value
 * passed in — a real launch is the only thing that can show it is the right
 * mapping. That parameter is 9th and positional, which is the other reason to
 * prove it from the top: an argument inserted ahead of it would still typecheck.
 */
describe('a real launch builds the kickoff context (#1635)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const store = require('../lib/store');
  const tmux = require('../lib/tmux');
  const enginesModule = require('../lib/engines');

  let tmpDir;
  let projectsDir;
  let sessions;
  let realKickoff;
  let calls;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-kickoff-launch-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls = [];
    realKickoff = launchKickoff.kickoff;
    launchKickoff.kickoff = (args) => {
      calls.push(args);
      return Promise.resolve('sent');
    };
  });

  afterEach(() => {
    launchKickoff.kickoff = realKickoff;
  });

  /** Let the deferred launch timers fire. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  /**
   * Launch a fresh project with tmux and engine detection stubbed out.
   * @param {string} name - Project and directory name
   * @returns {object} The launch result
   */
  function launch(name) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine: 'claude' });
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name, {});
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  it('hands the kickoff the session and project it just created', async () => {
    const result = launch('kickoff-ctx-project');
    await settle();

    assert.equal(calls.length, 1, 'the launch called the kickoff exactly once');
    assert.equal(calls[0].sessionId, result.session.id);
    assert.equal(calls[0].projectId, result.session.projectId);
    assert.equal(calls[0].projectName, 'kickoff-ctx-project');
  });

  it('reports hasSequence from the sequence the launch actually created', async () => {
    // The mapping under test: `hasSequence` is `applicability === 'applicable'`,
    // and the store is the oracle for whether a sequence really exists.
    const result = launch('kickoff-seq-project');
    await settle();

    const sequence = store.launchSequences.getBySession(result.session.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasSequence, Boolean(sequence),
      'the kickoff was told about a sequence exactly when one exists');
  });
});
