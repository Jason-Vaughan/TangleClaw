'use strict';

/**
 * Passive per-session idle/wedged classification (#349, Architect Ruling
 * A349) and the fleet-wide/project-level workload view model built on top
 * of it (#1923, Architect Ruling A1923) -- core engine, `v5.60.0` Car 60-C
 * Slice 1, co-hosted in one file per both rulings' own "Authorized Files"
 * envelope.
 *
 * A pure projection library: every function takes the caller's
 * already-fetched session facts (a workload receipt's own `state`/
 * `clearance`, an observed pane/process heartbeat, switchboard debt) as
 * plain data and returns a computed classification or view model --
 * nothing here reads the store, probes a pane, or sends a message. Wiring
 * this into the real fleet read (`lib/workload-fleet.js`,
 * `server.js`/`lib/routes/*.js`) and landing-page/Master-fleet-view DOM
 * rendering (`public/app.js`, `public/index.html`) is Slice 2, deliberately
 * deferred so Car 60-C stays 100% file-disjoint from this wave's other
 * `v5.60.0` cars.
 *
 * This is deliberately a DIFFERENT, narrower vocabulary from
 * `lib/workload-compose.js#AVAILABILITY` (`UNKNOWN`/`STOPPED`/`HELD`/
 * `WORKING`/`WAITING`/`BLOCKED`/`AVAILABLE`/`COMPLETE_NOT_CLEAR`), which
 * governs dispatch eligibility and already folds in control events and
 * receipt expiry. A349 names its own four-state passive liveness indicator
 * for the landing page specifically, so this module does not re-skin that
 * enum -- it reuses `lib/workload.js`'s own `STATES`/`CLEARANCES` for the
 * *asserted* workload fields it reads, and adds its own `SESSION_STATES`
 * on top for the thing A349 actually asks for: "is this session stuck",
 * not "may this lane be dispatched to".
 *
 * @module lib/fleet-workload-view
 */

const workload = require('./workload');

/** The passive liveness/progress states this module classifies into (#349). */
const SESSION_STATES = Object.freeze(['active', 'idle', 'wedged', 'offline']);

/**
 * Default staleness thresholds before a `working` declaration or an owed
 * switchboard debt counts as "no recent activity" (#349's own "configurable
 * staleness thresholds", left to this module to default since the ruling
 * names the concept, not the number -- chosen to match `tc workload set`'s
 * own 30-minute `working` re-report cadence, `CLAUDE.md`'s "Report your
 * workload" rule).
 * @type {Readonly<{workingMs: number, owedMs: number}>}
 */
const DEFAULT_STALE_THRESHOLDS = Object.freeze({ workingMs: 30 * 60 * 1000, owedMs: 30 * 60 * 1000 });

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Epoch ms from an ISO timestamp, or `null` when absent/unparseable.
 * @param {string|null|undefined} iso
 * @returns {number|null}
 */
