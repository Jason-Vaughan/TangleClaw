# ADR 0011: The Prawduct boundary — TangleClaw owns the plumbing, consumes the governance

**Status:** Accepted (2026-07-29).
**Source issue:** #330 — "Decouple Prawduct from TangleClaw: direct-integration drift risk as Prawduct moves to a Claude-embedded V2 skill." Filed explicitly *to capture the decision*.
**Builds on:** #353 (governance moved to the V2 plugin; `governanceState` derived live), #262 (the migration action), #538/#570 (methodology layer removed, `critic-check` deleted), #763 (auto-onboarding declined as out-of-boundary).
**Decides:** #330. Governs #368 and any future proposal that moves work across this seam.

---

## Context

#330 was filed when Prawduct was a file/template/hook framework wired straight into TangleClaw's
internals, and its author was reshaping it into something embedded in Claude Code. The issue named
two compounding risks — direct-integration drift, and a Claude-embedded Prawduct deepening
Claude lock-in for the methodology layer — and listed four options without choosing one.

**Its three "asks before deciding" have since been answered by events, not by discussion.**

*Ask: get clarity on Prawduct V2's actual shape and timeline.* Answered. Prawduct ships as a Claude
Code plugin — `prawduct@prawduct` v3.1.2, installed at user scope from its own marketplace
(`github.com/brookstalley/prawduct`). Its own description states the shape: "ships immutable
read-only code; all mutable state lives in each repo's `.prawduct/`." The file-framework did not
coexist; it was replaced.

