# Plan — #968: a level change reaches the Master, and the operator can make it

**Status:** OPEN — not started. **Milestone:** Master Control (#829). **Issue:** #968.
**Also ships:** #768 chunk 3 (Master Kill), which this bug turns from optional into the remedy.
**Predecessor:** #755 (shipped 2026-08-18 as PR #967 — this fixes a defect in it).
**Requirements Confidence:** **High.** The defect is reproduced and its mechanism is verified
against the live master home; the operator has ruled the scope and stated the copy requirement.

**Governed by:** `security-model.md` § Direction · `nonfunctional-requirements.md` § Direction
(mobile + ≥44px, errors never by colour alone) · `project-preferences.md` § Direction (no npm deps,
CommonJS, `node:test`, JSDoc) · the no-UI-timers norm (#98/#268).

---

## The headline, in one sentence

**The Master refuses writes at the `write` tier because it is reading its own stale instructions —
the boundary permits them — and the confirmation dialog tells the operator "no restart", which is
the opposite of what they need to do.**

## What is actually true today — verified against the live master home, 2026-08-18

| Artifact | State |
|---|---|
| `~/.tangleclaw/master/.access-level` | `write` ✓ |
| `.claude/hooks/guard-writes.js` | level-aware, regenerated, wired ✓ |
| **the guard, asked directly** | **`allow`** ✓ |
| `~/.tangleclaw/master/CLAUDE.md` | `**read-only** — structurally enforced` ✗ |
| `applyMasterAccessLevel` references to the identity | **zero** |

Two facts fall out, and they shape both chunks:

1. **The change path refreshes the guard and not the identity.** #755 chunk 1 made the guard
   immediate; chunk 2 put the level into the identity; the flip path only refreshes one of the two.
   One call site is not the family — again.
2. **A file fix is not sufficient.** A running Claude Code session holds `CLAUDE.md` in context from
   launch and never re-reads it. So even a correct file leaves the live Master believing the old
   level until it restarts — which makes `levelAppliesAt: 'next-tool-call'` true of the **guard** and
   false of the **Master's behaviour**.

## What the operator ruled (2026-08-18)

- **Scope: fix AND the Kill button, before 5.7.0 is cut.** Without Kill the documented remedy is
  `tmux kill-session -t tangleclaw-master` typed by hand, which is not an answer for a product whose
  primary client is a phone.
- **The warning must say a restart is needed.** Stated directly after hitting the bug: *"that warning
  should also say you need to restart the master session for that change to take effect."* It
  currently says the opposite — **"It binds on the Master's next tool call — no restart."**

## The one open design question — RESOLVE BEFORE CHUNK 1

**Should the "restart to apply" signal be unconditional, or detected?**

It is *detectable*: `tmux display-message -p -t tangleclaw-master '#{session_created}'` gives the
session's start time, and `CLAUDE.md`'s mtime gives when the identity was last written. Identity
newer than session start ⇒ the running Master's beliefs are stale. That turns a permanent nag into
an accurate signal, and it is the same standard #755 held everywhere else: a surface says what is
actually in force, not what is usually true.

- **Detected (recommended).** `identityStale: true | false | null` on the status payload. `null` when
  tmux does not answer — and `null` renders the cautious sentence, because this is a report and the
  restrictive direction for a report is raising the alarm (the corollary #755 learned).
- **Unconditional.** Simpler: any structural master always shows "restart to apply after a change".
  Cheaper, and permanently on, which is how a warning stops being read.

**`[DECISION: the stale-identity signal is DETECTED, not unconditional — `identityStale` compares the
tmux session's creation time against `CLAUDE.md`'s mtime | a permanent warning is how a warning stops
being read, and detection is what lets the bar say the true thing at the true time; it also catches
every cause of a stale identity rather than only an access-level flip — edited Hard rules and scope
changes reach a running Master no better | RULED by the operator 2026-08-18]`**

**Verified before offering it, not assumed:** `tmux display-message -p -t tangleclaw-master
'#{session_created}'` answers, and on this machine it exposed that the live Master session has been
running since **2026-07-17** against an identity rewritten **2026-08-17**. So the running Master has
been reading month-old instructions, and *nothing* regenerated into `CLAUDE.md` in that month reached
it. The access-level flip is simply the first cause that produced a visible symptom — which is the
strongest argument for detecting the condition rather than describing it.

`null` (tmux did not answer) renders the cautious sentence rather than silence: this is a report, and
the restrictive direction for a report is raising the alarm — the corollary #755 learned the hard
way.

---

## Chunks

### Chunk 1 — the level reaches the Master, and no surface promises "no restart"

**Type:** `bugfix` · **Critic mode:** `chunk` · **Visual change:** **yes**

- **`applyMasterAccessLevel` refreshes the identity**, so `CLAUDE.md` stops contradicting
  `.access-level`. Root cause, not a symptom.
- **Every surface that describes when a change takes effect stops claiming "no restart"** and says
  what is true: the guard binds on the next tool call, the running Master keeps its old instructions
  until it restarts. Three sites, and they are a FAMILY — fix all three or the next reader finds the
  false claim on the surface you skipped:
  - `writeWarningText` — the confirmation the operator actually read
  - `renderMasterSettingsBody`'s `bindsAt` — the modal tier hint
  - `setAccess`'s warning line on the bar
- **The bar surfaces the stale state** (shape per the open question above), next to the Kill control
  that fixes it.
- **Regression tests, mutation-proven.** The mutation that must go red: reverting
  `applyMasterAccessLevel` to skip the identity refresh. Name the real caller — the PATCH route — so
  the fixture is the shape the product produces, not one invented for the test.

**Done when:**
1. Flip to `write`; `CLAUDE.md` reads `write` immediately, without an ensure.
2. Flip back; it reads `read-only`. Both asserted against the generated file, not a return value.
3. No surface contains the string "no restart", and each of the three says the running Master needs
   one. Guarded so the family cannot lose a member again.
4. Suite green; every new guard mutated.

### Chunk 2 — Master Kill (#768 chunk 3)

**Type:** `feature` · **Critic mode:** `cumulative-final` · **Visual change:** **yes**

The remedy for chunk 1's residual, and the smallest of the bar's three missing backends.

- **`POST /api/master/kill`** — kills the reserved tmux session. Idempotent: killing an absent
  Master is success, not an error, because the operator's intent is "not running" and it already is.
  Must answer honestly when tmux does not respond — the same three-state liveness discipline
  `getMasterStatus` already uses (#905): a kill that could not be confirmed is not a kill.
- **The Kill button goes live** — remove `TC_MASTER_PENDING.kill`, and its removal from that table is
  the assertion that the pending treatment came off WITH the backend rather than beside it (the
  pattern #755 chunk 3 established for `access`).
- **Confirm before killing.** Destructive and global — there is exactly one Master. The Master's
  durable memory under `memory/` survives; its in-session context does not, and the confirmation
  should say so rather than leaving the operator to guess what is lost.
- **After a kill the bar repaints from server state** — same rule as the access toggle, no optimistic
  paint. Reopening the drawer runs `ensure`, which relaunches with a fresh identity.

**Done when:**
1. Kill a live Master from both surfaces; the tmux session is gone and the bar says so.
2. Kill an absent Master; success, no error.
3. tmux unreachable → the bar does not claim the Master was killed.
4. Flip to `write` → Kill → reopen → the Master writes outside `memory/`. **The end-to-end this
   whole plan exists for**, and it is operator-verified, not asserted.
5. `/prawduct:critic cumulative`, then `/prawduct:pr`.

### Not in this plan

- **Master Wrap** — still undecided (#768 Q1); shipping a button that looks like session Wrap and
  does something materially different is the failure mode.
- **Master Upload** — #768 Q2, needs a decision about where uploads land.
- **The enforcement boundary** — it works; this plan does not touch the guard's decisions.

## Standing constraints

- **`public/` is served live off the primary checkout.** Build in the worktree
  (`.claude/worktrees/968-master-level`); keep the primary on `main`.
- **Never bump `CACHE_NAME` in `public/sw.js`** — a new shared module goes in `NETWORK_FIRST_PATHS`
  *and* `STATIC_ASSETS` (#710).
- **The guard is built inside a template literal** — a backtick anywhere in it, comments included,
  breaks `lib/master.js` at require time.
- **Tests touching the master must pin the resolver AND the home**, or they read the operator's real
  `~/.tangleclaw/master`.
- **A finding-fix is new code** — mutate every fix from the Critic rounds too. A GREEN mutation is
  the finding.

## Status

- [ ] Chunk 1 — the level reaches the Master; no surface promises "no restart"
- [ ] Chunk 2 — Master Kill

## Related

#968 (this) · #755 (shipped; this fixes its defect) · #768 + its plan §3 (Master Kill) ·
#966 (the API-authority successor) · #829 (Master Control) ·
`docs/adr/0008-project-master-session-model.md`
