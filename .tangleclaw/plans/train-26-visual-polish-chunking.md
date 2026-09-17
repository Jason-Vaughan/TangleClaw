---
artifact: build-plan
version: 2
scope: train-26-visual-polish
# branch: not declared. Each chunk ships from its own branch and gets its own chunk build plan when it
# starts (as in Train 20), and that plan declares the branch.
depends_on:
  - artifact: nonfunctional-requirements
  - artifact: interaction-design
governed_by:
  - artifact: nonfunctional-requirements
    dispositions:
      - "If it doesn't work on mobile, it doesn't ship (iPhone Safari 320–375px primary, Pixel Fold 9 secondary, ≥44×44px targets) → conforms: this train exists to satisfy it; both chunks measure at those widths and keep 44px targets"
      - "Accessibility floors (AA contrast, visible focus, 16px body, reduced motion, not colour alone) → conforms: no colour or motion changes are planned; any text that shrinks stays at or above the current sizes, checked at chunk close"
partition: serial — both chunks edit public/ on the live install and share one phone-width scratch setup that chunk 01 builds; chunk 02 (#1570 + #1572) is gated on real-device checks, so it goes last
last_validated: 2026-09-17
---

# Train 26 — Visual Polish & Mobile Responsiveness: chunk plan

**Issues:** #1569 (dashboard rows: project name before badges on small screens), #1570 (terminal soft keyboard:
keep the input line visible), #1571 (session header: project name truncated too early), #1572 (terminal URLs are
not tap-to-open on touch screens). All four are OPEN, have no milestone, and were filed by the ProjectManager on
2026-09-17. #1572 was added after the first draft of this plan, at the operator's request.
**Source:** the shared `TRAIN_26_VISUAL_POLISH.md` and `MASTER_ROADMAP.md` in the TangleClaw-Shared directory (the
ProjectManager moved them there on 2026-09-17).
**Authorized:** planning only. The operator said "all we want you to do is build your chunk plan first and then I'm
going to refresh your context and let you go after it". The ProjectManager relayed the same, with "DO NOT begin
coding the fixes". **No code until the operator starts a chunk in a fresh session.**
**Plan shape:** a two-chunk program. Each chunk is its own PR and gets its own chunk build plan (Confidence check,
branch, `Type: cumulative-final`) when it starts, drawn from its section here.

## Requirements Confidence

**Level:** Medium

**Why:** each issue states the symptom and the expected result in a sentence, and the code points at a likely cause
for two of them. But the reporting device and width for #1569 are unknown, and the soft-keyboard behaviour in #1570
depends on current browser behaviour, which changes quickly and has to be checked on real devices.

**Open assumptions / unknowns:**
- [ASSUMPTION: #1569's squeeze happens between 601 and ~900 CSS px (a phone in landscape, or the Pixel Fold 9's
  inner screen), where no rule moves the name onto its own line | MED impact | chunk 01 measures 320–900px first, and
  the operator can name the device]
- [ASSUMPTION: #1571 comes from the fixed `max-width: 160px` on `.banner-name` | LOW impact | chunk 01 measures the
  banner before changing it]
- [ASSUMPTION: #1572's links are dead on touch because ttyd's xterm link handling only activates on a
  modifier-click, and a tap handler added through the shared terminal wiring can open them | MED impact | chunk 02
  reads what ttyd's bundled xterm actually registers before choosing]
- [UNKNOWN: whether sizing the page to `visualViewport` is enough for the xterm inside the ttyd iframe to keep its
  cursor visible on iOS Safari | HIGH impact for #1570 | chunk 02's first step is a real-device probe; a desktop
  browser cannot show a soft keyboard]

**What would raise confidence:** the operator naming the #1569 device, one iPhone test of the smallest #1570
change before any fuller design, and reading which link handling ttyd's xterm ships (#1572).

## Advisory

What I would do differently, or watch:
- **#1570 is the one real risk.** #1569 and #1571 are CSS-sized, and #1572 is a contained touch handler. #1570 is
  behavioural, browser-specific, and can't be verified without the operator's phone. I'd open chunk 02 with the smallest possible experiment (the
  viewport-meta key plus a `visualViewport`-sized layout) and have the operator try it before building anything
  broader. If it doesn't help on iOS, the honest outcome may be "Android fixed, iOS documented as a ttyd/iframe
  limit" rather than reaching into ttyd's page.
