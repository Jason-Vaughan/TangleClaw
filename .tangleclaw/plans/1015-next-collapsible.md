# 1015 — Collapsible "Next" items on the dashboard

**Issue:** [#1015](https://github.com/Jason-Vaughan/TangleClaw/issues/1015) (verify OPEN before treating as canonical)
**Branch:** `feat/1015-next-collapsible`
**Worktree:** `.claude/worktrees/1015-next-collapse` — mandatory; this touches `public/`, which the primary clone serves live.
**Design preview:** https://claude.ai/code/artifact/c713f8dc-4479-4705-b700-e06df3b13474
**Size:** medium (new file + 3 changed + 2 test files) · **Type:** feature + bugfix
**Critic mode:** cumulative

---

## Confidence check

**Problem.** `continuityIndex.nextAction` holds real multi-line Markdown — the sampled wraps are 4–6 bullet lists with inline code and issue refs — but `renderCard` draws it into a `white-space: nowrap; text-overflow: ellipsis` div (`public/ui.js:339`, `public/style.css:2832`). Every bullet flattens onto one line, backticks render raw, the tail is cut, and rows carrying a Next are double-height while rows without stay compact. The operator's word for the result is "messy"; the screenshot on #1015 shows it.

**Success.** A project row is a single uniform height with no Next text on it. Clicking the row opens the existing info panel, which carries a collapsed `Next` row; clicking *that* reveals the action rendered as real Markdown — bullets as bullets, `code` as code spans. Both open states survive the dashboard's 10-second re-render.

**Out of scope.** Autolinking URLs and `#123` refs (deliberately declined — link-building from session-authored text is where an escape bug would bite). Any change to how `nextAction` is *written*. Multiple panels open at once — the existing one-at-a-time behaviour is preserved.

---

## Decisions taken with the operator

| Decision | Choice | Why |
|---|---|---|
| Where Next lives | Inside the info panel, behind its own nested disclosure ("Option C") | Off the row entirely, and the panel keeps the even rhythm of its other rows until asked |
| Collapsed Next row | Label + `(click to reveal)` hint | The chevron alone tested as invisible; the row must say it opens |
| Markdown scope | `- `/`* ` bullets, `**bold**`, `` `code` `` — escape-first | Covers every construct in the real wrap data; nothing else earns the risk |
| Row-level affordance | Chevron on the card row, folded into this PR | Pre-existing defect found while building this; C is unshippable without it (below) |

---

## The two pre-existing defects this folds in

Both were found while building #1015, neither was filed. Folding them in because Option C is a two-level disclosure and both defects sit at level one — shipping C without them means shipping a nested control whose outer level is invisible.

1. **The card row never said it opens.** There is no `.project-card:hover` rule in `public/style.css` — only `:active`, which fires after the press is committed. Desktop gets `cursor: pointer`; touch gets nothing. The operator reads this dashboard from a phone more often than from this machine.
2. **The `i` button teaches the wrong destination.** It calls `openSettings()` (`public/ui.js:933`) — the Settings *modal*, not the inline info panel. So the row's only visible "info" affordance opens somewhere else, while the invisible whole-card click opens the panel.

The chevron addresses both: a row-level disclosure marker, distinct from and sitting after the `i` button.

---

## The timer defect (the operator's "goes back on its own")

`renderProjects()` assigns `grid.innerHTML` (`public/ui.js:100`), destroying any appended `.card-detail`; `loadProjects` runs on a 10s loop (`landing.js:1581`). So an open panel dies within 10 seconds today.

This is not a new problem and not merely a preference: `renderRootPanel`'s own JSDoc states the notice stays "free of any timer-driven lifecycle, **which this project does not use**", and #566 fixed the same self-dismissing-panel shape in the loops panel.

**Fix is structural, not a patch.** Open-ness stops living in the DOM. `renderCard` emits the panel inline when the project is in a module-level state Set; `toggleCardDetail` flips the Set and re-renders. Re-render becomes idempotent, so the poll cannot close anything. This follows the standing learning: *"a re-render guard must key on the source-of-truth (a state Set/Map + focus), NEVER on residual DOM state"* (learnings.md, TC#561).

---

## Chunks

### Chunk 1 — the Markdown renderer

New `public/next-markdown.js`: `renderNextMarkdown(src)` plus its `escHtml` helper, browser-global + `module.exports` shim (the `public/openclaw-cache.js` pattern), so tests `require` it directly rather than lifting it.

An earlier draft also specified `firstNextLine(src)`, for the one-line-teaser flavour of the collapsed row. The operator chose the hint-text flavour instead, so nothing calls it — dropped rather than shipped unused.

Escape-first, then apply marks — `escHtml` runs before any `<code>`/`<strong>` wrapping, so no raw HTML can survive from session-authored text.

- [x] `public/next-markdown.js` written, JSDoc on both exports
- [x] Registered in `public/index.html` before `ui.js`
- [x] **Added to `NETWORK_FIRST_PATHS` in `public/sw.js` — and `CACHE_NAME` NOT bumped.** A new `public/*` asset the shell loads goes stale behind an active worker otherwise; bumping `CACHE_NAME` is the forbidden remedy that locked the operator out of Chrome in #710.
- [x] `test/next-markdown.test.js`: bullets, bold, code, mixed, paragraph fallback, **empty / whitespace-only / absent**, and an injection attempt (`<script>`, `<h2>` in backticks, a bare `&`)

### Chunk 2 — panel state survives re-render

- [x] Module-level `openCardDetail` (project name or `null`) in `public/ui.js`
- [x] Extract `renderCardDetail(project)` as a pure function returning HTML — the testable seam
- [x] `renderCard` emits it inline when the card is the open one; sets `aria-expanded` and an `is-open` class on the `<article>`
- [x] `toggleCardDetail(name)` flips state + calls `renderProjects()`; restores focus to the toggled card afterwards (the grid's `innerHTML` assignment destroys the focused element — keyboard users land nowhere otherwise)
- [x] Regression test: render → open → re-render → panel still open

### Chunk 3 — the Next disclosure + row chevron

- [x] `openNextAction` state, same shape; cleared when its panel closes
- [x] Next row inside the panel: `<button class="next-toggle">` with `aria-expanded`/`aria-controls`, label + `(click to reveal)`, chevron. `event.stopPropagation()` — without it the card handler also fires and closes the panel underneath.
- [x] Row chevron on `.card-row`, after the action buttons; decorative `<span>` (the whole card is already the control), rotates via the `is-open` class
- [x] `public/style.css`: remove `.card-preview`; add `.next-toggle`, `.next-block`, `.next-list`, `.card-chev`, and a `.project-card:hover` rule
- [x] Both new controls ≥34px tall — matching the card rows, so this adds nothing to the 32px-target debt in #823
- [x] Contrast: chevron at 13px `#9E9E9E` on `#1A1A1A`. The first pass at 10px `#777` measured ~3.2:1 and the operator could not find it.
- [x] `prefers-reduced-motion` honoured on both chevron transitions

### Chunk 4 — verify and land

- [x] Full suite green in the worktree
- [x] `CHANGELOG.md`: `### Changed` (Next moves behind a disclosure) + `### Fixed` (panel no longer self-closes; row now signals it opens)
- [x] Enqueue in `.prawduct/operator-verification.md` — `Visual change: yes`
- [ ] `/prawduct:critic cumulative`, disposition findings in one pass
- [ ] PR with `Fixes #1015`

---

## Verification the tests cannot do

This is a visual change on a surface the operator reads from a phone. The suite proves the renderer's output and the state machine; it cannot prove the chevron is findable or the panel legible at 375px. Operator verification is required before merge, not after.

---

## Status

- [x] Chunk 1 — Markdown renderer
- [x] Chunk 2 — panel state survives re-render
- [x] Chunk 3 — Next disclosure + row chevron
- [ ] Chunk 4 — verify and land
