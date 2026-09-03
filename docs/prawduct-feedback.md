# Prawduct / Critic feedback — for upstream submission

Observations about **Prawduct itself** (its hooks, skills, gates, Critic workflow),
collected while using it. Not product bugs, not TangleClaw defects. Kept here so
they can be submitted upstream in a batch (`/prawduct:report-bug` routes one at a
time; this file is the accumulator).

Each entry: what happened, what was expected, how to reproduce, and how much it
cost. Date each one.

---

## 2026-09-03 — Train 11, cars 11–13 (Claude Opus 5, autonomous sprint)

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

### 5. Artifact publish protocol: three refusals, each demanding a different step

**Not Prawduct** — the `Artifact` tool — but logged here since this is the accumulator.

Updating an existing artifact took three refused publishes: (1) "you had not viewed the live
version", (2) "this is identical content already refused, merge onto that version", (3) a
required re-fetch to confirm. The expensive part is that "viewed" means Reading **every** line
of the saved file, and line 1 is a ~20KB minified frame-runtime the publisher injects — so
updating a 40KB document costs reading ~52KB twice. The protocol is sound (it prevents
clobbering someone else's saved edits); the cost is that the injected runtime counts toward the
read requirement even though the publisher strips and re-adds it.

**Suggestion:** exclude the injected `<!-- frame-runtime -->` line from the view requirement, or
save the file pre-injection.

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
- **Mutation discipline surfaced seven guards that were green against a broken
  implementation** across the three cars. Every one was a guard I had just written
  and believed.
- **Car 13 is the strongest case for the whole apparatus.** Four rounds, three blocking. The
  first review killed the design outright — the mechanism I had built and unit-tested would have
  re-pasted a full prime on every healthy launch, and every fixture I wrote used a 2-line prime
  in a 10-line synthetic pane, so nothing I owned could have caught it. A later round caught a
  **disposition I had written** asserting a fixture existed that did not. An independent reviewer
  that reads the tree rather than the claim is the only thing that finds that class.

---

## 2026-09-03 — Train 11, car 14 (Claude Opus 5, autonomous sprint)

### 5. The `test_command` declared in `project-state.yaml` is invisible at the point of use

**What happened.** The session briefing, `building.md`, and the stop-gate all talk
about running "the full suite" without naming it. This repo has **no
`package.json`**, so the reflexive `npm test` fails with `ENOENT`. The real command
lives in `.prawduct/project-state.yaml:449` (`test_command:`) — discoverable, but
only if you already suspect it exists.

**Expected.** The session briefing prints the project's declared `test_command`
alongside the branch and resume line. It is one line, it is already parsed, and it
is the single command every work cycle must run.

**Repro.** Onboard a non-npm repo; start a session; observe the briefing never
names the suite command.

**Cost.** One wasted background run and a confusing `ENOENT` that reads like a
broken checkout rather than a wrong command. Small in isolation; it recurs at every
`/clear` for the life of the project, and an agent that guesses `npm test` and sees
ENOENT may wrongly conclude the worktree is damaged.

### 6. `test-evidence record` and the "run the suite" instruction disagree about which number matters

Already noted in `learnings-detail.md` for this repo (JUnit top-level cases vs TAP
subtests). Restating as upstream signal: two documented, legitimate totals for one
green suite is a standing invitation to mis-cite. Prawduct could resolve it by
having `test-status` print the number it considers canonical and by the methodology
never asking for a count in prose at all.

### What worked, on this car specifically

- **`chunk` mode inferred correctly** once the work was committed on a feature
  branch — no override needed, unlike the cars 11–13 case logged above.
- **The "guards that score nothing" discipline paid for itself twice in one hour.**
  Mutating my own new tests found two that passed vacuously: one looped over the
  very constant it meant to pin (empty list → zero iterations → green), and one
  matched a symbol that also appeared at an unrelated call site, so deleting the
  behaviour it guarded changed nothing. Neither is visible from a green suite, and
  both would have shipped. This is the single highest-value habit the methodology
  enforces, and it is worth stating even more strongly than it currently is:
  *a guard you have not watched go red is a guard you have not written.*
- **"There is no pre-existing exception"** surfaced a real defect I would otherwise
  have stepped around: an existing test spent the production 8-second probe budget
  in real time and leaked its hang-guard timer, making one test file the slowest
  thing in the suite. The rule turned an annoyance into a fix.
- **Writing the plan re-scope BEFORE the code** caught that two of the chunk's three
  planned legs were already shipped and a third was built on a disproven hypothesis.
  Had I coded first, I would have re-implemented shipped work.
