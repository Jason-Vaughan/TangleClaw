'use strict';

/**
 * v6 (#3266, V6-017, Car V665-W1-B): a configurable Mandatory Sprint
 * Reports & Post-Mortems policy, and the Gate 4 completion gate it drives
 * — per version, and per multi-version train.
 *
 * `lib/native-sprint-tracker.js#parseSprintReportSettlement` already
 * parses a sprint report's rendered HTML and says whether it has settled
 * past its auto-generated live-tracker placeholder (#3175) — but nothing
 * in this repo's production code actually CALLS it to gate anything
 * (confirmed by grepping every caller outside that module's own tests):
 * it is a tested, exported, unused primitive. This module is its first
 * real consumer: {@link evaluateReportGate} turns "is this settled" into
 * an actual pass/fail decision against a CONFIGURABLE policy (mandatory
 * or not, an explicit Operator-authorized exception), and
 * {@link evaluateTrainGate} does the same across every version in a
 * multi-version train plus, optionally, the train's own consolidated
 * retrospective.
 *
 * Distinct from `lib/native-sprint-tracker.js#verifySprintSetupAndRoadmapSync`,
 * which uses the same settlement parser as ONE of several signals toward a
 * different question (is `roadmap-sync-status.json` honest about what it
 * claims) — this module is not a replacement for that, and does not
 * duplicate its hub-link or sync-status checks.
 *
 * Deliberately does not read any file from disk, call any publication
 * destination, or discover which versions belong to a train — all three
 * are callers' decisions (a future route/CLI car), the same way #3263 left
 * fleet-membership discovery to ITS caller. `reportHtml` is supplied
 * already-read, exactly as `parseSprintReportSettlement` itself takes it.
 *
 * #3324 (Car V666-W1-C) added a second capability on top: {@link
 * extractKaizenFindings} parses structured `KZ-<ver>-NN` Observer findings
 * out of a settled report's postmortem, {@link ingestKaizenFromReport}
 * upserts them into `lib/v6/e5-kaizen-ledger.js`'s `kaizen_items` table
 * idempotently, and {@link settleReportGate} composes that with {@link
 * evaluateReportGate} so a caller gets both in one call. Unlike every
 * function above, these three accept a live `db` handle — the module is no
 * longer purely file-I/O-free once ingestion is in play, though {@link
 * evaluateReportGate}/{@link evaluateTrainGate} themselves are untouched
 * and still take none. Built and tested here; not yet wired to any route,
 * CLI verb, or wrap step (a follow-up car's integration point).
 *
 * @module lib/sprint-report-gate
 */

const { parseSprintReportSettlement } = require('./native-sprint-tracker');
const { extractSection, toPlainText } = require('./v6/sprint-report-validator-v3');
const e5 = require('./v6/e5-kaizen-ledger');

/** A typed refusal: `code` is stable, `status` is the HTTP status a route should answer with. */
class SprintReportGateError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [detail]
   */
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'SprintReportGateError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a {@link SprintReportGateError} unless `condition` holds.
 * @param {*} condition
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @param {object} [detail]
 * @returns {void}
 */
function need(condition, code, message, status = 400, detail) {
  if (!condition) throw new SprintReportGateError(code, message, status, detail);
}

/**
 * Validate an Operator-authorized exception record: a non-empty `grantedBy`
 * and `reason`, and an `at` that parses as a real date. Anything else is
 * treated as NO exception (fail closed) rather than thrown — a malformed
 * exception object must never silently grant one.
 * @param {*} exception
 * @returns {boolean}
 */
function _isValidException(exception) {
  if (!exception || typeof exception !== 'object') return false;
  const { grantedBy, reason, at } = exception;
  return typeof grantedBy === 'string' && grantedBy.trim().length > 0
    && typeof reason === 'string' && reason.trim().length > 0
    && typeof at === 'string' && !Number.isNaN(Date.parse(at));
}

