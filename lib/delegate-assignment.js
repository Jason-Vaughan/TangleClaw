'use strict';

/**
 * v6 (#3263, V6-010, Car V663-W1-B): explicit fleet delegate assignment —
 * making a project a fleet's recognized Delegate (Coordinator/PM) updates
 * real runtime authority, not just the client-side "who does chat talk to"
 * preference `public/v6-shell.js#changeDelegate` already has (#3047; that
 * one is a pure browser pref with no server call at all).
 *
 * {@link assignFleetDelegate} atomically-as-the-underlying-stores-allow
 * updates THREE of the four systems the issue names:
 * 1. `coordinator_roles` — grants the new delegate the `project-manager`
 *    role, revoking the old delegate's (via `lib/coordinator-rotation.js`'s
 *    already-validated, already-tested `grantRole`/`revokeRole` — the same
 *    functions `POST /api/tc/fleet/coordinator` itself calls).
 * 2. `fleetCoordinator` — the project-config boolean toggled on the new
 *    delegate and off the old one (`store.projectConfig`).
 * 3. Sibling members' `workloadNudge.coordinatorProject` — repointed at the
 *    new delegate's project name, validated with
 *    `lib/project-config.js#workloadNudgeProblem` before writing.
 *
 * The fourth, `control_assignments`' authority matrix (`lib/control-state.js`,
 * each sibling's recorded `lifecycle` principal), is NOT done here. There is
 * no existing primitive to update an ACTIVE assignment's authority in
 * place: `controlState.create()` only supersedes an assignment that is
 * already `stopped` (confirmed by reading it — it throws `ASSIGNMENT_OPEN`
 * for `active`/`held`), and no store-level setter for `authority_json`
 * exists outside creation. Closing this gap needs either a new
 * `lib/store.js` setter (out of this car's file envelope) or an Architect
 * ruling on whether a stop-then-recreate cycle is an acceptable way to get
 * there. Every result this module returns carries `controlAssignmentsPending:
 * true` so a caller can never mistake this for done.
 *
 * Neither true cross-store atomicity: `coordinator_roles`/`control_assignments`
 * are SQLite, `fleetCoordinator`/`workloadNudge` are `project.json` file
 * writes — two different kinds of storage, each internally consistent, not
 * one shared transaction. Steps run in the order above and stop at the
 * first failure; the result names exactly which steps committed before
 * that happened, so a caller/route can decide how to reconcile rather than
 * being told a false "all or nothing."
 *
 * @module lib/delegate-assignment
 */

const store = require('./store');
const coordinatorRotation = require('./coordinator-rotation');
const { workloadNudgeProblem } = require('./project-config');

/** A typed refusal: `code` is stable, `status` is the HTTP status a route should answer with. */
class DelegateAssignmentError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [detail]
   */
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'DelegateAssignmentError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a {@link DelegateAssignmentError} unless `condition` holds.
 * @param {*} condition
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @param {object} [detail]
 * @returns {void}
 */
function need(condition, code, message, status = 400, detail) {
  if (!condition) throw new DelegateAssignmentError(code, message, status, detail);
}

/**
 * A project row by id, refusing when it does not exist.
 * @param {number} projectId
 * @param {string} role - `'newDelegateProjectId'`/`'oldDelegateProjectId'`/a member id, for the message
 * @returns {object}
 */
function _requireProject(projectId, role) {
  need(Number.isSafeInteger(projectId) && projectId > 0, 'PROJECT_ID_INVALID', `${role} must be a positive integer`);
  const project = store.projects.get(projectId);
  need(project, 'PROJECT_NOT_FOUND', `${role} ${projectId} has no such project`, 404, { projectId });
  return project;
}

/**
 * Make `newDelegateProjectId` a fleet's recognized Delegate, updating
 * `coordinator_roles`, `fleetCoordinator`, and every named sibling member's
 * `workloadNudge.coordinatorProject` — but NOT `control_assignments` (see
 * this module's header). Stops at the first failed step; `steps` names
 * every step attempted, in order, each with its own outcome, so a partial
 * run is never reported as if it fully succeeded.
 *
 * @param {{newDelegateProjectId: number, oldDelegateProjectId?: (number|null),
 *   memberProjectIds?: number[], note?: string}} input
 * @param {{kind: string}} caller - From `lib/control-auth.js#resolveControlCaller`;
 *   `coordinatorRotation.grantRole`/`revokeRole` each refuse unless `caller.kind === 'operator'`.
 * @param {{now?: () => string}} [deps] - Injection seam.
 * @returns {{ok: boolean, newDelegateProjectId: number, oldDelegateProjectId: (number|null),
 *   controlAssignmentsPending: true, steps: Array<{step: string, ok: boolean, detail: *}>}}
 * @throws {DelegateAssignmentError} `PROJECT_ID_INVALID`, `PROJECT_NOT_FOUND`, `MEMBER_IDS_INVALID`
 *   (thrown before any step runs — no partial state from a malformed call); a step's own failure is
 *   reported in `steps`, never thrown, since every step after it was never attempted and nothing
 *   needs unwinding that already-run steps didn't already commit.
 */
