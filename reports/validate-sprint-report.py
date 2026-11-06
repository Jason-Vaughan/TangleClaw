#!/usr/bin/env python3
"""
Canonical Interactive Sprint Report Validator (TangleClaw P4 / Rule #283.5 · v2.0.0)

Enforces:
1. Full 8-section canonical layout, Open Graph metadata, SVG diagrams, What Worked / What Didn't
   post-mortem cards, 16-row Rule #283 table, interactive wave explorer, and 6-card Next Sprint Plan.
2. Single-Banner Rule: Exactly 1 `id="ade-efficiency-card"` element per report (zero duplicate/conflicting ADE cards).
3. Canonical Metrics Schema & Primary-Source Integrity (`v5.65.0+` / `SPRINT_REPORT_CONTRACT.md v2.0.0`):
   - Embedded `<script type="application/json" id="tc-canonical-metrics">` block and `#canonical-timing-and-cost-audit` card.
   - 8 mandatory chronological timestamps (`t1..t8`) and prohibition on substituting pipelined merge/deploy tails (`< 1.0h`)
     for `full_engineering_window_hrs` (`T_eng`) when `pipeline_overlap_hrs > 0`.
   - 4-State Work-Completion Accounting (`State A..D`) and Milestone Reconciliation:
     `state_c_verified_closed_issues + partial_slice_re_milestoned_issues == chartered_active_issues`,
     `state_c_verified_closed_issues + pre_closed_milestone_issues == milestone_closed_total`,
     and `state_d_externally_accepted_issues == 0` unless an external receipt is present.
   - PR & Diff Integrity: `true_merge_count == len(prs_merged) == len(feature_prs) + len(release_prs)`,
     no duplicate PR IDs, no issue IDs transcribed into `prs_merged`, and net repo LOC vs. feature PR LOC consistency.
   - 3-Tier Cost & Orthogonal Efficiency / Legacy `ADE_v1` Mathematical Consistency, plus exact match between
     rendered `#ade-efficiency-card` HTML text and the canonical JSON payload.
   - Cross-report train consistency between individual leg reports (`v5.65.0`, `v5.66.0`) and the multi-version
     retrospective (`v5.65.0-v5.66.0-retrospective`).

Usage:
  python3 validate-sprint-report.py --all
  python3 validate-sprint-report.py --version v5.66.0
  python3 validate-sprint-report.py /path/to/index.html
"""

import argparse
import glob
import json
import os
import pathlib
import re
import sys

REPORTS_DIR = "/tmp/tc-sprint-reports"
if REPORTS_DIR not in sys.path:
    sys.path.insert(0, REPORTS_DIR)

from metrics_schema import DETAILED_SPRINT_RECORDS, HOURLY_RATE

# Canonical v5.39.0+ 8-section contract
CANONICAL_SECTIONS = [
    "overview",
    "architecture",
    "velocity",
    "deliverables",
    "telemetry",
    "postmortem",
    "waves",
    "next-sprint",
]

# Historical v5.34.0-v5.38.0 had slightly different section IDs before v5.39.0 standardized them
LEGACY_VERSIONS = {"v5.34.0", "v5.35.0", "v5.36.0", "v5.37.0", "v5.38.0"}

REQUIRED_TIMESTAMPS = [
    "t1_first_activity",
    "t2_first_branch_commit",
    "t3_first_pr_opened",
    "t4_final_feature_pr_merged",
    "t5_release_pr_merged",
    "t6_release_tag_published",
    "t7_live_deploy_completed",
    "t8_observer_certification_completed",
]


def parse_version_tuple(ver_str: str):
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", ver_str.strip())
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def requires_v2_canonical_metrics(version: str, content: str) -> bool:
    if version in DETAILED_SPRINT_RECORDS:
        return True
    if 'id="tc-canonical-metrics"' in content:
        return True
    if parse_version_tuple(version) >= (5, 65, 0):
        return True
    return False


