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

TangleClaw exports both variables into every pane it launches, whatever the engine. They identify which project is asking: the launch id names your live session, and the project claim must agree with it. They are required: a shared-docs or groups request without them is refused with `403`, and with them you can read and change documents only in the groups your project belongs to — on these routes, another project's group or document answers `404`, as if it did not exist. Changing a document's registration (its file path, name or injection settings) or deleting it, and creating, changing or deleting a group or its members, are the operator's alone (`403 OPERATOR_ONLY`): ask the operator. Editing a document's contents is not a registration change; lock it first. With `curl`, that is `-H "x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID" -H "x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID"`. A pane with no `TANGLECLAW_LAUNCH_ID` predates launch binding: relaunch the session.

**Send `groupId`** when listing documents, to name the group you mean. Without it the list holds the documents of every group your project is in, never another project's. To find your group's id, `GET /api/groups` lists the groups your project is in.

### API Operations

All calls are JSON and carry the two binding headers above. In an engine-private config the API base URL is injected **below this guide**; in a committed carrier read `$TANGLECLAW_API` instead (#1619).

```
# List docs available to your project
GET /api/shared-docs?groupId=<group-id>

# Register a new shared document
POST /api/shared-docs
{ "groupId": "<group-id>", "name": "NETWORK", "filePath": "/path/to/NETWORK.md", "injectIntoConfig": true, "injectMode": "reference" }

# Lock before editing a document's contents (prevents concurrent edits), then unlock after.
# sessionId and projectName must be your own: the session and project your launch binding
# verifies (`tc whoami` prints both), else 403 LOCK_CALLER_MISMATCH. ttlMinutes is optional,
# a whole number from 1 to 120 (default 30), else 400. A lock cannot be renewed.
POST /api/shared-docs/<doc-id>/lock
{ "sessionId": <your-session-id>, "projectName": "my-project", "ttlMinutes": 30 }
DELETE /api/shared-docs/<doc-id>/lock

# Re-scan a group's shared directory for new files
POST /api/groups/<group-id>/sync

# Read a document's recorded revisions after a seq (author, changed rows, notice outcomes, latest, gap)
GET /api/shared-docs/<doc-id>/events?since=<seq>

# Read every member's notice setting; set your own ("mute", "subscribe" or "default"), per doc or per group
GET /api/shared-docs/<doc-id>/notices
POST /api/shared-docs/<doc-id>/notices
{ "setting": "mute" }
POST /api/groups/<group-id>/notices
{ "setting": "subscribe" }
```

### Lock Etiquette

Lock before editing a shared doc's contents and unlock after, so other sessions can access it. Locks expire after **30 minutes** if not released; sessions auto-release all locks on wrap or kill.

### Attested Edits

TangleClaw records every revision it observes of a shared document. A revision's author is `unknown` unless the writer attests it: lock, `tc docs base <doc>` (save the digest it prints), edit the file as usual, `tc docs attest <doc> --base <saved digest>`, unlock. The attestation is refused (`409`) unless your session holds the lock and the edit followed your saved base with nothing observed in between; never re-take a base to make it pass. Attested authorship proves the lock holder named its base, not who typed the bytes.

### Change Notices

A `shared_doc_updated` notice is sent by rule, not to everyone: the owners of the rows an **attested** author changed (a row whose first cell is a member project's name), and the members that subscribed; never the attested author. An unattested write or a prose edit reaches subscribers only. Set yours with `tc docs subscribe|mute|default <doc>` (or `--group <group>`); a doc setting overrides its group's. A mute touches these notices only, never direct mail, replies or HOLD/STOP. Missed one, or offline? `GET /api/shared-docs/<doc-id>/events?since=<seq>` is the record.
