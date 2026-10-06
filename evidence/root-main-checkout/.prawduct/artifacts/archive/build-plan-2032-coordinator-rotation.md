---
artifact: build-plan
version: 2
scope: 2032-coordinator-rotation
branch: fix/2032-coordinator-rotation
partition: serial — each chunk consumes the previous one's record and states
critic_mode: cumulative-final
last_validated: 2026-09-29
lifecycle: completed
archived: 2026-09-29
maintained: false
---

> **Archived — no longer maintained.** This plan records what was built, not what will be. Do not edit it to reflect later changes; write those where they are true.

# Build plan — #2032: governed coordinator context rotation (E1–E3 vertical slice)

Canonical design (Architect): /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/2032-coordinator-context-rotation-emergency.md
Dispatch: Architect message e2f2d7c2 (2026-09-28T23:56Z), PM message 97cce8ef. Boundary: no push, no PR;
final handoff = full relevant suite + Critic + one exact head + independent exact-head review.

## Confidence Check

**Problem.** A Codex coordinator that is `/clear`ed keeps its startup-control channel bound to the
pre-clear thread. `observeActivity` returns `unknown/thread-not-loaded` on every tick, the Medusa wake
records `engine-thread-unknown` forever, and nothing tells the replacement context that it is a
re-entry or proves it reconciled before it dispatches again. No code path can replace a recorded
thread (by design), no code runs when `/clear` is injected, and there is no dispatch fence.

**Success.** A managed rotation — and only a managed rotation — moves a session through
`preparing → fenced → rebinding → reconciling → active`:
- prepare persists a validated, digested checkpoint plus the inbox interval and fences the project's
  new outbound dispatch (Medusa sends that are not replies);
- the server injects `/clear` when the coordinator thread is idle, then binds exactly one proven
  replacement Codex thread (new, same cwd, root, sole candidate, old one gone) by compare-and-set,
  under a new coordinator generation, and delivers a re-entry turn through the control channel;
- the replacement context submits a resume receipt naming the generation, checkpoint digest and
  reconciled facts; the server cross-checks what it can observe (generation, digest, launch, the
  prepare-time inbox interval is drained) and only then lifts the fence in the same transaction;
- every step is idempotent by attempt key and resumable after interruption; stale generations and
  replays are refused; ambiguity stays non-active with a typed reason.
Ordinary launch, ordinary wake, the #1978 multi-thread rules and #1761 Claude re-entry are unchanged,
and `observeActivity` still never replaces a recorded thread.

**Out of scope (E4 and later).** Full wrap/relaunch parity; the operator-surface UI for rotation
state; re-entry delivery for engines without a control channel (Claude keeps #1761 — rotation there
reports the rebind step as not-applicable and names `tc`-free recovery); server-side GitHub
reconciliation (the receipt carries it as asserted evidence); PM-side worker hold policy.

## Requirements Confidence: MEDIUM

- [ASSUMPTION: Codex `/clear` leaves the old thread unloaded and loads exactly one new root thread
  in the same cwd on the same app-server.] Consistent with the incident evidence (old thread no longer
  loaded, wake reports thread-not-loaded). If the old thread remains loaded, rebind fails closed with
  `prior-thread-still-loaded` rather than guessing — safe, but would need a follow-up.
- [ASSUMPTION: "dispatch" to fence = new outbound Medusa sends from the rotating project; replies
  (`inReplyTo`) stay allowed so the replacement can answer verification questions while reconciling.]
- [ASSUMPTION: "inbox high-water mark" = the ids of the messages in the in-memory inbox at prepare;
  "drained" = none of those ids remain at resume. Newer arrivals stay queued.]
- [DECISION: schema v51 for `coordinator_rotations`. #1971 and #1966 also claim v51; whichever lands
  second renumbers. Flagged to the Architect.]
- Stale-generation limit: old and new contexts share one pane and one launch credential, so a stale
  generation is only distinguishable on generation-bearing calls (rotation routes, resume). Flagged.

## Chunks

