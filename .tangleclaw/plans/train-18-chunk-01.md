# Train 18 — Chunk 01: the wrap-run controller, POST → 202, and one event vocabulary

**Issues:** #1312 (the frozen-on-Retry half only), #1228
**Branch:** `feat/train-18-chunk-1-wrap-state`
**Worktree:** `TC-a02` (touches `public/` and `server.js`, so it does not run in the live install)
**Critic mode:** cumulative
**Size:** large (server route contract + sessions + registry + three client files + a new client module)
**Train blueprint:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Coordinator/.tangleclaw/plans/train-18-blueprint.md` (Coordinator-owned; ratified 2026-09-14)
**Authorized:** operator "GO" in the Builder pane, 2026-09-14.

---

## Confidence check

**Problem.** The wrap POST blocks for the whole pipeline (minutes). Everything the drawer does is
built around that: the initial wrap discovers its own stream by probing `/wrap/status` beside the
POST, and a **Retry** opens no stream at all — so after Retry the drawer keeps showing the old red
"Blocked" report, with no progress, until the retry POST finally returns (#1312's frozen-drawer
comments). The run's state lives in six loosely-coupled globals (`wrapInFlight`,
`wrapWatchInFlight`, `currentWrapStream`, `currentWrapLive`, `sessionState.wrapping`,
`sessionState.wrapDrawerOpen`) and three overlapping flows (`attachWrapStream`, `startWrapStream`,
`watchWrapRun`). Separately, the stream's event names are spelled out in four places that agree only
by care (#1228).

**Success.**
1. `POST /api/sessions/:project/wrap` answers **202** the moment the run is claimed, with its
   `runId`. Refusals (503 disabled, 403 password, 404 no project/session, 409 in progress) stay
   synchronous with their existing codes.
2. Pressing **Retry** immediately resets the drawer: the red banner clears, every row returns to
   `pending`, the banner reads "Retrying — starting…", and the rows then move step by step as the
   new run streams.
3. The client follows a run through **one** controller: a pure reducer over explicit phases, with a
   single effect runner in `session.js`. Stream first; `/wrap/status` polling only when the stream is
   gone for good.
4. Reloading the page mid-wrap, or right after a block, restores the drawer for the run this tab was
   following.
5. The event vocabulary is declared once; adding a producer event with no client handler fails a
   test that does not carry its own copy of the list.

**Out of scope (other chunks, per the blueprint).** Launch baseline / session range / explicit
staging / worktree target (Chunk 2); the per-step sentinel (Chunk 3); the popover/bottom-sheet,
elapsed clock, collapsible/max-height drawer, and delegated-remediation rows (Chunk 4 — the rest of
#1312 and #1229). **#1321** (stale-run log line) was listed as optional for this chunk and is
**not** taken: it is a registry logging decision unrelated to the controller, and adding it would
widen the review surface of an already large chunk.

**Requirements confidence: HIGH** for 1, 2, 5 (stated by the blueprint and the #1312/#1228 text).
**MEDIUM** for 4: the blueprint says "page-load restore" without saying which runs; the inference
below (D6) is recorded as vetoable.

---

## Decisions

**D1 — 202 contract.** After the run is claimed the route answers
`202 {ok:true, runId, sessionId, project, status:'wrapping', statusUrl, streamUrl}`. The final
payload — `_wrapResultPayload`, unchanged — arrives on the stream's `run-done` and on
`GET /wrap/status`. A pipeline that throws or blocks is no longer an HTTP status on the POST; it is
the run's recorded result (`error` / `pipelineResult.blockedAt`). This is an HTTP contract change for
any external caller that relied on the POST returning the report; `api-contract.md` and
`configuration-reference.md` are updated in the same commit. `public/landing.js` treated any
truthy body as success, which would have lost the reason a failed wrap used to show there as the
POST's 500; its modal now waits on the run (`awaitDashboardWrapFailure`) — found by the Critic.

**D2 — split start from wait.** `sessions.startWrap(projectName, options)` validates, claims, fires
the pipeline and returns `{ok, runId, sessionId, done}` without awaiting. `triggerWrap` stays as the
in-process "start and await the outcome" API. Everything after `begin` moves inside the
try/finally that guarantees `finish` (today `recordVersion` and `resumableContentResults` run after
the claim but outside it — harmless while the POST awaited, a stranded slot plus an unhandled
rejection once nothing does). The detached promise gets a logged `.catch`.

**D3 — vocabulary.** `public/wrap-stream-events.js` (UMD, the `public/next-markdown.js` precedent
that `lib/plan-docs.js` already requires) declares the event names once. Producers
(`lib/wrap-pipeline.js`, `lib/wrap-run-registry.js`) use the constants; the drawer folds events
through a handler map keyed by type; `session.js` subscribes by iterating the declared list. The
vocabulary test asserts the handler map's keys equal the declared set and that no producer source
spells an event type as a literal. The file is network-first in `sw.js` (no `CACHE_NAME` bump), lockstep with
`wrap-drawer.js`.

**D4 — the controller.** `public/wrap-run-controller.js` exports a pure
`reduceWrapRun(state, signal)`. Phases: `idle`, `starting` (POST in flight), `following` (a run with
a live view; `transport: 'stream'|'poll'`), `settled` (a final result), `stalled`, `lost` (ran, then
vanished — restart), `refused` (POST refused, with its error). Signals: `start`, `accepted`,
`refused`, `follow`, `event`, `stream-lost`, `status`, `hide` (built: `in-progress` became `follow`,
and `dismiss` folded into `hide`). `session.js` holds one
state and one `dispatchWrapRun(signal)` that diffs old → new and runs the effects (open/close the
stream, start/stop the poll, paint the drawer). `attachWrapStream` and its discovery probe are
deleted — the POST now hands over the `runId`.

**D5 — Retry resets.** `accepted` from `settled` seeds the live view from the previous result's
steps, all `pending`, flagged `retry` so the banner says "Retrying". The stream's `run-start` then
replaces the rows with the new run's shape. Nothing is marked `running` until the server says so.

**D6 — page-load restore (vetoable inference).** A **running** run is followed on load (today's
behaviour). A **finished** run is restored only when this tab was following that exact `runId` and
the operator had not dismissed it — recorded in `sessionStorage` (per-tab, survives reload, wrapped
in try/catch; absent storage just means no restore). Without that bound, every page load would
re-open whatever the project's last blocked wrap was, including one dismissed an hour ago.

**D7 — hiding is not stopping.** Closing the drawer while a run is followed hides it and keeps
following; the final report re-opens it. Before, the blocking POST provided that guarantee; now the
controller must.

**D8 — fallback transport.** A stream that ends without `run-done` (CLOSED) switches the controller
to polling `/wrap/status` every 4 s through `wrap-run-controller.js#statusForRun` (which replaced `wrapWatchDecision`, keyed on `runId`
instead of clocks) until it renders, stalls
or reports lost. Required now: the POST no longer delivers a report behind a failed stream.

