'use strict';

// Tests for the Feature Index prime summarizer (#568) — the pure function that
// caps what `FEATURES.md` contributes to the session prime: curated categories
// inline, the auto-stubbed TODO backlog reduced to a count.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeFeatureIndexForPrime,
  countTodoEntries,
  countCuratedEntries
} = require('../lib/feature-index-prime');
const featuresToc = require('../lib/wrap-steps/features-toc');

const TODO = '## TODO (auto-stubbed 2026-07-02)';

describe('summarizeFeatureIndexForPrime (#568)', () => {
  it('is null/non-string safe', () => {
    for (const v of [null, undefined, 42, {}]) {
      assert.deepEqual(summarizeFeatureIndexForPrime(v), { curated: '', backlogEntries: 0, backlogBlocks: 0 });
    }
  });

  it('returns curated content unchanged when there is no TODO backlog', () => {
    const content = '# Feature Index\n\n## UI / Web\n\n- **Pill** — a pill. `lib/pill.js`\n';
    const { curated, backlogEntries, backlogBlocks } = summarizeFeatureIndexForPrime(content);
    assert.match(curated, /## UI \/ Web/);
    assert.match(curated, /\*\*Pill\*\*/);
    assert.equal(backlogEntries, 0);
    assert.equal(backlogBlocks, 0);
  });

  it('strips the TODO block and counts its entries', () => {
    const content = `# Feature Index\n\n## Server / API\n\n- **Real** — desc. \`r.js\`\n\n${TODO}\n\n`
      + '- **TBD** — touched in this session: `lib/a.js`. <!-- describe -->\n'
      + '- **TBD** — touched in this session: `lib/b.js`. <!-- describe -->\n';
    const { curated, backlogEntries, backlogBlocks } = summarizeFeatureIndexForPrime(content);
    // Curated keeps the real category + entry...
    assert.match(curated, /## Server \/ API/);
    assert.match(curated, /\*\*Real\*\*/);
    // ...and drops the TODO heading + its TBD entries entirely.
    assert.doesNotMatch(curated, /TODO \(auto-stubbed/);
    assert.doesNotMatch(curated, /\*\*TBD\*\*/);
    assert.doesNotMatch(curated, /lib\/a\.js/);
    assert.equal(backlogEntries, 2);
    assert.equal(backlogBlocks, 1);
  });

  it('counts across multiple TODO blocks and stops each at the next real heading', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n\n`
      + '## CLI / Tooling\n\n- **After** — a real one. `b.js`\n\n'
      + '## TODO (auto-stubbed 2026-07-03)\n\n- **TBD** — `c.js`.\n- **TBD** — `d.js`.\n';
    const { curated, backlogEntries, backlogBlocks } = summarizeFeatureIndexForPrime(content);
    assert.match(curated, /## CLI \/ Tooling/);
    assert.match(curated, /\*\*After\*\*/);
    assert.doesNotMatch(curated, /\*\*TBD\*\*/);
    assert.equal(backlogEntries, 3);
    assert.equal(backlogBlocks, 2);
  });

  it('collapses the blank-line gap a removed mid-file block leaves', () => {
    const content = `# Feature Index\n\n## UI / Web\n\n- **X** — \`x.js\`\n\n${TODO}\n\n- **TBD** — \`y.js\`.\n\n## Server / API\n\n- **Z** — \`z.js\`\n`;
    const { curated } = summarizeFeatureIndexForPrime(content);
    assert.doesNotMatch(curated, /\n{3,}/, 'no 3+ consecutive newlines after removing the block');
    assert.match(curated, /## UI \/ Web/);
    assert.match(curated, /## Server \/ API/);
  });

  it('a whitespace/empty file yields empty curated and a zero backlog', () => {
    assert.deepEqual(summarizeFeatureIndexForPrime('   \n\n\t \n'), { curated: '', backlogEntries: 0, backlogBlocks: 0 });
  });

  it('an all-backlog file yields curated with only the header and a nonzero count', () => {
    const content = `# Feature Index\n\n${TODO}\n\n- **TBD** — \`a.js\`.\n- **TBD** — \`b.js\`.\n`;
    const { curated, backlogEntries, backlogBlocks } = summarizeFeatureIndexForPrime(content);
    assert.equal(curated, '# Feature Index');
    assert.equal(backlogEntries, 2);
    assert.equal(backlogBlocks, 1);
  });

  it('counts curated entries outside any TODO block', () => {
    const content = `# Feature Index\n\n## UI / Web\n\n- **A** — \`a.js\`\n- **B** — \`b.js\`\n\n${TODO}\n\n- **TBD** — \`c.js\`.\n`;
    assert.equal(countCuratedEntries(content), 2);
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
    const { curated, backlogEntries, backlogBlocks } = summarizeFeatureIndexForPrime(seeded);
    assert.match(curated, /\*\*Existing\*\*/);
    assert.doesNotMatch(curated, /new-a\.js/, 'auto-stubbed paths are stripped from the prime');
    assert.equal(backlogEntries, 2);
    assert.equal(backlogBlocks, 1);
  });
});
