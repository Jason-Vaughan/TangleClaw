# Changelog

All notable changes to TangleClaw are documented here.

## [2.11.0] — 2026-03-11

- Add session wrap, client-side chime polling, and settings enhancements

## [2.10.1] — 2026-03-09

- Fix false chime triggers with sustained activity thresholds

## [2.10.0] — 2026-03-09

- Move chime detection server-side with SSE push to all clients

## [2.9.0] — 2026-03-09

- Fix chime detection and service worker caching for session pages

## [2.8.0] — 2026-03-09

- Add settings menu with prompt chime notification

## [2.7.0] — 2026-03-09

- Move version display: TC version under logo, project version next to name

## [2.6.0] — 2026-03-09

- Add command bar to session wrapper for mobile-friendly input

## [2.5.0] — 2026-03-08

- Add project version badges, PortHub integration, and doc parity protocol

## [2.4.3] — 2026-03-07

- Fix changelog spacing in commit-msg hook

## [2.4.2] — 2026-03-07

- Add commit-msg hook to auto-update CHANGELOG.md on every commit

## [2.4.0] — 2026-03-07

### Added
- **Select mode** for terminal text copy — toggles tmux mouse off so browser handles text selection natively
- `/api/tmux/mouse` endpoint to toggle tmux mouse mode
- `/api/clipboard` and `/api/clipboard/view` endpoints for clipboard access
- tmux `copy-pipe-and-cancel` bindings write selections to `~/.tangleclaw/clipboard`

## [2.3.0] — 2026-03-06

### Added
- **Project rename** (PATCH `/api/projects/:name`)
- **Password-protected project delete** (DELETE `/api/projects/:name`)
- Delete confirmation modal with password field
- Rename modal in project detail panel
- `deletePassword` support in `~/.tangleclaw/config.json`

### Fixed
- Template init error logging and increased timeout to 30s

## [2.2.0] — 2026-03-06

### Added
- **Prawduct integration** — structured product development template
- Prawduct phase detection and purple phase badges on project cards
- Template picker split: builtin pills + custom dropdown for additional templates

## [2.1.2] — 2026-03-06

### Added
- Pre-push hook to auto-push tags alongside commits

## [2.1.1] — 2026-03-06

### Added
- Post-commit hook to auto-tag commits with version from `version.json`

## [2.1.0] — 2026-03-06

### Added
- **Semantic versioning** with `version.json` and pre-commit hook enforcement
- Version display in UI header and session wrapper banner
- **File upload system** — project-specific uploads from session wrapper
- **Project templates** — blank, node, python, rust (file-based with `template.json`)
- **49 unit tests** across 17 suites using `node:test` (zero deps)
- Service worker for PWA offline support

## [2.0.0] — 2026-02-15

### Added
- **Full v2 rewrite** — modular Node.js server, single-file rich UI
- Landing page with project cards, system stats, activity log
- Session wrapper with persistent banner and ttyd iframe
- Reverse proxy for ttyd (`/terminal/*`) to avoid cross-origin iframe issues
- tmux session management (list, kill, peek, send-keys)
- Per-project git info with caching
- macOS system stats (CPU, RAM, disk, uptime)
- Activity logging (JSON Lines)
- PWA manifest and icons
- Zero npm dependencies — stdlib only

## [1.0.0] — 2026-02-15

- Initial commit
