'use strict';

/*
 * The startup prompt service (#1825): validation, compare-and-set update, the
 * fire scope rule, exact-launch targeting, and the typed `unsupported` answer
 * that is audited and never falls back to typing into a pane.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../lib/startup-prompt');

const ACTIVE = 'active';

/**
 * Fake lookups: projects 1 (target) and 2 (a firer sharing group g1) and 3
 * (a firer in no shared group), session 10 in project 1 with launch 100.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function deps(over = {}) {
  const revisions = [{ revision: 1, text: 'read your launch context: run tc start next', digest: 'd1', firerProjectIds: [2, 3], createdAt: 't', createdByKind: 'seed' }];
  const fires = [];
  const d = {
    prompts: {
      current: () => revisions[revisions.length - 1],
      update: ({ text, firerProjectIds, expectedRevision, byKind }) => {
        const cur = revisions[revisions.length - 1];
        if (cur.revision !== expectedRevision) return { ok: false, currentRevision: cur.revision };
        const next = { revision: cur.revision + 1, text, digest: `d${cur.revision + 1}`, firerProjectIds, createdAt: 't', createdByKind: byKind };
        revisions.push(next);
        return { ok: true, prompt: next };
      },
      recordFire: (f) => {
        const existing = fires.find((x) => x.sequenceId === f.sequenceId && x.promptRevision === f.promptRevision);
        if (existing) return { fire: existing, duplicate: true };
        const row = { id: fires.length + 1, ...f };
        fires.push(row);
        return { fire: row, duplicate: false };
      }
    },
    getProjectByName: (name) => ({ target: { id: 1 }, other: { id: 4 } })[name] || null,
    getProject: (id) => ([1, 2, 3, 4].includes(id) ? { id } : null),
    getSession: (id) => (id === 10 ? { id: 10, projectId: 1, engineId: 'codex', status: ACTIVE } : null),
    getLaunchBySession: (sid) => (sid === 10 ? { id: 100, sessionId: 10 } : null),
    getEngine: (id) => ({ id, capabilities: {} }),
    groupsForProject: (pid) => ({ 1: [{ id: 'g1' }], 2: [{ id: 'g1' }], 3: [{ id: 'g9' }] })[pid] || [],
    adapters: {},
    _fires: fires,
    ...over
  };
  return d;
}

const OPERATOR = { kind: 'operator', projectId: null, groupIds: [] };
const FIRER_IN_GROUP = { kind: 'project', projectId: 2, groupIds: ['g1'] };
const FIRER_OUT_OF_GROUP = { kind: 'project', projectId: 3, groupIds: ['g9'] };
const UNLISTED_IN_GROUP = { kind: 'project', projectId: 4, groupIds: ['g1'] };

/**
 * A fire request at session 10 / launch 100.
 * @param {object} caller - Resolved caller.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function req(caller, over = {}) {
  return { projectName: 'target', sessionId: 10, sequenceId: 100, expectedRevision: 1, caller, ...over };
}

describe('startup prompt service: text and firer validation', () => {
  it('accepts plain and multi-line text', () => {
    assert.equal(svc.textProblem('run tc start next'), null);
    assert.equal(svc.textProblem('line one\nline two'), null);
  });

  it('refuses empty, oversized and control-character text', () => {
    assert.match(svc.textProblem('   '), /empty/);
    assert.match(svc.textProblem(42), /string/);
    assert.match(svc.textProblem('x'.repeat(svc.MAX_PROMPT_CHARS + 1)), /at most/);
    assert.match(svc.textProblem('a\u001b[2Jb'), /control/);
    assert.match(svc.textProblem('a\rb'), /control/);
    assert.match(svc.textProblem('a\tb'), /control/);
  });

  it('refuses a malformed, repeated or unknown firer list', () => {
    const d = deps();
    assert.equal(svc.firersProblem([2, 3], d), null);
    assert.match(svc.firersProblem('2', d), /array/);
    assert.match(svc.firersProblem([2, 2], d), /repeat/);
    assert.match(svc.firersProblem([2, '3'], d), /positive integer/);
    assert.match(svc.firersProblem([99], d), /do not exist: 99/);
    assert.match(svc.firersProblem(Array.from({ length: svc.MAX_FIRERS + 1 }, (_, i) => i + 1), d), /at most/);
  });
});

describe('startup prompt service: read and update', () => {
  it('reads the current revision without any launch identifier', () => {
    const r = svc.read(deps());
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 1);
    assert.deepEqual(r.body.firerProjectIds, [2, 3]);
    assert.ok(!Object.keys(r.body).some((k) => /launch/i.test(k)), Object.keys(r.body).join(','));
  });

  it('writes a new revision under compare-and-set', () => {
    const d = deps();
    const r = svc.update({ text: 'new', firerProjectIds: [2], expectedRevision: 1 }, d);
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 2);
    assert.equal(r.body.updatedByKind, 'operator');
  });

  it('refuses a stale revision with 409 and the current revision', () => {
    const d = deps();
    svc.update({ text: 'new', firerProjectIds: [], expectedRevision: 1 }, d);
    const r = svc.update({ text: 'lost', firerProjectIds: [], expectedRevision: 1 }, d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STALE_STARTUP_PROMPT');
    assert.equal(r.body.currentRevision, 2);
  });

  it('refuses invalid input with 400 before writing', () => {
    const d = deps();
    assert.equal(svc.update({ text: 'x' }, d).body.code, 'STARTUP_PROMPT_INVALID');
    assert.equal(svc.update({ text: '', expectedRevision: 1 }, d).status, 400);
    assert.equal(svc.update({ text: 'ok', firerProjectIds: [99], expectedRevision: 1 }, d).status, 400);
    assert.equal(svc.update(null, d).status, 400);
    assert.equal(d.prompts.current().revision, 1, 'nothing was written');
  });

  it('treats an omitted firer list as none', () => {
    const r = svc.update({ text: 'new', expectedRevision: 1 }, deps());
    assert.deepEqual(r.body.firerProjectIds, []);
  });
});

describe('startup prompt service: who may fire', () => {
  const prompt = { firerProjectIds: [2, 3] };

  it('the operator may fire anywhere', () => {
    assert.equal(svc.canFire(OPERATOR, 1, prompt, deps()), true);
  });

  it('a listed firer may fire only into a project it shares a group with', () => {
    assert.equal(svc.canFire(FIRER_IN_GROUP, 1, prompt, deps()), true);
    assert.equal(svc.canFire(FIRER_OUT_OF_GROUP, 1, prompt, deps()), false);
  });

  it('sharing a group is not enough without being listed', () => {
    assert.equal(svc.canFire(UNLISTED_IN_GROUP, 1, prompt, deps()), false);
  });

  it('master, unbound, invalid and missing callers may not fire', () => {
    for (const kind of ['master', 'unbound', 'invalid']) {
      assert.equal(svc.canFire({ kind, projectId: 2, groupIds: ['g1'] }, 1, prompt, deps()), false, kind);
    }
    assert.equal(svc.canFire(null, 1, prompt, deps()), false);
  });
});

describe('startup prompt service: fire', () => {
  let d;
  beforeEach(() => { d = deps(); });

  it('an engine with no adapter gets a typed, audited unsupported refusal', () => {
    const r = svc.fire(req(OPERATOR), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STARTUP_CONTROL_UNSUPPORTED');
    assert.equal(r.body.engine, 'codex');
    assert.match(r.body.reason, /declares no startupControl/);
    assert.equal(d._fires.length, 1);
    assert.equal(d._fires[0].outcome, 'unsupported');
    assert.equal(d._fires[0].callerKind, 'operator');
    assert.equal(d._fires[0].promptRevision, 1);
    assert.equal(d._fires[0].promptDigest, 'd1');
  });

  it('a repeat fire of the same revision at the same launch returns the first record', () => {
    const first = svc.fire(req(OPERATOR), d);
    const again = svc.fire(req(FIRER_IN_GROUP), d);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.fire.id, first.body.fire.id);
    assert.equal(d._fires.length, 1);
  });

  it('records the agent caller and its project', () => {
    svc.fire(req(FIRER_IN_GROUP), d);
    assert.equal(d._fires[0].callerKind, 'project');
    assert.equal(d._fires[0].callerProjectId, 2);
  });

  it('refuses out-of-scope callers before looking at the session, and records nothing', () => {
    const r = svc.fire(req(UNLISTED_IN_GROUP), d);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FIRE_SCOPE_DENIED');
    assert.equal(d._fires.length, 0);
  });

  it('refuses an unknown project or a session that is not active in it', () => {
    assert.equal(svc.fire(req(OPERATOR, { projectName: 'nope' }), d).body.code, 'SESSION_NOT_FOUND');
    assert.equal(svc.fire(req(OPERATOR, { sessionId: 11 }), d).body.code, 'SESSION_NOT_FOUND');
    assert.equal(svc.fire(req(OPERATOR, { projectName: 'other' }), d).body.code, 'SESSION_NOT_FOUND');
    const ended = deps({ getSession: () => ({ id: 10, projectId: 1, engineId: 'codex', status: 'ended' }) });
    assert.equal(svc.fire(req(OPERATOR), ended).body.code, 'SESSION_NOT_FOUND');
  });

  it('refuses a launch that is not the session\'s current one, naming no launch id', () => {
    const r = svc.fire(req(OPERATOR, { sequenceId: 99 }), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'LAUNCH_NOT_CURRENT');
    assert.equal(d._fires.length, 0);
  });

  it('refuses a stale prompt revision', () => {
    const r = svc.fire(req(OPERATOR, { expectedRevision: 2 }), d);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'STALE_STARTUP_PROMPT');
    assert.equal(r.body.currentRevision, 1);
  });

  it('refuses non-integer targets', () => {
    assert.equal(svc.fire(req(OPERATOR, { sessionId: '10' }), d).status, 400);
  });

  it('with a registered adapter, refuses honestly and records and types nothing (dispatch is B2)', () => {
    const block = { adapter: 'fake', channel: 'c', readiness: 'r', receipt: 'x', blockers: 'b', verifiedVersions: ['1'] };
    block.evidence = Object.fromEntries(Object.keys(block).map((k) => [k, { verifiedOn: null, source: 's' }]));
    let touched = false;
    const supported = deps({
      getEngine: (id) => ({ id, capabilities: { startupControl: block } }),
      adapters: { fake: { fire: () => { touched = true; } } }
    });
    const r = svc.fire(req(OPERATOR), supported);
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'STARTUP_CONTROL_DISPATCH_UNAVAILABLE');
    assert.equal(supported._fires.length, 0);
    assert.equal(touched, false);
  });
});
