# Sprint Report Contract v3.0.0

Canonical schema and validation contract for Individual Sprint Reports and Multi-Version
Retrospectives. Supersedes the v2.0.0/v2.1.0 contract `validate-sprint-report.py` enforced
(`TangleClaw-Shared/sprint-reports/`); this document and `lib/v6/sprint-report-validator-v3.js`
are the v3.0.0 successor, built after forensic root-cause analysis of two real production defects
that shipped past v2.1.0 (below).

## Why v3.0.0 exists

Two contradictions reached live publication under v2.1.0:

1. **`v5.57.0-v5.61.0-retrospective`** — the hero banner states `27 PRs` and `12h 15m 26s`; the
   Architecture section (`#architecture`) states `26 True-Merged PRs` and the Total Run Time card
   states `12h 16m (736m)`. The hero's figures are the canonical ones — `27` (`22` feature + `5`
   release) is exactly the true-merge count across this report's own declared commit range
   (`1ce2dd19..d5b3491c`; `git log --merges --oneline 1ce2dd19..d5b3491c | grep -c "Merge pull
   request #"` returns `27`) — and the body/architecture figures are the stale, pre-reconciliation
   ones. Root cause: `requires_v2_canonical_metrics()` exempted this report from the v2.0.0
   canonical-metrics requirement entirely (its version tuple predated the cutoff), and v2.1.0 had
   no intra-document reconciler at all — the hero was reconciled to the correct totals at some
   point; the body, badges and fleet table never were.
2. **`v5.68.0-v5.71.0-retrospective`** — Section 12 (`#next-sprint`) cites `Session Hierarchy
   (#108), Engine Failover (#109), Adversarial Agent (#1032), Secure Secrets (#1257) & Dynamic
   Agents (#1578)`; the real titles are `#108` Adversarial Agent, `#109` Engine Failover (the one
   pair that happened to land right), `#1032` Secure Clipboard Sync, `#1257` Sub-Agent
   Parallelization, `#1578` Session Hierarchy. Root cause: the generator sorted five issue IDs
   ascending and zipped them against an unsorted label list, and v2.1.0 excluded `#next-sprint`
   from its only contamination check (a hardcoded per-section string join) and never verified any
   citation against a roadmap source at all.

Both defects are **intra-document or cross-source disagreements a human proofreader could have
caught by comparing two numbers, or one citation against one source** — not failures of technical
sophistication, failures of nobody ever writing the check. v3.0.0 is ten such checks, run on every
report, every time, including the two shapes that slipped past v2.1.0 (a report excluded by its
own cutoff date, and a section excluded from contamination scanning).

## Scope: two modes, one contract

- **`single`** — one version's own report (`vX.Y.Z/index.html`). Contamination detection (Rule 8)
  compares against a corpus of *other* reports' text, supplied by the caller.
- **`retrospective`** — a multi-version report spanning several legs (`vA.B.C-vD.E.F-retrospective/index.html`).
  Contamination detection compares each leg's own narrative against the others bundled in the same
  document, in addition to any external corpus supplied.

Every rule below applies to both modes unless stated otherwise. A retrospective's own aggregate
figures (Rule 3) reconcile against the SUM of its legs, not each leg individually — legs are
narrative content here, not separately re-validated documents.

## JSON anchors

Two embedded `<script type="application/json">` blocks carry every machine-checked fact. Both are
required (a report that would have none of a rule's inputs cannot be validated for that rule, and
a validator that skipped a rule for a missing anchor would be exactly the silent gap this version
exists to close).

### `#tc-canonical-metrics` (carried forward from v2.0.0, extended)

