---
artifact: build-plan
version: 2
scope: train-14
depends_on:
  - artifact: data-model
  - artifact: observability-strategy
  - artifact: architecture
  - artifact: project-preferences
  - artifact: nonfunctional-requirements
governed_by:
  - artifact: observability-strategy
    dispositions:
      - "Logs carry names, never payloads → conforms, and it is a design constraint rather than a checkbox in three chunks. Chunk 01's per-lease audit line carries project / service / port / host — all identifiers. Chunk 02's prune report carries event types and counts, never a `detail` column value, which is where a managed project's prose can reach the table. Chunk 05's CI failure names asset PATHS, not asset contents."
      - "Every logged error says what failed, why, and what the operator can do → ENGAGED, and Chunk 03 is a deliberate narrowing of it. #956 makes a durably-failing update check log its transitions instead of every occurrence; the quiet period between them is the whole point of the fix and is also, read strictly, a period in which the failing state is not in the log. The chunk conforms by keeping the fact reachable rather than repeated (recovery line + the state the status endpoint already carries), and records the reasoning as a DECISION rather than treating volume reduction as self-evidently fine — #916 filed the original warn precisely because a silently-undetectable install left no trace."
  - artifact: data-model
    dispositions:
      - "Governance state is derived from disk, never stored → inapplicable. No chunk stores a governance label; Chunk 06 changes how a project directory is READ, never what is persisted about it."
      - "A project's configuration travels with the project — `<project>/.tangleclaw/project.json` is the source of truth, the projects table holds only a queryable summary → conforms, and it bounds Chunk 02. `activity_log` is TangleClaw's own operational history, not any project's configuration, so a retention policy over it deletes nothing a project owns and nothing that must survive a move. Chunk 06 touches files that DO travel with the project (`<project>/.tangleclaw/continuity/**/uploads/`) and therefore changes only the read path, never the retention of those files."
      - "The Project Master has no sessions or projects footprint → applicable, and it is the trap Chunk 02 must not fall into. `tangleclaw-master` writes activity rows with a NULL `project_id`, and `_pruneSessionRuleDeliveries` documents in its own JSDoc that a per-project prune never touches NULL-project rows. A retention key of `project_id` alone would therefore leave exactly the singleton's rows unbounded. Chunk 02 keys on `event_type`, which has no NULL class."
  - artifact: architecture
    dispositions:
      - "A dependency's failure degrades TangleClaw, never crashes it → conforms, and Chunk 06 is the norm applied: a hung read of an operator's project directory becomes a named, killable failure on the uploads routes instead of a stalled server."
      - "A read that could not be established reports null and names itself, never a plausible default → ENGAGED by Chunk 06 and it is the chunk's sharper half. `listUploads` today opens with `if (!fs.existsSync(uploadsDir)) return []`, which reports the same empty list for 'this session uploaded nothing' and for 'this directory could not be read'. Routing the read through the killable scanner without carrying that distinction would move the hang and keep the lie."
      - "Bounded exception (#1180, chime idle detection) → inapplicable; no chunk touches idle detection."
  - artifact: project-preferences
    dispositions:
      - "No npm dependencies — for runtime or for tooling, and the ruling that an enforcement mechanism must add no installation step (ADR 0012) → ENGAGED, and it decides Chunk 05's shape before design starts. #625 recommends a CI check; ADR 0012 forecloses reaching for any tool the workflow does not already have. The check is git plus Node stdlib inside the existing `.github/workflows/test.yml` invocation, and #625's option 3 (hash-derived CACHE_NAME) stays foreclosed by the same norm's 'no build step' half."
      - "CommonJS, 'use strict', no build step → conforms; every file this train touches is already CommonJS and stays so."
      - "Tests are `node:test` + `node:assert/strict`, one file per module, and every API endpoint has them → conforms. Chunk 06 touches two endpoints (`listUploads`, `saveUpload`) whose route tests must cover the new failure report, not only the happy path."
  - artifact: nonfunctional-requirements
    dispositions:
      - "If it doesn't work on mobile, it doesn't ship → inapplicable. No chunk in this train adds or changes a user-visible surface; the whole roster is server-side bookkeeping, logging and CI. Recorded rather than assumed because Chunk 06 touches routes the dashboard calls, and 'the API changed but no pixel did' is an interpretation a reviewer may disagree with."
      - "Accessibility floors are requirements, not aspirations → inapplicable, same reason."
