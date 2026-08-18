# TangleClaw

<p align="center">
  <img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-logo.png?raw=true" alt="TangleClaw logo" width="200">
</p>

<p align="center">
  <strong>AI coding session orchestrator</strong> — persistent sessions, session continuity, multi-engine management, governance delegation, secure remote access
</p>

<p align="center">
  <code>claude code</code> &middot; <code>codex</code> &middot; <code>antigravity</code> &middot; <code>aider</code> &middot; <code>openclaw</code> &middot; <code>tmux</code> &middot; <code>pwa</code> &middot; <code>zero dependencies</code>
</p>

<p align="center">
  <strong>macOS only</strong> (launchd required for service management)
</p>

<p align="center">
  <a href="https://github.com/Jason-Vaughan/TangleClaw/actions/workflows/test.yml"><img src="https://github.com/Jason-Vaughan/TangleClaw/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/Jason-Vaughan/TangleClaw/releases/latest"><img src="https://img.shields.io/github/v/release/Jason-Vaughan/TangleClaw?color=blue" alt="Release"></a>
  <a href="#prerequisites"><img src="https://img.shields.io/badge/npm%20dependencies-zero-purple" alt="Zero npm dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
</p>

```bash
# Quickstart (macOS) — prerequisites and what the installer does: Quick Start, below
git clone --branch v5.7.0 https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw && ./deploy/install.sh
```

---

You VPN into your dev machine. You SSH in. You navigate to your project directory, fire up an AI coding agent, and start building. Thirty minutes later your VPN hiccups, or your SSH tunnel drops, or your laptop goes to sleep — and the session is gone. The agent's context, your conversation history, everything. There's no way to reconnect. You SSH back in, start over, and re-explain what you were doing.

TangleClaw was built to fix that. It wraps AI coding sessions in persistent tmux processes so they survive network drops, device switches, and reconnects. Close your laptop at your desk, open your phone on the couch, and pick up the exact same session. The agent never knows you left.

What started as session persistence grew into a full orchestration platform — and 4.0 closes the loop on the other half of the problem: **context that survives between sessions, not just within them**. Every session now ends with a structured wrap that writes a per-session summary, rolls a "here's where we left off" resume prime for the next session, and snapshots the full transcript — all searchable from the dashboard. Add password-gated remote access behind a Caddy ingress, a persistent Project Master assistant that watches the whole fleet, per-project routing to local models, and governance delegated to the live Prawduct plugin, and TangleClaw is a complete control plane for AI-assisted development — reachable from any browser or phone once you put it behind the login gate.

## Screenshots

<sub><em>Click any screenshot to open it full size.</em></sub>

<table>
<tr>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/dashboard.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/dashboard.png?raw=true" width="400" alt="TangleClaw dashboard"></a>
  <br><sub><b>Dashboard</b> — every managed project with engine badges, git info, and session indicators</sub>
</td>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-info-drawer.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-info-drawer.png?raw=true" width="400" alt="Project detail panel"></a>
  <br><sub><b>Project detail panel</b> — engine, active session, git state, groups, and session management</sub>
</td>
</tr>
<tr>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/session-history-search.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/session-history-search.png?raw=true" width="400" alt="Session History and Search"></a>
  <br><sub><b>Session History &amp; Search</b> <i>(new in 4.0)</i> — every wrapped session, searchable across summaries and full transcripts; filter by date, type, tags, files touched</sub>
</td>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/session-view-switchboard.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/session-view-switchboard.png?raw=true" width="400" alt="In-session view with the Session Switchboard control"></a>
  <br><sub><b>In-session view</b> — the terminal wrapper with the command bar, wrap/peek controls, and the <b>Session Switchboard</b> control (the two heads beside <i>Wrap</i>)</sub>
</td>
</tr>
<tr>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-master.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-master.png?raw=true" width="400" alt="Project Master"></a>
  <br><sub><b>Project Master</b> <i>(new in 4.0)</i> — a persistent fleet assistant that pops open as a drawer inside any session (and as a landing-page pane): what's running, what's idle, what shipped</sub>
</td>
<td width="50%" align="center" valign="top">
  <a href="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-settings.png?raw=true"><img src="https://github.com/Jason-Vaughan/project-assets/blob/main/tangleclaw-screenshots/project-settings.png?raw=true" width="400" alt="Project settings"></a>
  <br><sub><b>Project settings</b> — per-project engine, tags, Project Map / Feature Index, auto version bump, and the <b>Enable Medusa session comms</b> switch</sub>
