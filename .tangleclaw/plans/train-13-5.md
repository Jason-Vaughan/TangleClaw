---
artifact: build-plan
version: 2
scope: train-13-5
branch: fix/1245-ttyd-kickstart-thrash
depends_on:
  - artifact: api-contract
  - artifact: architecture
  - artifact: nonfunctional-requirements
  - artifact: project-preferences
---

# Train 13.5 — Stability & Timeout Hotfixes

**Board:** `MASTER_ROADMAP` → Currently Executing → *Train 13.5: Stability & Timeout Hotfixes*.
Assigned to the Builder session (`TangleClaw`) by the Coordinator, 2026-09-07.

**Cars:** #1314 (wedged wrap run blocks server restart forever) · #1245 (ttyd child leak) ·
#798 (guard the primary checkout) — added 2026-09-07 by Operator directive relayed via the
Coordinator, because it blocks Train 14, which runs as a multi-agent swarm.

## Chunk Roster

| Chunk | Issue | Size | State |
|---|---|---|---|
| 01 | #1314 — the registry owns the staleness predicate | Medium | Complete |
| 02 | #1245 — ttyd child leak, code-side branches only | Medium | Complete — see Scoping Ruling |
| 03 | #798 — the primary checkout stops being a writable surface for work that belongs elsewhere | Medium | In review |

### Scoping Ruling — #1245 (Operator, 2026-09-07)

The issue's own cheapest-first step is *"does a newer ttyd fix it?"*, i.e. `brew upgrade ttyd`.
That is **deferred until the Operator is physically at cursatory**, and the reason is not the
upgrade itself:

ttyd's TCC grants are keyed to the versioned Cellar path. Verified live 2026-09-07:
`kTCCServiceSystemPolicyDocumentsFolder | /opt/homebrew/Cellar/ttyd/1.7.7_6/bin/ttyd | auth_value=2`.
An upgrade mints a new path, macOS treats it as a new subject, and the grant is gone. That grant is
what carries the whole ttyd → tmux → claude chain, so every dashboard terminal loses `~/Documents`.
Re-granting requires clicking a GUI dialog, which SSH cannot do — so the outage would last until the
Operator is at the machine.

It cannot break SSH (`sshd` is a separate daemon) and it cannot brick the host. But #1245 itself
records the leak as **not urgent**: pool at ~9%, orphan gate holding, nothing user-visibly broken.
Trading a day of the Operator's working surface for a non-urgent investigation is the wrong trade.

**Chunk 02 is therefore scoped to the code-side branches only** — whether `deploy/ttyd-attach.sh`
`exec`s versus spawns the `tmux attach` child, and whether `-W`/idle-timeout is relevant. The ttyd
version bump is split out as its own issue, gated on physical presence.

---

## Chunk 01 — The registry owns the staleness predicate (#1314)

### Confidence Check

**Problem.** `lib/wrap-run-registry.js` defines `STALE_RUN_MS` and only `begin()` applies it. Every
reader of `run.running` believes a wedged run forever, so one pipeline promise that never settles
makes `POST /api/server/restart` answer 409 `WRAP_RESTART_BLOCKED` permanently and makes
`lib/medusa-wake.js` skip every nudge for that project permanently.

**Success.** With a run wedged past `STALE_RUN_MS`: the restart route accepts, the wake monitor
resumes nudging, the dashboard card reports the wrap as stale rather than either spinning forever
or silently vanishing, and a stream opened on it closes with its replay instead of hanging. All four
driven by injected time in tests, not by waiting 30 minutes.

**Out of scope.** Reaping `_runs`; persisting run state; changing `STALE_RUN_MS`; any change to
`begin()`'s existing takeover behaviour; #1245; #1302.

### Requirements Confidence — High

The mechanism is read, not inferred. `_internal.now` is already injectable, so every branch is
reachable from a test.

### The four readers

The issue names three. There are four. Scope is all of them.

| # | Reader | Reads | Fail posture | Under `_isLive` |
|---|---|---|---|---|
| 1 | `server.js:979` restart gate | `anyRunning()` | closed (refuses) | Stale ⇒ restart allowed |
| 2 | `lib/medusa-wake.js:1201` wake gate | `get().running` | closed (withholds) | Stale ⇒ nudges resume |
| 3 | `lib/projects.js` `_wrapState` | `get()` | open (no pinwheel) | Stale ⇒ reported stale, not absent |
| 4 | `wrap-run-registry.js` `subscribe()` | `run.running` | n/a | Stale ⇒ `finished: true`, stream closes |