function assignFleetDelegate(input, caller, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const newDelegate = _requireProject(input.newDelegateProjectId, 'newDelegateProjectId');
  const oldDelegateProjectId = input.oldDelegateProjectId == null ? null : input.oldDelegateProjectId;
  const oldDelegate = oldDelegateProjectId == null ? null : _requireProject(oldDelegateProjectId, 'oldDelegateProjectId');
  const memberProjectIds = input.memberProjectIds === undefined ? [] : input.memberProjectIds;
  need(Array.isArray(memberProjectIds), 'MEMBER_IDS_INVALID', 'memberProjectIds must be an array');
  const members = memberProjectIds.map((id) => _requireProject(id, 'a memberProjectIds entry'));
  const note = typeof input.note === 'string' ? input.note : undefined;

  const steps = [];
  /** Record a passing step. @param {string} step @param {*} detail @returns {void} */
  const pass = (step, detail) => { steps.push({ step, ok: true, detail }); };
  /** Record a failing step and build this call's failure result. @param {string} step @param {*} detail @returns {object} */
  const fail = (step, detail) => {
    steps.push({ step, ok: false, detail });
    return { ok: false, newDelegateProjectId: newDelegate.id, oldDelegateProjectId, controlAssignmentsPending: true, steps };
  };

  /**
   * Load, patch and save a project's config, catching a filesystem error
   * (a read/write failure, a permission problem) so it is recorded as this
   * step's own failure (#3263 PRR-B R2) rather than an uncaught exception
   * escaping `assignFleetDelegate` after earlier steps already committed.
   * @param {string} projectPath
   * @param {(config: object) => object} patch
   * @returns {{ok: true, config: object}|{ok: false, error: string}}
   */
  function saveConfig(projectPath, patch) {
    try {
      const config = store.projectConfig.load(projectPath);
      const next = patch(config);
      store.projectConfig.save(projectPath, next);
      return { ok: true, config: next };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const grant = coordinatorRotation.grantRole({ caller, body: { projectId: newDelegate.id, role: 'project-manager', note } }, { now });
  if (grant.status >= 400) return fail('grantCoordinatorRole', grant.body);
  pass('grantCoordinatorRole', grant.body);

  if (oldDelegate) {
    const revoke = coordinatorRotation.revokeRole({ caller, body: { projectId: oldDelegate.id } }, { now });
    // #3263: a 404 ROLE_NOT_FOUND means the old delegate already held no
    // active role (e.g. it was already reassigned, or never actually had
    // one) -- nothing to undo, not a failure of THIS operation; any other
    // refusal (authorization, a store error) genuinely stops the run.
    if (revoke.status >= 400 && revoke.body.code !== 'ROLE_NOT_FOUND') return fail('revokeOldCoordinatorRole', revoke.body);
    pass('revokeOldCoordinatorRole', revoke.body);
  }

  if (oldDelegate) {
    const result = saveConfig(oldDelegate.path, (config) => ({ ...config, fleetCoordinator: false }));
    if (!result.ok) return fail('clearOldFleetCoordinatorFlag', { projectId: oldDelegate.id, error: result.error });
    pass('clearOldFleetCoordinatorFlag', { projectId: oldDelegate.id });
  }
  {
    const result = saveConfig(newDelegate.path, (config) => ({ ...config, fleetCoordinator: true }));
    if (!result.ok) return fail('setNewFleetCoordinatorFlag', { projectId: newDelegate.id, error: result.error });
    pass('setNewFleetCoordinatorFlag', { projectId: newDelegate.id });
  }

  for (const member of members) {
    const problem = workloadNudgeProblem('coordinatorProject', newDelegate.name);
    if (problem) return fail('updateMemberCoordinatorProject', { projectId: member.id, problem });
    const result = saveConfig(member.path, (config) => ({
      ...config, workloadNudge: { ...(config.workloadNudge || {}), coordinatorProject: newDelegate.name }
    }));
    if (!result.ok) return fail('updateMemberCoordinatorProject', { projectId: member.id, error: result.error });
    pass('updateMemberCoordinatorProject', { projectId: member.id, coordinatorProject: newDelegate.name });
  }

  return { ok: true, newDelegateProjectId: newDelegate.id, oldDelegateProjectId, controlAssignmentsPending: true, steps };
}

module.exports = { DelegateAssignmentError, assignFleetDelegate };
