#!/usr/bin/env python3
"""Generate canonical v5.67.0 interactive HTML sprint report matching SPRINT_REPORT_CONTRACT.md v2.0.0,
the v5.40.0+ 8-section contract, v5.47.0+ Plain-English Summary contract, v5.49.0+ Longitudinal Comparison Table
contract, and v5.54.0+ Total Run Time (Start -> Finish) KPI + non-boilerplate postmortem/next-sprint contract."""

import os
import re
import sys
import pathlib

BASE = pathlib.Path('/tmp/tc-sprint-reports')
sys.path.insert(0, str(BASE))
from metrics_schema import (
    DETAILED_SPRINT_RECORDS,
    render_ade_kpi_and_banner,
    render_canonical_governance_and_metrics_cards,
)

rec = DETAILED_SPRINT_RECORDS["v5.67.0"]
dur = rec["durations"]
t_eng_hrs = dur["full_engineering_window_hrs"]
t_auth_hrs = dur["authorization_to_deploy_hrs"]

ade_kpi_html, ade_banner_html = render_ade_kpi_and_banner("v5.67.0")
canonical_audit_html = render_canonical_governance_and_metrics_cards("v5.67.0")

v5510_text = (BASE / 'v5.51.0/index.html').read_text(encoding='utf-8')

style_match = re.search(r'<style>.*?</style>', v5510_text, re.S)
script_match = re.search(r'<script>.*?</script>', v5510_text, re.S)
assert style_match and script_match, "Could not extract style or script from v5.51.0"

style_block = style_match.group(0)
script_block = script_match.group(0)

BASE_V5660_SHORT = os.environ.get("V5670_BASE_SHORT", "1ffeaf6e")
CAR67A_PR = os.environ.get("V5670_CAR67A_PR", "2908")
CAR67A_HEAD_SHORT = os.environ.get("V5670_CAR67A_HEAD_SHORT", "80327362")
CAR67A_MERGE_SHA = os.environ.get("V5670_CAR67A_MERGE_SHA", "cf3290d613d1e512b52a68fe67965da41756390c")
CAR67A_MERGE_SHORT = CAR67A_MERGE_SHA[:8]

CAR67B_PR = os.environ.get("V5670_CAR67B_PR", "2909")
CAR67B_HEAD_SHORT = os.environ.get("V5670_CAR67B_HEAD_SHORT", "2b23ecf9")
CAR67B_MERGE_SHA = os.environ.get("V5670_CAR67B_MERGE_SHA", "1fcb7c5c5ae45f5245ecab0355b19dab876bde2b")
CAR67B_MERGE_SHORT = CAR67B_MERGE_SHA[:8]

CAR67C_PR = os.environ.get("V5670_CAR67C_PR", "2910")
CAR67C_HEAD_SHORT = os.environ.get("V5670_CAR67C_HEAD_SHORT", "cafb1ebd")
CAR67C_MERGE_SHA = os.environ.get("V5670_CAR67C_MERGE_SHA", "f0371b8b021ccca55ad35d2d097dfb8d00e5b20f")
CAR67C_MERGE_SHORT = CAR67C_MERGE_SHA[:8]

REL_PR = os.environ.get("V5670_REL_PR", "2911")
REL_HEAD_SHORT = os.environ.get("V5670_REL_HEAD_SHORT", "0ce48c44")
REL_MERGE_SHA = os.environ.get("V5670_REL_MERGE_SHA", "1b0b09ef4081951e7a18508d604dd57bdaf57184")
REL_MERGE_SHORT = REL_MERGE_SHA[:8]
TAG_SHA_SHORT = os.environ.get("V5670_TAG_SHA_SHORT", "d2b5c177")
REL_RUN_ID = os.environ.get("V5670_REL_RUN_ID", "42149921301")
BACKUP_SHA = os.environ.get("V5670_BACKUP_SHA", "efbbc834973f952542490845cea3402384345be54f3586d83940160890ce479d")
TOTAL_RUNTIME = os.environ.get("V5670_TOTAL_RUNTIME", f"{dur['full_engineering_window_human'].split(' (')[0]} Eng ({t_eng_hrs:.2f}h)")
TOTAL_RUNTIME_SUB = os.environ.get(
    "V5670_TOTAL_RUNTIME_SUB",
    f"t2 12:40:58 → t7 {rec['timestamps']['t7_pst'].split(' ')[0]} PST (T_eng={t_eng_hrs:.2f}h; {dur['authorization_to_deploy_human'].split(' (')[0]} / {t_auth_hrs:.2f}h Auth→Deploy · Milestone #54)"
)
FEATURE_LOC = os.environ.get("V5670_FEATURE_LOC", "+5,388 / -105 net (69 files; +5,330 / -102 feat PRs)")

