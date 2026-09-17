---
artifact: build-plan
version: 1
scope: train-20-chunk-02
branch: feat/stranded-wraps-gate-1539
partition: serial — 02's three issues share lib/stranded-wraps.js, the launch/wrap routes and the drawer; Chunk 03 may run alongside in its own worktree (the only overlap is the route block in server.js)
governed_by: []
---

# Train 20 — Chunk 02: launch gate, new-wrap soft block, dashboard badge

**Issues:** #1539 (block launch on unacknowledged local stranded wraps), #1540 (soft-block a new wrap
while a stranded wrap is unresolved), #1541 (stranded badge on the dashboard)
**Program plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-20-stranded-wraps-chunking.md`
**Depends on:** Chunk 01 (PR #1547, merged `561e6879`): `lib/stranded-wraps.js` `list`, `acknowledge`, `isBlocking`.
**Branch:** `feat/stranded-wraps-gate-1539`
**Worktree:** `.claude/worktrees/stranded-wraps-gate-1539`. This chunk edits `public/` and `server.js`, and
the primary clone is the live install.
**Critic mode:** cumulative (Type: cumulative-final — one chunk, one PR)
**Visual change:** yes (the launch refusal dialog, the wrap soft-block, the card badge)
**Size:** medium (one module extension, two server refusals, three UI surfaces, docs)
**Authorized:** operator "Train 20 chunk 2 sounds good to me. Go." in the Builder pane, 2026-09-16.
Plan approved 2026-09-16 ("I like it"). D3 accepted for now, pending hands-on testing.

---

## Confidence check

**Problem.** Chunk 01 made stranded wraps visible to the agent at session start, but nothing stops a
session from launching, or a wrap from starting, on top of one. The operator is told only if the
agent passes it on.

**Success.**
1. Launching a project that has a blocking stranded wrap (unacknowledged and not grandfathered)
   answers 409 `STRANDED_WRAPS` with the blocking items, and nothing is written to the project first.
   The same request with `acknowledgeStranded: [{remote, branch, headSha}, …]` covering every blocking
   item records one acknowledgement per item (by the signed-in user) and launches. One round trip.
2. Starting a wrap while a blocking stranded wrap exists answers 409 `STRANDED_WRAPS` with the items,
   before any run is claimed. The same request with `options.proceedPastStranded` covering every
   blocking item starts the wrap. Both the dashboard and the session page show the items and ask for
   an explicit confirmation. No timers.
3. A project card with blocking stranded wraps shows a badge with the count. A card whose stranded
   items are all grandfathered or acknowledged shows none. The card's detail panel lists what the
   badge counts.
4. Grandfathered items never block and never count in the badge (locked decision 4).

**Out of scope.**
- GitHub checks, red CI, auto-clear (Chunk 03). A GitHub-derived finding never reaches this gate,
  because the gate reads only `isBlocking` over local records.
- Session-scoped facts on the session card, crashed/killed badge, grandfathered cleanup (Chunk 04).
- A session-page header badge. The session page shows stranded items in the wrap soft-block, which is
  where the operator acts on them there. `[ASSUMPTION: "project header" in #1541 means the dashboard
  project card | LOW impact | operator can ask for a session-page header badge too]`

**Requirements confidence: HIGH** for the launch gate (the issue and locked decisions 1, 2, 4 and 6
state it). **MEDIUM** for D3 (what confirming the wrap soft-block records). It is recorded below and
can be vetoed.

---

## Found when checking the plan against the code

- **`tc` has no launch verb.** `lib/tc-verbs.js` offers `whoami`, `capabilities`, `sessions`,
  `message`, `ports`, `docs`, `rules` and `learnings`. #1539's "`tc` launches get the 409" is met
  because every launch goes through `launchSession`. A future `tc launch` inherits the gate, and there
  is nothing to test today. The PR says this rather than claiming a `tc` test.
- **`launchSession` has exactly one caller**, `POST /api/sessions/:project` in `server.js`. The Master
  launches through `lib/master.js` and never reaches it, so locked decision 2's exemption holds by
  construction, as the program plan says.
- **No session roles exist in the code yet.** #1539's "the Steward IS gated" predates the multi-role
  work. The operator ruled on 2026-09-16 that it is a leftover and not part of this chunk: a Steward
  may come back as a role later. The chunk pins only what exists: the Master is exempt, and
  everything else is gated.
- **Every dashboard launch funnels through `doLaunchProject`** in `public/landing.js`. The continuity
  modal, the launch-mode picker and the create-project flow all end there. One refusal handler covers
  them all.
- **Wraps start from two places:** `confirmWrap` in `public/landing.js` (dashboard) and `postWrap` in
  `public/session.js` (session page, shared by first wrap and every Retry). The run registry replays
  a run's `options` on Retry (#1492).
- **Service worker:** `landing.js`, `ui.js`, `session.js`, `wrap-drawer.js`, `style.css` and
  `session.css` are all network-first in `public/sw.js`. No `CACHE_NAME` bump is needed, and none is
  made.

---

## Decisions

**D1: the gate lives in `launchSession`, before the launch writes anything.** It runs after the
refusals that change nothing (missing project, archived, already active, engine missing) and before the
OpenClaw branch, so web-UI launches are gated too. It runs before `launchBaseline.capture`, the heal,
the version record and the prime. A refused launch leaves the project untouched.
- The refusal travels as a value: `{code: 'STRANDED_WRAPS', items, error}`. The route maps the code to
  409 and adds `items` to the error body, the same way `WRAP_IN_PROGRESS` carries `runId`.
- Alternative considered: gating in the route. Rejected, because the issue asks for the server-side
  function so every present and future caller is covered.

**D2: acknowledge-and-continue writes real acknowledgements, then re-checks.** The request field is
`acknowledgeStranded: [{remote, branch, headSha}]`. Each entry goes through
`strandedWraps.acknowledge(project, entry, owner)`, the same function the ack route uses, so the key
rules, the 404 on an unknown item and the write read-back are the same. If any entry fails, the launch
is refused with that entry's code (400/404/500), and acknowledgements already written stay: each is a
real decision the operator made. Then the gate re-reads the list. If anything still blocks (an item
not covered, or one that appeared in between), the answer is 409 again with the current items.
- `remote` is sent as listed, so a branch of the same name on another remote can't be acknowledged by
  accident.

**D3: confirming the wrap soft-block does NOT acknowledge.** The wrap option is
`options.proceedPastStranded: [{remote, branch, headSha}]`. It lets this wrap start past the listed
items and records nothing about them. They stay unacknowledged, so they still block the next launch
and still show on the card.
- Why: acknowledging says "I have dealt with this". Wrapping anyway says "I know, finish this session
  first". The most likely moment for the soft block is a Retry right after this session's own wrap
  stranded. Turning that click into an acknowledgement would silently clear the launch gate for a branch
  nobody has looked at.
- The override is logged (`log.info`, with the keys) and kept in the run's recorded options, which is
  where the wrap run already keeps the operator's choices.
- It covers only the keys it lists. A Retry replays the options (#1492), so if the retried wrap strands
  a new branch, the new item is not covered and the soft block shows again.
- `[DECISION: wrap soft-block confirmation is a one-run override, not an acknowledgement | an
  acknowledgement is the audited "handled" record of locked decision 6, and a wrap confirmation is not
  that decision | operator can veto: make confirming the soft block write acknowledgements like the
  launch gate]`

**D4: the soft block is checked in `startWrap`, before the run is claimed.** It sits after the
existing refusals (no project, no active session) and before `wrapRunRegistry.begin`, so a refused wrap
claims nothing and the drawer's "a refused POST may still have a run" probe finds no run. The route
maps `STRANDED_WRAPS` to 409 with `items`. The `wrapDisabled` and password checks in the route stay
first.

**D5: one policy function decides who is gated.** `strandedWraps.gateAppliesTo({role})` returns false
for `role: 'master'` and true for anything else, including no role. `launchSession` and `startWrap`
call it with no role, because a project session has none today. The Master never calls either, so the
function exists to make the rule a stated, tested policy rather than a code path that happens to be
missing. When multi-role adds roles, each one is gated unless this function says otherwise.

**D6: one function answers "what blocks now".** `strandedWraps.blockingItems(project)` returns
`list(project).items.filter(isBlocking)`. Both gates and the project-list count use it, so all three
agree by construction. `strandedWraps.covers(items, keys)` returns the items the given keys do not cover
(matched on remote, branch and headSha), and both gates use it.

**D7: the project list carries a small count, not the items.** Each project in `GET /api/projects` gets
`stranded: {blocking, unacknowledged, grandfathered}`, or `stranded: null` with `strandedError` when the
read failed. A read failure never breaks the list. The card badge reads `blocking`. The detail panel
fetches `GET /api/projects/:project/stranded-wraps` when opened, for the items.
- Cost: three indexed-by-type activity queries per project, per list load, and the list is polled every
  10 seconds. *Measured while building:* 2.6 ms per list load for all 41 projects on a backup copy of the
  live store, so the count stays as three queries.

**D8: the refusal UI is one shared renderer.** A pure helper in `public/wrap-drawer.js`,
`renderStrandedItems(items)`, builds the list (branch, full SHA, recorded date, the API path) and is
used by the dashboard launch dialog, the dashboard wrap modal and the session-page wrap modal. It
returns HTML and is tested by running it.
- Launch: a modal lists the items, with one button "Acknowledge and launch". It sends the same launch
  body plus `acknowledgeStranded`. Cancel leaves everything as is.
- Wrap: the wrap modal shows the items and a checkbox "Wrap anyway; these stay flagged". The confirm
  button stays disabled until it is ticked. The option is added through
  `collectOptionsFromAccessors`, so the first wrap and every Retry shape it the same way (the Train 18
  lesson: trace it widget → collector → POST → server).
- Hidden states use `visibility`/`pointer-events` switched instantly; nothing is timed.

**D10: a store read failure lets the launch or wrap through, and says so.** *Added while building.*
Both gates catch a failed read of the records (including the read inside acknowledging), log a warning, and answer `ok` with `unchecked: <reason>`, which the launch's 201 and the wrap's 202 carry as `strandedUnchecked`.
The store that failed is the one every other launch and wrap step also needs, so refusing here would only
replace that failure's own error with a misleading "stranded wraps" one. The session prime already says
"could not be read" in the same case, and the project list reports `stranded: null` with the reason.
- `[DECISION: fail open on an unreadable store | a gate that fails closed on the store it shares with
  the rest of the launch adds no protection and hides the real error | operator can veto: refuse with
  the read error instead]`

**D11: a Retry refused for stranded wraps lists them in the drawer.** *Added while building.* The
session page's Retry goes through the same POST, so a Retry can be refused when the retried wrap
stranded a new branch. The drawer then shows the list with the same "Wrap anyway" box, and the next
Retry sends the whole list the server gave (it lists every blocking item, so nothing earlier is lost).

**D9: no new persisted format.** The gate writes only `wrap.strand_ack` rows, whose shape Chunk 01
fixed. The wrap override lives in the run registry's existing options record.

---

### Chunk 02: launch gate, wrap soft block, dashboard badge
Type: cumulative-final

0. In the worktree, symlink only the untracked `.prawduct/*` state back to the primary. Do not symlink
   `.tangleclaw/plans`, `change-log.md`, `backlog.md` or the artifacts directory as a whole.
1. Tests first. Every test uses a temp store (`store._setBasePath`), never the live one.
   - `test/stranded-wraps.test.js`: `blockingItems` (grandfathered and acknowledged excluded),
     `covers` (remote mismatch is not covered), `gateAppliesTo` (master false, no role true, any other
     role true).
   - The launch gate: a blocking item → `STRANDED_WRAPS` with the items, and no baseline, prime file or
     version file written. A grandfathered-only project launches. `acknowledgeStranded` covering all
     items launches and writes one ack per item with `by` = owner. A partial cover → 409 with the rest.
     An unknown key → 404 and no launch.
   - The route: 409 body carries `code` and `items`. The launch body's `acknowledgeStranded` reaches
     `launchSession`.
   - The wrap soft block: `startWrap` refuses before `begin` (no run in the registry). With
     `proceedPastStranded` covering the items, the run starts and no ack row is written. A key for a
     different head does not cover. The route answers 409 with `items`.
   - The project list: `stranded` counts per project, and `stranded: null` + `strandedError` when the
     read throws.
   - The UI helpers: `renderStrandedItems` escapes branch names and shows the full SHA.
     `collectOptionsFromAccessors` carries `proceedPastStranded` and drops it when the accessor
     returns nothing.
2. Implement `lib/stranded-wraps.js` (`blockingItems`, `covers`, `gateAppliesTo`), the gate in
   `launchSession`, the soft block in `startWrap`, the two route mappings, and the `stranded` count in
   `lib/projects.js`.
3. Implement the UI: the launch dialog (`public/landing.js`, `public/index.html`), the dashboard wrap
   modal, the session-page wrap modal (`public/session.js`, `public/session.html`), the card badge and
   detail row (`public/ui.js`, `public/style.css`), and the shared helper (`public/wrap-drawer.js`).
4. Deliberately break each rule once (the gate's position before writes, grandfathered exclusion, the
   remote match, the no-ack-on-wrap rule, the Retry replay of the override, the badge count) and
   confirm a test fails.
5. Docs: CHANGELOG `[Unreleased]` `### Added`, FEATURES.md, the API reference (the two 409 contracts,
   `acknowledgeStranded`, `proceedPastStranded`, the `stranded` project field). Move
   the Chunk 01 plan into the plans archive (now `.tangleclaw/plans/archive/train-20-chunk-01.md`; #868 and #1538 are closed).
6. Verify on a scratch server (temp store, temp repo, never the live install), served by tailnet IP:
   seed a stranded record, launch → 409, acknowledge-and-launch → 201; seed another, wrap → 409,
   wrap with the override → 202 and no ack row; list the projects and time it against a copy of the
   live store. Then drive the three UI surfaces in Chrome on that scratch server.
7. Add a `.prawduct/operator-verification.md` entry for the three surfaces on a real remote browser
   (MagicDNS URL).
8. `/prawduct:critic cumulative`, resolve the findings, PR with `Fixes #1539`, `Fixes #1540`,
   `Fixes #1541`. Tell the Coordinator at each step.

## Verification record (2026-09-16)

- **Suite:** full suite green (TAP run, 0 failures) on the implementation commit.
- **Existing tests that changed, and why:**
  - `test/sessions.test.js`: the Chunk 01 prime case recorded a stranded wrap on the shared fixture
    project and never settled it, so the new soft block refused every later wrap case there. The case
    now acknowledges its own record in a `finally`. No assertion changed.
  - `test/card-detail-disclosure.test.js`, `test/degraded-reads-frontend.test.js`,
    `test/error-string-parity.test.js`, `test/wrap-run-session-wiring.test.js`: their sandboxes list each
    function a lifted page function calls, so the new helpers were added to those lists. No assertion
    changed.
  - `test/wrap-release-decision.test.js`: "takes back every choice a Retry replays" now includes
    `proceedPastStranded`, because Retry now replays it.
  - `test/session-wrapper.test.js` pins that the session wrap modal re-enables Wrap in `finally`. The
    code keeps that line and then holds the button only while listed items are unconfirmed.
- **Deliberate breakages:** 13, each caught by a failing test: the gate moved after the launch writes,
  grandfathered items blocking, the remote ignored in key matching, wrapping anyway acknowledging, Retry
  dropping the confirmation, the badge counting the wrong number, a running wrap gated instead of
  followed, the launch route losing its 409, `postWrap` forgetting the items, the options collector
  dropping the choice, the launch acknowledgement losing its owner, the dashboard not sending the
  acknowledgements, and the project list losing its counts.

- **Scratch server** (temporary store and repos, tmux, engine detection and the wrap pipeline stubbed,
  served on the tailnet IP from a leased port): the project list gave the right counts for a blocking,
  a clean and an older-only project. A launch was refused with 409 and left the project with only its
  own files. The older-only and clean projects launched. A wrong head SHA answered 404, and a partial
  acknowledgement answered 409 with the rest. A wrap was refused with no run claimed, and wrapping past the
  item started a run that recorded the choice and left the item blocking.
- **Chrome on this Mac, same scratch server:** the badge and detail row, the launch-mode picker then
  the Stranded wraps dialog, and Acknowledge and launch opening the session. The session wrap modal held
  Wrap until the box was ticked, then started the wrap. A Retry refused for a new stranded wrap listed
  both items in the drawer, and ticking the box let the next Retry start. It found three gaps, all fixed in
  `466f6bbc`: acknowledged items were not marked in the list, a disabled dialog button looked enabled on
  both pages, and the refusal sentence shown to the operator named request fields.
- **Queued for the operator:** `VRF-1539-stranded-gates` (remote browser, both themes, phone width).
- **Not done:** `prawduct-hook verify-chunk-refs` reads `.prawduct/artifacts/build-plan.md`, and this repo
  keeps one file per plan, so that check could not run.

## Done when

- The suite is green (`prawduct-hook test-status`), confirmed with a TAP run.
- The scratch-server run shows the behaviour in step 6.
- The cumulative Critic has zero blocking findings.
- A PR is open with the three `Fixes` lines, and the operator verification entry is queued.

## Status

- [x] Chunk 02: launch gate, wrap soft block, dashboard badge
