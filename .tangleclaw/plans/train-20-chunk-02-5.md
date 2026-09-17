---
artifact: build-plan
version: 1
scope: train-20-chunk-02-5
branch: fix/wrap-ends-session-1558
partition: serial — one lifecycle rule, one option traced through four hops, one banner; every edit sits on the same wrap path
governed_by: []
---

# Train 20 — Chunk 02.5: a wrap that finishes ends the session

**Issue:** #1558 (a wrap that commits nothing never ends the session, even when the session's work
merged by PR)
**Program plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/master-roadmap.md`
(Train 20 lists this as Chunk 02.5, between Chunk 02 and Chunk 03). Stranded-wraps program plan:
`/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-20-stranded-wraps-chunking.md`.
**Depends on:** nothing unmerged. Builds on `main` at `7728254d`.
**Branch:** `fix/wrap-ends-session-1558`
**Worktree:** `.claude/worktrees/wrap-ends-session-1558`. This chunk edits `public/`, and the primary
clone is the live install.
**Critic mode:** cumulative (Type: cumulative-final — one chunk, one PR)
**Critic:** cumulative `rev-20260917T031850Z-49597a14` (1 blocking, fixed in `4945dc47`; notes accepted), verify-resolutions clean.
**Visual change:** yes (a checkbox in both wrap dialogs, the finished-drawer banner)
**Size:** medium (a lifecycle contract change, one option across four hops, one result field, docs)
**Authorized:** operator "build #1558" and "Yes, let's do it." in the Builder pane, 2026-09-16. The
design comes from the issue body. Plan approved 2026-09-16 ("That all seems reasonable. Let's build
the plan in a work tree.").

---

## Confidence check

**Problem.** Today the server ends a session after a wrap only when `ok && commitSha`
(`lib/sessions.js`, `_runClaimedWrap`). In this project the session's work merges by PR before the
wrap, and the wrap's own writes sit under `.tangleclaw/`, which this clone ignores. So a full wrap
reports `no changes to commit` and the session stays open. On 2026-09-17 that happened twice in a row.

**Success.**
1. A wrap whose pipeline finishes `ok` ends the session, with or without a commit. The session is
   recorded as `wrapped`, tmux is killed, and doc locks are released, exactly as on the commit path.
2. A run that stops (`needs-operator` or blocked), fails, or throws leaves the session open.
3. Both wrap dialogs (session page and dashboard) have a "Keep the session running" checkbox, off by
   default. When ticked, a finished wrap records everything and leaves the session open. The choice
   goes dialog → options → POST → server. It is replayed on every Retry and survives a page reload.
4. The finished drawer says what happened when nothing was committed, and says whether the session
   ended or was kept.

**Out of scope.**
- A "Kill session?" pop-up (the operator rejected it in the issue).
- Changing when the commit step commits, or making `.tangleclaw/` writes committable.
- The legacy `completeWrap` / wrap-idle path. It already ends the session.
- Session-state wording on the *committed* banners. They already say what shipped, and the page's own
  ended bar shows the session state. `[ASSUMPTION: the issue's item 4 is about the no-commit banner |
  LOW impact | operator can ask for "session kept running" on every banner]`

**Requirements confidence: HIGH.** The issue states the rule, the checkbox, its default and where it
travels. D3's field and D4's wording are mine and can be vetoed.

---

## Found when checking the plan against the code

- **The rule is one condition** in `_runClaimedWrap`: `if (pipelineResult.ok && pipelineResult.commitSha)`.
  `_completePipelineWrap` does the teardown, and it already copes with a session that ended mid-wrap
  (it reports `lifecycleCompleted: false`).
- **ADR 0002 records the old rule** ("Halted / thrown / clean-session paths leave the session active
  per spec", Chunk 11a). This chunk changes that decision, so the ADR gets a dated amendment rather
  than a silent edit.
- **The session page already handles a wrap that ends the session.** A committed wrap ends the
  session today, and the status poll's `data.active === false` branch calls `handleSessionEnded`. Its
  redirect countdown is held while the drawer is open (#268). A no-commit wrap will take the same
  path, so no new end-of-session UI is needed. The scratch run checks this.
- **The dashboard has no drawer.** Its `confirmWrap` waits for the run to settle, closes the modal and
  reloads the project list. An ended session shows as ended on its card, and the card offers Launch.
- **Wrap choices already have one collector.** `collectOptionsFromAccessors` in
  `public/wrap-drawer.js` builds the first wrap's options and every Retry's, and
  `replayChoicesFromOptions` restores them after a reload from the run's recorded `options`. The
  dashboard builds its body by hand.
- **The server passes `options` through unchecked**, except `proceedPastStranded`, which
  `lib/stranded-wraps.js` validates and refuses with `BAD_REQUEST`.
- **The HTTP result does not say whether the session ended.** `_wrapResultPayload` in `server.js`
  deliberately leaves out `lifecycleCompleted`. The drawer can't word the banner honestly without it.
- **Tests pin the old rule:** `test/sessions.test.js` "ok + null commitSha (clean session) → session
  stays active". Many other cases in that file stub the pipeline with `ok: true, commitSha: null` on a
  shared fixture project. Under the new rule those runs end their session, so later cases that expect an
  active session may break. Each one is fixed by giving the case its own session or by passing
  `keepSessionRunning`, never by changing what it asserts.
- **No `tc` wrap verb exists** (`lib/tc-verbs.js`), so the only callers are the two pages and the HTTP
  route.
- **Service worker:** `landing.js`, `session.js`, `wrap-drawer.js` and the CSS are network-first in
  `public/sw.js`. No `CACHE_NAME` bump.

---

## Decisions

**D1: the lifecycle rule becomes "a finished run ends the session unless the operator kept it".**
In `_runClaimedWrap`: `if (pipelineResult.ok && !keepRunning) lifecycleCompleted = _completePipelineWrap(...)`.
A run is finished when the runner returns `ok: true`, which already means `blockedAt === null`.
Stopped, blocked, failed and thrown runs never reach that line.
- Ending on `ok` alone is the rule the operator asked for: a wrap records the session whether or not
  git had anything to take.
- `[DECISION: an ok run with no commit ends the session | this project ships work by PR before the
  wrap, and the wrap's own writes are gitignored here, so "no commit" is the normal shape of a full
  wrap, not a no-op | amends ADR 0002 Chunk 11a | operator can veto]`

**D2: the option is `options.keepSessionRunning`, honoured only as `true`.** Anything other than a
boolean is refused with 400 `BAD_REQUEST` before a run is claimed, so a string `"true"` fails loudly
rather than silently ending the session. `false` and a missing value both mean end the session.
- The choice is logged with the run (`Wrap pipeline ran` gains `sessionKept`) and kept in the run's
  recorded `options`, where the other choices already live.
- It is decided before the run, not after. A Retry replays it, and `replayChoicesFromOptions`
  restores it after a reload, so a stopped run that the operator retries keeps the choice they made.

**D3: the result says what happened to the session.** `_runClaimedWrap` adds `sessionKept: boolean`
beside `lifecycleCompleted`. `_wrapResultPayload` forwards one derived field,
`sessionOutcome: 'ended' | 'kept' | null`:
- `ended` when `lifecycleCompleted` is true,
- `kept` when the run finished, `keepSessionRunning` was honoured, and the session is still the
  active one (*added after review:* a session killed during a kept wrap is `null`, not `kept`),
- `null` otherwise: the run didn't finish, or the session had already ended (killed mid-wrap), where
  the page's own ended bar says what happened.
- The GET `/wrap/status` result and the stream's `run-done` both go through `_wrapResultPayload`, so
  they agree.
- `[DECISION: add sessionOutcome to the wrap result payload | the drawer can't say whether the session
  ended without it, and a boolean would claim "still open" for a session killed mid-wrap | operator
  can veto]`

**D4: the no-commit banner names what happened.** In `summarizePipelineStatus` (`public/wrap-drawer.js`),
an `ok` run with no commit and no warnings reads:
- label `Wrapped — nothing new to commit`,
- detail `Your work was already committed or merged, or there was nothing to add.` plus
  ` The session has ended.` (`ended`) or ` The session is still running, as you asked.` (`kept`).
  Nothing is added for `null`.
The warnings case keeps its existing label, which a test pins as operator-facing; the session phrase
is appended to its detail the same way. The issue's "your work had already merged" is not said as a
fact, because the server can't tell merged work from a session that did nothing.

**D5: both dialogs get the same checkbox.** Label: "Keep the session running". Hint: "Records
everything but leaves the session open. Use it to save state mid-session." Unticked on every open, like
the release and bump choices, so an earlier tick can't carry into a later wrap.
- Session page: read in `confirmWrap` into `wrapKeepRunning`, sent through
  `collectOptionsFromAccessors({keepSessionRunning: () => wrapKeepRunning, …})`, replayed by the Retry
  accessors, and restored by `adoptWrapRunChoices`.
- Dashboard: `confirmWrap` builds its body by hand, sending the option only when ticked, as the
  collector does. *Changed while building:* the plan said it would use the shared collector, but the
  dashboard doesn't load `wrap-drawer.js`, and loading the whole drawer module for one key wasn't
  worth it. A test pins that both choices are sent together.
- The collector sends `keepSessionRunning: true` only when ticked, and never sends `false`.

**D6: no new persisted format.** The option rides in the run registry's existing in-memory options
record. `sessionOutcome` is a response field, not stored anywhere.

---

### Chunk 02.5: a finished wrap ends the session
Type: cumulative-final

0. Create the worktree on `fix/wrap-ends-session-1558`. Symlink only the untracked `.prawduct/*`
   state back to the primary. Do not symlink `.tangleclaw/plans`, `change-log.md`, `backlog.md` or
   the artifacts directory.
1. Tests first, all on a temp store (`store._setBasePath`).
   - `test/sessions.test.js`, wrap lifecycle transition: **change** "ok + null commitSha → session
     stays active" to "→ session is wrapped, tmux killed, locks released" (a deliberate contract change,
     named in the PR). Add: ok + commit + `keepSessionRunning` → stays active, `sessionKept: true`;
     ok + no commit + keep → stays active; `needs-operator` halt → stays active; a non-boolean
     `keepSessionRunning` → `BAD_REQUEST` and no run claimed. The existing halted and thrown cases stay.
   - A multi-hop case: a stopped run started with `keepSessionRunning`, then a Retry replaying the
     recorded options, finishes and leaves the session open.
   - Route: 400 for a non-boolean; `sessionOutcome` is `ended`, `kept` and `null` in the matching cases,
     and is the same on `GET /wrap/status` and the stream's `run-done`.
   - `test/wrap-drawer.test.js`: the no-commit banner for each `sessionOutcome`; the collector sends
     `keepSessionRunning` only when true; `replayChoicesFromOptions` restores it and ignores a
     non-boolean.
   - Page wiring: the session-page first wrap and Retry both send the option; the dashboard body sends
     it; both checkboxes reset on open.
2. Implement the server rule, the validation, `sessionKept` and `sessionOutcome`.
3. Implement the UI: `public/session.html` + `public/session.js`, `public/index.html` +
   `public/landing.js`, `public/wrap-drawer.js`. Update the sandboxes of the frontend suites that lift
   page functions, if a lifted function gains a call.
4. Fix any existing case the new rule breaks without changing what it asserts. List each one in the
   verification record.
5. Deliberately break each rule once and confirm a test fails: the old `commitSha` condition, ending a
   stopped run, ignoring `keepSessionRunning`, accepting `"true"`, the collector dropping the option,
   Retry dropping it, the reload losing it, the checkbox not resetting, and `sessionOutcome` claiming
   `kept` for a killed session.
6. Docs: CHANGELOG `[Unreleased]` `### Changed` (the lifecycle rule) and `### Added` (the checkbox);
   the ADR 0002 amendment; `docs/configuration-reference.md` (the option, the 400, `sessionOutcome`);
   FEATURES.md. Move the shipped Chunk 02 plan to `.tangleclaw/plans/archive/`.
7. Verify on a scratch server (temp store, temp git repo, the pipeline stubbed where it needs git
   hosting), served by tailnet IP from a leased port:
   - a clean no-commit wrap ends the session and `sessionOutcome` is `ended`;
   - the same with the box ticked leaves the session open (`kept`);
   - a stopped run leaves it open, and a Retry keeps the choice;
   - a session wrapped right after launch ends, the dashboard card shows it ended, and Launch starts a
     new session.
   Then drive both dialogs and the drawer in Chrome on that server.
8. Add a `.prawduct/operator-verification.md` entry (remote browser, both themes, phone width).
9. `/prawduct:critic cumulative`, resolve the findings, open the PR with `Fixes #1558`. Tell the
   Coordinator at each step.

## Verification record (2026-09-16)

- **Suite:** full suite green (TAP run, 0 failures) on `bf2ae27d`; evidence ingested from the junit
  run of the same pass.
- **Existing tests that changed, and why:**
  - `test/sessions.test.js` "ok + null commitSha → session stays active" is now "→ wraps the session
    and runs full teardown". This is the deliberate contract change #1558 asks for.
  - `test/sessions.test.js` #583 single-flight case: the first wrap passes `keepSessionRunning`, so the
    "fresh wrap after completion" still has a session to wrap. The threading case sends the option in
    its user options (still asserted unchanged) and starts a new session before its third call, which
    otherwise found no session and passed on a stale capture. No assertion was loosened.
  - `test/wrap-drawer.test.js`: the no-commit banner's label is the reworded one.
  - `test/api-wrap-status.test.js`: the result payload's key list includes `sessionOutcome`.
  - `test/wrap-release-decision.test.js`: "takes back every choice a Retry replays" includes
    `keepSessionRunning`.
  - `test/stranded-wraps-ui.test.js`, `test/wrap-run-session-wiring.test.js`,
    `test/error-string-parity.test.js`: their sandboxes declare `wrapKeepRunning`, which the lifted
    functions now read. No assertion changed.
- **Deliberate breakages:** 15, each caught: the old commit condition, ending a stopped run, ignoring
  the option, accepting `"true"`, the collector dropping it, Retry dropping it, a reload losing it,
  replay accepting a non-true value, either dialog not resetting the box, the dashboard not sending it,
  `kept` claimed for a killed session, `kept` for a stopped run, the banner ignoring the outcome, and
  the drawer not being handed it.
- **Scratch server** (temporary store, tmux and the pipeline stubbed, tailnet IP, leased port): a clean
  wrap ended the session (`sessionOutcome: ended`, tmux killed); `"true"` answered 400; a kept wrap left
  it active (`kept`); a stopped run with the box ticked left it active (`null`), and its Retry finished
  `kept`; a wrapped project relaunched with a new session.
- **Chrome on this Mac, same server, dark theme:** both dialogs show the box and the new sentence; the
  kept and ended banners read as D4 says; the ended bar appeared with Wrap disabled and no redirect
  while the report was open; after a reload the page restored the choice and Retry kept the session;
  the dashboard dialog ended one session and kept another, and the box was unticked on reopen.
  The automation window reports `document.hidden`, which pauses the page's status poll by design, so
  the ended state was driven with one direct poll.
- **Queued for the operator:** `VRF-1558-wrap-ends-session` (remote browser, both themes, phone width).

## Done when

- The suite is green (`prawduct-hook test-status`), confirmed with a TAP run.
- The scratch-server run shows the four behaviours in step 7.
- The cumulative Critic has zero blocking findings.
- A PR is open with `Fixes #1558`, it names the changed test contract, and the operator verification
  entry is queued.

## Status

- [x] Chunk 02.5: a finished wrap ends the session
