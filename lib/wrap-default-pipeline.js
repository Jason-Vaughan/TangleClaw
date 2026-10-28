'use strict';

const wrapStepOverrides = require('./wrap-step-overrides');

/**
 * The code-owned wrap pipeline.
 *
 * Every project runs this one pipeline. The step list used to be per-project
 * data, one copy per workflow template; that meant the step list could drift,
 * fork, and silently diverge from the runner that executes it (#538).
 * Code-owning the pipeline makes the step list reviewable in the same diff as
 * the handlers it dispatches to.
 *
 * Per-project variation is configuration, not a different pipeline:
 * - `wrapStepOverrides` in `.tangleclaw/project.json` may disable or
 *   reconfigure an individual step (`lib/wrap-step-overrides.js` is the
 *   contract for what may change).
 * - The dedicated effect toggles (`releaseMode`, `featureIndexEnabled`,
 *   `projectMapEnabled`) remain each step's own runtime gate.
 *
 * Order and membership are framework-owned. Step order carries correctness
 * contracts between steps — the changelog must be written before the version
 * bump reads it to choose a level, and both before the commit that flushes
 * them — pinned by tests in `test/wrap-default-pipeline.test.js`.
 *
 * `steps()` returns a deep copy so no caller can mutate the shared spec;
 * `_internal.pipeline` is a test seam for synthesizing variant pipelines.
 */

