# Configuration Reference

TangleClaw uses a layered configuration system: global config for system-wide settings, per-project config for project-specific settings, and engine/methodology profiles for behavior definitions.

## File Locations

| File | Purpose |
|------|---------|
| `~/.tangleclaw/config.json` | Global configuration |
| `~/.tangleclaw/engines/*.json` | Engine profiles |
| `~/.tangleclaw/templates/*/template.json` | Custom methodology templates |
| `~/.tangleclaw/global-rules.md` | Global rules (applied to all projects) |
| `~/.tangleclaw/tangleclaw.db` | SQLite database (runtime state) |
| `<project>/.tangleclaw/project.json` | Per-project configuration |

## Global Configuration (`config.json`)

Auto-created on first run with defaults. Editable directly or via `PATCH /api/config`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverPort` | number | `3101` | Landing page HTTP server port. The install script sets `TANGLECLAW_PORT=3102` via launchd, so the effective default after installation is **3102**. |
| `ttydPort` | number | `3100` | ttyd terminal emulator port. The install script configures ttyd on port **3101** via launchd. |
| `defaultEngine` | string | `"claude"` | Default engine for new projects |
| `defaultMethodology` | string | `"minimal"` | Default methodology for new projects |
| `projectsDir` | string | `"~/Documents/Projects"` | Root directory for managed projects |
| `deletePassword` | string\|null | `null` | Password for destructive operations (hashed via scrypt when saved) |
| `quickCommands` | array | see below | Global quick command buttons |
| `theme` | string | `"dark"` | UI theme: `"dark"`, `"light"`, `"high-contrast"` |
| `chimeEnabled` | boolean | `true` | Play audio chime when session goes idle |
| `peekMode` | string | `"drawer"` | Peek UI mode: `"drawer"`, `"modal"`, `"alert"` |
| `setupComplete` | boolean | `false` | Whether the first-run wizard has been completed. Set to `true` automatically for existing installs that lack this field. |
| `httpsEnabled` | boolean | `false` | Enable HTTPS for the server |
| `httpsCertPath` | string\|null | `null` | Path to TLS certificate file (PEM) |
| `httpsKeyPath` | string\|null | `null` | Path to TLS private key file (PEM) |

### Default Quick Commands

```json
[
  { "label": "git status", "command": "git status" },
  { "label": "git log", "command": "git log --oneline -5" },
  { "label": "ls", "command": "ls -la" }
]
```

### Password Protection

When `deletePassword` is set, the following operations require the password:

- Deleting a project
- Killing a session
- Wrapping a session

The password is hashed with scrypt before storage. Plaintext passwords from v2 are auto-upgraded on first verification.

## Global Rules (`global-rules.md`)

Editable markdown rules that apply to all projects across all engines. When an engine config is generated (e.g., `CLAUDE.md`, `.codex.yaml`), global rules are included as a `## Global Rules` section.

- **Default**: `data/default-global-rules.md` (bundled, restore source)
- **User copy**: `~/.tangleclaw/global-rules.md` (created from defaults on first load)
- **Edit via**: Landing page "Global Rules" panel, or `PUT /api/rules/global`
- **Reset**: Landing page Reset button, or `POST /api/rules/global/reset`

## Per-Project Configuration (`project.json`)

