# ADR 0012: A norm's enforcement mechanism adds no installation step

**Status:** Accepted (2026-08-01).
**Source:** The norm-registry ratification of 2026-08-01 (`/prawduct:doctor` Norm Ratification Flow).
**Decides:** How any norm in TangleClaw's registry may be mechanically enforced.
**Governs:** Every future proposal to add a linter, formatter, type checker, or any other checking
tool to this repository.
**Related:** ADR 0009 (secure by default) established the pattern this ADR follows — the decision
lives in git; the `.prawduct/` artifact points at it.

---

## Context

TangleClaw ratified its norm registry on 2026-08-01. A registry needs an answer to "what checks
each norm," and the answer is constrained by an unusual property of this repository: **the clone is
the live install.** `com.tangleclaw.server` runs `node server.js` out of the working tree. There is
no build step, no packaging, and therefore no boundary that makes a "development-only" tool less
present than a runtime one.

The registry's first draft answered this with a ruling attached to the dependency norm:
*enforcement mechanisms may not be bought with a dependency*, justified by the claim that
TangleClaw has "zero dependencies — runtime and tooling alike" and "runs on the Node.js standard
library and nothing else."

**That justification was false, and the correction is why this ADR exists rather than a one-line
note in an artifact.** `.prawduct/artifacts/dependency-manifest.md` inventories eleven external
dependencies: Node.js 22+, tmux, ttyd, Caddy, git, `gh`, launchd, mkcert, PortHub, the Medusa
Bridge, and a remote Docker host for the acceptance gate. Caddy is recorded there as "effectively
yes on a fresh install." Orchestrating third-party binaries is what this product *does*.

The precise, long-standing claim in the source artifacts is narrower and true: **zero *npm*
dependencies.** The widened form was introduced while drafting the registry and was ratified in
that form. Correcting the statement invalidated the ruling's justification — so the ruling was
re-derived from a principle that survives the correction, rather than renamed.

The engineering question underneath is not "npm or brew." It is: **what distinguishes the eleven
dependencies TangleClaw legitimately has from a checker it should not acquire?**

## Decision

**A norm's enforcement mechanism must add no installation step. It runs inside the existing
`node --test` invocation — a source-scanning test in the style of `test/master.test.js:270` (read
the file as text, assert over its contents) — or the norm is janitor-homed and walked by the
periodic Norm Health sweep.**

The distinguishing principle: **every dependency TangleClaw has is product function.** The operator
installs tmux because sessions cannot run without it, Caddy because TLS cannot terminate without
it, `gh` because the wrap cannot report PR status without it. Each earns its install by delivering
something the user asked for.

**A governance check is not product function.** It delivers nothing the operator asked for. Making
someone install a tool so the repository can check itself moves cost onto every install — including
the non-expert field install this project actually has — in exchange for zero user-facing value.

There is a second, sharper reason. **A checker that is absent does not fail cleanly.** It either
breaks the run for a reason unrelated to the code under test, or — the common and worse case — it
detects its own absence and skips, and the suite reports green. A check that silently stops
checking is worse than no check, because it also carries the belief that checking is happening.
That failure mode is not hypothetical here: it is the substance of #835, where a drift guard takes
`t.skip` on every CI runner because the thing it reads is not present there.

## Consequences

**Standing constraints this creates:**

- No linter, formatter, or type checker is added to this repository — npm-installed or
  brew-installed alike. The answer does not depend on the packaging system.
- A norm with no in-suite hook is **janitor-homed**, not mechanized. That is a recorded, honest
  state, not a gap awaiting tooling. Accessibility contrast and screen-reader behavior are homed
  this way for exactly this reason.
- A future check that wants `jq`, a Python package, or a Docker image is answered by this ADR
  without a new ruling. It is either reframed as a source scan, or its norm is janitor-homed.
- Reversing this requires superseding this ADR, not amending an artifact.

**What it does not constrain.** This ADR governs *enforcement mechanisms*. It says nothing about
dependencies acquired for product function; adding a twelfth to `dependency-manifest.md` is an
ordinary engineering decision on its own merits.

**Work it creates and forecloses.** Backlog item `NRM-5K8T` builds the source-scanning checks the
registry's Enforcement table marks "to build." `TL-3D5K` — filed 2026-07-09 as "configure a
zero-dep-friendly linter/formatter" — has its means foreclosed by this ADR and was retitled and
narrowed to the formatting/style residue, which now has no mechanism and is honestly recorded as
convention plus review.

## Alternatives considered

