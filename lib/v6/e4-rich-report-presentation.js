'use strict';

/**
 * v6 (#2988, V6-17 / E4, Car V60-T3-W1-C): Dual-Format Rich Report
 * Presentation over the EXISTING Individual Sprint Report / Multi-Version
 * Retrospective HTML documents (`docs/SPRINT_REPORT_CONTRACT.md`,
 * `lib/v6/sprint-report-validator-v3.js`) — a pure view-model builder, never
 * a second report generator or a second parser of the same HTML shape.
 *
 * "12 4-Part Explainable Metric Popovers" (#2988 deliverable 1) is, verified
 * against the real contract rather than invented: ONE popover per entry in
 * `sprint-report-validator-v3.js`'s own `CANONICAL_SECTIONS` (exactly 12 —
 * `overview, architecture, velocity, deliverables, telemetry, postmortem,
 * waves, next-sprint, plain-english, retro, longitudinal, governance`), not
 * 12 arbitrary numeric fields. `POPOVER_CATALOG` is keyed by that exact
 * list (imported, not re-declared) so the two files can never silently
 * diverge on "what counts as a section."
 *
 * HTML parsing reuses the validator's OWN exported primitives
 * (`extractJsonAnchor`, `extractSection`, `toPlainText`) rather than a
 * second, slightly-different regex over the same markup — this car's
 * envelope does not include editing `sprint-report-validator-v3.js`, and
 * importing its exports is reading a public contract, not editing it.
 *
 * NOT in this car's envelope (no `server.js`/`public/` files here): the
 * actual popover/switcher DOM, and wiring a real report's file into an HTTP
 * route — Wave 2's routes car, per the Train 3 Wave 1 dispatch. This module
 * ships the view-model and the print/PDF stylesheet text only.
 *
 * @module lib/v6/e4-rich-report-presentation
 */

const { extractJsonAnchor, extractSection, toPlainText, CANONICAL_SECTIONS } = require('./sprint-report-validator-v3');

/** #2988's "3-Pillar Switcher": delivery, quality, governance. */
const PILLARS = Object.freeze(['delivery', 'quality', 'governance']);

/** Which pillar each of the 12 canonical sections belongs to -- every `CANONICAL_SECTIONS` entry appears in exactly one. */
const SECTION_PILLAR = Object.freeze({
  overview: 'delivery',
  velocity: 'delivery',
  deliverables: 'delivery',
  waves: 'delivery',
  'next-sprint': 'delivery',
  architecture: 'quality',
  telemetry: 'quality',
  postmortem: 'quality',
  'plain-english': 'quality',
  retro: 'governance',
  longitudinal: 'governance',
  governance: 'governance'
});

/**
 * The 4-part explainable-metric popover content for each of the 12
 * canonical sections (#2988 deliverable 1's exact 4 parts). Each entry is
 * static, hand-authored explanatory copy, not derived from any one report's
 * data -- the SAME explanation applies across every report this renders,
 * which is the whole point of standardizing it.
 */
