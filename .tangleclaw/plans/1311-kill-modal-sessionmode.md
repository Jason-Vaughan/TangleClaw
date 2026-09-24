# #1311 — The kill modal reads a `sessionMode` the card payload never carries

- Issue: #1311 (OPEN at plan time) · Branch: `fix/1311-pilot-kill-modal`
- Dispatch: PM, Dual-Builder Pilot Lane 2. Envelope: no merge, no live pull/restart/live check,
  no tag/release/deploy. **Stop after opening the Draft PR.**
- Size / type: small bugfix that crosses a contract surface (the `GET /api/projects` card payload).
  Reviewed with the Critic regardless, because the PM wants the Critic step and the PR gate needs it.

## Confidence check

1. **Problem.** The landing page's Kill modal (`public/ui.js` `openKill`) decides its wording from
   `proj.session.sessionMode`. Neither card projection (`lib/projects.js` `_liveSession`,
   `_unknownSession`) emits that field, so `isWebui` is always false. A webui session's kill is
   described as "terminates the tmux session" when it actually tears down the SSH tunnel.
2. **Success.** For a webui session the Kill modal on a card reads "This tears down the SSH tunnel
   immediately.", and a tmux session's modal still reads "terminates the tmux session". A test runs
   the real renderer against the real projection. A second test fails the next time the landing page
   reads a `session.<field>` that `_liveSession` does not emit.
3. **Out of scope.** The session page's kill modal (`public/session.js`), which reads
   `getSessionStatus` and is already correct. Any redesign of the card payload. Changes to the store
   default (`_rowToSession` already defaults `sessionMode` to `'tmux'`).

## Facts established from the code (line numbers as of main @417faf5)

- `public/ui.js:1563` `openKill` reads `proj.session.sessionMode === 'webui'`.
- `lib/projects.js:866` `_liveSession` and `:902` `_unknownSession` emit no `sessionMode`.
- `lib/store.js:10791` `_rowToSession` exposes `sessionMode: row.session_mode || 'tmux'`, so the
  row these projections receive already carries it.
- A webui session is started with `tmuxSession: null` (`lib/sessions.js:1230`). `enrichProject`
  therefore takes the `!verdict` arm, and it is always projected by `_liveSession`. It cannot reach
  `_unknownSession`, which needs a tmux handle that tmux failed to confirm.
- The card only renders Kill when `session.active` is truthy (`ui.js:357`, `:1068`, `:1625`), and
  `_unknownSession` has `active: null`. So the issue's remark that the modal can be reached from the
  unknown shape does not hold today. Adding the field there is for a symmetric shape, not a live path.
- The landing-page scripts read card-session fields as `session.<field>` (where `session` is bound
  from `project.session`) or `project.session.<field>` / `proj.session.<field>`.
  Current reads: ui.js {active, lastEngineError, sessionMode, startedAt}, api-helper.js {active,
  cause, incomplete (comment only), wrapping}, landing.js {active}. All are emitted by `_liveSession`
  except `sessionMode`.
- **Boundary investigation, other consumers of the card `session` object.** `lib/project-view.js`
  `publicProjection` is a deliberate allowlist (`active`, `status`, `startedAt`) for rows a caller
  may not see whole. It is **left unchanged**: the dashboard always resolves as the operator
  (`lib/shared-docs-access.js` `_isOperator`, via a signed-in `tcSession` or, with the gate off, the
  dashboard client header), so it always receives whole rows and the new field. Widening the
  allowlist would be a disclosure decision outside the A1 ruling. No other `lib/`, `bin/` or
  `server.js` code reads the card session by field, and adding a key breaks no reader.
- `/ui.js` is in `NETWORK_FIRST_PATHS` in `public/sw.js`, so no `CACHE_NAME` bump is needed. It
  isn't touched anyway.

## Architectural decisions (for the Architect)

