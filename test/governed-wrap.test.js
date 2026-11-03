'use strict';

// #2072 Slice 1 (v5.58.0 Wave 2 Car 58-D, Architect Ruling A2072): governed
// background wrap's core engine, via `lib/governed-wrap.js`. A fresh temp
// store + a real git repo per test (headSha is read with real `git`), no
// mocks of the module under test; `sessions.startWrap` itself is stubbed
// per test since it is a separately, extensively tested dependency -- this
// file's job is to prove governed-wrap.js calls it correctly, not to
// re-prove the wrap pipeline.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const sessionsLib = require('../lib/sessions');
const gw = require('../lib/governed-wrap');

let tmpDir = null;
let project = null;
let session = null;

/** Run git in the fixture repo. */
function git(args) {
  return execFileSync('git', args, { cwd: project.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The initiator every test uses unless it says otherwise. */
const COORDINATOR = { kind: 'coordinator', principal: 'project:9' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-governed-wrap-'));
  store._setBasePath(tmpDir);
  store.init();
  const projDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projDir);
  execFileSync('git', ['init', '-q'], { cwd: projDir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: projDir });
  project = store.projects.create({ name: 'gwrap-proj', path: projDir, engine: 'claude' });

  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId, project, engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
  });
  session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createPreflightRequest', () => {
  it('creates an AWAITING_DECISION request carrying the live facts', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    assert.equal(r.ok, true);
    assert.equal(r.request.state, gw.STATES.AWAITING_DECISION);
    assert.equal(r.request.projectId, project.id);
    assert.equal(r.request.sessionId, session.id);
    assert.equal(r.request.preflight.headSha, git(['rev-parse', 'HEAD']).trim());
    assert.equal(r.request.preflight.controlState, null);
    assert.equal(r.request.optionSchemaVersion, gw.OPTION_SCHEMA_VERSION);
    assert.deepEqual(r.request.preflight.decidableOptionKeys, gw.DECIDABLE_OPTION_KEYS);
    assert.deepEqual(r.request.preflight.filePolicies, Object.values(gw.FILE_POLICIES));
  });

  it('refuses an unknown project', async () => {
    const r = await gw.createPreflightRequest({ projectName: 'no-such-project', initiator: COORDINATOR });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('refuses a project with no active session', async () => {
    store.sessions.kill(session.id, 'test: no active session');
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('refuses a malformed initiator', async () => {
    const r1 = await gw.createPreflightRequest({ projectName: project.name, initiator: { kind: 'nope', principal: 'x' } });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'GOVERNED_WRAP_INVALID');
    const r2 = await gw.createPreflightRequest({ projectName: project.name, initiator: { kind: 'master' } });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GOVERNED_WRAP_INVALID');
  });

  it('duplicate-run prevention: refuses a second open request for the same project', async () => {
    const r1 = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    assert.equal(r1.ok, true);
    const r2 = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'GOVERNED_WRAP_IN_PROGRESS');
    assert.equal(r2.requestId, r1.request.requestId);
  });

  it('a cancelled request frees the project for a fresh one', async () => {
    const r1 = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.cancelRequest(r1.request.requestId, 'test: superseded');
    const r2 = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    assert.equal(r2.ok, true);
    assert.notEqual(r2.request.requestId, r1.request.requestId);
  });

  it('honors a custom ttlMs, and the request expires once it elapses', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR, ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const read = gw.getRequest(r.request.requestId);
    assert.equal(read.state, gw.STATES.EXPIRED);
  });
});

