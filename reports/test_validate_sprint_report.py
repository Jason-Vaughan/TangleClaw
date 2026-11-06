#!/usr/bin/env python3
"""
Unit test suite for TangleClaw Sprint Report Validator (P4 / Rule #283.5 · v2.0.0).

Verifies that `validate-sprint-report.py` passes all canonical reports and deterministically
rejects every failure mode identified in both the v5.57.0–v5.61.0 and v5.65.0–v5.66.0
reconciliation audits:
1. Duplicate / conflicting `id="ade-efficiency-card"` banners (`Calculation A 0.17` vs `Calculation B 3.12`).
2. PR count mismatch (`26` vs `27` or `true_merge_count != len(prs_merged)`).
3. Issue IDs (`#2832, #2852`) erroneously transcribed into the PR list (`diff.prs_merged`).
4. Unreconciled issue / GitHub Milestone closure totals (`52` vs `54`, or claiming `8` closed in `v5.66.0` instead of `6` + `#2880`).
5. Claiming multi-slice Slice 2 re-milestoned issues (`#2866, #2878, #2883, #2877`) as closed in `Milestone #50` (`12` vs `8 + 4`).
6. Substituting a pipelined merge/deploy tail (`0.40h` / `0.41h` / `24m`) for `full_engineering_window_hrs` (`1.60h`) when `pipeline_overlap_hrs > 0`.
7. Partial PR LOC summation mismatch (`2-of-5` PRs vs full net/feature diff).
8. Unreceipted `State D — Externally Accepted` claims (`state_d_externally_accepted_issues > 0` without receipt).
9. Divergence between rendered `#ade-efficiency-card` HTML text and `#tc-canonical-metrics` JSON.
10. Timestamp chronology violations (`t1..t8`).
"""

import copy
import importlib.util
import json
import os
import pathlib
import re
import sys
import unittest

REPORTS_DIR = "/tmp/tc-sprint-reports"
if REPORTS_DIR not in sys.path:
    sys.path.insert(0, REPORTS_DIR)

spec = importlib.util.spec_from_file_location(
    "validate_sprint_report",
    os.path.join(REPORTS_DIR, "validate-sprint-report.py"),
)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def replace_embedded_json(html: str, new_rec: dict) -> str:
    payload = json.dumps(new_rec, indent=2)
    return re.sub(
        r'(<script[^>]+type="application/json"[^>]+id="tc-canonical-metrics"[^>]*>)(.*?)(</script>)',
        lambda m: f"{m.group(1)}\n{payload}\n      {m.group(3)}",
        html,
        flags=re.S,
    )


class TestValidateSprintReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v5650_path = os.path.join(REPORTS_DIR, "v5.65.0", "index.html")
        cls.v5660_path = os.path.join(REPORTS_DIR, "v5.66.0", "index.html")
        cls.retro_path = os.path.join(REPORTS_DIR, "v5.65.0-v5.66.0-retrospective", "index.html")
        cls.v5650_html = pathlib.Path(cls.v5650_path).read_text(encoding="utf-8")
        cls.v5660_html = pathlib.Path(cls.v5660_path).read_text(encoding="utf-8")
        cls.retro_html = pathlib.Path(cls.retro_path).read_text(encoding="utf-8")
        cls.v5650_json = validator.extract_embedded_json(cls.v5650_path)
        cls.v5660_json = validator.extract_embedded_json(cls.v5660_path)
        cls.retro_json = validator.extract_embedded_json(cls.retro_path)

    def test_01_canonical_v5650_v5660_retro_and_hub_pass(self):
        self.assertEqual(validator.validate_report(self.v5650_path, "v5.65.0"), [])
        self.assertEqual(validator.validate_report(self.v5660_path, "v5.66.0"), [])
        self.assertEqual(validator.validate_report(self.retro_path, "v5.65.0-v5.66.0-retrospective"), [])
        self.assertEqual(validator.validate_train_consistency(REPORTS_DIR), [])
        self.assertEqual(validator.validate_hub_index(REPORTS_DIR), [])

    def test_02_rejects_duplicate_ade_efficiency_card_banner(self):
        dup_html = self.retro_html.replace(
            "<!-- TANGLECLAW_ADE_BANNER_END -->",
            '<!-- TANGLECLAW_ADE_BANNER_END -->\n<div class="card" id="ade-efficiency-card">Conflicting ADE = 3.12 vs 0.17</div>',
        )
        errs = validator.validate_report_content(dup_html, "v5.65.0-v5.66.0-retrospective", enforce_registry_match=False)
        self.assertTrue(any("duplicate id=\"ade-efficiency-card\"" in e for e in errs), f"Expected duplicate ADE error, got {errs}")

    def test_03_rejects_pr_count_mismatch_v5570_v5610_mode(self):
        bad = copy.deepcopy(self.retro_json)
        bad["diff"]["true_merge_count"] = 8  # Claims 8 instead of 9 (like 26 vs 27 in v5.57.0-v5.61.0)
        mut_html = replace_embedded_json(self.retro_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.65.0-v5.66.0-retrospective", enforce_registry_match=False)
        self.assertTrue(any("PR count mismatch" in e for e in errs), f"Expected PR count mismatch error, got {errs}")

    def test_04_rejects_issue_ids_in_pr_list_v5570_v5610_mode(self):
        bad = copy.deepcopy(self.v5650_json)
        # Replace PR #2900 with issue ID #2832 (simulating issue IDs in PR list)
        bad["diff"]["prs_merged"] = [2899, 2832, 2902, 2901, 2906]
        bad["diff"]["feature_prs"] = [2899, 2832, 2902, 2901]
        mut_html = replace_embedded_json(self.v5650_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.65.0", enforce_registry_match=False)
        self.assertTrue(any("Issue ID(s) [2832] erroneously listed inside diff.prs_merged" in e for e in errs), f"Got {errs}")

    def test_05_rejects_v5660_inflated_closed_issue_count_8_vs_6(self):
        bad = copy.deepcopy(self.v5660_json)
        bad["completion"]["state_c_verified_closed_issues"] = 8  # Inflated from 6 to 8
        mut_html = replace_embedded_json(self.v5660_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.66.0", enforce_registry_match=False)
        self.assertTrue(
            any("state_c_verified_closed_issues" in e for e in errs),
            f"Expected unreconciled closed issue count error, got {errs}",
        )

    def test_06_rejects_v5650_partial_slice_claimed_as_closed_in_milestone_50(self):
        bad = copy.deepcopy(self.v5650_json)
        # Claiming all 12 active issues closed in Milestone #50 while Milestone #50 only has 9 total closures
        bad["completion"]["state_c_verified_closed_issues"] = 12
        bad["completion"]["state_c_issue_ids"] = [1424, 777, 2832, 2834, 2887, 2864, 2871, 2870, 2866, 2878, 2883, 2877]
        mut_html = replace_embedded_json(self.v5650_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.65.0", enforce_registry_match=False)
        self.assertTrue(
            any("Unreconciled chartered issue count" in e or "Unreconciled GitHub Milestone closed total" in e for e in errs),
            f"Expected milestone/slice reconciliation error, got {errs}",
        )

    def test_07_rejects_pipelined_tail_substituted_for_full_engineering_window(self):
        bad = copy.deepcopy(self.v5660_json)
        # Substitute 0.40h (24m pipelined tail) for 1.60h full engineering window while pipeline_overlap_hrs=1.19h
        bad["durations"]["full_engineering_window_hrs"] = 0.40
        mut_html = replace_embedded_json(self.v5660_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.66.0", enforce_registry_match=False)
        self.assertTrue(
            any("Substituting a pipelined merge/deploy tail for the full engineering window is prohibited" in e for e in errs),
            f"Expected pipelined tail substitution error, got {errs}",
        )

    def test_08_rejects_partial_loc_summation_error(self):
        bad = copy.deepcopy(self.v5650_json)
        bad["diff"]["feature_pr_insertions"] = 1563  # Partial 2-of-4 PR sum vs 4208 net
        mut_html = replace_embedded_json(self.v5650_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.65.0", enforce_registry_match=False)
        self.assertTrue(any("LOC accounting mismatch" in e for e in errs), f"Expected LOC mismatch error, got {errs}")

    def test_09_rejects_unreceipted_state_d_external_acceptance(self):
        bad = copy.deepcopy(self.v5660_json)
        bad["completion"]["state_d_externally_accepted_issues"] = 6
        mut_html = replace_embedded_json(self.v5660_html, bad)
        errs = validator.validate_report_content(mut_html, "v5.66.0", enforce_registry_match=False)
        self.assertTrue(any("state_d_externally_accepted_issues" in e for e in errs), f"Expected State D error, got {errs}")

    def test_10_rejects_html_banner_vs_json_divergence_and_chronology_violation(self):
        bad = copy.deepcopy(self.v5660_json)
        bad["timestamps"]["t2_first_branch_commit"] = "2026-11-05T09:00:00Z"  # After t3..t8
        mut_html = replace_embedded_json(self.v5660_html, bad).replace("ADE_v1 = 0.95", "ADE_v1 = 17.80").replace("<strong>0.95</strong>", "<strong>17.80</strong>").replace("ADE 0.95", "ADE 17.80").replace("<code>0.95</code>", "<code>17.80</code>")
        errs = validator.validate_report_content(mut_html, "v5.66.0", enforce_registry_match=False)
        self.assertTrue(any("Timestamp chronology violation" in e for e in errs), f"Expected chronology error, got {errs}")
        self.assertTrue(any("Rendered #ade-efficiency-card banner text does not match canonical JSON" in e for e in errs), f"Expected banner/JSON mismatch error, got {errs}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