```json
{
  "schema_version": "3.0.0",
  "version": "v5.72.0",
  "timestamps": { "...": "unchanged from v2.0.0 (t1..t8)" },
  "durations": {
    "...": "unchanged from v2.0.0, plus:",
    "total_run_time_display": "12h 15m 26s"
  },
  "completion": { "...": "unchanged from v2.0.0 (State A..D)" },
  "diff": { "...": "unchanged from v2.0.0" },
  "economics": {
    "measured_tokens": 128400,
    "estimated_tokens": 12000,
    "subscription_allocated_cost_usd": 4.18,
    "api_shadow_cost_usd": 19.62
  },
  "efficiency": { "...": "unchanged from v2.0.0 (ADE, throughput, legacy ADE_v1)" },
  "citations": [
    { "label": "Adversarial Agent", "issue": 108 },
    { "label": "Engine Failover", "issue": 109 }
  ],
  "release_state": ["code_merged_on_main", "release_pr_merged", "git_tag_published",
                     "github_release_published", "gate_4_report_validated",
                     "public_mirror_synced", "live_3102_deployed"],
  "scope_taxonomy": {
    "github_feature_issues_closed": 14,
    "chartered_execution_cars_completed": 14,
    "milestone_issues_deferred_external_gated": 1
  },
  "provenance": {
    "generated_at": "2026-11-10T08:00:00Z",
    "verified_at": "2026-11-10T08:05:00Z",
    "canonical_source_sha256": "…",
    "git_main_head_sha": "37c12c7986af4a25561e7fed575f1ead5c9c59b0",
    "validator_version": "3.0.0"
  }
}
```

`citations[]` is new: every `Label (#NNNN)` pair the rendered prose cites, in the exact order and
spelling it appears, so Rule 2 diffs the SAME list the generator produced against the SAME list
the roster source names — not a re-scrape of prose the validator itself parses two different ways
in two different rules.

`release_state` replaces a single free-text "status" string with an explicit array drawn from the
seven-term vocabulary in Rule 5 — a report states which of the seven have happened, never a prose
synonym for one of them.

### `#tc-report-errata` (new in v3.0.0)

Absent on a report with nothing to reconcile. Present — and required for Rule 9/10 to pass a
report with a genuine mismatch — once any correction is applied in place:

```json
{
  "schema_version": "1.0.0",
  "revision": "1.1",
  "errata_ledger": [
    {
      "entry_id": "errata-2026-11-10-001",
      "corrected_at": "2026-11-10T08:00:00Z",
      "field": "total_prs_merged",
      "original_value": "27",
      "corrected_value": "26",
      "reason": "Hero banner included release PR #2835 after enrichment; body prose and the architecture badge were never updated to match. 26 is the true-merge count.",
      "original_publication": { "timestamp": "2026-11-03T11:32:33-08:00", "digest": "sha256:…" }
    }
  ]
}
```

An `errata_ledger[]` entry is **immutable once written** — reconciling a SECOND defect in the same
report appends a new entry; it never edits or removes an earlier one. `original_publication` is
carried from the FIRST version of the document that ever published (digest of the pre-correction
content), so a Revision 1.1 report can always be diffed back to Revision 1.0's exact bytes.

