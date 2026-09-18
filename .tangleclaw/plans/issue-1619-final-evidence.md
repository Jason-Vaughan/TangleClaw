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
| `55ae5b4` | The `c858016` row, defects 4 and 5, the counter-case test corrected to assert measured behaviour, and the coverage-gate sentence narrowed to point at the command rather than assert a moment |
| `279644b` | The Architect's ruling: all six runtime-data classes, malformed regions treated as unverifiable, legacy whole-file carriers judged whole, and the bounded matrix |
| `eabd718` | The inline-body check re-keyed on the rendering after it misfired on this repo's own carrier, and the matrix counter-case rebuilt from the assembled block |
| `02390b7` | A superseded rule deleted from a comment, a misdirecting export comment, and a document name containing an asterisk no longer letting its body escape |

The table above stops there ON PURPOSE. Rows were added while implementation
was landing; continuing one per commit made the table a log of its own edits,
and every fill-in row needed a successor to name it. What follows replaces it
for the candidate as a whole.

## Final candidate

| | |
|---|---|
| **HEAD** | `7da31fdca5687482a87683385c30855e1a4da3fa` |
| **Tree** | `5689247500cd2e25ead21309dbffe529118097e2` |
| **Branch** | `fix/issue-1619-identity`, on `main` @ `f4d0d20` |
| **Architectural approval** | granted at `f0b3af1`. Commits after it are `5d5f725` (the direct no-masking fixture the Architect asked be retained, plus the corrected origin explanation) and `7da31fd` (comment sweep, no behaviour). |
| **Test evidence** | recorded against this tree by `prawduct-hook test-evidence record --from-junit`; `test-status` exits 0 with the working tree identical to the recorded run. |
| **Critic** | coverage gate satisfied over `69fcb7db..` this tree, 0 unresolved blocking. The newest fact is a `verify-resolutions` round with 0 findings. |
| **CI** | GitHub Tests SUCCESS at `f0b3af1`, independently confirmed by the Architect; re-run in flight for later commits. |

Figures are deliberately not copied into this table: `prawduct-hook
test-status` and `check-cumulative-critic` answer for the tree in front of the
reader, and a number written here ages the moment anything lands.

**The origin is not emitted unconditionally.** `rules.core.porthubRegistration:
false` removes the PortHub guide, and with it the API origin, the Medusa routes
and the bearer line; `rules.core: {}` leaves registration at its default, which
is ON. An earlier revision of this document said the opposite and used that to
explain why a no-masking fixture was impossible. It was not impossible: that
fixture is now regression coverage for both private carriers.

Rows are added as implementation lands. The table is not a log of its own
edits: a row naming the commit that wrote the row needs a successor to name
that one, and the sentence that tried to do it has already been stale twice.

The Architect's independent recheck of R1 and R2 was performed at `9a8b92f`, and
closed both. `2842fee` lands after that check; its own content is described in
the Review-status section below.
All four chunks of the fix brief are implemented. For the coverage gate's
state, run `prawduct-hook check-cumulative-critic` — it answers for the tree in
front of you, which a sentence written here cannot.

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
should be read as one. Critic rounds throughout, including a three-reviewer cumulative; the governance ledger holds the count, which is where a number belongs rather than in prose that ages. Each blocking
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

6. **The detector covered three of the six classes, and my defence of that was
   wrong.** I argued the other three were "not exploitable today because current
   generation omits them". The Architect ruled that is not a discharge: this
   guard exists precisely for the two cases where generation is NOT current — an
   older server regenerating a carrier, and a carrier migrating from private to
   shared — and rollout has not happened, so both are ahead of us. All six are
   covered now, each matched against the shape the private renderer writes.
7. **The check I added for the sixth class misfired on this repo's own
   carrier.** It keyed on the `## Shared Documents` heading, and the shared-docs
   GUIDE is such a section, ships fenced examples, and is injected into every
   carrier whether or not the project has any documents — so it asked on every
   ordinary wrap of the common case. Re-keyed on the shape the private renderer
   writes. The matrix missed it because its counter-case was assembled from
   three emitter line-sets rather than being the block generation actually
   writes; it now builds from `_generateOperationalBlock`. **A counter-case
   assembled from parts cannot prove a whole is silent.**

8. **The machine-path sweep stopped one renderer short, twice.** `tildeHomePath`
   is the only way an install path reaches a carrier, and it is called at three
   places in the renderer: the reference line, and the two fallbacks written
   when an inline document is missing or unreadable at generation time. I
   covered the first, then widened the first again, and left the other two both
   times — so a private carrier whose inline document could not be read held the
   operator's path while the guard stayed silent. Covered now, and the class is
   checkable rather than remembered: a test enumerates `tildeHomePath`'s call
   sites and fails if a fourth appears, naming what to do about it.

9. **I reported a fixture as impossible without checking.** The Architect asked
   that masking values — origin, route, token, lock — be absent, so a
   document-field miss could not hide behind them. I reported that the origin
   rides with the PortHub guide unconditionally, and substituted a
   strip-the-lines approximation. It is not unconditional: `rules.core: {}`
   leaves PortHub registration on by DEFAULT, and setting it explicitly false
   produces output with no origin at all. They verified it; I reproduced it. The
   direct fixture now sits in regression coverage beside the approximation — and
   writing it caught a second imprecision of mine, a precondition that forbade
   the words `Authorization: Bearer` rather than a live value, which the
   shared-docs guide legitimately documents as a placeholder.

**This was the same mistake six times.** Fix the instance shown, leave the
class. It cost more of this branch's review rounds than every other defect
together, and the Critic found each one by re-running the finding's own reason
as a search rather than trusting the sites it named. Where a fix could be made
checkable instead of remembered — the emitter-derived matrix, the
`tildeHomePath` call-site count — it now is.

**Nothing is left open for the Architect to rule on.** The encoding question
they ruled on is closed: patterns stay hand-written, and what is coupled to the
generator is behaviour — the matrix builds every body by calling the real
emitters, so an emitter change fails the guard's tests without anyone
remembering to update copied prose.

## Not fixed here, deliberately

- **#1626** — `GET /api/shared-docs` without `groupId` is unfiltered. Changing an
  existing endpoint's semantics affects every consumer and wants its own review.
  Nothing in this branch depends on it: the instruction that led there is gone.
- The route pin asserts route EXISTENCE, not that a parameter means what the
  caller thinks. That limit is stated in the CHANGELOG rather than papered over.
