'use strict';

/**
 * `critic-check` wrap step — heuristic on session history (commit count
 * + line-change count + chunk-tag detection in commit messages or branch
 * names). Warn UI surfaces if the heuristic trips and no Critic agent
 * ran. Never blocks; logs skip rationale to MEMORY.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 7.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
