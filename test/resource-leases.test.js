'use strict';

// #2014, #2071 (Architect Rulings A2014, A2071): runtime-enforced Resource
// Module leases and safe transitions, plus scoped delegated authority for
// project Architects to provision/retire resource modules. Both co-hosted
// in lib/resource-leases.js per the rulings' own shared file envelope.
//
// Pure state-machine library: no store, no route, no network. Every
// assertion drives the real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const rl = require('../lib/resource-leases');

const NOW = '2026-10-27T08:00:00.000Z';
const MINUTE = 60 * 1000;
/** @param {number} ms @returns {string} */
const at = (ms) => new Date(Date.parse(NOW) + ms).toISOString();

describe('resource-leases: exported vocabulary', () => {
  it('exposes its own state/mode vocabulary', () => {
    assert.deepEqual(rl.LEASE_STATES, ['active', 'draining', 'released', 'expired']);
    assert.deepEqual(rl.LEASE_MODES, ['exclusive', 'shared']);
    assert.deepEqual(rl.RESOURCE_STATES, ['active', 'retired']);
    assert.deepEqual(rl.LEASE_TRANSITIONS, { active: ['draining'], draining: ['released'], released: [], expired: [] });
  });
});

describe('resource-leases: acquireLease (#2014)', () => {
  it('refuses missing required fields', () => {
    assert.equal(rl.acquireLease({}).code, 'RESOURCE_LEASE_INVALID');
    assert.equal(rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'bogus', ttlMs: 1000 }).code, 'RESOURCE_LEASE_INVALID');
    assert.equal(rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 0 }).code, 'RESOURCE_LEASE_INVALID');
  });

  it('grants a fresh exclusive lease on an empty resource, starting at epoch 1 and state active', () => {
    const r = rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.lease.state, 'active');
    assert.equal(r.lease.epoch, 1);
    assert.equal(r.lease.expiresAt, at(10 * MINUTE));
  });

  it('refuses a second exclusive acquire while one is already live', () => {
    const first = rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE, now: NOW });
    const second = rl.acquireLease({
      resourceId: 'r1', holderSessionId: 's2', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE,
      existingLeases: [first.lease], now: NOW
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'RESOURCE_LEASE_CONFLICT');
  });

  it('refuses a shared acquire while a live exclusive lease exists', () => {
    const excl = rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE, now: NOW });
    const shared = rl.acquireLease({
      resourceId: 'r1', holderSessionId: 's2', holderProjectId: 'p1', mode: 'shared', ttlMs: 10 * MINUTE,
      existingLeases: [excl.lease], now: NOW
    });
    assert.equal(shared.ok, false);
    assert.equal(shared.code, 'RESOURCE_LEASE_CONFLICT');
  });

  it('allows two shared leases to coexist', () => {
    const first = rl.acquireLease({ resourceId: 'r1', holderSessionId: 's1', holderProjectId: 'p1', mode: 'shared', ttlMs: 10 * MINUTE, now: NOW });
    const second = rl.acquireLease({
      resourceId: 'r1', holderSessionId: 's2', holderProjectId: 'p1', mode: 'shared', ttlMs: 10 * MINUTE,
      existingLeases: [first.lease], now: NOW
    });
    assert.equal(second.ok, true);
  });

  it('an exclusive acquire is allowed once every existing lease on that resource has expired', () => {
    const stale = { resourceId: 'r1', leaseId: 'old', mode: 'exclusive', epoch: 1, state: 'active', expiresAt: at(-MINUTE) };
    const r = rl.acquireLease({
      resourceId: 'r1', holderSessionId: 's2', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE,
      existingLeases: [stale], now: NOW
    });
    assert.equal(r.ok, true);
  });

  it('a conflict check on resource A never sees a live lease on resource B', () => {
    const onB = rl.acquireLease({ resourceId: 'r-B', holderSessionId: 's1', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE, now: NOW });
    const onA = rl.acquireLease({
      resourceId: 'r-A', holderSessionId: 's2', holderProjectId: 'p1', mode: 'exclusive', ttlMs: 10 * MINUTE,
      existingLeases: [onB.lease], now: NOW
    });
    assert.equal(onA.ok, true);
  });
});

