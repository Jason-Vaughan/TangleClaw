'use strict';

/**
 * Gather a lane's inputs and compose its workload verdict (#1912, ADR 0020
 * §4, §6, §10). The one place that reads the store, the activity observer and
 * the wrap registries for workload; `lib/workload-compose.js` decides.
 *
 * Nothing here captures a pane or runs tmux. The engine block comes from the
 * observer's in-memory cache, so a fleet read costs SQLite reads and nothing
 * more (ADR 0020 §10).
 *
 * @module lib/workload-fleet
 */

const store = require('./store');
const workload = require('./workload');
const compose = require('./workload-compose');

/**
 * The default wrap lookups, required lazily: both registries pull in session
 * machinery that must not load before the store is initialized.
 * @returns {{wrapRun: function(string): object, wrapRequested: function(string): boolean}}
 */
function defaultWrapDeps() {
  return {
    wrapRun: (projectName) => require('./wrap-run-registry').get(projectName),
    wrapRequested: (projectName) => require('./wrap-sentinel').isWrapRequested(projectName)
  };
}

/**
 * The control events that bear on a receipt: those of the receipt's
 * assignment and of the lane's current open assignment.
 * @param {string|null} receiptAssignmentId - The assignment stamped on the receipt
 * @param {object|null} open - The project's open assignment row
 * @returns {Array<{kind: string, createdAt: string}>}
 */
function _controlEvents(receiptAssignmentId, open) {
  const ids = new Set();
  if (receiptAssignmentId) ids.add(receiptAssignmentId);
  if (open) ids.add(open.assignment_id);
  const out = [];
  for (const id of ids) {
    for (const ev of store.control.listEvents(id)) out.push({ kind: ev.kind, createdAt: ev.created_at });
  }
  return out;
}

/**
 * Compose one live project session's lane.
 * @param {object} session - A session (`id`, `projectId`, `status`)
 * @param {object} opts - Dependencies
 * @param {{get: function(number, number=): object}} opts.observer - The activity observer
 * @param {string|null} opts.projectName - The session's project name (for the wrap lookups)
 * @param {number} [opts.nowMs] - Clock
 * @param {object} [opts.wrap] - Wrap lookups (see {@link defaultWrapDeps})
 * @returns {{engine: object, workload: object, composed: object}}
 */
function laneFor(session, { observer, projectName, nowMs = Date.now(), wrap = defaultWrapDeps() }) {
  const engine = observer.get(session.id, nowMs);
  const sequence = store.launchSequences.getBySession(session.id);
  const liveLaunchId = sequence ? sequence.launchId : null;
  const row = liveLaunchId ? store.workloadReceipts.latestForLaunch(liveLaunchId) : null;
  const receipt = workload.toView(row);
  const open = store.control.getOpenForProject(session.projectId);
  const controlState = open && open.bound_launch_id === liveLaunchId ? open.state : null;
  const run = projectName ? wrap.wrapRun(projectName) : null;
  const wrapStartedAtMs = run && run.sessionId === session.id && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const narrowingRow = liveLaunchId ? store.workloadReceipts.activeNarrowing(liveLaunchId) : null;

  const { composed, workload: block } = compose.composeLane({
    receipt,
    sessionActive: session.status === store.SESSION_STATUS.ACTIVE,
    launchLive: Boolean(row && liveLaunchId && row.launch_id === liveLaunchId),
    controlEvents: _controlEvents(receipt ? receipt.assignmentId : null, open),
    wrapStartedAtMs,
    wrapRequested: projectName ? Boolean(wrap.wrapRequested(projectName)) : false,
    controlState,
    engine,
    narrowing: narrowingRow
      ? { capClearance: narrowingRow.cap_clearance === 1, forceUnknown: narrowingRow.force_unknown === 1 }
      : null,
    nowMs
  });
  if (narrowingRow) {
    block.narrowing = {
      capClearance: narrowingRow.cap_clearance === 1,
      forceUnknown: narrowingRow.force_unknown === 1,
      reason: narrowingRow.reason,
      at: narrowingRow.created_at
    };
  }
  return { engine, workload: block, composed };
}

module.exports = { laneFor, defaultWrapDeps };
