---
title: "Train 2: malformed project tags, inline-handler string encoding, and the port lease 'Not a project' mark"
status: IN PROGRESS — Chunk 1 done (8f565ec8, review rev-20260926T164901Z-c875176e, 0 blocking); Chunk 2 building
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-26 (message de99255a; Architect clearance R44 confirmed in 0f8b59dc)
issues: [1375, 1384, 1768]
scope: train-2
branch: fix/train-2-ui-hardening
partition: serial. All three chunks edit public/ui.js, and the PM set strict order #1375 -> #1384 -> #1768
critic_mode: chunk per chunk, cumulative at the boundary before the PR
---

# Train 2: malformed project tags, inline-handler string encoding, and the port lease "Not a project" mark

One branch, one PR, three chunks built in the dispatched order. Each chunk is its own commit series
and gets a `chunk` Critic review; a `cumulative` review covers the whole branch before the PR.
Out of scope for the whole train: #1896 (kept separate by the PM), #1245, anything outside the three
issues. Pilot Envelope: this session opens the PR but does not merge it.

## Chunk 1 — #1375: a string `tags` value no longer crashes the card detail render

**Problem.** Rows written before #1338 can hold `tags` as a JSON string. `_rowToProject` hands that
string to every consumer. `renderCardDetail` guards with `.length > 0` (true for a string) and then
calls `.map`, which throws and takes the card down. The settings modal's `.join` throws the same way,
and `store.projects.list({tag})` does substring matching on a string (`prod` matches `production`).

**Fix.**
1. Normalize on read in `lib/store.js` `_rowToProject`: an array keeps only its string members; a
   string is split on commas, trimmed, empties dropped (the create form's own shape); anything else is
   `[]`. Every consumer — card, settings modal, tag filter, API — then sees `string[]`. The row is
   repaired the next time the project is saved.
2. The card-detail reader checks `Array.isArray` instead of `.length`, so a malformed value that
   reaches it by any other path renders "None" rather than throwing.

**Done when.** Tests: `_rowToProject` normalization (string, comma string, mixed array, object,
null); `list({tag})` is array membership on a legacy string row; the card render with a string
`tags` does not throw. Suite for touched files green; CHANGELOG `### Fixed`; chunk Critic clean.

## Chunk 2 — #1384: inline handlers get one JS-string encoder

**Problem.** Inline handlers in `public/ui.js` write `fn('${esc(v)}')`. `esc` turns `'` into `&#39;`,
which the HTML parser decodes back before the JS runs, so an apostrophe (a project named `O'Brien`)
closes the string and kills the handler. Three different encodings coexist.

**Fix.** One `jsArg(value)` helper returning `esc(JSON.stringify(value))`; convert every
single-quoted interpolation and the double-stringify form to it, adjusting the receiving handler
where it `JSON.parse`s. A test scans `public/ui.js` so the single-quote form cannot come back. The
`liftFunction` test-helper consolidation named in the issue is a rider: done only if it stays small,
otherwise filed.

**Carried in from the Chunk 1 review (R-2).** `test/project-tags-shape.test.js` documents its `esc`
as a copy of `public/landing.js` but accepts only strings; load the real one or correct the comment,
in this chunk's commit.

**Scope found at chunk start.** Beyond the issue's 14, the card and stranded-wrap handlers interpolate
`'${n}'` (an escaped project name) the same way; they are converted too.

**Done when.** A handler rendered for `O'Brien` parses and receives the exact string; the scan test
passes; CHANGELOG `### Fixed`; chunk Critic clean.

## Chunk 3 — #1768: show and undo a lease's "Not a project" mark

**Problem.** Once an owner is marked `external`, the dashboard shows nothing and only a raw
`POST /api/ports/owner-kind` undoes it.

**Fix.** The ports panel marks `external` leases and offers a control that sets them back to
`project` through the existing route, using the Chunk 2 encoder. Details settle when the chunk
starts (read the ports panel and the route first).

**Done when.** UI test for the badge and the undo call; CHANGELOG `### Added`; chunk Critic clean,
then the cumulative review before the PR.

## Status

- [x] Chunk 1 — #1375
- [ ] Chunk 2 — #1384
- [ ] Chunk 3 — #1768
- [ ] Cumulative review + PR (not merged by this session)
