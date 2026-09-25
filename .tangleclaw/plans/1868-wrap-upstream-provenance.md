---
branch: fix/1868-wrap-upstream-provenance
partition: serial. One new module, one classification contract shared by three callers, and the drawer helpers that read it. Every chunk edits `_file-ownership.js` or its output shape
---

# #1868: Wrap recommends duplicate commits for artifacts already merged upstream

*Pilot Car A2. The PM dispatched this on 2026-09-25. Planned on `main` @c859e894. The plan is revised against the
Architect's brief (TangleClaw-Architect `.tangleclaw/plans/1868-wrap-provenance-dispatch.md`, contracts 1–8,
questions A1–A4) and two read-only scout reports (server classification seams; drawer copy/state/retry).*

## Status

- [x] Plan written (rev 2: brief incorporated, scouts collected)
- [x] Architect has ruled on A1–A4 (R11, 2026-09-25): all four approved, with the R11-E final-boundary amendment and the R11-F subagent ruling. Implementation was released on incorporation, with no second architecture pause. See "Architect ruling R11"
- [x] R13 received (controlling), recorded above
- [x] R14 received (branch-own refinement with guards), recorded above
- [ ] Chunk 01: `_upstream-provenance.js`, which resolves the default-branch ref, refreshes it with a time limit,
      records when it was observed, gives the checkout's position, and gives a fact for each path. Unit tests run
      against real temporary repos with a bare origin
- [ ] Chunk 02: `classify` consumes provenance. Adds the `alreadyUpstream` bucket, the `upstream-owns` reason,
      the Include downgrade and the commit-boundary revalidation. Wired into session-files, commit and
      changelog-coverage
- [ ] Chunk 03: the drawer keeps and renders the provenance fields. The provenance header, the per-path
      upstream line, the manifest group, and pruning of stale answers. Docs and CHANGELOG
- [ ] Verify: focused tests, then the full suite on this checkout (**not** the main instance)
- [ ] Critic
- [ ] Draft PR opened. **STOP here** (pilot boundary)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling or updating the live checkout, no restarting the
live service, no tests on the main instance, no tag, publish or release, no deploy.

## Architect ruling R14 (2026-09-25): the branch-own refinement, approved with guards

- A local path equal to upstream is not `alreadyUpstream` when commits unique to this branch changed that path;
  staging may be needed to reverse the branch's own change.
- When both the branch and upstream changed the path since the merge-base, it is not `upstream-owns`. Ordinary
  feature-branch handling applies, and the divergence is exposed (`branchChanged` per path,
  `output.provenanceDiverged`, explanatory copy).
- The exception is proven from git history only (the blob at HEAD differs from the blob at the merge-base). It is
  never proven from mtime, launch ownership, file kind, TC-maintenance status, or an untracked local path (a path
  HEAD does not hold never qualifies). The B2 incident behavior is unchanged.
- Tests: (a) a revert of this branch's committed change, (b) a true both-sides change, and negative controls for
  an untracked path (recreated after the branch deleted it) and for a carrier judged owned on a branch whose
  commits touch other files.

## Architect ruling R13 (2026-09-25), controlling; supersedes R11 where they differ

- **A1 approved (b)**, within the bounded contract: single ref, non-interactive, no tags, no checkout, reset,
  merge or rebase, and no index or work-tree mutation. On failure, fall back safely to the stale ref. The existing
  behind-origin opt-outs are reused, and no new key is added (approved).
- **A2 approved, with one clarification.** On a stale ref, `observedAt` is when the local ref last changed. It is
  not proof that `refSha` was then the remote tip. Only an established (refreshed) answer may say "checked just
  now".
- **A3, as corrected.**
  - session-files freezes the ref name and the immutable `refSha`.
  - commit makes no network call. It rehashes the current local files against the captured commit, and it also
    re-resolves the current local remote-tracking ref OID.
  - If the ref moved, the current OID is used only to tighten. A prior Include that is now equal, upstream-owned,
    different or otherwise unsafe is refused, or blocked and re-presented, and the drawer prunes the stale answer.
    A ref move never broadens scope.
  - If the ref did not move, local-content tightening against `refSha` is handled the same way.
  - The test moves the actual remote-tracking ref while `previousResults` keeps the original `refSha`.
    Implementation: `unverified` ranks above `none`, so an Include does not carry onto evidence that can no
    longer be read.
