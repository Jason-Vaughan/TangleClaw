---
title: startupControl — engine-native startup delivery with semantic receipt
issue: 1825
status: B1 SHIPPED (PR #1831). B2 (the Codex adapter) REVIEWED 2026-09-24 (Architect E1–E9 ruled, Critic clean); its PR is open. B3 is the next session's chunk (the Operator cancelled it for this session)
scope: startupcontrol-1825
branch: feat/1825-startup-control-b2
---

# startupControl (#1825)

Source of the problem statement, binding constraints and the four acceptance cases: the Car A3
planning note, archived at
`/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/.tangleclaw/plans/archive/train-a-car-a3-build-plan.md`
§ "P1: startupControl". They are not repeated here. Related: #1633 (gate task input until READY),
#1774 (TC CLI command contract). Adjacent, not duplicates: #1176 and #765 (these cover receipts
for *rules* delivery through the startup hook).

## Chunk 01: no-build spike (#1825)

**Scope.** Capture one engine's native channel, readiness signal, semantic receipt and
operator-blocked behavior **live**, in a scratch environment. No schema, adapter, profile field
or boot change lands in the repo. The only tracked output is this plan, with the evidence
recorded below. The Architect gets S1–S5 with that evidence.

### Candidate channels (surveyed 2026-09-23 from the installed CLIs, not from memory)

| Engine (installed version) | Native path found | Persistent + interactive? | Notes |
|---|---|---|---|
| Codex (codex-cli 0.156.1) | `codex app-server` JSON-RPC (`--listen unix://PATH`); the TUI attaches to the same server with `codex --remote unix://PATH` | yes: one thread, two clients | The protocol is published by the CLI itself (`codex app-server generate-json-schema`). It has `turn/start`, `thread/status/changed`, `turn/started`/`turn/completed`, `item/completed`, and server→client approval requests. Marked `[experimental]`. |
| Claude Code (2.1.280) | `--input-format stream-json` works only with `--print` (headless, not the interactive TUI). `--remote-control` routes through claude.ai. The SessionStart hook is native, but it is context, not a user turn. | no interactive, local, turn-level channel found in `--help` | The initial-prompt argv (`claude "<prompt>"`) is native, but only for turn 1. |
| Antigravity (`agy`) | `--prompt-interactive` (an initial prompt, then interactive). stream-json is print-mode only. `--remote-control` is a daemon. | only turn 1 is native | Same shape as Claude. |
| Aider, OpenClaw | none (per the planning note) | no | |

**Spike target: Codex app-server.** It is the only candidate with a persistent, local,
interactive channel. That channel is a published and machine-readable contract, and it has
explicit readiness, receipt and blocker messages. This is also the evidence that will settle S4.

### Spike procedure (scratch only)

1. Use a scratch cwd under the session scratchpad. It is not a TangleClaw project and not a repo
   checkout. Start `codex app-server --listen unix://<scratch>/cx.sock`. A unix socket needs no TCP
   port, so there is no PortHub lease.
2. Attach the interactive TUI in a scratch tmux session with `codex --remote unix://<scratch>/cx.sock`.
   The TUI is what an operator would see.
3. Connect a probe client (a node script in the scratchpad), then call `initialize` / `initialized`
   → `thread/loaded/list` (or `thread/list`) to find the TUI's thread.
4. **Readiness:** record what `thread/status/changed` reports before and while a turn runs.
5. **Channel:** `turn/start` on that thread with a benign bootstrap text that carries a nonce
   standing in for the launch id and priming digest ("reply with the nonce; run nothing").
   Confirm the TUI renders it as a user turn.
6. **Receipt:** capture `turn/started`, the `item/completed` for the userMessage (does it echo
   our text or nonce?), the agent message, and `turn/completed`. Also `thread/read` afterwards to
   check durability.
7. **Operator-blocked:** (a) an untrusted cwd, to see whether the directory-trust prompt is visible
   on the protocol or only in the TUI; (b) a turn that asks for a command, to observe the
   `item/commandExecution/requestApproval` server request and what happens when the probe does
   not answer it; (c) `account/read`, to see how an unauthenticated state would be named.
8. Tear down the tmux session, the app-server and the scratch dir.

Every model turn in the spike is benign. No project content goes to the model, and nothing is
executed in a TangleClaw project.

### Architectural decisions (for the Architect; recommendation first)

- **S1: Where the capability is declared.** Recommended: a `startupControl` block in the engine
  profile (`{supported, channel, readiness, receipt, blockers}`) with an `evidence` entry per
  field, following the `wake` pattern. It loads only when a code adapter of that name exists, so
  an operator edit alone cannot grant it. Rejected: code-only adapters, because they hide the
  capability from `tc capabilities`.
- **S2: What a receipt binds to.** Recommended: launch id + the step-4 revision digest + the
  priming-pact digest, stored beside the launch-sequence row, not on the session row. Rejected:
  the session row, which outlives relaunches and would let an old receipt satisfy a new launch.
  Spike refinement: carry a digest of those three values as `clientUserMessageId`. The engine
  echoes it back as the user item's `clientId`, so the receipt names the launch by construction.
  Record `accepted` on `userMessage item/completed` and `applied` on `turn/completed {completed}`.
- **S3: Fallback when unsupported.** Recommended: today's path, unchanged, with the launch record
  stating `startupControl: unsupported (<reason>)`. Nothing is downgraded to keystrokes. Rejected:
  retrying through tmux, which the Architect has already ruled out (wraps 1097/1101).
- **S4: First adapter.** Recommended, with the spike's evidence behind it: Codex via app-server.
  TangleClaw would own a per-launch `codex app-server --listen unix://…` and launch the pane's TUI
  with `--remote`, which changes how a Codex pane is launched. The protocol is marked
  `[experimental]`, so each field's `evidence` pins the codex-cli version it was verified on
  (0.156.1), and an unverified version reports `unsupported (unverified version)` rather than
  guessing. Rejected: Claude and Antigravity, whose only native path covers the initial prompt
  alone and has no turn-level receipt.
- **S5: How the bootstrap meets #1774.** Recommended: a fixed prime sentence now ("read your launch
  context: run `tc start next`"), swapped for a `TC START` manifest command once #1774 rules.
  Rejected: blocking on #1774, which is still open.

### Architect rulings (2026-09-23, message d94974c3): binding

The rulings factor in the operator's explicit UI/API design requirement. They certify no
implementation or merge.

- **S1: APPROVE.** Declare `startupControl` in the engine profile with per-field evidence. It is
  active only when the named code adapter exists, and `tc capabilities` exposes the resolved
  capability.
- **S2: MODIFY.** Bind the receipt to a canonical **launch-start payload**: launch id, target
  session/project, role+assignment revision, step-4 revision digest, priming-pact digest, and the
  stored prompt's id/revision/digest. Store it beside the launch-sequence row.
  `userMessage item/completed` with the echoed `clientId` = **accepted**. Only
  `turn/completed {completed}` = **applied**. A failed or interrupted turn stays non-applied and
  is named.