function _epoch(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Classify one session's passive liveness/progress state (#349) from its
 * asserted workload fields, observed activity, switchboard debt, and
 * whether its pane/process is alive -- without probing or mutating the
 * session itself; every input is the caller's own already-observed fact.
 *
 * Decision order, most certain signal first:
 * 1. A dead pane/process is `offline`, regardless of what it last asserted.
 * 2. A `working` declaration or any owed message held past its own
 *    staleness threshold with no recent activity is `wedged` -- the session
 *    said it was doing something (or owes a reply) and has gone quiet.
 * 3. A `complete`/`unknown`-clearance session with zero owed messages is
 *    `idle` -- nothing left for it to do, nothing it owes anyone.
 * 4. Anything else alive and not stale is `active`.
 *
 * A session with no workload receipt at all (`workloadState` absent) is
 * treated as `active` while its pane is alive and it owes nothing -- a
 * scoping decision, since neither ruling says what a session that has
 * never reported should read as; "no evidence of being stuck" is the
 * conservative default, not an idle/wedged label with nothing to support it.
 * @param {object} input
 * @param {string|null} [input.workloadState] - One of {@link workload.STATES}, or absent
 * @param {string|null} [input.workloadClearance] - One of {@link workload.CLEARANCES}, or absent
 * @param {string|null} [input.lastActivityAt] - ISO timestamp of last observed activity
 * @param {number} [input.owedMessageCount] - Switchboard messages this session owes a reply to
 * @param {boolean} input.paneAlive - Whether the session's pane/process is observed alive
 * @param {string} input.now - ISO timestamp, the caller's own clock
 * @param {{workingMs?: number, owedMs?: number}} [input.staleThresholds]
 * @returns {{ok: true, result: {state: string, reasons: string[]}}|{ok: false, code: string, message: string}}
 */
function classifySessionState(input) {
  if (!input || typeof input !== 'object') {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', 'input must be an object.');
  }
  if (typeof input.paneAlive !== 'boolean') {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', 'input.paneAlive must be a boolean.');
  }
  if (typeof input.now !== 'string' || !input.now) {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', 'input.now must be an ISO timestamp string.');
  }
  if (input.workloadState !== undefined && input.workloadState !== null && !workload.STATES.includes(input.workloadState)) {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', `"${input.workloadState}" is not a recognized workload state.`);
  }
  if (input.workloadClearance !== undefined && input.workloadClearance !== null && !workload.CLEARANCES.includes(input.workloadClearance)) {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', `"${input.workloadClearance}" is not a recognized workload clearance.`);
  }

  const nowMs = _epoch(input.now);
  if (nowMs === null) {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', 'input.now is not a parseable timestamp.');
  }
  const owed = typeof input.owedMessageCount === 'number' && input.owedMessageCount > 0 ? input.owedMessageCount : 0;
  const lastActivityMs = _epoch(input.lastActivityAt);
  const ageMs = lastActivityMs === null ? Infinity : Math.max(0, nowMs - lastActivityMs);
  const thresholds = { ...DEFAULT_STALE_THRESHOLDS, ...(input.staleThresholds || {}) };

  if (!input.paneAlive) {
    return { ok: true, result: { state: 'offline', reasons: ['pane/process is not alive'] } };
  }

  const reasons = [];
  if (input.workloadState === 'working' && ageMs > thresholds.workingMs) {
    reasons.push(`declared "working" with no activity for ${ageMs}ms (threshold ${thresholds.workingMs}ms)`);
  }
  if (owed > 0 && ageMs > thresholds.owedMs) {
    reasons.push(`owes ${owed} switchboard message(s) with no activity for ${ageMs}ms (threshold ${thresholds.owedMs}ms)`);
  }
  if (reasons.length > 0) {
    return { ok: true, result: { state: 'wedged', reasons } };
  }

  if (input.workloadState === 'complete' && owed === 0) {
    return { ok: true, result: { state: 'idle', reasons: ['workload complete, no owed messages'] } };
  }
  if ((input.workloadState === undefined || input.workloadState === null) && owed === 0) {
    return { ok: true, result: { state: 'active', reasons: ['no workload receipt yet, pane alive, nothing owed'] } };
  }

  return { ok: true, result: { state: 'active', reasons: [] } };
}

/**
 * Tally a list of per-session view rows by one of their own fields, over a
 * fixed, caller-given vocabulary -- every key present with at least `0`,
 * never a sparse object a renderer has to guess-fill.
 * @param {object[]} rows
 * @param {string} field
 * @param {ReadonlyArray<string>} vocabulary
 * @returns {Record<string, number>}
 */
function _tally(rows, field, vocabulary) {
  const counts = {};
  for (const key of vocabulary) counts[key] = 0;
  for (const row of rows) {
    const value = row[field];
    if (Object.prototype.hasOwnProperty.call(counts, value)) counts[value] += 1;
  }
  return counts;
}

/**
 * One project's (or the whole fleet's) slice of the workload view: its own
 * sessions plus the same shape of counts the top-level view carries.
 * @param {object[]} rows
 * @returns {object}
 */
function _summarize(rows) {
  return {
    sessions: rows,
    countsByState: _tally(rows, 'passiveState', SESSION_STATES),
    countsByClearance: _tally(rows, 'workloadClearance', workload.CLEARANCES),
    safeToClearCount: rows.filter((r) => r.workloadClearance === 'safe-to-clear').length,
    doNotClearCount: rows.filter((r) => r.workloadClearance === 'do-not-clear').length,
    wedgedCount: rows.filter((r) => r.passiveState === 'wedged').length
  };
}

/**
 * Build a deterministic, project-level AND fleet-wide workload view model
 * (#1923) by classifying each session's passive state (#349) and
 * aggregating per-session workload declarations into counts a landing page
 * or the Master fleet view can render directly, with no further derivation.
 * @param {object[]} sessions - Each: `{sessionId, project, workloadState?,
 *   workloadClearance?, summary?, refs?, branch?, headSha?, updatedAt?,
 *   lastActivityAt?, owedMessageCount?, paneAlive}`
 * @param {object} [options]
 * @param {string} [options.now] - ISO timestamp; defaults to `new Date().toISOString()`
 * @param {{workingMs?: number, owedMs?: number}} [options.staleThresholds]
 * @returns {{ok: true, view: object}|{ok: false, code: string, message: string}}
 */
function buildFleetWorkloadView(sessions, options = {}) {
  if (!Array.isArray(sessions)) {
    return _refuse('FLEET_WORKLOAD_VIEW_INVALID', 'sessions must be an array.');
  }
  const now = typeof options.now === 'string' && options.now ? options.now : new Date().toISOString();

  const rows = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string' || !s.sessionId) {
      return _refuse('FLEET_WORKLOAD_VIEW_INVALID', `sessions[${i}] has no "sessionId".`);
    }
    if (typeof s.project !== 'string' || !s.project) {
      return _refuse('FLEET_WORKLOAD_VIEW_INVALID', `sessions[${i}] has no "project".`);
    }
    const classified = classifySessionState({
      workloadState: s.workloadState, workloadClearance: s.workloadClearance,
      lastActivityAt: s.lastActivityAt, owedMessageCount: s.owedMessageCount,
      paneAlive: s.paneAlive !== false, now, staleThresholds: options.staleThresholds
    });
    if (!classified.ok) return classified;
    rows.push({
      sessionId: s.sessionId, project: s.project,
      workloadState: s.workloadState || null, workloadClearance: s.workloadClearance || null,
      summary: typeof s.summary === 'string' ? s.summary : null,
      refs: Array.isArray(s.refs) ? s.refs : [],
      branch: typeof s.branch === 'string' ? s.branch : null,
      headSha: typeof s.headSha === 'string' ? s.headSha : null,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null,
      passiveState: classified.result.state,
      passiveStateReasons: classified.result.reasons
    });
  }

  const byProject = new Map();
  for (const row of rows) {
    if (!byProject.has(row.project)) byProject.set(row.project, []);
    byProject.get(row.project).push(row);
  }
  const projects = {};
  for (const [project, projectRows] of byProject) {
    projects[project] = _summarize(projectRows);
  }

  return { ok: true, view: { ..._summarize(rows), projects } };
}

module.exports = {
  SESSION_STATES,
  DEFAULT_STALE_THRESHOLDS,
  classifySessionState,
  buildFleetWorkloadView
};
