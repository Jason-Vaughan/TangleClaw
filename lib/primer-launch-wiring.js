'use strict';

/**
 * Operating-primer launch wiring (#2844, #2070 Slice 2).
 *
 * #2070 Slice 1 shipped `lib/operating-primer.js#buildOperatingPrimer(role)`:
 * pure, tested (`test/tc-primer.test.js`), and called by nothing in
 * production -- only its own test imports it. This module is the missing
 * caller, closing the gap PRR-B's I-Gate review on PR #2841 flagged.
 *
 * Wiring it into the REAL launch/prime path (`lib/sessions.js`'s
 * `_collectPrimeSections`, or the lease-generation path) is Slice 3 --
 * `lib/sessions.js` is a shared hot file, out of this envelope, tracked in
 * #2888. This module builds the two things that path will call once it's
 * wired: the role-resolution decision #2844 itself names as needing to be
 * made, and the lease-companion attachment the issue's "Scope" section asks
 * for.
 *
 * ## The role-resolution decision (#2844's own open architectural question)
 *
 * #2844 states plainly that no first-class role-determination mechanism
 * exists anywhere in this codebase: `coordinator_roles` records which
 * PROJECT the operator appointed Architect/PM over, fleet-wide -- never
 * which of worker/reviewer/coordinator/master a given LAUNCHING SESSION
 * plays. {@link resolveSessionRole} is this module's answer, deterministic
 * in a fixed order (see its own doc): an explicit caller-supplied hint,
 * then the `TANGLECLAW_SESSION_ROLE` env convention (one of the three
 * candidates #2844 itself names: "a new launch-sequence field? An
 * engine/env convention? An explicit `tc start` flag?"), then the
 * project's own `coordinator_roles` row (folding `architect`/
 * `project-manager` to `coordinator`), defaulting to `worker` -- the
 * common case, an ordinary Builder lane with no special appointment.
 * `reviewer` has no existing signal anywhere in this codebase either (the
 * issue's own finding) and resolves only through the first two steps.
 *
 * This is a real design decision, made here rather than left unmade, and
 * open to correction: a session wiring this into the real launch path
 * (Slice 3) can swap the precedence or add a fourth signal without
 * touching {@link buildOperatingPrimer} or the rest of this module.
 *
 * @module lib/primer-launch-wiring
 */

const operatingPrimer = require('./operating-primer');
const store = require('./store');

/** The four roles `lib/operating-primer.js#buildOperatingPrimer` knows -- the real set {@link resolveSessionRole} must only ever return. */
const ROLES = Object.freeze(['worker', 'reviewer', 'coordinator', 'master']);

/** The env var a launching process may set to declare its own role explicitly (#2844's "engine/env convention" candidate). */
const ROLE_ENV_VAR = 'TANGLECLAW_SESSION_ROLE';

/** `coordinator_roles.role` values, each folding to this module's own `'coordinator'`. */
const COORDINATOR_ROLE_VALUES = Object.freeze(['architect', 'project-manager']);

/**
 * Resolve which of the four operating-primer roles a launching session
 * plays, in this fixed precedence:
 *
 *   1. `input.isMaster` -- the Project Master is a singular, specially-keyed
 *      identity (`lib/master.js`), never a `store.projects` row with an
 *      appointed coordinator role, so it is never inferred, only declared.
 *   2. `input.roleHint`, when it names one of the four real roles -- an
 *      explicit caller-supplied value (e.g. a future `tc start --role` flag).
 *   3. The `TANGLECLAW_SESSION_ROLE` environment variable, when it names one
 *      of the four real roles -- the launching process's own declared role.
 *   4. `input.projectId`'s active `coordinator_roles` row, if any:
 *      `architect` and `project-manager` both fold to `coordinator` (that
 *      table distinguishes neither worker/reviewer/master nor which
 *      coordinator kind, for this function's purposes).
 *   5. `'worker'` -- the default: an ordinary Builder lane session.
 *
 * @param {object} [input]
 * @param {boolean} [input.isMaster]
 * @param {string} [input.roleHint]
 * @param {number} [input.projectId]
 * @param {{env?: object}} [deps] - Injectable for tests; `env` defaults to `process.env`.
 * @returns {'worker'|'reviewer'|'coordinator'|'master'}
 */
function resolveSessionRole(input, deps) {
  const i = input && typeof input === 'object' ? input : {};
  const env = (deps && deps.env) || process.env;

  if (i.isMaster === true) return 'master';
  if (typeof i.roleHint === 'string' && ROLES.includes(i.roleHint)) return i.roleHint;

  const envRole = env[ROLE_ENV_VAR];
  if (typeof envRole === 'string' && ROLES.includes(envRole)) return envRole;

  if (Number.isInteger(i.projectId)) {
    const active = store.coordinatorRoles.getActiveForProject(i.projectId);
    if (active && COORDINATOR_ROLE_VALUES.includes(active.role)) return 'coordinator';
  }

  return 'worker';
}

/**
 * The resolved role's operating primer, for the real launch/prime path to
 * attach to a session's prime sections (Slice 3, #2888).
 * @param {object} [input] - As {@link resolveSessionRole}
 * @param {{env?: object}} [deps] - As {@link resolveSessionRole}
 * @returns {{role: ('worker'|'reviewer'|'coordinator'|'master'), primer: string}}
 */
function primerForLaunch(input, deps) {
  const role = resolveSessionRole(input, deps);
  return { role, primer: operatingPrimer.buildOperatingPrimer(role) };
}

/**
 * Attach the resolved role's operating primer to a lease as its own
 * companion field -- the issue's own "lease companion for AI resources"
 * framing, kept separate from the session prime (a lease is read by
 * whatever consumes the resource, not necessarily the leasing session's
 * own prime). Non-mutating: returns a new object, the same convention
 * `lib/resource-leases.js`'s own transition functions already use.
 * @param {object} lease - A lease object (`lib/resource-leases.js`'s own shape; opaque to this module beyond spreading it)
 * @param {object} [input] - As {@link resolveSessionRole}
 * @param {{env?: object}} [deps] - As {@link resolveSessionRole}
 * @returns {object} `lease`, plus `operatingPrimerRole` and `operatingPrimer`
 */
function attachOperatingPrimerToLease(lease, input, deps) {
  const { role, primer } = primerForLaunch(input, deps);
  return { ...(lease || {}), operatingPrimerRole: role, operatingPrimer: primer };
}

module.exports = {
  ROLES,
  ROLE_ENV_VAR,
  resolveSessionRole,
  primerForLaunch,
  attachOperatingPrimerToLease
};
