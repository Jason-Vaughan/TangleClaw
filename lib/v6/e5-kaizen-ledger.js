'use strict';

/**
 * v6 Stage 1 (#2980, V6-07 / E5, BRIDGE-1b): the Closed-Loop Kaizen Ledger
 * service — `kaizen_items`/`kaizen_measurements` lifecycle, 4-Class
 * Evidence-Based Verification, and the non-binding Gate 0 planning feed.
 *
 * The DDL lives in `lib/store/_schema.js#_v6E5KaizenLedgerDdl`, not here —
 * this module only ever receives an already-migrated `db`. Its exact shape
 * (10 mandatory attributes, `lifecycle_state`'s TitleCase vocabulary, the
 * separate `effectiveness_status` column, `gate0_disposition`) is Architect
 * Ruling A531-W1D-KAIZEN-C1-DDL-COSIGN (2026-11-10) — no DDL bundle for this
 * table exists anywhere in the fleet's plans; that ruling is the only
 * binding spec, and this module implements it verbatim, not a design of
 * its own.
 *
 * `{ok, code}` returns, `crypto.randomUUID()` ids, injectable `now`/`newId`
 * — the same house style `lib/v6/c1-logical-projects.js`/`authority-
 * service.js`/`transition-ledger.js` already share.
 *
 * Per the directive the Conflict Register itself records ("don't make
 * three consecutive clean sprints an absolute requirement before declaring
 * an improvement effective; use evidence-based verification appropriate to
 * the finding"), `canMarkProvenEffective` is the ONE place the four
 * class-specific proof rules live — a single-row CHECK/trigger cannot
 * express Class B/D's "read several `kaizen_measurements` rows together"
 * requirement, so this is a library function, not a DB constraint.
 *
 * `lib/sprint-charter-compiler.js`'s Gate 0 requirement ("fail charter
 * validation if open/due kaizen_items are not explicitly dispositioned") is
 * a DIFFERENT car (#2126) that reads `gate0Feed`'s output; this module
 * supplies the feed and the `setGate0Disposition` write, never the charter
 * compiler's own refusal logic.
 *
 * @module lib/v6/e5-kaizen-ledger
 */

const crypto = require('node:crypto');

const DEFECT_CATEGORY_MAX = 80;
const VERIFICATION_CLASSES = ['A_DETERMINISTIC', 'B_WORKFLOW', 'C_OPERATIONAL_DRILL', 'D_LONGITUDINAL'];
/** `lifecycle_state`'s exact TitleCase vocabulary (Architect Ruling A531), in lifecycle order. */
const LIFECYCLE_STATES = ['Detected', 'Classified', 'Proposed', 'Approved', 'Dismissed', 'Assigned', 'Implemented', 'Verified', 'Effectiveness Measured', 'Closed'];
const EFFECTIVENESS_STATUSES = ['UNVERIFIED', 'IMPLEMENTATION_VERIFIED', 'PROVEN_EFFECTIVE', 'REGRESSED', 'DISMISSED'];
const GATE0_DISPOSITIONS = ['unreviewed', 'scheduled', 'monitoring', 'deferred_with_rationale'];
const MEASUREMENT_KINDS = ['regression_test', 'sprint_window', 'chaos_drill', 'passive_monitor', 'statistical_trend'];

/**
 * Every valid `lifecycle_state` edge `advanceLifecycle` itself may apply;
 * `Dismissed` is a terminal dead-end off the `Proposed` fork, never
 * re-entered. Deliberately EXCLUDES `Verified>Effectiveness Measured` and
 * `Effectiveness Measured>Closed` (Architect Ruling
 * A535-PR3009-R1-HOLD-RECONCILED, PRR-B R1) — those two transitions are
 * gated behind {@link markProvenEffective}'s 4-Class proof rules and
 * {@link closeItem}'s own precondition respectively; routing them through
 * this generic function would let a caller reach either state without
 * ever satisfying the check that owns it.
 */
