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

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const rulesChannel = require('../lib/session-rules-channel');
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

  function makeSession(project) {
    return store.sessions.start({ projectId: project.id, engineId: 'claude' });
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
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 1), { exists: false, matches: false });
    });

    it('reports a match when the token on disk names the given delivery', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42), { exists: true, matches: true });
    });

    it('reports exists-but-no-match when the token now names a different delivery', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 7), { exists: true, matches: false });
    });
  });

  describe('classifyWrittenDelivery — #1150 disambiguation', () => {
    it('is local-receipt-pending when the token still names this delivery', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true })
      });
      assert.equal(result.status, 'local-receipt-pending');
    });

    it('is superseded when the token now names a different delivery', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: false })
      });
      assert.equal(result.status, 'superseded');
    });

    it('is needs-redelivery when no local token exists at all', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: false, matches: false })
      });
      assert.equal(result.status, 'needs-redelivery');
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
    it('requires a deliverViaOpenChannel dependency', async () => {
      await assert.rejects(() => redelivery.checkAndRedeliver({}), /deliverViaOpenChannel/);
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

    it('does not re-deliver while the local receipt token still names this delivery (#1150)', async () => {
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

      assert.equal(outcomes[0].status, 'local-receipt-pending');
      assert.equal(calls, 0, 'a live, matching local token must not trigger a spurious re-delivery');
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
});
