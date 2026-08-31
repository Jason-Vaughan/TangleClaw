---
plan: ambient-awareness
title: Ambient Awareness — every TangleClaw session knows what TangleClaw is, on any engine
status: active (shape approved 2026-08-31; Chunk 00 complete, Chunk 01 next)
created: 2026-08-31
branch: feat/ambient-awareness
shared_link: https://claude.ai/code/artifact/830caee7-fd12-4cff-a0e8-9d6bbb8fc522  # keep THIS link updated in place; never mint a new one
issues: [999, 1122, 1021, 1057, 1063, 1085, 1106, 1049]
closes_or_advances: [999, 1057, 1063, 1085, 1049, 1021, 1106]
depends_on:
  - .prawduct/artifacts/prime-delivery-direction.md
  - lib/ecosystem-primer.js
governed_by:
  - .prawduct/artifacts/prime-delivery-direction.md   # § Direction 1-5 (candidate, unratified)
  - .prawduct/artifacts/api-contract.md               # new CLI is a programmatic interface
---

# Ambient Awareness

## The problem, stated once

A TangleClaw-managed session should wake up knowing what TangleClaw is, what it
can do through it, and who else is alive — on Claude Code, Codex, Antigravity,
Aider, or whatever is added next. Today that is true on Claude and false
everywhere else, and TangleClaw reports success either way.

The proximate failure (2026-08-31): a CasaJirafa Antigravity session asked to
message another session had no concept of Medusa, pattern-matched onto
Antigravity's native `SendMessage`, addressed a Gemini brain UUID, invented "that
session is asleep", spawned a local subagent, and reported a fabricated
cross-session exchange to the operator. **Fabrication, not absence, is the
dangerous failure** — an agent that cannot discover it lacks a capability will
improvise one.

## This is bigger than Medusa — it is a defect class with 15 open instances

GURULifeline's follow-up on #1089 landed today and is the same structural failure
wearing different clothes: **TangleClaw asserting a success it never verified.**

A sweep of all 60 open issues finds this is not one bug with three faces. It is
**the single most common defect class in the backlog**, in three related shapes:

**Reports success it never verified**
- **#1012** — OpenClaw connections report healthy while unusable; three of four
  broken and nothing tests past HTTP reachability. *The same sentence as #1089.*
- **#1063** — prime delivery recorded as success when shards are written
- **#1054** — a failed rules fetch renders as an empty list (silent → wrong content)
- **#1061** — manual update-check is dishonest if the server is older
- **#994** — the update pill names the polled version, not the one it will install
- **#1056 / #1055** — a LAN-exposed ttyd job reports not-wide; a stored
  `bindAllInterfaces: true` is invisible in caddy mode *(these two are security-facing)*
- **#1046** — persistent version-cache write failures have no visible diagnostic

**Fails where the operator cannot see it** *(they are almost never on this machine)*
- **#1112** — host GUI dialogs are invisible remotely; an 8-day TCC modal stalled a session
- **#991** — a red `main` is invisible to a session working on it
- **#993** — the live-install checkout can sit on a feature branch and nothing says so

**Couples to one engine and degrades silently**
- **#1085** — `lib/master.js` hardcodes `CLAUDE.md` as the Master's identity filename
  — *the exact defect as `.antigravity.md`, in a second file*
- **#1057** — nothing detects drift in engine-declared `startupInjection.maxChars`;
  its own text names the recorded `codex.json --full-auto` learning, where an
  assertion with both sides in our own repo stayed green for months after the
  upstream flag was removed. **This is `.antigravity.md`'s root cause, already filed.**
- **#1049** — the stranded-config guard misses `.gemini` artifacts
- **#1021** — plugin-governed projects silently lose the PortHub/shared-docs guide
- **#1108** — unprofiled-engine sessions accumulate uncleared broadcasts forever
- **#1106** — the Claude wake profile has no at-rest marker, justified by a comment
  that is **factually untrue** — root cause recorded as *"an unverified assumption
  recorded as settled fact in a comment, then relied on to omit a defence"*

