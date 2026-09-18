# Wrap prompt compression — draft, review outcome and final text

Issue: #1617. Branch: `chore/wrap-prompt-compression` (TangleClaw-Builder2 checkout, off `main` @ fe45489).
Audit this implements: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/tangleclaw-wrap-prompt-review.md`
Architect review record: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/wrap-prompt-compression-review.md`

**Status: approved by the Architect with three wording corrections, all applied.** The before/after text below is the final implemented text.

## Review outcome

The Architect independently recounted the draft (standard 1664→1297, index example 442→381) and approved implementation with three corrections:

1. **Release step 3 had reversed an instruction.** The draft’s “`unsure` … not for avoiding a choice” discourages honest uncertainty; the original discouraged the opposite — forcing `cut`/`hold` in order to avoid `unsure`. Now: “Choose exactly one of `cut`, `hold`, or `unsure`. Use `unsure` when evidence is insufficient or the operator’s words and the work conflict without a clear resolution. Do not force `cut` or `hold` to avoid `unsure`.” (The Architect’s wording verbatim, with “exactly one of” carried over from the original so the single-value contract still reads explicitly.)
2. **“Edit nothing” contradicted the file-writing task.** Now: “Write only the recommendation file below. Do not change other files, cut a release, tag, or bump versions.”
3. **The changelog no-op gate kept its condition.** The draft implied any no-change reply stops the wrap. Now: “If neither an entry nor existing coverage satisfies verification, the wrap stops for the operator to confirm the skip” — existing coverage still passes without stopping.

Both decisions put to the Architect were approved: project-defined subsections rather than hard-coding `### Internal`, and grouping the two no-edit changelog cases provided their verification outcomes stay distinct.

## Word counts

Same counting method as the audit: whitespace-separated words in the template, before placeholder expansion. Final, after the corrections.

| Prompt | Before | After | Change |
|---|---:|---:|---:|
| changelog-update | 407 | 312 | −23% |
| release-recommendation | 358 | 311 | −13% |
| learnings-capture | 344 | 253 | −26% |
| memory-update | 555 | 434 | −22% |
| **Four standard prompts** | **1664** | **1310** | **−21%** |
| index-describe (conditional, both modes rendered) | 442 | 381 | −14% |

