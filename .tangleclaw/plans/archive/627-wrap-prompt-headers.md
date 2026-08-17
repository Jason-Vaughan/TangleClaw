# Plan — #627: self-identifying wrap ai-content prompts

**Issue:** #627 — the wrap's `ai-content` pane prompts arrive as near-identical walls of
text with no self-identification, so the operator cannot tell "pipeline progressing" from
"wrap re-fired." Trains distrust → operator stops pressing Wrap (#571 failure mode).

**Type/size:** bugfix (UX/trust), small-to-medium. Files: `lib/wrap-pipeline.js`,
`lib/wrap-steps/ai-content.js`, tests.

## Confidence check
1. **Problem:** three `ai-content` prompts hit the pane unlabeled; indistinguishable from a re-fire.
2. **Success:** every dispatched `ai-content` prompt begins with a self-identifying, engine-agnostic
   plain-text header; the fixed content steps carry an accurate "step N of M".
3. **Out of scope:** the changelog-gate family (#659/#660/#665/#640), drawer skip-reporting (#571).

## Ground truth (re-derived — issue's file refs are stale)
- The issue cites `data/templates/prawduct/template.json`, DELETED in Chunk 06b. Pipeline is now
  code-owned in `lib/wrap-default-pipeline.js`.
- Exactly THREE `kind:'ai-content'` prompting steps: `changelog-update` (pos 2),
  `learnings-capture` (pos 4), `memory-update` (pos 10).
- `index-describe` (pos 9) is a SEPARATE kind that emits a pane prompt by DELEGATING to
  `ai-content.run` with a synthesized `kind:'ai-content'` step — but only when it has
  describable targets (dynamic, decided at pos 9).

## Key design constraint
An accurate "of 4 vs of 3" is infeasible upfront: `index-describe`'s participation is decided
at pos 9, after the first two content prompts already fired. So the denominator cannot count it.

## Design
- **Runner pre-pass** `_planAiContentPrompts(steps, overrides, options, session)` → ordered ids of
  prompt-eligible `ai-content`-kind steps. Eligible = enabled ∧ non-empty resolved prompt ∧ not
  override-skipped (`skipAiContent`) ∧ (tmux, or webui with captureFields+captureFile). Session-aware
  so the count is right on both the tmux pane and the ClawBridge gateway.
- Runner sets `context.aiContentProgress = {ordinal, total}` on those steps.
- **`ai-content.js`** prepends a first-line header before send on BOTH paths (tmux + gateway):
  - with `aiContentProgress`: `[TangleClaw wrap — step N of M: <id>]`
  - without (index-describe delegation / direct test): `[TangleClaw wrap — <id>]`
- Engine-agnostic: plain text, no markdown/`##` (per standing rule 5). Header is in the PROMPT we
  send, not parsed as a reply → no interference with captureField parsing or the ≥20-char gate.

## Tests (regression)
- `_wrapStepHeader`: numbered when progress present; numberless fallback (index-describe shape).
- `_planAiContentPrompts`: default → [changelog-update, learnings-capture, memory-update] (total 3,
  index-describe EXCLUDED → "of 3, not of 4"); a disabled/skip-override core step drops the total;
  webui session → only memory-update (total 1).
- `ai-content.run`: the string handed to sendKeys begins with the header (numbered + numberless).

## Verify → Critic (chunk) → PR
