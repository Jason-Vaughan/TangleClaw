---
title: startupControl — engine-native startup delivery with semantic receipt
issue: 1825
status: Chunk 01 (no-build spike) COMPLETE 2026-09-23 — Architect ruled S1–S5 (message d94974c3); build chunks not yet admitted
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

## Status

- [x] Chunk 01: no-build spike: capture Codex app-server channel, readiness, receipt and blockers live; S1–S5 to the Architect with the evidence. Done 2026-09-23: all four cases captured; Architect ruled S1 APPROVE, S2–S5 MODIFY (message d94974c3)
- [ ] Build chunks: not yet planned; the PM admits scope, and routes, auth, persistence, concurrency and error shapes return to the Architect at that plan's plan-written gate
