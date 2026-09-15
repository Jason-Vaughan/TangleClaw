# Train 18 — Chunk 04: the Wrap popover and delegated remediation

**Issues:** #1312 (the remainder: no feedback after "Ask the session to fix this"; the drawer too big to
see the terminal behind), #1229 (a resolution for a blocked `preflight` row)
**Branch:** `feat/train-18-chunk-4-wrap-popover`
**Worktree:** `TC-a02` (touches `public/`; the primary clone is the live install and serves `public/`
off disk)
**Critic mode:** cumulative
**Size:** large (a new server route + watcher, a registry field, the drawer's view-model, the session
page's markup/CSS/wiring, docs)
**Train blueprint:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/train-18-blueprint.md`
(Coordinator-owned) §4, §5
**Authorized:** operator "Go chunk 04" in the Builder pane, 2026-09-14.

---

## Confidence check

**Problem.**
1. *The drawer hides the terminal (#1312 comments).* `#wrapDrawer` is a modal bottom sheet up to 80vh
   with a 50% backdrop. When the operator hands a fix to the session, the sheet covers the pane where
   the AI is typing it, and the only way to see the terminal is to close the drawer.
2. *No feedback after a handback (#1312 body).* "Ask the session to fix this" posts to the generic
   `/command` route. Nothing watches for the session to finish, so the button reads "Sent — resolve it in
   the session, then Retry" indefinitely and the operator guesses when to press Retry.
3. *The Wrap button says nothing during a wrap.* It is disabled with the fixed label "Wrap"; step
   progress and time exist only inside the drawer, and a step that drags on looks the same as one that
   just started. Step events carry no timestamp, so no surface can show a step's elapsed time.
4. *A blocked `preflight` row is read-only (#1229).* `decisionWidgetForBlockedStep` has no `preflight`
   case: a halting preflight can only be fixed back in the session, then retried by hand.

**Success.**
1. The Wrap button opens a compact, non-modal popover under it (desktop) or a 60vh bottom sheet
   (phone ≤600px). No backdrop; the terminal stays visible and usable. The step list scrolls inside the
   popover. Closing it (×, Escape, or the Wrap button again) never stops the wrap.
2. While a run is live, the Wrap button reads `Wrapping 4/12 · 1:42` (current step ordinal, total, the
   current step's elapsed time) and toggles the popover. Past `SLOW_STEP_MS` it turns amber, gains a
   text marker (not colour alone), and the running row says "Taking long — check the terminal".
   After a blocked run it reads `Wrap blocked` and still toggles the popover.
3. "Ask the session to fix this" starts a server-side watch for a fresh completion marker. The row shows
   `Fixing in the session · 0:42`; when the session prints the marker the row and the Retry button light
   up as `Ready: Retry`. An engine that never prints it lights up after the Chunk 3 quiet fallback with a
   note saying so.
4. A blocked `preflight` row offers: the block text with Copy, "Ask the session to satisfy this"
   (the same handback), and — for a halting preflight only — a "Wrap anyway" checkbox that retries past
   it and records the override in the commit body.

**Out of scope.**
- Auto-Retry when a handback finishes (#1312 option 2). The operator presses Retry; the light is the cue.
- TangleClaw writing `.prawduct/.gates-waived` (#1229 "waive"). ADR 0011 item 3 stays: TangleClaw does
  not author prawduct's state (D6).
- The confirm modal (`openWrapModal`), the `#sessionWrapping` bar, the pipeline's step semantics, and the
  Chunk 3 completion signal inside a pipeline step.
- A cancel-wrap endpoint (none exists; Kill remains the way out).

**Requirements confidence: HIGH** for 1–3 (blueprint §4, #1312's operator comments quoted in the issue).
**MEDIUM** for 4's shape (#1229 asks for the seam decision first; D6 records it, vetoable).
**MEDIUM** for `SLOW_STEP_MS` = 120s (D3, vetoable).

---

## Decisions

**D1 — the popover is the same element, made non-modal.** `#wrapDrawer` keeps its id, children and
every render function; its role stays `dialog` but `aria-modal` goes, the `#wrapDrawerBackdrop` element
and its click wiring are removed, and the element anchors under the banner's Wrap button:
`position: fixed`, right-aligned to the button, `width: min(420px, calc(100vw - 32px))`,
`max-height: min(70vh, 560px)`, header and actions pinned, `#wrapStepList` `overflow-y: auto`. At
`max-width: 600px` (the banner's existing phone breakpoint) it is a full-width bottom sheet at `60vh`.
Reusing the element keeps every existing renderer, widget and test working; a second surface would fork
them.

Dismiss by ×, Escape (focus returns to the Wrap button) and the Wrap button's toggle. **No outside-click
dismiss**: the operator's reason for the change is to click into and read the terminal while the popover
is open, and an outside-click close is the #566 re-render hazard besides. Every close goes through the
controller's existing `hide` signal, which already never cancels a run. `aria-expanded` on the Wrap
button tracks the popover.

**D2 — the Wrap button is the run's surface.** A pure `wrapButtonView(run, live, nowMs)` in
`public/wrap-drawer.js` returns `{label, mode, slow, disabled, ariaLabel}`:
- idle / refused / completed → today's behaviour (`Wrap`, opens the confirm modal; disabled after a
  completed wrap or an ended session).
- starting → `Wrapping…`, toggles.
- following → `Wrapping N/M · m:ss` from the live state's current step; toggles.
- settled with a blocking result → `Wrap blocked`; toggles.
- stalled / lost → `Wrap: reconnecting…` / `Wrap: lost track`; toggles (the popover already explains).

`N/M` counts every step in `run-start` (the drawer's own denominator, not the ai-content prompt
ordinal). The click handler branches on `mode` (`confirm` vs `toggle`) instead of the button being
disabled mid-run.

**D3 — step timing is server time.** `wrap-run-registry#_append` stamps `at` (epoch ms, through
`_internal.now`) on every stored event, so a replayed event after a reload carries the time it happened,
not the time it was re-delivered. `get()` adds `currentStepStartedAt`. The client estimates clock skew as
the **minimum** of `clientReceivedAt - at` over received events (a replay's lag is large and never the
minimum; a live event's is latency plus skew), and elapsed is `clientNow - skew - at`. Pure, in
`wrap-drawer.js`, unit-tested.

The elapsed label needs a once-a-second repaint while a step is running or a handback is fixing. That is
**one `setInterval` that only rewrites text and the derived `slow` class** — it never opens, closes,
dismisses or changes controller state, and it is cleared whenever nothing is ticking. This is a
deliberate, bounded departure from the no-UI-timers rule, whose object is timer-driven *lifecycle*
(auto-dismiss, redirect); recorded here so the Critic can judge it. A guard test asserts the tick
callback calls no lifecycle function.

`SLOW_STEP_MS` = 120s: past the Chunk 3 quiet fallback (60s) and short of `MAX_WAIT_MS` (5min), so a
content step that is still inside its honest wait reads amber before it times out. Vetoable.

**D4 — delegated remediation is a server-watched handback.**
`POST /api/sessions/:project/wrap/handback` `{stepId, prompt}`:
- 409 unless the project's latest run is settled and `stepId` is its active blocker; 400 on an empty
  prompt or one over the existing 3800-char cap.
- Mints a nonce, appends `ai-content._completionInstruction(nonce)`, sends it through
  `sessions.injectCommand` (what `/command` uses), and returns **202** `{handbackId, handback, streamUrl}`.
- A new `lib/wrap-handback.js` watches the pane with Chunk 3's primitives (`readPaneTail`, `_markerSeen`,
  `QUIET_FALLBACK_MS`, `MAX_WAIT_MS`, `POLL_INTERVAL_MS`): `marker` → `ready`; an unchanged 80-line tail
  for the quiet window → `ready` with `completedVia: 'quiet'` and the same note wording; neither within
  `MAX_WAIT_MS` → `timed-out`; a throwing pane read → `failed` with the read's message.
- A replaced handback settles `superseded` (its stream ends); so does one whose run a new wrap replaced.
- *Amended in 04a:* no `unwatched` state. `injectCommand` refuses webui sessions outright, so a gateway
  session never reaches a watch — its refusal is the same as `/command`'s. And no password gate: the
  route replaces `/command` for the drawer, which has none, and sends a narrower thing.
- State lives on the registry's run entry (`run.handback = {handbackId, stepId, state, completedVia,
  completionNote, startedAt, finishedAt, error}`); `get()` returns it, so `GET /wrap/status` restores it
  after a reload. A new handback replaces the old one (its watcher stops on its next poll); a new wrap
  run (`begin`) drops it.
- `GET /api/sessions/:project/wrap/handback/stream/:handbackId` is SSE with `handback-start` then one
  terminal `handback-done {state, completedVia, completionNote, error}`, after which it closes. It is a
  separate stream because a finished run's `/wrap/stream` is contractually closed; reopening it would
  change Chunk 1's terminal-frame contract. Event names join `public/wrap-stream-events.js` and its
  vocabulary test.

Why the server watches rather than the client: only the server can read the pane, and the marker is the
completion signal that already works (Chunk 3's live check). The `/command` route stays as it is for its
other callers.

**D5 — row states for a handback.** `buildStepRow` gains `row.handback` from the run's handback:
- `working` → the row's detail reads `Fixing in the session · m:ss`; the handback button is disabled.
- `ready` → the row reads "The session says it's done" (or the quiet note); Retry gets the primary
  emphasis class and the label `Ready: Retry` (composed with `syncRetryLabel`'s "Skip & continue", which
  wins when a skip box is ticked).
- `timed-out` / `failed` → the reason, plus "Check the terminal, then Retry"; the handback button
  re-enables so the operator can send again.
Retry is **never** disabled by a handback state: the light is a cue, not a gate (commitment 2 — a
missing marker must degrade to a visible reason, not a stuck button).

**D6 — `preflight` resolution, and the seam (#1229).**
- **Waive: not built.** Writing `.prawduct/.gates-waived` from TangleClaw would be a second narrowing of
  ADR 0011 item 3; the operator keeps the waiver on prawduct's side (the remediation text says how).
- **Satisfy now: the handback.** A blocked `preflight` row becomes `agentResolvable`, so "Ask the session
  to satisfy this" sends the block text and remediation to the session's own agent. TangleClaw sends a
  prompt, exactly as for a content step; it does not invoke the Critic or any agent itself, so ADR 0011
  item 5 (agent invocation is Claude-only) is not engaged and the button works on any tmux engine.
- **Copy.** The row's "How to fix this" gets a Copy button for the block text + remediation.
- **Wrap anyway.** `decisionWidgetForBlockedStep` gains a `preflight` case for a *halting* block only
  (an advisory one already continued): a checkbox `skipPreflight`. The pipeline honours
  `options.skipPreflight` only when the resolved step declares `allowOverride: true` — the shipped
  pipeline spec gains it on `preflight` — reporting the step `skipped` with "operator chose to wrap
  anyway", recorded in the commit body the way `skipTests` is. `syncRetryLabel` reads it as a skip.

**D7 — Direction and ADR records.** `wrap-direction.md` Instances: #1312 (marker-watched handback with an
honest quiet fallback — commitment 2) and #1229 (no TangleClaw-authored waiver; override is a
recorded operator choice — commitment 3). ADR 0002's drawer section describes the popover, the button
states and the handback. ADR 0011 gains no amendment (D6 stays inside the seam).

---

## Build steps

- **04a — server.** Registry `at` + `currentStepStartedAt` + `handback` field; `lib/wrap-handback.js`
  watcher; the two routes; `skipPreflight` in the pipeline + preflight spec `allowOverride` + commit body
  line. Tests:
  - every stored event carries `at`; a replay keeps the original `at`;
  - handback: marker → `ready/marker`; static tail 60s → `ready/quiet` with the note; moving tail never
    quiet-finishes before `MAX_WAIT_MS` → `timed-out`; throwing read → `failed`; 
    a nonce from an earlier handback in the scrollback does not finish a new one; a second handback
    stops the first watcher; `begin` drops a stale handback;
  - route: 202 shape; 409 when the run is running / absent / the step is not the blocker; 400 on empty
    or oversized prompt; the injected text ends with the completion instruction; SSE delivers
    `handback-start` then `handback-done` and closes; a stream opened after the watch ended gets the
    terminal frame immediately;
  - `skipPreflight`: honoured with `allowOverride`, ignored without it, recorded in the commit body.
- **04b — view-model (`public/wrap-drawer.js`).** `wrapButtonView`, skew/elapsed helpers, `slow`,
  `row.handback` states, `preflight` in `decisionWidgetForBlockedStep` and `agentResolvable`, Retry
  emphasis. Pure unit tests over every controller phase and handback state, including the empty/no-steps
  and missing-`at` paths (a legacy event with no `at` shows no elapsed rather than `NaN`).
- **04c — session page.** Markup (drop the backdrop, `aria-expanded`, Copy button), CSS (popover,
  phone sheet, amber state with a non-colour marker, `prefers-reduced-motion`), `session.js` wiring
  (button branch, toggle, Escape + focus return, handback POST + stream + reload restore, the tick with
  its guard). Tests in the `wrap-run-session-wiring.test.js` vm style (run it, don't regex it, per
  #1037), a CSS guard that parses the popover rules (the #931 stray-comment class), and the existing
  `wrap-stream-sw-cache.test.js` staying green (no new files expected; no `CACHE_NAME` bump).
- **04d — docs.** ADR 0002 drawer section, `.prawduct/artifacts/api-contract.md`
  (two routes, `at`, status fields), `FEATURES.md` drawer line, `docs/user-guide.md` "Watching it run",
  `.prawduct/artifacts/interaction-design.md` (a wrap popover entry under §3.4), `wrap-direction.md`
  Instances, CHANGELOG `[Unreleased]` `### Changed` (popover, button) and `### Added` (handback watch,
  preflight resolution), `.prawduct/change-log.md`. Bookkeeping: archive `train-18-chunk-03.md`.
- **04e — live check.** A scratch server (tailnet IP, own `TANGLECLAW_HOME`, `store.init()`), a real
  Claude tmux session, a browser:
  - (1) desktop: the button counts steps and time while the popover is closed; the terminal is visible
    with the popover open; closing it does not stop the run;
  - (2) a blocked content step: "Ask the session to fix this" → row `Fixing…` → `Ready: Retry` on the
    marker → Retry resets the rows and completes;
  - (3) phone width (≤600px): the 60vh sheet scrolls its steps; operator on-device confirmation recorded
    as owed in `.prawduct/operator-verification.md` if not done by the operator;
  - (4) a project with `preflight.blocker: true` and an unmet gate: "Wrap anyway" retries past it and
    the commit body records it.

## Done when

Suite green; 04e observed (or its on-device item recorded as owed); `/prawduct:critic cumulative` with
no unresolved blocking findings; PR opened (`Fixes #1312`, `Fixes #1229`); the Coordinator pinged with
the PR link.

## Status

- [x] 04a server: timing, handback watch + routes, skipPreflight
- [ ] 04b view-model
- [ ] 04c session page
- [ ] 04d docs
- [ ] 04e live check
