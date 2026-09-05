---
name: train-12.5-chunk-d
branch: fix/1252-1254-audit-defects
governed_by:
  - .prawduct/artifacts/architecture.md
  - .prawduct/artifacts/prime-delivery-direction.md
  - .prawduct/artifacts/nonfunctional-requirements.md
  - .prawduct/artifacts/project-preferences.md
---

# Train 12.5 — Chunk D: the audit defects ADR 0013 made defects

**Cars:** #1251, #1252, #1253, #1254, #1255 · **Base:** `405e23f` · **Critic mode:** cumulative

The five instances the C1 audit found and filed. ADR 0013's retroactivity is **migrate**, so each is
a defect from ratification rather than a grandfathered exception. C2a exists to make them cheap:
the intended shape of most of this work is a row in `ENGINE_CONDITIONAL_SETTINGS`, its mirror in
`tcSettingDisposition`, and a rendered reason — the parity test then holds the two to one sentence.

## Why this is two chunks, not one

They were filed together because one audit found them, not because they are one size.

- **#1252, #1253, #1254 are small and share a mechanism.** Each is a disposition row, a filter fix,
  or a data distinction. One PR.
- **#1251 needs a surface that does not exist.** `rules.core` / `rules.extensions` have **no UI at
  all** — the settings modal's "Project Rules" section is a different feature (free-text
  `session_rules` DB rows), which the C1 design flags as a taxonomy trap. So "say it where it is
  offered" has to decide *where* this setting is even offered.
- **#1255 is a data migration into a format with no comments.** The issue is explicit that the
  per-field provenance ("measured from a live pane" vs "inherited") must survive the move, and JSON
  cannot carry it as a comment. That is a schema decision, not a copy-paste.

D1 is this plan. D2 is #1251 + #1255 and gets its own.

## Two rulings taken without an operator round-trip, and why

Both issues asked for a *decision*; both had a cheaper answer than the one they proposed, and
neither needed a judgement only the operator can make.

**#1253 — repair, not remove.** The issue floats removal ("no UI, no documentation, works on two
engines by direct read"). Checked first: **no project on this install sets a non-default
`loggingLevel`**, so removal was available. It is still the worse option — `_getRulesContent`
filters `v === true`, so *no* string-valued rule can ever render, and teaching it to render
non-booleans is smaller than removal, makes the setting work on all five generators, and keeps the
two that already read it directly. Removal would also change the generated config of every codex
and aider project to buy nothing.

**#1254 — distinguish, not delete.** Confirmed by grep: `supportsSlashCommands`,
`supportsCoAuthor`, `supportsRemote`, `supportsModes` have **zero** readers in `lib/`, `server.js`
and `public/`; `coAuthorFormat` has zero readers anywhere including tests. Deleting declared data a
future feature may want is churn, and the issue's actual requirement is narrower: *"a capability
panel has to render **read** capabilities, not **declared** ones, and that distinction does not
exist in the data today."* Making the distinction exist and guarding it satisfies that without
throwing anything away. `capabilities.awareness` (openclaw only) is a deliberate keep whose own
`reason` text records a gap — the distinction is exactly what stops it reading as accidental.

Neither ruling deletes anything, which is why neither was escalated: the reversible option was also
the better one.

## Requirements Confidence

**High.** Each of the three is a filed issue with a reproducible statement, and the two that asked
for a *decision* were resolved against evidence rather than judgement — the `loggingLevel` census
across this install, and a grep establishing the four unread capability flags (both recorded above).
The one thing D1 invents rather than reads is the caveat's wording, and it is checked mechanically
against the predicate the prime pointer is actually gated on rather than asserted.

The open assumption, recorded because it is the one a reader could not derive: **rendering the
caveat regardless of the toggle's own value is a choice.** It reads as a property of the setting on
this engine, not of what the project currently stores, so an operator deciding whether to turn the
toggle on sees it first. Phrasing it the other way — describing only the stored state — would go
silent for exactly the person best placed to act on it. Resolvable by the operator disagreeing at
verification; nothing else hinges on it.

