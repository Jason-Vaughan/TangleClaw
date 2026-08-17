---
artifact: build-plan
version: 2
scope: enrichproject-spawns-890
depends_on:
  - artifact: architecture
governed_by:
  - artifact: security-model
    dispositions:
      - "secure by default, opt-out not opt-in → inapplicable because no auth, ingress, or bind surface is touched"
last_validated: 2026-08-11
---

# Build Plan — enrichProject's per-project subprocess spawns (#890)

Closes the last two synchronous subprocess spawns on the `GET /api/projects` poll
path, left explicitly out of scope by #884 and recorded there rather than passed
over silently.

## Confidence Check

**What problem are we solving?** `listProjects` maps every registered project
through `enrichProject`, which calls `engines.detectEngine` (`execSync
'command -v <name>'`, 2000ms cap) and `tmux.hasSession` (`execSync 'tmux
has-session'`, 5000ms cap) synchronously on the event loop — so a dashboard poll
costs up to `N × 7000ms` of blocked event loop, and the bound is per call rather
than across the fleet.

**What does success look like?** A poll of an N-project fleet issues **at most one
`tmux` invocation and at most one probe per distinct engine target**, regardless of
N, and `enrichProject` issues **no synchronous spawn at all** — both of the issue's
Expected clauses. Asserted as spawn *counts* in tests, not as wall-clock.

