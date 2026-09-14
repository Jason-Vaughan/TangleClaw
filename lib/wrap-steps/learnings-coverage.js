'use strict';

/**
 * Satisfaction predicate `learnings-entry` for the `learnings-capture` wrap step.
 *
 * The step's gate asks "did the AI change learnings.md while this step ran?" That
 * is the wrong question for an entry that already landed: the session wrote it
 * while preparing to wrap, or the AI finished it after a blocked attempt and the
 * operator pressed Retry. The file carries the entry, nothing changes during the
 * step, and the gate blocks. The only way through was writing more, which the
 * step's own prompt forbids (#843, #1405).
 *
 * This predicate answers "does the file already carry this session's entry?"
 * Both of these must hold:
 *
 *   1. **Written this session** — the file's modification time is at or after the
 *      session's start. An old file nobody touched cannot satisfy the step.
 *   2. **A dated entry inside the session** — a `## YYYY-MM-DD` heading, or the
 *      prompt's no-op line `- YYYY-MM-DD: no novel learnings`, dated on or after
 *      the session's start day and no later than today (local dates, the prompt's
 *      convention). A write that added no entry cannot satisfy the step.
 *
 * Each condition closes the other's hole: a modification time alone credits any
 * edit, and a date alone credits a previous session's entry from earlier today.
 * The remaining limit is an edit that adds no entry while a same-day entry from a
 * previous session is still in the file. It passes, because nothing records the
 * file's content at launch for a path git ignores. The cost is a missing learning,
 * not lost work.
 *
 * The gate stays hard: this is evidence in the file, the same second route
 * `changelog-coverage` gives `changelog-update`, not a waiver. A session whose
 * start time is unknown gets `unavailable`, and the gate falls back to the
 * mutation check.
 *
 * @module lib/wrap-steps/learnings-coverage
 */

const fs = require('node:fs');
const path = require('node:path');
const { isoLocalDate } = require('./_date');

const VERDICTS = Object.freeze({
  COVERED: 'covered',
  UNCOVERED: 'uncovered',
  UNAVAILABLE: 'unavailable'
});

const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;
const NO_OP_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s*no novel learnings/i;

/**
 * The entry dates a learnings file carries, in file order.
 *
 * @param {string} content - File content
 * @returns {string[]} `YYYY-MM-DD` dates from entry headings and no-op lines
 */
function entryDates(content) {
  const dates = [];
  for (const line of String(content).split(/\r?\n/)) {
    const m = HEADING_RE.exec(line) || NO_OP_RE.exec(line);
    if (m) dates.push(m[1]);
  }
  return dates;
}

/**
 * Judge whether the declared learnings file already carries this session's entry.
 *
 * @param {string} projectPath - Absolute root the paths are relative to
 * @param {string[]} paths - The step's `verifyChanged` paths
 * @param {object|null} scope - The wrap run's scope; `startedAtMs` is the session start
 * @param {object} [deps] - Test seams: `{stat, read, now}`
 * @returns {{verdict: string, path: (string|null), entryDate: (string|null), reason: (string|null)}}
 */
function evaluate(projectPath, paths, scope, deps = {}) {
  const stat = deps.stat || ((p) => fs.statSync(p));
  const read = deps.read || ((p) => fs.readFileSync(p, 'utf8'));
  const now = deps.now || (() => Date.now());

  const startedAtMs = scope && Number.isFinite(scope.startedAtMs) ? scope.startedAtMs : null;
  if (startedAtMs === null) {
    return { verdict: VERDICTS.UNAVAILABLE, path: null, entryDate: null, reason: 'the session start time is unknown' };
  }

  const fromDate = isoLocalDate(startedAtMs);
  const toDate = isoLocalDate(now());
  const reasons = [];

  for (const rel of paths) {
    const abs = path.join(projectPath, rel);
    let mtimeMs;
    let content;
    try {
      mtimeMs = stat(abs).mtimeMs;
      content = read(abs);
    } catch (err) {
      reasons.push(`${rel} could not be read (${err.code || err.message})`);
      continue;
    }
    if (!(mtimeMs >= startedAtMs)) {
      reasons.push(`${rel} has not been written since this session started`);
      continue;
    }
    const inSession = entryDates(content).filter((d) => d >= fromDate && d <= toDate);
    if (inSession.length === 0) {
      reasons.push(fromDate === toDate
        ? `${rel} carries no entry dated ${toDate}`
        : `${rel} carries no entry dated ${fromDate} through ${toDate}`);
      continue;
    }
    return { verdict: VERDICTS.COVERED, path: rel, entryDate: inSession[inSession.length - 1], reason: null };
  }

  return { verdict: VERDICTS.UNCOVERED, path: null, entryDate: null, reason: reasons.join('; ') || 'no path declared' };
}

module.exports = { evaluate, entryDates, VERDICTS };
