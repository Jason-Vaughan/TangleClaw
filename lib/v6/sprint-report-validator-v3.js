'use strict';

/**
 * Sprint Report Contract v3.1.0 validator (#2979; v3.1 adds Rule 11's
 * fast-follow sub-version remarks, #3089).
 *
 * Eleven deterministic rules over one report's rendered HTML and its two embedded
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

const VALIDATOR_VERSION = '3.1.0';

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
    // A <script>/<style> block's content is machine-readable metadata or CSS,
    // never rendered prose — left in, a JSON anchor's own English `reason`
    // text (which legitimately narrates a stale numeric figure, e.g. inside
    // an errataEntry) would otherwise leak into what Rule 3/8's rendered-text
    // scans treat as "what the report visibly says".
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
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

// ── The eleven rules ───────────────────────────────────────────────────────
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
  const expectedRunTime = durations && typeof durations.total_run_time_display === 'string' && durations.total_run_time_display.length > 0
    ? durations.total_run_time_display : null;
  // (PM R-Gate Round 2 feedback, PR #3006) A v3 report must DECLARE this
  // field, not merely be reconciled against it when present — a report that
  // omits it entirely used to pass Rule 3 silently, which is exactly the gap
  // a report missing its own canonical duration could exploit.
  if (ctx.metrics && !expectedRunTime) {
    out.push(_finding(3, 'DURATION_FIELD_MISSING', 'blocking',
      '#tc-canonical-metrics must declare a non-empty durations.total_run_time_display — Rule 3 cannot reconcile a report\'s rendered "Total Run Time" figures against an absent canonical value.',
      'total_run_time'));
  }
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

/** The sections a Fast-Follow Sub-Versions remark table may sit in (#3089). */
const FAST_FOLLOW_TABLE_SECTIONS = ['overview', 'deliverables'];

/**
 * Whether a value is a list of issue or PR numbers.
 * @param {*} v
 * @returns {boolean}
 */
function _isNumberList(v) {
  return Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);
}

/**
 * Rule 11 — Fast-Follow Sub-Version Remarks (#3089, contract v3.1). A
 * parent or consolidated train report may record its small fast-follow
 * point releases as `fast_follow_subversions[]` instead of a full report
 * each. When it does, each entry is complete; each has its own row in a
 * remark table inside `#overview` or `#deliverables`; and an entry marked
 * `major_learning: true` links a Kaizen ledger item (`kaizen_id`) and a
 * postmortem entry (`postmortem_ref`, an element id inside `#postmortem`),
 * so a fast-follow that taught something is never reduced to one line.
 * Absent: nothing to check.
 * @param {object} ctx
 * @returns {Finding[]}
 */
