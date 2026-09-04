# CLAUDE.md

<!-- This repo is governed by the Prawduct Claude Code plugin — see "Governance (Prawduct)"
below, under the PRAWDUCT:ANCHOR marker.

Two regions, and the marker is the boundary. Everything ABOVE `<!-- BEGIN:tangleclaw -->`
is hand-maintained and safe to edit. Everything between BEGIN:tangleclaw and END:tangleclaw
is written by TangleClaw and replaced on its next write — do not hand-edit inside it.

The "Global Rules" section below is a hand-maintained MIRROR of data/global-rules.md, the
file TC injects into every OTHER (non-plugin-governed) project's config. The two are pinned
equal by test/repo-governance-reference.test.js, so edit data/global-rules.md and copy it
here, never one alone. Where a mirrored rule does not hold for THIS repo, the exceptions
section immediately above it is the authority. -->

## Core Rules (Enforced)

- Update CHANGELOG.md with every change
- All functions must have JSDoc comments
- Write tests alongside implementation
- Follow session wrap protocol before ending
- All port assignments go through PortHub

## Extension Rules

- Update docs in same commit as code changes
- Use decision framework before adding code
- Independent Critic review after medium+ work

## This Repo's Exceptions To The Global Rules Below

The Global Rules section that follows is TangleClaw's guidance for the projects it manages, mirrored
here. TangleClaw is itself one of those managed projects, so the rules apply — except where this
repo's own tooling makes them wrong. Each exception below is the authority for this repo; the
mirrored rule stays as written because it is correct everywhere else.

- **Do not tag releases by hand.** The Releases & Versioning rule says to suggest
  `git tag -a vX.Y.Z && git push --tags` after a substantive merge. Not here: `.github/workflows/release.yml`
  creates the tag and publishes the Release as separate steps, so a hand-made tag races the workflow
  and can pin a commit whose `version.json` disagrees with the tag. `docs/release-process.md` is the
  authority on how a release is cut here, and it cites this exception.
- **The post-commit hook is opt-in**, and is not the tagger — see `docs/release-process.md`.

# Global Rules

These rules apply to all TangleClaw-managed projects, across all engines. Edit them from the TangleClaw landing page or via the API.

## General

- Follow the project's existing code style and conventions.
- Prefer small, focused commits over large monolithic ones.
- Keep functions short and single-purpose.
- Write commit messages that explain *why*, not just what.

## Build Plans & Chunks

Some engines store plans in their own global directory (Claude Code uses `~/.claude/plans/`), so plans get lost across sessions and collide between projects.

**Rule: Keep plans local to the project, in TangleClaw's directory — not an engine's.**
- After creating/updating a plan in plan mode, copy it to `<project-root>/.tangleclaw/plans/<name>.md`.
- The location is deliberately engine-neutral: a plan is project state, not engine state, so a project that switches engines keeps its plans. TangleClaw's wrap reads `.tangleclaw/plans/` first and still falls back to a legacy `.claude/plans/` directory where one exists, so existing projects keep working — but new plans go in the TangleClaw location.
- Memory entries and handoffs must reference the project-local copy by **absolute path** — never ambiguous relative paths like `.tangleclaw/plans/...`.
- Don't rely on an engine's global plans directory as the cross-session source of truth.

**Rule: Make plans and design docs openable from anywhere, not just as a local file path.** A local file path can't be opened from another machine, and the operator often reads on a different device.
- When you present a substantial plan, design doc, or reference deliverable, also make it available at a **shareable hosted link** the operator can open from any device — using whatever publishing capability your engine or harness provides.
- Keep the **same** link updated in place as the document evolves; don't mint a new link on each edit.
- The project-local file stays the canonical source; the shared link mirrors it.

**Rule: Archive plans whose chunk has shipped.** A plan outlives its purpose the moment its PR merges; leaving it beside active plans makes future sessions treat closed work as ready (the 2026-05-23 failure: recommended a chunk whose issue had closed 18 days earlier).
- When a plan's issue closes / PR merges, **move it to `<project-root>/.tangleclaw/plans/archive/`** (or the legacy `.claude/plans/archive/` if that is where the project's plans still live) rather than deleting — preserves the rationale without polluting the active listing.
- Before treating any plan as canonical, verify its issue is still **OPEN** (`gh issue view <N> --json state -q .state`), even for non-archived files. Archiving is convention; the issue-state check is the contract (it protects across fresh clones, which have no local archive).

