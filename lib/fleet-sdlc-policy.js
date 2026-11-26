'use strict';

/**
 * Configurable per-fleet SDLC workflow enforcement (#3265, V6-016).
 *
 * TangleClaw's own development is governed by GitHub Issues + the Public
 * Roadmap + `LANE_QUEUE.md` cars/trains — but not every fleet TangleClaw
 * manages works that way (a TangleVision creative studio or a local
 * research fleet has no GitHub issue tracker to triage into). This module
 * makes that governance a per-fleet policy rather than a hard-coded
 * assumption, in the same self-contained, plain-objects-in/plain-objects-out
 * shape `lib/roadmap-admission.js` already uses for train admission: it
 * never reads `.tangleclaw/project.json`, calls GitHub, or touches a route
 * itself — the caller resolves a project's config and a car's real,
 * already-fetched issue state, and this module turns that into one of a
 * small number of machine-readable verdicts.
 *
 * `issueBackend`:
 *   - `"github"` — every dispatched car must reference tracked GitHub
 *     issue(s); when `requireRoadmapTriage` is set, those issues must also
 *     be triaged into the active milestone/roadmap wave (as `TC-Lane` is).
 *   - `"local"` — a car must still name at least one tracked reference, but
 *     it need not be a GitHub issue and no roadmap-triage check applies.
 *   - `"none"` — no issue-tracking gate at all.
 *
 * @module lib/fleet-sdlc-policy
 */

/** Error for policy input that does not match this module's contract. */
class FleetSdlcPolicyError extends Error {}

/** The three recognized issue-tracking backends (issue #3265's own naming). */
const ISSUE_BACKENDS = Object.freeze(['github', 'local', 'none']);

/**
 * The default policy a fleet runs under when it has not configured one —
 * TangleClaw's own practice (`TC-Lane`), since that is what every fleet
 * historically did before this module gave it a name.
 */
const DEFAULT_FLEET_SDLC_POLICY = Object.freeze({
  issueBackend: 'github',
  requireRoadmapTriage: true
});

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond
 * @param {string} msg
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new FleetSdlcPolicyError(msg);
}

/**
 * Whether `v` is a valid issue reference: a non-empty (non-blank) string, or
 * a positive integer. Rejects `''`, `null`, `0`, `NaN`, and non-string/number
 * values outright, so a malformed reference can never silently pass an
 * admission check that counts it.
 * @param {*} v
 * @returns {boolean}
 */
function _isValidIssueRef(v) {
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0;
  return false;
}

/**
 * Validate a policy-shaped object's own fields are internally well-formed.
 * Does not apply defaults or precedence — see {@link resolveFleetSdlcPolicy}.
 * @param {object} policy
 * @returns {void}
 * @throws {FleetSdlcPolicyError}
 */
function validateFleetSdlcPolicy(policy) {
  _need(policy !== null && typeof policy === 'object' && !Array.isArray(policy), 'policy must be an object');
  _need(ISSUE_BACKENDS.includes(policy.issueBackend), `policy.issueBackend must be one of ${ISSUE_BACKENDS.join(', ')}`);
  _need(typeof policy.requireRoadmapTriage === 'boolean', 'policy.requireRoadmapTriage must be a boolean');
}

/**
 * Resolve the effective policy for a fleet/project: an explicit caller
 * override, then a `fleetSdlcPolicy` field on the project config object the
 * caller supplies (read however that caller likes — this module never reads
 * `.tangleclaw/project.json` itself), then {@link DEFAULT_FLEET_SDLC_POLICY}.
 * An unrecognized or malformed value at any source falls back to the
 * default with a warning rather than throwing — a typo in a config file
 * should never crash a dispatch — mirroring
 * `lib/wrap-steps/pr-merge.js#resolveWrapMergeMethod`'s own precedence shape.
 * @param {object} [projectConfig] - A plain object that MAY carry a
 *   `fleetSdlcPolicy` field; typically a loaded `.tangleclaw/project.json`,
 *   but this module does not care where it came from.
 * @param {object} [options]
 * @param {object} [options.fleetSdlcPolicy] - Explicit override, checked first.
 * @returns {{policy: {issueBackend: string, requireRoadmapTriage: boolean}, source: ('explicit'|'project-config'|'default'), warning: (string|null)}}
 */
