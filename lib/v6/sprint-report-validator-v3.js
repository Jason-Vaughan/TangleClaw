'use strict';

/**
 * Sprint Report Contract v3.0.0 validator (#2979).
 *
 * Ten deterministic rules over one report's rendered HTML and its two embedded
 * JSON anchors (`#tc-canonical-metrics`, `#tc-report-errata`) — see
 * `docs/SPRINT_REPORT_CONTRACT.md` for the full contract each rule enforces
 * and why each one exists. Built after forensic analysis of two real
 * production defects that shipped past the prior validator
 * (`TangleClaw-Shared/sprint-reports/validate-sprint-report.py` v2.1.0):
 *
 * - `v5.57.0-v5.61.0-retrospective`: hero banner said 27 PRs / 12h 15m 26s;
 *   the Architecture section said 26 PRs / 12h 16m (736m). The v2.1.0
 *   validator exempted this report from canonical-metrics checks entirely
 *   (its version predated the cutoff) and had no reconciler across rendered
 *   locations at all.
 * - `v5.68.0-v5.71.0-retrospective`: `#next-sprint` cited five issue numbers
 *   zipped against an unsorted label list, scrambling four of five
 *   Issue-ID-to-title mappings. The v2.1.0 validator's one contamination
 *   check joined a hardcoded list of sections that excluded `#next-sprint`,
 *   and never verified any citation against a roadmap source.
 *
 * Both are intra-document or cross-source disagreements — not sophistication
 * failures, missing-check failures. Every rule here closes one such gap.
 *
 * `remediateHistoricalErrata` is a narrow, purpose-built helper for exactly
 * those two known defects — it does not generalize to "fix any report";
 * general correction is what Rules 1-10 catch so no THIRD one ships unnoticed.
 */

const fs = require('node:fs');

/** The 12 sections every report declares, in declaration order. Both axes (single + retrospective) share this list; a retrospective's own legs are narrative content inside these same sections, not separate documents. */
const CANONICAL_SECTIONS = [
  'overview', 'architecture', 'velocity', 'deliverables', 'telemetry',
  'postmortem', 'waves', 'next-sprint', 'plain-english', 'retro',
  'longitudinal', 'governance'
];

/** The seven release-state terms Rule 5 allows — a report states which have happened, never a prose synonym for one. */
const RELEASE_STATE_VOCAB = [
  'code_merged_on_main', 'release_pr_merged', 'git_tag_published',
  'github_release_published', 'gate_4_report_validated',
  'public_mirror_synced', 'live_3102_deployed'
];

/** The four fields Rule 6 requires, each a non-negative number. */
const ECONOMICS_FIELDS = [
  'measured_tokens', 'estimated_tokens',
  'subscription_allocated_cost_usd', 'api_shadow_cost_usd'
];

/** The five fields Rule 7 requires, each a non-empty string. */
const PROVENANCE_FIELDS = [
  'generated_at', 'verified_at', 'canonical_source_sha256',
  'git_main_head_sha', 'validator_version'
];

const VALIDATOR_VERSION = '3.0.0';

/**
 * A small built-in floor for Rule 2 when no external `roadmapData` is
 * supplied — exactly the five issue numbers Defect Case 2
 * (`v5.68.0-v5.71.0-retrospective`'s scrambled `#next-sprint`) scrambled,
 * each title verified directly via `gh issue view <N>` (2026-11-10), not
 * guessed or copied from the plan's own narrative. Real `roadmapData`
 * always takes precedence when supplied (`ruleCitationVerifier` spreads
 * this UNDER it); this exists so the shipped CLI can catch the one defect
 * this car was built to fix without requiring an external
 * `roadmap2-data.json` snapshot — it is a floor, not a substitute for the
 * real roadmap source for any OTHER issue number.
 */
const KNOWN_ISSUE_TITLES = {
  108: { title: '[feature] Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation' },
  109: { title: '[feature] Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation' },
  1032: { title: 'Cross-machine secure clipboard sync and file/secret uploader' },
  1257: { title: '[feature] Authorization toggle: Allow sub-agent parallelization' },
  1578: { title: '[feature] Session hierarchy: let one session direct, wrap and clear another' }
};

/**
 * One violation or warning `validateReport` found.
 * @typedef {{rule: number, code: string, severity: 'blocking'|'warning', message: string}} Finding
 */

/**
 * Extract one embedded JSON anchor by its `id`.
 * @param {string} html
 * @param {string} id - e.g. `tc-canonical-metrics`
 * @returns {{ok: true, value: object}|{ok: false, reason: string}}
 */
