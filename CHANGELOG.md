# Changelog

All notable changes to TangleClaw are documented in this file.

## [Unreleased]

### Fixed

- **Model status not shown in session banner**: The model status monitor was only wired to the landing page project cards. Now the session page banner also fetches and displays upstream service status on the engine badge (green/amber/orange/red left border + tooltip), matching the landing page behavior. Polls every 2 minutes.

## [3.1.0] - 2026-03-18

### Added

- **Model status monitor**: Engine badges on project cards now show real-time upstream service status via a colored left border (green = operational, amber = degraded, orange = partial outage, red = major outage). Status polled every 2 minutes from official status pages (Anthropic, OpenAI, Google Cloud). Hover for details.
- **New API endpoint**: `GET /api/models/status` returns cached upstream service status for all engines with status page configs.
- **Engine profile `statusPage` field**: New optional field on engine profiles for upstream status page configuration (adapter type, URL, component/product identifiers). Set to `null` for engines without a known status page.
- **Status parity guard**: `validateStatusParity()` ensures every engine profile declares a `statusPage` field. Parity tests catch missing status config when adding new engines.

## [3.0.3] - 2026-03-18

### Fixed

- **Session page never redirects after session ends**: `getSessionStatus()` returned `active: true` even when the tmux session had died, so the countdown/redirect to the landing page never fired. Now detects dead tmux sessions and marks them as crashed, allowing the frontend to show the countdown and redirect.
- **Empty terminal on first launch after wrap**: When a wrapping session's tmux died, `enrichProject()` still reported it as `active: true`. The landing page would skip the server-side launch and navigate to a dead terminal. Now checks tmux liveness before reporting sessions as active, and `launchSession()` cleans up stale wrapping/active sessions before creating new ones.
- **Uncommitted work left behind after wrap**: The wrap protocol told the AI to commit, but if the engine exited before completing the commit step, changes were left uncommitted. Now `completeWrap()` and `autoCompleteWrap()` programmatically commit any uncommitted changes after the wrap finalizes.

## [3.0.2] - 2026-03-18

### Fixed

- **Orphan port leases never cleaned up**: Permanent port leases imported from the old PortHub daemon for projects that no longer exist (e.g. archived `TiLT-v1-archived` on port 5432) stayed in the database forever. The import banner would show them, but clicking Import just auto-ignored them in localStorage — the lease remained. Now: (1) `bootstrap()` runs `_cleanupOrphanLeases()` on every server start, releasing leases for projects that are neither registered in SQLite nor present as directories in projectsDir. (2) The `POST /api/projects/import` endpoint now releases orphan leases when the directory doesn't exist instead of just warning.

## [3.0.1] - 2026-03-18

### Fixed

