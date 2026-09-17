---
title: Train 21 — Engine-Agnostic Phased Launch (blueprint + chunking)
status: APPROVED rev 4 (Architect schema gate satisfied 2026-09-17, v40 + v41, blueprint level). Operator rulings 2026-09-17: R1 RATIFIED; R3 = operator mode.
authorized_by: TangleClaw-ProjectManager, 2026-09-17 (planning only)
source: /Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/TRAIN_21_MICROPLAN.md
review: /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/train-21-builder-schema-review.md
governed_by:
  - .prawduct/artifacts/prime-delivery-direction.md   # ratified 2026-08-31
  - .prawduct/artifacts/wrap-direction.md             # ratified 2026-07-21
  - .prawduct/artifacts/security-model.md
  - .tangleclaw/plans/master-startup-and-wrap.md      # Master startup — excluded here, see §2.9
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
branch: feat/train-21-chunk-01   # the chunk in flight; the gates resolve the active plan by this claim
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
  "status": {"cursor": 1, "ready": false, "recovery": "none|required|cleared", "unready": false},
  "next": "page|step|ready" }
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
4. **Recovery gate on step 4 (v41).** The gate depends on `recovery_mode` and has **no**
   `unready_at` input:
   - `recovery=required` and `recovery_mode=operator` → step 4 is **withheld**:
     `200 {withheld:true, reason, recoveryRevision}`, and nothing is marked served. Only a
     recovery-clear (§2.8) opens it.
   - `recovery=required` and `recovery_mode=advisory` → step 4 **is served**, prefixed with a
     recovery warning block naming the verdict and the reconciliation READY will demand. Recovery
     stays `required` until READY (below).
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
  "worktree": {"path": "/abs", "toplevel": "/abs", "gitDir": "/abs", "branch": "…", "headSha": "…", "dirty": false},  // null for non-git
  "rules": [{"id": 12, "source": "project", "revision": 3, "contentHash": "…"}],
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
| 2 | `identity-mismatch` | file `valid` but `projectId`/`workspaceId` ≠ the launching project | yes |
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
| 15 | **`ok`** (positive) | all of: a **current publication** exists; its identity matches; its `sessionId` **is** the newest prior session; that session is `wrapped` (final) or still-kept `active` (checkpoint); `worktree` is null (no-git, recorded) or its HEAD and branch match | no |
| 16 | `unclassified` | nothing above matched. Examples: a continuity index with no session history and no publications (`baseline = 'empty'`); an `active` newest session with no checkpoint. `reasons[]` lists every predicate that failed | yes |

**Pivot for 5, 6 and 12.** A crash, or a publication-less wrap, is recovered only when a *later*
session produces an eligible, published final. The newest prior session is then that session.

**Workspace unavailable (13).** The registered root's HEAD is reported as **diagnosis only**
(`evidence.fallbackRootHead`). It never turns the verdict into `ok`.

**Non-git project.** `worktree: null`, so 13–14 are recorded as `skipped: no-git`, and 15 accepts them only with that recorded skip.

**Migration boundary.** When v41 runs, it writes one `project_handoff_epoch` row per project:

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

Legacy acceptance ends permanently at the first session after the epoch: from then on a lost
handoff is 9 or 10, never 7.

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

**v41 columns on `launch_sequences`:**
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
| Master pane | unchanged | — | `not-applicable`: governed by `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/master-startup-and-wrap.md`; follow-up filed |

Behaviour is chosen from declared capabilities (`supportsSilentPrime`, `startupInjection`, new
`toolOutput.maxChars`, new `launchSequence: supported|unsupported` with a reason). There are no
engine-name branches.

### 2.10 Retention (B7)

- `launch_sequences`, `launch_sequence_steps`, `handoff_publications` and `project_handoff_epoch`
  use logical references and are **kept** when a session or project is deleted, like the delivery
  ledgers.
- Train 21 adds no DB pruning. Growth per launch is `4 + 3·(revisions − 1)` step rows (one more
  if step 1 is re-rendered), each holding up to `page_count × page_budget` characters of frozen
  content. It is typically ~30 KB, more under rule churn.
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
- **§3** (presence delivered) — **conforms while `pasteRules=paste`**. The amendment is *proposed*
  (R1) and is recorded and ratified before 21.6 changes any default.
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
- **21.4** (#1582) `tc start ready` + `tc.ready/1` validation (server-owned verdict, duplicate/conflict/ended cases) + snapshot revision on rule change
- **21.5** (#1583) unready window + single nudge (durable counters) + dashboard readiness/evidence panel (`public/`, worktree). **Refs #1176, does not close it.**
- **21.6** (#1584) `launchSequence.pasteRules: paste|pull`. R1 was ratified 2026-09-17, so this PR writes the dated amendment into `prime-delivery-direction.md` §3 **and** flips the default to `pull`, together.
- **Acceptance cases:** restart under a changed rule set → `SNAPSHOT_REVISED`; step 1 carried over only on byte-equal content; READY with a wrong verdict; duplicate vs conflicting READY; READY after the session ended. Visual change: yes → VRF entry.

### Chunk 03 — Handoff, preflight, recovery (v41)
- **21.7** (#1585) `tc.handoff/1` + the `handoff-stage` wrap step + `publishHandoff`/`abandonHandoff` (exact-attempt) in `_runClaimedWrap` + `handoff_publications` + `history/` + an ADR 0002 contract update. `store.sessions.wrap` gains the `{publicationId}` binding (the same transaction as the lifecycle transition).
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
- **21.11** (#1589) engine parity probes (codex, aider, antigravity) + honest `not-applicable` for openclaw and Master + follow-ups (Master phased launch; delegated clearing; retention setting)
- **21.12** (#1590) docs: ADR 0017 "Phased launch", `api-contract.md`, `engine-guide.md`, `configuration-reference.md`, CHANGELOG. The R1 amendment is **not** here: it lands with 21.6.

Governance checkpoints: after Chunk 01 (does the single renderer and frozen snapshot hold?) and after
Chunk 03 (a whole-trajectory review before parity).

---

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
- [ ] Chunk 02
- [ ] Chunk 03
- [ ] Chunk 04
