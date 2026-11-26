'use strict';

// #3279 (V6-050/V6-051) — end-to-end intake-to-release traceability. Pure
// logic only; no `gh`/network call (`_fetchRealData` is the real I/O and is
// not required or called here, matching this file's own module doc).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseIntakeReferences, buildTraceabilityMatrix, renderMatrixMarkdown,
  V6_REQUIREMENTS_LEDGER, buildLedgerTraceability, renderLedgerMarkdown
} = require('../scripts/verify-intake-traceability');

describe('parseIntakeReferences', () => {
  it('extracts a single backtick-fenced intake reference, as most issues write it', () => {
    assert.deepEqual(parseIntakeReferences('## Intake Reference: `V6-026` (E05 — Engine Compatibility)\n\n### Problem'), ['V6-026']);
  });

  it('extracts every reference on a plural "References" heading joined by "&" (issue #3279\'s own shape)', () => {
    assert.deepEqual(parseIntakeReferences('## Intake References: `V6-050` & `V6-051` (E10 — Historical Requirements)\n\n### Problem'), ['V6-050', 'V6-051']);
  });

  it('returns an empty array for a body with no intake reference, or a non-string body', () => {
    assert.deepEqual(parseIntakeReferences('Just a plain bug report, no intake section.'), []);
    assert.deepEqual(parseIntakeReferences(null), []);
    assert.deepEqual(parseIntakeReferences(undefined), []);
  });

  it('does not pick up a backtick-fenced V6-NNN from an unrelated line', () => {
    assert.deepEqual(parseIntakeReferences('Some other line mentions `V6-099` in passing, not as a heading.'), []);
  });
});

describe('buildTraceabilityMatrix', () => {
  const ISSUES = [
    { number: 3270, title: 'usage popover', state: 'CLOSED', body: 'Intake Reference: `V6-026`\n...' },
    { number: 3276, title: 'composer dead space', state: 'CLOSED', body: 'Intake Reference: `V6-040`\n...' },
    { number: 3265, title: 'fleet sdlc policy', state: 'OPEN', body: 'Intake Reference: `V6-016`\n...' },
    { number: 3279, title: 'requirements audit', state: 'OPEN', body: 'Intake References: `V6-050` & `V6-051`\n...' },
    { number: 9999, title: 'no intake ref at all', state: 'OPEN', body: 'Just a bug, no reference.' }
  ];

  it('rejects malformed inputs', () => {
    assert.throws(() => buildTraceabilityMatrix('not-an-array', new Set()), TypeError);
    assert.throws(() => buildTraceabilityMatrix([], []), TypeError);
  });

  it('builds one row per issue, each carrying every intake ref it declares and its shipped status', () => {
    const m = buildTraceabilityMatrix(ISSUES, new Set([3270, 3276]));
    assert.equal(m.rows.length, 5);
    const row3270 = m.rows.find((r) => r.issueNumber === 3270);
    assert.deepEqual(row3270.intakeRefs, ['V6-026']);
    assert.equal(row3270.shipped, true);
    const row3279 = m.rows.find((r) => r.issueNumber === 3279);
    assert.deepEqual(row3279.intakeRefs, ['V6-050', 'V6-051']);
    const row3265 = m.rows.find((r) => r.issueNumber === 3265);
    assert.equal(row3265.shipped, false);
  });

  it('flags issues with no intake reference at all', () => {
    const m = buildTraceabilityMatrix(ISSUES, new Set());
    assert.deepEqual(m.missingIntakeRef, [9999]);
  });

  it('flags a CLOSED issue with no shipped evidence, but never an OPEN one', () => {
    const closedNoShip = [{ number: 1, title: 'closed, no evidence', state: 'CLOSED', body: 'Intake Reference: `V6-001`' }];
    const m = buildTraceabilityMatrix(closedNoShip, new Set());
    assert.deepEqual(m.closedWithoutShippedEvidence, [1]);

    const openNoShip = [{ number: 2, title: 'open, no evidence yet', state: 'OPEN', body: 'Intake Reference: `V6-002`' }];
    const m2 = buildTraceabilityMatrix(openNoShip, new Set());
    assert.deepEqual(m2.closedWithoutShippedEvidence, [], 'an open issue is not expected to have shipped yet');
  });

  it('summarizes totals correctly', () => {
    const m = buildTraceabilityMatrix(ISSUES, new Set([3270, 3276]));
    assert.deepEqual(m.summary, { total: 5, withIntakeRef: 4, shipped: 2 });
  });
});

