# #1619 — final evidence for Architect review

Branch `fix/issue-1619-identity`, HEAD `09706a5`, on `main` @ `65fe15b`.
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
- **Missing/mismatched context fails visibly.** The discovery block says `whoami`
  ECHOES the workspace rather than validating it, and to stop on a mismatch with
  the launch env.
- **Repeat launch/sync/wrap.** The committed carrier is migrated, so a
  regenerated block is byte-identical; a block that still carries identity is no
  longer staged silently but returned as "not provably ours".
- **Nested worktree and accidentally-tracked local carrier.** Both fixtures build
  real git repositories. The tracked-`.codex.yaml` case is the gate you required.
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

## Not fixed here, deliberately

- **#1626** — `GET /api/shared-docs` without `groupId` is unfiltered. Changing an
  existing endpoint's semantics affects every consumer and wants its own review.
  Nothing in this branch depends on it: the instruction that led there is gone.
- The route pin asserts route EXISTENCE, not that a parameter means what the
  caller thinks. That limit is stated in the CHANGELOG rather than papered over.