**The through-line:** TangleClaw states facts it has not checked — about the engine
it is driving, about what reached a session, and about what is running on the host —
and reports success either way. Awareness is the largest instance, not the only one.
This plan builds the awareness floor **and** the verification habit underneath it,
which is why Chunk 01's guard is specified against the whole engine family rather
than the one profile that broke.


Their host had **no Medusa Bridge at all** — nothing listening on 3009 or 3010, no
Medusa process, no checkout registered. TangleClaw nonetheless showed a green
`medusaEnabled: true` toggle, minted a workspace id, and ran an endless generic
30-second reconnect loop. An absent external prerequisite was indistinguishable
from a TangleClaw listener defect.

**A measured claim of ours was contradicted, and it should be corrected.** The
2026-08-21 diagnosis mapped `lastError` to bridge condition:

| Bridge condition | predicted `state` / `lastError` |
|---|---|
| Nothing listening | `error` / `Socket error: … non-101 status code` |
| Accepts, then drops | `connecting` / `Connection closed (code 1006)` |

Their install had **nothing listening** and reported the **second** row. The
mapping does not hold, so the whole port-split hypothesis it drove was wrong —
`lastError` cannot currently be trusted to distinguish "no bridge" from "bad
bridge". That is a TangleClaw diagnostics defect in its own right.

Their two prevention requests are correct and are **not** absorbed into this plan
(they are Medusa-listener work, not awareness work) — but they belong to the same
Direction §4 commitment, *delivery confirmed, not assumed*:

1. Preflight the bridge's HTTP health and WS port before enabling, and name a
   missing bridge specifically instead of looping generically.
2. A listener created while the bridge was absent must recover when a healthy
   bridge appears. Today it does not — only restarting `com.tangleclaw.server`
   rebuilt the listener objects.

The pattern across all three instances: **a green surface asserting an unverified
external fact.** The prime ledger said `delivered`. `session.started` logged
`primeLength: 15996`. The Medusa toggle said enabled. None had checked.

## Why 5.15.0 was close, and what it missed

#1122 was right and is **not** being rebuilt. `lib/ecosystem-primer.js` is
engine-agnostic by construction: a declared roster, plain prompt text, HTTP
endpoints, no engine-specific filename anywhere. The content shipped.

Three things sat underneath it:

1. **The carrier never lands on non-Claude engines.** Antigravity's guide is
   written to `.antigravity.md`; Antigravity documents discovery of `GEMINI.md` /
   `AGENTS.md` only. The prime paste that should compensate fires 1500 ms in,
   ~41 s before the agent process exists.
