---
branch: fix/1761-clear-reentry
partition: serial — chunks 01 and 02 both edit lib/tc-verbs.js' start family and the same test files, and 02's re-entry text points at 01's verb
---

# #1761 — Terminal `/clear` drops launch context while the session stays READY

*Dual-Builder Pilot 3. Dispatched by the PM on 2026-09-24. Planned on `main` @c1c4b5c1. The branch
`fix/1761-clear-reentry` is created when the build starts, not before.*

## Status

- [x] Plan written
- [x] Architect has ruled on A1–A5 (2026-09-24: A2 and A5 approved; A1, A3 and A4 modified; ADR 0017 amendment required; see "Architect ruling"). The architectural gate is clear. **STOP here** (dispatch boundary: "Plan Written"). The PM releases the build boundary
- [ ] Chunk 01: `tc start review`, a read-only re-read of an attested launch, plus the operational-guide pointer
- [ ] Chunk 02: re-entry on `/clear` and `compact`, through the engine's own SessionStart sources
- [ ] ADR 0017 amended: post-READY read-only review, and the semantics of re-entry on clear and compact
- [ ] Verify: focused tests plus the full suite on this checkout (**not** the main instance). Manual `/clear` in a pilot pane
- [ ] Critic
- [ ] Draft PR opened. **STOP here** (pilot boundary)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling or updating the live checkout, no restarting the
live service, no tests on the main instance, no tag, publish or release, no deploy.

## Problem

TangleClaw gives a Claude session its launch context through three channels. `/clear` wipes the model's
context, and after that **none of the three can re-deliver it**:

1. **The prime (identity, ownership, scope guard, launch instructions)** comes from the SessionStart hook
   `data/hooks/sessionstart-prime-claude.sh`.
