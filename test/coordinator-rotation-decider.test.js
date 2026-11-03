'use strict';

// #2351/#2353 (v5.57.0 Wave 2 Car 57-E): unreachable appointed decider
// detection/fallback and governed refresh scheduling, via
// `lib/coordinator-rotation.js#checkDeciderReachability`/
// `#checkGovernedRefreshDue`. A fresh temp store per test (not the shared
// fixture `test/coordinator-rotation.test.js` uses for Codex rebinding,
// which this file has no need to entangle with) — real `coordinator_roles`,
// `sessions`, `launch_sequences`, `workload_receipts` and `medusa_exchanges`
// rows, with the wake-verdict/Medusa-status/pane-capture seams injected per
// Architect Rulings A2351/A2353's composition design.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const rotation = require('../lib/coordinator-rotation');
const medusaExchanges = require('../lib/medusa-exchanges');
const decisionRouting = require('../lib/decision-routing');

const START = '2026-11-03T08:00:00.000Z';
const MINUTE = 60 * 1000;

let tmpDir = null;
let PM_PROJECT = null;
let ARCHITECT_PROJECT = null;

/**
 * Start a session bound to a fresh launch sequence AND give it a workload
 * receipt — both are what `checkDeciderReachability` reads to resolve
 * `launchId` and the receipt's own currency.
 * @param {number} projectId
 * @param {{receiptState?: string, receiptAgeMs?: number, nowMs: number}} opts
 * @returns {{session: object, launchId: string}}
 */
function startDeciderSession(projectId, { receiptState = 'working', receiptAgeMs = MINUTE, nowMs }) {
  const launchId = `launch-${projectId}-${Math.floor(Math.random() * 1e9)}`;
  const session = store.sessions.start({
    projectId,
    engineId: 'codex',
    tmuxSession: `test-tmux-${projectId}-${Math.floor(Math.random() * 1e9)}`,
    launchSequence: {
      launchId, pageBudget: 0, applicability: 'not-applicable',
      notApplicableReason: 'test fixture', preflight: {}, sourceManifest: {}
    }
  });
  const receivedAt = new Date(nowMs - receiptAgeMs).toISOString();
  store.workloadReceipts.append({
    launch_id: launchId, session_id: session.id, project_id: projectId, assignment_id: null,
    state: receiptState, clearance: 'do-not-clear', summary: 'test fixture', wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli', received_at: receivedAt
  }, { minIntervalMs: 0, nowMs });
  return { session, launchId };
}

/**
 * A tracked, open (non-terminal) exchange addressed to `recipientWorkspaceId`,
 * via the real `createSendIntent` so every required column is populated the
 * way production code populates it — not a hand-rolled raw INSERT. Advanced
 * past `send_pending` to `stored` via the real `bindHubId` (simulating the
 * Hub accepting the send), so it lands in a state `checkDeciderReachability`'s
 * genuinely-unread filter actually treats as awaiting read — `send_pending`
 * itself is excluded there (PRR-A I-Gate Round 2), the same way
 * `lib/medusa-exchanges.js`'s own private `_awaitingRead` excludes it.
 * @param {string} recipientWorkspaceId
 * @param {number} recipientProjectId
 * @param {string} createdAt - ISO instant to backdate the exchange to
 * @param {string} [senderWorkspaceId] - The sender's own workspace, for blocked-sender-notification tests
 * @returns {object} The exchange row
 */
