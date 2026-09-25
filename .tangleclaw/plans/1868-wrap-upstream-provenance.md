---
branch: fix/1868-wrap-upstream-provenance
partition: serial. One new module plus its two callers (session-files, commit) and the drawer, all on one classification contract
---

# #1868: Wrap recommends duplicate commits for artifacts already merged upstream

*Pilot Car A2. The PM dispatched this on 2026-09-25. Planned on `main` @c859e894.*

## Status

- [x] Plan written
- [ ] Architect has ruled on A1 to A4. **STOP here** (dispatch boundary: Plan Written, because A1 to A4 need rulings)
- [ ] Chunk 01: `_upstream-provenance.js` (resolve the upstream ref, the ahead/behind counts and a per-path upstream fact) plus unit tests against real temporary git repos
- [ ] Chunk 02: wire provenance into `classify` (session-files and commit use the same facts), override recommendations, add the `alreadyUpstream` bucket, write the explanation text
- [ ] Chunk 03: drawer rendering of the provenance header and per-path upstream line. Docs and CHANGELOG
- [ ] Verify: focused tests, then the full suite on this checkout (**not** the main instance)
- [ ] Critic
- [ ] Draft PR opened. **STOP here** (pilot boundary)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling or updating the live checkout, no restarting the
live service, no tests on the main instance, no tag, publish or release, no deploy.

## Problem

The wrap decides what to recommend for each uncommitted path from **what kind of file it is**, and never
from **where it came from**:

- `lib/wrap-steps/_file-safety.js` `safetyOf()` classes `.tangleclaw/plans/**.md`, `priming/*.md` and
  `memories/*.md` as `durable` and returns `recommendation: 'include'`. The input is the path alone.
- `lib/wrap-steps/_file-ownership.js` `classify()` puts a path in `owned` (committed **without asking**)
  when its mtime is at or after launch. TangleClaw regenerates `CLAUDE.md` at every launch, so the carrier
  lands in `owned`, or in `tangleclawMaintenance` through `_tc-owned-paths.judge`, and gets staged.
- No code in `lib/wrap-steps/` reads `origin/*`. The ahead/behind counts that `lib/checkout-state.js`
  measures are never passed to the wrap.

