# Train 12.5 — Chunk B: the launch picker honors the project's default

**Train:** 12.5 "Settings & Modals Cleanup" (TangleClaw-Roadmap master roadmap)
**Chunk:** B · **Branch:** `feat/596-picker-preselect` · **Base:** `55e69fb`
**Car:** #596
**Critic mode:** cumulative (single chunk on this branch — the cumulative serves as its review)

## The issue is not the issue

#596 as written asks for a facelift and a test net. **Both already shipped**, in PR #1003 (merged
2026-08-19 as `0cd4acb`), which nobody closed or annotated — so the issue text still claims the
picker "has never had a design pass or a test net". #1003 landed the modal's visual pass, the
`Auto` description correction in `data/engines/claude.json`, `test/launch-mode-picker.test.js`, and
a rewritten `test/engine-launch-modes.test.js`. The per-engine flag mapping the issue asked for is
covered more strongly still by `test/engine-launch-flags.test.js` and `test/codex-launch-modes.test.js`
(#731), which probe the installed CLI's own parser rather than asserting a profile against a copy
of itself.

What is left is the **scope-addition comment** (operator, 2026-07-17): preselect-from-project-default.
It was never built, and its absence is not a missing nicety — it makes a shipped setting inert.
Re-scope recorded on the issue: https://github.com/Jason-Vaughan/TangleClaw/issues/596#issuecomment-5545083666

## Requirements Confidence

**High.** The mechanism is located and read end to end (three named line numbers below), the
predicate to reuse already exists with a stated single-definition rationale, and the behavior the
operator asked for is written down in their own words on the issue.

## Chunk B1 · `defaultLaunchMode` is dead whenever the picker is visible

**Problem, traced.** Three facts compose into the defect:

1. `openLaunchModeModal` seeds the selection from `engine.defaultLaunchMode` — the **engine's**
   default, never the project's (`public/landing.js:1455`).
2. `confirmLaunchMode` then passes that mode **explicitly** to `doLaunchProject`, which puts it in
   the POST body (`public/landing.js:1410`).
3. `lib/sessions.js:349` applies the project's configured default only `if (!options.launchMode …)`
   — "an explicit caller choice always wins", by design and correctly.

So with `showLaunchModePicker: true` — the shipped default (`DEFAULT_PROJECT_CONFIG`) — an explicit
mode is sent on every launch and the project's configured default is never consulted. A project set
to `plan` launches interactive every time unless the operator re-picks by hand. The setting works
only on the hidden-picker path, which is the path where no explicit mode is sent.

This is the shape #741 and #758 are both about: a control that stores the operator's choice and
then does nothing observable with it.

**Fix.** `proceedWithLaunchModeCheck` already holds the `project` object it read
`showLaunchModePicker` off (`public/landing.js:1360`). Pass it through and seed the picker from
`project.defaultLaunchMode` when the engine honors that key, falling back to the engine default.

**Done when**
- Opening the picker on a project with a stored `defaultLaunchMode` preselects that mode.
- Accepting the preselection launches in it — the mode reaching `doLaunchProject` is the project's,
  not the engine's.
- A stored key the engine does not define, or defines as `disabled`, falls back to the engine
  default rather than checking a radio that is not there.
- A project with no stored default is unchanged: engine default, exactly as today.

## Chunk B2 · The picker offers modes its own gate excluded

**Found while reading B1, and it is the predicate B1 needs.** Two lines in one file disagree about
the same flag:

- `proceedWithLaunchModeCheck` counts `Object.values(engine.launchModes).filter(m => !m.disabled)`
  to decide whether the picker is worth showing (`public/landing.js:1367`).
- `openLaunchModeModal` then renders `Object.entries(engine.launchModes)` — **all** of them,
  `disabled` included (`public/landing.js:1462`).

So the gate can decide "two real choices, show the picker" and the picker can render three, one of
which the engine will refuse. `lib/engines.js:1063` (`honorsLaunchMode`) is the server's single
definition of "the engine will run this", and its own docstring says why it is one function: "the
launch path, the settings modal and the delivery ledger all answer this question, and a predicate
restated at each site is how one of them ends up warning about a default."

**Honest severity: latent, not live.** No bundled engine profile ships a `disabled` mode today
(checked all five). `disabled` is nonetheless a real supported field — `updateProject` rejects a
disabled mode key, and `test/launch-mode-settings.test.js` pins that rejection as "symmetric with
the picker filter". The symmetry it names does not currently exist in the picker.

**The family is four sites, not two.** The first pass routed only the two `landing.js` sites and left
`public/ui.js:1344` (the settings modal's default-mode dropdown) and `public/ui.js:2441` (the create
flow's Launch Posture) spelling it inline as `!m.disabled` — which is not even the same predicate:
for a truthy non-`true` `disabled` value it disagrees with `disabled !== true`, so the picker would
offer a mode both dropdowns hide and the operator could not configure what they had just been
offered. Caught by the Critic; the recorded decision now names the whole family.

**Done when**
- The picker renders only modes the engine will honor, matching the gate that decided to open it.
- The preselect fallback in B1 uses the same predicate, not a second spelling of it.
- Every browser site that asks "which modes will this engine run" reads that one predicate — the
  picker, its gate, the settings dropdown and the create flow.
- A test pins the browser predicate against the server's over every bundled profile, including the
  one value shape on which the two spellings can disagree.

## Scope decisions, recorded rather than silently taken

- **A stranded stored mode falls back silently in the picker.** When the project's stored key is not
  honored, B1 preselects the engine default without saying "your saved mode is unavailable here".
  The reason is that the state is reconciled at its source: `updateProject` **resets and persists**
  a stored mode the new engine cannot honor on an engine switch (`lib/projects.js:2597`, pinned by
  `test/launch-mode-settings.test.js` → "engine-switch reconciliation"), which is the path that
  produces stranding.
  Two justifications considered and **rejected as unsound**, recorded so nobody re-derives them:
  the settings modal does *not* label the stranded state for a per-project mode — the labelled
  surface at `public/api-helper.js:1886` is Master Control's own launch-mode default, a different
  setting; and `lib/sessions.js:355`'s warn sits inside `if (!options.launchMode …)`, so on the
  picker path — which always sends an explicit mode — it structurally cannot fire. Anyone debugging
  "my saved plan mode did not apply" will not find a log line, because there is none.
  Residual, accepted: a profile update that disables a mode under an *unchanged* engine strands a
  stored key with nothing reconciling it. The picker falls back correctly and `updateProject`
  rejects the key on the next save, so nothing misbehaves — it is simply unannounced.
- **The frontend cannot `require` `honorsLaunchMode`.** `public/` runs in a browser and `lib/engines.js`
  is CommonJS on the server; there is no build step (project Direction: no bundler, no transpiler). B2
  therefore adds ONE frontend predicate and routes **every** browser site that asks the question
  through it. It lives in `public/api-helper.js` as `tcHonoredLaunchModes` — the declared shared
  frontend base, loaded before every page script — rather than in `landing.js`, so `ui.js` does not
  depend on the script order in `index.html` to see it. This follows chunk A's own precedent
  (`tcRenderSettingsWarnings` moved there rather than being copied). The server keeps its own
  definition; that duplication is a boundary, not a restatement, and
  `test/launch-mode-picker.test.js` pins the two predicates to each other so it stays one.
- **No facelift work.** #1003 did it. Re-doing a visual pass nobody asked twice for is scope the
  issue's own history has already closed.

## Test plan

Extends `test/launch-mode-picker.test.js`. The existing suite lifts `openLaunchModeModal` alone;
these drive the **real entry point** `proceedWithLaunchModeCheck` with a real bundled engine profile,
in the style of `test/create-flow-mode-picker.test.js` — a fixture that skips the caller is how a
failing criterion turns into a passing one.

1. A project storing `plan` opens the picker with `plan` checked (not `default`).
2. Accepting that preselection reaches `doLaunchProject` with `plan` — the end-to-end the bug breaks.
3. A stored key the engine does not define falls back to the engine default.
4. A stored key the engine defines as `disabled` falls back to the engine default.
5. A project with no stored default still gets the engine default.
6. The rendered option set excludes `disabled` modes.

**One existing assertion changes.** `test/launch-mode-picker.test.js:47` currently pins the engine
default as the correct preselection. That is the behavior this chunk removes, so the assertion is
rewritten with the reason in its prose — the requirement changed, the test is not being weakened.

Every new test gets a named mutation, verified red.

## Status

- [x] Chunk B1 · preselect from the project's `defaultLaunchMode`
- [x] Chunk B2 · one honored-mode predicate, all four browser sites
- [x] Tests written — every new test has a named mutation, each verified red (table below)
- [x] Suite green, evidence recorded from JUnit (`prawduct-hook test-status`)
- [x] CHANGELOG entry
- [x] Cumulative Critic + verify-resolutions: 0 blocking / 0 warning / 0 note; 9 fixed, R-1 waived (see below)
- [ ] PR

## Mutation evidence

Each mutation was applied to the named source file, the picker suite run, then the file restored
and checksummed against its pre-mutation copy.

| # | Mutation | Goes red |
|---|---|---|
| M1 | `selectedLaunchMode = engine.defaultLaunchMode` (the old seed) | the three project-default tests |
| M2 | `if (stored) return stored` — trust the stored key unchecked | both fallback tests |
| M3 | render `Object.entries(engine.launchModes)` again | omits-a-disabled-mode |
| M4 | gate counts `Object.keys(...)` instead of honored modes | does-not-open-for-one-honored-mode |
| M5 | `return engineDefault` without checking it is honored | falls-past-the-engine-default |
| M6 | drop the `if (!modes) return []` guard | launches-directly-when-engine-unknown |
| M7 | `tcHonoredLaunchModes` drifts to `!mode.disabled` (`api-helper.js`) | the browser/server parity test |

**M4 was GREEN on its first run, and that was the finding.** The fixture built its engine as
`Object.assign({ id: 'solo' }, readEngine('claude'))` — the profile JSON carries its own `id`, so
`'claude'` overwrote `'solo'` and `state.engines.find` matched nothing. The gate fell through to a
direct launch and the assertion passed for the exact opposite of the reason it named. Fixed by
applying `id` last, and by an `engineWithDisabled` helper so no test hand-rolls that assign again.
The recurrence guard is inside the helper: it asserts each named mode actually exists on the
profile, so a fixture naming a mode the engine does not declare fails loudly instead of quietly
testing nothing.

## Found but not fixed here

`public/history-drawer.js` is precached in `STATIC_ASSETS` and absent from `NETWORK_FIRST_PATHS`.
Its `sw.js` comment says so deliberately and names the mechanism that surfaces it: a `CACHE_NAME`
bump. Project learnings since forbid that bump (#931 — it tears down the worker in every browser
and locked the operator out behind basic_auth). So changes to that file — it last changed in #83 —
reach an operator with an active service worker through a mechanism the project no longer uses.
Out of scope for #596; no open issue covers it (#625 is adjacent, about the bump guard itself).

## Critic round (rev-20260904T190617Z-d226cc80)

1 blocking, 4 warnings, 11 notes. All dispositioned in one pass.

| Finding | Disposition |
|---|---|
| R-1 blocking — chunk B's deliverable check never ran | Fixed: `active_build_plan` repointed at this plan |
| R-2 / R-10 — the predicate sweep stopped at `landing.js` | Fixed: helper moved to `api-helper.js`, all four sites routed through it |
| R-5 — `FEATURES.md` still calls the server predicate the single definition | Fixed, both lines, plus the reciprocal clause in `lib/engines.js` |
| R-6 / R-12 — nothing pinned the two predicates to each other | Fixed: parity test over every bundled profile |
| R-7 — new comments narrate the defect's and the review's history | Fixed: rewritten as present-tense invariants |
| R-8 — `engines.test.js` cites a line and a gate this commit replaced | Fixed: asserts the honored count, not the key count |
| R-3 / R-11 — two of the silent-fallback decision's three legs do not hold | Fixed: both recorded as rejected, residual named |
| R-15 — open #1037 sits in this area | Accepted: this bundle both extends the source-probe pattern and applies the mitigation #1037's own body says does not resolve it, so no status change is warranted |
| R-4 / R-9 / R-16 / R-13 / R-14 | Accepted: each states "no action" — priors read and not re-raised, learnings cross-check, backlog reconciliation clean |

**M7 — a seventh mutation, added because of R-6, was GREEN on first run.** Drifting the browser
predicate to `!disabled` left the new parity test passing, because every fixture used `disabled:
true`, where the two spellings agree. The test could not see the drift it existed to prevent. Fixed
by adding truthy non-`true` fixtures (`'yes'`, `1`); M7 then reds. Second instance this chunk of a
fixture that could not reach its subject.

## Why R-1 was waived rather than fixed, and what it means beyond this chunk

R-1's named cause was fixed — `active_build_plan` points at this plan. The check still did not run.
`buildplan_refs._CHUNK_HEADING_RE` requires the literal word **`Chunk`** before the id, and this
plan was authored with `## B1 ·` / `## B2 ·`. **No `--chunk` value graded it.** The headings and
Status items above are now in the `Chunk B1` form so the check can grade.

Two things worth carrying past this chunk:

- **`train-12.5-chunk-a.md` uses the same `### A1 ·` style, so chunk A's deliverable check never
  ran either.** Nobody noticed, because the failure is silent unless a review is dispatched with an
  explicit `--chunk`.
- **Omitting `--chunk` produces no `unchecked` line at all** — a silent no-op rather than a warning.
  A plan whose headings do not match is indistinguishable from one that graded clean.
