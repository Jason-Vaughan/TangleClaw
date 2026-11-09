#!/usr/bin/env python3
"""
Canonical primary-source specifications for Charter A505 v1.0 sprint reports:
  - v5.68.0 (Milestone #55 · Leg 1/4)
  - v5.69.0 (Milestone #56 · Leg 2/4)
  - v5.70.0 (Milestone #57 · Leg 3/4)
  - v5.71.0 (Milestone #58 · Leg 4/4)
  - v5.68.0-v5.71.0-retrospective (4-Version Autonomous Sprint Train & Kaizen Retrospective)

All issue IDs, PR numbers (#2912–#2927), merge SHAs, head SHAs, file paths, review comment IDs,
Architect rulings, and Kaizen Retro findings are 100% primary-source verified against GitHub REST API
and session transcripts.
"""

A505_SPECS = {
    "v5.68.0": {
        "slug": "v5.68.0",
        "version": "v5.68.0",
        "milestone_num": 55,
        "charter": "Charter A505 v1.0",
        "leg_label": "Leg 1 of 4 (Charter A505 v1.0)",
        "theme": "Native sprint tracking, continuity mail & suite contention immunity",
        "release_notes_title": "Sprint tracking and continuity safeguards",
        "base_version": "v5.67.0",
        "base_sha_short": "1b0b09ef",
        "rel_pr": 2915,
        "rel_head_short": "e1ebf418",
        "rel_merge_sha": "2b4b39a37a6a4a2b431ecb4bd2603ab000547e76",
        "rel_merge_short": "2b4b39a3",
        "tag_sha_short": "3ee11478",
        "rel_run_id": "42187629444",
        "backup_sha": "80403a7c901d4e3852ae3306ea26647418e55b3baaa6ae57c5a56766af347ba9",
        "ogate_comment_id": "6680736226",
        "feature_loc_label": "+2,525 / -148 net (29 files; +2,490 / -143 feat PRs)",
        "meta_description": (
            "Executed across 2 coordinated waves on base tag 1b0b09ef as Leg 1 of 4 under "
            "Charter A505 v1.0 (Milestone #55) and SPRINT_REPORT_CONTRACT v2.0.0, closing all 5 chartered issues "
            "(#2644, #2821, #748, #2735, #2736) across 4 true-merged PRs (#2913, #2914, #2912, #2915)."
        ),
        "eyebrow": "● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #55 (v5.68.0) · CHARTER A505 v1.0 LEG 1/4 · KAIZEN RETRO #1",
        "hero_sub_html": (
            'Executed across <strong>2 coordinated waves</strong> on base <code>1b0b09ef</code> (<code>tag: v5.67.0</code>) '
            'as <strong>Leg 1 of 4</strong> of the self-organized overnight sprint train under <strong>Charter <code>A505 v1.0</code></strong>, '
            '<strong>Architect Gate 0 Ruling <code>A505-R1</code> (<code>#6678764376</code>)</strong>, and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>. '
            'Shipped <strong>4 Sprint PRs (#2913, #2914, #2912, #2915)</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), '
            'closing all <strong>5 active chartered Milestone #55 issues (#2644, #2821, #748, #2735, #2736; <code>open_issues: 0, closed_issues: 5</code>)</strong> '
            'plus <strong><code>v5.67.0</code> Feed-Forward 01 call-site wiring</strong> with <strong>0 post-merge defects on <code>main</code></strong> '
            'and <strong><code>+2,525 / -148</code> net repository lines of code across 29 files (<code>+2,490 / -143</code> across 26 feature PR file touches)</strong>. '
            'Wave 1 executed 3 file-disjoint cars: '
            '<code>Car 68-C PR #2913</code> (<code>#2735 + #2736 + FF-01b</code>: full-suite contention immunity for <code>test/tmux-tcc.test.js</code> and '
            '<code>test/master-medusa.test.js</code> plus governed-wrap SSE progress and manual chunk-boundary lookup wiring in <code>public/session.js</code>; '
            'merged at <code>8c2b7264</code>), '
            '<code>Car 68-B PR #2914</code> (<code>#2821 + #748 + FF-01a</code>: coordinator-rotation relaunch mail continuity in <code>lib/coordinator-rotation.js#claimRelaunch</code>, '
            'Feature Index graduation starvation fix in <code>lib/wrap-steps/index-describe.js</code>, and <code>acquireLeaseWithPrimer</code> call-site wiring in '
            '<code>lib/resource-lease-routes.js#handleAcquireLease</code>; merged at <code>1f98b04d</code>), and '
            '<code>Car 68-A PR #2912</code> (<code>#2644</code> Train 35: native sprint wave tracker &amp; file-disjoint validator in <code>lib/native-sprint-tracker.js</code>, '
            '<code>lib/routes/sprint-wave-routes.js</code>, and <code>public/sprint-wave-ui.js</code>; merged at <code>1370777f</code>).'
        ),
        "plain_english_headline": "Native Sprint Wave Tracking, Coordinator Relaunch Mail Continuity, Feature Index Graduation Fix & Full-Suite Contention Immunity",
        "plain_english_intro": (
            "Sprint <code>v5.68.0</code> (<strong>“Native sprint tracking, continuity mail &amp; suite contention immunity”</strong>, "
            "Leg 1 of the 4-version Charter <code>A505 v1.0</code> overnight train) closed all <strong>5 Milestone #55 issues across 4 pull requests</strong> "
            "(<code>+2,525 / -148</code> net LOC across 29 files):"
        ),
        "plain_english_pillars": [
            (
                "1. Native Sprint Wave Tracker & File-Disjoint Validator (#2644 · Car 68-A PR #2912)",
                "<code>Car 68-A</code> (<code>PR #2912</code>, <code>+1,363 / -1</code> LOC across <code>9</code> files) delivers <code>lib/native-sprint-tracker.js</code>, "
                "<code>lib/routes/sprint-wave-routes.js</code>, and <code>public/sprint-wave-ui.js</code> to validate wave/car file disjointness against real Git diffs, "
                "track dispatch states, model O-Gate summaries, and persist atomic last-good roadmap snapshots.",
            ),
            (
                "2. Coordinator Relaunch Mail Continuity, Feature Index Graduation & Lease Primer (#2821, #748 · Car 68-B PR #2914)",
                "<code>Car 68-B</code> (<code>PR #2914</code>, <code>+392 / -55</code> LOC across <code>10</code> files) snapshots unhandled Medusa messages during "
                "<code>claimRelaunch()</code> so messages arriving between prepare and relaunch are never dropped (<code>#2821</code>), unblocks Feature Index graduation "
                "when new <code>features-toc</code> entries are staged (<code>#748</code>), and wires <code>acquireLeaseWithPrimer</code> into <code>handleAcquireLease</code>.",
            ),
            (
                "3. Full-Suite Contention Immunity & Session Drawer Progress/Chunk Wiring (#2735, #2736 · Car 68-C PR #2913)",
                "<code>Car 68-C</code> (<code>PR #2913</code>, <code>+735 / -87</code> LOC across <code>7</code> files) eliminates full-suite CPU contention flakes in "
                "<code>test/tmux-tcc.test.js</code> (<code>#2735</code>) and <code>test/master-medusa.test.js</code> (<code>#2736</code>) by resetting state between retries, "
                "and wires governed-wrap progress bars and manual chunk-boundary lookup into <code>public/session.js</code>.",
            ),
        ],
        "cars": [
            {
                "car_id": "Car 68-C",
                "wave_phase": "Wave 1 (Car 68-C)",
                "builder": "TC-Lane-D (#1533)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2913,
                "head_short": "62425f0d",
                "merge_sha": "8c2b7264f738e4c55fdb1c9ad5136316fb18b866",
                "merge_short": "8c2b7264",
                "issues": [2735, 2736],
                "files_count": 7,
                "additions": 735,
                "deletions": 87,
                "title": "Harden tmux-tcc and master-medusa under suite contention and wire wrap/chunk UI call sites (#2735, #2736)",
                "files_list": "`public/session.js`, `test/tmux-tcc.test.js`, `test/master-medusa.test.js`, `test/governed-wrap-ui.test.js`, `test/chunk-boundary-ui-browser.test.js`, `changelog.d/2735.*.md`, `changelog.d/2736.*.md`",
                "summary": "Resets state between real tmux TCC probes (`#2735`) and Master Medusa HTTP test attempts (`#2736`) under full-suite load; wires governed-wrap progress stream and manual chunk-boundary lookup into `public/session.js` (`FF-01b`).",
                "verification": "`PRR-B R2 PASS (#5797072556)` + `Arc R2 PASS (#6679664401)` after R1 wire-shape fix (`requestId` & `GOVERNED_WRAP_PROGRESS_STAGES`)",
                "tags": "wave-1 contention session-ui",
            },
            {
                "car_id": "Car 68-B",
                "wave_phase": "Wave 1 (Car 68-B)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2914,
                "head_short": "23a6b7a1",
                "merge_sha": "1f98b04dc2f01b4668dd6218ff95915c2f04b888",
                "merge_short": "1f98b04d",
                "issues": [2821, 748],
                "files_count": 10,
                "additions": 392,
                "deletions": 55,
                "title": "Fix coordinator-rotation relaunch mail, Feature Index graduation starvation & wire lease primer (#2821, #748)",
                "files_list": "`lib/coordinator-rotation.js`, `lib/wrap-steps/index-describe.js`, `lib/wrap-steps/features-toc.js`, `lib/resource-lease-routes.js`, `docs/coordinator-rotation.md`, `test/coordinator-rotation.test.js`, `test/wrap-step-index-describe.test.js`, `test/resource-leases.test.js`",
                "summary": "Persists `unhandledAtRelaunch` snapshot in `claimRelaunch()` with fallback to `rotation.inboxIds` (`#2821`, `Ruling A505-R1.3`), decouples `index-describe` graduation from concurrent `features-toc` appends (`#748`), and wires `acquireLeaseWithPrimer` into `handleAcquireLease` (`FF-01a`).",
                "verification": "`PRR-A R2 PASS (#5797260771)` + `Arc R2 PASS (#6680009445)`",
                "tags": "wave-1 rotation graduation lease",
            },
            {
                "car_id": "Car 68-A",
                "wave_phase": "Wave 1 (Car 68-A)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2912,
                "head_short": "4132d18d",
                "merge_sha": "1370777fec27c6334cd5030fb8993a8aa2b2ca8f",
                "merge_short": "1370777f",
                "issues": [2644],
                "files_count": 9,
                "additions": 1363,
                "deletions": 1,
                "title": "Native sprint wave tracker, live sync, and report summary (#2644 · Train 35)",
                "files_list": "`lib/native-sprint-tracker.js`, `lib/routes/sprint-wave-routes.js`, `public/sprint-wave-ui.js`, `public/sw.js`, `docs/areas.json`, `.testament.toml`, `test/tiers.json`, `test/native-sprint-tracker.test.js`, `changelog.d/2644.*.md`",
                "summary": "Adds `lib/native-sprint-tracker.js` wave/car file-disjointness validation (normalizing repo-relative paths against real `git diff --name-only`), dispatch state machine, O-Gate summary model, and atomic roadmap sync snapshot, plus `createSprintWaveRouter` and `public/sprint-wave-ui.js` (`Rulings A505-R1.2, A505-R1.4`).",
                "verification": "`PRR-A R3 PASS (#5797343764)` + `Arc R3 PASS (#6680182647)` (`36/36` unit tests + `public/sw.js` `v3-71` cache bump)",
                "tags": "wave-1 tracker train35",
            },
        ],
        "rel_files_count": 13,
        "rel_additions": 79,
        "rel_deletions": 49,
        "rel_verification": "`PRR-A R2 PASS (#5797542993)` + `Arc R2 PASS (#6680564402)` + `Obsr O-Gate PASS (#6680736226)`",
        "kaizen_title": "Kaizen Retro #1 (v5.68.0 → v5.69.0) — Closed-Loop Findings & Feed-Forward Rules",
        "kaizen_badge": "Mandatory Per-Version Kaizen Retro #1 · 3 Findings Codified into v5.69.0 (#56)",
        "kaizen_items": [
            (
                "Finding KR1-01 (`public/sw.js` `cache-bump-guard` in Gate 0 & Local Preflight)",
                "`PR #2912` (`Car 68-A`, `#2644`) added `public/sprint-wave-ui.js` and passed 36 unit tests, but failed CI `Guard the service-worker cache generation` (`scripts/cache-bump-guard.js`) at Round 2 (`bea308df`) because `public/sw.js` `CACHE_NAME` was not bumped (`v3-70 → v3-71`), requiring `Ruling A505-R1.4` (`#6680118185`) and Round 3 (`4132d18d`). **Feed-Forward Action injected into `v5.69.0`:** `Ruling A505-R2` explicitly assigns `public/sw.js` to `Car 69-C` (`#1576, #1083`), and every car touching `public/*` must run `node scripts/cache-bump-guard.js --base origin/main --head HEAD` in local preflight before opening a PR.",
            ),
            (
                "Finding KR1-02 (Defense-in-Depth for Teardown-Adjacent State)",
                "In `PR #2914` (`Car 68-B`, `#2821`), `claimRelaunch()` runs after `_boundSessionEnded()`, where `#1806` (`_teardownMedusa`) has already torn down the old Medusa listener (`d.messages(oldSessionId) === []`). `I-Gate R1` (`#5797092794`) + `A-Gate R1` (`#6679749878`) + `Ruling A505-R1.3` closed this gap by persisting `unhandledAtRelaunch` in `claimRelaunch()` with conservative fallback to `rotation.inboxIds`. **Feed-Forward Action injected into `v5.69.0`:** For `#1732` (Medusa startup auto-announcement) and `#1713` (delegated peer recovery clearance), builders must test both live-listener and post-teardown/relaunch state transitions.",
            ),
            (
                "Finding KR1-03 (UI Wire-Shape Parity Between Server Payloads and Browser Renderers)",
                "In `PR #2913` (`Car 68-C`, `FF-01b`), `I-Gate R1` (`#5797022088`) and `A-Gate R1` (`#6679578207`) caught `request.id` vs `request.requestId` and `STATES` vs `GOVERNED_WRAP_PROGRESS_STAGES` in `public/session.js`. **Feed-Forward Action injected into `v5.69.0`:** `Car 69-C` (`#1576` Team Chat nicknames, `#1083` Master Medusa loops view) must assert exact server route JSON field names in DOM/browser tests.",
            ),
        ],
        "pm_worked": [
            (
                "1. Autonomous Backlog Triage & 3-Car File-Disjoint Wave Partition (`Charter A505 v1.0` Gate 0)",
                "`TC-Lane-PM` and `TC-Lane-Arc` (`Ruling A505-R1`, `#6678764376`) partitioned all 5 Milestone `#55` issues (`#2644, #2821, #748, #2735, #2736`) plus `v5.67.0 FF-01` call-site mounts across 3 strictly file-disjoint Wave 1 cars (`Car 68-A` 9 files, `Car 68-B` 10 files, `Car 68-C` 7 files), achieving `0` merge conflicts across all 4 true-merged PRs (`#2913, #2914, #2912, #2915`).",
            ),
            (
                "2. Dynamic Builder Reassignment When `TC-Lane-A/C` Hit Interactive Mode Holds",
                "When `TC-Lane-A` (`#1534`) and `TC-Lane-C` (`#1532`) were in `claude-sonnet-reviewer` mode with open `AskUserQuestion` prompts and `TC-Lane-B` (`#1555`) came online at `06:49Z`, `TC-Lane-PM` dynamically reassigned `Car 68-A` (`#2644`) and `Car 68-B` (`#2821, #748`) to `TC-Lane-B` (`#1555`) while `TC-Lane-D` (`#1533`) built `Car 68-C` (`#2735, #2736`), completing all 3 cars in `1h 24m 55s` (`T_eng = 1.42h`).",
            ),
            (
                "3. Pre-Merge `I-Gate` & `A-Gate` Catches on Relaunch Teardown Ordering (`#2821`) and UI Wire Shapes (`FF-01b`)",
                "`TC-Lane-PRR-A` (`#5797092794`) and `TC-Lane-Arc` (`#6679749878`) caught that `_teardownMedusa` cleared the old listener before `claimRelaunch()` ran in `PR #2914`, and `TC-Lane-PRR-B` (`#5797022088`) caught `request.requestId` / `GOVERNED_WRAP_PROGRESS_STAGES` wire-shape mismatches in `PR #2913`, fixing both before `main` integration.",
            ),
            (
                "4. Release-Note Attribution Honesty on `PR #2915` (`I-Gate R1 → R2`)",
                "During Wave 2 review of `PR #2915`, `TC-Lane-PRR-A` (`#5797519536`) verified every bullet in `docs/releases/v5.68.0.md` against mounted routes, ensuring `createSprintWaveRouter`, `public/sprint-wave-ui.js`, and `lib/resource-lease-routes.js` were accurately described as available adapters/handlers while not yet mounted in `server.js`.",
            ),
        ],
        "pm_warn": [
            (
                "1. Service-Worker `cache-bump-guard` CI Failure on `PR #2912` Round 2 (`KR1-01`)",
                "Adding `public/sprint-wave-ui.js` in `Car 68-A` (`PR #2912`) without bumping `CACHE_NAME` in `public/sw.js` tripped GitHub Actions `Guard the service-worker cache generation` on commit `bea308df`. **Fix / Guardrail (`Ruling A505-R1.4` & `KR1-01`):** Bumped `public/sw.js` to `v3-71` in commit `4132d18d` and mandated `node scripts/cache-bump-guard.js --base origin/main --head HEAD` preflight for all `public/*` cars in `v5.69.0–v5.71.0`.",
            ),
            (
                "2. Repo-Relative Path Normalization in `validateWaveDisjointness` (`PR #2912` R1 → R2)",
                "In `PR #2912` Round 1 (`ec6f3993`), `TC-Lane-PRR-A` (`#5796882458`) found that `validateWaveDisjointness` compared raw `git diff --name-only` paths without normalizing `./` prefixes when checking car envelopes, and `docs/areas.json` + `.testament.toml` needed envelope authorization. **Fix / Guardrail (`Ruling A505-R1.2`):** Normalized repo-relative paths and added real temporary-git-repo integration tests in Round 2 (`bea308df`).",
            ),
            (
                "3. Post-Teardown Medusa Inbox Snapshot in `claimRelaunch()` (`PR #2914` R1 → R2 · `KR1-02`)",
                "In `PR #2914` Round 1 (`66c53ef6`), `claimRelaunch()` queried `d.messages(oldSessionId)` after `_boundSessionEnded()` had already torn down the Medusa listener, returning `[]`. **Fix / Guardrail (`Ruling A505-R1.3` & `KR1-02`):** Persisted `unhandledAtRelaunch` before teardown with conservative fallback to `rotation.inboxIds` in Round 2 (`23a6b7a1`).",
            ),
            (
                "4. Session Drawer Governed-Wrap & Chunk-Boundary Payload Field Names (`PR #2913` R1 → R2 · `KR1-03`)",
                "In `PR #2913` Round 1 (`ad6612f1`), `public/session.js` read `request.id` instead of `request.requestId` and `STATES` instead of `GOVERNED_WRAP_PROGRESS_STAGES`. **Fix / Guardrail (`KR1-03`):** Corrected the field bindings in Round 2 (`62425f0d`) and required DOM tests in `v5.69.0` to assert exact server route JSON property names.",
            ),
        ],
        "next_sprint_cards": [
            (
                "KAIZEN FEED-FORWARD KR1-01 · SERVICE WORKER CACHE-BUMP PREFLIGHT",
                "Assign Single `public/sw.js` Owner & Run `cache-bump-guard.js` Before Opening Any UI PR",
                "Applied immediately in `v5.69.0` (`Ruling A505-R2`): `public/sw.js` is assigned exclusively to `Car 69-C` (`#1083, #1576`), and builders run `node scripts/cache-bump-guard.js --base origin/main --head HEAD` prior to `gh pr create`.",
            ),
            (
                "KAIZEN FEED-FORWARD KR1-02 · TEARDOWN-ADJACENT STATE TESTING",
                "Test Both Live-Listener and Post-Teardown Transitions in `v5.69.0` (`#1732, #1713`)",
                "Applied in `Car 69-A` (`PR #2918`): `lib/medusa-startup-announce.js` and `lib/launch-recovery-clear.js` verify recipient resolution and recovery clearance across both active and post-teardown session states.",
            ),
            (
                "KAIZEN FEED-FORWARD KR1-03 · SERVER-TO-BROWSER WIRE-SHAPE PARITY",
                "Assert Exact Server Route JSON Keys in `v5.69.0` UI Component Tests (`#1083, #1576`)",
                "Applied in `Car 69-C` (`PR #2917`): `test/medusa-control-component.test.js` and `test/medusa-control.test.js` assert exact `/api/sessions/:project/medusa/*` response shapes.",
            ),
            (
                "LEG 2 EXECUTION · SPRINT v5.69.0 (MILESTONE #56 · 5 ISSUES)",
                "Ship Medusa Broadcast (`#1224`), Startup Auto-Announce (`#1732`), Peer Recovery (`#1713`), Loops UI (`#1083`) & `@nickname` Routing (`#1576`)",
                "Proceeds immediately on base `v5.68.0` (`2b4b39a3`) across `Car 69-A` (`#1732, #1713`), `Car 69-B` (`#1224`), and unified `Car 69-C` (`#1083, #1576` under `Ruling A505-R2.6`).",
            ),
            (
                "LEG 3 EXECUTION · SPRINT v5.70.0 (MILESTONE #57 · 4 ISSUES)",
                "Ship Guided TCC Workspace Migration (`#2626`), Hands-Off Repo Mode (`#1485`), `tc capture` (`#1774`) & Orchestrator Vocabulary (`#2127`)",
                "Queued for Leg 3 of Charter `A505 v1.0` with cross-version pipelining (`Guardrail 06`) and Kaizen Retro #2 feed-forward guardrails.",
            ),
            (
                "LEG 4 EXECUTION · SPRINT v5.71.0 (MILESTONE #58 · 6 ISSUES)",
                "Ship OpenClaw Ordered Fallback Hosts (`#1531`), MagicDNS Migration (`#363`), Update Check (`#297`), Direct Proxy Fix (`#254`), Dot Liveness (`#1185`) & Header Pills (`#128`)",
                "Queued as the final leg of Charter `A505 v1.0` to complete all 20/20 autonomous overnight sprint deliverables.",
            ),
        ],
    },
    "v5.69.0": {
        "slug": "v5.69.0",
        "version": "v5.69.0",
        "milestone_num": 56,
        "charter": "Charter A505 v1.0",
        "leg_label": "Leg 2 of 4 (Charter A505 v1.0)",
        "theme": "Medusa broadcast, Team Chat nicknames & autonomous session lifecycle",
        "release_notes_title": "Medusa coordination and session recovery",
        "base_version": "v5.68.0",
        "base_sha_short": "2b4b39a3",
        "rel_pr": 2921,
        "rel_head_short": "15be7c83",
        "rel_merge_sha": "6c446dac04d780c941a91347a091054a9bfbf7e2",
        "rel_merge_short": "6c446dac",
        "tag_sha_short": "47ade7b2",
        "rel_run_id": "42204891203",
        "backup_sha": "6c446dac04d780c941a91347a091054a9bfbf7e2",
        "ogate_comment_id": "6683456490",
        "feature_loc_label": "+4,619 / -851 net (36 files; +4,586 / -846 feat PRs)",
        "meta_description": (
            "Executed 100% unattended across 2 coordinated waves on base v5.68.0 (2b4b39a3) as Leg 2 of 4 under "
            "Charter A505 v1.0 (Milestone #56) and SPRINT_REPORT_CONTRACT v2.0.0, closing all 5 chartered issues "
            "(#1224, #1732, #1713, #1083, #1576) across 4 true-merged PRs (#2916, #2918, #2917, #2921)."
        ),
        "eyebrow": "● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #56 (v5.69.0) · CHARTER A505 v1.0 LEG 2/4 · KAIZEN RETRO #2",
        "hero_sub_html": (
            'Executed <strong>100% unattended overnight (<code>0</code> human inputs)</strong> across <strong>2 coordinated waves</strong> '
            'on base <code>2b4b39a3</code> (<code>tag: v5.68.0</code>) as <strong>Leg 2 of 4</strong> under <strong>Charter <code>A505 v1.0</code></strong>, '
            '<strong>Architect Rulings <code>A505-R2 / R2.6 / R2.7</code></strong>, and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>. '
            'Shipped <strong>4 Sprint PRs (#2916, #2918, #2917, #2921)</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), '
            'closing all <strong>5 active chartered Milestone #56 issues (#1224, #1732, #1713, #1083, #1576; <code>open_issues: 0, closed_issues: 5</code>)</strong> '
            'with <strong>0 post-merge defects on <code>main</code></strong> and <strong><code>+4,619 / -851</code> net repository lines of code across 36 files '
            '(<code>+4,586 / -846</code> across 33 feature PR file touches)</strong>. '
            'Applying <code>Kaizen Retro #1</code> feed-forward rules (<code>KR1-01..03</code>), Wave 1 shipped: '
            '<code>Car 69-B PR #2916</code> (<code>#1224</code>: explicit system-wide Medusa broadcast <code>lib/medusa.js#broadcastAll</code> with <code>[BROADCAST scope=all]</code> framing, '
            'active coordinator/operator authorization, per-sender cooldown, and in-flight retry coalescing; merged at <code>747007af</code>), '
            '<code>Car 69-A PR #2918</code> (<code>#1732 + #1713</code>: Medusa startup auto-announcement to peer project coordinators in <code>lib/medusa-startup-announce.js</code> '
            'and cross-project delegated peer launch recovery clearance via <code>POST /api/sessions/:project/launch/recovery-clear-peer</code> in schema <code>v79</code>; merged at <code>ccc3297d</code>), and '
            'unified <code>Car 69-C PR #2917</code> (<code>#1083 + #1576</code> under <code>Ruling A505-R2.6</code>: shared <code>public/medusa-loops-ui.js</code> <code>tcCreateMedusaLoops</code> component '
            'mounted in the Master control bar and session banner plus <code>@nickname</code> Team Chat routing in <code>public/session.js</code>; merged at <code>3ebe7777</code>).'
        ),
        "plain_english_headline": "Explicit System-Wide Medusa Broadcast, Cross-Project Startup Announcements & Peer Recovery Clearance, and Master Loops + `@nickname` Team Chat Routing",
        "plain_english_intro": (
            "Sprint <code>v5.69.0</code> (<strong>“Medusa broadcast, Team Chat nicknames &amp; autonomous session lifecycle”</strong>, "
            "Leg 2 of the 4-version Charter <code>A505 v1.0</code> train) ran with zero human intervention and closed all "
            "<strong>5 Milestone #56 issues across 4 pull requests</strong> (<code>+4,619 / -851</code> net LOC across 36 files):"
        ),
        "plain_english_pillars": [
            (
                "1. Explicit System-Wide Medusa Broadcast With Cooldown & Retry Safety (#1224 · Car 69-B PR #2916)",
                "<code>Car 69-B</code> (<code>PR #2916</code>, <code>+677 / -0</code> LOC across <code>4</code> files) adds <code>lib/medusa.js#broadcastAll</code> and "
                "<code>POST /api/sessions/:project/medusa/broadcast</code> so an operator or active coordinator can broadcast <code>[BROADCAST scope=all]</code> "
                "to all active switchboards with per-sender cooldowns and race-safe in-flight retry coalescing.",
            ),
            (
                "2. Medusa Startup Auto-Announcement & Delegated Peer Recovery Clearance (#1732, #1713 · Car 69-A PR #2918)",
                "<code>Car 69-A</code> (<code>PR #2918</code>, <code>+1,598 / -9</code> LOC across <code>15</code> files) automatically announces newly READY sessions "
                "to peer project coordinators (<code>#1732</code>) and allows a verified peer coordinator to clear a stalled launch via "
                "<code>POST /api/sessions/:project/launch/recovery-clear-peer</code> with SQLite schema <code>v79</code> audit provenance (<code>#1713</code>).",
            ),
            (
                "3. Shared Master Control-Bar Medusa Loops UI & `@nickname` Team Chat Routing (#1083, #1576 · Car 69-C PR #2917)",
                "<code>Car 69-C</code> (<code>PR #2917</code>, <code>+2,311 / -837</code> LOC across <code>14</code> files) extracts the shared "
                "<code>public/medusa-loops-ui.js</code> (<code>tcCreateMedusaLoops</code>) component into the Master control bar (<code>#1083</code>) and adds "
                "live roster <code>@nickname</code> tag resolution and fail-closed validation to the inbox compose bar (<code>#1576</code>).",
            ),
        ],
        "cars": [
            {
                "car_id": "Car 69-B",
                "wave_phase": "Wave 1 (Car 69-B)",
                "builder": "TC-Lane-D (#1533)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2916,
                "head_short": "e273cba0",
                "merge_sha": "747007afb1fc36b18508acfa0820c38902a9708e",
                "merge_short": "747007af",
                "issues": [1224],
                "files_count": 4,
                "additions": 677,
                "deletions": 0,
                "title": "feat(medusa): add explicit system-wide broadcast (#1224)",
                "files_list": "`lib/medusa.js`, `server.js`, `test/api-medusa.test.js`, `changelog.d/1224.medusa-system-broadcast.added.md`",
                "summary": "Implements `lib/medusa.js#broadcastAll` and `/api/sessions/:project/medusa/broadcast` with `[BROADCAST scope=all]` prefixing, active coordinator/operator grant verification, per-sender cooldown, and reservation-token identity guard for in-flight retries.",
                "verification": "`PRR-B R4 PASS (#5798639277)` + `Arc R4 PASS (#6682375410)`",
                "tags": "wave-1 broadcast medusa",
            },
            {
                "car_id": "Car 69-A",
                "wave_phase": "Wave 1 (Car 69-A)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2918,
                "head_short": "5250fcb1",
                "merge_sha": "ccc3297d001eb8173518fd6f1925d3d8401afbad",
                "merge_short": "ccc3297d",
                "issues": [1732, 1713],
                "files_count": 15,
                "additions": 1598,
                "deletions": 9,
                "title": "Add Medusa startup announcement and delegated peer recovery clearance (#1732, #1713)",
                "files_list": "`lib/medusa-startup-announce.js`, `lib/launch-recovery-clear.js`, `lib/routes/launch-recovery.js`, `lib/launch-sequence.js`, `lib/sessions.js`, `lib/store/_schema.js`, `lib/store/launch.js`, `test/medusa-startup-announce.test.js`, `test/launch-recovery-peer-clear.test.js`, `test/store-bridge-migration.test.js`",
                "summary": "Wires READY + Medusa-listener-active startup auto-announcements to peer project coordinators (`#1732`) and adds `POST /api/sessions/:project/launch/recovery-clear-peer` with schema `v79` cross-project coordinator provenance (`#1713`, `Ruling A505-R2.7`).",
                "verification": "`PRR-A R4 PASS (#5798843067)` + `Arc R4 PASS (#6682706251)`",
                "tags": "wave-1 announce recovery schema",
            },
            {
                "car_id": "Car 69-C",
                "wave_phase": "Wave 1 (Car 69-C)",
                "builder": "TC-Lane-D (#1533) & TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2917,
                "head_short": "4fcd6cae",
                "merge_sha": "3ebe777752697831b7d19b0e1e40f374b93d083b",
                "merge_short": "3ebe7777",
                "issues": [1083, 1576],
                "files_count": 14,
                "additions": 2311,
                "deletions": 837,
                "title": "feat(medusa): Master control bar loop UI + @nickname Team Chat routing (#1083, #1576)",
                "files_list": "`public/medusa-loops-ui.js`, `public/session.js`, `public/index.html`, `public/session.html`, `public/session.css`, `public/shared-controls.css`, `public/api-helper.js`, `public/sw.js`, `test/medusa-control-component.test.js`, `test/medusa-control.test.js`",
                "summary": "Unifies `#1083` and `#1576` under `Ruling A505-R2.6` (`#6681755428`): mounts shared `tcCreateMedusaLoops` in Master control bar and session banner (`#1083`), and adds `@nickname` Team Chat tag resolution, single-flight send protection, and draft preservation (`#1576`).",
                "verification": "`PRR-B R6 PASS (#5798925321)` + `Arc R6 PASS (#6682858125)`",
                "tags": "wave-1 loops nickname ui",
            },
        ],
        "rel_files_count": 13,
        "rel_additions": 59,
        "rel_deletions": 31,
        "rel_verification": "`PRR-A R1 PASS (#5799143446)` + `Arc R1 PASS (#6683228816)` + `Obsr O-Gate PASS (#6683456490)`",
        "kaizen_title": "Kaizen Retro #2 (v5.69.0 → v5.70.0) — Closed-Loop Findings & Feed-Forward Rules",
        "kaizen_badge": "Mandatory Per-Version Kaizen Retro #2 · 3 Findings Codified into v5.70.0 (#57)",
        "kaizen_items": [
            (
                "Finding KR2-01 (Pinning Prior Global Schema Versions in Historical Migration Rewind Helpers)",
                "When `CURRENT_SCHEMA_VERSION` advanced to `v79` in `Car 69-A` (`PR #2918`, `#1713`), historical migration rewind helpers like `rewindToV65` in `test/store-bridge-migration.test.js` that computed relative offsets from `CURRENT_SCHEMA_VERSION` drifted, and `test/api-coordinator-rotation.test.js` needed startup-announcement test isolation. Resolved under `Ruling A505-R2.7` (`#6682519207`) in commit `5250fcb1`. **Feed-Forward Action injected into `v5.70.0` & `v5.71.0`:** Pin literal schema numbers in historical migration rewind helpers and update `test/store-bridge-migration.test.js` whenever `lib/store/_schema.js` increments `CURRENT_SCHEMA_VERSION`.",
            ),
            (
                "Finding KR2-02 (Avoiding `*/` Glob Patterns Inside CSS Block Comments `/* ... */`)",
                "During `Car 69-C` (`PR #2917`, `#1083, #1576`), an explanatory comment inside `public/session.css` / `public/shared-controls.css` referenced a path glob containing `*/` inside a `/* ... */` block comment, prematurely closing the CSS comment and failing CSS syntax checks until fixed in Round 6 (`4fcd6cae`). **Feed-Forward Action injected into `v5.70.0` & `v5.71.0`:** Never place literal `*/` glob sequences inside CSS block comments; run UI/CSS regression tests locally before pushing.",
            ),
            (
                "Finding KR2-03 (Unifying Tightly Coupled UI Control-Bar Cars Under a Single `public/sw.js` Owner)",
                "Combining `#1083` (Master control-bar loop UI) and `#1576` (Team Chat `@nickname` routing) into unified `Car 69-C` under `Ruling A505-R2.6` (`#6681755428`) and applying `KR1-01` (`public/sw.js` cache bump preflight) eliminated multi-car UI merge conflicts on `public/index.html`, `public/session.js`, and `public/sw.js` (`0` cache-bump CI failures). **Feed-Forward Action injected into `v5.70.0`:** Keep `#2127` (`Car 70-C` Orchestrator vocabulary & UI) strictly isolated from backend/CLI cars `Car 70-A` (`#2626`) and `Car 70-B` (`#1485, #1774`).",
            ),
        ],
        "pm_worked": [
            (
                "1. Closed-Loop Proof of `KR1-01`: Zero `public/sw.js` `cache-bump-guard` Failures in `v5.69.0`",
                "Following `Kaizen Retro #1` (`KR1-01`), `Ruling A505-R2.6` assigned `public/sw.js` exclusively to unified `Car 69-C` (`PR #2917`), which bumped `CACHE_NAME` in local preflight and passed `Guard the service-worker cache generation` on the first try.",
            ),
            (
                "2. Architect Scope Unification Ruling `A505-R2.6` Prevented `public/session.js` Merge Collisions",
                "When `#1083` and `#1576` both required changes to the inbox/loop control bar in `public/session.js` and `public/sw.js`, `TC-Lane-Arc` issued `Ruling A505-R2.6` (`#6681755428`) unifying them into `Car 69-C` (`PR #2917`), avoiding a 2-car merge collision.",
            ),
            (
                "3. Deep Concurrency & Authorization Hardening by `I-Gate` (`PR #2916` & `PR #2917`)",
                "`TC-Lane-PRR-B` caught broadcast reservation-token races in `PR #2916` (`#5798560711`) and single-flight/draft-overwrite edge cases in `PR #2917` (`#5798621868`, `#5798682071`), ensuring neither concurrent broadcasts nor rapid `@nickname` sends can drop or duplicate messages.",
            ),
            (
                "4. Single-Round Release PR Convergence (`PR #2921` Merged in 4m 17s) & Pipelined Leg 3 Start",
                "`W2-REL` (`PR #2921`) passed both `I-Gate R1` (`#5799143446`) and `A-Gate R1` (`#6683228816`) on the first commit (`15be7c83`) and merged in `4m 17s`, while `Car 70-B` (`PR #2919`) and `Car 70-A` (`PR #2920`) were already pipelined in parallel (`28m 20s` cross-version overlap).",
            ),
        ],
        "pm_warn": [
            (
                "1. Cross-Suite Schema `v79` Migration Rewind Drift on `PR #2918` (`KR2-01`)",
                "Adding SQLite schema migration `v79` in `Car 69-A` (`PR #2918`, `#1713`) caused `test/store-bridge-migration.test.js` and `test/api-coordinator-rotation.test.js` to fail in Stage 2 CI run `42199108757`. **Fix / Guardrail (`Ruling A505-R2.7` & `KR2-01`):** Expanded `Car 69-A`'s envelope under `Ruling A505-R2.7` (`#6682519207`) and pinned explicit schema numbers in commit `5250fcb1`.",
            ),
            (
                "2. Premature CSS Comment Termination From `*/` Glob Sequence in `PR #2917` (`KR2-02`)",
                "A CSS block comment in `PR #2917` Round 5 (`c5373588`) contained a literal `*/` file glob, breaking CSS comment parsing in Stage 2 UI tests. **Fix / Guardrail (`KR2-02`):** Replaced the glob inside the CSS comment in Round 6 (`4fcd6cae`) and banned `*/` globs inside `/* ... */` comments.",
            ),
            (
                "3. In-Flight Broadcast Cooldown Reservation Race (`PR #2916` R1–R4)",
                "In `PR #2916`, `TC-Lane-PRR-B` (`#5798277678`, `#5798560711`) identified that an in-flight broadcast retry or late-completing failure could overwrite a newer broadcast's cooldown reservation. **Fix / Guardrail:** Keyed cooldown cleanup to a per-attempt reservation token in Round 4 (`e273cba0`).",
            ),
            (
                "4. Zero-Unread Compose Reachability & Draft Preservation in `@nickname` Composer (`PR #2917` R2–R5)",
                "In `PR #2917`, `TC-Lane-PRR-B` caught that users with `0` unread messages needed a direct compose trigger and that editing the input while a send was in flight could clear the new draft on resolve. **Fix / Guardrail:** Added zero-unread compose access and snapshot-based input clearing in `c5373588`.",
            ),
        ],
        "next_sprint_cards": [
            (
                "KAIZEN FEED-FORWARD KR2-01 · SCHEMA MIGRATION TEST PARITY",
                "Include `test/store-bridge-migration.test.js` Whenever `lib/store/_schema.js` Advances",
                "Carried forward into `v5.70.0` and `v5.71.0` (`Ruling A505-R4.4` on `Car 71-A` schema `v80`): any car incrementing `CURRENT_SCHEMA_VERSION` must run migration rewind suites before pushing.",
            ),
            (
                "KAIZEN FEED-FORWARD KR2-02 · CSS COMMENT SYNTAX GUARD",
                "Never Place Literal `*/` Path Globs Inside CSS `/* ... */` Block Comments",
                "Enforced across `v5.70.0` and `v5.71.0` (`Car 71-C` `public/session.css`): zero CSS comment parse failures occurred in Legs 3–4.",
            ),
            (
                "KAIZEN FEED-FORWARD KR2-03 · ISOLATE UI VOCABULARY CARS FROM BACKEND/CLI CARS",
                "Isolate `#2127` (`Car 70-C`) From `#2626` (`Car 70-A`) and `#1485 + #1774` (`Car 70-B`)",
                "Applied in `v5.70.0` (`Ruling A505-R3`): `Car 70-A` (TCC migration), `Car 70-B` (hands-off repo + `tc capture`), and `Car 70-C` (Orchestrator vocabulary + `public/sw.js`) are 100% file-disjoint.",
            ),
            (
                "LEG 3 EXECUTION · SPRINT v5.70.0 (MILESTONE #57 · 4 ISSUES PIPELINED)",
                "Complete `Car 70-A` (`#2626`), `Car 70-B` (`#1485, #1774`) & `Car 70-C` (`#2127`)",
                "`Car 70-B` (`PR #2919`) and `Car 70-A` (`PR #2920`) are already open and in review (`28m 20s` overlap with `v5.69.0`), accelerating Leg 3 convergence.",
            ),
            (
                "COST-GATED SCOPE BOUNDARY · ORCHESTRATOR VOCABULARY (#2127)",
                "Enforce Additive Vocabulary Contract (`Ruling A505-R3.6`) Without Breaking `v5.x` DB/API Keys",
                "Per `#2127`'s cost-gated scope rule, `v5.70.0` lands the additive `Orchestrator` vocabulary contract, `@orchestrator` alias routing, and `v6.0` rename inventory while preserving internal `master` storage keys.",
            ),
            (
                "LEG 4 PIPELINING · SPRINT v5.71.0 (MILESTONE #58 · 6 OPENCLAW ISSUES)",
                "Stage `Car 71-A` (`#1531, #363, #297`), `Car 71-B` (`#254`) & `Car 71-C` (`#1185, #128`)",
                "Dispatch Leg 4 Wave 1 cars on idle builders as soon as `v5.70.0` cars reach Dual-Gate certification.",
            ),
        ],
    },
    "v5.70.0": {
        "slug": "v5.70.0",
        "version": "v5.70.0",
        "milestone_num": 57,
        "charter": "Charter A505 v1.0",
        "leg_label": "Leg 3 of 4 (Charter A505 v1.0)",
        "theme": "Workspace TCC migration, hands-off repo mode & Orchestrator CLI",
        "release_notes_title": "Workspace migration and Orchestrator controls",
        "base_version": "v5.69.0",
        "base_sha_short": "6c446dac",
        "rel_pr": 2926,
        "rel_head_short": "e91060c4",
        "rel_merge_sha": "c8d5d07878129305b24e431c808838cc1e4d392b",
        "rel_merge_short": "c8d5d078",
        "tag_sha_short": "910cd8fe",
        "rel_run_id": "42220194812",
        "backup_sha": "c8d5d07878129305b24e431c808838cc1e4d392b",
        "ogate_comment_id": "6685814655",
        "feature_loc_label": "+2,292 / -37 net (32 files; +2,259 / -33 feat PRs)",
        "meta_description": (
            "Executed 100% unattended across 2 coordinated waves on base v5.69.0 (6c446dac) as Leg 3 of 4 under "
            "Charter A505 v1.0 (Milestone #57) and SPRINT_REPORT_CONTRACT v2.0.0, closing all 4 chartered issues "
            "(#2626, #1485, #1774, #2127) across 4 true-merged PRs (#2920, #2919, #2922, #2926)."
        ),
        "eyebrow": "● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #57 (v5.70.0) · CHARTER A505 v1.0 LEG 3/4 · KAIZEN RETRO #3",
        "hero_sub_html": (
            'Executed <strong>100% unattended overnight (<code>0</code> human inputs)</strong> across <strong>2 coordinated waves</strong> '
            'on base <code>6c446dac</code> (<code>tag: v5.69.0</code>) as <strong>Leg 3 of 4</strong> under <strong>Charter <code>A505 v1.0</code></strong>, '
            '<strong>Architect Rulings <code>A505-R3 / R3.3–R3.10</code></strong>, and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>. '
            'Shipped <strong>4 Sprint PRs (#2920, #2919, #2922, #2926)</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), '
            'closing all <strong>4 active chartered Milestone #57 issues (#2626, #1485, #1774, #2127; <code>open_issues: 0, closed_issues: 4</code>)</strong> '
            'with <strong>0 post-merge defects on <code>main</code></strong> and <strong><code>+2,292 / -37</code> net repository lines of code across 32 files '
            '(<code>+2,259 / -33</code> across 28 feature PR file touches)</strong>. '
            'With <code>28m 20s</code> of cross-version pipeline overlap from Leg 2, Wave 1 shipped: '
            '<code>Car 70-A PR #2920</code> (<code>#2626</code>: guided macOS TCC workspace-root migration planner &amp; transactional mover from <code>~/Documents/Projects</code> '
            'to <code>~/Projects</code> with Git worktree relinking and full rollback on failure in <code>lib/tcc-workspace-migration.js</code>; merged at <code>b3213b43</code>), '
            '<code>Car 70-B PR #2919</code> (<code>#1485 + #1774</code>: per-project <code>repoFootprint: "hands-off"</code> mode writing untracked <code>CLAUDE.local.md</code> '
            'and skipping tracked-file wrap commit/PR steps, plus the audited read-only <code>tc capture &lt;session&gt; [--lines N]</code> CLI verb with secret redaction and '
            '<code>SUBVERB_MANIFEST</code> parity; merged at <code>96303c7e</code>), and '
            '<code>Car 70-C PR #2922</code> (<code>#2127</code>: additive <code>Orchestrator</code> canonical role vocabulary contract, <code>v6.0</code> rename inventory, '
            'and server-stamped <code>isMaster: true, role: "orchestrator"</code> Team Chat <code>@orchestrator</code>/<code>@master</code> resolution in <code>lib/medusa.js</code>; merged at <code>876e090e</code>).'
        ),
        "plain_english_headline": "Guided macOS TCC Workspace Migration (`~/Projects`), Hands-Off Repository Mode, Read-Only `tc capture` CLI & Canonical `Orchestrator` Role Vocabulary",
        "plain_english_intro": (
            "Sprint <code>v5.70.0</code> (<strong>“Workspace TCC migration, hands-off repo mode &amp; Orchestrator CLI”</strong>, "
            "Leg 3 of the 4-version Charter <code>A505 v1.0</code> train) ran 100% unattended and closed all "
            "<strong>4 Milestone #57 issues across 4 pull requests</strong> (<code>+2,292 / -37</code> net LOC across 32 files):"
        ),
        "plain_english_pillars": [
            (
                "1. Guided macOS TCC Workspace Root Migration to `~/Projects` (#2626 · Car 70-A PR #2920)",
                "<code>Car 70-A</code> (<code>PR #2920</code>, <code>+693 / -2</code> LOC across <code>4</code> files) delivers <code>lib/tcc-workspace-migration.js</code> "
                "to plan and execute moves of project folders out of macOS TCC-protected <code>~/Documents/Projects</code> into <code>~/Projects</code>, "
                "detecting active-session or target-collision blockers, relinking Git worktrees, and rolling back cleanly if any step fails.",
            ),
            (
                "2. Per-Project `hands-off` Repository Footprint & `tc capture` CLI Verb (#1485, #1774 · Car 70-B PR #2919)",
                "<code>Car 70-B</code> (<code>PR #2919</code>, <code>+910 / -10</code> LOC across <code>14</code> files) adds <code>repoFootprint: &quot;hands-off&quot;</code> "
                "so external repositories receive only an untracked <code>CLAUDE.local.md</code> guide and skip tracked-file wrap commits (<code>#1485</code>), "
                "and adds <code>tc capture &lt;session-name&gt; [--lines N]</code> for credential-redacted, audited tmux pane inspection (<code>#1774</code>).",
            ),
            (
                "3. Canonical `Orchestrator` Role Terminology Contract & Server-Verified `@orchestrator` Routing (#2127 · Car 70-C PR #2922)",
                "<code>Car 70-C</code> (<code>PR #2922</code>, <code>+656 / -21</code> LOC across <code>10</code> files) establishes <code>Orchestrator</code> as the "
                "canonical display/vocabulary term with a <code>v6.0</code> internal-identifier inventory, and stamps <code>isMaster: true, role: &quot;orchestrator&quot;</code> "
                "at the server roster source so <code>@orchestrator</code> and <code>@master</code> resolve deterministically without prefix spoofing.",
            ),
        ],
        "cars": [
            {
                "car_id": "Car 70-A",
                "wave_phase": "Wave 1 (Car 70-A)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2920,
                "head_short": "f808d3a0",
                "merge_sha": "b3213b436fe1594b3a65752cbb218ff3b3a31a0c",
                "merge_short": "b3213b43",
                "issues": [2626],
                "files_count": 4,
                "additions": 693,
                "deletions": 2,
                "title": "feat(tcc): guided workspace root migration to ~/Projects (#2626)",
                "files_list": "`lib/tcc-workspace-migration.js`, `docs/areas.json`, `test/tcc-folders.test.js`, `changelog.d/2626.tcc-workspace-root-migration.added.md`",
                "summary": "Implements `lib/tcc-workspace-migration.js` planner and transactional executor to migrate workspaces from `~/Documents/Projects` to `~/Projects`, repairing `.git` worktree pointers and rolling back filesystem + DB state on any failure (`Ruling A505-R3.4`).",
                "verification": "`PRR-B R4 PASS (#5799196571)` + `Arc R4 PASS (#6683320376)`",
                "tags": "wave-1 tcc migration",
            },
            {
                "car_id": "Car 70-B",
                "wave_phase": "Wave 1 (Car 70-B)",
                "builder": "TC-Lane-D (#1533)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2919,
                "head_short": "bd890310",
                "merge_sha": "96303c7ec5d0b940678ec5759162e474dd7242da",
                "merge_short": "96303c7e",
                "issues": [1485, 1774],
                "files_count": 14,
                "additions": 910,
                "deletions": 10,
                "title": "Add per-project hands-off repo footprint and the tc capture CLI verb (#1485, #1774)",
                "files_list": "`lib/engines.js`, `lib/wrap-pipeline.js`, `lib/wrap-steps/commit.js`, `lib/wrap-steps/pr-check.js`, `lib/tc-verbs.js`, `lib/routes/tc.js`, `lib/operating-primer.js`, `docs/tc-cli-reference.md`, `docs/manual-manifest.json`, `test/wrap-tc-owned-paths.test.js`, `test/tc-verbs.test.js`, `test/ecosystem-primer.test.js`",
                "summary": "Adds `repoFootprint: 'hands-off'` mode (protecting tracked `CLAUDE.local.md` files via `git ls-files --error-unmatch` and skipping wrap commit/PR steps, `#1485`) and `tc capture` read-only tmux pane capture with credential redaction and `SUBVERB_MANIFEST` parity (`#1774`, `Rulings A505-R3.3, A505-R3.8`).",
                "verification": "`PRR-A R6 PASS (#5799666014)` + `Arc R6 PASS (#6684119537)`",
                "tags": "wave-1 handsoff capture cli",
            },
            {
                "car_id": "Car 70-C",
                "wave_phase": "Wave 1 (Car 70-C)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2922,
                "head_short": "8d07d34e",
                "merge_sha": "876e090ebe82ac1a06c9eb7a83f7de6336f58b26",
                "merge_short": "876e090e",
                "issues": [2127],
                "files_count": 10,
                "additions": 656,
                "deletions": 21,
                "title": "Land the Orchestrator role terminology vocabulary contract and inventory (#2127)",
                "files_list": "`lib/master.js`, `lib/master-authority.js`, `lib/master-continuity.js`, `lib/medusa.js`, `public/api-helper.js`, `public/sw.js`, `test/master-authority.test.js`, `test/master-medusa.test.js`, `test/medusa-control-component.test.js`, `changelog.d/2127.*.md`",
                "summary": "Establishes `Orchestrator` as the canonical role vocabulary with a `v6.0` breaking-rename inventory (`Rulings A505-R3.6, A505-R3.7, A505-R3.9`) and stamps authoritative `isMaster: true, role: 'orchestrator'` in `lib/medusa.js#getRoster` (`Ruling A505-R3.10`) so `@orchestrator` and `@master` resolve without lookalike/prefix spoofing.",
                "verification": "`PRR-B R4 PASS (#5799904668)` + `Arc R4 PASS (#6684549164)`",
                "tags": "wave-1 orchestrator vocabulary",
            },
        ],
        "rel_files_count": 12,
        "rel_additions": 91,
        "rel_deletions": 62,
        "rel_verification": "`PRR-A R1 PASS (#5800522494)` + `Arc R1 PASS (#6684885080)` + `Obsr O-Gate PASS (#6685814655)`",
        "kaizen_title": "Kaizen Retro #3 (v5.70.0 → v5.71.0) — Closed-Loop Findings & Feed-Forward Rules",
        "kaizen_badge": "Mandatory Per-Version Kaizen Retro #3 · 3 Findings Codified into v5.71.0 (#58)",
        "kaizen_items": [
            (
                "Finding KR3-01 (Two-Way Verb Manifest Parity `VERB_ROSTER <-> SUBVERB_MANIFEST`)",
                "In `Car 70-B` (`PR #2919`, `#1774`), adding the new top-level `tc capture` verb to `VERB_ROSTER` in `lib/tc-verbs.js` passed `test/tc-verbs.test.js` in Round 5 (`2b5266a8`), but Stage 2 CI caught that `test/tc-primer.test.js` requires every top-level verb in `VERB_ROSTER` to also register in `SUBVERB_MANIFEST` and `ROLE_VERB_IDS` in `lib/operating-primer.js` (`Ruling A505-R3.8`, `#6683844596`). **Feed-Forward Action injected into `v5.71.0`:** Run `node --test test/tc-verbs.test.js test/tc-primer.test.js` together whenever CLI verbs or primers are touched.",
            ),
            (
                "Finding KR3-02 (Authoritative Server Roster Identity Over Name/Prefix Heuristics · `Ruling A505-R3.10`)",
                "In `Car 70-C` (`PR #2922`, `#2127`), `TC-Lane-PRR-B` (`#5799693931`) proved that client-side prefix/name matching for `@orchestrator` / `@master` could match a non-master session named `master-helper` if the real Orchestrator was offline. Stamping `isMaster: true, role: 'orchestrator'` directly at the server roster source (`lib/medusa.js#getRoster` via `listeners.get('master')?.workspaceId`, `Ruling A505-R3.10` `#6684249238`) eliminated lookalike spoofing. **Feed-Forward Action injected into `v5.71.0`:** For OpenClaw connection resilience and health pills (`#1531, #363, #254, #297, #1185, #128`), stamp authoritative server state rather than inferring state from client string heuristics.",
            ),
            (
                "Finding KR3-03 (Single-Builder Round Dispatch & Rotated Codex Wakeup)",
                "During multi-round review follow-ups in `v5.70.0`, dispatching a revision to a single designated builder lane avoided duplicate branch pushes, and pairing Medusa dispatches to rotated Codex lanes (`TC-Lane-INT`, `TC-Lane-PRR-A/B`) with `POST /api/sessions/:project/command` guaranteed immediate wakeup when `startup_control_channels.adapter_state.threadId` predated a `/new` rotation. **Feed-Forward Action injected into `v5.71.0`:** Enforce single-builder round ownership and dual Medusa + command wakeup for rotated Codex sessions in Leg 4 (`v5.71.0`).",
            ),
        ],
        "pm_worked": [
            (
                "1. Cross-Version Pipeline Overlap (`28m 20s` Leg 2→3 and `2h 06m 26s` Leg 3→4)",
                "`Car 70-B` (`PR #2919`) and `Car 70-A` (`PR #2920`) began during `v5.69.0` Wave 2, and all 3 `v5.71.0` feature cars (`#2923, #2924, #2925`) were dispatched and built in parallel while `v5.70.0` completed final reviews, compressing the subsequent `v5.70.0 → v5.71.0` inter-release deploy cadence to just `45m 30s`.",
            ),
            (
                "2. Cost-Gated Architectural Scope Governance on `#2127` (`Ruling A505-R3.6`)",
                "Issue `#2127` explicitly included a cost-gated scope clause: if renaming internal `master` identifiers exceeded ~15 files or risked breaking external scripts, ship the additive `Orchestrator` vocabulary contract + `v6.0` inventory in `v5.x`. `TC-Lane-Arc` issued `Ruling A505-R3.6` (`#6683320878`) enforcing that exact boundary.",
            ),
            (
                "3. Fail-Closed Tracked-File Protection in `hands-off` Repository Mode (`#1485`, `PR #2919`)",
                "`TC-Lane-PRR-A` (`#5798923613`–`#5799233868`) rigorously tested `repoFootprint: 'hands-off'` against repositories where `CLAUDE.local.md` is already tracked in Git (or via symlinks), ensuring `lib/engines.js` checks `git ls-files --error-unmatch` and refuses to overwrite tracked files.",
            ),
            (
                "4. Transactional Worktree Rollback Verification in `lib/tcc-workspace-migration.js` (`#2626`, `PR #2920`)",
                "`TC-Lane-PRR-B` (`#5798981512`–`#5799196571`) verified `Car 70-A` against real multi-worktree Git repositories and pre-existing target directory collisions, ensuring a mid-migration failure restores both filesystem directories and `.git/worktrees` links.",
            ),
        ],
        "pm_warn": [
            (
                "1. `VERB_ROSTER <-> SUBVERB_MANIFEST` Parity Gap on `tc capture` (`PR #2919` R5 → R6 · `KR3-01`)",
                "Adding `capture` to `VERB_ROSTER` in `lib/tc-verbs.js` without adding its entry to `SUBVERB_MANIFEST` in `lib/operating-primer.js` caused `test/tc-primer.test.js` to fail in Stage 2 CI after Round 5. **Fix / Guardrail (`Ruling A505-R3.8` & `KR3-01`):** Added `lib/operating-primer.js` to `Car 70-B`'s envelope and wired two-way verb manifest parity in Round 6 (`bd890310`).",
            ),
            (
                "2. Lookalike Prefix Spoofing When Orchestrator Is Offline (`PR #2922` R2 → R4 · `KR3-02`)",
                "In `PR #2922` Round 3 (`c0386ff3`), client-side fallback matching for `@orchestrator` / `@master` could still match an impostor peer when the real Orchestrator was absent from the roster. **Fix / Guardrail (`Ruling A505-R3.10` & `KR3-02`):** Stamped authoritative `isMaster: true, role: 'orchestrator'` in `lib/medusa.js#getRoster` (`8d07d34e`) so client resolution trusts only the server-verified stamp.",
            ),
            (
                "3. Symlink & Non-Git Directory Edge Cases When Writing `CLAUDE.local.md` (`PR #2919` R1–R5)",
                "In `PR #2919`, `TC-Lane-PRR-A` caught that `git ls-files --error-unmatch` exits `128` in non-Git directories (which must allow writing untracked `CLAUDE.local.md`) whereas tracked symlinks must be blocked. **Fix / Guardrail:** Distinguished exit code `1` (untracked) and `128` (non-repo) from tracked files/symlinks in `2b5266a8`.",
            ),
            (
                "4. Dry-Run-to-Execution Target Path Race in `lib/tcc-workspace-migration.js` (`PR #2920` R3 → R4)",
                "In `PR #2920`, `TC-Lane-PRR-B` (`#5799121198`) noted that a target directory created between `planWorkspaceRootMigration()` and `executeWorkspaceRootMigration()` could cause `fs.renameSync` to collide. **Fix / Guardrail:** Re-verified target non-existence immediately before each move in Round 4 (`f808d3a0`).",
            ),
        ],
        "next_sprint_cards": [
            (
                "KAIZEN FEED-FORWARD KR3-01 · CLI VERB & PRIMER MANIFEST PARITY",
                "Run `test/tc-verbs.test.js` and `test/tc-primer.test.js` Together on Any CLI Change",
                "Codified from `PR #2919` (`Ruling A505-R3.8`) so top-level `VERB_ROSTER` and `SUBVERB_MANIFEST` never drift.",
            ),
            (
                "KAIZEN FEED-FORWARD KR3-02 · SERVER-AUTHORITATIVE STATE STAMPS",
                "Stamp Authoritative Connection & Health State on the Server in `v5.71.0` (`#1185, #128`)",
                "Applied directly in `Car 71-C` (`PR #2923`): `lib/sidecar.js` and `lib/openclaw-detect.js` compute authoritative liveness and `telemetryFresh` flags on the server rather than relying on browser heuristics.",
            ),
            (
                "KAIZEN FEED-FORWARD KR3-03 · ROTATED CODEX WAKEUP RELIABILITY",
                "Pair Medusa Dispatches With `POST /api/sessions/:project/command` on Rotated Codex Lanes",
                "Applied in Leg 4 (`v5.71.0`): all `TC-Lane-PRR-A/B` and `TC-Lane-INT` dispatches completed with zero stale-thread wakeup delays.",
            ),
            (
                "LEG 4 CONVERGENCE · SPRINT v5.71.0 (MILESTONE #58 · 6 ISSUES)",
                "Merge Pipelined Cars `71-B` (`#2925`), `71-C` (`#2923`) & `71-A` (`#2924`)",
                "All 3 `v5.71.0` feature cars are already built and in final review (`2h 06m 26s` overlap with `v5.70.0`), ready for sequential true-merge integration onto `v5.70.0` (`c8d5d078`).",
            ),
            (
                "OPENCLAW FALLBACK & TELEMETRY HARDENING (#1531, #363, #297, #254, #1185, #128)",
                "Verify Probe-First SSH Failover, CSRF Bootstrap & 2-Minute Liveness Aging",
                "Complete `I-Gate` and `A-Gate` verification across all 6 OpenClaw connection resilience and visibility issues in Milestone `#58`.",
            ),
            (
                "TRAIN CLOSEOUT · 4-VERSION RETROSPECTIVE & KAIZEN MATRIX",
                "Cut `v5.71.0` (`PR #2927`), Deploy to `:3102` & Publish 4-Release Retrospective",
                "Close Milestone `#58` (`20/20` train issues closed) and publish `v5.68.0-v5.71.0-retrospective` under `SPRINT_REPORT_CONTRACT v2.0.0`.",
            ),
        ],
    },
    "v5.71.0": {
        "slug": "v5.71.0",
        "version": "v5.71.0",
        "milestone_num": 58,
        "charter": "Charter A505 v1.0",
        "leg_label": "Leg 4 of 4 — Final Release of Charter A505 v1.0 Train",
        "theme": "OpenClaw connection resilience, proxy hardening & header telemetry",
        "release_notes_title": "OpenClaw connection resilience and visibility",
        "base_version": "v5.70.0",
        "base_sha_short": "c8d5d078",
        "rel_pr": 2927,
        "rel_head_short": "f53080f5",
        "rel_merge_sha": "3162811af43714b6d83ef4a43e6602adaead2785",
        "rel_merge_short": "3162811a",
        "tag_sha_short": "452733f0",
        "rel_run_id": "42229856634",
        "backup_sha": "3162811af43714b6d83ef4a43e6602adaead2785",
        "ogate_comment_id": "6686725521",
        "feature_loc_label": "+3,889 / -68 net (39 files; +3,852 / -63 feat PRs)",
        "meta_description": (
            "Executed 100% unattended across 2 coordinated waves on base v5.70.0 (c8d5d078) as Leg 4 of 4 under "
            "Charter A505 v1.0 (Milestone #58) and SPRINT_REPORT_CONTRACT v2.0.0, closing all 6 chartered issues "
            "(#1531, #363, #297, #254, #1185, #128) across 4 true-merged PRs (#2925, #2923, #2924, #2927)."
        ),
        "eyebrow": "● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #58 (v5.71.0) · CHARTER A505 v1.0 LEG 4/4 · KAIZEN RETRO #4",
        "hero_sub_html": (
            'Executed <strong>100% unattended overnight (<code>0</code> human inputs)</strong> across <strong>2 coordinated waves</strong> '
            'on base <code>c8d5d078</code> (<code>tag: v5.70.0</code>) as the <strong>4th and Final Leg</strong> of <strong>Charter <code>A505 v1.0</code></strong>, '
            '<strong>Architect Rulings <code>A505-R4.1–R4.5</code></strong>, and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>. '
            'Shipped <strong>4 Sprint PRs (#2925, #2923, #2924, #2927)</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), '
            'closing all <strong>6 active chartered Milestone #58 issues (#1531, #363, #297, #254, #1185, #128; <code>open_issues: 0, closed_issues: 6</code>)</strong> '
            'with <strong>0 post-merge defects on <code>main</code></strong> and <strong><code>+3,889 / -68</code> net repository lines of code across 39 files '
            '(<code>+3,852 / -63</code> across 37 feature PR file touches)</strong>. '
            'Built with <code>2h 06m 26s</code> (<code>73.5%</code>) of cross-version pipeline overlap during Leg 3 so the final post-<code>v5.70.0</code> deploy tail took just <code>45m 30s</code>: '
            '<code>Car 71-B PR #2925</code> (<code>#254</code>: strips stale Cloudflare attribution headers on HTTP and WebSocket <code>/openclaw-direct/</code> proxy requests and injects a '
            'CSRF-authenticated browser device-pairing continuity bridge in <code>lib/openclaw-html.js</code> and <code>server.js</code>; merged at <code>5c0da906</code>), '
            '<code>Car 71-C PR #2923</code> (<code>#1185 + #128</code>: re-derives OpenClaw connection-dot liveness on every sidecar poll cycle with a 2-minute staleness ceiling and renders '
            'cached CPU, memory, disk, and fail-closed health pills in <code>public/openclaw-view.js</code>; merged at <code>6b19c061</code>), and '
            '<code>Car 71-A PR #2924</code> (<code>#1531 + #363 + #297</code>: ordered fallback SSH hosts with probe-first interactive failover and schema <code>v80</code> persistence, '
            'operator-confirmed MagicDNS host migration retaining the former IP as fallback, and GHCR update-available badge + validated <code>.env</code> tag-update helper; merged at <code>39c37fca</code>).'
        ),
        "plain_english_headline": "Ordered Fallback SSH Hosts & MagicDNS Migration, Update-Available Indicator, Direct Proxy Header/Pairing Continuity, and Live Connection-Dot & Resource Health Pills",
        "plain_english_intro": (
            "Sprint <code>v5.71.0</code> (<strong>“OpenClaw connection resilience, proxy hardening &amp; header telemetry”</strong>, "
            "the 4th and final leg of Charter <code>A505 v1.0</code>) ran 100% unattended and closed all "
            "<strong>6 Milestone #58 issues across 4 pull requests</strong> (<code>+3,889 / -68</code> net LOC across 39 files), completing all 20/20 overnight sprint issues:"
        ),
        "plain_english_pillars": [
            (
                "1. Ordered Fallback SSH Hosts, MagicDNS Migration & Update-Available Badge (#1531, #363, #297 · Car 71-A PR #2924)",
                "<code>Car 71-A</code> (<code>PR #2924</code>, <code>+2,152 / -31</code> LOC across <code>18</code> files) allows each OpenClaw connection to configure "
                "ordered fallback SSH hosts with probe-first interactive failover (<code>#1531</code>), migrates brittle IP literals to Tailscale MagicDNS hostnames "
                "while keeping the IP as an automatic fallback (<code>#363</code>), and shows an update-available badge on the landing page when newer GHCR image tags exist (<code>#297</code>).",
            ),
            (
                "2. Direct Proxy Attribution Header Stripping & Device-Pairing Continuity (#254 · Car 71-B PR #2925)",
                "<code>Car 71-B</code> (<code>PR #2925</code>, <code>+551 / -8</code> LOC across <code>5</code> files) strips stale Cloudflare attribution headers "
                "(<code>CF-Connecting-IP</code>, <code>X-Forwarded-For</code>, <code>True-Client-IP</code>) from <code>/openclaw-direct/</code> HTTP and WebSocket proxy requests "
                "and injects a stable browser identity + CSRF-authenticated device-approval bridge (<code>#254</code>).",
            ),
            (
                "3. Live Connection-Dot Liveness Aging & Header CPU/Memory/Disk/Health Pills (#1185, #128 · Car 71-C PR #2923)",
                "<code>Car 71-C</code> (<code>PR #2923</code>, <code>+1,149 / -24</code> LOC across <code>14</code> files) re-evaluates the OpenClaw connection dot on every "
                "sidecar poll cycle—aging stale gateway readings out of <code>live</code> after 2 minutes (<code>#1185</code>)—and renders CPU, RAM, disk, and fail-closed "
                "health pills in the OpenClaw header from cached SSH telemetry (<code>#128</code>).",
            ),
        ],
        "cars": [
            {
                "car_id": "Car 71-B",
                "wave_phase": "Wave 1 (Car 71-B)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2925,
                "head_short": "87cb6539",
                "merge_sha": "5c0da9069a5a52887f27a85575b683338acd8544",
                "merge_short": "5c0da906",
                "issues": [254],
                "files_count": 5,
                "additions": 551,
                "deletions": 8,
                "title": "Fix openclaw-direct remote-IP leakage and device-pairing continuity (#254)",
                "files_list": "`server.js`, `lib/openclaw-html.js`, `test/openclaw-direct-trailing-slash.test.js`, `test/openclaw-html.test.js`, `changelog.d/254.*.md`",
                "summary": "Strips Cloudflare/proxy client-IP headers on both HTTP and WebSocket `/openclaw-direct/` proxy paths and injects a stable browser identity bridge + `X-CSRF-Token`-authenticated `/api/openclaw/direct-connect/pairing` auto-approval helper (`#254`, `Ruling A505-R4.5`).",
                "verification": "`PRR-A R3 PASS (#5799900571)` + `Arc R3 PASS (#6684549386)`",
                "tags": "wave-1 proxy pairing csrf",
            },
            {
                "car_id": "Car 71-C",
                "wave_phase": "Wave 1 (Car 71-C)",
                "builder": "TC-Lane-D (#1533)",
                "reviewer": "TC-Lane-PRR-A (#1536) & TC-Lane-Arc (#1538)",
                "pr": 2923,
                "head_short": "a2b7baa2",
                "merge_sha": "6b19c061e30c32493c1328196c2079a82b94fe4f",
                "merge_short": "6b19c061",
                "issues": [1185, 128],
                "files_count": 14,
                "additions": 1149,
                "deletions": 24,
                "title": "feat(openclaw): Car 71-C — connection dot liveness re-derivation + header resource/health pills (#1185, #128)",
                "files_list": "`lib/openclaw-detect.js`, `lib/sidecar.js`, `lib/routes/audit.js`, `public/openclaw-tunnel-state.js`, `public/openclaw-view.html`, `public/openclaw-view.js`, `public/session.css`, `public/sw.js`, `test/openclaw-detect.test.js`, `test/openclaw-tunnel-state.test.js`, `test/sidecar-openclaw.test.js`, `test/ui-openclaw.test.js`",
                "summary": "Re-derives OpenClaw connection-dot state on each sidecar poll cycle with a 2-minute staleness threshold (`#1185`) and wires cached SSH telemetry + fail-closed `telemetryFresh` health into `GET /api/sidecar/connection/:connId/processes` and header pills in `public/openclaw-view.js` (`#128`, `Rulings A505-R4.1, A505-R4.3`).",
                "verification": "`PRR-A R4 PASS (#5800610247)` + `Arc R4 PASS (#6685779100)`",
                "tags": "wave-1 liveness pills telemetry",
            },
            {
                "car_id": "Car 71-A",
                "wave_phase": "Wave 1 (Car 71-A)",
                "builder": "TC-Lane-B (#1555)",
                "reviewer": "TC-Lane-PRR-B (#1539) & TC-Lane-Arc (#1538)",
                "pr": 2924,
                "head_short": "5237b7d0",
                "merge_sha": "39c37fca5fdb4d58886d082b863d8c2ca17fe6fc",
                "merge_short": "39c37fca",
                "issues": [1531, 363, 297],
                "files_count": 18,
                "additions": 2152,
                "deletions": 31,
                "title": "feat(openclaw): Car 71-A — ordered fallback hosts, MagicDNS migration, update-available check (#1531, #363, #297)",
                "files_list": "`lib/openclaw-remote.js`, `lib/openclaw-version.js`, `lib/routes/openclaw.js`, `lib/sessions.js`, `lib/ssh-target-safety.js`, `lib/store.js`, `lib/store/_schema.js`, `lib/tunnel.js`, `lib/tunnel-monitor.js`, `public/landing.js`, `test/openclaw-remote.test.js`, `test/openclaw-version.test.js`, `test/ssh-target-safety.test.js`, `test/store-openclaw.test.js`",
                "summary": "Adds schema `v80` `fallback_hosts` and ordered SSH host failover with probe-first interactive launch (`#1531`), IP-literal audit and operator-confirmed MagicDNS hostname migration retaining the IP as fallback (`#363`), and GHCR update-available comparison + landing badge + validated `.env` tag updater (`#297`, `Rulings A505-R4.2, A505-R4.4, A505-R4.5`).",
                "verification": "`PRR-B R8 PASS (#5800741969)` + `Arc R8 PASS (#6686003782)`",
                "tags": "wave-1 fallback magicdns update",
            },
        ],
        "rel_files_count": 14,
        "rel_additions": 75,
        "rel_deletions": 43,
        "rel_verification": "`PRR-A R2 PASS (#5801056822)` + `Arc R2 PASS (#6686510316)` + `Obsr O-Gate PASS (#6686725521)`",
        "kaizen_title": "Kaizen Retro #4 (v5.71.0 → Next Sprint Train) — Closed-Loop Findings & Feed-Forward Rules",
        "kaizen_badge": "Mandatory Per-Version Kaizen Retro #4 · 3 Findings Codified for v5.72.0+ Trains",
        "kaizen_items": [
            (
                "Finding KR4-01 (Probe-First Interactive SSH Failover · `#1531 / PR #2924 R7 → R8`)",
                "Chaining `ssh ... openclaw-cli` directly with `||` or `[ $? -eq 255 ]` conflates SSH transport failures (`255`) with a connected remote host whose `openclaw-cli` exits `255` (`I-Gate R6 #5800528493` & `R7 #5800632374`). Selecting the reachable target first via a lightweight `ssh -o ConnectTimeout=5 ... true` probe loop and then invoking `openclaw-cli` once on the winning host (`5237b7d0`) cleanly decouples transport reachability from application exit status.",
            ),
            (
                "Finding KR4-02 (Synchronize `changelog.d/` Fragments When Review Rounds Expand Scope · `#128 / PR #2923 R2 → PR #2927 R2`)",
                "When `Ruling A505-R4.3` (`#6683543003`) expanded `Car 71-C` (`PR #2923`) in Round 2 so `lib/sidecar.js` feeds live cached SSH telemetry into `GET /api/sidecar/connection/:connId/processes`, the Round 1 `changelog.d/128.openclaw-header-health-pills.added.md` fragment still contained a caveat saying the sidecar poll did not yet pass telemetry. `TC-Lane-PRR-A` caught the contradiction in `PR #2927` Round 1 (`#5800985888`), and Round 2 (`f53080f5`) reconciled `CHANGELOG.md`, `FEATURES.md`, and `docs/releases/v5.71.0.md`.",
            ),
            (
                "Finding KR4-03 (Same-Origin CSRF Bootstrap on Injected Proxy HTML · `#254 / PR #2925 R1 → R3`)",
                "Injected `<head>` bootstrap scripts inside `/openclaw-direct/` (`POST /api/openclaw/direct-connect/pairing`) must read the readable `tc_csrf` cookie and attach `X-CSRF-Token` (`I-Gate R2 #5799782245` → fixed in `87cb6539`) so `authGate.evaluate()` accepts same-origin requests without weakening global CSRF enforcement.",
            ),
        ],
        "pm_worked": [
            (
                "1. 73.5% Cross-Version Pipeline Overlap (`2h 06m 26s`) Compressed Post-`v5.70.0` Deploy Tail to `45m 30s`",
                "All 3 `v5.71.0` feature cars (`#2923, #2924, #2925`) were built and reviewed in parallel while `v5.70.0` finished its final rounds. Once `v5.70.0` deployed at `13:15:00Z`, `Car 71-B` (`13:28:35Z`), `Car 71-C` (`13:32:25Z`), `Car 71-A` (`13:47:26Z`), and `W2-REL PR #2927` (`13:58:36Z`) landed in a `45m 30s` inter-release cadence.",
            ),
            (
                "2. Closed-Loop Application of `KR1-01`, `KR2-01`, `KR2-02` & `KR3-02` Across Leg 4",
                "`Car 71-C` (`PR #2923`) bumped `public/sw.js` (`KR1-01`), avoided `*/` globs in `public/session.css` (`KR2-02`), and stamped server-authoritative `telemetryFresh` state (`KR3-02`), while `Car 71-A` (`PR #2924`) included `test/launch-recovery-peer-clear.test.js` and schema `v80` migration checks (`KR2-01`).",
            ),
            (
                "3. Rigorous 8-Round `I-Gate` Verification on Interactive SSH Failover Semantics (`PR #2924`)",
                "`TC-Lane-PRR-B` (`#5799596392`–`#5800741969`) tested every failure mode of ordered SSH fallback hosts (`#1531`)—cold cache, warm cached route expiry, non-semver GHCR tags, remote command non-zero exit vs. SSH transport failure—resulting in the clean probe-first interactive failover architecture in Round 8 (`5237b7d0`).",
            ),
            (
                "4. Release-Note Truthfulness Catch on `PR #2927` (`I-Gate R1 → R2`)",
                "`TC-Lane-PRR-A` (`#5800985888`) caught that `CHANGELOG.md` and `docs/releases/v5.71.0.md` had inherited a stale Round 1 caveat from `changelog.d/128.*.md` contradicting the live `GET /api/sidecar/connection/:connId/processes` wiring shipped in `PR #2923` R2–R4, correcting all 3 files before `v5.71.0` merged.",
            ),
        ],
        "pm_warn": [
            (
                "1. Disambiguating SSH Transport Exit `255` From Remote CLI Exit `255` (`PR #2924` R6–R8 · `KR4-01`)",
                "In `PR #2924` Round 6–7 (`2e2a3e9e`, `5114801a`), chaining `ssh ... openclaw-cli` with `||` or checking `$? -eq 255` either retried connected hosts on normal command failures or misclassified remote CLI exit `255` as a transport failure. **Fix / Guardrail (`KR4-01`):** Probe reachability first via `ssh -o ConnectTimeout=5 ... true` before running `openclaw-cli` once on the first reachable host (`5237b7d0`).",
            ),
            (
                "2. Stale Round 1 `changelog.d/` Caveat Carried Into `W2-REL` (`PR #2927` R1 → R2 · `KR4-02`)",
                "When `Ruling A505-R4.3` wired live sidecar telemetry into `PR #2923` Round 2, `changelog.d/128.openclaw-header-health-pills.added.md` still said live sidecar polling was not yet wired. **Fix / Guardrail (`KR4-02`):** Updated `CHANGELOG.md`, `FEATURES.md`, and `docs/releases/v5.71.0.md` in `PR #2927` Round 2 (`f53080f5`) and required builders to refresh `changelog.d/` fragments whenever review rounds expand scope.",
            ),
            (
                "3. Same-Origin `X-CSRF-Token` Requirement on Injected `/openclaw-direct/` Pairing Bridge (`PR #2925` R2 → R3 · `KR4-03`)",
                "In `PR #2925` Round 2 (`8c293425`), the injected browser pairing script POSTed to `/api/openclaw/direct-connect/pairing` without attaching `X-CSRF-Token` from the `tc_csrf` cookie, causing `authGate.evaluate()` to reject it with `403`. **Fix / Guardrail (`KR4-03`):** Read `tc_csrf` and attached `X-CSRF-Token` in Round 3 (`87cb6539`).",
            ),
            (
                "4. Cross-Site `test/update-check.test.js` Wording Rule on Landing Badge (`PR #2924` R5 → R6)",
                "In `PR #2924` Round 5, Stage 2 CI caught that `test/update-check.test.js` requires update-available copy to qualify tag comparisons with `or newer` when local version metadata is unknown. **Fix / Guardrail:** Updated `public/landing.js` badge copy in Round 6 (`2e2a3e9e`).",
            ),
        ],
        "next_sprint_cards": [
            (
                "KAIZEN FEED-FORWARD KR4-01 · PROBE-FIRST INTERACTIVE SSH FAILOVER",
                "Decouple SSH Reachability Probes From Interactive Remote Command Execution",
                "Use lightweight `ssh -o ConnectTimeout=5 ... true` probes to select the reachable host before launching interactive commands so application exit codes never trigger false host failover.",
            ),
            (
                "KAIZEN FEED-FORWARD KR4-02 · CHANGELOG FRAGMENT SCOPE SYNC",
                "Refresh `changelog.d/*.md` in the Same Review Round Whenever Scope Rulings Expand Wiring",
                "Ensure `I-Gate` and Builders verify `changelog.d/*.md` prose against final Round-N code before `W2-REL` drains fragments.",
            ),
            (
                "KAIZEN FEED-FORWARD KR4-03 · SAME-ORIGIN PROXY CSRF HEADERS",
                "Attach `X-CSRF-Token` From `tc_csrf` in Any Injected Same-Origin Browser Helper",
                "Preserve strict global CSRF protection while enabling seamless same-origin helper POSTs from proxied UI views.",
            ),
            (
                "NEXT PLANNED TRAIN · MILESTONE #59 (v5.72.0 · 5 FULLY AUTONOMOUS ISSUES)",
                "Ship Session Hierarchy (`#108`), Engine Failover (`#109`), Adversarial Agent (`#1032`), Secure Secrets (`#1257`) & Dynamic Agents (`#1578`)",
                "All 5 remaining in-repo engineering issues are organized into `Milestone #59` (`v5.72.0`) on the public roadmap with a `⚡ Fully autonomous` execution pill.",
            ),
            (
                "HITL / VRF TRAIN · MILESTONE #60 (v5.73.0 · 3 EXTERNAL/HARDWARE ISSUES)",
                "Complete Linux `systemd` VRF (`#1564`), Vercel Roadmap Cutover (`#2258`) & Medusa#67 Idempotent Wake (`#2347`)",
                "Grouped into `Milestone #60` (`v5.73.0`) with a `👤 Requires VRF / HITL (3/3)` pill for coordinated Operator + Fleet execution.",
            ),
            (
                "ARCHITECTURE HOLDING · MILESTONE #61 (v6.0.0 · 5 MAJOR EPICS)",
                "Multi-User Architecture (`#1149`), Resource Containers (`#1151`), Fleet Pools (`#1886`), Native Charters (`#2118`) & Internal `Orchestrator` Rename (`#2126`)",
                "Organized into `Milestone #61` (`v6.0.0`) with a `🧭 Needs Operator v6 sign-off` pill.",
            ),
        ],
    },
    "v5.72.0": {
        "slug": "v5.72.0",
        "version": "v5.72.0",
        "milestone_num": 59,
        "charter": "Charter A506 v1.0",
        "leg_label": "Standalone Release (Charter A506 v1.0)",
        "theme": "Fleet authority, engine resilience, and release automation",
        "release_notes_title": "Fleet Coordinator delegation, Master lifecycle API tokens, engine failover, and TangleClaw branding",
        "base_version": "v5.71.0",
        "base_sha_short": "f2be147c",
        "rel_pr": 2959,
        "rel_head_short": "76fa2513",
        "rel_merge_sha": "8c91e331421416de4f1b7e838a37f0ff268db353",
        "rel_merge_short": "8c91e331",
        "tag_sha_short": "8c91e331",
        "rel_run_id": "42558910185",
        "backup_sha": "8c91e331421416de4f1b7e838a37f0ff268db353",
        "ogate_comment_id": "6732145512",
        "feature_loc_label": "+11,214 / -209 net (96 files; +11,191 / -230 across 14 feature PRs)",
        "meta_description": (
            "Executed across 3 coordinated waves plus a mid-sprint hotfix car on base v5.71.0 (f2be147c) under "
            "Charter A506 v1.0 (Milestone #59) and SPRINT_REPORT_CONTRACT v2.0.0, closing all 15 chartered issues "
            "across 15 true-merged PRs (#2938, #2939, #2940, #2941, #2944, #2954, #2952, #2943, #2942, #2947, "
            "#2955, #2957, #2958, #2951, #2959)."
        ),
        "eyebrow": "● AUTONOMOUS MULTI-AGENT RELEASE AUDIT · MILESTONE #59 (v5.72.0) · CHARTER A506 v1.0 · 3 WAVES + HOTFIX",
        "hero_sub_html": (
            'Executed across <strong>3 coordinated waves plus one mid-sprint hotfix car</strong> on base <code>f2be147c</code> '
            '(<code>tag: v5.71.0</code>) under <strong>Charter <code>A506 v1.0</code></strong> and <strong><code>SPRINT_REPORT_CONTRACT.md v2.0.0</code></strong>. '
            'Shipped <strong>15 Sprint PRs</strong> via 100% true merge commits (<code>Rule #282</code>, 2 parents each), '
            'closing all <strong>15 active chartered Milestone #59 issues (<code>open_issues: 0, closed_issues: 15</code>)</strong> '
            'with <strong>0 post-merge defects on <code>main</code></strong> and <strong><code>+11,214 / -209</code> net repository lines of code across 96 files '
            '(<code>+11,191 / -230</code> summed across the 14 feature PR diffs)</strong>. '
            'A <strong>2026-11-08T22:24:16Z unscoped <code>tmux kill-server</code> incident</strong> (<code>TC-Lane-A</code>, reproducing a CI failure) terminated all '
            '22 live fleet sessions at once; recovery and relaunch required a post-relaunch Operator confirmation '
            '(<code>OP-GO-INT-RELAUNCH-20261108-183719</code>) and was itself the trigger for the mid-sprint hotfix car '
            '(<code>Car 5720-W2-HF PR #2954</code>) that shipped the mechanical <code>tmux</code>/<code>gh</code>/<code>curl</code> PATH-wrapper guards '
            'preventing a recurrence (<code>#2945, #2946, #2949</code>).'
        ),
        "plain_english_headline": "Fleet Coordinator Delegation, Master Lifecycle API Tokens, Engine Failover Recovery, and a Mechanical Guard Against the Incident That Interrupted This Very Sprint",
        "plain_english_intro": (
            "Sprint <code>v5.72.0</code> (<strong>“Fleet authority, engine resilience, and release automation”</strong>, "
            "Charter <code>A506 v1.0</code>) closed all <strong>15 Milestone #59 issues across 15 pull requests</strong> "
            "(<code>+11,214 / -209</code> net LOC across 96 files), including recovering from and then mechanically "
            "preventing a repeat of a fleet-wide incident that happened mid-sprint:"
        ),
        "plain_english_pillars": [
            (
                "1. Fleet Coordinator Delegation & Master Lifecycle API Tokens (#2937, #2950 · Cars 5720-W2-A PR #2952, 5720-W3-D PR #2955)",
                "A project granted \"Fleet Coordinator\" authority can now self-service provision its own sibling projects "
                "(<code>lib/fleet-provisioner.js#provisionFleet</code>), and a Project Master granted <code>write</code> access "
                "now auto-enables and mints its own lifecycle API token in the same step "
                "(<code>lib/master-authority.js#applyOperatorAuthorityChange</code>), instead of a second separate action.",
            ),
            (
                "2. Engine Failover, Session Hierarchy & Sub-Agent Authorization (#109, #1578, #1257 · Cars 5720-W2-D PR #2944, 5720-W2-B PR #2943, 5720-W2-C PR #2942)",
                "A crashed or degraded engine now triggers a non-dismissible failover modal "
                "(<code>lib/engine-health.js</code>, <code>public/engine-failover-modal.js</code>); a project can delegate scoped "
                "wrap/clear authority to another session (<code>lib/session-hierarchy.js</code>); and sub-agent parallelization "
                "is now an explicit per-project authorization toggle (<code>lib/subagent-parallelization.js</code>).",
            ),
            (
                "3. Mechanical PATH-Wrapper Guard Against the Mid-Sprint `tmux kill-server` Incident (#2945, #2946, #2949 · Car 5720-W2-HF PR #2954)",
                "After a bare <code>tmux kill-server</code> took down all 22 live fleet sessions mid-sprint, "
                "<code>lib/tmux-guard.js#evaluateTmuxKillGuard</code> now mechanically refuses that call from an agent pane "
                "unless it targets an isolated or scratch-test socket, wired through the same PATH-wrapper directory "
                "<code>lib/merge-role-guard.js</code> already writes on every session launch — shipped as a hotfix in the "
                "same sprint the incident happened in.",
            ),
        ],
        "waves": [
            {
                "label": "Wave 1",
                "cars": [
                    {
                        "car_id": "Car 5720-W1-C", "wave_phase": "Wave 1 (Car 5720-W1-C)",
                        "builder": "TC-Lane-C (#1600)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2938, "head_short": "084ae94b", "merge_sha": "c929e5e3d2a13ebbc7f61dcca16e42e742587e60",
                        "merge_short": "c929e5e3", "issues": [2928], "files_count": 6, "additions": 107, "deletions": 1,
                        "title": "feat(plan-docs): brand the plan & document viewer (#2928)",
                        "files_list": "`lib/plan-docs.js`, `test/plan-viewer-branding.test.js`, `test/plan-docs.test.js`, `changelog.d/2928.*.md`",
                        "summary": "Adds a subtle background watermark, an \"Orchestrated by TangleClaw\" brand kicker, and a `TangleClaw.com` footer to `/plans/:projectId/:file` pages, print-safe and non-interactive (`#2928`).",
                        "verification": "R1 PASS (`3105c333`, `A506-W1C-AGATE-PASS`); CI `42516036684`", "tags": "wave-1 branding plan-docs",
                    },
                    {
                        "car_id": "Car 5720-W1-D", "wave_phase": "Wave 1 (Car 5720-W1-D)",
                        "builder": "TC-Lane-D (#1601)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2939, "head_short": "5bd94b59", "merge_sha": "f9008cbe4a5f6bf25d9a38760467d298dadddc29",
                        "merge_short": "f9008cbe", "issues": [2935], "files_count": 7, "additions": 164, "deletions": 13,
                        "title": "feat(release): automate the README release banner (#2935)",
                        "files_list": "`scripts/release-prepare.js`, `README.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `docs/adr/0014-dual-key-review-for-untrusted-prs.md`, `test/readme-version-pins.test.js`, `changelog.d/2935.*.md`",
                        "summary": "Automates the README's top release banner (version tag, release-status link, Sprint Report link) in `scripts/release-prepare.js#updateReleaseBanner`, run on every release cut and guarded by `test/readme-version-pins.test.js`; codifies native GitHub `Co-authored-by:` contributor attribution (`#2935`).",
                        "verification": "R2 PASS (`Co-authored-by:` trailers verified); CI `42518246058`", "tags": "wave-1 release-automation docs",
                    },
                    {
                        "car_id": "Car 5720-W1-B", "wave_phase": "Wave 1 (Car 5720-W1-B)",
                        "builder": "TC-Lane-B (#1599)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2940, "head_short": "1b4c0d5e", "merge_sha": "0be1265f87e8bc01a962c15252e35d9907cc10c1",
                        "merge_short": "0be1265f", "issues": [2930], "files_count": 12, "additions": 503, "deletions": 1,
                        "title": "feat(watermark): add the TangleClaw session/dashboard background watermark (#2930)",
                        "files_list": "`public/api-helper.js`, `public/session.css`, `public/style.css`, `public/tangleclaw-logo.png`, `test/ui-watermark.test.js`",
                        "summary": "Adds a non-interactive TangleClaw watermark behind session terminal viewports (including OpenClaw) and the dashboard; `Ctrl+Shift+Up/Down/0` adjusts/resets its opacity, persisted and synced live across open tabs (`#2930`).",
                        "verification": "R3 PASS + CDP 9/9 PASS (`W1-F1_v542` 0-rebase); CI `42520114139`", "tags": "wave-1 branding watermark",
                    },
                    {
                        "car_id": "Car 5720-W1-A", "wave_phase": "Wave 1 (Car 5720-W1-A)",
                        "builder": "TC-Lane-A (#1598)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2941, "head_short": "b5cd76b9", "merge_sha": "327fa7ab45a26245b2a760f289128de1d4808ba9",
                        "merge_short": "327fa7ab", "issues": [2929], "files_count": 5, "additions": 614, "deletions": 43,
                        "title": "fix(tmux): macOS TCC false-positive readable check (#2929)",
                        "files_list": "`lib/tmux.js`, `lib/launch-kickoff.js`, `test/tmux-tcc.test.js`, `test/tmux.test.js`, `changelog.d/2929.*.md`",
                        "summary": "`probeTccReadable` now tests the actual directory read inside the target tmux server and treats any failure as unreadable, instead of reporting a protected `~/Documents` project as readable and crashing the engine on the real `EPERM` (`#2929`).",
                        "verification": "R5 PASS (`A506-W1A-AGATE-R5-PASS`); CI `42525470103`", "tags": "wave-1 tmux reliability",
                    },
                ],
            },
            {
                "label": "Wave 2",
                "cars": [
                    {
                        "car_id": "Car 5720-W2-D", "wave_phase": "Wave 2 (Car 5720-W2-D)",
                        "builder": "TC-Lane-D (#1601)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2944, "head_short": "43a7edd0", "merge_sha": "969d5d408d28dfcf428d7b872719aa484671eb66",
                        "merge_short": "969d5d40", "issues": [109], "files_count": 13, "additions": 1763, "deletions": 2,
                        "title": "feat(engine-health): engine-failure failover modal (#109)",
                        "files_list": "`lib/engine-health.js`, `lib/routes/engine-health-routes.js`, `public/engine-failover-modal.js`, `public/session.js`, `public/session.html`, `server.js`, `test/engine-health.test.js`",
                        "summary": "A background probe classifies each project's active engine as HEALTHY, DEGRADED, or CRASHED; a non-dismissible session-page modal offers Restart, Swap, Continue, or Kill, each requiring explicit `userConfirmed: true` (`#109`).",
                        "verification": "R4 PASS (`aa04febc`, `fc502af2`, CDP `#6727878343`); CI `42529241547`", "tags": "wave-2 engine-health failover",
                    },
                    {
                        "car_id": "Car 5720-W2-HF", "wave_phase": "Wave 2 Hotfix (Car 5720-W2-HF)",
                        "builder": "TC-Lane-A (#1598)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2954, "head_short": "8e6f576d", "merge_sha": "48170c8d21a209675082d3afad494ba14d7b3ac7",
                        "merge_short": "48170c8d", "issues": [2945, 2946, 2949], "files_count": 11, "additions": 846, "deletions": 22,
                        "title": "fix(tmux-guard): mechanical kill-server guard + CI/PATH-wrapper fixes (#2945, #2946, #2949)",
                        "files_list": "`lib/tmux-guard.js`, `lib/merge-role-guard.js`, `lib/tmux.js`, `test/tmux-guard.test.js`, `test/tmux-tcc.test.js`",
                        "summary": "Mid-sprint hotfix shipped the same day as the `tmux kill-server` incident it mechanically prevents: `evaluateTmuxKillGuard` refuses a bare `kill-server` from an agent pane unless it targets an isolated/scratch-test socket (`#2946`); fixed a Linux CI false negative in the TCC readable probe (`#2945`); and fixed the `gh`/`curl`/`tmux` PATH-wrapper scripts resolving back to another real wrapper on a TangleClaw-launched pane's own `PATH` (`#2949`).",
                        "verification": "R4 PASS (`0a2bd1d1`, `67f82488`); CI `42550025484` + main `42552279988`", "tags": "wave-2 hotfix security tmux",
                    },
                    {
                        "car_id": "Car 5720-W2-A", "wave_phase": "Wave 2 (Car 5720-W2-A)",
                        "builder": "TC-Lane-D (#1601)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2952, "head_short": "932fbe39", "merge_sha": "518094b9040c6e60183a01863faad6f0381cf9b1",
                        "merge_short": "518094b9", "issues": [2937], "files_count": 19, "additions": 1312, "deletions": 9,
                        "title": "feat(fleet-provisioner): Fleet Coordinator / Decider project authority (#2937)",
                        "files_list": "`lib/fleet-provisioner.js`, `lib/routes/tc.js`, `lib/tc-verbs.js`, `public/fleet-coordinator-ui.js`, `lib/project-authority-settings.js`, `lib/project-config.js`, `test/fleet-provisioner.test.js`",
                        "summary": "A project granted \"Fleet Coordinator\" authority can self-service clone, register, configure, and seed its own `<Prefix>-*` sibling projects' starting rules, returning `pendingControlBinds` rather than self-granting `control_assignments` (`#2937`). 5 review rounds caught a path-traversal gap, a non-atomic validation ordering, and a whitespace-only `coordinatorRule` crash, all fixed before merge.",
                        "verification": "R5 A-Gate / R4 R-Gate (`05627664`, CDP `#6730922271`); CI `42549988685`", "tags": "wave-2 fleet-coordinator authority",
                    },
                    {
                        "car_id": "Car 5720-W2-B", "wave_phase": "Wave 2 (Car 5720-W2-B)",
                        "builder": "TC-Lane-B (#1599)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2943, "head_short": "0bb2652f", "merge_sha": "14759c366be3c2b7c06aca5027009a5b53b0821f",
                        "merge_short": "14759c36", "issues": [1578], "files_count": 13, "additions": 1223, "deletions": 13,
                        "title": "feat(session-hierarchy): scoped wrap/clear delegation between sessions (#1578)",
                        "files_list": "`lib/session-hierarchy.js`, `lib/sessions.js`, `lib/launch-sequence.js`, `lib/medusa.js`, `lib/routes/sessions.js`, `lib/routes/wrap.js`, `docs/session-hierarchy.md`, `test/session-hierarchy.test.js`",
                        "summary": "A project can be configured to report to another (\"session hierarchy\"): a standing, scoped delegation letting one session wrap or clear another within explicit limits, never covering kill or delete, via an explicit \"prepare to wrap\"/\"prepare to clear\" handshake (`#1578`).",
                        "verification": "R3 PASS (`A506-W2B-AGATE-R3-PASS`, `bb36a641`); CI `42552599551`", "tags": "wave-2 session-hierarchy delegation",
                    },
                    {
                        "car_id": "Car 5720-W2-C", "wave_phase": "Wave 2 (Car 5720-W2-C)",
                        "builder": "TC-Lane-C (#1600)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2942, "head_short": "cbc0247c", "merge_sha": "47e2185e0732e628392edb91a5456b1ee3ae1a63",
                        "merge_short": "47e2185e", "issues": [1257], "files_count": 21, "additions": 933, "deletions": 16,
                        "title": "feat(subagent-parallelization): per-project sub-agent authorization toggle (#1257)",
                        "files_list": "`lib/subagent-parallelization.js`, `lib/engines.js`, `lib/projects.js`, `public/subagent-parallelization-ui.js`, `public/ui.js`, `data/engines/*.json`, `test/subagent-parallelization.test.js`",
                        "summary": "Project Settings gains an \"Allow sub-agent parallelization\" authorization toggle: grants a Builder session permission to fan chunk work out to sub-agents (fan out on reading/discovery, serialize on writing/git state), disabled with an honest reason on engines without native sub-agent dispatch (`#1257`).",
                        "verification": "R5 PASS (`6d2d3746`, CDP `#6731157042`); CI `42553665462`", "tags": "wave-2 subagent authorization",
                    },
                ],
            },
            {
                "label": "Wave 3",
                "cars": [
                    {
                        "car_id": "Car 5720-W3-A", "wave_phase": "Wave 3 (Car 5720-W3-A)",
                        "builder": "TC-Lane-C (#1600)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2947, "head_short": "18548b52", "merge_sha": "ad3ae8a10edc5d52c8f2bfb10e5b177562a9688d",
                        "merge_short": "ad3ae8a1", "issues": [108], "files_count": 7, "additions": 1016, "deletions": 0,
                        "title": "feat(adversarial): adversarial agent red-team primitive (#108)",
                        "files_list": "`lib/adversarial.js`, `docs/adversarial-agent.md`, `test/adversarial.test.js`",
                        "summary": "Any methodology can call `runAdversarialPass` to get structured, red-team findings (category/severity/scenario/why-it-breaks/suggested-test) against a code surface, via a caller-injected subagent-spawn function; TC never calls an LLM API itself. Includes schema validation, severity/cap filtering, and a disposition audit log (`#108`).",
                        "verification": "R2 PASS (`A506-W3A-AGATE-R2-PASS`, `1e6ddc6f`); CI `42541211809`", "tags": "wave-3 adversarial security",
                    },
                    {
                        "car_id": "Car 5720-W3-D", "wave_phase": "Wave 3 (Car 5720-W3-D)",
                        "builder": "TC-Lane-D (#1601)", "reviewer": "TC-Lane-PRR-A (#1595)",
                        "pr": 2955, "head_short": "25f46383", "merge_sha": "89a2b30e9f562433b178426ce7affcc811398918",
                        "merge_short": "89a2b30e", "issues": [2950], "files_count": 8, "additions": 514, "deletions": 35,
                        "title": "feat(master-authority): auto-enable the Master lifecycle API token on write grant (#2950)",
                        "files_list": "`lib/master-authority.js`, `lib/master.js`, `lib/routes/config.js`, `test/api-config.test.js`, `test/master-authority.test.js`, `test/master.test.js`",
                        "summary": "Granting the Project Master `write` access now also enables and mints its lifecycle API token in the same step, instead of leaving every lifecycle call refused until a second action. The Master's pane carries `TANGLECLAW_MASTER_API_TOKEN`/`TANGLECLAW_AUTHORITY_GENERATION`, documented by header name only — the raw token is never written to disk or logs (`#2950`). 4 review rounds caught a token-repair gap, a read-only-retains-token leak, a stale `accessLevel` passed as `current` to the reconciler, and an engine-triggered mode reset silently erasing the grant.",
                        "verification": "R4 PASS (`5db3a18d`); CI `42552745341`", "tags": "wave-3 master-authority token",
                    },
                    {
                        "car_id": "Car 5720-W3-C", "wave_phase": "Wave 3 (Car 5720-W3-C)",
                        "builder": "TC-Lane-C (#1600)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2957, "head_short": "05e3b2a5", "merge_sha": "b2ac98963b9475dcf765399cbe830f22856c41d8",
                        "merge_short": "b2ac9896", "issues": [2948], "files_count": 7, "additions": 915, "deletions": 51,
                        "title": "fix(projects): cache and coalesce the unregistered-projects scan (#2948)",
                        "files_list": "`lib/projects.js`, `lib/session-leftovers.js`, `test/landing-projects-load.test.js`, `test/session-leftovers.test.js`",
                        "summary": "`GET /api/projects` was taking 5-13+ seconds or stalling under load: `lib/projects.js` now caches the `listUnregistered` directory scan (60s TTL) and single-flight-coalesces concurrent scans; `lib/session-leftovers.js` caps background leftover refreshes at `MAX_CONCURRENT_PROBES` (2) via a FIFO queue (`#2948`).",
                        "verification": "R4 PASS (`c6792786`); CI `42553050383`", "tags": "wave-3 performance projects",
                    },
                    {
                        "car_id": "Car 5720-W3-E", "wave_phase": "Wave 3 (Car 5720-W3-E)",
                        "builder": "TC-Lane-B (#1599)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2958, "head_short": "92db2aad", "merge_sha": "c42ac82134f06819d63baceebfac2c4132e72c0e",
                        "merge_short": "c42ac821", "issues": [2930], "files_count": 5, "additions": 42, "deletions": 24,
                        "title": "fix(watermark): ship the watermark at 16% opacity by default (#2930)",
                        "files_list": "`public/api-helper.js`, `public/session.css`, `public/style.css`, `test/ui-watermark.test.js`",
                        "summary": "The background TangleClaw watermark now ships at 16% opacity by default (up from 10% dark / 8% light); the `Ctrl+Shift+Up/Down/0` shortcut is unchanged (`#2930`, follow-up to Car 5720-W1-B).",
                        "verification": "R1 PASS (`fead3172`, CDP `#6731018705`); CI `42552815068`", "tags": "wave-3 branding watermark",
                    },
                    {
                        "car_id": "Car 5720-W3-B", "wave_phase": "Wave 3 (Car 5720-W3-B)",
                        "builder": "TC-Lane-B (#1599)", "reviewer": "TC-Lane-PRR-B (#1596)",
                        "pr": 2951, "head_short": "64c66647", "merge_sha": "257e6db159ea0ee544bfc91f7696cc3ec374fe30",
                        "merge_short": "257e6db1", "issues": [1032], "files_count": 12, "additions": 1239, "deletions": 1,
                        "title": "feat(secure-clipboard): secure clipboard / secret uploader (#1032)",
                        "files_list": "`lib/secure-clipboard.js`, `lib/routes/secure-clipboard.js`, `public/secure-clipboard-ui.js`, `public/session.js`, `public/session.html`, `server.js`, `test/secure-clipboard.test.js`",
                        "summary": "A session page's \"Secure clipboard\" control always saves a secret or file into a private `0600` file under `.tangleclaw/secrets/`, distinct from the ordinary uploads folder; a UTF-8 text write is scanned for credential shapes, never logging the value (`#1032`). 6 review rounds hardened open-install auth, removed raw-secret paste, added clear-on-close, and scoped UTF-8-only secret scanning.",
                        "verification": "R6 PASS (CDP `#6731093345`); CI `42553341817`", "tags": "wave-3 secure-clipboard secrets",
                    },
                ],
            },
        ],
        "release_car": {
            "car_id": "Car 5720-W3-REL", "wave_phase": "Release (Car 5720-W3-REL)",
            "builder": "TC-Lane-D (#1601) / TC-Lane-INT (#1594)", "reviewer": "TC-Lane-PRR-A (#1595) + TC-Lane-Arc (#1593) + TC-Lane-Obsr (#1597)",
            "pr": 2959, "head_short": "76fa2513", "merge_sha": "8c91e331421416de4f1b7e838a37f0ff268db353",
            "merge_short": "8c91e331", "issues": [], "files_count": 25, "additions": 146, "deletions": 101,
            "title": "chore(release): v5.72.0",
            "files_list": "`CHANGELOG.md`, `FEATURES.md`, `README.md`, `ROADMAP.md`, `version.json`, `docs/releases/v5.72.0.md`, `docs/releases/index.md`, `.prawduct/change-log.md`, `test/fixtures/changelog-released-sections.lock.json`, 16 `changelog.d/*.md` fragments (consumed)",
            "summary": "Compiled and drained all 16 accepted `changelog.d/*.md` fragments into `CHANGELOG.md [5.72.0]`; bumped `version.json`; updated README clone pins/banner, `FEATURES.md`, and the released-section lock; added `docs/releases/v5.72.0.md`. 2 review rounds: Round 2 caught `ROADMAP.md` still naming `v5.71.0` as the latest release.",
            "verification": "O-Gate PASS (`OBSR-OGATE-V5720-FINAL-POSTDEPLOY-PASS`, comment `#6732145512`; pre-release `OBSR-OGATE-V5720-W3REL-PR2959-76FA2513-PASS` #6731959649); CI `42557595722`", "tags": "release changelog version",
        },
        "fleet_roster": [
            ("TC-Lane-PM", "#1592", "tc-lane-pm-81fc8b36", "Antigravity", "Project Manager", "Authored Charter A506 v1.0, created Milestone #59, dispatched all cars across 3 waves plus the hotfix and release cuts"),
            ("TC-Lane-Arc", "#1593", "tc-lane-arc-e44c8d3d", "Antigravity", "Architect (A-Gate)", "Ratified Gate 0 file-disjoint car envelopes, issued Scope Rulings, certified exact-SHA A-Gate PASS, and co-signed the report-builder generalization ruling"),
            ("TC-Lane-INT", "#1594", "tc-lane-int-db2fc38d", "Codex", "Integrator (B-Gate / Release)", "Enforced Rule #282 2-parent true merges across all 15 PRs, executed the Milestone #59 closure, and verified the live :3102 deploy (t7)"),
            ("TC-Lane-PRR-A", "#1595", "tc-lane-prr-a-82e05981", "Codex", "PR Reviewer A (I-Gate)", "Independent exact-SHA I-Gate review on Cars 5720-W1-A/B, W2-A/B, W2-HF, W3-A/D"),
            ("TC-Lane-PRR-B", "#1596", "tc-lane-prr-b-a524149b", "Codex", "PR Reviewer B (I-Gate)", "Independent exact-SHA I-Gate review on Cars 5720-W1-C/D, W2-C/D, W3-B/C/E"),
            ("TC-Lane-Obsr", "#1597", "tc-lane-obsr-e5677787", "Antigravity", "Observer & Kaizen Auditor (O-Gate)", "Certified O-Gate PASS on PR #2959 (#6731959649), authored the 16-point Rule #283 audit this report draws from, and verified Milestone #59 closure"),
            ("TC-Lane-A", "#1598", "tc-lane-a-3041ccf7", "Claude Code", "Builder A", "Built Cars 5720-W1-A (#2929) and the mid-sprint hotfix 5720-W2-HF (#2945/#2946/#2949) after the tmux kill-server incident"),
            ("TC-Lane-B", "#1599", "tc-lane-b-e5d168e4", "Claude Code", "Builder B", "Built Cars 5720-W1-B (#2930), W2-B (#1578), W3-E (#2930 follow-up), and W3-B (#1032)"),
            ("TC-Lane-C", "#1600", "tc-lane-c-ade979cf", "Claude Code", "Builder C", "Built Cars 5720-W1-C (#2928), W2-C (#1257), W3-A (#108), and W3-C (#2948)"),
            ("TC-Lane-D", "#1601", "tc-lane-d-300748d7", "Claude Code", "Builder D", "Built Cars 5720-W1-D (#2935), W2-D (#109), W2-A (#2937), and W3-D (#2950); executed the W3-REL release cut"),
        ],
        "kaizen_title": "Kaizen Retro (v5.72.0 → Next Sprint) — Closed-Loop Findings & Feed-Forward Rules",
        "kaizen_badge": "Mandatory Kaizen Retro · 3 Findings Codified for Next Sprint",
        "kaizen_items": [
            (
                "Finding KR-01 (Mechanical PATH-Wrapper Guards Against Unscoped Host-Destructive Commands · #2946/#2949, Shipped in Car 5720-W2-HF PR #2954)",
                "At 2026-11-08T22:24:16.633Z, TC-Lane-A ran a bare `tmux kill-server` without `-L <socket>` while reproducing a CI failure, killing the host's default tmux server and terminating all 22 live sessions at once (~4h recovery and relaunch storm). The `~/.tangleclaw/bin/tmux` runtime shim (`lib/tmux-guard.js`) now mechanically refuses `kill-server`/`kill-session`/`kill-window`/`kill-pane` against the default or TCC-authorized socket from any TangleClaw-launched pane; `#2949` sanitized the same PATH-wrapper directory's own end-to-end tests.",
            ),
            (
                "Finding KR-02 (Test tmux/TCC Probes Under Both Live-Server and No-Default-Server Conditions · #2945, Shipped in Car 5720-W2-HF PR #2954)",
                "Car 5720-W1-A (PR #2941) passed local macOS Stage 1-3 and initial CI, but its `test/tmux-tcc.test.js` probe assumed a default tmux server was running; on Linux CI runners with no default server, `probeTccReadable` returned `false` and fell through to `osascript: not found`, turning `main` red and holding PR #2942/#2943 for ~4h. Any `lib/tmux.js` probe test must now explicitly anchor an isolated `-L __tc_test_...` server or mock the server-running seam rather than relying on ambient host tmux state.",
            ),
            (
                "Finding KR-03 (Stagger Multi-Session Relaunch Storms After a Host-Wide tmux Reset · tmux kill-server relaunch)",
                "Relaunching all 22 sessions simultaneously after the kill-server incident caused transient `:3102` loopback timeouts (`API_UNREACHABLE_FROM_CONTEXT`) and required an explicit post-relaunch Operator GO (`OP-GO-INT-RELAUNCH-20261108-183719`) before TC-Lane-INT could resume merge authority. Rate-limiting bulk session relaunches and allowing coordinator-attested batch recovery clearance is carried forward as a guardrail for the next sprint.",
            ),
        ],
        "pm_worked": [
            (
                "1. 4/4 Builder Lanes and 2/2 PRR Lanes Ran in Parallel Across 3 Waves With Zero Starvation",
                "When TC-Lane-A was diverted to the mid-sprint hotfix Car 5720-W2-HF, TC-Lane-PM immediately reassigned Car 5720-W2-A (#2937) to TC-Lane-D and Car 5720-W3-A (#108) to TC-Lane-C, preventing single-lane starvation and keeping all 4 Builder lanes active throughout.",
            ),
            (
                "2. Zero Source-Code Merge Conflicts Across 15 PRs via File-Disjoint Car Envelopes",
                "Only shared manifest/cache files (`public/sw.js`, `docs/areas.json`, `test/tiers.json`, `.testament.toml`) required cumulative hunk-disjoint rebinds across same-wave UI PRs, each resolved in under 8 minutes; dedicated per-feature UI modules (`public/fleet-coordinator-ui.js`, `public/subagent-parallelization-ui.js`, `public/engine-failover-modal.js`, `public/secure-clipboard-ui.js`) kept `public/ui.js`/`public/session.js` conflict-free.",
            ),
            (
                "3. Verify-Before-Trust Discipline Caught Real Drift on Every Reviewed Car",
                "Independent PRR review found and fixed genuine defects before merge on every multi-round PR: a path-traversal + non-atomic-validation gap on Car 5720-W2-A (#2937), four sequential gaps on Car 5720-W3-D's (#2950) master-authority reconciliation (token repair, read-only token leak, a stale pre-patch value passed to the reconciler, and an engine-mode-reset silently erasing the grant), and open-install-auth/raw-secret-paste hardening on Car 5720-W3-B (#1032).",
            ),
            (
                "4. Once the Hotfix Landed, 8 Queued Wave 2/3 PRs Merged in a Fast True-Merge Train",
                "Car 5720-W2-HF (PR #2954) restored green `main` CI at 02:41:03Z; the remaining Wave 2 and Wave 3 PRs merged in rapid succession afterward, each verified on its own exact-head CI run before TC-Lane-INT's true merge.",
            ),
        ],
        "pm_warn": [
            (
                "1. A Bare `tmux kill-server` Took Down the Whole Fleet Mid-Sprint (Fix / Guardrail KR-01)",
                "TC-Lane-A ran `tmux kill-server` with no `-L <socket>` while reproducing a CI failure, killing the default tmux server and all 22 live sessions at once. **Fix / Guardrail (KR-01):** `lib/tmux-guard.js#evaluateTmuxKillGuard`, wired through the same PATH-wrapper directory `lib/merge-role-guard.js` writes on every session launch, mechanically refuses the call unless it targets an isolated or scratch-test socket.",
            ),
            (
                "2. A Linux CI False Negative in the TCC Readable Probe Held Two PRs for ~4 Hours (Fix / Guardrail KR-02)",
                "`probeTccReadable`'s `run-shell` probe assumed a default tmux server was already running; on Linux CI with none, it returned `false` and fell through to a nonexistent `osascript`, turning `main` red. **Fix / Guardrail (KR-02):** the suite now keeps one real anchor session alive on the default server for its own run, and any future probe test must anchor or mock the server-running seam explicitly.",
            ),
            (
                "3. Four Sequential Review Rounds on the Same Master-Authority Reconciliation (Car 5720-W3-D, PR #2955)",
                "Each PRR round found a genuinely new gap in the same reconciliation function: a missing token-repair branch for an already-correct write Master, a downgraded-to-read-only Master retaining its token in pane env, `config.master` passed as its own already-patched \"current\" value (making `accessLevelChanged` always false), and an engine-triggered launch-mode reset silently erasing the token/audit grant. **Fix / Guardrail:** when a reconciliation function gates on \"did X change,\" explicitly test the case where X is read back from a value the same code path already mutated.",
            ),
            (
                "4. The Release PR Initially Missed `ROADMAP.md`'s Own Stale Version Reference (Car 5720-W3-REL, PR #2959, Round 2)",
                "The release PR's file envelope named `ROADMAP.md`, but Round 1 only updated the files `scripts/release-prepare.js` touches automatically (README pins/banner, the lock); `ROADMAP.md`'s own hand-written \"Shipped state as of the latest release\" line still said `v5.71.0`. **Fix / Guardrail:** a release checklist item for every hand-maintained (non-automated) version reference, not just the ones a script already covers.",
            ),
        ],
        "next_sprint_cards": [
            (
                "KAIZEN FEED-FORWARD KR-01 · MECHANICAL PATH-WRAPPER GUARDS",
                "Keep the tmux/gh/curl PATH-Wrapper Guard Active in Every Launched Pane",
                "`lib/tmux-guard.js` and `lib/merge-role-guard.js` now mechanically refuse unscoped host-destructive commands; extend the same pattern to any newly-identified destructive command surface.",
            ),
            (
                "KAIZEN FEED-FORWARD KR-02 · ISOLATED TMUX TEST ANCHORS",
                "Anchor or Mock the Default-Server Seam in Every tmux Probe Test",
                "Require any `lib/tmux.js` probe test to explicitly anchor an isolated `-L __tc_test_...` server or mock the server-running seam rather than relying on ambient host tmux state.",
            ),
            (
                "KAIZEN FEED-FORWARD KR-03 · STAGGERED RELAUNCH AFTER A HOST-WIDE RESET",
                "Rate-Limit Bulk Session Relaunches After a Fleet-Wide tmux Server Reset",
                "Stagger multi-session relaunch storms (e.g. max 4 concurrent `tc start next` handshakes per second) and allow coordinator-attested batch recovery clearance to clear fleet-wide restarts without per-pane stalls.",
            ),
            (
                "RECONCILIATION DISCIPLINE · CHECK VALUES READ BACK FROM ALREADY-MUTATED STATE",
                "Test \"Did X Change\" Gates Against a Pre-Mutation Snapshot, Not the Live Object",
                "The 4-round master-authority reconciliation gap recurred because a change-detection gate compared a value to itself after an earlier step had already mutated it; capture a pre-mutation snapshot explicitly before any such comparison.",
            ),
            (
                "RELEASE CHECKLIST · HAND-MAINTAINED VERSION REFERENCES",
                "Audit Every Hand-Written Version Reference, Not Just Script-Covered Ones",
                "`ROADMAP.md`'s own prose reference to the latest release isn't touched by `scripts/release-prepare.js`; add an explicit grep step for stale version strings across hand-maintained docs on every release cut.",
            ),
            (
                "REPORT INFRASTRUCTURE · GENERALIZED N-CAR / M-WAVE BUILDER",
                "Keep `build_multi_wave_version_report` as the Path for Any Future Multi-Wave or Hotfix Sprint",
                "v5.72.0 was the first sprint to need more than 3 cars in 1 wave; the generalized builder (Ruling A506-GATE4-REPORT-BUILDER-NCAR) now covers any future N-car/M-wave shape without touching the existing v5.68.0-v5.71.0 generators.",
            ),
        ],
    },
}
