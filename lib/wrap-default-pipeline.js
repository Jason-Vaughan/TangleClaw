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
 * - The dedicated effect toggles (`versionBumpEnabled`, `featureIndexEnabled`,
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
      "id": "open-pr-check",
      "kind": "pr-check",
      "blocker": true
    },
    {
      "id": "changelog-update",
      "kind": "ai-content",
      "blocker": true,
      "allowOverride": true,
      "verifyChanged": [
        "CHANGELOG.md"
      ],
      "verifySatisfiedBy": "changelog-coverage",
      "prompt": "You are at the end of a development session. Update CHANGELOG.md with a new entry under the [Unreleased] section summarizing this session's work.\n\nSteps:\n1. Skim {engineConfigFile} for project-specific CHANGELOG conventions.\n2. Inspect session scope. Run `git log --oneline HEAD~10..HEAD`, `git diff HEAD~10..HEAD --stat`, and `git status --short`. If `.tangleclaw/project.json` has a non-null `lastWrapSha`, use `<lastWrapSha>..HEAD` for a tighter range.\n3. Read CHANGELOG.md to match existing style and locate the [Unreleased] section.\n4. Edit CHANGELOG.md to add an entry under the appropriate Keep a Changelog subsection (### Added / ### Changed / ### Fixed / ### Removed / ### Deprecated / ### Security). Match the style of existing entries: concise, link issues with #N, name files when relevant, lead with the why not just the what.\n5. After your Edit, verify the result with `grep '^## \\[' CHANGELOG.md | head -5` — the descending release-heading sequence must remain intact (a CHANGELOG.md Edit that consumes an adjacent release-version heading is a known regression class on this project; PR #166 is the canonical incident).\n\nWhen done, reply with a single `## Result` heading followed by a one-line summary of the entry you added.\n\nIf [Unreleased] ALREADY accounts for this session's commits — because the project's rules had you update it as you worked — do NOT invent a summary entry on top. Duplicating existing content inflates the apparent scope of the work. Reply with `## Result` then a one-line statement that the changelog already covers the session. Leaving the file untouched is a correct outcome here, not a skipped step.\n\nHow this step is verified: it passes if you edited CHANGELOG.md, if CHANGELOG.md already carries uncommitted edits, or if every commit in the session range touched CHANGELOG.md in its own diff. So a session that logged as it worked satisfies the step without a further edit, while a session carrying commits that shipped no entry is blocked and told exactly which ones. If you are blocked that way, writing the missing entries clears it — an uncommitted entry counts, so you do not need to commit first.\n\nIf the session genuinely produced no CHANGELOG-worthy changes (pure exploration, no merges, no behavior change), do NOT edit the file and do not fabricate signal — reply with `## Result` then `No CHANGELOG entry — session produced no user-visible changes.` With no entries and no coverage the step will stop the wrap and ask the operator to confirm the skip: that is deliberate, because a no-op must be an operator's explicit decision rather than something the wrap reports as done."
    },
    {
      "_orderNote": "MUST run AFTER changelog-update. This step reads CHANGELOG.md from disk and stages the whole promoted file; the commit step's flush writes that snapshot back verbatim. Staged before the AI's edit, the flush silently discards that edit, and the bump level is derived from a CHANGELOG missing this session's own entry.",
      "id": "version-bump",
      "kind": "version-bump",
      "blocker": false
    },
    {
      "id": "learnings-capture",
      "kind": "ai-content",
      "blocker": true,
      "allowOverride": true,
      "verifyChanged": [
        ".tangleclaw/memories/learnings.md"
      ],
      "prompt": "You are at the end of a development session. Capture this session's learnings — non-obvious behaviors, validated patterns, failure modes, or anti-patterns worth remembering for future work — to `.tangleclaw/memories/learnings.md`.\n\nSkip the obvious. Skip routine bug fixes. Capture only what would change how you'd approach a similar task next time.\n\nSteps:\n1. Read `.tangleclaw/memories/learnings.md` if it exists, to match the existing style. If it doesn't exist, create it with a top-level heading like `# Cross-Session Learnings — <project name>`.\n2. Reflect on this session: what surprised you? What broke in an unexpected way? What pattern got validated by shipping? What's worth remembering next time?\n3. Append a new entry. Convention: `## YYYY-MM-DD — <one-line title>` followed by a 2-5 sentence body. Link issues / PRs / commits with shortlinks where relevant.\n4. If there's nothing novel this session, append a single line: `- YYYY-MM-DD: no novel learnings (routine work).` Do not fabricate signal — a session with nothing to learn is honest.\n5. Save the file. The commit step will pick it up via `git add -A`.\n\nWhen done, reply with a single `## Result` heading followed by a one-line summary of what you captured (or `no novel learnings` if applicable)."
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
      "prompt": "You are at the end of a development session. Update `.tangleclaw/memories/MEMORY.md` to record this session AND emit a structured summary the wrap pipeline parses for the wrap commit.\n\nFile-edit steps:\n1. Read `.tangleclaw/memories/MEMORY.md` for existing structure (Boot pointer / Next Session / Last Session blocks).\n2. Read `.tangleclaw/memories/wrap-log.md` if it exists — older session blocks get demoted there to keep MEMORY.md scannable.\n3. Inspect session scope: `git log --oneline HEAD~10..HEAD` (or `<lastWrapSha>..HEAD` if `.tangleclaw/project.json` has a non-null `lastWrapSha`), `git status --short`.\n4. Update MEMORY.md:\n   - Demote the existing `Last Session` block (if any) into `wrap-log.md` (prepend to the file's most-recent-first section; create the file if absent).\n   - Write a new `Last Session` block in MEMORY.md describing THIS session: what shipped, what was learned, what's next. Match the existing dated-heading convention.\n   - Update the boot pointer's open-queue priorities if they shifted this session.\n5. Save both files. The commit step picks them up via `git add -A`.\n\nCRITICAL — structured summary FILE for pipeline parsing:\n\nAfter saving MEMORY.md and wrap-log.md, WRITE A FILE at `.tangleclaw/.wrap-summary.md` containing EXACTLY these three `## Heading` blocks and nothing else. The wrap pipeline reads and then deletes this file — do NOT rely on chat output. Headings are matched case-insensitively against the literals `summary`, `nextSteps`, `learnings` — use these exact spellings (no spaces, no extra words):\n\n## Summary\n<2-3 sentence prose summary of this session, written as you'd write a commit subject — declarative, concise, present-tense>\n\n## NextSteps\n- <highest-priority next item>\n- <second item>\n- <additional items as needed>\n\n## Learnings\n- <non-obvious takeaway>\n- <another takeaway>\n- (or write `none` on a single line if routine)\n\nWhy a FILE and not chat: the wrap captures your tmux pane, but a TUI that renders markdown displays `## ` headings as styled text without the literal `##` characters, so headings emitted to chat cannot be parsed and BLOCK the wrap (#287). Writing the block to `.tangleclaw/.wrap-summary.md` preserves the raw markdown. `lib/wrap-steps/ai-content.js` reads + parses that file against the step's `captureFields`; missing or empty blocks BLOCK the wrap with `Required captureField \"<name>\" missing or empty in AI response`. The `## Summary` content also flows into `_completeV2Wrap`'s summary deriver in `lib/sessions.js` and becomes the wrap commit subject line.",
      "captureFile": ".tangleclaw/.wrap-summary.md",
      "captureFields": [
        "summary",
        "nextSteps",
        "learnings"
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
 * `captureFields`. Consumers (`lib/sessions.js` wrap-payload/auto-complete)
 * read this instead of re-deriving.
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
    if (spec && Array.isArray(spec.captureFields)) {
      for (const field of spec.captureFields) captureSet.add(field);
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