const DEFAULT_WRAP_PIPELINE = {
  "schemaVersion": "1.0",
  "steps": [
    {
      "_orderNote": "MUST be first (#854). Asks prawduct for its session-end verdict before any step writes to the tree, so an unmet gate surfaces at the door rather than after changelog-update and version-bump have run. Advisory by default — the pipeline continues; wrapStepOverrides.preflight.blocker=true makes it halt here.",
      "id": "preflight",
      "kind": "preflight",
      "blocker": false,
      "allowOverride": true
    },
    {
      "_orderNote": "Before every step that writes (#1406). Lists uncommitted files this session did not change and asks the operator to include or leave each, so the question comes before the content steps rather than at the commit. The commit step re-checks the same rule.",
      "id": "session-files",
      "kind": "session-files",
      "blocker": true
    },
    {
      "id": "open-pr-check",
      "kind": "pr-check",
      "blocker": true
    },
    {
      "id": "changelog-update",
      "kind": "ai-content",
      "blocker": true,
      "allowOverride": true,
      "_verifyNote": "One declared path, not two (#2523). The entry the step asks for is a NEW file under changelog.d/, so the directory is declared rather than a filename nobody knows in advance; ai-content reads a declared directory as a digest of the entries the step may produce there (for changelog.d/, names the fragment contract accepts), so a created fragment is a change to the mutation check and the file-settle signal alike, while a misnamed file written there reads as no change and the coverage predicate names it. CHANGELOG.md is deliberately NOT declared here any more: ai-content.js's route-1 mutation check (`_verifyChangedGate`) passes a step the instant ANY one of its declared paths changed, with no awareness of which route changed it — so while CHANGELOG.md stayed declared, a direct edit to it alone (no fragment at all) satisfied this step unconditionally, defeating the whole point of closing the pre-boundary transition. CHANGELOG.md's own promotion is not this step's concern: that happens in the LATER, independent `version-bump` step (lib/wrap-steps/version-bump.js), which compiles every fragment into [Unreleased] on release regardless of what this step's gate decided. Dropping CHANGELOG.md from this declaration means route 1 only ever sees the changelog.d/ digest, so a direct edit with no fragment now correctly falls through to route 2 (changelog-coverage, lib/wrap-steps/changelog-coverage.js), which recognizes only a changelog.d/ fragment (or a project's declared coveragePaths) — never a direct CHANGELOG.md edit. Deliberately NO coveragePaths glob for changelog.d/: a glob would accept a misnamed file as the changelog being maintained, so changelog-coverage judges a fragment by the name contract (lib/changelog-fragments.js) instead.",
      "verifyChanged": [
        "changelog.d/"
      ],
      "verifySatisfiedBy": "changelog-coverage",
      "prompt": "Record this session's work as a changelog FRAGMENT under `changelog.d/`, not as an edit to CHANGELOG.md.\n\n1. Skim {engineConfigFile} for this project's CHANGELOG conventions — it may define subsections beyond the standard set, and may tie them to how the version bump is chosen.\n2. Inspect session scope. {sessionScope}\n3. Read CHANGELOG.md's `[Unreleased]` section and any files already in `changelog.d/` for the house style.\n4. Write ONE file named `changelog.d/<issue>.<slug>.<type>.md`. `<issue>` is the GitHub issue number: a positive integer with no leading zero. `<slug>` is 1 to 48 of `a-z`, `0-9`, `-`, telling this fragment from any other for the same issue. `<type>` is the subsection the entry lands under and sets the release bump: `added`, `changed`, `removed` or `deprecated` (minor), `fixed`, `security` or `internal` (patch). The body is ONE Markdown list entry: its first non-blank line starts with `- ` and the text, continuation lines may follow, and it holds no heading line and no code fence. Match the existing entries: concise, issues linked as #N, files named where relevant, the why before the what. Work on several issues gets one fragment each. Do not edit CHANGELOG.md: the release compiles the fragments into `[Unreleased]` and deletes them. A direct edit to CHANGELOG.md's `[Unreleased]` section is not accepted for session work — fragments in `changelog.d/` are compiled into `[Unreleased]` only when a release wrap runs.\n\nReply with a single `## Result` heading and a one-line summary naming the fragment you wrote.\n\nTwo cases call for writing nothing, answered under `## Result` instead:\n- A fragment for this session's work ALREADY sits in `changelog.d/`, or `[Unreleased]` already covers it, because the project's rules had you log as you worked. Say so — a second entry inflates the apparent scope. A correct outcome, not a skipped step.\n- The session genuinely produced nothing CHANGELOG-worthy: no merges, no behavior change. Reply `No CHANGELOG entry — session produced no user-visible changes.` and fabricate nothing. If neither a fragment nor existing coverage satisfies verification, the wrap stops for the operator to confirm the skip, by design — a no-op is their decision, not something the wrap reports as done.\n\nVerification: the step passes if you wrote or changed a correctly named fragment in `changelog.d/`, if one is already there uncommitted, if a commit in the session range added one, or if a project-declared `coveragePaths` path was edited instead (a monorepo's nested changelog). A direct edit to `CHANGELOG.md` does NOT satisfy this step, with no exception — not even when this wrap also cuts a release: the release's own compilation of fragments into `[Unreleased]` happens afterward, in the separate version-bump step, and does not touch this step's verification. A file in `changelog.d/` whose name is not `<issue>.<slug>.<type>.md` is not an entry: it is named as unlogged work instead. If the step blocks, it names the commits or files that shipped with no entry; writing the fragment clears it, uncommitted, with no need to commit first."
    },
    {
      "_orderNote": "AFTER changelog-update, so the AI judges the entries this session wrote, and BEFORE version-bump, which reads this step's result to decide whether a disagreement with its own readiness checks halts for the operator (#1492).",
      "_preconditionNote": "Sends no prompt when the release decision is already closed: releaseMode off, a Cut/Hold/level the operator already chose, or no [Unreleased] entries. A non-blocker: a recommendation that never arrives leaves version-bump deciding on its readiness checks alone.",
      "id": "release-recommendation",
      "kind": "ai-content",
      "blocker": false,
      "allowOverride": true,
      "precondition": "release-decision-open",
      "prompt": "Recommend whether THIS wrap should cut a release. You are recommending, not deciding: TangleClaw weighs your answer against its own release checks, and asks the operator when the two disagree.\n\n1. First, look back through this conversation for anything the operator said about this wrap or about releasing. \"Let's wrap and cut a release\" or \"ship it\" points to cut; \"saving state before I leave\", \"mid-feature\" or \"not done yet\" points to hold. Their words outrank your reading of the work — quote them exactly, never paraphrased. If they said nothing, or the conversation no longer shows it, write `none stated`; never present an intent you inferred as theirs.\n2. Then judge the work itself. {sessionScope} Read the `[Unreleased]` section of CHANGELOG.md. A release fits a clean boundary: the planned work is finished, committed or merged, nothing half-built. A save in the middle of a feature does not.\n3. Choose exactly one of `cut`, `hold`, or `unsure`. Use `unsure` when evidence is insufficient or the operator's words and the work conflict without a clear resolution. Do not force `cut` or `hold` to avoid `unsure`.\n\nWrite only the recommendation file below. Do not change other files, cut a release, tag, or bump versions.\n\nWRITE A FILE at `.tangleclaw/.release-recommendation.md` containing these three `## Heading` blocks and nothing else. It has to be a file: a terminal that renders markdown hides the `##` characters, so chat output cannot be parsed. The wrap reads the file, then deletes it.\n\n## ReleaseRecommendation\n<one word on its own line: cut, hold, or unsure>\n\n## OperatorIntent\n<the operator's exact words about this wrap or releasing, in quotes, or none stated>\n\n## Reason\n<one or two sentences: what in the conversation or the work decided it>\n\n`ReleaseRecommendation` is required. The wrap reads only its first word, and any word other than cut, hold or unsure counts as no recommendation.",
      "captureFile": ".tangleclaw/.release-recommendation.md",
      "captureFields": [
        "releaseRecommendation"
      ],
      "optionalCaptureFields": [
        "operatorIntent",
        "reason"
      ]
    },
    {
      "_orderNote": "MUST run AFTER changelog-update. This step reads CHANGELOG.md from disk and stages the whole promoted file; the commit step's flush writes that snapshot back verbatim. Staged before the AI's edit, the flush silently discards that edit, and the bump level is derived from a CHANGELOG missing this session's own entry. The same order holds for the fragments changelog-update now writes under changelog.d/ (#1220): the release preparation compiles them into [Unreleased] here, before the level is decided, so a bump staged first would miss the session's fragment exactly as it would miss a direct edit.",
      "_blockerNote": "A blocker only so an unanswered release decision halts before commit (#1492): the step returns ok:false for nothing else, since every other refusal is a skip. A handler throw halts too, which stops a wrap that would otherwise commit without the release it was meant to write.",
      "id": "version-bump",
      "kind": "version-bump",
      "blocker": true
    },
    {
      "id": "learnings-capture",
      "kind": "ai-content",
      "blocker": true,
      "allowOverride": true,
      "verifyChanged": [
        ".tangleclaw/memories/learnings.md"
      ],
      "verifySatisfiedBy": "learnings-entry",
      "prompt": "Capture this session's learnings to `.tangleclaw/memories/learnings.md`: non-obvious behaviors, validated patterns, failure modes, anti-patterns. Skip the obvious, skip routine bug fixes — capture only what would change how you'd approach a similar task next time.\n\n1. Read `.tangleclaw/memories/learnings.md` if it exists, to match its style. If it does not exist, create it with a top-level heading like `# Cross-Session Learnings — <project name>`.\n2. Ask what surprised you, what broke in an unexpected way, what pattern got validated by shipping.\n3. Append an entry in the file's convention — `## YYYY-MM-DD — <one-line title>` followed by 2-5 sentences, linking issues / PRs / commits where relevant.\n4. If nothing this session was novel, append exactly one line: `- YYYY-MM-DD: no novel learnings (routine work).` A session with nothing to learn is honest; fabricated signal is not.\n5. Save the file. Where `.gitignore` excludes `.tangleclaw/`, it stays local to this machine — read at session start, carried by no wrap commit.\n\nIf `learnings.md` ALREADY carries an entry you wrote this session — logged as you worked, or written on an earlier attempt at this step — do not add another. Reply with `## Result` and say it is already captured.\n\nVerification: the step passes if you edited learnings.md now, or if the file was written during this session and carries an entry dated within it. A file untouched since the session started is blocked.\n\nWhen done, reply with a single `## Result` heading and a one-line summary of what you captured (or `no novel learnings`)."
    },
    {
      "id": "learnings-db-write",
      "kind": "learnings-db-write",
      "blocker": false
    },
    {
      "id": "rule-proposal",
      "kind": "rule-proposal",
      "blocker": false
    },
    {
      "id": "next-session-prime",
      "kind": "priming-roll"
    },
    {
      "id": "features-toc",
      "kind": "features-toc"
    },
    {
      "id": "project-map",
      "kind": "project-map"
    },
    {
      "id": "index-describe",
      "kind": "index-describe",
      "blocker": false
    },
    {
      "id": "memory-update",
      "kind": "ai-content",
      "blocker": true,
      "allowOverride": true,
      "prompt": "Record this session in `.tangleclaw/memories/MEMORY.md`, then write the structured summary the wrap pipeline parses for the wrap commit.\n\nFile edits:\n1. Read `.tangleclaw/memories/MEMORY.md` for its structure (Boot pointer / Next Session / Last Session blocks), and `.tangleclaw/memories/wrap-log.md` if it exists — older session blocks get demoted there to keep MEMORY.md scannable. Inspect session scope. {sessionScope}\n2. Demote the existing `Last Session` block, if any, into `wrap-log.md` (prepend to its most-recent-first section; create the file if absent).\n3. Write a new `Last Session` block in MEMORY.md for THIS session — what shipped, what was learned, what's next — in the existing dated-heading convention, and update the boot pointer's open-queue priorities if they shifted.\n4. Save both files. Where `.gitignore` excludes `.tangleclaw/`, they stay local to this machine — read at session start, carried by no wrap commit.\n\nThen WRITE A FILE at `.tangleclaw/.wrap-summary.md` containing these seven `## Heading` blocks and nothing else. It has to be a file: a terminal that renders markdown shows `## ` headings as styled text without the literal characters, so headings emitted to chat cannot be parsed and BLOCK the wrap. The wrap matches your headings case-insensitively against the literals `summary`, `nextSteps`, `learnings`, `delta`, `openThreads`, `decisions`, `pointers` — these exact spellings, no spaces, no extra words — and deletes the file once read.\n\nThe first three are REQUIRED: a missing or empty one blocks the wrap with `Required captureField \"<name>\" missing or empty in AI response`, and you are asked again. The last four are WANTED — write each whenever the session has the content. Without one the wrap still completes and renders that section as `_⚠ not captured_` rather than inventing it. Never pad a section to avoid the marker: an honest gap is the designed outcome, a fabricated one corrupts the record the next session trusts.\n\n## Summary\n<2-3 sentences, declarative and present-tense, as you'd write a commit subject — it becomes the wrap commit's subject line>\n\n## NextSteps\n- <highest-priority next item>\n- <further items as needed>\n\n## Learnings\n- <non-obvious takeaway>\n- (or write `none` on a single line if routine)\n\n## Delta\n- <what MOVED this session and why: decisions taken and their reasoning, what shipped or merged, what was deliberately deferred. Not a file list — the wrap records the changed files itself.>\n\n## OpenThreads\n- <what is still in flight: half-finished work, blockers, questions raised and left unresolved>\n\n## Decisions\n- <settled and locked: the calls a future session should NOT relitigate, each with the reason that settled it>\n\n## Pointers\n- <where to look first next time: canonical artifacts, issues, PRs, files>",
      "captureFile": ".tangleclaw/.wrap-summary.md",
      "captureFields": [
        "summary",
        "nextSteps",
        "learnings"
      ],
      "optionalCaptureFields": [
        "delta",
        "openThreads",
        "decisions",
        "pointers"
      ]
    },
    {
      "id": "commit",
      "kind": "commit",
      "blocker": true
    },
    {
      "id": "continuity-write",
      "kind": "continuity-write",
      "blocker": false
    },
    {
      "id": "apply-pr-resolutions",
      "kind": "pr-merge",
      "blocker": false
    },
    {
      "id": "handoff-stage",
      "kind": "handoff-stage",
      "blocker": false
    }
  ]
};