**A1 — Card payload contract: add `sessionMode` to the project's `session` object in
`GET /api/projects`, on both `_liveSession` and `_unknownSession`.** *(response-shape change)*
- Recommend: both projections pass through `row.sessionMode`. The store's `_rowToSession` stays the
  single owner of the `'tmux'` default, and the projection does not restate it.
- Rejected: (a) `_liveSession` only. The two shapes are documented as mirror images except for
  `active`/`cause`/`lastEngineError`, and the issue's Expected names both. (b) Have the UI read the
  field from `GET /api/sessions/:project/status` when the modal opens. That adds a round trip before
  a destructive confirmation, and the modal could render before it answers. (c) Infer webui in the UI
  from `tmuxSession === null`. That derives a fact the store records explicitly, and it would break
  silently if a future mode also lacks a tmux handle. (d) Re-default to `'tmux'` in the projection.
  Two owners of one default can drift.

**A2 — Shape of the cross-layer regression test.** *(the issue leaves the design open: "a test
that spans the two")*
- Recommend two tests in a new `test/card-session-contract.test.js`:
  1. **Behavioral:** lift `openKill` out of `public/ui.js` (the `new Function` lift idiom from
     `test/wrap-indicator-card.test.js`), run it against a minimal fake `document` whose
     `state.projects` hold the **real** `_liveSession` output for a webui row and for a tmux row, and
     assert the modal text.
  2. **Static contract guard:** collect every `session.<field>` read in the landing-page scripts
     (`public/ui.js`, `public/api-helper.js`, `public/landing.js`, with comments stripped) and assert
     each field is a key that `_liveSession` emits. This covers the defect class, not just this
     instance.
- Rejected: (a) behavioral test only, which pins `sessionMode` but lets the next unprojected field
  repeat the bug (the issue says so directly). (b) A shared field-name constant imported by both
  `lib/projects.js` and `public/`. `public/` scripts are browser globals and not requireable, so this
  would need a new shared module and move ownership of the shape. That is too big for a bugfix.
  (c) Guarding against `_unknownSession` keys too. `lastEngineError` is deliberately absent there,
  and its reader gates on `active === true`, so the guard would fail on a correct design.
- Known limit, documented in the test: a read through an alias not named `session` is not seen.
  This matches the current idiom, and the test lists the files it scans so a new consumer is added
  there.

## Implementation-detail calls (best effort, not architectural)

- JSDoc `@returns` on both projections gains `sessionMode: string`.
- Existing test fixture `ROW` in `test/wrap-indicator-card.test.js` is left alone. Its assertions
  are on single fields, not deep-equal on the whole payload.
- CHANGELOG: `### Fixed` entry under `[Unreleased]`.
- No doc names the card session's field list, so no doc edit beyond CHANGELOG. FEATURES.md is
  unaffected.

## Chunk

- [ ] 01 — Project `sessionMode`, add `test/card-session-contract.test.js`, CHANGELOG, Critic,
  Draft PR (after the Architect rules on A1 and A2).

## Done when

- The new test fails on main and passes on the branch. The full suite is green.
- Critic run and its findings dispositioned.
- The Architect has ruled on A1 and A2, and the rulings are recorded below.
- Draft PR open with `Fixes #1311`, reported to the PM. Then stop.

## Architect rulings (2026-09-24, via Medusa)

- **A1 APPROVED.** Pass `row.sessionMode` through both `_liveSession` and `_unknownSession`. The store
  stays the sole owner of the `'tmux'` default. This is the smallest truthful repair of the
  `GET /api/projects` contract.
- **A2 APPROVED.** Use the behavioral test from the real projection to the renderer, plus the
  bounded static consumer/producer guard, with its alias and file-list limitation documented. Do
  not expand this chunk into shared schema machinery.
- **Re-escalate only if** the implementation changes the response beyond `sessionMode`, needs
  inference or a duplicated default, or broadens the test into a new ownership contract.
