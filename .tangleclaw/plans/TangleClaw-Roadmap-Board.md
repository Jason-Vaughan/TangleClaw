# TangleClaw — Roadmap Board

7 trains assembled and premise-verified; **29** issues grouped into **14** named clusters behind them.

| Open issues | In a train | In the yard | Unmilestoned |
|---|---|---|---|
| **277** | **52** | **29** | **11** |

_Data as of 2026-09-24 00:07 UTC._ A snapshot, not a live feed — a published page cannot poll GitHub. Regenerate with `build-board.py`, then republish.

> **Release gate.** These are POST-v5 trains. Nothing couples until v5 releases. Shipping model (ratified 2026-07-30): each version ships ONE train with all its cars — v5.1 is one complete train, v5.2 the next. Nothing here couples while `versionBumpEnabled` is false.

---

## Trains — assembled

### [First Install, Completed](https://github.com/Jason-Vaughan/TangleClaw/milestone/1) · `premises verified`

*The rest of the first hour. Finishes what v5 starts.*

**6 open · 8 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#411](https://github.com/Jason-Vaughan/TangleClaw/issues/411) | bug | open | Stale service worker can mask the restart button / out-of-date banner on long-lived remote tabs |
| [#575](https://github.com/Jason-Vaughan/TangleClaw/issues/575) | bug | open | Opening a session from a phone lands on the wrong port — operator must hand-edit the URL to :8443 |
| [#788](https://github.com/Jason-Vaughan/TangleClaw/issues/788) | bug | open | The first step of the documented install fails on a clean Mac — git is a Command Line Tools stub |
| [#825](https://github.com/Jason-Vaughan/TangleClaw/issues/825) | bug | open | A restarting server hides behind the unprotected screen — Continue fetches a dying process |
| [#857](https://github.com/Jason-Vaughan/TangleClaw/issues/857) | bug | open | No ClawBridge version floor — a 1.9.x bridge now fails with a misleading "prompt must instruct the AI" message |
| [#880](https://github.com/Jason-Vaughan/TangleClaw/issues/880) | enhancement | open | Stop shipping ~/Documents/Projects as the default projectsDir — the wizard warns about its own default |
| [#401](https://github.com/Jason-Vaughan/TangleClaw/issues/401) | bug | ✅ closed | ~~Fresh install: opening a new project shows no launch-mode picker (bypass/interactive/etc.)~~ |
| [#626](https://github.com/Jason-Vaughan/TangleClaw/issues/626) | enhancement | ✅ closed | ~~Create Project collects only 4 fields — first-session settings (launch posture, silent prime) can't be set at creation~~ |
| [#708](https://github.com/Jason-Vaughan/TangleClaw/issues/708) | bug | ✅ closed | ~~First-run setup attaches the TangleClaw clone itself as a managed project~~ |
| [#709](https://github.com/Jason-Vaughan/TangleClaw/issues/709) | bug | ✅ closed | ~~Dead server renders as an endless "Connection lost. Retrying…" loop behind a cached SW shell~~ |
| [#711](https://github.com/Jason-Vaughan/TangleClaw/issues/711) | enhancement | ✅ closed | ~~Complete the update path: provision dependencies/deploy assets, and don't strand a dirty checkout~~ |
| [#752](https://github.com/Jason-Vaughan/TangleClaw/issues/752) | bug | ✅ closed | ~~syncEngineHooks wipes operator-authored hooks from a managed project's .claude/settings.json at every session launch~~ |
| [#806](https://github.com/Jason-Vaughan/TangleClaw/issues/806) | bug | ✅ closed | ~~A completed caddy-mode install with no credential has no way to set one~~ |
| [#909](https://github.com/Jason-Vaughan/TangleClaw/issues/909) | bug | ✅ closed | ~~The setup wizard draws a working tree it could not read as clean~~ |

**Sequencing.** #711 is load-bearing — without it every later train only reaches people who reinstall by hand.

### [The UI Says What It's Doing](https://github.com/Jason-Vaughan/TangleClaw/milestone/2) · `premises verified`

*Every one is "the interface knows something and doesn't tell you."*

**4 open · 23 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#128](https://github.com/Jason-Vaughan/TangleClaw/issues/128) | enhancement | open | System resource + health pills in OpenClaw session header |
| [#1375](https://github.com/Jason-Vaughan/TangleClaw/issues/1375) | — | open | projects: a string tags value crashes the card detail render |
| [#1382](https://github.com/Jason-Vaughan/TangleClaw/issues/1382) | bug | open | PortHub ignore list uses per-browser localStorage |
| [#1384](https://github.com/Jason-Vaughan/TangleClaw/issues/1384) | — | open | ui: single-quoted onclick args break on an apostrophe — esc() emits &#39; which the parser decodes back |
| [#83](https://github.com/Jason-Vaughan/TangleClaw/issues/83) | enhancement | ✅ closed | ~~Audit remaining generic frontend error strings for server-message parity~~ |
| [#104](https://github.com/Jason-Vaughan/TangleClaw/issues/104) | enhancement | ✅ closed | ~~Universal pill UX contract: hover = category label, click = status detail~~ |
| [#113](https://github.com/Jason-Vaughan/TangleClaw/issues/113) | enhancement | ✅ closed | ~~LiteLLM proxy health indicator (footer pill or dot) with degradation/down detail on click~~ |
| [#185](https://github.com/Jason-Vaughan/TangleClaw/issues/185) | enhancement | ✅ closed | ~~Live wrap pipeline progress via SSE~~ |
| [#227](https://github.com/Jason-Vaughan/TangleClaw/issues/227) | enhancement | ✅ closed | ~~Detect when local clone is behind origin/main — banner (sibling to #199)~~ |
| [#243](https://github.com/Jason-Vaughan/TangleClaw/issues/243) | chore | ✅ closed | ~~Remove Reset button from Global Rules editor UI (#240 follow-up)~~ |
| [#261](https://github.com/Jason-Vaughan/TangleClaw/issues/261) | enhancement | ✅ closed | ~~Surface engine API errors in session UI (Codex 400s, etc.)~~ |
| [#345](https://github.com/Jason-Vaughan/TangleClaw/issues/345) | enhancement | ✅ closed | ~~Re-derive panel list for ttyd-watcher auto-remediation~~ |
| [#438](https://github.com/Jason-Vaughan/TangleClaw/issues/438) | enhancement | ✅ closed | ~~Toolbar Copy button — one-tap copy of the last terminal selection to the browser clipboard (touch devices)~~ |
| [#542](https://github.com/Jason-Vaughan/TangleClaw/issues/542) | enhancement | ✅ closed | ~~TangleClaw-served plan/design doc links (engine-agnostic "openable from anywhere")~~ |
| [#769](https://github.com/Jason-Vaughan/TangleClaw/issues/769) | bug | ✅ closed | ~~Upload gives no confirmation it succeeded — just a path under "Tell your AI assistant"~~ |
| [#770](https://github.com/Jason-Vaughan/TangleClaw/issues/770) | enhancement | ✅ closed | ~~Upload one file at a time is the only option — support multi-file selection~~ |
| [#771](https://github.com/Jason-Vaughan/TangleClaw/issues/771) | bug | ✅ closed | ~~Wrap gives no visible in-progress state — users click Wrap repeatedly because nothing says it's running~~ |
| [#790](https://github.com/Jason-Vaughan/TangleClaw/issues/790) | feature | ✅ closed | ~~LLM filter in project view~~ |
| [#817](https://github.com/Jason-Vaughan/TangleClaw/issues/817) | bug | ✅ closed | ~~Dashboard shell silently fails to initialize — document loads, no dashboard API calls, self-resolved with no intervention~~ |
| [#823](https://github.com/Jason-Vaughan/TangleClaw/issues/823) | bug | ✅ closed | ~~Dashboard buttons are 32px targets on a mobile-first project~~ |
| [#854](https://github.com/Jason-Vaughan/TangleClaw/issues/854) | enhancement | ✅ closed | ~~Wrap preflight — surface unmet prawduct gates at the door, not mid-pipeline~~ |
| [#907](https://github.com/Jason-Vaughan/TangleClaw/issues/907) | bug | ✅ closed | ~~getSessionStatus reports idle=false, lastOutputAge=0 when tmux could not be read~~ |
| [#1148](https://github.com/Jason-Vaughan/TangleClaw/issues/1148) | bug | ✅ closed | ~~Managed sessions cannot validate EventKit automations; external LaunchAgent works~~ |
| [#1164](https://github.com/Jason-Vaughan/TangleClaw/issues/1164) | bug | ✅ closed | ~~Settings modal fetches the delivery ledger into a container no markup creates~~ |
| [#1192](https://github.com/Jason-Vaughan/TangleClaw/issues/1192) | bug | ✅ closed | ~~Dashboard toolbar overlaps and clips on a phone — the operator's primary device~~ |
| [#1215](https://github.com/Jason-Vaughan/TangleClaw/issues/1215) | bug | ✅ closed | ~~Dashboard header pills (.dash-action) are 24px targets on a mobile-first project~~ |
| [#1383](https://github.com/Jason-Vaughan/TangleClaw/issues/1383) | — | ✅ closed | ~~ui: the import banner's Ignore button has never worked — double-encoded name~~ |

**Sequencing.** Ship #771's cheap fix first; #185 subsumes it.

### [Session Switchboard](https://github.com/Jason-Vaughan/TangleClaw/milestone/3) · `premises verified`

*Every car is a way a message dies quietly between two sessions.*

**5 open · 21 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#801](https://github.com/Jason-Vaughan/TangleClaw/issues/801) | enhancement | open | Session Switchboard v2 automation — opt-in auto-inject and swarm stats, gated on the delivery guarantee |
| [#810](https://github.com/Jason-Vaughan/TangleClaw/issues/810) | enhancement | open | Keep the steward session up — a managed always-on session class (Medusa reaps a wrapped consumer's identity) |
| [#934](https://github.com/Jason-Vaughan/TangleClaw/issues/934) | bug | open | TangleClaw notifications not clearing (missing ACK to Medusa) |
| [#1025](https://github.com/Jason-Vaughan/TangleClaw/issues/1025) | bug | open | Inbound Medusa delivery has no addressing — any running agent in a session can pick up a message meant for the session |
| [#1084](https://github.com/Jason-Vaughan/TangleClaw/issues/1084) | enhancement | open | Shared-doc change broadcast should reach the Project Master |
| [#342](https://github.com/Jason-Vaughan/TangleClaw/issues/342) | enhancement | ✅ closed | ~~Session continuity: add landing-card preview and Continue/Fresh launch choice~~ |
| [#372](https://github.com/Jason-Vaughan/TangleClaw/issues/372) | enhancement | ✅ closed | ~~Session-continuity / intent-reconciliation check at session start~~ |
| [#556](https://github.com/Jason-Vaughan/TangleClaw/issues/556) | bug | ✅ closed | ~~live-loop glow overrides Medusa mark state filters; blue glow on gold art reads green~~ |
| [#783](https://github.com/Jason-Vaughan/TangleClaw/issues/783) | bug | ✅ closed | ~~medusa-wake injects the Switchboard nudge into a focused SUBAGENT — false-idle read + no agent-focus gate~~ |
| [#784](https://github.com/Jason-Vaughan/TangleClaw/issues/784) | bug | ✅ closed | ~~Switchboard messages are never cleared or marked handled — POST /medusa/read moves a counter, not the inbox~~ |
| [#785](https://github.com/Jason-Vaughan/TangleClaw/issues/785) | bug | ✅ closed | ~~Switchboard inbox silently empties while reporting state=listening — messages lost with no trace~~ |
| [#791](https://github.com/Jason-Vaughan/TangleClaw/issues/791) | bug | ✅ closed | ~~Switchboard: messages arrive in inbox but fail to inject into live session~~ |
| [#792](https://github.com/Jason-Vaughan/TangleClaw/issues/792) | bug | ✅ closed | ~~A Switchboard message can arrive with the session never told — no delivery receipt, and the operator becomes the transport~~ |
| [#812](https://github.com/Jason-Vaughan/TangleClaw/issues/812) | bug | ✅ closed | ~~tmux.sendKeys pastes onto UNSENT draft text and hits Enter — it submits the operator's half-typed line with our payload glued on~~ |
| [#818](https://github.com/Jason-Vaughan/TangleClaw/issues/818) | enhancement | ✅ closed | ~~A Switchboard that never silently drops a message — rollup across TangleClaw + Medusa~~ |
| [#820](https://github.com/Jason-Vaughan/TangleClaw/issues/820) | bug | ✅ closed | ~~The Medusa control appears on every session page regardless of medusaEnabled — the flag gates autostart, not the surface~~ |
| [#836](https://github.com/Jason-Vaughan/TangleClaw/issues/836) | bug | ✅ closed | ~~Medusa listeners outlive their sessions — the roster reports dead sessions as connected~~ |
| [#837](https://github.com/Jason-Vaughan/TangleClaw/issues/837) | bug | ✅ closed | ~~POST /medusa/read clears a listener counter but never marks messages read, so API consumers re-count them forever~~ |
| [#868](https://github.com/Jason-Vaughan/TangleClaw/issues/868) | enhancement | ✅ closed | ~~Nothing surfaces a stranded wrap — the wrap.auto_pr row is queryable but not discoverable~~ |
| [#904](https://github.com/Jason-Vaughan/TangleClaw/issues/904) | bug | ✅ closed | ~~Generated project rules never mention the Medusa switchboard — sessions can't use infrastructure they were never told exists~~ |
| [#912](https://github.com/Jason-Vaughan/TangleClaw/issues/912) | bug | ✅ closed | ~~Medusa wake nudge omits the reply obligation, so initiators hang silently~~ |
| [#945](https://github.com/Jason-Vaughan/TangleClaw/issues/945) | enhancement | ✅ closed | ~~Broadcast Medusa notifications to active sessions when a Shared Document updates~~ |
| [#998](https://github.com/Jason-Vaughan/TangleClaw/issues/998) | bug | ✅ closed | ~~The shared-doc watcher nudges the session that wrote the file — a self-inflicted wake loop into a live pane~~ |
| [#1020](https://github.com/Jason-Vaughan/TangleClaw/issues/1020) | bug | ✅ closed | ~~Switchboard wake nudge points at a "project guide" that never states the base URL — dangling for every plugin-governed project~~ |
| [#1023](https://github.com/Jason-Vaughan/TangleClaw/issues/1023) | bug | ✅ closed | ~~Switchboard sends target an ephemeral workspace id — a peer restart rotates it and the send hard-fails SEND_REJECTED~~ |
| [#1075](https://github.com/Jason-Vaughan/TangleClaw/issues/1075) | bug | ✅ closed | ~~Message bridge unreachable — cross-session roster lookup fails (502)~~ |

**Sequencing.** These bugs ARE the at-least-once delivery guarantee that gates v2 automation (#801). Do not start auto-inject while any are open.

### [Fleet Intelligence](https://github.com/Jason-Vaughan/TangleClaw/milestone/4) · `premises verified`

*Autonomous fleet-level agents, in the Project Master lineage.*

**5 open · 2 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#349](https://github.com/Jason-Vaughan/TangleClaw/issues/349) | enhancement | open | Landing-page fleet idle/wedged indicator (passive per-session state) |
| [#777](https://github.com/Jason-Vaughan/TangleClaw/issues/777) | enhancement | open | Cross-project version dependency registry + notify dependents on release |
| [#793](https://github.com/Jason-Vaughan/TangleClaw/issues/793) | feature | open | Tangle Code Review — autonomous PR review bot |
| [#809](https://github.com/Jason-Vaughan/TangleClaw/issues/809) | enhancement | open | Own the trigger for prawduct governance telemetry — per-call log + one session report at wrap |
| [#830](https://github.com/Jason-Vaughan/TangleClaw/issues/830) | feature | open | Warn a launching session when its plugin version moved, and flag running sessions that are stale |
| [#111](https://github.com/Jason-Vaughan/TangleClaw/issues/111) | enhancement | ✅ closed | ~~Per-project cost tracking footer with model breakdown + charts~~ |
| [#905](https://github.com/Jason-Vaughan/TangleClaw/issues/905) | bug | ✅ closed | ~~The Project Master reports as absent when tmux will not answer, not as unknown~~ |

**Sequencing.** #793 (Tangle Code Review) mirrors Project Master's architecture: per-project instance, own rules and LLM, banner button, never merges.

### [Release Readiness](https://github.com/Jason-Vaughan/TangleClaw/milestone/5) · `premises verified`

*Pre-release gate — the last things before a version ships. Empty by design; filled as each release approaches.*

**11 open · 11 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#660](https://github.com/Jason-Vaughan/TangleClaw/issues/660) | bug | open | A project with a changelog-update prompt override keeps stale wrap-contract text |
| [#670](https://github.com/Jason-Vaughan/TangleClaw/issues/670) | chore | open | Log when resolveSessionRange downgrades a session SHA to the trunk range |
| [#721](https://github.com/Jason-Vaughan/TangleClaw/issues/721) | enhancement | open | Offer release automation to managed projects, not just TangleClaw's own repo |
| [#747](https://github.com/Jason-Vaughan/TangleClaw/issues/747) | chore | open | Count refreshStatusBars skip reasons directly, and execute two source-shape tests |
| [#748](https://github.com/Jason-Vaughan/TangleClaw/issues/748) | bug | open | Feature Index graduation starves on ships-every-session projects — the #568 staged-write gate is per-FILE, so a busy project never hits a quiet wrap |
| [#772](https://github.com/Jason-Vaughan/TangleClaw/issues/772) | chore | open | Executor scripts have no coverage of step ORDER — extract decisions into pure functions |
| [#808](https://github.com/Jason-Vaughan/TangleClaw/issues/808) | enhancement | open | Put the clean-room guest on the tailnet so browser-only VRF assertions can actually be scored |
| [#847](https://github.com/Jason-Vaughan/TangleClaw/issues/847) | bug | open | #839's false commit promise still ships in four more places — including the operator-facing remediation text |
| [#1196](https://github.com/Jason-Vaughan/TangleClaw/issues/1196) | bug | open | Nothing reports how close an auto-stub block is to the 14-day guard — the first signal is a red main |
| [#1205](https://github.com/Jason-Vaughan/TangleClaw/issues/1205) | bug | open | test/dir-scanner.test.js deadline/kill guard is red on darwin, green on ubuntu CI |
| [#1377](https://github.com/Jason-Vaughan/TangleClaw/issues/1377) | — | open | tests: enforce node:assert/strict so the non-strict set cannot regrow |
| [#177](https://github.com/Jason-Vaughan/TangleClaw/issues/177) | chore | ✅ closed | ~~Rewrite WRAP_STEP_PATTERNS to enforce the structural quality floor~~ |
| [#213](https://github.com/Jason-Vaughan/TangleClaw/issues/213) | chore | ✅ closed | ~~Update global-rules `--auto` rule to default-on for feature PRs (Auto Mode reconciliation)~~ |
| [#362](https://github.com/Jason-Vaughan/TangleClaw/issues/362) | chore | ✅ closed | ~~Marking a chunk done under views_enabled is an unenforced 2-step ritual (regen-views can be forgotten)~~ |
| [#429](https://github.com/Jason-Vaughan/TangleClaw/issues/429) | bug | ✅ closed | ~~Plan-mode wraps time out to status:'blocked' instead of stalling~~ |
| [#797](https://github.com/Jason-Vaughan/TangleClaw/issues/797) | bug | ✅ closed | ~~Wrap `files:` records a cumulative branch inventory, not the session's changed files — disjoint from the actual commit~~ |
| [#802](https://github.com/Jason-Vaughan/TangleClaw/issues/802) | chore | ✅ closed | ~~VRF 7e.1 never ran — the no-caddy honest-absence screen is unverified end-to-end~~ |
| [#831](https://github.com/Jason-Vaughan/TangleClaw/issues/831) | bug | ✅ closed | ~~Tests running bare `git init` inherit the live global template dir and flake when TangleClaw rewrites it~~ |
| [#835](https://github.com/Jason-Vaughan/TangleClaw/issues/835) | chore | ✅ closed | ~~The upstream drift check never runs in CI — it skips on every runner~~ |
| [#840](https://github.com/Jason-Vaughan/TangleClaw/issues/840) | bug | ✅ closed | ~~A leftover .wrap-summary.md from a previous run can be read as the current run's payload~~ |
| [#843](https://github.com/Jason-Vaughan/TangleClaw/issues/843) | bug | ✅ closed | ~~learnings-capture blocks a wrap when there is genuinely nothing novel — and when its entry already landed~~ |
| [#844](https://github.com/Jason-Vaughan/TangleClaw/issues/844) | bug | ✅ closed | ~~CI's green certifies 5113 of 5128 tests — the 15 it skips are the ones that touch the real world~~ |

**Sequencing.** Cadence decision open: rolling per-release cars, or the home of the release runbook.

### [Public Parity](https://github.com/Jason-Vaughan/TangleClaw/milestone/6) · `premises verified`

*Post-release: GitHub docs, images, and metadata match what actually shipped.*

**6 open · 1 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#2](https://github.com/Jason-Vaughan/TangleClaw/issues/2) | enhancement | open | Add Linux support (systemd) |
| [#239](https://github.com/Jason-Vaughan/TangleClaw/issues/239) | enhancement | open | Linux support for the Restart TangleClaw button (follow-up to #235) |
| [#277](https://github.com/Jason-Vaughan/TangleClaw/issues/277) | chore | open | Extract architecture docs / config tables / component inventories out of CLAUDE.md into docs/ |
| [#533](https://github.com/Jason-Vaughan/TangleClaw/issues/533) | chore | open | Gate user-facing doc/screenshot parity the way CHANGELOG parity is gated |
| [#794](https://github.com/Jason-Vaughan/TangleClaw/issues/794) | chore | open | GitHub sync on release — update docs, images, and metadata to match current state |
| [#811](https://github.com/Jason-Vaughan/TangleClaw/issues/811) | enhancement | open | An indexable product manual that stays in parity with the code, readable by human and NHE alike |
| [#833](https://github.com/Jason-Vaughan/TangleClaw/issues/833) | question | ✅ closed | ~~Should a managed repo's prawduct install reference be a committed artifact, not untracked machine state?~~ |

**Sequencing.** Runs after each release ships — #794 is the recurring sync pass; a script can flag drift, but a human verifies and commits.

### [Engine Ecosystem](https://github.com/Jason-Vaughan/TangleClaw/milestone/7) · `premises verified`

*Integrating new engines and autonomous systems.*

**15 open · 14 closed**

| Issue | Type | State | |
|---|---|---|---|
| [#108](https://github.com/Jason-Vaughan/TangleClaw/issues/108) | enhancement | open | Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation |
| [#109](https://github.com/Jason-Vaughan/TangleClaw/issues/109) | enhancement | open | Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation |
| [#130](https://github.com/Jason-Vaughan/TangleClaw/issues/130) | enhancement | open | Extend silentPrime SessionStart hook to clear and resume matchers |
| [#133](https://github.com/Jason-Vaughan/TangleClaw/issues/133) | enhancement | open | Codex TOML writer: carry both hook channels |
| [#193](https://github.com/Jason-Vaughan/TangleClaw/issues/193) | bug | open | SessionStart hook stdout pollutes spawned engine's stdin instead of terminal display |
| [#260](https://github.com/Jason-Vaughan/TangleClaw/issues/260) | enhancement | open | Codex pre-flight model validation at session launch |
| [#346](https://github.com/Jason-Vaughan/TangleClaw/issues/346) | bug | open | Engine detection false-negative under launchd PATH (engine-generic) |
| [#595](https://github.com/Jason-Vaughan/TangleClaw/issues/595) | enhancement | open | Settings & rules governance: verified delivery, drift detection, and a working lifecycle — so rules actually reach sessions |
| [#737](https://github.com/Jason-Vaughan/TangleClaw/issues/737) | bug | open | Engine-profile changes shipped in a release are inert until the server restarts |
| [#738](https://github.com/Jason-Vaughan/TangleClaw/issues/738) | chore | open | Converge the setup wizard's engine picker onto the shared option builder |
| [#765](https://github.com/Jason-Vaughan/TangleClaw/issues/765) | enhancement | open | Prime delivery chunks 03–04: trigger-based routing and delivery receipts |
| [#776](https://github.com/Jason-Vaughan/TangleClaw/issues/776) | chore | open | Retire or wire up migrationStatus — persisted, NULL everywhere, no reader |
| [#781](https://github.com/Jason-Vaughan/TangleClaw/issues/781) | bug | open | Legacy vendored-hook cleanup isn't gated on the plugin being present, and the isPluginGoverned comment describes a deferral that doesn't exist |
| [#795](https://github.com/Jason-Vaughan/TangleClaw/issues/795) | feature | open | Hermes system integration — review, design, and implement support |
| [#1085](https://github.com/Jason-Vaughan/TangleClaw/issues/1085) | bug | open | lib/master.js hardcodes CLAUDE.md as the Master's identity filename — violates the engine-agnostic rule |
| [#106](https://github.com/Jason-Vaughan/TangleClaw/issues/106) | enhancement | ✅ closed | ~~Wrap LiteLLM admin UI as a TangleClaw infrastructure session~~ |
| [#107](https://github.com/Jason-Vaughan/TangleClaw/issues/107) | enhancement | ✅ closed | ~~LiteLLM Supervision & Aliases UI (via orchestration profiles)~~ |
| [#110](https://github.com/Jason-Vaughan/TangleClaw/issues/110) | enhancement | ✅ closed | ~~Auto-discover locally-installed AI models (Ollama, llama.cpp, LM Studio) for fallback chain UX~~ |
| [#112](https://github.com/Jason-Vaughan/TangleClaw/issues/112) | enhancement | ✅ closed | ~~Provider catalog: API key management + per-provider model surfacing~~ |
| [#348](https://github.com/Jason-Vaughan/TangleClaw/issues/348) | enhancement | ✅ closed | ~~Continuity sync: re-scope without #341~~ |
| [#455](https://github.com/Jason-Vaughan/TangleClaw/issues/455) | enhancement | ✅ closed | ~~"TangleBrain (orchestrated)" option in project engine config — pick a routing strategy, not a model~~ |
| [#581](https://github.com/Jason-Vaughan/TangleClaw/issues/581) | enhancement | ✅ closed | ~~TangleTweaker — per-LLM tunables console (sliders + presets), standalone or in-TangleClaw~~ |
| [#736](https://github.com/Jason-Vaughan/TangleClaw/issues/736) | chore | ✅ closed | ~~Normalize engine display name once in enrichment, instead of guarding it at every render site~~ |
| [#741](https://github.com/Jason-Vaughan/TangleClaw/issues/741) | bug | ✅ closed | ~~silentPrime is silently ignored on engines that don't support it — no warning, unlike defaultLaunchMode~~ |
| [#750](https://github.com/Jason-Vaughan/TangleClaw/issues/750) | bug | ✅ closed | ~~The learnings→rules promotion gate is unreachable in practice — 51 provisional, 0 active after a full project's history~~ |
| [#796](https://github.com/Jason-Vaughan/TangleClaw/issues/796) | bug | ✅ closed | ~~Two binding rule sources contradict each other in the same session, and nothing detects it~~ |
| [#798](https://github.com/Jason-Vaughan/TangleClaw/issues/798) | feature | ✅ closed | ~~Guard the primary checkout while a chunk worktree exists — subagents and scripts default their cwd to the live install~~ |
| [#816](https://github.com/Jason-Vaughan/TangleClaw/issues/816) | bug | ✅ closed | ~~migrateToPlugin can write enabledPlugins with no marketplace entry — an unresolvable plugin reference on any fresh machine~~ |
| [#858](https://github.com/Jason-Vaughan/TangleClaw/issues/858) | — | ✅ closed | ~~engines: an engine switch leaves the previous engine's config file behind as stale canon~~ |

**Sequencing.** #795 (Hermes) uses the OpenClaw integration as its architectural reference.

---

## The yard — not assembled

> **Read before promoting anything.** Every cluster premise WAS verified against main @b33246b on 2026-07-30 (full evidence: yard-sweep-2026-07-30.md in the TangleClaw-Roadmap workspace) — 8 stale/ruled issues closed, 15 flagged as grown (re-scope before scheduling). Verification decays: re-walk a cluster if meaningful merges have landed since, before promoting anything out of it.

### A · Settings & control surfaces · `order matters`

**1 open** · 7 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#764](https://github.com/Jason-Vaughan/TangleClaw/issues/764) | enhancement | open | Per-engine tabs in the settings modal — surface installed plugins/skills and engine-specific settings |
| [#243](https://github.com/Jason-Vaughan/TangleClaw/issues/243) | chore | ✅ closed | ~~Remove Reset button from Global Rules editor UI (#240 follow-up)~~ |
| [#596](https://github.com/Jason-Vaughan/TangleClaw/issues/596) | enhancement | ✅ closed | ~~Launch Mode picker: facelift + test coverage~~ |
| [#626](https://github.com/Jason-Vaughan/TangleClaw/issues/626) | enhancement | ✅ closed | ~~Create Project collects only 4 fields — first-session settings (launch posture, silent prime) can't be set at creation~~ |
| [#755](https://github.com/Jason-Vaughan/TangleClaw/issues/755) | enhancement | ✅ closed | ~~Make the Master's access-level control functional — enable suggest/write, server-enforced~~ |
| [#756](https://github.com/Jason-Vaughan/TangleClaw/issues/756) | enhancement | ✅ closed | ~~Master settings needs a launch-mode selector — it hardcodes null today~~ |
| [#758](https://github.com/Jason-Vaughan/TangleClaw/issues/758) | enhancement | ✅ closed | ~~Warn when a launch-time setting is changed on a project with a live session — the change silently doesn't apply~~ |
| [#768](https://github.com/Jason-Vaughan/TangleClaw/issues/768) | enhancement | ✅ closed | ~~Master drawer header becomes a real control bar — upload, Medusa, kill, and both mode axes, reusing the session controls~~ |

Strongest next-train candidate. #768 is blocked on #755 + #756 (its own backend table says so) — but those two are deliberately decoupled; never treat them as one unit. #764 waits on the #581/#741 decisions. #626/#596 grown — re-scope before scheduling. #209 closed (delivered via #211/#731).

### B · Engine parity · `order matters`

**5 open** · 3 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#133](https://github.com/Jason-Vaughan/TangleClaw/issues/133) | enhancement | open | Codex TOML writer: carry both hook channels |
| [#260](https://github.com/Jason-Vaughan/TangleClaw/issues/260) | enhancement | open | Codex pre-flight model validation at session launch |
| [#346](https://github.com/Jason-Vaughan/TangleClaw/issues/346) | bug | open | Engine detection false-negative under launchd PATH (engine-generic) |
| [#737](https://github.com/Jason-Vaughan/TangleClaw/issues/737) | bug | open | Engine-profile changes shipped in a release are inert until the server restarts |
| [#738](https://github.com/Jason-Vaughan/TangleClaw/issues/738) | chore | open | Converge the setup wizard's engine picker onto the shared option builder |
| [#261](https://github.com/Jason-Vaughan/TangleClaw/issues/261) | enhancement | ✅ closed | ~~Surface engine API errors in session UI (Codex 400s, etc.)~~ |
| [#736](https://github.com/Jason-Vaughan/TangleClaw/issues/736) | chore | ✅ closed | ~~Normalize engine display name once in enrichment, instead of guarding it at every render site~~ |
| [#741](https://github.com/Jason-Vaughan/TangleClaw/issues/741) | bug | ✅ closed | ~~silentPrime is silently ignored on engines that don't support it — no warning, unlike defaultLaunchMode~~ |

Start with #741 (verified exactly: silent zeroing at sessions.js:198-201, warn precedent 15 lines below). #133 grown — #749 added a second hook channel, so the codex TOML writer must carry two scripts. #346 retitle off the retired Gemini engine; the launchd-PATH bug is engine-generic. #392/#134 closed (Antigravity shipped, gemini retired).

### C · Self-improvement loop · `needs a decision`

**4 open** · 2 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#595](https://github.com/Jason-Vaughan/TangleClaw/issues/595) | enhancement | open | Settings & rules governance: verified delivery, drift detection, and a working lifecycle — so rules actually reach sessions |
| [#660](https://github.com/Jason-Vaughan/TangleClaw/issues/660) | bug | open | A project with a changelog-update prompt override keeps stale wrap-contract text |
| [#670](https://github.com/Jason-Vaughan/TangleClaw/issues/670) | chore | open | Log when resolveSessionRange downgrades a session SHA to the trunk range |
| [#748](https://github.com/Jason-Vaughan/TangleClaw/issues/748) | bug | open | Feature Index graduation starves on ships-every-session projects — the #568 staged-write gate is per-FILE, so a busy project never hits a quiet wrap |
| [#362](https://github.com/Jason-Vaughan/TangleClaw/issues/362) | chore | ✅ closed | ~~Marking a chunk done under views_enabled is an unenforced 2-step ritual (regen-views can be forgotten)~~ |
| [#750](https://github.com/Jason-Vaughan/TangleClaw/issues/750) | bug | ✅ closed | ~~The learnings→rules promotion gate is unreachable in practice — 51 provisional, 0 active after a full project's history~~ |

One decision, verified: the exact-match recurrence key is a ~100% false-negative matcher on free-form prose — fix #750 and the whole chain unblocks; #595's governance layer matters only once anything flows; #748 is the same starvation class (decide it as a class). #362 rehome to Prawduct.

### D · Model routing & cost · `needs a decision`

**0 open** · 7 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#106](https://github.com/Jason-Vaughan/TangleClaw/issues/106) | enhancement | ✅ closed | ~~Wrap LiteLLM admin UI as a TangleClaw infrastructure session~~ |
| [#107](https://github.com/Jason-Vaughan/TangleClaw/issues/107) | enhancement | ✅ closed | ~~LiteLLM Supervision & Aliases UI (via orchestration profiles)~~ |
| [#110](https://github.com/Jason-Vaughan/TangleClaw/issues/110) | enhancement | ✅ closed | ~~Auto-discover locally-installed AI models (Ollama, llama.cpp, LM Studio) for fallback chain UX~~ |
| [#111](https://github.com/Jason-Vaughan/TangleClaw/issues/111) | enhancement | ✅ closed | ~~Per-project cost tracking footer with model breakdown + charts~~ |
| [#112](https://github.com/Jason-Vaughan/TangleClaw/issues/112) | enhancement | ✅ closed | ~~Provider catalog: API key management + per-provider model surfacing~~ |
| [#113](https://github.com/Jason-Vaughan/TangleClaw/issues/113) | enhancement | ✅ closed | ~~LiteLLM proxy health indicator (footer pill or dot) with degradation/down detail on click~~ |
| [#455](https://github.com/Jason-Vaughan/TangleClaw/issues/455) | enhancement | ✅ closed | ~~"TangleBrain (orchestrated)" option in project engine config — pick a routing strategy, not a model~~ |

#107 is half-shipped: its per-project overlay IS orchestration profiles (#357). Re-scope the remainder (LiteLLM supervision + aliases UI) on top of that. #106/#111/#113 hard-blocked on the remainder; #112 needs a key-custody decision first (conflicts with the shipped keyRef doctrine); #455 waits only on TangleBrain#70.

### E · OpenClaw · `needs a decision`

**4 open**

| Issue | Type | State | |
|---|---|---|---|
| [#128](https://github.com/Jason-Vaughan/TangleClaw/issues/128) | enhancement | open | System resource + health pills in OpenClaw session header |
| [#254](https://github.com/Jason-Vaughan/TangleClaw/issues/254) | bug | open | openclaw-direct: forces device re-pairing each launch + misreports remote IP as Cloudflare edge on Tailscale traffic |
| [#297](https://github.com/Jason-Vaughan/TangleClaw/issues/297) | enhancement | open | TC-driven OpenClaw update button (blocked: SSH user lacks container-runtime access) |
| [#363](https://github.com/Jason-Vaughan/TangleClaw/issues/363) | chore | open | Migrate openclaw_connections.host off literal IPs to Tailscale Magic DNS names |

NOT code-dormant — recent issue-tagged work throughout and 4 live IP-literal connections in the DB (#363 verified against real rows). Dormant-or-revive is an operational call about the hosts, not code rot. #297's phase 1 unblocked by #308. #293 closed (tunnel auto-heal shipped via #288/#291/#294).

### F · Staleness & cache

**1 open** · 2 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#411](https://github.com/Jason-Vaughan/TangleClaw/issues/411) | bug | open | Stale service worker can mask the restart button / out-of-date banner on long-lived remote tabs |
| [#227](https://github.com/Jason-Vaughan/TangleClaw/issues/227) | enhancement | ✅ closed | ~~Detect when local clone is behind origin/main — banner (sibling to #199)~~ |
| [#625](https://github.com/Jason-Vaughan/TangleClaw/issues/625) | chore | ✅ closed | ~~Cache-bump guard is monotone — it can pin the current CACHE_NAME but never catch the next missed bump~~ |

All three verified live. #625 sharpened: sw.js is at v3-59 while the test guard still pins >=54 — five bumps it could not check. #380 closed (watchdog + SW fixes shipped via #389/#391).

### G · Platform reach

**2 open**

| Issue | Type | State | |
|---|---|---|---|
| [#2](https://github.com/Jason-Vaughan/TangleClaw/issues/2) | enhancement | open | Add Linux support (systemd) |
| [#239](https://github.com/Jason-Vaughan/TangleClaw/issues/239) | enhancement | open | Linux support for the Restart TangleClaw button (follow-up to #235) |

#239 is a strict subset of #2 — link them. Both verified: install.sh still hard-errors on non-Darwin.

### H · Docs & repo hygiene · `mis-sized`

**2 open** · 3 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#277](https://github.com/Jason-Vaughan/TangleClaw/issues/277) | chore | open | Extract architecture docs / config tables / component inventories out of CLAUDE.md into docs/ |
| [#533](https://github.com/Jason-Vaughan/TangleClaw/issues/533) | chore | open | Gate user-facing doc/screenshot parity the way CHANGELOG parity is gated |
| [#83](https://github.com/Jason-Vaughan/TangleClaw/issues/83) | enhancement | ✅ closed | ~~Audit remaining generic frontend error strings for server-message parity~~ |
| [#177](https://github.com/Jason-Vaughan/TangleClaw/issues/177) | chore | ✅ closed | ~~Rewrite WRAP_STEP_PATTERNS to enforce the structural quality floor~~ |
| [#213](https://github.com/Jason-Vaughan/TangleClaw/issues/213) | chore | ✅ closed | ~~Update global-rules `--auto` rule to default-on for feature PRs (Auto Mode reconciliation)~~ |

#177 needs a REWRITE, not scheduling: the code-owned pipeline declares 14 step ids and 8+ silently auto-pass — the unearned quality floor is structural now. #213 newly unblocked (#212 closed): the advertised 2-minute edit. #277/#83 grown — partially delivered already.

### I · Session comms

**1 open** · 3 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#400](https://github.com/Jason-Vaughan/TangleClaw/issues/400) | enhancement | open | Cross-session / Project Master assistant: assisted remote cert + CA-trust install |
| [#342](https://github.com/Jason-Vaughan/TangleClaw/issues/342) | enhancement | ✅ closed | ~~Session continuity: add landing-card preview and Continue/Fresh launch choice~~ |
| [#348](https://github.com/Jason-Vaughan/TangleClaw/issues/348) | enhancement | ✅ closed | ~~Continuity sync: re-scope without #341~~ |
| [#372](https://github.com/Jason-Vaughan/TangleClaw/issues/372) | enhancement | ✅ closed | ~~Session-continuity / intent-reconciliation check at session start~~ |

#333 closed delivered-in-beta — successor #801 (v2 automation) is gated on the Switchboard train's delivery bugs. #342 is the missing front half of a shipped spine (continuity-write + Next-action exist; the landing preview and Continue/Fresh picker don't). #348 re-scope: its linchpin #341 closed NOT_PLANNED.

### J · Landing & fleet visibility · `order matters`

**2 open** · 2 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#108](https://github.com/Jason-Vaughan/TangleClaw/issues/108) | enhancement | open | Adversarial Agent primitive: methodology-callable subagent for systematic edge-case generation |
| [#349](https://github.com/Jason-Vaughan/TangleClaw/issues/349) | enhancement | open | Landing-page fleet idle/wedged indicator (passive per-session state) |
| [#104](https://github.com/Jason-Vaughan/TangleClaw/issues/104) | enhancement | ✅ closed | ~~Universal pill UX contract: hover = category label, click = status detail~~ |
| [#345](https://github.com/Jason-Vaughan/TangleClaw/issues/345) | enhancement | ✅ closed | ~~Re-derive panel list for ttyd-watcher auto-remediation~~ |

#104's case STRENGTHENS as it waits — the new sidecar pills shipped with raw title= tooltips, growing the surface the contract must cover. Land before #128/#113. #345's headline hazard is now auto-remediated (ttyd-watcher); re-derive its panel list.

### K · Infra & misc

**2 open** · 3 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#721](https://github.com/Jason-Vaughan/TangleClaw/issues/721) | enhancement | open | Offer release automation to managed projects, not just TangleClaw's own repo |
| [#747](https://github.com/Jason-Vaughan/TangleClaw/issues/747) | chore | open | Count refreshStatusBars skip reasons directly, and execute two source-shape tests |
| [#542](https://github.com/Jason-Vaughan/TangleClaw/issues/542) | enhancement | ✅ closed | ~~TangleClaw-served plan/design doc links (engine-agnostic "openable from anywhere")~~ |
| [#556](https://github.com/Jason-Vaughan/TangleClaw/issues/556) | bug | ✅ closed | ~~live-loop glow overrides Medusa mark state filters; blue glow on gold art reads green~~ |
| [#692](https://github.com/Jason-Vaughan/TangleClaw/issues/692) | bug | ✅ closed | ~~_cleanupOrphanLeases bulk-deletes leases on boot with no record of what it displaced~~ |

#721 is the prerequisite for #777 — per-project release automation before cross-project dependency notification. #556 verified exactly as filed (equal-specificity CSS, blue --root-accent). #343 closed (shipped PR #377).

### L · Big rocks / RFC

**2 open** · 1 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#109](https://github.com/Jason-Vaughan/TangleClaw/issues/109) | enhancement | open | Engine-failure failover: detect crash, surface notification, offer alternate engine with explicit user confirmation |
| [#130](https://github.com/Jason-Vaughan/TangleClaw/issues/130) | enhancement | open | Extend silentPrime SessionStart hook to clear and resume matchers |
| [#581](https://github.com/Jason-Vaughan/TangleClaw/issues/581) | enhancement | ✅ closed | ~~TangleTweaker — per-LLM tunables console (sliders + presets), standalone or in-TangleClaw~~ |

#581 is arguably a separate product wearing feature clothes; its env-var inventory was pinned against ~v2.1.2xx and mandates re-verification at build time. #109/#130 verified unbuilt.

### M · Prime delivery · `needs a decision`

**1 open**

| Issue | Type | State | |
|---|---|---|---|
| [#765](https://github.com/Jason-Vaughan/TangleClaw/issues/765) | enhancement | open | Prime delivery chunks 03–04: trigger-based routing and delivery receipts |

#765 verified: chunks 03-04 unshipped, and PRM-7T3Q's #759 incident evidence is still invisible on GitHub — absorb it. #368 closed per ADR 0011 decision 6 (reopen path recorded on the issue).

### N · Terminal, input & wrap defects

**2 open** · 2 shipped since filing

| Issue | Type | State | |
|---|---|---|---|
| [#192](https://github.com/Jason-Vaughan/TangleClaw/issues/192) | bug | open | tmux/ttyd: multi-line paste into web terminal corrupts input |
| [#193](https://github.com/Jason-Vaughan/TangleClaw/issues/193) | bug | open | SessionStart hook stdout pollutes spawned engine's stdin instead of terminal display |
| [#429](https://github.com/Jason-Vaughan/TangleClaw/issues/429) | bug | ✅ closed | ~~Plan-mode wraps time out to status:'blocked' instead of stalling~~ |
| [#438](https://github.com/Jason-Vaughan/TangleClaw/issues/438) | enhancement | ✅ closed | ~~Toolbar Copy button — one-tap copy of the last terminal selection to the browser clipboard (touch devices)~~ |

#429 retitle: after #672's file-settle signal, plan-mode wraps now time out to status:blocked instead of stalling indefinitely — same gap, different symptom.

---

## Loose, held, and off-GitHub

### Unmilestoned

*Unmilestoned deliberately — placed at the next train-formation pass.*

| Issue | Type | State | |
|---|---|---|---|
| [#776](https://github.com/Jason-Vaughan/TangleClaw/issues/776) | chore | open | Retire or wire up migrationStatus — persisted, NULL everywhere, no reader |
| [#777](https://github.com/Jason-Vaughan/TangleClaw/issues/777) | enhancement | open | Cross-project version dependency registry + notify dependents on release |
| [#781](https://github.com/Jason-Vaughan/TangleClaw/issues/781) | bug | open | Legacy vendored-hook cleanup isn't gated on the plugin being present, and the isPluginGoverned comment describes a deferral that doesn't exist |
| [#786](https://github.com/Jason-Vaughan/TangleClaw/issues/786) | bug | open | A missing mkcert makes ingress-cutover throw a stack trace instead of a tagged refusal |
| [#788](https://github.com/Jason-Vaughan/TangleClaw/issues/788) | bug | open | The first step of the documented install fails on a clean Mac — git is a Command Line Tools stub |
| [#789](https://github.com/Jason-Vaughan/TangleClaw/issues/789) | bug | open | ingress-cutover --to direct always crashes after succeeding — pollHealth hardcodes https.get |
| [#798](https://github.com/Jason-Vaughan/TangleClaw/issues/798) | feature | ✅ closed | ~~Guard the primary checkout while a chunk worktree exists — subagents and scripts default their cwd to the live install~~ |
| [#800](https://github.com/Jason-Vaughan/TangleClaw/issues/800) | bug | ✅ closed | ~~Post-v5 auth-surface residue from #710: stored wide-bind is invisible in caddy mode, and ttyd exposure misses LAN-IP binds~~ |
| [#801](https://github.com/Jason-Vaughan/TangleClaw/issues/801) | enhancement | open | Session Switchboard v2 automation — opt-in auto-inject and swarm stats, gated on the delivery guarantee |
| [#884](https://github.com/Jason-Vaughan/TangleClaw/issues/884) | bug | ✅ closed | ~~Registered projects still block the event loop — the synchronous-read family #883 did not sweep~~ |
| [#885](https://github.com/Jason-Vaughan/TangleClaw/issues/885) | enhancement | ✅ closed | ~~The dashboard shows a short project list with no sign that a scan is failing~~ |

### Deliberately held open

**[#1](https://github.com/Jason-Vaughan/TangleClaw/issues/1) — Add user authentication**

Do not close until v5 RELEASES. #710 + ADR 0009 deliver the gate but it is unreleased; a fresh install today is still loopback-only. Its third bullet (per-user access) is not planned — ADR 0009 ratifies a single shared credential.

### Not tracked as issues

- Backlog reconciliation — 4 graduations, 5 links, 25 stay put. Must run from the TangleClaw checkout (/prawduct:backlog resolves against its own repo).
- Backlog refs to add from the checkout: AUTH-4B7K + AUTH-6D9P → refs #800; MED-8H5W → refs #801.
- #781 patch staged at Shared/TangleClaw-Shared/exchange/PATCH-legacy-hook-cleanup-gate.md
- Prawduct-side critic wrong-tree fix: filed upstream as brookstalley/prawduct#147; TangleClaw backstop is #798.

---

## How this stays current

The board is **generated, not hand-edited**. Live state comes from `gh` at build time; the editorial layer (cluster membership, sequencing, verification status) lives in `board-data.json`. Edit that file to reshape the board.

A published Artifact cannot poll GitHub — the CSP blocks external hosts, and no GitHub connector is available — so "current" means someone re-ran the generator and republished. `build-board.py --check` exits **3** when the board no longer matches GitHub, which is what lets a wrap step notice drift and republish rather than relying on anyone remembering.

Generator and data live in `Shared/TangleClaw-Shared/roadmap-board/` — the shared group directory, so either session can regenerate without writing into the other's repo.
