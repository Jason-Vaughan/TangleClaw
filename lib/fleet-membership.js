'use strict';

/**
 * v6 Fleet Membership Management (#3262, V6-009, Car V663-W1-A): add an
 * existing workspace project to a fleet, or remove a member — with
 * immediate runtime reflection in `project_groups`/`project_group_members`
 * (`lib/store.js`'s `projectGroups` API, taken as an injected dependency so
 * this module never requires that large shared file directly).
 *
 * SCHEMA FINDING (verified by execution, not guessed — flagged in this
 * car's own PR rather than silently built around): the issue also asks for
 * this to reflect in `v6_fleets`/`v6_resources`. It does not, for a real,
 * confirmed schema reason. `v6_resources.legacy_project_id` is `UNIQUE`,
 * and `v6_legacy_project_insert` (an `AFTER INSERT ON projects` trigger,
 * `lib/store/_schema.js`) creates exactly one `v6_resources` row for every
 * legacy project the instant it exists — under that project's OWN
 * dedicated logical project (`'lp-' || id`), `fleet_id` left `NULL`. A
 * second resource row for the same legacy project is therefore impossible
 * (the `UNIQUE` constraint refuses it), and `v6_resources`' own composite
 * foreign key, `FOREIGN KEY (fleet_id, logical_project_id) REFERENCES
 * v6_fleets(id, logical_project_id)`, refuses even REASSIGNING that
 * existing row's `fleet_id` to any fleet that is not itself owned by that
 * SAME `'lp-' || id` logical project — confirmed directly: a raw `UPDATE
 * v6_resources SET fleet_id = ?` against a fleet belonging to a different
 * logical project throws `FOREIGN KEY constraint failed`. `lib/v6/
 * c1-logical-projects.js` (out of this car's file scope to edit) exposes
 * no function for reassigning a resource across logical projects either.
 * For an EXISTING legacy project joining a fleet it does not itself own,
 * `v6_fleets`/`v6_resources` membership is not representable in the
 * current schema at all — `project_groups` is the one mechanism the
 * schema actually supports for this, and is this module's real store.
 *
 * `legacyProjectId` throughout is the existing numeric `projects.id` (what
 * every other part of this codebase calls a "project").
 *
 * @module lib/fleet-membership
 */

/**
 * Add an existing workspace project to a fleet's membership group.
 * @param {object} args
 * @param {string} args.groupId - A `project_groups.id` — the fleet's own membership roster.
 * @param {number} args.legacyProjectId
 * @param {object} deps
 * @param {{get: (id: string) => (object|null), listMembers: (groupId: string) => number[], addMember: (groupId: string, projectId: number) => void}} deps.groupsApi - `lib/store.js`'s `projectGroups` API.
 * @param {(projectId: number) => boolean} [deps.projectExists] - Defaults to "exists" when omitted (test-only default; a real caller always supplies this, backed by `store.projects.get`).
 * @returns {{ok: boolean, code: string}}
 */
function addMember({ groupId, legacyProjectId }, deps) {
  const { groupsApi, projectExists = () => true } = deps || {};
  if (!groupsApi) return { ok: false, code: 'MISSING_DEPENDENCY' };
  if (typeof groupId !== 'string' || !groupId) return { ok: false, code: 'INVALID_REQUEST' };
  if (!Number.isInteger(legacyProjectId)) return { ok: false, code: 'INVALID_REQUEST' };
  if (!groupsApi.get(groupId)) return { ok: false, code: 'FLEET_NOT_FOUND' };
  if (!projectExists(legacyProjectId)) return { ok: false, code: 'PROJECT_NOT_FOUND' };
  if (groupsApi.listMembers(groupId).includes(legacyProjectId)) return { ok: false, code: 'ALREADY_MEMBER' };
  groupsApi.addMember(groupId, legacyProjectId);
  return { ok: true, code: 'CREATED' };
}

/**
 * Remove a member from a fleet's membership group.
 *
 * Safeguard (the issue's own acceptance criterion): refuses with
 * `ACTIVE_SESSION` when `deps.isLegacyProjectSessionActive` reports a live
 * session for this project, UNLESS `args.confirmed === true` — the caller
 * (the route layer) is what actually asks the operator to confirm removing
 * an active session mid-turn; this module only enforces that the asking
 * happened, never performs it itself.
 * @param {object} args
 * @param {string} args.groupId
 * @param {number} args.legacyProjectId
 * @param {boolean} [args.confirmed]
 * @param {object} deps
 * @param {{get: (id: string) => (object|null), listMembers: (groupId: string) => number[], removeMember: (groupId: string, projectId: number) => void}} deps.groupsApi
 * @param {(legacyProjectId: number) => boolean} [deps.isLegacyProjectSessionActive] - Defaults to "never active" when omitted (test-only default; a real caller always supplies this).
 * @returns {{ok: boolean, code: string}}
 */
function removeMember({ groupId, legacyProjectId, confirmed = false }, deps) {
  const { groupsApi, isLegacyProjectSessionActive = () => false } = deps || {};
  if (!groupsApi) return { ok: false, code: 'MISSING_DEPENDENCY' };
  if (!groupsApi.get(groupId)) return { ok: false, code: 'FLEET_NOT_FOUND' };
  if (!groupsApi.listMembers(groupId).includes(legacyProjectId)) return { ok: false, code: 'NOT_FOUND' };
  if (!confirmed && isLegacyProjectSessionActive(legacyProjectId)) {
    return { ok: false, code: 'ACTIVE_SESSION' };
  }
  groupsApi.removeMember(groupId, legacyProjectId);
  return { ok: true, code: 'UPDATED' };
}

/**
 * List every current member of a fleet's membership group.
 * @param {{groupId: string}} args
 * @param {object} deps
 * @param {{get: (id: string) => (object|null), listMembers: (groupId: string) => number[]}} deps.groupsApi
 * @returns {{ok: boolean, code: string, members?: number[]}}
 */
function listMembers({ groupId }, deps) {
  const { groupsApi } = deps || {};
  if (!groupsApi) return { ok: false, code: 'MISSING_DEPENDENCY' };
  if (!groupsApi.get(groupId)) return { ok: false, code: 'FLEET_NOT_FOUND' };
  return { ok: true, code: 'OK', members: groupsApi.listMembers(groupId) };
}

module.exports = { addMember, removeMember, listMembers };
