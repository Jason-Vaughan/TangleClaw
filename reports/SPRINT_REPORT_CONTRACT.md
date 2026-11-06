# Canonical Interactive Sprint Report Contract & Metrics Integrity Standard (`P4` / `Rule #283.5` · `v2.0.0`)

**Status:** MANDATORY (`v2.0.0` Canonical Standard — Effective `v5.65.0+` / Pre-`v5.67.0` Governance Upgrade)  
**Canonical Schema:** `/tmp/tc-sprint-reports/metrics-schema.json` & `/tmp/tc-sprint-reports/metrics_schema.py`  
**Validator:** `/tmp/tc-sprint-reports/validate-sprint-report.py`  
**Unit Test Suite:** `/tmp/tc-sprint-reports/test_validate_sprint_report.py`  
**Reference Generators (`v5.65.0+` Gold Standard):**
- `/tmp/tc-sprint-reports/generators/gen_v5650.py` (`v5.65.0/index.html`)
- `/tmp/tc-sprint-reports/generators/gen_v5660.py` (`v5.66.0/index.html`)
- `/tmp/tc-sprint-reports/generators/gen_v5650_v5660_retro.py` (`v5.65.0-v5.66.0-retrospective/index.html`)  
**Pre-Publish Gate:** Wired into `/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/roadmap-board/publish-public-roadmap.sh`

---

## 1. Zero-Drift Rule & Reference Format (`v5.65.0+`)

1. **Reference Format:** Every TangleClaw Interactive Sprint Report (`sprint-reports/vX.Y.Z/index.html` and mirrored `.tangleclaw/plans/sprint-vX.Y.Z.html`) and every Multi-Version Sprint Train Retrospective (`sprint-reports/v<Start>-v<End>-retrospective/index.html`) **MUST** use `v5.65.0/index.html`, `v5.66.0/index.html`, and `v5.65.0-v5.66.0-retrospective/index.html` as the permanent visual, structural, and evidentiary reference standard.
2. **Programmatic Generation & Single Source of Truth:** Reports **MUST** be generated via a Python generator script in `sprint-reports/generators/` that imports canonical metrics and card renderers from `metrics_schema.py` (`render_ade_kpi_and_banner()` and `render_canonical_governance_and_metrics_cards()`). Never hand-author or abbreviate an `index.html` report directly in a single LLM tool call, and never allow `enrich-sprint-reports.py` to scrape unverified numbers via regex when a canonical record exists in `metrics_schema.py`.
3. **Mandatory Validator & Unit Test Gate:** Every report and the Hub index (`sprint-reports/index.html`) **MUST** pass `python3 validate-sprint-report.py --all` (`0` errors) and `python3 -m unittest test_validate_sprint_report.py` before `O-Gate PASS` or GitHub Pages publication.

---

## 2. Canonical 8-Section Structural Requirements (Enforced by `validate-sprint-report.py`)

1. **Size & Completeness Floor:**
   - `>= 1,350` lines and `>= 85,000` bytes (`~1,485+` lines / `~105+ KB` target).
   - Shared CSS & interactive `<script>` block extracted verbatim from the canonical template.
2. **Sticky `.topnav` Bar & Link-Preview (`Open Graph`) Metadata:**
   - Brand badge + `← All Sprint Reports` (`href="../"`) link.
   - All 8 section jump links in exact order: `#overview`, `#architecture`, `#velocity`, `#deliverables`, `#telemetry`, `#postmortem`, `#waves`, `#next-sprint`.
   - **Mandatory Social / iMessage / Email Link-Preview Metadata (`<head>`):** Every report and the Hub index **MUST** include `og:title`, `og:description`, `og:url`, `og:image` (`https://jason-vaughan.github.io/TangleClaw/reports/assets/og-card.png`, `1200×630` TangleClaw logo + wordmark banner), `twitter:card` (`summary_large_image`), `rel="icon"`, and `rel="apple-touch-icon"`.
