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
   it would add resolves against the wrong backlog (below).
4. Put both projects in a group with a **shared directory** — the group needs `sharedDir` set, or
   there is nowhere for the two sessions to exchange files.
5. Paste everything under the line into the new session's first message.

---

## On the engine

**Any engine can do this job.** An earlier version of this document argued for Claude on the
grounds that reconciling the 68-entry Prawduct backlog needs `/prawduct:backlog`. That argument
does not hold in this configuration: the skill resolves against the project it runs in, and this
session runs from its own empty directory — so it would groom a new, empty backlog rather than
TangleClaw's.

Which means the backlog half is **read-and-propose**, not edit (see the paste block). Reading a
markdown file and writing a proposal is engine-neutral. Claude is a fine default here; nothing
about the work requires it.

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
  `/Users/jasonvaughan/Documents/Projects/TangleClaw`. The backlog you need is
  `<that>/.prawduct/backlog.md`; the v5 plan is `<that>/.tangleclaw/plans/v5-secure-baseline.md`.
  Read them freely. **Never write there** — that repo belongs to the build session, and a write
  from here lands in its working tree mid-build.

### Hard rules — read before doing anything

1. **Never write into the TangleClaw repo, and never run any git command that moves `HEAD`
   there.** Read-only git (`log`, `show`, `status`, `diff`, `ls-files`) against it is fine, with
   `-C /Users/jasonvaughan/Documents/Projects/TangleClaw`.
2. **Do not write code.** No source edits, no fixes, however small or tempting. If you find a
   real bug, file or update an issue and move on.
3. **Do not touch the v5 work** — the `v5-baseline` branch, `feat/710-*` branches, or anything
   under `.claude/worktrees/`. Issues #710, #772 are v5-adjacent: classify them, don't act.
4. **Do not change the release freezes.** Specifically never set `versionBumpEnabled` back to
   `true` on the TangleClaw project. That switch is what stops a half-built v5 from publishing.
5. **Verify before you conclude.** A closed issue is not backlog. Check state
   (`gh issue view <N> --json state -q .state`) before treating anything as live work.

### The queue, as of 2026-07-29

| | |
|---|---|
| Open GitHub issues | **91** — 59 enhancement, 20 bug, 6 chore, 5 unlabeled |
| Prawduct backlog entries | **68** (`/prawduct:backlog`) |

These are **two parallel queues** and nothing reconciles them today. Work can be tracked in one,
both, or neither — and "both" is how the same thing gets planned twice.

### What to produce

In rough priority order. Get through as much as the session allows; depth beats coverage.

1. **Reconcile the two queues.** Decide which is canonical for what, and say so explicitly. This
   is the highest-value output even if you do nothing else. Where an item exists in both, link
   them or collapse one. Where the Prawduct backlog holds something with no issue and it matters,
   file the issue (you *can* write to GitHub — that is not the TangleClaw working tree).

   **You cannot edit TangleClaw's backlog file, and must not.** Produce a proposed reconciliation
   — item by item, with the action for each — and hand it to the build session to apply through
   `/prawduct:backlog` from the repo, which is where that skill resolves correctly. Proposing is
   your half; applying is theirs.
2. **Bucket the open issues into release trains** — a candidate `v5.1`, `v5.2`, and a `later`
   pool. GitHub **milestones** are the right mechanism: they are visible, filterable, and survive
   sessions. A bucket is a claim about *what ships together*, not a priority score, so group by
   coherence — things a user would experience as one improvement.
3. **Label the 5 unlabeled issues** and fix obviously wrong labels. Every issue carries a type.
4. **Find and close duplicates.** Propose them to the operator first — closing someone's issue is
   their call — then execute the ones they approve.
5. **Name the themes.** After reading the queue, say what it is actually *about*. Clusters worth
   watching for: the settings-modal family (#755, #756, #758, #764, #768), upload UX (#769, #770),
   wrap UI (#771, #185, #197, #198), and test/coverage debt (#772). Themes make trains obvious.
6. **Write the roadmap document** — the buckets, the reasoning, the open questions — into **your
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
