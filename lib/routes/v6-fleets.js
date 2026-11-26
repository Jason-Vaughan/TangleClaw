'use strict';

/**
 * The HTTP adapter for `lib/fleet-membership.js` (#3262, V6-009, Car
 * V663-W1-A): a clean route factory, `createV6FleetsRouter(deps)`,
 * exposing add/remove/list for a fleet's own member seats (a
 * `project_groups` roster — see `lib/fleet-membership.js`'s own header for
 * why `v6_fleets`/`v6_resources` cannot represent this).
 *
 * Deliberately NOT registered through `lib/routes/_kernel.js`'s shared
 * `route()` table, and NOT yet mounted in `server.js` at all — same
 * reasoning and the same precedent as `lib/routes/sprint-wave-routes.js`
 * (#2644/#3087): `createV6FleetsRouter` returns its own local route list
 * and a self-contained `handle(req, res)`, built on the kernel's
 * stateless response/body helpers (not its route table), so this module
 * is lift-and-run testable in isolation. Mounting it is out of this
 * car's file envelope this wave: `server.js` is Car V664-W1-D's
 * exclusive file. A future car mounts it (registering each of
 * `endpoints` through the kernel's own route table, the same way
 * `sprint-wave-routes.js` was eventually wired in) once that car's own
 * work has landed.
 *
 * @module lib/routes/v6-fleets
 */

const { jsonResponse, errorResponse, parseBody, reqUrl } = require('./_kernel');
const fleetMembership = require('../fleet-membership');

/**
 * Compile one `:param`-bearing pattern to a matcher, independent of the
 * kernel's own route table (see the module doc for why).
 * @param {string} pattern - e.g. `/api/v6/fleets/:groupId/members`.
 * @returns {{regex: RegExp, paramNames: string[]}}
 */
function _compile(pattern) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

/** `{ok, code}` → HTTP status, read from every code `lib/fleet-membership.js` actually returns. */
const STATUS_BY_CODE = {
  FLEET_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  MISSING_DEPENDENCY: 500,
  ALREADY_MEMBER: 409,
  ACTIVE_SESSION: 409
};

/**
 * Create the v6 fleet-membership router.
 * @param {object} deps
 * @param {{get: Function, listMembers: Function, addMember: Function, removeMember: Function}} deps.groupsApi - `lib/store.js`'s `projectGroups` API.
 * @param {(projectId: number) => boolean} [deps.projectExists] - See `lib/fleet-membership.js#addMember`'s own doc.
 * @param {(legacyProjectId: number) => boolean} [deps.isLegacyProjectSessionActive] - See `lib/fleet-membership.js#removeMember`'s own doc.
 * @returns {{routes: object[], endpoints: object[], handle: Function}}
 */
function createV6FleetsRouter(deps) {
  const d = deps || {};
  const memberDeps = () => ({
    groupsApi: d.groupsApi, projectExists: d.projectExists, isLegacyProjectSessionActive: d.isLegacyProjectSessionActive
  });

  function respond(res, result) {
    if (result.ok) {
      jsonResponse(res, result.code === 'CREATED' ? 201 : 200, { ok: true, ...result });
      return;
    }
    const status = STATUS_BY_CODE[result.code] || 400;
    errorResponse(res, status, result.code, result.code);
  }

  async function handleListMembers(_req, res, params) {
    respond(res, fleetMembership.listMembers({ groupId: params.groupId }, memberDeps()));
  }

  async function handleAddMember(_req, res, params, body) {
    const b = body && typeof body === 'object' ? body : {};
    if (!Number.isInteger(b.legacyProjectId)) {
      return errorResponse(res, 400, 'legacyProjectId must be an integer', 'BAD_REQUEST');
    }
    respond(res, fleetMembership.addMember({ groupId: params.groupId, legacyProjectId: b.legacyProjectId }, memberDeps()));
  }

  async function handleRemoveMember(_req, res, params, body) {
    const legacyProjectId = Number(params.legacyProjectId);
    if (!Number.isInteger(legacyProjectId)) {
      return errorResponse(res, 400, 'legacyProjectId must be an integer', 'BAD_REQUEST');
    }
    const b = body && typeof body === 'object' ? body : {};
    respond(res, fleetMembership.removeMember({ groupId: params.groupId, legacyProjectId, confirmed: b.confirmed === true }, memberDeps()));
  }

  const table = [
    { method: 'GET', pattern: '/api/v6/fleets/:groupId/members', handler: handleListMembers },
    { method: 'POST', pattern: '/api/v6/fleets/:groupId/members', handler: handleAddMember },
    { method: 'DELETE', pattern: '/api/v6/fleets/:groupId/members/:legacyProjectId', handler: handleRemoveMember }
  ].map((entry) => ({ ...entry, ..._compile(entry.pattern) }));

  /**
   * Match and dispatch one request against this router's own table.
   * @param {object} req - A Node `http.IncomingMessage`.
   * @param {object} res - Its `http.ServerResponse`.
   * @returns {Promise<boolean>} Whether this router handled the request.
   */
  async function handle(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = reqUrl(req).pathname;
    for (const entry of table) {
      if (entry.method !== method) continue;
      const match = pathname.match(entry.regex);
      if (!match) continue;
      const params = {};
      entry.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      let body = null;
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          body = await parseBody(req);
        } catch (err) {
          errorResponse(res, err.status || 500, err.message, err.code || 'INTERNAL_ERROR', err.extra);
          return true;
        }
      }
      await entry.handler(req, res, params, body);
      return true;
    }
    return false;
  }

  return {
    routes: table.map((entry) => ({ method: entry.method, pattern: entry.pattern })),
    endpoints: table.map((entry) => ({ method: entry.method, pattern: entry.pattern, handler: entry.handler })),
    handle
  };
}

module.exports = { createV6FleetsRouter };
