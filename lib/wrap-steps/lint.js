'use strict';

/**
 * `lint` wrap step — runs the project's `lintCommand` on files changed
 * since the last wrap commit. `blocker: "errors-only"` blocks on lint
 * errors but not warnings. `scope: "in-session"` limits findings to
 * commits since last wrap.
 *
 * **No-op stub** (#139 Chunk 3). Real implementation lands in Chunk 4.
 * @param {object} _context - Pipeline runner context (project, step, session, …)
 * @returns {Promise<{ok:true, status:'done', output:null, blockers:string[]}>}
 */
async function run(_context) {
  return { ok: true, status: 'done', output: null, blockers: [] };
}

module.exports = { run };