---

## Build steps

- **01a** — `public/wrap-stream-events.js` + producers use it + drawer handler map + session.js
  subscription loop + vocabulary test (#1228). SW precache/network-first.
- **01b** — `sessions.startWrap`, post-claim try/finally, `triggerWrap` as start+await; route → 202.
  Update server tests (`api-sessions`, `api-wrap-status`, `api-wrap-stream`, `api-system`) to the
  new contract and add: refusals stay synchronous; a throw after claim still settles the run; the
  detached promise never rejects.
- **01c** — `public/wrap-run-controller.js` reducer + behavioural tests (every phase × signal that
  matters, Retry seeding, stale/lost via status).
- **01d** — `session.js` rewired onto the controller: `confirmWrap`, `retryWrap`, the stream,
  the poll fallback, drawer hide/dismiss, page-load restore. Source pins rewritten for the new wiring
  (`wrap-run-reattach`, `wrap-stream-client`, `wrap-confirm-calls-defined` as needed).
- **01e** — docs: `api-contract.md`, `configuration-reference.md`, `FEATURES.md`, CHANGELOG
  `[Unreleased]`, `.prawduct/change-log.md`.
- **01f** — live check on a scratch server (tailnet IP): wrap → live rows; block → Retry → reset and
  rows move; reload mid-wrap restores.

## Done when

Suite green; the scratch-server check above observed; `/prawduct:critic cumulative` with no
unresolved blocking findings; PR opened; the Coordinator pinged with the PR link.

## Status

- [ ] 01a vocabulary
- [ ] 01b 202 contract
- [ ] 01c controller reducer
- [ ] 01d session.js wiring
- [ ] 01e docs
- [ ] 01f live check
