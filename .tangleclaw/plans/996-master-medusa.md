# Plan — #996: Wire Medusa to the Master

**Issue:** [#996](https://github.com/Jason-Vaughan/TangleClaw/issues/996) (OPEN, verified 2026-08-21) · **Milestone:** Master Control (#829)
**Predecessors:** #768 (control bar, Medusa slot shipped as a labelled placeholder) · #755/#968 (access level, server-enforced) · MED-2K9P (session switchboard v1)
**Status:** chunk 1 SHIPPED 2026-08-21 as #1079 (`6b05c52`), live on the operator's install (Master listening as `project-master-1ad424e1`); chunk 2 BUILT 2026-08-21 (branch `feat/996-master-medusa-bar`). Chunk boxes are in `## Status` at the bottom.

## Why this slipped

#768 parked Medusa behind open question Q3 — *"should the Master be a participant at all, and if Medusa ships before #755 it must be read-side only."* #755 shipped 2026-08-18. The gate is gone; nobody reopened the door. Operator, 2026-08-19: *"i dont see medusa active in the master session."*

## What is true today (verified against the tree at `95ee854`)

| Fact | Evidence | Consequence |
|---|---|---|
| The Master is live, runs **`claude`**, at **`write`** | `config.master = {accessLevel:"write", engine:"claude", launchMode:"bypassPermissions", autoStart:true}`; `tmux has-session =tangleclaw-master` → live | #996's "the Master runs codex" is stale. A `claude` Master has a **wake profile** (`lib/medusa-wake.js:98`), so inbound nudges work on day one. |
| Every switchboard route is `/api/sessions/:project/medusa/*` (10 routes, `server.js:3486–3695`) | each resolves `projects.getByName` → `sessions.getActive` | No path for a non-project. This is the whole bug. |
| `lib/medusa.js` is already target-agnostic | `startSession({projectPath, sessionId, name})`; listeners keyed by `String(sessionId)`; registry at `<projectPath>/.tangleclaw/medusa/registry.json` | Passing `projectPath: masterHome(), sessionId: 'master', name: 'Project Master'` **works unchanged** — and the registry pins the workspace id to the Master's home, so it is **stable across kill/restart**. #996 Q2 is already answered by the existing mechanism. |
| The bar's Medusa slot is an honest placeholder | `public/api-helper.js:2065` `TC_MASTER_PENDING.medusa` | Going live means deleting that entry and mounting the real control — "the moment a control goes live on the Master it must be the extracted component, not a copy" (`api-helper.js:2040`). |
| The session Medusa UI is **not extracted** | `public/session.js:1092–1870`, singleton ids (`#medusaControl`, `#medusaPanel`…), module-global `projectName` | The frontend chunk is the expensive one. |
| The Master is told it is *not* a participant | `lib/master.js:1389` HOWTO.md: *"you observe through the activity feed — you are not a participant"* | Must flip with the feature, or the Master will ignore its own inbox. |
| `broadcastSharedDocUpdate` targets group members only (`server.js:41–45`) | | The Master stays excluded; out of scope here (noted below). |

## Decisions (the four #996 questions — recommended, vetoable)

1. **Routes: a parallel `/api/master/medusa/*` surface, built from the SAME handlers — no synthetic project row, no duplicated bodies.** The ten session routes become `registerMedusaRoutes(prefix, resolveTarget)`; `resolveTarget(params)` returns `{projectPath, sessionId, name}` or a typed error. Sessions pass the existing lookups; the Master passes `{masterHome(), 'master', 'Project Master'}` when its tmux session is live (409 `NO_SESSION` otherwise, same as a project with no session). A fake project row would leak into listings, the dashboard, the fleet map and `listProjects` callers — rejected.
2. **Identity: pinned to the Master's home via the existing registry** (`~/.tangleclaw/master/.tangleclaw/medusa/registry.json`). Nothing new to build; one test proves kill → ensure yields the same workspace id.
3. **Access level gates the outbound half, at request time.** `read-only` → inbox, read-mark, roster, status, toggle work; `send`, `loop`, `loops/*` return **403 `ACCESS_LEVEL`** naming the level and how to change it. `suggest` and `write` → full. **Shipped reading CONFIG per request rather than the guard's `.access-level` file** (deviation from the drafted line, recorded 2026-08-21): `PATCH /api/config` writes both in one request so the flip still binds with no restart, and config is the authority the operator set — the file is the guard's copy of it, and modelling a second reader of it would only create a place for the two to disagree.
4. **Loop discipline goes into the generated identity.** `buildMasterClaudeMd` gains a switchboard section mirroring `_medusaPrimeSection` (workspace id, *initiator closes*, *context-not-task*, the `/api/master/medusa/*` paths, "do not open your own WS"). HOWTO.md's "you are not a participant" line flips to the truth.

**Enablement:** `config.master.medusaEnabled` (boolean, default `false`, validated in the master PATCH like `autoStart`) — same opt-in shape as projects' `medusaEnabled`, and the bar toggle persists it. Boot resync + every `ensureMasterSession` start the listener when enabled; `killMasterSession` stops it. **On this install I flip it on as part of delivery** — that is what the operator asked for.

**Wake:** `config.master.medusaWake` (boolean, default `false`) mirrors the project pref; `medusa-wake` scans a synthetic Master record (`id:'master'`, `tmuxSession:'tangleclaw-master'`, the resolved engine) and the nudge text is parameterised by API prefix instead of project name. Flipped on here too, so an inbound message actually reaches the Master's pane.

## Chunks

### 1. Backend — the Master becomes a participant (worktree; touches `server.js`)
- `server.js`: `registerMedusaRoutes(prefix, resolveTarget)`; mount at `/api/sessions/:project/medusa` (unchanged behaviour, existing `test/api-medusa.test.js` must pass untouched) and `/api/master/medusa`.
- `lib/master.js`: `medusaEnabled`/`medusaWake` in `masterSettings`; `ensureMasterSession` starts the listener when enabled (created *or* already live); `killMasterSession` stops it; `getMasterStatus` reports `medusa: getStatus('master')`; access-level gate helper; identity section + HOWTO flip.
- `lib/sessions.js#resyncMedusaListeners` (or a sibling in master.js wired from the same boot site): resync the Master.
- `lib/medusa-wake.js`: Master scan + prefix-parameterised nudge.
- Tests (each mutation-checked red first): route parity (same handler, both prefixes); 409 without a live Master; stable workspace id across kill→ensure; 403 on outbound at `read-only`, 200 at `suggest`/`write`, flip binds without restart; identity contains the workspace id and the initiator-closes rule; HOWTO no longer says "not a participant"; wake nudges the Master pane with the master path; boot resync.
- CHANGELOG `### Added`. FEATURES.md row.

### 2. Frontend — the bar's Medusa slot goes live (worktree; touches `public/`)
- Extract the session Medusa control — mark, state/help text, toggle, inbox panel, peers hover, inbound/outbound flow animation — into `tcCreateMedusaControl({ apiBase, root, ids })` in `public/api-helper.js` (already loaded by both pages → **no `sw.js` change, no `CACHE_NAME` bump**). `session.js` mounts it with `apiBase: /api/sessions/${projectName}/medusa` and identical ids, so the three source-pinned frontend suites re-point rather than rewrite (the #768 chunk-1 precedent).
- Master bar + landing Master panel mount the same component with `apiBase: /api/master/medusa`; delete `TC_MASTER_PENDING.medusa` (its removal is the proof the pending treatment came off with the backend — the `access`/`kill` precedent).
- At `read-only`, the send affordance renders disabled **with the 403 reason**, never inert.
- **Carry-in from chunk 1 (found live):** `PATCH /api/config {master.medusaEnabled}` syncs the listener but does not regenerate the identity, so until the next ensure the Master is on the bus with instructions that still deny it. Call `refreshMasterIdentity({skipIfAbsent:true})` on that change, as the access-level path does; pin with a test.
- **Loop modal / loops panel stay session-only in this chunk** — they are a further ~500 lines and a fleet-command design question (#961). Filed as a follow-up, rendered absent-with-reason on the Master.
- CHANGELOG `### Added`; `public/` tests.

## Explicitly out of scope (filed or to file)
- Shared-doc broadcast (#945) including the Master — needs a "Master subscribes to group N" model. Follow-up issue.
- Master loops UI — follow-up issue (see chunk 2).
- `lib/master.js` hardcodes `CLAUDE.md` as the identity filename (`:1794`) — violates the engine-agnostic rule; pre-existing, not this feature's to fix. File it.
- #1075 (Elliot: roster 502 with no bridge) — the route factory makes the fix one place; still its own issue.

## Standing constraints
- `public/` and `server.js` are served live off the primary checkout → **both chunks in a worktree** (`git worktree add .claude/worktrees/996-chunkN feat/996-…`), symlink `.prawduct/*` except `change-log.md`, plus `.tangleclaw/plans`. Primary stays on `main`.
- Never bump `CACHE_NAME` (#710).
- Critic is paused (2026-08-19 ratification); back-run planned. Mutation-verify every guard in lieu.

## Status
- [x] Chunk 1 — backend participant (2026-08-21: route factory + master mount, lifecycle on live∧enabled, home-pinned identity, outbound gate w/ per-request read, identity+HOWTO, wake record, boot resync, PATCH sync. Suite green; 7 mutations red. CHANGELOG `### Added`, FEATURES row.)
- [x] Chunk 2 — bar control live (2026-08-21: `tcCreateMedusaControl` extracted to api-helper.js, session re-pointed via hooks, bar mounts it on both surfaces, `medusa` pending reason removed, `/api/master/status.medusa.outbound`, PATCH identity refresh carry-in closed, popover/inbox CSS moved to shared-controls.css. Suite green; 9 mutations red.)
