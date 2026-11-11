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
});
