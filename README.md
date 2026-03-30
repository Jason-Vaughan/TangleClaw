# TangleClaw v3

<p align="center">
  <img src="https://github.com/Jason-Vaughan/puberty-labs-assets/blob/main/tangleclaw-logo.png?raw=true" alt="TangleClaw logo" width="200">
</p>

<p align="center">
  <strong>AI coding session orchestrator</strong> — persistent sessions, multi-engine management, methodology enforcement, mobile access
</p>

<p align="center">
  <code>claude code</code> &middot; <code>codex</code> &middot; <code>gemini cli</code> &middot; <code>aider</code> &middot; <code>openclaw</code> &middot; <code>tmux</code> &middot; <code>pwa</code> &middot; <code>zero dependencies</code>
</p>

---

You VPN into your dev machine. You SSH in. You navigate to your project directory, fire up an AI coding agent, and start building. Thirty minutes later your VPN hiccups, or your SSH tunnel drops, or your laptop goes to sleep — and the session is gone. The agent's context, your conversation history, everything. There's no way to reconnect. You SSH back in, start over, and re-explain what you were doing.

TangleClaw was built to fix that. It wraps AI coding sessions in persistent tmux processes so they survive network drops, device switches, and reconnects. Close your laptop at your desk, open your phone on the couch, and pick up the exact same session. The agent never knows you left.

What started as session persistence grew into a full orchestration platform. Once you have persistent sessions, you start wanting a dashboard to manage them. Then you want your development methodology enforced as structural rules, not suggestions the agent can ignore. Then you want engine-native config generated automatically so Claude Code, Codex, Gemini CLI, and Aider all get the same instructions without you maintaining four different config files. Then you want port conflict management across projects, mobile access, idle detection, session wrap protocols.

TangleClaw is all of that — a local platform that sits between you and your AI coding agents, accessible from any browser or phone on your network.

## Features

### Sessions

- **Persistent sessions** — AI engine sessions run in tmux, surviving network drops, device switches, and reconnects
- **Prime prompts** — auto-generated from methodology state, active learnings, and last session summary, injected on session start
- **Wrap protocol** — configurable session wrap with version bumps, changelog updates, learnings capture, and next-session priming
- **Command bar** — inject commands into running sessions without touching the terminal. Quick command pills for common operations and engine-specific slash commands
- **Peek** — slide-up drawer showing the last lines of terminal output — check progress without scrolling
- **File upload** — send files into the project directory from the session wrapper (images, docs, configs up to 15 MB)
- **Idle detection** — audio chime when the terminal goes idle, so you know the agent has finished
- **Session history** — start time, duration, engine, wrap status, and wrap summary per project

### Engines

