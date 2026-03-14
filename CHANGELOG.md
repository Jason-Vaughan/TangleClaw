# Changelog

All notable changes to TangleClaw are documented in this file.

## [Unreleased]

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