const LIFECYCLE_EDGES = new Set([
  'Detected>Classified', 'Classified>Proposed', 'Proposed>Approved', 'Proposed>Dismissed',
  'Approved>Assigned', 'Assigned>Implemented', 'Implemented>Verified'
]);

const NON_BLANK = (s, max = 4000) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= max;

/** `lifecycle_state` values a fix must have reached before `recordMeasurement` accepts an effectiveness measurement against it (PRR-B R3, PR #3009). */
const POST_IMPLEMENTATION_STATES = ['Implemented', 'Verified', 'Effectiveness Measured'];

/**
 * Detect a new finding (`lifecycle_state: 'Detected'`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{originSprint: string, findingId: string, defectCategory: string, rootCause: string,
 *   originEvidenceRefs?: string[], correctiveActionSpec: string, ownerRole: string, ownerLane?: string,
 *   linkedIssueId?: number, linkedPrId?: number, linkedRuleId?: string, verificationClass: string,
 *   targetMetric: string, logicalProjectId?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function detectItem(db, {
  originSprint, findingId, defectCategory, rootCause, originEvidenceRefs = [], correctiveActionSpec,
  ownerRole, ownerLane = null, linkedIssueId = null, linkedPrId = null, linkedRuleId = null,
  verificationClass, targetMetric, logicalProjectId = null, now = () => new Date().toISOString(), newId = crypto.randomUUID
}) {
  if (!NON_BLANK(originSprint, 40) || !NON_BLANK(findingId, 80) || !NON_BLANK(defectCategory, DEFECT_CATEGORY_MAX) ||
    !NON_BLANK(rootCause) || !NON_BLANK(correctiveActionSpec) || !NON_BLANK(ownerRole, 80) ||
    !VERIFICATION_CLASSES.includes(verificationClass) || !NON_BLANK(targetMetric) || !Array.isArray(originEvidenceRefs)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const id = newId();
  db.prepare(
    `INSERT INTO kaizen_items (
      id, origin_sprint, finding_id, defect_category, root_cause, origin_evidence_refs_json,
      corrective_action_spec, owner_role, owner_lane, linked_issue_id, linked_pr_id, linked_rule_id,
      verification_class, target_metric, lifecycle_state, effectiveness_status, gate0_disposition,
      logical_project_id, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, originSprint, findingId, defectCategory, rootCause, JSON.stringify(originEvidenceRefs),
    correctiveActionSpec, ownerRole, ownerLane, linkedIssueId, linkedPrId, linkedRuleId,
    verificationClass, targetMetric, 'Detected', 'UNVERIFIED', 'unreviewed',
    logicalProjectId, now(), now()
  );
  return { ok: true, code: 'DETECTED', id };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {object|undefined}
 */
function getItem(db, id) {
  return db.prepare('SELECT * FROM kaizen_items WHERE id = ?').get(id);
}

