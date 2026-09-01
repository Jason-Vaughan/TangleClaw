# Engine Guide

Engines in TangleClaw represent AI coding agents. TangleClaw abstracts engine differences so you can switch between Claude Code, Codex, Aider, or any custom engine without reconfiguring your projects.

## How Engines Work

Each engine is a JSON profile that tells TangleClaw:

- How to **detect** if the engine is installed
- How to **launch** the engine in a tmux session
- What **config file** format the engine expects (so TangleClaw can translate project rules)
- What **slash commands** the engine supports (shown as pills in the command bar)
- What **capabilities** the engine has (prime prompt support, co-author format, etc.)

Engine profiles live in `~/.tangleclaw/engines/`. TangleClaw ships with five built-in profiles, copied there on first run.

## Built-in Engines

### Claude Code

- **Command**: `claude`
- **Interaction model**: Session-based (spawns in tmux)
- **Config file**: `CLAUDE.md` (Markdown)
- **Slash commands**: `/compact` (compress context), `/clear` (clear conversation), `/review` (review changes)
- **Capabilities**: Slash commands, prime prompt, config file, co-author

### Codex

- **Command**: `codex`
- **Interaction model**: Session-based
- **Config file**: `.codex.yaml` (YAML)
- **Slash commands**: None
- **Launch modes**: Interactive (default), Full Auto (`--ask-for-approval never --sandbox workspace-write` — no approval prompts, sandbox retained), Bypass (`--dangerously-bypass-approvals-and-sandbox` — no approvals **and no sandbox**, containers/VMs only). Verified against codex-cli 0.145.0. Note this is the one Bypass mode across all engines that also removes the sandbox: Claude's and Antigravity's `--dangerously-skip-permissions` skip approvals only. A bypass posture confirmed on another engine and carried to Codex by an engine switch is therefore wider than the one that was confirmed
- **Capabilities**: Prime prompt, config file, co-author

### Aider

- **Command**: `aider`
- **Interaction model**: Session-based
- **Config file**: `.aider.conf.yml` (YAML)
- **Slash commands**: `/add` (add file to context), `/drop` (remove file), `/undo` (undo last change)
- **Capabilities**: Slash commands, prime prompt, config file, co-author

> **Retired engines:** *Gemini CLI* was removed in #457 — Google [sunset it for individual accounts on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/); Antigravity (below) is the successor. The *genesis* placeholder profile was removed in #458. Retired ids are tombstoned: any stale copy in `~/.tangleclaw/engines/` is deleted on boot.

### Antigravity