def validate_canonical_metrics_payload(version: str, content: str, enforce_registry_match: bool = True) -> list[str]:
    """Validate the v2.0.0 canonical metrics JSON block and its alignment with rendered HTML."""
    errors = []

    if 'id="canonical-timing-and-cost-audit"' not in content:
        errors.append(
            f"[{version}] Missing mandatory v2.0.0 Canonical 8-Timestamp, 4-State Completion & 3-Tier Cost card "
            f"(id=\"canonical-timing-and-cost-audit\")."
        )

    m = re.search(
        r'<script[^>]+type="application/json"[^>]+id="tc-canonical-metrics"[^>]*>(.*?)</script>',
        content,
        re.S,
    )
    if not m:
        errors.append(
            f"[{version}] Missing mandatory <script type=\"application/json\" id=\"tc-canonical-metrics\"> block."
        )
        return errors

    raw_json = m.group(1).strip()
    try:
        rec = json.loads(raw_json)
    except Exception as exc:
        errors.append(f"[{version}] Invalid JSON in #tc-canonical-metrics: {exc}")
        return errors

    for top_key in ["schema_version", "version", "timestamps", "durations", "completion", "diff", "economics", "efficiency"]:
        if top_key not in rec:
            errors.append(f"[{version}] #tc-canonical-metrics JSON is missing required top-level key '{top_key}'.")
    if errors:
        return errors

    if rec.get("schema_version") != "2.0.0":
        errors.append(f"[{version}] Expected schema_version '2.0.0', got '{rec.get('schema_version')}'.")

    # 1. Validate 8 mandatory timestamps and chronological ordering
    ts = rec["timestamps"]
    iso_values = []
    for ts_key in REQUIRED_TIMESTAMPS:
        val = ts.get(ts_key, "")
        if not val or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", str(val)):
            errors.append(f"[{version}] Missing or invalid ISO-8601 UTC timestamp for '{ts_key}': '{val}'.")
        else:
            iso_values.append((ts_key, str(val)))

    for i in range(len(iso_values) - 1):
        k1, v1 = iso_values[i]
        k2, v2 = iso_values[i + 1]
        if v1 > v2:
            errors.append(
                f"[{version}] Timestamp chronology violation: {k1} ({v1}) occurs after {k2} ({v2})."
            )

    # 2. Validate durations & prohibition on pipelined tail substitution
    dur = rec["durations"]
    t_eng = float(dur.get("full_engineering_window_hrs", 0))
    t_cad = float(dur.get("inter_release_deploy_cadence_hrs", 0))
    t_ovl = float(dur.get("pipeline_overlap_hrs", 0))

    if t_eng <= 0:
        errors.append(f"[{version}] full_engineering_window_hrs must be > 0 (got {t_eng}).")
    if t_ovl > 0 and t_eng < 1.0:
        errors.append(
            f"[{version}] full_engineering_window_hrs ({t_eng}h) is < 1.0h despite pipeline_overlap_hrs={t_ovl}h. "
            f"Substituting a pipelined merge/deploy tail for the full engineering window is prohibited."
        )
    if t_ovl > 0 and t_eng <= t_cad:
        errors.append(
            f"[{version}] full_engineering_window_hrs ({t_eng}h) must exceed inter_release_deploy_cadence_hrs ({t_cad}h) "
            f"when pipeline_overlap_hrs ({t_ovl}h) > 0."
        )

    # 3. Validate 4-State Work-Completion Accounting & Milestone Reconciliation
    comp = rec["completion"]
    w_chart = int(comp.get("chartered_active_issues", -1))
    w_a = int(comp.get("state_a_implemented_issues", -1))
    w_b = int(comp.get("state_b_integrated_issues", -1))
    w_c = int(comp.get("state_c_verified_closed_issues", -1))
    c_ids = comp.get("state_c_issue_ids", [])
    w_d = int(comp.get("state_d_externally_accepted_issues", -1))
    w_part = int(comp.get("partial_slice_re_milestoned_issues", -1))
    part_ids = comp.get("partial_slice_issue_ids", [])
    w_pre = int(comp.get("pre_closed_milestone_issues", -1))
    pre_ids = comp.get("pre_closed_issue_ids", [])
    ms_closed = int(comp.get("milestone_closed_total", -1))
    ms_open = int(comp.get("milestone_open_total", -1))
    def_ids = comp.get("deferred_issue_ids", [])

    if w_c != len(c_ids) or len(c_ids) != len(set(c_ids)):
        errors.append(
            f"[{version}] state_c_verified_closed_issues ({w_c}) does not match unique state_c_issue_ids count ({len(set(c_ids))})."
        )
    if w_part != len(part_ids) or len(part_ids) != len(set(part_ids)):
        errors.append(
            f"[{version}] partial_slice_re_milestoned_issues ({w_part}) does not match unique partial_slice_issue_ids count ({len(set(part_ids))})."
        )
    if w_pre != len(pre_ids) or len(pre_ids) != len(set(pre_ids)):
        errors.append(
            f"[{version}] pre_closed_milestone_issues ({w_pre}) does not match unique pre_closed_issue_ids count ({len(set(pre_ids))})."
        )
    if w_c + w_part != w_chart:
        errors.append(
            f"[{version}] Unreconciled chartered issue count: state_c_verified_closed_issues ({w_c}) + "
            f"partial_slice_re_milestoned_issues ({w_part}) != chartered_active_issues ({w_chart})."
        )
    if w_a != w_chart or w_b != w_chart:
        errors.append(
            f"[{version}] State A ({w_a}) and State B ({w_b}) must equal chartered_active_issues ({w_chart})."
        )
    if w_c + w_pre != ms_closed:
        errors.append(
            f"[{version}] Unreconciled GitHub Milestone closed total: state_c_verified_closed_issues ({w_c}) + "
            f"pre_closed_milestone_issues ({w_pre}) != milestone_closed_total ({ms_closed})."
        )
    if ms_open != 0:
        errors.append(f"[{version}] milestone_open_total must be 0 at release closeout (got {ms_open}).")
    if w_d > 0 and not comp.get("external_acceptance_receipt"):
        errors.append(
            f"[{version}] state_d_externally_accepted_issues is {w_d} without an external_acceptance_receipt. "
            f"Internal autonomous sprints must report State D = 0."
        )
    if not set(c_ids).isdisjoint(set(part_ids)):
        errors.append(
            f"[{version}] Issue IDs cannot be both closed in current milestone and re-milestoned as partial Slice 2: "
            f"{sorted(set(c_ids) & set(part_ids))}."
        )

    # 4. Validate PR & Diff Integrity (catches PR count mismatches, issue-IDs-in-PR-list, and partial LOC sums)
    diff = rec["diff"]
    prs_merged = diff.get("prs_merged", [])
    feat_prs = diff.get("feature_prs", [])
    rel_prs = diff.get("release_prs", [])
    true_merges = int(diff.get("true_merge_count", -1))
    net_ins = int(diff.get("net_repo_insertions", 0))
    feat_ins = int(diff.get("feature_pr_insertions", 0))

    if len(prs_merged) != len(set(prs_merged)):
        errors.append(f"[{version}] Duplicate PR numbers in diff.prs_merged: {prs_merged}.")
    if true_merges != len(prs_merged):
        errors.append(
            f"[{version}] PR count mismatch: true_merge_count ({true_merges}) != len(prs_merged) ({len(prs_merged)})."
        )
    if len(feat_prs) + len(rel_prs) != len(prs_merged) or set(feat_prs + rel_prs) != set(prs_merged):
        errors.append(
            f"[{version}] feature_prs ({feat_prs}) + release_prs ({rel_prs}) do not partition prs_merged ({prs_merged})."
        )

    all_issue_ids = set(c_ids) | set(part_ids) | set(pre_ids) | set(def_ids)
    overlap_pr_issue = set(prs_merged) & all_issue_ids
    if overlap_pr_issue:
        errors.append(
            f"[{version}] Issue ID(s) {sorted(overlap_pr_issue)} erroneously listed inside diff.prs_merged ({prs_merged})."
        )

    if net_ins <= 0 or feat_ins <= 0 or feat_ins < net_ins * 0.85 or feat_ins > net_ins * 1.15:
        errors.append(
            f"[{version}] LOC accounting mismatch between net_repo_insertions ({net_ins}) and "
            f"feature_pr_insertions ({feat_ins}). Partial or omitted PR diff sums are prohibited."
        )

    # 5. Validate 3-Tier Cost & Orthogonal Efficiency / Legacy ADE_v1 Math
    econ = rec["economics"]
    eff = rec["efficiency"]
    tier1_api = float(econ.get("tier1_measured_marginal_api_usd", -1))
    c_alloc = float(econ.get("tier2_allocated_subscription_usd", 0))
    tp_closed = float(eff.get("throughput_closed_per_eng_hr", 0))
    unit_closed = float(eff.get("unit_allocated_cost_per_closed_issue_usd", 0))
    ade_closed = float(eff.get("legacy_ade_v1_closed", 0))

    if tier1_api != 0.0:
        errors.append(f"[{version}] tier1_measured_marginal_api_usd must be 0.00 for CLI subscription runs (got {tier1_api}).")

    expected_c_alloc = round(t_eng * HOURLY_RATE, 2)
    if abs(c_alloc - expected_c_alloc) > 0.03:
        errors.append(
            f"[{version}] tier2_allocated_subscription_usd ({c_alloc}) != round(T_eng * {HOURLY_RATE}, 2) ({expected_c_alloc})."
        )

    expected_tp = round(w_c / t_eng, 2) if t_eng > 0 else 0
    if abs(tp_closed - expected_tp) > 0.03:
        errors.append(
            f"[{version}] throughput_closed_per_eng_hr ({tp_closed}) != round(W_closed / T_eng, 2) ({expected_tp})."
        )

    expected_unit = round(c_alloc / max(1, w_c), 2)
    if abs(unit_closed - expected_unit) > 0.03:
        errors.append(
            f"[{version}] unit_allocated_cost_per_closed_issue_usd ({unit_closed}) != round(C_alloc / W_closed, 2) ({expected_unit})."
        )

    expected_ade = round(w_c / (t_eng * c_alloc), 2) if (t_eng * c_alloc) > 0 else 0
    if abs(ade_closed - expected_ade) > 0.03:
        errors.append(
            f"[{version}] legacy_ade_v1_closed ({ade_closed}) != round(W_closed / (T_eng * C_alloc), 2) ({expected_ade})."
        )

    # 6. Verify rendered #ade-efficiency-card HTML matches JSON payload
    ade_match = re.search(
        r'<!-- TANGLECLAW_ADE_BANNER_START -->(.*?)<!-- TANGLECLAW_ADE_BANNER_END -->',
        content,
        re.S,
    )
    ade_block = ade_match.group(1) if ade_match else ""
    if f"Throughput = {tp_closed:.2f}" not in ade_block or f"Legacy ADE_v1 = {ade_closed:.2f}" not in ade_block:
        errors.append(
            f"[{version}] Rendered #ade-efficiency-card banner text does not match canonical JSON "
            f"(expected Throughput = {tp_closed:.2f} and Legacy ADE_v1 = {ade_closed:.2f})."
        )

    # 7. Check exact match against DETAILED_SPRINT_RECORDS registry when applicable
    if enforce_registry_match and version in DETAILED_SPRINT_RECORDS:
        canonical_rec = DETAILED_SPRINT_RECORDS[version]
        if rec != canonical_rec:
            errors.append(
                f"[{version}] Embedded #tc-canonical-metrics JSON diverges from authoritative DETAILED_SPRINT_RECORDS['{version}']."
            )

    return errors