### Chunk 01 — E1: reproduce, rotation record, prepare, fence
- Test first: the observed incident — recorded thread gone, replacement loaded — is
  `thread-not-loaded` and the binding is kept (ordinary observation stays fail-closed).
- `coordinator_rotations` table (v51 migration + fresh DDL + postcondition), store API with CAS
  transitions, one non-terminal rotation per project.
- `lib/coordinator-rotation.js`: checkpoint validation (schema 1, required sections, size bound,
  canonical-JSON SHA-256), idempotent `prepare`, `isFenced(projectId)`.
- Fence: Medusa `send` from a fenced project refuses non-reply sends (409 COORDINATOR_FENCED).
- Done when: migration + prepare + fence tests green, observe tests unchanged.

### Chunk 02 — E2: managed clear, authenticated rebind, re-entry turn
- `advance(rotationId)`: wait for idle prior thread, inject `/clear` once (recorded), then select the
  replacement: new since prepare snapshot, same cwd, not subagent, sole candidate, prior not loaded.
  Zero / two / prior-still-loaded / wrong cwd / channel changed → typed failure, no bind.
- Rebind is a CAS on the channel (`threadId === prior`, same sequence, open) plus generation+1 in one
  record transition; a retry after crash converges.
- Re-entry turn via the channel (`turn/start`, `clientUserMessageId` = rotation-derived digest),
  checking `thread/turns/list` for an echoed item before sending so retries never duplicate.
- Wake: sessions with a non-active rotation are skipped (`coordinator-rotating`).
- Done when: happy path + every rejection + crash-retry tests green.

### Chunk 03 — E3: resume proof and fence release
- `resume({rotationId, attemptKey, generation, receipt})` from the verified launch: requires state
  `reconciling`, current generation, checkpoint digest match, required receipt sections, prepare
  interval drained; writes receipt + `active` + fence lift in one transaction. Stale / incomplete →
  refused, stays fenced, reports missing evidence.
- Routes: `POST /api/sessions/:project/rotation` (prepare+start), `GET …/rotation` (state, checkpoint),
  `POST …/rotation/advance` (retry), `POST …/rotation/resume`.
- Docs (FEATURES, API doc), CHANGELOG, change-log.
- Done when: full relevant suite green, cumulative Critic, independent exact-head review.

## Architect rulings (message 788ab209, 2026-09-29T00:22Z, replacement Architect f8c15610)

- A1 v51 OK locally only; rebase + next free schema number immediately before the certifying head.
- A2 BLOCKING: every coordinator-authority mutation (new dispatch, replies, Medusa ack/close,
  publication/finalization, control hold/release/stop) must be stale-generation-safe: replacement
  generation + server-minted capability delivered only in the re-entry turn, stored hashed. Reads stay open.
- A3 BLOCKING: coordinator control mutations fenced; operator-only recovery/abandon kept.
- A4 BLOCKING: checkpoint enumerates repo/ref/issue/PR facts; a trusted server-side reader re-observes;
  unavailable/mismatch keeps the fence and is stored as typed drift.
- A5: E4 (full relaunch parity + operator surface) is in certifying scope; E1–E3 local checkpoint OK.
- A6 BLOCKING: prepare verifies a durable coordinator role/delegation; the checkpoint role is not authority.
- A7 BLOCKING: git reconciliation covers path/ref/HEAD/status/declared owned dirt with server fingerprints
  at prepare and resume.
- A8 BLOCKING: an allowed coordinator state/clearance is enforced; the readiness verdict is persisted.
- A9: idle inbound wake of the replacement Architect not yet proven; keep as an acceptance test.
- Open questions sent (Q1 drift acknowledgement, Q2 capability carrier, Q3 mutation list, Q4 E4 surface).

## Follow-up rulings (message 3979eb3a, 2026-09-29T00:26Z)

- A6a: authority is NOT inferred from control assignments. Add an Operator-created durable
  coordinator-role contract keyed by project, role, status, authority version; prepare records its
  id/version. A control delegation may supplement it only if it explicitly grants coordinator-rotation scope.
