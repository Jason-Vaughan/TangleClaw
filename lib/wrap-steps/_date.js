'use strict';

/**
 * Shared date helpers for wrap-step handlers.
 *
 * Underscore-prefixed filename signals this is an internal helper
 * module (not a step kind that `lib/wrap-pipeline.js:STEP_DISPATCH`
 * dispatches to). Sibling step handlers consume the exports directly.
 *
 * @module lib/wrap-steps/_date
 */

/**
 * Local-zoned YYYY-MM-DD formatter (#205). `Date#toISOString` always
 * emits UTC, which produces a wrong calendar day on hosts with
 * negative UTC offsets running late local-evening (e.g. evening PT
 * is next-day UTC). Every prior CHANGELOG entry in this repo is
 * local-zoned; using `Date#getFullYear` / `getMonth` / `getDate`
 * matches that convention without pulling a tz library.
 *
 * Extracted in the post-#216 / post-#215 refactor — the same function
 * previously lived inline in `lib/wrap-steps/version-bump.js` and
 * `lib/wrap-steps/features-toc.js`. Both handlers now consume it from
 * here, eliminating drift risk between call sites.
 *
 * @returns {string} `YYYY-MM-DD` in the host's local timezone.
 */
function todayIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  todayIsoLocal
};
