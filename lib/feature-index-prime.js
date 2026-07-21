'use strict';

/**
 * Feature Index scan + prime summarizer (#568).
 *
 * The session prime used to inline the **entire** `FEATURES.md` under its
 * `## Feature Index` heading. Because the index could never converge — auto
 * `## TODO (auto-stubbed …)` blocks of `- **TBD** — …` entries piled up one
 * per wrap and never graduated into a real category — every session paid the
 * whole file's prime budget for a list where most entries were literally "TBD".
 *
 * This module is the single, dependency-free source of truth for parsing that
 * structure. It serves two consumers:
 *   - `lib/sessions.js` caps the prime: inline only the CURATED categories and
 *     replace the auto-stubbed backlog with a one-line count.
 *   - `lib/wrap-steps/index-describe.js` (graduate mode) uses the same scan to
 *     count backlog entries (its trigger) and curated entries (its honest
 *     graduated count), rather than re-implementing the block parse.
 *
 * The auto-stub format is a contract shared with the producer
 * (`lib/wrap-steps/features-toc.js`); keeping one parser means the format lives
 * in one place per role. Kept `require`-free so it stays off the
 * `projects → sessions` cycle and is trivially unit-testable.
 *
 * @module lib/feature-index-prime
 */

// A `## TODO (auto-stubbed <date>)` heading and any level-2 heading. A TODO
// block runs from its heading until the next `## ` heading or EOF.
const TODO_HEADING_RE = /^##\s+TODO\s+\(auto-stubbed\b/i;
const H2_HEADING_RE = /^##\s/;
// A top-level list entry (not an indented sub-bullet).
const LIST_ENTRY_RE = /^-\s+/;

/**
 * Single-pass scan of a `FEATURES.md`. Classifies every line as inside a
 * `## TODO (auto-stubbed …)` block or not, and counts the top-level list
 * entries on each side.
 *
 * @param {string} content
 * @returns {{keptLines:string[], backlogEntries:number, backlogBlocks:number, curatedEntries:number}}
 *   `keptLines` — every line NOT inside a TODO block (the TODO headings and
 *   their bodies dropped); `backlogEntries` — top-level entries inside TODO
 *   blocks; `backlogBlocks` — number of TODO blocks; `curatedEntries` —
 *   top-level entries outside any TODO block (i.e. under real categories).
 */
function _scan(content) {
  const out = { keptLines: [], backlogEntries: 0, backlogBlocks: 0, curatedEntries: 0 };
  if (!content || typeof content !== 'string') return out;
  let inTodo = false;
  for (const line of content.split('\n')) {
    if (TODO_HEADING_RE.test(line)) {
      inTodo = true;
      out.backlogBlocks += 1;
      continue; // drop the TODO heading itself
    }
    if (H2_HEADING_RE.test(line)) {
      inTodo = false; // a real category heading ends the backlog block
      out.keptLines.push(line);
      continue;
    }
    if (inTodo) {
      if (LIST_ENTRY_RE.test(line)) out.backlogEntries += 1;
      continue; // drop everything inside the TODO block
    }
    if (LIST_ENTRY_RE.test(line)) out.curatedEntries += 1;
    out.keptLines.push(line);
  }
  return out;
}

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
  const { keptLines, backlogEntries, backlogBlocks } = _scan(content);
  // Collapse 3+ consecutive newlines (left by a removed mid-file block) to a
  // single blank line, and trim leading/trailing whitespace.
  const curated = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { curated, backlogEntries, backlogBlocks };
}

/**
 * Count the top-level entries currently inside `## TODO (auto-stubbed …)`
 * blocks. Counts an entry whether or not it still carries a `<!-- describe -->`
 * marker — a described-but-un-graduated `**TBD**` entry still awaits graduation.
 *
 * @param {string} content
 * @returns {number}
 */
function countTodoEntries(content) {
  return _scan(content).backlogEntries;
}

/**
 * Count the top-level entries that sit OUTSIDE any TODO block — i.e. under a
 * real category heading. Used as the conservation baseline for graduate mode:
 * a correctly filed entry increments this count, a dropped entry does not.
 *
 * @param {string} content
 * @returns {number}
 */
function countCuratedEntries(content) {
  return _scan(content).curatedEntries;
}

module.exports = { summarizeFeatureIndexForPrime, countTodoEntries, countCuratedEntries };