2. **Operator project rules** come from the SessionStart hook `data/hooks/sessionstart-rules-claude.sh <n>`,
   one per shard (#749).
3. **The launch steps (identity, governance, state, task)** are pulled with `tc start next`.

Channels 1 and 2 are registered with **`matcher: 'startup'` only** (`lib/engines.js`
`_buildBaselineHooks`, around line 3202). Claude Code fires SessionStart with source `startup`, `resume`,
`clear` or `compact`, so after `/clear` neither hook runs. The live project confirms this:
`.claude/settings.local.json` has both entries on `"matcher": "startup"`.

Channel 3 **closes on READY by design** (`lib/launch-sequence.js` `_serve`, around line 713). Once
`cursor >= steps.length` and `readyAt` is set, `next` answers "There is nothing left to pull" with no
content. The only way to go back is `--page`, and that applies only to the current step, which no longer
exists after READY.

What does survive `/clear`: `CLAUDE.md` (the engine reloads it, including TangleClaw's generated
operational block) and the Prawduct plugin's own SessionStart, which fires on `clear`. So a cleared
session keeps generic governance but silently loses the operator's project rules, including the Pilot
Envelope, plus its identity, scope guard and task. That is the failure in the issue.
`tc rules` exists, but it returns only the project rules and only if the agent thinks to ask.

## Confidence check

1. **Problem:** after `/clear` or compaction, a READY session has no way to get its launch context back.
   The hooks don't fire on those sources and the pull sequence refuses to re-serve.
2. **Success:** after `/clear` in a Claude pane, the next model turn has (a) the operator's project rules
   and the session's identity and scope guard, pushed without being asked, and (b) text telling it this
   is a re-entry and not a new launch, so it doesn't re-emit the banner, re-run the launch sequence or
   re-propose. A session with an applicable, bound launch sequence, whose engine can run `tc` and take
   in its output, can re-read the whole attested launch context read-only with `tc start review`, and
   the `CLAUDE.md` guide, which survives `/clear`, says so. This is **not** coverage for every engine
   (A1).
3. **Out of scope:** re-validating or re-attesting after a clear (READY is not revoked, A2); refreshing
   rules that changed after READY (the review serves the frozen snapshot, as `next` did); detecting
   `/clear` on engines with no SessionStart source (they get the pull path and the guide line only);
   pane-scraping detection (the issue's "terminal wrapper" idea, see below); **any re-entry ledger or
   schema** (A4: cut, and no follow-up is owed); the `resume` and `fork` sources (A3).

Requirements confidence: **High** now that the Architect has ruled. The foreign API is confirmed:
the current Claude Code hooks docs (https://code.claude.com/docs/en/hooks, cited by the Architect)
list `startup|clear|compact` as exact alternatives for the matcher and `source` in the stdin JSON. They
also say every matching hook runs **in parallel**, which shapes the preamble (see chunk 02). A manual
`/clear` and `/compact` in a pilot pane is still required at verification.

### How this differs from the issue's proposed solution

- **Proposal 1, "terminal wrapper detects the wipe and re-injects":** I've replaced it with the engine's
  own signal. Claude Code already tells hooks *why* SessionStart fired. Scraping the pane for `/clear` would
  be a second, weaker detector, and it would type into a pane the operator is using. The trade-off is that
  only engines with a SessionStart source get automatic re-entry. Others get the pull path, where they
  can run `tc` (A1).
- **Proposal 2, `tc review-preflight` / `tc rules`:** kept, as **`tc start review`** in the existing
  `start` family, because it re-reads *all four* steps and not just the rules. `tc rules` is unchanged.

## Design

### Chunk 01 — `tc start review` (read-only re-read). Type: feature

- **`lib/launch-sequence.js`: `review({ launchId, projectId, step, page })`.** It resolves the sequence the
  same way `next` does (`_resolve`, `mutating: false`) and serves the frozen snapshot at the current
  revision. **It never** calls `markPageServed`, never acks, never calls `_reviseIfRulesChanged`, and never
  touches the cursor or `readyAt`. It is a pure read, which is the reason it is safe after READY.
  - **Not READY yet** → `409 NOT_READY`: "Your launch is not attested; `tc start next` still serves it."
    This keeps `review` from getting round the page-served rules for acks (an unserved page shown by
    review, then acked, would look served when it wasn't).
  - **Steps not applicable** (native or pushed launch) → the same refusal `next` gives
    (`SEQUENCE_NOT_APPLICABLE`), with its wording.
  - `step` accepts an index (1-based) or an id (`identity|governance|state|task`) and defaults to 1.
    `page` defaults to 0. Out of range → the existing `PAGE_OUT_OF_RANGE` shape.
  - The response carries `review: { readyAt, attestedVerdict, attestedFirstAction }` and a `nextRef`
    naming the following step/page command, so an agent can walk the whole context with no acks.
- **Route:** `GET /api/tc/start/review?step=&page=`, sitting next to `/api/tc/start/status`, with the same
  launch binding (`x-tangleclaw-launch-id`) and the same auth as the other `start` routes.
- **`lib/tc-verbs.js`:** `tc start review [--step <n|id>] [--page <n>]`. The renderer puts a fixed banner
  above the content: *"Read-only re-read of the launch context this session attested READY at <t>. This
  is not a new launch: do not re-attest and do not re-emit the resume proposal. Every rule and
  confirmation gate below is still binding. The state step reflects launch time; check freshness again
  before acting on it."* Update the usage strings (`runStart` and the verb table).
- **Operational guide pointer (`lib/engines.js` ~2457, or `ecosystem-primer.js` if that is where the
  `tc capabilities` bullet lives):** one bullet saying *"If your context was cleared or compacted
  mid-session, run `tc start review` to re-read your attested launch context and rules before acting."*
  It reaches any engine that reloads its config file on a clear and can run `tc`. Neither the plan, the
  guide nor the docs may claim "every engine" (A1). The token-budget tests on the generated block may
  need a trim, so check them up front.
- **Tests (`test/launch-sequence.test.js`, `test/api-launch-sequences.test.js`, `test/tc-verbs.test.js`):**
  - review before READY → 409 NOT_READY, cursor unchanged
  - after READY: every step and page reachable, content equals the snapshot the digest covers,
    `pagesServed`, cursor, revision and `readyAt` byte-identical before and after
  - a rule change after READY: review still serves the frozen snapshot and the revision does not move
  - a wrong launch id or project, a missing binding, and auth → the same refusals as `next` (A1 parity)
  - verb arg parsing, and the banner in the output
- **Docs:** the `tc` verb docs (wherever `tc start` is documented), CHANGELOG `### Added`.

### Chunk 02 — Re-entry through SessionStart `clear` / `compact`. Type: fix

- **`_buildBaselineHooks`:** register the prime and every rules shard with `matcher: 'startup|clear|compact'`
  (confirmed in the docs, A3). **Not `resume` or `fork`**, because both keep the transcript, so no context
  is lost (A3).
  `_mergeBaselineHooks` identifies TangleClaw's entries by script path, so the next launch replaces the
  old `startup` entries in place and adds no duplicates (existing merge tests cover this; add one with the
  new matcher).
- **`sessionstart-prime-claude.sh` reads the hook's stdin JSON** and extracts `source` with the same
  sed-only approach the rules script uses for the receipt, so there's no `jq` dependency. For
  `clear`/`compact` it emits `.tangleclaw/session-reentry.md` at the top of its own output, and then the
  prime. For
  `startup`, or a missing or unparseable source, it behaves exactly as today. That fails safe to current
  behavior.
- **`.tangleclaw/session-reentry.md`** is written by `lib/sessions.js` in the same place and under the
  same gates as the prime (`_writePrimeFile`, silentPrime on). It is removed where the prime file is
  removed, so a stale one can't outlive its launch. The content is TangleClaw-authored, from a small pure
  function (`renderReentryPreamble(project)`) so it can be unit-tested. It says:
  - This is a context re-entry after `/clear` or compaction in a running session, **not a new launch**.
  - The launch-sequence instructions in this session's launch prime (banner, `tc start next`, resume proposal, wait)
    **do not apply**. Run `tc start status`: if it shows READY, re-read with `tc start review`. If it
    doesn't, finish the sequence with `tc start next`.
  - Everything in this session's context still binds: identity, scope guard, the operator's project
    rules and every confirmation gate. **The preamble must stand on its own (A3).** Hooks that match run
    in parallel, so it must not assume where the rules-shard output lands relative to it. No "the rules
    that follow" or "below" pointing at another hook's output. It names `tc rules` and
    `tc start review` as the ways to re-read the rules.
  - Pick up the work in flight from the forward notes (`.prawduct/.handoff-notes.md` where the project is
    governed) and the operator's latest instruction. Don't restart from the handoff's "next action".
- **The rules shards' content is unchanged.** They re-fire as-is under the new matcher. **The receipt
  semantics must not change (Architect's ruling):** a rules-delivery receipt must never be repurposed to
  claim a re-entry event. So `sessionstart-rules-claude.sh` also reads `source` from stdin, and posts the
  shard-1 receipt **only when `source` is `startup` or missing**, which is exactly today's behavior, since
  today it only ever fires on startup. Tests pin that a `clear` or `compact` fire posts no receipt and
  leaves the delivery ledger byte-identical.
- **Tests:**
  - `test/sessionstart-prime-claude-hook.test.js`: stdin `{"source":"clear"}` → preamble then prime;
    `startup`, empty stdin and garbage stdin → the prime alone, byte-identical to today; a missing
    preamble file on `clear` → the prime alone, exit 0
  - `test/engines-hook-shell-safety.test.js`: the new matcher on every emitted entry, with the
    hostile-path safety unchanged
  - `test/engine-hooks-merge.test.js`: `startup`-only entries on disk are replaced, not duplicated
  - `renderReentryPreamble` unit test (it stands on its own, contains no "below" or "that follow",
    and names `tc start review` and `tc rules`), plus the sessions write/remove lifecycle
  - the rules hook with stdin `clear`/`compact` → shard content emitted, no receipt POST (a stubbed curl
    records zero calls); with `startup` or empty stdin → the receipt is posted exactly as today
- **Docs:** the silent-prime docs, CHANGELOG `### Fixed` (the headline fix for #1761).

### ADR 0017 amendment (same PR)

Amend `docs/adr/0017-phased-launch.md`, which the Architect requires. Add a Decision subsection, *"After
READY: read-only review and re-entry on clear or compact (#1761)"*, recording:

- READY is the historical attestation of initialization. `/clear` and `compact` do not revoke it, and
  neither review nor re-entry reopens the serve/ack/cursor/revision state machine (A2).
- `tc start review` serves the **frozen** attested snapshot, never live rules. State and task are
  point-in-time. The work in flight comes from the forward notes and the operator's latest instruction (A5).
- Review's contract covers an applicable, bound launch sequence on an engine that can run `tc`. It is not
  coverage for every engine (A1).
- On Claude, the prime and rules hooks re-fire on `clear` and `compact` (not on `resume` or `fork`). The
  re-entry preamble stands on its own because hooks run in parallel. Rules-delivery receipts are posted
  only for startup and never stand for a re-entry (A3, and the receipt ruling).
- No re-entry ledger. A future consumer needs its own admitted issue and a new persisted-format ruling (A4).

Also add a row to § "Consequences" and update § "What READY does not mean" if it contradicts any of this.

## Verification beyond tests

On this checkout's test server (never the main instance), launch a pilot Claude session, attest, run
`/clear`, and confirm the first turn after it: no banner and no re-proposal; the Pilot Envelope rule
present; no new rules-delivery receipt recorded for the launch; `tc start review` walks all four steps with the cursor unchanged (`tc start status` before and
after). Repeat with `/compact`. Repeat with silentPrime off: no push, but the `CLAUDE.md` bullet leads the
agent to `tc start review`. Also check `/resume`: no preamble, and nothing re-injected.

## Architect ruling (2026-09-24, formal, on main @c1c4b5c1)

- **A1 MODIFY:** ship both push and pull. `tc start review` is a read-only contract only for an
  applicable, bound launch sequence whose engine or session can run `tc` and take in its output. It is not
  coverage for "every engine", and the plan, guide, docs and acceptance text must say so. It keeps exact
  launch/project binding and auth parity with `next`, and changes nothing in serve, ack, cursor, revision
  or READY. *(Applied throughout.)*
- **A2 APPROVE:** `/clear` does not revoke READY.
- **A3 MODIFY:** re-inject on `clear` and `compact`, and exclude `resume` and `fork`. The docs confirm the
  matcher alternatives and `source`. Hooks run in parallel, so the preamble stands on its own and must not
  depend on where the rules shards land ("rules that follow" removed). A manual clear and compact check is
  required. *(Applied in chunk 02 and verification.)*
- **A4 MODIFY:** chunk 03 is **cut** from Pilot 3, with no deferred work and no follow-up implied. A future
  named consumer needs its own admitted issue and a new persisted-format ruling. *(Chunk 03 removed.)*
- **A5 APPROVE:** review serves the frozen attested snapshot, never live rules.
- **Also required:** amend ADR 0017 in this PR (section above). Don't repurpose the rule-delivery
  receipt/ledger to stand for re-entry, and pin that behavior as unchanged in tests *(chunk 02, receipt only
  on startup)*.

The architectural gate is clear. The PM still releases the build boundary.

## Questions put to the Architect (as sent, now ruled above)

- **A1 — Push, pull, or both?** I propose both. Push (chunk 02) covers Claude with silentPrime on. Pull
  (chunk 01), along with the `CLAUDE.md` pointer, covers pushed primes and other engines that can run `tc`
  *(wording corrected per A1; the original said "every engine")*. Push alone leaves every other engine
  blind. Pull alone depends on the agent realising it forgot something, which is
  exactly the failure.
- **A2 — Should `/clear` revoke READY and make the session attest again?** I propose **no**. READY records
  that the context arrived. Revoking it would need a detector TangleClaw doesn't have for most engines,
  and it would reopen the `next`/ack state machine for a snapshot the agent has already acknowledged.
  Review stays read-only and leaves the state alone.
- **A3 — Should `compact` re-inject?** I propose **yes**. A compaction summary is lossy, and the rules are
  exactly what gets summarised away. The cost is re-sending the prime (~10 KB) plus the rules shards once
  per compaction. `resume` is excluded because the transcript comes back intact.
- **A4 — Keep chunk 03 (re-entry ledger)?** I proposed deferring it. **Ruled: cut, with no follow-up.**
- **A5 — Should the review serve the frozen snapshot or the current rules?** I propose **frozen**, with the
  banner saying the state step is from launch time. The rules shards re-fired in chunk 02 are also
  launch-time files. Serving live rules after READY would bring back the "rule change after READY"
  question that §2.2 already settled as "does not invalidate readiness."

## What I'd do differently

The smallest fix that closes the issue is **chunk 02 on its own** (change the matcher plus the preamble),
which is about 40 lines and handles the reported case. I'm still proposing chunk 01 alongside it, because
without it any non-Claude or pushed-prime session keeps the same hole, and the task and state steps can't
be recovered even on Claude. I proposed cutting chunk 03, and the Architect has cut it (A4).
