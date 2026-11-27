'use strict';

/**
 * Per-project settings-parity read route (#3278, V6-049).
 *
 * `PATCH /api/projects/:name` (`server.js`) already lets a project's own
 * session, or the operator, change that project's settings — but there was
 * no symmetric read exposing the full resolved config plus a parity audit of
 * it, so an assistant or Admin Fleet caller had no authorized way to
 * "inspect... settings programmatically" (#3278's own wording) without
 * guessing at which fields a PATCH body would accept.
 *
 * This module is additive only: it registers one new, read-only route and
 * changes nothing already live in `server.js`. Like `lib/routes/config.js`'s
 * own extraction (#2248), `register(deps)` is handed the handful of
 * server.js-local pieces it needs rather than requiring the entry point back
 * (a cycle); unlike that module, every dependency here is a real,
 * independently-requirable library (`lib/shared-docs-access.js`,
 * `lib/projects.js`, `lib/project-config.js`), so the defaults below work
 * out of the box and a caller overrides only what a test needs to fake.
 * `server.js` requires this module and calls `register()` with no overrides
 * at the position `lib/routes/config.js`'s own routes hold, so the route is
 * genuinely live.
 *
 * @module lib/routes/projects
 */

const sharedDocsAccess = require('../shared-docs-access');
const projects = require('../projects');
const projectConfig = require('../project-config');
const settingsParity = require('./settings-parity');
const { route, jsonResponse, errorResponse } = require('./_kernel');
const { createLogger } = require('../logger');

const log = createLogger('server');

/**
 * Build the `GET /api/projects/:name/settings-parity` handler.
 * @param {object} [deps] - Overridable for tests; every field has a real default.
 * @param {(req: object) => {kind: string, reason: (string|null)}} [deps.resolveAccess]
 * @param {(access: object, need: string, action?: string) => ({status:number,code:string,message:string}|null)} [deps.projectRefusalFor]
 * @param {(access: object, projectId: number) => boolean} [deps.canChangeProject]
 * @param {(name: string) => (object|null)} [deps.getProjectRow]
 * @param {(projectPath: string) => object} [deps.loadProjectConfig]
 * @param {(config: object, options?: object) => object} [deps.auditProjectSettings]
 * @returns {function(object, object, object): void} An (req, res, params) route handler.
 */
function _buildGetProjectSettingsParity(deps = {}) {
  const resolveAccess = deps.resolveAccess || sharedDocsAccess.resolveAccess;
  const projectRefusalFor = deps.projectRefusalFor || sharedDocsAccess.projectRefusalFor;
  const canChangeProject = deps.canChangeProject || sharedDocsAccess.canChangeProject;
  const getProjectRow = deps.getProjectRow || projects.getProjectRow;
  const loadProjectConfig = deps.loadProjectConfig || projectConfig.load;
  const auditProjectSettings = deps.auditProjectSettings || settingsParity.auditProjectSettings;

  return function getProjectSettingsParity(req, res, params) {
    const access = resolveAccess(req);
    // Same gate as the existing PATCH: a project's settings are read or
    // changed by that project's own session, or the operator (#1752's own
    // boundary) — a read this parity-focused still names the same fields a
    // PATCH body would accept, so it gets the same protection.
    const refusal = projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
    if (refusal) {
      log.warn('Project settings-parity read refused', { project: params.name, code: refusal.code });
      return errorResponse(res, refusal.status, refusal.message, refusal.code);
    }
    const row = getProjectRow(params.name);
    if (!row) return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
    if (!canChangeProject(access, row.id)) {
      return errorResponse(res, 403,
        `This session is bound to another project, so it cannot read "${row.name}"'s settings. `
        + 'A project\'s settings are read by that project\'s own session, or by the operator.',
        'OTHER_PROJECT');
    }

    const config = loadProjectConfig(row.path);
    const audit = auditProjectSettings(config);
    log.info('Project settings-parity read', { project: row.name, gaps: audit.gaps.length, unknown: audit.unknownKeys.length });
    jsonResponse(res, 200, { project: row.name, config, audit });
  };
}

/**
 * Register this module's routes through the shared kernel.
 * @param {object} [deps] - See {@link _buildGetProjectSettingsParity}.
 * @returns {void}
 */
function register(deps = {}) {
  route('GET', '/api/projects/:name/settings-parity', _buildGetProjectSettingsParity(deps));
}

module.exports = { register, _buildGetProjectSettingsParity };
