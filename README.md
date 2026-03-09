<p align="center">
  <img src="https://raw.githubusercontent.com/Jason-Vaughan/puberty-labs-assets/main/tangleclaw-logo.png" alt="TangleClaw" width="300">
</p>

<p align="center">
  <strong>Mobile-first tmux session manager for remote dev machines.</strong><br>
  Zero npm dependencies. Runs entirely on Node.js stdlib.
</p>

---

## What It Does

TangleClaw turns a headless Mac into a project workstation you can access from anywhere:

- **Tap a project** on your phone and land in a full web terminal with Claude Code (or another AI engine) already running
- **See at a glance** which projects have active sessions, git branch, dirty file count, and uptime
- **Monitor your machine** with a collapsible system dashboard (CPU, RAM, disk, uptime)
- **Peek at terminal output** without opening a session — check if a long-running task finished
- **Send quick commands** (git status, ls, etc.) to running sessions from the project list
- **Kill sessions** with swipe-to-kill on mobile or a confirmation modal on desktop
- **Create new projects** from the UI with optional git init, CLAUDE.md, and language templates (including Prawduct structured development)
- **Rename or delete projects** with password-protected deletion support
- **Upload files** to projects directly from the session wrapper banner
- **Copy terminal text** via Select mode — toggles tmux mouse off for native browser text selection
- **Track project versions** — reads `version.json` or `package.json` and displays on cards and session banner

## Architecture

```
Phone/Browser --> VPN --> Landing Page (:3101) --> ttyd (:3100) --> tmux --> AI engine
```

Three layers, each independent:

| Layer | What It Does |
|-------|-------------|
| **tmux** | Session persistence. Each project gets a named session that survives disconnects. Multi-window support for running multiple agents on one project. |
| **ttyd** | Web terminal. Bridges browser WebSocket to tmux via a shell script (`project-session`). Single instance serves all projects via URL parameters. |
| **Landing page** | The TangleClaw server. Project dashboard, system stats, session management API, and a reverse proxy to ttyd (to avoid cross-origin iframe issues in Safari). |

### Request Flow

1. User taps a project card on the landing page
2. Browser navigates to `/session/ProjectName`
3. The server renders a **session wrapper** page: a persistent banner (project name, status, peek/kill buttons) with a full-screen ttyd iframe below
4. The iframe loads `/terminal/?arg=ProjectName`, which the server reverse-proxies to ttyd on port 3100
5. ttyd runs `project-session ProjectName`, which creates or attaches to a tmux session and launches the configured AI engine

### Session Wrapper

When you open a project, you don't get raw ttyd — you get a wrapper page with:

- **Back button** to return to the dashboard
- **Status indicator** (green breathing dot = active, red = disconnected)
- **Version display** — project version (from `version.json`/`package.json`) or TangleClaw version
- **Select button** to toggle tmux mouse off for native text selection and copy (auto-reverts after 30s)
- **Upload button** to upload files to the project directory
- **Peek button** to view the last few lines of terminal output
- **Kill button** with confirmation modal to end the session

The ttyd terminal fills the rest of the viewport. On iPhone, this feels like a native terminal app.

## Project Dashboard

The main landing page shows every directory in `~/Documents/Projects/` as a card:

- **Project name** with version badge, git branch badge, dirty file indicator, and Prawduct phase badge
- **Session status** — green dot if a tmux session is running, with breathing animation
- **Window count** badge when multiple tmux windows exist (multi-agent)
- **Expandable details** panel: session uptime, idle time, last commit age, AI engine selector, quick commands, window list
- **Swipe-to-kill** on mobile (touch devices) or inline kill button on desktop
- **Peek drawer** slides up from the bottom with the last 5 lines of terminal output
- **"Projects Directory" root card** spanning the full width for navigating `~/Documents/Projects/` itself

A collapsible **system dashboard** sits between the header and the project list:

- CPU load (1/5/15 min averages)
- Memory usage with color-coded bar
- Disk usage with color-coded bar
- System uptime

Everything auto-refreshes every 10 seconds.

## Creating Projects

The `+ Create` button in the toolbar opens a modal with:

- **Project name** (alphanumeric, hyphens, underscores)
- **Initialize git repo** (optional)
- **Create CLAUDE.md** with custom content (optional)
- **Language template**: Blank, Node.js, Python, Rust, or Prawduct — builtin pills plus dropdown for custom templates

After creation, the browser navigates directly to the new project's session wrapper.

## AI Engine Support

Each project can use a different AI coding engine. The default is Claude Code, with Aider and Codex CLI as options. The engine is selected per-project from the card's detail panel and stored in `~/.tangleclaw/config.json`.

The `project-session` shell script reads this config and launches the right engine command when creating a new tmux session.

## API

All endpoints return JSON.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List all projects with git info, session stats, and enriched metadata |
| `POST` | `/api/projects` | Create a new project directory (body: `{name, gitInit, claudeMd, template}`) |
| `GET` | `/api/config` | Read runtime config |
| `GET` | `/api/system` | macOS system stats (CPU, memory, disk, uptime) |
| `GET` | `/api/templates` | List available project templates |
| `GET` | `/api/templates/:id` | Template detail with file list |
| `GET` | `/api/activity` | Recent activity log entries |
| `POST` | `/api/sessions/:name/kill` | Kill a tmux session by name |
| `GET` | `/api/sessions/:name/peek` | Capture the last 5 lines of a session's terminal output |
| `POST` | `/api/sessions/:name/send` | Send a command to a running session (body: `{command}`) |
| `POST` | `/api/upload` | Upload file (body: `{name, data, project?}`) |
| `GET` | `/api/uploads` | List uploads (`?project=` for project-specific) |
| `DELETE` | `/api/projects/:name` | Delete project (body: `{password}` if protected) |
| `PATCH` | `/api/projects/:name` | Rename project (body: `{newName}`) |
| `POST` | `/api/tmux/mouse` | Toggle tmux mouse mode for Select/copy (body: `{on: bool}`) |
| `GET` | `/api/clipboard` | Get tmux clipboard text (JSON) |
| `GET` | `/api/clipboard/view` | Clipboard text as standalone HTML page |
| `GET` | `/api/version` | Get app version from `version.json` |