- **Import banner keeps re-triggering for the same projects**: The "project found in port leases not registered in TangleClaw" banner used `sessionStorage` for dismissal (cleared on every page load) and showed no details about what was found. Root causes: (1) TangleClaw's own infra ports registered as "TangleClaw" but the project is registered as "TangleClaw-v3" — constant mismatch. (2) Projects without matching directories (e.g. archived) could never be imported, so the banner returned forever. Fixed by: deriving the system port project name from the install directory, adding per-project "Ignore" buttons with `localStorage` persistence, showing project names/ports/conflicts in the banner, and auto-ignoring projects whose directories don't exist when import is attempted.
- **Port leases not tracked on project rename**: Added `portLeases.renameProject()` to update all leases when a project name changes. Project rename via PATCH now cascades to port lease records.
- **ttyd "Too many open files" causing reconnect loop**: ttyd was leaking PTY file descriptors (`/dev/ptmx`) when WebSocket connections dropped — they accumulated over time until hitting the default macOS launchd limit of 256 FDs, at which point `pty_spawn` failed on every new connection. Raised `SoftResourceLimits` and `HardResourceLimits` for `NumberOfFiles` to 4096 in both the plist template (`deploy/com.tangleclaw.ttyd.plist`) and the installed plist. Re-run `deploy/install.sh` or manually reload the launchd agent to apply.
- **Wrap command sends `/session-wrap` slash command that Claude Code doesn't recognize**: The default wrap command was `/session-wrap`, which Claude Code rejects as `Unknown skill: session-wrap`. Changed to a natural language prompt so Claude Code interprets it as a regular instruction instead of a non-existent slash command.
- **Kill button disabled during wrapping with no escape hatch**: Both wrap and kill buttons were disabled during wrapping state. If the wrap completed but tmux stayed alive, the user was stuck. Kill button now stays enabled during wrapping. Also added idle detection during wrapping — if Claude goes idle for 3 consecutive polls (~6s), the wrap auto-completes without requiring tmux to die.
- **Mobile terminal scrollback**: Added touch scroll shim for the terminal iframe on mobile. xterm.js's built-in touch handling doesn't scroll through the scrollback buffer on mobile; the shim intercepts touch swipe events and calls `scrollLines()` on the xterm.js instance directly.
- **Session wrap lifecycle**: Wrap button now works end-to-end. Clicking Wrap transitions the session from `active` → `wrapping` → `wrapped` with proper state tracking. The terminal stays visible during wrapping so the user can watch the AI execute wrap steps. When the AI exits tmux, the wrap summary is auto-captured from terminal output and stored for the next session's prime prompt. Added 20s countdown with "Stay" button on wrap completion. The wrap command is now methodology-driven — template-defined `steps` and `captureFields` are sent to the AI and used to parse structured output.

### Added

- **Global settings modal** (Phase 3, Chunk 1+2): Gear icon in header opens a settings modal with all configurable options — theme, peek mode, global chime mute, default engine/methodology, projects directory, and port scanner controls. Previously required API calls or the first-run wizard.
- **Global chime mute** (Phase 3, Chunk 1): Master mute toggle (`chimeMuted`) that silences chime notifications across all sessions, independent of per-session chime settings.
- **Theme support** (Phase 3, Chunk 1): Theme selection (dark/light/high-contrast) now applies CSS variable overrides immediately on save and persists across pages (landing + session). Dark remains the default.
- **Configurable port scanner** (Phase 3, Chunk 2): Port scanner can now be disabled (`portScannerEnabled`) or have its interval adjusted (`portScannerIntervalMs`, 10s–600s). Changes take effect immediately — scanner restarts or stops without requiring a server restart.

### Fixed

- **ttyd reconnect loop**: Fixed `deploy/ttyd-attach.sh` where `exec cmd1 || exec cmd2` fallback was dead code (`exec` replaces the shell, so `||` never runs). When a tmux session died overnight, ttyd would rapidly loop trying to reattach. Now uses `tmux new-session -A` which atomically attaches or creates. Added regression tests to prevent reintroduction.
- **Legacy `claude-code` engine ID in project configs**: The engine rename from `claude-code` to `claude` only updated the DB and defaults — existing `.tangleclaw/project.json` files on disk retained the old ID, causing "Engine not found" on launch. Added migration in `projectConfig.load()` that normalizes `claude-code` to `claude` on read. Bulk-fixed all 16 affected project configs.
- **Spaces in project names**: Project names with spaces (e.g. "TiLT v2") were rejected by the name validator. Now allowed — spaces are converted to hyphens for tmux session names via `tmux.toSessionName()`. Sanitization applied in session launch, status checks, delete, and ttyd-attach.sh.

### Changed

- **product-hook phase sync removed**: The `_sync_phase_to_tangleclaw()` code in product-hook was removed by upstream Prawduct framework sync. Phase sync is now handled externally.
- **Methodology config corruption**: Fixed Notse project showing "Minimal" on splash page when it was built with Prawduct (config had wrong methodology value while `.prawduct/` directory existed)

### Added

