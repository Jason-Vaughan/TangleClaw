## Shared Documents

TangleClaw supports shared documents — files that multiple projects can reference or embed in their AI engine configs. Shared docs are organized by **project groups**.

### What Are Groups and Shared Docs?

A **group** links related projects (e.g., "backend services"). Each group can have **shared documents** — markdown files that are injected into engine configs at session launch. Groups may also have a **shared directory** (`sharedDir`) — a folder whose `.md` files are auto-discovered and registered on session launch.

### Authentication

When the operator has enabled the **M2M service-token gate** (AUTH-4), every call to `/api/shared-docs*` (and a group's `/sync`) requires an `Authorization: Bearer <token>` header — without it the API returns `401`. TangleClaw injects the required header (with the live token) **below this guide** at session launch; copy it onto each request. When the gate is off (the default), no token is required. Rotating the token invalidates the old one — relaunch the session to pick up the new value.

```
curl -H "Authorization: Bearer $TANGLECLAW_SERVICE_TOKEN" .../api/shared-docs?groupId=<group-id>
```

### API Operations

All calls are JSON. Use `curl` or equivalent. The TangleClaw API base URL is injected below this guide. When the service-token gate is on, add `-H "Authorization: Bearer <token>"` to every call below.

**List shared documents** available to your project:
```
GET /api/shared-docs?groupId=<group-id>
```

**Register a new shared document**:
```
POST /api/shared-docs
{ "groupId": "<group-id>", "name": "NETWORK", "filePath": "/path/to/NETWORK.md", "injectIntoConfig": true, "injectMode": "reference" }
```

**Lock a document before editing** (prevents concurrent edits):
```
POST /api/shared-docs/<doc-id>/lock
{ "sessionId": <session-id>, "projectName": "my-project" }
```

**Unlock after editing**:
```
DELETE /api/shared-docs/<doc-id>/lock
```

**Trigger directory sync** (re-scans the group's shared directory for new files):
```
POST /api/groups/<group-id>/sync
```

### Shared Directory Convention

Groups can have a `sharedDir` path. On session launch, TangleClaw scans that directory for `.md` files and auto-registers any new ones. File names become doc names (e.g., `NETWORK.md` becomes "NETWORK"). Already-registered files are skipped.

### Lock Etiquette

- **Lock before editing** a shared document to prevent conflicts with other sessions.
- **Unlock after editing** so other sessions can access the file.
- Locks expire after **30 minutes** if not released. Sessions auto-release all locks on wrap or kill.
