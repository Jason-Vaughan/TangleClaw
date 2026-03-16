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
| `serverPort` | number | `3101` | Landing page HTTP server port |
| `ttydPort` | number | `3100` | ttyd terminal emulator port |
| `defaultEngine` | string | `"claude"` | Default engine for new projects |
| `defaultMethodology` | string | `"minimal"` | Default methodology for new projects |
| `projectsDir` | string | `"~/Documents/Projects"` | Root directory for managed projects |
| `deletePassword` | string\|null | `null` | Password for destructive operations (hashed via scrypt when saved) |
| `quickCommands` | array | see below | Global quick command buttons |
| `theme` | string | `"dark"` | UI theme: `"dark"`, `"light"`, `"high-contrast"` |
| `chimeEnabled` | boolean | `true` | Play audio chime when session goes idle |
| `peekMode` | string | `"drawer"` | Peek UI mode: `"drawer"`, `"modal"`, `"alert"` |
| `setupComplete` | boolean | `false` | Whether the first-run wizard has been completed. Set to `true` automatically for existing installs that lack this field. |

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

**Tables**: `projects`, `sessions`, `learnings`, `activity_log`, `port_leases`, `schema_version`

Current schema version: **2**

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

TangleClaw exposes 29 HTTP endpoints under `/api/`. All endpoints accept and return JSON. Error responses use the format:

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service health check |
| `/api/version` | GET | Version info |
| `/api/system` | GET | CPU, memory, disk stats |
| `/api/config` | GET | Global config (password redacted) |
| `/api/config` | PATCH | Update config fields |
| `/api/engines` | GET | List engines with availability |
| `/api/engines/:id` | GET | Engine profile details |
| `/api/methodologies` | GET | List methodology templates |
| `/api/methodologies/:id` | GET | Methodology template details |
| `/api/projects` | GET | List projects (filterable) |
| `/api/projects/:name` | GET | Single project detail |
| `/api/projects` | POST | Create project |
| `/api/projects/:name` | PATCH | Update project |
| `/api/projects/:name` | DELETE | Delete project |
| `/api/sessions/:project` | POST | Launch session |
| `/api/sessions/:project` | DELETE | Kill session |
| `/api/sessions/:project/status` | GET | Session status |
| `/api/sessions/:project/command` | POST | Inject command |
| `/api/sessions/:project/wrap` | POST | Trigger wrap |
| `/api/sessions/:project/peek` | GET | Peek at output |
| `/api/sessions/:project/history` | GET | Session history |
| `/api/ports` | GET | List all port leases |
| `/api/ports/lease` | POST | Create or renew a port lease |
| `/api/ports/release` | POST | Release a port lease |
| `/api/ports/heartbeat` | POST | Heartbeat a TTL lease |
| `/api/rules/global` | GET | Get global rules content |
| `/api/rules/global` | PUT | Save global rules content |
| `/api/rules/global/reset` | POST | Reset global rules to defaults |
| `/api/activity` | GET | Activity log |
| `/api/upload` | POST | Upload a file to a project directory (15 MB limit) |
| `/api/uploads` | GET | List uploads for a project (`?project=name`) |
| `/api/tmux/mouse/:session` | GET | Get mouse mode |
| `/api/tmux/mouse` | POST | Set mouse mode |

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
