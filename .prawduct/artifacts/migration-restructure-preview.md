# Restructure preview — before/after, for owner review before import

Source: .prawduct/backlog.md

- plan entries applied: **41**
- titles rewritten: **27** · bodies restructured: **0** · kind: assigned/changed: **41**
- flagged non-atomic (owner manual split — NOT auto-split): **6**
- lint findings (body/label, WARN-only) on the restructured set: **201**
- **titles that FAIL issue-standard §1 (the import will refuse): 0**

## Flagged non-atomic — owner decision required

- **TL-3D5K** — SPLIT PROPOSAL (owner decision, not auto-split): (1) decide + document the formatting convention TC holds by hand; (2) build the norm-scan that detects drift from it. Part 2 overlaps NRM-5K8T -- if the owner folds it there instead, this item keeps only part 1 and stays atomic.
- **MED-8H5W** — SPLIT PROPOSAL (owner decision, not auto-split): this is the v2 EPIC, not an atomic item -- (1) auto-inject an inbound message into the session; (2) the agent-to-agent round-trip loop. MED-4T7K/MED-6P2N/MED-9X3B are already its component items, so the cheaper alternative to splitting is to keep this as the parent and link the three as children (link --edge child) rather than mint new ids.
- **SR-8V4T** — SPLIT PROPOSAL (owner decision, not auto-split): (1) the integrity bug -- approval activates whatever the DB row holds, not what the operator saw; (2) the enabling gap -- content edits via PUT /:id are ungated. Fixing (1) with a compare-and-set token arguably closes (2) as well, in which case keep it whole.
- **AUTH-4B7K** — SPLIT PROPOSAL (owner decision, not auto-split): (1) caddy mode does not surface a stored bindAllInterfaces:true; (2) switching back to direct mode then reopens a wide bind nothing named. Same root (stored config is invisible in the mode that ignores it), so these are more likely one fix than two.
- **PRM-7T3Q** — SPLIT PROPOSAL (owner decision, not auto-split): (1) the ledger records write-time success as delivery (the integrity bug); (2) build Chunk 04 receipt + re-delivery (the designed fix). Item is stage:design and its build plan asks for a ledger-consumer enumeration first, so splitting now would mint an id for work whose shape is not yet fixed -- recommend keeping it whole until that pass runs.
- **PRW-4J8D** — SPLIT PROPOSAL (owner decision, not auto-split): the title joins the fix (pin the worktree path in reviewer prompts) to the defect (dispatched subagents anchor to the primary checkout). One claim, stated twice -- recommend NO split; the flag is the linter reading the em-dash join, and the rewritten title states the defect alone.

## Before / after

### SEC-9Z2D

- title before: `Cross-machine secure clipboard sync and file/secret uploader`
- title after (unchanged): `Cross-machine secure clipboard sync and file/secret uploader`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### PRJ-8M2X

- title before: `Refactor updateProject grab-bag into per-field validator table + two-phase validate/apply`
- title after: `projects: validate all updateProject PATCH fields before writing any`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### SES-5W9D

- title before: `Model session status as an explicit enum + allowed-transition map`
- title after (unchanged): `Model session status as an explicit enum + allowed-transition map`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### STO-7J4B

- title before: `Retire idempotent one-off migration shims that run on every config load`
- title after (unchanged): `Retire idempotent one-off migration shims that run on every config load`
- kind: `chore` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### TST-4X8N

- title before: `Add focused unit tests for wrap-steps submodules and server.js`
- title after (unchanged): `Add focused unit tests for wrap-steps submodules and server.js`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### TST-6L2P

- title before: `Reduce brittleness of frontend tests that regex-match exact public/* source text`
- title after: `tests: stop regex-matching exact public/* source text in frontend tests`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~500 visible words (budget 175)

### TL-3D5K

- title before: `Hold formatting/style consistency without a linter — the residue after the enforcement ruling`
- title after: `tooling: hold formatting consistency without adding a linter dependency`
- kind: `task` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~377 visible words (budget 175)

### DEP-8H7W