describe('resource-leases: transitionLease (#2014)', () => {
  const lease = { leaseId: 'l1', resourceId: 'r1', mode: 'exclusive', epoch: 3, state: 'active', expiresAt: at(10 * MINUTE) };

  it('refuses a transition the state machine does not allow', () => {
    const r = rl.transitionLease({ lease, toState: 'released', presentedEpoch: 3, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_LEASE_CONFLICT');
  });

  it('allows active -> draining with the matching epoch, incrementing it', () => {
    const r = rl.transitionLease({ lease, toState: 'draining', presentedEpoch: 3, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.lease.state, 'draining');
    assert.equal(r.lease.epoch, 4);
  });

  it('fences a stale epoch', () => {
    const r = rl.transitionLease({ lease, toState: 'draining', presentedEpoch: 2, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_LEASE_FENCED');
  });

  it('refuses any transition on an expired lease, even with the correct epoch', () => {
    const expired = { ...lease, expiresAt: at(-MINUTE) };
    const r = rl.transitionLease({ lease: expired, toState: 'draining', presentedEpoch: 3, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_LEASE_EXPIRED');
  });

  it('draining -> released is allowed; released has no further transitions', () => {
    const draining = { ...lease, state: 'draining' };
    const released = rl.transitionLease({ lease: draining, toState: 'released', presentedEpoch: 3, now: NOW });
    assert.equal(released.ok, true);
    assert.equal(released.lease.state, 'released');
    const again = rl.transitionLease({ lease: released.lease, toState: 'draining', presentedEpoch: 4, now: NOW });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'RESOURCE_LEASE_CONFLICT');
  });
});

describe('resource-leases: forceReclaimLease (#2014)', () => {
  it('requires an operatorId', () => {
    const lease = { leaseId: 'l1', resourceId: 'r1', epoch: 1, state: 'active' };
    assert.equal(rl.forceReclaimLease({ lease }).code, 'RESOURCE_LEASE_INVALID');
  });

  it('releases the lease and returns an audit record, ignoring the epoch entirely', () => {
    const lease = { leaseId: 'l1', resourceId: 'r1', epoch: 7, state: 'active' };
    const r = rl.forceReclaimLease({ lease, operatorId: 'op-1', reason: 'stuck session' });
    assert.equal(r.ok, true);
    assert.equal(r.lease.state, 'released');
    assert.equal(r.lease.epoch, 8);
    assert.equal(r.audit.operatorId, 'op-1');
    assert.equal(r.audit.action, 'force-reclaim');
    assert.equal(r.audit.reason, 'stuck session');
    assert.equal(r.audit.leaseId, 'l1');
  });
});

describe('resource-leases: issueDelegationGrant / revokeDelegationGrant (#2071)', () => {
  it('refuses a non-operator caller', () => {
    const r = rl.issueDelegationGrant({
      caller: { id: 'arc-1' }, projectId: 'p1', architectPrincipal: 'arc-1',
      allowedKinds: ['gpu'], maxInstances: 2, ttlMs: MINUTE
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('issues a grant for the operator', () => {
    const r = rl.issueDelegationGrant({
      caller: { principal: 'operator', id: 'op-1' }, projectId: 'p1', architectPrincipal: 'arc-1',
      allowedKinds: ['gpu'], maxInstances: 2, ttlMs: MINUTE, now: NOW
    });
    assert.equal(r.ok, true);
    assert.equal(r.grant.projectId, 'p1');
    assert.equal(r.grant.revoked, false);
    assert.equal(r.grant.expiresAt, at(MINUTE));
  });

  it('refuses revocation by a non-operator', () => {
    const r = rl.revokeDelegationGrant({ caller: { id: 'arc-1' }, grant: { grantId: 'g1' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('revokes a grant for the operator', () => {
    const r = rl.revokeDelegationGrant({ caller: { principal: 'operator', id: 'op-1' }, grant: { grantId: 'g1', revoked: false } });
    assert.equal(r.ok, true);
    assert.equal(r.grant.revoked, true);
  });
});

describe('resource-leases: provisionResourceModule (#2071)', () => {
  const grant = {
    grantId: 'g1', projectId: 'p1', architectPrincipal: 'arc-1', allowedKinds: ['gpu'], maxInstances: 2,
    expiresAt: at(10 * MINUTE), revoked: false
  };

  it('allows the operator unconditionally, with no grant', () => {
    const r = rl.provisionResourceModule({
      caller: { principal: 'operator', id: 'op-1' }, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.ok, true);
    assert.equal(r.resource.state, 'active');
  });

  it('refuses a caller with no grant at all', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('refuses a revoked grant', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant: { ...grant, revoked: true }, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('refuses an expired grant', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant: { ...grant, expiresAt: at(-MINUTE) }, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('refuses a grant belonging to a different caller', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'someone-else' }, grant, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('refuses a grant for a different project', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p-other', capacity: 4, now: NOW
    });
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('refuses a grant that does not cover the requested kind', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant, resourceId: 'cpu-1', kind: 'cpu', projectId: 'p1', capacity: 4, now: NOW
    });
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('allows a matching, live grant under its quota', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant, resourceId: 'gpu-1', kind: 'gpu', projectId: 'p1', capacity: 4, currentInstanceCount: 1, now: NOW
    });
    assert.equal(r.ok, true);
  });

  it('refuses once the grant quota is exhausted', () => {
    const r = rl.provisionResourceModule({
      caller: { id: 'arc-1' }, grant, resourceId: 'gpu-2', kind: 'gpu', projectId: 'p1', capacity: 4, currentInstanceCount: 2, now: NOW
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_QUOTA_EXCEEDED');
  });

  it('the operator is never quota-checked, even past what a grant would allow', () => {
    const r = rl.provisionResourceModule({
      caller: { principal: 'operator', id: 'op-1' }, resourceId: 'gpu-99', kind: 'gpu', projectId: 'p1', capacity: 4,
      currentInstanceCount: 999, now: NOW
    });
    assert.equal(r.ok, true);
  });
});

describe('resource-leases: retireResourceModule (#2071)', () => {
  const grant = {
    grantId: 'g1', projectId: 'p1', architectPrincipal: 'arc-1', allowedKinds: ['gpu'], maxInstances: 2,
    expiresAt: at(10 * MINUTE), revoked: false
  };
  const resource = { resourceId: 'gpu-1', kind: 'gpu', capacity: 4, state: 'active' };

  it('refuses retirement while a live lease exists on the resource', () => {
    const lease = { leaseId: 'l1', resourceId: 'gpu-1', mode: 'exclusive', epoch: 1, state: 'active', expiresAt: at(10 * MINUTE) };
    const r = rl.retireResourceModule({ caller: { id: 'arc-1' }, grant, resource, projectId: 'p1', activeLeases: [lease], now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_BUSY_ACTIVE_LEASE');
  });

  it('allows retirement once the only lease on the resource is released', () => {
    const lease = { leaseId: 'l1', resourceId: 'gpu-1', mode: 'exclusive', epoch: 2, state: 'released', expiresAt: at(10 * MINUTE) };
    const r = rl.retireResourceModule({ caller: { id: 'arc-1' }, grant, resource, projectId: 'p1', activeLeases: [lease], now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.resource.state, 'retired');
  });

  it('allows retirement once the only lease has expired', () => {
    const lease = { leaseId: 'l1', resourceId: 'gpu-1', mode: 'exclusive', epoch: 1, state: 'active', expiresAt: at(-MINUTE) };
    const r = rl.retireResourceModule({ caller: { id: 'arc-1' }, grant, resource, projectId: 'p1', activeLeases: [lease], now: NOW });
    assert.equal(r.ok, true);
  });

  it('a busy check on resource A never sees a lease on resource B', () => {
    const leaseOnB = { leaseId: 'l1', resourceId: 'gpu-OTHER', mode: 'exclusive', epoch: 1, state: 'active', expiresAt: at(10 * MINUTE) };
    const r = rl.retireResourceModule({ caller: { id: 'arc-1' }, grant, resource, projectId: 'p1', activeLeases: [leaseOnB], now: NOW });
    assert.equal(r.ok, true);
  });

  it('refuses retirement for an unauthorized caller before even checking leases', () => {
    const r = rl.retireResourceModule({ caller: { id: 'unauthorized' }, resource, projectId: 'p1', activeLeases: [], now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('the operator may always retire, with no grant', () => {
    const r = rl.retireResourceModule({ caller: { principal: 'operator', id: 'op-1' }, resource, projectId: 'p1', activeLeases: [], now: NOW });
    assert.equal(r.ok, true);
  });
});
