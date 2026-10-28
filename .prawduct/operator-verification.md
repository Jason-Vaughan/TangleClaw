# Operator verification — v5.38.0 Waves 2–3

The A473-A3 isolated scratch-server pass ran on `main@95e141364cd56985625971a0ae0752f5ee823754` with `scripts/with-scratch-server.js` and exited 0. Its server reported the helper's temporary `projectsDir`; a fixture project was created inside that directory. The dashboard and fixture session pages returned HTTP 200 with their expected DOM hosts, and the served scripts contained the launch-intent and terminal-paste wiring. Both temporary home and projects directories were removed after the callback. The pass made no request to the live port 3102 and used no real `~/Documents/Projects` fixture.

That pass checked HTTP, DOM, and served wiring. The following input and assistive-technology observations remain pending; the pass above does not close them.

## F10 — #2122/#2123/#2124 dashboard filters and native new-tab Launch

**Status:** pending native browser interaction; repeat the isolated scratch pass at W4-REL.

On the scratch dashboard, choose tag and engine filters, reload, and confirm the same applicable selection remains while a selection for a removed project is discarded. Right-click a project's Open and Launch links and open each in a new tab. Confirm Open reaches that project's session; Launch starts only when its dashboard-minted, project-bound intent is present, and a bare, expired, mismatched, or replayed intent does not start a session. Confirm the toolbar controls do not overlap at desktop and narrow widths. The Wave 2 scratch HTTP/DOM pass confirmed the routes and served launch-intent functions, but did not perform a native right-click, new-tab action, or reload interaction.

## VRF-006 — #2458 Windows terminal paste and Master Paste

**Status:** accepted

Using a safely isolated session on Windows, focus xterm and verify Ctrl+V and voice dictation insert the intended text once. Exercise the Master Paste button from both the dashboard panel and session drawer: confirm clipboard insertion, the prompt fallback when clipboard reading is unavailable, and no duplicate paste. The Wave 2 scratch pass confirmed the session route, terminal frame, served Windows paste wiring, and Master Paste control source; it did not synthesize Windows input or operate a live terminal.

**Accepted:** 2026-10-28 — rationale: Tracked in open issues #2458 / #2091; malformed status line repaired per Charter A480 P21.

## VRF-007 — #2091 VoiceOver/NVDA announcement on panel focus restore

**Status:** accepted

On the Groups or OpenClaw panel with VoiceOver or NVDA active, focus a fold toggle or an Edit group, Kill Tunnel, Web UI, SSH, or Remove control. Leave the panel open through a full 30-second poll cycle. Record whether the screen reader announces the focused control again on each restore or remains silent when its accessible meaning has not changed. If it repeats, file the follow-up to avoid an unnecessary focus event or preserve the DOM node across the poll. Automated tests for PR #2611 verify focus placement and stale-response guards; they cannot observe spoken announcements.

**Accepted:** 2026-10-28 — rationale: Tracked in open issues #2458 / #2091; malformed status line repaired per Charter A480 P21.

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