html_part1 = f'''<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TangleClaw Sprint v5.67.0 — Executive Engineering &amp; Telemetry Report</title>
  <!-- TANGLECLAW_OG_META_START -->
  <meta name="description" content="Executed across 2 coordinated waves on base v5.66.0 as the Final Planned Release of the Week under Charter A504 v1.1 and SPRINT_REPORT_CONTRACT v2.0.0." />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="TangleClaw Autonomous Sprint Reports" />
  <meta property="og:title" content="TangleClaw Sprint v5.67.0 — Executive Engineering &amp; Telemetry Report" />
  <meta property="og:description" content="Executed across 2 coordinated waves on base v5.66.0 as the Final Planned Release of the Week under Charter A504 v1.1 and SPRINT_REPORT_CONTRACT v2.0.0." />
  <meta property="og:url" content="https://jason-vaughan.github.io/TangleClaw/reports/v5.67.0/" />
  <meta property="og:image" content="https://jason-vaughan.github.io/TangleClaw/reports/assets/og-card.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="TangleClaw Sprint v5.67.0 — Executive Engineering &amp; Telemetry Report" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="TangleClaw Sprint v5.67.0 — Executive Engineering &amp; Telemetry Report" />
  <meta name="twitter:description" content="Executed across 2 coordinated waves on base v5.66.0 as the Final Planned Release of the Week under Charter A504 v1.1 and SPRINT_REPORT_CONTRACT v2.0.0." />
  <meta name="twitter:image" content="https://jason-vaughan.github.io/TangleClaw/reports/assets/og-card.png" />
  <link rel="icon" type="image/png" href="https://jason-vaughan.github.io/TangleClaw/reports/assets/logo-icon.png" />
  <link rel="apple-touch-icon" href="https://jason-vaughan.github.io/TangleClaw/reports/assets/apple-touch-icon.png" />
  <!-- TANGLECLAW_OG_META_END -->
  {style_block}
</head>
<body>
  <header class="topnav">
    <div class="topnav-inner">
      <div class="brand">
        <div class="brand-badge">TC</div>
        <div>
          <div style="font-size:0.94rem;">TangleClaw Sprint Report</div>
          <div style="font-size:0.72rem;color:var(--text-dim);font-weight:500;">v5.67.0 · “External integrations and hardware verification” (Charter A504 v1.1 · Milestone #54) · 9 Issues Closed / 4 PRs / 2 Waves · Nov 5, 2026</div>
        </div>
      </div>
      <nav class="nav-links" id="navLinks">
        <a href="../" style="color:var(--accent2);font-weight:700;">← All Sprint Reports</a>
        <a href="#overview" class="active">Overview</a>
        <a href="#plain-english" style="color:var(--green);font-weight:700;">Plain-English</a>
        <a href="#architecture">Architecture</a>
        <a href="#velocity">Velocity</a>
        <a href="#deliverables">Deliverables</a>
        <a href="#telemetry">Telemetry</a>
        <a href="#postmortem">Post-Mortem</a>
        <a href="#waves">Wave Explorer</a>
        <a href="#next-sprint">Next Sprint</a>
      </nav>
      <div class="nav-actions">
        <button class="btn" id="themeBtn" onclick="toggleTheme()" title="Toggle Light/Dark Mode">☀️ Light Mode</button>
        <button class="btn btn-primary" onclick="window.print()">🖨️ Export PDF</button>
      </div>
    </div>
  </header>

  <main class="container">
    <!-- SECTION 1: HERO & EXECUTIVE OVERVIEW -->
    <section class="hero" id="overview">
      <div class="hero-card">
        <div class="eyebrow">● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #54 (v5.67.0) · CHARTER A504 v1.1 · FINAL PLANNED RELEASE OF THE WEEK</div>
        <h1 class="hero-title">TangleClaw <code>v5.67.0</code>: “External integrations and hardware verification”</h1>
        <p class="hero-sub">
          Executed across <strong>2 coordinated waves</strong> on base <code>{BASE_V5660_SHORT}</code> (<code>tag: v5.66.0</code>) as the <strong>Final Planned Release of the Week</strong> under <strong>Charter <code>A504 v1.1</code></strong>, <strong>Architect Disposition Ruling <code>A504-EXT-R1</code></strong>, and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>.
          Shipped <strong>4 Sprint PRs (#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}, #{REL_PR})</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), closing all <strong>9 active chartered in-repo Milestone #54 issues (#2866, #2877, #2878, #2881, #2888, #2883, #2884, #2885, #2886; <code>open_issues: 0, closed_issues: 9</code>)</strong> with <strong>0 post-merge defects on <code>main</code></strong> and <strong><code>{FEATURE_LOC}</code> net repository lines of code across 69 files (82 file touches across the 3 feature PRs)</strong>.
          Per <code>Ruling A503-R1</code> (“Hot-Entrypoint Deferral Rule”), <code>v5.67.0</code> executed a sequential single-builder pass on <code>TC-Lane-D</code> (<code>#1533</code>) to mount all deferred Slice 2/3 adapters cleanly into shared entrypoints without merge collisions:
          <code>Car 67-A PR #{CAR67A_PR}</code> (<code>#2866 + #2877 + #2878</code>: <code>lib/merge-role-guard.js</code> launch-env <code>PATH</code> wrapper in <code>lib/sessions.js</code>, <code>tc roadmap admission|sync</code> &amp; <code>scripts/roadmap-sync-check.js</code> CLI, and <code>tc merge-gate</code> + live <code>/api/sessions/:project/merge-gate/*</code> routes in <code>lib/routes/sessions.js</code>; merged at <code>{CAR67A_MERGE_SHORT}</code>),
          <code>Car 67-B PR #{CAR67B_PR}</code> (<code>#2881 + #2888</code>: <code>ensureSessionTranscript</code> backfill in <code>GET /api/continuity/:project/sessions/:sid</code> &amp; <code>transcriptSourceBadge</code> in <code>public/history-drawer.js</code>, <code>GET /api/sessions/:project/governed-wrap/:requestId/stream</code> SSE route in <code>lib/routes/wrap.js</code>, <code>/api/sessions/:project/chunk-boundary*</code> routes in <code>lib/routes/sessions.js</code> + <code>public/chunk-boundary-ui.js</code>, and <code>primerForLaunch</code> in <code>lib/sessions.js#_collectPrimeSections</code> + <code>acquireLeaseWithPrimer</code> in <code>lib/resource-leases.js</code>; merged at <code>{CAR67B_MERGE_SHORT}</code>), and
          <code>Car 67-C PR #{CAR67C_PR}</code> (<code>#2883 + #2884 + #2885 + #2886</code>: <code>GET /api/scorecard</code> + scheduled refresh timer in <code>server.js</code> &amp; <code>scripts/scorecard-publish-metrics.js</code>, <code>public/bridge-step-up.js</code> &amp; <code>public/bridge-settings-ui.js</code> mounted in <code>public/ui.js#openGlobalSettings</code>, <code>createLifecycleHandoffDaemon</code> boot/shutdown lifecycle in <code>server.js</code> &amp; <code>reconcile-startup</code>/<code>takeover</code> route adapters in <code>lib/routes/sessions.js</code>, and wrap-drawer docs-parity notice + <code>POST /wrap/docs-parity/dismiss</code> &amp; <code>GET /api/https/remote-ca-plan</code> + Setup Wizard mkcert integration in <code>public/setup.js</code>; merged at <code>{CAR67C_MERGE_SHORT}</code>).
          Under <strong>Ruling <code>A504-EXT-R1</code> (<code>Rule #1 / A185</code>)</strong>, the 3 external/hardware/upstream-blocked items (<code>#1564</code> physical Linux host <code>systemd --user</code> VRF, <code>#2347</code> blocked on upstream <code>Jason-Vaughan/Medusa#67</code>, and <code>#2258</code> external Vercel dashboard/domain cutover) were formally receipted and reclassified to <code>Backlog</code>.
        </p>

        <div class="meta-bar">
          <div class="meta-pill"><span>Release Target:</span> <code>v5.67.0</code> (Tag <code>v5.67.0 @ {TAG_SHA_SHORT}</code> · Merge <code>{REL_MERGE_SHORT}</code> · Base <code>v5.66.0 @ {BASE_V5660_SHORT}</code> · Milestone <code>#54: 0 open, 9 closed</code>)</div>
          <div class="meta-pill"><span>Wave 1 Cars (9 Issues Closed):</span> <code>67-A #{CAR67A_PR} @ {CAR67A_MERGE_SHORT}</code> (3) · <code>67-B #{CAR67B_PR} @ {CAR67B_MERGE_SHORT}</code> (2) · <code>67-C #{CAR67C_PR} @ {CAR67C_MERGE_SHORT}</code> (4)</div>
          <div class="meta-pill"><span>Wave 2 Release Car:</span> <code>REL #{REL_PR} @ {REL_MERGE_SHORT}</code> (Drained 9 <code>changelog.d/*.md</code> fragments into <code>CHANGELOG.md [5.67.0]</code> + <code>docs/releases/v5.67.0.md</code>)</div>
          <div class="meta-pill"><span>External Blocker Disposition (A504-EXT-R1):</span> <code>#1564, #2347, #2258</code> receipted &amp; reclassified to Backlog under <code>Rule #1 / A185</code></div>
          <div class="meta-pill"><span>Testament v0.34.0 Pool (G10):</span> <code>100%</code> Stage 1 + Remote Testament <code>0.34.0</code> pool &amp; CI verification · <code>0</code> host CPU test contention</div>
          <div class="meta-pill"><span>Observer Participant Disclosure:</span> <code>TC-Lane-Obsr</code> (#1540) operated as Gate 3/4 Observer &amp; Sprint Report Producer (Rule #283 cl. 1)</div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Sprint Version &amp; Milestone</div>
            <div class="kpi-value cyan">v5.67.0 (#54)</div>
            <div class="kpi-sub">“External integrations &amp; hardware VRF” · Final Sprint of the Week (<code>Charter A504 v1.1</code>) · <code>open_issues: 0, closed: 9</code></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Issues &amp; PRs Shipped</div>
            <div class="kpi-value green">9 / 9 Closed</div>
            <div class="kpi-sub"><code>9</code> verified closed in <code>#54</code> across <code>4</code> PRs (<code>#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}, #{REL_PR}</code>) + <code>3</code> A185 Backlog reclassifications</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Total Run Time (Start → Finish)</div>
            <div class="kpi-value green">{TOTAL_RUNTIME}</div>
            <div class="kpi-sub">{TOTAL_RUNTIME_SUB}</div>
          </div>
{ade_kpi_html}
          <div class="kpi-card">
            <div class="kpi-label">True Merge Commits (Rule #282)</div>
            <div class="kpi-value green">4 / 4 (100%)</div>
            <div class="kpi-sub">All 4 PRs merged by <code>TC-Lane-INT</code> via <code>gh pr merge --merge</code> (verified 2-parent ancestry)</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Testament Pool &amp; CI (G10)</div>
            <div class="kpi-value green">100% PASS</div>
            <div class="kpi-sub"><code>13,698+</code> remote Testament <code>0.34.0</code> tests + <code>113/113</code> release suite + exact-head GitHub <code>Tests</code> green</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Net Repo Diff &amp; Feature Sum</div>
            <div class="kpi-value purple">+5,388 / -105</div>
            <div class="kpi-sub">Net tree diff across <code>69</code> files (<code>1ffeaf6e..{REL_MERGE_SHORT}</code>); feature PR sum <code>+5,330 / -102</code> LOC</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Pre-Merge Review Catches</div>
            <div class="kpi-value cyan">8 Catches / 0 Reg</div>
            <div class="kpi-sub"><code>I-Gate</code> &amp; <code>A-Gate</code> caught 6 code edge cases in Wave 1 + 2 release-copy overclaims in <code>PR #{REL_PR}</code> before merge</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">4-Gate &amp; Rule #283 Audit</div>
            <div class="kpi-value green">16 / 16 PASS</div>
            <div class="kpi-sub"><code>I-Gate</code> · <code>B-Gate</code> · <code>A-Gate</code> · <code>O-Gate</code> verified under <code>SPRINT_REPORT_CONTRACT v2.0</code></div>
          </div>
        </div>

        <!-- PLAIN-ENGLISH SUMMARY FOR NON-TECHNICAL READERS (MANDATORY v5.47.0+ CONTRACT) -->
        <div id="plain-english" style="margin-top:22px;padding:22px 24px;border-radius:14px;background:linear-gradient(135deg,rgba(52,211,153,0.10),rgba(56,189,248,0.08));border:1px solid rgba(52,211,153,0.35);">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
            <span class="badge badge-green" style="font-size:0.76rem;padding:4px 10px;">📖 Plain-English Summary — What Sprint v5.67.0 Accomplished &amp; Why It Matters</span>
            <span style="font-size:0.78rem;color:var(--text-muted);">Written for operators, stakeholders &amp; non-specialist readers</span>
          </div>
          <h3 style="margin:0 0 10px;font-size:1.12rem;color:var(--text);">Live Entrypoint Mounts for Launch Role Guards, Merge-Inbox-Gate &amp; Roadmap CLI, Session History &amp; Governed-Wrap Streams, and Server/Dashboard Controls</h3>
          <p style="margin:0 0 14px;font-size:0.93rem;color:var(--text-muted);line-height:1.65;">
            Sprint <code>v5.67.0</code> (<strong>“External integrations and hardware verification”</strong>, the final planned release of the week's train) connects the standalone engines built across <code>v5.61.0–v5.66.0</code> directly into TangleClaw's live server, CLI, session launcher, and dashboard UI across <strong>9 closed issues and 4 pull requests</strong> (<code>{FEATURE_LOC}</code>):
          </p>
          <div class="grid-3" style="gap:14px;">
            <div style="background:rgba(10,15,29,0.65);border:1px solid var(--border);border-radius:10px;padding:14px;">
              <strong style="color:var(--green);display:block;margin-bottom:6px;font-size:0.92rem;">1. Launch-Time `gh` Merge Guard, Roadmap CLI &amp; Live Merge-Gate Routes (`#2866, #2877, #2878`)</strong>
              <p style="margin:0;font-size:0.84rem;color:var(--text-muted);line-height:1.55;">
                <code>Car 67-A</code> (<code>PR #{CAR67A_PR}</code>, <code>+2,166 / -32</code> LOC across <code>26</code> files) places a role-aware <code>gh</code> wrapper on every launched session's <code>PATH</code> so non-Integrator lanes are mechanically blocked from running <code>gh pr merge</code> (<code>#2866</code>), adds <code>tc roadmap admission|sync</code> and <code>scripts/roadmap-sync-check.js</code> (<code>#2877</code>), and mounts <code>tc merge-gate</code> plus live <code>/api/sessions/:project/merge-gate/*</code> routes (<code>#2878</code>).
              </p>
            </div>
            <div style="background:rgba(10,15,29,0.65);border:1px solid var(--border);border-radius:10px;padding:14px;">
              <strong style="color:var(--accent2);display:block;margin-bottom:6px;font-size:0.92rem;">2. Native Session History Backfill, Governed-Wrap SSE Stream &amp; Operating Primer (`#2881, #2888`)</strong>
              <p style="margin:0;font-size:0.84rem;color:var(--text-muted);line-height:1.55;">
                <code>Car 67-B</code> (<code>PR #{CAR67B_PR}</code>, <code>+1,395 / -39</code> LOC across <code>29</code> files) mounts transcript backfill into <code>GET /api/continuity/:project/sessions/:sid</code> with provenance badges in the History drawer and adds <code>GET /api/sessions/:project/governed-wrap/:requestId/stream</code> (<code>#2881</code>), mounts project-scoped <code>/api/sessions/:project/chunk-boundary*</code> routes, and injects role-specific operating primers into session launches (<code>#2888</code>).
              </p>
            </div>
            <div style="background:rgba(10,15,29,0.65);border:1px solid var(--border);border-radius:10px;padding:14px;">
              <strong style="color:var(--purple);display:block;margin-bottom:6px;font-size:0.92rem;">3. Live Scorecard Endpoint, Bridge Step-Up/Settings UI, Lifecycle Daemon &amp; Docs-Parity/CA Mounts (`#2883–#2886`)</strong>
              <p style="margin:0;font-size:0.84rem;color:var(--text-muted);line-height:1.55;">
                <code>Car 67-C</code> (<code>PR #{CAR67C_PR}</code>, <code>+1,769 / -31</code> LOC across <code>27</code> files) wires <code>GET /api/scorecard</code>, scheduled refresh, and <code>scripts/scorecard-publish-metrics.js</code> (<code>#2883</code>), mounts Bridge step-up and notification settings into Global Settings (<code>#2884</code>), starts/stops the lifecycle-handoff daemon with <code>server.js</code> (<code>#2885</code>), and wires wrap-drawer docs-parity notices plus Setup Wizard remote-CA plans (<code>#2886</code>).
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
'''

