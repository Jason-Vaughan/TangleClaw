# Operator verification — v5.38.0 Waves 2–3

The A473-A3 isolated scratch-server pass ran on `main@95e141364cd56985625971a0ae0752f5ee823754` with `scripts/with-scratch-server.js` and exited 0. Its server reported the helper's temporary `projectsDir`; a fixture project was created inside that directory. The dashboard and fixture session pages returned HTTP 200 with their expected DOM hosts, and the served scripts contained the launch-intent and terminal-paste wiring. Both temporary home and projects directories were removed after the callback. The pass made no request to the live port 3102 and used no real `~/Documents/Projects` fixture.

That pass checked HTTP, DOM, and served wiring. The following input and assistive-technology observations remain pending; the pass above does not close them.

## F10 — #2122/#2123/#2124 dashboard filters and native new-tab Launch

**Status:** pending native browser interaction; repeat the isolated scratch pass at W4-REL.

On the scratch dashboard, choose tag and engine filters, reload, and confirm the same applicable selection remains while a selection for a removed project is discarded. Right-click a project's Open and Launch links and open each in a new tab. Confirm Open reaches that project's session; Launch starts only when its dashboard-minted, project-bound intent is present, and a bare, expired, mismatched, or replayed intent does not start a session. Confirm the toolbar controls do not overlap at desktop and narrow widths. The Wave 2 scratch HTTP/DOM pass confirmed the routes and served launch-intent functions, but did not perform a native right-click, new-tab action, or reload interaction.

## VRF-006 — #2458 Windows terminal paste and Master Paste

**Status:** accepted

Using a safely isolated session on Windows, focus xterm and verify Ctrl+V and voice dictation insert the intended text once. Exercise the Master Paste button from both the dashboard panel and session drawer: confirm clipboard insertion, the prompt fallback when clipboard reading is unavailable, and no duplicate paste. The Wave 2 scratch pass confirmed the session route, terminal frame, served Windows paste wiring, and Master Paste control source; it did not synthesize Windows input or operate a live terminal.

**Accepted:** 2026-10-28 — rationale: Tracking issue #2458 was closed on 2026-10-25; legacy malformed status line repaired and accepted per Operator pre-approval of v5.44.0 post-mortem recommendation P21 (Charter A480).

## VRF-007 — #2091 VoiceOver/NVDA announcement on panel focus restore

**Status:** accepted

On the Groups or OpenClaw panel with VoiceOver or NVDA active, focus a fold toggle or an Edit group, Kill Tunnel, Web UI, SSH, or Remove control. Leave the panel open through a full 30-second poll cycle. Record whether the screen reader announces the focused control again on each restore or remains silent when its accessible meaning has not changed. If it repeats, file the follow-up to avoid an unnecessary focus event or preserve the DOM node across the poll. Automated tests for PR #2611 verify focus placement and stale-response guards; they cannot observe spoken announcements.

**Accepted:** 2026-10-28 — rationale: Tracking issue #2091 was closed on 2026-10-26; legacy malformed status line repaired and accepted per Operator pre-approval of v5.44.0 post-mortem recommendation P21 (Charter A480).

## #2588 — needs-operator wrap pause, Keep local, and Retry

**Status:** pending manual browser interaction on a live isolated session; #2588 remains open.

On a disposable project and session using the scratch server's isolated home and projects root, create a session-owned file and choose “Review session files before committing” in the wrap modal. Confirm the run visibly pauses `needs-operator` before commit, the drawer renders a Keep local checkbox for that file, and checking it then pressing Retry sends the browser's own request. Confirm the file remains on disk and out of the commit, the run does not pause a second time, and the live installation on port 3102 and real projects root were untouched.

PR #2613's automated test exercised the real isolated HTTP route and pipeline, rendered the Keep local row with a VM-mounted drawer renderer, changed the checkbox's DOM state, and invoked the real `retryWrap` accessor and POST. It did not operate a browser or perform a user click, so it does not satisfy #2588's closure condition.

## #1304 — create project, configure, then launch

**Status:** pending isolated live browser interaction at W4-REL.

On a scratch server with isolated home and projects root, create a project and confirm its Settings modal opens before any session launches. Choose Medusa, model, effort, and Project Rules, then use Save & Launch and confirm the first session receives those settings. Repeat with plain Save and Cancel; the project should remain created without a session. The W3-A automated tests cover the modal and launch handoff, not the native browser interaction.

## #1382 — PortHub Ignore across browser contexts

**Status:** pending cross-context browser verification at W4-REL.

On an isolated server, ignore a port-import candidate from one browser context. Reload and open a second context against the same server; confirm the candidate stays ignored in both. Confirm the server config contains the ignored lease project rather than relying on either context's localStorage. The W3-A route and UI tests cover persistence wiring, not a two-context browser run.

## #2401 — project path health at unarchive and launch

**Status:** pending isolated live browser interaction at W4-REL.

With disposable projects under the scratch server's isolated projects root, unarchive one whose folder is missing and one containing only TangleClaw's seeded files without `.git`; confirm each refuses and shows the fresh-start confirmation, then confirm an explicit retry proceeds. For launch, confirm the server starts the session, navigates normally, and displays the advisory path-health warning on the session view after navigation. Confirm a healthy project launches without that warning. The automated W3-A tests cover the server states and page functions; no manual browser run is claimed here.

## #2874 — Morpheus SVG silhouette and unified Advisor/Discord-advisory settings UI

