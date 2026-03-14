# Changelog

All notable changes to TangleClaw are documented in this file.

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
