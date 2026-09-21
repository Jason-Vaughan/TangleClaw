## Shared Documents

TangleClaw supports shared documents — markdown files multiple projects can reference or embed in their AI engine configs, organized by **project groups**.

### Groups & Shared Docs

A **group** links related projects (e.g. "backend services"). Each group can have **shared documents** injected into engine configs at session launch, and optionally a **shared directory** (`sharedDir`) whose `.md` files are auto-discovered and registered on launch (filename → doc name, e.g. `NETWORK.md` → "NETWORK"; already-registered files are skipped).

### Authentication

When the M2M service-token gate (AUTH-4) is on, every `/api/shared-docs*` call and a group's `/sync` need `Authorization: Bearer <token>` (else `401`). In a committed carrier the live token is deliberately absent — fetch it from `$TANGLECLAW_API/api/service-token` (#1619); in an engine-private config TC injects it below this guide. Off by default. Rotating the token invalidates the old one — relaunch to refresh.

### Identify Your Project

Send your project binding as two headers on every shared-docs and groups request:

```
x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID
x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID
```

TangleClaw exports both variables into every pane it launches, whatever the engine. The server resolves the launch id to your live session and checks that the project claim agrees with it, so it answers for your project's groups rather than every group on the install. With `curl`, that is `-H "x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID" -H "x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID"`. A pane with no `TANGLECLAW_LAUNCH_ID` predates launch binding: relaunch the session.

### API Operations

All calls are JSON and carry the two binding headers above. In an engine-private config the API base URL is injected **below this guide**; in a committed carrier read `$TANGLECLAW_API` instead (#1619).

```
# List docs available to your project
GET /api/shared-docs?groupId=<group-id>

# Register a new shared document
POST /api/shared-docs
{ "groupId": "<group-id>", "name": "NETWORK", "filePath": "/path/to/NETWORK.md", "injectIntoConfig": true, "injectMode": "reference" }

# Lock before editing (prevents concurrent edits), then unlock after
POST /api/shared-docs/<doc-id>/lock
{ "sessionId": <session-id>, "projectName": "my-project" }
DELETE /api/shared-docs/<doc-id>/lock

# Re-scan a group's shared directory for new files
POST /api/groups/<group-id>/sync
```

### Lock Etiquette

Lock before editing a shared doc and unlock after, so other sessions can access it. Locks expire after **30 minutes** if not released; sessions auto-release all locks on wrap or kill.
