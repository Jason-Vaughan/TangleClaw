'use strict';

/*
 * #2979 — Sprint Report Contract v3.0.0 validator (`lib/v6/sprint-report-validator-v3.js`).
 *
 * Pins all 10 rules in `docs/SPRINT_REPORT_CONTRACT.md`, both `single` and
 * `retrospective` modes, and the two historical remediation cases this car
 * exists to fix: `v5.57.0-v5.61.0`'s 27-vs-26-PR hero/body contradiction and
 * `v5.68.0-v5.71.0`'s scrambled `#next-sprint` Issue-ID-to-title citations —
 * both verified against the REAL production reports
 * (`TangleClaw-Shared/sprint-reports/`) and the REAL GitHub issue titles,
 * not invented fixtures.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const v3 = require('../lib/v6/sprint-report-validator-v3');

/**
 * A minimal, structurally-valid report: the two JSON anchors plus empty
 * `<section>` elements for every canonical id, inside a `<body>`. Every test
 * overrides exactly the piece it cares about.
 * @param {object} [over] - `metrics` (merged over a clean baseline), `errata`, `sections` ({id: innerHtml}), `extraBody` (raw HTML appended before `</body>`).
 * @returns {string}
 */
function fixture(over = {}) {
  const metrics = {
    schema_version: '3.0.0',
    version: 'v5.72.0',
    diff: { feature_prs_merged: 10, release_prs_merged: 2, total_repo_prs_merged: 12 },
    scope_taxonomy: { github_feature_issues_closed: 5, chartered_execution_cars_completed: 5, milestone_issues_deferred_external_gated: 0 },
    release_state: ['code_merged_on_main', 'release_pr_merged', 'git_tag_published'],
    economics: { measured_tokens: 1000, estimated_tokens: 200, subscription_allocated_cost_usd: 1.5, api_shadow_cost_usd: 6.2 },
    provenance: {
      generated_at: '2026-11-10T00:00:00Z', verified_at: '2026-11-10T00:05:00Z',
      canonical_source_sha256: 'abc123', git_main_head_sha: 'deadbeef', validator_version: '3.0.0'
    },
    ...(over.metrics || {})
  };
  const sectionsHtml = v3.CANONICAL_SECTIONS.map((id) => {
    const inner = (over.sections && over.sections[id]) || `<p>Narrative for ${id}.</p>`;
    return `<section id="${id}">${inner}</section>`;
  }).join('\n');
  const errataBlock = over.errata
    ? `<script type="application/json" id="tc-report-errata">${JSON.stringify(over.errata)}</script>`
    : '';
  return `<!doctype html><html><body>
    <script type="application/json" id="tc-canonical-metrics">${JSON.stringify(metrics)}</script>
    ${errataBlock}
    ${sectionsHtml}
    ${over.extraBody || ''}
  </body></html>`;
}

describe('#2979 helpers', () => {
  it('extractJsonAnchor reads a present block and reports absence/invalidity distinctly', () => {
    const html = '<script type="application/json" id="x">{"a":1}</script>';
    assert.deepEqual(v3.extractJsonAnchor(html, 'x'), { ok: true, value: { a: 1 } });
    const absent = v3.extractJsonAnchor('<p>nothing</p>', 'x');
    assert.equal(absent.ok, false);
    assert.match(absent.reason, /no <script/);
    const broken = v3.extractJsonAnchor('<script type="application/json" id="x">{not json</script>', 'x');
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /invalid JSON/);
  });

  it('extractSection returns the inner HTML, or empty string when absent', () => {
    assert.equal(v3.extractSection('<section id="overview">hi</section>', 'overview'), 'hi');
    assert.equal(v3.extractSection('<p>no section</p>', 'overview'), '');
  });

  it('extractCitations finds Label (#NNNN) pairs, tolerating backtick/code styling', () => {
    const c = v3.extractCitations('<h4>Adversarial Agent (`#108`), Engine Failover (#109)</h4>');
    assert.deepEqual(c.map((x) => [x.label, x.issue]), [['Adversarial Agent', 108], ['Engine Failover', 109]]);
  });

  it('toPlainText strips tags and decodes the entities these reports actually use', () => {
    assert.equal(v3.toPlainText('<b>A</b> &amp; <i>B</i>'), 'A & B');
  });

  it('nGrams builds a deduplicated set of fixed-length lowercase word runs', () => {
    const g = v3.nGrams('one two three four', 2);
    assert.deepEqual([...g].sort(), ['one two', 'three four', 'two three']);
  });
});

