'use strict';

/**
 * `priming-roll` wrap step — parses `.claude/plans/<plan>.md` for the
 * current chunk pointer; rolls forward in `.claude/priming/build-session.md`.
 * Carries blocker annotations through (e.g. "chunk-10d blocked on 10c.2 +
 * 10c.3 → note in rolled pointer").
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 6.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