- title before: `Suppress node:sqlite ExperimentalWarning via --disable-warning flag`
- title after (unchanged): `Suppress node:sqlite ExperimentalWarning via --disable-warning flag`
- kind: `chore` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### MED-4T7K

- title before: `Accept an inbound Medusa message and insert it into the session`
- title after (unchanged): `Accept an inbound Medusa message and insert it into the session`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### MED-6P2N

- title before: `Auto-toggle mode for the Medusa control`
- title after (unchanged): `Auto-toggle mode for the Medusa control`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### MED-9X3B

- title before: `Autonomous relay mode (unattended switchboard)`
- title after (unchanged): `Autonomous relay mode (unattended switchboard)`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### MED-8H5W

- title before: `Session Switchboard v2 — auto-inject + agent-to-agent round-trip loop`
- title after: `ui/integration: Session Switchboard v2 auto-inject and round-trip loop`
- kind: `feature` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### TST-8V2Q

- title before: `Tighten FEATURES.md citation-contract coverage`
- title after (unchanged): `Tighten FEATURES.md citation-contract coverage`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### PRW-9K4C

- title before: `regen-views fail-closed validation hard-blocks every planless small-fix release window (upstream prawduct defect, 3.0.5)`
- title after: `prawduct-upstream: regen-views validation blocks planless releases`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~301 visible words (budget 175)

### PRJ-2F8W

- title before: `Visible diagnostic for persistent project-version-cache write failures`
- title after (unchanged): `Visible diagnostic for persistent project-version-cache write failures`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### SR-6D3W

- title before: `Extract the shared session-rules widget skeleton duplicated between Project Rules and the Master settings modal`
- title after: `session-rules: extract the rules widget duplicated in two surfaces`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~319 visible words (budget 175)

### SR-4N6C

- title before: `POST /api/session-rules/:id/restore returns CONFIRM_REQUIRED instead of NOT_FOUND for nonexistent versionNo on baseline master rules`
- title after: `session-rules: restore returns CONFIRM_REQUIRED for an unknown versionNo`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)

### PRJ-4T7G

- title before: `Extend stranded-config guard detection beyond Claude artifacts (gemini parity)`
- title after: `projects: stranded-config guard misses .gemini artifacts`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### WRP-3P9K

- title before: `Migrate the 12 projects with plans in legacy `.claude/plans` to `.tangleclaw/plans`, then retire the priming-roll legacy fallback`
- title after: `wrap: migrate 12 projects off legacy .claude/plans`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~183 visible words (budget 175)

### WRP-5H2T

- title before: `version-bump's changelog promotion emits bracketed headings without matching link-reference definitions`
- title after: `wrap: changelog promotion emits headings with no link-reference defs`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~195 visible words (budget 175)

### PTH-6R2K

- title before: `Unify the two project-containment predicates behind one helper with an explicit root policy`
- title after: `paths: unify the two project-containment predicates behind one helper`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### SR-8V4T

- title before: `Compare-and-set on rule-proposal approval — status PUT can ratify content the operator never saw`
- title after: `session-rules: status PUT can ratify content the operator never saw`
- kind: `bug` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)

### SR-2W7F

- title before: `fetchProjectRules renders API failure identically to an empty list ("No rules yet.")`
- title after: `session-rules: fetchProjectRules renders a failed fetch as an empty list`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)

### AUTH-4B7K

- title before: `A stored `bindAllInterfaces: true` is invisible in caddy mode — switching back to direct mode reopens a wide bind nothing named`
- title after: `auth: a stored bindAllInterfaces true is invisible in caddy mode`
- kind: `bug` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~331 visible words (budget 175)

### AUTH-6D9P

- title before: `ttyd exposure is derived by enumerating wide binds, so a LAN-IP-bound job is exposed but reports not-wide (no notice fires)`
- title after: `auth: a LAN-IP-bound ttyd job is exposed but reports not-wide`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)

### ENG-7Q3M

- title before: `Detect drift in engine-declared `startupInjection.maxChars` against its upstream source`
- title after: `engines: detect drift in engine-declared startupInjection.maxChars`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~188 visible words (budget 175)