- **S3: MODIFY.** Automatic launch fallback and an explicit fire are different cases. An
  unsupported *automatic* launch keeps today's legacy path and records the reason. An explicit
  *UI/API fire* on an unsupported engine returns a typed `unsupported` response and does no
  fallback and no keystroke injection.
- **S4: MODIFY.** Codex 0.156.1 is the first adapter (the operator cleared its cost gate). All
  app-server, WebSocket, socket and version details stay behind the generic adapter. Verified
  versions are pinned, and unverified versions read as unsupported. The per-launch socket is
  server-owned and local. Auth, quota, approval and subscription blockers are surfaced. **The
  generic UI, store and API carry no Codex-specific contract.**
- **S5: MODIFY.** Replace the hard-coded sentence with a **persisted, revisioned startup prompt**,
  seeded to `read your launch context: run tc start next`. There is an operator UI to read, edit
  and store it, and authenticated API operations to read, update and **fire** it. The Operator,
  the PM and the Architect may fire within their governed scope. The UI and the API call **one
  service path**. Fire means inject plus submit through the adapter. Fire uses an expected
  revision (idempotency), targets the exact launch/session, and audits the caller, the prompt
  revision and the receipt. The automatic bootstrap still only reads the startup context and
  never dispatches project work. #1774 may later replace the default with a manifest command
  without changing this contract.
- **Due at the build's plan-written gate:** exact routes, authorization evidence, persistence
  scope, concurrency and error shapes.

### Implementation calls (not architectural)

- The probe client is a throwaway node script in the scratchpad, never committed.
- Nonce format: `SPIKE-<random hex>`.

### Evidence

Captured live on 2026-09-23 against codex-cli 0.156.1. Raw wire logs are in the session scratchpad
and are not committed, because they contain account identifiers.

- **Transport (a correction to step 1).** `--listen unix://<long path>` quietly binds a short path
  under `/private/tmp/codex-daemon-501/` and leaves a symlink at the requested path. The TUI's
  `--remote unix://<long path>` fails with `path must be shorter than SUN_LEN`, so clients must
  use the resolved short path. On the unix socket the protocol is **WebSocket** (`101 Switching
  Protocols`, `x-codex-websocket-max-unfragmented-message-bytes: 16777216`), not the JSONL that
  stdio speaks. `codex app-server proxy --sock` passes raw bytes through and does not add
  framing: a JSONL `initialize` sent through it got no reply.
- **Channel (case 1): confirmed present, second client accepted.** The TUI attached with
  `--remote` and rendered its normal composer. A second client (the probe) completed
  `initialize` → `initialized` on the same server. `thread/loaded/list` returned exactly one
  thread (the TUI's, `01a0cf7f…`, whose cwd matches the TUI's). `initialize`'s `userAgent`
  reports the client name the probe supplied, so the server knows which client is which.
- **Readiness (case 2): a protocol-level ready state exists.** `thread/read` returns
  `status: {"type":"idle"}` for the TUI's thread. `ThreadStatus` is
  `notLoaded | idle | systemError | active{activeFlags}`, and `thread/status/changed` pushes the
  transitions. This is the channel's own ready state, not a glyph or a quiet pane. `thread/read`
  with `includeTurns: true` returns `-32601 list_turns is not supported yet` on this version.
- **Operator-blocked (case 4): quota is machine-readable before anything is sent.**
  `account/rateLimits/read` returned `ordinaryUsageAllowed: false`,
  `rateLimitReachedType: "rate_limit_reached"`, weekly window `usedPercent: 100`, resetting
  2026-09-23 21:33 PDT, with `credits.hasCredits: true`. The TUI's own status line showed
  `weekly 0% left`, and **no** directory-trust prompt appeared for the untrusted scratch cwd in
  remote mode. `account/read` names the auth mode (`chatgpt`), so a logged-out state is
  detectable in the same way. `ThreadActiveFlag` = `waitingOnApproval | waitingOnUserInput`
  names the in-turn blockers on the status channel itself.
- **Receipt (case 3): CAPTURED.** The operator approved spending Codex credits (2026-09-23), and
  three benign turns were spent. On `turn/start` with `clientUserMessageId: "SPIKE-77a3fabf5d3c"`,
  the server emitted, in order: the `turn/start` response (`status: inProgress`) →
  `thread/status/changed` `active` → `turn/started` → `item/started` + `item/completed`
  `{type: userMessage, clientId: "SPIKE-77a3fabf5d3c", content: <our text>}` → `agentMessage`
  `"SPIKE-77a3fabf5d3c"` (`phase: final_answer`) → `thread/status/changed` `idle` →
  `turn/completed {status: completed, durationMs: 1976}`. The TUI rendered the text as an ordinary
  user turn (`› …`) and showed the reply. **The server echoes our client id on the user item, so a
  receipt is bound by the engine, not by our own matching.** `userMessage completed` means
  *accepted*; `turn/completed` means *applied*.
- **Subscription is a precondition (a trap).** Unless a client has resumed the thread, it gets
  only global `thread/status/changed` notifications and no `turn/*` or `item/*` events. On this
  version, a plain `thread/resume` fails (`-32601 list_turns is not supported yet`), and the server
  says to use `excludeTurns: true`, which works. The first turn (`SPIKE-6e6288214510`) was
  delivered and answered in the TUI while the probe, whose resume had failed, saw no receipt. **An
  adapter must treat "subscribed" as part of readiness**, or it will read a delivered turn as
  missing.
- **Approval block (case 4b): CAPTURED.** A turn asking for a shell command produced
  `thread/status/changed {active, activeFlags: ["waitingOnApproval"]}` plus a server→client
  `item/commandExecution/requestApproval` (id 0), sent to **both** the probe and the TUI. The TUI
  showed its normal approval dialog. The probe left the request unanswered and disconnected, and
  the request stayed pending: a client that resumed later was re-sent the same request (id 0).
  The operator's decline in the TUI (Esc) produced `serverRequest/resolved {requestId: 0}` for every
  client, then `turn/completed {status: interrupted}`. No file was written. (The TUI also printed
  "Ran echo …", which is a misleading display line; the directory stayed empty.) So a blocked
  launch is named on the protocol, is never typed through, and resumes from where it stood once
  the operator acts. That is acceptance case 4.
- Torn down afterwards: both tmux sessions were killed, and the socket and scratch cwd are gone.

## Build chunks (admitted by the PM 2026-09-23, message 94dbfbee; the Operator confirmed in-pane)

| # | Chunk | Why this order |
|---|---|---|
| B1 | Engine-neutral foundation. The `startupControl` profile block, validator and adapter registry, resolved in `tc capabilities`. The persisted, revisioned startup prompt, with the service, the read/update/fire API and the operator editor. With no adapter yet, fire returns a typed `unsupported`. | S4 requires the generic UI, store and API to carry no Codex contract. Building them first, with an empty registry, proves that by construction. |
| B2 | Codex adapter. A server-owned per-launch `codex app-server` on a unix socket; the pane's TUI launched with `--remote`; readiness that includes the subscription; fire via `turn/start` carrying the launch-start payload digest; receipts (accepted/applied/failed/interrupted); and blockers (auth, quota, approval). | It needs B1's registry and fire path. The routes, auth and store are fixed in B1, so B2 adds no new ones. |
| B3 | The automatic bootstrap on launch: a supported engine fires through its adapter, and an unsupported one keeps the legacy path and records the reason (S3). The launch panel shows receipts and blockers, and has a Fire button. | It needs a working adapter, and it changes every launch, so it comes last. |

