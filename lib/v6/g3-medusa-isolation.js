'use strict';

/**
 * v6 (#2986, V6-14 / G3, Car V60-T2-W1-D): default-on Medusa communication
 * and mandatory Project/Fleet switchboard isolation.
 *
 * {@link defaultMedusaSettings} is the pure default (#2986 deliverable 1):
 * a CONSTANT a future project-creation call site applies, not a mutation
 * this module performs — this car's envelope is `lib/v6/g3-medusa-
 * isolation.js` only (zero `lib/store/_schema.js` or `server.js` edits),
 * so wiring it into real project creation is `BRIDGE-2`/`BRIDGE-5` (named
 * in #2986 itself as the required integration bridges), not this car.
 *
 * {@link checkMedusaCrossProjectAccess} is the switchboard ACL (#2986
 * deliverable 2): a caller's own project always reaches its own
 * switchboard; reaching a DIFFERENT logical project's switchboard is
 * refused `MEDUSA_CROSS_PROJECT_DENIED` unless an explicit link admits it.
 *
 * OPEN DESIGN QUESTION, flagged rather than silently resolved: #2986 calls
 * the exception "an explicit #2118 cross-project link," but
 * `lib/v6/c1-logical-projects.js`'s real schema (`v6_shared_assets` /
 * `v6_asset_grants`) has no asset `kind` for this — `ASSET_KINDS` is
 * `['document', 'rule', 'plan', 'config', 'artifact']`, and
 * `v6_authority_grants` grants a PRINCIPAL an operation within one
 * project, not a project-to-project switchboard link. Neither that file
 * nor `lib/store/_schema.js` is in this car's envelope, so this module
 * does not persist or look up a link itself: {@link checkMedusaCrossProjectAccess}
 * takes the caller's known links as an injected `crossProjectLinks` list,
 * the same decoupled-from-persistence pattern this wave's sibling cars
 * use (`lib/v6/b4-telemetry-header.js`, `lib/v6/c2-fleet-templates.js`).
 * Which real mechanism backs that list (a new asset kind, a new table, or
 * something else) is for whoever builds `BRIDGE-2`/`BRIDGE-5` to decide.
 *
 * @module lib/v6/g3-medusa-isolation
 */

/**
 * The default Medusa settings a new project should start with (#2986
 * deliverable 1) — default-on, per the issue title.
 * @returns {{medusaEnabled: true, medusaWake: true}}
 */
function defaultMedusaSettings() {
  return { medusaEnabled: true, medusaWake: true };
}

/**
 * Is `value` a real project id — present and non-blank after trimming?
 * PRR-B R1 HOLD (Ruling A562-PR3013-R1-HOLD-RECONCILED): without this,
 * `String(null) === String(null)` ('null' === 'null') and
 * `String('') === String('')` both read as equal, so two MISSING ids were
 * admitting each other as "the same project."
 * @param {*} value
 * @returns {boolean}
 */
function _isNonBlankId(value) {
  return value != null && String(value).trim().length > 0;
}

/**
 * Does one explicit cross-project link admit `callerProjectId` reaching
 * `targetProjectId`'s switchboard? A link is directional
 * (`fromProjectId` may reach `toProjectId`) unless it declares
 * `bidirectional: true`, in which case it admits the reverse direction too
 * — explicit grants default to the least-privilege direction they were
 * actually requested for. A link missing either id covers nothing.
 * @param {{fromProjectId: *, toProjectId: *, bidirectional?: boolean}} link
 * @param {*} callerProjectId
 * @param {*} targetProjectId
 * @returns {boolean}
 */
function _linkCovers(link, callerProjectId, targetProjectId) {
  if (!link || !_isNonBlankId(link.fromProjectId) || !_isNonBlankId(link.toProjectId)) return false;
  const from = String(link.fromProjectId);
  const to = String(link.toProjectId);
  const caller = String(callerProjectId);
  const target = String(targetProjectId);
  if (from === caller && to === target) return true;
  if (link.bidirectional === true && from === target && to === caller) return true;
  return false;
}

/**
 * The switchboard ACL (#2986 deliverable 2). A project always reaches its
 * own switchboard; a different Logical Project's switchboard is refused
 * `MEDUSA_CROSS_PROJECT_DENIED` unless `crossProjectLinks` contains a link
 * that covers this exact (caller, target) direction.
 *
 * Fails closed (PRR-B R1 HOLD, Ruling A562-PR3013-R1-HOLD-RECONCILED) when
 * either id is missing, `undefined`, or blank after trimming — BEFORE the
 * equality check, so two absent ids never read as "the same project."
 * @param {*} callerProjectId - The Logical Project id making the call.
 * @param {*} targetProjectId - The Logical Project id whose switchboard is being reached.
 * @param {{crossProjectLinks?: Iterable<{fromProjectId: *, toProjectId: *, bidirectional?: boolean}>}} [opts]
 * @returns {{allowed: boolean, code?: string}} `code` is
 *   `MEDUSA_CROSS_PROJECT_DENIED` on refusal, matching #2986's named HTTP
 *   403 code verbatim (the HTTP status itself is a future route-wiring
 *   car's concern, not this module's).
 */
function checkMedusaCrossProjectAccess(callerProjectId, targetProjectId, opts = {}) {
  if (!_isNonBlankId(callerProjectId) || !_isNonBlankId(targetProjectId)) {
    return { allowed: false, code: 'MEDUSA_CROSS_PROJECT_DENIED' };
  }
  if (String(callerProjectId) === String(targetProjectId)) return { allowed: true };
  for (const link of opts.crossProjectLinks || []) {
    if (_linkCovers(link, callerProjectId, targetProjectId)) return { allowed: true };
  }
  return { allowed: false, code: 'MEDUSA_CROSS_PROJECT_DENIED' };
}

module.exports = {
  defaultMedusaSettings,
  checkMedusaCrossProjectAccess
};