- **Six built-in engines** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Aider](https://aider.chat), Genesis, and [OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)
- **Engine-native config generation** — write rules once, TangleClaw translates to CLAUDE.md, .codex.yaml, GEMINI.md, .aider.conf.yml. Swap engines without reconfiguring projects
- **Custom engines** — adding a new engine is a single JSON profile, no code changes
- **Model status monitoring** — live upstream API status for Claude (Anthropic), Codex (OpenAI), and Gemini (Google) in the session banner

### Methodologies

- **Methodology-as-code** — pluggable JSON templates that define phases, rules, wrap behavior, prime prompts, and status contracts. Rules are structural gates, not suggestions
- **[Prawduct](https://github.com/brookstalley/prawduct) integration** — first-class support for structured governance with discovery, planning, building phases, independent Critic review, and continuous learning. Installed separately; TangleClaw auto-detects and integrates
- **Custom methodologies** — create your own templates with custom phases, rules, actions, and hooks
- **Global rules** — markdown rules applied to every project across all engines, editable from the dashboard
- **Methodology switching** — switch methodologies on any project with automatic state archival and rollback support

### Dashboard

- **Project management** — create, attach, filter, tag, and delete projects from a central landing page
- **Setup wizard** — first-run guided setup scans for existing projects, detects engines, configures preferences
- **Project groups & shared documents** — group related projects, share markdown documents across groups, auto-discover from shared directories, document locking
- **Mobile-first PWA** — installable on iOS and Android with 44px touch targets, safe area support, pull-to-refresh
- **PortHub** — central port registry preventing conflicts across all projects. Permanent and TTL leases with heartbeat support, system port scanning via lsof
- **HTTPS/TLS** — optional TLS via mkcert for secure remote access (required for OpenClaw Web UI from non-localhost browsers)

### Integrations

- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** — connect to remote self-hosted AI agent instances via SSH or Web UI mode. Connection registry with health checks, automatic SSH tunnel management, reverse proxy for same-origin iframe embedding, and auto device pairing
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** — bridge service running alongside OpenClaw that exposes background process status. TangleClaw's sidecar polls ClawBridge for live process visibility — status pills, detail panels with timestamps, exit codes, attention flags, and last output
- **[Prawduct](https://github.com/brookstalley/prawduct)** — structured product development framework. TangleClaw detects Prawduct projects, wires session hooks for briefings and governance gates, reads project state for dashboard badges, and syncs framework updates on each session start
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — multi-tiered AI agent evaluation system. Ingests exchange data from OpenClaw instances, runs a scoring pipeline with intelligent gating, tracks quality baselines, detects drift, and generates incidents

### Technical

- **Zero dependencies** — Node.js 22+ stdlib only. No npm install, no build step, no bundler
- **62 API endpoints** — full REST API for everything TangleClaw does
- **1,314 tests** — comprehensive test suite using node:test
- **SQLite storage** — runtime state in a single database file, JSON config for settings

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

## Prerequisites

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal access (`brew install ttyd`)
- **tmux** — session multiplexer (`brew install tmux`)
- **At least one AI CLI engine** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Aider](https://aider.chat)
- **[Prawduct](https://github.com/brookstalley/prawduct)** *(optional)* — install separately for governed workflows with discovery, planning, building phases, and independent Critic review
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** *(optional)* — for remote AI agent sessions. Requires SSH access to the OpenClaw host
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** *(optional)* — for background process visibility on OpenClaw instances

## Security Note

TangleClaw runs a local HTTP server with browser-based terminal access. There is no authentication on the server itself — anyone who can reach the port can view your projects and open terminal sessions. The `deletePassword` config option protects destructive operations (project deletion, data reset) but does not gate general access.

**Recommendations:**
- Run TangleClaw on a trusted network or behind a VPN (e.g., Tailscale, WireGuard)
- Do not expose TangleClaw ports to the public internet
- If accessing from mobile over Wi-Fi, ensure your network is private

## Documentation

- **[User Guide](docs/user-guide.md)** — Getting started, UI walkthrough, mobile setup, troubleshooting
- **[Methodology Guide](docs/methodology-guide.md)** — Built-in templates, creating custom methodologies, rules
- **[Engine Guide](docs/engine-guide.md)** — Built-in engines, creating custom engine profiles
- **[Configuration Reference](docs/configuration-reference.md)** — All config fields, JSON schemas, API overview
- **[OpenClaw Setup](docs/OPENCLAW-SETUP.md)** — Connecting to remote OpenClaw instances, SSH tunnels, Web UI mode, HTTPS
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — AI agent evaluation pipeline, scoring, baselines, drift detection

## Configuration

Global config lives at `~/.tangleclaw/config.json` (auto-created on first run).

Key settings:
- `serverPort` — Landing page server port (code default: 3101, launchd override: 3102)
- `ttydPort` — ttyd terminal port (code default: 3100, launchd override: 3101)
- `projectsDir` — Root directory for managed projects
- `defaultEngine` — Default AI engine for new projects
- `defaultMethodology` — Default methodology template
- `deletePassword` — Optional password for destructive operations
- `httpsEnabled` / `httpsCertPath` / `httpsKeyPath` — TLS configuration

Engine profiles: `~/.tangleclaw/engines/*.json`
Methodology templates: `~/.tangleclaw/templates/`

See the [Configuration Reference](docs/configuration-reference.md) for all fields, types, and defaults.

## Development

### Running Tests

```bash
node --test 'test/*.test.js'
```

### Architecture

```
launchd (com.tangleclaw.server)
  └─ node server.js
     ├─ Landing page HTTP server (:3102)
     ├─ API endpoints (/api/*)
     ├─ Reverse proxy /terminal/* → ttyd (:3101)
     ├─ Reverse proxy /openclaw/* → SSH tunnel → OpenClaw gateway
     ├─ WebSocket upgrade (ttyd + OpenClaw)
     └─ Session wrapper + OpenClaw viewer HTML serving

launchd (com.tangleclaw.ttyd)
  └─ ttyd --port 3101 tmux attach
     └─ WebSocket terminal access

tmux sessions (spawned on demand)
  └─ One per active project session
     └─ AI engine process (claude, codex, gemini, aider)

SSH tunnels (spawned on demand)
  └─ One per active OpenClaw connection
     ├─ Gateway port forward (18789)
     └─ ClawBridge port forward (3201, sidecar)
```

<details>
<summary>Project Structure</summary>

```
server.js              # HTTP server, API routes, reverse proxy, WebSocket upgrade
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
  tunnel.js            # SSH tunnel manager for OpenClaw connections
  sidecar.js           # Background process visibility (ClawBridge polling)
  model-status.js      # Upstream API status monitoring
  eval-audit.js        # AI agent evaluation pipeline
  update-checker.js    # Version update checks
  pidfile.js           # PID file management
public/
  index.html           # Landing page
  session.html         # Session wrapper page
  openclaw-view.html   # OpenClaw direct-connect viewer
  style.css            # Landing page styles
  session.css          # Session wrapper styles
  landing.js           # Landing page logic
  ui.js                # Landing page UI rendering
  session.js           # Session wrapper logic
  openclaw-view.js     # OpenClaw viewer logic (sidecar pills, detail panel)
  setup.js             # First-run setup wizard
  manifest.json        # PWA manifest
  sw.js                # Service worker
data/
  engines/             # Bundled engine profiles (claude, codex, gemini, aider, genesis, openclaw)
  templates/           # Bundled methodology templates
test/                  # Test files (node:test, 1314 tests)
deploy/                # launchd plists and install script
hooks/                 # Git hooks (reference, not auto-installed)
docs/                  # User documentation
```

</details>

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

- **TangleMeth** — AI-guided methodology builder. Instead of hand-writing template JSON, TangleMeth interviews you about your governance needs and generates a complete methodology framework: phase docs, enforcement hooks, artifact templates, and test suites. Compose from existing methodologies or fork and modify them
- **BitchBoard** — Multi-agent switchboard for coordinating parallel AI sessions across projects
- **Multi-engine sessions** — Launch multiple engines on the same project simultaneously (e.g., Claude Code for implementation, Codex for review)
- **Sidecar controls** — Poll/refresh individual processes, show full output, dismiss, terminate from the detail panel
- **Mobile terminal scrollback** — Improved touch scroll handling for xterm.js on iOS and Android

## License

MIT — see [LICENSE](LICENSE).