- **Detach vs Delete**: Project cards now have two actions — detach (removes from TangleClaw, files stay on disk, re-attachable) and delete (removes from TangleClaw and deletes files from disk). Delete requires type-to-confirm; detach shows a simple confirmation.
- **Hide unattached projects by default**: Landing page now only shows registered projects. A "N unattached" toggle button in the toolbar reveals unregistered projects when needed. Preference persists in localStorage.
- **Methodology hook management**: TangleClaw now manages `.claude/settings.json` hooks based on the assigned methodology. Prawduct projects get session governance hooks (product-hook clear/stop) pointing to TangleClaw's tools directory. Minimal/TiLT projects get hooks cleared. Hooks are synced on project create, attach, methodology switch, and session launch.
- **Methodology switch confirmation modal**: Changing a project's methodology now shows a confirmation dialog explaining what gets archived, what gets initialized, and that hooks will update. Archived state stays accessible to AI assistants.
- **Methodology archive tracking**: When switching methodologies, the archive path is stored in project config and referenced in generated CLAUDE.md/GEMINI.md and prime prompts so AI assistants know about prior methodology state.
- **`hooks` field in methodology templates**: Templates can now declare engine-specific session hooks with `{{TANGLECLAW_DIR}}` placeholder resolution.
- **Methodology badge in session banner**: Purple pill next to the engine badge shows the active methodology during a session.
- **Engine and methodology badges on splash page**: Project cards now show engine (green) and methodology (purple) badges with consistent color coding across session and landing pages.
- **Phase badge**: Orange pill shows the current methodology phase (e.g., "building", "discovery") on both splash page cards and session banner.
- **Kill button styling on landing page**: Kill session button on project cards now has red outline matching the session banner kill button style.
- **Automatic phase sync**: Product-hook infers the methodology phase from `work_in_progress.type` in project-state.yaml at session start and syncs it to TangleClaw via the API. Phase badge updates automatically without manual configuration.
- **Phase field in project updates**: `PATCH /api/projects/:name` now accepts a `phase` field to set the methodology phase.
- **Inferred phase fallback**: Projects with a methodology but no explicit phase show an inferred state badge — "in session" (active session), "active" (dirty git), or "idle" (no activity). Every methodology-enabled project now has a visible state indicator.
- **Mobile card layout**: On narrow screens (480px and below), project cards stack the name on its own line above badges and action buttons, preventing name truncation.

### Added

- **Parity validation**: New `validateParity()` function in `lib/engines.js` programmatically verifies that all engines with `supportsConfigFile: true` include core rules, PortHub guide, global rules, and methodology info in their generated config. Callable from tests and the Independent Critic.
- **Cross-feature integration tests**: Full-flow tests verifying Gemini config generation with all sections, global rules propagation across regenerated configs, port scanner conflict detection via `checkPort()`, and parity-equivalent output across all engines.
- **Parity checklist documentation**: `docs/engine-guide.md` now includes a step-by-step checklist for adding new engine generators with parity requirements.

### Added

- **Periodic Port Scanner**: New `lib/port-scanner.js` module scans the system for listening TCP ports using `lsof` every 60 seconds. `checkPort()` now detects conflicts with ports bound by processes outside the lease registry (returns `systemDetected: true`). `registerPort()` logs a warning when registering a port already in use by a system process but still allows registration. `GET /api/ports` response includes `systemPortCount` (count of system-detected ports not tracked in lease DB). Graceful degradation if `lsof` is unavailable.
- **Global Rules System**: Editable markdown rules that apply to all projects across all engines. Global rules are injected as a `## Global Rules` section into every generated engine config (CLAUDE.md, .codex.yaml, .aider.conf.yml, GEMINI.md). Editable from the landing page or via API (`GET/PUT /api/rules/global`, `POST /api/rules/global/reset`). Stored at `~/.tangleclaw/global-rules.md`, auto-created from bundled defaults on first load.

### Added