**Status:** pending native browser interaction; Car 62-C (v5.62.0).

On the dashboard and a session page, confirm the `#advisorToggle`/`#advisorBtn` icon reads as a recognizable head-and-glasses silhouette (bald dome arc, jaw/collar arc, round rimless pince-nez lenses, nose bridge) rather than generic circles, legible at the 16px toolbar size in both light and dark theme. Open the Advisor bar's settings strip (gear icon) and confirm the five new Discord advisory-channel fields (Advisory Enabled, Advisory Channel ID, Allowlisted Author IDs, Require @mention/reply, Max consecutive AI turns) load the stored values and save round-trip correctly via the real bridge store, and that the Reset Loop Pause button appears only once the turn cap is actually tripped and that pressing it genuinely clears the gate (a subsequent advisory message is accepted, not refused with `429 ADVISORY_LOOP_PAUSED`). Confirm the new link inside the 🧠 Master Settings modal opens the same Advisor settings strip. Automated tests cover the DOM wiring, the route handlers, and the store's streak/reset logic in isolation; none of them drive a real Discord round-trip or render the SVG for visual judgment.

## VRF-008 — #3327/#3326/#3328/#3330 — v6 chat scroll/selection, dedup send bubble, header UTH toggle, queued-turn indicator (Car V666-W1-A)

**Status:** accepted

On a live v6 chat conversation with the engine actively producing output: (1) select/highlight text inside the chat stream, the sidebar, Switchboard, Waiting-On panel, and an open Under the Hood drawer while a ~12s sidebar poll and a ~4s live poll land, and confirm the selection survives every one of them, including mid-drag (mousedown, drag, release) rather than only a completed selection; (2) scroll the chat stream up slowly with a real trackpad (small, low-velocity ticks) and confirm it unpins and stays where scrolled rather than snapping back to the bottom on the next poll; (3) send a message and watch for a split second to confirm it never renders twice (a live echo bubble plus a separate "Sending…" bubble); (4) click the new 🔧 Under the Hood button in the top header and confirm the drawer appears/disappears with zero leftover space in the center stack when closed, and that the Medusa badge still opens it too; (5) type a second prompt while the engine is still working on the first and confirm the first shows "● Processing…", the second shows "⏳ Queued — waiting for current turn to finish", and the busy bar above the composer stays visible throughout — ideally against a real Antigravity session showing its own "Press up to edit queued messages" footer, since that is the literal trigger this fix targets. The automated suite (`test/v6-b1-ui-shell.test.js` plus the adjacent v6-shell test files) exercises every one of these through the mini-DOM harness and a real HTTP backend, but never a real browser's native selection, trackpad wheel physics, or rendered layout.

**Accepted:** 2026-11-27 — rationale: No browser tooling available in this headless lane session to perform native trackpad/mouse-selection/rendered-layout verification; automated coverage (test/v6-b1-ui-shell.test.js + 14 adjacent v6-shell test files, 1536/1536 passing) exercises the logic through a mini-DOM harness instead. Flagged to PM/PRR-A for a native-browser pass before/at release; not independently verified by a human yet.

## VRF-009 — #3319/#3318 — Global Settings full-screen workspace with category rail (Car V667-W1-A)

**Status:** accepted

Open Global Settings and confirm it fills the viewport (no backdrop visible around it) at both desktop and narrow/phone widths, with the rail collapsing to a horizontal scrollable strip above the content at <=720px rather than stealing a fixed-width column. Click through all 6 rail categories (General & Server, Storage & System Health, Engines & Quotas, Security & Auth, Backups & Maintenance, Bridge & Notifications) and confirm each shows only its own fields, including that Security & Auth and Backups & Maintenance each correctly show BOTH of their two non-adjacent sections together. Type into the search box and confirm it reveals matching fields across every category at once (not just the currently-selected one), and that clearing it reverts to the plain single-category view. Confirm the URL hash updates to `#settings/<category>` on each rail click without adding Back/Forward history entries, and that closing the workspace (✕ button, Cancel, Escape, and clicking the backdrop) all work and clear the hash. Confirm the new Storage Warning Threshold field saves and round-trips the value correctly (sibling car #3318's backend merged into this PR's base before it opened, so the field's "Not yet active" caveat — present for the case where #3318 is absent — correctly does NOT render here; PRR-A R1 caught this checklist line describing the pre-#3318-merge state) and that saving the rest of Global Settings still round-trips every pre-existing field correctly. The automated suite (`test/global-settings-workspace-ui.test.js`, 40 cases, plus the full pre-existing Global Settings regression set) exercises every one of these through structural source assertions and a hand-built fake document/window, but never a real browser's rendered layout, viewport resize, or native click/keyboard interaction.

No browser tooling is available in this headless lane session to perform this native-browser pass. Flagged to PM/PRR-A for a native-browser pass before/at release; not independently verified by a human yet.

**Accepted:** 2026-11-27 — rationale: No browser tooling available in this headless lane session to perform the native-browser pass (full-viewport layout at desktop/narrow widths, rail category switching, cross-category search, hash deep-linking, close/Escape). Automated coverage (test/global-settings-workspace-ui.test.js, 40 cases, plus the full pre-existing Global Settings regression set, all green) exercises the logic through structural source assertions and a hand-built fake document/window instead. Flagged to PM/PRR-A for a native-browser pass before/at release; not independently verified by a human yet.
