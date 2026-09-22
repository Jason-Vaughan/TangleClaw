'use strict';

/**
 * How much of a project row each caller of the projects API may see.
 *
 * An enriched project row carries the project's absolute path, its group
 * membership, its git state, file paths from its session-health check, its
 * ports and its engine profile. Those describe one project's workspace, so a
 * caller sees them only for a project it owns: the operator and the verified
 * Project Master see every row whole, a bound project sees its own row whole,
 * and every other row reaches every other caller as the public projection.
 *
 * The public projection is an allowlist. A field added to the enriched row
 * later is withheld from it until someone decides it belongs there, so the
 * disclosure cannot reopen by accident.
 *
 * The caller is resolved by `lib/shared-docs-access.js`, the one resolver that
 * knows how to tell the operator, the Master and a bound project apart.
 * @module lib/project-view
 */

const { KINDS } = require('./shared-docs-access');

/**
 * Whether this caller sees every project whole.
 * @param {{kind: string}} access - From `sharedDocsAccess.resolveAccess`
 * @returns {boolean}
 */
function seesEveryProject(access) {
  return access.kind === KINDS.OPERATOR || access.kind === KINDS.MASTER;
}

/**
 * Whether this caller sees this project's full row.
 * @param {{kind: string, projectId: (number|null)}} access - From `sharedDocsAccess.resolveAccess`
 * @param {{id?: (number|null)}} project - An enriched project row
 * @returns {boolean}
 */
function seesWhole(access, project) {
  if (seesEveryProject(access)) return true;
  return access.kind === KINDS.PROJECT
    && project.id !== null && project.id !== undefined
    && project.id === access.projectId;
}

/**
 * The fields of a project any caller may see: enough to name it, tell its
 * engine and whether a session is live, and nothing about its workspace.
 * @param {object} project - An enriched project row
 * @returns {object} A new object; `restricted: true` marks it as shaped
 */
function publicProjection(project) {
  const engine = project.engine && typeof project.engine === 'object'
    ? { id: project.engine.id || null, name: project.engine.name || null }
    : null;
  const session = project.session && typeof project.session === 'object'
    ? {
      active: project.session.active === true,
      status: project.session.status || null,
      startedAt: project.session.startedAt || null
    }
    : null;
  return {
    id: project.id === undefined ? null : project.id,
    name: project.name,
    registered: project.registered !== false,
    archived: project.archived === true,
    tags: Array.isArray(project.tags) ? project.tags.slice() : [],
    engine,
    session,
    restricted: true
  };
}

/**
 * Shape one project row for a caller.
 * @param {{kind: string, projectId: (number|null)}} access - From `sharedDocsAccess.resolveAccess`
 * @param {object} project - An enriched project row
 * @returns {object} The row itself when the caller may see it whole, else its public projection
 */
function shapeProject(access, project) {
  return seesWhole(access, project) ? project : publicProjection(project);
}

/**
 * Shape the directory-scan block of `GET /api/projects`. Its `dir` is the
 * projects directory on this machine and its `hint` can name it, so only a
 * caller that sees every project whole gets them.
 * @param {{kind: string}} access - From `sharedDocsAccess.resolveAccess`
 * @param {object|null} scan - The scan block from `projects.listAllProjects`
 * @returns {object|null}
 */
function shapeScan(access, scan) {
  if (!scan || typeof scan !== 'object' || seesEveryProject(access)) return scan;
  return {
    complete: scan.complete,
    code: scan.code === undefined ? null : scan.code,
    listed: scan.listed
  };
}

module.exports = {
  seesEveryProject,
  seesWhole,
  publicProjection,
  shapeProject,
  shapeScan
};
