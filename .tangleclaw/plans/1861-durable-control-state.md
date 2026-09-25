---
branch: fix/1861-durable-control-state
partition: serial for chunks 01–03 and 05–06 (they share lib/store.js, server.js and lib/control-state.js); chunk 04 (managed hooks) touches only new files and consumes chunk 02's /api/control/check contract
---

## Status

*Bookkeeping above the approved plan. The approved rev 3 body starts at the first `#` heading below and is byte-identical to SHA-256 `5bab73b8…` (Architect release `d02b4524`, 2026-09-25). Built on `fix/1861-durable-control-state` from `origin/main` @ `e66f5620`; upstream changes since the design baseline `4dff1bde` were plan files only (#1851, #1852).*

- [x] Plan written; Architect rulings R1 and R2 incorporated (rev 3)
- [x] Implementation released by the Architect ("#1861 IMPLEMENTATION RELEASED")
- [x] Chunk 01: v48 schema, append-only triggers, `lib/control-state.js`, unit tests
- [x] Chunk 02: `/api/control/*`, operator proof tier, authority, ack/status, `tc control`, capabilities line
- [x] Chunk 03: `lib/control-gate.js`, admission capture, wiring at every §4 boundary, per-surface tests
- [x] Chunk 04: `lib/control-hooks.js` and the governed marker (STOP at the A5 escalation clause if a constraint cannot be met)
- [ ] Chunk 05: `docs/control-state.md`, FEATURES, CHANGELOG, operational-guide line
- [ ] Chunk 06: E2E exit test on an isolated instance
- [ ] Verify: focused tests plus the full suite on this worktree (**not** the main instance)
- [ ] Cumulative Critic
- [ ] Draft PR opened. **STOP here**: the PM owns readiness and merge sequencing

**Scope (Architect release):** no merge, auto-merge, live checkout/database/process mutation, live sync, restart, deploy, tag, release, destructive-data action, policy change, or work on #1865.

# #1861 — Durable HOLD/STOP control state (Car A1): plan and design

**Issue:** [#1861](https://github.com/Jason-Vaughan/TangleClaw/issues/1861) (OPEN; includes the criteria carried over from #1862)
**Train:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/dual-builder-normalization-train.md` → Chunk A, Car A1
**Plan (canonical):** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Pilot-B2/.tangleclaw/plans/1861-durable-control-state.md` · operator link https://cursatory.tail123678.ts.net:8443/plans/96/1861-durable-control-state.md
**Owner:** TangleClaw-Pilot-B2 Builder (project 96, workspace `tangleclaw-pilot-b2-5f5e9032`, launch `kKGpLw-3ctj9UG2-k-4K1w`) · **Baseline:** `main` @ `4dff1bde`
**Status:** PLAN, **rev 3**. It includes Architect rulings R1 (A1–A9 decided; message `20d836ae`) and R2 (N1–N5 decided; message `ea51c2ff`). **Implementation stays on HOLD** until the Architect replies "#1861 IMPLEMENTATION RELEASED". No commit, push, PR, merge, restart or live mutation has been made.

**Provenance.** Rev 1 was written by a background planning job, session `5499b208`. That job ran under the ProjectManager's launch env (project 74), in an ephemeral worktree that was later deleted. It was restored verbatim, SHA-256 `4a042074…`. For rev 2, the registered B2 session checked every code reference itself against `4dff1bde` (§1), adopted the plan, and applied R1. Rev 3 applies R2. Changes are listed in §9.

---

## 1. What exists today (re-verified by B2 against `main` @ 4dff1bde)

Code references use `file#symbol` anchors, not line numbers.

| Fact | Evidence |
|---|---|
| No HOLD, STOP, pause or lease record exists. The nearest precedents are `config.wrapDisabled`, checked only at the wrap-start route, and the wrap-cancel seam `wrapRunRegistry.admitStep`, which returns `'proceed'`/`'cancelled'` at each pipeline step boundary. | `server.js` `POST /api/sessions/:project/wrap`; `lib/wrap-run-registry.js#admitStep`; `lib/wrap-pipeline.js` (the `options.admitStep` call) |
| No role, assignment or job record exists. The launch digest says so explicitly ("TangleClaw has no first-class role or assignment record"). | `lib/startup-prompt.js` (role+assignment revision doc comment) |
| Identity is unstable across replacement. Each launch gets a new `sessions.id` and a new launch id (`launch-sequence#mintLaunchId`). The Medusa workspace id is re-minted per launch. Only `project_id` survives. `store.sessions.getActive(projectId)` assumes one active session per project. | `lib/sessions.js#launchSession`; `lib/launch-sequence.js` |
| Medusa bodies live in the external Hub. TangleClaw keeps an in-memory inbox per listener, plus the `medusa_deliveries` nudge ledger. | `lib/medusa-listener.js` header; `lib/store.js` `medusa_deliveries` DDL |
| **`/medusa/send` does not authenticate the caller.** The route resolves its sender from the **URL project name** (`resolveProjectMedusaTarget` → `getActive(project.id)`) and reads only `{to,message}`. No launch binding is checked. This is how a project-74-bound process posted as project 96 on 2026-09-25. | `server.js#resolveProjectMedusaTarget`, `registerMedusaRoutes`; comment above `sharedDocNoticeOf` |
| Caller identity comes from `shared-docs-access#resolveAccess`, which returns `operator`, `project` (verified launch, matching project, **active** session), `master`, `unbound` (no launch header) or `invalid`. | `lib/shared-docs-access.js#resolveAccess` |
| **Operator identity depends on the auth gate.** `_isOperator` accepts `req.tcSession`. When the gate stands down (`open`/`fallback`), it *also* accepts any request that is browser-shaped or carries `x-tangleclaw-client: dashboard`, which a local process can forge. This install is `authEnabled: true` (gate armed). | `lib/shared-docs-access.js#_isOperator`; `lib/auth-gate.js#standsDown`; `server.js` (`req.tcGateActive`) |
| **Restart and update read no caller identity.** `POST /api/server/restart`, `/api/update/apply` and `/api/update/check` ignore `req`. | `server.js` restart route; update routes |
| Schema is v47 (`CURRENT_SCHEMA_VERSION`). New tables use the DDL in `_createTables` plus the `if (currentVersion < N)` migration pattern. | `lib/store.js` |
| `tc` has no verb that mutates git, PRs, deploys or the server. Its verbs are `message` and `start` subverbs plus read-only verbs. | `lib/tc-verbs.js` |
| TangleClaw-owned mutation points: wrap `commit` step (`git add`/`git commit` in the commit routine; `_autoPrCloseLoop` runs `git push`, `gh pr create`, `gh pr merge --auto`); `pr-merge` step (`_ensurePushed` push, `defaultEnqueueAutoMerge`); stranded-wrap `_openPr` (`gh pr create`); `update-applier#_moveToTag` (`git checkout <tag>`); restart `execSync`; `sessions#injectCommand`. | `lib/wrap-steps/commit.js`; `lib/wrap-steps/pr-merge.js`; `lib/stranded-check.js`; `lib/update-applier.js`; `server.js` |
| Nothing in TangleClaw runs `gh pr ready`, `git tag` or `gh release`. Tagging and release run in `.github/workflows/release.yml`. Live sync is a manual shell pull followed by `POST /api/server/restart`. | grep; `release.yml` |
| The existing Git hook installer (`lib/git-hooks.js`, `commit-msg` only) **skips worktrees** because it needs `.git` to be a real directory. It **refuses** to write when a foreign hook is present; it does not chain. It ignores `core.hooksPath`. | `lib/git-hooks.js#_hookPath`, `installCommitMsgHook` |

**What this means for the incident.** The unauthorized push on 2026-09-25 was by every indication a direct shell `git push`/`gh` call. A server-side gate would not have stopped it. The acceptance test A1 can honestly pass is: *a queued HOLD blocks the next **TangleClaw-governed** mutation before the agent reads it.* The managed hooks (A5) narrow the shell gap but do not close it (§5).

---

## 2. Design (per R1)

### 2.1 Identity (R1-A1)

- **`assignment_id`**: an opaque id issued by TangleClaw. **At most one open assignment per project** in A1. There is no same-project multi-lane support and no `lane_key` column.
- The assignment stores its target `project_id` and the **current binding** (`bound_session_id`, `bound_launch_id`).
- A successor rebinds only through the supported launch path. Rebinding appends an audit event, and the **old launch fails authorization** from then on, because authorization compares against `bound_launch_id`.
- **Every wrap run and background job captures `assignment_id` when it is admitted**, and checks *that* assignment at every gate. A later assignment never authorizes an older job. If a job was admitted with no assignment and one is created afterwards, the gate *also* consults the project's current assignment. A new assignment **can only tighten an older job, never authorize it.**

### 2.2 Store and audit (R1-A2): TangleClaw SQLite, schema v48

Four tables. Only the first two are mutable, and both are caches written in the same transaction as the event that changes them.

- **`control_assignments`**: the current-state cache. It holds:
  - `assignment_id` (PK), `project_id`, `issue_ref` (bounded)
  - `authority_json`: the authority matrix (§2.3)
  - `bound_session_id`, `bound_launch_id`
  - `state` (`active | held | stopped | closed`), `state_generation`
  - `created_by_kind`, `created_at`, `stopped_at`, `closed_at`
  - A partial UNIQUE index on `project_id WHERE closed_at IS NULL` enforces one open assignment per project.
- **`control_holds`**: the active-hold cache. It holds `hold_id` (= the HOLD's event id), `assignment_id`, `issuer_principal`, `opened_generation`, `released_generation` (NULL while active) and `released_by_event_id`. Effective state is `held` whenever any row has `released_generation IS NULL`.
- **`control_events`**: **immutable**, append-only state history. Rows are never UPDATEd; this is enforced by a trigger that raises on UPDATE/DELETE, and a test covers it. It holds:
  - `event_id` (PK, opaque), `seq` (INTEGER AUTOINCREMENT, which is the audit order)
  - `assignment_id`
  - `kind` (`create | hold | release | stop | close | rebind`)
  - `state_generation`: the value after this event. Only `create`, `hold`, `release` and `stop` increment it. `close` and `rebind` record the unchanged value.
  - `issuer_principal`, `reason_code` (bounded enum)
  - `request_id`: the idempotency key, UNIQUE per assignment
  - `expected_generation`, `target_hold_ids_json` (release only), `created_at`
- **`control_receipts`**: immutable, append-only delivery and acknowledgement facts. It holds `receipt_seq` (AUTOINCREMENT), `event_id`, `fact` (`notify_pending | notify_attempted | observed | acknowledged | exchange_closed`), `outcome_code` (bounded; reuses the wake ledger's codes), `actor_principal` and `at`. **Receipts never change `state_generation`.**

State generation and receipt ordering are separate sequences. Replaying `control_events` in `seq` order rebuilds both caches exactly. A test covers this.

### 2.3 Semantics and authority (R1-A3)

- **Principals** are `operator` or `project:<id>`. Only a principal that `resolveAccess` verifies counts (§2.6). Role names, workspace prefixes, a Medusa `from`, or a connected listener grant nothing.
- **Authority matrix** (`authority_json`, set at creation, operator-only):
  - `hold: [principals]`
  - `stop: [principals]`
  - `lifecycle: [principals]`, for close
  - `releaseDelegations: { "<releaser>": ["<hold-issuer>", …] }`
  - The operator is implicitly in every list. The target project is never in `stop`, `lifecycle` or any release list.
- **HOLDs are cumulative.** Each accepted HOLD opens a new `control_holds` row with a stable `hold_id` and increments `state_generation`. A duplicate HOLD with the same `request_id` returns the original result. A HOLD with a new `request_id` opens another hold, even from the same issuer.
- **RELEASE** names `holdIds[]` and supplies `expectedGeneration`. It is accepted only if all of these hold:
  - (a) `expectedGeneration === state_generation`; otherwise `409 STALE_GENERATION`, with the current generation and active hold ids.
  - (b) every named hold is active; otherwise `409 HOLD_NOT_ACTIVE`.
  - (c) the releaser may release every named hold: the operator may release any hold; any other principal may release only holds it issued itself, or holds of an issuer it is explicitly delegated for.

  The PM and the Architect **cannot** clear each other's holds by role. A release clears only the holds it names. Effective state stays `held` while any hold remains.
- **Target Builder.** It never releases anything on its own assignment and never stops it. It **may self-HOLD**. Only the operator or a delegated non-target releaser clears that hold.
- **STOP** can come from the operator or a principal listed in `stop`. It is terminal: nothing clears it, and RELEASE gives `409 ASSIGNMENT_STOPPED`. A stopped assignment **keeps governing the project** (gates answer `423 CONTROL_STOPPED`, and an ordinary new-session launch is refused, §2.8). **The only A1 restart path** is an operator-created successor assignment, which **atomically supersedes** the stopped one in the same transaction. A STOP can never become an ungoverned project. (R2-N4)
- **Close** (R2-N4) is allowed only for an **ACTIVE** assignment with **zero active holds**, by the operator or a listed lifecycle authority. Close on a held assignment gives `409 ACTIVE_HOLDS`. Close on a stopped assignment gives `409 STOP_TERMINAL`.
- **Creation** is operator-only in A1, including the successor after a STOP.
- **Operator proof tier** (R2-N1). The `_isOperator` boolean is not sufficient proof for an operator-only control mutation (create, change authorities, release another principal's hold, stop, close). A new `control-state#operatorProof(req)` resolves and **audits** a tier on every event:
  - `verified-session`: `req.tcSession` exists, in any gate state (a valid session during fallback included). Accepted. Required whenever the gate is `armed`.
  - `ambient-open`: the gate state is `open` (auth deliberately disabled). Accepted for compatibility. Every event and status reports `operatorAuthority: ambient-open`, and the docs state it is not authenticated.
  - `external-fallback`: the gate is in `fallback` (TangleClaw stood down behind Caddy) with no `tcSession`. **Refused** with `503 CONTROL_OPERATOR_UNVERIFIABLE`: a loopback process can forge the dashboard header and bypass Caddy.
  - All other states without a `tcSession` (`armed`, `locked`, `account-required`, `unreadable`) are not the operator. `unreadable` answers `503 CONTROL_OPERATOR_UNVERIFIABLE` (fail closed). The rest answer `403`. *(B2 mapping of the gate states R2 did not name; stated here for Architect visibility.)*
  - `x-tangleclaw-client: dashboard` or browser shape **alone** never authorizes a control mutation. Read-only status stays under the existing access policy.
- **Peer prose is never parsed.** An ordinary Medusa message saying "stop" has no control effect.

### 2.4 Gating (R1-A4)

New `lib/control-gate.js`, entry point `checkMutation({ surface, subject })`. It reads the database directly and never the inbox, the wake ledger or the listener.

- **Subjects.** The gate checks the *mutation subject*, not merely the caller:
  - `{kind:'job', assignmentId|null, projectId}`: a wrap run, the stranded-wrap PR, queued auto-PR or auto-merge work. The assignment is captured at `wrapRunRegistry.begin` and carried on the run. The captured assignment is checked; the current one is also checked, and can only tighten (§2.1).
  - `{kind:'target', projectId}`: command injection into a pane.
  - `{kind:'caller', access}`: caller-owned global requests, **only** `POST /api/server/restart` and `POST /api/update/apply` (R2-N2). `GET /api/update-status` and `POST /api/update/check` are not governed mutations and are not gated. Outcomes:
    - A bound caller whose own assignment is held or stopped gets the normal `423`.
    - A bound caller whose assignment is clear is allowed, even while another lane is held.
    - A verified operator (per the N1 proof tier) is allowed.
    - An `unbound`/`invalid` caller, while **any** open assignment is held or stopped, gets `423 CONTROL_CALLER_UNATTRIBUTABLE`.
    - `force:true` never bypasses any of these.
    - The PM's live-sync client must send its own verified launch and project headers.
- **Outcomes:**
  - `allow`
  - `423 CONTROL_HELD`, `423 CONTROL_STOPPED`
  - `503 CONTROL_STATE_UNAVAILABLE`: the store throws, or the subject is governed and its assignment row cannot be read.
- **Ungoverned default.** No assignment means pass, for compatibility. A governed launch records its `assignment_id` durably on the launch record, so a store failure fails closed **only** for governed subjects.
- **Re-read at the final boundary.** Each gate re-reads current state immediately before the side effect. No cached allow is reused across a side effect.
- **Command injection on HOLD** into the target is refused, except for:
  - the control notice
  - the status and ack path
  - the guarded mechanism that communicates the hold (the ordinary Medusa wake nudge)

  Nothing is inferred as read-only from command prose.

### 2.5 Notification and acknowledgement (criterion 6, R1 amendment 6)

- **Accepted means stored.** In the **same transaction** as the control event, a `control_receipts` row `notify_pending` is written. Only then does the response return.
- The Medusa system notice (`medusa.sendSystemMessage`, body `{event:'control_changed', assignmentId, stateGeneration, state}`) is attempted **after** commit. Its outcome is appended as `notify_attempted`. **A delivery failure never rolls back control.**
- **Observed** is recorded when:
  - the target hits a gate refusal,
  - the target reads its own status with a verified launch, or
  - the target marks the notice handled.
- **Acknowledged** is recorded when the target's verified launch POSTs `ack` with the generation.
- **Exchange closed** is recorded when the issuer closes the exchange.
- **Released and stopped** are events, not receipts.
- The status view shows bounded codes and timestamps only. Silence shows as `notify_attempted / not observed`, never as compliance.
- **Ordinary Medusa is unchanged.** Any priority wake belongs to #1839.

### 2.6 API exposure (R1-A8, A9)

- **Routes:** experimental `/api/control/*`, internal but documented.
  - `POST assignments` (operator only)
  - `POST assignments/:id/{hold,release,stop,close,ack}`
  - `GET assignments/:id` (status)
  - `GET mine` (the caller's own assignments)
  - `GET check?assignmentId=`: a minimal read-only answer (`state`, `stateGeneration`) for the managed hooks.
- **Authorization** for every non-operator command requires a `resolveAccess` result of `project` (a verified *active* launch, with the project claim matching) **and** assignment-specific authority. The target's launch must also equal `bound_launch_id` for `ack` and for gate attribution. A service token, a URL project name or a Medusa route is **not sufficient**, and the Medusa route-derived sender model is not reused.
- **`tc control status|ack|hold|release|stop`**, plus a `tc capabilities` line. `tc` prints a one-line `HELD (gen N, k holds)` banner on any verb when the caller's assignment is held. This is visibility, not enforcement.
- **Codes:**
  - `423 CONTROL_HELD`, `423 CONTROL_STOPPED`, `423 CONTROL_CALLER_UNATTRIBUTABLE`
  - `503 CONTROL_STATE_UNAVAILABLE`, `503 CONTROL_OPERATOR_UNVERIFIABLE`
  - `409 STALE_GENERATION`, `409 ASSIGNMENT_STOPPED`, `409 HOLD_NOT_ACTIVE`, `409 ASSIGNMENT_OPEN` (a second open assignment), `409 ACTIVE_HOLDS`, `409 STOP_TERMINAL`
  - `403 CONTROL_UNAUTHORIZED`
  - `400 CONTROL_MALFORMED`

  Bodies may carry `assignmentId`, `stateGeneration` and `activeHoldIds`. They never carry raw commands, paths, secrets or free-text reasons.

### 2.7 Managed hooks: defense in depth, never called enforcement (R1-A5, option b)

New module `lib/control-hooks.js`, deliberately separate from `lib/git-hooks.js` so the `commit-msg` installer's contract is unchanged.

- **Machine-local governed marker.** The marker is `$(git rev-parse --git-dir)/tangleclaw-control.json`, which holds `{assignmentId, api}`. `--git-dir` is **per-worktree** for linked worktrees, untracked, and never committed. It is written when a governed launch starts in that checkout or worktree, and removed on close or ungoverned relaunch.
- **Hook location.** Hooks go in `git rev-parse --git-path hooks`, which honours `core.hooksPath` and resolves linked worktrees to the common hooks dir. The installed `pre-commit`/`pre-push` finds its own worktree's marker at run time. **No marker means the hook only runs any chained hook and exits with that hook's status.** Ungoverned repos and worktrees are therefore unchanged.
- **Governed checkout.** The hook calls `GET /api/control/check`. `held`/`stopped` → exit 1 with the code. API unreachable or unreadable → **exit 1 (fail closed), for governed checkouts only.**
- **Foreign hooks are preserved and chained, never overwritten** (R2-N3). An existing non-TangleClaw hook moves to `<hook>.tc-chained` behind a TangleClaw dispatcher, with these safeguards:
  - **Preserved exactly.** The `lstat` type, the bytes (regular file) or link target (symlink), and the mode are kept. A fingerprint (type, SHA-256 or link target, mode) is recorded in a TangleClaw-owned sidecar next to the marker.
  - **Transactional install.** Stage the dispatcher to a temp file, `rename` the foreign hook to `.tc-chained`, then `rename` the dispatcher into place. Every failed step rolls back fully to the original state. An existing `.tc-chained` that the sidecar does not explain is a **collision**: install refuses and changes nothing.
  - **Dispatcher.** It is TangleClaw-marked. It runs the control check first. On pass it `exec`s the chained hook with the original args and stdin, so the chained hook's exit status and signal semantics are the hook's own.
  - **Refresh** is idempotent.
  - **Uninstall** restores only when the dispatcher is TangleClaw-owned *and* `.tc-chained` still matches the recorded fingerprint. Otherwise it refuses with exact recovery instructions and never overwrites edits.
  - **Tracked hooks directory.** When `core.hooksPath` points inside the work tree (a tracked dir such as `.husky/`), TangleClaw never modifies it. That checkout reports `controlHook: UNPROTECTED (tracked hooksPath)` in status and `tc control status`. There is no silent fallback.
- **Documented bypasses:** `--no-verify`, changing `core.hooksPath`, deleting or editing the hook or marker, `GIT_DIR` tricks, `gh`/`curl` straight to the GitHub API, and the shared operator credentials. There is no engine PreToolUse control guard in A1.
- **Escalation clause.** If any A5 constraint cannot be met without redesigning `lib/git-hooks.js`, the Builder stops and sends a scoped design escalation. There is no fallback to overwriting and no fallback to option (a).

### 2.8 Restart, successor and retention (R1-A6); break-glass (R1-A7)

- SQLite state survives restart.
- A wrap does not close the assignment.
- A same-project successor inherits an **active or held** assignment only through the supported launch path, which appends a `rebind` event. It sees `HELD` in its launch context before any work, and the old launch then fails authorization.
- **Launch into a STOPPED project is refused** with `423 CONTROL_STOPPED` until the operator creates a successor assignment (R2-N4). The operator inspects control status from the dashboard or API without starting the stopped Builder. A session already running when STOP lands stays gated and notified. A1 does not claim to terminate a shell or process.
- Events and receipts are kept indefinitely.
- `close` follows §2.3: an ACTIVE assignment with no holds only, by the operator or a lifecycle authority. It never erases audit.
- **No override endpoint.** The audited recovery contract is:
  - an operator RELEASE of named holds, with `expectedGeneration` and a bounded reason code;
  - after a STOP, an operator-created new assignment.

  There is no bypass for any individual surface.

---

## 3. Acceptance criteria → code ownership → tests

Legend: **S** = enforced server-side at TangleClaw-owned paths; **V** = visibility only; **H** = managed hook (bypassable); **—** = not enforceable in A1.

| # | Criterion | Code ownership | Enf. | Tests |
|---|---|---|---|---|
| 1 | Durable record stored before "accepted", including the `notify_pending` fact | `lib/store.js` (v48 DDL, migration, triggers, `store.control`); `lib/control-state.js` (pure state machine) | S | `test/control-state.test.js`; `test/store-control-migration.test.js` (v47→v48 postconditions, fresh install, UPDATE/DELETE on `control_events`/`control_receipts` raises) |
| 2 | Control separate from correspondence | `lib/control-state.js`; `server.js` `/api/control/*`; `lib/medusa.js` unchanged except the system-notice call | S | `test/api-control.test.js`: a peer message "STOP now" leaves state unchanged. `test/api-medusa.test.js` passes unmodified. |
| 3 | Authority from the assignment matrix, not names | `lib/control-state.js#authorize` over `resolveAccess` | S (supervised grade; see N1) | `api-control`: rejects an unauthorized peer, a spoofed role name, a workspace-prefix look-alike, a stale or ended launch, a launch that is not `bound_launch_id`, and a malformed, negative or non-integer generation. **Impersonation regression (R1 amendment 5):** a caller bound to project 74 posting to the project-96 control route, and a project-74 launch presented with a `x-tangleclaw-project-id: 96` claim, both get `403`/`invalid`, with state unchanged. A Medusa message "from" a listed authority has no control effect (#1865 stays open; control does not depend on it). **Operator proof tier (R2-N1):** with a `tcSession`, accepted as `verified-session` in `armed` and in `fallback`. Gate `open` ⇒ accepted, and the event and status carry `ambient-open`. `fallback` with no session ⇒ `503 CONTROL_OPERATOR_UNVERIFIABLE`. `unreadable` ⇒ 503. `armed` with the forged dashboard header ⇒ 403. A dashboard header alone never creates, releases, stops, closes or changes authorities. |
| 4 | Newest valid generation wins; duplicates idempotent; out-of-order converges | `lib/control-state.js` (`BEGIN IMMEDIATE`, CAS) | S | GO g1 → HOLD g2 → delayed RELEASE(expected g1) ⇒ `409 STALE_GENERATION`, still held. Duplicate HOLD and duplicate RELEASE (same `request_id`) are no-ops. Permuted delivery of a fixed request set converges. |
| 4b | **Cumulative holds (R1 amendment 2)** | `control_holds` | S | PM HOLD and Architect HOLD both active. The PM releases its own ⇒ still held on the Architect's. The Architect releasing the PM's hold without delegation ⇒ 403. The operator releases the rest ⇒ active. Each issuer can release its own hold in either order. |
| 4c | **Immutable events, state generation separate from receipts (R1 amendment 3)** | `control_events`, `control_receipts` | S | Notify, observe and ack receipts leave `state_generation` unchanged. Receipt `seq` advances independently. An UPDATE on an event row raises. Replaying events rebuilds both caches. |
| 5 | Delivery is not enforcement | `lib/control-gate.js` (database only) | S | Wake adapter stubbed to fail (`inject-failed`, `turn-in-flight`, `wrap-running`), listener down or Hub unreachable ⇒ the gate still refuses. |
| 6 | Acknowledgement visible | `lib/control-state.js`, status route, `lib/tc-verbs.js` | V | Facts appear in order: `notify_pending` (in the same txn), `notify_attempted`, `observed`, `acknowledged`, `exchange_closed`. A notice-send failure leaves the event committed with `notify_attempted(outcome=failed)`. The payload has no command, path or secret (secret-scan-style assertion). |
| 7 | Bounded release; no self-clear; STOP terminal; close rules | `lib/control-state.js` | S | A target-issued RELEASE ⇒ 403. A target self-HOLD is accepted, but the target cannot release it. RELEASE after STOP ⇒ `409 ASSIGNMENT_STOPPED`. **Close (R2-N4):** held ⇒ `409 ACTIVE_HOLDS`; stopped ⇒ `409 STOP_TERMINAL`; active with no holds, by the operator or a lifecycle authority ⇒ closed; by anyone else ⇒ 403. An operator successor to a stopped assignment supersedes it atomically (one txn; the old assignment is never observed ungoverned) and starts at generation 1 under a new id. A non-operator create ⇒ 403. |
| 8 | Fail-closed governed surfaces | `lib/control-gate.js` at each §4 boundary | S at TangleClaw-owned paths | Per surface: refused *before* the first side effect (fake `_internal.exec` records zero git/gh calls). Store throws ⇒ `503`, working tree untouched. |
| 8b | **Old job / new assignment, and background subject gating (R1 amendment 4)** | `wrap-run-registry` captures the assignment; `control-gate` `job` subject | S | A wrap admitted under assignment X; X stopped; Y created ⇒ the wrap's next boundary is refused. A job admitted with no assignment; a HOLD assignment then created ⇒ refused (tighten-only). A stranded-wrap PR and queued auto-merge for a held project are refused. **Caller gate (R2-N2), for both `POST /api/server/restart` and `POST /api/update/apply`:** omitted headers while any assignment is held ⇒ `423 CONTROL_CALLER_UNATTRIBUTABLE`. Mismatched or stale launch headers ⇒ the same. A clear PM (bound, its own assignment clear) ⇒ allowed. A held Builder ⇒ `423 CONTROL_HELD`. A verified operator ⇒ allowed. `force:true` never bypasses any of these. `GET /api/update-status` and `POST /api/update/check` are unaffected while held. |
| 9 | Honest enforcement boundary | `docs/control-state.md` (new), `lib/engines.js` guide line | — / H | A doc test asserts the guide and doc state the shell limit and list the bypasses. |
| 9h | Managed hooks (A5) | `lib/control-hooks.js` (new) | H | `test/control-hooks.test.js`, using real temp repos: two linked worktrees, only one governed ⇒ only it is blocked. A foreign `pre-commit` and `pre-push` are chained and restored byte-for-byte on uninstall. Install, refresh and uninstall are idempotent. With TangleClaw unreachable, a governed checkout fails closed and an ungoverned one passes. HOLD blocks; RELEASE allows; STOP blocks. A tracked `core.hooksPath` is not written and reports `UNPROTECTED`. **Chaining safeguards (R2-N3):** a regular-file foreign hook (bytes and mode preserved); a symlink foreign hook (link target preserved, not dereferenced); a pre-existing unexplained `.tc-chained` ⇒ refused, nothing changed; interrupted install, with a fault injected at each step ⇒ full rollback to the original; a chained hook modified after install ⇒ uninstall refuses with recovery instructions, nothing overwritten; args and stdin forwarded byte-exact (pre-push ref lines); the chained hook's exit status and signal death are propagated. |
| 10 | Audited recovery (reconciled, R1 amendment 7) | `lib/control-state.js` | S | **There is no override endpoint** (a route-table assertion). An operator RELEASE of named holds needs `expectedGeneration` and a reason code, and is recorded. An old GO or RELEASE is never treated as recovery. After a STOP, only a new operator assignment resumes work. |
| #1862-a | HOLD during a long tool call ⇒ the next governed mutation is refused before side effects | gates in `commit.js` before each exec, and at `admitStep` | S | A HOLD inserted after the commit step is admitted but before `git commit` ⇒ zero git calls. A HOLD inserted before `gh pr merge --auto` ⇒ push done, no merge armed; the partial outcome is reported. |
| #1862-b | Isolation | the assignment is per project (one open per project) | S | A HOLD on project A's assignment leaves project B's wrap, commit and PR path allowed. Same-project multi-lane is **not supported** in A1. |
| #1862-c | Restart preserves state | SQLite | S | Close and re-init the store ⇒ same state, generation and active holds. The successor rebind test: the old launch gets 403, and the new launch sees `HELD` in its launch context. |
| #1862-d | Sender sees sent → delivered → acknowledged | status route | V | row 6 |
| #1862-e | Enforce server-side or revoke the lease | `sessions#launchSession` gate plus the mutation gates | S | **Ordinary launch into a STOPPED project ⇒ `423 CONTROL_STOPPED`, no session created (R2-N4).** Operator control status stays readable without launching. After an operator successor assignment, the launch succeeds and rebinds. A session already running when STOP lands gets 423 on every governed mutation and a notice. |
| Exit | Isolated failure test | integration | S | `test/control-e2e.test.js`: real temp store and repo, listener stubbed with the notice unread, HOLD ⇒ wrap refused with no commit. Isolated instance only, never the live server. |

---

## 4. Final-mutation boundaries: where `checkMutation` goes

| Surface | Final boundary | Subject | A1 |
|---|---|---|---|
| Wrap start | `POST /api/sessions/:project/wrap`, beside `wrapDisabled` | job (captured at `begin`) | S |
| Wrap in flight | `wrapRunRegistry.admitStep` gains a `'held'` answer, re-checked at every step boundary. Inside `commit.js` it is re-checked immediately before `releasePrepareCommand`, `git checkout -b`, `git add`, `git commit`, and each of `_autoPrCloseLoop`'s `git push`, `gh pr create` and `gh pr merge --auto` | job | S |
| pr-merge step | `pr-merge.js#_ensurePushed` push; `defaultEnqueueAutoMerge` | job | S |
| Stranded-wrap open PR | `stranded-check.js#_openPr` before `gh pr create` | job (the project's current assignment) | S |
| Self-update | `POST /api/update/apply` → `update-applier.js#_moveToTag` (not `update-status`/`update/check`) | caller (R2-N2) | S for HTTP. `scripts/apply-update.js` is shell (—) |
| Server restart | `POST /api/server/restart` before `execSync`; `force:true` does not bypass | caller (R2-N2) | S |
| Command injection | `sessions#injectCommand` via `/command`, `startup-prompt/fire`, `actions/:command`, launch kickoff; control notice and wake nudge exempt | target | S |
| New launch | `sessions#launchSession`: refuses when STOPPED (R2-N4); otherwise records `assignment_id`, rebinds, and shows HELD | (lifecycle) | S |
| `gh pr ready`, manual `gh pr merge`, `git tag`, `gh release`, deploy | not TangleClaw code | — | **—** (B3; credentials) |
| Direct `git commit`/`git push` | shell | — | **H** (§2.7) |
| Manual live-sync `git pull` | shell | — | **—** (only the restart half is S) |

---

## 5. What cannot be enforced against arbitrary direct shell commands (criterion 9)

1. **Any `git`/`gh` command an agent runs in its own shell bypasses every server-side gate.** That covers commit, push, `pr create/ready/merge`, `tag` and `release`. This is the incident's class of action.
2. **The managed hooks narrow the gap but do not close it.** `--no-verify`, `core.hooksPath` changes, deleting or editing the hook or marker, `GIT_DIR` tricks, and `curl`/`gh` straight to GitHub all bypass them. `gh pr merge/ready` and `gh release` have no local Git hook at all. A tracked `core.hooksPath` leaves a checkout visibly unprotected.
3. **Credentials are shared.** Builders run as the operator's OS user with the operator's `gh` token. Only branch protection with a TangleClaw-posted required status, or restricted per-Builder tokens, would stop GitHub-side mutation. Both are out of A1's scope.
4. **Principal attribution is supervised-grade.** A launch id is a bearer value in the pane environment. On an install whose auth gate is `open`, the operator is `ambient-open`: unauthenticated by design, and reported as such. On `fallback`, an operator-only control mutation needs a real `tcSession`, and is otherwise refused (R2-N1).
5. **Medusa's route-derived sender stays unauthenticated.** A1 does not fix `/medusa/send`; that is [#1865](https://github.com/Jason-Vaughan/TangleClaw/issues/1865). A1 guarantees that control never trusts it.
6. **The accurate claim:** *HOLD is durable and authoritative. Every TangleClaw-owned mutation path refuses it before side effects. The agent is shown it at its next `tc` call, gate refusal, or managed-hook refusal. Direct shell mutation remains a trust boundary.*

---

## 6. Out of scope for A1

- #1839: priority wake and escalation.
- #1806: mail across wrap and replacement.
- #1717/B3: inbox read before merge; auto-merge disarm when control changes. A1 refuses *arming* only inside TangleClaw's own wrap paths.
- #1578: hierarchy and same-project multi-lane.
- #1400: guard telemetry.
- Authenticating `/medusa/send` itself: [#1865](https://github.com/Jason-Vaughan/TangleClaw/issues/1865), filed by the Architect (R2-N5).

---

## 7. Rulings (R1, settled) and new points needing a ruling

**Settled by R1 (message `20d836ae`), applied above:** A1 identity (§2.1); A2 store and audit (§2.2); A3 semantics and authority (§2.3); A4 gating (§2.4); A5 hooks, option b (§2.7); A6 successor and retention (§2.8); A7 no break-glass endpoint (§2.8); A8 API exposure (§2.6); A9 codes (§2.6).

**Settled by R2 (message `ea51c2ff`), applied above:** N1 operator proof tier (§2.3); N2 caller gate on restart and `update/apply` only (§2.4); N3 transactional hook chaining (§2.7); N4 launch into STOPPED refused, and close rules (§2.3, §2.8); N5 filed as [#1865](https://github.com/Jason-Vaughan/TangleClaw/issues/1865), out of scope.

**Open architectural questions: none.** One B2 interpretation is recorded for visibility, not as a question: the proof-tier mapping of the gate states R2 did not name (`locked`, `account-required` ⇒ not the operator, 403; `unreadable` ⇒ 503, fail closed) in §2.3. If the Architect reads any of these differently, the build follows the correction.

---

## 8. Build order (after "#1861 IMPLEMENTATION RELEASED")

Order, each step with the §3 rows it covers:

1. v48 schema, triggers, `lib/control-state.js` (including `operatorProof`), unit tests. Rows 1, 4, 4b, 4c, 7, 10.
2. `/api/control/*`, authority, ack and status, `tc control`, capabilities line. Rows 2, 3 (including the impersonation regression), 6.
3. `lib/control-gate.js`, admission capture, wiring at each §4 boundary, per-surface tests. Rows 5, 8, 8b, #1862-a/b/c/e.
4. `lib/control-hooks.js` and the governed marker. Row 9h. This step triggers the escalation clause (§2.7) if a constraint can't be met.
5. `docs/control-state.md`, FEATURES, CHANGELOG `### Added`, guide line. Row 9.
6. E2E exit test on an isolated instance.
7. Cumulative Critic.
8. Draft PR; the PM sequences the merge. No auto-merge during Chunk A.

---

## 9. Change ledger: rev 1 (`4a042074…`) → rev 2

1. **Header and provenance.** Replaced the ephemeral worktree path and the "no hosted link" wording with verified references. Recorded the PM-env authoring job and B2's adoption. *(R1 amendment 1)*
2. **§1 re-verified by B2.** Replaced line numbers with `file#symbol` anchors. Corrected references: in `commit.js`, `git add`/`git commit` sit in the commit routine (≈916/929), not ≈1663/1700. The `/medusa/send` route is `registerMedusaRoutes` + `resolveProjectMedusaTarget`, not `server.js:6772`. Added three new facts: operator identity is gate-dependent; restart and update read no caller; the hook installer skips worktrees and refuses foreign hooks.
3. **Identity (A1).** One open assignment per project. Removed `lane_key`. Added the rebind-invalidates-old-launch rule. Jobs capture `assignment_id` when admitted; a new assignment only tightens.
4. **Store (A2).** Split the design into the `control_assignments` and `control_holds` caches, and immutable `control_events` and `control_receipts`. State generation is separate from receipt and audit order. Added triggers that block UPDATE/DELETE.
5. **Semantics (A3).** Replaced the single hold state with cumulative named holds. RELEASE names hold ids and uses CAS. Authority is per-issuer with explicit delegation; the PM and the Architect cannot clear each other's holds. STOP is issued by the operator or listed principals, is terminal, and still gates until replaced or closed. Creation is operator-only.
6. **Gating (A4).** Gates check the subject: job, target or caller. Re-read at each final boundary. Injection refusal on HOLD, with narrow exemptions.
7. **Hooks (A5).** Option (b) is specified: a separate module, a per-worktree marker, chaining, fail-closed only when governed, bypasses documented, and the escalation clause. Option (c) is dropped.
8. **Successor and retention (A6); break-glass (A7).** A wrap does not close the assignment. The override endpoint is removed, and criterion 10 is reconciled to named operator RELEASE or a new assignment. *(R1 amendment 7)*
9. **API (A8, A9).** Verified active launch plus assignment authority. Token, URL and Medusa route are insufficient. The final code set is listed.
10. **`notify_pending` receipt** is written in the same transaction before the response. A delivery failure never rolls back. *(R1 amendment 6)*
11. **Tests added:** rows 4b (two simultaneous holds, R1 amendment 2), 4c (immutability and generation separation, R1 amendment 3), 8b (old job / new assignment, background subjects, R1 amendment 4), the project-74→96 impersonation regression in row 3 (R1 amendment 5), and 9h (hooks).
12. **New ruling asks N1–N5** (§7), found during re-verification.

### Rev 2 (`944529b8…`) → rev 3 (R2)

1. **N1 operator proof tier.** `operatorProof` resolves `verified-session`, `ambient-open` or `external-fallback` (refused, `503 CONTROL_OPERATOR_UNVERIFIABLE`), and the tier is audited on every event. The dashboard header alone never authorizes. B2 mapped the unnamed gate states (`locked`/`account-required` ⇒ 403; `unreadable` ⇒ 503).
2. **N2 caller gate.** Scoped to `POST /api/server/restart` and `POST /api/update/apply` only; `update-status` and `update/check` are ungated. `423 CONTROL_CALLER_UNATTRIBUTABLE` applies to unbound or invalid callers while any assignment is held or stopped. `force` never bypasses. The PM's live sync must send launch headers.
3. **N3 chaining safeguards.** `lstat` type, bytes or link target, and mode are preserved and fingerprinted. Install is transactional with full rollback and refuses an unexplained `.tc-chained`. The dispatcher `exec`s the chained hook with args and stdin, keeping its exit and signal semantics. Uninstall is fingerprint-checked and never overwrites. A tracked hooksPath is UNPROTECTED.
4. **N4.** An ordinary launch into STOPPED is refused with 423. The only restart path is an operator successor assignment that atomically supersedes. Close is limited to an ACTIVE assignment with no holds; `409 ACTIVE_HOLDS` / `409 STOP_TERMINAL`. **Corrected rev 2 text** that let a lifecycle authority close a STOPPED assignment (§2.3), let a successor inherit a stopped one (§2.8), and let a launch into STOPPED start (§3 #1862-e, §4, §7 N4).
5. **N5.** Linked [#1865](https://github.com/Jason-Vaughan/TangleClaw/issues/1865) (§5, §6). The row 3 regression stays.
6. **Tests added:** row 3 proof tiers; row 7 close and supersede; row 8b caller gate (omitted, mismatched or stale headers, clear PM, held Builder, verified operator, `force:true`, ungated check and status); row 9h chaining (regular file, symlink, collision, interrupted install and rollback, modified chained hook, args and stdin, exit and signal); #1862-e launch refusal.
7. **New codes:** `423 CONTROL_CALLER_UNATTRIBUTABLE`, `503 CONTROL_OPERATOR_UNVERIFIABLE`, `409 ACTIVE_HOLDS`, `409 STOP_TERMINAL`.