### Other Routes

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/session/:name` | Session wrapper (banner + ttyd iframe) |
| `/terminal/*` | Reverse proxy to ttyd (HTTP + WebSocket) |

## File Structure

```
TangleClaw/
  server.js                        # Entry point — HTTP server, routing, ttyd proxy
  lib/
    api.js                         # API route dispatcher and handlers
    tmux.js                        # tmux interactions (list, kill, peek, send-keys)
    system.js                      # macOS stats (sysctl, vm_stat, df)
    git.js                         # Per-project git info with 10s cache
    config.js                      # Read/write ~/.tangleclaw/config.json
    activity.js                    # Append-only JSON Lines activity log
    projects.js                    # Project discovery, creation, rename, delete
    session.js                     # Session wrapper page renderer
    uploads.js                     # File upload save/list (project-specific or global)
  public/
    index.html                     # Single-file UI (~1380 lines, CSS + JS inline)
    sw.js                          # Service worker (PWA offline support)
    manifest.json                  # PWA manifest
    logo.png                       # Combined logo (serpent + wordmark)
    logo-icon.png                  # Serpent icon
    logo-text.png                  # "TangleClaw" wordmark
    icons/                         # PWA icons (192, 512, apple-touch-icon)
  templates/
    blank/                         # Empty project template
    node/                          # Node.js starter (package.json, index.js)
    python/                        # Python starter (main.py, requirements.txt)
    rust/                          # Rust starter (src/main.rs, cargo init)
    prawduct/                      # Prawduct structured development (init command)
  hooks/
    pre-commit                     # Enforces version.json bump on every commit
    post-commit                    # Auto-tags commits with version
    commit-msg                     # Auto-updates CHANGELOG.md with commit summary
  version.json                     # Semantic version (major.minor.patch)
  CHANGELOG.md                     # Auto-maintained changelog
  com.tangleclaw.landing.plist     # launchd plist for landing page server
  com.tangleclaw.ttyd.plist        # launchd plist for ttyd
```

## Setup

### Prerequisites

- macOS (uses `sysctl`, `vm_stat`, `df` for system stats)
- Node.js (no npm install needed — zero dependencies)
- tmux
- [ttyd](https://github.com/nicedoc/ttyd) (web terminal)
- [PortHub](https://github.com/ishayoyo/porthub) (port registry — prevents conflicts across projects)
- A VPN or other network access to the machine

### Install

1. Install PortHub (port registry):

   ```bash
   npm i -g porthub
   porthub start --daemon --port 8080
   ```

2. Clone this repo:

   ```bash
   git clone https://github.com/Jason-Vaughan/tangle-claw.git ~/Documents/Projects/TangleClaw
   ```

3. Register TangleClaw's ports:

   ```bash
   porthub lease 3100 --service "ttyd" --project "TangleClaw" --permanent
   porthub lease 3101 --service "landing-page" --project "TangleClaw" --permanent
   ```

4. Create the helper scripts:

   ```bash
   # ~/bin/project-session — creates/attaches tmux sessions, launches AI engine
   # ~/bin/start-ttyd — starts ttyd pointing at project-session
   chmod +x ~/bin/project-session ~/bin/start-ttyd
   ```

5. Install the launchd plists (edit paths to match your system first):

   ```bash
   cp com.tangleclaw.landing.plist ~/Library/LaunchAgents/
   cp com.tangleclaw.ttyd.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.tangleclaw.landing.plist
   launchctl load ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist
   ```

6. Open `http://localhost:3101` (or your machine's hostname/IP over VPN)

### Service Management

Both services run as macOS LaunchAgents — they start at login and auto-restart on crash.

```bash
# Restart the landing page (needed after changing lib/ files)
launchctl stop com.tangleclaw.landing && sleep 1 && launchctl start com.tangleclaw.landing

# Restart ttyd
launchctl stop com.tangleclaw.ttyd && sleep 1 && launchctl start com.tangleclaw.ttyd

# Check if services are running
lsof -i :3100 -i :3101 -P -n

# View logs
tail -f ~/Library/Logs/tangleclaw-landing.log
tail -f ~/Library/Logs/tangleclaw-ttyd.log
```

Static file changes (`public/`) only need a browser refresh — no service restart required.

## Configuration

Runtime config lives at `~/.tangleclaw/config.json`:

```json
{
  "ttydPort": 3100,
  "defaultEngine": "claude",
  "engines": {
    "claude": { "command": "claude", "label": "Claude Code" },
    "aider": { "command": "aider", "label": "Aider" }
  },
  "projectEngines": {
    "MyProject": "aider"
  },
  "quickCommands": [
    { "label": "git status", "command": "git status" },
    { "label": "git log", "command": "git log --oneline -5" },
    { "label": "ls", "command": "ls -la" }
  ]
}
```

## Design Decisions

- **Zero dependencies**: The entire server is Node.js stdlib (`http`, `fs`, `path`, `child_process`, `os`). No npm, no build step, no bundler.
- **Single-file UI**: All CSS and JavaScript live inline in `index.html`. No framework, no compilation. Edit and refresh.
- **Pipe delimiter in tmux**: tmux format strings use `|` instead of `\t` because tabs get mangled when processes run under launchd.
- **Same-origin ttyd proxy**: Safari blocks WebSocket connections from iframes on different ports. The landing page server reverse-proxies `/terminal/*` to ttyd, keeping everything on one origin.
- **LaunchAgents over LaunchDaemons**: LaunchDaemons run as root and don't inherit user TCC permissions. LaunchAgents inherit the user's permissions and just work.
- **PWA support**: Web app manifest + service worker enable "Add to Home Screen" on iOS for a native-app feel.
- **PortHub integration**: All ports (3100 ttyd, 3101 landing page) are registered with [PortHub](https://github.com/ishayoyo/porthub) as permanent leases. This prevents port conflicts across projects on the same machine.

## Multi-Agent Support

The `project-session` script supports window numbers for running multiple AI instances on the same project:

```bash
project-session MyProject      # Window 1 (default)
project-session MyProject 2    # Window 2
project-session MyProject 3    # Window 3
```

The dashboard shows a window count badge when a project has multiple windows.

## License

Personal project. No license yet.
