---
title: "#1637 Restart Session: a one-click relaunch on the ended bar after a completed wrap"
status: CHUNK 01 BUILT AND REVIEWED (2026-09-26). Chunk 02 waits for PM dispatch.
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-26, message fb7882f1 ("initialize the new Train on a fresh branch, create the plan, and begin Chunk 01").
issues: [1637]
governed_by:
  - Architect ruling R26 (brief: https://cursatory.tail123678.ts.net:8443/plans/81/1637-restart-session-architect-brief.md, local /Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/1637-restart-session-architect-brief.md), R26.1–R26.8
  - ADR 0002 (wrap pipeline contract), in particular the #1558 amendment (a finished wrap ends the session) and the #1586 amendment (the launch path is the second writer)
scope: 1637-restart-session
branch: feat/1637-restart-session
partition: serial. Chunk 02 wires what chunk 01 builds, and both are small.
critic_mode: a chunk review at chunk 01, and a cumulative review at chunk 02 (the boundary review before the PR)
collision_guard: Pilot-B1 owns #1245 (ttyd). This plan touches no ttyd surface. It shares public/session.js, session.html, session.css and sw.js with anyone editing the session page.
---

# #1637 Restart Session

## Requirements confidence: High

R26 answered placement, eligibility, the launch contract, continuity, gates, idempotence,
navigation and scope.

- **Problem:** after a wrap ends a session, relaunching the same project takes a trip back to the
  landing page, a click on the project and a pass through the launch dialogs. A context refresh is
  the most common reason to wrap, so this round trip is the common case.
- **Success:**
  - After a successful wrap has ended the session, the ended bar offers **Restart Session** beside
    **Back to Projects** and **Stay**.
  - One click issues exactly one `POST /api/sessions/:project` with `continuityMode: "continue"`
    and the project's default launch mode.
  - On `201` the page navigates to `/session/<name>?launched=1`.
  - Every refusal is shown by name and never bypassed.
- **Out of scope** (R26 boundary, R26.7):
  - assigning work, advancing a Train, or satisfying #1889;
  - emitting `READY_AFTER_CLEAR`;
  - any automatic or unattended restart (#1886);
  - acknowledging stranded wraps or tunnel conflicts on the session page;
  - any new backend route;
  - a launch-mode or engine picker on the session page.

## Discovery findings (verified at f7412296)

1. **The ended bar** is `#sessionEnded` (`public/session.html:212`). It holds "Back to Projects",
   `#stayBtn` and `#countdown`.
2. **Two painters reveal the bar.**
   - `handleWrapCompleted` (`public/session.js:6758`) shows it with no countdown. Its callers are
     the old `wrapCompleted` status flag, the wrap-idle modal's Return (which navigates away at
     once), and `finalizeFinishedWrap` (unreachable today, #1302). It receives no status payload.
   - `handleSessionEnded(statusData)` (`public/session.js:2315`) runs when a poll reads
     `active === false`, and starts a 10 s redirect to `/` unless the wrap drawer is open.
   - **A pipeline wrap that ends the session reaches the bar through `handleSessionEnded`**,
     because the server kills tmux and the next poll reads absence. So does any reload of a page
     whose session already wrapped.
3. **The eligibility evidence is `GET /api/sessions/:project/status`.** On established absence it
   answers `active: false` with `lastSession: {sessionId, status, endedAt, …}` (`lib/sessions.js:3222`).
   `status` is one of `active | wrapped | killed | crashed` (`lib/store.js:4939`). On unknown
   liveness it answers `active: null` with `incomplete: ['active']`. The route carries no wrap
   disposition field, so `lastSession.status === 'wrapped'` together with `active === false` is
   the durable "wrapped and ended" fact.
4. **The launch route** is `POST /api/sessions/:project` (`server.js:6337`).
   - Omitting `launchMode` makes the server apply the project's configured `defaultLaunchMode`
     (`lib/sessions.js:468`). Omitting `engineOverride` launches the project's engine. So R26.3's
     "project default" is exactly "send neither field".
   - `continuityMode` accepts `continue` or `fresh`.
   - Its refusal codes are:

     | Code | Status | Meaning |
     |---|---|---|
     | `CONTROL_STOPPED` / `CONTROL_HELD` | 423 | STOP control |
     | `CONTROL_STATE_UNAVAILABLE` | 503 | control state can't be read |
     | `LIVENESS_UNKNOWN` | 503 | tmux did not answer |
     | `STRANDED_WRAPS` | 409 | stranded wraps need acknowledging |
     | `CONFLICT` | 409 | a session is already active |
     | `TUNNEL_CONFLICT` | 409 | webui only |
     | `NOT_FOUND` | 404 | |
     | `BAD_REQUEST` | 400 | |
     | `ORPHANED_LAUNCH` / `LAUNCH_BIND_FAILED` | 500 | a pane may exist without a bound row |
     | `INTERNAL_ERROR` | 500 | |
     | `UNAUTHENTICATED` / `ACCOUNT_REQUIRED` | 401 | auth gate |
     | `CSRF_TOKEN_INVALID` | 403 | auth gate |

5. **`apiMutate` distinguishes the two failure kinds.** It returns `null` on failure. A
   structured refusal sets `api.lastErrorCode` and `api.lastBody`. A connection failure leaves
   `lastErrorCode` null and sets `lastError = 'Connection lost.'` (`public/api-helper.js:259-326`).
   It exposes no HTTP status and has no timeout.
6. **The landing page** navigates to `/session/<name>?launched=1` after a 201 (`landing.js:1755`).
   The session page turns `launched=1` into a three-poll grace (`session.js:7154`).
7. **Pure page logic lives in sibling modules.** `wrap-run-controller.js` is the model: an IIFE
   that exports to `module.exports` and `window`, tested in Node and loaded before `session.js`.
   It is listed network-first in `sw.js` so it stays in lockstep with `session.js`.
8. **Name clash:** `tcCreateRestartFlow` (`api-helper.js:1471`) is the server-restart flow. The
   new namespace is `tcSessionRelaunch`, and "restart" appears only in the operator-facing label.

## Design

### Module: `public/session-relaunch.js` (DOM-free, `window.tcSessionRelaunch`)

- `relaunchEligibility(status)` returns `{eligible, reason}`. It is eligible only when all of the
  following hold:
  - `status.active === false`, which is strict because `null` is unknown liveness;
  - `!status.wrapping` and `!status.untracked`;
  - `status.lastSession` is an object and `status.lastSession.status === 'wrapped'`.

  Everything else (no payload, active, null liveness, killed, crashed, no last session) is
  ineligible with a named reason. This is the one decision both painters consult.
- `relaunchRequestBody()` returns `{continuityMode: 'continue'}` and nothing else. No
  `launchMode`, `engineOverride`, `mode` or `acknowledgeStranded`.
- `classifyLaunchFailure(code)` sorts a failed POST into one of four classes:

  | Class | Codes | What the page does |
  |---|---|---|
  | `retryable` | `CONTROL_STOPPED`, `CONTROL_HELD`, `CONTROL_STATE_UNAVAILABLE`, `NOT_FOUND`, `BAD_REQUEST`, `UNAUTHENTICATED`, `ACCOUNT_REQUIRED`, `CSRF_TOKEN_INVALID` | Nothing launched. Show the server's reason and re-enable the button. |
  | `needs-landing` | `STRANDED_WRAPS`, `TUNNEL_CONFLICT` | These need a choice or acknowledgement this page doesn't offer. Show the reason, point to Back to Projects, and keep the button disabled. |
  | `liveness-unknown` | `LIVENESS_UNKNOWN` | Show the uncertainty and keep the button disabled. |
  | `uncertain` | `CONFLICT`, `ORPHANED_LAUNCH`, `LAUNCH_BIND_FAILED`, `INTERNAL_ERROR`, any unknown code, and `null` (connection lost) | The launch may or may not have happened, so reconcile through the status read. |

- `reconcileOutcome(status)` maps the reconcile read to an outcome:
  - `active === true` → `open-active`: navigate to the session, without `launched=1` because the
    session is already up.
  - `active === false` → `absent`: show the failure and permit an explicit retry.
  - anything else, including a failed read → `unknown`: keep the button disabled and show the
    uncertainty.
- `createRelaunchController({project, launch, readStatus, navigate, render})` returns `{activate, phase}`.
  `project` is required, since it builds both navigation URLs. `phase()` reads the current phase.
  - `activate()` latches **before** awaiting. Every call while latched, or after a terminal
    outcome, returns without a request, which is what makes "at most one POST per click" hold.
  - It never POSTs twice on its own; a retry only comes from a new explicit `activate()` after the
    controller has returned to `ready`.
  - `render(view)` receives `{label, disabled, message, tone, pointToLanding}` for the page to
    paint.

### Page wiring (chunk 02)

- `session.html`: a `#relaunchBtn` button, labelled "Restart Session" and hidden by default, goes
  before Stay. A `#relaunchStatus` `role="status" aria-live="polite"` span is added.
- `session.js`: one `applyRelaunchEligibility(status)` shows or hides the button.
  - `handleSessionEnded(statusData)` calls it.
  - **[DECISION]** When the status is eligible, `handleSessionEnded` does not start the 10 s
    redirect, exactly as `handleWrapCompleted` already doesn't. Without this, a pipeline wrap or a
    reload would offer the button and then navigate away from it, and R26.1 requires the two paths
    to converge.
  - `handleWrapCompleted` has no payload, so it performs one status read and applies the same
    decision. A failed read leaves the button hidden, which fails closed.
- `sw.js`: `/session-relaunch.js` is added to the network-first lockstep set and to the precache.
- **Carried from the chunk 01 Critic (R-5):** neither the controller nor `apiMutate` has a timeout,
  so a launch that never settles would leave the button on "Restarting…". Chunk 02 bounds the
  page's launch call with a timeout. A timeout is an answer that never arrived, so it takes the
  controller's existing `uncertain` path: it is reconciled by a status read and is never
  re-POSTed. Chunk 02 must test this.
- ADR 0002: a `## Amended 2026-09-26 — an ended wrap may offer an explicit relaunch (#1637)`
  section.
- CHANGELOG `### Added`; FEATURES.md if it lists session-page controls.

### Assumptions

- **Verified (was an assumption):** `lastSession` is the project's newest session row, built from
  `store.sessions.getLatest(project.id)` (`lib/sessions.js:3221`). An older wrapped row can't make
  a newer killed or crashed session look eligible.
- **[ASSUMPTION]** A webui (OpenClaw) project relaunched with no `mode` behaves as a landing-page
  launch that sent none. The landing page also omits `mode` unless the operator picked one.

## Chunks

### Chunk 01: the relaunch module and its contract tests

- **Delivers:** `public/session-relaunch.js` and `test/session-relaunch.test.js`. Nothing is wired
  into the page yet.
- **Tests cover:**
  - R26.8 items 1–2 at the decision level: eligible on wrapped + ended; ineligible on each of
    active, `null`, killed, crashed, wrapping, untracked, missing `lastSession`, and a missing
    payload.
  - Item 3: rapid and repeated `activate()` produces one POST carrying
    `continuityMode: 'continue'` and no launch-mode or engine fields.
  - Item 4: a 201 navigates to `/session/<enc>?launched=1`.
  - Item 5: each refusal class paints its reason. STOP and stranded are never retried, and
    stranded is never auto-acknowledged.
  - Item 6: an ambiguous outcome reconciles with no second POST, covering active → open,
    absent → retry allowed, and unknown → stays disabled.
  - Item 7 at the view-model level: label `Restarting…`, disabled while in flight, and restored on
    a retryable refusal.
- **Done when:** the new test file passes, the narrow suites touching `public/` helpers pass, and a
  chunk Critic has no unresolved blocking finding.

### Chunk 02: wire it into the session page; ADR, docs and regressions

- **Delivers:** the page wiring above, `sw.js`, the ADR amendment, CHANGELOG and FEATURES.
- **Tests:**
  - page-level tests (mini-dom): the button appears after `handleSessionEnded` with a wrapped
    status and after `handleWrapCompleted` plus a wrapped read, and the countdown is suppressed
    when eligible;
  - absence for killed, crashed, `null` and failed reads;
  - activation wiring: Enter or click on the real button produces one POST;
  - accessibility: `aria-live` status and the disabled state;
  - `sw.js` lists the file.
- **Done when:** the full suite is green in the worktree, the cumulative Critic is clean, and the
  PR is opened for PM merge. The Pilot Envelope forbids a builder merge.

## Status

- [x] Chunk 01: relaunch module + contract tests (1bd26d69; Critic rev-20260926T040831Z-cf8f4842: 0 blocking, 1 warning resolved by recorded evidence, 4 notes dispositioned)
- [ ] Chunk 02: page wiring, ADR amendment, docs, regressions