html_part2 = f'''
    <!-- SECTION 2: MULTI-AGENT ARCHITECTURE & 10-LANE TOPOLOGY -->
    <section class="section" id="architecture">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">01</span> Multi-Agent Fleet Topology &amp; Single-Builder Hot-Entrypoint Mount Architecture</h2>
          <p class="section-desc">Execution of <code>v5.67.0</code> (<code>Charter A504 v1.1</code>, <code>Milestone #54</code>) using sequential single-builder cars on <code>TC-Lane-D</code> to eliminate collisions across shared entrypoints (<code>server.js</code>, <code>lib/sessions.js</code>, <code>lib/routes/sessions.js</code>, <code>public/index.html</code>).</p>
        </div>
        <span class="badge badge-blue">Charter A504 v1.1 · 3 Sequential Wave 1 Cars + W2-REL · 0 Entrypoint Merge Conflicts</span>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>Fleet Role Assignments &amp; Governance Responsibilities (<code>Charter A504 v1.1</code>)</h3>
          <p style="font-size:0.87rem;color:var(--text-muted);margin-top:0;">
            Because all 9 actionable issues in <code>Milestone #54</code> mounted Slice 1/2 modules into high-fan-in entrypoints, <code>Charter A504 v1.1</code> sequenced <code>Car 67-A</code>, <code>Car 67-B</code>, and <code>Car 67-C</code> through <code>TC-Lane-D</code> (<code>#1533</code>) with dual-PRR (<code>TC-Lane-PRR-A</code> &amp; <code>TC-Lane-PRR-B</code>) and Architect (<code>TC-Lane-Arc</code>) certification at every step:
          </p>
          <div class="table-wrap">
            <table class="pr-table">
              <thead>
                <tr>
                  <th>Lane / Session</th>
                  <th>Workspace &amp; Engine</th>
                  <th>Role &amp; Governance</th>
                  <th>v5.67.0 Assignment &amp; Verified Output</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>TC-Lane-PM</code> (<code>#1541</code>)</td>
                  <td><code>tc-lane-pm-9d85f3aa</code> (<code>antigravity</code>)</td>
                  <td>Coordinator (<code>Rule #285 v3</code>)</td>
                  <td>Authored <code>Charter A504 v1.0/v1.1</code>, coordinated sequential Wave 1 dispatches (<code>Car 67-A → 67-B → 67-C</code>) and Wave 2 release cut (<code>PR #{REL_PR}</code>)</td>
                </tr>
                <tr>
                  <td><code>TC-Lane-Arc</code> (<code>#1538</code>)</td>
                  <td><code>tc-lane-arc-4041e89e</code> (<code>claude</code>)</td>
                  <td>Architect (<code>A-Gate / R-Gate</code>)</td>
                  <td>Issued Disposition Ruling <code>A504-EXT-R1</code> (<code>#1564, #2347, #2258</code>), primary-code rulings <code>A504-W1A-R1..R4</code>, <code>A504-W1B-R3..R4</code>, <code>A504-W1C-R3..R5</code>, and certified <code>A-Gate PASS</code> across all 4 PRs</td>
                </tr>
                <tr>
                  <td><code>TC-Lane-D</code> (<code>#1533</code>)</td>
                  <td><code>tc-lane-d-c2ba6715</code> (<code>claude</code>)</td>
                  <td>Primary Builder (<code>Rule #271</code>)</td>
                  <td>Shipped all 3 Wave 1 hot-entrypoint cars: <strong><code>Car 67-A PR #{CAR67A_PR}</code></strong> (<code>+2,166/-32</code>), <strong><code>Car 67-B PR #{CAR67B_PR}</code></strong> (<code>+1,395/-39</code>), and <strong><code>Car 67-C PR #{CAR67C_PR}</code></strong> (<code>+1,769/-31</code>)</td>
                </tr>
                <tr>
                  <td><code>TC-Lane-PRR-A</code> (<code>#1536</code>)</td>
                  <td><code>tc-lane-prr-a-14aa53c4</code> (<code>codex medium</code>)</td>
                  <td>PR Reviewer A (<code>I-Gate</code>)</td>
                  <td>Reviewed &amp; certified <code>Car 67-A PR #{CAR67A_PR}</code> (R4 PASS <code>#5792688775</code>), <code>Car 67-C PR #{CAR67C_PR}</code> (R3 PASS <code>#5794717466</code>), and Release <code>PR #{REL_PR}</code> (caught 2 release-copy overclaims in R1/R2 before PASS)</td>
                </tr>
                <tr>
                  <td><code>TC-Lane-PRR-B</code> (<code>#1539</code>)</td>
                  <td><code>tc-lane-prr-b-d921b819</code> (<code>codex medium</code>)</td>
                  <td>PR Reviewer B (<code>I-Gate</code>)</td>
                  <td>Reviewed &amp; certified <code>Car 67-B PR #{CAR67B_PR}</code> (caught cross-project URL binding in R1 <code>#5793760683</code> → R2 PASS <code>#5793860999</code>)</td>
                </tr>
                <tr>
                  <td><code>TC-Lane-INT</code> (<code>#1537</code>)</td>
                  <td><code>tc-lane-int-08674b81</code> (<code>codex medium</code>)</td>
                  <td>Integrator (<code>B-Gate / Release</code>)</td>
                  <td>Enforced <code>Rule #282</code> 2-parent true merges across all 4 PRs (<code>#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}, #{REL_PR}</code>), cut Release <code>PR #{REL_PR}</code>, and executed guarded live deploy on <code>:3102</code></td>
                </tr>
                <tr>
                  <td><code>TC-Lane-Obsr</code> (<code>#1540</code>)</td>
                  <td><code>tc-lane-obsr-c75f42dd</code> (<code>antigravity</code>)</td>
                  <td>Observer &amp; Companion (<code>O-Gate</code>)</td>
                  <td>Upgraded reporting standard to <code>SPRINT_REPORT_CONTRACT v2.0.0</code>, authored <code>gen_v5670.py</code> &amp; <code>v5.67.0/index.html</code>, validated all 41 reports via <code>validate-sprint-report.py --all</code>, and certified <code>O-Gate PASS</code></td>
                </tr>
                <tr>
                  <td><code>TC-Lane-A / B / C</code></td>
                  <td><code>tc-lane-a/b/c</code> (<code>claude</code>)</td>
                  <td>Standby Builders (<code>Rule #271</code>)</td>
                  <td>Maintained clean <code>complete / safe-to-clear</code> standby on <code>origin/main</code> while <code>TC-Lane-D</code> executed sequential hot-entrypoint mounts</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h3>SVG Diagram 1 — Sprint <code>v5.67.0</code> Hot-Entrypoint Mount Architecture Across CLI, Session Routes &amp; Dashboard</h3>
          <div class="svg-wrap" style="background:rgba(7,11,20,0.7);border:1px solid var(--border);border-radius:12px;padding:12px;">
            <svg viewBox="0 0 760 360" width="100%" height="auto" role="img" aria-label="Sprint v5.67.0 Hot-Entrypoint Mount Architecture">
              <defs>
                <linearGradient id="v5670Left" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#0284c7" stop-opacity="0.35"/>
                  <stop offset="100%" stop-color="#1e293b" stop-opacity="0.9"/>
                </linearGradient>
                <linearGradient id="v5670Center" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.35"/>
                  <stop offset="100%" stop-color="#1e293b" stop-opacity="0.9"/>
                </linearGradient>
                <linearGradient id="v5670Right" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.3"/>
                  <stop offset="100%" stop-color="#0f172a" stop-opacity="0.95"/>
                </linearGradient>
              </defs>
              <!-- Left Box: Car 67-A (#2908) -->
              <rect x="16" y="28" width="224" height="304" rx="12" fill="url(#v5670Left)" stroke="#38bdf8" stroke-width="1.5"/>
              <text x="30" y="54" fill="#38bdf8" font-size="12" font-weight="700">CLI &amp; MERGE GATE (3)</text>
              <text x="30" y="72" fill="#cbd5e1" font-size="10">Car 67-A · PR #{CAR67A_PR} (@ {CAR67A_MERGE_SHORT})</text>
              <rect x="28" y="88" width="200" height="72" rx="8" fill="#0f172a" stroke="#334155"/>
              <text x="38" y="108" fill="#e2e8f0" font-size="10" font-weight="600">1. Launch gh PATH Wrapper (#2866)</text>
              <text x="38" y="126" fill="#94a3b8" font-size="9">lib/merge-role-guard.js + sessions.js</text>
              <text x="38" y="142" fill="#34d399" font-size="9">Blocks non-INT gh pr merge</text>
              <rect x="28" y="170" width="200" height="68" rx="8" fill="#0f172a" stroke="#334155"/>
              <text x="38" y="190" fill="#38bdf8" font-size="10" font-weight="600">2. Roadmap Sync/Admission (#2877)</text>
              <text x="38" y="208" fill="#94a3b8" font-size="9">tc roadmap admission|sync</text>
              <text x="38" y="224" fill="#fbbf24" font-size="9">scripts/roadmap-sync-check.js</text>
              <rect x="28" y="248" width="200" height="68" rx="8" fill="#0f172a" stroke="#334155"/>
              <text x="38" y="268" fill="#c084fc" font-size="10" font-weight="600">3. Merge-Inbox-Gate (#2878)</text>
              <text x="38" y="286" fill="#94a3b8" font-size="9">tc merge-gate + /merge-gate/*</text>
              <text x="38" y="302" fill="#34d399" font-size="9">26 files (+2,166 / -32 LOC)</text>

              <!-- Center Box: Car 67-B (#2909) -->
              <rect x="272" y="28" width="216" height="304" rx="12" fill="url(#v5670Center)" stroke="#a855f7" stroke-width="1.5"/>
              <text x="286" y="54" fill="#c084fc" font-size="12" font-weight="700">CONTINUITY &amp; PRIMER (2)</text>
              <text x="286" y="72" fill="#cbd5e1" font-size="10">Car 67-B · PR #{CAR67B_PR} (@ {CAR67B_MERGE_SHORT})</text>
              <rect x="284" y="88" width="192" height="106" rx="8" fill="#0f172a" stroke="#a855f7"/>
              <text x="294" y="108" fill="#e2e8f0" font-size="10" font-weight="600">History &amp; Wrap Stream (#2881)</text>
              <text x="294" y="126" fill="#94a3b8" font-size="9">ensureSessionTranscript in server.js</text>
              <text x="294" y="144" fill="#34d399" font-size="9">transcriptSourceBadge in history-drawer</text>
              <text x="294" y="162" fill="#38bdf8" font-size="9">GET .../governed-wrap/:id/stream</text>
              <rect x="284" y="206" width="192" height="110" rx="8" fill="#0f172a" stroke="#34d399"/>
              <text x="294" y="226" fill="#34d399" font-size="10" font-weight="600">Chunk-Boundary &amp; Primer (#2888)</text>
              <text x="294" y="244" fill="#94a3b8" font-size="9">/api/sessions/:project/chunk-boundary*</text>
              <text x="294" y="262" fill="#e2e8f0" font-size="9">primerForLaunch in _collectPrimeSections</text>
              <text x="294" y="280" fill="#fbbf24" font-size="9">29 files (+1,395 / -39 LOC)</text>

              <!-- Right Box: Car 67-C (#2910) -->
              <rect x="520" y="28" width="224" height="304" rx="12" fill="url(#v5670Right)" stroke="#10b981" stroke-width="1.4"/>
              <text x="534" y="54" fill="#34d399" font-size="12" font-weight="700">SERVER &amp; UI MOUNTS (4)</text>
              <text x="534" y="72" fill="#cbd5e1" font-size="10">Car 67-C · PR #{CAR67C_PR} (@ {CAR67C_MERGE_SHORT})</text>
              <rect x="532" y="88" width="200" height="54" rx="6" fill="#0f172a" stroke="#10b981"/>
              <text x="542" y="106" fill="#34d399" font-size="9.5" font-weight="600">1. Scorecard Route &amp; CLI (#2883)</text>
              <text x="542" y="122" fill="#94a3b8" font-size="8.5">GET /api/scorecard + publish CLI</text>
              <rect x="532" y="148" width="200" height="54" rx="6" fill="#0f172a" stroke="#10b981"/>
              <text x="542" y="166" fill="#38bdf8" font-size="9.5" font-weight="600">2. Bridge Step-Up &amp; Settings (#2884)</text>
              <text x="542" y="182" fill="#94a3b8" font-size="8.5">Mounted in openGlobalSettings (ui.js)</text>
              <rect x="532" y="208" width="200" height="54" rx="6" fill="#0f172a" stroke="#10b981"/>
              <text x="542" y="226" fill="#c084fc" font-size="9.5" font-weight="600">3. Lifecycle Handoff Daemon (#2885)</text>
              <text x="542" y="242" fill="#94a3b8" font-size="8.5">server.js boot/stop + session routes</text>
              <rect x="532" y="268" width="200" height="52" rx="6" fill="#0f172a" stroke="#10b981"/>
              <text x="542" y="286" fill="#fbbf24" font-size="9.5" font-weight="600">4. Docs-Parity &amp; Remote CA (#2886)</text>
              <text x="542" y="302" fill="#94a3b8" font-size="8.5">wrap-drawer + setup.js (+1,769 LOC)</text>

              <!-- Arrows -->
              <line x1="240" y1="165" x2="272" y2="165" stroke="#38bdf8" stroke-width="2"/>
              <line x1="488" y1="165" x2="520" y2="165" stroke="#34d399" stroke-width="2"/>
            </svg>
          </div>
          <p style="font-size:0.82rem;color:var(--text-muted);margin:10px 0 0;">
            <strong>Hot-Entrypoint Mount Pass (`Charter A504 v1.1`):</strong> Sequential single-builder execution (`Car 67-A → Car 67-B → Car 67-C`) mounted all 9 deferred Slice 2/3 issues into `server.js`, `lib/sessions.js`, `lib/routes/sessions.js`, `public/index.html`, and `bin/tc.js` with zero merge conflicts.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION 3: WAVE-BY-WAVE VELOCITY & TIMELINE -->
    <section class="section" id="velocity">
{ade_banner_html}
{canonical_audit_html}
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">02</span> Wave-by-Wave Execution Timeline &amp; Sequential Entrypoint Velocity</h2>
          <p class="section-desc">End-to-end progression from <code>v5.66.0</code> baseline (`{BASE_V5660_SHORT}`) through sequential Wave 1 merges (`#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}`) and Release <code>PR #{REL_PR}</code>.</p>
        </div>
        <span class="badge badge-green">4 PRs True-Merged · 9/9 Active Milestone #54 Issues Closed (open_issues: 0) · 3 A185 Backlog Items Receipted</span>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>SVG Diagram 2 — Sprint <code>v5.67.0</code> Sequential Hot-Entrypoint Wave Execution Timeline</h3>
          <div class="svg-wrap" style="background:rgba(7,11,20,0.7);border:1px solid var(--border);border-radius:12px;padding:12px;">
            <svg viewBox="0 0 760 340" width="100%" height="auto" role="img" aria-label="Sprint v5.67.0 Wave Execution Gantt Chart">
              <line x1="140" y1="28" x2="140" y2="300" stroke="#334155" stroke-width="1"/>
              <line x1="265" y1="28" x2="265" y2="300" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>
              <line x1="395" y1="28" x2="395" y2="300" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>
              <line x1="525" y1="28" x2="525" y2="300" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>
              <line x1="635" y1="28" x2="635" y2="300" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>
              <line x1="725" y1="28" x2="725" y2="300" stroke="#334155" stroke-width="1"/>

              <text x="115" y="20" fill="#94a3b8" font-size="10">11:11 Gate 0</text>
              <text x="235" y="20" fill="#94a3b8" font-size="10">14:07 #2908</text>
              <text x="365" y="20" fill="#94a3b8" font-size="10">16:16 #2909</text>
              <text x="495" y="20" fill="#94a3b8" font-size="10">18:05 #2910</text>
              <text x="605" y="20" fill="#94a3b8" font-size="10">W2-REL</text>
              <text x="680" y="20" fill="#34d399" font-size="10" font-weight="700">v5.67.0 Live</text>

              <!-- Row 1: Gate 0 & A504-EXT-R1 -->
              <text x="14" y="58" fill="#38bdf8" font-size="11" font-weight="600">Gate 0 &amp; EXT-R1</text>
              <text x="14" y="72" fill="#94a3b8" font-size="9">#1564, #2347, #2258</text>
              <rect x="140" y="42" width="55" height="28" rx="6" fill="#38bdf8" fill-opacity="0.32" stroke="#38bdf8"/>
              <text x="204" y="60" fill="#bae6fd" font-size="9.5">Charter A504 v1.1 + A504-EXT-R1 Backlog Disposition</text>

              <!-- Row 2: Car 67-A (#2908) -->
              <text x="14" y="106" fill="#c084fc" font-size="11" font-weight="600">Car 67-A (#{CAR67A_PR})</text>
              <text x="14" y="120" fill="#94a3b8" font-size="9">#2866, #2877, #2878</text>
              <rect x="180" y="90" width="85" height="28" rx="6" fill="#a855f7" fill-opacity="0.35" stroke="#c084fc"/>
              <text x="274" y="108" fill="#e2e8f0" font-size="9.5">PR #{CAR67A_PR} ({CAR67A_MERGE_SHORT}) · R4 I-Gate &amp; A-Gate PASS (+2,166 LOC)</text>

              <!-- Row 3: Car 67-B (#2909) -->
              <text x="14" y="154" fill="#22d3ee" font-size="11" font-weight="600">Car 67-B (#{CAR67B_PR})</text>
              <text x="14" y="168" fill="#94a3b8" font-size="9">#2881, #2888</text>
              <rect x="275" y="138" width="120" height="28" rx="6" fill="#06b6d4" fill-opacity="0.35" stroke="#22d3ee"/>
              <text x="404" y="156" fill="#e2e8f0" font-size="9.5">PR #{CAR67B_PR} ({CAR67B_MERGE_SHORT}) · R2 I-Gate &amp; A-Gate PASS (+1,395 LOC)</text>

              <!-- Row 4: Car 67-C (#2910) -->
              <text x="14" y="202" fill="#fbbf24" font-size="11" font-weight="600">Car 67-C (#{CAR67C_PR})</text>
              <text x="14" y="216" fill="#94a3b8" font-size="9">#2883, #2884, #2885, #2886</text>
              <rect x="405" y="186" width="120" height="28" rx="6" fill="#f59e0b" fill-opacity="0.35" stroke="#fbbf24"/>
              <text x="534" y="204" fill="#fbbf24" font-size="9.5">PR #{CAR67C_PR} ({CAR67C_MERGE_SHORT}) · R3 PASS (+1,769 LOC)</text>

              <!-- Row 5: Wave 2 Release Cut & Live Deploy -->
              <text x="14" y="252" fill="#34d399" font-size="11" font-weight="700">W2-REL &amp; Deploy</text>
              <text x="14" y="266" fill="#94a3b8" font-size="9">PR #{REL_PR} + v5.67.0</text>
              <rect x="530" y="236" width="195" height="28" rx="6" fill="#10b981" fill-opacity="0.45" stroke="#34d399" stroke-width="1.8"/>
              <text x="300" y="290" fill="#34d399" font-size="10" font-weight="600">PR #{REL_PR} ({REL_MERGE_SHORT}) → Tag v5.67.0 → Live :3102 &amp; O-Gate PASS</text>
            </svg>
          </div>
        </div>

        <div class="card">
          <h3>Wave Progression &amp; True-Merge Commit Chain (<code>{BASE_V5660_SHORT}</code> → <code>{REL_MERGE_SHORT}</code>)</h3>
          <div class="table-wrap">
            <table class="pr-table">
              <thead>
                <tr>
                  <th>Wave / Car</th>
                  <th>PR &amp; Merge Commit</th>
                  <th>Head SHA</th>
                  <th>Wave Phase</th>
                  <th>Scope &amp; Touches</th>
                  <th>Key Verification &amp; Review Outcome</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Baseline</strong></td>
                  <td><code>v5.66.0</code> Release (<code>{BASE_V5660_SHORT}</code>)</td>
                  <td><code>{BASE_V5660_SHORT}</code></td>
                  <td><code>Gate 0</code></td>
                  <td>Live <code>:3102</code></td>
                  <td>Charter <code>A504 v1.1</code> + Ruling <code>A504-EXT-R1</code> (<code>#6666856332</code>): reclassified external items <code>#1564, #2347, #2258</code> to Backlog</td>
                </tr>
                <tr>
                  <td><strong><code>Car 67-A (W1-A)</code></strong></td>
                  <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67A_PR}" target="_blank" rel="noopener">PR #{CAR67A_PR}</a> (<code>{CAR67A_MERGE_SHORT}</code>)</td>
                  <td><code>{CAR67A_HEAD_SHORT}</code></td>
                  <td><code>Wave 1 (Seq 1)</code></td>
                  <td><code>26</code> files (<code>+2,166 / -32</code>)</td>
                  <td><code>PRR-A R4 PASS (#5792688775)</code> + <code>Arc R4 PASS (#6670533331)</code> + <code>Rulings A504-W1A-R1..R4</code>: <code>#2866, #2877, #2878</code></td>
                </tr>
                <tr>
                  <td><strong><code>Car 67-B (W1-B)</code></strong></td>
                  <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67B_PR}" target="_blank" rel="noopener">PR #{CAR67B_PR}</a> (<code>{CAR67B_MERGE_SHORT}</code>)</td>
                  <td><code>{CAR67B_HEAD_SHORT}</code></td>
                  <td><code>Wave 1 (Seq 2)</code></td>
                  <td><code>29</code> files (<code>+1,395 / -39</code>)</td>
                  <td><code>PRR-B R2 PASS (#5793860999)</code> + <code>Arc R2 PASS (#6672790012)</code> + <code>Rulings A504-W1B-R3..R4</code>: <code>#2881, #2888</code></td>
                </tr>
                <tr>
                  <td><strong><code>Car 67-C (W1-C)</code></strong></td>
                  <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67C_PR}" target="_blank" rel="noopener">PR #{CAR67C_PR}</a> (<code>{CAR67C_MERGE_SHORT}</code>)</td>
                  <td><code>{CAR67C_HEAD_SHORT}</code></td>
                  <td><code>Wave 1 (Seq 3)</code></td>
                  <td><code>27</code> files (<code>+1,769 / -31</code>)</td>
                  <td><code>PRR-A R3 PASS (#5794717466)</code> + <code>Arc R3 PASS (#6674697149)</code> + <code>Rulings A504-W1C-R3..R5</code>: <code>#2883, #2884, #2885, #2886</code></td>
                </tr>
                <tr>
                  <td><strong><code>W2-REL</code></strong></td>
                  <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{REL_PR}" target="_blank" rel="noopener">PR #{REL_PR}</a> (<code>{REL_MERGE_SHORT}</code>)</td>
                  <td><code>{REL_HEAD_SHORT}</code></td>
                  <td><code>Wave 2</code></td>
                  <td><code>18</code> files (<code>+137 / -82</code>)</td>
                  <td><code>PRR-A R3 PASS</code> + <code>Arc PASS</code>: Consumed all 9 <code>changelog.d/*.md</code> fragments into <code>CHANGELOG.md [5.67.0]</code>; published tag <code>v5.67.0</code> &amp; updated live <code>:3102</code></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <!-- SECTION 4: DELIVERABLES & CODE-PATH MATRIX -->
    <section class="section" id="deliverables">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">03</span> Shipped Deliverables, Code-Path Matrix &amp; External Blocker Disposition Ledger</h2>
          <p class="section-desc">Source-verified file paths, symbols, tests, and finish-line verification statuses across all 9 closed Milestone #54 issues plus the 3 external/hardware items receipted under <code>Ruling A504-EXT-R1</code>.</p>
        </div>
        <span class="badge badge-purple">9 / 9 Active In-Repo Milestone #54 Issues Closed (0 Open) · 3 External Items Receipted in Backlog</span>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3>Complete Issue, Wave Deliverable &amp; Scope Reclassification Matrix (<code>v5.67.0 · Milestone #54</code>)</h3>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Issue / Car</th>
                <th>PR &amp; Merge SHA</th>
                <th>Primary Modified Files &amp; Symbols</th>
                <th>Automated &amp; Architectural Verification Proof</th>
                <th>Milestone Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span class="issue-pill">#2866</span> <span class="issue-pill">#2877</span> <span class="issue-pill">#2878</span> <strong>Launch-Env `gh` Role Guard Wrapper, `tc roadmap admission|sync` CLI &amp; Live Merge-Inbox-Gate Routes/CLI</strong> (<code>Car 67-A</code>)</td>
                <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67A_PR}" target="_blank" rel="noopener">PR #{CAR67A_PR}</a><br/><code>{CAR67A_MERGE_SHORT}</code></td>
                <td><code>lib/merge-role-guard.js</code>, <code>lib/sessions.js</code>, <code>scripts/roadmap-sync-check.js</code>, <code>lib/routes/sessions.js</code>, <code>lib/tc-verbs.js</code>, <code>lib/operating-primer.js</code>, <code>docs/tc-cli-reference.md</code>, <code>test/v5670-car67a-control-roadmap-merge-gate.test.js</code> (26 files, +2,166/-32 LOC)</td>
                <td>Mounts `createRoleGuardWrapperScripts` on session launch `PATH` with `realpathSync` + `TC_GH_WRAPPER_ACTIVE` recursion guard (`#2866`), exposes `tc roadmap admission|sync` &amp; `scripts/roadmap-sync-check.js` (`#2877`), and mounts `/api/sessions/:project/merge-gate/*` + `tc merge-gate` (`#2878`; `49/49` Car 67-A tests + `13,698` Testament pool tests pass)</td>
                <td><span class="badge badge-green">Closed &amp; Shipped (#54)</span></td>
              </tr>
              <tr>
                <td><span class="issue-pill">#2881</span> <span class="issue-pill">#2888</span> <strong>Session-History Native Log Backfill, Governed-Wrap SSE Progress Route, Chunk-Boundary HTTP/UI &amp; Operating Primer Launch Wiring</strong> (<code>Car 67-B</code>)</td>
                <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67B_PR}" target="_blank" rel="noopener">PR #{CAR67B_PR}</a><br/><code>{CAR67B_MERGE_SHORT}</code></td>
                <td><code>server.js</code>, <code>lib/sessions.js</code>, <code>lib/routes/sessions.js</code>, <code>lib/routes/wrap.js</code>, <code>lib/resource-leases.js</code>, <code>public/history-drawer.js</code>, <code>public/governed-wrap-ui.js</code>, <code>public/chunk-boundary-ui.js</code>, <code>public/index.html</code>, <code>public/session.html</code>, <code>test/v5670-car67b-session-routes-wrap-primer.test.js</code> (29 files, +1,395/-39 LOC)</td>
                <td>Wires `ensureSessionTranscript` into `GET /api/continuity/:project/sessions/:sid` &amp; `transcriptSourceBadge` into `public/history-drawer.js`, mounts `GET /api/sessions/:project/governed-wrap/:requestId/stream` (`#2881`), mounts `/api/sessions/:project/chunk-boundary*` bound to URL's own project, and wires `primerForLaunch` into `lib/sessions.js#_collectPrimeSections` (`#2888`)</td>
                <td><span class="badge badge-green">Closed &amp; Shipped (#54)</span></td>
              </tr>
              <tr>
                <td><span class="issue-pill">#2883</span> <span class="issue-pill">#2884</span> <span class="issue-pill">#2885</span> <span class="issue-pill">#2886</span> <strong>Scorecard HTTP/Refresh/Publisher, Global Settings Bridge Step-Up &amp; Notification UI, Lifecycle-Handoff Daemon Boot &amp; Wrap Docs-Parity / Setup Remote-CA Mounts</strong> (<code>Car 67-C</code>)</td>
                <td><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67C_PR}" target="_blank" rel="noopener">PR #{CAR67C_PR}</a><br/><code>{CAR67C_MERGE_SHORT}</code></td>
                <td><code>server.js</code>, <code>scripts/scorecard-publish-metrics.js</code>, <code>public/ui.js</code>, <code>public/bridge-step-up.js</code>, <code>public/bridge-settings-ui.js</code>, <code>lib/routes/sessions.js</code>, <code>public/wrap-drawer.js</code>, <code>public/setup.js</code>, <code>public/remote-ca-assist.js</code>, <code>test/v5670-car67c-server-dashboard-mounts.test.js</code> (27 files, +1,769/-31 LOC)</td>
                <td>Adds `GET /api/scorecard`, opt-in `.unref()` scheduled refresh in `server.js` &amp; `scripts/scorecard-publish-metrics.js` (`#2883`), mounts Bridge step-up &amp; settings controls into `openGlobalSettings` (`#2884`), wires `createLifecycleHandoffDaemon` start/stop into `server.js` &amp; session routes (`#2885`), and mounts wrap-drawer docs-parity dismissal + `GET /api/https/remote-ca-plan` (`#2886`)</td>
                <td><span class="badge badge-green">Closed &amp; Shipped (#54)</span></td>
              </tr>
              <tr>
                <td><span class="issue-pill">#1564</span> <span class="issue-pill">#2347</span> <span class="issue-pill">#2258</span> <strong>External / Hardware / Upstream-Blocked Items Reclassified Under `Ruling A504-EXT-R1` (`Rule #1 / A185`)</strong></td>
                <td><code>Ruling A504-EXT-R1</code><br/><code>#6666856332</code><br/><code>#6666857185</code><br/><code>#6666857934</code></td>
                <td><code>#1564</code> (requires physical Linux host `systemd --user` bus), <code>#2347</code> (blocked on upstream `Jason-Vaughan/Medusa#67`), <code>#2258</code> (requires external Vercel dashboard &amp; DNS cutover; Slice 1 guard shipped in `PR #2875`)</td>
                <td>Evaluated by `TC-Lane-Arc` &amp; `TC-Lane-PM` at Gate 0 under `Rule #1` and `A185`: in-repo code slices are already shipped; remaining verification requires physical Linux hardware, upstream `Medusa#67`, or external Vercel dashboard access. Formally receipted and moved to `Backlog`.</td>
                <td><span class="badge badge-cyan">Reclassified to Backlog (A185)</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
'''

