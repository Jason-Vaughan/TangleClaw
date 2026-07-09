## Shared Documents

TangleClaw supports shared documents — markdown files multiple projects can reference or embed in their AI engine configs, organized by **project groups**.

### Groups & Shared Docs

A **group** links related projects (e.g. "backend services"). Each group can have **shared documents** injected into engine configs at session launch, and optionally a **shared directory** (`sharedDir`) whose `.md` files are auto-discovered and registered on launch (filename → doc name, e.g. `NETWORK.md` → "NETWORK"; already-registered files are skipped).

### Authentication

When the M2M service-token gate (AUTH-4) is on, every `/api/shared-docs*` call and a group's `/sync` need `Authorization: Bearer <token>` (else `401`); TC injects the header with the live token below this guide. Off by default. Rotating the token invalidates the old one — relaunch to refresh.

### API Operations

All calls are JSON; the API base URL is injected **below this guide**.

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
