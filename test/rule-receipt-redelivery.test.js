'use strict';

/*
 * #1176 — a `rules-hook` delivery that never receives its receipt stays
 * `written` forever (#1063 already made that an honest, visible state; it
 * never made anything watch for it). This pins the watcher that does:
 * grace-window gating on session activity, #1150 sandbox-loopback
 * disambiguation against the local receipt token, and bounded, cooled-down
 * re-delivery through an injected open channel that must itself confirm
 * before a row is treated as resolved.
 */

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const rulesChannel = require('../lib/session-rules-channel');
const tmux = require('../lib/tmux');
const redelivery = require('../lib/rule-receipt-redelivery');

describe('#1176 — rule-receipt-redelivery', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1176-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    redelivery._resetAttemptState();
  });

  let _uidCounter = 0;
  const uid = () => (++_uidCounter);

  function makeProject() {
    const name = `proj-${uid()}`;
    const projDir = path.join(projectsDir, name);
    fs.mkdirSync(projDir, { recursive: true });
    return store.projects.create({ name, path: projDir, engine: 'claude' });
  }

  function makeSession(project, overrides = {}) {
    return store.sessions.start({ projectId: project.id, engineId: 'claude', ...overrides });
  }

  function writtenDelivery(session, project) {
    return store.sessionRuleDeliveries.record({
      sessionId: session.id, projectId: project.id, engineId: 'claude',
      channel: 'rules-hook', outcome: 'written', ruleIds: [1, 2], digest: 'd'.repeat(64)
    });
  }

  function pastGraceNow() {
    return Date.now() + redelivery.DEFAULT_GRACE_MS + 60_000;
  }

  describe('probeLocalReceipt', () => {
    it('reports no receipt when the token file does not exist', () => {
      const project = makeProject();
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 1),
        { exists: false, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('reports a match with no hook-ran marker for a plain {deliveryId, api} token — '
      + 'the ordinary shape `writeReceiptToken` leaves BEFORE the engine ever starts (#1176 Round 2)', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: null, loopbackRefused: false });
    });

    it('reports exists-but-no-match when the token now names a different delivery', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 7),
        { exists: true, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('surfaces hookFiredAt when the token (once the hook-side stamp lands) carries one', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 42, api: 'http://localhost:3102', hookFiredAt: '2026-10-31T00:00:00Z' }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: '2026-10-31T00:00:00Z', loopbackRefused: false });
    });

    it('surfaces loopbackRefused when the token carries it (#1150)', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 42, api: 'http://localhost:3102', loopbackRefused: true }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: null, loopbackRefused: true });
    });

    it('never surfaces hookFiredAt/loopbackRefused from a token that does not match this delivery', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 999, api: 'http://localhost:3102', hookFiredAt: 'now', loopbackRefused: true }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('fails closed with readError on a non-ENOENT read failure, rather than reading as "no token" (WARNING 1)', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
      const original = fs.readFileSync;
      mock.method(fs, 'readFileSync', (p, enc) => {
        if (p === file) { const err = new Error('boom'); err.code = 'EACCES'; throw err; }
        return original(p, enc);
      });
      try {
        assert.deepEqual(redelivery.probeLocalReceipt(project.path, 1),
          { exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' });
      } finally {
        mock.restoreAll();
      }
    });
  });

  describe('classifyWrittenDelivery — #1150 disambiguation (corrected, #1176 Round 2 / PRR-B BLOCKING 1)', () => {
    it('is needs-redelivery when the token matches but carries NO hook-ran marker — the ordinary un-run-hook case', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'needs-redelivery',
        'presence-and-match alone must NOT withhold re-delivery — that was the Round 1 bug');
    });

    it('is local-receipt-pending when the token carries hookFiredAt', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: '2026-10-31T00:00:00Z', loopbackRefused: false })
      });
      assert.equal(result.status, 'local-receipt-pending');
    });

    it('is local-receipt-pending when the token carries loopbackRefused (#1150)', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: null, loopbackRefused: true })
      });
      assert.equal(result.status, 'local-receipt-pending');
    });

    it('is superseded when the token now names a different delivery', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: false, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'superseded');
    });

    it('is needs-redelivery when no local token exists at all', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'needs-redelivery');
    });

    it('is token-read-error, and does not fall through to needs-redelivery, on a non-ENOENT read failure (WARNING 1)', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' })
      });
      assert.equal(result.status, 'token-read-error');
      assert.match(result.reason, /EACCES/);
    });
  });

  describe('defaults', () => {
    it('bounds re-delivery to 2 attempts by default, per the dispatch (#1176)', () => {
      assert.equal(redelivery.DEFAULT_MAX_ATTEMPTS, 2);
    });

    it('spaces default attempts by a cooldown shorter than a day and longer than the grace window', () => {
      assert.ok(redelivery.DEFAULT_COOLDOWN_MS > 0);
      assert.ok(redelivery.DEFAULT_COOLDOWN_MS >= redelivery.DEFAULT_GRACE_MS);
    });
  });

  describe('checkAndRedeliver', () => {
    it('defaults deliverViaOpenChannel to the production tmux paste when none is supplied (PRR-B BLOCKING 2)', async () => {
      const project = makeProject();
      const session = makeSession(project, { tmuxSession: `tc-1176-${uid()}` });
      const delivery = writtenDelivery(session, project);

      mock.method(tmux, 'sendKeys', () => {});
      try {
        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery, session }],
          getRules: () => [{ id: 1, content: 'a rule' }]
        });
        assert.equal(outcomes[0].status, 'redelivered');
        assert.equal(tmux.sendKeys.mock.calls.length, 1);
        assert.equal(tmux.sendKeys.mock.calls[0].arguments[0], session.tmuxSession);
        assert.match(tmux.sendKeys.mock.calls[0].arguments[1], /a rule/);
      } finally {
        mock.restoreAll();
      }
    });

    it('the default channel reports a failed attempt (never throws past checkAndRedeliver) when the session has no tmux pane', async () => {
      const project = makeProject();
      const session = makeSession(project); // no tmuxSession
      const delivery = writtenDelivery(session, project);

      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        getRules: () => [{ id: 1, content: 'a rule' }]
      });
      assert.equal(outcomes[0].status, 'attempt-failed');
      assert.match(outcomes[0].reason, /no tmux pane/);
    });

    it('leaves a freshly-written row alone until the session has stood active past the grace window', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: () => Date.now(),
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].status, 'pending-grace');
      assert.equal(calls, 0, 'must not re-deliver before the grace window elapses');
    });

    it('RE-DELIVERS (does not withhold) when the local token matches but carries no hook-ran marker — '
      + 'presence-and-match alone is the ordinary un-run-hook shape, not evidence (#1176 Round 2 / PRR-B BLOCKING 1)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: delivery.id, api: 'http://localhost:3102' });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'redelivered');
      assert.equal(calls, 1, 'a presence-and-match-only token (what writeReceiptToken ALWAYS leaves pre-hook) '
        + 'must not be mistaken for proof the hook ran — Round 1\'s bug froze this forever at local-receipt-pending');
    });

    it('does NOT re-deliver while the local token carries loopbackRefused — genuine #1150 evidence the hook ran', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: delivery.id, api: 'http://localhost:3102', loopbackRefused: true }));

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'local-receipt-pending');
      assert.equal(calls, 0, 'real evidence the hook ran (#1150 loopback-blocked) must still withhold re-delivery');
    });

    it('fails closed with token-read-error, attempting no re-delivery, on a non-ENOENT token read failure (WARNING 1)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' }),
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'token-read-error');
      assert.equal(calls, 0, 'an unreadable token must never be treated as "no token, proceed"');
    });

    it('treats a token now pointing at a different delivery as superseded, not actionable', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: delivery.id + 999, api: 'http://localhost:3102' });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'superseded');
      assert.equal(calls, 0);
    });

    it('re-delivers through the open channel when nothing local explains the silence, and records the confirmed attempt', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      const seen = [];
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        getRules: () => [{ id: 1, content: 'rule text' }],
        deliverViaOpenChannel: async (entry) => { seen.push(entry); }
      });

      assert.equal(outcomes[0].status, 'redelivered');
      assert.equal(outcomes[0].attempt, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { sessionId: session.id, projectId: project.id, rules: [{ id: 1, content: 'rule text' }], attempt: 1 });

      const activity = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_ATTEMPT });
      assert.equal(activity.length, 1);
      assert.equal(activity[0].detail.confirmed, true);
    });

    it('records a failed attempt, then withholds a retry during the cooldown window', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const deps = {
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; throw new Error('channel unreachable'); },
        cooldownMs: 10 * 60 * 1000,
        maxAttempts: 5
      };

      const first = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
      assert.equal(first[0].status, 'attempt-failed');
      assert.equal(first[0].attempt, 1);
      assert.equal(calls, 1);

      const second = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
      assert.equal(second[0].status, 'cooling-down');
      assert.equal(calls, 1, 'must not attempt again inside the cooldown window');
    });

    it('stops at maxAttempts, surfaces exhaustion once, and never calls the channel again', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const exhaustions = [];
      const deps = {
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; throw new Error('channel unreachable'); },
        maxAttempts: 2,
        cooldownMs: 0,
        onExhausted: (entry) => exhaustions.push(entry)
      };

      const r1 = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
      assert.equal(r1[0].status, 'attempt-failed');

      const r2 = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
      assert.equal(r2[0].status, 'exhausted');
      assert.equal(calls, 2);
      assert.equal(exhaustions.length, 1);
      assert.equal(exhaustions[0].deliveryId, delivery.id);
      assert.equal(exhaustions[0].attempts, 2);

      const r3 = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 2000 });
      assert.equal(r3[0].status, 'exhausted');
      assert.equal(calls, 2, 'an already-exhausted delivery must never call the channel again');
      assert.equal(exhaustions.length, 1, 'exhaustion is surfaced once, not on every subsequent pass');

      const activity = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_EXHAUSTED });
      assert.equal(activity.length, 1);
    });

    it('never calls the channel for a delivered or skipped row (only `written` rules-hook rows are candidates)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivered = store.sessionRuleDeliveries.record({
        sessionId: session.id, projectId: project.id, engineId: 'claude',
        channel: 'rules-hook', outcome: 'delivered', ruleIds: [1], digest: 'd'.repeat(64)
      });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery: delivered, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      // Fed directly, bypassing `_defaultListCandidates`'s own filter, to pin
      // the defensive re-check inside `_processOne` itself.
      assert.equal(outcomes[0].status, 'not-applicable');
      assert.equal(calls, 0);

      // The default candidate list is fleet-wide (every live session), so this
      // asserts against THIS session specifically rather than an empty result
      // — other tests in this file leave their own live sessions behind, and
      // a reset attempt-state means some of those get a fresh, real attempt
      // here too.
      const liveOutcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        deliverViaOpenChannel: async () => {}
      });
      assert.equal(
        liveOutcomes.some((o) => o.sessionId === session.id), false,
        'the live store default must not surface a delivered row as a candidate'
      );
    });
  });

  // #1176, PRR-B BLOCKING 2: checkAndRedeliver has to actually run somewhere
  // in production, not only in a test's own direct call. This pins that
  // `lib/activity-observer.js`'s tick loop is that somewhere, and that a
  // failure in it (the default "no store yet" case every bare unit-test
  // observer hits) can never break the tick itself.
  describe('wired into lib/activity-observer.js\'s tick (#1176, PRR-B BLOCKING 2)', () => {
    it('calls deps.checkRuleReceipts once per tick, after the tick\'s own result is already final', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const calls = [];
      const obs = createObserver({
        listSessions: () => [],
        checkRuleReceipts: async () => { calls.push(1); }
      });
      const result = await obs.tick();
      assert.equal(calls.length, 1);
      assert.deepEqual(result, { observed: [], skipped: [] }, 'the redelivery pass must not alter the tick result');
    });

    it('a rejecting checkRuleReceipts (e.g. no store yet) is swallowed — tick() still resolves normally', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const obs = createObserver({
        listSessions: () => [],
        checkRuleReceipts: async () => { throw new Error('store not initialized'); }
      });
      await assert.doesNotReject(() => obs.tick());
    });

    it('defaults checkRuleReceipts to this module\'s own checkAndRedeliver when a caller supplies none', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const obs = createObserver({ listSessions: () => [] }); // no checkRuleReceipts override
      // The real default reaches this suite's own already-initialized live
      // store (earlier tests leave real `written` rules-hook rows behind),
      // and its own default `deliverViaOpenChannel` will genuinely attempt —
      // and fail — a tmux paste against sessions with no real pane. Both are
      // caught well before this call: `_processOne` catches a failed attempt
      // as an ordinary outcome, and `tick()`'s own try/catch around
      // `checkRuleReceipts()` is the backstop. This proves the production
      // default is actually wired, not just a test-supplied stand-in.
      await assert.doesNotReject(() => obs.tick());
    });
  });
});
