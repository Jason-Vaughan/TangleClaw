---
artifact: build-plan
version: 1
scope: train-20-chunk-04
branch: feat/session-health-cleanup-1544
partition: serial — both issues land on the same project-list payload, the same card detail panel and the same page-code test harnesses
governed_by: []
---

# Train 20 — Chunk 04: flag a session that ended leaving work behind, and a cleanup path for older stranded wraps

**Issues:** #1544 (flag a crashed or killed session that left work behind), #1545 (cleanup path for
grandfathered stranded wraps)
**Program plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-20-stranded-wraps-chunking.md`
(locked decisions 4, 5, 6 and 7 apply, and the Advisory's "no remote branch deletion").
**Depends on:** Chunks 01–03 (`lib/stranded-wraps.js`, `lib/stranded-check.js`, the card badge and detail
rows), all merged. Builds on `origin/main` at `c7a15460`.
**Branch:** `feat/session-health-cleanup-1544`
**Worktree:** `.claude/worktrees/session-health-cleanup-1544`. This chunk edits `public/` and `server.js`,
and the primary clone is the live install.
**Critic mode:** cumulative (Type: cumulative-final — one chunk, one PR; the last chunk of Train 20)
**Visual change:** yes (a session badge and "Last session" detail row on the card; per-item actions and a
confirmation dialog in the Stranded row)
**Size:** medium (a new module, one new persisted record, one new route, the project list, the card)
**Authorized:** operator "Start chunk 4. Let the coordinator know you're starting, and go." in the Builder
pane, 2026-09-16.

---

## Confidence check

**Problem.** (#1544) When a session is killed or crashes, nothing on the dashboard says whether it left
uncommitted or unpushed work in the project's checkout. The next session starts on top of it without
knowing. (#1545) Older stranded-wrap records (from before head SHAs were recorded) are listed but never
block, and the only thing the operator can do with one is acknowledge it. There is no way to act on it.

**Success.**
1. A project whose latest session ended `crashed` shows a badge. A project whose latest session ended
   `killed` shows a badge only when the checkout has changes that weren't dirty at launch, or commits
   made since launch that aren't on any remote. A clean killed session shows nothing.
2. The card's detail panel says what was found (counts, a few paths), that the work "may be from another
   session", and when the tree was read. When it can't tell (no launch baseline, git failed, the launch
   snapshot was incomplete), it says so rather than showing nothing or "clean".
3. The badge goes away on its own when the tree is clean again, or when a new session launches.
4. Each listed stranded wrap in the card has actions: **Acknowledge** and **Open PR**. Each opens an
   in-page confirmation. Opening a PR runs `gh pr create` for that branch and records who did it, when,
   and the PR URL. A failed `gh` call shows its reason and records nothing.
5. Deleting the remote branch is explained in the dialog (the command to run), never done.

**Out of scope.**
- Deleting remote branches (Advisory).
- Checking other worktrees of the project (locked decision 5: "other worktrees are ignored").
- Arming auto-merge on a PR opened from the cleanup path. The operator opens the PR; merging stays theirs.
- A prime-section line for the session badge. The issue asks for a badge.
  `[ASSUMPTION: the dashboard is enough for #1544; the prime does not need a "last session left work" line | LOW | operator can ask for one]`
- A fetch before counting unpushed commits. The count uses the local remote-tracking refs, and the text
  says so.

**Requirements confidence: MEDIUM.** The issues fix what triggers the badge and what the cleanup actions
are. D2's "crashed always shows" and D6's "actions on every listed item, not only grandfathered ones" are
my reading and can be vetoed.

---

## Found when checking the plan against the code (2026-09-16)

- **The launch baseline is on the session row** (`sessions.launch_sha`, `launch_toplevel`,
  `launch_dirty`), read through `store.sessions.getLaunchBaseline(id)`. It is null for a non-repo project
  and for sessions launched before it existed. `launch_dirty` is null when the status read failed and
  `truncated` past 5000 paths; both mean "not a complete list".
- **The same status listing and parser** (`wrap-steps/_file-ownership.js` `statusArgs`/`parseStatus`)
  wrote `launch_dirty`, so comparing with anything else would call a pre-existing file new.
- **The project list is polled every ten seconds and must not block.** Git facts come from a scanner
  child (`facts.git`), which carries branch/dirty only: no paths, no SHAs. The new probe therefore runs
  off the event loop with `execFile`, and the list reads its cached answer.
- **`store.sessions.getLatest(projectId)`** gives the latest session of any status; `getActive` gives the
  live one.
- **The wrap opens PRs with `gh pr create --base <original> --head <branch> --title "Session wrap on
  <branch>" --body …`** (`wrap-steps/commit.js`). The original base branch is not recorded anywhere, so
  the cleanup path cannot know it. `gh pr create --repo R --head B` without `--base` targets the
  repository's default branch (gh 2.74.0 help).
- **`stranded-check.js` already has `repoOf`, the prompt-free exec wrapper and redacted reasons.** The
  PR action lives there. #1561 (one shared exec helper) is still open, so this chunk does not add a
  third copy of the wrapper: the session probe borrows `stranded-check`'s.

---

## Decisions

**D1: a new module, `lib/session-leftovers.js`, answers "did the last session leave work behind?"**
`read(project)` is synchronous and never spawns: it returns the cached answer for the project's latest
ended session (or null), and starts a background refresh when the answer is missing or older than 30
seconds. `refresh(project)` is the async probe, single-flight per project.
- Applies only when the project has **no active session** and its latest session is `killed` or
  `crashed`. Otherwise `read` returns null and nothing is probed.
- The probe runs in `project.path` (the project's own checkout):
  1. `git rev-parse --show-toplevel`. When it differs from the baseline's `launch_toplevel`, the
     baseline doesn't describe this tree → `unknown`.
  2. The same status listing as the baseline. New paths = current paths not in `launch_dirty`.
  3. `git rev-list --count <launch_sha>..HEAD --not --remotes` → commits made since launch that no
     remote-tracking ref has.
- Cache key: session id. A new launch changes the latest session, so the old answer is never served.

**D2: the answer's shape** (`project.sessionHealth` on the project list):
`{scope: 'session', sessionId, status: 'killed'|'crashed', endedAt, state, checkedAt, reason,
newPaths, newPathCount, unpushed, snapshotComplete}`.
- `state`: `left-work` (new paths or unpushed commits), `clean`, `unknown` (with `reason`), or
  `checking` (no answer yet).
- `newPaths` holds at most 5 paths; `newPathCount` is the total.
- `snapshotComplete: false` when `launch_dirty` was null or truncated: every dirty path counts as
  possibly new, and the text says some may predate the session.
- `[DECISION: a crashed session always shows the badge, whatever the tree says | a crash is itself news
  the next session should hear, and the plan's locked decision 5 lists it on its own | operator can veto:
  crashed follows the killed rule]`
- `[DECISION: a killed session with no launch baseline shows no badge, and the detail row says it can't
  tell | the badge means "work found"; an unknown on every pre-baseline project would be noise |
  operator can veto]`

**D3: the badge and the row.** Badge: `crashed` (red-ish) or `killed · work left` (amber), with a title
naming the counts. The detail panel gets a **Last session** row: what ended and when, what was found,
"may be from another session", and the time it was read. No timers: the row re-renders with the list
poll.

**D4: `openPr(project, request, by)` in `lib/stranded-check.js`** — the cleanup path's PR action.
- The request names a listed item `{branch, headSha, remote?}` and must carry `confirm: true`; anything
  else is a 400. The item must be in `list()` (404 otherwise).
- Reads first, all before writing: `git remote get-url origin` → `repoOf` (not GitHub → refuse with the
  reason); the item's `remote` must equal origin when it has one; `git ls-remote --heads origin <branch>`
  must show the branch (gone → refuse, "the branch is no longer on origin"); for an item with a head
  SHA, the remote head must still equal it (moved → refuse); `gh pr list --head=<branch> --state open`
  must show no open PR (one exists → refuse, naming its URL).
- Then `gh pr create --repo R --head <branch> --title "Session wrap on <branch>" --body <why>`. On
  success the PR URL is parsed from stdout; no URL → treated as failed-to-confirm, recorded nothing.
- A successful open records `wrap.strand_pr_opened` `{remote, branch, headSha, prUrl, by, at}` and
  confirms the write by reading it back. It does **not** clear or acknowledge the item: an open PR isn't
  a landed one, and the GitHub check clears it when it merges or goes green.
- `[DECISION: no --base | the original base isn't recorded; gh defaults to the repository's default
  branch, and the dialog says so | operator can veto: ask for a base]`
- Any refusal or failure → `{ok: false, code, error}` with a redacted reason, and no row. Codes (as
  built): `BAD_REQUEST`, `NOT_FOUND`, `IN_PROGRESS`, `NOT_GITHUB`, `REMOTE_MISMATCH`, `BRANCH_GONE`,
  `BRANCH_MOVED`, `PR_EXISTS`, `READ_FAILED`, `CREATE_FAILED`, `WRITE_FAILED`.

**D5: `list()` items gain `prOpened: {url, by, at} | null`** from the newest `wrap.strand_pr_opened` row
for the same key, so the card shows "PR opened" instead of offering the action twice.

**D6: the card's Stranded list gets per-item actions** (only in the card; the launch and wrap dialogs
keep their existing list). Every listed item shows **Acknowledge** (when unacknowledged) and **Open PR**
(when no PR was opened from here). Each opens one shared in-page dialog: what will happen, the item, and
for Open PR the target (the default branch) plus the manual branch-deletion command
`git push origin --delete <branch>` as the alternative. Confirm calls the route; a failure shows in the
dialog and nothing changes.
- `[DECISION: the actions apply to every listed item, not only grandfathered ones | the same "pushed,
  no PR" problem, and the route already refuses anything that isn't listed | operator can veto: older
  records only]`

**D7: the route.** `POST /api/projects/:project/stranded-wraps/open-pr` `{branch, headSha, remote?,
confirm: true}` → 201 `{ok, item, prUrl}`; 400/404 as above; 409 for `IN_PROGRESS`, `REMOTE_MISMATCH`, `PR_EXISTS`,
`BRANCH_GONE`, `BRANCH_MOVED`; 422 `NOT_GITHUB`; 502 `READ_FAILED`, `CREATE_FAILED`; 500 `WRITE_FAILED`
(with `prUrl`, because the PR does exist). `by` is the signed-in user or null,
never the body.

**D8: no schema change.** One new activity event type (`wrap.strand_pr_opened`). The session answer is
in memory only; it is re-derived from the tree, never stored.

## Decisions made while building (2026-09-16)

- `[DECISION: the session probe borrows stranded-check's exec wrapper, exported as `exec` | #1561 will
  unify the wrappers; a third copy would grow it | none]`
- `[DECISION: a second Open PR for the same branch while one runs is refused with IN_PROGRESS | gh would
  refuse a duplicate open PR anyway, but only after a network round trip | none]`
- `[DECISION: a timed-out gh pr create says the request may have reached GitHub | the wrap's own close-loop
  gives the same warning for the same reason | none]`
- `endedAt` is returned as ISO 8601 UTC (the store holds SQLite `datetime('now')` text).
- The card's action buttons name items by list position, so a branch name is never quoted into an
  `onclick` attribute.
- `tcStrandedItemsMarkup` shows "PR opened" wherever it is used (launch and wrap dialogs too), but only the
  card passes actions.
- A store error while reading the last session becomes `state: 'unknown'` with `status: null`, never
  `null` (which would read as "nothing to report").
- Scratch run: all of step 5 except a real crash/kill of an engine session and a real `gh pr create`
  against GitHub. Those are in `VRF-1544-session-left-work-and-stranded-cleanup`.

---

### Chunk 04: session left-work badge + stranded cleanup path
Type: cumulative-final

0. Worktree on `feat/session-health-cleanup-1544`. Archive the shipped `train-20-chunk-03.md` plan into
   `.tangleclaw/plans/archive/`.
1. Tests first, on temp stores, with git faked through `_internal.exec` (unit) and a real temp repo
   (one integration case each for the status comparison and the unpushed count):
   - `session-leftovers`: killed + clean → `clean`, no badge; killed + new path → `left-work`; a path
     dirty at launch is not new; unpushed commits since launch; crashed + clean → badge; no baseline →
     `unknown`; truncated/null snapshot → `snapshotComplete: false`; toplevel changed → `unknown`; git
     failure/timeout → `unknown` with reason; active session → null; wrapped latest → null; cache served
     without spawning; a new session id ignores the old answer; single-flight.
   - `openPr`: happy path records the row with `by`; `confirm` missing; not listed; not GitHub; remote
     mismatch; branch gone; branch moved; open PR exists; `gh pr create` fails or prints no URL → no
     row; write not saved → `WRITE_FAILED`; `prOpened` shows on the item; `--repo` pinned.
   - Route status codes and `by` from the session, not the body.
   - The project list carries `sessionHealth`; the badge and the Last session row run as real page
     code; the per-item actions and dialog run as real page code; the two hand-stubbed harnesses get the
     new helpers.
2. Implement.
3. Deliberately break each rule once and confirm a test fails.
4. Docs: CHANGELOG `[Unreleased]` `### Added`, FEATURES.md, the API reference (the route, the
   `sessionHealth` field, `prOpened`, the event type).
5. Verify on a scratch server (temp store, a real temp repo with a bare `origin`, a fake `gh` on PATH,
   tailnet IP, leased port): a killed session with new work shows the badge, clears when committed and
   pushed; a crashed one shows; open-PR success and failure through the dialog; Chrome, both themes,
   phone width.
6. Operator-verification entry for a real remote browser.
7. `/prawduct:critic cumulative`, resolve, PR with `Fixes #1544` and `Fixes #1545`. Tell the Coordinator
   at each step.

## Done when

- The suite is green (`prawduct-hook test-status`), confirmed with a TAP run.
- The scratch-server run shows each behaviour in step 5.
- The cumulative Critic has zero blocking findings.
- A PR is open with both `Fixes` lines, and the operator-verification entry is queued.

## Status

- [ ] Chunk 04: session left-work badge + stranded cleanup path