**The fail postures are NOT to be unified.** Readers 1 and 2 take an action and fail closed; reader
3 is a display and fails open. That split is action-vs-display and is load-bearing — #1314's own
text says so, and `_wrapState`'s docblock explains it. This chunk changes what "running" *means*,
not which way any reader fails when the read *throws*.

### Design decisions

**D1 — One predicate, in the registry.**

```js
function _isLive(run) {
  return Boolean(run && run.running && (_internal.now() - run.startedAt) < STALE_RUN_MS);
}
```

`begin()`, `get()`, `anyRunning()` and `subscribe()` all ask it. The finding is that three readers
each reimplemented a check that drifted; the fix is one place that can answer.

**D2 — A stale run reports `running: false`, and says why.**

`get()` returns `running: false` for a stale run, so both boolean consumers become correct with no
change to their own logic — the safe answer is the default, including for any reader added later
that never hears about staleness. The extra information rides alongside as an explicit
`stale: true`, with `startedAt` retained, so the one consumer that wants more can have it.

Rejected: returning a third truthy value for `running`. It would make every existing boolean reader
wrong-by-default, which is the exact failure being fixed.

**D3 — The card says "stale", not "no wrap".**

`_wrapState` gains a fourth answer. `false` currently means *established that no wrap is running* —
a wedged run is not that, and flattening it to `false` would hide a real fault behind a plausible
one. `lib/projects.js` already carries an `incomplete`/`cause` vocabulary for exactly this shape.

**D4 — Report, do not reap.**

Reaping `_runs` would drop `finishedAt`/`result`, which the stream route replays, and `begin()`
already recovers the slot on the next wrap. Reporting is strictly more information at strictly less
risk.

**D5 — One threshold, not a per-reader one.**

#1314 asks whether 30 minutes is right for a *reader*, whose cost of being wrong differs from
`begin()`'s. Keeping one constant, because a second threshold recreates in a new place the very
drift this fixes. Revisit with evidence, not in advance.

**D6 — `subscribe()` folds in.**

A wedged run will never emit again, so a stream held open on one hangs its client forever — the same
bug in stream form. A stale run replays its log and reports `finished: true`. Deliberate, not
incidental: this is the reader #1314 does not mention.

### Done when

- [x] `_isLive` exists in `lib/wrap-run-registry.js` and is the only staleness test in the module.
- [x] `get()` reports `running: false` + `stale: true` past `STALE_RUN_MS`; `anyRunning()` skips it;
      `subscribe()` returns `finished: true` for it.
- [x] `begin()`'s takeover behaviour is unchanged (its existing tests still pass untouched).
- [x] `_wrapState` reports a stale run distinctly from both "wrapping" and "no wrap".
- [x] Regression tests drive every branch through injected `now`, and each one is mutation-checked:
      break the code, watch the test go red.
- [x] Full suite green; `prawduct-hook test-evidence record`.
- [x] `/prawduct:critic`, findings dispositioned in one pass.
- [x] CHANGELOG `[Unreleased]` entry under `### Fixed`.

### What the review added — the reader table was short by three

The table above enumerates the readers inside `lib/wrap-run-registry.js` and stops at the module
boundary. `get()`'s payload is also the `GET /wrap/status` response body, and three more readers
live past it (`boundary-patterns.md` → API Endpoints). Two act on falsy as inertia and are safe;
`wrapWatchDecision` (`public/wrap-drawer.js`) takes an ACTION on it, and with `running` newly false
for a wedged run it told the operator the pipeline died and nothing was committed — inviting a
second wrap at exactly the moment `begin`'s takeover would permit one. All three reviewers reached
it independently.

The reachability argument is the part worth keeping: `STALE_RUN_MS` is 30 minutes against a ~17
minute worst observed wall-time, so the case that actually fires is a **slow-but-alive** wrap, not
only a wedged one. Staleness is a reader's heuristic, never an observation of death, and no surface
may phrase it as one.

