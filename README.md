# TangleClaw

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-logo.png?raw=true" alt="TangleClaw logo" width="200">
</p>

<p align="center">
  <strong>AI coding session orchestrator</strong> — persistent sessions, session continuity, multi-engine management, methodology enforcement, secure remote access
</p>

<p align="center">
  <code>claude code</code> &middot; <code>codex</code> &middot; <code>antigravity</code> &middot; <code>aider</code> &middot; <code>openclaw</code> &middot; <code>tmux</code> &middot; <code>pwa</code> &middot; <code>zero dependencies</code>
</p>

<p align="center">
  <strong>macOS only</strong> (launchd required for service management)
</p>

---

You VPN into your dev machine. You SSH in. You navigate to your project directory, fire up an AI coding agent, and start building. Thirty minutes later your VPN hiccups, or your SSH tunnel drops, or your laptop goes to sleep — and the session is gone. The agent's context, your conversation history, everything. There's no way to reconnect. You SSH back in, start over, and re-explain what you were doing.

TangleClaw was built to fix that. It wraps AI coding sessions in persistent tmux processes so they survive network drops, device switches, and reconnects. Close your laptop at your desk, open your phone on the couch, and pick up the exact same session. The agent never knows you left.

What started as session persistence grew into a full orchestration platform — and 4.0 closes the loop on the other half of the problem: **context that survives between sessions, not just within them**. Every session now ends with a structured wrap that writes a per-session summary, rolls a "here's where we left off" resume prime for the next session, and snapshots the full transcript — all searchable from the dashboard. Add password-gated remote access behind a Caddy ingress, a persistent Project Master assistant that watches the whole fleet, per-project routing to local models, and methodology governance delegated to the live Prawduct plugin, and TangleClaw is a complete control plane for AI-assisted development — accessible from any browser or phone on your network.

## Screenshots

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project%20splash%20screen%20with%20sampele%20cards.png?raw=true" alt="TangleClaw dashboard" width="800">
  <br><em>Dashboard — project cards with engine badges, methodology status, git info, and session indicators</em>
</p>

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project%20info%20panel%20expanded.png?raw=true" alt="Project info panel" width="800">
  <br><em>Project detail panel — engine, methodology, active session, git state, settings, and session management</em>
</p>

## What TangleClaw Does

