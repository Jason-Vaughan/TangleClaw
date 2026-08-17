# Build Plan — #897: a killed wrap command must not be reported as a failed one

**Issue:** [#897](https://github.com/Jason-Vaughan/TangleClaw/issues/897) · **Branch:** `fix/897-killed-vs-failed-sweep`
**Size:** medium · **Type:** bugfix (defect-class sweep) · **Critic mode:** `cumulative-final`
**Requirements Confidence:** High — the defect class, the sites, and the acceptance rule all come from the issue and were re-verified against the code; the two open items are recorded as assumptions below.
**Related:** #894 (the same defect, in the two handlers nothing runs), #891 (same misdiagnosis shape, git budget)

---

## Confidence Check

**What problem are we solving?** Seven wrap-step sites run a child process under a timeout and cannot
tell a command that was **killed** from one that **ran and failed** — so a hang is reported to the
operator as a failure that never happened, and remediated as one. Unlike #894, every one of these is
reachable from the shipped fourteen-step wrap pipeline, and two of them (`commit`, `pr-merge`) take
outward actions whose post-kill state is genuinely ambiguous.

**What does success look like?** An operator whose `git commit`, `gh pr merge`, `gh pr list`,
`git diff` or `git log` is killed by our own timeout is told *that it was stopped and did not
finish* — never "it failed", never a remediation naming a cause that was never observed. Where the
killed command may have partially landed, the remediation says to check.

**What is out of scope?** Changing any timeout VALUE; adding retries; the `test`/`lint` handlers'
timeout logic (shipped in #894); rendering the `unreadable`/`incomplete` payload seams (#885);
the 54-site synchronous-read sweep (#889).

---

## What the sweep actually found

The issue names eight files. Enumerated against the code, the real shape is:

| # | Site | Shape | Reachable from the shipped pipeline? |
|---|---|---|---|
| 1 | `wrap-steps/commit.js` | async `execFile` wrapper | yes — step `commit` |
| 2 | `wrap-steps/pr-merge.js` | async `execFile` **and** `exec` wrappers | yes — step `apply-pr-resolutions` |
| 3 | `wrap-steps/pr-check.js` | async `exec` wrapper | yes — step `open-pr-check` |
| 4 | `wrap-steps/continuity-write.js` | async `execFile` wrapper | yes — step `continuity-write` |
| 5 | `wrap-steps/features-toc.js` | sync `execSync` + catch | yes — step `features-toc` |
| 6 | `wrap-steps/changelog-coverage.js` | sync `execSync` + catch | yes — `changelog-update`'s `verifySatisfiedBy` predicate |
| 7 | `wrap-steps/_git-range.js` | sync `execSync` + catch | yes — via 5 and 6 |
| 8 | `wrap-steps/version-bump.js` | **no child process at all** | n/a |

**Correction to the issue.** `version-bump.js` spawns nothing: it requires only `fs`, `path`,
`./_date`, `../logger`, `../store`, `../project-paths`, and none of those reaches `child_process`.
Its eleven `.exec(` hits are `RegExp.prototype.exec`. The issue's second comment lists it among the
steps "still mapping a killed command to a plain exit 1" — that claim is wrong, and this plan
records the written reason the issue's own acceptance criterion asks for rather than editing code
that has no defect. Same verification applied to the other seven: each was confirmed by reading the
wrapper, not by matching a symbol.

### Why the sync half matters more than it looks

`changelog-coverage` is the worst instance in the sweep. A killed `git log` is caught and returned
as verdict `unavailable`; `ai-content.js#_satisfactionPredicateGate` maps `unavailable` to `null`,
which **falls back to the mutation check** — so a session whose changelog IS maintained gets blocked
with "CHANGELOG.md is unchanged", from a predicate that never ran. That is the #894 defect exactly,
on the step an operator hits every wrap.

`_git-range` is the quietest: a killed `git merge-base --is-ancestor` is caught and returned as
`false`, which reads as "the recorded SHA is orphaned" and silently widens the session range to the
whole trunk divergence — the #664 ballooning shape, with nothing logged.

---

## Chunk A — the async half (the outward actions)

**Files:** `lib/wrap-steps/_exec-shell.js`, `commit.js`, `pr-merge.js`, `pr-check.js`,
`continuity-write.js`, `test/wrap-step-exec-timeout.test.js` (+ per-step guards)

1. **`_exec-shell.js` grows `execFileArgs(file, args, options)`** — the argv-style sibling of
   `execShell`, same `{exitCode, stdout, stderr, error, timedOut}` contract, same `wasTimedOut`
   predicate, same `TIMEOUT_EXIT_CODE`. Argv-style cannot be folded into the shell form: `commit.js`
   passes multi-line commit messages through `git commit -m` and depends on there being no shell.
2. **Each of the four steps delegates its `defaultExec` / `defaultExecShell` to the shared module**,
   keeping its own timeout and buffer caps, and gains the `timeoutMs` / `maxBufferBytes` test seam
   that `lint.js` and `test.js` already carry — without it, the mapping from a real kill to
   `timedOut` is the one thing no guard can reach, which is where this defect lived.
3. **Branch on `timedOut` at every site that surfaces a failure to the operator**, keeping each
   site's existing non-timeout wording untouched:
   - `commit.js` — `git status`, `git checkout -b`, `git add -A`, `git commit` blockers, and the
     auto-PR loop's `git push` / `gh pr create` / `gh pr merge` errors.
   - `pr-merge.js` — `git push` and `defaultEnqueueAutoMerge`'s reason.
   - `pr-check.js` — `defaultListOpenPrs`'s reason.
   - `continuity-write.js` — best-effort by contract, so no operator-facing text changes; a killed
     probe gets a `log.warn` so a stamp reading `unknown` has a traceable cause instead of none.
4. **Ambiguous-outcome remediation.** `git commit` and `gh pr merge` killed by SIGTERM may have
   landed. Their remediation says so and names the check (`git log -1` / the PR's merge queue),
   rather than asserting either outcome. The current text — "The commit was rejected — most often by
   a pre-commit hook … Read the hook output above" — is the exact false story this issue is about:
   there is no hook output, and the commit may exist.

**Done when:** a real killed command through each of the five production wrappers yields
`timedOut: true` and exit `124`; no operator-facing string on a timeout path names a cause that was
not observed; suite green.

## Chunk B — the sync half, plus the carried observations

**Files:** `lib/wrap-steps/_git-range.js`, `features-toc.js`, `changelog-coverage.js`,
`lint.js`, `test.js`, `_exec-shell.js`, guards

5. **`_git-range.js`** — the three `execSync` probes call `wasTimedOut(err)` in their catch:
   `log.warn` naming the killed probe, and `resolveSessionRange` reports `stopped: string[]` on its
   result (plus an `onStopped` collector, because the NULL return carries no field) so a caller can
   say the trunk fallback was taken because a probe was **stopped**, not because the SHA failed to
   resolve. Both callers READ it — on the non-null path too, which is where the costliest case
   lands. The fallback itself is unchanged — it is the right answer either way; what
   was missing is any record that it was a guess.
   *Not* rethrowing: `features-toc` calls the resolver outside a try, so a throw would turn a silent
   wrong answer into a crashed step.
6. **`features-toc.js`** — `_diffNameOnly`'s catch names a kill as a kill. Today a timeout skips the
   step with `git diff failed: Command failed: git diff …`, which says "failed" about a command that
   was stopped and does not even mention the timeout.
7. **`changelog-coverage.js`** — `_listCommits` and `_dirtyPaths` catches name a kill as a kill in
   the `unavailable` reason, so the `log.debug` in `ai-content.js` that records why the mutation
   fallback engaged says "the probe was stopped" rather than a bare `Command failed`.
8. **Carried from the issue's comments** (all local to files this chunk already opens):
   - `lint.js` — the `blocker === false` timeout path writes the drawer channels but logs nothing;
     add the `log.warn` its two blocking siblings already have. The one configuration that
     deliberately does not stop the wrap must not also be the one that leaves no record.
   - `lint.js` — `output.timedOut` has no production consumer (only a test reads it). **Decision:
     remove it**, and re-point `test/wrap-pipeline.test.js:789` at `output.warning` /
     `output.remediation`, which is what `public/wrap-drawer.js#buildStepRow` actually renders. That
     is a stronger assertion, not a weaker one — it pins the thing the operator sees. Alternative
     considered and rejected: render `timedOut` in the drawer, which is new UI for a fact the
     `warning` + `remediation` pair already carries.
   - `lint.js:246-249` — the comment claims "Any other blocker value falls through to the `false`
     branch above". It does not: the branch tests strict `false`, so every other value blocks.
     Pre-existing, wrong, and it describes the exact control flow this sweep reasons about.
   - `_exec-shell.js` `TIMEOUT_EXIT_CODE` is exported with no importer while both #894 guards assert
     the literal `124` — give it the importers.
   - Stray double blank lines at `lint.js:66-67` and `test.js:54-55`. (There is no linter in this
     repo — no `package.json`, no eslint config — so nothing else will ever catch these.)
9. **`version-bump.js`** — no change; the written reason is the table above.

**Done when:** a real `execSync` timeout is named as a stop at each of the three sync sites; the
five carried observations are discharged; suite green.

---

## Guard strategy — real kills, not modelled ones

Three hand-written models of these error shapes were wrong in #894, which is the entire reason this
issue exists. So:

- **Async shape** — every guard drives the *production* wrapper against a real `sleep 30` with a
  ~300ms timeout, exactly as `test/wrap-step-exec-timeout.test.js` already does for `execShell`.
  Extended to `execFileArgs` and to each of the four steps' own wrapper.
- **Sync shape** — a guard runs a real `execSync` under a short timeout, catches, and asserts
  `wasTimedOut` on the **real thrown error**. Where a site's injected `exec` seam must be exercised
  (`_git-range` builds its own command strings, so a stalling command cannot be passed in), the seam
  rethrows *that captured real error* — the object is produced by a real kill, never hand-built.
  This is the one place the guard cannot spawn the subject directly, and it is called out so the
  next reader does not mistake it for a stub.
- **Mutation check, per new branch.** For each `timedOut` branch added: name the edit that should
  make its guard go red, apply it, confirm red. A branch whose guard passes with the branch deleted
  is documentation, not a test — six recorded occurrences of that shape on this project.

## Assumptions

- `[ASSUMPTION]` Adding `error` / `timedOut` to the four steps' result shape is additive: existing
  test doubles return three fields, so `timedOut` is `undefined` → falsy → the ordinary path.
  Verified against the 27 `_internal.exec` doubles across four test files. **Revisit if** any double
  starts asserting on the result shape's key set rather than its values.
  **Trigger fired, chunk B (recorded at chunk close, not after the fact):** three key-set
  `deepEqual`s did need editing — `test/wrap-git-range.test.js:36` and
  `test/wrap-step-features-toc.test.js:625,642`. They pin `resolveSessionRange`'s shape, not the
  exec shape this assumption covers, so the assumption itself held; the assumption is widened here
  to "any additive field on a shape a test asserts exhaustively", which is the class both cases
  belong to.
- `[ASSUMPTION]` No consumer outside these modules reads the `{exitCode, stdout, stderr}` shape.
  Grepped: each `defaultExec` is module-private behind `_internal`. **Revisit if** a step's exec
  seam is exported.

## Status

- [x] Chunk A — async half (`e681c58`)
- [x] Chunk B — sync half + carried observations (`f14282d`)
- [x] `/prawduct:critic` — 2 blocking, 8 warning, 6 note (`rev-20260810T144313Z-79fe656f`)
- [x] Chunk C — all blocking + actionable warnings resolved in one pass (`0f95d23`)
- [x] `/prawduct:critic verify-resolutions` round 1 — all 10 prior blocking/warning verified
      resolved; 2 NEW blocking, both self-inflicted by the resolution pass (`rev-20260810T150401Z-e3649c61`)
- [x] Chunk D — the two round-1 blockers fixed (`7212116`)
- [x] `/prawduct:critic verify-resolutions` round 2 — **0 blocking, 0 warning, 0 note**; both
      round-1 blockers verified fixed at the source, each with a guard that fails on revert
      (`rev-20260810T151250Z-c6d96cfc`)
- [ ] PR, `Fixes #897`

### Carried forward (recorded, not defects)

- `lib/wrap-steps/ai-content.js` still interpolates `${degraded}` into the uncommitted-work
  remediation. Inert today — the only producer of that verdict shape now returns `reason: null`
  there, so the fix landed at the source rather than at both ends. It matters only if a second
  producer of that shape ever appears.
- The plan lives at `.tangleclaw/plans/` per TangleClaw's global rules, not `.prawduct/artifacts/`,
  so record-lint's `chunk-ref-missing` check cannot resolve a scope for it. Convention, not drift.

## Chunk D — round-1 resolutions

Both were introduced by chunk C, which is the pattern this plan has now hit three times: **a fix
written to close a finding is new code, and it inherits none of the discipline that writing a
feature does.**

1. **A `log.warn` I added to close a finding threw `ReferenceError`.** `_autoPrCloseLoop` takes
   `{cwd, branch, originalBranch, staged}`; the log line reached for `project.name`, bound in
   `run()`. The call site catches, so it failed silently into a strictly worse lie than the one the
   log existed to prevent: the branch is reached only after push + `gh pr create` + `gh pr merge
   --auto` have all SUCCEEDED, and the catch synthesises `pushed:false, prUrl:null,
   autoMergeArmed:false` — telling the operator to push a pushed branch and open an open PR, and
   nulling the `prUrl` in the activity_log row that exists so stranded wraps can be found by query.
   Now guarded by a test that drives the full success path with only the courtesy checkout killed
   and asserts the auto-PR result survives intact.
2. **The degraded-range caveat was rendered onto a verdict the range never produced.** Chunk C
   attached `_degradedRangeReason` to BOTH `uncovered` returns. The uncommitted-work form is read
   from the working tree — `uncovered: []`, `checkedCount: 0` — so `ai-content` was appending
   "check the listed commits belong to this session" to a list of FILE PATHS. Same class as the
   round-0 blocker: a new operator-facing string naming something not observed, whose plain reading
   invites tick-through of a correct block. The caveat now rides only the commit-list form.

Also closed from the review's demoted observations: the two `_gitFacts` `_warnStopped` sites, which
chunk C left uncovered on the argument that they share a helper with the two that were guarded —
"same helper" is a claim about the code, not a guard over the call sites.

## Chunk C — Critic resolutions

Both blocking findings were correct and both were self-inflicted by the fix:

1. **A new false operator-facing string, on the path that exists to remove them.** The killed
   `git status` remediation said "your working tree is exactly as you left it" — but
   `_flushStagedWrites` runs BEFORE that probe, so earlier steps' artifacts are already on disk. The
   same file already documents this at the auto-branch site. Rewritten to say what is actually true.
2. **The mutation-check claim did not hold.** Eleven mutations had been run, which is not the same
   as eleven *branches covered* — most new branches had no guard at all. Twenty branches now have
   one, each mutated away and confirmed red (see the two guard suites). The claim and the wording
   that overstated it are corrected here rather than left standing.

Two design findings, each raised independently by more than one reviewer, were also fixed:

3. **`commit.js`'s branch probe was the one site where a kill changed BEHAVIOUR, not wording.** A
   killed `git rev-parse --abbrev-ref HEAD` left `branch = null`, which switched off the #264
   auto-branch guard — so a wrap fired on `main` committed straight to `main`, silently, which is
   exactly what that guard was added for after the 631acb5 incident. The sweep had applied its own
   rule to every sibling probe in the file except this one. It now halts with a clear remediation,
   and `allowDirectToMain` still bypasses.
4. **`resolveSessionRange().stopped` had no production reader.** Both callers used the `onStopped`
   collector and only on the null-range path — so the case the plan itself calls costliest (a killed
   ancestry probe widening the range while a range still resolves) surfaced nowhere. That is the
   same unconsumed-payload-field anti-pattern this branch cites when deleting `lint.js`'s
   `output.timedOut`, applied asymmetrically. Both callers now read it on the non-null path, and
   `changelog-coverage` carries the caveat into the block text `ai-content.js` renders — so an
   operator being told to write changelog entries is warned when the commit list may reach past
   their own session.

Accepted without change (recorded, not actioned): the conditional-detail wording drift (an
improvement the plan did not promise), the `makeRunner` factory for the seven near-identical cap
blocks (uniform today; worth doing when the seam grows a knob), and the change-log/backlog
bookkeeping notes, handled separately.