- **#1572 and #1570 share a finger.** A tap on the terminal currently focuses it, which opens the keyboard. Tapping a
  link should open the link without also popping the keyboard or breaking touch-scroll and select mode (#443, #445).
  They are one chunk for that reason.
- **#1569 may not reproduce where its body says.** Below 600px the row already moves the name onto its own line, so
  I'd measure before assuming the issue's description of the layout.
- Nothing to cut. The train is small, and #1569/#1571 belong together.

## Status

- [x] Chunk 01: Project name first (#1571, #1569)
- [ ] Chunk 02: Terminal on a phone — input visible above the keyboard, and tappable links (#1570, #1572)
Context: Chunk plan written 2026-09-17 at the ProjectManager's and operator's request, and updated the same day to add
#1572 to chunk 02. Chunk 01 built the same day on `feat/name-first-1571` (cumulative Critic
`rev-20260917T123138Z-6120d2aa`, 0 blocking); its measurements and decisions are in the tracked
`.prawduct/change-log.md` entry "The project name gets the row's space first" (2026-09-17). Two findings worth carrying: #1569 reproduces only from
601 to 900px (below 600 the name already had its own line), and at 320–390px the banner row has no free space, so
#1571's fix changes nothing there; `VRF-1571-name-first-phone` asks the operator whether the engine pill should
give room first. Chunk 02 starts in a fresh session with a real-device probe, reusing chunk 01's scratch rig.

## Verification Strategy

- **Scratch server:** a temporary store, the tailnet IP, a leased port, and `createServer` only.
- **Phone widths in Chrome:** a same-origin `<iframe>` at 320, 375, 390, 412, 600, 700, 844 and 900 px. The Chrome
  window won't resize, and an iframe gives real media-query behaviour. Layout is read through JS
  (`getBoundingClientRect`, `scrollWidth`) because screenshots from this window are unreliable. Both themes.
- **Chunk 02:** the scratch server can't show a soft keyboard, so the real check is the operator on iPhone Safari
  and the Pixel Fold 9, on the MagicDNS URL. Link taps can be partly checked in Chrome with touch emulation, and
  finally on the devices.
- **Governance checkpoints:** after chunk 01 (the measuring setup works, and the name-first approach is agreed), and
  after chunk 02's first real-device experiment, before its fuller build.

## Build Chunks

### Chunk 01: Project name first (#1571, #1569)

- **Description:** On a narrow screen, the project name gets the row's space before the badges do, in both the
  session header and the dashboard rows. It is one technique in two stylesheets, with one verification setup, so it
  gets one review.
- **Depends on:** none
- **Artifacts consumed:** `nonfunctional-requirements.md` § Direction (mobile-first, 44px targets)
- **Deliverables:**
  - `public/session.css`: `.banner-name` loses its fixed `max-width: 160px` and takes the row's free space before
    the version and pills shrink; the ellipsis stays as the last resort.
  - `public/style.css`: the name-first treatment covers the width range where measurement shows the squeeze
    (expected: 601–900px); badges wrap before the name shrinks, and action buttons stay full-size.
  - Tests in the existing layout suites.
- **Tests:** layout assertions in `test/mobile-toolbar-layout.test.js` and `test/session-banner-phone-actions.test.js`,
  which pin these blocks, extended. Each new rule gets deliberately broken once. Measurements on the scratch server.
- **Acceptance criteria:**
  - At each measured width, a long name such as `JasonVaughanComPortfolio` is fully visible, or uses all of the
    row's free space, before any badge is truncated.
  - No horizontal page scroll.
  - Touch targets stay ≥44px.
  - Dark and light themes both look right.
  - Nothing is hidden that has no other way to be seen.
- **Visual change:** yes — layout at phone widths needs a human look on a real phone before merge
- **Done when:**
  1. Measure the current layout at the listed widths, and record where each issue actually reproduces.
  2. Acceptance criteria met and tests pass (suite green, TAP-confirmed).
  3. Operator-verification entry queued (a real phone, portrait and landscape).
  4. `/prawduct:critic cumulative` run and blocking findings resolved.
  5. PR opened with `Fixes #1569` and `Fixes #1571`; the merge is asked for only once CI is green.
  6. Committed, and the chunk marked `[x]` in Status.

### Chunk 02: Terminal on a phone — input visible above the keyboard, and tappable links (#1570, #1572)

- **Description:** Two fixes for the terminal on a touch screen, in the session view and the Master drawer on both
  pages:
  - When the soft keyboard opens, the prompt line stays visible (#1570).
  - A URL printed in the terminal opens in a new tab on tap, with no modifier key needed (#1572).

  They share the shared terminal wiring, the devices needed to verify them, and the same finger: a tap that opens a
  link must not also focus the terminal and pop the keyboard.
- **Depends on:** Chunk 01 (reuses its phone-width scratch setup; no code dependency)
- **Artifacts consumed:** `nonfunctional-requirements.md` § Direction (iPhone Safari primary, Pixel Fold 9
  secondary); the no-timer-driven-UI project rule
- **Deliverables:**
  - **#1570:**
    - the viewport meta in `public/session.html` and `public/index.html` (an `interactive-widget` key, if current
      browser behaviour supports it);
    - a `visualViewport` listener that sizes the terminal layout to the visible area while the keyboard is up,
      applied to `#terminalFrame` and both Master drawer frames.
  - **#1572:** a tap-to-open link path, added in the shared terminal wiring in `public/api-helper.js` (where
    `tcWireTerminalTouchScroll` already runs for every terminal frame). It uses whichever link detection ttyd's
    bundled xterm registers, and falls back to matching URLs on the tapped line.
    - It opens `http(s)` links only, in a new tab with `noopener`.
    - A tap that scrolls, or a tap in select mode, is not a link tap.
  - Tests for both.
- **Tests:**
  - **#1570:** the viewport-to-layout logic runs as real page code against a fake `visualViewport`: keyboard opens,
    keyboard closes, and orientation changes.
  - **#1572:** the tap-to-link logic runs against a fake xterm buffer and fake touch events. A tap on a URL opens it,
    a tap elsewhere doesn't, a drag or select-mode touch doesn't, and non-http schemes (`javascript:`, `file:`) are
    refused.
  - Deliberate breakages for each rule.
- **Acceptance criteria:**
  - On iPhone Safari and the Pixel Fold 9, tapping into the terminal leaves the prompt line visible above the
    keyboard, in the session view and in the Master drawer. Closing the keyboard restores the layout.
  - Tapping a URL printed in the terminal opens it in a new tab, without popping the keyboard.
  - Touch-scroll and select mode behave as before, and desktop (modifier-click) is unchanged.
  - Layout follows viewport events only, with no timers.
- **Visual change:** yes — only a real device can show the soft keyboard and a real tap
- **Done when:**
  1. Read current iOS Safari and Chrome on Android behaviour for the soft keyboard, `visualViewport` and
     `interactive-widget` from current documentation (fast-moving, so not from memory). Read which link provider
     ttyd's bundled xterm registers, and how it activates. Then ship the smallest #1570 experiment and have the
     operator try it on both devices before building further.
  2. Acceptance criteria met and tests pass (suite green, TAP-confirmed).
  3. Operator-verification entry queued. It is required, and this chunk is not done without it.
  4. `/prawduct:critic cumulative` run and blocking findings resolved.
  5. PR opened with `Fixes #1570` and `Fixes #1572`; the merge is asked for only once CI is green.
  6. Committed, and the chunk marked `[x]` in Status.

## Every chunk

- A worktree off `main`, with the untracked `.prawduct` state symlinked back (never `.tangleclaw/plans`).
- Check the issue is still OPEN before starting.
- CHANGELOG `[Unreleased]`: `### Fixed` for #1570, #1571 and #1572, `### Changed` for #1569. Also a FEATURES.md entry and a
  change-log entry.
- After the merge: pull, check no session is wrapping, restart, and report to the ProjectManager over the switchboard.