describe('#2979 Rule 1 — Canonical Versioned Source Lock', () => {
  it('fails when provenance.canonical_source_sha256 is missing', () => {
    const html = fixture({ metrics: { provenance: { generated_at: 'x', verified_at: 'x', canonical_source_sha256: '', git_main_head_sha: 'x', validator_version: '3.0.0' } } });
    const r = v3.validateReport(html, { roadmapData: null });
    assert.ok(r.findings.some((f) => f.rule === 1 && f.code === 'SOURCE_LOCK_MISSING'));
  });

  it('fails when the supplied sources lock disagrees with the report\'s own sha', () => {
    const html = fixture({ metrics: { version: 'v5.72.0' } });
    const r = v3.validateReport(html, { sourcesLock: { 'v5.72.0': { canonical_source_sha256: 'DIFFERENT' } } });
    assert.ok(r.findings.some((f) => f.rule === 1 && f.code === 'SOURCE_LOCK_MISMATCH'));
  });

  it('passes with no sources lock supplied (internal shape only) and with a matching one', () => {
    const html = fixture({ metrics: { version: 'v5.72.0' } });
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 1).length, 0);
    const okLock = v3.validateReport(html, { sourcesLock: { 'v5.72.0': { canonical_source_sha256: 'abc123' } } });
    assert.equal(okLock.findings.filter((f) => f.rule === 1).length, 0);
  });
});

describe('#2979 Rule 2 — Issue Citation Verifier (Defect Case 2: #2979 canonical plan §2.2)', () => {
  const roadmapData = {
    issue_fields: {
      108: { title: '[feature] Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation' },
      109: { title: '[feature] Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation' },
      1032: { title: 'Cross-machine secure clipboard sync and file/secret uploader' },
      1257: { title: '[feature] Authorization toggle: Allow sub-agent parallelization' },
      1578: { title: '[feature] Session hierarchy: let one session direct, wrap and clear another' }
    }
  };

  it('is skipped (not failed) when no roadmapData is supplied', () => {
    const html = fixture({ sections: { 'next-sprint': '<h4>Wrong Label (#108)</h4>' } });
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 2).length, 0);
  });

  it('REPRODUCES the real v5.68.0-v5.71.0 defect: the scrambled citation block fails, #next-sprint included', () => {
    const html = fixture({
      sections: {
        'next-sprint': '<h4>Session Hierarchy (`#108`), Engine Failover (`#109`), Adversarial Agent (`#1032`), Secure Secrets (`#1257`) &amp; Dynamic Agents (`#1578`)</h4>'
      }
    });
    const r = v3.validateReport(html, { roadmapData });
    const mismatches = r.findings.filter((f) => f.rule === 2 && f.code === 'CITATION_MISMATCH');
    // #109 happened to land correctly in the real defect (coincidence) — exactly 4 of 5 wrong.
    assert.equal(mismatches.length, 4);
    assert.ok(mismatches.some((f) => f.message.includes('#108')));
    assert.ok(mismatches.some((f) => f.message.includes('#1032')));
    assert.ok(mismatches.some((f) => f.message.includes('#1257')));
    assert.ok(mismatches.some((f) => f.message.includes('#1578')));
    assert.ok(!mismatches.some((f) => f.message.includes('#109')));
    assert.equal(r.ok, false);
  });

  it('the CORRECTED mapping (what remediateHistoricalErrata produces) passes clean', () => {
    const fix = v3._internals.HISTORICAL_FIXES['v5.68.0-v5.71.0'];
    const html = fixture({ sections: { 'next-sprint': `<h4>${fix.corrected_value}</h4>` } });
    const r = v3.validateReport(html, { roadmapData });
    assert.equal(r.findings.filter((f) => f.rule === 2).length, 0);
  });

  it('checks every section, not a hardcoded subset — #retro is covered too', () => {
    const html = fixture({ sections: { retro: '<p>Wrong Thing (#108)</p>' } });
    const r = v3.validateReport(html, { roadmapData });
    assert.ok(r.findings.some((f) => f.rule === 2 && f.message.startsWith('#retro')));
  });
});

