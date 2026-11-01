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
 * structure. It serves three consumers:
 *   - `lib/sessions.js` builds the prime's census from `countCuratedEntries` +
 *     `countTodoEntries` — counts only, never the body.
 *   - `lib/wrap-steps/index-describe.js` (graduate mode) uses the same scan to
 *     count backlog entries (its trigger) and curated entries (its honest
 *     graduated count), rather than re-implementing the block parse.
 *   - `censusFeatureIndex` / `formatStubClock` (#1196) add the deadline clock:
 *     the counts alone say a stub pile exists, not how close it is to the
 *     14-day `test/features-index.test.js` guard going red.
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
// Same heading, but captures the date when the producer's format is intact
// (`lib/wrap-steps/features-toc.js`'s `AUTOSTUB_HEADING_RE`). A block whose
// heading doesn't carry a well-formed date is still counted by `_scan` above,
// it just can't contribute to the clock.
const TODO_HEADING_DATE_RE = /^##\s+TODO\s+\(auto-stubbed\s+(\d{4}-\d{2}-\d{2})\)/i;
const H2_HEADING_RE = /^##\s/;
// A top-level list entry (not an indented sub-bullet).
const LIST_ENTRY_RE = /^-\s+/;

// The same deadline `test/features-index.test.js` enforces: a block older
// than this many days fails the required CI check.
const MAX_AUTO_STUB_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Single-pass scan of a `FEATURES.md`. Classifies every top-level list entry as
 * inside a `## TODO (auto-stubbed …)` block or not, counts each side, and
 * collects every block's date (when its heading carries one).
 *
 * @param {string} content
 * @returns {{backlogEntries:number, backlogBlocks:number, curatedEntries:number, blockDates:string[]}}
 *   `backlogEntries` — top-level entries inside TODO blocks; `backlogBlocks` —
 *   number of TODO blocks; `curatedEntries` — top-level entries outside any
 *   TODO block (i.e. under real categories); `blockDates` — each block's
 *   `YYYY-MM-DD`, in file order, omitting any block whose heading didn't parse.
 */
function _scan(content) {
  const out = { backlogEntries: 0, backlogBlocks: 0, curatedEntries: 0, blockDates: [] };
  if (!content || typeof content !== 'string') return out;
  let inTodo = false;
  for (const line of content.split('\n')) {
    if (TODO_HEADING_RE.test(line)) {
      inTodo = true;
      out.backlogBlocks += 1;
      const dateMatch = TODO_HEADING_DATE_RE.exec(line);
      if (dateMatch) out.blockDates.push(dateMatch[1]);
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

/**
 * Full census of a `FEATURES.md`, including the 14-day auto-stub clock
 * (#1196): the oldest backlog block's date, its age, and how many days
 * remain before `test/features-index.test.js`'s required CI check fails on
 * it. The counts alone (`countTodoEntries`/`countCuratedEntries`) say a pile
 * exists; this says how close it is to going red.
 *
 * @param {string} content
 * @param {Date|number} [now] - clock to measure age against; defaults to the
 *   real current time. Pass a fixed `Date`/timestamp for deterministic tests.
 * @returns {{
 *   backlogEntries: number, backlogBlocks: number, curatedEntries: number,
 *   oldestBlockDate: string|null, oldestAgeDays: number|null,
 *   daysRemaining: number|null
 * }}
 *   `oldestBlockDate`/`oldestAgeDays`/`daysRemaining` are `null` when there is
 *   no backlog block, or none of them carried a parseable date.
 *   `daysRemaining` is signed: 0 or negative means the guard has already (or
 *   is about to) fail on it — it is never clamped to 0, so overdue stays
 *   visible rather than reading as "right at the deadline".
 */
function censusFeatureIndex(content, now) {
  const scan = _scan(content);
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());

  let oldestBlockDate = null;
  let oldestAgeDays = null;
  let daysRemaining = null;
  if (scan.blockDates.length > 0) {
    // Lexicographic order matches chronological order for `YYYY-MM-DD`.
    oldestBlockDate = scan.blockDates.slice().sort()[0];
    oldestAgeDays = (nowMs - new Date(`${oldestBlockDate}T00:00:00`).getTime()) / MS_PER_DAY;
    daysRemaining = MAX_AUTO_STUB_AGE_DAYS - oldestAgeDays;
  }

  return {
    backlogEntries: scan.backlogEntries,
    backlogBlocks: scan.backlogBlocks,
    curatedEntries: scan.curatedEntries,
    oldestBlockDate,
    oldestAgeDays,
    daysRemaining
  };
}

/**
 * Render a census's auto-stub clock as the one-line notice described in
 * #1196: `"N auto-stub block(s), oldest YYYY-MM-DD — N day(s) before the
 * 14-day index guard fails"`, or an overdue variant once `daysRemaining` is
 * negative — matching `test/features-index.test.js`'s own guard, which
 * fails a block only when its age is STRICTLY greater than 14 days, so a
 * block exactly at the boundary (`daysRemaining === 0`) still reads as
 * "0 days before … fails", not overdue.
 *
 * @param {ReturnType<typeof censusFeatureIndex>} census
 * @returns {string|null} `null` when there is no backlog block to report.
 */
function formatStubClock(census) {
  if (!census || census.backlogBlocks === 0) return null;
  const blockWord = census.backlogBlocks === 1 ? 'block' : 'blocks';
  const prefix = `${census.backlogBlocks} auto-stub ${blockWord}`;

  if (census.oldestBlockDate === null) {
    return `${prefix}, oldest block date unavailable`;
  }
  // test/features-index.test.js's own guard fails a block only when
  // `ageDays > MAX_AUTO_STUB_AGE_DAYS` (strictly greater) — a block exactly
  // AT the boundary (`daysRemaining === 0`) still passes that guard, so it
  // must not read as "overdue" here either. Only `daysRemaining < 0`
  // (`ageDays > 14`) is overdue.
  if (census.daysRemaining < 0) {
    const overdueDays = Math.ceil(Math.abs(census.daysRemaining));
    const dayWord = overdueDays === 1 ? 'day' : 'days';
    return `${prefix}, oldest ${census.oldestBlockDate} — overdue by ${overdueDays} ${dayWord} (14-day index guard)`;
  }
  const remainingDays = Math.floor(census.daysRemaining);
  const dayWord = remainingDays === 1 ? 'day' : 'days';
  return `${prefix}, oldest ${census.oldestBlockDate} — ${remainingDays} ${dayWord} before the 14-day index guard fails`;
}

module.exports = {
  countTodoEntries,
  countCuratedEntries,
  censusFeatureIndex,
  formatStubClock,
  MAX_AUTO_STUB_AGE_DAYS
};