/**
 * Advance `lifecycle_state` along an explicit, validated edge — an unlisted
 * transition (including re-entering `Dismissed`'s dead end) is refused.
 * `nextState: 'Effectiveness Measured'` and `nextState: 'Closed'` are
 * ALWAYS refused here (`INVALID_TRANSITION`) — call
 * {@link markProvenEffective} and {@link closeItem} instead; this function
 * deliberately cannot reach either state, so no caller can bypass their
 * gating by going through the generic edge table.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, nextState: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function advanceLifecycle(db, { id, nextState, now = () => new Date().toISOString() }) {
  if (!LIFECYCLE_STATES.includes(nextState)) return { ok: false, code: 'INVALID_REQUEST' };
  const item = getItem(db, id);
  if (!item) return { ok: false, code: 'NOT_FOUND' };
  if (!LIFECYCLE_EDGES.has(`${item.lifecycle_state}>${nextState}`)) return { ok: false, code: 'INVALID_TRANSITION' };
  db.prepare('UPDATE kaizen_items SET lifecycle_state = ?, updated_at = ? WHERE id = ?').run(nextState, now(), id);
  if (nextState === 'Implemented') {
    db.prepare("UPDATE kaizen_items SET effectiveness_status = 'IMPLEMENTATION_VERIFIED', updated_at = ? WHERE id = ? AND effectiveness_status = 'UNVERIFIED'").run(now(), id);
    // Stamped once, never overwritten — the fixed boundary recordMeasurement/
    // canMarkProvenEffective need even after the item advances past this state.
    db.prepare('UPDATE kaizen_items SET implemented_at = ? WHERE id = ? AND implemented_at IS NULL').run(now(), id);
  }
  if (nextState === 'Dismissed') {
    db.prepare("UPDATE kaizen_items SET effectiveness_status = 'DISMISSED', updated_at = ? WHERE id = ?").run(now(), id);
  }
  return { ok: true, code: 'ADVANCED' };
}

/**
 * Record a measurement against an item — a passing regression test, a
 * clean sprint window, a chaos-drill receipt, a passive-monitor reading, or
 * one point of a longitudinal trend series.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kaizenId: string, sprintVersion: string, measurementKind: string, passed: boolean,
 *   recurrenceCount?: number, metricValue?: number, baselineValue?: number, evidenceRef: string,
 *   notes?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: boolean, code: string, id?: string}}
 */