function openExchangeTo(recipientWorkspaceId, recipientProjectId, createdAt, senderWorkspaceId = 'sender-ws') {
  const realNow = medusaExchanges._internal.now;
  medusaExchanges._internal.now = () => new Date(createdAt);
  try {
    const row = medusaExchanges.createSendIntent({
      meta: {
        requestId: `req-${Math.random().toString(36).slice(2)}`,
        priority: 'normal', replyRequired: true, escalateAfterMs: null, reasonCode: null,
        verified: true, proof: 'system'
      },
      sender: { projectId: null, sessionId: 'sender-session', workspaceId: senderWorkspaceId },
      recipient: { workspaceId: recipientWorkspaceId, projectId: recipientProjectId, sessionId: null },
      tracking: 'tracked'
    });
    return medusaExchanges.bindHubId(row.exchange_id, `hub-${Math.random().toString(36).slice(2)}`);
  } finally {
    medusaExchanges._internal.now = realNow;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-decider-reachability-'));
  store._setBasePath(tmpDir);
  store.init();
  const pmDir = path.join(tmpDir, 'pm-project');
  const archDir = path.join(tmpDir, 'architect-project');
  fs.mkdirSync(pmDir);
  fs.mkdirSync(archDir);
  PM_PROJECT = store.projects.create({ name: 'pm-project', path: pmDir, engine: 'codex' }).id;
  ARCHITECT_PROJECT = store.projects.create({ name: 'architect-project', path: archDir, engine: 'codex' }).id;
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A deps object the test controls: fixed clock, no real Medusa/wake monitor calls. */
function deps(overrides = {}) {
  const nowMs = Date.parse(START);
  return {
    now: () => new Date(nowMs).toISOString(),
    medusaStatus: () => ({ workspaceId: 'pm-workspace' }),
    wakeVerdict: () => null,
    ...overrides
  };
}

describe('checkDeciderReachability — not yet a problem', () => {
  it('a project with no active coordinator role is not checked at all', () => {
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps());
    assert.equal(result.checked, false);
    assert.equal(result.reason, 'not an appointed coordinator');
  });

  it('a coordinator with no active session is not checked', () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps());
    assert.equal(result.checked, false);
    assert.equal(result.reason, 'no active session');
  });

  it('a coordinator with no unread mail is healthy, regardless of wake/workload', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs }); // expired, but no mail
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.equal(result.checked, true);
    assert.equal(result.fired, false);
    assert.equal(result.reason, 'healthy');
  });

  it('unread mail under the silence bound does not fire even with an unknown wake', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const { session } = startDeciderSession(PM_PROJECT, { nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - (rotation.DECIDER_SILENCE_MS - MINUTE)).toISOString());
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }), now: () => new Date(nowMs).toISOString() }));
    assert.equal(result.fired, false, JSON.stringify(result));
    void session;
  });

  it('unread mail past the bound with a HEALTHY wake and current workload does not fire', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(result.fired, false);
  });
});