[Antigravity CLI](https://antigravity.google/) (`agy`) is Google's successor to Gemini CLI.

- **Command**: `agy`
- **Interaction model**: Session-based (spawns in tmux)
- **Config file**: `AGENTS.md` (Markdown, project root), written as a **managed block** rather than owned outright. Antigravity discovers `GEMINI.md` / `AGENTS.md` only, walking up from the working directory to the repo root — verified 2026-08-31 against `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md`. `AGENTS.md` is a multi-vendor convention that operators and other tools (`next dev`) also write, so TangleClaw splices only the region between its `BEGIN:tangleclaw` / `END:tangleclaw` markers and leaves the rest untouched.
- **Slash commands**: None
- **Launch modes**: Interactive (default), Sandbox (`--sandbox`), Bypass (`--dangerously-skip-permissions`, containers/VMs only). Antigravity has no Auto-Edit/Plan-Only approval modes (verified against agy v1.0.10)
- **Capabilities**: Prime prompt, config file
- **Status monitoring**: reuses the `google-incidents` adapter with `productName: "Gemini"` — agy fronts Gemini models, and model-serving incidents on the Google status page carry that name

### OpenClaw

[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw) is a self-hosted AI agent platform running in Docker on remote machines. Unlike other engines, OpenClaw connections are registered independently of projects in TangleClaw's connection registry.

- **Command**: `ssh` (SSH mode) or none (Web UI mode)
- **Interaction model**: Session-based (SSH) or iframe-based (Web UI)
- **Config file**: None (OpenClaw manages its own configuration)
- **Slash commands**: None
- **Capabilities**: Remote sessions, two connection modes (SSH terminal, Web UI iframe), automatic SSH tunnel management, sidecar process visibility via ClawBridge

OpenClaw does **not** appear in the project engine dropdown (#459) — assigning a connection as a project's engine never gave a local project an LLM (the agent works in the remote workspace), so it was removed as a picker choice. Registered instances are reached through the dedicated OpenClaw panel in the top bar. The internal engine ID form `openclaw:<connection-id>` still resolves for launch plumbing. See the [OpenClaw Setup Guide](openclaw-setup.md) for connection configuration.

**Connection modes:**
- **SSH mode** — TangleClaw spawns an SSH session in tmux, connecting to the OpenClaw CLI on the remote host. Works like any other tmux-based engine session.
- **Web UI mode** — TangleClaw establishes an SSH tunnel, then loads the OpenClaw Control UI in an iframe via a reverse proxy. No tmux involved — the browser talks directly to the OpenClaw gateway through the tunnel.

## Engine Detection

TangleClaw checks if each engine is available by running `command -v <command>` on the PATH your
login shell reports, not the narrower one the background service inherits. The landing page shows an
availability badge on each engine option:

- **Available** — the binary was found in PATH
- **Not found** — the binary is not in PATH

Detection happens when engines are listed via the API, not at startup.

## Creating a Custom Engine Profile

Create a JSON file at `~/.tangleclaw/engines/<engine-id>.json`:

```json
{
  "id": "my-engine",
  "name": "My Engine",
  "command": "my-engine-cli",
  "interactionModel": "session",
  "configFormat": {
    "filename": null,
    "syntax": null,
    "generator": null
  },
  "coAuthorFormat": "Co-Authored-By: {name} <{email}>",
  "commands": [
    {
      "label": "Help",
      "input": "/help",
      "description": "Show help"
    }
  ],
  "detection": {
    "strategy": "which",
    "target": "my-engine-cli"
  },
  "launch": {
    "shellCommand": "my-engine-cli",
    "args": ["--some-flag"],
    "env": {
      "MY_ENGINE_MODE": "interactive"
    }
  },
  "persistent": null,
  "capabilities": {
    "supportsSlashCommands": true,
    "supportsPrimePrompt": true,
    "supportsConfigFile": true,
    "supportsCoAuthor": true
  }
}
```

The `configFormat` above is set to `null` because config file generation requires a built-in generator. The available generators are `claude-md`, `codex-yaml`, `aider-conf`, `gemini-md` (generic markdown; kept for custom profiles after the Gemini engine's retirement), and `antigravity-md`. If your engine doesn't use a TangleClaw-generated config file, set `filename`, `syntax` and `generator` to `null`. To add a new generator, you'd need to add a handler in `lib/engines.js`.

### Engine Profile Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `name` | string | yes | Display name |
| `command` | string\|null | yes | CLI command to launch (null for persistent engines) |
| `interactionModel` | string | yes | `"session"` or `"persistent"` |
| `configFormat` | object | yes | Engine-specific config file details |
| `coAuthorFormat` | string\|null | yes | Git co-author pattern (null if unsupported) |
| `commands` | array | yes | Slash commands (shown as pills in command bar) |
| `detection` | object | yes | How to detect if installed |
| `launch` | object\|null | yes | Launch parameters (null for persistent engines) |
| `persistent` | object\|null | yes | Persistent engine config (null for session engines) |
| `capabilities` | object | yes | Feature flags |

### Config Format

| Field | Description |
|-------|-------------|
| `filename` | Config file name written to project root (e.g., `CLAUDE.md`) |
| `syntax` | File syntax: `"markdown"`, `"yaml"`, `"toml"`, or `null` |
| `generator` | Config generator to use: `"claude-md"`, `"codex-yaml"`, `"aider-conf"`, `"gemini-md"`, `"antigravity-md"`, or `null` |
| `mergeStrategy` | `"whole-file"` (default) — TangleClaw owns the entire file — or `"managed-block"`, where it splices only the region between `BEGIN:tangleclaw` / `END:tangleclaw` and leaves the rest byte-identical. **Required** for a shared-convention carrier (`AGENTS.md`, `GEMINI.md`, `CONVENTIONS.md`): those are files operators commit and other tools also write, so a whole-file write destroys their content and is **refused at the write**, not merely warned about |
| `discovery` | Evidence for the `filename` claim: `verifiedOn` (ISO date) and `source` (the upstream doc consulted), plus an optional `note`. Required wherever a wrong filename is destructive — a shared-convention carrier or a spliced block. A filename is an **upstream** fact about the engine, and an assertion whose both sides live in this repo cannot detect it drifting |

### Detection Strategies

| Strategy | Target | Description |
|----------|--------|-------------|
| `"which"` | binary name | Run `command -v <target>` to check PATH |
| `"path"` | absolute file path | Check whether that exact path exists |
| `"custom"` | null | No auto-detection (persistent engines) |

Results are cached for 60 seconds and shared by every caller asking about the
same target, so a fleet of projects on one engine costs a single probe rather
than one each. Two outcomes are never cached, because neither is an answer: a
probe killed by its own 2-second cap, and a probe that could not be started at
all (the machine was out of process slots). "Check again" in the setup wizard
drops everything cached, and the paths that *gate* a launch — starting a session,
starting the Project Master — probe fresh every time rather than reading the
cache, so an engine you have just installed is never refused.

### Capabilities

| Flag | Description |
|------|-------------|
| `supportsSlashCommands` | Engine has slash command input |
| `supportsPrimePrompt` | Engine accepts injected prime prompts |
| `supportsConfigFile` | Engine reads a config file from the project root |
| `supportsCoAuthor` | Engine supports git co-author attribution |
| `supportsSilentPrime` | Engine can receive the prime as hidden context at startup, rather than as typed input |
| `startupInjection.maxChars` | How many characters this engine's startup channel can carry before *it* truncates — see below |

#### `startupInjection.maxChars`

An object, not a boolean: `"startupInjection": { "maxChars": 10000 }`.

This is a fact about the **engine's own harness**, not a TangleClaw preference. Claude Code caps
hook output at 10,000 characters and replaces anything longer with a short preview plus a file path
— which means a prime that exceeds it is not shortened, it is *replaced*, and the session never sees
the directives it carried.

TangleClaw assembles the prime against whatever an engine declares here: bulk sections yield first,
each replaced by a pointer naming what was dropped, and anything still over budget is shipped whole
with a notice rather than cut. **Omit the field and the engine keeps the historical 16,000-character
fallback**, so declaring it for one engine never changes another's behavior.

The limit applies to the startup-hook channel only. When a project runs with `silentPrime` off the
prime is pasted into the terminal instead, and the fallback is used.

**Verify the number against the engine's own documentation before declaring it, and record where
and when in a sibling `evidence` block** — `"startupInjection": { "maxChars": 10000, "evidence":
{ "verifiedOn": "YYYY-MM-DD", "source": "…" } }`. The profile guard suite fails any declared
`maxChars` with no evidence: the number is an *upstream* fact, and an assertion with both sides in
this repo stays green forever after the upstream changes. Re-verify if directives start going
missing — a value copied from another engine, or left stale after the harness changes, fails
silently and in the one place nothing else is watching.

#### Prime paste readiness

When a project runs with `silentPrime` off (or the engine has no silent channel), the prime is
pasted into the TUI. That paste is **readiness-gated** for engines with a positive at-rest marker
in `medusa-wake`'s `ENGINE_WAKE_PROFILES` (antigravity: `? for shortcuts`): the paste waits until
the marker renders over a transcript that has stopped moving, instead of firing on a fixed timer —
a fixed delay racing an engine boot is how a 41-second antigravity boot swallowed the prime for 12
days with a clean ledger.

Engines without a positive marker cannot be gated and **must declare an explicit
`launch.startupDelay`** (the guard suite fails a paste-path profile with neither), and their blind
paste is recorded in the delivery ledger as `unverified`, never `delivered` — `delivered` is
reserved for a paste whose pane was observed ready.

## Config File Generation

When a session launches, TangleClaw generates the engine-specific config file in the project root. This file is built from:

- Core rules (CHANGELOG updates, JSDoc, testing, session wrap protocol, PortHub registration)
- Extension rules (identity sentry, docs parity, decision framework, etc.)
- PortHub guide (port management API reference, when PortHub registration is enabled)

All engines with `supportsConfigFile: true` receive the same rule content, translated into each engine's native format:

| Engine | Config File | How Rules Are Included |
|--------|------------|----------------------|
| Claude Code | `CLAUDE.md` | Markdown sections with bullet-point rules, full PortHub guide |
| Codex | `.codex.yaml` | `instructions:` multiline YAML field containing markdown-formatted rules and PortHub guide |
| Aider | `.aider.conf.yml` | YAML comments with rules and PortHub reference, plus functional config settings |
| Antigravity | `AGENTS.md` | Markdown sections (same format as CLAUDE.md), spliced into the project root file as a **managed block** — TangleClaw owns only the region between its `BEGIN:tangleclaw` / `END:tangleclaw` markers |

This translation is automatic — rules are written once, and TangleClaw handles the format conversion. A parity test suite verifies that all engines receive core rules and PortHub references.

**Plugin-governed projects get an operational block, not the full file.** When a project's dev-time
governance is owned by the Prawduct V2 plugin (`isPluginGoverned`), the plugin owns `CLAUDE.md`'s
governance content, so TangleClaw does not regenerate the file — it splices a **managed block**
(same `BEGIN:tangleclaw` / `END:tangleclaw` mechanism as `AGENTS.md`) carrying only operational
content: the API base URL, the service-token *pointer* (never the inline token — a governed
`CLAUDE.md` is a committed file), the Medusa switchboard section, and the PortHub / shared-docs /
session-memory guides. Rules tiers (core, extension, global) stay out of the block: governance is
the plugin's side of the line, and per-project session rules ride the prime (#595). Governed
projects on a non-`claude-md` carrier keep the full skip — writing a file TC has never owned on
those projects is a separate decision.

## Parity Checklist for New Engines

Every engine with `supportsConfigFile: true` **must** pass parity validation. Use `engines.validateParity()` programmatically or run the parity test suite (`node --test test/engines.test.js`).

When adding a new engine, verify that its generated config includes all of the following:

- [ ] **Core rules** — all five default rules: CHANGELOG updates, JSDoc comments, unit tests, session wrap protocol, PortHub registration
- [ ] **Extension rules** — active extension rules (identitySentry, docsParity, decisionFramework, etc.) translated into the engine's format
- [ ] **PortHub guide or reference** — full Port Management guide (for markdown-based engines) or API reference comment (for YAML-based engines)
- [ ] **Global rules** — content from `~/.tangleclaw/global-rules.md` injected into the config
- [ ] **Generator switch case** — a `case` entry in `generateConfig()` for the new generator name
- [ ] **Profile `configFormat.generator`** — must exactly match the switch case string
- [ ] **`_getRulesContent()` used** — the generator function must call `_getRulesContent()` to get the canonical rule set (do not duplicate rule logic)
- [ ] **Status page config** — set `statusPage` in the engine profile JSON to the upstream status API config (adapter, url, component info), or `null` if the engine has no known status page

### How to add a new engine generator

1. Create the engine profile JSON in `data/engines/<id>.json` with `supportsConfigFile: true` and a unique `configFormat.generator` value
2. Add a generator function `_generate<Format>()` in `lib/engines.js` that calls `_getRulesContent()` and translates rules into the engine's native format
3. Add the corresponding `case` in the `generateConfig()` switch statement
4. Run `engines.validateParity()` — it must return `{ valid: true }`
5. Run `engines.validateStatusParity()` — it must return `{ valid: true }` (ensures `statusPage` field is present)
6. Add engine-specific tests in `test/engines.test.js`

## Switching Engines

You can change a project's engine at any time from the project settings on the landing page or the session settings modal. The change takes effect on the next session launch — TangleClaw regenerates the config file in the new engine's format.

No data is lost when switching engines. Session history and learnings are engine-independent.

## Model Status Monitoring

TangleClaw monitors the upstream service status for engines with known status pages. The engine badge on project cards reflects real-time operational status:

- **Green left border** — Operational
- **Amber left border** — Degraded performance
- **Orange left border** — Partial outage
- **Red left border** — Major outage
- **Muted left border** — Unknown (no status page or fetch failed)

Status is polled every 2 minutes from official status pages. Hover over the engine badge for details.

### Supported status sources

| Engine | Status Page | Adapter |
|--------|------------|---------|
| Claude Code | status.claude.com | Atlassian Statuspage |
| Codex | status.openai.com | Atlassian Statuspage |
| Antigravity | status.cloud.google.com | Google Incidents |
| Aider | None (upstream-dependent) | — |

### Engine profile `statusPage` field

Each engine profile includes a `statusPage` field (object or `null`):

```json
"statusPage": {
  "adapter": "atlassian",
  "url": "https://status.example.com/api/v2/summary.json",
  "componentId": "abc123",
  "componentName": "My Service"
}
```

- **`adapter`** — Parser type: `"atlassian"` (Atlassian Statuspage) or `"google-incidents"` (Google Cloud)
- **`url`** — JSON API endpoint to poll
- **`componentId`** / **`componentName`** — For Atlassian: identifies the specific component to monitor
- **`productName`** — For Google: product name to filter incidents by

Set to `null` for engines without a known upstream status page.
