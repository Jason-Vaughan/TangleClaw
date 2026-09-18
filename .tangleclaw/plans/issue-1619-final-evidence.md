# #1619 — final evidence for Architect review

Branch `fix/issue-1619-identity`, on `main` @ `f4d0d20` (which added #1624 and
#1625 after this branch was cut, merged in at `eef19e7`).

**Implementation and test revisions this document describes**, named rather than
referred to, so the claim cannot drift onto a later commit:

| SHA | What it carries |
|---|---|
| `fa38535` | The Architect's R1 (unknown tracking state → committed) and R2 (lock status out of the committed carrier) |
| `2d393bc` | Deletes the reasoning R1 retracted, from `CHANGELOG.md` |
| `9a8b92f` | Deletes the same reasoning from the plan's discharge record |
| `2842fee` | The wrap refusal reaches the staging decision; the same reasoning removed from two `lib/engines.js` comments |
| `c858016` | The refusal is asked of the file rather than of the diff, closing two routes that bypassed it |
| `c2b0f1a`* | This row, defect 5 below, and the counter-case test corrected to assert measured behaviour |

\* The commit carrying these record edits; it names itself only in the sense
that the row describes the change it ships, which is the self-reference the
Architect said is unnecessary to avoid for a docs commit.

The Architect's independent recheck of R1 and R2 was performed at `9a8b92f`, and
closed both. `2842fee` lands after that check; its own content is described in
the Review-status section below.
All four chunks of the fix brief are implemented. Coverage gate: **satisfied**
(composed review spans the whole branch, 0 unresolved blocking findings).

Supersedes `issue-1619-chunk01-diff.md` and `issue-1619-chunk01-evidence.md`,
which describe earlier commits.

## The brief, point by point

| Brief | Where | State |
|---|---|---|
| 1. No checkout-specific name, route, ID, machine origin or live credential in shared bytes | `lib/engines.js` generation | done |
| 2. Deliver changing facts through existing launch context; no new identity schema | `TANGLECLAW_API`, `TANGLECLAW_PROJECT_ID`, `TANGLECLAW_WORKSPACE_ID`, `tc whoami` | done |
| 3. Stable discovery instruction; `tc` may be unavailable; refuse rather than guess | `lib/ecosystem-primer.js`, discovery block | done, your wording |
| 4. Local delivery keeps operator content; no checkout-specific fallback in shared bytes | shared-docs section points at the API; no `./bin/tc` anywhere | done |
| 5. Migrate stale TC-owned text out of tracked carriers | chunk 02, `CLAUDE.md` managed block | done |
| 6. Review wrap ownership; a managed block is not proof; no prompt on an ordinary wrap | `lib/wrap-steps/_tc-owned-paths.js` | done |
| 7. Cover every engine's generation path; respect plugin-owned sections | five generators + governed block | done |

## Acceptance evidence

- **Five checkouts, one committed baseline.** Distinct names, roots, numeric
  project ids and API origins; a shared doc locked by a third project. All three
  committed carriers (`CLAUDE.md` ungoverned, the plugin-governed operational
  block, `AGENTS.md`) are byte-identical across all five, name no project, carry
  no origin, and keep all five Medusa routes. Proven end to end through
  `writeEngineConfig`, the path that actually put `TangleClaw-Builder1` on `main`.
- **Rename survivability.** Identity is resolved at run time, so a rename
  changes no committed byte. The stale-PATH case your addendum asked about is
  handled in the bootstrap line, with the recovery routed through
  `TANGLECLAW_API` and no checkout-specific fallback.
- **Missing/mismatched context.** The discovery block says `whoami` ECHOES the
  workspace rather than validating it, and to stop on a mismatch with the launch
  env. **Residual limitation, stated rather than claimed as coverage:** that is
  generated PROSE instructing a session to compare — not an independent
  validation of the current launch. Nothing here proves a session obeys it, and
  no mechanism in this change verifies a claimed workspace against the live
  launch record. Closing that needs a server-side check, which is not in this
  change.
- **Repeat launch/sync/wrap.** The committed carrier is migrated, so a
  regenerated block is byte-identical; a block that still carries identity is no
  longer staged silently but returned as "not provably ours".
- **Accidentally-tracked local carrier.** Real git repositories: one ignoring its
  `.codex.yaml`, one with the file INDEXED and then ignored, and an unknown
  tracking state. The gate you required.
- **Nested worktree — what it does and does not show.** The fixture proves a
  linked worktree is classified by its OWN ignore rules, because `git -C
  <worktree>` answers there. It is **not** evidence about parent-directory
  instruction loading: nothing in it exercises an engine reading a `CLAUDE.md`
  from an enclosing checkout. That case is unaddressed by this change.
- **Global rules and operator content preserved.** The migration refused to write
  unless nothing outside the managed block changed;
  `test/repo-governance-reference.test.js` still pins the mirror equal to its
  source.
- **Full suite:** green, 0 failures, recorded against the tree via the JUnit
  reporter at every commit.

## Mutation checks

Each of these was verified to FAIL when the fix is reverted:

| Reverted | Caught by |
|---|---|
| Governed block's switchboard call → identity-bearing form | `tracked-carrier-identity` |
| Origin literal restored in committed carriers | origin-variation test (and only it) |
| Aider shared-docs body → identity-bearing rendering | private-format generator matrix |
| `judge` stops asking the identity question | `wrap-tc-owned-paths` |
| `judge` scans the whole file instead of the block | `wrap-tc-owned-paths` |

## What I got wrong, and what corrected it

Recorded because the review history is part of the evidence.

1. **Shared-doc paths and contents.** I argued they were group configuration and
   reverted a Critic fix for them. Your two same-policy fixtures disproved it.
2. **A classifier claimed but not wired.** Shipped a CHANGELOG bullet saying
   carriers were "derived" while the predicate had zero callers; then, once
   wired, it was still bypassed at three of five sinks; then a derived value was
   computed and ignored in one body. Three rounds, same class. Closed
   structurally: the literal origin is unreachable without declaring the carrier.
3. **A guard that would have fired on every wrap.** Twice — first scanning the
   whole carrier, then scanning a block that legitimately contains the operator's
   global rules for `AGENTS.md`. The patterns now match the labelled line
   generation writes, not prose.
4. **A redirect to a route that 404s.** My fix for "groupId is unobtainable"
   named a name-scoped route and fed it a numeric id; the natural fallback was
   the unfiltered `GET /api/shared-docs`, which returns every group's documents
   and absolute paths. Fixed; the endpoint itself is filed as **#1626**, not
   fixed here.
5. **A budget cap raised.** Your bootstrap wording cost 28 characters more than
   the prime budget; ~150 characters of filler came out first, then the cap moved
   2700 → 2800 as a recorded decision.
6. **A flake claimed as pre-existing** on weak evidence. Status is unknown: seen
   only under full-suite load, not reproduced on base under comparable load, not
   attributed.
7. **I committed the drift myself.** `fbdeaa6` swept the regenerated `CLAUDE.md`
   in via `git add -A`. Reverted in the next commit; the plan now carries the
   staging rule.

## Review status — no final approval

Reviewed by the Architect against the brief, with changes requested and
addressed. **No final approval has been given**, and nothing in this document
should be read as one. Eleven Critic rounds including a three-reviewer cumulative. Each blocking
finding was fixed and re-verified; the coverage gate's state at any moment is
whatever `prawduct-hook check-cumulative-critic` reports, which is the only
claim about it worth making in a document that outlives the tree it describes.

The Architect's review of the merged HEAD reproduced two blockers that every
targeted suite had passed:

1. **`_carrierIsCommitted` fell back to the filename convention when git could
   not answer.** Reproduced by tracking a `.codex.yaml` in a real repository and
   making the probe throw ENOENT: the carrier became private and the generator
   inlined a token. My reasoning — "a directory git cannot answer for commits
   nothing" — conflated a missing git with a missing repository. An unknown
   tracking state now means committed, and the tests that pinned the old
   fallback are replaced rather than relaxed.
2. **The committed shared-docs rendering still moved with live lock state.** A
   generic warning emitted only while a lock existed still meant the same
   document, unlocked and then locked, produced two different files. Lock status
   no longer reaches a committed carrier at all; the instruction survives as
   unconditional prose, and the private carrier keeps the live holder.

Both are pinned, and each was verified to fail the suite when reinstated. The
Architect rechecked them at `9a8b92f` and closed both, reproducing the
indexed-then-ignored and injected-ENOENT cases independently.

A third defect followed, from the cumulative review and fixed at `2842fee`:

3. **The wrap's refusal did not reach the staging decision three records said it
   controlled.** The guard downgraded an identity-carrying carrier from
   `MAINTENANCE` to "not provably TangleClaw's", and a null verdict falls
   through to the ordinary ownership rules — a carrier the running server
   regenerated mid-session is not dirty at launch and carries this session's
   mtime, so it landed in `owned`, which is staged exactly like maintenance. The
   guard changed which bucket the file was staged from and nothing else, for the
   case it is named after. My own tests asserted against `judge` alone, where
   that half was correct. The refusal now carries its reason, the ownership rules
   act on it, and the carrier reaches the operator; pinned at the composition.

4. **The refusal was reachable only where the head-vs-work comparison
   succeeded.** Every other exit from the carrier branch returned a bare null
   verdict — the file also differs outside the block, a malformed block, no
   comment form, no HEAD copy at all — and a bare null falls through to the
   mtime rule and is staged from `owned`. Same outcome as defect 3, by a second
   route, and neither input is exotic: an operator editing their own prose in
   the session the block acquired identity, or a previously-ignored carrier
   being tracked for the first time. The question is now asked of the work copy
   alone, before the comparison and again on the throw path. Three cases pinned,
   each mutation-checked, including the counter-case that an ordinary compound
   edit still stages.
5. **My own counter-case test proved less than it claimed.** Its single
   assertion was guarded by `if (asked)`, so it would have passed silently the
   day that path stopped reaching `foreign` — the outcome it existed to detect.
   Corrected, and I got it wrong once more on the way: my first correction
   asserted the carrier was put to the operator, which is not what happens. It
   stages, as the session's own file. Measured, then asserted.

**Still open, and for the Architect to rule on rather than for me to decide:**
the wrap-side detector matches three of the six identity classes generation
withholds, and its patterns are hand-typed rather than derived from the
generator, so a reword could disable it with the suite green. Neither is
exploitable today — generation no longer emits those values into a committed
carrier, and the detector exists for the pre-fix-server and hand-edit cases.

## Not fixed here, deliberately

- **#1626** — `GET /api/shared-docs` without `groupId` is unfiltered. Changing an
  existing endpoint's semantics affects every consumer and wants its own review.
  Nothing in this branch depends on it: the instruction that led there is gone.
- The route pin asserts route EXISTENCE, not that a parameter means what the
  caller thinks. That limit is stated in the CHANGELOG rather than papered over.