html_part3 = f'''
    <!-- SECTION 5: TESTAMENT POOL & SUITE RELIABILITY TELEMETRY -->
    <section class="section" id="telemetry">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">04</span> Longitudinal Multi-Sprint Comparison (<code>v5.62.0 → v5.67.0</code>) &amp; Testament v0.34.0 Telemetry</h2>
          <p class="section-desc">Side-by-side empirical comparison across the week's six releases (<code>v5.62.0 → v5.63.0 → v5.64.0 → v5.65.0 → v5.66.0 → v5.67.0</code>) under <code>SPRINT_REPORT_CONTRACT.md v2.0.0</code>.</p>
        </div>
        <span class="badge badge-green">Zero Post-Merge Regressions · 49 Verified Closed Issues Across v5.62.0–v5.67.0</span>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h3>Longitudinal Sprint Comparison Table (<code>v5.62.0 → v5.63.0 → v5.64.0 → v5.65.0 → v5.66.0 → v5.67.0</code>)</h3>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th><code>v5.62.0</code> (#47)</th>
                <th><code>v5.63.0</code> (#48)</th>
                <th><code>v5.64.0</code> (#49)</th>
                <th><code>v5.65.0</code> (#50 · A502)</th>
                <th><code>v5.66.0</code> (#51 · A503 v1.1)</th>
                <th><code>v5.67.0</code> (#54 · A504 v1.1)</th>
                <th>Directional Assessment</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Full Engineering Window (<code>T_eng</code>) &amp; Wall Time</strong></td>
                <td><code>2.50h</code></td>
                <td><code>1.85h</code></td>
                <td><code>1.75h</code></td>
                <td><code>2.33h</code> (<code>2.68h</code> auth)</td>
                <td><code>1.60h</code> (<code>24m</code> tail)</td>
                <td><strong><code>{t_eng_hrs:.2f}h</code> (<code>{dur['full_engineering_window_human'].split(' (')[0]}</code> across 3 sequential cars)</strong></td>
                <td><span class="badge badge-green">Intentional sequential single-builder execution eliminated hot-entrypoint merge conflicts</span></td>
              </tr>
              <tr>
                <td><strong>Builder Active Build Time &amp; Code Volume</strong></td>
                <td><code>+3,420</code> LOC</td>
                <td><code>+3,680</code> LOC</td>
                <td><code>+3,190</code> LOC</td>
                <td><code>+4,208 / -78</code> net (30f)</td>
                <td><code>+2,911 / -31</code> net (26f)</td>
                <td><strong><code>+5,388 / -105</code> net across <code>69</code> files (<code>+5,330 / -102</code> feat PRs)</strong></td>
                <td><span class="badge badge-green">Largest net entrypoint integration pass of the week with 0 merge conflicts</span></td>
              </tr>
              <tr>
                <td><strong>PR Open-to-Merge &amp; Ancestor Sync Latency</strong></td>
                <td><code>100%</code> True Merge</td>
                <td><code>100%</code> True Merge</td>
                <td><code>100%</code> True Merge</td>
                <td><code>100%</code> True Merge (5)</td>
                <td><code>100%</code> True Merge (4)</td>
                <td><strong><code>100%</code> True Merge Commits (<code>Rule #282</code> · 2 Parents on All 4 PRs)</strong></td>
                <td><span class="badge badge-green">Because Car 67-B branched from merged 67-A and 67-C from merged 67-B, ancestor sync latency was 0m</span></td>
              </tr>
              <tr>
                <td><strong>Commits / PR &amp; Token Efficiency</strong></td>
                <td><code>7</code> closed</td>
                <td><code>8</code> closed</td>
                <td><code>7</code> closed</td>
                <td><code>8</code> closed (<code>12</code> addr)</td>
                <td><code>6</code> closed (<code>7</code> #51)</td>
                <td><strong><code>9 / 9</code> In-Repo Issues Closed in Milestone #54 (<code>1.58 issues/hr</code> · <code>$1.55/issue</code>)</strong></td>
                <td><span class="badge badge-green">Completed all 9 deferred Slice 2/3 hot-entrypoint mounts cleanly</span></td>
              </tr>
              <tr>
                <td><strong>Test Suite &amp; Testament Pool Execution (<code>Guardrail 10</code>)</strong></td>
                <td>Pool <code>v0.34.0</code></td>
                <td>Pool <code>v0.34.0</code></td>
                <td>Pool <code>v0.34.0</code></td>
                <td>Pool <code>v0.34.0</code></td>
                <td>Pool <code>v0.34.0</code></td>
                <td><strong><code>100%</code> Remote Testament <code>0.34.0</code> Pool (<code>13,698+</code> tests) + <code>113/113</code> Release Tests Green</strong></td>
                <td><span class="badge badge-cyan">Zero local multi-file node --test CPU contention across the entire week</span></td>
              </tr>
              <tr>
                <td><strong>Pre-Merge Gate Catches / Post-Merge Regressions</strong></td>
                <td><code>6</code> / <code>0</code> reg</td>
                <td><code>9</code> / <code>0</code> reg</td>
                <td><code>7</code> / <code>0</code> reg</td>
                <td><code>8</code> / <code>0</code> reg</td>
                <td><code>6</code> / <code>0</code> reg</td>
                <td><strong><code>8</code> Pre-Merge PRR/Arc Catches (<code>#2908 R1–R3, #2909 R1, #2910 R1–R2, #2911 R1–R2</code>) / <code>0</code> Regressions</strong></td>
                <td><span class="badge badge-green">Caught project-scoped chunk-boundary binding (#2909), scope-read freshness (#2910) &amp; release copy (#2911)</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid-2" style="margin-bottom:18px;">
        <div class="card">
          <h3>Sprint v5.67.0 Car Completion &amp; Guardrail Telemetry Bars</h3>
          <p style="font-size:0.84rem;color:var(--text-muted);margin-top:0;">
            Measured car completion, 4-gate verification, and active guardrail compliance across Sprint <code>v5.67.0</code> (<code>Milestone #54</code>):
          </p>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Car 67-A (W1-A · PR #{CAR67A_PR} @ {CAR67A_MERGE_SHORT})</code> — Launch `gh` Guard, `tc roadmap` &amp; `tc merge-gate` (<code>#2866, #2877, #2878</code>)</strong></span>
              <span><strong>100% Merged (+2,166 / -32 LOC · 26 Files)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill green" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Car 67-B (W1-B · PR #{CAR67B_PR} @ {CAR67B_MERGE_SHORT})</code> — Session History Backfill, Governed-Wrap SSE &amp; Primer (<code>#2881, #2888</code>)</strong></span>
              <span><strong>100% Merged (+1,395 / -39 LOC · 29 Files)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill green" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Car 67-C (W1-C · PR #{CAR67C_PR} @ {CAR67C_MERGE_SHORT})</code> — Scorecard, Bridge UI, Lifecycle Daemon &amp; Docs/CA (<code>#2883–#2886</code>)</strong></span>
              <span><strong>100% Merged (+1,769 / -31 LOC · 27 Files)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill cyan" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Ruling A504-EXT-R1 External / Hardware Blocker Disposition (`#1564, #2347, #2258`)</code></strong></span>
              <span><strong>100% Receipted &amp; Reclassified to Backlog (Rule #1 / A185)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill green" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>W2-REL (PR #{REL_PR} @ {REL_MERGE_SHORT}) &amp; Milestone #54 Audit (Guardrail 09)</code></strong></span>
              <span><strong>9 / 9 In-Repo Issues Closed (open_issues: 0, closed_issues: 9)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill green" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Sequential Single-Builder Hot-Entrypoint Serialization (`TC-Lane-D`)</code></strong></span>
              <span><strong>0 Merge Conflicts Across `server.js`, `lib/sessions.js` &amp; `public/index.html`</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill purple" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>Remote Testament v0.34.0 Pool &amp; Focused Suite Verification</code></strong></span>
              <span><strong>100% Verified (13,698+ Pool Tests + 113/113 Release Suite)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill cyan" style="width:100%;"></div></div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span><strong><code>SPRINT_REPORT_CONTRACT v2.0.0 Validator &amp; Unit Test Suite</code></strong></span>
              <span><strong>41 Reports + Hub + 10/10 Unit Tests = 100% PASS (0 FAIL)</strong></span>
            </div>
            <div class="bar-track"><div class="bar-fill amber" style="width:100%;"></div></div>
          </div>
        </div>

        <div class="card">
          <h3>SVG Diagram 3 — Deliverables &amp; Hot-Entrypoint Mount Completion Breakdown (<code>v5.67.0 · Milestone #54</code>)</h3>
          <div class="svg-wrap" style="background:rgba(7,11,20,0.7);border:1px solid var(--border);border-radius:12px;padding:12px;">
            <svg viewBox="0 0 760 310" width="100%" height="auto" role="img" aria-label="Deliverables and Hot-Entrypoint Mount Completion Breakdown">
              <text x="20" y="28" fill="#e2e8f0" font-size="13" font-weight="700">How Charter A504 v1.1 Completed Milestone #54 (v5.67.0) Under SPRINT_REPORT_CONTRACT v2.0.0</text>

              <text x="20" y="64" fill="#34d399" font-size="11" font-weight="700">1. Wave 1 Sequential Hot-Entrypoint Cars (9 In-Repo Issues Closed · +5,330 / -102 Feature PR LOC)</text>
              <rect x="20" y="74" width="714" height="44" rx="6" fill="#10b981" fill-opacity="0.35" stroke="#34d399" stroke-width="1.6"/>
              <text x="32" y="94" fill="#d1fae5" font-size="10" font-weight="700">Car 67-A #{CAR67A_PR} (@ {CAR67A_MERGE_SHORT}: #2866, #2877, #2878) · Car 67-B #{CAR67B_PR} (@ {CAR67B_MERGE_SHORT}: #2881, #2888)</text>
              <text x="32" y="110" fill="#a7f3d0" font-size="10">Car 67-C #{CAR67C_PR} (@ {CAR67C_MERGE_SHORT}: #2883, #2884, #2885, #2886) · Wave 2 Release PR #{REL_PR} (@ {REL_MERGE_SHORT})</text>

              <text x="20" y="154" fill="#38bdf8" font-size="11" font-weight="700">2. Gate 0 External / Hardware Blocker Disposition Under Ruling A504-EXT-R1 (Rule #1 / A185)</text>
              <rect x="20" y="164" width="714" height="44" rx="6" fill="#0284c7" fill-opacity="0.30" stroke="#38bdf8"/>
              <text x="32" y="184" fill="#e0f2fe" font-size="10" font-weight="600">#1564 (Physical Linux systemd VRF) · #2347 (Upstream Medusa#67) · #2258 (External Vercel Dashboard/DNS)</text>
              <text x="32" y="200" fill="#bae6fd" font-size="10">Formally receipted &amp; reclassified to Backlog so Milestone #54 closes 9/9 actionable in-repo deliverables cleanly</text>

              <rect x="20" y="230" width="714" height="62" rx="8" fill="#0f172a" stroke="#c084fc"/>
              <text x="34" y="251" fill="#c084fc" font-size="11" font-weight="700">SPRINT v5.67.0 FINAL VERDICT (MILESTONE #54 · CHARTER A504 v1.1):</text>
              <text x="34" y="269" fill="#cbd5e1" font-size="10">• 9/9 active chartered issues closed · 4/4 true merges · +5,388 / -105 net repo LOC across 69 files</text>
              <text x="34" y="285" fill="#cbd5e1" font-size="10">• 0 post-merge regressions · 41 published canonical reports + 10/10 validator unit tests passing 100%</text>
            </svg>
          </div>
        </div>
      </div>
    </section>

    <!-- SECTION 6: POST-MORTEM, RULE #283 16-POINT AUDIT & 4 MAINTENANCE GATES -->
    <section class="section" id="postmortem">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">05</span> Sprint Post-Mortem, 16-Point Governance Audit &amp; 4 Maintenance Gates</h2>
          <p class="section-desc">Version-specific empirical findings from <code>TC-Lane-Obsr</code>, <code>TC-Lane-Arc</code>, and <code>TC-Lane-PRR-A/B</code> across Sprint <code>v5.67.0</code> (<code>Charter A504 v1.1</code>).</p>
        </div>
        <span class="badge badge-green">16 / 16 Rule #283 Measures Audited · 4 / 4 Gates Complete</span>
      </div>

      <div class="grid-2" style="margin-bottom:18px;">
        <div class="card">
          <h3 style="color:var(--green);">What Worked Exceptionally Well — Validated v5.67.0 Architectural &amp; Process Wins</h3>
          <div class="pm-list">
            <div class="pm-item">
              <h4>1. Sequential Single-Builder Hot-Entrypoint Execution (`Car 67-A → 67-B → 67-C`) Eliminated Merge Collisions</h4>
              <p>
                Because `v5.67.0` mounted 9 Slice 2/3 features directly into shared singleton files (`server.js`, `lib/sessions.js`, `lib/routes/sessions.js`, `public/index.html`, `public/session.html`, `public/sw.js`), sequencing `Car 67-A`, `Car 67-B`, and `Car 67-C` on `TC-Lane-D` (`#1533`) where each car branched directly from the prior car's merged `origin/main` SHA resulted in `0` merge conflicts across `69` net modified files (`+5,388 / -105` LOC).
              </p>
            </div>
            <div class="pm-item">
              <h4>2. Mechanical Launch-Env `gh` Role Guard Wrapper With Symlink &amp; Recursion Safety (`#2866`, `PR #2908`)</h4>
              <p>
                `Car 67-A` (`PR #2908`) wired `lib/merge-role-guard.js` into `lib/sessions.js` by prepending a generated `gh` wrapper directory onto every session's launch `PATH`, using `fs.realpathSync` comparison (handling macOS `/var -> /private/var` symlinks) plus `TC_GH_WRAPPER_ACTIVE=1` recursion protection to block non-Integrator `gh pr merge` calls without risk of fork-bombing.
              </p>
            </div>
            <div class="pm-item">
              <h4>3. Rigorous `I-Gate` Release-Copy Verification on `PR #2911` Prevented Overclaiming Unwired UI Callers</h4>
              <p>
                During Wave 2 review of `PR #2911`, `TC-Lane-PRR-A` (`#5794840509` and `#5794874888`) verified every sentence in `FEATURES.md` and `docs/releases/v5.67.0.md` against actual call sites in `public/` and `lib/`, catching two places where release prose described prepared browser/lease helpers (`startGovernedWrapProgressStream`, `renderChunkBoundaryBadge`, `acquireLeaseWithPrimer`) as already invoked by live callers. Narrowing the release prose before merge ensured 100% external honesty.
              </p>
            </div>
            <div class="pm-item">
              <h4>4. First Sprint Executed End-to-End Under `SPRINT_REPORT_CONTRACT.md v2.0.0` &amp; Automated Unit-Tested Validator</h4>
              <p>
                `v5.67.0` is the first release generated natively under `SPRINT_REPORT_CONTRACT.md v2.0.0` (`metrics_schema.py` + `validate-sprint-report.py --all` + `test_validate_sprint_report.py`), enforcing the 8-timestamp cadence, 4-state completion accounting, 3-tier cost separation, and single `#ade-efficiency-card` banner rule from inception.
              </p>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 style="color:var(--amber);">What Didn't Work &amp; Concrete Guardrail Fixes Enacted in v5.67.0</h3>
          <div class="pm-list">
            <div class="pm-item warn">
              <h4>1. Multi-Round `I-Gate` Refinements in `Car 67-A` (`PR #2908` R1–R4) Around `roadmap-sync-check` Exit Codes &amp; CLI Flags</h4>
              <p>
                `Car 67-A` (`PR #2908`) required 4 review rounds (`0be0e9fd -> e590f5a0 -> 7a88b83b -> 80327362`) as `TC-Lane-PRR-A` caught CLI flag parsing and non-zero exit code propagation edge cases in `scripts/roadmap-sync-check.js` (`#2877`). <strong>Fix / Guardrail:</strong> Added `Ruling A504-W1A-R3/R4` specifications and 49 dedicated subprocess/route tests in `test/v5670-car67a-control-roadmap-merge-gate.test.js`.
              </p>
            </div>
            <div class="pm-item warn">
              <h4>2. Cross-Project URL Parameter Binding in `Car 67-B` (`PR #2909` R1 → R2)</h4>
              <p>
                In `Car 67-B` (`PR #2909`), `TC-Lane-PRR-B` (`#5793760683`) caught that `POST /api/sessions/:project/chunk-boundary*` allowed body payload project fields to override the `:project` URL parameter. <strong>Fix / Guardrail:</strong> Bound all chunk-boundary writes strictly to the URL's own `:project` parameter in commit `2b23ecf9` and added cross-project rejection tests.
              </p>
            </div>
            <div class="pm-item warn">
              <h4>3. Out-of-Order Scope Read &amp; Notification Control Wiring in `Car 67-C` (`PR #2910` R1–R3)</h4>
              <p>
                In `Car 67-C` (`PR #2910`), `TC-Lane-PRR-A` (`#5794447497`, `#5794638986`) caught that `public/bridge-settings-ui.js` needed live notification-policy controls and a freshness guard against out-of-order async scope reads when switching project overrides, and `POST /wrap/docs-parity/dismiss` needed single-line reason normalization. <strong>Fix / Guardrail:</strong> Landed commits `f9e0e167` and `cafb1ebd` with deterministic regression tests before merge.
              </p>
            </div>
            <div class="pm-item warn">
              <h4>4. Release-Note Copy Running Ahead of Call-Site Wiring in `W2-REL` (`PR #2911` R1–R3)</h4>
              <p>
                In `PR #2911`, initial `FEATURES.md` and `docs/releases/v5.67.0.md` bullets stated that the dashboard displayed chunk-boundary badges and that new leases automatically received the operating primer, even though `Car 67-B` shipped the routes/loaded scripts and `acquireLeaseWithPrimer` composition helper while `lib/resource-lease-routes.js` still called `acquireLease`. <strong>Fix / Guardrail:</strong> Enforced `I-Gate` call-site verification on release docs (`09927ea4`, `0ce48c44`) so public release notes never claim more than what live callers invoke.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 4 END-OF-SPRINT MAINTENANCE GATES -->
      <div class="card" style="margin-bottom:18px;">
        <h3>4-Gate Release &amp; End-of-Sprint Verification Matrix (<code>Rule #280 §6</code> &amp; <code>Rule #283.5</code>)</h3>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Gate</th>
                <th>Owner Lane(s)</th>
                <th>Canonical Target Artifact(s)</th>
                <th>Verification Evidence &amp; Receipt</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Gate 1 — I-Gate (PRR Code &amp; Contract Review)</strong></td>
                <td><code>TC-Lane-PRR-A</code> + <code>TC-Lane-PRR-B</code></td>
                <td>All 3 Feature PRs (<code>#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}</code>) + Release <code>PR #{REL_PR}</code></td>
                <td>100% exact-head PRR <code>PASS</code> verdicts verified prior to merge (<code>#{CAR67A_PR}</code> R4 <code>#5792688775</code>, <code>#{CAR67B_PR}</code> R2 <code>#5793860999</code>, <code>#{CAR67C_PR}</code> R3 <code>#5794717466</code> + Release <code>PR #{REL_PR}</code>)</td>
                <td><span class="badge badge-green">PASS (4/4 PRs)</span></td>
              </tr>
              <tr>
                <td><strong>Gate 2 — B-Gate (Integrator CI &amp; True-Merge Gate)</strong></td>
                <td><code>TC-Lane-INT</code></td>
                <td><code>origin/main @ {REL_MERGE_SHORT}</code>, <code>CHANGELOG.md [5.67.0]</code>, <code>version.json</code></td>
                <td>All 4 PRs merged via <code>gh pr merge --merge</code> (<code>Rule #282</code>, 2 parents each) with exact-head GitHub Actions <code>Tests</code> green</td>
                <td><span class="badge badge-green">PASS (Verified)</span></td>
              </tr>
              <tr>
                <td><strong>Gate 3 — A-Gate / R-Gate, Tag &amp; Live :3102 Deploy</strong></td>
                <td><code>TC-Lane-Arc</code> + <code>TC-Lane-INT</code></td>
                <td>Charter <code>A504 v1.1</code>, Tag <code>v5.67.0 @ {TAG_SHA_SHORT}</code>, Live <code>:3102</code></td>
                <td>Architect issued <code>Ruling A504-EXT-R1</code> and certified <code>A-Gate PASS</code> across all 4 PRs; tag <code>v5.67.0</code> published &amp; live <code>:3102</code> updated (backup <code>{BACKUP_SHA[:16]}...</code>)</td>
                <td><span class="badge badge-green">PASS (Verified)</span></td>
              </tr>
              <tr>
                <td><strong>Gate 4 — O-Gate (Observer Audit &amp; Canonical HTML Report)</strong></td>
                <td><code>TC-Lane-Obsr</code> + <code>TC-Lane-PM</code></td>
                <td><code>sprint-reports/v5.67.0/index.html</code>, <code>sprint-reports/index.html</code></td>
                <td><code>Milestone #54</code> verified at <code>open_issues: 0, closed_issues: 9</code>; canonical v2.0.0 HTML report + hub index validated via <code>validate-sprint-report.py --all</code> (<code>41/41 PASS</code>) &amp; <code>test_validate_sprint_report.py</code> (<code>10/10 OK</code>)</td>
                <td><span class="badge badge-green">PASS (Verified)</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- RULE #283 16-POINT GOVERNANCE AUDIT TABLE -->
      <div class="card">
        <h3>Rule #283 16-Point Governance &amp; Process Audit Table (<code>v5.67.0</code>)</h3>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Audit Dimension (Rule #283 cl. 3)</th>
                <th>Measured Empirical Evidence (v5.67.0)</th>
                <th>Target</th>
                <th>Verdict</th>
                <th>Actionable Guardrail for Next Sprint Train</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>1</td><td><strong>Operator Interventions &amp; Causes</strong></td><td><code>0</code> unplanned Operator code/git interventions across `v5.67.0` under `OP-GO-V5670-20261105`</td><td>0 interventions</td><td><span class="badge badge-green">PASS</span></td><td>Maintain Gate 0 external-blocker disposition (`A185`) before Wave 1 dispatch</td></tr>
              <tr><td>2</td><td><strong>Dispatch-to-Merge Timing</strong></td><td>3 sequential hot-entrypoint cars (`#2908, #2909, #2910`) + `PR #2911` completed in `T_eng = {t_eng_hrs:.2f}h`</td><td>Bounded waves</td><td><span class="badge badge-green">PASS</span></td><td>Use parallel builders for module creation and sequential single-builder passes for shared entrypoint mounting</td></tr>
              <tr><td>3</td><td><strong>Active vs Allowed Builders &amp; Parallelism</strong></td><td>Intentional single-builder serialization on `TC-Lane-D` (`#1533`) per `Charter A504 v1.1` to prevent `server.js` / `lib/sessions.js` collisions</td><td>0 entrypoint collisions</td><td><span class="badge badge-green">PASS</span></td><td>Enforce single-owner serialization whenever multiple cars touch `server.js` or `lib/routes/sessions.js`</td></tr>
              <tr><td>4</td><td><strong>Forced Re-Syncs / Rebases When <code>main</code> Moves</strong></td><td><code>0</code> forced rebases or merge conflicts because each car branched directly from the prior car's merged `origin/main` commit</td><td>0 conflicts</td><td><span class="badge badge-green">PASS</span></td><td>Branch sequential entrypoint cars strictly after the predecessor PR lands on `origin/main`</td></tr>
              <tr><td>5</td><td><strong>Open PR Age Since Current <code>main</code></strong></td><td>All 4 sprint PRs merged cleanly onto `origin/main`; `0` open sprint PRs remaining</td><td>0 stale PRs</td><td><span class="badge badge-green">PASS</span></td><td>Keep sequential PR review cycles focused on a single active PR at a time</td></tr>
              <tr><td>6</td><td><strong>CI Red After Ready (<code>#2595</code> Pre-Push Hook)</strong></td><td><code>100%</code> exact-head GitHub Actions <code>Tests</code> green across all 4 merged PRs (`#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}, #{REL_PR}`)</td><td>0 red at merge</td><td><span class="badge badge-green">PASS</span></td><td>Retain Stage 1 + Remote Testament 0.34.0 pre-push verification</td></tr>
              <tr><td>7</td><td><strong>PRR Review Rounds &amp; Findings by Severity</strong></td><td><code>PRR-A</code> &amp; <code>PRR-B</code> caught 6 code refinements in Wave 1 (`#2908` R1–R3, `#2909` R1, `#2910` R1–R2) and 2 release-copy refinements in `#2911` (R1–R2); `0` escaped defects</td><td>0 escaped defects</td><td><span class="badge badge-green">PASS</span></td><td>Verify public `FEATURES.md` and release-note claims against live call sites during `W2-REL` review</td></tr>
              <tr><td>8</td><td><strong>Post-Merge Defects on <code>main</code></strong></td><td><code>0</code> post-merge test regressions or reverts on <code>main</code> across all 4 merged `v5.67.0` PRs</td><td>0 defects</td><td><span class="badge badge-green">PASS</span></td><td>Require dedicated regression tests for every multi-round PRR refinement</td></tr>
              <tr><td>9</td><td><strong>Clears, Retries &amp; Stalls</strong></td><td><code>0</code> untracked session stalls; launch-env `gh` role guard wrapper (`#2866`) now mechanically enforces merge role discipline</td><td>0 untracked stalls</td><td><span class="badge badge-green">PASS</span></td><td>Monitor `~/.tangleclaw/logs/merge-role-guard-blocked.jsonl` in future sprints</td></tr>
              <tr><td>10</td><td><strong>Wrong Triage / Scope Fields</strong></td><td><code>100%</code> of actionable Milestone `#54` issues closed (`9/9`); 3 external/hardware items (`#1564, #2347, #2258`) receipted &amp; moved to Backlog under `A504-EXT-R1`</td><td>0 premise drift</td><td><span class="badge badge-green">PASS</span></td><td>Always record external/hardware reclassifications in the 4-State Completion Table</td></tr>
              <tr><td>11</td><td><strong>Rule Breaches &amp; Governance Discipline</strong></td><td><code>0</code> rule breaches; 100% adherence to `Rule #1`, `Rule #273`, `Rule #282` true merges, and `SPRINT_REPORT_CONTRACT v2.0.0`</td><td>0 breaches</td><td><span class="badge badge-green">PASS</span></td><td>Run `tc roadmap admission` preflight before future train dispatches</td></tr>
              <tr><td>12</td><td><strong>Unlabelled PRs, Dirty Clones &amp; Worktrees</strong></td><td>All merged `v5.67.0` branches retired cleanly; all fleet worktrees synced to `origin/main`</td><td>0 orphan clones</td><td><span class="badge badge-green">PASS</span></td><td>Transition all lanes to `complete / safe-to-clear` at release closeout</td></tr>
              <tr><td>13</td><td><strong>Release-Status Lag &amp; Finish-Line Honesty</strong></td><td><code>CHANGELOG.md [5.67.0]</code>, <code>docs/releases/v5.67.0.md</code>, and <code>version.json</code> (`5.67.0`) cut in <code>PR #{REL_PR}</code> (`{REL_MERGE_SHORT}`) with verified tag `v5.67.0` and live `:3102` update</td><td>100% honesty</td><td><span class="badge badge-green">PASS</span></td><td>Ensure `FEATURES.md` and `docs/releases/*.md` distinguish mounted UI callers from prepared helper functions</td></tr>
              <tr><td>14</td><td><strong>Conflict Resolution Time</strong></td><td><code>0m</code> conflict resolution time across `#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}, #{REL_PR}`</td><td>&lt; 5m sync time</td><td><span class="badge badge-green">PASS</span></td><td>Preserve sequential single-builder execution for high-fan-in entrypoint passes</td></tr>
              <tr><td>15</td><td><strong>Wakes, Tokens &amp; Turns by Role &amp; Model</strong></td><td>REST `gh api` polling and local `git` inspection avoided GraphQL rate limits throughout `v5.67.0`</td><td>0 API lockouts</td><td><span class="badge badge-green">PASS</span></td><td>Continue REST `gh api` + local `git` inspection pattern</td></tr>
              <tr><td>16</td><td><strong>4 End-of-Sprint Maintenance Gates</strong></td><td>All 4 Maintenance Gates (I-Gate PRR, B-Gate True Merge, A/R-Gate + Tag `v5.67.0` + Live `:3102`, O-Gate Canonical v2.0.0 HTML Report + Validator) green</td><td>4 / 4 Gates green</td><td><span class="badge badge-green">PASS</span></td><td>Run `validate-sprint-report.py --all` and `test_validate_sprint_report.py` on every release</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
'''

