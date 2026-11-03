'use strict';

/**
 * Visible diagnostic for persistent project-version-cache write failures
 * (#1046, Architect Ruling A1046, `v5.60.0` Car 60-C Slice 1).
 *
 * A pure reducer, in the same shape `lib/resource-leases.js#transitionLease`
 * already establishes this session: {@link recordCacheWriteSuccess} and
 * {@link recordCacheWriteFailure} take the caller's own current tracking
 * record (or `null`, for a path never recorded before) plus one observed
 * write attempt, and return the next tracking record -- nothing here
 * writes a file, reads the real cache, or holds its own mutable state.
 * Wiring this into the real write path and a dashboard diagnostic banner
 * (`server.js`, `lib/project-version-files.js`, `public/app.js`) is Slice
 * 2, deliberately deferred so Car 60-C stays 100% file-disjoint from this
 * wave's other `v5.60.0` cars.
 *
 * @module lib/version-cache-diagnostic
 */

/**
 * Consecutive failures before the diagnostic banner escalates (#1046's own
 * "once persistent failure threshold is reached", left to this module to
 * default since the ruling names the concept, not the number). `3`: one
 * failure could be a transient blip (a momentary `ENOSPC` during a
 * concurrent write elsewhere); three in a row on the same project/path is
 * what "persistent" means.
 * @type {number}
 */
const PERSISTENT_FAILURE_THRESHOLD = 3;

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
 * Validate the shape every function below needs: a tracking key the
 * caller's `state` (if any) must agree with.
 * @param {object} input
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
function _validateKey(input) {
  if (!input || typeof input !== 'object') return _refuse('VERSION_CACHE_DIAGNOSTIC_INVALID', 'input must be an object.');
  if (typeof input.projectId !== 'string' || !input.projectId) {
    return _refuse('VERSION_CACHE_DIAGNOSTIC_INVALID', 'input.projectId is required.');
  }
  if (typeof input.cachePath !== 'string' || !input.cachePath) {
    return _refuse('VERSION_CACHE_DIAGNOSTIC_INVALID', 'input.cachePath is required.');
  }
  if (typeof input.now !== 'string' || !input.now || !Number.isFinite(Date.parse(input.now))) {
    return _refuse('VERSION_CACHE_DIAGNOSTIC_INVALID', 'input.now must be a parseable ISO timestamp.');
  }
  return { ok: true };
}

/**
 * Build the diagnostic banner payload for an escalated tracking record.
 * @param {object} state
 * @returns {object}
 */
function _buildBanner(state) {
  return {
    projectId: state.projectId,
    cachePath: state.cachePath,
    severity: 'persistent-write-failure',
    consecutiveFailures: state.consecutiveFailures,
    lastErrorCode: state.lastErrorCode,
    firstFailureAt: state.firstFailureAt,
    lastFailureAt: state.lastFailureAt
  };
}

/**
 * Record one successful project-version-cache write: clears any tracked
 * failure streak for this project/cache path outright, so the diagnostic
 * banner disappears the moment a write recovers (#1046's "clearing
 * automatically on subsequent write recovery") -- no partial credit, no
 * decay, a single success resets to zero.
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.cachePath
 * @param {string} input.now - ISO timestamp
 * @returns {{ok: true, state: object, banner: null}|{ok: false, code: string, message: string}}
 */
function recordCacheWriteSuccess(input) {
  const shape = _validateKey(input);
  if (!shape.ok) return shape;
  return {
    ok: true,
    state: {
      projectId: input.projectId, cachePath: input.cachePath,
      consecutiveFailures: 0, lastErrorCode: null, firstFailureAt: null, lastFailureAt: null
    },
    banner: null
  };
}

/**
 * Record one failed project-version-cache write attempt for a project/cache
 * path, carrying forward the previous tracking record (or starting fresh
 * when `previousState` is absent, or belongs to a different project/cache
 * path than this failure), and escalating to a visible diagnostic banner
 * once {@link PERSISTENT_FAILURE_THRESHOLD} consecutive failures accrue.
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.cachePath
 * @param {string} input.errorCode - e.g. `EACCES`, `ENOSPC`, `EROFS` -- not
 *   validated against a closed list; the ruling's own "etc." leaves the
 *   error-code vocabulary open-ended
 * @param {string} input.now - ISO timestamp
 * @param {object|null} [input.previousState] - This project/cache path's
 *   own last returned `state`, or `null`/absent for one never tracked
 * @returns {{ok: true, state: object, banner: (object|null)}|{ok: false, code: string, message: string}}
 */
function recordCacheWriteFailure(input) {
  const shape = _validateKey(input);
  if (!shape.ok) return shape;
  if (typeof input.errorCode !== 'string' || !input.errorCode) {
    return _refuse('VERSION_CACHE_DIAGNOSTIC_INVALID', 'input.errorCode is required.');
  }

  const previous = input.previousState;
  const sameKey = previous && previous.projectId === input.projectId && previous.cachePath === input.cachePath;
  const consecutiveFailures = sameKey ? previous.consecutiveFailures + 1 : 1;
  const firstFailureAt = sameKey && previous.firstFailureAt ? previous.firstFailureAt : input.now;

  const state = {
    projectId: input.projectId, cachePath: input.cachePath,
    consecutiveFailures, lastErrorCode: input.errorCode,
    firstFailureAt, lastFailureAt: input.now
  };
  const escalated = consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD;
  return { ok: true, state, banner: escalated ? _buildBanner(state) : null };
}

module.exports = {
  PERSISTENT_FAILURE_THRESHOLD,
  recordCacheWriteSuccess,
  recordCacheWriteFailure
};
