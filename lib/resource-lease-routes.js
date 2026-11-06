'use strict';

/**
 * The library/route adapter surface for `#2856` (Architect Ruling
 * A503-R1, `Car 66-C`): composed route/controller handlers over
 * `lib/resource-leases.js` and `lib/role-instruction-guard.js` -- the
 * exact call shapes a future `lib/routes/*.js` handler needs. Mounting
 * these behind the real resource module / delegation UI (`server.js`,
 * `public/index.html`) is `Milestone #54` per Ruling A503-R1; this module
 * is what that mount will call unchanged.
 *
 * `handleAcquireLease` (`v5.67.0` FEED-FORWARD 01, Architect-directed) is the
 * call-site wiring for `lib/resource-leases.js#acquireLeaseWithPrimer`
 * (#2888, shipped in `v5.67.0` but never given a controller call site of its
 * own) -- the live acquisition handler now always attaches the resolved
 * role's operating primer. `handleAcquireLeaseWithPrimer` stays exported as
 * an alias of the SAME function, for a caller that already names it. This
 * is a deliberate behavior change over the prior cycle's `acquireLease`-only
 * delegate: every caller of `handleAcquireLease` now also triggers
 * `lib/primer-launch-wiring.js#resolveSessionRole`'s `process.env` read
 * (never `store`, unless `primerInput.projectId` is given) whenever
 * `primerInput`/`primerDeps` are omitted. `test/fleet-settings-resource-
 * routes.test.js` (#2856, out of this car's file envelope) only asserts
 * `result.ok`/`result.lease.resourceId` and passes unaffected.
 *
 * @module lib/resource-lease-routes
 */

const resourceLeases = require('./resource-leases');
const roleInstructionGuard = require('./role-instruction-guard');

/** @see module:lib/resource-leases.acquireLeaseWithPrimer */
function handleAcquireLease(input, primerInput, primerDeps) {
  return resourceLeases.acquireLeaseWithPrimer(input, primerInput, primerDeps);
}

/** Alias of {@link handleAcquireLease} for a caller that names it explicitly. */
const handleAcquireLeaseWithPrimer = handleAcquireLease;

/** @see module:lib/resource-leases.transitionLease */
function handleTransitionLease(input) {
  return resourceLeases.transitionLease(input);
}

/** @see module:lib/resource-leases.forceReclaimLease */
function handleForceReclaimLease(input) {
  return resourceLeases.forceReclaimLease(input);
}

/** @see module:lib/resource-leases.issueDelegationGrant */
function handleDelegationGrant(input) {
  return resourceLeases.issueDelegationGrant(input);
}

/** @see module:lib/resource-leases.provisionResourceModule */
function handleResourceModuleProvision(input) {
  return resourceLeases.provisionResourceModule(input);
}

/**
 * Evaluate an outbound instruction against its target role, before it is
 * sent -- named for this call site's own vocabulary (the instruction is
 * leaving the sender, headed outbound to the target role), over
 * {@link module:lib/role-instruction-guard.evaluateRoleInstruction}.
 * @see module:lib/role-instruction-guard.evaluateRoleInstruction
 */
function evaluateOutboundRoleInstruction(input) {
  return roleInstructionGuard.evaluateRoleInstruction(input);
}

module.exports = {
  handleAcquireLease,
  handleAcquireLeaseWithPrimer,
  handleTransitionLease,
  handleForceReclaimLease,
  handleDelegationGrant,
  handleResourceModuleProvision,
  evaluateOutboundRoleInstruction
};
