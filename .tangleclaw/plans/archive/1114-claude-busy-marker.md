# #1114 — restore a busy gate that actually fires for Claude

**Issue:** #1114 (OPEN). Supersedes #1106 in importance; fold #1106 in rather than
solving it separately.

## The defect

`ENGINE_WAKE_PROFILES.claude.busyMarker` is `esc to interrupt`. On Claude Code 2.1.241
that string lives only inside a `low_priority_waiting` retry branch — it is absent from an
ordinary busy turn. With `idleMarker: null` there is no second gate, so `_assessPane`
returns `{idle: true, reason: 'at-prompt'}` for a session that is actively working and the
wake monitor can paste a nudge into a live turn. Safety property 1 fails open.

## What was measured

A throwaway Claude session was spawned in its own tmux session (`wakeprobe`) so no other
session was touched and no transcript contamination was possible, and driven through
busy→idle repeatedly.

| State | Spinner line | bare `❯` | cursor | `esc to interrupt` |
|---|---|---|---|---|
| At rest (clean room) | absent | present (`❯` + NBSP) | col 2 | absent |
| At rest + faint suggestion | absent | present | col 2 | absent |
| Busy, token generation | **present** | present | col 2 | absent |
| Busy, foreground tool call | **present** | present | col 2 | absent |
| Backgrounded shell (turn ended) | absent | present | col 2 | absent |

Neither the bare prompt nor the cursor separates the states — both are constant across all
five. The spinner line is the only observed discriminator.

Observed spinner lines, verbatim:

```
✽ Stewing… (1m 7s · ↓ 4.3k tokens)
✽ Whatchamacalliting… (3s · ↓ 108 tokens)
· Sprouting… (3s · ↓ 187 tokens)
✳ Twisting… (4s · ↓ 121 tokens · thinking with high effort)
✢ Julienning… (3s · ↓ 184 tokens)
```

The leading glyph varies (`✽ ✳ ✢ ·`) and the gerund is drawn from a randomised list in the
binary, so neither is a marker. The stable shape is: a glyph, a word ending in `…`, then an
elapsed clock in parentheses. `✻ Brewed for 4s` — the *completed* line — lacks both the
ellipsis and the clock, so it does not match, which is the distinction that matters.

## Design — REVISED after the spinner was disproved

The first design here proposed a `busyRe` matching the spinner line. **That was measured and
rejected.** During active token streaming Claude Code renders **no spinner at all**: output
streams directly above the box, the bare `❯` is present, and the status rows are identical to
a resting pane. The spinner appears only while *thinking* or *waiting on a foreground tool*,
which is why an early capture of a tool-call pane made it look sufficient.

So there is no string that separates a streaming session from a resting one, and the fix
cannot be another marker.

**What shipped instead: liveness by change, not by string.** A working session *writes* —
streaming changes the transcript on every tick, and a thinking one animates its spinner glyph
and elapsed clock. A resting session writes nothing.

`_paneDigest(lines, profile)` fingerprints the pane region ABOVE the composer. `_tick`
compares it to the previous tick's; a difference means the turn is in flight and resets the
idle streak with reason `pane-writing`. Everything from the composer down is excluded
deliberately — the input line carries an engine-rotated inline suggestion and the status row
carries a context-remaining percentage that falls while the session sits idle; including
either would fake liveness on a resting pane.

Measured: the region changed on every tick across a streaming turn, then held byte-identical
for 21 consecutive ticks (63s) at rest.

**Why this is the right shape for this repo:** it asks a behavioural question rather than a
lexical one, so it names no engine and depends on no rendering. That satisfies
engine-agnostic-by-construction directly, and it retires the defect class behind #1101,
#1103, #1105 and #1114 — every one of which was "the marker moved".

It composes with the existing debounce rather than replacing it: `IDLE_TICKS_REQUIRED` is 2
and the interval is 5s, so a pane must now be byte-static across a 5s gap before any nudge.

`busyMarker` is kept — the `low_priority_waiting` retry state is real — but is no longer what
gates an ordinary turn, and its comment now says so.

## Status

- [x] **1. Fixtures** — stream-state fixtures added; the precondition assertion pins that the
      marker gates alone judge a streaming pane idle, which is the regression proof.
- [x] **2. Digest + tick wiring** — `_paneDigest` + the `pane-writing` gate.
- [x] **3. Mutation pass** — four mutations, all caught (drop the gate / force `moved` false /
      digest the whole capture / constant digest).

Note for the record: the two existing tests that failed mid-build were **not** wrong. They
caught a real bug in `_paneDigest`, which chopped a fixed line above the composer and so
discarded real transcript on a short pane. Both were restored to their original text once the
helper was fixed; no existing test was weakened.

## Explicitly out of scope

Giving Claude a positive at-rest marker (#1106 option 1). Nothing was observed that is
present at rest and absent mid-turn — the status and hint rows are identical in both. Say
so honestly in the profile comment rather than inventing one; do not close #1106 on the
strength of this work.