## Memory Hygiene

Bridge memos — entries that exist only to span a specific gap (chat-ratified decisions not yet in the plan, in-progress migration context, open-incident notes) — turn into stale canon and mislead future sessions.

**Rule: Bridge memos must self-delete.** When creating one:
- Frontmatter `description` states it is **self-deleting** and names the cleanup criterion.
- The body opens with a prominent "Auto-cleanup check" section: (1) a short mechanical procedure to test whether the bridging condition still holds; (2) if resolved → `rm` the file AND prune its `MEMORY.md` line; (3) if pending → leave it, treat as canonical until ratified.
- The `MEMORY.md` index line signals the self-deleting nature.

When reading a bridge memo at session start, run its cleanup check before trusting it; if it says delete, delete + prune `MEMORY.md` first. This keeps bridging notes resolving into permanent docs (plans, specs, ADRs) instead of accreting as stale background.

## Priming Prompts

When a project grows a recurring "session role" (advisor, on-call review, debugging), save its priming prompt as a durable artifact, not chat memory.

**Rule: Save priming prompts as git-tracked files** at `<project-root>/.tangleclaw/priming/<role>.md` — the verbatim paste block plus a short "How to use", with a dated update history at the bottom so divergence is visible.

## Cross-Session Write Boundaries

When two sessions work related-but-distinct repos (advisor/builder, coordinator/executor), respect repo ownership.

**Rule: Don't write to the other session's repo from yours.**
- The advisor/coordinator doesn't commit to the builder/executor's repo, even when it would be faster.
- Send suggestions via memo-back (a paste-able block) or a shared bridge memo (subject to Memory Hygiene above).
- Either session may edit shared infrastructure (TangleClaw config, ports) — neither owns it.

This avoids merge conflicts, surprise git-log entries, and ambiguity over who owns which commit.

## Issues & Feature Requests

GitHub Issues are the canonical place for work outside current scope — searchable, citeable, assignable, and they feed public activity stats.

**Rule: File issues for bugs, deferred features, and open questions — don't bury them in chat or memory.** When something exceeds the current work item, suggest filing before continuing.
- Title `[type] subject`, type ∈ `bug`, `feature`, `chore`, `docs`, `question`.
- Body: what / why / how-to-reproduce (bugs) or expected behavior (features). Use `.github/ISSUE_TEMPLATE/` if the repo has them.
- Link from PRs/commits with `Fixes #N` / `Closes #N` (auto-closes on merge).
- Solo projects: file first, close via the PR — the history is the value.

## Branches & Pull Requests

Substantive work goes through a feature-branch PR (even solo) — the PR documents *why* a change happened, it's not just process overhead.

**Rule: Branch + PR for substantive work; direct main commits only for trivial doc edits or incident hot-fixes.**
- Branch names: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + `<short-name>`.
- PR titles in active voice ("Add X", "Fix Y when Z"). Body has What / Why / Test plan; link issues with `Fixes #N`. Delete branches after merge.

**Rule: Pair `gh pr create` with `gh pr merge --auto --delete-branch` for routine PRs** (docs, chore, version bumps, dependency updates, test-only) — GitHub then merges server-side the instant required checks pass, no session wait.
- **Use `--auto` for:** doc-only changes (README/CHANGELOG/MEMORY/plans/comments/JSDoc); mechanical chore PRs that don't shift how the project is built; test-only PRs.
- **Don't `--auto`:** anything that triggered a Critic review with unaddressed findings (wait until addressed); PRs touching CI/deploy/secrets/branch-protection; anything the user wants to review first.
- In Auto Mode the default is to enable `--auto` on every PR the session opens, including feature PRs and refactors. Branch protection still gates server-side, so the rule never overrides protection — it only removes the wait once gates clear.
- The merge strategy (merge commit, squash or rebase) is the methodology layer's call — a project's governance sets it, and this file does not prescribe it.
- Branch protection still gates: `--auto` waits for a required review, so it only removes the wait once gates clear — it never overrides protection. If auto-merge isn't enabled on the repo, `--auto` errors; enable it (Settings → Pull Requests) or fall back to `gh pr checks <PR#> --watch` + a manual merge.