describe('submitDecision', () => {
  it('a "ready" decision moves the request to READY and records the decider', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({
      requestId: r.request.requestId, principal: 'project:9',
      decision: { result: 'ready', options: { skipTests: true } }
    });
    assert.equal(d.ok, true);
    assert.equal(d.request.state, gw.STATES.READY);
    assert.equal(d.request.decidedByPrincipal, 'project:9');
    assert.deepEqual(d.request.decision, { result: 'ready', options: { skipTests: true } });
  });

  it('a "needs-operator" decision moves the request to NEEDS_OPERATOR', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({
      requestId: r.request.requestId, principal: 'master',
      decision: { result: 'needs-operator', question: 'Skip tests for this wrap?' }
    });
    assert.equal(d.ok, true);
    assert.equal(d.request.state, gw.STATES.NEEDS_OPERATOR);
  });

  it('refuses a decision with neither "ready" nor "needs-operator"', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'maybe' } });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'GOVERNED_WRAP_INVALID');
  });

  it('refuses "needs-operator" with no question', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'needs-operator' } });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'GOVERNED_WRAP_INVALID');
  });

  it('refuses an unknown decidable option key', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({
      requestId: r.request.requestId, principal: 'project:9',
      decision: { result: 'ready', options: { rm: '-rf' } }
    });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'GOVERNED_WRAP_INVALID');
  });

  it('refuses an unknown filePolicy', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const d = gw.submitDecision({
      requestId: r.request.requestId, principal: 'project:9',
      decision: { result: 'ready', filePolicy: 'leave-everything-forever' }
    });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'GOVERNED_WRAP_INVALID');
  });

  it('refuses a decision against a request that already has one', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
    const again = gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'GOVERNED_WRAP_NOT_AWAITING_DECISION');
  });

  it('refuses an unknown request id', () => {
    const d = gw.submitDecision({ requestId: 'gwr_doesnotexist', principal: 'project:9', decision: { result: 'ready' } });
    assert.equal(d.ok, false);
    assert.equal(d.code, 'NOT_FOUND');
  });
});

describe('executeReadyRequest', () => {
  /** Stub `sessions.startWrap`, capturing every call; restores itself. */
  function stubStartWrap(impl) {
    const real = sessionsLib.startWrap;
    const calls = [];
    sessionsLib.startWrap = (projectName, options) => {
      calls.push({ projectName, options });
      return impl ? impl(projectName, options) : { ok: true, runId: 'run-1', sessionId: session.id, strandedUnchecked: null, sessionOutcomePlanned: null, keepSource: 'default' };
    };
    return { calls, restore: () => { sessionsLib.startWrap = real; } };
  }

  it('claims the pipeline and moves the request to EXECUTING with the runId', async () => {
    const stub = stubStartWrap();
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
      const exec = await gw.executeReadyRequest(r.request.requestId);
      assert.equal(exec.ok, true);
      assert.equal(exec.request.state, gw.STATES.EXECUTING);
      assert.equal(exec.request.runId, 'run-1');
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].projectName, project.name);
    } finally {
      stub.restore();
    }
  });

  it('maps filePolicy "leave-all-preexisting" to options.foreignPathDefault, never pathDecisions', async () => {
    const stub = stubStartWrap();
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({
        requestId: r.request.requestId, principal: 'project:9',
        decision: { result: 'ready', filePolicy: gw.FILE_POLICIES.LEAVE_ALL_PREEXISTING, options: { skipTests: true } }
      });
      await gw.executeReadyRequest(r.request.requestId);
      assert.deepEqual(stub.calls[0].options, { skipTests: true, foreignPathDefault: 'leave' });
    } finally {
      stub.restore();
    }
  });

  it('"include-owned-only" sends no foreignPathDefault override at all', async () => {
    const stub = stubStartWrap();
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({
        requestId: r.request.requestId, principal: 'project:9',
        decision: { result: 'ready', filePolicy: gw.FILE_POLICIES.INCLUDE_OWNED_ONLY }
      });
      await gw.executeReadyRequest(r.request.requestId);
      assert.deepEqual(stub.calls[0].options, {});
    } finally {
      stub.restore();
    }
  });

  it('digest revalidation: a head sha that moved after the decision marks the request STALE and refuses to execute', async () => {
    const stub = stubStartWrap();
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'moved'], { cwd: project.path });
      const exec = await gw.executeReadyRequest(r.request.requestId);
      assert.equal(exec.ok, false);
      assert.equal(exec.code, 'GOVERNED_WRAP_STALE');
      assert.equal(stub.calls.length, 0, 'the pipeline is never claimed against stale facts');
      const read = gw.getRequest(r.request.requestId);
      assert.equal(read.state, gw.STATES.STALE);
    } finally {
      stub.restore();
    }
  });

  it('digest revalidation: a control state that moved (a HOLD landed) also marks the request STALE', async () => {
    const stub = stubStartWrap();
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
      const control = require('../lib/control-state');
      control.create({ projectId: project.id, requestId: 'req-1', issueRef: '#2072', authority: {} },
        { principal: 'operator', operatorProof: 'ambient-open' });
      const exec = await gw.executeReadyRequest(r.request.requestId);
      assert.equal(exec.ok, false);
      assert.equal(exec.code, 'GOVERNED_WRAP_STALE');
    } finally {
      stub.restore();
    }
  });

  it('a pipeline-level refusal (e.g. WRAP_IN_PROGRESS) leaves the request READY, not EXECUTING', async () => {
    const stub = stubStartWrap(() => ({ ok: false, code: 'WRAP_IN_PROGRESS', error: 'already running', sessionId: session.id }));
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
      const exec = await gw.executeReadyRequest(r.request.requestId);
      assert.equal(exec.ok, false);
      assert.equal(exec.code, 'WRAP_IN_PROGRESS');
      const read = gw.getRequest(r.request.requestId);
      assert.equal(read.state, gw.STATES.READY);
    } finally {
      stub.restore();
    }
  });

  it('refuses to execute a request that is not READY (e.g. still AWAITING_DECISION)', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const exec = await gw.executeReadyRequest(r.request.requestId);
    assert.equal(exec.ok, false);
    assert.equal(exec.code, 'GOVERNED_WRAP_NOT_READY');
  });

  it('refuses an unknown request id', async () => {
    const exec = await gw.executeReadyRequest('gwr_doesnotexist');
    assert.equal(exec.ok, false);
    assert.equal(exec.code, 'NOT_FOUND');
  });
});

