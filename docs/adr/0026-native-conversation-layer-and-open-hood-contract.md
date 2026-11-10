# ADR 0026: Native Conversation Layer over Persistent Harness Sessions and the "Open Hood" Non-Interference Contract

**Status:** Ratified — 2026-11-10 (`OP-GO-V6-GATE0-20261110`, `ODR-V6-01`, `Ruling A511-V6-R4-DELTA-COSIGN`, `OBSR-V6-R4-DELTA-SIGNOFF-20261110`)
**Date:** 2026-11-10
**Decision Owners:** Operator and TangleClaw Architect
**Amends:** ADR 0008 (`docs/adr/0008-project-master-session-model.md`) — supersedes Decision 6 ("The chat surface IS the terminal") and the "Alternatives considered" UI rejection while preserving Decisions 1–5 and all subsequent security/authority amendments (`#755`, `#968`, `#966`, `#2132`, `#2950`, `ADR 0023`).
**Builds on:** ADR 0008 (persistent harness-session model), ADR 0015 / ADR 0016 (TangleClaw-owned authentication and CSRF/WS gates), ADR 0017 (phased launch sequences), ADR 0018 (owned `ttyd` runtime), ADR 0020 (session workload receipts and activity observer), ADR 0023 (Master-mediated operator bridge).
**Source:** TangleClaw v6 Consolidated Product, Architecture & Development Plan — Initiative B (B1 Application Shell, B2 Native Conversation Layer), Part IV Item 1, and Issue `#2976`.

---

## Context

ADR 0008 established two separate architectural propositions:
1. **Runtime substrate (Decisions 1–5):** TangleClaw agents (including the global Orchestrator / Project Master and project sessions) are persistent, supervised harness sessions running in `tmux` under TangleClaw's lifecycle, identity, hook, and authority governance—not an unsupervised, TangleClaw-rolled direct LLM API loop.
2. **Presentation surface (Decision 6):** *"The chat surface IS the terminal"* — operators interact with the Orchestrator and project sessions directly inside a `ttyd` WebSocket terminal iframe (`/terminal/?arg=<session>`).

Proposition 1 proved sound and remains the foundation of TangleClaw's reliability, tool sandboxing, and multi-engine orchestration. Proposition 2 (Decision 6), however, became the primary usability bottleneck of the platform:
- Terminal emulators break standard browser text editing, selection, copy/paste, undo, and drag-and-drop file/image attachment.
- Routine tool execution, diff output, and test logs bury conversational responses, decisions, and approval prompts.
- Operators cannot see a deterministic queue of pending messages, delivery states (`queued`, `delivering`, `delivered`, `answered`), or structured interactive decision cards (`lib/decision-routing.js`, `lib/permission-requests.js`) without reading raw terminal scrollback.

TangleClaw v6 Initiative B2 replaces the terminal-as-primary-chat surface with a **Native Conversation Layer** while retaining the persistent harness session as the execution authority and keeping `ttyd` available on demand behind an **Open Hood** action.

---

## Decision

### 1. ADR 0008 Decisions 1–5 and Security Amendments Remain in Full Force

The Native Conversation Layer is a **structured presentation, event, and input-delivery layer over existing persistent harness sessions**—never a replacement runtime:

1. **No parallel LLM host:** TangleClaw does not call model provider completion APIs directly to conduct project or Orchestrator conversations. Every conversation turn executes inside the bound harness session (`tangleclaw-master` for the Orchestrator; the project/resource `tmux` or gateway session for fleet lanes) so all engine hooks, `session_rules`, launch sequences (`ADR 0017`), and `PreToolUse` guards (`#755`) remain enforced on every turn.
2. **Orchestrator singleton invariants preserved:** The global Orchestrator (`tangleclaw-master`, canonical role `Orchestrator` per `#2127`) retains no `sessions` row, no `projects` row, its dedicated `~/.tangleclaw/master/` data directory, its structural `.access-level` guard, its `tc_master_` lifecycle authority token (`lib/master-authority.js`), and its `bridge-principal` credential (`ADR 0023`).
3. **Owned `ttyd` runtime preserved (`ADR 0018`):** `~/.tangleclaw/bin/ttyd` remains TangleClaw's managed terminal runtime and is mounted on demand via the **Open Hood** action.

### 2. Canonical Conversation Event & Turn Model

Every session (`project` session or `orchestrator` singleton) exposes a durable, append-only **Conversation Event Ledger** (`conversation_events` in SQLite, scoped by `session_scope_key` and `launch_id`) with monotonically increasing per-session `seq` numbers.

