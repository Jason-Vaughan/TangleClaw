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
    what_it_measures: 'The headline shape of this report: version/range, duration, and top-line PR counts.',
    formula: 'Hero figures sourced directly from #tc-canonical-metrics (timestamps, durations, diff).',
    inputs_and_window: 'This report\'s own declared commit range and timestamp window (t1..t8).',
    decision_guidance: 'Use for "what happened, roughly" at a glance -- never as the reconciled source of truth; Rule 3 (Intra-Document Aggregate Reconciler) is what guarantees this agrees with the body.'
  }),
  architecture: Object.freeze({
    what_it_measures: 'True-merge PR counts and the structural shape of what shipped.',
    formula: 'feature_prs_merged + release_prs_merged == total_repo_prs_merged (Rule 3).',
    inputs_and_window: 'git log --merges across this report\'s own commit range.',
    decision_guidance: 'The canonical PR count for this window; a hero figure that disagrees with this is the stale one (see v5.57.0-v5.61.0\'s real defect in the contract doc).'
  }),
  velocity: Object.freeze({
    what_it_measures: 'Throughput and Agentic Development Efficiency (ADE) over the window.',
    formula: 'efficiency.ADE / efficiency.throughput, carried forward from the v2.0.0 contract unchanged.',
    inputs_and_window: 'Measured tokens, elapsed time, and completed-work count for this window only.',
    decision_guidance: 'Compares velocity WITHIN this report\'s own window; not adjusted for scope difficulty, so a harder sprint legitimately reads slower without that being a regression.'
  }),
  deliverables: Object.freeze({
    what_it_measures: 'What actually shipped: the list of completed features/fixes, cited by issue.',
    formula: 'citations[] -- every Label (#NNNN) pair the rendered prose names.',
    inputs_and_window: 'This report\'s own commit range and the roadmap source for issue titles.',
    decision_guidance: 'Every citation here is title-verified against the roadmap (Rule 2) -- a mismatch means the LABEL is wrong, not necessarily the issue.'
  }),
  telemetry: Object.freeze({
    what_it_measures: 'Cost and resource consumption: measured/estimated tokens, subscription vs. API-shadow cost.',
    formula: 'The 4 economics fields (Rule 6): measured_tokens, estimated_tokens, subscription_allocated_cost_usd, api_shadow_cost_usd.',
    inputs_and_window: 'Usage telemetry for this report\'s own window only, never cumulative.',
    decision_guidance: 'api_shadow_cost_usd is a WHAT-IF (metered-API-pricing estimate), not a bill -- never sum it with subscription_allocated_cost_usd as "total spend".'
  }),
  postmortem: Object.freeze({
    what_it_measures: 'What went wrong and what was learned, narratively.',
    formula: 'No numeric formula -- qualitative narrative, contamination-checked (Rule 8) against other reports.',
    inputs_and_window: 'This report\'s own incidents/retros for the window.',
    decision_guidance: 'Narrative, not a metric -- read for root cause, not for a number to trend.'
  }),
  waves: Object.freeze({
    what_it_measures: 'How work was decomposed into parallel execution waves/cars.',
    formula: 'scope_taxonomy.chartered_execution_cars_completed (one of Rule 4\'s 3 counts).',
    inputs_and_window: 'This report\'s own chartered car completions for the window.',
    decision_guidance: 'Counts COMPLETED cars only -- a car still in flight at report time is not represented here.'
  }),
  'next-sprint': Object.freeze({
    what_it_measures: 'What is planned for the NEXT window, cited by issue.',
    formula: 'citations[] -- same verification as deliverables, Rule 2 explicitly does not exempt this section.',
    inputs_and_window: 'Forward-looking: the roadmap\'s current state, not this window\'s actuals.',
    decision_guidance: 'A plan, not a commitment -- the real v2.1.0 defect this exists to prevent was exactly a scrambled citation list here (contract doc, Defect Case 2).'
  }),
  'plain-english': Object.freeze({
    what_it_measures: 'A non-technical restatement of the report\'s substance.',
    formula: 'No numeric formula -- a prose restatement, contamination-checked like every other narrative section.',
    inputs_and_window: 'This report\'s own content only.',
    decision_guidance: 'For a reader who wants the gist without the metrics -- cross-check a number here against its own section before quoting it, this is a restatement, not a second source.'
  }),
  retro: Object.freeze({
    what_it_measures: 'Retrospective reflection: what to keep doing, what to change.',
    formula: 'No numeric formula -- qualitative, contamination-checked against other legs in retrospective mode.',
    inputs_and_window: 'This report\'s own window (or, in retrospective mode, every bundled leg).',
    decision_guidance: 'Governance input for the NEXT planning cycle, not a verdict on this one.'
  }),
  longitudinal: Object.freeze({
    what_it_measures: 'Trend across multiple versions/legs (retrospective mode only).',
    formula: 'Aggregate figures reconcile against the SUM of bundled legs, not each leg individually (contract doc, Scope section).',
    inputs_and_window: 'Every leg bundled into this retrospective.',
    decision_guidance: 'Single-mode reports report this as not-applicable rather than a vacuous pass -- absence here does not mean "flat trend".'
  }),
  governance: Object.freeze({
    what_it_measures: 'Release-state progress and process compliance for the window.',
    formula: 'release_state[] drawn from the 7-term vocabulary (Rule 5) -- no free-text synonym.',
    inputs_and_window: 'This report\'s own release pipeline state at generation time.',
    decision_guidance: 'A state list, not a timeline -- it says WHICH of the 7 happened, not when, and never implies one not listed has NOT started.'
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
