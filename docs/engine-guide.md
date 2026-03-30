# Engine Guide

Engines in TangleClaw represent AI coding agents. TangleClaw abstracts engine differences so you can switch between Claude Code, Codex, Aider, or any custom engine without reconfiguring your projects.

## How Engines Work

Each engine is a JSON profile that tells TangleClaw:

- How to **detect** if the engine is installed
- How to **launch** the engine in a tmux session
- What **config file** format the engine expects (so TangleClaw can translate methodology rules)
- What **slash commands** the engine supports (shown as pills in the command bar)
- What **capabilities** the engine has (prime prompt support, co-author format, etc.)

Engine profiles live in `~/.tangleclaw/engines/`. TangleClaw ships with six built-in profiles, copied there on first run.

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
- **Capabilities**: Prime prompt, config file, co-author

### Aider

- **Command**: `aider`
- **Interaction model**: Session-based
- **Config file**: `.aider.conf.yml` (YAML)
- **Slash commands**: `/add` (add file to context), `/drop` (remove file), `/undo` (undo last change)
- **Capabilities**: Slash commands, prime prompt, config file, co-author

### Gemini CLI

- **Command**: `gemini`
- **Interaction model**: Session-based (spawns in tmux)
- **Config file**: `.gemini/GEMINI.md` (Markdown, in `.gemini/` subdirectory)
- **Slash commands**: None
- **Capabilities**: Prime prompt, config file, co-author

### Genesis

- **Command**: None (persistent agent)
- **Interaction model**: Persistent (connects to a running process, not managed by TangleClaw)
- **Config file**: None
- **Capabilities**: Placeholder — governance is handled by Mission Control, not TangleClaw

### OpenClaw

[OpenClaw](https://github.com/Jason-Vaughan/OpenClaw) is a self-hosted AI agent platform running in Docker on remote machines. Unlike other engines, OpenClaw connections are registered independently of projects in TangleClaw's connection registry.

- **Command**: `ssh` (SSH mode) or none (Web UI mode)
- **Interaction model**: Session-based (SSH) or iframe-based (Web UI)
- **Config file**: None (OpenClaw manages its own configuration)
- **Slash commands**: None
- **Capabilities**: Remote sessions, two connection modes (SSH terminal, Web UI iframe), automatic SSH tunnel management, sidecar process visibility via ClawBridge

OpenClaw engines appear in the engine dropdown when a connection has "Available as Engine" enabled. The engine ID is `openclaw:<connection-id>`. See the [OpenClaw Setup Guide](OPENCLAW-SETUP.md) for connection configuration.

**Connection modes:**
- **SSH mode** — TangleClaw spawns an SSH session in tmux, connecting to the OpenClaw CLI on the remote host. Works like any other tmux-based engine session.
- **Web UI mode** — TangleClaw establishes an SSH tunnel, then loads the OpenClaw Control UI in an iframe via a reverse proxy. No tmux involved — the browser talks directly to the OpenClaw gateway through the tunnel.

## Engine Detection

TangleClaw checks if each engine is available by running `which <command>`. The landing page shows an availability badge on each engine option:

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

The `configFormat` above is set to `null` because config file generation requires a built-in generator. The available generators are `claude-md`, `codex-yaml`, `aider-conf`, and `gemini-md`. If your engine doesn't use a TangleClaw-generated config file, set all three fields to `null`. To add a new generator, you'd need to add a handler in `lib/engines.js`.

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
| `syntax` | File syntax: `"markdown"`, `"yaml"`, or `null` |
| `generator` | Config generator to use: `"claude-md"`, `"codex-yaml"`, `"aider-conf"`, `"gemini-md"`, or `null` |

### Detection Strategies

| Strategy | Target | Description |
|----------|--------|-------------|
| `"which"` | binary name | Run `which <target>` to check PATH |
| `"custom"` | null | No auto-detection (persistent engines) |

### Capabilities

| Flag | Description |
|------|-------------|
| `supportsSlashCommands` | Engine has slash command input |
| `supportsPrimePrompt` | Engine accepts injected prime prompts |
| `supportsConfigFile` | Engine reads a config file from the project root |
| `supportsCoAuthor` | Engine supports git co-author attribution |

## Config File Generation

When a session launches, TangleClaw generates the engine-specific config file in the project root. This file is built from:

- Core rules (CHANGELOG updates, JSDoc, testing, session wrap protocol, PortHub registration)
- Extension rules (identity sentry, docs parity, decision framework, etc.)
- PortHub guide (port management API reference, when PortHub registration is enabled)
- Methodology template name and description

All engines with `supportsConfigFile: true` receive the same rule content, translated into each engine's native format:

| Engine | Config File | How Rules Are Included |
|--------|------------|----------------------|
| Claude Code | `CLAUDE.md` | Markdown sections with bullet-point rules, full PortHub guide, methodology info |
| Codex | `.codex.yaml` | `instructions:` multiline YAML field containing markdown-formatted rules and PortHub guide |
| Aider | `.aider.conf.yml` | YAML comments with rules and PortHub reference, plus functional config settings |
| Gemini CLI | `.gemini/GEMINI.md` | Markdown sections (same format as CLAUDE.md), written to `.gemini/` subdirectory |

This translation is automatic — methodology authors write rules once, and TangleClaw handles the format conversion. A parity test suite verifies that all engines receive core rules, PortHub references, and methodology info.

## Parity Checklist for New Engines

Every engine with `supportsConfigFile: true` **must** pass parity validation. Use `engines.validateParity()` programmatically or run the parity test suite (`node --test test/engines.test.js`).

When adding a new engine, verify that its generated config includes all of the following:

- [ ] **Core rules** — all five default rules: CHANGELOG updates, JSDoc comments, unit tests, session wrap protocol, PortHub registration
- [ ] **Extension rules** — active extension rules (identitySentry, docsParity, decisionFramework, etc.) translated into the engine's format
- [ ] **PortHub guide or reference** — full Port Management guide (for markdown-based engines) or API reference comment (for YAML-based engines)
- [ ] **Global rules** — content from `~/.tangleclaw/global-rules.md` injected into the config
- [ ] **Methodology info** — methodology name and description when a template is provided
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

No data is lost when switching engines. Session history, learnings, and methodology state are all engine-independent.

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
| Gemini CLI | status.cloud.google.com | Google Incidents |
| Aider | None (upstream-dependent) | — |
| Genesis | None (placeholder) | — |

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