1. **Normalized Event Taxonomy:**
   - `user.message`: Operator or authorized coordinator message submitted via the Native Conversation UI or API, carrying client `idempotency_key`, optional `attachments[]` (resolved via secure file transfer), and delivery state.
   - `agent.turn.started` / `agent.message.delta` / `agent.message.completed`: Structured assistant prose extracted by the engine conversation adapter.
   - `agent.activity.summary`: Compact, collapsible summary of tool calls, file edits, command executions, and test runs (hidden/collapsed by default in normal chat; expandable inline or inspectable in full via **Open Hood**).
   - `session.approval.requested` / `session.approval.resolved`: First-class interactive cards bound to `permission_requests` and `decision_requests` (`lib/decision-routing.js`), carrying `promptDigest` and authority class.
   - `session.lifecycle.notice`: Authoritative runtime transitions (`launch.ready`, `model.switched`, `wrap.started`, `wrap.completed`, `recovery.triggered`).
   - `conversation.tombstone`: Tombstone deletion/redaction record preserving monotonic `seq` continuity when an authorized Operator or Project Owner purges a turn or attachment under SQLite secure deletion (see Decision §3.4).
2. **Engine-Adapted Extraction Tiers, Reliability & Strict Non-Fabrication (Honest Capability Reporting per ADR 0013):**
   - **Tier A — Structured Stream / Hook Adapters (Preferred & Authoritative):** Engines that emit structured JSONL transcripts, hook callbacks, or gateway events (e.g., Claude Code transcript/hook stream, Codex structured session log, Antigravity/Gemini structured log, OpenClaw gateway stream) feed the adapter directly without scraping ANSI terminal redraws.
   - **Tier B — Sanitized Pane-Diff Adapter (Explicitly Degraded Fallback & Non-Fabrication Contract):** Engines without a structured transcript stream use a deterministic pane-capture delta adapter (`lib/activity-observer.js` / `lib/medusa-wake.js` primitives) that strips ANSI control sequences and TUI chrome, subject to three mandatory reliability rules:
     1. **Explicit Provenance & Degraded-Fidelity Disclosure:** Every Tier-B event is tagged `source: 'pane-derived'` in the API payload and renders a visible **`Terminal-Derived (Degraded Fidelity)`** badge in the UI header with a 1-click prompt to open **Open Hood** (`ttyd`).
     2. **Strict Non-Fabrication of Turn Boundaries:** The Tier-B adapter must **never** synthesize or guess fake `user.message` or `agent.message` turn boundaries from ambiguous terminal redraws, spinners, progress bars, or TUI status updates. When structured speaker/turn attribution is not provably anchored to a verified prompt/delivery boundary, output is emitted strictly as an unfabricated `agent.activity.summary` / raw terminal delta block rather than a fabricated conversational turn.
     3. **Idempotent Deduplication Across Resizes & Reconnects:** The Tier-B adapter maintains a persistent `(launch_id, pane_cursor_watermark, rolling_line_sha256)` cursor so terminal window resizes (`SIGWINCH`), `tmux` attach/detach cycles, or SSE/WebSocket reconnects **never** emit duplicate turns or replay scrollback as new messages.
   - Per ADR 0013, each engine profile (`data/engines/*.json`) declares its `conversationAdapter` tier and capabilities (`streaming`, `attachments`, `structuredToolFolding`, `interruptContract`), and the UI states any engine-specific limitation where offered.

### 3. Conversation Ledger Security, Privacy, Retention & Authorized Deletion

Because `conversation_events` persists conversational history and attachment metadata in SQLite, it is governed by four mandatory security and privacy controls:

1. **Default-Deny Project & Workspace Access Controls (`AuthorizationService`):**
   - **Orchestrator Ledger (`tangleclaw-master`):** Strictly **Operator-only**. No project session, Builder, Reviewer, or peer coordinator token may read or subscribe to the global Orchestrator conversation ledger.
   - **Project & Fleet Ledgers:** Scoped strictly to authenticated principals of the **owning Logical Project / Workspace** (the Project Owner/Operator, authorized Fleet Coordinator for that Logical Project, and the session itself). Cross-project read, stream, or write attempts fail closed with `403 CONVERSATION_CROSS_PROJECT_DENIED`.
