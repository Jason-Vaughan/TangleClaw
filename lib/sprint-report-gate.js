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
 * @module lib/sprint-report-gate
 */

const { parseSprintReportSettlement } = require('./native-sprint-tracker');

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

module.exports = { SprintReportGateError, evaluateReportGate, evaluateTrainGate };