### PRM-4H8N

- title before: `Decide remove-vs-keep for the now-runtime-unused `summarizeFeatureIndexForPrime``
- title after: `engines: decide remove or keep for unused summarizeFeatureIndexForPrime`
- kind: `chore` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### UPD-3F7Q

- title before: `Add a short failure back-off to the update-checker's origin lookup so a degraded install stops re-spawning execSync on every check`
- title after: `update-checker: back off and test-seam the synchronous origin lookup`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### UPD-7B4X

- title before: `Route the update-checker's synchronous `git ls-remote` through the `_internal` seam so its failure path can be driven from a test`
- title after: `update-checker: route the sync git ls-remote through the _internal seam`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### UPD-5K9V

- title before: `Make the manual update-check honest against a server older than the client, and test that path`
- title after: `update-checker: manual update-check is dishonest if the server is older`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~263 visible words (budget 175)

### ENG-6J8P

- title before: `Own shell-safety for generated hook commands in one place instead of at each call site`
- title after: `engines: own shell-safety for generated hook commands in one place`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### PRM-7T3Q

- title before: `Hook delivery is recorded as success when the shards are WRITTEN, never when the hook actually runs — a total outage logs as delivered on every launch`
- title after: `prime-delivery: delivery is recorded as success when shards are written`
- kind: `bug` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~289 visible words (budget 175)

### PRW-6T2M

- title before: `verify-chunk-refs resolves plan refs against the symlink realpath, so it validates against the wrong worktree`
- title after: `prawduct-upstream: verify-chunk-refs checks refs in the wrong worktree`
- kind: `bug` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~188 visible words (budget 175)

### PRW-4J8D

- title before: `Critic coordinator must pin the worktree path in reviewer prompts — dispatched subagents anchor to the primary checkout`
- title after: `prawduct-upstream: Critic reviewer prompts anchor to the primary tree`
- kind: `bug` (assigned by plan)
- ⚠ **flagged non-atomic** — split is an owner scrub decision
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Repro
- lint: `missing-section` — missing required section: Actual
- lint: `missing-section` — missing required section: Expected
- lint: `missing-section` — missing required section: Evidence
- lint: `bug-missing-env` — bug has no Env line — record the product version (+ environment)
- lint: `body-too-long` — ~184 visible words (budget 175)

### DOC-2Q7X

- title before: `Add JSDoc to the 9 undocumented private helpers`
- title after (unchanged): `Add JSDoc to the 9 undocumented private helpers`
- kind: `chore` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~208 visible words (budget 175)

### TST-3M6R

- title before: `Switch `test/wrap-step-pr-merge.test.js` to `node:assert/strict``
- title after: `tests: convert the remaining non-strict node:assert suites to strict`
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### TST-5N8W

- title before: `Switch `test/condition-log.test.js` to `node:assert/strict``
- title after (unchanged): `Switch `test/condition-log.test.js` to `node:assert/strict``
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### TST-9B4L

- title before: `Add tests for 4 API endpoints with no reference anywhere in `test/``
- title after (unchanged): `Add tests for 4 API endpoints with no reference anywhere in `test/``
- kind: `task` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### NRM-5K8T

- title before: `Build the norm-enforcement source scans marked "to build" in the Enforcement table`
- title after: `norms: build the norm-enforcement source scans still marked to build`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~445 visible words (budget 175)

### ENG-8V3N

- title before: `Real Codex Silent-Prime hook support, if still wanted`
- title after (unchanged): `Real Codex Silent-Prime hook support, if still wanted`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out

### MED-2K9P

- title before: `Medusa session-comms control in the TC session banner (switchboard realization)`
- title after: `ui/integration: Medusa session-comms control in the session banner`
- kind: `feature` (assigned by plan)
- lint: `missing-section` — missing required section: Problem
- lint: `missing-section` — missing required section: Proposed change
- lint: `missing-section` — missing required section: Acceptance
- lint: `missing-section` — missing required section: Scope-out
- lint: `body-too-long` — ~219 visible words (budget 175)
