---
artifact: build-plan
version: 1
scope: train-20-chunk-01
---

# Train 20 — Chunk 01: stranded wraps from local records, per-item acknowledgement, and a session-start section

**Issues:** #868 (re-scoped: local records only) and #1538 (acknowledge a stranded wrap: per-item,
audited record)
**Program plan:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder/.tangleclaw/plans/train-20-stranded-wraps-chunking.md`
**Branch:** `feat/stranded-wraps-local-868`
**Worktree:** `.claude/worktrees/stranded-wraps-local-868` (the primary clone is the live install, and this
chunk adds a `server.js` route)
**Critic mode:** cumulative
**Size:** medium, near large (a new module, a new persisted record type, two routes, a prime section, a
change to the wrap commit step's record, docs)
**Authorized:** operator "go" in the Builder pane, 2026-09-16 ("let's start train 20 and figure out the
chunkage").

---

## Confidence check

**Problem.** A wrap whose branch was pushed but whose PR never opened (`wrap.auto_pr` with
`stranded: true`) is recorded in `activity_log`, but nothing reads it. A later session finds it only by
accident. The 2026-07-30 branch was found five days late that way.

**Success.**
1. `GET /api/projects/:project/stranded-wraps` returns the project's stranded wraps from local records,
   each with `{scope: 'repo', remote, branch, headSha, recordedAt, sessionId, grandfathered, acknowledged}`.
2. `POST /api/projects/:project/stranded-wraps/ack` with `{branch, headSha}` records who acknowledged which
   item and when. The item then counts as acknowledged. A newer stranded record for the same branch at a
   different SHA shows up unacknowledged again.
3. Every session prime carries a short "Stranded wraps" section: a count, up to five unacknowledged
   items, and where to find the rest. When there are none, it says so in one line. The text is the same
   on every engine.
4. Grandfathered items (recorded before this chunk's upgrade) appear, flagged, and never count as
   unacknowledged blockers for later chunks.

**Out of scope.**
- Any GitHub or network call (Chunk 03). "Stranded" here means only what the local record says.
- The launch gate, the wrap soft-block and the dashboard badge (Chunk 02). There is no `public/` change
  in this chunk.
- Crashed/killed sessions and the cleanup path (Chunk 04).

**Requirements confidence: HIGH** for the API, the acknowledgement semantics and the prime section (the
program plan's locked decisions 1, 4, 6 and 7). **MEDIUM** for D2 (how the grandfather boundary is
recorded) and D3 (the retention answer). Both are recorded below and can be vetoed.

---

## Decisions

**D1: a stranded wrap gets a full record with the remote and the head SHA.** Today's `wrap.auto_pr` row
has `branch` but not the remote or the commit, and the acknowledgement key is (remote, branch, headSha).
The commit step already knows both. `remote` is the `origin` URL with any credentials stripped (it is
served over the API); `headSha` is the wrap commit. The close-loop result also carries the stripped
`remote`.
- *Refined while building:* the fields go on the new `wrap.stranded` row (D3), not on `wrap.auto_pr`.
  An existing test pins the exact `wrap.auto_pr` shape, and that record doesn't need them.

**D2: the grandfather boundary is the record's shape, not a date.** A stranded wrap recorded after this
change always has a `wrap.stranded` row. A `wrap.auto_pr` row with `stranded: true` and no
`wrap.stranded` row for its branch was written before the change, so it is grandfathered. This is the
"boundary recorded at upgrade" from locked decision 4, carried by the records themselves: it can't drift
with the clock, and a fresh install simply has no old rows.
- *Refined while building:* the plan first put a `recordVersion: 2` stamp on each row. Once the new
  record became its own event type, the type itself marks the shape, so the stamp added nothing and was
  dropped. The substance the operator approved (shape, not date) is unchanged.
- Alternative considered: a schema migration whose `applied_at` is the boundary. Rejected, because
  `activity_log.created_at` and `schema_version.applied_at` are both second-resolution text, so a wrap in
  the same second as the upgrade would be ambiguous.
- `[ASSUMPTION: every writer of a stranded record goes through the commit step.]` **Checked:**
  `lib/wrap-steps/commit.js` is the only writer of `wrap.auto_pr`.

**D3: stranded wraps get their own rare event type, so retention can't evict them.** `activity_log`
keeps at most 500 rows per event type (#869). This install has written 62 `wrap.auto_pr` rows since
August, so a stranded row would be evicted within months, and the thing this chunk surfaces would
silently disappear. #869's design says a rare type is safe on its own, with no exemption list to
maintain. So when a wrap is stranded, the commit step also writes a `wrap.stranded` row
(`{remote, branch, headSha}`).
- The query reads `wrap.stranded` rows and the grandfathered `wrap.auto_pr` rows (D2). Pruning can still
  evict the grandfathered ones; the docs say so rather than solving it with an exemption.
- Queries read up to 1000 rows, above the retention cap, so no row the table still holds is skipped.
- Alternative considered: exempting stranded rows from the prune. Rejected, because it is the exemption
  list #869 was designed to avoid.

**D4: an acknowledgement is its own record, `wrap.strand_ack`.** Its detail is
`{remote, branch, headSha, by, at}`. `by` is the signed-in username from the request's auth session, or
`null` when auth is off. The value `null` means "not known", and nothing is invented in its place. It
answers the three questions the program plan sets:
- Is this item acknowledged at its current head SHA? Yes, if an ack exists with the same
  (remote, branch, headSha).
- Who acknowledged it and when? `by` and `at`.
- What was acknowledged for this repo over a date range? `activity.query` filtered by type, then remote.
- An ack for an item that isn't in the list is refused (404), so a typo can't record an ack for nothing.
- Grandfathered items have no `headSha` or `remote`, so their key is `(null, branch, null)`, and the ack
  accepts `headSha: null` only for those.

**D5: "current head" is the newest local record for that branch.** Locally, the newest stranded record
for a (remote, branch) wins; an older SHA for the same branch is superseded, not listed twice. Chunk 03
replaces this with the head GitHub reports.

**D6: the prime section is its own module, `lib/stranded-wraps.js`, with `list(project)` and
`primeLines(items)`.** It follows the pattern of `ciStatus.primeLines`. It is placed next to the CI block
in `lib/sessions.js`, and `primeLines` doesn't depend on that position, so Train 21's step-by-step launch
can move it unchanged.
- Budget: a heading, a count line, at most five items (branch, short SHA, age), and a pointer to the API
  route. A test holds 50 items within the budget.
- The "none" line is one line: `No stranded wraps recorded for this project.`
- The text names no engine, file or UI (rule #5).
- A read failure renders as "could not be read", never as "none".

**D7: the routes are `/api/projects/:project/stranded-wraps` and `…/ack`,** taking the numeric id or
the name like the plans listing (`_projectByIdOrName`). They sit behind the same sign-in gate and CSRF
check as the rest of the API.

---

### Chunk 01: Local stranded-wrap query, acknowledgement and prime section

1. Grep every `wrap.auto_pr` writer (D2's assumption); read `activity.query` and the commit step's
   close-loop result.
2. Tests first (temp stores only, `store._setBasePath`, never the live store):
   - `test/stranded-wraps.test.js`: listing, grandfathered flag, supersession by a newer SHA, the ack
     cycle (ack hides it, a new SHA brings it back), the 404 on an unknown key, and `by` null vs set.
   - The prime section: the none line, the read-failure line, a 50-item budget, and no engine names.
   - The commit step: a stranded close-loop writes a `wrap.stranded` row with the remote, branch and
     commit; the remote has no credentials; a non-stranded one writes no `wrap.stranded` row.
   - The routes: the GET shape, the POST validation (400), the 404 and the 201.
3. Implement `lib/stranded-wraps.js`, the commit-step change, the two routes and the prime hook.
4. Docs: CHANGELOG `[Unreleased]` `### Added`, FEATURES.md, the API reference for both routes, and the
   configuration/retention note (D3).
5. Verify on a scratch server (not the live install): seed a stranded row, GET it, ack it, GET again,
   and read a generated prime.
6. `/prawduct:critic`, resolve the findings, PR.

## Done when

- The suite is green (`prawduct-hook test-status`).
- A scratch-server run shows the GET, ack and prime behaviour above.
- The cumulative Critic has zero blocking findings.
- A PR is open with `Fixes #868` and `Fixes #1538`, and the Coordinator has been told.

## Status

- [ ] Chunk 01: local stranded-wrap query, acknowledgement, prime section