## Chunk D1 — three defects that ride the mechanism

**Visual change:** yes — #1252 changes two settings toggles.

### D1a — `featureIndexEnabled` / `projectMapEnabled` say when only half of them applies (#1252)

Both toggles have two halves and only one is engine-agnostic. The wrap side seeds and maintains
`FEATURES.md` / `PROJECT-MAP.md` on every engine; the SessionStart pointer that tells the agent the
file exists is gated on `capabilities.supportsSilentPrime === true`, which only Claude declares. So
on four of five engines the toggle builds a file no session is ever told to read, and
`lib/project-config.js` states the toggle is *"engine-agnostic so the toggle is not engine-gated"* —
true of the wrap half, false of the prime half.

**This is the case the C2a mechanism does not yet express.** `applies` is a boolean; this setting
genuinely *does* something everywhere and *fails to do part of it* on four engines. Reporting it as
not-applying would be false, and reporting it as applying would be the silence the norm forbids.

**Done when**
- The disposition carries a **caveat** — a setting that takes effect partially says which part does
  not, distinct from a setting that does not apply at all. The three-state answer is the
  mechanism's, not each caller's.
- Both toggles render that caveat in the settings modal on an engine that cannot announce the file,
  and on Claude with `silentPrime` off (the gate is a triple; the operator who turns silent prime
  off loses the pointer too, which is defensible and currently undocumented).
- The caveat text is cross-realm parity-checked like every other reason.
- `lib/project-config.js`'s "engine-agnostic so the toggle is not engine-gated" comment stops being
  half-false.

### D1b — a string-valued rule can render (#1253)

`_getRulesContent` collects extension rules with `filter(([, v]) => v === true)`, so
`loggingLevel` — the only non-boolean under `rules.extensions`, default `'info'` — can never reach
the prose path. `_generateCodexYaml` and `_generateAiderConf` read it directly and work;
`_generateClaudeMd`, `_generateGeminiMd` and `_generateAntigravityMd` never mention it.

**Done when**
- A non-boolean extension rule renders as prose naming its value, so the setting is real on all
  five generators rather than two.
- `false` and absent stay unrendered — the filter's actual job is unchanged.
- A test pins that the boolean rules render exactly as they did, because this widens a filter every
  generated config file depends on.

### D1c — read capabilities are distinguishable from declared ones (#1254)

**Done when**
- `lib/engines.js` exports the capability keys application code actually reads, and a guard asserts
  each one has a reader outside `test/` — so a key added to the list without wiring fails, and a
  reader deleted without removing the key fails.
- A declared-but-unread key is identifiable as such by any future capability panel (#764's), rather
  than rendering as a promise the product does not keep — `supportsCoAuthor: true` on aider being
  the sharp example.
- Nothing is deleted from `data/engines/*.json`.

### Not in D1, deliberately

- **#1251** (OpenClaw rules block) and **#1255** (wake data into profiles) — chunk D2.
- Wiring any of the four unread capabilities to real behavior. Deciding *that* is a feature
  question per key; D1c only makes the distinction legible so the decision is possible.

### Standing constraints

- Branch in a worktree; the primary checkout stays on `main` (it is the live install).
- Every new test gets a named mutation verified red. A green mutation is the finding.
- Squash merge, branch single-use (`project-preferences.md` § Workflow).
- `Fixes #1252`, `Fixes #1253`, `Fixes #1254` on the PR. #1251 and #1255 stay OPEN and the PR says
  they are D2.
- Append to `.prawduct/operator-verification.md` — #1252 changes two operator-visible toggles.

## Status

- [x] D1a — the partial-application caveat, and both toggles rendering it (#1252)
- [x] D1b — non-boolean extension rules render (#1253)
- [x] D1c — read vs declared capabilities, guarded (#1254)
- [x] D1 — tests written, every new test mutation-verified red
- [x] D1 — suite green, evidence recorded
- [x] D1 — CHANGELOG entry
- [x] D1 — cumulative Critic + verify-resolutions, final round clean
- [ ] D1 — PR with `Fixes` for each car it closes