function extractJsonAnchor(html, id) {
  const re = new RegExp(`<script[^>]+type="application/json"[^>]+id="${id}"[^>]*>([\\s\\S]*?)</script>`);
  const m = html.match(re);
  if (!m) return { ok: false, reason: `no <script type="application/json" id="${id}"> block found` };
  try {
    return { ok: true, value: JSON.parse(m[1].trim()) };
  } catch (err) {
    return { ok: false, reason: `invalid JSON in #${id}: ${err.message}` };
  }
}

/**
 * Extract one `<section id="...">...</section>` block's inner HTML, or ''
 * when the section is absent — absence is a fact Rule 4/8 may act on, not a
 * throw.
 * @param {string} html
 * @param {string} sectionId
 * @returns {string}
 */
function extractSection(html, sectionId) {
  const m = html.match(new RegExp(`<section[^>]+id="${sectionId}"[^>]*>([\\s\\S]*?)</section>`));
  return m ? m[1] : '';
}

/**
 * Plain text of an HTML fragment: tags stripped, entities decoded for the
 * handful that appear in these reports, whitespace collapsed. Good enough for
 * citation scanning and n-gram comparison — never re-rendered, never trusted
 * for anything byte-exact.
 * @param {string} fragment
 * @returns {string}
 */
function toPlainText(fragment) {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `Label (#NNNN)` citation in a fragment, tolerating the backtick or
 * `<code>` styling these reports mix freely around the `#NNNN` (and
 * sometimes around the label too).
 * @param {string} fragment - Raw HTML (not yet stripped — label text may carry inline tags this strips per-match).
 * @returns {Array<{label: string, issue: number, raw: string}>}
 */
function extractCitations(fragment) {
  const text = toPlainText(fragment);
  const re = /([A-Za-z][A-Za-z0-9 /&'-]{1,60}?)\s*\(\s*`?#(\d{1,5})`?\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ label: m[1].trim(), issue: Number(m[2]), raw: m[0] });
  }
  return out;
}

/**
 * Word n-grams of a fixed size, lowercased, as a Set (duplicates within one
 * text collapse — contamination detection asks "does this run appear
 * elsewhere", not "how many times").
 * @param {string} text - Plain text (already `toPlainText`'d).
 * @param {number} n - Run length in words.
 * @returns {Set<string>}
 */
function nGrams(text, n) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Default phrases excluded from Rule 8 — generic boilerplate every report
 * legitimately repeats (pipeline/tooling descriptions, not narrative
 * content), named here because v2.1.0's own forensic record (#2979's
 * canonical plan, Defect Case 2) cites one of them by name. A caller's own
 * `options.allowlist` extends this; it never replaces it.
 */
const DEFAULT_CONTAMINATION_ALLOWLIST = [
  'verify local head matches charter base sha before any edit'
];

// ── The ten rules ──────────────────────────────────────────────────────────
// Each takes the shared `ctx` `validateReport` builds and returns `Finding[]`
// (empty when clean). None throws on malformed input — a report this broken
// is exactly what these exist to report on, not to crash over.

/** Rule 1 — Canonical Versioned Source Lock. */
function ruleSourceLock(ctx) {
  const out = [];
  const prov = ctx.metrics && ctx.metrics.provenance;
  const sha = prov && prov.canonical_source_sha256;
  if (!sha || typeof sha !== 'string' || !sha.trim()) {
    out.push(_finding(1, 'SOURCE_LOCK_MISSING', 'blocking',
      'provenance.canonical_source_sha256 is missing — the report carries no bound source snapshot to verify against.'));
    return out;
  }
  if (ctx.sourcesLock) {
    const locked = ctx.sourcesLock[ctx.version];
    if (!locked) {
      out.push(_finding(1, 'SOURCE_LOCK_UNRECORDED', 'blocking',
        `the supplied sources lock has no entry for "${ctx.version}".`));
    } else if (locked.canonical_source_sha256 !== sha) {
      out.push(_finding(1, 'SOURCE_LOCK_MISMATCH', 'blocking',
        `provenance.canonical_source_sha256 ("${sha}") disagrees with the sources lock's recorded value ("${locked.canonical_source_sha256}") for "${ctx.version}".`));
    }
  }
  return out;
}

/** Rule 2 — Issue Citation Verifier. Every section, `#next-sprint` included. */
function ruleCitationVerifier(ctx) {
  const out = [];
  // (PRR-A R1 catch on PR #3006) A caller-supplied `roadmapData` is still
  // preferred and takes precedence, but its absence no longer silences this
  // rule outright: `KNOWN_ISSUE_TITLES` (verified via `gh issue view`, not
  // guessed) at minimum lets the CLI catch the exact historical #next-sprint
  // defect this car exists to fix without requiring an external
  // roadmap2-data.json snapshot to be piped in. Genuinely unknown issue
  // numbers (anything outside this small built-in set, absent an external
  // roadmapData) still skip — this is a floor, not a substitute for the
  // real roadmap source.
  const titles = { ...KNOWN_ISSUE_TITLES, ...((ctx.roadmapData && ctx.roadmapData.issue_fields) || {}) };
  for (const sectionId of CANONICAL_SECTIONS) {
    const section = extractSection(ctx.html, sectionId);
    if (!section) continue;
    for (const c of extractCitations(section)) {
      const real = titles[String(c.issue)];
      if (!real || !real.title) continue; // not every citation's issue is in the roadmap snapshot — not this rule's concern
      if (!_titlesAgree(c.label, real.title)) {
        out.push(_finding(2, 'CITATION_MISMATCH', 'blocking',
          `#${sectionId} cites "${c.label}" for #${c.issue}, but its recorded title is "${real.title}".`,
          'issue_citations'));
      }
    }
  }
  return out;
}

/** Loose agreement: the cited label must appear as a substring (case-insensitive) of the real title, or vice versa — citations are shortened labels, never full titles verbatim. */
function _titlesAgree(label, realTitle) {
  const l = label.toLowerCase().trim();
  const t = realTitle.toLowerCase().replace(/^\[[a-z]+\]\s*/, '').trim(); // strip a leading "[feature] " kind tag
  return t.includes(l) || l.includes(t) || _wordOverlap(l, t) >= 0.5;
}

/** Fraction of `a`'s words that also appear in `b` — a cheap stand-in for "these describe the same thing" when neither is a clean substring of the other. */
function _wordOverlap(a, b) {
  const aw = a.split(/\s+/).filter((w) => w.length > 2);
  const bw = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (aw.length === 0) return 0;
  return aw.filter((w) => bw.has(w)).length / aw.length;
}

/** Rule 3 — Intra-Document Aggregate Reconciler. */
function ruleAggregateReconciler(ctx) {
  const out = [];
  const diff = ctx.metrics && ctx.metrics.diff;
  if (diff && typeof diff.feature_prs_merged === 'number' && typeof diff.release_prs_merged === 'number'
    && typeof diff.total_repo_prs_merged === 'number') {
    const sum = diff.feature_prs_merged + diff.release_prs_merged;
    if (sum !== diff.total_repo_prs_merged) {
      out.push(_finding(3, 'PR_COUNT_SUM_MISMATCH', 'blocking',
        `feature_prs_merged (${diff.feature_prs_merged}) + release_prs_merged (${diff.release_prs_merged}) = ${sum}, but total_repo_prs_merged is ${diff.total_repo_prs_merged}.`,
        'total_prs_merged'));
    }
  }
  // Cross-check the anchor's total against every rendered "<N> ... PRs"/"True-Merged PRs" figure.
  if (diff && typeof diff.total_repo_prs_merged === 'number') {
    const rendered = _renderedPrCounts(ctx.html);
    for (const r of rendered) {
      if (r.count !== diff.total_repo_prs_merged) {
        out.push(_finding(3, 'PR_COUNT_RENDERED_MISMATCH', 'blocking',
          `#tc-canonical-metrics names ${diff.total_repo_prs_merged} total PRs, but rendered text "${r.context}" states ${r.count}.`,
          'total_prs_merged'));
      }
    }
  }
  // (Architect Ruling A512-PR3006-R1-HOLD B3) Durations reconcile too, the
  // same way PR counts do — issue #2979's own deliverable named this
  // explicitly, and it is exactly the shape Defect Case 1 took for the OTHER
  // half of its contradiction ("12h 15m 26s" hero vs. "12h 16m (736m)" body).
  const durations = ctx.metrics && ctx.metrics.durations;
  const expectedRunTime = durations && typeof durations.total_run_time_display === 'string' ? durations.total_run_time_display : null;
  if (expectedRunTime) {
    for (const rendered of _renderedTotalRunTimes(ctx.html)) {
      if (!_durationsAgree(rendered.duration, expectedRunTime)) {
        out.push(_finding(3, 'DURATION_RENDERED_MISMATCH', 'blocking',
          `#tc-canonical-metrics names total_run_time_display "${expectedRunTime}", but rendered text "${rendered.context}" states "${rendered.duration}".`,
          'total_run_time'));
      }
    }
  }
  return out;
}

/** Every rendered "Total Run Time: <duration>" / "TOTAL RUN TIME: <duration>" figure — hero eyebrow, meta pill, body card, KPI card alike. */
function _renderedTotalRunTimes(html) {
  const text = toPlainText(html);
  const out = [];
  const re = /total run time[^0-9]{0,40}?(\d{1,2}h\s*\d{1,2}m(?:\s*\d{1,2}s)?(?:\s*\(\d+m\))?)/gi;
  let m;
  while ((m = re.exec(text))) {
    out.push({ duration: m[1].replace(/\s+/g, ' ').trim(), context: text.slice(m.index, m.index + m[0].length) });
  }
  return out;
}

/** Durations agree when normalized (whitespace-collapsed) strings match exactly — this rule does not attempt unit conversion/equivalence between "Xh Ym" and "Xh Ym Zs" forms; a report stating both forms for the SAME duration must spell them identically, which is exactly what Defect Case 1 did not do. */
function _durationsAgree(a, b) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/** Every rendered "<N> ... PR(s)" / "<N> True-Merged PRs" figure the hero, badges, tables and prose state — the same hunt Defect Case 1 needed, generalized past one hardcoded location. */
function _renderedPrCounts(html) {
  const text = toPlainText(html);
  const out = [];
  const re = /\b(\d{1,3})\s*(?:\/\s*\d{1,3}\s*)?(?:true-merged\s+)?PRs?\b/gi;
  let m;
  while ((m = re.exec(text))) {
    out.push({ count: Number(m[1]), context: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 5) });
  }
  return out;
}