describe('cancelRequest', () => {
  it('cancels an AWAITING_DECISION request', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const c = gw.cancelRequest(r.request.requestId, 'test: no longer needed');
    assert.equal(c.ok, true);
    assert.equal(c.request.state, gw.STATES.CANCELLED);
    assert.equal(c.request.cancelReason, 'test: no longer needed');
  });

  it('cancels a READY request before it executes', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
    const c = gw.cancelRequest(r.request.requestId, 'test');
    assert.equal(c.ok, true);
  });

  it('refuses to cancel an EXECUTING request', async () => {
    const real = sessionsLib.startWrap;
    sessionsLib.startWrap = () => ({ ok: true, runId: 'run-2', sessionId: session.id });
    try {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'project:9', decision: { result: 'ready' } });
      await gw.executeReadyRequest(r.request.requestId);
      const c = gw.cancelRequest(r.request.requestId, 'too late');
      assert.equal(c.ok, false);
      assert.equal(c.code, 'GOVERNED_WRAP_NOT_CANCELLABLE');
    } finally {
      sessionsLib.startWrap = real;
    }
  });

  it('refuses an unknown request id', () => {
    const c = gw.cancelRequest('gwr_doesnotexist', 'test');
    assert.equal(c.ok, false);
    assert.equal(c.code, 'NOT_FOUND');
  });
});

describe('getOpenForProject', () => {
  it('finds the one open request for a project', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const open = gw.getOpenForProject(project.id);
    assert.equal(open.requestId, r.request.requestId);
  });

  it('answers null once the request is cancelled', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.cancelRequest(r.request.requestId, 'test');
    assert.equal(gw.getOpenForProject(project.id), null);
  });

  it('answers null for a project with no request at all', () => {
    assert.equal(gw.getOpenForProject(project.id), null);
  });
});