- A10 (Q1): two drift classes. Trusted observations (GitHub state) may drift during absence; resume
  accepts only if every item has a stable key + before/after digest and the receipt gives a typed
  disposition and an updated next action. Unavailable evidence and unacknowledged drift block.
  Authority/identity/generation/control-binding/local-checkout-integrity drift is NOT self-accepting:
  it stays fenced for Operator recovery. Persist observations and dispositions.
- A7a: hash the tracked diff and each declared untracked owned file (expand untracked dirs); include
  declared important ignored files; never crawl dependency/build caches. Prepare refuses undeclared
  dirt; resume local-content drift is a hard blocker.
- A11 (Q2): no bearer secret in argv/history/persistent env. tc forwards CODEX_THREAD_ID as an
  engine-thread header; the server binds it to replacementThreadId + generation + session + launch.
  A one-time resume nonce rides only in the re-entry instruction and the resume body, stored hashed.
  Once a coordinator has an epoch, every later coordinator-authority mutation needs the exact active
  epoch + current thread/launch binding. Never-rotated projects keep legacy behavior.
- A12 (Q3) gated list: Medusa send (incl. replies), message ack/read, exchange close, workload set,
  handoff publication, wrap/finalize, session-rule writes, control hold/create/release/stop/ack.
  Reconciling allows only: reads, workload set from the bound replacement, control ack of the exact
  observed generation, resume, and replies + ack/close limited to checkpoint-interval
  messages/exchanges. After active, all listed mutations need the current epoch binding. Operator exempt.
- A13 (Q4): API + tc/fleet read surfaces (state, blocker, checkpoint digest, receipt verdict,
  exactly one next command); dashboard deferred. Relaunch: prepare on the old launch, fence persists;
  replacement claimed by an explicit server-managed relaunch transition that atomically binds the exact
  new session + launch; zero/multiple/unclaimed launches stay fenced; only then epoch + re-entry + resume.
- [ASSUMPTION: Codex exports CODEX_THREAD_ID into tool shells] — verify before relying on it.

### Chunk 04 — A6a coordinator-role contract; A7a checkout content fingerprint
### Chunk 05 — A11/A12 epoch binding (thread header + resume nonce) across the gated mutation list
### Chunk 06 — A10 trusted GitHub re-observation + drift classes; A8 readiness verdict
### Chunk 07 — E4 relaunch claim + operator read surface (A13)

## Status

- [x] Chunk 01 — E1
- [x] Chunk 02 — E2
- [x] Chunk 03 — E3
- [x] Chunk 04 — A6a + A7a
- [x] Chunk 05 — A11/A12 epoch binding
- [x] Chunk 06 — A10 + A8
- [x] Chunk 07 — E4 (A13)

## A18 ruling (message b23037a2, 2026-09-29T01:31Z) — 8b160286 NOT a candidate

Chunk 08 — A18 fixes:
1. Toggle while reconciling: only idempotent enable=true from the bound replacement; disabling stays fenced until active. Test both.
2. W1: serialize /advance with drive()/_driving — one re-entry turn, one live nonce. Test the race.
3. W2: a first-pass driver throw persists driver-stopped / fail-closed evidence.
4. W3: operator exemption uses resolveControlCaller-equivalent verified operator, not resolveAccess shape.
5. W4 docs: thread header is attribution + comparison, not authentication; subagent sharing launch env not cryptographically excluded.
6. W5: refused/held injects and in-progress clear must not burn attempts or type duplicate clears; count only proven admitted attempts; bounded observation/backoff; test HOLD, missing pane, slow unload, retry.
7. W6: cap importantIgnored count/bytes/path length; batch check-ignore; fingerprint off the event loop with a total deadline; test caps + timeout.
8. N5/N6/N7: reject all-dot repo segments; bound GitHub re-observation by total time/concurrency; cap canonical JSON depth; safe temp path in the live script.
9. N8: gate POST /api/sessions/:project/command; include sessions mutation family in registry coverage; classify startup-prompt fire and wrap-sentinel ack explicitly.
10. Prove no persistent/tester DB stamped v52 by 2534e1c1; report search/reset evidence.
N1 accepted as intended; N2/N3 need regression tests (awaiting RM03 text).
- [x] Chunk 08 — A18
