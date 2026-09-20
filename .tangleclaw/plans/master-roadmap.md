# Roadmap State

**Source of Truth for Cross-Session Coordination**

## Currently Executing
**Train 9: Tier 1 Auth (ADR 0015)**
- ✅ Chunk 01: #1416 (ADR OQ resolutions & scrypt migration), #1417 (users table schema). (SHIPPED)
- ✅ Chunk 02: #1418 (sessions, HTTP gate, CSRF). *Note: Must include reset-admin.js, strict password policy, and async scrypt.* (SHIPPED)
- ✅ Chunk 03: #1419 (authenticate WS upgrade; openclaw-direct seam). (SHIPPED - PR #1429)
- ✅ Chunk 04: #1420 (The Cutover: Caddy stops gating, bind-policy simplification). **[DONE]**
- ✅ Chunk 05: A-05 (Account Self-Service). **[DONE]** Scope: #1463 Sign out, #1457 Change password, #1462 CSRF fix, 401 redirect to /login, #1461 Chrome double-gate prompt loop fix. Concluding with combined A-VRF.
- ✅ Chunk 06: A2 (#804, #803 - Wizard UI, Opt-out). **[SHIPPED - PR #1468]**
- ✅ **Release v5.24.0**: **[SHIPPED]** (GHSA-fhgg-4h57-q2f9 published).
**Sprint v5.25.0 (Fast Follow)**
- ✅ #1471 (Session Banner Account Info). **[SHIPPED - PR #1473]**
- ✅ #1472, #1474, #1475, #1476 (UI Header Cleanup). **[SHIPPED - PR #1477]**
- ✅ #1478 (Kill button wraps alone on phone). **[SHIPPED - PR #1479]**
- ✅ **Release v5.25.0**: **[SHIPPED]**
**Sprint v5.25.1 (Fast Lane)**
- ✅ #1363 (project-map wrap-step deletes continuation lines). **[SHIPPED - PR #1481]**
**Train 16: The Secure Surface Finishes (De-prioritized/Parallel)**
- ✅ Chunk 01: #848 (SHIPPED). #846 (CLOSED - shipped-narrow)
- ✅ Chunk 02: #1361 (Dependabot). (SHIPPED - PR #1440)
- ✅ Chunk 03: #870, #1062 (SHIPPED - PR #1401)
- ✅ Chunk 04: #1394, #1373 (SHIPPED - PR #1411)

## Blessed Next Train: The Finalized Consensus Sequence
*This is the official next sequence of work. No major new subsystems enter v5 until these are stable.*

**Train 10: Can We Believe Our Own Green?** *(Runs first, blocks everything) - COMPLETE*
1. ✅ **#902** - Test suite spawns real processes (Leaks tmux sessions) - *Shipped PR #1153*
2. ✅ **#844** - CI green certifies 5113 of 5128 (skips real-world tests) - *Shipped PR #1155*
3. ✅ **#831** - Live global template dir flake - *Shipped PR #1156*
4. ✅ **#835** - Upstream drift check skips in CI - *Shipped PR #1157*
5. ✅ **#969** - INSTALL_REFERENCE refusal guard assert - *Shipped PR #1160*
6. ✅ **#957** - Threadpool assertion fails under load - *Shipped PR #1158*

**Train 11: The System Stops Lying - COMPLETE**
(Shipped)


**Train 12: The UI Says What It's Doing - COMPLETE**
*Shipped in v5.19.0 (merge a764d22). Deferred: #113, #128.*

1. ✅ **#948** - *Shipped PR #1162*
2. ✅ **#1054** - *Shipped PR #1163*
3. ✅ **#1061** - *Shipped PR #1165*
4. ✅ **#994** - *Shipped PR #1166*
5. ✅ **#1056** - *Shipped PR #1167*
6. ✅ **#741** - *Shipped PR #1168*
7. ✅ **#1150** - *Shipped PR #1169*
8. ✅ **#991** - *Shipped PR #1170*
9. ✅ **#796** - *Shipped PR #1171*
10. ✅ **#858** - *Shipped PR #1173*
11. ✅ **#429** - *Shipped PR #1174*
12. ✅ **#1063** - *Shipped PR #1175*
13. ✅ **#1134** - *Shipped PR #1177*
14. ✅ **#1012** - *Shipped PR #1186*
15. ✅ **#1178** - *Shipped PR #1188 (Topology Fix)*
16. ✅ **#1191** - *Shipped PR #1189 (Chime Fix)*

**Train 12.5: Settings & Modals Cleanup - COMPLETE**
*Shipped in v5.20.0 (release commit 64db86b). #764 left open by design.*

**Train 13: Nothing Mutates Behind Your Back**
- ✅ Chunk 01: #1022, #1242, #1275
- ✅ Chunk 02: #910, #840
- ✅ Chunk 03: #797, #882
- ✅ Chunk 04: #828, #1052 *(Notes: #828 real risk is UNSET HOME causing CWD-relative DB; #1052 descoped allowRoot, converged on symlink rule)*
- ✅ Chunk 05: #1033, #929
- ✅ Chunk 06: #1132 *(Notes: policy is counts-decide, not repair-everything; a third call site, retireInactiveEngineConfig, held its own marker predicate and whole-file-replaced co-owned carriers)*
*Shipped PR #1292. Filed: #1291 (non-atomic engine-config write; the tmp+rename fix would silently override a read-only config, so it needs an operator-intent decision). Quick win #1231 completed (PR #1293).*


**Train 14: Bounded, Not Infinite - COMPLETE**
- ✅ #869 (v5 half), #889, #692, #956, #625, #1108 (v5 half)

**Train 15: The Transport Tells The Truth - COMPLETE**
- ✅ #1130 -> #1131, #1100, #918, #1112, #934, #1025

*(Quick Wins: #1039, #1066, #1067, #1049, #1048, #1051, #976, #670, #1044, #1037, #1113. Execute between chunks. #923 executes after AUTH-4).*

**Train 18: The Wrap Protocol Overhaul**
- ✅ Chunk 1: Wrap-state controller, POST->202, retry fix, #1228 stream vocabulary. **[SHIPPED - PR #1483]**
- ✅ Chunk 2: Session range & ownership (#1309, #1406, #1469). **[SHIPPED - PR #1486]**
- ✅ Chunk 3: Explicit per-step sentinel (#1450) + learnings content verification (#843). **[SHIPPED - PR #1488]**
- ✅ Chunk 4: The new Wrap button/popover UI + Delegated Remediation row states (#1312, #1229). **[SHIPPED - PR #1489]**
*(Train 18 is completely executed and LIVE).*

## Up Next (Post-Consensus)

**Train 19: The Wrap Release Gate & UI Polish**
- ✅ Chunk 1: Wrap popover clipping bug on mobile (#1491). **[SHIPPED - PR #1493]**
- ✅ Chunk 2: L1 Server-Side Signals & `releaseMode` settings migration (#1492). **[SHIPPED - PR #1496]**
- ✅ Chunk 3: L3 UI Decision Drawer (#1492). **[SHIPPED - PR #1499]**
- ✅ Chunk 4: L2 AI Recommendation Step with Chat Context Ingestion (#1492). **[SHIPPED - PR #1500]**

**Train 19 Fast-Follows:**
- ✅ #1502: version-bump `release-prepare` hook for release companion files (Fixes PR #1501). **[SHIPPED - PR #1504]**
- ✅ **VRF**: Verify #976 (README pins update automatically during the next release cut, likely v5.26.0). **[SHIPPED]**

**Bugfix Sprint: TangleClaw State & Secrets (Pre-Train 20)**
- 🚨 **#1537**: dashboard self-updater deletes authored files under .tangleclaw/
- ✅ Chunk 01: #1508, #1509 (TangleClaw-owned path registry + wrap backstop). **[SHIPPED - PR #1519]**
- ✅ Chunk 02: #1510, #1511, #1512 (Move state + heal on launch). **[SHIPPED - PR #1520]**
- ✅ Chunk 03: #1513 (Content-based secret check). **[SHIPPED - PR #1524]**
- ✅ Chunk 04: #1514 (Bump Medusa routes to 64KB & catch 413 error). **[SHIPPED - PR #1521]**
- ✅ Chunk 05: #1515 (Wrap UI Retry illusion), #1516 (Filter plan picker by GH issue state). **[SHIPPED - PR #1523]**

**Train 20: Session Start & Continuity**
- ✅ Chunk 01: #868, #1538 (Local query + acknowledgement + session-start prime section). **[SHIPPED - PR #1547]**
- ✅ Chunk 02: #1539, #1540, #1541 (Launch gate + wrap soft-block + dashboard badge). **[SHIPPED - PR #1557]**
- ✅ Chunk 02.5: #1558 (Bug: wrap without commits never ends session). **[SHIPPED - PR #1559]**
- ✅ Chunk 03: #1542, #1543 (GitHub check + offline state). **[SHIPPED - PR #1562]**
- Chunk 04: #1544, #1545 (Crashed/killed badge + grandfathered cleanup path)

**Train 21: Engine-Agnostic Phased Launch**
- Convert the massive single-shot session prime dump into a "PULL" sequence (`tc start next`). The AI fetches rules dynamically. Custom steps will use defined step types.

**Train 22: Grouped Sessions (Multi-Role Architecture)**
- Reuse `project_groups` for multi-agent swarm roles. Ensure each role gets a separate git worktree/project to avoid HEAD collisions. 

**Train 23: GitHub Source of Truth Integration**
- Weaponize the UI to be fully GH compliant (`tc issue create` API for sandboxes, strict ADR 0014 enforcement).

**Train 24: The Fit and Finish (UI/UX Polish)**
- #1265: ui/integration: six v2 palette pairs fall below the 4.5:1 contrast floor
- #1370: [feature] Workspace Rename UX: Warn and Detect Orphaned Engine State

**Train 17: v6 Architecture (Post-Auth)**
*(Requires WHO, workspace policy, or audit attribution)*
- **#1149** - v6 multi-user architecture (Epic - Authorization half)
- **#1151** - v6 documentation model (Epic) (Absorbs #277, #811)
- **#966** - Scope the Master's authority (Scoped token & fleet-mutation role)
- **#1084** - Shared-doc broadcast to Project Master
- **#112 & #111** - Provider catalog (API keys) & metering
- **Splits from v5:** #934 (ACK attribution), #869 (Log audit retention)

**Deferred within v5 (Waiting for Train 14 Transport Boundaries)**
- Switchboard v2 cluster (#801, #979, etc.)
- Fleet/telemetry features
- Orchestration/model additions
- Master Control features
- Docs / UI Polish / Install features
- **#185** - Live Wrap Progress via SSE (Requires building both client + server halves from scratch)

## Operational Rules
- **Rule Authoring Policy**: The ProjectManager (PM) does NOT author, edit, or rewrite global or session rules. The Builders author and maintain the rules for themselves and the rest of the fleet. If questions arise about rule structure or policy, the Builders consult the Architect directly.
- **Multi-Builder Policy**: Train 21 remains serial (Builder1 only). Builder2 is on hold. Parallel execution requires Jason's explicit approval. At the next train's planning stage, the PM must: 1. Identify chunks that could run independently. 2. Ask Jason to verify dependencies and isolation. 3. Bring the proposed two-Builder plan to Jason for approval. 4. Dispatch Builder2 only when its assigned chunk's prerequisites are satisfied. Builders may consult the Architect directly on technical decisions without PM relay. (See canonical instructions: https://cursatory.tail123678.ts.net:8443/plans/81/two-builder-operating-instructions.md)
- **Changelog Invariant**: Anything writing to `[Unreleased]` in `CHANGELOG.md` MUST merge into the existing subsection (e.g. `### Fixed`), never prepend a duplicate subsection.
- **Master Roadmap Sync**: Whenever trains are shifted, added, or completed, the agent MUST regenerate and sync `.tangleclaw/plans/master-roadmap.md` before session wrap to ensure the shared hosted bookmark is always accurate.
- **Train Execution & Chunking**: A Train is a milestone, not a single session's workload. Before starting a new Train, the Builder session MUST plan and break the train down into small, digestible chunks (maximum 3-4 issues per chunk). **(Note for Claude sessions: You MUST utilize the `prawduct` plugin to evaluate the train and generate these chunks before starting execution.)** Execute, wrap, and merge one chunk at a time. Do NOT attempt to complete a massive train in a single PR. This keeps Prawduct reviews fast, prevents context exhaustion, and avoids endless critic loops.
- **Swarm Communication (Medusa)**: The Builder session MUST send a progress memo over the Medusa switchboard to the Coordinator session at the close of every chunk (when a PR is opened), or whenever a major architectural decision, discovery, or roster change occurs. Do not lapse on these reports; the Coordinator relies on them to keep this roadmap state strictly synced with reality.

## Unrostered Backlog (Gathered from Train 16)
- **#1503** - Timed-out commands leaving child processes.
- **#1344** - Add `codex` wake profile to the Medusa wake monitor so it can auto-inject notifications (currently reports `unprofiled-engine`).
- **[NEW]** - Stale pointer in `/clear` prime: prompt says to read `.prawduct/.handoff-notes.md` (which is empty) instead of the actual `.prawduct/.session-handoff.md`. Also verify if this string leaks into non-prawduct/engine-agnostic repos.
- **#1403** - Gate breadth (and ungated path-scoped block beside real gate).
- **#1412** - Intermittent 401 on GET /api/medusa/deliveries in suite.
- **#1413** - skip-ledger describe-level pattern rests on untracked junit-reporter behavior.
- **AI Attribution Suppression Feature Block (Cross-referenced):**
  - **#1407** - `stripAiCoauthors` misses Claude-Session and PR bodies.
  - **#1408** - Opt-in `Built-With: TangleClaw` commit trailer.
  - **#1409** - Opt-in README badge.
  - **#1410** - Wizard integration for attribution opt-in.
**Train 25: Settings & Rules Engine**
- #1604: [feature] Add a Compress rules preview to project and team-member settings
- #1606: [feature/epic] Audit and redesign self-improvement knowledge transfer (requires focused Architect sessions; group with #1151, #595, #1258)

**Train 26: Visual & UX Polish** (Expands Mobile Responsiveness)
- #1577: [feature] Global Upload UX: Multi-file support and auto-appending Attachment Pills
- #1573: [feature] Per-project visual identity for terminal views
- #1555: [bug] Restart button is offered when process manager didn't start the server
- #1564, #1563: [chore] Systemd user-unit Restart button tests and checks

**Train 27: Cleanroom & Security (ADR 0014 Follow-ups)**
- #1554: [feature] Isolated reviewer worker for untrusted PR text
- #1553: [chore] Require an approving review on main
- #1552: [docs] Correct cleanroom docs (it is not a hostile sandbox)
- #1550: [chore] Pin permissions/timeouts in `test.yml` for fork PR runs

**Train 28: Swarm & Medusa Coordination**
- #1578: [feature] Session hierarchy: let one session direct, wrap, and clear another
- #1576: [feature] Team Chat: Support `@nickname` tagging for Medusa routing

**Train 29: Release & Maintenance Cleanup**
- #1537: [bug] Self-updater deletes authored plans
- #1551: [bug] `release.yml` does not verify the tag target equals the tested commit
- #1549: [bug] `check-bump-diff` accepts an incomplete hunk
- #1522: [bug] `priming-roll` rolls a shipped plan when the plans directory holds only one file
- #1531: [feature] OpenClaw connections: ordered fallback addresses

**Recent Inbox Items (Awaiting Scheduling & Chunking)**
- #1638: [feature] Add mobile on-screen modifier key bar to TTYD (UI Polish)
- #1637: [feature] Add 'Restart Session' button to the post-wrap completion banner (UI Polish)
- #1633: [feature] Keep sessions visibly initializing and gate ordinary task input until startup is READY (Session Start)
- #1632: [bug] PROJECT-MAP.md publishes a per-install shared-doc group count into a tracked file
- #1672: [bug] TangleClaw background server is hardcoded to a Builder checkout, breaking when agents use git worktrees