## Releases & Versioning

Substantive milestones become tagged GitHub Releases — permanent citeable URLs that feed public activity.

**Rule: Tag with semver and create GitHub Releases with CHANGELOG-driven notes.**
- Semver: MAJOR breaking, MINOR features, PATCH fixes (pre-1.0 may use 0.x freely).
- After a substantive merge, suggest `git tag -a vX.Y.Z -m "..." && git push --tags`, then `gh release create vX.Y.Z --notes-from-tag` (or `-F <notes-file>` for curated CHANGELOG notes).
- Keep `CHANGELOG.md` in Keep a Changelog format: each merged PR adds to `[Unreleased]`; releases promote those entries to a dated section.

**Rule: TC's `version-bump` wrap step picks the bump level from `[Unreleased]` content — author entries under the subsection that produces the intended bump.**

| `[Unreleased]` content | Bump |
|---|---|
| `BREAKING:` or `BREAKING(` marker anywhere in body | **major** |
| Any `### Added`, `### Changed`, `### Removed`, or `### Deprecated` | **minor** |
| Only `### Fixed`, `### Security`, or `### Internal` | **patch** |

Rows are evaluated top-down, first-match-wins: a body with both `### Added` and `### Internal` matches **minor** (user-visible subsection wins; `### Internal` never vetoes a real feature). The patch row fires only when no minor- or major-triggering content is present.

`### Internal` (a non-Keep-a-Changelog subsection, added #231) covers refactors, test-only changes, dev tooling, CI tweaks, and doc-only edits — still logged in `CHANGELOG.md` for audit history, but treated as patch-tier so all-internal churn doesn't inflate the minor counter. Pick the subsection by **user-visible impact**, not file footprint: a one-line behavior change is `### Added`/`### Changed`; a 500-line no-user-effect refactor is `### Internal`. In doubt between `### Changed` and `### Internal`, ask "would an operator notice next session?" — yes → `### Changed`, no → `### Internal`.

## Repository Standards

Every repo should look professional to visitors — future-self, contributors, and hiring evaluators.

**Rule: Maintain a baseline of repository hygiene files; suggest missing ones when the project's stage warrants** — real value, not boilerplate spam (a pre-public solo project doesn't need ISSUE_TEMPLATEs yet; a client-facing one does). Baseline: `README.md` (what / why / install / use / status), `LICENSE` (explicit licensing helps even private repos), `CHANGELOG.md` (Keep a Changelog), `.gitignore` (language defaults + project-specific: env files, build outputs, OS noise), `.github/ISSUE_TEMPLATE/{bug,feature}.md`, `.github/PULL_REQUEST_TEMPLATE.md` (checklist + What/Why/Test-plan), and a `main` branch-protection rule (require status checks; require review once contributors arrive).

## Contributor Readiness

When a project is shown to contributors, clients, or hiring evaluators, help flip from solo-project to open-project hygiene.

**Rule: Anticipate contributor readiness; flag gaps proactively when the project signals it's going public** (triggers: "going public" / "bringing in a contributor" / "dev-for-hire showcase" / "portfolio" / about to be unprivated). Readiness sweep:
- README gets a stranger running the project with no prior context.
- LICENSE present and intentional (MIT / Apache 2.0 / BSL / AGPL, matching the commercial stance).
- CONTRIBUTING.md: dev setup, branch/PR conventions, test requirements, code-style expectations, where to file issues.
- CODE_OF_CONDUCT.md if open to public participation (Contributor Covenant is a sensible default).
- CI green and visible (README status badges linking the workflow).
- Recent activity visible — no months-stale main.
- Issue + PR templates present.
- Discoverable from the user's GitHub profile (pin a showcase repo; mention it in the profile README).

Treat the user's GitHub profile as their public portfolio: commit activity, public repos, GitHub Releases, stars, and contributions to others' repos all feed dev-for-hire credibility. Visibility is a feature, not a side-effect — when work crosses a showable milestone, suggest the visibility action.