- **A4 approved, with two corrections.** Copy shows the actual local line count. On stale or unavailable
  evidence, no Include recommendation is manufactured: every path that needs a decision defaults to Keep local,
  whatever its kind, while files the wrap already commits automatically keep their current behavior, so offline
  wraps still work.
- Implementation is released with no further Plan Written stop. Stop at the Draft PR / Critic boundary.

## Architect ruling R11 (2026-09-25), superseded by R13 where they differ

- **A1 approved (b)**, with these constraints:
  - The one fetch happens in session-files only. It fetches only the resolved default branch into its ordinary
    remote-tracking ref.
  - No tags, prune, checkout, reset, merge or rebase, and no index or work-tree mutation. Credentials are
    non-interactive, and the git-probe network timeout applies.
  - **It honors the existing behind-origin opt-outs** (`behindOriginCheckEnabled: false`,
    `TC_BEHIND_ORIGIN_DISABLED=1`). **No new config key.** This supersedes `wrapUpstreamRefresh` in A1 below.
  - Record the exact ref, the commit OID, the time, whether it refreshed, and any failure. A failed fetch falls
    back to local evidence as `stale`.
  - The commit step never fetches.
- **A2 approved.**
  - Under `stale`, an `equal` fact is still proof and goes to `alreadyUpstream`.
  - `absent`, `different` and `unknown` cannot support Include. The advice is downgraded to Keep local, with a
    note that upstream was not refreshed.
  - This is advice only, never a preselected radio.
- **A3 approved.** Git content is the contract. No `gh`, GitHub auth or wrap-ledger dependency in this Car.
- **A4 approved.** `alreadyUpstream` is a visible, non-interactive bucket: never staged or asked, shown with the
  ref and the reason, and the file is untouched.
- **R11-E, final boundary.**
  - session-files captures an immutable upstream OID after its fetch, and every later comparison names that OID.
  - At commit, re-read status and recompute every path fact against the captured OID. A local-blob conclusion is
    never reused, because wrap steps may have rewritten the file.
  - Also compare the current local remote-tracking ref OID with the captured one. If it moved and the newer local
    evidence tightens an earlier Include, block and re-present the updated facts.
  - Never broaden. No network call at commit.
- **R11-F.** Read-only scouts with disjoint contracts; the parent Builder is the sole writer. This was already
  done: one server scout and one drawer scout, both reaped before rev 2.
- Deliverables to report to the PM and the Architect: plan hash, branch and head, scout outputs, tests, a
  cumulative Critic, an independent exact-head review, and a draft PR. No merge, live sync, restart or release,
  and no work on #1839.

## Problem (verified in code)

Wrap advice comes from **file kind**, not **provenance**:

- `_file-safety.js` `safetyOf()` gives `.tangleclaw/{plans,priming,memories}` markdown files the class
  `durable`, and that class recommends Include. The path is the only input.
- `_file-ownership.js` `classify()` stages `owned` paths (by mtime or launch snapshot) and
  `tangleclawMaintenance` paths **without asking**. `_tc-owned-paths.judge` compares carriers such as
  `CLAUDE.md` only against `HEAD`. So a carrier that TangleClaw regenerates to match upstream is committed onto
  a stale branch.
- An Include or Leave decision is read only for paths classed foreign (`_file-ownership.js:288`). A decision for a
  path classed owned is silently ignored, and the path is staged.
- Nothing in `lib/wrap-steps/` reads a remote ref. `wrap-scope.trunk` is a fixed-name check
  (`_git-range.js:114`). The only real default-branch lookup lives outside the wrap, in `ci-status.js:154`
  (`symbolic-ref refs/remotes/origin/HEAD`).
