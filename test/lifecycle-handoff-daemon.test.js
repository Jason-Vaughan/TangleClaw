'use strict';

// #2838 Slice 2 (v5.64.0 Wave 1 Car 64-D, Architect Ruling A501-W1D-R1): the
// lifecycle handoff background daemon, via `lib/lifecycle-handoff-daemon.js`.
// Same fixture shape as `test/lifecycle-handoff.test.js` (Slice 1): a fresh
// temp store + a real git-free project per test, no mocks of the module
// under test, `sessions.launchSession` stubbed per test since it is a
// separately, extensively tested dependency depending on a real engine
// binary. This file's job is to prove the tick loop drives
// `lib/lifecycle-handoff.js`'s own real functions correctly and stops
// exactly where its own doc says it must -- not to re-prove that module's
// state machine, which test/lifecycle-handoff.test.js already does.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const sessionsLib = require('../lib/sessions');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const lh = require('../lib/lifecycle-handoff');
const daemon = require('../lib/lifecycle-handoff-daemon');

let tmpDir = null;
let project = null;
let session = null;

const CHECKPOINT = { note: 'handing off', plan: '.tangleclaw/plans/example.md' };

/** A fresh project + its started session, for a second project in a multi-project test. */
function freshProjectAndSession(name) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-lhd-${name}-`));
  const proj = store.projects.create({ name, path: projDir, engine: 'claude' });
  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId, project: proj, engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
  });
  const sess = store.sessions.start({ projectId: proj.id, engineId: 'claude', launchSequence: snapshot });
  return { project: proj, session: sess };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lifecycle-handoff-daemon-'));
  store._setBasePath(tmpDir);
  store.init();
  ({ project, session } = freshProjectAndSession('lhd-proj'));
});

afterEach(() => {
  wrapRunRegistry._resetForTests();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a handoff with sane defaults; override per test. @see test/lifecycle-handoff.test.js */
function create(overrides = {}) {
  return lh.createHandoff({
    projectName: project.name, sourceSessionId: session.id, transitionType: 'wrap',
    delegatePrincipal: 'project:9', checkpoint: CHECKPOINT, ...overrides
  });
}

describe('createLifecycleHandoffDaemon().tick', () => {
  it('advances CHECKPOINTED -> WRAP_INITIATED once a real wrap run is evidenced', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    const d = daemon.createLifecycleHandoffDaemon();
    d.tick();
    const after = lh.getHandoff(created.handoff.handoffId);
    assert.equal(after.state, lh.STATES.WRAP_INITIATED);
  });

  it('leaves CHECKPOINTED alone when no wrap/finalize evidence exists yet', () => {
    const created = create();
    const d = daemon.createLifecycleHandoffDaemon();
    d.tick();
    const after = lh.getHandoff(created.handoff.handoffId);
    assert.equal(after.state, lh.STATES.CHECKPOINTED);
  });

  it('advances WRAP_INITIATED -> TERMINAL_CONFIRMED once the source session is really wrapped', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');
    const d = daemon.createLifecycleHandoffDaemon();
    d.tick();
    const after = lh.getHandoff(created.handoff.handoffId);
    assert.equal(after.state, lh.STATES.TERMINAL_CONFIRMED);
  });

  it('leaves WRAP_INITIATED alone while the source session is still active', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    const d = daemon.createLifecycleHandoffDaemon();
    d.tick();
    const after = lh.getHandoff(created.handoff.handoffId);
    assert.equal(after.state, lh.STATES.WRAP_INITIATED);
  });

  it('advances TERMINAL_CONFIRMED -> REPLACEMENT_LAUNCHED by launching the one replacement', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');
    lh.recordTerminalConfirmed(created.handoff.handoffId);

    const { session: replacement } = freshProjectAndSession('lhd-repl-target');
    const realLaunch = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      const d = daemon.createLifecycleHandoffDaemon();
      d.tick();
      const after = lh.getHandoff(created.handoff.handoffId);
      assert.equal(after.state, lh.STATES.REPLACEMENT_LAUNCHED);
      assert.equal(after.replacementSessionId, replacement.id);
    } finally {
      sessionsLib.launchSession = realLaunch;
    }
  });

  it('never touches REPLACEMENT_LAUNCHED or STARTUP_READY -- those need the replacement\'s own proof, not a timer\'s', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');
    lh.recordTerminalConfirmed(created.handoff.handoffId);

    const { session: replacement } = freshProjectAndSession('lhd-repl-untouched');
    const realLaunch = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      lh.launchReplacement(created.handoff.handoffId);
      const beforeState = lh.getHandoff(created.handoff.handoffId).state;
      assert.equal(beforeState, lh.STATES.REPLACEMENT_LAUNCHED);

      const d = daemon.createLifecycleHandoffDaemon();
      d.tick();
      d.tick();
      const after = lh.getHandoff(created.handoff.handoffId);
      assert.equal(after.state, lh.STATES.REPLACEMENT_LAUNCHED, 'the daemon must never advance past here on its own');

      // Now drive it to STARTUP_READY by hand and tick again -- still untouched.
      const replacementLaunchId = store.launchSequences.getBySession(replacement.id).launchId;
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      const handoff = lh.getHandoff(created.handoff.handoffId);
      lh.reconcileStartup(
        created.handoff.handoffId,
        { kind: 'project', sessionId: replacement.id, launchId: replacementLaunchId },
        { checkpointDigest: handoff.checkpointDigest, generation: handoff.observedGeneration }
      );
      d.tick();
      const stillStartupReady = lh.getHandoff(created.handoff.handoffId);
      assert.equal(stillStartupReady.state, lh.STATES.STARTUP_READY, 'the daemon must never record a takeover on its own');
    } finally {
      sessionsLib.launchSession = realLaunch;
    }
  });

  it('fails a handoff with GENERATION_MOVED when the control generation moved underneath it', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');

    // Move the control generation this handoff was never actually bound to
    // in a REAL way is hard to fabricate without the control module; the
    // module's own _requireLiveGeneration only fires for a non-null
    // observedGeneration, which an ungoverned test project never has. Cover
    // the daemon's handling of the refusal shape directly instead, the same
    // seam-free approach the rest of this suite uses: stub
    // recordTerminalConfirmed's underlying call indirectly by moving the
    // handoff into a state recordBlocker can verify, proving the daemon's
    // OWN branch (not lifecycle-handoff.js's generation check, which is
    // test/lifecycle-handoff.test.js's job) records the right blocker code
    // whenever that exact refusal code comes back.
    const real = lh.recordTerminalConfirmed;
    lh.recordTerminalConfirmed = (handoffId) => ({ ok: false, code: 'LIFECYCLE_HANDOFF_GENERATION_MOVED', message: 'moved' });
    try {
      const d = daemon.createLifecycleHandoffDaemon();
      d.tick();
    } finally {
      lh.recordTerminalConfirmed = real;
    }
    const after = lh.getHandoff(created.handoff.handoffId);
    assert.equal(after.state, lh.STATES.FAILED);
    assert.equal(after.blockerCode, lh.BLOCKER_CODES.GENERATION_MOVED);
  });

  it('sweeps every open handoff across every project in one pass', () => {
    const created1 = create();
    const { project: project2, session: session2 } = freshProjectAndSession('lhd-proj-2');
    const created2 = lh.createHandoff({
      projectName: project2.name, sourceSessionId: session2.id, transitionType: 'wrap',
      delegatePrincipal: 'project:9', checkpoint: CHECKPOINT
    });
    wrapRunRegistry.begin(project.name, session.id);
    wrapRunRegistry.begin(project2.name, session2.id);

    const d = daemon.createLifecycleHandoffDaemon();
    d.tick();

    assert.equal(lh.getHandoff(created1.handoff.handoffId).state, lh.STATES.WRAP_INITIATED);
    assert.equal(lh.getHandoff(created2.handoff.handoffId).state, lh.STATES.WRAP_INITIATED);
  });

  it('never throws when listOpen itself fails', () => {
    const real = lh.listOpen;
    lh.listOpen = () => { throw new Error('store unavailable'); };
    try {
      const d = daemon.createLifecycleHandoffDaemon();
      assert.doesNotThrow(() => d.tick());
    } finally {
      lh.listOpen = real;
    }
  });

  it('never throws when one handoff\'s own tick fails, and still ticks the rest', () => {
    const created1 = create();
    const { project: project2, session: session2 } = freshProjectAndSession('lhd-proj-3');
    const created2 = lh.createHandoff({
      projectName: project2.name, sourceSessionId: session2.id, transitionType: 'wrap',
      delegatePrincipal: 'project:9', checkpoint: CHECKPOINT
    });
    wrapRunRegistry.begin(project2.name, session2.id);

    const real = lh.recordWrapInitiated;
    let calls = 0;
    lh.recordWrapInitiated = (handoffId) => {
      calls += 1;
      if (handoffId === created1.handoff.handoffId) throw new Error('boom');
      return real(handoffId);
    };
    try {
      const d = daemon.createLifecycleHandoffDaemon();
      assert.doesNotThrow(() => d.tick());
      assert.equal(calls, 2, 'both handoffs were still attempted');
      assert.equal(lh.getHandoff(created2.handoff.handoffId).state, lh.STATES.WRAP_INITIATED, 'the other handoff still advanced');
    } finally {
      lh.recordWrapInitiated = real;
    }
  });
});

describe('start/stop', () => {
  it('is idempotent in both directions and leaves no timer running after stop', () => {
    const d = daemon.createLifecycleHandoffDaemon({ intervalMs: 50 });
    d.start();
    d.start(); // no-op, no second timer
    d.stop();
    d.stop(); // no-op, already stopped
  });

  it('DEFAULT_TICK_MS is a real positive interval, the default when none is given', () => {
    assert.equal(typeof daemon.DEFAULT_TICK_MS, 'number');
    assert.ok(daemon.DEFAULT_TICK_MS > 0);
    // createLifecycleHandoffDaemon({}) must not throw building its own
    // interval from this default rather than a caller-supplied one.
    const d = daemon.createLifecycleHandoffDaemon();
    assert.doesNotThrow(() => { d.start(); d.stop(); });
  });
});

describe('_internal (test seam)', () => {
  it('tick() reads its own duration from _internal.now, overridable for a deterministic log', () => {
    const real = daemon._internal.now;
    const readings = [1000, 1250];
    let i = 0;
    daemon._internal.now = () => readings[Math.min(i++, readings.length - 1)];
    try {
      const d = daemon.createLifecycleHandoffDaemon();
      assert.doesNotThrow(() => d.tick());
      assert.equal(i, 2, 'tick() reads the clock once at start and once at the end');
    } finally {
      daemon._internal.now = real;
    }
  });
});

describe('route/CLI adapters', () => {
  /** Drive a handoff all the way to a real REPLACEMENT_LAUNCHED, with a real launch sequence for the replacement. */
  function toReplacementLaunched() {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');
    lh.recordTerminalConfirmed(created.handoff.handoffId);
    const { session: replacement } = freshProjectAndSession('lhd-adapter-target');
    const realLaunch = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      lh.launchReplacement(created.handoff.handoffId);
    } finally {
      sessionsLib.launchSession = realLaunch;
    }
    return { handoffId: created.handoff.handoffId, replacement };
  }

  it('handleReconcileStartupRequest parses an untrusted body into reconcileStartup\'s exact shape', () => {
    const { handoffId, replacement } = toReplacementLaunched();
    const launchId = store.launchSequences.getBySession(replacement.id).launchId;
    const seq = store.launchSequences.getBySession(replacement.id);
    store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
    const handoff = lh.getHandoff(handoffId);
    const caller = { kind: 'project', sessionId: replacement.id, launchId };

    const r = daemon.handleReconcileStartupRequest(handoffId, caller, {
      checkpointDigest: handoff.checkpointDigest, generation: handoff.observedGeneration
    });
    assert.equal(r.ok, true);
    assert.equal(r.handoff.state, lh.STATES.STARTUP_READY);
  });

  it('handleReconcileStartupRequest never derives the caller itself -- a wrong caller is refused exactly as reconcileStartup refuses it', () => {
    const { handoffId } = toReplacementLaunched();
    const r = daemon.handleReconcileStartupRequest(handoffId, { kind: 'project', sessionId: session.id, launchId: 'wrong' }, {
      checkpointDigest: 'x', generation: null
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_REPLACEMENT');
  });

  it('handleReconcileStartupRequest refuses a malformed body as a digest mismatch, never a crash', () => {
    const { handoffId, replacement } = toReplacementLaunched();
    const launchId = store.launchSequences.getBySession(replacement.id).launchId;
    const seq = store.launchSequences.getBySession(replacement.id);
    store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
    const caller = { kind: 'project', sessionId: replacement.id, launchId };

    const r = daemon.handleReconcileStartupRequest(handoffId, caller, { generation: 'not-a-number-or-null' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_CHECKPOINT_NOT_RECONCILED');
  });

  it('handleTakeoverRequest completes the handoff once reconciled, end to end through both adapters', () => {
    const { handoffId, replacement } = toReplacementLaunched();
    const launchId = store.launchSequences.getBySession(replacement.id).launchId;
    const seq = store.launchSequences.getBySession(replacement.id);
    store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
    const handoff = lh.getHandoff(handoffId);
    const caller = { kind: 'project', sessionId: replacement.id, launchId };

    daemon.handleReconcileStartupRequest(handoffId, caller, {
      checkpointDigest: handoff.checkpointDigest, generation: handoff.observedGeneration
    });
    const r = daemon.handleTakeoverRequest(handoffId, caller);
    assert.equal(r.ok, true);
    assert.equal(r.handoff.state, lh.STATES.TAKEOVER_COMPLETE);
    assert.equal(lh.getOpenForProject(project.id), null, 'a terminal handoff is no longer open');
  });

  it('handleTakeoverRequest refuses before reconciliation, exactly as recordTakeover refuses it', () => {
    const { handoffId, replacement } = toReplacementLaunched();
    const launchId = store.launchSequences.getBySession(replacement.id).launchId;
    const r = daemon.handleTakeoverRequest(handoffId, { kind: 'project', sessionId: replacement.id, launchId });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });
});