*Ask: decide what TangleClaw owns vs consumes.* Answered by what got built. TangleClaw migrated its
own governance onto the plugin — its `.claude/settings.json` carries
`enabledPlugins: {"prawduct@prawduct": true}` — and then removed the methodology layer that used to
carry Prawduct's concepts: the bundled template's `wrap_pipeline` block gave way to a code-owned
`lib/wrap-default-pipeline.js` (#538), and `critic-check` was deleted from the wrap pipeline outright
once governance moved plugin-side (#570).

*Ask: map the exact coupling points.* Done below.

**The decision therefore already exists — as behavior, and as one inline code comment.**
`lib/engines.js` reads "Defer to the Prawduct V2 Claude Code plugin when it governs this project
(#330 hybrid)" — grep the comment rather than a line number, which moves. That comment is currently
the most authoritative written record of the position, and it is a parenthetical inside a function
about writing engine config files. The rest lives in per-machine session memory, which does not
survive a fresh clone and is not reviewable.

That is the actual problem this ADR fixes. #330 was filed to preserve a rationale; closing it while
the rationale exists only as a code aside and a memory file would throw away the one thing it was
for.

### The coupling points, mapped

TangleClaw references Prawduct in 19 files under `lib/` (`git grep -il prawduct -- 'lib/**'`; 23 if
`server.js` and `public/` are included). They fall into three groups, and the groups are the
decision:

**1. Governance detection and migration — the real interface, and it is narrow.**
`lib/engines.js` holds it: `isPluginGoverned` (1318) keys off a `prawduct@*` entry in the project's
`.claude/settings.json`; `governanceState` (1355) classifies a project as `governed-plugin` /
`governed-vendored` / `ungoverned` / `not-applicable`; `migrateToPlugin` (1452) writes the plugin
reference, sourced from TangleClaw's *own* pin (`_readSelfPluginRef`) so a migration never hardcodes
a version. `writeEngineConfig` (1138) defers entirely when a project is plugin-governed, because the
plugin owns `CLAUDE.md` as a thin `PRAWDUCT:ANCHOR` file and regenerating would clobber it every
launch.

The total surface TangleClaw depends on here is: **one settings key prefix, one anchor file it must
not overwrite, and one directory (`.prawduct/`) it must not treat as source.** That is a remarkably
small contract for what #330 feared.

**2. Agent invocation — Claude-only, and explicitly so.**
`lib/actions/invoke-critic.js` sends `/critic` to the live session over tmux, polls for idle, and
reads structured findings from `<project>/.prawduct/.critic-findings.json`. It refuses outright when
`engine !== 'claude'` (line 208), with the reasoning in its own header: only the literal Claude Code
engine has the skill this invokes.

**3. Incidental references.** Path-exclusion rules (`lib/wrap-steps/_source-paths.js` excludes any
leading-dot segment, so `.prawduct/` is filtered without being enumerated), comments, and UI strings.
These are not coupling; they are a framework being mentioned.

---

## Decision

**TangleClaw owns the plumbing and consumes the governance. The plumbing is engine-agnostic; agent
invocation is Claude-only by design, not by accident.**

This is option 3 of #330 — "treat the V2 skill as just another engine capability" — ratified as the
position that was in fact built.

1. **TangleClaw owns:** project registry and lifecycle, engine profiles and config generation, the
   wrap pipeline (code-owned, `lib/wrap-default-pipeline.js`), ports, sessions, shared docs, groups,
   memory, releases, and updates. None of these require Prawduct to exist. A TangleClaw install with
   no Prawduct plugin is a complete product, not a degraded one.

2. **TangleClaw consumes, never reimplements:** methodology and governance — discovery, build
   governance, the Critic, learnings. TangleClaw does not carry its own copy of these concepts. The
   methodology layer that used to (#538, #570) is gone and does not come back.

3. **The seam is exactly three things,** and anything crossing it is a decision, not an
   implementation detail:
   - the `prawduct@*` key in a project's `.claude/settings.json` (governance detection),
   - `CLAUDE.md` as a plugin-owned anchor TangleClaw must not regenerate when plugin-governed,
   - `.prawduct/` as plugin-owned state TangleClaw reads at agreed paths and never authors.

4. **Governance state is derived live, never persisted.** `governanceState` inspects the filesystem on
   every read, so it self-clears the moment a project migrates. A persisted mirror of an external
   framework's state is precisely the drift #330 warned about. (This is why #354's stored
   `migrationStatus` was superseded rather than completed — see #776.)

5. **A Claude-only agent layer is accepted.** TangleClaw runs Gemini, Codex, Aider and others, and
   `invoke-critic` refuses on all of them. This is not a gap to close:
   - The capability being invoked is a *Claude Code skill*. There is no engine-agnostic way to invoke
     it, because it does not exist off Claude — a "portable Critic" would mean TangleClaw writing its
     own, which is decision 2 in reverse.
   - The refusal is explicit and total, not a silent degradation. Non-Claude engines lose the Critic
     and keep everything else.
   - `not-applicable` — not a fault state — is the honest classification for governance on a
     non-Claude engine, because the question genuinely does not apply.

   The cost is real and accepted: methodology governance is a Claude-only benefit. The alternative is
   TangleClaw owning a methodology framework, which it deliberately stopped doing.

6. **TangleClaw does not push governance onto projects.** It detects governance, reports it, and
   migrates a project **when the operator asks**. It does not onboard, activate, or enable governance
   as a side effect of an ordinary lifecycle operation. This is the rule #763 was closed on, stated
   as a principle rather than re-derived per issue.

---

## Consequences

**#330 closes, citing this ADR.** Its rationale is now in the repository, survives a fresh clone, and
is reviewable.

**#368 must be decided against decision 6, not on its own merits.** #368 proposes that
`createProject` in `lib/projects.js` (which calls `engines.writeEngineConfig`, then
`engines.syncEngineHooks`) also write the Prawduct activation reference for new Claude
projects. Under decision 6 that is governance activation happening as a side effect of project
creation, which is the seam #763 was closed on.

The counter-argument is genuine and should be recorded: the machinery already exists
(`engines.migrateToPlugin` writes exactly those keys), TangleClaw already writes them for itself, and
#368 is narrower than #763 — it writes a *reference*, not a full onboarding run, and is opt-out and
Claude-only by design. So #368 is not absurd; it is a real proposal that this boundary rules against.

Leaving both open unexamined is the outcome to avoid: #763 closed on "the fix belongs on the Prawduct
side of the seam," and #368 proposes crossing that same seam. Whichever way #368 goes, it should cite
this ADR and say so explicitly.

**The drift #330 feared did not fully materialize, for a reason worth keeping.** Prawduct's shape
changed completely — file framework to plugin — and TangleClaw absorbed it by *deleting* its own
methodology layer rather than adapting to the new shape. The insulation came from owning less, not
from abstracting more. Future upstream changes should be met the same way: shrink the seam before
widening the adapter.

**Standing constraints this creates:**
- Adding a fourth item to the seam (decision 3) requires an ADR amendment.
- No TangleClaw code may write inside `.prawduct/`.
- No lifecycle operation may enable governance without an explicit operator action.
- Reimplementing a Prawduct capability natively — a TangleClaw Critic, a TangleClaw discovery flow —
  contradicts decision 2 and requires superseding this ADR.

---

## Alternatives considered

**Option 1 — keep integrated, vendor-snapshot a frozen copy of Prawduct's shapes.** Rejected by
events. Vendored governance is precisely what `governed-vendored` now flags as legacy, and the
migration action exists to move projects off it. Pinning a snapshot would mean TangleClaw keeps
carrying Prawduct's concepts while guaranteeing they go stale.

**Option 2 — decouple to a TangleClaw-native methodology behind a stable TC-defined interface.**
Rejected as the most work for a benefit TangleClaw does not want. It makes TangleClaw the owner of a
methodology framework, which is a second product with its own roadmap. #538 and #570 moved
deliberately in the opposite direction.

**Option 4 — drop Prawduct coupling entirely.** Rejected. The governance is *useful*, TangleClaw's own
development depends on it, and the seam turned out to be three items — a cost far below the capability
it buys.

**A portable, engine-agnostic Critic.** Rejected as option 2 wearing a smaller hat. The Critic's value
is that it is an independent agent reviewing against project learnings; reproducing that off Claude
means building the agent layer TangleClaw declined to own.