/**
 * Evaluate Gate 4 for one report — a version's own Sprint Report, or a
 * train's consolidated retrospective — against a configured policy.
 *
 * @param {{scope: 'version'|'train', id: string, mandatory: boolean,
 *   reportHtml?: (string|null), destinations?: string[],
 *   operatorException?: ({grantedBy: string, reason: string, at: string}|null)}} input
 * @returns {{passed: boolean, scope: string, id: string, reason: string,
 *   settlement: (object|null), exceptionApplied: boolean, destinations: string[]}}
 * @throws {SprintReportGateError} `SCOPE_INVALID`, `ID_REQUIRED`, `MANDATORY_INVALID`, `DESTINATIONS_INVALID`.
 */
function evaluateReportGate(input) {
  need(input && (input.scope === 'version' || input.scope === 'train'), 'SCOPE_INVALID', "scope must be 'version' or 'train'");
  need(typeof input.id === 'string' && input.id.trim().length > 0, 'ID_REQUIRED', 'id must be a non-empty string');
  need(typeof input.mandatory === 'boolean', 'MANDATORY_INVALID', 'mandatory must be a boolean');
  const destinations = input.destinations === undefined ? [] : input.destinations;
  need(Array.isArray(destinations) && destinations.every((d) => typeof d === 'string' && d.trim().length > 0),
    'DESTINATIONS_INVALID', 'destinations must be an array of non-empty strings');

  const base = { scope: input.scope, id: input.id, destinations };

  if (!input.mandatory) {
    return { ...base, passed: true, reason: 'not mandatory under the configured policy', settlement: null, exceptionApplied: false };
  }
  if (_isValidException(input.operatorException)) {
    return { ...base, passed: true, reason: `operator-authorized exception: ${input.operatorException.reason}`, settlement: null, exceptionApplied: true };
  }
  if (typeof input.reportHtml !== 'string' || input.reportHtml.length === 0) {
    return { ...base, passed: false, reason: 'no report found', settlement: null, exceptionApplied: false };
  }
  const settlement = parseSprintReportSettlement(input.reportHtml);
  return {
    ...base, passed: settlement.settled, exceptionApplied: false, settlement,
    reason: settlement.settled ? 'report has settled past the live-tracker placeholder' : 'report still carries the live-tracker placeholder'
  };
}

/**
 * Evaluate Gate 4 across a whole multi-version train: every named version's
 * own gate, plus (when `trainRetrospective` is given) the train-level one.
 * Passes only when every evaluated entry passes; the full per-entry detail
 * is always returned, never collapsed into just the aggregate, so a caller
 * can report exactly which version (or the train retrospective itself) is
 * what's actually blocking.
 *
 * @param {{versions: Array<{id: string, mandatory: boolean, reportHtml?: (string|null),
 *   destinations?: string[], operatorException?: (object|null)}>,
 *   trainRetrospective?: ({id: string, mandatory: boolean, reportHtml?: (string|null),
 *     destinations?: string[], operatorException?: (object|null)}|null)}} input
 * @returns {{passed: boolean, versions: object[], trainRetrospective: (object|null)}}
 * @throws {SprintReportGateError} `VERSIONS_REQUIRED`, plus anything {@link evaluateReportGate} throws.
 */
function evaluateTrainGate(input) {
  need(Array.isArray(input.versions) && input.versions.length > 0, 'VERSIONS_REQUIRED', 'versions must be a non-empty array');
  const versionResults = input.versions.map((v) => evaluateReportGate({ ...v, scope: 'version' }));
  const trainResult = input.trainRetrospective ? evaluateReportGate({ ...input.trainRetrospective, scope: 'train' }) : null;
  const passed = versionResults.every((r) => r.passed) && (!trainResult || trainResult.passed);
  return { passed, versions: versionResults, trainRetrospective: trainResult };
}

/**
 * A `vX.Y.Z` (or bare `X.Y.Z`) version string collapsed into the
 * `KZ-<ver>-NN` id slug the fleet's own charter tables already use (e.g.
 * `v6.6.5` -> `v665`): strip a leading `v`, drop every `.`, re-prefix `v`.
 * @param {string} version
 * @returns {string}
 */
function _kaizenVersionSlug(version) {
  return `v${String(version).replace(/^v/i, '').replace(/\./g, '')}`;
}