function recordMeasurement(db, {
  kaizenId, sprintVersion, measurementKind, passed, recurrenceCount = 0, metricValue = null,
  baselineValue = null, evidenceRef, notes = null, now = () => new Date().toISOString(), newId = crypto.randomUUID
}) {
  if (!MEASUREMENT_KINDS.includes(measurementKind) || typeof passed !== 'boolean' ||
    !Number.isSafeInteger(recurrenceCount) || recurrenceCount < 0 || !NON_BLANK(evidenceRef, 400) || !NON_BLANK(sprintVersion, 40)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  const item = getItem(db, kaizenId);
  if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
  // PRR-B R3: an effectiveness measurement recorded before the fix was even
  // implemented proves nothing about the fix — reject outright rather than
  // let canMarkProvenEffective try to filter it out after the fact.
  if (!POST_IMPLEMENTATION_STATES.includes(item.lifecycle_state)) return { ok: false, code: 'PRE_IMPLEMENTATION_MEASUREMENT' };
  const id = newId();
  db.prepare(
    'INSERT INTO kaizen_measurements (id, kaizen_id, sprint_version, measurement_kind, passed, recurrence_count, metric_value, baseline_value, evidence_ref, notes, measured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, kaizenId, sprintVersion, measurementKind, passed ? 1 : 0, recurrenceCount, metricValue, baselineValue, evidenceRef, notes, now());
  return { ok: true, code: 'RECORDED', id };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kaizenId
 * @returns {object[]} Every measurement, oldest first.
 */
function listMeasurements(db, kaizenId) {
  return db.prepare('SELECT * FROM kaizen_measurements WHERE kaizen_id = ? ORDER BY measured_at').all(kaizenId);
}

/**
 * The one place the 4-Class proof rules live (Architect Ruling
 * A531-W1D-KAIZEN-C1-DDL-COSIGN §4): whether `item` has earned
 * `effectiveness_status = 'PROVEN_EFFECTIVE'`, given its recorded
 * `kaizen_measurements`.
 * - `A_DETERMINISTIC`: a non-empty `verification_evidence_ref` (or a
 *   passing `regression_test` measurement) plus ≥1 clean `sprint_window`
 *   measurement (`passed=1, recurrence_count=0`) after implementation.
 * - `B_WORKFLOW`: ≥3 consecutive clean `sprint_window` measurements
 *   (`passed=1, recurrence_count=0`) — "consecutive" means no
 *   `passed=0`/`recurrence_count>0` measurement sorted between them, not
 *   literally adjacent sprint version numbers (a version naming scheme is
 *   not this function's concern).
 * - `C_OPERATIONAL_DRILL`: ≥1 passing `chaos_drill` measurement plus ≥1
 *   clean `passive_monitor` measurement.
 * - `D_LONGITUDINAL`: 3–5 passing `statistical_trend` measurements.
 * @param {{verification_class: string, verification_evidence_ref: string|null}} item
 * @param {object[]} measurements - As {@link listMeasurements} returns, any order.
 * @returns {{ok: boolean, code: string}}
 */
function canMarkProvenEffective(item, measurements) {
  // PRR-B R3: a measurement backdated to before the item was ever
  // implemented proves nothing, even if recordMeasurement's own
  // POST_IMPLEMENTATION_STATES gate was satisfied at write time (the item
  // could have been Implemented, then the row's measured_at set earlier
  // than that moment by an injected/overridden `now`). item.implemented_at
  // is absent only for data predating this fix or a caller passing a bare
  // fixture — treated as "no boundary" rather than rejecting everything.
  const postImplementation = item.implemented_at
    ? measurements.filter((m) => m.measured_at >= item.implemented_at)
    : measurements;
  const byKind = (kind) => postImplementation.filter((m) => m.measurement_kind === kind);
  const clean = (list) => list.filter((m) => m.passed === 1 && m.recurrence_count === 0);
  const sprintOf = (m) => (typeof m.sprint_version === 'string' ? m.sprint_version.trim() : '');

  switch (item.verification_class) {
    case 'A_DETERMINISTIC': {
      const hasEvidence = NON_BLANK(item.verification_evidence_ref) || clean(byKind('regression_test')).length >= 1;
      const hasCleanWindow = clean(byKind('sprint_window')).length >= 1;
      return hasEvidence && hasCleanWindow ? { ok: true, code: 'PROVEN' } : { ok: false, code: 'INSUFFICIENT_EVIDENCE' };
    }
    case 'B_WORKFLOW': {
      // PRR-B R1: 3 DISTINCT sprint_versions, not just 3 rows — recording the
      // same sprint 3 times must never read as "3 consecutive clean sprints".
      // Trailing distinct-sprint count of clean sprint_window measurements, in
      // measured order; a non-clean or blank-sprint_version row resets it, a
      // clean row whose sprint_version repeats one already in the run neither
      // advances nor resets it (its own sprint already counted).
      const windows = byKind('sprint_window').slice().sort((a, b) => (a.measured_at < b.measured_at ? -1 : 1));
      let distinctSprints = new Set();
      for (const m of windows) {
        const version = sprintOf(m);
        if (m.passed === 1 && m.recurrence_count === 0 && version) distinctSprints.add(version);
        else distinctSprints = new Set();
      }
      return distinctSprints.size >= 3 ? { ok: true, code: 'PROVEN' } : { ok: false, code: 'INSUFFICIENT_CONSECUTIVE_SPRINTS' };
    }
    case 'C_OPERATIONAL_DRILL': {
      const hasDrill = clean(byKind('chaos_drill')).length >= 1;
      const hasMonitor = clean(byKind('passive_monitor')).length >= 1;
      return hasDrill && hasMonitor ? { ok: true, code: 'PROVEN' } : { ok: false, code: 'INSUFFICIENT_DRILL_OR_MONITOR_EVIDENCE' };
    }
    case 'D_LONGITUDINAL': {
      // PM R3 (PRR-B R2 catch): a ROLLING window of the latest up to 5
      // distinct qualifying sprints, not a lifetime cap — an item with 6+
      // qualifying sprints across its whole history must still prove on
      // its most recent 3-5, the same way Class B's streak is trailing,
      // not a running total that can only ever grow. A trend measurement
      // qualifies when it carries finite numeric metric_value/
      // baseline_value AND shows non-regression against baseline (lower-
      // is-better, this fleet's defect/recurrence-rate convention; a
      // metric needing the opposite direction needs a schema column
      // naming it, not a guess here) and a non-blank sprint_version. A
      // disqualifying measurement resets the trailing window entirely,
      // mirroring Class B; a qualifying repeat of a sprint already in the
      // window neither advances nor resets it.
      const trend = byKind('statistical_trend').slice().sort((a, b) => (a.measured_at < b.measured_at ? -1 : 1));
      let window = [];
      for (const m of trend) {
        const qualifies = m.passed === 1 &&
          typeof m.metric_value === 'number' && Number.isFinite(m.metric_value) &&
          typeof m.baseline_value === 'number' && Number.isFinite(m.baseline_value) &&
          m.metric_value <= m.baseline_value;
        const version = sprintOf(m);
        if (qualifies && version) {
          if (!window.includes(version)) {
            window.push(version);
            if (window.length > 5) window.shift();
          }
        } else {
          window = [];
        }
      }
      return window.length >= 3 ? { ok: true, code: 'PROVEN' } : { ok: false, code: 'INSUFFICIENT_TREND_SERIES' };
    }
    default:
      return { ok: false, code: 'UNKNOWN_VERIFICATION_CLASS' };
  }
}

/**
 * Mark an item `effectiveness_status = 'PROVEN_EFFECTIVE'` and advance its
 * `lifecycle_state` to `Effectiveness Measured`, refusing outright unless
 * {@link canMarkProvenEffective} agrees — this is the only writer of
 * `PROVEN_EFFECTIVE` in this module.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function markProvenEffective(db, { id, now = () => new Date().toISOString() }) {
  const item = getItem(db, id);
  if (!item) return { ok: false, code: 'NOT_FOUND' };
  if (item.lifecycle_state !== 'Verified') return { ok: false, code: 'INVALID_TRANSITION' };
  const verdict = canMarkProvenEffective(item, listMeasurements(db, id));
  if (!verdict.ok) return verdict;
  db.prepare(
    "UPDATE kaizen_items SET lifecycle_state = 'Effectiveness Measured', effectiveness_status = 'PROVEN_EFFECTIVE', updated_at = ? WHERE id = ?"
  ).run(now(), id);
  return { ok: true, code: 'PROVEN' };
}

/**
 * Mark a regression: effectiveness regressed after once being proven.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function markRegressed(db, { id, now = () => new Date().toISOString() }) {
  const changed = db.prepare(
    "UPDATE kaizen_items SET effectiveness_status = 'REGRESSED', updated_at = ? WHERE id = ? AND effectiveness_status = 'PROVEN_EFFECTIVE'"
  ).run(now(), id).changes;
  return changed === 1 ? { ok: true, code: 'REGRESSED' } : { ok: false, code: 'NOT_FOUND_OR_NOT_PROVEN' };
}

/**
 * Close an item — only reachable from `Effectiveness Measured` with
 * `effectiveness_status = 'PROVEN_EFFECTIVE'`, or from `Dismissed` (a
 * dismissed finding closes without ever being proven effective).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function closeItem(db, { id, now = () => new Date().toISOString() }) {
  const item = getItem(db, id);
  if (!item) return { ok: false, code: 'NOT_FOUND' };
  if (item.lifecycle_state === 'Dismissed') {
    db.prepare("UPDATE kaizen_items SET lifecycle_state = 'Closed', updated_at = ? WHERE id = ?").run(now(), id);
    return { ok: true, code: 'CLOSED' };
  }
  if (item.lifecycle_state === 'Effectiveness Measured' && item.effectiveness_status === 'PROVEN_EFFECTIVE') {
    db.prepare("UPDATE kaizen_items SET lifecycle_state = 'Closed', updated_at = ? WHERE id = ?").run(now(), id);
    return { ok: true, code: 'CLOSED' };
  }
  return { ok: false, code: 'INVALID_TRANSITION' };
}

/**
 * Record the sprint charter's explicit disposition for an open/due item —
 * the write half of the Gate 0 bridge; `lib/sprint-charter-compiler.js`
 * (#2126, out of this car's scope) is the reader that refuses a charter
 * carrying no disposition for an item {@link gate0Feed} would have surfaced.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, disposition: string, rationale?: string, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function setGate0Disposition(db, { id, disposition, rationale = null, now = () => new Date().toISOString() }) {
  if (!GATE0_DISPOSITIONS.includes(disposition)) return { ok: false, code: 'INVALID_REQUEST' };
  if (disposition === 'deferred_with_rationale' && !NON_BLANK(rationale)) return { ok: false, code: 'RATIONALE_REQUIRED' };
  const changed = db.prepare('UPDATE kaizen_items SET gate0_disposition = ?, gate0_rationale = ?, updated_at = ? WHERE id = ?')
    .run(disposition, rationale, now(), id).changes;
  return changed === 1 ? { ok: true, code: 'UPDATED' } : { ok: false, code: 'NOT_FOUND' };
}

/** Every `lifecycle_state` the Gate 0 planning feed surfaces — a closed or dismissed-and-closed item is no longer open/due. */
const GATE0_OPEN_STATES = ['Detected', 'Classified', 'Proposed', 'Approved', 'Assigned', 'Implemented', 'Verified', 'Effectiveness Measured'];

/**
 * Both spellings a `kaizen_items.logical_project_id` value might use for the
 * same underlying project (#3347, KZ-v667-07): `v6_legacy_project_map`'s own
 * auto-provisioning trigger always writes the `lp-<legacyProjectId>` form,
 * but that column carries no foreign key and no format check — a row
 * ingested by some other caller (e.g. a Gate 4 settlement path outside this
 * module's file envelope) could have recorded the bare numeric id instead.
 * Returns both forms so a resolved id set matches either spelling a real
 * `kaizen_items` row might actually hold; a value in neither shape (no
 * digits, or already something else entirely) is returned unchanged, alone.
 * @param {string} id
 * @returns {string[]}
 */
function _logicalProjectIdSpellings(id) {
  const lpMatch = /^lp-(\d+)$/.exec(id);
  if (lpMatch) return [id, lpMatch[1]];
  if (/^\d+$/.test(id)) return [id, `lp-${id}`];
  return [id];
}

/**
 * Every v6 logical project id a TangleClaw (legacy) project — AND every
 * other legacy project sharing one of its `project_group_members` groups —
 * is entitled to act under for Kaizen purposes (#3347, KZ-v667-07): the
 * fix for "a Fleet PM had to pass `--logical-project lp-114` by hand to see
 * items its own fleet's Observer ingested under lp-114". Own mapping(s) are
 * included unconditionally (group membership is additive, never a
 * narrowing), each expanded to both id spellings
 * ({@link _logicalProjectIdSpellings}) since the column itself enforces
 * neither. Deduplicated; empty when `projectId` has no v6 presence and no
 * group membership at all — never a wildcard.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} projectId
 * @returns {string[]}
 */
function resolveLogicalProjectIdsForLegacyProject(db, projectId) {
  const rows = db.prepare(
    `SELECT DISTINCT m.logical_project_id
     FROM v6_legacy_project_map m
     WHERE m.legacy_project_id = ?
        OR m.legacy_project_id IN (
          SELECT pgm2.project_id FROM project_group_members pgm1
          JOIN project_group_members pgm2 ON pgm2.group_id = pgm1.group_id
          WHERE pgm1.project_id = ?
        )`
  ).all(projectId, projectId);
  const ids = new Set();
  for (const row of rows) {
    for (const spelling of _logicalProjectIdSpellings(row.logical_project_id)) ids.add(spelling);
  }
  return Array.from(ids);
}

/**
 * Resolve {@link listItems}/{@link gate0Feed}'s logical-project scope from
 * whichever of three mutually-exclusive filter shapes a caller supplied,
 * most-specific first: an already-resolved `logicalProjectIds` array, a
 * `legacyProjectId` to resolve via {@link resolveLogicalProjectIdsForLegacyProject}
 * (the fleet-wide case, #3347), or a single exact `logicalProjectId` string
 * (unchanged pre-#3347 behavior). `null` means "no scope filter at all" —
 * distinct from an empty array, which means "resolved to nothing" (e.g. a
 * `legacyProjectId` with no v6 presence and no group) and must exclude
 * every row, never every row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logicalProjectId?: string, logicalProjectIds?: string[], legacyProjectId?: (number|string)}} opts
 * @returns {string[]|null}
 */
function _resolveScopeLogicalProjectIds(db, opts) {
  if (Array.isArray(opts.logicalProjectIds)) {
    return opts.logicalProjectIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  }
  const legacyProjectId = Number(opts.legacyProjectId);
  if (opts.legacyProjectId !== undefined && opts.legacyProjectId !== null && Number.isInteger(legacyProjectId)) {
    return resolveLogicalProjectIdsForLegacyProject(db, legacyProjectId);
  }
  if (typeof opts.logicalProjectId === 'string' && opts.logicalProjectId.trim().length > 0) {
    return [opts.logicalProjectId.trim()];
  }
  return null;
}

/**
 * Every open/due item a Gate 0 sprint charter must ingest and explicitly
 * disposition before dispatch, optionally scoped to a logical project (a
 * single id, an already-resolved id array, or a legacy project id to
 * resolve fleet-wide — see {@link _resolveScopeLogicalProjectIds}, #3347).
 * Read-only; never writes a disposition itself.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{logicalProjectId?: string, logicalProjectIds?: string[], legacyProjectId?: (number|string)}} [args]
 * @returns {object[]}
 */
function gate0Feed(db, args = {}) {
  const placeholders = GATE0_OPEN_STATES.map(() => '?').join(',');
  const scopeIds = _resolveScopeLogicalProjectIds(db, args);
  if (scopeIds !== null) {
    if (scopeIds.length === 0) return [];
    const idPlaceholders = scopeIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM kaizen_items WHERE lifecycle_state IN (${placeholders}) AND logical_project_id IN (${idPlaceholders}) ORDER BY created_at`
    ).all(...GATE0_OPEN_STATES, ...scopeIds);
  }
  return db.prepare(`SELECT * FROM kaizen_items WHERE lifecycle_state IN (${placeholders}) ORDER BY created_at`).all(...GATE0_OPEN_STATES);
}

/**
 * {@link listItems}'s recognized exact-equality query filters, mapped to
 * their real column. `logicalProjectId` is deliberately absent here since
 * #3347 — it, plus the newer `logicalProjectIds`/`legacyProjectId`, are
 * resolved together through {@link _resolveScopeLogicalProjectIds} instead,
 * so all three share one `IN (...)` clause rather than three separate
 * exact-equality ones that could never all match the same row at once.
 */
const LIST_ITEMS_FILTER_COLUMNS = Object.freeze({
  id: 'id', originSprint: 'origin_sprint',
  lifecycleState: 'lifecycle_state', gate0Disposition: 'gate0_disposition'
});

/** `listItems`'s row cap when `opts.limit` is absent, non-numeric, or non-positive — a generic listing route has no other bound on how many rows a caller could otherwise pull in one call. */
const LIST_ITEMS_DEFAULT_LIMIT = 200;

/** The hard ceiling `opts.limit` can request, however large a caller asks for. */
const LIST_ITEMS_MAX_LIMIT = 500;

/**
 * Every `kaizen_items` row matching zero or more exact-equality filters,
 * newest first — the general-purpose listing `GET /api/v6/kaizen/items`
 * (#3324, Car V666-W1-B) calls with its parsed query string as `opts`
 * verbatim, every value therefore a string. Unlike {@link gate0Feed}, this
 * is NOT scoped to open/due `lifecycle_state`s — a caller wanting that
 * narrower, oldest-first planning view still wants `gate0Feed`, not this.
 * Ties on `created_at` (`now()`'s millisecond resolution; two calls inside
 * the same millisecond are not hypothetical under test or a fast batch
 * ingest) break on `rowid DESC` — SQLite's own insertion order, the only
 * tie-break `ORDER BY created_at` alone cannot promise. Read-only.
 *
 * The logical-project scope (`logicalProjectId` / `logicalProjectIds` /
 * `legacyProjectId`) is resolved separately from the other filters, through
 * {@link _resolveScopeLogicalProjectIds} (#3347) — see that function for how
 * the three shapes relate.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id?: string, logicalProjectId?: string, logicalProjectIds?: string[],
 *   legacyProjectId?: (number|string), originSprint?: string,
 *   lifecycleState?: string, gate0Disposition?: string, limit?: (string|number)}} [opts]
 * @returns {object[]}
 */
function listItems(db, opts = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of Object.entries(LIST_ITEMS_FILTER_COLUMNS)) {
    const value = opts[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const scopeIds = _resolveScopeLogicalProjectIds(db, opts);
  if (scopeIds !== null) {
    if (scopeIds.length === 0) return [];
    clauses.push(`logical_project_id IN (${scopeIds.map(() => '?').join(',')})`);
    params.push(...scopeIds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const requested = Number(opts.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, LIST_ITEMS_MAX_LIMIT) : LIST_ITEMS_DEFAULT_LIMIT;
  return db.prepare(`SELECT * FROM kaizen_items ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, limit);
}

/**
 * Every item already recorded for one origin sprint, keyed by `finding_id`
 * (#3324) — the idempotency check `lib/sprint-report-gate.js`'s Gate 4
 * ingestion needs so settling the same report twice never inserts a
 * duplicate row for a finding it already ingested. Read-only.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} originSprint
 * @returns {object[]}
 */
function listByOriginSprint(db, originSprint) {
  return db.prepare('SELECT * FROM kaizen_items WHERE origin_sprint = ? ORDER BY created_at').all(originSprint);
}

/**
 * Confirm that every fast-follow sub-version a report marks as a major
 * learning links a Kaizen item that really exists in this ledger (#3089).
 * The report validator (Rule 11) can only check that a `kaizen_id` is
 * present, since it reads HTML with no database; this is the other half.
 * Routine entries (`major_learning` not true) need no link and are skipped.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{version?: string, major_learning?: boolean, kaizen_id?: string}>} entries -
 *   A report's `fast_follow_subversions[]`.
 * @returns {{ok: boolean, checked: number, missing: Array<{version: (string|null), kaizen_id: (string|null)}>}}
 */
function verifyFastFollowKaizenLinks(db, entries) {
  if (!Array.isArray(entries)) throw new TypeError('verifyFastFollowKaizenLinks: entries must be an array');
  const missing = [];
  let checked = 0;
  for (const entry of entries) {
    if (!entry || entry.major_learning !== true) continue;
    checked += 1;
    const id = typeof entry.kaizen_id === 'string' && entry.kaizen_id.trim() ? entry.kaizen_id.trim() : null;
    if (!id || !getItem(db, id)) {
      missing.push({ version: typeof entry.version === 'string' ? entry.version : null, kaizen_id: id });
    }
  }
  return { ok: missing.length === 0, checked, missing };
}

module.exports = {
  verifyFastFollowKaizenLinks,
  detectItem, getItem, advanceLifecycle,
  recordMeasurement, listMeasurements,
  canMarkProvenEffective, markProvenEffective, markRegressed, closeItem,
  setGate0Disposition, gate0Feed, listByOriginSprint, listItems,
  resolveLogicalProjectIdsForLegacyProject
};
