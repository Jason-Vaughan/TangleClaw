'use strict';

/**
 * Feature Index prime summarizer (#568).
 *
 * The session prime used to inline the **entire** `FEATURES.md` under its
 * `## Feature Index` heading. Because the index could never converge — auto
 * `## TODO (auto-stubbed …)` blocks of `- **TBD** — …` entries piled up one
 * per wrap and never graduated into a real category — every session paid the
 * whole file's prime budget for a list where most entries were literally "TBD".
 *
 * This summarizer caps that cost: the prime inlines only the CURATED content
 * (the real category sections) and replaces the auto-stubbed backlog with a
 * one-line count. As the graduate step (`lib/wrap-steps/index-describe.js`)
 * moves entries out of TODO blocks and into categories, the inlined content
 * grows with real value while the backlog shrinks to a number — the prime cost
 * tracks converged content, not the raw pile.
 *
 * Kept dependency-free (no `require`) and pure so it can live off the
 * `projects → sessions` require cycle and be unit-tested in isolation.
 *
 * @module lib/feature-index-prime
 */

// A `## TODO (auto-stubbed <date>)` heading and any level-2 heading. A TODO
// block runs from its heading until the next `## ` heading or EOF.
const TODO_HEADING_RE = /^##\s+TODO\s+\(auto-stubbed\b/i;
const H2_HEADING_RE = /^##\s/;

/**
 * Summarize a `FEATURES.md` for the session prime: strip the auto-stubbed
 * backlog and report its size, leaving the curated categories intact.
 *
 * @param {string} content - Raw `FEATURES.md` contents (may be empty).
 * @returns {{curated:string, backlogEntries:number, backlogBlocks:number}}
 *   `curated` — the file with every `## TODO (auto-stubbed …)` block removed and
 *   runs of blank lines collapsed; `backlogEntries` — count of top-level list
 *   entries that were inside TODO blocks; `backlogBlocks` — count of TODO blocks.
 */
function summarizeFeatureIndexForPrime(content) {
  if (!content || typeof content !== 'string') {
    return { curated: '', backlogEntries: 0, backlogBlocks: 0 };
  }
  const kept = [];
  let inTodo = false;
  let backlogEntries = 0;
  let backlogBlocks = 0;
  for (const line of content.split('\n')) {
    if (TODO_HEADING_RE.test(line)) {
      inTodo = true;
      backlogBlocks += 1;
      continue; // drop the TODO heading itself
    }
    if (H2_HEADING_RE.test(line)) {
      inTodo = false; // a real category heading ends the backlog block
      kept.push(line);
      continue;
    }
    if (inTodo) {
      if (/^-\s+/.test(line)) backlogEntries += 1;
      continue; // drop everything inside the TODO block
    }
    kept.push(line);
  }
  // Collapse 3+ consecutive newlines (left by a removed mid-file block) to a
  // single blank line, and trim leading/trailing whitespace.
  const curated = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { curated, backlogEntries, backlogBlocks };
}

module.exports = { summarizeFeatureIndexForPrime };