- The drawer builds each path again from a fixed list of fields (`wrap-drawer.js:1104-1116`, `:1119-1127`,
  `normalizeManifest :1150-1160`). The client accumulates answers and resends them on every Retry
  (`accumulatePathDecisions :1342`). A changed server recommendation therefore never replaces an earlier answer.

**The incident fixture:** Pilot-B2's session root was at `4dff1bde`, 18 behind `c859e894`.

- `CLAUDE.md` differed from HEAD and was byte-identical to upstream.
- The untracked `.tangleclaw/plans/1861-durable-control-state.md` was tracked upstream with a 32-line
  status header.
- The drawer recommended Include. The correct answer was Leave.

## Confidence check

- **Problem:** the wrap proposes, or silently makes, commits of content that upstream already has or owns in a
  newer form. It also presents path-based guesses with confidence.
- **Success:** in the incident fixture, both paths get Leave (or no commit at all). The drawer shows the
  checkout's behind/ahead state and a plain-language upstream fact for each path. No Include can reach the commit
  step on stale provenance. Offline wraps still finish.
- **Out of scope:** the brief's non-goals: no reset, pull, clean, stash, delete or sync; no PR lifecycle
  redesign; no change to the secret, protected-DB or methodology classes; #1839 is excluded.

## Architecture questions A1–A4 (the brief's framing; recommendation first)

### A1: Freshness

- **(a)** Use the already-fetched ref only, with its observation time.
- **(b)** Refresh the ref once, with a time limit, then fall back to (a).
- **(c)** Run a read-only `ls-remote` check of the tip SHA.

**Recommend (b).** `session-files` runs once
`git fetch --quiet --no-tags <remote> +refs/heads/<default>:refs/remotes/<remote>/<default>`:

- The fetch goes through `execFileArgs` with `gitProbe.callEnv(true)` (no prompts, batch ssh) and
  `gitProbe.NETWORK_TIMEOUT_MS`.
- It updates exactly one remote-tracking ref and never touches the work tree, index or HEAD.
- A new config key, `wrapUpstreamRefresh` (default `true`), and the env var `TC_WRAP_UPSTREAM_REFRESH=0` skip it.
  That is for metered, offline or CI setups.

When the refresh is skipped or fails, the ref's observation time comes from `git reflog -1 --format=%ct <ref>`,
with the mtime of `FETCH_HEAD` as a fallback. When neither is readable, the time is `unknown`. The reason (a)
alone is not enough: the incident class is "merged minutes ago", and a stale ref cannot see that. (c) only adds a
round-trip, because it tells us the tip moved without giving us the blobs.

A failed refresh never blocks. It sets `refresh: 'failed'` with a reason, and the rules below make that safe
(brief contract 4).

**Default branch resolution:**

1. `symbolic-ref refs/remotes/<remote>/HEAD`, with `<remote>` = the branch's configured remote, else `origin`,
   else the only remote.
2. Else the first of `<remote>/main` and `<remote>/master` that exists.
3. Else `unavailable`.

It is never hardcoded to `origin/main`.

### A2: Result model (one object, computed once)

```
provenance = {
  state: 'established' | 'stale' | 'unavailable',
  remote, ref: 'origin/main' | null, refSha: string | null,
  refresh: 'refreshed' | 'skipped' | 'failed', refreshProblem: string | null,
  observedAt: ISO | null,               // when refSha is known to have been upstream's tip
  ahead: number | null, behind: number | null,
  problem: string | null,               // operator words, when state !== 'established'
  paths: { [path]: { upstream: 'equal' | 'different' | 'absent' | 'unknown',
                     upstreamChanged: boolean | null,   // blob at merge-base != blob at refSha
                     localLines, upstreamLines } }
}
```

- **`established`** means the refresh succeeded. **`stale`** means a ref exists but was not refreshed this wrap.
  **`unavailable`** means no ref could be resolved.