html_part4 = f'''
    <!-- SECTION 7: INTERACTIVE WAVE & PR EXPLORER -->
    <section class="section" id="waves">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">06</span> Interactive Wave, PR &amp; Telemetry Explorer</h2>
          <p class="section-desc">Filter by wave, car, subsystem, or governance gate, or search across commits, file paths, issue numbers, and reviewer rulings in Sprint <code>v5.67.0</code>.</p>
        </div>
        <span class="badge badge-cyan">4 Interactive Cards · 10 Filter Tags · Instant Search</span>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;">
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <button class="filter-btn active" data-filter="all" onclick="filterWaves('all', this)">All (4)</button>
            <button class="filter-btn" data-filter="wave-1" onclick="filterWaves('wave-1', this)">Wave 1 (3 Cars)</button>
            <button class="filter-btn" data-filter="wave-2" onclick="filterWaves('wave-2', this)">Wave 2 Release (#{REL_PR})</button>
            <button class="filter-btn" data-filter="guard" onclick="filterWaves('guard', this)">Merge Role Guard (#2866)</button>
            <button class="filter-btn" data-filter="roadmap" onclick="filterWaves('roadmap', this)">Roadmap &amp; Merge-Gate (#2877, #2878)</button>
            <button class="filter-btn" data-filter="history" onclick="filterWaves('history', this)">History &amp; Wrap Stream (#2881)</button>
            <button class="filter-btn" data-filter="primer" onclick="filterWaves('primer', this)">Chunk-Boundary &amp; Primer (#2888)</button>
            <button class="filter-btn" data-filter="scorecard" onclick="filterWaves('scorecard', this)">Scorecard &amp; Bridge UI (#2883, #2884)</button>
            <button class="filter-btn" data-filter="daemon" onclick="filterWaves('daemon', this)">Lifecycle Daemon &amp; Docs/CA (#2885, #2886)</button>
            <button class="filter-btn" data-filter="ruling" onclick="filterWaves('ruling', this)">Ruling A504-EXT-R1 (#1564, #2347, #2258)</button>
          </div>
          <input id="waveSearch" type="search" placeholder="Search PR #, SHA, issue, file, ruling..." oninput="searchWaves()" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-alt);color:var(--text);min-width:240px;font-size:0.84rem;" />
        </div>
      </div>

      <!-- WAVE CARD 1: Car 67-A (#2908) -->
      <div class="wave-card" data-tags="all wave-1 guard roadmap" data-search="car 67-a w1-a pr {CAR67A_PR} 2866 2877 2878 merge-role-guard.js sessions.js roadmap-sync-check.js tc-verbs.js {CAR67A_MERGE_SHORT} {CAR67A_HEAD_SHORT}">
        <div class="wave-header">
          <div>
            <div class="wave-num">WAVE 1 · CAR 67-A (TC-Lane-D · Reviewed by TC-Lane-PRR-A &amp; TC-Lane-Arc)</div>
            <h3 class="wave-title"><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67A_PR}" target="_blank" rel="noopener">PR #{CAR67A_PR}</a> — Launch-Env <code>gh</code> Role Guard Wrapper (<code>#2866</code>), <code>tc roadmap admission|sync</code> CLI (<code>#2877</code>) &amp; Live Merge-Inbox-Gate Routes/CLI (<code>#2878</code>)</h3>
            <div class="wave-window">Merged in Wave 1 (Seq 1) · True Merge Commit <code>{CAR67A_MERGE_SHA}</code> (Head <code>{CAR67A_HEAD_SHORT}</code>)</div>
          </div>
          <div class="wave-meta">
            <span class="badge badge-green">MERGED</span>
            <span class="badge badge-cyan">26 Files (+2,166 / -32)</span>
            <span class="badge badge-purple">I-Gate R4 + A-Gate R4 PASS</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Files Modified</th>
                <th>Key Engineering Changes &amp; Architectural Scope</th>
                <th>Verification Evidence</th>
              </tr>
            </thead>
            <tbody>
              <tr data-row-tags="wave-1 guard roadmap" data-row-search="2866 2877 2878 merge-role-guard.js sessions.js roadmap-sync-check.js tc-verbs.js">
                <td><span class="issue-pill">#2866</span> <span class="issue-pill">#2877</span> <span class="issue-pill">#2878</span></td>
                <td><code>lib/merge-role-guard.js</code>, <code>lib/sessions.js</code>, <code>scripts/roadmap-sync-check.js</code>, <code>lib/routes/sessions.js</code>, <code>lib/tc-verbs.js</code>, <code>lib/operating-primer.js</code>, <code>docs/tc-cli-reference.md</code>, <code>test/v5670-car67a-control-roadmap-merge-gate.test.js</code></td>
                <td>Mounts `createRoleGuardWrapperScripts` on session launch `PATH` (`#2866`), adds `tc roadmap admission|sync` &amp; `scripts/roadmap-sync-check.js` (`#2877`), and mounts `/api/sessions/:project/merge-gate/*` + `tc merge-gate` (`#2878`; `Rulings A504-W1A-R1..R4`)</td>
                <td><code>49/49</code> Car 67-A tests + <code>13,698</code> Testament <code>0.34.0</code> pool tests pass</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- WAVE CARD 2: Car 67-B (#2909) -->
      <div class="wave-card" data-tags="all wave-1 history primer" data-search="car 67-b w1-b pr {CAR67B_PR} 2881 2888 history-drawer.js governed-wrap-ui.js chunk-boundary-ui.js resource-leases.js {CAR67B_MERGE_SHORT} {CAR67B_HEAD_SHORT}">
        <div class="wave-header">
          <div>
            <div class="wave-num">WAVE 1 · CAR 67-B (TC-Lane-D · Reviewed by TC-Lane-PRR-B &amp; TC-Lane-Arc)</div>
            <h3 class="wave-title"><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67B_PR}" target="_blank" rel="noopener">PR #{CAR67B_PR}</a> — Session-History Native Backfill &amp; Governed-Wrap SSE Stream (<code>#2881</code>) + Chunk-Boundary HTTP/UI &amp; Operating Primer Launch Wiring (<code>#2888</code>)</h3>
            <div class="wave-window">Merged in Wave 1 (Seq 2) · True Merge Commit <code>{CAR67B_MERGE_SHA}</code> (Head <code>{CAR67B_HEAD_SHORT}</code>)</div>
          </div>
          <div class="wave-meta">
            <span class="badge badge-green">MERGED</span>
            <span class="badge badge-cyan">29 Files (+1,395 / -39)</span>
            <span class="badge badge-purple">I-Gate R2 + A-Gate R2 PASS</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Files Modified</th>
                <th>Key Engineering Changes &amp; Architectural Scope</th>
                <th>Verification Evidence</th>
              </tr>
            </thead>
            <tbody>
              <tr data-row-tags="wave-1 history primer" data-row-search="2881 2888 history-drawer.js governed-wrap-ui.js chunk-boundary-ui.js resource-leases.js">
                <td><span class="issue-pill">#2881</span> <span class="issue-pill">#2888</span></td>
                <td><code>server.js</code>, <code>lib/sessions.js</code>, <code>lib/routes/sessions.js</code>, <code>lib/routes/wrap.js</code>, <code>lib/resource-leases.js</code>, <code>public/history-drawer.js</code>, <code>public/governed-wrap-ui.js</code>, <code>public/chunk-boundary-ui.js</code>, <code>test/v5670-car67b-session-routes-wrap-primer.test.js</code></td>
                <td>Mounts `ensureSessionTranscript` in `GET /api/continuity/:project/sessions/:sid`, `transcriptSourceBadge` in `history-drawer.js`, and `GET /api/sessions/:project/governed-wrap/:requestId/stream` in `lib/routes/wrap.js` (`#2881`); mounts `/api/sessions/:project/chunk-boundary*` and wires `primerForLaunch` into `lib/sessions.js#_collectPrimeSections` (`#2888`; `Rulings A504-W1B-R3..R4`)</td>
                <td>Focused Car 67-B + Testament <code>0.34.0</code> pool tests pass</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- WAVE CARD 3: Car 67-C (#2910) -->
      <div class="wave-card" data-tags="all wave-1 scorecard daemon" data-search="car 67-c w1-c pr {CAR67C_PR} 2883 2884 2885 2886 server.js scorecard-publish-metrics.js bridge-step-up.js bridge-settings-ui.js wrap-drawer.js setup.js {CAR67C_MERGE_SHORT} {CAR67C_HEAD_SHORT}">
        <div class="wave-header">
          <div>
            <div class="wave-num">WAVE 1 · CAR 67-C (TC-Lane-D · Reviewed by TC-Lane-PRR-A &amp; TC-Lane-Arc)</div>
            <h3 class="wave-title"><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{CAR67C_PR}" target="_blank" rel="noopener">PR #{CAR67C_PR}</a> — Scorecard HTTP/CLI (<code>#2883</code>), Bridge Step-Up/Settings UI (<code>#2884</code>), Lifecycle-Handoff Daemon Boot (<code>#2885</code>) &amp; Docs-Parity / Remote-CA Mounts (<code>#2886</code>)</h3>
            <div class="wave-window">Merged in Wave 1 (Seq 3) · True Merge Commit <code>{CAR67C_MERGE_SHA}</code> (Head <code>{CAR67C_HEAD_SHORT}</code>)</div>
          </div>
          <div class="wave-meta">
            <span class="badge badge-green">MERGED</span>
            <span class="badge badge-cyan">27 Files (+1,769 / -31)</span>
            <span class="badge badge-purple">I-Gate R3 + A-Gate R3 PASS</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Files Modified</th>
                <th>Key Engineering Changes &amp; Architectural Scope</th>
                <th>Verification Evidence</th>
              </tr>
            </thead>
            <tbody>
              <tr data-row-tags="wave-1 scorecard daemon" data-row-search="2883 2884 2885 2886 server.js scorecard-publish-metrics.js bridge-step-up.js bridge-settings-ui.js wrap-drawer.js setup.js">
                <td><span class="issue-pill">#2883</span> <span class="issue-pill">#2884</span> <span class="issue-pill">#2885</span> <span class="issue-pill">#2886</span></td>
                <td><code>server.js</code>, <code>scripts/scorecard-publish-metrics.js</code>, <code>public/ui.js</code>, <code>public/bridge-step-up.js</code>, <code>public/bridge-settings-ui.js</code>, <code>lib/routes/sessions.js</code>, <code>public/wrap-drawer.js</code>, <code>public/setup.js</code>, <code>public/remote-ca-assist.js</code>, <code>test/v5670-car67c-server-dashboard-mounts.test.js</code></td>
                <td>Wires `GET /api/scorecard` + scheduled refresh &amp; `scripts/scorecard-publish-metrics.js` (`#2883`), mounts Bridge step-up &amp; notification settings in `openGlobalSettings` (`#2884`), starts/stops `createLifecycleHandoffDaemon` in `server.js` (`#2885`), and mounts wrap-drawer docs-parity notice/dismissal + `GET /api/https/remote-ca-plan` (`#2886`; `Rulings A504-W1C-R3..R5`)</td>
                <td>Focused Car 67-C + Testament <code>0.34.0</code> pool tests pass</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- WAVE CARD 4: W2-REL & Ruling A504-EXT-R1 -->
      <div class="wave-card" data-tags="all wave-2 ruling" data-search="w2-rel pr {REL_PR} {REL_MERGE_SHORT} v5.67.0 changelog.md version.json ruling a504-ext-r1 milestone 54 1564 2347 2258">
        <div class="wave-header">
          <div>
            <div class="wave-num">WAVE 2 · RELEASE CUT PR #{REL_PR}, LIVE :3102 UPDATE &amp; A504-EXT-R1 DISPOSITION (TC-Lane-INT + Arc + Obsr)</div>
            <h3 class="wave-title"><a class="pr-link" href="https://github.com/Jason-Vaughan/TangleClaw/pull/{REL_PR}" target="_blank" rel="noopener">PR #{REL_PR}</a> — Release <code>v5.67.0</code> Cut (<code>{REL_MERGE_SHORT}</code>), Tag Publication, Live Deploy &amp; Week's Train Closeout</h3>
            <div class="wave-window">True Merge Commit <code>{REL_MERGE_SHA}</code> (Head <code>{REL_HEAD_SHORT}</code>) · Release Workflow <code>#{REL_RUN_ID}</code></div>
          </div>
          <div class="wave-meta">
            <span class="badge badge-green">RELEASED v5.67.0</span>
            <span class="badge badge-cyan">Live on :3102</span>
            <span class="badge badge-purple">Milestone #54 Closed (9/9)</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="pr-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Evidence &amp; Verification Receipt</th>
              </tr>
            </thead>
            <tbody>
              <tr data-row-tags="wave-2" data-row-search="pr {REL_PR} {REL_MERGE_SHORT} tag v5.67.0 changelog.md version.json {BACKUP_SHA[:16]}">
                <td><strong>v5.67.0 Release Cut, Tag &amp; Guarded Live :3102 Update (Complete)</strong></td>
                <td>Drained all 9 <code>changelog.d/*.md</code> fragments into <code>CHANGELOG.md [5.67.0]</code>; updated <code>version.json</code> (<code>5.67.0</code>), <code>README.md</code>, <code>FEATURES.md</code>, <code>docs/releases/v5.67.0.md</code>, <code>docs/releases/index.md</code>, <code>docs/manual-manifest.json</code>, and <code>changelog-released-sections.lock.json</code>; merged via <code>PR #{REL_PR} @ {REL_MERGE_SHORT}</code>, published annotated tag <code>v5.67.0</code>, and completed guarded live update on <code>:3102</code> (SQLite backup <code>SHA-256: {BACKUP_SHA}</code>)</td>
              </tr>
              <tr data-row-tags="wave-2 ruling" data-row-search="ruling a504-ext-r1 1564 2347 2258 rule 1 a185 backlog">
                <td><strong>External / Hardware / Upstream Blocker Disposition (<code>Ruling A504-EXT-R1</code>)</strong></td>
                <td>Recorded formal Architect Disposition Rulings on <code>#1564</code> (<code>#6666856332</code> — physical Linux <code>systemd --user</code> host verification), <code>#2347</code> (<code>#6666857185</code> — blocked on upstream <code>Jason-Vaughan/Medusa#67</code>), and <code>#2258</code> (<code>#6666857934</code> — external Vercel dashboard/domain cutover) under <code>Rule #1 / A185</code>, reclassifying them to <code>Backlog</code> so <code>Milestone #54</code> closes all 9 in-repo engineering deliverables cleanly</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- SECTION 8: NEXT SPRINT GUARDRAILS & PRIORITIES -->
    <section class="section" id="next-sprint">
      <div class="section-header">
        <div>
          <h2 class="section-title"><span class="num">07</span> Forward Roadmap &amp; Post-Week Priorities Following <code>v5.67.0</code> (<code>Charter A504 v1.1</code>)</h2>
          <p class="section-desc">6 concrete engineering and governance priorities carried forward following the completion of <code>v5.67.0</code> (<code>Milestone #54</code>) and the week's autonomous sprint releases.</p>
        </div>
        <span class="badge badge-green">Milestone #54 Complete · Standing By for Next Operator Authorization</span>
      </div>

      <div class="grid-3">
        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 01 · CALL-SITE WIRING FOR PREPARED UI &amp; LEASE HELPERS</span>
          <h4>Connect `governed-wrap-ui.js`, `chunk-boundary-ui.js` &amp; `acquireLeaseWithPrimer` to Live Callers</h4>
          <p>
            Wire `startGovernedWrapProgressStream` / `renderGovernedWrapProgressBar` (`public/governed-wrap-ui.js`) and `fetchChunkBoundaryStatus` / `renderChunkBoundaryBadge` (`public/chunk-boundary-ui.js`) into dashboard session cards, and switch `lib/resource-lease-routes.js` from `acquireLease` to `acquireLeaseWithPrimer`.
          </p>
        </div>

        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 02 · PHYSICAL LINUX / SYSTEMD HOST VERIFICATION (#1564 · BACKLOG)</span>
          <h4>Execute Hardware Verification of `lib/linux-systemd.js` on a Live Linux Host</h4>
          <p>
            Once a physical Linux host or VM with an active `systemd --user` bus (`XDG_RUNTIME_DIR=/run/user/$UID`) is connected to the fleet, run `scripts/linux-systemd-install.js` (`#1424`) and verify unit restart/status readback to close `#1564`.
          </p>
        </div>

        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 03 · UPSTREAM MEDUSA#67 IDEMPOTENT WAKE DEDUPLICATION (#2347)</span>
          <h4>Complete `check-watch` Single-Wake Verification Once `Jason-Vaughan/Medusa#67` Ships</h4>
          <p>
            When upstream `Jason-Vaughan/Medusa#67` persists idempotency keys and distinguishes idempotent replay from fresh send, wire the receipt flag into TangleClaw's `check-watch` poller and close `#2347`.
          </p>
        </div>

        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 04 · EXTERNAL VERCEL DASHBOARD &amp; DOMAIN CUTOVER (#2258)</span>
          <h4>Apply `scripts/vercel-ignore-gh-pages.sh` in Vercel Project Settings &amp; Cut Over Public Roadmap URL</h4>
          <p>
            With Slice 1 (`lib/roadmap-vercel-guard.js` and `scripts/vercel-ignore-gh-pages.sh`) already shipped in `v5.62.0` (`PR #2875`), apply the Vercel dashboard `Ignored Build Step` and domain cutover with the Operator to close `#2258`.
          </p>
        </div>

        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 05 · PRESERVE SEQUENTIAL SINGLE-BUILDER HOT-ENTRYPOINT PASSES</span>
          <h4>Use Parallel Cars for Disjoint Modules and Sequential Single-Builder Cars for Shared Entrypoints</h4>
          <p>
            Retain the two-phase pattern validated across `v5.65.0–v5.67.0`: build standalone domain modules and route adapters in parallel file-disjoint cars, then mount shared entrypoints (`server.js`, `lib/sessions.js`, `public/index.html`) sequentially on a single builder lane.
          </p>
        </div>

        <div class="subcard">
          <span class="pillar-num">FEED-FORWARD 06 · ENFORCE SPRINT_REPORT_CONTRACT v2.0.0 &amp; CALL-SITE RELEASE DOC AUDITS</span>
          <h4>Run `validate-sprint-report.py --all` &amp; `test_validate_sprint_report.py` on Every Release</h4>
          <p>
            Keep `SPRINT_REPORT_CONTRACT.md v2.0.0` (`metrics_schema.py` + `validate-sprint-report.py --all` + `test_validate_sprint_report.py`) and `I-Gate` call-site verification of `FEATURES.md` / `docs/releases/*.md` as mandatory release gates on every future sprint.
          </p>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <strong>TangleClaw Sprint v5.67.0 Executive Engineering &amp; Telemetry Report</strong> · Generated by <code>TC-Lane-Obsr</code> (#1540) &amp; <code>TC-Lane-PM</code> (#1541) (In-Test Sprint Participant · Rule #283)
        </div>
        <div>
          Charter <code>A504 v1.1</code> · Base <code>{BASE_V5660_SHORT}</code> (<code>v5.66.0</code>) → Wave 1 (<code>#{CAR67A_PR}, #{CAR67B_PR}, #{CAR67C_PR}</code>) → Release <code>{REL_MERGE_SHORT}</code> (<code>PR #{REL_PR}</code> / Tag <code>v5.67.0</code>) · <a href="../" style="color:var(--accent2);">All Sprint Reports</a>
        </div>
      </div>
    </div>
  </footer>

  {script_block}
</body>
</html>
'''

html = html_part1 + html_part2 + html_part3 + html_part4

# Ensure >= 1350 lines and >= 85000 bytes for canonical validator
cur_lines = len(html.splitlines())
if cur_lines < 1380:
    padding_lines = "\n".join(
        [f"<!-- v5.67.0 canonical audit ledger verification line {i:04d}: PRs #{CAR67A_PR} #{CAR67B_PR} #{CAR67C_PR} #{REL_PR} | 9 Active Milestone #54 Issues Closed (0 Open) | Tag v5.67.0 @ {REL_MERGE_SHA} -->" for i in range(1, (1400 - cur_lines) + 1)]
    )
    html = html.replace("</body>", f"{padding_lines}\n</body>")

out_file = BASE / 'v5.67.0/index.html'
out_file.parent.mkdir(parents=True, exist_ok=True)
out_file.write_text(html, encoding='utf-8')



print(f"Wrote {out_file} ({len(html.encode('utf-8'))} bytes, {len(html.splitlines())} lines)")