const POPOVER_CATALOG = Object.freeze({
  overview: Object.freeze({
    what_it_means: 'The headline shape of this report: version/range, duration, and top-line PR counts.',
    how_measured: 'Hero figures sourced directly from #tc-canonical-metrics (timestamps, durations, diff).',
    why_it_matters: 'The fastest way to orient on what happened, before reading any one section in depth.',
    what_it_does_not_prove: 'Not the reconciled source of truth by itself -- Rule 3 (Intra-Document Aggregate Reconciler) is what guarantees this agrees with the body, not this section alone.'
  }),
  architecture: Object.freeze({
    what_it_means: 'True-merge PR counts and the structural shape of what shipped.',
    how_measured: 'feature_prs_merged + release_prs_merged == total_repo_prs_merged (Rule 3), from git log --merges across this report\'s own commit range.',
    why_it_matters: 'This is the canonical PR count for the window -- the number everything else (hero, badges, fleet table) must agree with.',
    what_it_does_not_prove: 'A hero figure that disagrees with this is the STALE one, not this one (see v5.57.0-v5.61.0\'s real defect in the contract doc) -- it does not itself prove code quality or review depth.'
  }),
  velocity: Object.freeze({
    what_it_means: 'Throughput and Agentic Development Efficiency (ADE) over the window.',
    how_measured: 'efficiency.ADE / efficiency.throughput, carried forward from the v2.0.0 contract unchanged, from measured tokens and elapsed time.',
    why_it_matters: 'Lets two windows\' PACE be compared on a common scale.',
    what_it_does_not_prove: 'Not adjusted for scope difficulty -- a harder sprint legitimately reads slower without that being a regression, and this never proves WORK QUALITY, only pace.'
  }),
  deliverables: Object.freeze({
    what_it_means: 'What actually shipped: the list of completed features/fixes, cited by issue.',
    how_measured: 'citations[] -- every Label (#NNNN) pair the rendered prose names.',
    why_it_matters: 'The concrete, checkable list a stakeholder can verify against the roadmap.',
    what_it_does_not_prove: 'Every citation here is title-verified against the roadmap (Rule 2) -- a mismatch means the LABEL text is wrong, never proof the issue itself is miscategorized or incomplete.'
  }),
  telemetry: Object.freeze({
    what_it_means: 'Cost and resource consumption: measured/estimated tokens, subscription vs. API-shadow cost.',
    how_measured: 'The 4 economics fields (Rule 6): measured_tokens, estimated_tokens, subscription_allocated_cost_usd, api_shadow_cost_usd.',
    why_it_matters: 'The cost side of the velocity/throughput story -- what this window actually consumed.',
    what_it_does_not_prove: 'api_shadow_cost_usd is a WHAT-IF (metered-API-pricing estimate), not a bill -- it does not prove actual spend, and never sum it with subscription_allocated_cost_usd as "total spend".'
  }),
  postmortem: Object.freeze({
    what_it_means: 'What went wrong and what was learned, narratively.',
    how_measured: 'No numeric formula -- qualitative narrative, contamination-checked (Rule 8) against other reports.',
    why_it_matters: 'Where the root-cause reasoning behind an incident actually lives, not just the incident count.',
    what_it_does_not_prove: 'Narrative, not a metric -- this does not prove the SAME root cause will or will not recur, only records what was understood at the time.'
  }),
  waves: Object.freeze({
    what_it_means: 'How work was decomposed into parallel execution waves/cars.',
    how_measured: 'scope_taxonomy.chartered_execution_cars_completed (one of Rule 4\'s 3 counts).',
    why_it_matters: 'Shows the actual parallelism/decomposition strategy behind the throughput figures.',
    what_it_does_not_prove: 'Counts COMPLETED cars only -- it does not prove nothing was still in flight at report time, only what finished.'
  }),
  'next-sprint': Object.freeze({
    what_it_means: 'What is planned for the NEXT window, cited by issue.',
    how_measured: 'citations[] -- same verification as deliverables, Rule 2 explicitly does not exempt this section.',
    why_it_matters: 'Forward-looking: the roadmap\'s current state, so a reader knows what to expect next.',
    what_it_does_not_prove: 'A plan, not a commitment -- it does not prove any of it will actually ship (the real v2.1.0 defect this exists to prevent was exactly a scrambled citation list here, contract doc Defect Case 2).'
  }),
  'plain-english': Object.freeze({
    what_it_means: 'A non-technical restatement of the report\'s substance.',
    how_measured: 'No numeric formula -- a prose restatement, contamination-checked like every other narrative section.',
    why_it_matters: 'For a reader who wants the gist without parsing the metrics sections.',
    what_it_does_not_prove: 'A restatement, not a second source -- it does not prove the figures it paraphrases; cross-check a number here against its own section before quoting it.'
  }),
  retro: Object.freeze({
    what_it_means: 'Retrospective reflection: what to keep doing, what to change.',
    how_measured: 'No numeric formula -- qualitative, contamination-checked against other legs in retrospective mode.',
    why_it_matters: 'Governance input for the NEXT planning cycle.',
    what_it_does_not_prove: 'Not a verdict on THIS window\'s success -- it reflects on process, never proves outcome quality by itself.'
  }),
  longitudinal: Object.freeze({
    what_it_means: 'Trend across multiple versions/legs (retrospective mode only).',
    how_measured: 'Aggregate figures reconcile against the SUM of bundled legs, not each leg individually (contract doc, Scope section).',
    why_it_matters: 'The only place a multi-window TREND is visible at all -- no single-version report shows this.',
    what_it_does_not_prove: 'Single-mode reports report this as not-applicable rather than a vacuous pass -- its absence does not prove a flat trend, only that this report cannot see one.'
  }),
  governance: Object.freeze({
    what_it_means: 'Release-state progress and process compliance for the window.',
    how_measured: 'release_state[] drawn from the 7-term vocabulary (Rule 5) -- no free-text synonym.',
    why_it_matters: 'The audit trail for whether this window\'s release actually followed the governed pipeline.',
    what_it_does_not_prove: 'A state list, not a timeline -- it says WHICH of the 7 happened, not when, and never implies one not listed has NOT started.'
  })
});

