# Change Log — TangleClaw

<!-- Append new entries at the top.

Tag-line conventions (ART-4K9M, ratified 2026-07-17):
- scope=  : ONE scope per unit of work. Work done under an ACTIVE build plan uses that
  plan's frontmatter scope (its ## Status roster derives checkbox flips from these tags).
  Post-plan work — backlog items, GH-issue fixes, chores landing after the plan is
  archived — gets its OWN scope (kebab-case of the backlog id or issue, e.g. ui-2p7t,
  wrap-583), NEVER a borrowed scope from an archived plan: an archived roster can't track
  new chunk ids, so borrowed tags rot (the ART-4K9M failure). A scope with no build-plan
  file is fine — regen-views flags it only while status=merged, and deliberately not once
  status=shipped (retired/planless scopes are expected history).
- chunks= and status= : **RETIRED upstream (prawduct 3.4.0, `lib/change_log.py`), along with
  the derived views that were their only reader.** Which chunks an entry shipped now belongs in
  the entry BODY, where readers actually look — the 2026-09-06 entries write `Train 13 Chunk NN.`
  as their first line. Historical entries carrying either key still parse (the parser preserves
  unknown keys), so nothing below needs rewriting; the two bullets that follow are kept as the
  record of why they existed and are no longer instructions. Noted 2026-09-06 because this header
  still read as live guidance and produced a `chunks=05` tag line on the Chunk 05 entry before a
  Critic pass caught it.