describe('checkDeciderReachability — fires and records a durable decision_requests alert', () => {
  it('fires on unread mail + engine-thread-unknown, via decisionRouting.createDecisionRequest', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const { session } = startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    const exchange = openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.equal(result.fired, true);
    assert.equal(result.reason, 'engine-thread-unknown');
    assert.equal(result.request.gate, rotation.DECIDER_UNREACHABLE_GATE);
    assert.equal(result.request.requiredAuthority, 'human');
    assert.equal(result.request.state, decisionRouting.STATES.WAITING_DECISION);
    assert.equal(result.request.sessionId, session.id);

    // Really is a decision_requests row, readable through the normal API.
    const read = decisionRouting.getDecisionRequest(result.request.decisionId);
    assert.equal(read.decisionId, result.request.decisionId);
    // The alert's TTL is a dead-man's-switch backstop, not the primary
    // closure path (recovery is) — long enough that it never expires out
    // from under an outage still being worked. decisionRouting's OWN clock
    // (not this test's fixed `nowMs`) is what deadlineAt is computed from,
    // so compare against the request's own createdAt, the same clock read.
    assert.equal(Date.parse(read.deadlineAt) - Date.parse(read.createdAt), rotation.DECIDER_ALERT_TTL_MS);
    void exchange;
  });

  it('a message the coordinator already read does not count toward silence, even sitting alongside a genuinely unread one (PRR-A I-Gate Round 2)', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    // Old enough on its own to meet the silence bound, but already read --
    // must not count.
    const readOne = openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 2 * rotation.DECIDER_SILENCE_MS).toISOString());
    medusaExchanges.recordRead([readOne.hub_id], 'pm-workspace', null);
    // Genuinely unread, but too recent on its own to meet the silence bound.
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 5 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.equal(result.fired, false, 'the read exchange must not be mistaken for unread mail old enough to fire');
  });

  it('includes both diagnostic signals in the prompt when wake AND workload are both bad, and notifies the blocked sender (PRR-A I-Gate Round 2)', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs }); // expired
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString(), 'blocked-sender-ws');

    const notified = [];
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({
      wakeVerdict: () => ({ reason: 'engine-thread-unknown' }),
      notifySender: (workspaceId, message) => notified.push({ workspaceId, message })
    }));
    await Promise.resolve(); // let the fire-and-forget notify bookkeeping settle

    assert.equal(result.fired, true);
    assert.match(result.request.prompt, /engine-thread-unknown/);
    assert.match(result.request.prompt, /workload receipt: expired/);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].workspaceId, 'blocked-sender-ws');
    assert.match(notified[0].message, /unanswered/);

    // A second tick of the SAME episode (same oldest-unread exchange), same
    // sender, must not notify again.
    const second = rotation.checkDeciderReachability(PM_PROJECT, deps({
      wakeVerdict: () => ({ reason: 'engine-thread-unknown' }),
      notifySender: (workspaceId, message) => notified.push({ workspaceId, message })
    }));
    await Promise.resolve();
    assert.equal(second.request.decisionId, result.request.decisionId, 'same episode, replayed');
    assert.equal(notified.length, 1, 'no second notification for a replayed alert');
  });

  it('notifies a SECOND sender who joins an already-open outage episode (PRR-A I-Gate Round 3)', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString(), 'first-sender-ws');

    const notified = [];
    const d = deps({
      wakeVerdict: () => ({ reason: 'engine-thread-unknown' }),
      notifySender: (workspaceId, message) => notified.push({ workspaceId, message })
    });
    const first = rotation.checkDeciderReachability(PM_PROJECT, d);
    await Promise.resolve();
    assert.equal(notified.length, 1);
    assert.equal(notified[0].workspaceId, 'first-sender-ws');

    // A second sender's own mail ages into "genuinely unread" during the
    // SAME open episode -- a replay of the same decision, but a sender this
    // episode has never notified yet.
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 25 * MINUTE).toISOString(), 'second-sender-ws');
    const second = rotation.checkDeciderReachability(PM_PROJECT, d);
    await Promise.resolve();
    assert.equal(second.request.decisionId, first.request.decisionId, 'still the same open episode');
    assert.equal(notified.length, 2);
    assert.ok(notified.some((n) => n.workspaceId === 'second-sender-ws'));

    // A third tick with no new sender notifies nobody further.
    rotation.checkDeciderReachability(PM_PROJECT, d);
    await Promise.resolve();
    assert.equal(notified.length, 2, 'no new sender, no new notification');
  });

  it('a transient notifySender failure is not marked notified, and retries on the next tick (PRR-A I-Gate Round 3)', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString(), 'flaky-sender-ws');

    let calls = 0;
    const attemptedWorkspaces = [];
    const notifySender = (workspaceId) => {
      calls += 1;
      attemptedWorkspaces.push(workspaceId);
      if (calls === 1) return Promise.reject(new Error('synthetic transient send failure'));
      return Promise.resolve();
    };
    const d = deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }), notifySender });

    rotation.checkDeciderReachability(PM_PROJECT, d);
    await Promise.resolve();
    await Promise.resolve(); // let the rejection's handler run too
    assert.equal(calls, 1, 'the first attempt was made and failed');

    // A second tick retries the SAME sender, since the failed attempt was
    // never marked notified.
    rotation.checkDeciderReachability(PM_PROJECT, d);
    await Promise.resolve();
    assert.equal(calls, 2, 'the failed send is retried on the next tick, not abandoned');
    assert.deepEqual(attemptedWorkspaces, ['flaky-sender-ws', 'flaky-sender-ws']);
  });

  it('fires exactly at the silence bound, not a moment before (DECIDER_SILENCE_MS boundary)', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - rotation.DECIDER_SILENCE_MS).toISOString());
    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.equal(result.fired, true);
  });

  it('fires on unread mail + expired workload receipt (no wake-unknown needed)', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs }); // > 30m working-expiry
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(result.fired, true);
    assert.equal(result.reason, 'workload-expired');
  });

  it('a PM decider\'s fallback names the active architect role when one exists', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-pm', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    store.coordinatorRoles.grant({ roleId: 'role-arch', projectId: ARCHITECT_PROJECT, role: 'architect', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.equal(result.fired, true);
    assert.ok(result.request.choices.some((c) => c.includes('architect') && c.includes(String(ARCHITECT_PROJECT))), JSON.stringify(result.request.choices));
  });

  it('a PM decider\'s fallback is the Operator when no architect role is active', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-pm', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) }));
    assert.ok(result.request.choices.some((c) => c.toLowerCase().includes('operator')));
  });

  it('an architect decider\'s fallback is always the Operator', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-arch', projectId: ARCHITECT_PROJECT, role: 'architect', note: null, now: START });
    startDeciderSession(ARCHITECT_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('arch-workspace', ARCHITECT_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const result = rotation.checkDeciderReachability(ARCHITECT_PROJECT, deps({
      medusaStatus: () => ({ workspaceId: 'arch-workspace' }),
      wakeVerdict: () => ({ reason: 'engine-thread-unknown' })
    }));
    assert.equal(result.fired, true);
    assert.ok(result.request.choices.some((c) => c.toLowerCase().includes('operator')));
    assert.ok(!result.request.choices.some((c) => c.includes('architect')));
  });

  it('repeated ticks of the SAME outage episode replay into one open row, not several', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const d = deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) });
    const first = rotation.checkDeciderReachability(PM_PROJECT, d);
    const second = rotation.checkDeciderReachability(PM_PROJECT, d);
    assert.equal(first.request.decisionId, second.request.decisionId);
  });

  it('a later, genuinely distinct outage (a different oldest-unread exchange) opens a fresh alert', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());
    const d = deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) });
    const first = rotation.checkDeciderReachability(PM_PROJECT, d);

    // The first exchange gets answered/closed (simulated by directly marking
    // it terminal), and a NEW, later one arrives — a distinct episode.
    store.getDb().prepare("UPDATE medusa_exchanges SET terminal_at = ?, state = 'closed' WHERE recipient_workspace_id = 'pm-workspace'")
      .run(new Date(nowMs - 1000).toISOString());
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 25 * MINUTE).toISOString());
    const second = rotation.checkDeciderReachability(PM_PROJECT, d);

    assert.notEqual(first.request.decisionId, second.request.decisionId);
  });
});

