---
artifact: build-plan
version: 1
scope: train-20-chunk-03
branch: feat/stranded-github-check-1542
partition: serial — one new module feeds the list, the prime, the project list and the card; the two issues share every one of those files
governed_by: []
---

# Train 20 — Chunk 03: check stranded wraps against GitHub, and say when it couldn't

**Issues:** #1542 (check stranded wraps against GitHub after launch: red CI, no PR, auto-clear),
#1543 (record "GitHub unreachable" as its own state)
**Program plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-20-stranded-wraps-chunking.md`
(locked decisions 1, 3, 6 and 7 apply). Roadmap: the Coordinator's `master-roadmap.md`, Train 20 Chunk 03.
**Depends on:** Chunk 01 (`lib/stranded-wraps.js` `list`, `acknowledge`, `isBlocking`, `primeLines`)
and Chunk 02 (`counts`, the card badge, `strandedSummary`), both merged. Builds on `main` at `f3eabe51`.
**Branch:** `feat/stranded-github-check-1542`
**Worktree:** `.claude/worktrees/stranded-github-check-1542`. This chunk edits `public/` and `server.js`,
and the primary clone is the live install.
**Critic mode:** cumulative (Type: cumulative-final — one chunk, one PR)
**Visual change:** yes (a GitHub badge and detail rows on the project card, a "Check now" control)
**Size:** medium, close to large (a new module, two persisted formats, one new route, the prime, the card)
**Authorized:** operator "write the build plan - go but i want to clear or ui wrap before you actually
build it." in the Builder pane, 2026-09-16. **The plan is approved for writing only. Building waits for a
fresh session after the operator clears or wraps, and for the operator's go on this plan.**

---

## Confidence check

**Problem.** Chunks 01 and 02 know only what this machine recorded: a wrap branch pushed with no PR.
They can't tell that the branch has since been merged or deleted, so a dealt-with item keeps holding the
launch until someone acknowledges it by hand. They also can't see a wrap PR whose CI went red, or a
`wrap/*` branch on the remote that this machine never recorded. When GitHub can't be reached, nothing
says so.

**Success.**
1. After a launch, without delaying it, TangleClaw checks the project's stranded items and its `wrap/*`
   branches and PRs on GitHub.
2. A local item whose branch has a merged PR, is gone from the remote, or has an open PR with every
   check passed is **cleared**: it leaves the list, stops holding the launch, and the clear is recorded
   with the reason and the time.
3. A `wrap/*` PR that is open with a failed check shows a **red-CI** finding. A `wrap/*` branch on the
   remote with no PR that this machine has no record of shows a **no-PR** finding. Findings show on the
   card and in the prime and **never block** anything (locked decision 1).
4. Every check attempt is recorded as `wrap.strand_check`, successful or not. The prime and the card say
   when the last successful check ran, and when the latest check failed they say "couldn't check at T
   (reason)" rather than showing older results as current (locked decision 3).
5. `gh` or `git` missing, not signed in, offline or timing out are all recorded as a failed check with a
   reason. None of them clears anything or reports "no findings".

**Out of scope.**
- Deleting remote branches, or opening PRs for stranded branches (Chunk 04's cleanup path).
- The crashed/killed session badge (Chunk 04).
- Checking remotes other than `origin`, or non-GitHub remotes. Those record a failed check with the
  reason "not a GitHub remote".
- A background poller. Checks run after a launch and on the operator's request only.
  `[ASSUMPTION: "after launch" plus a manual "Check now" is enough; no timer-driven rechecks | LOW |
  operator can ask for a periodic check]`

**Requirements confidence: MEDIUM.** The issues fix the triggers, the outcomes and the offline record.
D2 (what counts as "cleared") and D4 (the findings shape) are my reading of #1542 and can be vetoed.
D6's "Check now" goes slightly past the issue's text.

---

## Found when checking the plan against the code (2026-09-16)

- **The local list holds only "pushed, no PR".** `wrap.stranded` is written only when no PR was opened
  (`lib/wrap-steps/commit.js`). A wrap PR whose CI later went red has a PR, so it is never in the list.
  #1542's red-CI badge therefore needs a second source, GitHub itself, and those findings sit beside
  the list rather than in it.
- **`lib/wrap-pr-status.js` classifies one PR** (`merged | pending | blocked | unknown`) from
  `gh pr view --json state,mergeStateStatus,url,number,statusCheckRollup`. `pending` covers both
  "checks running" and "every check passed but not merged". #1542 clears on green CI, so this chunk adds
  an "all checks passed" test next to `hasFailingCheck`, reusing its rollup reading.
- **`lib/ci-status.js` and `lib/gh-issue-state.js` already set the pattern:** spawn off the event loop,
  cache only definite answers, answer `unknown` with a reason when the probe could not run, redact
  remote output. The new module follows it.
- **`activity_log` keeps 500 rows per event type across all projects** (`ACTIVITY_LOG_RETENTION`). A
  check row per launch across every project would age out in weeks, so a project not launched for a
  while can lose its last check. D5 handles that as "no check on record", said plainly.
- **Wrap branches are named `wrap/<ts>-<slug>`** (`commit.js`). On this repo today there are no
  `wrap/*` branches on origin and 24 merged `wrap/*` PRs. No project on this install has a stranded
  record. Tests and the scratch run have to seed both sides.
- **`gh pr list` takes `--head <branch>` and `--state all`** (gh 2.74.0 here). Whether `--search`
  can match a branch prefix is unverified. The build checks the real flags before relying on either.
- **The prime is written at launch, before the check runs.** So a session's prime can only show the
  *previous* check, with its time. That is what locked decision 3 asks for.
- **Every launch goes through `POST /api/sessions/:project`**, which calls `launchSession` and answers
  201. The check is started there, after the launch succeeds and without being awaited.

---

## Decisions

**D1: a new module, `lib/stranded-check.js`, owns every GitHub read for stranded wraps.**
`check(project)` is async and never throws. It reads the project's `origin` URL, the local list, and
GitHub. It returns `{ok, reason, at, remote, cleared, findings}`, and it records one `wrap.strand_check`
row and one `wrap.strand_cleared` row per cleared item.
- Two reads per check, run through `execFile` with a timeout: `git ls-remote --heads origin
  'refs/heads/wrap/*'` for which `wrap/*` branches exist, and `gh pr list --state all --json
  number,state,headRefName,headRefOid,url,mergeStateStatus,statusCheckRollup` filtered to `wrap/*`
  heads. A local item with no match in that list gets its own `gh pr list --head <branch> --state all`,
  with bounded concurrency, so an older PR beyond the list limit is still found.
- Single-flight per project: a second call while one runs joins it.
- Any read that fails makes the whole check `ok: false` with that reason, and nothing is cleared or
  reported from a partial read. `[DECISION: a partial read reports nothing | a branch missing from a
  failed ls-remote would read as deleted and clear an item that still exists | operator can veto]`

**D2: what clears a local item.** An item is cleared, at its recorded head, when the successful check
shows one of:
- `merged`: a PR for the branch has merged.
- `deleted`: the branch is not on `origin`, and no open PR has it as its head.
- `green`: an open PR for the branch has at least one check and every check completed successfully.

A clear is a `wrap.strand_cleared` row, `{remote, branch, headSha, reason, prUrl, at}`. `list()`
leaves out an item cleared at its head, the same way an acknowledgement is matched, so the same branch
stranded again at a new SHA is a new item. Grandfathered items (no remote or SHA) are matched and
cleared by branch name with `headSha: null`. That also clears most of the older records Chunk 04 would
otherwise have to handle.
- A PR that is open and not green does not clear the item. A local item keeps holding the launch until
  it is cleared or acknowledged.
- `[DECISION: "green CI" means every check completed with success and at least one exists | an open PR
  with no checks, or one still running, has not shown it will land | operator can veto]`
- `[DECISION: a clear is its own record, not an acknowledgement | an acknowledgement records a person's
  decision (locked decision 6); a clear records what GitHub showed, and the audit must tell them apart
  | operator can veto: write it as an acknowledgement by "github"]`

**D3: clearing may lift a launch hold; findings never add one.** The launch and wrap gates keep reading
`blockingItems(list(project))`. Since `list()` drops cleared items, a clear lifts the hold. GitHub-only
findings are never part of `list()` and never reach a gate.

**D4: findings are shown, not stored per item.** A finding is `{kind: 'red-ci' | 'no-pr', branch,
headSha, prUrl, prNumber}`, scope `repo`, always non-blocking.
- `red-ci`: an open `wrap/*` PR with a failed check (`hasFailingCheck`).
- `no-pr`: a `wrap/*` branch on origin with no PR at all, and no local stranded item for that branch
  (a recorded one is already listed).
- Findings are kept only inside the latest successful `wrap.strand_check` row, capped at 20 per row,
  with a total count.

**D5: `wrap.strand_check` answers the three questions #1543 lists.** Row detail:
`{remote, ok, reason, at, durationMs, checked, cleared, findings, findingsTotal}`.
- *When was the last successful check?* The newest `ok: true` row for the project.
- *Why did the latest check fail?* The newest row, when `ok: false`: `reason`, `at`.
- *Is what's shown current?* The card and prime show findings only from the newest `ok: true` row, with
  its `at`. When the newest row is a failure, they also say "couldn't check at T (reason)", so older
  results are never shown as current. With no row at all, they say "not checked yet".
- `remote` is stored without credentials. `reason` goes through `redactRemoteOutput`.
- One row per attempt. The 500-row cap is shared across projects, so a project's rows can age out. A
  project with none reads "not checked yet", which is true of what the store holds.
- `lib/stranded-check.js#status(project)` reads these rows into
  `{state: 'ok' | 'failed' | 'never', lastOkAt, lastAttemptAt, reason, findings, findingsTotal}`.

**D6: when a check runs.** After a successful launch, the launch route starts `check(project)` without
awaiting it and logs any failure. `POST /api/projects/:project/stranded-wraps/check` runs one on
request and answers with the result. A request made while a check is running joins it and gets that
check's result, so there is no "already running" refusal. `GET /api/projects/:project/stranded-wraps` adds `github: status(project)`.
- A launch-triggered check is skipped when a successful check for the project finished less than
  5 minutes earlier. A requested check always runs.
- `[DECISION: add "Check now" (POST …/check) | a failed check otherwise stays failed until the next
  launch, which is when the operator most wants to know | operator can veto: launch-only]`

**D7: the prime shows the last check in one or two lines** (`primeLines` takes a `github` status).
- `ok` with findings: "GitHub, as of T: N wrap PR(s) with failing checks, M wrap branch(es) with no PR"
  and the first few branches.
- `ok` with none: nothing (a clean line on every launch is noise).
- `failed`: "GitHub check: couldn't check at T (reason). Stranded status may be out of date."
- `never`: nothing when there are no local items, otherwise "GitHub check: not run yet".
- The same text on every engine; it stays inside the section's existing budget.

**D8: the card.** The project list's `stranded` gains `github: {state, lastOkAt, lastAttemptAt,
reason, redCi, noPr}` (counts only; the items come from the GET when the card opens). A second badge,
separate from the blocking one, shows `✕ N red CI` or `N no PR` when there are findings, and
`GitHub ?` when the latest check failed, with the time and reason in its title. The detail row lists the
findings with "as of T" and a **Check now** button. No timers: the button shows "Checking…" only while
its request is out.

**D9: no schema change.** Two new activity event types, `wrap.strand_check` and `wrap.strand_cleared`,
through the existing `store.activity.log`.

---

### Chunk 03: GitHub check, offline state, auto-clear
Type: cumulative-final

0. Worktree on `feat/stranded-github-check-1542`. Symlink only the untracked `.prawduct/*` state back
   to the primary. Move the shipped `train-20-chunk-02-5.md` plan into `.tangleclaw/plans/archive/`.
1. Check the real `gh pr list` flags and `git ls-remote` output shapes on this machine before writing
   the reader.
2. Tests first, on a temp store with `git` and `gh` faked through `_internal.exec`:
   - Clears: merged, deleted, green; not cleared for pending, no checks, red, or closed unmerged. A
     cleared item leaves `list()`, stops blocking the launch and wrap gates, and a new head on the same
     branch comes back. Grandfathered items clear by branch.
   - Findings: red CI on an open PR; a branch with no PR and no local record; neither ever reaches
     `blockingItems`.
   - Failures: `gh` missing, not signed in, a timeout, `ls-remote` failing, unparseable output, a
     non-GitHub remote. Each records `ok: false` with a reason, clears nothing and reports no findings.
     A partial read clears nothing.
   - `status()`: `ok`, `failed` after an earlier `ok` (the old findings are marked as of their time),
     and `never`.
   - Single-flight, the 5-minute launch skip, and "Check now" always running.
   - The launch route starts the check without waiting (the 201 comes back while a fake `gh` is still
     pending) and a check failure never changes the launch response.
   - The prime lines for each state, within budget. The project list's `github` counts. The card badge
     and detail row, run as real page code.
3. Implement `lib/stranded-check.js`, the `list()` change, the helper next to `hasFailingCheck`, the
   launch hook, the route, `primeLines`, `strandedSummary`, and the card.
4. Deliberately break each rule once and confirm a test fails.
5. Docs: CHANGELOG `[Unreleased]` `### Added`, FEATURES.md, the API reference (the check route, the
   `github` fields, the two event types), and the activity event list if one exists.
6. Verify on a scratch server (temp store, a bare git repo as `origin`, a fake `gh` on its PATH, tailnet
   IP, leased port): seed stranded items, launch, see them clear or stay; make `gh` fail and see
   "couldn't check"; then drive the card in Chrome, both themes.
7. Add an operator-verification entry for a real remote browser.
8. `/prawduct:critic cumulative`, resolve the findings, open the PR with `Fixes #1542` and `Fixes #1543`.
   Tell the Coordinator at each step.

## Done when

- The suite is green (`prawduct-hook test-status`), confirmed with a TAP run.
- The scratch-server run shows each behaviour in step 6.
- The cumulative Critic has zero blocking findings.
- A PR is open with both `Fixes` lines, and the operator-verification entry is queued.

## Status

- [ ] Chunk 03: GitHub check, offline state, auto-clear
