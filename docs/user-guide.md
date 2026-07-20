# TangleClaw User Guide

This guide walks you through using TangleClaw — from first launch to managing AI development sessions on your projects.

## Getting Started

### Prerequisites

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal emulator (`brew install ttyd`)
- **tmux** — terminal multiplexer (`brew install tmux`)
- At least one AI engine installed (e.g., `claude`, `codex`, or `aider`)

### Installation

```bash
git clone https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
./deploy/install.sh
```

The install script verifies prerequisites, generates launchd plists, loads the services, and runs a health check. On success, you'll see:

- **Landing page**: http://localhost:3102
- **Terminal (ttyd)**: http://localhost:3101

Both services auto-restart on crash via launchd KeepAlive.

### First Run

On first launch, TangleClaw creates `~/.tangleclaw/` with:

- `config.json` — global configuration (editable)
- `engines/` — engine profile JSON files
- `tangleclaw.db` — SQLite database for runtime state

Open http://localhost:3102 in your browser. On a fresh install, a **setup wizard** will guide you through initial configuration:

1. **Welcome** — overview of what TangleClaw does
2. **Projects Directory** — set where your project folders live (defaults to `~/Documents/Projects`)
3. **Detect Projects** — scans the directory for existing projects (git repos, TangleClaw or Prawduct markers) and lets you select which to attach
4. **Engines** — shows which AI engines are detected on your system and lets you pick a default
5. **Preferences** — delete protection password, idle chime toggle
6. **Confirm** — summary of all selections, then "Complete Setup"

You can **skip the wizard** at any step — it will use sensible defaults. The wizard only appears once; subsequent launches go straight to the landing page.

### PWA Installation (Mobile)

TangleClaw works as a Progressive Web App:

- **iPhone Safari**: Tap Share → "Add to Home Screen"
- **Android Chrome**: Tap the three-dot menu → "Add to Home screen"

This gives you a full-screen app experience with no browser chrome.

## The Landing Page

The landing page is your dashboard for managing projects and launching sessions.

### Header

The header shows the TangleClaw logo (served from `public/logo.png`, with app icons in `public/icons/`), version, and a collapsible system stats panel (CPU, Memory, Disk, Uptime). Tap the stats area to expand or collapse it.

### PortHub Lease Import Banner

If TangleClaw detects an existing PortHub installation with active leases that haven't been imported yet, a banner appears at the top of the landing page offering to import those leases into TangleClaw's built-in port registry. This is a one-time migration convenience — once imported, TangleClaw manages ports directly.

### Ports Panel

Below the system stats, there's a collapsible **Ports** panel. Tap it to see all active port leases grouped by project. Each lease shows:

- **Port number** — the assigned port (e.g., 3100)
- **Service** — what the port is used for (e.g., "ttyd", "server")
- **Type badge** — "permanent" for infrastructure ports, "TTL" for time-limited leases

TangleClaw manages port assignments directly in its SQLite database. Leases survive server restarts (unlike the old PortHub daemon). The panel auto-refreshes every 30 seconds.

TangleClaw also periodically scans the system for listening TCP ports using `lsof`. When you check a port's availability (via API or internally), TangleClaw will detect conflicts with ports bound by processes outside its registry — even if no lease exists for that port. This helps prevent "port already in use" errors when launching services.

### Global Rules

Below the ports panel, there's a collapsible **Global Rules** panel. These are markdown rules that apply to every project across all engines. When TangleClaw generates an engine config file (e.g., `CLAUDE.md`, `.codex.yaml`), global rules are included automatically.

- **Edit**: Expand the panel, modify the textarea, and tap **Save**
- **Reset**: Tap **Reset to Defaults** to restore the bundled default rules (with confirmation)
- **API**: `GET /api/rules/global`, `PUT /api/rules/global`, `POST /api/rules/global/reset`

Global rules are stored at `~/.tangleclaw/global-rules.md`. On first load, this file is created from the bundled defaults in `data/default-global-rules.md`.

### Toolbar

- **Session count**: Shows how many active sessions are running
- **Filter**: Opens the search/filter panel
- **+ New**: Opens the create project drawer

### Project Cards

Projects are displayed as compact cards. Each card shows:

- **Name** — the project directory name
- **Version badge** — the project's current version (if available), shown as a subtle badge
- **Engine badge** — which AI engine is selected (e.g., "Claude Code")
- **Git info** — branch, dirty state, last commit age
- **Session indicator** — a green breathing dot when a session is active
- **Peek icon** — an eye icon to quickly peek at session output without entering the session wrapper
- **Delete button** — a subtle "x" on the card (password required if configured)
- **Launch** — tap the card or launch button to enter the session

### Searching and Filtering

Use the search bar to filter projects by name. Tag pills appear below the search bar — tap a tag to filter projects with that tag.

### Creating a Project

Tap **+ New** to open the create project drawer:

1. **Name** — enter a project name (letters, numbers, hyphens, underscores only)
2. **Engine** — select an AI engine from the dropdown
3. **Tags** — optional tags for organization

The project is created in your configured `projectsDir` (default: `~/Documents/Projects`). TangleClaw scaffolds the project directory, registers ports with PortHub (if available), and generates the engine-specific config file. See the [Engine Guide](engine-guide.md) for details on custom engines.

### Deleting a Project

Tap the delete button on a project card. If a `deletePassword` is configured, you'll need to enter it. Deletion releases registered ports and removes the project from TangleClaw's database. The project directory itself is preserved on disk.

### Attaching Existing Projects

TangleClaw shows ALL directories in your `projectsDir` on the landing page — not just registered ones. Unregistered directories appear with a muted style and an **Attach** button.

Tap **Attach** to register a directory as a TangleClaw project. This:
- Reads any existing `.tangleclaw/project.json` for engine settings
- Registers the project in the database
- Creates a `.tangleclaw/project.json` if one doesn't exist

You can also attach projects in bulk during the first-run setup wizard, or via the API: `POST /api/projects/attach { "name": "project-dir-name" }`.

### Auto-Detection of Existing Projects

During the setup wizard, TangleClaw scans your `projectsDir` for directories that have:

- A `.tangleclaw/project.json` file
- A Prawduct governance directory (`.prawduct/`)
- A git repository

These are offered for batch attachment during setup.

## Sessions

Sessions are the core of TangleClaw — they're how you interact with AI engines on your projects.

### Launching a Session

Tap the **Launch** button on a project card. TangleClaw:

1. Generates a prime prompt from project state, active learnings, and last session summary
2. Creates a tmux session
3. Launches the selected AI engine inside it
4. Injects the prime prompt (if the engine supports it)
5. Redirects you to the session wrapper

### The Session Wrapper

The session wrapper is your interface to the running AI session.

#### Banner

The top banner shows:

- **Back link** — return to the landing page
- **Project name** and **version**
- **Status dot** — green (connected), red (disconnected), with a breathing animation
- **Engine badge** — which engine is running

#### Terminal Viewport

The terminal fills the main area, showing the ttyd-powered terminal where your AI engine is running. Interact with it directly — type commands, paste text, scroll output.

#### Command Bar

Below the terminal, the command bar lets you inject commands without touching the terminal:

- Type a command and tap **Send** (or press Enter)
- **Quick command pills** appear below the input — tap to inject common commands
- Engine-specific slash commands are included as pills (e.g., `/compact`, `/review` for Claude Code)
- Commands are sent to the tmux session via `send-keys`

#### Peek

Tap **Peek** to open a bottom drawer showing the last few lines of terminal output. This lets you check on progress without scrolling through the terminal. Tap refresh to update.

#### Select

