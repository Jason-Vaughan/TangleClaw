'use strict';

/**
 * `pr-check` wrap step — surfaces open PRs scoped to the current session
 * via `gh pr list --state open --author @me`. Asks the user how to
 * handle: merge before wrap, note as deferred, ignore. Never blocks.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 8.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
