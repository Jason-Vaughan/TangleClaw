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
  countCuratedEntries
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