**What's out of scope?**
- Routing this work through the scanner child (#884's mechanism). Neither call
  reads an operator-chosen path, which is what that child exists to survive; the
  issue calls this "the right shape for the wrong reason" and recommends against it.
- A wedged `tmux` server reporting every session as dead. That is today's behavior
  and it is preserved here unchanged — see Chunk 01's "Deliberately not done".
- #889's 54-site synchronous-read family sweep, and #895's git spawn collapse.

## Requirements Confidence

**Level:** High

**Why:** Both call sites are read and their failure modes traced; the invalidation
hooks the engine cache needs already exist and were checked rather than assumed
(`refreshDetectionPath` at `lib/engines.js:153`, `resetDetectionCache` at `:214`);
the acceptance criteria are counts a test can assert. The only judgment call is the
detection TTL, and it is one constant.

**Open assumptions:**

- [ASSUMPTION: a 60s detection TTL is the right staleness posture | LOW impact |
  user can override] — the dashboard polls every 10s, so 60s cuts probes to at most
  one per minute per distinct target while still letting an engine installed
  mid-session appear without the operator knowing the "Check again" button exists.
  A permanent cache would be cheaper and is what the issue's option (2) literally
  suggests, but it makes a newly-installed engine invisible until restart. One
  constant to change if the operator prefers that.

**[DECISION: cache and single-flight, rather than route through the scanner child |
the child is a filesystem sandbox with a path deadline; neither of these calls
touches a path the operator chose, so it would add a cross-process round trip to
work that needs deduplication, not isolation | follows the issue's own
recommendation (option 2)]**

## Status

- [x] Chunk 01: One tmux snapshot per list, not one probe per project
- [x] Chunk 02: Engine detection answered once, not once per project

Context: both chunks built 2026-08-11 on `fix/890-enrichproject-spawns` (worktree
`.claude/worktrees/enrich-spawns`). The invariant is **zero test failures at every
commit on this branch**, which is what matters and cannot go stale — an earlier
draft of this paragraph quoted a round count and a pass total, and both were wrong
within the hour. The Review history below is the roster; count it there. Re-derive the count with
`node --test 'test/*.test.js'` rather than trusting a figure quoted here — the
one that used to sit in this sentence was already wrong by two rounds of fixes.
Note the recorded evidence counts differently from the TAP summary (the JUnit
reporter counts cases, the TAP footer counts tests), so the two numbers are not
expected to match.

**Every guard on this branch was driven by its named mutation** — applied, watched
go red, restored, baseline re-confirmed green — and the mutation for each is
written into the test that carries it, under a "THE MUTATION THIS CATCHES"
comment. That is the durable roster; grep for that phrase rather than trusting a
tally here.

Two guards did not earn it on the first attempt, which is the reason the practice
is worth its cost: the single-flight guard passed as first written while the cache
still spawned once per project under `Promise.all`, and one fix turned out to have
NO guard at all — discovered because reverting it left the suite green. A
behaviour change whose own reversal leaves the suite green is untested.

**Measured on the live 33-project fleet, one `listProjects`:**

| | before | after |
|---|---|---|
| synchronous spawns on the event loop | **41** (33 `command -v` + 8 `tmux has-session`) | **0** |
| asynchronous spawns | 0 | 5 (4 distinct engines + 1 tmux) |

The enriched payload — engine availability and session state for all 33 projects
— is identical before and after, which is the half of the measurement that makes
the other half mean anything.

Review history:

- `cumulative` (`rev-…220334Z-b947eb10`, 3 reviewers): **1 blocking**, 9 warnings,
  9 notes. Blocking = launch gates reading the new detection cache. Four warnings
  were things the build had not caught: a failed SPAWN cached as the answer "not
  installed", an in-flight delete that could evict a newer probe, two silent
  timeout branches, and the cache policy written out twice.
- `verify-resolutions` (`rev-…221932Z-0dff9c58`): 15 of 19 verified fixed, **1 new
  blocking** — the previous round's JSDoc fix had orphaned a doc block onto the
  wrong function by inserting two helpers between it and its function. Plus a
  third gate (`engineReadiness`) still reading the cache.
- `verify-resolutions` (`rev-…223043Z-a36cfe67`): **0 blocking, 0 warnings, 0
  notes.** Five demoted observations; two ride the next commit, three accepted
  with reasons recorded in that commit's message.
- A fourth `verify-resolutions` covers the observations commit, so composed
  coverage spans merge-base → HEAD for the PR gate.

**Two of the three blocking findings on this branch were introduced by the fix for
the previous round's findings**, both by mechanically inserting code — invisible
in the hunk, obvious in the finished file. That is [[feedback_finding_fix_is_new_code]]
recurring, now confirmed across two issues.

The mutation discipline earned its keep twice beyond catching weak assertions:
the single-flight guard passed as first written while the cache still spawned N
times under `Promise.all`, and the `engineReadiness` fix shipped with NO guard at
all — discovered because reverting it left the suite green. A behavior change
whose own reversal leaves the suite green is untested.

Not yet done: the PR, which is the operator's call. #900 was filed for the
wedged-tmux misdiagnosis Chunk 01 deliberately preserved.

`Critic mode:` cumulative-final — two small chunks against one issue and one PR, so
the last chunk's review is the single `cumulative`.

## Scaffolding

### Project Initialization

Existing repo — no initialization. Node 22+, `node:test` and `node:sqlite` built in;
there is no `package.json` at the repo root.

### Dependencies

None added. `node:child_process`'s `execFile` (already used elsewhere in `lib/`) and
`lib/exec-timeout.js`'s `wasTimedOut` are the only new imports.

### Build & Test Configuration

`node --test 'test/*.test.js'` from the repo root, per `CONTRIBUTING.md`.

### Scaffold Verification

**Work in a git worktree, not this clone.** The launchd server runs `server.js` from
this working tree, so a `git checkout` here moves the on-disk SHA under the running
process. `git worktree add .claude/worktrees/enrich-spawns fix/890-enrichproject-spawns`,
then symlink the gitignored governance state back to the primary — every `.prawduct/*`
entry except the tracked `change-log.md`, plus `.tangleclaw/plans`. Symlink by explicit
name, not by glob: a glob misses `.handoff-notes.md` and `.session-reflected` when they
do not yet exist in the primary.

## Project Structure

```
lib/tmux.js       # session-name snapshot (new); hasSession stays exact and unchanged
lib/engines.js    # detection result cache, single-flight, async probe variant
lib/projects.js   # enrichProject consumes both; listProjects builds the snapshot once
```

### Module Boundaries

`lib/tmux.js` and `lib/engines.js` each own their own memoization; `lib/projects.js`
consumes answers and owns none of the caching. `enrichProject` gains a third
parameter for the per-list snapshot, matching the `facts` precedent already
documented in its JSDoc: an omitted argument makes the function do the work itself,
so a call site that forgets is slower and never silently wrong.

## Build Chunks

### Chunk 01: One tmux snapshot per list, not one probe per project

- **Description:** Replace N `tmux has-session` spawns per poll with one
  `tmux list-sessions`, resolved lazily and shared across the whole list.
- **Depends on:** none
- **Deliverables:**
  - `lib/tmux.js`: `createSessionNameSnapshot()` returning `{ get(): Promise<Set<string>> }`
    — a single-flight lazy loader that spawns at most once and never spawns if
    nobody asks. Backed by `execFile('tmux', ['list-sessions', '-F', '#{session_name}'])`:
    no shell, and one field rather than the `|`-joined format `listSessions()` uses,
    so a foreign session whose name contains `|` cannot mis-split into a name that
    collides with one of ours.
  - `lib/projects.js`: `enrichProject(project, facts, context)` resolves session
    liveness from `context.tmuxSessionNames` when supplied, and creates its own
    one-shot snapshot when not — same code path, no second branch to keep in step.
  - `lib/projects.js`: `listProjects` creates one snapshot and passes it to every
    `enrichProject` in the map.
  - `hasSession` is **not** touched. Its callers kill, adopt and type into sessions
    off its answer, and its JSDoc promises an exact live read; a cached answer there
    would be wrong in a way that destroys work.
- **Acceptance criteria:**
  - A `listProjects` over N projects that all have live sessions issues exactly
    **one** tmux invocation. Asserted by counting invocations, with N ≥ 3 so the
    count distinguishes "one" from "one per project".
  - A fleet where **no** project has an active or wrapping session issues **zero**
    tmux invocations — the lazy loader must not make the idle case more expensive
    than it is today.
  - `enrichProject` called with no `context` still answers correctly, issuing one
    invocation when a session needs testing and zero when none does.
  - Exact-name matching survives: a live `Foo-Bar` does not make a project whose
    session is `Foo` report active.
  - tmux not running → every session reads as not-live, unchanged from today.
  - **The mutation each guard must catch, applied and confirmed red before commit:**
    for the count guards, reverting `listProjects` to per-project `hasSession`; for
    the idle guard, making the snapshot eager; for the exact-match guard, swapping
    `set.has(name)` for a `startsWith` scan.
- **Deliberately not done:** a wedged `tmux` server currently makes `hasSession`
  return false for every name, so every session reads as dead — an unknown presented
  as a fact, the same species #891 removed from `git.getInfo`. The snapshot preserves
  that behavior exactly rather than changing two things at once. **File it as its own
  issue** during this chunk; rendering it is #885's surface.

### Chunk 02: Engine detection answered once, not once per project

- **Description:** Memoize detection results so N projects sharing an engine cost one
  probe, and give `enrichProject` an async variant so no probe runs on the event loop.
- **Depends on:** none (independent of Chunk 01; ordered only for review size)
- **Deliverables:**
  - `lib/engines.js`: a detection-result cache keyed on `strategy` + `target`, not on
    engine id — four profiles pointing at the same binary should cost one probe.
  - Single-flight: concurrent cold-cache callers await one in-flight probe. Without
    this the `Promise.all` in `listProjects` still spawns N times on a cold cache,
    which is the defect.
  - **A probe our own timeout killed is never cached.** Detected with
    `wasTimedOut(err)` from `lib/exec-timeout.js` — never `err.killed`, which
    `execSync` sets on `spawnSync`'s result and not on the error it throws, so that
    check compiles, reads correctly, and is dead (#891, #894). Caching a timeout
    would store "we could not look" as the finding "not installed".
  - A non-zero exit from `command -v` **is** an answer and is cached — under the same
    TTL, so an engine installed mid-session is picked up without a restart.
  - `DETECTION_TTL_MS = 60000`, with its reasoning inline: the poll is 10s, so this
    bounds probes at one per minute per target while keeping a mid-session install
    visible within a minute.
  - Invalidated by `resetDetectionCache()` **and by `refreshDetectionPath()`**. The
    second is load-bearing and was verified rather than assumed: `GET /api/engines?refresh=1`
    — the wizard's "Check again" — calls `refreshDetectionPath`, which does *not* call
    `resetDetectionCache` (`lib/engines.js:153-183`). Hooking only the latter would
    leave the one button whose entire purpose is "my engine IS installed" answering
    from the stale cache that hid it.
  - `detectEngineAsync(profile)` for `enrichProject`; sync `detectEngine` stays for
    the launch paths (`lib/sessions.js:169`, `lib/master.js:616`) and
    `listWithAvailability`. Both variants share one cache and one cache-policy
    helper, so a warm cache serves the sync caller with zero spawns and there is no
    second copy of the policy to fall out of step.
  - `_detectPath`'s `fs.existsSync` is cached on identical terms. No shipped profile
    uses the `path` strategy today (all four use `which`), but a uniform rule has no
    second case to forget.
- **Acceptance criteria:**
  - `listProjects` over N projects sharing one engine issues **one** probe on a cold
    cache and **zero** on a warm one.
  - Concurrent cold-cache callers issue one probe between them, not one each.
  - A probe that times out is not cached: the next call probes again.
  - `refreshDetectionPath()` and `resetDetectionCache()` each drop cached results —
    asserted by probing, clearing, and probing again with the count rising.
  - Sync and async variants return the same shape for the same profile, and each
    populates a cache the other reads.
  - `enrichProject` performs no synchronous spawn: asserted by stubbing `execSync`
    to throw and confirming an enrich still succeeds.
  - **The mutation each guard must catch:** dropping the single-flight (count goes to
    N); caching the timeout branch (the re-probe count stays flat); removing the
    `refreshDetectionPath` hook (the post-refresh count stays flat).

## Verification Strategy

Tests assert **spawn counts**, which is the claim — wall-clock on a healthy machine
would pass with the defect intact, since a warm `command -v` costs a few ms and the
defect is that it happens N times. Wall-clock before and after is recorded in the PR
as supporting evidence, not as the criterion.

Beyond tests: run the real server against the live fleet and count invocations across
a poll, because the count that matters is the one a real `listProjects` produces, not
the one a fixture produces.

## Artifacts To Update

- `lib/projects.js` `enrichProject` JSDoc — its "WHAT IS STILL SYNCHRONOUS HERE"
  paragraph documents exactly the two spawns this plan removes, and is wrong the
  moment Chunk 02 lands.
- `architecture.md` Scaling Model — `listProjects`' per-poll cost changes shape.
- `CHANGELOG.md` `[Unreleased]` → `### Fixed` (patch tier: no new surface, an
  existing path stops blocking).
