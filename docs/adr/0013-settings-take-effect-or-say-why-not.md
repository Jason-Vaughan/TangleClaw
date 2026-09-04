# ADR 0013: A Setting TangleClaw Offers Must Take Effect, Or Say Why It Does Not

**Status:** Accepted (2026-09-04, operator-ratified during the Train 12.5 settings-cleanup design pass, #764)
**Source issue:** #764 (the scoping issue whose discovery produced the rule)
**Related issues:** #741, #758, #1227, #1236 (the four filings of the one bug), #1251, #1252, #1253, #1254, #1255 (instances found by the C1 audit)
**Related ADRs:** ADR 0001 — Symmetric Capability Gates (adjacent and distinct; see "Why this is not ADR 0001")
**Norm home:** `.prawduct/artifacts/architecture.md` § Direction, registered in `project-preferences.md` § Enforcement. This ADR is the tracked, clone-durable carrier of that norm — `.prawduct/artifacts/` is deliberately gitignored so ~54 internal design docs (including the security model) are not published to a public repo, which would otherwise leave a ratified norm existing only on one machine.

---

## Context

TangleClaw orchestrates many engines, and their capabilities differ. A setting that is meaningful on
Claude Code may be meaningless on Aider; one meaningful on OpenClaw may have no carrier anywhere
else. The settings surface, however, is largely uniform — so the product routinely offers the
operator a control that, for their project's engine, does nothing.

**The failure is not that the setting is unsupported. It is that nothing says so.** A control that
stores a value and produces no effect is indistinguishable from a broken product, and the operator
is almost never at the machine TangleClaw runs on — the settings surface is the only place they can
learn what their engine will not honor.

### One near-miss worth naming

`medusaWake` skips an unprofiled engine and logs it "once per session, never silent"
(`lib/medusa-wake.js`). That is genuinely better than the failures below, and it was nearly
classified compliant on that basis during the audit. **It is not compliant under this ADR**, whose
whole point is that a log line is not how a remote operator learns anything — and the settings
modal copy compounds it by claiming the feature is "Claude sessions only for now" when antigravity
has been supported since #560. Recorded here because "we already log it" is the most plausible
wrong answer to this norm.

### Incident catalog

Four issues, filed independently over two months, are one bug:

- **#741** — `silentPrime` was silently ignored on engines lacking the capability, unlike
  `defaultLaunchMode`, which warned. The operator's only route to the knowledge was noticing that
  "Codex sessions behave differently."
- **#758** — a launch-time setting changed on a project with a live session stored fine and did
  nothing, because the running session had already read its value.
- **#1227** — filed in good faith as *"the Audit button is a placeholder that was never wired up."*
  It was not. A complete, working feature — three scoring tiers, 15 API routes, a documented
  pipeline — came **within one session of being deleted**, because the panel was empty and nothing
  on screen explained why. Closed as not-planned once the premise was disproven.
- **#1236** — the real defect behind #1227: Eval Audit can only be enabled by hand-editing
  `project.json`, so the panel is empty on every install where nobody has done that.

The recurrence is the lesson, and #1227 is the sharpest form of it: **an unreachable feature is
indistinguishable from a broken one, and the product nearly paid for the confusion by deleting
working code.**

### What the audit found

Classifying every per-project and global setting against the engine roster produced a result that
reframes the problem. **"Universal but unevenly supported" is not an edge case between universal
and engine-specific — it is nearly the whole population.** Nothing in the capability matrix is a
clean universal: `supportsPrimePrompt` and `supportsConfigFile` are true for every engine except
OpenClaw; `supportsSlashCommands` is declared by all five profiles and true for two. A rule for
this class therefore carries essentially the entire settings surface.

## Decision

**Where TangleClaw presents a setting for a project, that setting either takes effect on that
project's engine, or the surface that offers it states — at the moment it is offered, in words the
operator reads — that it does not apply here and why.**

Two things that do not count as compliance:

- **Hiding the control.** An absent control answers no question; the operator who read the docs, or
  who set the value on another project, is left to infer.
- **A log line alone.** The operator is remote and does not tail the log. Logs record; they do not
  inform.

**Retroactivity: migrate.** The instances found by the audit that produced this ADR (#1251–#1255) are defects under this
ADR from ratification, not grandfathered exceptions.

### The mechanism, and the asymmetry it must preserve

`lib/engines.js` carries **two** capability predicates — `honorsLaunchMode` and
`silentPrimeDisposition` — written in the same shape but with separate implementations.
`reconcileLaunchMode` is a third *caller*, not a third instance: it delegates
(`return honorsLaunchMode(engineProfile, mode) ? mode : 'default'`). `silentPrimeDisposition`'s
docblock says "One definition on purpose, like `honorsLaunchMode` above" — a statement that each
question has one owner, not that the two deliberately avoid sharing code.

**Two is not the rework signal, and this ADR does not claim it is.** What justifies generalizing is
this norm's own migrate retroactivity: five instances (#1251–#1255) must each grow a disposition
and a rendered reason, and hand-building five more is how the shape stops being a shape. The
generalization is scheduled work, not an emergency.

The disposition is: a pure predicate over `(setting, projectConfig, engineProfile, shippedDefault)`
returning applies / does-not-apply, an operator-readable reason, **and the provenance of the stored
value** — see below for why that fourth input is not optional. Then a control rendered disabled
*with* that reason, and a log line at a level the predicate derives rather than each call site
choosing.

**The log level is a function of whether the stored value was a real choice, not of the setting's
importance.** This is deliberate, non-obvious, and the thing most likely to be "cleaned up" by a
later refactor:

- `defaultLaunchMode` **warns** when dropped — a stored non-default mode was chosen deliberately,
  so failing to honor it loses real operator intent.
- `silentPrime` records at **info** — it defaults to `true` on every engine, so a stored `true`
  cannot be distinguished from "never touched." Warning there would fire on every non-Claude launch
  about a preference nobody set, and an alarm that always fires is an alarm nobody reads.

Both are correct. Collapsing them to one level breaks one of the two.

**This is why the predicate takes the shipped default as an input.** "Was this a real choice?" is
answerable only by comparing the stored value against what the product ships — which is exactly
what `silentPrimeDisposition`'s own docblock reasons about ("indistinguishable from the shipped
default (`DEFAULT_PROJECT_CONFIG.silentPrime` is true)"). A signature that omits it cannot derive
the level, so every call site picks one by hand, and the asymmetry above survives only as long as
each author remembers it. A rule that depends on memory is the one this ADR exists to replace.

## Why this is not ADR 0001

ADR 0001 governs **internal state symmetry**: when one conceptual state is encoded in two
locations, every transition path must update both, or orphan state leaks. It is about the product
staying consistent with itself.

This ADR governs **operator-facing honesty**: when a stored value will produce no effect, the
surface that offered it must say so. It is about the product being truthful to the person using it.

A setting can satisfy ADR 0001 perfectly — written consistently to every location it belongs in —
and still violate this one, by being faithfully stored somewhere it will never be read. That is
precisely what #741 and #1251 are.

## Why this is not the honest-degradation norm

`architecture.md` § Direction already binds: *"a read that could not be established reports `null`
and names itself, never a plausible default."* That governs a read TangleClaw **stopped** — the
third state for an unknown.

This governs a read that **succeeded** and returned a real, known value the engine will not act on.
Applying the `null` rule here would be wrong: nothing is unknown, and reporting the value as absent
would be its own falsehood. The value is known; the *effect* is missing, and that is what must be
said.

## Consequences

- Every new setting whose effect is engine-conditional owes a disposition and a rendered reason
  before it ships. This is a real cost per setting, accepted because the alternative is the
  four-issue pattern above.
- The generic disposition mechanism (Train 12.5 chunk C2a) is what makes the cost small; until it
  exists, each instance is hand-built, which is how three parallel predicates accumulated.
- Where an engine genuinely has no carrier for a concern — OpenClaw has no config file at all — the
  correct outcome is still a stated reason, not a silent skip. The silence in
  `writeEngineConfig` (#1251) was locally reasonable and globally wrong.
- Engine-specific capability data belongs in the engine profile, so a disposition can be computed
  rather than hardcoded. `prime-delivery-direction.md` § Direction §1 already binds this for channel
  limits; #1255 is the same construction in `lib/medusa-wake.js` awaiting the same treatment.
- **The reason text is a second cross-realm surface and needs the parity treatment the predicates
  already have.** `public/` cannot `require()` `lib/`, so a reason rendered in the browser is a
  hand-copied restatement of the server's — the same split that `honorsLaunchMode` /
  `tcHonoredLaunchModes` solve with a test asserting the two agree over every bundled profile. A
  reason string that drifts tells the operator something the server does not believe.
- **#764's other half outlives this ADR's companion plan.** The design pass that produced this norm
  concluded that #764 describes two surfaces: per-project settings (one engine, no switcher) and a
  per-engine *global* surface for defaults and installed-extension inventory, which is also where
  #581's tunables dock. Only the first is being built. The second is recorded here, in a tracked
  file, because the plan that describes it in full is archived when its chunk ships — and an
  archived plan is not where the next reader looks.