Two further consequences of the same short table:
- The SSE route closes on `finished`, which `_isLive` made reachable for a run with no `run-done`
  in its log. A browser reads a terminal-frame-less close as a dropped connection and reconnects
  forever. `subscribe` now synthesises the terminal frame (never appends it — a read must not write
  to the log, and the run may still settle).
- The status route hand-copies the registry payload field by field, so `stale` stopped at the HTTP
  boundary while the reference documented it. The route's key SET is now pinned by a test, so the
  next added field fails there rather than going missing.

Deferred as #1321: nothing logs that a run crossed the threshold, so an operator cannot reconstruct
why a restart was permitted or why nudges resumed. The clean fix makes a read mutate the entry,
which is the property this chunk was careful to preserve — it deserves its own thought.

---

## Chunk 02 — The mitigation stops seeding its own next trigger (#1245)

### What the investigation found (2026-09-07, this machine)

The ttyd leak itself is NOT fixable from this repo — it is ttyd 1.7.7 failing to reap the
`tmux attach` child it spawns per websocket, and those children wedge in the macOS kernel `E`
state where nothing but ttyd dying reclaims them. The version bump that might fix it is deferred
by Operator ruling (see the Scoping Ruling above). **This chunk does not claim to fix the leak.**

Three things the investigation established, each of which narrows or corrects the issue:

1. **"Does `deploy/ttyd-attach.sh` hold the child open?" — answered NO.** The script ends with
   `exec tmux attach-session`, so ttyd's direct child IS `tmux attach`; there is no intermediate
   bash for ttyd to lose track of. 17 of 18 wedged processes observed were direct `(tmux)` children
   of ttyd. That hypothesis closes without code.

2. **The -W hypothesis is a misreading of the flag.** -W is --writable and is already set; it is
   not an idle timeout. The flags that bear on peer detection are the ping-interval one (default
   5s) and the max-clients one (unlimited); neither is configured, and neither addresses a child
   that wedges AFTER a clean disconnect. (Flag names deliberately unbackticked — record-lint reads
   a backticked token as a declared deliverable path.)

3. **The mitigation thrashes, and that IS fixable here.** 13 kickstarts over two days, clustering
   at 20 min and — once — **5 minutes**, which is one poll interval:

   | time (UTC) | orphans | gap |
   |---|---|---|
   | 09-07T00:34 | 24 | — |
   | 09-07T01:09 | 29 | 35 min |
   | 09-07T01:14 | 22 | **5 min** |
   | 09-07T01:34 | 21 | 20 min |

   `_check` reads `pid` fresh every tick and `_countTtydOrphans(pid)` counts children of that
   pid, so the 01:14 reading of 22 was against the NEW ttyd (pid 14240 → 67690 confirms the
   restart happened). **A fresh ttyd accumulated 22 wedged children within five minutes.**

   The mechanism is the mitigation's own side effect: a kickstart blanks every open terminal
   iframe simultaneously, they all reconnect at once, and connect/disconnect churn is what leaks.
   So the orphan gate can fire on damage its previous kickstart caused. Each round is user-visible
   — every terminal blanks — which is the papercut #1245 names.

### Confidence Check

**Problem.** The orphan gate re-fires on the reconnect burst its own kickstart produced, so the
operator's terminals blank two or three times in twenty minutes for one underlying leak.

**Success.** A kickstart is followed by a settling period in which the ORPHAN gate will not
re-fire; the PTY-pool gate is unaffected and still fires immediately, because pool exhaustion is
the actual emergency. The log says plainly when a kickstart is being suppressed and why, and what
the orphan count was on the tick after a kickstart, so the reclaim is visible.

### Requirements Confidence — High

The thrash is measured from this machine's own logs, not inferred: 13 kickstarts over two days with
the gaps and orphan counts tabulated above. The mechanism was read in `lib/ttyd-watcher.js` rather
than assumed, and `_runner` is already an injectable seam, so every branch is reachable from a test
without touching launchd.

The one thing NOT established is whether the reconnect burst is the whole explanation for the
post-restart orphan count. That is why this chunk also reports ttyd's uptime on every tick — the
data to answer it does not exist yet, and building a floor-based gate on the hypothesis would be
designing against a guess.

**Out of scope.** The leak itself; upgrading ttyd; `--max-clients`/`--ping-interval` tuning;
changing the frontend's reconnect behaviour; the pool-ratio gate's threshold or logic.

