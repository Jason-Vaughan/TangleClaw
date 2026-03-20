## Shared Documents

TangleClaw supports shared documents — files that multiple projects can reference or embed in their AI engine configs. Shared docs are organized by **project groups**.

### What Are Groups and Shared Docs?

A **group** links related projects (e.g., "habitat infra"). Each group can have **shared documents** — markdown files that are injected into engine configs at session launch. Groups may also have a **shared directory** (`sharedDir`) — a folder whose `.md` files are auto-discovered and registered on session launch.

### API Operations

All calls are JSON. Use `curl` or equivalent. The TangleClaw API base URL is injected below this guide.

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
