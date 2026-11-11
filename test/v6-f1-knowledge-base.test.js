'use strict';

// v6.1 (#2997, V6-27 / F1, Car V61-W1-C): the version-aware knowledge base
// and contextual help over #811's manual manifest. Pure functions over
// synthetic pages, plus one pass over this repo's real docs/manual-manifest.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kbm = require('../lib/v6/f1-knowledge-base');
const productManual = require('../lib/product-manual');

const ROOT = path.join(__dirname, '..');

const SETUP_MD = [
  '# Setup',
  'Install on a supported host.',
  '## Install',
  'Run the installer, then open the landing page.',
  '### Prerequisites',
  'Node 22 or newer.',
  '```bash',
  '# not a heading',
  '```',
  '## Recovery',
  'Recover safely by restarting the server.',
  '## Recovery',
  'A second recovery section with the same heading.'
].join('\n');

const AGENT_MD = ['# Agent notes', 'Agents read only fragments.', '## Retrieval', 'Fetch install fragments by anchor.'].join('\n');

/** A minimal valid manual manifest over the two synthetic pages. */
function manifest() {
  return {
    schema: 'tc.manual-manifest/v1',
    pages: [
      { id: 'setup', path: 'docs/setup.md', title: 'Setup Guide', audience: ['human', 'nhe'], surfaces: ['public/setup*.js'], sections: [] },
      { id: 'agent', path: 'docs/agent.md', title: 'Agent Notes', audience: ['nhe'], surfaces: ['lib/agent/**'], sections: [] }
    ]
  };
}

/** @returns {object} A knowledge base with 6.0.0 and 6.1.0 snapshots. */
function twoVersionKb() {
  const old = kbm.buildSnapshot(manifest(), { 'docs/setup.md': '# Setup\n## Install\nOld installer steps.', 'docs/agent.md': AGENT_MD }, '6.0.0');
  const cur = kbm.buildSnapshot(manifest(), { 'docs/setup.md': SETUP_MD, 'docs/agent.md': AGENT_MD }, '6.1.0');
  return kbm.createKnowledgeBase([old, cur]);
}

const HUMAN = { audience: 'human', budgetTokens: 400 };
const NHE = { audience: 'nhe', budgetTokens: 400 };

