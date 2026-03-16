# Changelog

All notable changes to TangleClaw are documented in this file.

## [Unreleased]

### Fixed

- **Methodology config corruption**: Fixed Notse project showing "Minimal" on splash page when it was built with Prawduct (config had wrong methodology value while `.prawduct/` directory existed)

### Added

- **Methodology hook management**: TangleClaw now manages `.claude/settings.json` hooks based on the assigned methodology. Prawduct projects get session governance hooks (product-hook clear/stop) pointing to TangleClaw's tools directory. Minimal/TiLT projects get hooks cleared. Hooks are synced on project create, attach, methodology switch, and session launch.
- **Methodology switch confirmation modal**: Changing a project's methodology now shows a confirmation dialog explaining what gets archived, what gets initialized, and that hooks will update. Archived state stays accessible to AI assistants.
- **Methodology archive tracking**: When switching methodologies, the archive path is stored in project config and referenced in generated CLAUDE.md/GEMINI.md and prime prompts so AI assistants know about prior methodology state.
- **`hooks` field in methodology templates**: Templates can now declare engine-specific session hooks with `{{TANGLECLAW_DIR}}` placeholder resolution.
- **Methodology badge in session banner**: Purple pill next to the engine badge shows the active methodology during a session.
- **Engine and methodology badges on splash page**: Project cards now show engine (green) and methodology (purple) badges with consistent color coding across session and landing pages.
- **Phase badge**: Orange pill shows the current methodology phase (e.g., "building", "discovery") on both splash page cards and session banner.
- **Kill button styling on landing page**: Kill session button on project cards now has red outline matching the session banner kill button style.

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