3. **Hero (`#overview`), Autonomous Delivery Efficiency (`ADE`), & Plain-English Summary (`#plain-english`):**
   - Eyebrow badge, release title + theme, executive summary paragraph, `>= 6` `.hero-actions` buttons, and `>= 8` `.kpi-card` cards including **Total Run Time (`Start → Finish`)** and **Autonomous Delivery Efficiency (`ADE`)**.
   - **Plain-English Summary Card (`id="plain-english"`):** Prominent 2-column card immediately below `.hero-top` explaining in everyday, non-jargon English (a) what shipped and why it matters to users, and (b) how the sprint ran (speed, test pass rate, and zero rework), while keeping all 8 technical sections and primary-source metrics 100% intact.
4. **Section 1 (`#architecture` — Multi-Agent Fleet Topology):**
   - Full `980×330` 9-node SVG diagram (`TC-Lane-PM`, `TC-Lane-Arc`, `TC-Lane-Obsr`, `TC-Lane-A..D`, `PRR-A/B`, `TC-Lane-INT`) + `3` `.subcard` architecture cards.
5. **Section 2 (`#velocity` — Sprint Velocity, Canonical 8-Timestamp Ledger & Efficiency Banner):**
   - **Single Canonical `#ade-efficiency-card` Banner (`Rule #283.5` Hard Gate):** Exactly **one** `id="ade-efficiency-card"` element is permitted per report (wrapped in `<!-- TANGLECLAW_ADE_BANNER_START --> ... <!-- TANGLECLAW_ADE_BANNER_END -->` and rendered by `metrics_schema.render_ade_kpi_and_banner()`). Duplicate or conflicting `#ade-efficiency-card` banners are a hard validation failure.
   - **Canonical 8-Timestamp, 4-State Completion, 3-Tier Cost & Credibility Card (`id="canonical-timing-and-cost-audit"`, `v5.65.0+`):** Rendered by `metrics_schema.render_canonical_governance_and_metrics_cards()`, accompanied by the machine-readable `<script type="application/json" id="tc-canonical-metrics">` block validated against `metrics-schema.json`.
   - Full `960×340` dual-axis SVG chart (PR Merge Timeline + Cumulative Passing Tests) + PR-by-PR merge velocity table.
6. **Section 3 (`#deliverables` — Shipped Feature Deliverables & LOC/Test Churn):**
   - Full `960×310` Car-by-Car SVG chart (`+LOC / -LOC` & Net New Tests per PR) + `3` `.subcard` deep-dive deliverable cards.
   - Must distinguish between **Net Repository Diff** (`git diff --shortstat <prev_tag>..<release_tag>`) and **Sum of Feature PR Diffs** when intermediate churn or release metadata updates exist.
7. **Section 4 (`#telemetry` — Longitudinal Multi-Sprint Comparison & CI/Pool Telemetry):**
   - **Mandatory Longitudinal Sprint Comparison Table:** Must include a `Longitudinal ... Comparison` table inside `#telemetry` with `>= 5` sprint version column headers (`<th>...vX.Y.Z...</th>`) comparing recent sprints side-by-side across Wall Time, Throughput (`Issues/Hr`), Builder Active Build Time (`Dispatch → PR`), PR Open-to-Merge Latency, Commits/PR & Token Efficiency, `.prawduct/change-log*` Collisions / Conflicts, Test Suite & Pool Offload, Records/Release Turnaround, and Pre-Merge Gate Catches / Post-Merge Regressions, plus a `Directional Assessment` column.
   - `>= 8` `.bar-row` items with labels rendered inside `.bar-label-row` above `.bar-track` and empty `.bar-fill` elements so text is never clipped.
