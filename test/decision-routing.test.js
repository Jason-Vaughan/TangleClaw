'use strict';

// #2037 (v5.57.0 Wave 1 Car 57-D): the decision-request record and its
// fail-closed state machine. Every write goes through the real store on a
// temporary database; each expiry/supersession test drives the module's own
// clock rather than sleeping, and each conflict/replay test asserts the exact
// code a trust-boundary caller will branch on. Mirrors
// `test/permission-requests.test.js`'s harness.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const decisionRouting = require('../lib/decision-routing');

const { STATES } = decisionRouting;

const START = Date.parse('2026-11-03T08:00:00.000Z');
const MINUTE = 60 * 1000;

const realNow = decisionRouting._internal.now;

let tmpDir = null;
let PROJECT_A = null;
let PROJECT_B = null;

/**
 * Fix the module's clock to an exact instant.
 * @param {number} ms - Offset from {@link START}
 * @returns {void}
 */
function clockAt(ms = 0) {
  const iso = new Date(START + ms).toISOString();
  decisionRouting._internal.now = () => iso;
}

/**
 * Start a session bound to a fresh launch sequence, so the session is both a
 * real `sessions` row and a real, resolvable launch.
 * @param {number} projectId
 * @param {string} launchId - Must be unique across the whole test file
 * @returns {object} The created session (`store.sessions.start`'s return)
 */
function startSession(projectId, launchId) {
  return store.sessions.start({
    projectId,
    engineId: 'claude',
    launchSequence: {
      launchId,
      pageBudget: 0,
      applicability: 'not-applicable',
      notApplicableReason: 'test fixture — no real launch steps needed',
      preflight: {},
      sourceManifest: {}
    }
  });
}

/**
 * Create a decision request bound to a freshly-started session, with sane
 * defaults.
 * @param {object} [overrides]
 * @returns {{result: object, session: object, launchId: string}}
 */
