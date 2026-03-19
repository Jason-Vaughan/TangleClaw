# TangleClaw v3

<p align="center">
  <img src="https://github.com/Jason-Vaughan/puberty-labs-assets/blob/main/tangleclaw-logo.png?raw=true" alt="TangleClaw logo" width="200">
</p>

AI coding agents are powerful, but managing them across multiple projects gets messy fast. Each engine has its own config format, its own way of receiving instructions, and no awareness of what other projects are doing on your machine. You end up juggling terminal sessions, copy-pasting methodology rules, manually tracking ports, and hoping your agents follow the process you intended.

TangleClaw is a local orchestration platform that sits between you and your AI coding agents. It enforces your development methodology as structural rules (not suggestions), generates engine-native config so every agent gets the same instructions regardless of engine, manages session lifecycle from launch to wrap, and provides a single landing page — accessible from your browser or phone — to manage all of it.

## Features

- **Methodology-as-code**: Pluggable methodology templates (Prawduct, Minimal, or custom) with structural enforcement — rules are gates, not suggestions
- **Engine abstraction**: Ships with five engines — Claude Code, Codex, Gemini CLI, Aider, and Genesis. Swap between them without reconfiguring projects; TangleClaw generates engine-native config (CLAUDE.md, .codex.yaml, GEMINI.md, .aider.conf.yml) so every agent gets the same rules. Adding a new engine is a single JSON profile — no code changes required
- **Model status monitoring**: Live upstream API status for Claude (Anthropic), Codex (OpenAI), and Gemini (Google) surfaced directly in the session banner so you know before you start typing
- **Session lifecycle**: Prime prompts auto-generated from methodology state, configurable wrap skills, learning capture, idle detection
- **PortHub**: Central port registry preventing conflicts across all projects. Permanent and TTL leases with heartbeat support
- **Setup wizard**: First-run guided setup scans for existing projects, detects engines, and configures preferences
- **Mobile-first PWA**: Installable on iOS and Android. Manage projects, launch sessions, and interact with AI agents from your phone
- **Zero dependencies**: Node.js 22+ stdlib only. No npm install, no build step, no bundler

## Security Note

TangleClaw runs a local HTTP server with browser-based terminal access. There is no authentication on the server itself — anyone who can reach the port can view your projects and open terminal sessions. The `deletePassword` config option protects destructive operations (project deletion, data reset) but does not gate general access.

**Recommendations:**
- Run TangleClaw on a trusted network or behind a VPN (e.g., Tailscale, WireGuard)
- Do not expose TangleClaw ports to the public internet
- If accessing from mobile over Wi-Fi, ensure your network is private

## Prerequisites

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — terminal emulator for browser-based terminal access (`brew install ttyd`)
- **tmux** — session multiplexer (`brew install tmux`)
- **At least one AI CLI engine** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Aider](https://aider.chat). TangleClaw auto-detects which engines are installed and makes them available for your projects.

## Quick Start

```bash
git clone https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
./deploy/install.sh
```

The install script:
1. Checks prerequisites (node 22+, ttyd, tmux)
2. Generates launchd plists with correct paths
3. Installs and loads the services
4. Runs a health check

Access the landing page at **http://localhost:3102**. On first launch, a setup wizard walks you through configuration — including choosing your **projects directory**. This is a single folder where all your managed projects live (e.g., `~/Projects`). TangleClaw scans this directory, detects existing repos and engines, and lets you attach them as managed projects.

## Documentation

- **[User Guide](docs/user-guide.md)** — Getting started, UI walkthrough, mobile setup, troubleshooting
- **[Methodology Guide](docs/methodology-guide.md)** — Built-in templates, creating custom methodologies, rules
- **[Engine Guide](docs/engine-guide.md)** — Built-in engines, creating custom engine profiles
- **[Configuration Reference](docs/configuration-reference.md)** — All config fields, JSON schemas, API overview

## Configuration

Global config lives at `~/.tangleclaw/config.json` (auto-created on first run).

Key settings:
- `serverPort` — Landing page server port (code default: 3101, launchd override: 3102)
- `ttydPort` — ttyd terminal port (code default: 3100, launchd override: 3101)
- `projectsDir` — Root directory for managed projects
- `defaultEngine` — Default AI engine for new projects
- `defaultMethodology` — Default methodology template
- `deletePassword` — Optional password for destructive operations

Engine profiles: `~/.tangleclaw/engines/*.json`
Methodology templates: `~/.tangleclaw/templates/`

See the [Configuration Reference](docs/configuration-reference.md) for all fields, types, and defaults.

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
  port-scanner.js      # Periodic system port conflict detection
  uploads.js           # File upload handling for AI sessions
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
docs/                  # User documentation
```

### Architecture

```
launchd (com.tangleclaw.server)
  └─ node server.js
     ├─ Landing page HTTP server (:3102)
     ├─ API endpoints (/api/*)
     ├─ Reverse proxy /terminal/* → ttyd (:3101)
     └─ Session wrapper HTML serving

launchd (com.tangleclaw.ttyd)
  └─ ttyd --port 3101 tmux attach
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
tail -f ~/.tangleclaw/logs/tangleclaw.log

# Health check
curl -s http://localhost:3102/api/health | python3 -m json.tool
```

## Roadmap

Planned features and improvements — contributions and feedback welcome.

- **TangleMeth** — AI-guided methodology builder. Instead of hand-writing template JSON, TangleMeth interviews you about your governance needs and generates a complete methodology framework: phase docs, enforcement hooks, artifact templates, and test suites. Compose from existing methodologies or fork and modify them. The output is a full methodology directory that TangleClaw loads as a first-class template.
- **Multi-engine sessions** — Launch multiple engines on the same project simultaneously (e.g., Claude Code for implementation, Codex for review)
- **Methodology versioning** — Version and update methodologies already applied to projects without breaking existing sessions
- **Mobile terminal scrollback** — Improved touch scroll handling for xterm.js on iOS and Android

## License

MIT — see [LICENSE](LICENSE). Repository is private during active development.
