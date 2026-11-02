# The primary-checkout guard

A PreToolUse hook that refuses AI tool calls which would write to — or move HEAD in — the checkout
that is serving the running install. It exists because on a TangleClaw development machine the
primary checkout **is** production: launchd runs `server.js` from it and serves `public/` straight
off the working tree, with no build, no staging copy and no deploy step.

Filed as [#798](https://github.com/Jason-Vaughan/TangleClaw/issues/798).

## The mechanism it guards

`$CLAUDE_PROJECT_DIR` expands to where a session **started**, and stays fixed for the session's
whole life — including after the session enters a git worktree. Everything a session dispatches
(subagents, Skills, scripts) inherits that directory as its working directory.

So the moment chunk work moves into a worktree, every dispatched actor is still pointed at the
primary checkout. That single mechanism produced five documented incidents: a sibling session's
`git checkout` yanking HEAD on a shared clone, a branch switch reverting a live modal fix (#422),
an `sw.js` cache bump on an unmerged branch that locked the operator out of Chrome behind the
basic-auth gate (#710), and two on one night in July 2026 — a Critic reviewer dispatch anchored to
the primary on `main`, and a script that edited main's copy of a file instead of the worktree's.

The worktree convention fixes a session's *own* edits. It does nothing about the dispatched ones,
which is why this is a hook rather than another line in a memory file.

## What it refuses

**P1 — the session is rooted in a worktree, but the operation lands in the primary.**
A write to a *git-tracked* file, or a working-tree-moving git command (`checkout`, `switch`,
`reset`, `rebase`, `merge`), is refused. This is the dispatched-actor shape exactly: the dispatcher
moved to a worktree and the dispatched actor did not.

**P2 — the write lands on `public/**` or `server.js` in the primary.**
Refused whatever the session root, because that is the surface that goes live *on write* rather
than on restart. It is also the only predicate that can see a swarm subagent whose coordinator was
itself launched in the primary.

## What it never refuses

- **Untracked state under `.prawduct/`** — it is written in the primary *by design*: the Stop
  hook's reflection lands there, and every worktree session symlinks its state back to it. P1's
  test is "tracked by git", not "under the primary", for exactly this reason — so the lead phrase
  here is deliberately narrower than the directory. `.prawduct/change-log.md` and
  `.prawduct/backlog.md` *are* tracked (`.gitignore` negates them) and P1 does refuse a write to
  the primary's copy from a worktree session. That is the correct answer, not an exception: a
  worktree whose `change-log.md` resolves into the primary is the known #710-chunk-3 defect.
- **`git commit`** — a commit does not move file content, and the session wrap commits on `main` in
  the primary by design.
- **`git checkout main` from a primary-rooted session** — the documented fast rollback from a bad
  branch. Taking that away would remove the fix.
- **`lib/**`** — live on the next launchd restart, not on write. Refusing it would block ordinary
  main-side work whose worst case is a lost edit rather than a broken operator environment.
- **Any session belonging to a different repository.** The wiring is machine-local, so nothing
  structurally stops the hook being invoked elsewhere; it compares the session's primary against
  its own and stands down when they differ, rather than applying this repo's `public/**` policy to
  a tree nobody serves.
- **Anything at all, when it cannot establish its own preconditions.** See *Fail-open*, below.

## What it does not catch

Stated plainly, because a guard whose limits are unwritten gets trusted past them.

- **Shell writes.** `cat > public/sw.js`, `sed -i`, a script that writes files — the Bash arm looks
  only for working-tree-moving *git* verbs. Separating a mutating shell command from a read-only
  one by pattern is not reliable, and `lib/master.js` declined the same thing for the same reason
  rather than pretending; Bash stays gated by the harness's own permission flow.
- **A session that entered a worktree mid-cycle.** `$CLAUDE_PROJECT_DIR` is fixed at launch, so
  P1 sees such a session as primary-rooted. Launch or `/clear` in the worktree — which is what
  `/prawduct:methodology building` already asks for, and for the same reason.
- **A worktree on a branch that predates this feature.** The wiring pins the primary's copy of the
  guard, so the hook still runs; but nothing re-installs the wiring on a machine where it was never
  installed. `--self-test` answers whether it is live.
- **Itself, when it is not armed.** Arming is a human step that no artifact performs: after a
  merge, an un-run installer, a `_mergeBaselineHooks` regression, a deleted script and a throwing
  node all produce the same observable — nothing. That is why the step is queued in
  `.prawduct/operator-verification.md` as `VRF-798-arm-the-primary-guard` rather than left to
  memory, and why `--self-test` exists.

## Doing it deliberately

Both routes are named in every refusal, and both are read fresh on each invocation.

```sh
# One command, not sticky — the right form for a git command.
TANGLECLAW_ALLOW_PRIMARY_WRITE=1 git checkout main

# A tool call cannot carry an env var, so the file arm honours a sentinel.
# The path is ABSOLUTE on purpose: the guard reads only the PRIMARY's copy, and a
# worktree's .prawduct is a directory of per-file symlinks — a relative `touch`
# run from a worktree creates a file the guard never reads, and the paired `rm`
# then leaves any real sentinel in place, disarmed and invisible.
# Paste the absolute path from the refusal itself, which prints it. Spelling the
# directory out here instead would be correct until the next rename and then wrong
# SILENTLY, because the guard reads only the real sentinel path — which is exactly
# how the TangleClaw -> TangleClaw-Builder rename disarmed this doc in 2026-09.
PRIMARY=<paste the absolute path the refusal printed>
touch "$PRIMARY/.prawduct/.allow-primary-write"   # gitignored
#   ... make the deliberate live edit ...
rm "$PRIMARY/.prawduct/.allow-primary-write"
```

Every refusal prints that absolute path, so the message can be copied rather than reconstructed.
While a sentinel is in force the guard says so on stderr on every call, so a forgotten one is
visible under `--debug` instead of looking like "no rule matched".

Neither is a lock, and the weakness is worth knowing: an **exported** env var is inherited by every
subagent, which disarms the guard for precisely the actors it exists to catch, and a forgotten
sentinel file disarms it indefinitely. They are a deliberate act that leaves a trace, not an
authorization boundary.

## Fail-open, deliberately

Every internal error exits 0 with no decision and one line on stderr (visible under `--debug`).
This is the opposite posture from `lib/master.js`'s Project Master write guard, and the difference
is the kind of boundary each one is:

| | Project Master guard | This guard |
|---|---|---|
| Bounds | an **untrusted** agent's authority | an **accident** by a trusted agent |
| Kind | security boundary | safety interlock |
| Cost of failing open | writes where it was never allowed | today's behaviour |
| Cost of failing closed | — | the whole session |

Claude Code feeds hook *failures* back as synthetic user messages, which starts a new turn. A guard
that fails closed on its own bug therefore loops forever, burning context on a machine the operator
is almost never sitting at. The wired command also ends in `|| true`, so a missing node, a deleted
script or a syntax error cannot produce a non-zero hook exit at all — belt-and-braces alongside
`--invoke`'s own exit-0 guarantee (below), for the one failure mode nothing *inside* this file's own
process can see: this file itself failing to parse.

## The stable outer runner, and liveness telemetry (#1400)

The wired command invokes `install-primary-guard.js --invoke`, not `guard-primary-checkout.js`
directly. `|| true` makes a crashed guard harmless; it does not make a crash *visible*. A script
that fails silently every time, from the day it ships, is observably identical to one that has
never fired at all — and nothing short of a second process watching the first can tell those apart,
because the thing crashing is also the thing that would have reported the crash.

`--invoke` is that second process. It spawns `guard-primary-checkout.js` as a **child** (bounded by
a timeout — a hung child is killed and recorded as an `error`, not left to block the tool call that
triggered it forever), forwards its stdin, and forwards its stdout byte-for-byte — never altering
the decision — while recording, to a small liveness-telemetry file, which of three things happened:

- **`refusal`** — the child returned a `deny` decision.
- **`allow`** — the child returned no decision (a handled fail-open, or an ordinary fall-through;
  these are indistinguishable from outside the child, and the child's own contract already treats
  them the same).
- **`error`** — the child could not be trusted to answer: a non-zero exit, a timeout, a syntax error
  in the policy script, or output that does not parse as this guard's own shape. This is the state
  `|| true` alone cannot surface.

The wired command's own `||` fallback — for the one failure mode even `--invoke` cannot observe,
`node` itself missing or this very file failing to parse — no longer stays silent either. It is pure
shell (a `printf`, no `node`, so it works precisely when `node` does not) that **appends** (`>>`, not
`>` — several failures before anyone folds them leave several lines, not one overwriting the last) a
small sentinel beside the telemetry file. It is folded into `counts.error` as `OUTER_NODE_FAILED`
(one per line, so a burst of real failures is not under-counted) the next time anything can run JS
against this primary again — a recovered real invocation, or an operator's own `--status`. The fold
happens strictly INSIDE the same lock `updateStatus` already takes for everything else, not as a
separate unlocked step beforehand: an earlier design unlinked the sentinel as its own atomic claim
before acquiring the lock, which raced against the lock's own contention-skip (below) — a contended
lock could let the unlink destroy the sentinel while the write meant to fold it never happened,
losing the failure entirely. One lock, one atomic read-fold-unlink-write, closes that gap.

Telemetry is written TWICE per invocation, not once: a `pending` entry is recorded *before* the
child even runs, and cleared when the outcome above is recorded after. The gap this closes is the
outer `--invoke` process itself being killed mid-invocation (not merely its child, which the timeout
above already bounds) — without the pre-invocation write, that leaves no trace at all, observably
identical to a guard that never fired. An entry still unclosed well past any realistic invocation
time is folded into `counts.error` as `unclosed-entry` the next time telemetry is touched.

Because a `PreToolUse` hook can fire for more than one tool call at once (parallel tool calls in one
turn), every telemetry read-modify-write goes through a short, local exclusive lock (a
`fs.openSync(..., 'wx')` lockfile, breaking a lock whose own mtime says its holder is long gone) —
without it, two concurrent invocations each incrementing the same counter from the same stale read
would silently lose one side's increment. The lock has a bounded wait, and losing that race SKIPS
the update rather than falling back to an unlocked read-modify-write: telemetry must never be the
reason a real tool call stalls, but an unlocked write could silently clobber a concurrent process's
own crash record — the one thing this telemetry exists to preserve — so a missed increment under
contention this guard does not expect to see in practice (one hook invocation per tool call, not a
high-throughput server) is the far cheaper failure.

The telemetry file (`<git-common-dir>/tangleclaw-primary-guard-status.json` by default;
`TANGLECLAW_PRIMARY_GUARD_STATUS_FILE` overrides it) tracks `lastInvokedAt`, a `lastHook` bounded to
`/^[A-Za-z0-9_-]{1,32}$/` (never the raw harness-supplied `tool_name` past that pattern — telemetry
must not leak what it observes; see Security below), `lastOutcome`, running `counts` per outcome,
and a bounded `lastError` code — never a raw path, command or message. A write failure here is
swallowed and never alters the decision already computed — telemetry is strictly best-effort
downstream of the thing that actually matters.

`--self-test` runs these checks, in order: the node binary it would re-spawn as the inner guard
actually runs (naming that specific cause directly, rather than letting it surface only as a generic
"the wired command failed to run"); `disableAllHooks` is not set in EITHER `.claude/settings.json`
or `settings.local.json` (a flag `settings.local.json` alone could never reveal if it were set only
in the shared file); this guard's entry appears in the UNION of both files' `PreToolUse` entries —
Claude Code loads hooks from both additively, so the union is the honest model of what the engine
actually has to work with, not a guess at precedence between them (there is none to guess at for two
files that both contribute).

**Then it checks for an EXISTING genuine engine heartbeat — and fails closed if there is none, rather
than skipping the check.** AC8's own text is explicit: *"Proof that the hook is on the live route must
come from a heartbeat the engine's own invocation produced, never from one the self-test caused. A
check that cannot be made is a failure, not a skip."* An earlier version of this file had self-test
drive a third, realistically engine-shaped probe through the wired command itself — which is exactly
the thing that sentence forbids: self-test manufacturing its own proof. Removed. Self-test may only
ask "has `engineInvocations` ever been incremented by something that was NOT self-test" — if the
answer is no, self-test FAILS, naming that as the reason, rather than quietly skipping the question.
Only once that proof already exists does self-test go on to genuinely drive the wired command through
a refusal case and an allow case and assert the liveness heartbeat advances — proving the outer
runner is the one actually live on this path — and explicitly confirms its OWN two probes never moved
`engineInvocations` either. Both probe invocations are counted into a **separate** `selfTest` bucket,
never into the genuine `counts` or `engineInvocations` — a healthy self-test habit must never be able
to masquerade as evidence that real tool-call traffic is reaching the guard.

```sh
node scripts/install-primary-guard.js --status         # liveness telemetry, human-readable
node scripts/install-primary-guard.js --status --json  # same, as JSON
```

`--status` reports `liveEngineVerified`: true once `engineInvocations` is nonzero — a GENUINE
(non-self-test) invocation whose payload actually looks like Claude Code's own PreToolUse envelope:
`hook_event_name === 'PreToolUse'` together with non-empty `session_id`/`transcript_path`/`cwd`, AND
`transcript_path` resolving to a REAL, EXISTING `.jsonl` file whose basename matches `session_id`.
The on-disk check is load-bearing, not decoration: a payload merely copying plausible-looking field
names is indistinguishable from the exact kind of self-manufactured proof AC8 forbids, so matching
field names alone is not enough — only a transcript file that genuinely exists at the claimed path is.
`lastEngineHeartbeatAt` is stamped alongside every such increment; `--self-test` requires both to be
present before it will run at all. It also checks
whether the TRACKED, shared `.claude/settings.json` declares its own `PreToolUse` entry for one of
this guard's two exact matchers (`'Bash'` or the write matcher) that is not this guard's own — this
repo's own contract says that file carries no `hooks` block at all, so any such entry is already
anomalous by that contract, whatever wrote it, and `sharedSettingsHookConflicts` names it. (This one
check is still deliberately narrow: an EXACT matcher collision, not a reproduction of general overlap
between two *different* matcher patterns, which is a harder problem than this check claims to solve.)

`--status` exits 1 and prints `ACTIONABLE` when any of three things is true: a crash was recorded
*after* the last successful `--self-test` (an old crash a passing self-test already re-covered is
not new news); the primary gained commits since the last `--status` check while no genuine
invocation was recorded in that window (an independent activity signal the guard itself cannot move,
used only as a *relative* check — commits advanced, invocations did not — never from wall-clock age
alone, and never tripped by an install that is simply, genuinely idle); or the shared-settings
conflict above. `--status` also folds the outer-node sentinel (above) before reading anything else,
so a shell-level failure is caught even on a check run with no invocation in between.

**Exemption hygiene:** this change introduces no new silence or exemption mechanism. The two
existing override routes (the env var and the sentinel file, both named below) are unchanged, and
telemetry does not add a third way to stand the guard down.

## Installing it

The guard **script** is tracked; its **wiring** is machine-local, and that split is forced twice
over. The tracked `.claude/settings.json` carries no `hooks` block by contract — TangleClaw's own
sync writes absolute-path hooks, and a committed hooks block once stranded a wrap PR with
auto-merge armed (#1022/#1275); `test/repo-governance-reference.test.js` asserts it. Independently,
"this checkout is the running install" is a fact about *one machine*, not about the repository: a
committed P2 would refuse `public/**` edits in a contributor's clone, where nothing is served at
all.

The script lives in `scripts/`, not `.claude/hooks/`, for the same reason in reverse: `.gitignore`
excludes `.claude/*` fail-closed with a single deliberate exception, so a hook script written there
would exist, run, pass its tests locally — and be committed nowhere. Nothing depends on the
location; the wiring names an absolute path.

```sh
node scripts/install-primary-guard.js              # wire it (idempotent)
node scripts/install-primary-guard.js --check      # report what IS wired; exit 1 if not, or stale
node scripts/install-primary-guard.js --self-test  # drive the wired command; exit 1 if it doesn't
                                                    # refuse, allow, and advance the heartbeat
node scripts/install-primary-guard.js --status     # liveness telemetry; see above
node scripts/install-primary-guard.js --remove     # unwire
```

**`--self-test` is the readback that matters.** `--check` proves an entry is listed and the script
it pins exists; it cannot prove the wired command still produces a decision. `--self-test` pipes
synthetic PreToolUse payloads through the command *actually written into the settings file* and
asserts a refusal, an allow, and a heartbeat advance all come back. That distinction is not
theoretical here: this repo shipped the mirror-image bug in #755, where a posture readback keyed on
the guard *script* reported healthy after the hook's *registration* was removed. A readback keyed
on the registration must not be blind to the reverse, and a wired command ending in `|| true` fails
silently by construction.

Run both after any merge that touches the guard, and after anything that rewrites
`settings.local.json`.

It writes into the gitignored `.claude/settings.local.json`, where TangleClaw already keeps its own
hooks and where `_mergeBaselineHooks` preserves foreign entries verbatim across the per-launch
reconciliation. **Wiring takes effect for sessions started after it runs**, not for the session that
ran it.

The command pins the *primary's* absolute copy of `install-primary-guard.js` rather than
`$CLAUDE_PROJECT_DIR`, so a session launched in a worktree whose branch predates this feature does
not invoke a script that does not exist. An already-wired machine's entry (pinned directly at
`guard-primary-checkout.js`, the pre-#1400 shape) is still recognised as this guard's own and
replaced cleanly on the next install — nothing migrates it on its own.

## Files

| Path | Role |
|---|---|
| `scripts/guard-primary-checkout.js` | the policy script: refusal text, fail-open |
| `scripts/install-primary-guard.js` | wire / check / unwire / status, AND (`--invoke`) the stable outer runner actually wired into the hook (#1400) |
| `lib/checkout-layout.js` | where the primary is, which worktree a path belongs to |
| `lib/project-paths.js` | the repo's sole containment predicate (`allowRoot` for directory questions) |
| `test/primary-checkout-guard.test.js` | drives the real hook and the real runner over stdin against a real worktree |
| `test/checkout-layout.test.js` | the layout answers that decide whether it refuses |

## Related

- **#1267** — nothing retires worktrees or merged branches. This guard deliberately does **not**
  arm on worktree *presence*, which is what #798 originally proposed: at the time it was built the
  install carried 34 worktrees, 12 with unmerged commits, the oldest three weeks old. A guard armed
  by presence would have been armed permanently, on every legitimate main-side edit, from its first
  day — and a guard that is always on is a guard that gets switched off.
- **`brookstalley/prawduct#147`** — the dispatch-side half (the Critic coordinator pinning an
  absolute worktree path and aborting when it lands on `main`). Upstream, and deliberately out of
  scope here.