### Design decisions

**D1 — The hold binds the ORPHAN gate only, never the pool gate.** Observed pool ratios are
0.084–0.115 against a 0.85 threshold, so the pool gate has never fired here — it is the true
safety net for actual exhaustion and must keep its ability to fire on any tick. Gating it too
would trade a papercut for the #94 incident.

**D1a — Keyed to ttyd's OWN AGE, not to our bookkeeping (added after review).** The first
implementation remembered when *this module* last kickstarted. Two reviewers each found the same
two holes in that: a FAILED kickstart still armed it (no restart happened, so there was no burst to
excuse, yet the only gate that fires on this box sat down for 15 minutes), and it was blind to every
restart we did not perform — including the `launchctl kickstart` that `lib/system-health.js` hands
the operator as this very row's remedy, and which produces the identical burst. Reading ttyd's start
time from `ps -o etime=` covers the whole class by construction, survives a TC server restart
because the fact lives in the OS, and makes the failed-kickstart case harmless: an unchanged age
means the next tick retries on schedule.

The constant is therefore `DEFAULT_MIN_TTYD_AGE_MS` — "how long ttyd must have been running before
the orphan gate may fire" — and not a cooldown, which is what the replaced mechanism was.

**D2 — Suppression is logged at `warn`, not swallowed.** A gate that declines to act is exactly
the thing an operator later needs to explain why terminals were blanking, or why they weren't.
This is the same argument as #1321 and it applies with more force here, because the suppression is
a decision rather than a measurement.

**D3 — Report the post-kickstart orphan count.** Nothing today distinguishes "the kickstart
reclaimed the children and they came back" from "the kickstart did not reclaim them". The tick
after a kickstart now says which, which is what makes the thrash diagnosable rather than inferred.

**D4 — `exec` the wrapper's no-session branch.** One of the 18 wedged processes was a `(bash)`
holding a `(tmux)` child — the non-exec'd window. The `else` branch sits in `sleep 30` as a live
bash for 30 seconds per failed attach. Small, in the same family, and correct regardless.

### Done when

- [x] The orphan gate does not fire while ttyd is younger than the minimum age, whoever restarted
      it; the pool gate is demonstrably unaffected.
- [x] A suppressed kickstart logs why, with ttyd's age, how long is left, and the orphan count —
      asserted against the LOG, not against the return value, which no production caller reads.
- [x] Every tick reports ttyd's age, so a restart's reclaim is visible rather than inferred.
- [x] The health panel says when the count it shows may be a recent restart's burst, so its own
      remedy does not invite a restart that buys nothing.
- [x] `deploy/ttyd-attach.sh`'s no-session branch execs.
- [x] Every new branch mutation-checked against a green control.
- [x] Full suite green; evidence recorded.
- [x] `/prawduct:critic`; findings dispositioned in one pass.
- [x] CHANGELOG entry under `### Fixed`.

## Chunk 03 — The primary checkout stops being a writable surface for work that belongs elsewhere (#798)

### What this guards, stated as the mechanism rather than the incident

`${CLAUDE_PROJECT_DIR}` expands to where a session **started** and stays fixed for the session's
whole life, including after it enters a worktree. Anything the session *dispatches* — a subagent, a
Skill, a script — inherits that directory as its cwd. So the moment chunk work moves into a
worktree, every dispatched actor is still pointed at the primary checkout, and the primary checkout
is the running install: launchd serves `public/` straight off this working tree with no build and no
deploy step.