describe('sectionsOf', () => {
  it('cuts at headings no deeper than sectionDepth, keeping deeper ones inside', () => {
    const s = kbm.sectionsOf(SETUP_MD, 2);
    assert.deepEqual(s.map((x) => x.anchor), ['setup', 'install', 'recovery', 'recovery-1']);
    assert.match(s[1].text, /### Prerequisites\nNode 22/);
  });

  it('never reads a line inside a code fence as a heading', () => {
    const s = kbm.sectionsOf(SETUP_MD, 6);
    assert.ok(!s.some((x) => x.heading === 'not a heading'));
    assert.ok(s.some((x) => x.anchor === 'prerequisites'));
  });

  it('uses the anchors product-manual#extractHeadings assigns', () => {
    const expected = productManual.extractHeadings(SETUP_MD).filter((h) => h.level <= 2).map((h) => h.anchor);
    assert.deepEqual(kbm.sectionsOf(SETUP_MD, 2).map((x) => x.anchor), expected);
  });
});

describe('buildSnapshot / createKnowledgeBase', () => {
  it('reports a page with no supplied text instead of indexing it empty', () => {
    const snap = kbm.buildSnapshot(manifest(), { 'docs/setup.md': SETUP_MD }, '6.1.0');
    assert.deepEqual(snap.missingPages, ['agent']);
    assert.ok(snap.sections.every((s) => s.pageId === 'setup' && s.version === '6.1.0'));
  });

  it('refuses a malformed version, an invalid manifest, and duplicate snapshot versions', () => {
    assert.throws(() => kbm.buildSnapshot(manifest(), {}, 'v6'), TypeError);
    assert.throws(() => kbm.buildSnapshot({ schema: 'nope', pages: [] }, {}, '6.1.0'), productManual.ProductManualError);
    const s = kbm.buildSnapshot(manifest(), {}, '6.1.0');
    assert.throws(() => kbm.createKnowledgeBase([s, s]), /two snapshots/);
    assert.throws(() => kbm.createKnowledgeBase([]), TypeError);
  });
});

describe('resolveSnapshot (version awareness)', () => {
  const kb = twoVersionKb();

  it('picks the exact version, the nearest older one with usedFallback, or the newest when unnamed', () => {
    assert.equal(kbm.resolveSnapshot(kb, '6.1.0').snapshot.version, '6.1.0');
    const between = kbm.resolveSnapshot(kb, '6.0.5');
    assert.equal(between.snapshot.version, '6.0.0');
    assert.equal(between.usedFallback, true);
    assert.equal(kbm.resolveSnapshot(kb).snapshot.version, '6.1.0');
    assert.equal(kbm.resolveSnapshot(kb, '7.0.0').snapshot.version, '6.1.0');
  });

  it('never substitutes a newer snapshot for an older version', () => {
    assert.equal(kbm.resolveSnapshot(kb, '5.9.0').code, 'VERSION_NOT_COVERED');
    assert.equal(kbm.resolveSnapshot(kb, 'latest').code, 'VERSION_INVALID');
  });
});

describe('search', () => {
  const kb = twoVersionKb();

  it('returns stable citations tagged with the version they were read from', () => {
    const out = kbm.search(kb, 'installer', { ...HUMAN, version: '6.1.0' });
    assert.equal(out.ok, true);
    assert.equal(out.schema, kbm.SEARCH_SCHEMA);
    assert.equal(out.results[0].citation, 'setup#install');
    assert.equal(out.results[0].version, '6.1.0');
    const old = kbm.search(kb, 'installer', { ...HUMAN, version: '6.0.0' });
    assert.equal(old.results[0].version, '6.0.0');
    assert.match(old.results[0].text, /Old installer/);
  });

  it('filters by audience before ranking, so an nhe-only page never reaches a human', () => {
    const human = kbm.search(kb, 'fragments anchor', HUMAN);
    assert.ok(human.results.every((r) => r.pageId !== 'agent'));
    const agent = kbm.search(kb, 'fragments anchor', NHE);
    assert.ok(agent.results.some((r) => r.pageId === 'agent'));
  });

  it('is deterministic and stays inside its budget, truncating and counting what does not fit', () => {
    const ctx = { audience: 'human', budgetTokens: 12 };
    const a = kbm.search(kb, 'recovery', ctx);
    assert.deepEqual(a, kbm.search(kb, 'recovery', ctx));
    assert.ok(a.usedTokens <= 12);
    assert.ok(a.results[0].truncated);
    assert.ok(a.omittedForBudget >= 1);
  });

  it('reports token reduction against the readable corpus', () => {
    const out = kbm.search(kb, 'installer', { audience: 'human', budgetTokens: 20 });
    assert.ok(out.tokenReduction.corpusTokens > out.tokenReduction.usedTokens);
    assert.ok(out.tokenReduction.ratio > 0 && out.tokenReduction.ratio < 1);
  });

  it('refuses bad queries, audiences, budgets and versions', () => {
    assert.equal(kbm.search(kb, '', HUMAN).code, 'QUERY_INVALID');
    assert.equal(kbm.search(kb, 'a b c d e f g h i j k l m', HUMAN).code, 'QUERY_INVALID');
    assert.equal(kbm.search(kb, 'x'.repeat(161), HUMAN).code, 'QUERY_INVALID');
    assert.equal(kbm.search(kb, 'install', { audience: 'robot', budgetTokens: 10 }).code, 'AUDIENCE_INVALID');
    assert.equal(kbm.search(kb, 'install', { audience: 'human', budgetTokens: kbm.MAX_BUDGET_TOKENS + 1 }).code, 'BUDGET_INVALID');
    assert.equal(kbm.search(kb, 'install', { ...HUMAN, version: '1.0.0' }).code, 'VERSION_NOT_COVERED');
  });
});

describe('contextualHelp', () => {
  const kb = twoVersionKb();

  it('returns the sections of every page documenting the surface, in document order', () => {
    const out = kbm.contextualHelp(kb, 'public/setup-wizard.js', HUMAN);
    assert.equal(out.ok, true);
    assert.deepEqual(out.pages, ['setup']);
    assert.deepEqual(out.results.map((r) => r.citation), ['setup#setup', 'setup#install', 'setup#recovery', 'setup#recovery-1']);
  });

  it('applies audience to the pages it offers', () => {
    assert.deepEqual(kbm.contextualHelp(kb, 'lib/agent/x.js', HUMAN).pages, []);
    assert.deepEqual(kbm.contextualHelp(kb, 'lib/agent/x.js', NHE).pages, ['agent']);
  });

  it('refuses a surface that is not a repo-relative path', () => {
    assert.equal(kbm.contextualHelp(kb, '/etc/passwd', HUMAN).code, 'SURFACE_INVALID');
    assert.equal(kbm.contextualHelp(kb, 'public/../../x', HUMAN).code, 'SURFACE_INVALID');
  });
});

describe('getSection', () => {
  const kb = twoVersionKb();

  it('fetches one whole cited section without its audience list', () => {
    const out = kbm.getSection(kb, 'setup#recovery-1', { audience: 'human' });
    assert.equal(out.ok, true);
    assert.match(out.section.text, /second recovery/);
    assert.equal(out.section.audience, undefined);
  });

  it('answers not-found for a section the audience may not read, exactly as for a missing one', () => {
    const forbidden = kbm.getSection(kb, 'agent#retrieval', { audience: 'human' });
    const missing = kbm.getSection(kb, 'agent#nope', { audience: 'human' });
    assert.equal(forbidden.code, 'SECTION_NOT_FOUND');
    assert.equal(missing.code, 'SECTION_NOT_FOUND');
  });
});

describe('against this repo\'s own manual', () => {
  it('indexes docs/manual-manifest.json with every page present and searchable', () => {
    const real = productManual.readManualManifest(path.join(ROOT, 'docs/manual-manifest.json'));
    const contents = {};
    for (const p of real.pages) contents[p.path] = fs.readFileSync(path.join(ROOT, p.path), 'utf8');
    const kb = kbm.createKnowledgeBase([kbm.buildSnapshot(real, contents, '6.1.0')]);
    assert.deepEqual(kb.snapshots[0].missingPages, []);
    const out = kbm.search(kb, 'engine', { audience: 'nhe', budgetTokens: 800 });
    assert.ok(out.results.length > 0);
    assert.ok(out.usedTokens <= 800);
    assert.ok(out.tokenReduction.ratio > 0.5, 'a bounded fetch is a small fraction of the whole manual');
  });
});
