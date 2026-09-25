'use strict';

// #1861: the durable HOLD/STOP state machine, over a scratch store. These are
// the rules the Architect ruled on: newest generation wins, HOLDs are
// cumulative and named, a RELEASE can only clear holds its releaser may clear,
// STOP is terminal, close never turns a STOP into an ungoverned project, and
// every accepted command is stored (with a notify_pending receipt) before it
// is reported accepted.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const control = require('../lib/control-state');

const OPERATOR = { principal: 'operator', operatorProof: 'verified-session' };
const PM = { principal: 'project:74' };
const ARCHITECT = { principal: 'project:70' };
const OUTSIDER = { principal: 'project:99' };

let tmpDir;
let target;
let targetActor;
let seq = 0;

/** @returns {string} A fresh request id */
function rid() {
  seq += 1;
  return `req-${seq}`;
}

/**
 * Create an assignment on the target with PM and Architect as hold and stop
 * authorities.
 * @param {object} [extra] - Authority overrides
 * @returns {object} The create result
 */
function assign(extra = {}) {
  return control.create({
    projectId: target.id,
    requestId: rid(),
    issueRef: '#1861',
    authority: { hold: ['project:74', 'project:70'], stop: ['project:74'], lifecycle: ['project:74'], ...extra },
    binding: { sessionId: 501, launchId: 'launch-target-1' }
  }, OPERATOR);
}

/**
 * Throw-assert a ControlError code.
 * @param {Function} fn - Command
 * @param {string} code - Expected code
 * @param {number} [status] - Expected HTTP status
 * @returns {object} The error
 */