describe('checkDeciderReachability — recovery closes the open alert (Acceptance Bullet 4)', () => {
  it('closes the open alert once unread mail drains, with a recovery rationale', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());
    const d = deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) });
    const fired = rotation.checkDeciderReachability(PM_PROJECT, d);
    assert.equal(fired.fired, true);

    // Mail drains (closed), simulating the decider having answered/the mail being read).
    store.getDb().prepare("UPDATE medusa_exchanges SET terminal_at = ?, state = 'closed' WHERE recipient_workspace_id = 'pm-workspace'")
      .run(new Date(nowMs).toISOString());

    const recovered = rotation.checkDeciderReachability(PM_PROJECT, d);
    assert.equal(recovered.fired, false);
    assert.equal(recovered.recovered, true);

    const closedRequest = decisionRouting.getDecisionRequest(fired.request.decisionId);
    assert.equal(closedRequest.state, decisionRouting.STATES.SUPERSEDED);
    assert.match(closedRequest.auditRationale, /recovered/);
  });

  it('closes the open alert once wake and workload are both healthy again, even with no mail drain', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());
    const fired = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(fired.fired, true, JSON.stringify(fired));

    // A fresh, current receipt lands (the session answered something), but
    // the SAME old mail is still technically unread in this fixture — the
    // recovery condition is "no longer (unread-past-bound AND (wake-unknown
    // OR workload-expired))", so a current receipt alone clears it.
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 0, nowMs }).session;
    const recovered = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(recovered.fired, false);
  });

  it('a renewed outage on the SAME still-unread exchange after recovery opens a FRESH alert, not the superseded one (PRR-A I-Gate Round 3)', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    // ONE session/launch throughout -- a fresh workload receipt posted by
    // the SAME session, not a new session starting, is what actually
    // recovers in production; starting a new session each step would
    // trigger decision-routing's own, unrelated launch-currency
    // supersession and mask whether THIS recovery path does its own job.
    const { session, launchId } = startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs });
    const postReceipt = (state, receiptAgeMs) => store.workloadReceipts.append({
      launch_id: launchId, session_id: session.id, project_id: PM_PROJECT, assignment_id: null,
      state, clearance: 'do-not-clear', summary: 'test fixture', wait_kind: null, wait_detail: null,
      refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
      received_at: new Date(nowMs - receiptAgeMs).toISOString()
    }, { minIntervalMs: 0, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());

    const first = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(first.fired, true);
    const firstDecisionId = first.request.decisionId;

    // Recovery: a fresh, current receipt lands FROM THE SAME SESSION, but
    // the SAME old mail stays unread throughout (never touched) -- the
    // exact scenario that shares one idemKey base across both episodes.
    postReceipt('working', 0);
    const recovered = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(recovered.fired, false);
    assert.equal(recovered.recovered, true);
    assert.equal(decisionRouting.getDecisionRequest(firstDecisionId).state, decisionRouting.STATES.SUPERSEDED);

    // Renewed outage: the receipt goes stale again, the mail is STILL that
    // same unread exchange. Must fire a genuinely NEW, live alert -- not
    // replay the now-dead superseded one.
    postReceipt('working', 40 * MINUTE);
    const renewed = rotation.checkDeciderReachability(PM_PROJECT, deps({ wakeVerdict: () => ({ reason: 'idle' }) }));
    assert.equal(renewed.fired, true);
    assert.notEqual(renewed.request.decisionId, firstDecisionId, 'a fresh episode, not the superseded one');
    assert.equal(renewed.request.state, decisionRouting.STATES.WAITING_DECISION, 'the renewed alert is actually live');
  });

  it('never re-closes an already-answered alert as a recovery (an Operator answer wins)', () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    openExchangeTo('pm-workspace', PM_PROJECT, new Date(nowMs - 30 * MINUTE).toISOString());
    const d = deps({ wakeVerdict: () => ({ reason: 'engine-thread-unknown' }) });
    const fired = rotation.checkDeciderReachability(PM_PROJECT, d);

    const answered = decisionRouting.answerDecisionRequest(fired.request.decisionId, {
      answer: fired.request.choices[0], answeredBySurface: 'operator', answeredByActor: 'operator',
      expectedPromptDigest: fired.request.promptDigest
    });
    assert.equal(answered.ok, true);

    store.getDb().prepare("UPDATE medusa_exchanges SET terminal_at = ?, state = 'closed' WHERE recipient_workspace_id = 'pm-workspace'")
      .run(new Date(nowMs).toISOString());
    const recovered = rotation.checkDeciderReachability(PM_PROJECT, d);
    assert.equal(recovered.recovered, false, 'nothing open left to recover');

    const stillAnswered = decisionRouting.getDecisionRequest(fired.request.decisionId);
    assert.equal(stillAnswered.state, decisionRouting.STATES.ANSWERED);
  });
});

