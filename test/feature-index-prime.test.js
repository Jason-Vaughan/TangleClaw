'use strict';

// Tests for the Feature Index scan (#568) — the pure counters behind the
// session prime's census (`lib/sessions.js`) and graduate mode's conservation
// baseline (`lib/wrap-steps/index-describe.js`). The prime summarizer that
// once lived beside them was removed as runtime-dead (PRM-4H8N, folded into
// #1057): the prime carries a pointer + census, never the curated body.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  countTodoEntries,
  countCuratedEntries,
  censusFeatureIndex,
  formatStubClock,
  MAX_AUTO_STUB_AGE_DAYS
} = require('../lib/feature-index-prime');
const featuresToc = require('../lib/wrap-steps/features-toc');

const TODO = '## TODO (auto-stubbed 2026-07-02)';

describe('feature-index scan counters (#568)', () => {
  it('is null/non-string safe', () => {
    for (const v of [null, undefined, 42, {}]) {
      assert.equal(countTodoEntries(v), 0);
      assert.equal(countCuratedEntries(v), 0);
    }
  });

  it('a file with no TODO backlog counts zero backlog entries', () => {
    const content = '# Feature Index\n\n## UI / Web\n\n- **Pill** — a pill. `lib/pill.js`\n';
    assert.equal(countTodoEntries(content), 0);
    assert.equal(countCuratedEntries(content), 1);
  });

  it('counts TODO-block entries separately from curated ones', () => {
    const content = `# Feature Index\n\n## Server / API\n\n- **Real** — desc. \`r.js\`\n\n${TODO}\n\n`
      + '- **TBD** — touched in this session: `lib/a.js`. <!-- describe -->\n'
      + '- **TBD** — touched in this session: `lib/b.js`. <!-- describe -->\n';
    assert.equal(countTodoEntries(content), 2);
    assert.equal(countCuratedEntries(content), 1);
  });

  it('counts across multiple TODO blocks and stops each at the next real heading', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n\n`
      + '## CLI / Tooling\n\n- **After** — a real one. `b.js`\n\n'
      + '## TODO (auto-stubbed 2026-07-03)\n\n- **TBD** — `c.js`.\n- **TBD** — `d.js`.\n';
    assert.equal(countTodoEntries(content), 3);
    assert.equal(countCuratedEntries(content), 1);
  });

  it('a whitespace/empty file counts zero on both sides', () => {
    assert.equal(countTodoEntries('   \n\n\t \n'), 0);
    assert.equal(countCuratedEntries('   \n\n\t \n'), 0);
  });

  it('an all-backlog file counts zero curated entries', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n- **TBD** — \`b.js\`.\n`;
    assert.equal(countTodoEntries(content), 2);
    assert.equal(countCuratedEntries(content), 0);
  });

  it('indented sub-bullets are not counted as entries', () => {
    const content = `# Feature Index\n\n## UI / Web\n\n- **A** — \`a.js\`\n  - detail line\n\n${TODO}\n\n- **TBD** — \`c.js\`.\n  - detail line\n`;
    assert.equal(countCuratedEntries(content), 1);
    assert.equal(countTodoEntries(content), 1);
  });

  it('parses the ACTUAL features-toc stub format (not just hand-written fixtures)', () => {
    // Pin the parser against the producer's real output so the shared auto-stub
    // contract can't drift silently (#568 / R-6).
    const seeded = featuresToc._appendTodoSection(
      '# Feature Index\n\n## Server / API\n\n- **Existing** — desc. `lib/e.js`\n',
      ['lib/new-a.js', 'lib/new-b.js'],
      '2026-07-20'
    );
    assert.equal(countTodoEntries(seeded), 2, 'both auto-stubbed entries are counted as backlog');
    assert.equal(countCuratedEntries(seeded), 1, 'the pre-existing curated entry is not counted as backlog');
  });
});