function create(overrides = {}) {
  const projectId = overrides.projectId ?? PROJECT_A;
  const launchId = overrides.launchId ?? `launch-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
  const session = overrides.session ?? startSession(projectId, launchId);
  const result = decisionRouting.createDecisionRequest({
    idemKey: overrides.idemKey ?? `idem-${launchId}`,
    projectId,
    sessionId: session.id,
    launchId,
    headSha: overrides.headSha,
    prompt: overrides.prompt ?? 'Proceed with the deploy?',
    choices: overrides.choices ?? ['yes', 'no'],
    recommendation: overrides.recommendation,
    requiredAuthority: overrides.requiredAuthority ?? 'human',
    gate: overrides.gate ?? 'test-gate',
    reversible: overrides.reversible,
    ttlMs: overrides.ttlMs ?? 10 * MINUTE
  });
  return { result, session, launchId };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-decision-routing-'));
  store._setBasePath(tmpDir);
  store.init();
  const dirA = path.join(tmpDir, 'proj-a');
  const dirB = path.join(tmpDir, 'proj-b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  PROJECT_A = store.projects.create({ name: 'decision-project-a', path: dirA, engine: 'claude' }).id;
  PROJECT_B = store.projects.create({ name: 'decision-project-b', path: dirB, engine: 'claude' }).id;
  clockAt(0);
});

afterEach(() => {
  decisionRouting._internal.now = realNow;
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createDecisionRequest', () => {
  it('creates a waiting_decision request with a prompt digest and the offered choices', () => {
    const { result } = create();
    assert.equal(result.ok, true);
    assert.equal(result.request.state, STATES.WAITING_DECISION);
    assert.deepEqual(result.request.choices, ['yes', 'no']);
    assert.equal(result.request.promptDigest.length, 64);
    assert.equal(result.request.isOverdue, false);
  });

  it('refuses a request missing a required field', () => {
    const result = decisionRouting.createDecisionRequest({
      idemKey: 'k', projectId: PROJECT_A, sessionId: 1, launchId: 'l', prompt: 'p',
      choices: ['a', 'b'], requiredAuthority: 'human', ttlMs: 1000
      // gate missing
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECISION_REQUEST_INVALID');
  });

  it('refuses fewer than two choices', () => {
    const { result } = create({ choices: ['only-one'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECISION_REQUEST_INVALID');
  });

  it('refuses an unrecognized authority class', () => {
    const { result } = create({ requiredAuthority: 'king' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DECISION_REQUEST_INVALID');
  });

  it('replays the same idemKey as the already-created request, not a new one', () => {
    const { session, launchId } = create({ idemKey: 'dup-key' });
    const second = decisionRouting.createDecisionRequest({
      idemKey: 'dup-key', projectId: PROJECT_A, sessionId: session.id, launchId,
      prompt: 'different prompt now', choices: ['x', 'y'], requiredAuthority: 'human',
      gate: 'test-gate', ttlMs: 60000
    });
    assert.equal(second.ok, true);
    assert.equal(second.replay, true);
    assert.equal(second.request.prompt, 'Proceed with the deploy?');
  });
});

describe('expiry and supersession (lazy, on read)', () => {
  it('reports waiting_decision before its deadline', () => {
    const { result } = create({ ttlMs: 5 * MINUTE });
    clockAt(4 * MINUTE);
    const read = decisionRouting.getDecisionRequest(result.request.decisionId);
    assert.equal(read.state, STATES.WAITING_DECISION);
  });

  it('expires once past its deadline, on the next read', () => {
    const { result } = create({ ttlMs: 5 * MINUTE });
    clockAt(6 * MINUTE);
    const read = decisionRouting.getDecisionRequest(result.request.decisionId);
    assert.equal(read.state, STATES.EXPIRED);
  });

  it('flags isOverdue once past deadline but still waiting', () => {
    const { result } = create({ ttlMs: 5 * MINUTE });
    clockAt(6 * MINUTE);
    const read = decisionRouting.getDecisionRequest(result.request.decisionId);
    assert.equal(read.isOverdue, false); // already transitioned to expired, not "waiting but overdue"
  });

  it('supersedes once the requesting session is no longer the project\'s current one', () => {
    const { result, launchId } = create({ ttlMs: 60 * MINUTE });
    // Start a second session for the same project — the first is no longer current.
    startSession(PROJECT_A, `${launchId}-replacement`);
    const read = decisionRouting.getDecisionRequest(result.request.decisionId);
    assert.equal(read.state, STATES.SUPERSEDED);
  });
});

describe('answerDecisionRequest', () => {
  it('answers a live request bound to its own prompt digest', () => {
    const { result } = create();
    const answered = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(answered.ok, true);
    assert.equal(answered.request.state, STATES.ANSWERED);
    assert.equal(answered.request.answer, 'yes');
    assert.equal(answered.request.answeredBySurface, 'operator');
  });

  it('refuses an answer whose prompt digest does not match — the newer-prompt case', () => {
    const { result } = create();
    const answered = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: 'stale-digest-from-an-earlier-prompt'
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.code, 'DECISION_PROMPT_MISMATCH');
  });

  it('refuses an answer that is not one of the offered choices', () => {
    const { result } = create();
    const answered = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'maybe', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.code, 'DECISION_ANSWER_NOT_OFFERED');
  });

  it('refuses to answer an expired request', () => {
    const { result } = create({ ttlMs: 5 * MINUTE });
    clockAt(6 * MINUTE);
    const answered = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.code, 'DECISION_REQUEST_EXPIRED');
  });

  it('refuses to answer a superseded request', () => {
    const { result, launchId } = create({ ttlMs: 60 * MINUTE });
    startSession(PROJECT_A, `${launchId}-replacement`);
    const answered = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.code, 'DECISION_LAUNCH_SUPERSEDED');
  });

  it('replays the identical answer idempotently', () => {
    const { result } = create();
    const first = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    const second = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.replay, true);
  });

  it('refuses a conflicting second answer', () => {
    const { result } = create();
    decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    const conflict = decisionRouting.answerDecisionRequest(result.request.decisionId, {
      answer: 'no', answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: result.request.promptDigest
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'DECISION_ANSWER_CONFLICT');
  });

  it('refuses an unknown decision id', () => {
    const answered = decisionRouting.answerDecisionRequest('dec_does_not_exist', {
      answer: 'yes', answeredBySurface: 'operator', answeredByActor: 'operator', expectedPromptDigest: 'x'
    });
    assert.equal(answered.ok, false);
    assert.equal(answered.code, 'DECISION_REQUEST_NOT_FOUND');
  });
});

describe('listDecisionRequestsForSession', () => {
  it('lists only the given session\'s requests, newest first', () => {
    const { session: sessionA } = create();
    const first = create({ session: sessionA, launchId: `launch-same-${Date.now()}` });
    clockAt(MINUTE);
    const second = create({ session: sessionA, launchId: first.launchId, idemKey: 'second-idem' });
    const list = decisionRouting.listDecisionRequestsForSession(sessionA.id);
    assert.equal(list.length >= 2, true);
    assert.equal(list[0].decisionId, second.result.request.decisionId);
  });

  it('filters by state', () => {
    const { session } = create({ ttlMs: 5 * MINUTE });
    create({ session, launchId: `launch-live-${Date.now()}`, idemKey: 'still-waiting' });
    const waiting = decisionRouting.listDecisionRequestsForSession(session.id, { state: STATES.WAITING_DECISION });
    assert.equal(waiting.every((r) => r.state === STATES.WAITING_DECISION), true);
  });
});

describe('resolveDecisionAuthorityPolicy (#2037 PRR-B: gives decisionAuthorityPolicy an actual effect)', () => {
  it('defaults to human when unset', () => {
    assert.equal(decisionRouting.resolveDecisionAuthorityPolicy({}), 'human');
  });

  it('defaults to human on an unrecognized value, rather than trusting it', () => {
    assert.equal(decisionRouting.resolveDecisionAuthorityPolicy({ decisionAuthorityPolicy: 'king' }), 'human');
  });

  it('honors a recognized configured policy', () => {
    assert.equal(decisionRouting.resolveDecisionAuthorityPolicy({ decisionAuthorityPolicy: 'autonomous-within-lease' }), 'autonomous-within-lease');
  });
});