8. **Section 5 (`#postmortem` — Post-Mortem, 4-Gate Audit & 16-Point `Rule #283` Table):**
   - Side-by-side `grid-2` post-mortem cards: `>= 4` green `.pm-item` cards (`✅ What Worked Exceptionally Well`) and `>= 4` amber `.pm-item.warn` cards (`⚠️ What Didn’t Work & Proven Fixes for Next Sprint`), each naming a concrete `Fix / Guardrail / Rule`.
   - **4-Gate Governance Audit Table:** `Gate 1 — Architect (A-Gate)`, `Gate 2 — Dual PR Reviewer (R-Gate)`, `Gate 3 — Release Integrator (CI-Gate / I-Gate)`, `Gate 4 — Independent Observer (O-Gate)`.
   - **Complete 16-Row `Rule #283` Empirical Evaluation Table:** Rows `1` through `16` (`<tr><td>1</td>` .. `<tr><td>16</td>`).
9. **Section 6 (`#waves` — Interactive 4-Wave & PR Explorer):**
   - `.filter-bar` with `>= 10` `.filter-btn` buttons + `#waveSearch` live search input + `>= 4` `.wave-card` containers.
10. **Section 7 (`#next-sprint` — Next Sprint Plan & Actionable Guardrails):**
    - `grid-3` containing `>= 6` `.subcard` cards with version-specific engineering and process guardrails for the next sprint.

---

## 3. Canonical Metrics Schema, Orthogonal Efficiency & `ADE_v1` Governance (`v2.0.0`)

### 3.1 Mandatory 8-Timestamp Release Cadence & 5 Derived Durations
Every `v5.65.0+` report **MUST** record all 8 primary-source timestamps in both UTC (`ISO-8601`) and local `PST/PDT`:
1. `t1_first_activity`: Sprint authorization (`OP-GO`), charter freeze, or pipelined dispatch timestamp.
2. `t2_first_branch_commit`: Earliest Git author/commit timestamp on the first feature branch of the release (`git log --format=%aI`).
3. `t3_first_pr_opened`: Timestamp when the first feature PR is opened (and first feature PR merged).
4. `t4_final_feature_pr_merged`: Timestamp when the final feature PR merges to `main`.
5. `t5_release_pr_merged`: Timestamp when the release bump/notes PR merges to `main`.
6. `t6_release_tag_published`: Timestamp when the annotated git tag / GitHub Release `vX.Y.Z` is published.
7. `t7_live_deploy_completed`: Timestamp when the pre-deploy SQLite backup SHA-256 is verified and `:3102` passes live health verification.
8. `t8_observer_certification_completed`: Timestamp when `TC-Lane-Obsr` posts the `O-Gate PASS` certification comment.

From `t1..t8`, every report **MUST** distinguish and report:
- **Authorization-to-Deploy Wall-Clock (`t1 → t7`):** Total elapsed clock time from authorization/dispatch to live `:3102` cutover.
- **Full Engineering Window (`T_eng = t2 → t7`):** Elapsed time from the first branch commit of the release to live `:3102` cutover. **This is the mandatory denominator (`T_eng`) for per-release Throughput, Allocated Subscription Cost, and `ADE_v1`.**
- **Inter-Release Merge Cadence (`t5_prev → t5_curr`):** Elapsed time between consecutive release PR merges in a pipelined train.
- **Inter-Release Deploy Cadence / Pipelined Tail (`t7_prev → t7_curr`):** Incremental post-previous-deploy tail required to merge, tag, and deploy a pipelined release.
- **Cross-Version Pipeline Overlap (`t2_curr → t7_prev`):** Concurrent engineering duration during which release $N$ was actively built and reviewed in parallel with release $N-1$.

> **Hard Prohibition on Pipelined Tail Substitution:** A pipelined release's inter-release merge or deploy tail (e.g., `21m 08s` / `0.35h` or `24m 43s` / `0.41h` in `v5.66.0`) **MUST NEVER** be substituted for `full_engineering_window_hrs` (`T_eng`). When `pipeline_overlap_hrs > 0`, `full_engineering_window_hrs` must include the full overlapping engineering duration (`>= 1.0h`).

