# Train 12 — The UI Says What It's Doing

**Roadmap:** GitHub milestone #2 "The UI Says What It's Doing" (15 open at train start). The
operator named this train on 2026-09-03; sequencing is the Roadmap session's, this plan holds the
executable cars.
**Critic mode:** chunk per car (each car is its own branch + PR); `cumulative` on `main` after the
last merge of the sprint.
Cars are numbered as chunks (`Chunk N`) so the record lint can grade each one.

## Why this train exists

Train 11 made TangleClaw stop stating facts it never measured. This train makes the surfaces the
operator actually touches *say what they are doing*: the dashboard on a phone (the operator's
primary device) must not draw controls over each other (#1192) or ship 32px tap targets (#823); a
phone must be able to copy terminal output at all (#438); a dead button must not sit in the Rules
editor (#243); a ledger fetch must land somewhere visible (#1164); a dashboard shell that never
booted must leave a server-visible trace (#817); a clone behind `origin/main` must say so (#227);
every banner pill must answer "what is this" on hover and "what does it say" on click (#104);
every error path must show the server's reason rather than a guess (#83); a project rename must
warn when a LaunchAgent still points at the old path (#1148); the wrap must surface unmet gates
at the door (#854) and stream its progress live (#185); plans must be openable from any engine
(#542); an engine's own API errors must reach the card (#261); and machine-wide health must be a
panel, not tribal memory (#345).

## Confidence check

1. **Problem:** the operator, almost never at the machine, reads TangleClaw through a phone and a
   handful of banners/pills — and those surfaces overlap, clip, guess, or stay silent.
2. **Success:** each issue's "Expected" section holds on a 390px portrait viewport or on the named
   surface; every new state has a test; nothing in the dashboard draws over anything else.
3. **Out of scope:** #113 (LiteLLM proxy health — no `lib/litellm.js` exists; the proxy it would
   monitor has not shipped) and #128 (OpenClaw header resource pills — needs remote `docker stats`
   plumbing that belongs to Engine Ecosystem). Both stay in the milestone for a later train.

## Requirements Confidence

**High** on cars 1–9: each is a filed defect with the code path named in the issue and the fix
direction chosen from the issue's own option list. **Medium** on cars 10–15: #1148 is a third-party
report the maintainers cannot reproduce (the car ships the narrow, rename-time half and a doc; the
TCC boundary itself is not TangleClaw's to move); #185 is a build-both-halves task (the 2026-09-02
comment established no SSE route or client exists); #542's access-control and render choices are
recorded as vetoable assumptions in the chunk; #261 and #345 are older specs whose surfaces moved
since filing — each car re-reads the current code before building and records what it found.

## Engine-agnostic bar (project rule)

Every car's mechanism is engine-neutral. #261's error patterns live in engine profile JSON so a
new engine registers its own; #542 serves any engine's plan file; #438 reads the tmux buffer, not
an engine's clipboard.

## Chunks

### Chunk 1 — #1192 Dashboard toolbar overlaps and clips on a phone
- `public/style.css`: `.toolbar` wraps at ≤600px; neither outer column may overlap the center;
  the header row wraps or scrolls rather than clipping the `Master` pill; the card action row keeps
  the destructive `×` off the card edge. Remove the inline `style="width: auto"` on the engine
  `<select>` (or override it) so the center column can shrink.
- Test: a CSS-contract test asserting the `@media (max-width: 600px)` block carries the toolbar
  rules (the existing pattern in `test/` for style contracts), so a future edit cannot drop them.
- Verify at 390px with device emulation; a desktop window cannot reproduce it.

### Chunk 2 — #823 Dashboard buttons are 32px targets
- `.btn` `min-height` 44px (match `.form-input`); audit `public/session.css` /
  `shared-controls.css` for the same primitive. If some dense control genuinely must stay small,
  record it as a named exception class, not a silent one.
- Test: style-contract assertion on the 44px minimum.

### Chunk 3 — #438 Toolbar Copy button for touch devices
- Server: `GET /api/sessions/:name/clipboard` returns the newest tmux buffer for the session's
  server (`tmux show-buffer`), 404 with an honest reason when none.
- `public/session.js`: toolbar **Copy** → fetch → `tcCopyToClipboard` → toast with char count;
  empty → "nothing to copy yet". Peek modal gets a Copy button over its rendered DOM text.
- Retire the orphaned `~/.tmux.conf` `MouseDragEnd1Pane` file binding if TC installs it.
- Tests: route (buffer present / absent / tmux missing), client handler.

### Chunk 4 — #243 Remove the Reset button from the Global Rules editor
- Option (a): remove the button and its handler; leave `POST /api/rules/global/reset` for
  back-compat. Test asserts the markup no longer carries it and no client code calls the route.

### Chunk 5 — #1164 Settings modal fetches the delivery ledger into a container no markup creates
- Option 1: `renderProjectRulesSection` creates `projRuleDeliveriesList`; the deliveries read gets
  the three-state treatment (rows / "No delivery records" / explicit unknown naming the failure).
- Test: each of the three states renders. Needs the milestone assigned.

### Chunk 6 — #817 Dashboard shell silently fails to initialize
- Boot beacon: once the dashboard shell has initialized (after the first successful projects
  fetch), `POST /api/dashboard/boot` (or a query on an existing route) so the access log carries a
  positive signal; the server logs it at info with the SW cache name the client reports.
- `docs/runbooks/dashboard-blank.md`: what to capture browser-side before it clears
  (console, Cache Storage), and why a `CACHE_NAME` bump is not the reflex fix.
- Tests: route accepts and logs; client sends after boot, not before.

### Chunk 7 — #227 Detect when the local clone is behind origin/main
- `lib/server-info.js` (or sibling): `getRemoteCommitsAhead()` — `git fetch --quiet` then
  `rev-list HEAD..origin/main --count`; 0 when no remote or fetch fails. 15-minute server-side
  cache. Config flag to disable (documented; it is a network call to GitHub).
- Info-tone banner above the projects grid, sibling of the stale-server banner: "N new commit(s)
  upstream on origin/main. Run `git pull` to fetch them."
- Tests: helper (ahead / level / no remote / fetch failure → 0, never throws), banner render.

### Chunk 8 — #104 Universal pill UX contract
- `[data-tooltip]` CSS primitive in `public/session.css` (and `style.css` where pills appear).
  Per-pill hover labels per the issue's table; the engine pill's status text moves from hover to
  click; the model pill's color-state stays untouched.
- Test: each banner pill carries `data-tooltip`; engine pill click shows the status message.

### Chunk 9 — #83 Audit generic frontend error strings
- Every form-handler error path renders `api.lastError || '<accurate generic fallback>'`.
  Known sites: upload handler, OpenClaw connection test, wrap "Check password", save "Name may
  already exist". Walk `public/*.js` for the rest.
- Tests: one per migrated handler asserting the server message renders when present.

### Chunk 10 — #1148 Project rename leaves LaunchAgents pointing at the old path
- On rename (`lib/projects.js` name-change branch) scan `~/Library/LaunchAgents/*.plist` for the
  old absolute project path; return the matches as a `warnings` array the UI shows in the rename
  result ("N LaunchAgent(s) still reference the old path: …"). No auto-edit of plists.
- `docs/macos-tcc-automations.md`: why a managed session cannot validate EventKit/TCC access
  (grants attach to the responsible process — the launchd ttyd/tmux chain, not the script), the
  supported project-owned LaunchAgent pattern, and the verification command in the real launchd
  context. Reply on the issue links it. Needs the milestone assigned.
- Tests: scanner (match / no match / dir absent), rename result carries warnings.

### Chunk 11 — #854 Wrap preflight
- A `preflight` step at position 0 of the wrap pipeline: runs `prawduct-hook stop` read-only when
  `.prawduct/` exists; non-zero → advisory row in the drawer with the block text; the pipeline
  continues (advisory by default; `wrapStepOverrides` can make it blocking per project).
- Tests: non-prawduct project → skipped; block text → advisory row; override → blocking.

### Chunk 12 — #185 Live wrap pipeline progress via SSE
- Server: `GET /api/sessions/:project/wrap/stream/:runId` (`text/event-stream`); `runWrapPipeline`
  emits `step-start` / `step-done` / `step-blocked` through `lib/wrap-run-registry.js`; per-run
  `runId` returned by the wrap POST.
- Client: `public/wrap-drawer.js` subscribes with `EventSource` and repaints rows; the existing
  `--running` tone becomes reachable; falls back to the current blocking render if the stream
  fails. Remove the stale "no client was ever written" comment in `session.js`.
- Tests: emitter ordering, SSE framing, client row repaint, fallback.

### Chunk 13 — #542 TangleClaw-served plan/design doc links
- `GET /plans/:project/:file` renders `<project>/.tangleclaw/plans/<file>.md` (fallback
  `.claude/plans/`) to theme-aware HTML behind the existing auth; graceful 404 when archived.
  `GET /api/projects/:id/plans` lists them with their URLs so a session can hand the link back.
  **Assumption (vetoable):** path-traversal guard + markdown render via the existing
  `next-markdown.js` renderer; no new dependency.
- Tests: render, traversal refusal, 404, listing.

### Chunk 14 — #261 Surface engine API errors in the session UI
- Engine profiles gain optional `errorPatterns: [{ regex, parser }]` validated in `lib/engines.js`;
  Codex ships one for `{"type":"error","status":4xx|5xx}`. Detection in the existing tmux output
  capture stores `session.lastEngineError`; banner in `session.js`, badge on the landing card;
  clears on the next successful interaction.
- Tests: parser for Codex shapes, profile validation, badge/banner render.

### Chunk 15 — #345 System health panel
- Landing-page machine-wide health area: ttyd PTY-pool exhaustion (#94), stale server SHA
  (reuse #199 detection), install TCC hazard (#324), each with its one-line remediation. Re-read
  the current code first — a minimal panel may already exist from 4.0 chunk R; extend, don't fork.
- Tests: each detector's three states; panel renders only the conditions that fired.

## Status
- [x] Chunk 1 — #1192
- [x] Chunk 2 — #823
- [x] Chunk 3 — #438
- [x] Chunk 4 — #243
- [x] Chunk 5 — #1164
- [x] Chunk 6 — #817
- [x] Chunk 7 — #227
- [x] Chunk 8 — #104
- [x] Chunk 9 — #83
- [x] Chunk 10 — #1148
- [ ] Chunk 11 — #854
- [x] Chunk 12 — #185
- [x] Chunk 13 — #542
- [x] Chunk 14 — #261
- [x] Chunk 15 — #345

## Context
Session 2026-09-03, autonomous overnight sprint. Cars build in parallel in per-agent git
worktrees; the primary checkout stays on `main` (live install). Merge order follows the Status
list; later cars rebase onto `main` before merge. Roadmap session (`tangleclaw-roadmap`) was sent
the roster over the switchboard at train start.
