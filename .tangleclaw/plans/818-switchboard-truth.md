# v5.13.0 — The Switchboard Tells The Truth

**Tracking issue:** [#818](https://github.com/Jason-Vaughan/TangleClaw/issues/818) (rollup) · **Milestone:** Session Switchboard
**Composed:** 2026-08-21 · **Status:** roster ratified, no car started
**Hosted mirror:** https://claude.ai/code/artifact/097ad1cb-6325-4b8c-b547-5a0e97bc259c (updated in place)

---

## Why this train, and why now

**This is an un-honored release gate, not new work.** #818 opens with an operator ruling dated
2026-07-31: *"a working Switchboard is a **v5 release requirement**, not post-v5 polish."*
v5.0.0 shipped 2026-08-13 without it. Twelve minor releases have gone out since.

**The blocker has moved to our side of the wire.** #818's proposed cut named seven issues — five in
TangleClaw, two in Medusa. The Medusa half is **done**:

| Issue | State | Closed |
|---|---|---|
| Medusa#25 — `medusa_hook` to a nonexistent workspace returns success | CLOSED | 2026-08-15 |
| Medusa#22 — presence ≠ deliverability; broadcast delivers 0/N | CLOSED | 2026-08-15 |
| Medusa#31 — three disjoint ID namespaces | CLOSED | 2026-08-15 |

`Jason-Vaughan/Medusa` has **zero open issues**. The bus was fixed six days ago. TangleClaw's six
integration issues have not been touched since early August. "Who drives the Medusa half" — #818's
third open follow-up — is answered: nobody needs to.

**We just put the Master on this channel.** v5.12.0 (#996, both chunks) made the Project Master a
switchboard participant — the one session with a fleet-wide view now rides a bus with no delivery
guarantee. Every car below makes that shipped feature more true.

**A third-party report is sitting on the subsystem.** #1075 (GURULifeline, 2026-08-21) reports the
roster endpoint returning `502 BRIDGE_UNREACHABLE`. It does **not** reproduce here — a live probe of
`GET /api/sessions/Medusa/medusa/roster` returned 200 with a full workspace list. Off-train and
tracked; see "Open questions".

## The completion test

**This train is done when operator project rule #5 can be deleted.**

That rule is a six-step manual procedure the operator wrote because the channel lies. Its own text
names the exit condition: *"Until #791/#792/#785/#784 land, treat the following as the procedure
rather than as improvisation."* Each step maps to a car:

| Rule #5 step | Retired by |
|---|---|
| 1. Keep your own watermark (`read` is advisory) | Car 1 (#784) |
| 2. Verify delivery, never assume it (peek at the peer's pane) | Car 2 (#792, #791) |
| 3. Then inject, but check the prompt first (draft-clobber) | Car 1 (#812) |
| 4. tmux targets must be exact | Car 3 (#1025 addressing) |
| 5. Consent is not optional | stays — a norm, not a defect |
| 6. Instruct the peer to verify rather than recall | stays — a norm, not a defect |

Steps 5–6 are genuine collaboration norms and survive as a shorter rule. Steps 1–4 are workarounds
for defects and go away with them. **The deliverable is the rule shrinking, and it is externally
checkable** — a property this subsystem otherwise lacks, since its whole failure mode is looking
fine from one side.

---

## The cars

### Car 1 — Stop the bleeding, and give the inbox a lifecycle
**#812 · #784 · #785**

`#812` rides first because it is the only car that can **destroy operator work** and it is
independent of everything else. `lib/tmux.js:529#sendKeys` pastes via `load-buffer`/`paste-buffer -p`
and then fires `Enter` unconditionally — with no read of what is already at the prompt. tmux
*appends*, so injecting onto a half-typed line submits the operator's text with our payload glued on.
Verified against the tree 2026-08-21: there is no prompt check anywhere in the function.

`#784`/`#785` are the foundation the rest of the train assumes: that **"handled" is a real state**.
Verified against the tree:

- `lib/medusa-listener.js:93` — `this.inbox = []`, in-memory, capped at 500, not persisted.
- `lib/medusa-listener.js:169#markRead` — mutates `this.unread` (a scalar) and the
  `_unackedIds`/`_ackAwaiting` sets that drive Hub ACKs. **Not one line writes to a message object.**
- `lib/medusa.js:195#getMessages` — returns `listener.inbox.slice()` raw.

So `read` comes back `None` because the field is never created. The ACK path is correct; TangleClaw
then keeps its own untouched copy forever and every reader re-derives "is this new?" from scratch.

### RULING 2026-08-21: clear on delivery — with the delivery event made real first

The operator ruled clear-on-delivery. Investigating the mechanism before coding surfaced a
tension that changes the shape of the car, so it is recorded here rather than folded silently
into the build.

**The literal reading destroys mail.** `markRead()` already ACKs to the Hub, and the Hub drops
an ACKed message from its durable queue permanently (TC#547, `lib/medusa-listener.js:110-119`).
The dashboard sends bodyless `POST /medusa/read` from `openInbox()` (`public/api-helper.js:2506`)
the moment the operator *opens the panel*. So "remove from the inbox on markRead" would delete
the last remaining copy of a message at the instant the operator glances at it — which is
**#785's data loss, promoted from a bug to a design**.

**The word doing the work in the ruling is "properly delivered."** Today `markRead` does not mean
delivered; it means a badge was cleared. So the car's real content is:

> **Make "handled" a real event, and key both irreversible actions off it** — the Hub ACK and
> inbox removal. Clearing the unread badge stops being the trigger for either.

That single change is the common root of both #784 and #785, which is why they belong in one car:

- `POST /medusa/read {ids}` = *I handled these* &rarr; those messages leave the inbox **and** are
  ACKed to the Hub. This is clear-on-delivery, as ruled.
- `POST /medusa/read` with no body = badge clear only &rarr; resets `unread`, **no ACK, no
  removal**. (Behaviour change: today the bodyless form ACKs everything.)
- Un-handled mail therefore stays queued Hub-side, so a fresh listener re-drains it on register.
  **This makes #785's silent loss structurally impossible** rather than merely detected.

**#785's stated root cause was a hypothesis; the verified mechanism is narrower.** The issue guessed
at "a new active session row." The registry keys the workspace id by `sessionId`
(`lib/medusa-registry.js:135`), so a new session row mints a *new* id and cannot produce the reported
signature. The reachable trigger is **toggle-off then toggle-on** (`server.js:3692-3694`,
`lib/projects.js:2172-2174`): `stopSession` drops the listener, `startSession` builds a fresh one, and
`ensureWorkspaceId` returns the *same* persisted id — same workspace id, `listening`, empty inbox.
A TC restart does the same. Un-ACKed redelivery fixes both.

Also carried, per #785's minimum ask: log a non-empty &rarr; empty inbox transition, so a loss is
never silent even if one becomes possible again.

**Superseded by the ruling above — kept for the reasoning:**

1. **Stamp** — add a real per-message `read`/`handledAt`, set it in `markRead`, let `GET` filter or
   expose it. Backwards-compatible; keeps history in the inbox; every consumer must still opt into
   filtering.
2. **Clear on delivery** — remove ACKed messages from `this.inbox`. Simpler contract, no flag to get
   wrong, makes the common bug structurally impossible.

Operator leans (2) — *"once a message is properly delivered it should be cleared from the switchboard
right?"* — and it is the stronger design. **Blocking dependency to resolve first:**
`lib/medusa.js:505#getLoops` iterates `listener.inbox` to re-learn loop ids from messages tagged
`loopId`. Clearing the inbox removes that history. Loop state needs a home that is not the inbox
before (2) can be committed to. Cost that out as step one of this car.

### Car 2 — Delivery is receipted, not assumed
**#792 · #791 · #934**

The sender must learn whether the session was actually told. Today `{"status":"received"}` from the
hub means the *hub* has it — the peer may never have been woken, and the operator becomes the
transport. `#934` belongs here rather than with the UI cars: notifications not clearing is a missing
ACK, which is the same lifecycle question as the receipt.

Per #818, a **TangleClaw-side receipt is an acceptable shape** — the guarantee is testable from here
alone and does not require touching Medusa's architecture.

### Car 3 — Injection reaches the right reader
**#783 · #1025 · #998**

Three ways a nudge lands on the wrong reader: a focused **subagent** absorbs it (`#783`, false-idle
read with no agent-focus gate); **any** running agent in a session can pick up mail meant for the
session (`#1025`, no addressing); and the shared-doc watcher nudges **the session that wrote the
file** (`#998`, a self-inflicted wake loop into a live pane).

### Car 4 — Identity survives a restart
**#1023** — SHIPPED 2026-08-21.

A peer restart rotates its ephemeral workspace id and sends hard-fail `SEND_REJECTED`.

**This plan's original guess was wrong, and is kept here as the record.** It said to check whether
#996's home-pinning generalizes to project sessions. It does not apply: home-pinning stabilises the
*receiver's own* id, while #1023 is the *sender's* problem — a cached handle for someone else. And
project ids are meant to rotate, because `forgetSession` drops the registry entry at session end.

**The fix recommended on the issue is also wrong, and would have passed its own tests.** #1023 quotes
Medusa's advice to target the human-readable name. Medusa matches a WS-only client — all TangleClaw
registers — by `id.split('-')[0]` (`medusa-server.js:230`), so `tilt-v2-8ef50ea0` answers to `"tilt"`
and never to `"TiLT v2"`: every multi-word project silently 404s, **including the one in the issue's
own reproduction**, while single-word projects work and make it look correct. `"TiLT v2"` and
`"TiLT Claw"` also collide on `"tilt"`.

**What shipped:** a not-found is treated as a stale handle first and a missing peer second.
`sendMessage` and `openLoop` re-resolve against the live roster by TangleClaw's OWN id convention
(`<name-slug>-<8 hex>`, whole-slug match) and retry once, reporting `retargetedFrom`; ambiguity
refuses and lists candidates.

### Car 5 — The surfaces stop lying
**#836 · #820 · #556**

Listeners outlive their sessions and the roster reports dead sessions as `connected` (`#836`) — the
same class of lie as Medusa#22, on our side. The Medusa control renders on every session page
regardless of `medusaEnabled`, because the flag gates autostart and not the surface (`#820`). The
live-loop glow overrides mark-state filters, so blue on gold reads green (`#556`).

### Car 6 — The channel teaches itself, and the rule comes down
**#912 · #1020 · #904** → **delete project rule #5 steps 1–4**

The wake nudge omits the reply obligation, so initiators hang silently (`#912`). It points at a
"project guide" that never states the base URL — dangling for every plugin-governed project
(`#1020`). And generated project rules never mention the switchboard at all, so sessions cannot use
infrastructure they were never told exists (`#904`).

`#904` is the exact counterpart of the completion test: **the workaround leaves the operator's
hand-written rules, and the capability enters the generated ones.** Engine-agnostic rule applies
directly — the generated text must interpolate each engine's own config filename, never `CLAUDE.md`.

---

## Explicitly not on this train

**All switchboard automation: #801 · #979 · #1040 · #1041 · #1042 · #1043.** #818 gates these on the
delivery guarantee, and they are the fastest way to make the train never leave. Auto-inject built on
a channel that drops messages automates the lie.

**Also off:** #810 (always-on steward session class), #868 (stranded wrap discoverability), #1084
(shared-doc broadcast reaches the Master — a feature, and #818's cut says features wait), #1075
(does not reproduce).

---

## Verification stance — read this before scoring any car

**This subsystem's entire failure mode is that it looks correct from one side.** A green suite is not
evidence a message arrived. Per `reference_live_verification_traps` and
`feedback_wait_conditions_must_be_falsifiable`:

- Cars 1–2 are not done on a unit suite. **The bar is a real two-session round trip** against the
  Medusa session (`feedback_switchboard_test_target` — Medusa is the sanctioned target; any other
  live session means ask first and wait).
- `pgrep` never matches in-process agents and mtime fires on unrelated writes. Any wait condition
  used to score a round trip must be falsifiable — name the mutation that turns it red.
- Never `2>/dev/null` in a wait condition: it turns "broken" into "not yet".

## Open questions for the operator

1. **#784's design fork** — stamp vs clear-on-delivery. Recommendation: clear-on-delivery, *after*
   `getLoops` gets a home for loop state that is not the inbox. Needs a ruling before car 1 codes.
2. **#1075 (GURULifeline)** — does not reproduce; roster returns 200 here. Reply asking whether it
   was transient or persists on his install? Third-party reports are the only place several defect
   classes are observable at all (`project_field_installer_elliot`), and the batched-release model
   has no fast lane for them yet (`project_post_v5_release_cadence`).
3. **Does #818 close with this train, or stay open** for the deferred automation half?

## Status

- [x] Car 1 — Stop the bleeding, and give the inbox a lifecycle (#812, #784, #785) — 2026-08-21: `markRead` split into an inert badge clear and `markHandled(ids)`; route carries both verbs; panel reports the ids it rendered; loop ids learned on arrival; `sendKeys` clears the prompt and logs the draft first. Suite green (6629 pass, 0 fail); 7 mutations red. Review pending.
- [x] Car 2 — Delivery is receipted, not assumed (#792, #791, #934) — 2026-08-21: `medusa_deliveries` ledger (schema v30) mirroring #595; every terminal path in `_scanSession` records `nudged`/`failed`/`skipped`+reason, deduped per (edge, outcome) so it logs events not polls; `GET /api/medusa/deliveries` fleet query + per-participant route. **#934 was already satisfied** — probed live: the listener transmits `{"type":"ack","messageIds":[...]}` on handled, which is its Required Fix option 2; propose closing rather than building. Suite green (6643 pass, 0 fail); 4 mutations red.
- [x] Car 3 — Injection reaches the right reader (#783, #998; **#1025 descoped, see below**) — 2026-08-21: `agents-running` gate in `_assessPane` pinned to #783's verbatim live capture; `broadcastSharedDocUpdate` skips the project whose directory holds the doc, via a new `isInsideProject` sibling in the containment module. Suite green (6648 pass, 0 fail); 2 mutations red.

### #1025 is NOT deliverable from TangleClaw alone — verified in Medusa's source

`#1025` asks for provenance in the envelope so a receiver can tell a subagent-sent
message from a main-session one. **A TangleClaw-side stamp would be silently dropped
before delivery.** `Medusa/src/medusa/medusa-server.js:889` builds the delivered
envelope from a fixed field whitelist:

```js
const msgPayload = { id, type: 'direct', from: data.from, to: targetId,
                     message: data.message, timestamp };
```

Both delivery paths use that object — the live WS push (`:905`) and the durable
offline queue (`:902`) — so any extra field in TangleClaw's `POST /messages/direct`
body never reaches the receiver. Adding one would have shipped as a green-tested
no-op. Provenance needs a **Medusa-side** change, and TangleClaw does not write to
Medusa's repo (cross-session write boundary). File it there; do not build it here.

The TangleClaw half that IS ours already exists: the fleet detector built for #783
is exactly the signal that can distinguish a subagent-originated send, and it can be
reused the moment the envelope has somewhere to put the answer.
- [x] Car 4 — Identity survives a restart (#1023) — 2026-08-21: re-resolve-and-retry-once on `sendMessage` and `openLoop`, matching TC's own id convention rather than Medusa's `split('-')[0]` name matching (which 404s every multi-word project). Suite green; 4 mutations red.
- [ ] Car 5 — The surfaces stop lying (#836, #820, #556)
- [ ] Car 6 — The channel teaches itself, and the rule comes down (#912, #1020, #904)