// Test seam: tests synthesizing variant pipelines (broken steps, unknown
// kinds, reordered specs) assign here and restore in a finally block. The
// shipped constant itself is never mutated — `steps()` deep-copies.
const _internal = { pipeline: DEFAULT_WRAP_PIPELINE };

/**
 * The wrap pipeline's step specs, deep-copied so callers can't mutate the
 * shared definition (step handlers and the override resolver treat specs as
 * read-only, but a copy makes that a guarantee rather than a convention).
 * @returns {object[]} `wrap_pipeline.steps[]`-shaped step specs, in run order.
 */
function steps() {
  return JSON.parse(JSON.stringify(_internal.pipeline.steps));
}

/**
 * The legacy `{command, steps, captureFields}` wrap shape, derived from the
 * pipeline: step ids in run order plus the union of every step's
 * `captureFields` AND `optionalCaptureFields`. Its consumer is the wrap HTTP
 * payload (`lib/sessions.js`, forwarded by `server.js`), which reads this
 * instead of re-deriving.
 *
 * Both lists count because this field answers "what may this wrap produce",
 * not "what must it produce" — the distinction the last paragraph already
 * drew, now that a step can want a field without requiring it. An optional
 * field the AI writes lands in `parsedFields` exactly like a required one, so
 * a shape that omitted it would under-report the wrap's own output.
 *
 * Deliberately NOT override-aware, unlike `effectiveStepIds`: captureFields
 * name what the pane parser should look for, and parsing tolerates absent
 * headings — so a project whose `memory-update` is disabled just never
 * produces the fields. Treat the list as "fields this wrap MAY produce",
 * never "fields this wrap WILL produce".
 * @returns {{ command: null, steps: string[], captureFields: string[] }}
 */
function wrapShape() {
  const specs = _internal.pipeline.steps;
  const ids = specs
    .map((s) => (s && typeof s.id === 'string' ? s.id : null))
    .filter((id) => id !== null);
  const captureSet = new Set();
  for (const spec of specs) {
    if (!spec) continue;
    for (const list of [spec.captureFields, spec.optionalCaptureFields]) {
      if (Array.isArray(list)) {
        for (const field of list) captureSet.add(field);
      }
    }
  }
  return { command: null, steps: ids, captureFields: Array.from(captureSet) };
}

/**
 * The step ids a given project's wrap actually runs: the pipeline minus
 * steps its `wrapStepOverrides` disable. For scoring/reporting surfaces
 * that must not hold a project accountable for steps it deliberately
 * turned off (the dedicated effect toggles are runtime gates inside their
 * steps and are not visible here).
 * @param {object|null|undefined} overrides - The project's `wrapStepOverrides` map
 * @returns {string[]} Enabled step ids, in run order.
 */
function effectiveStepIds(overrides) {
  return _internal.pipeline.steps
    .filter((s) => wrapStepOverrides.resolveStep(s, overrides || null).enabled)
    .map((s) => s.id);
}

module.exports = { steps, wrapShape, effectiveStepIds, _internal };