- **Persistent sessions** — AI engine sessions run in tmux, surviving network drops, device switches, and reconnects. Close your laptop, switch devices, pick up where you left off
- **Session continuity** *(new in 4.0)* — every session ends with a structured wrap: a per-session summary, an updated project changelog, and a resume prime so the next session starts with "we left off at X — continue?" instead of a cold open. Full transcripts are snapshotted at wrap and everything is searchable from a per-project **Session History & Search** drawer — filter by date, tags, type, or files touched, then drill from summary into the raw transcript
- **Six built-in engines** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Antigravity](https://antigravity.google/) (Google's Gemini CLI successor), [Gemini CLI](https://github.com/google-gemini/gemini-cli) (sunset by Google June 2026; retirement tracked in #457), [Aider](https://aider.chat), and [OpenClaw](https://github.com/Jason-Vaughan/OpenClaw). Write rules once — TangleClaw generates engine-native config so every agent gets the same instructions
- **Launch mode selector** — pick a permission mode when you start a session: Interactive, Accept Edits, Plan Only, Auto, or Bypass. The mode propagates to the engine natively, including remote OpenClaw sessions via ClawBridge
- **Secure remote access** *(new in 4.0)* — an optional, reversible [Caddy ingress](deploy/INGRESS.md) puts TLS and a password gate in front of everything (dashboard, terminals, APIs), with a break-glass admin reset and machine-to-machine **service tokens** so other projects' scripts can still call the PortHub and shared-docs APIs
- **Project Master** *(new in 4.0)* — a persistent, fleet-aware assistant session (🧠 in the header) that sees cross-project status: what's running, what's idle, what shipped. Available as a landing-page pane and an in-session drawer
- **Methodology enforcement** — pluggable JSON templates define phases, rules, and session behavior. Rules are structural gates, not suggestions. First-class [Prawduct](https://github.com/brookstalley/prawduct) integration — projects governed by the Prawduct V2 plugin get their governance from the plugin itself, with TangleClaw deferring automatically and surfacing drift visibly
- **Session rules & self-improvement** *(new in 4.0)* — durable behavioral directives injected into every session, editable from a per-project Project Rules modal — and the AI can propose rule improvements at wrap time, gated by an independent Critic review with version history and rollback ([docs](docs/session-rules-self-improvement.md))
- **Orchestration profiles** *(new in 4.0)* — bind a project to an OpenAI-compatible endpoint (e.g. a LiteLLM front door serving local models) and its engine launches against it, per project, with no engine-config edits. Key references stay hygienic: `env:`/`file:` indirection, never keys in argv
- **[PortHub](https://github.com/Jason-Vaughan/PortHub) built in** — central port registry preventing conflicts across all projects, with permanent and TTL leases, heartbeats, system-wide conflict detection, and auto-allocation of non-colliding ports for new connections
- **Project groups & shared docs** — link related projects into a group, then share markdown documents across them with per-doc locking. Shared directories auto-sync `.md` files on session launch
- **Project Map & Feature Index** *(new in 4.0)* — self-maintaining project indexes (`PROJECT-MAP.md`, `FEATURES.md`) refreshed at wrap time, so agents stop hunting for where things live
- **Dashboard & mobile PWA** — manage projects, launch sessions, and talk to agents from any browser or phone on your network. Installable on iOS and Android, with one-click **Update & restart** when a new TangleClaw release ships
- **Zero dependencies** — Node.js 22+ stdlib only. No npm install, no build step, no bundler

<details>
<summary>All features</summary>

### Sessions
- **Launch modes** — Interactive / Accept Edits / Plan Only / Auto / Bypass picker on session start for engines that declare `launchModes`. The selected mode is appended to the engine's launch args and recorded in the session DB; OpenClaw sessions propagate it through ClawBridge's `permissionMode`
- **Session briefings** — auto-generated context from methodology state, active learnings, session rules, and the last session's wrap, injected on session start
- **Structured session wrap** — a server-side pipeline (not a prompt) drives close-out: version bumps, changelog updates, learnings capture, memory updates, continuity write, and a single wrap commit. Blocked steps show "How to fix this" remediation in the wrap drawer. Wrap depth is configurable per methodology and per project. Contract: [ADR 0002](docs/adr/0002-wrap-pipeline-contract.md)
- **Degraded-wrap tiers** — when a full AI-assisted wrap isn't possible (no AI channel, remote transport), the wrap still runs mechanically and honestly stamps what it couldn't capture
- **Session ownership & scope guard** — each session knows which project it owns; requests that belong to another project's live session get flagged before any cross-repo damage happens
- **Command bar** — inject commands into running sessions without touching the terminal, with quick pills for common operations
- **Peek** — slide-up drawer showing full terminal scrollback (up to 50,000 lines) with search and live match highlighting
- **Terminal copy & touch that actually work** — plain drag copies terminal text to *your* clipboard (even on a remote browser), one-finger drag scrolls on mobile, long-press selects with a native-style Copy pill
- **File upload** — send files into the project directory from the session wrapper, with flag-only secret scanning (an amber badge warns you; nothing is blocked or scrubbed)
- **Idle chime** — audio notification when the terminal goes idle, so you know the agent has finished

### Continuity (new in 4.0)
- **Per-project continuity store** — `<project>/.tangleclaw/continuity/`: a curated `index.md` hot tier (rewritten each wrap, read back as the next session's resume), an append-only `changelog.md`, per-session 8-section wrap summaries, and a self-maintaining `## Map` of the project's features
- **Transcript capture** — the raw session transcript is snapshotted at wrap (`sessions/<sid>/transcript.jsonl`) with no hooks required, and secret-scanned (types flagged, values never stored)
- **Session History & Search** — a per-project drawer (🔍 on each card): search wrap summaries globally, filter by date/tags/type/files-touched, browse sessions, and drill into full transcripts with match highlighting
- **Session memory** — file-based, per-project memory at `.tangleclaw/memories/` with a `MEMORY.md` index, injected into every engine config so all engines follow the same convention

### Engines
- **Engine-native config generation** — CLAUDE.md, `.codex.yaml`, GEMINI.md, `.aider.conf.yml` generated automatically from your rules, regenerated on every server boot so changes land without a relaunch
- **Custom engines** — adding a new engine is a single JSON profile, no code changes
- **Orchestration launch-binder** — per-project binding to an orchestration profile (`~/.tangleclaw/orchestration-profiles.json`): the engine launches with the profile's base URL, model, and key injected via environment (never argv). Unbound projects launch exactly as before
- **Model status monitoring** — live upstream API status for Claude (Anthropic), Codex (OpenAI), and Gemini (Google) in the session banner

### Methodologies & Governance
- **[Prawduct](https://github.com/brookstalley/prawduct) V2 plugin delegation** — projects governed by the Prawduct Claude Code plugin get governance from the plugin; TangleClaw detects the install and defers (no config clobbering), keeping its own lightweight baseline for everything else. Governance drift is shown, never silent
- **Session rules** — durable per-project behavioral directives with operator editing (Project Rules modal), AI-proposed improvements at wrap, an independent Critic gate on autonomous edits, and full version history with rollback
- **Custom methodologies** — create your own templates with custom phases, rules, actions, wrap contracts, and hooks
- **Global rules** — markdown rules applied to every project across all engines, editable from the dashboard
- **Methodology switching** — switch methodologies on any project with automatic state archival and rollback support

### Dashboard
- **Project management** — create, attach, archive, filter, tag, and delete projects from a central landing page
- **Project Master pane** — persistent fleet-aware assistant session embedded in the landing page and as an in-session drawer ([ADR 0008](docs/adr/0008-project-master-session-model.md))
- **Setup wizard** — first-run guided setup scans for existing projects, detects engines, configures preferences, and walks through HTTPS setup
- **Universal project version detection** — every project's version resolves through a layered chain (`.tangleclaw/project-version.txt` → `CHANGELOG.md` → `version.json` → `package.json`) and shows on the project card and session banner
- **One-click self-update** — the update pill's **Update & restart** button fetches the latest release tag, checks it out with fail-closed guards, and restarts the server
- **Startup project sync** — on every server boot, all engine configs regenerate and memory/scaffolding backfills, so code changes land immediately
- **PortHub** — central port registry with permanent and TTL leases, heartbeats, and next-free-port auto-allocation

### Security & Remote Access
- **Caddy ingress** — optional, reversible reverse-proxy mode (`scripts/ingress-cutover.js`) that fronts the dashboard, terminals, and APIs with TLS and a `basic_auth` password gate. Fail-closed cutover with validation and health checks; full guide in [deploy/INGRESS.md](deploy/INGRESS.md)
- **Forced admin setup** — behind the ingress, the first-run wizard requires creating an admin login before anything else works
- **Break-glass reset** — lost admin password? A local CLI resets it without disabling the gate
- **Service tokens** — machine-to-machine tokens gate the PortHub and shared-docs APIs so other projects' scripts keep working after you lock the ingress down ([ADR 0005](docs/adr/0005-service-tokens.md))
- **User attribution** — when the ingress authenticates a user, TangleClaw records who did what
- **HTTPS via mkcert, one click** — for direct (no-ingress) mode, a wizard generates localhost certs and hot-swaps the server to HTTPS

### Integrations
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** — SSH or Web UI mode, connection registry, health checks, auto SSH tunnels with self-healing, reverse proxy, auto device pairing, and instance version display
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** — live background-process visibility on OpenClaw instances, remote session pre-create with permission modes, and remote wrap capture
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — multi-tiered AI agent evaluation: ingests exchange data, scores with intelligent gating, tracks baselines, detects drift, generates incidents

### Technical
- **115+ registered routes** — full REST API for everything TangleClaw does
- **3,600+ tests** — comprehensive suite using `node:test`, zero test dependencies
- **SQLite storage** — runtime state in a single database file, JSON config for settings
- **ADRs** — durable design decisions live in [docs/adr/](docs/adr/)

</details>

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

### Prerequisites

- **macOS** — TangleClaw uses launchd for service management. Linux support is not yet available
- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal access (`brew install ttyd`)
- **tmux** — session multiplexer (`brew install tmux`)
- **At least one AI CLI engine** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Antigravity](https://antigravity.google/), or [Aider](https://aider.chat)
- **Caddy** *(optional)* — for the password-gated TLS ingress (`brew install caddy`, see [deploy/INGRESS.md](deploy/INGRESS.md))
- **[Prawduct](https://github.com/brookstalley/prawduct)** *(optional)* — governed workflows with discovery, planning, building phases, and independent Critic review
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** *(optional)* — remote AI agent sessions (requires SSH access to the OpenClaw host)
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** *(optional)* — background-process visibility on OpenClaw instances

## How Do I…?

Quick answers, with links into the full docs:

| I want to… | Read this |
|---|---|
| Install TangleClaw and get it running | [Quick Start](#quick-start) above, or the [User Guide — Getting Started](docs/user-guide.md#getting-started) |
| Use it from my phone | [User Guide — PWA Installation](docs/user-guide.md#pwa-installation-mobile) and [Mobile Tips](docs/user-guide.md#mobile-tips) |
| Bring my existing projects in | [User Guide — Attaching Existing Projects](docs/user-guide.md#attaching-existing-projects) |
| Launch an AI session and pick a permission mode | [User Guide — Launching a Session](docs/user-guide.md#launching-a-session) |
| End a session properly (and why wraps matter) | [User Guide — Wrapping a Session](docs/user-guide.md#wrapping-a-session) |
| Find what a past session did, or search old transcripts | [User Guide — Session History](docs/user-guide.md#session-history) |
| Put a password and TLS in front of everything | [Ingress Guide](deploy/INGRESS.md) |
| Reset a lost admin password | [Ingress Guide — break-glass reset](deploy/INGRESS.md#admin-credential-reset-break-glass-auth-2) |
| Share docs between related projects | [User Guide — Project Groups and Shared Documents](docs/user-guide.md#project-groups-and-shared-documents) |
| Connect a remote OpenClaw machine | [OpenClaw Setup](docs/openclaw-setup.md) |
| Point a project's sessions at local models (LiteLLM/Ollama) | Orchestration profiles — edit `~/.tangleclaw/orchestration-profiles.json`, then bind the project in its settings |
| Set up or customize a methodology | [Methodology Guide](docs/methodology-guide.md) |
| Let the AI improve its own session rules (safely) | [Session Rules & Self-Improvement](docs/session-rules-self-improvement.md) |
| Add a custom engine | [Engine Guide](docs/engine-guide.md) |
| Change any config setting | [Configuration Reference](docs/configuration-reference.md) |
| Fix something that's broken | [User Guide — Troubleshooting](docs/user-guide.md#troubleshooting), or [Service Management](#service-management) below |

## Documentation

- **[User Guide](docs/user-guide.md)** — getting started, full UI walkthrough, sessions, groups, mobile setup, troubleshooting
- **[Ingress Guide](deploy/INGRESS.md)** — Caddy reverse proxy, TLS, password gate, break-glass reset, public domains
- **[Methodology Guide](docs/methodology-guide.md)** — built-in templates, creating custom methodologies, rules
- **[Session Rules & Self-Improvement](docs/session-rules-self-improvement.md)** — durable session directives, the Critic gate, version history
- **[Engine Guide](docs/engine-guide.md)** — built-in engines, creating custom engine profiles
- **[Configuration Reference](docs/configuration-reference.md)** — all config fields, JSON schemas, API overview
- **[OpenClaw Setup](docs/openclaw-setup.md)** — remote OpenClaw instances, SSH tunnels, Web UI mode
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — AI agent evaluation pipeline, scoring, baselines, drift detection
- **[Architecture Decision Records](docs/adr/)** — the durable "why" behind the ingress model, wrap pipeline, service tokens, Project Master, and more

## Security

TangleClaw runs a local server with browser-based terminal access. Out of the box (direct mode) there is **no user authentication** — anyone who can reach the port can view your projects and open terminal sessions. The `deletePassword` config option protects destructive operations only.

For anything beyond localhost, use the **Caddy ingress** (4.0): a reversible cutover that fronts the dashboard, terminals, and APIs with TLS and a `basic_auth` password gate, forces admin-account creation on first run, and issues service tokens for machine-to-machine API callers. See [deploy/INGRESS.md](deploy/INGRESS.md).

**Recommendations:**
- **Enable the ingress** (or at minimum mkcert HTTPS) for any non-localhost access
- Run TangleClaw on a trusted network or behind a VPN (e.g., Tailscale, WireGuard)
- Do not expose TangleClaw ports to the public internet without the ingress password gate
- If accessing from mobile over Wi-Fi, ensure your network is private

## Stay Updated

TangleClaw checks for newer releases automatically (a `git ls-remote --tags` against your `origin`, ~60 seconds after server start and every 24 hours after). When a newer tag exists, a pill appears next to the version label — click through to the release notes, dismiss per-version, or press **Update & restart** to have TangleClaw fetch the release, check it out with fail-closed guards, and restart itself.

Manual upgrade path:

```bash
cd <your-TangleClaw-clone>
git pull --ff-only
./deploy/install.sh    # picks up plist changes if any; idempotent
```

> **Note:** if your clone predates the 4.0 rename, the repository was previously named `TangleClaw-v3`. GitHub redirects the old URL, but updating your remote is cleaner: `git remote set-url origin https://github.com/Jason-Vaughan/TangleClaw.git`

## Configuration

Global config lives at `~/.tangleclaw/config.json` (auto-created on first run).

Key settings:
- `serverPort` — landing page server port (code default: 3101, launchd override: 3102)
- `ttydPort` — ttyd terminal port (code default: 3100, launchd override: 3101)
- `projectsDir` — root directory for managed projects
- `defaultEngine` / `defaultMethodology` — defaults for new projects
- `deletePassword` — optional password for destructive operations
- `httpsEnabled` / `httpsCertPath` / `httpsKeyPath` — direct-mode TLS
- `ingressMode` / `caddyHttpsPort` / `caddyHttpPort` / `publicDomain` — Caddy ingress ([guide](deploy/INGRESS.md))

Engine profiles: `~/.tangleclaw/engines/*.json` · Methodology templates: `~/.tangleclaw/templates/` · Orchestration profiles: `~/.tangleclaw/orchestration-profiles.json`

See the [Configuration Reference](docs/configuration-reference.md) for all fields, types, and defaults.

## Development

### Running Tests

```bash
node --test 'test/*.test.js'
```

### Architecture

```
[optional] launchd (com.tangleclaw.caddy)          ← 4.0 ingress mode
  └─ caddy: TLS + basic_auth gate
     └─ reverse proxy → TangleClaw server

launchd (com.tangleclaw.server)
  └─ node server.js
     ├─ Landing page HTTP(S) server (:3102)
     ├─ API endpoints (/api/*)
     ├─ Reverse proxy /terminal/* → ttyd (:3101)
     ├─ Reverse proxy /openclaw/* → SSH tunnel → OpenClaw gateway
     ├─ WebSocket upgrade (ttyd + OpenClaw)
     └─ Session wrapper + OpenClaw viewer HTML serving

launchd (com.tangleclaw.ttyd)
  └─ ttyd --port 3101 tmux attach (PTY-leak watchdog supervised)
     └─ WebSocket terminal access

tmux sessions (spawned on demand)
  ├─ One per active project session (AI engine process)
  └─ tangleclaw-master (reserved) — the Project Master session

SSH tunnels (spawned on demand)
  └─ One per active OpenClaw connection
     ├─ Gateway port forward
     └─ ClawBridge port forward (sidecar)
```

For a maintained map of features → source files, see [FEATURES.md](FEATURES.md). Durable design decisions live in [docs/adr/](docs/adr/).

### Git Hooks

Reference hooks are provided in `hooks/`. To install:

```bash
cp hooks/pre-commit hooks/commit-msg hooks/post-commit .git/hooks/
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg .git/hooks/post-commit
```

- **pre-commit**: runs the full test suite
- **commit-msg**: validates first line is non-empty and ≤72 characters
- **post-commit**: tags the version from `version.json` on the main branch

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

- **Session Switchboard** — inter-session agent messaging, so sessions can coordinate directly instead of through the operator
- **Project Master actions** — today the Master assistant is read-only; next it acts (confirm-gated) on your behalf across the fleet
- **TangleMeth** — AI-guided methodology builder: an interview generates a complete methodology framework (phase docs, enforcement hooks, artifact templates, test suites) instead of hand-written JSON
- **Cross-model governance** — extend the deeper governance layers beyond Claude Code to the other engines
- **Multi-engine sessions** — launch multiple engines on the same project simultaneously (e.g., Claude Code for implementation, Codex for review)
- **Sidecar controls** — poll, refresh, dismiss, and terminate individual background processes from the detail panel
- **Linux support** — systemd service management as an alternative to launchd

## License

MIT — see [LICENSE](LICENSE).
