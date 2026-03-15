# Changelog

All notable changes to TangleClaw are documented in this file.

## [Unreleased]

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