/**
 * One finding's `data-kaizen-id="…"` / `data-kaizen-class="…"` attributes,
 * when the report's author tagged it explicitly (#3324's forward-looking
 * markup convention — see `lib/sprint-report-gate.js`'s own module
 * JSDoc). Absent on every report shipped before this car, which is exactly
 * why {@link extractKaizenFindings} never requires either.
 * @param {string} attrs - The raw attribute text between the tag name and `>`.
 * @returns {{kaizenId: (string|null), verificationClass: (string|null)}}
 */
function _taggedAttrs(attrs) {
  const id = /data-kaizen-id="([^"]*)"/.exec(attrs || '');
  const cls = /data-kaizen-class="([^"]*)"/.exec(attrs || '');
  return {
    kaizenId: id && id[1].trim() ? id[1].trim() : null,
    verificationClass: cls && cls[1].trim() ? cls[1].trim() : null
  };
}

/** `<strong>Fix / Guardrail:</strong> …` (or `Fix/Guardrail:`), when a real-shape item names one — the rest of the paragraph after it; `null` when the item names no such callout at all. */
function _correctiveActionFrom(bodyHtml) {
  const tagged = /<strong>\s*Fix\s*\/?\s*Guardrail:\s*<\/strong>\s*([\s\S]*)$/i.exec(bodyHtml);
  if (!tagged) return null;
  const text = toPlainText(tagged[1]).trim();
  return text.length > 0 ? text : null;
}

/**
 * Extract structured Observer Kaizen findings — both `preserve` (What
 * Worked) and `improve` (What Didn't Work) — from a settled Gate 4
 * report's `#postmortem` section (#3324 AC#1). Two markup shapes, same as
 * {@link module:lib/native-sprint-tracker.parseSprintReportSettlement}
 * already tolerates for its own `whatWorked`/`whatDidnt` text lists:
 *   1. The real `TangleClaw-Shared/sprint-reports/` generator's own shape:
 *      `<div class="pm-item">`/`<div class="pm-item warn">` with an
 *      `<h4>` title and a `<p>` body.
 *   2. The synthetic convention: `<li>` points inside
 *      `<ul id="postmortem-what-worked">`/`<ul id="postmortem-what-didnt">`.
 * Every finding may carry `data-kaizen-id`/`data-kaizen-class` attributes
 * on its own element (forward-looking; no shipped report has these yet —
 * see `[ASSUMPTION: …]` in this car's build plan). Findings with none are
 * returned with `kaizenId: null`; {@link ingestKaizenFromReport} assigns
 * the sequential `KZ-<ver>-NN` id at ingestion time, not here, since
 * numbering depends on the origin sprint this function is never given.
 * @param {string} html - A report's full HTML (or its `#postmortem` section alone).
 * @returns {Array<{category: ('preserve'|'improve'), kaizenId: (string|null),
 *   verificationClass: (string|null), title: string, body: string}>} In document order.
 */
function extractKaizenFindings(html) {
  const text = typeof html === 'string' ? html : '';
  const section = extractSection(text, 'postmortem') || text;
  const findings = [];

  for (const m of section.matchAll(/<div\s+class="pm-item( warn)?"([^>]*)>\s*<h4[^>]*>([\s\S]*?)<\/h4>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/div>/gi)) {
    const { kaizenId, verificationClass } = _taggedAttrs(m[2]);
    const title = toPlainText(m[3]).replace(/^\d+\.\s*/, '').trim();
    const bodyText = toPlainText(m[4]).trim();
    if (!title && !bodyText) continue;
    findings.push({
      category: m[1] ? 'improve' : 'preserve', kaizenId, verificationClass,
      title: title || bodyText, body: bodyText, correctiveActionSpec: _correctiveActionFrom(m[4])
    });
  }

  for (const [listId, category] of [['postmortem-what-worked', 'preserve'], ['postmortem-what-didnt', 'improve']]) {
    const list = new RegExp(`<ul[^>]*\\bid="${listId}"[^>]*>([\\s\\S]*?)</ul>`, 'i').exec(section);
    if (!list) continue;
    for (const li of list[1].matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/gi)) {
      const { kaizenId, verificationClass } = _taggedAttrs(li[1]);
      const bodyText = toPlainText(li[2]).trim();
      if (!bodyText) continue;
      findings.push({ category, kaizenId, verificationClass, title: bodyText, body: bodyText, correctiveActionSpec: null });
    }
  }

  return findings;
}

