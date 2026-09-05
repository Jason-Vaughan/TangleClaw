---
name: train-12.5-chunk-d2
branch: fix/1251-1255-audit-defects-d2
governed_by:
  - docs/adr/0013-settings-take-effect-or-say-why-not.md
  - .prawduct/artifacts/architecture.md
  - .prawduct/artifacts/prime-delivery-direction.md
  - .prawduct/artifacts/project-preferences.md
---

# Train 12.5 — Chunk D2: the two audit defects that needed a design first

**Cars:** #1251, #1255 · **Base:** `fd72598` · **Critic mode:** chunk (D2a), cumulative-final (D2b)

The two instances the C1 audit found that chunk D deliberately did not build. D1 shipped the three
that shared a mechanism; these two each needed a decision before any code, and the chunk D plan said
so in terms: *"D2 opens at design, not at code."* Both decisions are now taken (below), so this plan
is the buildable form.

## What the design pass found, and how it changed both chunks

Neither issue needed the invention it asked for. Both answers were already in the repo, unread.

**#1251 — a reason for this engine is already declared in the profile, and nothing renders it.**
`data/engines/openclaw.json` carries `capabilities.awareness`, whose `reason` field is a paragraph
saying why this engine cannot receive a TangleClaw-authored context carrier: *"the remote host owns
its own context files, so TangleClaw can neither place a carrier there nor paste a prime. Recorded
gap, not an oversight."* D1c's ruling kept that key precisely because its text records a gap. It is
the precedent, not the field to render: it is developer-facing and scoped to the awareness path,
where what the operator needs is a sentence about the **config carrier**. So D2a declares
`configFormat.absentReason` beside the `filename` it explains, and `awareness.reason` stays what it
is. The consequence is the same either way and is the point: the operator-facing sentence is
**declared per engine and read identically by both realms**, so the cross-realm parity this ADR
demands is structural rather than a hand-copied string that can drift — a test asserts neither
realm contains a copy of it.

*(Built as described. Recorded here rather than silently rewritten because "reuse
`awareness.reason`" is the cheaper-looking move a later reader will propose again.)*

**#1255 — the provenance schema already exists in the profiles.**
`capabilities.startupInjection` and `capabilities.readOnlyModeMarker` each carry an `evidence`
sibling of `{verifiedOn, source}`, and `test/engine-config-managed-block.test.js` and
`test/wrap-plan-mode-precheck.test.js` already pin its shape (ISO date, non-empty source). The
issue's blocking question — sibling field, wrapper object, or separate map — has a house answer, and
picking it costs no new convention.

**And the two halves of #1255 are one design, not two.** The issue's second defect (comment
2026-09-04: `medusaWake` tells the log, not the operator) cannot be fixed cheaply while the wake data
is in `lib/`, because `public/` cannot `require()` it — the browser would need a second hardcoded
engine list to answer "can this engine be nudged", which is the drift ADR 0013 spends a whole
consequence section on. Once the wake block is a declared property of the profile, `GET /api/engines`
already ships it to the browser (`server.js` returns the whole profile), and `tcSettingDisposition`
computes the answer from the same bytes the server reads. **The migration is what makes the
honesty affordable**, which is why they are one chunk and not two.

## Two decisions, both operator-ratified this session

**#1251 states the loss; it does not build a rules editor.** The issue frames the work as needing
"a surface that does not exist", and the temptation is to build one. ADR 0013 asks that the operator
be *told*, not that the block become editable — and a rules editor for a block that has no effect on
the engine in question would be the odd deliverable. A real `rules.core` / `rules.extensions` editor
for the four engines where the block *does* work is a feature, filed separately, and it inherits
this chunk's disposition row for free when it is built.

**#1255 carries provenance as a sibling `evidence` map keyed by field**, not as a per-field wrapper:

```json
"wake": {
  "busyMarker": "esc to interrupt",
  "promptPattern": "^\\s*❯[\\u00a0 ]?$",
  "promptGlyph": "❯", "promptPad": " ",
  "placeholderSgr": [2], "idleMarker": null,
  "evidence": {
    "busyMarker": { "verifiedOn": "2026-07-11", "source": "…" },
    "idleMarker": { "verifiedOn": null, "source": "nothing found present at rest and absent mid-turn — null for an honest reason (#1106)" }
  }
}
```

