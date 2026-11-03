'use strict';

// #2073 Slice 1 (v5.58.0 Wave 2 Car 58-D, Architect Ruling A2073): the
// closed-loop session lifecycle handoff state machine, via
// `lib/lifecycle-handoff.js`. A fresh temp store per test, no mocks of the
// module under test; `sessions.launchSession` itself is stubbed per test
// since it is a separately, extensively tested dependency depending on a
// real engine binary -- this file's job is to prove lifecycle-handoff.js
// calls it correctly and validates its own state machine, not to re-prove
// session launch.

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

let tmpDir = null;
let project = null;
let session = null;

const CHECKPOINT = { note: 'handing off', plan: '.tangleclaw/plans/example.md' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lifecycle-handoff-'));
  store._setBasePath(tmpDir);
  store.init();
  const projDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projDir);
  project = store.projects.create({ name: 'lho-proj', path: projDir, engine: 'claude' });

  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId, project, engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
  });
  session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
});

afterEach(() => {
  wrapRunRegistry._resetForTests();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a handoff with sane defaults; override per test. */
function create(overrides = {}) {
  return lh.createHandoff({
    projectName: project.name, sourceSessionId: session.id, transitionType: 'wrap',
    delegatePrincipal: 'project:9', checkpoint: CHECKPOINT, ...overrides
  });
}

/** Drive a fresh handoff to TERMINAL_CONFIRMED (a REAL wrap run + wraps the source session). */
function toTerminalConfirmed(overrides = {}) {
  const created = create(overrides);
  wrapRunRegistry.begin(project.name, session.id);
  lh.recordWrapInitiated(created.handoff.handoffId);
  store.sessions.wrap(session.id, 'test: wrap summary');
  lh.recordTerminalConfirmed(created.handoff.handoffId);
  return created.handoff.handoffId;
}

/** The reconciliation receipt `reconcileStartup` requires: this exact handoff's own checkpointDigest/observedGeneration. */
function reconciliationFor(handoffId) {
  const handoff = lh.getHandoff(handoffId);
  return { checkpointDigest: handoff.checkpointDigest, generation: handoff.observedGeneration };
}

describe('createHandoff', () => {
  it('creates in CHECKPOINTED with the checkpoint and its digest recorded', () => {
    const r = create();
    assert.equal(r.ok, true);
    assert.equal(r.handoff.state, lh.STATES.CHECKPOINTED);
    assert.deepEqual(r.handoff.checkpoint, CHECKPOINT);
    assert.equal(r.handoff.checkpointDigest.length, 64);
    assert.equal(r.handoff.sourceSessionId, session.id);
    assert.equal(r.handoff.observedGeneration, null, 'ungoverned project has no generation to observe');
  });

  it('refuses an unknown project', () => {
    const r = create({ projectName: 'no-such-project' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('refuses a sourceSessionId that is not the project\'s current active session', () => {
    const r = create({ sourceSessionId: session.id + 999 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_SESSION_NOT_CURRENT');
  });

  it('refuses an unknown transitionType', () => {
    const r = create({ transitionType: 'restart' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID');
  });

  it('refuses a non-object checkpoint', () => {
    const r = create({ checkpoint: 'not an object' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID');
  });

  it('single-replacement / duplicate-handoff guard: refuses a second open handoff for the same project', () => {
    const r1 = create();
    assert.equal(r1.ok, true);
    const r2 = create();
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'LIFECYCLE_HANDOFF_IN_PROGRESS');
    assert.equal(r2.handoffId, r1.handoff.handoffId);
  });

  it('a cancelled handoff frees the project for a fresh one', () => {
    const r1 = create();
    lh.cancelHandoff(r1.handoff.handoffId, 'test: superseded');
    const r2 = create();
    assert.equal(r2.ok, true);
    assert.notEqual(r2.handoff.handoffId, r1.handoff.handoffId);
  });

  it('records the live control generation when the project is governed', () => {
    const control = require('../lib/control-state');
    const created = control.create({ projectId: project.id, requestId: 'req-1', issueRef: '#2073', authority: {} },
      { principal: 'operator', operatorProof: 'ambient-open' });
    const r = create();
    assert.equal(r.ok, true);
    assert.equal(r.handoff.observedGeneration, created.assignment.stateGeneration);
  });
});

describe('the state machine: only the documented forward edges are allowed', () => {
  it('refuses recordTerminalConfirmed before recordWrapInitiated', () => {
    const created = create();
    const r = lh.recordTerminalConfirmed(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });

  it('refuses a transition on an unknown handoff id', () => {
    assert.equal(lh.recordWrapInitiated('lho_doesnotexist').code, 'NOT_FOUND');
    assert.equal(lh.recordTerminalConfirmed('lho_doesnotexist').code, 'NOT_FOUND');
    assert.equal(lh.launchReplacement('lho_doesnotexist').code, 'NOT_FOUND');
    assert.equal(lh.reconcileStartup('lho_doesnotexist', { kind: 'operator' }).code, 'NOT_FOUND');
    assert.equal(lh.recordTakeover('lho_doesnotexist', { kind: 'operator' }).code, 'NOT_FOUND');
  });

  it('recordWrapInitiated refuses without real evidence of a running wrap', () => {
    const created = create();
    const r = lh.recordWrapInitiated(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_INITIATED');
  });

  it('recordTerminalConfirmed refuses while the source session is still active', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    const r = lh.recordTerminalConfirmed(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_TERMINAL');
  });

  it('recordTerminalConfirmed refuses a killed or crashed source -- only "wrapped" counts', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.kill(session.id, 'test: simulated kill');
    const r = lh.recordTerminalConfirmed(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_TERMINAL');
  });

  it('recordTerminalConfirmed succeeds once the source session is genuinely terminal (wrapped)', () => {
    const created = create();
    wrapRunRegistry.begin(project.name, session.id);
    lh.recordWrapInitiated(created.handoff.handoffId);
    store.sessions.wrap(session.id, 'test: wrap summary');
    const r = lh.recordTerminalConfirmed(created.handoff.handoffId);
    assert.equal(r.ok, true);
    assert.equal(r.handoff.state, lh.STATES.TERMINAL_CONFIRMED);
  });

  it('recordWrapInitiated succeeds for "finalize" when a real session.finalized activity record exists', () => {
    const created = create({ transitionType: 'finalize' });
    store.activity.log({ projectId: project.id, sessionId: session.id, eventType: 'session.finalized', detail: {} });
    const r = lh.recordWrapInitiated(created.handoff.handoffId);
    assert.equal(r.ok, true);
  });

  it('one-generation rule: a HOLD landing after checkpointing blocks every later step with GENERATION_MOVED', () => {
    const control = require('../lib/control-state');
    control.create({ projectId: project.id, requestId: 'req-2', issueRef: '#2073', authority: { hold: ['project:9'] } },
      { principal: 'operator', operatorProof: 'ambient-open' });
    const created = create();
    control.hold({ assignmentId: store.control.getOpenForProject(project.id).assignment_id, requestId: 'req-3', reasonCode: 'boundary' },
      { principal: 'project:9' });
    const r = lh.recordWrapInitiated(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_GENERATION_MOVED');
  });
});

describe('launchReplacement', () => {
  function stubLaunch(impl) {
    const real = sessionsLib.launchSession;
    const calls = [];
    sessionsLib.launchSession = (projectName, options) => {
      calls.push({ projectName, options });
      return impl ? impl(projectName, options) : { session: { id: 9999 }, primePrompt: null, ttydUrl: 'http://x', error: null };
    };
    return { calls, restore: () => { sessionsLib.launchSession = real; } };
  }

  it('launches for real and records the replacement session id', () => {
    const stub = stubLaunch();
    try {
      const handoffId = toTerminalConfirmed();
      const r = lh.launchReplacement(handoffId, { foo: 'bar' });
      assert.equal(r.ok, true);
      assert.equal(r.handoff.state, lh.STATES.REPLACEMENT_LAUNCHED);
      assert.equal(r.handoff.replacementSessionId, 9999);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].projectName, project.name);
      assert.deepEqual(stub.calls[0].options, { foo: 'bar' });
    } finally {
      stub.restore();
    }
  });

  it('a launch-level refusal leaves the handoff at TERMINAL_CONFIRMED, retryable', () => {
    const stub = stubLaunch(() => ({ session: null, primePrompt: null, ttydUrl: null, error: 'no engine available', code: 'ENGINE_NOT_AVAILABLE' }));
    try {
      const handoffId = toTerminalConfirmed();
      const r = lh.launchReplacement(handoffId);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'ENGINE_NOT_AVAILABLE');
      const read = lh.getHandoff(handoffId);
      assert.equal(read.state, lh.STATES.TERMINAL_CONFIRMED);
    } finally {
      stub.restore();
    }
  });

  it('refuses before TERMINAL_CONFIRMED', () => {
    const created = create();
    const r = lh.launchReplacement(created.handoff.handoffId);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });

  it('restart-safety: a retry adopts the exact session its own earlier attempt launched, after the crash window (PRR-B I-Gate Round 1 Finding 4 / Round 2 Finding 2)', () => {
    const stub = stubLaunch((projectName, options) => {
      // The stub itself launches for real -- a genuine session row exists,
      // same as a real launchSession succeeding.
      const launchId = launchSequence.mintLaunchId();
      const snapshot = launchSequence.buildSnapshot({
        launchId, project, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
      });
      const started = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
      return { session: started, primePrompt: null, ttydUrl: 'http://x', error: null };
    });
    try {
      const handoffId = toTerminalConfirmed();
      const first = lh.launchReplacement(handoffId);
      assert.equal(first.ok, true);
      const launchedSessionId = first.handoff.replacementSessionId;
      assert.equal(stub.calls.length, 1);

      // Simulate the crash window: the launch above genuinely succeeded,
      // but the write recording it on THIS handoff never landed -- roll the
      // row back to TERMINAL_CONFIRMED by hand, the same state a crash
      // right after `launchSession` returned would leave it in.
      store.getDb().prepare(
        "UPDATE lifecycle_handoffs SET state = 'terminal_confirmed', replacement_session_id = NULL, replacement_launch_id = NULL WHERE handoff_id = ?"
      ).run(handoffId);

      const retry = lh.launchReplacement(handoffId);
      assert.equal(retry.ok, true);
      assert.equal(retry.handoff.replacementSessionId, launchedSessionId, 'adopted the exact session its own earlier attempt launched');
      assert.equal(retry.launched.adopted, true);
      assert.equal(stub.calls.length, 1, 'launchSession is never called again');
    } finally {
      stub.restore();
    }
  });

  it('refuses to adopt an active session unrelated to this handoff\'s own launch attempt, rather than silently claiming it (PRR-B I-Gate Round 2 Finding 2)', () => {
    const stub = stubLaunch();
    try {
      const handoffId = toTerminalConfirmed();
      // An unrelated session already occupies the project's slot -- NOT
      // launched by this handoff's own attempt (no attempt has been made
      // yet at all).
      const launchId = launchSequence.mintLaunchId();
      const snapshot = launchSequence.buildSnapshot({
        launchId, project, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
      });
      store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });

      const r = lh.launchReplacement(handoffId);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LIFECYCLE_HANDOFF_LAUNCH_UNRELATED_SESSION');
      assert.equal(stub.calls.length, 0, 'never launches blindly over an unrelated active session either');
    } finally {
      stub.restore();
    }
  });
});

describe('reconcileStartup', () => {
  function stubLaunch(newSessionId) {
    const real = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: newSessionId }, primePrompt: null, ttydUrl: 'http://x', error: null });
    return () => { sessionsLib.launchSession = real; };
  }

  /** A second real session + launch sequence, standing in for the replacement. */
  function launchedReplacement() {
    const other = store.projects.create({ name: 'lho-other', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-other-')), engine: 'claude' });
    const launchId = launchSequence.mintLaunchId();
    const snapshot = launchSequence.buildSnapshot({
      launchId, project: other, engineProfile: store.engines.get('claude'),
      applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
    });
    return store.sessions.start({ projectId: other.id, engineId: 'claude', launchSequence: snapshot });
  }

  it('refuses retryably until the replacement attests READY', () => {
    const replacement = launchedReplacement();
    const restore = stubLaunch(replacement.id);
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const replacementLaunchId = store.launchSequences.getBySession(replacement.id).launchId;
      const caller = { kind: 'project', sessionId: replacement.id, launchId: replacementLaunchId };
      const r1 = lh.reconcileStartup(handoffId, caller);
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'LIFECYCLE_HANDOFF_STARTUP_NOT_READY');

      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      const r2 = lh.reconcileStartup(handoffId, caller, reconciliationFor(handoffId));
      assert.equal(r2.ok, true);
      assert.equal(r2.handoff.state, lh.STATES.STARTUP_READY);
    } finally {
      restore();
    }
  });

  it('refuses a caller that is not the replacement session -- a delegate cannot forge reconciliation (PRR-B I-Gate Round 1 Finding 4)', () => {
    const replacement = launchedReplacement();
    const restore = stubLaunch(replacement.id);
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      // The delegate (a project caller, but NOT the replacement's own session/launch).
      const r = lh.reconcileStartup(handoffId, { kind: 'project', sessionId: session.id, launchId: 'wrong-launch-id' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_REPLACEMENT');
    } finally {
      restore();
    }
  });

  it('the operator may reconcile on the replacement\'s behalf', () => {
    const replacement = launchedReplacement();
    const restore = stubLaunch(replacement.id);
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      const r = lh.reconcileStartup(handoffId, { kind: 'operator' }, reconciliationFor(handoffId));
      assert.equal(r.ok, true);
      assert.equal(r.handoff.state, lh.STATES.STARTUP_READY);
    } finally {
      restore();
    }
  });

  it('refuses a null/missing caller', () => {
    const replacement = launchedReplacement();
    const restore = stubLaunch(replacement.id);
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const r = lh.reconcileStartup(handoffId, null);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_REPLACEMENT');
    } finally {
      restore();
    }
  });

  it('refuses a reconciliation receipt that does not echo this handoff\'s own checkpoint digest (PRR-B I-Gate Round 2 Finding 1)', () => {
    const replacement = launchedReplacement();
    const restore = stubLaunch(replacement.id);
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const replacementLaunchId = store.launchSequences.getBySession(replacement.id).launchId;
      const caller = { kind: 'project', sessionId: replacement.id, launchId: replacementLaunchId };
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');

      const wrongDigest = lh.reconcileStartup(handoffId, caller, { checkpointDigest: 'x'.repeat(64), generation: null });
      assert.equal(wrongDigest.ok, false);
      assert.equal(wrongDigest.code, 'LIFECYCLE_HANDOFF_CHECKPOINT_NOT_RECONCILED');

      const missing = lh.reconcileStartup(handoffId, caller);
      assert.equal(missing.ok, false);
      assert.equal(missing.code, 'LIFECYCLE_HANDOFF_CHECKPOINT_NOT_RECONCILED');

      const read = lh.getHandoff(handoffId);
      assert.equal(read.state, lh.STATES.REPLACEMENT_LAUNCHED, 'neither bad receipt advanced the handoff');

      const ok = lh.reconcileStartup(handoffId, caller, reconciliationFor(handoffId));
      assert.equal(ok.ok, true);
      assert.equal(ok.handoff.state, lh.STATES.STARTUP_READY);
      assert.equal(ok.handoff.reconciledDigest, ok.handoff.checkpointDigest);
    } finally {
      restore();
    }
  });
});

describe('recordTakeover', () => {
  it('is the one transition into the terminal TAKEOVER_COMPLETE state', () => {
    const replacement = (() => {
      const other = store.projects.create({ name: 'lho-takeover', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-tk-')), engine: 'claude' });
      const launchId = launchSequence.mintLaunchId();
      const snapshot = launchSequence.buildSnapshot({
        launchId, project: other, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
      });
      return store.sessions.start({ projectId: other.id, engineId: 'claude', launchSequence: snapshot });
    })();
    const real = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const replacementLaunchId = store.launchSequences.getBySession(replacement.id).launchId;
      const caller = { kind: 'project', sessionId: replacement.id, launchId: replacementLaunchId };
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      lh.reconcileStartup(handoffId, caller, reconciliationFor(handoffId));
      const r = lh.recordTakeover(handoffId, caller);
      assert.equal(r.ok, true);
      assert.equal(r.handoff.state, lh.STATES.TAKEOVER_COMPLETE);
      assert.equal(lh.getOpenForProject(project.id), null, 'a terminal handoff is no longer open');
    } finally {
      sessionsLib.launchSession = real;
    }
  });

  it('refuses before STARTUP_READY', () => {
    const handoffId = toTerminalConfirmed();
    const r = lh.recordTakeover(handoffId, { kind: 'operator' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });

  it('refuses a caller that is not the replacement session, even once STARTUP_READY', () => {
    const other = store.projects.create({ name: 'lho-takeover-2', path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lho-tk2-')), engine: 'claude' });
    const launchId = launchSequence.mintLaunchId();
    const snapshot = launchSequence.buildSnapshot({
      launchId, project: other, engineProfile: store.engines.get('claude'),
      applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
    });
    const replacement = store.sessions.start({ projectId: other.id, engineId: 'claude', launchSequence: snapshot });
    const real = sessionsLib.launchSession;
    sessionsLib.launchSession = () => ({ session: { id: replacement.id }, primePrompt: null, ttydUrl: 'http://x', error: null });
    try {
      const handoffId = toTerminalConfirmed();
      lh.launchReplacement(handoffId);
      const replacementLaunchId = store.launchSequences.getBySession(replacement.id).launchId;
      const seq = store.launchSequences.getBySession(replacement.id);
      store.launchSequences.markReady(seq.id, seq.revision, { ok: true }, 'ready-digest-x');
      lh.reconcileStartup(handoffId, { kind: 'project', sessionId: replacement.id, launchId: replacementLaunchId }, reconciliationFor(handoffId));
      const r = lh.recordTakeover(handoffId, { kind: 'project', sessionId: session.id, launchId: 'wrong' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LIFECYCLE_HANDOFF_NOT_REPLACEMENT');
    } finally {
      sessionsLib.launchSession = real;
    }
  });
});

describe('recordBlocker', () => {
  it('fails closed from any open state, and never clears the checkpoint', () => {
    const created = create();
    const r = lh.recordBlocker(created.handoff.handoffId, { code: lh.BLOCKER_CODES.OTHER, detail: 'something unexpected' });
    assert.equal(r.ok, true);
    assert.equal(r.handoff.state, lh.STATES.FAILED);
    assert.equal(r.handoff.blockerCode, lh.BLOCKER_CODES.OTHER);
    assert.deepEqual(r.handoff.checkpoint, CHECKPOINT);
  });

  it('refuses a missing code', () => {
    const created = create();
    const r = lh.recordBlocker(created.handoff.handoffId, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LIFECYCLE_HANDOFF_INVALID');
  });

  it('refuses on an already-terminal handoff', () => {
    const created = create();
    lh.recordBlocker(created.handoff.handoffId, { code: lh.BLOCKER_CODES.OTHER });
    const again = lh.recordBlocker(created.handoff.handoffId, { code: lh.BLOCKER_CODES.OTHER });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });
});

describe('cancelHandoff and getOpenForProject', () => {
  it('cancels an open handoff and frees the project', () => {
    const created = create();
    const c = lh.cancelHandoff(created.handoff.handoffId, 'test: no longer needed');
    assert.equal(c.ok, true);
    assert.equal(c.handoff.state, lh.STATES.CANCELLED);
    assert.equal(c.handoff.cancelReason, 'test: no longer needed');
    assert.equal(lh.getOpenForProject(project.id), null);
  });

  it('refuses to cancel an already-terminal handoff', () => {
    const created = create();
    lh.cancelHandoff(created.handoff.handoffId, 'first');
    const again = lh.cancelHandoff(created.handoff.handoffId, 'second');
    assert.equal(again.ok, false);
    assert.equal(again.code, 'LIFECYCLE_HANDOFF_INVALID_TRANSITION');
  });

  it('getHandoff answers null-shaped NOT_FOUND for an unknown id via the mutating calls, and getOpenForProject answers null with no open row', () => {
    assert.equal(lh.getHandoff('lho_doesnotexist'), null);
    assert.equal(lh.getOpenForProject(project.id), null);
  });
});
