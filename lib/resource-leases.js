'use strict';

/**
 * Runtime-enforced Resource Module leases and safe transitions (#2014,
 * Architect Ruling A2014), plus scoped delegated authority for project
 * Architects to provision and retire resource modules (#2071, Architect
 * Ruling A2071) — core engine, `v5.60.0` Car 60-A Slice 1, co-hosted in
 * one file per both rulings' own "Authorized Files" envelope.
 *
 * A pure state-machine library: every function takes the caller's
 * already-fetched resources/leases/grants as plain data and returns a
 * computed next state or refusal — nothing here reads a database, holds a
 * timer, or touches a route. Wiring this into `server.js`/`lib/routes/*.js`
 * (which would resolve the REAL caller identity and persist the REAL
 * state) is Slice 2, deliberately deferred so Car 60-A stays 100%
 * file-disjoint from this wave's other `v5.60.0` cars. This module trusts
 * its caller to have already resolved `caller.principal`/`caller.id`
 * honestly — the same trust-boundary split `lib/bridge-confirmation.js` and
 * `lib/session-rules-bulk.js` document for their own callers.
 *
 * One deliberate exception (#2888, #2070 Slice 3): {@link
 * acquireLeaseWithPrimer} composes the still-pure {@link acquireLease} with
 * `lib/primer-launch-wiring.js#attachOperatingPrimerToLease`, which does
 * read `store`/`process.env`. Every other function in this file stays
 * exactly as pure as this docstring says.
 *
 * @module lib/resource-leases
 */

const primerLaunchWiring = require('./primer-launch-wiring');

/** Every state a lease passes through. A lease is single-use through this
 *  path: `active` → `draining` → `released`, or `active`/`draining` →
 *  `expired` on TTL — never back. */
const LEASE_STATES = Object.freeze(['active', 'draining', 'released', 'expired']);

/** The two ways a lease may hold a resource. */
const LEASE_MODES = Object.freeze(['exclusive', 'shared']);

/** Every state a resource module passes through — a scoping decision
 *  (#2014's own ruling names lease states, not resource ones): `active`
 *  while provisioned and usable, `retired` once retirement completes. No
 *  intermediate "retiring" state is modeled here because
 *  {@link retireResourceModule} is itself the fail-closed gate (it refuses
 *  outright, synchronously, rather than staging an async drain of its
 *  own) — the resource's OWN leases are what drain, not the resource.
 * @type {ReadonlyArray<string>}
 */
const RESOURCE_STATES = Object.freeze(['active', 'retired']);

/** Valid lease state transitions. Empty array means terminal. */
const LEASE_TRANSITIONS = Object.freeze({ active: ['draining'], draining: ['released'], released: [], expired: [] });

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/** @returns {string} */
function _now() {
  return new Date().toISOString();
}

/**
 * Apply a lease's lazy expiry transition against `now`, without mutating
 * the input. A lease already `released`/`expired` is unaffected — expiry
 * only ever fires from `active`/`draining`.
 * @param {object} lease
 * @param {string} now - ISO instant
 * @returns {object} The lease, expired if its TTL has passed
 */
function _evaluateExpiry(lease, now) {
  if ((lease.state === 'active' || lease.state === 'draining') && lease.expiresAt <= now) {
    return { ...lease, state: 'expired' };
  }
  return lease;
}

/**
 * Whether a lease currently holds its resource (not released, not expired,
 * not past its own TTL even if not yet lazily transitioned).
 * @param {object} lease
 * @param {string} now
 * @returns {boolean}
 */
function _isLive(lease, now) {
  return lease.state !== 'released' && lease.state !== 'expired' && lease.expiresAt > now;
}

/**
 * Acquire a new lease on a resource (#2014), checking it against every
 * other live lease already held on that same resource: an `exclusive`
 * request refuses if ANY live lease exists; a `shared` request refuses
 * only if a live `exclusive` lease exists (shared leases may coexist with
 * each other).
 * @param {object} input
 * @param {string} input.resourceId
 * @param {string} input.holderSessionId
 * @param {string} input.holderProjectId
 * @param {string} input.mode - `'exclusive'` or `'shared'`
 * @param {number} input.ttlMs - How long the lease stays live before expiry
 * @param {object[]} input.existingLeases - Every lease this caller already
 *   knows about, for ANY resource (live or not — required explicitly, `[]`
 *   for a known-empty snapshot, so a caller can never silently skip the
 *   conflict check by omitting it). Only those matching `resourceId` and
 *   still live (after this call's own lazy expiry evaluation) are checked
 *   for conflicts; ALL of them matching `resourceId`, live or not, are
 *   checked to derive the next monotonic epoch (below).
 * @returns {{ok: true, lease: object}|{ok: false, code: string, message: string}}
 */