A report carrying `#tc-report-errata` renders a visible audit banner reading exactly
`"Revision 1.1 — Errata & Canonical Reconciliation Applied"` (the revision number matches
`errata_ledger`'s own `revision` field) — Rule 10 fails a report whose ledger is non-empty but
whose rendered HTML carries no such banner, or whose banner names a revision the ledger disagrees
with.

## The ten rules

| # | Name | Fails when | Severity |
|---|---|---|---|
| 1 | Canonical Versioned Source Lock | `provenance.canonical_source_sha256` is absent, or disagrees with the caller-supplied lock record (when one is supplied) for this report's GitHub Issue/PR/Milestone/Commit/CI snapshot | blocking |
| 2 | Issue Citation Verifier | Any `Label (#NNNN)` cited anywhere in the 12 sections — **`#next-sprint` included** — names a label the roadmap source's real title for `#NNNN` does not match | blocking |
| 3 | Intra-Document Aggregate Reconciler | `economics`/`diff`/PR-count/duration figures disagree between the JSON anchor and ANY rendered location (hero, badges, tables, prose), `feature_prs_merged + release_prs_merged != total_repo_prs_merged`, `durations.total_run_time_display` is absent or empty (a v3 report must DECLARE this field, not merely be reconciled against it when present), or a rendered "Total Run Time: …" figure disagrees with it | blocking |
| 4 | Scope Taxonomy Strip | `scope_taxonomy`'s three counts are missing, or any rendered scope figure cannot be attributed to exactly one of the three | blocking |
| 5 | Release-State Vocabulary | `release_state[]` contains a term outside the seven-term vocabulary, or rendered release-status prose uses a synonym not drawn from it | blocking |
| 6 | Four-Tier Cost Separation | Any of the four `economics` fields is absent, non-numeric, or negative | blocking |
| 7 | Provenance Watermarks | Any of the five `provenance` fields is absent | blocking |
| 8 | Cross-Report Contamination Detector | An n-gram run of 8+ words (configurable) in ANY narrative section — including `#next-sprint` and `#retro` — matches a run in the supplied corpus or, in `retrospective` mode, another leg's narrative, AND is not a citation, a shared boilerplate allowlist entry, or a longitudinal cross-reference the two sections both legitimately describe | warning |
| 9 | Contradiction Gate | Rule 1–8 found any blocking violation and `#tc-report-errata`'s ledger does not already carry a matching entry reconciling it | blocking |
| 10 | Errata Ledger Integrity | `errata_ledger[]` has a mutated/removed prior entry (compared against a caller-supplied prior ledger snapshot, when one is supplied), or the visible audit banner's revision disagrees with the ledger's `revision` | blocking |

Severity: a **blocking** violation fails `validateReport()`'s overall `ok`; a **warning** is
reported but does not. Rule 9 is what turns a would-be-blocking Rule 1–8 finding into a pass: an
entry in the errata ledger that names the exact field and reconciles it is the only thing that
can.

## CLI

```
node lib/v6/sprint-report-validator-v3.js --mode single <path/to/index.html>
node lib/v6/sprint-report-validator-v3.js --mode retrospective <path/to/index.html>
node lib/v6/sprint-report-validator-v3.js --mode single --roadmap-data roadmap2-data.json --prior-ledger prior-ledger.json <path/to/index.html>
node lib/v6/sprint-report-validator-v3.js --remediate v5.57.0-v5.61.0 <path/to/index.html>
node lib/v6/sprint-report-validator-v3.js --remediate v5.68.0-v5.71.0 <path/to/index.html>
```

`--remediate <range>` runs the historical errata helper for exactly the one known defect that
range names (see `lib/v6/sprint-report-validator-v3.js`'s own module doc for the two it
recognizes) and prints the corrected HTML — every distinct stale phrase shape replaced, carrying
both the visible audit banner and an embedded `#tc-report-errata` JSON anchor (appended to any
ledger the document already carries, so two historical fixes compose on one report) — to stdout,
rather than writing in place: a human or a wrap step applies the output, so the exact bytes that
changed are always visible before they land.

`--sources-lock <path>`, `--roadmap-data <path>` and `--corpus <dir>` are optional inputs to Rules
1, 2 and 8 respectively; `--prior-ledger <path>` feeds Rule 10's immutability check. Omitted:

- Rule 1 checks internal consistency only (the field is present and well-formed, not that it
  matches an external record).
- Rule 2 still runs against `KNOWN_ISSUE_TITLES` — a small built-in floor covering exactly the
  five issue numbers Defect Case 2 scrambled, each verified via `gh issue view`, never a
  substitute for a real `roadmap2-data.json` for any other issue number. A caller-supplied
  `--roadmap-data` always takes precedence over it.
- Rule 8 compares within the document only (every leg in retrospective mode; nothing in single
  mode, which then reports contamination as not-applicable rather than a vacuous pass).
- Rule 10 checks the current ledger's own shape and banner only — it cannot detect a REMOVED or
  MUTATED prior entry without something to compare against.