/** Rule 4 — Explicit Scope Taxonomy Strip. */
function ruleScopeTaxonomy(ctx) {
  const out = [];
  const tax = ctx.metrics && ctx.metrics.scope_taxonomy;
  if (!tax) {
    out.push(_finding(4, 'SCOPE_TAXONOMY_MISSING', 'blocking', '#tc-canonical-metrics has no scope_taxonomy block.'));
    return out;
  }
  for (const key of ['github_feature_issues_closed', 'chartered_execution_cars_completed', 'milestone_issues_deferred_external_gated']) {
    if (typeof tax[key] !== 'number' || tax[key] < 0) {
      out.push(_finding(4, 'SCOPE_TAXONOMY_FIELD_INVALID', 'blocking', `scope_taxonomy.${key} must be a non-negative number.`));
    }
  }
  return out;
}

/** Rule 5 — Exact Release-State Vocabulary. */
function ruleReleaseStateVocabulary(ctx) {
  const out = [];
  const states = ctx.metrics && ctx.metrics.release_state;
  if (!Array.isArray(states)) {
    out.push(_finding(5, 'RELEASE_STATE_MISSING', 'blocking', '#tc-canonical-metrics has no release_state array.'));
    return out;
  }
  for (const s of states) {
    if (!RELEASE_STATE_VOCAB.includes(s)) {
      out.push(_finding(5, 'RELEASE_STATE_UNKNOWN_TERM', 'blocking',
        `release_state names "${s}", which is not one of the seven canonical terms.`));
    }
  }
  return out;
}