function acquireLease(input) {
  if (!input || typeof input !== 'object') return _refuse('RESOURCE_LEASE_INVALID', 'input must be an object.');
  for (const field of ['resourceId', 'holderSessionId', 'holderProjectId']) {
    if (typeof input[field] !== 'string' || !input[field]) {
      return _refuse('RESOURCE_LEASE_INVALID', `input.${field} must be a non-empty string.`);
    }
  }
  if (!LEASE_MODES.includes(input.mode)) {
    return _refuse('RESOURCE_LEASE_INVALID', `input.mode must be one of ${LEASE_MODES.join(', ')}.`);
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.ttlMs must be a positive number.');
  }
  if (!Array.isArray(input.existingLeases)) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.existingLeases must be an array (use [] for a known-empty snapshot).');
  }
  const now = input.now || _now();
  const onResource = input.existingLeases.filter((l) => l.resourceId === input.resourceId);
  const liveOnResource = onResource.map((l) => _evaluateExpiry(l, now)).filter((l) => _isLive(l, now));

  if (input.mode === 'exclusive' && liveOnResource.length > 0) {
    return _refuse('RESOURCE_LEASE_CONFLICT',
      `Resource "${input.resourceId}" already has ${liveOnResource.length} live lease(s); cannot acquire exclusive.`);
  }
  if (input.mode === 'shared' && liveOnResource.some((l) => l.mode === 'exclusive')) {
    return _refuse('RESOURCE_LEASE_CONFLICT',
      `Resource "${input.resourceId}" has a live exclusive lease; cannot acquire shared.`);
  }

  // The fencing token must stay monotonic across the resource's WHOLE
  // history, not just this caller's current holder -- resetting to 1 on
  // every reacquisition would let a stale holder's old epoch collide with
  // a later holder's epoch of the same number (A2014 Round 2 / PRR-B).
  // Derived from every known lease on this resource, live or not, never
  // just the live ones the conflict check above uses.
  const highestKnownEpoch = onResource.reduce((max, l) => Math.max(max, typeof l.epoch === 'number' ? l.epoch : 0), 0);

  return {
    ok: true,
    lease: {
      leaseId: `lease_${input.resourceId}_${input.holderSessionId}_${now}`,
      resourceId: input.resourceId,
      holderSessionId: input.holderSessionId,
      holderProjectId: input.holderProjectId,
      mode: input.mode,
      epoch: highestKnownEpoch + 1,
      expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString(),
      state: 'active'
    }
  };
}

/**
 * {@link acquireLease}, with the resolved role's operating primer attached
 * to the new lease as its own companion field (#2888, #2070 Slice 3:
 * `lib/primer-launch-wiring.js#attachOperatingPrimerToLease`, wired into a
 * real call path for the first time here). `acquireLease` itself stays
 * untouched and pure (no role resolution, no `store`/`process.env` read);
 * this is a separate, explicitly impure composition for whichever future
 * route layer wants the primer-attached shape in one call rather than two.
 * Never attaches a primer to a refusal -- only a successful lease gets one.
 *
 * `primerInput.projectId`, when the caller wants role resolution to reach
 * this project's own `coordinator_roles` row, must be `store.projects`' real
 * NUMERIC id -- deliberately never defaulted from `input.holderProjectId`,
 * which this module's own tests use as a bare opaque string (`'p1'`), not a
 * real project id; conflating the two would feed `resolveSessionRole` a
 * value that looks plausible but resolves nothing, or resolves the wrong
 * project's role entirely for a caller that happens to reuse a numeric-
 * looking holder id. With no `projectId` given, `resolveSessionRole` still
 * degrades correctly through its own remaining precedence (the env var,
 * then `'worker'`) -- so omitting it is honest, not broken.
 * @param {object} input - As {@link acquireLease}
 * @param {object} [primerInput] - As `primer-launch-wiring.js#resolveSessionRole`'s own `input`
 * @param {{env?: object}} [primerDeps] - As `resolveSessionRole`'s own `deps`
 * @returns {{ok: true, lease: object}|{ok: false, code: string, message: string}}
 */
