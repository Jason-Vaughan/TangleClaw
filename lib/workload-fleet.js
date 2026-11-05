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
 * a lane whose stale receipt was nudged or escalated carries a `nudge` block.
 *
 * @module lib/workload-fleet
 */

const store = require('./store');
const workload = require('./workload');
const compose = require('./workload-compose');
const bridgeNotify = require('./bridge-notify');
const fleetWorkloadView = require('./fleet-workload-view');

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
 * Seconds from a stored time to now, never negative; null for an unreadable time.
 * @param {string|null} ts - A stored timestamp
 * @param {number} nowMs - Clock
 * @returns {number|null}
 */
function _secondsSince(ts, nowMs) {
  const at = compose.parseTime(ts);
  return Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 1000)) : null;
}

/**
 * What the nudge monitor has done about a lane's newest receipt and the lane
 * has not answered (#2262), or null: the nudge, the escalation, or both.
 *
 * Only a stale receipt is asked about: a current one is either a receipt that
 * was never nudged or the answer to a nudge of an older one, and in both cases
 * there is nothing unanswered to show.
 *
 * A lane escalated without a nudge carries `nudgedAt: null` and the reason in
 * `notNudgedReason`. An escalation with nobody to send to is on the operator
 * route: `escalationRoute: 'operator'`, `escalatedTo: null`. Whether the
 * operator was then told is not in that record: `operatorNotice` is the state
 * of the bridge notice raised for it (`ready`, `blocked`, `delivered` or
 * `dropped`), or null when there is none, as when the bridge is off. It is
 * null on every other lane too.
 * @param {object|null} row - The lane's newest receipt row
 * @param {string} provenance - The receipt block's provenance
 * @param {number} nowMs - Clock
 * @returns {{nudgedAt: (string|null), receiptSeq: number, ageSeconds: (number|null),
 *   notNudgedReason: (string|null), escalatedAt: (string|null), escalatedAgeSeconds: (number|null),
 *   escalationRoute: (string|null), escalatedTo: (string|null), operatorNotice: (string|null)}|null}
 */
function _nudgeBlock(row, provenance, nowMs) {
  if (!row || provenance !== 'stale' || !Number.isInteger(row.receipt_id)) return null;
  const facts = store.workloadNudgeFacts.listForReceipt(row.receipt_id);
  const nudged = facts.find((f) => f.kind === 'nudged');
  const escalations = facts.filter((f) => f.kind === 'escalated');
  // A coordinator who was told outranks the operator-route record of the same silence.
  const escalated = escalations.find((f) => f.route === 'coordinator') || escalations[0];
  if (!nudged && !escalated) return null;
  const notNudged = nudged ? null : facts.find((f) => f.kind === 'not-nudged');
  const coordinator = escalated && Number.isInteger(escalated.target_project_id) ? store.projects.get(escalated.target_project_id) : null;
  return {
    nudgedAt: nudged ? nudged.created_at : null,
    receiptSeq: row.seq,
    ageSeconds: nudged ? _secondsSince(nudged.created_at, nowMs) : null,
    notNudgedReason: notNudged ? notNudged.code : null,
    escalatedAt: escalated ? escalated.created_at : null,
    escalatedAgeSeconds: escalated ? _secondsSince(escalated.created_at, nowMs) : null,
    escalationRoute: escalated ? escalated.route : null,
    escalatedTo: coordinator ? coordinator.name : null,
    operatorNotice: escalated && escalated.route === 'operator' ? bridgeNotify.laneSilentNotice(escalated.fact_id) : null
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

/**
 * A workload receipt's `refs` (`{issues: number[], prs: number[], tasks:
 * string[]}`, see `lib/workload.js#toView`) flattened to the single array
 * of display strings {@link module:lib/fleet-workload-view.buildFleetWorkloadView}
 * expects -- the two modules' `refs` shapes never matched, since the
 * receipt's own structured triple predates #1923's flatter view-model field.
 * @param {{issues: number[], prs: number[], tasks: string[]}|null|undefined} refs
 * @returns {string[]}
 */
function _flattenRefs(refs) {
  if (!refs || typeof refs !== 'object') return [];
  const out = [];
  for (const n of refs.issues || []) out.push(`#${n}`);
  for (const n of refs.prs || []) out.push(`PR#${n}`);
  for (const t of refs.tasks || []) out.push(String(t));
  return out;
}

/**
 * Build the fleet-wide/project-level workload view (#1923) over a batch of
 * sessions, wiring each one's already-composed lane
 * ({@link laneFor}/{@link laneContext}) into
 * {@link module:lib/fleet-workload-view.buildFleetWorkloadView}'s own input
 * contract -- the #349 passive-liveness classification this repository's
 * fleet read did not have before, composed here rather than re-derived at
 * every call site.
 *
 * `paneAlive` is read from the session's own `store.SESSION_STATUS`: an
 * ended session's pane/process is categorically gone, independent of
 * whatever its engine last asserted about being busy or at rest (a
 * different, narrower question `lib/activity-observer.js`'s `activity`
 * answers).
 * @param {object[]} sessions - Each a session row (`id`, `projectId`, `projectName`, `status`).
 * @param {object} opts - As {@link laneContext}'s own `opts`, plus:
 * @param {number} [opts.nowMs] - Clock; defaults to `Date.now()`.
 * @param {string} [opts.now] - ISO timestamp; defaults to `new Date(nowMs).toISOString()`.
 * @param {{workingMs?: number, owedMs?: number}} [opts.staleThresholds]
 * @returns {{ok: true, view: object}|{ok: false, code: string, message: string}}
 */
function buildFleetView(sessions, opts) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const now = typeof opts.now === 'string' && opts.now ? opts.now : new Date(nowMs).toISOString();

  const entries = sessions.map((session) => {
    const lane = laneFor(session, { ...opts, nowMs, projectName: session.projectName });
    const receipt = lane.workload.receipt;
    return {
      sessionId: String(session.id),
      project: session.projectName || String(session.projectId),
      workloadState: receipt ? receipt.state : undefined,
      workloadClearance: receipt ? receipt.clearance : undefined,
      summary: receipt ? receipt.summary : undefined,
      refs: receipt ? _flattenRefs(receipt.refs) : undefined,
      branch: receipt ? receipt.branch : undefined,
      headSha: receipt ? receipt.head : undefined,
      updatedAt: receipt ? receipt.receivedAt : undefined,
      lastActivityAt: lane.engine.observedAt,
      paneAlive: session.status === store.SESSION_STATUS.ACTIVE
    };
  });

  return fleetWorkloadView.buildFleetWorkloadView(entries, { now, staleThresholds: opts.staleThresholds });
}

module.exports = { laneFor, laneContext, buildFleetView };
