# Feature Index

<!--
Maintained automatically: the wrap-step handler appends
stubs when PRs touch new files. Fill in descriptions before
next wrap.

Format: - **Name** — short description. file.js:line, file2.js:line.
-->

## UI / Web

- **Landing page** — project list, port stats, system stats, group rendering. `public/landing.html`, `public/landing.js`.
- **Session view** — per-project app shell, banner, settings, wrap controls. `public/index.html`, `public/session.js`.
- **Settings modal** — per-project config editor (engine, methodology, silentPrime, featureIndexEnabled, rules). `public/ui.js:697`.
- **Silent-prime toggle** — engine-gated capability toggle. `public/ui.js:779`.
- **Feature Index toggle** (#207) — opt-in flag that seeds `FEATURES.md` on first enable. `public/ui.js:808`.
- **Banner group pills** — group membership chips on the session banner. `public/session.js:302`.
- **Methodology action buttons** — `actions[]` from `template.json` (e.g. "Run Critic"). `public/session.js:212`. Handler: `lib/actions/invoke-critic.js`. Toast: `public/session.js:281`.
- **Stale-server banner** (#199) — runtime-vs-disk SHA delta; no dismiss UI today. `public/landing.js:131`, `public/index.html:287`. Backend: `lib/server-info.js`.
- **Orphan-hooks repair banner** (#145) — scans projects for hook config drift. `public/landing.js:354`, `public/index.html:290`.
- **Update-available pill** — GitHub release check with localStorage dismiss-per-version. `public/landing.js:160`.
- **Session Wrap drawer** — step-by-step wrap status, BLOCKED/SKIPPED/DONE rendering. `public/wrap-drawer.js`.
- **OpenClaw view** — remote-engine project cache + view. `public/openclaw-view.js`, `public/openclaw-cache.js`.

## Server / API

- **HTTP entrypoint + route table** — `server.js` (single-file router; `route(method, path, handler)` registrations throughout).
- **`GET /api/projects`** — project list with enrichment. `server.js:854`. Enrichment: `lib/projects.js:559` (`enrichProject`).
- **`POST /api/projects/attach`** — register an existing directory as a project. `server.js:868`. `lib/projects.js:1111`.
- **`PATCH /api/projects/:name`** — update fields (silentPrime, featureIndexEnabled, methodology, engine, rules…). `lib/projects.js:1224` (`updateProject`).
- **`POST /api/projects/repair-orphan-hooks`** — strip orphan hook entries. `server.js:907`.
- **`GET /api/server-info`** (#199) — startup SHA, current disk SHA, isStale, uptimeSeconds. `server.js:324`. `lib/server-info.js`.
- **PortHub leasing** — `POST /api/ports/lease` `server.js:805`, `POST /api/ports/release` `:834`, `POST /api/ports/heartbeat` `:843`, `GET /api/ports` `:781`. Backend: `lib/porthub.js`.
- **Session lifecycle** — `POST /api/sessions/:project` (launch) `server.js:1162`, `DELETE` (kill) `:1232`, `GET /status` `:1265`, `POST /command` `:1274`. Core: `lib/sessions.js:51` (`launchSession`).
- **Session prime prompt builder** — assembles SessionStart prime text (last-session summary, eval-audit, Feature Index, etc.). `lib/sessions.js:340` (`generatePrimePrompt`).
- **Session Wrap pipeline** — `POST /api/sessions/:project/wrap` `server.js:1304`. Runner: `lib/wrap-pipeline.js:135` (`runWrapPipeline`).
- **Methodology-action dispatcher** — invokes declared template actions (write side of "Run Critic"). `lib/actions.js:68` (`runAction`).
- **Skills / wrap-shape registry** — looks up the wrap skill for a methodology. `lib/skills.js:108` (`getWrapSkill`).
- **Eval Audit** — Tier-1 exchange scoring + watchdog. `lib/eval-audit.js:55` (`runTier1`), `:238` (`watchSession`).
- **Project store / DB** — SQLite-backed project records, project-config persistence. `lib/store.js` (`DEFAULT_PROJECT_CONFIG`, `store.projects.*`).
- **Engine profiles + config generation** — detect installed engines, generate per-engine config files (`CLAUDE.md`, `.gemini/`, `.aider.conf.yml`, etc.). `lib/engines.js:16` (`detect`), `:214` (`generateConfig`).

## Methodologies / Engines

- **Methodology registry** — loads `data/templates/<id>/template.json` + `playbook.md`. `lib/methodologies.js`.
- **Prawduct template** — methodology shipped in repo. `data/templates/prawduct/template.json`, `data/templates/prawduct/playbook.md`.
- **Engine profiles** — claude, codex, gemini, aider, genesis, openclaw. `data/engines/<id>.json`. Capability gates (`supportsSilentPrime`, `supportsPrimePrompt`, etc.) consumed throughout `lib/sessions.js`, `lib/engines.js`.
- **SessionStart hook (Claude Code)** — shell script Claude Code runs on session start; reads `<project>/.tangleclaw/session-prime.md` and emits it as the prime context. `data/hooks/sessionstart-prime.sh`. Hook plumbing: `lib/engines.js:935` (`_buildBaselineHooks`).
- **Wrap pipeline runner** — orchestrates the wrap step sequence declared in `template.json#wrap_pipeline.steps[]`. `lib/wrap-pipeline.js:135`.
- **Wrap step: `version-bump`** — semver bump on `[Unreleased]` promotion. `lib/wrap-steps/version-bump.js`.
- **Wrap step: `critic-check`** — surfaces medium+ work without Critic dispatch. `lib/wrap-steps/critic-check.js`.
- **Wrap step: `commit`** — flushes staged writes, makes the wrap commit. `lib/wrap-steps/commit.js`.
- **Wrap step: `features-toc`** (#207 Chunk 3) — append-stub for files touched in PR not yet in FEATURES.md. `lib/wrap-steps/features-toc.js`.
- **Wrap step: `priming-roll`** — roll the next-session priming pointer. `lib/wrap-steps/priming-roll.js`.
- **Wrap step: `pr-check`** — surfaces open PRs. `lib/wrap-steps/pr-check.js`.
- **Wrap step: `ai-content`** — prompts injected into the AI session for changelog / learnings / memory updates. `lib/wrap-steps/ai-content.js`.
- **Wrap step: `test`** / **`lint`** — test + lint hooks. `lib/wrap-steps/test.js`, `lib/wrap-steps/lint.js`.
- **Run Critic action handler** — appends entry to `.tangleclaw/critic-runs.json`; **does not run a Critic** (the review is out-of-band). `lib/actions/invoke-critic.js`. UX clarification tracked in issue #230.

## CLI / Tooling

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