function ruleFastFollowSubversions(ctx) {
  const out = [];
  const entries = ctx.metrics && ctx.metrics.fast_follow_subversions;
  if (entries === undefined) return out;
  const field = 'fast_follow_subversions';
  if (!Array.isArray(entries)) {
    out.push(_finding(11, 'FAST_FOLLOW_INVALID', 'blocking', `${field} must be an array.`, field));
    return out;
  }
  const tableRows = FAST_FOLLOW_TABLE_SECTIONS
    .flatMap((id) => [...extractSection(ctx.html, id).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)])
    .map((m) => ` ${toPlainText(m[1])} `);
  const postmortem = extractSection(ctx.html, 'postmortem');
  const seen = new Set();
  entries.forEach((entry, i) => {
    const at = `${field}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out.push(_finding(11, 'FAST_FOLLOW_INVALID', 'blocking', `${at} must be an object.`, field));
      return;
    }
    const problems = [];
    if (typeof entry.version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(entry.version)) problems.push('version must be "vX.Y.Z"');
    if (!(Number.isInteger(entry.milestone) && entry.milestone > 0)) problems.push('milestone must be a milestone number');
    if (!_isNumberList(entry.prs)) problems.push('prs must be a list of PR numbers');
    if (!_isNumberList(entry.issues)) problems.push('issues must be a list of issue numbers');
    if (typeof entry.release_tag !== 'string' || !entry.release_tag.trim()) problems.push('release_tag must be a non-empty string');
    if (typeof entry.summary_remark !== 'string' || !entry.summary_remark.trim()) problems.push('summary_remark must be a non-empty string');
    if (typeof entry.major_learning !== 'boolean') problems.push('major_learning must be true or false');
    if (problems.length) {
      out.push(_finding(11, 'FAST_FOLLOW_INVALID', 'blocking', `${at}: ${problems.join('; ')}.`, field));
      return;
    }
    if (seen.has(entry.version)) {
      out.push(_finding(11, 'FAST_FOLLOW_DUPLICATE', 'blocking', `${at}: ${entry.version} is listed more than once.`, field));
      return;
    }
    seen.add(entry.version);
    const escaped = entry.version.replace(/\./g, '\\.');
    if (!tableRows.some((row) => new RegExp(`[\\s(]${escaped}[\\s)]`).test(row))) {
      out.push(_finding(11, 'FAST_FOLLOW_ROW_MISSING', 'blocking',
        `${entry.version} has no row in a Fast-Follow Sub-Versions table in #overview or #deliverables.`, field));
    }
    if (entry.major_learning) {
      if (typeof entry.kaizen_id !== 'string' || !entry.kaizen_id.trim()) {
        out.push(_finding(11, 'FAST_FOLLOW_KAIZEN_LINK_MISSING', 'blocking',
          `${entry.version} is a major learning but links no Kaizen ledger item (kaizen_id).`, field));
      }
      // An HTML id, so it can be matched as written; anything else names nothing.
      const ref = typeof entry.postmortem_ref === 'string' ? entry.postmortem_ref.trim() : '';
      const isId = /^[A-Za-z][A-Za-z0-9_:.-]*$/.test(ref);
      if (!isId || !new RegExp(`\\sid="${ref.replace(/\./g, '\\.')}"`).test(postmortem)) {
        out.push(_finding(11, 'FAST_FOLLOW_POSTMORTEM_REF_MISSING', 'blocking',
          `${entry.version} is a major learning but its postmortem_ref does not name an element inside #postmortem.`, field));
      }
    }
  });
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
 * Validate one report's rendered HTML against all eleven rules.
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
  findings.push(...ruleFastFollowSubversions(ctx));

  const ok = findings.every((f) => f.severity !== 'blocking');
  return { ok, findings, mode, version: ctx.version, validatorVersion: VALIDATOR_VERSION };
}

// ── Hub report links (#3093, Ruling A766-2) ────────────────────────────
//
// The Sprint Reports Hub (`sprint-reports/index.html`) links every report
// directory. When the live sprint card moves on to the next version, the
// version it used to link is left with no card of its own, and an unlinked
// report directory blocks the hub's publication. These two functions find
// such a directory and link it before validation runs.

/** A report directory name: `vX.Y.Z`, optionally a suffixed range such as `vA.B.C-vX.Y.Z-retrospective`. */
const REPORT_DIR_RE = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

/** The comment that closes the hub's live sprint card; auto-linked cards go directly after it. */
const LIVE_CARD_END_MARKER = '<!-- LIVE_SPRINT_CARD_END -->';

/**
 * The top-level directory an `href` points at, if it points at one:
 * `./v6.3.0/`, `v6.3.0`, `./v6.3.0/index.html` and the hub's public
 * `/reports/v6.3.0/` form all name `v6.3.0`. A link deeper inside a
 * directory (an asset) names none.
 * @param {string} href
 * @returns {string|null}
 */