/** Rule 6 — Four-Tier Cost & Token Separation. */
function ruleCostSeparation(ctx) {
  const out = [];
  const econ = ctx.metrics && ctx.metrics.economics;
  if (!econ) {
    out.push(_finding(6, 'ECONOMICS_MISSING', 'blocking', '#tc-canonical-metrics has no economics block.'));
    return out;
  }
  for (const field of ECONOMICS_FIELDS) {
    const v = econ[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      out.push(_finding(6, 'ECONOMICS_FIELD_INVALID', 'blocking', `economics.${field} must be a non-negative finite number.`));
    }
  }
  return out;
}

/** Rule 7 — Freshness & Verification Provenance Watermarks. */
function ruleProvenanceWatermarks(ctx) {
  const out = [];
  const prov = ctx.metrics && ctx.metrics.provenance;
  if (!prov) {
    out.push(_finding(7, 'PROVENANCE_MISSING', 'blocking', '#tc-canonical-metrics has no provenance block.'));
    return out;
  }
  for (const field of PROVENANCE_FIELDS) {
    if (typeof prov[field] !== 'string' || !prov[field].trim()) {
      out.push(_finding(7, 'PROVENANCE_FIELD_INVALID', 'blocking', `provenance.${field} must be a non-empty string.`));
    }
  }
  return out;
}

/**
 * Rule 8 — Cross-Report N-Gram Contamination Detector. Every narrative
 * section INCLUDING `#next-sprint` and `#retro` — the exact exclusion
 * Defect Case 2 slipped through.
 * @param {object} ctx
 * @returns {Finding[]}
 */
