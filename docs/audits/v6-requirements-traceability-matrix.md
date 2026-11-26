# V6 Requirements Traceability Matrix

Generated 2026-11-26T19:25:52.960Z by `scripts/verify-intake-traceability.js`. This checks what is
traceable from the issues this scan saw; it does not independently verify the original
v6 requirements dump itself still matches each cited `V6-NNN`.

Scope: issues #3200 and above only. Checked once against the full tracker (1506 issues, #1 through #3291) that every existing `Intake Reference` falls between #3258 and #3285 -- the convention is new to this intake wave, not retroactive, so an older issue having none is expected and is not listed as a gap here.

- 55 issue(s) scanned, 28 with an `Intake Reference`, 26 with shipped evidence.
- Missing an `Intake Reference`: #3291, #3290, #3289, #3287, #3257, #3254, #3248, #3247, #3218, #3217, #3216, #3215, #3214, #3213, #3212, #3211, #3210, #3209, #3208, #3207, #3206, #3205, #3204, #3203, #3202, #3201, #3200
- Closed with no shipped evidence found (changelog fragment or `CHANGELOG.md` line): #3248

| Issue | Intake Ref | State | Shipped | Title |
| --- | --- | --- | --- | --- |
| #3291 | — | OPEN | no | fix(v6-chat-url-wrap): stitch terminal-soft-wrapped URLs without injecting spaces so wrapped links are not cut off mid-URL |
| #3290 | — | OPEN | yes | docs(website-github-v6-showcase): update TangleClaw website (tangleclaw.com) & GitHub README with complete V6 feature showcase and 'Who Is TangleClaw For & Why' guide |
| #3289 | — | OPEN | no | feat(v6-attach-unregistered): surface discovered unregistered projects in V6 Wizard/Sidebar for 1-click attach & support path/engine in POST /api/projects/attach |
| #3287 | — | OPEN | no | fix(v6-chat-scroll-selection): stop 4s/12s background polls from replacing DOM nodes via innerHTML, resetting scroll position & destroying active text selections |
| #3285 | V6-044, V6-045, V6-046, V6-047, V6-048 | OPEN | no | track(v6-self-reporting-admin): Runtime-assisted bug reporting, opt-in auto-filing, private security reporting route, header feedback buttons & embedded settings assistant (V6-044, V6-045, V6-046, V6-047, V6-048) |
| #3284 | V6-039 | OPEN | no | track(v6-workspace-nav): Central-pane workspace navigation review (Chat, Sprints & Cars, separate Charter vs. Roadmap, Kaizen & Reports, SSOT, Wizard, Fleet Settings) (V6-039) |
| #3283 | V6-030, V6-031, V6-032 | OPEN | no | track(v6-observer-kaizen): Configurable Observer operating modes (per-sprint, persistent, on-demand, disabled), reporting ownership & Kaizen feedback loop acceptance workflow (V6-030, V6-031, V6-032) |
| #3282 | V6-020, V6-021, V6-022, V6-023, V6-024 | OPEN | no | track(v6-automated-wrap): Wrap procedure audit, 1-click automated solo-session wrap, delegate-orchestrated fleet wrap, intelligent defaults & full Wrap API parity (V6-020, V6-021, V6-022, V6-023, V6-024) |
| #3281 | V6-008, V6-011, V6-012, V6-013, V6-014 | OPEN | no | track(v6-fleet-governance): Dedicated Fleet Settings page, granular delegate permissions, YOLO delegate mode, defaults/inheritance & runtime policy enforcement (V6-008, V6-011, V6-012, V6-013, V6-014) |
| #3280 | V6-002, V6-004, V6-007, V6-041 | OPEN | no | track(v6-cli-fidelity): Owner-led CLI-to-UI side-by-side fidelity audit, suggested prompt autocomplete, full-pane terminal toggle & pane resizing review (V6-002, V6-004, V6-007, V6-041) |
| #3279 | V6-050, V6-051 | OPEN | yes | chore(requirements-audit): reconcile original v6 requirements dump & enforce end-to-end intake-to-release traceability (V6-050, V6-051) |
| #3278 | V6-049 | OPEN | no | feat(v6-settings-api): complete settings API parity across all global, fleet, workspace & session configurations (V6-049) |
| #3277 | V6-042, V6-043 | OPEN | no | feat(v6-lifecycle-ui): granular startup & wrap stage visualization in Fleet Sidebar and central pane (V6-042, V6-043) |
| #3276 | V6-040 | CLOSED | yes | fix(v6-layout): reclaim unused vertical space below prompt composer & anchor composer cleanly to bottom footer (V6-040) |
| #3275 | V6-035, V6-036, V6-037 | OPEN | no | feat(v6-docs): standard customizable project & fleet documentation structure and Dedicated SSOT central-pane view (V6-035, V6-036, V6-037) |
| #3274 | V6-033 | OPEN | yes | docs(sprint-reports): audit all completed versions against published sprint reports & recover any missing historical reports from git/SQLite evidence (V6-033) |
| #3273 | V6-029 | OPEN | no | chore(codex-compat): audit & validate modern Codex CLI versions, startupControl, model verification & Medusa lifecycle in isolated test fleet (V6-029) |
| #3272 | V6-028 | OPEN | no | feat(v6-resilience): formalize delegate role succession & surrogate hierarchy (PM -> Architect / Surrogate) distinct from engine fallback (V6-028) |
| #3271 | V6-027 | OPEN | no | feat(v6-failover): expose member-level engine fallback chains (Primary -> Secondary -> Tertiary) in fleet/member settings & runtime (V6-027) |
| #3270 | V6-026 | CLOSED | yes | fix(v6-usage-popover): constrain bottom-right engine usage/status modal within viewport so it never overflows offscreen right (V6-026) |
| #3269 | V6-025 | OPEN | no | feat(v6-health): add matching engine health indicators & hover diagnostics to bottom-right usage/status footer (V6-025) |
| #3268 | V6-019 | OPEN | no | feat(v6-train): codify & enforce safe multi-version sprint look-ahead for idle builder lanes (V6-019) |
| #3267 | V6-018, V6-038 | OPEN | no | fix(v6-sprint-cars): real-time car & train 5-status lifecycle synchronization across authoritative roadmap, LANE_QUEUE & Sprint & Cars UI (V6-018, V6-038) |
| #3266 | V6-017, V6-034 | OPEN | no | feat(v6-reports): configurable mandatory per-version & multi-version sprint reports, completion gate & Kaizen & Reports primary in-product view (V6-017, V6-034) |
| #3265 | V6-016 | OPEN | no | feat(v6-sdlc): configurable authoritative issue-tracking & roadmap workflow enforcement per fleet (V6-016) |
| #3264 | V6-015 | OPEN | no | feat(v6-governance): configurable mechanical enforcement of maximum safe parallelization & pre-execution plan validator (V6-015) |
| #3263 | V6-010 | OPEN | no | feat(v6-fleet): explicit fleet delegate assignment & runtime coordinator authority recognition (V6-010) |
| #3262 | V6-009 | OPEN | no | feat(v6-fleet): support post-creation fleet membership management (add/join/remove members) with live runtime reflection (V6-009) |
| #3261 | V6-006 | OPEN | no | fix(v6-uth): clarify Show/Suppress filter checkboxes, audit raw terminal vs. Peek Under the Hood accuracy & reliably hide Medusa chatter (V6-006) |
| #3260 | V6-005 | OPEN | no | feat(v6-chat): improve conversation readability for long text blobs, headings, lists, tables, code blocks & embedded preview margins (V6-005) |
| #3259 | V6-003 | OPEN | no | feat(v6-chat): surface interactive numbered choices (1–5), confirmation prompts & 'Chat About This' options with full CLI equivalence (V6-003) |
| #3258 | V6-001 | OPEN | no | fix(v6-shell): wire onViewOfflineHistory, onReturnToStartCard & onStartFleetMembers in public/ui.js so 'View Previous Conversation' opens offline history (V6-001) |
| #3257 | — | OPEN | no | fix(codex-launch): TCC-bootstrapped Codex sessions fail native startup (pane_not_ready) and lock in model-unverified hold |
| #3254 | — | OPEN | yes | [bug] Pre-existing flaky real-tmux-session tests block any push touching lib/tmux.js |
| #3248 | — | CLOSED | no | fix(medusa-wake): scope _assessActivity busyMarker check to bottom TUI status chrome and auto-clear inner-socket pane_in_mode=1 copy-mode |
| #3247 | — | CLOSED | yes | fix(medusa-wake): _assessActivity matches busyMarker in transcript body & send-keys fails when inner pane is in tmux copy-mode (pane_in_mode=1) |
| #3218 | — | CLOSED | yes | feat(v6-admin-fleet): Upgrade Admin Fleet (Admin-PM) to full V6 Chat UI (Chat Stream, UTH, Composer) and fix file/image upload & drag-and-drop across V6 and Classic views |
| #3217 | — | CLOSED | yes | GET /api/system: macOS disk percent always reports ~2% because it divides root Sealed System Volume used (15 GiB) by APFS container total (926 GiB) |
| #3216 | — | CLOSED | yes | feat(runtime-hardening): [WAVE-E] Comprehensive v6.5.12 Runtime Engine Hardening (parallel wave enforcement, non-blocking launches, engine SSOT & TCC-safe wrap) |
| #3215 | — | CLOSED | yes | feat(v6-fleet-launch): Add 'Start Fleet / Start Offline Members' button in left Fleet Sidebar to launch all stopped members of a selected fleet |
| #3214 | — | CLOSED | yes | feat(v6-settings-ux): Replace skinny Session Settings modal with full-page browser view and 3-phase AI model picker (4 Engines -> Submodel -> Effort) |
| #3213 | — | CLOSED | yes | feat(runtime-scheduler): Enforce default maximum fleet parallelization and reject single-stream roadmap drift in wave scheduler & roadmap admission |
| #3212 | — | CLOSED | yes | feat(security): Multi-Agent Credential & Execution Isolation Foundation (Control-Plane Broker, OS Seatbelt/Namespace Sandboxing & Scoped Fleet Tokens) |
| #3211 | — | CLOSED | yes | chore(security): Audit Java/Node.js exposure, npm supply chain, and multi-agent credential isolation |
| #3210 | — | CLOSED | yes | feat(v6-workspace-tabs): [WAVE-D-TABS] Five-tab functional & UX architecture audit, cohesive Sprint & Cars Kanban/Gate board, and prioritized UX design backlog |
| #3209 | — | CLOSED | yes | feat(usage-popover-ux): [UI-006] Engine Usage pop-up layout cleanup with structured per-engine cards, 5-hour vs weekly progress bars, and reset countdowns |
| #3208 | — | CLOSED | yes | fix(usage-probe): [BUG-003] Fix Engine Usage 'Refresh now' and interval POST requests failing with missing Content-Type application/json header |
| #3207 | — | CLOSED | yes | feat(v6-loading): [UI-004] Subtle animated ellipsis loading indicators with context-specific labels and reduced-motion accessibility support |
| #3206 | — | CLOSED | yes | perf(v6-navigation): [UI-003] Sub-100ms click acknowledgement, sub-300ms session shell render, stale-while-revalidate caching, and parallelized chat bootstrap |
| #3205 | — | CLOSED | yes | feat(v6-session-recovery): [UI-007] Sidebar session Actions menu and offline Session Properties editor with Save-Without-Starting recovery for broken sessions |
| #3204 | — | CLOSED | yes | fix(v6-navigation): [UI-002] Default Global Fleet & Workspace Overview sidebar filter to All Fleets and isolate per-tab navigation context |
| #3203 | — | CLOSED | yes | feat(v6-offline-ux): [UI-005] Centered offline session startup card with animated Starting transition, failure diagnostics, and persistent history viewer |
| #3202 | — | CLOSED | yes | feat(sessions): [ENH-001] Add session launch preflight checks and actionable failure diagnostics with retry and recovery hooks |
| #3201 | — | CLOSED | yes | fix(v6-sidebar): [BUG-001] Poll authoritative session lifecycle state (~12s consolidated sync) so Fleet Sidebar indicators never stay stale green |
| #3200 | — | CLOSED | yes | fix(v6-scroll): [BUG-005] Centralized V6 Chat & Under the Hood scroll coordinator preserving bottom attachment and reading position across UTH toggle, rename, resize, and async loads |