Tap **Select** to enable text selection in the terminal, and tap **Done** to leave it. Select mode adjusts tmux mouse mode so normal touch/click-drag gestures select text instead of reaching the terminal app (on desktop it turns mouse mode off; on touch devices it turns it on). It stays on until you tap Done — there is no auto-revert timer (#574; timer-driven UI reverts are banned by #98/#268) — and leaving select mode restores the mouse configuration you had before entering: an explicit per-session setting is set back, and a state inherited from the global config is restored by removing the session-level override entirely (#579), so a Select round-trip leaves no residue. If the page is reloaded or closed while Select mode is still on, the restore is replayed automatically the next time you open that session (UI-8W3D) — an interrupted Select can't permanently strand the terminal's mouse state. On touch devices you can also long-press to select without Select mode at all (a Copy pill appears on release).

#### Paste (touch devices)

On iPhone and other touch devices a **Paste** button appears in the session banner (#402) — iOS has no Cmd-V, and its native long-press Paste menu can't reach the terminal's hidden input, so this button is the paste path. Tap it and the clipboard is read directly (iOS shows its permission bubble the first time) and inserted into the terminal as a proper paste — multi-line text gets the same bracketed-paste framing a desktop Cmd-V would. When the clipboard can't be read directly (plain-HTTP setups have no clipboard API, or you decline the permission), a small **Paste into terminal** box opens instead: long-press the box, choose Paste from the iOS menu, and tap **Insert**. The button only appears on touch devices with a tmux-backed session — desktop keeps its normal Cmd-V.

#### Upload

Tap **Upload** to send a file into the project directory. A file picker opens where you can choose any file (up to 15 MB). For image files, a preview is shown before confirming. The file is base64-encoded and sent via `POST /api/upload`. On success, the upload path is displayed so you can reference it when talking to the AI assistant (e.g., "look at `uploads/screenshot.png`"). Uploaded files are stored in the project's working directory under a managed location.

#### Chime System

When enabled, TangleClaw plays an audio chime when the terminal goes idle (no new output for a configured period). This tells you the AI has finished working.

- Uses Web Audio API for reliable mobile playback
- Toggle via the Settings modal
- Works on both iOS and Android

#### Settings

The settings modal lets you configure:

- **Chime toggle** — enable/disable idle chime
- **Poll interval** — how often to check session status (2s–30s)
- **Engine selector** — switch engine for next session
- **Mouse mode** — toggle tmux mouse mode on/off

See the [Configuration Reference](configuration-reference.md) for all config fields and API endpoints.

#### Wrapping a Session

Tap **Wrap** to trigger the session wrap. This:

1. Executes the wrap pipeline's steps
2. Captures session output (summary, next steps, learnings)
3. Records the wrap in the database
4. Ends the session
5. Redirects to the landing page after a countdown

If a `deletePassword` is configured, you'll need to enter it to wrap.

**Choosing the version bump.** The wrap dialog has a **Version bump** selector: *Auto*, *Patch*, *Minor*, or *Major*. Auto (the default) derives the bump from your `CHANGELOG.md` `[Unreleased]` content — `### Added`/`### Changed` mean minor, `### Fixed`-only means patch, a `BREAKING` marker means major. Pick an explicit level when the CHANGELOG can't imply what you want — for example a release train where the bump belongs at promote time rather than at session end. Your choice is reapplied if the wrap blocks and you retry, and resets to Auto the next time you open the dialog.

**Did it actually ship?** A wrap that commits has not necessarily *released*. When the wrap opens a PR (see protected branches below), the version bump and CHANGELOG promotion only reach `main` once that PR merges — which happens after its checks pass, and never if a required check fails. The drawer says which of these is true:

- **Wrap shipped — PR merged** — the release landed.
- **Release pending checks** — the PR hasn't merged yet; it lands when its checks pass.
- **Release BLOCKED, did not ship** — a required check failed, a review is missing, or the branch conflicts. **This is a failure**: the wrap's version bump is stranded on an unmerged branch. Fix the PR, then merge it.
- **Release not confirmed** — TangleClaw couldn't reach GitHub (no `gh`, not signed in). The outcome is genuinely unknown, not assumed good.

Use **Recheck release** in the drawer to re-query at any time — checks usually take longer than the wrap itself, so "pending" right after a wrap is normal.

**Steps that were skipped.** If any wrap steps skipped, the drawer shows *"Skipped N of M steps"* with the reason for each, so a wrap that quietly did nothing doesn't look the same as one that did everything.

**When a step insists a file changed.** The steps that write your `CHANGELOG.md` and `.tangleclaw/memories/learnings.md` now check that the file actually changed. If the AI reports done without editing it, the wrap stops and asks you to decide rather than reporting success. If there's genuinely nothing to record, tick **Skip & note** — the skip is recorded in the commit body. (Retry only helps if the AI never acted; a retry looks for a *new* change, so it will stop again on an edit that already landed — and any edit already on disk still gets committed.)

**Wrap commits and protected branches.** When a wrap fires while the project is checked out on `main`/`master`, the commit step auto-branches to `wrap/<timestamp>-<project>` and commits there — and then closes the loop automatically: it pushes the wrap branch, opens a PR back to the original branch, and arms GitHub auto-merge (`--auto --squash --delete-branch`; branch protection still gates). The commit row in the wrap drawer shows the outcome (e.g. `wrap PR auto-merge armed`). If any part fails — no `origin` remote, `gh` missing, auto-merge disabled on the repo — the wrap still completes and the drawer shows what to do; the checkout stays on the wrap branch so the dangling commit is visible. Opt out per project with `wrapAutoPrEnabled: false` in `<project>/.tangleclaw/project.json` if a project must never have automated pushes or PRs.

**One wrap at a time, and it survives your connection.** A wrap can run for several minutes (the AI writes changelog, learnings, and memory content mid-pipeline), and it runs entirely server-side — if your connection drops, your phone locks, or you reload the page, **the wrap keeps going**. Don't re-tap Wrap: the page automatically reattaches to the running wrap (you'll see the wrapping bar; the terminal shows the wrap happening) and opens the results drawer when it finishes. Triggering a wrap while one is already running is refused ("wrap already in progress") — that's the guard working, not an error to fight. Restarting TangleClaw while a wrap is running is likewise refused with a confirmation; forcing it kills the wrap mid-run (nothing is committed — the commit step runs last), and the session page will tell you a killed wrap is safe to retry.

#### Killing a Session

Tap **Kill** to forcefully terminate a session without wrapping. Use this when a session is stuck or you don't need wrap data. Password required if configured. Kill is also available from the project card on the landing page — look for the stop icon in the card row when a session is active.

### Session History

Each project maintains a session history showing:

- Start time and duration
- Engine used
- Session status (wrapped, killed, crashed)
- Wrap summary (if wrapped)

For OpenClaw remote sessions, see the [OpenClaw Setup Guide](openclaw-setup.md).

## Project Groups and Shared Documents

### Groups

Project groups let you relate projects that share infrastructure or documentation. Create groups from the landing page's Groups panel (collapsible section in the dashboard bar).

### Shared Directory (Auto-Discover)

Each group can have a `sharedDir` — a directory path containing shared `.md` files. On session launch, TangleClaw scans this directory and auto-registers any new markdown files as shared documents. Already-registered files are skipped.

To set up auto-discover:
1. Edit a group and enter the shared directory path
2. Click "Sync" to trigger immediate discovery
3. New `.md` files are registered with `injectIntoConfig: true` and `injectMode: reference`

File names become document names (e.g., `NETWORK.md` becomes "NETWORK").

You can also trigger sync via the API:
```
POST /api/groups/<group-id>/sync
```

### Shared Documents

Shared documents are markdown files registered to a group. When a project belongs to a group, injectable shared docs appear in the project's engine config at session launch.

### Document Locking

Before editing a shared document, lock it to prevent conflicts:
```
POST /api/shared-docs/<doc-id>/lock
{ "sessionId": <id>, "projectName": "my-project" }
```
Locks expire after 30 minutes and are auto-released when sessions wrap or are killed.

## Mobile Tips

### iPhone Safari

- Use PWA mode (Add to Home Screen) for the best experience
- The command bar appears above the keyboard when focused
- Touch targets are 44px minimum for comfortable tapping
- Safe area insets are respected for notch/home indicator

### Android (Pixel Fold 9)

- Works in both folded and unfolded configurations
- Chrome PWA mode supported
- Scroll behavior is fixed (v2 bug resolved)

### Touch Patterns

- **Tap** — buttons, pills, cards
- **Swipe down** — pull to refresh on landing page
- **Drag** — peek drawer handle to resize
- **Long press** — not used (avoids conflicts with browser gestures)

## Troubleshooting

### Server Won't Start

```bash
# Check if Node 22+ is available
node --version

# Check service status
launchctl list | grep tangleclaw

# View server logs
tail -50 ~/.tangleclaw/logs/tangleclaw.log

# Health check
curl -s http://localhost:3102/api/health | python3 -m json.tool
```

### Terminal Not Connecting

```bash
# Check ttyd is running
launchctl list | grep ttyd

# View ttyd logs (ttyd has no app-level log; check launchd output if needed)
launchctl list | grep ttyd

# Test ttyd directly
curl -s http://localhost:3101
```

### Session Won't Launch

- Verify the selected engine is installed: check the engine badge on the landing page (shows "available" or "not found")
- Check tmux is running: `tmux ls`
- Check server logs for error details

### Chime Not Working on Mobile

- Tap anywhere on the page first — browsers require user interaction before playing audio
- Check the chime toggle in session settings
- Verify your device isn't in silent mode (iOS)

### Resetting TangleClaw

To reset all configuration and state:

```bash
rm -rf ~/.tangleclaw
launchctl kill SIGTERM gui/$(id -u)/com.tangleclaw.server
```

TangleClaw will recreate the default config on next start.
