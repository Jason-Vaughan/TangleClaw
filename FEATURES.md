# Feature Index

<!--
Maintained automatically: the wrap-step handler appends
stubs when PRs touch new files. Fill in descriptions before
next wrap.

Format: - **Name** — short description. file.js:line[, file2.js:line, ...].
Sub-pointer prefixes ("Backend:", "Handler:", "Core:") are allowed for
entries that span multiple co-equal locations.
-->

## UI / Web

- **Landing + session shells** — `public/index.html` is the single HTML host; it loads `/landing.js` (project list, port stats, system stats) and `/session.js` (per-project app shell) via the same document. `public/index.html`, `public/landing.js`, `public/session.js`.
- **Settings modal** — per-project config editor (engine, methodology, silentPrime, featureIndexEnabled, rules). `public/ui.js:697`.
- **Silent-prime toggle** — engine-gated capability toggle. `public/ui.js:779`.
- **Feature Index toggle** (#207) — opt-in flag that seeds `FEATURES.md` on first enable. `public/ui.js:808`.
- **Banner group pills** — group membership chips on the session banner. `public/session.js:302`.
- **Methodology action buttons** — `actions[]` from `template.json` (e.g. "Mark Critic Run", renamed in #230). `public/session.js:212`. Optional per-action wording fields (`confirmMessage`, `successToast` with `{branchName}` placeholder) at `public/session.js:235`. Handler: `lib/actions/invoke-critic.js`. Toast: `public/session.js:281`.
- **Stale-server banner** (#199) — runtime-vs-disk SHA delta; carries a *Restart TangleClaw* button (#235) when the server reports a non-null `restartMechanism`. `public/landing.js:131`, `public/index.html:287`. Backend: `lib/server-info.js`.
- **Restart TangleClaw button** (#235) — banner + Global Settings → Diagnostics surfaces; one-click restart via the platform process manager (macOS launchd today; Linux is a follow-up). Handler: `public/landing.js#triggerServerRestart`. Endpoint: `POST /api/server/restart`. Modal section: `public/ui.js#openGlobalSettings`.
- **Orphan-hooks repair banner** (#145) — scans projects for hook config drift. Section banner: `public/landing.js:364`. HTML: `public/index.html:290`.
- **Update-available pill** — GitHub release check with localStorage dismiss-per-version. `public/landing.js:160`.
- **Session Wrap drawer** — step-by-step wrap status, BLOCKED/SKIPPED/DONE rendering. Sticky blocked-report: stays open until dismissed (suppresses the session-ended auto-redirect, #268), with a "Copy report" button (`buildReportText`). `public/wrap-drawer.js`, `public/session.js:openWrapDrawer`.
- **OpenClaw view** — remote-engine project cache + view. `public/openclaw-view.js`, `public/openclaw-cache.js`.

## Server / API

- **HTTP entrypoint + route table** — `server.js` (single-file router; `route(method, path, handler)` registrations throughout). API families summarized below; line numbers point at the first route in each family.
- **Projects family** — `GET /api/projects` `server.js:855`, `POST /api/projects` `:932`, `GET /api/projects/:name` `:923`, `PATCH` `:1079`, `DELETE` `:1031`, `POST .../archive` `:1057`, `POST .../unarchive` `:1068`, `POST /api/projects/attach` `:869`, `POST /api/projects/import` `:962`, orphan-hooks scan `:902` / repair `:910`. Enrichment: `lib/projects.js:559` (`enrichProject`). Updates: `lib/projects.js:1224` (`updateProject`).
- **Methodology-action invocation** — `POST /api/projects/:name/actions/:command` `server.js:1138`. Dispatcher: `lib/actions.js:68` (`runAction`).
- **Methodologies registry** — `GET /api/methodologies` `server.js:1119`, `GET /api/methodologies/:id` `:1125`. Backend: `lib/methodologies.js:235` (`initialize`), `:614` (`listTemplates`).
- **Sessions family** — `POST /api/sessions/:project` (launch) `:1162`, `DELETE` (kill) `:1232`, `GET /status` `:1265`, `POST /command` `:1274`, `POST /wrap` `:1304`, `POST /wrap/complete` `:1338`, `GET /peek` `:1354`, `GET /history` `:1374`. Core: `lib/sessions.js:51` (`launchSession`), `:335` (`generatePrimePrompt` docstring).
- **Wrap pipeline runner** — `lib/wrap-pipeline.js:135` (`runWrapPipeline`).
- **Server-info endpoint** (#199, #235) — `GET /api/server-info` `server.js:324` (now includes `restartMechanism`). Backend: `lib/server-info.js`.
- **Server-restart endpoint** (#235) — `POST /api/server/restart` (next to `/api/server-info`). 202 Accepted before exec; 501 when no mechanism. Backend: `lib/server-info.js#detectRestartMechanism`, `#buildRestartCommand`.
- **PortHub leasing** — `POST /api/ports/lease` `:805`, `POST /api/ports/release` `:834`, `POST /api/ports/heartbeat` `:843`, `GET /api/ports` `:781`, `POST /api/ports/sync` `:828`. Backend: `lib/porthub.js`.
- **Groups family** — `GET /api/groups` `server.js:1493`, `POST` `:1505`, `GET/PUT/DELETE /:id` `:1521`/`:1536`/`:1555`, `POST /:id/sync` `:1568`, `GET/POST/DELETE /:id/members` `:1583`/`:1598`/`:1615`.
- **Shared-docs family** — `GET /api/shared-docs` `server.js:1627`, `POST` `:1637`, `GET/PUT/DELETE /:id` `:1659`/`:1670`/`:1689`, lock CRUD `:1704`/`:1723`/`:1733`.
- **OpenClaw connections family** — `GET /api/openclaw/connections` `server.js:1745`, `POST` `:1751`, `GET/PUT/DELETE /:id` `:1777`/`:1786`/`:1818`, `POST /api/openclaw/test` `:1839`, tunnel CRUD `:1887`/`:1921`/`:1941`, approve-pending `:1980`.
- **Eval Audit ingest** — `POST /api/audit/ingest` `server.js:2504`, `POST /api/audit/heartbeat` `:2770`. Backend: `lib/eval-audit.js:55` (`runTier1`), `:238` (`watchSession`).
- **Activity feed** — `GET /api/activity` `server.js:1394`.
- **Uploads** — `POST /api/upload` `server.js:1435`, `GET /api/uploads` `:1462`. Backend: `lib/uploads.js`.
- **Tmux mouse mode** — `GET /api/tmux/mouse/:session` `server.js:1480`.
- **Sidecar processes** — `GET /api/sidecar/:project/processes` `server.js:2724`, `GET /api/sidecar/connection/:connId/processes` `:2747`. Backend: `lib/sidecar.js`.
- **Skills / wrap-shape registry** — `lib/skills.js:108` (`getWrapSkill`).
- **Project store / DB** — SQLite-backed project records, project-config persistence. `lib/store.js` (`DEFAULT_PROJECT_CONFIG`, `store.projects.*`).
- **Engine profiles + config generation** — detect installed engines, generate per-engine config files (`CLAUDE.md`, `.gemini/`, `.aider.conf.yml`, etc.). `lib/engines.js:16` (`detect`), `:214` (`generateConfig`), `:935` (`_buildBaselineHooks`).

## Methodologies / Engines

- **Methodology registry** — loads `data/templates/<id>/template.json` + `playbook.md`. `lib/methodologies.js:235` (`initialize`).
- **Prawduct template** — methodology shipped in repo. `data/templates/prawduct/template.json`, `data/templates/prawduct/playbook.md`.
- **Engine profiles** — claude, codex, gemini, aider, genesis, openclaw. `data/engines/<id>.json`. Capability gates (`supportsSilentPrime`, `supportsPrimePrompt`, etc.) consumed throughout `lib/sessions.js`, `lib/engines.js`. **Canonical-source sync** (#251): on every `store.init()`, bundled `data/engines/*.json` is reconciled into `~/.tangleclaw/engines/`; drift triggers a `log.warn` then overwrite. Operator-added profiles with no bundled counterpart are preserved. Helper: `lib/store.js#_syncBundledEngines`.
- **SessionStart hook (Claude Code)** — shell script Claude Code runs on session start; reads `<project>/.tangleclaw/session-prime.md` and emits it as the prime context. `data/hooks/sessionstart-prime.sh`. Hook plumbing: `lib/engines.js:935` (`_buildBaselineHooks`).
- **AI co-author strip commit-msg hook** (#247) — POSIX-sh `commit-msg` git hook installed into every TC-managed project's `.git/hooks/`; strips `Co-Authored-By:` trailers naming AI coding assistants (Claude/GPT/Gemini/Copilot/Aider/Cursor) before commits land. Forward-only. Toggle via `globalSettings.stripAiCoauthors` (default ON). Script: `data/hooks/strip-ai-coauthors.sh`. Install/uninstall: `lib/git-hooks.js#syncGitHooks`. Lifecycle wiring: `lib/projects.js#createProject`, `#attachProject`, `#syncAllProjects`. PATCH-time re-sync in `server.js` `/api/config`. UI: `public/ui.js#openGlobalSettings` → *Commit hygiene*.
- **AI co-author strip — global git template** (#252) — companion to the per-project installer above. Installs the same hook into `~/.tangleclaw/git-template/hooks/commit-msg` and points `git config --global init.templateDir` at it, so every `git init` / `git clone` on the host (even outside TC's view) inherits the hook. Three-case `init.templateDir` detection (unset → claim; ours → no-op; non-TC → warn, don't clobber). Drift-aware revert via sentinel `~/.tangleclaw/git-template/.tc-init-templatedir-owned`. Backend: `lib/git-template.js#syncGlobalTemplate`. Wiring: `lib/projects.js#syncAllProjects` (startup) + `server.js` `/api/config` toggle handler. Limitation: only fires for FUTURE repos; existing on-disk repos require the per-project installer above (or a future bulk-sweep follow-up).
- **ClawBridge session pre-create with permissionMode** (#210) — when an OpenClaw connection has a `bridgePort` AND the operator picks a launch mode, TC pre-POSTs `/v2/session/start` to ClawBridge through the SSH tunnel before returning the iframe URL, so the chosen `permissionMode` propagates to the spawned claude process. Bridge contract: ClawBridge v1.6.0 (`permissionMode` field) + v1.7.0 (`attachIfExists` for idempotent attach). Client: `lib/clawbridge.js#startSession`. Wiring: `lib/sessions.js#launchWebuiSession`. Mode mapping: `data/engines/openclaw.json#launchModes` — six modes (`default`, `acceptEdits`, `bypassPermissions`, `auto`, `plan`, `dontAsk`) each with `bridgePermissionMode`. Picker gate honors per-mode `disabled` flag at `public/landing.js`.
- **Wrap pipeline runner** — orchestrates the wrap step sequence declared in `template.json#wrap_pipeline.steps[]`. `lib/wrap-pipeline.js:135`.
- **Wrap step: `version-bump`** — semver bump on `[Unreleased]` promotion. `lib/wrap-steps/version-bump.js`.
- **Wrap step: `critic-check`** — surfaces medium+ work without Critic dispatch; halts wrap on `severity:"blocking"` findings in `.tangleclaw/critic-runs.json` entries for current branch with `ranAt:"actual"` (#264). Operator override: `options.criticBlockingOverride` + `criticBlockingOverrideReason` proceeds and stages an audit-trail entry. `lib/wrap-steps/critic-check.js`.
- **Wrap step: `commit`** — flushes staged writes, makes the wrap commit. Auto-branches to `wrap/<YYYYMMDDHHmmss>-<slug>` when wrap fires on `main`/`master` (#264); `options.allowDirectToMain` bypasses for trivial doc edits / hot-fixes. `lib/wrap-steps/commit.js`.
- **Wrap step: `features-toc`** (#207 Chunk 3) — append-stub for files touched in PR not yet in FEATURES.md. `lib/wrap-steps/features-toc.js`.
- **Wrap step: `priming-roll`** — roll the next-session priming pointer. `lib/wrap-steps/priming-roll.js`.
- **Wrap step: `pr-check`** — surfaces open PRs. `lib/wrap-steps/pr-check.js`.
- **Wrap step: `ai-content`** — prompts injected into the AI session for changelog / learnings / memory updates. `lib/wrap-steps/ai-content.js`.
- **Wrap step: `test`** / **`lint`** — test + lint hooks. `lib/wrap-steps/test.js`, `lib/wrap-steps/lint.js`.
- **Mark Critic Run action handler** — appends entry to `.tangleclaw/critic-runs.json`; **does not run a Critic** (the review is out-of-band). `lib/actions/invoke-critic.js`. UX clarification (label + confirm + toast) landed in #230.
- **Project version reader** — surfaces `version.json` semver to the UI. `lib/project-version.js`.
- **Model status monitor** — polls engine providers (Atlassian / Google status pages) for outage detection. `lib/model-status.js:202` (`_pollEngine`), `:303` (`startMonitor`).

## CLI / Tooling

- **Git helpers** — repo detection, branch/dirty/tag/commit-age info, commits, internal cache. `lib/git.js:33` (`isGitRepo`), `:47` (`getInfo`), `:171` (`commit`).
- **Tmux helpers** — session create/kill/list, send-keys, capture-pane, mouse mode. `lib/tmux.js:100` (`createSession`), `:177` (`sendKeys`), `:251` (`capturePane`), `:298` (`setMouse`).
- **TTYD watcher** — keeps the shared ttyd alive; restart hook on PTY exhaustion (#94). `lib/ttyd-watcher.js`.
- **Tunnel** — Cloudflare tunnel lifecycle for remote access. `lib/tunnel.js`.
- **Sidecar** — supplementary process supervisor. `lib/sidecar.js`.
- **HTTPS setup** — mkcert-backed cert discovery + HTTPS listener. `lib/https-setup.js`.
- **Update checker** — GitHub release-tag polling. `lib/update-checker.js`.
- **Uploads** — file-upload handling for the in-browser drop zone. `lib/uploads.js`.
- **System stats** — CPU / mem / disk for the landing page. `lib/system.js`.
- **Port scanner** — local-port introspection for the PortHub UI. `lib/port-scanner.js`.
- **PID file** — single-instance guard. `lib/pidfile.js`.
- **Installer** — bootstrap script for fresh hosts. `deploy/install.sh`.
- **Detached ttyd attach** — helper for reconnecting to the shared ttyd. `deploy/ttyd-attach.sh`.