That is one mechanism producing five documented incidents (`.tangleclaw/memories/learnings.md`,
2026-05-31 · 2026-06-30/#422 · 2026-07-28/#710 · 2026-07-30 ×2). The worktree convention fixed the
session's *own* edits and does nothing about the dispatched ones, which is why #798 asks for a
structural guard rather than a sixth memory entry.

### Confidence Check

**Problem.** A dispatched actor writes tracked source, or moves HEAD, in the primary checkout while
the work it is doing belongs to a worktree — and neither the operator nor the dispatching session
sees it happen, because the operator is almost never at this machine.

**Success.** Such a write is refused before it lands, with a message that names where the write
should have gone and how to proceed deliberately. Writes the operator *intends* to be live are
still possible. No legitimate main-side work — the wrap, governance files, a hotfix — is blocked.

### Requirements Confidence — High

The arming condition was measured on this install rather than assumed, and the measurement changed
the design. #798's stated predicate is "block while a `.claude/worktrees/` worktree exists". At the
time this chunk started that was **34 worktrees, 12 of them with unmerged commits, the oldest from
2026-08-17** — nothing retires them (#1267). A guard armed by worktree *presence* would therefore
have been armed permanently here, on every legitimate main-side edit, from its first day. A guard
that is always on is a guard the operator turns off.

Also established rather than recalled: the session wrap's `git checkout -b wrap/…` and its file
writes run **server-side in `server.js`**, not through AI tool calls, so a PreToolUse hook cannot
break the wrap in either direction.

**Out of scope.** The dispatch-side fix (the Critic coordinator pinning an absolute worktree path
and aborting on `main`) — that is `brookstalley/prawduct#147`, upstream, and stays there. Retiring
stale worktrees and `[gone]` branches as a mechanism — that is #1267; this chunk removes the 23
already-merged worktrees by hand as a one-off so the repo state matches the design, and files
nothing new. Extending the guard to other TangleClaw-managed projects.

### Design decisions

**D1 — Two predicates, neither of which depends on worktree bookkeeping.** Replaces #798's
worktree-presence predicate for the reason measured above.

- **P1, session-anchored.** The session's own root is a *linked worktree*, and the operation lands
  in the *primary* worktree, and the target is *tracked by git* → refuse. This is the dispatched-
  actor shape exactly: the dispatcher moved to a worktree, the dispatched actor did not. It has no
  false positives at all — a session rooted in the primary is unaffected however many worktrees
  exist beside it, so the 34 corpses were never the question.
- **P2, target-anchored.** The target is `public/**` or `server.js` inside the primary → refuse,
  whatever the session's root. This is the surface that is live *the instant bytes hit disk* and the
  one that produced the #710 lockout. It is what catches a swarm subagent when the coordinator was
  itself launched in the primary — the Train 14 shape, which P1 alone cannot see.

**D1a — `lib/**` is deliberately NOT in P2.** It is live only on the next launchd restart, not on
write, and blocking it would refuse ordinary main-side work whose worst case is a lost edit rather
than a broken operator environment. Naming the boundary as *instantly live* keeps P2 to the files
where being wrong costs the operator their browser.

**D2 — Tracked-by-git, not under-the-primary, is P1's file test.** `.prawduct/` is written in the
primary *by design* — the Stop hook's reflection lands there, and every worktree session symlinks
its governance state back to it. Refusing those writes would break governance to protect source.
Tracked files are the live install and its source, which is the actual danger zone.

This conjunct also does the load-bearing work for symlinked governance state, and it is worth
saying why: containment resolves symlinks, so a worktree's `.prawduct/learnings.md` — a link into
the primary — *does* resolve inside the primary. It survives only because it is untracked. The
tracked file a blanket `.prawduct/` symlink would wrongly redirect is `change-log.md`, and there the
guard refusing is the correct answer: that redirection is a known defect (#710 chunk 3), and this
guard now catches it.

**D3 — Bash covers working-tree-MOVING verbs only, and only under P1.** `checkout`, `switch`,
`reset`, `rebase`, `merge` — **not** `commit`, which does not move file content and which the wrap
performs on `main` by design. Only under P1, because `git checkout main` in the primary is the
documented fast rollback from a bad branch; refusing it from a primary-rooted session would take
away the recovery move.

**D4 — FAIL OPEN on any internal error, which is the opposite of `lib/master.js`'s write guard,
deliberately.** That sibling guard answers the same *shape* of question and fails closed, so the
disagreement has to be argued rather than left for a reader to find.

The master guard bounds an **untrusted agent's authority** — a security boundary, where the cost of
failing open is an agent writing where it was never allowed to. This one prevents an **accident by a
trusted agent** — a safety interlock, where the cost of failing closed is different in kind: Claude
Code feeds hook *failures* back as synthetic user messages, which starts a new turn, so a buggy
guard loops forever on a box the operator cannot reach (`project_hook_failure_loop_mechanic`).
Failing open costs today's behaviour. Failing closed costs the session, and there is nobody at the
machine to stop it. Every internal error therefore exits 0 with no decision and one line on stderr,
which is visible under `--debug` and inert otherwise.

**D5 — The containment test goes through `lib/project-paths.js`, the repo's sole predicate.** The
module's own header records two guards that cannot use it, `lib/master.js`'s among them, "because it
is generated into a hook script inside a template literal and so cannot require any module". This
guard is a *tracked file* rather than a generated string precisely so that exemption does not apply
to it — it resolves the module from its own `__dirname`, needs no environment variable to find it,
and the header's list of exemptions does not grow.

The layout questions underneath it — where is the primary, is this root a linked worktree, which
worktree does a path belong to — live in `lib/checkout-layout.js` rather than in the hook, because
the guard and its installer both ask them and two copies would drift. They are answered by reading
`.git` directly rather than by spawning git: the guard runs ahead of every matched tool call.

**D5a — Worktree roots are ENUMERATED, not assumed to be under `.claude/worktrees/`.** The
convention puts them there, and that is exactly why they must be enumerated: a worktree nested
inside the primary is *lexically* inside it, so without subtracting each registered root every write
inside every worktree reads as a write to the primary and the guard refuses all of them.

**D7 — The script is tracked; the WIRING is machine-local, and that split is forced twice over.**
The tracked `.claude/settings.json` carries no `hooks` block *by contract* —
`test/repo-governance-reference.test.js` asserts `hooks === undefined`, because TangleClaw's own
sync used to write absolute-path hooks into that tracked file and the wrap swept them into a commit
that stranded a PR with auto-merge armed (#1022/#1275). Independently: "this checkout is the running
install" is a fact about *this machine*, not about the repository, so a committed P2 would refuse
`public/**` edits in a contributor's clone where nothing is served at all.

So `scripts/install-primary-guard.js` (tracked, tested, idempotent, `--check` / `--remove`) writes
the entry into the gitignored `.claude/settings.local.json`, where TangleClaw already writes its own
hooks and where `_mergeBaselineHooks` preserves foreign entries verbatim across every launch. The
command pins the PRIMARY's absolute copy of the guard rather than `$CLAUDE_PROJECT_DIR`, so a
session launched in a worktree whose branch predates this feature does not invoke a script that does
not exist — and it ends in `|| true`, so the guard can never itself start the hook-failure loop it
exists downstream of.

**D7a — the script lives in `scripts/`, not `.claude/hooks/`** (found at commit time, not designed).
`.gitignore` excludes `.claude/*` fail-closed with one deliberate negation for `settings.json`, so
the guard's first home made it *invisible to git*: it existed, ran, and passed every test, and
would have been committed nowhere — a clone or a fresh worktree would carry an installer pointing
at a script that does not exist. `fs.existsSync` cannot see that; only git can, which is why the
regression test asks git rather than the filesystem.

**D9 — the Bash arm asks the layout module, not the command text (Critic R-1/R-8, blocking).** The
first cut closed the `cd <primary> && git …` case with `command.includes(primary)` — a substring
scan — and that was wrong in BOTH directions, which is why two reviewers found it independently.
Every worktree root is lexically prefixed by the primary, so `git -C <abs worktree> checkout` was
REFUSED with a message telling the actor to run it where it already was: D5a's exact failure,
reintroduced on the text path only, on the absolute-path invocation that is normal for a dispatched
actor. And `cd ~/…/TangleClaw && git checkout main` contains no resolved primary path, so the case
the scan existed for walked straight past it. `movingGitTargets` now walks the command's segments,
tracks what `cd` moves to (tilde expanded), honours `-C`, and returns DIRECTORIES — which the
caller runs through the same `landsInPrimary` subtraction the file arm uses. One predicate, one
place.

**D9a — a moving verb counts only in git's SUBCOMMAND position (R-2).** Matching the verb anywhere
in the string made `git commit -m "fix the checkout path"` a working-tree move, refused with a
message asserting something false — against a Done-when line and a documented promise. The old
"never refuses a commit" test used the message `"wrap"`, which contains no verb word, so it stayed
green straight through it.

**D10 — the readback exercises the path, not the listing (R-4/R-14).** `--check` printed the
command it WOULD write; it now prints the one it read and calls a stale pin stale. `--self-test`
pipes a synthetic payload through the wired command and asserts a refusal. #755 was the mirror
image — a posture readback keyed on the guard SCRIPT, blind to the REGISTRATION being gone — and a
wired command ending in `|| true` fails silently, so a listing-only readback reports healthy on a
dead guard. Arming the live install is queued as `VRF-798-arm-the-primary-guard` rather than left
to memory, because after the merge an un-run installer, a merge regression, a deleted script and a
throwing node all look identical.

**D11 — unknown is not empty (R-3).** `linkedWorktreeRoots` returned `{roots: []}` for any
`readdirSync` failure. `ENOENT` means "no worktrees"; every other errno means the subtraction list
could not be established — and an empty list makes every path inside every nested worktree read as
the primary, so the guard refuses all of them. A fail-CLOSED hole inside a fail-open guard, and a
silent one. It now reports the errno and the guard stands down.

**D12 — the path that disarms the guard says so (R-15).** An active override produced output
byte-identical to "no rule matched", so a forgotten sentinel was indistinguishable from
not-applicable and the first conclusion available was "the guard is broken". D6 calls both routes
"a deliberate act that leaves a trace"; the trace now exists, naming which route and which file.

**D8 — three defects found by scrubbing the committed diff, none of which any test would have
caught.** (1) `deny()` called `process.exit(0)` straight after writing to stdout; writes to a pipe
are asynchronous and `process.exit` discards what has not flushed, so a refusal could arrive
TRUNCATED — which parses as nothing and silently permits the write it just refused. Both emitters
now return and let the process end on its own. (2) The git-token test required whitespace before
`git`, so `/usr/bin/git checkout` walked straight past the guard. (3) Nothing scoped the guard to
its own repository: the wiring is machine-local, so a session in another project would have had
this repo's `public/**` policy applied to a tree nobody serves. It now compares the session's
primary against its own and stands down when they differ.

**D6 — Two override routes, because they answer different situations.** `TANGLECLAW_ALLOW_PRIMARY_WRITE=1`
can be set **inline on a single command**, which is the precise, non-sticky form and the right one
for the Bash arm. A tool call cannot carry an env var, so the file arm also honours a sentinel,
`.prawduct/.allow-primary-write` (gitignored) — create it, make the deliberate live edit, delete it.
Both are read per invocation and both are named in every refusal.

Their weakness is stated rather than hidden: an *exported* env var is inherited by every subagent,
which disarms the guard for exactly the actors it exists to catch, and a forgotten sentinel file
disarms it indefinitely. Neither is a lock; both are a deliberate act that leaves a trace.

### Done when

- [ ] P1 refuses a tracked-file write and a HEAD-moving git command that land in the primary when
      the session root is a linked worktree, and does not fire when the session root is the primary.
- [ ] P2 refuses a `public/**` or `server.js` write in the primary from any session root, and does
      not fire on `lib/**` or on the same paths inside a worktree.
- [ ] `.prawduct/` writes in the primary are never refused, including through a worktree's symlink.
- [ ] `git commit` is never refused; `git checkout` from a primary-rooted session is never refused.
- [ ] Every internal failure path exits 0 with no decision — asserted, not asserted-about.
- [ ] Both override routes work and are named in the refusal text.
- [ ] The installer wires, re-wires idempotently, reports with `--check` and unwires with
      `--remove`; the tracked `.claude/settings.json` still carries no `hooks` block. Exercised at
      the CLI, not only through `apply()`.
- [ ] `--check` reports the command actually PRESENT and calls a stale pin stale; `--self-test`
      drives the wired command and fails when the guard refuses nothing.
- [ ] The wired entry survives TangleClaw's own `_mergeBaselineHooks` reconciliation as a foreign
      entry.
- [ ] Arming on the live install is queued as an owned post-merge step
      (`VRF-798-arm-the-primary-guard` in `.prawduct/operator-verification.md`), not left to memory.
- [ ] The 23 already-merged, clean worktrees are removed and the removal is reversible.
- [ ] Every new branch mutation-checked against a green control.
- [ ] Full suite green; evidence recorded.
- [ ] `/prawduct:critic`; findings dispositioned in one pass.
- [ ] CHANGELOG entry under `### Added`.

## Status

- [x] Chunk 01 — #1314, the registry owns the staleness predicate
- [x] Chunk 02 — #1245, the mitigation stops seeding its own next trigger
- [ ] Chunk 03 — #798, the primary checkout stops being a writable surface for work that belongs elsewhere
