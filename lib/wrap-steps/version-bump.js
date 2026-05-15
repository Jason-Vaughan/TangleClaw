'use strict';

/**
 * `version-bump` wrap step — if CHANGELOG has `[Unreleased]` entries and
 * the project has a `version.json`, bump and update CHANGELOG accordingly.
 * Optional, never blocks.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 4
 * (alongside `lint` and `test`, as part of the deterministic server-side
 * tier of step kinds).
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
