# TangleClaw v3

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-logo.png?raw=true" alt="TangleClaw logo" width="200">
</p>

<p align="center">
  <strong>AI coding session orchestrator</strong> — persistent sessions, multi-engine management, methodology enforcement, mobile access
</p>

<p align="center">
  <code>claude code</code> &middot; <code>codex</code> &middot; <code>gemini cli</code> &middot; <code>aider</code> &middot; <code>openclaw</code> &middot; <code>tmux</code> &middot; <code>pwa</code> &middot; <code>zero dependencies</code>
</p>

<p align="center">
  <strong>macOS only</strong> (launchd required for service management)
</p>

---

You VPN into your dev machine. You SSH in. You navigate to your project directory, fire up an AI coding agent, and start building. Thirty minutes later your VPN hiccups, or your SSH tunnel drops, or your laptop goes to sleep — and the session is gone. The agent's context, your conversation history, everything. There's no way to reconnect. You SSH back in, start over, and re-explain what you were doing.

TangleClaw was built to fix that. It wraps AI coding sessions in persistent tmux processes so they survive network drops, device switches, and reconnects. Close your laptop at your desk, open your phone on the couch, and pick up the exact same session. The agent never knows you left.

What started as session persistence grew into a full orchestration platform. Once you have persistent sessions, you start wanting a dashboard to manage them. Then you want your development methodology enforced as structural rules, not suggestions the agent can ignore. Then you want engine-native config generated automatically so Claude Code, Codex, Gemini CLI, and Aider all get the same instructions without you maintaining four different config files. Then you want port conflict management across projects, mobile access, idle detection, session wrap protocols.

TangleClaw is all of that — a local platform that sits between you and your AI coding agents, accessible from any browser or phone on your network. Project groups with shared markdown docs, per-session launch-mode selection (from fully interactive to full-autonomy sandboxed), file-based session memory that persists across restarts, a one-click mkcert HTTPS wizard, and a universal project-version detection chain are all wired in.

## Screenshots

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project%20splash%20screen%20with%20sampele%20cards.png?raw=true" alt="TangleClaw dashboard" width="800">
  <br><em>Dashboard — project cards with engine badges, methodology status, git info, and session indicators</em>
</p>

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project%20info%20panel%20expanded.png?raw=true" alt="Project info panel" width="800">
  <br><em>Project detail panel — engine, methodology, active session, git state, settings, and session management</em>
</p>

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/porthub-registry%20list%20example.png?raw=true" alt="PortHub registry" width="800">
  <br><em>PortHub registry — all port leases grouped by project with conflict detection</em>
</p>

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/launch%20mode%20selector%20modal.png?raw=true" alt="Launch mode selector" width="480">
  <br><em>Launch mode selector — pick per-session permission mode (Interactive / Accept Edits / Plan Only / Auto / Bypass)</em>
</p>

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/shared%20directories%20and%20files%20between%20groups%20modal.png?raw=true" alt="Shared directories between groups" width="800">
  <br><em>Project groups & shared docs — link related projects and share markdown across them with doc locking</em>
</p>

## Features

