# Prawduct / Critic feedback — for upstream submission

Observations about **Prawduct itself** (its hooks, skills, gates, Critic workflow),
collected while using it. Not product bugs, not TangleClaw defects. Kept here so
they can be submitted upstream in a batch (`/prawduct:report-bug` routes one at a
time; this file is the accumulator).

Each entry: what happened, what was expected, how to reproduce, and how much it
cost. Date each one.

---

## 2026-09-03 — Train 11, cars 11–12 (Claude Opus 5, autonomous sprint)

### 1. `disposition` rejects note-tier finding ids, but NEXT-ACTION tells you to disposition notes

**What happened.** The review's NEXT-ACTION block says: *"Decide the WARNING/NOTE
findings in that SAME pass (fix / accept / file)"* and gives
`prawduct-hook disposition <review-id> <fid> --accept "<reason>"`. Attempting that
for note-tier findings returned:

```
disposition: no finding 'R-N1' recorded for review 'rev-…' — a disposition must
reference a recorded finding (prawduct-hook evidence list --kind review)
```

**Expected.** Either notes are dispositionable (and are recorded with ids that
`disposition` accepts), or the NEXT-ACTION text stops instructing the agent to
disposition them.

**Repro.** Run a review that emits notes; try to `disposition` one.

**Cost.** Two failed calls, then guesswork about whether the notes needed any
action at all. Minor, but it makes the instruction untrustworthy — and an agent
that learns to ignore one line of NEXT-ACTION will ignore others.

---

### 2. `verify-resolutions` prints its OWN review id, but standing findings belong to the ORIGINAL review

**What happened.** After `verify-resolutions`, the NEXT-ACTION block printed
`prawduct-hook disposition rev-20260903T070436Z-12287c08 <fid> …` — the
verification pass's id. The findings still standing (R-3, R-4, R-10, R-11, R-15)
were recorded under the *original* chunk review
(`rev-20260903T064900Z-a80876b0`). Using the printed id failed for every one:

```
disposition: no finding 'R-10' recorded for review 'rev-20260903T070436Z-12287c08'
```

**Expected.** The NEXT-ACTION of a `verify-resolutions` pass should print the id
that the findings it just listed as *standing* actually live under — or
`disposition` should resolve a fid across the review chain.

**Repro.** Run a chunk review that emits warnings; fix some; run
`verify-resolutions`; try to disposition one of the findings it reports as
still standing, using the id its own NEXT-ACTION prints.

**Cost.** Five failed calls before inferring the right id. This is the more
expensive of the two, because the failure message names a real review id and
looks like the finding does not exist rather than like the id is wrong.

---

### 3. A Critic finding asserted a PR-body defect that was not there

**What happened.** The chunk-12 review's backlog walk reported: *"#1063 is still
open and the commit's `(#1063)` does not close it — the PR body needs
`Fixes #1063`."* The PR body already contained `Fixes #1063` (verified with
`gh pr view 1175 --json body`), and the issue closed on merge as expected.

**Expected.** A claim about a PR's body is checkable; it should be checked
against the PR rather than inferred from the commit message.

**Cost.** Low — one verification call. Noted because the same review was
excellent on the code findings, and a wrong-but-confident procedural finding is
the kind that erodes trust in the accurate ones.

---

### 4. `chunk` mode refuses on an already-committed chunk and falls back to `cumulative`

**What happened.** `/prawduct:critic chunk 12` reported: *"`chunk` refused on an
empty diff — the work was already committed — and the refusal named
`cumulative`." The fallback worked and the review was correct.

**Expected / question.** Committing before review is the documented flow for this
project (feature-branch + PR, review before merge). If `chunk` structurally
cannot serve a committed chunk, the mode's guidance should say so, or `chunk`
should resolve its interval against the branch's merge-base rather than the
working tree.

**Cost.** None this time (the fallback was correct and said so). Flagged because
it means `chunk` is effectively never the right mode in a commit-then-review
workflow, which is worth knowing before choosing it.

---

### What worked notably well (worth preserving upstream)

Recorded because feedback that is only complaints mis-prices the tool.

- **The Critic found two real defects I would have shipped**, both invisible to a
  green suite: a pane-marker locator that silently regressed under a subagent
  roster (#429 R-2), and a receipt route whose *joint* was untested while both
  ends were covered (#1063 R-1). Neither was a style nit.
- **It caught the same class of error twice in a row from me** — prose asserting a
  safety property the code lacked — including in the *fix* for the first
  instance. The independence is what made that possible; I could not see it.
- **The "norms bind, descriptions track" rule did real work**: it forced a
  recorded amendment to a ratified design decision instead of a silent
  divergence, and the amendment is now the artifact's best explanation of why
  the shipped shape differs.
- **Mutation discipline surfaced four guards that were green against a broken
  implementation** across the two cars. Every one was a guard I had just written
  and believed.