### 3.2 Orthogonal Efficiency Metrics vs. Disclosed Legacy `ADE_v1`
Because allocated subscription cost is proportional to engineering time ($C_{\text{alloc}} = r \cdot T_{\text{eng}}$, where $r = \$2.46/\text{hr}$), the legacy composite formula
$$\text{ADE}_{\text{v1}} = \frac{W_{\text{closed}}}{T_{\text{eng}} \times C_{\text{alloc}}} = \frac{W_{\text{closed}}}{r \cdot T_{\text{eng}}^2}$$
has dimensions of $\text{issues} \cdot \text{hr}^{-2} \cdot \$^{-1}$ and scales inversely with the **square** of elapsed time ($1/T_{\text{eng}}^2$). Consequently:
- **Primary Orthogonal Efficiency Metrics (Mandatory Headline Standard):**
  1. **Throughput (Velocity):** $\text{Throughput} = W_{\text{closed}} / T_{\text{eng}}$ (closed issues per engineering hour; scale-invariant across single releases and multi-version trains), plus $W_{\text{addressed}} / T_{\text{eng}}$ when partial multi-slice deliverables ship.
  2. **Unit Allocated Cost:** $C_{\text{alloc}} / W_{\text{closed}}$ (`$/closed issue`), $C_{\text{alloc}} / W_{\text{addressed}}$ (`$/addressed issue`), and $C_{\text{alloc}} / \text{kLOC}$ (`$/kLOC`).
  3. **Quality & Stability:** True-merge rate (`100%`), post-merge defect/revert count (`0`), and live `:3102` verification status.
- **Disclosed Legacy Composite Index (`ADE_v1`):** Retained for longitudinal continuity with `v5.34.0–v5.64.0`, always computed strictly on the full engineering window $T_{\text{eng}}$ and accompanied by the explicit $1/T_{\text{eng}}^2$ dimensional disclosure.

### 3.3 4-State Work-Completion Accounting & Milestone Reconciliation
Every report **MUST** classify chartered issue work across 4 explicit states and reconcile 100% of the GitHub Milestone's `closed_issues` count:
- **State A — Implemented:** Code and unit tests committed on a feature branch.
- **State B — Integrated:** Merged to `main` via `gh pr merge --merge` with dual `R-Gate` + `A-Gate` + `I-Gate` sign-off.
- **State C — Verified & Closed in Milestone (`W_closed`):** Issue closed in the release's GitHub Milestone during the sprint and verified live on `:3102`.
- **State D — Externally Accepted (`0` unless receipted):** Must be reported as `0` for internal autonomous sprints unless an explicit external user/customer acceptance receipt is linked.
- **Multi-Slice & Pre-Closed Milestone Reconciliation:**
  - Issues where an intermediate slice (`Part of #N`, e.g., Slice 2 adapters) merges during the sprint and the issue is re-milestoned to the next milestone for final hot-entrypoint mounting must be reported under `partial_slice_re_milestoned_issues` (`W_partial`), never silently counted as closed in the current milestone.
  - Any issue closed in the GitHub Milestone *prior* to the sprint window (`pre_closed_milestone_issues`, e.g., `#239` in Milestone `#50` or `#2880` in Milestone `#51`) must be explicitly itemized so that `state_c_verified_closed_issues + pre_closed_milestone_issues == milestone_closed_total`.
  - PR lists (`prs_merged`) must contain **only** pull request numbers (`len(prs_merged) == len(set(prs_merged))`) and must be strictly disjoint from issue IDs (`set(prs_merged).isdisjoint(set(state_c_issue_ids))`).

### 3.4 3-Tier Operating Cost Accounting
Every report **MUST** separate operating cost into three distinct, non-co-mingled tiers:
1. **Tier 1 — Measured Marginal Cash Expenditure (`measured`):** `$0.00` incremental per-token API billing (covered by fixed monthly CLI subscriptions) + measured local M3 Ultra wall-power (`~$0.025/hr × T_eng`).
2. **Tier 2 — Allocated Subscription & Compute Amortization (`allocated_estimate`):** Pro-rata share of the `$500/mo` multi-vendor CLI subscription pool (`85%` TangleClaw share = `$425/mo`) + `$15/mo` M3 Ultra base power = `$440/mo` divided by `178.8` active fleet-hours/month = **`$2.46 / active fleet-hr`** (`C_alloc = $2.46 × T_eng`), paired with the 24/7 calendar-hour reference (`$440/mo ÷ 720h = $0.611/hr`).
3. **Tier 3 — Hypothetical Public API Shadow Estimate (`hypothetical_estimate`):** Order-of-magnitude estimate of what equivalent token volume would cost at public pay-per-token API list prices. Must be labeled `hypothetical_estimate` because local SQLite `token_usage` is unmetered (`0` rows) for subscription CLI sessions.