function ruleContaminationDetector(ctx) {
  const out = [];
  const minWords = ctx.contaminationMinWords || 8;
  const allowlist = new Set([...DEFAULT_CONTAMINATION_ALLOWLIST, ...(ctx.allowlist || [])]);
  // A gram is a SHORT run (minWords); an allowlisted phrase is typically
  // longer than that — so the check is "is this gram a piece of an
  // allowlisted phrase", not the reverse (a short gram can never literally
  // contain a longer phrase).
  const isAllowed = (gram) => { for (const a of allowlist) if (a.includes(gram)) return true; return false; };

  /** @type {Array<{sectionId: string, grams: Set<string>, leg: (string|null)}>} */
  const ownSections = CANONICAL_SECTIONS
    .map((id) => ({ id, text: toPlainText(extractSection(ctx.html, id)) }))
    .filter((s) => s.text.length > 0);

  // Against the external corpus (both modes).
  if (Array.isArray(ctx.corpus)) {
    const corpusGrams = new Set();
    for (const doc of ctx.corpus) for (const g of nGrams(toPlainText(doc), minWords)) corpusGrams.add(g);
    for (const s of ownSections) {
      for (const g of nGrams(s.text, minWords)) {
        if (corpusGrams.has(g) && !isAllowed(g)) {
          out.push(_finding(8, 'CONTAMINATION_EXTERNAL', 'warning',
            `#${s.id} shares an ${minWords}-word run with the supplied corpus: "${g}".`));
        }
      }
    }
  }

  // Leg-vs-leg, retrospective mode only.
  if (ctx.mode === 'retrospective' && Array.isArray(ctx.legTexts) && ctx.legTexts.length > 1) {
    for (let i = 0; i < ctx.legTexts.length; i++) {
      for (let j = i + 1; j < ctx.legTexts.length; j++) {
        const gi = nGrams(toPlainText(ctx.legTexts[i].text), minWords);
        const gj = nGrams(toPlainText(ctx.legTexts[j].text), minWords);
        for (const g of gi) {
          if (gj.has(g) && !isAllowed(g)) {
            out.push(_finding(8, 'CONTAMINATION_CROSS_LEG', 'warning',
              `legs "${ctx.legTexts[i].leg}" and "${ctx.legTexts[j].leg}" share an ${minWords}-word run: "${g}".`));
          }
        }
      }
    }
  }
  return out;
}

/** Rule 9 — Contradiction Gate. Promotes any Rule 1-8 blocking finding to a hard fail UNLESS the errata ledger already reconciles it. */
function ruleContradictionGate(ctx, priorFindings) {
  const out = [];
  const ledger = (ctx.errata && Array.isArray(ctx.errata.errata_ledger)) ? ctx.errata.errata_ledger : [];
  const blocking = priorFindings.filter((f) => f.severity === 'blocking');
  for (const f of blocking) {
    const reconciled = ledger.some((e) => _errataReconciles(e, f));
    if (!reconciled) {
      out.push(_finding(9, 'CONTRADICTION_UNRECONCILED', 'blocking',
        `Rule ${f.rule} (${f.code}) is blocking and no errata_ledger entry reconciles it: ${f.message}`));
    }
  }
  return out;
}

/**
 * Whether an errata entry reconciles a finding: an EXACT match on
 * `entry.field === finding.field`, never a guess parsed out of free-text
 * `message` — a field name that happens to appear inside unrelated prose
 * (e.g. an entry correcting `effort` matching a finding about
 * `launch_effort_default`) would reconcile the wrong thing. A finding with
 * no `field` (most of rules 4-8, which have no single-field correction
 * shape) can never be reconciled this way — it is either genuinely fixed
 * in the content, or it blocks.
 */
function _errataReconciles(entry, finding) {
  return typeof entry.field === 'string' && typeof finding.field === 'string' && entry.field === finding.field;
}

