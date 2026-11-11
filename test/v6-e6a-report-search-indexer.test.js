'use strict';

// v6 Train 3 Wave 1 (#2989, V6-18 / E6a, Car V60-T3-W1-C): the report
// search indexer and deterministic "Ask This Report" citation drawer, over
// the REAL report HTML shape lib/v6/sprint-report-validator-v3.js already
// parses -- no live store, no sqlite, pure functions over synthetic report
// HTML.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const e6a = require('../lib/v6/e6a-report-search-indexer');
const { CANONICAL_SECTIONS } = require('../lib/v6/sprint-report-validator-v3');

/**
 * @param {Record<string, string>} [overrides] - sectionId -> inner HTML.
 * @returns {string}
 */
function syntheticReport(overrides = {}) {
  let html = '<html><body>';
  for (const id of CANONICAL_SECTIONS) {
    html += `<section id="${id}">${overrides[id] || `Plain narrative text for the ${id} section.`}</section>`;
  }
  html += '</body></html>';
  return html;
}

describe('buildSearchIndex (#2989 deliverable 1)', () => {
  it('indexes every canonical section with an anchor, heading, text, and token set', () => {
    const idx = e6a.buildSearchIndex(syntheticReport(), { version: 'v5.72.0' });
    assert.equal(idx.schemaVersion, e6a.INDEX_SCHEMA_VERSION);
    assert.equal(idx.version, 'v5.72.0');
    assert.equal(idx.sections.length, 12);
    for (const section of idx.sections) {
      assert.equal(section.anchor, `#${section.id}`);
      assert.ok(section.heading.length > 0);
      assert.ok(section.tokens.includes('narrative'));
    }
  });

  it('deduplicates repeated tokens within one section', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ overview: 'repeat repeat repeat unique' }));
    const overview = idx.sections.find((s) => s.id === 'overview');
    assert.equal(overview.tokens.filter((t) => t === 'repeat').length, 1);
    assert.ok(overview.tokens.includes('unique'));
  });

  it('collects every Label (#NNNN) citation across all sections, deduplicated', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      overview: 'Shipped Session Hierarchy (#108).',
      'next-sprint': 'Planning Session Hierarchy (#108) again, plus Engine Failover (#109).'
    }));
    assert.equal(idx.citations.filter((c) => c.issue === 108).length, 1, 'the #108 citation is deduplicated across sections');
    assert.ok(idx.citations.some((c) => c.issue === 109));
  });

  it('falls back to a title-cased section id as heading when the text has no short leading sentence', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ 'next-sprint': 'a'.repeat(200) }));
    const nextSprint = idx.sections.find((s) => s.id === 'next-sprint');
    assert.equal(nextSprint.heading, 'Next Sprint');
  });

  it('version defaults to null and generatedAt is an ISO timestamp when omitted', () => {
    const idx = e6a.buildSearchIndex(syntheticReport());
    assert.equal(idx.version, null);
    assert.ok(!Number.isNaN(Date.parse(idx.generatedAt)));
  });

  it('builds an anchored pr chunk for a PR #NNNN mention, with the [PR #NNNN] citation label (Ruling A594-PR3018-R1-HOLD-RECONCILED)', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      overview: 'This window true-merged PR #3016 cleanly into main.'
    }));
    const chunk = idx.prChunks.find((c) => c.issue === 3016);
    assert.ok(chunk, 'a pr chunk for #3016 must exist');
    assert.equal(chunk.sectionId, 'overview');
    assert.equal(chunk.anchor, '#overview');
    assert.equal(chunk.label, '[PR #3016]');
    assert.match(chunk.passage, /PR #3016/);
  });

  it('builds an anchored pr chunk for a bare #NNNN mention too, not only the PR-prefixed form', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ architecture: 'Closed #3017 as a duplicate.' }));
    const chunk = idx.prChunks.find((c) => c.issue === 3017);
    assert.ok(chunk, 'a bare #3017 must still produce a pr chunk');
    assert.equal(chunk.label, '[PR #3017]');
  });

  it('builds an anchored kaizen chunk for a KR-ID mention, with the [KR-ID] citation label (Ruling A594-PR3018-R1-HOLD-RECONCILED)', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ retro: 'Tracked under KR-01 this cycle.' }));
    const chunk = idx.kaizenChunks.find((c) => c.krId === 'KR-01');
    assert.ok(chunk, 'a kaizen chunk for KR-01 must exist');
    assert.equal(chunk.sectionId, 'retro');
    assert.equal(chunk.anchor, '#retro');
    assert.equal(chunk.label, '[KR-01]');
  });

  it('also matches a KAIZEN-prefixed id, case-insensitively', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ retro: 'See kaizen-07 for details.' }));
    const chunk = idx.kaizenChunks.find((c) => c.krId === 'KAIZEN-07');
    assert.ok(chunk, 'a lowercase kaizen-07 mention must still produce an uppercased KAIZEN-07 chunk');
    assert.equal(chunk.label, '[KAIZEN-07]');
  });

  it('indexes multiple pr/kaizen occurrences across different sections independently, each with its own anchor', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      overview: 'Shipped PR #100.',
      'next-sprint': 'Planning PR #100 follow-up and PR #101.'
    }));
    const hundredChunks = idx.prChunks.filter((c) => c.issue === 100);
    assert.equal(hundredChunks.length, 2, 'the SAME PR number mentioned in 2 different sections is 2 separate anchored chunks');
    assert.deepEqual(hundredChunks.map((c) => c.sectionId).sort(), ['next-sprint', 'overview']);
  });
});