- **Gemini CLI engine support**: New built-in engine profile for Google's Gemini CLI. Config file (`GEMINI.md`) is generated in `.gemini/` subdirectory with full rule injection (core rules, extension rules, PortHub guide, methodology info). Auto-detected via `which gemini`.
- **Cross-platform rule injection parity**: All engines with config file support (Claude Code, Codex, Aider) now receive the same core rules, extension rules, PortHub guide, and methodology info — translated into each engine's native format. Previously only Claude Code got full rule content.
- **Codex config now includes instructions**: Generated `.codex.yaml` files include an `instructions:` field with full markdown rules, PortHub guide, and methodology description.
- **Aider config now includes rules**: Generated `.aider.conf.yml` files include core rules and PortHub references as YAML comments for human visibility.
- **Rule parity test suite**: Automated tests verify that every engine with `supportsConfigFile: true` includes core rules, PortHub references, and methodology info in its generated config.

### Changed — Ports Panel UI

- **Bright white port group headers**: Port group names now use the primary text color (`--text`) instead of muted gray, improving readability in the ports panel.
- **Collapsible port groups**: Each project group in the ports panel can be individually collapsed/expanded via a clickable toggle with arrow caret. All groups default to open. Keyboard accessible (Enter/Space) with `aria-expanded` attributes. Lease count shown next to each group name.

### Added

- **Kill button on landing page**: Project cards with active sessions now show a Kill button (stop icon) in the card row and in the expanded detail view. Opens a confirmation modal with password support if delete protection is configured. Previously Kill was only available from the session view.

### Fixed

- **Terminal iframe shows wrong tmux session**: ttyd was hardcoded to a single "tangleclaw" tmux session, so the iframe always showed a blank shell instead of the project's actual session (with Claude Code running). Added `--url-arg` flag and a `ttyd-attach.sh` wrapper script so ttyd connects to the correct per-project tmux session based on the iframe's `?arg=` parameter.
- **Terminal input completely broken (desktop and mobile)**: ttyd 1.7.x defaults to readonly mode. The launchd plist was missing the `--writable` flag, so the terminal rendered output but silently rejected all keyboard input. Added `--writable` to the ttyd plist. Re-run `deploy/install.sh` to apply.
- **Terminal touch input blocked on mobile**: `touch-action: none` on the session wrapper body prevented touch events from reaching the terminal iframe on iOS Safari and Android Chrome. Changed to `touch-action: manipulation`.
- **Launch fails on orphaned tmux sessions**: When a tmux session existed from a previous run but the database had no active record (e.g., after a server restart), clicking Launch would fail with "Failed to create tmux session". Now automatically adopts the orphaned tmux session instead of failing.
- **Engine detection failing under launchd**: The install script built a minimal PATH for the launchd service that excluded user-installed binary locations (`~/.local/bin`, `~/.npm-global/bin`). Engine detection via `which` failed for Claude Code, Gemini CLI, and any other engines installed outside standard system paths. Install script now captures the user's full `$PATH` at install time.
- **New bundled engine profiles not seeded to existing installs**: The store's `_copyBundledFiles()` skipped entirely if the engines directory already had files, so newly added profiles (e.g., Gemini from p2-3) were never copied to `~/.tangleclaw/engines/`. Now copies any missing profiles individually.
- **Launch button silently failing**: Clicking Launch on a project card showed no feedback when the API returned an error. Now shows a toast notification with the specific error message.

### Fixed

- **Aider config generation silently failing**: The Aider engine profile declared generator `"aider-yaml"` but the code switch case expected `"aider-conf"`, causing `generateConfig('aider', ...)` to return `null`. Aider projects now get properly generated `.aider.conf.yml` files.

### Changed — Deployment

- **Server port changed to 3102**: Deploy template and install script now set `TANGLECLAW_PORT=3102` via launchd environment variable, avoiding conflict with v1 on port 3101. The application code default remains 3101 but is overridden at the deployment layer.

### Fixed — Post-Chunk Polish

- **Stats panel not fully collapsing**: System stats toggle left 12px of padding visible when collapsed, showing partial stat card outlines. Bottom padding now only applies when the panel is open.
- **Version badge missing from project cards**: Project cards now show the latest git tag (e.g. "v3.0.0") inline, restoring v2 parity. Added `latestTag` field to git info via `git describe --tags --abbrev=0`.

