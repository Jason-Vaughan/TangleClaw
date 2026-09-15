'use strict';

/*
 * The watched handback (#1312): after the drawer asks the session to fix the
 * step its wrap blocked on, TangleClaw watches the pane for the completion
 * marker and says when the session is done. Driven on a fake clock, so the
 * quiet window and the maximum wait are real durations the test steps through
 * rather than sleeps.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const handback = require('../lib/wrap-handback');
const registry = require('../lib/wrap-run-registry');
const aiContent = require('../lib/wrap-steps/ai-content');

const PROJECT = 'hb-test';
const SESSION = { id: 7, tmuxSession: 'hb-pane' };

const saved = { handback: { ...handback._internal }, registryNow: registry._internal.now };

let clock;
let pane;
let sent;

/**
 * Settle a run for PROJECT that halted at `blockedAt`.
 * @param {string} blockedAt - The step the run stopped on
 * @param {string} [status='blocked'] - That step's status
 * @returns {string} The run id
 */
function settleBlockedRun(blockedAt, status = 'blocked') {
  const claim = registry.begin(PROJECT, SESSION.id);
  registry.finish(PROJECT, claim.runId, {
    ok: false,
    pipelineResult: {
      ok: false,
      blockedAt,
      results: [{ stepId: blockedAt, kind: 'ai-content', status, output: null, blockers: ['no entry'] }]
    }
  });
  return claim.runId;
}

/**
 * Let the watch loop run until `pred` holds or the fake clock passes `limitMs`.
 * @param {() => boolean} pred - Stop condition
 * @param {number} [limitMs] - Fake-time budget
 * @returns {Promise<void>}
 */
async function runUntil(pred, limitMs = aiContent.MAX_WAIT_MS + 60_000) {
  const start = clock;
  let stalled = 0;
  let last = clock;
  // Only a running watch advances the fake clock, so a watch that already ended
  // would spin this forever; give up once the clock stops moving.
  while (!pred() && clock - start <= limitMs && stalled < 1000) {
    await new Promise((resolve) => setImmediate(resolve));
    stalled = clock === last ? stalled + 1 : 0;
    last = clock;
  }
}

/** @returns {object|null} The current handback for the latest run */
function current() {
  return handback.get(PROJECT, registry.get(PROJECT).runId);
}