## Chunk B1: the engine-neutral foundation

### Confidence check

1. **Problem:** nothing stores the startup instruction as a governed, revisioned artifact, nothing
   can fire it through an engine's native channel, and no profile can declare that an engine is
   able to.
2. **Success:**
   - The operator can read and edit the startup prompt in the dashboard, and each save makes a new
     revision guarded by an expected revision.
   - The authorized callers can read it and fire it at an exact session and launch.
   - Every engine today answers the fire with a typed `unsupported`, carrying the reason and doing
     no fallback, and that answer is audited.
   - `tc capabilities` reports `startup-control` for the caller's engine.
   - A profile can declare `startupControl`, but it is active only when a code adapter of that name
     is registered, and the registry ships empty.
3. **Out of scope:** any adapter or any Codex code (B2); a launch-start payload or receipts, beyond
   the audit row (B2); changing how a launch primes (B3).

### Facts established while planning (verified 2026-09-23 at 03ea93c)

- **Profiles and capability pattern.** Profiles live in `data/engines/*.json` and are validated
  per capability when read. The `wake` block (`lib/medusa-wake.js` `WAKE_FIELDS`,
  `_wakeBlockErrors`, `wakeSignature`) is the pattern: unknown fields are refused, evidence is
  required in both directions, and one validity function serves every reader. The "a profile names
  an adapter, never supplies one" precedent is `lib/engine-errors.js` `PARSERS`. A new capability
  key must be added to `READ_CAPABILITIES` (`lib/engines.js`), to
  `test/engine-capability-reads.test.js` and to the `docs/engine-guide.md` table.
- **Launch identity.** `launch_sequences` carries `id`, `launch_id` (UNIQUE) and `session_id`. **A
  launch id is a bearer credential** (the `x-tangleclaw-launch-id` binding header), so no response
  or audit row may carry it. Targets are named by session id and sequence id instead.
- **Two inputs in the S2 payload do not exist in code yet:** no "priming-pact digest" and no
  "role+assignment revision". They are B2's concern (the payload), and they are listed under D8.
- **Caller resolution.** `lib/shared-docs-access.js` `resolveAccess` returns `operator`, `project`,
  `master`, `unbound` or `invalid`. There is **no PM or Architect role in code**. Those sessions
  resolve as `project` callers bound to their own project.
- **The strict operator write is inline** in the recovery-clear route (`server.js` ~6782–6945):
  an armed gate needs a signed-in session plus CSRF; an open gate refuses machine clients
  (`OPERATOR_REQUIRED`) and requires same-origin plus `X-TC-Open-Token`.
- **Store:** schema v44; `BEGIN IMMEDIATE` migrations with a DDL postcondition. Compare-and-set is
  `UPDATE … WHERE revision=?` plus a `changes===0` check. `activity_log` is pruned, so a durable
  audit trail needs its own table.
- **Capabilities** are a hard-coded array in `GET /api/tc/whoami` (`server.js` ~4555). No engine
  capability is exposed there yet.

### Architectural decisions (for the Architect; recommendation first)

- **D1: Chunking.** B1/B2/B3 as in the table above. Rejected: one chunk, which would put one issue
  of this size in a single review (the project rule is one chunk per session).
- **D2: Persistence scope.** Recommended: **install-global**, one current prompt, stored as an
  append-only revision table `startup_prompt_revisions (revision PK, text, digest, created_at,
  created_by_kind)` with revision 1 seeded to `read your launch context: run tc start next` by the
  v45 migration. Rejected: per-project prompts now. The ruling names one prompt, and a later
  per-project override can add a scope column without changing the contract.
- **D3: Routes.**
  - `GET /api/startup-prompt` → `{revision, text, digest, updatedAt, updatedByKind}`.
  - `PUT /api/startup-prompt` with `{text, expectedRevision}` → `200` and the new revision.
  - `POST /api/sessions/:name/startup-prompt/fire` with `{sessionId, sequenceId,
    expectedRevision}` → the audited outcome.
  - Rejected: nesting under `/api/config`, which is unrevisioned.
- **D4: Authorization evidence.**
  - **Read:** the operator, or any bound project session (a session should be able to see what it
    will be sent).
  - **Update:** the operator only, through the strict operator write, which is extracted from
    recovery-clear into one shared helper so the two cannot drift.
  - **Fire:** the operator (strict write), or an agent session whose project is in the current
    revision's **`firerProjectIds`**. Its governed scope is a target session in a project that
    shares a project group with the caller. Identity comes from the existing launch binding (a
    `project` caller).
  - **Corrected while building (sent to the Architect as a D4 addendum, message 8ae21e40):** the
    first draft put the firer list in config (`startupPromptFirers`). `PATCH /api/config`
    authenticates nobody and is reachable by loopback agent sessions, so an agent could have added
    its own project. The list therefore lives in the revisioned prompt record, and is written only
    with the prompt, by the strict operator write, under the same compare-and-set. A firer change
    is a new audited revision. It also gives B2's S2 payload a real "assignment revision" source.
  - Rejected: inferring the PM or Architect from project names, which any rename breaks; and
    operator-only fire, which departs from S5.
- **D5: Concurrency and idempotency.**
  - An update is a compare-and-set on `expectedRevision`; a stale one gets 409.
  - A fire requires `expectedRevision` to equal the current revision, and
    `(sessionId, sequenceId)` to be that session's *current* launch.
  - A fire is keyed by `(sequenceId, revision)`. A repeat returns the existing fire record
    (`duplicate: true`) and never re-injects, and a partial unique index allows only one in-flight
    fire per launch.
- **D6: Error shapes.** The existing `{error, code, ...}` shape.
  - `400 STARTUP_PROMPT_INVALID`: empty, over 4 KB, or containing control characters other than
    newline.
  - `409 STALE_STARTUP_PROMPT {currentRevision}`.
  - `403 OPERATOR_REQUIRED`, `OPERATOR_ONLY` or `FIRE_SCOPE_DENIED`.
  - `404 SESSION_NOT_FOUND`.
  - `409 LAUNCH_NOT_CURRENT`, which echoes no launch identifier.
  - `409 STARTUP_CONTROL_UNSUPPORTED {engine, reason}`.
  - An `unsupported` fire is still audited.
- **D7: Profile schema and capability.**
  - The `startupControl` block has the fields `{adapter, channel, readiness, receipt, blockers,
    verifiedVersions, evidence}`, validated like `wake`.
  - It is active only when `adapter` names a registered adapter and the engine's installed version
    is in `verifiedVersions`. Otherwise it resolves to `unsupported (<reason>)`.
  - `whoami` gains a `startup-control` entry for the caller's engine.
  - B1 registers no adapter and no profile declares the block, so every engine reports
    `unsupported (no adapter)`.
