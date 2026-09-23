---
title: startupControl — engine-native startup delivery with semantic receipt
issue: 1825
status: Spike COMPLETE (Architect S1–S5, message d94974c3). Build chunks admitted 2026-09-23. B1 PLAN WRITTEN, with D1–D8 sent to the Architect
scope: startupcontrol-1825
branch: feat/1825-startup-control-c1
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

## Build Chunk B1: the engine-neutral foundation

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

## Status

- [x] Chunk 01: no-build spike: capture Codex app-server channel, readiness, receipt and blockers live; S1–S5 to the Architect with the evidence. Done 2026-09-23: all four cases captured; Architect ruled S1 APPROVE, S2–S5 MODIFY (message d94974c3)
- [ ] Chunk B1: Engine-neutral foundation: startupControl profile block + registry + capability, revisioned startup prompt with read/update/fire API and operator editor (#1825)
- [ ] Chunk B2: Codex adapter: per-launch app-server, readiness, fire with launch-bound receipts, blockers (#1825)
- [ ] Chunk B3: Automatic bootstrap on launch with legacy fallback; launch panel receipts, blockers and Fire (#1825)