### 3.5 Semantic Provenance, Release Identity & Deliverable Correspondence (`v2.1.0` — `A505` Guardrail)
To prevent template-cloning contamination (where a generator script is copied from a prior release and retains prior-release narrative prose while updating only KPI headers), `validate-sprint-report.py` (`validate_semantic_provenance_and_deliverables`) enforces:
1. **Header & Hero Identity Correspondence:** `<title>`, `<meta property="og:title">`, `.eyebrow`, and `<h1 class="hero-title">` **MUST** declare the report's own authoritative `version`, `milestone_number` (`Milestone #N`), and `charter` (`Charter A50X`), and **MUST NOT** reference foreign milestone numbers or foreign charter codes.
2. **Prohibition on Unlabeled Prior-Version Narrative Contamination:** Non-longitudinal sections (`#overview`, `#plain-english`, `#architecture`, `#velocity`, `#deliverables`, `#postmortem`, `#waves`) **MUST NOT** contain inherited prior-release charter/ruling/milestone strings (e.g., `Charter A504`, `Ruling A504-EXT-R1`, `Milestone #54`, or foreign PRs `#2908–#2911` inside `Charter A505` reports).
3. **Deliverable & Wave PR/Issue Completeness:** Every merged pull request in `diff.prs_merged` and every verified closed issue in `completion.state_c_issue_ids` **MUST** appear in both `#deliverables` / `#velocity` and `#waves`.
4. **Multi-Train Cross-Report Consistency (`validate_train_consistency`):** Both the `v5.65.0–v5.66.0` train and the `v5.68.0–v5.71.0` train are validated to ensure the retrospective report's `prs_merged`, `feature_prs`, `release_prs`, `state_c_issue_ids`, `state_c_verified_closed_issues`, `chartered_active_issues`, and `milestone_closed_total` equal the exact union/sum of the individual release leg reports.

---

## 4. Historical Integrity & External Credibility Rules

1. **Historical Integrity (No Silent Mutation):** When a post-hoc audit corrects a metric in a previously published report, the correction **MUST** be documented in a dated reconciliation addendum in `tangleclaw-reconciliation-and-correction-report.md` (stored in both `sprint-reports/` and `strategy-and-growth/`) showing the original published figure, the corrected primary-source figure, the root cause, and the structural guardrail enacted.
2. **External Credibility & Governance Disclosures:** Every `v5.65.0+` report **MUST** include explicit disclosures covering:
   - **Autonomous Code Execution vs. Operator Governance:** Distinguishing `0` human code/git/test/deploy edits during execution from Operator standing authorization (`OP-GO`) and Gate 0 charter/deferral approvals.
   - **Single GitHub Account Attribution:** Disclosing that multi-agent lanes (`TC-Lane-A..D`, `PRR-A/B`, `Arc`, `INT`, `PM`, `Obsr`) run in isolated `tmux` worktrees/models while authenticating to GitHub via the Operator's `Jason-Vaughan` `gh` CLI account, with role identity verified via structured review stamps and SQLite logs.
   - **In-Run Operational Anomalies:** Disclosing any in-run anomalies (such as `pane-no-prompt` Medusa nudge holds during interactive prompts) and their architectural mitigations.
   - **Scope of “Self-Improvement”:** Clarifying that self-improvement refers strictly to operational, runtime, and governance rule/code evolution, not autonomous LLM weight training.
