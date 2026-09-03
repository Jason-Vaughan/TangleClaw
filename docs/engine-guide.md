# Engine Guide

Engines in TangleClaw represent AI coding agents. TangleClaw abstracts engine differences so you can switch between Claude Code, Codex, Aider, or any custom engine without reconfiguring your projects. When a project switches engines, the previous engine's TangleClaw-written config file is marked inactive (a dated notice naming the live engine and its file) rather than left on disk as live canon; hand-written and plugin-owned files are left alone, and switching back regenerates the file (#858).

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
| `errorPatterns` | array | no | How to recognise the engine's own API errors in its terminal output — see [Engine API error detection](#engine-api-error-detection-errorpatterns) |

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
| `readOnlyModeMarker` | How this engine's TUI says the session is in a read-only mode, so a wrap refuses instead of timing out — see below |

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

#### `readOnlyModeMarker`

Optional. An engine whose TUI has a read-only mode — Claude Code's plan mode — declares how to
recognise it:

```json
"readOnlyModeMarker": {
  "modeLine": "(shift+tab to cycle)",
  "marker": "plan mode on (shift+tab to cycle)",
  "label": "plan mode",
  "exit": "shift+tab",
  "evidence": { "verifiedOn": "YYYY-MM-DD", "source": "…" }
}
```

