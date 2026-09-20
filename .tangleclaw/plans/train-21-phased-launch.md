---
title: Train 21 — Engine-Agnostic Phased Launch (blueprint + chunking)
status: APPROVED rev 4 (Architect schema gate satisfied 2026-09-17, v40 + v41, blueprint level). Operator rulings 2026-09-17: R1 RATIFIED; R3 = operator mode.
authorized_by: TangleClaw-ProjectManager, 2026-09-17 (planning only)
source: /Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/TRAIN_21_MICROPLAN.md
review: /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-builder-schema-review.md
# No `branch:` claim, deliberately. This plan spans a whole Train — twelve cars across many
# branches — so claiming one would orphan every other car's branch and make the lint grade the
# wrong plan with confidence instead of saying it could not tell. It resolves through the
# `active_build_plan` pointer, and the record lint correctly reports that as `unchecked` rather
# than as a pass. A per-CAR plan would be the thing to give a `branch:`, if this repo ever splits
# them out.
governed_by:
  - .prawduct/artifacts/prime-delivery-direction.md   # ratified 2026-08-31
  - .prawduct/artifacts/wrap-direction.md             # ratified 2026-07-21
  - .prawduct/artifacts/security-model.md
  - .tangleclaw/plans/master-startup-and-wrap.md      # Master startup — excluded here, see §2.9
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
scope: train-21-phased-launch
partition: serial — every chunk edits lib/sessions.js, lib/store.js and server.js; the chunks that touch public/ run in a worktree
---

# Train 21 — Engine-Agnostic Phased Launch

**Requirements Confidence: Medium.** The mechanism is specified. Two policy rulings belong to the
operator (R1 amendment, R3 default), and the tool-output capacity per engine is unmeasured (Chunk 01
spike). The design is written so that neither ruling changes a schema: both are values of project
settings.

## Revision log
- **rev 1** (2026-09-17 17:09) — first blueprint.
- **rev 2** (2026-09-17) — answers Architect review rev 1:
  - B1 ack binding and idempotency; B2 frozen snapshots; B3 two-phase handoff publication;
    B4 honest evidence and full governance pull; B5 route-level operator guard;
    B6 launch-id handshake; B7 canonical root and retention.
  - R3 default flipped to `operator` pending a ruling.
  - The R1 amendment is now recorded before its default changes.
- **rev 3** (2026-09-17) — answers the Architect's rev 2 recheck:
  - The launch-id handshake and the unverified open-install clear were **accepted**.
  - C1: consistent advisory and operator recovery transitions (§2.3).
  - C2: per-attempt publication identity, and repairs that are proposed then validated (§2.6).
  - C3: preflight is exhaustive and integrity-first, with a clean-baseline legacy check and a
    `workspace-unavailable` verdict (§2.7).
  - §2.8 branches are ordered by gate state.
  - Non-blocking fixes: ack rule order and step-1 carry-over; frozen pagination; the
    orphaned-launch path; older panes; the retention estimate.
- **rev 4** (2026-09-17) — answers the Architect's rev 3 recheck. v40 is accepted at blueprint
  level, and C1 is closed.
  - C2: a publication's eligibility is bound to lifecycle completion in the **same transaction**
    as `store.sessions.wrap`, and repair requires that binding (§2.6).
  - C3: `ok` is a positive predicate; there are explicit `legacy-unclean`, `handoff-behind` and
    `unclassified` recovery verdicts (§2.7).
  - Run-id answer adopted: every run, a resume included, is a new attempt.
  - **APPROVED** by the Architect 2026-09-17 (SHA `f887cbe5…`). The approval's non-blocking wording
    fixes to the acceptance cases were applied afterwards (checkpoint repair vs an unbound
    checkpoint; the kept-checkpoint `ok`; the eligible-but-superseded disposition).
    Review: /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-builder-schema-review.md

---

## 0. Policy rulings

| # | Question | Architect | Status | Effect until ruled |
|---|---|---|---|---|
| R1 | Paste-only engines (codex, aider, antigravity) get project rules by acknowledged pull instead of paste — an amendment to prime-delivery §3 | YES to the hybrid direction; the amendment needs the operator | **RATIFIED by the operator 2026-09-17** | The amendment text is written into `prime-delivery-direction.md` §3 in #1584's PR, which is also where the default flips to `pull`. Until then `paste` remains. |
| R2 | The sequence is locked, never the pane | YES | **Settled** | — |
| R3 | Recovery default: `operator` (withhold step 4 until the operator clears it) vs `advisory` (the agent reconciles in writing) | NO to `advisory` as the default | **RULED by the operator 2026-09-17: operator mode** — "for now, until it's proven there are no issues" | Default `operator`. `advisory` stays a project opt-in value. Revisit only on the operator's call, with evidence from real operator-mode use |