describe('citeThisReport (#2989 deliverable 2 -- deterministic, never generates text)', () => {
  it('returns the exact verbatim passage containing the match, with the section anchor', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      architecture: 'This window true-merged 27 pull requests across the release window.'
    }));
    const results = e6a.citeThisReport(idx, 'pull requests');
    assert.ok(results.length > 0);
    const hit = results.find((r) => r.sectionId === 'architecture');
    assert.ok(hit, 'architecture section must be the top match');
    assert.match(hit.passage, /true-merged 27 pull requests/);
    assert.equal(hit.anchor, '#architecture');
    // Every word in the returned passage is drawn verbatim from the
    // section's own indexed text -- never a word the query itself supplied
    // that isn't ALSO in the source text.
    const sourceText = idx.sections.find((s) => s.id === 'architecture').text;
    assert.ok(sourceText.includes(hit.passage.replace(/^…|…$/g, '')));
  });

  it('ranks a section with an exact phrase match above one with only scattered token overlap', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      overview: 'Engine Failover shipped this window.',
      retro: 'We discussed the engine team and a failover plan separately, in different sentences.'
    }));
    const results = e6a.citeThisReport(idx, 'Engine Failover');
    assert.equal(results[0].sectionId, 'overview', 'the exact phrase match ranks first');
  });

  it('returns an empty array for a query with no matching tokens anywhere', () => {
    const idx = e6a.buildSearchIndex(syntheticReport());
    assert.deepEqual(e6a.citeThisReport(idx, 'zzz-nonexistent-xyzzy'), []);
  });

  it('returns an empty array for an empty or whitespace-only query', () => {
    const idx = e6a.buildSearchIndex(syntheticReport());
    assert.deepEqual(e6a.citeThisReport(idx, ''), []);
    assert.deepEqual(e6a.citeThisReport(idx, '   '), []);
  });

  it('respects the limit option', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({
      overview: 'shared keyword here', architecture: 'shared keyword here too', velocity: 'shared keyword again'
    }));
    const results = e6a.citeThisReport(idx, 'shared keyword', { limit: 2 });
    assert.equal(results.length, 2);
  });

  it('every hit carries a type of section, pr, or kaizen, and a section hit\'s badge is [Section N]', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ overview: 'A narrative mention of velocity here.' }));
    const results = e6a.citeThisReport(idx, 'velocity narrative');
    assert.ok(results.length > 0);
    for (const hit of results) assert.ok(['section', 'pr', 'kaizen'].includes(hit.type));
    const sectionHit = results.find((r) => r.type === 'section' && r.sectionId === 'overview');
    assert.ok(sectionHit);
    assert.equal(sectionHit.badge, '[Section 1]', 'overview is CANONICAL_SECTIONS[0]');
  });

  it('a query for a PR number returns a typed pr hit with the [PR #NNNN] badge (Ruling A594-PR3018-R1-HOLD-RECONCILED)', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ overview: 'This window shipped PR #3016 cleanly.' }));
    const results = e6a.citeThisReport(idx, '3016');
    const prHit = results.find((r) => r.type === 'pr');
    assert.ok(prHit, 'a typed pr hit must be present for a PR-number query');
    assert.equal(prHit.badge, '[PR #3016]');
    assert.equal(prHit.anchor, '#overview');
    assert.match(prHit.passage, /PR #3016/);
  });

  it('a query for a Kaizen ID returns a typed kaizen hit with the [KR-ID] badge (Ruling A594-PR3018-R1-HOLD-RECONCILED)', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ retro: 'Tracked under KR-01 this cycle.' }));
    const results = e6a.citeThisReport(idx, 'KR-01');
    const kaizenHit = results.find((r) => r.type === 'kaizen');
    assert.ok(kaizenHit, 'a typed kaizen hit must be present for a Kaizen-ID query');
    assert.equal(kaizenHit.badge, '[KR-01]');
    assert.equal(kaizenHit.anchor, '#retro');
  });

  it('a pr/kaizen hit never carries a heading field (only section hits do)', () => {
    const idx = e6a.buildSearchIndex(syntheticReport({ overview: 'Shipped PR #3016 and tracked KR-01.' }));
    const results = e6a.citeThisReport(idx, '3016');
    const prHit = results.find((r) => r.type === 'pr');
    assert.equal('heading' in prHit, false);
  });

  it('surfaces the typed pr/kaizen hit under the DEFAULT limit even when the same identifier also appears in all 12 sections (Ruling A598-PR3018-R2-HOLD-RECONCILED)', () => {
    const overrides = {};
    for (const id of CANONICAL_SECTIONS) overrides[id] = 'Shipped PR #3016 and tracked KR-01.';
    const idx = e6a.buildSearchIndex(syntheticReport(overrides));

    const prResults = e6a.citeThisReport(idx, '3016');
    assert.ok(prResults.some((r) => r.type === 'pr' && r.badge === '[PR #3016]'),
      `expected a typed pr hit under default limit, got types: ${prResults.map((r) => r.type).join(',')}`);

    const kaizenResults = e6a.citeThisReport(idx, 'KR-01');
    assert.ok(kaizenResults.some((r) => r.type === 'kaizen' && r.badge === '[KR-01]'),
      `expected a typed kaizen hit under default limit, got types: ${kaizenResults.map((r) => r.type).join(',')}`);
  });
});