function acquireLeaseWithPrimer(input, primerInput, primerDeps) {
  const acquired = acquireLease(input);
  if (!acquired.ok) return acquired;
  return { ok: true, lease: primerLaunchWiring.attachOperatingPrimerToLease(acquired.lease, primerInput, primerDeps) };
}

/**
 * Transition a lease toward release, fenced on the epoch the caller last
 * observed (#2014's "monotonic lease epochs/fencing tokens"): a caller
 * presenting a stale epoch (one that is no longer the lease's current
 * value — this lease already moved since the caller last read it) is
 * refused `RESOURCE_LEASE_FENCED` rather than allowed to act on
 * out-of-date knowledge. Checked expiry-first: an expired lease answers
 * `RESOURCE_LEASE_EXPIRED` even with a correct epoch, since there is
 * nothing left to fence.
 * @param {object} input
 * @param {object} input.lease - The lease, as the caller last observed it
 * @param {string} input.toState - Must be a transition {@link LEASE_TRANSITIONS}
 *   allows from `lease.state`
 * @param {number} input.presentedEpoch - Must equal `lease.epoch`
 * @returns {{ok: true, lease: object}|{ok: false, code: string, message: string, lease?: object}}
 */
function transitionLease(input) {
  if (!input || !input.lease || typeof input.lease !== 'object') {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.lease is required.');
  }
  const now = input.now || _now();
  const evaluated = _evaluateExpiry(input.lease, now);
  if (evaluated.state === 'expired') {
    return _refuse('RESOURCE_LEASE_EXPIRED',
      `Lease "${input.lease.leaseId}" expired at ${input.lease.expiresAt}.`, { lease: evaluated });
  }
  if (input.presentedEpoch !== input.lease.epoch) {
    return _refuse('RESOURCE_LEASE_FENCED',
      `Presented epoch ${input.presentedEpoch} does not match this lease's current epoch ${input.lease.epoch}; this holder is stale.`,
      { lease: evaluated });
  }
  const allowed = LEASE_TRANSITIONS[input.lease.state] || [];
  if (!allowed.includes(input.toState)) {
    return _refuse('RESOURCE_LEASE_CONFLICT',
      `Cannot transition a lease from "${input.lease.state}" to "${input.toState}".`, { lease: evaluated });
  }
  return { ok: true, lease: { ...input.lease, state: input.toState, epoch: input.lease.epoch + 1 } };
}

/**
 * Force-release a lease on the operator's own authority — #2014's "explicit
 * expiry/operator force-reclaim with audit trail", the one path that does
 * NOT require the lease's current holder to cooperate (no epoch is
 * checked: the operator's standing authority supersedes any holder's
 * fencing token by design). Never silent: always returns an audit record
 * alongside the released lease.
 * @param {object} input
 * @param {object} input.lease
 * @param {string} input.operatorId
 * @param {string} [input.reason]
 * @returns {{ok: true, lease: object, audit: object}|{ok: false, code: string, message: string}}
 */
function forceReclaimLease(input) {
  if (!input || !input.lease || typeof input.lease !== 'object') {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.lease is required.');
  }
  if (typeof input.operatorId !== 'string' || !input.operatorId) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.operatorId is required.');
  }
  const now = input.now || _now();
  return {
    ok: true,
    lease: { ...input.lease, state: 'released', epoch: input.lease.epoch + 1 },
    audit: {
      leaseId: input.lease.leaseId, action: 'force-reclaim', operatorId: input.operatorId,
      reason: typeof input.reason === 'string' ? input.reason : null, at: now
    }
  };
}

/**
 * Validate an {@link issueDelegationGrant} or authorization input's caller
 * shape.
 * @param {object} caller
 * @returns {boolean}
 */
function _isCaller(caller) {
  return Boolean(caller && typeof caller === 'object' && typeof caller.id === 'string' && caller.id);
}

