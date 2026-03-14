# Methodology Guide

Methodologies in TangleClaw define how you work on a project — what phases you follow, what rules are enforced, how sessions wrap, and what gets captured.

## How Methodologies Work

A methodology is a JSON template that TangleClaw loads and enforces. Each project gets one methodology. The methodology controls:

- **Phases** — structured stages of work (e.g., discovery → planning → building)
- **Rules** — enforced behaviors (core rules are mandatory; extensions are opt-in)
- **Wrap behavior** — what happens when you end a session (what to capture, what steps to run)
- **Prime prompt** — what context is injected when a new session starts
- **Status contract** — how TangleClaw reads project status for the dashboard badge
- **Detection** — how TangleClaw recognizes that a project uses this methodology
- **Initialization** — what directories and files are created when a project adopts this methodology

## Built-in Templates

### Minimal

The default template. Core rules only — no methodology-specific workflow.

- **Phases**: None
- **Default rules**: Core only (changelog, JSDoc, tests, wrap protocol, PortHub)
- **Wrap steps**: learnings-capture, commit
- **Prime sections**: active-learnings, last-session-summary
- **Detection**: looks for `.tangleclaw/project.json`

Best for: projects where you want TangleClaw's session management without a prescribed workflow.

### Prawduct

Structured governance with discovery, planning, and building phases. Includes independent Critic review.

- **Phases**: Discovery (deep) → Planning (deep, offers context reset) → Building (normal, offers context reset)
- **Default rules**: Core + independentCritic, docsParity, decisionFramework
- **Wrap steps**: version-bump, changelog-update, learnings-capture, next-session-prime, commit
- **Prime sections**: methodology-rules, current-phase, active-learnings, last-session-summary, project-state
- **Status**: reads `work_in_progress.description` from `.prawduct/project-state.yaml`
- **Detection**: looks for `.prawduct/` directory
- **Actions**: "Run Critic" button in session wrapper

Best for: structured development with governance, planning artifacts, and independent review.

### TiLT

Identity-first development with trust signals and sentry verification.

- **Phases**: Setup (deep) → Development (normal, offers context reset) → Review (focused)
- **Default rules**: Core + identitySentry
- **Wrap steps**: learnings-capture, commit
- **Prime sections**: methodology-rules, current-phase, active-learnings, last-session-summary
- **Status**: reads `status` from `.tilt/status.json`
- **Detection**: looks for `.tilt/` directory

Best for: projects where identity verification and trust signals are important.

## Creating a Custom Methodology Template

Create a JSON file in `~/.tangleclaw/templates/<your-template-id>/template.json`:

```json
{
  "id": "my-methodology",
  "name": "My Methodology",
  "description": "A brief description of what this methodology does.",
  "type": "methodology",
  "version": "1.0.0",
  "phases": [
    {
      "id": "phase-one",
      "name": "Phase One",
      "description": "What happens in this phase",
      "weight": "deep",
      "offerContextReset": false
    },
    {
      "id": "phase-two",
      "name": "Phase Two",
      "description": "What happens next",
      "weight": "normal",
      "offerContextReset": true
    }
  ],
  "statusContract": {
    "command": "cat .my-method/status.json 2>/dev/null",
    "parse": "json",
    "field": "currentStatus",
    "badge": "status",
    "colorMap": {
      "phase-one": "blue",
      "phase-two": "green"
    }
  },
  "detection": {
    "strategy": "directory",
    "target": ".my-method"
  },
  "wrap": {
    "command": null,
    "steps": ["learnings-capture", "commit"],
    "captureFields": ["summary"]
  },
  "prime": {
    "format": "markdown",
    "sections": ["methodology-rules", "active-learnings", "last-session-summary"],
    "maxTokens": 3000
  },
  "defaultRules": {
    "docsParity": true
  },
  "actions": [
    {
      "label": "Custom Action",
      "command": "my-custom-command",
      "confirm": true
    }
  ],
  "init": {
    "directories": [".my-method"],
    "files": {
      ".my-method/status.json": "{\"currentStatus\": \"phase-one\"}\n"
    },
    "postInit": null
  }
}
```

### Template Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier (lowercase, hyphens) |
| `name` | string | yes | Display name |
| `description` | string | yes | Brief description |
| `type` | string | yes | Must be `"methodology"` |
| `version` | string | yes | Semver version |
| `phases` | array | yes | Workflow phases (can be empty `[]`) |
| `statusContract` | object | yes | How to read project status |
| `detection` | object | yes | How to detect this methodology |
| `wrap` | object | yes | Session wrap configuration |
| `prime` | object | yes | Prime prompt configuration |
| `defaultRules` | object | yes | Extension rules enabled by default |
| `actions` | array | yes | Custom action buttons (can be empty `[]`) |
| `init` | object | yes | Initialization config |

### Phase Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Phase identifier |
| `name` | string | Display name |
| `description` | string | What this phase is about |
| `weight` | string | `"deep"`, `"normal"`, or `"focused"` — affects prime prompt depth |
| `offerContextReset` | boolean | Whether to offer context reset on phase transition |

### Detection Strategies

| Strategy | Target | Description |
|----------|--------|-------------|
| `"directory"` | dir name | Check if directory exists in project root |
| `"file"` | file path | Check if file exists in project root |

### Prime Prompt Sections

Available sections for `prime.sections`:

- `methodology-rules` — methodology description text
- `current-phase` — current phase name and description
- `active-learnings` — promoted learnings from the database
- `last-session-summary` — wrap summary from the previous session
- `project-state` — reads project state file (Prawduct-specific)

### Status Contract Parsers

| Parser | Description |
|--------|-------------|
| `"json"` | Parse command output as JSON, extract `field` |
| `"yaml-field"` | Parse command output as YAML, extract dot-notation `field` |
| `null` | No status extraction (use with `command: null`) |

## Methodology Switching

You can switch a project's methodology at any time via the project settings on the landing page.

When you switch methodologies, TangleClaw:

1. Archives the old methodology state (e.g., `.prawduct/` → `.prawduct.archived/`)
2. Creates a documentation commit capturing the pre-switch state
3. Initializes the new methodology (creates directories and files)
4. Updates the project config

**Rollback**: The archive is just a renamed directory. To roll back, delete the new methodology's directory and rename the archive back. The documentation commit gives you a clean git state to return to.

## Rules

### Core Rules (Always Enforced)

These rules are mandatory for every project regardless of methodology:

| Rule | Description |
|------|-------------|
| `changelogPerChange` | Every code change must update the changelog |
| `jsdocAllFunctions` | All functions must have JSDoc documentation |
| `unitTestRequirements` | Code must have accompanying tests |
| `sessionWrapProtocol` | Sessions must be properly wrapped |
| `porthubRegistration` | Port assignments must go through PortHub |

Core rules cannot be disabled via the API or UI.

### Extension Rules (Opt-in)

These rules can be enabled or disabled per project:

| Rule | Default | Description |
|------|---------|-------------|
| `identitySentry` | off | Identity verification checks |
| `docsParity` | off | Documentation must match code changes |
| `decisionFramework` | off | Decisions must follow the decision framework |
| `loggingLevel` | `"info"` | Minimum logging level |
| `zeroDebtProtocol` | off | No technical debt allowed |
| `independentCritic` | off | Independent Critic review required |
| `adversarialTesting` | off | Adversarial test cases required |

Methodologies can set `defaultRules` to enable specific extensions automatically when a project adopts that methodology.