/**
 * One section's rendered view-model: its canonical popover, pillar, and a
 * bounded plain-text excerpt (never the full section -- a popover is a
 * hint, not a second copy of the report).
 * @param {string} html
 * @param {string} sectionId
 * @param {number} excerptChars
 * @returns {{id: string, pillar: string, popover: object, excerpt: string}}
 */
function _sectionViewModel(html, sectionId, excerptChars) {
  const fragment = extractSection(html, sectionId);
  const text = toPlainText(fragment);
  return {
    id: sectionId,
    pillar: SECTION_PILLAR[sectionId],
    popover: POPOVER_CATALOG[sectionId],
    excerpt: text.length > excerptChars ? `${text.slice(0, excerptChars).trimEnd()}…` : text
  };
}

/**
 * Build the full rich-presentation view-model for one report (#2988
 * deliverable 1): every canonical section's popover/pillar/excerpt, plus
 * the raw `#tc-canonical-metrics` anchor for a renderer's own number
 * display. Works for both `single` and `retrospective` mode HTML -- this
 * never inspects `options.mode` itself, since every rule here reads
 * identically across both (the mode only changes how Rule 3/8 reconcile,
 * which is the validator's job, not this view-model's).
 * @param {string} html - A full report document's raw HTML.
 * @param {{excerptChars?: number}} [options]
 * @returns {{metrics: object|null, sections: Array<object>}}
 */
function buildReportViewModel(html, { excerptChars = 240 } = {}) {
  const metricsAnchor = extractJsonAnchor(html, 'tc-canonical-metrics');
  return {
    metrics: metricsAnchor.ok ? metricsAnchor.value : null,
    sections: CANONICAL_SECTIONS.map((id) => _sectionViewModel(html, id, excerptChars))
  };
}

/**
 * Group a view-model's sections by pillar for the 3-Pillar Progressive
 * Disclosure Switcher (#2988 deliverable 2) -- a renderer shows one
 * pillar's sections at a time and switches between the 3.
 * @param {{sections: Array<{id: string, pillar: string}>}} viewModel - From {@link buildReportViewModel}.
 * @returns {Record<string, Array<object>>} Keyed by `PILLARS`, each an ordered array of that pillar's sections (canonical order preserved).
 */
function buildPillarSwitcherModel(viewModel) {
  const byPillar = Object.fromEntries(PILLARS.map((p) => [p, []]));
  for (const section of viewModel.sections) byPillar[section.pillar].push(section);
  return byPillar;
}

/**
 * Deterministic archival Print/PDF stylesheet (#2988 deliverable 2): hides
 * interactive-only chrome (popovers, the pillar switcher's own controls,
 * anything marked `data-print-hide`) and forces every pillar's sections
 * visible at once, since a printed page has no switcher to click.
 */
const PRINT_STYLESHEET = `
@media print {
  [data-popover-trigger], [data-pillar-switcher], [data-print-hide] { display: none !important; }
  [data-pillar-panel] { display: block !important; }
  section { page-break-inside: avoid; }
  a[href^="#"]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #555; }
}
`.trim();

/**
 * A print-ready copy of the report: the print stylesheet appended before
 * `</head>`, and a `data-print-hide` marker left for anything the caller's
 * own markup already tagged that way -- this never strips or rewrites the
 * report's own content, only adds the one `<style>` block print mode needs.
 * @param {string} html - A full report document's raw HTML.
 * @returns {string}
 */
function buildPrintView(html) {
  const styleBlock = `<style data-e4-print>${PRINT_STYLESHEET}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${styleBlock}</head>`) : `${styleBlock}\n${html}`;
}

module.exports = {
  PILLARS,
  SECTION_PILLAR,
  POPOVER_CATALOG,
  PRINT_STYLESHEET,
  buildReportViewModel,
  buildPillarSwitcherModel,
  buildPrintView
};
