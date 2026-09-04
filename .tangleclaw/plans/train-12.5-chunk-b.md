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

## B1 · `defaultLaunchMode` is dead whenever the picker is visible

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

## B2 · The picker offers modes its own gate excluded

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

**Done when**
- The picker renders only modes the engine will honor, matching the gate that decided to open it.
- The preselect fallback in B1 uses the same predicate, not a second spelling of it.

## Scope decisions, recorded rather than silently taken

- **A stranded stored mode falls back silently in the picker.** When the project's stored key is not
  honored, B1 preselects the engine default without saying "your saved mode is unavailable here".
  That surface already exists elsewhere and this is not its place: `updateProject` **resets** a stored
  mode on engine switch (`test/launch-mode-settings.test.js` → "engine-switch reconciliation"), the
  settings modal renders the stranded state explicitly (the #756 pattern in `public/api-helper.js:1886`),
  and `lib/sessions.js:355` logs it at launch. Stranding is prevented at the source and reported where
  the setting lives; adding a fourth telling to a per-launch chooser is not the smallest thing that
  solves this.
- **The frontend cannot `require` `honorsLaunchMode`.** `public/` runs in a browser and `lib/engines.js`
  is CommonJS on the server; there is no build step (project Direction: no bundler, no transpiler). B2
  therefore adds ONE frontend predicate in `public/landing.js` and routes both sites through it, rather
  than leaving the two inline spellings or inventing a third. The server keeps its own definition;
  that duplication is a boundary, not a restatement.
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

- [ ] B1 · preselect from the project's `defaultLaunchMode`
- [ ] B2 · one honored-mode predicate, both sites
- [ ] Tests written, each mutation verified red
- [ ] Suite green, evidence recorded
- [ ] CHANGELOG entry
- [ ] Cumulative Critic, findings dispositioned
- [ ] PR