describe('censusFeatureIndex / formatStubClock (#1196 — the 14-day auto-stub clock)', () => {
  it('reports MAX_AUTO_STUB_AGE_DAYS as 14 (the test/features-index.test.js guard)', () => {
    assert.equal(MAX_AUTO_STUB_AGE_DAYS, 14);
  });

  it('is null/non-string safe and reports no clock', () => {
    for (const v of [null, undefined, 42, {}]) {
      const census = censusFeatureIndex(v, new Date('2026-07-16T00:00:00'));
      assert.equal(census.backlogBlocks, 0);
      assert.equal(census.oldestBlockDate, null);
      assert.equal(census.oldestAgeDays, null);
      assert.equal(census.daysRemaining, null);
      assert.equal(formatStubClock(census), null);
    }
  });

  it('a file with no TODO backlog carries no clock', () => {
    const content = '# Feature Index\n\n## UI / Web\n\n- **Pill** — a pill. `lib/pill.js`\n';
    const census = censusFeatureIndex(content, new Date('2026-07-16T00:00:00'));
    assert.equal(census.backlogBlocks, 0);
    assert.equal(census.oldestBlockDate, null);
    assert.equal(census.oldestAgeDays, null);
    assert.equal(census.daysRemaining, null);
    assert.equal(formatStubClock(census), null);
  });

  it('a single fresh block reports its date, age, and days remaining', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    // TODO carries 2026-07-02; measure exactly 3 days later.
    const now = new Date('2026-07-05T00:00:00');
    const census = censusFeatureIndex(content, now);
    assert.equal(census.backlogBlocks, 1);
    assert.equal(census.oldestBlockDate, '2026-07-02');
    assert.equal(census.oldestAgeDays, 3);
    assert.equal(census.daysRemaining, 11);
    assert.equal(
      formatStubClock(census),
      '1 auto-stub block, oldest 2026-07-02 — 11 days before the 14-day index guard fails'
    );
  });

  it('picks the OLDEST block across multiple, regardless of file order', () => {
    const content = '# Feature Index\n\n## TODO (auto-stubbed 2026-07-10)\n\n- **TBD** — `a.js`.\n\n'
      + '## CLI / Tooling\n\n- **Real** — `b.js`\n\n'
      + '## TODO (auto-stubbed 2026-07-02)\n\n- **TBD** — `c.js`.\n- **TBD** — `d.js`.\n';
    const census = censusFeatureIndex(content, new Date('2026-07-05T00:00:00'));
    assert.equal(census.backlogBlocks, 2);
    assert.equal(census.oldestBlockDate, '2026-07-02', 'the earlier date wins, even though it is the second block in the file');
    assert.equal(census.oldestAgeDays, 3);
    assert.equal(census.daysRemaining, 11);
  });

  it('a block past the 14-day guard reports a negative daysRemaining and an overdue notice', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    // TODO carries 2026-07-02; measure 20 days later — 6 days past the guard.
    const now = new Date('2026-07-22T00:00:00');
    const census = censusFeatureIndex(content, now);
    assert.equal(census.oldestAgeDays, 20);
    assert.equal(census.daysRemaining, -6);
    assert.equal(
      formatStubClock(census),
      '1 auto-stub block, oldest 2026-07-02 — overdue by 6 days (14-day index guard)'
    );
  });

  it('a block exactly at the 14-day boundary is NOT overdue — matches the real guard\'s strict ">14" failure condition', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    const now = new Date('2026-07-16T00:00:00'); // exactly 14 days after 2026-07-02
    const census = censusFeatureIndex(content, now);
    assert.equal(census.daysRemaining, 0);
    assert.equal(
      formatStubClock(census),
      '1 auto-stub block, oldest 2026-07-02 — 0 days before the 14-day index guard fails',
      'test/features-index.test.js only fails a block when ageDays > 14, so exactly 14 days old must not read as overdue'
    );
  });

  it('a block one day past the boundary (ageDays > 14) IS overdue', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    const now = new Date('2026-07-17T00:00:00'); // 15 days after 2026-07-02
    const census = censusFeatureIndex(content, now);
    assert.equal(census.daysRemaining, -1);
    assert.equal(
      formatStubClock(census),
      '1 auto-stub block, oldest 2026-07-02 — overdue by 1 day (14-day index guard)'
    );
  });

  it('a block whose heading has no parseable date is counted but contributes no clock', () => {
    const content = '# Feature Index\n\n## TODO (auto-stubbed not-a-date)\n\n- **TBD** — `a.js`.\n';
    const census = censusFeatureIndex(content, new Date('2026-07-16T00:00:00'));
    assert.equal(census.backlogBlocks, 1);
    assert.equal(census.backlogEntries, 1);
    assert.equal(census.oldestBlockDate, null);
    assert.equal(census.oldestAgeDays, null);
    assert.equal(census.daysRemaining, null);
    assert.equal(formatStubClock(census), '1 auto-stub block, oldest block date unavailable');
  });

  it('accepts `now` as a raw timestamp number, not only a Date', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    const nowMs = new Date('2026-07-05T00:00:00').getTime();
    const census = censusFeatureIndex(content, nowMs);
    assert.equal(census.oldestAgeDays, 3);
  });

  it('defaults `now` to the real current time when omitted', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n`;
    const census = censusFeatureIndex(content);
    assert.ok(census.oldestAgeDays > 0, 'a 2026-07-02 stub is in the past relative to the real clock');
  });

  it('three blocks pluralizes "blocks" in the notice', () => {
    const content = '## TODO (auto-stubbed 2026-07-02)\n\n- **TBD** — `a.js`.\n\n'
      + '## TODO (auto-stubbed 2026-07-03)\n\n- **TBD** — `b.js`.\n\n'
      + '## TODO (auto-stubbed 2026-07-04)\n\n- **TBD** — `c.js`.\n';
    const census = censusFeatureIndex(content, new Date('2026-07-05T00:00:00'));
    assert.equal(census.backlogBlocks, 3);
    assert.match(formatStubClock(census), /^3 auto-stub blocks, oldest 2026-07-02/);
  });

  it('parses the ACTUAL features-toc stub format for the clock too', () => {
    const seeded = featuresToc._appendTodoSection(
      '# Feature Index\n\n## Server / API\n\n- **Existing** — desc. `lib/e.js`\n',
      ['lib/new-a.js'],
      '2026-07-20'
    );
    const census = censusFeatureIndex(seeded, new Date('2026-07-21T00:00:00'));
    assert.equal(census.oldestBlockDate, '2026-07-20');
    assert.equal(census.oldestAgeDays, 1);
    assert.equal(census.daysRemaining, 13);
  });
});