2. **A document cannot carry "the entire understanding" at this scale.** The
   primer roster is 6 bullets. TangleClaw exposes **135 API routes**. The prime
   is budget-capped (10,000 chars on Claude's hook). Any approach that ships
   understanding *as text* is choosing which 4% to send, forever.
3. **The design for all of this already exists and was never ratified.**
   `.prawduct/artifacts/prime-delivery-direction.md` (drafted 2026-07-28)
   commits to declared per-engine channel limits, delivery confirmed rather than
   assumed, and omission visible in the payload. Its own frontmatter reads
   `last_ratified: pending`; it was **withdrawn** at the 2026-08-01 ratification
   pass and binds nothing. That is why per-engine patching continued after it.

**The reframe:** stop treating awareness as a *message* to deliver and start
treating it as a *capability* present in the environment. Push vs pull is one
axis below the real one — both are documents the model must read and obey.

## The one substrate every engine shares

Not context files (different names, different formats, TangleClaw must guess —
and guessed wrong). Not startup hooks (Claude yes, Codex recently, Antigravity
and Aider none). Not MCP (Claude only).

**A shell.** Every engine here runs shell commands constantly and by reflex, and
that is POSIX, not an LLM feature.

TangleClaw already owns that substrate and uses it for nothing.
`lib/tmux.js:452` builds `tmux new-session -e KEY=VALUE`, with a comment showing
the env-before-launch ordering was already worked out. `lib/sessions.js:505`
feeds it only from `launchProfile.launch.env`, which is empty for every engine.

## Architecture — three layers

**L1 — Floor: `tc` on PATH.** TangleClaw prepends its own bin directory to
`PATH` for the launched pane only, via the existing `-e` mechanism. No global
install, no sudo, nothing for a third-party installer to do, no host collision.
A new engine works on day one with no adapter and no filename to guess. `tc` is
a thin HTTP client over the existing API — no local state, no second source of
truth.

**L2 — Target: delivered presence, per engine.** Where an engine *can* place
context, it still should — that is § Direction 3. The bootstrap line shrinks
from a 20 KB guide to one line, so getting the carrier right gets cheap, and the
`ecosystem-primer` roster remains the content.

**L3 — Proof: awareness is observed, not assumed.** The server sees `tc` calls.
A session that never became aware becomes a *detectable state* — the signal that
was missing when this regressed on 2026-08-18 and went unnoticed for 12 days.

## Norm reconciliation (governed_by)

`prime-delivery-direction.md` — candidate, **unratified**, reconciled anyway
because it is the right design and the plan proposes ratifying it:

| Norm | Disposition |
|---|---|
| §1 one concern per channel, limit declared by the engine | **conforms** — Chunk 01 makes the carrier a declared, evidenced engine property |
| §2 context cost scales with relevance | **conforms** — `tc` is the strongest possible form: zero context cost until invoked |
| §3 presence is delivered, not requested | **[DECISION] departure, recorded below** |
| §4 delivery confirmed, not assumed | **conforms** — Chunks 01 and 05 are this norm |
| §5 omission visible in the payload | **conforms** — Chunk 04 |

`[DECISION: L1 is a pointer the agent must choose to follow, which §3 names as
the floor rather than the target | §3 is right, and the CLI does not replace it —
it raises the floor from "nothing, silently" to "a working, honestly-failing
capability", while delivered presence stays the target wherever the engine
allows. The two are complementary, not alternatives. §3 would need amending only
if we ever treated the CLI as sufficient on an engine that could have carried
context. | user can veto/override]`

## Requirements Confidence: **Medium**

Scope and success criteria are clear; two assumptions are unconfirmed.

**Open assumptions**

- `[ASSUMPTION: agents will actually invoke a PATH-present CLI at a useful rate |
  HIGH impact | user can veto]` — PATH presence does not create intent. Chunk 02
  measures this on a live Antigravity session before Chunk 03 builds the full
  verb surface. *What would raise confidence: Chunk 02 itself — do not build the
  surface before the probe.*
- `[ASSUMPTION: the 2026-08-18 Antigravity regression is a boot-duration change
  outside TangleClaw, not a TangleClaw change | MED impact | user can correct]` —
  Train 5 (`a8c747e`) was ruled out and the negative verified (3 lines in
  `lib/sessions.js`, all comment; among engine profiles only `claude.json` and
  `codex.json` touched). Remaining suspects: the `agy` CLI itself and
  `antigravity-oauth-token` rewritten 08-18 22:23. **Chunk 01 does not depend on
  the answer** — a readiness gate is correct regardless of what moved.
- `[ASSUMPTION: `tc` stays a thin HTTP client with no local state | MED impact |
  user can override]` — keeps version skew between binary and server harmless.

## Chunks

### Chunk 00 — Ratify the Direction — **COMPLETE 2026-08-31**
**Type:** doc-only · **Critic mode:** waived

Ratify `prime-delivery-direction.md` (with the §3 amendment above) into the norm
registry and Enforcement table, or reject it explicitly. Rationale: an unratified
norm is exactly what permits "each engine gets the fix when it happens to hurt".
`ea2bfad` (2026-04-02) is titled *"Fix prime prompt firing before Claude engine
is ready"* — the same bug, fixed for Claude alone, four months before it bit
Antigravity. Train 5 then repeated the pattern. Governance, not code, is what
failed to generalize.

**Done when:** the artifact's `last_ratified` carries a date, or the plan records
the rejection and drops `governed_by`.

---

### Chunk 01 — Carrier repair *(urgent; 8 projects broken today)*
**Type:** code · **Critic mode:** chunk

Ordered first ahead of the architectural slice, deliberately: it is small,
independent, unblocks eight live projects immediately, and the bootstrap line of
every later chunk rides the channel it repairs.

1. **Engine config carrier becomes evidenced, not asserted.** `antigravity.json`
   `configFormat.filename` → `AGENTS.md`. Decide Aider's carrier separately — its
   guide currently goes to `.aider.conf.yml`, a YAML config, which is the same
   defect shape. Each profile records the upstream doc and a verified-on date,
   following the precedent already set for Claude's 10,000-char cap.
2. **Readiness-gated paste.** Replace the fixed `startupDelay` with the per-engine
   at-rest marker `lib/medusa-wake.js` already carries and trusts
   (`antigravity: { idleMarker: '? for shortcuts' }`). Fall back to a longer delay
   only where no marker exists.
   **Readiness needs TWO signals, and this is the trap.** v5.14.1 (#1114) replaced
   the lexical wake gate with `lib/medusa-wake.js#_paneDigest` — fingerprint the
   pane, compare across ticks, a difference means the transcript is moving. It is
   exported and engine-agnostic by construction, and it is the right first gate.

   But **digest alone cannot detect readiness**, only motion. `agy` sitting on
   *"Verifying your account…"* is a **static** pane: the digest holds byte-identical
   and reads exactly like a ready prompt. That is the failure this chunk exists to
   fix, so a digest-only gate would reproduce it. Readiness requires a *positive*
   signal that input is being accepted — digest AND an at-rest marker, which is
   precisely the two-independent-signals argument #1106 makes.

   **Dependency: #1106 stands.** Antigravity has its marker (`? for shortcuts`);
   Claude's is `null`, and v5.14.1's own changelog records that as honest rather
   than lazy — *"nothing was found that is present at rest and absent mid-turn"*.
   So for Claude the pair may be unavailable and the gate must degrade with a
   stated reason rather than pretend. Resolve #1106 first; do not build on the
   marker table as it stands, and do not paper the hole over with the digest.
3. **Fold in #1057.** The carrier-evidence guard below and #1057's drift detection
   are the same mechanism applied to two fields (`configFormat.filename`,
   `startupInjection.maxChars`). Build one, cover both, close #1057.
4. **Honest ledger.** `lib/sessions.js:2858` must stop recording `delivered` on
   the strength of `tmux send-keys` not throwing. `lib/store.js` already refuses
   `delivered` through channel `none`, so the ledger's own contract already
   implies a delivered row means something arrived — this closes the gap between
   its letter and its intent. Unobservable delivery records as `unverified`
   (§ Direction 4).
5. **Minor:** `lib/engines.js:1133` labels the send row "reply", which reads as
   "only respond, never initiate" and plausibly fed the original confusion.

**Guard — must cover the family, not the instance.** A guard asserting only that
Antigravity's filename is `AGENTS.md` repeats the defect it fixes. The guard runs
over **every** engine profile and fails any that declares a carrier without
evidence, and any that declares no readiness marker and no explicit delay.
(Learnings 2026-07-29 #749/#759: *a guard for a class must exercise every member
the producer emits, not a sampled one*; and 2026-07-27 #730/#731: *an assertion
whose both sides are your own repo cannot detect upstream drift* — which is
precisely how `.antigravity.md` stayed green.)

**Done when:** guard red before / green after; a live Antigravity launch shows
the prime in the agent's own transcript (`type: USER_INPUT`), not merely in the
ledger.

---

### Chunk 02 — `tc` thin vertical slice *(architectural keystone)*
**Type:** code · **Critic mode:** final *(override: later chunks build on this)*

The narrowest end-to-end proof that the architecture connects:

- `tc` binary shipped in the repo; TangleClaw prepends its dir to `PATH` and sets
  `TANGLECLAW_API`, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_WORKSPACE_ID` via the
  existing `createSession({ env })` path.
- **One verb: `tc whoami`** — identity, project name + numeric id, workspace id,
  operator host (never `localhost`), and the live capability roster.
- Server records the invocation as an **awareness receipt**.

**Verification is the point of this chunk.** Launch a real Antigravity session,
do not prompt it about `tc`, and observe whether a receipt arrives. This is the
live test of the HIGH-impact assumption above. A negative result is a valid and
valuable outcome — it redirects the plan rather than failing it.

**Done when:** `tc whoami` returns correct data inside a live Antigravity pane
and a receipt is recorded; the assumption is resolved either way and written into
this plan.

---

### Chunk 03 — The verb surface + capability roster
**Type:** code · **Critic mode:** chunk · *gated on Chunk 02's result*

`tc capabilities`, `tc sessions`, `tc message send|read`, `tc ports`, `tc docs`,
`tc rules`, `tc learnings`. Driven by a **declared roster**, extending the
`ecosystem-primer` pattern rather than inventing a second one — adding the next
capability is one roster entry.

**Every verb fails loudly.** No silent no-ops, no empty success. `tc message
send` to an unregistered peer says so in words. This is the direct antidote to
the fabrication that opened this plan: `whoami` must be able to honestly return
an **empty or unregistered** roster, because a surface that only ever describes
success teaches an agent to invent one.

**A CLI is a programmatic interface** (planning guide, structural trigger):
`.prawduct/artifacts/api-contract.md` gains this surface's operations, error
model, versioning scheme, and deprecation policy as *recorded decisions*, not
silent defaults.

---

### Chunk 04 — Bootstrap line, every carrier
**Type:** code · **Critic mode:** chunk

One short line, in every channel each engine actually reads, naming `tc` and what
it is for. Reuses the `ecosystem-primer` roster as content. Per § Direction 5,
anything a channel omits is replaced by a pointer naming what was dropped and
where to read it — never a blind slice.

Per the Master's point and my own: the line reads as an **instruction with a
stated consequence**, not a footnote. A line the agent skims is a vacuum too.

---

### Chunk 05 — Awareness observability
**Type:** code · **Critic mode:** cumulative-final

- "Sessions that never became aware" is a queryable, surfaced state — dashboard
  and Project Master, not a log line.
- Ledger distinguishes *sent* / *confirmed* / *unverified* (§ Direction 4).
- The family guard from Chunk 01 extends to awareness: a new engine profile that
  cannot demonstrate a path to awareness fails the suite rather than shipping
  silent.

**Done when:** disabling the carrier for one engine turns a surface red within
one launch. That is the acceptance criterion the whole plan exists for — the
2026-08-18 regression must not be able to hide for 12 days again.

## Governance checkpoints

1. After Chunk 02 — architecture validated, HIGH assumption resolved.
2. After Chunk 03 — API contract coherent before the surface widens.
3. Before Chunk 05 close — full trajectory review.

## Explicitly out of scope

**Governance enforcement on non-Claude engines** (#990 — the Critic, Stop hook,
build-plan and reflection gates do not exist off Claude). Real, related, and
deliberately separate: this plan makes a session *aware*, not *governed*. Keeping
them apart stops either from hiding behind the other. #990 is closed and would
need reopening or a successor.

## Status

- [x] Chunk 00 — Ratify the Direction — **done 2026-08-31** (operator-authorized; §3 amended, registry row live)
- [ ] Chunk 01 — Carrier repair
- [ ] Chunk 02 — `tc` vertical slice
- [ ] Chunk 03 — Verb surface + roster
- [ ] Chunk 04 — Bootstrap line
- [ ] Chunk 05 — Awareness observability
