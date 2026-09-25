'use strict';

/**
 * Who is asking, for the control routes (#1861).
 *
 * Built on `shared-docs-access#resolveAccess`, with one difference that
 * matters: the operator must also carry a PROOF TIER. `resolveAccess` answers
 * `operator` for a request that merely looks like the dashboard whenever the
 * account gate has stood down, and a local process can forge that look with
 * one header. That is acceptable for reading shared docs; it is not
 * acceptable for creating assignments, releasing someone else's hold, stopping
 * or closing. So:
 *
 * - `verified-session`: the request carries an account session. Accepted in
 *   every gate state.
 * - `ambient-open`: the gate is `open` because the operator switched auth off.
 *   That install has no identity boundary by choice; accepted, and recorded
 *   on every event so nobody mistakes it for authentication.
 * - otherwise the operator is unverifiable: `fallback` (TangleClaw stood down
 *   behind Caddy, which a loopback process bypasses) and `unreadable` (the
 *   gate state could not be read) answer 503. `armed`, `locked` and
 *   `account-required` never resolve an operator without a session, so an
 *   operator-shaped request there is simply not the operator.
 *
 * A project principal is a verified launch: the launch exists, its project
 * matches the claim, and its session is active. A Medusa sender, a URL
 * project name or a service token is never a principal here.
 *
 * @module lib/control-auth
 */

const sharedDocsAccess = require('./shared-docs-access');
const { GATE_STATES } = require('./auth-gate');

/**
 * Whether a request presents itself as the operator's dashboard or browser.
 * @param {object} req - The request
 * @returns {boolean}
 */
function _operatorShaped(req) {
  const headers = req.headers || {};
  return headers['sec-fetch-site'] !== undefined || headers.origin !== undefined
    || headers[sharedDocsAccess.CLIENT_HEADER] === sharedDocsAccess.DASHBOARD_CLIENT;
}

/**
 * Resolve the caller of a control route.
 * @param {object} req - The request, annotated by `server.js` (`tcSession`, `tcGateState`)
 * @param {Function} [resolveAccess] - Injected for tests; defaults to the shared resolver
 * @returns {{kind: string, actor?: object, projectId?: number, launchId?: string, reason?: (string|null)}}
 *   `kind` is `operator`, `project`, `operator-unverifiable`, or the resolver's
 *   own `unbound`/`invalid`/`master`. `actor` is set for the first two.
 */
function resolveControlCaller(req, resolveAccess = sharedDocsAccess.resolveAccess) {
  const access = resolveAccess(req);
  const gate = req.tcGateState;
  if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
    if (req.tcSession) {
      return { kind: 'operator', actor: { principal: 'operator', operatorProof: 'verified-session' } };
    }
    if (gate === GATE_STATES.OPEN) {
      return { kind: 'operator', actor: { principal: 'operator', operatorProof: 'ambient-open' } };
    }
    return { kind: 'operator-unverifiable', reason: `auth gate is ${gate || 'unknown'} and the request carries no account session` };
  }
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
    const launchId = req.headers[sharedDocsAccess.LAUNCH_HEADER];
    return {
      kind: 'project',
      projectId: access.projectId,
      launchId,
      actor: { principal: `project:${access.projectId}`, launchId }
    };
  }
  if (gate === GATE_STATES.UNREADABLE && _operatorShaped(req)) {
    return { kind: 'operator-unverifiable', reason: 'auth gate state is unreadable' };
  }
  return { kind: access.kind, reason: access.reason || null };
}

module.exports = { resolveControlCaller };
