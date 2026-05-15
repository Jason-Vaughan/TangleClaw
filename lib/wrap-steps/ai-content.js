'use strict';

/**
 * `ai-content` wrap step — server fabricates the per-step prompt from
 * `step.prompt` + session context, sends to the AI engine via tmux,
 * captures pane output, validates structured response. Used by the
 * `memory-update` step (writes session block to MEMORY.md) and the
 * `summary-derive` step (produces structured h2 output).
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 5.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
