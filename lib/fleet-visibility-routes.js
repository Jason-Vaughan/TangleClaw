'use strict';

/**
 * The library/route adapter surface for `#2858` (Architect Ruling
 * A503-R1, `Car 66-C`): composed controller functions over
 * `lib/fleet-workload-view.js` (via `lib/workload-fleet.js`'s own
 * `buildFleetView`), `lib/switchboard-swarm-stats.js`,
 * `lib/version-cache-diagnostic.js` (via `lib/project-version-files.js`'s
 * own `getVersionCacheDiagnostic`), and `lib/test-duration-stats.js` --
 * the exact call shapes a future `lib/routes/*.js` handler needs. Mounting
 * these behind a real HTTP route (`server.js`, `lib/routes/sessions.js`,
 * `public/index.html`) is `Milestone #54` per Ruling A503-R1; this module
 * is what that mount will call unchanged.
 *
 * @module lib/fleet-visibility-routes
 */

const fleetWorkloadView = require('./fleet-workload-view');
const swarmStats = require('./switchboard-swarm-stats');
const projectVersionFiles = require('./project-version-files');
const testDurationStats = require('./test-duration-stats');

/**
 * The fleet-wide/project-level workload view (#1923) over a batch of
 * already-fetched session summaries --
 * {@link module:lib/fleet-workload-view.buildFleetWorkloadView}'s own
 * stable call shape for a route. Deliberately over the pure
 * `lib/fleet-workload-view.js` directly, not over the real, store-backed
 * fleet read `lib/workload-fleet.js#buildFleetView` wires this same
 * classification into separately (for its own, already-store-backed
 * callers): a future route supplies its own already-fetched session list,
 * fetched however that route resolves the real store, which keeps this
 * adapter -- and its own test suite -- free of any database dependency.
 * @param {object[]} sessions - As {@link module:lib/fleet-workload-view.buildFleetWorkloadView}'s own `sessions`.
 * @param {object} [options] - As {@link module:lib/fleet-workload-view.buildFleetWorkloadView}'s own `options`.
 * @returns {{ok: true, view: object}|{ok: false, code: string, message: string}}
 */
function getFleetWorkloadView(sessions, options) {
  return fleetWorkloadView.buildFleetWorkloadView(sessions, options);
}

/**
 * @see module:lib/switchboard-swarm-stats.computeSwarmStats
 */
function getSwitchboardSwarmStats(exchanges) {
  return swarmStats.computeSwarmStats(exchanges);
}

/**
 * This process's current version-cache write diagnostic (#1046) for one or
 * more projects, batched -- each project path's own
 * {@link module:lib/project-version-files.getVersionCacheDiagnostic}, keyed by path.
 * @param {string[]} projectPaths
 * @returns {Object<string, ({state: object, banner: (object|null)}|null)>}
 */
function getVersionCacheDiagnostics(projectPaths) {
  const out = {};
  for (const projectPath of projectPaths) {
    out[projectPath] = projectVersionFiles.getVersionCacheDiagnostic(projectPath);
  }
  return out;
}

/**
 * A project's test-duration stats-card projection (#1784): extracts and
 * normalizes the caller's raw recorded duration (when given) and projects
 * the display-ready summary in one call, rather than making every route
 * caller chain `extractTestDuration` into `buildTestDurationStats` itself.
 * @param {object|null} raw - As {@link module:lib/test-duration-stats.extractTestDuration}'s
 *   own `raw`, or `null` for a project with no recorded duration at all.
 * @param {object} [options] - As {@link module:lib/test-duration-stats.buildTestDurationStats}'s own `options`.
 * @returns {{ok: true, stats: object}|{ok: false, code: string, message: string}}
 */
function getProjectTestDurationStats(raw, options) {
  if (raw === null) return { ok: true, stats: testDurationStats.buildTestDurationStats(null, options) };
  const extracted = testDurationStats.extractTestDuration(raw);
  if (!extracted.ok) return extracted;
  return { ok: true, stats: testDurationStats.buildTestDurationStats(extracted.duration, options) };
}

module.exports = {
  getFleetWorkloadView,
  getSwitchboardSwarmStats,
  getVersionCacheDiagnostics,
  getProjectTestDurationStats
};
