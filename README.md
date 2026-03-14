# TangleClaw v3

An AI development orchestration platform that manages the contracts, lifecycle, enforcement, and coordination between a human operator, development methodologies, and AI coding agents.

## What It Does

- **Methodology-as-code**: Pluggable methodology templates (Prawduct, TiLT, Minimal, custom) with structural enforcement — rules are gates, not suggestions
- **Engine abstraction**: Swap between Claude Code, Codex, Aider, or any AI engine without reconfiguring projects
- **Session lifecycle**: Prime prompts auto-generated from methodology state, configurable wrap skills, learning capture
- **Mobile-first**: Manage projects, launch sessions, and interact with AI agents from iPhone Safari or Android
- **Zero dependencies**: Node.js stdlib only. No npm install, no build step, no bundler

## Prerequisites

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — terminal emulator for browser-based terminal access (`brew install ttyd`)
- **tmux** — session multiplexer (`brew install tmux`)

## Quick Start

```bash
git clone <repo-url> ~/Documents/Projects/TangleClaw-v3
cd ~/Documents/Projects/TangleClaw-v3
./deploy/install.sh
```

The install script:
1. Checks prerequisites (node 22+, ttyd, tmux)
2. Generates launchd plists with correct paths
3. Installs and loads the services
4. Runs a health check

Access the landing page at **http://localhost:3101**.

## Configuration

Global config lives at `~/.tangleclaw/config.json` (auto-created on first run).

Key settings:
- `serverPort` — Landing page server port (default: 3101)
- `ttydPort` — ttyd terminal port (default: 3100)
- `projectsDir` — Root directory for managed projects
- `defaultEngine` — Default AI engine for new projects
- `defaultMethodology` — Default methodology template
- `deletePassword` — Optional password for destructive operations

Engine profiles: `~/.tangleclaw/engines/*.json`
Methodology templates: `~/.tangleclaw/templates/`

## Development

### Running Tests

```bash
node --test 'test/*.test.js'
```

### Project Structure

```
server.js              # HTTP server entry point, API routes, static serving
lib/
  store.js             # Storage abstraction (JSON config + SQLite runtime)
  logger.js            # Structured logging with rotation
  tmux.js              # tmux session management
  git.js               # Git operations
  system.js            # System resource stats
  engines.js           # Engine profile loading, detection, config generation
  methodologies.js     # Methodology templates, init, switching, status
  projects.js          # Project CRUD, enrichment, auto-detection
  sessions.js          # Session lifecycle (launch, prime, wrap, kill)
  skills.js            # Skills system (session-wrap skill)
  porthub.js           # PortHub integration (port registration)
public/
  index.html           # Landing page
  session.html         # Session wrapper page
  style.css            # Landing page styles
  session.css          # Session wrapper styles
  landing.js           # Landing page logic
  ui.js                # Landing page UI rendering
  session.js           # Session wrapper logic
  manifest.json        # PWA manifest
  sw.js                # Service worker
data/
  engines/             # Bundled engine profiles
  templates/           # Bundled methodology templates
test/                  # Test files (node:test)
deploy/                # launchd plists and install script
hooks/                 # Git hooks (reference, not auto-installed)
```

### Architecture

```
launchd (com.tangleclaw.server)
  └─ node server.js
     ├─ Landing page HTTP server (:3101)
     ├─ API endpoints (/api/*)
     ├─ Reverse proxy /terminal/* → ttyd (:3100)
     └─ Session wrapper HTML serving

launchd (com.tangleclaw.ttyd)
  └─ ttyd --port 3100 tmux attach
     └─ WebSocket terminal access

tmux sessions (spawned on demand)
  └─ One per active project session
     └─ AI engine process (claude, codex, aider)
```

### Git Hooks

Reference hooks are provided in `hooks/`. To install:

```bash
cp hooks/pre-commit .git/hooks/pre-commit
cp hooks/commit-msg .git/hooks/commit-msg
cp hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg .git/hooks/post-commit
```

- **pre-commit**: Runs the full test suite
- **commit-msg**: Validates first line is non-empty and ≤72 characters
- **post-commit**: Tags the version from `version.json` on the main branch

## Service Management

```bash
# Restart server (launchd auto-restarts via KeepAlive)
launchctl kill SIGTERM gui/$(id -u)/com.tangleclaw.server

# Stop services
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.server.plist
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist

# View logs
tail -f ~/Library/Logs/tangleclaw-server.log

# Health check
curl -s http://localhost:3101/api/health | python3 -m json.tool
```

## License

Private project.
