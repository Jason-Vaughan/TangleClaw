'use strict';

/**
 * Reusable Sprint Team Template package schema, validation and Settings
 * preview (#2395, Architect Ruling A2395, `v5.60.0` Car 60-B Slice 1).
 *
 * A pure schema/diff library: {@link validateTeamTemplate} and
 * {@link previewTeamTemplateApplication} take plain data — a template
 * package, a project's current seat list — and return a computed result.
 * Nothing here reads a database, imports a package from disk, or writes
 * anything; wiring import/apply into `server.js`/`lib/routes/*.js` and the
 * Settings UI (`public/app.js`, `public/index.html`) is Slice 2,
 * deliberately deferred so Car 60-B stays 100% file-disjoint from this
 * wave's other `v5.60.0` cars.
 *
 * @module lib/team-templates
 */

const crypto = require('node:crypto');

/**
 * Lane classes a template role may declare — the fleet roles this
 * product's own sprint methodology already names (Builder, Integrator,
 * the two independent peer reviewers, Architect, Project Manager,
 * Observer). A scoping decision (#2395's own ruling names "unknown lane
 * classes" as a validation failure without enumerating the known set):
 * this list is exactly the role vocabulary this repo's own fleet
 * dispatches already use, documented so a future addition is a one-line
 * change here rather than a guess at call time.
 * @type {ReadonlyArray<string>}
 */
const LANE_CLASSES = Object.freeze(['builder', 'integrator', 'prr-a', 'prr-b', 'architect', 'pm', 'observer']);

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

/**
 * Validate one role/seat definition within a template.
 * @param {object} role
 * @param {number} index
 * @returns {{ok: true, role: object}|{ok: false, code: string, message: string}}
 */
function _validateRole(role, index) {
  if (!role || typeof role !== 'object' || Array.isArray(role)) {
    return _refuse('TEAM_TEMPLATE_INVALID', `roles[${index}] is not an object.`);
  }
  if (typeof role.roleId !== 'string' || !role.roleId) {
    return _refuse('TEAM_TEMPLATE_INVALID', `roles[${index}] has no "roleId".`);
  }
  if (typeof role.title !== 'string' || !role.title) {
    return _refuse('TEAM_TEMPLATE_INVALID', `role "${role.roleId}" has no "title".`);
  }
  if (!LANE_CLASSES.includes(role.laneClass)) {
    return _refuse('TEAM_TEMPLATE_INVALID',
      `role "${role.roleId}" has unknown laneClass "${role.laneClass}" (expected one of ${LANE_CLASSES.join(', ')}).`);
  }
  const defaultRules = Array.isArray(role.defaultRules) ? role.defaultRules.filter((r) => typeof r === 'string') : [];
  const carAssignments = Array.isArray(role.carAssignments) ? role.carAssignments.filter((c) => typeof c === 'string') : [];
  const reviewGates = Array.isArray(role.reviewGates) ? role.reviewGates.filter((g) => typeof g === 'string') : [];
  return {
    ok: true,
    role: {
      roleId: role.roleId,
      title: role.title,
      laneClass: role.laneClass,
      enginePreference: typeof role.enginePreference === 'string' ? role.enginePreference : null,
      defaultRules,
      carAssignments,
      reviewGates
    }
  };
}

/**
 * Validate a Sprint Team Template package: schema shape, duplicate role
 * ids, unknown lane classes, and review-gate references that name a role
 * not in the same package (#2395). Fail-closed throughout — the first
 * problem found is the whole answer, not a partial result to build on.
 * @param {object} pkg - A candidate template package
 * @returns {{ok: true, template: object}|{ok: false, code: string, message: string}}
 */
function validateTeamTemplate(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'Template package must be an object.');
  }
  if (typeof pkg.templateId !== 'string' || !pkg.templateId) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'Template package has no "templateId".');
  }
  if (typeof pkg.name !== 'string' || !pkg.name) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'Template package has no "name".');
  }
  if (typeof pkg.version !== 'number' || !Number.isFinite(pkg.version)) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'Template package "version" must be a number.');
  }
  const roleList = Array.isArray(pkg.roles) ? pkg.roles : Array.isArray(pkg.seats) ? pkg.seats : null;
  if (!roleList || roleList.length === 0) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'Template package must carry a non-empty "roles" (or "seats") array.');
  }

  const roles = [];
  const seenIds = new Set();
  for (let i = 0; i < roleList.length; i++) {
    const validated = _validateRole(roleList[i], i);
    if (!validated.ok) return validated;
    if (seenIds.has(validated.role.roleId)) {
      return _refuse('TEAM_TEMPLATE_INVALID', `Duplicate role id "${validated.role.roleId}" (roles[${i}]).`);
    }
    seenIds.add(validated.role.roleId);
    roles.push(validated.role);
  }
  for (const role of roles) {
    for (const gate of role.reviewGates) {
      if (!seenIds.has(gate)) {
        return _refuse('TEAM_TEMPLATE_INVALID',
          `role "${role.roleId}" names reviewGates entry "${gate}", which is not a role id in this package.`);
      }
    }
  }

  return {
    ok: true,
    template: {
      templateId: pkg.templateId,
      name: pkg.name,
      version: pkg.version,
      description: typeof pkg.description === 'string' ? pkg.description : null,
      roles
    }
  };
}

