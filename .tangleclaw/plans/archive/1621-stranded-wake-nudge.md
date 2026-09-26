---
title: "#1621 A stranded wake nudge blocks its own recovery"
status: CHUNK 1 BUILT (2026-09-26). Cumulative Critic rev-20260926T171019Z-9281dd66 plus verify-resolutions rev-20260926T172747Z-77f346ab, 0 blocking. PR opened for PM merge.
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-26, message 73798d5f (dispatch), fix scope approved in 081f2259.
issues: [1621]
scope: 1621-stranded-wake-nudge
branch: fix/1621-stranded-wake-nudge
partition: serial. One chunk.
critic_mode: a cumulative review, then verify-resolutions over the guard commit
---

# #1621 — A stranded wake nudge blocks its own recovery

Issue: https://github.com/Jason-Vaughan/TangleClaw/issues/1621 (OPEN at plan time).
Dispatched by the ProjectManager to TangleClaw-Builder2, 2026-09-26. Envelope: plan, fix,
local verification, Critic-reviewed PR. Builder2 does not merge.

## Root cause

The issue reports a wake nudge pasted into the composer whose Enter never lands, left
there until a human presses Enter. #1839 already detects this: each nudge carries a
`(wake ref <nonce>)`, and `verifySubmission` records `wake_not_accepted` when that nonce
is still in the composer. The watchdog then re-arms the wake "through every gate".

One of those gates is the draft check. `_assessPane` returns `composer-has-input` for any
non-empty composer, and it cannot tell the operator's half-typed text from the
switchboard's own stranded nudge. So the re-arm the negative receipt earns is refused by
the text that earned it, on every tick, until the budget is spent and the exchange
escalates by age. A newer message's wake is refused the same way. Nothing re-submits.

Why the Enter is lost in the first place (a fixed 500 ms delay racing the TUI's
paste handling is the leading suspect) is **not established**, and this chunk does not
claim to fix it. What it fixes is the part that makes a lost Enter permanent.

## Design

Keep #1839's recorded rule: a transport never re-sends or presses Enter again. Recovery
goes through the re-arm and every gate. The fix makes the draft gate recognise the one
composer content that belongs to the switchboard itself.

1. `medusa-wake.isOwnNudge(text)` — true only when the whole composer text, whitespace
   removed, is a nudge line `_nudgeLineFor` could have produced followed by a wake ref.
   The pattern is derived from `_nudgeLineFor` itself, so the two cannot drift. Any
   operator text before or after the nudge fails the match.
2. `_assessPane`: when the cursor says the composer holds input, read it with
   `readComposerDraft`. When the draft is `complete` (its whole region was seen) and
   `isOwnNudge` matches, the pane is `at-prompt`: safe to type into, because the
   injector's `C-u` clears the stale nudge and pastes a fresh one with a new nonce.
   Everything else stays `composer-has-input`.
3. `tmux._clearPromptLine`: a composer holding only a stranded nudge is not the
   operator's draft. It is cleared without being saved to the draft store, and the log
   says a stranded switchboard nudge was cleared.

The fresh nudge carries a new nonce, gets its own receipt check, and a second lost Enter
re-arms again under the existing 3-re-arm budget and backoff, then escalates. So a lost
Enter now recovers on the next eligible tick instead of never.

## Decisions

- [DECISION: amend #1839's stated re-arm behaviour.] #1839's changelog says "the re-armed
  wake still waits for a clear composer". This chunk makes one exception: a composer that
  holds only the switchboard's own nudge is treated as clear. #1839's aim, "a draft is never
  typed over", is kept, because the exception covers only text the switchboard wrote and
  requires the composer's lower border to be seen. Rejected alternative: a second Enter
  from the transport on a negative receipt. That would break #1839's recorded rule that a
  transport never presses Enter again, and could submit operator text typed in the meantime.
- [DECISION: a borderless composer gets no exception.] Without a lower border, operator text
  could sit below the captured region. Those engines keep the old behaviour, and the docs
  say so.
- [DECISION: `_assessPane` checks before both refusal branches.] A wrapped nudge leaves the
  cursor on a continuation row, where `_composerEmpty` answers `null` and the text check
  alone says `no-prompt`, not `composer-has-input`. Found by test before implementation.

- [DECISION: re-read the composer after clearing a stranded nudge.] Critic warning: nothing
  proves one `C-u` clears every wrapped row in every engine. If the re-read finds anything
  left, `sendKeys` throws and the wake records `inject-failed`, instead of pasting after the
  leftover. Live verification on a real Claude pane was not done in this chunk; the guard
  makes the outcome safe either way.

## Out of scope

- The cause of the lost Enter itself (the paste/Enter timing). File separately if it
  keeps happening once recovery works.
- Engine-native wake transports with positive receipts (Codex-native, Claude Stop hook):
  already tracked as #1839 follow-ups.
- Any change to the re-arm budget, backoff, or escalation ladder.

## Tests

- `isOwnNudge`: a real `_nudgeLineFor` + `withNonce` line matches, for a project base and
  the Master base; the same line wrapped across composer rows matches; operator text
  before or after, a missing or malformed wake ref, and ordinary text do not.
- `_assessPane`: a composer holding only a stranded nudge (cursor on it, region complete)
  is `at-prompt`; the same nudge with operator text appended is `composer-has-input`; an
  incomplete region stays `composer-has-input`.
- Regression through the wake monitor: a re-armed edge whose pane holds the stranded
  nudge injects instead of recording `pane-composer-has-input`.
- `_clearPromptLine`: a stranded nudge is cleared and not written to the draft store; an
  operator draft still is.

## Docs

`docs/medusa-delivery.md` "Wakes and re-arms": say the draft gate lets a re-arm replace
the switchboard's own stranded nudge, and nothing else. CHANGELOG `### Fixed`.

## Status

- [x] Chunk 1 — own-nudge recognition in the draft gate and prompt clear, tests, docs