- `session-files` computes the object, including the refresh, and returns it in `output.provenance`.
- `commit` and `changelog-coverage` **do not refetch**. `commit` takes `refSha` from the session-files result in
  `previousResults` and recomputes the local-side blobs against that same commit. `changelog-coverage` is
  synchronous and only counts work, so it reuses session-files' verdicts (`provenanceVerdicts`) instead of
  rechecking. A file a later wrap step rewrites is still decided by `commit`; at worst the changelog check
  under-counts it. This was accepted in the Critic disposition. All three therefore
  classify against one upstream commit. When no session-files result exists, as in a commit-only replay, the
  commit step resolves the ref locally with no refresh and marks it `stale`.
- Every git call is read-only plumbing: `rev-parse`, `hash-object`, `cat-file`, `merge-base`,
  `rev-list --left-right --count` and `ls-tree`. One `ls-tree -r <refSha>` produces the whole upstream blob map,
  and one `hash-object --stdin-paths` hashes all local files, so the cost does not grow per path.
- `classify(scope, dirty, { provenance, … })` applies the rules below. Callers never re-derive facts.

### A3: Changed provenance at the final boundary

**Recommend block and re-ask, with the client pruning the stale answer.** Refuse only where there is nothing to
ask.

- `commit` compares each path's recomputed fact with the fact `session-files` reported. When a path with an
  Include has tightened, the commit step **blocks**, lists the path with the new fact and "changed since you
  answered", and returns `provenanceChanged: [paths]`. Tightened means `absent`→`different`, or anything→`equal`.
- The drawer prunes answers for `provenanceChanged` paths, the way `pruneProtectedDecisions` already does for
  protected files, so the next Retry asks again rather than resending the old Include. Without that prune, the
  accumulated map would loop the block forever.
- An Include for a path that is `equal` upstream is **refused**, never staged. It goes to
  `provenanceRefusedIncludes` and is reported, like `refusedIncludes` for a DB. Committing it could only replay
  upstream's change.
- Nothing ever broadens. A path that loosens, such as `different`→`absent`, keeps its answer.

### A4: Operator-facing states and copy

- **Header**, above the path list and in the settled-row detail: "This checkout is **18 behind** and 0 ahead of
  origin/main (checked just now)."
- **Header variants:**
  - "…(as of the last fetch, 2 h ago; refreshing failed: <reason>)"
  - "Couldn't compare with upstream: <problem>. Files are kept local unless you choose Include."
- **Per path**, in the row's recommendation line:

| Fact | Recommendation | Copy |
|---|---|---|
| `equal` | none (not asked; see bucket) | Manifest group **Already upstream (not committed)**: "origin/main already has exactly this content; committing would only repeat a merged change." |
| `different`, untracked here | Keep local | "origin/main already tracks this path with different content (32 lines there, 0 here…). Committing would duplicate or overwrite merged work. Your file is kept as-is." |
| `different`, `upstreamChanged` | Keep local | "origin/main changed this file after your checkout (you're 18 behind). Committing from here risks reverting that change. Your file is kept as-is." |
| `absent` | the existing kind-based advice | the existing why, with "not on origin/main yet" added |
| `unknown` or unavailable | never Include; durable → Keep local | "Couldn't check upstream for this file (<reason>), so it isn't recommended for the commit." |

None of the copy names blobs, refs or worktrees beyond the branch name.

## Classification rules (brief contract 1 precedence)

These run in `classify` in this order:

1. methodology withheld
2. TC state
3. protected DB
4. secret (in `_secret-check`, unchanged)
5. **provenance**
6. TC maintenance / carriers
7. ownership (launch snapshot / mtime)
8. file kind advice

What the provenance rule does:

- **`equal`** for any path that survives 1–3, whether owned, maintenance or foreign, goes to the new bucket
  `alreadyUpstream`. It is never staged and never asked. It appears in `manifestOf` as `alreadyUpstream` and in
  `_detail`. This fixes `CLAUDE.md`.
- **`different`**, where the path is untracked locally or `upstreamChanged` is true, becomes foreign with the new
  reason `upstream-owns` **even if it would otherwise be owned**. It is asked with Keep local recommended. This
  fixes the plan file.