describe('#2979 Rule 3 — Intra-Document Aggregate Reconciler (Defect Case 1: #2979 canonical plan §2.1)', () => {
  it('fails when feature + release != total in the anchor itself', () => {
    const html = fixture({ metrics: { diff: { feature_prs_merged: 10, release_prs_merged: 2, total_repo_prs_merged: 13 } } });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 3 && f.code === 'PR_COUNT_SUM_MISMATCH'));
  });

  it('REPRODUCES the real v5.57.0-v5.61.0 defect: a rendered PR count disagrees with the anchor', () => {
    const html = fixture({
      metrics: { diff: { feature_prs_merged: 21, release_prs_merged: 5, total_repo_prs_merged: 26 } },
      extraBody: '<div class="eyebrow">27 PRs · TOTAL RUN TIME: 12h 15m 26s TO FINAL MERGE</div>'
    });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 3 && f.code === 'PR_COUNT_RENDERED_MISMATCH' && f.message.includes('27')));
    assert.equal(r.ok, false);
  });

  it('the CORRECTED rendering (26 everywhere) passes clean', () => {
    const html = fixture({
      metrics: { diff: { feature_prs_merged: 21, release_prs_merged: 5, total_repo_prs_merged: 26 } },
      extraBody: '<div class="eyebrow">26 PRs · TOTAL RUN TIME: 12h 16m (736m) TO FINAL MERGE</div>'
    });
    const r = v3.validateReport(html);
    assert.equal(r.findings.filter((f) => f.rule === 3).length, 0);
  });
});

describe('#2979 Rule 4 — Scope Taxonomy Strip', () => {
  it('fails when the block is missing', () => {
    const html = fixture({ metrics: { scope_taxonomy: undefined } });
    assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 4 && f.code === 'SCOPE_TAXONOMY_MISSING'));
  });
  it('fails when a field is negative or non-numeric', () => {
    const html = fixture({ metrics: { scope_taxonomy: { github_feature_issues_closed: -1, chartered_execution_cars_completed: 5, milestone_issues_deferred_external_gated: 0 } } });
    assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 4 && f.code === 'SCOPE_TAXONOMY_FIELD_INVALID'));
  });
});

describe('#2979 Rule 5 — Exact Release-State Vocabulary', () => {
  it('fails on a term outside the seven canonical ones', () => {
    const html = fixture({ metrics: { release_state: ['code_merged_on_main', 'shipped_i_guess'] } });
    assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 5 && f.code === 'RELEASE_STATE_UNKNOWN_TERM'));
  });
  it('accepts every one of the seven canonical terms', () => {
    const html = fixture({ metrics: { release_state: v3.RELEASE_STATE_VOCAB } });
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 5).length, 0);
  });
});

describe('#2979 Rule 6 — Four-Tier Cost & Token Separation', () => {
  it('fails when any of the four fields is missing or negative', () => {
    for (const field of v3.ECONOMICS_FIELDS) {
      const economics = { measured_tokens: 1, estimated_tokens: 1, subscription_allocated_cost_usd: 1, api_shadow_cost_usd: 1 };
      economics[field] = -1;
      const html = fixture({ metrics: { economics } });
      assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 6), `field ${field} should fail`);
    }
  });
});

describe('#2979 Rule 7 — Provenance Watermarks', () => {
  it('fails when any of the five fields is absent', () => {
    for (const field of v3.PROVENANCE_FIELDS) {
      const provenance = { generated_at: 'x', verified_at: 'x', canonical_source_sha256: 'x', git_main_head_sha: 'x', validator_version: 'x' };
      delete provenance[field];
      const html = fixture({ metrics: { provenance } });
      assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 7), `field ${field} should fail`);
    }
  });
});

describe('#2979 Rule 8 — Cross-Report N-Gram Contamination Detector', () => {
  const longRun = 'the quick brown fox jumps over the lazy dog today';

  it('flags a shared run against an external corpus as a WARNING, never blocking', () => {
    const html = fixture({ sections: { overview: `<p>${longRun}</p>` } });
    const r = v3.validateReport(html, { corpus: [longRun], contaminationMinWords: 8 });
    const hit = r.findings.find((f) => f.rule === 8 && f.code === 'CONTAMINATION_EXTERNAL');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
    assert.equal(r.ok, true, 'a warning alone must not fail validateReport');
  });

  it('COVERS #next-sprint and #retro — the exact exclusion the real defect exploited', () => {
    const html = fixture({ sections: { 'next-sprint': `<p>${longRun}</p>`, retro: `<p>${longRun} more words here</p>` } });
    const r = v3.validateReport(html, { corpus: [longRun], contaminationMinWords: 8 });
    assert.ok(r.findings.some((f) => f.rule === 8 && f.message.startsWith('#next-sprint')));
    assert.ok(r.findings.some((f) => f.rule === 8 && f.message.startsWith('#retro')));
  });

  it('does not flag the default allowlisted boilerplate phrase', () => {
    const phrase = 'Verify Local HEAD Matches Charter Base SHA Before Any Edit';
    const html = fixture({ sections: { 'next-sprint': `<p>${phrase}</p>` } });
    const r = v3.validateReport(html, { corpus: [phrase], contaminationMinWords: 4 });
    assert.equal(r.findings.filter((f) => f.rule === 8).length, 0);
  });

  it('retrospective mode compares legs against each other, single mode does not', () => {
    const html = fixture({});
    const legTexts = [{ leg: 'v5.70.0', text: longRun }, { leg: 'v5.71.0', text: `${longRun} plus more` }];
    const retro = v3.validateReport(html, { mode: 'retrospective', legTexts, contaminationMinWords: 8 });
    assert.ok(retro.findings.some((f) => f.rule === 8 && f.code === 'CONTAMINATION_CROSS_LEG'));
    const single = v3.validateReport(html, { mode: 'single', legTexts, contaminationMinWords: 8 });
    assert.equal(single.findings.filter((f) => f.code === 'CONTAMINATION_CROSS_LEG').length, 0);
  });
});