/** Rule 10 — Errata Ledger Integrity: immutability + banner/ledger revision agreement. */
function ruleErrataLedgerIntegrity(ctx) {
  const out = [];
  const errata = ctx.errata;
  // (PRR-A R1 catch on PR #3006) The immutability check against
  // `priorLedgerSnapshot` runs REGARDLESS of whether the CURRENT ledger is
  // present or empty — an empty/absent current ledger when a prior
  // snapshot had entries is exactly "every entry was removed", the most
  // extreme mutation this check exists to catch. An early return here on
  // "nothing to reconcile" used to skip this entirely, so deleting the
  // WHOLE errata_ledger (or the whole #tc-report-errata block) read as ok.
  const currentLedger = (errata && Array.isArray(errata.errata_ledger)) ? errata.errata_ledger : [];
  if (Array.isArray(ctx.priorLedgerSnapshot)) {
    for (const prior of ctx.priorLedgerSnapshot) {
      const stillThere = currentLedger.find((e) => e.entry_id === prior.entry_id);
      if (!stillThere) {
        out.push(_finding(10, 'ERRATA_ENTRY_REMOVED', 'blocking', `errata_ledger entry "${prior.entry_id}" from a prior snapshot is missing.`));
      } else if (JSON.stringify(stillThere) !== JSON.stringify(prior)) {
        out.push(_finding(10, 'ERRATA_ENTRY_MUTATED', 'blocking', `errata_ledger entry "${prior.entry_id}" was edited after publication; entries are immutable.`));
      }
    }
  }

  if (!errata || currentLedger.length === 0) return out; // nothing CURRENT to reconcile, beyond the immutability check just run, is not itself a violation
  const expectedBanner = `Revision ${errata.revision} — Errata & Canonical Reconciliation Applied`;
  if (!ctx.html.includes(expectedBanner)) {
    out.push(_finding(10, 'ERRATA_BANNER_MISSING', 'blocking',
      `errata_ledger is non-empty (revision "${errata.revision}") but the report carries no visible "${expectedBanner}" banner.`));
  }
  return out;
}

/**
 * @param {number} rule
 * @param {string} code
 * @param {'blocking'|'warning'} severity
 * @param {string} message
 * @param {string|null} [field] - The `#tc-canonical-metrics`/narrative FIELD this finding is about, when it names one directly — Rule 9 matches an errata_ledger entry's own `field` against THIS, exactly, never a guess parsed out of `message`'s free text.
 * @returns {Finding}
 */