/**
 * Upsert a Gate 4 report's structured Kaizen findings into `kaizen_items`
 * (#3324 AC#1), scoped to `originSprint` and idempotent: a finding already
 * recorded for that origin sprint (matched by `finding_id`, real or
 * auto-numbered — see {@link extractKaizenFindings}) is skipped, not
 * re-inserted, so settling the same report twice is a safe no-op. Every
 * inserted item starts `gate0_disposition: 'unreviewed'` via
 * `e5.detectItem` — AC#2's fail-closed Gate 0 check is what makes that
 * mean something.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{reportHtml: string, originSprint: string, logicalProjectId?: (string|null),
 *   ownerRole?: string, defaultVerificationClass?: string, now?: Function, newId?: Function}} args
 * @returns {{ok: true, ingested: Array<{id: string, findingId: string}>, skipped: string[]}}
 */
function ingestKaizenFromReport(db, {
  reportHtml, originSprint, logicalProjectId = null, ownerRole = 'Observer',
  defaultVerificationClass = 'B_WORKFLOW', now = () => new Date().toISOString(), newId
} = {}) {
  need(typeof reportHtml === 'string' && reportHtml.length > 0, 'REPORT_HTML_REQUIRED', 'reportHtml must be a non-empty string');
  need(typeof originSprint === 'string' && originSprint.trim().length > 0, 'ORIGIN_SPRINT_REQUIRED', 'originSprint must be a non-empty string');

  const findings = extractKaizenFindings(reportHtml);
  const already = new Set(e5.listByOriginSprint(db, originSprint).map((item) => item.finding_id));
  const versionSlug = _kaizenVersionSlug(originSprint);

  const ingested = [];
  const skipped = [];
  let autoIndex = 0;
  for (const finding of findings) {
    let findingId = finding.kaizenId;
    if (!findingId) {
      autoIndex += 1;
      findingId = `KZ-${versionSlug}-${String(autoIndex).padStart(2, '0')}`;
    }
    if (already.has(findingId)) { skipped.push(findingId); continue; }

    const result = e5.detectItem(db, {
      originSprint, findingId, defectCategory: finding.category, rootCause: finding.body || finding.title,
      correctiveActionSpec: finding.correctiveActionSpec || `Preserve as an active guardrail: ${finding.title}`,
      ownerRole, verificationClass: finding.verificationClass || defaultVerificationClass,
      targetMetric: `no recurrence of: ${finding.title}`, logicalProjectId, now, newId
    });
    if (result.ok) { ingested.push({ id: result.id, findingId }); already.add(findingId); } else { skipped.push(findingId); }
  }

  return { ok: true, ingested, skipped };
}

/**
 * {@link evaluateReportGate} plus, when it passes on a genuinely settled
 * report, {@link ingestKaizenFromReport} against that same `reportHtml`
 * (#3324 AC#1's "settling Sprint N's report … upserts them into
 * kaizen_items"). `evaluateReportGate` itself stays pure and db-free —
 * every existing caller of it is unaffected; this is the one new entry
 * point a route/CLI car wires Gate 4 settlement through when it wants the
 * ingestion side effect too.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Parameters<typeof evaluateReportGate>[0] & {logicalProjectId?: (string|null), ownerRole?: string}} input
 * @returns {ReturnType<typeof evaluateReportGate> & {kaizenIngestion: (ReturnType<typeof ingestKaizenFromReport>|null)}}
 * @throws {SprintReportGateError} Anything {@link evaluateReportGate} throws.
 */
function settleReportGate(db, input) {
  const gate = evaluateReportGate(input);
  const reallySettled = gate.passed && gate.settlement && gate.settlement.settled && typeof input.reportHtml === 'string';
  if (!reallySettled) return { ...gate, kaizenIngestion: null };
  const kaizenIngestion = ingestKaizenFromReport(db, {
    reportHtml: input.reportHtml, originSprint: input.id,
    logicalProjectId: input.logicalProjectId, ownerRole: input.ownerRole
  });
  return { ...gate, kaizenIngestion };
}

module.exports = {
  SprintReportGateError, evaluateReportGate, evaluateTrainGate,
  extractKaizenFindings, ingestKaizenFromReport, settleReportGate
};