- **D8: Audit record.** A durable `startup_prompt_fires` table: id, session id, sequence id,
  prompt revision and digest, caller kind and project, outcome
  (`unsupported|accepted|applied|failed|interrupted|blocked`), reason, and timestamps. B1 writes
  only `unsupported`. B2 adds the launch-start payload digest and the receipt transitions.
  Flagged for B2: the S2 payload's priming-pact digest and role+assignment revision have no source
  in code. B2 will propose defining them from the launch snapshot's `sourceManifest` and the
  `startupPromptFirers` config revision.

### Architect rulings on D1–D8 (2026-09-23, message 29790e23): binding

- **D1: APPROVE.** B1/B2/B3 is the right dependency split. B1 stays non-operative, with an empty
  adapter registry.
- **D2: MODIFY.** Install-global, append-only revisions that include `firerProjectIds`, with
  revision 1 seeded to the default text and an **empty** firer list.
  - Store the stable numeric project ids **sorted and unique**.
  - Store an exact-text SHA-256 digest **and** a separate canonical policy digest.
  - Record honest creator provenance: `operator-verified` plus the username when known, or
    `open-install-unverified`, not merely `operator`.
  - A later per-project scope is NOT promised contract-free; it returns to the Architect.
- **D3: MODIFY.**
  - `GET` gives a bound project the revision, the text and the digests, but **not** other
    projects' firer ids, only whether it may fire itself. The strict operator view gets the full
    list.
  - `PUT` takes the full `{text, firerProjectIds, expectedRevision}` state.
  - Fire takes `{sessionId, sequenceId, expectedRevision, idempotencyKey}`, and the path project,
    the session and the sequence must agree.
- **D4: MODIFY (the correction is adopted).**
  - Never use `PATCH /api/config`. Unknown project ids refuse, and the default list is empty.
  - Agent fire authority belongs only to a current project-bound launch whose project is in that
    revision's list and currently shares a project group with the target. This is project
    authority, not a human role. The Master stays denied.
  - **An out-of-scope target answers the same external 404 as a nonexistent one**, and the internal
    `FIRE_SCOPE_DENIED` reason is audited, with no cross-group oracle.
  - The firer-policy revision/digest is authorization evidence, **not** the target's
    role+assignment revision.
- **D5: MODIFY.**
  - The compare-and-set update stands.
  - Validate the current prompt revision, the current target launch, the scope and the fire claim
    **atomically**, before any adapter work.
  - Separate transport idempotency from semantic dedup:
    - a repeat of the same `idempotencyKey` returns the same record;
    - there is one active fire per launch;
    - an **applied** `(sequence, revision)` is never re-injected.
  - `(sequence, revision)` is **not** an unconditional permanent key across unsupported/failed
    outcomes. B2 defines explicit retryability, and an indeterminate send is never auto-retried.
- **D6: MODIFY.**
  - The limit is **4096 UTF-8 bytes**. The exact bytes are hashed with no Unicode normalization,
    and LF is the only allowed control character.
  - Keep the typed unsupported, stale and current-launch errors, and the strict operator helper's
    real armed/open/fallback errors.
  - An invisible target gets the external 404.
- **D7: APPROVE.** A profile block, plus a registered adapter, plus an exact verified version.
- **D8: MODIFY.**
  - Insert a durable fire **intent** before any external effect, with `pending`, `dispatching` and
    `indeterminate` states, so a crash between the send and the receipt can neither look unsent nor
    be auto-retried.
  - Keep `accepted`, `applied`, `blocked`, `failed`, `interrupted` and `unsupported`.
  - Store bounded typed reasons, the caller's clearance and project, the prompt text digest, the
    policy digest and timestamps, and never the launch bearer.
  - **B2 obligation:** return with evidenced sources for the priming-pact digest and the target's
    role+assignment revision. `sourceManifest` may qualify only after proof, and the firer-policy
    revision cannot substitute.

### Critic follow-ups (review rev-20260923T232701Z, 0 blocking)

- **D7, as ruled:** the exact-verified-version check is in `resolve()`. The adapter contract is a
  synchronous, cached `installedVersion()`, so resolution never spawns a process. A missing or
  unlisted version, or a probe that throws, resolves to `version_unverified`. (The first build
  had left the check to the adapter; the Critic caught the drift from D7.)
- An engine profile that cannot be read resolves to `engine_profile_unreadable`, and
  `resolveProfile` is used so `openclaw:<id>` engines resolve.
