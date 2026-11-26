'use strict';

// #3279 (V6-050/V6-051) — end-to-end intake-to-release traceability. Pure
// logic only; no `gh`/network call (`_fetchRealData` is the real I/O and is
// not required or called here, matching this file's own module doc).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseIntakeReferences, buildTraceabilityMatrix, renderMatrixMarkdown } = require('../scripts/verify-intake-traceability');

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