## Complete 51-item ledger (V6-001 - V6-051): Gate 1 / Gate 4 status

Gate 1 (intake -> issue -> milestone): the entry's issue(s) exist in the tracker.
Gate 4 (PR/test/sprint-report evidence): only required where the entry is actionable, shippable work -- a Collaborative/Owner-review entry reads `n/a`, not a false gap.

- Gate 4 incomplete: V6-001, V6-003, V6-005, V6-006, V6-009, V6-010, V6-015, V6-016, V6-017, V6-018, V6-019, V6-025, V6-027, V6-028, V6-029, V6-034, V6-035, V6-036, V6-037, V6-038, V6-042, V6-043, V6-049

| Intake ID | Workstream | Title | Classification | Issue(s) | Gate 1 | Gate 4 |
| --- | --- | --- | --- | --- | --- | --- |
| V6-001 | E01 | View Previous Conversation button | Bug (Root Cause Found) | #3258 | complete | incomplete |
| V6-002 | E01 | CLI-to-UI fidelity audit | Owner Screenshot Audit | #3280 | complete | n/a |
| V6-003 | E01 | Interactive questions and selections | Actionable Enhancement | #3259 | complete | incomplete |
| V6-004 | E01 | Suggested next prompt autocomplete | Collaborative UX Design | #3280 | complete | n/a |
| V6-005 | E01 | Conversation readability | Actionable Enhancement | #3260 | complete | incomplete |
| V6-006 | E01 | Peek Under the Hood accuracy and filters | Bug / Enhancement | #3261 | complete | incomplete |
| V6-007 | E01 | Full-pane terminal mode | Collaborative UX Design | #3280 | complete | n/a |
| V6-008 | E02 | Dedicated fleet settings page | Collaborative UX Design | #3281 | complete | n/a |
| V6-009 | E02 | Post-creation membership management | Actionable Enhancement | #3262 | complete | incomplete |
| V6-010 | E02 | Explicit delegate assignment | Actionable Enhancement | #3263 | complete | incomplete |
| V6-011 | E02 | Granular delegate permissions | Collaborative Design | #3281 | complete | n/a |
| V6-012 | E02 | YOLO delegate mode | Collaborative Design | #3281 | complete | n/a |
| V6-013 | E02 | Defaults and inheritance | Collaborative Design | #3281 | complete | n/a |
| V6-014 | E03 | Runtime-enforced fleet policies | Collaborative Design | #3281 | complete | n/a |
| V6-015 | E03 | Maximize safe parallelization | Actionable Enhancement | #3264 | complete | incomplete |
| V6-016 | E03 | Issue-tracking and roadmap workflow | Actionable Enhancement | #3265 | complete | incomplete |
| V6-017 | E03 | Mandatory sprint reports and postmortems | Actionable Enhancement | #3266 | complete | incomplete |
| V6-018 | E03 | Car and train status synchronization | Bug / Enhancement | #3267 | complete | incomplete |
| V6-019 | E03 | Safe sprint look-ahead | Actionable Enhancement | #3268 | complete | incomplete |
| V6-020 | E04 | Wrap procedure audit | Collaborative Design | #3282 | complete | n/a |
| V6-021 | E04 | Automated solo-session wrap | Collaborative Design | #3282 | complete | n/a |
| V6-022 | E04 | Delegate-orchestrated fleet wrap | Collaborative Design | #3282 | complete | n/a |
| V6-023 | E04 | Intelligent wrap decisions | Collaborative Design | #3282 | complete | n/a |
| V6-024 | E04 | Wrap API parity | Collaborative Design | #3282 | complete | n/a |
| V6-025 | E05 | Consistent engine health indicators | Actionable Enhancement | #3269 | complete | incomplete |
| V6-026 | E05 | Engine status modal overflow | Bug (Root Cause Found) | #3270 | complete | complete |
| V6-027 | E05 | Member-level engine fallback chains | Actionable Enhancement | #3271 | complete | incomplete |
| V6-028 | E05 | Delegate succession and surrogate | Actionable Enhancement | #3272 | complete | incomplete |
| V6-029 | E05 | Modern Codex compatibility | Actionable Chore / Bug | #3273, #3257 | complete | incomplete |
| V6-030 | E06 | Configurable observer role | Collaborative Design | #3283 | complete | n/a |
| V6-031 | E06 | Observer reporting responsibilities | Collaborative Design | #3283 | complete | n/a |
| V6-032 | E06 | Close continuous-improvement loop | Collaborative Design | #3283 | complete | n/a |
| V6-033 | E06 | Recover missing historical reports | Actionable Docs / Audit | #3274 | complete | complete |
| V6-034 | E06 | Kaizen and Reports workspace integration | Actionable Enhancement | #3266 | complete | incomplete |
| V6-035 | E07 | Standard project documentation structure | Actionable Enhancement | #3275 | complete | incomplete |
| V6-036 | E07 | Dedicated SSOT view | Actionable Enhancement | #3275 | complete | incomplete |
| V6-037 | E07 | Functional project charter | Actionable Enhancement | #3275 | complete | incomplete |
| V6-038 | E07 | Sprint and cars visualization | Actionable Enhancement | #3267 | complete | incomplete |
| V6-039 | E07 | Workspace navigation review | Collaborative UX Design | #3284 | complete | n/a |
| V6-040 | E08 | Reclaim space below prompt composer | Bug (Actionable) | #3276 | complete | complete |
| V6-041 | E08 | Workspace pane and resizing review | Owner Screenshot Audit | #3280 | complete | n/a |
| V6-042 | E08 | Startup visualization | Actionable Enhancement | #3277 | complete | incomplete |
| V6-043 | E08 | Wrap visualization | Actionable Enhancement | #3277 | complete | incomplete |
| V6-044 | E09 | Runtime-assisted bug reporting | Collaborative Design | #3285 | complete | n/a |
| V6-045 | E09 | Optional automatic bug filing | Collaborative Design | #3285 | complete | n/a |
| V6-046 | E09 | Security-sensitive reporting | Collaborative Design | #3285 | complete | n/a |
| V6-047 | E09 | Discoverable feedback submission | Collaborative Design | #3285 | complete | n/a |
| V6-048 | E09 | Embedded settings/help assistant | Collaborative Design | #3285 | complete | n/a |
| V6-049 | E09 | Complete settings API parity | Actionable Enhancement | #3278 | complete | incomplete |
| V6-050 | E10 | Reconcile original v6 requirements | Actionable Audit | #3279 | complete | complete |
| V6-051 | E10 | Prevent future requirements loss | Actionable Governance | #3279 | complete | complete |