Every value stays plain, so no reader in `lib/sessions.js` changes shape; provenance is per key, so
antigravity's measured `busyMarker` and its deliberately-unmeasured `promptPad` are not flattened
into one claim; and a guard can assert the two maps cover the same keys. A wrapper per field
(`{value, evidence}`) would make omission impossible but rewrites every reader and every test, and
diverges from the `evidence` convention the profiles already use.

## Requirements Confidence

**High.** Both are filed issues with reproducible statements verified against source this session
(`writeEngineConfig`'s skip branch and its swallowing call site at `lib/sessions.js`; the two wake
profiles and their seven consumers across `lib/sessions.js` and four test files). The two questions
that genuinely needed a judgement were put to the operator and answered; nothing else here is
inferred from a guess.

**Open assumptions**, recorded because a reader could not derive them:

- `[ASSUMPTION: the generated-config row's "was this a real choice" input is whether any
  rules.extensions value differs from its shipped default | MED impact | user can correct]` —
  `settingDisposition` derives its log level from provenance, and every existing row compares one
  stored scalar against one shipped default. A rules *block* has no such scalar, so the row's `read`
  hands back a derived boolean. This is a real extension of the table's contract and is called out
  in D2a's Done-when so the Critic sees it as a decision rather than a shortcut. It reads correctly
  against the issue's own example: a project that set `independentCritic: true` and gets nothing has
  lost real intent and warns; a project on untouched defaults records at info.
- `[ASSUMPTION: the modal calls this "Generated engine config", not "Project rules" | LOW impact |
  user can correct]` — the C1 design flagged the taxonomy trap (the modal's existing "Project Rules"
  section is the free-text `session_rules` DB feature, a different thing with the same word). Naming
  the row after the *carrier* rather than its contents sidesteps the collision entirely, and the
  carrier is a file the operator can go and look at.

## Norm reconciliation