In the incident, the session-root checkout was 18 behind after its worktree PR (#1866) merged. The wrap
offered Include on two paths:
- the plan, which was untracked locally but tracked upstream with more content
- `CLAUDE.md`, which was byte-identical to `origin/main`

Accepting would have committed stale duplicates. The operator could only work out that Leave was correct by
inspecting git manually.

## Confidence check

- **Problem:** the wrap recommends committing, or silently commits, paths whose content already landed
  upstream, or whose upstream copy is newer.
- **Success:** in the four scenarios of requirement 7, the drawer shows the checkout's behind/ahead state,
  says what upstream holds for each path, and never recommends Include (or auto-stages) a path that is
  already upstream, owned by a newer upstream copy, or unverifiable. Leave keeps the files, and the wrap
  continues.
- **Out of scope:** deleting, resetting, overwriting or cleaning any file. Pulling, rebasing or fast-forwarding
  the checkout. Changing the `durable`/`local`/`protected` taxonomy for paths that upstream does not have.

## Design

### New module `lib/wrap-steps/_upstream-provenance.js`

`resolve(toplevel, dirty, { exec, fetch })`, async. It returns:

```
{ state: 'established' | 'stale-ref' | 'unavailable',
  ref: 'origin/main' | null,          // origin/HEAD's target, else @{upstream}, else origin/main if it exists
  refreshed: boolean, refreshProblem: string|null,
  ahead: number|null, behind: number|null,
  problem: string|null,               // why state isn't 'established', in operator language
  paths: Map<path, { upstream: 'identical' | 'differs' | 'absent' | 'unknown',
                     upstreamMoved: boolean,   // blob at merge-base(HEAD, ref) != blob at ref
                     localLines, upstreamLines }> }
```

Per path, using only read-only plumbing (`rev-parse <ref>:<path>`, `hash-object <path>`,
`merge-base`, `rev-list --left-right --count`), batched where git allows:
- `identical`: the local file's blob equals the upstream blob.
- `differs`: upstream tracks the path with other content. `upstreamMoved` says whether upstream changed
  it after this checkout's merge-base.
- `absent`: upstream does not track the path.
- `unknown`: any git failure. It is never read as `absent`.

Deleted paths: `identical` when upstream also lacks the path, otherwise `differs`.

### Recommendation rules (in `classify`, after the safety class, before advice reaches the drawer)

| Upstream fact | Path state | Result |
|---|---|---|
| `identical` | any tracked or untracked non-protected path, including owned and TC maintenance | new bucket **`alreadyUpstream`**: never staged, never asked, named in the manifest and the row ("already on origin/main; no commit needed") |
| `differs` with `upstreamMoved`, or untracked locally while upstream tracks it | asked (foreign, reason `upstream-owns`) | **Leave** recommended; why = "origin/main already has this path (N lines there, M here) and changed it after your checkout; you are B behind, so committing would duplicate or revert merged work" |
| `absent` | unchanged | existing `_file-safety` recommendation |
| `unknown`, or provenance `unavailable` | unchanged bucket | an `include` recommendation is **downgraded to Leave**. Why = "couldn't confirm what upstream has: <problem>" |

Protected (DB) and TangleClaw state paths keep their current handling. Provenance never overrides a
withhold. A `leave` recommendation never becomes an automatic decision: the operator still answers, or
uses the existing "Apply recommendations".

### Callers

`session-files` and `commit` both call `resolve()` and pass `options.provenance` to `classify`, so the
commit step can't stage a path that session-files sorted out. `changelog-coverage`'s call gets it as well,
so its owned set agrees. The summary gains `provenance: { ref, state, ahead, behind, refreshed, problem }`,
and `_detail` states it ("checkout 18 behind origin/main · 2 already upstream, not committed").

### Drawer

`public/session.js` path-decision widget: a provenance header line above the list, and `recommendationWhy`
carries the per-path upstream sentence. `alreadyUpstream` gets its own line in the manifest.
`public/wrap-drawer.js` passes the new fields through.

### Tests (requirement 7)

Real temporary repos with a bare `origin`, extending `test/wrap-file-ownership.test.js` plus a new
`test/wrap-upstream-provenance.test.js`:
1. Stale session root after a merged worktree PR: the plan is untracked locally and tracked upstream with
   more lines, and the checkout is behind. Result: Leave recommended, never Include, and `upstreamMoved` true.
2. Exact match: `CLAUDE.md` is modified locally and byte-identical upstream. Result: `alreadyUpstream`, not
   staged, not asked, whether mtime-owned or maintenance-judged.
3. An untracked file that upstream tracks with richer content. Result: Leave, and the why names both line counts.
4. Upstream unavailable (no remote / ref missing / git error). Result: `state: 'unavailable'`, no Include
   recommendation anywhere, and the problem is shown.
5. Leave applied: the files are untouched on disk, the step returns `done`, and the commit step stages nothing
   already upstream (multi-hop: session-files → decisions → commit).
6. Control: a path upstream lacks keeps its existing `durable` → Include recommendation.

## Architecture questions for the Architect (need rulings before build)

**A1. May the wrap fetch?** Nothing in `lib/wrap-steps/` touches the network today. `lib/checkout-state.js`
is documented read-only, and only `lib/behind-origin.js` fetches (TangleClaw's own clone, opt-out
`behindOriginCheckEnabled` / `TC_BEHIND_ORIGIN_DISABLED`). Without a fetch, a PR merged minutes ago is
invisible to a stale remote-tracking ref.
- (a) No fetch. Use the local remote-tracking ref and state its age ("origin/main as of last fetch").
- (b) A bounded `git fetch --quiet origin <default-branch>` in session-files only. It updates remote-tracking
  refs only, with `GIT_TERMINAL_PROMPT=0` and batch ssh, the `NETWORK_TIMEOUT_MS` from `git-probe`, and honors
  the same opt-outs. On failure it falls back to the local ref with `state: 'stale-ref'`.
- (c) (b), but only when the ref's last fetch is older than N minutes.
- **Recommend (b).** It is non-destructive, and the incident class is exactly "just merged". The commit step
  reuses session-files' result and doesn't fetch again.

**A2. What does a stale ref prove?** With `stale-ref`, `identical` is still proof: upstream had this
content at least as recently as the ref. `differs` / `absent` are not proof.
- **Recommend:** `identical` → `alreadyUpstream` as normal. `absent` under `stale-ref` → the Include
  recommendation downgrades to Leave with an "upstream not refreshed" note (requirement 4).
- Alternative: treat `stale-ref` wholly as `unavailable`. That is stricter, but it would ask about every plan
  whenever the machine is offline.

**A3. Requirement 3 ("merged PR from a linked worktree") via git content, not GitHub/ledger lookup.**
- **Recommend:** detect it with blob comparison against upstream (`identical`, or `upstreamMoved`), with no
  `gh` API or wrap-ledger dependency. This catches the merged-PR case regardless of which worktree or PR
  landed it, and adds no network/auth failure mode.
- Alternative: also read the session's wrap ledger / `gh pr view` to name the PR in the explanation. It costs
  a GitHub dependency in the wrap path for a nicer sentence. It could be a follow-up.

**A4. Byte-identical paths: silent bucket or asked?**
- **Recommend:** a new `alreadyUpstream` bucket. It is never staged, never asked, and is listed by name with
  the reason. Committing it can only replay upstream's change onto a stale branch, and asking adds a click
  with one right answer.
- Alternative: ask with Leave recommended (reason `already-upstream`). That keeps operator agency, at the
  cost of the question the issue is trying to remove.
- Either way the file on disk is untouched.

## Out-of-band note

`.tangleclaw/plans/1861-durable-control-state.md` is still at the plans root, but #1861 is CLOSED (#1866
merged). Per the archive rule it belongs in `archive/`. It is not in this car's scope, so this is flagged to
the PM rather than done here.