function _reportDirOfHref(href) {
  const m = /^(?:\.\/|\/(?:TangleClaw\/)?reports\/|https:\/\/[^/]+\/TangleClaw\/reports\/)?([^/?#]+)(?:\/(?:index\.html)?)?(?:[?#].*)?$/.exec(href.trim());
  return m ? m[1] : null;
}

/**
 * Which report directories the hub links, and which it does not.
 * Directories that are not report directories (`assets`, `scripts`) are
 * ignored, so a caller may pass a raw directory listing.
 * @param {string} hubHtml - The hub's `index.html`.
 * @param {string[]} reportDirs - Directory names next to it.
 * @returns {{ok: boolean, linked: string[], unlinked: string[]}}
 */
function validateHubReportLinks(hubHtml, reportDirs) {
  if (typeof hubHtml !== 'string') throw new TypeError('validateHubReportLinks: hubHtml must be a string');
  if (!Array.isArray(reportDirs)) throw new TypeError('validateHubReportLinks: reportDirs must be an array');
  const hrefs = new Set();
  for (const m of hubHtml.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
    const dir = _reportDirOfHref(m[1]);
    if (dir) hrefs.add(dir);
  }
  const dirs = [...new Set(reportDirs.filter((d) => typeof d === 'string' && REPORT_DIR_RE.test(d)))].sort();
  const linked = dirs.filter((d) => hrefs.has(d));
  const unlinked = dirs.filter((d) => !hrefs.has(d));
  return { ok: unlinked.length === 0, linked, unlinked };
}

/**
 * Newest first: by the directory's leading `X.Y.Z`, then by name.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _newestFirst(a, b) {
  const parts = (d) => /^v(\d+)\.(\d+)\.(\d+)/.exec(d).slice(1).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Link every unlinked report directory in the hub, so a version the live
 * sprint card has moved past keeps a card of its own. Each missing
 * directory gets one minimal card directly after the live card's end
 * marker, newest first; a directory the hub already links is left alone,
 * so running this twice changes nothing the second time. A hub with no
 * live-card end marker is returned unchanged with `ok: false`: guessing
 * where a card belongs could break the page, and the unlinked directories
 * are still reported.
 * @param {string} hubHtml - The hub's `index.html`.
 * @param {string[]} reportDirs - Directory names next to it.
 * @returns {{ok: boolean, html: string, inserted: string[], unlinked: string[], reason?: string}}
 *   `unlinked` is what is still unlinked afterwards.
 */
function ensureHubReportLinks(hubHtml, reportDirs) {
  const before = validateHubReportLinks(hubHtml, reportDirs);
  if (before.ok) return { ok: true, html: hubHtml, inserted: [], unlinked: [] };
  const at = hubHtml.indexOf(LIVE_CARD_END_MARKER);
  if (at === -1) {
    return { ok: false, html: hubHtml, inserted: [], unlinked: before.unlinked, reason: 'NO_LIVE_CARD_END_MARKER' };
  }
  const missing = before.unlinked.slice().sort(_newestFirst);
  // Each name matched REPORT_DIR_RE, so it carries nothing HTML could misread.
  const cards = missing.map((dir) => [
    `      <!-- AUTO_LINKED_REPORT ${dir} -->`,
    '      <article class="report-card">',
    `        <h2 class="report-title"><a href="./${dir}/">TangleClaw <code>${dir}</code> Sprint Report</a></h2>`,
    '      </article>'
  ].join('\n')).join('\n');
  const end = at + LIVE_CARD_END_MARKER.length;
  const html = `${hubHtml.slice(0, end)}\n${cards}${hubHtml.slice(end)}`;
  const after = validateHubReportLinks(html, reportDirs);
  return { ok: after.ok, html, inserted: missing, unlinked: after.unlinked };
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
    // (PM/PRR-A R-Gate Round 2 feedback, PR #3006) Verified against the REAL
    // production file (TangleClaw-Shared/sprint-reports/v5.57.0-v5.61.0-retrospective/index.html):
    // "26 PRs"/"26 True-Merged PRs"/"12h 16m" recur in many distinct surrounding
    // phrasings across the Architecture, Fleet, Release-Explorer and footer
    // sections, not just the two exact phrases Round 1 hardcoded. Each pattern
    // below is ordered before any more-generic pattern that would otherwise
    // leave a dangling "+5 release cuts"/"(736m)" fragment next to the now-
    // corrected number — once a specific phrase is replaced, the generic
    // catch-all after it no longer finds anything there to touch twice.
    replacements: [
      [/26 True-Merged PRs/g, '27 True-Merged PRs'],
      [/26 PRs True-Merged/g, '27 PRs True-Merged'],
      [/all 26 `?--no-ff`? true merges/gi, 'all 27 `--no-ff` true merges'],
      [/all 26 merged PRs/gi, 'all 27 merged PRs'],
      [/all 26 PRs/gi, 'all 27 PRs'],
      [/`26` PRs/g, '`27` PRs'],
      [/\(26\/26 PRs\)/g, '(27/27 PRs)'],
      [/26\s*\/\s*26\s*(Train PRs|True Merges)/g, '27/27 $1'],
      [/\b26 PRs\b/g, '27 PRs'],
      [/21 feature cars \+ 5 release cuts/g, '22 feature cars + 5 release cuts'],
      [/\b21 feature cars\b/g, '22 feature cars'],
      // "12h 16m" with an immediately-adjacent "(736m)" minutes gloss — possibly
      // split across an HTML tag boundary (e.g. "12h 16m</code> (<code>736m</code>)")
      // — drops the now-redundant minutes parenthetical entirely, matching the
      // hero's own style, while preserving any captured closing tag.
      [/12h\s*16m(<\/code>)?\s*\(\s*(?:<code>)?736m(?:<\/code>)?\s*\)/g, '12h 15m 26s$1'],
      [/12h\s*16m\s*Start-to-Finish/g, '12h 15m 26s Start-to-Finish'],
      // Generic catch-all for every remaining bare "12h 16m" (e.g. inside a
      // "TOTAL WALL-CLOCK TIME" eyebrow) — must run last, after every pattern
      // above that needs to also consume adjacent "(736m)"/"Start-to-Finish" text.
      [/\b12h\s*16m\b/g, '12h 15m 26s']
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
  // (PM R-Gate Round 2 feedback, PR #3006) The visible banner alone is not the
  // machine-checked record Rule 9/10 read — a corrected report must also carry
  // the #tc-report-errata JSON anchor itself. Append to an existing ledger
  // (another range's remediation may already have run on this same document)
  // rather than overwrite it, so two historical fixes compose on one report.
  const anchorRe = /<script type="application\/json" id="tc-report-errata">([\s\S]*?)<\/script>/;
  const existingAnchor = corrected.match(anchorRe);
  let ledger = [];
  if (existingAnchor) {
    try {
      const parsed = JSON.parse(existingAnchor[1]);
      if (Array.isArray(parsed.errata_ledger)) ledger = parsed.errata_ledger;
    } catch (e) {
      ledger = []; // a malformed prior anchor starts fresh rather than failing this remediation
    }
  }
  ledger.push(errataEntry);
  const anchorScript = `<script type="application/json" id="tc-report-errata">${JSON.stringify({ schema_version: '1.0.0', revision: '1.1', errata_ledger: ledger })}</script>`;
  corrected = existingAnchor
    ? corrected.replace(anchorRe, anchorScript)
    : corrected.replace('<body>', `<body>\n  ${anchorScript}`);
  return { ok: true, html: corrected, errataEntry };
}

module.exports = {
  VALIDATOR_VERSION,
  CANONICAL_SECTIONS,
  RELEASE_STATE_VOCAB,
  ECONOMICS_FIELDS,
  PROVENANCE_FIELDS,
  KNOWN_ISSUE_TITLES,
  FAST_FOLLOW_TABLE_SECTIONS,
  validateReport,
  remediateHistoricalErrata,
  extractJsonAnchor,
  extractSection,
  extractCitations,
  toPlainText,
  nGrams,
  validateHubReportLinks,
  ensureHubReportLinks,
  _internals: {
    ruleSourceLock, ruleCitationVerifier, ruleAggregateReconciler, ruleScopeTaxonomy,
    ruleReleaseStateVocabulary, ruleCostSeparation, ruleProvenanceWatermarks,
    ruleContaminationDetector, ruleContradictionGate, ruleErrataLedgerIntegrity, ruleFastFollowSubversions,
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