### Changed — Chunk 14: Landing Page UX Overhaul

- **Compact horizontal header**: Header is now a horizontal flex row — 64px logo + wordmark image side-by-side, ~80px total height. Falls back gracefully if logo-icon.png/logo-text.png are missing.
- **System stats always visible**: Stats grid defaults to open (CPU, Memory, Disk, Uptime visible on page load) with a minimize toggle.
- **Compact project cards**: Cards are now single-line compact rows — name + badges + status dot + inline action buttons. ~35 projects visible without scrolling on desktop. Card click expands a detail panel instead of navigating away.
- **Card detail expansion**: Clicking a card expands an inline detail panel showing engine, methodology, session info, git branch, and tags. Launch/Open button on the card row navigates to the session.
- **Root projects directory panel**: Blue-tinted full-width panel at top of project list showing the projects directory path and project count.
- **Active session count styling**: Session count shows green-styled number (e.g., "2 active sessions").
- **Ports panel collapsed by default**: Unchanged behavior (already collapsed).
- **Unregistered projects**: Filesystem-only directories appear with muted opacity and "Attach" button (from Chunk 13).

### Fixed — Chunk 13: Functional Bug Fixes

- **Session launch race condition**: After launching a session, the session page now appends `?launched=1` to the URL. When present, the first 3 status polls ignore `active: false` responses (grace period), preventing false "session ended" redirects while tmux starts up.
- **Missing projects**: `GET /api/projects` now merges SQLite-registered projects with ALL filesystem directories in projectsDir. Unregistered directories appear with `registered: false` and a muted style with "Attach" button on the landing page. New `POST /api/projects/attach` endpoint registers existing directories. New `listAllProjects()` and `attachProject()` functions in `lib/projects.js`.
- **Memory calculation wrong on macOS**: `getMemoryInfo()` now uses `vm_stat` and `sysctl` on macOS to calculate `used = active + wired + compressed` pages. Falls back to `os.freemem()` on non-macOS or command failure. Reports accurate ~50% usage instead of ~98%.
- **Uptime display**: Added `uptimeFormatted` field to `GET /api/system` response (e.g. "3d 2h", "5h 30m", "12m"). New `formatUptime()` utility in `lib/system.js`.
- **Methodology initialization errors**: Methodology init errors now include specific context (template not found, directory creation failed, postInit failed). `POST /api/projects` response includes `warnings` array on partial success. Create drawer shows toast for init warnings.
- **Phantom project creation guard**: `POST /api/setup/complete` now validates that each project path exists and is a directory before registering. Invalid paths are skipped with a warning.
- **28 new tests** (624 total): Memory calculation (vm_stat parsing, formatUptime), filesystem project merge (listAllProjects, attachProject), attach API endpoint, setup wizard path validation, system uptimeFormatted. Plus 2 git latestTag tests (626 total).

### Changed
- **Engine ID renamed from `claude-code` to `claude`**: The default engine profile ID now matches the actual CLI binary name. Eliminates the recurring bug where v2 interpreted the engine ID as a literal shell command, causing `zsh: command not found: claude-code`. Updated all defaults, DB schema, config, tests, and docs.

### Added — Chunk 12: UX Parity + Mobile Polish