R1 — **ratified 2026-09-17.** The amendment is still recorded before its default changes, not in
the last docs chunk. Car 21.6 (#1584) adds the dated amendment note to
`prime-delivery-direction.md` §3, citing this ratification, in the **same PR** that flips
`pasteRules` to `pull`. Until that PR merges, §3 reads as originally ratified and the setting stays
`paste`.

R3 — **ruled 2026-09-17: operator mode is the default** until it has been shown to cause no
problems. The `wrap-direction` commitment-3 argument for `advisory` is noted and deferred.
`advisory` remains a project opt-in value, and it is built and tested in #1587 so that a later
switch is a setting change, not new work.

**Delegated clearing** ("a delegate named in project rules") is **out of scope**. It needs an
authenticated non-operator identity path, which does not exist (#1025). A follow-up is filed.

---

## 1. What exists today (verified 2026-09-17 at `39d38348`)

| Concern | Where | Train 21 relevance |
|---|---|---|
| Prime assembly | `lib/sessions.js#generatePrimePrompt`, yieldable tiers `_yieldable` | Split into step renderers; one source for push and pull |
| Launch | `launchSession`: stranded launchGate → rules → prime → shards → config → hooks → **ambientEnv (:465) → tmux (:477) → `store.sessions.start` (:506, allocates the id)** → ledger → `_deferEngineInit` | The session id does not exist when the env is built → B6 handshake |
| Session lifecycle | `SESSION_STATUS_TRANSITIONS` (`store.js` ~:3063): active → wrapped/killed/crashed | Not extended by this train |
| Rules hook + receipt | `sessionstart-rules-claude.sh` posts for **shard 1 only**; `server.js` ~:4182 says a receipt proves *a* hook ran in the directory, **not which session's** | Hook evidence is not session-bound → B4 |
| Delivery ledger | `session_rule_deliveries`, closed channel/outcome vocabularies, logical refs (no FK); `markDelivered` upgrades only a fresh `written` row | **Untouched** by this train; pull evidence gets its own table |
| `activity_log` | Pruned per type (`_pruneActivityLog`) | Timeline only, never the source of an invariant |
| Wrap | 17 steps; `continuity-write` then `apply-pr-resolutions` (last); `_runClaimedWrap` transitions the lifecycle **after** the pipeline (`_completePipelineWrap`, which can lose to Kill); `keepSessionRunning` keeps the session | Two-phase handoff → B3 |
| Wrap run registry | `lib/wrap-run-registry.js`, process-local | Not durable evidence |
| Config root | `lib/wrap-steps/_config-root.js#configRootOf`; continuity writes there | Canonical handoff root → B7 |
| Auth | `auth-gate.js` admits machine clients (`tc`) at the common gate; `req.tcSession` is the verified browser session; `_accountSession` (`server.js` ~:2646) is the route-level refusal pattern (open → 409, fallback → refusal, else 401) | recovery-clear guard → B5 |
| `tc` | `lib/tc-verbs.js#VERB_ROSTER`; identity headers from the pane env; no token | New `start` verb |
| Store | SQLite, `CURRENT_SCHEMA_VERSION = 39` | v40 (Chunk 01), v41 (Chunk 03); re-confirm when building |
| Engines | only claude has `supportsSilentPrime`/`startupInjection`; openclaw declares SSH/webui modes | openclaw exclusion reason → §2.9 |

---

## 2. Blueprint

### 2.1 Identity: the launch-id handshake (B6)

`TANGLECLAW_SESSION_ID` cannot be put in `ambientEnv`: the id is allocated after tmux starts, and a
running process never sees a later tmux env change. The alternative, moving the INSERT before tmux,
would create `active` rows for launches that then fail. Marking those `crashed` would mislabel
them, and a new terminal status would touch every lifecycle consumer.

`[DECISION: bind identity with a launch-id handshake instead of preallocating the session row | a
row that exists before its process mislabels failed launches, and the transition map should not
grow for this train | ACCEPTED by the Architect 2026-09-17 (rev 2 recheck)]`

**Launch id** (`launch_id`: 128-bit random, base64url):
- **Generated** in `launchSession` before `ambientEnv` is built, and exported as
  `TANGLECLAW_LAUNCH_ID`.
- **Bound** by the same transaction that runs `store.sessions.start`. The `launch_sequences` row is
  inserted with `(launch_id, session_id)`, so the binding exists only if the session row does.
- **Before binding** (the engine called `tc` very early), the server answers
  `409 {code:'LAUNCH_NOT_BOUND', retryAfterMs:500}`. `tc` retries for up to 10 s, then exits 2
  with `LAUNCH_UNKNOWN`.
- **If tmux fails to start**, no process exists and no row is written, so there is nothing to
  clean up. `tc` is never reached.
- **If tmux starts but the bind transaction fails** (the process exists, the row does not):
  - `launchSession` catches the failure and calls `tmux.killSession(tmuxName)`.
  - It logs `launch.bind_failed` and returns `{error}` to the launcher.
  - If the kill also fails, the error names the orphan
    (`ORPHANED_LAUNCH: tmux session "<name>" is running with no session record`) so the dashboard
    can surface it.
  - An orphan that survives calls `tc` and gets `LAUNCH_UNKNOWN` after its retries: it is visible
    in its own pane and never receives a sequence.
  - Today a `store.sessions.start` throw after tmux has started is already unhandled. That gap is
    fixed here rather than inherited.
- **After binding**, the server checks that the bound session belongs to the
  `x-tangleclaw-project-id` it was sent with and is `active`. Otherwise it answers `409
  SEQUENCE_SESSION_MISMATCH` or `SESSION_ENDED`.
- **Older panes** (launched before Train 21, so no `TANGLECLAW_LAUNCH_ID`):
  - Read-only discovery (`tc whoami`, `tc capabilities`, `tc start status`) keeps working and
    reports `sequence: none (pane predates phased launch)`.
  - Mutating calls (`next`, `ready`) refuse with `409 LAUNCH_ID_REQUIRED`.

The server never infers "the latest active session". `tc whoami` reports the resolved `sessionId`.
The launch id is **attribution, not authentication**: it has bounded retries and exact
project/session validation (see §2.8).

### 2.2 The sequence and its frozen snapshot (B1, B2)

Tables (migration v40, Chunk 01). Session and project ids are **logical references, no FK**, the
same retention rationale as `session_rule_deliveries`:

```sql
CREATE TABLE launch_sequences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,   -- sequenceId
  launch_id       TEXT    NOT NULL UNIQUE,
  session_id      INTEGER NOT NULL,                    -- logical ref
  project_id      INTEGER NOT NULL,                    -- logical ref
  engine_id       TEXT    NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,          -- bumps when the snapshot is re-rendered (§2.2 rule change)
  cursor          INTEGER NOT NULL DEFAULT 0,          -- index of the first un-acked step (4 = all acked)
  page_budget     INTEGER NOT NULL,                    -- frozen at creation (toolOutput.maxChars − measured overhead)
  applicability   TEXT    NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
  not_applicable_reason TEXT,
  preflight       TEXT    NOT NULL,                    -- JSON verdict (§2.5), server-owned
  source_manifest TEXT    NOT NULL,                    -- JSON (below)
  ready_at        TEXT,
  ready_artifact  TEXT,                                -- canonical JSON as accepted
  ready_digest    TEXT,                                -- sha256 of canonical artifact (duplicate detection)
  unready_at      TEXT,                                -- set by the window; NEVER changes cursor or recovery
  nudge_count     INTEGER NOT NULL DEFAULT 0,
  last_nudged_at  TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_launch_sequences_session ON launch_sequences(session_id);

CREATE TABLE launch_sequence_steps (
  sequence_id   INTEGER NOT NULL,
  revision      INTEGER NOT NULL,
  step_index    INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 3),
  step_id       TEXT    NOT NULL CHECK (step_id IN ('identity','governance','state','task')),
  content       TEXT    NOT NULL,          -- the FROZEN rendered bytes; served verbatim
  digest        TEXT    NOT NULL,          -- sha256(content)[:16]
  page_count    INTEGER NOT NULL,
  page_offsets  TEXT    NOT NULL,          -- JSON [start,end) char offsets, frozen
  carried_from_revision INTEGER,           -- step-1 carry-over on byte-equal content only
  pages_served  TEXT    NOT NULL DEFAULT '[]',   -- JSON set of page indexes served
  served_at     TEXT,
  acked_at      TEXT,
  PRIMARY KEY (sequence_id, revision, step_index)
);
```

Recovery columns are **not** in v40. They arrive in v41 with Chunk 03, so Chunk 01 bakes in no R3
default.

**Frozen inputs.** At creation, all four steps are rendered once and stored as `content`. Every
serve returns the stored bytes. A restart or a rule edit cannot change what an advertised digest
covers. `source_manifest` records what the snapshot was built from:

```json
{ "rules":   [{"id": 12, "source": "project|global|shared", "revision": 3, "contentHash": "…"}],
  "globalRulesHash": "…", "engineConfig": {"file": "CLAUDE.md", "hash": "…"},
  "sharedDocs": [{"id": 4, "hash": "…"}], "continuityIndexHash": "…", "handoffDigest": "…|null" }
```

**Rule change before READY.** `POST /start/ready` and each `next` compare the live rules manifest
with `source_manifest.rules`. If they differ:
- The sequence gets `revision + 1`.
- Steps 2–4 are re-rendered under the new revision.
- **Step 1 carry-over** is explicit and evidence-preserving:
  - When the global rules hash and step 1's re-rendered bytes are **unchanged**, a new-revision
    step-1 row is written with the same `content` and `digest`. It records
    `carried_from_revision = <old>` and copies `acked_at`.
  - When either changed, step 1 is re-rendered unacked.
  - Old-revision evidence never acknowledges different content: a carry-over is allowed only on
    byte-equal content.
- The cursor moves back to the first re-rendered step, and the response says
  `{code:'SNAPSHOT_REVISED', reason:'rules changed', revision}`.
- After READY, a rule change does **not** invalidate readiness. Delivering it is the existing
  rules channel's job (and #1176's). The sequence records initialization, not continuous
  compliance.

**Pagination (frozen with the snapshot).**
- **Budget:** `page_budget = toolOutput.maxChars − envelope/footer overhead`. The overhead is
  measured from the rendered footer at creation, not estimated. The budget is stored on the
  sequence row as `page_budget`.
- **Page boundaries:** computed at creation and stored as `launch_sequence_steps.page_offsets`
  (JSON), so a restart or a budget change cannot re-page frozen content.
- **Splitting:** on paragraph boundaries. A single paragraph larger than the budget is hard-split on
  a line boundary, or on a character boundary as a last resort, and each piece is marked
  `(continued)`.
- **Digest:** appears **only on the last page**.
- **Ack:** a step can be acked only when `pages_served` covers every page.
- **Lost page:** `next {page: n}` re-requests it explicitly at any time. `pages_served` records
  **served**, never **received**: receipt is only ever evidenced by the ack.
- **Yielding:** required governance is never `_yieldable`; yield pointers remain for optional
  context only.

### 2.3 The protocol (B1)

**`tc.launch/1` envelope** (`tc` prints `content`, plus a footer line for the ack; `--json` prints
the envelope):

```json
{ "schema": "tc.launch/1",
  "sessionId": 1234, "sequenceId": 88, "revision": 1,
  "step": {"index": 1, "id": "governance", "of": 4},
  "page": {"index": 0, "of": 2},
  "content": "…",
  "ack": null,                                      // present only on the last page:
  // "ack": {"digest": "…", "command": "tc start next --ack governance:1:<digest>"}
  "status": {"cursor": 1, "ready": false, "recovery": "none|required|cleared",
             "recoveryMode": "operator|advisory", "recoveryRevision": 1, "unready": false},
  // Present only on a task step served under ADVISORY recovery; the renderer
  // prints it above the content and `pageOverhead` budgets for it (§4b deltas).
  "recovery": {"verdict": "…", "recoveryRevision": 1},
  "next": "page|step|ready|done|recovery-clear" }
```

**`POST /api/tc/start/next`**, body `{ack?: {step, revision, digest}, page?: n}`:
1. Resolve the sequence from the launch id (§2.1). The whole handler runs in `BEGIN IMMEDIATE`.
2. `ack` present — the rules are evaluated **in this order**, and the first match wins:
   - **(e)** `ack.revision` ≠ the current revision → `409 SNAPSHOT_REVISED` with the current
     revision and cursor. This includes a replayed duplicate from a superseded revision:
     old-revision acks never reach rule (a).
   - **(a)** `(revision, step)` already acked with the same digest → **idempotent**. Return the
     current cursor's envelope without advancing. A lost response is safe to replay.
   - **(b)** Same step, different digest → `409 ACK_DIGEST_MISMATCH`, echoing `step` and
     `cursor`, **never** the digest.
   - **(d)** Step is ahead of the cursor → `409 ACK_OUT_OF_ORDER`.
   - **(f)** Step is the cursor, digest matches, pages missing → `409 PAGES_UNSERVED`, listing
     the page indexes.
   - **(c)** Step is the cursor, digest matches, all pages served → set `acked_at`, cursor + 1,
     return the next step's page 0 (or the recovery gate response, see 4).
3. No `ack` → serve the requested page (default: the next unserved page) of the cursor step.
   Record it in `pages_served`. Serving is idempotent.
4. **Recovery gate on step 4 (v43 — see §2.8).** The gate depends on `recovery_mode` and has **no**
   `unready_at` input:
   - `recovery=required` and `recovery_mode=operator` → step 4 is **withheld**:
     `200 {withheld:true, reason, recoveryRevision}`, and nothing is marked served. Only a
     recovery-clear (§2.8) opens it.
   - `recovery=required` and `recovery_mode=advisory` → step 4 **is served**, carrying a
     `recovery: {verdict, recoveryRevision}` field beside `revised` in the envelope. The renderer
     prints a warning block above the content from it, on **every** page of the step, and
     `pageOverhead` budgets for the widest one — a warning built into the served bytes at serve time
     would be a decoration nothing budgeted for (§4b deltas). The step's frozen content and its
     digest are untouched, so the ack is still the snapshot's. Recovery stays `required` until READY
     (below).
   - `recovery` is `none` or `cleared` → served normally.
5. **Final task ack**: acking step 4 moves the cursor to 4 (`next:"ready"`). It is an ordinary ack
   under rules (a)–(e).

Two concurrent identical acks: the transaction serialises them. One advances; the other hits
(a). No double advance.

**`tc.ready/1` artifact** — `POST /api/tc/start/ready`:

```json
{ "schema": "tc.ready/1",
  "sequenceId": 88, "revision": 1,
  "preflightVerdict": "ok",            // must EQUAL the server's verdict; echoed to prove step 3 was read
  "reconciliation": "…",               // required iff the SERVER's verdict or a snapshot revision requires it
  "proposedFirstAction": "…" }         // a proposal, not an authorization (§2.4 step 4 wording)
```

The server accepts READY only when all of these hold:
- the sequence is live and its session is `active`
- `cursor === 4` at the current revision
- `preflightVerdict` equals the stored verdict
- the recovery condition holds (independent of `unready_at`):
  - `none` or `cleared` → passes
  - `required` + `operator` → `409 RECOVERY_UNCLEARED` (**operator mode cannot use the advisory
    path**)
  - `required` + `advisory` → passes only with a valid `reconciliation`. In the **same
    transaction**, READY is accepted and recovery set to `cleared` with
    `clearance: 'agent-reconciled'`.
- `reconciliation` is non-empty and at least 40 characters (a structural check, not a quality
  judgment) whenever the server requires it: a recovery verdict, a stale verdict, or a snapshot
  revision

This is the whole C1 transition set. Advisory recovery completes as
`serve step 4 with warning → ack → READY(reconciliation) ⇒ ready + cleared`, atomically. Operator
recovery completes only through `clear → serve step 4 → ack → READY`.

The caller never decides whether reconciliation is needed. Other outcomes:

| Case | Response |
|---|---|
| Duplicate, same `ready_digest` | `200` (idempotent) |
| A different artifact after acceptance | `409 READY_CONFLICT` |
| Session ended | `409 SESSION_ENDED` |

READY is **initialization, not task authorization**. Resume consent and operator-confirmation
rules are unchanged.

**`GET /api/tc/start/status`** → the `status` block plus per-step served/acked timestamps.

**Unready window.** Once `created_at + window` passes (default 10 min, a project setting) with no
READY:
- set `unready_at`, show it on the dashboard, and send **one** pane nudge (counted in
  `nudge_count`/`last_nudged_at` on the row, not in `activity_log`)
- change nothing else: neither the cursor, nor recovery, nor the validity of a later READY

### 2.4 Step content (single renderer)

`generatePrimePrompt` is refactored to compose from `renderLaunchStep(step, ctx)`.

**Byte-identity is scoped precisely.** A golden test proves the refactored push prime equals
today's prime byte for byte **before** the bootstrap line is added. The bootstrap line (Chunk 01) is
a declared, separately tested delta.

| Step | Contents |
|---|---|
| 1 identity | banner, Session Ownership, Scope Guard, **global safety rules**, bootstrap ("run `tc start next`"), wrap sentinel |
| 2 governance | **full** project rule text (paginated), the engine's config filename (from `profile.configFormat.filename`), shared-docs list, rule sources, active learnings |
| 3 state | preflight verdict + what it means, handoff summary, per-rule drift diff (§2.6), stranded wraps, CI status, heal report, last-session summary |
| 4 task | continuity "Next action" **worded as a proposed resumption that follows the existing resume/confirmation rules**, active plan pointer (absolute path + share link) |

Bulk reference material (Feature Index, Project Map, Medusa contract, ecosystem primer) stays
pointer-shaped and outside the sequence.

### 2.5 Evidence stays per channel (B4)

- **Step 2 always serves the full rule text on every engine, Claude included.** A census/digest
  pull is dropped: the shard-1-only, not-session-bound hook receipt cannot prove that all shards
  reached *this* session.
  `[DECISION: accept up to ~10k duplicated characters on Claude for honest coverage | push stays the
  §3 target, pull is the per-session proof | revisit only if per-session, per-shard hook evidence
  is built]`
- Three kinds of evidence, three records, **no cross-upgrades**:
  - **hook ran:** `session_rule_deliveries`, unchanged, still `markDelivered`
  - **content served:** `launch_sequence_steps.served_at` / `pages_served`
  - **agent acknowledged:** `acked_at` + `ready_at`
- Nothing in this train writes `session_rule_deliveries`. The dashboard shows the three side by side.
- READY is an attestation. It gains no authentication or authorization meaning without a new
  contract (§2.8).
- **#1176 stays OPEN.** Car 21.5 references it for the unready nudge only. #1176's acceptance
  criterion (tell a missing hook apart from a failed receipt before retrying) is **not** claimed.

### 2.6 Handoff lockfile — per-attempt publication (B3, B7, C2)

**Canonical root**: `configRootOf(project)`, the registered checkout, the same place continuity
writes. Everything lives under `<configRoot>/.tangleclaw/handoff/`, which is gitignored:

| File | What it is |
|---|---|
| `current.json` | the eligible handoff |
| `staged-<publicationId>.json` | a staged attempt |
| `history/<publicationId>.json` | superseded publications, kept for forensics |

There is one `current.json` per registered project. Train 22 members are separate project-backed
entries, and several agents sharing one root is explicitly unsupported until Train 22 defines
ownership.

**Identity: one publication per wrap attempt, never per session.**
- `publicationId` is a random 128-bit value (base64url), generated when an attempt is staged.
- A kept session can therefore publish checkpoint → checkpoint → final, each as its own immutable
  publication.
- **Every wrap run is a new attempt.** `wrapRunRegistry.begin` mints a new run id on every begin
  (`lib/wrap-run-registry.js` ~:179), and a Retry/resume reuses only captured AI content
  (#1404), so it is a new execution and a new publication.
  `UNIQUE(session_id, wrap_run_id)` only makes a replayed stage *within one run* idempotent.
- The same-attempt idempotent operation is **finalize replay for an existing pid**. Staged bytes
  are never reused across runs, even when AI captures were.

**`tc.handoff/1`**. The bytes are **frozen at staging** and are never rewritten. Publication time
lives only in the DB, so the staged digest *is* the published digest:

```json
{ "schema": "tc.handoff/1",
  "publicationId": "…",
  "projectId": 14, "workspaceId": "…|null", "sessionId": 1233, "wrapRunId": "…", "engineId": "claude",
  "kind": "final | checkpoint",                  // fixed at staging from the wrap's keepSessionRunning option
  "stagedAt": "ISO",
  "worktree": {"path": "/abs", "toplevel": "/abs", "gitDir": "/abs", "branch": "…", "headSha": "…", "dirty": false,
               // Present ONLY when the git reading went short (#1648). Absence is the signal that
               // it was whole, so a consumer can tell "this tree has no commits" from "git could
               // not be read" — which a bare null cannot say, and frozen bytes can never revisit.
               "unestablished": ["headSha"], "readFailure": "read-timed-out"},  // null for non-git
  // WHY `worktree` is null, when the reason is that nobody could look (#1649). `wrap-scope`
  // reports an unreadable work tree and a genuine non-repo identically — `workToplevel` is null
  // in both — and a bare null here is read as "no git", which skips checks 13/14 and satisfies a
  // precondition of `ok`. Mutually exclusive with a `worktree` object; absent on every pre-#1649
  // document, where absence keeps meaning "not a git repository".
  "worktreeProblem": "git could not be run in /abs: timed out | null",
  "rules": [{"id": 12, "source": "project", "revision": 3, "contentHash": "…"}],
  // Car 21.10 widened this block: `rules` rows also carry `label` and `measured`,
  // and a top-level `manifestSources` names what was read. §4c is the authority on
  // that shape and on why an unmeasured row is not an empty one — deliberately NOT
  // restated here, because two copies of one schema is how this list fell behind
  // the code in the first place.
  "globalRulesHash": "…", "engineConfigHash": "…", "continuityIndexHash": "…",
  "wrapOutcome": "complete | degraded",
  "missingEvidence": ["learnings-capture: failed", "…"],   // every non-ok step, named; empty iff complete
  "nextAction": "…|null", "planRef": "/abs|null" }
```

**Durable eligibility (v41)** — never the process-local run registry:

```sql
CREATE TABLE handoff_publications (
  publication_id  TEXT    PRIMARY KEY,
  seq             INTEGER NOT NULL UNIQUE,     -- monotonic per install; orders attempts
  project_id      INTEGER NOT NULL,            -- logical ref
  session_id      INTEGER NOT NULL,            -- logical ref (the producing session)
  wrap_run_id     TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('final','checkpoint')),
  state           TEXT    NOT NULL CHECK (state IN ('staged','published','superseded','abandoned')),
  file_digest     TEXT    NOT NULL,            -- sha256 of the staged (= published) bytes
  eligible_at     TEXT,                        -- set ONLY by the eligibility binding (below); NULL = this attempt did not complete
  eligible_via    TEXT CHECK (eligible_via IN ('lifecycle-wrap','checkpoint-complete')),
  staged_at TEXT NOT NULL, published_at TEXT, superseded_at TEXT, superseded_by TEXT,
  abandoned_at TEXT, abandoned_reason TEXT,
  UNIQUE (session_id, wrap_run_id)
);
CREATE INDEX idx_handoff_pub_project ON handoff_publications(project_id, seq);
-- at most one final attempt per session can ever be eligible: the one that completed the lifecycle
CREATE UNIQUE INDEX idx_handoff_pub_final_eligible
  ON handoff_publications(session_id) WHERE kind = 'final' AND eligible_at IS NOT NULL;
```

**Transitions.** Each one names an exact `publicationId`, so a late completion can only touch its
own attempt:

1. **Stage** — the new wrap step `handoff-stage`, placed **last** (after `apply-pr-resolutions`).
   - It writes `staged-<pid>.json` (tmp + rename) and inserts a `staged` row, then returns
     `publicationId` in its step result.
   - On a replay of the same `(session, run)` it returns the existing id and writes nothing.
   - It is a non-blocker: a failure is recorded in the wrap result, never fatal.
2. **Bind eligibility.** This is the attempt-exact proof of completion (C2).
   - **Final:** `_completePipelineWrap` passes the run's `publicationId` into
     `store.sessions.wrap(id, summary, {publicationId})`. That method runs the lifecycle
     transition and the binding **in one transaction**.
     - The `active → wrapped` UPDATE succeeds, and the row `pid` is `staged` with this session,
       this `wrap_run_id` and `kind = 'final'` → set `eligible_at` and
       `eligible_via = 'lifecycle-wrap'`.
     - If the transition is refused (Kill won), nothing is bound.
     - If the row does not match, the wrap still completes, `publicationBound: false` is returned,
       and the attempt is abandoned (below).
     - When a run's stage failed there is no pid: the session is `wrapped` and **no** publication
       is eligible, which preflight reports (§2.7 check 9 or 12).
   - **Checkpoint:** there is no lifecycle transition. `store.handoffs.markCheckpointComplete(pid,
     runId)` sets `eligible_at` / `checkpoint-complete` in one write when `pipelineResult.ok &&
     keepSessionRunning`. A crash before that write leaves it unbound, which reports `unfinished`.
   - **Nothing else writes `eligible_at`**, and no eligibility is ever inferred from session status.
3. **Finalize** — `publishHandoff(pid, expected)`, called from `_runClaimedWrap` with the
   pipeline's `publicationId` after the binding.
   - **Checks, all inside one `BEGIN IMMEDIATE`:**
     - the row is `staged`
     - the file digest equals `file_digest`
     - the file's `publicationId` and `kind` equal the row's
     - `eligible_at IS NOT NULL` for **this** pid (step 2), never session status
     - no publication with a greater `seq` is `published` for this project
   - **Then, in this order:**
     1. move the old `current.json` to `history/<oldPid>.json`
     2. rename staged → `current.json`
     3. set the old row to `superseded` (`superseded_by = pid`) and this row to `published`
   - A replay for a row already `published` with the same pid is a no-op success, which covers a
     lost finalize response.
4. **Abandon** — `abandonHandoff(pid, reason)`, only from a `staged` row whose `eligible_at` is
   NULL:
   - `_completePipelineWrap` returned false (lost to Kill), the pipeline failed, or an eligibility
     check failed
   - a newer publication was already published: `reason: superseded-before-publish`
   - The file stays for forensics.
   - **An eligible attempt that loses to a newer published one** (step 3's
     higher-`seq` check) is **not** abandoned. It becomes `superseded`, with `superseded_by` set,
     `published_at` NULL and `eligible_at` preserved. No file is moved, and `current.json` is never
     overwritten by an older attempt.

A crash can split a file operation from its DB update. Reconciliation catches that (below); an
atomic rename alone is never trusted to prove the DB update happened.

**Reconciliation.**
- **Detection is pure.** `runPreflight` returns `repairs: [...]` as *proposals* and writes nothing.
- **Application is separate.** `applyHandoffRepairs(proposals)` is a controller operation. It
  re-checks every condition inside its own transaction, applies the repair or refuses it, and
  preflight then re-runs once.

| Observed | Repair proposed only if **all** hold | Otherwise |
|---|---|---|
| `current.json` names pid X; row X is `staged` (crashed after rename, before DB) | file digest = row digest; file pid/kind = row; **row X `eligible_at` is set** (bound in the lifecycle or checkpoint transaction); no higher-`seq` publication is published | `handoff-unconfirmed` (recovery) |
| row X `staged` with a higher `seq` than the published row; `staged-X.json` present (crashed before rename) | same checks, including **X eligible** → proposal: *publish X* | `unfinished` (recovery) |
| `current.json` names pid X; row X `published`; digest matches | — (consistent) | — |
| `current.json` present; no row / `abandoned` / `superseded` / digest differs | never repaired | `handoff-unconfirmed` (recovery) |
| a staged file whose digest ≠ its row | never repaired (a mismatched file is never published) | `handoff-unconfirmed` (recovery) |

**Session status is never an input to repair.** Take attempt A, which staged a final and failed
before the lifecycle completed, and attempt B, which later wrapped the same session: A's
`eligible_at` is NULL, so A is never repaired or published, whether B's stage failed or B has not
published yet.

A checkpoint is repairable only if `markCheckpointComplete` committed.

### 2.7 Preflight (B3, C3) — `lib/launch-preflight.js`

`runPreflight(ctx) → {verdict, reasons[], repairs[], evidence}`.
- **Pure.** It never writes and never throws to the launcher.
- **Inputs:**
  - the project's session history (id and terminal status)
  - its `handoff_publications` rows
  - the file state of `current.json` (`absent | unreadable | invalid | valid`), plus any staged files
  - the continuity index
  - `handoff_epoch` and its clean-baseline flag (see *Migration boundary*)
  - the live HEAD of the recorded worktree
- **Nothing dereferences a handoff field** unless the file state is `valid`.
- It runs next to the stranded `launchGate`, before rendering.

**The first matching check wins, in this order.** Artifact integrity comes first, so no
compatibility bypass can hide a bad artifact. **`ok` is a positive predicate** (row 15); anything
that matches no row is recovery (row 16).

Definitions used below:
- **current publication** — `current.json` is `valid` and its `publicationId` names a row that is
  `published`, has `eligible_at` set, has a matching digest, and is the highest-`seq` published
  row for the project.
- **newest prior session** — the prior session with the highest id.

| # | Verdict | Condition | Recovery? |
|---|---|---|---|
| 1 | `handoff-corrupt` | `current.json` is `unreadable`/`invalid` (bad JSON, schema-invalid, unknown major), **regardless** of first-launch or legacy status | yes |
| 2 | `identity-mismatch` | file `valid` but `projectId` ≠ the launching project. **`workspaceId` is NOT compared** — amended 2026-09-18, see *Identity* below | yes |
| 3 | `handoff-unexpected` | file `valid` but the project has no sessions and no publication rows | yes |
| 4 | **`first-launch`** (explicit exception) | no prior sessions **and** no publication rows **and** no continuity index **and** file `absent` | no |
| 5 | `crash-recovery` | the newest prior session is `crashed`/`killed` | yes |
| 6 | `unfinished` | a staged/abandoned publication with a higher `seq` than the newest published one (after any validated repair); **or** the newest published row is a `checkpoint` whose session later ended `wrapped` without an eligible final | yes |
| 7 | **`legacy`** (explicit exception) | no publication rows ever **and** at least one prior session **and** every prior session id ≤ `handoff_epoch` **and** `baseline = 'clean'` **and** file `absent` | no |
| 8 | `legacy-unclean` | same as 7, except `baseline` is `unclean`. Example: newest pre-epoch session `wrapped` but the continuity index missing | yes |
| 9 | `handoff-never-published` | file `absent`, no publication rows, and at least one prior session id > `handoff_epoch` | yes |
| 10 | `handoff-missing` | file `absent` but a `published` row exists | yes |
| 11 | `handoff-unconfirmed` | the file-vs-row cases in the reconciliation table, including a file whose row is not eligible | yes |
| 12 | `handoff-behind` | a current publication exists, but the newest prior session id > its producing `sessionId`: a later session ended `wrapped` without an eligible publication (a crash is already 5) | yes |
| 13 | `workspace-unavailable` | current publication with non-null `worktree` whose `toplevel` no longer exists | **reconciliation required**; recovery **yes** if `worktree.dirty` was true, else no |
| 14 | `stale` | current publication, and `worktree.headSha` ≠ the live HEAD of `worktree.toplevel` (or the branch moved) | no; reconciliation required |
| 15 | **`ok`** (positive) | all of: a **current publication** exists; its identity matches (`projectId` only — see *Identity*); its `sessionId` **is** the newest prior session; that session is `wrapped` (final) or still-kept `active` (checkpoint); `worktree` is null **with no `worktreeProblem`** (no-git, recorded) or its HEAD and branch match | no |
| 16 | `unclassified` | nothing above matched. Example: a continuity index with no session history and no publications (`baseline = 'empty'`). `reasons[]` lists every predicate that failed | yes |

**Identity — amended 2026-09-18 (Architect ruling). Rev 4's rows 2 and 15 said
`projectId`/`workspaceId`; this supersedes the workspace half only, and rev 4's
approval history above stands as history.**

Row 2 compares the handoff's `projectId` with the launching project's numeric id,
in the same TangleClaw store. The handoff's `workspaceId` describes the PRODUCING
session's Medusa identity and is **not** compared with the next session's. Rev 4
conflated session routing identity with project identity: `medusa.mintWorkspaceId`
draws fresh random bytes on every launch, so the launching id differs from the
recorded one in the normal case. Wired to that fresh id, the check **would**
return `identity-mismatch` — a recovery verdict — for any Medusa project that had
written a handoff. It never did so on a deployed launch: 21.8's caller passes
`null`, which is what prevented it.

A changed, absent or null Medusa identity is **never on its own** a recovery
condition. The field stays in the frozen document and stays covered by the digest:
diagnostic does not mean editable after publication.

**Project identity alone does not authorize acceptance.** Every other acceptance
check stands unchanged — artifact validation, project-scoped publication lookup,
attempt-exact eligibility (ADR 0002, binding), digest matching, publication
ordering, producing-session state, and worktree reconciliation. `projectId`
equality never means `ok` by itself. This contract is within ONE store; it does
not define trust for importing handoffs between installations.

21.8 shipped `workspaceId: null` at the launch caller, which avoids the false
mismatch but leaves the wrong contract available to a future caller. **#1611 stays
open** for a focused follow-up: remove the launching-workspace equality predicate
from the pure evaluator, remove or explicitly deprecate the context/API option,
and update comments and tests so a stale optional argument cannot restore it. No
document-schema migration, and no removal of historical workspace values.

**Row 16 — amended 2026-09-18 (same ruling).** Rev 4's second example, "an
`active` newest session with no checkpoint", is removed: it does not specify
enough state to determine a verdict. With an absent handoff file and no
publication rows, a prior session AFTER the epoch reaches row 9
(`handoff-never-published`) and an all-pre-epoch history with an unclean baseline
reaches row 8 (`legacy-unclean`), each unless an earlier check wins. The
continuity-index example remains reachable and is the row's fixture. **The check
order is not changed to make the old example true**, and no active-session
exception is added.

Ruling: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-handoff-identity-ruling.md`
(hosted: https://cursatory.tail123678.ts.net:8443/plans/81/train-21-handoff-identity-ruling.md).
Carry it into ADR 0017 (21.12) with the v42 migration decision; the Architect
reviews that draft before it merges.

**Pivot for 5, 6 and 12.** A crash, or a publication-less wrap, is recovered only when a *later*
session produces an eligible, published final. The newest prior session is then that session.

**Workspace unavailable (13).** The registered root's HEAD is reported as **diagnosis only**
(`evidence.fallbackRootHead`). It never turns the verdict into `ok`.

**Non-git project.** `worktree: null` **and no `worktreeProblem`**, so 13–14 are recorded as
`skipped: no-git`, and 15 accepts them only with that recorded skip.

**A probe that failed (#1649).** `worktree: null` WITH a `worktreeProblem`. `wrap-scope` reports an
unreadable work tree and a genuine non-repo identically, so the bare null above was written for
both and the reassuring reading won. The reason now rides beside the null, and this case sets
`worktreeHeadUnverified` rather than answering on its own — so 15 collects it with its other failed
preconditions and 16 owes recovery. It cannot owe LESS than a reading that merely went short,
which already lands there: git never answering is strictly weaker evidence than git answering
incompletely. Absent on every pre-#1649 document, where absence keeps meaning no-git.

**Migration boundary — amended 2026-09-17 (Architect ruling); rev-4's approval history is preserved
above, this supersedes only the version number and the already-v41 case.**

`project_handoff_epoch` ships in **v42**, not v41. v41 shipped with car 21.7 (#1585, merged
`70c78c60`) carrying `handoff_publications` only, and its gate runs only for `currentVersion < 41` —
so initialization added inside it would never run on a store that already took v41. v41 and its
postconditions stay exactly as shipped; v42 adds its own. A chunk does not owe one schema version
when its cars ship separately, and #1587 must likewise take the next unshipped number.

**A new version fixes reachability, not the missing boundary.** The epoch is
`MAX(sessions.id) AT THE MOMENT handoffs began`. Taking today's maximum on a store that has already
been at v41 for a while does not recover that instant — it draws the line too late and sweeps
post-epoch sessions into the legacy window, turning what should be `handoff-never-published`
(recovery) into `legacy` (no recovery). So the cutoff is recorded per case:

| Store/project case | Result |
|---|---|
| Enters this startup **below v41** | Snapshot the project's max session id in the controlled v42 upgrade, before sessions are admitted, and classify `clean`/`unclean`/`empty` per the values below. This startup crosses into publication support, so the boundary is real. |
| Enters **already at v41** with history and no trustworthy epoch | Record today's cutoff once, but `baseline = 'unclean'` with a reason such as `epoch-boundary-unknown-from-v41`. It is a v42 **observation**, never a recovered v41 boundary, and it must never enable the clean-legacy exception. |
| A valid epoch already present (partial or retried upgrade) | Preserve cutoff, baseline and `recorded_at` exactly. Never recompute from newer sessions. An invalid or conflicting row fails validation rather than being silently replaced. |
| No session history | `epoch_session_id = 0`, `baseline = 'empty'`. |
| Project created after the migration | Its empty epoch is created with the project, before its first session. |
| Store claims v42+ but the epoch evidence is missing | An integrity / unknown-boundary outcome. **Never** a late `MAX(id)` backfill that grants legacy acceptance. |

**Honest uncertainty beats an unearned pass.** A genuinely old project on an already-v41 store may
land in recovery because its exact boundary was never recorded. That is the intended outcome, and the
reason is recorded so the operator is told the boundary is unknown rather than that a failure was
proven. Never infer the cutoff from `schema_version.applied_at`, session timestamps, deployment
timing, or the absence of publication rows.

**The unclean compatibility baseline is not a veto.** A valid current eligible publication still
satisfies the positive `ok` predicate (row 15) — the unclean baseline only withholds the unproved
clean-legacy bypass, and never resets good publication state. Where there are no publications, an
unknown baseline must reach recovery (`legacy-unclean` with its reason, or the catch-all), never
`legacy` and never `ok`. Integrity-first ordering is unchanged. Clearing recovery is bound to a
launch and revision; it never rewrites the historical baseline, and a later successful publication is
the normal forward path — not an edit to the past.

**Atomicity.** Epoch rows are initialized, validated and the v42 marker advanced in one transaction.
A failed initialization advertises no v42 and admits no session, and must not write a second version
stamp outside the transaction via the shared stamping code. `_createTables()` runs before migrations
and stamps a fresh database at the current version, bypassing the upgrade blocks entirely — so the
fresh-database and project-creation paths need their own coverage, not just the upgrade path. The v42
path also validates the v41 prerequisites it depends on, because an already-v41 store skips the old
gate.

Ruling: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-epoch-migration-ruling.md`
(hosted: https://cursatory.tail123678.ts.net:8443/plans/81/train-21-epoch-migration-ruling.md).
Carry it into ADR 0017 (21.12) so the contract does not live only in a plan and a chat.

The table below is rev 4's, unchanged apart from the version it runs at:

**Migration boundary — rev 4's original text, superseded on the version it names.** It read "when
v41 runs"; the migration is **v42**, per the amendment directly above, and the already-v41 case it
did not anticipate is handled there. The table and the baseline definitions below are unchanged and
still govern. One row per project:

```sql
CREATE TABLE project_handoff_epoch (
  project_id   INTEGER PRIMARY KEY,           -- logical ref
  epoch_session_id INTEGER NOT NULL,          -- MAX(sessions.id) for the project at migration (0 if none)
  baseline     TEXT NOT NULL CHECK (baseline IN ('clean','unclean','empty')),
  baseline_reason TEXT,
  recorded_at  TEXT NOT NULL
);
```

The `baseline` values:
- `clean` — the newest pre-epoch session ended `wrapped` and a continuity index exists.
- `unclean` — the newest pre-epoch session is `crashed`/`killed`/`active`, or the continuity index
  is missing.
- `empty` — no sessions.

Only `clean` satisfies check 7. An `unclean` baseline is recovery: 5 if the newest session
crashed, otherwise 8. An `empty` baseline with continuity present is 16. Nothing reaches `ok`
without a current publication.

Note what that last sentence does and does not mean, since the amendment makes `unclean` far more
common: baseline is read ONLY by checks 7 and 8, both of which require `file absent AND no
publication rows`. A project holding a current eligible publication never reaches a baseline test at
all, so an `unclean` compatibility baseline withholds the clean-legacy bypass without ever standing
between a good publication and `ok`.

Legacy acceptance ends permanently at the first session after the epoch: from then on a lost
handoff is 9 or 10, never 7. On a store whose epoch is a v42 observation rather than a recovered v41
boundary, check 7 is unreachable regardless, because that store's baseline is `unclean` by
construction.

### 2.8 Recovery clear — route-level operator guard (B5)

`POST /api/sessions/:project/launch/recovery-clear`, body
`{sessionId, sequenceId, recoveryRevision}`.

**Branch order.** The branches key on the **gate state** first, never on "is there a session":

1. **Fallback** (`GATE_STATES.FALLBACK`) → refused (`_refuseDuringFallback`).
2. **Armed** (login required):
   - No `req.tcSession` → `401 UNAUTHENTICATED`. This includes machine clients and failed
     authentication, which therefore **never** reach step 3.
   - Otherwise the route asserts the CSRF token itself, then clears with
     `clearance: 'operator-verified'` and `cleared_by = req.tcSession.username`.
3. **Open** (`authGate.isOpen(req.tcGateState)`, login explicitly disabled), only:
   - machine clients → `403 OPERATOR_REQUIRED`
   - the browser path requires same-origin (`Origin` matching the served origin, and
     `Sec-Fetch-Site: same-origin` when present) **and** the dashboard's anti-forgery token for
     open installs. `/api/auth/me` returns `csrfToken: null` when signed out, so whether an
     open-install token exists today is unverified. If none exists, car 21.9 adds one: a per-page
     token issued with the dashboard and checked by this route only
   - the clear is recorded as `clearance: 'open-install-unverified'`, `cleared_by: null`
   - these checks stop cross-site browsers. They do **not** prove a human, and they cannot exclude
     a local process forging headers; the classification says so.
4. **Any other state** → refused (`409 GATE_STATE_UNSUPPORTED`). There is never a fall-through to
   the open branch.

**Binding.** The clear applies only when `(sessionId, sequenceId, recoveryRevision)` matches the
live row and `recovery = 'required'`. Otherwise `409 STALE_RECOVERY`, so a delayed click cannot
clear a newer launch.

**Clearances stay separate.** `open-install-unverified` is never shown or counted as
`operator-verified`, and the dashboard labels it. An open install **never** silently switches to
advisory: `recovery_mode` is whatever the project setting says.

**v43 columns on `launch_sequences`** (rev 4 wrote v41; the cars of chunk 03 shipped separately and
each took the next unshipped number, so 21.7 took v41, 21.8 took v42 and 21.9 took v43):
- `recovery TEXT CHECK (recovery IN ('none','required','cleared'))`
- `recovery_mode TEXT CHECK (recovery_mode IN ('operator','advisory'))` — from the project setting,
  **default `operator`**
- `recovery_revision INTEGER`
- `recovery_cleared_at`
- `recovery_cleared_by`
- `recovery_clearance TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled'))`

**Advisory mode** is the §2.3 atomic READY transition (`agent-reconciled`). This route refuses it
with `409 RECOVERY_MODE_ADVISORY`, so the two paths never cross.

**Local trust for `next`/`status`/`ready`.** Those three stay under the existing loopback
machine-client trust (the same as `/api/tc/rule-receipt`). A local process can forge READY or an
advisory reconciliation; that grants nothing and is stated as the attestation boundary.

### 2.9 Engine matrix

| Engine | Step 1 | Steps 2–4 | Notes |
|---|---|---|---|
| claude | silent prime hook | `tc` pull (full content) | rules hook remains (§3 target) |
| codex / aider / antigravity | paste | `tc` pull | `pasteRules=paste` until R1 is ratified; a live probe per engine confirms `tc` resolves in the pane (#1140 PATH floor) |
| openclaw | — | — | `not-applicable`: no TangleClaw-owned delivery/CLI substrate on the remote side (the profile's SSH/webui modes do not run `tc` under TangleClaw's env) |
| Master pane | unchanged | — | `not-applicable`: governed by `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/.tangleclaw/plans/master-startup-and-wrap.md`; follow-up filed |

Behaviour is chosen from declared capabilities (`supportsSilentPrime`, `startupInjection`, new
`toolOutput.maxChars`, new `launchSequence: supported|unsupported` with a reason). There are no
engine-name branches.

### 2.10 Retention (B7)

- `launch_sequences`, `launch_sequence_steps`, `handoff_publications` and `project_handoff_epoch`
  use logical references and are **kept** when a session or project is deleted, like the delivery
  ledgers.
- Train 21 adds no DB pruning. Growth per launch is `4 · revisions` step rows: every revision
  writes a full set of four, because a carried step 1 is written as a row of its own at the new
  revision (that is what carries its acknowledgement forward). Each row holds up to
  `page_count × page_budget` characters of frozen content, so a launch is typically ~30 KB and
  a rule-churning one is a multiple of that. Measured, not estimated: the count is what
  `store.launchSequences.revise` inserts.
- Growth per wrap attempt is one `handoff_publications` row plus one `history/` file.
- `history/` files are the only thing pruned: the newest 50 per project are kept. The DB row keeps
  the digest, so pruning a file never loses the record that the publication existed.
  `[ASSUMPTION: unbounded retention is acceptable for Train 21 | MED | follow-up issue for a
  retention setting]`
- Every invariant (nudges, clearance, revision, acceptance) lives in these tables. `activity_log`
  events (`launch.*`) are a prunable timeline, and the docs say so.

---

## 3. Governing-norm dispositions

- **prime-delivery §1** (channel per concern, declared limits) — **conforms** (`toolOutput.maxChars`).
- **§2** (cost scales with relevance) — **conforms**.
- **§3** (presence delivered) — **conforms**. The operator ratified R1 on 2026-09-17 and the
  amendment ("An acknowledged pull is delivery") is written into
  `.prawduct/artifacts/prime-delivery-direction.md` §3 in the same work cycle as the default flip
  to `pull` (#1584). The amendment states the three conditions that bound the permission, and the
  code honours all three.
- **§4** (confirmed delivery) — **conforms, strengthened**, with per-channel evidence kept honest
  (§2.5).
- **§5** (visible omission) — **conforms**: required content is paginated, never yielded; withheld
  steps say why.
- **"Nothing may block a launch"** — **conforms** (R2).
- **wrap-direction 3** — **ruling needed** (R3). Until then the operator default follows the
  microplan.
- **Engine-agnostic** — **conforms** (§2.9).
- **security-model** — **conforms**: the operator route has its own guard (§2.8), local attestation
  is stated as bounded, and the launch id is attribution only.
- **New storage surfaces:** 4 tables + the handoff directory (observability: `launch.*` events plus
  the dashboard). **New external surfaces:** 3 `tc` routes + 1 operator route. **New execution
  context:** none.

---

## 4. Chunks and cars (filed 2026-09-17 after schema approval; tracking issue #1591)

Chunks are sequential; each one merges before the next begins.

### Chunk 01 — The sequence exists (v40; additive; no recovery; push unchanged apart from the bootstrap line)
- **21.1** (#1579) v40 tables + `lib/launch-sequence.js` (snapshot creation, ack protocol (a)–(e), transactions, pagination) + launch-id handshake
- **21.2** (#1580) step renderers + golden byte-identity test (pre-bootstrap) + `toolOutput.maxChars` / `launchSequence` capabilities. **Step 0 is a spike:** measure the tool-output truncation of `tc` output on claude/codex/aider/antigravity, and record unknowns as unknown.
- **21.3** (#1581) `tc start next|status` + routes + `START_SUBVERBS` receipt labels + the bootstrap line
- **Acceptance cases:**
  - replaying a lost ack response
  - concurrent duplicate acks
  - an old-revision duplicate → `SNAPSHOT_REVISED`, never idempotent success
  - out-of-order and mismatched acks
  - `PAGES_UNSERVED`; an explicit lost-page re-request
  - an oversize paragraph is split
  - page offsets survive a restart and a budget change
  - `LAUNCH_NOT_BOUND` → bound
  - a tmux failure never reaches `tc`
  - a bind failure after tmux started kills the pane, or reports `ORPHANED_LAUNCH`
  - older panes: `status` works, `next` → `LAUNCH_ID_REQUIRED`
  - a restart serves identical frozen bytes

### Chunk 02 — READY, unready, rule revision
- **21.4** (#1582) `tc start ready` + the tc.ready/1 artifact validated in `lib/launch-sequence.js` (server-owned verdict, duplicate/conflict/ended cases) + the route in `server.js` + the subverb in `lib/tc-verbs.js` + snapshot revision on rule change
- **21.5** (#1583) unready window + single nudge (durable counters) + dashboard readiness/evidence panel (`public/`, worktree). **Refs #1176, does not close it.**
- **21.6** (#1584) `launchSequence.pasteRules: paste|pull`. R1 was ratified 2026-09-17, so this PR writes the dated amendment into `prime-delivery-direction.md` §3 **and** flips the default to `pull`, together.
- **Acceptance cases:** restart under a changed rule set → `SNAPSHOT_REVISED`; step 1 carried over only on byte-equal content; READY with a wrong verdict; duplicate vs conflicting READY; READY after the session ended. Visual change: yes → VRF entry.

### Chunk 03 — Handoff, preflight, recovery (v41)
- **21.7** (#1585) the tc.handoff/1 document (`lib/handoff-publication.js`) + its on-disk store, `current.json`/`staged-*`/history/ (`lib/handoff-lockfile.js`) + the `handoff-stage` wrap step (`lib/wrap-steps/handoff-stage.js`) + `publishHandoff`/`abandonHandoff` (exact-attempt, `lib/handoff-publish.js`) called from `_runClaimedWrap` + the `handoff_publications` table + an ADR 0002 contract update. `store.sessions.wrap` gains the `{publicationId}` binding (the same transaction as the lifecycle transition). Two tokens here are NOT paths and the record lint reads them as paths anyway: the schema id tc.handoff/1 and the directory name history/. Both are left unbackticked for that reason — the lint keys on backticked tokens containing a slash. What implements them is `lib/handoff-publication.js` and `lib/handoff-lockfile.js` (`historyPath`), both named above.
- **21.8** (#1586) `lib/launch-preflight.js` (pure, ordered verdicts, repair proposals) + `applyHandoffRepairs` (validated controller) + `project_handoff_epoch` with baseline classification
- **21.9** (#1587) recovery columns + the step-4/READY guards + the `recovery-clear` route and its guard + the UI control (worktree)
- **Acceptance cases:**
  - advisory recovery reaches READY only with a reconciliation, atomically `cleared`
  - operator recovery cannot use the advisory path (`RECOVERY_UNCLEARED`); the clear route refuses advisory rows
  - an armed install with failed auth never reaches the open-install branch; fallback is refused; open-install clears are labelled unverified
  - checkpoint → checkpoint → final in one kept session gives three publications, the last one current, the others `superseded`
  - a lost finalize response replays as a no-op
  - a stale finalize for an older attempt never touches `current.json`: unbound → `abandoned`; eligible → `superseded` with its eligibility kept
  - a mismatched staged file is never published or repaired
  - attempt A stages a final and fails before the lifecycle completes; attempt B wraps the same session with (i) its stage failed and (ii) not yet published: A is never repaired or published, and preflight → `handoff-behind`/`unfinished`, never `ok`
  - `store.sessions.wrap` binds exactly one final per session (unique index); a refused transition (Kill won) binds nothing
  - a resumed/Retry wrap is a new attempt with a new pid; replaying finalize for an existing pid is a no-op
  - a crash after rename but before the DB update is repaired only after full validation, for a final **or** an eligible checkpoint (`markCheckpointComplete` committed); an unbound checkpoint reports `unfinished` and is never repaired
  - after the epoch, a crash with no file and no publication → `crash-recovery`; a wrap whose stage failed → `handoff-never-published`
  - legacy-wrapped with continuity → `legacy`; legacy-crashed → `crash-recovery`; legacy-wrapped with continuity missing → `legacy-unclean`
  - continuity only (no sessions, no publications) → `unclassified`
  - `ok` only with a current eligible publication from the newest session; a table-driven test asserts every other combination of the input space lands on a recovery or advisory verdict
  - a corrupt file under first-launch or legacy conditions → `handoff-corrupt`; a valid file with no history → `handoff-unexpected`
  - a removed worktree → `workspace-unavailable` (recovery iff it was dirty), never `ok`
  - READY while recovery is uncleared
  - an unready timer does not unlock step 4
  - a late clear for another sequence or revision → `STALE_RECOVERY`
  - a machine client clearing → 403
  - the open-install clear is recorded as unverified
  - legacy vs lost handoff after the epoch
  - the four publication crash windows
  - Kill during wrap → `abandoned`
  - a verified kept checkpoint (eligible, published, from the newest session, which is still `active`) satisfies `ok`, consistent with row 15. The existing single-active-session launch guard still refuses a duplicate worker, and a test proves the preflight verdict never bypasses it. An unbound or unpublished checkpoint → `unfinished`
  - the implementation's eligibility guards check the kept session and the exact run/session (Kill races included), not only the schema
  - worktree wrap → handoff found at the registered root
  - a moved HEAD → `stale` before `ok`
  - deleting a session/project keeps the sequence and publication rows

### Chunk 04 — Reconciliation, parity, the record (`Type: cumulative-final`)
- **21.10** (#1588) per-rule drift diff in step 3 (added/removed/changed from the handoff manifest, including global/shared sources); a revision or drift makes `reconciliation` required
- **21.11** (#1589) engine parity probes (codex, aider, antigravity) + honest `not-applicable` for openclaw and Master + follow-ups (Master phased launch; delegated clearing; retention setting). **CLOSED 2026-09-20 by operator scope amendment: the certification subsystem was cancelled by scope, not blocked, and §4d is superseded — see `## Status`.**
- **21.12** (#1590) docs: ADR 0017 "Phased launch", `api-contract.md`, `engine-guide.md`, `configuration-reference.md`, CHANGELOG. The R1 amendment is **not** here: it lands with 21.6.

Governance checkpoints: after Chunk 01 (does the single renderer and frozen snapshot hold?) and after
Chunk 03 (a whole-trajectory review before parity).

### Launch reliability — what the built sequence got wrong in use (`Type: chunk`)

Not part of the original twelve cars. These are defects the sequence surfaced once real sessions ran
against it, dispatched by the ProjectManager on 2026-09-20 and listed on the shared MASTER_ROADMAP.

- **#1680** the prime's opening order — two directives each claiming the session's first turn, beside
  an unscoped wait-for-confirmation rule, so a session stopped to ask permission to initialize
- **#1673** automate the crash-recovery clear, rather than sending the operator to the dashboard
- **#1685** wrap reports a content prompt delivered that the engine never accepted as a task

**This is a separate chunk from the `cumulative-final` one above, and does not consume it.** Its
three defects are not cars of the Train; the plan's own Chunk 04 is 21.10/21.11/21.12, of which only
21.10 (#1588) has closed. Ticking one for the other would disarm the train's final review while two
cars are still open, so the two are recorded apart and the final review stays where it was.

The roadmap briefly called this "Chunk 04" too, colliding with the plan's. Reported to the
ProjectManager rather than renumbered here — the roadmap is theirs — and **they renamed it to
Chunk 05 on 2026-09-20**, so the collision is resolved at the source. Kept as a note because the
reason the two must not share a tick outlives the numbering that prompted it.

---

## 4a. Chunk 02 implementation decisions

Written before the code, because each one answers a question the blueprint leaves to the build.

- **A revision needs the launch's render context, so the snapshot stores it.** Re-rendering steps
  2–4 at a new revision calls the same collector the launch called, and that collector takes
  launch-time-only inputs (`medusaWorkspaceId`, `continuityMode`, `operatorHost`, `healReport`) which
  no later request can recompute. They are recorded in `source_manifest.renderContext` — the manifest
  already answers "what was this snapshot built from", and the render context is literally that. No
  new column, so v40 is unchanged and v41 stays Chunk 03's.
  A sequence created before this version carries no render context: it is re-rendered from what is
  knowable now, and the revised manifest records `renderContext: null` so the gap is visible in
  `tc start status` rather than silent.
- **`pasteRules=pull` drops the pasted rule text only when a sequence will actually serve it.** The
  setting is read together with this launch's applicability: on an engine that declares no launch
  sequence, or a launch whose prime is disabled, the rules stay pasted. A pointer to a channel the
  session does not have is the #749 failure one engine over.
- **The reconciliation condition stays as approved: ANY revision demands one.** A revision that
  preceded every serve was briefly narrowed out of it during the Critic pass; that narrowed a
  ratified acceptance condition, so it was reverted. What the earlier-revision read decides now is
  the WORDING — a session that was served nothing is told the steps it read are not the ones this
  launch first rendered, rather than that "part of what you acknowledged has been replaced", which
  states a proxy as a fact.
- **A pointer paste records a rules SKIP, and the paste's own outcome is not recorded at all.**
  The ledger's subject is rule delivery, so a prime that carried a pointer records
  `channel: none, outcome: skipped` naming the sequence — never a `delivered` row carrying the rule
  digest, which is what prime-delivery §4 forbids. The consequence is deliberate and is filed as
  #1597: the paste still runs behind its readiness gate and its re-paste guard, but on a pull
  launch nothing durable says what became of it. `projectsWithUndeliveredRules` excludes that one
  documented skip, because whether the rules were read is answered by the launch's own record;
  the skip stays a skip (no cross-upgrades).
- **The §3 amendment is on disk, not in the PR diff.** `.prawduct/artifacts/` is gitignored in this
  repo by deliberate choice (`.gitignore` publishes three migration artifacts and nothing else), so
  the amendment cannot ride in a commit. It is written into
  `.prawduct/artifacts/prime-delivery-direction.md` in the same work cycle as the flip, which is
  what "the same PR" protects — the default never moves ahead of the recorded ratification — and the
  PR body says where to read it.
- **`pasteRules` gets no `ENGINE_CONDITIONAL_SETTINGS` row.** That table exists to explain a
  settings-modal control that is disabled, and this setting has no control: it lives in
  `.tangleclaw/project.json`. A row would add a browser mirror, probes and a parity loop for a
  disposition nobody renders. The honest-absence requirement is met where the setting is
  observable instead — the prime's "Rule sources in force" line names the carrier that actually
  carried the rules, and a launch whose setting asked for `pull` without a sequence logs that it
  pasted them anyway.
- **The unready monitor reuses the wake monitor's idle gate rather than growing a second one.**
  `medusaWake.assessSessionIdle` already decides whether a pane is safe to type into, and
  `lib/sessions.js#_awaitPaneReady` already reuses it, so the nudge injects through
  `sessions.injectCommand` behind the same verdict. A pane that is not typeable is left alone and
  the tick retries; `nudge_count` counts nudges SENT, never ticks.
- **The readiness panel is the settings modal's evidence surface, beside Rule deliveries.** That is
  where the hook-channel ledger already renders, and §2.5's requirement is that the three kinds of
  evidence be readable side by side — which means one panel, not a second place to look.

---

## 4b. Car 21.9 build plan (#1587) — recovery gate, clear route, UI control

**Branch:** `feat/train-21-car-21-9`. **Schema:** v42 → **v43** (v42 shipped with 21.8; a car takes
the next unshipped number, per §2.7 *Migration boundary*). **Critic mode:** `chunk`.
**Type:** feature. **Size:** medium-large — 9 files across store, config, launch, route and UI.

### Confidence check

- **Problem.** 21.8 computes `requiresRecovery` and freezes it into every launch record, and
  nothing reads it. A session whose handoff state is corrupt, behind or unclassified is told so in
  step 3 and then walks straight into step 4 and attests READY, which is the one outcome the
  preflight exists to prevent.
- **Success.** A launch whose preflight demands recovery cannot reach step 4 in `operator` mode
  until an operator clears it through the dashboard; in `advisory` mode it reads step 4 behind a
  warning and can only attest with a written reconciliation, which clears recovery in the same
  transaction. Both clearances are recorded with which one it was, and an open install's clear is
  never counted as operator-verified.
- **Out of scope.** The per-rule drift diff (21.10), engine parity probes (21.11), ADR 0017
  (21.12), and #1611's removal of the launching-workspace predicate. Retention (#1595) is
  untouched.

**Requirements Confidence: High.** §2.3, §2.7 and §2.8 specify the state machine, the branch order
and the column set. The two open points are named as decisions below, not as guesses.

### Steps

- [x] **1. Schema v42→43 — the recovery columns.** `lib/store.js`: the six columns of §2.8 on
  `launch_sequences`, in `_createTables` (fresh database) and in a v42→43 migration block
  (upgrade), with a postcondition check that refuses to advance `schema_version` if the columns or
  their CHECKs are missing — the shape v41→42 established. Existing rows take
  `recovery='none'` / `recovery_mode='operator'` / `recovery_revision=1`: a launch that predates
  the gate was never told to recover, and defaulting it to `required` would strand every live
  pane. `_rowToLaunchSequence` maps all six.
  Tests: `test/launch-recovery-migration.test.js` — the fresh-database shape lives there beside the
  upgrade rather than in `test/store.test.js`, because the two paths are only meaningful compared
  with each other (a fresh store never runs the migration, so its CHECKs have no other reader).
  It covers the upgrade from a v42 fixture, the fresh-vs-upgraded comparison including CHECK text,
  the refusal over a column that lost its constraint, and an idempotent re-run.

- [x] **2. `recoveryMode` project setting.** `lib/project-config.js`: `launchSequence.recoveryMode`
  with `RECOVERY_MODES = ['operator','advisory']` and `resolveRecoveryMode`, **default `operator`**
  (operator ruling R3, §0). An unrecognised value reads as `operator` — the blocking side, because
  this setting decides whether a bad handoff can walk through unattended, so a typo must fall back
  to the side that stops rather than the side that waves through. `lib/projects.js` validates it
  beside `pasteRules`.
  Tests: `test/launch-sequence-settings.test.js`.

- [x] **3. Recovery recorded at launch.** `lib/launch-sequence.js#buildSnapshot` returns
  `recovery: preflight.requiresRecovery ? 'required' : 'none'`, `recoveryMode` from the resolved
  setting, `recoveryRevision: 1`; `lib/sessions.js` resolves the setting and passes it;
  `store.launchSequences.create` writes them. `_statusBlock` reports the row's real `recovery`
  instead of today's hardcoded `'none'`, and the `PENDING_STAGES` note that named this gate as the
  missing piece goes with it.
  Tests: `test/launch-sequence.test.js` (the not-applicable and render-failure records) and
  `test/launch-recovery-gate.test.js` (what a launch in recovery records, and the mode it froze).
  `test/launch-preflight-context.test.js` is untouched: this step consumes the predicate that module
  already answered rather than changing it.

- [x] **4. The step-4 gate (§2.3 rule 4).** `_serve` withholds step 4 — and only step 4 — when
  `recovery === 'required'`:
  - `operator` → `200 {withheld: true, reason, recoveryRevision}` with **nothing marked served**,
    so the ack rules never see a page that was not delivered.
  - `advisory` → served, with a warning block naming the verdict and the reconciliation READY will
    demand **prepended to the served page-0 slice only**. The step's frozen content, its digest and
    its page offsets are untouched: the ack still carries `step.digest`, because the warning is
    framing around the snapshot and not part of it.
  The gate reads `recovery` alone. `unready_at` is not an input, and an expired unready window
  therefore cannot open step 4.
  Tests: `test/launch-sequence.test.js` — withheld in operator mode; served-with-warning in
  advisory; the digest is the frozen one in both; the unready timer does not unlock it; a cleared
  sequence serves normally.

- [x] **5. The READY guard (§2.3).** `_validateReady` / `ready()`:
  - `required` + `operator` → `409 RECOVERY_UNCLEARED`. Operator mode has no advisory path, so a
    reconciliation cannot substitute for the clear.
  - `required` + `advisory` → passes only with a reconciliation of at least
    `MIN_RECONCILIATION_CHARS`; on acceptance, **the same transaction** that writes `ready_at`
    sets `recovery='cleared'`, `recovery_clearance='agent-reconciled'` and
    `recovery_cleared_at`, with `recovery_cleared_by` NULL (no operator was involved and the row
    must not imply one).
  - `_reconciliationRequired` gains the recovery trigger it was written without; the comment that
    says the trigger belongs to #1587 goes with it.
  Tests: `test/launch-ready.test.js`.

- [x] **6. The open-install page token.** §2.8 left open whether one exists; it does not —
  `/api/auth/me` answers `csrfToken: null` when signed out, so an open install has no anti-forgery
  token at all. New `lib/open-install-token.js`: a process-lifetime store of minted tokens with a
  TTL and a cap, issued to the dashboard by `/api/auth/me` **only while the gate is open**, and
  read by the recovery-clear route and nothing else. It proves the caller fetched from this
  server's dashboard in this process's lifetime, which is exactly the cross-site claim §2.8 makes
  and no more: it does not prove a human and cannot exclude a local process, and the clearance
  label says so.
  Tests: new `test/open-install-token.test.js` (mint, expiry, cap eviction, single use vs reuse).

- [x] **7. The `recovery-clear` route (§2.8).** `POST /api/sessions/:project/launch/recovery-clear`,
  body `{sessionId, sequenceId, recoveryRevision}`, branching on **gate state first**:
  1. `fallback` → `_refuseDuringFallback`.
  2. `armed` → no `req.tcSession` is `401 UNAUTHENTICATED` (machine clients and failed auth end
     here and never reach the open branch); otherwise clear as `operator-verified` with
     `cleared_by = req.tcSession.username`. The perimeter CSRF check already covers this write;
     the route asserts the token too rather than inheriting a guard it does not own.
  3. `open` → machine clients `403 OPERATOR_REQUIRED`; the browser path requires same-origin
     (`Origin` matching the served origin, and `Sec-Fetch-Site: same-origin` when sent) **and** the
     page token from step 6; recorded as `open-install-unverified` with `cleared_by: null`.
     The gate stands down in `open`, so identity is **not** resolved by the perimeter — the route
     calls `_gateIdentity` itself to tell a machine client from a browser.
  4. anything else → `409 GATE_STATE_UNSUPPORTED`. There is no fall-through to the open branch.
  `recovery_mode='advisory'` → `409 RECOVERY_MODE_ADVISORY`, so the two clearing paths never cross.
  The clear applies only when `(sessionId, sequenceId, recoveryRevision)` matches the live row and
  `recovery='required'`; otherwise `409 STALE_RECOVERY`.
  Tests: new `test/launch-recovery-clear.test.js` — every branch, the binding, and the
  never-reached-open assertion for a failed armed authentication.

- [x] **8. The UI control.** `GET /api/launch-sequences` returns the recovery fields;
  `public/ui.js` renders each launch's recovery state in the existing Launch-readiness panel and
  offers **Clear recovery** only for `recovery='required'` with `recovery_mode='operator'`; a
  cleared row states which clearance it was, with `open-install-unverified` labelled as unverified
  and never shown as operator-verified. Advisory rows say the session clears its own by
  reconciling, and offer no button.
  Tests: `test/launch-readiness-panel.test.js`. **Visual change: yes** → VRF entry.

- [ ] **9. Record and wrap.** CHANGELOG `[Unreleased]`, the Status boxes below, `/prawduct:critic`,
  handoff notes.

### Decisions this car records

- **`recovery_revision` starts at 1 and increments with the snapshot revision.** §2.8 binds a clear
  to a `recoveryRevision` so a delayed click cannot clear a newer launch, but does not say what
  moves it. A snapshot revision re-renders step 3 — the verdict presentation the operator read
  before deciding to clear — so a revision is exactly the event that makes an outstanding clear
  stale. Incrementing it anywhere else would invalidate clears for changes the operator never saw.
- **An unrecognised `recoveryMode` reads as `operator`, the blocking side.** The mirror of
  `pasteRules`, whose bad value falls back to `paste` because that is *its* delivering side. The
  shared rule is that a bad value falls back to the side that fails safe for that setting's own
  question, not to a fixed one of the two words.
- **The advisory warning block is framing, not content.** Prepending it to the frozen step would
  either change the digest the agent must ack or make the digest stop describing what was served.
  It is prepended to the served slice, and the ack stays the snapshot's.

### Deltas from the blueprint, as built

- **The advisory warning is a sibling envelope field, not a prefix on the page-0 slice.** §2.3 and
  step 4 above described prepending a warning block to the served content. `lib/launch-page.js`
  sizes every page against `pageOverhead()`, the widest decoration a page can carry, and its own
  comment warns that "a reason added without this constant is a reason nothing budgeted for" — a
  prefix built at serve time is exactly that. So the envelope carries
  `recovery: {verdict, recoveryRevision}` beside the existing `revised`, the renderer prints it
  above the content, and `pageOverhead` measures it against the longest verdict in the preflight's
  own vocabulary. Two consequences: the notice rides **every** page of the task step rather than
  page 0 alone (a step read from page 1 onwards would otherwise show no sign of recovery at all),
  and the decoration budget grew from ~300 to 668 characters, which narrows every step's pages by
  that much. Harmless at Claude's measured 20,000 and at the assumed 8,000 default.

- **A binding mismatch can answer 404 as well as `STALE_RECOVERY`.** §2.8 named one code. The route
  resolves the sequence project-scoped first, so a `sequenceId` belonging to another project — or
  to nothing — is `404` before any recovery state is read; `STALE_RECOVERY` is reserved for a launch
  that IS this project's and whose recovery state or revision has moved. Reporting "stale" for a
  launch the caller never had is a different fact stated with the same word.

- **The READY recovery refusal precedes the unacked-steps check.** Written after it first, which
  produced a loop: in `operator` mode the task step is withheld, so the cursor can never reach the
  end, and `STEPS_UNACKED` sent the agent back to acknowledge a step nothing would ever serve it. A
  test caught it. The recovery refusal is the actionable truth and it names who can act.

- **A not-applicable launch records `recovery: 'none'`, whatever its verdict.** It has no steps to
  withhold and can never attest — both `next` and `ready` refuse it with `SEQUENCE_NOT_APPLICABLE`
  first, and the readiness panel returns from its not-applicable branch before any recovery line
  renders. Recording `required` would be a demand no gate enforces and no surface shows, and the
  clear route would then write a clearance for a launch that gated nothing. The verdict itself is
  still recorded in `preflight`, which is where a reader asking about the handoff should look.
  **Left open:** on an engine that declares no launch-sequence support, a session launching against
  a damaged handoff is therefore gated by nothing at all. That is the pre-existing shape of a
  not-applicable launch, not something this car narrowed, and closing it needs a surface that does
  not exist yet (Critic R-9, #1587).

- **`tc start status` reports the recovery state.** Not in §2.3's status block, which listed
  `recovery` alone; the renderer now prints the mode, the revision and what opens the gate, because
  a session told its task step is withheld looks to `status` to find out whether anything changed.

### Acceptance cases (from §4 Chunk 03, the recovery subset)

- advisory recovery reaches READY only with a reconciliation, atomically `cleared`
- operator recovery cannot use the advisory path (`RECOVERY_UNCLEARED`); the clear route refuses
  advisory rows
- an armed install with failed auth never reaches the open-install branch; fallback is refused;
  open-install clears are labelled unverified
- READY while recovery is uncleared
- an unready timer does not unlock step 4
- a late clear for another sequence or revision → `STALE_RECOVERY`
- a machine client clearing → 403
- the open-install clear is recorded as unverified

### Done when

Every box above is ticked, the suite is green, `/prawduct:critic` has run with no unresolved
blocking findings, the VRF entry is enqueued, and the PR closes #1587.

---

## 4c. Car 21.10 build plan (#1588) — per-rule drift reconciliation in step 3

**Branch:** `feat/train-21-car-21-10`. **Schema:** no DB migration (see decisions).
**Critic mode:** the chunk is `cumulative-final`, so 21.12's review is the train final; this car
takes a `chunk` review. **Type:** feature. **Size:** medium.

**Acceptance cases are DERIVED here, not quoted.** #1588 says "the acceptance cases for this car
are listed under Chunk 04 in the plan" — they are not; §4's Chunk 04 carries three deliverable
bullets and a governance-checkpoint note and nothing else. Chunks 02 and 03 each got an explicit
`Acceptance cases:` list and Chunk 04 never did. The cases below are derived from the approved
blueprint text that does exist (§2.2 rule-change/revision, §2.4 step 3's contents, §2.6's handoff
manifest fields) rather than invented, and they are flagged to the Architect with ADR 0017 (21.12)
so the gap is closed in the record rather than in one builder's head.

### Confidence check

- **Problem.** A session's rules can change between the wrap that wrote the handoff and the launch
  that reads it, and today nothing says so. Step 3 reports the preflight verdict and the handoff
  summary, both of which can read `ok` while the rule set the previous session worked under no
  longer exists. The agent then resumes that session's work under rules it was never told changed.
- **Success.** Step 3 names every rule added, removed or changed since the handoff was written,
  per rule and per source; a launch with any such drift cannot attest READY without a
  reconciliation, exactly as a revision cannot; and a handoff that never recorded a source says
  so rather than reading as "unchanged".
- **Out of scope.** Engine parity probes (21.11), ADR 0017 and the doc set (21.12), #1611's
  removal of the launching-workspace predicate, and retention (#1595). This car does not change
  what a wrap stages beyond the manifest widening below, and does not touch the recovery gate.

### The gap this car has to close, precisely

`_ruleManifest` (21.9, `lib/wrap-steps/handoff-stage.js`) already reuses
`launchSequence.ruleFingerprints` and says in a comment that it does so *because* 21.10 diffs the
two manifests. That reuse holds. What does not hold is the fingerprint's coverage:

- `ruleFingerprints` reads `store.sessionRules.listActiveForProject` and stamps every row
  `source: 'project'` — a literal, not a derivation. §2.2's manifest schema declares
  `"source": "project|global|shared"`, so two of the three declared values are unreachable today.
- The global rule set reaches the handoff as `globalRulesHash`, ONE hash over the whole text. A
  per-rule diff cannot come out of it; only "the global rules changed" can.
- Shared documents reach the LAUNCH manifest (`sourceManifest.sharedDocs`) but are **absent from
  the handoff document entirely**. There is nothing to diff them against.

So "including global/shared sources" is satisfiable for global at set granularity and, for shared,
only for handoffs written after this car ships.

### Decisions this car records

- **`[DECISION: widen the handoff manifest additively, keep the schema id at tc.handoff/1 |
  alternatives: a tc.handoff/2 bump, or diffing only project rules | rationale below]`**
  `rules[]` gains entries whose `source` is `global` or `shared` alongside the existing `project`
  rows, and the document gains exactly ONE new top-level field, `manifestSources`. Readers that
  ignore both behave exactly as before, which is what makes it additive; `globalRulesHash` stays
  where it is and keeps its meaning, because removing it would break the 21.8 preflight that
  already reads it. A schema bump would force a migration path for documents that are frozen bytes
  on disk and would buy nothing these two additions do not.

  **`manifestSources` is not optional, and the diff cannot be honest without it.** It was absent
  from the first cut of this decision, and writing the diff is what exposed the hole: a handoff
  carrying no `shared` rows is EITHER one written before this car (which recorded no shared docs at
  all) OR one written after it for a project that simply has none. Those two demand opposite
  answers — `not-recorded` and `unchanged` — and nothing already in the document tells them apart,
  because the pre-car fingerprint stamped every row `project` by literal. `manifestSources` is the
  producing wrap declaring which sources it looked at; a document without it is read as having
  recorded `project` only, which is exactly what was true before this car.
- **`[DECISION: the per-source verdict is FIVE-valued, and which SIDE was silent is part of the
  verdict | alternatives: a boolean changed/unchanged; a three-valued changed/unchanged/unknown |
  rationale: this is the §2.7 three-valued-`dirty` lesson one document over, and the third value
  was not enough]`** `changed` / `unchanged` / `not-recorded` (the HANDOFF never looked) /
  `unreadable-at-wrap` (the previous wrap recorded the source but could not hash part of it) /
  `unreadable-now` (THIS launch could not read it).

  The last two were ONE value for exactly one review round, and that round shipped a renderer
  telling operators "this launch could not read it — the server log names what failed" about files
  that had failed at the previous wrap, on a machine whose log says nothing. Which side was silent
  is not a detail of the verdict; it IS the verdict, because it decides where the person reading it
  goes to look. A three-valued model is strictly better than a boolean and still wrong here.

- **`[DECISION: an unmeasured row withholds GATING for its source but never suppresses a measured
  change | alternatives: demote the whole source out of the comparison | rationale: completeness
  and drift are different questions]`** A source holding an unreadable row cannot claim "and
  nothing else changed", so it is reported as partly uncompared. But the rows that COULD be
  measured were measured: dropping a real change because a sibling row was unreadable loses the one
  fact the agent most needs and fails OPEN at the READY gate. The first cut demoted the whole
  source before computing changes, and its own test pinned the loss — a shared document moving
  `h1` → `CHANGED` with `hasDrift` asserted false. A measured change outranks a partial read in
  the verdict, and the gap is disclosed beside it rather than in place of it.

- **`[DECISION: an unmeasurable governing source does NOT require a reconciliation — the gate
  fails OPEN | alternatives: fail closed, demanding a reconciliation whenever any source could not
  be compared | rationale: the gate's subject is drift, and an unmeasured source is not evidence of
  drift]`** This is the failure DIRECTION of the new gate, and it was recorded only implicitly
  until the Critic asked for it directly.

  Fail-closed is the safer-sounding answer and is wrong here for two reasons. A reconciliation is a
  written account of *what changed and what you are carrying forward*; demanding one for a source
  nobody could read asks the agent to write about something no one can tell it, which trains the
  habit of writing past a gate to get through it — the same defect as a requirement whose stated
  reason is missing from the text. And the condition is not rare or self-clearing: a shared
  document with a bad path is unreadable on every launch until a person fixes it, so fail-closed
  would demand a reconciliation forever, from every session, for one stale row in a config.

  What replaces gating is disclosure: step 3 states the gap in its own sentence, names the side
  that went silent, and says plainly that what is NOT named may have changed too. The operator-
  facing signal is the server log line naming the file. **The accepted cost is real** — a genuine
  rule change inside an unreadable source passes unreconciled — and it is accepted because the
  alternative blocks every launch on a condition the agent cannot resolve. Revisit if an
  unreadable governing source ever becomes common rather than a misconfiguration.

- **`[DECISION: a legacy handoff carrying NO rows claims nothing | alternatives: read it as
  "recorded: project", per the era's fingerprint | rationale: the producer's empty array is
  ambiguous and one reading invents drift]`** The pre-21.10 wrap returned `[]` both for a project
  that genuinely had no rules AND for a rules read that threw — its catch returned an empty array —
  so the frozen bytes cannot tell them apart. Reading such a document as having recorded the
  project rules makes every rule in force now report as ADDED and refuses READY for a change nobody
  made, on every launch, until someone edits a rule. Unknown is the honest answer and the safe
  direction. A legacy document WITH rows is still read as project-only: its rows are what make it
  evidence.
- **`[DECISION: drift requires a reconciliation, and does NOT revise the snapshot |
  alternatives: make drift a revision | rationale: a revision is about content served under the
  agent]`** §2.2's revision exists because steps already served were replaced; the cursor moves
  back and step 1 may carry over. Drift against a PREVIOUS session's handoff replaces nothing this
  launch served — the snapshot is correct as rendered. Reporting it as a revision would re-serve
  four steps that did not change and would make `carried_from_revision` evidence meaningless. It
  therefore joins `_reconciliationRequired` as a fourth trigger, beside advisory recovery, a
  revision, and a preflight verdict that declares one.
- **No DB migration.** Every input is either in the frozen handoff bytes or recomputable at launch;
  nothing here needs a column. The next unshipped schema version stays free for 21.11/21.12.

### Steps

1. **Widen the fingerprint.** `ruleFingerprints` takes an explicit source rather than stamping
   `'project'`, and a new `manifestFingerprints(project)` composes the three sources into one
   ordered array: project rules (per rule, as today), one `global` row hashing the global rule
   text, and one `shared` row per registered shared document. `_ruleManifest` (wrap) and
   `_launchRuleDrift` (launch) both call the composer with NO caller-supplied rules, so the two
   manifests the diff compares are built by one reader from one population — the property 21.9's
   comment was protecting, now pinned by a test rather than by a comment.

   **`buildSourceManifest` deliberately does NOT call the composer**, and an earlier draft of this
   step said it did. Its `rules` array is the input to §2.2's revision check, whose ratified
   trigger is a change to the PROJECT rules served in step 2; feeding it the widened array would
   make a global-rules edit re-render four steps and move the cursor back, which changes Chunk 02's
   approved protocol. The cost is that the three sources are traversed twice per launch and that
   the global text is hashed two ways — `globalRulesHash` untrimmed (21.8's preflight reads it) and
   the composer's `global` row trimmed. The composer's row is the authority for "did the global
   rules change"; the handoff document's JSDoc says so, because a reader holding two hashes of one
   document otherwise cannot tell which answers that question.
2. **A pure diff.** `lib/launch-rule-drift.js`, no store reads: `diffRuleManifests(before, after)`
   returns `{added, removed, changed, perSource, unmeasured, comparedSources}` where `perSource`
   is the FIVE-valued verdict above and `unmeasured` names, per side, the sources whose rows could
   not be hashed. Pure so the step renderer and the READY gate share one answer and cannot
   disagree.
3. **Render it in step 3.** `_ruleDriftLines(...)` joins `_preflightLines` in the `state` step:
   one line per added/removed/changed rule naming the source and the rule; a per-source line for
   `not-recorded`; two SEPARATE lines for the two unreadable directions, because one sends the
   reader to the previous session's machine and the other to this one; and an explicit "no drift"
   line when there is none — said, never implied, the same way stranded wraps says it. That last
   line is built from the VERDICT, naming only sources whose state is literally `unchanged`, not
   from `comparedSources`: a source that was compared but only partly readable cannot carry
   "nothing changed" either.
4. **Gate READY.** `_reconciliationRequired` gains the drift trigger, with wording that names what
   drifted. The drift is computed once at sequence creation and stored on the sequence, because the
   gate and the frozen step must answer identically — recomputing at READY would let a rule edit
   between render and attest produce a requirement the agent was never shown.
5. **Tests**, per the cases below.

### Acceptance cases (derived — see the note above)

- a rule added since the handoff → step 3 names it as added, and READY without a reconciliation is
  refused naming that rule
- a rule removed since the handoff → named as removed; READY refused
- a rule whose body changed (same id, new `contentHash`) → named as changed, not as add+remove
- a rule whose `revision` moved but whose `contentHash` did not → NOT drift (the body is what the
  session read; a no-op version bump is not a change to report)
- the global rule text changed → one `global` source line, and READY refused
- a shared document's content changed → named per document
- a handoff that recorded no `shared` rows → step 3 says `not-recorded` for that source, READY is
  NOT gated on it, and the line never reads as "unchanged"
- a source neither side could compare → READY is NOT gated on it (the recorded fail-open decision),
  step 3 states the gap in its own line, and the line names WHICH side went silent
- a measured change inside a partly-unreadable source → still named AND still gates, with the gap
  disclosed beside it rather than in place of it
- no drift at all → step 3 says so explicitly, and READY needs no reconciliation on drift grounds
- drift AND a revision → ONE reconciliation requirement, and the REVISION's wording wins. An
  earlier draft of this list said the wording should name both; the code is first-match-wins across
  four ordered triggers and that is the better answer, so the case is corrected here rather than
  the code changed to match a sentence nobody ratified. An agent handed a list of reasons cannot
  tell which gate it is standing at, and the stronger condition is the one it must act on. The
  ordering (advisory recovery → revision → preflight verdict → drift) is pinned by tests.
- drift on a launch whose preflight already requires a reconciliation → the preflight's wording
  wins, for the same reason; drift does not replace it and is not appended to it
- a launch with no handoff at all (first launch) → no drift section claims, and no drift gate
- a corrupt handoff → the drift section says it could not be read, and does not gate READY (the
  preflight already owns the corrupt verdict). Implemented as a distinct `{unavailable: reason}`
  value rather than the `null` that means "first launch": a measurement that was attempted and
  lost must not render identically to a clean slate, or a real rule change goes unreconciled with
  nothing in the agent's own text recording that anything was tried.
- the drift stored at creation is what the gate reads: a rule edited between render and READY does
  not change the requirement the agent was shown
- `ruleFingerprints` and `_ruleManifest` derive byte-identical manifests for the same project state
  (the property 21.9's comment asserts, now pinned by a test rather than by a comment)

Added by the Critic pass on this car — each one a place where failure and "nothing to report" were
the same value:

- a shared document unreadable at BOTH the wrap and the launch is `unreadable`, never `unchanged`.
  `_fileHash` answers null for a file it could not read, two nulls compare equal, and the row was
  filed under unchanged — the exact claim this car's own decision forbids, on the one source this
  car adds, with no log line and no rendered line. A null hash is now carried as `measured: false`
  and the diff refuses to compare it.
- a source THIS LAUNCH could not read is `unreadable`, not `not-recorded`. Both are uncomparable
  and they are silent on opposite sides: `not-recorded` sends the operator to the previous
  session, `unreadable` sends them to this machine.
- step 3's no-drift sentence names only the sources whose verdict is `unchanged` (it briefly named
  `comparedSources`, which was still too wide — a partly-readable source was compared and cannot
  carry the claim). It used to speak for all three sources
  whenever `hasDrift` was false — including the first launch after this ships for every project,
  where two of three were never compared — and then retract it on the next line.
- a drift computation that threw, and a handoff that could not be read, render a section saying so
  rather than no section at all. Only a genuine first launch renders nothing.
- the composer takes NO rules from its caller. The launch used to hand in its already-filtered
  bundle while the wrap read the store unfiltered, so a project holding one unusable rule reported
  it as removed on every launch and blocked READY forever for a deletion that never happened; and
  a caller whose own rules query THREW handed in `[]`, indistinguishable from "no rules".

### Requirements Confidence

**MEDIUM.** The blueprint text this car implements (§2.2, §2.4's step-3 row, §2.6's manifest
fields) is Architect-approved at rev 4, so WHAT step 3 must contain is settled. What is not settled
is the acceptance list: #1588 cites one the plan never carried, and the fourteen above plus the
five added by the Critic pass are derived by this builder. They are the test contract as built, and
they are what ADR 0017 (21.12) asks the Architect to ratify — a MEDIUM that resolves to HIGH on
that ruling, or sends this car back if the derivation missed the intent.

### Architect ruling, 2026-09-19 — the derived contract is APPROVED WITH AMENDMENTS

`/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-chunk04-acceptance-ruling.md`.
A CONTRACT review — explicitly not code, PR or merge approval. The `Requirements Confidence: MEDIUM`
above resolves on this ruling, subject to the amendments below, which are recorded here rather than
deferred to ADR 0017 at the Architect's instruction.

- **A measured empty is not an absence.** A manifest that explicitly declares `shared` and carries
  zero shared rows has measured zero: it must compare zero→zero `unchanged`, and zero→one `added`.
  The shipped code already behaves this way — `recordedSources` returns the declared filter
  whenever `manifestSources` is an array, so the unknown-reading fires ONLY when the field is
  absent entirely (the pre-21.10 producer, which wrote `[]` both for "no rules" and for a read that
  threw). The behaviour was incidental; an acceptance case now pins it.
- **Unknown alone does not create a drift gate, and cannot waive recovery or current-rule
  delivery.** The fail-open decision is approved for DRIFT only. It carries no authority over the
  recovery gate or the rules channel; both are decided elsewhere and stay decided there.
- **First-match refusal priority is approved, with a proviso:** all drift and uncertainty must
  remain visible. Only the refusal STRING is first-match — step 3 renders every finding and every
  gap whichever trigger supplied the wording.
- **Frozen original drift must not defeat a pre-READY revision or re-ack.** Carrying the drift
  through a revision must not interfere with that revision's cursor reset and re-acknowledgement.
  To be VERIFIED, not asserted.
- The prose bullet count was wrong (19 claimed, 21 actual). No count is written here now: nothing
  parses one, and this repo's own learning is that it goes stale — which it did inside one session.

### As-built delta — the global row was the third source, and it lacked the treatment

A cumulative round after the amendments landed found the class this car exists to fix, surviving
in the one source nobody had re-derived. `manifestFingerprints` wrapped `store.globalRules.load()`
in a try/catch, but that call catches its own errors AND the missing-file case and answers `''`,
so the catch was dead for both realistic failures and the row froze as `sha('')` — a real-looking
hash for a measurement nobody took, carrying no `measured: false`.

Its two siblings were already honest: `_fileHash` answers `null` for a shared document it could
not read, and `listActiveForProject` throws so the project source is left undeclared. Global was
the only one of the three without the treatment — **the recurring shape here is a fix applied to
the sites that prompted it and not to the family**, which this plan already records twice.

Fixed at the producer, not the consumer: `store.globalRules.loadMeasured()` answers
`{text, measured}` from ONE read, and `load()` now delegates to it so every existing caller is
byte-for-byte unchanged. `manifestFingerprints` carries `measured` through and hashes only a
document it actually read. The path stays private to the store — a readability probe in
`launch-sequence.js` would have minted a second source of truth for where the global rules live
and would have silently bypassed the test-only path redirection.

The consumer needed no change: `_measured()` was already correct, and correctly returned `true`
for `sha('')` because that IS a non-empty hash string. The predicate was sound; it was being fed
a fabricated measurement.

Pinned by four cases, including the end-to-end property rather than only the field: a document
unreadable on BOTH sides must not be reported `unchanged`. A measured empty stays measured — the
amendment above is the case the fix must not break while fixing the unread one.

### Done when

Every box above is ticked, the suite is green, `/prawduct:critic` has run at `chunk` with no
unresolved blocking findings, the four amendments above are implemented or verified, and the PR
closes #1588.

## 4d. Car 21.11 build plan (#1589) — engine parity CERTIFICATION

> **SUPERSEDED 2026-09-20 BY OPERATOR SCOPE AMENDMENT. NOTHING BELOW IS BINDING.**
>
> #1589 is **CLOSED**. The certification subsystem this section specifies — acceptance cases 1–5 and
> 8 — was **cancelled by scope, not blocked**: the operator judged that no current downstream
> consumer needs durable certification. **Live parity evidence was never the obstacle.** The
> operator accepted **six Codex and three Antigravity clean READY launches** for this car, and the
> `launch_sequences` table carries attested launches on both engines. An earlier reading — that
> required probes could not be obtained because an agent driving a pane is assisted activation — was
> **retracted**; it is named here rather than deleted so the retraction outlives the draft that
> carried it.
>
> **Every "Done when", acceptance case and final-parity clause in this section is superseded** and
> demands nothing of any car, this train's final review included. Aider parity moved to epic #1645.
> What actually shipped from this car, and what was removed, is recorded in `## Status` — read that,
> not the specification below.
>
> The section is kept unedited because it holds the reasoning a future revival would otherwise
> re-derive. Read it as an archived design, never as work owed.

**Branch:** `feat/train-21-car-21-11`. **Schema:** no DB migration. **Critic mode:** `chunk` — the
chunk is `cumulative-final`, so 21.12's review is the train final. **Type:** feature. **Size:**
medium.

**This section was rewritten wholesale on 2026-09-19** against the Architect's formal #1650 ruling
(`/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-preflight-evaluation-failure-ruling.md`,
recorded on the issue). The prior draft is preserved in commit `b53412fab` for diffing and is
**superseded, not amended**: it was built around *existence* — does `tc` resolve, does READY land —
and the ruling replaces that oracle outright. Two of its premises were also false, and both are
corrected below.

### What the prior draft got wrong, recorded so it is not re-derived

1. **"Nobody has confirmed `tc` resolves in codex/aider/antigravity panes" was FALSE.** The live
   `launch_sequences` table already separates the three engines: **codex** seq 29 reached READY with
   no unready transition and 0 nudges; **antigravity** seq 27 went unready → 1 nudge → READY, so its
   outcome was nudge-ASSISTED and the assistance is recorded; **aider** seq 33 went unready → **0
   nudges** → READY 13 minutes later, so the outcome is real but the mechanism is **unattributed**.
   That third row is the Architect's "assisted READY, candidate qualification missing" — and it is
   the actual finding, not the absence the draft claimed.
   *Re-verified read-only against `launch_sequences` on 2026-09-19 before this rewrite was
   committed: `nudge_count` 0/1/0 and `unready_at` null/set/set for seq 29/27/33 respectively, with
   `page_budget` 7332 on all three. The numbers are the table's, not a recollection.*
2. **"A stale pass is visible in a git diff" was REJECTED** by the Architect as an acceptance case.
   A git diff is not a mechanism. Staleness must be detected by the binding described below, not by
   a human noticing a diff.
3. Measured overhead is **668**, not the 301 the draft's harmlessness claim assumed — all three
   engines carry `page_budget 7332`. `toolOutput` 8000 with `measured:false` is already honest and
   stays.

### The oracle, restated: READY alone certifies nothing

Per the ruling, a probe may no longer assert "READY lands". Three distinct outcomes, none of which
substitutes for another:

| Scenario | Passes when | Does NOT establish |
|---|---|---|
| **Normal success** | the verdict is *successfully evaluated*, recovery state is correct, rule delivery and acknowledgements are current, and READY is bound to the SAME launch and final revision | anything about failure handling |
| **Injected evaluation failure** | the configured gate REFUSES — `operator` withholds the task step and refuses READY; `advisory` warns and requires written reconciliation plus atomic clearance | successful-preflight evidence, ever |
| **Cleared recovery** | a separately NAMED scenario: clearance was granted under the configured policy AND the failed-evaluation provenance survives it | that the evaluation succeeded — clearance is permission, not evaluation |

Neither `not-evaluated` nor missing evaluation evidence qualifies the normal-success case, **even
after a clearance**. A required engine failure is recorded as failed or blocked — never `N/A`
merely to close the car.

### Certification binding — what a result is bound to, and what invalidates it

A pass certifies a **configuration**, not an engine name. Every recorded result binds to all of:

- engine id **and version**
- the effective relevant **config fingerprint**
- **source / deployed runtime identity** (what actually ran, not what the repo says)
- the **same launch and session**, and the same **final revision**
- **assistance attribution** — automatic, nudge-assisted, or unattributed, carried explicitly

**Any changed input demotes the result to `historical` / `stale`. It is never reported as
current-verified.** Invalidation is mechanical, derived from the binding — not a reviewer noticing.
The three engine rows above are today's evidence and are `historical` by this rule until re-run
under a recorded binding.

### Acceptance cases — DERIVED, and flagged as such

Same treatment as §4c: #1589 says Chunk 04's cases are in the plan; they are not. These are derived
from the approved §2.9 text plus the #1650 ruling, marked derived, and carried to the Architect with
ADR 0017. `Requirements Confidence: MEDIUM` on that dependency.

1. A normal-success probe on an engine establishes all five bindings and a verdict of successfully
   evaluated; READY is bound to the same launch and final revision.
2. An injected context-evaluation failure in **`operator`** mode: the task step is withheld and
   READY is refused until a bound clear. Asserted through the REAL evaluator → stored preflight →
   snapshot → task/READY path, not a hand-built `requiresRecovery: true` fixture.
3. The same injected failure in **`advisory`** mode: warning served, written reconciliation and
   atomic `agent-reconciled` clearance required; no silent acceptance.
4. A **valid bound clearance** clears; a **wrong or stale** clearance does not.
5. After clearance, the **failed verdict and its provenance are still readable**.
6. The **missing/malformed result** fallback on a launch that required the check does NOT yield an
   open gate.
7. **Legitimate first launch** is CHECKED, reaches a positive evaluated verdict through the real
   evaluator, and proceeds on THAT — never on an absence. Covered end to end through the real
   evaluator and snapshot, not by a fixture that omits `preflight`.
8. An **unattributed** READY (aider's shape: no nudge, delayed transition) is recorded as
   unattributed and does **not** qualify as automatic.

### Bounds in force (ProjectManager, 2026-09-19) — unchanged by the rewrite

Probes are serial, bounded and isolated. No second implementing Builder. No injection into an
operator pane. Required parity rests on actual same-launch in-pane `tc` output **and** a server-side
READY record. A blocked or failed probe is recorded as blocked or failed. Manual startup is
distinguished from automatic activation.

### The discriminator, RESOLVED — and my premise was wrong

I had proposed splitting the constant on "was the check required", assuming a legitimate first
launch arrives with **no** preflight. **The Architect corrected the premise** (clarification dated
2026-09-19 against main `202dcb75d`): an omitted preflight was never first-launch evidence.

Production calls `launchPreflight.evaluate` BEFORE constructing the snapshot, and the evaluator
reaches `first-launch` only after establishing no sessions, no publication rows, no continuity
index and an absent handoff — with integrity checks preceding it. **A failed read or a missing
argument cannot establish those absences.** First launch is a positively evaluated verdict that
happens to be benign, not an absence of evaluation.

So the contract is simpler than the split I proposed, and the split would have been actively
harmful — it would have created exactly the permissive omitted-argument path that reopens the hole:

- Applicable current launches require the check, **including first launches**.
- Missing, null or malformed at the snapshot boundary **owes recovery**. ONE default — not a
  permissive constructor case beside a restrictive fallback case.
- Legitimate first-launch behaviour is preserved by passing its **explicit successful evaluation**,
  never by leaving `preflight` out.
- Attempted-failure and missing-evidence stay **distinct for provenance** ("we tried and it broke"
  and "nothing ever ran" send a reader to different places). Neither satisfies a required
  successful check.
- **No** `preflightRequired: false` flag and no "no handoff means no check" exemption. #1623's
  not-applicable path must not become a backdoor for applicable sequences.

Normalization placement is the Builder's, provided storage, renderer and gate carry one consistent
contract. Construction fixtures intending a healthy launch pass an explicit valid evaluated
preflight; omission, null and malformed each get their own negative test.

**#1650's production correction is tracked separately from this parity car**, per the ruling — its
own branch and PR, not folded in here.

### Explicitly out of scope

- **#1623** (no usable sequence) — a separate gap. Fixing the sequenced path does not close it and
  does not certify an affected no-sequence case.
- **#1648** evaluated-`stale` semantics — unchanged by the ruling.
- Historical engine-capability probe failures remain **non-gating** for supported governance
  delivery.
- Historical pre-gate rows stay historical. No bulk rewrite of their outcomes.

### Done when — SUPERSEDED, DEMANDS NOTHING

> This clause is dead. The operator **did** explicitly amend scope on 2026-09-20 — the branch this
> text names — and #1589 closed under it. Nothing below is owed by any car, and the **final parity
> acceptance it holds is cancelled, not pending**: it cannot be un-held, because what it gated no
> longer exists. The whole-trajectory prerequisite **expires with the deliverable it gated** — it
> does not transfer to a later train, and nothing inherits it; §4e records that disposition.
> Repeated at this heading because a reader who jumps straight to "Done when" never sees §4d's
> banner.

Superseded text, kept verbatim for the reasoning:

**Probes RUN with any outcome does NOT close #1589** (Architect, binding). Required cases must PASS,
or the operator explicitly amends scope. Beyond that: every box ticked, suite green,
`/prawduct:critic` at `chunk` with no unresolved blocking findings, ADR 0017 carrying the #1650
ruling and returned for Architect review, and **final parity acceptance still HELD** until the
#1650 correction is integrated into the identified candidate and the whole-trajectory findings have
an explicit disposition. Diagnostic runs are labelled diagnostic and are not final certification.

## 4e. Car 21.12 build plan (#1590) — ADR 0017 and the doc set

**Branch:** `feat/train-21-car-21-12`. **Schema:** no DB migration. **Critic mode:** `cumulative` —
Chunk 04 is `Type: cumulative-final`, so this car's review IS the train final; no separate `final`
is run. **Type:** feature (documentation). **Size:** medium.

**Bound 4 is in force:** the ADR draft goes to the Architect BEFORE this merges. This car does not
auto-merge.

### Confidence check

- **Problem.** Train 21 replaced a single pushed prime with a server-ordered acknowledged sequence,
  a handoff lockfile, a preflight and a recovery gate — eleven cars of mechanism with no
  architectural record and no operator-facing reference. A reader today can find the *behaviour* in
  `FEATURES.md` and the *settings* in `configuration-reference.md`, but nothing states why the
  design is shaped this way, which parts shipped, and which parts were descoped rather than built.
- **Success.** ADR 0017 exists and is accepted; an engine implementer can read `engine-guide.md` and
  learn what the attestation, recovery and handoff halves of the sequence require of their engine;
  `configuration-reference.md` covers every launch-sequence setting the train shipped; the CHANGELOG
  carries the train. A reader can tell **shipped** from **desired** without opening an issue.
- **Out of scope.** The R1 amendment to `prime-delivery-direction.md` §3 (shipped with 21.6). Any
  code change to the launch sequence. The certification machinery removed from 21.11 by the
  operator's amendment — this car records that it was removed, and never as shipped. Aider parity
  (#1645). The open defects below are *recorded*, not fixed.

### `api-contract.md` does not exist, and this car does not create it

§4's line for this car names `api-contract.md`. **There is no such file, and there never has been**
— not at `docs/api-contract.md`, not anywhere in the repo (`git ls-files` finds no path matching
`*api*contract*`). The name was written into the plan on 2026-09-17 from the shape a doc set
usually takes, not from this repo's.

This repo documents its HTTP surface in three places, none of them a contract doc: `FEATURES.md`
per feature (which already carries `POST /api/tc/start/next` and `GET /api/tc/start/status`), the
`data/*-guide.md` carriers that are injected into engine configs, and `docs/engine-guide.md` for
what an engine must do. **Creating a whole API contract doc is a new documentation surface**, with
its own freshness obligation on every route the product ships — that is a decision about this
repo's doc architecture, not a step in a car about Train 21.

`[DECISION: route the api-contract.md obligation to engine-guide.md and FEATURES.md rather than
creating docs/api-contract.md | the named file does not exist, and standing up a repo-wide API
contract doc inside a train car would create a surface nobody committed to maintaining | Builder1
2026-09-20, reported to the ProjectManager; reversible by filing the doc as its own chore]`

### The gap each file has to close, measured not assumed

Measured at `cffe998a4`, by grepping each file for the train's own vocabulary:

| File | Has | Missing |
|---|---|---|
| `FEATURES.md` | the sequence, the unready monitor, the ack rules, both routes | nothing this car must add |
| `docs/configuration-reference.md` | the whole `launchSequence` object — `pasteRules`, `unreadyWindowMinutes`, `recoveryMode` | nothing this car must add |
| `docs/engine-guide.md` | `toolOutput.maxChars`, `launchSequence.supported`, `TANGLECLAW_LAUNCH_ID` | **`tc start ready` and attestation; recovery and what a withheld task step looks like; the handoff preflight.** Zero occurrences of `ready`, `recovery`, `handoff` or `preflight` in the file |
| `docs/adr/` | 0002–0016 | **ADR 0017** |
| `CHANGELOG.md` | per-PR entries under `[Unreleased]` | the train's own entry |

So the doc work is **one new ADR, one real gap in `engine-guide.md`, and the CHANGELOG**. The other
two files were kept current by the cars that built them — recorded here because "update
`configuration-reference.md`" reads like outstanding work, and it is not.

### What ADR 0017 must carry, from the rulings that bind it

1. **R1, R2, R3** (§0) with their dispositions and who ruled.
2. **The #1650 ruling** — 21.11's Done-when requires ADR 0017 to carry it.
3. **Shipped vs desired, stated separately.** The Architect's 2026-09-19 ruling on #1589 requires
   this in as many words, with #1611 as the named case.
4. **What was descoped and by whom** — the operator's 2026-09-20 amendment removed 21.11's
   certification machinery (acceptance cases 1–5 and 8). The ADR records it as removed, never as
   shipped.
5. **The open defects the train leaves behind:** #1611 (identity check's workspace half unwired),
   #1623 (a launch with no sequence is gated by nothing), #1595 (retention), #1712, #1713.

### Steps

1. Write `docs/adr/0017-phased-launch.md`.
2. Add the attestation / recovery / handoff section to `docs/engine-guide.md`.
3. CHANGELOG entry under `[Unreleased]`.
4. `/prawduct:critic` at `cumulative` — and disposition the outcome (see the finding below).
5. Architect review of the ADR (bound 4) BEFORE merge, against a committed immutable head.
6. **Tick this car and Chunk 04 in `## Status` only once every Done-when gate above is satisfied,
   this review included.** A tick is a claim every later reader believes, and a car cannot certify
   its own bound 4 — ticking before the review inverts the gate it is supposed to record.

### Acceptance cases

These are documentation, so each case is a claim a reader can falsify against the code.

- Every `tc start` subverb the product ships (`next`, `status`, `ready`) appears in `engine-guide.md`
  with what the engine must do for it. Falsified by a subverb in `START_SUBVERBS` that the guide
  never names.
- The ADR's "shipped" column matches the code. Falsified by any row asserting behaviour that
  `lib/launch-preflight.js`, `lib/launch-sequence.js` or `lib/handoff-publication.js` does not
  implement — #1611's workspace half is the case that must land under **desired**, not shipped.
- No document claims a required parity case passed. Falsified by any sentence reading 21.11 as
  certified rather than descoped.
- The ADR names R1/R2/R3 and the #1650 ruling with dates and rulers.
- Every issue number cited resolves to an issue whose state matches how the text describes it.
- No file path is cited that does not exist — the `api-contract.md` case is the one this car found,
  and the pre-rename `TangleClaw-Builder` path is the other.

### Done when

Every box above ticked, the suite green (unchanged — this car adds no code), the cumulative-final
review dispositioned per the finding below, the ADR reviewed by the Architect, and the PR merged by
hand rather than by `--auto`.

### The cumulative-final review has no subject, and that is a finding, not a formality

`/prawduct:critic cumulative` was dispatched and **declined: exit 3, "no review needed — no
judgeable file"**. All four files this car touches are records or prose, so the interval composes as
a free edge and the coverage gate already passes it. Forcing a review would grade four documents,
which is not a whole-trajectory review either.

**This matters because two separate obligations were resting on this car's review, and they are not
the same obligation.**

1. **The plan's own `Type: cumulative-final`** — "21.12's review IS the train final; no separate one
   is run." This one is genuinely satisfied by composition: each car's code was reviewed on its own
   branch, those facts are in the evidence store, and the gate spans the interval. What is NOT
   satisfied is the *expectation a future reader would form* from the phrase "the train final",
   which implies a review round that never happened. Recorded here so nobody goes looking for a
   review fact that was never written.

2. **The Architect's whole-trajectory review** (ruling on #1589, 2026-09-19: *"Whole-trajectory
   review remains a final-parity prerequisite"*), which §4d's Done-when also held. **This one cannot
   be produced from this branch at any interval.** Every car merged into `main` before this branch
   was cut, so this branch's merge-base is already downstream of the whole train — there is no git
   range from here that spans the trajectory the Architect asked to have reviewed.

**Disposition: MOOT, not discharged.** The whole-trajectory review was a prerequisite *of final
parity acceptance*. The operator's 2026-09-20 scope amendment cancelled final parity acceptance —
cases 1–5 and 8 were struck rather than built — and the Architect directed on 2026-09-20 that no
Done-when or final-parity clause may still demand that cancelled subsystem, which is why §4d now
carries a superseded banner. The prerequisite therefore gates nothing in Train 21 — and it gates
nothing anywhere else either. **It expires with the deliverable it gated rather than transferring.**
The Architect ruled this explicitly on 2026-09-20: certification was cancelled for want of a current
consumer, so no future train inherits it by default, and a revival would need **a newly
operator-authorized issue with freshly scoped gates** that this one does not pre-supply.

**Nothing here should be read as the review having been performed.** That sentence is the whole
point of recording this: a declined review and a passed one are indistinguishable in a session
summary, and only the written distinction survives.

## 5. Open assumptions

- `[ASSUMPTION: tc output reaches the model intact up to toolOutput.maxChars per engine | HIGH | Chunk 01 spike measures it; unknown engines default to a conservative 8000 and say so]`
- `[ASSUMPTION: one sequence per session is the Train 21 boundary; a same-process /clear continuation (Train 22) needs context generations and is deferred | MED | Architect agreed 2026-09-17]`
- `[ASSUMPTION: one handoff per registered project root; several agents sharing a root is unsupported until Train 22 | MED]`
- `[ASSUMPTION: a 10-minute default unready window | LOW | project setting]`
- `[ASSUMPTION: unbounded retention for Train 21 | MED | follow-up]`

## 6. Advisory

- The Claude duplication cost (§2.5) is the price of honest evidence. It is worth paying now, and
  worth revisiting only if session-bound per-shard hook receipts ever exist.
- R3: I still lean `advisory`, because the operator is away most of the time and an `operator`
  default can stall a launch overnight. But the microplan is the operator's recorded design, so
  the default follows it until they rule otherwise.

## Status
- [x] Architect schema approval (rev 4, 2026-09-17)
- [x] Operator ruling R3: operator mode (2026-09-17)
- [x] Operator ratification R1 (2026-09-17); the amendment text lands with #1584
- [x] Issues filed: #1579–#1590, tracking #1591 (no milestone; trains are tracked by the tracking issue)
- [x] Chunk 01 — built 2026-09-17 (#1579/#1580/#1581). Deltas from the blueprint, all recorded in the PR:
  - The **push prime composes from the same tagged sections** the pull serves, rather than from
    `renderLaunchStep` itself. §2.4's byte-identity requirement and "compose from the step renderer"
    cannot both hold literally: the push order interleaves the four steps, so composing push out of
    whole steps would reorder it. One collector tags every section with its step; push renders all
    of them in the historical order, pull keeps one step's. Byte identity is pinned by
    `test/prime-golden.test.js` against fixtures captured before the refactor.
  - **Two push deltas, not one.** The bootstrap line is the declared one. The second is derived: the
    ecosystem primer lists `tc`'s verbs from the roster, so adding `start` changes that line by
    construction. It also took the primer's size cap from 2600 to 2700 characters, recorded in
    `test/ecosystem-primer.test.js` as the deliberate budget decision that test asks for.
  - **What the golden fixtures hold, precisely.** They were captured from the generator BEFORE the
    refactor and committed first (`Pin the pushed prime before the launch-step refactor`), which is
    what makes the byte-identity claim checkable. The committed files then moved by exactly one line
    each when `start` joined the verb roster — that one-line diff IS the second delta's evidence, so
    the current fixtures are post-verb by design, not pre-refactor captures.
  - **The blueprint's `renderLaunchStep(step, ctx)` is realized as `renderLaunchSteps`**, which
    returns all four steps from one set of reads — the launch path needs all four at once, and a
    single-step form re-rendered the other three to throw them away. Not a dropped requirement: the
    step renderer §2.4 asks for exists; only its arity changed.
  - `toolOutput.maxChars` for claude is **20,000**, measured in a live session (24,000 characters of
    tool output arrived intact; 51.8 KB was replaced by a preview). codex, aider and antigravity are
    **unmeasured** and take the conservative 8,000 default, which `tc start status` reports as
    assumed. Their live `tc`-in-pane probe is car 21.11's.
  - Step 3 serves a `not-evaluated` preflight verdict that says nothing is known about the handoff —
    the real verdict is Chunk 03's.
- [x] Chunk 02 — built 2026-09-17 (#1582/#1583/#1584). Deltas from the blueprint, all recorded in §4a:
  - The snapshot records the launch's **render context**, because a revision re-renders steps 2–4
    and the collector takes launch-time-only inputs no later request can recompute.
  - `pasteRules=pull` drops the pasted rule text **only when a sequence will actually serve it**,
    and the prime is re-rendered with the rules pasted if the snapshot degrades after the fact.
  - A pointer paste records a rules **skip** naming the sequence, never a `delivered` row carrying
    the rule digest; `projectsWithUndeliveredRules` excludes that one skip. The prime paste's own
    outcome is then unrecorded — filed as #1597.
  - The reconciliation condition stays **unnarrowed**: every revision demands one, and only the
    wording is derived from whether anything was served.
  - Retention follow-up #1595 and the nudge-verdict record #1596 filed from the Critic pass.
- [x] Chunk 03 — COMPLETE 2026-09-18. 21.7 (#1585) shipped (PR #1608); 21.8 (#1586) shipped (v42);
  21.9 (#1587) shipped (PR #1624, `8832e8bd`, v43). All three issues closed.
  - [x] Car 21.9 — recovery gate, clear route, UI control (#1587). Steps, as-built deltas and
    Done-when: §4b. Seven Critic rounds; #1623 filed for the one gap left open (a launch with no
    sequence is gated by nothing). VRF-1587-recovery-clear is PENDING with the operator.
  - 21.8's deltas from the blueprint:
  - The context-gathering half lives in its own module, `lib/launch-preflight-context.js`, rather
    than in `lib/sessions.js`. §2.7 says the preflight runs beside the stranded `launchGate`, and it
    does — but the reads it needs (store, handoff directory, git) are what `runPreflight`'s purity
    exists to keep out, and putting them in `sessions.js` would have made them untestable without
    launching a session.
  - **The identity check's workspace half is deliberately not wired**, and this is the one place
    21.8 does not do what §2.7 says. `medusa.mintWorkspaceId` draws fresh random bytes every launch,
    so the launching id can never equal the one a previous session recorded; passing it would report
    `identity-mismatch` — a recovery verdict — on every launch of every Medusa project. The
    `projectId` half is exact and unaffected. Filed as **#1611**: either the check compares something
    that can match, or the contract says identity is `projectId` alone.
  - `SESSION_WINDOW` / `PUBLICATION_WINDOW` (200 each) are diagnostic breadths, not correctness
    thresholds. The decision reads sessions for the newest one, the epoch comparison, and the
    producer of the newest published attempt; the first two are answered correctly by any
    newest-first slice, and the third is answered by fetching producers by id regardless of the
    slice. Publications are bounded on the same argument — every question asked of them is about the
    highest `seq`.
  - **A mixed repair batch applies `record-published` before `publish`**, seq-descending within
    each action. The two actions contend for ONE `current.json` — a `record-published` proposal
    exists only because the file already holds its bytes, and a `publish` renames over it. Ordered
    by seq alone, the rename goes first whenever the promoted attempt has the lower seq, and then
    either `promoteStaged` refuses to retire a `current.json` naming someone else (the launch
    reports `unfinished`, a recovery verdict, for a fully repairable state) or, with no published
    row to retire, the rename destroys the promoted document outright. An action with no declared
    rank sorts LAST rather than first, which is the fail-safe direction, and a test pins that every
    action has an explicit rank.
  - **`requiresRecovery` is stored on the launch record, not recomputed.** It is not a function of
    the verdict: `needsRecovery` reads `evidence.worktreeDirty` for `workspace-unavailable`, because
    a vanished worktree measured clean has nothing to recover while one never measured does. #1587's
    gate reading only the verdict would answer `false` for the unmeasured case — the unsafe
    direction. `worktreeDirty` is stored beside it so the answer stays auditable.
  - **Repair proposals are computed BEFORE the verdict chain**, not at row 6. A proposal is a fact
    about the store, not about which word won; inside the chain it inherited the early exits, so
    rows 1-5 returned none — and `crash-recovery` (row 5) is reachable with a completed, eligible,
    unpublished attempt sitting there. Once a later publication's higher `seq` passed it,
    `_repairable` could never return true for it again. Critic R-8.
  - **A second repair action, `record-published`.** §2.6's reconciliation table opens with a crash
    that landed AFTER `promoteStaged`'s rename and before `recordPublished` — the bytes are already
    `current.json` and only the row is behind. That case had no implementation: a scan of the staged
    files cannot see it, because after the rename no staged file remains. Its applier validates the
    promoted file against the row exactly as a staged file would be, and decides the lost race
    BEFORE reading the file, because `current.json` is shared and a newer winner's bytes would
    otherwise fail the identity check and strand a completed attempt at `staged`. Critic R-2.
  - **`worktree.dirty` stays three-valued.** The producer records `null` when it could not measure;
    row 13 flattened it with `=== true`, which told the operator the tree was clean and withheld
    recovery on a measurement nobody took. `evidence.worktreeDirty` is true/false/null and only a
    MEASURED clean tree withholds recovery. Critic R-1.
  - `evidence.fallbackRootHead` IS now populated, on exactly the condition §2.7 names — a recorded
    worktree that is gone. It was plumbed end to end and hardcoded null in the first cut. Critic
    R-4/R-10/R-17.
  - `handoffEpoch.present` survives `_normalize` and reaches `evidence.epochPresent`, and a missing
    boundary row is stated on EVERY verdict rather than only where `baselineReason` happens to
    print. A tri-state that dies at the last hop is not a tri-state. Critic R-16.
  - Every launch logs its verdict (warn for a recovery-class answer, info otherwise). Step 3 is not
    a channel that always exists — an engine declaring no launch sequence would have recorded
    `handoff-corrupt` and told nobody. Critic R-15.
  - The baseline vocabulary is still declared twice on purpose (importing the store would give the
    pure module a database dependency); `test/handoff-epoch.test.js` now pins the two lists equal,
    which is what makes the duplication safe. Critic R-9.
  - ADR 0002 carries a #1586 amendment: the launch path is a second writer of `current.json`, and
    what it may write. Critic R-18.
  - Retention (#1602) still did not land, and its enabling condition IS now satisfied. Recorded as a
    comment on that issue rather than left in a review — a deferral with no named home is a drop.
    Critic R-14.
  - Two `chunk-ref-missing` entries in the record lint were false positives: 21.7's deliverable bullet
    backticked the schema id tc.handoff/1 and the directory name history/, and the lint reads a
    backticked token containing a slash as a path. Both are unbackticked in that bullet now — and
    note that the first attempt unbackticked them only in the explanatory sentence it appended,
    leaving the real occurrences intact while three records claimed the fix had taken. Verified by
    re-running `prawduct-hook verify-records`, which now reports `chunk-ref-missing=0`. Claim a lint
    fix only from the lint's own output.
  - **§2.7's row 16 names an example that does not reach row 16.** "An `active` newest session with no
    checkpoint" matches row 9 (`handoff-never-published`) first, whenever that session is past the
    epoch — and row 9 is the better answer anyway, because it names what went missing rather than
    listing what failed. A pre-epoch active session reaches row 8 (`legacy-unclean`), not row 16
    either. Row 16's reachable named example is the continuity-index one, which is the one with a
    fixture. The row-16 text is left as rev 4 wrote it and corrected here rather than edited in
    place, so the approval history stays readable; `test/launch-preflight.test.js` pins what the code
    actually returns.
  - **The Critic's record lint could not grade this chunk** and cannot grade any chunk in this repo:
    it reads `.prawduct/artifacts/build-plan.md`, and this repo keeps plans in `.tangleclaw/plans/`.
    A gitignored symlink now mirrors the governing plan there, in this worktree and in the primary
    checkout — the same mirror pattern the other gates already read. Critic R-3.
  - `applyHandoffRepairs` lives in `lib/handoff-publish.js`, not the pure preflight module, and
    delegates its re-checks to `publishHandoff` rather than restating them. `publishHandoff` already
    re-establishes exactly `_repairable`'s conditions inside its own transaction, against the live
    row and file; a second copy of the eligibility rules would be a second copy free to drift from
    the one the wrap path uses.
  - It applies highest `seq` first. Two eligible attempts can both sit ahead of the published row (a
    kept session that staged a checkpoint and then a final, crashing before either published), and
    the other order briefly makes an older attempt current — which §2.6 forbids.
  - The branch's recurring defect, worth reading before touching `lib/wrap-steps/handoff-stage.js`:
    four findings were one class — the step read a foreign object for a value that does not mean
    what the field says (`session.workspaceId`, a column that does not exist; `scope.worktreeTarget`,
    a boolean in a field the schema declares `/abs`; `scope.baseline.dirty`, the launch tree rather
    than the handoff tree; then `git.getInfo`, a 120s cache answering a question the comment claimed
    was measured now). The bytes are frozen at staging, so none of it was repairable afterwards, and
    `dirty` drives §2.7's recovery verdict.
  - Closed by a guard shaped like the class, in `test/handoff-orchestration.test.js`: resolve a REAL
    scope and assert every key the step reads BY TYPE, not by presence. Extend that test rather than
    building a fixture — an earlier hand-built one passed `worktreeTarget: null`, a value no producer
    emits, which is how it hid the bug.
  - `git.getInfo` now takes `{ fresh: true }`, for anything recorded into a frozen document.
- [ ] Launch reliability (#1680, #1673, #1685) — IN PROGRESS, `Type: chunk`. Dispatched by the
  ProjectManager 2026-09-20; branch `feat/train-21-chunk-04`. A separate chunk from the
  `cumulative-final` one below, which it does not consume — see §4's entry for why the two share a
  number on the roadmap and must not share a tick.
  - [x] #1680 — the opening order. Built 2026-09-20. The order is stated once in the launch step
    that arrives FIRST, initialization is declared authorized, and the confirmation gate is scoped
    to the proposed work rather than to reading context. The Resume section stops claiming a turn
    that, on a pull, it is served too late to take.
    - **Four surfaces narrate this order and none owns it**, so they had drifted: the prime's
      ordering block, the all-acked page (`ALL_ACKED_CONTENT`), the already-attested page (the
      `readyAt` arm of `_serve`) and `kickoffLine`. Two disagreed on whether the freshness checks
      precede `tc start ready` — attesting first vouches for an unchecked next action — and two
      ended at the attestation rather than at the proposal. All four now end at the proposal with
      the stop named, each with a test asserting the ORDER by index rather than the prose.
      **Reviews found this in three rounds, each time on the sibling the last fix pointed at**: the
      first round caught the prime, the second caught the all-acked page and `kickoffLine`, the
      third caught the already-attested page. The family was never enumerated, only walked. A
      single-owner construction for this text is the real fix and is NOT done — filed as **#1693**,
      triggered by a fifth surface or by the next edit to any of the four.
    - The fix is text the product generates, so its regression coverage is over generated text:
      `test/launch-steps.test.js` pins the stated order, the explicit authorization, the preserved
      gate, and the absence of any retroactive first-message command. Golden fixtures regenerated
      for all six scenarios; the ordering block ships only where a launch has a sequence.
    - **Generated-text evidence is not a live launch.** Acceptance criterion 3 asks for a real
      launch reaching READY without a second operator prompt; that is a VRF owed, not something
      these fixtures establish. Queued as **VRF-1680-launch-reaches-ready-unprompted** in
      `.prawduct/operator-verification.md` — the box above is ticked for the BUILD, and the VRF is
      what holds the acceptance, because `Fixes #1680` closes the issue on merge and prose in a
      ticked box holds nothing.
    - **A sequence-less launch is the population nothing watches.** It gets the reworded banner and
      Resume with no ordering block, and the owed VRF cannot reach it from a project that has a
      sequence. Named in the VRF entry as the second thing to look at.
    - One test changed for a reason unrelated to the contract it guards: the Medusa-contract yield
      test squeezed against a hardcoded budget sitting fifteen characters above the prime's
      irreducible floor, so any directive edit failed it. It now derives that floor — including
      stripping the overflow report the impossible-budget render appends, without which the fit
      would have held by construction rather than by yielding. Original assertions unchanged; two
      added.
    - **The block is core text, so it displaces bulk.** On the richest sequence-bearing prime
      against Claude's cap it is what tips the total over, and the Ecosystem primer yields to its
      pointer where previously nothing yielded. No directive is displaced and nothing overflows —
      that is the budget working — but it is a real change in what such a session receives. The
      `full-silent-claude-pull` golden fixture is the record; read the yield out of the fixture
      rather than from a number written here, because a number here would go stale the next time
      this text is edited and nothing would catch it. No fixture covered this combination before:
      every other sequence-bearing one is a paste engine whose prime is far smaller.
  - [x] #1673 — CLOSED 2026-09-20 without code, and deliberately. The capability it asks for
    already ships: in `advisory` mode a session clears its own recovery by attesting READY
    (`lib/launch-sequence.js`, clearance `agent-reconciled`). What sends the operator to the
    dashboard is `operator` mode, the shipped default **per ruling R3** — so the gap was a
    governance decision, not a defect. Operator ruled 2026-09-20: report it, leave R3 standing.
    Per-project opt-in remains `launchSequence.recoveryMode: advisory`.
  - [ ] #1685 — wrap prompt delivery receipt. **NOT STARTED — split out of this chunk by the
    operator 2026-09-20** and owed its own session. `lib/wrap-steps/ai-content.js` logs
    `prompt sent` when `sendKeys` returns, which is not evidence the engine accepted a task;
    closing that needs an engine-aware submission/receipt with duplicate-submission prevention,
    and its acceptance explicitly refuses fixture-only evidence.
- [ ] Chunk 04 — IN PROGRESS. `Type: cumulative-final`, so 21.12's review IS the train final; no
  separate one is run.
  - [x] Car 21.10 — per-rule drift reconciliation in step 3 (#1588). Built 2026-09-19 on
    `feat/train-21-car-21-10`. Build plan and as-built deltas: §4c. MERGED via PR #1646; #1588 is
    closed. The review history is the governance ledger's, not this
    bullet's: an outcome copied here goes stale the next round, and one did — this bullet read
    "0 blocking / 0 warning / 0 note" while a later cumulative round found a blocking defect the
    earlier rounds had not reached.
    - **THREE review rounds, and rounds 2 and 3 were self-inflicted.** Round 1 found the class
      (failure, absence and "nothing changed" sharing one value). Round 2's fix introduced round
      3's defects — the same class, one level down: it split `unmeasured` from `unchanged` and then
      collapsed WHICH SIDE was unmeasured, and it stopped comparing null hashes by demoting whole
      sources, which dropped measured changes. The shape to watch for when touching this code is
      **making a value honest at one level and flattening it at the next.**
    - **Round 2 shipped a green suite containing a test that asserted a bug** — a shared document
      moving `h1` → `CHANGED` with `hasDrift` pinned false. Running the suite could never have
      caught it; only reading the assertion could. Treat a green suite over this module as evidence
      about what could have made it red, nothing more.
  - [x] Car 21.11 — engine parity probes (#1589). **CLOSED 2026-09-20 under an operator scope
    amendment, not by passing its required cases.** What shipped is narrow: the Master pane states
    `{applicable: false, reason}` in the same shape a project launch uses, and the reason is about
    the PANE rather than the engine — Master usually resolves an engine declaring
    `launchSequence.supported: true`, so an engine-derived answer would report "applicable" for
    exactly the pane where it is least true. openclaw needed nothing; its reason was already in its
    engine profile. Acceptance cases 6 and 7 were already shipped by #1650 and were VERIFIED, not
    rebuilt. **Cases 1–5 and 8 were removed from the car, and are neither shipped nor claimed.**
    Aider parity moved to epic #1645. **The certification was CANCELLED BY SCOPE, not blocked** —
    the operator's judgement was that no current downstream consumer needs durable certification.
    Live parity evidence was never the obstacle: the operator accepted **six Codex and three
    Antigravity clean READY launches** for this car. **Nothing is carried forward and nothing is
    owed**: there is no desired state, task or gate for certification on this train or any later
    one, and a revival would need a newly operator-authorized issue with freshly scoped gates. An
    Architect ruling is ARCHIVED at `.tangleclaw/plans/wrap-sequence-architecture.md` §3 (#1720) as
    history rather than as a design on hold; note only that it was **conditional** — existing
    versioned JSON carried the binding solely while it preserved that binding in full — so it should
    not be quoted as an unqualified no-migration answer. Follow-ups filed: #1712, #1713; retention
    was already #1595.
  - [ ] Car 21.12 — ADR 0017 and the doc set (#1590). Built 2026-09-20 on
    `feat/train-21-car-21-12`. Build plan, the measured per-file gap and acceptance cases: §4e.
    `docs/adr/0017-phased-launch.md` states shipped vs desired as a table, per the Architect's
    ruling on #1589, with #1611 and #1623 named there rather than left to inference; it carries R1,
    R2, R3 and the #1650 ruling. `docs/engine-guide.md` gains the attestation / recovery / preflight
    half it was missing entirely. **Bound 4 stands: the draft goes to the Architect BEFORE this
    merges, and this PR does not auto-merge.**
    - **The cumulative-final review declined for want of a subject** (`critic-begin` exit 3: no
      judgeable file — all four paths are records or prose). The plan's own `cumulative-final` is
      satisfied by composition; the **Architect's whole-trajectory review is not, and cannot be
      produced from this branch at any interval**, because every car merged before it was cut. §4e
      carries the proposed disposition — moot rather than discharged, since the operator's scope
      amendment removed the final parity acceptance it was a prerequisite of. **The Architect rules
      on it, not this car.**
    - **`api-contract.md` was named by §4 and does not exist** — not at `docs/`, not anywhere in the
      repo. This car did not create it: standing up a repo-wide API contract doc inside a train car
      would add a documentation surface with a freshness obligation on every route the product
      ships, and nobody committed to maintaining one. Routed to `engine-guide.md` and `FEATURES.md`
      instead, and reported to the ProjectManager. §4e records the decision.
    - **`configuration-reference.md` and `FEATURES.md` needed nothing** — measured, not assumed:
      both were kept current by the cars that built them. Recorded because "update
      `configuration-reference.md`" reads like outstanding work and is not.
  - The car's one class of defect, worth reading before touching the drift path: failure, absence
    and "nothing changed" started as ONE value at every boundary the car added, so every silence
    rendered as the reassuring one. Three distinct values now carry it — `unreadable` vs
    `not-recorded` for a source, `{unavailable}` vs `null` for a whole computation, and
    `measured: false` vs a null hash for a row. A null returned by a reader is not a measurement,
    and two of them must never compare equal.