/** Refresh-scheduling deps: a healthy, idle, no-mail, no-pane-reading baseline a test overrides from. */
function refreshDeps(overrides = {}) {
  const nowMs = Date.parse(START);
  return {
    now: () => new Date(nowMs).toISOString(),
    medusaStatus: () => ({ workspaceId: 'pm-workspace' }),
    unreadExchanges: () => [],
    capturePane: async () => null,
    ...overrides
  };
}

describe('checkGovernedRefreshDue — not yet due', () => {
  it('a project with no active coordinator role is not checked', async () => {
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps());
    assert.equal(result.checked, false);
    assert.equal(result.reason, 'not an appointed coordinator');
  });

  it('a fresh session, well under the runtime interval, with no pane reading, is not due', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps());
    assert.equal(result.checked, true);
    assert.equal(result.due, false);
    assert.equal(result.reason, 'not due');
  });

  it('a pane reading above the low-context threshold does not trigger low-context due', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 40% left' }));
    assert.equal(result.due, false);
  });
});

describe('checkGovernedRefreshDue — fires a durable refresh-due alert, never an autonomous rotation', () => {
  it('is due on role runtime past the interval, and records a decision_requests alert', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const { session } = startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    // store.sessions.start stamps startedAt as "now" — backdate it directly to simulate a long-running session.
    store.getDb().prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
      .run(new Date(nowMs - rotation.ROLE_REFRESH_INTERVAL_MS - MINUTE).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), session.id);

    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps());
    assert.equal(result.checked, true);
    assert.equal(result.due, true);
    assert.equal(result.held, false);
    assert.equal(result.reason, 'role-runtime');
    assert.equal(result.request.gate, rotation.GOVERNED_REFRESH_GATE);
    assert.equal(result.request.requiredAuthority, 'human');
    assert.match(result.request.prompt, /tc rotation prepare/);
  });

  it('is due on low context remaining, from the live pane statusline, even with fresh runtime', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 8% left' }));
    assert.equal(result.due, true);
    assert.equal(result.reason, 'low-context');
    assert.match(result.request.prompt, /8%/);
  });

  it('is due exactly at the LOW_CONTEXT_REMAINING_PCT boundary, not only strictly below it', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({
      capturePane: async () => `Context ${rotation.LOW_CONTEXT_REMAINING_PCT}% left`
    }));
    assert.equal(result.due, true);
    assert.equal(result.reason, 'low-context');
  });

  it('never invents a context reading from session age — an unreadable pane stays "due" only via runtime, never via a fabricated low-context reason', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const { session } = startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    store.getDb().prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
      .run(new Date(nowMs - rotation.ROLE_REFRESH_INTERVAL_MS - MINUTE).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), session.id);
    // capturePane returns null (unreadable/unsupported engine) — the default in refreshDeps().
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps());
    assert.equal(result.due, true);
    assert.equal(result.reason, 'role-runtime', 'due for a real reason, not a fabricated context one');
  });

  it('holds (defers) rather than firing while the coordinator\'s workload is "working"', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 8% left' }));
    assert.equal(result.due, true);
    assert.equal(result.held, true);
    assert.equal(result.reason, 'deferred-busy');
    assert.equal(result.request, null, 'no alert is written while held');
  });

  it('does NOT hold forever on an EXPIRED "working" receipt with no owed reply (PRR-A I-Gate Round 2)', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    // > 30m working-expiry (same threshold the checkDeciderReachability
    // "fires on unread mail + expired workload receipt" test uses) -- a
    // receipt that still SAYS "working" but has gone stale is not evidence
    // the coordinator is actually busy right now.
    startDeciderSession(PM_PROJECT, { receiptState: 'working', receiptAgeMs: 40 * MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 8% left' }));
    assert.equal(result.due, true);
    assert.equal(result.held, false, 'an expired "working" receipt must not hold the refresh forever');
    assert.equal(result.reason, 'low-context');
    assert.ok(result.request, 'the alert is actually written, not withheld behind a stale-busy hold');
  });

  it('holds while the coordinator has an open owed Medusa reply, even with an idle-shaped receipt', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'waiting-external', receiptAgeMs: MINUTE, nowMs });
    const result = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({
      capturePane: async () => 'Context 8% left',
      unreadExchanges: () => [{ terminal_at: null, reply_required: 1, state: 'read' }]
    }));
    assert.equal(result.held, true);
    assert.equal(result.reason, 'ruling-in-flight');
  });

  it('repeated ticks of the same due condition replay into one open alert', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    const d = refreshDeps({ capturePane: async () => 'Context 8% left' });
    const first = await rotation.checkGovernedRefreshDue(PM_PROJECT, d);
    const second = await rotation.checkGovernedRefreshDue(PM_PROJECT, d);
    assert.equal(first.request.decisionId, second.request.decisionId);
  });
});

