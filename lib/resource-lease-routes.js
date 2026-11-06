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
 * `handleAcquireLeaseWithPrimer` (`v5.67.0` FEED-FORWARD 01) is the same
 * call-site wiring for `lib/resource-leases.js#acquireLeaseWithPrimer`
 * (#2888, shipped in `v5.67.0` but never given a controller call site of
 * its own): added as a SEPARATE handler rather than changed in place over
 * `handleAcquireLease`, so a future route mount picks whichever shape it
 * wants and nothing already calling the plain handler (`#2856`'s own test
 * coverage, `test/fleet-settings-resource-routes.test.js`, out of this
 * car's file envelope) silently starts receiving two extra response fields
 * it never asked for.
 *
 * @module lib/resource-lease-routes
 */

const resourceLeases = require('./resource-leases');
const roleInstructionGuard = require('./role-instruction-guard');

/** @see module:lib/resource-leases.acquireLease */
function handleAcquireLease(input) {
  return resourceLeases.acquireLease(input);
}

/**
 * {@link handleAcquireLease}, with the resolved role's operating primer
 * attached to the new lease -- the controller call site
 * `lib/resource-leases.js#acquireLeaseWithPrimer` itself documents as not
 * yet wired to any real caller (`v5.67.0` FEED-FORWARD 01).
 * @see module:lib/resource-leases.acquireLeaseWithPrimer
 */
function handleAcquireLeaseWithPrimer(input, primerInput, primerDeps) {
  return resourceLeases.acquireLeaseWithPrimer(input, primerInput, primerDeps);
}

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