/**
 * Issue a scoped delegation grant authorizing a project's Architect to
 * provision and retire resource modules within that project's boundary
 * (#2071). Operator-only — the one action in this module that never
 * accepts a delegated caller, since a grant is the thing that CREATES
 * delegation.
 * @param {object} input
 * @param {object} input.caller - Must carry `principal: 'operator'`
 * @param {string} input.projectId
 * @param {string} input.architectPrincipal - The session/identity being granted authority
 * @param {string[]} input.allowedKinds - Resource `kind`s this grant covers
 * @param {number} input.maxInstances
 * @param {number} input.ttlMs
 * @returns {{ok: true, grant: object}|{ok: false, code: string, message: string}}
 */
function issueDelegationGrant(input) {
  if (!input || !_isCaller(input.caller) || input.caller.principal !== 'operator') {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', 'Only the operator may issue a delegation grant.');
  }
  if (typeof input.projectId !== 'string' || !input.projectId) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.projectId is required.');
  }
  if (typeof input.architectPrincipal !== 'string' || !input.architectPrincipal) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.architectPrincipal is required.');
  }
  if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0
    || !input.allowedKinds.every((k) => typeof k === 'string' && k)) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.allowedKinds must be a non-empty array of strings.');
  }
  if (!Number.isFinite(input.maxInstances) || input.maxInstances <= 0) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.maxInstances must be a positive number.');
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.ttlMs must be a positive number.');
  }
  const now = input.now || _now();
  return {
    ok: true,
    grant: {
      grantId: `grant_${input.projectId}_${input.architectPrincipal}_${now}`,
      projectId: input.projectId,
      architectPrincipal: input.architectPrincipal,
      allowedKinds: [...input.allowedKinds],
      maxInstances: input.maxInstances,
      expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString(),
      revoked: false
    }
  };
}

/**
 * Revoke a delegation grant. Operator-only, same reasoning as issuing one.
 * @param {object} input
 * @param {object} input.caller
 * @param {object} input.grant
 * @returns {{ok: true, grant: object}|{ok: false, code: string, message: string}}
 */
function revokeDelegationGrant(input) {
  if (!input || !_isCaller(input.caller) || input.caller.principal !== 'operator') {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', 'Only the operator may revoke a delegation grant.');
  }
  if (!input.grant || typeof input.grant !== 'object') {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.grant is required.');
  }
  return { ok: true, grant: { ...input.grant, revoked: true } };
}

/**
 * Whether `caller` is authorized to provision or retire a resource module
 * of `kind` in `projectId` — the operator always, unconditionally; anyone
 * else only with a live, unexpired, unrevoked grant naming that exact
 * project, that exact kind, and that exact caller (#2071's "Verify that a
 * non-operator caller holds a live, unexpired Architect delegation grant
 * matching projectId, kind, and quota").
 * @param {object} caller
 * @param {object|null} grant
 * @param {string} projectId
 * @param {string} kind
 * @param {string} now
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
function _authorizeDelegatedAction(caller, grant, projectId, kind, now) {
  if (!_isCaller(caller)) return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', 'A caller identity is required.');
  if (caller.principal === 'operator') return { ok: true };
  if (!grant || typeof grant !== 'object' || grant.revoked) {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', `Caller "${caller.id}" holds no live delegation grant.`);
  }
  if (grant.expiresAt <= now) {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', `Caller "${caller.id}"'s delegation grant expired at ${grant.expiresAt}.`);
  }
  if (grant.architectPrincipal !== caller.id) {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', `This grant does not belong to caller "${caller.id}".`);
  }
  if (grant.projectId !== projectId) {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', `This grant does not cover project "${projectId}".`);
  }
  if (!grant.allowedKinds.includes(kind)) {
    return _refuse('RESOURCE_DELEGATION_UNAUTHORIZED', `This grant does not cover resource kind "${kind}".`);
  }
  return { ok: true };
}

/**
 * Provision a new resource module under either operator authority or a
 * matching delegation grant, enforcing the grant's quota (#2071).
 * @param {object} input
 * @param {object} input.caller
 * @param {object|null} [input.grant] - Required unless `caller` is the operator
 * @param {string} input.resourceId
 * @param {string} input.kind
 * @param {string} input.projectId
 * @param {number} input.capacity
 * @param {number} [input.currentInstanceCount] - How many instances of this
 *   kind the grant's holder has already provisioned, for the quota check.
 *   Required to be a valid non-negative integer for a non-operator caller
 *   — omitted/invalid fails closed rather than defaulting to `0`, which
 *   would silently waive the quota check entirely (ignored outright for an
 *   operator caller — the operator has no quota, so it is never read)
 * @returns {{ok: true, resource: object}|{ok: false, code: string, message: string}}
 */