last_validated: 2026-09-06
---

## Requirements Confidence

**Level:** High

**Why:** Every car is a filed issue with a diagnosed mechanism, and each diagnosis was
re-verified against this repo's code before the plan was written rather than taken from the
issue text ([[feedback_issue_diagnosis_is_a_hypothesis]]). Four verifications changed the
plan's shape:

- **#692 — the issue's headline is wrong in one respect, and the correction narrows the fix.**
  It states the deletion is silent, "no activity-log entry, no `log.warn` naming what was
  removed". There IS a log line today: `lib/porthub.js#_cleanupOrphanLeases` ends with
  `log.info('Cleaned up orphan port leases', { project, count: released })`. What is missing is
  narrower and worth stating precisely: the line is emitted **per orphan project, not per
  lease**, it names no port, service or host, it is `info` rather than `warn`, and no
  `activity_log` row is written — so the very table that records `port.leased`, `port.released`,
  `port.expired` and `port.takeover` (`lib/store.js:4534/4574/4636/4755`) has no record of the
  one deletion path that runs unattended on every boot.
- **#869 — measured on this install rather than estimated.** `activity_log` holds **5,891 rows
  spanning 2026-03-14 → 2026-09-06** (~176 days, ~33 rows/day). The distribution is what decides
  the policy: `port.leased` alone is 2,147 rows (36%), `session.started` 930, `port.released`
  688; against that, `wrap.auto_pr` — the forensic type the issue names explicitly — is **36 rows
  since 2026-08-07**, and a dozen types have fewer than 30 rows each dating to March. A
  time-based TTL is therefore the wrong instrument: at any age cutoff it deletes the rare
  forensic rows the issue exists to protect while leaving the churn that actually grows the
  table. The issue's "include `sessions`/`eval_*` in the same pass if they share the problem" was
  also checked: `sessions` is 876 rows and referenced by foreign keys from `activity_log` itself,
  `eval_exchanges` and `eval_scores` are **0 rows**, and `medusa_deliveries` is 1,195 — so the
  honest scope is `activity_log` plus a recorded finding on the others, not a blanket sweep.
- **#1108 — the issue's sub-problem 1 is already corrected by its own second comment, and the
  code confirms the comment.** `server.js:157` debounces `fs.watch` per `doc.id` at 500 ms.
  "Add coalescing" is not the fix; the observed 1.3–2.0 s gaps all exceed the window, so each
  burst legitimately becomes its own broadcast. The chunk builds the per-`(doc, participant)`
  shape the comment argues for.
- **#889 — the census is not 54 any more.** Re-derived at `11fbad8` with the issue's own widened
  grep: **58 sites — 11 in `lib/uploads.js`, 47 in `lib/projects.js`** (the file grew 4 sites
  while the issue sat). This is the sizing evidence behind the scope decision below.

The train's theme is one defect class: **a mechanism that runs forever with nothing bounding
what it accumulates, deletes, or says.** Each chunk takes one shape of it — an unbounded table,
an unbounded log line, an unbounded inbox, an unbounded read, and two guards that can only ever
fire in one direction.

**Open assumptions / unknowns:**

- [ASSUMPTION: #869 ships a per-`event_type` row cap trimmed on insert, following the
  `_pruneSessionRuleDeliveries` / `_pruneSessionRuleVersions` precedent already in `lib/store.js`,
  rather than a time-based TTL | MED impact | user can override at Chunk 02]. The measured
  distribution above is the argument: caps bound the churny types and leave every rare forensic
  type intact indefinitely, which is what the issue asks for; a TTL does the opposite. The
  precedent also brings its own test seam and JSDoc-rationale shape, so the chunk reuses a
  reviewed pattern rather than inventing a third one.
