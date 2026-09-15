---
artifact: build-plan
version: 1
scope: train-19-chunk-03
---

# Train 19 — Chunk 03: the Release decision in the wrap UI (L3)

**Issue:** #1492 (layer L3; L2 AI recommendation and the L1-vs-L2 disagreement trigger are Chunk 04)
**Branch:** `feat/release-drawer-1492`
**Worktree:** `.claude/worktrees/release-drawer-1492` (the primary clone is the live install)
**Critic mode:** cumulative
**Size:** medium (the version-bump step, the pipeline declaration, the drawer helpers, the wrap modal,
the settings modal, ADR 0002, docs)
**Roadmap:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/master-roadmap.md`
(Coordinator-owned), Train 19
**Authorized:** operator "go" in the Builder pane, 2026-09-14, after the Coordinator relayed the chunk.
The Coordinator confirmed over the switchboard that this chunk builds the `needs-operator` plumbing and
that the L1-vs-L2 trigger lands in Chunk 04.

---

## Confidence check

**Problem.** Chunk 02 gave the step a verdict and a mode, but the operator still has only a bump-level
picker. They can't say "hold this one" when the verdict is `ready`, or "cut" without also choosing a
level. In `ask` mode, and in `auto` on an `unknown` verdict, the step reports `needsOperator: true` and
then skips anyway. The wrap commits with no release, and the operator's decision never gets asked for.

**Success.**
1. The wrap modal offers `Release: Auto / Cut / Hold`. Auto follows the project's `releaseMode`. Cut
   cuts whatever the verdict. Hold never cuts. A bump level can be chosen only alongside Cut, and it
   defaults to the CHANGELOG heuristic.
2. When the step needs the operator and the operator hasn't decided, the wrap **halts** at
   `version-bump` with `needs-operator`, before `commit`. The drawer shows what would be cut
   (`from → to`, level), the verdict with its reason and signals, and a Cut / Hold choice with nothing
   preselected. Retry carries the choice, and the wrap goes on.
3. A project whose `releaseMode` is `off` doesn't show a release control that would be ignored. The
   modal says releases are off and points to Settings.
4. The settings modal sets `releaseMode` (Off / Auto / Ask) directly, replacing the boolean checkbox.

**Out of scope.**
- The L2 AI recommendation and the L1-vs-L2 disagreement trigger (Chunk 04). This chunk halts on the
  `needsOperator` conditions Chunk 02 already computes.
- The "picker ignored when `off`" bug (Chunk 02 D6). The server still skips `off` before reading any
  option. This chunk only stops the UI from offering the control there.
- Cutting v5.26.0 or changing this project's own setting.

**Requirements confidence: HIGH** for the controls and the halt (#1492 L3 text; the Coordinator's
scope). **MEDIUM** for where each control lives (D1) and the halt mechanism (D3). Both are recorded and
vetoable.

---

## Decisions

**D1: the up-front choice lives in the wrap modal, and the decision under a halt lives in the drawer.**
#1492 says "the Wrap Drawer replaces the current version picker", but the picker is in the wrap
*modal*. The drawer only exists once a run has started. The modal's picker becomes the Release control,
and the drawer renders the choice only when the step halts. So the operator answers once, in the place
where the question arises.

**D2: the wire is `options.release: 'cut' | 'hold'`, absent for Auto.**
- `bumpLevel` is sent only with Cut. A `bumpLevel` with no `release` still means cut (Chunk 02 D1),
  so an API caller that sends only a level keeps working.
- `release` outside the set skips the step and names the value, the same fail-closed rule as
  `bumpLevel`.
- `hold` together with a `bumpLevel` contradicts itself, so the step skips and says so rather than
  picking one.
- A Hold is recorded as `decidedBy: 'operator'` on the held output. The row then reads as the operator's
  call, not as the gate's.

**D3: the halt is a `needs-operator` result on a `blocker: true` step.** The runner halts only when
`step.blocker` is `true`/`errors-only` and the step returns `!ok`. The step returns
`{ok:false, status:'needs-operator'}` only when `needsOperator` is true and the operator hasn't decided.
Every other outcome stays `ok:true`. `version-bump` flips to `blocker: true`.
- *Consequence, accepted:* a version-bump handler that **throws** now halts the wrap too. Before, it
  continued and committed with no release. Stopping before the commit is the safer half of that: the
  step is the one that writes the release.
- *Consequence, accepted:* `wrapStepOverrides['version-bump'].blocker: false` restores continue-on-hold.
  The row still reads `needs-operator`. That is an operator's explicit choice, the same escape the
  other steps offer.
- *Rejected:* making the runner halt on any `needs-operator` whatever the blocker flag. That changes
  every step's contract to serve one step, and it would override an operator's existing
  `blocker: false` on a content step.
- **ADR 0002 amendment:** the step-kind table says version-bump "never blocks". It now halts in exactly
  one case, a release decision that belongs to the operator, and the amendment records why.

**D4: the choice persists across retries.** Every Retry re-runs the pipeline from step 0, so the
modal's choice and a drawer answer are both kept as session-level state (as `wrapBumpLevel` already
is). A drawer answer replaces the modal's Auto. Content steps before `version-bump` are reused on
Retry under #1404's window, so a halt here doesn't re-prompt the AI.

**D5: the settings modal sends `releaseMode` alone.** The `versionBumpEnabled` alias stays on the API
for callers (Chunk 02 D5), but the UI no longer sends it.

**D6: the `needs-operator` tooltip is generalised.** It currently names plan mode as the only cause.
It now describes a decision only the operator can make, with plan mode as one example.

---

## Build steps

### Chunk 03: Release decision in the wrap UI

1. `lib/wrap-steps/version-bump.js`: validate `options.release`, the hold+level contradiction, the halt
   result, and Hold/Cut in `_releaseGate`. Tests in `test/version-bump-release-gate.test.js`.
2. `lib/wrap-default-pipeline.js`: `version-bump` `blocker: true` with an `_orderNote` saying why. Test
   that a `needs-operator` result halts before `commit`.
3. `public/wrap-drawer.js`: `release` in `collectOptionsFromAccessors`, a `releaseDecisionWidget`
   descriptor, a detail line for an operator-decided cut or hold, and the tooltip. Tests.
4. `public/session.html` + `public/session.js` + CSS: the modal's Release control (reset on open, level
   only with Cut, hidden when `off`), the widget render, the retry accessor and persistence. Source-level
   tests following `test/wrap-bump-level-askmode.test.js`.
5. `public/ui.js`: the Release mode select in Settings. Test.
6. Docs: ADR 0002 amendment + table row, `docs/configuration-reference.md`,
   `.prawduct/artifacts/api-contract.md`, CHANGELOG, `.prawduct/change-log.md`.
7. *Added from the cumulative Critic.* The wrap modal re-reads `releaseMode` when it opens and
   again before sending, because the page's load-time copy can be stale. The run registry
   records each run's `options`, `/wrap/status` returns them, and a reloaded page takes back the
   choices Retry replays. A Hold forgotten on reload became Auto, and a ready `auto` project then
   cut the release the operator had refused.

## Done when

- The suite is green. The new tests cover Cut / Hold / Auto × each mode × each verdict, the halt,
  and the retry carry.
- Live check on a scratch server: an `ask` project's wrap halts at version-bump, the drawer shows the
  choice, and Hold then Retry completes the wrap with no release. Entered in operator verification
  (visual change).
- Cumulative Critic: 0 blocking.
- PR opened. The Coordinator gets a chunk-close memo.

## Status

- [ ] 03a step: release option, hold, halt
- [ ] 03b pipeline blocker + halt test
- [ ] 03c drawer helpers
- [ ] 03d wrap modal + drawer widget
- [ ] 03e settings Release mode select
- [ ] 03f docs + ADR amendment + live check
