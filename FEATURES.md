# Feature Index

<!--
Maintained automatically: the wrap-step handler appends
stubs when PRs touch new files. Fill in descriptions before
next wrap.

Format: - **Name** — short description. `file.js` plus stable anchors:
`file.js#symbolName` for a function/const, or the literal route string
("POST /api/foo") for server.js routes. NO :line pointers — nothing
re-verifies them, so they rot (DOC-3K7Q found drift of 300+ lines).
Sub-pointer prefixes ("Backend:", "Handler:", "Core:") are allowed for
entries that span multiple co-equal locations.

Auto-stub TODO sections appended at wrap are working state, not backlog:
fold them into the sections above promptly — test/features-index.test.js
fails any auto-stub section older than 14 days.
-->

## UI / Web

- **Landing + session shells** — `public/index.html` is the single HTML host; it loads `/landing.js` (project list, port stats, system stats) and `/session.js` (per-project app shell) via the same document. The standalone per-session page is `public/session.html` + `public/session.css` (banner, terminal, Medusa control, drawers). `public/index.html`, `public/landing.js`, `public/session.js`, `public/session.html`, `public/session.css`. Operator guide: `docs/user-guide.md`.
- **First-run setup wizard** — guided initial configuration frontend (admin credential step landed with AUTH-2). `public/setup.js`.
- **Service worker + update propagation** (#246/#258/#380) — `public/sw.js` is cache-first for static assets, network-first for API/navigation/cache-bust-critical scripts; `public/sw-register.js` registers it and forces fresh-worker pickup on iOS (poll `reg.update()` on load + tab-visibility, guarded `controllerchange`→reload). `public/sw.js`, `public/sw-register.js` (loaded by `public/index.html`).
- **Settings modal** — per-project config editor (engine, methodology, silentPrime, featureIndexEnabled, rules, launch-mode defaults). `public/ui.js#openSettings`; launch-mode section `public/ui.js#renderLaunchModeSettings` (with the bypass-hidden eyes-open confirm).
- **Silent-prime toggle** — engine-gated capability toggle. `public/ui.js#renderSilentPrimeToggle`.
- **Feature Index toggle** (#207) — opt-in flag that seeds `FEATURES.md` on first enable. `public/ui.js#renderFeatureIndexToggle`.
- **Banner group pills** — group membership chips on the session banner. `public/session.js#renderBannerGroups`, `#toggleGroupPopover`.
- **Methodology action buttons** — `actions[]` from `template.json` (e.g. "Mark Critic Run", renamed in #230). `public/session.js#renderMethodologyActions`, `#invokeMethodologyAction` (per-action wording fields `confirmMessage`, `successToast` with `{branchName}` placeholder). Handler: `lib/actions/invoke-critic.js`. Toast: `public/session.js#showMethodologyActionToast`.
- **Stale-server banner** (#199) — runtime-vs-disk SHA delta; carries a *Restart TangleClaw* button (#235) when the server reports a non-null `restartMechanism`. `public/landing.js#renderStaleServerBanner`, `public/index.html`. Backend: `lib/server-info.js`.
- **Restart TangleClaw button** (#235) — banner + Global Settings → Diagnostics surfaces; one-click restart via the platform process manager (macOS launchd today; Linux is a follow-up). Handler: `public/landing.js#triggerServerRestart`. Endpoint: `POST /api/server/restart`. Modal section: `public/ui.js#openGlobalSettings`.
- **Orphan-hooks repair banner** (#145) — scans projects for hook config drift. `public/landing.js#renderOrphanHooksBanner`, `#repairAllOrphanHooks`; markup in `public/index.html`.
- **Update-available pill** — GitHub release check with localStorage dismiss-per-version. `public/landing.js#loadUpdateStatus`.
- **Session Wrap drawer** — step-by-step wrap status, BLOCKED/SKIPPED/DONE rendering. Sticky blocked-report: stays open until dismissed (suppresses the session-ended auto-redirect, #268), with a "Copy report" button (`buildReportText`). Status badges carry `title` tooltips (#222, `STATUS_META`); blocked steps show a collapsible "How to fix this" remediation from the handler's `output.remediation` (#223). `public/wrap-drawer.js`, `public/session.js#openWrapDrawer`/`#renderStepRow`. Handler remediation lives in each `lib/wrap-steps/*.js` blocked return.
- **OpenClaw view** — remote-engine project cache + view. `public/openclaw-view.js`, `public/openclaw-view.html`, `public/openclaw-cache.js`. Operator setup guide: `docs/openclaw-setup.md`.
- **Project Master pane** (chunk G slice 2, #331) — landing-header 🧠 Master button + collapsible panel embedding the ttyd terminal iframe onto the reserved `tangleclaw-master` tmux session; ensure-then-attach (`POST /api/master/ensure` before iframe src), status dot from `GET /api/master/status` (one-shot, no polling), #431 ⌥+drag copy + touch-scroll parity. `public/ui.js#toggleMaster`/`#ensureMasterAttached`/`#attachMasterFrame`, `public/index.html` (`#masterPanel`), `public/style.css` (`.master-panel`). Backend: `lib/master.js` (slice 1).
- **Master settings surface** (V1 Sunset Phase A, spec ratified 2026-07-18) — gear in the Master pane → modal: access level (`read-only` enforced; `suggest`/`write` disabled until real enforcement ships), engine, group scope, auto-start (`master` object in global config via `PATCH /api/config`); editable Hard-rules block as `kind='master'` session rules with version history/rollback + `POST /api/master/rules/restore-defaults`; structural write guard (`.claude/settings.json` + PreToolUse hook denying writes outside `memory/`) regenerated per ensure; master memory scaffold (`~/.tangleclaw/master/memory/`: TC-refreshed `FLEET.md`/`HOWTO.md`, master-owned `MEMORY.md`/`CHANGELOG.md`/`NOTES.md`). `lib/master.js`, `public/ui.js#openMasterSettings`, `server.js#validateMasterPatch`. Tests: `test/master.test.js`, `test/master-settings-frontend.test.js`.
- **Terminal copy & touch gestures** (#431/#443/#445) — plain drag copies terminal text to the REMOTE client's clipboard (capture-phase modifier rewrite into xterm's force-selection); one-finger touch drag scrolls (synthetic wheel via tmux copy-mode); long-press+drag selects on touch with a native-style Copy pill; Option/Shift+drag and right-click untouched. All shared in `public/api-helper.js` (`tcWireTerminalDragCopy`, `tcWireTerminalTouchScroll`, `tcCopyToClipboard`), wired from `public/session.js#setupTerminal` + `public/ui.js#attachMasterFrame`.

## Server / API

- **HTTP entrypoint + route table** — `server.js` (single-file router; `route(method, path, handler)` registrations throughout). API families summarized below; find any route by grepping its literal route string in `server.js`.
- **Projects family** — `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:name`, `POST .../archive`, `POST .../unarchive`, `POST /api/projects/attach`, `POST /api/projects/import`, orphan-hooks scan/repair routes. Enrichment: `lib/projects.js#enrichProject`. Updates: `lib/projects.js#updateProject`.
- **Methodology-action invocation** — `POST /api/projects/:name/actions/:command`. Dispatcher: `lib/actions.js#runAction`.
- **Methodologies registry** — `GET /api/methodologies`, `GET /api/methodologies/:id`. Backend: `lib/methodologies.js#initialize`, `#listTemplates`.
- **Sessions family** — `POST /api/sessions/:project` (launch), `DELETE` (kill), `GET .../status`, `POST .../command`, `POST .../wrap`, `POST .../wrap/complete`, `GET .../wrap/status` (#583 reattach), `GET .../peek`, `GET .../history`. Core: `lib/sessions.js#launchSession`, `#generatePrimePrompt`.
- **Wrap pipeline runner** — `lib/wrap-pipeline.js#runWrapPipeline`; single-flight per project via `lib/wrap-run-registry.js` (#583).
- **Continuity store** (Continuity Contract, `.claude/plans/archive/continuity-contract.md`) — per-project gitignored store at `<project>/.tangleclaw/continuity/`. **Hot tier (CC-1):** curated `index.md` rewritten each wrap, read back by `generatePrimePrompt` for the "we left off at X — continue?" resume. **Warm tier (CC-2):** append-only `changelog.md` (one entry per session) + per-session `wraps/<sid>.md` 8-section summary + `search(projectPath, query, {section})` grep-over-markdown retrieval carrying the `session:<sid>` pointer. **Map (CC-3):** the index's `## Map` feature/component section, self-maintained at wrap (`updateMap` stubs touched files, prunes deleted; preserved verbatim across the rewrite) — internal hot-tier sibling of this `FEATURES.md`. **Cold tier (CC-4 / CC-4b):** uploads relocate to `sessions/<sid>/uploads/` (CC-4) and the raw session transcript snapshots to `sessions/<sid>/transcript.jsonl` + `transcript.meta.json` at wrap (CC-4b, `lib/transcript.js`). The transcript is resolved at wrap with **no hook** — a harness-adapter registry keyed by engine (`claude` implemented via a `~/.claude/projects` cwd-content match; `gemini`/`codex`/`aider`/`openclaw` are forward-compat stubs) — and scanned by `lib/secret-scan.js` (flag-only, types not values). **Operator search (CC-5, #344):** the **Session History & Search** drawer (&#128269; button on each project card → `public/history-drawer.js` + `#historyModal`). Warm global search (`searchSessions()` — filters: date range / `tags` / `type` / file-touched / `refs`; recency+match-count ranking; browse mode on empty query) → cold drill-down (`searchTranscript()` over `transcript.jsonl`, surfacing the `secretsFlagged` warning). A **Summaries / Full-transcripts** toggle switches the global box to `searchProjectTranscripts()` (`?scope=transcripts`) — greps every captured transcript in the project at once (direct transcript search, same filters, results highlighted via `<mark>`). `listSessions()` merges wrap + changelog + transcript meta per session. New schema fields feed the filters: `type:`/`[type]` from the branch prefix, `files:` from the wrap step's touched list (both forward-only; `meta.unindexed` labels the gap). Routes: `GET /api/continuity/:project/{search,sessions,sessions/:sid,sessions/:sid/transcript/search}`. All render/parse pure in `lib/continuity.js`; written by the `continuity-write` wrap step (`lib/wrap-steps/continuity-write.js`, runs after `commit`, `blocker:false`; the transcript snapshot is isolated so a copy failure never affects the warm tier). **Wrap-section depth (CC-6, #386):** the rendered section set resolves per-project `project.wrapSections` (operator override) → all 8 (deep fallback); `Next action` is always forced in by `effectiveWrapSections`. A methodology-level `wrap_contract.sections` default (CC-8) sat between the two until #570 removed it — it was validated and honored but declared by no template.
- **Server-info endpoint** (#199, #235) — `GET /api/server-info` (includes `restartMechanism`). Backend: `lib/server-info.js`.
- **Server-restart endpoint** (#235) — `POST /api/server/restart`. 202 Accepted before exec; 501 when no mechanism; 409 `WRAP_RESTART_BLOCKED` while a wrap runs (#583). Backend: `lib/server-info.js#detectRestartMechanism`, `#buildRestartCommand`.
- **Auth: Caddy ingress + proxy identity** (AUTH-1/AUTH-3) — `lib/caddy.js` generates the integrity-stamped Caddyfile for the auth-gated ingress; `lib/auth-identity.js` resolves proxy-authenticated request identity (`X-Auth-User` → `currentUser` on `/api/server-info`). Drift surfacing: `docs/auth-status-surfacing.md` (AUTH-2K9D).
- **PortHub leasing** — `GET /api/ports`, `POST /api/ports/lease`, `POST /api/ports/release`, `POST /api/ports/heartbeat`, `POST /api/ports/sync`. Backend: `lib/porthub.js`. Injected operator guide: `data/porthub-guide.md`.
- **PortHub next-free-port auto-allocation** (#352) — `porthub.nextFreePort({ range, host })` returns the first free port in a range (not lease-held, not OS-bound). The OpenClaw connection-create route auto-allocates `local_port` (and opt-in `bridge_port` via `bridgePort:"auto"`) when omitted and leases it at create-time under `oc-direct-<id>`. Backend: `lib/porthub.js#nextFreePort`, `server.js` `POST /api/openclaw/connections`.
- **Groups family** — `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/:id`, `POST /api/groups/:id/sync`, member CRUD under `/api/groups/:id/members`.
- **Shared-docs family** — `GET/POST /api/shared-docs`, `GET/PUT/DELETE /api/shared-docs/:id`, lock CRUD under `/api/shared-docs/:id/lock`. Injected operator guide: `data/shared-docs-guide.md`.
- **OpenClaw connections family** — `GET/POST /api/openclaw/connections`, `GET/PUT/DELETE /api/openclaw/connections/:id`, `POST /api/openclaw/test`, tunnel CRUD, approve-pending.
- **Medusa switchboard** (MED-2K9P) — inter-session agent messaging. `lib/medusa.js` (service layer: listener lifecycle, send, roster, session-end teardown), `lib/medusa-listener.js` (per-session Bridge WebSocket listener + state machine), `lib/medusa-registry.js` (session→workspace-id mint/persist/forget), `lib/medusa-wake.js` (v2 T2: boot-time idle-gated wake monitor — nudges an opted-in `medusaWake` session's pane about fresh mail only when provably idle: busy-marker absent + bare-`❯` prompt + 2-tick debounce). Routes under `/medusa/*` (status/toggle/messages/read/send/roster).
- **Session rules + self-improvement loop** (#347) — per-project session rules store (`store.sessionRules`; startup rules render into the session prime via `lib/sessions.js#buildStartupRulesSection`, wrap rules inject into the wrap prompt via `lib/wrap-steps/ai-content.js#_appendWrapRules`), the Project Rules section of the Settings modal, and the wrap-time self-improvement loop. The standalone global-tier panel was retired. Docs: `docs/session-rules-self-improvement.md`.
- **Session-rule delivery ledger** (#595) — every launch records whether the startup-rule block actually reached the engine, on which channel, and why not when it did not (`store.sessionRuleDeliveries`, `session_rule_deliveries` table, `GET /api/session-rules/deliveries`). Exists because startup rules were structurally undeliverable on all 13 plugin-governed projects with nothing recording the miss. Tests: `test/session-rule-delivery.test.js`.
- **Eval Audit ingest** — `POST /api/audit/ingest`, `POST /api/audit/heartbeat`. Backend: `lib/eval-audit.js#runTier1`, `#watchSession`.
- **Activity feed** — `GET /api/activity`.
- **Uploads** — per-project file uploader (modal in `public/session.js`/`session.html`). **Any file type** (#338, no extension allowlist); referenced by local path; filename sanitized (no traversal). **Session-linked store (CC-4):** an active-session upload lands under `<project>/.tangleclaw/continuity/sessions/<sid>/uploads/` (the legacy flat `<project>/.uploads/` is now only the no-active-session fallback); `listUploads` merges both, tagging each entry's `session` (or `null` for legacy). Recent-uploads history items are **click-to-copy-path** (#338). `POST /api/upload`, `GET /api/uploads`. Backend: `lib/uploads.js`.
- **Secret badge** (#343, CC-4) — flag-only secret detection on text uploads (`lib/secret-scan.js`: AWS/Slack/GitHub/Google keys, PEM private keys, generic long-value secret assignments). A hit is recorded in a per-uploads-dir `_scan.json` sidecar (**pattern types only, never the value**) and surfaced as an amber `.badge-secret` in the upload history. **Never scrubs or blocks** — the operator remediates manually. (Transcript-snapshot scan deferred → CC-4b/#376.)
- **Tmux mouse mode** — `GET /api/tmux/mouse/:session`.
- **Sidecar processes** — `GET /api/sidecar/:project/processes`, `GET /api/sidecar/connection/:connId/processes`. Backend: `lib/sidecar.js`.
- **Skills / wrap-shape registry** — `lib/skills.js#getWrapSkill`.
- **Project store / DB** — SQLite-backed project records, project-config persistence. `lib/store.js` (`DEFAULT_PROJECT_CONFIG`, `store.projects.*`).
- **Engine profiles + config generation** — detect installed engines, generate per-engine config files (`CLAUDE.md`, `.antigravity.md`, `.aider.conf.yml`, etc.). `lib/engines.js#detect`, `#generateConfig`, `#_buildBaselineHooks`. Injected shared docs: `data/global-rules.md` (Global Rules shared across TC-managed projects), `data/session-memory-guide.md` (file-based session memory system).
- **Prawduct V2 plugin-governed deferral** (#330) — when a project carries the V2 plugin install reference (`enabledPlugins["prawduct@*"]` in `.claude/settings.json`), TC stops generating its governance config: `writeEngineConfig` skips `CLAUDE.md` regeneration and `syncEngineHooks` strips its own `.hooks` block (preserving the install reference). Auto-detected, fail-closed. `lib/engines.js#isPluginGoverned`.
- **Orchestration launch-binder** (TB-1, #357) — bind a project to an orchestration profile so its engine launches against a different OpenAI-compatible endpoint (LiteLLM `direct` etc.) **per project**, no engine-config edit. Profiles live in operator-owned `~/.tangleclaw/orchestration-profiles.json` (seeded from `data/orchestration-profiles.json`; loader `store.orchestrationProfiles.load`); the binding is the nullable `projects.orchestration_profile` column (schema v22). Pure resolvers in `lib/orchestration.js` (`resolveKeyRef`, `resolveLaunchProfile`, `applyLaunchOverlay`); injected at one seam in `lib/sessions.js#launchSession` (overlay onto `launch.args` `--model` + `launch.env` `OPENAI_API_BASE`/`OPENAI_API_KEY`). `NULL` binding = zero injection (byte-identical to pre-TB-1). Optional per-project key override `projConfig.orchestrationKeyRef`. Spec: `.prawduct/artifacts/tb-1-launch-binder.md`.

## Methodologies / Engines

- **Methodology registry** — loads `data/templates/<id>/template.json` + optional `playbook.md`. `lib/methodologies.js#initialize`. Authoring guide: `docs/methodology-guide.md` (template.json fields).
- **Prawduct template** — methodology shipped in repo. `data/templates/prawduct/template.json`, `data/templates/prawduct/playbook.md`.
- **Minimal template** — bare-bones methodology (wrap pipeline only, no playbook). `data/templates/minimal/template.json`.
- **Retired templates tombstone** — `RETIRED_TEMPLATE_IDS` in `lib/store.js#_copyBundledTemplates` deletes runtime copies of retired bundled methodology templates on every boot (mirrors `RETIRED_ENGINE_IDS`). Currently: `tilt` (identity-first methodology, retired 2026-07-17 — no distinct value over minimal).
- **Engine profiles** — claude, codex, antigravity, aider, openclaw (openclaw is `pickerHidden: true` — resolvable for launch plumbing but excluded from the project engine picker, #459). `data/engines/<id>.json`. Capability gates (`supportsSilentPrime`, `supportsPrimePrompt`, etc.) consumed throughout `lib/sessions.js`, `lib/engines.js`. **Canonical-source sync** (#251): on every `store.init()`, bundled `data/engines/*.json` is reconciled into `~/.tangleclaw/engines/`; drift triggers a `log.warn` then overwrite. Operator-added profiles with no bundled counterpart are preserved — EXCEPT retired ids (`RETIRED_ENGINE_IDS`: gemini #457, genesis #458), which are tombstoned (user-local copy deleted on boot). Helper: `lib/store.js#_syncBundledEngines`.
- **SessionStart hook (Claude Code)** — shell script Claude Code runs on session start; reads `<project>/.tangleclaw/session-prime.md` and emits it as the prime context. `data/hooks/sessionstart-prime.sh`. Hook plumbing: `lib/engines.js#_buildBaselineHooks`.
- **AI co-author strip commit-msg hook** (#247) — POSIX-sh `commit-msg` git hook installed into every TC-managed project's `.git/hooks/`; strips `Co-Authored-By:` trailers naming AI coding assistants (Claude/GPT/Gemini/Copilot/Aider/Cursor) before commits land. Forward-only. Toggle via `globalSettings.stripAiCoauthors` (default ON). Script: `data/hooks/strip-ai-coauthors.sh`. Install/uninstall: `lib/git-hooks.js#syncGitHooks`. Lifecycle wiring: `lib/projects.js#createProject`, `#attachProject`, `#syncAllProjects`. PATCH-time re-sync in `server.js` `/api/config`. UI: `public/ui.js#openGlobalSettings` → *Commit hygiene*.
- **AI co-author strip — global git template** (#252) — companion to the per-project installer above. Installs the same hook into `~/.tangleclaw/git-template/hooks/commit-msg` and points `git config --global init.templateDir` at it, so every `git init` / `git clone` on the host (even outside TC's view) inherits the hook. Three-case `init.templateDir` detection (unset → claim; ours → no-op; non-TC → warn, don't clobber). Drift-aware revert via sentinel `~/.tangleclaw/git-template/.tc-init-templatedir-owned`. Backend: `lib/git-template.js#syncGlobalTemplate`. Wiring: `lib/projects.js#syncAllProjects` (startup) + `server.js` `/api/config` toggle handler. Limitation: only fires for FUTURE repos; existing on-disk repos require the per-project installer above (or a future bulk-sweep follow-up).
- **ClawBridge session pre-create with permissionMode** (#210) — when an OpenClaw connection has a `bridgePort` AND the operator picks a launch mode, TC pre-POSTs `/v2/session/start` to ClawBridge through the SSH tunnel before returning the iframe URL, so the chosen `permissionMode` propagates to the spawned claude process. Bridge contract: ClawBridge v1.6.0 (`permissionMode` field) + v1.7.0 (`attachIfExists` for idempotent attach). Client: `lib/clawbridge.js#startSession`. Wiring: `lib/sessions.js#launchWebuiSession`. Mode mapping: `data/engines/openclaw.json#launchModes` — six modes (`default`, `acceptEdits`, `bypassPermissions`, `auto`, `plan`, `dontAsk`) each with `bridgePermissionMode`. Picker gate honors per-mode `disabled` flag at `public/landing.js`.
- **Wrap pipeline runner** — orchestrates the wrap step sequence declared in `template.json#wrap_pipeline.steps[]`. `lib/wrap-pipeline.js#runWrapPipeline`.
- **Wrap step: `version-bump`** — semver bump on `[Unreleased]` promotion; also flips this repo's prawduct change-log `status=merged` tags to `shipped` at release-promote (WRP-9F2K). `lib/wrap-steps/version-bump.js`.
- **Wrap step: `commit`** — flushes staged writes, makes the wrap commit. Auto-branches to `wrap/<YYYYMMDDHHmmss>-<slug>` when wrap fires on `main`/`master` (#264); `options.allowDirectToMain` bypasses for trivial doc edits / hot-fixes. `lib/wrap-steps/commit.js`.
- **Wrap step: `features-toc`** (#207 Chunk 3) — append-stub for files touched in PR not yet in FEATURES.md. `lib/wrap-steps/features-toc.js`.
- **Wrap step: `project-map`** (PIDX slice 3, #360/#356) — keeps `PROJECT-MAP.md` fresh on wrap: refreshes the `## Structure` dir skeleton + `## Shared directories` membership against the live filesystem + store, preserving curated descriptions + operator sections; idempotent (skips on no drift). Refresh helpers `_refreshProjectMapContent`/`_mergeStructureBody` in `lib/projects.js`; ADR 0007. `lib/wrap-steps/project-map.js`.
- **Wrap step: `priming-roll`** — roll the next-session priming pointer. Resolves the build plan by precedence: `step.planPath` → `activePlan` in `.tangleclaw/project.json` → the single in-progress plan among many → skip if all complete (#226). `lib/wrap-steps/priming-roll.js`.
- **Wrap step: `pr-check`** — surfaces open PRs and gates the wrap on them: a session-scoped open PR with no `merge`/`defer`/`ignore` resolution blocks the wrap. Read-only; degraded probes (no `gh`, no auth) skip without blocking. `lib/wrap-steps/pr-check.js`.
- **Wrap step: `pr-merge`** — applies the gate's resolutions after the wrap commit: pushes the branch so the PR contains that commit, then enqueues GitHub auto-merge (`gh pr merge --auto --squash --delete-branch`) per `merge`. Never blocks; a failed push or enqueue surfaces as a warning with remediation and nothing is enqueued. `lib/wrap-steps/pr-merge.js`.
- **Wrap step: `ai-content`** — prompts injected into the AI session for changelog / learnings / memory updates. `lib/wrap-steps/ai-content.js`.
- **Wrap step: `test`** / **`lint`** — test + lint hooks. `lib/wrap-steps/test.js`, `lib/wrap-steps/lint.js`.
- **Mark Critic Run action handler** — appends entry to `.tangleclaw/critic-runs.json`; **does not run a Critic** (the review is out-of-band). `lib/actions/invoke-critic.js`. UX clarification (label + confirm + toast) landed in #230.
- **Project version reader** — surfaces the project's version to the UI, resolved in order: `CHANGELOG.md`, a configured `versionFilePath`, `version.json`, `package.json`, git tag, then a `0.0.0-dev` fallback. Degrades with a warning rather than refusing. `lib/project-version.js`.
- **Model status monitor** — polls engine providers (Atlassian / Google status pages) for outage detection. `lib/model-status.js#_pollEngine`, `#startMonitor`.

## CLI / Tooling

- **Git helpers** — repo detection, branch/dirty/tag/commit-age info, commits, internal cache. `lib/git.js#isGitRepo`, `#getInfo`, `#commit`.
- **Tmux helpers** — session create/kill/list, send-keys, capture-pane, mouse mode. `lib/tmux.js#createSession`, `#sendKeys`, `#capturePane`, `#setMouse`.
- **TTYD watcher** — keeps the shared ttyd alive; recycles it via `launchctl kickstart` on two independent leak gates: PTY-pool ratio ≥ 0.85 (#94/#144) and leaked-child count ≥ 20 (ttyd children wedged in `E`/`Z` state, #380). `lib/ttyd-watcher.js`.
- **TTYD attach-script resolver** — resolves the canonical `~/.tangleclaw` ttyd attach-script install location (TCC-safe — see #500). `lib/ttyd-attach.js`.
- **Path-token matcher** (CON-8H3Z) — shared path-like-token regex used by both this index's drift scan and the continuity Map, so their extension allowlists can't drift. `lib/path-tokens.js`.
- **Tunnel** — Cloudflare tunnel lifecycle for remote access. `lib/tunnel.js`.
- **Sidecar** — supplementary process supervisor. `lib/sidecar.js`.
- **HTTPS setup** — mkcert-backed cert discovery + HTTPS listener. `lib/https-setup.js`.
- **Update checker** — GitHub release-tag polling. `lib/update-checker.js`.
- **Self-update action** (#228/#229, UB) — the update pill's **Update & restart** button: `POST /api/update/apply` fetches + checks out the latest release tag with fail-closed guards (dirty-tree / no-update / wrong-ref / no-git → 409; git-error → 500; argv-form git so a tag can't shell-inject), then the client chains the existing #235 restart and polls `/api/server-info`. Does NOT restart itself; logs `fromSha` for one-line manual rollback. `lib/update-applier.js`, route `server.js` (next to `/api/update-status`), UI `public/landing.js#applyUpdateAndRestart` + `#loadUpdateStatus`, button `.update-pill-apply` (`public/style.css`).
- **Uploads** — file-upload handling for the in-browser drop zone. `lib/uploads.js`.
- **System stats** — CPU / mem / disk for the landing page. `lib/system.js`.
- **Port scanner** — local-port introspection for the PortHub UI. `lib/port-scanner.js`.
- **PID file** — single-instance guard. `lib/pidfile.js`.
- **Installer** — bootstrap script for fresh hosts. `deploy/install.sh`.
- **Detached ttyd attach** — helper for reconnecting to the shared ttyd. `deploy/ttyd-attach.sh`.
- **Ingress cutover** — renders launchd plist templates and cuts the server over to Caddy ingress (AUTH-1; guarded post-#463 — refuses to un-gate a hand-edited live Caddyfile). `scripts/ingress-cutover.js`.
- **CI** (CI-9F3T) — GitHub Actions `Tests` workflow runs the full suite on PRs + push-to-main; the `test` check is required on `main` (CI-2V8Q). `.github/workflows/test.yml`, pinned by `test/ci-workflow.test.js`.

## Tests

Suite: `node --test 'test/*.test.js'` (~4300 tests, CI-gated). Most test files pair 1:1 with the module they cover (lib/NAME.js → test/NAME.test.js); the map below covers files whose subject isn't obvious from the name.

- `test/features-index.test.js` — this file's own citation contract (no `:line` pointers, no dangling paths/anchors, stub sections fold within 14 days).
- `test/api-sessions.test.js` — the `/api/sessions/*` route family; `test/api-system.test.js` — system/config/restart routes; `test/api-wrap-status.test.js` — `GET .../wrap/status` reattach + `WRAP_RESTART_BLOCKED` restart guard (#583).
- `test/wrap-run-registry.test.js` — wrap-run registry lifecycle/stale-takeover/isolation (#583); `test/wrap-run-reattach.test.js` — session-page wrap-reattach wiring pins (#583).
- `test/paste-affordance.test.js` — iOS touch Paste button + `tcPastePath` matrix (#402, UI-2P7T); `test/terminal-drag-copy.test.js` — #431 remote drag-copy wiring; `test/select-mode-mouse.test.js` — select-mode mouse handling in the terminal; `test/git.test.js` — `lib/git.js` helpers incl. `latestTag`.
- `test/api-openclaw.test.js` — the `/api/openclaw/connections` route family (CRUD + test/approve).
- `test/openclaw-setup-readme.test.js` — OpenClaw connection Read-Me / AI-setup-prompt UI, including the `tcCopyToClipboard` copy path.
- `test/openclaw-bridge-port-row.test.js` — conditional Bridge Port row on the OpenClaw card (#491); owns the exact CACHE_NAME pin.
- `test/bridge-port-input.test.js` — `tcParseBridgePort` Bridge-port field parsing (#489).
- `test/terminal-selection-fix.test.js` — #431 ⌥+drag local-selection override (`macOptionClickForcesSelection` flip + mouseup-gesture copy) in `public/session.js`.
- `test/upload-modal-frontend.test.js` — upload modal's post-upload "Tell your AI assistant: <path>" copy affordance.
- `test/master-drawer-frontend.test.js` — in-session Project Master drawer frontend (#331); `test/master.test.js` — `buildMasterClaudeMd` (Project Master session config).
- `test/auth-credential-durability.test.js` — auth credential durability / lockout regressions (#397); `test/auth2-wizard-admin.test.js` — AUTH-2 setup-wizard admin step (frontend); `test/api-auth-identity.test.js` + `test/auth-identity.test.js` — proxy identity (AUTH-3); `test/auth-status-warning.test.js` — dashboard auth-status drift warning (AUTH-2K9D).
- `test/ingress-cutover.test.js` — ingress-cutover plist/Caddy logic; `test/ttyd-attach-sync.test.js` — `lib/ttyd-attach.js` install-location sync; `test/ttyd-plist.test.js` — the `com.tangleclaw.ttyd.plist` launchd definition.
- `test/sessions.test.js` — core session lifecycle (launch/wrap/kill); `test/sessions-webui.test.js` — Web UI (OpenClaw) session lifecycle; `test/session-wrapper.test.js` — session-wrapper UI shell.
- `test/store.test.js` — core SQLite store / project records; `test/store-openclaw.test.js` — `store.openclawConnections`; `test/store-portleases.test.js` — `store.portLeases` (PortHub); `test/store-session-mode.test.js` — schema v6 `session_mode` column; `test/orchestration-profiles-store.test.js` — orchestration-profiles seed/store (TB-1/#357).
- `test/session-rules.test.js` — `sessionRules` store API (#347); `test/session-rules-panel.test.js` — global-panel retirement pins; `test/api-session-rules-selfimprove.test.js` — session-rules self-improvement API; `test/launch-mode-settings.test.js` — per-project launch-mode settings (validation, guard, launch resolution, UI pins).
- `test/wrap-pipeline.test.js` — server-side wrap pipeline runner (#139); `test/wrap-drawer.test.js` — wrap-drawer `buildStepRow` helpers; `test/wrap-step-priming-roll.test.js` — priming-roll wrap step helpers; `test/landing-wrap-single-flight.test.js` — single-flight dashboard wrap trigger (UI-3B8N); `test/wrap-drawer-select-a11y.test.js` — a11y labels on wrap-drawer decision selects (UI-7H4K).
- `test/api-medusa.test.js` — Medusa service + `/medusa/*` routes; `test/medusa-listener.test.js` — MedusaListener WS client (reconnect, de-dup, socket-identity guard); `test/medusa-wake.test.js` — wake monitor (pane idle-policy pinned byte-for-byte against live spike captures, debounce/watermark/burst/retry, per-gate blocking); `test/medusa-control.test.js` — banner Medusa control frontend.
- `test/settings-modal-silentprime.test.js` — Project Settings modal silentPrime toggle (#103); `test/projects.test.js` — projects store/enrichment + preferences (incl. `medusaEnabled`); `test/engines.test.js` — engine detection + per-engine config generation; `test/https-setup.test.js` — HTTPS/mkcert setup helpers; `test/server.test.js` — HTTP server / route table; `test/api-globalrules.test.js` — the `/api/rules/global` route; `test/prawduct-playbook-gating.test.js` — engine/rule gating of the V1 prawduct playbook (#536).

## TODO (auto-stubbed 2026-07-18)

- **TBD** — touched in this session: `docs/adr/0002-wrap-pipeline-contract.md`. <!-- describe -->
- **TBD** — touched in this session: `docs/adr/0008-project-master-session-model.md`. <!-- describe -->
- **TBD** — touched in this session: `docs/eval-audit-mode.md`. <!-- describe -->
- **TBD** — touched in this session: `test/api-config.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/api-methodologies.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/api-session-rules.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/methodologies.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/migration.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/project-rules-modal.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/project-version-require-cycle.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/session-rules-selfimprove.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/skills.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/store-projects.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/stranded-configs.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/wrap-step-ai-content.test.js`. <!-- describe -->

## TODO (auto-stubbed 2026-07-18)

- **TBD** — touched in this session: `deploy/cleanroom/bake.sh`. <!-- describe -->
- **TBD** — touched in this session: `deploy/cleanroom/compose.yaml`. <!-- describe -->
- **TBD** — touched in this session: `deploy/cleanroom/provision.sh`. <!-- describe -->
- **TBD** — touched in this session: `test/cleanroom-compose.test.js`. <!-- describe -->

## TODO (auto-stubbed 2026-07-18)

- **TBD** — touched in this session: `test/create-project-modal.test.js`. <!-- describe -->

## TODO (auto-stubbed 2026-07-18)

- **TBD** — touched in this session: `test/prawduct-aicontent-prompts.test.js`. <!-- describe -->
- **TBD** — touched in this session: `test/wrap-engine-agnostic.test.js`. <!-- describe -->