<!-- PRAWDUCT:ANCHOR — static governance pointer managed by the prawduct plugin. Keep it small and version-free: principles, methodology, and the active version live in the plugin and are injected at session start. -->

## Governance (Prawduct)

This repo is governed by **Prawduct**, installed as a Claude Code plugin — not as
committed framework files. The principles, methodology, Critic protocol, and PR
review live in the plugin and are read on demand (run `/prawduct:methodology`);
they are intentionally not copied into this repo.

**Before writing any code, STOP and read the build cycle: `/prawduct:methodology building`.**
Skipping it is the #1 governance failure.

The hardest rules (everything else is in the plugin):

- **Tests are contracts** — fix the code, never weaken a test.
- **No "pre-existing" exception** — fix what you find, or flag why you can't.
- **Never silently drop a requirement** — say so explicitly.
- **Run `/prawduct:critic` after medium+ work** — never write Critic findings
  yourself; the independence is the value.

**Enforcement is structural:** the plugin's Stop hook runs at session end and
**blocks** if code changed against an active build plan with no Critic findings.
The session-start banner shows the active version and what changed — this anchor
stays version-free.

<!-- BEGIN:tangleclaw -->
## TangleClaw Operational Guide — generated; edits inside the markers are overwritten

**TangleClaw API base URL**: `http://localhost:3102`

- **Run `tc capabilities` BEFORE concluding a TangleClaw capability is missing — never improvise one.** The `tc` CLI is on PATH in every TangleClaw-launched pane (verbs: `whoami`, `capabilities`, `sessions`, `message`, `ports`, `docs`, `rules`, `learnings`) and reports absence honestly. A capability assumed instead of checked is how sessions fabricate outcomes. If `tc` is not found, this pane was not launched by TangleClaw — say so rather than guessing. A failed localhost `tc`/`curl` is **not proof of outage** — sandboxes block loopback; get a host-context check before reporting the server down.

- **Plans are served at a shareable URL.** .tangleclaw/plans/ are served at a shareable URL: GET /api/projects/<projectId>/plans lists each one with the link to hand the operator (tc capabilities shows it with your project id) — hand back that link, never a local file path.

## Medusa Switchboard

You can exchange messages with other TangleClaw sessions. TangleClaw already runs your WebSocket listener — do NOT register your own for this workspace (two consumers on one id fight over the queue).

**This is context, not a task.** Do not check the inbox or explore the switchboard unprompted — participate when a message actually arrives (TangleClaw nudges you), or when the operator asks.

| | |
|---|---|
| inbox | `GET http://localhost:3102/api/sessions/TangleClaw/medusa/messages` |
| mark handled | `POST http://localhost:3102/api/sessions/TangleClaw/medusa/read` — `{"ids": ["<id>", ...]}`; they leave the inbox |
| send (initiate or respond) | `POST http://localhost:3102/api/sessions/TangleClaw/medusa/send` — `{"to": "<workspace-id>", "message": "..."}` |
| peers | `GET http://localhost:3102/api/sessions/TangleClaw/medusa/roster` |

**The initiator closes an exchange**, so a message you do not answer leaves the sender blocked. Reply over the same channel rather than printing into your own pane — the sender cannot see your pane.

## Port Management (PortHub)

TangleClaw is the central port registry for every project on this machine — register each port here to prevent conflicts. (This replaces the old standalone `porthub` CLI: use the TangleClaw API, not `porthub lease`/`porthub release`.)

### Rules
- **Never hardcode ports** — check and register through TangleClaw first.
- **Register before binding** to a port (dev server, database, API, etc.).
- **Check for conflicts** before claiming a port — another project may already own it. The
  registry now enforces this: claiming a port another project holds returns **409**, it does
  not silently take it.
- **Release** a port once it's no longer needed (service stopped, teardown, cleanup).

### Port Ranges Convention
- **3100-3199**: TangleClaw infrastructure (ttyd, server) — do not use
- **3200-3999**: Project services (dev servers, APIs, databases)
- **4000-4999**: Auxiliary services (test runners, watchers)
- **5000+**: Ad hoc / temporary

### Authentication