A wrap's content steps have to **edit files**. In a read-only mode the engine answers with a plan
and waits on an approval that never comes, so before `ai-content` sends anything it samples the
pane: a present marker fails the step in under a second with `status: 'needs-operator'` and the
exit instruction, instead of polling for five minutes and reporting `blocked` (#429).

The two string fields answer two different questions and both are required:

- **`modeLine`** *locates* the line. It must match the pane in **every** mode, not just the
  read-only one — otherwise a writable session and an unreadable pane are indistinguishable.
- **`marker`** *decides*. It is the mode line plus the words that make it read-only. A marker
  equal to `modeLine` would refuse every wrap.

Locating by signature rather than by position is load-bearing: subagent rows render *below* the
mode line, so it is not the last line of the pane and a fixed slice off the bottom loses it as
soon as enough agents are running — which is exactly when a plan-mode session is doing work.

`label` names the mode in operator-facing copy; `exit` says how to leave it (both optional, with
neutral fallbacks). **Declare `evidence` with the date and how it was measured** — this is a claim
about another product's UI, and the same reasoning as `startupInjection.maxChars` applies: an
assertion with both sides in this repo stays green forever after upstream changes its footer. The
shipped Claude value was probed on a live pane, not recalled.

**Omit the field entirely and nothing is measured** — the step proceeds exactly as it did before
the check existed, and the step record says which engine declared no marker rather than implying a
clean pane. A field that is present but missing `marker` or `modeLine` is a profile defect: it is
treated as absent and logged at warn.

#### The ambient-awareness floor (`tc` on PATH)

Independent of any config file or prime, every tmux session TangleClaw launches gets the `tc` CLI
on its `PATH` plus `TANGLECLAW_API` / `TANGLECLAW_PROJECT_ID` (and `TANGLECLAW_WORKSPACE_ID` when
the switchboard minted one) in the pane environment. The verbs come from a declared roster
(`lib/tc-verbs.js`): `whoami`, `capabilities`, `sessions`, `message send|read|ack`, `ports`,
`docs`, `rules`, `learnings` — each answers honestly (an empty inbox or idle fleet says so in
words; a disabled capability states its reason), and the server records each invocation as a
verb-labeled **awareness receipt**, so a session that never discovered the floor is a detectable
state. This is engine-neutral by construction: a new engine needs no adapter to reach it.
Engine-profile `launch.env` overrides any of these keys on collision.

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

#### `pasteRejectedMarker`

Optional, and since #1134 the pane being observed ready is **no longer the last word**. An engine
that has been measured *discarding* a submission declares the text it prints when it does:

```json
"pasteRejectedMarker": "Please try again shortly"
```

Antigravity 1.1.22 renders the complete at-rest UI — bare `>` and `? for shortcuts` — while it is
still verifying an account, and drops whatever is submitted. Both readiness signals pass, so the
gate alone cannot tell that state from a ready one. After a paste, the pane is watched for this
marker; when it appears the delivery row is `unverified` with that reason **even though the gate
was satisfied**, and the prime is re-pasted once (bounded, and only after checking the pane is not
mid-turn).

It only ever **downgrades**. A watch that saw no rejection, or could not read the pane, leaves the
pre-existing verdict exactly as it was — so a swallow the engine does not announce is still missed,
and nothing here can invent a delivery or a retry. That asymmetry is deliberate: a false retry
pastes a whole prime into a session that already has one.

**Do not infer this marker from another engine, and date what you measured.** Watching for the
prime to *arrive* instead was tried and abandoned: a generated prime runs to hundreds of lines, so
once it echoes it is not in a pane tail at all, and the check fires on every healthy launch.
Omit the field and the engine is not watched, which is the honest default.

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

- [ ] **`tc` bootstrap line** — the unconditional instruction naming the `tc` CLI (single source: `lib/ecosystem-primer.js#tcBootstrapLines`, `md` or `comment` form). The family test in `test/engines.test.js` ("tc bootstrap line rides every carrier") fails any config-supporting engine that omits it — PATH presence alone creates no discovery intent, so every channel the engine reads must carry the line
- [ ] **Core rules** — all five default rules: CHANGELOG updates, JSDoc comments, unit tests, session wrap protocol, PortHub registration
- [ ] **Extension rules** — active extension rules (identitySentry, docsParity, decisionFramework, etc.) translated into the engine's format
- [ ] **PortHub guide or reference** — full Port Management guide (for markdown-based engines) or API reference comment (for YAML-based engines)
- [ ] **Global rules** — content from `data/global-rules.md` (the git-tracked canonical source, #240) injected into the config
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

The previous engine's config file does not stay behind as live canon (#858): if TangleClaw wrote it — a managed block between the `tangleclaw` markers, or a whole file carrying the generated header — it is marked with a dated inactive notice naming the live engine and its file. A hand-written file, and a plugin-owned `CLAUDE.md`, are left alone and the reason is logged. Switching back regenerates the file.

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

## Engine API error detection (`errorPatterns`)

A status page says whether the provider is up. It does not say that *this session's* calls are failing — Codex under the wrong auth mode answers every prompt with `{"type":"error","status":400,"error":{"type":"invalid_request_error",…}}` as gray terminal text while the status page stays green and the project card looks healthy. `errorPatterns` closes that gap: an engine profile declares how its API errors look in its own output, and TangleClaw watches for them.

```json
"errorPatterns": [
  { "regex": "\\{\"type\":\"error\"", "parser": "codex-json" }
]
```

- **`regex`** — a JavaScript regular expression, as a string, that selects a pane line worth parsing. Prefer an unanchored shape: a TUI gutter, indent or wrap prefix ahead of the JSON would otherwise defeat an anchored one silently. It must compile, and it may not nest a quantifier inside a quantified group (`(a+)+`, `(a*)*`, …) — the pattern runs against every captured row of every live session on the server's event loop, so `validateProfile` rejects the catastrophic-backtracking shape with the reason. Rows are capped at 2000 characters before any pattern sees them.
- **`parser`** — the **name** of a parsing strategy TangleClaw ships (`lib/engine-errors.js#PARSERS`), never code. A name the module does not know is rejected. Parsers today: `codex-json` — the structured `{"type":"error","status":<4xx|5xx>,"error":{"type","code","message"}}` object Codex echoes for a failed API call; a long line tmux wrapped across several rows is reassembled before parsing.

The field is optional. Bundled: Codex declares the pattern above; the other engines declare none until a shape is known for them.

**What the operator sees.** The wrap sentinel's existing per-tick read of every live pane (every few seconds) is the capture; there is no second loop. A match records `lastEngineError = { type, status, message, timestamp }` on the session, which reaches `GET /api/sessions/:project/status` and the project's `session` object in `GET /api/projects`. The session page shows a banner above the terminal naming the status, the error type and the provider's message; the project card on the dashboard carries a red `⚠ HTTP <status>` badge with the same detail in its tooltip.

**When it clears — stated honestly.** TangleClaw cannot see an API call succeed; it sees the pane's captured tail. The error is reported for as long as a matching line is inside that tail, and clears the first time a capture no longer contains one — which is what the next successful prompt looks like from outside: the engine produced enough new output to push the error line off the captured rows. An error still on screen stays reported even after the operator has fixed the cause, until the terminal moves past it; a repeated error re-arms with a fresh timestamp once the previous one has scrolled away. A capture that came back empty — tmux failed or timed out — is no reading at all and changes nothing, so a flaky tmux cannot flash the card healthy for a tick and re-stamp the same error as new. Detection applies to tmux sessions; a Web UI (gateway) session has no pane to read.
