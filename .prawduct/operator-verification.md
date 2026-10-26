# Operator verification — v5.38.0 Waves 2–3

The A473-A3 isolated scratch-server pass ran on `main@95e141364cd56985625971a0ae0752f5ee823754` with `scripts/with-scratch-server.js` and exited 0. Its server reported the helper's temporary `projectsDir`; a fixture project was created inside that directory. The dashboard and fixture session pages returned HTTP 200 with their expected DOM hosts, and the served scripts contained the launch-intent and terminal-paste wiring. Both temporary home and projects directories were removed after the callback. The pass made no request to the live port 3102 and used no real `~/Documents/Projects` fixture.

That pass checked HTTP, DOM, and served wiring. The following input and assistive-technology observations remain pending; the pass above does not close them.

## F10 — #2122/#2123/#2124 dashboard filters and native new-tab Launch

**Status:** pending native browser interaction; repeat the isolated scratch pass at W4-REL.

On the scratch dashboard, choose tag and engine filters, reload, and confirm the same applicable selection remains while a selection for a removed project is discarded. Right-click a project's Open and Launch links and open each in a new tab. Confirm Open reaches that project's session; Launch starts only when its dashboard-minted, project-bound intent is present, and a bare, expired, mismatched, or replayed intent does not start a session. Confirm the toolbar controls do not overlap at desktop and narrow widths. The Wave 2 scratch HTTP/DOM pass confirmed the routes and served launch-intent functions, but did not perform a native right-click, new-tab action, or reload interaction.

## VRF-006 — #2458 Windows terminal paste and Master Paste

**Status:** pending live Windows and operator interaction; repeat the isolated scratch pass at W4-REL.

Using a safely isolated session on Windows, focus xterm and verify Ctrl+V and voice dictation insert the intended text once. Exercise the Master Paste button from both the dashboard panel and session drawer: confirm clipboard insertion, the prompt fallback when clipboard reading is unavailable, and no duplicate paste. The Wave 2 scratch pass confirmed the session route, terminal frame, served Windows paste wiring, and Master Paste control source; it did not synthesize Windows input or operate a live terminal.

## VRF-007 — #2091 VoiceOver/NVDA announcement on panel focus restore

**Status:** pending live screen-reader observation. #2091 remains open.

On the Groups or OpenClaw panel with VoiceOver or NVDA active, focus a fold toggle or an Edit group, Kill Tunnel, Web UI, SSH, or Remove control. Leave the panel open through a full 30-second poll cycle. Record whether the screen reader announces the focused control again on each restore or remains silent when its accessible meaning has not changed. If it repeats, file the follow-up to avoid an unnecessary focus event or preserve the DOM node across the poll. Automated tests for PR #2611 verify focus placement and stale-response guards; they cannot observe spoken announcements.

## #2588 — needs-operator wrap pause, Keep local, and Retry

**Status:** pending manual browser interaction on a live isolated session; #2588 remains open.

On a disposable project and session using the scratch server's isolated home and projects root, create a session-owned file and choose “Review session files before committing” in the wrap modal. Confirm the run visibly pauses `needs-operator` before commit, the drawer renders a Keep local checkbox for that file, and checking it then pressing Retry sends the browser's own request. Confirm the file remains on disk and out of the commit, the run does not pause a second time, and the live installation on port 3102 and real projects root were untouched.

PR #2613's automated test exercised the real isolated HTTP route and pipeline, rendered the Keep local row with a VM-mounted drawer renderer, changed the checkbox's DOM state, and invoked the real `retryWrap` accessor and POST. It did not operate a browser or perform a user click, so it does not satisfy #2588's closure condition.
