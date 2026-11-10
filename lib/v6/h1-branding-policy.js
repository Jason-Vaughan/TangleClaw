'use strict';

/**
 * v6 (#2987, V6-15 / H1, Car V60-T2-W1-D): the Three-Surface Split
 * Branding & Attribution Policy — three independent keys, their defaults,
 * and the two hard locks #2987 names.
 *
 * `project_authority_policies` (named in #2987 as where these three keys
 * live) is `lib/v6/authority-service.js`'s table, not this car's — neither
 * that file nor `lib/store/_schema.js` is in this car's envelope (zero
 * edits to either, per the car's file list). This module ships the policy
 * DEFINITIONS, their defaults, and the two hard-lock rules as pure
 * functions; registering `BRANDING_KEYS` into `authority-service.js`'s own
 * `KEYS` is `BRIDGE-1`/`BRIDGE-4`/`BRIDGE-5` (named in #2987 itself), a
 * later car's scope.
 *
 * @module lib/v6/h1-branding-policy
 */

/** The three independent branding/attribution keys #2987 names. */
const BRANDING_KEYS = Object.freeze([
  'branding.uiWatermark',
  'branding.gitCommitTrailer',
  'branding.generatedDocAttribution'
]);

/** How a repository can be classified for the `gitCommitTrailer` hard lock. */
const REPO_CLASSIFICATIONS = Object.freeze(['first-party', 'client-external']);

/**
 * The default value for every branding key on a repo with no stored
 * override — `uiWatermark` and `generatedDocAttribution` default `true`,
 * `gitCommitTrailer` defaults `false` on every repo (#2987 deliverable 1),
 * first-party included: `gitCommitTrailer` is opt-IN everywhere, not
 * merely opt-out on client/external repos.
 * @returns {{'branding.uiWatermark': true, 'branding.gitCommitTrailer': false, 'branding.generatedDocAttribution': true}}
 */
function defaultBrandingPolicy() {
  return {
    'branding.uiWatermark': true,
    'branding.gitCommitTrailer': false,
    'branding.generatedDocAttribution': true
  };
}

/**
 * Classify a path for `generatedDocAttribution` eligibility. Fail-closed:
 * only a path under `.tangleclaw/` (untracked, TangleClaw's own generated
 * reports) classifies `generated`; anything else — application source,
 * tests, configs, and any path this function doesn't specifically
 * recognize — classifies `application`, matching #2987's "permanently
 * forbidden on application source code/tests/configs" default-deny
 * posture for a path this module has not been told is safe.
 * @param {string} filePath
 * @returns {'generated'|'application'}
 */
function classifyAttributionTarget(filePath) {
  const normalized = String(filePath).split('\\').join('/').replace(/^\.\//, '');
  return /^\.tangleclaw\//.test(normalized) ? 'generated' : 'application';
}

/**
 * The effective `gitCommitTrailer` value, enforcing the hard lock
 * (#2987: "hard-locked `false` when repo is classified `Client /
 * External`") at READ time — a stored `true` on a client/external repo
 * never takes effect, regardless of how it got stored.
 * @param {boolean|undefined} storedValue
 * @param {string} repoClassification - One of {@link REPO_CLASSIFICATIONS}.
 * @returns {boolean}
 */
function effectiveGitCommitTrailer(storedValue, repoClassification) {
  if (repoClassification === 'client-external') return false;
  return storedValue === true;
}

/**
 * The effective `generatedDocAttribution` value, enforcing the hard lock
 * (#2987: "permanently forbidden on application source code/tests/
 * configs") at READ time — a stored `true` for a path that isn't
 * `generated` never takes effect.
 * @param {boolean|undefined} storedValue
 * @param {string} targetPath
 * @returns {boolean}
 */
function effectiveGeneratedDocAttribution(storedValue, targetPath) {
  if (classifyAttributionTarget(targetPath) !== 'generated') return false;
  return storedValue === undefined || storedValue === null ? true : storedValue === true;
}

/**
 * The effective `uiWatermark` value — no hard lock, just the stored value
 * or its default.
 * @param {boolean|undefined} storedValue
 * @returns {boolean}
 */
function effectiveUiWatermark(storedValue) {
  return storedValue === undefined || storedValue === null ? true : storedValue === true;
}

/**
 * Validate a proposed WRITE to one branding key before it is stored —
 * refuses a write the hard locks would make immediately ineffective,
 * rather than silently accepting a value {@link effectiveGitCommitTrailer}/
 * {@link effectiveGeneratedDocAttribution} would then override, which
 * would make the stored value lie about what is actually in effect.
 * @param {string} key - One of {@link BRANDING_KEYS}.
 * @param {*} value
 * @param {{repoClassification?: string, targetPath?: string}} [opts]
 * @returns {{allowed: boolean, code?: string}}
 */
function validateBrandingPolicyChange(key, value, opts = {}) {
  if (!BRANDING_KEYS.includes(key)) return { allowed: false, code: 'UNKNOWN_BRANDING_KEY' };
  if (key === 'branding.gitCommitTrailer' && value === true && opts.repoClassification === 'client-external') {
    return { allowed: false, code: 'GIT_COMMIT_TRAILER_LOCKED_CLIENT_EXTERNAL' };
  }
  if (key === 'branding.generatedDocAttribution' && value === true && opts.targetPath
    && classifyAttributionTarget(opts.targetPath) !== 'generated') {
    return { allowed: false, code: 'DOC_ATTRIBUTION_FORBIDDEN_ON_APPLICATION_PATH' };
  }
  return { allowed: true };
}

module.exports = {
  BRANDING_KEYS,
  REPO_CLASSIFICATIONS,
  defaultBrandingPolicy,
  classifyAttributionTarget,
  effectiveGitCommitTrailer,
  effectiveGeneratedDocAttribution,
  effectiveUiWatermark,
  validateBrandingPolicyChange
};