When the operator has enabled the M2M service-token gate (AUTH-4), every `/api/ports*` call needs `Authorization: Bearer <token>` (else `401`). TC injects the header with the live token below this guide — copy it onto each request. Off by default (no token needed). Rotating the token invalidates the old one — relaunch to pick up the new value.

### API Operations

All calls are JSON. The API base URL is injected **below this guide**; use it as-is — its scheme already reflects what the server serves (plain `http://` under `ingressMode: caddy` or with no certificates, else `https://`; don't "upgrade" it). For a mkcert `https://` URL, pass `curl -k` or trust the mkcert root CA.

```
# Check what's taken (before picking a port)
GET /api/ports

# Register a port. Pass "permanent": true to survive restarts (the default over
# HTTP is false — an omitted flag gives you a non-permanent lease).
# Returns 201 on success, or 409 if another project already holds the port.
POST /api/ports/lease
{ "port": 3200, "project": "my-project", "service": "dev-server", "permanent": true }

# Register a temporary port (expires after TTL unless heartbeated)
POST /api/ports/lease
{ "port": 4000, "project": "my-project", "service": "test-runner", "ttl": 7200000 }

# Release a port when done. Always send your own "project": ownership is verified
# when present — releasing a port a DIFFERENT project still holds returns 409
# (add "force": true to override). Omitting "project" skips the check.
POST /api/ports/release
{ "port": 3200, "project": "my-project" }

# Heartbeat to keep a TTL lease alive. Send "project" too: renewing another
# project's lease returns 409.
POST /api/ports/heartbeat
{ "port": 4000, "project": "my-project" }
```

### When to Register / Release
- **Register** when adding any listening service (dev server, database, API) to a project, or spinning up a temporary test server.
- **Release** when removing a service from a project's config, permanently shutting one down (not just a temporary stop), or when the project no longer needs the port.

### Conflict Resolution

Claiming a port another project holds returns **409** with the current owner:

```json
{ "error": "Port 3200 on localhost is leased by \"other-project\" (dev-server). …",
  "code": "PORT_CONFLICT",
  "owner": { "project": "other-project", "service": "dev-server", "permanent": true } }
```

**Pick a different port in the same range.** That is the answer in almost every case — the
owner in the response tells you who has it without a second call.

Re-leasing a port **your own project** already holds is a renewal, not a conflict: it
succeeds normally, so idempotent re-registration on every boot needs no special handling.
An **expired** lease does not block anyone.

Taking over a live lease requires `"force": true` in the body. It is deliberately explicit
and it is logged with the displaced owner, because the displaced project is still running
against a port the registry no longer says is theirs. Use it only when you know the previous
owner is gone — otherwise release the port from the owning side first.

**Scope of enforcement, precisely.** `lease` is guarded. `release` and `heartbeat` are guarded
**when you name your project** (#656): a mismatch returns 409 with the current owner, just like
`lease`. The check is opt-in because these calls historically took only a port — a request that
omits `project` still releases or renews unverified, so the guarantee holds only for callers that
send their own project (always do). This closes the accidental case — an agent cleaning up after
itself no longer silently releases a neighbor's live port — but it is not authentication: nothing
binds the caller to the project name it sends, so a caller that supplies someone else's project
can still act on their lease. Treat release as the destructive call it is: send your `project`,
and release only ports your own project holds.

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

## Session Memory

TangleClaw provides a file-based memory system that persists context across AI sessions. Each project has a `.tangleclaw/memories/` directory.

### How It Works
- **Index**: `.tangleclaw/memories/MEMORY.md` — the entry point; it references any additional memory files.
- **Additional files**: topic-specific `.md` files alongside it (e.g. `ARCHITECTURE.md`, `DECISIONS.md`).

### At Session Start
Read `.tangleclaw/memories/MEMORY.md` to restore prior decisions, progress, open questions, and anything the previous session flagged for you.

### At Session End
Before wrapping, update memory with what the next session needs: key decisions and why, progress on multi-session work, open questions or blockers, and architecture notes or patterns discovered.

### Conventions
- Keep entries concise and actionable; organize by markdown heading.
- Don't duplicate what's already in code, git history, docs, or changelogs.
- Remove or update stale entries — memory should reflect current state.
- Plain markdown, no special syntax required.
<!-- END:tangleclaw -->