/**
 * Compute a SHA-256 content digest over a validated template, in canonical
 * (already role-order-stable, since {@link validateTeamTemplate} preserves
 * input order) JSON form.
 * @param {object} template - A `validateTeamTemplate` result's `template`
 * @returns {string}
 */
function _templateDigest(template) {
  return crypto.createHash('sha256').update(JSON.stringify(template)).digest('hex');
}

/**
 * One current project seat's shape this module compares against a
 * template role, by `roleId`.
 * @typedef {{roleId: string, title: string, laneClass: string,
 *   enginePreference?: (string|null), defaultRules?: string[]}} CurrentSeat
 */

/**
 * Whether two role/seat definitions differ in any field this module
 * tracks, and which fields.
 * @param {object} templateRole
 * @param {object} currentSeat
 * @returns {string[]} Field names that differ; empty when identical
 */
function _diffFields(templateRole, currentSeat) {
  const fields = ['title', 'laneClass', 'enginePreference'];
  const changed = fields.filter((f) => (templateRole[f] || null) !== (currentSeat[f] || null));
  for (const listField of ['defaultRules', 'carAssignments', 'reviewGates']) {
    const templateValues = new Set(templateRole[listField] || []);
    const currentValues = new Set(currentSeat[listField] || []);
    const differ = templateValues.size !== currentValues.size
      || [...templateValues].some((v) => !currentValues.has(v));
    if (differ) changed.push(listField);
  }
  return changed;
}

/**
 * Generate a non-mutating Settings preview of applying a template package
 * to a project's current seat configuration (#2395): which seats the
 * template would add, which it would change and how, which already match,
 * and a warning for any current seat the template says nothing about (left
 * alone by a real apply — this preview never proposes removing a seat).
 * @param {object} templatePkg - A candidate template package (validated here)
 * @param {CurrentSeat[]} currentSeats - The project's current seats
 * @returns {{ok: true, preview: object}|{ok: false, code: string, message: string}}
 */
function previewTeamTemplateApplication(templatePkg, currentSeats) {
  const validated = validateTeamTemplate(templatePkg);
  if (!validated.ok) return validated;
  if (!Array.isArray(currentSeats)) {
    return _refuse('TEAM_TEMPLATE_INVALID', 'currentSeats must be an array.');
  }
  for (let i = 0; i < currentSeats.length; i++) {
    if (!currentSeats[i] || typeof currentSeats[i].roleId !== 'string' || !currentSeats[i].roleId) {
      return _refuse('TEAM_TEMPLATE_INVALID', `currentSeats[${i}] has no "roleId".`);
    }
  }

  const template = validated.template;
  const currentByRoleId = new Map(currentSeats.map((s) => [s.roleId, s]));
  const templateRoleIds = new Set(template.roles.map((r) => r.roleId));

  const addedSeats = [];
  const updatedSeats = [];
  const unchangedSeats = [];
  const ruleChanges = [];
  const warnings = [];

  for (const role of template.roles) {
    const current = currentByRoleId.get(role.roleId);
    if (!current) {
      addedSeats.push(role);
      if (role.defaultRules.length > 0) {
        ruleChanges.push({ roleId: role.roleId, added: role.defaultRules, removed: [] });
      }
      continue;
    }
    const changedFields = _diffFields(role, current);
    if (changedFields.length === 0) {
      unchangedSeats.push(role);
      continue;
    }
    updatedSeats.push({ roleId: role.roleId, changedFields, from: current, to: role });
    if (changedFields.includes('defaultRules')) {
      const currentRules = new Set(current.defaultRules || []);
      const templateRules = new Set(role.defaultRules);
      ruleChanges.push({
        roleId: role.roleId,
        added: role.defaultRules.filter((r) => !currentRules.has(r)),
        removed: (current.defaultRules || []).filter((r) => !templateRules.has(r))
      });
    }
  }

  for (const seat of currentSeats) {
    if (!templateRoleIds.has(seat.roleId)) {
      warnings.push({
        roleId: seat.roleId,
        detail: `Current seat "${seat.roleId}" has no corresponding role in this template; a real apply would leave it unchanged.`
      });
    }
  }

  return {
    ok: true,
    preview: {
      templateId: template.templateId,
      addedSeats, updatedSeats, unchangedSeats, ruleChanges, warnings,
      packageDigestSha256: _templateDigest(template)
    }
  };
}

module.exports = {
  LANE_CLASSES,
  validateTeamTemplate,
  previewTeamTemplateApplication
};
