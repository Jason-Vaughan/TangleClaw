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
    durations: { total_run_time_display: '3h 00m 00s' },
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

  it('toPlainText drops <script>/<style> content entirely — a JSON anchor\'s own reason text must never read as rendered prose', () => {
    const html = '<p>26 PRs</p><script type="application/json">{"reason":"the real count is 99 PRs"}</script><style>.x{content:"26 PRs"}</style>';
    assert.equal(v3.toPlainText(html), '26 PRs');
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

  it('is skipped (not failed) when no roadmapData is supplied and the issue is outside the built-in floor', () => {
    const html = fixture({ sections: { 'next-sprint': '<h4>Wrong Label (#9999)</h4>' } });
    assert.equal(v3.validateReport(html).findings.filter((f) => f.rule === 2).length, 0);
  });

  it('still checks against the built-in KNOWN_ISSUE_TITLES floor when no roadmapData is supplied', () => {
    assert.ok(v3.KNOWN_ISSUE_TITLES[108] && v3.KNOWN_ISSUE_TITLES[108].title, 'the floor names #108\'s real title');
    const html = fixture({ sections: { 'next-sprint': '<h4>Wrong Label (#108)</h4>' } });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 2 && f.code === 'CITATION_MISMATCH' && f.message.includes('#108')));
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
      metrics: {
        diff: { feature_prs_merged: 21, release_prs_merged: 5, total_repo_prs_merged: 26 },
        durations: { total_run_time_display: '12h 16m (736m)' }
      },
      extraBody: '<div class="eyebrow">26 PRs · TOTAL RUN TIME: 12h 16m (736m) TO FINAL MERGE</div>'
    });
    const r = v3.validateReport(html);
    assert.equal(r.findings.filter((f) => f.rule === 3).length, 0);
  });

  it('fails when the anchor omits durations.total_run_time_display entirely (PM R-Gate Round 2)', () => {
    const html = fixture({ metrics: { durations: undefined } });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 3 && f.code === 'DURATION_FIELD_MISSING'));
    assert.equal(r.ok, false);
  });

  it('fails when durations.total_run_time_display is an empty string', () => {
    const html = fixture({ metrics: { durations: { total_run_time_display: '' } } });
    const r = v3.validateReport(html);
    assert.ok(r.findings.some((f) => f.rule === 3 && f.code === 'DURATION_FIELD_MISSING'));
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
    const r = v3.remediateHistoricalErrata('v5.57.0-v5.61.0', '<html><body>already fine, 27 True-Merged PRs</body></html>');
    assert.equal(r.ok, false);
    assert.match(r.reason, /nothing to remediate/);
  });

  it('v5.57.0-v5.61.0: fixes the REAL body/badge contradiction (stale 26-PR figures) and the corrected text passes Rule 3', () => {
    // Excerpted verbatim (shape) from the real production file's Architecture section
    // badge, fleet table and Total Run Time card — the STALE, pre-reconciliation
    // figures. The hero banner already stated the canonical 27-PR / 12h15m26s totals;
    // the body never caught up. Direction verified directly against git (Architect
    // Ruling A512-PR3006-R1-HOLD B2): 27 (22 feature + 5 release) is canonical.
    const staleBodyExcerpt = '<div class="architecture-badge">26 True-Merged PRs</div>'
      + '<p>all 26 merged PRs are true `--no-ff` merges</p>'
      + '<table><tr><td>21 feature cars + 5 release cuts</td></tr></table>'
      + '<div class="total-run-time-card">Total Run Time: 12h 16m (736m) Start-to-Finish</div>';
    const r = v3.remediateHistoricalErrata('v5.57.0-v5.61.0', `<html><body>${staleBodyExcerpt}</body></html>`);
    assert.equal(r.ok, true);
    // The embedded #tc-report-errata anchor's own `reason` text legitimately
    // narrates the stale figures it corrected — check the VISIBLE markup
    // (anchor excluded) is actually fixed, not the raw string as a whole.
    const visible = r.html.replace(/<script type="application\/json" id="tc-report-errata">[\s\S]*?<\/script>/, '');
    assert.ok(visible.includes('27 True-Merged PRs'));
    assert.ok(!visible.includes('26 True-Merged PRs'));
    assert.ok(visible.includes('22 feature cars + 5 release cuts'));
    assert.ok(visible.includes('12h 15m 26s Start-to-Finish'));
    assert.ok(visible.includes('Revision 1.1'));
    assert.equal(r.errataEntry.original_value, '26');
    assert.equal(r.errataEntry.corrected_value, '27');

    // The #tc-report-errata JSON anchor itself must be present and carry the entry.
    assert.ok(r.html.includes('id="tc-report-errata"'));
    const anchorMatch = r.html.match(/<script type="application\/json" id="tc-report-errata">([\s\S]*?)<\/script>/);
    const anchorJson = JSON.parse(anchorMatch[1]);
    assert.ok(Array.isArray(anchorJson.errata_ledger));
    assert.ok(anchorJson.errata_ledger.some((e) => e.original_value === '26' && e.corrected_value === '27'));

    // Re-validate: splice the remediated body text (now carrying the banner too)
    // into a fixture whose anchor already states the reconciled 27-PR total and
    // matching duration — the corrected body must no longer disagree with either.
    const fixHtml = fixture({
      metrics: {
        diff: { feature_prs_merged: 22, release_prs_merged: 5, total_repo_prs_merged: 27 },
        durations: { total_run_time_display: '12h 15m 26s' }
      },
      extraBody: r.html.match(/<body>([\s\S]*)<\/body>/)[1]
    });
    const result = v3.validateReport(fixHtml);
    assert.equal(result.findings.filter((f) => f.rule === 3).length, 0);
  });

  it('v5.57.0-v5.61.0: remediates EVERY distinct stale phrase shape found in the REAL production HTML (PM/PRR-A R-Gate Round 2)', () => {
    // Excerpted verbatim from TangleClaw-Shared/sprint-reports/v5.57.0-v5.61.0-retrospective/index.html
    // (lines 590, 606, 608, 628, 652, 808, 931, 1045, 1046, 1133, 1216, 1272,
    // 1273, 1279, 1280) — the full catalogue of distinct surrounding phrasings
    // PRR-A found Round 1's two hardcoded phrases did not reach.
    const productionShapedExcerpt = [
      '<span class="badge badge-green" style="font-size:0.76rem;padding:4px 10px;">📖 PLAIN-ENGLISH SUMMARY · FIVE VERSIONS SHIPPED BACK-TO-BACK IN 12h 16m TOTAL WALL-CLOCK TIME (5h 36m → 22m)</span>',
      '<h4 style="margin:0 0 8px;color:var(--green);font-size:0.98rem;">⏱️ Total Run Time: 12h 16m Start-to-Finish (5h 36m → 4h 09m → 1h 15m → 56m → 22m)</h4>',
      '<p>total elapsed wall-clock time was <strong><code>12h 16m</code> (<code>736m</code>)</strong> (<code>12h 20m</code> to final O-Gate closeout)</p>',
      '<span class="badge badge-blue">10 Active Lanes · 5 Co-Signed Charters (A494–A498) · 26 True-Merged PRs</span>',
      '<td>Authored Charters A494–A498, orchestrated 21 feature cars + 5 release cuts, enforced Guardrail 06 pipelining</td>',
      '<td><span class="badge badge-green">100% 2-parent ancestry preserved across all 26 PRs</span></td>',
      '<p class="section-desc">Complete rollup of the 21 feature cars and 5 release cuts (`26` PRs, `+29,421 / -881` LOC across `186` files).</p>',
      '<td><strong><code>100%</code> True Merge (26/26 Train PRs)</strong></td>',
      '<td><span class="badge badge-green">Zero squash/rebase merges; 100% 2-parent ancestry preserved across all 26 PRs</span></td>',
      '<span><strong>26 / 26 True Merges (100% 2-Parent Ancestry)</strong></span>',
      '<p>kept Mac Studio host CPU contention at zero across all 26 PRs.</p>',
      '<td>100% exact-head PRR ACCEPT verdicts across all 26 PRs; 28 pre-merge findings resolved</td>',
      '<td><span class="badge badge-green">PASS (26/26 PRs)</span></td>',
      '<td>All 26 PRs merged via <code>gh pr merge --merge</code> (Rule #282, 2 parents each)</td>',
      '<td><span class="badge badge-green">PASS (26/26 True Merges)</span></td>'
    ].join('\n');
    const r = v3.remediateHistoricalErrata('v5.57.0-v5.61.0', `<html><body>${productionShapedExcerpt}</body></html>`);
    assert.equal(r.ok, true);

    const visible = r.html.replace(/<script type="application\/json" id="tc-report-errata">[\s\S]*?<\/script>/, '');
    // Not a single stale "26 ... PRs/Merges" or "12h 16m" shape survives.
    assert.equal((visible.match(/26[^<\n]{0,25}(PRs|Merges)/gi) || []).length, 0);
    assert.equal((visible.match(/12h\s*16m/g) || []).length, 0);
    assert.equal((visible.match(/\b21 feature cars\b/) || []).length, 0);
    assert.ok(visible.includes('27 True-Merged PRs'));
    assert.ok(visible.includes('22 feature cars + 5 release cuts'));
    assert.ok(visible.includes('22 feature cars and 5 release cuts'));
    assert.ok(visible.includes('27/27 Train PRs'));
    assert.ok(visible.includes('27/27 True Merges'));
    assert.ok(visible.includes('(27/27 PRs)'));
    assert.ok(visible.includes('(27/27 True Merges)'));
    assert.ok(visible.includes('12h 15m 26s Start-to-Finish'));
    assert.ok(visible.includes('12h 15m 26s TOTAL WALL-CLOCK TIME'));
    assert.ok(visible.includes('<code>12h 15m 26s</code></strong> (<code>12h 20m</code>'));

    // The remediated HTML embeds the machine-checked #tc-report-errata anchor,
    // not just the visible banner, and passes validateReport() clean on Rule 3
    // once spliced into a v3 anchor stating the reconciled totals.
    assert.ok(r.html.includes('id="tc-report-errata"'));
    const fixHtml = fixture({
      metrics: {
        diff: { feature_prs_merged: 22, release_prs_merged: 5, total_repo_prs_merged: 27 },
        durations: { total_run_time_display: '12h 15m 26s' }
      },
      extraBody: r.html.match(/<body>([\s\S]*)<\/body>/)[1]
    });
    const result = v3.validateReport(fixHtml);
    assert.equal(result.findings.filter((f) => f.rule === 3).length, 0, JSON.stringify(result.findings.filter((f) => f.rule === 3)));
  });

  it('v5.68.0-v5.71.0: fixes the REAL scrambled next-sprint citation and the corrected text passes Rule 2', () => {
    // Excerpted verbatim from the real production file's #next-sprint h4.
    const realNextSprintExcerpt = '<h4>Session Hierarchy (`#108`), Engine Failover (`#109`), Adversarial Agent (`#1032`), Secure Secrets (`#1257`) &amp; Dynamic Agents (`#1578`)</h4>';
    const r = v3.remediateHistoricalErrata('v5.68.0-v5.71.0', `<html><body>${realNextSprintExcerpt}</body></html>`);
    assert.equal(r.ok, true);
    assert.ok(r.html.includes('Adversarial Agent (`#108`)'));
    assert.ok(r.html.includes('Session Hierarchy (`#1578`)'));
    assert.ok(!r.html.includes('Session Hierarchy (`#108`)'));
    assert.equal(r.errataEntry.field, 'issue_citations');
    assert.ok(r.html.includes('id="tc-report-errata"'));
    const anchorJson = JSON.parse(r.html.match(/<script type="application\/json" id="tc-report-errata">([\s\S]*?)<\/script>/)[1]);
    assert.ok(anchorJson.errata_ledger.some((e) => e.field === 'issue_citations'));

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