def validate_report(path: str, version: str = None, enforce_registry_match: bool = True) -> list[str]:
    errors = []
    if not os.path.isfile(path):
        return [f"File does not exist: {path}"]

    if version is None:
        parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
        if parent.startswith("v") or parent == "sgm-strike-sprint":
            version = parent
        else:
            m = re.search(r"(v\d+\.\d+\.\d+(?:-v\d+\.\d+\.\d+-retrospective)?)", os.path.basename(path))
            version = m.group(1) if m else "unknown"

    content = pathlib.Path(path).read_text(encoding="utf-8")
    return validate_report_content(content, version, enforce_registry_match=enforce_registry_match)


def validate_report_content(content: str, version: str, enforce_registry_match: bool = True) -> list[str]:
    errors = []
    is_legacy = version in LEGACY_VERSIONS
    is_live_progress = "<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT -->" in content
    lines = content.splitlines()
    line_count = len(lines)
    byte_count = len(content.encode("utf-8"))

    # 1. Minimum line and byte thresholds
    min_lines = 1000 if is_live_progress else (1200 if is_legacy else 1350)
    min_bytes = 50000 if is_live_progress else (80000 if is_legacy else 85000)
    if line_count < min_lines:
        errors.append(
            f"[{version}] Line count {line_count} is below canonical minimum ({min_lines} lines). "
            f"Abbreviated/drifted reports are prohibited."
        )
    if byte_count < min_bytes:
        errors.append(
            f"[{version}] Byte size {byte_count} B is below canonical minimum ({min_bytes} B)."
        )

    # 2. Section IDs & ordering
    section_ids = re.findall(r'<section[^>]+id="([^"]+)"', content)
    if not is_legacy:
        if section_ids != CANONICAL_SECTIONS:
            errors.append(
                f"[{version}] Section IDs {section_ids} do not match canonical 8-section order {CANONICAL_SECTIONS}."
            )
    else:
        for req in ["overview", "architecture", "telemetry", "postmortem", "waves", "next-sprint"]:
            if req not in section_ids:
                errors.append(f"[{version}] Missing required section #{req} (found {section_ids}).")

    # 3. Topnav links
    if not is_legacy:
        for sec_id in CANONICAL_SECTIONS:
            if f'href="#{sec_id}"' not in content:
                errors.append(f"[{version}] Sticky .topnav is missing link href=\"#{sec_id}\".")
        if 'href="../"' not in content and "../index.html" not in content:
            errors.append(f"[{version}] Sticky .topnav is missing '../' All Sprint Reports Hub link.")

    # 3b. Open Graph / Social Link Preview & TangleClaw Logo Metadata
    for og_tag in ['property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"', 'rel="apple-touch-icon"']:
        if og_tag not in content:
            errors.append(
                f"[{version}] Missing mandatory link-preview / Open Graph tag ({og_tag}) in <head>."
            )

    # 4. Hero KPI grid, Plain-English Summary (v5.47.0+) & Single ADE Banner Check
    kpi_cards = len(re.findall(r'class="kpi-card"', content))
    min_kpis = 6 if is_legacy else 8
    if kpi_cards < min_kpis:
        errors.append(f"[{version}] Hero .kpi-grid has {kpi_cards} .kpi-card elements; canonical minimum is {min_kpis}.")

    if parse_version_tuple(version) >= (5, 47, 0):
        if 'id="plain-english"' not in content or not re.search(r"Plain-English Summary", content, re.I):
            errors.append(
                f"[{version}] Report (v5.47.0+) is missing the mandatory Plain-English Summary card (id=\"plain-english\")."
            )

    if parse_version_tuple(version) >= (5, 54, 0) or "retrospective" in version.lower():
        if not re.search(r"Total Run Time\s*\(Start\s*(?:→|&rarr;|->)\s*Finish\)", content, re.I):
            errors.append(
                f"[{version}] Report (v5.54.0+ / retrospective) is missing the mandatory 'Total Run Time (Start → Finish)' KPI card in the Hero .kpi-grid."
            )

    ade_card_count = len(re.findall(r'id="ade-efficiency-card"', content))
    if 'Autonomous Delivery Efficiency (ADE)' not in content or ade_card_count == 0:
        errors.append(
            f"[{version}] Report is missing the mandatory 'Autonomous Delivery Efficiency (ADE)' KPI card or #ade-efficiency-card formula banner."
        )
    elif ade_card_count > 1:
        errors.append(
            f"[{version}] Found {ade_card_count} duplicate id=\"ade-efficiency-card\" banners; exactly 1 canonical ADE banner is permitted."
        )

    # 4b. Canonical v2.0.0 Metrics Schema & Mathematical Consistency (v5.65.0+)
    if requires_v2_canonical_metrics(version, content) and not is_live_progress:
        errors.extend(
            validate_canonical_metrics_payload(version, content, enforce_registry_match=enforce_registry_match)
        )

    # 5. SVG Architecture, Velocity, and Deliverables diagrams
    svg_count = len(re.findall(r"<svg\b", content))
    min_svgs = 1 if is_legacy else 3
    if svg_count < min_svgs:
        errors.append(
            f"[{version}] Found {svg_count} <svg> diagram(s); canonical format requires >= {min_svgs} "
            f"(Architecture 9-node SVG, Velocity & Test Growth SVG, and Car-by-Car Deliverables SVG)."
        )

    # 6. Telemetry bar rows, non-clipped .bar-fill check & Longitudinal Multi-Sprint Comparison Table (v5.49.0+)
    if not is_legacy:
        bar_rows = len(re.findall(r'class="bar-row"', content))
        if bar_rows < 8:
            errors.append(
                f"[{version}] Section 4 (#telemetry) has {bar_rows} .bar-row elements; canonical minimum is 8."
            )
    if parse_version_tuple(version) >= (5, 49, 0) and not is_live_progress:
        telemetry_match = re.search(r'<section[^>]+id="telemetry"[^>]*>(.*?)</section>', content, re.S)
        telemetry_block = telemetry_match.group(1) if telemetry_match else ""
        if not re.search(r"Longitudinal.*Comparison", telemetry_block, re.I):
            errors.append(
                f"[{version}] Section 4 (#telemetry) is missing the mandatory Longitudinal Sprint Comparison Table "
                f"(heading matching 'Longitudinal ... Comparison')."
            )
        else:
            th_versions = set(re.findall(r"<th[^>]*>.*?v\d+\.\d+\.\d+.*?</th>", telemetry_block, re.I | re.S))
            if len(th_versions) < 5:
                errors.append(
                    f"[{version}] Longitudinal Sprint Comparison Table in #telemetry has {len(th_versions)} sprint version "
                    f"column headers (<th>...vX.Y.Z...</th>); canonical minimum is 5 historical/current sprints."
                )
            for req_metric in [
                r"Wall\s+Time",
                r"Build\s+Time",
                r"Open-to-Merge|Ancestor\s+Sync",
                r"Commits\s*/\s*PR|Token",
                r"Test\s+Suite|Flakes|Pool",
                r"Regressions|Pre-Merge",
            ]:
                if not re.search(req_metric, telemetry_block, re.I):
                    errors.append(
                        f"[{version}] Longitudinal Sprint Comparison Table in #telemetry is missing required metric row matching '{req_metric}'."
                    )
    non_empty_fills = [
        f.strip()
        for f in re.findall(r'<div class="bar-fill"[^>]*>(.*?)</div>', content, re.S)
        if f.strip()
    ]
    if non_empty_fills:
        errors.append(
            f"[{version}] Found {len(non_empty_fills)} .bar-fill element(s) containing text (e.g. '{non_empty_fills[0][:40]}'). "
            f".bar-track is 12px tall with overflow:hidden, so text inside .bar-fill is vertically clipped. "
            f"Render labels inside .bar-label-row above .bar-track and keep .bar-fill empty."
        )
    if 'class="bar-label"' in content or 'class="bar-val"' in content:
        errors.append(
            f"[{version}] Found legacy unstyled .bar-label / .bar-val inside .bar-row; use .bar-label-row with two <span> elements."
        )

    # 7. Section 5 (#postmortem): What Worked (green .pm-item) & What Didn't (amber .pm-item.warn)
    pm_ok = len(re.findall(r'class="pm-item"', content))
    pm_warn = len(re.findall(r'class="pm-item warn"', content))
    if pm_ok < 4:
        errors.append(
            f"[{version}] Section 5 (#postmortem) 'What Worked Exceptionally Well' has {pm_ok} .pm-item cards; "
            f"canonical minimum is 4."
        )
    if pm_warn < 4:
        errors.append(
            f"[{version}] Section 5 (#postmortem) 'What Didn't Work & Proven Fixes' has {pm_warn} .pm-item.warn cards; "
            f"canonical minimum is 4."
        )
    if not is_legacy:
        if "What Worked" not in content:
            errors.append(f"[{version}] Section 5 (#postmortem) is missing the 'What Worked' heading.")
        if "What Didn" not in content:
            errors.append(f"[{version}] Section 5 (#postmortem) is missing the 'What Didn't Work' heading.")
        warn_blocks = re.findall(r'<div class="pm-item warn">(.*?)</div>', content, re.S)
        for idx, wb in enumerate(warn_blocks, 1):
            if "<h4>" not in wb or "<p>" not in wb:
                errors.append(f"[{version}] Section 5 (#postmortem) .pm-item.warn card #{idx} is missing <h4> or <p>.")
            if not re.search(r"Fix|Guardrail|Pillar|Rule", wb, re.I):
                errors.append(
                    f"[{version}] Section 5 (#postmortem) .pm-item.warn card #{idx} must specify a concrete Fix/Guardrail."
                )

    # 8. Section 5 (#postmortem): 16-row Rule #283 table & 4-Gate table
    if not is_legacy:
        if "Rule #283" not in content and "16-Point" not in content:
            errors.append(f"[{version}] Section 5 (#postmortem) is missing the 16-Point Rule #283 table.")
        for row_idx in range(1, 17):
            if f"<tr><td>{row_idx}</td>" not in content:
                errors.append(
                    f"[{version}] Section 5 (#postmortem) 16-Point Rule #283 table is missing row #{row_idx} (<tr><td>{row_idx}</td>)."
                )
        for gate in ["Gate 1", "Gate 2", "Gate 3", "Gate 4"]:
            if gate not in content:
                errors.append(f"[{version}] Section 5 (#postmortem) 4-Gate Audit Table is missing '{gate}'.")

    # 9. Section 6 (#waves): Interactive Wave & PR Explorer
    wave_cards = len(re.findall(r'class="wave-card"', content))
    if wave_cards < 4:
        errors.append(
            f"[{version}] Section 6 (#waves) has {wave_cards} .wave-card elements; canonical minimum is 4."
        )
    if 'id="waveSearch"' not in content:
        errors.append(f"[{version}] Section 6 (#waves) is missing interactive search input #waveSearch.")
    filter_btns = len(re.findall(r'class="filter-btn(?:\s+active)?"', content))
    if not is_legacy and filter_btns < 10:
        errors.append(
            f"[{version}] Section 6 (#waves) has {filter_btns} .filter-btn filter buttons; canonical minimum is 10."
        )

    # 10. Section 7 (#next-sprint): 6-Card Next Sprint Plan & Actionable Guardrails
    if not is_legacy:
        next_match = re.search(r'<section[^>]+id="next-sprint"[^>]*>(.*?)</section>', content, re.S)
        if not next_match:
            errors.append(f"[{version}] Could not isolate <section id=\"next-sprint\"> block.")
        else:
            next_block = next_match.group(1)
            next_subcards = len(re.findall(r'class="subcard"', next_block))
            if next_subcards < 6:
                errors.append(
                    f"[{version}] Section 7 (#next-sprint) has {next_subcards} .subcard recommendation cards; "
                    f"canonical minimum is 6."
                )
            if parse_version_tuple(version) >= (5, 54, 0) or "retrospective" in version.lower():
                if "Hardcoded Issue Ceiling" in content:
                    errors.append(
                        f"[{version}] Section 5 (#postmortem) contains generic sync-live-sprint.py boilerplate ('Hardcoded Issue Ceiling'); must contain version-specific post-mortem cards."
                    )
                if "Verify Local HEAD Matches Charter Base SHA Before Any Edit" in next_block:
                    errors.append(
                        f"[{version}] Section 7 (#next-sprint) contains generic sync-live-sprint.py boilerplate ('Verify Local HEAD Matches Charter Base SHA Before Any Edit'); must contain version-specific feed-forward / next-sprint cards."
                    )

    return errors