describe('wrap handback watch (#1312)', () => {
  beforeEach(() => {
    clock = 1_000_000;
    pane = '';
    sent = [];
    registry._resetForTests();
    handback._resetForTests();
    registry._internal.now = () => clock;
    Object.assign(handback._internal, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; await new Promise((resolve) => setImmediate(resolve)); },
      readPaneTail: () => (typeof pane === 'function' ? pane() : pane),
      newNonce: () => 'abcd1234',
      getSession: (id) => (id === SESSION.id ? SESSION : null),
      inject: (project, text, options) => { sent.push({ project, text, options }); return { ok: true, error: null }; }
    });
  });

  afterEach(() => {
    Object.assign(handback._internal, saved.handback);
    registry._internal.now = saved.registryNow;
    handback._resetForTests();
    registry._resetForTests();
  });

  it('sends the prompt with the completion instruction to the wrap\'s own session', () => {
    settleBlockedRun('changelog-update');
    const res = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'Write the entry.' });
    assert.equal(res.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.sessionId, SESSION.id);
    assert.ok(sent[0].text.startsWith('Write the entry. '));
    assert.ok(sent[0].text.endsWith(aiContent._completionInstruction('abcd1234')));
    assert.doesNotMatch(sent[0].text, /[\r\n]/, 'tmux send-keys would submit at a newline');
    assert.equal(res.handback.state, 'working');
  });

  it('is ready on the marker, and the echoed prompt alone never matches', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'Write the entry.' });
    pane = sent[0].text;
    const markerAt = clock + 20_000;
    // The pane keeps changing (a working TUI), so only the marker can finish it.
    pane = () => (clock >= markerAt ? `${sent[0].text}\nDone.\nTCWRAP-DONE \`abcd1234\`` : `${sent[0].text}\nworking ${clock}`);
    await runUntil(() => current().state !== 'working');
    const hb = current();
    assert.equal(hb.state, 'ready');
    assert.equal(hb.completedVia, 'marker');
    assert.ok(hb.finishedAt >= markerAt && hb.finishedAt < markerAt + 2 * aiContent.POLL_INTERVAL_MS);
  });

  it('an earlier handback\'s marker in the scrollback does not finish a new one', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'first' });
    handback._internal.newNonce = () => 'ffff0000';
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'second' });
    pane = () => `TCWRAP-DONE abcd1234\nstill going ${clock}`;
    await runUntil(() => clock > 1_000_000 + 30_000);
    assert.equal(current().state, 'working');
  });

  it('a static pane turns `quiet` after the quiet window, not before, and the watch keeps going', async () => {
    settleBlockedRun('changelog-update');
    const started = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    const events = [];
    let ended = false;
    handback.subscribe(PROJECT, started.handbackId, { onEvent: (e) => events.push(e.state), onEnd: () => { ended = true; } });
    pane = 'a pane that never changes';
    await runUntil(() => current().state !== 'working');
    const hb = current();
    assert.equal(hb.state, 'quiet', 'a session that stopped to ask something is not done');
    assert.equal(hb.completedVia, 'quiet');
    assert.match(hb.completionNote, /no completion marker seen/);
    assert.ok(clock - hb.startedAt >= aiContent.QUIET_FALLBACK_MS, 'not before the quiet window');
    assert.equal(hb.finishedAt, null, 'quiet does not end the watch');
    assert.equal(ended, false);
    assert.deepEqual(events, ['quiet']);
  });

  it('a quiet session that is answered and then prints its line is seen as ready (#1312 live check)', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    pane = 'Which option do you want?';
    await runUntil(() => current().state === 'quiet');
    // Long after the content step's maximum wait, the operator answers; the pane moves.
    const answerAt = clock + aiContent.MAX_WAIT_MS;
    pane = () => (clock < answerAt ? 'Which option do you want?' : `answered, working ${clock}`);
    await runUntil(() => current().state === 'working', aiContent.MAX_WAIT_MS * 2);
    assert.equal(current().finishedAt, null, 'the answered session is watched again, not timed out');
    const doneAt = clock + 10_000;
    pane = () => (clock < doneAt ? `working ${clock}` : 'Created it.\nTCWRAP-DONE abcd1234');
    await runUntil(() => current().state === 'ready');
    assert.equal(current().completedVia, 'marker');
  });

  it('a question nobody answers ends the watch as `quiet` at the cap', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    pane = 'Which option do you want?';
    await runUntil(() => current().finishedAt !== null, handback.QUIET_WATCH_CAP_MS + 60_000);
    const hb = current();
    assert.equal(hb.state, 'quiet');
    assert.ok(hb.finishedAt - hb.startedAt >= handback.QUIET_WATCH_CAP_MS);
    assert.match(hb.completionNote, /no completion marker seen/);
  });

  it('a pane that keeps moving times out at the maximum wait', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    pane = () => `spinner ${clock}`;
    await runUntil(() => current().state !== 'working');
    const hb = current();
    assert.equal(hb.state, 'timed-out');
    assert.ok(hb.finishedAt - hb.startedAt >= aiContent.MAX_WAIT_MS);
    assert.match(hb.error, /did not print its completion line/);
  });

  it('a pane read that throws fails the watch, naming the read', async () => {
    settleBlockedRun('changelog-update');
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    handback._internal.readPaneTail = () => { throw new Error('no such session'); };
    await runUntil(() => current().state !== 'working');
    assert.equal(current().state, 'failed');
    assert.match(current().error, /Could not read the terminal: no such session/);
  });

  it('a second handback supersedes the first and ends its stream', async () => {
    settleBlockedRun('changelog-update');
    const first = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'first' });
    const events = [];
    let ended = false;
    handback.subscribe(PROJECT, first.handbackId, { onEvent: (e) => events.push(e.type), onEnd: () => { ended = true; } });
    const second = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'second' });
    assert.equal(ended, true);
    assert.deepEqual(events, ['handback-done']);
    assert.equal(current().handbackId, second.handbackId);
    assert.equal(handback.subscribe(PROJECT, first.handbackId, { onEvent() {}, onEnd() {} }).ok, false);
  });

  it('a new wrap run drops the handback, and its watch stops', async () => {
    const runId = settleBlockedRun('changelog-update');
    const started = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    let ended = false;
    handback.subscribe(PROJECT, started.handbackId, { onEvent() {}, onEnd: () => { ended = true; } });
    const next = registry.begin(PROJECT, SESSION.id);
    assert.notEqual(next.runId, runId);
    assert.equal(handback.get(PROJECT, next.runId), null);
    pane = () => `moving ${clock}`;
    await runUntil(() => ended, 10_000);
    assert.equal(ended, true, 'the orphaned watch ended its stream');
  });

  it('refuses a running, absent or unhalted run, a step that is not the blocker, and a needs-operator block', () => {
    assert.equal(handback.start(PROJECT, { stepId: 'x', prompt: 'p' }).code, 'WRAP_NOT_SETTLED');
    const claim = registry.begin(PROJECT, SESSION.id);
    assert.equal(handback.start(PROJECT, { stepId: 'x', prompt: 'p' }).code, 'WRAP_NOT_SETTLED');
    registry.finish(PROJECT, claim.runId, { ok: true, pipelineResult: { ok: true, blockedAt: null, results: [] } });
    assert.equal(handback.start(PROJECT, { stepId: 'x', prompt: 'p' }).code, 'WRAP_STEP_NOT_BLOCKED');
    settleBlockedRun('changelog-update');
    assert.equal(handback.start(PROJECT, { stepId: 'memory-update', prompt: 'p' }).code, 'WRAP_STEP_NOT_BLOCKED');
    settleBlockedRun('changelog-update', 'needs-operator');
    const refused = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'p' });
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'WRAP_STEP_NEEDS_OPERATOR');
    assert.equal(sent.length, 0, 'nothing was typed into the session');
  });

  it('refuses a structural block a prompt cannot fix', () => {
    const claim = registry.begin(PROJECT, SESSION.id);
    registry.finish(PROJECT, claim.runId, {
      ok: false,
      pipelineResult: { ok: false, blockedAt: 'test', results: [{ stepId: 'test', kind: 'test', status: 'blocked', blockers: ['failed'] }] }
    });
    const refused = handback.start(PROJECT, { stepId: 'test', prompt: 'fix the tests' });
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'WRAP_STEP_NOT_RESOLVABLE');
    assert.equal(sent.length, 0);
  });

  it('refuses an empty, multi-line or oversized prompt with 400', () => {
    settleBlockedRun('changelog-update');
    for (const body of [{ stepId: 'changelog-update' }, { stepId: 'changelog-update', prompt: '  ' },
      { stepId: 'changelog-update', prompt: 'a\nb' }, { stepId: 'changelog-update', prompt: 'x'.repeat(handback.MAX_PROMPT_CHARS + 1) },
      { prompt: 'p' }]) {
      assert.equal(handback.start(PROJECT, body).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(sent.length, 0);
  });

  it('a failed injection is refused and leaves no handback', () => {
    settleBlockedRun('changelog-update');
    handback._internal.inject = () => ({ ok: false, error: 'tmux session "hb-pane" not found' });
    const res = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'p' });
    assert.equal(res.status, 404);
    assert.equal(res.code, 'HANDBACK_NOT_SENT');
    assert.equal(current(), null);
  });

  it('the prompt plus its completion instruction fits injectCommand\'s limit', () => {
    settleBlockedRun('changelog-update');
    handback._internal.newNonce = () => 'ffffffff';
    handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'x'.repeat(handback.MAX_PROMPT_CHARS) });
    assert.ok(sent[0].text.length <= 4096, `${sent[0].text.length} chars`);
  });

  it('a subscriber arriving after the watch ended gets both events and is told to close', async () => {
    settleBlockedRun('changelog-update');
    const started = handback.start(PROJECT, { stepId: 'changelog-update', prompt: 'fix' });
    pane = 'TCWRAP-DONE abcd1234';
    await runUntil(() => current().state !== 'working');
    const sub = handback.subscribe(PROJECT, started.handbackId, { onEvent() {}, onEnd() {} });
    assert.equal(sub.finished, true);
    assert.deepEqual(sub.replay.map((e) => [e.seq, e.type, e.state]), [[1, 'handback-start', 'working'], [2, 'handback-done', 'ready']]);
    assert.ok(sub.replay.every((e) => Number.isFinite(e.at)));
  });
});

describe('wrap run registry timing', () => {
  beforeEach(() => registry._resetForTests());
  afterEach(() => { registry._internal.now = saved.registryNow; registry._resetForTests(); });

  it('stamps each event with the time it happened, and a replay keeps it', () => {
    let t = 5_000;
    registry._internal.now = () => t;
    const { runId } = registry.begin('timing', 1);
    registry.emit('timing', runId, { type: 'run-start', steps: [] });
    t = 9_000;
    registry.emit('timing', runId, { type: 'step-start', stepId: 'a', kind: 'k' });
    assert.equal(registry.get('timing').currentStepStartedAt, 9_000);
    t = 60_000;
    const sub = registry.subscribe('timing', runId, { onEvent() {}, onEnd() {} });
    assert.deepEqual(sub.replay.map((e) => e.at), [5_000, 9_000], 'replayed with the original times');
    sub.unsubscribe();
    registry.finish('timing', runId, null);
    assert.equal(registry.get('timing').currentStepStartedAt, null);
  });
});