- **Carried into B3 (the Critic's R-13/R-14):**
  - Surface `denied` fire attempts in the launch panel. Today they are visible only in
    `startup_prompt_fires`.
  - Bring a retention decision for `startup_prompt_fires` to the Architect with B3, when the
    table gains its readers.

### Implementation calls (not architectural)

- New modules: `lib/startup-control.js` (the validator, the empty adapter registry and the
  capability resolution) and `lib/startup-prompt.js` (the service that the UI routes and the API
  call alike: one service path, per S5).
- The operator editor sits on the landing page beside the global rules editor, following the
  `#rulesEditor` pattern, and sends `expectedRevision`. A 409 re-reads and says so.
- `docs/engine-guide.md` (`startupControl`) and `docs/user-guide.md` ("Startup Prompt") are
  updated in the same commits, along with `CHANGELOG.md` `### Added`. (The configuration reference
  is not touched, because the firer list is not configuration; see D4.)

### Tests (written alongside)

- Validator: unknown fields, evidence in both directions, an adapter not in the registry, and an
  unverified version all resolve to unsupported.
- Store: the v45 migration seeds revision 1; update is compare-and-set; the one-in-flight index
  holds; and a migration postcondition refuses a half-built table.
- API: read/update/fire authorization for every caller kind (operator armed and open, bound
  project, listed firer inside and outside a shared group, master, unbound, invalid).
- API errors: stale revisions; a launch that is not current; a duplicate fire; and `unsupported`
  audited without any keystroke path touched (tmux is spied on and never called).
- Recovery clear still passes its existing tests on the extracted helper.
- `whoami` reports `startup-control`, and the UI collector sends `expectedRevision`.

### Done when

- Every test above is green, the full suite is green, and the docs are current.
- The Architect has ruled on D1–D8, and the Critic is clean.

## Chunk B2: the Codex adapter

### Confidence check

1. **Problem:** with B1, every fire is refused as unsupported. Codex has a native channel (the
   spike), but TangleClaw neither owns a per-launch app-server nor launches the pane's TUI against
   one, so no receipt can exist.
2. **Success:**
   - A Codex session launched by TangleClaw runs its TUI against a TangleClaw-owned app-server on a
     local unix socket. `tc capabilities` reports `startup-control` enabled for codex-cli 0.156.1.
   - A fire by the operator, or by a listed firer in scope, delivers the prompt as a user turn the
     operator sees in the pane, and the fire row moves `pending → dispatching → accepted → applied`
     with the engine-echoed payload digest as the binding.
   - A fire that cannot proceed names its blocker (`trust_required`, `auth_required`,
     `quota_exhausted`, `engine_not_ready`) and types nothing. A turn that fails or that the operator
     interrupts is recorded as such. A turn waiting on an approval stays `accepted` and says so.
   - A TangleClaw restart neither kills the pane's app-server nor loses the channel; ending the
     session ends the app-server.
   - A Codex launch whose app-server cannot be started launches exactly as today, and records why.
3. **Out of scope:** the automatic bootstrap at launch and the legacy-fallback decision (B3); the
   launch panel, its receipts and the Fire button (B3); any engine other than Codex; a read route
   for fire records (B3's panel); creating the thread from TangleClaw's side (impossible before the
   first user message on 0.156.1, see below).

### Facts established while planning (measured live 2026-09-24 against codex-cli 0.156.1, six probes, no model turn spent)

- **Transport.** The unix socket speaks WebSocket (RFC 6455) carrying JSON-RPC-shaped messages
  WITHOUT a `jsonrpc` field: `{id, method, params}` → `{id, result}` or `{id, error}`;
  notifications are `{method, params}`. A 100-line hand-rolled client (handshake, masking, ping/pong,
  126/127-byte length forms, fragments) completed `initialize` and every call below. The project has
  no dependencies (no `package.json`), and Node's global `WebSocket` cannot dial a unix socket, so
  the client is ours.
- **`initialize` reports the server's version** in `userAgent` (`<client>/0.156.1 (...)`), so a
  channel can be checked against the adapter's cached installed version at readiness.
- **Launch-mode flags survive `--remote`.** `codex --remote unix://<path> -a never -s
  workspace-write` attached and the status line read `never`; thread/start from the protocol echoes
  `approvalPolicy` and `sandbox` the same way.
- **Trust lives in the TUI, not the server.** In an untrusted directory the TUI sits at the
  "Trust this folder?" dialog and loads NO thread (30 s, thread/loaded/list empty), while
  thread/start from the protocol in the same directory succeeds without complaint. config/read
  returns `config.projects[<path>].trust_level`, so trust is readable on the protocol before a fire.
  A `-c projects.<path>.trust_level=trusted` override on the TUI's command line does NOT bypass the
  dialog.
- **A fresh thread cannot be subscribed to, listed or resumed before its first user message.**
  thread/resume answers `no rollout found`, thread/turns/list answers "thread ... is not
  materialized yet; unavailable before first user message", and thread/items/list is "not
  supported yet"; the rollout file is absent for 15+ s after the thread starts. Metadata writes
  (thread/name/set) do not materialize it. `codex resume <id> --remote` fails for the same reason,
  so TangleClaw cannot create the thread and have the TUI join it. **Therefore the fire's own
  turn/start is what materializes the thread, and the subscription must follow the turn/start
  response.** The spike already showed that the sender of turn/start is NOT subscribed by sending.
- **Global notifications arrive without a subscription:** thread/started (with the thread's
  `cwd`), thread/status/changed, account/updated, account/rateLimits/updated,
  thread/name/updated. Per-turn `turn/*` and `item/*` events need the subscription.
- **Blockers are readable before a send.** account/read → `{account: {type: chatgpt, email,
  planType} | null, requiresOpenaiAuth}`. account/rateLimits/read →
  `{ordinaryUsageAllowed, rateLimits: {primary: {usedPercent, resetsAt}, credits: {hasCredits,
  balance}, rateLimitReachedType}}`. Measured now: weekly window 100 % used, resetting 2026-09-24
  04:33 UTC, credits present. In-turn: `thread/status/changed {active, activeFlags:
  [waitingOnApproval | waitingOnUserInput]}` and serverRequest/resolved (spike).
- **Process lifecycle.** `codex app-server --listen unix://<long path>` binds a short path under
  `/private/tmp/codex-daemon-<uid>/<hash>` and leaves a symlink at the requested path; the TUI needs
  the resolved short path. SIGTERM exits 0 and removes both. A TUI exiting does not close its thread
  (thread/loaded/list still names it).
- **Wire shapes** come from `codex app-server generate-json-schema` (v2), read into the scratchpad,
  not from memory: `TurnStartParams {threadId, input: [{type: 'text', text}], clientUserMessageId}`,
  `Turn {id, status: completed|interrupted|failed|inProgress, error: TurnError{message,
  codexErrorInfo}}`, `ThreadItem userMessage {id, clientId, content}`, `ThreadStatus`,
  `ThreadTurnsListParams {threadId, itemsView}`.
- **Code seams.** `lib/sessions.js#launchSession` builds the pane command (`_buildLaunchCommand`)
  and creates the tmux session BEFORE the session row exists (`store.sessions.start` binds the launch
  snapshot in the same transaction); `killSession` and the four other `_teardownMedusa` call sites
  are where a session's server-owned resources end. `store.startupPrompts.transaction` is
  synchronous (`BEGIN IMMEDIATE`), so nothing asynchronous can run inside it. The v44→v45 tables have
  zero fire rows on the live install. SQLite cannot alter a CHECK constraint in place.

### Architectural decisions (for the Architect; recommendation first)

- **E1: Channel ownership and lifetime.** Recommended: TangleClaw spawns one `codex app-server
  --listen unix://<TangleClaw base dir>/run/startup-control/<random>.sock` per launch, **detached**
  (own process group, stdio ignored), before the pane exists; the pane runs `codex --remote
  unix://<resolved short path> <launch-mode args>`. The channel is torn down (SIGTERM, socket
  removed) when the session is killed, wrapped or found crashed, and by a reaper at boot and every
  five minutes for channels whose session is no longer active. The reaper verifies the pid is still
  a `codex app-server` naming that socket before signalling it. Rejected: (a) a child of the
  TangleClaw process: every restart of the live server (frequent here) would sever every Codex pane;
  (b) hosting the app-server inside the pane (`codex app-server & codex --remote`): TangleClaw could
  not tell whether the socket it connects to is this launch's, and readiness would race the shell;
  (c) the shared `codex app-server daemon`: one server across launches and users, against S4's
  per-launch, server-owned socket.
- **E2: Persisted channel record.** Recommended: a new table `startup_control_channels` (schema
  v46): `id, session_id, sequence_id, engine_id, adapter, engine_version, socket_path,
  resolved_socket_path, pid, thread_id (NULL until the TUI's thread is observed), state
  (open|closed), opened_at, closed_at, close_reason`, one open row per session. No launch id.
  Rejected: columns on `launch_sequences` (the generic launch row must carry no Codex contract, S4);
  an in-memory map (a restart would orphan every app-server and lose every reconnection).
- **E3: Launch-mode carry-over.** Recommended: the existing `launchModes` args are appended after
  `--remote` unchanged, because the TUI applies them in remote mode (measured). The app-server is
  started with no policy flags. Rejected: passing the policy to the app-server with `-c`, which makes
  the pane's flags and the server's config two sources for one posture.
- **E4: Readiness (acceptance case 2).** Recommended, all on the protocol: (1) the channel's
  app-server answers `initialize`, and its `userAgent` version equals the adapter's installed
  version; (2) thread/loaded/list names one thread whose `cwd` is the project path (recorded as the
  channel's `thread_id` on first sight); (3) thread/read reports `idle`; (4) account/read names an
  account; (5) account/rateLimits/read allows ordinary usage or reports credits; (6) config/read
  shows the project path `trust_level: trusted`. **Subscription is not a readiness precondition on
  0.156.1** (the server refuses it before the first user message); it is the first step of the
  receipt path (E5). Rejected: pane reads (glyphs, quiet pane) as readiness, which case 2 forbids;
  waiting for a subscription that this version cannot grant, which would make every fresh launch
  never-ready.
- **E5: Fire and receipt transitions (D8).** Recommended: B1's transaction writes the intent row as
  `pending` and commits; the adapter then runs outside it. `dispatching` is written when the
  turn/start frame (with `clientUserMessageId = payloadDigest`, E8) is handed to the socket. On the
  turn/start response the turn id is stored; the adapter then calls `thread/resume {excludeTurns:
  true}` (the thread is materialized now) and ONE `thread/turns/list {itemsView: full}` read-back to
  reconcile whatever was emitted before the subscription. A userMessage item in that turn whose
  `clientId` equals the payload digest, from either the read-back or an item/completed
  notification, is **accepted**. Then `turn/completed {completed}` → **applied**; `{failed}` →
  **failed** (`turn_failed`, with `codexErrorInfo` in the bounded reason); `{interrupted}` →
  **interrupted**. `thread/status/changed active [waitingOnApproval | waitingOnUserInput]` during the
  turn keeps `accepted` and sets `reasonCode: approval_pending`; serverRequest/resolved clears it.
  The operator answers approvals in the TUI; TangleClaw never answers one. A socket lost before the
  turn/start response → **indeterminate** (`send_unconfirmed`); an error response → **failed**
  (`turn_rejected`); a socket lost after `accepted` → reconnect (bounded) and settle from the
  turn's status in thread/turns/list; a channel that is gone → **indeterminate** (`channel_lost`).
  The fire route waits up to 10 s for `accepted` or a terminal state and returns the row as it then
  stands (200); the watch continues in the background to settle `applied`, and every transition is
  written to the activity log. Rejected: returning before the intent is durable; treating the
  turn/start response alone as accepted (it carries no echo of our id); a new fires read route in
  this chunk (B3's panel owns reading; B1 fixed the routes).
- **E6: Blockers (acceptance case 4).** Recommended reason codes, added to the bounded list:
  `trust_required`, `auth_required`, `quota_exhausted`, `engine_not_ready` (no channel, no thread,
  thread not idle, or unreachable app-server), `version_mismatch`, `approval_pending`, `turn_failed`,
  `turn_rejected`, `turn_interrupted`, `send_unconfirmed`, `channel_lost`, `channel_unavailable`
  (the app-server could not be started at launch). A pre-send blocker is outcome **blocked** with
  nothing sent; it leaves the launch's active slot, so a new fire may follow once cleared. The trust
  dialog cannot be pre-answered from the protocol and is never typed through: the TUI shows it and
  the fire says `trust_required`. Rejected: retrying through the dialog; treating an in-turn approval
  as a terminal `blocked` (the turn is still live and the operator may approve it).
- **E7: Retryability (D5's B2 obligation) and the v46 migration.** Recommended:
  - `applied`: never re-injected for that `(sequence, revision)` (existing index).
  - `pending`, `dispatching`, `accepted`: active; a second fire is `STARTUP_FIRE_IN_FLIGHT`.
  - `indeterminate`: active and **never auto-retried**. A fire attempt that finds one first runs a
    reconcile: thread/turns/list for a turn carrying the payload digest settles it to the turn's
    true state; no such turn on an idle thread settles it to `failed` (`send_unconfirmed`), after
    which a new fire is allowed; a channel that cannot be reached leaves it indeterminate
    (`channel_lost`) until the session is relaunched.
  - `blocked`, `failed`, `interrupted`, `unsupported`, `denied`: not active; a new fire with a new
    `idempotencyKey` may be made; the same key replays the record.
  - Transitions are enforced in the store (`updateFire` refuses a move out of a terminal outcome).
  - v46 rebuilds `startup_prompt_fires` to widen the `reason_code` CHECK (SQLite cannot alter it),
    copying every row, and adds `payload` (JSON, no bearer), `payload_digest`, `engine_thread_id`,
    `engine_turn_id`, `dispatched_at`, `accepted_at`, `settled_at`; the postcondition refuses a
    half-built table, as v45 does. Rejected: dropping the CHECK and validating only in code.
- **E8: The launch-start payload and the D8 sources (the obligation).** The payload is canonical
  JSON: `{launchId, sessionId, projectId, sequenceId, launchRevision, stepDigests: {identity,
  governance, state, task}, primingPactDigest, roleAssignmentRevision, promptRevision,
  promptTextDigest, policyDigest}`; `payloadDigest = sha256(payload)` is the `clientUserMessageId`
  the engine echoes. The row stores the payload **without `launchId`** (the bearer is hashed in,
  never stored) plus the digest. The step-4 revision digest of S2 is `stepDigests.task` at
  `launchRevision`. Evidenced sources for the two inputs that have none in code:
  - **Priming-pact digest.** Recommended **P-a**: `sha256` over the four step digests at the
    launch's current revision, in step order. Evidence: `launch_sequence_steps.digest` is
    `stepDigest(content)` over the exact bytes served (`lib/launch-sequence.js#buildSnapshot`), frozen
    per revision, re-rendered only by `_reviseIfRulesChanged` (which bumps `launch_sequences.revision`)
    and never after READY. It is the bytes the session was primed with, so it is the pact by
    construction. Alternative **P-b**, `sourceManifest`: what the steps were built FROM (rules
    fingerprints with `session_rules` version numbers, the global-rules hash, the engine config hash,
    shared-doc hashes, the continuity index hash, the consumed handoff's publication id and digest,
    the render context). Proof status: it is frozen with the snapshot and canonical for a launch,
    but it is NOT a closure of every prime input (`project.json` settings, the engine profile and
    the preflight verdict are not hashed), so it proves "the recorded sources were unchanged", not
    "the prime was unchanged". Rejected: hashing `sessions.prime_prompt` (unrevisioned, and null on
    silent-prime launches).
  - **Role+assignment revision.** There is no session role in code: `resolveAccess` yields
    `operator | project | master | unbound | invalid`, and the only role env is the Master pane's
    `TANGLECLAW_ROLE`. Recommended **R-a**: role = the target project's session-rules revision set
    (`[{ruleId, versionNo}]` from `store.sessionRules.listVersions`, the same values
    `ruleFingerprints` records), because the operator-authored session rules are what define a
    session's role here (this project's "PM-managed Builder" rules are session rules); assignment =
    the handoff publication the launch consumed (`sourceManifest.handoffPublicationId` and
    `handoffDigest`, #1675), which carries the next action the session was launched to resume.
    `roleAssignmentRevision = sha256(canonical {rules, handoffPublicationId, handoffDigest})`, with
    the components stored in the payload and `roleAssignmentSource: 'session-rules+handoff'`
    recorded beside it. Alternative **R-b**: the digest of a `.tangleclaw/priming/<role>.md` file:
    git-tracked role prompts exist (`build-session`, `pm-managed-builder`, `roadmap-triage`,
    `swarm-sprint`) but nothing binds a session to one, so it needs a project setting, which is a new
    requirement for a later chunk. Alternative **R-c**: the PM's dispatch message: not a TangleClaw
    record (Medusa messages are not persisted as assignments). The firer-policy revision is used for
    neither (D4).
- **E9: Version source.** Recommended: `codex --version` is probed asynchronously (execFile, 5 s
  timeout) at boot and at each Codex launch, and cached; `installedVersion()` answers from the cache
  and never spawns. The channel's `initialize.userAgent` version must equal it at readiness, else
  `version_mismatch`. Rejected: reading the version only from the app-server (it does not exist until
  a launch, and resolution runs on request paths).

### Architect rulings on E1–E9 (2026-09-24, message 2ad0567c): binding

Proceed with B2 subject to these modifications. They authorize no B3 and no second Builder.

- **E1: MODIFY.** One detached, server-owned app-server per launch and the boot/periodic reaper are
  approved. Teardown follows the actual session/launch lifetime: kill, a terminal wrap that ends the
  session, crash, or replacement by a new launch. A keep-running wrap MUST retain the channel. On a
  TangleClaw restart, recover active channel records and reconnect before reaping. Before signalling,
  verify the current session+sequence, the exact socket, the command identity and a recorded
  process-birth identity so pid reuse cannot kill an unrelated process; terminate the owned process
  group and record teardown failure honestly.
- **E2: MODIFY.** Persistence and omission of the raw launch bearer are approved. Bind every row to
  session_id + sequence_id and enforce one open channel for the current launch generation. S4 still
  forbids a Codex-specific contract in the generic store: keep a generic channel header and put
  pid/socket/resolved-socket/thread data in bounded, non-secret adapter-owned state only the Codex
  adapter interprets. The generic UI/API may expose lifecycle state and typed reasons, not Codex
  process fields.
- **E3: APPROVE.** Preserve the already-validated launch-mode argv after `--remote`; give the
  app-server no competing policy flags; reuse the validated argv path rather than interpolating raw
  mode text.
- **E4: MODIFY.** The six protocol checks and deferring subscription until after materialization are
  approved. Compare canonical cwd identities and require exactly the recorded launch thread; zero,
  multiple or mismatched candidates are not ready. Quota passes only on an explicit
  `ordinaryUsageAllowed = true` or an explicitly usable positive-credit predicate pinned to the
  verified protocol version; a credits object alone is insufficient. Unknown account, rate-limit or
  trust state fails closed with a typed reason. Trust is read for the canonical target path and never
  injected or answered by TangleClaw.
- **E5: MODIFY.** pending → dispatching → accepted → applied and the subscribe-then-read-back gap
  closure are approved. Accepted requires the same thread/turn, `clientId == payloadDigest` AND echoed
  user-message content whose exact bytes hash to `promptTextDigest`. Applied requires `completed` on
  that tracked turn after accepted evidence exists; an early completion is buffered/reconciled, never
  used to skip the accepted proof. `waitingOnApproval` and `waitingOnUserInput` are distinct
  non-terminal accepted states (`approval_pending`, `user_input_pending`). After a restart, recover and
  reconcile every non-terminal fire without resending: a proven never-dispatched pending row may fail
  cleanly, dispatching without a response becomes indeterminate, accepted resumes its watch. The 10 s
  route wait and the continuing watcher are approved.
- **E6: MODIFY.** Bounded typed codes and pre-send blocked semantics are approved. Add
  `user_input_pending`. `channel_unavailable` is failure to create or obtain a channel;
  `channel_lost` is an established one that disappeared. `approval_pending` / `user_input_pending`
  remain accepted and keep the slot; pre-send blocked releases it. Unknown readiness, account or
  quota evidence must never become a false ready or a false `quota_exhausted`; use an honest bounded
  code.
- **E7: MODIFY.** The retry classes, same-key replay, applied dedup, store-enforced transitions and
  the transactional v46 rebuild are approved. An indeterminate send may settle to
  failed/send_unconfirmed only after an authoritative, exhaustive read of the exact materialized
  thread (all pages), on the exact reachable channel, shows the payload absent while the thread is
  stably idle. One page or one instantaneous absence is not enough; otherwise it stays indeterminate
  and is never resent automatically. Preserve all rows, constraints and indexes through the rebuild.
- **E8: MODIFY; choices: P-a and R-a in these exact forms.**
  - Priming pact: P-a, hashed as a domain-separated, versioned canonical object
    `{kind: startup-priming-pact, version: 1, launchRevision, steps: {identity, governance, state,
    task}}`, not a concatenation. The step digests are the exact frozen bytes served, so this is the
    pact; `sourceManifest` is provenance, not the pact.
  - Role+assignment: R-a as the honest current proxy, derived ONLY from the frozen launch snapshot,
    never from live `listVersions`. A domain-separated, versioned object containing the target
    project binding (projectId; the launch-time name if frozen), `roleKind: project-bound`, the
    snapshot rule fingerprints, and the consumed handoff publicationId + digest (explicit nulls when
    absent), with source recorded as `project-binding+session-rules+handoff`. Session rules alone are
    governance, not proof of a first-class role, and the handoff is continuity, not a persisted PM
    dispatch; that limitation is documented. A future first-class role/assignment record returns for a
    new decision rather than silently changing this digest. Store the non-bearer components and the
    canonicalization version for audit; the raw launchId is hashed into the full payload digest and
    never stored.
- **E9: APPROVE with one condition.** Probe the exact resolved Codex executable used for the launch,
  refresh before each launch, and invalidate rather than reuse a stale cache on probe failure.
  `initialize.userAgent` must match both the channel row's recorded version and an exact verified
  version. Recovered channels are revalidated against their recorded server version.
  `installedVersion` stays synchronous and spawn-free on request paths.

The Architect confirmed the Builder's restatement (message a445580e) and closed the exchange; it
returns only at the review gate or if implementation evidence changes a contract.

### How the rulings landed (implementation calls)

- E2: `startup_control_channels` is `{id, session_id, sequence_id, engine_id, adapter, state,
  adapter_state (JSON ≤ 8 KiB), opened_at, closed_at, close_reason, teardown}`. The Codex adapter's
  state is `{pid, birth, socketPath, resolvedSocketPath, engineVersion, enginePath, threadId,
  serverVersion}`.
- E4/E6: `_usageAllowed` answers `allowed | exhausted | unknown`; every unknown is `readiness_unknown`.
- E5: `_echoedItem` requires both the clientId and `sha256(text) === promptTextDigest`; an early
  turn/completed triggers a read-back before judgement; `recover()` runs at boot.
- E7: `reconcile` pages thread/turns/list to the end, reads the status twice across
  `STABLE_IDLE_MS` (1.5 s), and lists again before recording `failed`.
- E8: `buildLaunchPayload` in `lib/startup-prompt.js`, with `PAYLOAD_CANON_VERSION = 1`.
- E9: `probeVersionSync({enginePath})` runs with `detectEngine`'s resolved path at each launch.
- Reason codes added to the bounded list: `readiness_unknown`, `user_input_pending`,
  `restart_before_dispatch`, plus the E6 set.
- The fire route answers `409 STARTUP_FIRE_BLOCKED` for a pre-send blocker (nothing sent), and `200`
  with the row for every other outcome.

### Live verification (the gap is closed)

Probes 1–6 (above) were spend-free. With the operator's pre-authorization (relayed by the PM,
message f3951ca5), one benign turn was spent on 2026-09-24 01:14 UTC running the REAL adapter
(`lib/startup-control-codex.js`, real seams) against a real `codex app-server` and TUI in the
trusted scratch directory `/private/tmp/tc731`:

- `prepareLaunch` probed the exact executable (the npm-global codex binary, 0.156.1), started the
  server detached (pid recorded with its `ps` birth time), resolved the short socket path and built
  `codex --remote unix://<short path> -a never -s workspace-write`; the TUI attached and showed the
  `never` posture.
- Readiness passed on the protocol: server version 0.156.1 recorded on the channel, trust read from
  config/read, account present, usage window exhausted but credits usable, exactly one idle thread
  for the directory (`01a0d0fa-9013…`, recorded on the channel).
- turn/start with the payload digest as `clientUserMessageId` answered with turn `01a0d0fa-a078…`;
  **`thread/resume {excludeTurns: true}` on the freshly materialized thread FAILED with
  `-32601 list_turns is not supported yet`** (the trap the spike hit, now on the post-send path
  too), so the subscription is not guaranteed on this version. The thread/turns/list read-back
  answered, carried the user message with the echoed `clientId` and the prompt's exact text, and the
  fire went `dispatching → accepted` 0.25 s after the send; `turn/completed {completed}` arrived and
  the fire went `applied` 1.3 s later. The pane showed the prompt as an ordinary user turn (`› …`)
  and Codex's reply (`• ACK`). No command ran.
- `releaseSession` verified command, socket and birth, signalled the process group, recorded
  `teardown: ok`, and no app-server survived.
- Consequence built in: the watcher re-reads the turn record every 5 s while a fire is accepted
  (`WATCH_POLL_MS`), so a turn whose end no notification reports is still settled from the engine's
  record; a test replays the refused subscription.

### Implementation calls (not architectural)

- New modules: `lib/ws-unix-client.js` (the RFC 6455 client over a unix socket),
  `lib/startup-control-codex.js` (the adapter: version probe, channel spawn/attach/teardown/reaper,
  readiness, fire, watch, reconcile), registered as `codex` in `lib/startup-control.js#ADAPTERS`.
- `data/engines/codex.json` declares `startupControl` with `adapter: codex`, `verifiedVersions:
  ['0.156.1']` and an `evidence` entry per field naming the spike and these probes.
- `launchSession` asks the adapter to prepare the channel only when `startupControl.resolveEngine`
  says supported; a spawn failure logs, records `channel_unavailable` and launches today's command.
  The channel row is written after `store.sessions.start` returns (it needs the session id); a
  failed session insert tears the channel down.
- `startupPrompt.fire` becomes async; B1's tests `await` it (no assertion changes).
- Docs in the same commits: `docs/engine-guide.md` (`startupControl`: Codex, the channel, the
  receipt, the blockers), `docs/user-guide.md` ("Startup Prompt": what a fire on Codex does and the
  outcomes), `CHANGELOG.md` `### Added`.

### Tests (written alongside)

- ws client: handshake accept/refuse, masking, the 7/16/64-bit length forms, ping→pong,
  fragmented text, close.
- Adapter against a fake app-server that replays the spike's recorded sequence: readiness green and
  each blocker; accepted via notification and via read-back alone; applied; failed; interrupted;
  approval pending then applied; socket lost before the response → indeterminate; socket lost after
  accepted → reconnect settles; reconcile of an indeterminate row (turn found, turn absent, channel
  gone); version mismatch; TangleClaw never answers a server request.
- Store: v46 rebuild keeps rows and widens the CHECK, refuses a half-built table; `updateFire`
  refuses illegal transitions; the channels table's one-open-per-session rule.
- Launch: a supported Codex launch spawns the app-server (spied), prepends `--remote <resolved>`,
  keeps the mode args, records the channel; an unsupported version or a failed spawn launches the
  unchanged command; kill/wrap/crash tear the channel down; the reaper closes channels of ended
  sessions and never signals a pid that is not a `codex app-server` on that socket.
- API: fire on a supported session returns the accepted row (fake adapter); the B1 authorization,
  idempotency and unsupported cases still pass unchanged.
- Capability: `tc capabilities` reports `startup-control` enabled for codex on a stubbed 0.156.1.

### Done when

- Every test above is green, the full suite is green, and the docs are current.
- The Architect has ruled on E1–E9 (E8's P/R choice in particular), and the Critic is clean.

## Status

- [x] Chunk 01: no-build spike: capture Codex app-server channel, readiness, receipt and blockers live; S1–S5 to the Architect with the evidence. Done 2026-09-23: all four cases captured; Architect ruled S1 APPROVE, S2–S5 MODIFY (message d94974c3)
- [x] Chunk B1: Engine-neutral foundation: startupControl profile block + registry + capability, revisioned startup prompt with read/update/fire API and operator editor (#1825): Architect ruled D1–D8 (message 29790e23) plus a D4 correction; Critic rev-20260923T232701Z (0 blocking) → rev-20260923T234219Z (1 blocking, introduced by a fix) → rev-20260923T235204Z (0 findings); follow-ups carried into B3
- [x] Chunk B2: Codex adapter: per-launch app-server, readiness, fire with launch-bound receipts, blockers (#1825): Architect ruled E1–E9 (message 2ad0567c); one operator-authorized live turn went dispatching → accepted → applied; Critic cumulative rev-20260924T013228Z (2 blocking, 9 warning, 12 note) → verify rev-20260924T015225Z (1 blocking) → verify rev-20260924T020349Z (0 findings)
- [ ] Chunk B3: Automatic bootstrap on launch with legacy fallback; launch panel receipts, blockers and Fire (#1825). Carries from B2's review: surface `denied` fires in the panel; take retention of `startup_prompt_fires` AND of closed `startup_control_channels` rows to the Architect (R-14/R-19); consider a per-launch app-server log file if a live launch ever fails to open its socket (R-18); pin the pipeline-wrap keep-running retention and the medusa-resync crash release with tests, and wire adapter `stop()` at shutdown (verify-resolutions observations 1–2)
