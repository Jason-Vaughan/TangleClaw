'use strict';

/**
 * The cross-project version dependency registry (#777, carved out of #577
 * item 4): TangleClaw is the only thing on this machine that knows every
 * managed project's version, and right now a dependent finds out a
 * dependency released a new version only because a human remembers.
 *
 * This module is the registry's logic: validate a declared edge
 * (`dependent` depends on `dependency` within `requiredRange`), evaluate
 * it against actual current versions (`satisfied` / `outdated` /
 * `breaking` / `unknown`), and build the DATA a release notification would
 * carry. It is pure — no filesystem, no database, no network, no sending
 * anything to anyone.
 *
 * The issue's own open questions are answered here only as far as the
 * Architect's ruling scopes this car, and no further:
 *
 * - **Where do edges come from?** Declared, not inferred. Inference
 *   (`package.json`, lockfiles) only works for ecosystems this module
 *   would then have to parse, and the issue itself flags project groups
 *   as a plausible existing home — out of scope either way for this
 *   module, which takes edges as data from whatever a caller supplies.
 * - **What is a notification?** A payload — data describing what changed
 *   and who is affected ({@link buildReleaseNotificationPayloads}) — not
 *   an action. Sending it (a dashboard badge, a session-prime note, an
 *   actual bridge/Medusa message) is a caller's job, in a later car; nothing
 *   here reaches `lib/bridge-notify.js` or any other delivery mechanism.
 * - **Nothing auto-modifies a dependent's checkout.** This module has no
 *   write path to any project's files, full stop — the same boundary #711
 *   and the hooks incidents already drew for this repo.
 *
 * The range grammar is intentionally small (no semver library — this repo
 * takes zero npm dependencies, per `CONTRIBUTING.md`): an exact
 * `MAJOR.MINOR.PATCH`, a caret `^MAJOR.MINOR.PATCH` (same major, at least
 * that minor.patch), or `*` (any version).
 *
 * @module lib/project-version-deps
 */

/** Error for registry/edge input that does not match this module's contract. */
class ProjectVersionDepsError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new ProjectVersionDepsError(msg);
}

/** A dependency edge's evaluated relationship to the dependency's actual current version. */
const DEPENDENCY_STATES = Object.freeze({
  SATISFIED: 'satisfied',
  OUTDATED: 'outdated',
  BREAKING: 'breaking',
  UNKNOWN: 'unknown'
});

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CARET_RANGE_RE = /^\^(\d+\.\d+\.\d+)$/;

function _needSemver(v, where) {
  _need(typeof v === 'string' && SEMVER_RE.test(v), `${where} must be a MAJOR.MINOR.PATCH version string`);
}

/**
 * Parse a `MAJOR.MINOR.PATCH` string into comparable parts.
 * @param {string} v
 * @returns {[number, number, number]}
 */
function _parseSemver(v) {
  return v.split('.').map(Number);
}

/**
 * Three-way compare two semver strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative if `a < b`, positive if `a > b`, 0 if equal.
 */