2. **Pre-Persistence Sensitive-Data Redaction:**
   - Every inbound and outbound event payload (`user.message`, `agent.message.*`, `agent.activity.summary`, `terminal-direct` captures) passes through a deterministic secret-redaction filter (`lib/secret-redactor.js`) **before** being written to SQLite `conversation_events` and **before** being broadcast over SSE/WebSocket.
   - Known credential patterns (`Authorization: Bearer`, `ghp_*`, `sk-*`, `tc_master_*`, `x-tangleclaw-*` launch tokens, Discord webhook URLs, `.env` assignments, and configured custom secret regexes) are replaced in-flight with `[REDACTED:<pattern-class>]` and never hit disk in cleartext.
3. **Configurable Retention Policy:**
   - Global and per-project settings (`conversationRetentionDays`, default `30` days; `conversationMaxEventsPerSession`, default `10,000`) govern automatic background pruning of expired conversation ledgers and attachment staging files.
4. **Authorized Deletion, SQLite Secure Deletion vs. Cryptographic Deletion & Residual-Copy Limitations (`PRAGMA secure_delete = ON` + `PRAGMA wal_checkpoint(TRUNCATE)`):**
   - An authenticated **Operator** or **Project Owner** may redact or purge specific turns (`DELETE /api/sessions/:scope/conversation/events/:seq`), specific attachments, or an entire session/project conversation history (`DELETE /api/sessions/:scope/conversation/history`).
   - **Tombstone & SQLite Secure-Deletion Mechanics (Distinct from Cryptographic Key Destruction):**
     - Purging an event overwrites its SQLite columns (`payload_json = NULL`, `redacted_reason`, `tombstoned_at`, `tombstoned_by`, `event_type = 'conversation.tombstone'`), unlinks any associated attachment files from disk, and executes under SQLite `PRAGMA secure_delete = ON` followed by `PRAGMA wal_checkpoint(TRUNCATE)` while preserving the row's monotonic `seq` number so client cursor pagination and audit continuity never break.
     - **Explicit Security Distinction (`ADR 0013` Honest Disclosure):** SQLite secure deletion (`PRAGMA secure_delete = ON` + `PRAGMA wal_checkpoint(TRUNCATE)`) zeroes freed SQLite B-tree pages and truncates the write-ahead log on disk; it is **database page-overwrite deletion, NOT true cryptographic deletion** (which would require per-record/per-session encryption key destruction).
   - **Four Mandatory Residual-Copy Disclosures & Remediation Rules:**
     1. **SQLite `-wal` Frames:** Until `PRAGMA wal_checkpoint(TRUNCATE)` completes, historical page frames can remain in the `.sqlite-wal` file; therefore the deletion endpoint must run `PRAGMA wal_checkpoint(TRUNCATE)` (or report `walCheckpointPending: true` if blocked by a concurrent reader and checkpoint on release).
     2. **Pre-Existing Database Backups, OS Snapshots & SSD Wear-Leveling:** User-space page zeroing cannot retroactively erase data already copied into external SQLite backups, APFS/Time Machine filesystem snapshots, or unmapped physical NVMe/SSD flash blocks managed by controller wear-leveling.
     3. **External Harness Engine Transcripts (`~/.claude`, `~/.codex`, `.aider.chat.history.md`, Antigravity logs):** Supervised CLI engines maintain their own local session transcripts outside TangleClaw's SQLite database. Every deletion response must return an explicit `residual_locations[]` array enumerating any detected external engine transcript paths for that session and invoke engine-specific transcript scrub hooks where supported.
     4. **Live `tmux` Pane Scrollback:** In-memory `tmux` scrollback buffers retain terminal output until cleared; when purging a live session's history, TangleClaw automatically executes `tmux clear-history -t <session>` and records `tmuxHistoryCleared: true` in the deletion receipt.

### 4. Transport, Queue Prioritization vs. Active Turn Interruption

1. **Authenticated Event Stream & REST Commands:**
   - **Read / Stream:** `GET /api/sessions/:scope/conversation/events?afterSeq=<n>` (paginated history + SSE/WebSocket live tail, gated by Tier-1 session authentication and `AuthorizationService` project/workspace scope). Reconnecting clients pass their last seen `seq` and replay missed events deterministically without context loss or duplicate rendering.
   - **Write / Enqueue:** `POST /api/sessions/:scope/conversation/messages` (requires authenticated principal + CSRF/token proof + `idempotencyKey`).
2. **Visible Queue & Delivery State Machine:**
   - Every outbound message transitions deterministically through:
     `queued` → `delivering` → `delivered` (confirmed in harness input or structured channel) → `answered` (or `failed` / `cancelled`).
   - If the target harness session is `busy` (turn in flight per `lib/activity-observer.js`), new messages are held in the visible server-side session queue (`queued`) where the operator can edit, reorder, or cancel them before delivery.
