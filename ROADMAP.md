# TangleClaw — Roadmap Board



> **SDLC Orchestration Platform Roadmap.** This document outlines the roadmap across the foundational departments of our AI-native SDLC orchestration platform.



## Management

| Issue | Type | State | Title |
|---|---|---|---|
| [#880](https://github.com/Jason-Vaughan/TangleClaw/issues/880) | enhancement | open | Stop shipping ~/Documents/Projects as the default projectsDir — the wizard warns about its own default |
| [#401](https://github.com/Jason-Vaughan/TangleClaw/issues/401) | bug | ✅ closed | ~~Fresh install: opening a new project shows no launch-mode picker (bypass/interactive/etc.)~~ |
| [#626](https://github.com/Jason-Vaughan/TangleClaw/issues/626) | enhancement | ✅ closed | ~~Create Project collects only 4 fields — first-session settings (launch posture, silent prime) can't be set at creation~~ |
| [#708](https://github.com/Jason-Vaughan/TangleClaw/issues/708) | bug | ✅ closed | ~~First-run setup attaches the TangleClaw clone itself as a managed project~~ |
| [#752](https://github.com/Jason-Vaughan/TangleClaw/issues/752) | bug | ✅ closed | ~~syncEngineHooks wipes operator-authored hooks from a managed project's .claude/settings.json at every session launch~~ |
| [#1375](https://github.com/Jason-Vaughan/TangleClaw/issues/1375) | — | open | projects: a string tags value crashes the card detail render |
| [#542](https://github.com/Jason-Vaughan/TangleClaw/issues/542) | enhancement | ✅ closed | ~~TangleClaw-served plan/design doc links (engine-agnostic "openable from anywhere")~~ |
| [#790](https://github.com/Jason-Vaughan/TangleClaw/issues/790) | feature | ✅ closed | ~~LLM filter in project view~~ |
| [#823](https://github.com/Jason-Vaughan/TangleClaw/issues/823) | bug | ✅ closed | ~~Dashboard buttons are 32px targets on a mobile-first project~~ |
| [#1215](https://github.com/Jason-Vaughan/TangleClaw/issues/1215) | bug | ✅ closed | ~~Dashboard header pills (.dash-action) are 24px targets on a mobile-first project~~ |
| [#1084](https://github.com/Jason-Vaughan/TangleClaw/issues/1084) | enhancement | open | Shared-doc change broadcast should reach the Project Master |
| [#904](https://github.com/Jason-Vaughan/TangleClaw/issues/904) | bug | ✅ closed | ~~Generated project rules never mention the Medusa switchboard — sessions can't use infrastructure they were never told exists~~ |
| [#1020](https://github.com/Jason-Vaughan/TangleClaw/issues/1020) | bug | ✅ closed | ~~Switchboard wake nudge points at a "project guide" that never states the base URL — dangling for every plugin-governed project~~ |
| [#777](https://github.com/Jason-Vaughan/TangleClaw/issues/777) | enhancement | open | Cross-project version dependency registry + notify dependents on release |
| [#809](https://github.com/Jason-Vaughan/TangleClaw/issues/809) | enhancement | open | Own the trigger for prawduct governance telemetry — per-call log + one session report at wrap |
| [#111](https://github.com/Jason-Vaughan/TangleClaw/issues/111) | enhancement | ✅ closed | ~~Per-project cost tracking footer with model breakdown + charts~~ |
| [#905](https://github.com/Jason-Vaughan/TangleClaw/issues/905) | bug | ✅ closed | ~~The Project Master reports as absent when tmux will not answer, not as unknown~~ |
| [#660](https://github.com/Jason-Vaughan/TangleClaw/issues/660) | bug | open | A project with a changelog-update prompt override keeps stale wrap-contract text |
| [#721](https://github.com/Jason-Vaughan/TangleClaw/issues/721) | enhancement | open | Offer release automation to managed projects, not just TangleClaw's own repo |
| [#748](https://github.com/Jason-Vaughan/TangleClaw/issues/748) | bug | open | Feature Index graduation starves on ships-every-session projects — the #568 staged-write gate is per-FILE, so a busy project never hits a quiet wrap |
| [#429](https://github.com/Jason-Vaughan/TangleClaw/issues/429) | bug | ✅ closed | ~~Plan-mode wraps time out to status:'blocked' instead of stalling~~ |
| [#853](https://github.com/Jason-Vaughan/TangleClaw/issues/853) | docs | open | PortHub guide omits the `host` field — a documented host-less release can drop another project's lease |
| [#595](https://github.com/Jason-Vaughan/TangleClaw/issues/595) | enhancement | open | Settings & rules governance: verified delivery, drift detection, and a working lifecycle — so rules actually reach sessions |
| [#781](https://github.com/Jason-Vaughan/TangleClaw/issues/781) | bug | open | Legacy vendored-hook cleanup isn't gated on the plugin being present, and the isPluginGoverned comment describes a deferral that doesn't exist |
| [#1085](https://github.com/Jason-Vaughan/TangleClaw/issues/1085) | bug | open | lib/master.js hardcodes CLAUDE.md as the Master's identity filename — violates the engine-agnostic rule |
| [#455](https://github.com/Jason-Vaughan/TangleClaw/issues/455) | enhancement | ✅ closed | ~~"TangleBrain (orchestrated)" option in project engine config — pick a routing strategy, not a model~~ |
| [#750](https://github.com/Jason-Vaughan/TangleClaw/issues/750) | bug | ✅ closed | ~~The learnings→rules promotion gate is unreachable in practice — 51 provisional, 0 active after a full project's history~~ |
| [#626](https://github.com/Jason-Vaughan/TangleClaw/issues/626) | enhancement | ✅ closed | ~~Create Project collects only 4 fields — first-session settings (launch posture, silent prime) can't be set at creation~~ |
| [#755](https://github.com/Jason-Vaughan/TangleClaw/issues/755) | enhancement | ✅ closed | ~~Make the Master's access-level control functional — enable suggest/write, server-enforced~~ |
| [#756](https://github.com/Jason-Vaughan/TangleClaw/issues/756) | enhancement | ✅ closed | ~~Master settings needs a launch-mode selector — it hardcodes null today~~ |
| [#758](https://github.com/Jason-Vaughan/TangleClaw/issues/758) | enhancement | ✅ closed | ~~Warn when a launch-time setting is changed on a project with a live session — the change silently doesn't apply~~ |
| [#768](https://github.com/Jason-Vaughan/TangleClaw/issues/768) | enhancement | ✅ closed | ~~Master drawer header becomes a real control bar — upload, Medusa, kill, and both mode axes, reusing the session controls~~ |
| [#595](https://github.com/Jason-Vaughan/TangleClaw/issues/595) | enhancement | open | Settings & rules governance: verified delivery, drift detection, and a working lifecycle — so rules actually reach sessions |
| [#660](https://github.com/Jason-Vaughan/TangleClaw/issues/660) | bug | open | A project with a changelog-update prompt override keeps stale wrap-contract text |
| [#748](https://github.com/Jason-Vaughan/TangleClaw/issues/748) | bug | open | Feature Index graduation starves on ships-every-session projects — the #568 staged-write gate is per-FILE, so a busy project never hits a quiet wrap |
| [#750](https://github.com/Jason-Vaughan/TangleClaw/issues/750) | bug | ✅ closed | ~~The learnings→rules promotion gate is unreachable in practice — 51 provisional, 0 active after a full project's history~~ |
| [#111](https://github.com/Jason-Vaughan/TangleClaw/issues/111) | enhancement | ✅ closed | ~~Per-project cost tracking footer with model breakdown + charts~~ |
| [#455](https://github.com/Jason-Vaughan/TangleClaw/issues/455) | enhancement | ✅ closed | ~~"TangleBrain (orchestrated)" option in project engine config — pick a routing strategy, not a model~~ |
| [#400](https://github.com/Jason-Vaughan/TangleClaw/issues/400) | enhancement | open | Cross-session / Project Master assistant: assisted remote cert + CA-trust install |
| [#721](https://github.com/Jason-Vaughan/TangleClaw/issues/721) | enhancement | open | Offer release automation to managed projects, not just TangleClaw's own repo |
| [#542](https://github.com/Jason-Vaughan/TangleClaw/issues/542) | enhancement | ✅ closed | ~~TangleClaw-served plan/design doc links (engine-agnostic "openable from anywhere")~~ |
| [#429](https://github.com/Jason-Vaughan/TangleClaw/issues/429) | bug | ✅ closed | ~~Plan-mode wraps time out to status:'blocked' instead of stalling~~ |
| [#777](https://github.com/Jason-Vaughan/TangleClaw/issues/777) | enhancement | open | Cross-project version dependency registry + notify dependents on release |
| [#781](https://github.com/Jason-Vaughan/TangleClaw/issues/781) | bug | open | Legacy vendored-hook cleanup isn't gated on the plugin being present, and the isPluginGoverned comment describes a deferral that doesn't exist |
| [#884](https://github.com/Jason-Vaughan/TangleClaw/issues/884) | bug | ✅ closed | ~~Registered projects still block the event loop — the synchronous-read family #883 did not sweep~~ |
| [#885](https://github.com/Jason-Vaughan/TangleClaw/issues/885) | enhancement | ✅ closed | ~~The dashboard shows a short project list with no sign that a scan is failing~~ |


## Architecture

| Issue | Type | State | Title |
|---|---|---|---|
| [#747](https://github.com/Jason-Vaughan/TangleClaw/issues/747) | chore | open | Count refreshStatusBars skip reasons directly, and execute two source-shape tests |
| [#277](https://github.com/Jason-Vaughan/TangleClaw/issues/277) | chore | open | Extract architecture docs / config tables / component inventories out of CLAUDE.md into docs/ |
| [#795](https://github.com/Jason-Vaughan/TangleClaw/issues/795) | feature | open | Hermes system integration — review, design, and implement support |
| [#277](https://github.com/Jason-Vaughan/TangleClaw/issues/277) | chore | open | Extract architecture docs / config tables / component inventories out of CLAUDE.md into docs/ |
| [#747](https://github.com/Jason-Vaughan/TangleClaw/issues/747) | chore | open | Count refreshStatusBars skip reasons directly, and execute two source-shape tests |


## Engineering

| Issue | Type | State | Title |
|---|---|---|---|
| [#575](https://github.com/Jason-Vaughan/TangleClaw/issues/575) | bug | open | Opening a session from a phone lands on the wrong port — operator must hand-edit the URL to :8443 |
| [#128](https://github.com/Jason-Vaughan/TangleClaw/issues/128) | enhancement | open | System resource + health pills in OpenClaw session header |
| [#185](https://github.com/Jason-Vaughan/TangleClaw/issues/185) | enhancement | ✅ closed | ~~Live wrap pipeline progress via SSE~~ |
| [#261](https://github.com/Jason-Vaughan/TangleClaw/issues/261) | enhancement | ✅ closed | ~~Surface engine API errors in session UI (Codex 400s, etc.)~~ |
| [#438](https://github.com/Jason-Vaughan/TangleClaw/issues/438) | enhancement | ✅ closed | ~~Toolbar Copy button — one-tap copy of the last terminal selection to the browser clipboard (touch devices)~~ |
| [#771](https://github.com/Jason-Vaughan/TangleClaw/issues/771) | bug | ✅ closed | ~~Wrap gives no visible in-progress state — users click Wrap repeatedly because nothing says it's running~~ |
| [#854](https://github.com/Jason-Vaughan/TangleClaw/issues/854) | enhancement | ✅ closed | ~~Wrap preflight — surface unmet prawduct gates at the door, not mid-pipeline~~ |
| [#907](https://github.com/Jason-Vaughan/TangleClaw/issues/907) | bug | ✅ closed | ~~getSessionStatus reports idle=false, lastOutputAge=0 when tmux could not be read~~ |
| [#1148](https://github.com/Jason-Vaughan/TangleClaw/issues/1148) | bug | ✅ closed | ~~Managed sessions cannot validate EventKit automations; external LaunchAgent works~~ |
| [#801](https://github.com/Jason-Vaughan/TangleClaw/issues/801) | enhancement | open | Session Switchboard v2 automation — opt-in auto-inject and swarm stats, gated on the delivery guarantee |
| [#810](https://github.com/Jason-Vaughan/TangleClaw/issues/810) | enhancement | open | Keep the steward session up — a managed always-on session class (Medusa reaps a wrapped consumer's identity) |
| [#1025](https://github.com/Jason-Vaughan/TangleClaw/issues/1025) | bug | open | Inbound Medusa delivery has no addressing — any running agent in a session can pick up a message meant for the session |
| [#342](https://github.com/Jason-Vaughan/TangleClaw/issues/342) | enhancement | ✅ closed | ~~Session continuity: add landing-card preview and Continue/Fresh launch choice~~ |
| [#372](https://github.com/Jason-Vaughan/TangleClaw/issues/372) | enhancement | ✅ closed | ~~Session-continuity / intent-reconciliation check at session start~~ |
| [#791](https://github.com/Jason-Vaughan/TangleClaw/issues/791) | bug | ✅ closed | ~~Switchboard: messages arrive in inbox but fail to inject into live session~~ |
| [#792](https://github.com/Jason-Vaughan/TangleClaw/issues/792) | bug | ✅ closed | ~~A Switchboard message can arrive with the session never told — no delivery receipt, and the operator becomes the transport~~ |
| [#820](https://github.com/Jason-Vaughan/TangleClaw/issues/820) | bug | ✅ closed | ~~The Medusa control appears on every session page regardless of medusaEnabled — the flag gates autostart, not the surface~~ |
| [#836](https://github.com/Jason-Vaughan/TangleClaw/issues/836) | bug | ✅ closed | ~~Medusa listeners outlive their sessions — the roster reports dead sessions as connected~~ |
| [#868](https://github.com/Jason-Vaughan/TangleClaw/issues/868) | enhancement | ✅ closed | ~~Nothing surfaces a stranded wrap — the wrap.auto_pr row is queryable but not discoverable~~ |
| [#945](https://github.com/Jason-Vaughan/TangleClaw/issues/945) | enhancement | ✅ closed | ~~Broadcast Medusa notifications to active sessions when a Shared Document updates~~ |
| [#998](https://github.com/Jason-Vaughan/TangleClaw/issues/998) | bug | ✅ closed | ~~The shared-doc watcher nudges the session that wrote the file — a self-inflicted wake loop into a live pane~~ |
| [#1075](https://github.com/Jason-Vaughan/TangleClaw/issues/1075) | bug | ✅ closed | ~~Message bridge unreachable — cross-session roster lookup fails (502)~~ |
| [#349](https://github.com/Jason-Vaughan/TangleClaw/issues/349) | enhancement | open | Landing-page fleet idle/wedged indicator (passive per-session state) |
| [#830](https://github.com/Jason-Vaughan/TangleClaw/issues/830) | feature | open | Warn a launching session when its plugin version moved, and flag running sessions that are stale |
| [#670](https://github.com/Jason-Vaughan/TangleClaw/issues/670) | chore | open | Log when resolveSessionRange downgrades a session SHA to the trunk range |
| [#177](https://github.com/Jason-Vaughan/TangleClaw/issues/177) | chore | ✅ closed | ~~Rewrite WRAP_STEP_PATTERNS to enforce the structural quality floor~~ |
| [#797](https://github.com/Jason-Vaughan/TangleClaw/issues/797) | bug | ✅ closed | ~~Wrap `files:` records a cumulative branch inventory, not the session's changed files — disjoint from the actual commit~~ |
| [#840](https://github.com/Jason-Vaughan/TangleClaw/issues/840) | bug | ✅ closed | ~~A leftover .wrap-summary.md from a previous run can be read as the current run's payload~~ |
| [#843](https://github.com/Jason-Vaughan/TangleClaw/issues/843) | bug | ✅ closed | ~~learnings-capture blocks a wrap when there is genuinely nothing novel — and when its entry already landed~~ |
| [#109](https://github.com/Jason-Vaughan/TangleClaw/issues/109) | enhancement | open | Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation |
| [#130](https://github.com/Jason-Vaughan/TangleClaw/issues/130) | enhancement | open | Extend silentPrime SessionStart hook to clear and resume matchers |
| [#193](https://github.com/Jason-Vaughan/TangleClaw/issues/193) | bug | open | SessionStart hook stdout pollutes spawned engine's stdin instead of terminal display |
| [#260](https://github.com/Jason-Vaughan/TangleClaw/issues/260) | enhancement | open | Codex pre-flight model validation at session launch |
| [#346](https://github.com/Jason-Vaughan/TangleClaw/issues/346) | bug | open | Engine detection false-negative under launchd PATH (engine-generic) |
| [#737](https://github.com/Jason-Vaughan/TangleClaw/issues/737) | bug | open | Engine-profile changes shipped in a release are inert until the server restarts |
| [#738](https://github.com/Jason-Vaughan/TangleClaw/issues/738) | chore | open | Converge the setup wizard's engine picker onto the shared option builder |
| [#106](https://github.com/Jason-Vaughan/TangleClaw/issues/106) | enhancement | ✅ closed | ~~Wrap LiteLLM admin UI as a TangleClaw infrastructure session~~ |
| [#736](https://github.com/Jason-Vaughan/TangleClaw/issues/736) | chore | ✅ closed | ~~Normalize engine display name once in enrichment, instead of guarding it at every render site~~ |
| [#741](https://github.com/Jason-Vaughan/TangleClaw/issues/741) | bug | ✅ closed | ~~silentPrime is silently ignored on engines that don't support it — no warning, unlike defaultLaunchMode~~ |
| [#796](https://github.com/Jason-Vaughan/TangleClaw/issues/796) | bug | ✅ closed | ~~Two binding rule sources contradict each other in the same session, and nothing detects it~~ |
| [#858](https://github.com/Jason-Vaughan/TangleClaw/issues/858) | — | ✅ closed | ~~engines: an engine switch leaves the previous engine's config file behind as stale canon~~ |
| [#764](https://github.com/Jason-Vaughan/TangleClaw/issues/764) | enhancement | open | Per-engine tabs in the settings modal — surface installed plugins/skills and engine-specific settings |
| [#596](https://github.com/Jason-Vaughan/TangleClaw/issues/596) | enhancement | ✅ closed | ~~Launch Mode picker: facelift + test coverage~~ |
| [#260](https://github.com/Jason-Vaughan/TangleClaw/issues/260) | enhancement | open | Codex pre-flight model validation at session launch |
| [#346](https://github.com/Jason-Vaughan/TangleClaw/issues/346) | bug | open | Engine detection false-negative under launchd PATH (engine-generic) |
| [#737](https://github.com/Jason-Vaughan/TangleClaw/issues/737) | bug | open | Engine-profile changes shipped in a release are inert until the server restarts |
| [#738](https://github.com/Jason-Vaughan/TangleClaw/issues/738) | chore | open | Converge the setup wizard's engine picker onto the shared option builder |
| [#261](https://github.com/Jason-Vaughan/TangleClaw/issues/261) | enhancement | ✅ closed | ~~Surface engine API errors in session UI (Codex 400s, etc.)~~ |
| [#736](https://github.com/Jason-Vaughan/TangleClaw/issues/736) | chore | ✅ closed | ~~Normalize engine display name once in enrichment, instead of guarding it at every render site~~ |
| [#741](https://github.com/Jason-Vaughan/TangleClaw/issues/741) | bug | ✅ closed | ~~silentPrime is silently ignored on engines that don't support it — no warning, unlike defaultLaunchMode~~ |
| [#670](https://github.com/Jason-Vaughan/TangleClaw/issues/670) | chore | open | Log when resolveSessionRange downgrades a session SHA to the trunk range |
| [#106](https://github.com/Jason-Vaughan/TangleClaw/issues/106) | enhancement | ✅ closed | ~~Wrap LiteLLM admin UI as a TangleClaw infrastructure session~~ |
| [#128](https://github.com/Jason-Vaughan/TangleClaw/issues/128) | enhancement | open | System resource + health pills in OpenClaw session header |
| [#254](https://github.com/Jason-Vaughan/TangleClaw/issues/254) | bug | open | openclaw-direct: forces device re-pairing each launch + misreports remote IP as Cloudflare edge on Tailscale traffic |
| [#177](https://github.com/Jason-Vaughan/TangleClaw/issues/177) | chore | ✅ closed | ~~Rewrite WRAP_STEP_PATTERNS to enforce the structural quality floor~~ |
| [#342](https://github.com/Jason-Vaughan/TangleClaw/issues/342) | enhancement | ✅ closed | ~~Session continuity: add landing-card preview and Continue/Fresh launch choice~~ |
| [#372](https://github.com/Jason-Vaughan/TangleClaw/issues/372) | enhancement | ✅ closed | ~~Session-continuity / intent-reconciliation check at session start~~ |
| [#349](https://github.com/Jason-Vaughan/TangleClaw/issues/349) | enhancement | open | Landing-page fleet idle/wedged indicator (passive per-session state) |
| [#109](https://github.com/Jason-Vaughan/TangleClaw/issues/109) | enhancement | open | Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation |
| [#130](https://github.com/Jason-Vaughan/TangleClaw/issues/130) | enhancement | open | Extend silentPrime SessionStart hook to clear and resume matchers |
| [#192](https://github.com/Jason-Vaughan/TangleClaw/issues/192) | bug | open | tmux/ttyd: multi-line paste into web terminal corrupts input |
| [#193](https://github.com/Jason-Vaughan/TangleClaw/issues/193) | bug | open | SessionStart hook stdout pollutes spawned engine's stdin instead of terminal display |
| [#438](https://github.com/Jason-Vaughan/TangleClaw/issues/438) | enhancement | ✅ closed | ~~Toolbar Copy button — one-tap copy of the last terminal selection to the browser clipboard (touch devices)~~ |
| [#801](https://github.com/Jason-Vaughan/TangleClaw/issues/801) | enhancement | open | Session Switchboard v2 automation — opt-in auto-inject and swarm stats, gated on the delivery guarantee |
| [#788](https://github.com/Jason-Vaughan/TangleClaw/issues/788) | bug | open | The first step of the documented install fails on a clean Mac — git is a Command Line Tools stub |
| [#909](https://github.com/Jason-Vaughan/TangleClaw/issues/909) | bug | ✅ closed | ~~The setup wizard draws a working tree it could not read as clean~~ |
| [#1384](https://github.com/Jason-Vaughan/TangleClaw/issues/1384) | — | open | ui: single-quoted onclick args break on an apostrophe — esc() emits &#39; which the parser decodes back |
| [#104](https://github.com/Jason-Vaughan/TangleClaw/issues/104) | enhancement | ✅ closed | ~~Universal pill UX contract: hover = category label, click = status detail~~ |
| [#227](https://github.com/Jason-Vaughan/TangleClaw/issues/227) | enhancement | ✅ closed | ~~Detect when local clone is behind origin/main — banner (sibling to #199)~~ |
| [#243](https://github.com/Jason-Vaughan/TangleClaw/issues/243) | chore | ✅ closed | ~~Remove Reset button from Global Rules editor UI (#240 follow-up)~~ |
| [#345](https://github.com/Jason-Vaughan/TangleClaw/issues/345) | enhancement | ✅ closed | ~~Re-derive panel list for ttyd-watcher auto-remediation~~ |
| [#769](https://github.com/Jason-Vaughan/TangleClaw/issues/769) | bug | ✅ closed | ~~Upload gives no confirmation it succeeded — just a path under "Tell your AI assistant"~~ |
| [#770](https://github.com/Jason-Vaughan/TangleClaw/issues/770) | enhancement | ✅ closed | ~~Upload one file at a time is the only option — support multi-file selection~~ |
| [#817](https://github.com/Jason-Vaughan/TangleClaw/issues/817) | bug | ✅ closed | ~~Dashboard shell silently fails to initialize — document loads, no dashboard API calls, self-resolved with no intervention~~ |
| [#1164](https://github.com/Jason-Vaughan/TangleClaw/issues/1164) | bug | ✅ closed | ~~Settings modal fetches the delivery ledger into a container no markup creates~~ |
| [#1192](https://github.com/Jason-Vaughan/TangleClaw/issues/1192) | bug | ✅ closed | ~~Dashboard toolbar overlaps and clips on a phone — the operator's primary device~~ |
| [#1383](https://github.com/Jason-Vaughan/TangleClaw/issues/1383) | — | ✅ closed | ~~ui: the import banner's Ignore button has never worked — double-encoded name~~ |
| [#812](https://github.com/Jason-Vaughan/TangleClaw/issues/812) | bug | ✅ closed | ~~tmux.sendKeys pastes onto UNSENT draft text and hits Enter — it submits the operator's half-typed line with our payload glued on~~ |
| [#772](https://github.com/Jason-Vaughan/TangleClaw/issues/772) | chore | open | Executor scripts have no coverage of step ORDER — extract decisions into pure functions |
| [#808](https://github.com/Jason-Vaughan/TangleClaw/issues/808) | enhancement | open | Put the clean-room guest on the tailnet so browser-only VRF assertions can actually be scored |
| [#847](https://github.com/Jason-Vaughan/TangleClaw/issues/847) | bug | open | #839's false commit promise still ships in four more places — including the operator-facing remediation text |
| [#1196](https://github.com/Jason-Vaughan/TangleClaw/issues/1196) | bug | open | Nothing reports how close an auto-stub block is to the 14-day guard — the first signal is a red main |
| [#1377](https://github.com/Jason-Vaughan/TangleClaw/issues/1377) | — | open | tests: enforce node:assert/strict so the non-strict set cannot regrow |
| [#362](https://github.com/Jason-Vaughan/TangleClaw/issues/362) | chore | ✅ closed | ~~Marking a chunk done under views_enabled is an unenforced 2-step ritual (regen-views can be forgotten)~~ |
| [#802](https://github.com/Jason-Vaughan/TangleClaw/issues/802) | chore | ✅ closed | ~~VRF 7e.1 never ran — the no-caddy honest-absence screen is unverified end-to-end~~ |
| [#831](https://github.com/Jason-Vaughan/TangleClaw/issues/831) | bug | ✅ closed | ~~Tests running bare `git init` inherit the live global template dir and flake when TangleClaw rewrites it~~ |
| [#835](https://github.com/Jason-Vaughan/TangleClaw/issues/835) | chore | ✅ closed | ~~The upstream drift check never runs in CI — it skips on every runner~~ |
| [#844](https://github.com/Jason-Vaughan/TangleClaw/issues/844) | bug | ✅ closed | ~~CI's green certifies 5113 of 5128 tests — the 15 it skips are the ones that touch the real world~~ |
| [#2](https://github.com/Jason-Vaughan/TangleClaw/issues/2) | enhancement | open | Add Linux support (systemd) |
| [#239](https://github.com/Jason-Vaughan/TangleClaw/issues/239) | enhancement | open | Linux support for the Restart TangleClaw button (follow-up to #235) |
| [#533](https://github.com/Jason-Vaughan/TangleClaw/issues/533) | chore | open | Gate user-facing doc/screenshot parity the way CHANGELOG parity is gated |
| [#811](https://github.com/Jason-Vaughan/TangleClaw/issues/811) | enhancement | open | An indexable product manual that stays in parity with the code, readable by human and NHE alike |
| [#833](https://github.com/Jason-Vaughan/TangleClaw/issues/833) | question | ✅ closed | ~~Should a managed repo's prawduct install reference be a committed artifact, not untracked machine state?~~ |
| [#133](https://github.com/Jason-Vaughan/TangleClaw/issues/133) | enhancement | open | Codex TOML writer: carry both hook channels |
| [#765](https://github.com/Jason-Vaughan/TangleClaw/issues/765) | enhancement | open | Prime delivery chunks 03–04: trigger-based routing and delivery receipts |
| [#776](https://github.com/Jason-Vaughan/TangleClaw/issues/776) | chore | open | Retire or wire up migrationStatus — persisted, NULL everywhere, no reader |
| [#110](https://github.com/Jason-Vaughan/TangleClaw/issues/110) | enhancement | ✅ closed | ~~Auto-discover locally-installed AI models (Ollama, llama.cpp, LM Studio) for fallback chain UX~~ |
| [#112](https://github.com/Jason-Vaughan/TangleClaw/issues/112) | enhancement | ✅ closed | ~~Provider catalog: API key management + per-provider model surfacing~~ |
| [#348](https://github.com/Jason-Vaughan/TangleClaw/issues/348) | enhancement | ✅ closed | ~~Continuity sync: re-scope without #341~~ |
| [#581](https://github.com/Jason-Vaughan/TangleClaw/issues/581) | enhancement | ✅ closed | ~~TangleTweaker — per-LLM tunables console (sliders + presets), standalone or in-TangleClaw~~ |
| [#798](https://github.com/Jason-Vaughan/TangleClaw/issues/798) | feature | ✅ closed | ~~Guard the primary checkout while a chunk worktree exists — subagents and scripts default their cwd to the live install~~ |
| [#816](https://github.com/Jason-Vaughan/TangleClaw/issues/816) | bug | ✅ closed | ~~migrateToPlugin can write enabledPlugins with no marketplace entry — an unresolvable plugin reference on any fresh machine~~ |
| [#243](https://github.com/Jason-Vaughan/TangleClaw/issues/243) | chore | ✅ closed | ~~Remove Reset button from Global Rules editor UI (#240 follow-up)~~ |
| [#133](https://github.com/Jason-Vaughan/TangleClaw/issues/133) | enhancement | open | Codex TOML writer: carry both hook channels |
| [#362](https://github.com/Jason-Vaughan/TangleClaw/issues/362) | chore | ✅ closed | ~~Marking a chunk done under views_enabled is an unenforced 2-step ritual (regen-views can be forgotten)~~ |
| [#110](https://github.com/Jason-Vaughan/TangleClaw/issues/110) | enhancement | ✅ closed | ~~Auto-discover locally-installed AI models (Ollama, llama.cpp, LM Studio) for fallback chain UX~~ |
| [#112](https://github.com/Jason-Vaughan/TangleClaw/issues/112) | enhancement | ✅ closed | ~~Provider catalog: API key management + per-provider model surfacing~~ |
| [#363](https://github.com/Jason-Vaughan/TangleClaw/issues/363) | chore | open | Migrate openclaw_connections.host off literal IPs to Tailscale Magic DNS names |
| [#227](https://github.com/Jason-Vaughan/TangleClaw/issues/227) | enhancement | ✅ closed | ~~Detect when local clone is behind origin/main — banner (sibling to #199)~~ |
| [#2](https://github.com/Jason-Vaughan/TangleClaw/issues/2) | enhancement | open | Add Linux support (systemd) |
| [#239](https://github.com/Jason-Vaughan/TangleClaw/issues/239) | enhancement | open | Linux support for the Restart TangleClaw button (follow-up to #235) |
| [#533](https://github.com/Jason-Vaughan/TangleClaw/issues/533) | chore | open | Gate user-facing doc/screenshot parity the way CHANGELOG parity is gated |
| [#348](https://github.com/Jason-Vaughan/TangleClaw/issues/348) | enhancement | ✅ closed | ~~Continuity sync: re-scope without #341~~ |
| [#104](https://github.com/Jason-Vaughan/TangleClaw/issues/104) | enhancement | ✅ closed | ~~Universal pill UX contract: hover = category label, click = status detail~~ |
| [#345](https://github.com/Jason-Vaughan/TangleClaw/issues/345) | enhancement | ✅ closed | ~~Re-derive panel list for ttyd-watcher auto-remediation~~ |
| [#692](https://github.com/Jason-Vaughan/TangleClaw/issues/692) | bug | ✅ closed | ~~_cleanupOrphanLeases bulk-deletes leases on boot with no record of what it displaced~~ |
| [#581](https://github.com/Jason-Vaughan/TangleClaw/issues/581) | enhancement | ✅ closed | ~~TangleTweaker — per-LLM tunables console (sliders + presets), standalone or in-TangleClaw~~ |
| [#765](https://github.com/Jason-Vaughan/TangleClaw/issues/765) | enhancement | open | Prime delivery chunks 03–04: trigger-based routing and delivery receipts |
| [#776](https://github.com/Jason-Vaughan/TangleClaw/issues/776) | chore | open | Retire or wire up migrationStatus — persisted, NULL everywhere, no reader |
| [#788](https://github.com/Jason-Vaughan/TangleClaw/issues/788) | bug | open | The first step of the documented install fails on a clean Mac — git is a Command Line Tools stub |
| [#798](https://github.com/Jason-Vaughan/TangleClaw/issues/798) | feature | ✅ closed | ~~Guard the primary checkout while a chunk worktree exists — subagents and scripts default their cwd to the live install~~ |


## Communication

| Issue | Type | State | Title |
|---|---|---|---|
| [#857](https://github.com/Jason-Vaughan/TangleClaw/issues/857) | bug | open | No ClawBridge version floor — a 1.9.x bridge now fails with a misleading "prompt must instruct the AI" message |
| [#83](https://github.com/Jason-Vaughan/TangleClaw/issues/83) | enhancement | ✅ closed | ~~Audit remaining generic frontend error strings for server-message parity~~ |
| [#934](https://github.com/Jason-Vaughan/TangleClaw/issues/934) | bug | open | TangleClaw notifications not clearing (missing ACK to Medusa) |
| [#556](https://github.com/Jason-Vaughan/TangleClaw/issues/556) | bug | ✅ closed | ~~live-loop glow overrides Medusa mark state filters; blue glow on gold art reads green~~ |
| [#783](https://github.com/Jason-Vaughan/TangleClaw/issues/783) | bug | ✅ closed | ~~medusa-wake injects the Switchboard nudge into a focused SUBAGENT — false-idle read + no agent-focus gate~~ |
| [#784](https://github.com/Jason-Vaughan/TangleClaw/issues/784) | bug | ✅ closed | ~~Switchboard messages are never cleared or marked handled — POST /medusa/read moves a counter, not the inbox~~ |
| [#785](https://github.com/Jason-Vaughan/TangleClaw/issues/785) | bug | ✅ closed | ~~Switchboard inbox silently empties while reporting state=listening — messages lost with no trace~~ |
| [#818](https://github.com/Jason-Vaughan/TangleClaw/issues/818) | enhancement | ✅ closed | ~~A Switchboard that never silently drops a message — rollup across TangleClaw + Medusa~~ |
| [#837](https://github.com/Jason-Vaughan/TangleClaw/issues/837) | bug | ✅ closed | ~~POST /medusa/read clears a listener counter but never marks messages read, so API consumers re-count them forever~~ |
| [#912](https://github.com/Jason-Vaughan/TangleClaw/issues/912) | bug | ✅ closed | ~~Medusa wake nudge omits the reply obligation, so initiators hang silently~~ |
| [#1023](https://github.com/Jason-Vaughan/TangleClaw/issues/1023) | bug | ✅ closed | ~~Switchboard sends target an ephemeral workspace id — a peer restart rotates it and the send hard-fails SEND_REJECTED~~ |
| [#83](https://github.com/Jason-Vaughan/TangleClaw/issues/83) | enhancement | ✅ closed | ~~Audit remaining generic frontend error strings for server-message parity~~ |
| [#556](https://github.com/Jason-Vaughan/TangleClaw/issues/556) | bug | ✅ closed | ~~live-loop glow overrides Medusa mark state filters; blue glow on gold art reads green~~ |


## Quality

| Issue | Type | State | Title |
|---|---|---|---|
| [#108](https://github.com/Jason-Vaughan/TangleClaw/issues/108) | enhancement | open | Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation |
| [#108](https://github.com/Jason-Vaughan/TangleClaw/issues/108) | enhancement | open | Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation |


## Code Review

| Issue | Type | State | Title |
|---|---|---|---|
| [#793](https://github.com/Jason-Vaughan/TangleClaw/issues/793) | feature | open | Tangle Code Review — autonomous PR review bot |


## Release

| Issue | Type | State | Title |
|---|---|---|---|
| [#711](https://github.com/Jason-Vaughan/TangleClaw/issues/711) | enhancement | ✅ closed | ~~Complete the update path: provision dependencies/deploy assets, and don't strand a dirty checkout~~ |
| [#213](https://github.com/Jason-Vaughan/TangleClaw/issues/213) | chore | ✅ closed | ~~Update global-rules `--auto` rule to default-on for feature PRs (Auto Mode reconciliation)~~ |
| [#794](https://github.com/Jason-Vaughan/TangleClaw/issues/794) | chore | open | GitHub sync on release — update docs, images, and metadata to match current state |
| [#297](https://github.com/Jason-Vaughan/TangleClaw/issues/297) | enhancement | open | TC-driven OpenClaw update button (blocked: SSH user lacks container-runtime access) |
| [#625](https://github.com/Jason-Vaughan/TangleClaw/issues/625) | chore | ✅ closed | ~~Cache-bump guard is monotone — it can pin the current CACHE_NAME but never catch the next missed bump~~ |
| [#213](https://github.com/Jason-Vaughan/TangleClaw/issues/213) | chore | ✅ closed | ~~Update global-rules `--auto` rule to default-on for feature PRs (Auto Mode reconciliation)~~ |


## Dependency management

_No pending items._


## Operations

| Issue | Type | State | Title |
|---|---|---|---|
| [#411](https://github.com/Jason-Vaughan/TangleClaw/issues/411) | bug | open | Stale service worker can mask the restart button / out-of-date banner on long-lived remote tabs |
| [#825](https://github.com/Jason-Vaughan/TangleClaw/issues/825) | bug | open | A restarting server hides behind the unprotected screen — Continue fetches a dying process |
| [#709](https://github.com/Jason-Vaughan/TangleClaw/issues/709) | bug | ✅ closed | ~~Dead server renders as an endless "Connection lost. Retrying…" loop behind a cached SW shell~~ |
| [#1382](https://github.com/Jason-Vaughan/TangleClaw/issues/1382) | bug | open | PortHub ignore list uses per-browser localStorage |
| [#113](https://github.com/Jason-Vaughan/TangleClaw/issues/113) | enhancement | ✅ closed | ~~LiteLLM proxy health indicator (footer pill or dot) with degradation/down detail on click~~ |
| [#107](https://github.com/Jason-Vaughan/TangleClaw/issues/107) | enhancement | ✅ closed | ~~LiteLLM Supervision & Aliases UI (via orchestration profiles)~~ |
| [#107](https://github.com/Jason-Vaughan/TangleClaw/issues/107) | enhancement | ✅ closed | ~~LiteLLM Supervision & Aliases UI (via orchestration profiles)~~ |
| [#113](https://github.com/Jason-Vaughan/TangleClaw/issues/113) | enhancement | ✅ closed | ~~LiteLLM proxy health indicator (footer pill or dot) with degradation/down detail on click~~ |
| [#411](https://github.com/Jason-Vaughan/TangleClaw/issues/411) | bug | open | Stale service worker can mask the restart button / out-of-date banner on long-lived remote tabs |
| [#789](https://github.com/Jason-Vaughan/TangleClaw/issues/789) | bug | open | ingress-cutover --to direct always crashes after succeeding — pollHealth hardcodes https.get |


## Security

| Issue | Type | State | Title |
|---|---|---|---|
| [#806](https://github.com/Jason-Vaughan/TangleClaw/issues/806) | bug | ✅ closed | ~~A completed caddy-mode install with no credential has no way to set one~~ |
| [#1205](https://github.com/Jason-Vaughan/TangleClaw/issues/1205) | bug | open | test/dir-scanner.test.js deadline/kill guard is red on darwin, green on ubuntu CI |
| [#786](https://github.com/Jason-Vaughan/TangleClaw/issues/786) | bug | open | A missing mkcert makes ingress-cutover throw a stack trace instead of a tagged refusal |
| [#800](https://github.com/Jason-Vaughan/TangleClaw/issues/800) | bug | ✅ closed | ~~Post-v5 auth-surface residue from #710: stored wide-bind is invisible in caddy mode, and ttyd exposure misses LAN-IP binds~~ |