- **Real logo assets**: Replaced SVG placeholder logos with v2's serpent logo (`logo.png` in header, `icon-192.png` in session banner). Added icon files (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) to `public/icons/`. Updated manifest.json to reference correct icon paths.
- **Compact project cards**: Redesigned landing page cards — header with name + git branch + version badge, green breathing dot for active sessions, streamlined actions (Launch, peek eye, settings gear, subtle delete x). Removed standalone Wrap button from cards.
- **Upload system**: New `lib/uploads.js` module for saving files to a project's `.uploads/` directory with timestamped names and extension allowlist. Two new API endpoints: `POST /api/upload` (15MB limit) and `GET /api/uploads?project=name`.
- **Per-route body size limits**: `route()` now accepts an `options` parameter with `maxBodySize`, passed through to `parseBody()`. Upload route uses 15MB; all others retain the 10KB default.
- **Session Select button**: Toggles tmux mouse mode for text selection with 30s auto-revert timer. Mobile: enables mouse for native selection. Desktop: disables mouse for native selection.
- **Session Upload modal**: File picker with image preview, base64 upload to project's `.uploads/` directory, result shows the path to tell your AI assistant, recent upload history.
- **PortHub lease import**: Landing page detects port leases referencing unregistered projects and shows an import notification banner with "Import All" action.
- **Card peek panel**: Eye icon on active-session cards opens an inline terminal peek (last 15 lines) directly on the landing page, matching v2 behavior. Only shown for projects with active sessions; toggles open/closed.
- **Delete modal text**: Updated to clarify that deletion removes the project and kills any active session.
- **15 new tests** (595 total): Upload module unit tests (8) and upload API endpoint tests (5), plus 2 list tests.

### Fixed

- **Session page redirect on untracked sessions**: Session page no longer times out and redirects to the landing page when a tmux session exists but wasn't launched through v3. Status endpoint now falls back to checking tmux directly when the DB has no active session record, returning `active: true` with an `untracked` flag.
- **PortHub daemon import**: Fixed `_migrateFromOldPorthub()` — the `porthub status --json` CLI outputs ASCII art before the JSON array, so `JSON.parse()` was failing silently. Now extracts JSON by finding the first `[` character. Also handles the raw array format (not wrapped in `{ leases: [...] }`). Expired leases are now skipped during import.
- **PortHub sync on every boot**: Removed the one-time migration gate (`existing.length <= 2 && infraOnly`). Import now runs on every server start, safely skipping ports already in the database. Expired leases are filtered out. Added `POST /api/ports/sync` endpoint and `syncFromDaemon()` for manual re-sync.
- **Project delete releases ALL ports**: `deleteProject()` now calls `store.portLeases.releaseByProject(name)` instead of only releasing ports stored in the project record's `ports` field. This ensures ports registered via API or imported from the old PortHub daemon are also cleaned up when a project is deleted.

### Added — Chunk 11: First-Run Setup Wizard

- **Setup wizard**: Full-screen overlay on first launch guides new users through configuration — projects directory, existing project detection, engine availability, default preferences. Six-step card flow with step indicators, skip button on every step.
- **Project scanning**: `POST /api/setup/scan` scans any directory for existing projects by detecting git repos, methodology markers (.prawduct/, .tilt/), and TangleClaw config files.
- **Batch setup**: `POST /api/setup/complete` atomically updates config (projectsDir, defaultEngine, defaultMethodology, deletePassword, chimeEnabled), attaches selected projects, and marks setup complete.
- **Existing install migration**: Configs without `setupComplete` field automatically default to `true` (skip wizard). Only fresh installs see the wizard.
- **17 new tests** (580 total): Config migration behavior, scan endpoint validation, setup completion with project attachment, password hashing, skip flow.

### Added — Chunk 10: PortHub Deep Integration

- **Embedded port lease management**: Port leases are now stored in TangleClaw's SQLite database (`port_leases` table) instead of depending on the external PortHub daemon. Leases survive server restarts.
- **Port lease API**: Four new endpoints — `GET /api/ports` (list all, grouped by project), `POST /api/ports/lease` (create/renew), `POST /api/ports/release` (release), `POST /api/ports/heartbeat` (extend TTL leases).
- **Landing page ports panel**: Collapsible "Ports" section between system stats and toolbar. Shows all leases grouped by project with port number, service name, and type badge (permanent/TTL). Auto-refreshes every 30 seconds.
- **Server bootstrap/shutdown**: TangleClaw registers its own infrastructure ports (ttyd, server) on startup and releases them on shutdown. Periodic expiration timer cleans up stale TTL leases.
- **PortHub guide for AI assistants**: `data/porthub-guide.md` is automatically injected into generated CLAUDE.md files when the `porthubRegistration` core rule is active.
- **One-time migration**: On first startup with an empty leases table, existing leases are imported from the old PortHub daemon (if available).
- **Install script update**: PortHub CLI is now shown as an optional prerequisite (not required).
- **18 new tests** (563 total): Store-level port lease CRUD, porthub module rewrite, API endpoint tests, engine guide injection tests.