- status= : (none) on branch → `shipped` stamped at merge (AMENDED 2026-07-17, ratified
  under ART-7W2J/PRW-9K4C: upstream trunk semantics — TC restarts the server onto main
  right after merge, so merged work IS live; the wrap's version number is bookkeeping.
  The prior intermediate `merged` state created a merge→wrap window where prawduct
  3.0.5's fail-closed regen-views flagged every planless small-fix scope fatally).
  The WRP-9F2K release flip stays as a safety net (flips any `merged` stragglers at
  the next wrap promote); a STATUSLESS tag line remains the missed-stamp diagnostic.
  TC skips `release=` tokens — CHANGELOG.md is TC's release-notes surface, not
  prawduct's release-notes.md. regen-views derives build-plan Status checkboxes from
  status=shipped ONLY — the old convention left released work stuck at `merged`, which
  un-ticked genuinely shipped chunks (2026-07-17 back-stamp: 29 entries across
  v4.5.0–v4.19.0).
-->

## 2026-09-22 — PortHub refuses an unleased listener, refuses an ambiguous host-less release, and stops deleting non-project owners' leases (#814, #853, #1381)

<!-- prawduct: type=bugfix | scope=train-b2-chunk2 -->

Train B.2 Chunk 2. `POST /api/ports/lease` now calls `porthub.registerPort`, which returns the stored lease and passes `autoRenew`/`ownerKind` through; the route states `permanent: body.permanent === true` to keep the HTTP default. `registerPort` runs `_checkListener` first: renewal (live lease, same project) skips the probe; another project's live lease defers to the store (`PORT_CONFLICT`, or `takeover` with `force`); otherwise on localhost `lib/port-scanner.js#probePort` runs `lsof -nP -iTCP:<port> -sTCP:LISTEN` with stderr captured (exit 1 with no stderr = clear; any other failure falls back to the cached scan, then `unavailable`). An unleased listener returns `PORT_IN_USE` unless `adoptListener`. All in-process callers (bootstrap, `lib/tunnel.js`, OpenClaw connection create/update) pass `adoptListener: true`. `store.portLeases.isLive` exposes `_isLeaseLive` so the check cannot drift from the conflict rule. Bootstrap enrols `caddyHttpsPort`/`caddyHttpPort` when `ingressMode === 'caddy'`. `GET /api/ports` adds `systemPorts`. Release refuses `HOST_REQUIRED` when `host` is omitted and a non-localhost lease exists for the port. Schema v43→v44 adds `port_leases.owner_kind` (CHECK from `LEASE_OWNER_KINDS`, DDL read back as in v35). The upsert keeps the stored kind for the same owner and resets it on a cross-project takeover. `setOwnerKind` backs `POST /api/ports/owner-kind`. `releaseByProject` takes `ownerKind`, and the orphan sweep passes `project` and skips `external`. The import route no longer calls `releaseByProject`. The banner skips `external`, adds **Not a project** (`markLeaseOwnerExternal`), and no longer auto-ignores "directory not found" names. The port tests now stub the probe (`_setExec`) so they grade the registry and not the host's listeners. The old `registerPort` "succeeds even when scanner shows port in use" case is replaced, not weakened: #814 reverses that requirement. Critic round (rev-20260922T040856Z-11b64dc3, 0 blocking) fixes: the lease route coerces and range-checks `port` (a string skipped the probe); `checkPort` probes fresh instead of reading the cache, so `nextFreePort` and OpenClaw connection create/update see a busy port, and those two call sites no longer pass `adoptListener` (their tunnel is not up yet); bootstrap releases TangleClaw's own `caddy-*-ingress` leases outside caddy mode; `_checkListener` owns `takeover`; `test/api-openclaw.test.js` and `test/tunnel.test.js` answer the probe from fixtures (tunnel: from the ports its own servers bound, so dropping the tunnel's `adoptListener` still fails two tests, checked by mutation). Every suite that creates OpenClaw connections (`api-openclaw`, `ui-openclaw`, `openclaw-approve`, `openclaw-version-route`, `openclaw-ssh-routes-nonblocking`) installs the new `test/_probe-stub.js`, because a fresh `checkPort` otherwise saw this host's listener on fixture port 18789. Three migration tests that pinned 43 as the newest stamp now read `CURRENT_SCHEMA_VERSION`; each keeps its invariant (the shared line stamps only the current version, exactly once). The fleet-surface "additive only" working rule in `api-contract.md` has a recorded departure for `PORT_IN_USE` and `HOST_REQUIRED`: both refusals name their fix, so a session primed with the older guide recovers without a relaunch.
<!-- Older entries live in .prawduct/change-log-archive/YYYY-MM.md, moved there verbatim by `prawduct-hook archive-change-log`. -->

## 2026-09-22 — `.gitignore` names prawduct's session files explicitly (gitignore-contract advisory)

<!-- prawduct: type=chore | scope=gitignore-contract-drift -->

Ran `prawduct-hook update-gitignore`, then folded its duplicate `# Prawduct session files` header into the existing block. Adds `.prawduct/.test-report.xml`, `.prawduct/.test-report.xml.scope.json`, `.prawduct/.critic-review-dispatch.json` and `.prawduct/.pr-review-dispatch.json`, all already covered by `.prawduct/*`. `--dry-run` now reports no changes needed. The PR flow's `archive-change-log --apply` then refused because `.prawduct/*` ignored `.prawduct/change-log-archive/`; added `!.prawduct/change-log-archive/` and re-ran it: 284 shipped entries moved verbatim into five monthly files, live log 812 KB → 19 KB. No moved entry carries a `status=merged` tag line (the matches are body prose), so `version-bump.js`'s WRP-9F2K flip, which reads only the live log's tag lines, loses nothing. The prawduct learnings migration named in the same advisory batch is not in this change: it requires committing the untracked `.prawduct/learnings*.md` to this public repo, which is held for a decision.

## 2026-09-22 — The projects API answers each caller only for what it owns; project delete/archive are operator-only; ingest refuses an unbound connection (#1739, #1746, #1261)

<!-- prawduct: type=bugfix | scope=train-b2-chunk1 -->

Train B.2 Chunk 1. New `lib/project-view.js` shapes each enriched project row using `sharedDocsAccess.resolveAccess`. The operator and the verified Master get the row itself, and a bound project gets its own row. Everyone else gets an allowlist projection (`id, name, registered, archived, tags, engine{id,name}, session{active,status,startedAt}, restricted`). The `scan` block drops `dir`/`hint` for those callers. `GET /api/projects` and `GET /api/projects/:name` both shape, and neither refuses. `server.js#projectOperatorCaller` gates `DELETE /api/projects/:name`, `archive` and `unarchive` with `403 OPERATOR_ONLY` before any lookup. A set delete password is still checked after it. `POST /api/audit/ingest` answers `409 CONNECTION_UNBOUND` and stores nothing when no project is bound to the authenticated connection. It no longer reads `body.project`, and archived projects stay bound. `server.js#projectsReader` logs a presented binding that is not honoured at `warn`, because the read is never refused. Existing tests that played an unbound caller now name the operator; their assertions are unchanged. The Master prime says to send its binding on `GET /api/projects`. Follow-ups filed: #1752 (the remaining project write routes), #1753 (a gate-down dashboard over plain http is not seen as the operator).


## 2026-09-21 — Shared-docs and groups writes are limited to the caller's own groups; registration and group management are operator-only (#1626)

<!-- prawduct: type=bugfix | scope=hotfix-b1-shared-docs-authz -->

Hotfix B.1 Chunk 04. `sharedDocsCaller` now takes a need (`lib/shared-docs-access.js#NEEDS`: read, write, operator), and `refusalFor` answers it before any lookup. Register, lock, unlock, notify and sync admit only the operator and a member project (`canWriteGroup`); another group answers 404 like a missing id. `PUT`/`DELETE` of a document and all group and membership changes are operator-only. D8: every non-operator, even an unbound one, gets `OPERATOR_ONLY`, because no binding would help. D7: the Master gets `SHARED_DOCS_READ_ONLY` on member writes, since `OPERATOR_ONLY` would misstate those routes. The Chunk 03 review items O-3 ("on these routes") and O-4 (the tmux cause in the refusal log) are carried in. The Critic had no blocking findings. Its observations fixed here: the fleet runbook and user guide still curled operator-only routes from a pane; the guide's "editing is the operator's" contradicted "lock before editing" (it now names the registration); and the Master's write refusal rested on each route passing `NEEDS.WRITE`, which `canWriteGroup` now backs. Only two notify tests wrote as bare clients; they now call as the operator, and none is weakened. This PR closes #1626.

## 2026-09-21 — Shared-docs and groups reads answer only a bound caller, scoped to its groups (#1626)

<!-- prawduct: type=bugfix | scope=hotfix-b1-shared-docs-authz -->

Hotfix B.1 Chunk 03. `server.js#sharedDocsCaller` resolves the caller and sends the refusal before any lookup. The six read routes (`/api/groups`, `/api/groups/:id`, `/api/groups/:id/members`, `/api/shared-docs`, `/api/shared-docs/:id`, `/api/shared-docs/:id/lock`) filter on `canSeeGroup`. A non-member group or document answers 404, identical to a missing id; the bare list is scoped, not refused. Both preconditions were checked first: the live Master carries a launch id, and PV-AI-Guidebook sends both headers. D6 bounds the Master's synchronous tmux read at 1s (`MASTER_READ_TIMEOUT_MS`), failing closed. The plan said the dashboard tests would pass unchanged, but they were bare machine clients, not dashboard-shaped. They now declare their caller through `test/_shared-docs-callers.js`, and none is weakened. The guide and carrier text flipped from "does not narrow" to describing the scoped answer. The Critic raised four warnings, none blocking: refusals are now logged (never with the launch id), the timeout is pinned by a route test, and `tc docs` no longer claims nothing is hidden. `GET /api/projects` still maps projects to groups and paths; that is filed as #1739, outside B.1. Writes remain for Chunk 04; its PR, not this one, closes the issue.

## 2026-09-21 — The Project Master gets a shared-docs launch binding, ahead of enforcement (#1626)

<!-- prawduct: type=bugfix | scope=hotfix-b1-shared-docs-authz -->

Hotfix B.1 Chunk 02. Each Master launch (`lib/master.js#ensureMasterSession`) now mints a `TANGLECLAW_LAUNCH_ID` into the pane. `resolveAccess` gains a `master` kind: `x-tangleclaw-role: master` together with the id held in the live `tangleclaw-master` tmux session environment (`tmux.readSessionEnv`, `master.liveMasterLaunchId`). A replaced or ended Master's id is `master-launch-stale`. If tmux does not answer, the claim is refused as `master-unverifiable`. The store is checked first, so a project's launch id is never promoted by adding the role header. D5: the binding is deliberately not persisted, because the tmux value cannot drift from the pane and needs no schema version. The Master's prompt and its `tc whoami` capability line now name both headers. The Critic's R-1 found that `bin/tc` forwards the new id on every request, which broke the Master's `tc start` (LAUNCH_NOT_BOUND). `server.js#_launchIdentity` now answers a Master request as a pane with no launch sequence. R-2 (a synchronous tmux read on the request path) is carried into Chunk 03. Chunk 03 must not enforce until the live Master has been relaunched.

## 2026-09-21 — Shared-docs callers carry a project binding, ahead of enforcement (#1626)

<!-- prawduct: type=bugfix | scope=hotfix-b1-shared-docs-authz -->

Hotfix B.1 Chunk 01. Adds `lib/shared-docs-access.js`. `resolveAccess` decides who is asking: an operator (signed-in session, or a browser-shaped request when the gate stands down), a project (a live launch id with an agreeing project claim), unbound, or invalid. Anything but operator or project is refused by default. The shared-docs guide and the committed carrier now tell sessions to send `x-tangleclaw-project-id` and `x-tangleclaw-launch-id`. No route consults the resolver yet, so no caller's behaviour changes. Why: the issue's proposed fix (filter on the project-id header) rests on a claim; the launch id is the only binding the server can check itself. The plan also found four more doors (the groups routes and `shared-docs/:id`), cross-group writes, and an unbound Project Master. Chunks 02–04 cover those, with the Master binding before any enforcement at the PM's ruling. The outside-caller check found `PV-AI-Guidebook/instruction.json` calling the bare route; it must migrate before read enforcement.

## 2026-09-19 — The handoff records one tree at one moment (#1648)

<!-- prawduct: type=bugfix | scope=handoff-1648 -->

Found by the Chunk 03 whole-trajectory review — the governance checkpoint the Train 21 plan names after Chunk 03, which had never been run. Verified against this install before the fix was written.

`tc.handoff/1`'s `worktree` block was three facts from three moments. `branch` came from the wrap scope's trunk, probed before the commit step ran. `headSha` came from the wrap's own commit step when it had one and from `scope.baseline.sha` — the sha the session LAUNCHED at — when it did not; BOTH are other moments, and the commit-step source is the one that survived a first attempt at this fix. `dirty` was measured fresh at staging, under a comment explaining why freshness mattered, two lines above two fields that had none. The preflight reads all three as one snapshot of one tree at one moment.

What that did here: `current.json` recorded `branch: main` with `headSha: 40b94e310`, a commit that has never been on main. It was the wrap branch's tip, and that branch was squash-merged, so the sha never lands on main at all. The next launch computed `movedHead`, answered `stale`, required a reconciliation and refused READY. **The steady-state verdict on a sound handoff was `stale`.** The session that found it had itself been handed `stale` at launch and written a reconciliation, taking the defect for correct process.

What was read first:
- `git.getInfo` already reads `branch` and `dirty` from one `status` invocation and `lastCommit` from one `log`. Adding `headSha` to that same `log` format keeps everything one measurement, rather than adding a second probe that could disagree with the first.
- Dropping the `scope.trunk.branch` fallback is deliberate, per `architecture.md`: a read that could not be established reports null and names itself, never a plausible default. An unmeasurable tree now records no branch instead of borrowing one from another moment.

The guard for this class existed and could not see it. Car 21.9 closed four defects of exactly this shape and extended `test/handoff-orchestration.test.js` — created by car 21.7 (#1585, PR #1608) — to pin them. But it called `_worktreeFacts(scope, 'abc123')` with a literal anchor, so the fallback was never reached and branch/sha agreement was never asked. It now also runs with no anchor and asserts that the branch it names contains the sha it names. The fix was verified by reinstating the defect and confirming the guard fails.

Three further defects were found by review of the fix itself, and all three were introduced by it. Preferring the wrap's commit sha looks obviously right and is not: when a wrap auto-branches off a protected branch, the commit lands on the WRAP branch and the original branch is checked back out, so the document would pair a measured `branch: main` with a sha main has never carried. That source is now gone entirely rather than reordered, and `_commitSha` went with it once nothing called it. `getInfo().branch` is never null — it answers the sentinels `unknown` and `HEAD`, both truthy — so a naive reader would have frozen a word that is not a branch into bytes nobody can repair; `measuredBranch()` is the reader that turns both into an honest absence. And an unmeasured tree was indistinguishable from a measured one at both ends: the document now carries `unestablished`/`readFailure` when a reading went short, and the launch treats a recorded side that established NOTHING as unverified rather than letting a readable probe stand in for a handoff that never captured the tree. The last is deliberately asymmetric — a recorded sha against an unreadable probe stays `stale`, because the recorded value is evidence and the probe's silence does not retract it.

A pre-existing test asserted the old sourcing from a synthetic scope pointed at a path that does not exist — the defect written down as a contract. It is replaced by two: an unmeasurable tree reports `branch: null`, and a real tree reports its own branch while the fixture hands in a deliberately wrong `trunk.branch` and a bogus `baseline.sha` that the step must ignore. The old fixture handed in the right answer, which is why it could not catch this.

## 2026-08-20 — #990: forensic review of the ungoverned Antigravity window fixes 8 confirmed bugs

<!-- prawduct: type=bugfix | scope=antigravity-window-990 | chunks=01,02,03,04,05,06,07 -->

A 5-dimension multi-agent adversarially-verified review of commit range `v5.8.0..v5.10.0` — a
window where a different AI engine (Antigravity) committed directly to `main` with no Prawduct
governance active — surfaced 17 raw findings collapsing to ~10 distinct root issues. One
(`startWrapSse` ReferenceError) was already fixed post-v5.10.0 by #1005. This work fixes the rest,
confirmed still live on `main`:

- Shared-doc `fs.watch` handles never re-targeted on a `filePath` edit and leaked on delete — the
  most severe finding, independently corroborated by 4 of 5 review dimensions.
- `codex.json` advertised `capabilities.supportsSilentPrime: true`, but `syncEngineHooks()` clears
  hooks for any non-`claude` engine instead of writing them — not dead code, a live UI lie: an
  operator could enable "Silent Prime" for a Codex project and nothing would happen. Turned off;
  real support filed as backlog ENG-8V3N.
- Multi-file upload had no `FileReader.onerror` — a failed read hung the modal forever.
- CHANGELOG's `## [5.9.0]` "Master Session Recovery" `### Fixed` entry was fabricated (no such fix
  exists anywhere in history) — corrected via an `[Unreleased]` note, without touching the locked
  released section.
- Removed the dead live-wrap-progress SSE subsystem (zero consumers since #1005 removed its only
  client) and deduped shared-doc notify logic between two drifting implementations.

Cumulative Critic review (`rev-20260820T181429Z-411d7e43`): 0 blocking, 2 warning + 2 note, all
fixed and re-verified clean. Full suite: 6508 pass / 0 fail / 1 skipped.

One thing worth naming for the next reader of this repo's history: two of the fixes above exist
*because* re-checking a claim rather than trusting it surfaced something worse than reported — the
Codex "dead code" finding turned out to be a live capability lie, and a shipped commit's own
message ("Added Next Action preview") didn't match what the diff actually built (documented
honestly in `FEATURES.md` rather than propagated).