describe('renderMatrixMarkdown', () => {
  it('names every scanned issue, flags gaps, and never crashes on a title containing a pipe', () => {
    const m = buildTraceabilityMatrix(
      [{ number: 1, title: 'a | pipe in the title', state: 'OPEN', body: 'no ref' }],
      new Set()
    );
    const md = renderMatrixMarkdown(m, '2026-11-26T00:00:00.000Z');
    assert.match(md, /# V6 Requirements Traceability Matrix/);
    assert.match(md, /#1/);
    assert.match(md, /a \\\| pipe in the title/);
    assert.match(md, /Missing an `Intake Reference`: #1/);
  });

  it('renders multiple intake refs on one row joined by a comma', () => {
    const m = buildTraceabilityMatrix(
      [{ number: 3279, title: 'requirements audit', state: 'OPEN', body: 'Intake References: `V6-050` & `V6-051`' }],
      new Set()
    );
    const md = renderMatrixMarkdown(m, '2026-11-26T00:00:00.000Z');
    assert.match(md, /V6-050, V6-051/);
  });
});

describe('V6_REQUIREMENTS_LEDGER (the authoritative 51-item intake ledger)', () => {
  it('has exactly 51 entries, V6-001 through V6-051, each with a unique id', () => {
    assert.equal(V6_REQUIREMENTS_LEDGER.length, 51);
    const ids = new Set(V6_REQUIREMENTS_LEDGER.map((e) => e.id));
    assert.equal(ids.size, 51, 'every id must be unique');
    assert.ok(ids.has('V6-001'));
    assert.ok(ids.has('V6-051'));
  });

  it('every entry names at least one real issue number and a workstream', () => {
    for (const entry of V6_REQUIREMENTS_LEDGER) {
      assert.ok(Array.isArray(entry.issues) && entry.issues.length > 0, `${entry.id} must name at least one issue`);
      assert.match(entry.workstream, /^E\d{2}$/, `${entry.id}'s workstream must be E01-E10`);
      assert.equal(typeof entry.gateFourApplies, 'boolean', `${entry.id} must declare whether Gate 4 applies`);
    }
  });
});

describe('buildLedgerTraceability', () => {
  const FAKE_LEDGER = [
    { id: 'V6-A', workstream: 'E01', title: 'Shippable item', classification: 'Actionable Enhancement', issues: [100], gateFourApplies: true },
    { id: 'V6-B', workstream: 'E01', title: 'Design review item', classification: 'Collaborative Design', issues: [101], gateFourApplies: false },
    { id: 'V6-C', workstream: 'E01', title: 'Multi-issue shippable item', classification: 'Actionable Enhancement', issues: [102, 103], gateFourApplies: true }
  ];
  /** A fetched issue with a milestone, the common case these tests build on. */
  const withMilestone = (state = 'OPEN') => ({ state, milestone: 'v6.6.1' });

  it('rejects malformed inputs', () => {
    assert.throws(() => buildLedgerTraceability('not-an-array', new Map(), new Set()), TypeError);
    assert.throws(() => buildLedgerTraceability([], [], new Set()), TypeError);
    assert.throws(() => buildLedgerTraceability([], new Map(), []), TypeError);
    assert.throws(() => buildLedgerTraceability([], new Map(), new Set(), []), TypeError);
  });

  it('Gate 1 is complete only when every one of an entry\'s issues was fetched AND carries a milestone', () => {
    const states = new Map([[100, withMilestone()], [101, withMilestone()]]);
    const m = buildLedgerTraceability(FAKE_LEDGER, states, new Set());
    const a = m.rows.find((r) => r.id === 'V6-A');
    const c = m.rows.find((r) => r.id === 'V6-C');
    assert.equal(a.gateOneComplete, true);
    assert.equal(c.gateOneComplete, false, 'issue 103 was never fetched, so Gate 1 is incomplete');
    assert.deepEqual(m.gateOneIncomplete, ['V6-C']);
  });

  it('PRR-B R2 BLOCKING 1: an issue that exists but has NO milestone is Gate 1 incomplete, not complete', () => {
    const states = new Map([[100, { state: 'OPEN', milestone: null }]]);
    const m = buildLedgerTraceability([FAKE_LEDGER[0]], states, new Set());
    const a = m.rows.find((r) => r.id === 'V6-A');
    assert.equal(a.gateOneComplete, false, 'issue exists but has no milestone -- Gate 1 must not read this as complete');
  });

  it('Gate 4 reads n/a for a design-review entry, regardless of shipped evidence', () => {
    const states = new Map([[100, withMilestone()], [101, withMilestone()], [102, withMilestone()], [103, withMilestone()]]);
    const m = buildLedgerTraceability(FAKE_LEDGER, states, new Set());
    const b = m.rows.find((r) => r.id === 'V6-B');
    assert.equal(b.gateFour, 'n/a');
  });

  it('Gate 4 requires every one of a shippable entry\'s issues to be shipped for "complete"', () => {
    const states = new Map([[100, withMilestone()], [102, withMilestone()], [103, withMilestone()]]);
    const partiallyShipped = buildLedgerTraceability(FAKE_LEDGER, states, new Set([102]));
    const c1 = partiallyShipped.rows.find((r) => r.id === 'V6-C');
    assert.equal(c1.gateFour, 'incomplete', '103 is not shipped, so a multi-issue entry is not complete');

    const fullyShipped = buildLedgerTraceability(FAKE_LEDGER, states, new Set([100, 102, 103]));
    const a2 = fullyShipped.rows.find((r) => r.id === 'V6-A');
    const c2 = fullyShipped.rows.find((r) => r.id === 'V6-C');
    assert.equal(a2.gateFour, 'complete');
    assert.equal(c2.gateFour, 'complete');
    assert.deepEqual(fullyShipped.gateFourIncomplete, []);
  });

  it('PRR-B R2 BLOCKING 2: a changelog.d fragment or open-PR reference alone reads "in-flight", never "complete"', () => {
    const states = new Map([[100, withMilestone()]]);
    const m = buildLedgerTraceability([FAKE_LEDGER[0]], states, new Set(), new Set([100]));
    const a = m.rows.find((r) => r.id === 'V6-A');
    assert.equal(a.gateFour, 'in-flight', 'in-flight evidence must not be conflated with genuinely shipped');
    assert.deepEqual(m.gateFourIncomplete, [], 'in-flight is real progress, not a reported gap');
  });

  it('with neither shipped nor in-flight evidence, Gate 4 reads "incomplete" -- a real, reportable gap', () => {
    const states = new Map([[100, withMilestone()]]);
    const m = buildLedgerTraceability([FAKE_LEDGER[0]], states, new Set(), new Set());
    const a = m.rows.find((r) => r.id === 'V6-A');
    assert.equal(a.gateFour, 'incomplete');
    assert.deepEqual(m.gateFourIncomplete, ['V6-A']);
  });

  it('a multi-issue entry with one shipped and one only in-flight reads "in-flight" overall, not "complete"', () => {
    const states = new Map([[102, withMilestone()], [103, withMilestone()]]);
    const m = buildLedgerTraceability([FAKE_LEDGER[2]], states, new Set([102]), new Set([103]));
    const c = m.rows.find((r) => r.id === 'V6-C');
    assert.equal(c.gateFour, 'in-flight');
  });

  it('a CLOSED issue counts as shipped for the ledger\'s own Gate 4, even with empty shippedIssueNumbers (merge precedes the formal release cut)', () => {
    const states = new Map([[100, withMilestone('CLOSED')]]);
    const m = buildLedgerTraceability([FAKE_LEDGER[0]], states, new Set(), new Set());
    const a = m.rows.find((r) => r.id === 'V6-A');
    assert.equal(a.gateFour, 'complete');
  });

  it('closure alone does not feed back into shippedIssueNumbers itself -- a separate caller\'s own set is untouched', () => {
    const shippedIssueNumbers = new Set();
    const states = new Map([[100, withMilestone('CLOSED')]]);
    buildLedgerTraceability([FAKE_LEDGER[0]], states, shippedIssueNumbers);
    assert.equal(shippedIssueNumbers.size, 0, 'buildLedgerTraceability must not mutate its caller\'s Set');
  });
});

describe('renderLedgerMarkdown', () => {
  it('names every entry and flags both kinds of gap', () => {
    const states = new Map([[101, { state: 'OPEN', milestone: 'v6.6.1' }]]);
    const m = buildLedgerTraceability(
      [
        { id: 'V6-X', workstream: 'E01', title: 'Missing issue', classification: 'Actionable Enhancement', issues: [999], gateFourApplies: true },
        { id: 'V6-Y', workstream: 'E01', title: 'Not shipped', classification: 'Actionable Enhancement', issues: [101], gateFourApplies: true }
      ],
      states,
      new Set()
    );
    const md = renderLedgerMarkdown(m);
    assert.match(md, /V6-X/);
    assert.match(md, /V6-Y/);
    assert.match(md, /Gate 1 incomplete: V6-X/);
    // V6-X is incomplete on BOTH gates (its issue was never fetched, so it
    // can't be shipped either); V6-Y is Gate 1 complete but not yet shipped
    // (and has no in-flight evidence either, in this test).
    assert.match(md, /Gate 4 incomplete: V6-X, V6-Y/);
  });

  it('renders "in-flight" distinctly from "complete" and "incomplete" in the table itself', () => {
    const states = new Map([[100, { state: 'OPEN', milestone: 'v6.6.1' }]]);
    const m = buildLedgerTraceability(
      [{ id: 'V6-Z', workstream: 'E01', title: 'In progress', classification: 'Actionable Enhancement', issues: [100], gateFourApplies: true }],
      states,
      new Set(),
      new Set([100])
    );
    const md = renderLedgerMarkdown(m);
    assert.match(md, /\| V6-Z \|.*\| in-flight \|/);
  });
});
