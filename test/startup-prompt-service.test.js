'use strict';

/*
 * The startup prompt service (#1825): validation, the redacted read, the
 * compare-and-set update with provenance, the fire scope rule (with an
 * external 404 for anything out of scope), idempotency by key, the single
 * active slot, the applied-once rule, and the typed `unsupported` answer that
 * is recorded and never falls back to typing into a pane.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../lib/startup-prompt');

const ACTIVE_STATES = ['pending', 'dispatching', 'indeterminate', 'accepted'];

/**
 * Fake lookups: projects 1 (target), 2 (a firer sharing group g1), 3 (a firer
 * in no shared group) and 4 (unlisted, in g1); session 10 in project 1 with
 * launch 100.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function deps(over = {}) {
  const revisions = [{
    revision: 1, text: 'read your launch context: run tc start next', textDigest: 't1', policyDigest: 'p1',
    firerProjectIds: [2, 3], createdAt: 'now', createdByKind: 'seed', createdBy: null
  }];
  const fires = [];
  let inTx = 0;
  const d = {
    prompts: {
      transaction: (fn) => { inTx += 1; try { return fn(); } finally { inTx -= 1; } },
      current: () => revisions[revisions.length - 1],
      update: ({ text, firerProjectIds, expectedRevision, byKind, byName }) => {
        const cur = revisions[revisions.length - 1];
        if (cur.revision !== expectedRevision) return { ok: false, currentRevision: cur.revision };
        revisions.push({
          revision: cur.revision + 1, text, textDigest: `t${cur.revision + 1}`, policyDigest: `p${cur.revision + 1}`,
          firerProjectIds, createdAt: 'now', createdByKind: byKind, createdBy: byName
        });
        return { ok: true, prompt: revisions[revisions.length - 1] };
      },
      insertFire: (f) => {
        assert.ok(inTx > 0, 'a fire row is written inside the transaction');
        const row = { id: fires.length + 1, ...f };
        fires.push(row);
        return row;
      },
      getFireByKey: (k) => fires.find((f) => f.idempotencyKey === k) || null,
      getFireById: (id) => fires.find((f) => f.id === id) || null,
      updateFire: (id, patch) => {
        const f = fires.find((x) => x.id === id);
        if (!f) return { ok: false, reason: 'no such fire', fire: null };
        Object.assign(f, { outcome: patch.outcome, reasonCode: patch.reasonCode === undefined ? null : patch.reasonCode, reason: patch.reason || null });
        if (patch.engineThreadId) f.engineThreadId = patch.engineThreadId;
        if (patch.engineTurnId) f.engineTurnId = patch.engineTurnId;
        return { ok: true, fire: f };
      },
      activeFire: (seq) => fires.find((f) => f.sequenceId === seq && ACTIVE_STATES.includes(f.outcome)) || null,
      appliedFire: (seq, rev) => fires.find((f) => f.sequenceId === seq && f.promptRevision === rev && f.outcome === 'applied') || null
    },
    getProjectByName: (name) => ({ target: { id: 1 }, other: { id: 4 } })[name] || null,
    getProject: (id) => ([1, 2, 3, 4].includes(id) ? { id } : null),
    getSession: (id) => (id === 10 ? { id: 10, projectId: 1, engineId: 'codex', status: 'active' } : null),
    getLaunchBySession: (sid) => (sid === 10 ? { id: 100, sessionId: 10, launchId: 'bearer-L1', revision: 2, sourceManifest: { rules: [{ id: 7, source: 'project', revision: 3, contentHash: 'h7' }], handoffPublicationId: 'pub-1', handoffDigest: 'hd-1', renderContext: { projectName: 'target' } } } : null),
    listSteps: () => [{ id: 'identity', digest: 'd-i' }, { id: 'governance', digest: 'd-g' }, { id: 'state', digest: 'd-s' }, { id: 'task', digest: 'd-t' }],
    logActivity: () => {},
    acceptWaitMs: 50,
    getEngine: (id) => ({ id, capabilities: {} }),
    groupsForProject: (pid) => ({ 1: [{ id: 'g1' }], 2: [{ id: 'g1' }], 3: [{ id: 'g9' }], 4: [{ id: 'g1' }] })[pid] || [],
    adapters: {},
    _fires: fires,
    _revisions: revisions,
    ...over
  };
  return d;
}

const OPERATOR = { kind: 'operator', projectId: null, groupIds: [] };
const FIRER_IN_GROUP = { kind: 'project', projectId: 2, groupIds: ['g1'] };
const FIRER_OUT_OF_GROUP = { kind: 'project', projectId: 3, groupIds: ['g9'] };
const UNLISTED_IN_GROUP = { kind: 'project', projectId: 4, groupIds: ['g1'] };

let keyN = 0;
/**
 * A fire request at session 10 / launch 100.
 * @param {object} caller - Resolved caller.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function req(caller, over = {}) {
  keyN += 1;
  return {
    projectName: 'target', sessionId: 10, sequenceId: 100, expectedRevision: 1,
    idempotencyKey: `key-${String(keyN).padStart(8, '0')}`,
    caller, clearance: caller.kind === 'operator' ? 'operator-verified' : 'project-binding',
    ...over
  };
}

describe('startup prompt service: validation', () => {
  it('accepts plain and multi-line text', async () => {
    assert.equal(svc.textProblem('run tc start next'), null);
    assert.equal(svc.textProblem('line one\nline two'), null);
  });

  it('counts the limit in UTF-8 bytes, not characters', async () => {
    assert.equal(svc.textProblem('a'.repeat(svc.MAX_PROMPT_BYTES)), null);
    assert.match(svc.textProblem('a'.repeat(svc.MAX_PROMPT_BYTES + 1)), /bytes/);
    // 2048 two-byte characters fit; one more does not.
    assert.equal(svc.textProblem('é'.repeat(svc.MAX_PROMPT_BYTES / 2)), null);
    assert.match(svc.textProblem('é'.repeat(svc.MAX_PROMPT_BYTES / 2 + 1)), /bytes/);
  });

  it('refuses empty text and every control character except LF', async () => {
    assert.match(svc.textProblem('   '), /empty/);
    assert.match(svc.textProblem(42), /string/);
    for (const c of ['\u001b', '\r', '\t', '\u0000', '\u007f', '\u0080', '\u009b', '\u009f']) {
      assert.match(svc.textProblem(`a${c}b`), /control/, JSON.stringify(c));
    }
    assert.equal(svc.textProblem('a b'), null, 'NBSP is not a control character');
  });

  it('refuses a malformed, repeated or unknown firer list', async () => {
    const d = deps();
    assert.equal(svc.firersProblem([2, 3], d), null);
    assert.match(svc.firersProblem('2', d), /array/);
    assert.match(svc.firersProblem([2, 2], d), /repeat/);
    assert.match(svc.firersProblem([2, '3'], d), /positive integer/);
    assert.match(svc.firersProblem([99], d), /do not exist: 99/);
    assert.match(svc.firersProblem(Array.from({ length: svc.MAX_FIRERS + 1 }, (_, i) => i + 1), d), /at most/);
  });
});

describe('startup prompt service: read', () => {
  it('the operator sees the whole firer list and who wrote the revision', async () => {
    const r = svc.read(OPERATOR, deps());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.firerProjectIds, [2, 3]);
    assert.equal(r.body.updatedByKind, 'seed');
    assert.equal(r.body.textDigest, 't1');
    assert.equal(r.body.policyDigest, 'p1');
  });

  it('a project session sees the prompt and digests, but only whether it is listed itself', async () => {
    const listed = svc.read(FIRER_IN_GROUP, deps()).body;
    assert.equal(listed.callerListedAsFirer, true);
    assert.equal(listed.firerProjectIds, undefined, 'other projects\' authority is not disclosed');
    assert.equal(listed.text, 'read your launch context: run tc start next');
    assert.equal(svc.read(UNLISTED_IN_GROUP, deps()).body.callerListedAsFirer, false);
  });

  it('carries no launch-shaped field', async () => {
    for (const caller of [OPERATOR, FIRER_IN_GROUP]) {
      assert.ok(!Object.keys(svc.read(caller, deps()).body).some((k) => /launch/i.test(k)));
    }
  });
});

describe('startup prompt service: update', () => {
  const PROOF = { clearance: 'operator-verified', actor: 'rosie' };

  it('writes the full state as a new revision with the proof\'s provenance', async () => {
    const d = deps();
    const r = svc.update({ text: 'new', firerProjectIds: [2], expectedRevision: 1 }, PROOF, d);
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 2);
    assert.equal(r.body.updatedByKind, 'operator-verified');
    assert.equal(r.body.updatedBy, 'rosie');
    assert.deepEqual(r.body.firerProjectIds, [2]);
  });

  it('requires the firer list: a save states the whole prompt', async () => {
    const r = svc.update({ text: 'new', expectedRevision: 1 }, PROOF, deps());
    assert.equal(r.status, 400);
    assert.match(r.body.error, /firerProjectIds is required/);
  });

  it('refuses a stale revision with 409 and the current revision', async () => {
    const d = deps();
    svc.update({ text: 'new', firerProjectIds: [], expectedRevision: 1 }, PROOF, d);
    const r = svc.update({ text: 'lost', firerProjectIds: [], expectedRevision: 1 }, PROOF, d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STALE_STARTUP_PROMPT');
    assert.equal(r.body.currentRevision, 2);
  });

  it('refuses invalid input with 400 before writing', async () => {
    const d = deps();
    assert.equal(svc.update({ text: 'x', firerProjectIds: [] }, PROOF, d).body.code, 'STARTUP_PROMPT_INVALID');
    assert.equal(svc.update({ text: '', firerProjectIds: [], expectedRevision: 1 }, PROOF, d).status, 400);
    assert.equal(svc.update({ text: 'ok', firerProjectIds: [99], expectedRevision: 1 }, PROOF, d).status, 400);
    assert.equal(svc.update(null, PROOF, d).status, 400);
    assert.equal(d.prompts.current().revision, 1, 'nothing was written');
  });
});

describe('startup prompt service: who may fire', () => {
  const prompt = { firerProjectIds: [2, 3] };

  it('the operator may fire anywhere', async () => {
    assert.equal(svc.canFire(OPERATOR, 1, prompt, deps()), true);
  });

  it('a listed firer may fire only into a project it shares a group with', async () => {
    assert.equal(svc.canFire(FIRER_IN_GROUP, 1, prompt, deps()), true);
    assert.equal(svc.canFire(FIRER_OUT_OF_GROUP, 1, prompt, deps()), false);
  });

  it('sharing a group is not enough without being listed', async () => {
    assert.equal(svc.canFire(UNLISTED_IN_GROUP, 1, prompt, deps()), false);
  });

  it('master, unbound, invalid and missing callers may not fire', async () => {
    for (const kind of ['master', 'unbound', 'invalid']) {
      assert.equal(svc.canFire({ kind, projectId: 2, groupIds: ['g1'] }, 1, prompt, deps()), false, kind);
    }
    assert.equal(svc.canFire(null, 1, prompt, deps()), false);
  });
});

describe('startup prompt service: fire', () => {
  let d;
  beforeEach(() => { d = deps(); });

  it('an engine with no adapter gets a typed unsupported refusal, recorded with its evidence', async () => {
    const r = await svc.fire(req(OPERATOR), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STARTUP_CONTROL_UNSUPPORTED');
    assert.equal(r.body.engine, 'codex');
    assert.equal(r.body.reasonCode, 'engine_declares_none');
    const f = d._fires[0];
    assert.equal(d._fires.length, 1);
    assert.equal(f.outcome, 'unsupported');
    assert.equal(f.callerKind, 'operator');
    assert.equal(f.callerClearance, 'operator-verified');
    assert.equal(f.promptRevision, 1);
    assert.equal(f.promptTextDigest, 't1');
    assert.equal(f.policyDigest, 'p1');
    assert.equal(f.projectId, 1);
  });

  it('an unreadable engine profile is a recorded unsupported, not an error', async () => {
    const broken = deps({ getEngine: () => { throw new Error('bad json'); } });
    const r = await svc.fire(req(OPERATOR), broken);
    assert.equal(r.status, 409);
    assert.equal(r.body.reasonCode, 'engine_profile_unreadable');
    assert.equal(broken._fires[0].outcome, 'unsupported');
  });

  it('a repeat of the same key returns the first record and records nothing new', async () => {
    const request = req(OPERATOR);
    const first = await svc.fire(request, d);
    const again = await svc.fire({ ...request }, d);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.fire.id, first.body.fire.id);
    assert.equal(d._fires.length, 1);
  });

  it('a new key after an unsupported outcome is a new attempt: unsupported is not a permanent key', async () => {
    await svc.fire(req(OPERATOR), d);
    await svc.fire(req(OPERATOR), d);
    assert.equal(d._fires.length, 2);
  });

  it('a key reused for a different target is refused', async () => {
    const request = req(OPERATOR);
    await svc.fire(request, d);
    d.getSession = (id) => ([10, 11].includes(id) ? { id, projectId: 1, engineId: 'codex', status: 'active' } : null);
    d.getLaunchBySession = (sid) => ({ id: sid * 10, sessionId: sid });
    const r = await svc.fire({ ...request, sessionId: 11, sequenceId: 110 }, d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('records the agent caller, its project and its binding clearance', async () => {
    await svc.fire(req(FIRER_IN_GROUP), d);
    assert.equal(d._fires[0].callerKind, 'project');
    assert.equal(d._fires[0].callerProjectId, 2);
    assert.equal(d._fires[0].callerClearance, 'project-binding');
  });

  it('an out-of-scope target answers exactly like a missing one, and the denial is recorded', async () => {
    const denied = await svc.fire(req(UNLISTED_IN_GROUP), d);
    const missing = await svc.fire(req(UNLISTED_IN_GROUP, { sessionId: 12 }), d);
    assert.equal(denied.status, 404);
    assert.equal(denied.body.code, 'SESSION_NOT_FOUND');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, denied.body.code);
    assert.equal(d._fires.length, 1, 'only the real target\'s denial is recorded');
    assert.equal(d._fires[0].outcome, 'denied');
    assert.equal(d._fires[0].reasonCode, 'fire_scope_denied');
    assert.equal((await svc.fire(req(FIRER_OUT_OF_GROUP), d)).status, 404);
  });

  it('refuses an unknown project or a session that is not active in it', async () => {
    assert.equal((await svc.fire(req(OPERATOR, { projectName: 'nope' }), d)).body.code, 'SESSION_NOT_FOUND');
    assert.equal((await svc.fire(req(OPERATOR, { sessionId: 11 }), d)).body.code, 'SESSION_NOT_FOUND');
    assert.equal((await svc.fire(req(OPERATOR, { projectName: 'other' }), d)).body.code, 'SESSION_NOT_FOUND');
    const ended = deps({ getSession: () => ({ id: 10, projectId: 1, engineId: 'codex', status: 'ended' }) });
    assert.equal((await svc.fire(req(OPERATOR), ended)).body.code, 'SESSION_NOT_FOUND');
  });

  it('refuses a launch that is not the session\'s current one', async () => {
    const r = await svc.fire(req(OPERATOR, { sequenceId: 99 }), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'LAUNCH_NOT_CURRENT');
    assert.equal(d._fires.length, 0);
  });

  it('refuses a stale prompt revision', async () => {
    const r = await svc.fire(req(OPERATOR, { expectedRevision: 2 }), d);
    assert.equal(r.body.code, 'STALE_STARTUP_PROMPT');
    assert.equal(r.body.currentRevision, 1);
  });

  it('never injects an applied revision into the same launch again', async () => {
    d._fires.push({ id: 90, idempotencyKey: 'x', sequenceId: 100, promptRevision: 1, outcome: 'applied', sessionId: 10 });
    const r = await svc.fire(req(OPERATOR), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STARTUP_PROMPT_ALREADY_APPLIED');
  });

  it('refuses while another fire is active on the launch, for every active state', async () => {
    for (const outcome of ACTIVE_STATES) {
      const dd = deps();
      dd._fires.push({ id: 91, idempotencyKey: 'y', sequenceId: 100, promptRevision: 1, outcome, sessionId: 10 });
      const r = await svc.fire(req(OPERATOR), dd);
      assert.equal(r.body.code, 'STARTUP_FIRE_IN_FLIGHT', outcome);
    }
  });

  it('refuses a malformed idempotency key or non-integer targets', async () => {
    assert.equal((await svc.fire(req(OPERATOR, { idempotencyKey: 'short' }), d)).status, 400);
    assert.equal((await svc.fire(req(OPERATOR, { idempotencyKey: 'has space in it' }), d)).status, 400);
    assert.equal((await svc.fire(req(OPERATOR, { idempotencyKey: undefined }), d)).status, 400);
    assert.equal((await svc.fire(req(OPERATOR, { sessionId: '10' }), d)).status, 400);
  });

  it('a registered adapter that cannot dispatch is refused with 501, and nothing is recorded or touched', async () => {
    const block = { adapter: 'fake', channel: 'c', readiness: 'r', receipt: 'x', blockers: 'b', verifiedVersions: ['1'] };
    block.evidence = Object.fromEntries(Object.keys(block).map((k) => [k, { verifiedOn: null, source: 's' }]));
    const supported = deps({
      getEngine: (id) => ({ id, capabilities: { startupControl: block } }),
      adapters: { fake: { installedVersion: () => '1' } }
    });
    const r = await svc.fire(req(OPERATOR), supported);
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'STARTUP_CONTROL_DISPATCH_UNAVAILABLE');
    assert.equal(supported._fires.length, 0);
  });

  /**
   * A supported engine whose adapter is a scripted fake.
   * @param {(input: object) => {accepted: Promise, settled: Promise}} fireImpl - The fake fire.
   * @returns {object} deps
   */
  function supportedDeps(fireImpl) {
    const block = { adapter: 'fake', channel: 'c', readiness: 'r', receipt: 'x', blockers: 'b', verifiedVersions: ['1'] };
    block.evidence = Object.fromEntries(Object.keys(block).map((k) => [k, { verifiedOn: null, source: 's' }]));
    return deps({
      getEngine: (id) => ({ id, capabilities: { startupControl: block } }),
      adapters: { fake: { installedVersion: () => '1', fire: fireImpl } }
    });
  }

  it('a dispatching adapter gets a durable pending intent first, the launch-bound payload, and the route answers the row as the adapter left it', async () => {
    let seen = null;
    const d = supportedDeps((input) => {
      seen = input;
      assert.equal(d._fires[0].outcome, 'pending', 'the intent row exists before the adapter runs');
      const row = input.onUpdate({ outcome: 'dispatching', engineThreadId: 'T' });
      assert.equal(row.outcome, 'dispatching');
      const accepted = Promise.resolve(input.onUpdate({ outcome: 'accepted', engineTurnId: 'U' }));
      return { accepted, settled: accepted.then(() => new Promise((resolve) => setTimeout(() => resolve(input.onUpdate({ outcome: 'applied' })), 20))) };
    });
    const r = await svc.fire(req(OPERATOR), d);
    assert.equal(r.status, 200);
    assert.equal(r.body.fire.outcome, 'accepted', 'answered at acceptance, before the watch settles');
    assert.equal(seen.sequenceId, 100);
    assert.equal(seen.promptText, 'read your launch context: run tc start next');
    assert.equal(seen.promptTextDigest, 't1');
    assert.match(seen.payloadDigest, /^[0-9a-f]{64}$/);
    const row = d._fires[0];
    assert.equal(row.payloadDigest, seen.payloadDigest);
    assert.ok(!JSON.stringify(row.payload).includes('bearer-L1'), 'the launch bearer is hashed in, never stored');
    assert.equal(row.payload.roleAssignmentSource, 'project-binding+session-rules+handoff');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(d._fires[0].outcome, 'applied', 'the watch settled in the background');
  });

  it('a pre-send blocker answers 409 STARTUP_FIRE_BLOCKED and frees the launch for another fire', async () => {
    const d = supportedDeps((input) => {
      const row = input.onUpdate({ outcome: 'blocked', reasonCode: 'trust_required', reason: 'not trusted' });
      return { accepted: Promise.resolve(row), settled: Promise.resolve(row) };
    });
    const first = await svc.fire(req(OPERATOR), d);
    assert.equal(first.status, 409);
    assert.equal(first.body.code, 'STARTUP_FIRE_BLOCKED');
    assert.equal(first.body.reasonCode, 'trust_required');
    const second = await svc.fire(req(OPERATOR), d);
    assert.equal(second.status, 409, 'a new fire is decided afresh');
    assert.equal(second.body.code, 'STARTUP_FIRE_BLOCKED');
    assert.equal(d._fires.length, 2, 'blocked released the slot, so the second attempt was recorded');
  });

  it('an adapter that throws before sending fails the fire as channel_lost, with the intent recorded', async () => {
    const d = supportedDeps(() => { throw new Error('boom'); });
    const r = await svc.fire(req(OPERATOR), d);
    assert.equal(r.status, 200);
    assert.equal(r.body.fire.outcome, 'failed');
    assert.equal(r.body.fire.reasonCode, 'channel_lost');
  });

  it('an indeterminate fire is reconciled before a new fire is decided, and stays in the way until it settles', async () => {
    let reconciled = 0;
    const d = supportedDeps(() => { throw new Error('should not fire'); });
    d.adapters.fake.reconcile = ({ fire, onUpdate }) => { reconciled += 1; return Promise.resolve(onUpdate({ outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'absent' })); };
    d._fires.push({ id: 1, idempotencyKey: 'old-key-00000001', projectId: 1, sessionId: 10, sequenceId: 100, promptRevision: 1, outcome: 'indeterminate', reasonCode: 'send_unconfirmed', engineThreadId: 'T', payloadDigest: 'x'.repeat(64) });
    d.adapters.fake.fire = (input) => { const row = input.onUpdate({ outcome: 'blocked', reasonCode: 'engine_not_ready', reason: 'r' }); return { accepted: Promise.resolve(row), settled: Promise.resolve(row) }; };
    const r = await svc.fire(req(OPERATOR), d);
    assert.equal(reconciled, 1);
    assert.equal(d._fires[0].outcome, 'failed', 'the old fire was settled from the record');
    assert.equal(r.body.code, 'STARTUP_FIRE_BLOCKED', 'and the new fire was then decided');
  });
});

