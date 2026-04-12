# Changelog

All notable changes to TangleClaw are documented in this file.

## [Unreleased]

### Fixed

- **Remove misleading PortHub warning from installer** — `deploy/install.sh` previously checked for standalone `porthub` and printed a yellow warning when not found, causing new users to think it was a missing dependency; PortHub was fully absorbed into TangleClaw — the standalone CLI check and its associated messages have been removed (fixes #59)

### Added

- **Document project version convention (#55, chunk 3)** — Added "Project Version Recording" section to CLAUDE.md global rules documenting the `.tangleclaw/project-version.txt` convention: file format, when to write (session start + wrap), detection order, and how TangleClaw reads it. Doc parity sweep confirmed no stale references in README or user-guide — existing "version badge" references are generic and still accurate. Completes #55.
- **Session-lifecycle version recording (#55, chunk 2)** — The engine-agnostic prime prompt now includes a "Project Version Recording" section instructing the AI to detect the project's current version at session start and write it to `.tangleclaw/project-version.txt`. The wrap protocol also includes a re-record step so the version is updated if it changed during the session (e.g., CHANGELOG bump or git tag). Both injections are methodology-agnostic — they apply to every methodology (prawduct, minimal, custom). This completes the write side of the version detection chain from chunk 1: the AI now populates the cache file that `enrichProject()` reads as its highest-priority source. 5 new tests (prime prompt section presence for both methodologies, wrap command version instruction for both methodologies, custom-command wrap branch coverage — added after Independent Critic review). 1424 total tests passing.
- **Harden #55 chunk 1 detection helpers (Critic follow-ups)** — Post-merge Independent Critic review of PR #57 surfaced several edge cases. All addressed: (1) UTF-8 BOM now stripped at the read boundary via a new `_readTextFileNoBom()` helper so files exported from Windows or certain editors don't break anchored regexes or `JSON.parse`; (2) CRLF line endings normalized to LF in the same helper so per-line regexes don't have to account for trailing `\r`; (3) `_readVersionJsonVersion` and `_readPackageJsonVersion` now require `typeof data.version === 'string'` AND a non-empty trimmed value, defensively rejecting `{"version": 123}`, `{"version": {}}`, and whitespace-only strings; (4) `_readVersionCacheFile` rejects whitespace-only version values (`version:    ` now correctly falls through to the next layer); (5) JSDoc drift fixed — cache file comment now says "Will be written" instead of implying a writer that doesn't exist yet; (6) redundant trailing `|| null` removed from the detection chain (dead code). 11 new tests covering BOM handling (all 4 readers), CRLF, non-string version field (number and object), missing/malformed version.json, whitespace-only cache value, and a dedicated layer-4 symmetry test. Live smoke-tested on the running server — Notse still returns `0.3.0` from CHANGELOG after the refactor. 1419 total tests passing.
- **Universal project version detection chain (#55, chunk 1)** — `enrichProject()` now detects the project's current version using a layered fallback chain instead of only reading root `package.json`. Order: (1) `.tangleclaw/project-version.txt` cache file (AI-recorded, highest priority — will be written by the session-lifecycle hook in chunk 2), (2) `CHANGELOG.md` first non-`[Unreleased]` version header (Keep-a-Changelog format), (3) `version.json` at root (TangleClaw convention), (4) `package.json` at root (existing logic, now layer 4), (5) `null`. Five new helper functions exposed on `projects` for unit testing: `_detectProjectVersion`, `_readVersionCacheFile`, `_readChangelogVersion`, `_readVersionJsonVersion`, `_readPackageJsonVersion`. CHANGELOG regex enforces version shape (`^v?\d+\.\d+`) so date-style headers like `## [2026-03-31]` are correctly rejected (some projects use date headers that would otherwise leak in as fake versions). Live impact on current projects: Notse now shows `0.3.0`, TangleClaw-v3 shows `3.12.7`, and projects with both CHANGELOG and package.json (OnDeck-V2, ScrapeGoat) now correctly prefer the more recent CHANGELOG entry. 14 new tests.
- **`tmux.js` regression-prevention test coverage** — `lib/tmux.js` previously had only structural tests (validation, error cases, history-limit). Added behavioral tests for the functions that physically deliver prompts to engines, where regressions silently break user experience: `sendKeys()` round-trip via real tmux sessions (text delivery, `enter:false` behavior, single-quote preservation, special shell characters `$` `` ` `` `\`, large >4KB multi-line payloads — covers the original 3.11.0 regression that motivated #23), `sendRawKey()` (behavioral Enter delivery + missing-session error case), and `killSession()` success path (return value + session removal); 9 new tests, 40 total in `test/tmux.test.js` (closes #23)

### Changed

- **Slimmer UI chrome across all pages** — Reduced vertical space consumed by headers, toolbars, and action buttons across the session banner, OpenClaw wrapper, and landing page; banner buttons shrunk from 44px to 30px (26px on desktop), back button from 44px to 32px, landing `.btn` from 44px to 32px, dash-bar and toolbar padding tightened, card rows from 44px to 34px min-height, logo and font sizes reduced proportionally; no functionality removed — same controls, just denser (fixes #51)

### Fixed

- **Session banner shows TangleClaw version instead of project version** — `loadVersion()` was fetching `/api/version` (TangleClaw's own version); now reads the project's `version` field from `enrichProject()`, which parses the project's `package.json`; projects without a `package.json` or version field show no version badge; 4 new tests (fixes #53)
- **Tmux status bar shows raw session internals** — Status bar previously showed bare `#{session_name}` (e.g. `TangleClaw-v3`) which was easily confused with the project name; now shows literal `TangleClaw` label on the left and `HH:MM  YYYY-MM-DD` on the right; canonical config moved to `deploy/tmux.conf` and installed to `~/.tmux.conf` by `deploy/install.sh` with backup of any existing file; install.sh also reloads tmux config in any running server so existing sessions update without restart; per-session `set-option` calls in `lib/tmux.js` updated to match (covers systems where the global config differs); 6-digit hex required by tmux 3.6+ (`#777` → `#777777`, `#333` → `#333333`); 2 new tests (fixes #53)

- **Status pill misses short incidents** — `_parseAtlassian()` only checked component status, which can revert to `operational` before the next poll; now also parses the `incidents[]` array from the Atlassian summary response and checks for unresolved incidents affecting the target component; uses the worse of component status vs. active incident impact; new `_parseAtlassianIncidents()` and `_incidentAffectsComponent()` helpers with component matching by ID and name; 10 new tests

## [3.12.7] - 2026-04-05

### Fixed

- **Orphan bare shell after session ends** — `ttyd-attach.sh` used `tmux new-session -A` which silently creates a new bare shell when the engine session is gone (wrap, kill, or crash); the orphan shell had no working directory (cwd `/`), inherited ttyd's restrictive launchd resource limits (`NumberOfFiles: 4096`), triggered `.zshrc` ulimit errors, and confused TangleClaw's `hasSession()` state tracking; replaced with `tmux has-session` guard + `tmux attach-session` so the script only attaches to existing sessions and shows a "session not running" message when the session is gone; 4 new tests (fixes #47)
- **Session launch feels frozen for ~6 seconds** — `launchSession()` blocked the API response while doing synchronous sleeps for `preKeyDelay` (3s), preKeys (1s), and `startupDelay` (2s); moved preKey and prime prompt injection to background timers via `_deferEngineInit()` so the API returns immediately after creating the tmux session; frontend launch button now shows "Launching…" with disabled state for instant visual feedback; user sees the terminal loading while the engine boots in the background
- **Codex sessions crash immediately on launch** — live engine profiles at `~/.tangleclaw/engines/` were never updated when bundled profiles gained new fields (e.g. `preKeys`, `preKeyDelay`, `startupDelay`); without `preKeys` the trust dialog wasn't dismissed, so the prime prompt injection selected "No, quit" and Codex exited; `_copyBundledFiles()` now deep-merges missing fields from bundled profiles into existing ones without overwriting user customizations; 4 new tests (fixes #47)

## [3.12.6] - 2026-04-05

### Fixed

- **Peek not working for alternate-screen engines (Codex, etc.)** — TUI-based engines like Codex run in tmux's alternate screen buffer, which has no scrollback history; `capture-pane -S - -E -` could fail or return empty content for these panes; `capturePane()` now detects alternate screen mode via `#{alternate_on}` and falls back to visible-only capture; new `isAlternateScreen()` helper in `tmux.js`; peek API response includes `alternateScreen` flag; frontend shows informational notice when peek content is screen-only (no scrollback); 4 new tests (fixes #44)

## [3.12.5] - 2026-04-05

### Added

- **Project archive/unarchive** — Projects can be archived (deactivated) from the landing page; archived projects are skipped by `syncAllProjects()` on boot, hidden from the main project list, and blocked from session launch; archived projects appear in a collapsed section at the bottom of the landing page with an "Unarchive" button; new API endpoints `POST /api/projects/:name/archive` and `POST /api/projects/:name/unarchive`; `store.projects.unarchive()` added; `listAllProjects()` excludes archived projects from the unregistered filesystem scan; 10 new tests (fixes #42)
- **Attach confirmation dialog** — Clicking "Attach" on an unregistered project card now shows a confirmation modal explaining what will happen (scaffold config, generate engine files, sync on boot) before registering the project; prevents accidental project registration

### Fixed

- **Session launch blocked for archived projects** — `launchSession()` now returns an error if the project is archived, with a message to unarchive first

## [3.12.4] - 2026-04-04

### Changed

- **Slim session prime prompt** — Removed full methodology playbook from the prime prompt injected into the terminal at session start; the playbook is already in the engine config (CLAUDE.md) which the AI reads automatically; prime prompt now shows only: session header, methodology name, current phase, last session summary, active learnings, and extension rules — reducing terminal output from ~50+ lines to ~10-15 lines (fixes #40)

## [3.12.3] - 2026-04-04

### Fixed

- **Wrap button completes wrap but doesn't kill session or clear banner** — Wrap completion relied solely on idle detection (3 consecutive polls with stable terminal output), which could fail silently if captured output fluctuated; added server-side wrap timeout (120s) that force-completes wrapping sessions via `getSessionStatus`; added frontend fallback timeout (120s) in `showWrappingState()`; guarded `completeWrapFromIdle()` against re-entry with `wrapCompleting` flag; all timeouts cleaned up in `handleWrapCompleted` and `handleSessionEnded`; 6 new tests (fixes #28)

## [3.12.2] - 2026-04-04

### Added

- **Session Memory** — File-based, per-project memory system that persists context across AI sessions; `.tangleclaw/memories/MEMORY.md` created automatically on project init; session memory guide injected into all engine configs (Claude, Codex, Aider, Gemini) telling the AI to read and update memory files; engine-agnostic — works with any AI that can read files and follow instructions; 4 new tests (fixes #36)
- **Startup project sync** — `syncAllProjects()` runs on every server boot: regenerates all engine configs and backfills scaffolding (like `.tangleclaw/memories/`) for existing projects; ensures code changes (new guides, updated rules) are reflected immediately across all projects without waiting for session relaunch; 3 new tests

## [3.12.1] - 2026-04-04

### Added

- **Peek search** — Search bar in peek drawer with live case-insensitive matching, match highlighting (`<mark>` spans), next/prev navigation (buttons + Enter/Shift+Enter), match counter ("3 of 42"), Cmd/Ctrl+F keyboard shortcut when peek is open, Escape to close; performance-guarded rendering limits DOM highlights to 1000 around the active match for large buffers; 4 new tests

### Fixed

- **Session wrap notes not picked up by next session** — Added "Session Start" section to Prawduct playbook instructing agents to glob for all `build-plan*.md` files (not just `build-plan.md`) and surface incomplete chunks; updated wrap instructions to specify updating build plan files with ✅/⬜ markers as the handoff mechanism; 2 new regression tests (fixes #33)

## [3.12.0] - 2026-04-04

### Added

- **Full scrollback peek** — Peek drawer now shows the entire terminal scrollback history instead of the last 50 lines; tmux sessions are created with `history-limit 50000`; `capturePane()` supports `full: true` for full buffer capture (`-S - -E -`); peek API accepts `full=true` query param; frontend strips ANSI escape codes, auto-scrolls to bottom, supports sticky scroll (unlocks on scroll-up, re-locks at bottom), and has Jump to Top/Bottom buttons (fixes #26)

### Fixed

- **Light mode only changes splash screen, not terminal shell** — `applyTheme()` in `session.js` now propagates theme colors to the xterm.js terminal instance inside the ttyd iframe via `term.options.theme`; added xterm theme palettes for dark, light, and high-contrast modes; terminal theme is applied on iframe load (with retry for async xterm init) and on theme change; `.terminal-frame` background changed from hardcoded `#000` to `var(--bg)` (fixes #30)

## [3.11.5] - 2026-04-03

### Fixed

- **Prime prompt pastes but doesn't submit on session start** — `sendKeys()` now uses tmux `load-buffer`/`paste-buffer` for reliable delivery of large text (properly triggers bracketed paste mode), with a 500ms delay before sending Enter to let the terminal process the paste; the previous `send-keys -l` approach sent characters too fast for Claude Code to process before Enter arrived

## [3.11.4] - 2026-04-03

### Fixed

- **Kill button shows generic "Check password" instead of actual error** — session view's `confirmKill()` used `apiMutate()` which swallowed server error messages and showed a hardcoded string; now uses direct `fetch` (matching the landing page pattern) to display the actual error from the server (e.g. "Password required" vs "Incorrect password")

## [3.11.3] - 2026-04-03

### Fixed

- **Methodology playbook missing from engine config files** — `_generateClaudeMd`, `_generateCodexYaml`, `_generateAiderConf`, and `_generateGeminiMd` now inject the full playbook content (not just methodology name and description), matching what `generatePrimePrompt()` already does
- **Bundled template sync skips new files in existing directories** — `_copyBundledTemplates()` now syncs missing files into existing template directories instead of skipping the entire directory; this fixes the case where `playbook.md` was added to bundled templates but never copied to installations that already had the template directory
- **`getPlaybook()` falls back to bundled templates** — if a playbook is missing from the user's `~/.tangleclaw/templates/` directory, it now checks the bundled `data/templates/` directory as a fallback, ensuring playbook injection works reliably even before the sync runs
- 7 new tests: playbook injection for Claude/Gemini/Codex/Aider generators and cross-engine parity

## [3.11.2] - 2026-04-02

### Fixed

- **Polling burst storm on tab refocus crashes system** — replaced all `setInterval` polling in `session.js`, `openclaw-view.js`, and `landing.js` with `setTimeout` chains that don't queue callbacks when browser tabs are backgrounded; added `visibilitychange` listener to pause/resume session page polling when tabs are hidden/shown. Previously, backgrounding a session tab for ~60s caused ~35 queued interval callbacks to fire simultaneously on refocus, hammering the server with rapid tmux shell commands and overwhelming the system (fixes #19)

## [3.11.1] - 2026-04-02

### Fixed

- **Prime prompt no longer fires before Claude engine is ready** — added explicit `startupDelay: 2000` to Claude engine profile, bumped default fallback from 500ms to 1500ms (fixes #17)

## [3.11.0] - 2026-04-02

### Added

- **Methodology playbook injection in prime prompt** — `generatePrimePrompt()` now reads and injects `playbook.md` from methodology template directories, giving engines full operational procedures instead of just the methodology name and phase labels (fixes #14)
- **Extension rule definitions in prime prompt** — `defaultRules` in `template.json` now supports object form with `enabled` and `definition` fields; active rules are rendered with their definitions in the prime prompt
- **Prawduct playbook** — new `data/templates/prawduct/playbook.md` covering session discipline (one chunk per session), phase procedures (Discovery/Planning/Building), Independent Critic review protocol, Janitor Pass, and Decision Framework
- **Prawduct rule definitions** — `independentCritic`, `docsParity`, and `decisionFramework` now include concrete definitions explaining what each rule requires in practice
- 7 new tests: store `getPlaybook` (3), prime prompt playbook injection (2), rule definitions (2)

## [3.10.2] - 2026-04-02

### Fixed

- **Select button now works for projects with spaces/special characters in name** — mouse toggle API endpoints now normalize project names via `toSessionName()` before passing to tmux, matching the sanitized tmux session name (e.g., "TiLT v2" → "TiLT-v2") (fixes #12)

## [3.10.1] - 2026-03-31

### Fixed

- **Main page banner now stays fixed while content scrolls** — matches behavior of session and OpenClaw pages (body flex layout + scrollable content wrapper)

## [3.10.0] - 2026-03-30

### Changed

- **Unbundle Prawduct tools — methodology is now a separate install**
  - Removed bundled `tools/product-hook`, `tools/prawduct-setup.py`, `tools/prawduct-init.py`, `tools/prawduct-sync.py`, `tools/prawduct-migrate.py` — Prawduct is now installed separately from [brookstalley/prawduct](https://github.com/brookstalley/prawduct)
  - Updated `template.json` hooks from `{{TANGLECLAW_DIR}}/tools/product-hook` to `$CLAUDE_PROJECT_DIR/tools/product-hook` — matches Prawduct v1.3.0 native hook resolution
  - Removed `SessionEnd` hook (removed upstream in Prawduct v1.2.3 — it dirtied the repo after commit)
  - Added `statusMessage` fields to hooks (Prawduct v1.3.0 convention)
  - TangleClaw detects and orchestrates Prawduct projects; Prawduct owns its own tools
  - 1 new test (1313 → 1314): `$CLAUDE_PROJECT_DIR` passthrough verification

- **Critic review fixes for public release**
  - Replaced personal infrastructure values (IPs, hostnames, SSH keys) with generic placeholders across docs, HTML, and 9 test files
  - Added macOS-only platform requirement to README header and prerequisites
  - Moved Prerequisites before Quick Start for better onboarding flow
  - Removed BitchBoard from roadmap (separate project), added Linux support to roadmap
  - Clarified Genesis engine as "persistent agent placeholder"
  - Removed methodology-extractions/ from published files (internal research notes)
  - Cleaned eval-audit-mode.md build metadata and TODO section
  - Renamed OPENCLAW-SETUP.md → openclaw-setup.md for consistent naming
  - Fixed port number documentation (clarified code defaults vs launchd overrides)
  - Replaced "habitat infra" examples with generic "backend services" across docs

- **Documentation overhaul for public release**
  - README: updated project structure (added 8 missing lib/ files, OpenClaw viewer, setup.js; removed bundled tools/), updated architecture diagram with SSH tunnels and OpenClaw proxy, added Sidecar and Eval Audit to features, added Prawduct as optional prerequisite with repo link, added BitchBoard and Sidecar controls to roadmap, removed "private repository" notice, added Eval Audit Mode to docs index
  - User Guide: fixed clone URL to `github.com/Jason-Vaughan/TangleClaw`, fixed all port references (3101→3102 for server, 3100→3101 for ttyd)
  - Methodology Guide: added [Prawduct](https://github.com/brookstalley/prawduct) repo link, documented separate install model, added hooks documentation with `$CLAUDE_PROJECT_DIR` resolution
  - Engine Guide: added OpenClaw engine section (SSH and Web UI modes, connection registry, sidecar), updated engine count to six
  - Configuration Reference: updated schema version 2→12, added 7 missing tables, expanded API from 29→62 endpoints organized by category (core, projects, sessions, ports, groups, shared docs, OpenClaw, sidecar, eval audit), added HTTPS config fields
  - OpenClaw Setup: updated version requirement to v3.10.0+, added Bridge Port/Token fields, added Sidecar section
  - Prawduct extraction doc: updated to reference external repo, removed local path references

## [3.9.5] - 2026-03-30

### Added

- **Sidecar bridge integration: direct ClawBridge polling**
  - Schema v11: added `bridge_port` column to `openclaw_connections` (default 3201)
  - Updated `_rowToConnection()`, `create()`, `update()` to handle `bridgePort` field
  - Sidecar `pollProcesses()` now polls `bridgePort` instead of `localPort` — hits ClawBridge directly instead of the OpenClaw gateway
  - Tunnel manager `ensureTunnel()` accepts `extraForwards` array — SSH tunnel now forwards both gateway port (18789) and bridge port (3201) in a single connection
  - Updated `launchWebuiSession()` and direct-connect tunnel route to pass bridge port as extra forward
  - Bridge Port field added to connection modal in UI (`index.html`, `ui.js`)
  - **ClawBridge side** (RentalClaw-Project): added `GET /api/processes` endpoint to `bridge/server.js` — returns active and recently completed background runs with process registry tracking
  - 2 new tests (1311 → 1313): bridgePort update (1), schema migration bridge_port column (1); plus bridgePort assertions added to existing create tests and 4 schema version assertions updated to v11

## [3.9.4] - 2026-03-30

### Added

- **Sidecar: Chunk 5 — Pills + detail panel in OpenClaw viewer**
  - Sidecar pills container in `openclaw-view.html` banner (between banner-row and terminal viewport)
  - Sidecar detail panel markup: backdrop, aside panel, nav bar, detail container, refresh/close buttons
  - `openclaw-view.js` — full sidecar UI wired to connection-based API:
    - `pollSidecarProcesses()` — polls `GET /api/sidecar/connection/:connId/processes` every 10s after tunnel is up
    - `renderSidecarPills(processes, stale)` — status-colored pills with dot, label, elapsed time
    - `openSidecarPanel(processId)` / `closeSidecarPanel()` — slide-in detail panel with backdrop
    - `renderSidecarDetail()` — full process detail: status badge, type, project, workDir, timestamps, duration, exit code, signal, attention flags, last output snippet
    - `autoSelectProcess(processes)` — selects first attention-needing, then first active, then first process
    - `formatElapsed(startedAt, completedAt)` / `formatTimestamp(iso)` — time display helpers
    - `sidecarStatusClass(proc)` — maps status to pill CSS class
    - `sidecarField(label, valueHtml)` / `escapeHtml(str)` — rendering helpers
    - `initSidecar()` — wires close, backdrop, refresh, pill click, and nav click event listeners
    - `startSidecarPolling()` / `stopSidecarPolling()` — polling lifecycle
  - Process nav bar for switching between multiple processes
  - Pill click opens detail panel for that process
  - Panel auto-updates on each poll cycle when open
  - All CSS reused from shared `session.css` — no new styles
  - 27 new tests (1284 → 1311): HTML structure (8), JS functions (16), connection-based polling API (3)

## [3.9.3] - 2026-03-30

### Changed

- **Sidecar: Chunk 4 — Strip from session page, add connection-based API**
  - Removed all sidecar code from `session.js` and `session.html` — sidecar is for OpenClaw direct-connect sessions only, not project sessions
  - Removed: `isOpenClawProject()`, `pollSidecarProcesses()`, `sidecarStatusClass()`, `formatElapsed()`, `renderSidecarPills()`, `startSidecarPolling()`, `stopSidecarPolling()`, sidecar detail panel functions, sidecar pills container, sidecar panel markup
  - Kept: all sidecar CSS in `session.css` (shared with `openclaw-view.html`), webui banner scroll fix
  - Added `getProcessesByConnection(connId)` to `lib/sidecar.js` — direct connection lookup without project resolution
  - Added `GET /api/sidecar/connection/:connId/processes` API route — polls by connection ID for direct-connect sessions
  - Updated `syncPolling()` to also start polling for connections with active tunnels (`oc-direct-*`), not just project engine sessions
  - Tests updated: 1304 → 1284 (removed 52 misplaced session-page assertions, added 32 for connection-based API + absence checks)

## [3.9.2] - 2026-03-29

### Added

- **Sidecar: OpenClaw Process Visibility — Chunk 3: Detail Panel**
  - Sidecar detail panel (slide-in drawer from bottom, mirrors peek drawer pattern)
  - `openSidecarPanel(processId)` / `closeSidecarPanel()` — open/close with backdrop
  - `autoSelectProcess()` — selects first attention-needing, then first active, then first process
  - `renderSidecarDetail()` — renders full process detail: status badge, type, project, workDir, timestamps, duration, exit code, signal
  - `formatTimestamp(iso)` — formats ISO timestamps for display
  - `sidecarField(label, valueHtml)` — builds detail field rows
  - Process nav bar when multiple processes — clickable buttons with status dots
  - Attention flags: "Waiting for Input", "Suspected Stalled", "Needs Attention" pills
  - Last output snippet in monospace pre block (auto-refreshes on poll)
  - Pill click handler: clicking a sidecar pill opens the detail panel for that process
  - Refresh button: manual re-poll and re-render
  - `pollSidecarProcesses()` now caches processes and auto-updates panel when open
  - CSS: `.sidecar-panel`, `.sidecar-panel-header`, `.sidecar-detail`, `.sidecar-nav`, `.sidecar-field`, `.sidecar-status-badge--*`, `.sidecar-flags`, `.sidecar-output`, clickable pill cursor
  - 29 new tests (1275 → 1304): HTML structure (5), CSS styles (9), JS functions (15)

### Fixed

- **OpenClaw webui session layout** — terminal viewport iframe now uses `position: absolute; inset: 0` with `overflow: hidden` on viewport container, preventing the banner from scrolling off-screen when OpenClaw UI content is taller than the viewport

## [3.9.1] - 2026-03-29

### Added

- **Sidecar: OpenClaw Process Visibility — Chunk 2: Frontend Process Pills**
  - `sidecarPills` container in session header between banner-row and banner-actions
  - `pollSidecarProcesses()` — polls `/api/sidecar/:project/processes` every 10s for OpenClaw sessions
  - `isOpenClawProject()` — detects OpenClaw engine from project data
  - `sidecarStatusClass(proc)` — maps process status to pill color class (running=green, quiet=yellow, failed=red, completed=gray)
  - `formatElapsed(startedAt, completedAt)` — human-readable elapsed time (45s, 2m, 1h 3m)
  - `renderSidecarPills(processes, stale)` — renders status-colored pills with dot, label, elapsed time
  - `startSidecarPolling()` / `stopSidecarPolling()` — lifecycle management, auto-starts for OpenClaw sessions
  - Attention badge: amber count pill when processes have `needsAttention` flag
  - Stale data indicator when poll cache is outdated
  - `sidecar-pill--attention` pulse animation for processes needing attention
  - Sidecar polling stops on session end and wrap completion
  - CSS: `.sidecar-pills`, `.sidecar-pill`, `.sidecar-pill--running/quiet/completed/failed`, `.sidecar-pill--attention`, `.sidecar-attention-badge`, `.sidecar-stale-badge` with mobile responsive breakpoint
  - 23 new tests (1252 → 1275): HTML structure (3), CSS styles (10), JS functions (10)

## [3.9.0] - 2026-03-29

### Added

- **Sidecar: OpenClaw Process Visibility — Chunk 1: Backend Polling Infrastructure**
  - `lib/sidecar.js` — polls OpenClaw's `/api/processes` through SSH tunnel, caches state per connection
  - `pollProcesses(connectionId)` — fetches active/recent background processes from ClawBridge
  - `getProcesses(connectionId)` / `getProcessesForProject(projectName)` — returns cached state with stale detection
  - `startPolling()` / `stopPolling()` / `syncPolling()` — manages per-connection polling intervals (default 10s)
  - Graceful degradation: stale cache preserved on connection failure
  - `GET /api/sidecar/:project/processes` — API endpoint for frontend to consume process state
  - Auto-starts polling on server startup for OpenClaw connections with active sessions
  - 17 new tests (1235 → 1252): resolveConnectionId (3), getProcesses (4), getProcessesForProject (2), pollProcesses (3), polling lifecycle (3), syncPolling (2)

### Fixed

- **Prevent duplicate port leases for OpenClaw tunnels** — `ensureTunnel()` now checks for existing leases before registering, avoiding conflicts when both a project session and a direct-connect use the same tunnel port (e.g., RentalClaw + oc-direct on port 18789)
- **Import banner no longer flags OpenClaw tunnels** — `checkPortImports()` in the landing page now recognizes `oc-direct-*` lease names as belonging to known OpenClaw connections instead of showing them as unregistered projects

## [3.8.3] - 2026-03-27

### Fixed

- **Engine configs now use correct HTTPS protocol** — all generated engine configs (CLAUDE.md, GEMINI.md, Codex YAML, Aider conf) now emit `https://` when HTTPS is enabled instead of always using `http://`; fixes API calls failing with "empty reply from server" in projects like BiTCH

## [3.8.2] - 2026-03-24

### Added

- **PID file guard against duplicate server instances** — prevents multiple TangleClaw servers from running simultaneously
  - `lib/pidfile.js` — PID file management module: `check()` detects live instances (handles stale PID files from crashes), `write()` records PID on startup, `remove()` cleans up on shutdown
  - Startup guard in `server.js` — checks for existing instance before binding, exits with clear error message if duplicate detected
  - EADDRINUSE handler — gracefully exits instead of crashing if port is already bound (prevents launchd restart loops)
  - PID file cleaned up on graceful shutdown (SIGTERM/SIGINT) and on EADDRINUSE exit
  - Stale PID files from crashed processes are auto-cleaned on next startup
  - 11 new tests (1224 → 1235): write/readPid (3), check logic (4), remove (2), isProcessAlive (2)

## [3.8.1] - 2026-03-24

### Fixed

- **OpenClaw tunnel kill/cleanup from UI** — Stale SSH tunnels (e.g. from server restarts or crashed sessions) can now be detected and killed directly from the OpenClaw connection panel
  - `detectTunnel(localPort, host)` — finds SSH tunnel processes by port regardless of in-memory tracking (survives server restarts)
  - `killTunnelByPort(localPort, host)` — kills SSH tunnel by port, cleans up PortHub lease and in-memory tracking
  - `ensureTunnel()` now returns PID when tunnel is already up, re-tracks untracked tunnels in memory, and supports `force` option to auto-kill stale tunnels before spawning fresh ones
  - `GET /api/openclaw/connections/:id/tunnel` — tunnel status endpoint (active, connectable, PID, tracked)
  - `DELETE /api/openclaw/connections/:id/tunnel` — kills tunnel for a connection (tracked + port-based + project-scoped), marks associated webui sessions as killed
  - Connection cards show tunnel status badge with port and PID when active, with a "Kill Tunnel" button and confirmation dialog
  - Session launch returns 409 `TUNNEL_CONFLICT` with `staleTunnel` info when port is blocked by a stale tunnel (instead of generic 500)
  - `POST /api/sessions/:project` and `POST /api/openclaw/connections/:id/tunnel` accept `force: true` to auto-kill stale tunnels
  - Kill session modal text is now mode-aware ("tears down the SSH tunnel" for webui, "terminates the tmux session" for tmux)
  - CSS: `.oc-tunnel-status`, `.badge-tunnel-active`, `.oc-tunnel-detail` styles
  - 10 new tests (1214 → 1224): detectTunnel (2), killTunnelByPort (2), ensureTunnel force (1), _findSshPidByPort (1), API tunnel status/kill (4)

## [3.8.0] - 2026-03-24

### Added

- **Eval Audit Mode — Chunk 5: Bidirectional Scoring, Cost Cap, Retention, UI + Polish (Feature Complete)**
  - **Bidirectional (human-side) scoring** — `validateHumanScore()` validates 1-5 scale submissions; `POST /api/audit/:project/scores/:id/human` endpoint stores human score, comment, and timestamp on any score record. Schema v10 migration adds `human_score`, `human_comment`, `human_scored_at` columns to `eval_scores`
  - **Cost cap enforcement** — `checkCostCap()` checks accumulated session cost against `costCapPerSession` config (default $1.00/session). Ingest handler skips paid scoring tiers when cap exceeded, stores Tier 1 only (free), returns `reason: 'cost_cap_exceeded'`. `getSessionCost(sessionId)` store method aggregates cost across session exchanges
  - **Retention policy** — `runRetentionPolicy(store, retentionDays)` purges exchanges and cascading scores older than the configured window (default 90 days). `purgeOlderThan(cutoffDate)` store method deletes scores first (FK dependency) then exchanges. Runs automatically on server startup; manual trigger via `POST /api/audit/retention/run`
  - **evalDimensions validation** — `validateTemplate()` in `lib/methodologies.js` now validates `evalDimensions` field: schemaVersion required, tier1 checks must be `"pattern"` type with patterns array, tier2 entries need id+description, tier3 entries require `when` field from valid set (always, execution_task, disagreement, high_stakes, multi_user, implementation_task, code_change)
  - **Startup banner** — `generatePrimePrompt()` adds "Eval Audit Mode: Active" section when enabled, showing judge model, tiers, sampling config, cost cap, and open incident count. Gives the agent visibility that it's being evaluated
  - **Project card audit badge** — `enrichProject()` exposes `evalAudit: { enabled, openIncidents }`. Project cards show green "Audit" badge with incident count pill when audit is active
  - **Dashboard audit panel** — Expandable "Audit" panel in landing page header with incident count badge. Panel shows summary table per audit-enabled project: exchange count, scored count, anomalies, open incidents. Loads summaries on first open
  - CSS: `.badge-audit`, `.audit-dot`, `.badge-anomaly`, `.audit-panel`, `.audit-summary-table` styles
  - 28 new tests (1186 → 1214): human score store CRUD (2), session cost aggregation (2), retention purge (2), validateHumanScore (7), checkCostCap (3), runRetentionPolicy (2), evalDimensions validation (5), API endpoints (human score 3, retention 1, cost cap ingest 1)

### TODO

- **Manual integration testing of Eval Audit Mode (v3.4.0–v3.8.0)** — All 5 chunks have unit/API tests but need end-to-end verification against a live OpenClaw instance. See `build-plan-eval-audit.md` verification checklists (Phase 1 items 1-6, Phase 2 items 1-6) for the full test plan.

## [3.7.0] - 2026-03-24

### Added

- **Eval Audit Mode — Chunk 4: Baselines + Drift Detection + Incidents**
  - `eval_incidents` table (CREATE TABLE IF NOT EXISTS in schema v9) with project index. Store namespace `evalIncidents` with insert, get, list (filterable by status/type), update, and countByStatus methods
  - `computeBaseline(project, store, options)` — computes per-tier averages and standard deviations from historical scores within a configurable window (default 14 days). Stores baseline via `evalBaselines.insert()` with anomaly rate tracking
  - `detectDrift(project, store, options)` — compares recent daily score averages against latest baseline. Flags drift when 3+ consecutive days deviate >1σ from baseline on any tier. Returns per-tier drift details with direction, deviation amount, and baseline reference
  - `generateIncidents(project, store, options)` — orchestrates drift detection and anomaly spike detection. Creates typed incidents (`drift`, `anomaly_spike`) with severity levels (`warning` for >1σ, `critical` for >2σ). Deduplicates against existing open incidents to prevent duplicates on re-runs
  - `POST /api/audit/:project/baseline/recompute` endpoint — triggers baseline recomputation with optional window parameter
  - `GET /api/audit/:project/incidents` endpoint — lists incidents with optional status/type/limit filtering
  - `GET /api/audit/:project/incidents/:id` endpoint — fetches single incident with project ownership validation
  - `PUT /api/audit/:project/incidents/:id` endpoint — accept/dismiss workflow with status validation, auto-sets resolvedAt/resolvedBy
  - Debounced auto-incident generation in ingest handler — runs `generateIncidents()` max once per 60 seconds per project after async scoring pipeline completes
  - 24 new tests (1162 → 1186): store CRUD (8), computeBaseline (3), detectDrift (4), generateIncidents (3), API endpoints (6)

## [3.6.0] - 2026-03-24

### Added

- **Eval Audit Mode — Chunk 3: Tier 2.5 + Wrap Quality + Trends API**
  - Tier 2.5 thinking block analysis — LLM judge compares agent thinking vs output for reasoning-output alignment (0.0-1.0), sycophancy detection, and advocacy suppression. Skips when no thinking block is available. Integrates into scoring pipeline between Tier 2 and Tier 3
  - `buildTier2_5JudgePrompt()` — specialized system prompt for thinking-vs-output comparison (fixed task, no configurable dimensions)
  - `scoreTier2_5()` — async LLM judge call with same DI pattern as Tier 2/3, returns alignment score + sycophancy/suppression flags
  - Tier 2.5 gate cascade integration — sycophancy or advocacy suppression detected forces Tier 3 (same escalation as Tier 2 flag)
  - Session wrap quality scoring — `scoreWrapQuality()` pattern-matches session-end exchanges against methodology `wrap.steps` (version-bump, changelog-update, learnings-capture, next-session-prime, commit). Free structural check, no LLM call
  - `aggregateTrends()` — groups score records by day with per-day averages for all tiers, anomaly counts, and exchange counts. Supports configurable time windows (7d, 14d, 30d)
  - `GET /api/audit/:project/trends` endpoint — returns daily trend data points with window parameter
  - `GET /api/audit/:project/wrap-quality` endpoint — returns wrap quality scores for recent sessions with methodology-aware step checking
  - `evalExchanges.listSessions()` store method — distinct sessions by project with exchange counts and timestamp ranges
  - Tier 2.5 fields now populated in async ingest pipeline (were previously null placeholders)
  - `evalDimensions` added to Prawduct methodology template — governance-focused: decision_framework_adherence (Tier 2), independent_thinking + methodology_compliance (Tier 3), Prawduct-specific judge context
  - `evalDimensions` added to TiLT methodology template — identity-focused: identity_consistency (Tier 2), identity_sentry_compliance + trust_signal_accuracy (Tier 3), TiLT-specific judge context
  - 20 new tests (1142 → 1162): Tier 2.5 scoring (4), wrap quality (5), trends aggregation (3), pipeline integration (2), store listSessions (2), API endpoints (3), prompt builder (1)

## [3.5.0] - 2026-03-24

### Added

- **Eval Audit Mode — Chunk 2: Tier 2/3 Scoring + Gate Cascade**
  - Tier 2 semantic scorer — LLM judge call (Haiku-class) for scope compliance and information completeness. Returns 0.0-1.0 scores per dimension with reasoning
  - Tier 3 behavioral dimensional scorer — LLM judge scoring 1-5 per applicable dimension with methodology-specific filtering via `when` field (always, execution_task, disagreement, high_stakes, code_change)
  - Judge prompt assembly — `buildJudgePrompt()` constructs system prompts from methodology `judgeContext` + dimension definitions, with tier-specific scoring instructions
  - `callJudge` with dependency injection — default implementation calls Anthropic Messages API via Node `https`; accepts injectable function for testability
  - Gate cascade cost optimization — Tier 1 fail → run all tiers; routine pass → Tier 2 only; Tier 2 flag → escalate to Tier 3; cascade togglable via `gateCascade` config
  - `isRoutine()` classifier — determines if an exchange is routine based on turn number, sampling reason, and disagreement patterns
  - Cost tracking — `estimateCost()` calculates USD cost from token usage with Haiku/Sonnet pricing tiers
  - `runScoringPipeline()` — orchestrates full Tier 1→2→3 cascade with error handling, cost accumulation, and tier tracking
  - Async pipeline in ingest handler — Tier 1 scored synchronously, Tier 2/3 run asynchronously after response. Score record updated with pipeline results via new `evalScores.update()`
  - `evalScores.update()` store method — updates Tier 2/3 fields, anomaly flags, cost, and judge model on existing score records
  - Markdown-fenced JSON parsing tolerance in judge response parser
  - 25 new tests (1117 → 1142): judge prompt assembly, Tier 2 scoring with mock judge, Tier 3 dimensional scoring with dimension filtering, cost estimation, routine classification, gate cascade (6 scenarios), store update, error handling

## [3.4.0] - 2026-03-24

### Added

- **Eval Audit Mode — Chunk 1: Capture + Storage Foundation**
  - SQLite schema v9: `eval_exchanges`, `eval_scores`, `eval_baselines` tables with full indexes
  - `audit_secret` column on `openclaw_connections` for webhook authentication
  - Store namespaces: `evalExchanges`, `evalScores`, `evalBaselines` with full CRUD + query APIs
  - `POST /api/audit/ingest` webhook endpoint — receives exchange data from OpenClaw, validates Bearer token auth, stores exchanges, runs Tier 1 scoring inline
  - Tier 1 structural scorer (free, pattern matching) — self-identification denial, silent refusal, constraint disclosure without reasoning. Methodology-aware via `evalDimensions.tier1`
  - Intelligent sampling — always scores first 5 turns, last 3 turns, disagreement, long responses, Tier 1 flags; samples every Nth routine exchange; skipped exchanges stored for retroactive scoring
  - Heartbeat watchdog — monitors data flow per active audit session, escalating alerts at 1/2/3 missed intervals
  - Per-exchange anomaly detection — flags Tier 1 failures, Tier 3 low scores, Tier 2.5 divergence
  - Query API endpoints: `GET /api/audit/:project/scores`, `/anomalies`, `/summary`, `/baseline`
  - Telemetry endpoints: `POST /api/audit/heartbeat`, `GET /api/audit/telemetry`
  - `evalAuditMode` added to `DEFAULT_PROJECT_CONFIG` with full configuration schema
  - Default eval dimensions fallback for methodologies without `evalDimensions`
  - 63 new tests (store CRUD, Tier 1 scorer, sampling logic, heartbeat, API integration)

## [3.3.0] - 2026-03-23

### Changed

- **README rewrite**: New intro section tells the origin story — persistent sessions solving dropped VPN/SSH connections — instead of leading with a feature matrix. Added OpenClaw integration to the features list and OpenClaw Setup to the documentation links.
- **Prawduct framework tools updated**: Synced `product-hook` and all framework tools from upstream Prawduct. Major changes: `prawduct-sync.py`, `prawduct-init.py`, and `prawduct-migrate.py` are now shims delegating to new unified `prawduct-setup.py` (92KB). `product-hook` adds session-end sync (quiet framework sync at session end so hot files are fresh for next session), bootstrap support for repos without manifests, and cleaner sync output formatting. Template updated with `SessionEnd` hook event.
- **Eval Audit Mode spec v2**: Rewrote `tangleclaw-eval-audit-mode.md` in shared docs. Major additions: methodology-aware scoring dimensions (not Genesis-only), webhook push capture with heartbeat watchdog (tmux parsing dropped), thinking block analysis (Tier 2.5), intelligent sampling, auto-incident generation from anomalies, SQLite from day 1, bidirectional scoring, session wrap quality scoring, silent drift detection via automatic baselines, schema versioning for dimension changes.
- **Eval Audit Mode build plan**: 8-chunk implementation plan (`build-plan-eval-audit.md`). ~142 new tests planned across schema, ingest, 4-tier scoring pipeline, query APIs, heartbeat/telemetry, baselines/drift detection, and bidirectional scoring.
- **PortHub schema v8**: host column on port_leases table (composite PK), host-aware lease/release/heartbeat, test version assertions updated.

### Added

- **Methodology extractions directory** (`docs/methodology-extractions/`): New directory for dissecting organic methodologies from existing projects into structured, reproducible patterns. Groundwork for TangleMeth.
  - **TiLT v2 extraction** (`tilt-v2.md`): 10 patterns — identity sentries, session wraps, learning capture, data safety, PROD/DEV separation, doc parity, testing mandates, decision frameworks, mobile parity, anti-bloat rules. Enforcement analysis (prose vs gates).
  - **OnDeck-V2 extraction** (`ondeck-v2.md`): 3 unique patterns — critical incidents log (failures → prevention rules feedback loop), AI config sync system (single source of truth for multi-engine rules), session priming files (dedicated next-session planning with timestamp discipline).
  - **Prawduct reference** (`prawduct.md`): Not extracted — Prawduct is already a designed framework (13,400 lines, Python tools, 27 templates, agent definitions). Referenced as TangleMeth's target output rather than dissected.

## [Unreleased]

### Fixed

- **PortHub: bogus per-project ttyd registration removed**: Project creation no longer registers the global ttyd port (3100) under each project's name, which was overwriting TangleClaw's infrastructure lease on every create
- **PortHub: OpenClaw tunnel ports now tracked**: `ensureTunnel()` registers the local port with PortHub (24h TTL), `killTunnel()` releases it — tunnel ports are now visible in `GET /api/ports`
- **PortHub: port conflict check on OpenClaw connections**: Creating or updating an OpenClaw connection now checks `localPort` against PortHub and returns 409 if the port is already in use
- **PortHub: connection delete releases port and kills tunnel**: Deleting an OpenClaw connection now releases its port lease from PortHub and kills any active standalone tunnel
- **PortHub: orphan cleanup recognizes OpenClaw connections**: `_cleanupOrphanLeases()` no longer removes port leases registered under `oc-direct-<id>` patterns when the corresponding OpenClaw connection still exists

### Added

- **OpenClaw engine build plan**: Designed and documented full implementation plan for OpenClaw as a new engine type. Two-tier architecture: connection registry (define OpenClaw instances independently) + engine integration (optionally expose as AI engine in project create wizard). Two connection modes: SSH (tmux-based) and Web UI (iframe-based). 6 session chunks planned. See `build-plan.md`.
- **OpenClaw connection registry — backend** (Chunk 1/6): Schema v5 migration adds `openclaw_connections` table. Full CRUD store methods (`store.openclawConnections.list/get/create/update/delete`) with validation, name uniqueness, and activity logging. API routes: `GET/POST /api/openclaw/connections`, `GET/PUT/DELETE /api/openclaw/connections/:id`, `POST /api/openclaw/test` (SSH + gateway health check). 36 new tests (961 total).
- **OpenClaw connection registry — frontend** (Chunk 2/6): "OpenClaw" button in dashboard bar with expandable connections panel. Connection list shows name, host:port, engine badge, and expandable detail grid (SSH user, key path, CLI command, local port). Add/Edit modal with all connection fields, "Test Connection" button (shows SSH/gateway status inline), "Available as Engine" toggle, and delete confirmation. 11 new tests (972 total).
- **OpenClaw engine integration + SSH launch** (Chunk 3/6): OpenClaw connections with `availableAsEngine` now appear as virtual engines in the engine dropdown under an "OpenClaw" optgroup category. Engine ID format: `openclaw:<connectionId>`. `_buildLaunchCommand()` builds SSH command from connection config (`ssh -t -i <key> <user>@<host> "<cliCommand>"`). `enrichProject()` resolves OpenClaw engine names and capabilities from the connection registry. Wrap button hidden for engines without `supportsPrimePrompt`. New `data/engines/openclaw.json` base engine profile (remote, no config file, no prime prompt). 20 new tests (992 total).
- **Tunnel manager + schema v6** (Chunk 4/6): New `lib/tunnel.js` — lightweight SSH tunnel manager with no npm dependencies. `ensureTunnel()` detects existing tunnels via TCP probe before spawning, `killTunnel()` cleans up by PID and port lookup, `checkHealth()` probes `/healthz` endpoint. Schema v6 migration adds `session_mode` column to sessions table (`'tmux'` default, `'webui'` for iframe-based OpenClaw sessions). `sessions.start()` and `_rowToSession()` updated to handle session mode. 21 new tests (1013 total).
- **Web UI mode — backend** (Chunk 5/6): Schema v7 adds `default_mode` column to `openclaw_connections` (`'ssh'` or `'webui'`). New `launchWebuiSession()` async function skips tmux, ensures SSH tunnel via `tunnel.ensureTunnel()`, health-checks via `tunnel.checkHealth()`, records session with `sessionMode: 'webui'`, and returns `iframeUrl` for iframe-based OpenClaw access. `getSessionStatus()` returns health-based status for webui sessions (no tmux, idle always false). `killSession()` tears down SSH tunnel instead of tmux for webui sessions. `injectCommand()` and `peek()` gracefully reject webui sessions. Launch API (`POST /api/sessions/:project`) supports `mode` body param to override connection default, and response includes `sessionMode` and `iframeUrl` fields. 17 new tests (1030 total).
- **Web UI mode — frontend + proxy** (Chunk 6/6): OpenClaw reverse proxy at `/openclaw/:project/*` forwards HTTP and WebSocket traffic to the connection's local tunnel port, enabling same-origin iframe embedding. Session wrapper (`public/session.js`) detects webui mode from status poll and loads `iframeUrl` into the iframe instead of ttyd. Peek, Cmd, Select, and Upload buttons disabled for webui sessions (no tmux). Kill modal shows "tears down the SSH tunnel" instead of "terminates the tmux session". tmux mouse toggle hidden in settings for webui. Status endpoint includes `iframeUrl` for webui sessions (enables reconnect on page reload). 9 new tests (1039 total).
- **Standalone OpenClaw access buttons**: "Web UI" and "SSH" action buttons on each connection in the OpenClaw panel. "Web UI" opens the OpenClaw viewer page. "SSH" copies the SSH command to clipboard. New API endpoint `POST /api/openclaw/connections/:id/tunnel` for standalone tunnel startup. Direct proxy handles both HTTP and WebSocket traffic independently of project assignment.
- **OpenClaw viewer page** (`/openclaw-view/:connId`): Dedicated page with TangleClaw header + iframe embedding the OpenClaw Control UI via the direct proxy. Starts tunnel automatically, shows connection name and host in the banner.
- **Auto-approve device pairing**: New endpoint `POST /api/openclaw/connections/:id/approve-pending` auto-approves pending OpenClaw device pairing requests via SSH + docker exec on the gateway host. The viewer page polls this endpoint for 30 seconds after load so new browsers are paired automatically without manual CLI intervention. Approval only runs server-side from TangleClaw.
- **HTTPS support**: TangleClaw can now serve over HTTPS via `httpsEnabled`, `httpsCertPath`, `httpsKeyPath` config options. Required for OpenClaw Control UI's secure context (device identity/crypto). Uses mkcert-generated certs.
- **OpenClaw proxy auth**: All proxy paths (HTTP + WebSocket, both direct and project-based) now rewrite `Origin`/`Referer` headers to match the gateway's local address and inject `Authorization: Bearer <token>` from the connection's gateway token, enabling transparent authentication without device pairing for proxied requests.

## [3.2.2] - 2026-03-20

### Added

- **Shared docs startup banner**: Prime prompt now includes a "Shared Infrastructure" section when a project belongs to groups with shared documents. Single group shows inline format; multiple groups show a bulleted list with doc counts and `sharedDir` paths. Omitted when project has no groups with docs.

### Fixed

- **Group members not displaying**: Group detail endpoint returned raw project IDs instead of enriched objects with names, causing member names to be blank (only delete buttons visible)

## [3.2.1] - 2026-03-20

### Added

- **Shared docs auto-discover**: Groups now have an optional `sharedDir` field — a directory path whose `.md` files are auto-registered as shared documents on session launch. File names become doc names (e.g., `NETWORK.md` → "NETWORK"). Idempotent — skips already-registered files. Manual sync via `POST /api/groups/:id/sync` or the "Sync" button in the group edit modal.
- **AI shared docs guide**: New `data/shared-docs-guide.md` operational guide injected into all 4 engine config generators (Claude, Codex, Aider, Gemini). Teaches AI assistants how to list, register, lock/unlock shared docs, and explains the shared directory convention.
- **sharedDir UI**: Group create/edit modal now includes a "Shared Directory" input field and "Sync" button. Inline group detail shows the configured shared directory path.
- **Schema v4 migration**: Adds `shared_dir` column to `project_groups` table.

### Fixed

- **Idle chime repeating every 5 seconds**: Chime now plays once per idle transition instead of every poll cycle while idle. Resets only when the session becomes active again.

## [3.2.0] - 2026-03-20

### Added

- **Update Checker**: Daily git remote poll detects new TangleClaw versions by comparing semver tags. Red version badge appears on the session wrapper banner when an update is available. Tapping the badge injects step-by-step update instructions directly into the active AI session (git fetch, pull, test, restart) — the AI agent handles the update. First check runs 60s after server start, then every 24h. Graceful degradation — no errors if offline or remote unreachable. New `GET /api/update-status` endpoint returns cached check result.
- **Project Groups and Shared Documents data model**: 4 new SQLite tables (`project_groups`, `project_group_members`, `shared_documents`, `document_locks`) with full store CRUD APIs. Groups allow relating projects (e.g., "backend services"). Shared documents register files that can be injected into engine configs at session launch. Advisory document locking prevents concurrent edit conflicts between sessions. Schema version bumped to 3.
- **Shared Docs API endpoints**: 15 new HTTP endpoints for groups (`GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/:id`), group members (`GET/POST /api/groups/:id/members`, `DELETE /api/groups/:id/members/:projectId`), shared documents (`GET/POST /api/shared-docs`, `GET/PUT/DELETE /api/shared-docs/:id`), and document locks (`POST/GET/DELETE /api/shared-docs/:id/lock`). All endpoints include enriched responses with member/doc counts, lock status, and project names.
- **Shared docs engine integration**: All 4 engine config generators (Claude, Codex, Aider, Gemini) now inject a `## Shared Documents` section when the project belongs to groups with injectable docs. Reference mode lists file paths with descriptions; inline mode reads and embeds file content in fenced blocks. Lock warnings and missing-file warnings included. Deduplication by file path when project is in multiple groups.
- **Session lifecycle lock release**: `completeWrap()` and `killSession()` now call `store.documentLocks.releaseBySession()` to automatically release all document locks held by the ending session.
- **Document lock expiry timer**: Server bootstrap starts a 5-minute interval timer to sweep expired document locks, stopped on graceful shutdown.
- **Project enrichment with groups**: `enrichProject()` now includes a `groups` array with group name and shared doc count for each group the project belongs to.
- **Project rename in settings modal**: Name field is now editable in the project settings modal; renames the directory on disk, updates the DB path, and updates associated port leases. Disabled with a warning when a session is active
- **Groups management UI**: Collapsible "Groups" panel on the landing page dashboard bar. Create, edit, and delete project groups. Manage group membership via checkbox list. Register shared documents with inject mode (reference/inline) and inject toggle. Expandable group items show members, docs, and lock status inline.
- **Group badges on project cards**: Small blue pills on project cards showing group membership. Card detail expansion includes groups row with doc counts.
- **Shared docs in session wrapper**: Settings modal shows shared documents available to the project (via group membership), with lock status indicators, inject mode badges, file paths, and group names. Hidden when project has no groups.
- **Groups in project detail**: Card detail expansion and project enrichment API now show group membership with shared doc counts
- **Group creation with members**: New Group modal now shows project checkboxes immediately, so members can be selected during creation instead of requiring a separate edit step. Group name is optional — auto-generated from selected member names (e.g. "project-a + project-b"), with override ability.
- **Group pills in session banner**: Session wrapper shows clickable blue pills for each group the project belongs to. Tapping a pill shows a popover with all member projects (current project highlighted), group description, and shared doc count. Click outside to dismiss.

### Fixed

- **Stale methodology on session launch**: Engine config and hooks were regenerated _after_ the tmux session started, so the engine loaded the old CLAUDE.md. Moved config generation and hook sync to run _before_ launching the tmux session
- **Stale extension rules after methodology switch**: Switching away from a methodology (e.g. prawduct → minimal) left its `defaultRules` (docsParity, decisionFramework, independentCritic) enabled. Now resets old methodology rules before applying new ones
- **Auto-scaffold CHANGELOG.md**: New and attached projects get a starter CHANGELOG.md if one doesn't already exist

## [3.1.5] - 2026-03-19

### Changed

- **README overhaul for sharing**: Added problem-statement intro, detailed engine/status descriptions, roadmap section with TangleMeth, and MIT license
- **Removed unreleased methodology templates from distribution**: TiLT template kept locally but excluded from repo via `.gitignore`; Prawduct template (JSON only) continues to ship as a bundled starter
- **Removed internal development artifacts from repo**: INTAKE-BRIEF.md (Prawduct discovery artifact) and `.tangleclaw/project.json` (dogfooding config) excluded via `.gitignore`
- **Fixed stale log paths across docs and deploy**: Updated user-guide, install.sh, and README to reference `~/.tangleclaw/logs/tangleclaw.log` instead of removed `~/Library/Logs/tangleclaw-server.log`
- **Redirected ttyd plist output to `/dev/null`**: Matches server plist change from v3.1.4
- **Simplified clone path in README**: No longer hardcodes a specific local directory
- **Added MIT LICENSE file**
- **Added security note to README**: Documents lack of auth on the server, recommends VPN or trusted network

## [3.1.4] - 2026-03-19

### Fixed

- **Event-loop blocking from git info polling caused terminal failure**: `git.getInfo()` used `execSync` with a 10-second cache TTL, spawning up to 180 git subprocesses (6 commands × 30 project directories) on nearly every `/api/projects` poll. This blocked the Node event loop for 1–4 seconds, preventing WebSocket upgrades from completing — the browser would launch but the terminal CLI never appeared. Increased cache TTL from 10s to 2 minutes and added early `rev-parse HEAD` check to skip `git log`/`git describe` on repos with no commits.
- **Git stderr flooding server log to 19MB**: `execSync` in `git.js` did not explicitly set `stdio`, allowing child process stderr (`fatal: not a git repository`, `fatal: No names found`, etc.) to leak to the parent process stderr. Combined with the launchd plist routing both stdout and stderr to the same log file, this produced ~267K lines (19MB) of noise. Added explicit `stdio: ['pipe', 'pipe', 'pipe']` to capture stderr in-process.
- **Launchd server log growing without rotation**: `StandardOutPath` and `StandardErrorPath` in the server plist pointed to `~/Library/Logs/tangleclaw-server.log` with no rotation. The app's internal logger (`~/.tangleclaw/logs/tangleclaw.log`) already handles rotation at 10MB with 3 backups. Redirected the launchd plist outputs to `/dev/null` to eliminate the redundant, unrotated log.

## [3.1.3] - 2026-03-19

### Fixed

- **Engine config not written for non-Claude engines**: `createProject` and `updateProject` failed silently when writing config files to nested paths (e.g., `.gemini/GEMINI.md`) because the parent directory didn't exist. Added `mkdirSync` before `writeFileSync` in both code paths.
- **Orphaned tmux session adoption skipped setup**: When a tmux session with the project name already existed (orphaned from a prior run), `launchSession` adopted it in-place, skipping working directory, prime prompt injection, config generation, and hook sync. Now kills the orphan and creates a fresh session with full setup.
- **New project opened in ended/wrap state**: After the create wizard finished, it navigated to the session page without launching a session first. The page detected no active session and immediately showed the "session ended" state. Now auto-launches the session after creation.
- **`.claude/` directory created for all projects**: `syncEngineHooks` wrote `.claude/settings.json` regardless of engine. Now skips non-Claude projects.
- **Codex session crashed on startup**: Codex CLI shows interactive trust/update prompts that blocked startup and caused the session to die. Added `launch.preKeys` and `launch.startupDelay` engine profile fields to dismiss startup prompts before prime prompt injection. Codex profile now sends Enter keys to dismiss trust and update dialogs.

## [3.1.2] - 2026-03-18

### Changed

- **Landing page: compact dashboard bar**: Replaced the stacked header, system stats cards, ports toggle, and rules toggle with a single-row dashboard bar. Logo (32px), inline stats (CPU/MEM/DISK/UP), and action buttons (Ports, Rules, Settings) all in one line. Recovers ~200px of vertical space so the project list is immediately visible. Stats hidden on mobile (<600px) for a clean two-element bar.

## [3.1.1] - 2026-03-18

### Changed

- **Desktop session banner**: Single-row layout at 900px+ with compact action buttons inline. Mobile layout unchanged.
- **Model status indicators**: Replaced border-based engine status with inline status dot inside the pill. Non-operational states change the entire pill color (amber/orange/red) with a pulsing glow on major outages. Consistent across session and landing pages.
- **Session banner order**: Reordered to name → version → connected dot → methodology → phase → engine (last).

### Fixed

- **Model status not shown in session banner**: The model status monitor was only wired to the landing page project cards. Now the session page banner also fetches and displays upstream service status on the engine badge, polling every 2 minutes.
- **Distorted logo in session banner**: Regenerated icon-192.png and icon-512.png from source with correct aspect ratio.

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