No fixed quota was targeted. These templates are mostly instruction rather than explanation, so the honest reduction is moderate. What came out: the repeated “You are at the end of a development session” openers (the generated step header already names the step), incident history (PR #166, #287, #571, #1309), source paths (`lib/wrap-steps/ai-content.js`, `lib/sessions.js`) and parser-implementation narration.

## What is preserved, deliberately

- Capture files and field names: `.tangleclaw/.wrap-summary.md`, `.tangleclaw/.release-recommendation.md`, and all ten `## Heading` literals.
- The required/optional split, the words REQUIRED and WANTED, the `_⚠ not captured_` marker and the no-padding rule.
- `## Result` tails; `{sessionScope}` and `{engineConfigFile}` tokens; the same three steps carrying `{sessionScope}`.
- The release-heading `grep` check (the incident number is gone, the check and the reason it exists are not).
- Operator release authority, exact-quote / `none stated` semantics, and the cut/hold/unsure vocabulary with first-word parsing.
- The dated no-novel-learnings line (audit finding 4 — left alone pending #1606).
- Every verification and skip description, including the changelog no-op that stops for operator confirmation when nothing else satisfies verification.
- The file-not-chat requirement, reduced to one sentence in each of the two prompts that need it.

## Out of scope (unchanged)

Pipeline order, gates, blocker flags, preconditions, capture-field lists, `_appendWrapRules` placement (audit finding 1), the completion-marker nonce instruction, and rollout. No service restart, no deploy.

Because these are code-owned defaults in `lib/wrap-default-pipeline.js`, both Builders — and every other project on the shared source — resolve to the shortened prompts once the change is rolled out. No per-project override is introduced, and neither Builder carries a `wrapStepOverrides` entry that would mask them. Live rollout verification across both Builders stays with PM and Jason.

## Before / after (final)

### changelog-update

**Before**

```
You are at the end of a development session. Update CHANGELOG.md with a new entry under the [Unreleased] section summarizing this session's work.

Steps:
1. Skim {engineConfigFile} for project-specific CHANGELOG conventions.
2. Inspect session scope. {sessionScope}
3. Read CHANGELOG.md to match existing style and locate the [Unreleased] section.
4. Edit CHANGELOG.md to add an entry under the appropriate Keep a Changelog subsection (### Added / ### Changed / ### Fixed / ### Removed / ### Deprecated / ### Security). Match the style of existing entries: concise, link issues with #N, name files when relevant, lead with the why not just the what.
5. After your Edit, verify the result with `grep '^## \[' CHANGELOG.md | head -5` — the descending release-heading sequence must remain intact (a CHANGELOG.md Edit that consumes an adjacent release-version heading is a known regression class on this project; PR #166 is the canonical incident).

When done, reply with a single `## Result` heading followed by a one-line summary of the entry you added.

If [Unreleased] ALREADY accounts for this session's commits — because the project's rules had you update it as you worked — do NOT invent a summary entry on top. Duplicating existing content inflates the apparent scope of the work. Reply with `## Result` then a one-line statement that the changelog already covers the session. Leaving the file untouched is a correct outcome here, not a skipped step.

How this step is verified: it passes if you edited CHANGELOG.md, if CHANGELOG.md already carries uncommitted edits, or if any commit in the session range touched CHANGELOG.md (a pull of `main` into your branch is not counted). So a session that logged as it worked satisfies the step without a further edit, while a session carrying commits that shipped no entry is blocked and told exactly which ones. If you are blocked that way, writing the missing entries clears it — an uncommitted entry counts, so you do not need to commit first.

If the session genuinely produced no CHANGELOG-worthy changes (pure exploration, no merges, no behavior change), do NOT edit the file and do not fabricate signal — reply with `## Result` then `No CHANGELOG entry — session produced no user-visible changes.` With no entries and no coverage the step will stop the wrap and ask the operator to confirm the skip: that is deliberate, because a no-op must be an operator's explicit decision rather than something the wrap reports as done.
```

**After**

```
Update CHANGELOG.md with an entry under `[Unreleased]` for this session's work.

1. Skim {engineConfigFile} for this project's CHANGELOG conventions — it may define subsections beyond the standard set, and may tie them to how the version bump is chosen.
2. Inspect session scope. {sessionScope}
3. Read CHANGELOG.md for its style and its `[Unreleased]` section.
4. Add the entry under the subsection that fits — `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Deprecated` / `### Security`, plus any this project defines. Match the existing entries: concise, issues linked as #N, files named where relevant, the why before the what.
5. Check `grep '^## \[' CHANGELOG.md | head -5`: the descending release-heading sequence must still be intact. An edit here can swallow an adjacent version heading.

Reply with a single `## Result` heading and a one-line summary of the entry you added.

Two cases call for leaving the file alone, answered under `## Result` instead:
- `[Unreleased]` ALREADY covers this session's commits, because the project's rules had you log as you worked. Say so — a summary on top of it inflates the apparent scope. A correct outcome, not a skipped step.
- The session genuinely produced nothing CHANGELOG-worthy: no merges, no behavior change. Reply `No CHANGELOG entry — session produced no user-visible changes.` and fabricate nothing. If neither an entry nor existing coverage satisfies verification, the wrap stops for the operator to confirm the skip, by design — a no-op is their decision, not something the wrap reports as done.

Verification: the step passes if you edited CHANGELOG.md, if it already carries uncommitted edits, or if a commit in the session range touched it (a pull of `main` into your branch is not counted). If it blocks, it names the commits that shipped no entry; writing those entries clears it, uncommitted, with no need to commit first.
```

### release-recommendation

**Before**

```
You are at the end of a development session. Recommend whether THIS wrap should cut a release. You are giving a recommendation, not making the decision: TangleClaw compares it with its own release checks, and when the two disagree it asks the operator.

Steps:
1. First, look back through this conversation for anything the operator said about the purpose of this wrap or about releasing. "Let's wrap and cut a release" or "ship it" points to cut. "Wrapping to save state before I leave", "mid-feature" or "not done yet" points to hold. The operator's own words outrank your reading of the work. Quote them exactly, and never paraphrase a quote. If they said nothing about it, or this conversation no longer shows what they said, write `none stated`; do not infer an intent and present it as theirs.
2. Then judge the work itself. {sessionScope} Read the `[Unreleased]` section of CHANGELOG.md. A release fits a clean boundary: the planned work is finished, it is committed or merged, and nothing is half-built. A save in the middle of a feature does not fit.
3. Choose exactly one: `cut`, `hold`, or `unsure`. Use `unsure` when the operator's words and the work point different ways and you can't tell which they meant, or when there is too little to judge. Do not choose `cut` or `hold` just to avoid `unsure`.

Do not edit CHANGELOG.md, version files, or anything else, and do not cut, tag or bump anything yourself: this step only writes its recommendation file.

WRITE A FILE at `.tangleclaw/.release-recommendation.md` containing these three `## Heading` blocks and nothing else. The wrap reads and then deletes this file, so do not rely on chat output: a terminal that renders markdown hides the `##` characters.

## ReleaseRecommendation
<one word on its own line: cut, hold, or unsure>

## OperatorIntent
<the operator's exact words about this wrap or releasing, in quotes, or none stated>

## Reason
<one or two sentences: why, naming what in the conversation or the work decided it>

`ReleaseRecommendation` is required. The wrap reads only its first word, and any word other than cut, hold or unsure counts as no recommendation.
```

**After**

```
Recommend whether THIS wrap should cut a release. You are recommending, not deciding: TangleClaw weighs your answer against its own release checks, and asks the operator when the two disagree.

1. First, look back through this conversation for anything the operator said about this wrap or about releasing. "Let's wrap and cut a release" or "ship it" points to cut; "saving state before I leave", "mid-feature" or "not done yet" points to hold. Their words outrank your reading of the work — quote them exactly, never paraphrased. If they said nothing, or the conversation no longer shows it, write `none stated`; never present an intent you inferred as theirs.
2. Then judge the work itself. {sessionScope} Read the `[Unreleased]` section of CHANGELOG.md. A release fits a clean boundary: the planned work is finished, committed or merged, nothing half-built. A save in the middle of a feature does not.
3. Choose exactly one of `cut`, `hold`, or `unsure`. Use `unsure` when evidence is insufficient or the operator's words and the work conflict without a clear resolution. Do not force `cut` or `hold` to avoid `unsure`.

Write only the recommendation file below. Do not change other files, cut a release, tag, or bump versions.

WRITE A FILE at `.tangleclaw/.release-recommendation.md` containing these three `## Heading` blocks and nothing else. It has to be a file: a terminal that renders markdown hides the `##` characters, so chat output cannot be parsed. The wrap reads the file, then deletes it.

## ReleaseRecommendation
<one word on its own line: cut, hold, or unsure>

## OperatorIntent
<the operator's exact words about this wrap or releasing, in quotes, or none stated>

## Reason
<one or two sentences: what in the conversation or the work decided it>

`ReleaseRecommendation` is required. The wrap reads only its first word, and any word other than cut, hold or unsure counts as no recommendation.
```

### learnings-capture

**Before**

```
You are at the end of a development session. Capture this session's learnings — non-obvious behaviors, validated patterns, failure modes, or anti-patterns worth remembering for future work — to `.tangleclaw/memories/learnings.md`.

Skip the obvious. Skip routine bug fixes. Capture only what would change how you'd approach a similar task next time.

Steps:
1. Read `.tangleclaw/memories/learnings.md` if it exists, to match the existing style. If it doesn't exist, create it with a top-level heading like `# Cross-Session Learnings — <project name>`.
2. Reflect on this session: what surprised you? What broke in an unexpected way? What pattern got validated by shipping? What's worth remembering next time?
3. Append a new entry. Convention: `## YYYY-MM-DD — <one-line title>` followed by a 2-5 sentence body. Link issues / PRs / commits with shortlinks where relevant.
4. If there's nothing novel this session, append a single line: `- YYYY-MM-DD: no novel learnings (routine work).` Do not fabricate signal — a session with nothing to learn is honest.
5. Save the file. The wrap commits it only if your project tracks `.tangleclaw/`; git ignores what `.gitignore` excludes. Where that path is ignored (TangleClaw's own clone ignores it), this file is local machine state: durable on this machine, read at session start, and carried by no wrap commit.

If `learnings.md` ALREADY carries an entry you wrote this session — because you logged it as you worked, or wrote it on an earlier attempt at this step — do NOT add another one. Reply with `## Result` then a one-line statement that the entry is already captured.

How this step is verified: it passes if you edited learnings.md during this step, or if the file was written during this session and carries an entry (a `## YYYY-MM-DD` heading or the no-op line) dated within the session. So an entry already on disk satisfies it without a further edit, while a file untouched since the session started is blocked.

When done, reply with a single `## Result` heading followed by a one-line summary of what you captured (or `no novel learnings` if applicable).
```

**After**

```
Capture this session's learnings to `.tangleclaw/memories/learnings.md`: non-obvious behaviors, validated patterns, failure modes, anti-patterns. Skip the obvious, skip routine bug fixes — capture only what would change how you'd approach a similar task next time.

1. Read `.tangleclaw/memories/learnings.md` if it exists, to match its style. If it does not exist, create it with a top-level heading like `# Cross-Session Learnings — <project name>`.
2. Ask what surprised you, what broke in an unexpected way, what pattern got validated by shipping.
3. Append an entry in the file's convention — `## YYYY-MM-DD — <one-line title>` followed by 2-5 sentences, linking issues / PRs / commits where relevant.
4. If nothing this session was novel, append exactly one line: `- YYYY-MM-DD: no novel learnings (routine work).` A session with nothing to learn is honest; fabricated signal is not.
5. Save the file. Where `.gitignore` excludes `.tangleclaw/`, it stays local to this machine — read at session start, carried by no wrap commit.

If `learnings.md` ALREADY carries an entry you wrote this session — logged as you worked, or written on an earlier attempt at this step — do not add another. Reply with `## Result` and say it is already captured.

Verification: the step passes if you edited learnings.md now, or if the file was written during this session and carries an entry dated within it. A file untouched since the session started is blocked.

When done, reply with a single `## Result` heading and a one-line summary of what you captured (or `no novel learnings`).
```

### memory-update

**Before**

```
You are at the end of a development session. Update `.tangleclaw/memories/MEMORY.md` to record this session AND emit a structured summary the wrap pipeline parses for the wrap commit.

File-edit steps:
1. Read `.tangleclaw/memories/MEMORY.md` for existing structure (Boot pointer / Next Session / Last Session blocks).
2. Read `.tangleclaw/memories/wrap-log.md` if it exists — older session blocks get demoted there to keep MEMORY.md scannable.
3. Inspect session scope. {sessionScope}
4. Update MEMORY.md:
   - Demote the existing `Last Session` block (if any) into `wrap-log.md` (prepend to the file's most-recent-first section; create the file if absent).
   - Write a new `Last Session` block in MEMORY.md describing THIS session: what shipped, what was learned, what's next. Match the existing dated-heading convention.
   - Update the boot pointer's open-queue priorities if they shifted this session.
5. Save both files. The wrap commits them only if your project tracks `.tangleclaw/`; git ignores what `.gitignore` excludes. Where that path is ignored (TangleClaw's own clone ignores it), these are local machine state: durable on this machine, read at session start, and carried by no wrap commit.

CRITICAL — structured summary FILE for pipeline parsing:

After saving MEMORY.md and wrap-log.md, WRITE A FILE at `.tangleclaw/.wrap-summary.md` containing these seven `## Heading` blocks and nothing else. The wrap pipeline reads and then deletes this file — do NOT rely on chat output. Headings are matched case-insensitively against the literals `summary`, `nextSteps`, `learnings`, `delta`, `openThreads`, `decisions`, `pointers` — use these exact spellings (no spaces, no extra words).

The first three are REQUIRED: omit one and the wrap stops and asks you again. The last four are WANTED: write them whenever the session has the content. The wrap completes without them and renders that section as `_⚠ not captured_` rather than inventing one — so never pad a section to avoid the marker. An honest gap is the designed outcome; a fabricated one corrupts the record the next session trusts.

## Summary
<2-3 sentence prose summary of this session, written as you'd write a commit subject — declarative, concise, present-tense>

## NextSteps
- <highest-priority next item>
- <second item>
- <additional items as needed>

## Learnings
- <non-obvious takeaway>
- <another takeaway>
- (or write `none` on a single line if routine)

## Delta
- <what MOVED this session and why: decisions taken and the reasoning behind them, what shipped or merged, what was deliberately deferred. Not a file list — the wrap records the changed files itself.>

## OpenThreads
- <what is still in flight: half-finished work, blockers, questions raised and left unresolved>

## Decisions
- <settled and locked: the calls a future session should NOT relitigate, each with the reason that settled it>

## Pointers
- <where to look first next time: canonical artifacts, issues, PRs, files>

Why a FILE and not chat: the wrap captures your tmux pane, but a TUI that renders markdown displays `## ` headings as styled text without the literal `##` characters, so headings emitted to chat cannot be parsed and BLOCK the wrap (#287). Writing the block to `.tangleclaw/.wrap-summary.md` preserves the raw markdown. `lib/wrap-steps/ai-content.js` reads + parses that file against the step's `captureFields` and `optionalCaptureFields`; a missing or empty REQUIRED block BLOCKS the wrap with `Required captureField "<name>" missing or empty in AI response`. The `## Summary` content also feeds the wrap-summary deriver in `lib/sessions.js` and becomes the wrap commit subject line.
```

**After**

```
Record this session in `.tangleclaw/memories/MEMORY.md`, then write the structured summary the wrap pipeline parses for the wrap commit.

File edits:
1. Read `.tangleclaw/memories/MEMORY.md` for its structure (Boot pointer / Next Session / Last Session blocks), and `.tangleclaw/memories/wrap-log.md` if it exists — older session blocks get demoted there to keep MEMORY.md scannable. Inspect session scope. {sessionScope}
2. Demote the existing `Last Session` block, if any, into `wrap-log.md` (prepend to its most-recent-first section; create the file if absent).
3. Write a new `Last Session` block in MEMORY.md for THIS session — what shipped, what was learned, what's next — in the existing dated-heading convention, and update the boot pointer's open-queue priorities if they shifted.
4. Save both files. Where `.gitignore` excludes `.tangleclaw/`, they stay local to this machine — read at session start, carried by no wrap commit.

Then WRITE A FILE at `.tangleclaw/.wrap-summary.md` containing these seven `## Heading` blocks and nothing else. It has to be a file: a terminal that renders markdown shows `## ` headings as styled text without the literal characters, so headings emitted to chat cannot be parsed and BLOCK the wrap. The wrap matches your headings case-insensitively against the literals `summary`, `nextSteps`, `learnings`, `delta`, `openThreads`, `decisions`, `pointers` — these exact spellings, no spaces, no extra words — and deletes the file once read.

The first three are REQUIRED: a missing or empty one blocks the wrap with `Required captureField "<name>" missing or empty in AI response`, and you are asked again. The last four are WANTED — write each whenever the session has the content. Without one the wrap still completes and renders that section as `_⚠ not captured_` rather than inventing it. Never pad a section to avoid the marker: an honest gap is the designed outcome, a fabricated one corrupts the record the next session trusts.

## Summary
<2-3 sentences, declarative and present-tense, as you'd write a commit subject — it becomes the wrap commit's subject line>

## NextSteps
- <highest-priority next item>
- <further items as needed>

## Learnings
- <non-obvious takeaway>
- (or write `none` on a single line if routine)

## Delta
- <what MOVED this session and why: decisions taken and their reasoning, what shipped or merged, what was deliberately deferred. Not a file list — the wrap records the changed files itself.>

## OpenThreads
- <what is still in flight: half-finished work, blockers, questions raised and left unresolved>

## Decisions
- <settled and locked: the calls a future session should NOT relitigate, each with the reason that settled it>

## Pointers
- <where to look first next time: canonical artifacts, issues, PRs, files>
```

### index-describe

**Before**

```
You are at the end of a development session. The project keeps AI-orientation index file(s) that need finishing so future sessions can find things faster.

FILL empty description stubs (do not restructure these files):
- `PROJECT-MAP.md` (Project Map, 3 empty stubs)

For EACH empty `<!-- describe -->` stub in the file(s) above:
- Replace the literal `<!-- describe -->` marker with a brief one-line description of what that directory or feature contains, based on its ACTUAL contents (read the directory / files if unsure).
- Keep it to a single concise line. No trailing newline changes to the rest of the file.

STRICT rules (fill-only files):
- Only touch lines that still contain the literal `<!-- describe -->` marker. Never overwrite an entry that already has a description (preserve curation).
- Do NOT add, remove, reorder, or restructure entries. Only fill empty stubs in place.

CURATE the auto-stubbed backlog (graduate TODO entries into their real home):
- `FEATURES.md` (Feature Index, 4 entries awaiting graduation)

Each file above has one or more `## TODO (auto-stubbed <date>)` blocks whose entries were auto-added when a session touched new files. Finish the job for EACH entry inside a `## TODO (auto-stubbed …)` block:
- Give it a real short **Name** in place of `**TBD**`, inferred from what the file actually is (read the file if unsure).
- Write a brief one-line description (keep an existing good description; replace any leftover `<!-- describe -->` marker).
- Keep the exact backtick path token unchanged (e.g. `lib/foo.js`) — it is the stable anchor.
- MOVE the finished entry out of the TODO block and under the single best-fit EXISTING category heading. Match the category to the entry; do not invent new categories.
- When a `## TODO (auto-stubbed …)` block has no entries left, DELETE the now-empty heading and its surrounding blank lines.

STRICT rules (curated files):
- Only ever touch entries currently inside a `## TODO (auto-stubbed …)` block, and the TODO headings themselves. NEVER modify, reorder, or delete an entry already under a real category heading, and never touch the file's top comment. That existing curation is authoritative.
- Do not drop any entry: every TODO entry must end up under a category. If you truly cannot tell what a file is, give it a best-effort name and file it under the closest category — never delete it.

Edit the file(s) directly with your file tools. The wrap commit picks the changes up automatically.

When done, reply with a single `## Result` heading followed by a one-line summary (e.g. "Graduated N entries, described M stubs"). If there was nothing to do, say so — do not fabricate.
```

**After**

```
This project keeps AI-orientation index file(s) with unfinished entries. Finish them so future sessions can find things faster.

FILL empty description stubs — fill-only, never restructure:
- `PROJECT-MAP.md` (Project Map, 3 empty stubs)

Replace each literal `<!-- describe -->` marker with one concise line saying what that directory or feature actually contains (read it if unsure). Leave the rest of the file as it is.

STRICT rules (fill-only files):
- Only touch lines that still contain the literal `<!-- describe -->` marker. Never overwrite an entry that already has a description (preserve curation).
- Do NOT add, remove, reorder, or restructure entries. Only fill empty stubs in place.

CURATE the auto-stubbed backlog — graduate TODO entries into their real home:
- `FEATURES.md` (Feature Index, 4 entries awaiting graduation)

Entries under a `## TODO (auto-stubbed <date>)` heading were auto-added when a session touched new files. Finish each one:
- Replace `**TBD**` with a real short name, inferred from what the file actually is (read it if unsure).
- Give it a brief one-line description (keep an existing good one; replace any leftover `<!-- describe -->` marker).
- Keep the backtick path token unchanged (e.g. `lib/foo.js`) — it is the stable anchor.
- MOVE it out of the TODO block and under the single best-fit EXISTING category heading. Match the category to the entry; do not invent new ones.
- Once a `## TODO (auto-stubbed …)` block has no entries left, DELETE the now-empty heading and its surrounding blank lines.

STRICT rules (curated files):
- Only ever touch entries currently inside a `## TODO (auto-stubbed …)` block, and the TODO headings themselves. NEVER modify, reorder, or delete an entry already under a real category heading, and never touch the file's top comment — that curation is authoritative.
- Drop no entry: every TODO entry must end up under a category. If you truly cannot tell what a file is, give it a best-effort name and file it under the closest category — never delete it.

Edit the file(s) directly with your file tools; the wrap commit picks the changes up.

When done, reply with a single `## Result` heading followed by a one-line summary (e.g. "Graduated N entries, described M stubs"). If there was nothing to do, say so — do not fabricate.
```