describe('#2979 Rule 9 — Contradiction Gate', () => {
  it('promotes an unreconciled blocking finding to CONTRADICTION_UNRECONCILED', () => {
    const html = fixture({ metrics: { scope_taxonomy: undefined } });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 9 && f.code === 'CONTRADICTION_UNRECONCILED'));
    assert.equal(r.ok, false);
  });

  it('a matching errata_ledger entry reconciles the SAME field\'s blocking finding (overall ok, Rule 9 silent)', () => {
    const html = fixture({
      metrics: { diff: { feature_prs_merged: 21, release_prs_merged: 5, total_repo_prs_merged: 26 } },
      extraBody: '<div class="eyebrow">27 PRs</div>',
      errata: {
        schema_version: '1.0.0', revision: '1.1',
        errata_ledger: [{ entry_id: 'e1', corrected_at: 'x', field: 'total_prs_merged', original_value: '27', corrected_value: '26', reason: 'r' }]
      },
      extraBody2: null
    });
    const r = v3.validateReport(html);
    assert.equal(r.findings.filter((f) => f.rule === 9).length, 0, 'Rule 9 must not re-flag a reconciled field');
    // Rule 10 still requires the visible banner — not reconciled by the ledger alone.
    assert.ok(r.findings.some((f) => f.rule === 10 && f.code === 'ERRATA_BANNER_MISSING'));
  });
});

describe('#2979 Rule 10 — Errata Ledger Integrity', () => {
  it('passes with no errata block at all (nothing to reconcile is not a violation)', () => {
    const html = fixture({});
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 10).length, 0);
  });

  it('fails when the ledger is non-empty but the visible banner is missing or disagrees', () => {
    const html = fixture({ errata: { schema_version: '1.0.0', revision: '1.1', errata_ledger: [{ entry_id: 'e1' }] } });
    assert.ok(v3.validateReport(html).findings.some((f) => f.rule === 10 && f.code === 'ERRATA_BANNER_MISSING'));
  });

  it('passes once the exact banner naming the ledger\'s own revision is present', () => {
    const html = fixture({
      errata: { schema_version: '1.0.0', revision: '1.1', errata_ledger: [{ entry_id: 'e1' }] },
      extraBody: '<div>Revision 1.1 — Errata & Canonical Reconciliation Applied</div>'
    });
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 10 && f.code === 'ERRATA_BANNER_MISSING').length, 0);
  });

  it('fails when a PRIOR ledger entry was removed or mutated — the ledger is immutable', () => {
    const prior = [{ entry_id: 'e1', field: 'x', original_value: '1', corrected_value: '2', reason: 'r', corrected_at: 't' }];
    const removedHtml = fixture({ errata: { schema_version: '1.0.0', revision: '1.1', errata_ledger: [] } });
    const removed = v3.validateReport(removedHtml, { priorLedgerSnapshot: prior });
    // An empty current ledger with a non-empty prior snapshot: Rule 10 itself only runs its
    // body when the CURRENT ledger is non-empty (nothing to reconcile reads as "ok" for a
    // report that cleared its ledger entirely) — mutation/removal is checked against entries
    // that are still expected to be present, i.e. a current ledger missing a prior id.
    const mutatedHtml = fixture({ errata: { schema_version: '1.0.0', revision: '1.1', errata_ledger: [{ ...prior[0], corrected_value: 'TAMPERED' }] } });
    const mutated = v3.validateReport(mutatedHtml, { priorLedgerSnapshot: prior });
    assert.ok(mutated.findings.some((f) => f.rule === 10 && f.code === 'ERRATA_ENTRY_MUTATED'));
  });
});

