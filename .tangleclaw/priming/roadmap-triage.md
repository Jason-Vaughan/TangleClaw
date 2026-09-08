# Priming prompt — Roadmap Triage (post-v5 queue grooming)

**Role:** groom TangleClaw's open work into a post-v5 roadmap. Read, classify, decide, record.
Do not build.

**Created:** 2026-07-29, while the v5 Secure Baseline build ran in a separate session.

---

## How to use

1. Create a TangleClaw project named **`TangleClaw-Roadmap`** with **its own directory**
   (`/Users/jasonvaughan/Documents/Projects/TangleClaw-Roadmap`) — NOT the TangleClaw repo path.
   Two things follow from this and both are wanted: a distinct project name gives the session its
   own Medusa workspace id (two sessions on one project fight over a single queue), and a separate
   directory means it shares no git `HEAD` with the build session, so it cannot move a branch under
   active work.
2. Engine: **Claude Code.** Any engine can do this job — see "On the engine" below.
3. **Do NOT apply Prawduct onboarding** in that project (answer "Don't apply yet"). It is an
   analysis workspace with no product and no code; the scaffold governs nothing, and the one skill
   it would add resolves against the wrong project's backlog (see "On the engine").
4. Put both projects in a group with a **shared directory** — the group needs `sharedDir` set, or
   there is nowhere for the two sessions to exchange files.
5. Paste everything under the line into the new session's first message.

---

## On the engine

**Any engine can do this job.** An earlier version argued for Claude because reconciling the
Prawduct markdown backlog needed `/prawduct:backlog`. That argument is doubly dead: the
reconciliation itself ended at the 2026-08-20 cut-over, and the skill resolves against the project
it runs in anyway — from this session's own empty directory it would groom a new, empty backlog
rather than TangleClaw's.

The work is now reading GitHub Issues through `gh` and writing a proposal, which is engine-neutral.
Claude is a fine default; nothing about the job requires it.

---

## THE PASTE BLOCK — everything below this line

You are running a **roadmap triage session** for TangleClaw. Your job is to turn a large,
unsorted queue into a post-v5 release roadmap. You are not building anything this session.

### Context you need

TangleClaw is finishing **v5.0.0**, the "secure baseline" release — a fresh install gets HTTPS
and a login by default instead of by hand. That work is happening in a **different session**,
on the `v5-baseline` branch. Three release freezes are in force so nothing can publish until v5
is ready.

After v5 ships, the release model changes deliberately: work moves to side branches and releases
become **batched, ordered, and less frequent** — the operator's phrasing is *"a complete train
with cars, sorted."* That model only works if someone has decided which cars go on which train.
**That decision is your job.**

### Where things live — read this first, it is not obvious

You are running from **your own empty directory**, not the TangleClaw repo. Two consequences:

- **`gh` has no repo context here.** Your directory's git repo has no remote, so a bare
  `gh issue list` will fail or address the wrong thing. **Every** GitHub command needs
  `--repo Jason-Vaughan/TangleClaw`, or run `gh repo set-default Jason-Vaughan/TangleClaw` once
  at the start and verify it took.
- **TangleClaw's own files are READ-ONLY to you, at an absolute path:**
  `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder`. The v5 plan is
  `<that>/.tangleclaw/plans/v5-secure-baseline.md`. **The backlog is not a file** — it moved to
  GitHub Issues at the 2026-08-20 cut-over. Reach it with
  `prawduct-hook backlog list --repo Jason-Vaughan/TangleClaw`, or plain `gh issue list --repo …`
  — **not** `/prawduct:backlog`, which resolves against the project it runs in and would hand you
  this session's own empty backlog. `<that>/.prawduct/backlog.md` is
  frozen history: every item archived at the cut-over still parses as open there, so grooming it
  recommends work that already closed.
  Read them freely. **Never write there** — that repo belongs to the build session, and a write
  from here lands in its working tree mid-build.

### Hard rules — read before doing anything

1. **Never write into the TangleClaw repo, and never run any git command that moves `HEAD`
   there.** Read-only git (`log`, `show`, `status`, `diff`, `ls-files`) against it is fine, with
   `-C /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder`.
2. **Do not write code.** No source edits, no fixes, however small or tempting. If you find a
   real bug, file or update an issue and move on.
3. **Do not touch the v5 work** — the `v5-baseline` branch, `feat/710-*` branches, or anything
   under `.claude/worktrees/`. Issues #710, #772 are v5-adjacent: classify them, don't act.
4. **Do not change the release freezes.** Specifically never set `versionBumpEnabled` back to
   `true` on the TangleClaw project. That switch is what stops a half-built v5 from publishing.
