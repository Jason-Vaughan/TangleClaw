'use strict';

// v6 Train 3 Wave 1 (#2988, V6-17 / E4, Car V60-T3-W1-C): rich report
// presentation view-model building over the REAL report HTML shape
// lib/v6/sprint-report-validator-v3.js already parses (CANONICAL_SECTIONS,
// extractSection, toPlainText, extractJsonAnchor) -- no live store, no
// sqlite, pure functions over synthetic report HTML.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const e4 = require('../lib/v6/e4-rich-report-presentation');
const { CANONICAL_SECTIONS } = require('../lib/v6/sprint-report-validator-v3');

/**
 * A minimal synthetic report document carrying every canonical section
 * plus the canonical-metrics anchor, so tests exercise the real parsing
 * path (extractSection/extractJsonAnchor) rather than calling internals directly.
 * @param {Record<string, string>} [overrides] - sectionId -> inner HTML, for sections that need specific content.
 * @param {object|null} [metrics]
 * @returns {string}
 */
function syntheticReport(overrides = {}, metrics = { version: 'v1.0.0' }) {
  let html = '<html><head><title>t</title></head><body>';
  for (const id of CANONICAL_SECTIONS) {
    html += `<section id="${id}">${overrides[id] || `Narrative text for ${id} section.`}</section>`;
  }
  if (metrics) html += `<script type="application/json" id="tc-canonical-metrics">${JSON.stringify(metrics)}</script>`;
  html += '</body></html>';
  return html;
}

describe('POPOVER_CATALOG / SECTION_PILLAR (#2988 deliverable 1, 2)', () => {
  it('has exactly one popover and one pillar for every CANONICAL_SECTIONS entry, no more, no fewer', () => {
    assert.deepEqual(Object.keys(e4.POPOVER_CATALOG).sort(), [...CANONICAL_SECTIONS].sort());
    assert.deepEqual(Object.keys(e4.SECTION_PILLAR).sort(), [...CANONICAL_SECTIONS].sort());
    assert.equal(Object.keys(e4.POPOVER_CATALOG).length, 12);
  });

  it('every popover carries all 4 parts, each a non-empty string', () => {
    for (const id of CANONICAL_SECTIONS) {
      const popover = e4.POPOVER_CATALOG[id];
      for (const part of ['what_it_means', 'how_measured', 'why_it_matters', 'what_it_does_not_prove']) {
        assert.equal(typeof popover[part], 'string', `${id}.${part} must be a string`);
        assert.ok(popover[part].length > 0, `${id}.${part} must be non-empty`);
      }
    }
  });

  it('every pillar value is one of the 3 declared PILLARS', () => {
    for (const id of CANONICAL_SECTIONS) {
      assert.ok(e4.PILLARS.includes(e4.SECTION_PILLAR[id]), `${id}'s pillar must be one of PILLARS`);
    }
  });
});

describe('buildReportViewModel (#2988 deliverable 1)', () => {
  it('returns one view-model entry per canonical section, each with its popover/pillar/excerpt', () => {
    const vm = e4.buildReportViewModel(syntheticReport());
    assert.equal(vm.sections.length, 12);
    for (const section of vm.sections) {
      assert.equal(section.popover, e4.POPOVER_CATALOG[section.id]);
      assert.equal(section.pillar, e4.SECTION_PILLAR[section.id]);
      assert.match(section.excerpt, /Narrative text for/);
    }
  });

  it('carries the #tc-canonical-metrics anchor through verbatim', () => {
    const vm = e4.buildReportViewModel(syntheticReport({}, { version: 'v5.72.0', economics: { measured_tokens: 1000 } }));
    assert.deepEqual(vm.metrics, { version: 'v5.72.0', economics: { measured_tokens: 1000 } });
  });

  it('metrics is null when the anchor is absent, rather than throwing', () => {
    const vm = e4.buildReportViewModel(syntheticReport({}, null));
    assert.equal(vm.metrics, null);
  });

  it('truncates a long excerpt to excerptChars and marks truncation with an ellipsis', () => {
    const longText = 'word '.repeat(200).trim();
    const vm = e4.buildReportViewModel(syntheticReport({ overview: longText }), { excerptChars: 40 });
    const overview = vm.sections.find((s) => s.id === 'overview');
    assert.ok(overview.excerpt.length <= 41);
    assert.ok(overview.excerpt.endsWith('…'));
  });
});

describe('buildPillarSwitcherModel (#2988 deliverable 2)', () => {
  it('groups every section into exactly one of the 3 pillars, covering all 12', () => {
    const vm = e4.buildReportViewModel(syntheticReport());
    const switcher = e4.buildPillarSwitcherModel(vm);
    assert.deepEqual(Object.keys(switcher), [...e4.PILLARS]);
    const total = e4.PILLARS.reduce((sum, p) => sum + switcher[p].length, 0);
    assert.equal(total, 12);
    for (const pillar of e4.PILLARS) {
      for (const section of switcher[pillar]) assert.equal(section.pillar, pillar);
    }
  });
});

describe('buildPrintView / PRINT_STYLESHEET (#2988 deliverable 2)', () => {
  it('injects the print stylesheet before </head> without altering the rest of the document', () => {
    const html = syntheticReport();
    const printed = e4.buildPrintView(html);
    assert.match(printed, /<style data-e4-print>/);
    assert.match(printed, /@media print/);
    assert.ok(printed.includes('<section id="overview">'), 'original content is preserved');
  });

  it('prepends the style block when the document has no </head> at all', () => {
    const printed = e4.buildPrintView('<body><p>no head here</p></body>');
    assert.match(printed, /^<style data-e4-print>/);
  });
});
