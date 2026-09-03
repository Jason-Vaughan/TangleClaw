'use strict';

/**
 * The topics the methodology layer owns and TangleClaw's global rules must not
 * legislate (#796).
 *
 * ADR 0011 draws the seam — the plugin owns methodology, TangleClaw consumes
 * it — but names no topics; this is the enumeration. It is ONE list on purpose:
 * the prime tells every session what the plugin owns, and the boundary guard
 * (`test/global-rules-boundary.test.js`) fails CI when `data/global-rules.md`
 * prescribes on one of these. Two hand-typed lists would already have
 * disagreed once (the prime said four topics, the guard checked two).
 *
 * Each entry names the topic for prose and the tells that mean the global
 * rules are prescribing rather than deferring.
 *
 * @type {Array<{topic: string, tells: RegExp[]}>}
 */
const METHODOLOGY_OWNED_TOPICS = [
  {
    topic: 'merge strategy',
    tells: [/--squash\b/, /--rebase\b/, /\bsquash[- ]merg/i, /\brebase[- ]merg/i, /gh pr merge[^\n]*--merge\b/]
  },
  {
    topic: 'commit attribution trailers',
    tells: [/Co-Authored-By/i, /Signed-off-by/i, /Generated with \[?Claude/i]
  }
];

module.exports = { METHODOLOGY_OWNED_TOPICS };
