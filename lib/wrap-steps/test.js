'use strict';

/**
 * `test` wrap step — runs the project's `testCommand`. Red → blocks the
 * pipeline. `allowOverride: true` lets the user pass `--skip-tests` from
 * the UI; the skip is recorded in the wrap commit body.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 4.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
