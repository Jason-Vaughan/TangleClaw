'use strict';

/**
 * `commit` wrap step — single git commit aggregating all server-side
 * mutations + AI-produced files. Message built from `messageBuilder:
 * "session-content"` strategy. Skipped if truly clean (no changes
 * anywhere). The push step lives outside the pipeline — separate UI
 * affordance, per ADR 0002.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 9.
 * Until then the runner is *transactionally inert*: no step here touches
 * the project's git index, so a partial wrap leaves no trace.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