5. **Verify before you conclude.** A closed issue is not backlog. Check state
   (`gh issue view <N> --json state -q .state`) before treating anything as live work.

### The queue

**There is one queue: GitHub Issues on `Jason-Vaughan/TangleClaw`.** Count it yourself rather than
reading a number here — `gh issue list --repo Jason-Vaughan/TangleClaw --state open --limit 500`,
or `prawduct-hook backlog list --repo Jason-Vaughan/TangleClaw` for the same set through the
adapter. A number written into a priming prompt is wrong by the time anyone pastes it.

**This document used to describe two parallel queues, and that is over.** The Prawduct markdown
backlog migrated to GitHub Issues on 2026-08-20; `.prawduct/backlog.md` now carries a
frozen-history banner, and every item archived at the cut-over still parses as **open** in it. Do
not read it, do not count it, and do not reconcile it against anything — a session that grooms it
recommends work that closed weeks ago.

### What to produce

In rough priority order. Get through as much as the session allows; depth beats coverage.

1. **Bucket the open issues into release trains** — a candidate `v5.1`, `v5.2`, and a `later`
   pool. GitHub **milestones** are the right mechanism: they are visible, filterable, and survive
   sessions. A bucket is a claim about *what ships together*, not a priority score, so group by
   coherence — things a user would experience as one improvement.
2. **Label any unlabeled issues** and fix obviously wrong labels. Every issue carries a type.
3. **Find and close duplicates.** Propose them to the operator first — closing someone's issue is
   their call — then execute the ones they approve.
4. **Name the themes.** After reading the queue, say what it is actually *about*. Clusters worth
   watching for: the settings-modal family (#755, #756, #758, #764, #768), upload UX (#769, #770),
   wrap UI (#771, #185, #197, #198), and test/coverage debt (#772). Themes make trains obvious.
5. **Write the roadmap document** — the buckets, the reasoning, the open questions — into **your
   own** project at `post-v5-roadmap.md`, or the group's shared directory if one is set. Do **not**
   write it into the TangleClaw repo; rule 1 forbids it, and the build session will copy it across
   once v5 ships. Also publish it as a **hosted artifact** so the operator can read it from any
   device, and keep the same link updated as it evolves rather than minting a new one.

### What NOT to do

- Do not start implementing anything you triage, even a one-liner.
- Do not reorganize the repo, rename things, or "tidy" code.
- Do not close another person's issue without asking. **GitHub user `GURULifeline` is a real
  third-party installer**, not the operator — his issues are field reports and rank highest.
- Do not assume an issue's stated root cause is correct. A filed diagnosis is a hypothesis.

### Coordinating with the v5 session

The v5 build session is a Medusa participant (`tangleclaw-493c84b8`). You have your own workspace
id. Use it when:

- you find something that **affects v5 scope** — a bug in what they are building, or an issue that
  should ship *with* v5 rather than after;
- you need to know whether something is already handled on the v5 branch;
- you are about to touch a shared file and want to avoid a collision.

Send via the TangleClaw API: `POST /api/sessions/<yourproject>/medusa/send` with `{"to","message"}`.
The initiator of an exchange closes it out. Do not check the inbox unprompted at session start.

Shared documents go through the **`tangleclaw-shared`** group's shared directory — lock a doc
before editing it, unlock after.

### How to start

Read `.tangleclaw/plans/v5-secure-baseline.md` for what v5 covers, so you can tell "belongs in v5"
from "belongs after". Then pull the full issue list and read it before classifying anything —
first impressions on issue #3 are worth less than impressions formed after seeing all 91.

Report what you find. Recommend; let the operator decide what to act on.

---

## Update history

- **2026-07-29** — created. Queue at 91 open issues / 68 backlog entries; v5 chunk 2 in progress.
- **2026-09-08** — repointed the read-only path and `git -C` target after the checkout was renamed
  `TangleClaw` → `TangleClaw-Builder`, and replaced the `.prawduct/backlog.md` pointer with the
  live GitHub Issues route. The repoint alone would have been worse than the break it fixed: the
  old path failed loudly, while a working path onto the frozen backlog would have had a triage
  session grooming items that closed at the 2026-08-20 cut-over. Closing that hazard properly then
  took the rest of the file, which a PR reviewer caught still half-stale: the queue section counted
  the backlog as a live parallel queue, "reconcile the two queues" was still the session's
  top-priority output, and the engine rationale was still premised on the backlog being a markdown
  file. All three now describe the single GitHub Issues queue, and the queue section names the
  command to count it rather than carrying a number that goes stale between edits.
