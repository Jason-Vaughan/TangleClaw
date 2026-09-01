'use strict';

/**
 * Feature Index scan (#568).
 *
 * The session prime used to inline the **entire** `FEATURES.md` under its
 * `## Feature Index` heading. Because the index could never converge — auto
 * `## TODO (auto-stubbed …)` blocks of `- **TBD** — …` entries piled up one
 * per wrap and never graduated into a real category — every session paid the
 * whole file's prime budget for a list where most entries were literally "TBD".
 *
 * That inlining is gone entirely: the prime now carries a POINTER to
 * `FEATURES.md` plus a census, because an index that grows with the project
 * made prime length a function of how much had been authored, and the overflow
 * silently removed whichever directive sorted after it.
 *
 * This module is the single, dependency-free source of truth for parsing that
 * structure. It serves two consumers:
 *   - `lib/sessions.js` builds the prime's census from `countCuratedEntries` +
 *     `countTodoEntries` — counts only, never the body.
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
 * Single-pass scan of a `FEATURES.md`. Classifies every top-level list entry as
 * inside a `## TODO (auto-stubbed …)` block or not, and counts each side.
 *
 * @param {string} content
 * @returns {{backlogEntries:number, backlogBlocks:number, curatedEntries:number}}
 *   `backlogEntries` — top-level entries inside TODO blocks; `backlogBlocks` —
 *   number of TODO blocks; `curatedEntries` — top-level entries outside any
 *   TODO block (i.e. under real categories).
 */
function _scan(content) {
  const out = { backlogEntries: 0, backlogBlocks: 0, curatedEntries: 0 };
  if (!content || typeof content !== 'string') return out;
  let inTodo = false;
  for (const line of content.split('\n')) {
    if (TODO_HEADING_RE.test(line)) {
      inTodo = true;
      out.backlogBlocks += 1;
      continue;
    }
    if (H2_HEADING_RE.test(line)) {
      inTodo = false; // a real category heading ends the backlog block
      continue;
    }
    if (inTodo) {
      if (LIST_ENTRY_RE.test(line)) out.backlogEntries += 1;
      continue;
    }
    if (LIST_ENTRY_RE.test(line)) out.curatedEntries += 1;
  }
  return out;
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

module.exports = { countTodoEntries, countCuratedEntries };