- **Persistent sessions** — AI engine sessions run in tmux, surviving network drops, device switches, and reconnects. Close your laptop, switch devices, pick up where you left off
- **Five built-in engines** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Aider](https://aider.chat), and [OpenClaw](https://github.com/Jason-Vaughan/OpenClaw). Write rules once — TangleClaw generates engine-native config so every agent gets the same instructions
- **Launch mode selector** — pick a permission mode when you start a session: Interactive (prompt on every action), Accept Edits (auto-accept file reads and edits), Plan Only (read-only, no code changes), Auto (full autonomy with safety classifier), or Bypass (accepts everything — containers/VMs only). Engines without `launchModes` launch as before; Claude Code ships with all five wired in
- **Project groups & shared docs** — link related projects into a group, then share markdown documents across them (architecture notes, network diagrams, runbooks) with per-doc locking so two sessions can't step on each other. Shared directories auto-sync `.md` files on session launch
- **Session memory** — file-based, per-project memory system at `.tangleclaw/memories/` that persists context across AI sessions. The guide is injected into every engine config so Claude, Codex, Gemini, and Aider all read and update it the same way
- **Methodology enforcement** — pluggable JSON templates define phases, rules, and session behavior. Rules are structural gates, not suggestions. First-class [Prawduct](https://github.com/brookstalley/prawduct) integration for governed workflows with independent Critic review
- **[PortHub](https://github.com/Jason-Vaughan/PortHub) built in** — central port registry preventing conflicts across all projects. Originally a [standalone CLI](https://github.com/Jason-Vaughan/PortHub), now fully integrated into TangleClaw with permanent and TTL leases, heartbeat support, and system-wide conflict detection via lsof
- **HTTPS via mkcert, one click** — first-run wizard detects mkcert, generates localhost certs into `~/.tangleclaw/certs/`, and hot-swaps the server to HTTPS with a restart overlay. Required for OpenClaw Web UI device pairing; optional manual-cert and skip paths also supported
- **Dashboard & mobile PWA** — manage projects, launch sessions, and interact with AI agents from any browser or phone on your network. Installable on iOS and Android. Archive projects you're not touching, get an update-available pill when a new TangleClaw ships, and see model status for Claude/OpenAI/Google in the session banner
- **OpenClaw integration** — connect to remote [OpenClaw](https://github.com/Jason-Vaughan/OpenClaw) instances via SSH or Web UI mode with automatic SSH tunnel management, and live background process visibility via [ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)
- **Universal project version detection** — every project's current version is resolved through a layered chain: `.tangleclaw/project-version.txt` (AI-recorded) → `CHANGELOG.md` → `version.json` → `package.json`. The session wrap re-records it, so the dashboard badge stays honest across any project convention
- **Zero dependencies** — Node.js 22+ stdlib only. No npm install, no build step, no bundler

<details>
<summary>All features</summary>

### Sessions
- **Launch modes** — Interactive / Accept Edits / Plan Only / Auto / Bypass picker on session start for engines that declare `launchModes`. The selected mode is appended to the engine's launch args and recorded in the session DB
- **Session briefings** — auto-generated context from methodology state, active learnings, and last session summary, injected on session start
- **Structured session wrap** — configurable close-out with version bumps, changelog updates, learnings capture, and next-session priming
- **Session memory** — per-project `.tangleclaw/memories/` directory with a `MEMORY.md` index. Auto-scaffolded on project init; engine configs include the read/update instructions so every AI follows the same memory convention
- **Command bar** — inject commands into running sessions without touching the terminal. Quick command pills for common operations and engine-specific slash commands
- **Peek** — slide-up drawer showing full terminal scrollback (up to 50,000 lines), with search (Cmd/Ctrl+F), live match highlighting, and alternate-screen-aware capture for TUI engines like Codex
- **File upload** — send files into the project directory from the session wrapper (images, docs, configs up to 15 MB)
- **Idle chime** — audio notification when the terminal goes idle, so you know the agent has finished
- **Session history** — start time, duration, engine, wrap status, and wrap summary per project

### Engines
- **Engine-native config generation** — CLAUDE.md, .codex.yaml, GEMINI.md, .aider.conf.yml generated automatically from your rules
- **Custom engines** — adding a new engine is a single JSON profile, no code changes
- **Model status monitoring** — live upstream API status for Claude (Anthropic), Codex (OpenAI), and Gemini (Google) in the session banner

### Methodologies
- **[Prawduct](https://github.com/brookstalley/prawduct) integration** — discovery, planning, building phases with independent Critic review and continuous learning. Installed separately; TangleClaw auto-detects and integrates
- **Custom methodologies** — create your own templates with custom phases, rules, actions, and hooks
- **Global rules** — markdown rules applied to every project across all engines, editable from the dashboard
- **Methodology switching** — switch methodologies on any project with automatic state archival and rollback support

### Dashboard
- **Project management** — create, attach, archive/unarchive, filter, tag, and delete projects from a central landing page. Attaching an unregistered project shows a confirmation dialog explaining what scaffolding will be generated before it registers
- **Setup wizard** — first-run guided setup scans for existing projects (including plain folders with `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, etc.), detects engines, configures preferences, and walks through HTTPS setup
- **Project groups & shared documents** — group related projects, share markdown documents across groups with document locking, and auto-sync `.md` files from a group's shared directory on session launch
- **Universal project version detection** — every project's version is resolved from a layered chain (`.tangleclaw/project-version.txt` → `CHANGELOG.md` → `version.json` → `package.json`) and shown on the project card and session banner
- **Update notification pill** — landing page shows a pill when a newer TangleClaw version is available, with dismiss-per-version persistence
- **Startup project sync** — on every server boot, all engine configs regenerate and memory/scaffolding backfills for existing projects, so code changes land immediately without a session relaunch
- **PortHub** — central port registry preventing conflicts across all projects. Permanent and TTL leases with heartbeat support
- **HTTPS/TLS** — one-click mkcert setup wizard that generates `cert.pem`/`key.pem` into `~/.tangleclaw/certs/` with correct perms, plus manual-cert and skip paths. Server hot-switches between HTTP and HTTPS on save with a restart overlay

### Integrations
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** — SSH or Web UI mode, connection registry, health checks, auto SSH tunnels, reverse proxy, auto device pairing
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** — live background process visibility — status pills, detail panels with timestamps, exit codes, attention flags
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — multi-tiered AI agent evaluation. Ingests exchange data from OpenClaw, scores with intelligent gating, tracks baselines, detects drift, generates incidents

### Technical
- **62 API endpoints** — full REST API for everything TangleClaw does
- **1,314 tests** — comprehensive test suite using node:test
- **SQLite storage** — runtime state in a single database file, JSON config for settings

</details>

## Prerequisites

- **macOS** — TangleClaw uses launchd for service management. Linux support is not yet available
- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal access (`brew install ttyd`)
- **tmux** — session multiplexer (`brew install tmux`)
- **At least one AI CLI engine** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Aider](https://aider.chat)
- **[Prawduct](https://github.com/brookstalley/prawduct)** *(optional)* — install separately for governed workflows with discovery, planning, building phases, and independent Critic review
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** *(optional)* — for remote AI agent sessions. Requires SSH access to the OpenClaw host
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** *(optional)* — for background process visibility on OpenClaw instances

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

## Security Note

TangleClaw runs an HTTP or HTTPS server with browser-based terminal access. HTTPS is supported via mkcert or any TLS certificate — enable it in config with `httpsEnabled`, `httpsCertPath`, and `httpsKeyPath`. There is no user authentication on the server itself — anyone who can reach the port can view your projects and open terminal sessions. The `deletePassword` config option protects destructive operations (project deletion, data reset) but does not gate general access.

**Recommendations:**
- **Enable HTTPS** for any non-localhost access (required for OpenClaw Web UI device pairing)
- Run TangleClaw on a trusted network or behind a VPN (e.g., Tailscale, WireGuard)
- Do not expose TangleClaw ports to the public internet
- If accessing from mobile over Wi-Fi, ensure your network is private

## Documentation

- **[User Guide](docs/user-guide.md)** — Getting started, UI walkthrough, mobile setup, troubleshooting
- **[Methodology Guide](docs/methodology-guide.md)** — Built-in templates, creating custom methodologies, rules
- **[Engine Guide](docs/engine-guide.md)** — Built-in engines, creating custom engine profiles
- **[Configuration Reference](docs/configuration-reference.md)** — All config fields, JSON schemas, API overview
- **[OpenClaw Setup](docs/openclaw-setup.md)** — Connecting to remote OpenClaw instances, SSH tunnels, Web UI mode, HTTPS
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
- **Multi-engine sessions** — Launch multiple engines on the same project simultaneously (e.g., Claude Code for implementation, Codex for review)
- **Sidecar controls** — Poll/refresh individual processes, show full output, dismiss, terminate from the detail panel
- **Linux support** — systemd service management as an alternative to launchd
- **Mobile terminal scrollback** — Improved touch scroll handling for xterm.js on iOS and Android

## License

MIT — see [LICENSE](LICENSE).
