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
3. **Detect Projects** — scans the directory for existing projects (git repos, methodology markers) and lets you select which to attach
4. **Engines** — shows which AI engines are detected on your system and lets you pick a default
5. **Preferences** — default methodology, delete protection password, idle chime toggle
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
- **Methodology badge** — which methodology template is active (e.g., "Prawduct")
- **Status badge** — current methodology status (color-coded by phase)
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
3. **Methodology** — choose a methodology template
4. **Tags** — optional tags for organization

The project is created in your configured `projectsDir` (default: `~/Documents/Projects`). TangleClaw scaffolds the project directory, initializes the methodology, registers ports with PortHub (if available), and generates the engine-specific config file.

### Deleting a Project

Tap the delete button on a project card. If a `deletePassword` is configured, you'll need to enter it. Deletion releases registered ports and removes the project from TangleClaw's database. The project directory itself is preserved on disk.

### Attaching Existing Projects

TangleClaw shows ALL directories in your `projectsDir` on the landing page — not just registered ones. Unregistered directories appear with a muted style and an **Attach** button.

Tap **Attach** to register a directory as a TangleClaw project. This:
- Reads any existing `.tangleclaw/project.json` for engine and methodology settings
- Detects methodology from directory markers (`.prawduct/`)
- Registers the project in the database
- Creates a `.tangleclaw/project.json` if one doesn't exist

You can also attach projects in bulk during the first-run setup wizard, or via the API: `POST /api/projects/attach { "name": "project-dir-name" }`.

### Auto-Detection of Existing Projects

During the setup wizard, TangleClaw scans your `projectsDir` for directories that have:

- A `.tangleclaw/project.json` file
- A methodology marker directory (`.prawduct/`)
- A git repository

These are offered for batch attachment during setup.

## Sessions

Sessions are the core of TangleClaw — they're how you interact with AI engines on your projects.

### Launching a Session

Tap the **Launch** button on a project card. TangleClaw:

1. Generates a prime prompt from methodology state, active learnings, and last session summary
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

Tap **Select** to temporarily enable text selection in the terminal. This toggles tmux mouse mode off so you can select and copy text from the terminal output using normal touch/click-drag gestures. After 30 seconds, mouse mode automatically reverts to its previous state, so you don't have to remember to switch it back.

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
- **Methodology info** — current methodology and phase
- **Mouse mode** — toggle tmux mouse mode on/off

#### Wrapping a Session

Tap **Wrap** to trigger the methodology-defined wrap skill. This:

1. Executes the wrap steps defined in the methodology template
2. Captures session output (summary, next steps, learnings)
3. Records the wrap in the database
4. Ends the session
5. Redirects to the landing page after a countdown

If a `deletePassword` is configured, you'll need to enter it to wrap.

#### Killing a Session

Tap **Kill** to forcefully terminate a session without wrapping. Use this when a session is stuck or you don't need wrap data. Password required if configured. Kill is also available from the project card on the landing page — look for the stop icon in the card row when a session is active.

### Session History

Each project maintains a session history showing:

- Start time and duration
- Engine used
- Session status (wrapped, killed, crashed)
- Wrap summary (if wrapped)

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