</td>
</tr>
</table>

## What TangleClaw Does

- **Persistent sessions** — AI engine sessions run in tmux, surviving network drops, device switches, and reconnects. Close your laptop, switch devices, pick up where you left off
- **Session continuity** *(new in 4.0)* — every session ends with a structured wrap: a per-session summary, an updated project changelog, and a resume prime so the next session starts with "we left off at X — continue?" instead of a cold open. Full transcripts are snapshotted at wrap and everything is searchable from a per-project **Session History & Search** drawer — filter by date, tags, type, or files touched, then drill from summary into the raw transcript
- **Four local engines, plus remote OpenClaw** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Antigravity](https://antigravity.google/) (Google's Gemini CLI successor), and [Aider](https://aider.chat) run locally; [OpenClaw](https://github.com/Jason-Vaughan/OpenClaw) sessions run on a remote host and attach through its connection registry. Write rules once — TangleClaw generates engine-native config so every agent gets the same instructions
- **Launch mode selector** — pick a permission mode when you start a session: Interactive, Accept Edits, Plan Only, Auto, or Bypass. The mode propagates to the engine natively, including remote OpenClaw sessions via ClawBridge
- **Secure remote access** *(new in 4.0)* — a reversible [Caddy ingress](deploy/INGRESS.md), set up for you during first-run setup, puts TLS and a password gate in front of everything (dashboard, terminals, APIs), with a break-glass admin reset and machine-to-machine **service tokens** so other projects' scripts can still call the PortHub and shared-docs APIs
- **Project Master** *(new in 4.0)* — a persistent, fleet-aware assistant session (🧠 in the header) that sees cross-project status: what's running, what's idle, what shipped. Available as a landing-page pane and an in-session drawer
- **Session Switchboard** *(beta)* — direct session-to-session messaging, so sessions coordinate with each other instead of routing everything through you. A two-head control in the session banner shows honest listener status and lights up on inbound *and* outbound messages, with a per-project auto-enable toggle. **Functionally in beta:** receiving, status, and **outbound send** (pick another session from a live roster; honest delivered-vs-queued feedback) are all live; deeper v2 automation (auto-inject, swarm stats) is still ahead
- **Governance delegation** — first-class [Prawduct](https://github.com/brookstalley/prawduct) integration: projects governed by the Prawduct V2 plugin get their governance from the plugin itself, with TangleClaw detecting the install, deferring automatically, and flagging projects still on the legacy vendored hook
- **Session rules & self-improvement** *(new in 4.0)* — durable behavioral directives injected into every session, editable from a per-project Project Rules modal — and the AI can propose rule improvements at wrap time, gated by an independent Critic review with version history and rollback ([docs](docs/session-rules-self-improvement.md))
- **Orchestration profiles** *(new in 4.0)* — bind a project to an OpenAI-compatible endpoint (e.g. a LiteLLM front door serving local models) and its engine launches against it, per project, with no engine-config edits. Key references stay hygienic: `env:`/`file:` indirection, never keys in argv
- **[PortHub](https://github.com/Jason-Vaughan/PortHub) built in** — central port registry preventing conflicts across all projects, with permanent and TTL leases, heartbeats, system-wide conflict detection, and auto-allocation of non-colliding ports for new connections
- **Project groups & shared docs** — link related projects into a group, then share markdown documents across them with per-doc locking. Shared directories auto-sync `.md` files on session launch
- **Project Map & Feature Index** *(new in 4.0)* — self-maintaining project indexes (`PROJECT-MAP.md`, `FEATURES.md`) refreshed at wrap time, so agents stop hunting for where things live
- **Dashboard & mobile PWA** — manage projects, launch sessions, and talk to agents from any browser or phone on your network. Installable on iOS and Android, with one-click **Update now** when a new TangleClaw release ships
- **Zero dependencies** — Node.js 22+ stdlib only. No npm install, no build step, no bundler

<details>
<summary>All features</summary>

### Sessions
- **Launch modes** — Interactive / Accept Edits / Plan Only / Auto / Bypass picker on session start for engines that declare `launchModes`. The selected mode is appended to the engine's launch args and recorded in the session DB; OpenClaw sessions propagate it through ClawBridge's `permissionMode`
- **Session briefings** — auto-generated context from project state, active learnings, session rules, and the last session's wrap, injected on session start
- **Structured session wrap** — a server-side pipeline (not a prompt) drives close-out: version bumps, changelog updates, learnings capture, memory updates, continuity write, and a single wrap commit. Blocked steps show "How to fix this" remediation in the wrap drawer. Wrap depth is configurable per project. Contract: [ADR 0002](docs/adr/0002-wrap-pipeline-contract.md)
- **Degraded-wrap tiers** — when a full AI-assisted wrap isn't possible (no AI channel, remote transport), the wrap still runs mechanically and honestly stamps what it couldn't capture
- **Session ownership & scope guard** — each session knows which project it owns; requests that belong to another project's live session get flagged before any cross-repo damage happens
- **Command bar** — inject commands into running sessions without touching the terminal, with quick pills for common operations
- **Peek** — slide-up drawer showing full terminal scrollback (up to 50,000 lines) with search and live match highlighting
- **Terminal copy & touch that actually work** — plain drag copies terminal text to *your* clipboard (even on a remote browser), one-finger drag scrolls on mobile, long-press selects with a native-style Copy pill
- **File upload** — send files into the project directory from the session wrapper, with flag-only secret scanning (an amber badge warns you; nothing is blocked or scrubbed)
- **Idle chime** — audio notification when the terminal goes idle, so you know the agent has finished
- **Session Switchboard** *(beta)* — inter-session messaging over a lightweight listener each session registers on launch. The banner control (two facing heads) carries listener state — off / connecting / listening / error — never by color alone: the accessible label announces state, an unread badge counts inbound messages, the inbound head lights on each new arrival, and an aria-live region announces them. To **send**, the ➤ compose button opens a target picker built from the live roster of other sessions and reports the honest outcome — delivered, or queued when the recipient is offline — never a blanket "sent"; the outbound head lights on a successful send. A per-project **Enable session comms** toggle (default off) auto-starts the listener for new sessions of that project; the banner control is the per-session override. Session end (kill or wrap) tears the listener down so it leaves no ghost peer

### Continuity (new in 4.0)
- **Per-project continuity store** — `<project>/.tangleclaw/continuity/`: a curated `index.md` hot tier (rewritten each wrap, read back as the next session's resume), an append-only `changelog.md`, per-session 8-section wrap summaries, and a self-maintaining `## Map` of the project's features
- **Transcript capture** — the raw session transcript is snapshotted at wrap (`sessions/<sid>/transcript.jsonl`) with no hooks required, and secret-scanned (types flagged, values never stored)
- **Session History & Search** — a per-project drawer (🔍 on each card): search wrap summaries globally, filter by date/tags/type/files-touched, browse sessions, and drill into full transcripts with match highlighting
- **Session memory** — file-based, per-project memory at `.tangleclaw/memories/` with a `MEMORY.md` index, injected into every engine config so all engines follow the same convention

### Engines
- **Engine-native config generation** — CLAUDE.md, `.codex.yaml`, `.antigravity.md`, `.aider.conf.yml` generated automatically from your rules, regenerated on every server boot so changes land without a relaunch
- **Custom engines** — adding a new engine is a single JSON profile, no code changes
- **Orchestration launch-binder** — per-project binding to an orchestration profile (`~/.tangleclaw/orchestration-profiles.json`): the engine launches with the profile's base URL, model, and key injected via environment (never argv). Unbound projects launch exactly as before
- **Model status monitoring** — live upstream API status for Claude (Anthropic), Codex (OpenAI), and Antigravity (Google) in the session banner

### Governance
- **[Prawduct](https://github.com/brookstalley/prawduct) V2 plugin delegation** — projects governed by the Prawduct Claude Code plugin get governance from the plugin; TangleClaw detects the install and defers (no config clobbering), keeping its own lightweight baseline for everything else. Projects still on the legacy vendored hook are flagged as migration candidates
- **Session rules** — durable per-project behavioral directives with operator editing (Project Rules modal), AI-proposed improvements at wrap, an independent Critic gate on autonomous edits, and full version history with rollback
- **Global rules** — markdown rules applied to every project across all engines, editable from the dashboard

### Dashboard
- **Project management** — create, attach, archive, filter, tag, and delete projects from a central landing page
- **Project Master pane** — persistent fleet-aware assistant session embedded in the landing page and as an in-session drawer, with a settings surface (access level, engine, launch mode, scope, auto-start, editable versioned Hard rules) and a write boundary on the Claude engine — read-only, ask-before-writing, or full access, applied by the guard on its next tool call, though the running Master must be restarted before it acts on a change (file writes; Bash stays operator-gated rather than hook-enforced) ([ADR 0008](docs/adr/0008-project-master-session-model.md))
- **Setup wizard** — first-run guided setup scans for existing projects, detects engines, configures preferences, and walks through HTTPS setup
- **Universal project version detection** — every project's version resolves through a layered chain (`.tangleclaw/project-version.txt` → `CHANGELOG.md` → `version.json` → `package.json`) and shows on the project card and session banner
- **One-click self-update** — the update beacon's **Update now** button fetches the latest release tag, checks it out with fail-closed guards, and restarts the server
- **Startup project sync** — on every server boot, all engine configs regenerate and memory/scaffolding backfills, so code changes land immediately
- **PortHub** — central port registry with permanent and TTL leases, heartbeats, and next-free-port auto-allocation

### Security & Remote Access
- **Caddy ingress** — the default on a fresh install (and reversible) reverse-proxy mode, provisioned by the setup wizard and driveable by hand with `scripts/ingress-cutover.js`, that fronts the dashboard, terminals, and APIs with TLS and a `basic_auth` password gate — including an auto-provisioned HTTPS site on your Tailscale tailnet. Fail-closed cutover with validation and health checks; full guide in [deploy/INGRESS.md](deploy/INGRESS.md)
- **Forced admin setup** — the first-run wizard requires creating an admin login on any machine that can enforce one, which is the default; there is no default credential and no way to skip past it
- **Change it from settings** — global settings has a Login section for changing the password later; it may change a login but never create or blank one, and it tells you it will sign you out before you commit
- **Break-glass reset** — lost admin password? A local CLI resets it without disabling the gate
- **Service tokens** — machine-to-machine tokens gate the PortHub and shared-docs APIs so other projects' scripts keep working after you lock the ingress down ([ADR 0005](docs/adr/0005-service-tokens.md))
- **User attribution** — when the ingress authenticates a user, TangleClaw records who did what
- **Auth-drift warning** — the dashboard flags when the ingress auth *config* and the *live* Caddy state disagree, so a half-applied gate can't quietly masquerade as protection
- **HTTPS via mkcert, one click** — for direct (no-ingress) mode, a wizard generates localhost certs and hot-swaps the server to HTTPS

### Integrations
- **[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw)** — SSH or Web UI mode, connection registry, health checks, auto SSH tunnels with self-healing, reverse proxy, auto device pairing, instance version display, and a per-connection ClawBridge port (auto-allocated or explicit)
- **[ClawBridge](https://github.com/Jason-Vaughan/ClawBridge)** — live background-process visibility on OpenClaw instances, remote session pre-create with permission modes, and remote wrap capture
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — multi-tiered AI agent evaluation: ingests exchange data, scores with intelligent gating, tracks baselines, detects drift, generates incidents

### Technical
- **115+ registered routes** — full REST API for everything TangleClaw does
- **5,500+ tests** — comprehensive suite using `node:test`, zero test dependencies
- **SQLite storage** — runtime state in a single database file, JSON config for settings
- **ADRs** — durable design decisions live in [docs/adr/](docs/adr/)

</details>

## Quick Start

```bash
git clone --branch v5.7.0 https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
./deploy/install.sh
```

**Before that first line works, you need `git`** — and a brand-new Mac does not have it. Running
`git clone` on a machine that has never had developer tools installed prints
`xcode-select: note: No developer tools were found, requesting install.` and stops. On a desktop
Mac a dialog appears: click **Install**, wait for it (it is a large download — budget 15–30
minutes), then run the clone again. Over SSH with no desktop session, install them first with
`xcode-select --install`. This is the one prerequisite the installer cannot handle for you, because
you need it to *get* the installer.

The install script:
1. **Installs everything else for you** — Homebrew if it is missing, then Node 22+, ttyd, tmux,
   mkcert and Caddy. You do not need to install these by hand; the list below is what ends up on
   your machine, not a set of chores to do first.
2. Generates launchd plists with correct paths
3. Installs and loads the services
4. Runs a health check

Access the landing page at **http://localhost:3102**. That is where setup starts, and where the
dashboard stays if you opt out of the login gate.

**Once setup has installed the login gate — the default — the address changes to
`https://localhost:8443`.** Caddy takes over the front door on its own port; `3102` stays bound to
the loopback interface behind it and is *not* the address to use or share. `https://localhost:3102`
does not work in that mode and never will: TangleClaw serves plain HTTP there and Caddy terminates
the TLS. Setup tells you the address it landed on — trust that over this paragraph, since it knows
which mode you chose.

If you opted out of the gate and enabled HTTPS directly, `https://localhost:3102` is correct. Port
3102 serves one protocol at a time; opening the HTTP URL after HTTPS is enabled produces empty responses and can look like a dashboard refresh loop. See [Troubleshooting](docs/user-guide.md#dashboard-constantly-refreshes-after-enabling-https) to verify the protocol or return a localhost-only install to HTTP. (The installed launchd service uses port 3102; running `node server.js` by hand instead listens on the code default, **3101**.) On first launch, a setup wizard walks you through configuration — including choosing your **projects directory**. This is a single folder where all your managed projects live (e.g., `~/Projects`). TangleClaw scans this directory, detects existing repos and engines, and lets you attach them as managed projects.

### Prerequisites

**You install these two:**

- **macOS** — TangleClaw uses launchd for service management. Linux support is not yet available
- **git / Xcode Command Line Tools** — needed to clone this repository at all. See the note above
  the install script's steps; `xcode-select --install` if you have no desktop session

**`deploy/install.sh` installs the rest** — listed so you know what lands on your machine, not as
work to do first:

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal access
- **tmux** — session multiplexer
- **mkcert** — generates the local TLS certificate
- **Caddy** — serves the password-gated TLS ingress that setup provisions by default (see
  [deploy/INGRESS.md](deploy/INGRESS.md)). If it is somehow absent, setup finishes with **no login**
  and says so

**You also need at least one AI CLI engine**, which TangleClaw does not install — it drives whichever
you already use, with your own account: [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex), [Antigravity](https://antigravity.google/), or
[Aider](https://aider.chat). TangleClaw installs and runs without one; you just cannot launch a
session until an engine is present.

**Optional integrations:**
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
| Change the password you sign in with | [User Guide — Changing your login](docs/user-guide.md#changing-your-login) |
| Reset a lost admin password | [Ingress Guide — break-glass reset](deploy/INGRESS.md#admin-credential-reset-break-glass-auth-2) |
| Share docs between related projects | [User Guide — Project Groups and Shared Documents](docs/user-guide.md#project-groups-and-shared-documents) |
| Connect a remote OpenClaw machine | [OpenClaw Setup](docs/openclaw-setup.md) |
| Point a project's sessions at local models (LiteLLM/Ollama) | Orchestration profiles — edit `~/.tangleclaw/orchestration-profiles.json`, then bind the project in its settings |
| Let the AI improve its own session rules (safely) | [Session Rules & Self-Improvement](docs/session-rules-self-improvement.md) |
| Add a custom engine | [Engine Guide](docs/engine-guide.md) |
| Cut a release, or work out why one never reached installs | [Release Process](docs/release-process.md) |
| Change any config setting | [Configuration Reference](docs/configuration-reference.md) |
| Fix something that's broken | [User Guide — Troubleshooting](docs/user-guide.md#troubleshooting), or [Service Management](#service-management) below |
| Set it up safely, or get back in when locked out | [Setup Guide](docs/setup-guide.md) |

## Documentation

- **[Setup Guide](docs/setup-guide.md)** — setting up safely with no prior background: what the login protects, reaching it from another device, checking it worked, getting back in if you are locked out
- **[User Guide](docs/user-guide.md)** — getting started, full UI walkthrough, sessions, groups, mobile setup, troubleshooting
- **[Ingress Guide](deploy/INGRESS.md)** — Caddy reverse proxy, TLS, password gate, break-glass reset, public domains
- **[Session Rules & Self-Improvement](docs/session-rules-self-improvement.md)** — durable session directives, the Critic gate, version history
- **[Engine Guide](docs/engine-guide.md)** — built-in engines, creating custom engine profiles
- **[Configuration Reference](docs/configuration-reference.md)** — all config fields, JSON schemas, API overview
- **[OpenClaw Setup](docs/openclaw-setup.md)** — remote OpenClaw instances, SSH tunnels, Web UI mode
- **[Eval Audit Mode](docs/eval-audit-mode.md)** — AI agent evaluation pipeline, scoring, baselines, drift detection
- **[Architecture Decision Records](docs/adr/)** — the durable "why" behind the ingress model, wrap pipeline, service tokens, Project Master, and more

## Security

TangleClaw runs a local server with browser-based terminal access, so reaching the dashboard means running shell commands as you. It therefore **listens on `127.0.0.1` only** unless you tell it otherwise — a fresh install is reachable from the machine it runs on, and nowhere else. The terminal listener (`ttyd`) is pinned to loopback on every install, new or upgraded. The `deletePassword` config option protects destructive operations only; it is not a login.

**Upgrading from a version before this changed?** Your dashboard binding is left as it was, deliberately — narrowing it would take away remote access you may be relying on before there is a password to put in its place. TangleClaw says so on every start and on the dashboard until you resolve it, either by enabling the login gate below (recommended — it keeps remote access) or by setting `"bindAllInterfaces": false` to close it entirely.

**A fresh install sets a login during setup.** The wizard asks for a username and password and then
configures the Caddy gate itself, so the password-gated ingress below is the **default outcome of
installing**, not something you go and turn on afterwards. There is no default credential — you set
one, or setup does not finish. TangleClaw skips the step only where it could not enforce a
credential anyway (Caddy not installed, or a Caddy config it must not overwrite), and then says
plainly that no login is in force rather than implying one.

To reach TangleClaw from another device, pick one of two things — never neither:

- **The Caddy ingress** (the default, and recommended): a reversible cutover that fronts the dashboard, terminals, and APIs with TLS and a `basic_auth` password gate, forces admin-account creation on first run, and issues service tokens for machine-to-machine API callers. Setup provisions this for you; `scripts/ingress-cutover.js` is the manual path for upgrades and recovery. See [deploy/INGRESS.md](deploy/INGRESS.md).
- **`"bindAllInterfaces": true`** in `~/.tangleclaw/config.json` (or Settings → Network Exposure): accept connections from every interface **with no password**. Only sensible on a network you fully control, and it is the deliberate opt-out from the protection above. Requires a restart.

**Recommendations:**
- **Enable the ingress** (or at minimum mkcert HTTPS) for any non-localhost access
- Run TangleClaw on a trusted network or behind a VPN (e.g., Tailscale, WireGuard)
- If accessing from mobile over Wi-Fi, ensure your network is private

**Internet exposure is unsupported** — not merely discouraged. The gate is a single shared Basic credential with no rate limiting, lockout, second factor, or session revocation, sitting in front of arbitrary code execution. Supported perimeters are loopback, a private tunnel (Tailscale/WireGuard), or a trusted LAN behind the gate. The reasoning is recorded in [ADR 0009](docs/adr/0009-secure-by-default.md).

## Stay Updated

TangleClaw checks for newer releases automatically (a `git ls-remote --tags` against your `origin`, ~60 seconds after server start and periodically after — see `updateCheckIntervalMs`). That timer is only the floor for an install nobody has open: the dashboard re-checks when you open it and whenever you return to its tab, and every open session re-checks on its own poll, so a release published between timer ticks is noticed within minutes of it existing rather than whenever the timer next happens to fire. Those page-driven checks are throttled and coalesced server-side, so the cost is the same whether you have one tab open or twenty.

**To check on demand, click the version number** in the header. It reports the result inline — up to date, an update available, or that the check could not be made. That last distinction matters: an install that cannot reach `origin` is not the same as one that is current, and before #716 both rendered identically as "no pill".

When a newer tag exists, the serpent logo announces it — on the dashboard and inside every session, from one surface. A notice pops naming the version, fades after a few seconds, and leaves a red dot on the logo that stays until the update is applied; clicking the dot re-opens the notice. Click through to the release notes, or press **Update now** to have TangleClaw fetch the release, check it out with fail-closed guards, and restart itself.

> **A fork `origin` freezes detection.** GitHub copies tags into a fork only at creation, so a clone whose `origin` points at your own fork will report "up to date" indefinitely no matter how often it checks. Point `origin` at the upstream repo, or fetch tags from upstream yourself. Tracked as [#711](https://github.com/Jason-Vaughan/TangleClaw/issues/711).

Manual upgrade path:

```bash
cd <your-TangleClaw-clone>
node scripts/apply-update.js   # same guarded applier as the button
                               # result JSON on stdout, logs on stderr, exit 1 if refused
launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server
```

Run `./deploy/install.sh` **only** when a release changed a launchd plist or another deploy asset — it reloads both agents itself, so it replaces the `kickstart` above rather than following it.

Use the script rather than `git pull`. A successful update leaves the checkout **detached at the release tag**, which is the intended state — pulling a branch on top of that moves you to an unreleased commit, and the updater then refuses to run again because HEAD no longer sits on a tag. The script fetches and checks out the release tag itself, and fails closed on a dirty tree or a branch that isn't meant to be updated.

> **Note:** if your clone predates the 4.0 rename, the repository was previously named `TangleClaw-v3`. GitHub redirects the old URL, but updating your remote is cleaner: `git remote set-url origin https://github.com/Jason-Vaughan/TangleClaw.git`

## Configuration

Global config lives at `~/.tangleclaw/config.json` (auto-created on first run).

Key settings:
- `serverPort` — landing page server port (code default: 3101, launchd override: 3102)
- `ttydPort` — ttyd terminal port (3100; in `caddy` ingress mode ttyd binds a Unix socket instead of a TCP port)
- `projectsDir` — root directory for managed projects
- `defaultEngine` — preferred engine for new projects; used when installed, otherwise TangleClaw falls back to the first installed engine (see the configuration reference)
- `deletePassword` — optional password for destructive operations
- `httpsEnabled` / `httpsCertPath` / `httpsKeyPath` — direct-mode TLS
- `ingressMode` / `caddyHttpsPort` / `caddyHttpPort` / `publicDomain` — Caddy ingress ([guide](deploy/INGRESS.md))

Engine profiles: `~/.tangleclaw/engines/*.json` · Orchestration profiles: `~/.tangleclaw/orchestration-profiles.json`

See the [Configuration Reference](docs/configuration-reference.md) for all fields, types, and defaults.

## Development

### Running Tests

```bash
node --test 'test/*.test.js'
```

### Architecture

```
[default]  launchd (com.tangleclaw.caddy)          ← ingress mode, provisioned by setup
  └─ caddy: TLS + basic_auth gate
     └─ reverse proxy → TangleClaw server

launchd (com.tangleclaw.server)
  └─ node server.js
     ├─ Landing page HTTP(S) server (:3102)
     ├─ API endpoints (/api/*)
     ├─ Reverse proxy /terminal/* → ttyd (:3100)
     ├─ Reverse proxy /openclaw/* → SSH tunnel → OpenClaw gateway
     ├─ WebSocket upgrade (ttyd + OpenClaw)
     └─ Session wrapper + OpenClaw viewer HTML serving

launchd (com.tangleclaw.ttyd)
  └─ ttyd --port 3100 tmux attach (PTY-leak watchdog supervised)
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

# Health check (use https:// and curl -k when HTTPS is enabled)
curl -s http://localhost:3102/api/health | python3 -m json.tool
```

## Roadmap

Planned features and improvements — contributions and feedback welcome.

- **Session Switchboard — v2 automation** — the switchboard's send + receive + banner control are in beta today (see [What TangleClaw Does](#what-tangleclaw-does)); next is opt-in auto-inject of inbound messages into the live session and hover swarm-stats, gated on an at-least-once delivery guarantee upstream
- **Project Master actions** — the Master can now write files at the access level you set; next it acts on the TangleClaw API itself (confirm-gated) across the fleet
- **Cross-model governance** — extend the deeper governance layers beyond Claude Code to the other engines
- **Multi-engine sessions** — launch multiple engines on the same project simultaneously (e.g., Claude Code for implementation, Codex for review)
- **Sidecar controls** — poll, refresh, dismiss, and terminate individual background processes from the detail panel
- **Linux support** — systemd service management as an alternative to launchd

## License

MIT — see [LICENSE](LICENSE).