Stored in `<project>/.tangleclaw/project.json`. Created when a project is added to TangleClaw.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `engine` | string\|null | `null` | Engine ID for this project |
| `methodology` | string\|null | `null` | Methodology template ID |
| `methodologyPhase` | string\|null | `null` | Current methodology phase |
| `rules.core` | object | all `true` | Core enforcement rules (not editable) |
| `rules.extensions` | object | all `false` | Opt-in extension rules |
| `ports` | object | `{}` | Registered port assignments |
| `quickCommands` | array | `[]` | Project-specific quick command buttons |
| `actions` | array | `[]` | Custom action buttons |
| `tags` | array | `[]` | Project tags for filtering |
| `silentPrime` | boolean | `true` | Deliver the session prime silently rather than as typed input |
| `versionBumpEnabled` | boolean | `true` | Run the wrap's `version-bump` step. Turn off for projects that manage their own versioning |
| `versionFilePath` | string\|null | `null` | Explicit version file, relative to the project root (e.g. `VERSION.json`). `null` probes `version.json` then `package.json`. Set it when the file has a different name or case — the probe only tests the lowercase name, so on a case-sensitive filesystem it would otherwise miss and bump `package.json` instead. Must stay inside the project — enforced after resolving symlinks, at both the API and the write site, since a hand-edited `project.json` never passes through the API. The wrap's version-bump **refuses** if a configured path is unusable — it never falls back to another file. Version *detection* (what the dashboard shows) is more forgiving: it prefers `CHANGELOG.md`, then this file, then the probe, warning and degrading rather than refusing. So an unusable value can show a probe-derived version while the wrap declines to bump |
| `featureIndexEnabled` | boolean | `false` | Maintain `FEATURES.md` during wrap |
| `projectMapEnabled` | boolean | `false` | Maintain `PROJECT-MAP.md` during wrap |
| `wrapAutoPrEnabled` | boolean | `true` | After an auto-branched wrap commit, push and open a PR back to the original branch |
| `wrapSections` | array\|null | `null` | Which continuity wrap-summary sections render. `null` = all of them |
| `wrapStepOverrides` | object | `{}` | Per-step wrap overrides, keyed by step id — see [Wrap step overrides](#wrap-step-overrides) below |
| `medusaEnabled` | boolean | `false` | Auto-start this project's sessions on the Medusa switchboard |
| `medusaWake` | boolean | `false` | Wake an idle session on inbound switchboard messages |
| `defaultLaunchMode` | string | `"default"` | Engine launch-mode key this project launches in by default |
| `showLaunchModePicker` | boolean | `true` | Show the launch-mode picker instead of launching directly in the default mode |

### Core Rules (Always `true`)

| Rule | Description |
|------|-------------|
| `changelogPerChange` | Changelog updated with every code change |
| `jsdocAllFunctions` | All functions have JSDoc documentation |
| `unitTestRequirements` | Code has accompanying tests |
| `sessionWrapProtocol` | Sessions are properly wrapped |
| `porthubRegistration` | Port assignments go through PortHub |

### Extension Rules

| Rule | Type | Default | Description |
|------|------|---------|-------------|
| `identitySentry` | boolean | `false` | Identity verification checks |
| `docsParity` | boolean | `false` | Docs must match code changes |
| `decisionFramework` | boolean | `false` | Decisions follow the decision framework |
| `loggingLevel` | string | `"info"` | Minimum logging level |
| `zeroDebtProtocol` | boolean | `false` | No technical debt allowed |
| `independentCritic` | boolean | `false` | Independent Critic review required |
| `adversarialTesting` | boolean | `false` | Adversarial test cases required |

### Wrap Step Overrides

`wrapStepOverrides` turns off or reconfigures an individual wrap step for one project. It is
keyed by the step's `id` from the methodology's `wrap_pipeline.steps`:

```json
"wrapStepOverrides": {
  "version-bump":     { "enabled": false },
  "changelog-update": { "blocker": false }
}
```

Overrides live here rather than in the methodology template because the template's step list is
framework-owned: it is replaced wholesale whenever a newer framework revision ships, so a
template edit is silently undone at the next server start. Nothing that syncs templates writes
`project.json`.

| Field | Type | Effect |
|-------|------|--------|
| `enabled` | boolean | `false` skips the step. It still appears in the wrap drawer as a skip with its reason, rather than disappearing from the run |
| `blocker` | `true` \| `false` \| `"errors-only"` | Whether a failed step halts the rest of the wrap. `false` means the step still runs, still reports failure, and the wrap continues. **`"errors-only"` halts** (it is a stricter form of `true`, not a softer one) — use `false` to stop a step halting your wrap |
| `prompt` | string | Replaces the instruction text for an `ai-content` step. An empty string makes the step skip itself |

**What you cannot change.** Step *order and membership* are framework-owned — no adding,
removing, or reordering. Order carries correctness contracts between steps (the changelog must
be written before the version bump reads it to choose a level), guaranteed by one check against
the shared pipeline; per-project ordering would turn that into a promise nothing verifies. If
you genuinely need a different pipeline, fork a methodology instead.

Fields outside the table above are ignored, and the API rejects them with the field named. Two
are worth calling out:

- **`verifyChanged` cannot be overridden.** It lists the files a step must actually have changed
  to count as done. Blanking it would leave the check reporting success while verifying nothing.
- **The `commit` step cannot be disabled.** Every other step stages its writes in memory; the
  commit step is the only one that flushes them to disk. Turning it off would leave the version
  bump and changelog update reporting success with nothing landing. You may still set its
  `blocker`.

**Relationship to the individual toggles.** `versionBumpEnabled`, `featureIndexEnabled`, and
`projectMapEnabled` are independent of this map: each is checked by its own step at run time, so
either switch turning a step off is enough to skip it. There is no precedence to reason about —
they cannot contradict, only agree or disagree about which one did the skipping. Prefer the
dedicated toggle where one exists; it is the surfaced setting.

## Project Groups

Groups are stored in the `project_groups` SQLite table. Managed via the API or landing page UI.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | auto-generated | UUID primary key |
| `name` | string | required | Unique group name |
| `description` | string\|null | `null` | Group description |
| `sharedDir` | string\|null | `null` | Absolute path to a directory of shared `.md` files. On session launch, TangleClaw scans this directory and auto-registers new files as shared documents. |
| `created_at` | string | auto | ISO 8601 timestamp |

### sharedDir Auto-Discover

When `sharedDir` is set on a group, TangleClaw scans the directory for `.md` files at two times:
1. **Session launch** — before generating the engine config, all groups for the project are synced
2. **Manual sync** — via `POST /api/groups/:id/sync`

New files are registered with `injectIntoConfig: true` and `injectMode: 'reference'`. Already-registered files (matched by `file_path`) are skipped.

## Engine Profile JSON Schema

Engine profiles define how TangleClaw interacts with an AI engine. See the [Engine Guide](engine-guide.md) for full details on creating custom profiles.

```json
{
  "id": "string — unique identifier",
  "name": "string — display name",
  "command": "string|null — CLI command",
  "interactionModel": "string — 'session' or 'persistent'",
  "configFormat": {
    "filename": "string|null — config file name",
    "syntax": "string|null — 'markdown', 'yaml', or null",
    "generator": "string|null — config generator id"
  },
  "coAuthorFormat": "string|null — git co-author pattern",
  "commands": [
    { "label": "string", "input": "string", "description": "string" }
  ],
  "detection": {
    "strategy": "string — 'which' or 'custom'",
    "target": "string|null — binary name"
  },
  "launch": {
    "shellCommand": "string",
    "args": ["array of string"],
    "env": { "ENV_VAR": "value" }
  },
  "persistent": "object|null — persistent engine config",
  "capabilities": {
    "supportsSlashCommands": "boolean",
    "supportsPrimePrompt": "boolean",
    "supportsConfigFile": "boolean",
    "supportsCoAuthor": "boolean"
  }
}
```

## Methodology Template JSON Schema

Methodology templates define project workflow. See the [Methodology Guide](methodology-guide.md) for full details on creating custom templates.

```json
{
  "id": "string — unique identifier",
  "name": "string — display name",
  "description": "string — brief description",
  "type": "string — must be 'methodology'",
  "version": "string — semver version",
  "phases": [
    { "id": "string", "name": "string", "description": "string",
      "weight": "string — 'deep'|'normal'|'focused'",
      "offerContextReset": "boolean" }
  ],
  "statusContract": {
    "command": "string|null — shell command",
    "parse": "string|null — 'json', 'yaml-field', or null",
    "field": "string|null — dot-notation field path",
    "badge": "string — badge label",
    "colorMap": { "phase-id": "color" }
  },
  "detection": {
    "strategy": "string — 'directory' or 'file'",
    "target": "string — directory or file name"
  },
  "wrap": {
    "command": "string|null",
    "steps": ["array of step ids"],
    "captureFields": ["array of field names"]
  },
  "prime": {
    "format": "string — 'markdown'",
    "sections": ["array of section ids"],
    "maxTokens": "number — token limit for prime prompt"
  },
  "defaultRules": { "extensionRuleId": "boolean" },
  "actions": [
    { "label": "string", "command": "string", "confirm": "boolean" }
  ],
  "init": {
    "directories": ["array of dir paths"],
    "files": { "file-path": "file-content" },
    "postInit": "string|null — shell command"
  }
}
```

## SQLite Database

The SQLite database at `~/.tangleclaw/tangleclaw.db` stores runtime state. You should not need to edit it directly — use the API instead.

**Tables**: `projects`, `sessions`, `learnings`, `activity_log`, `port_leases`, `schema_version`, `project_groups`, `group_members`, `shared_docs`, `openclaw_connections`, `eval_scores`, `eval_baselines`, `eval_incidents`

Current schema version: **12**

### Port Leases Table

The `port_leases` table stores all managed port assignments. TangleClaw is the authoritative port registry — leases survive restarts.

| Column | Type | Description |
|--------|------|-------------|
| `port` | INTEGER (PK) | Port number |
| `project` | TEXT | Project name |
| `service` | TEXT | Service description (e.g., "ttyd", "server") |
| `status` | TEXT | `active`, `expired`, or `permanent` |
| `permanent` | INTEGER | 1 for permanent leases, 0 for TTL-based |
| `ttl_ms` | INTEGER | TTL in milliseconds (null for permanent) |
| `expires_at` | TEXT | ISO 8601 expiration time |
| `last_heartbeat` | TEXT | Last heartbeat timestamp |
| `description` | TEXT | Optional description |
| `auto_renew` | INTEGER | 1 if auto-renew on heartbeat |

## API Overview

TangleClaw exposes 62 HTTP endpoints under `/api/`. All endpoints accept and return JSON. Error responses use the format:

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service health check |
| `/api/version` | GET | Version info |
| `/api/system` | GET | CPU, memory, disk stats |
| `/api/config` | GET | Global config (password redacted) |
| `/api/config` | PATCH | Update config fields |
| `/api/models/status` | GET | Upstream API status for all engines |
| `/api/update-status` | GET | Version update check |

### Engines & Methodologies

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/engines` | GET | List engines with availability |
| `/api/engines/:id` | GET | Engine profile details |
| `/api/methodologies` | GET | List methodology templates |
| `/api/methodologies/:id` | GET | Methodology template details |

### Projects

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List projects (filterable) |
| `/api/projects/:name` | GET | Single project detail |
| `/api/projects` | POST | Create project |
| `/api/projects/attach` | POST | Attach existing directory as project |
| `/api/projects/import` | POST | Import project from external source |
| `/api/projects/:name` | PATCH | Update project |
| `/api/projects/:name` | DELETE | Delete project |

### Sessions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:project` | POST | Launch session |
| `/api/sessions/:project` | DELETE | Kill session |
| `/api/sessions/:project/status` | GET | Session status |
| `/api/sessions/:project/command` | POST | Inject command |
| `/api/sessions/:project/wrap` | POST | Trigger wrap |
| `/api/sessions/:project/wrap/complete` | POST | Complete wrap with captured data |
| `/api/sessions/:project/peek` | GET | Peek at output |
| `/api/sessions/:project/history` | GET | Session history |

### Ports

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ports` | GET | List all port leases |
| `/api/ports/lease` | POST | Create or renew a port lease |
| `/api/ports/release` | POST | Release a port lease |
| `/api/ports/heartbeat` | POST | Heartbeat a TTL lease |
| `/api/ports/sync` | POST | Sync port leases with system state |

### Rules & Config

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rules/global` | GET | Get global rules content |
| `/api/rules/global` | PUT | Save global rules content |
| `/api/rules/global/reset` | POST | Reset global rules to defaults |
| `/api/activity` | GET | Activity log |
| `/api/upload` | POST | Upload a file to a project directory (15 MB limit) |
| `/api/uploads` | GET | List uploads for a project (`?project=name`) |
| `/api/tmux/mouse/:session` | GET | Get mouse mode |
| `/api/tmux/mouse` | POST | Set mouse mode |

### Setup

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/setup/scan` | POST | Scan projects directory for attachable projects |
| `/api/setup/complete` | POST | Complete first-run setup wizard |

### Groups & Shared Documents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/groups` | GET | List project groups |
| `/api/groups` | POST | Create a group |
| `/api/groups/:id` | GET | Get group details |
| `/api/groups/:id` | PUT | Update a group |
| `/api/groups/:id` | DELETE | Delete a group |
| `/api/groups/:id/members` | GET | List group members |
| `/api/groups/:id/members` | POST | Add member to group |
| `/api/groups/:id/members/:projectId` | DELETE | Remove member from group |
| `/api/shared-docs` | GET | List shared documents |
| `/api/shared-docs` | POST | Register a shared document |
| `/api/shared-docs/:id` | GET | Get shared document details |
| `/api/shared-docs/:id` | PUT | Update a shared document |
| `/api/shared-docs/:id` | DELETE | Delete a shared document |
| `/api/shared-docs/:id/lock` | GET | Check document lock status |
| `/api/shared-docs/:id/lock` | POST | Lock a shared document |
| `/api/shared-docs/:id/lock` | DELETE | Unlock a shared document |

### OpenClaw

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/openclaw/connections` | GET | List all connections |
| `/api/openclaw/connections` | POST | Create a connection |
| `/api/openclaw/connections/:id` | GET | Get connection details |
| `/api/openclaw/connections/:id` | PUT | Update a connection |
| `/api/openclaw/connections/:id` | DELETE | Delete a connection |
| `/api/openclaw/connections/:id/tunnel` | POST | Start SSH tunnel |
| `/api/openclaw/connections/:id/tunnel` | DELETE | Stop SSH tunnel |
| `/api/openclaw/connections/:id/approve-pending` | POST | Auto-approve device pairing |
| `/api/openclaw/test` | POST | Test SSH + gateway connectivity |

### Sidecar

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sidecar/:project/processes` | GET | Get background processes for a project |
| `/api/sidecar/connection/:connId/processes` | GET | Get background processes by connection ID |

### Eval Audit

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/audit/telemetry` | GET | Get audit telemetry |
| `/api/audit/ingest` | POST | Ingest exchange data for evaluation |
| `/api/audit/heartbeat` | POST | Heartbeat for audit sessions |
| `/api/audit/retention/run` | POST | Run retention cleanup |
| `/api/audit/:project/scores` | GET | Get evaluation scores |
| `/api/audit/:project/scores/:id/human` | POST | Submit human review of a score |
| `/api/audit/:project/anomalies` | GET | Get detected anomalies |
| `/api/audit/:project/summary` | GET | Get audit summary |
| `/api/audit/:project/baseline` | GET | Get quality baseline |
| `/api/audit/:project/baseline/recompute` | POST | Recompute baseline |
| `/api/audit/:project/trends` | GET | Get quality trends |
| `/api/audit/:project/wrap-quality` | GET | Get wrap quality metrics |
| `/api/audit/:project/incidents` | GET | List incidents |
| `/api/audit/:project/incidents/:id` | GET | Get incident details |
| `/api/audit/:project/incidents/:id` | PUT | Update incident |

### Per-Route Body Size Limits

The server enforces per-route body size limits rather than a single global limit. Most API routes use the default JSON body limit, while the upload endpoint allows larger payloads to accommodate base64-encoded files.

| Route | Max Body Size | Notes |
|-------|--------------|-------|
| `POST /api/upload` | 15 MB | Accommodates base64-encoded files (overhead ~33% over raw file size) |
| All other routes | Default (100 KB) | Standard JSON payloads |

These limits are configured in `server.js` using per-route middleware.

### Upload System

The upload system (`lib/uploads.js`) allows files to be sent into project directories from the session wrapper UI.

- **Endpoint**: `POST /api/upload` — accepts a JSON body with `project`, `filename`, and `data` (base64-encoded file content)
- **Endpoint**: `GET /api/uploads?project=name` — lists previously uploaded files for a project
- **Size limit**: 15 MB per upload (enforced by route-level body size middleware)
- **File type allowlist**: Only files with permitted extensions are accepted: `.png`, `.jpg`, `.jpeg`, `.gif`, `.pdf`, `.md`, `.txt`, `.json`, `.yaml`, `.yml`. Attempts to upload disallowed file types are rejected with a 400 error
- **Storage**: Uploaded files are saved to the project's `.uploads/` directory with timestamped filenames (e.g., `20260314-143022-screenshot.png`). The response includes the full file path so it can be referenced in AI assistant conversations