describe('startup prompt service: the launch-start payload (E8)', () => {
  const crypto = require('node:crypto');
  const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  const launch = { id: 100, launchId: 'bearer-L1', revision: 2, sourceManifest: { rules: [{ id: 9, source: 'project', revision: 1, contentHash: 'h9' }, { id: 7, source: 'project', revision: 3, contentHash: 'h7' }], handoffPublicationId: 'pub-1', handoffDigest: 'hd-1', renderContext: { projectName: 'target' } } };
  const prompt = { revision: 4, textDigest: 'td', policyDigest: 'pd' };
  const d = { listSteps: () => [{ id: 'identity', digest: 'd-i' }, { id: 'governance', digest: 'd-g' }, { id: 'state', digest: 'd-s' }, { id: 'task', digest: 'd-t' }] };

  it('hashes domain-separated, versioned canonical objects from the frozen snapshot, and never stores the bearer', () => {
    const { stored, digest } = svc.buildLaunchPayload({ launch, session: { id: 10 }, project: { id: 1 }, prompt }, d);
    assert.equal(stored.primingPactDigest, sha(svc.canonicalJson({ kind: 'startup-priming-pact', version: 1, launchRevision: 2, steps: { identity: 'd-i', governance: 'd-g', state: 'd-s', task: 'd-t' } })));
    assert.deepEqual(stored.roleAssignment, {
      kind: 'startup-role-assignment', version: 1, projectId: 1, projectName: 'target', roleKind: 'project-bound',
      ruleFingerprints: [{ id: 7, source: 'project', revision: 3, contentHash: 'h7' }, { id: 9, source: 'project', revision: 1, contentHash: 'h9' }],
      handoffPublicationId: 'pub-1', handoffDigest: 'hd-1'
    });
    assert.equal(stored.roleAssignmentRevision, sha(svc.canonicalJson(stored.roleAssignment)));
    assert.equal(stored.roleAssignmentSource, 'project-binding+session-rules+handoff');
    assert.equal(stored.canonVersion, svc.PAYLOAD_CANON_VERSION);
    assert.equal(stored.launchId, undefined);
    assert.ok(!JSON.stringify(stored).includes('bearer-L1'));
    const full = { ...stored, launchId: 'bearer-L1' };
    delete full.roleAssignment;
    assert.equal(digest, sha(svc.canonicalJson(full)), 'the digest covers the payload WITH the bearer');
    const again = svc.buildLaunchPayload({ launch, session: { id: 10 }, project: { id: 1 }, prompt }, d);
    assert.equal(again.digest, digest, 'deterministic');
    const other = svc.buildLaunchPayload({ launch: { ...launch, launchId: 'bearer-L2' }, session: { id: 10 }, project: { id: 1 }, prompt }, d);
    assert.notEqual(other.digest, digest, 'a different launch is a different digest');
  });

  it('reads nothing live: missing steps and an absent manifest hash as explicit nulls', () => {
    const { stored } = svc.buildLaunchPayload({ launch: { id: 1, launchId: 'x', revision: 1, sourceManifest: null }, session: { id: 10 }, project: { id: 1 }, prompt }, { listSteps: () => { throw new Error('unreadable'); } });
    assert.deepEqual(stored.stepDigests, { identity: null, governance: null, state: null, task: null });
    assert.deepEqual(stored.roleAssignment.ruleFingerprints, []);
    assert.equal(stored.roleAssignment.handoffPublicationId, null);
    assert.equal(stored.roleAssignment.projectName, null);
  });

  it('canonical JSON sorts keys at every depth', () => {
    assert.equal(svc.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});