describe('checkGovernedRefreshDue — recovery', () => {
  it('closes the open alert once context/runtime moves back under threshold', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    const fired = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 8% left' }));
    assert.equal(fired.due, true);

    const recovered = await rotation.checkGovernedRefreshDue(PM_PROJECT, refreshDeps({ capturePane: async () => 'Context 50% left' }));
    assert.equal(recovered.due, false);
    assert.equal(recovered.reason, 'no-longer-due');

    const closed = decisionRouting.getDecisionRequest(fired.request.decisionId);
    assert.equal(closed.state, decisionRouting.STATES.SUPERSEDED);
    assert.match(closed.auditRationale, /recovered/);
  });
});

describe('refreshMonitorTick — the recurring caller both checks above need (#2351/#2353 Critic BLOCKING)', () => {
  afterEach(() => rotation.stopRefreshMonitor());

  it('is empty when no project has an active coordinator role', async () => {
    const results = await rotation.refreshMonitorTick(refreshDeps());
    assert.deepEqual(results, {});
  });

  it('runs both checks for every project with an active coordinator role', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    store.coordinatorRoles.grant({ roleId: 'role-2', projectId: ARCHITECT_PROJECT, role: 'architect', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    startDeciderSession(ARCHITECT_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });

    const results = await rotation.refreshMonitorTick(refreshDeps());
    assert.equal(results[PM_PROJECT].reachability.checked, true);
    assert.equal(results[PM_PROJECT].refresh.checked, true);
    assert.equal(results[ARCHITECT_PROJECT].reachability.checked, true);
    assert.equal(results[ARCHITECT_PROJECT].refresh.checked, true);
  });

  it('skips a project with no active session without crashing the pass', async () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    const results = await rotation.refreshMonitorTick(refreshDeps());
    assert.equal(results[PM_PROJECT].reachability.reason, 'no active session');
    assert.equal(results[PM_PROJECT].refresh.reason, 'no active session');
  });

  it('one project throwing does not stop the pass over the rest', async () => {
    const nowMs = Date.parse(START);
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: PM_PROJECT, role: 'project-manager', note: null, now: START });
    store.coordinatorRoles.grant({ roleId: 'role-2', projectId: ARCHITECT_PROJECT, role: 'architect', note: null, now: START });
    startDeciderSession(PM_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });
    startDeciderSession(ARCHITECT_PROJECT, { receiptState: 'complete', receiptAgeMs: MINUTE, nowMs });

    let calls = 0;
    const throwingMedusaStatus = () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic failure for the first project checked');
      return { workspaceId: 'pm-workspace' };
    };
    const results = await rotation.refreshMonitorTick(refreshDeps({ medusaStatus: throwingMedusaStatus }));
    const outcomes = Object.values(results);
    assert.ok(outcomes.some((r) => r.error), 'the throwing project is recorded as an error, not silently dropped');
    assert.ok(outcomes.some((r) => r.reachability && r.reachability.checked === true), 'the other project was still checked');
  });

  it('start/stop arm and clear the timer, idempotently, defaulting to REFRESH_MONITOR_INTERVAL_MS', () => {
    assert.ok(Number.isInteger(rotation.REFRESH_MONITOR_INTERVAL_MS) && rotation.REFRESH_MONITOR_INTERVAL_MS > 0);
    rotation.startRefreshMonitor(); // no intervalMs given -- falls back to REFRESH_MONITOR_INTERVAL_MS
    rotation.startRefreshMonitor(); // second call is a no-op, not a second timer
    rotation.stopRefreshMonitor();
    rotation.stopRefreshMonitor(); // stopping twice is also a no-op
  });
});