def extract_embedded_json(path: str) -> dict | None:
    if not os.path.isfile(path):
        return None
    txt = pathlib.Path(path).read_text(encoding="utf-8")
    m = re.search(
        r'<script[^>]+type="application/json"[^>]+id="tc-canonical-metrics"[^>]*>(.*?)</script>',
        txt,
        re.S,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1).strip())
    except Exception:
        return None


def validate_train_consistency(reports_dir: str) -> list[str]:
    """Verify cross-report mathematical consistency between v5.65.0, v5.66.0, and v5.65.0-v5.66.0-retrospective."""
    errors = []
    r65 = extract_embedded_json(os.path.join(reports_dir, "v5.65.0", "index.html"))
    r66 = extract_embedded_json(os.path.join(reports_dir, "v5.66.0", "index.html"))
    r_retro = extract_embedded_json(os.path.join(reports_dir, "v5.65.0-v5.66.0-retrospective", "index.html"))
    if not (r65 and r66 and r_retro):
        return ["[train consistency] Missing embedded #tc-canonical-metrics JSON in v5.65.0, v5.66.0, or retrospective."]

    if set(r65["diff"]["prs_merged"] + r66["diff"]["prs_merged"]) != set(r_retro["diff"]["prs_merged"]):
        errors.append("[train consistency] Retrospective prs_merged does not equal union of v5.65.0 and v5.66.0 PRs.")
    if (
        r65["completion"]["state_c_verified_closed_issues"] + r66["completion"]["state_c_verified_closed_issues"]
        != r_retro["completion"]["state_c_verified_closed_issues"]
    ):
        errors.append("[train consistency] Retrospective state_c_verified_closed_issues != sum of v5.65.0 and v5.66.0.")
    if (
        r65["completion"]["chartered_active_issues"] + r66["completion"]["chartered_active_issues"]
        != r_retro["completion"]["chartered_active_issues"]
    ):
        errors.append("[train consistency] Retrospective chartered_active_issues != sum of v5.65.0 and v5.66.0.")
    if (
        r65["completion"]["milestone_closed_total"] + r66["completion"]["milestone_closed_total"]
        != r_retro["completion"]["milestone_closed_total"]
    ):
        errors.append("[train consistency] Retrospective milestone_closed_total != sum of v5.65.0 and v5.66.0.")
    return errors


