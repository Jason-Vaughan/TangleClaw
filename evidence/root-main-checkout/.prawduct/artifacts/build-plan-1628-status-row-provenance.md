---
scope: 1628-status-row-provenance
---

# Build plan — #1628: status-row provenance for the codex readiness gate

## Confidence Check

**Problem.** `_assessActivity` decides at-rest by `text.includes(profile.idleMarker)`
over the WHOLE captured tail. Two observed failures, both measured this session:
- The declared literal `· Ready ·` is not rendered on the operator's pane (run-state
  sits 6th in a 14-segment `status_line` and the row truncates at 104 cols), so the
  gate returns `not-at-rest` forever and Medusa mail waits for a human. This is the
  #1628 incident.
- The same literal appears in TRANSCRIPT PROSE discussing the marker (3 occurrences
  in the Architect's scrollback). Whole-tail matching found it and the gate reported
  at-rest. Ledger 5030, 2026-09-19 03:29:50Z — a false idle.

**Success.** The readiness verdict is derived from the STATUS ROW only; transcript
text can never satisfy it; a status row with no state token FAILS CLOSED carrying a
reason that names what is wrong; the positive readiness requirement is preserved;
claude and antigravity are byte-for-byte unaffected; every listed case is pinned by a
fixture-backed regression test.

**Out of scope.** #1621 input submission (evidence captured, not fixed). Any change to
`~/.codex/config.toml` or a live pane. Removing or softening the positive gate.
Push / PR / merge / deploy.

## Requirements Confidence: HIGH
Rendering measured live in two disposable probes; provenance discriminator validated
against three independent captures; both failure directions reproduced from evidence.

## Design

**Footer identification.** The status row is the LAST NON-EMPTY line of the captured
pane. Validated on all three preserved captures, including the clipped one where the
state token is correctly absent. Codex runs on tmux's alternate screen, so a
no-range `capture-pane -p` returns exactly the visible pane.

**Gated on a new OPTIONAL profile field** so engines that do not declare it keep
today's behaviour exactly:
- `idleMarkerRow: "status-row"` — where the idle marker must be found.
- `busyStates: string[]` — the other run-state tokens, so a busy footer is reported
  as busy rather than as an unreachable marker.

Only `codex.json` gains them. `antigravity` (`? for shortcuts`) and `claude`
(`idleMarker: null`) are untouched.

**Matching.** Whole-token match of `idleMarker` against the identified footer row
ONLY — not a whole-tail regex (explicitly barred, and it would carry the identical
false-idle defect). Decorative cells are blanked first, reusing the existing
per-cell reading, so shimmer cannot break the match or forge one.

**Verdicts when `idleMarkerRow` is declared:**
| footer state | verdict | reason |
|---|---|---|
| no non-empty line | working | `status-row-unavailable` |
| lines not supplied | working | `status-row-unavailable` |
| idle token present | at rest | (falls through to existing prompt checks) |
| a busyStates token present | working | `not-at-rest` |
| no state token, row ends U+2026 | working | `status-row-truncated` |
| no state token | working | `status-row-no-state` |

Fail-closed everywhere. Never infers idle from silence or an empty composer — the
composer check remains an ADDITIONAL requirement for injection, never a substitute.

**Shared semantics.** `sessions.js#_awaitPaneReady` consumes the same `idleMarker`
with the same blind spot, so it calls the same exported predicate rather than
growing a second copy.

## Chunks

### Chunk 01: Fixtures

- [ ] **C1 — fixtures.** Real captured bytes into `test/_wake-fixtures.js` from
      `.tangleclaw/reference/1628-probes/`: codex idle (run-state alone), idle with
      neighbour, clipped/truncated row, transcript-prose-containing-the-literal,
      busy (Working), Thinking, dialog, human draft, shimmer.

### Chunk 02: Profile

- [ ] **C2 — profile.** `codex.json`: `idleMarker` `· Ready ·` → `Ready`, add
      `idleMarkerRow` + `busyStates`, rewrite the `evidence` blocks with the
      2026-09-19 probe measurements and the CLI version.

### Chunk 03: Gate

- [ ] **C3 — gate.** Schema entries for the two new fields; footer locator;
      `_assessActivity` status-row branch; new reason codes + their meanings.

### Chunk 04: Launch consumer

- [ ] **C4 — launch consumer.** `_awaitPaneReady` uses the shared predicate.

### Chunk 05: Tests

- [ ] **C5 — tests.** Regression tests for every row of the verdict table, plus a
      test asserting claude and antigravity behaviour is unchanged.

## Done when
Suite green, `/prawduct:critic` run and blocking findings resolved, diff + evidence
reported to the acting PM. NO push, NO PR.

## Status
- [x] Chunk 01 Fixtures
- [x] Chunk 02 Profile
- [x] Chunk 03 Gate
- [x] Chunk 04 Launch consumer
- [x] Chunk 05 Tests