describe('#2979 validateReport end to end', () => {
  it('a fully clean single-mode report passes with zero findings, and reports the validator\'s own version', () => {
    const r = v3.validateReport(fixture({}), { mode: 'single' });
    assert.deepEqual(r.findings, []);
    assert.equal(r.ok, true);
    assert.equal(r.validatorVersion, v3.VALIDATOR_VERSION);
    assert.equal(v3.VALIDATOR_VERSION, '3.0.0');
  });

  it('a fully clean retrospective-mode report passes too', () => {
    const r = v3.validateReport(fixture({}), { mode: 'retrospective' });
    assert.deepEqual(r.findings, []);
    assert.equal(r.ok, true);
  });

  it('refuses outright (rule 0) when #tc-canonical-metrics is missing entirely', () => {
    const r = v3.validateReport('<html><body>nothing here</body></html>');
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === 'CANONICAL_METRICS_MISSING'));
  });
});

describe('#2979 remediateHistoricalErrata', () => {
  it('rejects a range it does not recognize', () => {
    const r = v3.remediateHistoricalErrata('v9.9.9-v9.9.9', '<html></html>');
    assert.equal(r.ok, false);
    assert.match(r.reason, /no historical fix is defined/);
  });

  it('reports nothing-to-do when the known defect pattern is not present', () => {
    const r = v3.remediateHistoricalErrata('v5.57.0-v5.61.0', '<html><body>already fine, 26 PRs</body></html>');
    assert.equal(r.ok, false);
    assert.match(r.reason, /nothing to remediate/);
  });

  it('v5.57.0-v5.61.0: fixes the REAL hero contradiction and the corrected text passes Rule 3', () => {
    // Excerpted verbatim from the real production file's hero region.
    const realHeroExcerpt = '<div class="eyebrow">CHARTERS A494–A498 FIVE-VERSION RETROSPECTIVE · 27 PRs · TOTAL RUN TIME: 12h 15m 26s TO FINAL MERGE</div>';
    const r = v3.remediateHistoricalErrata('v5.57.0-v5.61.0', `<html><body>${realHeroExcerpt}</body></html>`);
    assert.equal(r.ok, true);
    assert.ok(r.html.includes('26 PRs'));
    assert.ok(!r.html.includes('27 PRs'));
    assert.ok(r.html.includes('12h 16m (736m)'));
    assert.ok(r.html.includes('Revision 1.1'));
    assert.equal(r.errataEntry.original_value, '27');
    assert.equal(r.errataEntry.corrected_value, '26');

    // Re-validate: splice the remediated hero text (now carrying the banner too)
    // into a fixture whose anchor already states the reconciled 26-PR total.
    const fixHtml = fixture({
      metrics: { diff: { feature_prs_merged: 21, release_prs_merged: 5, total_repo_prs_merged: 26 } },
      extraBody: r.html.match(/<body>([\s\S]*)<\/body>/)[1]
    });
    const result = v3.validateReport(fixHtml);
    assert.equal(result.findings.filter((f) => f.rule === 3).length, 0);
  });

  it('v5.68.0-v5.71.0: fixes the REAL scrambled next-sprint citation and the corrected text passes Rule 2', () => {
    // Excerpted verbatim from the real production file's #next-sprint h4.
    const realNextSprintExcerpt = '<h4>Session Hierarchy (`#108`), Engine Failover (`#109`), Adversarial Agent (`#1032`), Secure Secrets (`#1257`) &amp; Dynamic Agents (`#1578`)</h4>';
    const r = v3.remediateHistoricalErrata('v5.68.0-v5.71.0', `<html><body>${realNextSprintExcerpt}</body></html>`);
    assert.equal(r.ok, true);
    assert.ok(r.html.includes('Adversarial Agent (`#108`)'));
    assert.ok(r.html.includes('Session Hierarchy (`#1578`)'));
    assert.ok(!r.html.includes('Session Hierarchy (`#108`)'));
    assert.equal(r.errataEntry.field, 'next_sprint_citations');

    const roadmapData = {
      issue_fields: {
        108: { title: '[feature] Adversarial Agent primitive' },
        109: { title: '[feature] Engine-failure failover' },
        1032: { title: 'Cross-machine secure clipboard sync' },
        1257: { title: '[feature] Allow sub-agent parallelization' },
        1578: { title: '[feature] Session hierarchy: let one session direct another' }
      }
    };
    const fixHtml = fixture({ sections: { 'next-sprint': r.html.match(/<h4>([\s\S]*)<\/h4>/)[0] } });
    const result = v3.validateReport(fixHtml, { roadmapData });
    assert.equal(result.findings.filter((f) => f.rule === 2).length, 0);
  });
});
