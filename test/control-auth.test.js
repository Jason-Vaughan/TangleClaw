'use strict';

// #1861: the operator proof tier. `_isOperator` accepts a forgeable dashboard
// header whenever the account gate stands down, so control mutations need to
// know HOW the operator was established: an account session in any gate state,
// or an install whose gate is deliberately open. Caddy fallback without a
// session, and an unreadable gate, are refused.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveControlCaller } = require('../lib/control-auth');
const { GATE_STATES, standsDown } = require('../lib/auth-gate');

/**
 * A request as server.js annotates it.
 * @param {string} gate - Gate state
 * @param {{session?: boolean, headers?: object}} [opts]
 * @returns {object}
 */
function req(gate, opts = {}) {
  return {
    headers: opts.headers || {},
    tcSession: opts.session ? { id: 's1', userId: 1 } : null,
    tcGateState: gate,
    tcGateActive: !standsDown(gate)
  };
}

const DASHBOARD = { 'x-tangleclaw-client': 'dashboard' };
const BROWSER = { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' };

describe('control-auth: operator proof tier (#1861)', () => {
  it('an account session is verified-session in every gate state, fallback included', () => {
    for (const gate of Object.values(GATE_STATES)) {
      const c = resolveControlCaller(req(gate, { session: true }));
      assert.equal(c.kind, 'operator', gate);
      assert.equal(c.actor.operatorProof, 'verified-session', gate);
    }
  });

  it('an open gate accepts the dashboard as ambient-open', () => {
    for (const headers of [DASHBOARD, BROWSER]) {
      const c = resolveControlCaller(req(GATE_STATES.OPEN, { headers }));
      assert.equal(c.kind, 'operator');
      assert.equal(c.actor.operatorProof, 'ambient-open');
    }
  });

  it('Caddy fallback without a session is unverifiable, however operator-shaped', () => {
    for (const headers of [DASHBOARD, BROWSER]) {
      assert.equal(resolveControlCaller(req(GATE_STATES.FALLBACK, { headers })).kind, 'operator-unverifiable');
    }
  });

  it('an unreadable gate makes an operator-shaped request unverifiable', () => {
    assert.equal(resolveControlCaller(req(GATE_STATES.UNREADABLE, { headers: DASHBOARD })).kind, 'operator-unverifiable');
  });

  it('armed, locked and account-required never make a forged dashboard header the operator', () => {
    for (const gate of [GATE_STATES.ARMED, GATE_STATES.LOCKED, GATE_STATES.ACCOUNT_REQUIRED]) {
      const c = resolveControlCaller(req(gate, { headers: DASHBOARD }));
      assert.notEqual(c.kind, 'operator', gate);
      assert.notEqual(c.kind, 'operator-unverifiable', gate);
      assert.equal(c.actor, undefined, gate);
    }
  });

  it('a request with no binding and no operator shape is unbound', () => {
    assert.equal(resolveControlCaller(req(GATE_STATES.ARMED)).kind, 'unbound');
    assert.equal(resolveControlCaller(req(GATE_STATES.ARMED, { headers: { authorization: 'Bearer service-token' } })).kind, 'unbound');
  });

  it('a verified launch becomes a project principal carrying its launch id', () => {
    const c = resolveControlCaller(req(GATE_STATES.ARMED, { headers: { 'x-tangleclaw-launch-id': 'L1', 'x-tangleclaw-project-id': '9' } }),
      () => ({ kind: 'project', projectId: 9, groupIds: [], reason: null }));
    assert.equal(c.kind, 'project');
    assert.deepEqual(c.actor, { principal: 'project:9', launchId: 'L1' });
  });
});