function resolveFleetSdlcPolicy(projectConfig, options = {}) {
  const explicit = options.fleetSdlcPolicy;
  if (explicit !== undefined && explicit !== null) {
    try {
      validateFleetSdlcPolicy(explicit);
      return { policy: { issueBackend: explicit.issueBackend, requireRoadmapTriage: explicit.requireRoadmapTriage }, source: 'explicit', warning: null };
    } catch (err) {
      return {
        policy: { ...DEFAULT_FLEET_SDLC_POLICY },
        source: 'default',
        warning: `invalid explicit fleetSdlcPolicy (${err.message}) — falling back to the default policy`
      };
    }
  }

  const configured = projectConfig && projectConfig.fleetSdlcPolicy;
  if (configured !== undefined && configured !== null) {
    try {
      validateFleetSdlcPolicy(configured);
      return { policy: { issueBackend: configured.issueBackend, requireRoadmapTriage: configured.requireRoadmapTriage }, source: 'project-config', warning: null };
    } catch (err) {
      return {
        policy: { ...DEFAULT_FLEET_SDLC_POLICY },
        source: 'default',
        warning: `unrecognized fleetSdlcPolicy in .tangleclaw/project.json (${err.message}) — falling back to the default policy`
      };
    }
  }

  return { policy: { ...DEFAULT_FLEET_SDLC_POLICY }, source: 'default', warning: null };
}

/**
 * A dispatched car's own, already-known facts — never fetched by this
 * module. `issues` is the car's full issue list; `triagedIssues` is the
 * subset of those the caller has already confirmed (by whatever means it
 * uses — a Roadmap Board read, a GitHub milestone query) are triaged into
 * the active milestone/wave.
 * @typedef {object} FleetSdlcCar
 * @property {string[]} issues
 * @property {string[]} [triagedIssues]
 */

/**
 * Evaluate whether a dispatched car is admissible under a resolved policy
 * (issue #3265 acceptance criterion 2). Returns every reason it is not,
 * rather than stopping at the first, so a caller can report a complete
 * picture in one pass.
 * @param {{issueBackend: string, requireRoadmapTriage: boolean}} policy - As returned by {@link resolveFleetSdlcPolicy}.
 * @param {FleetSdlcCar} car
 * @returns {{admitted: boolean, reasons: string[]}}
 */
function evaluateCarAdmission(policy, car) {
  validateFleetSdlcPolicy(policy);
  _need(car !== null && typeof car === 'object' && !Array.isArray(car), 'car must be an object');
  _need(Array.isArray(car.issues), 'car.issues must be an array');
  const badIssues = car.issues.filter((issue) => !_isValidIssueRef(issue));
  _need(badIssues.length === 0, `car.issues must contain only non-empty strings or positive integers, got: ${badIssues.map((v) => JSON.stringify(v)).join(', ')}`);

  if (policy.issueBackend === 'none') {
    return { admitted: true, reasons: [] };
  }

  const reasons = [];
  if (car.issues.length === 0) {
    reasons.push(`no tracked issue(s) referenced, but issueBackend is "${policy.issueBackend}"`);
  }

  if (policy.issueBackend === 'github' && policy.requireRoadmapTriage && car.issues.length > 0) {
    const triaged = new Set(Array.isArray(car.triagedIssues) ? car.triagedIssues : []);
    const untriaged = car.issues.filter((issue) => !triaged.has(issue));
    if (untriaged.length > 0) {
      reasons.push(`issue(s) not triaged into the active milestone/roadmap wave: ${untriaged.join(', ')}`);
    }
  }

  return { admitted: reasons.length === 0, reasons };
}

module.exports = {
  FleetSdlcPolicyError,
  ISSUE_BACKENDS,
  DEFAULT_FLEET_SDLC_POLICY,
  validateFleetSdlcPolicy,
  resolveFleetSdlcPolicy,
  evaluateCarAdmission
};
