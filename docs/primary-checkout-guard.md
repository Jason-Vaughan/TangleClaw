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
touch ~/Documents/Projects/TangleClaw/.prawduct/.allow-primary-write   # gitignored
#   ... make the deliberate live edit ...
rm ~/Documents/Projects/TangleClaw/.prawduct/.allow-primary-write
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
script or a syntax error cannot produce a non-zero hook exit at all.

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
node scripts/install-primary-guard.js --self-test  # drive the wired command; exit 1 if it doesn't refuse
node scripts/install-primary-guard.js --remove     # unwire
```

**`--self-test` is the readback that matters.** `--check` proves an entry is listed and the script
it pins exists; it cannot prove the wired command still produces a decision. `--self-test` pipes a
synthetic PreToolUse payload through the command *actually written into the settings file* and
asserts a refusal comes back. That distinction is not theoretical here: this repo shipped the
mirror-image bug in #755, where a posture readback keyed on the guard *script* reported healthy
after the hook's *registration* was removed. A readback keyed on the registration must not be blind
to the reverse, and a wired command ending in `|| true` fails silently by construction.

Run both after any merge that touches the guard, and after anything that rewrites
`settings.local.json`.

It writes into the gitignored `.claude/settings.local.json`, where TangleClaw already keeps its own
hooks and where `_mergeBaselineHooks` preserves foreign entries verbatim across the per-launch
reconciliation. **Wiring takes effect for sessions started after it runs**, not for the session that
ran it.

The command pins the *primary's* absolute copy of the guard rather than `$CLAUDE_PROJECT_DIR`, so a
session launched in a worktree whose branch predates this feature does not invoke a script that
does not exist.

## Files

| Path | Role |
|---|---|
| `scripts/guard-primary-checkout.js` | the hook: policy, refusal text, fail-open |
| `lib/checkout-layout.js` | where the primary is, which worktree a path belongs to |
| `lib/project-paths.js` | the repo's sole containment predicate (`allowRoot` for directory questions) |
| `scripts/install-primary-guard.js` | wire / check / unwire |
| `test/primary-checkout-guard.test.js` | drives the real hook over stdin against a real worktree |
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