- [ASSUMPTION: the first application of that cap does NOT retroactively purge this install's
  existing history in one boot | HIGH impact | user can override at Chunk 02]. A trim-to-cap on
  the next insert would delete ~1,600 real `port.leased` rows from the operator's live database
  the first time the policy runs — and this repo IS the live install
  ([[project_repo_is_the_live_install]]), so the plan's own execution triggers it. Chunk 02 owes
  an explicit decision on convergence, and Chunk 01's norm (a sweep that deletes says what it
  displaced) binds it.
- [ASSUMPTION: #1108's drain half applies to `type:"system"` broadcasts only | MED impact | user
  can correct at Chunk 04]. A peer-blocking message must never auto-drain — the switchboard's own
  rule is that the initiator closes the loop ([[feedback_initiator_closes_loop_with_ack]]), so
  expiring an unanswered peer message would silently break an exchange. A system broadcast has no
  waiting sender by construction, which is the property that makes draining it safe.

**Recorded scope decision (operator, 2026-09-06):**

[DECISION: #889 rides as its `lib/uploads.js` half only; `lib/projects.js`'s 47 sites are re-filed
as their own issue | the re-derived census is 58 sites and the issue itself states the sweep is
larger than Train 13's chunks 01+02a+02b combined, which is more than one Critic pass can review
honestly; `lib/uploads.js` is a self-contained 246-line module whose 11 sites are all
route-reachable and include the `_recordScan` write hazard, so it is a complete boundary rather
than a slice | operator chose this over dropping #889 or splitting it across three chunks]

**What would raise confidence:** N/A at High. The two MED assumptions and the HIGH one are
decisions surfaced at the chunk that acts on them, not unknowns.

## Status

- [ ] Chunk 01: The boot sweep says what it displaced (#692)
- [ ] Chunk 02: The activity log is bounded without losing the rare row (#869)
- [ ] Chunk 03: A durable failure is logged when it changes, not when it repeats (#956)
- [ ] Chunk 04: One broadcast per reader per quiet period, and a drain for what nobody reads (#1108)
- [ ] Chunk 05: The cache-bump guard fires on the next miss, not the last one (#625)
- [ ] Chunk 06: The uploads module reads a project directory the way the scanner does (#889, uploads half)

Context: Plan written 2026-09-06 against the roadmap's blessed Train 14 roster
(`MASTER_ROADMAP.md`, "Train 14: Bounded, Not Infinite" — #869, #889, #692, #956, #625, #1108).
All six verified OPEN at plan time. The order departs from the roadmap's listing order for one
reason recorded here: #692 establishes the norm ("a sweep that deletes names what it displaced")
that #869 then has to obey, because #869 introduces a new deleter over the same table #692 starts
writing to. Building them in the roadmap's order would mean writing the retention sweep first and
retrofitting its audit line second.

### Chunk 01: The boot sweep says what it displaced

- **Description:** `_cleanupOrphanLeases` runs on every boot and bulk-releases every lease whose
  project is neither registered, nor a directory in `projectsDir`, nor an `oc-direct-*`
  connection. It reports one `log.info` per orphan *project* with a count — so if the classifier
  is wrong about a live project (a rename mid-flight, a `projectsDir` misread, an unregistered
  connection), nothing anywhere records which ports were freed, and the next claimant collides
  with a still-running service. Make the sweep observable at the granularity it deletes at: one
  line per lease naming project, service, port and host, and an `activity_log` event mirroring
  the `port.takeover` / `port.released` audit lines this table already carries. The deletion
  behavior itself does not change.
- **Closes:** #692
- **Depends on:** none. First because the norm it lands — a deletion that runs unattended must
  name what it removed — is the constraint Chunk 02's retention sweep is then held to, and
  because it is the smallest slice through the two layers (`lib/porthub.js` and the
  `lib/store.js` activity API) that the next chunk works in.
- **Artifacts consumed:** `observability-strategy.md` (both Direction entries),
  `data-model.md` (what the activity table is for)
- **Deliverables:** `lib/porthub.js#_cleanupOrphanLeases` enumerates a project's leases before
  calling `releaseByProject`, so the audit is of what was actually held rather than of a count
  returned afterwards. Each displaced lease gets a `log.warn` (matching #656's treatment of the
  interactive release path — the sweep is the *automated* instance of the same class, so the same
  level) and a `port.orphan_swept` activity row alongside the existing `port.takeover` /
  `port.released` / `port.expired` emitters in `lib/store.js`. The per-project `log.info` summary
  stays: it answers a different question (how many projects the classifier rejected) and dropping
  it would trade one gap for another.

  **The correction to the issue is carried in the code's own words.** #692 says the deletion is
  silent; it is not, it is under-specified. Whatever comment lands here says what is actually
  missing — port, service, host, and a durable row — so the next reader is not told a falsehood
  the file itself refutes.
- **Tests:** unit — a swept lease produces one audit record per lease, naming port and service,
  and the row is queryable through `activity.query({ eventType: 'port.orphan_swept' })`; a sweep
  that displaces nothing writes nothing; a project holding three leases produces three rows, not
  one (the mutation that proves the granularity changed, since the pre-change code could pass a
  one-row assertion).
- **Acceptance criteria:** after a boot that sweeps at least one orphan, `activity_log` holds a
  `port.orphan_swept` row for every released lease naming its port, service and host, and the log
  carries the same at `warn`. No change in which leases are deleted.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 02: The activity log is bounded without losing the rare row

- **Description:** `activity_log` is append-only with no TTL, no cap and no vacuum — 5,891 rows
  and rising on this install, and Chunk 01 just added a new writer to it. Give it a retention
  policy of the shape this codebase already uses twice (`_pruneSessionRuleVersions`,
  `_pruneSessionRuleDeliveries`): a per-`event_type` cap trimmed on insert, keyed so the rare
  forensic types are never the ones deleted. The chunk also owes an explicit, recorded answer to
  a question the issue does not ask: what the policy does to the history that already exists.
- **Closes:** #869
- **Depends on:** Chunk 01 — its `port.orphan_swept` type must be in the policy from the start
  rather than added as an afterthought, and its norm (a deletion that runs unattended names what
  it removed) is what this chunk's own prune is measured against.
- **Artifacts consumed:** `data-model.md` (Direction: the Master's NULL-`project_id` rows;
  what the table is a summary of), `observability-strategy.md`
- **Deliverables:** a retention policy in `lib/store.js` beside the two precedents, with their
  shape: a named constant carrying the *rationale* in JSDoc, a `_set*Retention` test seam, and a
  prune that runs on insert so no sweeper is needed. Keyed on `event_type` — never on
  `project_id`, which would leave the Project Master's NULL-project rows unbounded, the exact
  case `_pruneSessionRuleDeliveries` documents itself as not covering.

  **The forensic exemption is the design, not a caveat.** `wrap.auto_pr` exists so a stale record
  survives long enough to explain a branch nobody looked at for five days; at 36 rows since
  August it must never be pruned, while `port.leased` at 2,147 is the growth. The policy
  therefore has to distinguish types, and the chunk must state on what basis a type is exempt —
  a mechanical rule a future event type can be classified by, not a hand-written list that the
  next `activity.log` call site silently falls outside of ([[feedback_verify_mechanism_uniformity]]).

  **Convergence decision, owed explicitly.** This repo is the live install, so the first insert
  after this ships prunes the operator's real table. Trim-to-cap deletes ~1,600 `port.leased`
  rows in one statement; the alternatives (a higher initial cap, or a bounded trim per insert
  that converges over days) trade promptness for the operator's ability to see it happen. Chunk
  01's norm binds whichever is chosen: the first prune says what it displaced.

  **Scope, stated because the issue invites widening.** #869 says "include `sessions`/`eval_*`
  growth in the same pass if they share the problem." Measured: `eval_exchanges` and
  `eval_scores` are 0 rows; `sessions` is 876 and is a foreign-key target of `activity_log`,
  `medusa_deliveries` is 1,195 and belongs to the switchboard Chunk 04 touches. None is swept
  here. What this chunk owes them is a written finding, not silence.
- **Tests:** unit — a churny type stops at its cap while a forensic type past that cap is
  untouched; the newest rows are the ones kept; a NULL-`project_id` row is subject to the policy
  (the Master-footprint trap); the seam makes the cap testable without writing thousands of rows.
  The mutation that must go red: remove the exemption and the forensic-type assertion fails.
- **Acceptance criteria:** `activity_log` growth is bounded per event type; every type classified
  as forensic survives an insert volume that would evict a churny one; the first prune on a real
  table is reported, not silent.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The `sessions` / `medusa_deliveries` / `eval_*` finding is written down — on #869 or as its
     own issue — rather than absorbed
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 03: A durable failure is logged when it changes, not when it repeats

- **Description:** `lib/update-checker.js` logs `Update check failed (likely offline)` at `warn`
  on every failed measurement, in both `checkForUpdate` (`:347`) and `checkForUpdateAsync`
  (`:381`). Since #954 raised measurement frequency, an install whose `origin` is unreachable can
  reach ~288 of those a day with a session page open. Log the transition — the first failure and
  the recovery — and keep the per-occurrence line at `debug`.
- **Closes:** #956
- **Depends on:** none.
- **Artifacts consumed:** `observability-strategy.md` (Direction: every logged error says what
  failed, why, and what the operator can do)
- **Deliverables:** transition state in `lib/update-checker.js` covering **both** call sites —
  they are one family and the sync form is `update-applier`'s pre-flight path, so fixing only the
  async one leaves the flood on the path that matters most
  ([[feedback_verify_mechanism_uniformity]]). The existing JSDoc explaining *why* this is `warn`
  and not `debug` (#916: an install that silently stopped detecting releases left no trace an
  operator would find) is not deleted — it is the reason the transition line stays at `warn`, and
  it is the norm this chunk is narrowing.

  [DECISION: log the transition rather than dedupe on a long window | a window is a second
  number to tune and still restates a fact that has not changed; a transition pair says exactly
  what an operator needs — when detection stopped and when it came back — and #916's requirement
  is that the fact be findable, not that it be repeated | user can override]
- **Tests:** unit — N consecutive failures produce one `warn`, not N; a recovery produces a
  `warn` naming the recovery; a second failure after a recovery warns again (the mutation that
  catches a latch that never resets); both call sites are covered by the same assertions.
- **Acceptance criteria:** an unreachable `origin` produces one warn per failure *episode*
  regardless of poll rate, and the recovery is visible in the log.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. `/prawduct:critic` run and blocking findings resolved
  3. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 04: One broadcast per reader per quiet period, and a drain for what nobody reads

- **Description:** Two halves that only matter together. `server.js:157` debounces shared-doc
  broadcasts per document at 500 ms — real, and confirmed in the code — but an agent editing a
  document over minutes produces bursts spaced wider than the window, so every participant
  receives one broadcast per burst. Meanwhile a session on an engine with no `ENGINE_WAKE_PROFILES`
  entry is skipped as `unprofiled-engine` (`lib/medusa-wake.js:931`) forever, so nothing ever
  marks those broadcasts handled and the inbox grows monotonically for the life of the workspace
  id. Coalesce per `(doc, participant)` so a reader gets one "this doc changed" per quiet period,
  and give system broadcasts a drain so an unwakeable session's inbox has a ceiling.
- **Closes:** #1108
- **Depends on:** Chunk 02 in spirit rather than in code — the drain is the same
  bounded-accumulation question one table over (`medusa_deliveries`, 1,195 rows), and the answer
  should not be a third unrelated mechanism.
- **Artifacts consumed:** `switchboard-v2-design.md`, `architecture.md`, `data-model.md`
- **Deliverables:** per-recipient coalescing in the broadcast path, so the cost stops being
  "one editor's cadence × every live session"; and an expiry or non-counting rule for
  `type:"system"` messages that no peer is blocked on.

  **The boundary that must not be crossed, stated up front.** A peer-to-peer switchboard message
  has a sender waiting on it — the initiator closes the loop — so it must never auto-drain. Only
  system broadcasts qualify, and the property that makes them safe (no waiting sender, by
  construction) is what the code should key on, not the message's current shape.

  **Not in this chunk:** profiling codex so those sessions become wakeable. The module refuses to
  guess an engine's idle signature by design, and a real profile needs a live idle/busy capture —
  a separate piece of work with its own verification, filed rather than folded in.
- **Tests:** unit — a document written five times across a quiet period yields one notification
  per participant, not five; two participants each get their own; a system broadcast to an
  unprofiled participant is bounded, while an unanswered peer message to the same participant is
  NOT drained (the assertion that pins the boundary).
- **Acceptance criteria:** `GET /api/medusa/deliveries` no longer shows a participant's `unread`
  count rising without bound from system broadcasts; a peer message still waits for its reader.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The codex-profile residue is filed, not absorbed
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 05: The cache-bump guard fires on the next miss, not the last one

- **Description:** When a precached `public/*` asset changes without a `CACHE_NAME` bump in
  `public/sw.js`, the service worker keeps serving the old file and the change is invisible to an
  operator who is remote on iOS with no hard-reload. It has recurred at #246, #271, #427 and #623.
  The existing guards are monotone floors (`>= 54` in `test/create-project-modal.test.js`, and the
  same shape in `test/bridge-port-input.test.js:168` and `test/master-drawer-frontend.test.js:180`)
  — each pins the bump that shipped with it and none can fail for the *next* miss. The property is
  relational, so it needs the one context that has "changed relative to what": the diff.
- **Closes:** #625
- **Depends on:** none.
- **Artifacts consumed:** `project-preferences.md` (Direction: no npm dependencies; ADR 0012 —
  an enforcement mechanism adds no installation step)
- **Deliverables:** a check in `.github/workflows/test.yml` that diffs against the merge base and
  fails when a file in `sw.js`'s `STATIC_ASSETS` changed while `CACHE_NAME` did not, naming the
  offending assets. Git and Node stdlib only — ADR 0012 forecloses adding a tool, and the same
  norm's no-build-step half forecloses #625's option 3 (deriving `CACHE_NAME` from asset content).

  **The asset list must be read from `sw.js`, not copied into the workflow.** A hand-maintained
  second list is a guard that goes stale exactly when someone adds a precached file — the failure
  this chunk exists to end, one layer up.

  **The network-first set is deliberately NOT in scope, and the distinction is load-bearing.**
  `sw.js`'s own comments record that dual-listed files are network-first *because* they are
  cache-bust-critical, and that a `CACHE_NAME` bump is what surfaces the precached ones. A guard
  that demanded a bump for every `public/*` change would fire on files the bump does not gate,
  and a guard that cries wolf gets bypassed.

  **The three monotone floors:** #625 says the assertion "can then be dropped or kept as
  documentation." Decide it once, in one place, for all three sites — this is a family, and
  leaving two of three is the shape that recurs in this repo ([[feedback_enumerate_the_guards_family]]).
- **Tests:** the guard's own proof is a run against a constructed diff in both directions — a
  change to a precached asset without a bump FAILS, the same change with a bump PASSES. A check
  that has never been shown to go red is not a check ([[feedback_measure_against_the_real_shape]]).
- **Acceptance criteria:** a PR that edits a precached `public/*` asset without bumping
  `CACHE_NAME` fails CI with a message naming the assets; a PR that bumps it passes; a PR that
  touches only a network-first-only file is unaffected.
- **Done when:**
  1. Acceptance criteria met and both directions demonstrated
  2. The three monotone floor assertions are resolved consistently
  3. `/prawduct:critic` run and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

### Chunk 06: The uploads module reads a project directory the way the scanner does

- **Description:** `lib/uploads.js` performs 11 synchronous filesystem operations on paths under
  `<project>/…` — `uploadsDirFor` resolves to `<project>/.tangleclaw/continuity/sessions/<sid>/uploads/`
  or the legacy `<project>/.uploads/`, so every one reads the operator's project directory on the
  event loop. All are route-reachable (`server.js:3738`, `:3820`, `:3844`). A TCC-blocked or
  network-mounted path hangs the single-threaded server, and `fs.promises` plus a deadline is the
  documented trap: the deadline bounds the request, not the syscall, and the abandoned call keeps
  its libuv threadpool thread forever. `lib/dir-scanner.js`'s killable child is the mechanism that
  reclaims it. Two of the sites WRITE — `saveUpload` and `_recordScan`, whose manifest
  `_readScanManifest` parses — so a kill mid-write is a parse failure on a live path, not a lost
  file, and those writes must be staged-and-renamed the way `repairOrphanHooks:1329` already is.
- **Closes:** #889 (uploads half; see the recorded scope decision above)
- **Depends on:** none of this train's chunks; depends on `lib/dir-scanner.js` and the
  boundary-patterns artifact, both of which predate it.
- **Artifacts consumed:** `boundary-patterns.md` (the killable-read and atomic-write patterns),
  `architecture.md` (Direction: degrade, don't crash; a read that could not be established
  reports null and names itself)
- **Deliverables:** the uploads read paths routed through the killable scanner, and the two write
  paths staged-and-renamed. `listUploads`'s early `if (!fs.existsSync(uploadsDir)) return []` is
  the line that must not survive as-is: it reports the same empty list for "nothing was uploaded"
  and "the directory could not be read", and moving the hang without carrying that distinction
  keeps the lie the architecture Direction names. The failure vocabulary is the one already in
  use (`SCAN_TIMEOUT` / `SCAN_ABORTED` and friends), not a new one.

  **Re-file the remainder, with the census attached.** `lib/projects.js`'s 47 sites are the rest
  of #889 and become their own issue, carrying the re-derived numbers, the route-reachability
  table, and the two questions the census flags as needing a different answer: `createProject`
  and `deleteProject` CREATE and DESTROY directories rather than reading them (a child SIGKILLed
  mid-`rmSync` leaves a half-deleted project), and `detectExistingProjects` is proven
  unreferenced outside tests — route it or delete it, with the proof attached
  ([[feedback_prove_absence_before_deleting]]).
- **Tests:** unit — a read of an unreadable uploads directory reports a named failure rather than
  an empty list, and the route surfaces it; a kill mid-`_recordScan` leaves the previous manifest
  parseable rather than truncated; `saveUpload` is atomic. The mutation that must go red: make
  the unreadable case return `[]` again and the naming assertion fails.
- **Acceptance criteria:** a re-run of the issue's census over `lib/uploads.js` returns zero
  route-reachable synchronous reads of an operator-chosen path; the two writers are atomic;
  suite green; the remainder is filed with its census.
- **Done when:**
  1. Acceptance criteria met and tests pass
  2. The `lib/projects.js` issue is filed with the census verbatim
  3. `/prawduct:critic` run (final/cumulative for the train) and blocking findings resolved
  4. Committed, PR merged, chunk marked `[x]` in Status

## Verification Strategy

Tests are the floor, and for this train they are unusually close to sufficient: five of six chunks
change bookkeeping, logging and CI rather than a surface a person looks at. Where they are not
sufficient:

- **Chunk 02 runs against real data on this machine.** This clone is the live install, so the
  first prune acts on the operator's actual 5,891-row table. Before merging, the row counts per
  event type are captured, and after the first prune they are compared — the check is that the
  types the policy exempts are unchanged, not merely that the total went down.
- **Chunk 05's guard is verified by making it fail.** A green CI run proves nothing about a check
  that has never gone red; both directions are demonstrated on a scratch branch before the chunk
  closes.
- **Chunk 06 needs the live no-FDA check** the #884 family established — a read of a directory
  the process genuinely cannot open, not a fixture that merely does not exist.

No chunk declares `Visual change: yes`; if one turns out to alter something an operator sees
(Chunk 06's routes reach the dashboard), it gains the declaration and the queue entry at that
point rather than at plan time.

## Governance Checkpoints

- **After Chunk 02** — the retention policy is this train's only persisted-behavior change and
  the only one that deletes the operator's data. Review the trajectory here, not just the chunk:
  does the policy's exemption rule generalize to event types nobody has written yet?
- **After Chunk 06** — the train's cumulative review, and the point at which the #889 remainder,
  the codex-profile residue, and the `sessions`/`medusa_deliveries` finding are all confirmed
  filed rather than absorbed.