- **ADR 0013 (settings take effect or say why not)** — `conforms`. Both chunks are its scheduled
  migrate-retroactivity work. D2a is the instance its Consequences section names by number
  (*"the silence in `writeEngineConfig` (#1251) was locally reasonable and globally wrong"*); D2b is
  the near-miss its Context section names (*"'we already log it' is the most plausible wrong answer
  to this norm"*).
- **`prime-delivery-direction.md` § Direction §1 corollary** (*a channel's limit is a declared
  property of the engine*) — `conforms`. D2b is the same construction one layer over, and the issue
  cites this corollary as its warrant.
- **`prime-delivery-direction.md` § Direction §3 corollary** (*the reachable capability must be able
  to report absence*) — `conforms`. Both chunks are absence-reporting.
- **`architecture.md` § Direction, honest-degradation** (*a read that could not be established
  reports `null` and names itself*) — `inapplicable because` ADR 0013 settles this explicitly in its
  "Why this is not the honest-degradation norm" section: nothing here is an unestablished read. The
  values are known; the *effect* is missing.
- **`architecture.md` § Direction, `detectAtPrompt` bounded exception (#1180)** — `conforms`, and
  D2b must not widen it. That exception lets one function fall back to staleness for an unprofiled
  engine. D2b changes where wake data *lives*; it must leave the set of profiled engines and the
  fallback behavior byte-identical. See D2b's Done-when.

## Chunk D2a — the engine-config carrier says what it cannot deliver (#1251)

**Visual change:** yes — a new statement in the settings modal.
**Type:** code · **Critic mode:** chunk

On an OpenClaw project, `writeEngineConfig` returns `{skipped: true}` because the profile declares
`configFormat.filename: null`, and the whole generated config goes with it: all five `rules.core`
flags, all six `rules.extensions` flags, the Global Rules document, and the PortHub, shared-docs and
session-memory guides. The skip is deliberate and correct on the write path — #240's Critic asked for
it so a launch does not shout — and the call site at `lib/sessions.js` then discards `skipReason`
without reading it. Nothing the operator can see says any of this.

The unit of loss is the **carrier**, not each rule: one file is absent, so everything that rides it
is absent. That is what the row states, and it is why the row is keyed on the carrier.

**Done when**
- A `generatedConfig` row exists in `ENGINE_CONDITIONAL_SETTINGS` gating on
  `configFormat.filename`, with its reason drawn from a field **declared in the engine profile**
  rather than composed in `lib/`. Adding a sixth engine with no config file writes its own sentence
  in its own profile and needs no code change in either realm.
- The browser half in `public/api-helper.js` reads that same declared field, so
  `test/setting-disposition.test.js`'s existing cross-realm agreement extends to this row **without
  a second copy of the sentence anywhere**. A mutation of the profile's text turns both realms red
  together — verify that, because a parity test that passes when only one realm changed is the
  failure mode this row is designed out of.
- The row's provenance input (`read`) is the derived boolean named in Open assumptions, with the
  reasoning at the row rather than in this plan — a plan is archived, `lib/engines.js` is not.
- The settings modal renders the statement where the engine is chosen, re-rendered on engine change
  like the silent-prime toggle, and says what is not delivered (the project's rules block and
  TangleClaw's operational guides) rather than naming an abstraction.
- The launch path stops discarding `skipReason`: a skip records at the level
  `settingDisposition` derives, not one the call site picks. The ADR is explicit that the level is
  the mechanism's to decide.
- A test pins that every engine **with** a config file is unaffected — the row must answer
  `applies: true` for claude, codex, aider and antigravity, or this ships a false statement on four
  engines to fix one.
- `.prawduct/operator-verification.md` gets an entry.

## Chunk D2b — wake data becomes a declared property of the engine, and says where it cannot nudge (#1255)

**Visual change:** yes — the `medusaWake` hint in the settings modal is wrong today and changes.
**Type:** code · **Critic mode:** cumulative-final

`ENGINE_WAKE_PROFILES` hardcodes `claude` and `antigravity` in `lib/medusa-wake.js`. Adding a sixth
engine to TangleClaw today means editing a `lib/` module — the construction
`prime-delivery-direction.md` § Direction §1 already forbids one layer up. And the one operator-facing
string about the feature says *"Claude sessions only for now"* when antigravity has worked since
#560, so the single surface that exists is both the wrong channel and out of date.

The per-field comments in that module are unusually good — each records whether a value was measured
from a live pane or is deliberately absent, and antigravity's entry explicitly refuses to inherit
Claude's `promptPad`. **That provenance is the payload of this migration**, not incidental
commentary: a field that loses "this was measured" becomes an assumption the next reader trusts.

**Done when**
- `data/engines/claude.json` and `data/engines/antigravity.json` declare a `wake` block in the
  agreed shape, with an `evidence` entry for every declared field — including the ones whose honest
  provenance is negative (`idleMarker: null` because nothing was found that separates the states;
  antigravity's `promptPad: null` because it has never been measured; `pasteRejectedMarker` measured
  on 1.1.22 and **not** re-confirmed on 1.1.24). Nothing in the module's comments is dropped: what
  does not fit `evidence.source` stays as prose next to the code that acts on it.
- `promptRe` crosses into JSON as a `promptPattern` string compiled once at load. A test compiles
  each declared pattern and asserts it matches the same live-capture fixtures the current tests use,
  and that it does **not** match the busy/dialog fixtures — the pattern is the injection gate, and a
  regex that silently fails to compile would read as "no profile" rather than as an error.
- `lib/medusa-wake.js` builds `ENGINE_WAKE_PROFILES` from the profiles and keeps the export, so its
  seven consumers in `lib/sessions.js` and the four test files that read
  `ENGINE_WAKE_PROFILES.claude` / `.antigravity` are untouched. **The tests that still pass are the
  suspects here**: the existing suite would go green against a migration that silently dropped a
  field, so each new guard needs a named mutation in the JSON verified red, not a green suite.
- **The derivation is lazy, not module-load.** The runtime reads engine profiles from
  `~/.tangleclaw/engines/`, not from `data/engines/` — `store.init()` canonical-source-overwrites
  the user-local copy from the bundle on every boot (#251), which is what carries a new `wake` block
  to existing installs with no migration. But `server.js` `require()`s every module *before* it
  calls `store.init()`, so a `const ENGINE_WAKE_PROFILES = buildFromProfiles()` at module load reads
  the directory in its pre-sync state — empty on a fresh install. That ships as **zero wake profiles,
  silently**, which is the failure this whole chunk is about, introduced by its own fix. Derive on
  first use behind a memoized getter on `module.exports` so every consumer's `ENGINE_WAKE_PROFILES[id]`
  access is unchanged, and pin the ordering with a test that builds a store whose engines dir is
  empty at require time, runs `init()`, and asserts claude still resolves.
- **A guard runs at the read, not only over the bundled files.** `lib/engines.js` already records
  that "an operator profile in `~/.tangleclaw/engines/` never passes through those tests" and refuses
  a bad write strategy at the write for that reason. A profile whose `wake` block is malformed —
  a `promptPattern` that will not compile, an `evidence` map that does not cover its fields — must be
  refused at the read and logged, leaving that engine unprofiled (the existing honest skip), never
  half-loaded into the injection gate.
- A guard asserts the `evidence` map and the declared fields cover the same keys in both directions
   — a field added without provenance fails, and a stale `evidence` entry for a removed field fails.
- The set of engines that can be nudged is unchanged by the migration itself. Codex, aider and
  openclaw declare no `wake` block and stay skipped; `detectAtPrompt`'s #1180 bounded exception is
  not widened.
- `medusaWake` becomes a row in `ENGINE_CONDITIONAL_SETTINGS` gating on the profile's declared wake
  block, with its browser half computing the same answer from the profile the engines API already
  ships — no second engine list in `public/`. ADR 0013 asks that a row be checked for
  partial-application before an `applies` gate is written for it (#1252's lesson): checked, and
  `applies` is right — an unprofiled engine is never nudged at all, so there is no half that runs.
  Record that check at the row, because the next reader's cheapest wrong move is assuming a caveat.
- The settings modal stops claiming "Claude sessions only for now" and renders the disposition
  instead. Verify against a real antigravity project that the modal no longer contradicts #560.
- The inert branch carries no `#settingsMedusaWake` element, so `doSaveSettings` attaches no value
  and cannot pick up a stale checkbox — the pattern `renderSilentPrimeToggle` already establishes.
  Pin it: a modal rendered on an unprofiled engine must POST no `medusaWake` key at all.
- `.prawduct/operator-verification.md` gets an entry.

### Not in D2, deliberately

- **A real `rules.core` / `rules.extensions` editor.** Filed as its own feature; D2a's row is what it
  will render through. Building it here would drag in the taxonomy-trap naming decision the C1
  design flagged, for a surface no issue asks for.
- **Wake profiles for codex, aider or openclaw.** A profile requires a live pane capture, and the
  module's first safety property forbids guessing one. Declaring an unmeasured signature to make the
  disposition read better would be the exact dishonesty this chunk exists to end.
- **The plugin-governed non-`claude-md` skip.** `writeEngineConfig` has a second silent skip for
  governed projects on a non-Claude carrier. It is the same class as #1251 and is not filed; note it
  and file it rather than absorbing it.

### Standing constraints

- Branch in a worktree; the primary checkout stays on `main` (it is the live install).
- Every new test gets a named mutation verified red. A green mutation is the finding.
- One PR for both chunks, `Fixes #1251` and `Fixes #1255`. Merge commit, branch single-use
  (`project-preferences.md` § Workflow).
- `docs/adr/0013-…` gains no new norm — D2 is its scheduled work, not an amendment. If either chunk
  finds the norm wanting, that is a ruling to record, not a doc edit to slip in.

## Status

- [x] D2a — `generatedConfig` disposition row, reason declared in the profile (#1251)
- [x] D2a — settings modal renders it; launch path stops discarding `skipReason`
- [x] D2a — tests written, every new test mutation-verified red
- [ ] D2a — chunk Critic, findings addressed
- [ ] D2b — `wake` block declared in both profiles with per-field `evidence` (#1255)
- [ ] D2b — `ENGINE_WAKE_PROFILES` derived from the profiles, consumers untouched
- [ ] D2b — `medusaWake` disposition row; modal copy corrected
- [ ] D2b — tests written, every new test mutation-verified red
- [ ] D2 — suite green, evidence recorded
- [ ] D2 — CHANGELOG entry
- [ ] D2 — cumulative Critic + verify-resolutions, final round clean
- [ ] D2 — PR with `Fixes #1251` and `Fixes #1255`