### Changed

- `lib/porthub.js` rewritten from shell-out to store-backed operations. No longer depends on the `porthub` CLI for runtime port management.
- Schema version bumped to 2 (v1→v2 migration adds `port_leases` table).

## [3.0.0] — 2026-03-14

Full rewrite of TangleClaw from a tmux session manager into a methodology-aware AI development orchestration platform.

### Added

- **Methodology engine**: Pluggable methodology templates (Prawduct, TiLT, Minimal) with structural enforcement. Core rules are mandatory; extension rules are opt-in per project.
- **Engine adapter layer**: Support for Claude Code, Codex, Aider, and Genesis engine profiles. Adding engines is just creating a JSON profile — no code changes needed.
- **Session lifecycle**: Prime prompt generation (reads methodology + state + learnings), configurable wrap skill, session history tracking, idle detection.
- **Skills system**: Installable, configurable behaviors. Session-wrap skill ships with v3.
- **Landing page rewrite**: Semantic HTML, PWA support (manifest + service worker + Add to Home Screen), search/filter, project cards with methodology status, engine badges, mobile-optimized modals and drawers.
- **Session wrapper rewrite**: Command bar with engine-specific slash commands, peek drawer, settings modal, chime system (Web Audio API), mouse guard, breathing status dot.
- **SQLite runtime state**: `node:sqlite` for ACID session/activity/learning storage. JSON preserved for human-editable config. Storage abstraction layer insulates app code.
- **PortHub integration**: Auto-register ports on project create, auto-release on delete. Graceful degradation when PortHub is unavailable.
- **Learning capture**: Learnings stored per-project with auto-promotion from provisional to active. Re-indexed for faster session starts. Surfaced in prime prompt.
- **v2 project auto-detection**: Existing projects with `.tangleclaw/project.json` or methodology markers (`.prawduct/`, `.tilt/`) are auto-detected.
- **API**: 24 endpoints covering projects, sessions, engines, methodologies, system, config, health, activity, and tmux mouse control.
- **Deployment**: launchd plists, install script with prerequisite checking, idempotent reload.
- **Git hooks**: pre-commit (test suite), commit-msg (format validation), post-commit (version tagging).
- **500+ tests**: Full test coverage across all modules using `node:test`. Zero external test dependencies.
- **User documentation**: User guide, methodology guide, engine guide, and configuration reference in `docs/`. Covers getting started, UI walkthrough, custom template/engine creation, all config fields, and mobile setup.

### Changed

- **Zero dependencies**: Entire codebase uses Node.js 22+ stdlib only. No npm, no build step, no bundler.
- **Mobile-first**: 44px touch targets, safe area handling, PWA installable, tested on iPhone Safari and Pixel Fold 9.

### Fixed

- Android scroll behavior in session wrapper
- Chime playback on mobile browsers (Web Audio API instead of Audio element)
- Peek mode as drawer instead of alert
- XSS safety: all dynamic content uses `createElement` instead of `innerHTML`

### Architecture

- `server.js` — HTTP server with route table, static serving, terminal reverse proxy
- `lib/store.js` — Hybrid persistence (JSON + SQLite) behind a unified API
- `lib/methodologies.js` — Template loading, validation, initialization, switching, status contract execution
- `lib/engines.js` — Engine profile loading, detection, config generation
- `lib/projects.js` — Project CRUD with enrichment, password hashing, auto-detection
- `lib/sessions.js` — Session launch, priming, idle detection, wrap orchestration
- `lib/skills.js` — Skill loading and execution
- `lib/porthub.js` — PortHub API client with graceful degradation