function provisionResourceModule(input) {
  if (!input || typeof input.resourceId !== 'string' || !input.resourceId
    || typeof input.kind !== 'string' || !input.kind
    || typeof input.projectId !== 'string' || !input.projectId
    || !Number.isFinite(input.capacity) || input.capacity <= 0) {
    return _refuse('RESOURCE_LEASE_INVALID', 'resourceId, kind, projectId and a positive capacity are required.');
  }
  const now = input.now || _now();
  const authz = _authorizeDelegatedAction(input.caller, input.grant, input.projectId, input.kind, now);
  if (!authz.ok) return authz;
  if (input.caller.principal !== 'operator') {
    if (!Number.isInteger(input.currentInstanceCount) || input.currentInstanceCount < 0) {
      return _refuse('RESOURCE_LEASE_INVALID', 'input.currentInstanceCount must be a non-negative integer for a non-operator caller.');
    }
    const count = input.currentInstanceCount;
    if (count >= input.grant.maxInstances) {
      return _refuse('RESOURCE_QUOTA_EXCEEDED',
        `Grant for caller "${input.caller.id}" allows at most ${input.grant.maxInstances} instance(s) of kind "${input.kind}"; ${count} already provisioned.`);
    }
  }
  return { ok: true, resource: { resourceId: input.resourceId, kind: input.kind, capacity: input.capacity, state: 'active' } };
}

/**
 * Retire a resource module, refusing if it still carries an active,
 * un-drained lease (#2071's "Refuse retirement... unless safe drain/
 * release has completed").
 * @param {object} input
 * @param {object} input.caller
 * @param {object|null} [input.grant]
 * @param {object} input.resource - `{resourceId, kind, capacity, state}`
 * @param {string} input.projectId
 * @param {object[]} input.activeLeases - Every lease the caller knows
 *   about, for ANY resource (required explicitly, `[]` for a known-empty
 *   snapshot, so a caller can never silently skip the busy check by
 *   omitting it) — only those on `resource.resourceId` and still live are
 *   checked
 * @returns {{ok: true, resource: object}|{ok: false, code: string, message: string}}
 */
function retireResourceModule(input) {
  if (!input || !input.resource || typeof input.resource !== 'object'
    || typeof input.resource.resourceId !== 'string' || !input.resource.resourceId) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.resource must carry a resourceId.');
  }
  if (typeof input.projectId !== 'string' || !input.projectId) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.projectId is required.');
  }
  if (!Array.isArray(input.activeLeases)) {
    return _refuse('RESOURCE_LEASE_INVALID', 'input.activeLeases must be an array (use [] for a known-empty snapshot).');
  }
  const now = input.now || _now();
  const authz = _authorizeDelegatedAction(input.caller, input.grant, input.projectId, input.resource.kind, now);
  if (!authz.ok) return authz;
  const busy = input.activeLeases
    .map((l) => _evaluateExpiry(l, now))
    .some((l) => l.resourceId === input.resource.resourceId && _isLive(l, now));
  if (busy) {
    return _refuse('RESOURCE_BUSY_ACTIVE_LEASE',
      `Resource "${input.resource.resourceId}" still has a live lease; drain or release it before retiring.`);
  }
  return { ok: true, resource: { ...input.resource, state: 'retired' } };
}

module.exports = {
  LEASE_STATES,
  LEASE_MODES,
  RESOURCE_STATES,
  LEASE_TRANSITIONS,
  acquireLease,
  acquireLeaseWithPrimer,
  transitionLease,
  forceReclaimLease,
  issueDelegationGrant,
  revokeDelegationGrant,
  provisionResourceModule,
  retireResourceModule
};