def validate_hub_index(reports_dir: str) -> list[str]:
    errors = []
    hub_path = os.path.join(reports_dir, "index.html")
    if not os.path.isfile(hub_path):
        return [f"Missing hub index: {hub_path}"]

    hub_content = pathlib.Path(hub_path).read_text(encoding="utf-8")
    vdirs = sorted(
        [os.path.basename(p) for p in glob.glob(os.path.join(reports_dir, "v*")) if os.path.isdir(p)],
        key=parse_version_tuple,
    )
    for ver in vdirs:
        if f'href="./{ver}/"' not in hub_content:
            errors.append(f"[hub index.html] Missing report card link href=\"./{ver}/\" for {ver}.")

    latest_badges = len(re.findall(r"● Latest Release", hub_content))
    if latest_badges != 1:
        errors.append(
            f"[hub index.html] Expected exactly 1 '● Latest Release' badge on the newest release card, found {latest_badges}."
        )
    for og_tag in ['property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"', 'rel="apple-touch-icon"']:
        if og_tag not in hub_content:
            errors.append(
                f"[hub index.html] Missing mandatory link-preview / Open Graph tag ({og_tag}) in <head>."
            )
    return errors


def main():
    parser = argparse.ArgumentParser(description="Validate TangleClaw Interactive Sprint Reports.")
    parser.add_argument("paths", nargs="*", help="Direct path(s) to report HTML files.")
    parser.add_argument("--all", action="store_true", help="Validate all reports in sprint-reports/ and hub index.")
    parser.add_argument("--version", help="Validate a specific version in sprint-reports/ (e.g. v5.66.0).")
    args = parser.parse_args()

    targets = []
    check_hub = False

    if args.all:
        check_hub = True
        for vdir in sorted(glob.glob(os.path.join(REPORTS_DIR, "v*")), key=lambda p: parse_version_tuple(os.path.basename(p))):
            if os.path.isdir(vdir):
                targets.append((os.path.join(vdir, "index.html"), os.path.basename(vdir)))
    elif args.version:
        ver = args.version if args.version.startswith("v") else f"v{args.version}"
        targets.append((os.path.join(REPORTS_DIR, ver, "index.html"), ver))
    elif args.paths:
        for p in args.paths:
            targets.append((p, None))
    else:
        parser.print_help()
        sys.exit(2)

    all_errors = []
    for path, ver in targets:
        errs = validate_report(path, ver)
        if errs:
            all_errors.extend(errs)
        else:
            content = pathlib.Path(path).read_text(encoding="utf-8")
            label = ver or os.path.basename(os.path.dirname(path))
            print(f"PASS [{label}] {path} ({len(content.splitlines())} lines, {len(content.encode('utf-8'))} B)")

    if check_hub:
        train_errs = validate_train_consistency(REPORTS_DIR)
        if train_errs:
            all_errors.extend(train_errs)
        hub_errs = validate_hub_index(REPORTS_DIR)
        if hub_errs:
            all_errors.extend(hub_errs)
        else:
            print(f"PASS [hub] {os.path.join(REPORTS_DIR, 'index.html')}")

    if all_errors:
        print("\nSPRINT REPORT VALIDATION FAILED:", file=sys.stderr)
        for e in all_errors:
            print(f"  ✗ {e}", file=sys.stderr)
        sys.exit(1)

    print("\nAll validated sprint reports conform 100% to the canonical contract.")


if __name__ == "__main__":
    main()