<!-- prawduct: type=bugfix | scope=master-level-takes-effect-968 | chunks=01,02 -->

The first real use of #755 found it: the toggle moved, the guard permitted the write, and the Master
refused anyway. It was refusing itself — the change path refreshed the guard and not the identity, so
the Master read `read-only` from month-old instructions and never attempted the write the guard was
waiting to allow.

Three things generalise:

- **"One call site is not the family" applies to ARTIFACTS, not just code sites.** #755 chunk 1 made
  the guard immediate and chunk 2 put the level into the identity; the change path refreshed one of
  the two, and every test in the suite read one of the artifacts that WAS being written. The fix was
  to delete the partial refresher rather than add a third write to it.
- **A detector that fires on the healthy path is worse than no detector.** The first shape of the
  staleness check compared the identity's mtime to the session start — and the identity was rewritten
  unconditionally on every ensure, which both surfaces fire on drawer open. It would have shown
  "restart to apply" permanently, which is the exact permanent nag the ruling behind it rejected.
  Caught by review, not by me. Write-if-changed; the mtime is load-bearing, so not touching it is
  part of the contract.
- **Verify a mechanism before offering it as an option.** The tmux session-start comparison was
  probed before it was put to the operator as a choice, and the probe found more than the bug: the
  live Master had been running a month against instructions rewritten the day before, so *nothing*
  regenerated in that month had reached it.

Also learned: `tmux display-message` does not fail on an absent session — it answers for the attached
client — so an exact-match target cannot protect it and the caller must check existence separately.
The codebase already documented this at one call site; the new one repeated the mistake. It cannot be
held behaviourally in a headless run (no attached client to fall back to), so a source-level guard
holds it, and the guard had to strip comments first because both callers explain the hazard in prose
directly above the check.

**Chunk 2 — Master Kill (also #768 chunk 3).** `POST /api/master/kill` plus the bar's Kill button,
which shipped dim from #768 waiting for this route. It is the remedy chunk 1 makes load-bearing: the
guard binds a level change at once, the running Master does not, so restarting it is what makes it
act. Killing an absent Master is SUCCESS — the operator's intent is "not running" and it already
holds — while a tmux that will not answer refuses, because a kill that could not be confirmed is not
a kill, and `hasSession` would have flattened that wedge into "already stopped" during exactly the
condition where the Master is most likely still running. `kill` leaving `tcMasterPendingReasons` is
the assertion that the pending treatment came off WITH the backend rather than beside it — the same
pattern `access` set in #755.

**Classification:** bugfix