function refuses(fn, code, status) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof control.ControlError, `expected ${code}, got ${caught && caught.message}`);
  assert.equal(caught.code, code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

describe('control-state (#1861)', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-state-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
    target = store.projects.create({ name: `target-${path.basename(dir)}`, path: dir, engine: 'claude' });
    targetActor = { principal: `project:${target.id}`, launchId: 'launch-target-1' };
  });

  describe('create', () => {
    it('is operator-only and stores generation 1 with a notify_pending receipt before returning', () => {
      refuses(() => control.create({ projectId: target.id, requestId: rid() }, PM), 'CONTROL_UNAUTHORIZED', 403);
      const res = assign();
      assert.equal(res.assignment.state, 'active');
      assert.equal(res.assignment.stateGeneration, 1);
      const st = control.status(res.assignment.assignmentId);
      assert.deepEqual(st.events.map((e) => e.kind), ['create']);
      assert.deepEqual(st.events[0].receipts.map((r) => r.fact), ['notify_pending']);
      assert.equal(st.events[0].operatorAuthority, 'verified-session');
    });

    it('never exposes the bound launch id', () => {
      const res = assign();
      assert.ok(!JSON.stringify(control.status(res.assignment.assignmentId)).includes('launch-target-1'));
    });

    it('allows one open assignment per project', () => {
      assign();
      refuses(() => assign(), 'ASSIGNMENT_OPEN', 409);
    });

    it('replays a duplicate create request id', () => {
      const requestId = rid();
      const a = control.create({ projectId: target.id, requestId }, OPERATOR);
      const b = control.create({ projectId: target.id, requestId }, OPERATOR);
      assert.equal(b.replayed, true);
      assert.equal(b.assignment.assignmentId, a.assignment.assignmentId);
    });

    it('refuses an operator whose identity is unverifiable', () => {
      refuses(() => control.create({ projectId: target.id, requestId: rid() }, { principal: 'operator' }), 'CONTROL_OPERATOR_UNVERIFIABLE', 503);
      refuses(() => control.create({ projectId: target.id, requestId: rid() }, { principal: 'operator', operatorProof: 'external-fallback' }),
        'CONTROL_OPERATOR_UNVERIFIABLE', 503);
    });

    it('rejects a matrix that gives the target stop, lifecycle or release authority', () => {
      const me = `project:${target.id}`;
      refuses(() => assign({ stop: [me] }), 'CONTROL_MALFORMED', 400);
      refuses(() => assign({ lifecycle: [me] }), 'CONTROL_MALFORMED', 400);
      refuses(() => assign({ releaseDelegations: { [me]: ['project:74'] } }), 'CONTROL_MALFORMED', 400);
      refuses(() => assign({ hold: ['PM'] }), 'CONTROL_MALFORMED', 400);
      refuses(() => assign({ bogus: [] }), 'CONTROL_MALFORMED', 400);
    });
  });

  describe('newest generation wins', () => {
    it('GO g1 → HOLD g2 → delayed RELEASE built on g1 is refused and the HOLD stands', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      assert.equal(h.assignment.stateGeneration, 2);
      const err = refuses(() => control.release({
        assignmentId: a.assignmentId, holdIds: [h.holdId], expectedGeneration: 1, requestId: rid(), reasonCode: 'resolved'
      }, PM), 'STALE_GENERATION', 409);
      assert.equal(err.details.stateGeneration, 2);
      assert.deepEqual(err.details.activeHoldIds, [h.holdId]);
      assert.equal(control.status(a.assignmentId).assignment.state, 'held');
    });

    it('rejects malformed, negative and non-integer generations', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      for (const bad of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
        refuses(() => control.release({
          assignmentId: a.assignmentId, holdIds: [h.holdId], expectedGeneration: bad, requestId: rid(), reasonCode: 'resolved'
        }, PM), 'CONTROL_MALFORMED', 400);
      }
    });

    it('treats a duplicate HOLD and a duplicate RELEASE (same request id) as no-ops', () => {
      const a = assign().assignment;
      const holdReq = rid();
      const h1 = control.hold({ assignmentId: a.assignmentId, requestId: holdReq, reasonCode: 'boundary' }, PM);
      const h2 = control.hold({ assignmentId: a.assignmentId, requestId: holdReq, reasonCode: 'boundary' }, PM);
      assert.equal(h2.replayed, true);
      assert.equal(h2.holdId, h1.holdId);
      assert.equal(h2.assignment.stateGeneration, 2);
      const relReq = rid();
      const r1 = control.release({ assignmentId: a.assignmentId, holdIds: [h1.holdId], expectedGeneration: 2, requestId: relReq, reasonCode: 'resolved' }, PM);
      const r2 = control.release({ assignmentId: a.assignmentId, holdIds: [h1.holdId], expectedGeneration: 2, requestId: relReq, reasonCode: 'resolved' }, PM);
      assert.equal(r2.replayed, true);
      assert.equal(r2.event.eventId, r1.event.eventId);
      assert.equal(control.status(a.assignmentId).assignment.stateGeneration, 3);
      assert.equal(control.status(a.assignmentId).events.length, 3);
    });

    it('refuses a request id reused for a different command', () => {
      const a = assign().assignment;
      const req = rid();
      control.hold({ assignmentId: a.assignmentId, requestId: req, reasonCode: 'boundary' }, PM);
      refuses(() => control.stop({ assignmentId: a.assignmentId, requestId: req, reasonCode: 'incident' }, PM), 'CONTROL_MALFORMED', 400);
    });

    it('converges on the same state whatever order a fixed set of requests arrives in', () => {
      const finals = [];
      const orders = [['holdPM', 'holdArch', 'relPM'], ['holdArch', 'holdPM', 'relPM'], ['holdArch', 'relPM', 'holdPM'], ['relPM', 'holdPM', 'holdArch']];
      for (const order of orders) {
        const dir = fs.mkdtempSync(path.join(tmpDir, 'perm-'));
        const proj = store.projects.create({ name: `perm-${path.basename(dir)}`, path: dir, engine: 'claude' });
        const a = control.create({ projectId: proj.id, requestId: rid(), authority: { hold: ['project:74', 'project:70'] } }, OPERATOR).assignment;
        const pmReq = rid();
        const archReq = rid();
        const relReq = rid();
        const deliver = (step) => {
          const cur = control.status(a.assignmentId);
          if (step === 'holdPM') return control.hold({ assignmentId: a.assignmentId, requestId: pmReq, reasonCode: 'boundary' }, PM);
          if (step === 'holdArch') return control.hold({ assignmentId: a.assignmentId, requestId: archReq, reasonCode: 'awaiting-ruling' }, ARCHITECT);
          const pmHold = cur.holds.find((h) => h.issuer === 'project:74' && h.releasedGeneration === null);
          if (!pmHold) return null;
          return control.release({ assignmentId: a.assignmentId, holdIds: [pmHold.holdId], expectedGeneration: cur.assignment.stateGeneration, requestId: relReq, reasonCode: 'resolved' }, PM);
        };
        // Each request is delivered, then redelivered: duplicates change nothing.
        for (const step of order) { deliver(step); try { deliver(step); } catch (err) { if (!(err instanceof control.ControlError)) throw err; } }
        // A release that arrived before its hold existed is retried once, as a sender would.
        deliver('relPM');
        const st = control.status(a.assignmentId);
        finals.push({ state: st.assignment.state, holders: st.holds.filter((h) => h.releasedGeneration === null).map((h) => h.issuer).sort() });
      }
      for (const f of finals) assert.deepEqual(f, { state: 'held', holders: ['project:70'] });
    });
  });

  describe('cumulative holds', () => {
    it('two holds from different authorities: releasing either leaves the other effective', () => {
      for (const firstReleaser of ['pm', 'arch']) {
        const dir = fs.mkdtempSync(path.join(tmpDir, 'cum-'));
        const proj = store.projects.create({ name: `cum-${path.basename(dir)}`, path: dir, engine: 'claude' });
        const a = control.create({ projectId: proj.id, requestId: rid(), authority: { hold: ['project:74', 'project:70'] } }, OPERATOR).assignment;
        const hp = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
        const ha = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'awaiting-ruling' }, ARCHITECT);
        const [first, firstHold, second, secondHold] = firstReleaser === 'pm' ? [PM, hp, ARCHITECT, ha] : [ARCHITECT, ha, PM, hp];
        const r1 = control.release({ assignmentId: a.assignmentId, holdIds: [firstHold.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'resolved' }, first);
        assert.equal(r1.assignment.state, 'held');
        assert.deepEqual(r1.assignment.activeHoldIds, [secondHold.holdId]);
        const r2 = control.release({ assignmentId: a.assignmentId, holdIds: [secondHold.holdId], expectedGeneration: 4, requestId: rid(), reasonCode: 'resolved' }, second);
        assert.equal(r2.assignment.state, 'active');
      }
    });

    it('the PM and the Architect cannot clear each other\'s holds by role; the operator clears any named hold', () => {
      const a = assign().assignment;
      const hp = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      const ha = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'awaiting-ruling' }, ARCHITECT);
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'resolved' }, ARCHITECT), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [ha.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'resolved' }, PM), 'CONTROL_UNAUTHORIZED', 403);
      const r = control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId, ha.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'operator-directive' }, OPERATOR);
      assert.equal(r.assignment.state, 'active');
    });

    it('an explicit delegation lets one authority release another\'s holds', () => {
      const a = assign({ releaseDelegations: { 'project:70': ['project:74'] } }).assignment;
      const hp = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      const r = control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'ruling-issued' }, ARCHITECT);
      assert.equal(r.assignment.state, 'active');
    });

    it('a release that names an inactive hold is refused', () => {
      const a = assign().assignment;
      const hp = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, PM);
      control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId], expectedGeneration: 4, requestId: rid(), reasonCode: 'resolved' }, PM), 'HOLD_NOT_ACTIVE', 409);
    });
  });

  describe('authority', () => {
    it('rejects an unlisted peer and a role-named principal', () => {
      const a = assign().assignment;
      refuses(() => control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, OUTSIDER), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, { principal: 'tangleclaw-projectmanager' }), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.stop({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'incident' }, ARCHITECT), 'CONTROL_UNAUTHORIZED', 403);
    });

    it('rejects a reason that is not a bounded code', () => {
      const a = assign().assignment;
      refuses(() => control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'please stop now' }, PM), 'CONTROL_MALFORMED', 400);
    });
  });

  describe('bounded release and STOP', () => {
    it('the target may self-HOLD but never releases, and only a non-target releaser clears it', () => {
      const a = assign({ releaseDelegations: { 'project:74': [`project:${target.id}`] } }).assignment;
      const self = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'self-hold' }, targetActor);
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [self.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, targetActor), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [self.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, ARCHITECT), 'CONTROL_UNAUTHORIZED', 403);
      const r = control.release({ assignmentId: a.assignmentId, holdIds: [self.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, PM);
      assert.equal(r.assignment.state, 'active');
    });

    it('STOP is terminal: no RELEASE, HOLD or close clears it, and it keeps governing the project', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      refuses(() => control.stop({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'incident' }, targetActor), 'CONTROL_UNAUTHORIZED', 403);
      const s = control.stop({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary-crossed' }, PM);
      assert.equal(s.assignment.state, 'stopped');
      refuses(() => control.release({ assignmentId: a.assignmentId, holdIds: [h.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'operator-directive' }, OPERATOR), 'ASSIGNMENT_STOPPED', 409);
      refuses(() => control.close({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'completed' }, OPERATOR), 'STOP_TERMINAL', 409);
      assert.equal(store.control.getOpenForProject(target.id).assignment_id, a.assignmentId, 'a stopped assignment still governs');
    });

    it('an operator successor supersedes a STOP atomically and starts at generation 1', () => {
      const a = assign().assignment;
      control.stop({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'incident' }, OPERATOR);
      refuses(() => control.create({ projectId: target.id, requestId: rid() }, PM), 'CONTROL_UNAUTHORIZED', 403);
      const b = assign();
      assert.equal(b.supersededAssignmentId, a.assignmentId);
      assert.notEqual(b.assignment.assignmentId, a.assignmentId);
      assert.equal(b.assignment.stateGeneration, 1);
      const old = control.status(a.assignmentId).assignment;
      assert.equal(old.state, 'closed');
      assert.equal(old.supersededBy, b.assignment.assignmentId);
      assert.ok(old.stoppedAt, 'the record keeps that it was stopped');
      // No notice goes out for the superseded assignment; its close says so
      // rather than showing a notice pending forever.
      const closeReceipts = control.status(a.assignmentId).events.at(-1).receipts.map((r) => [r.fact, r.outcomeCode]);
      assert.deepEqual(closeReceipts, [['notify_pending', null], ['notify_attempted', 'skipped']]);
    });

    it('close: held ⇒ ACTIVE_HOLDS; active ⇒ closed by the operator or a lifecycle authority; others 403', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      refuses(() => control.close({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'completed' }, PM), 'ACTIVE_HOLDS', 409);
      control.release({ assignmentId: a.assignmentId, holdIds: [h.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, PM);
      refuses(() => control.close({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'completed' }, ARCHITECT), 'CONTROL_UNAUTHORIZED', 403);
      const c = control.close({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'completed' }, PM);
      assert.equal(c.assignment.state, 'closed');
      assert.equal(c.assignment.stateGeneration, 3, 'close does not move the state generation');
      assert.equal(store.control.getOpenForProject(target.id), null);
    });
  });

  describe('audit: immutable events, receipts apart from state generation', () => {
    it('receipts never move the state generation and advance on their own sequence', () => {
      const a = assign().assignment;
      control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      const before = control.status(a.assignmentId);
      const holdEvent = before.events[1];
      control.recordNotify(holdEvent.eventId, 'failed');
      control.observe(a.assignmentId, 'gate-refusal', targetActor.principal);
      control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, targetActor);
      control.closeExchange({ assignmentId: a.assignmentId, eventId: holdEvent.eventId }, PM);
      const afterSt = control.status(a.assignmentId);
      assert.equal(afterSt.assignment.stateGeneration, 2);
      assert.deepEqual(afterSt.events[1].receipts.map((r) => r.fact),
        ['notify_pending', 'notify_attempted', 'observed', 'acknowledged', 'exchange_closed']);
      const seqs = afterSt.events[1].receipts.map((r) => r.receiptSeq);
      assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
      assert.equal(afterSt.events.length, before.events.length, 'receipts added no events');
    });

    it('a notify failure leaves the event committed', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      control.recordNotify(h.event.eventId, 'failed');
      assert.equal(control.status(a.assignmentId).assignment.state, 'held');
    });

    it('the database refuses UPDATE and DELETE on events and receipts', () => {
      const a = assign().assignment;
      const db = store.getDb();
      assert.throws(() => db.prepare("UPDATE control_events SET reason_code = 'x' WHERE assignment_id = ?").run(a.assignmentId), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM control_events WHERE assignment_id = ?').run(a.assignmentId), /append-only/);
      assert.throws(() => db.prepare("UPDATE control_receipts SET fact = 'observed'").run(), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM control_receipts').run(), /append-only/);
    });

    it('replaying the event log rebuilds the caches exactly', () => {
      const a = assign().assignment;
      const hp = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'awaiting-ruling' }, ARCHITECT);
      control.release({ assignmentId: a.assignmentId, holdIds: [hp.holdId], expectedGeneration: 3, requestId: rid(), reasonCode: 'resolved' }, PM);
      const cached = control.status(a.assignmentId).assignment;
      const replayed = control.replayState(a.assignmentId);
      assert.deepEqual(replayed, { state: cached.state, stateGeneration: cached.stateGeneration, activeHoldIds: cached.activeHoldIds });
    });
  });

  describe('acknowledgement and rebind', () => {
    it('only the target\'s bound launch acknowledges, and only the current generation', () => {
      const a = assign().assignment;
      control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      refuses(() => control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, PM), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, { ...targetActor, launchId: 'someone-elses' }), 'CONTROL_UNAUTHORIZED', 403);
      refuses(() => control.ack({ assignmentId: a.assignmentId, stateGeneration: 1 }, targetActor), 'STALE_GENERATION', 409);
      control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, targetActor);
    });

    it('a rebind moves the binding without moving the generation, and the old launch stops authorizing', () => {
      const a = assign().assignment;
      control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      const r = control.rebind({ projectId: target.id, sessionId: 777, launchId: 'launch-target-2' });
      assert.equal(r.stateGeneration, 2);
      assert.equal(r.boundSessionId, 777);
      refuses(() => control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, targetActor), 'CONTROL_UNAUTHORIZED', 403);
      control.ack({ assignmentId: a.assignmentId, stateGeneration: 2 }, { ...targetActor, launchId: 'launch-target-2' });
      assert.equal(control.status(a.assignmentId).events.at(-1).kind, 'rebind');
    });

    it('a rebind into a STOPPED project is refused, and an ungoverned project rebinds to nothing', () => {
      assert.equal(control.rebind({ projectId: target.id, sessionId: 1, launchId: 'x' }), null);
      const a = assign().assignment;
      control.stop({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'incident' }, OPERATOR);
      refuses(() => control.rebind({ projectId: target.id, sessionId: 2, launchId: 'y' }), 'CONTROL_STOPPED', 423);
    });
  });

  describe('restart', () => {
    it('state, generation and active holds survive closing and reopening the store', () => {
      const a = assign().assignment;
      const h = control.hold({ assignmentId: a.assignmentId, requestId: rid(), reasonCode: 'boundary' }, PM);
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      const st = control.status(a.assignmentId).assignment;
      assert.equal(st.state, 'held');
      assert.equal(st.stateGeneration, 2);
      assert.deepEqual(st.activeHoldIds, [h.holdId]);
    });
  });
});