3. **Strict Separation of Queue Prioritization vs. Active Turn Interruption:**
   TangleClaw treats **prioritizing a queued message** and **interrupting a live in-flight turn** as **two distinct operations** with separate API endpoints, separate UI controls, and separate safety rules:
   - **Operation A — Queue Prioritization (`POST /api/sessions/:scope/conversation/messages/:id/prioritize`, UI: "Deliver Next at Turn Boundary"):**
     - Moves the specified `queued` message to the head of the pending queue (`priority = 'next-boundary'`) so it is delivered the instant the current in-flight turn finishes.
     - **Sends zero signals or keystrokes to the running harness process.** Safe and supported across 100% of engines.
   - **Operation B — Active Turn Interruption (`POST /api/sessions/:scope/conversation/interrupt`, UI: "Interrupt Active Turn" with explicit confirmation):**
     - Attempts to cancel the currently executing turn mid-flight so the operator can redirect the agent immediately.
     - **Never assumes raw `Escape` or `Ctrl-C` (`SIGINT`) is universally safe.** Each engine profile (`data/engines/*.json`) must declare an explicit `interruptContract`:
       1. `'native-rpc-cancel'`: Structured control-channel cancellation (e.g., OpenClaw gateway cancel or structured harness RPC).
       2. `'verified-sigint-turn-cancel'`: Engine-verified harness interrupt sequence proved by qualification tests to cancel only the current generation turn without exiting the CLI harness or killing child processes/locks unsafely.
       3. `'unsupported'`: The engine cannot safely cancel a mid-flight turn without risking process termination or state corruption.
     - **Fail-Closed Refusal (`409 INTERRUPT_UNSUPPORTED_BY_ENGINE`):** If an engine's `interruptContract` is `'unsupported'` (or unverified), the UI disables the **Interrupt Active Turn** button (offering **Deliver Next at Turn Boundary** or **Open Hood** instead) and `POST /api/sessions/:scope/conversation/interrupt` fails closed with `409 INTERRUPT_UNSUPPORTED_BY_ENGINE`.
     - **Explicit Authorization & Audit:** Active turn interruption requires Operator (or owning Coordinator within lease) authorization, an explicit confirmation prompt in the UI, and records an immutable `session.lifecycle.notice` (`turn.interrupted`) receipt.

### 5. Strict Non-Interference Contract ("Open Hood" Invariant)

**Core Rule:** **Opening, closing, hiding, or switching views must never independently affect the lifecycle of the underlying AI session.**

The Native Conversation View and the `ttyd` Terminal View (**Open Hood**) are **two projections of the same underlying harness session**, governed by four hard invariants:

1. **View lifecycle never mutates session lifecycle:** Opening, closing, hiding, refreshing, resizing, or switching between the Native Conversation View and the **Open Hood** (`ttyd`) terminal view must **never** independently affect the lifecycle of the underlying AI session—it must never kill, stop, wrap, clear, or restart the underlying `tmux` session or harness process.
2. **`HIDE means HIDE, never DISABLE`:** Collapsing tool logs, hiding the **Open Hood** terminal drawer, or hiding telemetry bars only changes visual presentation. Background monitoring, `medusa-wake`, `activity-observer`, hooks, and session execution continue unaffected.
3. **Lazy `ttyd` Attachment:** The browser mounts the `/terminal/?arg=<session>` WebSocket iframe only when the operator activates **Open Hood**, avoiding idle WebSocket/PTY churn across multi-session fleets while keeping attach latency sub-second.
4. **Coexistence of Input:** Direct keystrokes typed inside **Open Hood** remain supported for break-glass/diagnostic use; when the operator types directly in `ttyd`, the conversation adapter observes the resulting turn as `source: 'terminal-direct'` (after pre-persistence secret redaction) so the Native Conversation timeline stays synchronized.

---

## Consequences

- **Usability:** Operators interact with the Orchestrator and all fleet lanes through a modern, fleet-first conversational UI with native text editing, attachments, visible message queues, and inline approval cards, while routine terminal noise stays folded.
- **Safety & Governance Continuity:** Because every turn still runs inside the supervised harness session, zero existing safety investments (phased launch `ADR 0017`, `PreToolUse` guards `#755`, `~/.tangleclaw/bin/tmux` guard `#2946`, workload receipts `ADR 0020`, `control-gate` `#1861`) are bypassed or re-implemented.
- **Diagnostic Transparency:** **Open Hood** preserves 100% of raw terminal access via the managed `ttyd` runtime (`ADR 0018`) without coupling UI tab closures to process liveness.