function compareSemver(a, b) {
  _needSemver(a, 'a');
  _needSemver(b, 'b');
  const pa = _parseSemver(a);
  const pb = _parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Whether a range string is one this module understands.
 * @param {string} range
 * @returns {boolean}
 */
function isValidRange(range) {
  return range === '*' || SEMVER_RE.test(range) || CARET_RANGE_RE.test(range);
}

/**
 * The range's own base version — the one pinned exact version, or a
 * caret range's floor. `null` for `*`, which pins nothing.
 * @param {string} range
 * @returns {string|null}
 */
function _rangeBaseVersion(range) {
  if (range === '*') return null;
  const caret = CARET_RANGE_RE.exec(range);
  return caret ? caret[1] : range;
}

/**
 * Whether a version satisfies a range.
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 * @throws {ProjectVersionDepsError} On an unrecognized range.
 */
function satisfiesRange(version, range) {
  _needSemver(version, 'version');
  _need(isValidRange(range), `range "${range}" is not one of: an exact version, a ^-prefixed caret range, or "*"`);
  if (range === '*') return true;
  const caret = CARET_RANGE_RE.exec(range);
  if (caret) {
    const req = _parseSemver(caret[1]);
    const v = _parseSemver(version);
    if (v[0] !== req[0]) return false;
    return compareSemver(version, caret[1]) >= 0;
  }
  return compareSemver(version, range) === 0;
}

/**
 * Validate one dependency edge's shape.
 * @param {*} edge
 * @param {string} [where]
 * @returns {void}
 */
function validateEdge(edge, where = 'edge') {
  _need(edge !== null && typeof edge === 'object' && !Array.isArray(edge), `${where} must be an object`);
  const allowed = new Set(['dependent', 'dependency', 'requiredRange']);
  for (const key of Object.keys(edge)) _need(allowed.has(key), `${where} has unknown key "${String(key).slice(0, 40)}"`);
  for (const key of allowed) _need(edge[key] !== undefined, `${where}.${key} is missing`);
  _need(typeof edge.dependent === 'string' && edge.dependent.length > 0, `${where}.dependent must be a non-empty string`);
  _need(typeof edge.dependency === 'string' && edge.dependency.length > 0, `${where}.dependency must be a non-empty string`);
  _need(edge.dependent !== edge.dependency, `${where}.dependent and ${where}.dependency must not be the same project`);
  _need(isValidRange(edge.requiredRange), `${where}.requiredRange must be an exact version, a ^-prefixed caret range, or "*" (got ${JSON.stringify(edge.requiredRange)})`);
}

/**
 * Validate a whole registry: every edge, and no two edges for the same
 * ordered `(dependent, dependency)` pair.
 * @param {*} edges
 * @returns {void}
 * @throws {ProjectVersionDepsError}
 */
function validateRegistry(edges) {
  _need(Array.isArray(edges), 'edges must be an array');
  const seen = new Set();
  edges.forEach((edge, i) => {
    validateEdge(edge, `edges[${i}]`);
    const key = `${edge.dependent}\u0000${edge.dependency}`;
    _need(!seen.has(key), `edges[${i}] repeats the pair (dependent "${edge.dependent}", dependency "${edge.dependency}")`);
    seen.add(key);
  });
}

/**
 * Evaluate one edge against the actual current versions known.
 * @param {{dependent: string, dependency: string, requiredRange: string}} edge
 * @param {Object<string, string>} currentVersions - Project name → its current version.
 * @returns {{dependent: string, dependency: string, requiredRange: string, state: string, dependencyVersion: (string|null), reason?: string}}
 */
function evaluateEdge(edge, currentVersions) {
  validateEdge(edge);
  _need(currentVersions !== null && typeof currentVersions === 'object', 'currentVersions must be an object');
  const actual = currentVersions[edge.dependency];
  const base = { dependent: edge.dependent, dependency: edge.dependency, requiredRange: edge.requiredRange };
  if (actual === undefined) {
    return { ...base, state: DEPENDENCY_STATES.UNKNOWN, dependencyVersion: null, reason: `no known version for "${edge.dependency}"` };
  }
  if (satisfiesRange(actual, edge.requiredRange)) {
    return { ...base, state: DEPENDENCY_STATES.SATISFIED, dependencyVersion: actual };
  }
  const requiredBase = _rangeBaseVersion(edge.requiredRange);
  const state = requiredBase !== null && compareSemver(actual, requiredBase) > 0
    ? DEPENDENCY_STATES.BREAKING
    : DEPENDENCY_STATES.OUTDATED;
  return { ...base, state, dependencyVersion: actual };
}

/**
 * {@link evaluateEdge}, for every edge in a registry.
 * @param {Array<object>} edges
 * @param {Object<string, string>} currentVersions
 * @returns {Array<object>}
 */
function evaluateRegistry(edges, currentVersions) {
  return edges.map((edge) => evaluateEdge(edge, currentVersions));
}

/**
 * Every edge naming a project as its dependency — who would be affected
 * if that project released.
 * @param {Array<object>} edges
 * @param {string} projectName
 * @returns {Array<object>}
 */
function dependentsOf(edges, projectName) {
  return edges.filter((e) => e.dependency === projectName);
}

/**
 * Build the notification DATA for a project's release — never sends
 * anything; a caller decides whether and how. One payload per affected
 * dependent, naming whether the release changed that edge's state (a
 * dependent already satisfied by both the old and new version is still
 * reported, with `changed: false`, so a caller can choose to notify only
 * on change).
 * @param {Array<object>} edges - A validated registry.
 * @param {object} o
 * @param {string} o.project - The project that released.
 * @param {string} o.previousVersion
 * @param {string} o.newVersion
 * @returns {Array<{dependent: string, dependency: string, requiredRange: string, previousVersion: string, newVersion: string, stateBefore: string, stateAfter: string, changed: boolean, message: string}>}
 */
function buildReleaseNotificationPayloads(edges, { project, previousVersion, newVersion }) {
  _need(typeof project === 'string' && project.length > 0, 'project must be a non-empty string');
  _needSemver(previousVersion, 'previousVersion');
  _needSemver(newVersion, 'newVersion');
  return dependentsOf(edges, project).map((edge) => {
    const before = evaluateEdge(edge, { [project]: previousVersion });
    const after = evaluateEdge(edge, { [project]: newVersion });
    return {
      dependent: edge.dependent,
      dependency: project,
      requiredRange: edge.requiredRange,
      previousVersion,
      newVersion,
      stateBefore: before.state,
      stateAfter: after.state,
      changed: before.state !== after.state,
      message: `${project} released ${newVersion} (was ${previousVersion}); ${edge.dependent} requires ${edge.requiredRange} and is now ${after.state}`
    };
  });
}

module.exports = {
  ProjectVersionDepsError,
  DEPENDENCY_STATES,
  compareSemver,
  isValidRange,
  satisfiesRange,
  validateEdge,
  validateRegistry,
  evaluateEdge,
  evaluateRegistry,
  dependentsOf,
  buildReleaseNotificationPayloads
};
