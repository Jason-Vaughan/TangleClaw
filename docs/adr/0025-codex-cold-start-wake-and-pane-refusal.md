# ADR 0025: Codex cold-start wake and pane refusal

**Status:** Accepted (2026-10-07, Architect ruling A123). Recorded in this repository on 2026-10-17.
A123 is a historical decision record with continuing boundaries: the later rulings A175 and A168
govern their named amendments (see "Later amendments").
**Source:** Architect ruling A123, issued 2026-10-07 on the Codex cold-start probe for
[#2059](https://github.com/Jason-Vaughan/TangleClaw/issues/2059).
**Decision owner:** TangleClaw Architect.
**Implementation owners:** ProjectManager for scope and dispatch, Builder lanes for code, Integrator
for gated merge.

---

## Provenance

The complete ruling was first appended as "Design as ruled (Architect A123, 2026-10-07)" to
Pilot-B4's cold-start probe and readiness design, `.tangleclaw/plans/2059-cold-start-probe-and-readiness-design.md`
in that project. That file is local and gitignored. Its findings remain the measurement record, and
it is named here as supporting evidence, not as a substitute for this record.

The Architect later recorded the ruling as its durable decision page,
`.tangleclaw/plans/a123-codex-cold-start-wake-ruling.md` in the Architect project (recorded
2026-10-13). This ADR is taken from that page and from this repository's code, and from nothing
else. [#2059](https://github.com/Jason-Vaughan/TangleClaw/issues/2059) tracks the wake work, with
[#2187](https://github.com/Jason-Vaughan/TangleClaw/issues/2187),
[#2186](https://github.com/Jason-Vaughan/TangleClaw/issues/2186) and
[#2177](https://github.com/Jason-Vaughan/TangleClaw/issues/2177) covering adjacent acceptance and
containment.

## Context

The A123 decisions shape the wake, launch and engine-profile code, but until now the ruling itself
existed only outside this repository: in an Architect page and in a gitignored
probe file. A reader of the code could see each decision's effect without finding the decision, its
order, or the limits it set. This ADR puts the record in `docs/adr/`, as the 2026-10-14 owner
comment on #2059 asked. It changes no behavior, and the remaining wake work stays open on #2059.

## Decision

**D1 — Readiness boundary.** The launch's own bound Codex thread must be loaded for its project
folder and report idle through `observeActivity`; that native channel remains the wake authority.
The fake-key cold-start probe is provisional evidence only. It does not add any Codex version to
`verifiedVersions` or justify "verified" wording. A version needs a signed-in cold launch, resume,
and observation across the screens drawn after models load before admission.

**D2 — Settling hold.** After the bound thread first reports idle, hold wake nudges for one full
monitor interval in code, under a named reason (working name `engine-thread-settling`) with delivery
disposition and operator-facing meaning. The pane debounce constant alone may not close the measured
overlap. Tests must prove the recorded F4 startup samples stay held, a thread idle beyond the
interval proceeds, relaunch starts a fresh hold, and changing `IDLE_TICKS_REQUIRED` cannot remove
this hold.

**D3 — Dialog below composer.** In `_assessPane`, a bare prompt row cannot count as an available
composer if a later row starts with the engine's prompt glyph. Whole-pane captures, including dialog
selector rows below an older composer, are the relevant evidence; cropped dialog fixtures are
insufficient.

**D4 — Opening screen.** The wake profile may declare an engine-starting marker; when the newest
matching header row carries it, refuse the pane as `pane-engine-starting`. The Codex probe used a
newest `model:` header reading `loading`. The implementation later chose the regex field name
`startingPattern` rather than the ruling's working name `startingMarker`; that naming change is
documented in A175 and does not widen which versions are admitted.

**D3/D4 merge gate.** Before either refusal merges, recapture trust and update dialog fixtures
**whole** for each supported version and check the built predicates against an ordinary usable
screen and a real turn on every supported engine. The Codex real-turn check requires a signed-in
tier. Preserve normal composers and own-nudge behavior; a false refusal must be corrected before
merge.

**D5 — Folder trust under `--remote`.** Correct `data/engines/codex.json` readiness evidence and the
`trust_required` reason text to the measured setup, clearly limiting the fake-key result. Do not
change wake trust policy without signed-in evidence.

**#2177 containment.** Stop blind `Enter` pre-keys. An unrecognized startup screen receives no typed
key. Report a folder-trust prompt for human action; do not accept folder trust on the Operator's
behalf without an explicit Operator policy decision. A later screen-matched dismissal of an update
prompt may use Escape, never Enter, only after positive matching tests. The legacy trust behavior
change must be visible to the Operator and recorded in CHANGELOG.

### Original order and reserved decisions

The order A123 set: the #2177 containment first; then D3/D4, behind the whole-capture and
usable-screen gate; then D1/D2 and per-version proof. No fleet launch or wake experiment may rest on
fake-key evidence alone. Product code waited for PM dispatch.

Two decisions were reserved to the Operator:

1. whether TangleClaw may accept folder trust on their behalf;
2. whether to provide the separate signed-in probe tier.

## Later amendments

Later rulings take precedence over A123 on their exact points. Each is stated here as the A123 page
states it, and is not expanded. Neither relaxes the separate launch/readiness proof.

- **A175** (Codex launch rulings, `.tangleclaw/plans/a175-codex-launch-rulings.md` in the Architect
  project) approved one narrow order exception: D2's first-idle hold could build and merge before
  D3/D4 because it changed wake settling only. It did not admit newer Codex versions, weaken the
  pane gate, or prove automatic launch readiness. A175 also placed D3/D4 checks after native
  activity and before a cursor result can return `at-prompt`, clarified the last bare prompt as
  anchor, and retained D5's explicitly untrusted signed-in probe gate. This does not relax the separate launch/readiness
  proof.
- **A168** (Codex admission and wake release dependency,
  `.tangleclaw/plans/a168-codex-admission-and-wake-release-dependency.md` in the Architect project)
  requires separate isolation and wake evidence for each newer version. This does not relax the
  separate launch/readiness proof.

## What A123 does not permit

A123 is not permission to accept an unverified engine, to auto-answer a trust prompt, or to fire an
automatic launch before its separate pane gate passes.

## Where it stands in code

File-level pointers, read on `main` when this record was written. They locate each decision; they
are not a specification of it.

- **D1:** the native activity channel is `observeActivity` in `lib/startup-control.js` (Codex's in
  `lib/startup-control-codex.js`), read by `lib/medusa-wake.js`. Admitted versions are `verifiedVersions` in `data/engines/codex.json`.
- **D2:** the `engine-thread-settling` reason in `lib/medusa-wake.js`, with its delivery disposition
  in `lib/medusa-delivery-disposition.js`.
- **D3:** `_glyphRowBelowPrompt`, called from `_assessPane`, in `lib/medusa-wake.js`.
- **D4:** `startingPattern` in `data/engines/codex.json` and `lib/medusa-wake.js`, refusing as
  `pane-engine-starting`.
- **D5:** the readiness evidence and `trust_required` reason text in `data/engines/codex.json`.
- **#2177:** `launch.guardedDialogs`, read by `lib/launch-dialog-guard.js` and documented in
  `docs/engine-guide.md`'s `launch.guardedDialogs` section.