**"Enforcement may not be bought with an npm package"** — the formulation this replaces. Rejected
because the line is arbitrary: it forbids `eslint` from npm while permitting an identical binary
from Homebrew, and TangleClaw already depends on five brew-installed tools, so nothing in the
product's history explains why one packaging system is the boundary. It also happens to reach the
right answer for linters today only because every mainstream JavaScript linter ships on npm — a
coincidence of ecosystem, not a principle.

**"Zero dependencies, absolutely"** — the original framing. Rejected as false. The dependency
manifest refutes it, and a norm that its own artifacts contradict cannot bind anything.

**Permit development-only tooling with a documented install step.** Rejected on two grounds. The
repository is the live install, so "development-only" describes no real boundary here — the tool
would sit in the same tree the server runs from. And the install cost lands on the field installer,
a non-expert third party, who gains nothing from it.

**Run checkers in CI only, where an install burdens nobody.** This is the strongest alternative and
it was not dismissed lightly: `.github/workflows/test.yml` already runs the suite on
`ubuntu-latest`, and CI could install anything without touching an operator's machine. Rejected for
three reasons. First, it splits enforcement — a check that exists only in CI does not run for the
operator editing code locally, which is precisely when the feedback is worth having, and this
project is developed by one person working directly on the box. Second, it would require a
`package.json` in a repository whose ratified norm is that there is none, so the norm would be
enforced by a mechanism that violates it. Third, CI-only checks have their own silent-skip failure
mode, which is the same defect this decision is trying to avoid — see #835, where a guard that
"runs in CI" turned out never to execute there at all.

---

## Amendment 2026-09-07 — a relational property may be enforced from CI (#625)

**What changed.** The Decision above names two homes for a norm's enforcement: inside the existing
`node --test` invocation, or janitor-homed. `scripts/cache-bump-guard.js` is a third — a step of
the `test` job that runs only on `pull_request`. That is the "Run checkers in CI only" alternative
this ADR rejects by name, so it is recorded here rather than left to read as conformance.

**Why the two existing homes cannot hold it.** The property is *"if a cache-first `public/*` asset
changed in this diff, `CACHE_NAME` must have changed too."* It is relational: it is about a change,
not about a tree. A source-scanning test reads one working tree and has no access to "changed
relative to what," which is why the nine unit assertions written for it over four recurrences were
all monotone floors that could never fail for the next miss. Janitor-homing it means a periodic
sweep noticing a stale cache weeks after the operator stopped seeing their own fix.

**The three rejection reasons, answered for this class:**

1. *"It splits enforcement — a CI-only check does not run for the operator editing locally."*
   Partly stands, and is mitigated rather than dismissed. The check runs locally in one command
   with no install — `node scripts/cache-bump-guard.js --base main`, documented in
   `CONTRIBUTING.md`. What is genuinely CI-only is the *trigger*, not the availability, and the
   trigger is where the diff lives.
2. *"It would require a `package.json` in a repository whose ratified norm is that there is none."*
   Does not apply. The check is git plus two `node:` stdlib requires; no package, no lockfile, no
   install step. The install-step half of this ADR is honoured exactly.
3. *"CI-only checks have their own silent-skip failure mode (#835)."* The sharpest reason, and the
   one this design had to answer structurally rather than promise around. Three answers: an empty
   `--base` is an **error**, never a skip, so a workflow expression that resolved to nothing fails
   loudly instead of reporting a clean pass; the only skip path requires the flag to be absent
   entirely and prints why; and `test/ci-workflow.test.js` pins that the workflow invokes the script
   with a base and full history, so a workflow edit that disarmed it goes red in the suite. The
   guard also lives in the **`test` job** rather than its own, because a job name is what branch
   protection requires and `main` requires only `test` — a separate job would have been a check that
   reports a miss `gh pr merge --auto` merges straight past, which is #835's failure wearing a
   different hat.

**Scope.** This amendment licenses CI-homed enforcement for **relational properties that no reading
of a single tree can decide**, subject to all three answers above holding. It does not reopen
CI-installed tooling: a check that wants a package is still answered by the Decision, unchanged.
A future proposal that is *not* relational belongs in `node --test` or is janitor-homed.

---

## Provenance note

This ADR records a decision made and corrected on the same day. The ruling was first stated on a
false premise, the premise was caught by the product owner reading his own dependency manifest, and
the ruling was re-derived rather than renamed. The corrected wording is preserved in
`.prawduct/artifacts/project-preferences.md` § Direction with a dated correction note.

The reason that history is written down rather than tidied away: the original claim was *stronger*
than the truth and it flattered the thing it described, which is the direction governance records
drift and the direction they are least audited in. A reader who knows this ADR was born from a
correction is better equipped to challenge the next confident-sounding constraint than one who
reads only the clean result.