function _finding(rule, code, severity, message, field = null) {
  return { rule, code, severity, message, field };
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Validate one report's rendered HTML against all ten rules.
 *
 * @param {string} html - The full `index.html` content.
 * @param {object} [options]
 * @param {'single'|'retrospective'} [options.mode='single']
 * @param {string} [options.version] - This report's own version/range (matched against `sourcesLock` keys for Rule 1).
 * @param {object} [options.roadmapData] - Parsed `roadmap2-data.json`-shaped object (`issue_fields`), for Rule 2. Omitted: Rule 2 is skipped, not failed.
 * @param {object} [options.sourcesLock] - Parsed `canonical-sources-lock.json`-shaped object, keyed by version, for Rule 1's cross-check. Omitted: Rule 1 checks internal presence/shape only.
 * @param {string[]} [options.corpus] - Other reports' raw HTML/text, for Rule 8's external comparison.
 * @param {Array<{leg: string, text: string}>} [options.legTexts] - This retrospective's own per-leg narrative text, for Rule 8's cross-leg comparison (`mode: 'retrospective'` only).
 * @param {string[]} [options.allowlist] - Additional n-grams Rule 8 must not flag, beyond `DEFAULT_CONTAMINATION_ALLOWLIST`.
 * @param {number} [options.contaminationMinWords=8] - Rule 8's run length.
 * @param {object[]} [options.priorLedgerSnapshot] - A PRIOR read of this report's own `errata_ledger[]`, for Rule 10's immutability check.
 * @returns {{ok: boolean, findings: Finding[], mode: string, version: (string|undefined)}}
 */
function validateReport(html, options = {}) {
  const mode = options.mode === 'retrospective' ? 'retrospective' : 'single';
  const metricsRead = extractJsonAnchor(html, 'tc-canonical-metrics');
  const errataRead = extractJsonAnchor(html, 'tc-report-errata');

  const findings = [];
  if (!metricsRead.ok) {
    findings.push(_finding(0, 'CANONICAL_METRICS_MISSING', 'blocking', metricsRead.reason));
    return { ok: false, findings, mode, version: options.version };
  }
  // #tc-report-errata is OPTIONAL (absence just means nothing to reconcile yet) —
  // a present-but-invalid block is reported, never silently treated as absent.
  if (!errataRead.ok && !errataRead.reason.startsWith('no <script')) {
    findings.push(_finding(0, 'REPORT_ERRATA_INVALID', 'blocking', errataRead.reason));
  }

  const ctx = {
    html, mode,
    version: options.version || (metricsRead.value && metricsRead.value.version),
    metrics: metricsRead.value,
    errata: errataRead.ok ? errataRead.value : null,
    roadmapData: options.roadmapData || null,
    sourcesLock: options.sourcesLock || null,
    corpus: options.corpus || null,
    legTexts: options.legTexts || null,
    allowlist: options.allowlist || [],
    contaminationMinWords: options.contaminationMinWords,
    priorLedgerSnapshot: options.priorLedgerSnapshot || null
  };

  const rules1to8 = [
    ruleSourceLock, ruleCitationVerifier, ruleAggregateReconciler, ruleScopeTaxonomy,
    ruleReleaseStateVocabulary, ruleCostSeparation, ruleProvenanceWatermarks, ruleContaminationDetector
  ];
  for (const rule of rules1to8) findings.push(...rule(ctx));

  findings.push(...ruleContradictionGate(ctx, findings));
  findings.push(...ruleErrataLedgerIntegrity(ctx));

  const ok = findings.every((f) => f.severity !== 'blocking');
  return { ok, findings, mode, version: ctx.version, validatorVersion: VALIDATOR_VERSION };
}

// ── Historical errata remediation (#2979) ──────────────────────────────
//
// Narrow, purpose-built fixes for exactly the two known defects named in
// this module's own doc comment — not a general "fix any report" tool.
// Each returns the corrected HTML plus the `#tc-report-errata` block to
// splice in; it never writes a file itself, so the exact bytes that would
// change are always visible before anything lands (docs/SPRINT_REPORT_CONTRACT.md's
// own `--remediate` CLI section explains why).

const HISTORICAL_FIXES = {
  'v5.57.0-v5.61.0': {
    // Direction verified directly against git (Architect Ruling A512-PR3006-R1-HOLD
    // B2, confirmed independently rather than taken on either party's word): true
    // PR merges in the report's own declared range (`1ce2dd19..d5b3491c`) number
    // EXACTLY 27 (`git log --merges --oneline 1ce2dd19..d5b3491c | grep -c "Merge
    // pull request #"`), split 22 feature + 5 release — matching the HERO banner's
    // "27 PRs (22 Feat + 5 Rel)" exactly. The BODY prose/badges ("26 True-Merged
    // PRs", "21 feature cars + 5 release cuts") are the stale, pre-reconciliation
    // figures; an earlier version of this fix had the direction backwards.
    field: 'total_prs_merged',
    original_value: '26',
    corrected_value: '27',
    reason: 'The Architecture section badge, fleet table and Total Run Time card stated the stale pre-reconciliation '
      + 'figures ("26 True-Merged PRs", "21 feature cars + 5 release cuts", "12h 16m (736m)"); the hero banner already '
      + 'stated the canonical, git-verified totals ("27 PRs (22 Feat + 5 Rel)", "12h 15m 26s") this report\'s own '
      + 'declared commit range (1ce2dd19..d5b3491c) confirms.',
    replacements: [
      [/26 True-Merged PRs/g, '27 True-Merged PRs'],
      [/all 26 merged PRs/g, 'all 27 merged PRs'],
      [/all 26 `?--no-ff`? true merges/g, 'all 27 `--no-ff` true merges'],
      [/21 feature cars \+ 5 release cuts/g, '22 feature cars + 5 release cuts'],
      [/12h\s*16m\s*\(736m\)\s*Start-to-Finish/g, '12h 15m 26s Start-to-Finish'],
      [/12h\s*16m\s*\(736m\)/g, '12h 15m 26s']
    ]
  },
  'v5.68.0-v5.71.0': {
    field: 'issue_citations',
    original_value: 'Session Hierarchy (#108), Engine Failover (#109), Adversarial Agent (#1032), Secure Secrets (#1257) & Dynamic Agents (#1578)',
    corrected_value: 'Adversarial Agent (#108), Engine Failover (#109), Secure Clipboard Sync (#1032), Sub-Agent Parallelization (#1257) & Session Hierarchy (#1578)',
    reason: 'The generator sorted five issue IDs ascending and zipped them against an unsorted label list, scrambling '
      + 'four of five Issue-ID-to-title mappings (#109 happened to land correctly by coincidence). Corrected against '
      + 'each issue\'s real GitHub title (verified via `gh issue view`).',
    replacements: [
      [/Session Hierarchy \(`?#108`?\),\s*Engine Failover \(`?#109`?\),\s*Adversarial Agent \(`?#1032`?\),\s*Secure Secrets \(`?#1257`?\)\s*&amp;\s*Dynamic Agents \(`?#1578`?\)/g,
        'Adversarial Agent (`#108`), Engine Failover (`#109`), Secure Clipboard Sync (`#1032`), Sub-Agent Parallelization (`#1257`) &amp; Session Hierarchy (`#1578`)']
    ]
  }
};

/**
 * Apply the one known historical fix `range` names.
 * @param {'v5.57.0-v5.61.0'|'v5.68.0-v5.71.0'} range
 * @param {string} html
 * @returns {{ok: true, html: string, errataEntry: object}|{ok: false, reason: string}}
 */
function remediateHistoricalErrata(range, html) {
  const fix = HISTORICAL_FIXES[range];
  if (!fix) {
    return { ok: false, reason: `no historical fix is defined for "${range}" — this helper recognizes exactly ${Object.keys(HISTORICAL_FIXES).join(', ')}.` };
  }
  let corrected = html;
  let appliedAny = false;
  for (const [pattern, replacement] of fix.replacements) {
    if (pattern.test(corrected)) appliedAny = true;
    corrected = corrected.replace(pattern, replacement);
  }
  if (!appliedAny) {
    return { ok: false, reason: `none of "${range}"'s known defect patterns were found in the supplied HTML — nothing to remediate, or it is already corrected.` };
  }
  const banner = 'Revision 1.1 — Errata & Canonical Reconciliation Applied';
  if (!corrected.includes(banner)) {
    corrected = corrected.replace('<body>', `<body>\n  <div class="errata-banner" role="note">${banner}</div>`);
  }
  const errataEntry = {
    entry_id: `errata-${range}-001`,
    corrected_at: new Date().toISOString(),
    field: fix.field,
    original_value: fix.original_value,
    corrected_value: fix.corrected_value,
    reason: fix.reason
  };
  return { ok: true, html: corrected, errataEntry };
}

module.exports = {
  VALIDATOR_VERSION,
  CANONICAL_SECTIONS,
  RELEASE_STATE_VOCAB,
  ECONOMICS_FIELDS,
  PROVENANCE_FIELDS,
  KNOWN_ISSUE_TITLES,
  validateReport,
  remediateHistoricalErrata,
  extractJsonAnchor,
  extractSection,
  extractCitations,
  toPlainText,
  nGrams,
  _internals: {
    ruleSourceLock, ruleCitationVerifier, ruleAggregateReconciler, ruleScopeTaxonomy,
    ruleReleaseStateVocabulary, ruleCostSeparation, ruleProvenanceWatermarks,
    ruleContaminationDetector, ruleContradictionGate, ruleErrataLedgerIntegrity,
    HISTORICAL_FIXES, _renderedTotalRunTimes, _durationsAgree
  }
};

// ── CLI ──────────────────────────────────────────────────────────────────

/** CLI flags that take a value, each consuming the token after it from the positional scan. */
const _VALUED_FLAGS = ['--mode', '--remediate', '--sources-lock', '--corpus', '--roadmap-data', '--prior-ledger'];

function _cli(argv) {
  const args = argv.slice(2);
  const flagIdx = (name) => args.indexOf(name);
  const positional = args.filter((a, i) => !a.startsWith('--') && !_VALUED_FLAGS.includes(args[i - 1]));

  const remediateIdx = flagIdx('--remediate');
  if (remediateIdx !== -1) {
    const range = args[remediateIdx + 1];
    const htmlPath = positional[0];
    if (!range || !htmlPath) {
      process.stderr.write('Usage: --remediate <range> <path/to/index.html>\n');
      process.exitCode = 2;
      return;
    }
    const result = remediateHistoricalErrata(range, fs.readFileSync(htmlPath, 'utf8'));
    if (!result.ok) {
      process.stderr.write(`REMEDIATION FAILED: ${result.reason}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ errataEntry: result.errataEntry }, null, 2) + '\n');
    process.stdout.write('--- corrected HTML follows on stdout; redirect to apply ---\n');
    process.stdout.write(result.html);
    return;
  }

  const modeIdx = flagIdx('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'single';
  const htmlPath = positional[0];
  if (!htmlPath) {
    process.stderr.write('Usage: --mode <single|retrospective> [--sources-lock <path>] [--roadmap-data <path>] [--prior-ledger <path>] <path/to/index.html>\n');
    process.exitCode = 2;
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const options = { mode };
  const sourcesLockIdx = flagIdx('--sources-lock');
  if (sourcesLockIdx !== -1) options.sourcesLock = JSON.parse(fs.readFileSync(args[sourcesLockIdx + 1], 'utf8'));
  const roadmapDataIdx = flagIdx('--roadmap-data');
  if (roadmapDataIdx !== -1) options.roadmapData = JSON.parse(fs.readFileSync(args[roadmapDataIdx + 1], 'utf8'));
  const priorLedgerIdx = flagIdx('--prior-ledger');
  if (priorLedgerIdx !== -1) options.priorLedgerSnapshot = JSON.parse(fs.readFileSync(args[priorLedgerIdx + 1], 'utf8'));
  const result = validateReport(html, options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  _cli(process.argv);
}
