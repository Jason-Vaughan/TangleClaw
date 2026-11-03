'use strict';

/**
 * Recorded test suite duration extraction and project-stats-card
 * projection (#1784, Architect Ruling A1784, `v5.60.0` Car 60-C Slice 1).
 *
 * A pure extractor/projector: {@link extractTestDuration} and
 * {@link buildTestDurationStats} take the caller's already-fetched
 * duration facts as plain data and return a normalized record or a
 * display-ready stats summary -- nothing here reads a project's stored
 * test evidence file, runs a suite, or touches a route. No project
 * test-evidence/status storage schema exists anywhere in this repo yet
 * (grepped before writing this module; none found) -- Slice 2's route
 * wiring is what will produce the real per-source raw record, so
 * {@link extractTestDuration} validates and normalizes the one caller-
 * supplied shape common to all three named sources (`durationMs`,
 * `recordedAt`, `commitSha`, `source`) rather than inventing three
 * different unverified raw storage schemas to "extract" from. Wiring this
 * into `server.js`/`lib/routes/*.js` and the project stats card
 * (`public/app.js`) is Slice 2, deliberately deferred so Car 60-C stays
 * 100% file-disjoint from this wave's other `v5.60.0` cars.
 *
 * @module lib/test-duration-stats
 */

/** Where a recorded test duration can have come from (#1784). */
const DURATION_SOURCES = Object.freeze(['testament', 'ci', 'stage']);

/**
 * How long a recorded duration stays current when the caller gives no
 * `currentCommitSha` to compare against (#1784's own "stale" field, left
 * to this module to default to a time-based fallback since the ruling
 * names the field, not the exact staleness rule). `7` days: long enough
 * that a quiet day between runs isn't false-flagged, short enough that a
 * month-old number on an active project reads as suspect.
 * @type {number}
 */
const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Format a millisecond duration as a short, human-readable label --
 * `"45s"`, `"2m 17s"`, `"1h 3m"`. Deterministic: the same `durationMs`
 * always formats the same way.
 * @param {number} durationMs
 * @returns {string}
 */
function _formatDuration(durationMs) {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Extract and normalize a recorded test suite duration (#1784) from the
 * caller's already-fetched duration facts.
 * @param {object} raw
 * @param {string} raw.source - One of {@link DURATION_SOURCES}
 * @param {number} raw.durationMs - Must be finite and `>= 0`
 * @param {string} raw.recordedAt - ISO timestamp
 * @param {string} [raw.commitSha]
 * @returns {{ok: true, duration: {durationMs: number, formattedDuration: string,
 *   recordedAt: string, commitSha: (string|null), source: string}}
 *   |{ok: false, code: string, message: string}}
 */
function extractTestDuration(raw) {
  if (!raw || typeof raw !== 'object') {
    return _refuse('TEST_DURATION_INVALID', 'input must be an object.');
  }
  if (!DURATION_SOURCES.includes(raw.source)) {
    return _refuse('TEST_DURATION_INVALID', `"${raw.source}" is not a recognized duration source (expected one of ${DURATION_SOURCES.join(', ')}).`);
  }
  if (typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) {
    return _refuse('TEST_DURATION_INVALID', 'durationMs must be a finite number >= 0.');
  }
  if (typeof raw.recordedAt !== 'string' || !raw.recordedAt || !Number.isFinite(Date.parse(raw.recordedAt))) {
    return _refuse('TEST_DURATION_INVALID', 'recordedAt must be a parseable ISO timestamp.');
  }
  if (raw.commitSha !== undefined && raw.commitSha !== null && typeof raw.commitSha !== 'string') {
    return _refuse('TEST_DURATION_INVALID', 'commitSha must be a string when present.');
  }

  return {
    ok: true,
    duration: {
      durationMs: raw.durationMs,
      formattedDuration: _formatDuration(raw.durationMs),
      recordedAt: raw.recordedAt,
      commitSha: typeof raw.commitSha === 'string' ? raw.commitSha : null,
      source: raw.source
    }
  };
}

/**
 * Project a clean, display-ready stats summary for a project stats card
 * (#1784) from a normalized duration (or `null`, for a project with no
 * recorded duration at all).
 *
 * `stale` compares against `options.currentCommitSha` when given (the
 * duration is stale precisely when it was recorded against a different
 * commit than the project's current HEAD -- the more precise signal);
 * otherwise it falls back to {@link DEFAULT_STALE_MS} age-based staleness.
 * @param {{durationMs: number, formattedDuration: string, recordedAt: string,
 *   commitSha: (string|null), source: string}|null} duration - An
 *   {@link extractTestDuration} result's `duration`, or `null`
 * @param {object} [options]
 * @param {string} [options.now] - ISO timestamp; defaults to `new Date().toISOString()`
 * @param {string} [options.currentCommitSha]
 * @param {number} [options.staleMs]
 * @returns {{hasDuration: boolean, durationMs: (number|null), displayLabel: string, stale: boolean}}
 */
function buildTestDurationStats(duration, options = {}) {
  if (!duration) {
    return { hasDuration: false, durationMs: null, displayLabel: 'No recorded duration', stale: false };
  }
  const now = typeof options.now === 'string' && options.now ? options.now : new Date().toISOString();
  const staleMs = typeof options.staleMs === 'number' ? options.staleMs : DEFAULT_STALE_MS;

  let stale;
  if (typeof options.currentCommitSha === 'string' && options.currentCommitSha) {
    stale = duration.commitSha !== options.currentCommitSha;
  } else {
    const ageMs = Date.parse(now) - Date.parse(duration.recordedAt);
    stale = !Number.isFinite(ageMs) || ageMs > staleMs;
  }

  return {
    hasDuration: true,
    durationMs: duration.durationMs,
    displayLabel: duration.formattedDuration,
    stale
  };
}

module.exports = {
  DURATION_SOURCES,
  DEFAULT_STALE_MS,
  extractTestDuration,
  buildTestDurationStats
};
