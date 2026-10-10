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
 * It is also the one reader of the workload nudge record for display (#2262):
 * a lane whose stale receipt was nudged carries a `nudge` block.
 *
 * @module lib/workload-fleet
 */

const store = require('./store');
const workload = require('./workload');
const compose = require('./workload-compose');

/**
 * The default wrap lookups, required lazily: both registries pull in session
 * machinery that must not load before the store is initialized.
 * @returns {{wrapRun: function(string): object}}
 */
function defaultWrapDeps() {
  return {
    wrapRun: (projectName) => require('./wrap-run-registry').get(projectName)
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
 * The nudge a lane's newest receipt has had and not answered (#2262), or null.
 *
 * Only a stale receipt is asked about: a current one is either a receipt that
 * was never nudged or the answer to a nudge of an older one, and in both cases
 * there is nothing unanswered to show.
 * @param {object|null} row - The lane's newest receipt row
 * @param {string} provenance - The receipt block's provenance
 * @param {number} nowMs - Clock
 * @returns {{nudgedAt: string, receiptSeq: number, ageSeconds: (number|null)}|null}
 */
function _nudgeBlock(row, provenance, nowMs) {
  if (!row || provenance !== 'stale' || !Number.isInteger(row.receipt_id)) return null;
  const fact = store.workloadNudgeFacts.listForReceipt(row.receipt_id).find((f) => f.kind === 'nudged');
  if (!fact) return null;
  const at = compose.parseTime(fact.created_at);
  return {
    nudgedAt: fact.created_at,
    receiptSeq: row.seq,
    ageSeconds: Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 1000)) : null
  };
}

/**
 * Compose one live project session's lane.
 * @param {object} session - A session (`id`, `projectId`, `status`)
 * @param {object} opts - Dependencies
 * @param {{get: function(number, number=): object}} opts.observer - The activity observer
 * @param {string|null} opts.projectName - The session's project name (for the wrap lookups)
 * @param {number} [opts.nowMs] - Clock
 * @param {object} [opts.wrap] - Wrap lookups (see {@link defaultWrapDeps})
 * @returns {{engine: object, workload: object, composed: object, nudge: (object|null)}}
 */
function laneFor(session, opts) {
  return laneContext(session, opts).lane;
}

/**
 * A lane as {@link laneFor} composes it, with the two row identities a caller
 * that records against the receipt needs. They stay out of the lane itself:
 * the lane is what the fleet read returns, and a row id is no part of that.
 * @param {object} session - A session (`id`, `projectId`, `status`)
 * @param {object} opts - As {@link laneFor}
 * @returns {{lane: object, receiptId: (number|null), launchId: (string|null)}} `receiptId` is the
 *   lane's newest receipt of its live launch, `launchId` that launch; each null when there is none
 */
function laneContext(session, { observer, projectName, nowMs = Date.now(), wrap = defaultWrapDeps() }) {
  const engine = observer.get(session.id, nowMs);
  const sequence = store.launchSequences.getBySession(session.id);
  const liveLaunchId = sequence ? sequence.launchId : null;
  const row = liveLaunchId ? store.workloadReceipts.latestForLaunch(liveLaunchId) : null;
  const receipt = workload.toView(row);
  const open = store.control.getOpenForProject(session.projectId);
  // The project's open assignment governs the lane whatever its binding says:
  // a rebind that failed, or an assignment made before this launch, must not
  // let a held or stopped project read AVAILABLE (control verdicts are hard).
  const controlState = open ? open.state : null;
  const run = projectName ? wrap.wrapRun(projectName) : null;
  const wrapStartedAtMs = run && run.sessionId === session.id && Number.isFinite(run.startedAt) ? run.startedAt : null;
  const narrowingRow = liveLaunchId ? store.workloadReceipts.activeNarrowing(liveLaunchId) : null;

  const { composed, workload: block } = compose.composeLane({
    receipt,
    sessionActive: session.status === store.SESSION_STATUS.ACTIVE,
    launchLive: Boolean(row && liveLaunchId && row.launch_id === liveLaunchId),
    controlEvents: _controlEvents(receipt ? receipt.assignmentId : null, open),
    wrapStartedAtMs,
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
  return {
    lane: { engine, workload: block, composed, nudge: _nudgeBlock(row, block.provenance, nowMs) },
    receiptId: row ? row.receipt_id : null,
    launchId: liveLaunchId
  };
}

module.exports = { laneFor, laneContext, defaultWrapDeps };
