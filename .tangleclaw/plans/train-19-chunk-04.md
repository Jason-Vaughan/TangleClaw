---
artifact: build-plan
version: 1
scope: train-19-chunk-04
---

# Train 19 — Chunk 04: the AI release recommendation (L2) and the L1-vs-L2 disagreement halt

**Issue:** #1492 (layer L2 and the disagreement trigger; the last layer of the issue)
**Branch:** `feat/release-recommendation-1492`
**Worktree:** `.claude/worktrees/release-recommendation-1492` (the primary clone is the live install)
**Critic mode:** cumulative
**Size:** medium (a new content step in the pipeline, a precondition seam in the content handler and the
runner's prompt roster, the version-bump gate, the drawer, the continuity summary, ADR 0002, docs)
**Roadmap:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/master-roadmap.md`
(Coordinator-owned), Train 19
**Authorized:** operator "go" in the Builder pane, 2026-09-14, after the Coordinator relayed the chunk
(L2 AI Recommendation step with chat context ingestion, and the L1-vs-L2 disagreement trigger).

---

## Confidence check

**Problem.** L1 (`lib/release-readiness.js`) judges release readiness from files: `[Unreleased]` has
entries, the plan's Status boxes are ticked. It can't know what the operator meant by this wrap. "Wrap
and cut a release" and "wrapping to save state before I leave" look the same to it. In `auto` a
ready verdict cuts a release the operator just said not to cut, and a not-ready verdict holds one they
asked for.

**Success.**
1. A wrap whose release decision is still open runs a content step, `release-recommendation`, before
   `version-bump`. The AI writes `## ReleaseRecommendation` (`cut` | `hold` | `unsure`), the operator's
   own words about releasing (or `none stated`), and a reason.
2. The recommendation rests first on what the operator said in this session's conversation, and only
   then on the work itself.
3. In `auto`, when L1 and L2 disagree (`ready` + `hold`, or `not-ready` + `cut`), version-bump halts
   with `needs-operator`, and the drawer shows both sides before asking Cut / Hold. When they agree, or
   L2 is `unsure` or absent, the behaviour is Chunk 03's.
4. The recommendation is recorded wherever the release decision is: on the version-bump output (cut or
   held), on the drawer row and in the halt widget, and in the wrap summary.
5. No prompt is spent when there is nothing to decide: `releaseMode` `off`, a decision the operator
   already made (Cut, Hold or a picked level), or no `[Unreleased]` entries.

**Out of scope.**
- The picker-ignored-when-`off` bug (Chunk 02 D6). It is still the operator's call.
- Server-side transcript scraping (D2).
- Cutting v5.26.0, or changing this project's own `releaseMode`.

**Requirements confidence: HIGH** for the step, the trigger and the skip conditions (#1492 L2/L3 text;
the Coordinator's scope). **MEDIUM** for how "ingest the conversation" is met (D2) and where the
recommendation lands in the wrap summary (D6). Both are recorded and vetoable.

---

## Decisions

**D1: L2 is a new `ai-content` step, `release-recommendation`, between `changelog-update` and
`version-bump`.** Before `version-bump` because the trigger has to be decided before the release is
staged. After `changelog-update` because the AI should judge the entries this session just wrote.
- Kind stays `ai-content`, so the tmux and gateway transports, the `step N of M` roster, the #1404
  Retry reuse and Skip & note all apply without new code.
- `captureFile: .tangleclaw/.release-recommendation.md`. `captureFields: ['releaseRecommendation']`;
  `optionalCaptureFields: ['operatorIntent', 'reason']`.
- `blocker: false`, `allowOverride: true`. The recommendation is a hint. A timeout or a missing capture
  leaves an honest row and the gate falls back to L1 alone. It never halts the wrap.

**D2: the conversation is ingested by the session that holds it, not by the server.** The wrap prompt
goes into the live session, whose engine already has the conversation in context. The prompt tells the
AI to look there first for what the operator said about this wrap, quote those words, and write
`none stated` when there are none.
- *Why not scrape a transcript server-side:* `lib/transcript.js` resolves only Claude Code's
  `~/.claude/projects` files; every other engine's adapter is a stub. A recommendation built on a
  scraped transcript would work on one engine, which the wrap's engine-agnostic commitment forbids.
- *Known limit, accepted:* a session cleared or compacted since the operator spoke has lost those
  words. The AI then says `none stated`, and the recommendation rests on the work alone.

**D3: L2 does not see L1's verdict.** The prompt doesn't carry the readiness verdict or its signals.
An AI shown the verdict tends to echo it, and then a disagreement can't happen: the trigger would never
fire.

**D4: a precondition gates the prompt, owned by one predicate.** A new optional step field,
`precondition: 'release-decision-open'`, names a predicate in `lib/wrap-steps/_release-recommendation.js`.
- `ai-content.run` checks it before anything else, which covers both transports. The runner's
  `_planAiContentPrompts` checks it too, so the `step N of M` denominator counts only prompts that
  will actually be sent. *Amended during the build:* the roster plans before `changelog-update` runs,
  and that step may write the very entries the CHANGELOG check looks for. So the roster asks with
  `planning: true` and the CHANGELOG check is skipped there. A prompt the handler later finds
  unneeded leaves the count one high, never one low.
- The predicate skips when: `releaseMode` resolves to `off`; `options.release` is `cut`/`hold`, or
  `options.bumpLevel` is set (the operator's decision wins, so a recommendation can't change the
  outcome); `CHANGELOG.md` is missing, or `[Unreleased]` has no entries.
- Unknown precondition names skip the step with a reason naming the bug. A test pins every name in the
  shipped pipeline to a registered predicate.
- `precondition` is not overridable (it is absent from `OVERRIDABLE_FIELDS`). A project can still
  disable the step outright.
- *Accepted waste:* the predicate doesn't replay version-bump's semver and drift guards, so a project
  that can never be bumped still spends one prompt. That is rare and visible, and replaying the guards
  would mean a second copy of them.

**D5: the disagreement trigger lives in `_releaseGate`.** It gains a fourth input, the parsed
recommendation.
- The operator's decision still wins first.
- In `auto`: `ready` + `hold`, or `not-ready` + `cut`, gives `needsOperator: true` with a reason that
  names both sides. `unknown` already needs the operator. Agreement, `unsure`, or no recommendation
  keeps Chunk 03's result.
- In `ask`: unchanged (always the operator's). The recommendation rides along as the hint.
- Output: every held and cut result carries `recommendation`: `{state: 'given', value, operatorIntent,
  reason}` or `{state: 'absent', reason}`. A halt caused by disagreement also carries
  `disagreement: true`.
- Parsing is tolerant of markdown decoration: the first word of the field's first non-empty line,
  stripped of backticks, bold and quotes and lowercased, must be `cut`, `hold` or `unsure`. Anything
  else reads as `absent`, with the unparsed text in the reason. It is never guessed into a value.

**D6: the wrap summary records it in `Freshness`.** The eight summary sections are a contract
(`continuity-contract.md`), and `Decisions` is the AI's judgment section: appending a mechanical line
there would hide its `_⚠ not captured_` flag. `continuity-write` reads the version-bump result from
`previousResults` and adds one `- release: …` line to `Freshness`. The line gives the outcome (cut
`from → to`, held, or needs the operator), who decided, and the recommendation with the operator's
quoted intent. The `## ReleaseRecommendation` heading itself lives in the capture file that the
AI writes and the step parses.

**D7: the drawer shows the recommendation beside the readiness verdict.** `releaseDecisionWidget`
carries `recommendation` and `disagreement`. The halt widget renders an "AI recommends …" line with the
quoted intent, or says why there is none. The version-bump row detail appends `· AI recommended <value>` to a cut, and `· the release checks and the AI disagree` to a disagreement halt. A held row keeps showing its reason, which the status check already renders.

**D8: carried over from the Chunk 03 PR review.** Two comments narrate the bug's history instead of
giving the present-tense reason. Rewrite them: the `begin()` JSDoc in `lib/wrap-run-registry.js` and
the `/wrap/status` comment in `server.js`.

---

## Build steps

### Chunk 04: AI release recommendation and the disagreement halt

1. `lib/wrap-steps/_release-recommendation.js`: `releaseDecisionOpen(project, options)`,
   `parseRecommendation(parsedFields)` and `recommendationFrom(previousResults)`. Unit tests.
2. `lib/wrap-steps/ai-content.js`: the `precondition` check in `run` (before the session and transport
   branches), with a registry of predicates. `lib/wrap-pipeline.js`: `_planAiContentPrompts` asks the
   same predicate. Tests: both transports skip, the roster excludes the step, an unknown name skips.
3. `lib/wrap-default-pipeline.js`: the `release-recommendation` step with its prompt, `_orderNote` and
   capture contract. Update the pipeline order and membership tests. Add a guard that every
   `precondition` resolves.
4. `lib/wrap-steps/version-bump.js`: read the recommendation, apply the trigger in `_releaseGate`, and
   record `recommendation` / `disagreement` on the output. Tests: mode × verdict × recommendation
   (including `unsure`, absent, unparseable, and operator-decided).
5. `lib/wrap-steps/continuity-write.js`: the `Freshness` release line. Tests.
6. `public/wrap-drawer.js` + `public/session.js`: recommendation fields on the widget descriptor, the
   halt-widget line, the row detail. Tests.
7. D8's two comment rewrites.
8. Docs: ADR 0002 step table and amendment, `docs/configuration-reference.md` (the step and its
   override), `.prawduct/artifacts/api-contract.md` (the version-bump output fields), CHANGELOG, and
   `.prawduct/change-log.md`.

## Done when

- The suite is green. New tests cover the precondition on both transports and in the roster, and the
  trigger across mode × verdict × recommendation.
- ~~Live check on a scratch server~~ *Amended during the build:* a scratch server can't produce a
  recommendation without a live engine session, so it would show only what the runner test already
  shows with a stubbed pane. The seam is instead covered by a runner test that uses the real content
  handler and the real version-bump (a written `hold` halts ready checks; an unreadable answer cuts).
  The live-engine check (an `auto` project, an operator who said "just saving state", a halt that shows
  both sides, then Hold → Retry with no version change and no second prompt) is entered in operator
  verification as VRF-1492-release-recommendation (visual change).
- Cumulative Critic: 0 blocking.
- PR opened. The Coordinator gets a chunk-close memo.

## Status

- [ ] 04a recommendation module (precondition, parse, read-back)
- [ ] 04b precondition seam in the content handler and the prompt roster
- [ ] 04c pipeline step + prompt
- [ ] 04d version-bump disagreement trigger
- [ ] 04e continuity Freshness line
- [ ] 04f drawer widget + row detail
- [ ] 04g D8 comment rewrites + docs + live check