- **`unknown`**, or `state` of `stale`/`unavailable` together with an `absent` fact, changes nothing about
  ownership. Any `include` recommendation is downgraded to `leave` with the unavailable copy. Owned files still
  commit, so offline wrapping is not blocked (contract 4).
- **`absent`** leaves the current rules unchanged. A genuinely new plan keeps Include advice (the control test).

**Decisions made during the build** (within the R13 contract):

- `[DECISION: a path this branch's own commits changed since the fork (HEAD blob ≠ merge-base blob) is judged as
  the branch's own line of work.]`
  - Matching upstream there is the branch undoing its own change, so the verdict is `none`, not
    `already-upstream`.
  - When both sides changed it, the verdict is also `none`, not `upstream-owns`, because the branch's merge is
    where they meet.
  - Why: without this, a feature branch that reverts its own edit would have the revert silently left out, and
    every wrap on a long-running branch would ask about files main also touched.
  - `upstream-owns` stays for untracked paths and for paths the branch never touched.
- `[DECISION: a repository with no remote is state no-remote, with no per-path facts.]`
  - Nothing upstream can be duplicated there, so the existing advice stands.
  - It is distinct from `unavailable` (a remote that can't be read).

## Drawer (chunk 03)

- `pathDecisionWidget` passes through `provenance` (a header summary) and each path's `upstream` and
  `upstreamWhy`.
- `normalizeManifest` / `projectManifest` / `renderManifest` gain the `alreadyUpstream` group.
- A `pruneProvenanceChangedDecisions` helper sits beside `pruneProtectedDecisions`.
- The header line lives inside the widget's `role="group"`, referenced from the group's `aria-describedby`.
- Radios are still never preselected. Apply fills only unanswered paths, as it does today.
- `test/wrap-drawer.test.js:813-836` pins the widget shape. It is extended, not relaxed.

## Tests (brief "Required tests")

These use real temporary repos: `test/_temp-repo.js` `initRepo(--bare)` + `cloneRepo`, and `wrapScope.resolve`
through the existing `scopeFor` pattern. The new `test/wrap-upstream-provenance.test.js` plus extensions to
`wrap-file-ownership`, `wrap-secret-check`, `wrap-step-commit-autopr` and `wrap-drawer`:

1. **Exact B2 incident:** clone at an old commit, upstream advances with a plan file and a `CLAUDE.md` change,
   and locally the plan is untracked with less content while `CLAUDE.md` equals upstream. Plan → `upstream-owns`
   with Keep local. `CLAUDE.md` → `alreadyUpstream`. Nothing staged.
2. A tracked local change equal to upstream: covers the owned, maintenance-judged and foreign paths. None is
   staged.
3. An untracked local file that upstream tracks with richer content: no Include advice, and the file is
   byte-unchanged afterwards.
4. Upstream absent, genuinely new durable document: Include advice is kept.
5. Unavailable (no remote / no ref / fetch fails / `ls-tree` fails): no Include advice anywhere. Leave → the
   step is `done` and the files are preserved.
6. Default branch `trunk` through `origin/HEAD`, a remote not named `origin`, a detached HEAD, and the
   worktree-scoped wrap.
7. Provenance tightening between session-files and commit, done by moving the recorded `refSha` fixture: the
   Include is blocked with `provenanceChanged`, and after the prune plus the re-answer it proceeds. An Include on
   `equal` is refused. Multi-hop: session-files → commit → retry.
8. Precedence: secret-flagged, protected-DB and methodology-withheld paths keep their current handling when
   upstream is `equal` or `different`.
9. Drawer: Apply produces a manifest matching the displayed advice (including `alreadyUpstream`), with no
   implicit radio.
10. No mutation: across all of the above, `git status --porcelain`, the index, HEAD and file bytes are the same
    before and after. The only permitted change is one remote-tracking ref from the refresh.

## Docs

- `docs/configuration-reference.md`: `wrapUpstreamRefresh` and `TC_WRAP_UPSTREAM_REFRESH`.
- The wrap docs section on file decisions.
- CHANGELOG `### Fixed`.
